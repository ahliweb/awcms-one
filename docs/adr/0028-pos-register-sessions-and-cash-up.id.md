🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0028-pos-register-sessions-and-cash-up.md)

<!-- i18n-source-hash: sha256:d90800e43096aa769da29c16d89cc0bc7b2882d17669c2ea9658b2c8cb734c22 -->

<!-- i18n-source-hash: sha256:placeholder -->

# ADR-0028 — Sesi register POS dan tutup kas: jumlah yang seharusnya DITURUNKAN dari ledger pembayaran, shift yang sudah ditutup tidak dapat diubah

- **Status:** Diterima
- **Tanggal:** 3 Oktober 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** [ADR-0025](0025-payments-are-an-allocation-ledger-separate-from-order-status.md) (ledger alokasi pembayaran yang menjadi dasar ADR ini); [ADR-0003](0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md) (uang); [ADR-0015](0015-commerce-migrations-live-in-the-reserved-9xx-range.md) (rentang migrasi); [ADR-0017](0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md) (POS); issue [#284](https://github.com/ahliweb/awcms-one/issues/284) di bawah epic [#281](https://github.com/ahliweb/awcms-one/issues/281).

## Konteks

POS sampai sekarang mencatat penjualan dan melunasinya (ADR-0025), tetapi tidak ada yang menjawab pertanyaan yang diajukan setiap pemilik kasir di akhir shift: *apakah laci berisi sebanyak seharusnya?* Tidak ada register, tidak ada shift, tidak ada modal awal, tidak ada catatan uang tunai yang masuk ke brankas atau keluar untuk membeli es, sehingga tidak ada tutup kas. Epic #281 membangun model penjualan satu-ledger; ADR ini adalah bagian penanganan uang tunainya dan memakai ulang ledger pembayaran alih-alih menyimpan kumpulan total kedua.

## Keputusan

### D1 — Enam tabel, masing-masing satu tujuan (`sql/970`)

`awcms_commerce_registers` (kasir bernama: `code`, `name`, label lokasi opsional, `active`), `…_register_sessions` (satu shift: modal awal, kasir saat ini, `status` `open | closing | closed | corrected`), `…_register_movements` (mutasi laci append-only), `…_register_close_requests` (satu baris per percobaan penutupan: selisih, alasan, keputusan persetujuan), `…_register_close_lines` (snapshot seharusnya / dihitung / selisih per metode untuk satu percobaan) dan `…_register_corrections` (baris kompensasi pasca-penutupan). Setiap tabel FORCE RLS dengan `WITH CHECK`, memakai FK komposit `(tenant_id, …)` yang ditopang `UNIQUE (tenant_id, id)`, dan menyimpan uang sebagai `numeric(14,2)`. Staf adalah stempel uuid tenant-user biasa (bukan FK — catatan fiskal harus melampaui akun yang menghasilkannya).

### D2 — Jumlah yang seharusnya DITURUNKAN dari ledger pembayaran, lewat stempel, bukan jendela waktu

Untuk sebuah sesi, `seharusnya(tunai) = modal awal + Σ leg pembayaran tunai berhasil − Σ leg pembalikan tunai berhasil + Σ mutasi masuk − Σ mutasi keluar` dan `seharusnya(metode lain) = Σ pembayaran berhasil − Σ pembalikan berhasil metode itu` (`amount` leg tunai adalah jumlah yang DITERAPKAN, kembalian sudah dikeluarkan — ADR-0025 D5 — sehingga aritmetika laci persis). Leg yang dihitung adalah leg yang DISTEMPEL dengan sesi itu (`sql/971`: `awcms_commerce_payment_allocations.register_session_id`, dibekukan oleh trigger append-only). Sebuah leg distempel ketika pesanannya membawa sesi DAN sesi itu masih `open` pada saat leg ditulis (`application/register-session-stamp.ts`): tender POS, tetapi juga sisa tagihan yang dibayar kemudian di konter atau refund tunai yang dicatat selama shift. Tidak ada yang ditulis ulang — penjualan dan leg-nya ditulis persis seperti sebelumnya, ditambah satu uuid, sehingga tutup kas tidak pernah bisa mengubah penjualan atau pembayaran.

Mengapa bukan "leg yang dibuat antara `opened_at` dan `closed_at`": `created_at` sebuah leg adalah waktu mulai TRANSAKSI-nya, sehingga penjualan yang dimulai sesaat sebelum sesi dibuka (dan melihatnya terbuka setelah commit), atau yang dimulai sesaat sebelum penutupan, jatuh di sisi jendela yang salah. Stempel yang ditulis di bawah kunci baris sesi persis menurut konstruksi. Angka yang seharusnya di-SNAPSHOT sekali pada baris penutupan, sehingga angka sesi yang sudah ditutup adalah bukti, bukan kueri yang bisa dijalankan ulang terhadap data yang telah bergeser.

### D3 — Satu sesi aktif per register, dan tiga mode kunci pada baris sesi

Indeks UNIQUE parsial `(tenant_id, register_id) WHERE status IN ('open', 'closing')` adalah jaminan mekanisnya; pembukaan juga mengunci baris REGISTER (`FOR NO KEY UPDATE`), sehingga dua pembukaan yang benar-benar bersamaan berjalan serial dan yang kalah mendapat `409 REGISTER_SESSION_ALREADY_OPEN` yang bersih alih-alih pelanggaran unik. Penjualan, mutasi, dan leg yang distempel mengunci sesi `FOR SHARE` (banyak sekaligus); serah terima, penutupan, persetujuan, dan koreksi mengunci `FOR NO KEY UPDATE` — eksklusif terhadap setiap pemegang kunci bersama dan satu sama lain, tetapi, tidak seperti `FOR UPDATE`, kompatibel dengan `FOR KEY SHARE` yang diambil insert FK pada baris sesi (deadlock yang dicatat ADR-0025 D4, dihindari di sini menurut konstruksi). Setiap mutasi berlingkup sesi mengunci DULU dan membaca store idempotensi SETELAH kunci, sehingga percobaan ulang yang menunggu permintaan pertama memutar ulang catatan yang sudah di-commit secara deterministik.

### D4 — Alur penutupan, dan ambang pada selisih KOTOR

Kasir saat ini (`commerce.register_cash_ups.create`) menghitung laci per metode; body hanya membawa apa yang DIHITUNG. Hitungan wajib untuk tunai dan setiap metode yang punya aktivitas ledger. Selisih **kotor** — jumlah selisih MUTLAK per metode — dibandingkan dengan pengaturan tenant `cashUp.approvalThreshold` (pengaturan modul commerce, default `"0.00"`: selisih sekecil apa pun perlu supervisor; dibaca defensif, nilai rusak kembali ke default ketat): di dalamnya permintaan menjadi `auto` dan sesi `closed`; di atasnya, penutup yang juga memegang `commerce.register_cash_ups.approve` menutupnya satu langkah (`approved`, oleh dirinya), dan yang tidak memegangnya membiarkan sesi `closing` dengan permintaan `pending` yang tidak menerima penjualan, mutasi, atau penutupan kedua sampai penyetuju memutuskan (`approve` → `closed`; `reject`, dengan catatan wajib → kembali `open`, permintaan yang ditolak disimpan sebagai riwayat, percobaan berikutnya n+1). Kotor, bukan bersih, agar kelebihan tunai tidak dapat menyembunyikan kekurangan QRIS dengan saling menghapus menjadi nol. `varianceReason` wajib setiap kali ada metode yang selisih. Selisih bersih dan kotor, ambang yang berlaku, dan keputusan semuanya disimpan pada permintaan.

### D5 — Sesi yang sudah ditutup tidak dapat diubah; koreksi adalah baris kompensasi

Trigger membekukan setiap kolom sesi `closed`/`corrected` kecuali satu transisi `closed → corrected`; mutasi, baris penutupan, dan koreksi append-only (trigger menolak UPDATE, `awcms_app` kehilangan UPDATE dan DELETE), permintaan penutupan hanya berubah `pending → approved | rejected`, dan setiap tabel register kehilangan `DELETE` untuk `awcms_app` (hanya worker retensi yang boleh menghapus, melewati batas sepuluh tahun — `sql/973`; `security-readiness.ts` menegaskan himpunan hak istimewa yang persis di kedua arah). Koreksi (`commerce.register_corrections.approve`) menambahkan penyesuaian bertanda per metode pada jumlah yang DIHITUNG; permintaan dan baris asli tetap utuh, angka terkoreksi adalah angka asli ditambah jumlah koreksinya (tidak pernah negatif), dan sesi menjadi `corrected`. Aktivitas ledger yang terlambat — sisa tagihan yang dibayar pada penjualan sesi yang sudah ditutup — dicatat di ledger dan TIDAK distempel, sehingga tidak pernah dapat mengubah tutup kas yang sudah ditutup; ia juga tidak dilebur diam-diam (lihat Ditunda).

### D6 — Integrasi POS: penjualan distempel, sebuah gerbang, dan flag fitur opt-in yang default MATI

Pesanan POS mendapat `register_session_id` (`sql/971`; hanya pesanan `pos` yang boleh membawanya — CHECK; diset sekali saat insert, tidak pernah berubah; trigger menolak melekatkan ke sesi yang tidak terbuka bahkan untuk penulis yang melewati gerbang aplikasi). Flag fitur `commerce` `register` (`domain/commerce-features.ts`) adalah satu-satunya flag yang default MATI: ia menambah kewajiban, sehingga tenant yang tidak pernah membuka "Fitur" harus melihat POS yang persis sama seperti hari ini. Saat NYALA, `POST /api/v1/commerce/pos/orders` mensyaratkan `registerId` dan register itu harus punya sesi `open` yang kasir saat ini-nya adalah pelaku (`400` / `404` / `409 REGISTER_SESSION_REQUIRED | REGISTER_SESSION_CLOSING | NOT_SESSION_CASHIER`, semuanya sebelum apa pun ditulis; sesi kemudian dikunci `FOR SHARE` selama sisa transaksi penjualan). Saat MATI tidak ada yang distempel dan penjualan sama persis seperti sebelumnya — dan menyebut `registerId` ditolak (`409 FEATURE_DISABLED`) alih-alih diabaikan diam-diam, sehingga penjualan tidak pernah tampak terlekat padahal tidak. `registerId` masuk hash idempotensi hanya bila ada, sehingga payload lama tetap dapat diputar ulang melewati deploy. Seluruh permukaan register digerbangi flag itu (`409 FEATURE_DISABLED` pada rute pemilik).

### D7 — Izin: sepuluh kunci, verba yang sudah ada, tidak ada yang tersirat dari `commerce.pos.create`

`commerce.registers.{read,create,update}`, `commerce.register_sessions.{read,create,update,export}` (buka = `create`, pakai = `update`), `commerce.register_cash_ups.{create,approve}` (tutup, setujui selisih) dan `commerce.register_corrections.approve`. Hanya verba yang sudah ada di union `AccessAction` milik upstream (alasan verba `reverse` ADR-0025 D9, lagi); `approve` dan `export` berisiko tinggi, sehingga tenant boleh menyusun aturan SoD atasnya (mis. "kasir yang menghitung tidak boleh menyetujui"). Mutasi, penjualan, dan penutupan adalah milik kasir SAAT INI; serah terima diizinkan bagi kasir saat ini atau supervisor pemegang kunci approve (dicek di handler, lewat chokepoint, hanya bila perlu). Kasir yang memegang persis kunci shift diizinkan di setiap rute shift dan ditolak untuk persetujuan, koreksi, ekspor CSV, dan administrasi register — dibuktikan oleh tes `evaluateAccess` yang nyata dan oleh tes tingkat rute dengan prinsipal yang di-seed hanya dengan kunci itu.

### D8 — Idempotensi, audit, dan event

Buka, mutasi, serah terima, penutupan, keputusan penutupan, dan koreksi mensyaratkan `Idempotency-Key` (store bersama `awcms_idempotency_keys`, hash terikat pada pelaku dan sumber daya; baris mutasi, permintaan penutupan, dan koreksi juga membawa `source_key` unik sendiri). Aksi audit `register.create|update` dan `register_session.open|movement|handover|close_requested|close|close_rejected|correct` membawa uang, tipe, dan id — tidak pernah teks bebas. Event `awcms.commerce.register_session.{opened, movement_recorded, closed, corrected}` berjalan pada agregat SESI (`commerce.register_session`); `closed` dipicu sekali, hanya ketika sesi benar-benar mencapai `closed`. Terdaftar di `module.ts`, registri tipe event, dan AsyncAPI.

### D9 — Laporan dan CSV

`GET …/register-sessions/{id}` mengembalikan laporan tutup kas: modal awal, jumlah/total penjualan, pembayaran / pembalikan / seharusnya / dihitung / selisih per metode (koreksi diterapkan di atasnya, aslinya tidak tersentuh), mutasi, riwayat penutupan, koreksi; langsung saat open/closing, snapshot tersimpan setelah ditutup. `GET …/report.csv` (`commerce.register_sessions.export`) menserialisasikannya dalam satu berkas bersekat; setiap sel dinetralkan dari formula spreadsheet (`domain/register-cash-up-csv.ts`: awalan `=`, `+`, `-`, `@`, tab, atau carriage return diberi awalan `'`; jumlah yang benar-benar numerik mempertahankan tandanya) dan tidak ada data pelanggan yang muncul.

### D10 — Referensi pengeluaran adalah kait bertipe, bukan kolom yang menunjuk ke ketiadaan

Mutasi `expense` membutuhkan `reference`, teks bebas saat ini. `reference_kind` (CHECK `IN ('free_text')`) adalah kait bertipenya: domain pengeluaran (#294) belum ada, dan kolom id yang merujuk tabel yang belum ada adalah klaim, bukan fitur (disiplin yang diterapkan ADR-0025 pada `store_credit`/`gift_card`). Migrasi yang mengirimkan tabel pengeluaran melebarkan CHECK dan menambah kolom id.

### D11 — Referensi aman-tenant, siklus hidup, data subjek

Semua referensi adalah FK komposit; dua induk (`registers`, `sessions`) membawa `deleted_at` yang hanya ada sebagai kolom kursor mesin retensi dan tidak pernah diset (bentuk `commerce.orders` — praktis tidak terjangkau, yang juga menjaga FK anak append-only dari purge yang akan menjadikannya yatim); empat tabel append-only berkursor `created_at` (batas bawah lima tahun, batas atas sepuluh tahun). Deskriptor `subjectData` menamai stempel staf sebagai kolom `tenant_user`, dipertahankan di bawah kewajiban fiskal; catatan/alasan teks bebas tidak pernah diekspor.

## Konsekuensi

- Positif: pemilik kasir bisa merekonsiliasi shift sampai ke sen dari baris yang tidak bisa diedit; tutup kas membaca ledger yang sama dengan setiap laporan pembayaran lain, sehingga tidak ada kumpulan total kedua yang bisa menyimpang; penjualan tidak pernah bisa mendarat di sesi yang sudah dihitung; persetujuan supervisor adalah konsekuensi mekanis dari ambang yang ditetapkan tenant, bukan konvensi.
- Biaya: mode kunci kedua dan satu kunci baris per penjualan pada jalur register (`FOR SHARE` pada satu baris sesi — hanya diperebutkan oleh penutupan atau serah terima, keduanya jarang); kolom nullable pada `awcms_commerce_orders` dan pada ledger; tenant yang menyalakan fitur harus mendefinisikan register dan membuka sesi sebelum kasir bisa mencatat penjualan (itulah maksudnya, dan opt-in); enam tabel.
- Kompatibilitas: murni aditif. Fitur MATI adalah POS hari ini; payload, hash, dan respons yang ada tidak berubah kecuali `registerSessionId` aditif pada 201 POS.

## Ditunda (sengaja tidak dibangun di sini)

Domain pengeluaran (#294) dan referensi pengeluaran bertipe (D10); aktivitas ledger yang terlambat pada penjualan sesi yang sudah ditutup yang ditampilkan sebagai angka "dicatat setelah penutupan" di laporan (saat ini ada di ledger, tidak distempel, dan di luar semua tutup kas); tautan pasangan antara mutasi transfer-keluar dan transfer-masuk di dua register; hitung buta (layar menampilkan seharusnya di samping dihitung, sebagaimana diminta issue); override ambang per register dan ambang per metode; pemilih kasir untuk serah terima (formulir menerima id tenant-user — pemilih membutuhkan direktori staf yang tidak diberikan izin commerce); penghitungan pecahan (lembar/koin); operasi offline; proyeksi tutup kas untuk dasbor (laporan adalah agregat langsung atas tabel berindeks).
