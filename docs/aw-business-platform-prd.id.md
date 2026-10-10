🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](aw-business-platform-prd.md)

<!-- i18n-source-hash: sha256:ac1c53575eaa0556706f6617e72ac45c03e7656df7eb90610965dfdcdce30f0b -->

# AW Business Platform — blueprint platform dan PRD (bagian milik awcms-one)

Artefak Definition of Ready (DoR) 1 (blueprint) dan 2 (PRD) dari epik [#280](https://github.com/ahliweb/awcms-one/issues/280), pada tingkat platform, untuk [#336](https://github.com/ahliweb/awcms-one/issues/336) (butir Wave A A6). Pelacak: [`aw-business-platform-dor.md`](aw-business-platform-dor.id.md). **Ini adalah spesifikasi, bukan implementasi:** tidak menambah modul, migrasi, jalur OpenAPI, atau definisi tabel ([ADR-0040](adr/0040-aw-business-platform-capability-ownership-and-boundaries.id.md) D7). Nama tabel, port, dan event di bawah adalah gambaran maksud, bukan kontrak, sampai isu masing-masing mendarat.

Dokumen ini tidak mengklaim kepatuhan hukum. Bila sebuah aturan menyangkut data pribadi, pembayaran, atau hukum ketenagakerjaan, ia menyatakan batasan desain; apakah itu memenuhi suatu regulasi adalah urusan pekerjaan keberlakuan regulasi (A8, [#338](https://github.com/ahliweb/awcms-one/issues/338)) dan penasihat hukum.

**Terkait:** [Kontrak metrik](aw-business-platform-metrics.id.md), [Model ancaman adaptor](aw-business-platform-threat-model.id.md); [pelacak DoR](aw-business-platform-dor.id.md) (tinjauan lintas-spesifikasi, A9).

## 1. Tujuan dan penempatan

AW Business Platform menambahkan kapabilitas booking, tenaga kerja, penggajian, notifikasi, dan analitik di sekitar toko commerce. [ADR-0040](adr/0040-aw-business-platform-capability-ownership-and-boundaries.id.md) D1 dan D4 memutuskan siapa memiliki apa. Dokumen ini hanya mencakup **bagian yang berada di repositori ini**:

| Kapabilitas di sini                                                                                                              | Mengapa di sini (ADR-0040 D4)                                  |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Definisi segmen CRM** atas pelanggan commerce                                                                                  | Masukannya adalah fakta commerce                               |
| **Kelayakan dan penukaran loyalti** (memperluas buku besar poin yang ada)                                                        | Buku besarnya milik commerce ([ADR-0026](adr/0026-loyalty-points-are-an-append-only-ledger.id.md)) |
| **Adaptor booking-commerce**: tautan penawaran ke produk, hold ke pesanan, deposit sebagai alokasi pembayaran, koordinasi refund | Mengaitkan dua konteks; commerce milik repositori ini          |
| **Konteks layanan POS**                                                                                                          | Perluasan POS yang ada ([ADR-0028](adr/0028-pos-register-sessions-and-cash-up.id.md)) |

Semua yang generik dispesifikasikan dan dibangun **di upstream** `ahliweb/awcms` dan tiba di sini lewat sinkronisasi subtree; dokumen ini memakai desain itu dan tidak mengulanginya:

- Mesin booking (sumber daya, jadwal, hold, reservasi, pencegahan double-booking): [ADR-0131](https://github.com/ahliweb/awcms/blob/main/docs/adr/0131-generic-booking-module-admission.md) dan paket desain [`awcms/booking.md`](https://github.com/ahliweb/awcms/blob/main/docs/awcms/booking.md).
- Tenaga kerja, komisi, dan penggajian (`hr_workforce`, `hr_commission`, `hr_payroll`): [ADR-0132](https://github.com/ahliweb/awcms/blob/main/docs/adr/0132-hr-payroll-module-family-admission.md) dan [`awcms/hr-payroll.md`](https://github.com/ahliweb/awcms/blob/main/docs/awcms/hr-payroll.md).
- Pengiriman generik (promosi WhatsApp, Telegram opsional): [ADR-0133](https://github.com/ahliweb/awcms/blob/main/docs/adr/0133-generic-delivery-capability-whatsapp-promotion.md).
- Port lintas domain dan mekanisme konsumen event: [ADR-0134](https://github.com/ahliweb/awcms/blob/main/docs/adr/0134-descriptor-declared-domain-event-consumers.md) dan [`awcms/cross-domain-contracts.md`](https://github.com/ahliweb/awcms/blob/main/docs/awcms/cross-domain-contracts.md).

Paket upstream Booking dan `hr_payroll` membawa bagian PRD-lite sendiri; PRD ini tidak menggandakannya. Definisi KPI (okupansi, retensi, pendapatan neto, produktivitas) adalah kontrak metrik A7 (dokumen metrik AW Business Platform, sedang ditulis paralel); PRD ini hanya menyatakan hasil mana yang dibutuhkannya dari kontrak itu. Model ancaman dan analisis privasi untuk adaptor (A8) juga dokumen tersendiri.

### 1.1 Blueprint dalam satu pandangan (artefak DoR 1)

```
 profile_identity ─────────── (upstream, dasar DAG)
        ▲
        │                    Booking (upstream)  ── tanpa dependensi ke commerce
        │                       │  port: quote / hold / confirm / cancel / reschedule
        │                       │  event: held, confirmed, expired, cancelled, ...
        │                       ▼
 commerce (repo ini) ◄── ADAPTOR booking-commerce (repo ini; satu-satunya tempat yang mengenal keduanya)
   pelanggan  pesanan  buku besar pembayaran  buku besar loyalti  retur  POS
        │
        └── segmen CRM (evaluasi baca-saja atas pelanggan + pesanan)
        └── kelayakan / penukaran loyalti (hanya menulis buku besar loyalti yang ada)
        └── konteks layanan POS (baris layanan dalam penjualan POS yang ada)
```

Invarian yang diwarisi blueprint dan tidak boleh dilanggar PRD ini:

1. **Commerce tetap otoritas pelanggan** (O12). Tidak ada tabel `crm_customer` di samping `awcms_commerce_customers` (ADR-0040 D5.1).
2. **Booking memegang status reservasi; pesanan commerce memegang status pembayaran** (ADR-0040 D3, D5.9). Tidak ada saldo atau status pembayaran di Booking.
3. **Satu buku besar per urusan.** Pembayaran di buku besar alokasi pembayaran ([ADR-0025](adr/0025-payments-are-an-allocation-ledger-separate-from-order-status.id.md)); poin di buku besar loyalti (ADR-0026); kompensasi pasca-penjualan lewat retur ([ADR-0033](adr/0033-returns-refunds-and-exchanges-are-additive-records-that-compensate-through-the-existing-ledgers.id.md)). Tidak ada penyimpanan analitik kedua; proyeksi berada di mesin `reporting` (ADR-0040 D5.2).
4. **Tanpa siklus.** Booking tidak pernah memanggil commerce; adaptor bergantung pada port dan event Booking, tidak pernah sebaliknya (ADR-0040 D3).
5. **Perilaku yang ada dipertahankan.** Checkout tamu, POS yang ada, dan pembayaran Midtrans/manual tetap berjalan; setiap perilaku baru berada di balik feature flag per tenant yang default-nya mati, seperti `loyalty` dan `returns`.

## 2. Persona

O1 memasukkan kesembilannya ke dalam cakupan. Tabel menunjukkan mana yang menyentuh bagian milik awcms-one; sisanya dilayani sepenuhnya oleh modul upstream.

| Persona                                | Peran pada bagian milik awcms-one                                                                                                            | Menyentuh |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| **Pelanggan**                          | Memesan dan membayar deposit di etalase; memperoleh dan menukar poin; dapat melihat penawaran berbasis segmen miliknya; meminta pembatalan atau refund | Ya        |
| **Kasir**                              | Menjual baris layanan di POS, menerima deposit atau pelunasan, menukar poin di kasir                                                         | Ya        |
| **Penjadwal / resepsionis**            | Membuat, mengonfirmasi, membatalkan, dan menjadwal ulang reservasi; perlu melihat status deposit pesanan terkait, tanpa wewenang pembayaran | Ya        |
| **Admin tenant**                       | Menyalakan feature flag, mendefinisikan segmen dan aturan loyalti, menetapkan kebijakan refund pembatalan, memberi izin                       | Ya        |
| **Keuangan / auditor**                 | Membaca buku besar pembayaran, alokasi deposit, refund, dan penyesuaian loyalti; merekonsiliasi                                              | Ya        |
| Karyawan, supervisor                   | Ketersediaan dan penugasan staf ada di upstream (Workforce, Booking). Di sini hanya sebagai pelaku penjualan atau booking (event sumber komisi adalah adaptor berikutnya, Wave D) | Tidak langsung |
| HR, operator penggajian                | Sepenuhnya upstream (`hr_payroll`). Tidak ada permukaan milik awcms-one dalam PRD ini                                                        | Tidak     |

Akses persona adalah himpunan izin, bukan nama peran: izin commerce mengikuti konvensi `commerce.<resource>.<action>` yang ada dan diberikan terpisah (ADR-0026 D8 adalah preseden: kasir dapat menukar tanpa dapat menyesuaikan). Matriks konkretnya adalah artefak DoR 5, tidak ditulis di sini.

## 3. Vertikal pertama: hotel, vila, dan rental (O2)

O2 memilih hotel / vila / rental, tanpa terikat repositori konsumen yang ada. Inilah kasus yang sengaja dikeluarkan paket upstream dari v1 ("menginap per malam (hari check-in/check-out) di luar v1", booking.md bagian 11, O2), sehingga ia hal pertama yang harus diserap bentuk akhir Booking. **Upstream-lah** yang memodelkan menginap berbasis hari dan kapasitas multi-malam; PRD ini hanya mencatat implikasinya bagi adaptor, karena adaptor adalah tempat uang bertemu semua itu:

- **Menginap multi-malam adalah satu reservasi, satu pesanan.** Pesanan terkait membawa satu baris layanan untuk menginap itu (malam sebagai kuantitas atau sebagai satuan harga; tautan produk yang menentukan, lihat pertanyaan terbuka Q1). Adaptor tidak boleh memecah menginap menjadi pesanan per malam.
- **Deposit adalah sebagian dari total yang lebih besar.** Menginap beberapa malam lazimnya dibayar sebagian di muka. Pesanan commerce sudah mendukung uang muka (ADR-0025 D3: `dp_amount`, status `dp_paid`, sisa terutang eksplisit), jadi deposit adalah alokasi pembayaran pada pesanan terkait, bukan konsep baru (ADR-0040 D5.9).
- **Refund parsial saat pembatalan adalah kasus normal.** Membatalkan dalam batas waktu dapat menghanguskan satu malam atau seluruh deposit; membatalkan menginap multi-malam lebih awal dapat melepas sebagian malam. Reservasi mencatat faktanya (`late_cancellation`, booking.md upstream bagian 3); **keputusan uangnya milik commerce**: adaptor menghitung jumlah refund dari kebijakan tenant dan menyelesaikannya lewat mesin retur/refund, satu leg per pembayaran asal, tepat sampai sen (ADR-0033 D4, D5).
- **Memperpendek menginap** adalah retur parsial baris layanan, bukan penyuntingan pesanan yang sudah final (ADR-0033 D2: riwayat tidak pernah disunting).
- **Rental** (kendaraan, peralatan) memakai bentuk yang sama dan menambah deposit jaminan yang dikembalikan, bukan diperoleh. Di sini diperlakukan sebagai alokasi deposit yang dibalik penuh pada pengembalian bersih; apakah ia butuh tender atau label tersendiri adalah pertanyaan terbuka Q3.
- **Angka okupansi hanya menghitung menginap yang terkonfirmasi** (hold adalah angka pipeline terpisah, O8). Tugas adaptor adalah memindahkan hold ke terkonfirmasi tepat ketika ambang deposit terpenuhi, sehingga angka itu digerakkan oleh fakta pembayaran.

Tidak ada kolom khusus vertikal yang masuk ke kontrak generik (ADR-0040 D5.7): "hotel" adalah skenario penerimaan PRD ini, bukan kolom atau flag.

## 4. Alur kerja

Setiap alur kerja adalah urutan bernomor. "Booking" adalah mesin upstream; "adaptor" adalah bagian milik awcms-one. Semua langkah adaptor idempoten dan terbatas pada tenant; setiap langkah lintas domain membawa correlation id.

### 4.1 Booking dengan deposit (etalase)

1. Pelanggan memilih layanan dan tanggal di etalase. Adaptor meminta Booking melakukan **quote** (tanpa menulis baris).
2. Pelanggan melanjutkan. Adaptor meminta Booking menahan slot (**hold**, idempoten pada kunci klien) dan, dalam satu tindakan bisnis yang sama, membuat **pesanan commerce tertunda** dengan satu baris layanan, menyimpan id pesanan sebagai referensi eksternal reservasi.
3. Adaptor menghitung **deposit terutang** dari kebijakan deposit tenant (jumlah tetap atau persentase dari total) dan mencatatnya pada pesanan sebagai ambang pelepasan (uang muka). Pelanggan melihat jumlah dan kedaluwarsa hold.
4. Pelanggan membayar deposit lewat tender yang ada (sesi gateway Midtrans, transfer manual, atau QRIS). Leg dicatat di buku besar pembayaran, tertunda sampai dikonfirmasi.
5. Ketika buku besar menunjukkan penyelesaian telah mencapai ambang deposit (transisi pesanan-dibayar yang ada, ADR-0025 D3), adaptor meminta Booking **mengonfirmasi** reservasi. Pesanan berpindah ke `dp_paid` dengan sisa terutang.
6. Bila hold **kedaluwarsa** atau pesanan dibatalkan/kedaluwarsa lebih dulu, Booking melepas slot dan adaptor membatalkan pesanan tertunda. Deposit yang tiba setelah kedaluwarsa tetap dicatat (buku besar mencatat uang yang dikonfirmasi eksternal, ADR-0025 D5) dan muncul sebagai pengecualian untuk operator; ia tidak pernah diam-diam mengonfirmasi slot yang sudah dilepas.
7. Pelunasan dibayar kemudian (daring, atau di POS saat check-in). Ketika penyelesaian mencapai total, pesanan menjadi `paid`.
8. Struk/faktur untuk menginap adalah snapshot bernomor dari **pesanan** lewat siklus dokumen yang ada ([ADR-0029](adr/0029-commerce-documents-are-separate-records-and-numbered-documents-are-immutable-order-snapshots.id.md)); Booking tidak menerbitkan dokumen (ADR-0040 D6).

### 4.2 Pembatalan dan koordinasi refund

1. Pelanggan, penjadwal, atau sistem (kedaluwarsa) meminta pembatalan. Booking membatalkan reservasi (melepas alokasi) dan memancarkan event-nya; ia tidak tahu apa pun tentang uang.
2. Adaptor menerima event dan membaca penyelesaian pesanan terkait (buku besar pembayaran, bukan Booking).
3. Adaptor menerapkan **kebijakan refund pembatalan** tenant pada fakta reservasi (waktu sebelum mulai, jumlah malam, flag pembatalan terlambat) untuk mendapat jumlah yang dapat di-refund, mungkin nol, mungkin sebagian.
4. Bila jumlahnya di atas nol, adaptor membuat **retur/refund** pada pesanan untuk baris layanan lewat ADR-0033: satu leg per pembayaran asal (terbaru dulu), dibatasi tiga kali, diselesaikan otomatis untuk leg tunai/manual/kredit toko atau lewat port gateway untuk leg gateway, atau diantrekan untuk atestasi offline operator.
5. Kompensasi ADR-0033 D9 berjalan dalam penyelesaian yang sama: poin yang diperoleh atas bagian yang di-refund dibalik di buku besar loyalti (tetap satu-satunya penulis) dan komisi afiliasi disesuaikan.
6. Bila jumlah yang dapat di-refund nol atau lebih kecil dari deposit, bagian yang ditahan tetap pada pesanan sebagai pendapatan biasa yang sudah diselesaikan; pesanan tidak disunting. Keputusan dan masukan kebijakannya dicatat pada catatan refund/retur dan diaudit.
7. Pembatalan yang tidak dapat di-refund otomatis (penyedia menolak, tanpa adaptor) mengikuti jalur offline ADR-0033 dengan izin berisiko tinggi tersendiri dan alasan wajib; tidak pernah ditelan diam-diam.

### 4.3 Jadwal ulang

1. Booking menjadwal ulang dengan membuat reservasi baru dan menandai yang lama sebagai dijadwal ulang (upstream). Adaptor memindahkan referensi eksternal pesanan ke reservasi baru dalam tindakan bisnis yang sama.
2. Selisih harga adalah jalur penyesuaian pesanan biasa (leg pembayaran atau refund baru), tidak pernah mengubah riwayat yang sudah dibayar. Pertanyaan terbuka Q4 membahas siapa yang menetapkan harganya.

### 4.4 POS dengan konteks layanan

1. Kasir membuka baris layanan dalam penjualan POS yang ada (sesi register dan cash-up dari ADR-0028 tidak berubah).
2. Baris dapat merujuk **reservasi** (kedatangan, check-in, penagihan pelunasan) atau membuat penjualan layanan walk-in tanpa reservasi.
3. Untuk reservasi, POS menampilkan sisa terutang pesanan terkait dan menerima pelunasan lewat jalur tender eksplisit yang ada (ADR-0025 D8). Ia menulis ke pesanan dan buku besar yang sama; tidak ada POS kedua.
4. Aksi check-in/check-out memanggil port Booking; POS tidak menyimpan status reservasi.

### 4.5 Definisi dan penggunaan segmen

1. Admin tenant mendefinisikan **segmen**: himpunan aturan tersimpan bernama atas pelanggan commerce (lihat bagian 6.1), dengan versi.
2. Sistem **mengevaluasi** segmen menjadi daftar anggota atau jumlah sesuai permintaan, baca-saja, dengan waktu acuan yang dinyatakan; ia tidak pernah menyalin data pelanggan ke penyimpanan kedua.
3. Konsumen membaca hasil evaluasi: audiens kampanye (filter audiens kampanye saat ini tetap berlaku dan tidak digantikan), kelayakan aturan loyalti, atau kohort analitik.
4. Mengubah segmen membuat versi baru; konsumen mencatat versi yang dipakai, sehingga kampanye atau perolehan poin di masa lalu dapat dijelaskan.

### 4.6 Perolehan dan penukaran loyalti

1. **Perolehan** tetap terjadi pada `order.paid` dan dibalik saat pembatalan atau refund (ADR-0026 D5, ADR-0033 D9). Deposit booking saja tidak memperoleh poin; poin mengikuti belanja layak pesanan saat pesanan dibayar lunas (pertanyaan terbuka Q5 bila tenant ingin perolehan saat deposit).
2. **Kelayakan** (baru): versi program loyalti dapat dibatasi pada suatu segmen (misalnya hanya anggota, atau pelanggan yang pesanan terakhirnya lebih lama dari N hari), dan pesanan yang berasal dari booking dapat memperoleh poin menurut aturan khusus layanan. Versi yang berlaku pada `paid_at` tetap yang menentukan.
3. **Penukaran** (baru): saat checkout atau di POS, pelanggan atau kasir memilih membelanjakan poin. Poin didebit dari buku besar (kunci idempoten menurut ADR-0026 D4) dan **nilai poin itu** mengurangi jumlah terutang sebagai baris diskon (nilai poin: lihat Q6). Penukaran yang ditolak atau dibalik mengembalikan poin lewat baris kompensasi.
4. Refund yang mengembalikan diskon hasil penukaran mengikuti kompensasi yang ada; poin tidak pernah disunting di tempat.

## 5. Bukan tujuan

Dari O9 dan ADR-0040:

- **Tanpa akuntansi atau buku besar umum.** Catatan commerce adalah fakta operasional, bukan bagan akun.
- **Tanpa dokumen fiskal** (e-Faktur, faktur pajak, penomoran Coretax). Di luar cakupan repositori ini (ADR-0039 D6; tindak lanjut upstream).
- **Tanpa aktivitas jasa sistem pembayaran.** Platform mengamati pembayaran gateway dan mencatat penyelesaian; ia tidak pernah menyimpan, meneruskan, atau mencairkan dana pelanggan, dan "deposit" adalah pembayaran untuk pesanan milik merchant sendiri, bukan nilai tersimpan yang dipegang untuk pihak ketiga. Perubahan model itu memicu penilaian hukum tersendiri.
- **Tanpa penagihan piutang (AR)** di Wave B sampai F (ADR-0040 D6). Struk atau faktur tetap snapshot pesanan yang tak dapat diubah, tanpa saldo atau jatuh tempo.

Juga, menurut batas:

- Tanpa `crm_customer`, tanpa master pelanggan kedua, tanpa harmonisasi `profile_identity` tanpa ADR tersendiri (O12).
- Tanpa mesin Booking generik di sini: sumber daya, jadwal, hold, dan pencegahan double-booking ada di upstream. Tanpa kolom pembayaran, harga, atau deposit di Booking.
- Tanpa POS kedua, tanpa buku besar pembayaran atau loyalti kedua, tanpa penyimpanan data analitik kedua, tanpa antrean e-mail/push/WhatsApp baru.
- Tanpa pengiriman pesan otomatis berbasis segmen dalam PRD ini: memakai segmen sebagai audiens kampanye memakai ulang outbox kampanye yang ada; orkestrasi lintas kanal adalah butir terpisah yang tertahan di upstream (O11).
- Tanpa logika vertikal (tipe kamar, rate plan, harga musiman, channel manager) di template. Itu urusan konsumen atau upstream di kemudian hari.
- Tanpa penilaian produktivitas karyawan, komisi, atau logika penggajian di sini (Wave D dan E, upstream, dengan adaptor event sumber awcms-one belakangan).
- Tanpa kesimpulan hukum tentang UU PDP, PP 71/2019, atau regulasi pembayaran (A8).

## 6. Persyaratan dan cerita pengguna

Prioritas berasal dari O3: **MUST = CRM + Booking** (segmen dan loyalti, serta adaptor booking-commerce). Tenaga kerja, penggajian, notifikasi, dan analitik menyusul sebagai Should/Could; kontrak metrik analitik yang dibutuhkan KPI CRM dan Booking masuk cakupan karena melayani butir MUST. Cerita ditulis untuk bagian milik awcms-one; sebuah cerita Ready hanya bila kriteria penerimaannya dapat diuji tanpa memilih butir yang belum terselesaikan di bagian 9.

Konvensi untuk semua kriteria: setiap penulisan dibatasi tenant di bawah row-level security dan diaudit; setiap pemanggilan yang mengubah status idempoten pada kunci klien (kunci dan isi sama diputar ulang; kunci sama dengan isi berbeda adalah konflik); uang tepat sampai sen; tidak ada data pribadi di event atau rincian audit selain id.

### 6.1 Segmen CRM (MUST)

**Segmen** adalah definisi tersimpan, berversi, milik tenant yang dievaluasi terhadap pelanggan commerce dan fakta pesanan mereka. Kosakata aturan untuk v1 (semuanya dapat diturunkan dari data commerce yang ada): level harga pelanggan, memiliki akun, jumlah pesanan dan belanja terbayar dalam suatu jendela, tanggal pesanan terakhir (sebelum/sesudah), tanggal pesanan pertama, rentang saldo loyalti, atribut mirip-tag yang sudah ada pada pelanggan, dan fakta turunan booking (menginap selesai, tanggal menginap terakhir) lewat event milik adaptor. Kombinasi dengan AND/OR/NOT sampai kedalaman terbatas. Tanpa bahasa kueri bebas dan tanpa SQL mentah dari klien.

**S1. Mendefinisikan segmen.** Sebagai admin tenant, saya mendefinisikan dan menamai segmen dari kosakata aturan agar dapat dipakai ulang.
- Dengan aturan yang valid, menyimpan membuat versi 1; menyunting membuat versi N+1 dan tidak pernah mengubah N.
- Field, operator tak dikenal, atau kedalaman di atas batas ditolak dengan galat yang menyebut field.
- Segmen tidak pernah menyimpan baris pelanggan; menghapus segmen mempertahankan versi yang dirujuk kampanye/perolehan masa lalu.

**S2. Pratinjau dan evaluasi.** Sebagai admin tenant, saya mempratinjau berapa pelanggan yang cocok dan melihat contoh terbatas untuk memeriksanya.
- Evaluasi mengembalikan jumlah dan daftar anggota berhalaman dengan stempel waktu acuan; masukan sama pada waktu acuan sama memberi hasil sama.
- Pelanggan yang diblokir atau dihapus dikecualikan; baris placeholder walk-in tidak pernah menjadi anggota.
- Evaluasi baca-saja dan terbatas waktu serta ukuran; segmen yang terlalu mahal dievaluasi ditolak dengan kode jelas, tidak dijalankan tanpa batas.

**S3. Memakai segmen.** Sebagai admin tenant, saya melekatkan segmen sebagai audiens versi program loyalti dan (memakai ulang alur kampanye yang ada) kampanye.
- Konsumen menyimpan id dan versi segmen yang dipakai.
- Filter audiens kampanye yang ada tetap berjalan tanpa perubahan bila tidak ada segmen yang dipilih.

**S4. Privasi segmen.** Sebagai pelanggan, data saya dipakai untuk segmentasi hanya dalam tujuan yang dikonfigurasi tenant.
- Evaluasi segmen tidak membuka field pelanggan lebih dari yang diizinkan izin pemanggil; staf tanpa izin baca pelanggan tidak dapat mendaftar anggota.
- Penggunaan pemasaran menghormati persetujuan/opt-out pelanggan yang sudah ada untuk kanal tersebut.

### 6.2 Kelayakan dan penukaran loyalti (MUST)

**L1. Kelayakan menurut segmen.** Sebagai admin tenant, saya membatasi versi program pada suatu segmen agar hanya mereka yang memperoleh poin.
- Versi yang berlaku pada `paid_at` dan versi segmen yang dievaluasi pada saat yang sama yang menentukan; anggota yang kemudian keluar dari segmen tetap memegang poin yang sudah diperoleh.
- Tanpa pengisian ulang retroaktif; menyalakan kelayakan tidak memberi poin ulang pada pesanan lama (seperti ADR-0026 D5).

**L2. Perolehan dari pesanan hasil booking.** Sebagai admin tenant, saya membiarkan pesanan hasil booking memperoleh poin menurut program normal.
- Perolehan mempertahankan kunci idempoten `earn:order:<orderId>`; menginap yang dibatalkan atau di-refund dibalik secara proporsional (ADR-0033 D9).
- Hold atau reservasi yang belum dibayar tidak memperoleh apa pun.

**L3. Penukaran di checkout dan POS.** Sebagai pelanggan atau kasir, saya membelanjakan poin pada suatu pesanan.
- Penukaran mendebit buku besar dengan `redeem:<accountId>:<clientKey>` dan mencatat diskon pada pesanan; keduanya dalam satu transaksi atau tidak sama sekali.
- Saldo di bawah jumlah yang diminta menolak seluruh penukaran (tanpa parsial), dan penukaran yang ditolak tidak dicatat sehingga kunci yang sama dapat dicoba lagi setelah top-up.
- Dua penukaran serentak pada satu akun diserialkan; yang kedua melihat saldo yang pertama.
- Pesanan yang dibatalkan atau di-refund mengembalikan poin tertukar lewat baris kompensasi dan tidak pernah menyunting riwayat.
- Pelanggan hanya melihat saldo dan riwayatnya sendiri lewat endpoint berbearer (ADR-0026 D10, ADR-0016 D3).

**L4. Nilai poin eksplisit.** Sebagai admin tenant, saya menetapkan berapa nilai satu poin (Q6); sebelum ditetapkan, penukaran tidak tersedia. Tidak ada nilai placeholder yang dikirim.

### 6.3 Adaptor booking-commerce (MUST)

**A1. Menautkan penawaran ke produk.** Sebagai admin tenant, saya menautkan penawaran Booking ke produk layanan commerce agar menjual produk membuat reservasi.
- Tautan adalah referensi, bukan penggabungan: sumber daya Booking bukan item inventori maupun produk commerce (ADR-0040 D5.8).
- Satu penawaran dapat ditautkan paling banyak ke satu produk aktif per tenant; melepas tautan tidak menyentuh pesanan lama.

**A2. Hold menjadi pesanan tertunda.** Sebagai pelanggan, ketika saya melanjutkan, slot saya ditahan dan pesanan dibuat untuknya.
- Pembuatan hold dan pesanan idempoten pada satu kunci klien: percobaan ulang mengembalikan reservasi dan pesanan yang sama dan tidak membuat keduanya dua kali.
- Bila pesanan tak dapat dibuat, hold dilepas; bila hold gagal, tidak ada pesanan yang tertinggal.
- Kedaluwarsa hold ditampilkan ke pelanggan; kedaluwarsa pesanan sendiri tidak pernah melampaui hold.

**A3. Deposit sebagai alokasi pembayaran.** Sebagai pelanggan, membayar deposit mengonfirmasi reservasi saya.
- Deposit dicatat sebagai alokasi pada pesanan terkait lewat buku besar pembayaran dan idempotensinya (referensi gateway atau source key); tidak disimpan di Booking.
- Reservasi dikonfirmasi ketika, dan hanya ketika, penyelesaian mencapai ambang deposit (ambang pelepasan pesanan).
- Konfirmasi deposit yang diputar ulang gateway mengonfirmasi satu kali.
- Deposit yang tiba setelah hold kedaluwarsa dicatat dan ditandai untuk operator; slot tidak diklaim ulang otomatis.
- Deposit berlebih muncul sebagai `overpaid` menurut ADR-0025 D5 dan tidak dibuang.

**A4. Pelunasan dan penyelesaian.** Sebagai kasir atau pelanggan, saya membayar pelunasan sebelum atau saat check-in.
- Pembayaran pelunasan memakai tender yang ada dan jalur POS tender eksplisit; penyelesaian yang mencapai total membuat pesanan `paid`.
- Adaptor membuka sisa terutang kepada penjadwal secara baca-saja.

**A5. Koordinasi refund pembatalan.** Sebagai admin tenant, saya mendefinisikan kebijakan refund pembatalan; sebagai penjadwal atau pelanggan, pembatalan menerapkannya.
- Kebijakan adalah konfigurasi tenant: daftar jendela waktu-sebelum-mulai ke bagian yang dapat di-refund (persentase, seluruh menginap, atau per malam), berversi; versi kebijakan yang dipakai dicatat pada refund.
- Refund melalui ADR-0033 (satu leg per pembayaran asal, dibatasi tiga kali, tepat sampai sen); menginap yang di-refund bertahap berjumlah tepat sama dengan total, bagaimanapun dipecah.
- Reservasi dibatalkan baik uang di-refund maupun tidak; leg refund yang gagal tidak pernah membuat slot tetap tertahan.
- Refund nol tidak membuat leg refund dan mencatat alasannya.
- Memutar ulang pembatalan tidak pernah me-refund dua kali (id leg refund adalah kunci idempotensi penyedia).

**A6. Jadwal ulang menjaga uang tetap koheren.** Sebagai penjadwal, saya memindahkan menginap.
- Referensi reservasi pesanan berpindah ke reservasi baru secara atomik; reservasi lama tidak pernah tertinggal tertaut.
- Tidak ada pesanan, baris, atau alokasi terbayar yang disunting; selisih adalah pembayaran atau refund baru.

**A7. Tidak datang (no-show).** Sebagai penjadwal, saya menandai no-show; adaptor menerapkan penahanan no-show dari kebijakan (lazimnya deposit ditahan) tanpa refund, dicatat dan diaudit.

**A8. Event Booking dikonsumsi lewat pendaftaran, bukan impor.** Adaptor mengonsumsi event Booking lewat mekanisme konsumen yang dideklarasikan descriptor di upstream (ADR-0134 di `awcms`), bukan dengan mengimpor dari modul upstream. Pemutaran ulang event tidak berbahaya (setiap efek diterapkan sekali).

**A9. Degradasi.** Bila Booking tidak aktif untuk suatu tenant, commerce berperilaku persis seperti sekarang; bila commerce tidak aktif, Booking bekerja tanpa adaptor. Adaptor hanya ada di tempat keduanya menyala.

### 6.4 Konteks layanan POS (MUST untuk skenario hotel; selebihnya SHOULD)

**P1. Baris layanan dengan atau tanpa reservasi.** Sebagai kasir, saya menjual layanan di konter, opsional terkait reservasi.
- Penjualan melalui pembuatan pesanan POS, sesi register, dan pembayaran yang ada; tidak ada POS paralel.
- Baris layanan tidak membawa pergerakan stok.

**P2. Pencarian reservasi di kasir.** Sebagai kasir, saya menemukan reservasi dari kodenya (dan pelanggan) dan melihat status, tanggal, dan sisa terutang pesanan, agar dapat menerima pelunasan.
- Pencarian hanya membuka apa yang diizinkan izin kasir; rincian kontak pelanggan disamarkan kecuali izin dimiliki.

**P3. Check-in dan check-out dari kasir** memanggil port Booking dan diberi izin terpisah dari menerima pembayaran.

### 6.5 Masukan analitik untuk butir MUST (dalam cakupan, didefinisikan di A7)

Dibutuhkan dari kontrak metrik, tidak didefinisikan di sini: pendapatan dilaporkan kotor, diskon, refund, neto (neto sebagai tajuk, jendela hari Asia/Jakarta, O8); okupansi (hold dikecualikan, dilaporkan terpisah sebagai angka pipeline); utilisasi (terpisah); retensi (pembelian atau booking ulang dalam 90 hari sejak yang pertama, O8). PRD ini mensyaratkan bahwa masing-masing adalah proyeksi di mesin `reporting` yang ada, dapat dibangun ulang dari fakta di atas, tanpa penyimpanan kedua, dan bahwa porsi pendapatan asal booking serta pemisahan deposit-versus-pelunasan terlihat sebagai dimensi.

## 7. Hasil yang terukur

Target adalah ambang penerimaan untuk rilis pertama tiap butir, untuk dikonfirmasi pemilik pada tinjauan DoR (berupa usulan, ditandai P). Definisi pengukuran milik A7.

| #   | Hasil                                                                                         | Ukuran                                                                                  | Target (P)               |
| --- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------ |
| M1  | Tidak ada slot terjual berlebih lewat jalur commerce                                          | Reservasi terkonfirmasi untuk unit yang sudah teralokasi (uji slot terakhir serentak)   | 0                        |
| M2  | Deposit dan pesanan selalu sepakat                                                            | Reservasi terkonfirmasi yang penyelesaian pesanannya di bawah ambang deposit            | 0 (rekonsiliasi harian)  |
| M3  | Uang berpindah tepat sekali                                                                   | Baris pembayaran, refund, atau penukaran ganda dari permintaan/event yang diputar ulang | 0                        |
| M4  | Refund tepat                                                                                  | Selisih jumlah leg refund terhadap jumlah kebijakan, pada pemecahan apa pun             | 0,00                     |
| M5  | Menginap dapat direkonsiliasi ujung ke ujung                                                  | Hold yatim (tanpa pesanan) atau pesanan layanan yatim (tanpa reservasi) setelah 24 jam  | 0 dilaporkan oleh rekonsiliasi |
| M6  | Integritas buku besar loyalti terjaga                                                         | Putusnya buku besar / drift proyeksi yang ditemukan rekonsiliasi yang ada               | 0                        |
| M7  | Evaluasi segmen layak dipakai interaktif                                                      | Waktu pratinjau p95 untuk segmen pada tenant 100.000 pelanggan                          | paling lama 3 d          |
| M8  | Jalur booking menambah sedikit beban checkout                                                 | Tambahan latensi p95 pembuatan hold-plus-pesanan dibanding jalur pesanan biasa          | paling lama 500 md       |
| M9  | Perilaku yang ada tak tersentuh saat fitur mati                                               | Rangkaian regresi checkout tamu, POS, pembayaran, perolehan loyalti                     | 100% hijau               |
| M10 | Sinyal nilai bisnis (dilaporkan, tidak menjadi gerbang)                                       | Booking/pembelian ulang dalam 90 hari sejak yang pertama; porsi pendapatan dari booking; poin tertukar sebagai porsi dari yang diperoleh | dilaporkan |

## 8. MoSCoW (O3)

| Butir                                                                                                             | Prioritas  | Catatan                                                        |
| ----------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------- |
| Definisi segmen, pemversian, pratinjau/evaluasi (S1, S2)                                                          | **Must**   | CRM                                                            |
| Segmen sebagai kelayakan loyalti dan audiens kampanye (S3, L1)                                                    | **Must**   | CRM                                                            |
| Penukaran loyalti ke checkout dan POS (L3, L4)                                                                    | **Must**   | Menutup butir Deferred ADR-0026; butuh Q6                      |
| Perolehan loyalti dari pesanan booking, dengan pembalikan (L2)                                                    | **Must**   | Memakai ulang konsumen yang ada                                |
| Adaptor: tautan, hold-ke-pesanan, alokasi deposit, konfirmasi, kedaluwarsa (A1 sampai A4, A8, A9)                 | **Must**   | Booking + commerce                                             |
| Adaptor: kebijakan dan koordinasi refund pembatalan, jadwal ulang, no-show (A5 sampai A7)                         | **Must**   | Refund parsial adalah kasus hotel yang normal                  |
| Konteks layanan POS (P1 sampai P3)                                                                                | **Should** | Must hanya untuk pelunasan-saat-check-in skenario hotel; pemakaian konter dapat menyusul |
| Masukan analitik untuk KPI CRM dan Booking (bagian 6.5)                                                           | **Must**   | Melayani butir MUST; kontrak di A7                             |
| Personalisasi etalase berbasis segmen untuk pelanggan                                                             | **Could**  |                                                                |
| Tier loyalti                                                                                                      | **Could**  | Tetap terpisah dari level harga pelanggan (ADR-0026)           |
| Struk per pembayaran / nota kredit untuk deposit                                                                  | **Could**  | Deferred ADR-0029; lebih mungkin dengan deposit (ADR-0040 D6)  |
| Aturan segmen turunan booking di luar menginap selesai dan menginap terakhir                                      | **Could**  |                                                                |
| Adaptor event sumber komisi dan penggajian                                                                        | **Should** (Wave D, E) | Menyusul tenaga kerja/penggajian upstream          |
| Notifikasi: pengingat, Telegram, orkestrasi                                                                       | **Should / Could** (Wave F) | O10 ya (opsional, default mati); O11 ya tetapi butuh kasus nilai dan ADR upstream |
| Penagihan AR, akuntansi, dokumen fiskal, aktivitas jasa sistem pembayaran                                         | **Won't**  | O9                                                             |

## 9. Pertanyaan terbuka

Tidak ada yang menghalangi spesifikasi; Q1, Q5, dan Q6 menghalangi cerita tertentu menjadi Ready.

| #   | Pertanyaan                                                                                                                                   | Dibutuhkan oleh            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Q1  | Bagaimana menginap multi-malam dihargai pada pesanan: malam sebagai kuantitas satu produk per malam, atau satu baris dengan total terhitung? Bergantung pada desain berbasis hari di upstream | A1, A2, skenario hotel |
| Q2  | Bentuk kebijakan deposit: jumlah tetap, persentase, atau per malam; satu per produk atau per tenant? Ambang default bila tidak diatur         | A3                         |
| Q3  | Deposit jaminan rental: tender dan alokasi yang sama dengan label, atau jenis tersendiri yang tidak pernah menjadi pendapatan?                | A3, A5                     |
| Q4  | Siapa yang menetapkan harga selisih jadwal ulang: jalur pesanan, atau aturan penawaran Booking lewat tautan produk?                           | A6                         |
| Q5  | Haruskah poin pernah diperoleh saat deposit, bukan saat pembayaran lunas?                                                                     | L2                         |
| Q6  | Berapa nilai satu poin (tarif per tenant, pembulatan, batas porsi pesanan yang boleh dibayar dengan poin)? ADR-0026 sengaja tidak mengirim nilai | L3, L4                    |
| Q7  | Kosakata aturan segmen: apakah daftar v1 di bagian 6.1 cukup, dan apakah aturan turunan booking diinginkan sejak peluncuran?                  | S1                         |
| Q8  | Apakah poin dan deposit yang dapat dikembalikan boleh digabung pada satu pesanan, dan urutan leg refund bila digabung                          | L3, A5                     |
| Q9  | Jendela kebijakan pembatalan: apakah butuh default seluruh tenant, atau hanya per produk?                                                     | A5                         |
| Q10 | Himpunan izin minimum per persona (artefak DoR 5), termasuk siapa yang boleh menimpa refund hasil hitung kebijakan                            | A5, P2                     |

## 10. Dependensi dan urutan

- Modul `booking` upstream dan mekanisme konsumen harus sudah ada di `apps/cms` repositori ini (sinkronisasi subtree) sebelum adaptor dibangun (ADR-0040 D7 butir 2 dan 3).
- Definisi segmen dan kelayakan/penukaran loyalti hanya bergantung pada commerce dan, menurut ADR-0040 D7, dapat dibuka lebih dulu setelah artefak DoR CRM (blueprint, PRD ini, model ancaman, definisi metrik) ada.
- Adaptor bergantung pada pembayaran (sudah ada), retur (sudah ada), dan loyalti (sudah ada); ia tidak menambah skema ke Booking dan hanya sedikit catatan sisi commerce, untuk dirancang di artefak DoR 4.

## 11. Asal-usul keputusan

Setiap keputusan pemilik yang diandalkan PRD ini, sebagaimana dijawab pada 10 Oktober 2026:

| ID  | Keputusan                                                                                                   | Dipakai di                       |
| --- | ----------------------------------------------------------------------------------------------------------- | -------------------------------- |
| O1  | Kesembilan persona dalam cakupan                                                                            | Bagian 2                         |
| O2  | Vertikal pertama: hotel / vila / rental; tanpa repositori konsumen yang ada                                 | Bagian 3, alur kerja, A5         |
| O3  | MUST = CRM + Booking; Tenaga kerja, Penggajian, Notifikasi, Analitik menyusul; kontrak Analitik yang melayani CRM dan Booking masuk cakupan | Bagian 8, 6.5 |
| O5  | Platform adalah prosesor untuk data bisnis tenant dan pengendali untuk data akun/penagihan operator sendiri | Privasi segmen (S4); rincian di A8 |
| O8  | Okupansi mengecualikan hold; jendela retensi 90 hari; pendapatan kotor ke neto dengan neto sebagai tajuk; jendela hari Asia/Jakarta | Bagian 3, 6.5, 7 |
| O9  | Bukan tujuan: tanpa akuntansi, tanpa dokumen fiskal, tanpa aktivitas jasa sistem pembayaran, tanpa penagihan AR di Wave B sampai F | Bagian 5            |
| O10 | Telegram diterima sebagai adaptor opsional, default mati                                                    | Bagian 8 (Wave F)                |
| O11 | Orkestrasi notifikasi diinginkan, dengan syarat kasus nilai dan ADR upstream                                | Bagian 8 (Wave F)                |
| O12 | Commerce tetap otoritas pelanggan                                                                           | Bagian 1.1, 5                    |

Tidak diandalkan di sini: O4, O6, dan O7 (profil penggajian, bukti kehadiran, dan pemisahan tugas penggajian) hanya menyangkut `hr_payroll` upstream.

Keputusan yang sudah ada dan dijadikan dasar: [ADR-0016](adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.id.md) (sesi pelanggan), [ADR-0025](adr/0025-payments-are-an-allocation-ledger-separate-from-order-status.id.md), [ADR-0026](adr/0026-loyalty-points-are-an-append-only-ledger.id.md), [ADR-0028](adr/0028-pos-register-sessions-and-cash-up.id.md), [ADR-0029](adr/0029-commerce-documents-are-separate-records-and-numbered-documents-are-immutable-order-snapshots.id.md), [ADR-0033](adr/0033-returns-refunds-and-exchanges-are-additive-records-that-compensate-through-the-existing-ledgers.id.md), [ADR-0040](adr/0040-aw-business-platform-capability-ownership-and-boundaries.id.md). Keadaan commerce saat ini: [`status.md`](status.id.md).
