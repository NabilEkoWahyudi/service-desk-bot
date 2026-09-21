/**
 * ═══════════════════════════════════════════════════════════════
 * PM2 ECOSYSTEM CONFIG — IT Service Desk Bot PLN Batam
 * ═══════════════════════════════════════════════════════════════
 *
 * Item 9: Konfigurasi PM2 untuk production deployment.
 * PM2 menggantikan kebutuhan manual restart saat Chrome crash/hang.
 *
 * CARA INSTALL DAN JALANKAN:
 *   npm install -g pm2          ← install PM2 secara global
 *   pm2 start ecosystem.config.js
 *   pm2 save                    ← simpan agar auto-start saat server reboot
 *   pm2 startup                 ← ikuti instruksi yang muncul
 *
 * PERINTAH BERGUNA:
 *   pm2 status                  ← lihat status semua proses
 *   pm2 logs helpdesk-bot       ← lihat log real-time
 *   pm2 restart helpdesk-bot    ← restart manual
 *   pm2 stop helpdesk-bot       ← stop
 *   pm2 monit                   ← monitor CPU & RAM real-time
 */

module.exports = {
  apps: [
    {
      name: 'helpdesk-bot',
      script: 'index.js',
      cwd: './',

      // ─── Memory & Node.js ─────────────────────────────────────
      node_args: '--max-old-space-size=512',

      // ─── Auto Restart on Crash ────────────────────────────────
      // Jika Chrome crash atau bot hang, PM2 restart otomatis.
      autorestart: true,
      max_restarts: 10,               // Maks 10x restart dalam satu window
      min_uptime: '30s',              // Anggap "crash" jika mati sebelum 30 detik
      restart_delay: 5000,            // Tunggu 5 detik sebelum restart (detik)
      exp_backoff_restart_delay: 100, // Backoff exponential jika terus crash

      // ─── Memory Limit ─────────────────────────────────────────
      // Restart otomatis jika RAM melebihi 700MB (Chrome + Node)
      max_memory_restart: '700M',

      // ─── Cron Restart ─────────────────────────────────────────
      // Restart preventif setiap hari jam 04:00 pagi (trafik rendah).
      // Membersihkan memory leak Puppeteer/Chrome yang menumpuk setelah 24 jam.
      cron_restart: '0 4 * * *',

      // ─── Environment ─────────────────────────────────────────
      env: {
        NODE_ENV: 'production'
      },
      env_development: {
        NODE_ENV: 'development'
      },

      // ─── Log Files ───────────────────────────────────────────
      // PM2 menyimpan log sendiri, terpisah dari Winston logs/
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,

      // ─── Watch (Development Only) ─────────────────────────────
      // Set ke true saat development untuk auto-reload saat kode berubah.
      // JANGAN aktifkan di production (akan restart saat file log berubah).
      watch: false,
      ignore_watch: ['node_modules', 'logs', 'generated_pdfs', 'data', '.wwebjs_auth', '.wwebjs_cache']
    }
  ]
};
