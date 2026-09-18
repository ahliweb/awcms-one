🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](routing.md)

<!-- i18n-source-hash: sha256:90881ceafe48a616d5621a2ddd1e94a8f3d97148f0a249abc031eaa79fd43e66 -->

# Routing

Setiap rute yang dipublikasikan `apps/storefront` — 41 berkas rute di bawah `apps/storefront/src/pages/`, semuanya dihasilkan secara statis (`output: "static"`, `trailingSlash: "never"`, `build.format: "file"`, tidak ada `prerender = false` di mana pun — ditegakkan oleh [`apps/storefront/tests/checkout-guard-no-prerender.test.ts`](../apps/storefront/tests/checkout-guard-no-prerender.test.ts), yang men-grep setiap sumber halaman alih-alih meng-compile-nya). Halaman keranjang/checkout/pelacakan-order juga statis — lihat [ADR-0007](adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.id.md) untuk alasan mengapa JavaScript sisi-klien-nya bisa memanggil `apps/cms` secara live tanpa halaman itu sendiri di-server-render.

## Katalog

| Path | Sumber | Catatan |
| --- | --- | --- |
| `/` | `apps/storefront/src/pages/index.astro` | Slider, kategori populer, strip flash-sale, produk featured/recommended, testimonial, berita terbaru, popup promo |
| `/produk` | `apps/storefront/src/pages/produk.astro` | Grid + sidebar (pohon kategori, sort, rentang harga, stok, khusus-flash-sale); search/filter/sort/pagination sisi-klien atas `/index/produk.json`, halaman pertama di-server-render agar tetap terindeks |
| `/kategori/{slug}` | `src/pages/kategori/[slug].astro` | Satu halaman per kategori hidup |
| `/flash-sale` | `apps/storefront/src/pages/flash-sale.astro` | |
| `/product/{slug}` | `src/pages/product/[slug].astro` | Galeri, pemilih varian, harga bertingkat/flash-sale, size chart, formulir jasa, produk terkait; JSON-LD `Product`/`Offer`/`BreadcrumbList` — lihat [ADR-0005](adr/0005-product-urls-match-the-live-sites-shape.id.md) untuk bentuk URL itu sendiri |
| `/cari` | `apps/storefront/src/pages/cari.astro` | Pencarian katalog; `noindex, follow` |

## Berita (mencerminkan seputarborneo/beritasampit)

| Path | Sumber | Catatan |
| --- | --- | --- |
| `/berita` | `apps/storefront/src/pages/berita/index.astro` | Headline + satu bagian per rubrik tingkat-atas, strip video, strip mitra, sidebar |
| `/berita/{slug}` | `src/pages/berita/[slug].astro` | Detail artikel; JSON-LD `NewsArticle`+`BreadcrumbList` |
| `/berita/feed.xml` | `apps/storefront/src/pages/berita/feed.xml.ts` | RSS 2.0, 20 terbaru, `content:encoded` penuh |
| `/rubrik/{slug}` | `src/pages/rubrik/[slug]/index.astro` | Arsip rubrik induk mencakup post setiap rubrik turunannya |
| `/rubrik/{slug}/halaman/{n}` | `src/pages/rubrik/[slug]/halaman/[n].astro` | Pagination |
| `/rubrik/{slug}/feed.xml` | `src/pages/rubrik/[slug]/feed.xml.ts` | RSS per-rubrik |
| `/daerah/{slug}` | `src/pages/daerah/[slug].astro` | Arsip wilayah — dijangkau lewat `regionCode` milik institusi; post itu sendiri tidak membawa field wilayah |
| `/mitra/{slug}` | `src/pages/mitra/[slug].astro` | Halaman landing institusi |
| `/video` | `apps/storefront/src/pages/video/index.astro` | |
| `/video/{slug}` | `src/pages/video/[slug].astro` | Post yang membawa blok `videoNews` yang bisa di-render; dipartisi dari `/berita/{slug}` sehingga tidak ada post yang punya dua URL kanonik |
| `/tag/{slug}` | `src/pages/tag/[slug].astro` | |
| `/penulis/{slug}` | `src/pages/penulis/[slug].astro` | Arsip penulis berbasis byline |
| `/arsip/{yyyy}/{mm}` | `src/pages/arsip/[yyyy]/[mm].astro` | Bulan kalender WIB |
| `/cari-berita` | `apps/storefront/src/pages/cari-berita.astro` | Pencarian sisi-klien atas `/index/berita.json` |

## Commerce runtime (browser memanggil `apps/cms` secara langsung; halamannya sendiri statis)

| Path | Sumber | Catatan |
| --- | --- | --- |
| `/keranjang` | `apps/storefront/src/pages/keranjang.astro` | Me-render keranjang `localStorage`, re-quote live, kode voucher, fallback WhatsApp no-JS |
| `/checkout` | `apps/storefront/src/pages/checkout.astro` | Satu halaman, lima langkah yang diungkap progresif: kontak → alamat → pengiriman → pembayaran → review |
| `/pesanan` | `apps/storefront/src/pages/pesanan.astro` | Pelacakan lewat `?kode=`; **bukan** `/pesanan/[kode]` — path per-kode tidak bisa di-prerender di bawah `output: "static"`, dan tidak ada catch-all sisi-server untuk redirect dari satu bentuk ke bentuk lain; nomor telepon berasal dari `sessionStorage` atau formulir, tidak pernah dari URL |
| `/wishlist` | `apps/storefront/src/pages/wishlist.astro` | Hanya-`localStorage` |

Keempatnya: `noindex, follow`, `aria-live="polite"` pada update quote/status, terjangkau keyboard, fallback `<noscript>` plus fallback WhatsApp untuk kondisi JS-berjalan-tapi-CMS-down (`apps/storefront/src/lib/wa-fallback.ts`).

## Statis

| Path | Sumber |
| --- | --- |
| `/kontak` | `apps/storefront/src/pages/kontak.astro` |
| `/halaman/{slug}` | `src/pages/halaman/[slug].astro` — halaman CMS yang di-render dari Portable Text |
| `/404` | `apps/storefront/src/pages/404.astro` |

## Discovery, feed, dan aset yang dihasilkan

| Path | Sumber |
| --- | --- |
| `/robots.txt` | `apps/storefront/src/pages/robots.txt.ts` — men-`Disallow` `/keranjang`, `/checkout`, `/pesanan`, `/wishlist`, `/cari`, `/api/`; menyebut `Sitemap:` |
| `/sitemap-index.xml` | `apps/storefront/src/pages/sitemap-index.xml.ts` |
| `/sitemap-{n}.xml` | `src/pages/sitemap-[n].xml.ts` — dipecah per 5000 URL/berkas (`registerSitemapSource` milik `apps/storefront/src/lib/sitemap.ts`) |
| `/feed.xml` | `apps/storefront/src/pages/feed.xml.ts` — produk |
| `/manifest.webmanifest` | `apps/storefront/src/pages/manifest.webmanifest.ts` |
| `/theme-tokens.css` | `apps/storefront/src/pages/theme-tokens.css.ts` — warna brand dibaca dari `apps/cms` saat build |
| `/product-labels.css` | `apps/storefront/src/pages/product-labels.css.ts` — satu class CSS per `labelColor` unik yang benar-benar dipakai katalog |
| `/csp.json` | `apps/storefront/src/pages/csp.json.ts` — artifact CSP turunan; lihat [`docs/arsitektur.md`](arsitektur.id.md) |
| `/index/produk.json`, `/index/berita.json` | Indeks pencarian saat-build untuk filtering sisi-klien milik `/produk`/`/cari-berita` |
| `/index/pengalihan-legacy.json` | Peta redirect-lawas, dibangun dari `awcms_seo_redirects` (di bawah) |
| `/index/wilayah-provinsi.json`, `/index/wilayah-kabupaten-{provinceCode}.json`, `/index/wilayah-kecamatan-{cityCode}.json` | Data wilayah alamat untuk checkout, dipanggang saat build dan dibatasi oleh `PUBLIC_WILAYAH_PROVINSI` (default setiap provinsi Kalimantan) alih-alih dataset nasional penuh ~90.000 desa |

## Redirect lawas

`legacyRedirectLocation()` milik `apps/storefront/server/penyaji.mjs` mencari path yang masuk (dinormalisasi: URI-decoded, query/fragment dilepas, satu trailing slash dihapus) terhadap peta yang dibaca sekali saat server startup dari `dist/client/index/pengalihan-legacy.json`. Berkas itu dibangun dari baris `awcms_seo_redirects` milik `apps/cms` sendiri (`origin: "legacy_blog"`) — hanya baris dengan `targetType: "relative_same_tenant"` yang dipakai (baris `verified_external` menunjuk ke luar situs dan dilewati); kolom `target` milik CMS sendiri tidak dipakai verbatim — hanya segmen path terakhirnya (slug) yang diambil dan dibangun ulang dalam kosakata URL aplikasi ini sendiri, karena `target` membawa bentuk `/blog/{tenantCode}/{slug}` milik CMS sendiri. Tujuan hasil bangun ulang itu adalah `/berita/{slug}` untuk post biasa, tapi `/video/{slug}` saat slug itu milik post video (`apps/storefront/src/pages/index/pengalihan-legacy.json.ts` memanggil `getVideo()` sekali, saat build, khusus untuk himpunan itu) — `getPosts()` milik `apps/storefront/src/lib/berita.ts` tidak pernah mempublikasikan post video di `/berita/{slug}` juga, jadi baris yang mengabaikan ini akan me-redirect ke halaman yang tidak pernah dibangun aplikasi ini. Dua baris yang menormalisasi ke path sumber yang sama tapi tidak sepakat soal tujuan menggagalkan **build**, bukan last-wins diam-diam saat request.

Bentuk URL yang ditangani: `/news/{id}-{slug}.html` milik seputarborneo dan `/{yyyy}/{mm}/{dd}/{slug}/` milik beritasampit — keduanya menormalisasi dengan benar baik trailing slash ada maupun tidak, baik saat build (kunci peta) maupun saat request (lookup), termasuk regresi trailing-slash sungguhan yang ditangkap dan diperbaiki build ini (riwayat commit `legacyRedirectLocation` sendiri, `apps/storefront/tests/berita-penyaji-legacy.test.ts`). Satu bentuk sengaja dikecualikan dari pelucutan query string biasa: `normalizeLegacyPath` milik `apps/storefront/src/lib/pengalihan-legacy.ts` mempertahankan query sumber `/video/?video={id}-…` apa adanya (bukan meruntuhkan setiap baris video ke kunci `/video` telanjang yang sama) khusus supaya `findVideoRowTargetById` milik `pengalihan-aturan.mjs` (di bawah) masih bisa membedakan satu id video dari yang lain.

### Redirect berbasis aturan (issue #55 / A9) — sisa URL seputarborneo, tanpa baris CMS sama sekali

Peta berbasis-baris di atas hanya pernah tahu URL yang secara eksplisit dicatat operator/import — tepat untuk satu artikel, boros untuk bentuk URL yang sama untuk ratusan halaman. `apps/storefront/server/pengalihan-aturan.mjs` adalah modul kedua yang MURNI dan berbasis-tabel khusus untuk bentuk-bentuk itu — taksonomi rubrik/daerah/mitra/video/statis/pencarian milik seputarborneo, dibaca dari `include/nav_menu.php` (`seputarborneo_rubrik_resolve()`/`_kanonik()`), `.htaccess`, `rubriks/index.php`, `video/index.php`, `img/index.php`, dan `data/index.php`. `legacyRedirectLocation()` memanggilnya hanya saat GAGAL cocok dengan peta berbasis-baris di atas, sehingga baris buatan operator selalu menang saat keduanya bisa tidak sepakat.

| Bentuk sumber | Tujuan | Catatan |
| --- | --- | --- |
| `/rubrik/{slug}.html` | `/rubrik/{slug}` | Huruf kecil semua, spasi/underscore/`%20` → `-`; `Olah Raga`/`OLAHRAGA` → `olahraga`; `VIDEO`/`video` → `/video` (halaman daftarnya sendiri, bukan arsip rubrik) |
| `/daerah/{kategori}.html`, `/DAERAH/{Kategori}.html` | `/daerah/{slug}` | Nama salah satu dari 14 daerah sendiri, atau nama kota lama (Sampit → `kotawaringin-timur`, dan 9 lainnya — lihat tabel `DAERAH_ENTRIES` milik modul itu sendiri), dipetakan ke slug kabupatennya |
| `/mitra-borneo/{slug}.html`, `/MITRA%20BORNEO/{Nama}.html`, `/Mitra-Borneo/{Nama}.html` | `/mitra/{slug}` | Salah satu dari 24 kanal Mitra Borneo, atau yang akan datang — slug institusi diteruskan apa adanya, jadi aturan ini tidak perlu pembaruan tabel saat institusi ke-25 disemai |
| `/umum/{slug}.html`, `/UMUM/{Nama}.html` | `/rubrik/{slug}` | Anak UMUM adalah rubrik biasa di sini — `/rubrik/wisata.html` (topik lama) dan `/umum/wisata.html` (anak UMUM lama) sama-sama mendarat di `/rubrik/wisata`, satu-satunya pasangan yang dibuktikan suite test aplikasi ini sebagai SATU-SATUNYA tabrakan di antara semua nama yang dikenal modul |
| `/rubriks/?news={A}&kt={B}&lanjut={n}` | SAMA seperti `/{A}/{B}.html` di atas, plus `/halaman/{n}` (n>1) jika tujuannya halaman `/rubrik/…` | Bukan bentuk tersendiri — ini adalah rewrite dua-segmen (atau, saat `kt` absen, satu-segmen `/rubrik/{news}.html`) milik `.htaccess` sendiri dengan capture-nya sudah dipecah jadi parameter query, jadi diselesaikan oleh dispatch rubrik/daerah/mitra/umum yang SAMA, tidak pernah yang kedua. Tujuan `daerah`/`mitra` tidak punya rute paginasi di aplikasi ini, jadi `lanjut` diabaikan untuk keduanya |
| `/video/?video={id}-{slug}.html`, `/video/?video={id}_{slug}.html`, atau bentuk bare `/video/?video={id}` yang dulu di-hardcode beranda | `/video/{slug}` jika ada baris `/video/?video={id}-…`, jika tidak `/video` | Tidak pernah slug tebakan, dan tidak pernah peta baris `/news/…` untuk id yang sama — id milik `berita_vid` dan `berita_red` (di balik `/news/…`) adalah dua ruang id yang independen (issue #58/B2), jadi redirect video hanya pernah mencari irisan `/video/?video={id}…` milik peta baris itu sendiri |
| `/tentang_kami.html`, `/pedoman_media_cyber.html`, `/disclimer.html` | `/halaman/redaksi`, `/halaman/pedoman-media-siber`, `/halaman/disclaimer` | Tiga halaman statis yang dulu dilayani `data/index.php` |
| `/pencarian/?cari_berita={q}` | `/cari-berita?q={q}` | **302**, bukan 301 — hasil pencarian bukan sumber daya yang dipindah permanen |
| `/img/?news={id}` | Tujuan `/news/{id}…` berbasis-baris jika dikenal, jika tidak `/berita` | `img/index.php` sendiri sudah me-redirect bentuk ini di situs live; id boleh diikuti `-`, `_`, atau `.` — template baku importer legacy CMS untuk situs ini adalah `/news/{legacyId}_{slug}.html` (underscore), bukan cuma bentuk tanda hubung |
| `/index.php`, `/?subscribed=1` | `/berita` | |

Semuanya `301` kecuali aturan pencarian (302, di atas); `createServer` membaca bentuk `{ location, status }` yang dikembalikan `ruleBasedRedirectLocation()` hanya untuk kasus itu, dan sebuah string biasa (301) untuk setiap aturan lain — bentuk kembalian yang sama yang sudah dimiliki `legacyRedirectLocation()` sebelum modul ini ada, jadi `apps/storefront/tests/berita-penyaji-legacy.test.ts` tidak perlu diubah. `apps/storefront/tests/pengalihan-aturan.test.ts` mencakup setiap baris tabel di atas (input ter-encode maupun tidak, dengan atau tanpa trailing slash) plus pemeriksaan loop-guard: tujuan aturan mana pun tidak cocok dengan bentuk sumber aturan mana pun, sehingga satu request tidak akan pernah di-redirect dua kali.

Pencarian id `/news/…` dan `/video/?video=…` (aturan img dan video) dilayani dari indeks `id -> tujuan` yang dibangun sekali per objek peta berbasis-baris dan di-cache (sebuah `WeakMap` berkunci objek itu), bukan dipindai ulang setiap request — krusial begitu issue #58 (B2) mengimpor ~25 ribu artikel seputarborneo ke peta yang sama.

## `/products` → `/` (301), tidak berubah dari increment 1

URL katalog lama milik situs live, `/products` — dengan atau tanpa query string — tetap redirect ke `/` dengan `301`, dicocokkan hanya pada path (`isProductsRedirect`/`PRODUCTS_REDIRECT_LOCATION` di `apps/storefront/server/penyaji.mjs`). Ini adalah aturan hardcoded terpisah, berbeda dari peta redirect-lawas yang dihasilkan di atas — lihat [ADR-0005](adr/0005-product-urls-match-the-live-sites-shape.id.md).

## Halaman yang terbayangi direktori bernama sama ditulis ulang ke `.html`-nya (issue #75)

Di bawah `build.format: "file"`, halaman landing yang juga punya anak dipancarkan sebagai **file sekaligus direktori** — `dist/client/berita.html` di samping `dist/client/berita/`, `video.html` di samping `video/`, dan `rubrik/{slug}.html` di samping `rubrik/{slug}/` (`feed.xml` rubrik itu dan `halaman/{n}.html`). Static handler `@astrojs/node` menguji direktori *sebelum* meminta file ke `send`: dengan `trailingSlash: "never"`, permintaan berbentuk direktori tanpa garis miring akhir ditulis ulang menjadi `{path}/index.html` — file yang tidak pernah ditulis build ini — sehingga fallback `.html` milik `send` tidak pernah berjalan, adapter jatuh ke SSR, dan `/berita`, `/video`, serta setiap `/rubrik/{slug}` menjawab **404** di situs yang disajikan padahal build-nya hijau. Karena itu `apps/storefront/server/penyaji.mjs` menelusuri `dist/client/` **sekali saat startup** (`discoverShadowedHtmlPaths`, rekursif — bayangan rubrik ada satu tingkat di bawah) untuk menemukan setiap path semacam itu, dan, sebagai langkah *terakhir* sebelum adapter — setelah `/healthz`, redirect `/products`, dan kedua lapisan redirect lawas di atas, yang semuanya tetap didahulukan — menulis ulang `req.url` untuk path-path itu saja menjadi `{path}.html` (`shadowedHtmlUrl`, query string dipertahankan). Ini penulisan ulang internal, bukan redirect: URL pembaca tetap `/berita`, dan pemanggilan `send` milik adapter sendiri tetap menyajikan file itu dengan penanganan traversal, conditional-GET, dan content-type miliknya — tidak ada bagian `penyaji.mjs` yang membaca atau men-stream halaman. Bentuk dengan garis miring akhir (`/berita/`) sengaja diserahkan ke adapter, yang me-301-kannya ke `/berita` seperti sebelumnya. Dicakup oleh `apps/storefront/tests/penyaji-bayangan-html.test.ts` (pohon `dist/` sintetis dan hook `createServer`) dan `apps/storefront/tests/penyaji-bayangan-build-smoke.test.ts` (build nyata berbasis stub yang disajikan oleh bundel `dist/server/penyaji.mjs` yang sesungguhnya).

## Belum dibangun

Path pelacakan-order per-kode (`/pesanan/{code}` — lihat "Commerce runtime" di atas untuk alasan mengapa `?kode=` adalah bentuk sungguhan yang kompatibel-statis). Job CI yang menjalankan suite e2e Playwright (`apps/storefront/tests/e2e/checkout.e2e.ts`, `bun run test:e2e` di dalam `apps/storefront`) — sudah ada dan lolos secara lokal, tapi belum dikaitkan ke `.github/workflows/ci.yml` (di luar cakupan berkas CI milik-ops untuk issue #30 — lihat [`docs/pengujian.md`](pengujian.id.md)).
