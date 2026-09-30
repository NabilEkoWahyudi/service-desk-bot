/**
 * ---------------------------------------------------------------
 * NOTIFICATION SERVICE - IT Service Desk Bot PLN Batam
 * ---------------------------------------------------------------
 *
 * Dua mekanisme penerimaan balasan (tanpa/minimal delay):
 *
 *   1. WEBHOOK - zero delay (direkomendasikan)
 *      ManageEngine -> POST /webhook/me-notification -> bot -> WA pegawai
 *      Konfigurasi di ManageEngine: Admin -> Business Rules -> tambah Action
 *      "HTTP Notification" dengan URL: http://<ip-server>:3000/webhook/me-notification
 *      Body JSON: { "request_id": "${requestId}" }
 *
 *   2. ADAPTIVE POLLING - backup otomatis jika webhook tidak dikonfigurasi
 *      Master timer 5 detik mengecek tiket mana yang sudah waktunya dipoll.
 *      Interval per tiket adaptif berdasarkan umur tiket:
 *        0-5  menit  -> setiap 15 detik  (maks delay 15 detik)
 *        5-30 menit  -> setiap 30 detik  (maks delay 30 detik)
 *        30min-7hari -> setiap 60 detik  (maks delay 60 detik)
 *      Poll PERTAMA dilakukan 5 detik setelah tiket didaftarkan.
 *
 * Routing notifikasi berdasarkan field "type" dari ManageEngine:
 *   type = "approval"             -> kirim ke WA ATASAN  (permintaan APPROVE/REJECT)
 *   type = "system_notification"  -> kirim ke WA PEGAWAI (status disetujui/ditolak)
 *   type lainnya                  -> kirim ke WA PEGAWAI (default)
 *
 * Routing: berdasarkan Request ID tiket (bukan WA number).
 * Satu WA number bisa punya banyak tiket aktif - masing-masing independen.
 */

'use strict';

const path           = require('path');
const logger         = require('../utils/logger');
const encryptedStore = require('../utils/encrypted-store');

// --- Konfigurasi -------------------------------------------------------------

/**
 * Interval polling flat untuk semua tiket - tanpa memandang umur tiket.
 * Semua tiket aktif di-poll setiap POLL_INTERVAL_MS agar reply admin
 * langsung muncul di chatbot (real-time, maks delay = POLL_INTERVAL_MS).
 *
 * Bisa di-override via env var NOTIF_POLL_INTERVAL_MS (dalam milidetik).
 * Contoh: NOTIF_POLL_INTERVAL_MS=10000 -> tiap 10 detik.
 */
const POLL_INTERVAL_MS = parseInt(process.env.NOTIF_POLL_INTERVAL_MS || '15000', 10);

/** Frekuensi master scheduler (bukan frekuensi per-tiket). */
const MASTER_TICK_MS = 5_000;

/**
 * Delay sebelum poll pertama setelah tiket didaftarkan.
 * Default: 5 detik - cukup cepat tanpa mengganggu proses pembuatan tiket.
 */
const INITIAL_POLL_DELAY_MS = parseInt(process.env.NOTIF_INITIAL_POLL_DELAY_MS || '5000', 10);

/** Durasi maksimum tracking tiket: 7 hari. */
const MAX_TRACK_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

/** File persisten untuk menyimpan daftar tiket yang sedang di-track. */
const NOTIF_DATA_FILE = path.join(__dirname, '../../data/notifications.json');

// --- In-Memory Store ----------------------------------------------------------
/**
 * Map<requestId, { waNumber, supervisorWa, supervisorMeId, seenIds, registeredAt, lastCheckedAt }>
 *   supervisorWa   : nomor WA atasan yang sudah dinormalisasi (628xxx), atau null
 *   supervisorMeId : ManageEngine user ID atasan (untuk cocokkan approver.id), atau null
 *   lastCheckedAt  : timestamp kapan tiket terakhir di-poll (untuk adaptive scheduling)
 */
const trackedTickets = new Map();

// --- Persistence -------------------------------------------------------------

function loadTrackedTickets() {
  try {
    const obj  = encryptedStore.readJson(NOTIF_DATA_FILE, {});
    const now  = Date.now();
    let loaded = 0;

    for (const [id, info] of Object.entries(obj)) {
      if (!info || now - info.registeredAt > MAX_TRACK_DURATION_MS) continue;
      trackedTickets.set(id, {
        waNumber:      info.waNumber,
        supervisorWa:  info.supervisorWa  || null,
        supervisorMeId: info.supervisorMeId || null,
        appName:       info.appName       || null,   // nama aplikasi (persist lintas restart)
        seenIds:       new Set(Array.isArray(info.seenIds) ? info.seenIds : []),
        seenAttachmentIds: new Set(Array.isArray(info.seenAttachmentIds) ? info.seenAttachmentIds : []),
        registeredAt:  info.registeredAt,
        lastCheckedAt: 0
      });
      loaded++;
    }

    if (loaded > 0) {
      logger.info(
        `[Notif] ${loaded} tiket dimuat dari disk - semua dijadwalkan poll segera (lastCheckedAt direset)` +
        (encryptedStore.ENCRYPTION_ENABLED ? ' [terenkripsi]' : ' [plain JSON]') + '.'
      );
    }
  } catch (err) {
    logger.warn(`[Notif] Gagal memuat data notifikasi dari disk: ${err.message}`);
  }
}

let _saveTimer = null;
function saveTrackedTickets() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    const obj = {};
    for (const [id, info] of trackedTickets.entries()) {
      obj[id] = {
        waNumber:       info.waNumber,
        supervisorWa:   info.supervisorWa   || null,
        supervisorMeId: info.supervisorMeId || null,
        appName:        info.appName        || null,   // nama aplikasi (untuk pesan ke atasan)
        seenIds:        [...info.seenIds],
        seenAttachmentIds: [...(info.seenAttachmentIds || [])],
        registeredAt:   info.registeredAt,
        lastCheckedAt:  info.lastCheckedAt
      };
    }
    encryptedStore.writeJson(NOTIF_DATA_FILE, obj);
  }, 500);
}

// --- Interval Check -----------------------------------------------------------

/**
 * Cek apakah tiket sudah waktunya di-poll berdasarkan POLL_INTERVAL_MS.
 * Semua tiket menggunakan interval yang sama tanpa memandang umur.
 */
function isTicketDue(lastCheckedAt) {
  return Date.now() - (lastCheckedAt || 0) >= POLL_INTERVAL_MS;
}

/**
 * Format pesan permintaan approval ke ATASAN (notif type = "approval").
 *
 * Mengekstrak data form dari DESKRIPSI TIKET (bukan dari notif.description):
 *   Nama Aplikasi, Nomor Induk Pegawai, Nama Lengkap,
 *   User Account, Unit/Bidang/Bagian, Jabatan.
 *
 * @param {string} requestId
 * @param {string} ticketDescription - Deskripsi tiket (dari getTicketDetail)
 * @param {object} approvalItem      - Data tambahan dari pendingApprovals store
 * @returns {string}
 */
/**
 * Format pesan permintaan approval ke ATASAN (notif type = "approval").
 *
 * Menggunakan data dari approvalItem (pendingApprovals store) sebagai sumber utama.
 * Hanya menampilkan baris yang ada nilainya - baris kosong tidak ditampilkan.
 *
 * @param {string} requestId
 * @param {string} ticketDescription - Tidak digunakan lagi (kept for signature compatibility)
 * @param {object} approvalItem      - Data dari pendingApprovals store
 * @returns {string}
 */
function buildApprovalRequestMsg(requestId, ticketDescription, approvalItem) {
  // Ambil data langsung dari approvalItem (sumber paling akurat)
  const sd = approvalItem?.staffData || {};

  const namaAplikasi = approvalItem?.appName || '';
  const nip          = sd.employeeId || approvalItem?.nip || '';
  const namaLengkap  = sd.name || approvalItem?.staffName || '';
  const userAccount  = approvalItem?.userAccount || sd.loginName || '';
  const unitBidang   = sd.department || approvalItem?.department || '';
  const jabatan      = sd.jobTitle || approvalItem?.jabatan || '';

  // Bangun baris data - format *Label* : value (mobile-friendly, tanpa padding)
  const lines = [];
  if (namaAplikasi) lines.push(`*Nama Aplikasi* : ${namaAplikasi}`);
  if (nip)          lines.push(`*Nomor Induk Pegawai* : ${nip}`);
  if (namaLengkap)  lines.push(`*Nama Lengkap* : ${namaLengkap}`);
  if (userAccount)  lines.push(`*Username Aplikasi* : ${userAccount}`);
  if (unitBidang)   lines.push(`*Unit/Bidang/Bagian* : ${unitBidang}`);
  if (jabatan)      lines.push(`*Jabatan* : ${jabatan}`);
  lines.push(       `*No. Tiket* : ${requestId}`);

  return (
    `*[IT Service Desk PLN Batam - Permintaan Persetujuan]*\n\n` +
    ` Terdapat permintaan *Pembuatan atau Perubahan Otorisasi Aplikasi* yang memerlukan persetujuan Anda:\n\n` +
    lines.join('\n') +
    `\n\nBalas dengan:\n` +
    ` *APPROVE* - untuk menyetujui\n` +
    ` *REJECT*  - untuk menolak\n\n` +
    `_Pesan ini dikirim otomatis oleh IT Service Desk Bot PLN Batam_`
  );
}

/**
 * Format pesan notifikasi status ke PEGAWAI (notif type = "system_notification").
 *
 * Mendeteksi apakah subject mengandung kata "Approved" atau "Rejected"
 * dan membuat pesan yang sesuai.
 * @param {string}      requestId
 * @param {object}      notif      - Objek notifikasi dari ManageEngine
 * @param {string}      ticketDesc - Deskripsi tiket (tidak lagi digunakan)
 * @param {object|null} staffData  - Data user dari verifiedUser/getUserById
 * @returns {string}
 */
function buildSystemNotifMsg(requestId, notif, ticketDesc, staffData = null) {
  const subject = (notif.subject || '').toLowerCase();
  const isApproved = subject.includes('approved') || subject.includes('approve');
  const isRejected = subject.includes('rejected') || subject.includes('reject');

  const ticketSubject = notif.request?.subject || notif.subject || '';

  // Bangun baris data - format *Label* : value (mobile-friendly, tanpa padding)
  const sd    = staffData || {};
  const lines = [];
  if (sd.name || '')         lines.push(`*Nama Pegawai* : ${sd.name}`);
  if (sd.employeeId || '')   lines.push(`*Nomor Induk Pegawai* : ${sd.employeeId}`);
  if (sd.loginName || '')    lines.push(`*Username Aplikasi* : ${sd.loginName}`);
  if (sd.department || '')   lines.push(`*Unit/Bidang/Bagian* : ${sd.department}`);
  if (sd.jobTitle || '')     lines.push(`*Jabatan* : ${sd.jobTitle}`);
  lines.push(                     `*No. Tiket* : ${requestId}`);
  if (ticketSubject)         lines.push(`*Judul* : ${ticketSubject}`);
  const userDataSnippet = lines.join('\n');

  if (isApproved) {
    return (
      ` *Request Pembuatan atau Perubahan Otorisasi Aplikasi Anda Telah DISETUJUI*\n\n` +
      `Permintaan Anda telah disetujui oleh atasan dan akan segera diproses oleh Tim IT.\n\n` +
      userDataSnippet +
      `\n\n_Ketik *menu* jika ingin mengajukan request baru._`
    );
  }

  if (isRejected) {
    return (
      ` *Request Pembuatan atau Perubahan Otorisasi Aplikasi Anda Telah DITOLAK*\n\n` +
      `Permintaan Anda ditolak oleh atasan.\n\n` +
      userDataSnippet +
      `\n\n_Ketik *menu* jika ingin mengajukan request baru._`
    );
  }

  // Fallback: system notification lainnya (mis. tiket closed, dsb)
  return formatNotificationMessage(requestId, notif, ticketDesc);
}

/**
 * Ekstrak nilai field dari body teks yang sudah di-strip HTML.
 * Mendukung dua format umum di email balasan ManageEngine:
 *   Inline  : "Nama Pegawai : TES"
 *   Newline : "Nama Pegawai :\n AD.FAHYAR"
 *
 * Juga mendukung format dengan tanda bintang (asterisk) sebelum titik dua,
 * yang digunakan dalam template HTML deskripsi tiket buatan bot:
 *   "Nama Aplikasi *:\n AMR"
 *   "Nomor Induk Pegawai *:\n 8901234"
 */
function extractFieldValue(text, fieldNames) {
  for (const name of fieldNames) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Cocokkan label dengan opsional tanda bintang (*) sebelum pemisah (: atau -)
    const sep = `\\s*(?:\\*\\s*)?[:\\-]\\s*`;

    const inline = text.match(new RegExp(`${esc}${sep}([^\\n\\r]+)`, 'i'));
    if (inline && inline[1].trim()) return inline[1].trim();

    const nextLine = text.match(new RegExp(`${esc}${sep}[\\r\\n]+\\s*([^\\n\\r]+)`, 'i'));
    if (nextLine && nextLine[1].trim()) return nextLine[1].trim();
  }
  return null;
}

/**
 * Format objek notifikasi ManageEngine menjadi pesan WhatsApp yang bersih.
 * Hanya menampilkan field relevan per kategori dan HANYA jika ada nilainya.
 *
 * @param {string}      requestId
 * @param {object}      notif       - Objek notifikasi dari ManageEngine
 * @param {string}      ticketDesc  - Deskripsi tiket asli (dipakai sebagai fallback)
 * @param {object|null} staffData   - Data user dari info.staffData (sumber utama)
 */
function formatNotificationMessage(requestId, notif, ticketDesc, staffData = null) {
  const subject       = notif.subject        || notif.request?.subject || '-';
  const ticketSubject = notif.request?.subject || subject;

  // -- Sumber data user: staffData (dari session/API) - paling akurat ---------
  // Jika staffData tersedia, gunakan langsung tanpa parsing HTML deskripsi.
  // Ini menghindari masalah regex menangkap nilai yang salah dari template form.
  let namaAplikasi = '', nip = '', namaLengkap = '', userAccount = '', jabatan = '';

  if (staffData) {
    namaAplikasi = staffData.appName   || '';  // appName disimpan di info, bukan staffData
    nip          = staffData.employeeId || '';
    namaLengkap  = staffData.name       || '';
    userAccount  = staffData.loginName  || '';
    jabatan      = staffData.jobTitle   || staffData.jobtitle || '';
  } else {
    // Fallback: parsing dari deskripsi tiket (kurang akurat, dipakai hanya jika staffData kosong)
    const rawDescBody = typeof ticketDesc === 'string' ? ticketDesc : (ticketDesc?.description || '');
    const plainDescBody = rawDescBody
      .replace(/<br\s*\/?>/gi, '\n').replace(/<p[^>]*>/gi, '\n').replace(/<\/p>/gi, '')
      .replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'").replace(/\n{3,}/g, '\n\n').trim();

    // Ambil hanya baris yang berformat "Label : Nilai" sederhana - lewati baris yang masih mengandung "*"
    // (baris template form seperti "Nama Aplikasi * :" harus diabaikan)
    const cleanLines = plainDescBody.split('\n').filter(l => !l.includes('*') && l.includes(':'));
    const cleanText  = cleanLines.join('\n');

    namaLengkap  = extractFieldValue(cleanText, ['Nama Lengkap', 'Nama Pegawai']) || '';
    nip          = extractFieldValue(cleanText, ['Nomor Induk Pegawai', 'NIP', 'Employee ID']) || '';
    userAccount  = extractFieldValue(cleanText, ['User Account', 'Username']) || '';
    jabatan      = extractFieldValue(cleanText, ['Jabatan']) || '';
  }

  // -- Konten balasan dari admin (badan notifikasi) --------------------------
  const rawBody = notif.description || notif.body || notif.content || notif.message || '';
  const plainBody = rawBody
    .replace(/<br\s*\/?>/gi, '\n').replace(/<p[^>]*>/gi, '\n').replace(/<\/p>/gi, '')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'").replace(/\n{3,}/g, '\n\n').trim();

  // Hanya ambil baris pertama dari body yang bermakna sebagai balasan admin
  // (bukan re-paste konten form tiket yang panjang)
  const balasanLines = plainBody.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.includes('Nomor Tiket') && !l.includes('No. Tiket'));

  // Cek apakah ada password / autorisasi / tindakan / VPN dari body
  const password   = extractFieldValue(plainBody, ['Password', 'Sandi']);
  const autorisasi = extractFieldValue(plainBody, ['Autorisasi', 'Otorisasi', 'Hak Akses']);
  const tindakan   = extractFieldValue(plainBody, ['Tindakan', 'Solusi', 'Penyelesaian', 'Resolusi', 'Perbaikan']);
  const vpnInfo    = extractFieldValue(plainBody, ['Alamat VPN', 'Server VPN', 'VPN']);

  // Format *Label* : value - HANYA baris yang ada nilainya (baris kosong tidak ditampilkan)
  const fieldLines = [];
  if (namaAplikasi) fieldLines.push(`*Nama Aplikasi* : ${namaAplikasi}`);
  if (nip)          fieldLines.push(`*Nomor Induk Pegawai* : ${nip}`);
  if (namaLengkap)  fieldLines.push(`*Nama Lengkap* : ${namaLengkap}`);
  if (userAccount)  fieldLines.push(`*Username Aplikasi* : ${userAccount}`);
  if (jabatan)      fieldLines.push(`*Jabatan* : ${jabatan}`);
  if (password)     fieldLines.push(`*Password* : ${password}`);
  if (autorisasi)   fieldLines.push(`*Autorisasi* : ${autorisasi}`);
  if (tindakan)     fieldLines.push(`*Tindakan* : ${tindakan}`);
  if (vpnInfo)      fieldLines.push(`*Info VPN* : ${vpnInfo}`);

  let msg =
    `*No. Tiket* : *${requestId}*\n` +
    `*Judul* : ${ticketSubject}`;

  if (fieldLines.length > 0) {
    msg += `\n\n---\n` + fieldLines.join('\n');
  }

  // Tampilkan pesan balasan admin jika ada dan tidak sama dengan konten form
  if (balasanLines.length > 0) {
    // Batasi panjang dan filter agar tidak menampilkan ulang seluruh form tiket
    const relevantLines = balasanLines.filter(l =>
      !l.match(/^(Aplikasi|Judul|Nomor Tiket|Formulir|OPS TI|Komitmen|Dengan ini|PERMINTAAN|Lokasi|Unit\/Bidang)\b/i)
    );
    if (relevantLines.length > 0) {
      const preview = relevantLines.slice(0, 10).join('\n');
      msg += `\n\n *Balasan:*\n${preview}`;
    }
  }

  msg +=
    `\n\n---\n` +
    `_Balasan ini untuk tiket No. ${requestId}_\n` +
    `_Ketik *menu* untuk mengajukan request baru._`;

  return msg;
}

// --- Polling Core -------------------------------------------------------------

/**
 * Poll satu tiket secara langsung.
 *
 * @param {string}  requestId
 * @param {object}  opts
 * @param {boolean} opts.skipIntervalCheck - true = abaikan interval adaptive (untuk webhook/initial poll)
 */
async function pollSingleTicket(requestId, { skipIntervalCheck = false } = {}) {
  const info = trackedTickets.get(requestId);
  if (!info) return;

  // Cek expired
  if (Date.now() - info.registeredAt > MAX_TRACK_DURATION_MS) {
    trackedTickets.delete(requestId);
    saveTrackedTickets();
    logger.info(`[Notif] Tiket ${requestId} dihapus dari tracking (expired > 7 hari).`);
    return;
  }

  // Jika dari scheduler reguler, cek apakah sudah waktunya berdasarkan interval flat
  if (!skipIntervalCheck) {
    if (!isTicketDue(info.lastCheckedAt)) return; // belum waktunya
  }

  // Update lastCheckedAt SEBELUM API call - mencegah race condition jika ticker cepat
  info.lastCheckedAt = Date.now();

  let getTicketNotifications, sendMessageToNumber, getSupervisorWaByRequestId;
  try {
    ({ getTicketNotifications }      = require('./ticket.service'));
    ({ sendMessageToNumber }          = require('./whatsapp.service'));
    ({ getSupervisorWaByRequestId }   = require('./approval.service'));
  } catch (err) {
    logger.warn(`[Notif] Gagal load dependency: ${err.message}`);
    return;
  }

  try {
    const notifications = await getTicketNotifications(requestId);

    // -- Auto-untrack: tiket tidak ditemukan di ManageEngine (404) -------------
    // Ini terjadi jika tiket sudah dihapus, di-merge, atau ID tidak valid.
    // Hapus dari tracking agar tidak terus-menerus menghasilkan warn log.
    if (notifications && !Array.isArray(notifications) && notifications.notFound === true) {
      trackedTickets.delete(requestId);
      saveTrackedTickets();
      logger.info(`[Notif] Tiket ${requestId} dihapus dari tracking - tidak ditemukan di ManageEngine (404).`);
      return;
    }

    if (!Array.isArray(notifications) || notifications.length === 0) return;

    let anyNew = false;
    
    // FETCH TICKET DESC HERE SO IT CAN BE REUSED UNTUK SEMUA NOTIFIKASI
    let ticketDesc = '';
    let ticketDetailObj = null;
    try {
      const { getTicketDetail } = require('./ticket.service');
      ticketDetailObj = await getTicketDetail(requestId);
      ticketDesc = ticketDetailObj?.description || '';
    } catch (_) { /* gunakan string kosong jika gagal */ }

    for (const notif of notifications) {
      const notifId   = String(notif.id ?? notif.notification_id ?? '');
      const notifType = (notif.type || '').toLowerCase();

      if (!notifId || info.seenIds.has(notifId)) continue;

      // -- Routing berdasarkan type notifikasi dari ManageEngine ------------
      //
      // type = "approval"            -> kirim ke WA ATASAN (permintaan APPROVE/REJECT)
      // type = "system_notification" -> kirim ke WA PEGAWAI (status disetujui/ditolak)
      // type lainnya                 -> kirim ke WA PEGAWAI (format default)

      let targetWa, msg;

      // PENTING: ManageEngine kadang membuat notifikasi type='reply' atau 'system_notification' yang isinya
      // adalah email approval request ke atasan. Ini TIDAK boleh diteruskan ke employee pembuat tiket.
      // Cek body notifikasi: jika mengandung penanda approval email dan BUKAN notif type='approval', skip.
      if (notifType !== 'approval') {
        const notifBodyRaw = (notif.description || notif.body || notif.content || notif.message || '')
          .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ');

        const isApprovalEmail = [
          '$ApprovalLink', '_approve', '_reject',
          'memerlukan persetujuan', 'Notifikasi Persetujuan',
          'agar dapat ditindaklanjuti', 'persetujuan Anda'
        ].some(kw => notifBodyRaw.toLowerCase().includes(kw.toLowerCase()));

        if (isApprovalEmail) {
          // Ini email persetujuan yang ditujukan ke atasan - jangan teruskan ke employee
          info.seenIds.add(notifId);
          anyNew = true;
          logger.info(
            `[Notif] Notifikasi #${notifId} tiket ${requestId} di-skip ` +
            `(konten approval email, tidak relevan untuk pegawai).`
          );
          continue;
        }
      }

      if (notifType === 'approval') {
        // Cek apakah atasan sudah terdaftar di pending approvals (anti-duplikat)
        const approvalLookup = getSupervisorWaByRequestId(requestId);
        if (approvalLookup) {
          logger.info(
            `[Notif] Notifikasi approval #${notifId} tiket ${requestId} - ` +
            `atasan ${approvalLookup.supervisorWa} sudah terdaftar di pending store, skip duplikasi.`
          );
          info.seenIds.add(notifId);
          anyNew = true;
          continue;
        }

        // Ambil nomor WA atasan - utamakan dari cache, fallback ke API jika belum ada
        let supervisorWa = info.supervisorWa || null;

        if (!supervisorWa) {
          // Fallback: ambil reporting_to.phone/mobile dari GET /api/v3/users/{requesterId}
          // Endpoint individual selalu menyertakan phone di dalam reporting_to
          logger.info(
            `[Notif] supervisorWa belum tersimpan untuk tiket ${requestId} - ` +
            `mencoba ambil dari API (GET /api/v3/users/{requesterId})...`
          );

          let getTicketDetailFn, getUserByIdFn;
          try {
            const ticketSvc  = require('./ticket.service');
            getTicketDetailFn = ticketSvc.getTicketDetail;
            getUserByIdFn     = ticketSvc.getUserById;
          } catch (depErr) {
            logger.warn(`[Notif] Gagal load ticket.service: ${depErr.message} - skip approval WA.`);
            info.seenIds.add(notifId);
            anyNew = true;
            continue;
          }

          try {
            // 1. Dapatkan requester ID dari tiket
            const ticketDetail = await getTicketDetailFn(requestId);
            const requesterId  = ticketDetail?.requester?.id || null;

            if (!requesterId) {
              logger.warn(`[Notif] Tidak bisa dapatkan requester ID tiket ${requestId} - skip approval WA.`);
              info.seenIds.add(notifId);
              anyNew = true;
              continue;
            }

            // 2. GET /api/v3/users/{requesterId} -> ambil reporting_to.phone / mobile
            //    Endpoint ini PASTI menyertakan phone di dalam reporting_to (sesuai respons ManageEngine)
            //    Kirim ke reporting_to meskipun reporting_to.id == id user sendiri (self-referential)
            const userDetail = await getUserByIdFn(requesterId);
            const rawPhone   = userDetail?.reportingTo?.phone || userDetail?.reportingTo?.mobile || null;

            if (!rawPhone) {
              logger.warn(
                `[Notif] Requester ID ${requesterId} tidak punya reporting_to Phone/Mobile ` +
                `- skip approval WA tiket ${requestId}.`
              );
              info.seenIds.add(notifId);
              anyNew = true;
              continue;
            }

            // 3. Normalisasi: +628xxx / 628xxx / 08xxx / 8xxx -> 628xxx
            const cleanPhone = rawPhone.replace(/\D/g, '');
            if (cleanPhone.startsWith('0')) {
              supervisorWa = '62' + cleanPhone.slice(1);
            } else if (cleanPhone.startsWith('62')) {
              supervisorWa = cleanPhone;
            } else {
              supervisorWa = '62' + cleanPhone;
            }

            if (!supervisorWa || supervisorWa.length < 10 || supervisorWa.length > 15) {
              logger.warn(`[Notif] Nomor WA tidak valid setelah normalisasi: "${supervisorWa}" - skip.`);
              info.seenIds.add(notifId);
              anyNew = true;
              continue;
            }

            // Simpan ke info agar polling berikutnya tidak perlu API call lagi
            info.supervisorWa   = supervisorWa;
            info.supervisorMeId = String(userDetail?.reportingTo?.id || '').trim() || null;
            logger.info(
              `[Notif] supervisorWa berhasil didapat via API: ${supervisorWa} ` +
              `(atasan: ${userDetail?.reportingTo?.name || '-'}, ME ID: ${info.supervisorMeId || '-'}, tiket ${requestId})`
            );

          } catch (fallbackErr) {
            logger.warn(
              `[Notif] Error saat fallback lookup supervisorWa tiket ${requestId}: ` +
              `${fallbackErr.message} - skip approval WA.`
            );
            info.seenIds.add(notifId);
            anyNew = true;
            continue;
          }
        }

        logger.info(
          `[Notif] Notifikasi approval #${notifId} tiket ${requestId} - ` +
          `mengirim permintaan persetujuan ke atasan ${supervisorWa}...`
        );

        let addPendingApprovalFn;
        try {
          addPendingApprovalFn = require('./approval.service').addPendingApproval;
        } catch (depErr) {
          logger.warn(`[Notif] Gagal load approval.service: ${depErr.message}`);
          info.seenIds.add(notifId);
          anyNew = true;
          continue;
        }

        // -- Sumber data staf (prioritas): -------------------------------------
        // 1. info.staffData - verifiedUser dari session saat tiket dibuat (paling akurat)
        // 2. Fallback API getUserById - jika bot restart dan staffData hilang dari memory
        // Tidak lagi memakai ekstraksi HTML karena format tabel menyebabkan parse error.

        let staffData = info.staffData || null;

        if (!staffData) {
          logger.info(
            `[Notif] staffData kosong untuk tiket ${requestId} (mungkin setelah restart) - ` +
            `mencoba ambil dari ManageEngine API...`
          );
          try {
            const ticketSvc2      = require('./ticket.service');
            const ticketDetailTmp = await ticketSvc2.getTicketDetail(requestId);
            const requesterId2    = ticketDetailTmp?.requester?.id || null;
            if (requesterId2) {
              const userDetail2 = await ticketSvc2.getUserById(requesterId2);
              if (userDetail2) {
                staffData = userDetail2;
                // Cache ke info agar tidak fetch lagi di polling berikutnya
                info.staffData = userDetail2;
                logger.info(
                  `[Notif] Fallback user data berhasil: name=${userDetail2.name} (tiket ${requestId})`
                );
              }
            }
          } catch (fallbackErr2) {
            logger.warn(`[Notif] Fallback lookup user gagal untuk tiket ${requestId}: ${fallbackErr2.message}`);
          }
        }

        const finalStaffName   = staffData?.name || '';
        const finalNip         = staffData?.employeeId || '';
        const finalUserAccount = staffData?.loginName || '';
        const finalJabatan     = staffData?.jobTitle || '';
        const finalDepartment  = staffData?.department || '';
        // Nama aplikasi dari session.data.nama_aplikasi (disimpan di trackInfo appName jika ada)
        const finalAppName     = info.appName || '';

        addPendingApprovalFn(supervisorWa, {
          requestId:      String(requestId),
          levelNumber:    '',   // diambil dinamis saat reply
          approvalId:     '',   // diambil dinamis saat reply
          staffWaNumber:  info.waNumber,
          staffName:      finalStaffName,
          appName:        finalAppName,
          department:     finalDepartment,
          supervisorMeId: info.supervisorMeId || null,
          nip:            finalNip,
          userAccount:    finalUserAccount,
          jabatan:        finalJabatan,
          staffData:      staffData || null   // simpan object lengkap untuk buildApprovalRequestMsg
        });

        // Kirim pesan WA APPROVE/REJECT ke atasan
        const approvalMsg = buildApprovalRequestMsg(requestId, '', {
          staffName:   finalStaffName,
          appName:     finalAppName,
          department:  finalDepartment,
          nip:         finalNip,
          userAccount: finalUserAccount,
          jabatan:     finalJabatan,
          staffData:   staffData || null
        });

        const waResult = await sendMessageToNumber(supervisorWa, approvalMsg);
        if (waResult.success) {
          info.seenIds.add(notifId);
          anyNew = true;
          logger.info(
            `[Notif]  WA approval terkirim ke atasan ${supervisorWa} untuk tiket ${requestId}`
          );
        } else {
          // Tidak masuk seenIds -> akan dicoba ulang di polling berikutnya
          logger.warn(
            `[Notif]  Gagal kirim WA approval ke ${supervisorWa}: ${waResult.error} ` +
            `- tiket ${requestId} akan dicoba ulang.`
          );
        }

        continue;

      } else if (notifType === 'system_notification') {
        // Notifikasi status sistem (has been Approved / Rejected) -> ke pegawai
        targetWa = info.waNumber;
        msg      = buildSystemNotifMsg(requestId, notif, ticketDesc, info.staffData || null);
        logger.info(`[Notif] Notifikasi system #${notifId} tiket ${requestId} -> WA pegawai ${targetWa}`);

      } else {
        // Notifikasi lain (balasan admin, dsb) - forward ke pegawai dengan format bersih.
        // Gunakan staffData dari info (sumber terpercaya) bukan parsing HTML description.
        // Sisipkan appName ke staffData sementara karena formatter memerlukannya.
        const staffDataWithApp = info.staffData
          ? { ...info.staffData, appName: info.appName || '' }
          : (info.appName ? { appName: info.appName } : null);
        targetWa = info.waNumber;
        msg      = formatNotificationMessage(requestId, notif, ticketDesc, staffDataWithApp);
        logger.info(`[Notif] Notifikasi #${notifId} (type: ${notifType || 'unknown'}) tiket ${requestId} -> WA ${targetWa}`);
      }

      // PENTING: jangan tambahkan ke seenIds sebelum pengiriman WA berhasil.
      const result = await sendMessageToNumber(targetWa, msg);

      if (result.success) {
        info.seenIds.add(notifId);
        anyNew = true;
        logger.info(`[Notif]  Notifikasi #${notifId} tiket ${requestId} -> WA ${targetWa} (type: ${notifType || 'unknown'})`);

        // -- TASK 12: Cek lampiran & gambar balasan admin (inline & attachment) --------
 if (notifType !== 'approval' && notifType !== 'system_notification') {
 try {
 const ticketSvc = require('./ticket.service');
 const waSvc = require('./whatsapp.service');
 
 if (!info.seenAttachmentIds) info.seenAttachmentIds = new Set();

 // 1. Ekstrak gambar inline dari notif.description (HTML)
 // ManageEngine menyimpan gambar balasan admin sebagai <img src="/api/v3/.../images/:id" alt="..."/>
 const inlineImages = [];
 if (notif.description && typeof notif.description === 'string') {
 const imgTagRegex = /<img\b[^>]*>/gi;
 let match;
 while ((match = imgTagRegex.exec(notif.description)) !== null) {
 const imgTag = match[0];
 const srcMatch = imgTag.match(/src=["']([^"']+)["']/i);
 if (srcMatch && srcMatch[1]) {
 const src = srcMatch[1];
 if (src.includes('/images/') || src.startsWith('/api/v3/')) {
 const altMatch = imgTag.match(/alt=["']([^"']+)["']/i);
 const alt = altMatch ? altMatch[1] : '';
 inlineImages.push({ src, alt });
 }
 }
 }
 }

 if (inlineImages.length > 0) {
 logger.info(`[Notif] Tiket ${requestId}: ${inlineImages.length} gambar inline ditemukan di balasan admin`);
 for (let i = 0; i < inlineImages.length && i < 5; i++) {
 const img = inlineImages[i];
 const imgKey = `inline_${notifId}_${img.src}`;
 if (!info.seenAttachmentIds.has(imgKey)) {
 logger.info(`[Notif] Mendownload gambar inline ke-${i+1} dari balasan admin tiket ${requestId}...`);
 const fileData = await ticketSvc.downloadInlineImage(img.src);
 if (fileData && fileData.data) {
 const filename = img.alt || `foto_admin_${notifId}_${i+1}.${fileData.content_type === 'image/png' ? 'png' : 'jpg'}`;
 const sendResult = await waSvc.sendMediaToNumber(
 targetWa,
 fileData.data,
 fileData.content_type,
 filename,
 `[Lampiran] Balasan dari Admin - Tiket #${requestId}`
 );
 if (sendResult.success) {
 logger.info(`[Notif] Gambar inline ke-${i+1} terkirim ke WA ${targetWa}`);
 info.seenAttachmentIds.add(imgKey);
 anyNew = true;
 } else {
 logger.warn(`[Notif] Gagal kirim gambar inline ke-${i+1} ke WA ${targetWa}: ${sendResult.error}`);
 }
 }
 }
 }
 }

 // 2. Cek attachment pada notifikasi (jika admin melampirkan file pada reply)
 const notifAttachments = Array.isArray(notif.attachments) ? notif.attachments : [];
 for (const nAtt of notifAttachments) {
 const nAttKey = `notif_att_${notifId}_${nAtt.id}`;
 if (!info.seenAttachmentIds.has(nAttKey)) {
 logger.info(`[Notif] Mendownload attachment notifikasi #${nAtt.id} (${nAtt.name}) tiket ${requestId}...`);
 const fileData = await ticketSvc.downloadNotificationAttachment(requestId, notifId, nAtt.id);
 if (fileData && fileData.data) {
 const sendResult = await waSvc.sendMediaToNumber(
 targetWa,
 fileData.data,
 fileData.content_type,
 nAtt.name || `lampiran_${nAtt.id}.jpg`,
 `[Lampiran] Lampiran dari Admin - Tiket #${requestId}`
 );
 if (sendResult.success) {
 logger.info(`[Notif] Attachment notifikasi #${nAtt.id} terkirim ke WA ${targetWa}`);
 info.seenAttachmentIds.add(nAttKey);
 anyNew = true;
 }
 }
 }
 }

 // 3. Cek attachment di level tiket (request attachments)
 const attachments = await ticketSvc.getTicketAttachments(requestId);
 function getImageMime(att) {
 const name = (att.name || '').toLowerCase();
 if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
 if (name.endsWith('.png')) return 'image/png';
 if (name.endsWith('.gif')) return 'image/gif';
 if (name.endsWith('.webp')) return 'image/webp';
 const ct = (att.content_type || '').toLowerCase();
 if (ct.startsWith('image/')) return ct;
 return null;
 }

 const newImageAttachments = attachments.filter(att =>
 att &&
 att.id &&
 !info.seenAttachmentIds.has(String(att.id)) &&
 !(att.name && (att.name.startsWith('wa_image_') || att.name.startsWith('foto_tiket_'))) &&
 getImageMime(att) !== null
 ).slice(0, 5);

 for (const att of newImageAttachments) {
 const attIdStr = String(att.id);
 const imageMime = getImageMime(att);
 logger.info(`[Notif] Mendownload attachment tiket ${attIdStr} (${att.name}) dari tiket ${requestId}...`);
 const fileData = await ticketSvc.downloadTicketAttachment(requestId, att.id, imageMime);
 if (fileData && fileData.data) {
 const finalMime = (fileData.content_type || '').startsWith('image/')
 ? fileData.content_type
 : imageMime;
 const sendResult = await waSvc.sendMediaToNumber(
 targetWa,
 fileData.data,
 finalMime,
 att.name || `lampiran_${att.id}.jpg`,
 `[Lampiran] Lampiran dari Admin - Tiket #${requestId}`
 );
 if (sendResult.success) {
 logger.info(`[Notif] Lampiran foto ${attIdStr} terkirim ke WA ${targetWa}`);
 info.seenAttachmentIds.add(attIdStr);
 anyNew = true;
 } else {
 logger.warn(`[Notif] Gagal mengirim lampiran foto ${attIdStr} ke WA ${targetWa}: ${sendResult.error}`);
 }
 }
 }
 } catch (errAtt) {
            logger.warn(`[Notif] Error saat memproses attachment tiket ${requestId}: ${errAtt.message}`);
          }
        }
      } else {
        // Tidak masuk seenIds -> akan dicoba ulang di polling berikutnya
        logger.warn(`[Notif]  Gagal kirim notifikasi #${notifId} tiket ${requestId} ke ${targetWa}: ${result.error} - akan dicoba ulang.`);
      }
    }

    if (anyNew) saveTrackedTickets();

  } catch (err) {
    logger.warn(`[Notif] Error polling tiket ${requestId}: ${err.message}`);
  }
}

/**
 * Scheduler utama: dijalankan setiap MASTER_TICK_MS.
 * Men-trigger pollSingleTicket hanya untuk tiket yang sudah waktunya.
 */
async function pollAllTickets() {
  if (trackedTickets.size === 0) return;

  const expiredIds = [];

  for (const [requestId, info] of trackedTickets.entries()) {
    if (Date.now() - info.registeredAt > MAX_TRACK_DURATION_MS) {
      expiredIds.push(requestId);
      continue;
    }
    await pollSingleTicket(requestId); // interval check ada di dalam pollSingleTicket
  }

  if (expiredIds.length > 0) {
    for (const id of expiredIds) {
      trackedTickets.delete(id);
      logger.info(`[Notif] Tiket ${id} dihapus dari tracking (expired).`);
    }
    saveTrackedTickets();
  }
}

// --- Public API ---------------------------------------------------------------

/**
 * Poll tiket SEGERA, mengabaikan interval adaptive.
 * Dipanggil oleh webhook endpoint /webhook/me-notification saat ManageEngine
 * mengirim notifikasi push - menghasilkan zero delay di sisi bot.
 *
 * @param {string} requestId - ID tiket dari ManageEngine
 */
async function pollTicketImmediate(requestId) {
  const id = String(requestId);
  if (!trackedTickets.has(id)) {
    logger.warn(`[Notif] Webhook untuk tiket ${id} diterima tapi tidak ada di tracking.`);
    return false;
  }
  logger.info(`[Notif]  Webhook trigger - poll langsung tiket ${id}`);
  await pollSingleTicket(id, { skipIntervalCheck: true });
  return true;
}

/**
 * Daftarkan tiket untuk dipantau notifikasinya.
 * Dipanggil dari message.handler.js setelah tiket berhasil dibuat.
 *
/**
 * Daftarkan tiket baru ke tracking.
 *
 * @param {string|number} requestId
 * @param {string}        waNumber       - Format: 628xxx
 * @param {string|null}   supervisorWa   - Nomor WA atasan (628xxx), atau null
 * @param {string|null}   supervisorMeId - ManageEngine user ID atasan, atau null
 * @param {object|null}   verifiedUser   - Data user dari lookupUserByEmail (untuk pesan ke atasan)
 * @param {string|null}   appName        - Nama aplikasi dari form staf (untuk pesan ke atasan)
 */
function registerTicket(requestId, waNumber, supervisorWa = null, supervisorMeId = null, verifiedUser = null, appName = null, initialAttachmentIds = []) {
  const id = String(requestId);
  if (trackedTickets.has(id)) {
    logger.info(`[Notif] Tiket ${id} sudah terdaftar - skip duplikat.`);
    return;
  }

  trackedTickets.set(id, {
    waNumber,
    supervisorWa:   supervisorWa   || null,
    supervisorMeId: supervisorMeId || null,
    appName:        appName        || null,   // nama aplikasi untuk pesan ke atasan
    // Simpan data user (nama, NIP, jabatan, dll) untuk dipakai saat kirim pesan ke atasan
    // Disimpan di memory saja (tidak di-persist ke disk untuk privacy)
    staffData:      verifiedUser   || null,
    seenIds:        new Set(),
    registeredAt:   Date.now(),
    lastCheckedAt:  0
  });
  saveTrackedTickets();
  logger.info(
    `[Notif] Tiket ${id} didaftarkan (WA: ${waNumber}` +
    (supervisorWa   ? `, atasan WA: ${supervisorWa}` : ', atasan WA: belum diketahui') +
    (supervisorMeId ? `, atasan ME ID: ${supervisorMeId}` : '') +
    `) - poll pertama dalam ${INITIAL_POLL_DELAY_MS / 1000}s`
  );

  // Poll pertama: bypass interval adaptive agar balasan awal langsung terdeteksi
  setTimeout(() => {
    pollSingleTicket(id, { skipIntervalCheck: true }).catch(err => {
      logger.warn(`[Notif] Poll pertama tiket ${id} gagal: ${err.message}`);
    });
  }, INITIAL_POLL_DELAY_MS);
}

/**
 * Mulai scheduler polling adaptif.
 * Dipanggil SEKALI dari index.js saat server startup.
 */
function startPolling() {
  loadTrackedTickets();
  logger.info(
    `[Notif] Polling real-time aktif - master tick: ${MASTER_TICK_MS / 1000}s | ` +
    `interval per-tiket: ${POLL_INTERVAL_MS / 1000}s (semua umur) | ` +
    `poll pertama: ${INITIAL_POLL_DELAY_MS / 1000}s | ` +
    `max tracking: 7 hari`
  );
  setInterval(pollAllTickets, MASTER_TICK_MS);
}

module.exports = { registerTicket, startPolling, pollTicketImmediate, formatNotificationMessage, buildApprovalRequestMsg };

