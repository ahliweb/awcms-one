🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0026-loyalty-points-are-an-append-only-ledger.md)

<!-- i18n-source-hash: sha256:14e153801625b33bebf7d1ed66da224c5b1ea6087a4b3bd5a253f490401a2264 -->

# ADR-0026 — Poin loyalitas adalah buku besar append-only dengan saldo hasil proyeksi

- **Status:** Diterima
- **Tanggal:** 3 Oktober 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** [ADR-0003](0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md) (uang tetap eksak — aturan perolehan mengubah belanja `numeric(14,2)` menjadi sen bulat sebelum melakukan hal lain); [ADR-0008](0008-one-commerce-module-carries-the-whole-store-not-three.md) (fitur ini berada di dalam `commerce`, tanpa modul kedua); [ADR-0015](0015-commerce-migrations-live-in-the-reserved-9xx-range.md) (migrasi `950`–`952`); [ADR-0016](0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) D3 (endpoint untuk pelanggan diamankan dengan bearer, tidak pernah cookie); [ADR-0017](0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md) (`order.paid` diterbitkan oleh setiap jalur pembayaran, itulah yang membuat loyalitas bisa tidak menyentuh satu pun dari jalur itu); issue [#289](https://github.com/ahliweb/awcms-one/issues/289), bagian dari epic [#281](https://github.com/ahliweb/awcms-one/issues/281)

## Konteks

Issue #289 meminta kemampuan loyalitas/reward "terinspirasi reward OSPOS, tetapi dirancang sebagai buku besar poin yang dapat diaudit, bukan kolom poin pelanggan yang bisa diubah": perolehan, penukaran, kedaluwarsa, penyesuaian, dan pembatalan, dengan identitas sumber yang idempoten, saldo hasil proyeksi yang bisa dibangun ulang dan direkonsiliasi, kelayakan yang ditentukan oleh fakta bisnis sisi server, dan pelaporan yang tidak menghitung ganda. Poin loyalitas secara eksplisit **bukan** nilai kartu hadiah atau store credit (#288), dan aturan uang epic berlaku: aritmetika eksak, tanpa edit destruktif, RLS FORCE dengan referensi aman-tenant, idempotensi pada setiap penulisan berisiko tinggi.

Kendala yang paling membentuk rancangan adalah pekerjaan paralel: alokasi pembayaran (#285) sedang dibangun pada saat yang sama dan memiliki pembuatan order POS, transisi order menjadi dibayar, harga checkout, dan jalur webhook pembayaran. Maka loyalitas harus terintegrasi lewat apa yang sudah diterbitkan jalur-jalur itu, bukan dengan mengubahnya.

## Keputusan

### D1 — Tiga tabel di dalam `commerce`, di balik feature flag yang defaultnya MATI

`awcms_commerce_loyalty_programs` (aturan berversi), `awcms_commerce_loyalty_accounts` (satu per pelanggan per tenant), dan `awcms_commerce_loyalty_ledger` (fakta-faktanya), di `sql/950`. Tidak ada `module.ts` kedua (ADR-0008). Setiap referensi di antara ketiganya adalah foreign key komposit `(tenant_id, id)`, sehingga satu baris tidak bisa menunjuk program, akun, atau entri milik tenant lain bahkan lewat bug aplikasi; `awcms_commerce_customers` mendapat indeks unik `(tenant_id, id)` yang memungkinkannya (aditif — `id` sudah unik).

Fiturnya adalah `features.loyalty`, **default MATI**. Lima flag yang sudah ada default HIDUP karena mengatur perilaku yang sudah ada; loyalitas adalah perilaku baru yang mengakumulasi poin pada setiap order yang dibayar dan menampilkan saldo yang terlihat pelanggan, jadi tenant harus memilihnya. Tenant yang tidak pernah membuka bagian Fitur tidak terpengaruh. Setiap route pemilik menjawab `409 FEATURE_DISABLED` saat mati, route storefront menjawab `404` netral (aturan di `domain/commerce-features.ts`), dan entri sidebar disembunyikan.

### D2 — Ledger adalah kebenarannya; baris akun adalah proyeksi; hanya ada satu penulis

Setiap perubahan saldo adalah satu baris append-only. `awcms_commerce_loyalty_accounts.balance` adalah `SUM(ledger.points)`, dijaga **dalam transaksi yang sama** dengan setiap insert selama baris akun dipegang `FOR UPDATE`. `appendLedgerEntry` di `application/loyalty-ledger.ts` adalah satu-satunya fungsi yang meng-insert baris ledger atau menyentuh proyeksi (`apps/cms/tests/commerce-loyalty-routes.test.ts` gagal bila ada berkas lain di bawah `src/` yang melakukannya).

Konkurensi diselesaikan dengan kunci baris, bukan dengan retry: dua redeem konkuren antre pada akun, yang kedua membaca saldo hasil commit yang pertama dan ditolak bila akan overdraw. Alternatifnya adalah pemeriksaan versi optimistik dengan retry (lebih banyak kode, mode gagal yang terlihat saat terjadi kontensi, dan loop retry adalah tempat persis bug idempotensi bersembunyi) dan `SERIALIZABLE` (melempar kegagalan serialisasi ke setiap pemanggil). Kunci dipegang satu transaksi pendek yang menyentuh satu akun, dan tidak ada consumer atau job yang memegang lebih dari satu kunci akun, jadi tidak ada bahaya urutan kunci.

Setiap baris ledger membawa `account_seq` per akun (ditetapkan di bawah kunci) dan `balance_after` berjalan. Itu membuat riwayat berurutan tanpa memercayai timestamp, membuat reconcile mampu mendeteksi baris yang dimanipulasi (saldo berjalan tidak lagi cocok), dan membuat paginasi keyset eksak. `created_at` adalah `clock_timestamp()`, bukan `now()` — transaksi yang menunggu kunci kalau tidak akan dicap dengan saat ia mulai menunggu.

**Ledger append-only di bawah aplikasi:** `awcms_app` dicabut `UPDATE` dan `DELETE`, dan trigger menolak setiap `UPDATE` untuk role apa pun. Koreksi adalah baris kompensasi. Poin adalah bilangan bulat (`bigint`, dibatasi ±10¹² oleh CHECK, aman di dalam rentang safe-integer JavaScript, diverifikasi pada setiap decode) — bukan float, bukan uang.

### D3 — Aturan perolehan berversi, berlaku menurut tanggal, dan eksak

Satu baris program adalah satu *versi* aturan: `earn_points_per_unit` poin untuk setiap `earn_unit_amount` utuh dari belanja yang layak, minimum order opsional, batas per order opsional, dan masa kedaluwarsa dalam hari yang opsional. **Pembulatan adalah FLOOR dan dicatat pada baris** (`earn_rounding = 'floor'`), sehingga aturannya menjelaskan dirinya sendiri dan mode kedua adalah perubahan yang eksplisit. Belanja yang layak adalah `subtotal - discount` order (barang setelah voucher), dengan batas bawah nol — ongkir, asuransi, dan pajak tidak pernah diberi poin — dan aritmetikanya adalah sen bulat bigint lewat `toCents` yang sudah ada di modul ini, sehingga `0.9 / 0.3` tepat 3 (float menghasilkan 3.0000000000000004).

Perolehan menentukan versi yang berlaku pada **`paid_at`** order dan mencatat id-nya pada baris ledger; order yang dibayar di bawah versi 1 memperoleh poin di bawah versi 1 walau event-nya diproses setelah versi 2 aktif. Versi tidak dapat diubah setelah aktif, karena baris ledger berkata "diperoleh di bawah versi N" dan mengedit N akan memalsukannya; perubahan aturan adalah versi baru. Aktivasi berlaku segera (`effective_from` = sekarang) dan menutup versi yang terbuka pada saat itu dalam transaksi yang sama. "Paling banyak satu versi terbuka pada satu waktu" ditegakkan oleh transaksi itu di bawah advisory lock per tenant, bukan oleh exclusion constraint `btree_gist` yang akan menambah ketergantungan ekstensi yang tidak dimiliki skema ini; tes aktivasi konkuren mengunci sifat tersebut.

Tier opsional (terpisah dari level harga `customer.level` yang sudah ada) masuk dalam cakupan issue dan ditunda — lihat Ditunda.

### D4 — Idempotensi adalah fakta database, bukan kebiasaan handler

Setiap baris ledger memiliki `idempotency_key` unik per tenant: `earn:order:<orderId>`, `reversal:order:<orderId>`, `expire:<lotEntryId>`, `redeem:<accountId>:<clientKey>`, `adjust:<accountId>:<clientKey>`. Event yang di-replay, job yang dijalankan ulang, atau retry klien tidak bisa menulis baris kedua. Dua indeks unik parsial membuat kasus struktural mustahil terlepas dari kunci — satu `reversal` per entri asal, satu penanda `expire` per lot perolehan. Redeem dan adjust juga memakai penyimpanan bersama `awcms_idempotency_keys` (respons tersimpan di-replay; kunci yang sama dengan body berbeda adalah `409 IDEMPOTENCY_CONFLICT`), dan id akun menjadi bagian dari kunci ledger sehingga satu kunci klien tidak bisa bertabrakan antar pelanggan. Redeem yang ditolak (tidak cukup) sengaja tidak dicatat, sehingga kunci yang sama bisa berhasil setelah top-up.

### D5 — Perolehan dan pembatalan digerakkan oleh domain event; loyalitas tidak mengubah kode order maupun pembayaran

`commerce.order_paid_loyalty_earner` mengonsumsi `order.paid` dan `commerce.order_cancelled_loyalty_reverser` mengonsumsi `order.cancelled`, terdaftar di `domain-event-runtime/infrastructure/consumer-registry.ts` di samping entitlement grantor (pengecualian terdokumentasi `domain_event_runtime -> commerce` yang sama). Setiap jalur pembayaran — storefront, POS, webhook gateway, reconcile — sudah menerbitkan `order.paid`, sehingga tidak ada satu pun dari `order-directory.ts`, `pos-directory.ts`, penetapan harga, atau berkas webhook pembayaran yang berubah. Consumer membaca baris order, tidak pernah payload event (yang tidak membawa uang), dan menoleransi order yang sudah berpindah keadaan: order yang dibatalkan, pelanggan sentinel walk-in (baris placeholder bersama, bukan orang), pelanggan terblokir, fitur yang dimatikan, atau program yang tidak ada/belum berlaku semuanya dilewati secara diam-diam. Melewati karena fitur mati **tidak berlaku surut**: menghidupkan loyalitas kemudian tidak mengisi ulang order sebelumnya.

Dispatcher berjalan sebagai `awcms_worker` saat deployment mengonfigurasinya, sehingga `sql/951` memberi worker persis yang dibutuhkan consumer dan job (programs `SELECT, DELETE`; accounts `SELECT, INSERT, UPDATE, DELETE`; ledger `SELECT, INSERT, DELETE`, tidak pernah `UPDATE`) dan satu grant baru, `SELECT` pada `awcms_module_settings`, karena consumer perolehan membaca `features.loyalty`. Suite integrasi menjalankan perolehan dan kedaluwarsa sebagai role `awcms_worker` sungguhan untuk membuktikannya.

### D6 — Kedaluwarsa per lot perolehan; pembatalan boleh membuat saldo negatif

Ledger tidak dapat membawa kolom "sisa" yang berkurang, sehingga seberapa banyak sebuah perolehan masih belum terpakai **diturunkan**: `domain/loyalty-lots.ts` me-replay entri akun dalam urutan `account_seq` dan mengalokasikan setiap debit terhadap entri positif ("lot") dengan yang paling cepat kedaluwarsa lebih dulu (lot yang tidak pernah kedaluwarsa terakhir), melewati lot yang sudah kedaluwarsa pada saat debit itu sendiri. Ia murni, deterministik, dan tidak menyimpan apa pun yang bisa menyimpang; tes properti membangkitkan 200 ledger acak dan memeriksa `balance = Σ sisa − defisit`.

`commerce:loyalty:expire` (tiap jam) menambahkan satu baris `expire` per lot jatuh tempo untuk poin yang masih ada. Lot yang sudah habis terpakai mendapat **penanda nol poin** (CHECK tanda mengizinkan `expire <= 0`) agar pemindaian berhenti, bukan menemukannya lagi selamanya; indeks unik `expire` membuat penanda kedua mustahil. Kebenaran tidak bergantung pada kadensnya: redeem, penyesuaian, atau pembatalan terlebih dahulu mengekspirasi lot akun yang jatuh tempo sendiri, di bawah kunci yang sama, sehingga poin yang sudah lewat tidak pernah bisa dibelanjakan.

**Pembatalan** (order dibatalkan) adalah baris kompensasi, bukan penghapusan. Ia mengambil kembali poin asli lot **dikurangi apa pun yang sudah kedaluwarsa** (itu sudah hilang; mengambilnya lagi berarti mengurangi dua kali), dan mencakup poin yang sudah **dibelanjakan** pelanggan, sehingga saldo bisa menjadi **negatif** — alternatifnya, membatasi di nol, berarti pelanggan bisa memperoleh, membelanjakan, lalu membatalkan tanpa biaya. Saldo negatif memblokir redeem sampai perolehan berikutnya menutupinya. Penyesuaian negatif *manual* tidak boleh membuat saldo di bawah nol; hanya pembatalan sistem yang boleh.

### D7 — Reconcile hanya-baca secara default, hanya memperbaiki proyeksi, dan melaporkan yang tidak bisa diperbaikinya

`commerce:loyalty:reconcile` (harian) menghitung ulang setiap akun dari ledger dan melaporkan (a) drift proyeksi — `balance`/`version` tidak cocok dengan ledger — dan (b) ledger break — baris yang `balance_after` berjalannya bukan jumlah berjalan. Ia keluar non-nol pada keduanya, sehingga scheduler menampakkannya. Ia tidak pernah menulis. Perbaikan adalah `POST /api/v1/commerce/loyalty/reconcile {"repair": true}` di bawah `commerce.loyalty.manage`, mengunci setiap akun yang drift, menghitung ulang di bawah kunci, menulis ulang **hanya** `balance`/`version`, dan mengaudit tiap satu. Ledger break dilaporkan dan tidak pernah diperbaiki: tabel append-only yang tidak sepakat dengan dirinya sendiri butuh manusia, bukan skrip. Pemindaian mencakup seluruh tenant (dibatasi 1.000 temuan per run); pemindaian penuh ledger per tenant sekali sehari dapat diterima pada skala ini, dan pemindaian keyset berpotongan adalah hal pertama yang diubah bila tenant melampauinya.

### D8 — Empat izin pada tiga kode aktivitas, bukan `loyalty.adjust` / `loyalty.redeem`

`commerce.loyalty.read`, `commerce.loyalty.manage` (aksi berisiko tinggi yang sudah ada: ia mengubah apa yang diperoleh setiap order mendatang), `commerce.loyalty_adjustments.create`, dan `commerce.loyalty_redemptions.create`. Issue menggambarkan `commerce.loyalty.adjust|redeem`, tetapi `AccessAction` berada di `identity-access/domain/access-control.ts` milik upstream dan tidak memiliki anggota tersebut; menambahkannya akan menaruh divergensi baru di berkas subtree untuk setiap sync mendatang (preseden `"send"` ada dan sudah menjadi lokasi konflik yang tercatat). Penyesuaian manual dan redeem masing-masing adalah *pembuatan* baris ledger, jadi `create` pada kode aktivitasnya sendiri mengatakan hal yang sama, menjaganya dapat diberikan terpisah (kasir bisa redeem tanpa bisa menyesuaikan), dan tidak menyentuh apa pun di upstream. Penyesuaian membutuhkan alasan (juga CHECK database) dan aktor, serta diaudit.

### D9 — Satu domain event untuk setiap baris ledger

`awcms.commerce.loyalty.entry_recorded`, agregat = akun loyalitas, payload `{entryId, accountId, customerId, kind, points, balanceAfter, sourceType}` — tanpa nama, telepon, atau alasan teks bebas. Satu tipe, bukan lima, karena setiap consumer yang menginginkan "saldo berubah" menginginkan kelima jenis, dan yang menginginkan satu jenis menyaring pada `kind`. Terdaftar di `module.ts`, registri tipe event, dan dokumen AsyncAPI dalam perubahan yang sama.

### D10 — Endpoint pelanggan diamankan bearer, terlingkup pemilik secara konstruksi, dan lebih sempit dari tampilan staf

`GET /api/v1/commerce/storefront/account/loyalty` mengikuti ADR-0016 D3: sesi bearer opaque, tanpa cookie, tanpa CORS berkredensial. Id pelanggan dibaca **hanya** dari sesi yang terverifikasi — route tidak menerima id pelanggan, akun, atau ledger sama sekali — dan `fetchCustomerLoyaltyOverview` menentukan akun *dari* pelanggan itu dan membaca ledger *untuk akun itu*. Tes BOLA menjalankan persis fungsi itu untuk dua pelanggan; tes struktural gagal bila route pernah membaca id dari request. Proyeksinya membuang aktor staf, alasan teks bebas, dan id sumber/program. Halaman UI storefront bukan bagian perubahan ini (Ditunda).

### D11 — Pelaporan adalah jumlah ledger, bukan proyeksi kedua

`GET /api/v1/commerce/loyalty/summary` mengembalikan diperoleh / ditukar / kedaluwarsa / penyesuaian (neto) / dibatalkan / neto untuk satu rentang, ditambah total poin beredar sepanjang waktu, setiap angka berupa `SUM` atas satu ledger yang dikelompokkan menurut `kind`. Satu poin dihitung sekali: perolehan hanya ada di `earned`; kedaluwarsa atau pembatalannya adalah baris lain di bucket lain. `outstanding` adalah jumlah ledger, bukan proyeksi, sehingga tetap benar walau proyeksi drift. Dua rentang yang tidak beririsan berjumlah sama dengan angka sepanjang waktu (diuji). Tabel proyeksi pra-agregasi lewat mesin reporting akan menambah jalur rebuild dan kelambatan kesegaran untuk angka yang dijawab langsung oleh indeks `(tenant_id, created_at)`; tinjau ulang bila ledger tumbuh melampaui yang dilayani pemindaian rentang.

### D12 — Retensi eksplisit, dan setiap cursor hanya menjangkau yang sudah mati

Tiga deskriptor `dataLifecycle` (engine generik; batas bawah lima tahun, default dan batas atas sepuluh, kelas `financial_tax`), dipilih agar purge tidak bisa meninggalkan yatim: ledger menurut `created_at` (`reversal` merujuk perolehannya dengan `ON DELETE CASCADE`, sehingga satu batch tidak pernah memisahkan pasangannya); akun menurut `updated_at` (akun yang menganggur selama seluruh rentang, yang riwayatnya dihapus lebih dulu oleh purge ledger; FK ledger ke akun adalah RESTRICT, sehingga pass yang mendahului gagal tanpa bahaya dan berhasil kemudian); program menurut `effective_to` (`NULL` untuk draf atau versi terbuka tidak pernah memenuhi `< cutoff`, sehingga aturan yang hidup tak terjangkau). `BOUNDED_BY_DESIGN` sengaja **tidak** dipakai: tesnya sendiri mensyaratkan penyusutan neto untuk setiap pertumbuhan. Konsekuensi jujurnya: akun *aktif* yang riwayat paling awalnya dipurge tidak lagi berjumlah sama dengan proyeksinya, dan reconcile melaporkannya; sepuluh tahun menjadikannya pilihan operator yang disengaja. Ketiga tabel adalah `retain_under_obligation` di `subjectData` (baris menjangkau seseorang hanya lewat `commerce.customers`, yang tidak membawa id tenant-user/identity — ADR-0016 D1).

## Ditunda (tercantum di issue, dengan sengaja tidak dibangun di sini)

- **Redeem ke harga checkout dan tender POS.** Redeem hanya mencatat pengurangan poin. Mengubah poin menjadi diskon membutuhkan model tender #285 dan keputusan tentang nilai sebuah poin; belum ada field `redeem_value`, daripada angka placeholder.
- **Tier opsional.** Belum dibangun; bila nanti dibangun, tetap terpisah dari level harga `customer.level` kecuali pemetaannya diputuskan eksplisit.
- **Kompensasi retur/refund per baris (#287).** Pembatalan hari ini seluruh order, saat pembatalan — satu-satunya event order kompensasi yang ada. Belum ada status/event order refunded.
- **Kelayakan kampanye/segmen/promosi (#280)**, **perolehan per baris** (`source_type`/`source_id` ledger setingkat order; kolom baris bersifat aditif), dan **aktivasi berjadwal ke depan** (butuh scheduler agar jujur tentang kapan versi mulai).
- **Halaman UI storefront** untuk saldo dan riwayat (endpoint ada; halaman menyentuh matriks build-profile toko dan merupakan perubahan terpisah), **form edit draf** di layar admin (`PATCH` ada; layar membuat draf baru), dan tampilan **"segera kedaluwarsa"**.
- **Skala replay.** Kedaluwarsa dan pembatalan memuat seluruh ledger akun bila ada yang jatuh tempo; gerbang `EXISTS` yang murah menjauhkannya dari jalur umum, dan checkpoint per akun berkala adalah tindak lanjutnya bila satu akun pernah memegang puluhan ribu baris.

## Konsekuensi

- Saldo pelanggan di storefront bisa tertinggal dari job kedaluwarsa hingga selama intervalnya untuk akun yang tidak disentuh siapa pun; setiap *aksi* (redeem, adjust, reverse) eksak karena mengekspirasi lebih dulu.
- `awcms_worker` mendapat `SELECT` pada `awcms_module_settings` (RLS tenant, hanya-baca) — perubahan pada matriks worker di `apps/cms/scripts/security-readiness.ts`, dilakukan karena consumer perolehan harus membaca feature flag.
- Menambahkan `loyalty` ke `CommerceFeatureKey` adalah perubahan union satu baris yang harus dipelajari tiga tes yang sudah ada (ekspektasi flag default, jumlah peta label, jumlah izin).
- Consumer perolehan mengimpor `loyalty-ledger.ts`, yang mengimpor `append-domain-event`, yang mengimpor registry consumer: siklus impor tingkat berkas, tidak berbahaya karena kedua sisi memakai ekspor satu sama lain hanya di dalam badan fungsi. Hal ini dinyatakan di komentar registry itu sendiri agar pembaca berikutnya tidak menemukannya ulang.
