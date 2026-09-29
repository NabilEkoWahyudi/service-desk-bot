/**
 * ═══════════════════════════════════════════════════════════════
 * TICKET SERVICE — IT Service Desk Bot PLN Batam
 * ═══════════════════════════════════════════════════════════════
 *
 * Mengirim request ke ManageEngine ServiceDesk Plus API v3.
 *
 * Alur:
 *   1. POST /api/v3/requests  — buat tiket (body: input_data JSON, x-www-form-urlencoded)
 *   2. GET  /api/v3/requests/:id — ambil detail tiket resmi setelah POST berhasil
 *
 * Autentikasi : Header TECHNICIAN_KEY
 * Content-Type: application/x-www-form-urlencoded (untuk POST)
 */

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');
const { CATEGORY_CONFIG, TECHNICIAN_KEY, ME_BASE_URL, ENDPOINT_USERS, ENDPOINT_REQUESTS_BASE } = require('../config/endpoints');
const { getSubcategoryMap } = require('./category.service');
const { getMeConfigIds } = require('./me-config.service');
const logger = require('../utils/logger');

/**
 * Logo PLN Batam:
 *   - Prioritas utama : URL resmi PLN Batam (langsung dirender oleh browser ManageEngine)
 *
 * ManageEngine ServiceDesk biasanya merender gambar dari URL eksternal dengan baik,
 * sehingga pendekatan URL lebih ringan dan tidak menggembungkan payload description.
 */
const PLN_LOGO_URL_BATAM = 'https://www.plnbatam.com/wp-content/themes/brightpln/img/main_logo.jpg';

/**
 * Kembalikan src terbaik untuk logo PLN Batam.
 * Selalu gunakan URL eksternal PLN Batam sebagai prioritas.
 * @returns {string} - URL
 */
function getLogoSrc() {
  // Selalu gunakan URL PLN Batam resmi sebagai prioritas utama
  return PLN_LOGO_URL_BATAM;
}

/**
 * Portal ID untuk ManageEngine On-Premise.
 * Wajib disertakan sebagai header PORTALID di setiap API call.
 * Nilai default 'SDP' — sesuaikan di .env jika berbeda.
 */
const PORTAL_ID = process.env.PORTAL_ID || 'SDP';

/**
 * Headers wajib sesuai Postman collection ManageEngine:
 *   TECHNICIAN_KEY : auth token
 *   PORTALID       : nama portal (wajib di On-Premise)
 *   Accept         : format response JSON v3
 */
const AUTH_HEADERS = {
  'TECHNICIAN_KEY': TECHNICIAN_KEY,
  'PORTALID': PORTAL_ID,
  'Accept': 'application/vnd.manageengine.sdp.v3+json'
};

/**
 * Headers khusus untuk operasi APPROVE / REJECT.
 * Menggunakan ADMIN_KEY (akun approver ManageEngine) karena ManageEngine On-Premise
 * hanya mengizinkan approver yang bersangkutan untuk mengeksekusi _approve / _reject.
 * Jika ADMIN_KEY tidak di-set, fallback ke TECHNICIAN_KEY (mungkin gagal di ME).
 */
const ADMIN_KEY = process.env.ADMIN_KEY || TECHNICIAN_KEY;
const ADMIN_AUTH_HEADERS = {
  'TECHNICIAN_KEY': ADMIN_KEY,
  'PORTALID': PORTAL_ID,
  'Accept': 'application/vnd.manageengine.sdp.v3+json'
};

/**
 * Escape karakter HTML khusus dari string input user agar tidak ada
 * stored XSS / HTML injection ke dalam description ManageEngine. (S4 fix)
 *
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Kompilasi field detail menjadi satu string description untuk ManageEngine.
 * Menyertakan data dari verifiedUser (hasil GET /api/v3/users) dan data form user.
 *
 * Semua data user di-escape HTML sebelum dimasukkan ke template. (S4 fix)
 *
 * @param {object} data          - Data session user (dari form chatbot)
 * @param {string} category      - Kategori request
 * @param {object|null} verifiedUser - Data user dari ManageEngine lookup
 * @param {object|null} config   - CATEGORY_CONFIG entry
 * @returns {string}
 */
function buildDescription(data, category, verifiedUser = null, config = null) {
  const title       = escapeHtml(config ? config.label.toUpperCase() : category);
  const logoSrc     = getLogoSrc();

  const nip         = escapeHtml(verifiedUser?.employeeId || '');
  const fullName    = escapeHtml(verifiedUser?.name || '');
  const jobTitle    = escapeHtml(verifiedUser?.jobTitle || '');
  const phone       = escapeHtml(data.phone || verifiedUser?.phone || '');
  const department  = escapeHtml(verifiedUser?.department || '');
  const userAccount = escapeHtml(verifiedUser?.loginName || data.requester || '');
  const location    = escapeHtml(verifiedUser?.department || '');

  // ── Shared inline style constants (menggantikan CSS class) ────────────────────
  // ManageEngine strips <style> blocks — semua style harus inline agar tampil benar.
  const S_P        = 'margin:0;line-height:1.5;';
  const S_REQUIRED = 'color:#d92d20;white-space:nowrap;';
  const S_TD_LABEL = 'padding:11px 14px;vertical-align:middle;background:#edf5f8;color:#173f56;font-weight:700;width:230px;border-right:1px solid #d6e0e7;border-bottom:1px solid #d6e0e7;';
  const S_TD_VALUE = 'padding:11px 14px;vertical-align:middle;color:#39444b;border-bottom:1px solid #d6e0e7;';
  // Baris terakhir sebelum commitment tidak perlu border-bottom (commitment punya border-top sendiri)
  const S_TD_LABEL_LAST = S_TD_LABEL.replace('border-bottom:1px solid #d6e0e7;', '');
  const S_TD_VALUE_LAST = S_TD_VALUE.replace('border-bottom:1px solid #d6e0e7;', '');

  // ── Helper: baris label-value standar ─────────────────────────────────────────
  function labelRow(labelText, valueText, isLast = false) {
    const sTdL = isLast ? S_TD_LABEL_LAST : S_TD_LABEL;
    const sTdV = isLast ? S_TD_VALUE_LAST : S_TD_VALUE;
    return `
      <tr>
        <td style="${sTdL}">
          <p style="${S_P}">${labelText} <span style="${S_REQUIRED}">*</span> :</p>
        </td>
        <td colspan="4" style="${sTdV}">
          <p style="${S_P}">${valueText}</p>
        </td>
      </tr>`;
  }

  // ─── Baris khusus per kategori ────────────────────────────────────────────────
  let categorySpecificRow = '';

  if (category === 'PASSWORD') {
    // ── Reset Password: tampilkan Nama Aplikasi + Username Aplikasi ──
    const appName      = escapeHtml(data.nama_aplikasi      || '-');
    const usernameApps = escapeHtml(data.username_aplikasi  || '-');
    categorySpecificRow =
      labelRow('Nama Aplikasi',      appName) +
      labelRow('Username Aplikasi',  usernameApps, true);

  } else if (category === 'AUTORISASI') {
    // ── Otorisasi: Nama Aplikasi + Username Aplikasi + Alasan + Tabel 2 Kolom Role ──
    const appName        = escapeHtml(data.nama_aplikasi      || '-');
    const usernameApps   = escapeHtml(data.username_aplikasi  || '-');
    const alasanOtorisasi = escapeHtml(data.alasan_otorisasi  || '-');
    // Nilai role: kosong / "-" → tampilkan sel kosong
    const roleAssign = (data.role_assign && data.role_assign.trim() && data.role_assign.trim() !== '-')
      ? escapeHtml(data.role_assign.trim()) : '';
    const roleHapus  = (data.role_hapus  && data.role_hapus.trim()  && data.role_hapus.trim()  !== '-')
      ? escapeHtml(data.role_hapus.trim())  : '';

    const S_TH_ASSIGN = 'padding:10px 14px;font-weight:700;color:#1565c0;background:#edf5f8;border:1px solid #d6e0e7;text-align:center;width:50%;';
    const S_TH_HAPUS  = 'padding:10px 14px;font-weight:700;color:#d92d20;background:#fff3f3;border:1px solid #d6e0e7;text-align:center;width:50%;';
    const S_TD_CELL   = 'padding:9px 14px;border:1px solid #d6e0e7;vertical-align:top;min-height:30px;';

    // Buat 5 baris data — baris pertama diisi nilai user, sisanya kosong
    const buildRoleRows = () => {
      const rows = [];
      for (let r = 0; r < 5; r++) {
        rows.push(`
          <tr>
            <td style="${S_TD_CELL}">${r === 0 ? roleAssign : ''}</td>
            <td style="${S_TD_CELL}">${r === 0 ? roleHapus  : ''}</td>
          </tr>`);
      }
      return rows.join('');
    };

    categorySpecificRow =
      labelRow('Nama Aplikasi',     appName) +
      labelRow('Username Aplikasi', usernameApps) +
      // Baris full-width: label Alasan
      `<tr>
        <td colspan="5" style="padding:10px 14px;vertical-align:middle;background:#edf5f8;color:#173f56;font-weight:700;border-bottom:1px solid #d6e0e7;">
          <p style="${S_P}">Alasan Pembuatan/Perubahan Otorisasi <span style="${S_REQUIRED}">*</span> :</p>
        </td>
      </tr>
      <tr>
        <td colspan="5" style="padding:10px 14px;vertical-align:top;color:#39444b;border-bottom:1px solid #d6e0e7;min-height:40px;">
          <p style="${S_P}">${alasanOtorisasi}</p>
        </td>
      </tr>
      <!-- Tabel 2 kolom Role -->
      <tr>
        <td colspan="5" style="padding:0;border-bottom:1px solid #d6e0e7;">
          <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
            <thead>
              <tr>
                <th style="${S_TH_ASSIGN}">Role yang akan <span style="color:#1565c0;">diassign</span> ke User</th>
                <th style="${S_TH_HAPUS}">Role yang akan <span style="color:#d92d20;">dihapus</span> dari User</th>
              </tr>
            </thead>
            <tbody>${buildRoleRows()}</tbody>
          </table>
        </td>
      </tr>`;

  } else if (category === 'KELUHAN') {
    // ── Permintaan/Keluhan: tampilkan Nama Aplikasi + Username Aplikasi + Keluhan ──
    const appName      = escapeHtml(data.nama_aplikasi      || '-');
    const usernameApps = escapeHtml(data.username_aplikasi  || '-');
    const keluhanVal   = escapeHtml(data.keluhan            || '-');
    categorySpecificRow =
      labelRow('Nama Aplikasi',      appName) +
      labelRow('Username Aplikasi',  usernameApps) +
      labelRow('Keluhan yang Dialami', keluhanVal, true);

  } else if (category === 'VPN') {
    // ── Akses VPN: tampilkan User Account (email) + Alasan + Tabel Tanggal ──
    const emailUser = escapeHtml(verifiedUser?.email || data.requester || '-');
    const alasanVal = escapeHtml(data.alasan || '-');
    const tglAwal   = escapeHtml(data.tgl_awal || '-');
    const tglAkhir  = escapeHtml(data.tgl_akhir || '-');

    const S_TH_TGL = 'padding:10px 14px;font-weight:700;color:#39444b;background:#cfd8df;border:1px solid #c9d8e2;text-align:center;width:50%;';
    const S_TD_TGL = 'padding:11px 14px;border:1px solid #c9d8e2;text-align:center;color:#b0bac3;font-weight:600;font-size:15px;';
    const S_TD_TGL_FILLED = 'padding:11px 14px;border:1px solid #c9d8e2;text-align:center;color:#39444b;font-weight:600;font-size:15px;';

    categorySpecificRow =
      labelRow('User Account', emailUser) +
      // Baris full-width: label Alasan
      `<tr>
        <td colspan="5" style="padding:10px 14px;vertical-align:middle;background:#edf5f8;color:#173f56;font-weight:700;border-bottom:1px solid #d6e0e7;">
          <p style="${S_P}">Alasan Permintaan Akses VPN <span style="${S_REQUIRED}">*</span> :</p>
        </td>
      </tr>
      <tr>
        <td colspan="5" style="padding:10px 14px;vertical-align:top;color:#39444b;border-bottom:1px solid #d6e0e7;min-height:40px;">
          <p style="${S_P}">${alasanVal}</p>
        </td>
      </tr>
      <!-- Tabel 2 kolom Tanggal VPN -->
      <tr>
        <td colspan="5" style="padding:0;border-bottom:1px solid #d6e0e7;">
          <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
            <thead>
              <tr>
                <th style="${S_TH_TGL}">Tanggal Awal Akses VPN</th>
                <th style="${S_TH_TGL}">Tanggal Akhir Akses VPN</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style="${tglAwal !== '-' ? S_TD_TGL_FILLED : S_TD_TGL}">${tglAwal !== '-' ? tglAwal : 'dd Bulan yyyy'}</td>
                <td style="${tglAkhir !== '-' ? S_TD_TGL_FILLED : S_TD_TGL}">${tglAkhir !== '-' ? tglAkhir : 'dd Bulan yyyy'}</td>
              </tr>
            </tbody>
          </table>
        </td>
      </tr>`;
  }

  // ─── Baris header NAMA APLIKASI: hanya untuk PASSWORD / AUTORISASI / KELUHAN ────────────
  const appNameHeaderRow = (category === 'PASSWORD' || category === 'AUTORISASI' || category === 'KELUHAN')
    ? `
      <tr>
        <td colspan="5" style="padding:11px 14px;vertical-align:middle;background:#f7fafb;border-bottom:1px solid #d6e0e7;">
          <p style="${S_P}"><b>NAMA APLIKASI <span style="${S_REQUIRED}">*</span> : ${escapeHtml(data.nama_aplikasi || '-')}</b></p>
        </td>
      </tr>`
    : '';

  // ─── Logo img atau fallback teks ─────────────────────────────────────────────
  const logoHtml = logoSrc
    ? `<img src="${logoSrc}" alt="Logo PLN Batam" width="80" height="50" style="display:block;margin:0 auto;object-fit:contain;"/>`
    : `<span style="font-size:9px;color:#888;">PLN Batam</span>`;

  return `<div style="width:100%;max-width:860px;margin:0 auto;background:#ffffff;font-family:Roboto,Arial,sans-serif;font-size:14px;color:#263746;">

  <!-- ═══ HEADER TABLE ══════════════════════════════════════════════════════ -->
  <table cellpadding="0" cellspacing="0" border="0"
    style="width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;margin-bottom:18px;border:1px solid #d6e0e7;border-radius:14px;background:#ffffff;box-shadow:0 5px 18px rgba(30,63,83,0.08);">
    <colgroup>
      <col style="width:18%;" />
      <col style="width:64%;" />
      <col style="width:18%;" />
    </colgroup>
    <tbody>
      <tr>
        <td rowspan="2"
          style="background:#f7fafb;text-align:center;padding:14px 16px;vertical-align:middle;border-right:1px solid #d6e0e7;">
          <p style="${S_P}"><span style="font-size:20px;">OPS<br/>TI</span></p>
        </td>
        <td style="background:#075578;color:#ffffff;text-align:center;padding:14px 16px;vertical-align:middle;border-bottom:1px solid rgba(255,255,255,0.25);border-right:1px solid rgba(255,255,255,0.15);">
          <p style="${S_P}color:#ffffff;"><b style="font-size:15px;letter-spacing:0.4px;color:#ffffff;">FORMULIR PERMINTAAN</b></p>
        </td>
        <td rowspan="2"
          style="background:#f7fafb;text-align:center;padding:14px 16px;vertical-align:middle;">
          <p style="${S_P}">${logoHtml}</p>
        </td>
      </tr>
      <tr>
        <td style="background:#075578;color:#ffffff;text-align:center;padding:14px 16px;vertical-align:middle;border-right:1px solid rgba(255,255,255,0.15);">
          <p style="${S_P}color:#ffffff;"><b style="font-size:13px;letter-spacing:0.2px;color:#ffffff;">${title}</b></p>
        </td>
      </tr>
    </tbody>
  </table>

  <!-- ═══ FORM TABLE ════════════════════════════════════════════════════════ -->
  <table cellpadding="0" cellspacing="0" border="0"
    style="width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;border:1px solid #d6e0e7;border-radius:14px;background:#ffffff;box-shadow:0 5px 18px rgba(30,63,83,0.06);">
    <colgroup>
      <col style="width:230px;" />
      <col style="width:157.5px;" />
      <col style="width:157.5px;" />
      <col style="width:157.5px;" />
      <col style="width:157.5px;" />
    </colgroup>
    <tbody>
      ${appNameHeaderRow}
      <tr>
        <td colspan="5" style="padding:11px 14px;vertical-align:middle;background:#f7fafb;border-bottom:1px solid #d6e0e7;">
          <p style="${S_P}"><b>Lokasi <span style="${S_REQUIRED}">*</span> :&nbsp;${location}</b></p>
        </td>
      </tr>
      ${labelRow('Nomor Induk Pegawai', nip)}
      ${labelRow('Nama Lengkap', fullName)}
      ${labelRow('Jabatan', jobTitle)}
      ${labelRow('Phone/Ext/HP', phone)}
      ${labelRow('Unit/Bidang/Bagian', department)}
      ${categorySpecificRow}
      <tr>
        <td colspan="5"
          style="padding:16px 18px;vertical-align:middle;background:#fff8e7;border-top:2px solid #e1b343;">
          <p style="margin:0 0 8px 0;line-height:1.5;color:#6d4c00;font-weight:700;">Komitmen Pengguna:</p>
          <p style="margin:0;color:#39444b;line-height:1.65;text-align:justify;">Dengan ini menyatakan bahwa saya akan menjaga kerahasiaan data dan akses yang diberikan kepada saya serta tidak akan mengalihkan hak akses tersebut kepada pihak lain tanpa izin. Saya berkomitmen untuk menggunakan sistem informasi dan teknologi di lingkungan PT PLN Batam dengan bertanggung jawab, menjaga keamanan kata sandi dan identitas yang diberikan kepada saya. Saya juga akan segera melaporkan setiap insiden atau potensi ancaman keamanan informasi kepada&nbsp;Unit Bisnis Infrastruktur Teknologi Informasi.</p>
        </td>
      </tr>
    </tbody>
  </table>

</div>`;
}

/**
 * Kirim request ke ManageEngine ServiceDesk Plus.
 *
 * @param {string} category        - Kategori: PASSWORD, AUTORISASI, KELUHAN, VPN, TEST
 * @param {object} data            - Data user dari session
 * @param {object|null} verifiedUser - Data user dari ManageEngine lookup
 * @returns {Promise<{ success: boolean, message: string, requestId?: string, ticketDetail?: object }>}
 */
async function submitToEndpoint(category, data, verifiedUser = null, options = {}) {
  const config = CATEGORY_CONFIG[category];
  if (!config) {
    return { success: false, message: `Kategori tidak valid: ${category}` };
  }

  if (!TECHNICIAN_KEY) {
    logger.warn('[Ticket] TECHNICIAN_KEY belum diset di .env — skip pengiriman');
    return {
      success: false,
      message: 'Technician Key ManageEngine belum dikonfigurasi. Pengajuan tercatat.'
    };
  }

  // ── Build description HTML dengan detail dari verifiedUser ──────────────────
  let compiledDescription = buildDescription(data, category, verifiedUser, config);

  // ── Requester: pakai id + name dari hasil GET /api/v3/users ─────────────
  // ManageEngine lebih reliabel menerima id dibanding email_id.
  // id didapat dari verifiedUser yang sudah di-lookup sebelum submit.
  // Fallback ke email_id jika (unlikely) lookup tidak menghasilkan id.
  const requesterPayload = (verifiedUser && verifiedUser.id)
    ? { id: String(verifiedUser.id), name: verifiedUser.name }
    : { email_id: data.requester };

  // ── Dapatkan Config ID secara dinamis (fallback ke env) ───────────────────
  const meConfig = await getMeConfigIds();

  // ── Payload yang dikirim ke ManageEngine ──────────────────────────────────
  // [BUG-2 FIX] ID diambil dinamis dari ManageEngine API atau konstanta .env
  const requestBody = {
    subject:          config.autoSubject,
    description:      compiledDescription,
    requester:        requesterPayload,
    group:            { id: meConfig.groupId },
    level:            { id: meConfig.levelId },
    service_category: { id: meConfig.serviceCategoryId }
  };

  // ── Pilih template berdasarkan tipe user ─────────────────────────────────
  // Untuk AUTORISASI, terdapat dua template:
  //   1. templateId       (default: 2404) — "Formulir Permintaan Get Approvals"
  //      → Dipakai user BIASA: memiliki approval level, notif dikirim ke atasan via WA.
  //   2. seniorTemplateId (default: 2408) — "(Tanpa Approval) Pembuatan atau Perubahan Otorisasi"
  //      → Dipakai ATASAN (isSenior=true): TIDAK ada approval level, tiket langsung ke teknisi.
  //        Menggantikan auto-approve via API yang tidak reliabel.
  const isSeniorUser = options?.isSenior === true;
  if (category === 'AUTORISASI') {
    if (isSeniorUser && config.seniorTemplateId) {
      requestBody.template = { id: config.seniorTemplateId };
      logger.info(
        `[Ticket] Template SENIOR (tanpa approval) disertakan: ID=${config.seniorTemplateId} ` +
        `— tiket atasan langsung ke teknisi tanpa approval workflow.`
      );
    } else if (config.templateId) {
      requestBody.template = { id: config.templateId };
      logger.info(
        `[Ticket] Template AUTORISASI (dengan approval) disertakan: ID=${config.templateId} ` +
        `— notifikasi approval akan dikirim ke atasan.`
      );
    }
  }


  const inputData = { request: requestBody };

  // ── Lookup category & subcategory dari nama aplikasi ───────────────────────────────
  // Cocokkan nama_aplikasi secara case-insensitive ke map dinamis (dari ManageEngine API).
  // Jika ditemukan, tambahkan category & subcategory ke requestBody.
  // Jika tidak ditemukan, tiket tetap dikirim tanpa kedua field tersebut.
  if (data.nama_aplikasi) {
    const appKey = (data.nama_aplikasi || '').trim().toLowerCase();
    const subcategoryMap = await getSubcategoryMap();
    const subcatInfo = subcategoryMap[appKey];
    if (subcatInfo) {
      requestBody.category    = { id: subcatInfo.categoryId };
      requestBody.subcategory = { id: subcatInfo.subcategoryId };
      logger.info(`[Ticket] Subcategory ditemukan: ${subcatInfo.subcategoryName} (${subcatInfo.categoryName})`);
    } else {
      logger.warn(`[Ticket] Nama aplikasi "${data.nama_aplikasi}" tidak ditemukan di subcategory map — category/subcategory tidak disertakan`);
    }
  }

  // ── Fallback khusus kategori VPN ────────────────────────────────────────────
  // Kategori "Akses VPN" tidak memiliki field nama_aplikasi (user hanya mengisi
  // alasan), sehingga lookup di atas tidak terpicu.
  // Solusi: jika bot-category === 'VPN' dan subcategory belum diset,
  // cari 'vpn' di map dinamis dan otomatis petakan.
  if (category === 'VPN' && !requestBody.subcategory) {
    const subcategoryMap = await getSubcategoryMap();
    const vpnInfo = subcategoryMap['vpn'];
    if (vpnInfo) {
      requestBody.category    = { id: vpnInfo.categoryId };
      requestBody.subcategory = { id: vpnInfo.subcategoryId };
      logger.info(`[Ticket] Subcategory VPN otomatis dipetakan: ${vpnInfo.subcategoryName} (${vpnInfo.categoryName})`);
    }
  }

  const params = new URLSearchParams();
  params.append('input_data', JSON.stringify(inputData));

  // [BUG-2 FIX] Log payload SEBELUM dikirim untuk memudahkan debug HTTP 400.
  // Hanya log field struktural (bukan description HTML yang panjang).
  logger.info(
    `[Ticket] Payload ke ManageEngine: group=${meConfig.groupId}, level=${meConfig.levelId}, ` +
    `service_category=${meConfig.serviceCategoryId}, ` +
    `requester=${JSON.stringify(requesterPayload)}, subject="${config.autoSubject}"` +
    (requestBody.category    ? `, category=${requestBody.category.id}`    : '') +
    (requestBody.subcategory ? `, subcategory=${requestBody.subcategory.id}` : '')
  );

  let requestId = null;

  /**
   * Kirim POST request. URL divalidasi agar hanya ke host yang sama
   * dengan ME_BASE_URL untuk mencegah SSRF. (B5 fix)
   */
  async function sendPostRequest(url) {
    // Validasi URL: hanya izinkan host yang sama dengan ME_BASE_URL
    try {
      const allowedHost = new URL(ME_BASE_URL).host;
      const targetHost  = new URL(url).host;
      if (targetHost !== allowedHost) {
        throw new Error(`Redirect ke host tidak diizinkan: ${targetHost} (expected: ${allowedHost})`);
      }
    } catch (urlErr) {
      throw new Error(`URL tidak valid atau tidak aman: ${urlErr.message}`);
    }

    return await axios.post(url, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...AUTH_HEADERS
      },
      timeout: 30000,
      maxContentLength: 2 * 1024 * 1024,
      maxRedirects: 0 // Jangan otomatis ikuti redirect, supaya POST tidak berubah jadi GET
    });
  }

  // Langkah 1: POST — buat tiket
  try {
    logger.info(`[Ticket] Membuat request di ManageEngine — kategori: ${config.label}`);

    let response;
    try {
      response = await sendPostRequest(config.endpoint);
    } catch (err) {
      if (err.response && (err.response.status === 301 || err.response.status === 302)) {
        const redirectUrl = err.response.headers.location;
        logger.warn(`[Ticket] Server meredirect (${err.response.status}) ke: ${redirectUrl}. Melakukan retry...`);
        response = await sendPostRequest(redirectUrl); // SSRF-safe via validasi host di atas
      } else {
        throw err; // Lempar ke blok catch terluar
      }
    }

    // Ekstrak ID dari response
    const responseData = Array.isArray(response.data) ? response.data[0] : response.data;
    requestId = responseData?.request?.id || responseData?.response_status?.id || null;

    logger.info(`[Ticket] Request berhasil dibuat! HTTP: ${response.status}${requestId ? `, ID: ${requestId}` : ''}`);

  } catch (err) {
    return _handleAxiosError('[Ticket] Gagal membuat request', err);
  }

  // Langkah 2: GET /api/v3/requests/:id — ambil detail tiket resmi
  let ticketDetail = null;
  if (requestId) {
    ticketDetail = await getTicketDetail(requestId);
  }

  return {
    success: true,
    message: 'Request berhasil dikirim ke ManageEngine ServiceDesk Plus.',
    requestId,
    ticketDetail
  };
}

/**
 * Ambil detail tiket resmi dari ManageEngine setelah POST berhasil.
 *
 * @param {string} requestId - ID tiket dari hasil POST
 * @returns {Promise<object|null>}
 */
async function getTicketDetail(requestId) {
  try {
    const endpoint = `${ENDPOINT_REQUESTS_BASE}/${requestId}`;
    // logger.debug(`[Ticket] Mengambil detail tiket resmi — GET ${endpoint}`);

    const response = await axios.get(endpoint, {
      headers: AUTH_HEADERS,
      timeout: 15000
    });

    const ticket = response.data?.request || null;
    if (ticket) {
      // logger.debug(`[Ticket] Detail tiket berhasil diambil — ID: ${requestId}`);
    }
    return ticket;

  } catch (err) {
    // Tidak fatal — jika gagal, bot tetap kirim notifikasi dengan requestId saja
    logger.warn(`[Ticket] Gagal ambil detail tiket ${requestId}: ${err.message}`);
    return null;
  }
}

/**
 * Ambil daftar notifikasi tiket dari ManageEngine.
 * Digunakan oleh notification.service.js untuk polling balasan admin.
 *
 * Endpoint: GET /api/v3/requests/:request_id/notifications
 *
 * Return values:
 *   { notFound: true }  — tiket tidak ada di ManageEngine (HTTP 404), harus di-untrack
 *   []                  — sukses tapi tidak ada notifikasi baru
 *   [ ...notifs ]       — sukses, ada notifikasi baru
 *
 * @param {string} requestId - ID tiket dari ManageEngine
 * @returns {Promise<object[]|{notFound:boolean}>}
 */
async function getTicketNotifications(requestId) {
  try {
    const endpoint = `${ENDPOINT_REQUESTS_BASE}/${requestId}/notifications`;
    // logger.debug(`[Ticket] Mengambil notifikasi tiket — GET ${endpoint}`);

    const response = await axios.get(endpoint, {
      headers: AUTH_HEADERS,
      timeout: 15000
    });

    const notifications = response.data?.notifications || [];
    return notifications;

  } catch (err) {
    // Deteksi 404: tiket sudah tidak ada di ManageEngine (dihapus / tidak valid)
    if (err.response?.status === 404) {
      logger.warn(`[Ticket] Tiket ${requestId} tidak ditemukan di ManageEngine (404) — tandai untuk dihapus dari tracking.`);
      return { notFound: true };
    }
    // Error lain (timeout, 5xx, dll) — anggap sementara, jangan untrack
    logger.warn(`[Ticket] Gagal ambil notifikasi tiket ${requestId}: ${err.message}`);
    return [];
  }
}

/**
 * Lookup data pegawai dari ManageEngine berdasarkan email kantor.
 *
 * CATATAN PENTING:
 *   GET /api/v3/users (list) TIDAK mengembalikan field reporting_to.
 *   Setelah user ditemukan dari list, dilakukan GET /api/v3/users/{id}
 *   untuk mendapatkan reporting_to lengkap (phone, id, name, dll).
 *
 * @param {string} email - Email kantor pegawai (contoh: nama@plnbatam.com)
 * @returns {Promise<{ found: boolean, user?: object, message?: string }>}
 */
async function lookupUserByEmail(email) {
  if (!TECHNICIAN_KEY) {
    logger.warn('[Lookup] TECHNICIAN_KEY belum diset — tidak dapat melakukan lookup user');
    return { found: false, message: 'Technician Key belum dikonfigurasi.' };
  }

  const inputData = {
    list_info: {
      sort_field: 'name',
      start_index: 1,
      sort_order: 'asc',
      row_count: '25',
      get_total_count: true,
      search_fields: {
        email_id: email.trim()
      }
    },
    // fields_required di GET all users TIDAK mencakup reporting_to —
    // reporting_to hanya tersedia di GET /api/v3/users/{id}
    fields_required: [
      'name',
      'is_technician',
      'login_name',
      'email_id',
      'department',
      'phone',
      'mobile',
      'jobtitle',
      'employee_id',
      'first_name',
      'middle_name',
      'last_name',
      'is_vipuser'
    ]
  };

  try {
    logger.info(`[Lookup] Mencari user ManageEngine dengan email: ${email}`);

    const response = await axios.get(ENDPOINT_USERS, {
      params: {
        input_data: JSON.stringify(inputData)
      },
      headers: AUTH_HEADERS,
      timeout: 15000
    });

    const users = response.data?.users;

    if (!users || users.length === 0) {
      logger.info(`[Lookup] Email tidak ditemukan di ManageEngine: ${email}`);
      return { found: false, message: 'Email tidak terdaftar di sistem ManageEngine PLN.' };
    }

    const u = users[0];

    const fullName = [
      u.first_name || '',
      u.middle_name || '',
      u.last_name || ''
    ].filter(Boolean).join(' ').trim() || u.name || u.full_name || '-';

    // ── Langkah 2: GET /api/v3/users/{id} untuk mendapatkan reporting_to ──────────────
    // GET all users TIDAK mengembalikan reporting_to — harus ambil dari endpoint individual.
    // Endpoint individual SELALU menyertakan reporting_to lengkap (phone, id, name, email).
    let reportingToData = null;
    let supervisorWa    = null;
    let supervisorMeId  = null;   // ManageEngine user ID atasan
    let isSenior        = false;  // true jika user punya org_role 'Reporting To' di ME

    if (u.id) {
      try {
        logger.info(`[Lookup] Mengambil detail user ID ${u.id} untuk mendapatkan reporting_to...`);
        const userDetail = await getUserById(u.id);

        if (userDetail?.reportingTo) {
          reportingToData = userDetail.reportingTo;
          supervisorMeId  = String(reportingToData.id || '').trim() || null;

          // Normalisasi nomor WA atasan dari reporting_to
          // Mendukung: +628xxx, 628xxx, 08xxx, 8xxx → semua jadi 628xxx
          const rawPhone = reportingToData.phone || reportingToData.mobile || null;
          if (rawPhone) {
            const cleanPhone = rawPhone.replace(/\D/g, '');
            if (cleanPhone.startsWith('0')) {
              supervisorWa = '62' + cleanPhone.slice(1);
            } else if (cleanPhone.startsWith('62')) {
              supervisorWa = cleanPhone;
            } else {
              supervisorWa = '62' + cleanPhone;
            }
            // Validasi panjang nomor
            if (supervisorWa.length < 10 || supervisorWa.length > 15) supervisorWa = null;
          }

          logger.info(
            `[Lookup] reporting_to ditemukan via GET /users/${u.id}: ` +
            `id=${supervisorMeId}, name=${reportingToData.name}, ` +
            `supervisorWa=${supervisorWa || '(phone tidak ada)'}`
          );
        } else {
          logger.warn(`[Lookup] User ID ${u.id} tidak memiliki reporting_to di ManageEngine.`);
        }

        // isSenior: true jika jabatan user adalah tingkat manajemen (ASMAN ke atas).
        // Cek keywords di jobTitle untuk menentukan auto-approve.
        // PENTING: ManageEngine mengembalikan field 'jobtitle' (huruf kecil) di GET /users/{id},
        // sehingga kita baca dari userDetail.jobtitle (bukan .jobTitle).
        const rawJobTitle = userDetail?.jobtitle || userDetail?.jobTitle || '';
        const jobTitle = rawJobTitle.toUpperCase();
        logger.info(`[Lookup] User ID ${u.id} — jobTitle dari ME: "${rawJobTitle || '(kosong)'}"`); 

        // Keyword senior: ASMAN (Asisten Manajer) dan ke atas — sesuai hierarki PLN/korporat Indonesia.
        // Singkatan umum:
        //   ASMAN / ASMGR / AS MAN / AS. MAN / ASISTEN MAN* → Asisten Manajer (level minimum)
        //   MAN / MGR / MANAJER / MANAGER               → Manajer
        //   SM / SR MGR / SENIOR MAN*                   → Senior Manager
        //   KAMAN / KADIV / KADEP / KABID               → Kepala Divisi / Departemen / Bidang
        //   GM / GEN MAN*                               → General Manager
        //   VP / VICE PRES*                             → Vice President
        //   SVP / SR VP / SENIOR VP                    → Senior Vice President
        //   EVP / EXC VP / EXEC VP                     → Executive Vice President
        //   DIR / DIREKTUR / DIRECTOR                  → Direktur
        //   DIRUT / DIRUTAMA                           → Direktur Utama
        const seniorKeywords = [
          // ── Asisten Manajer (level minimum auto-approve) ──────────────────
          'ASMAN', 'ASMGR', 'AS MAN', 'AS MGR', 'AS. MAN', 'AS. MGR',
          'ASISTEN MAN', 'ASISTEN MGR', 'ASISTEN MANAGER', 'ASISTEN MANAJER',
          'ASSISTANT MANAGER', 'ASST MANAGER', 'ASST MGR',
          // ── Manajer ───────────────────────────────────────────────────────
          'MANAJER', 'MANAGER', 'MGR', 'MAN',
          // ── Senior Manager ────────────────────────────────────────────────
          'SM', 'SR MGR', 'SR MAN', 'SR. MGR', 'SR. MAN',
          'SENIOR MANAGER', 'SENIOR MANAJER', 'SENIOR MGR',
          // ── Kepala (Divisi / Departemen / Bidang / Bagian) ────────────────
          'KADIV', 'KADEP', 'KABAG', 'KABID', 'KAMAN',
          'KEPALA DIVISI', 'KEPALA DEPARTEMEN', 'KEPALA BIDANG', 'KEPALA BAGIAN',
          // ── General Manager ───────────────────────────────────────────────
          'GM', 'GENERAL MANAGER', 'GENERAL MGR',
          // ── Vice President ────────────────────────────────────────────────
          'VP', 'VICE PRESIDENT', 'VICE PRES',
          // ── Senior Vice President ─────────────────────────────────────────
          'SVP', 'SR VP', 'SR. VP', 'SENIOR VP', 'SENIOR VICE PRESIDENT',
          // ── Executive Vice President ──────────────────────────────────────
          'EVP', 'EXC VP', 'EXEC VP', 'EXECUTIVE VICE PRESIDENT',
          // ── Direktur ──────────────────────────────────────────────────────
          'DIR', 'DIREKTUR', 'DIRECTOR',
          'DIRUT', 'DIRUTAMA', 'DIREKTUR UTAMA',
          // ── Komisaris ─────────────────────────────────────────────────────
          'KOMUT', 'KOMISARIS UTAMA', 'KOMISARIS',
          // ── Wakil / Deputi / Asisten (Level Atas) ─────────────────────────
          'WAKADIV', 'WAKADEP', 'WADIR', 'WADIRUT', 'WAGM', 'WASM',
          'DEPUTI', 'DEPUTY'
        ];

        isSenior = seniorKeywords.some(keyword => {
          const regex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'i');
          return regex.test(jobTitle);
        });

        if (isSenior) {
          logger.info(`[Lookup] User ID ${u.id} memiliki jabatan '${rawJobTitle}' (Senior/Manajemen) → isSenior = true (auto-approve)`);
        }
      } catch (detailErr) {
        logger.warn(`[Lookup] Gagal ambil detail user ${u.id}: ${detailErr.message} — reporting_to diabaikan.`);
      }
    }

    const user = {
      id:            u.id || '',
      name:          fullName,
      email:         u.email_id || email,
      department:    u.department?.name || '',
      phone:         u.phone || u.mobile || '',
      mobile:        u.mobile || u.phone || '',
      employeeId:    u.employee_id || u.login_name || '',
      loginName:     u.login_name || '',
      jobTitle:      u.jobtitle || '',
      firstName:     u.first_name || '',
      middleName:    u.middle_name || '',
      lastName:      u.last_name || '',
      isTechnician:  u.is_technician || false,
      isVipUser:     u.is_vipuser || false,
      isSenior,          // true jika org_role 'Reporting To' → auto-approve AUTORISASI
      reportingTo:   reportingToData,
      supervisorWa,
      supervisorMeId
    };

    logger.info(
      `[Lookup] User ditemukan: ${user.name} (${user.department}) — ` +
      `atasan: ${user.reportingTo?.name || 'tidak ada'} (ME ID: ${supervisorMeId || '-'}) — ` +
      `supervisorWa: ${user.supervisorWa || '(phone/mobile tidak ada di reporting_to)'}`
    );
    return { found: true, user };

  } catch (err) {
    return _handleAxiosError('[Lookup] Gagal mengambil data user dari ManageEngine', err);
  }
}

/**
 * Ambil detail user dari ManageEngine berdasarkan user_id.
 * Digunakan untuk mendapatkan data atasan (reporting_to) termasuk nomor teleponnya,
 * serta org_roles untuk menentukan apakah user adalah senior (Reporting To).
 * Endpoint: GET /api/v3/users/{userId}
 *
 * @param {string|number} userId - ID user ManageEngine
 * @returns {Promise<{ id, name, jobtitle, reportingTo, orgRoles }|null>}
 */
async function getUserById(userId) {
  if (!userId) return null;
  try {
    const endpoint = `${ME_BASE_URL}/api/v3/users/${userId}`;
    logger.info(`[Ticket] Mengambil detail user by ID — GET ${endpoint}`);

    const response = await axios.get(endpoint, {
      headers: AUTH_HEADERS,
      timeout: 15000
    });

    const u = response.data?.user;
    if (!u) return null;

    const reportingTo = u.reporting_to
      ? {
          id:     u.reporting_to.id       || null,
          name:   u.reporting_to.name     || '-',
          email:  u.reporting_to.email_id || '-',
          phone:  u.reporting_to.phone    || null,
          mobile: u.reporting_to.mobile   || null
        }
      : null;

    // org_roles: daftar peran organisasi user di ManageEngine.
    // Contoh: [{ name: 'Reporting To', id: 2 }] — artinya user ini adalah atasan bagi orang lain.
    const orgRoles = Array.isArray(u.org_roles) ? u.org_roles : [];

    logger.info(`[Ticket] Detail user ID ${userId} — atasan: ${reportingTo?.name || 'tidak ada'}, org_roles: [${orgRoles.map(r => r.name).join(', ') || 'kosong'}]`);

    return {
      id:         u.id || String(userId),
      name:       u.name || '-',
      jobtitle:   u.jobtitle || '',      // key asli dari ManageEngine
      jobTitle:   u.jobtitle || '',      // camelCase alias — untuk konsistensi dengan user object
      phone:      u.phone  || null,
      mobile:     u.mobile || null,
      reportingTo,
      orgRoles
    };

  } catch (err) {
    logger.warn(`[Ticket] Gagal ambil detail user ID ${userId}: ${err.message}`);
    return null;
  }
}

/**
 * Ambil daftar approval levels dari ManageEngine untuk sebuah tiket.
 * Endpoint: GET /api/v3/requests/{requestId}/approval_levels
 *
 * Response yang diharapkan:
 *   { approval_levels: [ { level_number, approvals: [ { id, status, ... } ] } ] }
 *
 * @param {string} requestId - ID tiket ManageEngine
 * @returns {Promise<Array>} - Array approval levels, atau [] jika gagal
 */
async function getApprovalLevels(requestId) {
  try {
    const endpoint = `${ENDPOINT_REQUESTS_BASE}/${requestId}/approval_levels`;
    logger.info(`[Ticket] Mengambil approval levels — GET ${endpoint}`);

    const response = await axios.get(endpoint, {
      headers: AUTH_HEADERS,
      timeout: 15000
    });

    const levels = response.data?.approval_levels || [];
    logger.info(`[Ticket] ${levels.length} approval level ditemukan untuk tiket ${requestId}`);
    return levels;

  } catch (err) {
    logger.warn(`[Ticket] Gagal ambil approval levels tiket ${requestId}: ${err.message}`);
    return [];
  }
}

/**
 * Ambil daftar approvals dalam satu level untuk sebuah tiket.
 * Endpoint: GET /api/v3/requests/{requestId}/approval_levels/{levelId}/approvals
 *
 * Diperlukan karena endpoint parent (approval_levels) tidak menyertakan
 * array approvals secara langsung dalam respons-nya.
 *
 * @param {string} requestId - ID tiket ManageEngine
 * @param {string|number} levelId - ID level approval
 * @returns {Promise<Array>} - Array approvals, atau [] jika gagal
 */
async function getApprovalsByLevel(requestId, levelId) {
  try {
    const endpoint = `${ENDPOINT_REQUESTS_BASE}/${requestId}/approval_levels/${levelId}/approvals`;
    logger.info(`[Ticket] Mengambil approvals level ${levelId} — GET ${endpoint}`);

    const response = await axios.get(endpoint, {
      headers: AUTH_HEADERS,
      timeout: 15000
    });

    const approvals = response.data?.approvals || [];
    logger.info(`[Ticket] ${approvals.length} approval ditemukan di level ${levelId} tiket ${requestId}`);
    return approvals;

  } catch (err) {
    logger.warn(`[Ticket] Gagal ambil approvals level ${levelId} tiket ${requestId}: ${err.message}`);
    return [];
  }
}

/**
 * Setujui (approve) sebuah tiket di ManageEngine.
 * Endpoint: PUT /api/v3/requests/{requestId}/approval_levels/{levelNumber}/approvals/{approvalId}/_approve
 *
 * @param {string} requestId   - ID tiket
 * @param {string} levelNumber - Nomor level approval
 * @param {string} approvalId  - ID approval
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function approveTicket(requestId, levelNumber, approvalId) {
  try {
    const endpoint =
      `${ENDPOINT_REQUESTS_BASE}/${requestId}/approval_levels/${levelNumber}/approvals/${approvalId}/_approve`;
    logger.info(`[Ticket] APPROVE tiket ${requestId} — PUT ${endpoint}`);

    // Body sesuai spec Postman collection ManageEngine:
    // Content-Type: application/x-www-form-urlencoded
    // input_data: {"approval":{"comments":"..."}}
    const params = new URLSearchParams();
    params.append('input_data', JSON.stringify({ approval: { comments: 'Approved via WhatsApp Bot' } }));

    await axios.put(endpoint, params, {
      headers: {
        ...ADMIN_AUTH_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 15000
    });

    logger.info(`[Ticket] ✓ Tiket ${requestId} berhasil di-APPROVE`);
    return { success: true };

  } catch (err) {
    logger.error(`[Ticket] Gagal approve tiket ${requestId}: ${err.message}`);
    const detail = err.response?.data?.response_status?.messages?.[0]?.message
      || err.message
      || 'Error tidak diketahui';
    return { success: false, error: detail };
  }
}

/**
 * Tolak (reject) sebuah tiket di ManageEngine.
 * Endpoint: PUT /api/v3/requests/{requestId}/approval_levels/{levelNumber}/approvals/{approvalId}/_reject
 *
 * @param {string} requestId   - ID tiket
 * @param {string} levelNumber - Nomor level approval
 * @param {string} approvalId  - ID approval
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function rejectTicket(requestId, levelNumber, approvalId) {
  try {
    const endpoint =
      `${ENDPOINT_REQUESTS_BASE}/${requestId}/approval_levels/${levelNumber}/approvals/${approvalId}/_reject`;
    logger.info(`[Ticket] REJECT tiket ${requestId} — PUT ${endpoint}`);

    // Body sesuai spec Postman collection ManageEngine:
    // Content-Type: application/x-www-form-urlencoded
    // input_data: {"approval":{"comments":"..."}}
    const params = new URLSearchParams();
    params.append('input_data', JSON.stringify({ approval: { comments: 'Rejected via WhatsApp Bot' } }));

    await axios.put(endpoint, params, {
      headers: {
        ...ADMIN_AUTH_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 15000
    });

    logger.info(`[Ticket] ✓ Tiket ${requestId} berhasil di-REJECT`);
    return { success: true };

  } catch (err) {
    logger.error(`[Ticket] Gagal reject tiket ${requestId}: ${err.message}`);
    const detail = err.response?.data?.response_status?.messages?.[0]?.message
      || err.message
      || 'Error tidak diketahui';
    return { success: false, error: detail };
  }
}

/**
 * Buat approval level baru pada sebuah tiket di ManageEngine.
 * Dipanggil SEKALI setelah tiket AUTORISASI berhasil dibuat via API,
 * agar workflow approval aktif tanpa harus Admin menekan "Send Notification" secara manual.
 *
 * Strategi autentikasi (retry otomatis):
 *   1. Coba dengan ADMIN_KEY dulu
 *   2. Jika gagal (permission/read-only), retry dengan TECHNICIAN_KEY
 *
 * Endpoint: POST /api/v3/requests/{requestId}/approval_levels
 *
 * @param {string} requestId - ID tiket ManageEngine
 * @returns {Promise<{ success: boolean, levelId?: string, error?: string }>}
 */
async function createApprovalLevel(requestId) {
  const endpoint = `${ENDPOINT_REQUESTS_BASE}/${requestId}/approval_levels`;

  // Payload tanpa field 'level' — ManageEngine auto-assign nomor level
  // (field 'level' dianggap read-only oleh ME dan menyebabkan error jika diisi)
  const params = new URLSearchParams();
  params.append('input_data', JSON.stringify({ approval_level: {} }));

  const attempts = [
    { label: 'ADMIN_KEY',      headers: { ...ADMIN_AUTH_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' } },
    { label: 'TECHNICIAN_KEY', headers: { ...AUTH_HEADERS,       'Content-Type': 'application/x-www-form-urlencoded' } }
  ];

  for (const attempt of attempts) {
    try {
      logger.info(`[Ticket] Membuat approval level — POST ${endpoint} (auth: ${attempt.label})`);
      const response = await axios.post(endpoint, params, { headers: attempt.headers, timeout: 15000 });

      const levelId = String(
        response.data?.approval_level?.id ||
        response.data?.id ||
        ''
      ).trim();

      if (!levelId) {
        logger.warn(
          `[Ticket] Approval level dibuat (${attempt.label}) tapi ID tidak ada — ` +
          `tiket ${requestId}, respons: ${JSON.stringify(response.data).substring(0, 200)}`
        );
        return { success: false, error: 'Level ID tidak ditemukan di respons ManageEngine' };
      }

      logger.info(`[Ticket] ✓ Approval level berhasil dibuat (${attempt.label}) — tiket ${requestId}, levelId: ${levelId}`);
      return { success: true, levelId };

    } catch (err) {
      const detail = err.response?.data?.response_status?.messages?.[0]?.message
        || err.message
        || 'Error tidak diketahui';
      logger.warn(`[Ticket] Gagal buat approval level tiket ${requestId} via ${attempt.label}: ${detail}`);
      // Lanjut ke attempt berikutnya (TECHNICIAN_KEY)
    }
  }

  return { success: false, error: 'Semua percobaan gagal membuat approval level' };
}

/**
 * Tambahkan approver (atasan) ke dalam approval level yang sudah ada.
 * Dipanggil segera setelah createApprovalLevel() berhasil.
 *
 * Strategi autentikasi (retry otomatis):
 *   1. Coba dengan ADMIN_KEY dulu
 *   2. Jika gagal (permission/read-only), retry dengan TECHNICIAN_KEY
 *
 * Endpoint: POST /api/v3/requests/{requestId}/approval_levels/{levelId}/approvals
 *
 * @param {string} requestId      - ID tiket ManageEngine
 * @param {string} levelId        - ID approval level (dari createApprovalLevel)
 * @param {string} supervisorMeId - ManageEngine user ID atasan (dari reporting_to.id)
 * @returns {Promise<{ success: boolean, approvalId?: string, error?: string }>}
 */
async function addApproverToLevel(requestId, levelId, supervisorMeId) {
  const endpoint = `${ENDPOINT_REQUESTS_BASE}/${requestId}/approval_levels/${levelId}/approvals`;

  const params = new URLSearchParams();
  params.append('input_data', JSON.stringify({
    approval: { approver: { id: String(supervisorMeId) } }
  }));

  const attempts = [
    { label: 'ADMIN_KEY',      headers: { ...ADMIN_AUTH_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' } },
    { label: 'TECHNICIAN_KEY', headers: { ...AUTH_HEADERS,       'Content-Type': 'application/x-www-form-urlencoded' } }
  ];

  for (const attempt of attempts) {
    try {
      logger.info(
        `[Ticket] Menambahkan approver ME ID=${supervisorMeId} ke level ${levelId} — ` +
        `POST ${endpoint} (auth: ${attempt.label})`
      );
      const response = await axios.post(endpoint, params, { headers: attempt.headers, timeout: 15000 });

      const approvalId = String(
        response.data?.approval?.id ||
        response.data?.id ||
        ''
      ).trim();

      if (!approvalId) {
        logger.warn(
          `[Ticket] Approver ditambahkan (${attempt.label}) tapi approval ID tidak ada — ` +
          `tiket ${requestId}, respons: ${JSON.stringify(response.data).substring(0, 200)}`
        );
        return { success: false, error: 'Approval ID tidak ditemukan di respons ManageEngine' };
      }

      logger.info(
        `[Ticket] ✓ Approver berhasil ditambahkan (${attempt.label}) — ` +
        `tiket ${requestId}, levelId: ${levelId}, approvalId: ${approvalId}`
      );
      return { success: true, approvalId };

    } catch (err) {
      const detail = err.response?.data?.response_status?.messages?.[0]?.message
        || err.message
        || 'Error tidak diketahui';
      logger.warn(`[Ticket] Gagal tambah approver tiket ${requestId} via ${attempt.label}: ${detail}`);
      // Lanjut ke attempt berikutnya (TECHNICIAN_KEY)
    }
  }

  return { success: false, error: 'Semua percobaan gagal menambahkan approver' };
}

/**
 * Helper: Tangani error Axios secara terstruktur
 */
function _handleAxiosError(prefix, err) {
  if (err.response) {
    const status = err.response.status;
    const detail = err.response.data?.response_status?.messages?.[0]?.message
      || err.response.data?.message
      || JSON.stringify(err.response.data)?.substring(0, 200)
      || 'Unknown error';
    logger.error(`${prefix} — HTTP ${status}: ${detail}`);
    return {
      success: false,
      found: false,
      message: `Server ManageEngine merespons dengan error ${status}: ${detail}`
    };
  } else if (err.code === 'ECONNABORTED') {
    logger.error(`${prefix} — Timeout (30 detik)`);
    return {
      success: false,
      found: false,
      message: 'Server ManageEngine tidak merespons (timeout). Silakan hubungi Tim IT secara langsung.'
    };
  } else if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
    logger.error(`${prefix} — Tidak dapat terhubung: ${err.message}`);
    return {
      success: false,
      found: false,
      message: 'Tidak dapat terhubung ke server ManageEngine. Silakan hubungi Tim IT secara langsung.'
    };
  } else {
    logger.error(`${prefix} — Error tidak terduga: ${err.message}`);
    return {
      success: false,
      found: false,
      message: 'Terjadi kesalahan tak terduga. Silakan hubungi Tim IT secara langsung.'
    };
  }
}

/**
 * Upload Attachment ke ManageEngine ServiceDesk Plus.
 *
 * Alur sesuai Postman Collection On-Premise (Add and associate attachment):
 *   PUT /api/v3/requests/:request_id/upload
 *   — Upload file DAN asosiasikan langsung ke tiket dalam satu request.
 *
 * Content-Type: multipart/form-data (set otomatis oleh form-data library)
 * Field       : input_file (type: file)
 * Headers     : TECHNICIAN_KEY, PORTALID, Accept
 *               (TANPA Content-Type manual — biarkan form-data set boundary)
 *
 * Response    : { attachment: { id, name, content_type, ... }, response_status: { status_code: 2000 } }
 *
/**
 * Mengunggah satu atau beberapa foto/dokumen ke tiket (add and associate).
 *
 * @param {string} requestId - ID tiket ManageEngine
 * @param {object|object[]} mediaList - Objek { data, mimetype, filename } atau array of objek tersebut
 * @returns {Promise<{ success: boolean, uploaded: number, failed: number, errors: string[] }>}
 */
async function uploadAttachments(requestId, mediaList) {
  if (!Array.isArray(mediaList)) {
    mediaList = [mediaList];
  }

  const result = { success: false, uploaded: 0, failed: 0, errors: [] };
  const FormData = require('form-data');

  for (let i = 0; i < mediaList.length; i++) {
    const media = mediaList[i];
    if (!media || !media.data) continue;

    try {
      const form = new FormData();

      // Convert base64 media ke Buffer
      const buffer = Buffer.from(media.data, 'base64');
      const ext = (media.mimetype || 'image/jpeg').split('/')[1] || 'jpeg';
      const filename = media.filename || `foto_tiket_${Date.now()}_${i}.${ext}`;

      // Field 'input_file' sesuai Postman Collection ManageEngine
      form.append('input_file', buffer, {
        filename,
        contentType: media.mimetype || 'image/jpeg'
      });

      // Satu langkah: Upload DAN asosiasikan ke tiket via PUT /api/v3/requests/:requestId/upload
      const uploadEndpoint = `${ENDPOINT_REQUESTS_BASE}/${requestId}/upload`;
      logger.info(`[Ticket] Mengunggah foto ke-${i+1} ke tiket ${requestId} — PUT ${uploadEndpoint}`);

      const uploadResponse = await axios.put(uploadEndpoint, form, {
        headers: {
          'TECHNICIAN_KEY': TECHNICIAN_KEY,
          'PORTALID': PORTAL_ID,
          'Accept': 'application/vnd.manageengine.sdp.v3+json',
          ...form.getHeaders()  // set multipart boundary otomatis (TANPA Content-Type manual)
        },
        timeout: 30000,
        maxContentLength: 10 * 1024 * 1024  // maks 10MB untuk response buffer
      });

      const attachment    = uploadResponse.data?.attachment || null;
      const attachmentId  = attachment?.id || null;
      const statusCode    = uploadResponse.data?.response_status?.status_code;

      if (!attachmentId || statusCode !== 2000) {
        logger.warn(
          `[Ticket] Upload foto ke-${i+1} gagal atau attachment ID tidak tersedia — ` +
          `tiket: ${requestId}, status: ${statusCode}, ` +
          `respons: ${JSON.stringify(uploadResponse.data).substring(0, 200)}`
        );
        result.failed++;
        result.errors.push(`Gagal upload foto ke-${i+1}`);
      } else {
        logger.info(
          `[Ticket] ✓ Foto ke-${i+1} berhasil diunggah dan ditautkan ke tiket ${requestId} — ` +
          `attachment ID: ${attachmentId}, nama: ${attachment.name || filename}`
        );
        result.uploaded++;
      }

    } catch (error) {
      logger.error(`[Ticket] Error upload foto ke-${i+1} ke tiket ${requestId}: ${error.message}`);
      result.failed++;
      result.errors.push(error.message);
    }
  }

  result.success = result.uploaded > 0;
  return result;
}


/**
 * Mengambil daftar attachment pada tiket.
 * Sesuai Postman: GET /api/v3/requests/:request_id/attachments
 * Response: { attachments: [{ id, name, content_type, content_url, size }] }
 * @param {string} requestId - ID tiket
 */
async function getTicketAttachments(requestId) {
  try {
    const endpoint = `${ENDPOINT_REQUESTS_BASE}/${requestId}/attachments`;
    logger.info(`[Ticket] Mengambil list attachment tiket ${requestId} — GET ${endpoint}`);
    const response = await axios.get(endpoint, {
      headers: {
        'TECHNICIAN_KEY': TECHNICIAN_KEY,
        'PORTALID': PORTAL_ID,
        'Accept': 'application/vnd.manageengine.sdp.v3+json'
      },
      timeout: 15000
    });
    const list = response.data?.attachments || [];
    logger.info(`[Ticket] Attachment tiket ${requestId}: ${list.length} file ditemukan`);
    return list;
  } catch (error) {
    logger.warn(`[Ticket] Gagal mengambil list attachment untuk tiket ${requestId}: ${error.message}`);
    return [];
  }
}

/**
 * Mengunduh attachment tiket sebagai base64.
 * Sesuai Postman: GET /api/v3/requests/:request_id/attachments/:attachment_id/download
 * @param {string} requestId     - ID tiket
 * @param {string} attachmentId  - ID attachment
 * @param {string} contentType   - mime type (opsional, fallback dari list)
 */
async function downloadTicketAttachment(requestId, attachmentId, contentType = null) {
  try {
    const endpoint = `${ENDPOINT_REQUESTS_BASE}/${requestId}/attachments/${attachmentId}/download`;
    logger.info(`[Ticket] Mendownload attachment ${attachmentId} dari tiket ${requestId} — GET ${endpoint}`);
    const response = await axios.get(endpoint, {
      headers: {
        'TECHNICIAN_KEY': TECHNICIAN_KEY,
        'PORTALID': PORTAL_ID,
        'Accept': '*/*'
      },
      responseType: 'arraybuffer',
      timeout: 30000,
      maxRedirects: 5,           // ikuti redirect jika ada
      maxContentLength: 20 * 1024 * 1024  // batas 20MB
    });

    if (!response.data || response.data.byteLength === 0) {
      logger.warn(`[Ticket] Attachment ${attachmentId} — response kosong`);
      return null;
    }

    // Prioritaskan content-type dari header respons, fallback ke parameter, lalu default
    const mime = response.headers['content-type']
      || contentType
      || 'application/octet-stream';

    logger.info(`[Ticket] ✓ Attachment ${attachmentId} didownload — ${response.data.byteLength} bytes, mime: ${mime}`);
    return {
      data: Buffer.from(response.data).toString('base64'),
      content_type: mime.split(';')[0].trim()  // hapus bagian "; charset=..." jika ada
    };
  } catch (error) {
    logger.warn(`[Ticket] Gagal mendownload attachment ${attachmentId} tiket ${requestId}: ${error.message}`);
    return null;
  }
}

module.exports = {
  submitToEndpoint,
  lookupUserByEmail,
  getTicketDetail,
  getTicketNotifications,
  getUserById,
  getApprovalLevels,
  getApprovalsByLevel,
  approveTicket,
  rejectTicket,
  createApprovalLevel,
  addApproverToLevel,
  uploadAttachments,
  getTicketAttachments,
  downloadTicketAttachment
};
