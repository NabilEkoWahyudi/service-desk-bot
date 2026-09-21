/**
 * DIAGNOSTIC — IT Help Desk Bot PLN Batam
 * Cara jalankan:
 *   node tests/diagnostic.js
 *   node tests/diagnostic.js --with-http
 *   node tests/diagnostic.js --ticket-id=REQ-0001
 */
'use strict';
require('dotenv').config();
const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const args           = process.argv.slice(2);
const WITH_HTTP      = args.includes('--with-http');
const TICKET_ARG     = args.find(a => a.startsWith('--ticket-id='));
const TEST_TICKET_ID = TICKET_ARG ? TICKET_ARG.split('=')[1] : null;

const C = {
  reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m',
  green:'\x1b[32m', red:'\x1b[31m', yellow:'\x1b[33m', cyan:'\x1b[36m',
  bgRed:'\x1b[41m', bgGreen:'\x1b[42m',
};

const results = { pass:0, fail:0, warn:0, skip:0 };
const failedTests = [];

function pass(l, d=''){results.pass++;console.log(`  ${C.green}v${C.reset} ${l}${d?C.dim+'  ('+d+')'+C.reset:''}`);}
function fail(l, d=''){results.fail++;failedTests.push({l,d});console.log(`  ${C.red}x FAIL${C.reset} ${C.bold}${l}${C.reset}`);if(d)d.split('\n').forEach(s=>console.log(`    ${C.red}-> ${s}${C.reset}`));}
function warn(l, d=''){results.warn++;console.log(`  ${C.yellow}! WARN${C.reset} ${l}`);if(d)console.log(`    ${C.yellow}-> ${d}${C.reset}`);}
function skip(l, r=''){results.skip++;console.log(`  ${C.dim}- SKIP${C.reset}${C.dim} ${l}${r?' ('+r+')':''}${C.reset}`);}
function section(title) {
  console.log(`\n${C.cyan}${C.bold}━━━ ${title} ━━━${C.reset}`);
}

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const ME_BASE_URL     = process.env.ME_BASE_URL || 'https://servicedesk.plnbatam.com';
const TECHNICIAN_KEY  = process.env.TECHNICIAN_KEY || '';
const PORTAL_ID       = process.env.PORTAL_ID || 'SDP';
const PORT            = process.env.PORT || 3000;

const AUTH_HEADERS = {
  'TECHNICIAN_KEY': TECHNICIAN_KEY,
  'PORTALID': PORTAL_ID,
  'Accept': 'application/vnd.manageengine.sdp.v3+json',
};

function testEnvVars(){
  section('1. ENVIRONMENT VARIABLES');
  const req=[
    {k:'TECHNICIAN_KEY', m:'API key ME -- semua API call gagal'},
    {k:'ME_BASE_URL',    m:'URL ManageEngine -- wajib'},
    {k:'PORTAL_ID',      m:'Portal ID ME (biasanya SDP)'},
  ];
  for(const{k,m} of req){
    if(process.env[k]) pass(k, process.env[k].substring(0,25)+'...');
    else fail(k, m);
  }
  const sec=[
    {k:'SESSION_SECRET', m:'Data tersimpan plain JSON -- tidak terenkripsi'},
    {k:'HEALTH_API_KEY', m:'Endpoint /health & /wa-restart terbuka tanpa auth'},
    {k:'WEBHOOK_SECRET', m:'Endpoint /webhook/reply tidak terlindungi'},
  ];
  for(const{k,m} of sec){
    const v=process.env[k]||'';
    if(!v) warn(k+' tidak di-set', m);
    else if(v.includes('ganti_dengan')||v.length<16) warn(k+' terlalu lemah','Gunakan string acak min. 32 karakter');
    else pass(k, 'terisi ('+v.length+' karakter)');
  }
  const opt=['WA_WHITELIST','RATE_LIMIT_MAX','APPROVAL_REMINDER_HOURS',
             'NOTIF_POLL_INTERVAL_MS','CATEGORY_CACHE_TTL_MS'];
  for(const k of opt){
    if(process.env[k]) pass(k+' (opsional)', process.env[k]);
    else skip(k, 'nilai default aktif');
  }
}

function testFileSystem(){
  section('2. FILE SYSTEM & DIREKTORI');
  const ROOT=path.join(__dirname,'..');
  const dirs=[
    {p:'data', req:true, d:'Data runtime'},
    {p:'logs', req:true, d:'Log files'},
    {p:'src',  req:true, d:'Source code'},
  ];
  for(const{p,req,d} of dirs){
    const full=path.join(ROOT,p);
    if(fs.existsSync(full)){
      try{
        const tmp=path.join(full,'._diag_');
        fs.writeFileSync(tmp,'ok'); fs.unlinkSync(tmp);
        pass(p+'/', d+' -- writable');
      }catch(e){fail(p+'/', 'Tidak bisa ditulis: '+e.message);}
    }else if(req){
      fail(p+'/', 'Tidak ditemukan. Buat: mkdir '+p);
    }else warn(p+'/', 'Belum ada');
  }
  const dataFiles=['data/sessions.json','data/notifications.json',
                   'data/ratelimit.json','data/pending_approvals.json'];
  for(const f of dataFiles){
    const full=path.join(ROOT,f);
    if(!fs.existsSync(full)){skip(f,'belum ada, dibuat saat bot berjalan');continue;}
    try{
      const raw=fs.readFileSync(full,'utf8').trim();
      if(!raw){warn(f,'File kosong');continue;}
      if(raw.startsWith('{')||raw.startsWith('[')){JSON.parse(raw);pass(f,'plain JSON valid');}
      else pass(f,'terenkripsi');
    }catch(e){fail(f,'Parse error: '+e.message);}
  }
  const assets=path.join(ROOT,'src/assets');
  if(!fs.existsSync(assets)) warn('src/assets/','Tidak ada -- logo dari URL eksternal saja');
  else{
    const files=fs.readdirSync(assets);
    if(files.length===0) warn('src/assets/','Kosong -- simpan logo PLN lokal di sini');
    else pass('src/assets/', files.join(', '));
  }
}

function testWhatsAppAuth(){
  section('2A. WHATSAPP WEB AUTHENTICATION');
  const ROOT=path.join(__dirname,'..');
  const authDir=path.join(ROOT,'.wwebjs_auth');
  if(!fs.existsSync(authDir)){
    warn('.wwebjs_auth/','Folder sesi WhatsApp tidak ditemukan. Bot belum login atau baru di-reset.');
  }else{
    const files=fs.readdirSync(authDir);
    if(files.length>0){
      pass('.wwebjs_auth/',`Ditemukan dengan ${files.length} item. Sesi kemungkinan tersimpan.`);
    }else{
      warn('.wwebjs_auth/','Folder ada tapi kosong. Bot perlu memindai kode QR ulang.');
    }
  }
}

function testLogFiles(){
  section('2B. LOG FILES');
  const ROOT=path.join(__dirname,'..');
  const logDir=path.join(ROOT,'logs');
  if(!fs.existsSync(logDir)){
    skip('logs/','Folder log belum dibuat.');
    return;
  }
  let totalSize=0;
  try{
    const files=fs.readdirSync(logDir);
    let count=0;
    for(const f of files){
      if(f.endsWith('.log')){
        count++;
        const stat=fs.statSync(path.join(logDir,f));
        totalSize+=stat.size;
      }
    }
    const mb=(totalSize/(1024*1024)).toFixed(2);
    if(totalSize>50*1024*1024){ // >50MB
      warn(`Total ukuran log (${count} file)`,`${mb} MB -- lumayan besar, pastikan rotasi log berjalan.`);
    }else if(count>0){
      pass(`Total ukuran log (${count} file)`,`${mb} MB`);
    }else{
      skip('logs/','Folder log ada tapi tidak berisi file .log');
    }
  }catch(e){
    fail('Cek folder logs',e.message);
  }
}

async function testPort(){
  section('2C. KETERSEDIAAN PORT');
  const net = require('net');
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        warn(`Port ${PORT}`, `Sudah digunakan. Jika bot sedang berjalan, ini normal. Jika bot mati, berarti ada aplikasi lain (atau bot nyangkut) di port ini.`);
      } else {
        fail(`Port ${PORT}`, `Gagal mengecek port: ${err.message}`);
      }
      resolve();
    });
    server.once('listening', () => {
      server.close();
      pass(`Port ${PORT}`, `Tersedia dan siap digunakan oleh bot.`);
      resolve();
    });
    server.listen(PORT);
  });
}

function testSyntax(){
  section('2D. SYNTAX CHECK (node -c)');
  const { execSync } = require('child_process');
  const ROOT = path.join(__dirname, '..');
  
  function getJs(dir, list = []) {
    if(!fs.existsSync(dir)) return list;
    for(const f of fs.readdirSync(dir)){
      const p = path.join(dir, f);
      if(fs.statSync(p).isDirectory()) getJs(p, list);
      else if(p.endsWith('.js')) list.push(p);
    }
    return list;
  }

  const files = [
    path.join(ROOT, 'index.js'),
    path.join(ROOT, 'ecosystem.config.js'),
    ...getJs(path.join(ROOT, 'src'))
  ];

  let errs = 0;
  for(const f of files){
    if(!fs.existsSync(f)) continue;
    try{
      // node -c mengecek syntax tanpa mengeksekusi kode
      execSync(`node -c "${f}"`, { stdio: 'pipe' });
    }catch(e){
      errs++;
      const output = e.stderr ? e.stderr.toString().trim().split('\n')[0] : e.message;
      fail(`Syntax Error di ${path.relative(ROOT, f)}`, output);
    }
  }
  
  if(errs === 0){
    pass('Pengecekan Syntax', `${files.length} file JS diperiksa, tidak ada error`);
  }
}

function testDependencies() {
  section('2E. DEPENDENCIES & NODE VERSION');
  const ROOT = path.join(__dirname, '..');
  
  // Cek versi Node.js
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.replace('v', '').split('.')[0], 10);
  if (major >= 16) {
    pass('Node.js Version', `${nodeVersion} (Optimal)`);
  } else if (major >= 14) {
    warn('Node.js Version', `${nodeVersion} (Minimal v14, direkomendasikan >= v16)`);
  } else {
    fail('Node.js Version', `${nodeVersion} (Versi terlalu lama, bisa bermasalah dengan Puppeteer/whatsapp-web.js)`);
  }

  // Cek node_modules
  const nodeModulesPath = path.join(ROOT, 'node_modules');
  if (fs.existsSync(nodeModulesPath)) {
    // Cek modul krusial
    const criticalModules = ['whatsapp-web.js', 'puppeteer', 'axios', 'express'];
    let missing = [];
    for (const mod of criticalModules) {
      if (!fs.existsSync(path.join(nodeModulesPath, mod))) {
        missing.push(mod);
      }
    }
    
    if (missing.length === 0) {
      pass('node_modules/', `Modul krusial terinstal (${criticalModules.join(', ')})`);
    } else {
      fail('node_modules/', `Modul hilang: ${missing.join(', ')}. Jalankan: npm install`);
    }
  } else {
    fail('node_modules/', 'Folder tidak ditemukan! Wajib menjalankan perintah: npm install');
  }
}

async function testInternet() {
  section('2F. KONEKSI INTERNET (WHATSAPP)');
  try {
    const t0 = Date.now();
    // Gunakan axios get biasa ke web.whatsapp.com untuk memastikan server tidak diblokir firewall
    const resp = await axios.get('https://web.whatsapp.com', { timeout: 10000 });
    const ms = Date.now() - t0;
    if (resp.status === 200) {
      pass('Ping web.whatsapp.com', `HTTP 200 -- ${ms}ms (Bebas blokir firewall)`);
    } else {
      warn('Ping web.whatsapp.com', `HTTP ${resp.status}`);
    }
  } catch (e) {
    fail('Ping web.whatsapp.com', `Gagal terhubung (${e.message}). Cek koneksi internet VPS atau konfigurasi firewall.`);
  }
}

function testSecurity() {
  section('2G. SECURITY & GITIGNORE');
  const ROOT = path.join(__dirname, '..');
  
  // 1. Cek isi .gitignore
  const gitignorePath = path.join(ROOT, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const gitignore = fs.readFileSync(gitignorePath, 'utf8');
    const mustIgnore = ['.env', 'data', 'logs', '.wwebjs_auth', 'node_modules'];
    let leak = false;
    for (const item of mustIgnore) {
      // Cek apakah ada baris yang mengandung item tersebut secara kasar
      const regex = new RegExp(`^\\s*\\/?${item}\\/?\\s*$`, 'm');
      if (!regex.test(gitignore) && !gitignore.includes(item)) {
        fail('Gitignore Leak', `Aturan untuk "${item}" tidak ada di .gitignore! Data sensitif berisiko ter-commit ke Git.`);
        leak = true;
      }
    }
    if (!leak) {
      pass('.gitignore', 'Aturan pengecualian untuk file rahasia (.env, data, logs, auth) sudah aman');
    }
  } else {
    fail('.gitignore', 'File .gitignore TIDAK DITEMUKAN! Risiko kebocoran source code dan API Key sangat tinggi.');
  }

  // 2. Evaluasi kekuatan Secret Key (bila diisi)
  const weakSecrets = [];
  const envKeys = ['SESSION_SECRET', 'WEBHOOK_SECRET', 'HEALTH_API_KEY'];
  for (const k of envKeys) {
    const val = process.env[k] || '';
    if (val && (val.length < 24 || val.toLowerCase().includes('ganti_dengan') || val.toLowerCase().includes('secret'))) {
      weakSecrets.push(k);
    }
  }
  
  if (weakSecrets.length > 0) {
    warn('Weak Secret Keys', `Nilai rentas ditebak. Ganti dengan string acak >= 24 karakter: ${weakSecrets.join(', ')}`);
  } else if (process.env.SESSION_SECRET || process.env.HEALTH_API_KEY) {
    pass('Secret Keys', 'Panjang dan kekuatan secret key memadai');
  } else {
    skip('Secret Keys', 'Tidak ada secret key yang di-set di .env');
  }
}

function testEncryption(){
  section('3. ENKRIPSI AES-256-GCM');
  if(!process.env.SESSION_SECRET){warn('Enkripsi tidak aktif','Set SESSION_SECRET di .env');return;}
  try{
    const secret=process.env.SESSION_SECRET;
    const key=crypto.createHash('sha256').update(secret).digest();
    const iv=crypto.randomBytes(12);
    const c=crypto.createCipheriv('aes-256-gcm',key,iv);
    const plain=JSON.stringify({test:'diagnostic',ts:Date.now()});
    const enc=Buffer.concat([c.update(plain,'utf8'),c.final()]);
    const tag=c.getAuthTag();
    const token=`${iv.toString('hex')}|${tag.toString('hex')}|${enc.toString('base64')}`;
    const[ivH,tagH,ciphB]=token.split('|');
    const d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(ivH,'hex'));
    d.setAuthTag(Buffer.from(tagH,'hex'));
    const dec=d.update(Buffer.from(ciphB,'base64'),'binary','utf8')+d.final('utf8');
    const parsed=JSON.parse(dec);
    if(parsed.test==='diagnostic') pass('AES-256-GCM encrypt -> decrypt','Data cocok setelah round-trip');
    else fail('AES-256-GCM','Data tidak cocok setelah decrypt');
  }catch(e){fail('AES-256-GCM', e.message);}
}

function testValidators(){
  section('4. INPUT VALIDATORS');
  let validateField, parseNumberedList;
  try{({validateField,parseNumberedList}=require('../src/utils/validators'));pass('Load validators.js');}
  catch(e){fail('Load validators.js',e.message);return;}

  const emailTests=[
    {v:'user@plnbatam.com', e:true,  l:'Email valid @plnbatam.com'},
    {v:'user@gmail.com',    e:false, l:'Email Gmail ditolak'},
    {v:'invalid-email',     e:false, l:'Format email salah ditolak'},
    {v:'',                  e:false, l:'Email kosong ditolak'},
  ];
  for(const{v,e,l} of emailTests){
    const r=validateField('requester',v);
    if(r.valid===e) pass(l);
    else fail(l, `valid=${r.valid} (expected ${e}), msg: ${r.message||'-'}`);
  }
  const fieldTests=[
    {f:'nama_aplikasi', v:'SIMKEU',       e:true,  l:'Nama aplikasi valid'},
    {f:'nama_aplikasi', v:'A',            e:false, l:'Nama aplikasi terlalu pendek'},
    {f:'keluhan',       v:'Printer rusak sejak pagi', e:true,  l:'Keluhan valid'},
    {f:'keluhan',       v:'Rusak',        e:false, l:'Keluhan terlalu singkat'},
  ];
  for(const{f,v,e,l} of fieldTests){
    const r=validateField(f,v);
    if(r.valid===e) pass(l);
    else fail(l, `valid=${r.valid} (expected ${e})`);
  }
  const r1=parseNumberedList('1. user@plnbatam.com\n2. SIMKEU',2);
  if(JSON.stringify(r1)===JSON.stringify(['user@plnbatam.com','SIMKEU'])) pass('parseNumberedList "1. value"');
  else fail('parseNumberedList "1. value"','Hasil: '+JSON.stringify(r1));
  const r2=parseNumberedList('bukan format',2);
  if(r2===null) pass('parseNumberedList format salah return null');
  else fail('parseNumberedList format salah return null','Hasilnya: '+JSON.stringify(r2));
}

function testSessionService(){
  section('5. SESSION SERVICE');
  let loadSessions, saveSessions;
  try{({loadSessions,saveSessions}=require('../src/services/session.service'));pass('Load session.service.js');}
  catch(e){fail('Load session.service.js',e.message);return;}
  try{
    const s=loadSessions();
    pass('loadSessions()', s.size+' sesi aktif di disk');
  }catch(e){fail('loadSessions()', e.message);return;}
  try{
    const tmp=new Map();
    tmp.set('_diagnostic_test',{state:'IDLE',category:null,data:{},lastActivity:Date.now()});
    saveSessions(tmp);
    const r=loadSessions();
    r.delete('_diagnostic_test');
    saveSessions(r);
    pass('saveSessions() + reload','Tulis dan baca ulang berhasil');
  }catch(e){fail('saveSessions()', e.message);}
}

async function testMEConnectivity(){
  section('6. KONEKTIVITAS MANAGEENGINE');
  if(!TECHNICIAN_KEY||!ME_BASE_URL){fail('Konektivitas ME','TECHNICIAN_KEY atau ME_BASE_URL tidak di-set');return;}
  try{
    const t0=Date.now();
    const resp=await axios.get(`${ME_BASE_URL}/api/v3/users`,{
      headers:AUTH_HEADERS,
      params:{input_data:JSON.stringify({list_info:{row_count:1,start_index:1}})},
      timeout:10000, validateStatus:()=>true,
    });
    const ms=Date.now()-t0;
    if(resp.status===200){
      pass('Koneksi ke ManageEngine', `HTTP 200 -- ${ms}ms`);
      pass('Autentikasi TECHNICIAN_KEY','Key diterima -- akun valid');
    }else if(resp.status===401||resp.status===403){
      pass('Koneksi ke ManageEngine', `HTTP ${resp.status} -- server merespons (${ms}ms)`);
      fail('Autentikasi TECHNICIAN_KEY',
        `HTTP ${resp.status} -- Key DITOLAK. `+
        (resp.data?.response_status?.messages?.[0]?.message||'Tidak ada pesan error'));
    }else{
      warn('Koneksi ke ManageEngine',`HTTP ${resp.status} -- ${ms}ms`);
    }
  }catch(e){
    const map={ECONNREFUSED:'Server tidak dapat dijangkau',ENOTFOUND:'Hostname tidak bisa diresolv -- cek ME_BASE_URL',ETIMEDOUT:'Timeout 10 detik',ECONNABORTED:'Timeout 10 detik'};
    fail('Koneksi ke '+ME_BASE_URL, map[e.code]||e.message);
  }
}

async function testUserLookup(){
  section('7. USER LOOKUP API');
  if(!TECHNICIAN_KEY||!ME_BASE_URL){skip('User Lookup','TECHNICIAN_KEY atau ME_BASE_URL tidak di-set');return;}
  try{
    const resp=await axios.get(`${ME_BASE_URL}/api/v3/users`,{
      headers:AUTH_HEADERS,
      params:{input_data:JSON.stringify({list_info:{row_count:1,start_index:1,search_fields:{email_id:'diagnostic.test@plnbatam.com'}}})},
      timeout:10000, validateStatus:()=>true,
    });
    if(resp.status===200){
      const users=resp.data?.users||[];
      pass('GET /api/v3/users (search email)','Endpoint OK -- '+users.length+' result email dummy');
      if(resp.data?.list_info) pass('Struktur response','Field list_info ada');
      else warn('Struktur response','Field list_info tidak ada');
    }else if(resp.status===401||resp.status===403){
      fail('GET /api/v3/users',`HTTP ${resp.status} -- `+(resp.data?.response_status?.messages?.[0]?.message||'Unauthorized'));
    }else{
      warn('GET /api/v3/users',`HTTP ${resp.status}`);
    }
  }catch(e){fail('GET /api/v3/users',e.message);}
}

async function testCategoryAPI(){
  section('8. CATEGORY & SUBCATEGORY API');
  if(!TECHNICIAN_KEY||!ME_BASE_URL){skip('Category API','TECHNICIAN_KEY tidak di-set');return;}
  try{
    const resp=await axios.get(`${ME_BASE_URL}/api/v3/categories`,{
      headers:AUTH_HEADERS,
      params:{input_data:JSON.stringify({list_info:{row_count:20,start_index:1}})},
      timeout:15000, validateStatus:()=>true,
    });
    if(resp.status===200){
      const cats=resp.data?.categories||[];
      pass('GET /api/v3/categories',`${cats.length} kategori ditemukan`);
      if(cats.length>0){
        const cat=cats[0];
        const sub=await axios.get(`${ME_BASE_URL}/api/v3/categories/${cat.id}/subcategories`,{
          headers:AUTH_HEADERS,
          params:{input_data:JSON.stringify({list_info:{row_count:5,start_index:1}})},
          timeout:10000, validateStatus:()=>true,
        });
        if(sub.status===200){
          const subs=sub.data?.subcategories||[];
          pass(`Subcategories untuk "${cat.name}"`,`${subs.length} subkategori`);
        }else warn('GET subcategories',`HTTP ${sub.status}`);
      }
    }else if(resp.status===401||resp.status===403){
      fail('GET /api/v3/categories',`HTTP ${resp.status} -- Key tidak punya izin`);
    }else warn('GET /api/v3/categories',`HTTP ${resp.status}`);
  }catch(e){fail('GET /api/v3/categories',e.message);}
}

async function testApprovalAPI(){
  section('9. APPROVAL API -- Diagnosa Error "Not Authorized"');
  if(!TECHNICIAN_KEY||!ME_BASE_URL){skip('Approval API','TECHNICIAN_KEY tidak di-set');return;}
  if(!TEST_TICKET_ID){
    console.log(`  ${C.dim}  Jalankan: node tests/diagnostic.js --ticket-id=REQ-0001${C.reset}`);
    skip('Approval API','Tambahkan --ticket-id=<nomor> untuk aktifkan');
    return;
  }

  let levelId=null, approvalId=null;
  try{
    const resp=await axios.get(`${ME_BASE_URL}/api/v3/requests/${TEST_TICKET_ID}/approval_levels`,
      {headers:AUTH_HEADERS, timeout:10000, validateStatus:()=>true});
    if(resp.status===200){
      const levels=resp.data?.approval_levels||[];
      pass(`GET approval_levels tiket ${TEST_TICKET_ID}`,`${levels.length} level`);
      if(levels.length>0){
        levelId=levels[0].level_number??levels[0].id;
        const subR=await axios.get(
          `${ME_BASE_URL}/api/v3/requests/${TEST_TICKET_ID}/approval_levels/${levelId}/approvals`,
          {headers:AUTH_HEADERS, timeout:10000, validateStatus:()=>true});
        if(subR.status===200){
          const approvals=subR.data?.approvals||[];
          pass(`GET approvals level ${levelId}`,`${approvals.length} approval`);
          if(approvals.length>0){
            approvalId=approvals[0].id;
            console.log(`    ${C.dim}Approver: ${approvals[0].approver?.name||'?'} (ME ID: ${approvals[0].approver?.id||'?'})${C.reset}`);
            console.log(`    ${C.dim}Status  : ${approvals[0].approval_status?.name||'?'}${C.reset}`);
          }else warn('Approvals','Tidak ada approval di level ini');
        }else fail(`GET approvals level ${levelId}`,`HTTP ${subR.status}`);
      }else warn('Approval levels','Tiket tidak punya level -- mungkin bukan tiket AUTORISASI');
    }else if(resp.status===404){
      fail(`GET approval_levels tiket ${TEST_TICKET_ID}`,'Tiket tidak ditemukan -- cek nomor tiket');
    }else{
      fail(`GET approval_levels`,`HTTP ${resp.status} -- `+(resp.data?.response_status?.messages?.[0]?.message||'Error'));
    }
  }catch(e){fail('GET approval_levels', e.message);}

  // ── PUT /_approve DINONAKTIFKAN — berisiko meng-approve tiket sungguhan ──
  // Aktifkan kembali dengan menghapus tanda komentar jika diperlukan untuk debug.
  //
  // if(levelId&&approvalId){
  //   console.log(`\n  -> Menguji PUT /_approve (level=${levelId}, approval=${approvalId})...`);
  //   try{
  //     const params=new URLSearchParams();
  //     params.append('input_data',JSON.stringify({approval:{comments:'[DIAGNOSTIC TEST]'}}));
  //     const resp=await axios.put(
  //       `${ME_BASE_URL}/api/v3/requests/${TEST_TICKET_ID}/approval_levels/${levelId}/approvals/${approvalId}/_approve`,
  //       params,
  //       {headers:{...AUTH_HEADERS,'Content-Type':'application/x-www-form-urlencoded'},timeout:10000,validateStatus:()=>true}
  //     );
  //     if(resp.status===200||resp.status===201){
  //       pass('PUT /_approve', `HTTP ${resp.status} -- BERHASIL! Key punya izin approve`);
  //     }else if(resp.status===401||resp.status===403){
  //       const msg=resp.data?.response_status?.messages?.[0]?.message||JSON.stringify(resp.data).substring(0,150);
  //       fail('PUT /_approve -- ERROR NOT AUTHORIZED',
  //         `HTTP ${resp.status}: "${msg}"\n`+
  //         `DIAGNOSA: Key bukan approver tiket ini di ManageEngine.\n`+
  //         `SOLUSI 1: Buat akun SDAdmin di ME -> ambil key-nya -> update TECHNICIAN_KEY di .env\n`+
  //         `SOLUSI 2: Admin ME -> Technicians -> edit akun -> set role SDAdmin`
  //       );
  //     }else if(resp.status===400){
  //       warn('PUT /_approve',`HTTP 400 -- Detail: `+(resp.data?.response_status?.messages?.[0]?.message||'?'));
  //     }else warn('PUT /_approve',`HTTP ${resp.status}`);
  //     }catch(e){fail('PUT /_approve', e.message);}
  //   }
  // }

  if(levelId&&approvalId){
    skip('PUT /_approve (dinonaktifkan)','Hapus komentar di diagnostic.js untuk mengaktifkan');
  }
}

async function testMEConfigIDs(){
  section('10. ME CONFIG IDs (Group / Level / Service Category)');
  if(!TECHNICIAN_KEY||!ME_BASE_URL){skip('ME Config IDs','TECHNICIAN_KEY tidak di-set');return;}
  const entities=[
    {endpoint:'/api/v3/support_groups',    key:'support_groups',
     name:process.env.ME_GROUP_NAME||'Aplikasi',            envId:process.env.ME_GROUP_ID||'4',            envKey:'ME_GROUP_ID'},
    {endpoint:'/api/v3/levels',            key:'levels',
     name:process.env.ME_LEVEL_NAME||'Tier 2 - Request',   envId:process.env.ME_LEVEL_ID||'2',            envKey:'ME_LEVEL_ID'},
    {endpoint:'/api/v3/service_categories',key:'service_categories',
     name:process.env.ME_SERVICE_CATEGORY_NAME||'Manajemen User', envId:process.env.ME_SERVICE_CATEGORY_ID||'8', envKey:'ME_SERVICE_CATEGORY_ID'},
  ];
  for(const{endpoint,key,name,envId,envKey} of entities){
    try{
      const resp=await axios.get(`${ME_BASE_URL}${endpoint}`,{
        headers:AUTH_HEADERS,
        params:{input_data:JSON.stringify({list_info:{row_count:100,start_index:1,search_fields:{name}}})},
        timeout:10000, validateStatus:()=>true,
      });
      if(resp.status===200){
        const items=resp.data?.[key]||[];
        const found=items.find(i=>i.name?.toLowerCase()===name.toLowerCase());
        if(found){
          if(String(found.id)===String(envId)) pass(`${key}: "${name}"`,`ID=${found.id} cocok dengan ${envKey}`);
          else warn(`${key}: "${name}"`,`ID di API=${found.id} vs ${envKey}=${envId} di .env -- TIDAK COCOK`);
        }else warn(`${key}: "${name}"`,`Nama tidak ditemukan -- fallback ke ID ${envId}`);
      }else warn(`${key}`,`HTTP ${resp.status}`);
    }catch(e){fail(`${key}`, e.message);}
  }
}

async function testHTTPEndpoints(){
  section('11. HTTP ENDPOINTS BOT (port '+PORT+')');
  if(!WITH_HTTP){skip('HTTP Endpoints','Jalankan dengan --with-http (bot harus aktif)');return;}
  const BASE=`http://localhost:${PORT}`;

  try{
    const resp=await axios.get(`${BASE}/health`,{
      timeout:4000, validateStatus:()=>true,
      headers:process.env.HEALTH_API_KEY?{'x-api-key':process.env.HEALTH_API_KEY}:{},
    });
    if(resp.status===200) pass('GET /health',`status="${resp.data?.status}", uptime=${Math.floor(resp.data?.uptime||0)}s`);
    else if(resp.status===401) warn('GET /health','HTTP 401 -- set HEALTH_API_KEY di header');
    else fail('GET /health',`HTTP ${resp.status}`);
  }catch(e){fail('GET /health', e.code==='ECONNREFUSED'?`Bot tidak berjalan di port ${PORT}`:e.message);}

  try{
    const resp=await axios.get(`${BASE}/wa-status`,{timeout:5000, validateStatus:()=>true});
    if(resp.status===200){
      const s=resp.data;
      if(s.connected) pass('GET /wa-status',`CONNECTED`);
      else warn('GET /wa-status',`state=${s.state} -- WhatsApp belum terhubung`);
    }else fail('GET /wa-status',`HTTP ${resp.status}`);
  }catch(e){fail('GET /wa-status', e.code==='ECONNREFUSED'?`Bot tidak berjalan di port ${PORT}`:e.message);}

  // ── POST /admin/refresh-categories DINONAKTIFKAN ──────────────────────────
  // Memicu fetch ulang semua data kategori dari ManageEngine (bisa lambat).
  // Aktifkan kembali dengan menghapus tanda komentar jika diperlukan.
  //
  // if(process.env.HEALTH_API_KEY){
  //   try{
  //     const resp=await axios.post(`${BASE}/admin/refresh-categories`,{},{
  //       headers:{Authorization:`Bearer ${process.env.HEALTH_API_KEY}`},
  //       timeout:30000, validateStatus:()=>true,
  //     });
  //     if(resp.status===200) pass('POST /admin/refresh-categories',`${resp.data?.totalEntries} entri di-refresh`);
  //     else if(resp.status===401) fail('POST /admin/refresh-categories','HTTP 401 -- token salah');
  //     else if(resp.status===403) warn('POST /admin/refresh-categories','HTTP 403 -- HEALTH_API_KEY belum di-set di bot');
  //     else fail('POST /admin/refresh-categories',`HTTP ${resp.status}`);
  //   }catch(e){fail('POST /admin/refresh-categories',e.message);}
  // }else skip('POST /admin/refresh-categories','HEALTH_API_KEY tidak di-set');

  skip('POST /admin/refresh-categories (dinonaktifkan)','Hapus komentar di diagnostic.js untuk mengaktifkan');
}

function printSummary(){
  const total=results.pass+results.fail+results.warn+results.skip;
  console.log('\n'+C.bold+'='.repeat(60)+C.reset);
  console.log(C.bold+' RINGKASAN DIAGNOSTIK'+C.reset);
  console.log('-'.repeat(60));
  console.log(`  ${C.green}v PASS${C.reset}  : ${results.pass}`);
  console.log(`  ${C.red}x FAIL${C.reset}  : ${results.fail}`);
  console.log(`  ${C.yellow}! WARN${C.reset}  : ${results.warn}`);
  console.log(`  ${C.dim}- SKIP${C.reset}  : ${results.skip}`);
  console.log('-'.repeat(60));
  console.log(`  Total   : ${total} tes`);
  if(failedTests.length>0){
    console.log('\n'+C.red+C.bold+' DAFTAR KEGAGALAN:'+C.reset);
    for(const{l,d} of failedTests){
      console.log(`  ${C.red}x${C.reset} ${l}`);
      if(d) d.split('\n').forEach(s=>{if(s.trim())console.log(`      ${C.dim}${s}${C.reset}`);});
    }
  }
  console.log('\n'+'-'.repeat(60));
  if(results.fail===0) console.log(C.bgGreen+C.bold+'  SEMUA TES LULUS  '+C.reset+'\n');
  else console.log(C.bgRed+C.bold+`  ADA ${results.fail} KEGAGALAN -- Periksa detail di atas  `+C.reset+'\n');
  if(!WITH_HTTP) console.log(C.dim+'Tip: --with-http -> uji endpoint HTTP (bot harus berjalan)'+C.reset);
  if(!TEST_TICKET_ID) console.log(C.dim+'Tip: --ticket-id=REQ-xxxx -> uji approval API secara langsung'+C.reset);
  console.log('');
}

async function main(){
  const ts=new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta'});
  console.log('\n'+C.cyan+C.bold+'='.repeat(62));
  console.log('   DIAGNOSTIC -- IT Help Desk Bot PLN Batam');
  console.log('   '+ts);
  console.log('='.repeat(62)+C.reset);

  testEnvVars();
  testFileSystem();
  testWhatsAppAuth();
  testLogFiles();
  await testPort();
  testSyntax();
  testDependencies();
  await testInternet();
  testSecurity();
  testEncryption();
  testValidators();
  testSessionService();

  await testMEConnectivity();
  await testUserLookup();
  await testCategoryAPI();
  await testApprovalAPI();
  await testMEConfigIDs();
  await testHTTPEndpoints();

  printSummary();
  process.exit(results.fail>0?1:0);
}

main().catch(err=>{
  console.error('\n'+C.red+C.bold+'FATAL ERROR: '+err.message+C.reset);
  process.exit(1);
});
