// =============================================================
// CONTENT SCRIPT — QRIS Payment Monitor
// Berjalan di dalam tab merchant.qris.interactive.co.id
// =============================================================

const CONFIG = {
    // URL patterns
    URL_LOGIN: '/v2/m/login/',
    URL_VERIFIKASI: 'verification.php',
    URL_HISTORI: 'historytrx.php',
    URL_REDIRECT: 'https://merchant.qris.interactive.co.id/v2/m/kontenr.php?idir=pages/historytrx.php',

    // Polling
    POLL_INTERVAL_MS: 5000,   // scrape tabel setiap 5 detik
    COMMAND_POLL_INTERVAL_MS: 30000,  // tanya server ada perintah? setiap ~30 detik
    COMMAND_JITTER_MS: 2000,   // jitter ±2 detik pada command poll

    // Reload anti-bot
    RELOAD_BEFORE_MIN: 14,     // reload sebelum 15 menit (14 menit)
    RELOAD_JITTER_MS: 60000,  // ±60 detik jitter pada auto-reload
    MIN_RELOAD_GAP_MS: 25000,  // minimal 25 detik antar dua reload

    // Selector tabel — sesuaikan jika struktur DOM berubah
    TABLE_ROW_SELECTOR: 'table tbody tr',
    // DataTables menambah 2 hidden cols (raw nominal [3], sort [4])
    // Total 13 kolom: No[0] Waktu[1] Nominal[2] RawNom[3] Sort[4] Status[5]
    //   Nama[6] Metode[7] RRN[8] Keterangan[9] IDTransaksi[10] IDInvoice[11] Settlement[12]
    COL: {
        WAKTU: 1,      // td[1]: tanggal & waktu transaksi
        NOMINAL: 2,    // td[2]: "Rp 1.665" → parseNominal → 1665
        STATUS: 5,     // td[5]: "Sukses" (shifted +2 dari visual karena hidden cols)
        NAMA: 6,       // td[6]: nama pengirim
        METODE: 7,     // td[7]: metode pembayaran (Dana, GoPay, dll)
        RRN: 8,        // td[8]: RRN
        KODE_REF: 9,   // td[9]: keterangan
        UID_HASH: 10,  // td[10]: ID Transaksi (hash unik untuk dedup)
    }
};

// ── State ──────────────────────────────────────────────────────
const knownUids = new Set();   // Set uid transaksi yang sudah dikirim
let pollingTimer = null;
let commandTimer = null;
let reloadCheckTimer = null;
let lastReloadTime = Date.now();
let lastUrl = window.location.href;
let reloadQueue = [];
let isProcessingQueue = false;

// ── Helper ─────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg, data) {
    const prefix = '[QRIS Monitor]';
    data ? console.log(prefix, msg, data) : console.log(prefix, msg);
}

function parseNominal(str) {
    if (!str) return 0;
    return parseInt(str.replace(/[^0-9]/g, ''), 10) || 0;
}

// ── URL Detection ───────────────────────────────────────────────
function cekStatusHalaman() {
    const url = window.location.href;

    if (url.includes(CONFIG.URL_LOGIN)) {
        log('URL = LOGIN — session expired atau belum login');
        chrome.runtime.sendMessage({
            type: 'SESSION_EXPIRED',
            timestamp: new Date().toISOString()
        });
        stopSemua();
        return;
    }

    if (url.includes(CONFIG.URL_VERIFIKASI)) {
        log('URL = VERIFIKASI — baru selesai login, redirect ke histori...');
        chrome.runtime.sendMessage({ type: 'SUDAH_LOGIN' });
        setTimeout(() => {
            window.location.href = CONFIG.URL_REDIRECT;
        }, 1500);
        return;
    }

    if (url.includes(CONFIG.URL_HISTORI)) {
        log('URL = HISTORI — mulai monitoring transaksi');
        startScraping();
        startCommandPolling();
        startAutoReloadCheck();
        return;
    }

    // Halaman lain tapi sudah login (dashboard, dll)
    log('URL tidak dikenal, redirect ke halaman histori...');
    window.location.href = CONFIG.URL_REDIRECT;
}

// ── Scraping (Batch Support) ──────────────────────────────────
function scrapeTransaksi() {
    const rows = document.querySelectorAll(CONFIG.TABLE_ROW_SELECTOR);

    if (!rows || rows.length === 0) {
        log('Tabel transaksi kosong atau belum load');
        return;
    }

    const transaksiList = [];

    rows.forEach((row) => {
        const cols = row.querySelectorAll('td');
        if (cols.length < 11) return; // skip loading/incomplete rows

        const status = cols[CONFIG.COL.STATUS]?.innerText?.trim();
        if (status !== 'Sukses') return;

        const uidHash = cols[CONFIG.COL.UID_HASH]?.innerText?.trim();
        if (!uidHash) return;

        transaksiList.push({
            waktu: cols[CONFIG.COL.WAKTU]?.innerText?.trim() || '',
            nominal_raw: cols[CONFIG.COL.NOMINAL]?.innerText?.trim() || '',
            nominal: parseNominal(cols[CONFIG.COL.NOMINAL]?.innerText),
            status: status,
            nama: cols[CONFIG.COL.NAMA]?.innerText?.trim() || '',
            metode: cols[CONFIG.COL.METODE]?.innerText?.trim() || '',
            kode_ref: cols[CONFIG.COL.KODE_REF]?.innerText?.trim() || '',
            uid_hash: uidHash,
        });
    });

    if (transaksiList.length === 0) return;

    // Filter: hanya transaksi BARU yang belum pernah dikirim
    const baruList = transaksiList.filter(t => !knownUids.has(t.uid_hash));

    // Tandai SEMUA transaksi sebagai known (termasuk yang lama)
    for (const t of transaksiList) {
        knownUids.add(t.uid_hash);
    }

    if (baruList.length === 0) return; // semua sudah pernah dikirim

    log(`${baruList.length} transaksi baru dikirim ke server (total known: ${knownUids.size})`,
        baruList.map(t => `${t.nominal_raw} [${t.uid_hash.substring(0, 8)}]`));

    // Kirim BATCH ke background.js — semua transaksi baru sekaligus
    chrome.runtime.sendMessage({
        type: 'TRANSAKSI_BATCH',
        batch: baruList
    });
}

// ── Start/Stop Polling ─────────────────────────────────────────
function startScraping() {
    if (pollingTimer) return;
    log('Mulai polling scrape setiap', CONFIG.POLL_INTERVAL_MS + 'ms');
    scrapeTransaksi(); // langsung cek sekali
    pollingTimer = setInterval(scrapeTransaksi, CONFIG.POLL_INTERVAL_MS);
}

function stopScraping() {
    if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
}

// ── Command Polling dari Server ────────────────────────────────
function startCommandPolling() {
    if (commandTimer) return;
    commandTimer = setInterval(async () => {
        try {
            const jitter = Math.random() * CONFIG.COMMAND_JITTER_MS;
            await sleep(jitter);

            const response = await chrome.runtime.sendMessage({ type: 'CEK_PERINTAH' });

            if (response?.command === 'CEK_SEKARANG') {
                log('Server minta cek sekarang!');
                enqueueReload('server_command');
            }
        } catch (e) {
            // Background sedang tidak aktif, skip
        }
    }, CONFIG.COMMAND_POLL_INTERVAL_MS);
}

function stopCommandPolling() {
    if (commandTimer) { clearInterval(commandTimer); commandTimer = null; }
}

// ── Queue Reload (anti-bot, anti-spam) ─────────────────────────
function enqueueReload(trigger) {
    reloadQueue.push({ trigger, queuedAt: Date.now() });
    if (!isProcessingQueue) processReloadQueue();
}

async function processReloadQueue() {
    isProcessingQueue = true;
    while (reloadQueue.length > 0) {
        const item = reloadQueue.shift();
        const timeSinceLast = Date.now() - lastReloadTime;

        // Pastikan minimal 25 detik dari reload terakhir
        if (timeSinceLast < CONFIG.MIN_RELOAD_GAP_MS) {
            await sleep(CONFIG.MIN_RELOAD_GAP_MS - timeSinceLast);
        }

        // Jeda random 2–8 detik sebelum reload (simulasi human)
        const humanDelay = 2000 + Math.random() * 6000;
        log(`Akan reload dalam ${Math.round(humanDelay / 1000)}s (trigger: ${item.trigger})`);
        await sleep(humanDelay);

        lastReloadTime = Date.now();
        location.reload();
        return; // reload memutus eksekusi
    }
    isProcessingQueue = false;
}

// ── Auto-Reload Sebelum Sesi Habis ────────────────────────────
function startAutoReloadCheck() {
    if (reloadCheckTimer) return;
    reloadCheckTimer = setInterval(() => {
        const elapsed = Date.now() - lastReloadTime;
        const targetMs = CONFIG.RELOAD_BEFORE_MIN * 60 * 1000;
        const jitter = Math.random() * CONFIG.RELOAD_JITTER_MS;

        if (elapsed >= targetMs + jitter) {
            log('Auto-reload untuk jaga sesi tetap aktif');
            enqueueReload('anti_session_timeout');
        }
    }, 30000);
}

// ── Stop Semua ─────────────────────────────────────────────────
function stopSemua() {
    stopScraping();
    stopCommandPolling();
    if (reloadCheckTimer) { clearInterval(reloadCheckTimer); reloadCheckTimer = null; }
    log('Semua monitoring dihentikan karena session expired');
}

// ── SPA Navigation Observer ────────────────────────────────────
const urlObserver = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        log('URL berubah ke:', lastUrl);
        stopScraping();
        stopCommandPolling();
        setTimeout(cekStatusHalaman, 1000);
    }
});
urlObserver.observe(document.body, { childList: true, subtree: true });

// ── Init ───────────────────────────────────────────────────────
log('Content script aktif, cek status halaman...');
cekStatusHalaman();
