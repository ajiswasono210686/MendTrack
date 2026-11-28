# Panduan Setup Custom SMTP Resend & Email Transaksional MendTrack (Stage 6)

Panduan ini menyiapkan pengiriman email Auth (verifikasi akun & reset sandi) serta email transaksional otomatis MendTrack via **Resend** pada subdomain khusus `mail.brkhdenim.com` untuk project Supabase **`mendtrack_dev`** (`ncobbhceczfpxosgszwz`).

> **Penting:** Jangan mengubah project Supabase legacy `mendtrack` (`zurtrvuyigwtmyfvrelb`), dan jangan pernah menuliskan `RESEND_API_KEY` ke dalam file kode, `.env` yang ikut ter-commit, atau Git.

---

## 1. Tambah & Verifikasi Subdomain `mail.brkhdenim.com` di Resend + Hostinger DNS

Menggunakan subdomain `mail.brkhdenim.com` menjaga reputasi domain utama `brkhdenim.com` tetap terpisah dari lalu lintas email transaksional.

1. Masuk ke dashboard **Resend** -> menu **Domains** -> klik **Add Domain**.
2. Masukkan nama domain: `mail.brkhdenim.com`.
3. Pilih region terdekat (misalnya **Tokyo `ap-northeast-1`** atau **Singapore** bila tersedia) lalu simpan.
4. Resend akan menampilkan daftar DNS record yang perlu ditambahkan (ikuti persis tipe dan nilai yang tampil di layar Resend Anda; pada format Resend terbaru biasanya berupa):
   - **DKIM (`TXT`)**: Name `resend._domainkey.mail`, Content `p=MIGfMA...` (TTL Auto / 3600).
   - **Enable Sending / SPF (`CNAME`)**: dua record `CNAME` seperti `rsend.mail` dan `send.mail` menuju target `...mta.net` (TTL `3600`), atau format `TXT`/`MX` bila akun Resend menggunakan format lama.
   - **Enable receiving**: biarkan **OFF** (tidak diperlukan untuk email transaksional keluar).
5. Klik tombol **Go to Hostinger** di Resend (atau buka **Hostinger hPanel** -> **Domains** -> `brkhdenim.com` -> **DNS / Nameservers** -> **DNS records** secara manual).
6. Tambahkan seluruh record DKIM (`TXT`) dan SPF (`CNAME`) dari Resend. (Di Hostinger, cukup tulis `resend._domainkey.mail`, `rsend.mail`, dan `send.mail` tanpa mengetik ulang `.brkhdenim.com`.)
7. Tambahkan juga record **DMARC (`TXT`)** agar reputasi inbox lebih baik:
   - **Type:** `TXT`
   - **Name:** `_dmarc.mail`
   - **Content:** `v=DMARC1; p=none; adkim=r; aspf=r;`
   - **TTL:** `3600` (atau default Hostinger)
8. Kembali ke Resend -> klik **I've already added the records** / **Verify DNS Records**. Tunggu hingga status domain berubah menjadi **Verified** (biasanya 5 sampai 30 menit).

---

## 2. Buat Resend API Key

1. Di dashboard **Resend**, buka **API Keys** -> **Create API Key**.
2. Isi:
   - **Name:** `mendtrack-dev-transactional`
   - **Permission:** `Sending access`
   - **Domain:** `mail.brkhdenim.com`
3. Salin API key (`re_...`) sekali saat ditampilkan dan simpan di password manager Anda.

---

## 3. Konfigurasi Custom SMTP Resend di Supabase Auth (`mendtrack_dev`)

Langkah ini menghilangkan batas bawaan Supabase Auth (`email rate limit exceeded`, 2 email/jam).

1. Buka Supabase Dashboard untuk project **`mendtrack_dev`** (`ncobbhceczfpxosgszwz`).
2. Masuk ke **Authentication** -> **Notifications** (atau **Project Settings** -> **Authentication** -> **SMTP Settings**).
3. Aktifkan **Enable Custom SMTP** dan isi:
   - **Sender email:** `noreply@mail.brkhdenim.com`
   - **Sender name:** `MendTrack`
   - **Host:** `smtp.resend.com`
   - **Port number:** `465` (atau `587` jika memakai STARTTLS)
   - **Minimum interval per user sent:** `60` detik (default aman)
   - **Username:** `resend`
   - **Password:** tempel `RESEND_API_KEY` Anda (`re_...`)
4. Klik **Save**.

### Verifikasi Redirect URLs untuk Verifikasi & Reset Password

Pastikan **Authentication** -> **URL Configuration** di `mendtrack_dev` memuat:
- **Site URL:** `https://mendtrack.vercel.app`
- **Redirect URLs:**
  - `https://mendtrack.vercel.app/admin`
  - `https://mendtrack.vercel.app/admin/**`
  - `http://localhost:3000/admin` (opsional bila menguji lokal)

---

## 4. Pasang Template HTML Branded MendTrack di Supabase Auth

Buka **Authentication** -> **Email Templates** di `mendtrack_dev`:

1. **Confirm signup**:
   - **Subject:** `Verifikasi Email MendTrack / Verify Your MendTrack Email`
   - **Message Body (Source/HTML):** salin seluruh isi file `supabase/templates/confirm-signup.html`.
2. **Reset password**:
   - **Subject:** `Reset Kata Sandi MendTrack / Reset Your MendTrack Password`
   - **Message Body (Source/HTML):** salin seluruh isi file `supabase/templates/reset-password.html`.
3. Klik **Save** pada masing-masing template.

Kedua template memakai variabel resmi Supabase Auth (`{{ .ConfirmationURL }}` dan `{{ .SiteURL }}`), bergaya Tema A (*Craft Ledger*), dwibahasa `ID`/`EN`, kontras WCAG AA >= 4.5:1, dan bebas em dash.

---

## 5. Set Supabase Edge Function Secrets (`mendtrack_dev`)

Edge Functions `send-transactional-email` dan `public-quote` membaca konfigurasi pengirim sepenuhnya dari **Supabase Secrets**:

| Nama Secret | Nilai Contoh | Fungsi |
| :--- | :--- | :--- |
| `RESEND_API_KEY` | `re_xxxxxxxxx` | Kunci otorisasi Resend REST API |
| `RESEND_FROM_EMAIL` | `MendTrack <noreply@mail.brkhdenim.com>` | Header `From` untuk semua email transaksional |
| `APP_BASE_URL` | `https://mendtrack.vercel.app` | Base URL untuk tautan `/admin?invite=...`, `/t/<slug>?quote=...`, dan `/t/<slug>` |

### Opsi A: Via Supabase Dashboard
1. Buka **Edge Functions** -> **Secrets** di project `mendtrack_dev`.
2. Tambahkan tiga secret di atas lalu simpan.

### Opsi B: Via Supabase CLI
```bash
supabase secrets set \
  RESEND_API_KEY="re_YOUR_KEY_HERE" \
  RESEND_FROM_EMAIL="MendTrack <noreply@mail.brkhdenim.com>" \
  APP_BASE_URL="https://mendtrack.vercel.app" \
  --project-ref ncobbhceczfpxosgszwz
```

> **Perilaku Fallback:** Jika `RESEND_API_KEY` atau `RESEND_FROM_EMAIL` belum diisi, seluruh aksi operasional MendTrack (buat undangan, kirim quote, ubah status order) tetap berhasil normal. Edge Function mencatat status `skipped` pada tabel `public.email_logs` dan UI menampilkan tombol **Salin Tautan** / **Kirim via WhatsApp** seperti biasa.

---

## 6. Verifikasi Pengiriman Live

1. **Auth Confirm Signup:** Daftar akun uji di `https://mendtrack.vercel.app/admin` (atau dari tautan undangan `/admin?invite=<token>`) dan pastikan email masuk dengan pengirim `MendTrack <noreply@mail.brkhdenim.com>` dan desain Craft Ledger.
2. **Auth Reset Password:** Klik **Lupa kata sandi?** di `/admin`, masukkan email akun uji, buka tautan pemulihan di inbox, lalu simpan sandi baru minimal 8 karakter.
3. **Email Transaksional & Log:**
   - Buat undangan staff di **Tim & Peran** -> pastikan badge berubah ke **Email terkirim** dan entri `team_invite` muncul di **Riwayat Pengiriman Email**.
   - Kirim permintaan estimasi di `/t/<slug>?tab=quote` dengan email opsional -> cek email konfirmasi pelanggan (`quote_received_customer`) dan email notifikasi workshop (`quote_received_workshop`).
   - Terbitkan Quote di `/admin` -> cek email link persetujuan (`quote_published`) dan tombol **Kirim Ulang Email**.
   - Ubah status order yang memiliki email pelanggan ke **Siap Diambil / Siap Kirim** (`order_ready`) dan **Selesai / Dikirim** (`order_completed`) -> cek email beserta resi keluar (untuk mail-in) dan status di toast WhatsApp.

---

## 7. Checklist Migrasi Domain ke Domain Netral MendTrack (Stage 8, Tanpa Ubah Kode)

Saat domain resmi MendTrack (misalnya `mendtrack.com`) sudah siap di Stage 8:

1. Tambah dan verifikasi subdomain baru (misalnya `mail.mendtrack.com`) di **Resend** beserta SPF, DKIM, MX, dan DMARC.
2. Buat API Key Resend baru untuk domain tersebut (atau perluas izin API Key).
3. Perbarui **Supabase Auth -> Custom SMTP**:
   - Ubah **Sender email** ke `noreply@mail.mendtrack.com` dan perbarui password SMTP jika API Key diganti.
   - Perbarui **Site URL** dan **Redirect URLs** ke domain aplikasi baru (misalnya `https://mendtrack.com/admin`).
4. Perbarui **Supabase Edge Function Secrets** di project terkait:
   - `RESEND_API_KEY` (jika diganti)
   - `RESEND_FROM_EMAIL="MendTrack <noreply@mail.mendtrack.com>"`
   - `APP_BASE_URL="https://mendtrack.com"`
5. Selesai. Tidak ada baris kode frontend, SQL, maupun Edge Function yang perlu diubah.
