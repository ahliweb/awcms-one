🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](responsif.md)

<!-- i18n-source-hash: sha256:ed1c7b23ff8f54795c71897ec357edf279618ec5b72bfc5aaec8a35aa3da6ee1 -->

# Desain responsif

Bagaimana `apps/storefront` berperilaku di berbagai lebar viewport, dan bagaimana itu diperiksa. **Baca ini dulu: setiap klaim di bawah berasal dari membaca `apps/storefront/src/styles/*.css` dan template halaman — tidak ada browser, sungguhan atau headless, yang dibuka untuk memverifikasi layout pada lebar mana pun saat menulis dokumen ini.** `apps/storefront` belum punya uji visual-regression saat ini; ia punya suite e2e Playwright sungguhan (`apps/storefront/tests/e2e/checkout.e2e.ts`), tapi suite itu menguji perilaku checkout, bukan layout pada rentang lebar.

## Sebagian besar fluid, dengan sekumpulan breakpoint kecil yang disengaja

Klaim increment 1 bahwa aplikasi ini sama sekali **tidak** membawa breakpoint lebar-viewport tidak lagi benar — sidebar katalog, nav mobile, dan layout dua-kolom berita masing-masing butuh titik nyata di mana layout berubah bentuk, bukan sekadar reflow:

| File | Breakpoint | Apa yang berubah |
| --- | --- | --- |
| `global.css` | `max-width: 720px` | Layout navigasi mobile |
| `katalog.css` | `max-width: 860px` (×2) | Sidebar `/produk` (`minmax(0,260px) 1fr` → kolom tunggal); collapse grid-produk kedua |
| `katalog.css` | `max-width: 720px` | Pemadatan lanjutan halaman katalog |
| `berita.css` | `min-width: 900px` | **Satu-satunya breakpoint min-width (ke-atas-desktop)** — layout dua-kolom berita (`minmax(0,1fr)` → `minmax(0,2fr) minmax(0,1fr)`) hanya aktif di atas 900px; di bawahnya, kedua kolom bertumpuk, yang merupakan default mobile-first, bukan pengecualian |

Meski begitu, setiap grid kartu/produk tetap CSS Grid fluid dengan `auto-fill`/`auto-fit`, bukan saklar breakpoint:

```css
/* global.css — catalog grid */
grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr));
/* katalog.css — narrower product cards */
repeat(auto-fill, minmax(min(140px, 100%), 1fr));
/* berita.css — news card grid */
repeat(auto-fill, minmax(min(220px, 100%), 1fr));
```

Clamp `min(Npx, 100%)` disengaja di mana-mana: track tetap polos bisa memaksa scroll horizontal begitu pembulatan `box-sizing` atau border menambah sub-pixel lebar; membungkusnya dalam `min(...,100%)` membatasi track pada lebar apa pun yang benar-benar dimiliki grid, sehingga tidak pernah bisa memaksa overflow, sambil berperilaku identik dengan nilai tetap di atas titik itu. `max-width: 1200px` milik `.container` membatasi setiap halaman di layar besar.

## Target sentuh

Setiap kontrol interaktif yang ditambahkan untuk keranjang/checkout/wishlist (tombol, stepper kuantitas, toggle nav mobile) membawa `min-width: 44px` — terverifikasi di `global.css`, `katalog.css` (tiga deklarasi terpisah), sesuai minimum 44px yang sama yang direkomendasikan WCAG 2.5.5 dan panduan platform Apple/Google sendiri, diterapkan secara konsisten alih-alih hanya pada halaman yang kebetulan paling membutuhkannya.

## Apa yang diverifikasi, dan bagaimana

- **Konfirmasi setingkat `grep` untuk setiap query `@media`** di `global.css`, `katalog.css`, `berita.css`, `toko.css` — tabel breakpoint di atas menyeluruh, bukan sampel. `toko.css` (gaya khusus checkout/keranjang) tidak membawa breakpoint lebar sendiri, mengandalkan guard flex-shrink `min-width: 0` sebagai gantinya.
- **Membaca, bukan mengukur, batas-bawah viewport-sempit** untuk setiap grid fluid — penalaran `min(Npx, 100%)` di atas dibaca dari komentar/struktur masing-masing stylesheet sendiri, tidak dikonfirmasi dengan jendela browser terbuka.
- **Tabel layar admin** (`apps/cms/src/pages/admin/commerce.astro`) mendeklarasikan kelas `data-table--stack` untuk perilaku responsifnya sendiri — milik `apps/cms`, bukan storefront ini, dan tidak diperiksa lebih lanjut untuk dokumen ini.

## Belum dibangun

Uji visual-regression otomatis apa pun, atau langkah CI yang me-render storefront pada berbagai lebar viewport. `bun run check` milik `apps/storefront` adalah type-check; suite Playwright menguji perilaku, bukan layout. Langkah berikutnya yang konkret, belum diambil, akan persis jenis pemeriksaan browser-sungguhan yang skill `playwright` di lingkungan ini ada untuk menyiapkannya.
