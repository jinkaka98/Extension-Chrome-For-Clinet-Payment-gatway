// =============================================================
// BACKGROUND SERVICE WORKER — QRIS Payment Monitor
// Relay pesan dari content.js ke PHP web server via fetch()
// Armbian tidak butuh IP publik — semua request OUTBOUND
// =============================================================

// ⚠️ SETTING UNTUK LOCAL TESTING
const API_BASE = 'http://192.168.1.12:8000/api/qris';
const API_KEY = 'AlpaKyros_QRIS_Monitor_2026';

// ── HTTP Helper ───────────────────────────────────────────────
async function kirimKeServer(endpoint, payload = {}) {
    try {
        const res = await fetch(`${API_BASE}/${endpoint}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Monitor-Key': API_KEY
            },
            body: JSON.stringify({
                ...payload,
                timestamp: new Date().toISOString()
            })
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (e) {
        console.warn('[QRIS BG] Gagal kirim ke server:', endpoint, e.message);
        // Simpan ke pending queue
        await queuePesan(endpoint, payload);
        return null;
    }
}

async function getFromServer(endpoint) {
    try {
        const res = await fetch(`${API_BASE}/${endpoint}`, {
            method: 'GET',
            headers: { 'X-Monitor-Key': API_KEY }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (e) {
        console.warn('[QRIS BG] Gagal GET dari server:', endpoint, e.message);
        return null;
    }
}

// ── Pending Queue (buffer saat internet putus sesaat) ─────────
async function queuePesan(endpoint, payload) {
    const { pendingQueue = [] } = await chrome.storage.local.get('pendingQueue');
    pendingQueue.push({ endpoint, payload, queuedAt: Date.now() });
    await chrome.storage.local.set({ pendingQueue });
}

async function retryPendingQueue() {
    const { pendingQueue = [] } = await chrome.storage.local.get('pendingQueue');
    if (pendingQueue.length === 0) return;

    const berhasil = [];
    const gagalLagi = [];

    for (const item of pendingQueue) {
        try {
            const res = await fetch(`${API_BASE}/${item.endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Monitor-Key': API_KEY },
                body: JSON.stringify(item.payload)
            });
            if (res.ok) berhasil.push(item);
            else gagalLagi.push(item);
        } catch {
            gagalLagi.push(item);
        }
    }

    await chrome.storage.local.set({ pendingQueue: gagalLagi });
    if (berhasil.length > 0) console.log(`[QRIS BG] ${berhasil.length} pesan pending berhasil dikirim ulang`);
}

// ── Listener dari content.js ──────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    // Harus return true agar sendResponse bisa dipanggil async
    (async () => {
        switch (message.type) {

            // Transaksi baru terdeteksi dari scraping DOM
            case 'TRANSAKSI_BARU': {
                console.log('[QRIS BG] Transaksi baru diterima:', message.data?.nominal_raw);

                const result = await kirimKeServer('transaksi', {
                    transaksi: message.data,
                    konteks: message.semua
                });

                // Update storage untuk popup
                await chrome.storage.local.set({
                    lastTransaksi: message.data,
                    lastTransaksiTime: new Date().toISOString()
                });

                // Increment counter harian
                const { totalHariIni = 0 } = await chrome.storage.local.get('totalHariIni');
                await chrome.storage.local.set({ totalHariIni: totalHariIni + 1 });

                sendResponse({ ok: true, result });
                break;
            }

            // Session QRIS habis / logout
            case 'SESSION_EXPIRED': {
                console.log('[QRIS BG] Session expired! Beritahu server...');

                await kirimKeServer('session-expired', {});
                await chrome.storage.local.set({ sessionStatus: 'expired' });

                sendResponse({ ok: true });
                break;
            }

            // Berhasil login, monitor aktif kembali
            case 'SUDAH_LOGIN': {
                console.log('[QRIS BG] Monitor aktif!');

                await kirimKeServer('monitor-up', {});
                await chrome.storage.local.set({
                    sessionStatus: 'active',
                    monitorStatus: 'online'
                });

                sendResponse({ ok: true });
                break;
            }

            // Content script minta tanya server: ada perintah?
            case 'CEK_PERINTAH': {
                const serverResponse = await getFromServer('pending-commands');
                // Server returns { success, message, data: { command, order_id } }
                // Content.js expects { command: 'CEK_SEKARANG' }
                const commandData = serverResponse?.data || { command: null };
                sendResponse(commandData);
                break;
            }

            // Test Ping ke server tujuan
            case 'PING_SERVER': {
                console.log('[QRIS BG] Ping server...');
                const startTime = performance.now();
                try {
                    const res = await fetch(`${API_BASE}/ping`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Monitor-Key': API_KEY
                        },
                        body: JSON.stringify({ ping: true, timestamp: new Date().toISOString() })
                    });
                    const endTime = performance.now();
                    const latency = Math.round(endTime - startTime);

                    if (res.ok) {
                        let serverData = null;
                        try { serverData = await res.json(); } catch { }
                        sendResponse({
                            ok: true,
                            status: 'reachable',
                            httpCode: res.status,
                            latency,
                            serverUrl: API_BASE,
                            serverResponse: serverData,
                            testedAt: new Date().toISOString()
                        });
                    } else {
                        sendResponse({
                            ok: false,
                            status: 'error',
                            httpCode: res.status,
                            latency,
                            serverUrl: API_BASE,
                            error: `HTTP ${res.status} ${res.statusText}`,
                            testedAt: new Date().toISOString()
                        });
                    }
                } catch (e) {
                    const endTime = performance.now();
                    const latency = Math.round(endTime - startTime);
                    sendResponse({
                        ok: false,
                        status: 'unreachable',
                        latency,
                        serverUrl: API_BASE,
                        error: e.message,
                        testedAt: new Date().toISOString()
                    });
                }
                break;
            }

            default:
                sendResponse({ ok: false, error: 'Unknown message type' });
        }
    })();

    return true; // keep channel open untuk async sendResponse
});

// ── Keepalive & Heartbeat ─────────────────────────────────────
chrome.alarms.create('keepalive', { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'keepalive') {
        await kirimKeServer('heartbeat', {});
        await retryPendingQueue();
        console.log('[QRIS BG] Heartbeat terkirim');
    }
});

// ── Inisialisasi saat Service Worker pertama aktif ─────────────
(async () => {
    // Reset harian counter jika hari sudah berganti
    const { lastDate, totalHariIni } = await chrome.storage.local.get(['lastDate', 'totalHariIni']);
    const today = new Date().toDateString();
    if (lastDate !== today) {
        await chrome.storage.local.set({ lastDate: today, totalHariIni: 0 });
    }

    // Set status awal
    await chrome.storage.local.set({ monitorStatus: 'starting' });

    console.log('[QRIS BG] Service Worker aktif');
})();
