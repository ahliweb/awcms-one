🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](deployment.md)

<!-- i18n-source-hash: sha256:19d195b1a26073457296ea22f55603885c6bb3a780b4281ef616b79a1e4a0260 -->

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

## Basis data lokal (issue #25)

`compose.yaml` di root repositori menyediakan `postgres:18.4` sekali-pakai untuk pengembangan lokal dan CI — bukan produksi (lihat "Penyediaan PostgreSQL produksi belum dilakukan" di bawah). Ia hanya membuat apa yang TIDAK dibuat migrasi SQL `apps/cms` sendiri: server itu sendiri, dan separuh `LOGIN` dari tiga role yang dibuat migrasi sebagai `NOLOGIN` dan tanpa password dengan sengaja (`apps/cms/sql/019_awcms_db_role_separation.sql` membuat `awcms_app`, `apps/cms/sql/022_awcms_db_worker_setup_roles.sql` membuat `awcms_worker`/`awcms_setup` — password adalah rahasia dan tidak pernah boleh ada di migrasi yang di-commit; lihat header masing-masing berkas). Setiap tabel, indeks, kebijakan RLS, dan `GRANT` tetap tugas migrasi. `docker/postgres-init/01-create-least-privilege-roles.sh` melakukan satu hal yang sengaja tidak dilakukan migrasi, dan tidak lebih — headernya sendiri menjelaskan mengapa menduplikasi satu `GRANT` di sini akan melenceng begitu satu migrasi mempersempit atau melebarkannya.

Urutan lengkap, berurutan, dengan nilai nyata (`cp .env.example .env` di root, `cp apps/cms/.env.example apps/cms/.env` dulu — lihat masing-masing berkas untuk apa yang perlu diedit):

```bash
cp .env.example .env                    # root — POSTGRES_*, AWCMS_*_PASSWORD, SEED_*
bun run db:up                           # postgres:18.4, project "awcms-one", host port 5433

# DATABASE_URL milik apps/cms/.env sendiri default ke bentuk OWNER/superuser
# di port 5432 — timpa itu untuk SATU perintah ini saja agar mengarah ke
# superuser compose di port 5433. Jangan pernah arahkan DATABASE_URL
# tersimpan milik apps/cms sendiri ke owner: role itu superuser Postgres dan
# melewati `FORCE ROW LEVEL SECURITY` sama sekali.
DATABASE_URL=postgres://awcms:awcms_dev_password@localhost:5433/awcms \
  bun run db:migrate:cms

# Edit DATABASE_URL milik apps/cms/.env ke role runtime LEAST-PRIVILEGE
# sebagai gantinya, sesuai default terdokumentasi root .env.example:
#   DATABASE_URL=postgres://awcms_app:awcms_app_dev_password@localhost:5433/awcms
# lalu, di terminal KEDUA, jalankan server yang dijalankan skrip seed
# repositori ini sebagai klien HTTP — pola dua-proses yang sama yang sudah
# dipakai dokumen ini untuk verifikasi build `apps/storefront` sendiri di
# bawah:
cd apps/cms && bun run dev              # atau: bun run build && bun run start

# terminal KETIGA, dari root repositori — idempoten, aman dijalankan ulang
bun run db:seed:cms
```

`tools/seed-borneojek-mart.ts` (`bun run db:seed:cms`) menjalankan `apps/cms` yang sedang berjalan dari langkah di atas sebagai klien HTTP dari permukaan `/api/v1/*` publiknya sendiri — antarmuka yang sama yang dipakai build `apps/storefront`, dan satu-satunya yang dijanjikan tetap stabil oleh issue #23/#26/#29. Ia mem-bootstrap tenant dan owner `borneojek-mart` (`POST /api/v1/setup/initialize`), men-seed katalog 8 kategori dan satu produk representatif per `type` commerce dari `tools/seed-data/*.json`, segelintir term/halaman/post blog, profil situs, dan menerbitkan satu kredensial mesin baca-saja bercakupan `commerce.products.read`/`commerce.categories.read` — bentuk kredensial yang sama yang dibutuhkan token build `apps/storefront`. Setiap langkah idempoten (memeriksa baris sebelum membuatnya); menjalankannya ulang terhadap tenant yang sama tidak membuat apa pun baru dan keluar dengan 0. Ia mencetak password owner dan token kredensial mesin persis sekali, pada run yang membuatnya — tidak ada yang disimpan skrip ini di mana pun.

Membuktikan katalog yang di-seed bisa dilayani:

```bash
curl -H "Authorization: Bearer <AWCMS_API_TOKEN yang dicetak di atas>" \
     -H "x-awcms-tenant-id: <tenantId yang dicetak di atas>" \
     http://localhost:4321/api/v1/commerce/products

cd apps/storefront && AWCMS_API_URL=http://localhost:4321 \
  AWCMS_API_TOKEN=<token> SITE_URL=http://localhost:4321 bun run build
```

`bun run build` me-render satu halaman per produk yang di-seed plus indeks katalog — kriteria penerimaan yang sama yang dinyatakan issue #25.

```bash
bun run db:down                         # hentikan container, simpan volume
bun run db:reset                        # hapus volume juga — bersih total
```

### Field produk yang diisi issue #23

`/api/v1/commerce/products` menerima bentuk 12-field yang didefinisikan `CreateProductInput` milik `apps/cms/src/modules/commerce/domain/product-validation.ts` hari ini — tanpa gambar, tanpa varian, tanpa `service_form`, tanpa `subscription_period`. `tools/seed-data/products.json` sudah membawa nilai `service_form`/varian/`subscription_period` BjekMikro/RutinRide yang diamati di situs live, di bawah kunci `future` masing-masing produk, bersama gambar produk placeholder milik `tools/seed-assets/` — jadi mendaratkan field issue #23 adalah perubahan pada apa yang dikirim `ensureProducts()` milik `tools/seed-borneojek-mart.ts`, membaca data yang sudah ada di berkas ini, tidak pernah restrukturisasi data seed atau skrip kedua.

### Apa yang TIDAK di-seed skrip ini, dan mengapa

Pengaturan toko `commerce_bj_mart` legacy (level pelanggan, metode pengiriman alternatif `BORNEOJEK`, self-pickup, QRIS manual) tidak punya field di `/api/v1/site-profile`, `/api/v1/commerce/*`, atau endpoint lain mana pun yang diekspos `apps/cms` hari ini — diverifikasi dengan membaca setiap modul terdaftar, bukan diasumsikan. `tools/seed-data/site-profile.json` mencatat nilai-nilai ini di bawah kunci `future`-nya sendiri sehingga nilainya tidak hilang, tapi skrip ini tidak mengarang endpoint untuk menerimanya; itu keputusan untuk issue #26/#29, atau admission baru, yang membuatnya.

## Penyediaan PostgreSQL produksi belum dilakukan

`apps/cms` hanya-PostgreSQL. **Server produksi borneojek menjalankan MySQL** — basis data yang sama tempat skema katalog platform ini sedang diekspresikan-ulang (lihat [`docs/kamus-data.md`](kamus-data.md)) — jadi instans PostgreSQL harus disediakan di infrastruktur itu, atau di tempat lain, sebelum `apps/cms` bisa di-deploy terhadap basis data produksi nyata. Container `postgres:18.4` milik `compose.yaml` sengaja adalah kenyamanan LOKAL/CI (volume bernama di disk developer, password default kelas-development terdokumentasi di `.env.example`) dan tidak pernah dimaksudkan untuk diarahkan dari deployment produksi. Inilah mengapa [`docs/pengujian.md`](pengujian.md) mendeskripsikan suite tes ber-gate-DB `apps/cms` sebagai sesuatu untuk dijalankan terhadap PostgreSQL sekali-pakai yang disediakan lokal, tidak pernah terhadap apa pun yang saat ini dioperasikan borneojek.

## Belum dibangun

Dockerfile, image container, atau pipeline deployment apa pun untuk `apps/cms` maupun `apps/storefront` di repositori ini — tidak ada apa pun di bawah `.github/workflows/` yang membangun atau mempublikasikan image container hari ini (lihat [`docs/alur-kerja-pengembangan.md`](alur-kerja-pengembangan.md) untuk persis apa yang dijalankan CI). Konfigurasi reverse-proxy/terminasi-TLS untuk `apps/storefront` di produksi — `apps/storefront/server/penyaji.mjs` mengasumsikan satu ada di depannya tapi tidak mengonfigurasi atau mendokumentasikannya sendiri.
