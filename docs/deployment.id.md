🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](deployment.md)

<!-- i18n-source-hash: sha256:9355da449bfb8fef81668e8e60bc669ed018cd792ac2270d916b0247c2e4fabf -->

# Deployment

Bagaimana `apps/storefront` di-build dan dilayani, variabel environment-nya, dan — terus terang, karena itu mengubah apa arti "men-deploy repositori ini" hari ini — bahwa `apps/cms` belum bisa di-deploy terhadap basis data nyata di infrastruktur borneojek sendiri.

## Build, lalu serve — dua langkah terpisah, dua level kepercayaan terpisah

```bash
bun run build          # bun run check && astro build && build:penyaji
bun run serve          # bun dist/server/penyaji.mjs
```

`bun run build` (`apps/storefront/package.json`) menjalankan `bun run check` (type-check), lalu `astro build` (mengambil katalog dari `apps/cms` memakai `AWCMS_API_TOKEN`, memanggang setiap halaman ke `dist/client/`), lalu `build:penyaji` (mem-bundle `apps/storefront/server/penyaji.mjs` sendiri ke `dist/server/penyaji.mjs` lewat `bun build --target=bun`). **Hanya langkah build yang pernah membaca variabel `AWCMS_*`.** `bun run serve` menjalankan `dist/server/penyaji.mjs` yang sudah di-build, yang membaca persis dua variabel environment — `PORT` dan `HOST` — dan tidak satu pun milik `apps/cms`. Ini bukti mekanis dari klaim [ADR-0002](adr/0002-static-output-with-build-time-fetch-for-the-storefront.md) bahwa container yang berjalan tidak pernah berbicara ke `apps/cms`: bukan sekadar bahwa ia tidak melakukannya hari ini, tapi bahwa sumber proses yang dilayani sama sekali tidak punya jalur kode yang membaca kredensial atau URL yang bisa menjangkaunya.

## Variabel environment

Dua berkas `.env.example` terpisah, satu per workspace, sengaja tidak digabung — berkas `apps/storefront` sendiri hanya mendokumentasikan apa yang dibacanya; ia tidak menduplikasi milik `apps/cms`.

### `apps/storefront/.env.example`

| Variabel | Dibaca | Tujuan |
| --- | --- | --- |
| `SITE_URL` | Saat build (juga `astro.config.mjs` langsung, sebelum `apps/storefront/src/config/site.ts` berjalan) | Origin absolut kanonik — tautan kanonik, URL Open Graph, dan JSON-LD `Product` semuanya dibangun darinya |
| `SITE_NAME`, `SITE_DESCRIPTION` | Saat build | Opsional; default yang masuk akal sehingga `bun run dev` bekerja tanpa `.env` sama sekali |
| `AWCMS_API_URL` | Hanya saat build | Origin instans `apps/cms` untuk mengambil katalog |
| `AWCMS_API_TOKEN` | Hanya saat build | Kredensial Bearer **read-only**, dibatasi ke modul commerce (produk, kategori) — tidak pernah dipancarkan ke output build; tidak diprefiks `PUBLIC_`, dengan sengaja, karena Vite hanya meng-inline variabel berprefiks `PUBLIC_` ke kode yang terjangkau klien |
| `AWCMS_API_TIMEOUT_MS` | Hanya saat build, opsional | Berapa lama satu request ke `apps/cms` boleh berlangsung sebelum build menyerah (default 30000 ms) — nilai yang bukan angka positif ditolak langsung, termasuk `0`, yang jika tidak berarti "tanpa batas" dan mengembalikan persis hang yang ingin dicegah deadline ini |
| `PORT`, `HOST` | Runtime, hanya oleh `apps/storefront/server/penyaji.mjs` | Default `8080`/`0.0.0.0` — `0.0.0.0` karena proses ini biasanya berjalan di dalam container di belakang reverse proxy, di mana listener khusus-`localhost` tidak terjangkau dari luar container dan muncul sebagai health check yang gagal tanpa alasan yang dinyatakan |

### `apps/cms/.env.example`

Berkas yang jauh lebih besar, dimiliki sepenuhnya oleh `apps/cms` sebagai kode `ahliweb/awcms` yang di-embed — root repositori ini tidak menduplikasinya ("Configuration and toolchain" milik `AGENTS.md`: "setiap variabel env yang dibaca skrip level-root harus ada di `.env.example`... `apps/cms` menjaga `.env.example`-nya sendiri untuk konfigurasi runtime-nya sendiri; berkas root repo ini tidak menduplikasinya"). Variabel yang penting untuk memahami apa yang dibutuhkan `apps/cms` yang berjalan: `DATABASE_URL` (role aplikasi `awcms_app` — tidak pernah role pemilik basis data, yang adalah superuser Postgres yang melewati `FORCE ROW LEVEL SECURITY` sama sekali, mengalahkan persis isolasi yang didokumentasikan [`docs/skema-basis-data.md`](skema-basis-data.md)), `APP_ENV`/`APP_URL`, dan variabel HTTP listener (`PORT`, `HOST`, dan jalur sertifikat TLS in-process opsional) yang dibaca entrypoint standalone-nya sendiri.

## Apa yang boleh dan tidak boleh dijangkau container storefront

| | Boleh menjangkau |
| --- | --- |
| Proses build (`astro build`) | API publik `apps/cms`, lewat HTTPS, dengan token build read-only |
| Container yang berjalan (`bun dist/server/penyaji.mjs`) | Tidak ada apa pun di luar dirinya sendiri — tidak ada `apps/cms`, tidak ada basis data, tidak ada panggilan jaringan eksternal jenis apa pun |

CSP milik `apps/storefront/server/penyaji.mjs` sendiri (`connect-src 'self'`, di antara setiap direktif lain yang diset `'self'` atau `'none'`) tambahan memblokir *browser* agar tidak bisa dibuat memanggil apa pun di luar origin yang sama ini — tidak ada origin eksternal terkonfigurasi untuk dilebarkan, karena aplikasi ini tidak punya host gambar-produk atau skrip pihak-ketiga untuk diizinkan.

## Penyediaan PostgreSQL untuk increment 2 belum dilakukan

`apps/cms` hanya-PostgreSQL. **Server produksi borneojek menjalankan MySQL** — basis data yang sama tempat skema katalog platform ini sedang diekspresikan-ulang (lihat [`docs/kamus-data.md`](kamus-data.md)) — jadi instans PostgreSQL harus disediakan di infrastruktur itu, atau di tempat lain, sebelum `apps/cms` bisa di-deploy terhadap basis data nyata sama sekali. Tidak ada apa pun di repositori ini yang menyediakan, memigrasikan, atau men-seed instans itu hari ini; `bun run db:migrate:cms` adalah skrip yang ada dan terdokumentasi, bukan langkah yang sudah dijalankan terhadap data produksi. Inilah mengapa [`docs/pengujian.md`](pengujian.md) mendeskripsikan suite tes ber-gate-DB `apps/cms` sebagai sesuatu untuk dijalankan terhadap PostgreSQL sekali-pakai yang disediakan lokal, tidak pernah terhadap apa pun yang saat ini dioperasikan borneojek.

## Belum dibangun

Dockerfile, image container, atau pipeline deployment apa pun untuk `apps/cms` maupun `apps/storefront` di repositori ini — tidak ada apa pun di bawah `.github/workflows/` yang membangun atau mempublikasikan image container hari ini (lihat [`docs/alur-kerja-pengembangan.md`](alur-kerja-pengembangan.md) untuk persis apa yang dijalankan CI). Konfigurasi reverse-proxy/terminasi-TLS untuk `apps/storefront` di produksi — `apps/storefront/server/penyaji.mjs` mengasumsikan satu ada di depannya tapi tidak mengonfigurasi atau mendokumentasikannya sendiri.
