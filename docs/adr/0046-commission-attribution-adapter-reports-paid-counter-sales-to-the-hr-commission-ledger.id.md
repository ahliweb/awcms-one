🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0046-commission-attribution-adapter-reports-paid-counter-sales-to-the-hr-commission-ledger.md)

<!-- i18n-source-hash: sha256:e55aef7943e17e4e959afad24059621cdc5b5a4aac8f3abfbb1c008d23e56f46 -->

# ADR-0046 — Adaptor atribusi komisi melaporkan penjualan kasir yang sudah dibayar ke buku besar `hr_commission`

- **Status:** Diusulkan
- **Tanggal:** 14 Oktober 2026
- **Pengambil keputusan:** diusulkan dalam pull request implementasi untuk ditinjau ahliweb, dalam batasan yang sudah ditetapkan oleh [ADR-0040](0040-aw-business-platform-capability-ownership-and-boundaries.md) D4 dan aturan khusus-templat [ADR-0024](0024-awcms-one-is-template-only-derived-apps-own-their-backend.md); menjadi Diterima saat pull request digabung
- **Terkait:** isu [#391](https://github.com/ahliweb/awcms-one/issues/391) (ADR ini dan implementasinya; separuh accrue adalah D1-D8, separuh pembalikan adalah D9), epik [#280](https://github.com/ahliweb/awcms-one/issues/280), prasyarat [#409](https://github.com/ahliweb/awcms-one/issues/409) (sinkronisasi yang membawa `hr_commission` dan `hr_workforce`); [ADR-0040](0040-aw-business-platform-capability-ownership-and-boundaries.md) D4 dan D5 butir 4; [ADR-0037](0037-the-commerce-migration-band-is-allocated-gap-first-and-widened-upstream.md) (migrasi `1030` dan `1031`); [ADR-0016](0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) tidak terlibat (tidak ada yang mengautentikasi pembeli di sini); model ancaman [alur F5](../aw-business-platform-threat-model.md) dan F7; `ahliweb/awcms` hulu ADR-0132 dan ADR-0011 (kontrak port) serta README modul `hr_commission` (`apps/cms/src/modules/hr-commission/README.md`, "Reversal is the next step of the ledger")

## Konteks

Modul `hr_commission` di hulu menyimpan buku besar komisi yang diperoleh sebuah employment. Modul ini menerima **fakta penjualan** lewat port netral, `CommissionAccrualPort` (`apps/cms/src/modules/_shared/ports/commission-accrual-port.ts`), dan menyatakan terang-terangan bahwa memverifikasi penjualan itu nyata, sudah dibayar dan milik karyawan tersebut adalah **kewajiban adaptor**, bukan buku besar. Repositori ini memiliki adaptor itu untuk `commerce` (ADR-0040 D4): satu baris pesanan yang sudah dibayar, dan nanti refund yang membalikkannya. Komisi afiliasi di `commerce` adalah hal lain dengan penerima manfaat eksternal dan tetap di tempatnya.

Port hanya membuka **`accrue`**. Pembalikan adalah fase buku besar yang belakangan (README modul menyebutnya "langkah berikutnya"). Itu yang membentuk seluruh keputusan: perubahan ini bisa melaporkan sebuah penjualan, tetapi tidak bisa menariknya kembali.

Adaptor ini juga harus menjadi **kapabilitas templat yang dapat dipakai ulang** (ADR-0024): tanpa skema komisi konsumen mana pun, tanpa nama konsumen, tanpa asumsi satu deployment. Tenant menyusun aturannya sendiri di `hr_commission`; `commerce` hanya menyatakan hal berbayar mana yang dilaporkan dan untuk siapa.

## Keputusan

### D1 — Konsumer yang dideklarasikan di descriptor atas fakta pesanan-dibayar, mati secara bawaan

`commerce.order_paid_commission_attributor` dideklarasikan di `domainEventConsumers` pada `apps/cms/src/modules/commerce/module.ts`, berlangganan `awcms.commerce.order.paid`, dengan idempotensi bawaan `runtime_effect_once` (`ahliweb/awcms` hulu ADR-0134, di `apps/cms/docs/adr/`; handler hanya efek sampingnya dan tidak pernah memanggil penjaga). Konsumer tidak melakukan apa pun kecuali tenant telah menyalakannya di `awcms_commerce_commission_settings` (`enabled`, bawaan `false`; CHECK melarang `enabled` tanpa kunci aturan). Pengaturan ini berupa tabel kecil tersendiri, bukan sakelar fitur baru di blob pengaturan modul `commerce`: ia membawa kunci aturan, sakelar akan menambah permukaan layar pengaturan dan string katalog untuk fitur yang belum punya layar, dan dengan tabel sendiri basis data dapat menolak "menyala tanpa aturan".

### D2 — Penerima manfaat diturunkan di server, tidak pernah diberikan (model ancaman F5, baris T)

Tidak ada kolom pesanan, keranjang atau checkout yang menyebut karyawan. Konsumer mengatribusikan pesanan hanya bila **semua** syarat ini terpenuhi, dibaca dari basis data dan tidak pernah dari payload event:

1. pesanan sudah melewati pembayaran dan tidak dibatalkan (`paid`, `processing`, `shipped`, `completed`) **dan** `payment_status = 'paid'`;
2. `channel`-nya `pos`;
3. membawa `pos_cashier_tenant_user_id`, yang dicap `pos-directory.ts` dari sesi terautentikasi saat penjualan dicatat;
4. login itu punya tautan staf yang **hidup** (D3).

Pesanan etalase, penjualan tanpa cap, dan login tanpa tautan semuanya dilewati: tidak ada penerima cadangan dan tidak ada karyawan bawaan.

Teks isu dan rancangan pertama menyebut operator sesi register sebagai penjual. Sebagai gantinya dipakai cap kasir pada **pesanan**: itulah login yang benar-benar mencatat penjualan ini (`current_cashier_tenant_user_id` sebuah sesi dapat berganti selama shift, dan `opened_by_tenant_user_id` adalah yang membuka laci, bukan yang menjual), dan cap itu ada baik tenant memakai fitur register maupun tidak. Tingkat kepercayaannya sama dengan fakta sesi, karena keduanya dicap di server dari aktor terautentikasi.

| Opsi untuk "siapa yang menjual"                   | Keamanan                                              | Ketepatan                                            | Kompatibilitas                     |
| ------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------- | ---------------------------------- |
| **A. Cap kasir pada pesanan itu sendiri**         | Dicap server dari sesi; klien tidak dapat mengaturnya | Tepat: login yang mencatat penjualan _ini_           | Berfungsi saat fitur register mati |
| B. Pembuka atau kasir saat ini pada sesi register | Dicap server                                          | Salah setelah serah terima atau bila manajer membuka | Memerlukan fitur register menyala  |
| C. Kolom pada penjualan yang menyebut karyawan    | Ditolak: dari klien, menugaskan sendiri (F5)          | n/a                                                  | n/a                                |

### D3 — Tautan staf milik commerce memetakan login ke id employment yang buram

`awcms_commerce_commission_staff_links` (`tenant_id`, `tenant_user_id`, `employment_id`, siapa yang membuat dan mempensiunkannya serta kapan) menggabungkan seorang tenant user dengan id employment `hr_workforce`. Id employment itu **buram**: tanpa foreign key, tanpa pembacaan, tanpa join (tes batas di `apps/cms/tests/commerce-commission-boundary.test.ts` memindai sumber dan migrasi commerce untuk tabel `awcms_hr_*` dan impor `hr-commission/` serta `hr-workforce/`). Buku besar memvalidasi employment (ada di tenant, hidup dan bekerja pada tanggal penjualan) di bawah kunci saat sebuah accrual ditulis, dan menolak penjualan jika tidak. Sisi tenant user adalah foreign key komposit `(tenant_id, tenant_user_id)`.

Sebuah login punya paling banyak satu tautan hidup dan sebuah employment paling banyak satu (indeks unik parsial). Tautan **dipensiunkan, tidak pernah dihapus**: `awcms_app` tidak punya DELETE dan trigger menolaknya untuk semua role; siapa yang digabungkan tidak pernah berubah; tautan yang dipensiunkan bersifat final, dan koreksi adalah pensiun ditambah tautan baru, sehingga riwayat menunjukkan keduanya. Membuat dan mempensiunkan berada di balik `commerce.commission_staff_links.manage` (aksi berisiko tinggi) dan diaudit; daftar memakai `.read`. Pengaturan punya `commerce.commission_settings.read` dan `.manage`. Hanya kata kerja yang sudah ada, sehingga union `AccessAction` milik hulu tidak diperlebar.

Pemetaan manual ini kelemahan yang diketahui (id employment yang salah ketik mengatribusikan komisi ke orang yang salah). Mitigasinya adalah izin berisiko tinggi, baris audit yang menyebut kedua id, dan pemeriksaan kelayakan buku besar sendiri; perbaikan sesungguhnya adalah port workforce yang menyelesaikan "employment dari login ini" (D8).

### D4 — Fakta yang dilaporkan: satu baris, basis bersihnya, tanggal tenant

Untuk setiap baris pesanan yang tidak dihapus dengan nilai bersih positif, konsumer memanggil `accrue` sekali dengan:

- **identitas sumber** `(type, ref, line)` = `(settings.sourceType, id pesanan, id baris pesanan)`; `sourceType` bawaannya `commerce_order_line` yang netral dan harus sama dengan `sourceType` yang dideklarasikan aturan tenant (port menolak ketidakcocokan). Buku besar menambahkan employment ke kunci uniknya, sehingga replay adalah accrual yang sama;
- **jumlah dasar** = total baris dikurangi bagian proporsionalnya dari diskon tingkat pesanan (`discount` + `loyalty_discount`, angka yang juga dikurangkan pemberi poin loyalitas), dialokasikan dengan fungsi sisa-terbesar yang sama dengan modul retur (`allocateOrderDiscount`), sehingga koreksi akibat refund di kemudian hari memetakan ke angka per baris yang sama. Ongkos kirim, asuransi dan pajak tidak pernah masuk basis. Uang adalah string desimal, bukan angka;
- **mata uang** = `IDR`, mata uang tunggal commerce (dokumen dan penawaran memakai CHECK; pesanan tidak punya kolom mata uang). Aturan dalam mata uang lain ditolak port, tidak dikonversi;
- **occurredAt** = `paid_at` pesanan; **occurredOn** = tanggal sipilnya di **zona waktu tenant sendiri** (`awcms_tenant_settings.timezone`, kembali ke zona pelaporan commerce `Asia/Jakarta` bila tenant belum punya baris pengaturan). Tidak ada nilai khusus-konsumen yang ditanam: zonanya milik tenant.

### D5 — Dihubungkan sebagai kapabilitas opsional, lewat satu sambungan

`commerce` mendeklarasikan `capabilities.consumes: [{ capability: "commission_accrual", providedBy: "hr_commission", optional: true }]` dan **bukan** dependensi siklus hidup: commerce harus tetap dapat diaktifkan, dan tetap berfungsi, untuk tenant yang tidak pernah menyalakan `hr_commission`, dan sisi keras akan menjadikannya prasyarat seluruh toko. Konsumer memeriksa sendiri status modul `hr_commission` tenant sebelum memanggil apa pun. Adaptor konkret (`createCommissionAccrualPort`) disebut di tepat satu berkas, `apps/cms/src/modules/commerce/application/commission-attribution-port.ts`, akar komposisi yang diminta kontrak port; setiap berkas lain bergantung pada _tipe_ port. Tes batas gagal bila itu pernah melebar. Tidak ada berkas milik hulu yang diubah perilakunya, jadi daftar divergensi di `AGENTS.md` akar tidak bertambah. Satu-satunya baris yang ditambahkan ke registri bersama adalah yang ditambahkan setiap modul: empat baris di buku besar `NOT_YET_SCREENED` yang hanya boleh menyusut (seperti kunci `hr_commission` sendiri) dan baris hibah worker di `security-readiness.ts`.

### D6 — Konsumer adalah aktor sistem; penolakan adalah hasil yang diaudit, bukan pengecualian

Port tidak melakukan pemeriksaan akses dan tidak menulis baris audit: akar komposisi konsumer harus mengotorisasi dan mengaudit aksi bisnisnya. Saat pengiriman tidak ada pengguna yang bertindak. Otorisasi untuk membayar komisi diberikan, oleh pemegang kedua izin `manage`, saat tenant menyalakan adaptor dan saat sebuah login ditautkan, dan keduanya diaudit pada tingkat `warning`. `created_by` accrual karena itu `null` (sistem), dan setiap upaya yang mengubah sesuatu diaudit oleh konsumer dengan pesanan sebagai sumber daya dan **tanpa jumlah, basis, tarif, referensi sumber atau id employment**: `commerce.commission.attributed` (info, dengan jumlah baris), `commerce.commission.attribution_refused` (warning, satu per jenis penolakan) dan `commerce.commission.attribution_rejected` (warning, konflik sumber dan permintaan tidak valid). Replay murni tidak mengaudit apa pun.

`no_effective_rule`, `employment_not_eligible` dan penolakan lain adalah hasil yang **dikembalikan** dan tidak pernah dilempar: pengiriman yang melempar dicoba ulang delapan kali lalu masuk dead-letter karena masalah konfigurasi yang tidak dapat diperbaiki coba ulang. Penolakan tingkat-pesanan berhenti pada baris pertama (jawabannya sama untuk setiap baris). Hanya kegagalan sungguhan (basis data) yang melempar, membatalkan pengiriman beserta penandanya. Akibatnya **penjualan yang ditolak tidak diputar ulang otomatis**: tenant memperbaiki aturan atau tautan dan penjualan yang terlewat tidak dicoba lagi. Memutar ulang murah (kunci buku besar membuatnya idempoten) tetapi memerlukan aksi operator yang belum ada; dicatat di bawah.

### D7 — Role worker mendapat hibah tersempit yang dibutuhkan inti pencatatan (`sql/1031`)

Konsumer berjalan di `domain-events:dispatch` sebagai `awcms_worker`, dan inti pencatatan port beserta trigger penjaganya berjalan dalam transaksi pemanggil dengan hak pemanggil. Migrasi `1031` memberi: SELECT pada dua tabel commerce; SELECT dan INSERT pada accrual dan log transisinya (tidak pernah UPDATE atau DELETE: worker tidak dapat menyetujui, membatalkan, membayar atau menulis ulang accrual); SELECT pada aturan dan employment ditambah **`UPDATE (id)` tingkat kolom** pada keduanya (PostgreSQL mensyaratkan hak UPDATE untuk bacaan `FOR SHARE` yang mencegah pensiun atau pemutusan yang bersamaan menyelinap di antara pemeriksaan dan insert; hibah satu kolom pada kunci yang tak berubah adalah cara tersempit, preseden: lokasi inventory); SELECT pada `awcms_tenant_settings` (zona waktu) dan `awcms_tenant_modules` (status modul). `WORKER_ROLE_GRANTS` di `apps/cms/scripts/security-readiness.ts` memuat baris tingkat tabelnya. Tes integrasi menjalankan seluruh pekerjaan sebagai role worker, menunjukkan bahwa menghapus hibah kolom merusaknya, dan menunjukkan worker tidak dapat menyetujui, membatalkan, menulis ulang atau menghapus accrual, mengubah aturan atau employment, atau menyentuh tautan atau pengaturan.

### D8 — Pembalikan saat refund, retur atau pembatalan TIDAK diimplementasikan: port tidak punya void

Kriteria penerimaan "refund melakukan void" **tidak dapat dipenuhi di repositori ini hari ini**. `CommissionAccrualPort` hanya membuka `accrue`. Satu-satunya cara void adalah aksi HTTP terautentikasi (`POST /api/v1/hr-commission/accruals/{id}/void`, di balik `hr_commission.accruals.void` untuk pengguna) atau mengimpor kode aplikasi `hr_commission`, yang dilarang batas modul (port ada agar commerce tidak pernah melakukannya). Menjangkau tabel buku besar dari commerce, atau memanggil fungsi aplikasinya langsung, persis pintu belakang yang ditolak ADR ini; itu tidak dilakukan. Accrual yang di-void juga mempertahankan kunci sumbernya, dan accrual yang sudah payable atau paid membutuhkan pembalikan, yang belum dibangun hulu.

Maka perubahan ini menyatakan celahnya dan mengusulkan perluasan hulu, untuk diajukan ke `ahliweb/awcms` (fondasi AWCMS generik mengikuti kepemilikan hulu; itu bukan divergensi lokal):

```ts
// apps/cms/src/modules/_shared/ports/commission-accrual-port.ts: kenaikan kontrak MINOR
export type CommissionVoidRequest = {
  employmentId: string;
  source: CommissionAccrualSource; // identitas tempat accrual dilaporkan
  reasonCode: string; // kode pendek, bukan teks bebas
  correlationId?: string;
};
export type CommissionVoidOutcome =
  | { outcome: "voided" | "already_voided"; accrualId: string }
  | { outcome: "not_found" }
  | { outcome: "not_voidable"; status: "payable" | "paid" } // butuh fase pembalikan
  | { outcome: "input_invalid"; message: string };
// CommissionAccrualPort mendapat:
//   void(tx, tenantId, actorTenantUserId, request): Promise<CommissionVoidOutcome>
```

Void menurut **identitas sumber** (bukan id accrual) memungkinkan adaptor tanpa-status membatalkan persis apa yang dilaporkannya. Setelah itu ada, `commerce` menambah konsumer untuk fakta pesanan-dibatalkan serta retur-dicatat atau refund-diselesaikan, memakai identitas `(sourceType, id pesanan, id baris pesanan)` yang sama, memetakan retur sebagian per baris dengan fungsi alokasi di atas, dan melaporkan accrual `not_voidable` untuk fase pembalikan. Usulan kedua menyertainya: port workforce yang menyelesaikan employment dari sebuah login, sehingga tautan staf (D3) dapat divalidasi saat dibuat, bukan dipercaya. **Sampai saat itu refund, retur atau pembatalan tidak mengurangi komisi yang sudah di-accrue**; accrual tetap `pending` untuk di-void manual oleh orang yang memegang `hr_commission.accruals.void`, dan dokumen menyatakannya. Isu koordinasi tetap terbuka untuk separuh ini.

### D9 — Amendemen (separuh kedua #391): pembatalan dan refund me-void accrual lewat `CommissionAccrualPort.void`

D8 digantikan pada kesimpulannya, bukan pada penalarannya. Hulu mengirimkan perluasan yang diminta D8 (ahliweb/awcms#1109, kontrak port `commission_accrual` 1.1.0, disinkronkan oleh #427): `void(tx, tenantId, actorTenantUserId, { source, employmentId, reason, correlationId })` dengan kunci identitas sumber yang sama seperti `accrue`, dengan hasil `voided`, `already_voided`, `not_found`, `period_closed`, `actor_required` dan `input_invalid`. Perluasan itu juga membuat dua pilihan yang berbeda dari usulan D8 dan diikuti apa adanya: accrual `payable` atau `paid` ditolak sebagai `period_closed` (di usulan: `not_voidable`), dan pelaku void harus seorang manusia.

**Dua konsumer lagi yang dideklarasikan di descriptor, keduanya `runtime_effect_once` secara bawaan (handler hanya efek sampingnya, tidak pernah memanggil penjaga):**

| Konsumer                                       | Event                            | Yang dibalikkan                                                          |
| ---------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| `commerce.order_cancelled_commission_reverser` | `awcms.commerce.order.cancelled` | setiap baris pesanan                                                     |
| `commerce.refund_settled_commission_reverser`  | `awcms.commerce.refund.settled`  | setiap baris retur yang di-refund dan kini sudah dikembalikan seluruhnya |

Keduanya membaca basis data, tidak pernah payload, dan menurunkan ulang penerima manfaat seperti accrue (cap kasir pesanan, lalu tautan staf), dengan identitas sumber `(settings.sourceType, id pesanan, id baris pesanan)`. Keduanya mencoba **setiap employment yang pernah ditautkan ke login itu, hidup maupun sudah dipensiunkan**: tautan bisa dipensiunkan atau diarahkan ulang antara penjualan dan refund-nya, dan accrual milik employment yang tertaut saat penjualan dibayar. Void untuk employment yang tidak pernah memperoleh baris itu adalah `not_found`, tanpa efek. Commerce tetap tidak membaca tabel komisi apa pun dan tidak menyimpan id buku besar; baris audit memuat pesanan sebagai sumber daya dan hanya hitungan.

**Refund sebagian (keputusannya).** Port me-void seluruh accrual dan accrual yang sudah di-void tidak pernah dihidupkan lagi, sehingga baris yang di-refund sebagian tidak dapat dibalikkan secara proporsional. Dua opsi ditimbang: me-void accrual baris pada refund apa pun atasnya, atau tidak berbuat apa-apa untuk baris itu sampai dikembalikan seluruhnya. Opsi kedua dipilih, per baris: refund membalikkan accrual sebuah baris hanya bila jumlah kuantitas baris itu pada semua retur `completed` milik pesanan mencapai kuantitas yang dipesan (`isLineFullyReturned`). Alasannya: ini arah yang konservatif untuk operasi yang tidak dapat dibatalkan (komisi yang keliru dipertahankan hanya berjarak satu `void` manual lewat `hr_commission.accruals.void` dan **ditandai**; komisi yang keliru di-void tidak dapat dibatalkan dan mengambil upah yang sudah diperoleh seseorang untuk unit yang tetap dipegang pelanggan); commerce tidak pernah membutuhkan tarif atau jumlah (D4: buku besar memiliki aritmetika); dan ini sesuai pernyataan D8 sendiri bahwa retur sebagian dipetakan per baris. Kasus yang ditunda tidak diam-diam: ia dihitung, dan satu baris peringatan `commerce.commission.reversal_needs_attention` mencatat `partiallyReturnedLines`. Sebuah retur hanya dipertimbangkan bila `completed` (leg refund terakhirnya sudah settle): event leg yang lebih awal menemukannya masih terbuka dan tidak berbuat apa-apa, sehingga uang yang masih tertunda tidak membalikkan apa pun. Retur yang tidak menggerakkan uang (penukaran tanpa leg refund) tidak menerbitkan `refund.settled` dan tidak membalikkan apa pun.

**`period_closed`.** Konsumer tidak pernah mencobanya ulang dan tidak pernah melempar karenanya: pengiriman yang melempar dicoba ulang delapan kali lalu masuk dead-letter untuk sesuatu yang tidak dapat diubah coba ulang. Baris dibiarkan apa adanya, tally dibawa ke satu baris audit peringatan `commerce.commission.reversal_needs_attention` (penyebab, berapa yang `payable`, berapa yang `paid`) dan pengiriman selesai. Baris itu adalah pekerjaan bagi manusia (clawback, yang belum punya mekanisme di keluarga modul ini; hulu mencatat baris negatif kompensasi sebagai tindak lanjut `sql/188`). Tidak ada tabel perhatian tersendiri: pola commerce yang sudah ada untuk "seseorang harus melihat" adalah baris audit berseverity peringatan (D6), dan antrean baru akan menjadi konsep kedua tanpa layar. `actor_required` dan `input_invalid` menempuh jalur yang sama.

**Aktor.** `void` mencap seorang manusia (`voided_by`, NOT NULL oleh CHECK siklus hidup; `null` adalah `actor_required`), dan konsumer event tidak punya pengguna yang bertindak (aktor di amplop event tidak sampai ke handler, dan pembatalan oleh pelanggan sendiri atau job kedaluwarsa memang tidak punya). Pelaku void adalah pengguna tenant yang terakhir menyimpan pengaturan komisi, orang yang memberi otorisasi pembayaran komisi untuk tenant ini (D6 sudah menyandarkan accrual sistem pada otorisasi itu). Baris audit buku besar karena itu menyebut orang tersebut sebagai pelaku void, dan baris audit commerce menyatakan pembalikan itu otomatis; inilah satu-satunya tempat `voided_by` buku besar adalah atribusi, bukan tangan di mesin kasir, dan hal itu dinyatakan di sini, tidak disembunyikan. Bila tidak ada, hasilnya `actor_required` dan pembalikan menunggu seseorang. Tidak ada login akun-layanan yang dikarang.

**Gerbang.** Pembalikan membutuhkan `hr_commission` menyala dan adaptor pernah dikonfigurasi (baris pengaturan ada); ia **tidak** membutuhkan `enabled` bernilai true. Mematikan adaptor menghentikan accrual baru; ia tidak boleh membiarkan accrual yang sudah dibuat terlantar saat penjualannya dibatalkan. Tipe sumber adalah yang berlaku di pengaturan saat ini: mengubahnya setelah accrual membuat accrual lama tidak terjangkau pembalikan otomatis (tampak sebagai tidak ada yang di-void, sehingga tenant harus me-void manual), kendala yang sama yang sudah dikenakan `source_type_mismatch` accrue pada aturan.

**Hibah (`sql/1051`, nomor pertama di atas pita `1035`-`1049` yang dicadangkan untuk adaptor Booking dan cadangan `1050` milik #386).** "Worker tidak pernah UPDATE accrual" pada D7 dipersempit, bukan dibuang: `awcms_worker` mendapat `UPDATE (status, voided_at, voided_by, void_reason_code)` pada `awcms_hr_commission_accruals` dan tidak lebih. Matriks tingkat tabel tetap `SELECT, INSERT`; `WORKER_COLUMN_GRANTS` mencatat keempat kolom. CHECK siklus hidup, trigger imutabilitas dan log transisi append-only tetap menentukan edge mana yang sah, dan port menolak accrual `payable` atau `paid` sebelum menulis apa pun, sehingga worker tetap tidak dapat menyetujui, merilis, membayar, mengubah jumlah, aturan, sumber atau penerima manfaat, atau menghapus. Suite integrasi menjalankan seluruh jalur sebagai role worker yang sebenarnya, menunjukkan bahwa mencabut hibah kolom merusak pembalikan dan memulihkannya memperbaikinya, serta menunjukkan penulisan lain tetap ditolak.

**Batas.** Daftar divergensi AGENTS.md tidak bertambah: tidak ada berkas milik hulu yang berubah perilakunya; tambahan pada registri bersama adalah jenis yang sudah disebut D5 (satu baris `WORKER_COLUMN_GRANTS` di `security-readiness.ts`, dua nama konsumer di `domain-event-consumer-declarations.test.ts`).

## Konsekuensi

- Tenant yang tidak melakukan apa pun tidak melihat perubahan: adaptor mati, tidak ada tabel yang dibaca per pesanan, tidak ada accrual dibuat.
- Replay, pengiriman ulang dan pengiriman balapan menghasilkan satu accrual per baris; jaminan tepat-sekali adalah kunci unik buku besar, diuji dengan enam pengiriman balapan.
- Penerima manfaat tidak dapat ditegaskan oleh klien. Risiko sisa adalah tautan staf yang diketik administrator, yang berisiko tinggi, diaudit dan hanya diperiksa kelayakannya saat accrual.
- **Sisa: verifikasi pembayaran adalah fakta `paid`/`payment_status` pesanan itu sendiri**, bukan penghitungan ulang segar dari buku besar alokasi pembayaran (baris S/T F5 model ancaman meminta bentuk yang lebih kuat). Itu fakta yang sama yang dipercaya pemberi poin loyalitas; pemeriksaan silang buku besar adalah tindak lanjut.
- Belum ada layar admin. Keempat izin ada di buku besar `NOT_YET_SCREENED` yang hanya boleh menyusut; API (dan OpenAPI) lengkap.
- Tidak ada entri `ROUTE_PARITY_EXEMPTIONS`: ketiga berkas rute ada beserta kontraknya.

## Belum ada

- Clawback accrual `payable` atau `paid` setelah refund atau pembatalan (D9 mencatatnya untuk manusia; keluarga modul belum punya mekanisme pembalikan-ke-periode-berjalan).
- Pembalikan proporsional baris yang dikembalikan sebagian (D9: port me-void seluruh accrual).
- Membalikkan komisi retur yang tidak menggerakkan uang (penukaran tanpa leg refund).
- Cara memutar ulang penjualan yang ditolak karena aturan hilang setelah tenant memperbaikinya.
- Layar admin pengaturan dan tautan staf.
- Penghitungan ulang "dibayar" dari buku besar alokasi pembayaran.
- Komisi bersumber Booking (isu adaptor Booking sendiri).

### D9 — Identitas sumber dibekukan begitu atribusi ada (tinjauan isu #413, `sql/1052`)

Identitas sumber akrual adalah `(settings.sourceType, id pesanan, id baris pesanan)`, dan buku besar memperlakukan identitas yang sama dengan `ruleKey` berbeda sebagai `source_conflict`. Pembatalan (void) berikutnya dialamatkan dengan identitas yang sama. Jika administrator mengubah `sourceType` atau `ruleKey` setelah akrual ada, void yang disusun dari pengaturan saat ini akan meleset diam-diam dan event yang dikirim ulang bisa mengakrual untuk kedua kalinya di bawah identitas baru.

Keputusan: `PUT` pengaturan **menolak perubahan `sourceType` atau `ruleKey` selama ada akrual yang dilaporkan di bawah pasangan tersimpan**: `409 COMMISSION_SOURCE_LOCKED`, diaudit pada tingkat `warning` sebagai `commerce.commission.settings_refused` (hanya kode tersimpan dan yang diminta). Mengirim ulang nilai tersimpan, dan mengubah hanya `enabled`, selalu diterima. Commerce tidak bisa bertanya ke buku besar apakah akrual ada (ia tidak membaca tabel komisi, D3, dan `CommissionAccrualPort` hanya punya `accrue`), dan jejak audit bisa dipurge, sehingga jawabannya milik commerce sendiri: `awcms_commerce_commission_attributed_sources`, satu baris insert-only per `(tenant, source_type, rule_key)`, ditulis konsumer dalam transaksi YANG SAMA dengan akrual yang dilindunginya (`ON CONFLICT DO NOTHING`; replay juga menulisnya). Konsumer mengambil `pg_advisory_xact_lock_shared` pada kunci per-tenant sebelum membaca pengaturan; pembaruan pengaturan mengambil kunci eksklusif pada kunci yang sama, membaca penanda dan memutuskan di bawahnya, sehingga perubahan tidak bisa menyela atribusi yang sedang berjalan (bentuk kunci mode inventaris). Worker hanya punya `SELECT, INSERT` dan trigger penjaga menolak UPDATE dan DELETE untuk semua peran. Tabel ini hanya berisi dua kode dan cap waktu: tanpa data subjek, disimpan selama hidup tenant. Konsekuensi yang sengaja tumpul: untuk memakai aturan atau tipe sumber lain setelah atribusi pertama, tenant memerlukan migrasi yang disengaja, bukan sunting pengaturan.

### D10 — Dorman sampai upstream menyediakan jalur worker yang sah (`sql/1053`)

D7 dan D9 memberi `awcms_worker`, identitas `domain-events:dispatch`, hak pada tabel keluarga payroll (`awcms_hr_commission_accruals`, `_transitions`, `_rules`, `awcms_hr_employments`) karena inti posting `CommissionAccrualPort` berjalan dalam transaksi pemanggil dengan hak pemanggil. Batas katalog payroll upstream (ahliweb/awcms#1015) hanya mengizinkan `awcms_app` memegang hak pada tabel itu, daftar izin worker-nya kosong, dan `hr-attendance-autosettle` mengunci `UPDATE` worker pada `awcms_hr_employments` hanya ke `updated_at`. Hak-hak tersebut melanggar gerbang upstream itu, dan repositori ini tidak melemahkan atau menyunting gerbang milik upstream.

Keputusan: adaptor **dikirim dalam keadaan dorman**. `sql/1053` mencabut setiap hak yang diberikan `sql/1031` dan `sql/1051` pada tabel `awcms_hr_*` (tingkat tabel dan kolom); hak pada tabel milik commerce serta pada `awcms_tenant_settings` / `awcms_tenant_modules` tetap, begitu pula hak `sql/280` milik upstream pada employments. Ketiga konsumer mempertahankan kodenya tetapi diekspor sebagai `DORMANT_COMMISSION_CONSUMERS` dan tidak dicantumkan di `domainEventConsumers`, sehingga dispatcher tidak pernah menjalankannya. Rute pengaturan, rute staff-link, tabel, dan izin tidak berubah, tetapi `PUT /api/v1/commerce/commission/settings` dengan `enabled: true` dijawab `409 COMMISSION_ADAPTER_DORMANT` agar tak ada yang mengira akrual berjalan; mematikannya tetap diterima. D1-D9 menggambarkan adaptor sebagaimana dibangun dan berlaku kembali setelah diaktifkan.

Tindak lanjut: aktivasi membutuhkan jalur worker yang sah dari upstream (titik masuk milik `hr_commission` yang boleh dipanggil worker, atau entri daftar izin worker yang diterima di bawah batas ADR-0132 upstream `awcms`). Setelah ada, daftarkan konsumer, beri hak lagi lewat jalur itu dalam migrasi baru, dan cabut penolakannya.
