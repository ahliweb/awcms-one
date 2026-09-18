🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](seo.md)

<!-- i18n-source-hash: sha256:56e79bbadf4621fcf6b388c9bb9ca3e8f5899a3825d6ced0fc09a90549133512 -->

# SEO

Apa yang dipancarkan `apps/storefront` untuk mesin pencari dan pratinjau tautan — metadata, data terstruktur, sitemap, feed, dan peta redirect-legacy yang menjaga tautan masuk tetap utuh saat cutover.

## Metadata per-halaman — mekanisme tak berubah dari increment 1

Setiap halaman di-render lewat `BaseLayout`, yang mengatur `<title>`, `<meta name="description">` yang dipotong, `<link rel="canonical">`, dan blok Open Graph tetap (`og:type`, `og:url`, `og:title`, `og:description`, `og:site_name`, `og:locale`). `og:type` tetap `"website"` di halaman produk — data harga/ketersediaan terstruktur lewat JSON-LD sebagai gantinya, bukan meta `product:price:*`, yang tidak dideklarasikan aplikasi ini. Sejak issue #54 (increment 3, A8) `BaseLayout` juga menerima dua prop opsional: `ogType` (`website` sebagai default, `article`, `video.other`) dan `meta` (daftar bertipe pasangan `property=`/`name=` + `content=`, di-render satu `<meta>` per entri, tepat setelah blok tetap). Halaman yang tidak mengirim keduanya me-render `<head>` persis seperti sebelumnya — semua halaman toko begitu — sehingga tag di bawah hanya ada di halaman berita yang memintanya.

## Open Graph dan Twitter Card per jenis halaman (issue #54)

`apps/storefront/src/lib/meta-sosial.ts` membangun tag spesifik-halaman sebagai data polos, pola yang sama dengan pembangun JSON-LD: satu pembangun per `og:type`, sehingga sebuah halaman tak pernah bisa memasangkan `og:type` satu tipe dengan namespace tipe lain (Open Graph diam-diam mengabaikan `article:*` di bawah `video.other`, dan sebaliknya).

| Halaman | `og:type` | Tag yang ditambahkan | Dibangun oleh |
| --- | --- | --- | --- |
| `/berita/{slug}` | `article` | `og:image` + `og:image:width`/`height`/`alt` jika gambar unggulan ter-resolve (`PostDetail.image` dari issue #47); `article:published_time`/`article:modified_time` (nilai ISO 8601 mentah `publishedAt`/`updatedAt` yang sama dengan yang dibawa JSON-LD `NewsArticle`); `article:section` (nama rubrik); satu `article:tag` per tag; `twitter:card` = `summary_large_image` jika ada gambar, `summary` jika tidak; `twitter:title`, `twitter:description` (dipotong 200 karakter), `twitter:image` | `articleSocialMeta(post)` |
| `/video/{slug}` | `video.other` | `og:image` = gambar unggulan pos itu sendiri jika ter-resolve, jika tidak `https://i.ytimg.com/vi/{id}/hqdefault.jpg` — prioritas gambar-unggulan-dulu yang sama dengan yang dipakai `ArtikelCard.astro` untuk thumbnail kartu, dan URL poster yang persis sama yang sudah dimuat kartu dan facade. Sengaja BUKAN `maxresdefault.jpg`: YouTube hanya menyajikannya untuk unggahan yang punya rendisi HD dan menjawab 404 untuk sisanya, dan aplikasi ini tak bisa tahu yang mana — URL yang mungkin 404 di bawah kartu `summary_large_image` persis kartu gambar-besar kosong yang dihindari aturan `twitter:card`; `hqdefault` ada untuk setiap id yang valid; `og:video:url` = `https://www.youtube-nocookie.com/embed/{id}`, pemutar privacy-enhanced yang sama yang dipasang `video-facade.ts` saat diklik; `video:release_date`, satu `video:tag` per tag; `twitter:card` = `summary_large_image` selalu (pos video selalu punya poster) | `videoSocialMeta(post)` |
| `/berita`, `/rubrik/{slug}`, `/daerah/{slug}`, `/mitra/{slug}`, `/video`, `/tag/{slug}`, `/penulis/{slug}`, `/arsip/{yyyy}/{mm}` | `website` | Logo situs (`identity.logoMediaId`, di-resolve lewat `apps/storefront/src/lib/awcms/media.ts`) sebagai `og:image` + dimensi/alt dan kartu `summary` — hanya jika logo benar-benar ter-resolve; logo yang tidak ada atau tidak ter-resolve tidak memancarkan apa pun, meninggalkan blok persis seperti sebelumnya. Diterapkan sekali, di `BeritaLayout.astro` (cangkang yang dilewati setiap halaman berita), tidak pernah di `BaseLayout`, dan itulah yang menjaga blok setiap halaman toko tak berubah | `listingSocialMeta(logo)` |
| `/rubrik/{slug}`, `/rubrik/{slug}/halaman/{n}` | `website` | `<link rel="prev">`/`<link rel="next">`, URL absolut, lewat slot `head` milik `BaseLayout` (diteruskan oleh `BeritaLayout`); `prev` halaman 2 adalah URL `/rubrik/{slug}` polos, tidak pernah `/halaman/1`, sesuai tautan komponen paginasi sendiri; rubrik satu halaman tidak memancarkan keduanya | `rubrikPaginationLinks(slug, page, totalPages)` |
| setiap halaman toko (`/`, `/produk`, `/kategori/{slug}`, `/product/{slug}`, `/halaman/{slug}`, …) | `website` | tidak ada — hanya enam tag tetap, tanpa `og:image`, tanpa `twitter:*`. `apps/storefront/tests/meta-sosial-build-smoke.test.ts` menahan halaman-halaman ini pada snapshot beku blok pra-issue-54, dalam satu build di mana halaman listing berita MEMANG memperoleh gambar logo | — |

Setiap nilai `content` adalah teks CMS (teks alt, nama rubrik atau tag, deskripsi) dan mencapai halaman hanya lewat escaping atribut HTML milik Astro di satu batas render di `BaseLayout` — escaping yang sama yang sudah diandalkan enam tag tetap untuk `og:title`/`og:description`. Tidak ada di jalur ini yang memakai `set:html`, dan `jsonForScript()` (di bawah) sengaja TIDAK diterapkan pada teks atribut: ia menghasilkan escape JSON `\uXXXX`, yang bukan escape HTML dan akan ter-render apa adanya. `og:image` juga diperiksa ulang sebagai URL `http(s)` sebelum dipancarkan, sikap yang sama yang diambil `parseSocialLinks` untuk URL sosial tersimpan.

Dua hal yang dipertimbangkan issue ini dan tidak dilakukan: `noindex` pada halaman rubrik setelah halaman 1 (panduan Google sendiri adalah jangan me-`noindex` arsip berpaginasi — `rel=prev/next` plus canonical yang merujuk diri sendiri per halaman adalah bentuk yang direkomendasikannya), dan `og:image:width`/`height` untuk poster YouTube (aplikasi ini belum mengambilnya dan tidak boleh menyatakan ukuran yang belum dilihatnya).

## JSON-LD berdasarkan jenis halaman

| Halaman | `@type` | Dibangun oleh |
| --- | --- | --- |
| `/` (beranda) | *(tidak ada)* | Beranda tidak memancarkan JSON-LD — pemangkasan cakupan yang disengaja, bukan kelalaian |
| `/product/{slug}` | `Product` + `Offer` bersarang, `AggregateRating` jika rating ada, `BreadcrumbList` | `apps/storefront/src/lib/jsonld-produk.ts` |
| `/kategori/{slug}` | `CollectionPage` + `BreadcrumbList` | `buildCategoryPageSchema()` milik `apps/storefront/src/lib/jsonld-produk.ts` |
| `/berita/{slug}` | `NewsArticle` + `BreadcrumbList` (`@graph`, menggabungkan beberapa node dalam satu blok script) | `apps/storefront/src/lib/jsonld-berita.ts` — author adalah node `Person` jika byline ada, jika tidak `Organization`; publisher selalu `Organization` |

`offers.price` di halaman produk masih string desimal `numeric(14,2)` **mentah**, tanpa format — validator schema.org menghendaki desimal polos, bukan yang diformat-locale. `availability` diturunkan dari `stock` (`InStock`/`OutOfStock`), tidak pernah dibawa sebagai field independen.

## Escaping JSON-LD adalah pertahanan XSS sungguhan, bukan formalitas — tak berubah, kini dijalankan lebih banyak halaman

`jsonForScript()` milik `BaseLayout.astro` mengganti `<`, `>`, dan `&` dengan escape JSON `\uXXXX` sebelum string apa pun pasokan-CMS mencapai blok `<script type="application/ld+json">` — menutup permukaan stored-XSS yang sama yang pertama kali didokumentasikan `docs/seo.md` increment 1 (nama produk/artikel/kategori yang berisi `</script><script>...` jika tidak begitu akan keluar dari blok JSON-LD dan tereksekusi). Setiap emitter JSON-LD baru yang ditambahkan di increment 2 (`Offer`/`AggregateRating` milik `jsonld-produk.ts`, `NewsArticle` milik `jsonld-berita.ts`) melewati `jsonForScript()` yang sama — hanya ada tepat satu fungsi escaping di aplikasi ini, bukan satu per emitter.

## Halaman `noindex`

`checkout`, `pesanan`, `cari`, `wishlist`, dan `keranjang` semuanya membawa `<meta name="robots" content="noindex, follow">` lewat slot `head` milik `BaseLayout` — tidak satu pun dari halaman ini seharusnya menjadi tempat hasil pencarian mendaratkan pembaca secara langsung. `robots.txt` juga men-`Disallow` fetch untuk kelima path yang sama plus `/api/`.

## Sitemap dan feed

`registerSitemapSource(name, source)` milik `apps/storefront/src/lib/sitemap.ts` mendaftarkan fungsi penghasil-URL bernama; dua belas sumber didaftarkan di seluruh katalog dan berita (`static-routes`, `static-pages`, `berita-front`, `berita-posts`, `berita-video`, `berita-rubrik`, `berita-daerah`, `berita-mitra`, `berita-tag`, `katalog-produk`, `katalog-kategori`, `katalog-product-detail`). `chunkSitemapEntries` membagi hasil gabungan menjadi chunk berisi maksimal 5.000 URL masing-masing; `sitemap-index.xml` mendaftar berkas `/sitemap-{n}.xml` hasilnya. `feed.xml` (produk) dan `berita/feed.xml` + `rubrik/{slug}/feed.xml` per-rubrik (berita, RSS 2.0, `content:encoded`) adalah feed terpisah yang dibangun tangan, bukan sumber sitemap.

## Peta redirect-legacy

Setiap URL masuk seputarborneo (`/news/{id}-{slug}.html`) atau beritasampit (`/{yyyy}/{mm}/{dd}/{slug}/`) diresolusi terhadap peta yang dibangun dari baris `awcms_seo_redirects` milik `apps/cms` sendiri dan dilayani dengan `301` sungguhan oleh `apps/storefront/server/penyaji.mjs` — lihat [`docs/routing.md`](routing.id.md) untuk mekanisme persisnya. Ini adalah jawaban increment 2 untuk baris "belum dibangun: sitemap, feed, robots.txt" milik increment 1 — ketiganya kini ada, dan peta redirect ini yang membuat cutover dari platform legacy mana pun tidak berbiaya setiap tautan dan bookmark yang terindeks.

## URL kanonik

Setiap URL kanonik masih absolut, dibangun dari `SITE_URL`, sesuai bentuk URL situs live untuk produk — lihat [ADR-0005](adr/0005-product-urls-match-the-live-sites-shape.id.md).

## Belum dibangun

Data terstruktur untuk halaman listing katalog (`/produk`) itu sendiri — hanya halaman kategori dan halaman detail produk yang membawa JSON-LD. `og:image` di halaman TOKO mana pun (`/`, `/produk`, `/kategori/{slug}`, `/product/{slug}`, `/halaman/{slug}`) — issue #54 membangun mekanisme tag-nya dan memakainya di setiap halaman berita, tapi `images[].publicUrl` milik DTO produk belum dihubungkan ke sana, dan fallback logo situs sengaja dibatasi ke cangkang berita agar blok halaman toko terbukti tak berubah pada gelombang ini. `defaultSocialMediaId` milik profil situs komposit — field "gambar bagikan default" yang memang dibuat CMS untuk tujuan ini — belum dimunculkan oleh `apps/storefront/src/lib/awcms/profil.ts`, sehingga fallback listing memakai `logoMediaId` untuk saat ini; menghubungkan `defaultSocialMediaId` lebih dulu, dengan logo sebagai fallback-nya, adalah langkah lanjutan yang wajar. Namespace Open Graph `product:price:*` (node `Offer` JSON-LD membawa ini sebagai gantinya, secara sengaja, sesuai "Metadata per-halaman" di atas).
