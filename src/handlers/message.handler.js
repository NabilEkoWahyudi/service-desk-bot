/**
 * ═══════════════════════════════════════════════════════════════
 * MESSAGE HANDLER — IT Help Desk Bot PLN Batam
 * ═══════════════════════════════════════════════════════════════
 *
 * State machine untuk mengelola alur percakapan setiap pegawai.
 * Setiap nomor WhatsApp memiliki session independen di memory.
 *
 * State Flow:
 *   IDLE → SELECTING_CATEGORY → FILLING_FORM → CONFIRMING → (kembali ke IDLE)
 *
 * Alur pengisian form:
 *   1. User memilih kategori (1–5)
 *   2. User mengisi field sesuai kategori dalam format numbered list
 *   3. Bot memvalidasi email via GET /api/v3/users (ManageEngine)
 *   4. Bot menampilkan ringkasan data dan meminta konfirmasi (OKE / UBAH / BATAL)
 *   5. Jika OKE → POST /api/v3/requests ke ManageEngine
 *
 * Field default (tidak ditanya):
 *   Group, Level (Request), Status (Open), Service Category (Manajemen User)
 */

const { submitToEndpoint, lookupUserByEmail, getApprovalLevels, getApprovalsByLevel, approveTicket, rejectTicket, uploadAttachments } = require('../services/ticket.service');
const { CATEGORY_CONFIG } = require('../config/endpoints');
const { buildAllFieldsPrompt, parseNumberedList, validateField } = require('../utils/validators');
const { loadSessions, saveSessions } = require('../services/session.service');
const { registerTicket, buildApprovalRequestMsg } = require('../services/notification.service');
const {
  initApprovalService,
  startApprovalReminders,
  addPendingApproval,
  hasPendingApproval,
  getPendingApproval,
  removePendingApproval,
  getRemainingCount
} = require('../services/approval.service');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const encryptedStore = require('../utils/encrypted-store');
const { SlidingWindowRateLimiter, DuplicateTicketGuard } = require('../utils/ticket-protection');
const { downloadMediaDirect } = require('../utils/wa-media-download');

// ─── In-Memory Session Store ─────────────────────────────────────────────────
// Map<waNumber, SessionData>
const sessions = loadSessions();

/**
 * Timeout session setelah 15 menit tidak ada aktivitas
 */
const SESSION_TIMEOUT_MS = 1 * 60 * 60 * 1000; // 1 jam

/**
 * State enum
 */
const STATE = {
  IDLE: 'IDLE',
  SELECTING_CATEGORY: 'SELECTING_CATEGORY',
  FILLING_FORM: 'FILLING_FORM',
  CONFIRMING: 'CONFIRMING'
};

/**
 * Mapping angka pilihan ke kategori
 */
const CATEGORY_MAP = {
  '1': 'PASSWORD',
  '2': 'AUTORISASI',
  '3': 'KELUHAN',
  '4': 'VPN'
};



/**
 * Pesan welcome / menu utama
 */
const WELCOME_MSG = `Halo! Selamat datang di *IT Service Desk PLN Batam*.

Saya akan membantu Anda mengajukan request layanan IT. Silakan pilih kategori:

1. Permintaan Reset Password
2. Pembuatan atau Perubahan Otorisasi Aplikasi
3. Permintaan/Keluhan
4. Akses VPN

_Balas dengan angka 1, 2, 3, atau 4._`;



// ─── Session Management ───────────────────────────────────────────────────────

/**
 * Dapatkan atau buat session untuk user
 */
function getSession(waNumber) {
  if (sessions.has(waNumber)) {
    const session = sessions.get(waNumber);
    // Cek timeout
    if (Date.now() - session.lastActivity > SESSION_TIMEOUT_MS) {
      logger.info(`[Session]  Timeout untuk ${waNumber} — reset session`);
      resetSession(waNumber);
      return createSession(waNumber);
    }
    session.lastActivity = Date.now();
    return session;
  }
  return createSession(waNumber);
}

/**
 * Buat session baru
 */
function createSession(waNumber) {
  const session = {
    state: STATE.IDLE,
    category: null,
    data: {},
    lastActivity: Date.now()
  };
  sessions.set(waNumber, session);
  saveSessions(sessions);
  return session;
}

/**
 * Reset session ke IDLE
 */
function resetSession(waNumber) {
  sessions.delete(waNumber);
  saveSessions(sessions);
}

// ─── F5: Periodic Session Cleanup ────────────────────────────────────────────
// Bersihkan session expired setiap 30 menit untuk mencegah memory leak
// jika user tidak pernah mengirim pesan lagi setelah memulai session
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [waNumber, session] of sessions.entries()) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      resetSession(waNumber);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    logger.info(`[Session]  Periodic cleanup: ${cleaned} session expired dihapus`);
  }
}, 30 * 60 * 1000); // Setiap 30 menit

// ─── Item 1: Token Bucket Throttle (per WA) ──────────────────────────────
const tokenBuckets = new Map();
function checkThrottle(waNumber) {
  const now = Date.now();
  if (!tokenBuckets.has(waNumber)) {
    tokenBuckets.set(waNumber, { tokens: 5, lastRefill: now });
  }
  const bucket = tokenBuckets.get(waNumber);
  const timePassed = now - bucket.lastRefill;
  const tokensToAdd = Math.floor(timePassed / 2000); // 1 token per 2 detik
  if (tokensToAdd > 0) {
    bucket.tokens = Math.min(5, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now - (timePassed % 2000);
  }
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true; // allowed
  }
  return false; // throttled
}

// ─── Item 8: Duplicate Ticket Detection ──────────────────────────────
const duplicateTicketGuard = new DuplicateTicketGuard(10 * 60 * 1000);


// ─── Item 7: Anti-spam dengan Auto-Expiry Lock ───────────────────────────────
// Menggunakan Map<waNumber, timestamp> agar lock stale otomatis expire
// setelah LOCK_TIMEOUT — mencegah ghost lock permanen akibat error tak terduga.
const LOCK_TIMEOUT_MS = 90 * 1000;  // 90 detik maksimum lock
const processingLock = new Map();       // waNumber → lockedAt (timestamp)

function acquireLock(waNumber) {
  const lockedAt = processingLock.get(waNumber);
  if (lockedAt) {
    // Cek apakah lock sudah expired
    if (Date.now() - lockedAt < LOCK_TIMEOUT_MS) return false; // masih terkunci
    logger.warn(`[Lock] Ghost lock ditemukan untuk ${waNumber} — auto-release setelah ${LOCK_TIMEOUT_MS / 60000} menit`);
  }
  processingLock.set(waNumber, Date.now());
  return true;
}

function releaseLock(waNumber) {
  processingLock.delete(waNumber);
}

// ─── Item 2: Sliding Window Per EMAIL dan WA ─────────────────────────────────
// Reservasi dilakukan sebelum submit agar nomor/email yang dipakai serentak tetap dibatasi.
const MAX_TICKETS_PER_WINDOW = parseInt(process.env.RATE_LIMIT_MAX || '10', 10);
const RATE_WINDOW_MS = 10 * 60 * 1000; // 10 menit
const RATELIMIT_FILE = path.join(__dirname, '../../data/ratelimit.json');

/**
 * Muat rate limit dari disk saat startup.
 * Window yang sudah expired (> RATE_WINDOW_MS) otomatis dibuang.
 * @returns {Map<string, { count: number, windowStart: number }>}
 */
function loadRateLimit() {
  try {
    const obj = encryptedStore.readJson(RATELIMIT_FILE, {});
    const now = Date.now();
    const store = new Map();
    for (const [storedKey, record] of Object.entries(obj)) {
      const key = storedKey.startsWith('email:') || storedKey.startsWith('wa:')
        ? storedKey
        : (storedKey.includes('@') ? `email:${storedKey}` : `wa:${storedKey}`);
      const timestamps = Array.isArray(record?.timestamps)
        ? record.timestamps
        : Array.from({ length: Math.max(0, Number(record?.count) || 0) }, () => Number(record?.windowStart) || now);
      const activeTimestamps = timestamps.filter(timestamp => now - timestamp < RATE_WINDOW_MS);
      if (activeTimestamps.length) store.set(key, activeTimestamps);
    }
    logger.info(`[RateLimit] Data rate limit dimuat dari disk (${store.size} entri aktif)` +
      (encryptedStore.ENCRYPTION_ENABLED ? ' [terenkripsi]' : ' [plain JSON]') + '.');
    return store;
  } catch (err) {
    logger.warn(`[RateLimit] Gagal memuat rate limit dari disk: ${err.message}`);
  }
  return new Map();
}

// Debounce timer untuk menghindari terlalu banyak write ke disk
let _rateLimitSaveTimer = null;

/**
 * Simpan rate limit store ke disk (debounced 500ms).
 * File disimpan terenkripsi jika SESSION_SECRET aktif.
 */
function saveRateLimit() {
  if (_rateLimitSaveTimer) clearTimeout(_rateLimitSaveTimer);
  _rateLimitSaveTimer = setTimeout(() => {
    const obj = Object.fromEntries(ticketRateLimiter.records);
    encryptedStore.writeJson(RATELIMIT_FILE, obj);
  }, 500); // 500ms debounce
}

const ticketRateLimiter = new SlidingWindowRateLimiter(
  MAX_TICKETS_PER_WINDOW,
  RATE_WINDOW_MS,
  loadRateLimit(),
  saveRateLimit
);

function ticketRateLimitKeys(email, waNumber) {
  const keys = [`wa:${waNumber}`];
  if (email) keys.push(`email:${email.toLowerCase().trim()}`);
  return keys;
}

/**
 * Periksa apakah user sudah melebihi rate limit tiket.
 * Dipanggil SEBELUM submit tiket ke ManageEngine.
 * @param {string} waNumber
 * @param {string|null} email
 * @returns {{ blocked: boolean, resetInMs?: number }}
 */
function checkRateLimit(waNumber, email = null) {
  const keys = ticketRateLimitKeys(email, waNumber);
  const result = ticketRateLimiter.reserve(keys);
  if (!result.allowed) {
    return { blocked: true, resetInMs: result.resetInMs };
  }
  // Rollback reservasi — hanya dipakai untuk cek, bukan commit
  ticketRateLimiter.rollback(result.reservation);
  return { blocked: false };
}

/**
 * Catat penggunaan rate limit setelah tiket berhasil terkirim.
 * @param {string} waNumber
 * @param {string|null} email
 */
function incrementRateLimit(waNumber, email = null) {
  const keys = ticketRateLimitKeys(email, waNumber);
  ticketRateLimiter.reserve(keys); // commit otomatis saat reserve (tidak di-rollback)
}

/**
 * Periksa apakah tiket duplikat (payload sama dalam 10 menit).
 * @param {string} waNumber
 * @param {string} payloadStr - JSON.stringify(session.data)
 * @returns {boolean} true jika duplikat (harus ditolak)
 */
function checkDuplicateTicket(waNumber, payloadStr) {
  const fingerprint = `${waNumber}:${payloadStr}`;
  const reservation = duplicateTicketGuard.reserve(fingerprint);
  if (!reservation) return true; // duplikat
  // Commit duplikat guard langsung — tiket akan segera disubmit
  duplicateTicketGuard.commit(reservation);
  return false;
}

// ─── Input Error Limiter (per nomor WA) ──────────────────────────────────────
// Jika user salah isi form sebanyak INPUT_ERROR_MAX kali berturut-turut,
// dikenakan cooldown progresif (1, 5, 15 menit) yang disimpan di disk.
const INPUT_ERROR_MAX      = 5;
const INPUT_ERROR_FILE     = path.join(__dirname, '../../data/inputerror.json');

function loadInputErrorStore() {
  try {
    const obj = encryptedStore.readJson(INPUT_ERROR_FILE, {});
    const store = new Map();
    for (const [key, val] of Object.entries(obj)) {
      if (val && (val.errorCount > 0 || val.cooldownUntil)) store.set(key, val);
    }
    return store;
  } catch (err) { return new Map(); }
}
const inputErrorStore = loadInputErrorStore();

let _inputErrorSaveTimer = null;
function saveInputErrorStore() {
  if (_inputErrorSaveTimer) clearTimeout(_inputErrorSaveTimer);
  _inputErrorSaveTimer = setTimeout(() => {
    encryptedStore.writeJson(INPUT_ERROR_FILE, Object.fromEntries(inputErrorStore));
  }, 500);
}

function getInputErrorRecord(waNumber) {
  if (!inputErrorStore.has(waNumber)) {
    inputErrorStore.set(waNumber, { errorCount: 0, cooldownUntil: null, notified: false, tier: 0 });
  }
  return inputErrorStore.get(waNumber);
}

function checkInputCooldown(waNumber) {
  const rec = getInputErrorRecord(waNumber);
  const now = Date.now();
  if (rec.cooldownUntil && now < rec.cooldownUntil) {
    return { blocked: true, remainingMs: rec.cooldownUntil - now };
  }
  if (rec.cooldownUntil && now >= rec.cooldownUntil) {
    rec.errorCount   = 0;
    rec.cooldownUntil = null;
    rec.notified      = false;
    saveInputErrorStore();
  }
  return { blocked: false, remainingMs: 0 };
}

function incrementInputError(waNumber) {
  const rec = getInputErrorRecord(waNumber);
  rec.errorCount += 1;
  logger.info(`[InputLimit] ${waNumber} — kesalahan isi ke-${rec.errorCount}/${INPUT_ERROR_MAX}`);

  if (rec.errorCount >= INPUT_ERROR_MAX) {
    const tiers = [1 * 60000, 5 * 60000, 15 * 60000];
    const tierIdx = Math.min(rec.tier || 0, tiers.length - 1);
    const cooldownMs = tiers[tierIdx];
    rec.tier = (rec.tier || 0) + 1;
    rec.cooldownUntil = Date.now() + cooldownMs;
    rec.notified      = false;
    rec.errorCount    = 0;
    saveInputErrorStore();
    logger.warn(`[InputLimit] ${waNumber} — cooldown ${cooldownMs/60000} menit diaktifkan.`);

    setTimeout(async () => {
      try {
        const currentRec = inputErrorStore.get(waNumber);
        if (currentRec && !currentRec.notified) {
          currentRec.notified = true;
          saveInputErrorStore();
          const { sendMessageToNumber } = require('../services/whatsapp.service');
          await sendMessageToNumber(waNumber,
            '✅ *Waktu jeda telah selesai.*\n\n' +
            'Anda sudah bisa mengisi ulang data kembali.\n' +
            'Ketik *menu* untuk memulai dari awal, atau lanjutkan mengisi form.'
          );
        }
      } catch (notifErr) {}
    }, cooldownMs + 500);

    return { cooldownActivated: true };
  }
  saveInputErrorStore();
  return { cooldownActivated: false };
}

function resetInputError(waNumber) {
  const rec = inputErrorStore.get(waNumber);
  if (rec) {
    rec.tier = 0;
    rec.errorCount = 0;
    rec.cooldownUntil = null;
    saveInputErrorStore();
  }
}



// ─── Helper: Alur AUTORISASI ──────────────────────────────────────────────────
/**
 * Proses pengiriman tiket AUTORISASI.
 *
 * Alur berdasarkan tipe user:
 *
 * ── ATASAN (isSenior = true) ──────────────────────────────────────────────────
 *   1. Submit tiket dengan template SENIOR (ID: 2408, "Tanpa Approval")
 *      → ManageEngine TIDAK membuat approval level → tiket langsung ke teknisi
 *   2. Kirim konfirmasi ke atasan bahwa request diterima langsung
 *
 * ── USER BIASA (isSenior = false) ─────────────────────────────────────────────
 *   1. Submit tiket dengan template NORMAL (ID: 2404, "Formulir Permintaan Get Approvals")
 *      → ManageEngine membuat approval workflow → kirim notif ke atasan
 *   2. Daftarkan ke notification service untuk tracking
 *   3. Kirim WA approval ke atasan secara langsung
 *   4. Informasikan staf bahwa tiket terkirim & menunggu persetujuan atasan
 *
 * @param {object}   session   - Session user saat ini
 * @param {string}   waNumber  - Nomor WA staf pemohon
 * @param {Function} sendReply - Fungsi untuk membalas WA pemohon
 */
async function handleAutorisasiWithApproval(session, waNumber, sendReply, rateReservation, duplicateReservation) {
  const verifiedUser  = session.verifiedUser || null;
  const isSenior      = verifiedUser?.isSenior || false;
  const jobTitle      = verifiedUser?.jobTitle || verifiedUser?.jobtitle || '';
  const appName       = session.data.nama_aplikasi || '-';

  // ── 1. Submit tiket ke ManageEngine ─────────────────────────────────────────
  //    Atasan (isSenior=true)  → template 2408 (Tanpa Approval): tidak ada approval level
  //    User biasa              → template 2404 (Dengan Approval): approval workflow aktif
  let result;
  try {
    result = await submitToEndpoint(
      session.category,
      session.data,
      verifiedUser,
      { isSenior }
    );
  } catch (error) {
    ticketRateLimiter.rollback(rateReservation);
    duplicateTicketGuard.release(duplicateReservation);
    throw error;
  }

  if (!result.success) {
    ticketRateLimiter.rollback(rateReservation);
    duplicateTicketGuard.release(duplicateReservation);
    await sendReply(
      ` *Request gagal dikirim ke server PLN.*\n\n` +
      `ℹ️ Keterangan: ${result.message}\n\n` +
      `Ketik *menu* untuk kembali ke menu utama.`
    );
    resetSession(waNumber);
    return;
  }

  const requestId = result.requestId;
  duplicateTicketGuard.commit(duplicateReservation);
  const attachmentUploaded = requestId ? await uploadSessionMedia(requestId, session) : null;

  // ── 2. Daftarkan tiket ke notification service (untuk semua tipe user) ───────
  const supervisorWa    = verifiedUser?.supervisorWa    || null;
  const supervisorMeId  = verifiedUser?.supervisorMeId  || null;
  if (requestId) {
    registerTicket(
      requestId, waNumber,
      supervisorWa, supervisorMeId,
      verifiedUser,
      session.data.nama_aplikasi || null
    );
    logger.info(
      `[Handler] Tiket AUTORISASI ${requestId} didaftarkan — ` +
      `isSenior=${isSenior}, jabatan="${jobTitle}", ` +
      `supervisorWa: ${supervisorWa || 'N/A'}, supervisorMeId: ${supervisorMeId || 'N/A'}`
    );
  }

  // ── 3. ATASAN (isSenior=true): tiket sudah masuk langsung ke teknisi ─────────
  //    Tidak ada approval workflow di ManageEngine (template 2408 tidak punya level approver).
  //    Tidak perlu auto-approve, tidak perlu notif ke atasan lain — langsung konfirmasi.
  if (isSenior) {
    logger.info(
      `[Handler] isSenior=true (${jobTitle}) — template tanpa approval digunakan (ID: ` +
      `${result.requestId ? requestId : 'unknown'}). Tiket langsung ke teknisi.`
    );
    await sendReply(
      ` *Request berhasil dikirim ke IT Service Desk PLN Batam!*\n\n` +
      `*Kategori* : Pembuatan atau Perubahan Otorisasi Aplikasi\n` +
      `*Aplikasi* : ${appName}\n` +
      (requestId ? `*No. Tiket* : ${requestId}\n` : '') +
      `*Status*   : Disetujui Langsung ✅\n\n` +
      (attachmentUploaded && attachmentUploaded.failed > 0 ? `⚠️ Catatan: ${attachmentUploaded.failed} dari ${attachmentUploaded.uploaded + attachmentUploaded.failed} foto gagal diunggah.\n\n` : '') +
      ` Sebagai *${jobTitle}*, permintaan Anda tidak memerlukan persetujuan atasan.\n` +
      `Tim IT akan segera menindaklanjuti request Anda.\n\n` +
      `Ketik *menu* untuk mengajukan request baru.`
    );
    resetSession(waNumber);
    return;
  }

  // ── 4. USER BIASA: Kirim WA approval ke atasan langsung ─────────────────────
  //    Anti-duplikat: polling akan skip notif type="approval" jika requestId
  //    sudah ada di pendingApprovals store (dijaga oleh getSupervisorWaByRequestId).
  let approvalSentToSupervisor = false;
  if (requestId && supervisorWa) {
    try {
      // Simpan ke pending approval store terlebih dahulu
      addPendingApproval(supervisorWa, {
        requestId:      String(requestId),
        levelNumber:    '',      // diambil dinamis saat atasan balas
        approvalId:     '',      // diambil dinamis saat atasan balas
        staffWaNumber:  waNumber,
        staffName:      verifiedUser?.name       || '',
        appName:        appName,
        department:     verifiedUser?.department || '',
        supervisorMeId: supervisorMeId           || null,
        nip:            verifiedUser?.employeeId || '',
        userAccount:    session.data.username_aplikasi || verifiedUser?.loginName  || '',
        jabatan:        verifiedUser?.jobTitle   || '',
        staffData:      verifiedUser             || null
      });

      // Bangun pesan approval
      const approvalMsg = buildApprovalRequestMsg(requestId, '', {
        staffName:   verifiedUser?.name       || '',
        appName:     appName,
        department:  verifiedUser?.department || '',
        nip:         verifiedUser?.employeeId || '',
        userAccount: session.data.username_aplikasi || verifiedUser?.loginName  || '',
        jabatan:     verifiedUser?.jobTitle   || '',
        staffData:   verifiedUser             || null
      });

      // Kirim ke WA atasan
      const { sendMessageToNumber } = require('../services/whatsapp.service');
      const waResult = await sendMessageToNumber(supervisorWa, approvalMsg);

      if (waResult.success) {
        approvalSentToSupervisor = true;
        logger.info(`[Handler] ✓ WA approval langsung dikirim ke atasan ${supervisorWa} — tiket ${requestId}`);
      } else {
        // Gagal kirim WA — tidak fatal, polling akan retry secara otomatis
        logger.warn(
          `[Handler] Gagal kirim WA approval langsung ke ${supervisorWa}: ${waResult.error} ` +
          `— polling akan retry otomatis via notifikasi ManageEngine.`
        );
      }
    } catch (approvalErr) {
      logger.warn(`[Handler] Error saat kirim WA approval langsung: ${approvalErr.message} — polling akan retry.`);
    }
  } else if (requestId && !supervisorWa) {
    logger.info(
      `[Handler] supervisorWa belum diketahui untuk tiket ${requestId} — ` +
      `approval akan dikirim via polling saat ME mendeteksi notif type="approval".`
    );
  }

  // ── 5. Informasikan staf ─────────────────────────────────────────────────────
  const supervisorNote = approvalSentToSupervisor
    ? ` Permintaan persetujuan sudah dikirim otomatis ke WhatsApp atasan Anda.\n`
    : ` Permintaan persetujuan akan dikirim ke WhatsApp atasan Anda setelah diproses Tim IT.\n`;

  await sendReply(
    ` *Request berhasil dikirim ke IT Service Desk PLN Batam!*\n\n` +
    `*Kategori* : Pembuatan atau Perubahan Otorisasi Aplikasi\n` +
    `*Aplikasi* : ${appName}\n` +
    (requestId ? `*No. Tiket* : ${requestId}\n` : '') +
    `*Status* : Terkirim ke ServiceDesk\n\n` +
    (attachmentUploaded && attachmentUploaded.failed > 0 ? `⚠️ Catatan: ${attachmentUploaded.failed} dari ${attachmentUploaded.uploaded + attachmentUploaded.failed} foto gagal diunggah.\n\n` : '') +
    supervisorNote +
    `Anda akan mendapat notifikasi WhatsApp begitu atasan memberikan keputusan.\n\n` +
    `Ketik *menu* untuk mengajukan request baru.`
  );

  resetSession(waNumber);
}

async function uploadSessionMedia(requestId, session) {
  if (!requestId || !session.mediaList || session.mediaList.length === 0) return null;
  const result = await uploadAttachments(requestId, session.mediaList);
  session.mediaList = null;
  if (result.success) {
    logger.info(`[Handler] ✓ uploadAttachments (AUTORISASI) berhasil untuk tiket ${requestId} (${result.uploaded} foto)`);
  } else {
    logger.error(`[Handler] uploadAttachments (AUTORISASI) gagal untuk tiket ${requestId} | Error asli: ${result.errors.join(', ')}`);
  }
  return result; // return { success, uploaded, failed, errors }
}


/**
 * Menangani pesan yang berisi HANYA FOTO tanpa teks (fast path, tanpa lock).
 *
 * WhatsApp mengirim foto album sebagai banyak pesan image terpisah yang hampir
 * bersamaan. Karena acquireLock() menolak permintaan paralel untuk nomor yang
 * sama, foto ke-2 dan seterusnya akan hilang jika diproses lewat jalur utama.
 *
 * Fungsi ini tidak mengubah state machine — ia hanya mengumpulkan foto ke
 * session.mediaList sehingga aman dijalankan tanpa lock (JS event loop
 * single-threaded menjamin push() ke array tidak race-condition).
 */
async function handleImageOnly(waNumber, sendReply, msg) {
  const session = getSession(waNumber);

  // Hanya terima foto jika sedang dalam state yang mendukungnya
  if (![STATE.FILLING_FORM, STATE.CONFIRMING].includes(session.state)) {
    await sendReply('Silakan pilih kategori dan isi formulir terlebih dahulu sebelum mengirim foto.');
    return;
  }

  let media = null;

  // Metode 1: Library standar
  try {
    media = await msg.downloadMedia();
    if (media) logger.info(`[Handler] ✓ downloadMedia() library berhasil dari ${waNumber}`);
  } catch (err) {
    logger.warn(`[Handler] downloadMedia() library gagal dari ${waNumber} | Error asli: ${err.message || String(err)}`);
  }

  // Metode 2: Direct HTTPS + decrypt (fallback)
  if (!media && msg._data) {
    logger.info(`[Handler] Mencoba downloadMediaDirect() untuk ${waNumber}...`);
    try {
      media = await downloadMediaDirect(msg._data);
      if (media) logger.info(`[Handler] ✓ downloadMediaDirect() berhasil dari ${waNumber}`);
    } catch (err) {
      logger.error(`[Handler] downloadMediaDirect() gagal untuk ${waNumber} | Error: ${err.message || String(err)}`);
    }
  }

  if (!media) {
    logger.error(`[Handler] SEMUA metode download gagal untuk ${waNumber} (fast path)`);
    await sendReply('⚠️ Foto gagal diunduh dari sistem WhatsApp. Silakan coba kirim ulang foto Anda.');
    return;
  }

  const mediaBytes = Buffer.byteLength(media.data || '', 'base64');
  if (!['image/jpeg', 'image/png'].includes(media.mimetype) || mediaBytes > 5 * 1024 * 1024) {
    logger.warn(`[Handler] Media tidak valid dari ${waNumber} (mimetype: ${media.mimetype}, size: ${mediaBytes})`);
    await sendReply('Foto tidak dapat digunakan. Kirim file JPG/PNG dengan ukuran maksimal 5 MB.');
    return;
  }

  // Push ke mediaList — aman tanpa lock karena JS event loop single-threaded
  session.mediaList = session.mediaList || [];
  if (session.mediaList.length >= 5) {
    await sendReply('⚠️ Maksimal 5 foto per tiket. Foto ini tidak disimpan.\n\n_Ketik *OKE* untuk mengirim tiket, atau ketik *BATAL* untuk mengulang._');
    return;
  }

  session.mediaList.push({ data: media.data, mimetype: media.mimetype, filename: media.filename });
  sessions.set(waNumber, session);
  saveSessions(sessions);
  logger.info(`[Handler] Media foto ke-${session.mediaList.length} tersimpan ke session ${waNumber} — ${Math.round(mediaBytes / 1024)}KB`);

  const totalFoto = session.mediaList.length;
  const pesanFoto = totalFoto === 1
    ? `Foto Diterima ✅`
    : `Foto Diterima ✅ (${totalFoto} foto)`;
  await sendReply(pesanFoto);
}


/**
 * Handler utama untuk setiap pesan masuk
 *
 * @param {string} waNumber - Nomor WhatsApp pengirim
 * @param {string} messageText - Isi pesan
 * @param {Function} sendReply - Fungsi untuk mengirim balasan: (text) => Promise<void>
 * @param {Object|null} msg - Objek pesan asli dari WA (untuk media)
 */
async function handleMessage(waNumber, messageText, sendReply, msg = null) {
  if (!checkThrottle(waNumber)) {
    logger.warn(`[Throttle] WA ${waNumber} mengirim pesan terlalu cepat, diabaikan.`);
    return;
  }

  const text = (messageText || '').trim();

  // ── FAST PATH: Pesan foto tanpa teks — kumpulkan ke mediaList tanpa lock ──
  // WhatsApp mengirim foto album sebagai beberapa pesan terpisah yang hampir
  // bersamaan. acquireLock() akan menolak foto ke-2 dst karena foto ke-1 masih
  // diproses. Solusi: pesan image murni (tanpa teks) tidak memerlukan lock
  // karena hanya push ke session.mediaList, tidak mengubah state machine.
  if (msg?.hasMedia && msg.type === 'image' && !text) {
    await handleImageOnly(waNumber, sendReply, msg);
    return;
  }

  // Anti-spam lock dengan auto-expiry (Item 7)
  if (!acquireLock(waNumber)) {
    return;
  }

  try {
    if (!text && !(msg?.hasMedia && msg.type === 'image')) return;

    // Batasi panjang input dan sanitasi karakter berbahaya (Unicode control & formatting chars)
    let safeText = text.length > 500 ? text.substring(0, 500) : text;
    safeText = safeText
      // Hapus ASCII control chars (kecuali newline \n dan carriage return \r)
      .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, '')
      // Hapus Unicode formatting chars (zero-width, BIDI overrides, dsb)
      .replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F]/g, '');

    // ─── Intercept: Pesan APPROVE / REJECT dari Atasan ───────────────────────
    // Cek apakah nomor WA pengirim adalah atasan yang memiliki pending approval.
    // Ini dicek SEBELUM state machine agar atasan bisa menjawab dari luar alur bot.
    // Case-insensitive: 'approve', 'APPROVE', 'Approve' semua diterima
    const upperInput = safeText.toUpperCase().trim();
    if (hasPendingApproval(waNumber) && (upperInput === 'APPROVE' || upperInput === 'REJECT')) {
      const approvalData = getPendingApproval(waNumber);
      logger.info(`[Handler] Atasan ${waNumber} mengirim ${upperInput} untuk tiket ${approvalData.requestId}`);

      const isApprove = upperInput === 'APPROVE';

      // Ambil approvalLevels secara dinamis — levelNumber dan approvalId
      // tidak disimpan saat pending dibuat (diambil saat reply agar selalu akurat)
      let levelNumber = approvalData.levelNumber || null;
      let approvalId = approvalData.approvalId || null;

      // Jika store masih kosong, ambil dari API
      if (!levelNumber || !approvalId) {
        const levels = await getApprovalLevels(approvalData.requestId);

        // supervisorMeId: ManageEngine user ID atasan (disimpan saat approval didaftarkan)
        // Digunakan sebagai pencocokan UTAMA karena approval.approver hanya punya id, name, email
        // (TIDAK punya phone/mobile — terbukti dari Postman collection ManageEngine)
        let supervisorMeId = approvalData.supervisorMeId
          ? String(approvalData.supervisorMeId).trim()
          : null;

        // Jika supervisorMeId null (entri lama sebelum fitur ini diimplementasikan),
        // coba dapatkan dari API: requester tiket → reporting_to.id
        if (!supervisorMeId) {
          logger.info(
            `[Handler] supervisorMeId kosong untuk tiket ${approvalData.requestId} — ` +
            `mencoba ambil dari ManageEngine API...`
          );
          try {
            const { getTicketDetail, getUserById } = require('../services/ticket.service');
            const ticketDetail = await getTicketDetail(approvalData.requestId);
            const requesterId = ticketDetail?.requester?.id || null;
            if (requesterId) {
              const userDetail = await getUserById(requesterId);
              const reportingId = userDetail?.reportingTo?.id
                ? String(userDetail.reportingTo.id).trim()
                : null;
              if (reportingId) {
                supervisorMeId = reportingId;
                // Simpan ke store agar tidak perlu fetch lagi
                approvalData.supervisorMeId = supervisorMeId;
                const { addPendingApproval: _add, removePendingApproval: _rm } = require('../services/approval.service');
                // Update field di store (langsung mutasi objek yang ada di memory)
                logger.info(
                  `[Handler] supervisorMeId berhasil di-resolve via API: ${supervisorMeId} ` +
                  `(tiket ${approvalData.requestId})`
                );
              } else {
                logger.warn(
                  `[Handler] reporting_to.id tidak tersedia untuk requester ID ${requesterId} ` +
                  `(tiket ${approvalData.requestId}) — akan pakai fallback.`
                );
              }
            } else {
              logger.warn(
                `[Handler] Tidak bisa dapatkan requester ID dari tiket ${approvalData.requestId} — ` +
                `supervisorMeId tetap null, akan pakai fallback.`
              );
            }
          } catch (resolveErr) {
            logger.warn(
              `[Handler] Gagal resolve supervisorMeId dari API: ${resolveErr.message} — akan pakai fallback.`
            );
          }
        }

        // Strategi pencarian approvalId (prioritas dari akurat ke fallback):
        //   1. Cocokkan approver.id dengan supervisorMeId (ME user ID atasan) — PALING AKURAT
        //   2. Fallback: gunakan approval pertama yang ditemukan
        // CATATAN: approval.approver dari API ManageEngine HANYA memiliki: id, name, email_id
        //          TIDAK ada phone/mobile — pencocokan via phone tidak mungkin dilakukan
        let bestLevelNumber = null;
        let bestApprovalId = null;
        let fallbackLevelNumber = null;
        let fallbackApprovalId = null;

        for (const level of levels) {
          const lvlId = level.level_number ?? level.id;
          let approvals = level.approvals || [];

          // Endpoint parent tidak menyertakan nested approvals
          // — fetch dari sub-endpoint jika array masih kosong
          if (approvals.length === 0) {
            approvals = await getApprovalsByLevel(approvalData.requestId, lvlId);
          }

          for (const approval of approvals) {
            const approverId = String(approval.approver?.id || '').trim();
            const approverName = approval.approver?.name || '-';

            // Simpan fallback: approval pertama yang ada
            if (!fallbackApprovalId) {
              fallbackLevelNumber = String(lvlId);
              fallbackApprovalId = String(approval.id);
            }

            // Pencocokan utama: approver.id === supervisorMeId (ManageEngine user ID atasan)
            // Ini dijamin akurat karena ID bersifat unik di ManageEngine
            if (supervisorMeId && approverId && approverId === supervisorMeId) {
              bestLevelNumber = String(lvlId);
              bestApprovalId = String(approval.id);
              logger.info(
                `[Handler] ✓ approvalId cocok via ME user ID: approver="${approverName}" ` +
                `(id=${approverId}), level=${lvlId}, approvalId=${approval.id}`
              );
              break;
            }
          }

          if (bestApprovalId) break;
        }

        // Gunakan hasil terbaik: yang cocok dengan supervisorMeId, atau fallback
        levelNumber = bestLevelNumber || fallbackLevelNumber;
        approvalId = bestApprovalId || fallbackApprovalId;

        if (!bestApprovalId && fallbackApprovalId) {
          logger.warn(
            `[Handler] ⚠ Tidak ditemukan approval yang cocok dengan supervisorMeId=${supervisorMeId || 'tidak ada'} ` +
            `— menggunakan fallback approvalId=${fallbackApprovalId} (level=${fallbackLevelNumber}). ` +
            `Pastikan reporting_to.id di ManageEngine sesuai dengan approver workflow tiket.`
          );
        }
      }

      if (!levelNumber || !approvalId) {
        await sendReply(
          ` *Tidak dapat memproses keputusan.*\n\n` +
          `Data approval untuk tiket *${approvalData.requestId}* belum tersedia di ManageEngine.\n` +
          `Kemungkinan Tim IT belum mengaktifkan workflow approval.\n\n` +
          `Silakan hubungi Tim IT secara langsung.`
        );
        return;
      }

      // ── Guard: cek status approval sebelum PUT ke ManageEngine ─────────────
      // Jika approval sudah dieksekusi (Approved/Rejected) sebelum bot action
      // (misalnya oleh Tim IT dari dashboard), jangan double-action ke ME.
      // ManageEngine akan melempar "Approval(s) doesn't belong to current level"
      // jika approval sudah tidak aktif (bukan Pending).
      try {
        const { getApprovalsByLevel: _getApprsByLvl } = require('../services/ticket.service');
        const currentApprovals = await _getApprsByLvl(approvalData.requestId, levelNumber);
        const thisApproval = currentApprovals.find(a => String(a.id) === String(approvalId));
        const currentStatus = (thisApproval?.status?.name || '').toLowerCase();
        const isPending = currentStatus.includes('pending') || currentStatus === '';

        if (!isPending) {
          logger.info(
            `[Handler] Approval ${approvalId} tiket ${approvalData.requestId} sudah berstatus "${thisApproval?.status?.name}" ` +
            `— skip PUT ke ManageEngine (sudah diproses sebelumnya).`
          );
          removePendingApproval(waNumber, approvalData.requestId);
          await sendReply(
            ` *Persetujuan sudah diproses sebelumnya.*\n\n` +
            `Tiket *${approvalData.requestId}* sudah berstatus *${thisApproval?.status?.name || 'Selesai'}* di sistem ManageEngine.\n` +
            `Tidak perlu melakukan tindakan lagi.\n\nTerima kasih.`
          );
          return;
        }
      } catch (guardErr) {
        // Jika gagal cek status (network error dsb), lanjutkan ke PUT biasa
        logger.warn(`[Handler] Gagal cek status approval sebelum PUT: ${guardErr.message} — lanjutkan ke PUT.`);
      }

      const apiResult = isApprove
        ? await approveTicket(approvalData.requestId, levelNumber, approvalId)
        : await rejectTicket(approvalData.requestId, levelNumber, approvalId);

      if (apiResult.success) {
        // Hapus dari pending store
        removePendingApproval(waNumber, approvalData.requestId);

        // Helper: bangun detail lines, hanya tampilkan baris yang ada nilainya
        function buildDetailLines(data) {
          const sd = data.staffData || {};
          const nip = sd.employeeId || data.nip || '';
          const nama = sd.name || data.staffName || '';
          const akun = data.userAccount || sd.loginName || '';
          const unit = sd.department || data.department || '';
          const jab = sd.jobTitle || data.jabatan || '';
          const rows = [];
          if (data.appName) rows.push(`*Nama Aplikasi* : ${data.appName}`);
          if (nip)          rows.push(`*Nomor Induk Pegawai* : ${nip}`);
          if (nama)         rows.push(`*Nama Lengkap* : ${nama}`);
          if (akun)         rows.push(`*Username Aplikasi* : ${akun}`);
          if (unit)         rows.push(`*Unit/Bidang/Bagian* : ${unit}`);
          if (jab)          rows.push(`*Jabatan* : ${jab}`);
          rows.push(         `*No. Tiket* : ${data.requestId}`);
          return rows.join('\n');
        }

        // ── Notifikasi ke atasan (konfirmasi keputusan berhasil diproses) ────
        const atasanMsg = isApprove
          ? ` *Persetujuan berhasil diproses!*\n\n` +
          `Anda telah *menyetujui* permintaan berikut:\n\n` +
          buildDetailLines(approvalData) +
          `\n\nPegawai akan menerima notifikasi dari sistem IT Service Desk.\nTerima kasih.`
          : ` *Penolakan berhasil diproses!*\n\n` +
          `Anda telah *menolak* permintaan berikut:\n\n` +
          buildDetailLines(approvalData) +
          `\n\nPegawai akan menerima notifikasi dari sistem IT Service Desk.\nTerima kasih.`;
        await sendReply(atasanMsg);

        // CATATAN: Notifikasi hasil ke pegawai (staf pemohon) TIDAK dikirim di sini.
        // ManageEngine akan otomatis mengirim system_notification "has been Approved/Rejected"
        // yang akan ditangkap oleh polling (notification.service.js → buildSystemNotifMsg)
        // dan diteruskan ke WA pegawai secara otomatis.

        // ── Tampilkan pending approval berikutnya jika ada ─────────────────
        const remaining = getRemainingCount(waNumber);
        if (remaining > 0) {
          const next = getPendingApproval(waNumber);
          await sendReply(
            `\n Masih ada *${remaining} permintaan* lain yang menunggu persetujuan Anda:\n\n` +
            buildDetailLines(next) +
            `\n\nBalas *APPROVE* untuk menyetujui atau *REJECT* untuk menolak.`
          );
        }

      } else {
        // API approval gagal
        await sendReply(
          ` *Gagal memproses keputusan.*\n\n` +
          `Keterangan: ${apiResult.error}\n\n` +
          `Silakan coba kembali atau hubungi Tim IT secara langsung.`
        );
      }

      return; // Jangan lanjutkan ke state machine normal
    }

    const session = getSession(waNumber);

    if (msg?.hasMedia && msg.type === 'image') {
      if (![STATE.FILLING_FORM, STATE.CONFIRMING].includes(session.state)) {
        if (!safeText) {
          await sendReply('Silakan pilih kategori dan isi formulir terlebih dahulu sebelum mengirim foto.');
          return;
        }
        // Ada teks tapi state tidak tepat untuk media — lanjutkan proses teks saja, abaikan media
      } else {
        // ── Download Media: dua metode berurutan ───────────────────────────
        // Metode 1: downloadMedia() via library (Puppeteer + WA Web internal)
        // Metode 2: downloadMediaDirect() via HTTPS + AES-256-CBC Node.js (bypass Puppeteer)
        let media = null;

        // --- Metode 1: Library standar ---
        try {
          media = await msg.downloadMedia();
          if (media) {
            logger.info(`[Handler] ✓ downloadMedia() library berhasil dari ${waNumber}`);
          }
        } catch (err) {
          logger.warn(`[Handler] downloadMedia() library gagal dari ${waNumber} | Error asli: ${err.message || String(err)}`);
        }

        // --- Metode 2: Direct HTTPS + decrypt (fallback jika library gagal) ---
        if (!media && msg._data) {
          logger.info(`[Handler] Mencoba downloadMediaDirect() (bypass Puppeteer) untuk ${waNumber}...`);
          try {
            media = await downloadMediaDirect(msg._data);
            if (media) {
              logger.info(`[Handler] ✓ downloadMediaDirect() berhasil dari ${waNumber}`);
            }
          } catch (err) {
            logger.error(`[Handler] downloadMediaDirect() gagal untuk ${waNumber} | Error: ${err.message || String(err)}`);
          }
        }

        // --- Simpan media ke session atau beri peringatan ---
        if (media) {
          const mediaBytes = Buffer.byteLength(media.data || '', 'base64');
          if (['image/jpeg', 'image/png'].includes(media.mimetype) && mediaBytes <= 5 * 1024 * 1024) {
            session.mediaList = session.mediaList || [];
            
            if (session.mediaList.length >= 5) {
              if (!safeText) {
                await sendReply('⚠️ Maksimal 5 foto per tiket. Foto ini tidak disimpan.\n\n_Ketik *OKE* untuk mengirim tiket, atau ketik *BATAL* untuk mengulang._');
                return;
              }
            } else {
              session.mediaList.push({
                data: media.data,
                mimetype: media.mimetype,
                filename: media.filename
              });
              sessions.set(waNumber, session);
              saveSessions(sessions);
              logger.info(`[Handler] Media foto ke-${session.mediaList.length} tersimpan ke session ${waNumber} — ${Math.round(mediaBytes / 1024)}KB`);

              if (!safeText) {
                const tot = session.mediaList.length;
                await sendReply(tot === 1 ? `Foto Diterima ✅` : `Foto Diterima ✅ (${tot} foto)`);
                return;
              }
            }
          } else {
            logger.warn(`[Handler] Media tidak valid (mimetype: ${media.mimetype}, size: ${Buffer.byteLength(media.data || '', 'base64')}) dari ${waNumber}`);
            if (!safeText) {
              await sendReply('Foto tidak dapat digunakan. Kirim file JPG/PNG dengan ukuran maksimal 5 MB.');
              return;
            }
          }
        } else {
          // Kedua metode gagal
          logger.error(`[Handler] SEMUA metode download gagal untuk ${waNumber} — foto tidak akan dilampirkan.`);
          if (!safeText) {
            await sendReply('⚠️ Foto gagal diunduh dari sistem WhatsApp. Silakan coba kirim ulang foto Anda.');
            return;
          }
          await sendReply('⚠️ Foto gagal diunduh, tapi data form Anda tetap diproses.\n_Anda bisa mengirim ulang foto setelah konfirmasi jika diperlukan._');
        }
      }
    }

    if (!safeText) return;

    // ─── Keyword Global: Reset / Batal / Menu ────────────────────────────
    // Semua keyword dicek secara case-insensitive via normalisasi ke lowercase
    const lowerText = safeText.toLowerCase().trim();

    if (['batal', 'cancel', 'reset', 'menu', 'ulang', 'halo', 'hai', 'hi', 'p', 'ping', 'help'].includes(lowerText)) {
      const wasActive = session.state !== STATE.IDLE;
      resetSession(waNumber);

      if (wasActive) {
        await sendReply(
          ` *Sesi dibatalkan.*\n\n` +
          `Tidak ada perubahan yang disimpan.\n\n` +
          WELCOME_MSG
        );
      } else {
        await sendReply(WELCOME_MSG);
      }
      return;
    }

    // ─── Keyword "ubah" di luar state CONFIRMING — beri panduan ──────────
    // Kata "ubah" hanya berlaku saat CONFIRMING. Di state lain, beri pesan
    // panduan agar user tidak bingung.
    if (lowerText === 'ubah' && session.state !== STATE.CONFIRMING) {
      if (session.state === STATE.FILLING_FORM) {
        const config = CATEGORY_CONFIG[session.category];
        await sendReply(
          ` Untuk mengubah data, silakan isi ulang semua field di bawah ini:\n\n` +
          buildAllFieldsPrompt(config)
        );
      } else {
        // IDLE atau SELECTING_CATEGORY
        await sendReply(WELCOME_MSG);
      }
      return;
    }

    // ─── State Machine ────────────────────────────────────────────────────
    switch (session.state) {

      // ═══ STATE: IDLE ═════════════════════════════════════════════════════
      case STATE.IDLE: {
        // ── Cek cooldown salah isi (input error limit) ───────────────────
        const idleCooldown = checkInputCooldown(waNumber);
        if (idleCooldown.blocked) {
          const remainSecs = Math.ceil(idleCooldown.remainingMs / 1000);
          await sendReply(
            `⏳ *Anda sedang dalam masa jeda.*\n\n` +
            `Anda telah melakukan kesalahan pengisian sebanyak ${INPUT_ERROR_MAX} kali.\n` +
            `Silakan coba lagi dalam *${remainSecs} detik*.\n\n` +
            `Anda akan mendapat pemberitahuan otomatis saat jeda selesai.`
          );
          return;
        }

        // Jika user langsung mengirim angka 1-4 (misal setelah batal),
        // langsung proses sebagai pilihan kategori tanpa tampilkan menu dulu
        const directCategory = CATEGORY_MAP[safeText];
        if (directCategory) {
          const directConfig = CATEGORY_CONFIG[directCategory];
          session.state = STATE.FILLING_FORM;
          session.category = directCategory;
          session.data = {};
          sessions.set(waNumber, session);
          saveSessions(sessions);
          logger.info(`[Request Masuk] Kategori: ${directConfig.label}`);
          await sendReply(
            `Baik, Anda memilih *${directConfig.label}* \n\n` +
            `Ketik *batal* kapan saja untuk membatalkan.\n\n` +
            buildAllFieldsPrompt(directConfig)
          );
        } else {
          // Input bukan angka — tampilkan menu pilihan
          session.state = STATE.SELECTING_CATEGORY;
          sessions.set(waNumber, session);
          saveSessions(sessions);
          await sendReply(WELCOME_MSG);
        }
        break;
      }

      case STATE.SELECTING_CATEGORY: {
        const category = CATEGORY_MAP[safeText];

        if (!category) {
          await sendReply(
            `Hmm, pilihan *${safeText}* tidak tersedia \n\n` +
            `Silakan balas dengan angka:\n` +
            `1. Permintaan Reset Password\n` +
            `2. Pembuatan atau Perubahan Otorisasi Aplikasi\n` +
            `3. Permintaan/Keluhan\n` +
            `4. Akses VPN`
          );
          return;
        }

        const config = CATEGORY_CONFIG[category];
        session.state = STATE.FILLING_FORM;
        session.category = category;
        session.data = {};
        sessions.set(waNumber, session);
        saveSessions(sessions);

        // Catat sebagai request masuk (untuk metrik dashboard)
        logger.info(`[Request Masuk] Kategori: ${config.label}`);

        // Kirim prompt semua field sekaligus
        await sendReply(
          `Baik, Anda memilih *${config.label}* \n\n` +
          `Ketik *batal* kapan saja untuk membatalkan.\n\n` +
          buildAllFieldsPrompt(config)
        );
        break;
      }

      // ═══ STATE: FILLING_FORM (semua field sekaligus, numbered list) ═══════
      case STATE.FILLING_FORM: {
        const config = CATEGORY_CONFIG[session.category];

        // ── Cek cooldown salah isi sebelum proses apapun ──────────────────
        const formCooldown = checkInputCooldown(waNumber);
        if (formCooldown.blocked) {
          const remainSecs = Math.ceil(formCooldown.remainingMs / 1000);
          await sendReply(
            `⏳ *Anda sedang dalam masa jeda.*\n\n` +
            `Anda telah melakukan kesalahan pengisian sebanyak ${INPUT_ERROR_MAX} kali.\n` +
            `Silakan coba lagi dalam *${remainSecs} detik*.\n\n` +
            `Anda akan mendapat pemberitahuan otomatis saat jeda selesai.`
          );
          return;
        }

        // Parse balasan user berformat numbered list
        // Hitung indeks field nullable (opsional) dari config
        const nullableFields = config.nullableFields || [];
        const nullableIndices = new Set(
          nullableFields.map(f => config.fields.indexOf(f)).filter(i => i >= 0)
        );
        const parsed = parseNumberedList(safeText, config.fields.length, nullableIndices);

        if (!parsed) {
          // Format tidak dikenali — hitung sebagai 1 kesalahan
          const errResult = incrementInputError(waNumber);
          const rec = getInputErrorRecord(waNumber);
          const errCount = errResult.cooldownActivated ? INPUT_ERROR_MAX : rec.errorCount;

          if (errResult.cooldownActivated) {
            await sendReply(
              `⏳ *Terlalu banyak kesalahan pengisian (${INPUT_ERROR_MAX}x).*\n\n` +
              `Sistem memberikan jeda *1 menit* sebelum Anda dapat mencoba kembali.\n` +
              `Anda akan mendapat pemberitahuan otomatis saat jeda selesai.`
            );
          } else {
            await sendReply(
              `⚠️ Format tidak dikenali. Mohon isi semua data dengan format nomor urut.\n` +
              `_(Percobaan salah: ${errCount}/${INPUT_ERROR_MAX} — ${INPUT_ERROR_MAX - errCount} kesempatan tersisa)_\n\n` +
              buildAllFieldsPrompt(config)
            );
          }
          return;
        }

        // Validasi semua field sekaligus
        const errors = [];
        const newData = {};

        for (let i = 0; i < config.fields.length; i++) {
          const fieldKey = config.fields[i];
          const value = parsed[i];
          const validation = validateField(fieldKey, value);

          if (!validation.valid) {
            errors.push(`• *${config.fieldLabels[fieldKey]}*: ${validation.message}`);
          } else {
            // ── Case-insensitive handling ────────────────────────────────────
            // Email (requester) : dipertahankan case asli sesuai input (case-sensitive)
            // nama_aplikasi     : disimpan case asli, lookup case-insensitive
            // keluhan / alasan  : disimpan case asli
            newData[fieldKey] = value.trim();
          }
        }

        if (errors.length > 0) {
          // Hitung sebagai 1 kesalahan input
          const errResult = incrementInputError(waNumber);
          const rec = getInputErrorRecord(waNumber);
          const errCount = errResult.cooldownActivated ? INPUT_ERROR_MAX : rec.errorCount;

          if (errResult.cooldownActivated) {
            await sendReply(
              `⏳ *Terlalu banyak kesalahan pengisian (${INPUT_ERROR_MAX}x).*\n\n` +
              `Sistem memberikan jeda *1 menit* sebelum Anda dapat mencoba kembali.\n` +
              `Anda akan mendapat pemberitahuan otomatis saat jeda selesai.`
            );
          } else {
            await sendReply(
              `⚠️ Ada data yang perlu diperbaiki:\n\n${errors.join('\n')}\n` +
              `_(Percobaan salah: ${errCount}/${INPUT_ERROR_MAX} — ${INPUT_ERROR_MAX - errCount} kesempatan tersisa)_\n\n` +
              buildAllFieldsPrompt(config)
            );
          }
          return;
        }

        // Semua field valid — validasi email ke ManageEngine SEBELUM submit
        session.data = newData;
        sessions.set(waNumber, session);
        saveSessions(sessions);
        await sendReply('⏳ Memvalidasi email...');

        // ── Langkah 1: GET /api/v3/users — cek email terdaftar ─────────────
        const lookupResult = await lookupUserByEmail(newData.requester);

        if (!lookupResult.found) {
          logger.warn(`[Handler]  Email tidak terdaftar: ${newData.requester}`);
          // Hitung sebagai 1 kesalahan input (email salah = data tidak valid)
          const errResult = incrementInputError(waNumber);
          const rec = getInputErrorRecord(waNumber);
          const errCount = errResult.cooldownActivated ? INPUT_ERROR_MAX : rec.errorCount;

          session.state = STATE.FILLING_FORM;
          session.data = {};
          sessions.set(waNumber, session);
          saveSessions(sessions);

          if (errResult.cooldownActivated) {
            await sendReply(
              `⏳ *Terlalu banyak kesalahan pengisian (${INPUT_ERROR_MAX}x).*\n\n` +
              `Sistem memberikan jeda *1 menit* sebelum Anda dapat mencoba kembali.\n` +
              `Anda akan mendapat pemberitahuan otomatis saat jeda selesai.`
            );
          } else {
            await sendReply(
              `⚠️ *Email tidak terdaftar di sistem PLN.*\n\n` +
              `Email *${newData.requester}* tidak ditemukan di database ManageEngine.\n` +
              `Pastikan email yang Anda gunakan adalah email kantor yang terdaftar.\n` +
              `_(Percobaan salah: ${errCount}/${INPUT_ERROR_MAX} — ${INPUT_ERROR_MAX - errCount} kesempatan tersisa)_\n\n` +
              buildAllFieldsPrompt(config)
            );
          }
          return;
        }

        // Langkah 2: Email valid — simpan data user terverifikasi & reset error counter
        resetInputError(waNumber);
        session.verifiedUser = lookupResult.user;
        // Simpan nama dan departemen ke session.data agar bisa ditampilkan di konfirmasi
        session.data.requester_name = lookupResult.user.name || '';
        session.data.requester_department = lookupResult.user.department || '';
        sessions.set(waNumber, session);
        saveSessions(sessions);
        logger.info(`[Handler] User tervalidasi: ${lookupResult.user.name} (${lookupResult.user.department})`);

        // Set state CONFIRMING sebelum kirim pesan konfirmasi
        session.state = STATE.CONFIRMING;
        sessions.set(waNumber, session);
        saveSessions(sessions);

        // Bangun ringkasan konfirmasi — format *Label* : value (mobile-friendly)
        const W2_base = ['Nama Pegawai', 'Departemen', 'Email Kantor', 'Kategori'];
        const allLabels = [
          ...W2_base,
          ...config.fields.filter(k => k !== 'requester').map(k => config.fieldLabels[k] || k)
        ];
        const confirmLines = [
          `*Nama Pegawai* : ${session.data.requester_name}`,
          `*Departemen* : ${session.data.requester_department}`,
          `*Email Kantor* : ${session.data.requester}`,
          `*Kategori* : ${config.label}`,
          ...config.fields
            .filter(k => k !== 'requester')
            .map(k => `*${config.fieldLabels[k] || k}* : ${session.data[k] || ''}`)
        ].join('\n');

        await sendReply(
          ` *Email terverifikasi. Berikut ringkasan pengajuan Anda:*\n\n` +
          confirmLines +
          `\n\nKetik *OKE* untuk mengirim ke sistem IT PLN.\n` +
          `Ketik *UBAH* untuk mengisi ulang data.\n` +
          `Ketik *BATAL* untuk membatalkan pengajuan.`
        );

        break;
      }

      // ═══ STATE: CONFIRMING ════════════════════════════════════════════════
      case STATE.CONFIRMING: {
        // Normalisasi ke uppercase untuk perbandingan — case-insensitive
        const upperText = safeText.toUpperCase().trim();

        if (['YA', 'Y', 'YES', 'BENAR', 'OKE', 'OK'].includes(upperText)) {
          // ── Cek duplikat tiket (Item 8) ────────────────────────────────────
          const payloadStr = JSON.stringify(session.data);
          const fingerprint = `${waNumber}:${payloadStr}`;
          const dupReservation = duplicateTicketGuard.reserve(fingerprint);
          if (!dupReservation) {
            logger.warn(`[Duplicate] WA ${waNumber} mencoba mengirim tiket duplikat`);
            await sendReply(
              `🚫 *Tiket Duplikat Terdeteksi.*\n` +
              `Anda baru saja mengirimkan permintaan dengan data yang persis sama.\n` +
              `Sistem mengabaikan permintaan ini untuk mencegah duplikasi di ManageEngine.\n\n` +
              `Silakan ketik *menu* untuk mengajukan request baru.`
            );
            resetSession(waNumber);
            return;
          }

          await sendReply(' Sedang mengirim tiket ke server PLN...');

          try {
            // ── Kategori AUTORISASI: semua pengecekan (ASMAN, reporting_to, nomor) ───
            // dilakukan di dalam handleAutorisasiWithApproval.
            if (session.category === 'AUTORISASI') {
              logger.info(`[Handler] Kategori AUTORISASI — routing ke approval flow.`);
              await handleAutorisasiWithApproval(session, waNumber, sendReply);
              return;
            }

            // ── POST /api/v3/requests — kirim tiket ─────────────────────────
            const result = await submitToEndpoint(
              session.category,
              session.data,
              session.verifiedUser || null   // kirim data user lookup untuk mapping ID & phone
            );

            const verifiedUser = session.verifiedUser || {};

            if (result.success) {
              // ── Upload Attachment jika ada ─────────────────────────────────
              let uploadResult = null;
              if (result.requestId && session.mediaList && session.mediaList.length > 0) {
                uploadResult = await uploadAttachments(result.requestId, session.mediaList);
                if (!uploadResult.success) {
                  logger.error(`[Handler] uploadAttachments gagal untuk tiket ${result.requestId} | Error asli: ${uploadResult.errors.join(', ')}`);
                } else {
                  logger.info(`[Handler] ✓ uploadAttachments berhasil untuk tiket ${result.requestId} (${uploadResult.uploaded} foto)`);
                }
                // Bersihkan media setelah diupload
                session.mediaList = null;
              }

              // Catat penggunaan rate limit user
              const _emailForLimit = (session.verifiedUser?.email || session.data?.requester || waNumber);
              incrementRateLimit(waNumber, _emailForLimit);

              // ── Daftarkan tiket ke notification service ─────────────────────
              // Agar setiap notifikasi/balasan dari admin di ManageEngine
              // diteruskan langsung ke WhatsApp pegawai ini.
              if (result.requestId) {
                registerTicket(result.requestId, waNumber);
              }

              const successLines = [
                `*Kategori* : ${CATEGORY_CONFIG[session.category].label}`,
                ...(verifiedUser.name ? [`*Requester* : ${verifiedUser.name} (${verifiedUser.department})`] : []),
                ...(result.requestId  ? [`*No. Tiket* : ${result.requestId}`] : []),
                `*Status* : Dikirim ke sistem IT PLN Batam`,
              ].join('\n');
              
              let replyMsg = `✅ *Request berhasil dikirim!*\n\n` + successLines;
              
              if (uploadResult && uploadResult.failed > 0) {
                if (uploadResult.uploaded === 0) {
                  replyMsg += `\n\n⚠️ *Catatan:* Tiket terkirim, tetapi semua foto gagal diunggah ke sistem.`;
                } else {
                  replyMsg += `\n\n⚠️ *Catatan:* ${uploadResult.failed} dari ${uploadResult.uploaded + uploadResult.failed} foto gagal diunggah ke sistem.`;
                }
              }
              
              replyMsg += `\n\nTerima kasih telah menggunakan IT Service Desk Bot. Ketik *menu* kapan saja untuk mengajukan request baru.`;
              
              await sendReply(replyMsg);
            } else {
              await sendReply(
                ` *Request gagal dikirim ke server PLN.*\n\n` +
                ` Keterangan: ${result.message}\n\n` +
                `Ketik *menu* untuk kembali ke menu utama.`
              );
            }
          } catch (err) {
            // Buat kode referensi error singkat agar user bisa melaporkan ke Tim IT
            // (6 karakter hex dari timestamp — tidak mengekspos detail teknis)
            const errRef = Date.now().toString(16).slice(-6).toUpperCase();
            logger.error(`[Handler] Error submit [REF:${errRef}]: ${err.message}`, { error: err });
            await sendReply(
              ` *Pengiriman tiket gagal.*\n\n` +
              `Terjadi gangguan saat menghubungi sistem IT PLN Batam.\n\n` +
              ` *Yang bisa Anda lakukan:*\n` +
              `- Coba kirim ulang beberapa saat lagi\n` +
              `- Ketik *menu* untuk memulai dari awal\n` +
              `- Hubungi Tim IT jika masalah berlanjut\n\n` +
              `_Kode referensi: ${errRef}_`
            );
          }

          // Reset session setelah selesai
          resetSession(waNumber);

        } else if (['TIDAK', 'NO', 'SALAH', 'UBAH'].includes(upperText)) {
          // Kembali ke pengisian form dari awal
          const config = CATEGORY_CONFIG[session.category];
          session.state = STATE.FILLING_FORM;
          session.data = {};
          sessions.set(waNumber, session);
          saveSessions(sessions);

          await sendReply(
            `Baik, mari kita isi ulang data untuk *${config.label}*.\n\n` +
            buildAllFieldsPrompt(config)
          );

        } else if (['BATAL', 'CANCEL'].includes(upperText)) {
          // Batalkan pengajuan sepenuhnya — kembali ke menu utama
          resetSession(waNumber);
          await sendReply(
            ` *Pengajuan dibatalkan.*\n\n` +
            `Tidak ada tiket yang dikirim ke sistem IT.\n` +
            `Ketik *menu* kapan saja jika ingin mengajukan request baru.`
          );
        } else {
          await sendReply(
            `Mohon balas dengan:\n` +
            `- *OKE* — jika data sudah benar dan ingin dikirim\n` +
            `- *UBAH* — untuk mengisi ulang data\n` +
            `- *BATAL* — untuk membatalkan pengajuan`
          );
        }
        break;
      }


      default:
        resetSession(waNumber);
        await sendReply(WELCOME_MSG);
    }

  } catch (error) {
    logger.error(`[Handler]  Error untuk ${waNumber}: ${error.message}`, { error });
  } finally {
    releaseLock(waNumber); // Item 7: selalu release lock
  }
}

module.exports = { handleMessage, initApprovalService, startApprovalReminders };
