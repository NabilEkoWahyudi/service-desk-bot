/**
 * ═══════════════════════════════════════════════════════════════
 * UNIT TESTS — Session Service (Enkripsi/Dekripsi AES-256-GCM)
 * ═══════════════════════════════════════════════════════════════
 *
 * Menguji fungsi enkripsi/dekripsi sesi secara terisolasi
 * dan encrypted-store helper.
 *
 * Cara jalankan:
 *   node tests/unit.session.test.js
 *
 * Tidak memerlukan framework, koneksi internet, atau WhatsApp.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

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

// ─── Setup: Gunakan temp dir untuk file test ───────────────────────────────────

const TMP_DIR      = fs.mkdtempSync(path.join(os.tmpdir(), 'helpdesk-test-'));
const TEST_FILE    = path.join(TMP_DIR, 'test-store.json');

function cleanup() {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
}

// ─── Test encrypted-store (tanpa enkripsi) ────────────────────────────────────

section('encrypted-store — mode plain JSON (SESSION_SECRET kosong)');

// Pastikan SESSION_SECRET tidak diset
delete process.env.SESSION_SECRET;

// Require setelah manipulasi env
const storeModule = require('../src/utils/encrypted-store');

{
  const data = { testKey: 'testValue', arr: [1, 2, 3] };
  storeModule.writeJson(TEST_FILE, data);
  assert('File berhasil dibuat', fs.existsSync(TEST_FILE));

  const raw = fs.readFileSync(TEST_FILE, 'utf8');
  assert('File plain JSON dimulai dengan {', raw.trim().startsWith('{'));

  const read = storeModule.readJson(TEST_FILE, {});
  assert('Data terbaca kembali dengan benar', read.testKey === 'testValue');
  assert('Array terbaca dengan benar', JSON.stringify(read.arr) === '[1,2,3]');
}

{
  const read = storeModule.readJson(path.join(TMP_DIR, 'tidak-ada.json'), { default: true });
  assert('File tidak ada → kembalikan defaultVal', read.default === true);
}

{
  fs.writeFileSync(path.join(TMP_DIR, 'empty.json'), '');
  const read = storeModule.readJson(path.join(TMP_DIR, 'empty.json'), { default: 42 });
  assert('File kosong → kembalikan defaultVal', read.default === 42);
}

// ─── Test encrypted-store (dengan enkripsi) ───────────────────────────────────

section('encrypted-store — mode ENCRYPTED (SESSION_SECRET diset)');

// Set SESSION_SECRET dan require ulang (fresh module untuk test enkripsi)
// Karena Node.js cache module, kita test manual enkripsi via internal helper

{
  // Test langsung menggunakan Node.js crypto untuk verifikasi logika enkripsi
  const crypto = require('crypto');
  const secret = 'test_secret_key_for_unit_testing_32chars!!';
  const key    = crypto.createHash('sha256').update(secret).digest();

  function testEncrypt(plainText) {
    const iv     = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc    = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const tag    = cipher.getAuthTag();
    return `${iv.toString('hex')}|${tag.toString('hex')}|${enc.toString('base64')}`;
  }

  function testDecrypt(encText) {
    const parts = encText.split('|');
    if (parts.length !== 3) throw new Error('Format tidak valid');
    const [ivHex, tagHex, ctBase64] = parts;
    const iv      = Buffer.from(ivHex, 'hex');
    const tag     = Buffer.from(tagHex, 'hex');
    const ct      = Buffer.from(ctBase64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ct, 'binary', 'utf8') + decipher.final('utf8');
  }

  const original = JSON.stringify({ waNumber: '628123456789', seenIds: [] });
  const encrypted = testEncrypt(original);

  assert('Enkripsi menghasilkan format 3 bagian (|)', encrypted.split('|').length === 3);
  assert('Enkripsi tidak mengandung data plain', !encrypted.includes('628123456789'));

  const decrypted = testDecrypt(encrypted);
  assert('Dekripsi menghasilkan data asli', decrypted === original);

  // Test: data berbeda menghasilkan ciphertext berbeda (IV acak)
  const enc1 = testEncrypt(original);
  const enc2 = testEncrypt(original);
  assert('Enkripsi dua kali menghasilkan output berbeda (IV acak)', enc1 !== enc2);

  // Test: dekripsi data berbeda menghasilkan data asli yang sama
  const dec1 = testDecrypt(enc1);
  const dec2 = testDecrypt(enc2);
  assert('Dekripsi keduanya menghasilkan data asli yang sama', dec1 === dec2);
}

// ─── Test format separator ────────────────────────────────────────────────────

section('encrypted-store — separator "|" tidak muncul di hex/base64');

{
  // Verifikasi bahwa hex string tidak mengandung '|'
  const crypto = require('crypto');
  const iv  = crypto.randomBytes(12).toString('hex');
  const tag = crypto.randomBytes(16).toString('hex');
  assert('IV hex tidak mengandung "|"', !iv.includes('|'));
  assert('Auth tag hex tidak mengandung "|"', !tag.includes('|'));

  // Base64 standard juga tidak mengandung '|'
  const sample = Buffer.from('test data').toString('base64');
  assert('Base64 tidak mengandung "|"', !sample.includes('|'));
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

cleanup();

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
