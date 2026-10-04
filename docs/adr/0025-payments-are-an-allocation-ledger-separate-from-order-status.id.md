🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0025-payments-are-an-allocation-ledger-separate-from-order-status.md)

<!-- i18n-source-hash: sha256:22779efec58e0d87aac112bbefa4f21658057db0533d156435bc611a78347b4c -->

# ADR-0025 — Pembayaran adalah ledger alokasi append-only, terpisah dari status pesanan

- **Status:** Diterima
- **Tanggal:** 3 Oktober 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** [ADR-0003](0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md) (uang); [ADR-0010](0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.md) dan [ADR-0017](0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md) (payment gateway, POS, tidak ada panggilan provider di dalam transaksi); [ADR-0015](0015-commerce-migrations-live-in-the-reserved-9xx-range.md) (rentang migrasi); issue [#285](https://github.com/ahliweb/awcms-one/issues/285) di bawah epic [#281](https://github.com/ahliweb/awcms-one/issues/281).

## Konteks

Sampai sekarang pembayaran sebuah pesanan hanyalah satu fakta: `payment_method` (apa yang dikatakan pelanggan akan dipakai) dan satu sumbu `payment_status` yang ditimpa mesin status pesanan menjadi `paid` begitu `pending_payment -> paid` berjalan. Itu tidak bisa menyatakan "Rp 60.000 tunai dan Rp 40.000 QRIS", "Rp 50.000 dibayar, sisanya tagihan", atau "Rp 20.000 darinya dikembalikan", dan membiarkan tiga jalur yang tidak berhubungan (konfirmasi transfer storefront yang diterima, webhook Midtrans, tender POS) masing-masing memutuskan "lunas" dengan caranya sendiri — konfirmasi Rp 1 yang diterima memindahkan pesanan Rp 100.000 ke `paid`. Epic #281 membangun model penjualan satu-ledger (poin loyalti dan nilai kartu hadiah adalah ledger terpisah); ADR ini adalah bagian pembayarannya dan fondasi yang dipakai ulang oleh pekerjaan loyalti/kartu hadiah/refund.

## Keputusan

### D1 — Satu tabel append-only, `awcms_commerce_payment_allocations`, dan penyelesaian DITURUNKAN

Setiap leg tender dan setiap pembalikan kompensasi adalah satu baris (`sql/940`): `kind` (`payment` | `reversal`), `tender_type` (`cash`, `manual_qris`, `manual_bank_transfer`, `gateway`), `amount numeric(14,2) > 0` (jumlah yang DITERAPKAN ke pesanan), `status` (`pending` | `succeeded` | `failed`), provider/referensi provider, `tendered_amount`/`change_amount` tunai, `source`, `actor`, dan `(tenant_id, source_key)` yang unik. Penyelesaian adalah `Σ pembayaran berhasil − Σ pembalikan berhasil`; `outstanding = max(0, total − settled)`. **Tidak ada saldo berjalan yang disimpan**, jadi saldo tidak bisa menyimpang dari baris yang membenarkannya. `awcms_commerce_orders.payment_status` tetap ada, sebagai CACHE dari turunan itu (`unpaid | partially_paid | dp_paid | paid | refunded`), ditulis ulang dalam transaksi yang sama dengan setiap penulisan ledger agar filter admin dan pembacaan storefront yang ada tetap berbentuk satu kolom.

`store_credit`/`gift_card` sengaja tidak ada di CHECK tender: ledger-nya (#288/#289) belum ada, dan nilai yang tidak bisa ditulis jalur kode mana pun adalah klaim, bukan fitur. Migrasi yang mengirimkan penulis pertamanya melebarkan constraint itu.

### D2 — Append-only itu mekanis, bukan konvensi

`awcms_app` kehilangan `DELETE` (`REVOKE`, karena `sql/019` memberi keempat verb secara default — preseden `sql/125`; `security-readiness.ts` menegaskan himpunan grant yang persis di kedua arah). Trigger `BEFORE UPDATE` membekukan setiap kolom kecuali satu transisi sah: leg gateway `pending` yang diselesaikan menjadi `succeeded`/`failed` (+ `settled_at`). Jumlah, tender, referensi, atau aktor tidak pernah bisa diedit; koreksi adalah baris `reversal` BARU yang menunjuk pembayaran yang dikompensasinya, dibatasi sebesar jumlah pembayaran itu. Hanya `awcms_worker` yang mempertahankan `DELETE`, untuk batas sepuluh tahun mesin data-lifecycle (`commerce.payment_allocations`, batas bawah lima tahun).

### D3 — Status pembayaran independen dari siklus hidup pesanan; siklus hidup bergerak lewat satu mesin yang sudah ada

Pesanan mencapai `paid` tepat ketika penyelesaian mencapai **ambang rilis**-nya: total — atau, untuk pesanan uang muka (`payment_method = 'dp'`, `dp_amount < total`), uang mukanya, yang persis dilakukan alur sebelum ledger (konfirmasi pertama yang diterima merilis pesanan) tanpa pengampunan diam-diam atas sisanya (kini `dp_paid` dengan jumlah terutang yang eksplisit). Transisinya TIDAK di-fork: ledger diberi callback rilis yang merupakan closure atas `transitionOrderStatus` milik `order-directory.ts` (timestamp status, `order_events`, audit, event `order.paid`/`order.status_changed` adalah yang sudah dihasilkan setiap jalur). **Pembalikan tidak pernah memundurkan siklus hidup** — ia menurunkan penyelesaian dan menurunkan ulang `payment_status`; membatalkan fulfilment karena uang kembali tetap keputusan manusia (sikap refund yang sudah ada di `domain/order-status.ts`). Konsekuensi: `PATCH .../status -> paid` manual dari admin ditolak dengan `409 PAYMENT_NOT_SETTLED` sampai ledger menyatakannya — "lunas" tidak lagi bisa diklaim tanpa uang yang tercatat. Ini perubahan perilaku yang disengaja, dinyatakan di changeset.

### D4 — Konkurensi: kunci baris pesanan, `FOR NO KEY UPDATE`

Setiap penulis ledger pertama-tama mengunci baris pesanan, lalu membaca ledger, memvalidasi, menyisipkan, menghitung ulang — dengan urutan itu di mana-mana (tanpa deadlock antar penulis). Dua alokasi final yang bersamaan berjalan serial; yang kedua melihat yang pertama dan gagal pada pemeriksaan kelebihan bayar-nya sendiri, sehingga pesanan tidak pernah bisa kelebihan penyelesaian atau dirilis dua kali. Kuncinya `FOR NO KEY UPDATE`, **bukan** `FOR UPDATE`: insert anak dengan FK ke pesanan (baris `payment_events`, baris ledger) mengambil `FOR KEY SHARE`, yang bentrok dengan `FOR UPDATE` — tes webhook yang benar-benar konkuren menemukan deadlock-nya (pengiriman A memegang baris sesi gateway dan menunggu pesanan; pengiriman B memegang key-share pada pesanan dan menunggu sesi). `source_key` yang unik adalah penjaga kedua yang independen.

### D5 — Kelebihan bayar ditolak, kecuali kembalian tunai; kembalian hanya dari leg tunai

`planTenders` di `domain/payment-allocation.ts` mengurangkan setiap tender non-tunai dari jumlah terutang lebih dulu, lalu menerapkan tunai pada sisanya: `kembalian = diserahkan − diterapkan`, tidak pernah negatif. Tender yang kurang adalah kekurangan (`409 INSUFFICIENT_TENDER`), tidak pernah disembunyikan di balik kembalian tender lain; tender non-tunai yang jumlahnya melebihi total adalah `409 OVERPAYMENT`; tender tunai ketika tidak ada lagi yang harus dibayar ditolak (kembalian dari udara kosong). CHECK tabel menjadikan `tendered = amount + change` invarian baris. **Pengecualian, dicatat bukan disembunyikan:** leg gateway yang dikonfirmasi pihak luar (provider sudah menangkap uangnya) dicatat meskipun pesanan dibatalkan/kedaluwarsa/sudah lunas — kelebihannya muncul sebagai `overpaid` untuk dikembalikan operator lewat pembalikan, bukan dibuang diam-diam. Konfirmasi transfer manual yang diterima dibatasi pada jumlah terutang (batasnya ditulis di `note` baris), bukan alasan menolak penerimaan.

### D6 — Idempotensi dalam dua lapisan independen

Store `awcms_idempotency_keys` bersama memberi semantik replay/konflik HTTP (`commerce.payments.record`, `.reverse`, `commerce.pos.create`; hash mengikat aktor dan id sumber daya, sehingga kasir lain atau pesanan lain tidak pernah bisa me-replay responsnya). `source_key` milik ledger sendiri mencakup jalur tanpa kunci klien: `gateway:{provider}:{ref}` (replay webhook, pengiriman ulang dengan event key baru, atau job reconcile yang berlomba dengan webhook semuanya menemukan leg sudah `succeeded`), `confirmation:{id}`, `api:{key}`, `reversal:{key}`, `pos:{key}:{n}`, `backfill:{order id}`.

### D7 — Leg gateway pending sampai dikonfirmasi; tidak ada panggilan provider yang masuk ke transaksi

`createGatewaySession` membuka leg `pending` di transaksi persist-nya (setelah panggilan provider kembali); hasil webhook/reconcile yang terverifikasi menyelesaikannya menjadi `succeeded` (atau sesi `failed`/`expired` menyelesaikannya menjadi `failed`). Leg pending tidak dihitung dan tidak memicu event. Refund gateway TIDAK dibalik otomatis (keputusan "refunded tidak menggerakkan pesanan" yang sudah ada); operator mencatat pembalikannya. Tidak ada kode di ADR ini yang membuat panggilan provider/jaringan sama sekali: pembalikan adalah fakta pembukuan, mengembalikan uang adalah tindakan operator. Tender gateway tidak bisa diketik staf (`POST .../payments` menerima `cash`, `manual_qris`, `manual_bank_transfer`). Penjaga jumlah gateway tetap mensyaratkan `gross_amount` provider sama dengan total pesanan, sehingga sesi gateway saat ini selalu menagih seluruh total — mencampur leg gateway dengan tender lain pada satu pesanan ditunda.

### D8 — POS: payload legacy diadaptasi, `tenders[]` eksplisit, saldo terutang berizin (kontrak versi 2)

`POST /api/v1/commerce/pos/orders` menerima SALAH SATU `payment: { method, amountTendered }` legacy — diadaptasi menjadi tepat satu leg ledger dengan aritmetika dan error yang sama, hash idempotensinya identik byte-per-byte dengan sebelumnya — ATAU `tenders[]` eksplisit (tidak pernah keduanya). `amount` tender non-tunai = diterapkan; `amount` tender tunai (tunggal) = diserahkan. `allowDue: true` (memerlukan `tenders[]`, nomor telepon pelanggan — baris walk-in tidak bisa ditagih — dan izin TERPISAH `commerce.pos_due.create`, dicek di handler lewat chokepoint yang sama selain `commerce.pos.create`) memungkinkan penjualan difinalisasi dengan saldo terutang: tetap `pending_payment`, `payment_status` `unpaid`/`partially_paid`, `expires_at NULL` (job kedaluwarsa tidak pernah mengambil kembali stok penjualan kasir), dengan `settlement.outstanding` eksplisit, dan endpoint pembayaran sisi-pemilik melunasinya kemudian. 201 mendapat `payments[]` (setiap tender, untuk struk) dan `settlement`; `change`/`amountTendered` mempertahankan arti legacy-nya. `orders.payment_method` menjadi petunjuk ringkasan legacy (tender dengan jumlah diterapkan terbesar); ledger adalah kebenarannya. OpenAPI mendokumentasikan ini sebagai aditif: klien versi 1 tidak terpengaruh, tidak ada yang dihapus.

### D9 — Izin dan event

`commerce.payments.read | create | revoke` (+ `commerce.pos_due.create`). Pembalikan memakai verb RISIKO-TINGGI platform yang sudah ada, `revoke`, alih-alih menambah `reverse` ke union `AccessAction` milik upstream: mengeluarkan uang tercatat dari pembukuan persis untuk itulah himpunan risiko-tinggi (dan aturan SoD yang boleh disusun tenant) ada. Event `awcms.commerce.payment.recorded` / `.payment.reversed` berjalan pada agregat PESANAN (satu aliran berurutan per pesanan), membawa id/tender/jumlah/penyelesaian hasilnya dan tidak pernah nama/telepon pelanggan atau referensi pembayaran; leg pending dan backfill tidak memicunya. Audit `payment.record` / `payment.reverse`.

### D10 — Pelaporan membaca ledger langsung

`GET /api/v1/reports/commerce/tender-mix` (pembayaran, pembalikan, neto per tender pada rentang hari laporan `Asia/Jakarta`, dikaitkan ke hari saat setiap leg dicatat) dan `.../outstanding-balances` (pesanan yang masih terutang, diturunkan ulang dari ledger, jumlah/total atas SEMUA yang cocok) adalah agregat langsung atas tabel append-only terindeks — tanpa proyeksi kedua yang bisa menyimpang atau perlu direkonsiliasi. Bila volume kelak menuntut, proyeksi bisa ditambahkan di balik rute yang sama. Layar detail pesanan dan POS menampilkan angka turunan yang sama.

### D11 — Expand → backfill

`sql/943` menulis SATU leg `backfill` deterministik per pesanan yang sudah lunas (`ON CONFLICT DO NOTHING`, dilewati untuk pesanan yang punya baris ledger, timestamp = `paid_at` pesanan itu sendiri, bukan `now()`), merekonstruksi tender dari `payment_method` (gateway dari `gateway_provider/ref`) dan, untuk satu bentuk legacy di mana "lunas" tidak pernah berarti lunas penuh (pesanan uang muka), jumlah konfirmasi yang diterima dibatasi pada total (atau `dp_amount`) — mengoreksi status cache pesanan itu menjadi `dp_paid`. Ia tidak mengarang kembalian tunai dan tidak mengumumkan apa pun.

### D12 — Referensi aman-tenant

Kedua referensi adalah FK komposit pada `(tenant_id, …)` (`UNIQUE (tenant_id, id)` pada tabel alokasi dan pada `awcms_commerce_orders`), plus RLS FORCE dengan `WITH CHECK`. Rute pemilik me-resolve pesanan dan pembayaran dengan lingkup tenant DAN pesanan: pesanan tenant lain, pembayaran yang tidak dikenal, dan pembayaran milik pesanan berbeda adalah `404` yang sama (tanpa oracle BOLA).

## Konsekuensi

- Positif: pembayaran terbagi/terutang/dikembalikan bisa dinyatakan dan persis; "lunas" diturunkan dan tidak bisa diklaim tanpa uang tercatat; setiap pembayaran teraudit, idempoten, dan aman-replay; laporan tidak butuh angka karangan; pekerjaan loyalti/kartu hadiah/refund punya bentuk ledger untuk ditiru.
- Biaya: konfirmasi transfer manual yang diterima untuk kurang dari total tidak lagi menandai pesanan lunas (saldo eksplisit); override `-> paid` manual pada pesanan yang sudah punya leg ledger tetapi belum lunas ditolak (catat pembayarannya), sedangkan pada pesanan tanpa leg sama sekali ia mencatat sendiri satu leg manual senilai penuh (lihat "Perubahan perilaku" di bawah); pesanan yang memegang uang yang sudah diterima tidak pernah dikadaluarsakan oleh job kedaluwarsa dan tidak ditawari sesi gateway; satu kunci baris `FOR NO KEY UPDATE` tambahan per penulisan pembayaran; laporan adalah agregat langsung (dibatasi indeks `(tenant_id, created_at)`, proyeksi adalah jalan keluarnya).
- Kompatibilitas: payload POS dan storefront single-tender legacy tetap bekerja; `payment_status` mendapat `partially_paid` (field OpenAPI berupa string biasa; label admin diperluas).

## Perubahan perilaku (perbaikan tinjauan)

- **`PATCH .../status -> paid` manual.** Diputuskan di bawah kunci baris pesanan (`FOR NO KEY UPDATE`, urutan kunci yang sama dengan setiap penulis): pesanan TANPA leg ledger sama sekali (tenant COD / offline yang tidak pernah memakai ledger) mendapat SATU leg berhasil senilai total penuh, sumber `admin`, kunci sumber `status-paid:{order id}` (replay tidak berefek), diaudit seperti pembayaran lain, dengan tender diambil dari `payment_method` pesanan (`cash`, `manual_qris`, `gateway` dengan provider `legacy` seperti backfill `sql/943`, selain itu `manual_bank_transfer`), lalu ledger merilis pesanan menjadi `paid`; pesanan DENGAN leg yang belum lunas tetap `409 PAYMENT_NOT_SETTLED` beserta jumlah terutang. Tidak perlu migrasi (jenis tender yang ada sudah cukup; `sql/944` tetap tak terpakai).
- **Sesi gateway menolak pesanan yang sudah dibayar sebagian.** Sesi hosted-checkout menagih seluruh total pesanan, sehingga `createGatewaySession` tidak membuat maupun mengembalikan sesi bila `settled > 0`: `409 ORDER_PARTIALLY_SETTLED` dengan `details.outstanding`. Pemeriksaan diulang di transaksi persist (pembayaran bisa masuk saat panggilan provider berjalan). Leg gateway jumlah-parsial tetap ditunda; sisanya diselesaikan dengan tender manual.
- **Kedaluwarsa tidak pernah menelantarkan uang yang diterima.** `listExpirableOrderIds` melewati, dan `expireOrderBySystem` memeriksa ulang di bawah kunci pesanan, setiap pesanan dengan `settled > 0`: tidak dikadaluarsakan dan tidak di-restock, serta tetap ada di laporan saldo terutang agar operator menyelesaikan atau membatalkannya.
- **Konflik kunci sumber.** `source_key` ledger yang ditemukan pada pesanan yang sama hanya replay bila permintaannya SAMA (tender, serta jumlah atau tunai yang diserahkan untuk pembayaran; pembayaran yang dibalik dan jumlahnya untuk pembalikan). Kunci yang sudah dipakai untuk pesanan lain, atau permintaan berbeda, adalah `AllocationSourceKeyConflictError`, dipetakan ke `409 IDEMPOTENCY_CONFLICT` oleh rute pembayaran, pembalikan, dan POS.

## Ditunda (sengaja tidak dibangun di sini)

Tender kredit toko / kartu hadiah (#288/#289); refund provider otomatis dan perubahan pesanan/fulfilment yang digerakkan refund; leg gateway untuk kurang dari seluruh total (sesi jumlah-parsial, yang juga memerlukan penjaga jumlah membandingkan dengan saldo terutang); proyeksi tender-mix; "saldo terutang" yang menghadap pelanggan di halaman pesanan storefront; rekonsiliasi laci-kas/shift per tender.
