🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](deployment.md)

<!-- i18n-source-hash: sha256:b5c7b7bfbfa56522de4094b0e741d0ee788063d6ee31f748508ea42a79c1b77e -->

# Deployment

Bagaimana `apps/storefront` di-build dan dilayani, variabel environment-nya, dan — terus terang, karena itu mengubah apa arti "men-deploy repositori ini" hari ini — bahwa `apps/cms` belum bisa di-deploy terhadap basis data nyata di infrastruktur borneojek sendiri.

## Build, lalu serve — dua langkah terpisah, dua level kepercayaan terpisah

```bash
bun run build          # bun run check && astro build && build:build-id && build:penyaji
bun run serve          # bun dist/server/penyaji.mjs
```

`bun run build` (`apps/storefront/package.json`) menjalankan `bun run check` (type-check), lalu `astro build` (mengambil katalog, permukaan marketing, dan konten berita dari `apps/cms` memakai `AWCMS_API_TOKEN`, memanggang setiap halaman ke `dist/client/`, dan menulis artefak CSP turunan — lihat [`docs/arsitektur.md`](arsitektur.id.md)), lalu menulis build id, lalu `build:penyaji` (mem-bundle `apps/storefront/server/penyaji.mjs` sendiri ke `dist/server/penyaji.mjs` lewat `bun build --target=bun`). **Hanya langkah build yang pernah membaca variabel `AWCMS_*`, dan hanya langkah build yang pernah membaca `AWCMS_API_TOKEN` sama sekali.** `bun run serve` menjalankan `dist/server/penyaji.mjs` yang sudah di-build, yang membaca `PORT`/`HOST` dan, hanya saat startup, artefak `csp.json` build-nya sendiri — tidak pernah kredensial `apps/cms` hidup. Ini bukti mekanis dari klaim [ADR-0002](adr/0002-static-output-with-build-time-fetch-for-the-storefront.md) bahwa *container* tidak pernah berbicara ke `apps/cms`: sumber proses yang dilayani sama sekali tidak punya jalur kode yang membaca kredensial atau URL yang bisa menjangkaunya. **Yang ditambahkan increment 2 adalah relasi kedua, sisi-browser** — halaman keranjang, checkout, dan pelacakan pesanan mengirimkan JavaScript sisi-klien yang memanggil endpoint anonim `apps/cms` `/api/v1/commerce/storefront/*` langsung, cross-origin, dari browser pembaca sendiri, tidak pernah dari container — lihat [ADR-0007](adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.id.md).

## Variabel environment

Dua berkas `.env.example` terpisah, satu per workspace, sengaja tidak digabung — berkas `apps/storefront` sendiri hanya mendokumentasikan apa yang dibacanya; ia tidak menduplikasi milik `apps/cms`.

### `apps/storefront/.env.example`

| Variabel | Dibaca | Tujuan |
| --- | --- | --- |
| `SITE_URL` | Saat build (juga `astro.config.mjs` langsung, sebelum `apps/storefront/src/config/site.ts` berjalan) | Origin absolut kanonik — tautan kanonik, URL Open Graph, dan JSON-LD `Product` semuanya dibangun darinya |
| `SITE_NAME`, `SITE_DESCRIPTION` | Saat build | Opsional; default yang masuk akal sehingga `bun run dev` bekerja tanpa `.env` sama sekali |
| `AWCMS_API_URL` | Hanya saat build | Origin instans `apps/cms` untuk mengambil katalog, permukaan marketing, dan konten berita |
| `AWCMS_API_TOKEN` | Hanya saat build | Kredensial Bearer **read-only**, dibatasi ke setiap permission `read` commerce (seed issue #25 kini menerbitkan satu kredensial yang mencakup pembacaan katalog, marketing, dan — bila berlaku — ekspor pesanan) — tidak pernah dipancarkan ke output build; tidak diprefiks `PUBLIC_`, dengan sengaja, karena Vite hanya meng-inline variabel berprefiks `PUBLIC_` ke kode yang terjangkau klien |
| `AWCMS_API_TIMEOUT_MS` | Hanya saat build, opsional | Berapa lama satu request ke `apps/cms` boleh berlangsung sebelum build menyerah (default 30000 ms) — nilai yang bukan angka positif ditolak langsung, termasuk `0`, yang jika tidak berarti "tanpa batas" dan mengembalikan persis hang yang ingin dicegah deadline ini |
| `PUBLIC_AWCMS_ORIGIN` | Saat build, dan dipanggang ke CSP yang dilayani | **Baru di issue #30.** Origin `apps/cms` yang dipanggil *browser* saat runtime untuk keranjang/checkout/pelacakan-pesanan — sengaja diprefiks `PUBLIC_`, karena ia origin, bukan rahasia (nilai yang sama yang sudah diungkap setiap URL media). Divalidasi oleh `apps/storefront/src/lib/awcms/toko-origin.ts`; nilai yang tidak diset atau malformed menggagalkan build langsung, menyebut nama variabelnya, karena `apps/storefront/src/pages/csp.json.ts` — halaman yang di-prerender tanpa syarat oleh setiap build — memanggil validator itu tanpa syarat. Lihat [ADR-0007](adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.id.md) dan [`docs/arsitektur.md`](arsitektur.id.md) |
| `PUBLIC_WILAYAH_PROVINSI` | Saat build, opsional | Provinsi Indonesia mana yang data wilayah-alamatnya (`idn_admin_regions`) dipanggang ke `/index/wilayah-*.json` untuk form alamat checkout — default semua provinsi Kalimantan, sengaja bukan dataset nasional penuh ~90.000 desa |
| `PORT`, `HOST` | Runtime, hanya oleh `apps/storefront/server/penyaji.mjs` | Default `8080`/`0.0.0.0` — `0.0.0.0` karena proses ini biasanya berjalan di dalam container di belakang reverse proxy, di mana listener khusus-`localhost` tidak terjangkau dari luar container dan muncul sebagai health check yang gagal tanpa alasan yang dinyatakan |

### `apps/cms/.env.example`

Berkas yang jauh lebih besar, dimiliki sepenuhnya oleh `apps/cms` sebagai kode `ahliweb/awcms` yang di-embed — root repositori ini tidak menduplikasinya ("Configuration and toolchain" milik `AGENTS.md`: "setiap variabel env yang dibaca skrip level-root harus ada di `.env.example`... `apps/cms` menjaga `.env.example`-nya sendiri untuk konfigurasi runtime-nya sendiri; berkas root repo ini tidak menduplikasinya"). Variabel yang penting untuk memahami apa yang dibutuhkan `apps/cms` yang berjalan: `DATABASE_URL` (role aplikasi `awcms_app` — tidak pernah role pemilik basis data, yang adalah superuser Postgres yang melewati `FORCE ROW LEVEL SECURITY` sama sekali, mengalahkan persis isolasi yang didokumentasikan [`docs/skema-basis-data.md`](skema-basis-data.md)), `APP_ENV`/`APP_URL`, dan variabel HTTP listener (`PORT`, `HOST`, dan jalur sertifikat TLS in-process opsional) yang dibaca entrypoint standalone-nya sendiri.

## Apa yang boleh menjangkau `apps/cms`: proses build, dan — sejak issue #30 — browser pembaca

| | Boleh menjangkau |
| --- | --- |
| Proses build (`astro build`) | API publik `apps/cms`, lewat HTTPS, dengan token build read-only |
| Container yang berjalan (`bun dist/server/penyaji.mjs`) | Tidak ada apa pun di luar dirinya sendiri — tidak ada `apps/cms`, tidak ada basis data, tidak ada panggilan jaringan eksternal jenis apa pun. Ini tidak berubah sejak increment 1 |
| Browser pembaca sendiri | API anonim `apps/cms` `/api/v1/commerce/storefront/*`, di `PUBLIC_AWCMS_ORIGIN`, `mode: "cors"` / `credentials: "omit"` — tidak ada cookie, tidak ada bearer token, tidak pernah |

CSP milik `apps/storefront/server/penyaji.mjs` sendiri kini diturunkan, bukan dikonfigurasi tangan — `img-src` dan `connect-src` membawa persis origin yang benar-benar dirujuk suatu build tertentu (gambar produk/media, dan `PUBLIC_AWCMS_ORIGIN`), divalidasi ulang saat server startup dan jatuh kembali ke `'self'`-saja pada artefak yang hilang/malformed mana pun; lihat [`docs/arsitektur.md`](arsitektur.id.md) untuk mekanisme lengkapnya. Setiap direktif CSP lain tetap `'self'`/`'none'` — tidak ada skrip atau embed pihak-ketiga yang diizinkan aplikasi ini.

## Origin storefront tenant yang di-seed harus didaftarkan di `awcms_tenant_domains`

API storefront anonim me-resolve tenant-nya dari header `Origin` browser pemanggil terhadap tabel `awcms_tenant_domains` milik `apps/cms` — origin yang tidak terdaftar di sana mendapat penolakan netral yang sama seperti kode pesanan yang tidak dikenal (lihat [`docs/api.md`](api.id.md)). `tools/seed-borneojek-mart.ts` mendaftarkan `mart.borneojek.com` dan `http://localhost:4321` (default dev repo ini sendiri) sebagai domain `active` yang diatestasi manual untuk tenant yang di-seed. Deployment yang melayani storefront dari origin berbeda harus mendaftarkan origin itu dengan cara yang sama sebelum checkout bisa bekerja sama sekali — ini langkah nyata yang mudah terlewat, bukan detail implementasi.

## Basis data lokal (issue #25)

`compose.yaml` di root repositori menyediakan `postgres:18.4` sekali-pakai untuk pengembangan lokal dan CI — bukan produksi (lihat "Penyediaan PostgreSQL produksi belum dilakukan" di bawah). Ia hanya membuat apa yang TIDAK dibuat migrasi SQL `apps/cms` sendiri: server itu sendiri, dan separuh `LOGIN` dari tiga role yang dibuat migrasi sebagai `NOLOGIN` dan tanpa password dengan sengaja (`apps/cms/sql/019_awcms_db_role_separation.sql` membuat `awcms_app`, `apps/cms/sql/022_awcms_db_worker_setup_roles.sql` membuat `awcms_worker`/`awcms_setup` — password adalah rahasia dan tidak pernah boleh ada di migrasi yang di-commit; lihat header masing-masing berkas). Setiap tabel, indeks, kebijakan RLS, dan `GRANT` tetap tugas migrasi. `docker/postgres-init/01-create-least-privilege-roles.sh` melakukan satu hal yang sengaja tidak dilakukan migrasi, dan tidak lebih — headernya sendiri menjelaskan mengapa menduplikasi satu `GRANT` di sini akan melenceng begitu satu migrasi mempersempit atau melebarkannya.

Urutan lengkap, berurutan, dengan nilai nyata (`cp .env.example .env` di root, `cp apps/cms/.env.example apps/cms/.env` dulu — lihat masing-masing berkas untuk apa yang perlu diedit):

```bash
cp .env.example .env                    # root — POSTGRES_*, AWCMS_*_PASSWORD, SEED_*
bun run db:up                           # postgres:18.4, project "awcms-one", host port 5433

# apps/cms/.env's own DATABASE_URL defaults to the OWNER/superuser shape on
# port 5432 — override it for THIS one command to point at the compose
# superuser on port 5433 instead. Never point apps/cms's own persisted
# DATABASE_URL at the owner: that role is a Postgres superuser and bypasses
# `FORCE ROW LEVEL SECURITY` outright.
DATABASE_URL=postgres://awcms:awcms_dev_password@localhost:5433/awcms \
  bun run db:migrate:cms

# Edit apps/cms/.env's DATABASE_URL to the LEAST-PRIVILEGE runtime role
# instead, matching root .env.example's documented defaults:
#   DATABASE_URL=postgres://awcms_app:awcms_app_dev_password@localhost:5433/awcms
# then, in a SECOND terminal, start the server this repo's seed script drives
# as an HTTP client — the same two-process pattern this document already
# uses for apps/storefront's own build verification below:
cd apps/cms && bun run dev              # or: bun run build && bun run start

# a THIRD terminal, from the repo root — idempotent, safe to re-run
bun run db:seed:cms
```

`tools/seed-borneojek-mart.ts` (`bun run db:seed:cms`) menjalankan `apps/cms` yang sedang berjalan dari langkah di atas sebagai klien HTTP dari permukaan `/api/v1/*` publiknya sendiri — antarmuka yang sama yang dipakai build `apps/storefront`, dan satu-satunya yang dijanjikan tetap stabil oleh issue #23/#26/#29. Setiap langkah idempoten (memeriksa baris sebelum membuatnya); menjalankannya ulang terhadap tenant yang sama tidak membuat apa pun baru dan keluar dengan 0. Per issue #29, ia men-seed:

- Tenant dan owner `borneojek-mart` (`POST /api/v1/setup/initialize`), dan origin storefront-nya di `awcms_tenant_domains` (lihat di atas).
- Katalog 8 kategori dan satu produk per `type` commerce (physical/service/subscription/digital, yang terakhir placeholder sintetis yang ditandai jelas), dengan field paritas BjekMart lengkap (gambar, varian, size chart, service form) dari `tools/seed-data/*.json`.
- Permukaan marketing: satu flash sale dengan satu produk, dua voucher, tiga testimoni, satu popup, dan store settings.
- Segelintir term/halaman/post blog dan profil situs.
- Satu pelanggan dengan dua pesanan pada state berbeda (`pending_payment`, `paid`), dibuat lewat jalur pembuatan-pesanan anonim itu sendiri — bukan backdoor — sehingga seed sekaligus membuktikan jalur itu bekerja.
- Kredensial mesin baca-saja bercakupan setiap permission `read` commerce (pembacaan katalog, marketing, dan order/customer/review) — bentuk kredensial yang sama yang dibutuhkan token build `apps/storefront`.

Ia mencetak password owner dan token kredensial mesin persis sekali, pada run yang membuatnya — tidak ada yang disimpan skrip ini di mana pun.

### Celah yang diketahui: `SETUP_DATABASE_URL` / `awcms_setup` kekurangan grant yang dibutuhkan

Ditemukan selama pengembangan issue #26: role `awcms_setup` (yang dimaksudkan `SETUP_DATABASE_URL` untuk membatasi cakupan wizard setup satu-kali) tidak punya grant pada `awcms_principals` — `sql/112` memberi grant tabel itu hanya ke `awcms_app`. Mengonfigurasi `SETUP_DATABASE_URL` seperti yang didokumentasikan upstream karena itu membuat wizard setup 500. Urutan di atas mengatasinya dengan membiarkan `SETUP_DATABASE_URL` tidak diset sama sekali (wizard kemudian berjalan di bawah `DATABASE_URL` `apps/cms` yang sudah dikonfigurasi) — ini alur lokal yang didokumentasikan, bukan perbaikan. Diajukan sebagai issue upstream `ahliweb/awcms`; bukan sesuatu yang bisa diperbaiki migrasi repositori ini sendiri, karena `sql/112` adalah kode upstream yang di-embed lewat subtree.

Membuktikan katalog yang di-seed bisa dilayani:

```bash
curl -H "Authorization: Bearer <AWCMS_API_TOKEN printed above>" \
     -H "x-awcms-tenant-id: <tenantId printed above>" \
     http://localhost:4321/api/v1/commerce/products

cd apps/storefront && AWCMS_API_URL=http://localhost:4321 \
  AWCMS_API_TOKEN=<token> SITE_URL=http://localhost:4321 bun run build
```

`bun run build` me-render satu halaman per produk yang di-seed plus indeks katalog, permukaan marketing, dan konten berita yang di-seed.

```bash
bun run db:down                         # hentikan container, simpan volume
bun run db:reset                        # hapus volume juga — bersih total
```

### Gotcha Postgres 18, dicatat agar orang berikutnya tidak kehilangan satu jam untuknya

Image resmi `postgres:18` menolak volume yang di-mount langsung di `/var/lib/postgresql/data` — layout pra-18 yang sudah tidak dipakainya lagi. `compose.yaml` sebagai gantinya me-mount volume bernama itu di `/var/lib/postgresql`. Jika suatu saat edit ke `compose.yaml` memindahkan mount point itu kembali, `bun run db:up` gagal langsung alih-alih menjalankan server yang rusak.

### Apa yang masih TIDAK di-seed skrip ini, dan mengapa

Gambar produk, media slider, dan gambar bukti konfirmasi-pembayaran di-resolve lewat mekanisme referensi `media_library` yang sudah ada (lihat [`docs/cms.md`](cms.id.md)) tapi tidak diunggah lewat sesi R2 nyata di sini — `tools/seed-assets/` membawa SVG placeholder kecil buatan-sendiri alih-alih foto nyata, dan endpoint unggah bukti-pembayaran anonim selalu menjawab `503 MEDIA_UNAVAILABLE`. Tarif kurir RajaOngkir dan payment gateway tidak punya field pada endpoint mana pun yang diekspos `apps/cms` hari ini, by design — lihat [ADR-0010](adr/0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.id.md) dan [issue #33](https://github.com/ahliweb/awcms-one/issues/33). Akun pelanggan tidak di-seed — pelanggan yang di-seed tidak punya password, cocok dengan [ADR-0009](adr/0009-guest-checkout-by-order-code-and-phone.id.md) dan [issue #32](https://github.com/ahliweb/awcms-one/issues/32).

## Mengimpor seputarborneo (issue #58)

`tools/import-seputarborneo.ts` (`bun run import:seputarborneo`) mengimpor arsip MariaDB lama seputarborneo.com — `berita_red` (artikel), `berita_vid` (post video), `ikl_online` (materi iklan), `logo` (logo instansi), `config` (profil situs) — ke tenant `borneojek-mart` yang SAMA yang di-bootstrap [`tools/seed-borneojek-mart.ts`](#basis-data-lokal-issue-25), lewat permukaan publik `/api/v1/*` tenant itu. `users`, `counter`, `newsletter_subscribers`, `renungan_rmd`, `tanya_jawab`, dan `foto_berita` paling banter hanya dibaca untuk dihitung (atau sama sekali tidak dibaca) — tidak pernah diimpor; lihat header skrip itu sendiri untuk alasan tiap satu dikecualikan (PII, tidak ada catatan persetujuan, atau tabel mati/tak terpakai).

**Dump tidak pernah disalin ke repositori ini, tidak pernah di-commit, dan tidak pernah dicetak.** `tools/lib/mysql-dump-reader.ts` men-stream-nya — `Bun.file(...).stream()` lewat `DecompressionStream("gzip")` — satu baris sekaligus; arsip 228 MB (setelah dekompresi) tidak pernah ditahan utuh di memori, dan baris log skrip ini hanya mencetak angka, tidak pernah nilai judul/isi/kategori satu baris pun.

```bash
# .env: set SEPUTARBORNEO_DUMP ke path absolut dump yang sudah dikompresi gzip.

# Aman di mesin yang sama sekali tidak menjalankan apps/cms — hanya membaca dump.
bun run import:seputarborneo -- --dry-run

# Terhadap tenant yang SUDAH di-seed (bun run db:seed:cms dulu, apps/cms
# berjalan, SEED_OWNER_PASSWORD di-set ke password yang dicetak run seed itu):
bun run import:seputarborneo -- --commit --limit=200
```

`--dry-run` (default setiap kali `--commit` absen) mencetak jumlah per rubrik/wilayah-atau-jenis-mitra, per tahun, dan setiap nilai taksonomi yang tak terpetakan — semuanya bukan isi baris, dan semuanya juga ada di `tools/out/seputarborneo-import-manifest.json` (git-ignored). `--limit=<n>` membatasi jumlah baris `berita_red` yang diproses; `--since=<yyyy-mm-dd>` memfilter berdasarkan `tgl`.

### Dua keterbatasan nyata API publik, ditemukan dan didokumentasikan alih-alih disiasati diam-diam

1. **Tidak ada field publik yang mem-backdate `published_at`.** `apps/cms` punya pipeline NDJSON internal `bun run blog:legacy:import` (`apps/cms/scripts/blog-legacy-import.ts`) yang menulis tanggal historis nyata langsung ke basis data — dibangun, menurut docblock-nya sendiri, memakai arsip seputarborneo ini persis sebagai kasus acuannya. Pipeline itu berjalan DI DALAM `apps/cms`, yang merupakan batas workspace yang tidak boleh dilewati tool repositori ini (AGENTS.md "Workspace boundaries"). `POST /api/v1/blog/posts/{id}/schedule` MENERIMA `scheduledAt` di masa depan, jadi artikel lama bertanggal masa depan tetap mempertahankan tanggal aslinya; yang sudah lewat malah diterbitkan pada WAKTU IMPOR. Lihat header `tools/import-seputarborneo.ts` sendiri untuk penalaran lengkapnya.
2. **Tidak ada field publik yang men-set byline artikel yang dirender.** `authorByline` diturunkan dari tenant user yang terautentikasi, tidak pernah dari input per-post. Kolom `user`/`admin` lama ditulis ke `contentJson.legacySource.author` sebagai gantinya, untuk provenance — tidak dirender sebagai byline artikel.

### Apa yang masih butuh manusia, atau issue susulan

- **Media.** `--media` (dengan `SEPUTARBORNEO_FILES` di-set) hanya MENYEBUTKAN apa yang masih perlu diunggah (daftar `mediaNeeded` di `tools/out/seputarborneo-import-manifest.json`) — tidak mengunggah apa pun sendiri, handoff yang sama yang dipakai `blog:legacy:import --images`/`--media-map` milik `apps/cms` sendiri dan untuk alasan yang sama (`/admin/media` adalah satu-satunya jalur dengan MIME-sniffing dan batas ukuran; skrip yang mengambil byte pihak ketiga di sisi server adalah primitif request-forgery). Setiap foto utama `foto_berita` pada baris `berita_red` butuh ini dulu sebelum artikel itu bisa dibuat dengan `featuredMediaId`.
- **Penempatan iklan** (`ikl_online`) dan **logo instansi** (`logo`, untuk [issue #59](https://github.com/ahliweb/awcms-one/issues/59)'s `logo_media_id`) hanya dibaca ke manifest — penempatan butuh `mediaObjectId` terverifikasi sebelum `POST /api/v1/news-portal/ad-placements` menerimanya, dan `awcms_blog_institutions.logo_media_id` belum ada di `apps/cms` repositori ini.
- **Tiga dari empat belas wilayah `daerah`** (Kotawaringin Barat, Sukamara, Barito Selatan) tidak punya instansi yang berpadanan di seed 24-instansi [issue #57](https://github.com/ahliweb/awcms-one/issues/57), dan sebuah post hanya mencapai `/daerah/{slug}` lewat `regionCode` sebuah instansi (header `apps/storefront/src/pages/daerah/[slug].astro` sendiri) — tidak ada field `regionCode` pada post lewat API publik. Artikel untuk ketiga wilayah itu tetap terimpor dengan benar tapi tidak akan muncul di arsip wilayahnya sampai ada issue susulan yang menambahkan instansi (atau API publik mendapat field wilayah tingkat-post).
- **Run produksi penuh** (seluruh ~25.490 baris `berita_red`, setiap video, setiap iklan, setiap logo) sengaja ditunda melewati PR issue #58 sendiri — lihat daftar acceptance issue #58.

## Penyediaan PostgreSQL produksi belum dilakukan

`apps/cms` hanya-PostgreSQL. **Server produksi borneojek menjalankan MySQL** — basis data yang sama tempat skema katalog platform ini sedang diekspresikan-ulang (lihat [`docs/kamus-data.md`](kamus-data.md)) — jadi instans PostgreSQL harus disediakan di infrastruktur itu, atau di tempat lain, sebelum `apps/cms` bisa di-deploy terhadap basis data produksi nyata. Container `postgres:18.4` milik `compose.yaml` sengaja adalah kenyamanan LOKAL/CI (volume bernama di disk developer, password default kelas-development terdokumentasi di `.env.example`) dan tidak pernah dimaksudkan untuk diarahkan dari deployment produksi. Inilah mengapa [`docs/pengujian.md`](pengujian.md) mendeskripsikan suite tes ber-gate-DB `apps/cms` sebagai sesuatu untuk dijalankan terhadap PostgreSQL sekali-pakai yang disediakan lokal, tidak pernah terhadap apa pun yang saat ini dioperasikan borneojek.

## Belum dibangun

Dockerfile, image container, atau pipeline deployment apa pun untuk `apps/cms` maupun `apps/storefront` di repositori ini — tidak ada apa pun di bawah `.github/workflows/` yang membangun atau mempublikasikan image container hari ini (lihat [`docs/alur-kerja-pengembangan.md`](alur-kerja-pengembangan.md) untuk persis apa yang dijalankan CI). Konfigurasi reverse-proxy/terminasi-TLS untuk `apps/storefront` di produksi — `apps/storefront/server/penyaji.mjs` mengasumsikan satu ada di depannya tapi tidak mengonfigurasi atau mendokumentasikannya sendiri.
