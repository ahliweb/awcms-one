🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](SECURITY.md)

<!-- i18n-source-hash: sha256:196c905a708aa5801e567e1a036aec8949b4f4c7d9570837f5912e72481ceb9f -->

# Kebijakan Keamanan

## Melaporkan kerentanan

**Jangan buka issue publik untuk kerentanan yang bisa dieksploitasi.**

Laporkan lewat [GitHub Security Advisory](https://github.com/ahliweb/awcms-one/security/advisories/new) (jalur privat). Sertakan langkah reproduksi, perkiraan dampak, dan commit yang Anda uji.

Kami menargetkan respons awal dalam **3 hari kerja** dan perbaikan untuk kerentanan yang terkonfirmasi dalam **14 hari kerja**, tergantung tingkat keparahannya.

## Dua permukaan berbeda, dilaporkan dengan cara sama tetapi dimiliki berbeda

Repo ini adalah monorepo, dan hari ini ia memuat satu permukaan serangan sungguhan beserta perkakas di sekitarnya:

- **`apps/cms`** — `ahliweb/awcms`, disematkan utuh lewat `git subtree`. Ia adalah system of record platform ini: basis data, autentikasi, otorisasi (RBAC/ABAC), dan setiap modul yang kelak akan menyimpan data komersial. Kerentanan yang ditemukan di kodenya, sebagaimana berada di repositori ini, dilaporkan di sini (GitHub Security Advisory pada `ahliweb/awcms-one`), karena di situlah kode yang terdampak sebenarnya berjalan. [`apps/cms/SECURITY.md`](apps/cms/SECURITY.md) (dibawa dari upstream) mendokumentasikan rincian permukaan itu lebih dalam. Bila cacat yang sama belum diperbaiki di `ahliweb/awcms` versi terkini, laporkan juga di sana, karena deployment lain proyek itu ikut memilikinya — salinan repo ini tetap diperbaiki di sini, mengikuti subtree pull yang dijelaskan di [`AGENTS.md`](AGENTS.md#the-subtree-embed).
- **Akar workspace** (`packages/gerbang/`, `tools/`, `tests/`) — perkakas build dan rilis, bukan layanan yang berjalan. Ia tidak punya listener jaringan, tidak punya koneksi basis data, dan tidak punya permukaan yang dihadapkan ke pengguna sama sekali; satu-satunya interaksi eksternalnya adalah memanggil `git` sebagai argv array (tidak pernah lewat shell — lihat `packages/gerbang/lib/git.mjs`). Kelas kerentanan di sini berbentuk skrip yang bisa dipaksa menulis di luar repo, atau yang akan mengeksekusi sesuatu yang dikendalikan penyerang (nama branch berbahaya, nama berkas changeset berbahaya) — laporkan dengan cara yang sama, di sini.

**`apps/storefront` belum ada** ([issue #5](https://github.com/ahliweb/awcms-one/issues/5)). Dokumen ini akan menambah bagian untuk permukaannya sendiri — membaca API publik `apps/cms`, merender ke browser pembaca — begitu ia ada.

## Yang BELUM benar, dinyatakan terus terang

**Belum ada deployment produksi platform ini yang hidup.** Increment 1 (epic saat ini, [issue #1](https://github.com/ahliweb/awcms-one/issues/1)) adalah fondasi plus satu vertical slice yang ditulis tangan, tanpa basis data hidup — memigrasi dan mengisi instans PostgreSQL sungguhan adalah increment 2. Sampai saat itu, tidak ada sistem yang berjalan di `mart.borneojek.com` untuk diekspos kode repo ini sendiri; permukaan yang ada adalah permukaan generik `apps/cms` sebagai `ahliweb/awcms`, bukan data komersial platform ini sendiri.

## Kontrol yang berlaku hari ini

- **Tidak ada rahasia, token, atau kredensial** di kode, commit, issue, atau dokumentasi.
- **`bun audit` harus melaporkan nol kerentanan** sebelum rilis (`tools/rilis.mjs` menjalankannya sebelum menerapkan).
- **GitHub Actions dipin ke SHA commit**, bukan tag — lihat bagian "Configuration and toolchain" di `AGENTS.md`.
- **PR `git subtree pull` di-merge dengan merge commit, tidak pernah di-squash atau di-rebase** — bukan kontrol keamanan terhadap penyerang eksternal, melainkan kontrol terhadap rusaknya kemampuan repo ini sendiri untuk menarik patch keamanan upstream ke `apps/cms` di masa depan. Lihat "The subtree embed" di `AGENTS.md`.

## Bukan kerentanan keamanan

Yang berikut penting, tetapi bukan laporan keamanan — gunakan issue biasa, atau jalur di [`SUPPORT.md`](SUPPORT.md):

- Cacat di `apps/cms` yang murni perilaku generik `ahliweb/awcms` sendiri, tidak berkaitan dengan pekerjaan komersial platform ini.
- Fitur yang hilang, atau celah antara skema sumber borneojek-mart dan apa yang sudah mendarat di sini sejauh ini — lihat [issue #1](https://github.com/ahliweb/awcms-one/issues/1) untuk apa yang masuk cakupan increment saat ini.
