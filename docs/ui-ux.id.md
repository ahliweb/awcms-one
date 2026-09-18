🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](ui-ux.md)

<!-- i18n-source-hash: sha256:5c020e1b1425fc1c456dc250dc18e875e3fc0571248718c891b6883e1c90d2cf -->

# UI / UX

Keputusan desain visual dan interaksi storefront yang cukup mengikat untuk perlu dijelaskan, alih-alih menyatakan ulang setiap aturan CSS di `apps/storefront/src/styles/`.

## Gambar produk kini ada — "tanpa gambar, di mana pun" milik increment 1 tidak lagi berlaku

`awcms_commerce_product_images` (issue #23) memberi `CommerceProduct` field `images[]` sungguhan, diresolusi lewat `media_library` menjadi URL publik, dan halaman detail produk (`/product/{slug}`) me-render galeri gambar. `apps/storefront` masih belum punya klien `media_library` sendiri untuk **chrome situs** yang dikelola CMS — logo/favicon storefront sendiri masih belum diresolusi dari `logoMediaId`/`faviconMediaId` (lihat [`docs/cms.md`](cms.id.md)) — tapi **fotografi produk sudah nyata**, dan `img-src` milik CSP kini diturunkan saat build khusus untuk mengizinkannya dengan aman; lihat [`docs/arsitektur.md`](arsitektur.id.md).

## `labelColor`: warna pilihan-CMS, di-render dengan aman — mekanisme tak berubah

`label`/`labelColor` pada produk masih lencana merchandising bebas-bentuk di mana `labelColor` adalah string hex sembarang yang diketik merchandiser. Mekanisme saat-build yang sama dari increment 1 masih berlaku: `apps/storefront/src/pages/product-labels.css.ts` memindai setiap produk, mengumpulkan nilai `labelColor` yang berbeda, dan memancarkan satu stylesheet kecil, same-origin — `style-src 'self'` tidak butuh pengecualian. Kontras dihitung oleh `contrastingForeground()` (berbasis luminansi relatif, memilih mana pun dari hitam/putih yang memberi rasio lebih tinggi), diuji unit di `apps/storefront/tests/warna.test.ts` terhadap setiap warna brand default.

## Presentasi harga: lima angka, tidak pernah dihitung di sisi klien

Produk kini membawa `price`, hingga tiga harga tingkat (`priceLevel2/3/4`), dan `finalPrice` hasil hitung server — plus, saat flash sale berlaku, harga flash-sale yang diambil dari `GET /flash-sales/active`. `apps/storefront` masih **tidak melakukan aritmetika harga sendiri**: setiap angka yang ditampilkan persis apa yang dihitung `apps/cms`, diformat lewat `Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR" })` (`formatPrice()`, kini di `apps/storefront/src/lib/harga.ts` — aturan yang dijaga-grep milik aplikasi ini sendiri bahwa ini adalah *satu-satunya* berkas yang mengonversi string harga menjadi angka, ditegakkan oleh uji unit atas `src/`). Halaman keranjang dan checkout mengutip-ulang setiap baris terhadap `apps/cms` secara live (`POST .../cart/quote`) alih-alih mempercayakan angka milik halaman statis sendiri ke dalam pesanan — lihat [ADR-0007](adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.id.md).

## Pemilih varian, size chart, formulir layanan, dan catatan langganan/digital

Halaman detail produk me-render, jika ada: pemilih varian (berbasis atribut, mis. ukuran/warna, tiap varian membawa harga/stok sendiri), catatan asuransi (`withInsurance`/`insuranceRequired`/`insuranceFee`), size chart (`none`/gambar/tabel, sesuai `sizeChartType`), field formulir intake produk layanan (`serviceForm`), dan catatan periode langganan atau unduhan digital. Tidak satu pun dari ini menghitung apa pun — semuanya me-render persis bentuk yang dikembalikan `apps/cms`, aturan "tanpa aritmetika di aplikasi ini" yang sama diperluas ke setiap field baru, bukan dilonggarkan untuknya.

## Keranjang adalah kontrak lokal-browser

`apps/storefront/src/lib/keranjang-kontrak.ts` mendefinisikan bentuk keranjang: kunci `localStorage` `awcms-one:keranjang:v1`, `{id, lines, updatedAt}`, event `keranjang:berubah` yang dipicu pada setiap penulisan (badge jumlah-keranjang header mendengarkannya). `id` milik keranjang sendiri berfungsi ganda sebagai kunci idempotensi pesanan checkout — klik "buat pesanan" yang terkirim ganda tidak bisa membuat dua pesanan, karena klien mengirim kunci yang sama kedua kalinya dan penyimpanan `awcms_idempotency_keys` milik `apps/cms` mengenali pengulangan itu (lihat [`docs/api.md`](api.id.md)).

## Presentasi stok dan harga pada kartu

Stok masih ditampilkan sebagai lencana biner — "Stok tersedia" / "Stok habis" — diturunkan dari `stock > 0`, bukan hitungan numeriknya. `discountPercent` masih ditampilkan sebagai persentase yang dikirim `apps/cms`, tidak pernah sebagai harga-diskon hasil hitung klien.

## Bahasa: Indonesia, tanpa syarat — tak berubah

Setiap string yang menghadap pengguna ditulis langsung dalam Bahasa Indonesia (`<html lang="id">`) — tidak ada framework i18n, tidak ada pengalih locale, dan tidak ada salinan berbahasa Inggris di mana pun pada output yang di-render, termasuk setiap string keranjang/checkout/pelacakan-pesanan/wishlist baru yang ditambahkan di increment 2.

## Permukaan berita, sebagaimana dibentuk increment 3

Halaman berita bukan lagi chrome katalog yang diisi artikel. Keduanya kini punya header sendiri (bilah utilitas berisi tanggal WIB, kontak, dan ikon akun resmi; nav delapan item; **panel Daerah**, yang selalu dirender penuh oleh server dengan keempat belas kabupaten/kota dan hanya *dilipat* oleh skrip, sehingga pembaca tanpa JavaScript tetap melihat semua tautannya; ticker "Terkini"), footer sendiri (kolom Rubrik/Umum/Daerah, direktori 24 Mitra, leaderboard di atas footer, tautan ke atas), serta **satu sidebar bersama** di setiap halaman berita berkolom samping — daftar bertab Terbaru/Mitra Borneo, tiga slot iklan, kotak buletin, awan tag.

Empat keputusan di dalam permukaan itu layak dibawa terus:

- **Slot iklan yang tidak terisi tidak merender apa pun.** Bukan bingkai kosong, bukan placeholder — kotak placeholder di situs rujukan adalah gejala inventarisnya, bukan tujuan desain.
- **"Terpopuler" nyata atau tidak ada sama sekali.** Ia memeringkat dari rollup milik `visitor_analytics` dan jatuh ke "terbaru" secara diam-diam di kode, tidak pernah mengumumkan peringkat yang tak didukung datanya.
- **Pemutar baca-nyaring hanya ditawarkan di tempat ia berfungsi.** Kartunya dikirim `hidden` dan baru dibuka ketika peramban benar-benar punya `speechSynthesis` beserta suaranya; sorotan yang digambarnya saat membaca berupa outline, sehingga artikel tidak pernah bergeser di bawah orang yang sedang mendengarkan.
- **Lambang lembaga milik lembaga itu.** Satu unggahan melayani seluruh artikel kanal tersebut, dan artikel yang lembaganya tak punya lambang memang tidak punya ([ADR-0014](adr/0014-the-institution-owns-the-emblem-not-the-post.md)).

## Belum dibangun

Pengalih locale; keputusan gambar-produk apa pun yang terkait dark mode (media query color-scheme mengatur chrome aplikasi ini sendiri, bukan gambar pasokan-CMS atau `labelColor`); perbandingan tarif kurir live saat checkout (opsi kurir di-render sebagai "segera" — dinonaktifkan — menunggu [issue #33](https://github.com/ahliweb/awcms-one/issues/33), lihat [ADR-0010](adr/0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.id.md)).
