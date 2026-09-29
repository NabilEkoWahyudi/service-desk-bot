/**
 * ═══════════════════════════════════════════════════════════════
 * WHATSAPP SERVICE — IT Help Desk Bot PLN Batam
 * ═══════════════════════════════════════════════════════════════
 *
 * Mengelola koneksi WhatsApp menggunakan whatsapp-web.js.
 * Menghubungkan pesan masuk ke message.handler.js.
 *
 * Fix yang diterapkan:
 *   [FIX-1] Timeout naik ke 120 detik (dari 60 detik)
 *   [FIX-2] destroy() selalu dipanggil saat init gagal/timeout
 *           → Chrome tidak lagi zombie setelah init gagal
 *   [FIX-3] Kill Chrome HANYA berdasarkan PID atau session path
 *           → Tidak lagi membunuh Chrome browser milik user
 *   [FIX-4] Cross-platform: Windows (WMIC/PID), Linux/Mac (pkill/kill)
 */

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');   // [PERF] async exec — tidak memblokir event loop
const { handleMessage } = require('../handlers/message.handler');
const logger = require('../utils/logger');

let waClient = null;
let isInitializing = false;   // Guard: cegah double-init saat --watch restart
let reconnectAttempts = 0;
let chromePid = null;    // [FIX-3] Simpan PID Chrome Puppeteer untuk targeted cleanup

// ─── Fitur: Chat Only ───────────────────────────────────────────────────
// Simpan pesan teks terakhir per nomor WA.
// Digunakan untuk mengulangi pesan terakhir saat user mengirim stiker.
// Map<waNumber, string>
const lastTextByNumber = new Map();

const MAX_RECONNECT = 5;
const INIT_TIMEOUT_MS = 120_000;  // [FIX-1] 120 detik
// Watchdog: jika Promise.race macet (Chrome zombie), paksa kill setelah durasi ini
// Diset lebih besar dari INIT_TIMEOUT_MS agar baru aktif jika timeout JS gagal bekerja
const INIT_WATCHDOG_MS = INIT_TIMEOUT_MS + 15_000; // 135 detik total

// ─── [FIX-3] Helper: Kill Chrome berdasarkan PID tersimpan ────────────────────
// Cross-platform: SIGKILL di Linux/Mac, taskkill di Windows
// [PERF] Menggunakan exec async agar tidak memblokir event loop Node.js
async function killChromeByPid(pid) {
  if (!pid) return;
  return new Promise((resolve) => {
    if (os.platform() === 'win32') {
      // Gunakan PowerShell agar error 'no running instance' tidak muncul ke console
      // [PERF] exec (async) menggantikan execSync — PowerShell spawn tidak memblokir event loop
      exec(
        `powershell -NoProfile -Command "Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue; Get-WmiObject Win32_Process | Where-Object { $_.ParentProcessId -eq ${pid} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
        { timeout: 8000 },
        () => {
          logger.info(` [WhatsApp] Chrome PID ${pid} berhasil dihentikan.`);
          resolve();
        }
      );
    } else {
      // Linux / macOS: coba kill process group dulu, lalu fallback ke kill PID langsung
      // process.kill(-pid) hanya bekerja jika PID adalah process group leader
      try { process.kill(-pid, 'SIGKILL'); } catch (_) {
        // Bukan group leader — langsung kill PID
        try { process.kill(pid, 'SIGKILL'); } catch (_2) { }
      }
      // Fallback: pkill --pgroup untuk memastikan seluruh subtree Chrome ikut mati
      // [PERF] exec (async) menggantikan execSync
      exec(
        `pkill -P ${pid} 2>/dev/null; kill -9 ${pid} 2>/dev/null; true`,
        { timeout: 5000 },
        () => {
          logger.info(` [WhatsApp] Chrome PID ${pid} berhasil dihentikan.`);
          resolve();
        }
      );
    }
  });
}

// ─── [FIX-3] Helper: Kill Chrome Puppeteer berdasarkan session path ───────────
// Windows : PowerShell WMI — hanya Chrome yang command line-nya mengandung 'wwebjs_auth'
// Linux   : pkill berdasarkan pattern argumen --user-data-dir=.../.wwebjs_auth
// Ini TIDAK membunuh Chrome browser biasa milik user.
// [PERF] Menggunakan exec async agar WMI query tidak memblokir event loop
async function killStaleWWebChrome() {
  const platform = os.platform();

  return new Promise((resolve) => {
    if (platform === 'win32') {
      // Windows 11 24H2 menghapus wmic, jadi kita gunakan PowerShell untuk presisi
      // Hanya kill Chrome yang CommandLine-nya mengandung 'wwebjs_auth'
      // [PERF] exec (async) menggantikan execSync — PowerShell WMI tidak lagi blocking
      exec(
        `powershell -NoProfile -Command "Get-WmiObject Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -match 'wwebjs_auth' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
        { timeout: 8000 },
        () => {
          logger.info(' [WhatsApp] Chrome Puppeteer lama dihentikan (targeted by session path).');
          resolve();
        }
      );
    } else if (platform === 'linux' || platform === 'darwin') {
      // pkill berdasarkan pola argumen Chromium/Chrome
      exec(
        `pkill -f "wwebjs_auth" 2>/dev/null || true`,
        { timeout: 4000 },
        () => {
          logger.info(' [WhatsApp] Chrome Puppeteer lama dihentikan (targeted by session path).');
          resolve();
        }
      );
    } else {
      resolve(); // Platform tidak dikenal — lewati
    }
  });
}

/**
 * Inisialisasi WhatsApp Client
 */
async function initWhatsApp() {
  // ── Guard: Cegah double-init ──────────────────────────────────────────────
  if (isInitializing) {
    logger.warn(' [WhatsApp] Inisialisasi sudah berjalan — request ini diabaikan.');
    return;
  }
  isInitializing = true;

  // ── Cleanup client lama ───────────────────────────────────────────────────
  if (waClient) {
    logger.info(' [WhatsApp] Menutup client lama sebelum inisialisasi ulang...');
    try { await waClient.destroy(); } catch (_) { }
    waClient = null;
  }

  // ── [FIX-3] Kill Chrome Puppeteer sesi sebelumnya (TARGETED, bukan global) ─
  // Kill berdasarkan PID tersimpan terlebih dahulu (paling presisi)
  if (chromePid) {
    await killChromeByPid(chromePid);
    chromePid = null;
  }
  // Lalu kill sisa Chrome yang masih punya session path wwebjs_auth di cmdline
  await killStaleWWebChrome();

  // Beri jeda singkat agar OS selesai membebaskan file lock
  // [PERF] Dikurangi dari 500ms → 200ms; exec async di atas sudah selesai saat baris ini dicapai
  await new Promise(r => setTimeout(r, 200));

  let executablePath;

  // ── Deteksi Browser Lintas Platform ──────────────────────────────────────
  const platform = os.platform();
  const localBrowsers = platform === 'darwin'
    ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ]
    : platform === 'win32'
      ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
      ]
      : [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/brave-browser'
      ];

  // 1. Cek Puppeteer internal (Paling aman)
  try {
    const puppeteer = require('puppeteer');
    const p = puppeteer.executablePath();
    if (p && fs.existsSync(p)) {
      executablePath = p;
      logger.info(` [WhatsApp] Menggunakan Puppeteer browser: ${p}`);
    }
  } catch (err) {
    logger.warn(' [WhatsApp] Puppeteer browser module error, mencoba mencari browser lokal...');
  }

  // 2. Fallback ke browser lokal
  if (!executablePath) {
    for (const bPath of localBrowsers) {
      if (fs.existsSync(bPath)) {
        executablePath = bPath;
        logger.info(` [WhatsApp] Menggunakan browser lokal: ${bPath}`);
        break;
      }
    }
  }

  // 3. Konfigurasi Puppeteer (Optimasi Kecepatan & RAM)
  const isWindows = platform === 'win32';
  const isLinux = platform === 'linux';

  const puppeteerArgs = [
    // ── Cross-platform (aman di semua OS) ──
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--metrics-recording-only',
    '--mute-audio',
    '--disable-features=site-per-process',
    '--disable-accelerated-2d-canvas',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-breakpad',
    '--disable-web-security',
    '--disable-component-extensions-with-background-pages',
    '--disable-ipc-flooding-protection',
    '--disable-renderer-backgrounding',
    '--disable-hang-monitor',
    '--disable-client-side-phishing-detection',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-domain-reliability',
    '--disable-infobars',
    '--no-pings',
    '--disable-translate',
    '--hide-scrollbars',
    '--disable-logging',
    '--log-level=3',
    '--js-flags=--max-old-space-size=256',
    // ── Optimasi kecepatan startup ──
    '--disk-cache-size=67108864',   // 64MB disk cache untuk aset WA Web
    '--media-cache-size=33554432',  // 32MB media cache
    // ── [FIX-4] Suppress crash recovery dialog agar tidak block startup ──
    '--disable-session-crashed-bubble',
    // CATATAN: '--blink-settings=imagesEnabled=false' DIHAPUS karena memblokir
    // downloadMedia() saat user mengirim foto. Flag ini mencegah Chromium memuat
    // blob media WhatsApp sehingga msg.downloadMedia() selalu gagal dengan error "r".
    // ── Linux only ──────────────────────────────────────────────────────────
    ...(isLinux ? [
      '--no-sandbox',              // Wajib di Linux tanpa setuid sandbox
      '--disable-setuid-sandbox',  // Hanya relevan di Linux
      '--no-zygote',               // Stabil di Linux headless, tidak dipakai di macOS/Windows
    ] : []),
    // ── macOS only ──────────────────────────────────────────────────────────
    ...(platform === 'darwin' ? [
      '--no-sandbox',              // Diperlukan di beberapa macOS CI environment
    ] : [])
  ];

  const puppeteerConfig = {
    headless: true,
    args: puppeteerArgs,
    // protocolTimeout: timeout tiap CDP command (naik ke 90 detik)
    protocolTimeout: 90_000
  };

  if (isWindows) {
    logger.info(' [WhatsApp] Platform Windows terdeteksi — menggunakan konfigurasi Puppeteer yang kompatibel');
  } else if (isLinux) {
    logger.info(' [WhatsApp] Platform Linux terdeteksi — menggunakan konfigurasi Puppeteer Linux');
  } else {
    logger.info(' [WhatsApp] Platform macOS terdeteksi — menggunakan konfigurasi Puppeteer macOS');
  }

  if (executablePath) {
    puppeteerConfig.executablePath = executablePath;
  } else {
    logger.warn(' [WhatsApp] Tidak menemukan path browser eksplisit. Mengandalkan auto-detect dari Puppeteer.');
  }

  // ── webVersion dari env var ─────────────────────────────────────────────
  const waWebVersion = process.env.WA_WEB_VERSION || null;

  const clientConfig = {
    authStrategy: new LocalAuth({
      dataPath: process.env.WA_SESSION_PATH || './.wwebjs_auth'
    }),
    puppeteer: puppeteerConfig
  };

  // webVersionCache: PENTING! Pin versi WA Web ke rilis stabil (2.2412.54)
  // WhatsApp Web sering mengupdate kode internal (merubah WAWebDownloadManager)
  // yang menyebabkan error "r" saat mendownload media. Mem-pin versi ini
  // menjamin kompatibilitas 100% dengan whatsapp-web.js v1.26.1-alpha.4.
  clientConfig.webVersionCache = {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
  };

  if (waWebVersion) {
    clientConfig.webVersion = waWebVersion;
    logger.info(` [WhatsApp] Menggunakan WA Web versi terpilih: ${waWebVersion} (cache: remote)`);
  } else {
    logger.info(' [WhatsApp] WA_WEB_VERSION di-pin ke 2.2412.54 secara remote untuk stabilitas downloadMedia()');
  }


  waClient = new Client(clientConfig);

  // ── Blokir Image / CSS / Font via Puppeteer Request Interception ─────────
  // (DIHAPUS: Request interception di Puppeteer dapat mengganggu Service Worker
  // WhatsApp Web dan menyebabkan error "r" saat memanggil downloadMedia())


  // ─── Event: QR Code ───────────────────────────────────────────────────────
  waClient.on('qr', (qr) => {
    logger.info('\n [WhatsApp] Scan QR Code berikut di WhatsApp Anda:\n');
    qrcode.generate(qr, { small: true });
    logger.info('\n');
  });

  // ─── Event: Ready ─────────────────────────────────────────────────────────
  // Simpan timestamp saat bot pertama kali siap.
  // Semua pesan yang dikirim SEBELUM timestamp ini adalah pesan offline/pending
  // yang masuk saat bot tidak aktif — harus diabaikan agar bot tidak membalas
  // chat lama secara tiba-tiba setelah restart.
  let botReadyAt = Math.floor(Date.now() / 1000); // Unix timestamp (detik)

  waClient.on('ready', async () => {
    botReadyAt = Math.floor(Date.now() / 1000);
    logger.info(' [WhatsApp] Client siap dan terhubung!');
    logger.info(` [WhatsApp] Nomor: ${waClient.info?.wid?.user || 'N/A'}`);
    logger.info(` [WhatsApp] Pesan sebelum ${new Date(botReadyAt * 1000).toISOString()} akan diabaikan (offline message guard).`);

    // [FIX-3] Simpan Chrome PID untuk targeted cleanup saat shutdown
    try {
      const pid = waClient.pupBrowser?.process()?.pid;
      if (pid) {
        chromePid = pid;
        logger.info(` [WhatsApp] Chrome PID tersimpan: ${chromePid}`);
      }
    } catch (_) { /* pupBrowser belum tersedia — abaikan */ }

    reconnectAttempts = 0;
  });

  // ─── Event: Authenticated ──────────────────────────────────────────────────
  waClient.on('authenticated', () => {
    logger.info(' [WhatsApp] Autentikasi berhasil — session tersimpan');
  });

  // ─── Event: Auth Failure ──────────────────────────────────────────────────
  waClient.on('auth_failure', (msg) => {
    logger.error(` [WhatsApp] Autentikasi gagal: ${msg}`);
  });

  // ─── Event: Disconnected ──────────────────────────────────────────────────
  waClient.on('disconnected', (reason) => {
    logger.info(` [WhatsApp] Terputus: ${reason}`);
    waClient = null;
    chromePid = null;   // [FIX-3] Reset PID saat disconnect

    if (reconnectAttempts >= MAX_RECONNECT) {
      logger.error(' [WhatsApp] Melebihi batas reconnect. Restart manual diperlukan.');
      return;
    }

    reconnectAttempts++;
    const delay = 30000 * reconnectAttempts;
    logger.info(` [WhatsApp] Mencoba reconnect dalam ${delay / 1000}s... (percobaan ${reconnectAttempts}/${MAX_RECONNECT})`);

    setTimeout(async () => {
      try {
        await initWhatsApp();
      } catch (err) {
        logger.error(` [WhatsApp] Reconnect gagal: ${err.message}`);
      }
    }, delay);
  });

  // ─── Dedup stiker: cegah double-reply jika muncul di kedua event ─────────
  // Stiker bisa muncul di KEDUA event ('message' dan 'message_create') sekaligus.
  // Set ini menyimpan ID stiker yang sudah diproses selama 5 detik terakhir.
  const _stickerProcessed = new Set();

  // ─── Helper: Kirim balasan stiker (dengan retry + dedup) ─────────────────
  async function handleStickerReply(msg) {
    const senderFrom = msg.from || '';
    if (senderFrom.includes('@g.us') || senderFrom === 'status@broadcast' || msg.fromMe) return;
    if (!waClient) return;

    // Deduplication: skip jika ID yang sama sudah diproses dalam ~5 detik
    const dedupKey = msg.id?.id || `${senderFrom}_${msg.timestamp}`;
    if (_stickerProcessed.has(dedupKey)) {
      logger.info(`[WhatsApp] Stiker ${dedupKey} sudah diproses — skip duplikat.`);
      return;
    }
    _stickerProcessed.add(dedupKey);
    // Auto-hapus dari Set setelah 5 detik
    setTimeout(() => _stickerProcessed.delete(dedupKey), 5000);

    let waNumSticker;
    try {
      const contact = await msg.getContact();
      waNumSticker = contact.id?.user || senderFrom.replace(/@.*$/, '');
    } catch (_) {
      waNumSticker = senderFrom.replace(/@.*$/, '');
    }

    const lastText = lastTextByNumber.get(waNumSticker);
    const textToSend = lastText || (
      'Halo! \uD83D\uDE0A\n\nSaya adalah *IT Service Desk Bot PLN Batam*.\n' +
      'Ketik pesan perintah yang sesuai\n\n' +
      'Silakan ketik *menu* untuk melihat layanan yang tersedia.'
    );

    const doSend = async () => {
      if (!waClient) throw new Error('waClient belum siap');
      try {
        const chat = await msg.getChat();
        await chat.sendStateTyping();
        await new Promise(r => setTimeout(r, 800 + Math.random() * 1700));
      } catch (typingErr) {
        // Typing indicator gagal, lanjutkan saja kirim pesan
      }
      await waClient.sendMessage(senderFrom, textToSend);
    };

    try {
      await doSend();
      logger.info(`[WhatsApp] Stiker dari ${waNumSticker} dibalas (lastText: ${!!lastText}).`);
    } catch (err) {
      const errMsg = (err && err.message) ? err.message : String(err);
      // Error "r" atau <=2 karakter = transient WA internal — retry sekali
      if (errMsg.length <= 2) {
        logger.warn(`[WhatsApp] Stiker: WA error "${errMsg}" ke ${waNumSticker} — retry 2 detik...`);
        await new Promise(r => setTimeout(r, 2000));
        try {
          await doSend();
          logger.info(`[WhatsApp] Stiker dari ${waNumSticker} — retry berhasil.`);
        } catch (err2) {
          logger.error(`[WhatsApp] Stiker dari ${waNumSticker} — retry juga gagal: ${err2.message}`);
        }
      } else {
        logger.warn(`[WhatsApp] Gagal balas stiker dari ${waNumSticker}: ${errMsg}`);
      }
    }
  }

  // ─── Fallback Stiker via message_create ──────────────────────────────────
  // Di beberapa versi whatsapp-web.js, stiker hanya muncul di 'message_create'.
  waClient.on('message_create', async (msg) => {
    if (msg.fromMe) return;
    if ((msg.from || '').includes('@g.us')) return;
    if (msg.from === 'status@broadcast') return;

    if (msg.type === 'sticker') {
      await handleStickerReply(msg);
    }
  });


  // ─── Sistem Antrean Pesan (Anti-DDoS / Spam Protection) ───────────────────
  class MessageQueue {
    constructor(concurrency = 5, delayMs = 1000, maxLength = 200) {
      this.concurrency = concurrency;
      this.delayMs = delayMs;
      this.maxLength = maxLength;
      this.running = 0;
      this.queue = [];
    }
    async add(task) {
      if (this.queue.length >= this.maxLength) {
        logger.warn('[WhatsApp] Antrean penuh, pesan dibuang untuk mencegah DDoS');
        return Promise.reject(new Error('Antrean penuh'));
      }
      return new Promise((resolve, reject) => {
        this.queue.push(async () => {
          try {
            resolve(await task());
          } catch (err) {
            reject(err);
          } finally {
            this.running--;
            // Jeda 1 detik (1000ms) untuk tiket/antrean ke-11 ke atas sesuai instruksi
            setTimeout(() => this.next(), this.delayMs);
          }
        });
        this.next();
      });
    }
    next() {
      if (this.running >= this.concurrency || this.queue.length === 0) return;
      this.running++;
      const task = this.queue.shift();
      task();
    }
  }
  const botQueue = new MessageQueue(5, 1000, 200);

  // ─── Event: Pesan Masuk ───────────────────────────────────────────────────
  // Catatan: event 'message' hanya menerima pesan MASUK (dari pengguna ke bot),
  // sehingga tidak perlu logika rumit untuk menghindari loop.
  waClient.on('message', async (rawMsg) => {
    const msg = rawMsg;
    // Abaikan: grup, status broadcast, pesan dari bot sendiri
    if (msg.from.includes('@g.us') || msg.from === 'status@broadcast' || msg.fromMe) {
      return;
    }

    // ─── Guard: Abaikan pesan offline (dikirim saat bot tidak aktif) ───────
    // whatsapp-web.js me-replay semua pesan pending saat reconnect.
    // Pesan yang timestamp-nya lebih tua dari botReadyAt adalah pesan offline
    // — diabaikan agar bot tidak membalas chat lama secara tiba-tiba.
    const msgTimestamp = msg.timestamp || 0; // Unix timestamp dalam detik
    if (msgTimestamp > 0 && msgTimestamp < botReadyAt) {
      logger.warn(
        `[WhatsApp] Pesan lama diabaikan (offline guard): dari ${msg.from}, ` +
        `dikirim ${new Date(msgTimestamp * 1000).toISOString()}, ` +
        `bot ready ${new Date(botReadyAt * 1000).toISOString()}`
      );
      return;
    }

    // Ekstrak nomor WA
    let waNumber;
    try {
      const contact = await msg.getContact();
      waNumber = contact.id?.user || msg.from.replace(/@.*$/, '');
    } catch (_) {
      waNumber = msg.from.replace(/@.*$/, '');
    }

    // ─── F4: Whitelist Nomor WA (Dicek Paling Awal) ────────────────────────
    const whitelistEnv = process.env.WA_WHITELIST || '';
    if (whitelistEnv) {
      const whitelist = whitelistEnv.split(',').map(n => n.trim()).filter(Boolean);
      if (whitelist.length > 0 && !whitelist.includes(waNumber)) {
        logger.warn(`[WhatsApp] Nomor tidak diizinkan (bukan whitelist): ${waNumber} — pesan diabaikan`);
        return;
      }
    }

    // Membungkus seluruh logika pemrosesan chat ke dalam keranjang antrean (Maksimal 5)
    botQueue.add(async () => {
      // ── Stiker: tangkap SEBELUM cek hasMedia (hasMedia bisa false di beberapa versi) ──
      if (msg.type === 'sticker') {
        await handleStickerReply(msg);
        return;
      }

      // Abaikan pesan media TAPI izinkan tipe 'image' (agar user bisa kirim foto + caption)
      if (msg.hasMedia && msg.type !== 'image') {
        try {
          const chat = await msg.getChat();
          await chat.sendStateTyping();
          await new Promise(r => setTimeout(r, 800 + Math.random() * 1700));
          await msg.reply(
            'Maaf, saat ini IT Service Desk Bot hanya menerima lampiran berupa *Foto/Gambar* dan pesan teks.\n\n' +
            'Silakan ulangi kembali.'
          );
        } catch (_) { }
        return;
      }

      const msgText = (msg.body || '').trim();
      // Jika tidak ada teks dan tidak ada media, abaikan
      if (!msgText && !msg.hasMedia) return;

    // ─── Kirim ke Message Handler ──────────────────────────────────────────
    // Teruskan `msg` sebagai parameter ke-4 agar handler bisa mengunduh attachment jika perlu.
    await handleMessage(waNumber, msgText, async (replyText, mediaPath = null) => {
      // Simpan pesan balasan terakhir bot (digunakan saat stiker masuk)
      if (replyText) lastTextByNumber.set(waNumber, replyText);

      // ── Typing indicator (tidak kritis — error-nya tidak boleh abort pengiriman) ──
      try {
        const chat = await msg.getChat();
        await chat.sendStateTyping();
      } catch (_) { /* typing indicator gagal — lanjut kirim pesan */ }

      await new Promise(r => setTimeout(r, 800 + Math.random() * 1700));

      // ── Helper: kirim pesan via sendMessage (lebih stabil dari msg.reply) ──────
      // Tidak menggunakan msg.reply() karena WA Web internal JS yang di-minify
      // sering melempar string "r" saat quote-message gagal — sulit di-debug.
      const doSend = async () => {
        if (!waClient) throw new Error('waClient belum siap');
        if (mediaPath) {
          const media = MessageMedia.fromFilePath(mediaPath);
          await waClient.sendMessage(msg.from, media, { caption: replyText });
        } else {
          await waClient.sendMessage(msg.from, replyText);
        }
      };

      // ── Kirim dengan 1x retry untuk error transient WA internal ("r", dll) ────
      // Error ≤2 karakter adalah artefak minifikasi WA Web JS — hampir selalu
      // transient dan berhasil di percobaan kedua setelah jeda singkat.
      try {
        await doSend();
      } catch (err) {
        const errMsg = (err && typeof err === 'object' && err.message)
          ? err.message : String(err);

        if (errMsg.length <= 2) {
          // Transient WA internal error — tunggu 2 detik lalu coba sekali lagi
          logger.warn(`[WhatsApp] WA internal error ("${errMsg}") ke ${waNumber} — retry dalam 2 detik...`);
          await new Promise(r => setTimeout(r, 2000));
          try {
            await doSend();
            logger.info(`[WhatsApp] Retry berhasil — pesan terkirim ke ${waNumber}`);
          } catch (err2) {
            const err2Msg = (err2 && typeof err2 === 'object' && err2.message)
              ? err2.message : String(err2);
            logger.error(`[WhatsApp] Retry juga gagal ke ${waNumber}: "${err2Msg}"`);
          }
        } else {
          // Error bermakna (bukan minifikasi) — langsung log sebagai error
          logger.error(`[WhatsApp] Gagal mengirim balasan ke ${waNumber}: "${errMsg}"`);
        }
      }
    }, msg);
    }); // Penutup botQueue.add
  });

  // ─── Inisialisasi Client ─────────────────────────────────────────────────
  // [FIX-1] Timeout 120 detik via Promise.race
  // [FIX-2] destroy() dipanggil saat init gagal agar Chrome tidak zombie
  // [WATCHDOG] Jika Chrome zombie memblokir Promise.race, watchdog paksa kill setelah 135 detik
  logger.info(` [WhatsApp] Menginisialisasi client... (timeout: ${INIT_TIMEOUT_MS / 1000}s, watchdog: ${INIT_WATCHDOG_MS / 1000}s)`);

  // Watchdog timer: jalan paralel, matikan Chrome secara paksa jika timeout JS tidak bekerja
  const watchdogTimer = setTimeout(async () => {
    logger.error(' [WhatsApp] ⚠ WATCHDOG: Inisialisasi melebihi batas waktu — Chrome zombie terdeteksi. Memaksa kill...');
    const pidToForceKill = chromePid;
    waClient = null;
    chromePid = null;
    isInitializing = false;
    if (pidToForceKill) await killChromeByPid(pidToForceKill);
    await killStaleWWebChrome();
    logger.warn(' [WhatsApp] Watchdog selesai. Jalankan /wa-restart untuk mencoba kembali.');
  }, INIT_WATCHDOG_MS);

  try {
    const initTimeout = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timeout: waClient.initialize() tidak selesai dalam ${INIT_TIMEOUT_MS / 1000} detik`)),
        INIT_TIMEOUT_MS
      )
    );
    await Promise.race([waClient.initialize(), initTimeout]);
    // Inisialisasi berhasil — batalkan watchdog
    clearTimeout(watchdogTimer);

  } catch (err) {
    clearTimeout(watchdogTimer); // Batalkan watchdog karena error sudah ditangani di sini
    logger.error(` [WhatsApp] Gagal menginisialisasi: ${err.message}`);

    // [FIX-2] KRITIS: Simpan referensi client sebelum di-null-kan, lalu destroy
    // agar Chrome Puppeteer tidak terus berjalan di background sebagai zombie.
    const clientToDestroy = waClient;
    const pidToKill = chromePid;
    waClient = null;
    chromePid = null;

    if (clientToDestroy) {
      // Destroy secara async (non-blocking) — initialize() mungkin masih pending
      setImmediate(async () => {
        try {
          await clientToDestroy.destroy();
          logger.info(' [WhatsApp] Chrome Puppeteer dihentikan setelah init gagal.');
        } catch (_) {
          // destroy() gagal — kill secara paksa berdasarkan PID atau session path
          if (pidToKill) await killChromeByPid(pidToKill);
          else await killStaleWWebChrome();
        }
      });
    }

  } finally {
    isInitializing = false;  // Selalu reset flag setelah selesai (berhasil atau gagal)
  }
}

/**
 * Restart WhatsApp Client tanpa mematikan server Express.
 * Dipanggil oleh endpoint POST /wa-restart atau saat disconnect terdeteksi.
 * Berguna untuk recovery cepat tanpa perlu Ctrl+C dan jalankan ulang node.
 */
async function restartWhatsApp() {
  logger.info(' [WhatsApp] Memulai restart client (tanpa restart server)...');
  await closeWhatsApp();
  // Beri jeda agar OS selesai melepas file lock session
  await new Promise(r => setTimeout(r, 2000));
  reconnectAttempts = 0; // Reset counter agar reconnect bisa berjalan penuh
  await initWhatsApp();
  logger.info(' [WhatsApp] Restart selesai.');
}

/**
 * Cek status koneksi WhatsApp
 */
async function getWhatsAppStatus() {
  if (!waClient) {
    return { connected: false, state: 'NO_CLIENT', info: null };
  }

  try {
    const state = await waClient.getState();
    const info = waClient.info || null;
    return {
      connected: state === 'CONNECTED',
      state,
      info: info ? { number: info.wid?.user, platform: info.platform } : null
    };
  } catch (err) {
    return { connected: false, state: 'ERROR', error: err.message };
  }
}

/**
 * Tutup koneksi WhatsApp dengan aman (Graceful Shutdown)
 * [FIX-3] Kill Chrome berdasarkan PID tersimpan, bukan global taskkill
 */
async function closeWhatsApp() {
  logger.info(' [WhatsApp] Menutup client WhatsApp...');

  // ── Langkah 1: Kill Chrome via PowerShell DULU ──────────────────────────
  // Ini harus dilakukan SEBELUM destroy() agar Puppeteer tidak sempat
  // menjalankan taskkill internalnya (yang mencetak ERROR ke console).
  // Setelah Chrome dimatikan, destroy() akan menemukan browser sudah tidak
  // ada dan langsung exit tanpa mencetak apapun.
  if (chromePid) {
    await killChromeByPid(chromePid);
    chromePid = null;
  }
  await killStaleWWebChrome();

  // ── Langkah 2: destroy() sebagai cleanup — Chrome sudah tidak ada ───────
  if (waClient) {
    try {
      await waClient.destroy();
      logger.info(' [WhatsApp] Client berhasil ditutup.');
    } catch (_) {
      // Error expected — Chrome sudah dimatikan di atas, destroy() akan gagal konek ke CDP
      logger.info(' [WhatsApp] Client ditutup (Chrome sudah dihentikan lebih dahulu).');
    } finally {
      waClient = null;
    }
  }
}

/**
 * Kirim pesan teks langsung ke nomor WA tertentu (digunakan oleh webhook balasan admin)
 *
 * @param {string} waNumber - Nomor WA tujuan format 628xxx (tanpa @c.us)
 * @param {string} message  - Teks pesan yang akan dikirim
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function sendMessageToNumber(waNumber, message) {
  if (!waClient) {
    return { success: false, error: 'WhatsApp client belum siap atau belum terhubung.' };
  }

  try {
    const state = await waClient.getState();
    if (state !== 'CONNECTED') {
      return { success: false, error: `WhatsApp tidak terhubung. State: ${state}` };
    }

    // Format nomor ke WhatsApp ID (harus berakhiran @c.us)
    const chatId = waNumber.includes('@c.us') ? waNumber : `${waNumber}@c.us`;
    await waClient.sendMessage(chatId, message);
    logger.info(`[WhatsApp] Balasan admin terkirim ke ${waNumber}`);
    return { success: true };
  } catch (err) {
    logger.error(`[WhatsApp] Gagal kirim balasan ke ${waNumber}: ${err.message}`);

    // ── Deteksi error konteks browser Puppeteer yang rusak ───────────────────
    // Error-error ini terjadi ketika halaman WhatsApp Web di Puppeteer sudah
    // tidak valid (page reload, context destroyed, dll) meski state masih CONNECTED.
    // Solusi: trigger auto-restart WA agar koneksi browser diperbaiki.
    const BROWSER_CONTEXT_ERRORS = [
      'window.require is not a function',
      'Cannot read properties of undefined',
      'Execution context was destroyed',
      'Session closed',
      'Target closed',
      'Protocol error',
    ];

    const isBrowserContextBroken = BROWSER_CONTEXT_ERRORS.some(e => err.message.includes(e));
    if (isBrowserContextBroken && !isInitializing) {
      logger.warn(
        `[WhatsApp] ⚠ Konteks browser WhatsApp rusak ("${err.message.substring(0, 60)}") — ` +
        `memulai restart otomatis dalam 3 detik...`
      );
      setTimeout(async () => {
        try {
          await restartWhatsApp();
          logger.info('[WhatsApp] ✓ Auto-restart setelah browser context error selesai.');
        } catch (restartErr) {
          logger.error(`[WhatsApp] Auto-restart gagal: ${restartErr.message}`);
        }
      }, 3000);
    }

    return { success: false, error: err.message };
  }
}

async function sendMediaToNumber(waNumber, base64Data, mimeType, filename, caption) {
  if (!waClient) {
    return { success: false, error: 'WhatsApp client belum siap atau belum terhubung.' };
  }

  try {
    const state = await waClient.getState();
    if (state !== 'CONNECTED') {
      return { success: false, error: `WhatsApp tidak terhubung. State: ${state}` };
    }

    const chatId = waNumber.includes('@c.us') ? waNumber : `${waNumber}@c.us`;
    const media = new MessageMedia(mimeType, base64Data, filename);
    await waClient.sendMessage(chatId, media, { caption });
    
    logger.info(`[WhatsApp] Balasan media terkirim ke ${waNumber}`);
    return { success: true };
  } catch (err) {
    logger.error(`[WhatsApp] Gagal kirim media ke ${waNumber}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { initWhatsApp, getWhatsAppStatus, closeWhatsApp, restartWhatsApp, sendMessageToNumber, sendMediaToNumber };
