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
    requester:         'ahmad.fauzi@plnbatam.com',
    nama_aplikasi:     'SIMKEU',
    keluhan:           'Printer di ruangan IT tidak mau menarik kertas sejak pagi',
    alasan:            'Akses dari rumah karena sedang WFH dan butuh server intranet'
  };

  const exampleLines = config.fields.map((key, i) => {
    return `${i + 1}. ${exampleMap[key] || '-'}`;
  });

  return (
    `Silakan isi data berikut dalam *satu pesan* dengan format:\n\n` +
    fieldLines.join('\n') + '\n\n' +
    `*Contoh balasan:*\n` +
    exampleLines.join('\n')
  );
}

/**
 * Helper: Parse balasan user yang berformat numbered list
 *
 * Mendukung variasi format:
 *   "1. value"   "1) value"   "1: value"   "1- value"
 *
 * @param {string} text          - Teks input user
 * @param {number} expectedCount - Jumlah field yang diharapkan
 * @returns {string[]|null}      - Array nilai (index 0..n-1), atau null jika
 *                                 format tidak dikenali / ada field kosong
 */
function parseNumberedList(text, expectedCount) {
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

  // Pastikan semua field tersedia
  const result = [];
  for (let i = 0; i < expectedCount; i++) {
    if (!entries[i] || !entries[i].trim()) return null;
    result.push(entries[i].trim());
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
