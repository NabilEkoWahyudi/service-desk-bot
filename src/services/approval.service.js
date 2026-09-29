/**
 * ═══════════════════════════════════════════════════════════════
 * APPROVAL SERVICE — IT Help Desk Bot PLN Batam
 * ═══════════════════════════════════════════════════════════════
 *
 * Mengelola pending approval untuk kategori AUTORISASI.
 *
 * Alur:
 *   1. Staf mengajukan request AUTORISASI
 *   2. Bot membuat tiket di ManageEngine, lalu kirim WA ke atasan (ASMAN)
 *   3. Atasan balas APPROVE atau REJECT (case-insensitive)
 *   4. Bot meneruskan ke ManageEngine via API approve/reject
 *
 *   Store:
 *   Map<supervisorWaNumber, ApprovalItem[]>
 *   Persisten ke data/pending_approvals.json
 *   ApprovalItem: { requestId, levelNumber, approvalId,
 *                   staffWaNumber, staffName, appName, department,
 *                   supervisorMeId, createdAt }
 *
 *   supervisorMeId : ManageEngine user ID atasan (untuk cocokkan approver.id saat APPROVE/REJECT)
 *
 * KEAMANAN STARTUP:
 *   Modul ini TIDAK mengirim pesan WA apapun saat diimpor.
 *   loadPendingApprovals() hanya MEMBACA file dari disk ke memori.
 *   Pengiriman WA hanya terjadi saat:
 *     - handleAutorisasiWithApproval() dipanggil (user submit AUTORISASI)
 *     - Atasan membalas APPROVE/REJECT via WhatsApp
 */

'use strict';

const path            = require('path');
const logger          = require('../utils/logger');
const encryptedStore  = require('../utils/encrypted-store');

// ─── Konfigurasi (dari env, tidak hardcoded) ──────────────────────────────────

/**
 * Durasi maksimum pending approval sebelum dianggap expired.
 * Default: 7 hari. Dapat dikonfigurasi via env APPROVAL_MAX_DAYS.
 */
const APPROVAL_MAX_DAYS       = parseInt(process.env.APPROVAL_MAX_DAYS || '7', 10);
const MAX_APPROVAL_DURATION_MS = APPROVAL_MAX_DAYS * 24 * 60 * 60 * 1000;

/**
 * Path file persisten pending approvals.
 * Selalu berada di folder data/ relatif terhadap project root.
 * Folder data/ sudah masuk .gitignore — tidak akan ter-commit ke git.
 */
const APPROVAL_DATA_FILE = path.join(__dirname, '../../data/pending_approvals.json');

// ─── In-Memory Store ──────────────────────────────────────────────────────────
// Map<supervisorWaNumber, ApprovalItem[]>
const pendingApprovals = new Map();

// ─── Persistence ─────────────────────────────────────────────────────────────

/**
 * Muat pending approvals dari disk ke memori.
 *
 * ⚠️  PENTING: Fungsi ini HANYA membaca file — tidak mengirim pesan WA apapun.
 *     Aman dipanggil saat startup tanpa risiko pengiriman pesan tidak sengaja.
 *
 * Dipanggil SEKALI dari index.js via initApprovalService(), setelah WhatsApp
 * siap — bukan otomatis saat modul diimpor.
 *
 * Approval yang sudah expired (> APPROVAL_MAX_DAYS hari) otomatis dibuang.
 */
function loadPendingApprovals() {
  try {
    const obj = encryptedStore.readJson(APPROVAL_DATA_FILE, {});
    const now = Date.now();
    let loaded = 0;
    let expired = 0;

    for (const [supWa, items] of Object.entries(obj)) {
      if (!Array.isArray(items)) continue;
      const valid = items.filter(item =>
        item && item.createdAt && (now - item.createdAt < MAX_APPROVAL_DURATION_MS)
      );
      expired += items.length - valid.length;
      if (valid.length > 0) {
        pendingApprovals.set(supWa, valid);
        loaded += valid.length;
      }
    }

    if (loaded === 0 && expired === 0) {
      logger.info('[Approval] File pending_approvals.json belum ada atau kosong — mulai dengan store kosong.');
    } else {
      logger.info(
        `[Approval] Startup: ${loaded} pending approval dimuat dari disk` +
        (expired > 0 ? `, ${expired} expired dibuang` : '') +
        `. (Max usia: ${APPROVAL_MAX_DAYS} hari)` +
        (encryptedStore.ENCRYPTION_ENABLED ? ' [terenkripsi]' : ' [plain JSON]')
      );
    }
    logger.info('[Approval] ℹ️  Tidak ada pesan WA yang dikirim saat startup — hanya baca dari disk.');

  } catch (err) {
    logger.warn(`[Approval] Gagal memuat pending approvals dari disk: ${err.message} — mulai dengan store kosong.`);
  }
}

let _saveTimer = null;

/**
 * Simpan pending approvals ke disk (debounced 500ms).
 * File disimpan terenkripsi jika SESSION_SECRET aktif.
 */
function savePendingApprovals() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    const obj = Object.fromEntries(pendingApprovals);
    encryptedStore.writeJson(APPROVAL_DATA_FILE, obj);
  }, 500);
}

// ─── Inisialisasi Eksplisit ────────────────────────────────────────────────────

/**
 * Inisialisasi Approval Service.
 * Dipanggil SEKALI dari index.js saat server startup — setelah WhatsApp siap.
 *
 * Tidak mengirim pesan WA apapun — hanya memuat data dari disk ke memori.
 */
function initApprovalService() {
  loadPendingApprovals();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Tambahkan pending approval untuk seorang atasan.
 * Jika atasan sudah punya approval sebelumnya, approval baru masuk ke antrian.
 *
 * @param {string} supervisorWaNumber - Nomor WA atasan format 628xxx
 * @param {object} approvalData
 * @param {string} approvalData.requestId     - ID tiket ManageEngine
 * @param {string} approvalData.levelNumber   - Level approval
 * @param {string} approvalData.approvalId    - ID approval
 * @param {string} approvalData.staffWaNumber - Nomor WA staf
 * @param {string} approvalData.staffName     - Nama staf pemohon
 * @param {string} approvalData.appName       - Nama aplikasi
 * @param {string} approvalData.department    - Departemen staf
 */
function addPendingApproval(supervisorWaNumber, approvalData) {
  const existing = pendingApprovals.get(supervisorWaNumber) || [];
  existing.push({
    requestId:      String(approvalData.requestId),
    levelNumber:    String(approvalData.levelNumber),
    approvalId:     String(approvalData.approvalId),
    staffWaNumber:  approvalData.staffWaNumber,
    staffName:      approvalData.staffName,
    appName:        approvalData.appName,
    department:     approvalData.department || '',
    supervisorMeId: approvalData.supervisorMeId || null,  // ME user ID atasan
    nip:            approvalData.nip || '',
    userAccount:    approvalData.userAccount || '',
    jabatan:        approvalData.jabatan || '',
    createdAt:      Date.now()
  });
  pendingApprovals.set(supervisorWaNumber, existing);
  savePendingApprovals();
  logger.info(`[Approval] Pending approval ditambahkan untuk atasan ${supervisorWaNumber} — tiket: ${approvalData.requestId}, supervisorMeId: ${approvalData.supervisorMeId || 'tidak diketahui'}, antrian: ${existing.length}`);
}

/**
 * Cek apakah atasan memiliki pending approval.
 * @param {string} supervisorWaNumber
 * @returns {boolean}
 */
function hasPendingApproval(supervisorWaNumber) {
  const items = pendingApprovals.get(supervisorWaNumber) || [];
  return items.length > 0;
}

/**
 * Ambil pending approval TERBARU (LIFO) untuk atasan.
 * Menggunakan LIFO karena ketika atasan menerima notifikasi approval baru,
 * yang relevan untuk di-approve adalah tiket yang PALING BARU dikirim,
 * bukan tiket lama yang mungkin sudah expired atau sudah diproses manual.
 * @param {string} supervisorWaNumber
 * @returns {object|null}
 */
function getPendingApproval(supervisorWaNumber) {
  const items = pendingApprovals.get(supervisorWaNumber) || [];
  return items.length > 0 ? items[items.length - 1] : null;
}

/**
 * Hapus satu pending approval berdasarkan requestId.
 * @param {string} supervisorWaNumber
 * @param {string} requestId
 */
function removePendingApproval(supervisorWaNumber, requestId) {
  const items = pendingApprovals.get(supervisorWaNumber) || [];
  const filtered = items.filter(item => item.requestId !== String(requestId));

  if (filtered.length === 0) {
    pendingApprovals.delete(supervisorWaNumber);
  } else {
    pendingApprovals.set(supervisorWaNumber, filtered);
  }

  savePendingApprovals();
  logger.info(`[Approval] Pending approval tiket ${requestId} dihapus untuk atasan ${supervisorWaNumber}. Sisa: ${filtered.length}`);
}

/**
 * Jumlah pending approval yang tersisa untuk atasan ini.
 * @param {string} supervisorWaNumber
 * @returns {number}
 */
function getRemainingCount(supervisorWaNumber) {
  return (pendingApprovals.get(supervisorWaNumber) || []).length;
}

/**
 * Cari nomor WA atasan berdasarkan requestId tiket.
 * Digunakan oleh notification.service untuk routing notifikasi type="approval"
 * ke WA atasan (bukan ke pegawai pembuat tiket).
 *
 * @param {string} requestId - ID tiket ManageEngine
 * @returns {{ supervisorWa: string, approvalItem: object }|null}
 *   supervisorWa  : nomor WA atasan (format 628xxx)
 *   approvalItem  : data approval lengkap (staffName, appName, department, dst)
 */
function getSupervisorWaByRequestId(requestId) {
  const rid = String(requestId);
  for (const [supervisorWa, items] of pendingApprovals.entries()) {
    if (!Array.isArray(items)) continue;
    const found = items.find(item => item.requestId === rid);
    if (found) return { supervisorWa, approvalItem: found };
  }
  return null;
}

// ─── Reminder Scheduler ───────────────────────────────────────────────────────

/**
 * Durasi sebelum reminder dikirim (default: 1 jam).
 * Dapat dikonfigurasi via env APPROVAL_REMINDER_HOURS.
 */
const REMINDER_AFTER_MS = parseInt(process.env.APPROVAL_REMINDER_HOURS || '1', 10) * 60 * 60 * 1000;

/**
 * Interval pemeriksaan reminder (setiap 15 menit).
 * Cukup sering agar reminder 1 jam terdeteksi tepat waktu.
 */
const REMINDER_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 menit

/**
 * Periksa semua pending approval dan kirim reminder WA ke atasan
 * jika approval sudah menunggu lebih dari REMINDER_AFTER_MS.
 *
 * Dipanggil secara periodik oleh startApprovalReminders().
 * Lazy-require whatsapp.service untuk menghindari circular dependency.
 */
async function checkAndSendReminders() {
  if (pendingApprovals.size === 0) return;

  const now = Date.now();
  let remindersSent = 0;

  let sendMessageToNumber;
  try {
    ({ sendMessageToNumber } = require('./whatsapp.service'));
  } catch (err) {
    logger.warn(`[Approval] Gagal load whatsapp.service untuk reminder: ${err.message}`);
    return;
  }

  for (const [supervisorWa, items] of pendingApprovals.entries()) {
    if (!Array.isArray(items) || items.length === 0) continue;

    // Kirim reminder untuk approval tertua yang belum dibalas
    const oldest = items[0];
    const ageMs  = now - (oldest.createdAt || 0);

    // Hanya kirim jika sudah melewati batas waktu reminder
    if (ageMs < REMINDER_AFTER_MS) continue;

    // Hanya kirim 1x reminder — jika sudah pernah diingatkan, skip selamanya
    if (oldest.remindedCount && oldest.remindedCount >= 1) continue;

    const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
    // Format *Label* : value — mobile-friendly, tanpa padding
    const dataLines = [
      `*Nama Aplikasi* : ${oldest.appName || ''}`,
      `*Nomor Induk Pegawai* : ${oldest.nip || ''}`,
      `*Nama Lengkap* : ${oldest.staffName || ''}`,
      `*Username Aplikasi* : ${oldest.userAccount || ''}`,
      `*Unit/Bidang/Bagian* : ${oldest.department || ''}`,
      `*Jabatan* : ${oldest.jabatan || ''}`,
      `*No. Tiket* : ${oldest.requestId}`,
    ].join('\n');
    const reminderMsg =
      `*[Pengingat — IT Service Desk PLN Batam]*\n\n` +
      `Anda memiliki permintaan *Pembuatan atau Perubahan Otorisasi Aplikasi* yang belum mendapat respons sejak *${ageHours} jam* lalu:\n\n` +
      dataLines +
      `\n\nSilakan balas dengan:\n` +
      ` *APPROVE* — untuk menyetujui\n` +
      ` *REJECT*  — untuk menolak`;

    const result = await sendMessageToNumber(supervisorWa, reminderMsg);
    if (result.success) {
      oldest.remindedCount = (oldest.remindedCount || 0) + 1;
      oldest.lastRemindedAt = now;
      savePendingApprovals();
      remindersSent++;
      logger.info(`[Approval] ⏰ Reminder dikirim ke atasan ${supervisorWa} untuk tiket ${oldest.requestId} (${ageHours} jam menunggu) — tidak ada reminder berikutnya.`);
    } else {
      logger.warn(`[Approval] Gagal kirim reminder ke ${supervisorWa}: ${result.error}`);
    }
  }

  if (remindersSent > 0) {
    logger.info(`[Approval] ${remindersSent} reminder terkirim.`);
  }
}

/**
 * Mulai scheduler reminder approval.
 * Dipanggil SEKALI dari index.js setelah WhatsApp siap.
 * Pemeriksaan pertama dilakukan setelah 5 menit server berjalan.
 * Reminder hanya dikirim 1x setelah 1 jam tidak direspons.
 */
function startApprovalReminders() {
  logger.info(
    `[Approval] Scheduler reminder aktif — periksa setiap 15 menit, ` +
    `kirim reminder 1x jika approval belum dijawab > ${Math.floor(REMINDER_AFTER_MS / (60 * 60 * 1000))} jam.`
  );
  // Pemeriksaan pertama: 5 menit setelah startup
  setTimeout(() => {
    checkAndSendReminders().catch(err =>
      logger.warn(`[Approval] Error pada pemeriksaan reminder pertama: ${err.message}`)
    );
  }, 5 * 60 * 1000);

  // Pemeriksaan rutin setiap 15 menit
  setInterval(() => {
    checkAndSendReminders().catch(err =>
      logger.warn(`[Approval] Error pada pemeriksaan reminder: ${err.message}`)
    );
  }, REMINDER_CHECK_INTERVAL_MS);
}

module.exports = {
  initApprovalService,
  startApprovalReminders,
  addPendingApproval,
  hasPendingApproval,
  getPendingApproval,
  removePendingApproval,
  getRemainingCount,
  getSupervisorWaByRequestId
};
