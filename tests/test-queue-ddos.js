const crypto = require('crypto');

// Menyalin kelas MessageQueue persis seperti yang ada di whatsapp.service.js
class MessageQueue {
  constructor(concurrency = 10, delayMs = 1000) {
    this.concurrency = concurrency;
    this.delayMs = delayMs;
    this.running = 0;
    this.queue = [];
  }

  async add(task) {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          resolve(await task());
        } catch (err) {
          reject(err);
        } finally {
          this.running--;
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

// Inisialisasi antrean dengan batas 10 barengan dan jeda 1 detik
const botQueue = new MessageQueue(10, 1000);

let selesai = 0;
const totalPesan = 100;
const startTime = Date.now();

console.log(`[TEST] Memulai Simulasi Serangan DDoS (Spam ${totalPesan} Pesan Masuk Bersamaan)`);
console.log(`[TEST] Konfigurasi: Maks 10 Pesan diproses serentak, Jeda antar tarikan antrean 1 Detik.`);
console.log(`-------------------------------------------------------------------------`);

// Fungsi simulasi pemrosesan 1 pesan WhatsApp (butuh waktu acak 100 - 300 ms)
const prosesSatuPesanWA = async (nomorPesan) => {
  const processTime = Math.floor(Math.random() * 200) + 100; // 100ms - 300ms
  
  return new Promise((resolve) => {
    setTimeout(() => {
      selesai++;
      const detikBerjalan = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[Waktu: ${detikBerjalan}s] ✅ Pesan ke-${nomorPesan} selesai diproses (Sisa Antrean: ${totalPesan - selesai})`);
      resolve();
    }, processTime);
  });
};

// Menembakkan 100 pesan secara serentak di milidetik yang sama
for (let i = 1; i <= totalPesan; i++) {
  botQueue.add(() => prosesSatuPesanWA(i));
}

// Menampilkan status berjalannya waktu
const interval = setInterval(() => {
  const detikBerjalan = Math.floor((Date.now() - startTime) / 1000);
  if (selesai === totalPesan) {
    clearInterval(interval);
    console.log(`-------------------------------------------------------------------------`);
    console.log(`🎉 TEST BERHASIL! Seluruh ${totalPesan} pesan selesai diproses.`);
    console.log(`⏱ Total Waktu Nyata: ${detikBerjalan} detik.`);
    console.log(`Perhatikan bahwa pada Detik 0, sepuluh (10) pesan pertama langsung selesai,`);
    console.log(`lalu dilanjutkan 10 pesan berikutnya setiap 1 detik tanpa membebani server.`);
  }
}, 500);
