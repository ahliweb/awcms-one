🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0032-barcodes-are-a-derived-identifier-and-the-cashier-keyboard-layer-is-chord-only.md)

<!-- i18n-source-hash: sha256:89ae580c1bc2c090a5a1dbb35e4df9f178977a0af5578cf43a3d5a5d9d90d8d5 -->

<!-- i18n-source-hash: sha256:placeholder -->

# ADR-0032 — Barcode adalah pengenal per tenant dengan simbologi turunan, label dirender di server, dan lapisan keyboard kasir hanya berbasis kombinasi tombol

- **Status:** Diterima
- **Tanggal:** 4 Oktober 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** issue [#297](https://github.com/ahliweb/awcms-one/issues/297) (hanya-template: kemampuan generik yang dapat dipakai ulang tanpa keterikatan pada perangkat keras vendor tertentu); [ADR-0016](0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) (apa yang dianggap kredensial oleh repositori ini: barcode bukan kredensial); [ADR-0015](0015-commerce-migrations-live-in-the-reserved-9xx-range.md) (rentang migrasi); [ADR-0028](0028-pos-register-sessions-and-cash-up.md) (layar POS yang diperluas); [ADR-0029](0029-commerce-documents-are-separate-records-and-numbered-documents-are-immutable-order-snapshots.md) (kontrol penjualan tertahan yang bersebelahan dengannya); issue [#292](https://github.com/ahliweb/awcms-one/issues/292) di bawah epic [#281](https://github.com/ahliweb/awcms-one/issues/281). Barcode paket/bundel (issue #290) ditunda bersama epic bundel, yang sendiri terblokir oleh pekerjaan persediaan pada issue #282.

## Konteks

Meja kasir cepat ketika tangan kasir tidak pernah meninggalkan pemindai dan keyboard. Sistem POS yang matang menyediakan barcode pada setiap barang, label yang dapat dicetak, kolom pindai yang "langsung jalan" dengan pemindai USB, dan pintasan keyboard untuk aksi yang diulang kasir sepanjang hari. Layar POS repositori ini belum punya satu pun: kasir mencari berdasarkan nama atau SKU lalu mengeklik.

Empat pertanyaan harus dijawab sebelum menulis kode: _apa itu barcode dan di mana disimpan_, _bagaimana label dibuat_, _bagaimana pindaian dibedakan dari ketikan_, dan _bagaimana lapisan pintasan menghindari bentrok dengan peramban, teknologi bantu, dan ketikan biasa_. Keempatnya dibatasi oleh teks issue yang sama: **barcode adalah pengenal, bukan autentikasi atau otorisasi.**

## Keputusan

### D1 — Barcode adalah kolom nullable pada dua baris yang dapat dijual, unik per tenant lintas keduanya; simbologinya diturunkan, tidak disimpan

`barcode text` pada `awcms_commerce_products` dan `awcms_commerce_product_variants` (`sql/975`). 1 sampai 48 karakter ASCII yang dapat dicetak, tanpa spasi (repertoar Code 128 subset B yang dapat diketik ulang pemindai wedge); tidak boleh diawali `<angka>*` (sintaks pengali jumlah pada kolom pindai, D5). Kode berisi angka saja dengan panjang 8, 12, 13, atau 14 digit menurut definisi adalah GTIN dan **harus** memiliki digit pemeriksa GS1 yang benar — yang salah ditolak, tidak pernah "dibetulkan"; selain itu adalah kode internal bebas. Simbologi (EAN-13, EAN-8, UPC-A yang dicetak sebagai EAN-13 dengan nol di depan, GTIN-14 dan semua kode internal sebagai Code 128) adalah fungsi murni dari kodenya, sehingga tidak ada kolom kedua yang dapat berbeda dengannya.

**Keunikan** berlaku per tenant di antara produk **dan** varian yang _hidup_: pemindai membaca satu string dan harus menunjuk tepat satu hal. Tiap tabel punya indeks unik parsial `(tenant_id, barcode) WHERE deleted_at IS NULL AND barcode IS NOT NULL` — yang juga merupakan indeks pencarian — dan trigger `BEFORE INSERT OR UPDATE` menolak kode yang dipegang baris hidup di tabel lainnya, di bawah advisory lock tingkat transaksi yang **dibagi menjadi strip** (256 strip) agar dua penulis bersamaan untuk kode baru yang sama mengantre, bukan sama-sama lolos pemeriksaan. Dua tenant boleh memakai kode yang sama.

|                          | A. Kolom pada tiap baris + trigger lintas tabel (dipilih)                                                   | B. Tabel `barcodes` terpisah (satu baris per kode, banyak kode per barang)                                                         | C. Pakai ulang `sku` sebagai barcode                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Keamanan                 | mewarisi FORCE RLS, filter tenant, dan retensi baris yang ditunjuknya; tidak ada hal baru yang bisa terlupa | tabel baru dengan kebijakan, deskriptor siklus hidup, entri data subjek, dan hak worker sendiri — masing-masing tempat untuk salah | tidak ada yang baru, tetapi SKU bersifat untuk manusia dan dapat diubah |
| Kinerja                  | satu probe kesetaraan pada indeks unik parsial; terverifikasi sebagai index scan pada 20.000 baris          | join pada setiap pindaian                                                                                                          | sudah terindeks (trigram, bukan kesetaraan)                             |
| Aksesibilitas / UX       | satu kode per barang: mudah dijelaskan dan dicetak                                                          | beberapa kode per barang (ukuran kemasan, EAN lama) — kebutuhan nyata sebagian peritel                                             | tanpa digit pemeriksa GTIN, tanpa kode label terpisah                   |
| Kompatibilitas           | menambah satu kolom nullable; tidak mengubah query atau respons yang ada                                    | FK dan join baru pada jalur POS                                                                                                    | tidak ada perubahan                                                     |
| Kompleksitas operasional | satu trigger; memulihkan baris yang kodenya dipakai ulang kembali tanpa barcode, bukan gagal                | logika pembersihan, yatim, dan penggabungan untuk tabel tambahan                                                                   | tidak ada                                                               |
| Jangka panjang           | beberapa kode per barang tetap bisa ditambahkan kelak sebagai tabel B tanpa membatalkan data A              | paling umum                                                                                                                        | mengunci makna SKU                                                      |

**Dipilih: A.** Satu kode per barang adalah yang diminta issue dan yang dibutuhkan peritel kecil; beberapa kode per barang adalah ekstensi yang ditunda (lihat "Ditunda").

**Pelajaran yang dicatat.** Versi pertama trigger mengambil satu advisory lock _per kode_. Pemuatan massal 20.000 baris ber-barcode dalam satu transaksi gagal dengan `out of shared memory` — advisory lock menempati satu slot tabel kunci bersama sampai commit. Pembagian strip membatasi satu transaksi pada 256 slot. Tes integrasi memasukkan 20.000 baris ber-barcode dalam satu pernyataan justru karena alasan ini.

### D2 — Pencarian adalah probe kesetaraan yang berizin dan dibatasi tenant, dengan satu jawaban netral saat tidak ditemukan

`GET /api/v1/commerce/barcodes/lookup?code=` menyelesaikan kode menjadi satu produk atau varian yang ditunjuknya di tenant pemanggil, dibatasi oleh `commerce.barcodes.read` dan fitur `barcode`. Kode tak dikenal, baris yang sudah dihapus lunak, dan kode milik tenant lain dijawab dengan badan `404` yang sama — endpoint ini bukan orakel untuk kode tenant lain. Predikatnya adalah `=` biasa pada `text` (leakproof, sehingga aman berdampingan dengan kualifikasi RLS), dan responsnya menyebut `requiresVariant` (induk polos dari produk bervarian tidak dapat dijual) dan `sellable` (aktif, ada stok, tanpa varian), sehingga layar tidak butuh permintaan kedua. Penetapan adalah `PUT /api/v1/commerce/barcodes` di bawah `commerce.barcodes.update`; ia menetapkan keadaan sehingga tidak membawa `Idempotency-Key`. Duplikat adalah `409 BARCODE_DUPLICATE`.

Kedua izin ini **dipisah per sumber daya dan baru**: menjalankan penjualan (`commerce.pos.create`) tidak memberi kasir hak mengubah label katalog, dan menyunting produk (`commerce.products.update`) tidak memberi siapa pun hak memindahkan kode yang secara fisik tertempel pada barang. `AccessAction` tidak diperlebar.

### D3 — Label dirender di server, hanya dari angka, tanpa dependensi baru

`domain/barcode.ts` berisi encoder Code 128 (subset B dan C, dengan checksum) dan EAN-13/EAN-8 — sekitar 150 baris ditambah tabel 107 simbol, diverifikasi oleh tes (setiap pola berjumlah 11 modul, digit pemeriksa dan GTIN yang diketahui, garis pelindung dan paritas). Layar label merender setiap set batang sebagai **satu `<path>` SVG inline yang hanya berisi bilangan bulat**; semua teks tenant (nama, SKU, kode, harga) adalah markup biasa yang di-escape, tidak pernah `set:html`. Angka tata letak (kolom, salinan, ukuran label) dijepit menjadi bilangan bulat sebelum sampai ke atribut `style`, dan sebuah kode dirender hanya bila divalidasi ulang.

|                          | A. SVG dirender server, encoder sendiri (dipilih)                                            | B. Pustaka sisi klien (sekelas JsBarcode)                                    | C. PDF sisi server                         |
| ------------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------ |
| Keamanan                 | tanpa skrip pada jalur cetak; SVG tidak memuat teks tenant                                   | kode pihak ketiga pada layar yang menangani katalog; teks disuntikkan ke SVG | perangkat PDF di server                    |
| Kinerja                  | nol JavaScript klien untuk label; halamannya adalah lembarnya                                | puluhan kB ditambahkan ke anggaran klien                                     | CPU per cetak                              |
| Aksesibilitas            | lembar adalah HTML nyata yang dapat dicetak; SVG `aria-hidden` dan kode dicetak sebagai teks | canvas/SVG dibangun saat runtime                                             | PDF harus dibuat aksesibel tersendiri      |
| Kompatibilitas           | peramban apa pun yang dapat mencetak; `@media print` menyembunyikan chrome                   | sama                                                                         | butuh penampil                             |
| Kompleksitas operasional | tidak ada selain tes encoder                                                                 | dependensi untuk dilacak dan diaudit                                         | dependensi berat dan font                  |
| Jangka panjang           | cukup untuk Code 128 dan EAN/UPC; QR/DataMatrix kelak butuh pustaka sungguhan                | dukungan simbologi luas                                                      | bagus untuk stok label yang sudah dipotong |

**Dipilih: A**, dengan cetak peramban sebagai keluarannya. Ekspor PDF dan simbologi tambahan (ITF-14 dengan bearer bar, GS1-128, QR) ditunda, bukan dibuat setengah jadi.

### D4 — Deteksi pindai: kolom khusus ditambah detektor semburan cepat global yang tidak pernah aktif di kolom teks

Kolom pindai menerima kode saat Enter pada kecepatan ketik berapa pun (kasir boleh mengetik kode manual). Detektor global ada agar kasir yang terakhir mengeklik tombol tetap dapat memindai: ia mengenali semburan karakter yang dapat dicetak yang setiap jeda antar-tombolnya paling banyak 35 md, sedikitnya empat karakter, diakhiri Enter. Ia adalah kelas murni yang diberi peristiwa tombol beserta cap waktunya sendiri (sehingga deterministik saat diuji), dan ia **tidak pernah aktif untuk tombol yang diketik di dalam kolom teks** — pemanggil menandainya dan buffer dibuang — sehingga pindaian tidak dapat salah dikira ketikan ke nama pelanggan, dan ketikan pelanggan tidak dapat salah dikira pindaian. Tab, Spasi, panah, kombinasi pengubah, dan jeda apa pun mereset-nya. Enter dari semburan yang dikenali ditelan (`preventDefault`) agar tidak sekaligus menekan tombol yang sedang fokus — kalau tidak, pindaian dapat "mengeklik" _Selesaikan penjualan_.

Pemindai wedge yang dikonfigurasi dengan akhiran Tab tidak didukung: Tab adalah cara kasir keyboard-saja memindahkan fokus, dan detektor tidak boleh memakannya. Sintaks jumlah opsional adalah `N*KODE` (1 sampai 999) hanya pada kolom pindai; pengali tanpa kode (`3*`) adalah kesalahan, dan karena kode tersimpan tidak boleh diawali `<1-3 digit>*`, pemisahan itu tak ambigu. Format barcode dengan harga/berat tertanam ("profil parser yang di-allowlist" dalam issue) **tidak dibangun**: tidak ada kebutuhan tervalidasi, dan parser yang membaca harga dari sebuah kode membuat siapa pun yang mencetak label dapat menetapkan harga — batas kepercayaan yang tidak dibuka ADR ini.

Hasil disampaikan kepada teknologi bantu: keberhasilan lewat wilayah `role="status"` yang sopan, setiap kegagalan (kode tak dikenal, stok habis, perlu varian, melebihi stok, pencarian gagal) lewat pesan sebaris `role="alert"`. Tidak ada modal.

### D5 — Pintasan: hanya kombinasi tombol, tiga lapisan, penimpaan pribadi tetap di peramban

Bawaan → peta tenant (pengaturan modul `commerce` `posShortcuts`, disunting lewat API pengaturan modul yang ada) → peta pengguna sendiri (`localStorage` peramban, `awcms-one:pos-shortcuts:v1`). Tiap lapisan boleh mengikat ulang himpunan bagian mana pun; setiap entri divalidasi dan lapisan yang akan bentrok dengan lapisan di bawahnya dibuang entri demi entri, sehingga nilai tersimpan yang buruk turun ke bawaan dan tidak pernah dapat menonaktifkan sebuah aksi.

**Yang boleh menjadi kombinasi:** `Alt+Shift+<huruf atau angka>`; tombol fungsi `F2`, `F4`, `F8`, `F9`; `Ctrl+Enter` / `Ctrl+Shift+Enter`. Ditolak dengan alasan: karakter tercetak polos (WCAG 2.1.4 Character Key Shortcuts), `Ctrl+<huruf>` (peramban), `Meta+…` (OS), `Alt+<huruf>` tanpa Shift (mnemonik menu), `Alt+Panah/Home/F4`, `Tab`, `Escape`, `Enter`, `Spasi`, panah, dan `F1 F3 F5 F6 F7 F10 F11 F12` yang dicadangkan peramban. Pencocokan memakai tombol fisik (`event.code`) sehingga berfungsi pada tata letak keyboard apa pun dan pada Option macOS. Pintasan adalah kombinasi, jadi sengaja berfungsi dari dalam kolom (di situlah tangan kasir berada) tanpa pernah memakan ketikan biasa; pintasan diabaikan saat dialog terbuka.

|                          | A. Hanya kombinasi, bawaan tenant + penimpaan per peramban (dipilih)                                                                         | B. Mnemonik tombol polos (`/` untuk cari, `h` untuk tahan)                                  | C. Peta per pengguna disimpan di server             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Keamanan                 | tidak ada yang baru di server                                                                                                                | tidak ada                                                                                   | tabel baru dengan kewajiban data subjek dan retensi |
| Aksesibilitas            | memenuhi WCAG 2.1.4; tidak bentrok dengan tombol pembaca layar (mereka memakai Insert/CapsLock)                                              | gagal 2.1.4 kecuali setiap tombol dapat diikat ulang atau dimatikan; bentrok dengan ketikan | sama dengan A                                       |
| UX                       | dialog bantuan yang terlihat mendaftar dan mengikat ulang setiap kombinasi; tombol "Pintasan keyboard" yang selalu ada membuatnya terjangkau | tercepat bagi yang mahir, tidak ramah untuk kolom nama pelanggan                            | mengikuti orangnya ke mesin mana pun                |
| Kompatibilitas           | berfungsi di semua peramban; kegagalan penyimpanan hanya kehilangan penimpaan                                                                | bentrok dengan pencarian type-ahead peramban                                                | butuh perjalanan ke server                          |
| Kompleksitas operasional | tidak ada                                                                                                                                    | tidak ada                                                                                   | tabel, endpoint, jalur purge                        |

**Dipilih: A.** Penimpaan pribadi adalah kemudahan per perangkat (kasir di terminal bersama menginginkan tata letak _terminal_ itu), dan bawaan tenant adalah kontrak bersama. Penyimpanan per pengguna di server ditunda sampai ada yang membutuhkan peta mengikuti orang antarperangkat.

### D6 — Seluruh permukaan berada di balik feature flag yang bawaannya MATI

`features.barcode` (bawaan **mati**, flag ketiga seperti itu setelah `register` dan `documents`). Dengan flag mati tidak ada kolom pindai, detektor, lapisan pintasan, tombol bantuan, atau entri navigasi, dan setiap rute barcode menjawab `409 FEATURE_DISABLED` — tenant yang tidak pernah membuka "Fitur" melihat POS persis seperti sebelumnya. Kolom pindai juga membutuhkan `commerce.barcodes.read`; lapisan pintasan tidak. Alur mouse/sentuh yang ada tidak disentuh: pencarian, klik-untuk-tambah, bagian pembayaran, dan struk tidak distrukturkan ulang (lapisan keyboard menjangkaunya lewat id elemen yang ada dan satu kait `addScanned`).

## Konsekuensi

- Migrasi `sql/975`–`976` (kolom, indeks, trigger; izin). `977`–`979` tetap dicadangkan. Tidak ada tabel baru, jadi tidak ada deskriptor retensi, entri data subjek, atau hak worker baru.
- Dua izin, tiga rute, satu layar admin (`/admin/commerce-labels`), satu modul klien (`lib/ui/pos-keyboard-client.ts`) dan tiga modul domain murni, masing-masing dengan tes unit; tes integrasi mencakup keunikan (satu tabel, lintas tabel, per tenant), balapan penulis bersamaan, RLS, BOLA, pemakaian ulang setelah hapus lunak, pemulihan, rencana indeks 20.000 baris, feature flag, dan pemisahan izin.
- Anggaran aset klien diukur ulang (lihat `apps/cms/scripts/client-asset-budget.ts`).
- Barcode yang tercetak pada label hidup lebih lama daripada nama dan harga baris: mengubah barcode barang yang sudah ada di rak membuat labelnya yatim. Layar karena itu tidak meminta hal khusus — tetapi jejak audit mencatat setiap penetapan dan penghapusan.

## Ditunda (tidak dibangun di sini, dengan sengaja)

- **Beberapa barcode per barang** (ukuran kemasan, EAN yang digantikan) — opsi B di atas; dapat ditambahkan kelak.
- **Barcode bundel** (issue #290) — terblokir oleh epic persediaan (#282).
- **Barcode dengan harga/berat tertanam** — lihat D4; butuh kebutuhan tervalidasi dan tinjauan kepercayaan sendiri.
- **Ekspor label PDF, ITF-14, GS1-128, QR/DataMatrix** — D3.
- **Layar penyunting pintasan tingkat tenant** — peta tenant disunting lewat API pengaturan modul saat ini; tiap kasir sudah dapat mengikat ulang miliknya sendiri.
- **Penyimpanan pintasan per pengguna di server** — D5.
- **E2E peramban nyata untuk alur pindai/keyboard** — logika waktu dan kebijakan diuji unit dan rute diuji integrasi, tetapi matriks Playwright (`local-ci/e2e-*`) tidak diperluas dalam perubahan ini.
