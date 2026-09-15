🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](aksesibilitas.md)

<!-- i18n-source-hash: sha256:2ac1c67ff5d1d8bd18e63e287d83c839ad3c7a62e4ec8f01d279b1ba61e46910 -->

# Aksesibilitas

Apa yang dilakukan `apps/storefront` untuk aksesibilitas, dan bagaimana itu diperiksa. **Baca bagian ini dulu: setiap klaim di bawah ini diverifikasi dengan membaca HTML hasil-build dan sumbernya dengan tangan — bukan dengan menjalankan axe, Lighthouse, atau alat aksesibilitas otomatis lainnya.** Tidak ada alat semacam itu yang tersambung ke build atau gate aplikasi ini hari ini. Di mana cakupan otomatis akan menangkap lebih banyak daripada yang bisa ditangkap pembacaan manual, celah itu nyata dan disebutkan di sini alih-alih diam-diam dianggap tidak ada oleh daftar yang terdengar meyakinkan.

## Apa yang sudah ada

- **Skip link.** `BaseLayout.astro` me-render `<a class="skip-link" href="#main-content">Lewati ke konten utama</a>` sebagai elemen pertama yang bisa di-focus di `<body>`, menargetkan `<main id="main-content">` — pengguna keyboard atau screen reader bisa melompati header dan navigasi di setiap halaman.
- **Satu `<h1>` per halaman, sengaja tidak dimiliki layout bersama.** `BaseLayout.astro` tidak me-render heading-nya sendiri — docblock-nya menyatakan ini eksplisit sebagai kontrak yang sengaja tidak dipenuhinya, justru agar halaman di dalam `<slot />` bisa memiliki `<h1>` tunggal tanpa shell ini bersaing dengannya. `<h1>` halaman katalog adalah "Katalog Produk"; `<h1>` halaman produk adalah nama produk itu sendiri.
- **Elemen `<a>` nyata untuk setiap kartu produk**, baik di grid katalog (`index.astro`) maupun tidak ada tempat lain yang butuh (halaman produk tidak punya kartu sendiri) — tidak pernah `<div>` dengan click handler. Kartu bisa di-focus keyboard dan dijangkau daftar-tautan screen reader by construction, bukan lewat peran ARIA tambahan yang menggantikan tautan nyata.
- **`aria-hidden="true"` pada glyph yang murni dekoratif** — pemisah breadcrumb (`/`) dan ikon stock-badge/empty-state membawanya, sehingga screen reader tidak mengumumkan karakter yang sendirinya tidak menyampaikan apa-apa.
- **`aria-label` pada dua landmark navigasi yang membutuhkannya** — nav utama (`aria-label="Navigasi utama"`) dan breadcrumb halaman-produk (`aria-label="Remah roti"`), sehingga daftar landmark screen reader membedakan keduanya satu sama lain dan dari header/footer.
- **`aria-current="page"` pada item breadcrumb saat ini**, sehingga teknologi bantu bisa membedakan halaman saat ini dari tautan sebelumnya tanpa bergantung pada styling visual saja.
- **`prefers-reduced-motion: reduce` dihormati** — `apps/storefront/src/styles/global.css` membawa media query untuknya (diverifikasi: `grep -n "prefers-reduced-motion" src/styles/global.css`), sehingga pembaca yang meminta sistemnya mengurangi gerakan tidak diperlihatkan animasi yang didefinisikan aplikasi ini tanpa memandang preferensi itu.
- **Semantik tabel pada daftar produk admin** — tabel produk `apps/cms/src/pages/admin/commerce.astro` memakai `<caption>`, header tabel `scope="col"`, dan atribut `data-label` untuk tata letak stacked responsifnya, meski layar itu bagian dari `apps/cms` (lihat [`docs/cms.md`](cms.md)), bukan storefront ini.

## Apa yang tidak diperiksa

Tidak ada jalankan axe, tidak ada audit aksesibilitas Lighthouse, tidak ada penelusuran screen-reader dengan teknologi bantu nyata (VoiceOver, NVDA, JAWS, TalkBack), dan tidak ada sesi navigasi keyboard-saja yang dilakukan untuk dokumen ini. Kontras warna untuk lencana `labelColor` pilihan-merchandiser *dihitung* — lihat `contrastingForeground` di [`docs/ui-ux.md`](ui-ux.md) — tapi perhitungan itu tidak diverifikasi ulang secara independen terhadap alat pemeriksa-kontras saat menulis dokumen ini; itu properti kode yang dibaca, bukan hasil yang diukur di sini.

## Belum dibangun

Tes, gate, atau langkah CI otomatis khusus-aksesibilitas apa pun untuk aplikasi ini — `bun run check` milik `apps/storefront` men-type-check aplikasi; ia tidak menjalankan audit aksesibilitas. Menambahkannya (axe-core di CI, atau anggaran Lighthouse) adalah tindak lanjut yang masuk akal namun belum diambil.
