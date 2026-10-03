🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0031-expenses-are-commerce-local-register-linked-petty-cash.md)

<!-- i18n-source-hash: sha256:9f3d79c683f92f57f080a1d6240fec8f6b07c189d5e9138d798e882a9167d2e4 -->

<!-- i18n-source-hash: sha256:placeholder -->

# ADR-0031 — Pengeluaran adalah kas kecil lokal-commerce yang terhubung ke register, bukan buku besar: pengeluaran yang diposting menambah mutasi register dan tidak pernah mengedit tutup kas

- **Status:** Diterima
- **Tanggal:** 3 Oktober 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** [ADR-0028](0028-pos-register-sessions-and-cash-up.md) (register tempat ini tersambung; **D10 dan butir "Ditunda" tentang pengeluaran diselesaikan di sini**); [ADR-0025](0025-payments-are-an-allocation-ledger-separate-from-order-status.md) (penalaran izin yang dipisah per sumber daya, gaya ledger append-only); [ADR-0003](0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md) (uang); [ADR-0015](0015-commerce-migrations-live-in-the-reserved-9xx-range.md) (rentang migrasi); [ADR-0016](0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) (pelanggan tetap di luar kosakata profil); issue [#294](https://github.com/ahliweb/awcms-one/issues/294) di bawah epic [#281](https://github.com/ahliweb/awcms-one/issues/281), dan PR tata kelola epic tersebut [#298](https://github.com/ahliweb/awcms-one/pull/298).

## Konteks

Pemilik kasir membayar es batu, tip kurir, atau isi ulang gas dari laci sepanjang hari, dan ADR-0028 sudah memungkinkan laci mencatat pembayaran semacam itu sebagai mutasi `expense` berupa teks bebas. Itu menjawab "apakah laci berisi sebagaimana mestinya?", tetapi bukan pertanyaan berikutnya dari seorang pemilik: untuk apa saja uang dikeluarkan, siapa yang mengizinkan yang besar, di mana struknya, dan apakah kesalahan dapat dibatalkan tanpa menulis ulang shift yang sudah ditutup? Issue #294 meminta hal itu, dengan pagar yang disengaja: *"Tidak berpura-pura bahwa issue ini adalah sistem buku besar/AP yang lengkap"*, dan keputusan kepemilikan wajib sebelum kode apa pun — kas kecil lokal-commerce, atau domain keuangan/pengeluaran generik di hulu `ahliweb/awcms`.

## Keputusan

### D1 — Kepemilikan: model kas kecil lokal-commerce yang terhubung ke register, secara eksplisit BUKAN buku besar

Ini diklasifikasikan sebagai **kas kecil dan pengeluaran operasional lokal-commerce yang terhubung ke register**. Ia berada di modul `commerce`, skemanya dua tabel (`awcms_commerce_expense_categories`, `awcms_commerce_expenses`) ditambah satu kolom bertipe pada mutasi register yang dihasilkannya, dan satu-satunya integrasinya dengan platform lainnya adalah register POS (#284). Ia bukan buku besar, utang usaha, master vendor, anggaran, model pajak, atau bagan akun: tidak ada akun, tidak ada baris jurnal, tidak ada jatuh tempo, tidak ada multi-mata-uang.

Mengapa lokal-commerce dan bukan di hulu, sekarang:

- **Satu-satunya sumber kas di repo ini hari ini adalah register POS.** Setiap konsumen yang ada menginginkan "pengeluaran yang menggerakkan laci". Domain keuangan generik yang dibangun untuk satu konsumen adalah tebakan tentang konsumen kedua.
- **Domain keuangan generik tidak ada di hulu.** `ahliweb/awcms` tidak punya modul keuangan; membangunnya berarti merancang akun, periode, aturan posting, dan pajak di dalam subtree yang tidak dimiliki repo ini, dengan permukaan konflik sinkronisasi sebesar sebuah buku besar. Aturan issue itu sendiri — "pilih hulu ketika model menjadi lebih luas dari mutasi kas register" — adalah kawat pemicunya, dan model ini sengaja tidak pernah melewatinya.
- **Batasnya dijaga sempit agar dapat diserap.** Tiga kata benda adalah seluruh permukaannya: *kategori pengeluaran*, *catatan pengeluaran*, *posting → mutasi register*. Modul keuangan hulu di masa depan akan memiliki akun dan jurnal; model ini kemudian menjadi adaptor — setiap pengeluaran yang diposting atau dibalik adalah satu entri jurnal seimbang yang sisi kasnya sudah teridentifikasi oleh `awcms_commerce_register_movements.expense_id`. Tidak ada yang dibentuk di sekitar konvensi akuntansi tertentu yang harus dibatalkan adaptor.

Alternatif yang ditimbang:

| | A. Kas kecil lokal-commerce (dipilih) | B. Modul pengeluaran/keuangan generik di hulu lebih dulu | C. Pertahankan hanya mutasi `expense` berupa teks bebas (status quo) | D. Buku besar / AP sungguhan di repo ini |
| --- | --- | --- | --- | --- |
| **Kelebihan** | Rilis pada satu-satunya konsumen yang ada; skema kecil; memakai ulang kunci, audit, dan tutup kas register; dapat diserap kemudian lewat adaptor | Rumah jangka panjang yang tepat untuk akuntansi; satu model untuk semua vertikal | Tanpa permukaan baru | Akan menjawab setiap pertanyaan keuangan |
| **Kekurangan** | Tempat kedua untuk dicari jika keuangan datang; kategorinya bukan bagan akun | Memblokir #294 pada desain hulu tanpa konsumen kedua; risiko divergensi subtree besar; lambat | Tanpa kategori, persetujuan, struk, atau pembalikan; kasir dapat mencatat jumlah apa pun tanpa tinjauan | Cakupan berbulan-bulan; aturan akuntansi ditebak; bertentangan dengan non-tujuan eksplisit issue |
| **Keamanan** | Ambang persetujuan, SoD, struk privat, FORCE RLS, FK komposit — semuanya ditegakkan di skema maupun kode | Kontrol yang sama, tetapi dirancang generik dan lebih lambat | Jalur mutasi mentah tidak punya persetujuan sama sekali (celah yang ditutup D6) | Permukaan serangan terbesar; kunci periode dan integritas posting harus benar sejak hari pertama |
| **Kinerja** | Dua tabel kecil; satu insert mutasi per posting laci; pembacaan keyset berindeks | Tidak diketahui | Tidak ada tambahan | Volume jurnal dan pemeriksaan keseimbangan di jalur panas |
| **Keterpeliharaan** | Modul yang sama, disiplin yang sama seperti #284; satu orang dapat memahaminya | Kontrak lintas repo dan keterikatan rilis | Tak ada yang dipelihara, tak ada yang didapat | Produk di dalam produk |
| **Skalabilitas** | Jumlah baris mengikuti aktivitas toko; RLS per tenant; jendela retensi dideklarasikan | Berskala sesuai desain, jika dirancang | Baik | Perlu partisi dan pengarsipan sejak awal |
| **Aksesibilitas / UX** | Satu layar, konfirmasi `<dialog>` native, formulir berlabel, tabel bertumpuk terjemahan | UI keuangan generik yang tidak diminta pemilik toko | Teks bebas hanya di laci | UI back-office berat |
| **Kompatibilitas** | Murni aditif; fitur MATI = toko hari ini | Bergantung pada rilis hulu | Kompatibel dengan tidak melakukan apa-apa | Invasif |
| **Kompleksitas operasional** | Satu flag, satu ambang, tanpa job baru | Siklus hidup modul baru, peran baru, peningkatan baru | Tidak ada | Tinggi |
| **Jangka panjang** | Jalur adaptor terjaga | Kondisi akhir terbaik, dicapai terlalu dini | Jalan buntu | Dibangun berlebihan untuk pertanyaan yang diajukan |

### D2 — Tabel (`sql/990`–`sql/993`)

`awcms_commerce_expense_categories` (`code` unik per tenant tanpa membedakan huruf besar/kecil, `name`, `active`) dan `awcms_commerce_expenses` (kategori, `status`, `amount numeric(14,2) > 0`, `tender_type`, `occurred_on date`, `description`, `payee_name` opsional, `register_session_id` opsional, `receipt_media_object_id` opsional, serta stempel pembuat / pengaju / pemutus / pemosting / pembalik / pembuang beserta waktunya dan ambang persetujuan yang berlaku). Keduanya FORCE RLS dengan `WITH CHECK`, memakai foreign key komposit `(tenant_id, …)` yang didukung `UNIQUE (tenant_id, id)`, menyimpan staf sebagai stempel uuid tenant-user biasa (catatan fiskal harus hidup lebih lama dari akun), mengindeks setiap foreign key, dan kehilangan `DELETE` untuk `awcms_app` (hanya worker retensi yang boleh menghapus, setelah batas sepuluh tahun; `sql/993`). `deleted_at` hanya ada sebagai kursor mesin retensi dan tidak pernah diisi — pengeluaran dibalik atau dibatalkan, tidak pernah dihapus, dan mutasi register menyimpan foreign key ke sana. `sql/991` menambahkan `reference_kind = 'expense'` dan `expense_id` ke mutasi append-only (menyelesaikan ADR-0028 D10), `sql/992` menyemai izin.

### D3 — Siklus hidup, ditegakkan oleh trigger maupun kode

`draft → posted`, atau `draft → pending_approval → posted | draft (ditolak)`, lalu `posted → reversed`; `cancelled` adalah draf yang dibuang. `reversed` dan `cancelled` bersifat akhir. Trigger menolak perpindahan yang tidak sah dan membekukan isi (kategori, jumlah, metode, tanggal, alasan, payee, sesi laci) begitu baris meninggalkan `draft`, sehingga pemberi persetujuan memutuskan persis apa yang diajukan dan pengeluaran yang diposting menjadi bukti; fakta posting dari baris yang diposting tidak pernah berubah; struk boleh dilampirkan pada pengeluaran yang diposting atau dibalik satu kali dan tidak pernah diganti. Constraint CHECK menyatakan bentuknya: pengeluaran laci adalah tunai; pengeluaran yang diposting menyebut siapa yang memostingnya, bagaimana disetujui, dan — bila dibayar dari laci — mutasinya; **pemutus yang menyetujui tidak pernah sama dengan pembuatnya** (`approver_check`).

### D4 — Persetujuan melalui ambang tenant dan pemisahan tugas, bukan `workflow_approval`

Pengaturan tenant `expenses.approvalThreshold` (bawaan `"0.00"`: setiap pengeluaran memerlukan orang kedua — ketat secara bawaan, dilonggarkan dengan sengaja; dibaca secara defensif, sehingga nilai rusak hanya membuat posting lebih ketat). Dalam ambang itu, posting langsung (`auto`). Di atasnya, hanya pemosting yang memegang `commerce.expense_postings.approve` **dan tidak membuat pengeluaran itu** yang dapat memostingnya dalam satu langkah (`approved`); selain itu pengeluaran tetap `pending_approval`, dan pengeluaran tertunda disetujui atau ditolak oleh orang yang memegang kunci approve dan **bukan pembuat maupun pengajunya** (`403 SEGREGATION_OF_DUTIES`). Penolakan memerlukan catatan dan mengembalikan pengeluaran ke `draft`. `approve` adalah kata kerja berisiko tinggi, sehingga tenant dapat menyusun aturan SoD tambahan terhadapnya. Keputusannya adalah fungsi murni (`decidePosting`, `approvalSegregationViolation` di `domain/expense.ts`) dan diuji secara menyeluruh.

Brief meminta memilih `workflow_approval` lewat API publiknya. Ia dievaluasi dan **tidak dipakai**, dengan alasan yang spesifik, bukan preferensi: ia tidak mengekspos port kapabilitas — konsumen menjangkaunya lewat definisi alur kerja berversi yang disusun tenant dan registri kondisi/aksi statis yang ditinjau yang merupakan sumber hulu (`workflow-approval/infrastructure/condition-action-registry.ts`), sehingga menyambungkan tipe sumber daya `expense` berarti mengedit kode hulu yang tidak dimiliki repo ini; tenant yang tidak pernah menerbitkan definisi akan **tidak punya persetujuan sama sekali** (fail-open), sedangkan ambang dengan bawaan ketat bersifat fail-closed; dan posting harus diputuskan dalam transaksi yang sama dengan mutasi register yang ditulisnya, yang tidak dapat dijanjikan mesin instans asinkron. Persetujuan tutup kas ADR-0028 mengambil keputusan yang sama dengan alasan yang sama. Jika `workflow_approval` kelak memiliki port kapabilitas, ambang menjadi aturan perutean bawaan dan bukan diganti.

### D5 — Integrasi register: sebuah mutasi, bukan total; tepat satu kali

Memposting pengeluaran yang dibayar dari laci menambahkan **satu** mutasi kas keluar `expense` ke sesi pengeluaran itu lewat `appendRegisterMovement` — penulis yang sama dengan rute mutasi manual (diekstrak dari `recordRegisterMovement` untuk ini), sehingga baris audit dan event `movement_recorded` identik. Kas yang diharapkan pada tutup kas adalah `saldo awal + … + Σ mutasi masuk − Σ mutasi keluar` (ADR-0028 D2), sehingga pengeluaran tercermin di dalamnya tepat ketika, dan hanya ketika, mutasinya ada; tidak ada yang di sini pernah mengedit total tutup kas. "Tepat satu kali" bersifat mekanis, dalam tiga lapis: baris pengeluaran dikunci `FOR NO KEY UPDATE` lebih dulu dan posting kedua adalah `409 EXPENSE_NOT_POSTABLE`; `source_key` mutasi adalah `expense:<id>:post`; dan indeks UNIQUE parsial `sql/991` mengizinkan paling banyak satu mutasi `out` dan satu `in` per pengeluaran. Sesi dikunci `FOR SHARE` setelah baris pengeluaran (selalu dalam urutan itu, sehingga tidak ada siklus), sehingga penutupan dan posting berjalan serial dan mutasi mendarat pada sesi yang terbuka pada saat itu juga (trigger `sql/970` adalah cadangannya).

**Pembalikan membuat mutasi penyeimbang**: sebuah `correction` kas **masuk** dengan jumlah yang sama. Ia masuk ke sesi pengeluaran jika masih terbuka, jika tidak ke sesi terbuka pada **register yang sama**; bila tidak ada yang terbuka ia ditolak (`409 REGISTER_SESSION_REQUIRED`) alih-alih diam-diam melewati laci — kas belum kembali sampai sebuah laci dapat menyatakannya. Shift yang sudah ditutup tidak pernah ditulis ulang: laporannya identik byte demi byte sebelum dan sesudah (dibuktikan di suite integrasi). Aktor mutasi adalah siapa pun yang menyelesaikan aksi (sehingga pemberi persetujuan yang memposting pengeluaran kasir adalah aktor mutasinya), dan aturan khusus-kasir pada mutasi manual tidak berlaku: otorisasi pengeluaran itu sendiri (D4, D9) menggantikannya. `reference` pada kedua mutasi adalah `EXP-XXXXXXXX` yang dibuat sistem, tidak pernah teks bebas pengeluaran.

### D6 — Mutasi `expense` mentah ditolak begitu fitur menyala

Jika kasir masih bisa `POST …/movements` dengan `movementType: "expense"`, ambang dan SoD di atas hanyalah hiasan. Maka selama fitur `expenses` tenant MENYALA, rute itu menjawab `409 EXPENSE_REQUIRES_EXPENSE_RECORD` untuk tipe `expense` (tipe lain tidak tersentuh); dengan fitur MATI — bawaan — perilaku ADR-0028 persis seperti saat dirilis.

### D7 — Struk adalah objek media privat di balik izinnya sendiri

Struk memakai ulang kelas `visibility = 'private'` pustaka media dan GET presigned (PR #278), dan tidak menambahkan apa pun ke pustaka media: objek dilampirkan dengan id, diselesaikan dari **pengeluaran** saat dibaca, tidak pernah dari id yang diberikan pemanggil. Penjaga, masing-masing terhadap penyalahgunaan yang berbeda:

- melampirkan memerlukan objek `private` terverifikasi **yang diunggah oleh pelampir** — jika tidak `commerce.expense_receipts.create` akan menjadi confused deputy yang membiarkan objek privat mana pun yang idnya bocor (PDF terlindungi produk, berkas rekan kerja) dilampirkan dan dibaca kembali;
- satu objek melayani **satu** pengeluaran (indeks UNIQUE parsial), dan objek yang menjaga unduhan produk ditolak;
- `GET …/receipt-url` memerlukan `commerce.expense_receipts.read`, yang **tidak** tersirat oleh `commerce.expenses.read` (struk dapat menampilkan nama orang atau nomor rekening) dan tidak dipenuhi oleh `media_library.media.download`; ia memverifikasi ulang setiap panggilan bahwa objek masih objek privat terverifikasi, gagal tertutup (objek publik-karena-kesalahan atau yang di-soft-delete tidak pernah ditandatangani), mengaudit setiap keputusan penerbitan yang menjangkau objek nyata lewat penulis `media.download` bersama, mengembalikan `Cache-Control: no-store`, dan memendekkan umur URL dengan batas TTL pustaka media yang ada;
- badan pengeluaran hanya mengekspos `hasReceipt`; id media dan kunci objek tidak pernah keluar lewatnya, dan CSV hanya membawa boolean itu.

**Lingkup karyawan.** Pengeluaran milik pembuatnya: mengedit atau membuang draf, dan melampirkan struk pada keadaan apa pun yang dapat dilampiri (draf, diposting, dibalik — jika tidak, siapa pun pemegang `receipts.create` dapat menempati satu-satunya slot struk pengeluaran yang diposting), diizinkan untuk pembuat atau supervisor (pemanggil yang juga memegang kunci approve, diselesaikan lewat chokepoint akses hanya bila perlu), tidak pernah untuk karyawan lain yang sekadar memegang `commerce.expenses.update` (`403 NOT_EXPENSE_OWNER`). Membaca tetap pada `commerce.expenses.read`.

### D8 — Payee adalah teks bebas; referensi pihak bertipe adalah penundaan yang terdokumentasi

Brief memilih referensi pihak/profil kanonik "jika ada di modul commerce". Tidak ada: ADR-0016 sengaja menjaga pelanggan di luar kosakata profil, dan master vendor adalah non-tujuan. `payee_name` karena itu teks bebas terbatas (120 karakter), diperlakukan seperti alasan: disamarkan dari audit dan event, tidak pernah diekspor ke ekspor data subjek. Ketika model pihak ada, kolom mendapat saudara bertipe pada migrasi berikutnya, sebagaimana ADR-0028 D10 lakukan untuk referensi mutasi.

### D9 — Dua belas izin yang dipisah per sumber daya, hanya kata kerja yang ada

`commerce.expense_categories.{read,create,update}`, `commerce.expenses.{read,create,update,export}`, `commerce.expense_postings.{create,approve}`, `commerce.expense_reversals.approve`, `commerce.expense_receipts.{read,create}`. Hanya kata kerja yang sudah ada di union `AccessAction` milik hulu — **tidak diperluas** — dan tidak ada yang tersirat oleh `commerce.register_sessions.update` atau `commerce.pos.create`: boleh menggerakkan kas di laci tidak memberi wewenang membukukan, menyetujui, atau membalik pengeluaran. `approve` (keputusan posting, pembalikan) dan `export` adalah kata kerja berisiko tinggi, sehingga tenant dapat menyusun aturan SoD terhadapnya. Tes `evaluateAccess` yang nyata dan tes tingkat rute dengan prinsipal yang disemai tepat satu kunci membuktikan setiap penolakan.

### D10 — Idempotensi, audit, event

Create, post, decide, reverse, dan cancel memerlukan `Idempotency-Key` (penyimpanan `awcms_idempotency_keys` bersama, hash terikat pada aktor dan sumber daya; dibaca **setelah** kunci baris sehingga percobaan ulang yang menunggu memutar ulang secara deterministik). Aksi audit `expense.create|update|cancel|submit|post|reject|reverse|receipt_attach` membawa uang, id, metode, dan keputusan — tidak pernah deskripsi, payee, catatan, atau alasan pembalikan (tes integrasi mencari semuanya di setiap baris audit dan payload event). Event `awcms.commerce.expense.{posted,reversed}` berjalan pada agregat `commerce.expense` dan terbit sekali, ketika status benar-benar berubah; terdaftar di `module.ts`, registri tipe event, dan AsyncAPI.

### D11 — Pelaporan dan ekspor

`GET …/expenses/summary?from&to` (read) mengembalikan total diposting dan dibalik per kategori dan per metode, ditambah jumlah draf dan tertunda, dalam sen yang tepat; pengeluaran yang dibalik dilaporkan di samping yang diposting, tidak pernah dinetralkan. `GET …/expenses/export.csv?from&to` (`commerce.expenses.export`) dinetralkan dari formula dengan helper CSV tutup kas itu sendiri (bukan salinan), dibatasi 366 hari dan 10.000 baris dengan header `X-Export-Truncated` eksplisit, dan `no-store`. Pengeluaran laci juga muncul pada laporan tutup kas shiftnya sebagai mutasi biasa — rekonsiliasi tidak memerlukan laporan baru.

### D12 — Flag fitur bawaan MATI; kompatibilitas aditif

`features.expenses` adalah flag kedua yang bawaannya MATI (setelah `register`): tenant yang tidak pernah membuka "Fitur" melihat toko hari ini. Pengeluaran yang dibayar dari laci juga memerlukan `features.register`. Dokumen pengaturan mendapat objek `expenses` tingkat atas (tanpa kenaikan `schemaVersion`, sama seperti `cashUp`). Baris, payload, hash, dan respons yang ada tidak berubah.

### D13 — Retensi dan data subjek

Kedua tabel adalah deskriptor `generic` hard-delete lantai lima tahun / batas sepuluh tahun yang dikunci pada `deleted_at` yang tidak pernah diisi (praktis tak terjangkau, seperti `commerce.orders`); deskriptor `subjectData` menamai stempel staf sebagai kolom `tenant_user` yang dipertahankan di bawah kewajiban fiskal dan menandai `description`, `payee_name`, `decision_note`, dan `reversal_reason` sebagai disamarkan.

## Konsekuensi

- Positif: pemilik dapat melihat untuk apa uang dikeluarkan, siapa yang mengizinkan, dan di mana struknya; pengeluaran laci direkonsiliasi sampai sen lewat tutup kas yang sudah ada; pembuat tidak dapat menyetujui pengeluarannya sendiri; kesalahan dibatalkan dengan baris penyeimbang, tidak pernah dengan menulis ulang shift yang ditutup; model dapat diserap modul keuangan di masa depan lewat adaptor.
- Biaya: jalur tulis ketiga yang berurutan kunci pada register (pengeluaran → sesi); dua tabel dan satu kolom; tenant yang menyalakan fitur harus mendefinisikan kategori sebelum apa pun dapat dicatat dan, dengan bawaan ketat, menetapkan ambang atau punya pemberi persetujuan kedua — pertukaran yang disengaja untuk toko satu pemilik yang didokumentasikan di layar; `appendRegisterMovement` kini kode bersama.
- Kompatibilitas: murni aditif. Fitur MATI adalah toko hari ini; satu-satunya perubahan perilaku pada ADR-0028 (D6) hanya berlaku dengan fitur MENYALA.

## Ditunda (sengaja tidak dibangun di sini)

Buku besar, utang usaha, vendor, pajak, anggaran, dan multi-mata-uang (non-tujuan); referensi payee/pihak bertipe (D8); lebih dari satu struk per pengeluaran dan kontrol unggah di layar pengeluaran (struk dilampirkan dengan id objek media, diunggah lewat API sesi unggah media dengan `visibility: "private"`); pengeluaran berulang; pengeluaran dari laci yang tidak termasuk sesi register mana pun (dibayar dari brankas dicatat sebagai pengeluaran non-laci); ambang persetujuan per kategori atau per register; proyeksi `expense` untuk dasbor (ringkasan adalah agregat langsung atas tabel berindeks); merutekan ambang lewat `workflow_approval` bila kelak ia memiliki port kapabilitas.
