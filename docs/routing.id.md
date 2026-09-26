🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](routing.md)

<!-- i18n-source-hash: sha256:b196fe7c4c394cc6a9fb03bd818264f159344edad751d845c32c273a50a64f82 -->

# Routing

Setiap rute yang dipublikasikan `apps/storefront` — 52 berkas rute, semuanya dihasilkan secara statis (`output: "static"`, `trailingSlash: "never"`, `build.format: "file"`, tidak ada `prerender = false` di mana pun — ditegakkan oleh [`apps/storefront/tests/checkout-guard-no-prerender.test.ts`](../apps/storefront/tests/checkout-guard-no-prerender.test.ts), yang men-grep setiap sumber halaman alih-alih meng-compile-nya, di bawah `src/pages/**` DAN `src/profil/*/pages/**`). Halaman keranjang/checkout/pelacakan-order juga statis — lihat [ADR-0007](adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.id.md) untuk alasan mengapa JavaScript sisi-klien-nya bisa memanggil `apps/cms` secara langsung tanpa halamannya sendiri di-render di server.

Sejak issue #137 berkas rute hidup dalam **grup halaman**, dan grup mana yang disertakan sebuah build ditentukan oleh profil build — baca bagian berikut sebelum membaca tabel-tabelnya: kolom `Sumber` yang dimulai dengan `apps/storefront/src/profil/toko/` atau `.../profil/berita/` menamai rute yang hanya ada pada profil yang menyusun grup itu.

## Profil build: `SITE_PROFILE` menentukan grup mana yang menjadi rute (issue #137, [ADR-0018](adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.id.md) D2/D3)

`SITE_PROFILE` (`toko` — default, situs hibrida BjekMart sendiri — `berita`, atau `landing`) dibaca sekali, saat build, oleh [`apps/storefront/src/config/profil.ts`](../apps/storefront/src/config/profil.ts) lewat rantai `readEnv` yang sama dengan `SITE_URL`. Nilai yang tidak dikenal menggagalkan build dengan pesan yang menyebut nama variabelnya; tidak diset berarti `toko`. Sebuah profil adalah komposisi tiga grup halaman:

| Profil | Grup | Apa itu |
| --- | --- | --- |
| `toko` (default) | `shared` + `toko` + `berita` | Commerce dan berita bersama — BjekMart hari ini, byte-per-byte sama dengan yang dibangun sebelum #137 |
| `berita` | `shared` + `berita` | Portal berita saja, tanpa commerce |
| `landing` | `shared` | Situs profil perusahaan / landing — beranda, halaman statis, kontak, chrome SEO |

**Di mana berkasnya.** `apps/storefront/src/pages/**` hanya memuat grup `shared` — sepuluh berkas yang dilayani setiap profil (`index.astro`, `404.astro`, `kontak.astro`, `halaman/[slug].astro`, `robots.txt.ts`, `sitemap-index.xml.ts`, `sitemap-[n].xml.ts`, `csp.json.ts`, `manifest.webmanifest.ts`, `theme-tokens.css.ts`) — sebagai rute berbasis-berkas Astro biasa. Setiap berkas halaman lain dipindahkan (`git mv`, riwayat dipertahankan) ke `apps/storefront/src/profil/<grup>/pages/**`, dengan path relatif yang persis sama seperti di bawah `apps/storefront/src/pages/`: 23 berkas di `profil/toko/pages/`, 19 di `profil/berita/pages/`. Penetapan lengkap berkas-per-berkas, termasuk tiga kasus tepi yang diputuskan dari kode dan bukan dari nama berkasnya (`mitra/[slug]` adalah `berita`, `feed.xml` akar adalah feed produk milik `toko`, `index/wilayah-*` adalah cascade alamat checkout milik `toko`), adalah matriks profil di [`docs/template.md`](template.id.md); [`apps/storefront/tests/profil-integrasi.test.ts`](../apps/storefront/tests/profil-integrasi.test.ts) mem-parse tabel itu dan gagal bila pohon berkas tidak sesuai.

**Bagaimana grup menjadi rute.** [`apps/storefront/integrations/profil.mjs`](../apps/storefront/integrations/profil.mjs), satu-satunya integrasi Astro aplikasi ini (didaftarkan di `apps/storefront/astro.config.mjs`), berjalan di hook `astro:config:setup` — sebelum Astro memindai `apps/storefront/src/pages/` — dan memanggil `injectRoute({ pattern, entrypoint })` untuk setiap berkas di bawah direktori `pages/` grup yang AKTIF. `pattern` adalah rute yang akan diturunkan routing berbasis-berkas Astro sendiri dari path relatif yang sama (`produk.astro` → `/produk`, `berita/index.astro` → `/berita`, `feed.xml.ts` → `/feed.xml`, `rubrik/[slug]/halaman/[n].astro` → `/rubrik/[slug]/halaman/[n]`); `entrypoint` adalah path berkas relatif terhadap akar proyek (`./src/profil/toko/pages/produk.astro`), bentuk yang di-resolve API integrasi Astro terhadap `config.root`. Direktori grup yang tidak aktif tidak pernah dijelajahi: halamannya bukan rute, `getStaticPaths()`-nya tidak pernah berjalan, datanya tidak pernah diambil, tidak ada satu pun yang sampai ke `dist/`. Tidak ada rute yang menyetel `prerender` — test penjaga di atas juga menjelajahi `src/profil/**`.

**Halaman beranda.** `/` termasuk `shared`, tetapi isinya per profil. `apps/storefront/src/pages/index.astro` mengimpor `@profil/beranda`, alias Vite yang oleh integrasi yang sama diarahkan ke `apps/storefront/src/profil/<profil>/Beranda.astro`: `toko/Beranda.astro` adalah beranda pra-#137 yang dipindahkan apa adanya; `berita/Beranda.astro` me-render badan halaman depan `/berita` ([`apps/storefront/src/components/berita/HalamanDepanBerita.astro`](../apps/storefront/src/components/berita/HalamanDepanBerita.astro), dipakai bersama `/berita` sendiri) di bawah chrome berita dengan nama situs sebagai `<h1>`-nya; `landing/Beranda.astro` adalah hero, halaman statis yang terbit, dan bagian kontak. Alias, bukan `import` tiga-arah di dalam `index.astro`, karena Astro mengumpulkan stylesheet sebuah halaman dari semua yang diimpornya — statis maupun dinamis — sehingga hanya varian aktif yang boleh berada di graf modul kalau beranda `toko` harus tetap byte-identik.

**Semua yang lain membaca `profil.ts`, tidak ada yang memutuskan grup dua kali.** Nav header dan formulir pencariannya, tautan bantuan dan legal di footer, feed `<link rel="alternate">` dan stylesheet `/product-labels.css` di `BaseLayout`, daftar `Disallow` `robots.txt`, registrasi `sitemap-sources.ts`/`sitemap-katalog.ts`, bacaan konten `csp.json.ts`, dan anotasi `ROUTE_GROUPS` milik `routes.ts` sendiri (setiap kunci `ROUTES` membawa grupnya; `satisfies` menjadikan kunci tanpa anotasi sebagai galat tipe) semuanya berasal dari satu modul itu. Per profil:

| | `toko` | `berita` | `landing` |
| --- | --- | --- | --- |
| Nav header | Beranda, Produk, Flash Sale, Berita, Kontak + alat keranjang/wishlist/akun | Beranda, Berita, rubrik tingkat atas yang dikenali (dinamis), Video, Buletin, Kontak | Beranda, setiap halaman statis yang terbit (dinamis), Kontak |
| Formulir pencarian header/404 | `/cari` (produk) | `/cari-berita` (berita) | tidak ada |
| Tautan legal footer | keenam-enamnya | Redaksi, Pedoman Media Siber, Disclaimer, Kebijakan Privasi, Syarat & Ketentuan | Kebijakan Privasi, Syarat & Ketentuan |
| `Disallow` `robots.txt` | `/keranjang`, `/checkout`, `/pesanan`, `/wishlist`, `/cari`, `/newsletter/confirm`, `/newsletter/unsubscribe`, `/masuk`, `/daftar`, `/akun`, `/api/` (tidak berubah) | `/newsletter/confirm`, `/newsletter/unsubscribe`, `/api/` | `/api/` |
| Sumber sitemap | kedua belas | `static-routes`, `static-pages`, setiap `berita-*` | `static-routes`, `static-pages` |
| Feed | `/feed.xml` (produk, diiklankan di `<head>`), `/berita/feed.xml`, `/rubrik/{slug}/feed.xml` | `/berita/feed.xml` (diiklankan), `/rubrik/{slug}/feed.xml` | tidak ada |
| `csp.json` | `connect-src` = `PUBLIC_AWCMS_ORIGIN`; `img-src` dari produk, pemasaran, media artikel; `frame-src` YouTube bila ada post video | `connect-src` = `PUBLIC_AWCMS_ORIGIN` (beacon pengunjung dan formulir buletin mem-POST ke sana); `img-src` dari media artikel; YouTube seperti di atas | `connect-src` = `PUBLIC_AWCMS_ORIGIN` (beacon pengunjung berjalan di setiap halaman); `img-src` = host media dan logo situs saja; tanpa `frame-src` |

Server ([`apps/storefront/server/penyaji.mjs`](../apps/storefront/server/penyaji.mjs)) tidak memerlukan flag profil: ia menurunkan apa yang bisa dilayaninya dari `dist/` saat startup, seperti yang sudah dilakukannya untuk artefak CSP dan peta redirect lawas — aturan redirect berita lawas (di bawah) kini hanya berjalan bila `berita.html` ada di build, sehingga deployment `landing` tidak pernah me-301 pembaca ke `/berita` yang tidak dimilikinya.

## Katalog

| Path | Sumber | Catatan |
| --- | --- | --- |
| `/` | `apps/storefront/src/pages/index.astro` | Slider, kategori populer, strip flash-sale, produk featured/recommended, testimonial, berita terbaru, popup promo |
| `/produk` | `apps/storefront/src/profil/toko/pages/produk.astro` | Grid + sidebar (pohon kategori, sort, rentang harga, stok, khusus-flash-sale); search/filter/sort/pagination sisi-klien atas `/index/produk.json`, halaman pertama di-server-render agar tetap terindeks |
| `/kategori/{slug}` | `apps/storefront/src/profil/toko/pages/kategori/[slug].astro` | Satu halaman per kategori hidup |
| `/flash-sale` | `apps/storefront/src/profil/toko/pages/flash-sale.astro` | |
| `/product/{slug}` | `apps/storefront/src/profil/toko/pages/product/[slug].astro` | Galeri, pemilih varian, harga bertingkat/flash-sale, size chart, formulir jasa, produk terkait; JSON-LD `Product`/`Offer`/`BreadcrumbList` — lihat [ADR-0005](adr/0005-product-urls-match-the-live-sites-shape.id.md) untuk bentuk URL itu sendiri |
| `/cari` | `apps/storefront/src/profil/toko/pages/cari.astro` | Pencarian katalog; `noindex, follow` |

## Berita (mencerminkan seputarborneo/beritasampit)

| Path | Sumber | Catatan |
| --- | --- | --- |
| `/berita` | `apps/storefront/src/profil/berita/pages/berita/index.astro` | Headline + satu bagian per rubrik tingkat-atas, strip video, strip mitra, sidebar |
| `/berita/{slug}` | `apps/storefront/src/profil/berita/pages/berita/[slug].astro` | Detail artikel; JSON-LD `NewsArticle`+`BreadcrumbList` |
| `/berita/feed.xml` | `apps/storefront/src/profil/berita/pages/berita/feed.xml.ts` | RSS 2.0, 20 terbaru, `content:encoded` penuh |
| `/rubrik/{slug}` | `apps/storefront/src/profil/berita/pages/rubrik/[slug]/index.astro` | Arsip rubrik induk mencakup post setiap rubrik turunannya |
| `/rubrik/{slug}/halaman/{n}` | `apps/storefront/src/profil/berita/pages/rubrik/[slug]/halaman/[n].astro` | Pagination |
| `/rubrik/{slug}/feed.xml` | `apps/storefront/src/profil/berita/pages/rubrik/[slug]/feed.xml.ts` | RSS per-rubrik |
| `/daerah/{slug}` | `apps/storefront/src/profil/berita/pages/daerah/[slug].astro` | Arsip wilayah — dijangkau lewat `regionCode` milik institusi; post itu sendiri tidak membawa field wilayah |
| `/mitra/{slug}` | `apps/storefront/src/profil/berita/pages/mitra/[slug].astro` | Halaman landing institusi |
| `/video` | `apps/storefront/src/profil/berita/pages/video/index.astro` | |
| `/video/{slug}` | `apps/storefront/src/profil/berita/pages/video/[slug].astro` | Post yang membawa blok `videoNews` yang bisa di-render; dipartisi dari `/berita/{slug}` sehingga tidak ada post yang punya dua URL kanonik |
| `/tag/{slug}` | `apps/storefront/src/profil/berita/pages/tag/[slug].astro` | |
| `/penulis/{slug}` | `apps/storefront/src/profil/berita/pages/penulis/[slug].astro` | Arsip penulis berbasis byline |
| `/arsip/{yyyy}/{mm}` | `apps/storefront/src/profil/berita/pages/arsip/[yyyy]/[mm].astro` | Bulan kalender WIB |
| `/cari-berita` | `apps/storefront/src/profil/berita/pages/cari-berita.astro` | Pencarian sisi-klien atas `/index/berita.json` |

## Commerce runtime (browser memanggil `apps/cms` secara langsung; halamannya sendiri statis)

| Path | Sumber | Catatan |
| --- | --- | --- |
| `/keranjang` | `apps/storefront/src/profil/toko/pages/keranjang.astro` | Me-render keranjang `localStorage`, re-quote live, kode voucher, fallback WhatsApp no-JS |
| `/checkout` | `apps/storefront/src/profil/toko/pages/checkout.astro` | Satu halaman, lima langkah yang diungkap progresif: kontak → alamat → pengiriman → pembayaran → review |
| `/pesanan` | `apps/storefront/src/profil/toko/pages/pesanan.astro` | Pelacakan lewat `?kode=`; **bukan** `/pesanan/[kode]` — path per-kode tidak bisa di-prerender di bawah `output: "static"`, dan tidak ada catch-all sisi-server untuk redirect dari satu bentuk ke bentuk lain; nomor telepon berasal dari `sessionStorage` atau formulir, tidak pernah dari URL |
| `/wishlist` | `apps/storefront/src/profil/toko/pages/wishlist.astro` | Hanya-`localStorage` |

Keempatnya: `noindex, follow`, `aria-live="polite"` pada update quote/status, terjangkau keyboard, fallback `<noscript>` plus fallback WhatsApp untuk kondisi JS-berjalan-tapi-CMS-down (`apps/storefront/src/lib/wa-fallback.ts`).

## Akun pelanggan (issue #88 S1, issue #90 S2, issue #93/#115 S3, dari #32/#33)

| Path | Sumber | Catatan |
| --- | --- | --- |
| `/masuk` | `apps/storefront/src/profil/toko/pages/masuk.astro` | Masuk dengan OTP e-mail; issue #115 (kontrak #106 D5) menambah pilihan kanal "Kirim kode lewat: E-mail \| WhatsApp", ditampilkan hanya saat `whatsappOtpEnabled` pada pengaturan toko publik bernilai `true` saat build — WhatsApp meminta nomor telepon (`type="tel"`) alih-alih e-mail; `noindex, follow` |
| `/daftar` | `apps/storefront/src/profil/toko/pages/daftar.astro` | Pendaftaran dengan nama + telepon + OTP e-mail; selalu hanya-e-mail (catatan milik issue #115 menjelaskan ini meski kanal WhatsApp `/masuk` aktif); `noindex, follow` |
| `/akun` | `apps/storefront/src/profil/toko/pages/akun/index.astro` | Shell dashboard setelah masuk (profil, "Ubah nama", kotak centang persetujuan promo yang ditambahkan issue #115, "Keluar", kartu navigasi); `noindex, follow` |
| `/akun/alamat` | `apps/storefront/src/profil/toko/pages/akun/alamat.astro` | Daftar/tambah/ubah/hapus/atur-default alamat (maksimal 10); pilihan provinsi/kota/kecamatan memakai ulang `apps/storefront/src/lib/wilayah-region-select.ts`, modul YANG SAMA dipakai autofill alamat tersimpan milik `checkout.astro`; `noindex, follow` |
| `/akun/pesanan` | `apps/storefront/src/profil/toko/pages/akun/pesanan.astro` | Daftar pesanan berpaginasi keyset ("Muat lebih banyak"); `noindex, follow` |
| `/akun/pesanan?kode=` | berkas yang sama, dengan `?kode=` | Detail satu pesanan milik akun, memakai ulang renderer `/pesanan` sendiri (`apps/storefront/src/lib/pesanan-render.ts`) — TANPA prompt telepon, sesi sudah membuktikan kepemilikan |
| `/akun/ulasan` | `apps/storefront/src/profil/toko/pages/akun/ulasan.astro` | Ulasan produk milik akun sendiri — rating sebagai teks + bintang, status moderasi dalam Bahasa Indonesia; `noindex, follow` |
| `/akun/afiliasi` | `apps/storefront/src/profil/toko/pages/akun/afiliasi.astro` | Program afiliasi (issue #93, S3 dari #32; sisi CMS/staf adalah issue #92): penjelasan tertutup saat `affiliateProgramEnabled` bernilai `false` pada saat build, jika tidak maka gabung/tautan-referral/statistik/komisi; `noindex, follow` |
| `/akun/pesan` | `apps/storefront/src/profil/toko/pages/akun/pesan.astro` | Kotak pesan akun dengan toko (issue #115, S3 dari #33, kontrak #106 D8): daftar percakapan berpaginasi keyset dengan lencana belum-dibaca, formulir "Pesan baru", tampilan thread; `noindex, follow` (diwariskan dari prefix `Disallow` milik `/akun` — tidak perlu perubahan `robots.txt`) |
| `/akun/pesan?id=` | berkas yang sama, dengan `?id=` | Thread satu percakapan milik akun — setiap pesan, formulir balas selama `status` `"open"`, catatan thread-tertutup jika sebaliknya |

`ROUTES.accountOrder(kode)` (`/akun/pesanan?kode=`) adalah URL milik satu pesanan itu sendiri; `ROUTES.accountMessage(id)` (`/akun/pesan?id=`) adalah bentuk yang sama untuk satu percakapan.

`?ref={code}` pada HALAMAN MANA PUN (bukan hanya `/`) adalah referral yang ditangkap, bukan rute tersendiri — `apps/storefront/src/scripts/afiliasi-tangkap.ts`, dipasang dari `BaseLayout.astro` di setiap halaman, menyimpan kode yang valid dan menghapus HANYA parameter kueri itu lewat `history.replaceState`; lihat [`docs/seo.md`](seo.id.md) untuk alasan mengapa tautan kanonik tidak terpengaruh oleh penangkapan ini.

`checkout.astro`/`checkout.ts` mendapat `<select>` "Pilih alamat tersimpan", tersembunyi sampai sesi pelanggan terkonfirmasi, yang mengisi otomatis langkah alamat dari `GET …/account/addresses`; permintaan pembuatan pesanan membawa Bearer token pembeli yang sudah masuk bila ada (`createOrder` milik `apps/storefront/src/lib/toko-klien.ts` menerima argumen kedua OPSIONAL `bearerToken` — pemanggil anonim yang sudah ada tidak terpengaruh).

## Statis

| Path | Sumber |
| --- | --- |
| `/kontak` | `apps/storefront/src/pages/kontak.astro` |
| `/halaman/{slug}` | `apps/storefront/src/pages/halaman/[slug].astro` — halaman CMS yang di-render dari Portable Text |
| `/404` | `apps/storefront/src/pages/404.astro` |

## Discovery, feed, dan aset yang dihasilkan

| Path | Sumber |
| --- | --- |
| `/robots.txt` | `apps/storefront/src/pages/robots.txt.ts` — men-`Disallow` daftar milik profil aktif (`ROBOTS_DISALLOW` di `apps/storefront/src/config/profil.ts`; untuk `toko`: `/keranjang`, `/checkout`, `/pesanan`, `/wishlist`, `/cari`, `/newsletter/confirm`, `/newsletter/unsubscribe`, `/masuk`, `/daftar`, `/akun`, `/api/`); menyebut `Sitemap:` |
| `/sitemap-index.xml` | `apps/storefront/src/pages/sitemap-index.xml.ts` |
| `/sitemap-{n}.xml` | `apps/storefront/src/pages/sitemap-[n].xml.ts` — dipecah per 5000 URL/berkas (`registerSitemapSource` milik `apps/storefront/src/lib/sitemap.ts`) |
| `/feed.xml` | `apps/storefront/src/profil/toko/pages/feed.xml.ts` — produk (grup `toko`; feed berita adalah `/berita/feed.xml` di atas) |
| `/manifest.webmanifest` | `apps/storefront/src/pages/manifest.webmanifest.ts` |
| `/theme-tokens.css` | `apps/storefront/src/pages/theme-tokens.css.ts` — warna brand dibaca dari `apps/cms` saat build |
| `/product-labels.css` | `apps/storefront/src/profil/toko/pages/product-labels.css.ts` — satu class CSS per `labelColor` unik yang benar-benar dipakai katalog |
| `/csp.json` | `apps/storefront/src/pages/csp.json.ts` — artifact CSP turunan; lihat [`docs/arsitektur.md`](arsitektur.id.md) |
| `/index/produk.json`, `/index/berita.json` | Indeks pencarian saat-build untuk filtering sisi-klien milik `/produk`/`/cari-berita` |
| `/index/pengalihan-legacy.json` | Peta redirect-lawas, dibangun dari `awcms_seo_redirects` (di bawah) |
| `/index/wilayah-provinsi.json`, `/index/wilayah-kabupaten-{provinceCode}.json`, `/index/wilayah-kecamatan-{cityCode}.json` | Data wilayah alamat untuk checkout, dipanggang saat build dan dibatasi oleh `PUBLIC_WILAYAH_PROVINSI` (default setiap provinsi Kalimantan) alih-alih dataset nasional penuh ~90.000 desa |

## Redirect lawas

`legacyRedirectLocation()` milik `apps/storefront/server/penyaji.mjs` mencari path yang masuk (dinormalisasi: URI-decoded, query/fragment dilepas, satu trailing slash dihapus) terhadap peta yang dibaca sekali saat server startup dari `dist/client/index/pengalihan-legacy.json`. Berkas itu dibangun dari baris `awcms_seo_redirects` milik `apps/cms` sendiri (`origin: "legacy_blog"`) — hanya baris dengan `targetType: "relative_same_tenant"` yang dipakai (baris `verified_external` menunjuk ke luar situs dan dilewati); kolom `target` milik CMS sendiri tidak dipakai verbatim — hanya segmen path terakhirnya (slug) yang diambil dan dibangun ulang dalam kosakata URL aplikasi ini sendiri, karena `target` membawa bentuk `/blog/{tenantCode}/{slug}` milik CMS sendiri. Tujuan hasil bangun ulang itu adalah `/berita/{slug}` untuk post biasa, tapi `/video/{slug}` saat slug itu milik post video (`apps/storefront/src/profil/berita/pages/index/pengalihan-legacy.json.ts` memanggil `getVideo()` sekali, saat build, khusus untuk himpunan itu) — `getPosts()` milik `apps/storefront/src/lib/berita.ts` tidak pernah mempublikasikan post video di `/berita/{slug}` juga, jadi baris yang mengabaikan ini akan me-redirect ke halaman yang tidak pernah dibangun aplikasi ini. Dua baris yang menormalisasi ke path sumber yang sama tapi tidak sepakat soal tujuan menggagalkan **build**, bukan last-wins diam-diam saat request.

Bentuk URL yang ditangani: `/news/{id}-{slug}.html` milik seputarborneo (dan bentuk pra-2.0-nya `/news/{id}_{Judul_Dengan_Garis_Bawah}.html`) dan `/{yyyy}/{mm}/{dd}/{slug}/` milik beritasampit — keduanya menormalisasi dengan benar baik trailing slash ada maupun tidak, baik saat build (kunci peta) maupun saat request (lookup), termasuk regresi trailing-slash sungguhan yang ditangkap dan diperbaiki build ini (riwayat commit `legacyRedirectLocation` sendiri, `apps/storefront/tests/berita-penyaji-legacy.test.ts`).

**Post video memakai kunci sintetis tanpa query — `/video/{id}-{slug}.html` — bukan URL lawas yang sebenarnya.** URL video seputarborneo yang sebenarnya adalah `/video/?video={id}-{slug}.html`, dengan seluruh identitasnya di query string, dan `apps/cms` melucuti query string dari setiap *sumber* redirect saat menulis (`validateRedirectInput` → `normalizeRedirectPath` tanpa `keepQuery`, `apps/cms/src/modules/seo-distribution/domain/redirect-rule.ts` / `redirect-path.ts`): dikirim apa adanya, ke-35 baris video akan tersimpan sebagai `/video` telanjang yang sama — chunk impor gagal dengan `DUPLICATE_IN_BATCH`, atau satu baris yang selamat me-redirect halaman daftar `/video` itu sendiri ke satu post. Maka `tools/import-seputarborneo.ts` (issue #58) menulis `/video/{id}-{slug}.html` sebagai sumber — path yang tidak pernah ada secara publik, dipilih semata karena lolos CMS tanpa berubah dan masih membawa id-nya. URL masuk yang sebenarnya ditangani modul berbasis aturan di bawah: `rowIdIndexFor` milik `pengalihan-aturan.mjs` mengindeks setiap kunci peta baris yang cocok `^/video/(\d+)[-_.]` berdasarkan id numeriknya, dan `resolveVideoQuery` menjawab `/video/?video={id}-…`, `{id}_…` atau `{id}` telanjang dari indeks itu — hanya berdasarkan id, persis seperti `video/index.php` lawas membaca `(int) $_GET['video']`. `normalizeLegacyPath` milik `apps/storefront/src/lib/pengalihan-legacy.ts` masih mempertahankan query sumber `/video/?video={id}-…` apa adanya jika suatu saat menemuinya (fixture tulisan tangan; CMS masa depan yang mempertahankan query), dan `rowIdIndexFor` mengindeks bentuk itu juga — tapi cabang itu defensif, bukan kontraknya: CMS sendiri tidak pernah bisa menyerahkan bentuk itu ke storefront.

### Redirect berbasis aturan (issue #55 / A9) — sisa URL seputarborneo, tanpa baris CMS sama sekali

Peta berbasis-baris di atas hanya pernah tahu URL yang secara eksplisit dicatat operator/import — tepat untuk satu artikel, boros untuk bentuk URL yang sama untuk ratusan halaman. `apps/storefront/server/pengalihan-aturan.mjs` adalah modul kedua yang MURNI dan berbasis-tabel khusus untuk bentuk-bentuk itu — taksonomi rubrik/daerah/mitra/video/statis/pencarian milik seputarborneo, dibaca dari `include/nav_menu.php` (`seputarborneo_rubrik_resolve()`/`_kanonik()`), `.htaccess`, `rubriks/index.php`, `video/index.php`, `img/index.php`, dan `data/index.php`. `legacyRedirectLocation()` memanggilnya hanya saat GAGAL cocok dengan peta berbasis-baris di atas, sehingga baris buatan operator selalu menang saat keduanya bisa tidak sepakat.

| Bentuk sumber | Tujuan | Catatan |
| --- | --- | --- |
| `/rubrik/{slug}.html` | `/rubrik/{slug}` | Huruf kecil semua, spasi/underscore/`%20` → `-`; `Olah Raga`/`OLAHRAGA` → `olahraga`; `VIDEO`/`video` → `/video` (halaman daftarnya sendiri, bukan arsip rubrik) |
| `/daerah/{kategori}.html`, `/DAERAH/{Kategori}.html` | `/daerah/{slug}` | Nama salah satu dari 14 daerah sendiri, atau nama kota lama (Sampit → `kotawaringin-timur`, dan 9 lainnya — lihat tabel `DAERAH_ENTRIES` milik modul itu sendiri), dipetakan ke slug kabupatennya |
| `/mitra-borneo/{slug}.html`, `/MITRA%20BORNEO/{Nama}.html`, `/Mitra-Borneo/{Nama}.html` | `/mitra/{slug}` | Salah satu dari 24 kanal Mitra Borneo, atau yang akan datang — slug institusi diteruskan apa adanya, jadi aturan ini tidak perlu pembaruan tabel saat institusi ke-25 disemai |
| `/umum/{slug}.html`, `/UMUM/{Nama}.html` | `/rubrik/{slug}` | Anak UMUM adalah rubrik biasa di sini — `/rubrik/wisata.html` (topik lama) dan `/umum/wisata.html` (anak UMUM lama) sama-sama mendarat di `/rubrik/wisata`, satu-satunya pasangan yang dibuktikan suite test aplikasi ini sebagai SATU-SATUNYA tabrakan di antara semua nama yang dikenal modul |
| `/rubriks/?news={A}&kt={B}&lanjut={n}` | SAMA seperti `/{A}/{B}.html` di atas, plus `/halaman/{n}` (n>1) jika tujuannya halaman `/rubrik/…` | Bukan bentuk tersendiri — ini adalah rewrite dua-segmen (atau, saat `kt` absen, satu-segmen `/rubrik/{news}.html`) milik `.htaccess` sendiri dengan capture-nya sudah dipecah jadi parameter query, jadi diselesaikan oleh dispatch rubrik/daerah/mitra/umum yang SAMA, tidak pernah yang kedua. Tujuan `daerah`/`mitra` tidak punya rute paginasi di aplikasi ini, jadi `lanjut` diabaikan untuk keduanya |
| `/video/?video={id}-{slug}.html`, `/video/?video={id}_{slug}.html`, atau bentuk bare `/video/?video={id}` yang dulu di-hardcode beranda | `/video/{slug}` jika ada baris `/video/{id}-…` (kunci sintetis tanpa query milik exporter, di atas), jika tidak `/video` | Tidak pernah slug tebakan, dan tidak pernah peta baris `/news/…` untuk id yang sama — id milik `berita_vid` dan `berita_red` (di balik `/news/…`) adalah dua ruang id yang independen (issue #58/B2), jadi redirect video hanya pernah mencari irisan `/video/{id}…` milik peta baris itu sendiri |
| `/tentang_kami.html`, `/pedoman_media_cyber.html`, `/disclimer.html` | `/halaman/redaksi`, `/halaman/pedoman-media-siber`, `/halaman/disclaimer` | Tiga halaman statis yang dulu dilayani `data/index.php` |
| `/pencarian/?cari_berita={q}` | `/cari-berita?q={q}` | **302**, bukan 301 — hasil pencarian bukan sumber daya yang dipindah permanen |
| `/img/?news={id}` | Tujuan `/news/{id}…` berbasis-baris jika dikenal, jika tidak `/berita` | `img/index.php` sendiri sudah me-redirect bentuk ini di situs live; id boleh diikuti `-`, `_`, atau `.` — template baku importer legacy CMS untuk situs ini adalah `/news/{legacyId}_{slug}.html` (underscore), bukan cuma bentuk tanda hubung |
| `/index.php`, `/?subscribed=1` | `/berita` | |

Semuanya `301` kecuali aturan pencarian (302, di atas); `createServer` membaca bentuk `{ location, status }` yang dikembalikan `ruleBasedRedirectLocation()` hanya untuk kasus itu, dan sebuah string biasa (301) untuk setiap aturan lain — bentuk kembalian yang sama yang sudah dimiliki `legacyRedirectLocation()` sebelum modul ini ada, jadi `apps/storefront/tests/berita-penyaji-legacy.test.ts` tidak perlu diubah. `apps/storefront/tests/pengalihan-aturan.test.ts` mencakup setiap baris tabel di atas (input ter-encode maupun tidak, dengan atau tanpa trailing slash) plus pemeriksaan loop-guard: tujuan aturan mana pun tidak cocok dengan bentuk sumber aturan mana pun, sehingga satu request tidak akan pernah di-redirect dua kali.

Pencarian id `/news/…` dan `/video/…` (aturan img dan video) dilayani dari indeks `id -> tujuan` yang dibangun sekali per objek peta berbasis-baris dan di-cache (sebuah `WeakMap` berkunci objek itu), bukan dipindai ulang setiap request — krusial begitu issue #58 (B2) mengimpor ~25 ribu artikel seputarborneo ke peta yang sama.

**Hanya pada build yang punya permukaan berita (issue #137).** Setiap aturan di atas mengirim pembaca ke rute berita. Karena itu `apps/storefront/server/penyaji.mjs` meneruskan `hasNewsSurface(clientDir)` — "apakah `dist/client/berita.html` ada?", dibaca sekali saat startup — sebagai flag `rulesEnabled` milik `legacyRedirectLocation`, sehingga build `landing` (tanpa grup `berita`) tidak menerapkan satu pun aturan itu dan permintaan seperti `/rubrik/politik.html` jatuh begitu saja ke 404 milik adapter. Peta berbasis baris tidak butuh gerbang semacam itu: tanpa grup `berita` tidak ada artefak `index/pengalihan-legacy.json`, dan `readLegacyRedirectMap` sudah menghasilkan `{}` untuk berkas yang hilang.

### Mekanisme mana yang otoritatif untuk URL lawas tingkat kategori

`apps/cms` membawa aset yang sudah ada dan ter-commit untuk URL daftar rubrik/daerah/mitra seputarborneo — `apps/cms/data/seputarborneo-legacy/rubrik-redirects.json` (68 entri, ditangkap 2026-08-26) dan skrip `bun run blog:legacy:rubrik-redirects` yang mengubahnya menjadi payload `POST /api/v1/seo/redirects/import` (issue upstream `awcms` #711 / ADR-0113 di repo itu). Di storefront **ini** aset itu tidak dipakai, dan modul berbasis aturan di atas adalah yang otoritatif untuk setiap URL lawas tingkat kategori: ia tidak butuh baris CMS sama sekali, mencakup seluruh keluarga bentuk (setiap rubrik, ke-14 daerah beserta nama kota lamanya, ke-24 kanal Mitra Borneo dan yang akan datang, anak-anak UMUM, bentuk berpaginasi `/rubriks/?news=&kt=&lanjut=`) alih-alih 68 literal tautan tulisan tangan yang kebetulan tertangkap aset itu, dan menargetkan rute aplikasi ini sendiri. Target aset itu adalah kosakata upstream (`/kategori/daerah`, `/kategori/politik`, …) — di storefront ini `/kategori/{slug}` adalah halaman kategori **produk**, jadi mengimpor baris-baris itu akan mengirim pembaca berita ke toko — dan barisnya akan membawa `origin: "import"` (skrip itu tidak menetapkan `origin`, jadi default rute yang berlaku), yang toh diabaikan `getLegacyRedirectRows()`. Karena itu `blog:legacy:rubrik-redirects` bukan langkah dari runbook repositori ini (`docs/deployment.md`, "Mengimpor seputarborneo"); asetnya sendiri adalah konten subtree upstream dan dibiarkan tak tersentuh.

## `/products` → `/` (301), tidak berubah dari increment 1

URL katalog lama milik situs live, `/products` — dengan atau tanpa query string — tetap redirect ke `/` dengan `301`, dicocokkan hanya pada path (`isProductsRedirect`/`PRODUCTS_REDIRECT_LOCATION` di `apps/storefront/server/penyaji.mjs`). Ini adalah aturan hardcoded terpisah, berbeda dari peta redirect-lawas yang dihasilkan di atas — lihat [ADR-0005](adr/0005-product-urls-match-the-live-sites-shape.id.md).

## Halaman yang terbayangi direktori bernama sama ditulis ulang ke `.html`-nya (issue #75)

Di bawah `build.format: "file"`, halaman landing yang juga punya anak dipancarkan sebagai **file sekaligus direktori** — `dist/client/berita.html` di samping `dist/client/berita/`, `video.html` di samping `video/`, dan `rubrik/{slug}.html` di samping `rubrik/{slug}/` (`feed.xml` rubrik itu dan `halaman/{n}.html`). Static handler `@astrojs/node` menguji direktori *sebelum* meminta file ke `send`: dengan `trailingSlash: "never"`, permintaan berbentuk direktori tanpa garis miring akhir ditulis ulang menjadi `{path}/index.html` — file yang tidak pernah ditulis build ini — sehingga fallback `.html` milik `send` tidak pernah berjalan, adapter jatuh ke SSR, dan `/berita`, `/video`, serta setiap `/rubrik/{slug}` menjawab **404** di situs yang disajikan padahal build-nya hijau. Karena itu `apps/storefront/server/penyaji.mjs` menelusuri `dist/client/` **sekali saat startup** (`discoverShadowedHtmlPaths`, rekursif — bayangan rubrik ada satu tingkat di bawah) untuk menemukan setiap path semacam itu, dan, sebagai langkah *terakhir* sebelum adapter — setelah `/healthz`, redirect `/products`, dan kedua lapisan redirect lawas di atas, yang semuanya tetap didahulukan — menulis ulang `req.url` untuk path-path itu saja menjadi `{path}.html` (`shadowedHtmlUrl`, query string dipertahankan). Ini penulisan ulang internal, bukan redirect: URL pembaca tetap `/berita`, dan pemanggilan `send` milik adapter sendiri tetap menyajikan file itu dengan penanganan traversal, conditional-GET, dan content-type miliknya — tidak ada bagian `penyaji.mjs` yang membaca atau men-stream halaman. Bentuk dengan garis miring akhir (`/berita/`) sengaja diserahkan ke adapter, yang me-301-kannya ke `/berita` seperti sebelumnya. Dicakup oleh `apps/storefront/tests/penyaji-bayangan-html.test.ts` (pohon `dist/` sintetis dan hook `createServer`) dan `apps/storefront/tests/penyaji-bayangan-build-smoke.test.ts` (build nyata berbasis stub yang disajikan oleh bundel `dist/server/penyaji.mjs` yang sesungguhnya).

## Belum dibangun

Path pelacakan-order per-kode (`/pesanan/{code}` — lihat "Commerce runtime" di atas untuk alasan mengapa `?kode=` adalah bentuk sungguhan yang kompatibel-statis). `apps/storefront/tests/e2e/checkout.e2e.ts` (`bun run test:e2e` di dalam `apps/storefront`) sudah ada dan lolos secara lokal, dan kini berjalan sebagai bagian leg `local-ci/e2e-*` (`tools/ci/runners/e2e.ts`, issue #183/#225) — lihat [`docs/pengujian.md`](pengujian.id.md).
