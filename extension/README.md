# QRIS Payment Monitor — Chrome Extension

## Apa ini?

Chrome Extension (Manifest V3) untuk monitoring transaksi QRIS merchant secara otomatis di Armbian Lokal. Login QRIS dilakukan **manual satu kali**, extension mengambil alih seterusnya.

---

## Struktur File

```
extension/
├── manifest.json     ← Config extension
├── content.js        ← Scraper DOM (jalan di tab QRIS)
├── background.js     ← Relay pesan ke web server (fetch HTTP)
├── popup.html/js/css ← UI mini dashboard
└── icons/            ← Icon 16/48/128px
```

---

## Setup Sebelum Install

### 1. Edit `background.js`

Buka `background.js`, ganti dua baris ini:

```javascript
const API_BASE = 'https://situskamu.com/api/qris';  // ← URL web server kamu
const API_KEY  = 'GANTI_DENGAN_KEY_RAHASIA_KAMU';   // ← API key yang sama di PHP
```

### 2. Edit `manifest.json` (jika domain berbeda)

Pastikan `host_permissions` include domain web server kamu:
```json
"host_permissions": [
  "https://merchant.qris.interactive.co.id/*",
  "https://DOMAIN-KAMU.COM/*"
]
```

---

## Cara Install di Chromium (Armbian)

1. Buka `chrome://extensions`
2. Aktifkan **Developer mode** (toggle kanan atas)
3. Klik **Load unpacked**
4. Pilih folder `extension/` ini
5. Extension akan muncul di toolbar

---

## Cara Pakai

1. **Login manual** ke [QRIS Merchant](https://merchant.qris.interactive.co.id/v2/m/login/)
2. Extension otomatis akan redirect ke halaman riwayat transaksi
3. Monitoring berjalan — setiap transaksi baru dikirim ke web server
4. Jika session habis, extension otomatis reload halaman untuk jaga sesi
5. Klik icon extension untuk lihat status

---

## API Endpoints yang Perlu Ada di PHP Server

| Method | Path | Fungsi |
|--------|------|--------|
| POST | `/api/qris/transaksi` | Terima & matching transaksi |
| POST | `/api/qris/session-expired` | Kirim email admin |
| POST | `/api/qris/monitor-up` | Log Armbian aktif |
| POST | `/api/qris/heartbeat` | Keepalive tiap 1 menit |
| GET  | `/api/qris/pending-commands` | Kirim perintah ke extension |

Semua endpoint wajib validasi header `X-Monitor-Key`.

### Contoh validasi PHP:
```php
$key = $_SERVER['HTTP_X_MONITOR_KEY'] ?? '';
if ($key !== 'RAHASIA_KAMU') {
    http_response_code(401);
    exit(json_encode(['error' => 'Unauthorized']));
}
```

### Logika `pending-commands`
```php
// Cek apakah ada order QRIS pending yang dibuat < 30 menit
$ada = // query orders WHERE status='awaiting_payment' AND payment_method='qris'
       //   AND created_at > NOW() - INTERVAL 30 MINUTE
       //   AND command_sent = false

if ($ada) {
    // tandai sudah dikirim
    echo json_encode(['command' => 'CEK_SEKARANG']);
} else {
    echo json_encode(['command' => null]);
}
```

### Logika matching `/api/qris/transaksi`
```php
// Data dari extension
$nominal   = (int) $data['transaksi']['nominal'];     // misal: 5182
$uid_hash  = $data['transaksi']['uid_hash'];          // hash unik dari QRIS
$nama      = $data['transaksi']['nama'];
$metode    = $data['transaksi']['metode'];
$kode_ref  = $data['transaksi']['kode_ref'];

// Cari order yang cocok:
// orders.total + orders.unique_code == nominal
// misal: total=5000, unique_code=182 → 5182 ✓
$order = // SELECT * FROM orders
         //   WHERE (total + unique_code) = $nominal
         //   AND status = 'awaiting_payment'
         //   AND payment_method = 'qris'

if ($order) {
    // Update order ke paid
    // INSERT ke qris_transactions (log audit)
}
```

---

## Troubleshooting

**Transaksi tidak terdeteksi:**
- Buka Console (F12) di tab QRIS, cari log `[QRIS Monitor]`
- Periksa apakah selector `table tbody tr` masih sesuai dengan DOM halaman
- Pastikan status kolom ke-3 (td[3]) memang bernilai `Sukses`

**Extension tidak konek ke server:**
- Cek `API_BASE` dan `API_KEY` di `background.js`
- Pastikan CORS di PHP server mengizinkan origin extension
- Buka DevTools → Network → lihat request yang gagal
