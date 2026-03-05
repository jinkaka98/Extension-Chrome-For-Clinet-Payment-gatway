// =============================================================
// CONTENT SCRIPT — QRIS Payment Monitor
// Berjalan di dalam tab merchant.qris.interactive.co.id
// =============================================================

// ── Default CONFIG (bisa dioverride dari popup via storage) ────
const CONFIG_DEFAULT = {
    // URL patterns
    URL_LOGIN: '/v2/m/login/',
    URL_VERIFIKASI: 'verification.php',
    URL_HISTORI: 'historytrx.php',
    URL_REDIRECT: 'https://merchant.qris.interactive.co.id/v2/m/kontenr.php?idir=pages/historytrx.php',

    // Polling (dapat diubah dari popup)
    POLL_INTERVAL_MS: 5000,          // interval scrape tabel
    COMMAND_POLL_INTERVAL_MS: 30000, // interval tanya server
    COMMAND_JITTER_MS: 2000,

    // Reload (dapat diubah dari popup)
    RELOAD_NO_TRX_MIN: 14,    // reload jika TIDAK ada transaksi baru selama X menit
    RELOAD_AFTER_TRX_MS: 30000, // reload setelah ada transaksi, tunggu X ms dulu
    RELOAD_JITTER_MS: 60000,
    MIN_RELOAD_GAP_MS: 25000,

    // Selector DOM
    TABLE_ROW_SELECTOR: 'table tbody tr',
    COL: {
        WAKTU: 1, NOMINAL: 2, STATUS: 5,
        NAMA: 6, METODE: 7, RRN: 8,
        KODE_REF: 9, UID_HASH: 10,
    }
};

// CONFIG aktif — diisi dari storage, lalu merge dengan default
let CONFIG = { ...CONFIG_DEFAULT };

// Load timing config dari storage
async function loadTimingConfig() {
    try {
        const { timingConfig } = await chrome.storage.local.get('timingConfig');
        if (timingConfig) {
            CONFIG = { ...CONFIG_DEFAULT, ...timingConfig };
            log('Timing config dimuat:', {
                poll: CONFIG.POLL_INTERVAL_MS + 'ms',
                reloadNoTrx: CONFIG.RELOAD_NO_TRX_MIN + ' menit',
                reloadAfterTrx: CONFIG.RELOAD_AFTER_TRX_MS + 'ms'
            });
        }
    } catch {
        // Gunakan default jika storage tidak bisa diakses
    }
}

// ── State ──────────────────────────────────────────────────────
// knownUids di-load dari sessionStorage agar tidak reset setelah reload
const _knownRaw = sessionStorage.getItem('qris_known_uids');
const knownUids = new Set(_knownRaw ? JSON.parse(_knownRaw) : []);

let pollingTimer = null;
let commandTimer = null;
let reloadCheckTimer = null;

// lastReloadTime juga di-persist ke sessionStorage
const _lastReload = sessionStorage.getItem('qris_last_reload_time');
let lastReloadTime = _lastReload ? parseInt(_lastReload, 10) : Date.now();

let lastTrxTime = null;   // waktu terakhir ada transaksi baru
let lastUrl = window.location.href;
let reloadQueue = [];
let isProcessingQueue = false;

// Flag: sudah minta reload setelah trx? reset saat knownUids bersih
let afterTrxReloadScheduled = false;

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

// ── Auto-fill Login (Staff Account) ────────────────────────────
const STAFF_CREDS = {
    email: 'nurulnisya217@gmail.com',
    pass: '@Merdeka321'
};

function autoFillLogin() {
    let attempts = 0;
    const maxAttempts = 10;

    const tryFill = () => {
        const emailEl = document.querySelector('input[type="email"], input[name="email"], input[placeholder*="email" i]');
        const passEl = document.querySelector('input[type="password"]');

        if (!emailEl || !passEl) {
            if (++attempts < maxAttempts) setTimeout(tryFill, 500);
            return;
        }

        // Isi field
        const setVal = (el, val) => {
            el.focus();
            el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        setVal(emailEl, STAFF_CREDS.email);
        setVal(passEl, STAFF_CREDS.pass);
        log('Auto-fill login berhasil');

        // Inject tombol "Login Otomatis" jika belum ada
        if (document.getElementById('qris-autologin-btn')) return;

        const btn = document.createElement('button');
        btn.id = 'qris-autologin-btn';
        btn.type = 'button';
        btn.textContent = '🔑 Login Otomatis (Staff Monitor)';
        btn.style.cssText = [
            'display:block', 'width:100%', 'margin-top:10px',
            'padding:10px 16px', 'background:#f2d00d', 'color:#000',
            'border:2px solid #000', 'border-radius:6px',
            'font-weight:700', 'font-size:14px', 'cursor:pointer',
            'box-shadow:3px 3px 0 #000', 'transition:all .15s'
        ].join(';');
        btn.addEventListener('click', () => {
            // Re-fill (just in case cleared) then find & click submit
            setVal(emailEl, STAFF_CREDS.email);
            setVal(passEl, STAFF_CREDS.pass);
            const submitBtn = document.querySelector('button[type="submit"], input[type="submit"]');
            if (submitBtn) submitBtn.click();
        });
        // Masukkan setelah form password
        passEl.closest('div, form')?.appendChild(btn);
    };
    setTimeout(tryFill, 800);
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

        // Auto-fill login credentials (akun staff monitor)
        autoFillLogin();
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

    // Simpan knownUids ke sessionStorage (persist antar reload)
    try { sessionStorage.setItem('qris_known_uids', JSON.stringify([...knownUids])); } catch { }

    log(`${baruList.length} transaksi baru dikirim ke server (total known: ${knownUids.size})`,
        baruList.map(t => `${t.nominal_raw} [${t.uid_hash.substring(0, 8)}]`));

    // Tandai waktu transaksi terakhir
    lastTrxTime = Date.now();

    // Kirim BATCH ke background.js — semua transaksi baru sekaligus
    chrome.runtime.sendMessage({
        type: 'TRANSAKSI_BATCH',
        batch: baruList
    });

    // Setelah ada transaksi baru, reload SATU KALI untuk refresh data
    // Guard: jangan schedule ulang jika sudah ada pending reload
    if (CONFIG.RELOAD_AFTER_TRX_MS > 0 && !afterTrxReloadScheduled) {
        afterTrxReloadScheduled = true;
        setTimeout(() => {
            afterTrxReloadScheduled = false;
            // Hanya reload jika tidak ada transaksi baru dalam window itu
            if (Date.now() - lastTrxTime >= CONFIG.RELOAD_AFTER_TRX_MS - 1000) {
                enqueueReload('after_trx_refresh');
            }
        }, CONFIG.RELOAD_AFTER_TRX_MS);
    }
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
        // Persist lastReloadTime agar setelah reload tidak trigger langsung
        try { sessionStorage.setItem('qris_last_reload_time', String(lastReloadTime)); } catch { }
        location.reload();
        return; // reload memutus eksekusi
    }
    isProcessingQueue = false;
}

// ── Auto-Reload: jika tidak ada transaksi selama X menit ──────
function startAutoReloadCheck() {
    if (reloadCheckTimer) return;
    reloadCheckTimer = setInterval(() => {
        // Sinkron lastReloadTime dari sessionStorage (mungkin diperbarui oleh reload)
        const saved = sessionStorage.getItem('qris_last_reload_time');
        if (saved) lastReloadTime = Math.max(lastReloadTime, parseInt(saved, 10));

        const elapsed = Date.now() - lastReloadTime;
        const targetMs = CONFIG.RELOAD_NO_TRX_MIN * 60 * 1000;
        const jitter = Math.random() * CONFIG.RELOAD_JITTER_MS;

        if (elapsed >= targetMs + jitter) {
            log(`Auto-reload: tidak ada transaksi selama ${CONFIG.RELOAD_NO_TRX_MIN} menit`);
            enqueueReload('no_trx_timeout');
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

// ── Dengar perubahan storage dari popup (tanpa reload halaman) ─
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.timingConfig) {
        const newCfg = changes.timingConfig.newValue;
        if (!newCfg) return;
        CONFIG = { ...CONFIG_DEFAULT, ...newCfg };
        log('Timing config diperbarui dari popup:', {
            poll: CONFIG.POLL_INTERVAL_MS + 'ms',
            reloadNoTrx: CONFIG.RELOAD_NO_TRX_MIN + ' menit',
            reloadAfterTrx: CONFIG.RELOAD_AFTER_TRX_MS + 'ms'
        });
        // Restart polling agar interval baru langsung berlaku
        stopScraping();
        stopCommandPolling();
        if (reloadCheckTimer) { clearInterval(reloadCheckTimer); reloadCheckTimer = null; }
        startScraping();
        startCommandPolling();
        startAutoReloadCheck();
    }
});

// ── Init ───────────────────────────────────────────────────────
(async () => {
    await loadTimingConfig(); // baca config sebelum mulai
    log('Content script aktif, cek status halaman...');
    cekStatusHalaman();
})();
