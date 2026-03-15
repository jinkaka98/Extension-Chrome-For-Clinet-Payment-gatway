// ============================================================
// POPUP JS — QRIS Payment Monitor (Dual Broadcast Mode)
// ============================================================

const QRIS_HISTORI_URL = 'https://merchant.qris.interactive.co.id/v2/m/kontenr.php?idir=pages/historytrx.php';

const DEFAULT_SERVERS = {
    local: { url: 'http://localhost:8000/api/qris' },
    production: { url: 'https://alpakyros.com/api/qris' }
};

const DEFAULT_TIMING = {
    POLL_INTERVAL_MS: 5000,
    RELOAD_NO_TRX_MIN: 14,
    RELOAD_AFTER_TRX_MS: 30000,
    MIN_RELOAD_GAP_MS: 25000
};

// ─── Tab Navigation ──────────────────────────────────────────
const TAB_MAP = {
    tabMonitor: 'viewMonitor',
    tabSettings: 'viewSettings',
    tabSessionLog: 'viewSessionLog'
};

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.view-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        const viewId = TAB_MAP[btn.id];
        if (viewId) document.getElementById(viewId).classList.add('active');
        // Auto-load session log saat tab dibuka
        if (btn.id === 'tabSessionLog') loadSessionLog();
    });
});

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
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ─── Update status bar ────────────────────────────────────────
function updateUI(data) {
    const dot = document.getElementById('statusDot');
    const monEl = document.getElementById('monitorStatus');
    const mon = data.monitorStatus || 'offline';

    if (mon === 'online' || mon === 'starting') {
        monEl.textContent = '✅ Online';
        monEl.style.color = '#00e676';
        dot.className = 'status-dot online';
    } else {
        monEl.textContent = '🔴 Offline';
        monEl.style.color = '#ff5252';
        dot.className = 'status-dot offline';
    }

    const sessEl = document.getElementById('sessionStatus');
    const sess = data.sessionStatus || 'unknown';
    if (sess === 'active') {
        sessEl.textContent = '✅ Aktif';
        sessEl.style.color = '#00e676';
    } else if (sess === 'expired') {
        sessEl.textContent = '⚠️ Habis';
        sessEl.style.color = '#ffd740';
        dot.className = 'status-dot warning';
    } else {
        sessEl.textContent = '—';
        sessEl.style.color = '';
    }

    document.getElementById('totalHariIni').textContent = data.totalHariIni || 0;

    // Last transaksi
    const card = document.getElementById('lastTrxCard');
    if (data.lastTransaksi) {
        const t = data.lastTransaksi;
        card.style.opacity = '1';
        document.getElementById('lastNominal').textContent = t.nominal_raw || formatRupiah(t.nominal);
        document.getElementById('lastNama').textContent = t.nama || '—';
        document.getElementById('lastMetode').textContent = t.metode || '—';
        document.getElementById('lastTime').textContent = t.waktu || '—';
    } else {
        // Tetap tampil card tapi kosong (biar grid tetap simetris)
        card.style.opacity = '0.4';
        document.getElementById('lastNominal').textContent = '—';
        document.getElementById('lastNama').textContent = '—';
        document.getElementById('lastMetode').textContent = '—';
        document.getElementById('lastTime').textContent = 'Belum ada transaksi';
    }

    document.getElementById('lastUpdate').textContent =
        data.lastTransaksiTime ? 'Update ' + formatWaktu(data.lastTransaksiTime) : 'Belum ada data';
}

// ─── Update panel status server ───────────────────────────────
function updateServerStatus(servers, reachability) {
    const list = [
        { id: 'local', label: 'Local 🏠' },
        { id: 'production', label: 'Production 🌐' },
        { id: 'supabase', label: 'Supabase ☁️' }
    ];

    let activeCount = 0;

    for (const srv of list) {
        const dot = document.getElementById(`dot${capitalize(srv.id)}`);
        const state = document.getElementById(`state${capitalize(srv.id)}`);
        const urlEl = document.getElementById(`url${capitalize(srv.id)}`);
        const row = document.getElementById(`row${capitalize(srv.id)}`);

        const defaultUrl = srv.id === 'supabase' ? 'Direct Database' : DEFAULT_SERVERS[srv.id].url;
        const url = servers?.[srv.id]?.url || defaultUrl;
        if (urlEl) {
            urlEl.textContent = url;
            urlEl.title = url;
        }

        if (!reachability) {
            dot.className = 'server-dot unknown';
            state.textContent = '?';
            state.style.color = '';
            row.className = 'server-row';
        } else if (reachability[srv.id]) {
            dot.className = 'server-dot online';
            state.textContent = '✅ Aktif';
            state.style.color = '#00e676';
            row.className = 'server-row active';
            if (srv.id !== 'supabase') activeCount++;
        } else {
            dot.className = 'server-dot offline';
            state.textContent = '🔴 Offline';
            state.style.color = '#ff5252';
            row.className = 'server-row';
        }
    }

    // Update broadcast badge di header
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
            document.getElementById('inputLocalUrl').value = result.servers?.local?.url || DEFAULT_SERVERS.local.url;
            document.getElementById('inputProductionUrl').value = result.servers?.production?.url || DEFAULT_SERVERS.production.url;
        }
    } catch {
        updateServerStatus(null, null);
    }
}

// ─── Load timing config dari storage ─────────────────────────
async function loadTimingConfig() {
    try {
        const { timingConfig } = await chrome.storage.local.get('timingConfig');
        const c = timingConfig || DEFAULT_TIMING;
        document.getElementById('inputPollSec').value = Math.round((c.POLL_INTERVAL_MS || 5000) / 1000);
        document.getElementById('inputReloadNoTrxMin').value = c.RELOAD_NO_TRX_MIN || 14;
        document.getElementById('inputReloadAfterTrxSec').value = Math.round((c.RELOAD_AFTER_TRX_MS || 30000) / 1000);
        document.getElementById('inputMinReloadGapSec').value = Math.round((c.MIN_RELOAD_GAP_MS || 25000) / 1000);
    } catch {
        // Pakai default visual
    }
}

// ─── Tombol: Deteksi Ulang Server ────────────────────────────
document.getElementById('btnDetect').addEventListener('click', async () => {
    const btn = document.getElementById('btnDetect');
    const scanCard = document.getElementById('scanResultCard');
    const scanBody = document.getElementById('scanResultBody');

    btn.disabled = true;
    btn.textContent = '🌐 Scanning jaringan...';
    updateServerStatus(null, null);

    // Show scan card with loading state
    scanCard.style.display = 'block';
    scanBody.innerHTML = '<div style="color:#ffd740">⏳ Mendeteksi network interfaces & scanning subnet...</div>';

    try {
        const result = await chrome.runtime.sendMessage({ type: 'AUTO_DETECT' });
        if (result && result.ok) {
            // Update server status panel
            if (result.servers) {
                updateServerStatus(result.servers, result.reachability);
                document.getElementById('inputLocalUrl').value = result.servers?.local?.url || DEFAULT_SERVERS.local.url;
                document.getElementById('inputProductionUrl').value = result.servers?.production?.url || DEFAULT_SERVERS.production.url;
            } else {
                await loadServerStatus();
            }

            // Build scan result display
            let html = '';
            const localOk = result.reachability?.local;
            const prodOk = result.reachability?.production;

            if (result.autoDiscovered) {
                html += `<div style="color:#00e676;font-weight:700">🎯 Server ditemukan!</div>`;
                html += `<div style="color:#90caf9;margin:2px 0">📍 ${result.autoDiscovered}</div>`;
                html += `<div style="color:#aaa">Config local auto-updated ✅</div>`;
                btn.textContent = '✅ Ditemukan!';
            } else if (localOk) {
                html += `<div style="color:#00e676">✅ Local server aktif di URL tersimpan</div>`;
            } else {
                html += `<div style="color:#ff5252">❌ Server lokal tidak ditemukan di jaringan</div>`;
                html += `<div style="color:#aaa;font-size:10px;margin-top:2px">Pastikan backend (php run dev) sedang berjalan</div>`;
            }

            html += `<div style="margin-top:4px;border-top:1px solid #333;padding-top:4px;">`;
            html += `<span style="color:${prodOk ? '#00e676' : '#ff5252'}">${prodOk ? '✅' : '🔴'} Production</span>`;
            html += `</div>`;

            scanBody.innerHTML = html;
        }
    } catch (e) {
        scanBody.innerHTML = `<div style="color:#ff5252">❌ Error: ${e.message}</div>`;
        console.error(e);
    }
    finally {
        setTimeout(() => {
            btn.disabled = false;
            btn.textContent = '🔍 Deteksi Server';
        }, 2000);
    }
});

// ─── Tombol: Ping Semua ────────────────────────────────────────
document.getElementById('btnPing').addEventListener('click', async () => {
    const btn = document.getElementById('btnPing');
    const card = document.getElementById('pingResultCard');
    const body = document.getElementById('pingResultBody');

    btn.disabled = true;
    btn.textContent = '⏳ Ping...';
    card.style.display = 'block';
    body.innerHTML = '<div class="ping-row">⏳ Mengirim ping...</div>';

    try {
        const result = await chrome.runtime.sendMessage({ type: 'PING_SERVER' });
        if (result && result.ok) {
            const rows = Object.values(result.results).map(r => {
                const color = r.ok ? '#00e676' : '#ff5252';
                const status = r.ok ? '✅' : '🔴';
                const latency = r.latency !== undefined ? `${r.latency}ms` : '—';
                const http = r.httpCode ? ` (HTTP ${r.httpCode})` : '';
                const err = r.error ? `<br><span style="font-size:9px;color:#ff5252">${r.error}</span>` : '';
                return `<div class="ping-row">
                    <span style="color:${color};font-weight:700">${status} ${r.label}</span>
                    <span class="ping-latency-inline">${latency}${http}</span>
                    <div class="ping-url">${r.url}</div>${err}
                </div>`;
            }).join('');
            body.innerHTML = rows;
            await loadServerStatus();
        } else {
            body.innerHTML = '<div class="ping-row" style="color:#ff5252">❌ Gagal ping</div>';
        }
    } catch (e) {
        body.innerHTML = `<div class="ping-row" style="color:#ff5252">❌ ${e.message}</div>`;
    } finally {
        btn.disabled = false;
        btn.textContent = '📡 Ping Semua';
    }
});

// ─── Tombol: Buka QRIS & Refresh ─────────────────────────────
document.getElementById('btnBukaQris').addEventListener('click', () => {
    chrome.tabs.create({ url: QRIS_HISTORI_URL });
    window.close();
});

document.getElementById('btnRefresh').addEventListener('click', () => {
    loadData();
    loadServerStatus();
});

// ─── Tombol: Simpan URL ───────────────────────────────────────
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
        // SAVE_SERVER_CONFIG di background sekarang langsung verifikasi + re-detect
        const result = await chrome.runtime.sendMessage({ type: 'SAVE_SERVER_CONFIG', config });
        if (result && result.ok) {
            feedback.textContent = '✅ Tersimpan & terdeteksi!';
            feedback.className = 'save-feedback success';

            // Update tampilan server status dari hasil re-detect
            if (result.reachability) {
                updateServerStatus(config, result.reachability);
            }
            // Juga reload full status
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

// ─── Tombol: Simpan Timing ────────────────────────────────────
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
        await chrome.storage.local.set({ timingConfig });
        feedback.textContent = '✅ Tersimpan & langsung aktif';
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

// ─── Session Log: Format Helpers ───────────────────────────────
function formatDurationPopup(ms) {
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

function getDurationClass(ms) {
    if (!ms) return '';
    const menit = ms / 60000;
    if (menit < 15) return 'dur-short';       // < 15 mnt = hijau (pendek)
    if (menit < 60) return 'dur-medium';      // 15-60 mnt = kuning
    return 'dur-long';                        // > 60 mnt = cyan (lama)
}

function formatLogTime(isoStr) {
    if (!isoStr) return '—';
    const d = new Date(isoStr);
    return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
        '\n' + d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: '2-digit' });
}

function getStatusBadge(status) {
    switch (status) {
        case 'active': return '<span class="badge badge-active">AKTIF</span>';
        case 'expired': return '<span class="badge badge-expired">EXPIRED</span>';
        case 'expired_unknown': return '<span class="badge badge-unknown">???</span>';
        default: return '<span class="badge">' + status + '</span>';
    }
}

// ─── Session Log: Load & Render ─────────────────────────────────
let activeSessionTimer = null;

async function loadSessionLog() {
    try {
        const result = await chrome.runtime.sendMessage({ type: 'GET_SESSION_LOG' });
        if (!result || !result.ok) return;

        const log = result.sessionLog || [];
        const currentStart = result.currentSessionStart;
        const tbody = document.getElementById('sessionLogBody');

        // === Active Session Indicator ===
        const activeCard = document.getElementById('activeSessionCard');
        if (activeSessionTimer) { clearInterval(activeSessionTimer); activeSessionTimer = null; }

        if (currentStart) {
            activeCard.style.display = 'block';
            const startDate = new Date(currentStart);
            document.getElementById('activeSessionSince').textContent =
                startDate.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

            const updateElapsed = () => {
                const elapsed = Date.now() - startDate.getTime();
                document.getElementById('activeSessionElapsed').textContent = formatDurationPopup(elapsed);
            };
            updateElapsed();
            activeSessionTimer = setInterval(updateElapsed, 1000);
        } else {
            activeCard.style.display = 'none';
        }

        // === Tabel History ===
        if (log.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="session-log-empty">Belum ada data session</td></tr>';
        } else {
            // Terbaru di atas
            const sorted = [...log].reverse();
            tbody.innerHTML = sorted.map(entry => {
                const durClass = getDurationClass(entry.durationMs);
                const durText = entry.durationText || formatDurationPopup(entry.durationMs);
                return `<tr>
                    <td style="white-space:pre-line">${formatLogTime(entry.loginAt)}</td>
                    <td style="white-space:pre-line">${formatLogTime(entry.logoutAt)}</td>
                    <td class="${durClass}">${durText}</td>
                    <td>${getStatusBadge(entry.status)}</td>
                </tr>`;
            }).join('');
        }

        // === Summary Stats ===
        const completed = log.filter(e => e.durationMs && e.durationMs > 0);
        document.getElementById('totalSessions').textContent = log.length;

        if (completed.length > 0) {
            const durations = completed.map(e => e.durationMs);
            const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
            const min = Math.min(...durations);
            const max = Math.max(...durations);

            document.getElementById('avgDuration').textContent = formatDurationPopup(avg);
            document.getElementById('minDuration').textContent = formatDurationPopup(min);
            document.getElementById('maxDuration').textContent = formatDurationPopup(max);
        } else {
            document.getElementById('avgDuration').textContent = '—';
            document.getElementById('minDuration').textContent = '—';
            document.getElementById('maxDuration').textContent = '—';
        }

    } catch (e) {
        console.error('[Popup] loadSessionLog error:', e);
    }
}

// ─── Tombol: Hapus Log ────────────────────────────────────────
document.getElementById('btnClearLog').addEventListener('click', async () => {
    if (!confirm('Hapus semua log session? Data tidak bisa dikembalikan.')) return;

    const btn = document.getElementById('btnClearLog');
    btn.disabled = true;
    btn.textContent = '⏳ Menghapus...';

    try {
        await chrome.runtime.sendMessage({ type: 'CLEAR_SESSION_LOG' });
        await loadSessionLog();
    } catch (e) {
        console.error(e);
    } finally {
        btn.disabled = false;
        btn.textContent = '🗑 Hapus Semua Log';
    }
});

// ─── Init ─────────────────────────────────────────────────────
loadData();
loadServerStatus();
loadTimingConfig();
loadSessionLog();
