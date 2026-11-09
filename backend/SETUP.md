# Backend TagihanKu — Google Apps Script + Google Sheets

Backend ini adalah sumber data server untuk autentikasi email/kata sandi, profil, tagihan, transaksi simulasi, notifikasi, dan audit log.

## 1. Buat Google Spreadsheet

1. Buat spreadsheet baru di Google Drive, misalnya `TagihanKu Database`.
2. Buka spreadsheet itu.
3. Pilih **Extensions → Apps Script**.
4. Ganti isi `Code.gs` dengan file `backend/Code.gs` dari paket proyek.
5. (Opsional) buka Project Settings, aktifkan **Show `appsscript.json` manifest file**, lalu salin manifest `backend/appsscript.json`.
6. Simpan proyek.

## 2. Siapkan database

1. Pilih fungsi `setupTagihanKu` di dropdown editor Apps Script.
2. Klik **Run** dan setujui izin Google Sheets.
3. Pastikan 7 tab dibuat: `Users`, `Sessions`, `Bills`, `Transactions`, `Notifications`, `LoginAttempts`, `AuditLogs`.
4. Jalankan `testTagihanKuSetup` sekali. Hasil yang diharapkan diawali `OK:`.

Jangan ubah nama tab atau urutan kolom. Jangan membagikan spreadsheet database sebagai publik/editor. Hanya pemilik Apps Script yang seharusnya memiliki akses edit.

## 3. Deploy Web App

1. Klik **Deploy → New deployment**.
2. Pilih jenis **Web app**.
3. **Execute as:** Me.
4. **Who has access:** Anyone / Anyone, even anonymous (nama opsi tergantung UI dan kebijakan akun). Akses anonim diperlukan agar pengguna non-Google dapat mendaftar dan login di aplikasi; API menyediakan autentikasi aplikasinya sendiri. Manifest proyek juga menyetel `USER_DEPLOYING` + `ANYONE_ANONYMOUS` sebagai konfigurasi web app.
5. Klik Deploy, setujui izin, lalu salin URL yang berakhir `/exec`.
6. Jangan gunakan URL `/dev` untuk pengguna biasa; URL `/dev` hanya untuk pengujian editor.
7. Salin URL `/exec`.

Karena web app berjalan sebagai pemilik, endpoint dapat mengakses spreadsheet milik pemilik. Jangan membagikan URL deployment bersama data rahasia lain. API ini hanya membuka operasi yang didefinisikan dalam `dispatch_`, dan setiap data akun di-scope dengan user ID hasil sesi. CORS bukan autentikasi.

## 4. Uji endpoint

Ganti `DEPLOYMENT_ID` dengan ID dari URL `/exec`, lalu jalankan dari terminal: 

```bash
curl -L --data-binary '{"action":"health","payload":{},"token":""}' \
  -H 'Content-Type: text/plain;charset=UTF-8' \
  'https://script.google.com/macros/s/DEPLOYMENT_ID/exec'
```

Respons yang diharapkan berisi `\"ok\":true` dan `\"status\":\"ready\"`. Jika muncul halaman login Google atau izin ditolak, periksa kembali opsi akses deployment anonim.

## 5. Hubungkan frontend

Buka `backend-config.js` di root folder frontend, lalu tempel URL `/exec`:

```js
window.TAGIHANKU_CONFIG = {
  apiUrl: 'https://script.google.com/macros/s/PASTE_DEPLOYMENT_ID/exec'
};
```

Simpan. Jalankan lokal melalui HTTPS atau `http://localhost`, atau deploy ke hosting HTTPS seperti GitHub Pages. Jangan mengubah URL menjadi URL `/dev`.

Frontend menggunakan `fetch` POST `text/plain;charset=UTF-8` dengan `redirect: follow`. ContentService Google mengalihkan output ke domain `script.googleusercontent.com`; karena itu konfigurasi CSP mengizinkan domain Apps Script dan Googleusercontent. Saat uji pertama, periksa DevTools → Network dan Console. Jika CORS tidak lolos pada lingkungan/akun tertentu, jangan matikan CSP atau memakai JSONP untuk operasi tulis; gunakan opsi hosting UI di Apps Script HTML Service dengan `google.script.run` sebagai jalur komunikasi yang didukung Google.

## Catatan browser lokal dan pemeriksaan endpoint

Jangan membuka frontend lewat klik ganda (`file://`). Screenshot browser yang menunjukkan alamat `file:///.../index.html` berarti halaman berjalan dengan origin lokal `null`; browser dapat menolak permintaan `fetch` lintas-origin ke Apps Script. Jalankan dari folder frontend:

```bash
python3 -m http.server 8000
```

Buka `http://localhost:8000`, atau deploy frontend ke hosting HTTPS.

Sebelum frontend digunakan, jalankan `setupTagihanKu()` dan `testTagihanKuSetup()` dari editor Apps Script. Lalu periksa URL `/exec` langsung di browser atau terminal:

```bash
curl -iL 'https://script.google.com/macros/s/DEPLOYMENT_ID/exec'
```

Respons JSON yang diharapkan memuat `"status":"ready"`. Jika `not_configured`, jalankan ulang `setupTagihanKu()` pada proyek Apps Script yang sama. Jika yang muncul halaman login Google atau HTTP 401/403, periksa deployment aktif: **Execute as Me** dan **Who has access Anyone** sesuai ketersediaan akun. Pastikan URL berasal dari deployment `/exec`, bukan `/dev`.

## 6. Uji alur

1. Buka frontend, pilih **Buat akun**.
2. Buat akun menggunakan email yang valid dan kata sandi minimal 10 karakter, berisi huruf kecil, huruf besar, dan angka.
3. Pastikan data pengguna dan tiga tagihan awal masuk ke sheet yang benar.
4. Keluar lalu masuk kembali.
5. Bayar satu atau lebih tagihan menggunakan metode demo. Periksa sheet `Transactions` dan perubahan status pada `Bills`.
6. Buka dashboard dari browser lain dan masuk dengan akun yang sama untuk memastikan data berasal dari server.

## Keamanan dan batasan

- Password tidak pernah disimpan plaintext. Backend demonstrasi menggunakan PBKDF2-HMAC-SHA256 12.000 iterasi, salt per pengguna, dan pepper di Script Properties. **12.000 iterasi berada di bawah rekomendasi modern dan tidak cukup untuk menyebut autentikasi ini siap produksi.** OWASP mengutamakan Argon2id/scrypt; jika PBKDF2-HMAC-SHA256 digunakan untuk kebutuhan FIPS, OWASP menyebut 600.000 iterasi. Gunakan identity provider terkelola untuk data sensitif/produksi.
- Login dibatasi setelah 5 kegagalan selama 15 menit per email yang dinormalisasi.
- Session token acak berumur 7 hari; hanya SHA-256 hash token disimpan di Sheets. Token browser disimpan di `sessionStorage`, tidak di URL.
- Semua query data dibatasi dengan `userId` server-side.
- Email belum diverifikasi melalui email/OTP. Jangan menganggap akun terverifikasi.
- Google Sheets bukan database transaksi berkapasitas besar. Apps Script memiliki kuota, batas runtime, dan batas konkurensi. Backend ini dibuat untuk proyek akademik/prototipe kecil.
- Pembayaran tetap simulasi. Endpoint `payBills` hanya menandai tagihan demo sebagai lunas dan membuat transaksi demo; tidak ada uang yang dipindahkan.
- Notifikasi server disimpan per akun. Push notification ketika browser ditutup belum tersedia.
- Buat salinan cadangan spreadsheet secara rutin. Jangan simpan nomor kartu, PIN, OTP, kredensial bank, atau rahasia pembayaran.

## Deployment ulang

Saat memperbarui `Code.gs`, simpan perubahan lalu buka **Deploy → Manage deployments → Edit** pada deployment aktif, pilih versi baru, dan deploy. URL `/exec` tetap sama untuk deployment yang diedit. Jika membuat deployment baru, perbarui URL di `backend-config.js`.
