🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](ui-ux.md)

<!-- i18n-source-hash: sha256:de5b5a32b2bd08b8954200cf1a4b0fd19e2aed58b553be16f3217c8c14171ce3 -->

# UI / UX

Keputusan desain visual dan interaksi storefront yang cukup mengikat untuk perlu dijelaskan, alih-alih menyatakan ulang setiap aturan CSS di `apps/storefront/src/styles/global.css`.

## Tanpa gambar produk, di mana pun

Baik grid katalog maupun halaman detail produk tidak me-render foto produk. Ini bukan kelalaian untuk diisi nanti dalam cakupan dokumen ini — `CommerceProduct` sama sekali tidak membawa field gambar di irisan ini, karena `product_images` adalah salah satu tabel yang ditunda increment ini (lihat [`docs/skema-basis-data.md`](skema-basis-data.md) dan [`docs/cms.md`](cms.md)). Setiap kartu produk dan halaman detail disusun dari teks (nama, SKU, harga, deskripsi) dan, jika diset, lencana berkode-warna.

## `labelColor`: warna pilihan-CMS, di-render dengan aman

`label`/`labelColor` pada produk adalah lencana merchandising bebas-bentuk — mis. tag "Baru" — di mana `labelColor` adalah **string hex sembarang yang diketik merchandiser**, tanpa palet tetap yang bisa dideklarasikan aplikasi ini sebagai kelas CSS biasa. Dua cara umum menerapkan warna per-instans sembarang — atribut `style="background: ..."` inline, atau blok `<style>` tulisan-tangan — keduanya persis yang ditolak CSP ketat aplikasi ini (`style-src 'self'`, tanpa `'unsafe-inline'`, lihat [`apps/storefront/server/penyaji.mjs`](../apps/storefront/server/penyaji.mjs)) tanpa pengecualian yang sengaja dirancang untuk tidak pernah dibutuhkan aplikasi ini.

Cara ketiga: `apps/storefront/src/pages/product-labels.css.ts` adalah endpoint saat-build yang memindai setiap produk di katalog, mengumpulkan nilai `labelColor` yang berbeda, dan memancarkan satu stylesheet kecil, benar-benar eksternal, same-origin — `.label-bg-1a2b3c { background-color: #1a2b3c; color: ... }` — karena setiap warna di katalog sudah diketahui saat build (keputusan output-statis, [ADR-0002](adr/0002-static-output-with-build-time-fetch-for-the-storefront.md), yang membuat ini mungkin sama sekali). `style-src 'self'` mengizinkannya tanpa pengecualian, karena ia berkas seperti berkas lain yang dipancarkan build ini, bukan sesuatu yang inline.

## Kontras dihitung, bukan diasumsikan

Warna teks lencana tidak di-hardcode putih atau hitam — `contrastingForeground()` (`apps/storefront/src/lib/catalog.ts`) menghitung luminansi relatif WCAG dari warna latar dan memilih mana pun dari hitam murni atau putih murni yang menghasilkan rasio kontras lebih tinggi terhadapnya, alih-alih menguji luminansi terhadap satu ambang titik-tengah (kedua formula kontras, terhadap putih dan terhadap hitam, tidak simetris di sekitar satu titik tetap, jadi ambang tetap memilih opsi yang lebih buruk pada rentang warna nyata). Ini menutup kelas bug nyata yang disebutkan langsung di komentar kode sendiri: mengasumsikan teks putih selalu terbaca pada latar pilihan-merchandiser gagal telak pada warna pucat — tag "Baru" kuning muda dengan teks putih, misalnya.

**Batasan yang dinyatakan, tidak disembunyikan:** untuk warna latar dekat pertengahan rentang luminansi, *tidak ada* hitam murni maupun putih murni yang mungkin mencapai ambang kontras minimum 4,5:1 untuk teks-badan — memilih yang berkontras lebih tinggi adalah yang terbaik yang bisa dilakukan fungsi dari warna latar saja, tanpa mengubah warna pilihan merchandiser, yang tidak dilakukan aplikasi ini secara diam-diam.

`labelColor` yang bukan string hex `#rrggbb` 6-digit bersih (teks bebas, `rgb(...)`, typo) sama sekali **tidak** mendapat kelas hasil-generate — `isValidHexColor()` menolaknya, `labelClassName()` mengembalikan `undefined`, dan produk jatuh kembali ke gaya `.label-badge` polos yang sudah ada di `global.css`. Satu nilai warna buruk merchandiser menurunkan latar satu lencana; ia tidak menggagalkan build.

## Presentasi stok dan harga

`formatPrice()` me-render `price` (string desimal `numeric(14,2)`, lihat [ADR-0003](adr/0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md)) lewat `Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR" })` — satu-satunya tempat aplikasi ini pernah mengonversi string harga ke angka, langsung diumpankan ke formatter tanpa overload string dan tidak pernah disimpan atau dikombinasikan ulang. `discountPercent` ditampilkan sebagai persentase yang dikirim awcms ("Diskon 20%"), tidak pernah sebagai harga-diskon yang dihitung — aplikasi ini tidak melakukan aritmetika harga di mana pun, jadi tidak pernah harus menciptakan aturan pembulatan yang mungkin berbeda dari apa pun yang dihitung checkout masa depan. Stok ditampilkan sebagai lencana biner — "Stok tersedia" / "Stok habis" — diturunkan dari `stock > 0`, bukan hitungan numeriknya sendiri.

## Bahasa: Indonesia, tanpa syarat

Setiap string yang menghadap pengguna di aplikasi ini ditulis langsung dalam Bahasa Indonesia (`<html lang="id">`, "Katalog Produk", "Stok tersedia", "Lewati ke konten utama") — tidak ada framework i18n, tidak ada pengalih locale, dan tidak ada salinan berbahasa Inggris di mana pun pada output yang di-render. Ini aplikasi yang lebih kecil dari template `awcms-astro`/`media-lenterakalteng` serupa yang menjadi modelnya, yang memang membawa mesin multi-locale; storefront ini tidak membutuhkannya dan tidak membawanya.

## Belum dibangun

Gambar produk jenis apa pun, UI category-browse (lihat [`docs/routing.md`](routing.md)), afordansi keranjang atau checkout apa pun, pengalih locale, dan keputusan gambar-produk khusus-mode-gelap apa pun (media query color-scheme di `global.css` mengatur chrome aplikasi sendiri, bukan warna pasokan-produk seperti `labelColor`, yang di-render sebagaimana diset merchandiser tanpa memandang tema OS pembaca).
