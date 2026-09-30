/**
 * ---------------------------------------------------------------
 * SESSION SERVICE - IT Help Desk Bot PLN Batam
 * ---------------------------------------------------------------
 *
 * Mengelola persistensi session ke disk.
 *
 * Item 6: Session kini dienkripsi menggunakan AES-256-GCM jika
 *   SESSION_SECRET di-set di .env. Jika tidak di-set, data tetap
 *   disimpan plain JSON dengan peringatan (backwards compatible).
 *
 * Item 7: Ghost lock - pada saat loadSessions(), semua session
 *   yang terkunci (state CONFIRMING/FILLING_FORM) di-reset agar
 *   tidak ada state basi setelah server restart.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');

const SESSION_FILE_PATH = path.join(__dirname, '../../data/sessions.json');

// Pastikan folder data ada
const dataDir = path.dirname(SESSION_FILE_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// --- Item 6: Setup Enkripsi ----------------------------------------------------
// AES-256-GCM membutuhkan key 32 byte.
// Key diturunkan dari SESSION_SECRET menggunakan SHA-256.
const SESSION_SECRET = process.env.SESSION_SECRET || null;
const ENCRYPTION_ENABLED = !!SESSION_SECRET;

if (!ENCRYPTION_ENABLED) {
  logger.warn('[SessionService] SESSION_SECRET tidak di-set - session disimpan plain JSON. Set SESSION_SECRET di .env untuk enkripsi.');
}

/**
 * Enkripsi teks plain menggunakan AES-256-GCM
 * @param {string} plainText
 * @returns {string} format: "iv_hex|authTag_hex|ciphertext_base64"
 *   Menggunakan '|' sebagai separator (bukan ':') agar tidak
 *   bertabrakan dengan karakter yang mungkin ada di base64. (B1 fix)
 */
function encrypt(plainText) {
  const key = crypto.createHash('sha256').update(SESSION_SECRET).digest(); // 32 bytes
  const iv  = crypto.randomBytes(12); // 12 bytes IV untuk GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag   = cipher.getAuthTag();

  // Gunakan '|' sebagai separator - hex tidak mengandung '|' sehingga aman
  return `${iv.toString('hex')}|${authTag.toString('hex')}|${encrypted.toString('base64')}`;
}

/**
 * Dekripsi string yang terenkripsi AES-256-GCM
 * @param {string} encryptedText - format: "iv_hex|authTag_hex|ciphertext_base64"
 * @returns {string} plain text asli
 *
 * B1 fix: split dibatasi 3 bagian menggunakan separator '|' yang tidak
 * mungkin muncul di hex atau base64, sehingga parsing selalu akurat.
 */
function decrypt(encryptedText) {
  // Split maksimum 3 bagian - iv|authTag|ciphertext
  const parts = encryptedText.split('|');
  if (parts.length !== 3) {
    throw new Error('Format enkripsi tidak valid');
  }
  const [ivHex, authTagHex, ciphertextBase64] = parts;

  const key        = crypto.createHash('sha256').update(SESSION_SECRET).digest();
  const iv         = Buffer.from(ivHex, 'hex');
  const authTag    = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextBase64, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  return decipher.update(ciphertext, 'binary', 'utf8') + decipher.final('utf8');
}

// --- Helpers -------------------------------------------------------------------

/**
 * Baca dan parse file session dari disk
 * Mendukung file terenkripsi (separator '|') maupun plain JSON (auto-detect)
 */
function readSessionFile() {
  const raw = fs.readFileSync(SESSION_FILE_PATH, 'utf8').trim();

  // Coba dekripsi jika enkripsi aktif dan file tidak diawali '{'
  // File enkripsi selalu diawali hex string (karakter 0-9a-f), bukan '{'
  if (ENCRYPTION_ENABLED && !raw.startsWith('{')) {
    try {
      const decrypted = decrypt(raw);
      return JSON.parse(decrypted);
    } catch (_) {
      logger.warn('[SessionService] Gagal dekripsi file session - kemungkinan format lama. Mereset sesi.');
      return {};
    }
  }

  // Fallback: plain JSON
  try {
    return JSON.parse(raw);
  } catch (_) {
    logger.warn('[SessionService] File session tidak valid (bukan JSON) - mereset sesi.');
    return {};
  }
}

/**
 * Tulis session ke disk (terenkripsi jika SESSION_SECRET aktif)
 */
function writeSessionFile(obj) {
  const json = JSON.stringify(obj, null, 2);
  if (ENCRYPTION_ENABLED) {
    fs.writeFileSync(SESSION_FILE_PATH, encrypt(json));
  } else {
    fs.writeFileSync(SESSION_FILE_PATH, json);
  }
}

// --- Public API ----------------------------------------------------------------

/**
 * Memuat sesi dari file dan melakukan pembersihan state basi (Item 7: Ghost Lock)
 * @returns {Map<string, any>}
 */
function loadSessions() {
  if (!fs.existsSync(SESSION_FILE_PATH)) return new Map();

  try {
    const parsed = readSessionFile();
    const sessionsMap = new Map(Object.entries(parsed));

    // --- Item 7: Ghost Lock Prevention --------------------------------------
    // Setelah server restart, semua processingLock in-memory sudah terhapus.
    // Reset state aktif ke IDLE agar user memulai dari awal.
    let ghostCount = 0;
    for (const [waNumber, session] of sessionsMap) {
      if (session.state === 'CONFIRMING' || session.state === 'FILLING_FORM') {
        session.state        = 'IDLE';
        session.category     = null;
        session.data         = {};
        session.verifiedUser = null;
        ghostCount++;
      }
      // Hapus sesi IDLE lama (tidak aktif lebih dari 24 jam)
      const lastActivity = new Date(session.lastActivity || 0).getTime();
      const ageHours = (Date.now() - lastActivity) / (1000 * 60 * 60);
      if (session.state === 'IDLE' && ageHours > 24) {
        sessionsMap.delete(waNumber);
      }
    }

    if (ghostCount > 0) {
      logger.info(`[SessionService] ${ghostCount} ghost session di-reset ke IDLE saat startup.`);
    }

    return sessionsMap;

  } catch (err) {
    logger.error(`[SessionService] Gagal memuat sesi dari file: ${err.message}`);
    return new Map();
  }
}

/**
 * Menyimpan sesi ke file (terenkripsi jika SESSION_SECRET aktif)
 * @param {Map<string, any>} sessionsMap
 */
function saveSessions(sessionsMap) {
  try {
    const obj = Object.fromEntries(sessionsMap);

    // Simpan hanya field yang diperlukan - tidak ada pdfBuffer (sudah dihapus)
    const safeObj = {};
    for (const [key, session] of Object.entries(obj)) {
      safeObj[key] = {
        state:        session.state,
        category:     session.category,
        data:         session.data,
        lastActivity: session.lastActivity,
        verifiedUser: session.verifiedUser || null
      };
    }

    writeSessionFile(safeObj);

  } catch (err) {
    logger.error(`[SessionService] Gagal menyimpan sesi ke file: ${err.message}`);
  }
}

module.exports = { loadSessions, saveSessions };
