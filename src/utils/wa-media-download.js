'use strict';

/**
 * --- WA Media Direct Download -------------------------------------------------
 * Download dan dekripsi media WhatsApp secara langsung via HTTPS ke CDN WA
 * tanpa bergantung pada Puppeteer atau fungsi internal WA Web.
 *
 * Protokol enkripsi media WhatsApp:
 *   1. mediaKey (base64) -> expand via HKDF-SHA256 dengan info "WhatsApp <Type> Keys"
 *   2. Hasilkan: iv (16 byte) + cipherKey (32 byte) + macKey (32 byte) + ...
 *   3. Download encrypted file dari https://mmg.whatsapp.net{directPath}
 *   4. Verifikasi HMAC-SHA256 (opsional) lalu decrypt AES-256-CBC
 *   5. Strip 10 bytes terakhir (MAC appended by WA)
 *
 * Referensi: https://github.com/adiwajshing/Baileys / signal-protocol WA media spec
 */

const crypto = require('crypto');
const https  = require('https');
const http   = require('http');
const logger = require('./logger');

const WA_MEDIA_HOST = 'mmg.whatsapp.net';

// Mapping tipe WA ke info string untuk HKDF
const MEDIA_HKDF_INFO = {
  image:    'WhatsApp Image Keys',
  video:    'WhatsApp Video Keys',
  audio:    'WhatsApp Audio Keys',
  document: 'WhatsApp Document Keys',
  sticker:  'WhatsApp Image Keys',
};

/**
 * HKDF expand sesuai RFC 5869
 * @param {Buffer} prk - pseudorandom key (dari HMAC-SHA256)
 * @param {string|Buffer} info
 * @param {number} length - jumlah byte yang dibutuhkan
 */
function hkdfExpand(prk, info, length) {
  const infoBuffer = Buffer.isBuffer(info) ? info : Buffer.from(info, 'utf8');
  let output = Buffer.alloc(0);
  let prev   = Buffer.alloc(0);
  let counter = 1;

  while (output.length < length) {
    const hmac = crypto.createHmac('sha256', prk);
    hmac.update(prev);
    hmac.update(infoBuffer);
    hmac.update(Buffer.from([counter]));
    prev = hmac.digest();
    output = Buffer.concat([output, prev]);
    counter++;
  }
  return output.slice(0, length);
}

/**
 * HKDF extract + expand dari mediaKey
 * @param {string} mediaKeyB64 - base64 encoded mediaKey dari msg._data
 * @param {string} mediaType   - 'image', 'video', 'audio', 'document'
 * @returns {{ iv: Buffer, cipherKey: Buffer, macKey: Buffer }}
 */
function deriveMediaKeys(mediaKeyB64, mediaType) {
  const mediaKey = Buffer.from(mediaKeyB64, 'base64');
  const info     = MEDIA_HKDF_INFO[mediaType] || MEDIA_HKDF_INFO.image;

  // Extract: HMAC-SHA256(salt=0x00*32, ikm=mediaKey)
  const salt = Buffer.alloc(32, 0);
  const prk  = crypto.createHmac('sha256', salt).update(mediaKey).digest();

  // Expand: 112 bytes -> iv(16) + cipherKey(32) + macKey(32) + ... 
  const expanded = hkdfExpand(prk, info, 112);

  return {
    iv:        expanded.slice(0, 16),
    cipherKey: expanded.slice(16, 48),
    macKey:    expanded.slice(48, 80),
  };
}

/**
 * Unduh file dari URL via HTTPS/HTTP
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib    = parsed.protocol === 'https:' ? https : http;

    const req = lib.get(url, {
      headers: {
        'User-Agent': 'WhatsApp/2.24.6.77 A',
        'Accept':     '*/*',
      },
      timeout: 30000,
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // ikuti redirect
        return downloadBuffer(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} saat download dari ${url}`));
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end',  ()    => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout saat download media')); });
    req.on('error', reject);
  });
}

/**
 * Download dan dekripsi media WhatsApp langsung via HTTPS
 * SEPENUHNYA bypass Puppeteer dan internal WA Web.
 *
 * @param {object} msgData - msg._data dari whatsapp-web.js
 *   Harus mengandung: directPath, mediaKey, mimetype
 *   Opsional: mediaType (default: 'image'), encFilehash
 * @returns {Promise<{ data: string, mimetype: string, filename: string } | null>}
 */
async function downloadMediaDirect(msgData) {
  const { directPath, mediaKey, mimetype, filename, type } = msgData;

  if (!directPath || !mediaKey) {
    logger.warn('[WaMedia] directPath atau mediaKey tidak ada di msgData');
    return null;
  }

  const mediaType = type || 'image';
  const url = `https://${WA_MEDIA_HOST}${directPath}`;

  logger.info(`[WaMedia] Download langsung dari: https://${WA_MEDIA_HOST}${directPath.substring(0, 40)}...`);

  // 1. Download encrypted file
  let encryptedBuffer;
  try {
    encryptedBuffer = await downloadBuffer(url);
    logger.info(`[WaMedia] Downloaded ${encryptedBuffer.length} bytes`);
  } catch (err) {
    logger.error(`[WaMedia] Gagal download dari CDN WhatsApp: ${err.message}`);
    return null;
  }

  // 2. Derive keys via HKDF
  let iv, cipherKey;
  try {
    ({ iv, cipherKey } = deriveMediaKeys(mediaKey, mediaType));
  } catch (err) {
    logger.error(`[WaMedia] Gagal derive media keys: ${err.message}`);
    return null;
  }

  // 3. Encrypted file: [encrypted_data][10-byte MAC appended by WA]
  // Strip 10 byte terakhir (mac), lalu decrypt sisanya
  const encryptedData = encryptedBuffer.slice(0, encryptedBuffer.length - 10);

  let decrypted;
  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
    decipher.setAutoPadding(true);
    decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  } catch (err) {
    logger.error(`[WaMedia] Gagal dekripsi AES-256-CBC: ${err.message}`);
    return null;
  }

  const data = decrypted.toString('base64');
  logger.info(`[WaMedia]  Dekripsi berhasil - ${Math.round(decrypted.length / 1024)}KB`);

  return {
    data,
    mimetype: mimetype || 'image/jpeg',
    filename: filename || `wa_image_${Date.now()}.jpg`,
  };
}

module.exports = { downloadMediaDirect };
