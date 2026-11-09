# TagihanKu — Frontend, PWA, dan Backend Google Apps Script

TagihanKu adalah dashboard pengelolaan tagihan bulanan menggunakan HTML5 semantik, CSS3, dan JavaScript murni. Frontend mencakup sidebar responsif, ringkasan tagihan, kalender, analitik, notifikasi, riwayat, invoice, tema, dan PWA. Backend menggunakan Google Apps Script + Google Sheets untuk akun, profil, tagihan, transaksi simulasi, dan notifikasi.

> **Batas penggunaan:** pembayaran tetap simulasi. Tidak ada koneksi ke bank, QRIS, e-wallet, PLN, PDAM, atau payment gateway. Email belum diverifikasi melalui OTP. Google Sheets + Apps Script ditujukan untuk prototipe akademik skala kecil, bukan sistem keuangan produksi.

## Yang tersedia

- Sidebar desktop dan drawer responsif untuk tablet/ponsel.
- Dashboard, kartu Internet/Listrik/PDAM, filter status, dan pemilihan beberapa tagihan.
- Kalender, countdown, pengingat, pusat notifikasi, dan Smart Assistant berbasis aturan lokal.
- Riwayat transaksi, invoice simulasi, ekspor CSV, dan cetak laporan PDF.
- Grafik analitik, perbandingan bulanan, ringkasan kategori, dan insight.
- Tema terang/gelap/sistem, profil, dan preferensi tampilan.
- PWA: manifest, ikon, service worker, app-shell cache, dan offline fallback.
- Registrasi dan login server, sesi, profil, sinkronisasi tagihan, transaksi simulasi, serta notifikasi melalui Apps Script.

## Konfigurasi backend saat ini

`backend-config.js` sudah berisi URL Web App berdasarkan deployment ID yang diberikan untuk proyek ini. URL endpoint Web App bukan password atau API secret; frontend publik harus mengetahui alamat API. Jangan pernah menaruh Spreadsheet ID, pepper, kata sandi, token sesi, atau rahasia lain di file frontend.

Konfigurasi yang digunakan:

```js
window.TAGIHANKU_CONFIG = Object.freeze({
  apiUrl: 'https://script.google.com/macros/s/AKfycbzj29oXacNqT-cnQnThFfF9uij_A5LpLWxMTK_7qDw9iBySyM9HpDQy4-hCL4KitrAR/exec'
});
```

Jika endpoint perlu diganti, gunakan URL Web App yang berakhiran `/exec`. `backend-client.js` juga menerima deployment ID `AK...` tanpa domain dan akan membentuk URL secara otomatis.

## Backend Google Apps Script + Google Sheets

### Komponen

- `backend/Code.gs` — API, validasi server, autentikasi, sesi, dan operasi Sheet.
- `backend/appsscript.json` — runtime V8, timezone, scope spreadsheet, dan pengaturan web app.
- `backend/SETUP.md` — petunjuk pembuatan spreadsheet dan deployment.
- `backend-config.js` — URL Web App publik.
- `backend-client.js` — adapter browser ke Apps Script.

### Sheet yang dibuat oleh `setupTagihanKu()`

| Tab | Kegunaan |
|---|---|
| `Users` | user ID, email, nama, hash password, salt, status, preferensi |
| `Sessions` | hash token sesi, waktu dibuat/kedaluwarsa/dicabut |
| `Bills` | tagihan per pengguna, nominal, jatuh tempo, status |
| `Transactions` | transaksi simulasi dan rincian layanan |
| `Notifications` | notifikasi per pengguna dan status baca |
| `LoginAttempts` | jumlah gagal login dan lockout |
| `AuditLogs` | catatan registrasi, login, profil, dan pembayaran demo |

Semua operasi data server dibatasi menggunakan `userId` yang diperoleh dari token sesi. Frontend tidak mengirim `userId` sebagai sumber otorisasi.

### Kontrak API

Request dikirim sebagai `POST` JSON dengan header `Content-Type: text/plain;charset=UTF-8`, tanpa cookie atau custom Authorization header. Adapter mengikuti redirect ContentService. Action utama: `health`, `register`, `login`, `logout`, `getDashboard`, `saveProfile`, `savePreferences`, `payBills`, dan pengelolaan notifikasi.

Google menjelaskan bahwa Web App memproses POST melalui `doPost(e)` dan ContentService mengalihkan output ke URL sementara `script.googleusercontent.com`; karena itu klien perlu mengikuti redirect. Lihat [Apps Script Web Apps](https://developers.google.com/apps-script/guides/web) dan [Content Service](https://developers.google.com/apps-script/guides/content).

## Setup atau perbaikan deployment

Jika backend belum siap atau pemeriksaan health gagal:

1. Buka Google Sheet database milikmu.
2. Pilih **Extensions → Apps Script**.
3. Pastikan `Code.gs` sama dengan `backend/Code.gs` dalam paket.
4. Jalankan `setupTagihanKu()` satu kali dan setujui akses spreadsheet.
5. Jalankan `testTagihanKuSetup()`; hasilnya harus diawali `OK:` dan mencantumkan tujuh tab.
6. Pilih **Deploy → Manage deployments → Edit**, pilih versi terbaru, lalu deploy. Pastikan Web App berjalan sebagai pemilik dan aksesnya sesuai kebutuhan aplikasi publik. Opsi akses anonim dapat dibatasi oleh kebijakan Google Workspace.
7. Buka URL `/exec` di browser; endpoint GET health harus menampilkan JSON dengan `status: ready`.
8. Jika membuat deployment baru (bukan mengedit deployment aktif), perbarui `backend-config.js` dengan URL baru.

Detail lengkap ada di [`backend/SETUP.md`](backend/SETUP.md).

### Pemeriksaan koneksi dari terminal

Jalankan dari Debian/Linux:

```bash
curl -L --data-binary '{"action":"health","payload":{},"token":""}' \
  -H 'Content-Type: text/plain;charset=UTF-8' \
  'https://script.google.com/macros/s/AKfycbzj29oXacNqT-cnQnThFfF9uij_A5LpLWxMTK_7qDw9iBySyM9HpDQy4-hCL4KitrAR/exec'
```

Respons yang diharapkan memiliki `"ok":true` dan `"status":"ready"`. Jika muncul halaman izin/login Google, deployment belum dapat diakses oleh pengguna aplikasi. Jika `curl` berhasil tetapi browser menampilkan pesan koneksi, periksa DevTools → Console dan Network untuk CORS/redirect.

## Autentikasi dan batas keamanan

- Password tidak disimpan plaintext. Implementasi backend demonstrasi memakai PBKDF2-HMAC-SHA256 12.000 iterasi, salt per pengguna, dan pepper di Script Properties. **12.000 iterasi berada di bawah rekomendasi modern dan tidak cukup untuk menyebut autentikasi ini siap produksi.** OWASP mengutamakan Argon2id/scrypt; PBKDF2-HMAC-SHA256 600.000 iterasi disebut untuk kebutuhan FIPS. Untuk data sensitif/produksi, gunakan identity provider terkelola atau backend dengan password hashing modern.
- Token sesi acak berlaku 7 hari. Hanya hash token disimpan di Sheet; token browser memakai `sessionStorage`, bukan URL atau `localStorage`.
- Login dikunci sementara setelah 5 kegagalan untuk email yang sama.
- Data tagihan, transaksi, dan notifikasi dibatasi berdasarkan user ID server.
- Email belum diverifikasi dengan OTP/email link; email yang didaftarkan tidak otomatis terbukti dimiliki pendaftar.
- Web App berjalan sebagai pemilik, sehingga endpoint publik memiliki akses ke spreadsheet melalui kode. Jangan membagikan Sheet database sebagai publik/editor. CORS bukan autentikasi. Pertimbangkan menutup pendaftaran publik setelah akun yang diperlukan dibuat dengan fungsi admin `closePublicRegistration()`.
- Apps Script/Sheets memiliki batas runtime, kuota, dan konkurensi. Backend ini hanya untuk proyek akademik/prototipe kecil.
- Pembayaran hanya mengubah status tagihan simulasi; tidak ada uang yang dipotong atau dipindahkan.

## Mode akun dan pratinjau

- Dengan URL backend valid, tombol **Buat akun** dan **Masuk** memanggil Google Apps Script. Registrasi membuat akun, tiga tagihan awal, dan sesi server.
- Setelah masuk, tagihan, transaksi, profil, preferensi yang didukung, dan notifikasi akun dimuat dari server. Data transaksi akun tidak disimpan ke `localStorage` sebagai transaksi palsu.
- Jika backend belum dapat dihubungi, aplikasi menampilkan status layanan dan tidak menganggap login pratinjau sebagai akun server.
- Jika endpoint dikosongkan untuk pengembangan UI lokal, aplikasi tetap menampilkan data pratinjau; operasi akun online tidak tersedia.
- Data pratinjau lama tidak otomatis diunggah ke akun server agar transaksi contoh tidak tercampur dengan data akun.

## Menjalankan frontend

Dari folder yang berisi `index.html`:

```bash
python3 -m http.server 8000
```

Buka `http://localhost:8000`. Jangan membuka `index.html` melalui `file://` untuk menguji PWA atau API. Untuk publikasi, deploy seluruh folder ke hosting HTTPS dan pertahankan struktur file.

## Publikasi ke GitHub Pages

Repository ini menggunakan `index.html` di root. Workflow `.github/workflows/pages.yml` akan menjalankan pemeriksaan struktur lalu menerbitkan seluruh website ke GitHub Pages setiap ada push ke branch `main`.

1. Buat repository baru bernama `tagihanku` dengan visibilitas **Public**. Jangan pilih template atau menambahkan file lain bila repository akan diisi melalui folder proyek ini.
2. Dari folder proyek lokal, jalankan:

```bash
git init -b main
git add .
git commit -m "Publish TagihanKu website"
git remote add origin https://github.com/andisec/tagihanku.git
git push -u origin main
```

Jika folder sudah berupa repository Git, jangan jalankan `git init` lagi; cukup periksa `git status`, tambahkan perubahan, commit, lalu push ke remote yang benar.

3. Di GitHub buka **Settings → Pages** dan pilih **GitHub Actions** pada bagian Build and deployment.
4. Buka tab **Actions** dan tunggu workflow `Deploy TagihanKu to GitHub Pages` selesai dengan status hijau.
5. URL project site akan berbentuk `https://andisec.github.io/tagihanku/`.

GitHub Pages hanya meng-host frontend statis. Backend tetap berjalan pada Google Apps Script dan database tetap berada di Google Sheets. Jangan mengunggah spreadsheet database ke repository.

## Validasi proyek

```bash
./validate.sh
```

Skrip memeriksa sintaks JavaScript utama, backend-client, backend-config, service worker, Apps Script, JSON manifest, struktur HTML, ID ganda, aset lokal, selector ID JavaScript, dan CSS parsing.

Setelah backend deploy, lakukan uji browser manual:

1. Klik profil → **Buat akun**.
2. Daftar memakai email dan kata sandi minimal 10 karakter, dengan huruf kecil, huruf besar, dan angka.
3. Pastikan satu pengguna dan tiga tagihan awal tersimpan di Sheet.
4. Keluar lalu masuk kembali.
5. Bayar satu atau lebih tagihan simulasi; periksa tab `Bills`, `Transactions`, dan `AuditLogs`.
6. Masuk dari browser lain dengan akun yang sama; data harus berasal dari server.
7. Pastikan akun berbeda tidak dapat melihat data satu sama lain.
8. Uji PWA secara terpisah lewat HTTPS/localhost. Operasi akun membutuhkan internet.

## Struktur proyek

```text
tagihanku-web/
├── .github/
│   └── workflows/
│       └── pages.yml
├── .nojekyll
├── .gitignore
├── SECURITY.md
├── index.html
├── styles.css
├── script.js
├── favicon.svg
├── icons/
│   ├── icon-180.png
│   ├── icon-192.png
│   └── icon-512.png
├── backend-config.js
├── backend-client.js
├── service-worker.js
├── manifest.webmanifest
├── offline.html
├── validate.sh
├── backend/
│   ├── Code.gs
│   ├── appsscript.json
│   └── SETUP.md
└── README.md
```
