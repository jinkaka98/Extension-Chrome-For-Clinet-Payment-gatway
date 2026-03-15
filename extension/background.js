// =============================================================
// BACKGROUND SERVICE WORKER — QRIS Payment Monitor
// DUAL BROADCAST MODE: kirim ke semua server aktif secara paralel
// Jika Local + Production keduanya online → keduanya menerima data
// =============================================================

const API_KEY = 'AlpaKyros_QRIS_Monitor_2026';
const PING_TIMEOUT_MS = 5000; // timeout cek server (5 detik — lebih longgar)
const SCAN_TIMEOUT_MS = 1500; // timeout per-IP saat LAN scan (cepat)
const SCAN_PORT = 8000;

// ── Konfigurasi Default Server ────────────────────────────────
// CATATAN: IP ini akan di-override oleh config yang tersimpan di storage.
// User bisa ganti URL lewat tab Pengaturan di popup.
// PENTING: "localhost" dari Armbian merujuk ke Armbian itu sendiri!
// Gunakan IP LAN PC yang menjalankan backend (cek: ipconfig → IPv4).
const DEFAULT_SERVERS = {
    local: {
        id: 'local',
        label: 'Local 🏠',
        url: 'http://192.168.1.16:8000/api/qris',   // ← IP LAN PC (bukan localhost)
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

// ── LAN Auto-Scan: probe IP:8000 untuk cari backend ──────────
// Fully dynamic: detect network interfaces → derive subnets → scan
async function scanSingleIP(ip) {
    const url = `http://${ip}:${SCAN_PORT}/api/qris`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);
    try {
        const res = await fetch(`${url}/ping`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Monitor-Key': API_KEY },
            body: JSON.stringify({ ping: true, scan: true }),
            signal: controller.signal
        });
        clearTimeout(timer);
        if (res.ok) {
            console.log(`[QRIS BG] ✅ LAN scan: found server at ${ip}:${SCAN_PORT}`);
            return { ip, url, ok: true };
        }
        return { ip, url, ok: false };
    } catch {
        clearTimeout(timer);
        return { ip, url, ok: false };
    }
}

// Derive subnet prefix from an IP address (e.g., "192.168.1.12" → "192.168.1")
function getSubnetPrefix(ip) {
    const parts = ip.split('.');
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}`;
    return null;
}

// Detect local network interfaces via Chrome API → return unique subnet prefixes
async function detectSubnets() {
    const subnets = new Set();

    try {
        if (chrome.system && chrome.system.network && chrome.system.network.getNetworkInterfaces) {
            const interfaces = await new Promise((resolve, reject) => {
                chrome.system.network.getNetworkInterfaces((ifaces) => {
                    if (chrome.runtime.lastError) {
                        reject(chrome.runtime.lastError);
                    } else {
                        resolve(ifaces || []);
                    }
                });
            });

            console.log(`[QRIS BG] 🌐 Network interfaces detected: ${interfaces.length}`);
            for (const iface of interfaces) {
                // Only IPv4 addresses (skip IPv6, loopback, link-local)
                if (iface.address && iface.address.includes('.') &&
                    !iface.address.startsWith('127.') &&
                    !iface.address.startsWith('169.254.')) {
                    const prefix = getSubnetPrefix(iface.address);
                    if (prefix) {
                        subnets.add(prefix);
                        console.log(`[QRIS BG]   → Interface: ${iface.name || '?'} = ${iface.address} → subnet ${prefix}.*`);
                    }
                }
            }
        }
    } catch (e) {
        console.warn('[QRIS BG] ⚠️ chrome.system.network failed:', e.message);
    }

    // If no subnets detected (API unavailable), add common defaults as fallback
    if (subnets.size === 0) {
        console.log('[QRIS BG] ⚠️ No interfaces detected, using fallback subnets');
        subnets.add('192.168.1');
        subnets.add('192.168.0');
    }

    return [...subnets];
}

async function scanLAN() {
    console.log('[QRIS BG] 🔍 Smart LAN scan dimulai...');

    // Step 1: Detect actual subnets from network interfaces
    const subnets = await detectSubnets();
    console.log(`[QRIS BG] 📡 Subnets to scan: ${subnets.join(', ')}`);

    // Step 2: Build candidate list from detected subnets
    const candidates = ['127.0.0.1', 'localhost'];

    for (const subnet of subnets) {
        // Full range: 1-254 for each detected subnet
        for (let host = 1; host <= 254; host++) {
            candidates.push(`${subnet}.${host}`);
        }
    }

    console.log(`[QRIS BG] 🎯 Total candidates: ${candidates.length} IPs across ${subnets.length} subnet(s)`);

    // Step 3: Scan in batches (20 parallel for speed)
    const BATCH_SIZE = 20;
    let scanned = 0;
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
        const batch = candidates.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(ip => scanSingleIP(ip)));
        scanned += batch.length;
        const found = results.find(r => r.ok);
        if (found) {
            console.log(`[QRIS BG] 🎯 LAN scan berhasil! Server ditemukan di: ${found.url} (scanned ${scanned} IPs)`);
            return found;
        }
    }

    console.log(`[QRIS BG] ❌ LAN scan selesai — tidak menemukan server (scanned ${scanned} IPs)`);
    return null;
}

// ── Auto-detect: cek kedua server, update status di storage ───
//    Sekarang dengan LAN scan fallback jika local gagal.
async function autoDetectServers(enableLanScan = false) {
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

    // Jika local TIDAK reachable DAN LAN scan diaktifkan → cari otomatis
    if (!statusMap.local && enableLanScan) {
        console.log('[QRIS BG] Local offline → memulai LAN scan otomatis...');
        const found = await scanLAN();
        if (found) {
            // Update server config dengan IP baru
            const newConfig = {
                local: { id: 'local', label: 'Local 🏠', url: found.url, enabled: true },
                production: servers.production
            };
            await chrome.storage.local.set({ serverConfig: newConfig });
            statusMap.local = true;
            statusMap._autoDiscovered = found.url;
            console.log(`[QRIS BG] 🔄 Config local auto-updated ke: ${found.url}`);
        }
    }

    // Simpan hasil deteksi ke storage
    await chrome.storage.local.set({ serverReachability: statusMap });

    const aktif = checks.filter(c => c.reachable).map(c => c.id);
    if (statusMap._autoDiscovered) aktif.push('local(auto-discovered)');
    console.log('[QRIS BG] Auto-detect selesai. Aktif:', aktif.length > 0 ? aktif.join(' + ') : 'tidak ada');

    return statusMap;
}

// ── Periodic auto-detect: setiap 5 menit refresh serverReachability ──
const AUTO_DETECT_INTERVAL_MS = 5 * 60 * 1000; // 5 menit
setInterval(async () => {
    console.log('[QRIS BG] Periodic auto-detect...');
    try { await autoDetectServers(); } catch (e) {
        console.warn('[QRIS BG] Periodic auto-detect gagal:', e.message);
    }
}, AUTO_DETECT_INTERVAL_MS);
// Jalankan auto-detect saat extension dimuat
setTimeout(() => { autoDetectServers().catch(() => { }); }, 3000);

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

// ── HTTP Helper: kirim ke SATU URL (dengan timeout) ──────────
const FETCH_TIMEOUT_MS = 5000; // 5 detik timeout per request

async function kirimSatu(url, endpoint, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(`${url}/${endpoint}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Monitor-Key': API_KEY
            },
            body: JSON.stringify({ ...payload, timestamp: new Date().toISOString() }),
            signal: controller.signal
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { url, ok: true, data: await res.json() };
    } catch (e) {
        clearTimeout(timer);
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

// ── GET dari server (pakai server pertama yang aktif, dengan timeout) ──
async function getFromServer(endpoint) {
    const urls = await getActiveServerUrls();
    for (const url of urls) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            // Cache-buster: LiteSpeed cache GET responses agresif
            const cacheBuster = `_t=${Date.now()}`;
            const separator = endpoint.includes('?') ? '&' : '?';
            const res = await fetch(`${url}/${endpoint}${separator}${cacheBuster}`, {
                method: 'GET',
                headers: {
                    'X-Monitor-Key': API_KEY,
                    'Cache-Control': 'no-cache, no-store'
                },
                signal: controller.signal
            });
            clearTimeout(timer);
            if (res.ok) return await res.json();
        } catch {
            clearTimeout(timer);
            // timeout atau error → coba url berikutnya
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

// ── Format durasi ms → teks "Xj Xm Xd" ──────────────────────
function formatDuration(ms) {
    if (!ms || ms < 0) return '—';
    const totalSec = Math.floor(ms / 1000);
    const jam = Math.floor(totalSec / 3600);
    const menit = Math.floor((totalSec % 3600) / 60);
    const detik = totalSec % 60;
    const parts = [];
    if (jam > 0) parts.push(`${jam}j`);
    if (menit > 0) parts.push(`${menit}m`);
    parts.push(`${detik}d`);
    return parts.join(' ');
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

            // Jalankan auto-detect manual dari popup (dengan LAN scan)
            case 'AUTO_DETECT': {
                console.log('[QRIS BG] Auto-detect dipicu manual (dengan LAN scan)...');
                const reachability = await autoDetectServers(true); // enable LAN scan
                const updatedServers = await getServers();
                sendResponse({
                    ok: true,
                    reachability,
                    servers: updatedServers,
                    autoDiscovered: reachability._autoDiscovered || null
                });
                break;
            }

            // LAN Scan manual (scan only, tanpa auto-detect)
            case 'LAN_SCAN': {
                console.log('[QRIS BG] LAN scan manual dipicu...');
                const scanResult = await scanLAN();
                if (scanResult) {
                    // Auto-update config
                    const currentServers = await getServers();
                    const newConfig = {
                        local: { id: 'local', label: 'Local 🏠', url: scanResult.url, enabled: true },
                        production: currentServers.production
                    };
                    await chrome.storage.local.set({ serverConfig: newConfig });
                    // Re-detect with new config
                    const newReachability = await autoDetectServers(false);
                    sendResponse({
                        ok: true,
                        found: true,
                        discoveredUrl: scanResult.url,
                        discoveredIp: scanResult.ip,
                        servers: newConfig,
                        reachability: newReachability
                    });
                } else {
                    sendResponse({ ok: true, found: false });
                }
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

            // ── Session History Log ──────────────────────────────
            case 'SESSION_LOGIN': {
                const loginTime = message.timestamp || new Date().toISOString();

                // Cek apakah sudah ada session aktif (mencegah duplikat saat reload)
                const { currentSessionStart: existingStart } = await chrome.storage.local.get('currentSessionStart');
                if (existingStart) {
                    console.log('[QRIS BG] ⚠️ Session sudah aktif sejak', existingStart, '— skip duplikat login');
                    sendResponse({ ok: true, skipped: true });
                    break;
                }

                console.log('[QRIS BG] 📝 Session LOGIN dicatat:', loginTime);

                // Simpan sebagai pending session (belum ada logout)
                await chrome.storage.local.set({
                    currentSessionStart: loginTime
                });

                // Tambahkan entry "login" ke log (belum ada logoutAt)
                const { sessionLog = [] } = await chrome.storage.local.get('sessionLog');
                sessionLog.push({
                    id: Date.now(),
                    loginAt: loginTime,
                    logoutAt: null,
                    durationMs: null,
                    durationText: null,
                    status: 'active'
                });

                // Max 50 entries
                while (sessionLog.length > 50) sessionLog.shift();
                await chrome.storage.local.set({ sessionLog });

                sendResponse({ ok: true });
                break;
            }

            case 'SESSION_LOGOUT': {
                const logoutTime = message.timestamp || new Date().toISOString();
                console.log('[QRIS BG] 📝 Session LOGOUT dicatat:', logoutTime);

                const { currentSessionStart } = await chrome.storage.local.get('currentSessionStart');
                const { sessionLog = [] } = await chrome.storage.local.get('sessionLog');

                if (currentSessionStart) {
                    // Hitung durasi
                    const loginDate = new Date(currentSessionStart);
                    const logoutDate = new Date(logoutTime);
                    const durationMs = logoutDate - loginDate;
                    const durationText = formatDuration(durationMs);

                    console.log(`[QRIS BG] 📊 Durasi session: ${durationText} (${durationMs}ms)`);

                    // Cari entry terakhir yang masih "active" dan update
                    const lastActive = [...sessionLog].reverse().find(e => e.status === 'active');
                    if (lastActive) {
                        lastActive.logoutAt = logoutTime;
                        lastActive.durationMs = durationMs;
                        lastActive.durationText = durationText;
                        lastActive.status = 'expired';
                    } else {
                        // Tidak ada entry active, buat baru (fallback)
                        sessionLog.push({
                            id: Date.now(),
                            loginAt: currentSessionStart,
                            logoutAt: logoutTime,
                            durationMs,
                            durationText,
                            status: 'expired'
                        });
                    }

                    // Clear current session
                    await chrome.storage.local.remove('currentSessionStart');
                } else {
                    // Tidak ada login tercatat, skip — jangan buat entry orphan
                    console.log('[QRIS BG] ⚠️ Logout terdeteksi tapi tidak ada login sebelumnya, skip');
                }

                while (sessionLog.length > 50) sessionLog.shift();
                await chrome.storage.local.set({ sessionLog });

                sendResponse({ ok: true });
                break;
            }

            case 'GET_SESSION_LOG': {
                const { sessionLog = [] } = await chrome.storage.local.get('sessionLog');
                const { currentSessionStart = null } = await chrome.storage.local.get('currentSessionStart');
                sendResponse({ ok: true, sessionLog, currentSessionStart });
                break;
            }

            case 'CLEAR_SESSION_LOG': {
                await chrome.storage.local.set({ sessionLog: [] });
                await chrome.storage.local.remove('currentSessionStart');
                console.log('[QRIS BG] 🗑 Session log dihapus');
                sendResponse({ ok: true });
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
