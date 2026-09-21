/**
 * ═══════════════════════════════════════════════════════════════
 * ME CONFIG SERVICE — IT Help Desk Bot PLN Batam
 * ═══════════════════════════════════════════════════════════════
 *
 * Mengambil ID secara dinamis untuk Group, Level, dan Service Category
 * berdasarkan namanya dari ManageEngine ServiceDesk Plus API v3.
 *
 * Jika API ManageEngine tidak dapat dihubungi atau nama tidak ditemukan,
 * service ini akan FALLBACK ke nilai ID dari variabel .env
 * (ME_GROUP_ID, ME_LEVEL_ID, ME_SERVICE_CATEGORY_ID).
 *
 * Cache: ID disimpan di memori selama 1 jam (CACHE_TTL).
 * Tujuan: mengurangi beban API ManageEngine dan mempercepat respons bot.
 */

const axios = require('axios');
const logger = require('../utils/logger');
const { TECHNICIAN_KEY, ME_BASE_URL, ME_GROUP_ID, ME_LEVEL_ID, ME_SERVICE_CATEGORY_ID } = require('../config/endpoints');

const PORTAL_ID = process.env.PORTAL_ID || 'SDP';
const AUTH_HEADERS = {
  'TECHNICIAN_KEY': TECHNICIAN_KEY,
  'PORTALID': PORTAL_ID,
  'Accept': 'application/vnd.manageengine.sdp.v3+json'
};

// Nama default yang akan dicari (dapat ditimpa via env)
const TARGET_GROUP_NAME = process.env.ME_GROUP_NAME || 'Aplikasi';
const TARGET_LEVEL_NAME = process.env.ME_LEVEL_NAME || 'Tier 2 - Request';
const TARGET_SERVICE_CATEGORY_NAME = process.env.ME_SERVICE_CATEGORY_NAME || 'Manajemen User';

let cachedIds = null;
let cacheTimestamp = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 jam

/**
 * Kategorisasi error Axios untuk log yang lebih informatif.
 * @param {Error} err
 * @returns {string}
 */
function describeAxiosError(err) {
  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
    return `Timeout (${err.code}) — ManageEngine lambat merespons`;
  }
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
    return `Tidak dapat terhubung ke ManageEngine (${err.code})`;
  }
  if (err.response) {
    return `HTTP ${err.response.status} dari ManageEngine`;
  }
  return err.message || 'Error tidak diketahui';
}

/**
 * Fetch ID entitas berdasarkan nama.
 * @param {string} endpoint  - Path API (mis. '/api/v3/support_groups')
 * @param {string} entityKey - Key array dalam response (mis. 'support_groups')
 * @param {string} targetName
 * @returns {Promise<string|null>} ID string, atau null jika tidak ditemukan / error
 */
async function fetchEntityId(endpoint, entityKey, targetName) {
  try {
    const url = `${ME_BASE_URL}${endpoint}`;

    const inputData = {
      list_info: {
        row_count: 100,
        start_index: 1,
        search_fields: {
          name: targetName
        }
      }
    };

    const response = await axios.get(url, {
      params: { input_data: JSON.stringify(inputData) },
      headers: AUTH_HEADERS,
      timeout: 10000
    });

    const items = response.data?.[entityKey] || [];

    if (items.length === 0) {
      logger.warn(`[MeConfig] Nama "${targetName}" tidak ditemukan di ${entityKey} (response kosong) — akan pakai ID dari .env`);
      return null;
    }

    // Cari yang namanya sama persis (case-insensitive)
    const found = items.find(item => item.name && item.name.toLowerCase() === targetName.toLowerCase());
    if (found && found.id) {
      return String(found.id);
    }

    logger.warn(`[MeConfig] Nama "${targetName}" tidak cocok dengan ${items.length} item di ${entityKey} — akan pakai ID dari .env`);
    return null;

  } catch (err) {
    const desc = describeAxiosError(err);
    logger.warn(`[MeConfig] Gagal fetch ${entityKey} untuk "${targetName}": ${desc} — akan pakai ID dari .env`);
    return null;
  }
}

/**
 * Dapatkan semua ID konfigurasi ManageEngine.
 * Hasil di-cache di memori selama CACHE_TTL (1 jam) untuk mengurangi beban API.
 *
 * Jika semua fetch gagal → bot tetap berjalan menggunakan ID dari .env.
 * @returns {Promise<{ groupId: string, levelId: string, serviceCategoryId: string }>}
 */
async function getMeConfigIds() {
  const now = Date.now();
  if (cachedIds && (now - cacheTimestamp) < CACHE_TTL) {
    return cachedIds;
  }

  logger.info('[MeConfig] Memulai pencarian ID dinamis ke ManageEngine...');

  // Lakukan request paralel untuk efisiensi
  const [fetchedGroupId, fetchedLevelId, fetchedServiceCategoryId] = await Promise.all([
    fetchEntityId('/api/v3/support_groups', 'support_groups', TARGET_GROUP_NAME),
    fetchEntityId('/api/v3/levels', 'levels', TARGET_LEVEL_NAME),
    fetchEntityId('/api/v3/service_categories', 'service_categories', TARGET_SERVICE_CATEGORY_NAME)
  ]);

  // Fallback ke konstanta env jika gagal
  const groupId           = fetchedGroupId           || ME_GROUP_ID;
  const levelId           = fetchedLevelId           || ME_LEVEL_ID;
  const serviceCategoryId = fetchedServiceCategoryId || ME_SERVICE_CATEGORY_ID;

  // Log sumber masing-masing ID agar mudah diaudit
  const srcGroup  = fetchedGroupId           ? 'API' : `Env(${ME_GROUP_ID})`;
  const srcLevel  = fetchedLevelId           ? 'API' : `Env(${ME_LEVEL_ID})`;
  const srcSvcCat = fetchedServiceCategoryId ? 'API' : `Env(${ME_SERVICE_CATEGORY_ID})`;

  cachedIds = { groupId, levelId, serviceCategoryId };
  cacheTimestamp = now;

  logger.info(
    `[MeConfig] ID Berhasil di-resolve → ` +
    `Group: ${groupId} [${srcGroup}], ` +
    `Level: ${levelId} [${srcLevel}], ` +
    `Service Category: ${serviceCategoryId} [${srcSvcCat}]`
  );

  return cachedIds;
}

module.exports = { getMeConfigIds };
