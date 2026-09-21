/**
 * ═══════════════════════════════════════════════════════════════
 * ENTRY POINT — IT Help Desk Bot PLN Batam
 * ═══════════════════════════════════════════════════════════════
 *
 * Server Express minimal + WhatsApp client.
 * Tidak ada: Database, Socket.io, JWT.
 *
 * Express digunakan hanya untuk:
 *   - Health check endpoint (monitoring uptime di VPS)
 *   - WhatsApp status endpoint (diagnostik)
 *   - Webhook untuk balasan admin → WA pegawai
 *   - Restart endpoint (recovery darurat)
 */

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const { initWhatsApp, getWhatsAppStatus, closeWhatsApp, restartWhatsApp, sendMessageToNumber } = require('./src/services/whatsapp.service');
const { startPolling } = require('./src/services/notification.service');
const { getSubcategoryMap, refreshSubcategoryMap } = require('./src/services/category.service');
const { initApprovalService, startApprovalReminders } = require('./src/handlers/message.handler');
const logger = require('./src/utils/logger');


const app = express();
const PORT = process.env.PORT || 3000;

// ─── Security Middleware ──────────────────────────────────────────────────────
// Helmet menetapkan HTTP security headers: X-Frame-Options, X-Content-Type-Options,
// Strict-Transport-Security, Referrer-Policy, dsb. (S6 fix)
app.use(helmet());

// ─── Startup Environment Check ───────────────────────────────────────────────
// Berikan peringatan untuk konfigurasi kritis yang belum di-set di .env
(function checkRequiredEnv() {
  const warnings = [];

  if (!process.env.SESSION_SECRET) {
    warnings.push('SESSION_SECRET — session disimpan plain JSON (tidak terenkripsi)');
  }
  if (!process.env.TECHNICIAN_KEY) {
    warnings.push('TECHNICIAN_KEY — bot tidak dapat mengirim/menerima tiket dari ManageEngine');
  }
  if (!process.env.WEBHOOK_SECRET) {
    warnings.push('WEBHOOK_SECRET — endpoint /webhook/reply hanya aman jika tidak dapat diakses publik');
  }
  if (!process.env.HEALTH_API_KEY) {
    warnings.push('HEALTH_API_KEY — endpoint /health terbuka tanpa autentikasi');
  }

  if (warnings.length > 0) {
    logger.warn('[Config] Variabel .env berikut belum dikonfigurasi:');
    for (const w of warnings) {
      logger.warn(`[Config]   • ${w}`);
    }
  }
})();


// ─── Health Check ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  // Jika HEALTH_API_KEY di-set di .env, hanya bisa diakses dengan:
  //   ?key=<HEALTH_API_KEY>  atau  Authorization: Bearer <key>
  // Kosongkan untuk membiarkan endpoint terbuka (mode development).
  const healthKey = process.env.HEALTH_API_KEY || '';
  if (healthKey) {
    const queryKey = _req.query.key || '';
    const authHeader = _req.headers['authorization'] || '';
    const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (queryKey !== healthKey && bearerKey !== healthKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  res.json({
    status: 'ok',
    service: 'IT Service Desk Bot — PLN Batam',
    uptime: Math.floor(process.uptime()) + 's',
    timestamp: new Date().toISOString()
  });
});


// ─── WhatsApp Status ──────────────────────────────────────────────────────────
app.get('/wa-status', async (_req, res) => {
  try {
    const status = await getWhatsAppStatus();
    res.json(status);
  } catch (err) {
    res.json({ connected: false, state: 'ERROR', error: err.message });
  }
});

// ─── WhatsApp Restart (Recovery) ─────────────────────────────────────────────
// Endpoint darurat untuk me-restart WhatsApp client tanpa matikan server.
// Berguna saat bot hang di state inisialisasi akibat Chrome zombie.
//
// Cara pemakaian:
//   POST http://localhost:3000/wa-restart
//   Authorization: Bearer <HEALTH_API_KEY dari .env>
//
// Keamanan: Hanya bisa diakses jika HEALTH_API_KEY di-set di .env.
// Jika tidak di-set, endpoint ini DITOLAK untuk keamanan.
app.post('/wa-restart', async (req, res) => {
  const healthKey = process.env.HEALTH_API_KEY || '';
  if (!healthKey) {
    return res.status(403).json({
      success: false,
      error: 'Endpoint ini memerlukan HEALTH_API_KEY di .env untuk keamanan.'
    });
  }
  const authHeader = req.headers['authorization'] || '';
  const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (bearerKey !== healthKey) {
    logger.warn('[Restart] Percobaan akses /wa-restart dengan token tidak valid');
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  logger.info('[Restart] Permintaan restart WhatsApp diterima via /wa-restart');
  res.json({ success: true, message: 'Restart WhatsApp dimulai. Pantau log untuk perkembangan.' });

  // Jalankan restart di background agar HTTP response sudah terkirim duluan
  setImmediate(async () => {
    try {
      await restartWhatsApp();
    } catch (err) {
      logger.error(`[Restart] Restart gagal: ${err.message}`);
    }
  });
});

// ─── Webhook: Balasan Admin → WA Pegawai ─────────────────────────────────────
// Endpoint ini dipanggil oleh ManageEngine atau admin dashboard
// saat admin menjawab tiket, agar balasannya diteruskan ke WA pegawai.
//
// Cara pemakaian:
//   POST /webhook/reply
//   Authorization: Bearer <WEBHOOK_SECRET dari .env>
//   Content-Type: application/json
//   Body: { "waNumber": "6281234567890", "message": "Tiket Anda sudah diproses..." }
//
// Opsional:
//   Body: { "waNumber": "...", "message": "...", "ticketId": "REQ-0042" }
app.post('/webhook/reply', express.json(), async (req, res) => {
  // ── Autentikasi: cek WEBHOOK_SECRET ──
  const webhookSecret = process.env.WEBHOOK_SECRET || '';
  if (webhookSecret) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (token !== webhookSecret) {
      logger.warn('[Webhook] Akses ditolak — token tidak valid');
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
  }

  const { waNumber, message, ticketId } = req.body || {};

  // ── Validasi input ──
  if (!waNumber || typeof waNumber !== 'string') {
    return res.status(400).json({ success: false, error: 'Field "waNumber" wajib diisi (format: 628xxx)' });
  }
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ success: false, error: 'Field "message" wajib diisi dan tidak boleh kosong' });
  }

  // ── Validasi ticketId: hanya karakter alfanumerik, strip, dan tanda hubung ──
  let safeTicketId = null;
  if (ticketId && typeof ticketId === 'string') {
    // Hanya izinkan alfanumerik, dash, dan underscore
    safeTicketId = ticketId.replace(/[^a-zA-Z0-9\-_]/g, '').substring(0, 50);
  }

  // ── Bersihkan nomor: hapus +, spasi, karakter non-digit ──
  const cleanNumber = waNumber.replace(/[^\d]/g, '');
  if (!cleanNumber || cleanNumber.length < 7) {
    return res.status(400).json({ success: false, error: 'Format waNumber tidak valid. Gunakan format: 628xxx' });
  }

  const logCtx = safeTicketId ? `[Tiket: ${safeTicketId}]` : '';
  logger.info(`[Webhook] ${logCtx} Balasan admin untuk ${cleanNumber}: "${message.substring(0, 80)}${message.length > 80 ? '...' : ''}"`);

  // ── Format pesan balasan ──
  const formattedMessage =
    `*[Balasan Tim IT Service Desk PLN Batam]*\n\n` +
    `${message.trim()}\n\n` +
    (safeTicketId ? `_Nomor Tiket: ${safeTicketId}_\n` : '') +
    `_Jika ada pertanyaan lanjutan, silakan ketik *menu* untuk mengajukan request baru._`;

  // ── Kirim via WhatsApp ──
  const result = await sendMessageToNumber(cleanNumber, formattedMessage);

  if (result.success) {
    logger.info(`[Webhook] ${logCtx} Pesan berhasil dikirim ke WA ${cleanNumber}`);
    return res.json({ success: true, message: `Pesan terkirim ke ${cleanNumber}` });
  } else {
    logger.error(`[Webhook] ${logCtx} Gagal kirim ke WA ${cleanNumber}: ${result.error}`);
    return res.status(503).json({ success: false, error: result.error });
  }
});

// ─── Webhook: ManageEngine Push → Zero Delay Notification ────────────────────
// Endpoint ini dipanggil oleh ManageEngine Business Rules secara OTOMATIS
// setiap kali ada balasan/update pada tiket — menghasilkan notifikasi WA
// TANPA DELAY (tidak menunggu polling interval).
//
// Konfigurasi di ManageEngine:
//   Admin → Business Rules → tambah rule baru:
//     Trigger  : "Request Reply Added" (atau "Request Updated")
//     Condition: (opsional, misal status = Open)
//     Action   : HTTP Notification
//       Method : POST
//       URL    : http://<ip-server-bot>:3000/webhook/me-notification
//       Header : Content-Type: application/json
//       Body   : { "request_id": "${requestId}" }
//
// Catatan: ${requestId} adalah variabel template ManageEngine yang akan
// diganti otomatis dengan ID tiket yang bersangkutan.
app.post('/webhook/me-notification', express.json(), async (req, res) => {
  // Ambil request_id dari berbagai format yang mungkin dikirim ManageEngine
  const requestId =
    req.body?.request_id ||
    req.body?.requestId ||
    req.body?.REQUEST_ID ||
    req.body?.id ||
    req.query?.request_id ||
    req.query?.id ||
    '';

  if (!requestId) {
    logger.warn('[ME-Webhook] Request diterima tanpa request_id — diabaikan.');
    return res.status(400).json({
      success: false,
      error: 'Field "request_id" wajib disertakan di body JSON.'
    });
  }

  const cleanId = String(requestId).replace(/[^a-zA-Z0-9\-_]/g, '').substring(0, 20);
  if (!cleanId) {
    return res.status(400).json({ success: false, error: 'request_id tidak valid.' });
  }

  logger.info(`[ME-Webhook] ⚡ Push notifikasi diterima dari ManageEngine untuk tiket ${cleanId}`);

  // Langsung response ke ManageEngine agar tidak timeout
  res.json({ success: true, message: `Notifikasi tiket ${cleanId} sedang diproses.` });

  // Poll tiket secara LANGSUNG di background (zero delay)
  setImmediate(async () => {
    try {
      const { pollTicketImmediate } = require('./src/services/notification.service');
      const processed = await pollTicketImmediate(cleanId);
      if (!processed) {
        logger.warn(`[ME-Webhook] Tiket ${cleanId} tidak ada di tracking list — lewati.`);
      }
    } catch (err) {
      logger.error(`[ME-Webhook] Error saat memproses tiket ${cleanId}: ${err.message}`);
    }
  });
});

// ─── Admin: Force Refresh Cache Subkategori ──────────────────────────────────
// Endpoint ini memaksa bot mengambil ulang data kategori & subkategori
// dari ManageEngine tanpa menunggu TTL 1 jam habis.
// Berguna setelah admin menambah/mengubah subkategori di ManageEngine.
//
// Cara pemakaian:
//   POST http://localhost:3000/admin/refresh-categories
//   Authorization: Bearer <HEALTH_API_KEY dari .env>
//
// Keamanan: Hanya bisa diakses jika HEALTH_API_KEY di-set di .env.
app.post('/admin/refresh-categories', async (req, res) => {
  const healthKey = process.env.HEALTH_API_KEY || '';
  if (!healthKey) {
    return res.status(403).json({
      success: false,
      error: 'Endpoint ini memerlukan HEALTH_API_KEY di .env untuk keamanan.'
    });
  }
  const authHeader = req.headers['authorization'] || '';
  const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (bearerKey !== healthKey) {
    logger.warn('[Admin] Percobaan akses /admin/refresh-categories dengan token tidak valid');
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    logger.info('[Admin] Force refresh cache subkategori diminta via /admin/refresh-categories');
    const count = await refreshSubcategoryMap();
    logger.info(`[Admin] Cache subkategori berhasil di-refresh: ${count} entri.`);
    return res.json({
      success: true,
      message: 'Cache subkategori berhasil di-refresh.',
      totalEntries: count,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    logger.error(`[Admin] Gagal refresh cache subkategori: ${err.message}`);
    return res.status(500).json({ success: false, error: `Gagal refresh: ${err.message}` });
  }
});


// ─── Start Server ─────────────────────────────────────────────────────────────

const server = app.listen(PORT, async () => {
  logger.info(`IT Service Desk BOT — PLN BATAM berjalan di port ${PORT}`);
  logger.info(`Health check : http://localhost:${PORT}/health`);
  logger.info(`WA status    : http://localhost:${PORT}/wa-status`);
  // Inisialisasi polling notifikasi ManageEngine (balasan admin → WA pegawai)
  startPolling();
  // Pre-warming cache subkategori aplikasi dari ManageEngine API
  // Dilakukan di background agar server tidak tertahan jika ManageEngine lambat merespons
  getSubcategoryMap()
    .then(map => logger.info(`[CategoryService] Cache subkategori siap: ${Object.keys(map).length} entri`))
    .catch(err => logger.warn(`[CategoryService] Pre-warming gagal (tidak fatal): ${err.message}`));
  // Inisialisasi WhatsApp
  await initWhatsApp();

  // Inisialisasi Approval Service — dipanggil SETELAH WhatsApp siap.
  // Hanya memuat data dari disk ke memori, TIDAK mengirim pesan WA apapun.
  initApprovalService();

  // Mulai scheduler reminder approval (kirim pengingat ke atasan setelah 24 jam).
  // Dipanggil SETELAH initApprovalService() agar data pending sudah dimuat.
  startApprovalReminders();
});

// Handle port sudah dipakai — keluar dengan bersih agar node --watch bisa restart
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const killCmd = process.platform === 'win32'
      ? `netstat -ano | findstr :${PORT}  (catat PID-nya, lalu: taskkill /PID <PID> /F)`
      : `lsof -ti:${PORT} | xargs kill -9`;
    logger.error(` Port ${PORT} sudah dipakai. Hentikan proses lain dulu dengan:\n    ${killCmd}`);
    process.exit(1);
  } else {
    logger.error(` Server error: ${err.message}`);
    process.exit(1);
  }
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
async function shutdown(signal) {
  logger.info(`\n [${signal}] Shutting down gracefully...`);
  await closeWhatsApp();
  server.close(() => {
    logger.info(' Server ditutup.');
    process.exit(0);
  });
  // Force exit setelah 5 detik jika tidak merespons
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason, promise) => {
  // Abaikan error internal Puppeteer yang tidak berbahaya.
  if (reason && reason.message && reason.message.includes('Request is already handled')) {
    return;
  }
  // Unhandled rejection TIDAK boleh crash process — hanya log.
  // Bot tetap berjalan; error akan terlihat di log untuk di-debug.
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.error(`[Stability] Unhandled rejection: ${msg}`, {
    stack: reason instanceof Error ? reason.stack : undefined
  });
});

process.on('uncaughtException', (err) => {
  // uncaughtException dicatat tapi TIDAK langsung exit agar bot tetap hidup.
  // Pengecualian: error fatal yang benar-benar membuat proses tidak stabil
  // (mis. heap memory habis, EACCES file system) — dalam kasus itu tetap exit.
  const fatalMessages = ['ENOMEM', 'heap out of memory', 'EACCES', 'ENOSPC'];
  const isFatal = fatalMessages.some(m => err.message?.includes(m));

  if (isFatal) {
    logger.error(`[Stability] Uncaught exception FATAL — process exit: ${err.message}`, { stack: err.stack });
    process.exit(1);
  } else {
    logger.error(`[Stability] Uncaught exception (non-fatal, bot tetap berjalan): ${err.message}`, { stack: err.stack });
    // Jangan exit — biarkan bot lanjut
  }
});
