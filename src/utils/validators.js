/**
 * ═══════════════════════════════════════════════════════════════
 * VALIDATORS & PROMPTS — IT Help Desk Bot PLN Batam
 * ═══════════════════════════════════════════════════════════════
 *
 * Menyediakan tiga fungsi utama:
 *   - buildAllFieldsPrompt() : Buat prompt semua field sekaligus (numbered list)
 *   - parseNumberedList()    : Parse balasan user berformat "1. ... 2. ..."
 *   - validateField()        : Validasi nilai per field
 */

/**
 * Helper: Bangun prompt semua field dalam satu pesan (format numbered list)
 * @param {object} config - CATEGORY_CONFIG entry
 * @returns {string}
 */
function buildAllFieldsPrompt(config) {
  const fieldLines = config.fields.map((key, i) => {
    const label = config.fieldLabels[key];
    const hint = config.fieldHints ? config.fieldHints[key] : '';
    return `${i + 1}. *${label}*${hint ? `\n   _${hint}_` : ''}`;
  });

  // Contoh generik per tipe field
  const exampleMap = {
    requester: 'ahmad.fauzi@plnbatam.com',
    nama_aplikasi: 'SIMKEU',
    username_aplikasi: 'User123',
    keluhan: 'Printer di ruangan IT tidak mau menarik kertas sejak pagi',
    alasan: 'Akses dari rumah karena sedang WFH dan butuh server intranet'
  };

  return (
    `Silakan isi data berikut dalam *satu pesan* dengan format:\n\n` +
    fieldLines.join('\n') +
    `\n\nDapat mengupload media foto (png/jpg Maks. 5).`
  );
}

/**
 * Helper: Parse balasan user yang berformat numbered list
 *
 * Mendukung variasi format:
 *   "1. value"   "1) value"   "1: value"   "1- value"
 *
 * @param {string}  text          - Teks input user
 * @param {number}  expectedCount - Jumlah field yang diharapkan
 * @param {Set}     nullableIndices - Indeks field yang boleh kosong (opsional)
 * @returns {string[]|null}      - Array nilai (index 0..n-1), atau null jika
 *                                 format tidak dikenali / field wajib kosong
 */
function parseNumberedList(text, expectedCount, nullableIndices = new Set()) {
  const entries = {};
  const lines = text.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Cocokkan: angka diikuti tanda baca, lalu isi field
    const match = trimmed.match(/^(\d+)[.):\-]\s*(.+)/);
    if (match) {
      const idx = parseInt(match[1], 10) - 1;
      if (idx >= 0 && idx < expectedCount && entries[idx] === undefined) {
        entries[idx] = match[2].trim();
      }
    }
  }

  // Pastikan semua field tersedia — field nullable boleh kosong
  const result = [];
  for (let i = 0; i < expectedCount; i++) {
    const val = entries[i];
    if (!val || !val.trim()) {
      if (nullableIndices.has(i)) {
        result.push('');   // field opsional — boleh kosong
      } else {
        return null;       // field wajib — gagal parse
      }
    } else {
      result.push(val.trim());
    }
  }

  return result;
}

/**
 * Helper: Validasi nilai per field
 * @param {string} fieldKey - Key field
 * @param {string} value    - Nilai yang dimasukkan user
 * @returns {{ valid: boolean, message?: string }}
 */
function validateField(fieldKey, value) {
  const trimmed = (value || '').trim();

  if (!trimmed || trimmed.length < 2) {
    return { valid: false, message: 'Tidak boleh kosong dan minimal 2 karakter.' };
  }

  if (fieldKey === 'nama_aplikasi') {
    if (trimmed.length > 100) {
      return { valid: false, message: 'Nama aplikasi terlalu panjang (maks 100 karakter).' };
    }
  }

  if (fieldKey === 'username_aplikasi') {
    if (trimmed.length > 100) {
      return { valid: false, message: 'Username aplikasi terlalu panjang (maks 100 karakter).' };
    }
  }

  // role_assign, role_hapus, tgl_awal, tgl_akhir bersifat opsional — jika kosong atau "-", selalu valid
  if (fieldKey === 'role_assign' || fieldKey === 'role_hapus' || fieldKey === 'tgl_awal' || fieldKey === 'tgl_akhir') {
    if (!trimmed || trimmed === '-') return { valid: true };
    if (trimmed.length > 500) {
      return { valid: false, message: 'Terlalu panjang (maks 500 karakter).' };
    }
    return { valid: true };
  }

  if (fieldKey === 'alasan_otorisasi') {
    if (trimmed.length < 5) {
      return { valid: false, message: 'Alasan terlalu singkat (min. 5 karakter).' };
    }
    if (trimmed.length > 1000) {
      return { valid: false, message: 'Alasan terlalu panjang (maks 1000 karakter).' };
    }
  }

  if (fieldKey === 'keluhan' || fieldKey === 'alasan') {
    if (trimmed.length < 10) {
      return { valid: false, message: 'Penjelasan terlalu singkat. Mohon jelaskan lebih detail (min. 10 karakter).' };
    }
  }

  if (fieldKey === 'requester') {
    // Validasi HANYA domain @plnbatam.com
    if (!/^[^\s@]+@plnbatam\.com$/i.test(trimmed)) {
      return { valid: false, message: 'Harus menggunakan email resmi PLN Batam (@plnbatam.com)' };
    }
  }

  return { valid: true };
}

module.exports = { buildAllFieldsPrompt, parseNumberedList, validateField };
