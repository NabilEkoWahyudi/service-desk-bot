/**
 * ---------------------------------------------------------------
 * ENDPOINT CONFIGURATION - IT Help Desk Bot PLN Batam
 * ---------------------------------------------------------------
 *
 * Konfigurasi URL endpoint ManageEngine ServiceDesk Plus dan
 * struktur field per kategori request.
 *
 * Autentikasi ManageEngine: TECHNICIAN_KEY header
 * Format body: application/x-www-form-urlencoded (input_data=<JSON>)
 *
 * Endpoint Users:
 *   GET /api/v3/users?input_data=<JSON>  - Lookup data pegawai berdasarkan email
 * Endpoint Requests:
 *   POST /api/v3/requests               - Buat tiket baru
 *   GET  /api/v3/requests/:id           - Ambil detail tiket resmi
 */

const CATEGORY_CONFIG = {
  PASSWORD: {
    label: 'Permintaan Reset Password',
    endpoint: process.env.ENDPOINT_PASSWORD || 'https://servicedesk.plnbatam.com:8080/api/v3/requests',
    autoSubject: 'Permintaan Reset Password',
    fields: ['requester', 'nama_aplikasi', 'username_aplikasi'],
    fieldLabels: {
      requester: 'Email Kantor',
      nama_aplikasi: 'Nama Aplikasi',
      username_aplikasi: 'Username Aplikasi'
    },
    fieldHints: {
      requester: 'Contoh: nama.anda@plnbatam.com',
      nama_aplikasi: 'Contoh: SIMKEU, SAP, Aplikasi Email',
      username_aplikasi: 'Contoh: User123, ahmad.fauzi'
    }
  },
  AUTORISASI: {
    label: 'Pembuatan atau Perubahan Otorisasi Aplikasi',
    endpoint: process.env.ENDPOINT_AUTORISASI || 'https://servicedesk.plnbatam.com:8080/api/v3/requests',
    // ID Template "Formulir Permintaan Get Approvals" (ID: 2404).
    // Template ini mengaktifkan approval flow $REPORTING_TOS secara otomatis di ManageEngine.
    // Menggunakan ID lebih aman daripada nama - nama bisa berubah, ID tidak.
    templateId: process.env.ME_TEMPLATE_AUTORISASI || '2404',
    // ID Template "(Tanpa Approval) Pembuatan atau Perubahan Otorisasi" (ID: 2408).
    // Digunakan KHUSUS untuk atasan (Senior/ASMAN+) - template ini tidak memiliki approval level,
    // sehingga tiket langsung masuk ke antrian teknisi tanpa perlu persetujuan siapapun.
    // Menggantikan pendekatan auto-approve via API yang selalu gagal.
    seniorTemplateId: process.env.ME_TEMPLATE_AUTORISASI_SENIOR || '2408',
    autoSubject: 'Pembuatan atau Perubahan Otorisasi Aplikasi',
    fields: ['requester', 'nama_aplikasi', 'username_aplikasi', 'role_assign', 'role_hapus', 'alasan_otorisasi'],
    fieldLabels: {
      requester:         'Email Kantor',
      nama_aplikasi:     'Nama Aplikasi',
      username_aplikasi: 'Username Aplikasi',
      role_assign:       'Role yang Di-assign ke User',
      role_hapus:        'Role yang Dihapus dari User',
      alasan_otorisasi:  'Alasan Pembuatan/Perubahan Otorisasi'
    },
    fieldHints: {
      requester:         'Contoh: nama.anda@plnbatam.com',
      nama_aplikasi:     'Contoh: SIMKEU, SAP, Modul Keuangan',
      username_aplikasi: 'Contoh: User123, ahmad.fauzi',
      role_assign:       'Opsional - ketik - jika tidak ada',
      role_hapus:        'Opsional - ketik - jika tidak ada',
      alasan_otorisasi:  'Jelaskan alasan pembuatan atau perubahan otorisasi'
    },
    // Field opsional - boleh diisi "-" atau dikosongkan
    nullableFields: ['role_assign', 'role_hapus']
  },
  KELUHAN: {
    label: 'Permintaan/Keluhan',
    endpoint: process.env.ENDPOINT_KELUHAN || 'https://servicedesk.plnbatam.com:8080/api/v3/requests',
    autoSubject: 'Permintaan/Keluhan',
    fields: ['requester', 'nama_aplikasi', 'username_aplikasi', 'keluhan'],
    fieldLabels: {
      requester: 'Email Kantor',
      nama_aplikasi: 'Nama Aplikasi',
      username_aplikasi: 'Username Aplikasi',
      keluhan: 'Keluhan yang Dialami'
    },
    fieldHints: {
      requester: 'Contoh: nama.anda@plnbatam.com',
      nama_aplikasi: 'Contoh: SIMKEU, SAP, Aplikasi Email',
      username_aplikasi: 'Contoh: User123, ahmad.fauzi',
      keluhan: 'Jelaskan detail masalah yang Anda alami'
    }
  },
  VPN: {
    label: 'Akses VPN',
    endpoint: process.env.ENDPOINT_VPN || 'https://servicedesk.plnbatam.com:8080/api/v3/requests',
    autoSubject: 'Akses VPN',
    fields: ['requester', 'alasan', 'tgl_awal', 'tgl_akhir'],
    fieldLabels: {
      requester: 'Email Kantor',
      alasan:    'Alasan Akses VPN',
      tgl_awal:  'Tanggal Awal Akses VPN',
      tgl_akhir: 'Tanggal Akhir Akses VPN'
    },
    fieldHints: {
      requester: 'Contoh: nama.anda@plnbatam.com',
      alasan:    'Jelaskan alasan atau tujuan pengajuan VPN',
      tgl_awal:  'Contoh: 21 November 2026 atau ketik -',
      tgl_akhir: 'Contoh: 25 November 2026 atau ketik -'
    },
    nullableFields: ['tgl_awal', 'tgl_akhir']
  },
};


/** Technician Key untuk autentikasi ke ManageEngine ServiceDesk Plus */
const TECHNICIAN_KEY = process.env.TECHNICIAN_KEY || '';

/**
 * Base URL ManageEngine ServiceDesk Plus
 * Digunakan sebagai prefix untuk semua endpoint API
 */
// Port 8080 adalah port default ManageEngine ServiceDesk Plus On-Premise.
// Samakan dengan default endpoint per kategori agar tidak ada inkonsistensi saat .env kosong.
const ME_BASE_URL = process.env.ME_BASE_URL || 'https://servicedesk.plnbatam.com:8080';

/**
 * Endpoint untuk mengambil data user/pegawai dari ManageEngine
 * Method : GET
 * Params : input_data (JSON dengan list_info.search_fields.email_id)
 */
const ENDPOINT_USERS = process.env.ENDPOINT_USERS || `${ME_BASE_URL}/api/v3/users`;

/**
 * Base endpoint untuk requests (tambah /:id untuk GET detail tiket)
 * Method POST : Buat tiket baru
 * Method GET  : GET /api/v3/requests/:id - ambil detail tiket resmi
 */
const ENDPOINT_REQUESTS_BASE = `${ME_BASE_URL}/api/v3/requests`;

/**
 * [BUG-2 FIX] ID field ManageEngine yang sebelumnya hardcoded.
 * Sekarang dapat dikonfigurasi via .env tanpa edit kode.
 *
 * Cara cek ID yang benar di ManageEngine:
 *   Admin -> Service Desk -> Groups        -> catat ID di URL saat klik nama group
 *   Admin -> Service Desk -> Levels        -> ID "Tier 2 - Request"
 *   Admin -> Service Desk -> Service Items -> ID "Manajemen User"
 *
 * Default (sesuai konfigurasi PLN Batam saat ini):
 *   ME_GROUP_ID            = '4'   -> Group "Aplikasi"
 *   ME_LEVEL_ID            = '2'   -> Level "Tier 2 - Request"
 *   ME_SERVICE_CATEGORY_ID = '8'   -> Service Category "Manajemen User"
 */
const ME_GROUP_ID            = process.env.ME_GROUP_ID            || '4';
const ME_LEVEL_ID            = process.env.ME_LEVEL_ID            || '2';
const ME_SERVICE_CATEGORY_ID = process.env.ME_SERVICE_CATEGORY_ID || '8';

/**
 * ID Template "Formulir Permintaan Get Approvals" untuk kategori AUTORISASI (user biasa).
 * Digunakan saat POST tiket agar approval flow $REPORTING_TOS aktif di ManageEngine.
 * Nilai bisa dikonfigurasi via .env (ME_TEMPLATE_AUTORISASI).
 */
const ME_TEMPLATE_AUTORISASI = process.env.ME_TEMPLATE_AUTORISASI || '2404';

/**
 * ID Template "(Tanpa Approval) Pembuatan atau Perubahan Otorisasi" untuk atasan (Senior/ASMAN+).
 * Template ini tidak memiliki approval level - tiket langsung masuk ke teknisi.
 * Menggantikan pendekatan auto-approve via API yang tidak reliabel.
 * Nilai bisa dikonfigurasi via .env (ME_TEMPLATE_AUTORISASI_SENIOR).
 */
const ME_TEMPLATE_AUTORISASI_SENIOR = process.env.ME_TEMPLATE_AUTORISASI_SENIOR || '2408';

module.exports = {
  CATEGORY_CONFIG,
  TECHNICIAN_KEY,
  ME_BASE_URL,
  ENDPOINT_USERS,
  ENDPOINT_REQUESTS_BASE,
  ME_GROUP_ID,
  ME_LEVEL_ID,
  ME_SERVICE_CATEGORY_ID,
  ME_TEMPLATE_AUTORISASI,
  ME_TEMPLATE_AUTORISASI_SENIOR
};
