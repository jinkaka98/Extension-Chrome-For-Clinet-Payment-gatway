// =============================================================
// BACKGROUND SERVICE WORKER — QRIS Payment Monitor
// DUAL BROADCAST MODE: kirim ke semua server aktif secara paralel
// Jika Local + Production keduanya online → keduanya menerima data
// =============================================================

const API_KEY = 'AlpaKyros_QRIS_Monitor_2026';
const PING_TIMEOUT_MS = 5000; // timeout cek server (5 detik — lebih longgar)

// ── Konfigurasi Default Server ────────────────────────────────
// CATATAN: IP ini akan di-override oleh config yang tersimpan di storage.
// User bisa ganti URL lewat tab Pengaturan di popup.
const DEFAULT_SERVERS = {
    local: {
        id: 'local',
        label: 'Local 🏠',
        url: 'http://localhost:8000/api/qris',
        enabled: true
    },
    production: {
        id: 'production',
        label: 'Production 🌐',
        url: 'https://alpakyros.com/api/qris',
        enabled: true
    }
};

// ── Ambil konfigurasi server dari storage ─────────────────────
// Selalu baca dari storage dulu; fallback ke DEFAULT hanya jika kosong.
async function getServers() {
    try {
        const { serverConfig } = await chrome.storage.local.get('serverConfig');
        if (serverConfig && serverConfig.local && serverConfig.production) {
            // ── Migrasi otomatis: jika masih pakai IP 192.168.x.x, ganti ke localhost
            // Karena extension & backend ada di mesin yang sama (Armbian)
            let migrated = false;
            if (serverConfig.local.url && /192\.168\.\d+\.\d+/.test(serverConfig.local.url)) {
                serverConfig.local.url = serverConfig.local.url.replace(/192\.168\.\d+\.\d+/, 'localhost');
                migrated = true;
            }
            if (migrated) {
                console.log('[QRIS BG] ⚡ Migrasi URL lokal → localhost:', serverConfig.local.url);
                await chrome.storage.local.set({ serverConfig });
            }

            console.log('[QRIS BG] getServers: dari storage →', serverConfig.local.url, '|', serverConfig.production.url);
            return serverConfig;
        }
    } catch (e) {
        console.warn('[QRIS BG] getServers: gagal baca storage:', e.message);
    }
    console.log('[QRIS BG] getServers: pakai DEFAULT →', DEFAULT_SERVERS.local.url, '|', DEFAULT_SERVERS.production.url);
    return DEFAULT_SERVERS;
}

// ── Cek apakah satu server reachable (dengan timeout) ─────────
async function checkServer(serverObj) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);

    try {
        console.log(`[QRIS BG] Ping ${serverObj.id} → ${serverObj.url}/ping`);
        const res = await fetch(`${serverObj.url}/ping`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Monitor-Key': API_KEY
            },
            body: JSON.stringify({ ping: true, timestamp: new Date().toISOString() }),
            signal: controller.signal
        });
        clearTimeout(timer);
        console.log(`[QRIS BG] Ping ${serverObj.id} → HTTP ${res.status}`);

        if (!res.ok) {
            try {
                const errBody = await res.text();
                console.warn(`[QRIS BG] Ping ${serverObj.id} error body:`, errBody.substring(0, 300));
            } catch { }
        }
        return res.ok;
    } catch (e) {
        clearTimeout(timer);
        console.warn(`[QRIS BG] Ping ${serverObj.id} EXCEPTION:`, e.message);
        return false;
    }
}

// ── Auto-detect: cek kedua server, update status di storage ───
async function autoDetectServers() {
    const servers = await getServers();
    console.log('[QRIS BG] Auto-detect dimulai. Local:', servers.local.url, '| Production:', servers.production.url);

    const checks = await Promise.all([
        checkServer(servers.local).then(ok => ({ id: 'local', reachable: ok })),
        checkServer(servers.production).then(ok => ({ id: 'production', reachable: ok }))
    ]);

    const statusMap = {};
    for (const c of checks) {
        statusMap[c.id] = c.reachable;
    }

    // Simpan hasil deteksi ke storage
    await chrome.storage.local.set({ serverReachability: statusMap });

    const aktif = checks.filter(c => c.reachable).map(c => c.id);
    console.log('[QRIS BG] Auto-detect selesai. Aktif:', aktif.length > 0 ? aktif.join(' + ') : 'tidak ada');

    return statusMap;
}

// ── Ambil daftar URL server yang aktif (reachable) ────────────
async function getActiveServerUrls() {
    const servers = await getServers();
    const { serverReachability } = await chrome.storage.local.get('serverReachability');

    // Jika belum pernah detect, anggap semua aktif dulu
    if (!serverReachability) {
        return [servers.local.url, servers.production.url];
    }

    const aktif = [];
    if (serverReachability.local) aktif.push(servers.local.url);
    if (serverReachability.production) aktif.push(servers.production.url);

    // Fallback: jika tidak ada yang aktif, coba production
    if (aktif.length === 0) aktif.push(servers.production.url);

    return aktif;
}

// ── HTTP Helper: kirim ke SATU URL ───────────────────────────
async function kirimSatu(url, endpoint, payload) {
    try {
        const res = await fetch(`${url}/${endpoint}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Monitor-Key': API_KEY
            },
            body: JSON.stringify({ ...payload, timestamp: new Date().toISOString() })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { url, ok: true, data: await res.json() };
    } catch (e) {
        return { url, ok: false, error: e.message };
    }
}

// ── BROADCAST: kirim ke semua server aktif secara paralel ─────
async function kirimKeServer(endpoint, payload = {}) {
    const urls = await getActiveServerUrls();
    const results = await Promise.all(urls.map(url => kirimSatu(url, endpoint, payload)));

    const gagal = results.filter(r => !r.ok);
    const berhasil = results.filter(r => r.ok);

    if (berhasil.length > 0) {
        console.log(`[QRIS BG] Terkirim ke ${berhasil.length} server:`, berhasil.map(r => r.url).join(', '));
    }

    // Queue ulang yang gagal
    for (const item of gagal) {
        console.warn(`[QRIS BG] Gagal kirim ke ${item.url}:`, item.error);
        await queuePesan(endpoint, payload, item.url);
    }

    return results;
}

// ── GET dari server (pakai server pertama yang aktif) ─────────
async function getFromServer(endpoint) {
    const urls = await getActiveServerUrls();
    for (const url of urls) {
        try {
            const res = await fetch(`${url}/${endpoint}`, {
                method: 'GET',
                headers: { 'X-Monitor-Key': API_KEY }
            });
            if (res.ok) return await res.json();
        } catch {
            // coba url berikutnya
        }
    }
    return null;
}

// ── Pending Queue ─────────────────────────────────────────────
async function queuePesan(endpoint, payload, targetUrl = null) {
    const { pendingQueue = [] } = await chrome.storage.local.get('pendingQueue');
    pendingQueue.push({ endpoint, payload, targetUrl, queuedAt: Date.now() });
    await chrome.storage.local.set({ pendingQueue });
}

async function retryPendingQueue() {
    const { pendingQueue = [] } = await chrome.storage.local.get('pendingQueue');
    if (pendingQueue.length === 0) return;

    const gagalLagi = [];

    for (const item of pendingQueue) {
        const urls = item.targetUrl ? [item.targetUrl] : await getActiveServerUrls();
        let berhasil = false;

        for (const url of urls) {
            try {
                const res = await fetch(`${url}/${item.endpoint}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Monitor-Key': API_KEY },
                    body: JSON.stringify(item.payload)
                });
                if (res.ok) { berhasil = true; break; }
            } catch { /* lanjut */ }
        }

        if (!berhasil) gagalLagi.push(item);
    }

    await chrome.storage.local.set({ pendingQueue: gagalLagi });
    const terkirim = pendingQueue.length - gagalLagi.length;
    if (terkirim > 0) console.log(`[QRIS BG] ${terkirim} pending berhasil dikirim ulang`);
}

// ── Listener dari content.js ──────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
        switch (message.type) {

            case 'TRANSAKSI_BATCH': {
                const batch = message.batch || [];
                console.log(`[QRIS BG] Batch ${batch.length} transaksi → broadcast ke semua server aktif`);

                const results = await kirimKeServer('transaksi-batch', { transaksi_list: batch });

                if (batch.length > 0) {
                    await chrome.storage.local.set({
                        lastTransaksi: batch[0],
                        lastTransaksiTime: new Date().toISOString()
                    });
                    const { totalHariIni = 0 } = await chrome.storage.local.get('totalHariIni');
                    await chrome.storage.local.set({ totalHariIni: totalHariIni + batch.length });
                }

                sendResponse({ ok: true, results });
                break;
            }

            case 'TRANSAKSI_BARU': {
                console.log('[QRIS BG] Transaksi baru → broadcast ke semua server aktif');

                const results = await kirimKeServer('transaksi', {
                    transaksi: message.data,
                    konteks: message.semua
                });

                await chrome.storage.local.set({
                    lastTransaksi: message.data,
                    lastTransaksiTime: new Date().toISOString()
                });

                const { totalHariIni = 0 } = await chrome.storage.local.get('totalHariIni');
                await chrome.storage.local.set({ totalHariIni: totalHariIni + 1 });

                sendResponse({ ok: true, results });
                break;
            }

            case 'SESSION_EXPIRED': {
                await kirimKeServer('session-expired', {});
                await chrome.storage.local.set({ sessionStatus: 'expired' });
                sendResponse({ ok: true });
                break;
            }

            case 'SUDAH_LOGIN': {
                await kirimKeServer('monitor-up', {});
                await chrome.storage.local.set({
                    sessionStatus: 'active',
                    monitorStatus: 'online'
                });
                sendResponse({ ok: true });
                break;
            }

            case 'CEK_PERINTAH': {
                const serverResponse = await getFromServer('pending-commands');
                const commandData = serverResponse?.data || { command: null };
                sendResponse(commandData);
                break;
            }

            // Jalankan auto-detect manual dari popup
            case 'AUTO_DETECT': {
                console.log('[QRIS BG] Auto-detect dipicu manual...');
                const reachability = await autoDetectServers();
                sendResponse({ ok: true, reachability });
                break;
            }

            // Ping ke semua server, report hasilnya
            case 'PING_SERVER': {
                console.log('[QRIS BG] Ping broadcast ke semua server...');
                const servers = await getServers();
                const startTimes = {};
                const pingResults = {};

                const pings = [servers.local, servers.production].map(async (srv) => {
                    const t0 = performance.now();
                    startTimes[srv.id] = t0;
                    try {
                        const res = await fetch(`${srv.url}/ping`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'X-Monitor-Key': API_KEY },
                            body: JSON.stringify({ ping: true, timestamp: new Date().toISOString() })
                        });
                        const latency = Math.round(performance.now() - t0);
                        if (res.ok) {
                            let data = null;
                            try { data = await res.json(); } catch { }
                            pingResults[srv.id] = { ok: true, latency, httpCode: res.status, url: srv.url, label: srv.label, serverData: data };
                        } else {
                            let errText = `HTTP ${res.status}`;
                            try { errText = (await res.text()).substring(0, 200); } catch { }
                            pingResults[srv.id] = { ok: false, latency, httpCode: res.status, url: srv.url, label: srv.label, error: errText };
                        }
                    } catch (e) {
                        const latency = Math.round(performance.now() - startTimes[srv.id]);
                        pingResults[srv.id] = { ok: false, latency, url: srv.url, label: srv.label, error: e.message };
                    }
                });

                await Promise.all(pings);

                // Update reachability berdasarkan hasil ping
                await chrome.storage.local.set({
                    serverReachability: {
                        local: pingResults.local?.ok || false,
                        production: pingResults.production?.ok || false
                    }
                });

                sendResponse({ ok: true, results: pingResults, testedAt: new Date().toISOString() });
                break;
            }

            // ── Simpan konfigurasi URL server ──────────────────────
            // PENTING: Setelah save, LANGSUNG auto-detect dengan config baru
            case 'SAVE_SERVER_CONFIG': {
                const config = message.config;
                console.log('[QRIS BG] Simpan server config. Local:', config.local?.url, '| Production:', config.production?.url);

                // Simpan ke storage
                await chrome.storage.local.set({ serverConfig: config });

                // Verifikasi tersimpan dengan benar
                const verify = await chrome.storage.local.get('serverConfig');
                if (verify.serverConfig?.local?.url === config.local?.url) {
                    console.log('[QRIS BG] ✅ Config terverifikasi tersimpan:', verify.serverConfig.local.url);
                } else {
                    console.error('[QRIS BG] ❌ Config GAGAL tersimpan! Verify:', verify.serverConfig);
                }

                // Langsung re-detect dengan config baru
                const reachability = await autoDetectServers();

                sendResponse({ ok: true, reachability });
                break;
            }

            // Ambil konfigurasi + status reachability
            case 'GET_SERVER_STATUS': {
                const servers = await getServers();
                const { serverReachability } = await chrome.storage.local.get('serverReachability');
                console.log('[QRIS BG] GET_SERVER_STATUS →', servers.local.url, '| reachable:', serverReachability);
                sendResponse({ ok: true, servers, reachability: serverReachability || null });
                break;
            }

            default:
                sendResponse({ ok: false, error: 'Unknown message type' });
        }
    })();

    return true;
});

// ── Keepalive, Heartbeat & Auto-Detect Periodik ───────────────
chrome.alarms.create('keepalive', { periodInMinutes: 1 });
chrome.alarms.create('auto-detect', { periodInMinutes: 2 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'keepalive') {
        await kirimKeServer('heartbeat', {});
        await retryPendingQueue();
        console.log('[QRIS BG] Heartbeat broadcast selesai');
    }
    if (alarm.name === 'auto-detect') {
        await autoDetectServers();
    }
});

// ── Inisialisasi ──────────────────────────────────────────────
(async () => {
    const { lastDate } = await chrome.storage.local.get('lastDate');
    const today = new Date().toDateString();
    if (lastDate !== today) {
        await chrome.storage.local.set({ lastDate: today, totalHariIni: 0 });
    }

    await chrome.storage.local.set({ monitorStatus: 'starting' });

    // Baca config yang tersimpan dan log
    const servers = await getServers();
    console.log('[QRIS BG] ═══════════════════════════════════════');
    console.log('[QRIS BG] Service Worker AKTIF');
    console.log('[QRIS BG] Local  URL:', servers.local.url);
    console.log('[QRIS BG] Prod   URL:', servers.production.url);
    console.log('[QRIS BG] ═══════════════════════════════════════');

    // Auto-detect server
    await autoDetectServers();
    console.log('[QRIS BG] Siap. Mode: DUAL BROADCAST');
})();
