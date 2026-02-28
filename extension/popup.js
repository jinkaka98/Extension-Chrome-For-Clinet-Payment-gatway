// ============================================================
// POPUP JS — QRIS Payment Monitor
// ============================================================

const QRIS_HISTORI_URL = 'https://merchant.qris.interactive.co.id/v2/m/kontenr.php?idir=pages/historytrx.php';

// Format rupiah dari integer
function formatRupiah(angka) {
    if (!angka) return '—';
    return 'Rp ' + parseInt(angka).toLocaleString('id-ID');
}

// Format waktu relatif
function formatWaktu(isoStr) {
    if (!isoStr) return '—';
    const d = new Date(isoStr);
    return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) +
        ' — ' + d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
}

// Update DOM berdasarkan data dari storage
function updateUI(data) {
    const dot = document.getElementById('statusDot');

    // Monitor status
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

    // Session status
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

    // Total hari ini
    document.getElementById('totalHariIni').textContent = data.totalHariIni || 0;

    // Transaksi terakhir
    if (data.lastTransaksi) {
        const t = data.lastTransaksi;
        document.getElementById('lastTrxCard').style.display = 'block';
        document.getElementById('lastNominal').textContent = t.nominal_raw || formatRupiah(t.nominal);
        document.getElementById('lastNama').textContent = t.nama || '—';
        document.getElementById('lastMetode').textContent = t.metode || '—';
        document.getElementById('lastTime').textContent = t.waktu || '—';
    }

    // Last update
    document.getElementById('lastUpdate').textContent =
        data.lastTransaksiTime ? 'Update ' + formatWaktu(data.lastTransaksiTime) : 'Belum ada data';
}

// Muat data dari storage
async function loadData() {
    const data = await chrome.storage.local.get([
        'monitorStatus',
        'sessionStatus',
        'totalHariIni',
        'lastTransaksi',
        'lastTransaksiTime'
    ]);
    updateUI(data);
}

// Tombol buka halaman QRIS
document.getElementById('btnBukaQris').addEventListener('click', () => {
    chrome.tabs.create({ url: QRIS_HISTORI_URL });
    window.close();
});

// Tombol refresh data popup
document.getElementById('btnRefresh').addEventListener('click', () => {
    loadData();
});

// ── Tombol Test Ping Server ──────────────────────────────────
document.getElementById('btnPing').addEventListener('click', async () => {
    const btn = document.getElementById('btnPing');
    const card = document.getElementById('pingResultCard');
    const statusEl = document.getElementById('pingStatus');
    const latencyEl = document.getElementById('pingLatency');
    const metaEl = document.getElementById('pingMeta');

    // Loading state
    btn.disabled = true;
    btn.textContent = '⏳ Menguji koneksi...';
    card.style.display = 'block';
    statusEl.textContent = '⏳ Mengirim ping...';
    statusEl.style.color = '';
    latencyEl.textContent = '';
    metaEl.textContent = '';

    try {
        const result = await chrome.runtime.sendMessage({ type: 'PING_SERVER' });

        if (result && result.ok) {
            statusEl.textContent = '✅ Server Terjangkau';
            statusEl.style.color = '#00e676';
            latencyEl.textContent = `⚡ ${result.latency}ms (HTTP ${result.httpCode})`;
            latencyEl.style.color = result.latency < 300 ? '#00e676' : result.latency < 1000 ? '#ffd740' : '#ff5252';
        } else if (result && result.status === 'error') {
            statusEl.textContent = `⚠️ Server Error`;
            statusEl.style.color = '#ffd740';
            latencyEl.textContent = `${result.latency}ms — ${result.error}`;
            latencyEl.style.color = '#ffd740';
        } else if (result && result.status === 'unreachable') {
            statusEl.textContent = '🔴 Server Tidak Terjangkau';
            statusEl.style.color = '#ff5252';
            latencyEl.textContent = result.error || 'Connection failed';
            latencyEl.style.color = '#ff5252';
        } else {
            statusEl.textContent = '❓ Respon tidak diketahui';
            statusEl.style.color = '#ffd740';
        }

        if (result && result.serverUrl) {
            metaEl.textContent = `${result.serverUrl} • ${formatWaktu(result.testedAt)}`;
        }
    } catch (e) {
        statusEl.textContent = '🔴 Gagal mengirim ping';
        statusEl.style.color = '#ff5252';
        latencyEl.textContent = e.message;
        latencyEl.style.color = '#ff5252';
        metaEl.textContent = '';
    } finally {
        btn.disabled = false;
        btn.textContent = '📡 Test Ping Server';
    }
});

// Load saat popup dibuka
loadData();
