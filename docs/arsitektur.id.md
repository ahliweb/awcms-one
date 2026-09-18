🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](arsitektur.md)

<!-- i18n-source-hash: sha256:2c9a07c0b4b1f8c2b0b46adc8e92988ffa5e33293f46c283bb6b27a375375a50 -->

# Arsitektur

Apa yang benar-benar di-deploy oleh repositori ini hari ini, dan batasan yang menjaga kedua bagiannya agar tidak diam-diam saling menyusup. Dokumen ini mendeskripsikan increment 3 — paritas BjekMart/portal-berita milik increment 2 ditambah paritas fungsional dengan seputarborneo.com v2.4.0 yang ditambahkan epic [#46](https://github.com/ahliweb/awcms-one/issues/46) (media sungguhan, chrome berita, pemutar baca-nyaring, pengalihan lawas berbasis aturan, analitik first-party, lambang lembaga), tetap tanpa basis data produksi yang hidup — sebagaimana adanya di tree yang sudah digabung, bukan sebagaimana direncanakan. Lihat [`README.md`](../README.id.md) dan [`AGENTS.md`](../AGENTS.id.md) untuk tata letak workspace dan aturan kerja yang diasumsikan dokumen ini.

## Dua deployable, satu aliran data saat-build, satu seam runtime anonim

```mermaid
flowchart LR
  subgraph "apps/cms — system of record"
    DB[(PostgreSQL, RLS-scoped)]
    OwnerAPI["/api/v1/commerce/* (owner, Bearer)"]
    PublicAPI["/api/v1/commerce/storefront/* (anonim, Origin-bound)"]
    DB --> OwnerAPI
    DB --> PublicAPI
  end

  subgraph "apps/storefront — situs publik"
    Build["astro build\n(token Bearer read-only)"]
    Files["dist/client/*.html"]
    Penyaji["server/penyaji.mjs\n(server HTTP Bun)"]
    Browser["browser milik pembaca"]
    Build --> Files --> Penyaji --> Browser
  end

  OwnerAPI -- "hanya saat build" --> Build
  Penyaji -. "tidak pernah, saat runtime" .-> OwnerAPI
  Browser -- "keranjang/checkout/pelacakan, CORS, tanpa kredensial" --> PublicAPI
```

| | `apps/cms` | `apps/storefront` |
| --- | --- | --- |
| Apa itu | `ahliweb/awcms` v10.3.0, di-embed utuh lewat `git subtree` (lihat [ADR-0001](adr/0001-git-subtree-with-full-history-for-apps-cms.id.md)) | Aplikasi Astro, `output: "static"`, tidak ada rute `prerender = false` di mana pun (lihat [ADR-0002](adr/0002-static-output-with-build-time-fetch-for-the-storefront.id.md), diamendemen oleh [ADR-0007](adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.id.md)) |
| Peran | System of record — PostgreSQL di bawah row-level security, API commerce yang menghadap owner, dan API commerce kedua yang anonim untuk pembeli tamu | Situs katalog publik, berita, dan belanja |
| Berbicara ke | Basis data PostgreSQL-nya sendiri, saat request | API owner `apps/cms` hanya saat **build** (server-side, token read-only); API storefront anonim `apps/cms` saat **runtime**, tapi hanya dari **browser milik pembaca sendiri** — tidak pernah dari container yang berjalan |
| Kredensial runtime | Connection string basis data untuk `awcms_app`/`awcms_worker`/`awcms_setup` (lihat `apps/cms/.env.example`) | Tidak ada — `apps/storefront/server/penyaji.mjs` hanya membaca `PORT`/`HOST`; panggilan browser ke `apps/cms` tidak membawa cookie maupun bearer token (`mode: "cors"`, `credentials: "omit"`) |
| Dilayani oleh | Runtime Bun/Astro milik `apps/cms` sendiri | `apps/storefront/server/penyaji.mjs`, server HTTP Bun yang ditulis tangan, membungkus adapter `standalone` milik `@astrojs/node` |

**Container yang menjalankan `apps/storefront` tidak pernah berbicara ke `apps/cms`.** `astro build` memanggil API owner `apps/cms` sekali, dengan token Bearer read-only (`AWCMS_API_TOKEN`), untuk memanggang katalog, berita, permukaan pemasaran, dan halaman statis menjadi HTML datar di bawah `dist/client/`. Begitu build itu selesai, `bun dist/server/penyaji.mjs` hanya melayani berkas-berkas itu dan tidak lebih — ia tidak memegang token API, tidak membuka koneksi ke `apps/cms`, dan tidak punya jalur kode yang bisa menjangkau basis data sekalipun ia mau. **Yang berubah di increment 2 adalah hubungan *browser* itu sendiri dengan `apps/cms`**, bukan hubungan container: keranjang, checkout, dan pelacakan pesanan adalah halaman statis yang JavaScript sisi-kliennya memanggil `https://<cms>/api/v1/commerce/storefront/*` langsung, lintas-origin, memakai `PUBLIC_AWCMS_ORIGIN` — nilai yang dipanggang saat build, sengaja dibuat publik (sebuah origin bukan rahasia; setiap URL media sudah mengungkapkannya). Inilah keseluruhan argumen [ADR-0007](adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.id.md): kredensial runtime di dalam *container* ditolak karena kredensial mesin `apps/cms` memang read-only secara konstruksi (kredensial itu tidak pernah bisa membuat pesanan); keluarga endpoint anonim dan Origin-bound yang sudah dibangun `apps/cms` untuk permukaan newsletter/site-search/comments-nya adalah pola yang dipakai ulang di sini. Kompromi pada container storefront tetap tidak menjangkau data pelanggan apa pun, karena memang tidak ada yang bisa dijangkau dari dalamnya — pesanan, nomor telepon, instruksi pembayaran semuanya berjalan browser ↔ CMS langsung dan tidak pernah dicatat log atau disimpan oleh storefront.

**Trade-off dari ADR-0002 tidak berubah untuk semua hal kecuali harga dan stok pada saat menambahkan ke keranjang:** setiap halaman katalog dan berita tetap hanya sesegar build terakhir. Halaman keranjang meng-quote ulang setiap baris terhadap `apps/cms` secara live sebelum checkout (`POST .../storefront/cart/quote`), sehingga harga statis yang basi ditampilkan dan ditandai, tidak pernah dikenakan secara diam-diam.

## CSP diturunkan dari konten, bukan dikonfigurasi

Foto produk, gambar slider/testimoni, dan — sejak increment 2 — origin CMS itu sendiri semuanya adalah hal yang baru diketahui build lewat fetch konten; CSP yang dikelola manual akan drift sejak saat merchandiser mengunggah gambar baru. Sebagai gantinya:

1. `apps/storefront/src/pages/csp.json.ts` — halaman yang selalu di-prerender setiap build tanpa syarat — mengumpulkan setiap origin gambar yang benar-benar dirujuk build (`img-src`) dari fetch ter-memoized yang sama yang dipakai me-render halaman, dan memanggil `requireAwcmsOrigin()` (`apps/storefront/src/lib/awcms/toko-origin.ts`) untuk menambahkan tepat satu origin `connect-src`: `PUBLIC_AWCMS_ORIGIN`. Nilai yang tidak diset atau malformed **menggagalkan build**, menyebut nama variabelnya — bukan kejutan saat runtime.
2. Hasilnya ditulis ke `dist/client/csp.json` (`{ version: 1, imgSrc: [...], connectSrc: [...] }`).
3. `apps/storefront/server/penyaji.mjs` membaca berkas itu **sekali, saat server startup** (bukan per-request), dan memvalidasi ulang setiap origin secara independen dari build yang menghasilkannya — menolak apa pun yang punya path, query, kredensial, wildcard, atau karakter separator, hanya menyisakan origin `http(s)` polos. Artefak yang hilang, malformed, atau versi tak dikenal jatuh kembali ke kebijakan baseline (`img-src 'self'`, `connect-src 'self'`): gambar dan API storefront berhenti bekerja, secara terlihat, alih-alih kebijakan diam-diam melebar melampaui apa yang benar-benar diminta build mana pun.

Ini mekanisme yang sama untuk kedua directive — entri `PUBLIC_AWCMS_ORIGIN` milik `connect-src` (issue #30) memakai ulang derivasi `img-src` yang dibangun issue #27, alih-alih menambah permukaan konfigurasi kedua.

Increment 3 memperluas penurunan yang sama alih-alih menggantinya ([ADR-0011](adr/0011-storefront-media-resolves-through-the-media-objects-endpoint.md)): `img-src` kini juga membawa origin setiap URL media yang benar-benar **ter-resolve** build lewat `GET /api/v1/media/objects` — sehingga baris yang masih menunjuk host media sebelumnya tetap tampil alih-alih diblokir — ditambah `https://i.ytimg.com`, dan `frame-src https://www.youtube-nocookie.com`, tetapi hanya ketika build itu memang memuat pos video. Origin milik GA4 sendiri (`script-src`/`connect-src`/`img-src`) muncul hanya ketika `PUBLIC_GA_ID` diisi; build bawaan sama sekali tidak punya origin pihak ketiga di kebijakannya ([ADR-0012](adr/0012-first-party-visitor-analytics-with-an-opt-in-ga4-switch.md)).

## Arah impor: satu jalur, `storefront → kontrak → cms`

`apps/storefront` tidak pernah mengimpor dari `apps/cms` secara langsung. `packages/kontrak` duduk di antara keduanya, mengekspor-ulang union type-only (`ProductType`, `ProductStatus`, `SizeChartType`, `SubscriptionPeriod`, `ServiceFormFieldType`, `ProductSort`, dan union pemasaran/order yang ditambahkan issue #26/#29) dari `apps/cms/src/modules/commerce/domain/*.ts` — lapisan murni bebas-I/O yang dijaga bersih oleh konvensi `apps/cms` sendiri — sebagai `export type` saja, tanpa nilai runtime. Arahnya ditegakkan secara mekanis: [`tests/kontrak-arah-impor.test.mjs`](../tests/kontrak-arah-impor.test.mjs) memindai setiap berkas `.ts`/`.tsx`/`.astro` di bawah `apps/cms/src/` dan gagal jika ada satu pun yang mengimpor dari `apps/storefront`, `packages/kontrak`, atau paket `@awcms-one/*`. Lihat [ADR-0004](adr/0004-a-type-only-contract-package-with-an-import-direction-gate.id.md) untuk alasan mengapa arah ini penting khususnya karena `apps/cms` adalah kode vendored.

## Embed subtree, secara singkat

`apps/cms` adalah tree milik `ahliweb/awcms` sendiri, dibawa ke sini dengan riwayat commit lengkap lewat `git subtree`, bukan digantungkan sebagai paket — infrastruktur bersama yang dibutuhkan `commerce` (`withTenant`, `authorizeInTransaction`, `appendDomainEvent`, `recordAuditEvent`, kontrak modul, migration runner) tidak punya paket standalone untuk digantungkan sebagai gantinya. Sinkronisasi dilakukan lewat `git subtree pull --prefix=apps/cms awcms main`, dan **PR yang menjalankannya harus digabung dengan merge commit — tidak pernah di-squash, tidak pernah di-rebase** — men-squash menghancurkan merge base yang dibutuhkan sinkronisasi berikutnya, secara tak kasatmata, sampai sinkronisasi berikutnya gagal jauh dari commit yang merusaknya. Lihat [ADR-0001](adr/0001-git-subtree-with-full-history-for-apps-cms.id.md) untuk perbandingan lengkap terhadap `--squash` dan salinan vendored, serta [`AGENTS.md`](../AGENTS.id.md#penyematan-subtree) untuk mekanisme sinkronisasinya.

**Mengadmisi modul `commerce` menyentuh 29 berkas di luar direktori modulnya sendiri** — masing-masing adalah registry yang harus diikuti modul baru, atau inventaris yang dihasilkan yang diturunkan ulang dari sumber, atau kenaikan kecil jumlah-modul dalam dokumentasi prosa. Increment 2 menjaga jumlah modul tetap satu, bukan tiga, khususnya untuk menghindari membayar biaya 29-berkas itu berulang kali — lihat [ADR-0008](adr/0008-one-commerce-module-carries-the-whole-store-not-three.md). **Setelah setiap sinkronisasi subtree, perbaikannya adalah menjalankan ulang generator yang disebutkan `bun run check` di dalam `apps/cms` — jangan pernah menggabung berkas hasil-generate dengan tangan.**

## Modul `commerce`: satu modul, tiga area, satu dependensi pada `media_library`

Per [ADR-0008](adr/0008-one-commerce-module-carries-the-whole-store-not-three.md), semua tabel, rute, izin, event, job, dan layar admin commerce hidup di bawah satu kunci modul `commerce`, dikelompokkan secara internal berdasarkan area (`domain/{catalog,marketing,orders}/…` adalah konvensi direktori, bukan batas modul):

- **Catalog** (issue #23) — kategori, produk (gambar, varian, harga bertingkat, size chart, form layanan, banner promo).
- **Marketing** (issue #26) — flash sale, voucher, slider, testimoni, popup, pengaturan toko yang di-versioning.
- **Orders** (issue #29) — pelanggan, alamat, quote keranjang, pesanan, konfirmasi pembayaran, ulasan, wishlist, dan permukaan `/api/v1/commerce/storefront/*` yang anonim.

`dependencies` milik `module.ts` adalah `tenant_admin`, `identity_access`, `domain_event_runtime`, `media_library` (gambar produk/slider/testimoni/popup di-resolve lewat `MediaLibraryPort`), dan `module_management` (pengecekan fail-closed milik tenant-resolver storefront anonim). Lihat [`docs/skema-basis-data.md`](skema-basis-data.id.md), [`docs/kamus-data.md`](kamus-data.id.md), [`docs/api.md`](api.id.md), dan [`docs/cms.md`](cms.id.md) untuk isi modul ini secara mendalam, dan [`apps/cms/src/modules/commerce/README.md`](../apps/cms/src/modules/commerce/README.id.md) untuk dokumentasinya sendiri yang berdekatan-kode.

## Satu hal lagi yang dilakukan server: memperbaiki halaman yang terbayangi

`apps/storefront/server/penyaji.mjs` tetap server berkas statis tanpa token API, tetapi kini melakukan satu penulisan ulang internal di luar dua lapisan pengalihan: di bawah `build.format: "file"`, halaman landing yang juga punya anak dipancarkan sebagai berkas **di samping** direktori bernama sama (`berita.html` di sebelah `berita/`), dan static handler `@astrojs/node` menulis ulang permintaan berbentuk direktori menjadi `index.html` yang tidak pernah ditulis build ini — sehingga `/berita`, `/video`, dan setiap `/rubrik/{slug}` menjawab 404 di situs yang disajikan padahal semua gerbang build hijau ([issue #75](https://github.com/ahliweb/awcms-one/issues/75)). Server menemukan halaman terbayangi itu sekali saat startup dan menulis ulang `req.url` menjadi `{path}.html` sebagai langkah **terakhir** sebelum adapter, setelah `/healthz`, redirect `/products`, dan kedua lapisan pengalihan lawas, sehingga tidak ada yang dilakukannya bisa membayangi sebuah pengalihan. Lihat [`docs/routing.id.md`](routing.id.md) dan [ADR-0013](adr/0013-rule-based-legacy-redirects-beside-the-row-based-map.md).

## Apa yang masih belum ada di sini

Akun pelanggan (login, wishlist/alamat/ulasan yang tersinkron, program afiliasi — [issue #32](https://github.com/ahliweb/awcms-one/issues/32)); integrasi tarif kurir RajaOngkir yang live dan payment gateway (keduanya harus dipanggil lewat outbox milik `apps/cms`, tidak pernah secara sinkron di jalur pesanan, per [ADR-0010](adr/0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.md) — [issue #33](https://github.com/ahliweb/awcms-one/issues/33)); POS dan pelaporan manajemen (issue #33); upload berbasis-R2 yang nyata untuk gambar produk, media slider, dan gambar bukti konfirmasi-pembayaran (skrip seed memakai SVG placeholder yang dibuat sendiri dan endpoint upload bukti-pembayaran anonim menjawab `503 MEDIA_UNAVAILABLE` — lihat [`docs/deployment.md`](deployment.id.md) dan [`docs/cms.md`](cms.id.md)); deployment PostgreSQL produksi (`postgres:18.4` milik `compose.yaml` hanya kemudahan lokal/CI — lihat [`docs/deployment.md`](deployment.id.md)).

## Bacaan lanjutan

- [`docs/adr/`](adr/README.id.md) — sepuluh keputusan yang menjadi landasan arsitektur ini, masing-masing dengan tabel trade-off-nya sendiri.
- [`docs/skema-basis-data.md`](skema-basis-data.id.md), [`docs/kamus-data.md`](kamus-data.id.md) — skema dan pemetaan kolom legacy-nya.
- [`docs/api.md`](api.id.md), [`docs/cms.md`](cms.id.md) — API commerce (owner dan anonim) dan alur kerja authoring/publishing di baliknya.
- [`docs/routing.md`](routing.id.md) — peta URL publik lengkap.
- [`knowledge/curated/monorepo-map.md`](../knowledge/curated/monorepo-map.md) — tata letak workspace, secara struktural, dijaga terpisah dari dokumen ini karena berkas itu menamai STRUKTUR dan dokumen ini menamai KEPUTUSAN di baliknya.
