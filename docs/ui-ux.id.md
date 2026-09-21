🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](ui-ux.md)

<!-- i18n-source-hash: sha256:0f13faca254b0d569ecc3854fde918f3ec97d18f1e0155b947763ebb1db6f60d -->

# UI / UX

Keputusan desain visual dan interaksi storefront yang cukup mengikat untuk perlu dijelaskan, alih-alih menyatakan ulang setiap aturan CSS di `apps/storefront/src/styles/`.

## Gambar produk kini ada — "tanpa gambar, di mana pun" milik increment 1 tidak lagi berlaku

`awcms_commerce_product_images` (issue #23) memberi `CommerceProduct` field `images[]` sungguhan, diresolusi lewat `media_library` menjadi URL publik, dan halaman detail produk (`/product/{slug}`) me-render galeri gambar. `apps/storefront` masih belum punya klien `media_library` sendiri untuk **chrome situs** yang dikelola CMS — logo/favicon storefront sendiri masih belum diresolusi dari `logoMediaId`/`faviconMediaId` (lihat [`docs/cms.md`](cms.id.md)) — tapi **fotografi produk sudah nyata**, dan `img-src` milik CSP kini diturunkan saat build khusus untuk mengizinkannya dengan aman; lihat [`docs/arsitektur.md`](arsitektur.id.md).

## `labelColor`: warna pilihan-CMS, di-render dengan aman — mekanisme tak berubah

`label`/`labelColor` pada produk masih lencana merchandising bebas-bentuk di mana `labelColor` adalah string hex sembarang yang diketik merchandiser. Mekanisme saat-build yang sama dari increment 1 masih berlaku: `apps/storefront/src/profil/toko/pages/product-labels.css.ts` memindai setiap produk, mengumpulkan nilai `labelColor` yang berbeda, dan memancarkan satu stylesheet kecil, same-origin — `style-src 'self'` tidak butuh pengecualian. Kontras dihitung oleh `contrastingForeground()` (berbasis luminansi relatif, memilih mana pun dari hitam/putih yang memberi rasio lebih tinggi), diuji unit di `apps/storefront/tests/warna.test.ts` terhadap setiap warna brand default.

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

## Permukaan akun (issue #90, S2 dari #32)

`/akun/alamat`, `/akun/pesanan`, dan `/akun/ulasan` memperluas shell akun S1 (`/masuk`, `/daftar`, `/akun`) dengan alamat, riwayat pesanan, dan ulasan milik pembeli sendiri. Tiga keputusan yang dibawa dari S1, diterapkan di sini juga:

- **Setiap halaman me-render kedua state dalam markup statis.** Sebuah skrip (`akun-alamat.ts`/`akun-pesanan.ts`/`akun-ulasan.ts`) mengalihkan tamu vs. sudah-masuk berdasarkan `bacaSesi()`, pemisahan yang sama yang sudah ditetapkan `akun.ts` (S1) — HTML itu sendiri tidak pernah memutuskan apa pun yang hanya bisa diketahui JavaScript.
- **Kontrol wilayah dipakai bersama, bukan diduplikasi.** Formulir tambah/edit `/akun/alamat` dan autofill "Pilih alamat tersimpan" milik `checkout.astro` sendiri sama-sama menggerakkan `<select>` provinsi/kota/kecamatan lewat modul YANG SAMA, `apps/storefront/src/lib/wilayah-region-select.ts` — diekstrak dari kode inline cascading-fetch asli `checkout.ts` khusus supaya issue ini tidak perlu salinan kedua.
- **Detail pesanan milik akun sendiri memakai ulang renderer halaman pelacakan tamu.** `apps/storefront/src/lib/pesanan-render.ts` adalah kode pembangun-DOM yang sudah dimiliki `/pesanan` (issue #30), diekstrak sehingga `/akun/pesanan?kode=` me-render `Order` secara identik — minus formulir verifikasi-telepon dan aksi konfirmasi-pembayaran/batalkan, yang tetap rute CMS ber-gerbang-telepon yang tidak disebut issue #86 punya padanan terautentikasi-akun untuknya (pengurangan cakupan yang disengaja, bukan kelalaian).

**Wishlist menjadi ter-sinkron-akun saat sudah masuk, dan tetap lokal jika tidak.** `apps/storefront/src/lib/wishlist-sinkron.ts` adalah fungsi merge MURNI (union berdasarkan `productId`, `addedAt` paling awal menang, dibatasi 200) — saat login, id produk wishlist lokal di-`PUT` ke akun dan salinan lokal diganti dengan gabungan antara yang lokal dan yang dijawab CMS; selagi sudah masuk, `wishlist-tombol.ts` (setiap tombol hati, seluruh situs) dan `wishlist.ts` (daftar `/wishlist`) menulis-tembus ke akun pada setiap tambah/hapus, memperlakukan `localStorage` sebagai cache render alih-alih sumber kebenaran. Logout meninggalkan salinan lokal persis apa adanya. Kegagalan jaringan apa pun terdegradasi menjadi operasi lokal-saja dengan region status `aria-live` bersama yang sopan (`apps/storefront/src/lib/wishlist-akun-sync.ts`) — tombol hati tidak pernah terlihat rusak.

## Permukaan afiliasi (issue #93, S3 dari #32)

`/akun/afiliasi` me-render salah satu dari tiga state dari data build-time dan runtime bersama-sama, tidak pernah spinner-lalu-menebak: **tertutup** (`affiliateProgramEnabled` bernilai `false` saat build — hanya penjelasan singkat, tombol gabung tidak pernah dirender, karena kontrak CMS sendiri menjawab `409 AFFILIATE_PROGRAM_DISABLED` untuk percobaan apa pun); **tamu** (tautan ke `/masuk`/`/daftar`); **sudah masuk** (tombol gabung idempoten saat belum bergabung, jika tidak maka tautan referral dengan tombol salin yang memakai ulang pola salin-kode-voucher, tarif komisi, status, statistik seumur hidup yang diformat lewat `formatPrice`, dan daftar komisi berpaginasi keyset). Penangkapan `?ref={code}` (`apps/storefront/src/scripts/afiliasi-tangkap.ts`, dipasang sekali dari `BaseLayout` di setiap halaman) dan atribusi `affiliateCode` saat checkout sengaja tidak terlihat bagi pembeli — referral diingat dan diteruskan, tidak pernah dimunculkan sebagai langkah UI-nya sendiri di alur keranjang atau checkout.

## Kosakata label-status: satu `Record` kecil per permukaan, tidak pernah enum API mentah

Setiap status moderasi/siklus-hidup yang dirender aplikasi ini diterjemahkan ke Bahasa Indonesia lewat lookup `Record<Status, string>` kecil per-halaman alih-alih satu tabel enum-ke-teks bersama — status ulasan milik `akun-ulasan.ts` (`pending` → "Menunggu moderasi", `published` → "Terbit", `rejected` → "Ditolak"), kedua kosakata milik `akun-afiliasi.ts` sendiri (afiliasi `active`/`suspended` → "Aktif"/"Ditangguhkan"; komisi `pending`/`approved`/`paid`/`void` → "Menunggu"/"Disetujui"/"Dibayar"/"Dibatalkan"), dan `STATUS_LABELS` milik `pesanan-render.ts` untuk status pesanan (dipakai bersama `/pesanan` dan `/akun/pesanan`, tidak berubah increment ini). Setiap lookup jatuh kembali ke nilai API mentah (`?? status`) alih-alih melempar atau tidak me-render apa pun, sehingga status yang belum dikejar teks aplikasi ini — state baru sisi-API, migrasi masa depan — tetap menampilkan sesuatu yang bisa dibaca pembeli.

## Checkout dan pelacakan: payment gateway, berbasis redirect (issue #112, kontrak: #106 D3)

Langkah pembayaran checkout menampilkan **Bayar online (kartu, VA, e-wallet)** setiap kali `paymentMethods[]` milik quote menyertakan `gateway` — sebuah flag tenant (`payment.gatewayEnabled`), sikap "CMS yang memutuskan, aplikasi ini hanya merender apa yang didaftarkannya" yang sama seperti setiap metode pembayaran lain. Memilihnya dan mengirim tetap menempatkan pesanan persis seperti sebelumnya (`POST …/orders` yang sama, keranjang dikosongkan, telepon disimpan ke `sessionStorage`); aplikasi ini kemudian membuat SATU panggilan lagi, `createGatewaySession`, dan mengirim SELURUH tab ke `redirectUrl`-nya (`window.location.assign` — tidak pernah `<iframe>`, tidak pernah `fetch`-lalu-render, sesuai [ADR-0010](adr/0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.id.md)). `redirectUrl` hanya pernah dituju ketika tervalidasi sebagai `https:` — atau `http:`, tapi hanya ketika `PUBLIC_AWCMS_ORIGIN` milik build ini sendiri adalah `http:` (stub lokal/CI repo ini, tidak pernah deployment nyata) — selain itu, atau kegagalan apa pun saat membuat sesi, jatuh ke `/pesanan?kode=…` sebagai gantinya: pesanan sudah ada, jadi ini tidak pernah diperlakukan sebagai kegagalan checkout.

`/pesanan` dan tampilan detail `/akun/pesanan` sama-sama merender tombol **Bayar sekarang** menggantikan instruksi transfer manual untuk pesanan `gateway` yang masih `pending_payment` — mengkliknya membuat (atau, sesuai aturan kontrak sendiri "idempoten per pesanan", membaca ulang) sesi gateway yang sama dan redirect dengan cara yang sama. Selagi tombol itu tampil, baris `aria-live="polite"` membaca "Menunggu konfirmasi pembayaran…", dan halaman melakukan polling pesanan setiap 5 detik (`apps/storefront/src/lib/pesanan-poll.ts`) — berhenti begitu pesanan meninggalkan `pending_payment`, begitu `expiresAt`-nya lewat, setelah 15 menit, atau (jeda, bukan berhenti) selagi tab tersembunyi, dilanjutkan lagi saat `visibilitychange`. Pesanan `paid` memperbarui baris yang sama menjadi "Pembayaran diterima." — countdown-menuju-kedaluwarsa yang sudah ada tetap bekerja tanpa perubahan untuk setiap metode pembayaran lain.

## OTP WhatsApp, persetujuan promo, dan `/akun/pesan` (issue #115, S3 dari #33, kontrak: #106 D5/D8/D9)

`/masuk` merender pilihan kanal — "Kirim kode lewat: E-mail | WhatsApp" — hanya saat `whatsappOtpEnabled` pada pengaturan toko publik bernilai `true` saat build, sikap "CMS yang memutuskan, aplikasi ini hanya merender apa yang bisa dilaksanakannya" yang sama seperti baris payment-gateway `/checkout`. Memilih WhatsApp menukar field identitas menjadi input telepon; kedua kanal selebihnya berbagi formulir dua-langkah yang sama persis (identitas → kode 6 digit) serta penanganan error, termasuk pesan `409 CHANNEL_UNAVAILABLE` baru untuk kanal yang berhenti dikonfigurasi setelah halaman dimuat. Pendaftaran (`/daftar`) tidak pernah mendapat pilihan ini — tetap hanya-e-mail apa pun yang ditawarkan `/masuk`, dengan catatan satu baris menjelaskan alasannya, karena nomor telepon belum menjadi identitas terverifikasi saat pendaftaran (issue #86 sendiri menunda "verifikasi telepon").

`/akun` mendapat kartu "Preferensi Promo": satu kotak centang sungguhan, tersimpan segera saat `change` tanpa perlu tombol "Simpan"-nya sendiri — perubahan status sakelar itu SENDIRI sudah merupakan niat lengkap, berbeda dari formulir "Ubah Nama" multi-field di sampingnya. Ini adalah field `PATCH …/account/me` pertama aplikasi ini yang menulis selain `name`; tipe input `ubahProfil` menjadi `{name?, marketingConsent?}` justru agar kedua pemanggil tidak perlu mengirim ulang field yang tidak sedang diubahnya.

`/akun/pesan` adalah halaman daftar/detail terautentikasi keempat aplikasi ini (setelah `/akun/pesanan`, `/akun/alamat`, daftar komisi `/akun/afiliasi`), memakai ulang bentuk daftar-keyset-plus-detail-`?id=` yang sama persis seperti yang ditetapkan `/akun/pesanan` — pelanggan yang sudah mengenal pola halaman itu (daftar, "Muat lebih banyak", klik ke detail) tidak perlu mempelajari apa pun yang baru di sini. Satu elemen yang sungguh baru adalah lencana belum-dibaca: hitungan kecil pada tiap baris daftar, diberi `aria-label` alih-alih dibiarkan sebagai angka visual polos, dan dibersihkan di sisi server sebagai efek samping membuka thread (tidak pernah aksi "tandai dibaca" terpisah yang harus diingat pelanggan). Thread tertutup merender catatan polos menggantikan formulir balas — tidak pernah textarea `disabled`, yang akan mengundang pelanggan mencoba mengetik pada kontrol yang hanya bisa gagal.

## Belum dibangun

Pengalih locale; keputusan gambar-produk apa pun yang terkait dark mode (media query color-scheme mengatur chrome aplikasi ini sendiri, bukan gambar pasokan-CMS atau `labelColor`).

## Checkout: tarif kurir nyata, dihitung per tujuan (issue #109, kontrak: #106 D4)

Baris kurir pada langkah pengiriman checkout bukan lagi placeholder "segera" permanen — kini merender satu radio per layanan yang sudah dihitung harganya (`{nama} ({etd}) — {harga}`, mis. "JNE REG (2-3 hari) — Rp15.000") begitu `<select>` kecamatan pada langkah alamat memiliki nilai, dan otomatis meng-quote ulang setiap kali kecamatan berubah (termasuk saat alamat tersimpan diisi otomatis, yang mengisi select secara terprogram, bukan lewat event `change` pengguna). Sebelum kecamatan dipilih, saat toko menonaktifkan kurir, atau saat penyedia tidak bisa menghitung tujuan yang dipilih, placeholder tunggal yang dinonaktifkan tetap tampil seperti sebelumnya — `available:false`, `serviceId:null` — namun kini membawa `note` yang menjelaskan salah satu dari tiga alasan itu, ditampilkan sebagai teks bantuan yang terlihat pada baris itu sendiri (`aria-describedby`, bukan sekadar atribut title). Baris status `aria-live="polite"` di atas daftar opsi mengumumkan "Menghitung ongkir…" selagi quote sedang diminta dan pesan kegagalan singkat bila gagal, sehingga pengguna pembaca layar tidak dibiarkan menebak-nebak mengapa daftarnya kosong. `apps/storefront/src/lib/kurir-opsi.ts` adalah satu-satunya tempat sebuah opsi diubah menjadi teks ini — `checkout.ts` hanya mengulang apa yang sudah diputuskan di sana.

## Sistem desain (redesign 2026-09, issue #166) — fondasi saja

**Gelombang 1 dari redesign visual yang lebih luas** (canvas Claude Design "Publik awcms-one" dari `redesign/AWCMS-One Admin dan Publik.zip`, 11 halaman mockup — issue ini hanya membaca markup mockup itu dan chrome-nya, baris 24-86 dan 861-877, tidak pernah mengimplementasikan ulang satu halaman penuh). Issue ini menghadirkan sistem tipografi, token desain, sekumpulan primitif CSS bersama, dan pembaruan chrome situs (utility bar, brand tile, kolom "Kanal" keempat pada footer) — setiap halaman yang memakainya (detail produk, keranjang, checkout, akun) adalah issue lanjutan (#167/#168/#169) yang membangun DI ATAS nama kelas ini, bukan issue ini.

### Sistem tipografi: self-hosted, tiga keluarga

`apps/storefront/public/fonts/` membawa build subset-latin `woff2` (SIL OFL, `apps/storefront/public/fonts/LICENSE-OFL.txt` menyebutkan keluarga/bobot/versi paket persisnya) dari:

| Token | Keluarga | Bobot yang dibawa |
| --- | --- | --- |
| `--font-sans` | Plus Jakarta Sans | 400, 500, 600, 700, 800 |
| `--font-serif` | Lora | 400, 500, 600 (+ 400 italic) |
| `--font-mono` | IBM Plex Mono | 400, 500 |

Tidak ada Google Fonts, tidak ada origin CSP baru: setiap `src` `@font-face` di `apps/storefront/src/styles/global.css` adalah path same-origin `/fonts/*.woff2` (`font-src 'self'`, `apps/storefront/server/penyaji.mjs`, tidak berubah), `font-display: swap` di semuanya, dan `apps/storefront/tests/global-css-fonts.test.ts` membuktikan keduanya. `BaseLayout.astro` hanya mem-preload tiga wajah huruf yang benar-benar tampil di atas lipatan pada halaman biasa — sans 400/600, serif 500 — sisanya dimuat lambat saat pertama dipakai.

### Token (`apps/storefront/src/styles/global.css`)

Warna merek tidak pernah di-hardcode di sini: `--color-primary`/`--color-secondary`/`--color-accent` tetap berasal dari `/theme-tokens.css` (didorong CMS, `apps/storefront/src/pages/theme-tokens.css.ts`), dipakai hanya sebagai LATAR tombol/pill dipasangkan dengan padanan `-foreground`-nya — aturan yang sama yang sudah dinyatakan docblock header berkas ini sebelumnya. Yang ditambahkan issue ini:

| Kelompok | Token |
| --- | --- |
| Pita inverse | `--bg-inverse`, `--bg-inverse-2`, `--text-on-inverse`, `--text-on-inverse-muted`, `--border-on-inverse` |
| Pasangan status lembut | `--status-{success,warning,info,danger,neutral}-bg` / `-fg` (+ `--status-info-border`) |
| Warna tautan | `--link-color`, `--link-hover` (biru langit, terpisah namanya dari `--accent-primary` walau nilainya sama hari ini) |
| Skala radius | `--radius-xs` (8px) … `--radius-full` (999px) |
| Bayangan | `--shadow-sm`/`--shadow-md` (nilai tidak berubah, kini juga dipakai primitif baru) |
| Skala tipe | `--text-xs` (12px, batas bawah AA) … `--text-2xl` (28px) |
| Font | `--font-sans`, `--font-serif`, `--font-mono` |

Setiap token di atas punya padanan `prefers-color-scheme: dark` di blok gelap yang sudah ada — mockup-nya sendiri tidak punya satu pun, jadi setiap nilai gelap dipilih agar tetap mempertahankan maksudnya (status warning lembut tetap terbaca amber-di-atas-amber-gelap, bukan sekadar pasangan mode-terang diulang mentah).

### Primitif (`apps/storefront/src/styles/global.css`, didokumentasikan di puncak berkas itu sendiri)

Semuanya ADITIF — setiap kelas yang sudah ada sebelum issue ini (`.card`, `.cart-count`, `.wishlist-button`, `.stock-badge`, `.label-badge`, `.empty-state`, …) tidak berubah sedikit pun.

| Kelas | Apa itu |
| --- | --- |
| `.btn`, `.btn--primary`/`--secondary`/`--quiet`, `.btn--md`/`--sm` | Tombol — terisi warna merek, outline, teks-saja; tinggi 44/40/36px |
| `.pill`, `.pill--success`/`--warning`/`--info`/`--danger`/`--neutral`/`--label` | Badge status/label bulat kecil di atas token status lembut |
| `.band-inverse` | Permukaan gelap (utility bar, footer) |
| `.field-label`, `.is-mono` | Pembungkus label formulir; font monospace untuk input kode/telepon/kode pos |
| `input[type=…]`, `select`, `textarea` | Kontrol 42px (semua formulir produk/checkout sudah menargetkan tinggi ini; kini digerakkan token) |
| `.stepper`, `.stepper--lg` | Kontrol qty −/n/+, 38px dan 46px |
| `.radio-card` | Kartu terpilih selebar penuh, dibangun dari `<input type="radio">` + `<label>` sungguhan |
| `.segmented` | Baris tab/langkah berbobot sama, `[aria-current="true"]` menandai yang aktif |
| `.section-title` | Judul bagian halaman dengan meta/hitungan ekor opsional |

`.card` dan `.empty-state` sudah ada sebelumnya (increment 1) dan dipakai ulang apa adanya — issue ini tidak mendefinisikan ulang keduanya.

### Chrome situs

- **Utility bar** (`Header.astro`, hanya grup `toko`): "Lacak pesanan", "Berita" (hanya saat grup `berita` JUGA aktif di build ini), "Akun saya" — di atas `.band-inverse`. Slot notifikasi gratis-ongkir milik mockup dengan sengaja TIDAK dirender: itu adalah teks yang didorong pengaturan toko (`shippingSettings.freeShipping`, `apps/storefront/src/lib/awcms/pemasaran.ts`) yang tidak disambungkan issue ini ke fetch waktu-build header, dan mengarang salinan Bahasa Indonesia sebagai gantinya justru kesalahan yang diperingatkan aturan repo ini sendiri.
- **Brand tile**: huruf pertama nama situs, `aria-hidden`, di atas `--color-primary`, di samping tautan wordmark yang sudah ada (nama aksesibel `.site-brand` tidak berubah).
- **Alat header**: tombol "Cari" pencarian, pill hitungan keranjang (`--color-accent`), dan tautan wishlist sudah bernada merek sebelum issue ini (`.search-form button`/`.cart-count` milik increment 1) dan tidak berubah.
- **Footer**: kolom "Kanal" keempat (Katalog/Flash Sale/Berita/Program Afiliasi), setiap entri digerbangi `isRouteActive` (`apps/storefront/src/config/profil.ts`) persis seperti setiap tautan footer sadar-profil lainnya — build `landing`/khusus-`berita` tidak merender kanal apa pun yang tidak punya rute untuknya. Footer sendiri kini berada di atas `.band-inverse`, dan baris bawahnya berbunyi `© TAHUN nama · Semua harga dalam Rupiah` plus catatan "Bahasa Indonesia · html lang="id"" milik mockup sendiri.

### Batas aksesibilitas

Tidak ada teks dalam sistem desain ini yang dirender di bawah `--text-xs` (12px) — caption 10-11px milik mockup sendiri (`#94a3b8` pada 10px, yang gagal WCAG AA) menjadi 12px `--text-muted`/`--status-*-fg` di semua tempat. Lihat [`docs/aksesibilitas.md`](aksesibilitas.md) untuk detail kontras dan target sentuh.
