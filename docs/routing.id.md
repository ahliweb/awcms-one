🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](routing.md)

<!-- i18n-source-hash: sha256:c9bb8f1f2874cadaf0e2836d352b3a790a7bd2c44d92279cdc4e439fcda55783 -->

# Routing

Setiap rute yang dipublikasikan `apps/storefront`, dan bagaimana masing-masing diturunkan. Semuanya statis (lihat [ADR-0002](adr/0002-static-output-with-build-time-fetch-for-the-storefront.md)) — tidak ada keputusan routing sisi-server yang dibuat saat request; semua di bawah ini diputuskan saat `astro build`.

## Rute

| Jalur | Sumber | Diturunkan dari |
| --- | --- | --- |
| `/` | [`apps/storefront/src/pages/index.astro`](../apps/storefront/src/pages/index.astro) | Grid katalog — setiap produk yang dikembalikan `getProducts()` |
| `/product/{slug}` | [`src/pages/product/[slug].astro`](../apps/storefront/src/pages/product/[slug].astro) | Satu halaman per produk, lewat `getStaticPaths()` (di bawah) |
| `/product-labels.css` | [`apps/storefront/src/pages/product-labels.css.ts`](../apps/storefront/src/pages/product-labels.css.ts) | Satu kelas CSS per `labelColor` berbeda yang benar-benar dipakai katalog — lihat [`docs/ui-ux.md`](ui-ux.md) |
| `/products` (query string apa pun) | 301 di [`apps/storefront/server/penyaji.mjs`](../apps/storefront/server/penyaji.mjs) | Mengalihkan ke `/` — lihat di bawah |

## `getStaticPaths()`: satu halaman per produk aktif

```ts
export async function getStaticPaths() {
  const products = await getProducts();
  return products.map((product) => ({
    params: { slug: product.slug },
    props: { product }
  }));
}
```

`getProducts()` ([`apps/storefront/src/lib/catalog.ts`](../apps/storefront/src/lib/catalog.ts)) adalah satu-satunya sumber tempat setiap halaman produk digenerate: ia mengambil dan memoize seluruh katalog sekali per build, lalu menyaring hanya `status === "active"` lewat `switch` exhaustive yang gagal compile begitu `apps/cms` menambah nilai `ProductStatus` kelima tanpa storefront diberi tahu maknanya (lihat [ADR-0004](adr/0004-a-type-only-contract-package-with-an-import-direction-gate.md)). Setiap halaman produk yang pernah dihasilkan build ini karena itu berpadanan dengan persis satu produk hidup, aktif, saat build — tidak ada jalur yang bisa dijangkau produk `draft`, `inactive`, atau `archived`.

## Bentuk URL: `/product/{slug}`, tanpa trailing slash

`astro.config.mjs` mengeset `trailingSlash: "never"` di seluruh situs dan `build.format: "file"`, sehingga berkas yang dihasilkan build ini (`dist/client/product/{slug}.html`) dan URL tempat ia dilayani identik byte-demi-byte — tanpa penulisan-ulang directory-index, tanpa pengalihan antara apa yang diindeks dan apa yang dilayani. Bentuk ini dipilih dengan sengaja untuk mencocokkan URL situs live borneojek-mart yang sudah ada; lihat [ADR-0005](adr/0005-product-urls-match-the-live-sites-shape.md) untuk bukti sitemap-nya dan trade-off terhadap bentuk `/{slug}` yang direncanakan semula.

## `/products` → `/` (301), `category_slug` dijatuhkan by design

URL katalog lama situs live, `/products` — dengan atau tanpa query string seperti `?category_slug=kebutuhan-pokok-qy01` — mengalihkan ke `/` dengan `301`, dicocokkan hanya pada jalur sehingga query string tidak pernah menggagalkan kecocokan (`isProductsRedirect` di `apps/storefront/server/penyaji.mjs`). Ini satu aturan hardcoded di berkas yang sama yang sudah mengatur setiap header respons lain, bukan berkas data-pengalihan hasil-generate. Filter `category_slug` yang mungkin dibawa URL semacam itu **dijatuhkan by design, bukan hilang karena kelalaian** — lihat bagian berikutnya.

## Halaman listing kategori: belum dibangun

Tidak ada rute yang mendaftar produk berdasarkan kategori. `awcms_commerce_categories` ada dan setiap produk membawa `categoryId`, jadi data untuk membangun satu ada — tapi tidak ada apa pun di irisan ini yang membacanya seperti itu; `getCategories()` hanya dipakai untuk resolve nama kategori produk sendiri untuk ditampilkan di halaman detailnya dan di kartu katalog. Pembaca yang mendarat di `/products?category_slug=...` dari bookmark lama mencapai akar katalog, tanpa filter, alih-alih 404 atau filter yang diam-diam diabaikan.

## Belum dibangun

Pencarian, sitemap, feed RSS/Atom, rute `robots.txt` (tidak ada — empat rute yang terdaftar di atas adalah seluruh tabel rute), dan rute apa pun yang membaca `apps/cms` saat request. Setiap rute di atas sepenuhnya ditentukan saat build, tanpa halaman server-rendered mana pun di aplikasi ini.
