🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0039-commerce-tax-is-computed-by-the-tax-module-behind-a-per-tenant-mode.md)

<!-- i18n-source-hash: sha256:98735bb225c1e69193fc65599070cdce9f109196efdf9ded616850abbb45e72e -->

<!-- i18n-source-hash: sha256:placeholder -->

# ADR-0039 — Pajak commerce dihitung oleh modul `tax`, di belakang mode per tenant

- **Status:** Diterima
- **Tanggal:** 5 Oktober 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** isu [#293](https://github.com/ahliweb/awcms-one/issues/293) (induk [#281](https://github.com/ahliweb/awcms-one/issues/281); hanya-template: kemampuan generik yang dapat dipakai ulang tanpa keterikatan pada konsumen tertentu, [ADR-0024](0024-awcms-one-is-template-only-derived-apps-own-their-backend.md)); upstream ahliweb/awcms#889 dan `awcms` ADR-0127-nya (modul `tax`, masuk lewat sinkronisasi subtree v10.5.0, isu [#319](https://github.com/ahliweb/awcms-one/issues/319)) serta `apps/cms/docs/awcms/tax-calculation.md` §11 (kontrak adaptor migrasi yang diimplementasikan ADR ini); [ADR-0003](0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md) (uang); [ADR-0025](0025-payments-are-an-allocation-ledger-separate-from-order-status.md) (buku besar pembayaran); [ADR-0029](0029-commerce-documents-are-separate-records-and-numbered-documents-are-immutable-order-snapshots.md) (dokumen menyalin uang pesanan); [ADR-0033](0033-returns-refunds-and-exchanges-are-additive-records-that-compensate-through-the-existing-ledgers.md) (pengembalian); [ADR-0035](0035-pos-operational-reports-are-commerce-projections-over-the-existing-ledgers-on-the-reporting-engine.md) (laporan). Penomoran migrasi mengikuti the migration-numbering ADR (0037) D2 (migrasi hanya boleh bergantung pada objek bernomor lebih rendah dan tidak pernah pada tabel pengembalian/laporan `994`–`999`).

## Konteks

Hari ini pajak toko hanyalah satu angka: `payment.tax.percent` (bilangan bulat) dan sakelar `active` di pengaturan toko. `quoteCart` menghitung `pajak = (subtotal - diskon voucher) x persen`, sekali, half-up, dalam sen, lalu menambahkannya ke total. Angka itu disalin ke pesanan, penjualan POS, versi penawaran, dan setiap dokumen; pengembalian dana (ADR-0033) sengaja tidak mengembalikannya.

Itu cukup untuk toko yang tarifnya tidak pernah berubah. Ia tidak dapat menyatakan tarif yang berubah pada suatu tanggal (penjualan yang di-backdate atau disinkronkan terlambat harus dikenai tarif pada harinya sendiri), kategori yang dibebaskan atau bertarif nol, harga yang sudah memuat pajak, pungutan berlapis, atau refund yang mengambil kembali persis pajak yang dikenakan. AWCMS upstream kini menyediakan modul generik, netral yurisdiksi, yang melakukan semuanya (`awcms` ADR-0127): versi aturan berlaku-tanggal, kalkulator murni yang eksak, snapshot append-only per dokumen yang difinalkan, dan pembalikan yang dihitung hanya dari snapshot asli. §11-nya menetapkan bagaimana konsumen yang memegang persentase tetap berpindah ke sana, dan menyatakan bahwa, dengan pengaturan yang sama, selisih terhadap angka lama persis nol.

Pertanyaannya: _di mana_ sakelarnya, _bagaimana_ voucher tingkat dokumen menjadi masukan pajak per baris tanpa mengubah satu sen pun, _apa_ satuan pajak yang dibalik oleh sebuah pengembalian, _bagaimana_ tenant berpindah dengan aman dan kembali, dan _di mana_ laporan pajak berada.

## Keputusan

### D1 — Mode per tenant, `flat` (bawaan) atau `engine`

|              | A. Ganti persentase untuk semua orang                                          | B. Pertahankan persentase tetap dan tidak pernah memakai modul                  | **C. Mode per tenant di atas mesin upstream (dipilih)**                                           |
| ------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Keunggulan   | satu jalur kode                                                                | tanpa pekerjaan                                                                 | tenant yang ada tidak berubah sampai operator memindahkannya; mesin dicoba dulu secara bayangan   |
| Kelemahan    | penentuan harga ulang diam-diam untuk semua tenant saat deploy; tanpa rollback | tidak bisa menyatakan tanggal berlaku, pembebasan, harga inklusif               | dua jalur ada sampai tenant terakhir dipindahkan                                                  |
| Kebenaran    | paritas per tenant tidak terbukti                                              | perubahan tarif mengubah arti riwayat; refund tidak bisa mencerminkan penjualan | paritas _diperiksa per tenant_ sebelum pengalihan dan jalur flat tetap persis sama byte demi byte |
| Keterbalikan | tidak ada                                                                      | n/a                                                                             | mode dapat dikembalikan; pesanan mode engine menyimpan snapshot-nya                               |

`awcms_commerce_store_settings` mendapat `tax_mode` (`flat` \| `engine`, bawaan `flat`) dan `tax_profile_code` (bawaan `store-default`), `awcms_commerce_products` mendapat `tax_category_code` (nullable; `NULL` = standar, yaitu aturan cadangan versi), dan `awcms_commerce_orders` mendapat `tax_snapshot_id` (nullable; FK komposit `(tenant_id, tax_snapshot_id)` ke `awcms_tax_snapshots`, `ON DELETE SET NULL (tax_snapshot_id)` karena retensi snapshot tidak boleh terhalang oleh, atau merambat ke, sebuah pesanan; indeks unik parsial membuat satu snapshot milik paling banyak satu pesanan). Semuanya ada di `sql/948_awcms_commerce_tax_adapter.sql`, satu-satunya migrasi yang dipakai perubahan ini; ia hanya bergantung pada upstream `171`–`173` dan commerce `<= 947`.

- **Mode berada di kolom nyata, bukan di blob jsonb `settings`**, dengan alasan yang sama seperti `affiliate_commission_rate` (`sql/921`): `PUT /store-settings` ganti-penuh milik admin tidak boleh bisa membalik atau menimpanya, dan `PUT` yang membawa `taxMode` ditolak sebagai bidang tak dikenal. `GET` mengembalikannya hanya-baca. Hanya perkakas cut-over yang diaudit yang menuliskannya (D4).
- **Reset pengaturan tidak pernah menghapus mode.** Reset menandai baris untuk dipurge; baris mode engine direset di tempat, dan mengaktifkan mode menghidupkan kembali baris yang sudah ditandai, sehingga retensi tidak dapat diam-diam mengembalikan tenant ke tarif yang tidak lagi dipeliharanya.
- **Kategori pajak per produk, bukan per varian.** Varian adalah ukuran atau warna dari pasokan yang sama; kelas pajak yang berbeda adalah produk yang berbeda. Ini menjaga masukan per baris pada kuotasi sebagai fungsi `product_id` saja.
- **Tidak ada sakelar `taxMode` di API pengaturan.** "Mengubah tax*mode memakai izin pengaturan commerce" dipenuhi untuk \_membaca* (`commerce.settings.read`); pengalihan hanya untuk operator (D4, D7) karena pengalihan tanpa pemeriksaan paritas persis kecelakaan yang diperingatkan §11 F.

### D2 — Runtime mode engine: kuotasi di memori, snapshot saat penempatan, pembalikan dari yang asli

- **Kuotasi** (keranjang, pratinjau POS, versi penawaran): `buildCartQuote` menentukan mode tenant; pada mode engine ia menentukan versi terbit untuk **tanggal bisnis** toko (`Asia/Jakarta`, konstanta yang sudah dipakai laporan penjualan — tanggal kalender, bukan jam server) dan kategori produk, lalu menyerahkan keduanya ke `quoteCart` yang murni, yang memanggil kalkulator modul pajak menggantikan perkalian persentase. Tidak ada yang disimpan. Pada mode flat tidak ada kueri tambahan selain pembacaan mode satu baris.
- **Penempatan pesanan** (storefront `createOrderFromCart` dan `createPosOrder`): setelah pesanan dan itemnya ada, dalam transaksi tenant yang sama, `finaliseOrderTax` menentukan versi untuk tanggal bisnis, memanggil kalkulator dan `finaliseSnapshot` (`documentType = "order"`, `documentId = <id pesanan>`, referensi baris = id item pesanan), menyimpan `tax_snapshot_id`, mengaudit `tax.snapshot.finalise`, dan menambahkan event outbox milik modul. Ini in-process: tanpa panggilan jaringan, tanpa `Idempotency-Key` (kunci alami snapshot `(tenant, kind, documentType, documentId)` sudah menjadikannya idempoten, dan idempotensi tingkat permintaan pesanan mengembalikan pesanan tersimpan sebelum semua ini berjalan). Pajak pesanan adalah **milik snapshot**: angka dihitung sekali oleh kuotasi dari versi, tanggal, dan masukan yang sama, dan finalisasi **gagal tertutup** dengan `OrderTaxMismatchError` bila total snapshot berbeda dari harga pesanan. Commerce tidak pernah menghitung ulang pajak secara lokal.
- **Pengembalian** (ADR-0033): `createReturn` membalik, dari snapshot **asli** pesanan (bukan aturan hari ini), pajak untuk persis unit yang dikembalikan. Pemetaan ke API pembalikan modul (`tax-calculation.md` §6): tiap baris pesanan yang dikembalikan menjadi satu baris pembalikan `{ lineRef: <id item pesanan>, quantity: <unit dikembalikan> }`; modul mengambil `round(asli x q / Q)` dari neto baris dan tiap komponen dengan mode dan skala pembulatan milik snapshot itu sendiri (sisa eksak ketika unit terakhir kembali), dibatasi pada apa yang tersisa dari pembalikan sebelumnya, sehingga jumlah semua pembalikan tidak pernah melebihi — dan, bila semuanya dikembalikan, sama dengan — yang asli. `documentId` pembalikan adalah `return:<id pengembalian>`, sehingga pemutaran ulang idempoten; **tidak ada kolom pada pengembalian atau refund yang diperlukan untuk pembalikan itu sendiri**, yang juga dituntut the migration-numbering ADR (0037) D2.
- **Pembatalan dan kedaluwarsa** membalik sisa pajak yang masih berdiri pada snapshot (setiap baris yang belum dibalik oleh pengembalian). Tanpa ini, checkout yang ditinggalkan akan tetap tercatat sebagai penjualan di buku besar pajak selamanya. Job kedaluwarsa berjalan sebagai `awcms_worker`, yang oleh `sql/172` hanya diberi `SELECT`/`DELETE` pada buku besar; `sql/948` menambah `INSERT` (baris pembalikan) dan `UPDATE` (semata agar `SELECT ... FOR UPDATE` dapat mengunci yang asli — pemicu immutabilitas tetap menolak setiap `UPDATE` sungguhan untuk semua peran), ditegaskan di `security-readiness.ts`.
- **Klien tidak pernah mengirim pajak.** Validator permintaan pesanan, POS, dan kuotasi mengabaikan kunci `tax`/`taxAmount`/`total`; pesanan dihitung ulang oleh server. API modul sendiri tetap menolak nominal pajak dengan nama (`TAX_AMOUNT_NOT_ACCEPTED`).
- **Pajak yang tidak dapat dijawab mesin memblokir checkout.** Tidak ada versi terbit untuk tanggal itu, kategori tanpa aturan dan tanpa cadangan, atau skala pembulatan selain 2 (uang commerce `numeric(14,2)`) membuat kuotasi membawa `tax.error` dan `canCheckout: false`. Sebuah baris tidak pernah diam-diam tak berpajak.
- **Harga inklusif didukung**: bila versi memasukkan pajak ke dalam jumlah baris, kuotasi melaporkan pajak yang diekstrak dan tidak menambahkannya ke `total` (`tax.inclusive: true`).
- **Jendela tanggal pajak tidak dijaga ulang secara in-process.** `guardTaxDate` API (tanggal server -7/+1 hari kecuali `tax.snapshots.backdate`) melindungi tanggal yang dinyatakan pemanggil; di sini tanggal diturunkan dari saat pembuatan pesanan itu sendiri, sehingga tidak ada yang dijaga. Sinkronisasi POS offline yang menginginkan tanggal lampau tetap lewat API (§11 G).

### D3 — Voucher tingkat dokumen menjadi diskon per baris, dialokasikan dalam sen; paritas dibuktikan

Jalur flat mengenakan pajak atas `subtotal - diskon voucher`. Diskon modul bersifat per baris. Voucher dialokasikan ke baris-baris kuotasi dengan metode sisa terbesar dalam sen (`allocateOrderDiscount`, fungsi yang sudah dipakai pengembalian, seri ke indeks lebih rendah, dibatasi pada tiap baris), sehingga jumlah baris persis `subtotal - diskon voucher`. Dengan aturan cadangan `taxable` pada persentase yang sama, harga `exclusive`, `half_up`, skala 2, dan tingkat `document`, total mesin sama dengan angka flat **persis**. Ini tes, bukan argumen: uji properti berbenih tetap menghitung 2.000 keranjang acak pada adaptor dan 500 lewat `quoteCart` asli (katalog acak, diskon tingkat, voucher persen dan nominal) dan menegaskan kesamaan pajak dan total di kedua mode. Satu keanehan mode flat yang sudah ada sengaja **tidak** ditiru: voucher nominal lebih besar dari subtotal membuat pajak flat negatif; mesin membatasi diskon pada subtotal (pajak 0). Itu di luar domain paritas dan mode flat tidak diubah.

### D4 — Perkakas penyiapan: `bun run commerce:tax:cutover`

CLI khusus operator (akar komposisi; memanggil fungsi aplikasi modul pajak secara langsung), **dry-run secara bawaan**:

1. Turunkan profil `store-default` dari pengaturan saat ini (§11 A): satu aturan cadangan, `taxable` dengan satu komponen `net` pada persentase toko (`exempt` bila persentase mati atau nol); harga `exclusive` — total hari ini menambahkan pajak di atas harga, jadi harga tidak memuatnya; `half_up`, skala 2, tingkat `document`; `effectiveFrom` = tanggal server (versi tidak dapat diterbitkan ke masa lalu). Versi yang sudah berlaku untuk profil itu **dipakai ulang**, tidak pernah ditimpa.
2. Paritas bayangan (§11 F): hitung ulang pesanan mode flat terbaru tenant (`--sample`, bawaan 200; `--since` untuk melewati pesanan sebelum perubahan tarif) lewat mesin dan bandingkan dengan pajak yang tersimpan. **Selisih apa pun menolak pengalihan** dan tidak menulis apa pun; itu ketidakcocokan konfigurasi, bukan toleransi pembulatan.
3. Dengan `--commit` dan paritas persis, dalam satu transaksi tenant: buat dan terbitkan versi (bila perlu; diaudit, dengan event `rule_version.published` modul) dan set `tax_mode = engine` (diaudit `commerce / tax_mode.update`, kritis). `--tenant <kode>` untuk peluncuran bertahap.
4. Rollback = `--rollback --commit`: kembalikan mode ke `flat` (perubahan pengaturan teraudit yang sama). Pesanan mode engine yang sudah ditempatkan menyimpan snapshot-nya dan tetap dapat dibalik darinya; pesanan baru dihitung dengan persentase lagi. Pesanan historis tidak pernah dihitung ulang atau diimpor (§11 E).

### D5 — Pelaporan: buku besar snapshot adalah laporan pajak; tanpa keluarga laporan pajak commerce

Proyeksi `tax.snapshot_activity` upstream dan `GET /api/v1/tax/reports/reconciliation` pada mesin reporting yang sama adalah laporan pajaknya: per versi aturan, per komponen, per perlakuan, dinetralkan per mata uang, dengan blok integritas. Ini **menggantikan catatan ADR-0035 D1 bahwa irisan pajak akan milik commerce sendiri** untuk #293 — laporan pajak kedua yang diturunkan dari pesanan akan menjadi sumber kebenaran kedua yang dapat berselisih dengan buku besar yang diperhatikan hukum. Proyeksi penjualan commerce sendiri (ADR-0035) membaca kolom `tax` pesanan, yang pada mode engine adalah angka snapshot, sehingga tidak berubah; pembalikan pembatalan/pengembalian yang baru mengeluarkan pajak dari buku besar, bukan dari proyeksi itu (lihat Konsekuensi).

### D6 — Netralitas regulasi; catatan keberlakuan Indonesia

Inti tetap netral yurisdiksi (`awcms` ADR-0127; ADR-0024: tidak ada yang spesifik negara dalam template). **Keberlakuan Indonesia:** tarif PPN, perubahan regulasi (sebuah PMK) atau perlakuan suatu kategori dinyatakan sebagai **versi aturan berlaku-tanggal baru yang disusun oleh pedagang atau penasihat pajaknya** dan diterbitkan lewat `/admin/tax` (izin yang diberikan terpisah), tidak pernah sebagai kode. Tidak ada dalam perubahan ini yang menegaskan tarif: cut-over menyalin persentase apa pun yang sudah dikonfigurasi pedagang. Ekspor Coretax / e-Faktur dan penomoran faktur pajak berada di luar cakupan dan merupakan tindak lanjut upstream dari `awcms` ADR-0127.

### D7 — Deskriptor modul, izin

`commerce` mendeklarasikan `tax` di `dependencies` (`modules:dag:check`; `tax` tidak pernah bergantung pada commerce). Tidak ada izin baru: membaca mode dan mengubah kategori produk memakai `commerce.settings.read` dan `commerce.products.update`; CLI cut-over adalah tindakan operator tanpa permukaan HTTP; layar dan API pajak tetap memakai izin `tax.*` sendiri. Tenant yang dibuat sebelum `sql/173` dijalankan memerlukan `bun run identity-access:permissions:backfill` sekali agar peran `owner`-nya memegang izin `tax.*` (runbook memuat langkahnya); jalur commerce sendiri memanggil modul pajak in-process dan tidak dikendalikan izin itu. Karena `module_management` menjaga dependensi modul yang aktif tetap terpenuhi, tenant yang sebelumnya menonaktifkan `tax` secara eksplisit tidak dapat mengaktifkan ulang `commerce` sebelum mengaktifkan `tax`, dan `tax` tidak dapat dinonaktifkan selama `commerce` aktif. Tenant tanpa baris `awcms_tenant_modules` untuk `tax` (bawaan) tidak terdampak, dan perilaku tetap diatur oleh mode per tenant, sehingga tenant yang tidak pernah cut-over tidak pernah memanggil `tax`.

### D8 — UI admin

Form produk mendapat bidang `Kategori pajak` (buat dan ubah; kosong = standar). Pengaturan toko menampilkan mode sebagai lencana hanya-baca dengan tautan ke `/admin/tax`. Penambahannya dua input dan satu kunci payload di skrip yang sudah ada — tanpa aset klien baru.

## Opsi yang dipertimbangkan

- **Mempertahankan persentase tetap — ditolak.** Ia tidak dapat menyatakan perubahan tarif bertanggal, pembebasan, harga inklusif, atau refund yang mencerminkan penjualan, dan setiap kebutuhan mendatang akan membebani angka tunggal yang sama.
- **Menanam PPN Indonesia di kode commerce — ditolak.** Inti netral yurisdiksi (`awcms` ADR-0127) dan template tidak membawa apa pun yang spesifik negara (ADR-0024); tarif di dalam kode berarti rilis untuk setiap perubahan tarif dan menegaskan posisi hukum yang dimiliki pedagang.
- **Tabel snapshot sisi commerce — ditolak.** Modul sudah memiliki buku besar immutabel, aritmetika pembalikan, dan laporan rekonsiliasi; menyalinnya akan memecah satu sumber kebenaran.
- **Mode per tenant di atas mesin upstream — dipilih** (D1).
- **Mode sebagai bidang blob pengaturan yang dapat dibalik lewat `PUT` — ditolak** (D1): pengalihan tanpa pemeriksaan paritas adalah kegagalan yang dicegah §11 F.

## Konsekuensi

- Tenant flat tidak melihat perubahan: aritmetika sama, satu pembacaan satu-baris tambahan per kuotasi, tanpa snapshot.
- Tenant mode engine memiliki satu snapshot per pesanan dan satu pembalikan per pengembalian, pembatalan, atau kedaluwarsa; buku besar pajak dan kolom `tax` commerce adalah dua tampilan dari angka yang sama.
- **Celah yang sudah ada, tidak diubah ADR ini:** `refund_total` ADR-0033 adalah barang dikurangi diskon ditambah ongkir dan sebuah `CHECK` mengunci hal itu, sehingga pengembalian **tidak** mengembalikan pajak ke pelanggan; mode engine membaliknya di _buku besar pajak_ (kewajiban), dan operator yang ingin pelanggan dibayar kembali tetap melakukannya seperti hari ini. Mengubah aritmetika refund akan menyentuh skema pengembalian (`994`), yang tidak boleh dirujuk migrasi ini (the migration-numbering ADR (0037) D2); itu tindak lanjut. **Ditutup oleh isu #323:** migrasi `1000` menambah `tax_refund` pada retur dan memasukkannya ke `refund_total` (total pajak snapshot pembalikan pada mode engine, pajak pesanan yang diprorata pada mode flat, tidak ada pada harga inklusif); lihat adendum pajak di [ADR-0033](0033-returns-refunds-and-exchanges-are-additive-records-that-compensate-through-the-existing-ledgers.md).
- Dokumen pesanan mode engine (struk, faktur, penawaran) menyalin `tax` pesanan seperti sebelumnya. Pada harga inklusif baris "Pajak" terbaca sebagai pajak yang terkandung dalam total.
- Versi aturan tidak dapat diterbitkan sebelum tanggal UTC server; `effectiveFrom` karenanya adalah hari cut-over, dan tanggal bisnis waktu toko (`Asia/Jakarta`, tidak pernah di belakang UTC) selalu jatuh pada atau setelahnya.
- Layar pengaturan tidak lagi dapat mengubah pajak yang dibayar tenant begitu berada di mode engine (`payment.tax` diabaikan); itulah tujuannya, dan lencana menyatakannya.
- Dua suite unit dan satu suite integrasi membawa pembuktian (paritas, kategori, harga inklusif, cut-over, satu snapshot per pesanan, imutabilitas riwayat, pembalikan, RLS).

## Keamanan & privasi

- **Uang otoritatif di server.** Tidak ada bidang klien yang mencapai angka pajak; kuotasi, pesanan, dan snapshot berasal dari satu kalkulator dan ketidakcocokan membatalkan pesanan.
- **Tidak ada data pribadi yang masuk modul pajak.** Snapshot dikunci oleh id pesanan dan membawa referensi baris (id item pesanan), kode, dan string desimal; atribut audit dan event hanya memuat id dan total.
- **Isolasi tenant.** Kolom baru berada pada tabel yang sudah `FORCE ROW LEVEL SECURITY`; FK pesanan ke snapshot bersifat komposit pada `(tenant_id, id)`, sehingga pesanan tidak dapat merujuk snapshot tenant lain (teruji).
- **Hak istimewa.** Mode dan versi hanya ditulis oleh perkakas operator yang diaudit (tanpa rute HTTP); hibah baru worker pada buku besar adalah `INSERT` ditambah `UPDATE` khusus-kunci, dengan pemicu append-only utuh.
- **Retensi.** Snapshot mempertahankan batas bawah 1826 harinya; `ON DELETE SET NULL (tax_snapshot_id)` membiarkan retensi berjalan tanpa menyentuh pesanan.

## Rollback

`bun run commerce:tax:cutover --rollback --commit` (per tenant, teraudit) mengembalikan mode ke `flat`. Tidak ada lagi yang perlu dibatalkan: pesanan mode engine menyimpan snapshot dan pembalikannya, versi terbit tetap ada (imutabel) dan cut-over berikutnya memakainya ulang. Membalik kode meninggalkan ketiga kolom nullable/berbawaan tetap ada dan tak terpakai.
