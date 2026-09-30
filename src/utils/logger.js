const fs = require('fs');
const winston = require('winston');
require('winston-daily-rotate-file');

// S13: Pastikan folder logs/ selalu ada sebelum Winston mencoba menulis ke sana
if (!fs.existsSync('logs')) {
  fs.mkdirSync('logs', { recursive: true });
}

// --- Item 4: Audit Log Redaction ----------------------------------------------
// Filter ini menyensor data sensitif dari semua log entry agar tidak tersimpan
// email pegawai atau konten tiket secara plain text di file log.
const REDACT_PATTERNS = [
  // Email -> tampilkan hanya 2 huruf pertama + domain
  {
    pattern: /([a-zA-Z0-9._%+-]{2})[a-zA-Z0-9._%+-]*(@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g,
    replacement: '$1**$2'
  },
  // Nomor HP/WA (08xxx atau 628xxx) -> sensor 4 digit tengah
  {
    pattern: /(628|08)(\d{2,4})(\d{4})(\d{2,4})/g,
    replacement: '$1$2****$4'
  }
];

function redactSensitive(message) {
  if (typeof message !== 'string') return message;
  let result = message;
  for (const { pattern, replacement } of REDACT_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// Custom Winston format untuk menyensor data sensitif
const redactFormat = winston.format((info) => {
  info.message = redactSensitive(info.message);
  // Juga sensor field 'stack' di error log
  if (info.stack) info.stack = redactSensitive(info.stack);
  return info;
});

// Custom format untuk tampilan console agar rapi
const consoleFormat = winston.format.combine(
  redactFormat(),
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    return `[${timestamp}] ${level}: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
  })
);

// Format JSON murni untuk production log file
const fileFormat = winston.format.combine(
  redactFormat(),
  winston.format.timestamp(),
  winston.format.json()
);

// S5: Log rotation - simpan per hari, maks 14 hari, maks 20MB per file
const rotateTransportCombined = new winston.transports.DailyRotateFile({
  filename: 'logs/combined-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxFiles: '14d',       // hapus log lebih dari 14 hari
  maxSize: '20m',        // rotasi jika file melebihi 20MB
  format: fileFormat,
  zippedArchive: true    // kompres log lama menjadi .gz
});

const rotateTransportError = new winston.transports.DailyRotateFile({
  filename: 'logs/error-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  level: 'error',
  maxFiles: '30d',       // error log simpan lebih lama (30 hari)
  maxSize: '10m',
  format: fileFormat,
  zippedArchive: true
});

const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: fileFormat,
  transports: [
    // Print ke console
    new winston.transports.Console({
      format: consoleFormat
    }),
    // Simpan semua log dengan rotasi harian
    rotateTransportCombined,
    // Simpan hanya error dengan rotasi harian
    rotateTransportError
  ]
});

module.exports = logger;
