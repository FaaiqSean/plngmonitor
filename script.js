/* =========================================================================
   MONITORING CKG — PUSKESMAS PULUNG
   script.js

   PENTING (dibaca dulu sebelum edit):
   Blok NAVIGASI SIDEBAR ditaruh PALING ATAS dan sengaja dipisah dari kode
   yang bergantung pada Chart.js / library CDN lain. Ini disengaja: kalau
   suatu saat CDN gagal dimuat (jaringan lambat/diblokir), menu sidebar
   TETAP bisa diklik karena sudah didaftarkan lebih dulu, sebelum baris
   manapun yang bisa melempar error dieksekusi.
========================================================================= */

/* ============================================================
   0. NAVIGASI SIDEBAR — WAJIB PALING ATAS, JANGAN DIPINDAH
   ============================================================ */
(function initNavigation(){
  const titles = {
    dashboard:['Dasbor Utama','Ringkasan capaian Cek Kesehatan Gratis (CKG)'],
    pegawai:['Capaian Pegawai','Pemantauan input per pegawai beserta interpretasinya'],
    data:['Data & Riwayat','Seluruh riwayat input kegiatan CKG'],
    unduh:['Unduh Laporan','Ekspor bukti input sebagai Excel atau PDF'],
    pengaturan:['Pengaturan','Sambungan data dan ambang batas capaian']
  };
  const navEl = document.getElementById('nav');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('overlay');

  function closeSidebar(){ sidebar.classList.remove('open'); overlay.classList.remove('show'); }

  navEl.addEventListener('click', e=>{
    const btn = e.target.closest('.nav-item');
    if(!btn) return;
    document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
    const view = btn.dataset.view;
    document.getElementById('view-'+view).classList.add('active');
    document.getElementById('pageTitle').textContent = titles[view][0];
    document.getElementById('pageSubtitle').textContent = titles[view][1];
    closeSidebar();
  });

  document.getElementById('hamburgerBtn').addEventListener('click', ()=>{
    sidebar.classList.add('open'); overlay.classList.add('show');
  });
  overlay.addEventListener('click', closeSidebar);
})();

/* ============================================================
   1. KONFIGURASI
   ============================================================ */
const API_URL_KEY = 'ckg_api_url';

// URL Web App Apps Script yang sudah di-deploy (lihat Code.gs).
// Ditulis langsung di sini (bukan cuma di localStorage) supaya dashboard
// ini otomatis tersambung ke Google Sheet yang SAMA di perangkat manapun
// dibuka — HP, laptop, browser lain — tanpa perlu isi URL manual dulu
// lewat halaman Pengaturan. Kalau suatu saat re-deploy Apps Script dan
// dapat URL baru, cukup ganti nilai di bawah ini.
const DEFAULT_API_URL = 'https://script.google.com/macros/s/AKfycbwpcsOjaL1EKdwyhaEfDiOqdFxZuR2sV9zCFTKy9kCSV2onIeCBDS0w4oJEt6gymjbL/exec';

const CONFIG = {
  // Prioritas: kalau perangkat ini pernah menyimpan URL sendiri lewat
  // halaman Pengaturan (misalnya untuk uji coba URL lain), pakai itu.
  // Kalau tidak ada, pakai DEFAULT_API_URL di atas supaya tetap sinkron.
  API_URL: localStorage.getItem(API_URL_KEY) || DEFAULT_API_URL
};

const THRESH_DEFAULT = { low: 100, high: 200 };
function getThreshold(){
  try{ return JSON.parse(localStorage.getItem('ckg_threshold')) || THRESH_DEFAULT; }
  catch(e){ return THRESH_DEFAULT; }
}
function setThreshold(t){ localStorage.setItem('ckg_threshold', JSON.stringify(t)); }

const PALETTE = {
  primary:'#1F6F63', primaryDark:'#164F46', accent:'#C98A3E',
  low:'#C15C4E', medium:'#C99A3E', high:'#2E7D5B',
  gridline:'#DBE5DF', textSoft:'#5C6F6A'
};

let RECORDS = [];   // {tanggal(Date), pegawai, kegiatan, jumlah, namaInput, keterangan}
let charts = {};
let lastSync = null;      // Date objek terakhir kali data berhasil diambil dari Sheet
let lastSource = 'demo';  // 'demo' | 'sheet'

/* ============================================================
   2. DATA DEMO (dipakai bila belum tersambung ke Google Sheet)
   ============================================================ */
function buildDemoData(){
  const pegawaiList = ['Siti Aminah','Budi Santoso','Dewi Lestari','Agus Wijaya','Rina Kartika','Yusuf Hidayat'];
  const kegiatanList = ['Pemeriksaan Tekanan Darah','Pemeriksaan Gula Darah','Pemeriksaan Kolesterol','Pemeriksaan Asam Urat','Pengukuran IMT','Skrining Kesehatan Jiwa'];
  const namaContoh = ['Warga','Peserta','Lansia','Ibu Hamil','Remaja','Balita'];
  const rows = [];
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth()-11, 1);
  let d = new Date(start);
  let idx = 0;
  while(d <= today){
    const entriesToday = Math.random() < 0.72 ? Math.floor(Math.random()*5) : 0;
    for(let i=0;i<entriesToday;i++){
      idx++;
      const pegawai = pegawaiList[Math.floor(Math.random()*pegawaiList.length)];
      const kegiatan = kegiatanList[Math.floor(Math.random()*kegiatanList.length)];
      rows.push({
        tanggal: new Date(d),
        pegawai,
        kegiatan,
        jumlah: Math.floor(Math.random()*9)+2,
        namaInput: namaContoh[Math.floor(Math.random()*namaContoh.length)] + ' ' + idx,
        keterangan: Math.random() < 0.15 ? 'Perlu tindak lanjut' : ''
      });
    }
    d.setDate(d.getDate()+1);
  }
  return rows;
}

/* ============================================================
   3. AMBIL & PARSE DATA DARI APPS SCRIPT
   ============================================================ */
function mapRow(r){
  return {
    tanggal: new Date(r.tanggal || r.Tanggal || r['Tanggal Input']),
    pegawai: r.pegawai || r.Pegawai || r['Nama Pegawai'] || '',
    kegiatan: r.kegiatan || r.Kegiatan || r['Jenis Kegiatan'] || '',
    jumlah: Number(r.jumlah || r.Jumlah || r['Jumlah yang Diinput'] || 0),
    namaInput: r.namaInput || r['Nama yang Diinput'] || '',
    keterangan: r.keterangan || r.Keterangan || ''
  };
}

async function fetchSheetData(url){
  if(!url) throw new Error('URL Web App belum diisi.');
  let res;
  try{
    res = await fetch(url, { redirect:'follow' });
  }catch(networkErr){
    throw new Error('Tidak bisa menghubungi URL tersebut. Periksa koneksi internet, atau URL mungkin salah/typo.');
  }
  if(!res.ok){
    throw new Error('Server merespons dengan status ' + res.status + '. Periksa apakah Web App sudah di-deploy dengan akses "Anyone".');
  }
  let json;
  try{
    json = await res.json();
  }catch(parseErr){
    throw new Error('Respons bukan JSON yang valid. Pastikan URL mengarah ke deployment "/exec" Web App Apps Script, bukan URL Sheet biasa.');
  }
  if(json && json.error){
    throw new Error('Apps Script mengembalikan error: ' + json.error);
  }
  const raw = json.data || json;
  if(!Array.isArray(raw)){
    throw new Error('Format data tidak dikenali. Pastikan Code.gs belum diubah strukturnya.');
  }
  return raw.map(mapRow);
}

async function loadData(){
  if(CONFIG.API_URL){
    try{
      RECORDS = await fetchSheetData(CONFIG.API_URL);
      lastSync = new Date();
      lastSource = 'sheet';
      setDemoBadge('connected');
    }catch(err){
      console.error('Gagal memuat dari Google Sheet, memakai data demo.', err);
      RECORDS = buildDemoData();
      lastSource = 'demo';
      setDemoBadge('error', err.message);
    }
  }else{
    RECORDS = buildDemoData();
    lastSource = 'demo';
    setDemoBadge('demo');
  }
  populateFilterOptions();
  renderAll();
  renderConnectionStatus();
}

function setDemoBadge(state, detail){
  const badge = document.getElementById('demoBadge');
  badge.classList.remove('show','badge-ok','badge-warn');
  if(state==='connected'){
    badge.innerHTML = iconCheck() + 'Tersambung ke Google Sheet';
    badge.classList.add('show','badge-ok');
  }else if(state==='error'){
    badge.innerHTML = iconWarn() + 'Gagal sambung — memakai data contoh';
    badge.title = detail || '';
    badge.classList.add('show','badge-warn');
  }else{
    badge.innerHTML = iconWarn() + 'Mode Demo — data contoh, belum tersambung Google Sheet';
    badge.classList.add('show');
  }
}
function iconCheck(){ return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="m5 13 4 4L19 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
function iconWarn(){ return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 9v4m0 4h.01M10.3 3.9 2.5 17.5c-.6 1 .1 2.5 1.4 2.5h16.2c1.3 0 2-1.5 1.4-2.5L13.7 3.9c-.7-1.2-2.6-1.2-3.4 0Z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }

/* ============================================================
   4. UJI KONEKSI (halaman Pengaturan)
   ============================================================ */
function renderConnectionStatus(){
  const box = document.getElementById('connStatus');
  if(!box) return;
  if(lastSource === 'sheet'){
    box.className = 'conn-status conn-ok';
    box.innerHTML = `
      <span class="conn-dot"></span>
      <div>
        <strong>Tersambung — data langsung dari Google Sheet</strong>
        <p class="card-sub mb-0">${RECORDS.length.toLocaleString('id-ID')} baris data ditemukan · terakhir disinkron ${lastSync ? lastSync.toLocaleTimeString('id-ID') : '-'}.
        Ini artinya alur Form &rarr; Sheet &rarr; Apps Script &rarr; Dashboard sudah berjalan baik.</p>
      </div>`;
  }else if(CONFIG.API_URL){
    box.className = 'conn-status conn-error';
    box.innerHTML = `
      <span class="conn-dot"></span>
      <div>
        <strong>Belum berhasil tersambung</strong>
        <p class="card-sub mb-0">Dashboard masih menampilkan data contoh. Klik "Uji Koneksi" di bawah untuk melihat detail error dan cara memperbaikinya.</p>
      </div>`;
  }else{
    box.className = 'conn-status conn-idle';
    box.innerHTML = `
      <span class="conn-dot"></span>
      <div>
        <strong>Belum diatur</strong>
        <p class="card-sub mb-0">Isi URL Web App Apps Script di bawah, lalu klik "Uji Koneksi".</p>
      </div>`;
  }
}

async function runConnectionTest(){
  const url = document.getElementById('apiUrlInput').value.trim();
  const resultBox = document.getElementById('connTestResult');
  resultBox.className = 'conn-status conn-loading';
  resultBox.innerHTML = `<span class="conn-dot"></span><div><strong>Menguji koneksi…</strong><p class="card-sub mb-0">Menghubungi Web App Apps Script.</p></div>`;
  resultBox.classList.remove('d-none');

  if(!url){
    resultBox.className = 'conn-status conn-error';
    resultBox.innerHTML = `<span class="conn-dot"></span><div><strong>URL kosong</strong><p class="card-sub mb-0">Isi dulu URL Web App (diakhiri <code class="inline">/exec</code>) sebelum menguji.</p></div>`;
    return;
  }

  try{
    const rows = await fetchSheetData(url);
    const withDate = rows.filter(r => !isNaN(r.tanggal.getTime())).sort((a,b)=>b.tanggal-a.tanggal);
    const newest = withDate[0];
    resultBox.className = 'conn-status conn-ok';
    resultBox.innerHTML = `
      <span class="conn-dot"></span>
      <div>
        <strong>Berhasil! Koneksi Form &rarr; Sheet &rarr; Dashboard aktif</strong>
        <p class="card-sub mb-0">
          ${rows.length.toLocaleString('id-ID')} baris data ditemukan di sheet.
          ${newest ? 'Input terbaru: ' + fmtDate(newest.tanggal) + ' oleh ' + (newest.pegawai||'-') + '.' : ''}
          Klik "Simpan &amp; Muat Ulang Data" di bawah untuk menerapkannya ke dashboard.
        </p>
      </div>`;
  }catch(err){
    resultBox.className = 'conn-status conn-error';
    resultBox.innerHTML = `
      <span class="conn-dot"></span>
      <div>
        <strong>Koneksi gagal</strong>
        <p class="card-sub mb-0">${err.message}</p>
        <p class="card-sub mb-0 mt-1"><strong>Cek ini:</strong> (1) Sheet sudah punya jawaban Form minimal 1 baris, (2) di Apps Script &gt; Deploy &gt; Manage deployments, akses diset "Anyone", (3) URL diakhiri <code class="inline">/exec</code> bukan <code class="inline">/dev</code>, (4) nama tab sheet sama persis dengan <code class="inline">SHEET_NAME</code> di Code.gs.</p>
      </div>`;
  }
}

/* ============================================================
   5. HELPERS TANGGAL & UMUM
   ============================================================ */
function fmtDate(d){ return d.toLocaleDateString('id-ID', {day:'2-digit',month:'short',year:'numeric'}); }
function isoDate(d){ return d.toISOString().slice(0,10); }
function monthLabel(m){ return ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'][m]; }
function sameDay(a,b){ return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }
function sumWhere(fn){ return RECORDS.filter(fn).reduce((s,r)=>s+r.jumlah,0); }
function uniqueList(key){ return [...new Set(RECORDS.map(r=>r[key]).filter(Boolean))].sort(); }
function uniqueList2(arr){ return [...new Set(arr)].sort((a,b)=>a-b); }

function populateFilterOptions(){
  const pegawaiOpts = uniqueList('pegawai');
  const kegiatanOpts = uniqueList('kegiatan');
  ['fPegawai','dPegawai'].forEach(id=>{
    const sel = document.getElementById(id);
    const current = sel.value;
    sel.innerHTML = `<option value="">Semua${id==='fPegawai'?'':' pegawai'}</option>` + pegawaiOpts.map(p=>`<option value="${p}">${p}</option>`).join('');
    sel.value = current;
  });
  const selK = document.getElementById('fKegiatan');
  selK.innerHTML = '<option value="">Semua</option>' + kegiatanOpts.map(k=>`<option value="${k}">${k}</option>`).join('');
}

/* ============================================================
   6. RENDER: RINGKASAN (kartu atas)
   ============================================================ */
function renderAll(){
  renderSummary();
  renderChartsSafe();
  renderEmployeeRanking();
  renderTable();
  renderDownloadCount();
  const th = getThreshold();
  document.getElementById('labLow').textContent = th.low;
  document.getElementById('labMedRange').textContent = th.low+'–'+(th.high-1);
  document.getElementById('labHigh').textContent = th.high;
  document.getElementById('thLow').value = th.low;
  document.getElementById('thHigh').value = th.high;
}

const STAT_ICONS = {
  pulse: 'M3 12h4l2 7 4-14 2 7h6',
  calendar: 'M4 5h16M7 3v4M17 3v4M5 9h14v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V9Z',
  trend: 'm3 17 6-6 4 4 8-8M15 6h6v6',
  layers: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5'
};

function renderSummary(){
  const today = new Date();
  const totalToday = sumWhere(r=>sameDay(r.tanggal, today));
  const totalMonth = sumWhere(r=>r.tanggal.getFullYear()===today.getFullYear() && r.tanggal.getMonth()===today.getMonth());
  const totalYear = sumWhere(r=>r.tanggal.getFullYear()===today.getFullYear());
  const totalAll = sumWhere(()=>true);

  const yest = new Date(today); yest.setDate(yest.getDate()-1);
  const totalYesterday = sumWhere(r=>sameDay(r.tanggal, yest));
  const lastMonthDate = new Date(today.getFullYear(), today.getMonth()-1, 1);
  const totalLastMonth = sumWhere(r=>r.tanggal.getFullYear()===lastMonthDate.getFullYear() && r.tanggal.getMonth()===lastMonthDate.getMonth());

  const cards = [
    {label:'Capaian Hari Ini', value:totalToday, sub:fmtDate(today), tone:'primary', icon:STAT_ICONS.pulse, delta:trendDelta(totalToday,totalYesterday,'vs kemarin')},
    {label:'Capaian Bulan Ini', value:totalMonth, sub:monthLabel(today.getMonth())+' '+today.getFullYear(), tone:'accent', icon:STAT_ICONS.calendar, delta:trendDelta(totalMonth,totalLastMonth,'vs bulan lalu')},
    {label:'Capaian Tahun Ini', value:totalYear, sub:today.getFullYear(), tone:'high', icon:STAT_ICONS.trend},
    {label:'Total Keseluruhan', value:totalAll, sub:RECORDS.length+' entri input', tone:'dark', icon:STAT_ICONS.layers},
  ];
  document.getElementById('summaryCards').innerHTML = cards.map(c=>`
    <div class="col-12 col-sm-6 col-xl-3">
      <div class="card stat-card h-100">
        <div class="stat-top">
          <div>
            <p class="card-label">${c.label}</p>
            <p class="card-value tabular">${c.value.toLocaleString('id-ID')}</p>
          </div>
          <div class="stat-icon stat-icon-${c.tone}">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="${c.icon}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </div>
        </div>
        <p class="card-sub">${c.sub}${c.delta ? ' · '+c.delta : ''}</p>
      </div>
    </div>`).join('');
}

function trendDelta(current, previous, label){
  if(!previous){ return ''; }
  const diff = current - previous;
  const pct = Math.round((diff/previous)*100);
  if(diff===0) return `<span class="trend trend-flat">stabil ${label}</span>`;
  const cls = diff>0 ? 'trend-up' : 'trend-down';
  const arrow = diff>0 ? '&#8599;' : '&#8600;';
  return `<span class="trend ${cls}">${arrow} ${Math.abs(pct)}% ${label}</span>`;
}

/* ============================================================
   7. RENDER: CHARTS (dibungkus try/catch supaya kalau Chart.js
      gagal dimuat, sisa dashboard—terutama navigasi—tetap hidup)
   ============================================================ */
let chartsPollTimer = null;
function renderChartsSafe(retriesLeft){
  if(chartsPollTimer){ clearTimeout(chartsPollTimer); chartsPollTimer = null; }
  // BUG LAMA: Chart.js sekarang dimuat secara async dengan beberapa CDN
  // cadangan (lihat index.html). Karena async, ada kemungkinan script.js
  // ini jalan duluan SEBELUM Chart.js selesai dimuat — kalau langsung
  // dicek sekali dan gagal, chart akan menampilkan pesan error padahal
  // sebenarnya cuma butuh menunggu beberapa saat lagi. Makanya di sini
  // dicoba ulang (retry) tiap 400ms, maksimal ~12 detik, sebelum benar-benar
  // dianggap gagal dan menampilkan pesan error ke pengguna.
  if(retriesLeft === undefined) retriesLeft = 30;
  if(typeof Chart === 'undefined'){
    if(retriesLeft > 0){
      chartsPollTimer = setTimeout(()=>renderChartsSafe(retriesLeft-1), 400);
      return;
    }
    showChartLibWarning();
    return;
  }
  try{
    Chart.defaults.font.family = "'Public Sans', sans-serif";
    Chart.defaults.color = PALETTE.textSoft;
    Chart.defaults.font.size = 12;
    renderCharts();
  }catch(err){
    console.error('Gagal menggambar chart:', err);
    showChartLibWarning();
  }
}

function showChartLibWarning(){
  document.querySelectorAll('.chart-wrap').forEach(el=>{
    if(el.querySelector('.chart-fail')) return;
    el.insertAdjacentHTML('beforeend', `<div class="chart-fail">Grafik gagal dimuat (library Chart.js tidak tersedia). Data lain di dashboard tetap berfungsi normal — coba muat ulang halaman.</div>`);
  });
}

function destroy(id){ if(charts[id]){ charts[id].destroy(); } }

function gradientFill(ctx, color){
  const g = ctx.createLinearGradient(0,0,0,240);
  g.addColorStop(0, color+'55');
  g.addColorStop(1, color+'03');
  return g;
}

function renderCharts(){
  const today = new Date();
  document.getElementById('tahunLabel').textContent = today.getFullYear();

  // ---- Harian (30 hari terakhir) ----
  const days = [];
  for(let i=29;i>=0;i--){ const d=new Date(today); d.setDate(d.getDate()-i); days.push(d); }
  const dailyData = days.map(d => sumWhere(r=>sameDay(r.tanggal,d)));
  destroy('harian');
  const ctxHarian = document.getElementById('chartHarian').getContext('2d');
  charts.harian = new Chart(ctxHarian, {
    type:'line',
    data:{ labels:days.map(d=>d.getDate()+'/'+(d.getMonth()+1)),
      datasets:[{ data:dailyData, borderColor:PALETTE.primary, backgroundColor:gradientFill(ctxHarian, PALETTE.primary),
        fill:true, tension:.35, pointRadius:0, pointHoverRadius:5, pointHoverBackgroundColor:PALETTE.primary, borderWidth:2.5 }] },
    options: baseOpts({ x:{maxTicksLimit:8} })
  });
  renderInsight('insightHarian', buildDailyInsight(days, dailyData));

  // ---- Bulanan (tahun berjalan) ----
  const monthData = Array.from({length:12}, (_,m)=> sumWhere(r=>r.tanggal.getFullYear()===today.getFullYear() && r.tanggal.getMonth()===m));
  destroy('bulanan');
  charts.bulanan = new Chart(document.getElementById('chartBulanan'), {
    type:'bar',
    data:{ labels:Array.from({length:12},(_,m)=>monthLabel(m)),
      datasets:[{ data:monthData, backgroundColor:PALETTE.primary, borderRadius:6, maxBarThickness:26 }] },
    options: baseOpts({})
  });
  renderInsight('insightBulanan', buildMonthlyInsight(monthData, today));

  // ---- Tahunan ----
  const years = uniqueList2(RECORDS.map(r=>r.tanggal.getFullYear()));
  const yearData = years.map(y=> sumWhere(r=>r.tanggal.getFullYear()===y));
  destroy('tahunan');
  charts.tahunan = new Chart(document.getElementById('chartTahunan'), {
    type:'bar',
    data:{ labels:years, datasets:[{ data:yearData, backgroundColor:PALETTE.accent, borderRadius:6, maxBarThickness:46 }] },
    options: baseOpts({})
  });

  // ---- Distribusi jenis kegiatan ----
  const kegiatanList = uniqueList('kegiatan');
  const kegiatanData = kegiatanList.map(k=> sumWhere(r=>r.kegiatan===k));
  destroy('kegiatan');
  charts.kegiatan = new Chart(document.getElementById('chartKegiatan'), {
    type:'doughnut',
    data:{ labels:kegiatanList, datasets:[{ data:kegiatanData, borderWidth:2, borderColor:'#fff',
      backgroundColor:generateColors(kegiatanList.length) }] },
    options:{ responsive:true, maintainAspectRatio:false, cutout:'62%',
      plugins:{ legend:{ position:'right', labels:{ boxWidth:10, boxHeight:10, padding:12, font:{size:11.5} } },
        tooltip:{ backgroundColor:'#164F46', padding:10, cornerRadius:8 } } }
  });
  renderInsight('insightKegiatan', buildKegiatanInsight(kegiatanList, kegiatanData));

  // ---- Per pegawai ----
  const pegawaiList = uniqueList('pegawai');
  const sortedPegawai = pegawaiList.map(p=>({p, v:sumWhere(r=>r.pegawai===p)})).sort((a,b)=>b.v-a.v);
  const th = getThreshold();

  // BUG LAMA: tinggi wrapper chart ini tetap (340px) berapa pun jumlah pegawai.
  // Kalau pegawainya banyak (puluhan), setiap bar jadi sangat tipis dan nama
  // pegawai di sumbu-y saling tumpuk sehingga chart tidak terbaca. Sekarang
  // tingginya menyesuaikan jumlah pegawai (minimal 28px per baris).
  const pegawaiWrap = document.getElementById('pegawaiChartWrap');
  if(pegawaiWrap){
    const ROW_HEIGHT = 28;
    const MIN_HEIGHT = 340;
    pegawaiWrap.style.height = Math.max(MIN_HEIGHT, sortedPegawai.length * ROW_HEIGHT) + 'px';
  }

  destroy('pegawai');
  charts.pegawai = new Chart(document.getElementById('chartPegawai'), {
    type:'bar',
    data:{ labels: sortedPegawai.map(x=>x.p),
      datasets:[{ data: sortedPegawai.map(x=>x.v), borderRadius:6, maxBarThickness:28,
        backgroundColor: sortedPegawai.map(x=> x.v>=th.high?PALETTE.high : x.v>=th.low?PALETTE.medium:PALETTE.low) }] },
    options: { ...baseOpts({}), indexAxis:'y' }
  });
}

// BUG LAMA: palet warna doughnut cuma berisi 7 warna tetap. Begitu jenis
// kegiatan lebih dari 7 (data asli Puskesmas Pulung punya 13 jenis), warna
// ke-8 dan seterusnya jadi "undefined"/tidak terdefinisi sehingga beberapa
// potongan chart tidak berwarna atau warnanya sama persis — chart jadi tidak
// bisa dibedakan/dibaca. Fungsi ini menambah warna baru secara otomatis
// (rotasi hue) kalau jumlah kategori melebihi palet dasar.
function generateColors(n){
  const base = [PALETTE.primary, PALETTE.accent, PALETTE.high, '#7CA79A', '#D9AF6B', '#4C8C6B', '#8FB6AC'];
  if(n <= base.length) return base.slice(0, n);
  const colors = base.slice();
  const extra = n - base.length;
  for(let i=0;i<extra;i++){
    const hue = Math.round((360/extra) * i);
    colors.push(`hsl(${hue}, 55%, 50%)`);
  }
  return colors;
}

function baseOpts(scaleOverrides){
  return {
    responsive:true, maintainAspectRatio:false,
    interaction:{ intersect:false, mode:'index' },
    plugins:{ legend:{display:false}, tooltip:{ backgroundColor:'#164F46', padding:10, cornerRadius:8, titleFont:{weight:600} } },
    scales:{
      x:{ grid:{display:false}, ticks:{...(scaleOverrides.x||{})} },
      y:{ grid:{color:PALETTE.gridline}, beginAtZero:true, ticks:{...(scaleOverrides.y||{})} }
    }
  };
}

/* ---- teks interpretasi otomatis di bawah tiap chart ---- */
function renderInsight(elId, html){
  const el = document.getElementById(elId);
  if(el) el.innerHTML = html;
}
function buildDailyInsight(days, data){
  const last7 = data.slice(-7).reduce((a,b)=>a+b,0);
  const prev7 = data.slice(-14,-7).reduce((a,b)=>a+b,0);
  const avg = (data.reduce((a,b)=>a+b,0)/data.length).toFixed(1);
  let trendTxt = 'stabil dibanding 7 hari sebelumnya';
  if(prev7>0){
    const pct = Math.round(((last7-prev7)/prev7)*100);
    if(pct>5) trendTxt = `naik ${pct}% dibanding 7 hari sebelumnya`;
    else if(pct<-5) trendTxt = `turun ${Math.abs(pct)}% dibanding 7 hari sebelumnya`;
  }
  return `Rata-rata harian <strong>${avg}</strong> input. 7 hari terakhir ${trendTxt}.`;
}
function buildMonthlyInsight(monthData, today){
  const upToNow = monthData.slice(0, today.getMonth()+1);
  const max = Math.max(...upToNow);
  const bestIdx = upToNow.indexOf(max);
  if(max===0) return 'Belum ada data bulan berjalan tahun ini.';
  return `Bulan tertinggi tahun ini: <strong>${monthLabel(bestIdx)}</strong> dengan ${max.toLocaleString('id-ID')} input.`;
}
function buildKegiatanInsight(list, data){
  if(list.length===0) return 'Belum ada data jenis kegiatan.';
  const total = data.reduce((a,b)=>a+b,0);
  const maxIdx = data.indexOf(Math.max(...data));
  const pct = total>0 ? Math.round((data[maxIdx]/total)*100) : 0;
  return `Kegiatan terbanyak: <strong>${list[maxIdx]}</strong> (${pct}% dari seluruh input).`;
}

/* ============================================================
   8. RENDER: PERINGKAT PEGAWAI
   ============================================================ */
function renderEmployeeRanking(){
  const th = getThreshold();
  const pegawaiList = uniqueList('pegawai');
  const data = pegawaiList.map(p=>({ pegawai:p, total: sumWhere(r=>r.pegawai===p) })).sort((a,b)=>b.total-a.total);
  const max = Math.max(...data.map(d=>d.total), 1);
  document.getElementById('rankList').innerHTML = data.map((d,i)=>{
    let level='low', label='Rendah';
    if(d.total>=th.high){ level='high'; label='Tinggi'; }
    else if(d.total>=th.low){ level='medium'; label='Sedang'; }
    const color = level==='high'?PALETTE.high:level==='medium'?PALETTE.medium:PALETTE.low;
    return `<div class="rank-row">
      <div class="rank-num">${i+1}</div>
      <div class="rank-name">
        <strong>${d.pegawai}</strong>
        <div class="bar-track"><div class="bar-fill" style="width:${(d.total/max*100).toFixed(0)}%;background:${color};"></div></div>
      </div>
      <span class="badge badge-${level}"><span class="dot"></span>${label}</span>
      <span class="rank-value tabular">${d.total.toLocaleString('id-ID')}</span>
    </div>`;
  }).join('') || `<div class="empty-state">Belum ada data pegawai.</div>`;

  const insightEl = document.getElementById('insightPegawai');
  if(insightEl){
    if(data.length===0){ insightEl.innerHTML = ''; }
    else{
      const top = data[0];
      const low = data.filter(d=>d.total<th.low).length;
      insightEl.innerHTML = `<strong>${top.pegawai}</strong> memimpin dengan ${top.total.toLocaleString('id-ID')} input.` +
        (low>0 ? ` ${low} pegawai masih di bawah ambang batas "Rendah" (${th.low}) dan mungkin perlu pendampingan.` : ' Semua pegawai sudah di atas ambang batas "Rendah".');
    }
  }
}

/* ============================================================
   9. RENDER: TABEL DATA
   ============================================================ */
function getFiltered(source){
  const pegawai = document.getElementById(source+'Pegawai').value;
  const dari = document.getElementById(source+'Dari').value;
  const sampai = source==='f' ? document.getElementById('fSampai').value : document.getElementById('dSampai').value;
  const kegiatan = source==='f' ? document.getElementById('fKegiatan').value : '';
  return RECORDS.filter(r=>{
    if(pegawai && r.pegawai!==pegawai) return false;
    if(kegiatan && r.kegiatan!==kegiatan) return false;
    if(dari && isoDate(r.tanggal) < dari) return false;
    if(sampai && isoDate(r.tanggal) > sampai) return false;
    return true;
  }).sort((a,b)=>b.tanggal-a.tanggal);
}
function renderTable(){
  const rows = getFiltered('f');
  const body = document.getElementById('tableBody');
  const empty = document.getElementById('tableEmpty');
  if(rows.length===0){ body.innerHTML=''; empty.classList.remove('d-none'); return; }
  empty.classList.add('d-none');
  body.innerHTML = rows.slice(0,300).map(r=>`
    <tr>
      <td class="tabular">${fmtDate(r.tanggal)}</td>
      <td>${r.pegawai}</td>
      <td>${r.kegiatan}</td>
      <td class="tabular">${r.jumlah}</td>
      <td>${r.namaInput||'—'}</td>
      <td>${r.keterangan||'—'}</td>
    </tr>`).join('');
}
['fPegawai','fKegiatan','fDari','fSampai'].forEach(id=>{
  document.getElementById(id).addEventListener('change', renderTable);
});
document.getElementById('resetFilter').addEventListener('click', ()=>{
  ['fPegawai','fKegiatan','fDari','fSampai'].forEach(id=> document.getElementById(id).value='');
  renderTable();
});

/* ============================================================
   10. UNDUH LAPORAN (Excel / PDF)
   ============================================================ */
function renderDownloadCount(){
  const rows = getFiltered('d');
  document.getElementById('downloadCount').textContent = rows.length.toLocaleString('id-ID') + ' baris data sesuai filter.';
}
['dPegawai','dDari','dSampai'].forEach(id=>{
  document.getElementById(id).addEventListener('change', renderDownloadCount);
});

/* KOP surat resmi (logo + identitas instansi) untuk laporan PDF & Excel,
   sesuai tata naskah dinas — teks & logo diambil dari KOP_SURAT.docx. */
const KOP_INFO = {
  baris1: 'PEMERINTAH KABUPATEN PONOROGO',
  baris2: 'DINAS KESEHATAN',
  baris3: 'PUSKESMAS PULUNG',
  alamat: 'Jl. Dr. Soetomo No. 33, Pulung Telp. (0352) 571118 Kode Pos 63481',
  kontak: 'Laman puskesmaspulung.ponorogo.go.id  ·  Pos-el puskesmas_pulung@ponorogo.go.id'
};

/* Menggambar KOP surat di halaman PDF (jsPDF), mengembalikan koordinat Y
   tempat konten laporan boleh mulai digambar (di bawah garis ganda). */
function drawPdfLetterhead(doc){
  const pageWidth = doc.internal.pageSize.getWidth();
  const marginLeft = 14, marginRight = 14;
  const logoW = 18, logoH = 19.1; // rasio asli logo ±242:257

  if(typeof KOP_LOGO_BASE64 !== 'undefined'){
    try{ doc.addImage(KOP_LOGO_BASE64, 'PNG', marginLeft, 8, logoW, logoH); }
    catch(e){ console.warn('Gagal menambahkan logo KOP ke PDF:', e); }
  }

  const textColX = marginLeft + logoW + 4;
  const textCenterX = textColX + (pageWidth - marginRight - textColX) / 2;

  doc.setTextColor(20,30,28);
  doc.setFont('helvetica','bold');
  doc.setFontSize(12);
  doc.text(KOP_INFO.baris1, textCenterX, 12.5, { align:'center' });
  doc.text(KOP_INFO.baris2, textCenterX, 17.5, { align:'center' });
  doc.setFontSize(15);
  doc.text(KOP_INFO.baris3, textCenterX, 23.5, { align:'center' });
  doc.setFont('helvetica','normal');
  doc.setFontSize(8.5);
  doc.text(KOP_INFO.alamat, textCenterX, 28.5, { align:'center' });
  doc.text(KOP_INFO.kontak, textCenterX, 32.5, { align:'center' });

  // garis ganda khas kop surat dinas (tebal lalu tipis)
  doc.setDrawColor(20,30,28);
  doc.setLineWidth(0.9);
  doc.line(marginLeft, 35.5, pageWidth - marginRight, 35.5);
  doc.setLineWidth(0.25);
  doc.line(marginLeft, 37, pageWidth - marginRight, 37);
  doc.setTextColor(0,0,0);

  return 44; // Y mulai konten laporan
}

document.getElementById('btnExportExcel').addEventListener('click', ()=>{
  if(typeof XLSX === 'undefined'){ alert('Library Excel belum termuat, coba muat ulang halaman.'); return; }
  const rows = getFiltered('d');
  const COL_COUNT = 6; // Tanggal, Nama Pegawai, Jenis Kegiatan, Jumlah, Nama yang Diperiksa, Keterangan

  // ---- KOP surat (baris teks di atas tabel data) ----
  // Catatan: library Excel gratis yang dipakai di sini (SheetJS Community/
  // xlsx.full.min.js) tidak mendukung penyisipan gambar maupun styling
  // (bold/border) saat menulis file — jadi logo tidak bisa ditaruh di
  // Excel seperti di PDF. Identitas instansi tetap ditampilkan sebagai
  // baris teks resmi, dirata-tengah lewat penggabungan sel (merge cell).
  const aoa = [
    [KOP_INFO.baris1],
    [KOP_INFO.baris2],
    [KOP_INFO.baris3],
    [KOP_INFO.alamat],
    [KOP_INFO.kontak],
    ['='.repeat(90)],
    [],
    ['LAPORAN BUKTI INPUT — CEK KESEHATAN GRATIS (CKG)'],
    ['Dicetak: ' + fmtDate(new Date())],
    [],
    ['Tanggal','Nama Pegawai','Jenis Kegiatan','Jumlah','Nama yang Diperiksa','Keterangan']
  ];
  const HEADER_ROWS = aoa.length; // baris ke berapa header tabel berada (0-based index dari header row = HEADER_ROWS-1)

  rows.forEach(r=>{
    aoa.push([fmtDate(r.tanggal), r.pegawai, r.kegiatan, r.jumlah, r.namaInput||'—', r.keterangan||'—']);
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{wch:14},{wch:20},{wch:26},{wch:10},{wch:22},{wch:24}];
  ws['!merges'] = [
    {s:{r:0,c:0}, e:{r:0,c:COL_COUNT-1}},
    {s:{r:1,c:0}, e:{r:1,c:COL_COUNT-1}},
    {s:{r:2,c:0}, e:{r:2,c:COL_COUNT-1}},
    {s:{r:3,c:0}, e:{r:3,c:COL_COUNT-1}},
    {s:{r:4,c:0}, e:{r:4,c:COL_COUNT-1}},
    {s:{r:5,c:0}, e:{r:5,c:COL_COUNT-1}},
    {s:{r:7,c:0}, e:{r:7,c:COL_COUNT-1}},
    {s:{r:8,c:0}, e:{r:8,c:COL_COUNT-1}}
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Laporan CKG');
  XLSX.writeFile(wb, `Laporan-CKG-Pulung-${isoDate(new Date())}.xlsx`);
});

document.getElementById('btnExportPdf').addEventListener('click', ()=>{
  if(typeof window.jspdf === 'undefined'){ alert('Library PDF belum termuat, coba muat ulang halaman.'); return; }
  const rows = getFiltered('d');
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation:'landscape' });

  const startY = drawPdfLetterhead(doc);

  doc.setFont('helvetica','bold');
  doc.setFontSize(13);
  doc.text('Laporan Bukti Input — Cek Kesehatan Gratis (CKG)', doc.internal.pageSize.getWidth()/2, startY, { align:'center' });
  doc.setFont('helvetica','normal');
  doc.setFontSize(9.5);
  doc.text('Dicetak: ' + fmtDate(new Date()), doc.internal.pageSize.getWidth()/2, startY + 5.5, { align:'center' });

  doc.autoTable({
    startY: startY + 10,
    head:[['Tanggal','Nama Pegawai','Jenis Kegiatan','Jumlah','Nama yang Diperiksa','Keterangan']],
    body: rows.map(r=>[fmtDate(r.tanggal), r.pegawai, r.kegiatan, r.jumlah, r.namaInput||'—', r.keterangan||'—']),
    styles:{ fontSize:9, cellPadding:4 },
    headStyles:{ fillColor:[31,111,99], textColor:255 },
    alternateRowStyles:{ fillColor:[242,246,244] }
  });
  doc.save(`Laporan-CKG-Pulung-${isoDate(new Date())}.pdf`);
});

/* ============================================================
   11. PENGATURAN (URL Sheet, Uji Koneksi, Ambang Batas)
   ============================================================ */
document.getElementById('apiUrlInput').value = CONFIG.API_URL;
document.getElementById('testConnection').addEventListener('click', runConnectionTest);
document.getElementById('openApiUrl').addEventListener('click', ()=>{
  const url = document.getElementById('apiUrlInput').value.trim();
  if(!url){ alert('Isi URL Web App terlebih dahulu.'); return; }
  window.open(url, '_blank');
});
document.getElementById('saveApiUrl').addEventListener('click', ()=>{
  const url = document.getElementById('apiUrlInput').value.trim();
  localStorage.setItem(API_URL_KEY, url);
  CONFIG.API_URL = url;
  loadData();
});
document.getElementById('saveThreshold').addEventListener('click', ()=>{
  const low = Number(document.getElementById('thLow').value) || THRESH_DEFAULT.low;
  const high = Number(document.getElementById('thHigh').value) || THRESH_DEFAULT.high;
  setThreshold({ low, high });
  renderAll();
});

/* ============================================================
   12. PROTEKSI HALAMAN PENGATURAN (KATA SANDI)
   ------------------------------------------------------------
   Catatan penting: ini proteksi sisi client (di browser), tujuannya
   supaya orang iseng/tidak berkepentingan tidak asal buka & mengubah
   Pengaturan. Ini BUKAN keamanan tingkat server — siapapun yang buka
   "View Page Source"/DevTools tetap bisa melihat kata sandinya di
   script.js ini. Jangan pakai kata sandi ini untuk melindungi data
   yang benar-benar rahasia/sensitif.
   ============================================================ */
(function initPengaturanLock(){
  const SETTINGS_PASSWORD = 'AyamBetutu';
  let unlocked = false;

  const lockEl = document.getElementById('pengaturanLock');
  const contentEl = document.getElementById('pengaturanContent');
  const pwInput = document.getElementById('pengaturanPassword');
  const errEl = document.getElementById('pengaturanError');
  const unlockBtn = document.getElementById('unlockPengaturan');
  if(!lockEl || !contentEl || !pwInput || !errEl || !unlockBtn) return;

  function showLock(){
    lockEl.style.display = '';
    contentEl.style.display = 'none';
    pwInput.value = '';
    errEl.style.display = 'none';
  }
  function showContent(){
    lockEl.style.display = 'none';
    contentEl.style.display = '';
  }

  function tryUnlock(){
    if(pwInput.value === SETTINGS_PASSWORD){
      unlocked = true;
      showContent();
    }else{
      errEl.style.display = '';
      pwInput.value = '';
      pwInput.focus();
    }
  }
  unlockBtn.addEventListener('click', tryUnlock);
  pwInput.addEventListener('keydown', e=>{ if(e.key==='Enter') tryUnlock(); });

  // Setiap kali menu "Pengaturan" dibuka dan belum terbuka kuncinya
  // pada sesi ini, tampilkan lagi gerbang kata sandi.
  document.getElementById('nav').addEventListener('click', e=>{
    const btn = e.target.closest('.nav-item');
    if(!btn || btn.dataset.view !== 'pengaturan') return;
    if(unlocked){ showContent(); }
    else{ showLock(); setTimeout(()=>pwInput.focus(), 60); }
  });
})();

/* ============================================================
   13. INIT
   ============================================================ */
loadData();