🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](responsif.md)

<!-- i18n-source-hash: sha256:0db6b59cbaae60a7312a3806997b566919459d18d93ed4c3af1488f203491e5d -->

# Desain responsif

Bagaimana `apps/storefront` berperilaku di berbagai lebar viewport, dan bagaimana itu diperiksa. **Baca ini dulu: setiap klaim di bawah ini berasal dari membaca `apps/storefront/src/styles/global.css` dan template halaman — tidak ada browser, nyata atau headless, yang dibuka untuk memverifikasi tata letak pada lebar mana pun saat menulis dokumen ini.** `apps/storefront` tidak punya suite Playwright, tidak punya tes visual-regression, dan tidak punya langkah CI khusus-responsif hari ini.

## Fluid, bukan berbasis breakpoint

Grid katalog (`.grid-cards` di `apps/storefront/src/styles/global.css`) memakai CSS Grid dengan `auto-fill`, bukan sekumpulan breakpoint `@media` tetap:

```css
grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr));
```

Jumlah kolom adalah fungsi dari lebar yang tersedia, dihitung browser pada setiap lebar, bukan sekumpulan kecil tata letak pilihan-tangan yang beralih pada ambang pilihan-tangan. Klem `min(280px, 100%)` disengaja: pada viewport sempit, track `280px` telanjang bisa memaksa scroll horizontal begitu pembulatan `box-sizing` atau border menambah bahkan sub-pixel lebar. Membungkusnya dalam `min(..., 100%)` membatasi track pada lebar apa pun yang benar-benar dimiliki grid, sehingga ia tidak pernah bisa memaksa overflow, sambil berperilaku identik dengan `280px` tetap di atas titik itu. `max-width: 1200px` milik `.container` sendiri membatasi grid di layar besar tanpa breakpoint juga.

## Apa yang diverifikasi, dan bagaimana

- **Konfirmasi level-`grep` bahwa tidak ada breakpoint `@media (min-width:` / `@media (max-width:` di `apps/storefront/src/styles/global.css`** — satu-satunya query `@media` yang ada adalah `(prefers-color-scheme: dark)` dan `(prefers-reduced-motion: reduce)`, tidak satu pun soal lebar viewport. Responsivitas tata letak karena itu properti dari grid fluid dan tata letak flex di seluruh stylesheet, bukan properti sistem breakpoint yang bisa dienumerasi dokumen ini.
- **Membaca, bukan mengukur, batas bawah 320px.** Komentar stylesheet sendiri di samping `.grid-cards` bernalar eksplisit soal kasus viewport-sempit (track yang di-klem `min()` untuk menghindari overflow paksa di ujung bawah lebar yang didukung) — dokumen ini mengulang penalaran itu karena dibaca di sumbernya, bukan karena jendela browser selebar 320px dibuka dan diukur.
- **Tabel layar admin** (`apps/cms/src/pages/admin/commerce.astro`) mendeklarasikan kelas `data-table--stack` dengan atribut `data-label` per-sel — teknik CSS konvensional untuk mengubah tabel menjadi tata letak kartu-stacked di bawah suatu lebar — tapi ini milik `apps/cms`, bukan `apps/storefront`, dan breakpoint-nya sendiri (jika ada) tidak diperiksa untuk dokumen ini.

## Belum dibangun

Tes responsif atau visual-regression otomatis apa pun — Playwright, alat screenshot-diff, atau langkah CI yang me-render storefront pada berbagai lebar viewport. `bun run check` milik `apps/storefront` adalah type-check; ia tidak menyatakan apa pun soal tata letak ter-render pada lebar mana pun. Langkah konkret berikutnya, belum diambil, adalah persis jenis pemeriksaan browser-nyata yang ada untuk didirikan skill `playwright` di lingkungan ini.
