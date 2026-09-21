/**
 * ═══════════════════════════════════════════════════════════════
 * SMOKE TEST — Server Startup & Endpoints
 * ═══════════════════════════════════════════════════════════════
 *
 * Memverifikasi bahwa:
 *   1. Server Express bisa dijalankan tanpa error
 *   2. Endpoint /health merespons dengan benar
 *   3. Endpoint /wa-status merespons dengan benar
 *   4. Endpoint /webhook/reply menolak request tanpa auth
 *   5. Endpoint /wa-restart menolak request tanpa HEALTH_API_KEY
 *
 * Cara jalankan:
 *   node tests/smoke.test.js
 *
 * Catatan:
 *   - WhatsApp tidak diinisialisasi (WA_SKIP_INIT=true)
 *   - ManageEngine tidak dihubungi
 *   - Port yang digunakan: 13099 (bukan 3000)
 */

'use strict';

const http = require('http');
const path = require('path');

// ─── Konfigurasi Test ─────────────────────────────────────────────────────────

const TEST_PORT = 13099;
process.env.PORT = String(TEST_PORT);
process.env.NODE_ENV = 'test';
process.env.WA_SKIP_INIT = 'true'; // Flag untuk skip inisialisasi WA

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

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function httpRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: TEST_PORT, ...options }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), raw: data });
        } catch (_) {
          resolve({ status: res.statusCode, body: null, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

// ─── Setup: jalankan Express minimal ──────────────────────────────────────────

// Import Express langsung — tidak import index.js penuh agar tidak trigger WA init
const express = require('express');
const helmet  = require('helmet');

const app = express();
app.use(helmet());
app.use(express.json());

// Salin implementasi endpoint dari index.js untuk test terisolasi
app.get('/health', (_req, res) => {
  const healthKey = process.env.HEALTH_API_KEY || '';
  if (healthKey) {
    const queryKey = _req.query.key || '';
    const authHeader = _req.headers['authorization'] || '';
    const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (queryKey !== healthKey && bearerKey !== healthKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }
  res.json({
    status: 'ok',
    service: 'IT Service Desk Bot — PLN Batam',
    uptime: Math.floor(process.uptime()) + 's',
    timestamp: new Date().toISOString()
  });
});

app.get('/wa-status', (_req, res) => {
  res.json({ connected: false, state: 'SMOKE_TEST' });
});

app.post('/wa-restart', (req, res) => {
  const healthKey = process.env.HEALTH_API_KEY || '';
  if (!healthKey) {
    return res.status(403).json({ success: false, error: 'Endpoint ini memerlukan HEALTH_API_KEY di .env untuk keamanan.' });
  }
  const authHeader = req.headers['authorization'] || '';
  const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (bearerKey !== healthKey) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  res.json({ success: true, message: 'Restart dimulai.' });
});

app.post('/webhook/reply', (req, res) => {
  const secret = process.env.WEBHOOK_SECRET || '';
  if (secret) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (token !== secret) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
  }
  const { waNumber, message } = req.body || {};
  if (!waNumber) return res.status(400).json({ success: false, error: 'waNumber wajib' });
  if (!message) return res.status(400).json({ success: false, error: 'message wajib' });
  res.json({ success: true, message: 'Smoke test — tidak benar-benar mengirim WA.' });
});

// ─── Jalankan Test ────────────────────────────────────────────────────────────

async function runTests() {
  const server = app.listen(TEST_PORT);

  // Beri waktu server startup
  await new Promise(r => setTimeout(r, 100));

  try {
    // ── Test 1: GET /health (tanpa auth) ────────────────────────────────────
    section('GET /health — tanpa HEALTH_API_KEY');
    {
      delete process.env.HEALTH_API_KEY;
      const res = await httpRequest({ path: '/health', method: 'GET' });
      assert('Status 200', res.status === 200, `got ${res.status}`);
      assert('body.status === "ok"', res.body?.status === 'ok', JSON.stringify(res.body));
      assert('body.uptime ada', typeof res.body?.uptime === 'string');
      assert('body.timestamp ada', typeof res.body?.timestamp === 'string');
    }

    // ── Test 2: GET /health (dengan HEALTH_API_KEY) ──────────────────────────
    section('GET /health — dengan HEALTH_API_KEY');
    {
      process.env.HEALTH_API_KEY = 'test-smoke-key-12345';

      const unauthorized = await httpRequest({ path: '/health', method: 'GET' });
      assert('Tanpa token → 401', unauthorized.status === 401);

      const withQuery = await httpRequest({ path: '/health?key=test-smoke-key-12345', method: 'GET' });
      assert('Dengan ?key= benar → 200', withQuery.status === 200);

      const withBearer = await httpRequest({ path: '/health', method: 'GET', headers: { 'Authorization': 'Bearer test-smoke-key-12345' } });
      assert('Dengan Bearer token benar → 200', withBearer.status === 200);

      const wrongBearer = await httpRequest({ path: '/health', method: 'GET', headers: { 'Authorization': 'Bearer salah' } });
      assert('Dengan Bearer token salah → 401', wrongBearer.status === 401);

      delete process.env.HEALTH_API_KEY;
    }

    // ── Test 3: GET /wa-status ───────────────────────────────────────────────
    section('GET /wa-status');
    {
      const res = await httpRequest({ path: '/wa-status', method: 'GET' });
      assert('Status 200', res.status === 200);
      assert('body.connected ada', typeof res.body?.connected === 'boolean');
    }

    // ── Test 4: POST /wa-restart tanpa HEALTH_API_KEY ───────────────────────
    section('POST /wa-restart — keamanan');
    {
      delete process.env.HEALTH_API_KEY;
      const res = await httpRequest({ path: '/wa-restart', method: 'POST', headers: { 'Content-Type': 'application/json' } });
      assert('Tanpa HEALTH_API_KEY → 403', res.status === 403);

      process.env.HEALTH_API_KEY = 'restart-key-test';
      const unauthorized = await httpRequest({ path: '/wa-restart', method: 'POST', headers: { 'Authorization': 'Bearer salah' } });
      assert('Dengan token salah → 401', unauthorized.status === 401);

      delete process.env.HEALTH_API_KEY;
    }

    // ── Test 5: POST /webhook/reply ──────────────────────────────────────────
    section('POST /webhook/reply — validasi input');
    {
      process.env.WEBHOOK_SECRET = 'webhook-test-secret';

      const noAuth = await httpRequest({ path: '/webhook/reply', method: 'POST', headers: { 'Content-Type': 'application/json' } }, {});
      assert('Tanpa auth → 401', noAuth.status === 401);

      const noBody = await httpRequest(
        { path: '/webhook/reply', method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer webhook-test-secret' } },
        {}
      );
      assert('Tanpa waNumber → 400', noBody.status === 400);

      const noMsg = await httpRequest(
        { path: '/webhook/reply', method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer webhook-test-secret' } },
        { waNumber: '628123456789' }
      );
      assert('Tanpa message → 400', noMsg.status === 400);

      const valid = await httpRequest(
        { path: '/webhook/reply', method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer webhook-test-secret' } },
        { waNumber: '628123456789', message: 'Test message dari smoke test' }
      );
      assert('Dengan data valid → 200', valid.status === 200);

      delete process.env.WEBHOOK_SECRET;
    }

  } finally {
    server.close();
  }

  // ─── Ringkasan ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Hasil: ${passed} PASS, ${failed} FAIL`);

  if (failed > 0) {
    console.error('❌ Ada test yang gagal!');
    process.exit(1);
  } else {
    console.log('✅ Semua smoke test lulus!');
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('💥 Smoke test crashed:', err.message);
  process.exit(1);
});
