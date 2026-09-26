🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](deployment.md)

<!-- i18n-source-hash: sha256:1c160cdaaf6bb1906e91080121611208f3b51202b99d2cd90cd6b1ff20ce4c73 -->

# Deployment

Bagaimana `apps/storefront` di-build dan dilayani, variabel environment-nya, dan — terus terang, karena itu mengubah apa arti "men-deploy repositori ini" hari ini — bahwa `apps/cms` belum bisa di-deploy terhadap basis data nyata di infrastruktur borneojek sendiri.

## Build, lalu serve — dua langkah terpisah, dua level kepercayaan terpisah

```bash
bun run build          # bun run check && astro build && build:build-id && build:penyaji
bun run serve          # bun dist/server/penyaji.mjs
```

`bun run build` (`apps/storefront/package.json`) menjalankan `bun run check` (type-check), lalu `astro build` (mengambil katalog, permukaan marketing, dan konten berita dari `apps/cms` memakai `AWCMS_API_TOKEN`, memanggang setiap halaman ke `dist/client/`, dan menulis artefak CSP turunan — lihat [`docs/arsitektur.md`](arsitektur.id.md)), lalu menulis build id, lalu `build:penyaji` (mem-bundle `apps/storefront/server/penyaji.mjs` sendiri ke `dist/server/penyaji.mjs` lewat `bun build --target=bun`). **Hanya langkah build yang pernah membaca variabel `AWCMS_*`, dan hanya langkah build yang pernah membaca `AWCMS_API_TOKEN` sama sekali.** `bun run serve` menjalankan `dist/server/penyaji.mjs` yang sudah di-build, yang membaca `PORT`/`HOST` dan, hanya saat startup, artefak `csp.json` build-nya sendiri — tidak pernah kredensial `apps/cms` hidup. Ini bukti mekanis dari klaim [ADR-0002](adr/0002-static-output-with-build-time-fetch-for-the-storefront.md) bahwa *container* tidak pernah berbicara ke `apps/cms`: sumber proses yang dilayani sama sekali tidak punya jalur kode yang membaca kredensial atau URL yang bisa menjangkaunya. **Yang ditambahkan increment 2 adalah relasi kedua, sisi-browser** — halaman keranjang, checkout, dan pelacakan pesanan mengirimkan JavaScript sisi-klien yang memanggil endpoint anonim `apps/cms` `/api/v1/commerce/storefront/*` langsung, cross-origin, dari browser pembaca sendiri, tidak pernah dari container — lihat [ADR-0007](adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.id.md).

### Profil build (`SITE_PROFILE`, issue #137)

`bun run build`/`check`/`dev`/`serve` semuanya menuruti `SITE_PROFILE ∈ {toko, berita, landing}` (default `toko`), dibaca sekali saat build oleh `apps/storefront/src/config/profil.ts` — lihat bagian "Build profiles" di [`docs/routing.md`](routing.id.md) untuk mekanismenya dan [`docs/template.md`](template.id.md) untuk matriks lengkapnya. Men-deploy situs khusus `berita` atau khusus `landing` adalah proses build-lalu-serve dua langkah yang sama di atas, dengan `SITE_PROFILE` diatur di environment build; tidak ada yang berbeda dari cara melayani `dist/` hasilnya — `apps/storefront/server/penyaji.mjs` menurunkan apa yang bisa dilayaninya dari build yang diberikan padanya, sama seperti yang sudah dilakukannya untuk artefak CSP. Local CI membuktikan ketiganya bisa dibangun (leg `local-ci/check-toko|berita|landing` milik `bun run ci`, ketiganya status check wajib di `main` bersama `local-ci/check-cms`), dan keempat leg `local-ci/template-*` (sebelumnya `.github/workflows/template-init-smoke.yml`) tambahan membangun tiap profil setelah run `bun run template:init` yang sungguhan — semuanya juga status check wajib — lihat [`docs/alur-kerja-pengembangan.md`](alur-kerja-pengembangan.id.md).

## Variabel environment

Dua berkas `.env.example` terpisah, satu per workspace, sengaja tidak digabung — berkas `apps/storefront` sendiri hanya mendokumentasikan apa yang dibacanya; ia tidak menduplikasi milik `apps/cms`.

### `apps/storefront/.env.example`

| Variabel | Dibaca | Tujuan |
| --- | --- | --- |
| `SITE_URL` | Saat build (juga `astro.config.mjs` langsung, sebelum `apps/storefront/src/config/site.ts` berjalan) | Origin absolut kanonik — tautan kanonik, URL Open Graph, dan JSON-LD `Product` semuanya dibangun darinya |
| `SITE_NAME`, `SITE_DESCRIPTION` | Saat build | Opsional; default yang masuk akal sehingga `bun run dev` bekerja tanpa `.env` sama sekali |
| `AWCMS_API_URL` | Hanya saat build | Origin instans `apps/cms` untuk mengambil katalog, permukaan marketing, dan konten berita |
| `AWCMS_API_TOKEN` | Hanya saat build | Kredensial Bearer **read-only**, dibatasi ke setiap permission `read` yang dipakai build untuk mengambil data — pembacaan commerce (katalog, marketing, dan — bila berlaku — ekspor pesanan; issue #25) plus 9 pembacaan permukaan berita (issue #57 dan #47: `blog_content.{posts,taxonomies,institutions,pages,ad_placements}.read`, `seo_distribution.redirect.read`, `site_profile.profile.read`, `idn_admin_regions.region.read`, `media_library.media.read`); seed menerbitkan satu kredensial yang mencakup semuanya — tidak pernah dipancarkan ke output build; tidak diprefiks `PUBLIC_`, dengan sengaja, karena Vite hanya meng-inline variabel berprefiks `PUBLIC_` ke kode yang terjangkau klien |
| `AWCMS_API_TIMEOUT_MS` | Hanya saat build, opsional | Berapa lama satu request ke `apps/cms` boleh berlangsung sebelum build menyerah (default 30000 ms) — nilai yang bukan angka positif ditolak langsung, termasuk `0`, yang jika tidak berarti "tanpa batas" dan mengembalikan persis hang yang ingin dicegah deadline ini |
| `PUBLIC_AWCMS_ORIGIN` | Saat build, dan dipanggang ke CSP yang dilayani | **Baru di issue #30.** Origin `apps/cms` yang dipanggil *browser* saat runtime untuk keranjang/checkout/pelacakan-pesanan — sengaja diprefiks `PUBLIC_`, karena ia origin, bukan rahasia (nilai yang sama yang sudah diungkap setiap URL media). Divalidasi oleh `apps/storefront/src/lib/awcms/toko-origin.ts`; nilai yang tidak diset atau malformed menggagalkan build langsung, menyebut nama variabelnya, karena `apps/storefront/src/pages/csp.json.ts` — halaman yang di-prerender tanpa syarat oleh setiap build — memanggil validator itu tanpa syarat. Lihat [ADR-0007](adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.id.md) dan [`docs/arsitektur.md`](arsitektur.id.md) |
| `PUBLIC_WILAYAH_PROVINSI` | Saat build, opsional | Provinsi Indonesia mana yang data wilayah-alamatnya (`idn_admin_regions`) dipanggang ke `/index/wilayah-*.json` untuk form alamat checkout — default semua provinsi Kalimantan, sengaja bukan dataset nasional penuh ~90.000 desa |
| `PUBLIC_GA_ID` | Saat build, dan dipanggang ke CSP yang disajikan | **Baru di issue #56.** Measurement ID GA4 miliknya sendiri (`G-…`). Tidak diset, kosong, atau tidak berbentuk seperti itu (`apps/storefront/src/lib/ga.ts`) dan build tersebut sama sekali tidak membawa origin Google mana pun — lihat "Dua sakelar" di bawah |
| `PORT`, `HOST` | Runtime, hanya oleh `apps/storefront/server/penyaji.mjs` | Default `8080`/`0.0.0.0` — `0.0.0.0` karena proses ini biasanya berjalan di dalam container di belakang reverse proxy, di mana listener khusus-`localhost` tidak terjangkau dari luar container dan muncul sebagai health check yang gagal tanpa alasan yang dinyatakan |

### `apps/cms/.env.example`

Berkas yang jauh lebih besar, dimiliki sepenuhnya oleh `apps/cms` sebagai kode `ahliweb/awcms` yang di-embed — root repositori ini tidak menduplikasinya ("Configuration and toolchain" milik `AGENTS.md`: "setiap variabel env yang dibaca skrip level-root harus ada di `.env.example`... `apps/cms` menjaga `.env.example`-nya sendiri untuk konfigurasi runtime-nya sendiri; berkas root repo ini tidak menduplikasinya"). Variabel yang penting untuk memahami apa yang dibutuhkan `apps/cms` yang berjalan: `DATABASE_URL` (role aplikasi `awcms_app` — tidak pernah role pemilik basis data, yang adalah superuser Postgres yang melewati `FORCE ROW LEVEL SECURITY` sama sekali, mengalahkan persis isolasi yang didokumentasikan [`docs/skema-basis-data.md`](skema-basis-data.md)), `APP_ENV`/`APP_URL`, dan variabel HTTP listener (`PORT`, `HOST`, dan jalur sertifikat TLS in-process opsional) yang dibaca entrypoint standalone-nya sendiri.

**`EMAIL_ENABLED`/`EMAIL_PROVIDER` menjadi load-bearing untuk login pelanggan, tidak sekadar untuk e-mail keluar secara umum, sejak increment 4.** `POST account/otp/request` (issue #89) mengantre kode 6 digitnya lewat outbox modul `email` yang sama yang dipakai setiap e-mail transaksional lain. Dengan `EMAIL_ENABLED=false` (default) atau `EMAIL_PROVIDER=log`, kodenya pergi ke adapter `log` alih-alih ke kotak masuk — deployment yang dibiarkan di default ini tetap bisa menjalankan seluruh alur OTP di pengembangan/CI, tapi pelanggan "produksi" sungguhan tidak bisa benar-benar menerima kode login-nya sampai keduanya diset (`EMAIL_ENABLED=true` dan `EMAIL_PROVIDER` nyata, mis. `mailketing`). Ini gerbang deployment, bukan sekadar flag fitur: menyalakannya belakangan adalah beda antara permukaan akun bekerja ujung ke ujung dan setiap login diam-diam hanya sampai ke log server.

| Variabel | Default | Tujuan |
| --- | --- | --- |
| `EMAIL_ENABLED` | `false` | Apakah modul `email` benar-benar mengirim — `false` mengarahkan setiap pesan, termasuk OTP, ke adapter `log` |
| `EMAIL_PROVIDER` | tidak diset (`log` saat `EMAIL_ENABLED=false`) | `mailketing` (adapter nyata) atau `log` (aman untuk lokal/dev, tanpa jaringan) |
| `COMMERCE_ACCOUNT_OTP_RATE_LIMIT_MAX_PER_IP` / `_WINDOW_SEC` / `_MAX_PER_EMAIL` | 10 / 3600 / 5 | Batas dua-sumbu `account/otp/request` (issue #89) — batas per-IP saja tidak bisa melindungi kotak surat tujuan OTP |
| `COMMERCE_ACCOUNT_OTP_VERIFY_RATE_LIMIT_MAX_PER_IP` / `_WINDOW_SEC` | 20 / 3600 | Budget per-IP `account/otp/verify` sendiri yang lebih longgar — tanpa sumbu per-e-mail, karena kode ter-hash dengan 5 percobaan sudah membatasi tebakan satu alamat |
| `COMMERCE_STOREFRONT_PUBLIC_URL` | tidak diset | Origin storefront publik deployment ini, dipakai hanya untuk membangun tautan referral afiliasi yang terdaftar (issue #92, `"${COMMERCE_STOREFRONT_PUBLIC_URL}/?ref=CODE"`); tidak diset jatuh kembali ke `/?ref=CODE` relatif alih-alih mengarang origin |
| `COMMERCE_SHIPPING_RATE_PROVIDER` | tidak diset | Issue #107 (contract #106 D4) — `rajaongkir` (adapter nyata) atau `log` (aman untuk lokal/dev, tanpa jaringan); tidak diset berarti tidak ada tarif kurir langsung sama sekali, terlepas dari `shipping.courier.enabled` pada pengaturan milik tenant sendiri |
| `COMMERCE_RAJAONGKIR_API_KEY` | tidak diset | Wajib saat `COMMERCE_SHIPPING_RATE_PROVIDER=rajaongkir` — nilai header `key` API v2 Komerce |
| `COMMERCE_RAJAONGKIR_BASE_URL` | `https://rajaongkir.komerce.id/api/v1` | Override hanya untuk pengujian/dev — tidak pernah dari input permintaan |
| `COMMERCE_RAJAONGKIR_TIMEOUT_MS` | `10000` | Timeout per panggilan (`withTimeout`) untuk kedua panggilan RajaOngkir, pencarian tujuan dan hitung ongkos |
| `COMMERCE_PAYMENT_GATEWAY` | tidak diset | Issue #110 (kontrak #106 D3) — `midtrans` (adapter nyata) atau `log` (deterministik, tanpa jaringan; ditolak saat `NODE_ENV=production`); tidak diset berarti `payment.method: "gateway"` tidak pernah `available`, apa pun status `payment.gateway.enabled` pada pengaturan tenant sendiri |
| `COMMERCE_MIDTRANS_SERVER_KEY` | tidak diset | Wajib saat `COMMERCE_PAYMENT_GATEWAY=midtrans` — server key Basic-auth yang dikirim sebagai `Authorization: Basic base64(ServerKey + ":")` |
| `COMMERCE_MIDTRANS_IS_PRODUCTION` | `false` | Memilih base URL Snap/status API (sandbox vs production) saat override di bawah tidak diset |
| `COMMERCE_MIDTRANS_SNAP_BASE_URL` | `https://app.sandbox.midtrans.com` (sandbox) / `https://app.midtrans.com` (production) | Override hanya untuk tes/dev — jangan pernah dari input request |
| `COMMERCE_MIDTRANS_STATUS_BASE_URL` | `https://api.sandbox.midtrans.com` (sandbox) / `https://api.midtrans.com` (production) | Override hanya untuk tes/dev — jangan pernah dari input request |
| `COMMERCE_MIDTRANS_TIMEOUT_MS` | `15000` | Timeout per panggilan (`withTimeout`) untuk `createSession` maupun `fetchStatus` |
| `COMMERCE_WEBHOOK_RATE_LIMIT_MAX` / `_WINDOW_SEC` | 120 / 60 | Issue #113 — rate limit per-IP pada `POST /api/v1/commerce/webhooks/{provider}/{endpointToken}`, bentuk shared-limiter yang sama yang dipakai setiap rute storefront |

**`COMMERCE_STOREFRONT_PUBLIC_URL` (sudah didokumentasikan di atas untuk tautan referral afiliasi) juga membangun `redirectUrl` milik provider payment-gateway `log` (`"${COMMERCE_STOREFRONT_PUBLIC_URL}/pesanan?kode=...&gateway=log"`) dan, saat diset, URL `callbacks.finish` milik adapter Midtrans.**

**Job terjadwal — `commerce:payments:reconcile` (issue #113).** Jalankan `bun run commerce:payments:reconcile` tiap 1-2 menit lewat cron/systemd timer, dengan cara yang sama seperti `commerce:orders:expire`/`commerce:whatsapp:dispatch` (descriptor `jobs` milik `commerce/module.ts` sendiri menyebut jadwal yang direkomendasikan untuk setiap job di modul ini, termasuk yang ini). Job ini membaca variabel `COMMERCE_PAYMENT_GATEWAY`/`COMMERCE_MIDTRANS_*` yang sama di atas dan merupakan no-op bersih saat tidak ada provider yang dikonfigurasi.

**`COMMERCE_WHATSAPP_ENABLED`/`COMMERCE_WHATSAPP_PROVIDER` adalah gerbang deployment sejenis untuk login WhatsApp (issue #108, kontrak #106 D5).** `POST account/otp/request` dengan `via: "whatsapp"` menjawab `409 CHANNEL_UNAVAILABLE` sampai `COMMERCE_WHATSAPP_ENABLED=true`; kode kemudian pergi ke adapter `log` (dev/CI) kecuali `COMMERCE_WHATSAPP_PROVIDER` juga menyebut provider nyata (`fonnte` atau `meta`, masing-masing dengan variabel kredensial sendiri di bawah). WhatsApp adalah kanal login-saja untuk akun yang sudah ada — pendaftaran tidak terpengaruh dan tetap hanya OTP e-mail.

| Variabel | Default | Tujuan |
| --- | --- | --- |
| `COMMERCE_WHATSAPP_ENABLED` | `false` | Menggerbangi baik klaim di `commerce:whatsapp:dispatch` maupun apakah `via: "whatsapp"` tersedia sama sekali di `otp/request` |
| `COMMERCE_WHATSAPP_PROVIDER` | tidak diset (`log` saat `COMMERCE_WHATSAPP_ENABLED=false`) | `fonnte`, `meta`, atau `log` (aman untuk lokal/dev, tanpa jaringan) |
| `COMMERCE_FONNTE_TOKEN` / `COMMERCE_FONNTE_API_BASE_URL` | tidak diset / `https://api.fonnte.com` | Kredensial/base URL adapter Fonnte |
| `COMMERCE_META_WA_TOKEN` / `COMMERCE_META_WA_PHONE_NUMBER_ID` / `COMMERCE_META_WA_OTP_TEMPLATE` / `COMMERCE_META_WA_API_BASE_URL` | semua tidak diset / `https://graph.facebook.com/v20.0` | Adapter Meta WhatsApp Cloud API — `COMMERCE_META_WA_OTP_TEMPLATE` menyebut nama templat yang sudah disetujui operator yang dibutuhkan Meta untuk pesan templat (OTP) |

Variabel storefront `PUBLIC_*` tidak berubah oleh increment 4 — sesi bearer hidup sepenuhnya di `localStorage` browser sendiri, sehingga tidak ada env var build-time atau runtime baru yang dibutuhkan di sisi `apps/storefront` untuk akun atau afiliasi.

## Apa yang boleh menjangkau `apps/cms`: proses build, dan — sejak issue #30 — browser pembaca

| | Boleh menjangkau |
| --- | --- |
| Proses build (`astro build`) | API publik `apps/cms`, lewat HTTPS, dengan token build read-only |
| Container yang berjalan (`bun dist/server/penyaji.mjs`) | Tidak ada apa pun di luar dirinya sendiri — tidak ada `apps/cms`, tidak ada basis data, tidak ada panggilan jaringan eksternal jenis apa pun. Ini tidak berubah sejak increment 1 |
| Browser pembaca sendiri | API anonim `apps/cms` `/api/v1/commerce/storefront/*`, di `PUBLIC_AWCMS_ORIGIN`, `mode: "cors"` / `credentials: "omit"` — tidak ada cookie, tidak ada bearer token, tidak pernah; dan, sejak issue #56, `POST /api/v1/analytics/collect` di origin yang sama, kali ini `credentials: "include"` (cookie kunci-pengunjung anonim, `httpOnly`, milik modul itu sendiri — lihat di bawah) |

CSP milik `apps/storefront/server/penyaji.mjs` sendiri kini diturunkan, bukan dikonfigurasi tangan — `img-src` dan `connect-src` membawa persis origin yang benar-benar dirujuk suatu build tertentu (gambar produk/media, dan `PUBLIC_AWCMS_ORIGIN`), divalidasi ulang saat server startup dan jatuh kembali ke `'self'`-saja pada artefak yang hilang/malformed mana pun; lihat [`docs/arsitektur.md`](arsitektur.id.md) untuk mekanisme lengkapnya. Setiap direktif CSP lain tetap `'self'`/`'none'` — tidak ada skrip atau embed pihak-ketiga yang diizinkan aplikasi ini, kecuali (issue #56) dua origin milik GA4 sendiri, dan hanya ketika `PUBLIC_GA_ID` dikonfigurasi — lihat "Dua sakelar" tepat di bawah ini.

## Analitik pengunjung: dua sakelar (issue #56)

`apps/storefront` selalu memasang beacon pengunjung first-party miliknya
sendiri (`apps/storefront/src/scripts/analitik.ts`, bagian "Visitor analytics and the
optional GA4 switch" di `apps/storefront/README.md`) di setiap halaman. Apakah
beacon itu benar-benar melakukan sesuatu yang teramati adalah dua sakelar
independen, di dua sisi berbeda repositori ini, dan seorang deployer yang
hanya menyetel satu akan mendapati kondisi setengah-jalan yang nyata namun
mudah terlewat:

1. **`VISITOR_ANALYTICS_ENABLED` milik `apps/cms`** (`apps/cms/.env.example`,
   `apps/cms/src/modules/visitor-analytics/README.md`) — mati secara default.
   Beacon storefront tetap terpicu apa pun keadaannya
   (`POST /api/v1/analytics/collect` selalu menjawab `202`, memang demikian
   desainnya — lihat docblock route itu sendiri), tetapi dengan sakelar ini
   mati, tidak ada yang dicatat: tidak ada session, tidak ada event, tidak
   ada rollup untuk dibaca bagian "Terpopuler" A3. Menyalakan sakelar
   teknis ini bukanlah keputusan basis-hukum/persetujuan yang disyaratkan UU
   PDP itu sendiri — lihat bagian "Privacy posture" modul tersebut.
2. **`PUBLIC_GA_ID` milik `apps/storefront`** (`apps/storefront/.env.example`)
   — tidak diset secara default. Murni aditif dan independen dari sakelar 1:
   GA4 adalah produk analitik Google sendiri yang terpisah, sehingga suatu
   deployment bisa menjalankan beacon first-party saja, GA4 saja (dengan
   hanya menyetel variabel ini — beacon tetap terpicu apa pun keadaannya, ia
   hanya tidak mencatat apa pun tanpa sakelar 1), atau keduanya bersamaan.

Tidak satu pun sakelar diwajibkan agar build berhasil; keduanya default ke
"mati", yang merupakan keadaan deployment baru repositori ini apa adanya.

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

# One-off, only for a database that ran `db:migrate` against the `commerce`
# module's OLD sql/153-sql/168 file names (issue #72, ADR-0015): before its
# NEXT db:migrate, run
#   cd apps/cms && DATABASE_URL=<url> bun run db:commerce:renumber
# once. It updates the sixteen already-applied rows' recorded names/checksums
# to the new sql/901-sql/916 names; a fresh database (this one) needs it not
# at all, since it applies the new file names directly.

# db:migrate:cms kini juga menerapkan sql/917-sql/923 (increment 4, epic
# #32): skema akun/OTP/sesi pelanggan (917) plus grant purge worker-nya
# (918), seed template e-mail OTP turunan untuk tenant yang sudah ada (919),
# indeks unik parsial alamat-default-per-pelanggan (920), dan skema program
# afiliasi — termasuk orders.affiliate_id dan
# store_settings.affiliate_commission_rate (921), seed izinnya (922), serta
# grant purge worker-nya (923). Tidak ada yang dibutuhkan di luar langkah
# `db:migrate:cms` biasa di atas untuk menerapkan semua ini.

# Issue #57 — institusi "Daerah" pada taksonomi berita dan arsip
# /daerah/{slug} me-resolve kode/nama wilayahnya terhadap `idn_admin_regions`
# (ADR-0046), yang migrasinya hanya membuat SKEMA — baris wilayah
# sesungguhnya adalah langkah import + activate terpisah, perintah apps/cms
# sendiri (masih koneksi OWNER di atas; grant `awcms_worker` cukup, tapi
# koneksi owner yang sudah terbuka dari urutan ini juga bekerja):
cd apps/cms
DATABASE_URL=postgres://awcms:awcms_dev_password@localhost:5433/awcms \
  bun run idn-regions:import --commit          # mendarat `validated`, mencetak kode dataset
DATABASE_URL=postgres://awcms:awcms_dev_password@localhost:5433/awcms \
  bun run idn-regions:activate -- --dataset <kode yang dicetak di atas> --commit
cd ..

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
- Katalog 8 kategori dan satu produk per `type` commerce (physical/service/subscription/digital, yang terakhir placeholder sintetis yang ditandai jelas), dengan field paritas BjekMart lengkap (gambar, varian, size chart, service form) dari `tools/seed-data/contoh/borneojek-mart/*.json`.
- Permukaan marketing: satu flash sale dengan satu produk, dua voucher, tiga testimoni, satu popup, dan store settings.
- Segelintir term/halaman/post blog dan profil situs, termasuk enam tautan sosial dan satu nomor WhatsApp.
- Satu pelanggan dengan dua pesanan pada state berbeda (`pending_payment`, `paid`), dibuat lewat jalur pembuatan-pesanan anonim itu sendiri — bukan backdoor — sehingga seed sekaligus membuktikan jalur itu bekerja.
- Kredensial mesin baca-saja — `storefront-build (baca-saja)` — bercakupan setiap permission `read` yang dipakai build `apps/storefront` untuk mengambil data: pembacaan commerce (katalog, marketing, dan order/customer/review) plus, sejak issue #57, pembacaan permukaan berita (post/taksonomi/institusi/halaman/ad placement blog, redirect SEO, profil situs, `idn-regions`, dan media object — setiap key disalin dari blok `authorize` file route yang benar-benar dipanggil storefront; daftar persisnya adalah `MACHINE_CREDENTIAL_PERMISSION_KEYS` di skrip). Inilah kredensial yang harus dibawa `AWCMS_API_TOKEN` di atas. **Cakupan direkonsiliasi saat dijalankan ulang, bukan sekadar dicek berdasarkan nama:** permukaan machine-credential tidak punya verba "perlebar cakupan" (`apps/cms/src/pages/api/v1/access/machine-credentials/` hanya mengekspos create dan `{id}/revoke`), jadi ketika tenant yang di-seed sebelum cakupan ini bertambah masih memegang kredensial bernama sama yang `allowedPermissionKeys`-nya berbeda dari daftar skrip, skrip mencabutnya dan menerbitkan yang baru — mencetak token baru sekali dengan baris `ACTION REQUIRED`, karena token lama gagal pada request berikutnya dan setiap tempat yang membaca `AWCMS_API_TOKEN` harus diperbarui sebelum build berikutnya. Kredensial yang cakupannya sudah cocok dibiarkan apa adanya.
- **Issue #57** — taksonomi referensi milik IA berita sendiri, dimodelkan dari struktur nyata seputarborneo (`include/nav_menu.php`'s `seputarborneo_taksonomi()`, diverifikasi 2026-09-18): pohon `category` 8-rubrik (politik, hukum, nasional, olahraga, wisata, daerah, mitra-borneo, umum) dengan 5 anak tematik milik umum plus satu anak `wisata-travel` (tabrakan slug `Wisata`/`WISATA` milik seputarborneo sendiri diselesaikan dengan cara ini — `awcms_blog_terms_slug_dedup`, `apps/cms/sql/035_awcms_blog_content_schema.sql`, unik pada `(tenant_id, taxonomy_type, slug)` tanpa komponen `parent_id`, sehingga satu pohon tidak bisa menampung dua slug `wisata`); direktori 27-institusi legislatif/eksekutif (`POST /api/v1/blog/institutions`) — daftar 24-kanal Mitra Borneo milik seputarborneo sendiri (`seputarborneo_nav_mitra()`) plus satu `Pemkab` telanjang untuk masing-masing 3 kabupaten yang tidak masuk daftar itu (Kotawaringin Barat, Sukamara, Barito Selatan), ditambahkan supaya seluruh 14 kabupaten/kota Kalteng — bukan hanya 11 yang kebetulan disebut daftar situs referensi — punya minimal satu institusi pembawa `regionCode`-nya, karena keanggotaan wilayah hanya lewat institusi (lihat temuan di bawah); setiap `regionCode`-nya di-resolve lewat NAMA terhadap `GET /api/v1/idn-regions/regions` pada saat seed (tidak pernah hard-code — inilah mengapa langkah `idn-regions:import`/`idn-regions:activate` di atas kini bagian dari urutan ini); 44 sample post berita — minimal dua per rubrik (8 rubrik utama DAN 6 anak umum, sehingga tidak ada arsip `/rubrik/*` yang kosong), dan setiap dari 27 institusi punya minimal satu post yang diarsipkan kepadanya lewat `institutionIds`, yang (karena keanggotaan wilayah hanya lewat institusi, lihat temuan di bawah) membuat seluruh 14 arsip `/daerah/*` dan 27 arsip `/mitra/*` ter-render dengan konten alih-alih empty state; isinya placeholder generik yang ditandai jelas (tanpa orang atau peristiwa nyata), tiga di antaranya membawa node Portable Text `videoNews` dengan id YouTube placeholder yang ditandai jelas, karena tidak ada id kanal seputarborneo nyata yang bisa diverifikasi; tiga halaman legal tambahan (`redaksi` — placeholder generik, SENGAJA bukan data perusahaan/personel seputarborneo sendiri; `pedoman-media-siber` — teks publik Dewan Pers, diporting; `disclaimer` — digenerikkan untuk tenant ini); dan 5 sample redirect ber-origin `legacy_blog` (`/news/{id}-{slug}.html` → bentuk `/blog/borneojek-mart/{slug}` milik CMS ini sendiri) yang menjalankan jalur legacy-redirect berbasis-baris `docs/routing.md`. **Ad placement adalah satu-satunya bagian dari langkah ini yang tidak membuat apa pun di deployment lokal/CI ini** — lihat "Apa yang masih TIDAK di-seed skrip ini, dan mengapa" di bawah.

**Sebuah temuan yang ternyata memengaruhi setiap halaman/post yang pernah di-seed skrip ini, bukan hanya milik issue #57 sendiri** — `createBlogPage`/`createBlogPost` selalu menulis `status: 'draft'`, dan sampai issue #57 tidak ada apa pun di skrip ini yang pernah mentransisikan keduanya melewati itu, sehingga `kebijakan-privasi`/`tos` dan 3 post BjekMart sendiri tidak pernah, dan akan tetap, tidak terlihat oleh build `apps/storefront` (predikat `blog/pages/public.ts` dan `getAllPosts()` milik `blog.ts` sama-sama mensyaratkan `published`). Ditemukan saat memverifikasi kriteria penerimaan issue #57 sendiri "me-render `/halaman/redaksi`"/"me-render `/berita`" terhadap CMS lokal yang BENAR-BENAR di-seed, bukan stub (yang fixture-nya data kalengan yang sudah published dan tidak pernah menjalankan jalur ini). Diperbaiki untuk setiap halaman/post yang dibuat skrip ini, ke depan maupun saat dijalankan ulang terhadap tenant yang sudah di-seed.

Ia mencetak password owner dan token kredensial mesin persis sekali, pada run yang membuatnya (atau, untuk token, pada run yang merotasinya — lihat butir kredensial di atas) — tidak ada yang disimpan skrip ini di mana pun.

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

**Ad placement (issue #57) adalah satu-satunya resource yang sama sekali tidak bisa dibuat skrip ini secara lokal**, dan ini celah yang lebih berat dari SVG-placeholder di atas: tidak seperti gambar produk, `mediaObjectId` pada `POST /api/v1/news-portal/ad-placements` WAJIB diisi dan diperiksa keberadaan/statusnya terhadap `awcms_news_media_objects` (`ad-placement-reference-validation.ts`) — hanya media object berstatus `verified`/`attached` yang memenuhinya, dan mencapai `verified` butuh `finalizeNewsMediaUploadSession` melakukan `GET` R2 sungguhan + checksum, yang butuh `NEWS_MEDIA_R2_*` dikonfigurasi. Stack compose lokal/CI repositori ini hanya menyediakan PostgreSQL, tidak ada penyimpanan objek kompatibel-R2/S3. `tools/seed-data/contoh/borneojek-mart/ad-placements.json` dan empat PNG placeholder berukuran-benar di bawah `tools/seed-assets/` (`ad-728x90.png`/`ad-970x250.png`/`ad-300x250.png`/`ad-300x600.png`) ada supaya langkah `ensureAdPlacements` skrip seed benar-benar membuat ke-12nya begitu satu deployment SUDAH mengonfigurasi `NEWS_MEDIA_R2_*` (`sidebar_middle` memakai kreatif 300x600 — slot `kiri-tengah` seputarborneo adalah unit half-page — dua slot sidebar lainnya 300x250). Secara lokal ia mencetak satu baris skip yang menjelaskan, menghitung placement yang benar-benar belum diterapkan, alih-alih 12 kegagalan, dan tidak membuat apa pun. **Degradasi itu dicadangkan untuk persis satu penolakan:** `502 PROVIDER_ERROR` dari route create-session ("News media R2 storage is not configured for this deployment", `apps/cms/src/pages/api/v1/media/news-images/upload-sessions/index.ts`), satu-satunya sinyal bahwa deployment sama sekali tidak punya R2. Kegagalan media lain apa pun — penolakan mime/ukuran `400`, `403` pada PUT presigned, `422` atau `502` transien dari finalize, galat jaringan, `POST .../ad-placements` yang ditolak — adalah kegagalan nyata run itu atau aset-asetnya, dilaporkan per placement, dan membuat seed keluar non-nol; tidak pernah ditelan sebagai "tidak ada R2 di sini".

## Mengimpor seputarborneo (issue #58)

`tools/import-seputarborneo.ts` (`bun run import:seputarborneo`) adalah EXPORTER: ia membaca arsip MariaDB lama seputarborneo.com dan menulis berkas input yang dibutuhkan pipeline operator milik `apps/cms` sendiri untuk pekerjaan persis ini — `bun run blog:legacy:import` (`apps/cms/scripts/blog-legacy-import.ts`, Issue #599/ADR-0114 in upstream awcms). Ia tidak pernah melakukan panggilan jaringan dan tidak butuh `apps/cms` berjalan sama sekali; impor sesungguhnya berjalan DARI DALAM `apps/cms`, terhadap tenant `borneojek-mart` yang SAMA yang di-bootstrap [`tools/seed-borneojek-mart.ts`](#basis-data-lokal-issue-25).

**Dump tidak pernah disalin ke repositori ini, tidak pernah di-commit, dan tidak pernah dicetak ke console.** `tools/lib/mysql-dump-reader.ts` men-stream-nya — `Bun.file(...).stream()` lewat `DecompressionStream("gzip")` — satu baris sekaligus; arsip 228 MB (setelah dekompresi) tidak pernah ditahan utuh di memori, dan output console skrip ini hanya mencetak angka. Berkas yang ditulisnya di bawah `tools/out/seputarborneo/` (git-ignored) MEMANG membawa isi baris — itulah seluruh tujuannya, karena itu adalah format input `blog:legacy:import` sendiri — tapi tetap tinggal di mesin yang menjalankan export.

### Kenapa exporter, bukan klien API langsung

Versi awal tool ini memanggil `POST /api/v1/blog/posts` langsung. `blog:legacy:import` melakukan dua hal dengan benar yang tidak bisa dilakukan route publik mana pun: ia menerima `publishedAt` yang dipasok pemanggil untuk tanggal yang SUDAH LEWAT (dicek langsung — tidak ada route `blog/posts/*` yang bisa), dan ia menulis `legacy_source_id`/`legacy_source_system` (`sql/138`) sehingga run ulang idempoten lewat provenance, bukan tebakan dari slug. Ia juga mengonversi `bodyHtml` ke Portable Text sendiri; exporter ini tidak menduplikasi converter itu — setiap nilai `bodyHtml` yang ditulisnya adalah HTML lawas apa adanya, jadi apa yang ditolak pipeline itu persis apa yang ada di arsip.

### Runbook

```bash
# .env: set SEPUTARBORNEO_DUMP ke path absolut dump yang sudah dikompresi gzip.
bun run import:seputarborneo                     # menulis tools/out/seputarborneo/*, tanpa panggilan jaringan
bun run import:seputarborneo -- --limit=200       # batasi baris berita_red, untuk run pertama
```

Lalu, dari `apps/cms` (terhadap tenant yang SUDAH di-seed dan SUDAH berjalan — `bun run db:seed:cms` dan seed taksonomi seputarborneo, [issue #57](https://github.com/ahliweb/awcms-one/issues/57), dulu):

```bash
cd apps/cms

# 1. Preview (default — tidak ada yang ditulis tanpa --commit):
bun run blog:legacy:import --file=../tools/out/seputarborneo/posts.ndjson \
  --tenant=<uuid> --author=<uuid> --system=seputarborneo

# 2. Daftar unggah — setiap foto utama foto_berita DAN <img> inline mana pun
#    yang ditolak converter (ini daftar KANONIK, dari penolakan converter
#    sendiri; exporter ini tidak memindai ulang HTML-nya sendiri, supaya
#    tidak ada scanner kedua yang menyimpang dari yang penolakannya
#    sungguh-sungguh berarti):
bun run blog:legacy:import --file=../tools/out/seputarborneo/posts.ndjson \
  --tenant=<uuid> --author=<uuid> --system=seputarborneo \
  --images=upload-set.json
# Unggah setiap berkas lewat /admin/media, lalu bangun media-map.json:
# { "<src>": "<media object uuid>" }

# 3. Term — bangun term-map.json dari tools/out/seputarborneo/term-map-hints.json
#    (panduan MILIK exporter ini sendiri: term mana dari 8 term teratas B1,
#    atau anak UMUM mana, milik tiap 45 nama kategori lawas) plus
#    GET /api/v1/blog/terms live — { "<nama kategori lawas>": "<term uuid>" }.

# 4. Commit:
bun run blog:legacy:import --file=../tools/out/seputarborneo/posts.ndjson \
  --tenant=<uuid> --author=<uuid> --system=seputarborneo \
  --media-map=media-map.json --term-map=term-map.json --commit

# 5. Ulangi 1-4 untuk videos.ndjson (tidak ada featuredImageSrc, jadi langkah
#    2 hanya penting bila isi deskripsi video punya <img>; tidak ada
#    categories yang di-export untuk video — lihat "Apa yang TIDAK
#    dibawa" di bawah).

# 6. Redirect — redirects.json MILIK exporter ini SENDIRI, BUKAN
#    blog:legacy:redirects:import (lihat "Kenapa exporter ini membangun
#    redirect sendiri" di bawah). ~51.000 entri terhadap route yang menerima
#    200 per panggilan all-or-nothing berarti loop ~256 panggilan, jadi
#    exporter yang menjalankannya (`tools/lib/redirect-push.ts`); ia memakai
#    ulang AWCMS_BASE_URL/SEED_OWNER_*:
cd ..   # kembali ke root repo
bun run import:seputarborneo -- --push-redirects            # DRY RUN seluruh berkas: setiap chunk diposting
                                                            # dengan dryRun: true, tidak ada yang ditulis;
                                                            # penolakan per-entri dicetak, exit 1 jika ada
bun run import:seputarborneo -- --push-redirects --commit   # impor sungguhan, chunk demi chunk, masing-masing
                                                            # dengan Idempotency-Key turunan isi chunk itu
#    Crash atau chunk gagal di tengah run aman diulang dengan perintah yang sama:
#    CMS memutar ulang setiap chunk yang sudah ter-commit dari rekaman
#    idempotensinya (kunci sama + body sama -> 200 yang tersimpan) dan hanya
#    mengimpor sisanya. Run commit TIDAK dry-run dulu persis karena alasan itu —
#    dry run segar atas chunk yang sudah ter-commit akan melaporkan setiap baris
#    sebagai CONFLICT dengan dirinya sendiri.
#    JANGAN export ulang di antara dry run dan commit: berkas yang berubah berarti
#    kunci chunk berubah, dan chunk pertama yang tumpang tindih dengan impor
#    sebelumnya gagal keras dengan CONFLICT alih-alih diputar ulang.

# 7. Instansi — blog:legacy:import tidak punya mekanisme untuk men-set
#    institutionIds (lihat di bawah). Pass susulan MILIK exporter ini
#    SENDIRI menutup celah itu, lewat API publik, dari root repo:
bun run import:seputarborneo -- --assign-institutions

# 8. Verifikasi (dari apps/cms, terhadap sitemap atau daftar URL):
cd apps/cms && bun run blog:legacy:cutover:verify --tenant=<uuid> --urls=<path>
```

### Apa yang masih TIDAK bisa dilakukan `blog:legacy:import` — dan susulan yang tetap dijaga repositori ini

0. **Baris redirect itu sendiri.** Tidak ada skrip upstream yang menulis `awcms_seo_redirects`; satu-satunya jalan masuk adalah `POST /api/v1/seo/redirects/import`, dibatasi `MAX_REDIRECT_IMPORT_ITEMS` (200) per panggilan all-or-nothing dan mewajibkan `Idempotency-Key` di setiap panggilan. `--push-redirects` (langkah 6) adalah loop itu — diverifikasi terhadap berkas route-nya sendiri (`apps/cms/src/pages/api/v1/seo/redirects/import.ts`): body `{ redirects, dryRun }`, header `idempotency-key`, `results[].{index, ok, code, normalizedSourcePath, errors}` per-item pada envelope 200 maupun 400 `IMPORT_VALIDATION_FAILED`. Sebelum panggilan apa pun ia juga menjalankan normalisasi sumber (pelucutan query) milik route itu sendiri atas SELURUH berkas dan menolak pada duplikat pertama, karena route hanya mendeteksi duplikat di dalam satu chunk — duplikat lintas-berkas kalau tidak baru muncul sebagai `CONFLICT` di chunk berikutnya, setelah chunk sebelumnya sudah ditulis.
1. **`institutionIds`.** `main()` milik `blog:legacy:import` sendiri memanggil `syncPostTermAssignments` setelah tiap insert — tidak pernah `syncPostInstitutionAssignments`, dicek langsung terhadap `apps/cms/scripts/blog-legacy-import.ts` dan `legacy-import-directory.ts`. Artikel `DAERAH`/`MITRA BORNEO` karenanya terimpor TANPA instansi, dan sebuah post hanya mencapai `/daerah/{slug}`/`/mitra/{slug}` lewat satu (header `apps/storefront/src/pages/daerah/[slug].astro` sendiri) — keduanya adalah acceptance criterion issue #58 sendiri. `bun run import:seputarborneo -- --assign-institutions` (langkah 7 di atas) menutup ini: ia membaca ulang dump, me-resolve instansi tiap artikel `DAERAH`/`MITRA BORNEO` lewat nama, lalu `PATCH` `institutionIds` pada post yang sudah terimpor (ditemukan lewat `slug` hasil export-nya sendiri — tidak ada route pencarian-lewat-slug di API publik, jadi ia melakukan paging seluruh daftar post sekali).
2. **Byline lawas.** `--author=<uuid>` adalah SATU nilai untuk seluruh run; `legacy-import-record.ts` sama sekali tidak punya field author/sidecar per-baris. Kolom `user`/`admin` lawas dibuang seluruhnya oleh pipeline ini — celah nyata dan tak terhindarkan dari memakai tool operator sesuai maksudnya, bukan sesuatu yang bisa dikarang-karang exporter ini dengan field baru.

### Kenapa exporter ini membangun `redirects.json` sendiri, bukan `blog:legacy:redirects:import`

Skrip sejawat itu menurunkan path sumbernya lewat templating `{legacyId}`/`{slug}` — dengan `{slug}` adalah slug post TERSIMPAN (`listLegacyRedirectMappings`, dicek langsung). Untuk ~84 grup bentrok / ~171 baris yang disebut komentar `blog-legacy-import.ts` sendiri (dua artikel lawas berbagi judul), slug tersimpan membawa akhiran `-{legacyId}` yang ditambahkan `newPostSlug` milik exporter ini sendiri — tapi URL current-style lawas yang SESUNGGUHNYA dibangun dari judul polos tanpa akhiran, jadi redirect ber-template skrip sejawat itu akan salah persis untuk baris-baris itu. `redirects.json` di sini dibangun langsung dari `title` mentah untuk kedua bentuk URL lawas (bentuk hari ini `/news/{id}-{slug}.html` dan bentuk pra-2.0 `/news/{id}_{judul_dengan_underscore}.html`, yang disebut terakhir SAMA SEKALI tidak bisa dihasilkan `blog:legacy:redirects:import` — template-nya tidak punya placeholder `{title}`), menyasar `/blog/{tenantCode}/{slug}` dengan slug tersimpan akhir yang SAMA yang ditulis `blog:legacy:import`. `blog:legacy:redirects:import`, `blog:legacy:rubrik-redirects` (yang memutar ulang peta level-kategori `apps/cms/data/seputarborneo-legacy/rubrik-redirects.json` yang SUDAH TER-COMMIT — aset upstream terpisah yang sudah ada duluan yang tidak disentuh exporter ini, dan BUKAN langkah runbook ini: "Mekanisme mana yang otoritatif untuk URL lawas tingkat kategori" di `docs/routing.md` menjelaskan kenapa modul berbasis aturan milik storefront mencakup URL-URL itu tanpa baris sama sekali), dan `blog:legacy:article-paths` (dibangun untuk cutover ber-edge-serve `ahliweb/awcms-astro`, dan secara eksplisit inert untuk `awcms_seo_redirects` — mekanisme milik repositori ini sendiri, sesuai `docs/routing.md`) tetap tersedia sebagai tool upstream; exporter ini sederhananya tidak membutuhkannya.

Dua keputusan bentuk di `redirects.json` ada semata karena cara CMS dan storefront mengonsumsi barisnya (ditemukan saat review PR #67):

- **`origin` adalah `legacy_blog`, bukan `import`.** `getLegacyRedirectRows()` milik `apps/storefront/src/lib/awcms/blog.ts` HANYA menyimpan baris `origin === "legacy_blog"` saat membangun `/index/pengalihan-legacy.json` (`docs/routing.md`, "Redirect lawas"); baris ber-origin `import` adalah aturan CMS yang sah tapi diam-diam tidak akan pernah dilayani storefront ini. `defaultOrigin: "import"` milik route impor hanya berlaku untuk body yang menghilangkan `origin`.
- **Sumber baris video adalah `/video/{id}-{slug}.html` sintetis tanpa query, bukan `/video/?video={id}-{slug}.html` yang sebenarnya.** CMS melucuti query string dari setiap sumber redirect saat menulis (`validateRedirectInput` → `normalizeRedirectPath` tanpa `keepQuery`), jadi URL sebenarnya dari ke-35 baris video akan tersimpan sebagai satu `/video` telanjang — chunk gagal dengan `DUPLICATE_IN_BATCH`, atau satu baris yang selamat me-redirect halaman daftar `/video` storefront ke satu post. Storefront menjawab URL masuk `?video={id}` yang sebenarnya berdasarkan id dari kunci sintetis itu (`docs/routing.md`, bagian yang sama). Satu kunci per video sudah cukup: aturan saat request mencocokkan berdasarkan id saja, jadi kunci kedua berpemisah garis bawah hanya akan jadi beban mati.

### Apa yang SAMA SEKALI TIDAK dibawa

- **Byline lawas** (lihat di atas).
- **Pemutar video ter-embed.** `berita_vid` tidak punya field content-block di `legacy-import-record.ts` — hanya `bodyHtml`. `videos.ndjson` menambahkan link polos `<a href="https://youtu.be/{id}">` setelah teks deskripsi video, bukan blok `videoNews` ter-embed; converter menerima link (tidak seperti `<iframe>`, yang ditolaknya mentah-mentah), jadi video terimpor sebagai artikel dengan link untuk menontonnya, bukan pemutar.
- **Penempatan iklan** (`ikl_online`) dan **logo instansi** (`logo`, untuk `logo_media_id` [issue #59](https://github.com/ahliweb/awcms-one/issues/59)) — exporter ini hanya membaca jumlah barisnya untuk ringkasan; membuat penempatan butuh `mediaObjectId` terverifikasi (`POST /api/v1/news-portal/ad-placements`), dan `awcms_blog_institutions.logo_media_id` belum ada di `apps/cms` repositori ini.
- **Run produksi penuh** (seluruh ~25.490 baris `berita_red`, setiap video) sengaja ditunda melewati PR issue #58 sendiri — manager menjalankannya setelah issue #57 merge.

### `newsletter_subscribers`, dan semua yang lain yang tidak pernah dibaca exporter ini

`newsletter_subscribers` dihitung dan dilaporkan, tidak pernah diimpor — tidak ada catatan persetujuan yang bertahan dari formulir pendaftaran lawas. `users`, `counter`, `renungan_rmd`, `tanya_jawab`, dan `foto_berita` (tabel galeri) sama sekali tidak pernah dibaca — lihat tabel pemetaan `docs/kamus-data.md` untuk alasan masing-masing dikecualikan.

## Topologi produksi (issue #150, ADR-0019)

`apps/cms` hanya-PostgreSQL, dan sampai bagian ini ditulis, infrastruktur produksi borneojek sendiri menjalankan MySQL tanpa PostgreSQL yang disediakan di mana pun di atasnya — celah pengiriman yang disebutkan langsung oleh [issue #150](https://github.com/ahliweb/awcms-one/issues/150). Berikut adalah jalur produksi nyata dan teruji yang sekarang dikirim repositori ini; [ADR-0019](adr/0019-production-topology-two-images-a-jobs-sidecar-and-a-fail-closed-preflight.md) mencatat keputusan di baliknya. Container `postgres:18.4` milik `compose.yaml` sendiri tetap kenyamanan LOKAL/CI — `compose.production.yaml` (di bawah) adalah bentuk produksinya, dan keduanya tidak pernah dimaksudkan berbagi basis data.

### Model basis data dua-peran

Tiga identitas berbeda, tidak pernah dicampur (ADR-0019 D2):

- **`awcms_setup`** (atau superuser Postgres) — koneksi pemilik migrasi. Dipakai hanya untuk menjalankan migrasi, tidak pernah dibiarkan tetap berjalan.
- **`awcms_app`** — peran runtime `apps/cms` sendiri yang berhak-minimum (`sql/019`). `DATABASE_URL` servis `cms` harus mengarah ke peran ini.
- **`awcms_worker`** — peran job latar belakang (`sql/022`). `DATABASE_URL` servis `jobs` harus mengarah ke peran ini.

`docker/postgres-init/01-create-least-privilege-roles.sh` (sudah dipakai `compose.yaml` lokal/CI) mengaktifkan `LOGIN` dan password nyata untuk ketiganya pertama kali volume `postgres` kosong.

### Image

- **`apps/cms`** — `apps/cms/Dockerfile.production` (sudah ada sebelumnya, upstream, tidak diubah) membangun target `runtime` (hanya `dist/`, peran berhak-minimum, tanpa scripts) dan target `jobs` (source penuh, sehingga 30+ target job terdaftarnya benar-benar bisa berjalan).
- **`apps/storefront`** — `apps/storefront/Dockerfile` (baru). Multi-stage: stage build yang menjalankan `bun run build` dari konteks ROOT REPO (build aplikasi ini butuh kontrak type-only `packages/kontrak`, yang sendiri mengimpor dari source `apps/cms`) dengan `SITE_PROFILE`/`SITE_URL`/`AWCMS_API_URL`/`PUBLIC_AWCMS_ORIGIN`/`PUBLIC_GA_ID` sebagai build ARG, dan `AWCMS_API_TOKEN` HANYA lewat BuildKit `--mount=type=secret,id=awcms_api_token` — tidak pernah ARG/ENV, sehingga tidak pernah masuk layer image (ADR-0019 D4); stage runtime yang hanya membawa `dist/` dan menjalankan `bun dist/server/penyaji.mjs` sebagai user non-root `bun` milik image itu sendiri. **Setiap `SITE_PROFILE` adalah image-nya sendiri** — bangun `toko`, `berita`, dan `landing` terpisah bila lebih dari satu deployment berbagi repositori ini.

```bash
DOCKER_BUILDKIT=1 docker build \
  -f apps/storefront/Dockerfile \
  --build-arg SITE_PROFILE=toko \
  --build-arg SITE_URL=https://shop.example.test \
  --build-arg AWCMS_API_URL=https://cms.example.test \
  --build-arg PUBLIC_AWCMS_ORIGIN=https://cms.example.test \
  --secret id=awcms_api_token,env=AWCMS_API_TOKEN \
  -t awcms-one-storefront:toko .
```

Image `runtime`/`jobs` milik `apps/cms` sendiri di atas, sejak issue #187, juga dibangun dan dipublikasikan ke GHCR — sejak issue #225 (ADR-0023), dari server rilis terpercaya alih-alih CI, lihat "Image yang dipublikasikan" tepat di bawah ini. Image `apps/storefront` sengaja tidak — ia tetap `docker build` manual di host deploy, dengan alasan yang dijelaskan di sana.

### Image yang dipublikasikan (issue #187, ADR-0020; issue #225/ADR-0023 memindahkan ini keluar dari GitHub Actions)

`bun run release:images -- --publish --tag vX.Y.Z` (`tools/release/images.ts`, dijalankan dengan tangan dari server rilis terpercaya — sebelumnya `.github/workflows/images.yml`, dipicu push tag `v*` atau `workflow_dispatch`) membangun target `runtime` dan `jobs` milik `apps/cms/Dockerfile.production` — berkas yang sama, tanpa perubahan, yang sudah dijelaskan judul "Image" di atas — dan mempublikasikan keduanya ke:

- `ghcr.io/<owner>/<repo>-cms` — target `runtime`, yaitu servis `cms`.
- `ghcr.io/<owner>/<repo>-cms-jobs` — target `jobs`, yaitu servis `jobs`/`migrate`.

(`<owner>/<repo>` adalah path GitHub repositori ini sendiri, di-lower-case, dibaca dari `git remote get-url origin` kecuali `--owner`/`--repo` diberikan — sehingga repositori turunan-template mempublikasikan ke namespace-nya sendiri tanpa apa pun yang perlu diedit — untuk `ahliweb/awcms-one` itu adalah `ghcr.io/ahliweb/awcms-one-cms` dan `ghcr.io/ahliweb/awcms-one-cms-jobs`.) Setiap push membawa tiga tag — semver yang dirilis (`vX.Y.Z` → `X.Y.Z`), garis `X.Y`, dan `sha` commit yang membangunnya — plus SBOM (diekspor ke direktori evidence run itu dan, dengan flag `--evidence` milik `release:publish`, dilekatkan ke GitHub Release), menandatangani setiap digest yang di-push dengan `cosign` (`COSIGN_KEY`), memverifikasi tanda tangannya, dan memindai kerentanan dengan trivy. Lihat [ADR-0023](adr/0023-release-images-are-built-signed-and-published-from-a-trusted-release-host.id.md) untuk model kepercayaan penggantinya dan [`docs/rilis.md`](rilis.id.md) untuk urutan command lengkap dan environment yang dibutuhkan. Tanpa `--publish`, command yang sama hanya membangun — tidak pernah login, tidak pernah push, tidak pernah menandatangani — inilah mode PR/verifikasi yang tidak perlu dijalankan `bun run ci`/`ci:pr` milik repo ini sendiri, karena ia tidak membangun image apa pun sendiri.

**Menarik image yang dipublikasikan alih-alih membangun lokal** — set dua env var yang kini dibaca servis `cms`/`jobs`/`migrate` milik `compose.production.yaml` (ADR-0020 D4; keduanya default ke nama build-lokal hari ini, jadi membiarkannya unset tidak mengubah apa pun dari perilaku berkas ini yang sudah ada):

```bash
export AWCMS_ONE_CMS_IMAGE=ghcr.io/ahliweb/awcms-one-cms:0.11.0
export AWCMS_ONE_CMS_JOBS_IMAGE=ghcr.io/ahliweb/awcms-one-cms-jobs:0.11.0
docker compose -f compose.production.yaml pull cms
docker compose -f compose.production.yaml --profile jobs pull jobs
docker compose -f compose.production.yaml --profile migrate pull migrate
docker compose -f compose.production.yaml up -d cms
```

**Memverifikasi tanda tangan/atestasi image yang ditarik** — lihat "Verifying a published image" milik [`docs/rilis.md`](rilis.id.md): `cosign verify --key <published-cosign-public-key>` untuk apa pun yang dipublikasikan setelah ADR-0023, dan `gh attestation verify oci://ghcr.io/<owner>/<repo>-cms:<tag> --owner <owner>` yang lama untuk image yang dipublikasikan sebelumnya (atestasi yang diterbitkan GitHub itu masih sah dan masih bisa diverifikasi — hanya cara image BARU mendapat atestasinya yang berubah). `PASS` dari salah satu keduanya menyebutkan persis commit/digest tempat image itu dibangun — jaminan yang sama yang sudah diasumsikan catatan "Rollback/cutover" dokumen ini sendiri ("setiap image ditandai commit/rilis tempat ia dibangun"), kini bisa diperiksa independen, tidak hanya dinyatakan. **SBOM** diekspor ke direktori evidence milik `tools/release/images.ts` sendiri dan, dengan `release:publish --evidence`, dilekatkan ke GitHub Release sebagai asset.

**Visibilitas package GHCR** — push pertama ke package baru (`ahliweb/awcms-one-cms`, `ahliweb/awcms-one-cms-jobs`) bisa membuatnya sebagai **privat**, default GHCR sendiri untuk package tanpa pengaturan visibilitas sebelumnya. Package privat butuh kredensial tariknya sendiri (`docker login ghcr.io` dengan token yang membawa `read:packages`) bahkan untuk host deploy yang tidak disebutkan berkas mana pun milik repositori ini rahasianya; pemilik repositori membuat sebuah package publik dari pengaturan GitHub milik package itu sendiri ("Package settings" → "Change visibility") sekali, setelah itu `docker pull` anonim berfungsi. Tidak ada apa pun di `tools/release/images.ts` yang mengeset visibilitas sendiri — GHCR mengikat visibilitas pada aksi manual pemilik, bukan pada apa pun yang bisa diminta sendiri oleh sebuah run server-rilis.

**Kenapa `apps/storefront` tidak dipublikasikan** — lihat [ADR-0020](adr/0020-publish-only-the-cms-images-to-ghcr-with-sbom-and-provenance.md) D2: build-nya memanggang konten katalog/berita live satu tenant memakai token owner CMS sebagai BuildKit secret, sehingga mempublikasikannya berarti kredensial produksi itu hidup di tempat otomasi CI/rilis menjangkaunya, dan tag yang dipublikasikan diam-diam menjadi basi begitu konten berubah tanpa image baru yang sepadan. Ia tetap dibangun di host deploy, persis seperti yang dijelaskan bagian "Image" di atas. `bun run release:images -- --storefront-smoke` (sebelumnya job `storefront-smoke` milik `.github/workflows/images.yml`) hanya membuktikan `apps/storefront/Dockerfile` masih bisa dibangun — dimatriks atas ketiga nilai `SITE_PROFILE`, terhadap stub CMS repositori ini sendiri (`apps/storefront/scripts/stub-awcms.mjs`) — dan tidak pernah mempublikasikan hasilnya.

### `compose.production.yaml`

Topologi reproducible untuk deployment self-hosted: `postgres` (tanpa port host dipublikasikan secara default — lihat komentar file itu sendiri untuk memakai instans terkelola/eksternal sebagai gantinya), `migrate` (sekali-jalan, `--profile migrate`, satu-satunya servis yang memakai DSN pemilik/setup), `cms` (image runtime, DSN `awcms_app`), `jobs` (image jobs, DSN `awcms_worker`, dijaga di balik `--profile jobs`, dipanggil terjadwal alih-alih dibiarkan berjalan — lihat "Job terjadwal" di bawah), dan `storefront` (dibangun dengan secret BuildKit di atas). Tidak ada servis yang mempublikasikan port host untuk `cms`/`storefront` secara default — pasang reverse proxy di depan dan biarkan ia menerminasi TLS. Setiap kredensial dibaca dari file turunan `apps/cms/.env.example` dan turunan root `.env.example` yang tidak pernah di-commit; `tests/compose-produksi.test.mjs` secara mekanis memeriksa file itu untuk rahasia yang terlihat hardcode, pemisahan peran `awcms_app`/`awcms_worker`, dan ketiadaan port host.

### Job terjadwal

`bun run jobs:crontab:generate` (di dalam `apps/cms`) sudah menggenerate `apps/cms/ops/awcms-jobs.crontab` dari registry job modul — satu-satunya sumber kebenaran tentang job mana yang ada dan kapan berjalan; `jobs:crontab:check` (bagian dari `bun run check`) gagal bila menyimpang. Variabel `AWCMS_RUN_JOB` file itu dirancang untuk `docker run` biasa terhadap image yang dipublikasikan (`apps/cms/ops/run-job.sh`); deployment docker-compose mengarahkannya ke `ops/run-job-compose.sh` sebagai gantinya (skrip baru milik repositori ini sendiri, ADR-0019 D3) — signature `<target> [args...]` yang sama, memanggil `docker compose -f compose.production.yaml --profile jobs run --rm jobs bun run <target>`. Pasang crontab yang SAMA yang sudah digenerate bagaimanapun caranya; hanya kontainer mana yang menjalankan setiap job yang berubah.

### Preflight produksi fail-closed

Dua perintah berlapis, tidak menggantikan `bun run config:validate`/`bun run security:readiness` milik `apps/cms` sendiri (tidak diubah):

```bash
# Di dalam apps/cms — pemeriksaan produksi spesifik modul commerce:
cd apps/cms && bun run commerce:deploy:preflight --live --production

# Dari root repo — bentuk env build storefront, lalu mendelegasikan ke atas:
bun run deploy:preflight --live --production
```

Setiap pemeriksaan mencetak satu baris `PASS|FAIL|SKIP` dan alasannya, tidak pernah nilai rahasia. Ini ditegakkan secara struktural, bukan sekadar konvensi (issue #205): satu helper `redact()` menyamarkan kata sandi DSN `postgres://user:pass@host`, nilai berbentuk bearer/API-token, dan seluruh nilai variabel env mana pun yang NAMA-nya cocok `/(PASSWORD|SECRET|TOKEN|KEY|DSN|DATABASE_URL)/i`, dan setiap baris yang dicetak — banner saat mulai, tiap baris `PASS|FAIL|SKIP`, dan ekor stderr/stdout tangkapan dari skrip yang didelegasikan (mis. `jobs:crontab:check`, `apps/cms/scripts/validate-env.ts`) — melewatinya lebih dulu sebelum sampai ke terminal. Nilai yang tidak berbahaya (nama provider, nama peran, URL polos) tercetak apa adanya tanpa perubahan; `apps/cms/tests/commerce-deploy-preflight.test.ts` mengunci baik redaksi maupun non-regresi itu. `--live` tambahan terhubung ke `DATABASE_URL` dan memverifikasi peran runtime bukan superuser/pemilik, tidak memiliki tabel `awcms_commerce_*` mana pun, setiap tabel semacam itu punya `relrowsecurity AND relforcerowsecurity`, dan buku besar migrasi tidak punya yang tertunda. Tanpa `--production`, aturan khusus-produksi (pengiriman OTP, provider pembayaran/pengiriman bukan `log`, URL kanonik https) di-skip alih-alih digagalkan — teruskan `--production` (atau set `APP_ENV=production`) untuk menerapkannya terhadap file yang sedang ditinjau sebelum disalin ke tempatnya (`--file <path>`).

### Tiga concern yang berbeda: pemeriksaan CI, publikasi artefak, deployment produksi (issue #224, ADR-0022)

Yang penting, secara persis, adalah mana dari ketiga hal ini yang sedang terjadi pada titik mana pun di jalur delivery platform ini — mencampuradukkannya di bawah satu deskripsi "Registry/CI-push" adalah persis ambiguitas yang ingin ditutup ADR-0022:

1. **Pemeriksaan CI** — dua belas leg `local-ci/*` milik `bun run ci` (`tools/ci/`, sebelumnya `.github/workflows/ci.yml`/`e2e.yml`/`codeql.yml`/`template-init-smoke.yml`, semua dihapus oleh issue #225/ADR-0021) melakukan lint, type-check, test, dan menjalankan analisis keamanan. Mereka tidak pernah menyentuh kredensial produksi dan tidak pernah memutasi apa pun yang berjalan.
2. **Publikasi artefak** — `bun run release:images -- --publish`/`release:publish` (`tools/release/`, ADR-0023, sebelumnya `.github/workflows/images.yml`/`release.yml`, "Image yang dipublikasikan" di atas) membangun dan mempublikasikan image `apps/cms` yang ditandatangani dan diatestasi ke GHCR beserta GitHub Release yang cocok, dijalankan dengan tangan dari server rilis terpercaya. Ini adalah engineering rilis: menghasilkan artefak imutabel yang dapat diverifikasi independen. Ia tetap tidak pernah men-deploy apa pun — tidak ada yang mengonsumsi image yang dipublikasikan sampai manusia atau agent secara eksplisit memberi tahu host produksi untuk melakukannya.
3. **Deployment produksi** — `tools/deploy/deploy-production.sh`, dijelaskan tepat di bawah. Ini adalah SATU-SATUNYA langkah dalam daftar ini yang memutasi sistem produksi yang berjalan, dan ia tidak pernah berjalan di dalam GitHub Actions — tidak ada eksekusi GitHub Actions sama sekali di repositori ini lagi (issue #225, ADR-0021): **tidak ada runner GitHub-hosted atau self-hosted yang menjadi bagian dari control plane produksi, dan tidak ada host produksi yang pernah didaftarkan sebagai self-hosted runner GitHub** — repositori ini publik, dan panduan resmi GitHub tegas bahwa self-hosted runner repositori publik terekspos ke eksekusi kode PR-fork dengan kredensial dan jangkauan jaringan milik runner itu sendiri.

### Deployment produksi (server-side, eksplisit) — `tools/deploy/deploy-production.sh` (issue #224, ADR-0022)

Entrypoint deployment kanonis dan satu-satunya, dijalankan HANYA di host produksi (atau host dengan repositori ini dan `compose.production.yaml` sudah di-checkout) — tidak pernah oleh GitHub Actions, tidak pernah dipicu otomatis oleh push atau merge:

```bash
tools/deploy/deploy-production.sh <tag-eksak|sha-40-karakter|image@sha256:digest>
# atau, dari laptop, lewat SSH ke host produksi, tanpa logika yang diduplikasi secara lokal:
tools/deploy/deploy-remote.sh <ssh-host> <tag-eksak|sha-40-karakter|image@sha256:digest>
```

Target yang diterima tepat tiga bentuk, dan tidak ada yang lain: tag rilis eksak (`vX.Y.Z`), SHA commit 40 karakter, atau referensi image GHCR yang dipin dengan digest (`ghcr.io/<owner>/<repo>-cms@sha256:<64 hex>`) — nama branch, SHA pendek, atau tag yang mengambang ditolak sebelum apa pun berjalan. **Image GHCR yang dipublikasikan (ADR-0020) diutamakan begitu ada satu untuk suatu rilis** — ia diatestasi independen, tidak butuh build ulang di host produksi, dan rollback ke digest sebelumnya instan; build sumber (tag/SHA) tetap didukung penuh dan menjadi satu-satunya pilihan sebelum image suatu rilis dipublikasikan, atau untuk deployment yang tidak pernah mempublikasikan image sama sekali.

Skrip menjalankan transaksi penuh di bawah `set -Eeuo pipefail` dan `flock` non-blocking (pemanggilan bersamaan langsung ditolak, tidak diantrekan):

```text
ambil lock -> resolusi target -> catat rilis saat ini
  -> fetch/verifikasi (git status --porcelain harus kosong; gagal closed pada checkout kotor)
  -> preflight (bun run deploy:preflight --live --production)
  -> backup pra-migrasi (docker compose --profile backup run --rm backup)
  -> build (target sumber) atau pull+verifikasi cosign opsional (target image)
  -> migrasi (docker compose --profile migrate run --rm migrate — identitas setup yang berhak-istimewa)
  -> verifikasi peran runtime adalah rolsuper=false AND rolbypassrls=false
  -> aktivasi (docker compose up -d cms storefront)
  -> health (tools/deploy/healthcheck-production.sh)
  -> smoke (GET /api/v1/health, GET /healthz)
  -> catatan audit append-only (timestamp, target, rilis sebelumnya, operator, hasil per-langkah)
  -> sukses
```

Target yang sudah di-deploy dan sehat adalah no-op sukses. Pada kegagalan setelah aktivasi, skrip mengembalikan runtime ke rilis sebelumnya yang tercatat secara otomatis HANYA ketika tidak ada migrasi yang diterapkan pada percobaan yang sama — diputuskan dengan membaca ledger migrasi `apps/cms` (`awcms_schema_migrations`) sebelum dan sesudah langkah migrate, dan jumlah yang tidak terbaca dihitung sebagai "diterapkan" (`tools/deploy/rollback-production.sh [<rilis-sebelumnya>]`, juga bisa dijalankan manual); ketika migrasi memang berjalan, ia berhenti dan mencetak jalur ke "Celah yang diketahui" dan runbook jaminan-backup di bawah alih-alih menebak bahwa rollback kode aman terhadap skema yang mungkin sudah berubah. Setiap baris yang dicetak tooling ini — dan log audit append-only di `${DEPLOY_STATE_DIR:-/var/lib/awcms-one-deploy}/audit.jsonl` — diredaksi lewat `packages/gerbang/lib/redact.mjs` (via `tools/deploy/redact-log.mjs`) sebelum mencapai terminal atau disk, disiplin yang sama yang ditetapkan issue #205 untuk preflight milik `apps/cms` sendiri. `tests/deploy-production.test.mjs` adalah suite skenario hermetis atas setiap jalur kegagalan yang disebutkan di atas — docker/git/curl/ssh/cosign semuanya stub di `PATH` (juga bisa dibind lewat `DOCKER=`/`GIT=`/`CURL=`/`SSH=`/`COSIGN=`, yang dibaca setiap skrip alih-alih nama perintah yang di-hardcode); tidak ada test yang pernah menyentuh kontainer nyata, remote git, atau endpoint jaringan.

Setiap variabel environment yang dibaca skrip-skrip ini (`DEPLOY_STATE_DIR`, `DEPLOY_SKIP_BACKUP`, `DEPLOY_COSIGN_VERIFY_COMMAND`, override perintah, URL smoke-check, `DEPLOY_REMOTE_SCRIPT_PATH`) didokumentasikan di bagian "Server-side production deployment" milik root `.env.example`.

**Setup host pertama kali** (sekali, sebelum deploy pertama):

1. Buat pengguna sistem `deploy` yang khusus alih-alih deploy sebagai root atau akun developer bersama; beri keanggotaan grup `docker` (atau akses Docker/Coolify berhak-istimewa-minimal yang setara) dan tidak lebih luas.
2. Hasilkan kredensial SSH berbasis kunci untuk pengguna itu. Opsional, batasi `~deploy/.ssh/authorized_keys` dengan forced command, sehingga kunci yang bocor hanya bisa menjalankan entrypoint deploy milik repositori ini sendiri:
   ```
   command="/home/deploy/awcms-one/tools/deploy/deploy-production.sh $SSH_ORIGINAL_COMMAND",no-port-forwarding,no-X11-forwarding,no-agent-forwarding ssh-ed25519 AAAA... operator@laptop
   ```
3. `mkdir -p /var/lib/awcms-one-deploy && chmod 700 /var/lib/awcms-one-deploy` (atau arahkan `DEPLOY_STATE_DIR` ke tempat lain) — lock, log audit, dan state rilis-saat-ini hidup di sini.
4. Buat `.secrets/` (sudah di-`.gitignore`kan) dengan file secret BuildKit/backup yang dijelaskan "Secrets" dan "Jaminan backup" di atas, dengan izin yang restriktif (`chmod 600`).
5. Sediakan PostgreSQL — baik servis `postgres` di `compose.production.yaml`, atau instans terkelola dengan tiga peran yang sama dibuat manual (lihat komentar file itu sendiri).
6. Jalankan deploy PERTAMA terhadap basis data yang genuinely baru dengan `DEPLOY_SKIP_BACKUP=true` (belum ada yang perlu dibackup), misalnya `DEPLOY_SKIP_BACKUP=true tools/deploy/deploy-production.sh v1.0.0` — setiap deploy berikutnya berjalan dengan default (backup ditegakkan).
7. Pasang `apps/cms/ops/awcms-jobs.crontab` di host, dengan `AWCMS_RUN_JOB` mengarah ke `ops/run-job-compose.sh` (lihat "Job terjadwal" di atas) — skrip deploy tidak memasang ini untuk Anda.
8. **Daftarkan origin nyata storefront** di `awcms_tenant_domains` — API storefront anonim me-resolve tenant-nya dari header `Origin` browser pemanggil (lihat "Origin storefront tenant yang di-seed harus terdaftar" di atas); deployment yang melewatkan langkah ini mendapat build yang berfungsi dan checkout yang tidak pernah me-resolve tenant.

**Deploy biasa**, setelah host disiapkan: `tools/deploy/deploy-production.sh v1.4.0` (atau digest GHCR yang setara). **Rollback**: `tools/deploy/rollback-production.sh` tanpa argumen mengembalikan ke apa pun yang terakhir dicatat `deploy-production.sh` sebagai rilis sebelumnya; berikan rilis eksplisit untuk rollback ke yang lain.

**Pemulihan basis data ketika rollback tidak kompatibel-skema** — ini adalah satu-satunya jalur yang secara sengaja tidak diotomatisasi `deploy-production.sh`/`rollback-production.sh`, karena menebak salah di sini bisa merusak data. Ketika percobaan deploy menjalankan migrasi lalu gagal (kegagalan health/aktivasi), baris audit skrip sendiri menyebutkan target dan backup pra-migrasi yang sudah diambil langkah itu: pulihkan backup itu dengan perintah manual dan terkonfirmasi `restore-postgres.sh --target=<db> --yes` yang didokumentasikan "Restore drill default ke isolated/disposable" di bawah, ke basis data scratch/staging dulu untuk mengonfirmasinya, lalu ikuti proses change-management organisasi Anda sendiri untuk memutuskan apakah memulihkan ke basis data produksi nyata atau forward-fix dengan migrasi baru sebagai gantinya (aturan `apps/cms/scripts/db-migrate.ts` sendiri: jangan pernah edit-tangan migrasi yang sudah diterapkan).

**Coolify** — jika Coolify adalah orkestrator yang dipilih sebagai pengganti (atau bersama) `docker compose` polos, matikan webhook auto-deploy push-GitHub-ke-produksi miliknya untuk jalur ini; token API/kredensial Coolify sendiri hanya hidup di host deployment, tidak pernah di secret GitHub Actions. Skrip yang memanggil API Coolify melakukannya dengan identitas rilis yang eksplisit dan sudah diresolusi, dan tetap menjalankan `healthcheck-production.sh`/pemeriksaan smoke milik repositori ini sendiri setelahnya alih-alih mempercayai sinyal "deployment berhasil" milik Coolify sebagai kata akhir.

### Mekanisme health/readiness dan rollback

`cms` mengekspos `GET /api/v1/health` (liveness — menjawab 200 bahkan dengan basis data tak terjangkau, sengaja; lihat komentar `apps/cms/Dockerfile.production` sendiri kenapa probe yang me-restart kontainer tidak boleh bergantung pada basis data) dan `GET /api/v1/database/pool/health` (pertanyaan kesehatan dependensi yang nyata, dibaca `apps/cms/ops/synthetic-check.sh` alih-alih orkestrator kontainer). `storefront` mengekspos `GET /healthz`, melaporkan build id yang ditulis `apps/storefront/scripts/write-build-id.mjs` saat waktu build. Setiap image ditandai dengan commit/rilis tempat ia dibangun; rollback adalah men-deploy ulang tag/digest sebelumnya, tidak pernah mengedit kontainer yang berjalan. Migrasi maju-saja dengan checksum immutable (`validateAppliedChecksums` milik `apps/cms/scripts/db-migrate.ts` menolak menerapkan ulang migrasi yang sudah diterapkan yang isinya berubah) — migrasi yang salah dikoreksi lewat migrasi BARU, tidak pernah edit-tangan yang sudah diterapkan.

**Backup/restore:** lihat "Jaminan backup" tepat di bawah — jalur terenkripsi, terautentikasi, tersalin off-site, dan teruji-drill yang kini dipakai topologi produksi repositori ini sendiri, memakai ulang `apps/cms/deploy/backup/*.sh` milik upstream lewat servis `backup`/`restore-drill`/`offsite-copy` milik `compose.production.yaml` sendiri — LANGKAH `backup` YANG SAMA yang dijalankan `deploy-production.sh` secara otomatis sebelum setiap migrasi. (`apps/cms/ops/backup-awcms.sh`/`restore-drill-awcms.sh` adalah pasangan skrip lain yang lebih lama, khusus-host, yang masih dibawa upstream untuk cron deployment lain — bukan yang dipasang topologi produksi repositori ini sendiri; jangan mencampuradukkan keduanya.)

## Jaminan backup (issue #213)

`apps/cms/deploy/backup/*.sh` (disinkronkan masuk oleh issue #210, tooling milik upstream sendiri — lihat [ADR-0123](https://github.com/ahliweb/awcms/blob/main/docs/adr/0123-backup-encryption-manifest-authentication.md) dan `README.md` milik direktori itu sendiri untuk apa yang dilakukan tiap skrip dan kenapa) dipakai di sini lewat topologi produksi REPOSITORI INI sendiri, bukan diimplementasikan ulang. `compose.production.yaml` menambah tiga servis ber-profile — `backup`, `restore-drill`, `offsite-copy` — masing-masing pembungkus tipis: kontainer dibangun dari `docker/backup/Dockerfile` (image `postgres:18.4` yang SAMA dengan yang dijalankan servis `postgres`, ditambah `age`/`rsync`/`openssh-client` — persis yang diminta catatan "Base images ship neither `age` nor a database client by default" milik `apps/cms/deploy/backup/README.md` sendiri) dengan `apps/cms/deploy/backup/` di-bind-mount read-only di `/scripts` dan skrip aslinya dipanggil tanpa modifikasi.

### Identitas basis data (butir cakupan 1)

`backup` dan `restore-drill` sama-sama terhubung memakai `SETUP_DATABASE_URL` — DSN pemilik-migrasi yang SAMA dengan yang sudah dipakai `migrate` di file ini, tidak pernah `awcms_app` (`cms`) atau `awcms_worker` (`jobs`). Dua alasan struktural: `pg_dump` harus membaca semua tabel, yang sengaja ditolak dari peran runtime berhak-istimewa-minimal (sql/019/021); dan mode drill `restore-postgres.sh` membuat lalu menghapus basis data scratch-nya sendiri, yang butuh `CREATEDB`. `offsite-copy` tidak butuh koneksi basis data sama sekali — ia hanya memindahkan berkas yang sudah ditulis.

### Secrets (butir cakupan 2)

Empat secret compose berbasis-berkas baru, mekanisme yang SAMA dengan yang sudah dipakai `awcms_api_token` milik `storefront` sendiri (di-mount read-only di `/run/secrets/<name>`, tidak pernah nilai `environment:`, tidak pernah lapisan image, tidak pernah muncul di output `docker inspect` sendiri):

| Secret | Variabel env yang menunjuk berkas host-nya | Berisi |
| --- | --- | --- |
| `backup_age_recipients` | `BACKUP_AGE_RECIPIENTS_FILE` | recipient publik `age` — aman di host backup |
| `backup_hmac_key` | `BACKUP_HMAC_KEY_FILE` | kunci HMAC-SHA256 — dibutuhkan di KEDUA host backup dan restore |
| `restore_age_identity` | `RESTORE_AGE_IDENTITY_FILE` | identitas PRIVAT `age` — HANYA host restore/drill, tidak pernah host backup |
| `offsite_ssh_key` | `OFFSITE_SSH_KEY_FILE` | kunci privat SSH off-site |

Buat keempatnya persis seperti yang didokumentasikan langkah 1 milik `apps/cms/deploy/backup/README.md` sendiri (`age-keygen`, `openssl rand`), di workstation, bukan host backup itu sendiri; lalu, mis.:

```bash
mkdir -p .secrets
age-keygen -o .secrets/restore-age-identity.key
grep '^# public key:' .secrets/restore-age-identity.key | sed 's/# public key: //' > .secrets/backup-age-recipients.txt
openssl rand -out .secrets/backup-hmac.key 32
cp <kunci privat ssh off-site Anda> .secrets/offsite-ssh-key
```

`.secrets/` sudah di-`.gitignore` (aturan yang sama yang dipakai `AWCMS_API_TOKEN_FILE`). Tak satu pun dari keempat berkas ini, atau nilai turunannya, pernah dicetak skrip mana pun di `apps/cms/deploy/backup/` — lihat tabel "Secrets — what goes where, and what never appears in a log" milik README direktori itu sendiri.

### Tempat artifact hidup, dan salinan off-site (butir cakupan 3-4)

Artifact terenkripsi, sidecar, manifest, dan log evidence restore-drill hidup di volume bernama `awcms-one-production-backups`, di-mount di `/backup` di ketiga servis. `offsite-copy` butuh `OFFSITE_SSH_TARGET` (`user@host:/absolute/path`) dan memakai algoritma pemilihan-artifact yang SAMA dengan yang sudah dipakai `restore-drill.sh` (lewat `docker/backup/select-and-offsite-copy.sh`, skrip perekat kecil milik repositori ini sendiri — bukan fork dari `offsite-copy.sh` itu sendiri, yang dipanggilnya tanpa modifikasi) untuk memilih backup terbaru yang eligible plus sidecar-nya. Transfer yang gagal setelah percobaan-ulang `offsite-copy.sh` sendiri keluar non-zero dan tidak pernah menghapus salinan lokal — backup yang hanya lokal tidak pernah dilaporkan sebagai salinan off-site yang berhasil (header `offsite-copy.sh` sendiri; diverifikasi dalam validasi issue ini dengan menghentikan target off-site di tengah jadwal).

### Retensi/rotasi (butir cakupan 5)

Retensi lokal adalah `BACKUP_RETENTION_DAYS` (default 14, `0` menonaktifkan), dibaca `backup-postgres.sh` sendiri. Retensi off-site adalah kebijakan apa pun yang diterapkan tujuan di `OFFSITE_SSH_TARGET` — `offsite-copy.sh` hanya menyalin, tidak pernah memangkas tujuan (header-nya sendiri). Keduanya kebijakan host/tujuan milik operator, bukan sesuatu yang dikelola tooling repositori ini.

### Invokasi terjadwal (butir cakupan 6)

`ops/run-backup-compose.sh <backup|restore-drill|offsite-copy>` adalah bentuk `ops/run-job-compose.sh` (issue #150) diterapkan ke tiga profile ini — `docker compose -f compose.production.yaml --profile <task> run --rm <task>`. `ops/awcms-one-backup.crontab` adalah manifest pasang-manual (konvensi yang sama dengan `apps/cms/deploy/cron/awcms.crontab`): backup tiap malam, salinan off-site tepat sesudahnya, restore drill mingguan.

### Observabilitas (butir cakupan 7)

Setiap skrip mencetak persis apa yang dilakukannya ke stdout/stderr — tidak ada yang ditelan — jadi crontab host yang mengarahkan ke berkas log (seperti yang dilakukan `ops/awcms-one-backup.crontab`) membuat sukses/gagal terlihat di log, dan exit non-zero dari `ops/run-backup-compose.sh` adalah yang dipakai mailer cron atau setup log-shipping/alerting eksternal. `restore-drill.sh` tambahan menambahkan satu baris JSON per run ke `${BACKUP_DIR}/restore-drill-evidence.jsonl` — timestamp, nama artifact, pass/fail, RTO/RPO terukur, tanpa secret atau isi basis data — aman dikirim ke agregasi log atau dilampirkan ke tiket change-management.

### Restore drill default ke isolated/disposable, secara struktural (butir cakupan 8, syarat keamanan)

`restore-drill` punya `command: ["bash", "/scripts/restore-drill.sh"]` yang di-hardcode di `compose.production.yaml` — tidak pernah `restore-postgres.sh` langsung, dan tidak pernah dengan `--target`. `restore-drill.sh` sendiri tidak punya jalur kode `--target` sama sekali (headernya sendiri menyatakan ini), dan mode drill `restore-postgres.sh` sendiri (tanpa `--target`) membuat basis data scratch-nya SENDIRI (`RESTORE_SCRATCH_DB`, default `awcms_restore_drill`), menolak bila nama itu sama dengan basis data yang terhubung, memulihkan ke dalamnya, memverifikasinya, lalu menghapusnya — basis data yang terhubung/produksi tidak pernah dimutasi. Tidak ada variabel environment, profile compose, atau argumen cron yang membuat servis ini destruktif; restore disaster-recovery yang nyata SENGAJA BUKAN servis compose — ia adalah langkah runbook manual dan terkonfirmasi `docker run ... restore-postgres.sh <dump> --target=<db> --yes` di bawah, satu langkah lebih jauh dari `docker compose up` yang tak sengaja atau baris cron yang di-copy-paste dibanding definisi servis:

```bash
docker run --rm --network container:<kontainer postgres> \
  -v awcms-one-production-backups:/backup \
  -v ./apps/cms/deploy/backup:/scripts:ro \
  -e DATABASE_URL="<DSN owner/setup>" \
  -e RESTORE_AGE_IDENTITY_FILE=/secrets/restore-age-identity.key \
  -e BACKUP_HMAC_KEY_FILE=/secrets/backup-hmac.key \
  postgres:18.4 \
  bash /scripts/restore-postgres.sh /backup/<artifact>.dump.age --target=<db> --yes
```

### Evidence RTO/RPO (butir cakupan 9)

`restore-drill.sh` mengukur keduanya langsung, tanpa data produksi pernah keluar dari drill: `restoreRtoSeconds` adalah durasi nyata verify→decrypt→restore→check secara wall-clock; `restoreRpoSeconds` adalah umur backup yang di-drill, pada saat drill. Memvalidasi issue ini terhadap PostgreSQL disposable dengan data sintetis (satu baris tenant fiktif, tanpa data pelanggan/bisnis nyata), satu drill penuh mengukur **RTO 2-3 detik, RPO 1-615 detik** tergantung berapa lama sejak backup sintetis terakhir — evidence dari mekanismenya, bukan SLA produksi; angka deployment nyata bergantung pada ukuran basis data dan kadensi cron `backup`/`restore-drill`-nya sendiri.

### Kaitan dengan topologi produksi saat ini (butir cakupan 10)

`backup`/`restore-drill`/`offsite-copy` adalah servis tambahan di `compose.production.yaml` yang SAMA yang sudah dijelaskan "Runbook produksi" dokumen ini — tanpa perubahan pada `postgres`/`migrate`/`cms`/`jobs`/`storefront`, dan tanpa port basis data baru yang bisa diakses host (aturan keamanan di atas: produksi tetap hanya terjangkau dari jaringan proyek compose sendiri; `backup`/`restore-drill` bergabung ke jaringan yang sama persis seperti yang sudah dilakukan `migrate`).

### Jalur kegagalan yang diverifikasi

Diuji langsung terhadap PostgreSQL disposable (`bun run db:up`) dengan data sintetis, memakai baik skrip mentah maupun servis/image `compose.production.yaml` yang sesungguhnya:

- **Materi kunci enkripsi salah/hilang** — `restore-postgres.sh` menolak sebelum menyentuh basis data mana pun ketika `RESTORE_AGE_IDENTITY_FILE` tidak diset, atau ketika `BACKUP_HMAC_KEY_FILE` menunjuk kunci yang salah (HMAC tidak cocok).
- **Manifest yang di-tamper** — satu field yang diedit di JSON manifest tertangkap pemeriksaan HMAC sebelum dekripsi dicoba.
- **Backup yang korup** — satu byte yang dibalik di ciphertext tertangkap pemeriksaan `artifact_sha256` milik manifest sebelum dekripsi dicoba.
- **Tujuan off-site tak tersedia** — `offsite-copy.sh` mencoba ulang, lalu keluar non-zero, dan salinan lokal tidak tersentuh; tidak ada yang melaporkan backup lokal-saja sebagai off-site.
- **Target restore tidak aman/tidak terisolasi** — `restore-postgres.sh --target=<db>` menolak ketika `<db>` sama dengan basis data yang disebut di DSN koneksi, sebelum mutasi apa pun; servis compose `restore-drill` sendiri sama sekali tidak bisa mencapai jalur kode ini (lihat di atas).

### Tidak diuji

Berkas recipient `age` yang salah/malformed pada saat BACKUP (berbeda dari identitas salah saat RESTORE) teramati sekali, secara insidental, selama validasi issue ini sendiri (berkas recipients sintetis non-bech32 membuat `backup-postgres.sh` gagal tertutup dengan dump plaintext dibiarkan di tempat dan tanpa artifact `.age` ditulis) tetapi tidak dijalankan sebagai kasus uji yang disengaja dan berulang seperti kelima jalur di atas. Host SSH off-site yang benar-benar tak terjangkau (kegagalan DNS, bukan sekadar connection-refused) dan prompt konfirmasi `restore-postgres.sh --target` di bawah TTY nyata tidak diuji terpisah — jalur kode yang mendasarinya adalah yang sama yang sudah dicakup test suite upstream milik `apps/cms` sendiri untuk skrip-skrip ini.

### Apa yang masih belum dibangun (ADR-0019 D7, dipersempit ADR-0020)

Image `runtime`/`jobs` milik `apps/cms` sendiri, sejak issue #187, dipublikasikan `bun run release:images -- --publish` (`tools/release/images.ts`, sejak issue #225/ADR-0023; sebelumnya `.github/workflows/images.yml`) — lihat "Image yang dipublikasikan" di atas; bagian itu dari daftar ADR-0019 D7 sendiri kini tertutup. Yang masih tersisa, dengan sengaja: pipeline CI yang mempublikasikan image per-profil `apps/storefront` ke registry — [ADR-0020](adr/0020-publish-only-the-cms-images-to-ghcr-with-sbom-and-provenance.md) D2 menolaknya langsung, bukan sekadar menundanya (fetch-konten-saat-build dan token owner lewat BuildKit secret — lihat "Image yang dipublikasikan" di atas — membuat image storefront yang dipublikasikan menjadi risiko kredensial-produksi dan keusangan, bukan sekadar kemudahan yang belum dibangun). Konfigurasi reverse-proxy/terminasi-TLS di luar contoh di atas — ingress operator sendiri yang menerminasi TLS. Adapter pembayaran Xendit dan pelacakan kurir (keduanya disebut sebagai tindak lanjut eksplisit ADR-0017). PostgreSQL produksi yang dioperasikan repositori ini sendiri — servis `postgres` `compose.production.yaml` disediakan untuk deployment self-hosted; instans terkelola didokumentasikan sebagai alternatif, tidak dikirim.
