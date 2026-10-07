🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0036-bundles-are-component-stocked-products-sold-as-one-line.md)

<!-- i18n-source-hash: sha256:4ec3cdce2f294a1ca44ff8a5d0b969dbe704568bd4663609c4c2d244c27fa6fe -->

<!-- i18n-source-hash: sha256:placeholder -->

# ADR-0036 — Bundle adalah produk yang tersusun dari komponen: dijual sebagai satu baris, stoknya bergerak lewat komponennya

- **Status:** Diterima
- **Tanggal:** 5 Oktober 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** issue [#290](https://github.com/ahliweb/awcms-one/issues/290) (epik induk [#281](https://github.com/ahliweb/awcms-one/issues/281); khusus-template: kemampuan generik yang dapat dipakai ulang, [ADR-0024](0024-awcms-one-is-template-only-derived-apps-own-their-backend.md)); [ADR-0038](0038-commerce-stock-is-a-write-through-cache-of-the-inventory-ledger.md) (adaptor inventori yang dilalui setiap pergerakan stok di sini); [ADR-0039](0039-commerce-tax-is-computed-by-the-tax-module-behind-a-per-tenant-mode.md) (pajak per baris); [ADR-0033](0033-returns-refunds-and-exchanges-are-additive-records-that-compensate-through-the-existing-ledgers.md) (retur; nilai per unit); [ADR-0032](0032-barcodes-are-a-derived-identifier-and-the-cashier-keyboard-layer-is-chord-only.md) (barcode); [ADR-0029](0029-commerce-documents-are-separate-records-and-numbered-documents-are-immutable-order-snapshots.md) (snapshot immutable); [ADR-0035](0035-pos-operational-reports-are-commerce-projections-over-the-existing-ledgers-on-the-reporting-engine.md) (laporan bundle yang ditundanya); [ADR-0015](0015-commerce-migrations-live-in-the-reserved-9xx-range.md) (rentang migrasi).

## Konteks

Sebuah toko menjual "paket kopi": dua kantong kopi dan satu botol sirup dengan satu harga. Sampai sekarang satu-satunya cara adalah produk dengan penghitung `stock`-nya sendiri yang dijaga sejalan dengan tiga produk nyata secara manual — masalah dua sumber kebenaran yang persis dihapus [ADR-0038](0038-commerce-stock-is-a-write-through-cache-of-the-inventory-ledger.md) untuk stok itu sendiri. Menjual paket harus mengambil bagian-bagiannya dari rak, pesanan yang dibatalkan harus mengembalikannya, dan paket yang diretur harus me-restock bagian-bagiannya — tanpa pengurangan tersembunyi di mana pun dan tanpa paket memiliki hitungan yang bisa menyimpang.

Migrasi 935 (issue #266) sudah menambahkan `awcms_commerce_products.type = 'bundle'`. Itu adalah _tipe_ produk deskriptif untuk paket gaya-entitlement dan tidak membawa semantik stok; ia dibiarkan persis seperti adanya dan **bukan** dasar keputusan ini.

## Keputusan

### D1 — Bundle adalah produk dengan `kind = 'bundle'`

`awcms_commerce_products` mendapat `kind` (`standard`, bawaan, atau `bundle`), `bundle_pricing`, dan `bundle_discount_percent` (`sql/953`). Bundle **tanpa varian** (trigger menolaknya), **tanpa stok sendiri** (kolom ditahan di `0` oleh `CHECK`, diabaikan semua pembaca, dan API admin serta impor CSV menolak nilai bukan nol), **bukan produk jasa** (`service_form IS NULL` lewat `CHECK`) dan **tidak layak masuk flash sale** (ditolak ketika flash sale menyebutnya, dan produk yang ada di flash sale tidak bisa menjadi bundle). Ini batasan lingkup yang disengaja, bukan kelalaian: kuantitas bundle adalah fungsi dari bagian-bagiannya, sehingga sumbu varian, penghitung, atau kuota flash sale masing-masing akan menjadi sumber kebenaran kedua. Karena bundle _adalah_ produk, ia mempertahankan slug, SKU, kategori, gambar, atribut, barcode ([ADR-0032](0032-barcodes-are-a-derived-identifier-and-the-cashier-keyboard-layer-is-chord-only.md): barcode milik produk bundle sendiri adalah "barcode bundle") dan setiap jalur daftar, pencarian, dan POS yang ada.

### D2 — Komponen adalah baris; nesting mustahil

`awcms_commerce_bundle_components` (`sql/953`): `(tenant_id, bundle_product_id, position, component_product_id, component_variant_id?, quantity)`, RLS `FORCE` dan kebijakan isolasi tenant seperti setiap tabel saudaranya. Referensinya **komposit** (`(tenant_id, id)` pada produk, `(variant, product)` pada varian), sehingga komponen tidak bisa menyebut produk tenant lain atau varian produk lain bahkan lewat bug — pemeriksaan foreign key melewati RLS, jadi constraint-lah yang membawa tenant. Unik `(tenant, bundle, position)` dan `(tenant, bundle, produk komponen, varian komponen)`; 1–20 baris; `quantity` 1–10000. Sebuah trigger menegakkan aturan yang tidak bisa dinyatakan skema: baris bundle harus berupa bundle, komponen **tidak pernah berupa bundle**, bundle tidak bisa menyebut dirinya, produk komponen yang punya varian aktif harus menyebut salah satunya, dan bundle punya paling banyak 20 baris. Trigger cermin pada `products.kind` menolak mengubah produk yang dipakai sebagai komponen menjadi bundle, mengubah produk bervarian menjadi bundle, dan mengubah bundle kembali menjadi produk standar selagi masih punya komponen. Kedua trigger mengunci baris yang dibacanya (`FOR NO KEY UPDATE` pada bundle, `FOR SHARE` pada komponen), sehingga "tambahkan P sebagai komponen" dan "jadikan P bundle" yang bersamaan berjalan serial dan salah satunya kalah. **Nesting ditolak**; siklus karenanya mustahil secara konstruksi dan tidak ada penelusuran graf yang bisa salah.

### D3 — Dua strategi harga, otoritatif di server

`fixed` (bawaan): harga produk bundle sendiri, tier dan persentasenya, persis seperti produk apa pun. `derived`: **Σ (harga satuan daftar komponen × kuantitas)** dikurangi `bundle_discount_percent`, dibulatkan half-up ke sen, dalam sen bilangan bulat lewat helper uang modul ([ADR-0003](0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md)). Harga satuan daftar komponen adalah harga override variannya atau harga produknya setelah persentase produk itu sendiri; harga tier dan flash sale tidak berlaku pada bundle derived. Angkanya dihitung saat penawaran di server, tidak pernah diambil dari klien, dan `finalPrice` publik bundle derived membawanya (kolom `price` mentah dibiarkan agar formulir admin tidak menulis angka turunan kembali). Strategi lain adalah **ekstensi berversi**: nilai baru `bundle_pricing` di balik `CHECK` yang sama, bukan formula bebas.

### D4 — Ketersediaan dihitung, dan ditampilkan sebagai `stock`

`ketersediaan = min atas komponen dari floor(stok komponen yang dapat dijual / kuantitas)`, dengan stok adalah `stock` varian atau produk komponen — pada mode `ledger` itu adalah cache write-through [ADR-0038](0038-commerce-stock-is-a-write-through-cache-of-the-inventory-ledger.md) D3, sehingga otoritasnya tetap satu. Komponen yang sama sekali tidak bisa dijual (dihapus, tidak `active`, varian yang dihapus, atau produk yang mendapat varian setelah ditambahkan) membuat bundle tidak tersedia. Penawaran keranjang melipat ini ke snapshot produk bundle, sehingga bundle yang kurang menjadi `out_of_stock` / `quantity_reduced` lewat mesin status yang ada; model baca katalog melaporkan angka hitungan itu sebagai `stock` bundle, sehingga etalase, pencarian POS, dan pencarian barcode tidak butuh field baru.

### D5 — Satu baris pesanan, snapshot komponen yang immutable

Bundle dijual sebagai **satu baris `awcms_commerce_order_items`** dengan harga bundle: pelanggan dan kasir melihat satu baris, dan setiap angkanya (subtotal, bagian diskon, pajak, nilai retur [ADR-0033](0033-returns-refunds-and-exchanges-are-additive-records-that-compensate-through-the-existing-ledgers.md)) adalah milik baris itu. Di sampingnya, `awcms_commerce_order_item_components` (`sql/954`) menyimpan satu baris per komponen sebagaimana terjual: id, SKU, nama, nama varian, unit per bundle, unit total, dan `allocated_value` (`numeric(14,2)`) — total baris dibagi ke komponen menurut nilai daftarnya dengan **sen sisa-terbesar (largest remainder)**, sehingga bagian-bagiannya berjumlah tepat sama dengan total baris (seri jatuh ke posisi lebih awal; nilai daftar nol semua dibagi rata). Baris bersifat **append-only** (trigger menolak UPDATE; role aplikasi tidak punya DELETE; item pesanan yang dipurge menghapusnya secara cascade), sehingga mengubah atau menghapus definisi bundle tidak pernah mengubah apa yang dibatalkan restock atau retur pesanan lama.

### D6 — Pergerakan stok: tanpa pengurangan tersembunyi

Baris bundle itu sendiri tidak pernah menggerakkan stok. **Komponennyalah yang bergerak, lewat satu adaptor** ([ADR-0038](0038-commerce-stock-is-a-write-through-cache-of-the-inventory-ledger.md)):

| Jalur | mode `counter` | mode `ledger` (sumber `(type, id, line)`) |
| --- | --- | --- |
| pesanan etalase, penjualan POS | penghitung tiap komponen, produk lalu varian, id menaik | `sale` per komponen, `commerce_order`, id pesanan, **`<orderItemId>:c<position>`** |
| pembatalan / kedaluwarsa | penghitung yang sama dinaikkan kembali | `sale_return` per komponen, `commerce_order_restock`, id pesanan, `<orderItemId>:c<position>` |
| retur | penghitung yang sama dinaikkan kembali | `sale_return` per komponen, `commerce_return`, id retur, `<returnLineId>:c<position>` |

Pada mode `ledger` baris komponen diposting **dalam savepoint yang sama, diurutkan bersama setiap baris lain dari pesanan** menurut `(itemType, itemRef, line)`, sehingga kunci saldo tetap dalam satu urutan global dan dua bundle yang berbagi komponen tidak pernah deadlock. Penolakan ledger menggulung seluruh pesanan dan dijawab `cart_changed` / `PosCartChangedError` persis seperti produk standar. Pada mode `counter` pesanan mengunci baris komponen bundle (`FOR NO KEY UPDATE`, produk lalu varian, id menaik), **menawar ulang terhadap hitungan yang terkunci**, baru menulis: penjualan yang kalah berebut unit komponen terakhir dijawab `cart_changed` sebelum satu baris pun darinya ada, dan `CHECK (stock >= 0)` tidak pernah menjadi yang menolak. Restock dan retur membaca **snapshot**, bukan definisi saat ini (D5). Retur hanya dalam **unit bundle utuh** — baris retur adalah baris bundle, sehingga retur komponen parsial tidak mungkin — dan disposisi restock-nya berlaku bagi setiap komponen; `damaged` / `quarantine` tidak mengubah apa pun di sini, seperti baris lain. **Pajak** ([ADR-0039](0039-commerce-tax-is-computed-by-the-tax-module-behind-a-per-tenant-mode.md)): bundle dipajaki sebagai **satu baris, menurut kategori pajak produk bundle itu sendiri**; kelas pajak per komponen ditunda (bundle barang yang dipajaki berbeda membutuhkan input mesin per komponen dan pembalikan per komponen).

### D7 — Admin, POS, etalase

Formulir produk mendapat sakelar "Bundle", strategi harga, persen diskon, dan editor isi berupa `<textarea>` biasa berisi baris `SKU x jumlah` (urutan baris adalah urutan komponen); server me-resolve tiap SKU menjadi produk atau varian aktif milik tenant, sehingga editor tidak butuh skrip pemilih, dan SKU yang tidak dikenal ditolak persis seperti id produk yang tidak dikenal. DTO admin produk membawa `kind`, `bundlePricing`, `bundleDiscountPercent`, dan `bundle` (komponen: id, SKU, nama, unit — tidak pernah harga pokok atau hitungan stok). Tanpa izin baru: bundle adalah produk, sehingga `commerce.products.*` yang mengaturnya. Pencarian POS dan pemindaian barcode menemukan bundle seperti produk apa pun (pencarian barcode melaporkan ketersediaan hitungan dan harga turunan); halaman produk etalase mendaftar isinya di bawah "Isi paket" dari pengambilan katalog saat build (output statis, tanpa panggilan runtime baru); baris penawaran keranjang membawa isinya agar keranjang dapat menampilkannya.

### D8 — Pelaporan

Tidak ada yang baru. Laporan bundle (penjualan per bundle, konsumsi komponen) ditunda, sebagaimana dicatat [ADR-0035](0035-pos-operational-reports-are-commerce-projections-over-the-existing-ledgers-on-the-reporting-engine.md): proyeksi penjualan sudah menghitung bundle sebagai baris produk yang ia adalah, dan pergerakan komponen adalah laporan `inventory` milik ledger sendiri.

## Opsi yang dipertimbangkan

| Pertanyaan | Opsi | Putusan |
| --- | --- | --- |
| **Di mana bagian-bagian keluar dari stok?** | A: bundle punya penghitung sendiri, dijaga manual atau oleh job | **Ditolak.** Sumber kebenaran kedua yang menyimpang, dan persis hal yang hendak dihindari adaptor inventori. |
|  | B: jual bundle sebagai N baris pesanan, satu per komponen | **Ditolak.** Pelanggan dan kasir akan melihat N baris, harga bundle harus disebar ke harga baris, retur menjadi N retur, dan "satu paket" tidak lagi menjadi objek di mana pun. |
|  | **C: satu baris, snapshot komponen, stok digerakkan per komponen lewat adaptor** | **Dipilih.** Satu hal dijual, satu tempat stok bergerak. |
| **Bundle bersarang?** | A: izinkan, dengan pemeriksaan siklus | **Ditolak.** Penelusuran graf di bawah konkurensi, batas kedalaman, dan snapshot yang harus rekursif, untuk kebutuhan ("paket dari paket") yang dipenuhi bundle datar dari bagian-bagian yang sama. |
|  | **B: tanpa nesting, ditegakkan trigger** | **Dipilih.** Siklus mustahil, bukan dideteksi. |
| **Harga** | A: bahasa formula | **Ditolak** (evaluator ekspresi adalah permukaan serangan dan dukungan). |
|  | **B: dua strategi bernama di balik `CHECK`, lainnya lewat ekstensi berversi** | **Dipilih.** |
| **Oversell mode counter** | A: biarkan `CHECK (stock >= 0)` gagal | **Ditolak.** 500 dan pesanan tertulis setengah. |
|  | **B: kunci baris komponen, tawar ulang, baru tulis** | **Dipilih.** Jawaban `cart_changed` yang sudah ada, sebelum penulisan apa pun. |

## Konsekuensi

- Sebuah paket dijual dengan satu harga, satu baris, dan satu retur, dan bagian-bagiannya keluar dan masuk stok lewat adaptor yang sama dengan yang lain, pada kedua mode otoritas.
- Ketersediaan bundle diturunkan pada setiap pembacaan; biayanya satu kueri tambahan per halaman produk yang memuat bundle dan satu lagi saat penawaran.
- Produk komponen yang mendapat varian setelah ditambahkan membuat setiap bundle yang memakainya tidak tersedia sampai bundle menyebut varian (trigger hanya memeriksa saat insert). Produk yang menjadi komponen tidak bisa menjadi bundle, dan bundle tidak bisa bersarang — operator yang menginginkan paket dari paket mendaftar bagian-bagiannya secara datar.
- Pada mode `counter`, keranjang yang memuat bundle dan baris standar salah satu komponennya ditawar baris demi baris, sehingga kebutuhan gabungan hanya diperiksa oleh `CHECK (stock >= 0)` (mode `ledger`: oleh ledger). Pemeriksaan gabungan tingkat-keranjang belum dibangun.
- Berat bundle untuk pengiriman adalah `weight_grams` produk bundle sendiri, yang diisi merchant (tidak dijumlah dari komponen).
- Mengubah produk berstok menjadi bundle pada mode `ledger` membiarkan saldo ledger-nya di tempat (ledger tidak mengonversi); operator memindahkannya dengan penyesuaian.

## Keamanan & privasi

- Kedua tabel baru berRLS `FORCE` dengan kebijakan tenant dan foreign key tenant komposit; tidak ada yang terjangkau lintas tenant bahkan lewat id. Referensi komponen yang tidak dikenal, dihapus, atau lintas tenant ditolak dengan pesan yang **sama**.
- Tidak ada permukaan tanpa-autentikasi baru. Katalog publik mendapat isi (id yang sudah dibuka DTO produk, SKU, nama, unit) dan tidak pernah harga pokok atau hitungan stok komponen; baris penawaran membawa hal yang sama.
- `awcms_worker` mendapat `SELECT, DELETE` pada kedua tabel baru dan tidak lebih (restock kedaluwarsa membaca snapshot; mesin retensi memurge snapshot menurut `created_at` dan baris komponen yang diganti menurut `deleted_at` — baris hidup tidak pernah menjadi kandidat purge). Role aplikasi tidak bisa mengubah atau menghapus baris snapshot.
- Snapshot dan definisi tidak memuat data pribadi; peristiwa audit perubahan definisi membawa kind, harga, dan jumlah.

## Rollback

- Berhenti membuat bundle: bundle adalah produk, sehingga menetapkannya `archived` mengeluarkannya dari penjualan. Pesanan yang sudah ditempatkan mempertahankan snapshot-nya dan di-restock dengan benar.
- `sql/953`–`955` bersifat tambahan: tiga kolom produk nullable/ber-default, dua tabel, dan empat trigger (edit men-soft-delete baris komponen yang digantinya). Kode lama mengabaikan kolom itu; database yang di-rollback ke kode lama tidak pernah membaca tabel baru. Menghapusnya (tidak disarankan selama ada pesanan yang memegang snapshot) adalah keputusan kelas-restore.

## Ditunda

Kelas pajak per komponen; retur komponen parsial (retur dalam bundle utuh); laporan bundle; bundle bersarang (ditolak, bukan ditunda); pemeriksaan komponen gabungan tingkat-keranjang pada mode `counter`; berat dijumlah dari komponen; varian untuk bundle; override harga per komponen pada bundle derived; skrip pemilih untuk editor isi (textarea `SKU x jumlah` adalah kontraknya).
