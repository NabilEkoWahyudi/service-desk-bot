# IT ServiceDesk Bot — PLN Batam

Bot WhatsApp otomatis (ServiceDesk) khusus untuk melayani pengajuan dan keluhan IT di lingkungan PLN Batam. Sistem ini terintegrasi secara *real-time* dengan **ManageEngine ServiceDesk Plus On-Premise**.

Bot memandu pegawai mengisi formulir request IT secara interaktif, memvalidasi status pegawai langsung ke database ManageEngine, membuat deskripsi tiket resmi dalam format HTML, dan mengirimkan tiket secara otomatis ke sistem IT PLN.

---

## 🚀 Fitur Utama

1. **Integrasi ManageEngine ServiceDesk Plus:**
   - **User Validation:** Memvalidasi email pegawai ke endpoint `GET /api/v3/users` sebelum tiket diizinkan dibuat.
   - **Automated Ticketing:** Mengirim tiket secara langsung ke `POST /api/v3/requests`.
   - **Dynamic Category Mapping:** Subkategori diambil dinamis dari ManageEngine (`GET /api/v3/categories`) dan di-cache selama 1 jam.
   - **Dynamic Config IDs:** Group, Level, dan Service Category ID di-resolve dinamis dari API, dengan fallback ke nilai `.env`.

2. **Webhook & Notifikasi Real-Time:**
   - **Webhook Push (Zero Delay):** ManageEngine langsung POST ke `/webhook/me-notification` setiap ada update tiket.
   - **Adaptive Polling (Backup):** Jika webhook tidak dikonfigurasi, bot poll ManageEngine setiap 15 detik secara otomatis.
   - **Webhook Balasan Admin:** Tim IT dapat membalas tiket dari ManageEngine, bot meneruskan ke WA pegawai via `POST /webhook/reply`.

3. **Workflow Approval Otorisasi:**
   - Tiket kategori Otorisasi oleh staf biasa memerlukan persetujuan atasan (ASMAN) via WhatsApp.
   - Bot kirim pesan APPROVE/REJECT ke atasan, dan notifikasi hasilnya ke pemohon.
   - **Reminder Otomatis:** Jika atasan belum membalas dalam 24 jam, bot mengirim pengingat ulang.

4. **Keamanan & Stabilitas:**
   - **Enkripsi Data (AES-256-GCM):** Session, pending approval, notifikasi tracking, dan rate limit store terenkripsi bila `SESSION_SECRET` di-set.
   - **Rate Limiting & Anti-Spam:** Mencegah spamming tiket dari satu nomor WhatsApp.
   - **WhatsApp Whitelist:** Membatasi nomor WA yang diizinkan menggunakan bot.
   - **Log Redaction:** Menyensor data sensitif (email & nomor WA) di file log.
   - **Input Sanitasi:** Semua input user di-escape HTML sebelum dikirim ke ManageEngine.
   - **SSRF Protection:** URL redirect divalidasi agar hanya ke host ManageEngine yang dikonfigurasi.

---

## 🛠 Struktur Proyek

```
helpdesk/
├── index.js                        # Entry point (Express server + inisialisasi WA)
├── .env                            # Variabel lingkungan (JANGAN commit ke git!)
├── .env.example                    # Template konfigurasi
├── ecosystem.config.js             # Konfigurasi deployment PM2 (production)
├── nginx.conf.example              # Panduan setup HTTPS via NGINX reverse proxy
├── src/
│   ├── config/
│   │   └── endpoints.js            # Mapping kategori tiket & URL ManageEngine
│   ├── handlers/
│   │   └── message.handler.js      # State machine percakapan, rate limiter, anti-spam
│   ├── services/
│   │   ├── whatsapp.service.js     # Engine WhatsApp (whatsapp-web.js + Puppeteer)
│   │   ├── ticket.service.js       # Jembatan API ke ManageEngine (Axios)
│   │   ├── session.service.js      # Manajemen & enkripsi sesi percakapan
│   │   ├── notification.service.js # Polling & webhook notifikasi balasan admin
│   │   ├── approval.service.js     # Workflow approval ASMAN + reminder otomatis
│   │   ├── category.service.js     # Fetch & cache data kategori/subkategori ME
│   │   └── me-config.service.js    # Fetch & cache ID Group/Level/ServiceCategory ME
│   └── utils/
│       ├── validators.js           # Validasi format input pengguna
│       ├── logger.js               # Logging terstruktur (Winston + rotasi harian)
│       └── encrypted-store.js      # Helper baca/tulis file JSON terenkripsi
├── data/                           # Data persisten runtime (tidak di-commit)
│   ├── sessions.json               # Sesi percakapan aktif (terenkripsi)
│   ├── notifications.json          # Tracking tiket yang dipantau (terenkripsi)
│   ├── ratelimit.json              # Rate limit per nomor WA (terenkripsi)
│   └── pending_approvals.json      # Approval menunggu respons atasan (terenkripsi)
└── tests/
    ├── smoke.test.js               # Smoke test HTTP endpoints (tanpa WA/ME)
    ├── unit.validators.test.js     # Unit test validators.js
    └── unit.session.test.js        # Unit test enkripsi AES-256-GCM
```

### 🔄 Alur Kerja Sistem

1. **Inisiasi:** Pegawai mengirim pesan ke nomor WA bot. Bot merespons dengan menu kategori.
2. **Pengisian Form:** Pegawai mengisi data (email, detail request) dalam format angka terurut.
3. **Validasi Pegawai:** Bot mengecek email ke ManageEngine. Jika terdaftar, sistem ambil detail (Nama, Jabatan, Departemen).
4. **Konfirmasi & Pengiriman:** Pegawai balas "OKE" → bot kirim tiket ke ManageEngine dan berikan Nomor Tiket.
5. **Approval (khusus Otorisasi):** Bot kirim notifikasi ke WA atasan untuk APPROVE/REJECT.
6. **Notifikasi Balasan:** Saat teknisi membalas tiket di ManageEngine, webhook/polling memicu bot mengirim notifikasi ke WA pegawai.

---

## ⚙️ Persiapan & Instalasi

### 1. Kebutuhan Sistem
- **Node.js** v18 atau v20 LTS
- **Google Chrome** atau **Chromium** terinstal (engine Puppeteer)
- **PM2** untuk manajemen proses di production

### 2. Instalasi Dependensi
```bash
git clone <repo_url>
cd helpdesk_pln/helpdesk_bu/helpdesk
npm install
```

### 3. Konfigurasi Lingkungan (`.env`)
```bash
cp .env.example .env
```

Lengkapi isinya. **Variabel Paling Penting:**

| Variabel | Keterangan |
|---|---|
| `TECHNICIAN_KEY` | *Technician Key* dari ManageEngine (Admin → API → Technician Key) |
| `SESSION_SECRET` | String acak min. 32 karakter untuk enkripsi semua data di disk |
| `WEBHOOK_SECRET` | Token untuk melindungi endpoint `/webhook/reply` |
| `WA_WHITELIST` | Daftar nomor WA pegawai (contoh: `62812xxx,62856xxx`). Kosongkan = semua diterima |
| `HEALTH_API_KEY` | Token untuk mengamankan endpoint `/health` dan `/wa-restart` |
| `ME_BASE_URL` | URL ManageEngine (contoh: `https://servicedesk.plnbatam.com:8080`) |

---

## 💻 Cara Menjalankan

### A. Mode Development
```bash
npm run dev
```
1. Terminal menampilkan **QR Code**.
2. Buka WhatsApp di HP bot → *Linked Devices* → Pindai QR Code.
3. Bot siap merespons.

### B. Mode Production (Server PLN)
Wajib menggunakan **PM2** agar bot auto-restart jika Chrome crash.

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save          # Simpan agar auto-start saat server reboot
pm2 startup       # Ikuti instruksi yang muncul
```

Pantau status:
```bash
pm2 status
pm2 logs helpdesk-bot
pm2 monit
```

### C. HTTPS (Sangat Direkomendasikan)
Setup NGINX sebagai reverse proxy dengan SSL. Lihat `nginx.conf.example` untuk panduan lengkap.

---

## 🧪 Testing

```bash
# Jalankan semua test
npm test

# Unit test per modul
npm run test:validators   # Test validasi input
npm run test:session      # Test enkripsi AES-256-GCM
npm run test:smoke        # Smoke test HTTP endpoints (tanpa WA/ManageEngine)
```

---

## 🔐 Endpoint API

| Method | Path | Auth | Keterangan |
|---|---|---|---|
| `GET` | `/health` | `HEALTH_API_KEY` (opsional) | Status server & uptime |
| `GET` | `/wa-status` | — | Status koneksi WhatsApp |
| `POST` | `/wa-restart` | `HEALTH_API_KEY` (wajib) | Restart WhatsApp tanpa matikan server |
| `POST` | `/webhook/reply` | `WEBHOOK_SECRET` (opsional) | Kirim balasan admin ke WA pegawai |
| `POST` | `/webhook/me-notification` | — | Push notifikasi dari ManageEngine (zero delay) |
| `POST` | `/admin/refresh-categories` | `HEALTH_API_KEY` (wajib) | Force refresh cache subkategori dari ManageEngine |

---

## 🌿 Environment Variables Lengkap

Lihat file `.env.example` untuk daftar lengkap beserta penjelasan setiap variabel.

Variabel yang dapat dikonfigurasi antara lain:
- `NOTIF_POLL_INTERVAL_MS` — Interval polling notifikasi (default: 15000ms)
- `APPROVAL_REMINDER_HOURS` — Jam sebelum reminder approval dikirim (default: 24)
- `APPROVAL_MAX_DAYS` — Masa berlaku pending approval (default: 7 hari)
- `CATEGORY_CACHE_TTL_MS` — TTL cache subkategori (default: 3600000ms / 1 jam)
- `ME_GROUP_NAME`, `ME_LEVEL_NAME`, `ME_SERVICE_CATEGORY_NAME` — Nama entitas untuk lookup dinamis

**Penting:** Jangan jalankan pembuatan atau pengiriman request di manageengine secara manual, karena akan menyebabkan duplikat tiket dan approval tidak berjalan dengan benar
