🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0005-product-urls-match-the-live-sites-shape.md)

<!-- i18n-source-hash: sha256:31fb31c50af2ba4e8d49f4ffac051d6cc6451a6b855719f7e658c65768f53b22 -->

# ADR-0005 — URL produk mengikuti bentuk situs live: `/product/{slug}`, tanpa trailing slash, `/products` dialihkan

- **Status:** Diterima
- **Tanggal:** 15 September 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** [issue #5](https://github.com/ahliweb/awcms-one/issues/5), komentar "Scope amendment: match the live site's URL shape" (bukti dan tabel trade-off yang dinyatakan ulang ADR ini); [`apps/storefront/astro.config.mjs`](../../apps/storefront/astro.config.mjs); [`apps/storefront/server/penyaji.mjs`](../../apps/storefront/server/penyaji.mjs); [`docs/routing.md`](../routing.md); [`docs/kamus-data.md`](../kamus-data.md) (batasan migrasi slug yang diciptakan keputusan ini)

## Konteks

Storefront awalnya dibangun dengan `src/pages/[slug].astro` — satu segmen jalur, tanpa namespace. Sebelum itu dirilis, koordinator memeriksa sitemap situs live sendiri:

```
$ curl -sL https://mart.borneojek.com/sitemap.xml | grep -oE '<loc>[^<]+' | sed 's/<loc>//'
https://mart.borneojek.com/products
https://mart.borneojek.com/products?category_slug=kebutuhan-pokok-qy01
…
https://mart.borneojek.com/product/beras-5-kg-dbfc
https://mart.borneojek.com/product/jasa-jemput-kbj1

$ curl -sL -o /dev/null -w '%{http_code}\n' https://mart.borneojek.com/product/beras-5-kg-dbfc
200
```

Situs live mempublikasikan detail produk di `/product/{slug}` (tunggal, ber-namespace, tanpa trailing slash) dan permukaan katalog/filter di `/products`. Bentuk `/{slug}` yang direncanakan semula tidak berbagi jalur dengan keduanya.

## Keputusan

Detail produk dipublikasikan di `/product/{slug}` tanpa trailing slash — bentuk situs live sendiri, bukan desain ulang. `/products`, dengan atau tanpa query string (`?category_slug=…`), 301-redirect ke `/`.

| | `/{slug}/` (sebagaimana awalnya dibangun) | `/product/{slug}` (keputusan ini) |
| --- | --- | --- |
| URL terindeks, bookmark, tautan yang dibagikan saat cutover | semua rusak; butuh peta 301 permanen | dipertahankan 1:1, tanpa peta |
| Tabrakan dengan halaman top-level masa depan (`/tentang`, `/kontak`) | ya | tidak ada — ber-namespace di bawah `/product/` |
| Biaya memutuskan sekarang vs. nanti | — | satu pemindahan berkas + dua baris konfigurasi |

Cutover ke basis data live adalah increment 2, tapi bentuk URL diputuskan **sekarang**, di increment 1, karena dokumentasi ini, `offers.url` JSON-LD `Product`, dan setiap tautan internal storefront ditulis mengikuti bentuk itu dalam perubahan yang sama yang membangun storefront sama sekali — mengubah bentuknya nanti berarti mengubah semuanya sekaligus; mengubahnya sekarang adalah satu penggantian nama.

Tiga bagian mekanis membawa keputusan ini:

1. `src/pages/product/[slug].astro` (dipindah dari `src/pages/[slug].astro`), dengan `canonicalPath` dibangun sebagai `` `/product/${product.slug}` `` dan setiap tautan internal (kartu katalog di `index.astro`, breadcrumb) mengikutinya.
2. `astro.config.mjs`: `trailingSlash: "never"` di seluruh situs (bukan opt-out per-halaman, sehingga halaman masa depan tidak bisa diam-diam memperkenalkan kembali trailing slash) dan `build.format: "file"`, sehingga berkas yang dihasilkan (`dist/client/product/{slug}.html`) dan URL yang dilayani identik byte-demi-byte — tanpa penulisan-ulang directory-index, tanpa 301 antara apa yang diindeks dan apa yang dilayani.
3. `isProductsRedirect` milik `apps/storefront/server/penyaji.mjs`: satu aturan hardcoded, diperiksa sebelum pencarian-berkas adapter berjalan, 301-mengalihkan `/products` (hanya jalur, sehingga query string tidak menggagalkan kecocokan) ke `/`. Ini **bukan** berkas data pengalihan bergaya `asal-pengalihan` yang dipakai keluarga template serupa dan dikecualikan daftar berkas issue #5 sendiri — ia satu aturan bernama yang hidup di berkas yang sama yang sudah mengatur setiap header respons lain, untuk persis satu URL yang dulu dilayani aplikasi ini sendiri.

Parameter query `category_slug` yang mungkin dibawa URL `/products?...` semacam itu **dijatuhkan by design, bukan hilang karena kelalaian**: halaman listing kategori bukan bagian irisan ini (lihat [`docs/routing.md`](../routing.md) dan [`docs/cms.md`](../cms.md) untuk apa lagi yang belum dibangun), jadi tidak ada halaman tersisa untuk diseleksi filter itu.

## Konsekuensi

- **Batasan nyata dan mengikat pada migrasi data increment 2, dicatat di sini agar tidak hilang:** slug live membawa akhiran keunikan 4 karakter yang dihasilkan aplikasi Laravel (`beras-5-kg-dbfc`, `jasa-jemput-kbj1`). Migrasi ke kolom `awcms_commerce_products.slug` **harus membawa slug itu apa adanya, akhiran termasuk** — CMS tidak boleh menghasilkan ulang dari nama produk — atau setiap URL yang dipertahankan ADR ini diam-diam tidak lagi menunjuk ke produk yang seharusnya. Ini dinyatakan dalam huruf tebal di [`docs/kamus-data.md`](../kamus-data.md), tempat pembaca yang membangun migrasi itu benar-benar akan mencarinya.
- `docs/routing.md` mendokumentasikan `/products` sebagai target pengalihan, bukan rute, dan menamai listing kategori sebagai belum dibangun — pembaca yang menemukan `?category_slug=` di bookmark lama dan mengharapkan pemfilteran menemukan "belum dibangun" yang eksplisit alih-alih 404 diam-diam atau filter yang diam-diam tidak melakukan apa-apa.
