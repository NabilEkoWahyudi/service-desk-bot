/**
 * ---------------------------------------------------------------
 * CATEGORY SERVICE - IT Help Desk Bot PLN Batam
 * ---------------------------------------------------------------
 *
 * Mengambil data kategori dan subkategori dari ManageEngine
 * ServiceDesk Plus API v3 secara dinamis, lalu menyimpannya
 * ke dalam cache memori.
 *
 * Menggantikan SUBCATEGORY_MAP yang sebelumnya di-hardcode di
 * endpoints.js - kini data selalu sinkron dengan ManageEngine.
 *
 * Endpoint yang digunakan (dari Postman Collection On-Premise):
 *   GET /api/v3/categories
 *     -> input_data: { list_info: { row_count, start_index, ... } }
 *   GET /api/v3/categories/:category_id/subcategories
 *     -> input_data: { list_info: { row_count, start_index, ... } }
 *
 * Alur:
 *   1. fetchAllCategories()  - ambil semua kategori (paginasi)
 *   2. Untuk setiap kategori -> fetchSubcategoriesForCategory()
 *   3. Bentuk map: appName (lowercase) -> { categoryId, categoryName,
 *                                          subcategoryId, subcategoryName }
 *   4. Simpan ke cachedMap. Expire otomatis setelah CACHE_TTL_MS.
 */

const axios  = require('axios');
const logger = require('../utils/logger');
const { TECHNICIAN_KEY, ME_BASE_URL } = require('../config/endpoints');

// --- Auth Headers (sama persis dengan ticket.service.js) -------------------
const PORTAL_ID = process.env.PORTAL_ID || 'SDP';

const AUTH_HEADERS = {
  'TECHNICIAN_KEY': TECHNICIAN_KEY,
  'PORTALID': PORTAL_ID,
  'Accept': 'application/vnd.manageengine.sdp.v3+json'
};

// --- Cache ------------------------------------------------------------------
/**
 * Cache TTL: 1 jam. Setelah habis, fetch ulang saat permintaan berikutnya.
 * Bisa di-override via env var CATEGORY_CACHE_TTL_MS (dalam milidetik).
 */
const CACHE_TTL_MS = parseInt(process.env.CATEGORY_CACHE_TTL_MS || String(60 * 60 * 1000), 10);

/** @type {Record<string, { categoryId: string, categoryName: string, subcategoryId: string, subcategoryName: string }> | null} */
let cachedMap = null;
let cacheBuiltAt = 0;

// --- Helpers ----------------------------------------------------------------

/**
 * Ambil semua halaman dari sebuah endpoint ManageEngine dengan paginasi otomatis.
 *
 * @param {string} url         - URL endpoint (tanpa query string)
 * @param {string} resultKey   - Key array di response (mis. 'categories', 'subcategories')
 * @param {number} [pageSize]  - Jumlah baris per halaman (default 100)
 * @returns {Promise<object[]>}
 */
async function fetchAllPages(url, resultKey, pageSize = 100) {
  const results = [];
  let startIndex = 1;
  let hasMore = true;

  while (hasMore) {
    const inputData = {
      list_info: {
        row_count: pageSize,
        start_index: startIndex,
        sort_field: 'id',
        sort_order: 'asc',
        get_total_count: true
      }
    };

    const response = await axios.get(url, {
      params: { input_data: JSON.stringify(inputData) },
      headers: AUTH_HEADERS,
      timeout: 15000
    });

    const items = response.data?.[resultKey] || [];
    results.push(...items);

    // Gunakan has_more_rows dari response - sesuai format API ManageEngine On-Premise
    // Contoh list_info: { "has_more_rows": false, "total_count": 13, ... }
    const listInfo = response.data?.list_info || {};
    hasMore = listInfo.has_more_rows === true;

    if (hasMore) {
      startIndex += items.length; // lanjut dari index terakhir
    }
  }

  return results;
}

/**
 * Ambil semua subkategori untuk satu kategori (dengan paginasi).
 *
 * @param {string} categoryId
 * @returns {Promise<object[]>}
 */
async function fetchSubcategoriesForCategory(categoryId) {
  const url = `${ME_BASE_URL}/api/v3/categories/${categoryId}/subcategories`;
  try {
    return await fetchAllPages(url, 'subcategories');
  } catch (err) {
    logger.warn(`[CategoryService] Gagal ambil subkategori untuk category ${categoryId}: ${err.message}`);
    return [];
  }
}

// --- Core -------------------------------------------------------------------

/**
 * Bangun map subkategori dari API ManageEngine.
 *
 * @returns {Promise<Record<string, object>>}
 */
async function buildSubcategoryMap() {
  logger.info('[CategoryService] Mengambil data kategori dari ManageEngine...');

  const categoriesUrl = `${ME_BASE_URL}/api/v3/categories`;
  const categories = await fetchAllPages(categoriesUrl, 'categories');

  if (categories.length === 0) {
    logger.warn('[CategoryService] Tidak ada kategori yang ditemukan dari ManageEngine.');
    return {};
  }

  logger.info(`[CategoryService] ${categories.length} kategori ditemukan. Mengambil subkategori...`);

  const map = {};

  for (const cat of categories) {
    const categoryId = String(cat.id || '');
    if (!categoryId) continue;

    const subcategories = await fetchSubcategoriesForCategory(categoryId);

    for (const sub of subcategories) {
      // Skip subkategori yang sudah dihapus di ManageEngine
      if (sub.deleted === true) continue;

      const subcategoryId   = String(sub.id || '');
      const subcategoryName = sub.name || '';
      if (!subcategoryId || !subcategoryName) continue;

      // Ambil categoryId & categoryName dari field sub.category - lebih akurat
      // karena setiap subcategory object sudah memiliki referensi kategorinya sendiri.
      // Contoh response: { "id": "53", "name": "Presales", "category": { "id": "16", "name": "Aplikasi Pendukung" } }
      const catId   = String(sub.category?.id   || categoryId);
      const catName = String(sub.category?.name || '');

      // Key: nama subkategori lowercase - cocok dengan lookup di ticket.service.js
      const key = subcategoryName.toLowerCase().trim();

      map[key] = {
        categoryId:      catId,
        categoryName:    catName,
        subcategoryId,
        subcategoryName
      };
    }
  }

  logger.info(`[CategoryService] Map subkategori berhasil dibangun: ${Object.keys(map).length} entri.`);
  return map;
}

// --- Public API -------------------------------------------------------------

/**
 * Ambil map subkategori.
 * Menggunakan cache jika masih valid (< CACHE_TTL_MS).
 * Jika cache expired atau belum ada, lakukan fetch ulang.
 *
 * @returns {Promise<Record<string, { categoryId: string, categoryName: string, subcategoryId: string, subcategoryName: string }>>}
 */
async function getSubcategoryMap() {
  const now = Date.now();

  if (cachedMap !== null && (now - cacheBuiltAt) < CACHE_TTL_MS) {
    return cachedMap;
  }

  try {
    cachedMap = await buildSubcategoryMap();
    cacheBuiltAt = Date.now();
  } catch (err) {
    logger.error(`[CategoryService] Gagal membangun map subkategori: ${err.message}`);

    // Jika cache masih ada (meski expired), tetap gunakan daripada tidak ada sama sekali
    if (cachedMap !== null) {
      logger.warn('[CategoryService] Menggunakan cache lama karena fetch gagal.');
      return cachedMap;
    }

    // Tidak ada cache sama sekali - kembalikan objek kosong agar bot tetap berjalan
    return {};
  }

  return cachedMap;
}

/**
 * Paksa refresh cache, mengabaikan TTL.
 * Bisa dipanggil dari endpoint admin untuk sinkronisasi manual.
 *
 * @returns {Promise<number>} Jumlah entri dalam map setelah refresh
 */
async function refreshSubcategoryMap() {
  logger.info('[CategoryService] Force refresh cache subkategori...');
  cachedMap = null;
  cacheBuiltAt = 0;
  const map = await getSubcategoryMap();
  return Object.keys(map).length;
}

module.exports = { getSubcategoryMap, refreshSubcategoryMap };
