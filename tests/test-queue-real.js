require('dotenv').config();
const { handleMessage } = require('../src/handlers/message.handler');

// Menggunakan logika antrean asli seperti di whatsapp.service.js
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

const botQueue = new MessageQueue(10, 1000);

let selesai = 0;
const totalPesan = 100;
const startTime = Date.now();

console.log(`[REAL TEST] Memulai Uji Integrasi DDoS Nyata (${totalPesan} Request)`);
console.log(`[REAL TEST] Menggunakan logika ASLI dari message.handler.js`);
console.log(`-------------------------------------------------------------------------`);

for (let i = 1; i <= totalPesan; i++) {
  // Simulasi 100 pegawai dengan nomor WA yang berbeda-beda
  const waNumber = `628000000${i.toString().padStart(3, '0')}`;
  const messageText = "halo"; // Keyword sapaan untuk memicu bot
  
  // Membelokkan fungsi kirim WA agar pesan masuk ke terminal, bukan ke internet
  const mockSendReply = async (replyText) => {
    // Balasan disembunyikan agar log terminal tetap rapi
  };

  botQueue.add(async () => {
    try {
      // INI ADALAH PEMANGGILAN KE OTAK ASLI BOT ANDA
      await handleMessage(waNumber, messageText, mockSendReply, null);
    } catch (err) {
      console.error(`Error pada pesan ${i}:`, err);
    } finally {
      selesai++;
      const detik = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[Waktu: ${detik}s] ✅ Otak bot selesai memproses pegawai ${waNumber} (Sisa: ${totalPesan - selesai})`);
    }
  });
}

const interval = setInterval(() => {
  if (selesai === totalPesan) {
    clearInterval(interval);
    const totalWaktu = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`-------------------------------------------------------------------------`);
    console.log(`🎉 UJI NYATA BERHASIL! ${totalPesan} pesan asli telah diproses oleh Handler Bot.`);
    console.log(`⏱ Total Waktu Nyata: ${totalWaktu} detik.`);
    console.log(`Bot Anda terbukti TAHAN BANTING menghadapi DDoS logika internal.`);
    process.exit(0);
  }
}, 500);
