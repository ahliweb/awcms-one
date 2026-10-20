🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](booking-ux-flows.md)

<!-- i18n-source-hash: sha256:fbf9c9c67f770ba3eae59b8ee3a529375d34301aec0c143548f9db000b88bf6e -->

<!-- i18n-source-hash: sha256:0 -->

# Alur UX pemesanan — pemesanan menginap di storefront, uang muka, pembatalan, dan check-in meja depan

Artefak DoR 8 dari epik [#280](https://github.com/ahliweb/awcms-one/issues/280), item Wave A W8 ([#359](https://github.com/ahliweb/awcms-one/issues/359)), dilacak di [`aw-business-platform-dor.md`](aw-business-platform-dor.md). Ditulis 10 Oktober 2026.

> **Spesifikasi desain, sebagian sudah dibangun.** Permukaan A (alur pemesanan storefront: `/booking`, `/booking/pesan`, `/akun/reservasi`, beserta state hitung mundur, kedaluwarsa, dan daftar milik sendiri) dibangun oleh [issue #386](https://github.com/ahliweb/awcms-one/issues/386); lihat "Status implementasi Permukaan A" di bawah untuk apa persisnya yang dikerjakannya dan di mana ia sengaja berbeda dari teks ini. Serah-terima pembayaran Permukaan B adalah sesi gateway yang sudah ada (tujuan deposit dan saldo) yang dicapai dari halaman-halaman itu; tampilan order dengan riwayat pembayarannya, **Permukaan C (pembatalan dan refund), Permukaan D (check-in kasir), dan semua layar back-office belum dibangun** (issue #381 sampai #383 dan seterusnya). Setiap nama rute, string teks, dan state di bawah yang belum dibangun tetap usulan untuk dikonfirmasi implementernya; bila teks ini bertentangan dengan kode, kode dan pengujiannya yang menang dan dokumen ini diubah.

**Terkait:** [PRD platform](aw-business-platform-prd.md) (alur kerja 4.1 sampai 4.4, jawaban pemilik di bagian 9), [Model ancaman](aw-business-platform-threat-model.md) (pemetaan kontrol, bagian 7), [Kontrak metrik](aw-business-platform-metrics.md), [ADR-0025](adr/0025-payments-are-an-allocation-ledger-separate-from-order-status.md) (buku besar pembayaran dan uang muka), [ADR-0033](adr/0033-returns-refunds-and-exchanges-are-additive-records-that-compensate-through-the-existing-ledgers.md) (pengembalian dana), [ADR-0040](adr/0040-aw-business-platform-capability-ownership-and-boundaries.md), [ADR-0041](adr/0041-gateway-deposit-sessions-and-mixed-tenders-on-one-order.md) (sesi uang muka); aturan visual dan aksesibilitas yang diikuti spesifikasi ini adalah [`ui-ux.md`](ui-ux.md), [`aksesibilitas.md`](aksesibilitas.md), dan [`responsif.md`](responsif.md).

## 1. Cakupan dan aturan dasar

Dalam cakupan: empat permukaan untuk vertikal pertama (menginap per malam hotel, vila, dan rental, jawaban pemilik O2): **(A)** alur pemesanan storefront, **(B)** pembayaran uang muka dan tampilan pesanan, **(C)** pembatalan dan pengembalian dana, **(D)** check-in kasir / meja depan dengan penerimaan sisa pembayaran. Di luar cakupan: layar admin untuk konfigurasi adapter dan untuk resource, tarif, dan blokir modul Booking upstream (itu admin upstream; layar konfigurasi adapter adalah item W8 berikutnya), pengingat, dan harga per malam (ditunda upstream oleh ADR-0135 bagian 6 upstream `awcms`).

Aturan dasar yang diwarisi setiap layar:

1. **Storefront tidak menghitung uang.** Setiap angka (harga per malam, total, uang muka, sudah dibayar, sisa pembayaran, pengembalian) berasal dari server, diformat hanya melalui jalur `formatPrice()` yang ada ([`ui-ux.md`](ui-ux.md), "Price presentation"). Halaman boleh mengurangi dua angka server hanya untuk menampilkan angka yang juga dikembalikan server; tidak pernah mengirim balik jumlah hasil hitungan. Kontrol C-07 (penjaga jumlah uang muka) dan C-10 (jumlah pengembalian dihitung server) menjadi alasannya.
2. **Malam adalah aritmetika tanggal, dari server.** Menginap adalah interval tanggal lokal setengah terbuka `[check-in, check-out)` dalam zona waktu IANA properti (`awcms` [ADR-0135 upstream](../apps/cms/docs/adr/0135-day-granularity-stays-admitted-into-booking-v1.md) bagian 2): check-in inklusif, check-out eksklusif, malam = check-out dikurangi check-in, paling banyak 366. Zona waktu peramban tidak pernah dipakai menafsirkan tanggal menginap; pemilih bekerja pada string tanggal (`YYYY-MM-DD`) dan melabeli zona properti. Pergantian di hari yang sama sah (tamu boleh check-in pada hari tamu lain check-out), sehingga tanggal yang merupakan check-out orang lain dapat dipilih sebagai check-in.
3. **Malam adalah kuantitas satu produk layanan per malam** (jawaban pemilik Q1): pesanan punya satu baris, kuantitas = malam, sehingga "2 malam x Rp 500.000 = Rp 1.000.000" persis yang dikembalikan server, bukan hitungan klien.
4. **Bahasa Indonesia adalah bahasa utama, tanpa syarat** ([`ui-ux.md`](ui-ux.md), "Language"); kolom Inggris di bawah untuk penerjemah dan mirror Inggris dokumen ini, bukan locale storefront kedua.
5. **Autentikasi adalah sesi bearer yang ada** ([ADR-0016](adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) D3, kontrol C-04): token opak `cs_` di `localStorage`, dikirim sebagai `Authorization: Bearer`, melalui `apps/storefront/src/lib/akun-sesi.ts` dan `apps/storefront/src/lib/akun-klien.ts`; tidak pernah cookie, dan CORS tidak mendapat header kredensial. `401 UNAUTHENTICATED` dari rute pemesanan mana pun menghapus sesi dan mengarahkan tamu ke masuk, lalu kembali (bagian 7). Tidak ada bentuk sesi kedua.
6. **Output statis.** Storefront adalah `output: "static"` tanpa halaman `prerender = false`. Setiap layar di bawah adalah shell statis yang mengambil dari `apps/cms` di peramban saat runtime (pola ADR-0007, seperti keranjang dan checkout), sehingga setiap area dinamis punya state loading eksplisit, dan shell statis tanpa JavaScript menampilkan state tanpa-skrip di bagian 2.1.
7. **Menjelajah tanpa login, memesan dengan login.** Pencarian dan penawaran harga anonim (tidak menulis baris, PRD 4.1 langkah 1); membuat penahanan (hold) memerlukan sesi pelanggan agar reservasi punya pemilik untuk pemeriksaan kepemilikan C-05. Pengenal di URL tidak pernah bukti kepemilikan (C-02): tampilan pesanan dan reservasi dimuat berdasarkan sesi, bukan referensi polos.

### 1.1 Kosakata state layar bersama

Setiap area berisi data menerapkan empat state ini, berurutan menurut prioritas. Keempatnya berlaku untuk tiap permukaan di bawah; tiap permukaan hanya mencantumkan perbedaannya.

| State   | Aturan (semua permukaan)                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading | Kerangka atau teks "Memuat..." dalam area bertanda `aria-busy="true"`; tidak pernah area kosong. Permintaan yang belum dijawab dalam 10 detik menjadi state Error dengan coba lagi. Tombol kirim form dinonaktifkan dan menampilkan "Memproses..." selama permintaan berjalan, dan form tidak bisa dikirim dua kali (kunci idempotensi panggilan hold/pembayaran dibuat sekali per percobaan dan dipakai ulang saat mengulang). |
| Empty   | Pesan yang bertujuan dengan tindakan berikutnya, memakai ulang `.empty-state`; tidak pernah tabel atau kotak kosong.                                                                                                                                                                                                                                                                                                            |
| Error   | Pesan yang menyatakan apa yang terjadi dan apa yang harus dilakukan, dalam area `role="alert"` di atas form atau di area yang gagal; menawarkan "Coba lagi" bila mengulang aman. Pesan tidak pernah membuka kode internal, stack, atau apakah tenant lain atau referensi tamu lain ada (C-02).                                                                                                                                  |
| Success | Konfirmasi di live region sopan (`role="status"`), langkah berikutnya sebagai tautan atau tombol, dan fokus dipindah ke judul konfirmasi.                                                                                                                                                                                                                                                                                       |

## 2. Permukaan A — alur pemesanan storefront

Usulan rute (semuanya hanya di profil `toko`, bagian 8): `/booking` (pencarian dan penawaran harga), `/booking/pesan` (data tamu, hold, dan pilihan pembayaran), `/akun/reservasi` (daftar dan detail reservasi sendiri, setelah masuk). `/akun/reservasi` berada di samping halaman `/akun/*` yang ada dan memakai ulang tata letak serta penjaga masuknya.

### 2.1 Langkah 1 — pilih penginapan (`/booking`)

Isi: pemilih layanan (produk layanan per malam, lewat kartu produk atau select), **pemilih rentang tanggal** untuk check-in dan check-out, stepper tamu/unit bila resource memilikinya, dan panel penawaran harga.

**Perilaku pemilih rentang tanggal**

- Dua kolom tanggal berlabel native ("Tanggal masuk", "Tanggal keluar") adalah kontrol utama yang selalu tersedia: `<input type="date">` dengan `min` = hari ini di zona properti dan petunjuk teks zona ("Zona waktu properti: WITA"). Kisi kalender adalah peningkatan di atas kolom itu, bukan pengganti: bila skrip gagal atau tamu memakai pembaca layar, kedua input tetap berfungsi. Ini membuat pemilih lengkap untuk keyboard dan pembaca layar secara konstruksi.
- Memilih check-in lalu check-out menyorot rentang setengah terbuka: tanggal check-out ditampilkan sebagai "keluar" dan **tidak** dihitung sebagai malam. Satu baris ringkasan menyatakan hasilnya dengan kata: "2 malam: 12 Okt sampai 14 Okt 2026" (jumlah malam adalah penawaran harga server; sebelum kembali, barisnya berbunyi "Menghitung...").
- Check-out harus setelah check-in; tanggal sama adalah galat inline (tabel bagian 2.5), bukan penukaran diam-diam. Lebih dari 366 malam ditolak dengan pesan, tidak dipotong.
- Ketersediaan tanggal ditampilkan dari jawaban ketersediaan server untuk layanan yang dipilih, tidak pernah disimpulkan. Tanggal tanpa unit kosong ditandai tidak tersedia di kisi dengan teks dan ikon ("Penuh"), bukan hanya warna, dan dikeluarkan dari urutan tab kisi tetapi tetap dapat dijangkau lewat input tanggal, yang memberi galat ketersediaan bagian 2.5.
- Panel penawaran harga (satu area `aria-live="polite"`) menampilkan: nama layanan, malam, harga per malam, total, uang muka yang harus dibayar sekarang dan sisa pembayaran nanti (bagian 3.1), serta jam check-in/check-out sebagai informasi ("Check-in mulai 14.00, check-out sebelum 12.00"; ini kolom informasi tamu, bukan bagian uji tumpang tindih, ADR-0135 upstream `awcms` bagian 3).

**State**

| State   | Perilaku                                                                                                                                                                                                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Loading | Daftar layanan dan ketersediaan dimuat ke area `aria-busy`; panel penawaran berbunyi "Menghitung harga..." dan tombol "Lanjut" nonaktif sampai ada penawaran untuk tanggal saat ini. Perubahan tanggal langsung membatalkan penawaran lama (angka lama dihapus, tidak dibiarkan basi).                                   |
| Empty   | Tidak ada layanan yang bisa dipesan untuk tenant ini: "Belum ada layanan yang bisa dipesan saat ini." dengan tautan kembali ke katalog. Tidak ada ketersediaan pada rentang yang dicari: "Tidak ada kamar kosong untuk tanggal ini. Coba tanggal lain." dengan tanggal alternatif terdekat bila server mengembalikannya. |
| Error   | Permintaan penawaran atau ketersediaan gagal: "Tidak dapat memuat harga. Periksa koneksi Anda, lalu coba lagi." + "Coba lagi".                                                                                                                                                                                           |
| Success | Penawaran valid ditampilkan dan "Lanjut ke data tamu" aktif.                                                                                                                                                                                                                                                             |

**Tanpa skrip**: shell statis menampilkan pesan `<noscript>` ("Pemesanan memerlukan JavaScript. Hubungi kami di ..." memakai kontak situs dari `site.ts`), karena halaman statis tidak dapat menawar harga atau menahan tanpa peramban memanggil `apps/cms`.

### 2.2 Langkah 2 — data tamu, hold, dan hitung mundur (`/booking/pesan`)

Menekan "Lanjut" (sudah masuk) meminta adapter **menahan** penginapan dan membuat pesanan tertunda dalam satu tindakan bisnis (PRD 4.1 langkah 2). Tamu yang belum masuk diarahkan ke `/masuk` (OTP) dengan layanan dan tanggal terpilih dibawa di alamat kembali (bagian 7) dan dikembalikan ke langkah ini sesudahnya.

Isi: ringkasan menginap (baca-saja, dengan tautan "Ubah tanggal" yang tidak melepas apa pun sampai hold baru menggantikan, lihat di bawah), nama dan kontak tamu (terisi dari akun; kontak hanya dipakai untuk konfirmasi), textarea permintaan khusus (dibatasi panjang, teks polos), kalimat persetujuan yang menautkan kebijakan pembatalan (bagian 4.1), jumlah uang muka dan pilihan metode pembayaran, serta **hitung mundur hold**.

**Spesifikasi hitung mundur hold**

- Server mengembalikan kedaluwarsa hold sebagai instan absolut (`holdExpiresAt`, UTC) dan instan server saat ini; halaman menghitung sisa waktu dari **selisihnya** (jam perangkat yang salah tidak berpengaruh) dan menyinkronkan ulang saat halaman terlihat lagi atau jaringan kembali.
- Teks terlihat: "Kamar ditahan untuk Anda selama 14:32" (mm:ss; jj:mm:dd di atas satu jam). Di bawah 60 detik teks mendapat gaya peringatan **dan** kata "kurang dari 1 menit".
- **Aturan live region (WCAG 4.1.3, dan 2.2.1 pembatasan waktu)**: angka yang berdetak **tidak** berada di live region (pengumuman per detik tidak dapat dipakai). Area `role="status"` tersembunyi-visual terpisah hanya mengumumkan pada ambang: saat hold dimulai ("Kamar ditahan selama 15 menit"), pada 5 menit, pada 1 menit, dan saat kedaluwarsa; pengumuman 1 menit dan kedaluwarsa memakai `role="alert"`. Hitung mundur tidak pernah merebut fokus.
- **Kendali batas waktu (WCAG 2.2.1)**: pada ambang 1 menit tombol "Perpanjang waktu tahan" muncul sekali, bila server mengizinkan perpanjangan (satu kali, ditentukan server, dibatasi laju oleh C-03); bila tidak, pesan menyatakannya. Tamu yang butuh waktu lebih dapat mematikan, menyesuaikan, atau memperpanjang batas, atau mulai ulang.
- Saat kedaluwarsa form dinonaktifkan dan diganti state kedaluwarsa ("Waktu penahanan habis. Kamar dilepas. Pilih tanggal lagi.") dengan tombol utama kembali ke Langkah 1 dengan tanggal terisi. Halaman memperlakukan server sebagai otoritas: pengiriman yang tiba setelah kedaluwarsa dijawab `HOLD_EXPIRED` dan ditampilkan sebagai state yang sama, apa pun bacaan timer lokal.
- `prefers-reduced-motion`: hitung mundur tidak beranimasi sama sekali; bilah progres, bila dipakai, tidak beranimasi di bawah preferensi itu.

**State**

| State   | Perilaku                                                                                                                                                          |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading | Saat hold dibuat: "Menahan kamar..." dan form disembunyikan (agar tekan ganda tidak membuat hold kedua; panggilan hold tetap idempoten pada kunci klien).         |
| Empty   | Membuka halaman tanpa hold aktif (muat ulang setelah kedaluwarsa, atau tautan langsung): "Tidak ada pemesanan yang sedang berjalan." dengan tautan ke `/booking`. |
| Error   | Tabel galat bagian 2.5. Fokus pindah ke alert; form mempertahankan isian tamu.                                                                                    |
| Success | Hold aktif: hitung mundur, ringkasan, dan pilihan pembayaran tampil. Mengirim pilihan pembayaran menuju Permukaan B.                                              |

### 2.3 Reservasi sendiri (`/akun/reservasi`)

Daftar reservasi tamu setelah masuk, terbaru dahulu: tanggal menginap, malam, layanan, status reservasi (kosakata bagian 2.4), status pembayaran (bagian 3.3), sisa pembayaran. Tiap baris menaut ke detail, yang menampung tampilan pesanan Permukaan B dan pembatalan Permukaan C. Kepemilikan dihitung dari sesi (C-05); referensi milik orang lain mengembalikan "Pemesanan tidak ditemukan" netral yang sama seperti yang tidak ada (C-02).

| State   | Perilaku                                                                                       |
| ------- | ---------------------------------------------------------------------------------------------- |
| Loading | Daftar `aria-busy` dengan baris kerangka.                                                      |
| Empty   | "Anda belum punya reservasi." + tautan "Cari penginapan".                                      |
| Error   | "Tidak dapat memuat reservasi." + coba lagi; `401` menghapus sesi dan mengarahkan ke `/masuk`. |
| Success | Daftar; tamu yang kembali dari pembayaran mendarat di sini dengan pesan status (bagian 3.2).   |

### 2.4 Kosakata status

Satu `Record` kecil per permukaan, tidak pernah enum API mentah ([`ui-ux.md`](ui-ux.md), "Status-label vocabulary"). Label selalu teks; warna `.pill` hanya penguat, bukan satu-satunya sinyal.

| State reservasi (upstream) | Label Indonesia               | Inggris          | Pill    |
| -------------------------- | ----------------------------- | ---------------- | ------- |
| `held`                     | Menunggu pembayaran uang muka | Awaiting deposit | warning |
| `confirmed`                | Terkonfirmasi                 | Confirmed        | success |
| `checked_in`               | Sedang menginap               | Checked in       | info    |
| `completed`                | Selesai                       | Completed        | neutral |
| `expired`                  | Penahanan habis               | Hold expired     | neutral |
| `cancelled`                | Dibatalkan                    | Cancelled        | danger  |
| `rescheduled`              | Dijadwalkan ulang             | Rescheduled      | neutral |
| `no_show`                  | Tidak hadir                   | No-show          | danger  |

### 2.5 Galat ketersediaan dan pemesanan

Setiap galat ditampilkan inline di samping kolom yang bersangkutan (atau di atas form untuk galat tingkat form) dengan aturan asosiasi bagian 6, dan masing-masing menyebut tindakan berikutnya. Halaman memetakan kode penolakan server ke teks; kode tak dikenal memakai baris generik.

| Kondisi (jawaban server)                                                        | Indonesia                                                                   | Inggris                                                                     | Tindakan berikutnya                                                               |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Check-out tidak setelah check-in                                                | Tanggal keluar harus setelah tanggal masuk.                                 | Check-out must be after check-in.                                           | Fokus ke kolom check-out.                                                         |
| Tanggal lampau                                                                  | Tanggal masuk tidak boleh sebelum hari ini.                                 | Check-in cannot be before today.                                            | Fokus ke check-in.                                                                |
| Lebih dari 366 malam                                                            | Lama menginap maksimal 366 malam.                                           | Maximum stay is 366 nights.                                                 | Fokus ke check-out.                                                               |
| Tidak ada unit kosong untuk rentang (constraint eksklusi kalah, atau tidak ada) | Maaf, kamar untuk tanggal ini baru saja terisi. Silakan pilih tanggal lain. | Sorry, this room was just taken for these dates. Please choose other dates. | Kembali ke Langkah 1 dengan tanggal dipertahankan; tampilkan alternatif bila ada. |
| Malam diblokir (perawatan / pemakaian pemilik)                                  | Tanggal ini tidak tersedia untuk dipesan.                                   | These dates are not available.                                              | Sama. Halaman tidak menyebut alasan (alasan blokir adalah informasi staf).        |
| Hold kedaluwarsa                                                                | Waktu penahanan habis.                                                      | The hold has expired.                                                       | Langkah 1 dengan tanggal dipertahankan.                                           |
| Dibatasi laju (C-03)                                                            | Terlalu banyak percobaan. Tunggu sebentar, lalu coba lagi.                  | Too many attempts. Please wait and try again.                               | Kontrol coba lagi setelah waktu tunggu server.                                    |
| Sesi berakhir (`401`)                                                           | Sesi Anda berakhir. Masuk lagi untuk melanjutkan.                           | Your session expired. Sign in to continue.                                  | Masuk, lalu kembali dengan penginapan terjaga.                                    |
| Jaringan / tak dikenal                                                          | Terjadi gangguan. Coba lagi.                                                | Something went wrong. Try again.                                            | Coba lagi; panggilan idempoten membuatnya aman.                                   |

Jawaban "tidak ada unit kosong" tidak pernah sukses kosong: halaman harus menampilkan pesan, karena balapan antara dua tamu diputuskan basis data dan yang kalah harus diberi tahu dengan jelas.

## 3. Permukaan B — pembayaran uang muka dan tampilan pesanan

### 3.1 Penyajian uang muka dan sisa pembayaran

Uang muka adalah kebijakan per produk (jawaban pemilik Q2: persentase atau jumlah tetap, tanpa default tenant; produk tanpa kebijakan dibayar penuh). Server mengembalikan, bersama penawaran dan pesanan: total, **uang muka yang harus dibayar sekarang**, **sisa pembayaran nanti**, dan state pembayaran. Halaman menampilkan persis itu, dalam daftar definisi (tiga baris, istilah berlabel), pada penawaran (Langkah 1), pembayaran (Langkah 2) dan tampilan pesanan:

| Baris                                            | Label Indonesia                       | Inggris         | Sumber                                                        |
| ------------------------------------------------ | ------------------------------------- | --------------- | ------------------------------------------------------------- |
| Total                                            | Total                                 | Total           | total pesanan                                                 |
| Sudah dibayar                                    | Sudah dibayar                         | Paid so far     | alokasi yang sudah settle di buku besar (bukan yang tertunda) |
| Sisa pembayaran                                  | Sisa pembayaran                       | Balance due     | sisa yang diberikan server                                    |
| Jatuh tempo sekarang (sebelum uang muka dibayar) | Uang muka yang harus dibayar sekarang | Deposit due now | uang muka hitungan server (`dp_amount`, ADR-0041 D4)          |

Produk tanpa kebijakan uang muka menyembunyikan baris uang muka dan menampilkan "Bayar penuh" dengan total sebagai jumlah yang harus dibayar. **Poin tidak ditawarkan pada pesanan beruang muka dan deposit jaminan yang dikembalikan tidak ada di v1** (jawaban pemilik Q8 dan Q3; ADR-0041 D8): checkout tidak menampilkan kontrol penukaran poin bila pesanan punya uang muka, dan menampilkan teks singkat bahwa poin tidak dapat digabung dengan uang muka ("Poin tidak dapat dipakai bersama uang muka."), dan tidak ada baris atau label "deposit jaminan" di mana pun. Pengembalian dapat mengembalikan uang muka yang sudah menjadi pendapatan menurut ADR-0033; UI menyebutnya "uang muka", tidak pernah "deposit jaminan".

### 3.2 Membayar uang muka

Uang muka dibayar lewat tender yang ada: sesi gateway Midtrans yang jumlah harapannya adalah uang muka hitungan server (ADR-0041 D1/D2), transfer manual, atau QRIS. Alur memakai ulang pola checkout berbasis redirect ([`ui-ux.md`](ui-ux.md), "Checkout and tracking"): halaman mengirim tamu ke penyedia dan menerimanya kembali di halaman detail penginapan. Tamu tidak pernah mengirim jumlah; jumlah yang ditampilkan adalah milik server, dan jumlah yang ditagih penyedia dijaga di server (C-07).

Kembali dari penyedia **bukan bukti pembayaran** (C-06, C-08): halaman kembali membaca state pesanan dari server dan menampilkan salah satu:

| State server saat kembali                                  | Indonesia                                                                                                                                                                         | Inggris                                                                                                                                    | Pill / berikutnya                                                                                                            |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Uang muka settle, reservasi `confirmed`, pesanan `dp_paid` | Uang muka diterima. Reservasi Anda terkonfirmasi. Sisa pembayaran Rp X dibayar saat check-in atau lebih awal.                                                                     | Deposit received. Your reservation is confirmed. Balance Rp X is due at check-in or earlier.                                               | success                                                                                                                      |
| Pembayaran tertunda (penyedia belum mengonfirmasi)         | Pembayaran sedang diproses. Halaman ini diperbarui otomatis. Kamar tetap ditahan sampai HH:MM.                                                                                    | Payment is being processed. This page updates automatically. The room stays held until HH:MM.                                              | info; polling sopan (backoff, berhenti setelah hold kedaluwarsa), umumkan perubahan lewat area status                        |
| Pembayaran gagal atau dibatalkan                           | Pembayaran tidak berhasil. Anda bisa mencoba metode lain selama kamar masih ditahan.                                                                                              | Payment did not succeed. You may try another method while the room is held.                                                                | danger; "Bayar lagi" bila hold masih hidup                                                                                   |
| Hold kedaluwarsa sebelum pembayaran settle                 | Waktu penahanan habis sebelum pembayaran kami terima. Jika Anda sudah membayar, tim kami akan menghubungi Anda untuk pengembalian dana atau penjadwalan ulang. Nomor pesanan: ... | The hold expired before we received payment. If you already paid, our team will contact you about a refund or rebooking. Order number: ... | warning; ini pengecualian pembayaran terlambat PRD 4.1 langkah 6 (C-08): halaman tidak pernah menyatakan kamar terkonfirmasi |

Halaman tidak menyatakan "terkonfirmasi" hanya dari parameter redirect.

### 3.3 Tampilan pesanan dengan state uang muka

Detail reservasi menampilkan penginapan (tanggal di zona properti, malam, jam check-in/out), nomor pesanan, pill status, tiga baris uang bagian 3.1, dan riwayat pembayaran (tiap alokasi: tanggal, tender, jumlah, status; jumlah dalam format server). Kosakata label status pembayaran:

| State pembayaran pesanan                       | Indonesia                          | Inggris                      | Pill    |
| ---------------------------------------------- | ---------------------------------- | ---------------------------- | ------- |
| menunggu pembayaran                            | Menunggu pembayaran                | Awaiting payment             | warning |
| `dp_paid`                                      | Uang muka dibayar, sisa Rp X       | Deposit paid, Rp X remaining | info    |
| lunas (settlement mencapai total, ADR-0041 D6) | Lunas                              | Paid in full                 | success |
| dikembalikan sebagian / seluruhnya             | Dikembalikan sebagian / seluruhnya | Partly / fully refunded      | neutral |

Tindakan menurut state: "Bayar sisa pembayaran" (pembayaran sisa lewat tender yang sama, kapan saja sebelum atau saat check-in; disembunyikan bila sisa nol), "Batalkan reservasi" (Permukaan C), "Unduh kuitansi" (dokumen pesanan bernomor, ADR-0029; Booking tidak menerbitkan dokumen). Pembayaran sisa juga yang diterima kasir di meja depan (Permukaan D).

| State   | Perilaku                                                                                                                               |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Loading | Detail `aria-busy` dengan baris kerangka untuk daftar uang.                                                                            |
| Empty   | Tidak berlaku (detail tanpa reservasi adalah not-found netral).                                                                        |
| Error   | "Pemesanan tidak ditemukan" netral untuk yang tidak ada dan bukan milik Anda sama saja (C-02); kegagalan memuat menampilkan coba lagi. |
| Success | Detail; setelah pembayaran, area status mengumumkan state baru.                                                                        |

## 4. Permukaan C — tampilan pembatalan dan pengembalian dana

### 4.1 Jendela kebijakan, per produk dengan default tenant

Jendela pembatalan berlaku per produk, dengan default seluruh tenant untuk produk tanpa kebijakan sendiri (jawaban pemilik Q9). Tamu melihat kebijakan yang **berlaku untuk produk ini**, diselesaikan server, di tiga titik: pada kalimat persetujuan sebelum membayar uang muka (Langkah 2), pada detail reservasi, dan pada dialog pembatalan. Ditampilkan sebagai tabel pendek, bukan hanya prosa:

| Batal paling lambat                      | Pengembalian dari yang dibayar | Indonesia                                                          | Inggris                                      |
| ---------------------------------------- | ------------------------------ | ------------------------------------------------------------------ | -------------------------------------------- |
| Contoh: 7 hari sebelum check-in          | 100%                           | Batal paling lambat 7 hari sebelum check-in: dana kembali 100%.    | Cancel 7+ days before check-in: 100% refund. |
| Contoh: 2 sampai 7 hari                  | 50%                            | Batal 2 sampai 7 hari sebelum check-in: dana kembali 50%.          | Cancel 2 to 7 days before: 50% refund.       |
| Contoh: kurang dari 2 hari / tidak hadir | 0%                             | Batal kurang dari 2 hari atau tidak hadir: tidak ada pengembalian. | Under 2 days or no-show: no refund.          |

Baris-baris ini contoh bentuk; angkanya kebijakan tenant, dibaca dari server, tidak pernah ditulis keras. Bila kebijakan tidak terselesaikan (tidak ada kebijakan produk dan tidak ada default tenant), halaman berkata "Kebijakan pembatalan belum ditetapkan. Hubungi kami sebelum membatalkan." dan **tidak** menawarkan jalur pengembalian mandiri tombol batal (tamu tetap boleh meminta pembatalan; jumlahnya lalu mengikuti jalur staf). Batas waktu dinyatakan dengan zona properti dan sebagai tanggal dan jam lokal konkret ("sampai 5 Okt 2026 14.00 WITA"), diturunkan server dari instan kedatangan yang di-snapshot dan batasnya.

### 4.2 Dialog pembatalan — pengembalian ditampilkan sebelum konfirmasi

Menekan "Batalkan reservasi" membuka dialog konfirmasi (pola dialog konfirmasi aksesibel yang ada; tidak pernah `confirm` peramban, yang sudah dilarang gerbang admin dan juga tidak dipakai storefront). Dialog **memuat dulu pratinjau pengembalian dari server**: jendela kebijakan tempat pembatalan jatuh, jumlah yang dibayar, jumlah yang dapat dikembalikan, dan yang ditahan. Membuka dialog tidak membatalkan apa pun.

| Baris               | Indonesia                                                      | Inggris                                 |
| ------------------- | -------------------------------------------------------------- | --------------------------------------- |
| Dibayar             | Sudah dibayar                                                  | Paid                                    |
| Kebijakan berlaku   | Kebijakan yang berlaku: batal 2 sampai 7 hari sebelum check-in | Policy applied                          |
| Pengembalian        | Dana yang dikembalikan                                         | Refund                                  |
| Ditahan             | Ditahan sesuai kebijakan                                       | Retained under the policy               |
| Tujuan pengembalian | Dikembalikan ke metode pembayaran asal (Midtrans, transfer)    | Refunded to the original payment method |

Teks: judul "Batalkan reservasi ini?"; isi menyatakan tiga angka; tombol "Ya, batalkan dan ajukan pengembalian" (danger) dan "Tidak, tetap pesan" (fokus default). Pengembalian nol mengubah tombol konfirmasi menjadi "Ya, batalkan tanpa pengembalian" dan menampilkan jumlah yang ditahan di pill peringatan, sehingga tamu tidak menemukan hilangnya dana setelah kejadian. Pengembalian yang ditampilkan adalah **pratinjau**; setelah konfirmasi, angka pada hasil adalah pengembalian yang tercatat. Bila pratinjau dan angka tercatat berbeda (jendela kebijakan lewat saat dialog terbuka), server menolak dengan pratinjau baru dan dialog menampilkannya lagi untuk konfirmasi baru; tamu tidak pernah dibebani angka berbeda secara diam-diam.

| State   | Perilaku                                                                                                                                                                                                                                                                                                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading | Isi dialog `aria-busy` "Menghitung pengembalian dana..."; konfirmasi nonaktif sampai pratinjau tiba.                                                                                                                                                                                                                                                                                    |
| Empty   | Reservasi yang tidak dapat dibatalkan lagi (selesai, sudah dibatalkan, lewat check-in): tombol diganti alasan teks polos ("Reservasi ini sudah selesai dan tidak dapat dibatalkan."), bukan disembunyikan.                                                                                                                                                                              |
| Error   | Pratinjau gagal: "Tidak dapat menghitung pengembalian dana. Coba lagi." + coba lagi; konfirmasi tetap nonaktif. Permintaan batal gagal: alert di dialog, tidak ada yang diasumsikan.                                                                                                                                                                                                    |
| Success | Dialog menutup; detail menampilkan "Dibatalkan" dan pesan status: "Reservasi dibatalkan. Pengembalian dana Rp X sedang diproses; biasanya ... hari kerja." Baris pengembalian lalu mengikuti state-nya sendiri: diproses, selesai, atau "menunggu verifikasi tim kami" bila penyelesaian antre untuk atestasi offline operator (ADR-0033; kontrol C-11), tidak pernah hilang diam-diam. |

Pengembalian yang tidak dapat diselesaikan otomatis ditampilkan ke tamu sebagai "sedang diproses" dengan nomor referensi, bukan galat yang mengundang pembatalan kedua; panggilan batal bersifat idempoten (C-10).

### 4.3 Override staf (hanya back-office)

**Tamu tidak dapat meng-override apa pun.** Storefront tidak punya kontrol yang mengubah jumlah pengembalian. Override adalah tindakan staf di konteks admin / meja depan (jawaban pemilik Q10; PRD 4.2 langkah 6; A5): memerlukan **izin manajer atau finance** yang dipegang terpisah dari izin batal biasa, **autentikasi ulang step-up**, **alasan wajib**, **peristiwa audit**, dan jumlah **tidak pernah melebihi yang sudah dibayar**. Layarnya adalah layar admin adapter, dispesifikasikan di bagian 11.5 dan dibangun oleh [#381](https://github.com/ahliweb/awcms-one/issues/381); bagian ini menetapkan kontrak UX-nya:

- Kontrol override tidak ada (bukan dinonaktifkan) bagi staf tanpa izin.
- Form menampilkan jumlah hitungan kebijakan di samping kolom override, mewajibkan alasan (panjang minimum, teks bebas, polos), dan menyatakan batas ("Maksimal Rp X: sebesar yang sudah dibayar").
- Mengirim memicu autentikasi ulang step-up; override baru dicatat setelah berhasil, dan step-up yang gagal atau ditinggalkan tidak mengubah apa pun.
- Hasilnya diaudit dengan aktor, angka kebijakan, angka override, dan alasan; tampilan untuk tamu lalu menampilkan pengembalian tercatat dan paling banyak "Disesuaikan oleh tim kami", tidak pernah alasan atau aktornya.

## 5. Permukaan D — check-in kasir / meja depan dengan penerimaan sisa pembayaran

Permukaan ini ada di POS (sesi register dan cash-up dari ADR-0028 tidak berubah, PRD 4.4); ini permukaan staf, masuk sebagai staf berperan kasir, bukan halaman storefront, dan dibangun di atas pola layar POS yang ada. Menulis ke pesanan dan buku besar yang sama; tidak ada POS kedua, dan POS tidak menyimpan state reservasi (check-in dan check-out memanggil port Booking).

### 5.1 Alur

1. **Cari reservasi**: pindai atau ketik referensi pemesanan, atau cari menurut nama/telepon tamu dan tanggal kedatangan. Pencarian hanya menampilkan reservasi tenant sendiri (C-01); referensi yang tidak ditemukan menampilkan "Reservasi tidak ditemukan" tanpa petunjuk tentang tenant lain.
2. **Buka baris layanan**: POS menampilkan kartu reservasi: tamu, unit/kamar, tanggal dan malam, pill status, dan tiga baris uang (total, sudah dibayar, **sisa pembayaran**), dengan kosakata identik bagian 3.1. Kartu menaut ke pesanan.
3. **Terima sisa pembayaran**: kasir menerima sisa lewat jalur tender eksplisit yang ada (ADR-0025 D8), dengan tender apa pun dan tender terpisah; sisa adalah angka server dan entri tender menolak jumlah di atasnya. Penukaran poin dan deposit jaminan yang dikembalikan tidak ditawarkan (Q8 dan Q3).
4. **Check-in**: aktif bila reservasi `confirmed`. Apakah check-in dengan sisa belum dibayar diizinkan adalah **kebijakan tenant**, keputusan yang belum dicatat pemilik; spesifikasi ini menunjukkan kedua varian dalam satu kontrol: bila kebijakan mewajibkan sisa lunas dulu, "Check-in" nonaktif dengan alasan terlihat "Lunasi sisa pembayaran dulu" di sampingnya; bila tidak, check-in aktif dan sisa tetap terlihat. Diputuskan oleh [ADR-0045](adr/0045-booking-commerce-adapter.id.md) D19: pengaturan tenant `checkin_requires_settlement`, bawaan `false` (diizinkan), pemilik dapat merevisi.
5. **Check-out**: `checked_in` menjadi `completed` lewat kontrol yang sama. Penginapan yang dipersingkat saat check-out adalah pengembalian parsial baris layanan (PRD bagian 3; ADR-0033 D2), dimulai dari pesanan, tidak pernah mengedit pesanan final.
6. **Kuitansi**: kuitansi/faktur bernomor adalah dokumen pesanan lewat siklus dokumen yang ada (ADR-0029); layar menawarkan cetak dan kirim.

### 5.2 State

| State   | Perilaku                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading | Kartu reservasi `aria-busy`; tombol aksi nonaktif sampai settlement pesanan termuat (agar sisa tidak pernah tampil nol secara default).                                                                                                                                                                                                                                                                                                                   |
| Empty   | Tidak ada kedatangan hari ini: "Tidak ada kedatangan hari ini." dan kotak pencarian; pencarian tanpa hasil: "Reservasi tidak ditemukan." dan opsi membuat penjualan layanan walk-in tanpa reservasi (PRD 4.4 langkah 2).                                                                                                                                                                                                                                  |
| Error   | Pembayaran gagal pada suatu tender: alert di samping baris tender, dengan sisa tidak berubah; kasir dapat mencoba lagi atau memilih tender lain. Check-in ditolak Booking (state berubah di tempat lain): kartu dimuat ulang dan menampilkan status terkini dengan "Status reservasi berubah. Data diperbarui." Tidak ada sesi register terbuka: "Buka sesi kasir sebelum menerima pembayaran." dengan tautan membukanya, dan entri tender dinonaktifkan. |
| Success | Sisa diterima: area status "Sisa pembayaran Rp X diterima. Pesanan lunas." dan pesanan menampilkan "Lunas"; pelunasan penuh yang menjadi dasar loyalitas (PRD 4.6), bukan uang muka (Q5). Check-in selesai: kartu menampilkan "Sedang menginap".                                                                                                                                                                                                          |

Teks (Indonesia, Inggris): "Terima sisa pembayaran" / Collect balance; "Check-in tamu" / Check in guest; "Check-out tamu" / Check out guest; "Sesi kasir belum dibuka" / Register session is not open.

### 5.3 Kontrol (khusus meja depan)

Setiap penerimaan sisa dan penulisan check-in/check-out diaudit dengan aktor dan sesi register (dibawa audit POS yang ada). Kasir tidak dapat meng-override pengembalian atau membatalkan reservasi berbayar dengan pengembalian dari permukaan ini; keduanya adalah jalur back-office Permukaan C dengan izin bagian 4.3.

## 6. Persyaratan aksesibilitas (WCAG 2.1 AA)

Ini persyaratan atas implementasi, ditambahkan ke lantai di [`aksesibilitas.md`](aksesibilitas.md); suite e2e yang dijelaskan di sana (axe-core `wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa`, `serious`/`critical`) harus memindai setiap halaman storefront baru di `toko` setelah ada. Alat otomatis hanya menangkap sebagian; pemeriksaan manual di kolom terakhir bagian dari penerimaan.

| Area                | Persyaratan                                                                                                                                                                                                                                                                                                                                                                        | WCAG                                | Pemeriksaan manual                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------- |
| Keyboard            | Setiap kontrol dapat dijangkau dan dioperasikan dengan keyboard dalam urutan logis; kisi tanggal mendukung tombol panah (hari), Page Up / Page Down (bulan), Home / End (pekan), Enter/Spasi untuk memilih, Escape untuk menutup; tidak ada jebakan fokus kecuali dialog modal, yang menjebak dan memulihkannya. Dua input tanggal native selalu tetap menjadi alternatif lengkap. | 2.1.1, 2.1.2, 2.4.3                 | Selesaikan pemesanan hanya dengan keyboard              |
| Fokus               | Indikator fokus terlihat pada setiap kontrol dengan kontras 3:1 terhadap warna sekitar (cincin fokus sistem desain); setelah pergantian langkah, ringkasan galat, atau dialog membuka/menutup, fokus dipindah dengan sengaja (judul, kolom tidak valid pertama, kontrol yang membuka dialog). Header lengket tidak pernah menutupi kontrol yang difokuskan.                        | 2.4.7, 2.4.3, 3.2.1                 | Tab melalui setiap langkah                              |
| Label               | Setiap kolom punya `<label>` terlihat yang terikat lewat `for`/`id`; kisi pemilih punya nama aksesibel dan setiap tombol hari bernama lengkap ("Senin, 12 Oktober 2026, tersedia" / "penuh"); kolom wajib ditandai dengan teks, bukan warna; petunjuk zona dan format terikat ke input dengan `aria-describedby`. Placeholder tidak pernah menjadi label.                          | 1.3.1, 3.3.2, 4.1.2                 | Uji pembaca layar di iOS VoiceOver dan Android TalkBack |
| Galat               | Setiap galat adalah pesan teks yang terasosiasi dengan kolomnya (`aria-describedby` plus `aria-invalid="true"`), ditulis dalam bahasa bagian 2.5, dengan ringkasan `role="alert"` tingkat form yang menaut ke kolom tidak valid pertama dan mengambil fokus saat pengiriman gagal; galat menyatakan perbaikan, bukan hanya kesalahan.                                              | 3.3.1, 3.3.3, 4.1.3                 | Kirim form kosong dan tidak valid                       |
| Kontras             | Teks 4,5:1 (3:1 untuk 18px+/14px tebal), komponen UI dan indikator fokus 3:1, memakai token yang ada; tidak ada di bawah `--text-xs` (12px); pill dan tanda tanggal tidak tersedia membawa label teks, tidak pernah hanya warna.                                                                                                                                                   | 1.4.3, 1.4.11, 1.4.1                | Axe plus pemeriksaan token manual                       |
| Live region         | Panel penawaran `aria-live="polite"`; perubahan state pembayaran dan konfirmasi memakai `role="status"`; hitung mundur hold mengikuti bagian 2.2 (hanya pengumuman ambang, `role="alert"` pada satu menit dan kedaluwarsa); tidak ada area yang mengumumkan tiap detik; area ada di DOM sebelum isinya berubah.                                                                    | 4.1.3, 2.2.1                        | Uji pembaca layar; pastikan tidak ada celoteh per detik |
| Waktu               | Hold adalah batas waktu: tamu diberi tahu di awal, diperingatkan sebelum kedaluwarsa dan ditawari perpanjangan bila server mengizinkan; tidak ada timeout tersembunyi, dan sesi berakhir tidak pernah menghilangkan penginapan terpilih (bagian 7).                                                                                                                                | 2.2.1, 2.2.6                        | Biarkan hold habis                                      |
| Ukuran target       | Kontrol minimal 44px (aturan yang ada), termasuk tombol hari kisi tanggal pada 360px; tombol hari tidak lebih kecil dari 44px kali 44px, sehingga kisi menampilkan lebih sedikit kolom per baris alih-alih mengecilkan sel (kisi 7 kolom pada 360px dikurangi gutter 16px adalah 328px, 46px per sel, cukup).                                                                      | 2.5.5 (AAA, diterapkan aturan repo) | Ukur pada 360px                                         |
| Reflow              | Tidak ada gulir horizontal pada 360px, tidak ada gulir dua dimensi; konten mengalir ulang pada zoom 400% (320 CSS px).                                                                                                                                                                                                                                                             | 1.4.10                              | Zoom ke 400%                                            |
| Jarak teks dan zoom | Tata letak bertahan dari override jarak teks WCAG 1.4.12 dan perbesaran teks 200% tanpa kehilangan konten atau fungsi.                                                                                                                                                                                                                                                             | 1.4.4, 1.4.12                       | Terapkan bookmarklet jarak teks                         |
| Gerak               | Tidak ada animasi otomatis; `prefers-reduced-motion` menghapus transisi; tidak ada yang berkedip.                                                                                                                                                                                                                                                                                  | 2.2.2, 2.3.1                        | Ubah pengaturan OS                                      |
| Dialog              | Dialog pembatalan adalah modal dengan nama dan deskripsi aksesibel (angka pengembalian), fokus pindah ke dalamnya dan kembali ke pembuka saat ditutup, Escape menutupnya tanpa membatalkan, dan latar belakang inert.                                                                                                                                                              | 2.1.2, 4.1.2                        | Keyboard dan pembaca layar                              |
| Bahasa              | `lang="id"` pada dokumen; fragmen Inggris (nama penyedia) membawa `lang`-nya sendiri.                                                                                                                                                                                                                                                                                              | 3.1.1, 3.1.2                        | Axe                                                     |
| Permukaan kasir     | Aturan yang sama; tambahan: setiap pintasan keyboard dapat ditemukan, dapat dimatikan atau dipetakan ulang bila ada pintasan satu karakter, dan sisa serta status adalah teks, bukan warna (WCAG 2.1.4).                                                                                                                                                                           | 2.1.4                               | Uji keyboard di terminal POS                            |

## 7. Tata letak responsif, 360px

Storefront diverifikasi oleh peramban nyata pada 360px dan 1280px yang menegaskan `document.documentElement.scrollWidth <= window.innerWidth` pada setiap halaman kunci ([`responsif.md`](responsif.md)); setiap halaman pemesanan masuk daftar itu di `toko` setelah dibangun. Aturan tata letak:

- Satu kolom di bawah titik henti 720px/860px yang ada; panel penawaran berada di bawah form, dan tiga baris uang bertumpuk label-di-atas-nilai (daftar definisi, bukan tabel) sehingga tidak perlu gulir horizontal.
- Pemilih tanggal menampilkan **satu bulan** pada 360px; dua bulan hanya pada 860px ke atas. Track kisi memakai `minmax(0, 1fr)` (perbaikan overflow `1fr` polos dari isu #183) dan sel hari minimal 44px persegi.
- Daftar riwayat pembayaran pada tampilan pesanan adalah daftar bertumpuk pada 360px (tiap alokasi sebuah kartu), bukan tabel; bila tabel sungguhan dipertahankan di layar lebih lebar, ia berada di area `.data-table-scroll` bernama yang dapat difokuskan.
- Dialog pembatalan adalah bottom sheet atau dialog selebar penuh pada 360px dengan tombol bertumpuk, pilihan aman ("Tidak, tetap pesan") pertama dalam urutan DOM setelah angka; string panjang (nama tamu panjang, referensi panjang) dibungkus (`overflow-wrap: anywhere`) dan tidak pernah melebarkan dialog.
- Bilah "Lanjut" lengket (bila dipakai) tidak pernah menutupi kolom terfokus (scroll-padding), dan hitung mundur hold terlihat tanpa menggulir di atas Langkah 2.
- Permukaan kasir dirancang untuk tablet atau ponsel selain desktop: kartu reservasi dan entri tender bertumpuk satu kolom pada 360px, dengan kontrol 44px.

Kembali-setelah-masuk: layanan dan tanggal terpilih dibawa di alamat kembali sebagai nilai polos `YYYY-MM-DD` (tidak pernah jumlah uang), divalidasi ulang saat kembali; tidak ada yang terkait pemesanan disimpan di `localStorage` selain sesi di bawah `awcms-one:akun:v1`.

## 8. Perilaku pada tiga profil build

`SITE_PROFILE` dibaca saat build oleh `apps/storefront/src/config/profil.ts`. Pemesanan adalah kapabilitas commerce dan milik **hanya** profil `toko`:

| Profil    | Perilaku                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toko`    | Halaman pemesanan (`/booking`, `/booking/pesan`, `/akun/reservasi`) adalah halaman profil di bawah grup `toko` (`apps/storefront/src/profil/toko/pages/**`), disuntikkan oleh integrasi profil; header dan footer boleh menaut ke `/booking` hanya di profil ini; sakelar tenant yang mematikan pemesanan menyembunyikan tautan dan membuat rute menampilkan "Pemesanan tidak tersedia" alih-alih form rusak. Halaman baru harus muncul tepat sekali di matriks profil [`template.md`](template.md). |
| `berita`  | Tidak ada halaman pemesanan dibangun; tidak ada tautan ke halaman itu di mana pun (pemeriksaan yang ada bahwa tidak ada halaman terbangun menaut ke rute di luar profilnya mencakup ini). URL pemesanan adalah 404.                                                                                                                                                                                                                                                                                  |
| `landing` | Sama dengan `berita`: tidak ada halaman dan tautan pemesanan. Situs landing yang ingin pertanyaan memakai halaman kontak yang ada; tidak mendapat form pemesanan setengah jadi.                                                                                                                                                                                                                                                                                                                      |

Pada setiap profil build tetap statis dan profil tanpa pemesanan tidak membawa skrip klien-nya (tidak ada kode mati yang dikirim). Situs yang menggabungkan landing dengan pemesanan adalah build `toko` dengan konten landing-nya, bukan profil keempat. Permukaan kasir adalah permukaan back-office (`apps/cms`) dan tidak bergantung pada profil storefront.

## 9. Kontrol dan keterlacakan

| Perhatian                                       | Kontrol (model ancaman bagian 7) | Letaknya di spesifikasi ini                                     |
| ----------------------------------------------- | -------------------------------- | --------------------------------------------------------------- |
| Tenant hanya dari origin                        | C-01                             | Tidak ada pemilih tenant; pencarian kasir dibatasi tenant (5.1) |
| Tanpa enumerasi, not-found netral               | C-02                             | 2.3, 3.3, 5.1                                                   |
| Batas laju hold dan OTP                         | C-03                             | 2.2 (perpanjangan), 2.5                                         |
| Sesi bearer, tanpa cookie                       | C-04                             | Aturan dasar 5, bagian 7                                        |
| Kepemilikan pada tiap endpoint ber-ID           | C-05                             | 2.3, 3.3                                                        |
| Penerimaan webhook: halaman kembali bukan bukti | C-06                             | 3.2                                                             |
| Penjaga jumlah uang muka, hitungan server       | C-07                             | Aturan dasar 1, 3.1, 3.2                                        |
| Balapan pembayaran terlambat / hold kedaluwarsa | C-08                             | 3.2 (baris terakhir)                                            |
| Idempotensi pengembalian, jumlah server         | C-10                             | 4.2                                                             |
| Pemisahan tugas pada pengembalian offline       | C-11                             | 4.2 (offline), 4.3                                              |
| Penebusan tidak digabung dengan uang muka       | C-33                             | 3.1 (kontrol poin disembunyikan pada pesanan uang muka)         |
| Pencarian POS: kode plus pelanggan, miss netral | C-34                             | 5.1                                                             |
| Pemisahan izin POS                              | C-35                             | 5.1, 5.2                                                        |
| Integritas jendela reschedule dan pembatalan    | C-37                             | 4.1 (jendela), 11.6 (dialog jadwal ulang)                       |
| Kontrol override pengembalian                   | C-40                             | 4.3                                                             |
| Penahanan no-show hanya menurut kebijakan       | C-41                             | 4.1 (baris no-show), 11.6 (tindakan tamu tidak hadir)           |

Kontrol C-25 sampai C-41 berasal dari adendum model ancaman ([#354](https://github.com/ahliweb/awcms-one/issues/354)). Rujukan bagian di kolom kanan adalah bagian terdekat yang memuat perilaku tiap kontrol; tabel ini alat keterlacakan dan teks kontrol di model ancaman adalah yang berwenang.

## Status implementasi Permukaan A (issue #386)

Dibangun, hanya pada profil `toko` (`apps/storefront/src/profil/toko/pages/**`; build `berita` atau `landing` tidak menulis satu pun halaman ini dan tidak menautkannya), statis (`output: "static"`, tanpa `prerender = false`), membaca CMS dari browser:

| Halaman           | Bacaan (semua `GET …/commerce/storefront/booking/*` kecuali disebut)                                              | Fungsi                                                                                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/booking`        | `offerings`, `availability`, `quote` (anonim; bearer opsional memberi harga satuan sesuai level pelanggan)        | Pilihan layanan, dua input tanggal bawaan, jumlah tamu, panel kuota (malam, harga per malam, total, uang muka dan sisa, semuanya string dari server), "Penuh" bila tak ada resource kosong.                            |
| `/booking/pesan`  | `quote`, lalu `POST reservations` (bearer, `Idempotency-Key`), `GET reservations/{orderCode}` untuk sinkron ulang | Ringkasan, pilihan pembayaran, hold dan hitung mundurnya, state kedaluwarsa dan terkonfirmasi, serah-terima pembayaran (`POST …/orders/{code}/payment-gateway/sessions` dengan `purpose: deposit \| balance \| full`). |
| `/akun/reservasi` | `GET reservations` (bearer, keyset)                                                                               | Reservasi milik pembeli sendiri, terbaru dulu, dengan pil status dan pembayaran, sisa tagihan, sisa waktu hold yang hidup, dan tombol bayar.                                                                           |

Di mana ia berbeda dari usulan di atas, dan mengapa:

1. **Hold dibuat di `/booking/pesan`, bersama pilihan pembayaran, bukan sebelumnya.** Server menahan menginap dan membuat order dalam satu panggilan yang sudah membutuhkan metode pembayaran (ADR-0045 G2), sehingga "Lanjut" di `/booking` membawa menginap itu sebagai `?o=&r=&in=&out=&n=` (id dan tanggal polos, tidak pernah nominal) dan hold terjadi saat pembeli mengonfirmasi di `/booking/pesan`. Hitung mundur dimulai di sana. Tautan "Ubah tanggal" tidak melepas apa pun karena belum ada yang ditahan.
2. **Akun diperlukan untuk memesan (aturan dasar 7), dan blok tamu tidak ditampilkan.** Saat belum masuk, halaman mengarahkan pembeli ke `/masuk?kembali=` lalu kembali. Server juga menerima checkout tamu (G15), tetapi storefront tidak menawarkannya; kontak menginap adalah milik akun, ditampilkan hanya-baca, karena server mengabaikan blok `guest` bila bearer diberikan.
3. **Tidak ada perpanjangan hold.** CMS tidak punya endpoint perpanjangan, sehingga ambang satu menit menampilkan catatan ("Waktu tahan tidak dapat diperpanjang...") dan jalan untuk memulai lagi, bukan tombol "Perpanjang waktu tahan" (keputusan 2 di bagian 10 tetap terbuka).
4. **Tidak ada grid kalender.** Dua input tanggal bawaan adalah kontrol yang lengkap; grid adalah penyempurnaan di atasnya dan belum dibangun.
5. **Tidak ada jam check-in dan check-out.** Bacaan ketersediaan dan kuota tidak membawanya (keduanya bidang informasi tamu pada resource, bukan bagian uji tumpang tindih).
6. **Resource diperiksa berdasarkan id.** Sebuah offering Booking tidak menetapkan resource dan tautan offering tidak membawanya, sehingga `offerings` mendaftar id resource aktif tenant dengan mode yang sama dengan offering, dan halaman menanyakan `availability` satu per satu, memakai yang pertama punya unit kosong. Tenant yang menjual beberapa tipe kamar dari resource terpisah bermode sama akan melihat setiap tipe ditawarkan di bawah setiap offering; penetapan eksplisit offering-ke-resource adalah tindak lanjut (catatan implementasi ADR-0045 untuk #386).
7. **Provider kembali ke `/pesanan`.** URL selesai gateway adalah `COMMERCE_STOREFRONT_PUBLIC_URL` milik CMS ditambah `/pesanan`, sehingga pembeli yang membayar lewat gateway mendarat di halaman pelacakan order; `/booking/pesan` (menginap dan tab yang sama) dan `/akun/reservasi` menampilkan reservasi terkonfirmasi dan sisa saldonya, dan tidak pernah menyatakan "terkonfirmasi" dari redirect.
8. **Hitung mundur tidak pernah memercayai jam perangkat.** Setiap isi reservasi membawa `serverNow`; sisa waktu adalah `holdExpiresAt - serverNow` dikurangi waktu yang berlalu pada jam monotonik perangkat, dan halaman bertanya lagi ke server saat nol, saat kembali terlihat atau terhubung, dan setiap beberapa detik selama ditahan.

## 10. Keputusan yang belum dicatat (asumsi untuk dikonfirmasi)

1. **Check-in dengan sisa belum dibayar**: diselesaikan oleh [ADR-0045](adr/0045-booking-commerce-adapter.id.md) D19. Pengaturan tenant `checkin_requires_settlement` (bawaan `false`: diizinkan, sisa tetap terlihat) ditegakkan server dengan `BALANCE_NOT_SETTLED`; bagian 5.1 menunjukkan kedua varian dan pemilik dapat merevisi bawaannya.
2. **Panjang hold dan aturan perpanjangan**: hitung mundur menampilkan apa pun yang ditetapkan server; angka 15 menit dalam teks hanya ilustrasi, dan apakah satu perpanjangan diizinkan adalah keputusan Booking/adapter.
3. **Stepper tamu/unit dan menginap multi-unit**: penginapan berada pada satu unit di v1 (ADR-0135 upstream `awcms` bagian 4); pemesanan multi-kamar tidak dispesifikasikan di sini.
4. **Nama rute** adalah usulan; implementer fase 1 menetapkannya dan memperbarui [`routing.md`](routing.md) serta matriks profil dalam perubahan yang sama.
5. **Saran tanggal alternatif** pada state tanpa-ketersediaan bergantung pada kapabilitas endpoint ketersediaan yang menjadi hak upstream untuk didefinisikan.
6. **Apakah tamu melihat kontak pengecualian pembayaran terlambat** (3.2) sebagai telepon, WhatsApp, atau e-mail adalah konfigurasi tenant.
7. **Tidak diketahui sampai dibangun**: semua desain tingkat piksel (jarak, visual kalender persisnya) milik sistem desain redesign ([`ui-ux.md`](ui-ux.md)); spesifikasi ini menyatakan perilaku, bukan mock-up.

## 11. Permukaan E — layar admin adapter booking (Isu #385, residu DoR R2)

Ditulis 17 Oktober 2026. Ini spesifikasi yang harus ada sebelum [#385](https://github.com/ahliweb/awcms-one/issues/385) membangun (residu DoR R2); [#381](https://github.com/ahliweb/awcms-one/issues/381) membangun permukaan kebijakan pembatalan dan penggantian pengembalian dana berdasarkan bagian ini. Layar-layar ini adalah halaman admin `apps/cms` di dalam modul `commerce` (ADR-0045), di balik fitur `booking` tenant (bawaan MATI) dengan `requiredFeature: { moduleKey: "commerce", feature: "booking" }` pada setiap entri sidebar. Teks admin mengikuti aturan i18n repo: Inggris adalah msgid, Indonesia ada di `id.po`; baris Indonesia di bawah adalah terjemahan katalog. Setiap kontrol hanya untuk UX: server memvalidasi ulang setiap kolom dan menjadi otoritasnya.

| Layar                                | Rute                               | Izin (lihat / ubah)                                                          | Dibangun di                |
| ------------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------- | -------------------------- |
| 11.1 Tautan penawaran                | `/admin/commerce-booking-links`    | `commerce.booking_offering_links.read` / `.create`, `.update`                | #385                       |
| 11.2 Kebijakan uang muka             | `/admin/commerce-booking-deposits` | `commerce.booking_deposit_policies.read` / `.update`                         | #385                       |
| 11.3 Pengaturan akun layanan         | `/admin/commerce-settings`         | `commerce.settings.read` / `.update` (layar yang ada, satu kolom baru)       | #385                       |
| 11.4 Versi kebijakan pembatalan      | `/admin/commerce-booking-policies` | `commerce.booking_cancellation_policies.read` / `.create`, `.approve`        | #381 (butuh API kebijakan) |
| 11.5 Dialog penggantian pengembalian | pada detail pesanan dan reservasi  | `commerce.booking_refund_overrides.approve` (terpisah dari izin batal biasa) | #381 (butuh API batal)     |

Kelimanya memakai state bersama bagian 1.1, disesuaikan dengan chrome admin: pemirsa yang ditolak mendapat `.state-notice`, kegagalan muat mendapat `.state-notice` dengan petunjuk coba lagi, daftar kosong mendapat blok `.empty-state` dengan tindakan berikutnya, dan kegagalan tulis mendapat kotak `role="alert"` di atas formulir (`.admin-create-error`). Tombol sibuk dinonaktifkan dan diberi label baru ("Menyimpan…"); halaman dimuat ulang setelah tulis berhasil (idiom `mutateAndReload`), sehingga baris dari server yang dilihat operator berikutnya.

### 11.1 Tautan penawaran

Tujuan: menautkan satu penawaran Booking ke satu produk **jasa** agar produk dapat dijual sebagai reservasi (ADR-0045 D1). Satu produk aktif per penawaran dan satu penawaran aktif per produk.

- **Daftar.** Wilayah `.data-table-scroll` (dapat difokus, bernama) dengan hitungan di `<caption>`. Kolom: Penawaran (id, `.cell-code`), Produk (id), Dasar ("Per malam" / "Per pemesanan"), Resource (id resource terikat dalam `.cell-code`, atau kata "Semua resource aktif" bila tautan tidak menyebut resource), Status (`admin-status-pill`: Aktif = sukses, Terlepas = netral; teks selalu ada), Ditautkan pada, Tindakan. Daftar dipaginasi keyset (50), terbaru dulu; filter "Tampilkan terlepas" adalah tautan GET biasa (`?status=unlinked`), bukan skrip.
- **Formulir buat** (hanya dengan `.create`): ID penawaran (teks uuid, `autocomplete="off"`, petunjuk "Salin dari Booking, Penawaran."), ID produk (teks uuid, petunjuk "Produk jasa."), Dasar (pilihan: Per malam / Per pemesanan), ID resource (opsional, issue #437: uuid dipisahkan koma, paling banyak sepuluh, petunjuk "Tipe kamar yang dijual penawaran ini: salin ID resource dari Booking, Resource, dipisahkan koma. Kosongkan untuk menawarkan setiap resource aktif dengan jenis yang sama."; dikirim sebagai `resourceIds`, dihilangkan bila kosong). Kolom wajib ditandai dengan teks. Pengiriman memakai `POST` dengan `Idempotency-Key` baru per percobaan.
- **Lepas tautan** (hanya dengan `.update`): tombol baris membuka dialog konfirmasi bersama (bahaya). Dialog menjelaskan akibatnya: tautan tidak lagi dapat dijual; pesanan dan reservasi lama menyimpan riwayatnya; tidak dapat ditautkan lagi dari baris yang sama (buat tautan baru).
- **Peringatan.** Tautan yang dibuat dengan produk tanpa kebijakan pembatalan aktif menampilkan baris status sopan di samping formulir: "Tertaut. Produk ini belum memiliki kebijakan pembatalan, sehingga tamu tidak akan melihat ketentuan pengembalian dana." (`NO_CANCELLATION_POLICY`; tidak memblokir, ADR-0045 D6).
- **Penolakan server dipetakan ke teks khusus**, bukan kegagalan umum: `OFFERING_ALREADY_LINKED` "Penawaran ini sudah ditautkan ke produk."; `PRODUCT_ALREADY_LINKED` "Produk ini sudah ditautkan ke penawaran."; `PRODUCT_NOT_SERVICE` "Hanya produk jasa yang dapat ditautkan."; `QUANTITY_BASIS_MISMATCH` "Dasar kuantitas tidak sesuai dengan penawaran (per malam atau per pemesanan)."; `OFFERING_NOT_LINKABLE` "Penawaran yang langsung terkonfirmasi tidak dapat dijual."; `BOOKING_SERVICE_ACTOR_NOT_CONFIGURED` "Tetapkan akun layanan pemesanan di Pengaturan toko terlebih dahulu."; `FEATURE_DISABLED` "Pemesanan dimatikan untuk toko ini."; `RESOURCE_NOT_FOUND` "Penawaran, produk, atau resource tidak ditemukan."; `RESOURCE_MODE_MISMATCH` "Resource tidak sesuai dengan penawaran (menginap atau slot waktu)."; `RESOURCE_NOT_ACTIVE` "Resource tidak aktif. Pilih yang aktif."

### 11.2 Kebijakan uang muka

Tujuan: menetapkan uang muka produk jasa sebagai persen dari total kena pajak, jumlah tetap per unit kuantitas (per malam untuk produk per malam), atau mengembalikannya ke pembayaran penuh. Produk tanpa kebijakan dibayar penuh; tidak ada bawaan tenant (ADR-0045 D5).

- **Daftar.** Satu baris per produk jasa: Produk (nama, SKU), Status, Kebijakan (teks: "Pembayaran penuh", "30.00% dari total", "Rp 50.000,00 per unit"), Tindakan. `details` "Ubah uang muka" per baris (hanya dengan `.update`) memuat formulir; ringkasannya adalah pengungkap yang dapat dijangkau keyboard.
- **Formulir.** Fieldset "Uang muka" dengan radio (Pembayaran penuh / Persen / Jumlah tetap per unit); kolom Persen (0-100, dua desimal) dan kolom Tetap (jumlah, dua desimal) hanya tampil untuk radionya, dan kolom tersembunyi dikeluarkan dari urutan tab. Pengiriman memakai `PUT` dengan `{ kind, percent | fixedAmount }`; tidak pernah mengirim jumlah hasil hitung. Satu baris di bawah formulir menyatakan: "Uang muka pada tiap pesanan dihitung oleh server dan ditetapkan saat pesanan dibuat; mengubah ini tidak mengubah pesanan yang ada."
- **Catatan Allow-DP.** Karena kebijakan menjaga bendera lama "izinkan uang muka" tetap sejalan, baris tidak menampilkan sakelar terpisah; kontrol pada formulir produk dikunci server selama `booking` aktif (`ALLOW_DP_MANAGED_BY_POLICY`), dan layar menyatakannya dalam petunjuk.
- Teks validasi: "Masukkan persentase antara 0 dan 100 dengan paling banyak dua desimal." / "Masukkan jumlah lebih besar dari nol dengan paling banyak dua desimal."

### 11.3 Pengaturan akun layanan

Satu kolom pada formulir pengaturan toko, dalam legendanya sendiri "Booking": "Akun layanan pemesanan (ID pengguna)", sebuah uuid, dengan petunjuk "Pengguna staf yang dicatat Booking untuk checkout tamu dan tindakan otomatis. Harus pengguna aktif toko ini. Kosongkan untuk menghapusnya." Kolom hanya dirender selama fitur `booking` aktif dan hanya untuk pemirsa yang dapat membaca pengaturan; dikirim dengan bilah simpan yang ada dan mengirim `bookingServiceTenantUserId` (uuid, atau `null` untuk menghapus). Pengguna tidak aktif atau milik tenant lain ditolak server dengan galat kolom, ditampilkan di kotak galat formulir.

### 11.4 Versi kebijakan pembatalan (dispesifikasikan di sini, dibangun oleh #381)

> **Dibangun** oleh [#381](https://github.com/ahliweb/awcms-one/issues/381) sebagai `/admin/commerce-booking-policies`; bagian 11.4 dan 11.5 diikuti, dengan dua keputusan: draf tidak pernah disunting (suntingan adalah draf baru, karena tabel jendela hanya-sisip), dan konfirmasi serta step-up adalah `<dialog>` asli.

Tujuan: menyusun jendela bagian 4.1 sebagai **versi**: draf diedit, disetujui orang kedua, dan baru kemudian menjadi versi aktif; versi lama tetap dapat dibaca dan tidak pernah berubah, sehingga setiap pengembalian dana dapat dijelaskan oleh versi yang berlaku.

- **Pemilih cakupan.** "Bawaan tenant" atau satu produk. Halaman menampilkan **versi aktif** sebagai tabel bagian 4.1, lalu **Draf** (dapat diedit, dengan `.create`), lalu **Riwayat** (tabel `.data-table-scroll` hanya-baca: nomor versi, cakupan, disetujui oleh dan pada, ringkasan jendela, pil status). Baris riwayat tidak punya kontrol ubah atau hapus (tidak ada, bukan dinonaktifkan).
- **Editor jendela.** Baris "Batal paling lambat [n] [jam|hari] sebelum check-in" dan "Pengembalian [0-100]%". Baris harus berurutan dan tidak tumpang tindih; formulir menyatakan aturannya dan server menegakkannya. Baris terakhir untuk pengembalian no-show paling banyak sebesar yang dinyatakan kebijakan.
- **Setujui** (`.approve`, orang yang berbeda dari penyusun — pemisahan tugas, C-11): tombol membuka dialog konfirmasi yang menampilkan jendela berdampingan dengan versi aktif.
- State: memuat, kosong ("Belum ada kebijakan pembatalan. Tamu tidak akan melihat ketentuan pengembalian dana."), galat, sukses - seperti bagian 1.1.

### 11.5 Dialog penggantian pengembalian dana (dispesifikasikan di sini, dibangun oleh #381)

Tujuan: tindakan staf bagian 4.3, pada detail pesanan dan detail reservasi, untuk reservasi yang tidak dikembalikan dananya oleh kebijakan sesuai maksud staf. Ini kontrak yang dibangun #381.

- **Visibilitas.** Kontrol "Ubah pengembalian dana" tidak ada (bukan dinonaktifkan) tanpa `commerce.booking_refund_overrides.approve`. Juga tidak ada bila tidak ada yang dibayar.
- **Dialog.** `<dialog>` modal asli (pola bersama: fokus masuk, Escape membatalkan, fokus kembali ke pembuka, latar inert) bernama "Ubah jumlah pengembalian dana" dan dijelaskan oleh angkanya. Baris: Dibayar (hanya-baca), Pengembalian menurut kebijakan (hanya-baca, dihitung server), Jumlah pengembalian baru (angka, `min` 0, `max` = jumlah dibayar, `step` 0.01, `inputmode="decimal"`), Alasan (textarea, wajib, minimal 10 karakter, penghitung diumumkan secara sopan).
- **Batas.** Petunjuknya: "Maksimal Rp X: sebesar yang sudah dibayar." Tombol kirim **dinonaktifkan selama jumlah di atas jumlah dibayar, di bawah nol, salah format, atau alasan terlalu pendek**, dan kolom memuat `aria-invalid="true"` beserta pesannya; `max` pada input hanya kemudahan. **Server menegakkan batas yang sama** dan menolak jumlah lebih besar dengan `REFUND_EXCEEDS_PAID` (409), ditampilkan di peringatan dialog; permintaan buatan tangan mendapat penolakan yang sama.
- **Step-up.** Pengiriman memicu autentikasi ulang step-up; penggantian hanya dicatat setelah berhasil. Step-up yang gagal atau ditinggalkan tidak mengubah apa pun dan dialog tetap terbuka dengan nilai yang diketik.
- **Teks.** Judul "Ubah jumlah pengembalian dana"; konfirmasi "Catat perubahan"; batal "Pakai jumlah sesuai kebijakan" (fokus bawaan); status sukses "Pengembalian dana ditetapkan Rp X. Perubahan dicatat beserta alasan Anda." Tamu tidak pernah melihat alasan atau pelakunya (bagian 4.3).
- **State.** Memuat (angka belum dimuat: kolom dinonaktifkan, `aria-busy`), galat (pratinjau gagal: coba lagi, kirim dinonaktifkan), dan sukses (dialog menutup, detail dimuat ulang dan menampilkan pengembalian tercatat serta pil "Disesuaikan").

### 11.6 Jadwal ulang dan tamu tidak hadir pada panel booking (dibangun oleh #382)

Tujuan: tindakan staf pada bagian 4.3 di detail pesanan yang dibooking: memindahkan reservasi ke tanggal baru (selisih harga dibawa oleh jalur pesanan dan refund), dan menandai tamu yang tidak datang. Keduanya berada pada panel booking di bagian 11.5 (`CommerceBookingPanel`), di balik fitur `booking`.

- **Jadwal ulang - visibilitas.** Tombol "Jadwalkan ulang" tidak ada (bukan dinonaktifkan) tanpa `commerce.booking_reservation_links.update`, dan setelah reservasi tidak lagi terkonfirmasi atau sudah memiliki keputusan.
- **Jadwal ulang - dialog.** `<dialog>` modal asli bernama "Jadwalkan ulang reservasi", dijelaskan oleh tanggal saat ini ("Saat ini 2026-12-10 sampai 2026-12-12 (2 malam). Harga selisih apa pun dihitung oleh server, tidak pernah diketik di sini."). Menginap menampilkan input tanggal "Check-in baru" dan "Check-out baru"; slot waktu menampilkan "Mulai baru (UTC)". Pilihan "Alasan" menawarkan daftar tertutup (tamu meminta pindah, pihak properti perlu memindahkannya, pemesanan ganda, alasan lain). Tanggal paling awal berasal dari jam server (`serverNow`), satu hari lebih awal dari tanggal UTC-nya karena tanggal lokal sumber daya dapat tertinggal dari UTC.
- **Harga adalah milik server.** "Periksa harga" dinonaktifkan sampai tanggalnya valid (tanggal nyata, check-out setelah check-in, tidak di masa lalu, bukan tanggal saat ini) lalu meminta `GET .../reschedule-quote`; jawabannya ditampilkan sebagai satu kalimat di wilayah live yang sopan: lama sama ("tidak ada yang dihitung; hanya reservasi yang berpindah"); menginap lebih lama ("malam tambahan ditagih sebagai pesanan terpisah sebesar Rp X, yang dibayar pelanggan seperti pesanan lain"); menginap lebih singkat ("malam yang dihapus bernilai Rp X; kebijakan pembatalan awal mengembalikan Rp Y, diantrekan di Pengembalian barang dan dana", atau "tidak mengembalikan apa pun", atau "tidak ada kebijakan pembatalan yang berlaku"). Peramban tidak menghitung dan tidak mengirim angka apa pun: body POST adalah waktu baru dan kode alasan.
- **Kirim.** "Jadwalkan ulang" mengirim dengan `Idempotency-Key`; halaman dimuat ulang saat berhasil dan menampilkan reservasi baru serta satu baris riwayat. Penolakan ditampilkan di dalam dialog dengan kata-kata: tanggal tidak tersedia (`SLOT_UNAVAILABLE`), menginap lebih singkat pada saldo belum dibayar (`BALANCE_OUTSTANDING`), malam yang dijual pada pesanan lain (`REDUCTION_NOT_SUPPORTED`), malam tambahan tidak dapat dijual (`SUPPLEMENT_ORDER_UNAVAILABLE`), dan lainnya.
- **Riwayat.** Tabel "Penjadwalan ulang" (`.data-table-scroll`, `data-table--stack`): kapan, malam sebelum dan sesudah, selisih (lama sama, menginap lebih lama, menginap lebih singkat), jumlah dihitung dan refund, serta pesanan tambahan dengan kodenya (tautan ke pesanan itu), status, dan total.
- **Tamu tidak hadir - visibilitas.** Blok "Tamu tidak datang" muncul untuk reservasi terkonfirmasi yang kedatangan aslinya telah lewat, bagi pengguna yang memegang kunci cancel dan keputusan sekaligus. Ia menampilkan kebijakan yang berlaku, aturan tamu tidak hadir (tahan uang muka, tahan semua yang dibayar, refund menurut jendela), yang sudah dibayar, dan yang ditahan kebijakan.
- **Tamu tidak hadir - tindakan.** "Tandai tidak hadir" membuka dialog konfirmasi bersama, yang menyatakan angkanya dan bahwa tidak ada yang dikembalikan; Booking yang memutuskan apakah kedatangan ditambah toleransi sudah lewat (`NO_SHOW_TOO_EARLY` ditampilkan sebagai "Terlalu dini..."). Setelah keputusan, panel menampilkan "Keputusan tamu tidak hadir" dengan "Ditahan oleh kebijakan" dan "Tidak ada uang yang berpindah: tamu yang tidak hadir tidak pernah dikembalikan dananya."
- **Status.** Kuotasi memuat ("Memeriksa harga..."), kuotasi galat (di dalam dialog, kirim tetap tersedia), dan berhasil (muat ulang).

### 11.7 Aksesibilitas, keyboard, dan 360px untuk layar ini

Landasan bagian 6 berlaku; tambahan:

- **Keyboard.** Setiap kontrol dapat dijangkau dalam urutan baca: tautan filter, formulir buat, wilayah tabel (dapat difokus, bernama), tombol baris, pengungkap `details`; Enter dan Spasi mengoperasikan tombol dan ringkasan; dialog konfirmasi menjebak fokus, Escape membatalkan, dan fokus kembali ke tombol baris. Tidak ada affordance khusus penunjuk.
- **Nama dan status.** Setiap input punya `<label>` terlihat yang diikat `for`/`id`; petunjuk dikaitkan dengan `aria-describedby`; pil status selalu memuat teksnya; galat adalah pesan teks di wilayah `role="alert"`, tidak pernah hanya warna.
- **Tanpa dialog bawaan peramban.** Konfirmasi destruktif memakai `CommerceConfirmDialog` bersama; `window.confirm`, `alert`, dan `prompt` dilarang (gerbang admin gagal bila dilanggar).
- **360px.** Tabel memakai `data-table--stack` dengan `data-label` pada tiap sel, di dalam wilayah `.data-table-scroll`; formulir satu kolom dengan kontrol 44px; halaman tidak pernah menggulir horizontal; id panjang dibungkus (`overflow-wrap: anywhere`).
- **Verifikasi.** Pemindaian axe `wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa` dan pemeriksaan overflow 360px mencakup layar yang ada (11.1 sampai 11.3); 11.4 dan 11.5 bergabung saat #381 membangunnya.
