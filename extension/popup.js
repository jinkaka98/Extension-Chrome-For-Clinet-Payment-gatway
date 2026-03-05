// ============================================================
// POPUP JS — QRIS Payment Monitor (Dual Broadcast Mode)
// ============================================================

const QRIS_HISTORI_URL = 'https://merchant.qris.interactive.co.id/v2/m/kontenr.php?idir=pages/historytrx.php';

const DEFAULT_SERVERS = {
    local: { url: 'http://192.168.1.12:8000/api/qris' },
    production: { url: 'https://alpakyros.com/api/qris' }
};

// ─── Format helpers ───────────────────────────────────────────
function formatRupiah(angka) {
    if (!angka) return '—';
    return 'Rp ' + parseInt(angka).toLocaleString('id-ID');
}
function formatWaktu(isoStr) {
    if (!isoStr) return '—';
    const d = new Date(isoStr);
    return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) +
        ' — ' + d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
}

// ─── Update status bar ────────────────────────────────────────
function updateUI(data) {
    const dot = document.getElementById('statusDot');
    const monitorEl = document.getElementById('monitorStatus');
    const mon = data.monitorStatus || 'offline';

    if (mon === 'online' || mon === 'starting') {
        monitorEl.textContent = '✅ Online';
        monitorEl.style.color = '#00e676';
        dot.className = 'status-dot online';
    } else {
        monitorEl.textContent = '🔴 Offline';
        monitorEl.style.color = '#ff5252';
        dot.className = 'status-dot offline';
    }

    const sessionEl = document.getElementById('sessionStatus');
    const sess = data.sessionStatus || 'unknown';
    if (sess === 'active') {
        sessionEl.textContent = '✅ Aktif';
        sessionEl.style.color = '#00e676';
    } else if (sess === 'expired') {
        sessionEl.textContent = '⚠️ Habis — perlu login';
        sessionEl.style.color = '#ffd740';
        dot.className = 'status-dot warning';
    } else {
        sessionEl.textContent = '—';
        sessionEl.style.color = '';
    }

    document.getElementById('totalHariIni').textContent = data.totalHariIni || 0;

    if (data.lastTransaksi) {
        const t = data.lastTransaksi;
        document.getElementById('lastTrxCard').style.display = 'block';
        document.getElementById('lastNominal').textContent = t.nominal_raw || formatRupiah(t.nominal);
        document.getElementById('lastNama').textContent = t.nama || '—';
        document.getElementById('lastMetode').textContent = t.metode || '—';
        document.getElementById('lastTime').textContent = t.waktu || '—';
    }

    document.getElementById('lastUpdate').textContent =
        data.lastTransaksiTime ? 'Update ' + formatWaktu(data.lastTransaksiTime) : 'Belum ada data';
}

// ─── Update panel status server ───────────────────────────────
function updateServerStatus(servers, reachability) {
    const serverList = [
        { id: 'local', label: 'Local 🏠' },
        { id: 'production', label: 'Production 🌐' }
    ];

    let activeCount = 0;

    for (const srv of serverList) {
        const dot = document.getElementById(`dot${capitalize(srv.id)}`);
        const state = document.getElementById(`state${capitalize(srv.id)}`);
        const urlEl = document.getElementById(`url${capitalize(srv.id)}`);
        const row = document.getElementById(`row${capitalize(srv.id)}`);

        const url = servers?.[srv.id]?.url || DEFAULT_SERVERS[srv.id].url;
        urlEl.textContent = url;
        urlEl.title = url;

        if (!reachability) {
            // Belum ada data deteksi
            dot.className = 'server-dot unknown';
            state.textContent = '?';
            state.style.color = '';
            row.className = 'server-row';
        } else if (reachability[srv.id]) {
            dot.className = 'server-dot online';
            state.textContent = '✅ Aktif';
            state.style.color = '#00e676';
            row.className = 'server-row active';
            activeCount++;
        } else {
            dot.className = 'server-dot offline';
            state.textContent = '🔴 Offline';
            state.style.color = '#ff5252';
            row.className = 'server-row';
        }
    }

    // Update broadcast badge
    const badge = document.getElementById('broadcastBadge');
    if (!reachability) {
        badge.textContent = 'DETEKSI...';
        badge.className = 'broadcast-badge unknown';
    } else if (activeCount === 2) {
        badge.textContent = '⚡ DUAL BROADCAST';
        badge.className = 'broadcast-badge dual';
    } else if (activeCount === 1) {
        badge.textContent = '▶ SINGLE';
        badge.className = 'broadcast-badge single';
    } else {
        badge.textContent = '✗ NO SERVER';
        badge.className = 'broadcast-badge offline';
    }
}

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

// ─── Load data dari storage ───────────────────────────────────
async function loadData() {
    const data = await chrome.storage.local.get([
        'monitorStatus', 'sessionStatus', 'totalHariIni',
        'lastTransaksi', 'lastTransaksiTime'
    ]);
    updateUI(data);
}

async function loadServerStatus() {
    try {
        const result = await chrome.runtime.sendMessage({ type: 'GET_SERVER_STATUS' });
        if (result && result.ok) {
            updateServerStatus(result.servers, result.reachability);
            // Isi input URL dari config
            const lUrl = result.servers?.local?.url || DEFAULT_SERVERS.local.url;
            const pUrl = result.servers?.production?.url || DEFAULT_SERVERS.production.url;
            document.getElementById('inputLocalUrl').value = lUrl;
            document.getElementById('inputProductionUrl').value = pUrl;
        }
    } catch {
        updateServerStatus(null, null);
    }
}

// ─── Tombol Deteksi Ulang ─────────────────────────────────────
document.getElementById('btnDetect').addEventListener('click', async () => {
    const btn = document.getElementById('btnDetect');
    btn.disabled = true;
    btn.textContent = '⏳ Mendeteksi...';
    updateServerStatus(null, null);

    try {
        const result = await chrome.runtime.sendMessage({ type: 'AUTO_DETECT' });
        if (result && result.ok) {
            await loadServerStatus();
        }
    } catch (e) {
        console.error(e);
    } finally {
        btn.disabled = false;
        btn.textContent = '🔍 Deteksi Ulang Server';
    }
});

// ─── Simpan konfigurasi URL ───────────────────────────────────
document.getElementById('btnSaveConfig').addEventListener('click', async () => {
    const btn = document.getElementById('btnSaveConfig');
    const feedback = document.getElementById('saveFeedback');

    const localUrl = document.getElementById('inputLocalUrl').value.trim();
    const productionUrl = document.getElementById('inputProductionUrl').value.trim();

    if (!localUrl || !productionUrl) {
        feedback.textContent = '⚠️ URL tidak boleh kosong';
        feedback.className = 'save-feedback error';
        return;
    }

    const config = {
        local: { id: 'local', label: 'Local 🏠', url: localUrl, enabled: true },
        production: { id: 'production', label: 'Production 🌐', url: productionUrl, enabled: true }
    };

    btn.disabled = true;
    btn.textContent = '⏳ Menyimpan...';

    try {
        const result = await chrome.runtime.sendMessage({ type: 'SAVE_SERVER_CONFIG', config });
        if (result && result.ok) {
            feedback.textContent = '✅ URL disimpan! Mendeteksi ulang...';
            feedback.className = 'save-feedback success';
            // Auto-detect setelah simpan
            await chrome.runtime.sendMessage({ type: 'AUTO_DETECT' });
            await loadServerStatus();
        } else {
            feedback.textContent = '❌ Gagal menyimpan';
            feedback.className = 'save-feedback error';
        }
    } catch (e) {
        feedback.textContent = '❌ ' + e.message;
        feedback.className = 'save-feedback error';
    } finally {
        btn.disabled = false;
        btn.textContent = '💾 Simpan URL';
        setTimeout(() => { feedback.textContent = ''; feedback.className = 'save-feedback'; }, 4000);
    }
});

// ─── Ping Semua Server ────────────────────────────────────────
document.getElementById('btnPing').addEventListener('click', async () => {
    const btn = document.getElementById('btnPing');
    const card = document.getElementById('pingResultCard');
    const body = document.getElementById('pingResultBody');

    btn.disabled = true;
    btn.textContent = '⏳ Ping semua server...';
    card.style.display = 'block';
    body.innerHTML = '<div class="ping-row">⏳ Mengirim ping ke semua server...</div>';

    try {
        const result = await chrome.runtime.sendMessage({ type: 'PING_SERVER' });

        if (result && result.ok) {
            const rows = Object.values(result.results).map(r => {
                const color = r.ok ? '#00e676' : '#ff5252';
                const status = r.ok ? '✅' : '🔴';
                const latency = r.latency !== undefined ? `${r.latency}ms` : '—';
                const http = r.httpCode ? ` (HTTP ${r.httpCode})` : '';
                const err = r.error ? `<br><span style="font-size:10px;color:#ff5252">${r.error}</span>` : '';
                return `<div class="ping-row">
                    <span style="color:${color};font-weight:700">${status} ${r.label}</span>
                    <span class="ping-latency-inline">${latency}${http}</span>
                    <div class="ping-url">${r.url}</div>${err}
                </div>`;
            }).join('');
            body.innerHTML = rows;

            // Update reachability di panel server juga
            await loadServerStatus();
        } else {
            body.innerHTML = '<div class="ping-row" style="color:#ff5252">❌ Gagal ping</div>';
        }
    } catch (e) {
        body.innerHTML = `<div class="ping-row" style="color:#ff5252">❌ ${e.message}</div>`;
    } finally {
        btn.disabled = false;
        btn.textContent = '📡 Ping Semua Server';
    }
});

// ─── Buka QRIS & Refresh ──────────────────────────────────────
document.getElementById('btnBukaQris').addEventListener('click', () => {
    chrome.tabs.create({ url: QRIS_HISTORI_URL });
    window.close();
});

document.getElementById('btnRefresh').addEventListener('click', () => {
    loadData();
    loadServerStatus();
});

// ─── Timing Config ────────────────────────────────────────────
const DEFAULT_TIMING = {
    POLL_INTERVAL_MS: 5000,
    RELOAD_NO_TRX_MIN: 14,
    RELOAD_AFTER_TRX_MS: 30000,
    MIN_RELOAD_GAP_MS: 25000
};

function updateTimingUI(cfg) {
    document.getElementById('inputPollSec').value = Math.round((cfg.POLL_INTERVAL_MS || 5000) / 1000);
    document.getElementById('inputReloadNoTrxMin').value = cfg.RELOAD_NO_TRX_MIN || 14;
    document.getElementById('inputReloadAfterTrxSec').value = Math.round((cfg.RELOAD_AFTER_TRX_MS || 30000) / 1000);
    document.getElementById('inputMinReloadGapSec').value = Math.round((cfg.MIN_RELOAD_GAP_MS || 25000) / 1000);
}

async function loadTimingConfig() {
    try {
        const { timingConfig } = await chrome.storage.local.get('timingConfig');
        updateTimingUI(timingConfig || DEFAULT_TIMING);
    } catch {
        updateTimingUI(DEFAULT_TIMING);
    }
}

document.getElementById('btnSaveTiming').addEventListener('click', async () => {
    const btn = document.getElementById('btnSaveTiming');
    const feedback = document.getElementById('timingFeedback');

    const pollSec = parseInt(document.getElementById('inputPollSec').value) || 5;
    const reloadNoTrxMin = parseInt(document.getElementById('inputReloadNoTrxMin').value) || 14;
    const reloadAfterTrx = parseInt(document.getElementById('inputReloadAfterTrxSec').value) || 30;
    const minGapSec = parseInt(document.getElementById('inputMinReloadGapSec').value) || 25;

    const timingConfig = {
        POLL_INTERVAL_MS: Math.max(2, pollSec) * 1000,
        RELOAD_NO_TRX_MIN: Math.max(1, reloadNoTrxMin),
        RELOAD_AFTER_TRX_MS: Math.max(0, reloadAfterTrx) * 1000,
        MIN_RELOAD_GAP_MS: Math.max(10, minGapSec) * 1000,
    };

    btn.disabled = true;
    btn.textContent = '⏳ Menyimpan...';

    try {
        // Simpan ke storage — content.js akan otomatis update via storage.onChanged
        await chrome.storage.local.set({ timingConfig });
        feedback.textContent = `✅ Tersimpan & langsung aktif di tab QRIS`;
        feedback.className = 'save-feedback success';
    } catch (e) {
        feedback.textContent = '❌ ' + e.message;
        feedback.className = 'save-feedback error';
    } finally {
        btn.disabled = false;
        btn.textContent = '⏱ Simpan Waktu';
        setTimeout(() => { feedback.textContent = ''; feedback.className = 'save-feedback'; }, 4000);
    }
});

// ─── Tab Navigation ─────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.view-content').forEach(c => c.classList.remove('active'));

        btn.classList.add('active');
        const targetId = btn.id === 'tabMonitor' ? 'viewMonitor' : 'viewSettings';
        document.getElementById(targetId).classList.add('active');
    });
});

// ─── Init ─────────────────────────────────────────────────────
loadData();
loadServerStatus();
loadTimingConfig();
