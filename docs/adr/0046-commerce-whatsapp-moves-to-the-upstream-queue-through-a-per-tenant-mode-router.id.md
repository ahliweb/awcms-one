🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0046-commerce-whatsapp-moves-to-the-upstream-queue-through-a-per-tenant-mode-router.md)

<!-- i18n-source-hash: sha256:428a1aae4267b99e5b5e67be2b472493583f72e843bd9aba8111f7bb92756315 -->

# ADR-0046 — WhatsApp commerce pindah ke antrean upstream lewat router mode per tenant

- **Status:** Accepted
- **Tanggal:** 14 Oktober 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** issue [#392](https://github.com/ahliweb/awcms-one/issues/392) (ADR ini dan fase 2), [#393](https://github.com/ahliweb/awcms-one/issues/393) (flip terjaga dan laporan pengosongan, fase 3), epik [#280](https://github.com/ahliweb/awcms-one/issues/280) butir 31; ADR-0133 upstream bagian 6 (fase dan kondisi akhir) di `apps/cms/docs/adr/`; [ADR-0017](0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md) D5 (outbox milik commerce yang dipensiunkan), [ADR-0034](0034-commercial-documents-are-delivered-through-the-existing-outboxes-as-transactional-messages-built-from-immutable-sources.md) (pengiriman dokumen), [ADR-0038](0038-commerce-stock-is-a-write-through-cache-of-the-inventory-ledger.md) (bentuk mode per tenant yang sama untuk stok), [ADR-0037](0037-the-commerce-migration-band-is-allocated-gap-first-and-widened-upstream.md) (nomor migrasi)

## Konteks

Upstream mempromosikan pengiriman WhatsApp menjadi modul generik, `whatsapp_delivery` (ADR-0133, disinkronkan oleh #409): satu antrean per kanal, tiga kelas tujuan, penyimpanan consent, suppression, kedaluwarsa untuk pesan keamanan, dan `WhatsappDeliveryPort`. Commerce masih memiliki antrean kedua, `awcms_commerce_whatsapp_messages`, dengan provider, dispatcher, dan purge sendiri. ADR-0133 bagian 6 fase 2 meminta adapter kompatibilitas dan mode per tenant yang memilih ke mana pesan **baru** pergi, tanpa dual write dan tanpa menyalin baris, serta kondisi akhir bertanggal yang menghapus adapter.

## Keputusan

**D1 — `enqueueWhatsappMessage` menjadi router mode; signaturnya tidak berubah.** `application/whatsapp-enqueue.ts` membaca mode tenant lalu memanggil penulis legacy (`whatsapp-enqueue-legacy.ts`, fungsi lama dipindah tanpa perubahan) atau adapter upstream (`whatsapp-upstream-enqueue.ts`, `WhatsappDeliveryPort.enqueue` dalam transaksi pemanggil). Empat pemanggil (OTP pelanggan, pesanan dibayar, kampanye, pengiriman dokumen) hanya mengimpor router. Ditolak: satu fungsi dengan `if` di dalamnya (jalur upstream tidak dapat dibuktikan bebas dari tabel legacy), dan fungsi publik kedua (semua pemanggil harus berubah).

**D2 — Mode adalah dua kolom pada `awcms_commerce_store_settings` (`sql/1027`).** `whatsapp_mode` (`legacy` default, `upstream`) dan `whatsapp_mode_changed_at`, bentuk yang diberikan ADR-0038 pada `inventory_mode`: kolom, bukan jsonb pengaturan, agar "reset toko" oleh pemilik tidak memindahkan tenant antar antrean; `resetStoreSettings` kini juga mempertahankan baris tetap hidup selama mode `upstream`, sehingga purge retensi tidak dapat menghapusnya. Tenant tanpa baris pengaturan adalah `legacy`. Ditolak: tabel baru (satu baris yang harus konsisten dengan baris pengaturan untuk satu nilai) dan variabel lingkungan (menurut ADR ini per tenant, bukan per deployment).

**D3 — Mode dibaca di bawah advisory lock bersama; tidak ada penulis dalam perubahan ini.** `resolveWhatsappMode` mengambil `pg_advisory_xact_lock_shared` sebelum membaca, sehingga jawabannya tidak berubah di tengah transaksi. `lockWhatsappModeExclusive` adalah titik sambung untuk #393: flip mengambilnya, menolak selama antrean legacy memiliki baris non-terminal (`queued`, `sending`, `retry_wait`), melakukan upsert baris pengaturan, menulis kolom, dan mengaudit. #392 hanya mengatur kolom dalam pengujian, lewat SQL.

**D4 — `legacy` identik byte demi byte.** INSERT, kolom, dan nilai yang sama; field input baru yang opsional `idempotencyKey` diabaikan olehnya. Dikunci oleh uji unit tingkat pernyataan dan uji integrasi tingkat baris. Satu-satunya pekerjaan tambahan pada mode legacy adalah satu lock dan satu `SELECT` mode per enqueue, dan satu `SELECT` untuk ketersediaan kanal.

**D5 — `upstream` memetakan setiap pesan ke template terdaftar.** `commerce.customer_otp` adalah `security` (variabel rahasia `code`, `expiresAt` = sekarang ditambah masa berlaku kode itu sendiri), `commerce.order_paid` dan `commerce.document` adalah `transactional`, `commerce.campaign` adalah `marketing`. Redaksi dan daftar variabel adalah milik registri legacy, dibaca lewat satu accessor, sehingga kedua mode tidak dapat berbeda. Penerima adalah alamat (pelanggan commerce tidak memiliki profil `profile_identity`). Correlation id adalah milik pemanggil. Penolakan atau suppression dikembalikan sebagai `enqueued: false` dengan alasan, tidak pernah dilempar.

**D6 — Kunci idempotensi berasal dari identitas pemanggil, dan OTP tidak memilikinya.** Penerima kampanye adalah `campaign:<campaignId>:<customerId>` dan pengiriman dokumen `document:<deliveryId>`, berawalan `commerce:`. Jalur legacy tidak pernah punya kunci, jadi identitasnya adalah yang menjadi unik pada tabelnya sendiri. OTP pelanggan mendapat kunci baru setiap panggilan: pemutaran ulang akan mengirim kode sebelumnya untuk kode yang baru. Correlation id dispatch kampanye berlaku per run, bukan per kampanye, sehingga tidak bisa menjadi identitas.

**D7 — Ketersediaan kanal dan pembacaan status mengikuti mode.** `legacy` menanyakan `COMMERCE_WHATSAPP_ENABLED`; `upstream` menanyakan `WHATSAPP_ENABLED`, karena masing-masing adalah gerbang yang dipatuhi dispatcher-nya. Resolver kanal OTP mengembalikan kanal yang mencari mode saat kirim, sehingga adapter `log` legacy (yang mencetak kode) tidak pernah dipakai untuk tenant `upstream`. Riwayat pengiriman dokumen membaca tabel legacy dahulu lalu antrean, lewat port, untuk id yang tidak ditemukan. Pengiriman dokumen yang tidak masuk antrean dicatat dengan dua nilai `failure_reason` yang diizinkan CHECK-nya (sisi penerima: `RECIPIENT_SUPPRESSED`; sisi pengirim: `TEMPLATE_UNAVAILABLE`).

**D8 — Pendaftaran template adalah berkas side-effect tanpa dependensi, dan proses dispatch butuh satu impor.** `domain/whatsapp-upstream-templates.ts` mendaftarkan template dengan `registerWhatsappTemplate`; `module.ts` mengimpornya untuk server CMS. Proses `whatsapp:dispatch` tidak mengimpor modul apa pun dan upstream tidak menyediakan pendaftaran yang dideklarasikan descriptor, sehingga tanpanya setiap pesan commerce gagal sebagai `template_unknown`. `apps/cms/scripts/whatsapp-dispatch.ts` membawa satu impor side-effect (divergensi tercatat di `AGENTS.md`, bentuk sama dengan yang e-mail). Sisi `commerce -> whatsapp_delivery` adalah entri `capabilities.consumes` (opsional), bukan `dependencies`, sehingga mengaktifkan commerce tidak mewajibkan tenant mengaktifkan `whatsapp_delivery`.

**D9 — Uji pertama kondisi akhir sudah ada sekarang.** `apps/cms/tests/commerce-whatsapp-upstream-boundary.test.ts` gagal jika berkas di jalur upstream menyebut tabel, provider, dispatcher, atau penulis legacy, jika pemanggil commerce mencapai WhatsApp tidak lewat router, atau jika berkas di luar daftar izin pendek menyebut tabel legacy. Saat jalur legacy dihapus, daftar izin menjadi kosong dan aturannya menjadi redaksi ADR-0133 upstream `awcms`.

## Celah yang harus diterima tenant sebelum #393 mem-flip-nya

Ini adalah sifat antrean upstream, ditemukan saat membangun adapter, dan tidak ada yang diperbaiki di sini (milik upstream atau #393):

1. **Consent pemasaran tidak dijembatani.** Penerima kampanye butuh opt-in tercatat di penyimpanan consent `whatsapp_delivery`; `marketing_consent_at` commerce tidak disalin ke sana. Tenant yang di-flip tanpa mengimpor nomor yang opt-in tidak mengirim kampanye WhatsApp (setiap penerima `skipped`). Runbook #393 harus menyebutnya.
2. **Variabel satu baris dan dibatasi 1.000 karakter.** Renderer upstream meratakan pemisah baris dalam variabel dan memotongnya, sehingga isi dokumen yang panjang dan multi-baris (struk) atau isi kampanye diratakan atau terpotong. Butuh opsi template upstream sebelum tenant yang bergantung pada dokumen panjang di-flip.
3. **Meta butuh identitas template provider.** Template commerce tidak membawa satu pun; dengan `WHATSAPP_PROVIDER=meta` gagal secara terminal (tidak pernah teks bebas). Fonnte dan `log` tidak terpengaruh.
4. **Batas laju berbeda.** Upstream membatasi penerima 10 pesan per jam (5 untuk `security`) dan tenant 2.000.
5. **Belum ada pemanggil `order_paid`.** Template terdaftar dan router melayaninya; tidak ada yang mengirimnya dari commerce saat ini.

## Konsekuensi

- Fase 2 dapat dirilis dengan semua tenant di `legacy`; tidak ada yang teramati berubah sampai kolom sebuah tenant diatur.
- Batas akhir ADR-0133 upstream `awcms` (adapter dihapus selambat-lambatnya pada rilis minor kedua setelah rilis yang pertama kali memuat mode `upstream`) dimulai dengan rilis perubahan ini.
- Dua layar admin, `commerce:whatsapp:dispatch`, dan `commerce:whatsapp:purge` tetap ada dan terus mengosongkan baris legacy.
