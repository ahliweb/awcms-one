🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](seo.md)

<!-- i18n-source-hash: sha256:5d560391c526cf63545b36986080ad034b870d6e996b9a17e6aacbdc5202a1c5 -->

# SEO

Apa yang dipancarkan `apps/storefront` untuk mesin pencari dan pratinjau tautan — metadata, data terstruktur, sitemap, feed, dan peta redirect-legacy yang menjaga tautan masuk tetap utuh saat cutover.

## Metadata per-halaman — mekanisme tak berubah dari increment 1

Setiap halaman di-render lewat `BaseLayout`, yang mengatur `<title>`, `<meta name="description">` yang dipotong, `<link rel="canonical">`, dan tag Open Graph (`og:type` tetap `"website"` bahkan di halaman produk — data harga/ketersediaan terstruktur lewat JSON-LD sebagai gantinya, bukan meta `product:price:*`, yang tidak dideklarasikan aplikasi ini). `BaseLayout` sendiri masih belum memancarkan tag `og:image` di halaman mana pun — issue #47 (`apps/storefront/src/lib/awcms/media.ts`) memberi `PostDetail` berita sebuah `image.publicUrl` yang sudah ter-resolve yang bisa dipakai tag `og:image`, tapi menambahkan tag itu sendiri adalah perubahan terpisah dan menyusul ke head slot `BaseLayout`.

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

Data terstruktur untuk halaman listing katalog (`/produk`) itu sendiri — hanya halaman kategori dan halaman detail produk yang membawa JSON-LD. TAG `og:image` di halaman mana pun — aplikasi ini sekarang punya klien CMS-media (`apps/storefront/src/lib/awcms/media.ts`, issue #47) dan gambar berita yang sudah ter-resolve untuk dituju, tapi memancarkan tag itu sendiri adalah perubahan `BaseLayout` terpisah yang tidak dilakukan issue ini. Namespace Open Graph `product:price:*` (node `Offer` JSON-LD membawa ini sebagai gantinya, secara sengaja, sesuai "Metadata per-halaman" di atas).
