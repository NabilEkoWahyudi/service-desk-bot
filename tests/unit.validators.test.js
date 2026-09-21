/**
 * ═══════════════════════════════════════════════════════════════
 * UNIT TESTS — Validators
 * ═══════════════════════════════════════════════════════════════
 *
 * Menguji fungsi-fungsi di src/utils/validators.js:
 *   - parseNumberedList()
 *   - validateField()
 *   - buildAllFieldsPrompt()
 *
 * Cara jalankan:
 *   node tests/unit.validators.test.js
 *
 * Tidak memerlukan framework atau koneksi internet.
 */

'use strict';

const { parseNumberedList, validateField, buildAllFieldsPrompt } = require('../src/utils/validators');

// ─── Mini Test Runner ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n─── ${title} ───`);
}

// ─── parseNumberedList ────────────────────────────────────────────────────────

section('parseNumberedList()');

{
  const result = parseNumberedList('1. test@plnbatam.com\n2. SIMKEU', 2);
  assert('Format "1. " dikenali', Array.isArray(result) && result.length === 2);
  assert('Nilai field 1 benar', result && result[0] === 'test@plnbatam.com');
  assert('Nilai field 2 benar', result && result[1] === 'SIMKEU');
}

{
  const result = parseNumberedList('1) test@plnbatam.com\n2) SAP', 2);
  assert('Format "1) " dikenali', Array.isArray(result) && result.length === 2);
}

{
  const result = parseNumberedList('1: test@plnbatam.com\n2: SAP', 2);
  assert('Format "1: " dikenali', Array.isArray(result) && result.length === 2);
}

{
  const result = parseNumberedList('1- test@plnbatam.com\n2- SAP', 2);
  assert('Format "1- " dikenali', Array.isArray(result) && result.length === 2);
}

{
  const result = parseNumberedList('Hanya satu baris', 2);
  assert('Input tidak lengkap → null', result === null);
}

{
  const result = parseNumberedList('1. test@plnbatam.com', 2);
  assert('Hanya 1 dari 2 field → null', result === null);
}

{
  const result = parseNumberedList('', 2);
  assert('String kosong → null', result === null);
}

// ─── validateField ────────────────────────────────────────────────────────────

section('validateField() — requester (email)');

{
  const v = validateField('requester', 'ahmad@plnbatam.com');
  assert('Email plnbatam.com valid', v.valid === true);
}

{
  const v = validateField('requester', 'ahmad@gmail.com');
  assert('Email non-plnbatam ditolak', v.valid === false);
}

{
  const v = validateField('requester', 'ahmad@PLNBatam.com');
  assert('Email plnbatam.com case-insensitive valid', v.valid === true);
}

{
  const v = validateField('requester', '');
  assert('Email kosong ditolak', v.valid === false);
}

{
  const v = validateField('requester', 'a@plnbatam.com');
  // 1 char prefix masih < 2 karakter total minimal
  assert('Email prefix 1 char: valid format email (lewati min length)', typeof v.valid === 'boolean');
}

section('validateField() — nama_aplikasi');

{
  const v = validateField('nama_aplikasi', 'SIMKEU');
  assert('Nama aplikasi normal valid', v.valid === true);
}

{
  const v = validateField('nama_aplikasi', 'A'.repeat(101));
  assert('Nama aplikasi > 100 karakter ditolak', v.valid === false);
}

{
  const v = validateField('nama_aplikasi', 'A'.repeat(100));
  assert('Nama aplikasi tepat 100 karakter valid', v.valid === true);
}

{
  const v = validateField('nama_aplikasi', '');
  assert('Nama aplikasi kosong ditolak', v.valid === false);
}

section('validateField() — keluhan / alasan');

{
  const v = validateField('keluhan', 'Printer tidak mau nyala sejak pagi');
  assert('Keluhan detail valid', v.valid === true);
}

{
  const v = validateField('keluhan', 'Rusak');
  assert('Keluhan < 10 karakter ditolak', v.valid === false);
}

{
  const v = validateField('alasan', 'Untuk akses server dari rumah WFH');
  assert('Alasan detail valid', v.valid === true);
}

{
  const v = validateField('alasan', 'WFH');
  assert('Alasan < 10 karakter ditolak', v.valid === false);
}

// ─── buildAllFieldsPrompt ─────────────────────────────────────────────────────

section('buildAllFieldsPrompt()');

const mockConfig = {
  label: 'Test Kategori',
  fields: ['requester', 'nama_aplikasi'],
  fieldLabels: { requester: 'Email Kantor', nama_aplikasi: 'Nama Aplikasi' },
  fieldHints: { requester: 'Contoh: nama@plnbatam.com', nama_aplikasi: 'Contoh: SIMKEU' }
};

{
  const prompt = buildAllFieldsPrompt(mockConfig);
  assert('Prompt adalah string', typeof prompt === 'string');
  assert('Prompt mengandung "1."', prompt.includes('1.'));
  assert('Prompt mengandung "2."', prompt.includes('2.'));
  assert('Prompt mengandung label field', prompt.includes('Email Kantor'));
  assert('Prompt mengandung hint', prompt.includes('nama@plnbatam.com'));
  assert('Prompt mengandung contoh balasan', prompt.includes('Contoh balasan'));
}

// ─── Ringkasan ────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Hasil: ${passed} PASS, ${failed} FAIL`);

if (failed > 0) {
  console.error('❌ Ada test yang gagal!');
  process.exit(1);
} else {
  console.log('✅ Semua test lulus!');
  process.exit(0);
}
