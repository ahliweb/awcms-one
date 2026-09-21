🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](ui-ux.md)

<!-- i18n-source-hash: sha256:a1772073b7fb609f329dc1ca70489248f093993eb8a0c90b5f26b769014e62ef -->

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

### Halaman commerce (issue #167)

**Gelombang 2**, dibangun sepenuhnya di atas primitif issue #166 di atas — tidak ada token baru, tidak ada kelas primitif baru, hanya halaman pemakainya yang didesain ulang. Markup/CSS saja: setiap kontrak klien (`toko-klien.ts`, `keranjang-kontrak.ts`, `wishlist-kontrak.ts`, alur quote/pesanan checkout) tidak berubah, dan setiap nama kelas yang diperiksa test yang sudah ada dipertahankan.

#### Beranda (`apps/storefront/src/profil/toko/Beranda.astro`)

Slider CMS (`getActiveSliders()`) kini merender setiap slide di permukaan `.band-inverse` sebagai kartu hero: badge `.pill--success` "Slider dikelola CMS", judul/subjudul slide itu sendiri, dan dua tautan sungguhan — CTA utama ke `linkUrl` slide (jatuh ke `/produk` bila slide tidak punya satu pun) dan CTA sekunder outline ke katalog. `<a class="slider-slide">` tunggal yang dulu membungkus seluruh slide kini menjadi `<div>` dengan dua tautan sungguhan yang bisa difokus terpisah, karena satu slide bukan lagi satu target sentuh raksasa — sesuai komposisi dua-CTA milik mockup sendiri. Strip flash sale kini menjadi pita lembut amber (`--status-warning-bg`/`-fg`); kartu unggulan/rekomendasi adalah hasil desain ulang `ProductCard.astro` sendiri (bagian berikutnya).

#### Kartu produk (`apps/storefront/src/components/katalog/ProductCard.astro`)

Dipakai oleh beranda, `/produk`, `/kategori/[slug]`, dan daftar terkait di detail produk — didesain ulang sekali. `.card-badges` mengelompokkan pill label/flash/stok dalam satu baris; `.card-price-row` menampilkan harga "semula" + persentase diskon hanya saat `product.discountPercent > 0` (tidak pernah coretan yang direkayasa — `finalPrice` sudah menjadi angka setelah diskon, ADR-0003); `.card-tier-line` menampilkan "Grosir mulai {formatPrice(priceLevel2)}" hanya saat produk benar-benar punya harga level-2 (tidak ada angka kuantitas-minimum yang direkayasa — DTO produk awcms tidak punya kolom semacam itu). Hati wishlist (`.wishlist-button`, saudara dari `.card`, kontrak atribut data tidak berubah) menjadi 44px di sini lewat aturan `.card-wrap .wishlist-button` berspesifisitas lebih tinggi di `katalog.css`, sementara kelas telanjang `global.css` tetap 32px untuk apa pun yang tidak ikut serta.

#### Katalog (`/produk`, `/kategori/[slug]`)

Kartu filter sidebar dan baris `CategoryTree.astro` didesain ulang — kotak penanda dekoratif di samping tiap baris kategori memberinya bentuk sekilas yang sama dengan checkbox milik mockup, tapi tetap `<a>` sungguhan (aturan fallback yang didokumentasikan issue ini sendiri: "tautan biasa" saat tidak ada kontrak pemfilteran multi-pilih untuk ditambahkan tanpa mengubah perilaku klien `produk-listing.ts`). Kontrol urutkan/rentang-harga/stok memakai primitif baru `.field-label`/`.is-mono`/`.btn`; selector `data-filter-*` yang dibaca `produk-listing.ts` tidak berubah.

#### Detail produk (`/product/[slug]`)

Badge berkelompok di atas judul; tabel harga bertingkat kini berada dalam `.tier-box` (kartu bernada info-lembut, `--status-info-bg`/`-border`/`-fg`); stepper qty/tambah-ke-keranjang memakai tampilan `.stepper--lg`/`.btn btn--primary` di atas perilaku `data-qty-*`/`data-add-to-cart` yang sama; tombol `[data-wishlist]` (bentuk atribut data yang sama dengan `ProductCard.astro`) kini duduk di samping "Tambah ke Keranjang" — delegasi event situs-lebar `wishlist-tombol.ts` menyambungkannya tanpa perubahan skrip. Deskripsi kini mendahului tabel size chart (keduanya didesain ulang), dan aksi bagikan memakai nada `.btn`. **Tidak ada daftar ulasan per-produk yang dirender**: kontrak awcms tidak punya `GET …/storefront/reviews` (`openapi/modules/commerce.openapi.yaml` — hanya `POST` anonim, menunggu moderasi), jadi satu-satunya sinyal ulasan nyata di halaman ini tetap baris rata-rata rating + jumlah terjual yang sudah ada; mengarang kartu ulasan berarti menampilkan teks/penulis yang tidak pernah dikirim CMS.

#### Keranjang (`/keranjang`)

Tata letak dua kolom `.cart-layout` (kartu baris + voucher di kiri, `.cart-summary` lengket-di-desktop di kanan, satu kolom di bawah 900px). `renderLines` milik `keranjang.ts` kini membangun kontrol `.stepper` −/n/+ (sebuah `<output>`, tidak bisa diketik langsung — pertukaran afordansi, bukan perubahan alur data) yang memanggil `updateCartLineQuantity` yang sama, plus `.toko-line-sum` rata-kanan dari `quoteLine.lineTotal` (tidak pernah dihitung di sisi klien). Kondisi kosong memakai primitif bersama `.empty-state` dengan CTA "Mulai belanja".

#### Checkout (`/checkout`)

Baris pill langkah yang dekoratif dan **non-interaktif** (`<span data-step-pill>`, bukan tab `.segmented` — sebuah langkah di sini bukan jalan pintas melewati validasi kolom-wajib formulir) berada di atas formulir; `showStep()` yang sudah ada di `checkout.ts` kini juga memperbarui `aria-current` pada pill yang cocok, di samping bagian `[data-step]` sungguhan yang selalu ditogelnya. Kolom telepon/kode-pos memakai `.is-mono`. Opsi pengiriman dan pembayaran — dibangun oleh `renderShippingOptions`/`renderPaymentOptions` yang SAMA — didesain ulang menjadi baris bergaya `.radio-card` murni lewat CSS (`.toko-shipping-option`/`[data-payment-options] .toko-field`, persis nama kelas yang sudah diberikan fungsi-fungsi itu).

#### Pelacakan (`/pesanan`)

Input telepon/kode pesanan memakai `.is-mono`. Pill status (`renderOrder` milik `pesanan-render.ts`) kini bernada sesuai status pesanan sungguhan (`pill--warning` saat menunggu pembayaran, `pill--success` setelah selesai, `pill--danger` bila dibatalkan, …) alih-alih warna tetap — renderer bersama yang sama juga dipakai tampilan detail `/akun/pesanan`, sehingga halaman itu mendapat penyesuaian nada pill status yang sama secara cuma-cuma. Pita "Bayar sekarang" tampil persis saat kondisi gateway-pending yang sudah ada (`renderPaymentSection`) bernilai benar; tidak ada yang berubah dari kondisi itu.

#### Wishlist (`/wishlist`)

Sebuah pita info menyatakan perilaku sinkronisasi yang sungguhan (`wishlist-akun-sync.ts` sudah menulis ke akun saat masuk — bukan salinan baru). Setiap kartu mendapat tautan "Ke keranjang" di samping hapus — navigasi sungguhan ke halaman produk, **bukan** `addToCart()` langsung: `WishlistItem` (`wishlist-kontrak.ts`) tidak membawa cuplikan `minPurchase`/`maxQuantity`/`sku`, sehingga tidak ada kuantitas/stok yang jujur untuk ditambahkan tanpa mengambil ulang data, dan halaman produklah tempat penambahan itu sudah terjadi dengan benar.

### Halaman akun & afiliasi, di-redesain (issue #168)

**Wave 2**, dibangun di atas fondasi issue #166 di atas — hanya markup/CSS, `apps/storefront/src/profil/toko/pages/akun/**`, `masuk.astro`, `daftar.astro`, `apps/storefront/src/styles/akun.css`, dan kode pembangun-DOM milik skrip akun sendiri (`src/scripts/akun*.ts`, `afiliasi*.ts` tidak disentuh, `pesan.ts`/`alamat.ts`/`ulasan.ts`/`pesanan.ts` di bawah prefiks `akun-`). Klien sesi bearer (`akun-sesi.ts`/`akun-klien.ts`) dan setiap kontrak pengambilan data tidak berubah.

- **Shell akun**: satu avatar tile (inisial di atas `--bg-inverse`, `.akun-avatar`), nama dan e-mail akun (`.akun-identity-name`/`.akun-identity-meta.is-mono`), dan `.btn.btn--secondary` "Keluar" — baris header `/akun` sendiri (`.akun-shell-head`).
- **Navigasi samping** (`.akun-sidenav`/`.akun-sidenav-item`): Ringkasan/Pesanan/Alamat/Pesan/Ulasan/Afiliasi, item 38px, `aria-current="page"` menandai halaman saat ini (nilai statis nyata per halaman — tidak pernah dihitung di sisi klien). Markup identik diduplikasi di seluruh enam halaman akun pada frontmatter masing-masing, alih-alih difaktorkan ke partial berawalan `_`: `listPageFiles` milik `integrations/profil.mjs` (dipakai `apps/storefront/tests/profil-integrasi.test.ts` untuk menegakkan matriks profil `docs/template.md`) mendaftar setiap berkas di bawah `src/profil/toko/pages/**` tanpa memandang prefiks `_` yang dilewati pemindaian rute Astro sendiri, sehingga sebuah partial tanpa rute sendiri akan butuh baris matriks yang tidak ada. Tidak ada lencana belum-dibaca pada "Pesan": tidak ada klien di aplikasi ini yang mengekspos jumlah total percakapan belum-dibaca (hanya `unreadForCustomer` milik setiap thread sendiri, berpaginasi) — lencana di sini berarti menebak total yang tidak bisa dihitung halaman ini secara jujur.
- **Ringkasan**: tiga ubin statistik (`.akun-stat-grid`/`.akun-stat-card`) — "Pesanan" dan "Sedang berjalan" (pesanan mana pun yang bukan `completed`/`cancelled`/`expired`) dari halaman pertama pesanan akun sendiri, "Wishlist" dari wishlist akun sendiri — keduanya fungsi `akun-klien.ts` yang sudah ada (`ambilPesananAkun`, `ambilWishlistAkun`), tanpa endpoint baru. Checkbox preferensi promo (issue #115) perilakunya tidak berubah, hanya di-restyle ke `.akun-card`.
- **Peta corak pill-status**, dipakai bersama oleh pesanan/ulasan/afiliasi/komisi: `pending → warning`, `paid`/`published`/`approved`/`completed`/`active → success`, `cancelled`/`expired`/`rejected`/`void`/`suspended → danger`, `processing`/`shipped → info` (`.pill`/`.pill--*`, primitif milik issue #166 sendiri).
- **Pesanan**: baris (`.akun-order-row`) — kode pesanan mono, tanggal · jumlah item, satu pill status, total, dan tautan "Detail" `.btn.btn--secondary`.
- **Alamat**: kartu (`.akun-address-card`) dengan lencana "Utama" `.pill.pill--success`, tombol `.btn` Ubah/Hapus (Hapus dalam `--status-danger-fg` lewat `.akun-btn-danger`), dan tombol putus-putus `.akun-address-add` "+ Tambah alamat".
- **Pesan**: baris thread (`.akun-thread-row`) — subjek, jumlah belum-dibaca `.pill.pill--info`, glyph panah, dan `lastMessageAt` · status sebagai baris meta. Tanpa cuplikan: `GET …/account/conversations` tidak pernah mengembalikan pratinjau pesan terakhir suatu thread, hanya `lastMessageAt` — menampilkan satu berarti mengarang teks yang tidak pernah diberikan ke klien ini.
- **Ulasan**: kartu (`.akun-review-card`) — nama produk, rating numerik plus glyph bintang mono dalam `--text-rating` (token baru yang didefinisikan lokal oleh stylesheet ini, `#b45309`/`#fbbf24` gelap — `global.css` sendiri tidak disentuh), dan satu pill status.
- **Afiliasi**: satu pill status plus tarif komisi yang terdaftar, tautan referral dalam kotak mono putus-putus (`.akun-affiliate-link-box`, sebuah `<input readonly>` yang benar-benar bisa difokus di dalamnya, tidak pernah teks polos) dengan tombol salin "Salin"/"Tersalin!" (perilaku tidak berubah), empat ubin statistik, dan tabel komisi (`.akun-commission-table`/`-row`) dengan "Muat lebih banyak" — semuanya memakai ulang primitif ubin-statistik dan pill yang sama dengan Ringkasan/Pesanan.
- **Masuk/Daftar**: kontrol formulir 42px `global.css` yang sama, `.field-label` pada setiap label, `.is-mono` pada input telepon/OTP, `.akun-otp-input` untuk kode 6 digit, dan `.btn.btn--primary`/`--quiet` pada tombol kirim/kirim-ulang.

Setiap kontrol mempertahankan hook `data-*` yang sudah ada sebelumnya (`tests/akun-*`, `tests/afiliasi-*`, `apps/storefront/tests/pesan-build-smoke.test.ts` menguji hook itu, tidak pernah nama kelas) — issue ini tidak mengubah satu pun assersi uji, hanya markup/CSS di sekeliling hook yang sudah diuji itu.

### Chrome berita, beranda berita, dan artikel (issue #169)

Dibangun di atas token/primitif di atas — tidak ada perubahan pada `apps/storefront/src/styles/global.css` itu sendiri; setiap aturan di bawah ini hidup di `apps/storefront/src/styles/berita-chrome.css`/`berita.css`/`dengar.css`/`bagikan.css`, yang hanya dimuat pada halaman yang merender `BeritaLayout.astro` (`apps/storefront/src/layouts/BeritaLayout.astro`), tidak pernah pada halaman toko/landing. Sumber: mockup yang sama, baris 59-86 (chrome), 718-782 (beranda berita), 784-857 (artikel).

**Dua token baru, dibatasi pada `berita-chrome.css`** — bukan `--color-primary` yang digerakkan CMS, sehingga warna zamrud sebuah deployment bermerek BjekMart tidak pernah menjadi identitas visual desk berita:

| Token | Terang | Gelap | Dipakai oleh |
| --- | --- | --- | --- |
| `--news-bar-bg` | `#111827` | `#030712` | Bilah tanggal (`BilahUtilitas.astro`) |
| `--news-accent` | `#dc2626` | `#f87171` (AA di atas `--news-bar-bg`) | Garis bawah nav aktif, garis bawah tab, pil "TERKINI" |

**Chrome berita**: bilah tanggal (`BilahUtilitas.astro`) memakai `--news-bar-bg`, mono (`--font-mono`), membawa tanggal yang dirender di sisi klien (tidak berubah — lihat dokblok komponen itu sendiri untuk alasan nilai ini tidak boleh menjadi nilai waktu-build) plus akhiran statis "· WIB", dan — hanya saat grup `toko` JUGA aktif di build ini (`isGroupActive("toko")`, `apps/storefront/src/config/profil.ts`) — "Ke toko" dan "Akun". "Akun" memakai ulang kontrak `[data-akun-tautan]`/`[data-akun-label]` milik `Header.astro`; `apps/storefront/src/scripts/akun-header.ts` dipasang kedua kalinya, dari `BeritaLayout.astro`, sehingga skrip yang sama menjaga tautan akun kedua chrome tetap selaras. Masthead (`NavBerita.astro`) menetapkan nama situs dalam `--font-serif` pada 26px, dengan kicker mono di sampingnya dari `identity.description` (field `tagline` milik CMS — lihat `apps/storefront/src/lib/awcms/profil.ts`) saat CMS memiliki satu yang dikonfigurasi. Item nav utama yang aktif mendapat garis bawah `--news-accent` 2px (`border-bottom`, bukan `text-decoration`) menggantikan garis bawah bernada merek yang dipakainya sebelum issue ini. Ticker "Terkini" (`Ticker.astro`) kini berupa pita terang dengan hanya label "TERKINI" sebagai pil `--news-accent` yang membawa titik berdenyut (`prefers-reduced-motion: reduce` membekukannya — animasi sungguhan kali ini, berbeda dari kisah reduced-motion "tanpa marquee" milik ticker sendiri sebelumnya untuk daftar judul itu sendiri), dan setiap judul terpotong satu baris dengan elipsis, bukan pita gulir-horizontal yang dipakainya sebelum ini.

**Beranda berita** (`HalamanDepanBerita.astro`, data/urutan bagian tidak berubah): blok headline mendapat label "Headline" (`.berita-hero__lencana`) dan judul Lora 28px; setiap kartu dalam grid 6-kartu mendapat judul Lora dan eyebrow rubrik langit (`--link-color`) huruf besar — `berita.css` menimpa `.card-title`/`.card-eyebrow` generik milik `global.css`, aman hanya karena file itu dimuat khusus pada layout ini. Sidebar (`Sidebar.astro`) mempertahankan tab **Terbaru / Mitra Borneo** yang teruji (lihat dokblok komponen itu sendiri untuk alasan pasangan "Terbaru / Terpopuler" milik mockup tidak diimplementasikan issue ini — `sidebar-build-smoke.test.ts` mengunci panel Mitra Borneo sebagai konten nyata yang teruji); bagian "Terpopuler" yang selalu tampil mendapat indeks mono 2-digit berpadding-nol (`decimal-leading-zero`) dan judul Lora. Kartu buletin kini berada di atas `.band-inverse`, membungkus `FormBuletin` opt-in ganda yang sama, tidak berubah. Panel Daerah, direktori Mitra Borneo, dan setiap slot iklan tidak tersentuh dalam penempatan dan perilaku — hanya digaya ulang, lewat cascade token yang sama.

**Artikel** (`ArtikelView.astro`): judul memakai Lora 32px (`.article-header h1`); paragraf lede kini dirender dari `post.excerpt` saat CMS memilikinya (tanpa fetch baru — field itu sudah ada pada `PostSummary`/`PostDetail`); baris byline mendapat inisial avatar dekoratif (dua kata pertama `post.authorByline`) dan tanggalnya dirender dalam `--font-mono`. Baris bagikan (`BarisBagikan.astro`/`bagikan.css`) mempertahankan target sentuh 44px-nya — batas aksesibilitas repo ini sendiri — dan hanya mengubah bentuk, `border-radius: 50%` → `var(--radius-s)` (kotak membulat, bukan 34px literal milik mockup). Pemutar "Dengarkan berita ini" (`PemutarDengar.astro`/`dengar.css`/`dengar.ts`) mendapat bilah progres visual 4px sungguhan (`data-dengar-progres-bar`) yang lebar isiannya kini juga ditetapkan `tulisProgres()` milik `dengar.ts` yang sudah ada, dari angka indeks-unit yang sama yang sudah diubahnya menjadi teks live-region `data-dengar-progres` — tanpa komputasi progres baru, hanya rendering visual kedua dari angka yang sama. Isi artikel memakai `--font-serif` pada 16px/1,85 (`.article-body`); sebuah blockquote (pull-quote) mempertahankan garis kiri `--color-primary` 3px-nya — warna merek yang digerakkan CMS, dengan sengaja, karena pull-quote berada dalam konten editorial toko itu sendiri — kini dengan kutipan Lora miring di atas latar belakang halus. "Produk terkait dari toko" (mockup baris 850) **tidak diimplementasikan** dalam issue ini: tidak ada apa pun di aplikasi ini hari ini yang mengorelasikan sebuah artikel dengan sekumpulan produk, dan aturan issue ini sendiri melarang penambahan fetch waktu-build baru untuk mengarang korelasi itu — issue lanjutan yang merancang hubungan itu (pilihan manual? tag bersama?) dapat menambahkan kotak sidebar itu begitu ia ada.

### Admin (redesign 2026-09, issue #171)

**Repo dan mockup yang berbeda dari setiap gelombang di atas**: gelombang 166/167/169 me-restyle `apps/storefront` (situs publik) di atas kanvas "Publik awcms-one"; gelombang ini me-restyle layar admin `commerce` milik `apps/cms` sendiri (`apps/cms/src/pages/admin/commerce*.astro`) di atas kanvas "Admin awcms-one", memakai primitive bersama yang ditambahkan subtree sync issue #170 (awcms#813 upstream) ke `apps/cms/src/styles/admin.css` — rel sidebar gelap plus `.admin-stat-card`, `.admin-status-pill`, `.admin-segmented`, `.admin-bulk-bar`, `.admin-two-pane`, `.admin-toggle`, `.admin-timeline`, dan `.admin-media-grid`. Issue ini tidak menambah primitive baru sendiri; setiap layar di bawah hanya memakai apa yang sudah dikirim #170. Lihat bagian "Layar admin: dua belas, mencakup setiap izin" milik [`docs/cms.md`](cms.md) untuk detail per layar dan tabel rute.

**Aturan yang diikuti di seluruh bagian ini: hanya data nyata, tak pernah angka placeholder atau baris karangan.** Layar dashboard baru (`/admin/commerce-dashboard`) secara eksplisit menghilangkan stat tingkat konversi karena belum ada proyeksi funnel/kunjungan untuk menghitungnya, alih-alih menampilkan persentase karangan; setiap stat card lain membaca tabel yang sudah ada atau proyeksi laporan penjualan yang sudah ada (issue #117). Pil status provider baru milik layar settings (WhatsApp, Midtrans, RajaOngkir) menunjukkan terkonfigurasi/belum diturunkan hanya dari KEBERADAAN environment variable, tak pernah nilai secret.

Satu divergensi sengaja dari bentuk literal mockup: layar POS (`/admin/commerce-pos`) mempertahankan grid dua-panel `.pos-layout` sendiri alih-alih mengadopsi primitive generik `.admin-two-pane`, karena sisi keranjangnya butuh kontrol khusus POS (stepper kuantitas, pembacaan jumlah-dibayar/kembalian, blok resi `@media print`) yang tak dimodelkan primitive generik — penilaian "restyle, jangan paksa-cocokkan" yang sama yang diambil issue #167 untuk step-pill checkout di atas.

Belum ada layar galeri media commerce khusus hari ini — gambar produk/slider/testimoni dikelola inline per record, bukan lewat galeri berdiri sendiri — sehingga `.admin-media-grid` tidak dipakai issue ini; ia tetap tersedia di `admin.css` untuk layar mana pun yang mengadopsinya berikutnya.
