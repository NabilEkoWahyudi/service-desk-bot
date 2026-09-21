/**
 * ═══════════════════════════════════════════════════════════════
 * ENCRYPTED STORE — IT Help Desk Bot PLN Batam
 * ═══════════════════════════════════════════════════════════════
 *
 * Helper untuk membaca dan menulis file JSON yang dienkripsi
 * menggunakan AES-256-GCM (sama dengan session.service.js).
 *
 * Digunakan oleh:
 *   - approval.service.js  (pending_approvals.json)
 *   - notification.service.js (notifications.json)
 *   - message.handler.js   (ratelimit.json)
 *
 * Perilaku:
 *   - Jika SESSION_SECRET di-set → file ditulis/dibaca dalam format terenkripsi
 *   - Jika SESSION_SECRET kosong → plain JSON (backwards compatible)
 *   - File lama (plain JSON) otomatis terdeteksi dan dibaca dengan benar
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const SESSION_SECRET    = process.env.SESSION_SECRET || null;
const ENCRYPTION_ENABLED = !!SESSION_SECRET;

// ─── Internal Crypto (AES-256-GCM) ───────────────────────────────────────────

/**
 * Enkripsi string plain menjadi format: "iv_hex|authTag_hex|ciphertext_base64"
 * @param {string} plainText
 * @returns {string}
 */
function _encrypt(plainText) {
  const key    = crypto.createHash('sha256').update(SESSION_SECRET).digest(); // 32 bytes
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag   = cipher.getAuthTag();

  return `${iv.toString('hex')}|${authTag.toString('hex')}|${encrypted.toString('base64')}`;
}

/**
 * Dekripsi string format "iv_hex|authTag_hex|ciphertext_base64"
 * @param {string} encryptedText
 * @returns {string} plain text
 */
function _decrypt(encryptedText) {
  const parts = encryptedText.split('|');
  if (parts.length !== 3) throw new Error('Format enkripsi tidak valid (bukan 3 bagian)');

  const [ivHex, authTagHex, ciphertextBase64] = parts;
  const key        = crypto.createHash('sha256').update(SESSION_SECRET).digest();
  const iv         = Buffer.from(ivHex, 'hex');
  const authTag    = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextBase64, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  return decipher.update(ciphertext, 'binary', 'utf8') + decipher.final('utf8');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Baca file JSON (plain atau terenkripsi) dari disk.
 *
 * Auto-detect: jika konten diawali '{' atau '[' → anggap plain JSON.
 * Selain itu → coba dekripsi dulu (jika enkripsi aktif).
 *
 * @param {string} filePath    - Path absolut ke file
 * @param {any}    defaultVal  - Nilai default jika file tidak ada atau gagal dibaca
 * @returns {any}              - Object/Array yang sudah di-parse
 */
function readJson(filePath, defaultVal = {}) {
  try {
    if (!fs.existsSync(filePath)) return defaultVal;

    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return defaultVal;

    // Auto-detect plain JSON (diawali '{' atau '[')
    if (raw.startsWith('{') || raw.startsWith('[')) {
      return JSON.parse(raw);
    }

    // Bukan plain JSON — coba dekripsi jika enkripsi aktif
    if (ENCRYPTION_ENABLED) {
      try {
        return JSON.parse(_decrypt(raw));
      } catch (_) {
        logger.warn(`[EncryptedStore] Gagal dekripsi ${path.basename(filePath)} — mereset ke default`);
        return defaultVal;
      }
    }

    // Enkripsi tidak aktif tapi format tidak dikenali — reset
    logger.warn(`[EncryptedStore] Format file ${path.basename(filePath)} tidak dikenali — mereset ke default`);
    return defaultVal;

  } catch (err) {
    logger.warn(`[EncryptedStore] Gagal membaca ${path.basename(filePath)}: ${err.message}`);
    return defaultVal;
  }
}

/**
 * Tulis object/array ke file JSON (plain atau terenkripsi).
 *
 * @param {string} filePath - Path absolut ke file
 * @param {any}    data     - Object/Array yang akan disimpan
 */
function writeJson(filePath, data) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const json = JSON.stringify(data, null, 2);

    if (ENCRYPTION_ENABLED) {
      fs.writeFileSync(filePath, _encrypt(json));
    } else {
      fs.writeFileSync(filePath, json);
    }
  } catch (err) {
    logger.warn(`[EncryptedStore] Gagal menulis ${path.basename(filePath)}: ${err.message}`);
  }
}

module.exports = { readJson, writeJson, ENCRYPTION_ENABLED };
