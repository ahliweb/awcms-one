🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](responsif.md)

<!-- i18n-source-hash: sha256:3a741be488045396b39bc19a4c928a53be4a2c4cb71684d6c0c13100459a422d -->

# Desain responsif

Bagaimana `apps/storefront` berperilaku di berbagai lebar viewport, dan bagaimana itu diperiksa. **Baca ini dulu: setiap klaim di bawah kini diverifikasi oleh pemeriksaan browser otomatis sungguhan, bukan sekadar dengan membaca `apps/storefront/src/styles/*.css` dan template halaman secara manual.** `apps/storefront/tests/e2e/responsif.e2e.ts` (issue #183) membuka setiap halaman kunci profil build aktif di peramban Chromium sungguhan pada 360px (mobile) dan 1280px (desktop) dan menegaskan `document.documentElement.scrollWidth <= window.innerWidth` — kondisi persis yang menghasilkan scrollbar horizontal yang tak diinginkan. `.github/workflows/e2e.yml` menjalankannya untuk ketiga profil build pada setiap push (belum menjadi status check wajib — lihat komentar milik workflow itu sendiri); bagian "Playwright e2e" milik `docs/pengujian.md` adalah rujukan tier lengkapnya. `apps/storefront` masih belum punya baseline visual-regression yang di-commit — `apps/storefront/tests/e2e/screenshots.e2e.ts` menangkap screenshot halaman penuh untuk dilihat manusia, sengaja tidak pernah dibandingkan byte demi byte (lihat docblock spec itu sendiri untuk alasannya).

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

## Akun pelanggan: tanpa breakpoint tersendiri, fluid seperti yang lain

`apps/storefront/src/styles/akun.css` (`/masuk`, `/daftar`, `/akun*`, issue #88/#90/#93) tidak membawa query `@media` sendiri — terverifikasi dengan membaca berkasnya: setiap aturan tidak bergantung lebar, dan target ukuran 44px `min-height` yang sama yang disebut komentar header stylesheet-nya sendiri diterapkan seragam di setiap kontrol (input kode OTP, kolom formulir alamat, tombol gabung afiliasi), tidak digerbangi breakpoint apa pun. Grid kartu-navigasi dashboard akun adalah `grid-template-columns: repeat(auto-fill, minmax(180px, 1fr))` — mekanisme reflow `auto-fill` yang sama yang dipakai grid katalog dan berita, tanpa clamp overflow `min(Npx, 100%)` tambahan yang dibawa keduanya (tidak dibutuhkan di sini: track 180px tidak pernah mendekati lebar viewport ponsel itu sendiri), sehingga tetap kolaps menjadi sesedikit satu kolom pada lebar ponsel tanpa breakpoint sendiri.

## Chrome redesign 2026-09 (issue #166)

Utility bar (`Header.astro`) dan kolom "Kanal" baru pada footer (`Footer.astro`) sama-sama memakai pola fluid yang sudah didokumentasikan di atas — `flex-wrap: wrap` dengan `gap`, tanpa breakpoint baru. Grid footer (`.site-footer-grid`, `grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr))` tidak berubah) sekadar mendapat kolom kelima yang mungkin (Kanal, di samping kolom Informasi yang digerbangi profil) dan mengalir ulang persis seperti empat kolom yang sudah ada. `.stepper`/`.radio-card`/`.segmented` (primitif baru, `global.css`) semuanya adalah baris flex berukuran intrinsik tanpa breakpoint sendiri — sikap "fluid sampai ada alasan nyata untuk berubah bentuk" yang sama yang sudah dijelaskan dokumen ini.

## Apa yang diverifikasi, dan bagaimana

- **Peramban sungguhan mengukur overflow sungguhan** (`apps/storefront/tests/e2e/responsif.e2e.ts`, issue #183) pada 360px dan 1280px, untuk setiap halaman kunci setiap profil build — inilah sekarang sumber utama untuk "apakah halaman ini overflow", bukan pembacaan setingkat `grep` di bawah.
- **Konfirmasi setingkat `grep` untuk setiap query `@media`** di `global.css`, `katalog.css`, `berita.css`, `toko.css` — tabel breakpoint di atas menyeluruh, bukan sampel. `toko.css` (gaya khusus checkout/keranjang) tidak membawa breakpoint lebar sendiri, mengandalkan guard flex-shrink `min-width: 0` sebagai gantinya.
- **Penalaran `min(Npx, 100%)` clamp sendiri** dibaca dari komentar/struktur masing-masing stylesheet sendiri — masih benar, dan kini didukung pemeriksaan 360px di atas yang sungguh menjalankannya.
- **Tabel layar admin** (`apps/cms/src/pages/admin/commerce.astro`) mendeklarasikan kelas `data-table--stack` untuk perilaku responsifnya sendiri — milik `apps/cms`, bukan storefront ini, dan tidak diperiksa lebih lanjut untuk dokumen ini.

## Dua bug overflow sungguhan yang ditemukan jalankan otomatis pertama (issue #183)

Keduanya diperbaiki di `apps/storefront/src/styles/katalog.css`, di token/komponen alih-alih patch satu-off:

- **Baris rentang harga sidebar filter `/produk`** (`.filter-price-range`) secara tak sengaja adalah flex KOLOM, bukan baris — ia juga membawa class `.filter-field`, yang aturan `flex-direction: column`-nya adalah satu-satunya yang menetapkan properti itu, sehingga `flex: 1`/`min-width: 0` pada kedua field `<input type="number">`-nya menyusutkan TINGGI-nya (sumbu utama kolom), bukan lebarnya; tiap input berada pada default intrinsiknya sendiri ~190px, jauh melewati viewport 360px. Diperbaiki dengan mendeklarasikan `flex-direction: row` secara eksplisit pada `.filter-price-range`.
- **Breakpoint satu-kolom halaman yang sama** (`@media (max-width: 860px) { .listing-layout { grid-template-columns: 1fr; } }`) tetap overflow bahkan setelah perbaikan di atas: track `1fr` polos adalah singkatan `minmax(auto, 1fr)`, dan minimum otomatis track itu tetap pada ukuran min-content item terbesar terlepas dari `min-width: 0` yang ditetapkan pada ITEM grid (`.listing-sidebar` sudah membawanya, dan itu tidak cukup dengan sendirinya). Diperbaiki dengan `minmax(0, 1fr)`, yang juga menghapus batas track itu sendiri.

## Belum dibangun

Baseline visual-regression yang di-commit — `apps/storefront/tests/e2e/screenshots.e2e.ts` (issue #183) menangkap PNG halaman-penuh per halaman kunci per viewport (diunggah sebagai artifact CI oleh `.github/workflows/e2e.yml`) untuk dilihat manusia, sengaja tidak pernah dibandingkan byte demi byte terhadap jalankan sebelumnya (rendering font lintas-OS membuat itu flaky secara konstruksi, dan layanan visual-diff yang di-hosting adalah dependensi eksternal berbayar yang tidak dimiliki repo ini).
