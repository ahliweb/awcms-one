🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](routing.md)

<!-- i18n-source-hash: sha256:20d93c7cb141548a64d4a0271de6e8cc853704ac27f7847f61ea2a40e3c1f8d8 -->

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

`legacyRedirectLocation()` milik `apps/storefront/server/penyaji.mjs` mencari path yang masuk (dinormalisasi: URI-decoded, query/fragment dilepas, satu trailing slash dihapus) terhadap peta yang dibaca sekali saat server startup dari `dist/client/index/pengalihan-legacy.json`. Berkas itu dibangun dari baris `awcms_seo_redirects` milik `apps/cms` sendiri (`origin: "legacy_blog"`) — hanya baris dengan `targetType: "relative_same_tenant"` yang dipakai (baris `verified_external` menunjuk ke luar situs dan dilewati); kolom `target` milik CMS sendiri tidak dipakai verbatim — hanya segmen path terakhirnya (slug) yang diambil dan dibangun ulang sebagai `/berita/{slug}`, karena `target` membawa bentuk `/blog/{tenantCode}/{slug}` milik CMS sendiri. Dua baris yang menormalisasi ke path sumber yang sama tapi tidak sepakat soal tujuan menggagalkan **build**, bukan last-wins diam-diam saat request.

Bentuk URL yang ditangani: `/news/{id}-{slug}.html` milik seputarborneo dan `/{yyyy}/{mm}/{dd}/{slug}/` milik beritasampit — keduanya menormalisasi dengan benar baik trailing slash ada maupun tidak, baik saat build (kunci peta) maupun saat request (lookup), termasuk regresi trailing-slash sungguhan yang ditangkap dan diperbaiki build ini (riwayat commit `legacyRedirectLocation` sendiri, `apps/storefront/tests/berita-penyaji-legacy.test.ts`).

## `/products` → `/` (301), tidak berubah dari increment 1

URL katalog lama milik situs live, `/products` — dengan atau tanpa query string — tetap redirect ke `/` dengan `301`, dicocokkan hanya pada path (`isProductsRedirect`/`PRODUCTS_REDIRECT_LOCATION` di `apps/storefront/server/penyaji.mjs`). Ini adalah aturan hardcoded terpisah, berbeda dari peta redirect-lawas yang dihasilkan di atas — lihat [ADR-0005](adr/0005-product-urls-match-the-live-sites-shape.id.md).

## Belum dibangun

Path pelacakan-order per-kode (`/pesanan/{code}` — lihat "Commerce runtime" di atas untuk alasan mengapa `?kode=` adalah bentuk sungguhan yang kompatibel-statis). Job CI yang menjalankan suite e2e Playwright (`apps/storefront/tests/e2e/checkout.e2e.ts`, `bun run test:e2e` di dalam `apps/storefront`) — sudah ada dan lolos secara lokal, tapi belum dikaitkan ke `.github/workflows/ci.yml` (di luar cakupan berkas CI milik-ops untuk issue #30 — lihat [`docs/pengujian.md`](pengujian.id.md)).
