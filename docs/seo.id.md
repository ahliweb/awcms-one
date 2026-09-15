🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](seo.md)

<!-- i18n-source-hash: sha256:7cda4db5fa8b9a907bfb961ec4237f822ec6c93e98ea9e24519fa767de61df59 -->

# SEO

Apa yang dipancarkan `apps/storefront` untuk mesin pencari dan pratinjau tautan, dibaca langsung dari [`apps/storefront/src/layouts/BaseLayout.astro`](../apps/storefront/src/layouts/BaseLayout.astro) dan [`src/pages/product/[slug].astro`](../apps/storefront/src/pages/product/[slug].astro) — dua berkas yang bertanggung jawab atas semua di bawah ini.

## Metadata per-halaman

Setiap halaman di-render lewat `BaseLayout`, yang mengeset: `<title>` (judul halaman, atau `{title} — {siteConfig.name}` bila keduanya berbeda), `<meta name="description">` dipotong 160 karakter, `<link rel="canonical">` dibangun dari `siteConfig.siteUrl` (`SITE_URL`) ditambah `canonicalPath` halaman itu sendiri, dan tag Open Graph (`og:type` tetap `"website"`, `og:url`, `og:title`, `og:description`, `og:site_name`, `og:locale` tetap `id_ID`). Tidak ada `og:image`: `CommerceProduct` tidak membawa field foto-produk di irisan ini (lihat [`docs/cms.md`](cms.md)), dan mempublikasikan `og:image` yang menunjuk ke berkas yang tidak ada akan lebih buruk daripada meniadakan tag itu.

`og:type` tetap `"website"` bahkan di halaman produk — tipe `"product"` Open Graph hanya valid berdampingan dengan prefiks namespace-nya sendiri dan tag meta `product:price:*`, tidak satu pun dideklarasikan aplikasi ini. Data harga/ketersediaan terstruktur lewat JSON-LD `Product` (di bawah), bukan lewat meta OG, jadi mengimplementasikan setengah-jalan tipe produk OG akan kurang benar, bukan lebih.

## JSON-LD `Product` pada halaman detail

`src/pages/product/[slug].astro` membangun satu node `Product` per produk:

```json
{
  "@type": "Product",
  "name": "...", "sku": "...", "description": "...", "category": "...",
  "offers": {
    "@type": "Offer",
    "url": "https://mart.borneojek.com/product/...",
    "price": "150000.00",
    "priceCurrency": "IDR",
    "availability": "https://schema.org/InStock"
  }
}
```

`offers.price` adalah string desimal `numeric(14,2)` **mentah** yang dikirim awcms — tidak diformat, karena properti `price` schema.org menginginkan desimal polos (`"150000.00"`), bukan yang diformat-locale (`"Rp150.000"`), dan validator data-terstruktur Google menolak yang belakangan. `priceCurrency` hardcoded `"IDR"`. `availability` **diturunkan dari `stock`** — `InStock` ketika `stock > 0`, `OutOfStock` sebaliknya — tidak pernah dibawa sebagai field yang bisa diperselisihkan `apps/cms` sendiri secara independen.

## Escaping JSON-LD adalah pertahanan XSS nyata, bukan formalitas

`schema` dibangun dari string yang dipasok CMS (`name` produk, `description`, `name` kategori). `JSON.stringify` meng-escape kutip dan backslash tapi **tidak** `<` — dan *parser* HTML, bukan mesin JavaScript, mengakhiri elemen `<script>` pada urutan byte `</script>` pertama yang ditemuinya, tidak peduli atribut `type` apa yang dibawa tag itu. Produk bernama `…</script><script>alert(1)</script>` jika tidak akan menutup blok JSON-LD lebih awal dan mengubah teks setelahnya menjadi markup nyata dan tereksekusi: permukaan stored-XSS yang hanya dijaga CSP di `apps/storefront/server/penyaji.mjs` (`script-src 'self'`) — perlindungan nyata, tapi bukan yang seharusnya diandalkan halaman sebagai *satu-satunya* perlindungan.

`jsonForScript()` milik `BaseLayout.astro` menutup ini dengan mengganti `<`, `>`, dan `&` dengan escape JSON `\uXXXX`-nya sebelum nilai ditulis ke halaman — tidak satu pun dari ketiganya bermakna di dalam string JSON, jadi bentuk yang di-escape ter-parse kembali identik byte-demi-byte, sambil tidak memberi parser HTML `<` apa pun untuk pernah memulai tag. Ini dibuktikan lewat fixture regresi, bukan sekadar diargumentasikan dalam komentar: `apps/storefront/tests/fixtures/awcms/products.json` membawa fixture bernama `XSS-REGRESI-01` khusus untuk menguji jalur ini.

## URL kanonik dan pengalihan

Setiap URL kanonik absolut, dibangun dari `SITE_URL`, dan mengikuti bentuk URL situs live — lihat [ADR-0005](adr/0005-product-urls-match-the-live-sites-shape.md) dan [`docs/routing.md`](routing.md) untuk bentuk `/product/{slug}` dan pengalihan `/products` → `/` yang dipertahankannya.

## Belum dibangun

Sitemap, feed RSS/Atom, `robots.txt`, data terstruktur untuk halaman listing katalog itu sendiri (hanya halaman detail produk yang membawa JSON-LD `Product`), dan permukaan SEO apa pun yang akan butuh request runtime ke `apps/cms` — semua di atas diputuskan sekali, saat build.
