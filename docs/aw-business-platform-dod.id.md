🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](aw-business-platform-dod.md)

<!-- i18n-source-hash: sha256:adcd80a27d42ccbdfaa2cb7c460c0b92b34217dadda2469dd0e4917506b68d82 -->

# AW Business Platform — penelusuran Definition of Done

Menelusuri 20 butir bagian 20 ("Definition of Done for this epic") dari epik [#280](https://github.com/ahliweb/awcms-one/issues/280), dinilai pada **11 November 2026** untuk isu [#397](https://github.com/ahliweb/awcms-one/issues/397). Epiknya sendiri ditutup pada 7 Oktober 2026, saat Definition of Ready tercapai; halaman ini menilai pengiriman hasil, dan mengganti pertanyaan terbuka "apakah DoD bisa dicentang?" dengan satu vonis per butir. Tidak ada butir yang dicentang hanya karena judul isunya: setiap vonis menyebut berkas, uji, atau catatan yang ada di pohon ini atau di pohon upstream yang disematkan (`apps/cms`).

"Upstream" berarti `ahliweb/awcms`; "di sini" berarti `ahliweb/awcms-one`. Repositori ini adalah templat ([ADR-0024](adr/0024-awcms-one-is-template-only-derived-apps-own-their-backend.md)): segala hal yang membutuhkan deployment nyata, tenant nyata, atau pelanggan nyata dimiliki produk turunan, bukan repositori ini.

## Kunci vonis

- **Met** (terpenuhi): bukti ada di repositori ini atau upstream.
- **Met for the template scope** (terpenuhi untuk lingkup templat): kewajiban sisi templat terpenuhi; sisanya milik produk turunan (ADR-0024), dan barisnya menyebut persis apa yang tersisa dan siapa pemiliknya.
- **Partial** (sebagian): sebagian butir belum ada, dan barisnya menyebut apa yang kurang.
- **Not met** (belum terpenuhi): butir belum selesai; barisnya menyebut alasan dan isu yang melacaknya.

## Ringkasan

| #   | Butir DoD (diringkas)                                            | Vonis                      |
| --- | ---------------------------------------------------------------- | -------------------------- |
| 1   | Setiap kapabilitas punya pemilik dan klasifikasi                 | Met                        |
| 2   | Tidak ada divergensi `awcms-one` yang tak disengaja              | Met                        |
| 3   | Otoritas pelanggan CRM dan relasi `profile_identity` tercatat    | Met                        |
| 4   | ADR admisi Booking dan pencegahan double-book                    | Met                        |
| 5   | Tidak ada mesin booking ganda permanen di konsumen               | Met for the template scope |
| 6   | Order, pembayaran, POS dipakai ulang dan teruji regresi          | Met                        |
| 7   | Batas invoice dan akuntansi eksplisit                            | Met                        |
| 8   | Identitas workforce merujuk party/profil kanonis                 | Met                        |
| 9   | Batas absensi, shift, komisi, payroll                            | Met for the template scope |
| 10  | Aturan payroll berlaku-efektif/berversi, bukan hard-code         | Partial                    |
| 11  | E-mail dan push dipakai ulang; WhatsApp dan Telegram tak ganda   | Partial                    |
| 12  | Analitik lewat proyeksi pelaporan, metrik terdefinisi            | Met                        |
| 13  | Model ancaman, privasi, ERD, matriks, spesifikasi, UX, migrasi   | Met                        |
| 14  | Kriteria Penerimaan ke uji otomatis dapat ditelusuri             | Partial                    |
| 15  | Ancaman/Risiko ke Kontrol ke uji keamanan dapat ditelusuri       | Partial                    |
| 16  | Keberlakuan UU PDP, PP PSTE, ketenagakerjaan-payroll, pembayaran | Met for the template scope |
| 17  | Pemetaan bukti ISO/IEC/OWASP/PCI, tanpa klaim tak berdasar       | Partial                    |
| 18  | Isu anak atomik dan sadar-dependensi                             | Met                        |
| 19  | Bukti staging, UAT, Go/No-Go, validasi produksi                  | Partial                    |
| 20  | Dokumen, cermin, graf pengetahuan, changelog, runbook sinkron    | Partial                    |

Tidak ada butir yang berstatus **Not met** mutlak. Tiga belas butir Met atau Met for the template scope; tujuh butir Partial. Pekerjaan terbuka ada di bagian "Yang tersisa" di akhir.

## Butir

### 1. Setiap kapabilitas punya pemilik dan klasifikasi eksplisit: Met

[ADR-0040](adr/0040-aw-business-platform-capability-ownership-and-boundaries.md) D2 adalah matriks reuse/extend/new yang divalidasi ulang terhadap pohon kode (tiap baris punya bukti, kelas, dan penempatan), D4 adalah ringkasan kepemilikan, dan D1 adalah aturan penempatan yang memilah tiap kapabilitas ke upstream-lebih-dulu, adapter awcms-one, atau keputusan pemilik. Kelasnya Reuse, Extend, Redesign, New, dan Deferred, sesuai permintaan epik. Matriks diperiksa silang butir demi butir di [pelacak DoR](aw-business-platform-dor.md) (tinjauan lintas-spesifikasi A9, isu [#339](https://github.com/ahliweb/awcms-one/issues/339)) dan pemilik menerimanya pada 8 Oktober 2026 ([#335](https://github.com/ahliweb/awcms-one/issues/335)).

### 2. Kapabilitas AWCMS generik bukan divergensi `awcms-one` yang tak disengaja: Met

Booking, HR workforce, HR commission, dan pengiriman WhatsApp dispesifikasikan dan dibangun **di upstream** (`awcms` ADR-0131 sampai ADR-0133, [Booking](../apps/cms/docs/awcms/booking.md), [HR dan payroll](../apps/cms/docs/awcms/hr-payroll.md)) lalu tiba di sini lewat sinkronisasi subtree (isu [#347](https://github.com/ahliweb/awcms-one/issues/347), [#409](https://github.com/ahliweb/awcms-one/issues/409), [#377](https://github.com/ahliweb/awcms-one/issues/377), [#424](https://github.com/ahliweb/awcms-one/issues/424), [#427](https://github.com/ahliweb/awcms-one/issues/427), [#452](https://github.com/ahliweb/awcms-one/issues/452)); `commerce` hanya menambah adapter di atas port upstream. Divergensi yang memang ada disengaja, didaftar satu per satu di [`AGENTS.md`](../AGENTS.md) ("Known local divergences") beserta aturan penyelesaiannya, dan dilacak untuk diusulkan ke upstream di [#420](https://github.com/ahliweb/awcms-one/issues/420). `apps/cms/tests/module-boundary.test.ts` dan `apps/cms/tests/commerce-migrations-range.test.ts` menjaga garis struktural (tidak ada modul yang mengimpor modul lain; migrasi commerce tetap di bandnya).

### 3. Otoritas pelanggan CRM dan relasi `profile_identity` ke depan: Met

Tercatat sebagai keputusan pemilik (O12): commerce tetap menjadi otoritas pelanggan dan tidak dibuat master pelanggan kedua (`crm_customer`), di [ADR-0040](adr/0040-aw-business-platform-capability-ownership-and-boundaries.md) D2/D5 dan [PRD](aw-business-platform-prd.md) bagian 1.1 dan 5. Harmonisasi pelanggan dengan `profile_identity` sengaja ditunda ke ADR expand/map/backfill tersendiri; itu bukan kekurangan butir ini. Aturan rujukan pelanggan untuk booking (pelanggan diturunkan lewat order yang tertaut) ada di [model data adapter booking-commerce](booking-commerce-adapter-data-model.md) dan [ADR-0045](adr/0045-booking-commerce-adapter.md).

### 4. Booking punya ADR admisi dan strategi pencegahan double-book yang terbukti: Met

`awcms` [ADR-0131](../apps/cms/docs/adr/0131-generic-booking-module-admission.md) upstream mengadmisi `booking` dan bagian 2-nya menaruh pencegahan double-booking di basis data: `EXCLUDE USING gist` atas unit sumber daya dan rentang waktu, dengan kedaluwarsa hold memakai jam basis data. [ADR-0135](../apps/cms/docs/adr/0135-day-granularity-stays-admitted-into-booking-v1.md) mengadmisi menginap berbutir hari. Buktinya dapat dijalankan: `apps/cms/tests/booking-allocation.test.ts`, serta suite konkurensi berbasis DB `apps/cms/tests/integration/booking-concurrency.integration.test.ts` dan `apps/cms/tests/integration/booking-stay.integration.test.ts` (yang juga membuktikan kasus "mendeteksi cacat" dengan menjatuhkan constraint). Adapter commerce tidak mengimplementasi ulang alokasi: [ADR-0045](adr/0045-booking-commerce-adapter.md) hanya memanggil `BookingPort`.

### 5. Implementasi booking spesifik konsumen tidak menjadi mesin ganda permanen: Met for the template scope

[ADR-0024](adr/0024-awcms-one-is-template-only-derived-apps-own-their-backend.md) dan `AGENTS.md` ("Template-only ownership rule") menyatakan bahwa kode booking vertikal tinggal di repositori konsumen dan hanya kapabilitas yang dinetralkan dan berversi yang dipromosikan. Mesin generiknya ada di upstream dan berversi (`BookingPort` 1.1.0 sejak sinkronisasi #427; `apps/cms/tests/booking-port-additions.test.ts`; [kontrak lintas-domain](../apps/cms/docs/awcms/cross-domain-contracts.md)), dan kosakata adapter tidak membawa kolom vertikal ([PRD](aw-business-platform-prd.md) bagian 3: "hotel" adalah skenario penerimaan, bukan kolom). Kode khusus IRMbyDUS dimiliki `ahliweb/web-irmbydus.com`, seperti dicatat `AGENTS.md` untuk isu #297. **Yang tersisa, dan pemiliknya:** migrasi kode booking tiap produk turunan ke modul `booking` upstream adalah rencana produk itu sendiri; repositori ini tidak dapat memverifikasinya.

### 6. Order/pembayaran/POS commerce tetap dipakai ulang dan teruji regresi: Met

Adapter duduk di atas buku besar yang ada, bukan di sampingnya: [ADR-0025](adr/0025-payments-are-an-allocation-ledger-separate-from-order-status.md) (pembayaran), [ADR-0041](adr/0041-gateway-deposit-sessions-and-mixed-tenders-on-one-order.md) (deposit dan tender campuran), [ADR-0028](adr/0028-pos-register-sessions-and-cash-up.md) (POS), [ADR-0033](adr/0033-returns-refunds-and-exchanges-are-additive-records-that-compensate-through-the-existing-ledgers.md) (retur). Cakupan regresinya berbasis DB: `apps/cms/tests/integration/commerce-orders.integration.test.ts`, `commerce-payment-allocations.integration.test.ts`, `commerce-payment-webhook.integration.test.ts`, `commerce-pos.integration.test.ts`, dan `commerce-returns.integration.test.ts` di direktori yang sama, ditambah seluruh leg `local-ci/check-cms` ([`docs/pengujian.md`](pengujian.md)). Tolok ukur beban dan konkurensi untuk jalur baru ada ([tolok ukur](benchmarks-commerce-load.md), isu [#395](https://github.com/ahliweb/awcms-one/issues/395)).

### 7. Batas invoice/akuntansi eksplisit: Met

[ADR-0040](adr/0040-aw-business-platform-capability-ownership-and-boundaries.md) D6 dan [ADR-0029](adr/0029-commerce-documents-are-separate-records-and-numbered-documents-are-immutable-order-snapshots.md) D1: kuitansi atau invoice komersial adalah snapshot order bernomor yang tak dapat diubah dan tidak menyimpan saldo; booking tidak pernah menerbitkan dokumen bernomor (order tertaut yang menerbitkannya); dokumen pajak fiskal di luar lingkup ([ADR-0039](adr/0039-commerce-tax-is-computed-by-the-tax-module-behind-a-per-tenant-mode.md) D6); invoice piutang tetap Deferred sampai domain keuangan ada di upstream. Pengeluaran juga lokal commerce ([ADR-0031](adr/0031-expenses-are-commerce-local-register-linked-petty-cash.md)).

### 8. Identitas karyawan workforce merujuk party/profil kanonis: Met

Desain upstream: employment menyimpan rujukan `profile_identity` dan tidak pernah menyalin nama, kontak, atau nomor identitas ([HR dan payroll](../apps/cms/docs/awcms/hr-payroll.md), bagian 3, foreign key komposit, "tidak ada kolom data pribadi di tabel HR mana pun"). Sudah dibangun: `hr_workforce` ada di registri (`sql/176`-`177`, `184`-`185`), dan `apps/cms/tests/payroll-data-boundary.test.ts` serta `apps/cms/tests/payroll-catalog-boundary-1077.test.ts` menjaga batasnya secara mekanis. ADR-0040 D3 mencatat arah dependensinya.

### 9. Batas absensi/shift/komisi/payroll ditentukan dan diotorisasi: Met for the template scope

Dispesifikasikan di upstream dalam [HR dan payroll](../apps/cms/docs/awcms/hr-payroll.md) dan ADR-0132, ADR-0136 (pemisahan tugas yang dapat dikonfigurasi, bawaan tiga arah), ADR-0137 (rekening pembayaran dienkripsi dan di-hash berkunci), ADR-0138 (geolokasi: hanya vonis, mati secara bawaan); diotorisasi oleh model izin dan ABAC yang tercatat di paket yang sama, dan oleh [ADR-0046](adr/0046-commission-attribution-adapter-reports-paid-counter-sales-to-the-hr-commission-ledger.md) untuk satu-satunya tempat `commerce` menyentuh buku besar komisi (penjualan kasir yang lunas, dengan pembalikan). Gerbang batas payroll (`payroll:sql-boundary:check`, `sensitive-reads:check`) berjalan di `bun run check:cms`; `apps/cms/tests/commerce-commission-boundary.test.ts` dan `apps/cms/tests/commerce-commission-attribution.test.ts` mengunci sisi adapter. **Yang tersisa:** `hr_payroll` sendiri belum diadmisi ke registri; admisi, pembangunan, dan tinjauan privasi data payroll-nya milik upstream (paket desain, [ahliweb/awcms#916](https://github.com/ahliweb/awcms/issues/916)) lalu milik deployment payroll tiap produk turunan.

### 10. Aturan regulasi payroll berlaku-efektif/berversi: Partial

Selesai: aturan komisi adalah data berversi dengan evaluasi murni (`hr_commission` upstream, [HR dan payroll](../apps/cms/docs/awcms/hr-payroll.md) bagian 6), dan syarat kerja berlaku-efektif dan hanya-tambah (bagian 4.1). Model aturan payroll (bagian 7.3: aturan netral yurisdiksi, data aturan berlaku-efektif, bukan konstanta templat) **dispesifikasikan**, dan model ancaman mencatat instrumen yang berlaku sebagai masukan. **Kurang:** payroll baru berupa desain, sehingga belum ada tabel versi aturan atau perhitungan pajak yang dapat diuji mandiri untuk ditunjuk. Pemilik: `hr_payroll` upstream (fase 3), dengan profil payroll Indonesia sebagai keputusan data aturan milik konsumen atau upstream (jawaban pemilik O4, tercatat di paket). Tidak ada aturan payroll yang di-hard-code di repositori ini.

### 11. E-mail/push dipakai ulang; migrasi WhatsApp dan Telegram tidak menggandakan pengiriman: Partial

Dipakai ulang: e-mail lewat outbox upstream ([ADR-0034](adr/0034-commercial-documents-are-delivered-through-the-existing-outboxes-as-transactional-messages-built-from-immutable-sources.md)); Web Push pelanggan dibangun di atas modul `push_delivery` upstream ([ADR-0048](adr/0048-customer-web-push-identity-subscription-and-cross-origin-contract.md), isu #430 sampai #432, `apps/cms/tests/commerce-customer-push.test.ts`, `apps/cms/tests/commerce-customer-push-fanout.test.ts`); WhatsApp pindah ke antrean upstream lewat router mode per tenant ([ADR-0047](adr/0047-commerce-whatsapp-moves-to-the-upstream-queue-through-a-per-tenant-mode-router.md), fase 2 dan 3 dibangun, `apps/cms/tests/commerce-whatsapp-upstream-boundary.test.ts`); Telegram adalah adapter upstream khusus peringatan staf (ADR-0140) dan orkestrasi lintas-kanal tidak diadmisi (ADR-0139). **Kurang:** fase 4, penghapusan outbox WhatsApp milik commerce dan jalur legacy, terbuka sebagai [#394](https://github.com/ahliweb/awcms-one/issues/394); sampai saat itu antrean kedua ada secara sengaja. [ADR-0054](adr/0054-the-adr-0133-whatsapp-legacy-path-backstop-moves-to-v0-22-0.md) menetapkan batas akhir: penghapusan paling lambat v0.22.0. Tindak lanjut CRM omnichannel (#458 sampai #461, #463, #464, #466) terblokir isu upstream yang masih terbuka dan bukan bagian butir ini.

### 12. Analitik memakai proyeksi pelaporan dengan metrik terdefinisi formal: Met

Kontrak metrik untuk pendapatan, okupansi, utilisasi, retensi, dan produktivitas karyawan: [metrik](aw-business-platform-metrics.md). Implementasinya di mesin pelaporan, bukan penyimpanan paralel: [ADR-0035](adr/0035-pos-operational-reports-are-commerce-projections-over-the-existing-ledgers-on-the-reporting-engine.md) (laporan POS), [ADR-0044](adr/0044-customer-retention-is-a-per-customer-recompute-projection-on-the-reporting-engine.md) (retensi), irisan pendapatan booking ([#389](https://github.com/ahliweb/awcms-one/issues/389), [#478](https://github.com/ahliweb/awcms-one/issues/478); `apps/cms/tests/commerce-booking-revenue-domain.test.ts`), ADR-0143 upstream, dan [metrik workforce](../apps/cms/docs/awcms/workforce-metrics.md).

### 13. Model ancaman, privasi, ERD, matriks, spesifikasi domain, kontrak, UX, dan rencana migrasi lengkap: Met

Kesepuluh artefak DoR tercatat terpenuhi atau dikecualikan eksplisit di [pelacak DoR](aw-business-platform-dor.md): [model ancaman dan analisis privasi](aw-business-platform-threat-model.md), [ERD dan kamus data](booking-commerce-adapter-data-model.md), [matriks RBAC/ABAC/RLS](booking-commerce-access-matrix.md), [draf OpenAPI/AsyncAPI](booking-commerce-adapter-contracts.md) (draf; jalur yang aktif ada di `apps/cms/openapi/modules/commerce.openapi.yaml`), [UX](booking-ux-flows.md) (ditambah [UI/UX omnichannel](omnichannel-crm-ui-ux.md)), PRD, dan metrik. Rencana migrasinya adalah [ADR-0037](adr/0037-the-commerce-migration-band-is-allocated-gap-first-and-widened-upstream.md) dan aturan band di `AGENTS.md`, ditegakkan `apps/cms/tests/commerce-migrations-range.test.ts`. Tiga sisa yang dikecualikan pemilik pada 11 Oktober 2026 (R1 sampai R3) tercatat di sana beserta alasannya.

### 14. Kriteria Penerimaan ke uji otomatis dapat ditelusuri: Partial

Tiap isu anak membawa kriteria penerimaannya, dan tiap fitur yang dikirim punya uji unit dan uji integrasi berbasis DB yang dinamai sesuai fiturnya (misalnya `apps/cms/tests/integration/commerce-booking-hold-to-order.integration.test.ts` untuk #380). PRD ([hasil terukur, bagian 7](aw-business-platform-prd.md)) mendefinisikan luarannya. **Kurang:** belum ada satu matriks yang memetakan tiap cerita atau kriteria PRD ke berkas ujinya; pemetaannya ada di teks isu dan PR serta nama uji. Pemilik: repositori ini, tindak lanjut khusus dokumen; bukan penghalang rilis.

### 15. Ancaman/Risiko ke Kontrol ke uji regresi keamanan dapat ditelusuri: Partial

Model ancaman punya tabel STRIDE per alur F1 sampai F11 dan tabel kontrol C-01 sampai C-41 ([model ancaman](aw-business-platform-threat-model.md) bagian 4 dan 7), dan kontrak adapter memuat bagian [ketertelusuran kontrol](booking-commerce-adapter-contracts.md). Uji mengutip kontrolnya: C-05 sampai C-12 dan C-25 sampai C-41 muncul di berkas uji (misalnya `apps/cms/tests/commerce-booking-cancellation-domain.test.ts`, `apps/cms/tests/commerce-segment-contract.test.ts`, `apps/cms/tests/commerce-gateway-deposit-domain.test.ts`). **Kurang:** teks bagian 7 sendiri masih menyebut setiap baris "planned" dan menamai uji "planned"; tabelnya tidak pernah disegarkan ke status terimplementasi, dan C-01 sampai C-04 serta C-13 sampai C-24 tidak dikutip uji mana pun, sehingga tautan maju (kontrol ke uji) tidak lengkap di dokumen meski ujinya ada. Pemilik: repositori ini, penyegaran tabel itu yang khusus dokumen.

### 16. Keberlakuan UU PDP / PP PSTE / ketenagakerjaan-payroll / pembayaran terdokumentasi: Met for the template scope

[Model ancaman](aw-business-platform-threat-model.md) bagian 6 mendaftar UU 27/2022 (PDP), PP 71/2019, PP 49/2025, PMK 168/2023, PBI 10/2025, dan PADG 32/2025 beserta alur yang mungkin tersentuh, hal yang belum diketahui, dan tindakannya; bagian 5 adalah analisis privasi (peran hukum per deployment, minimisasi, retensi, kait hak subjek data); upstream menambah [analisis privasi](../apps/cms/docs/awcms/privacy-analysis.md). Dokumen itu menyatakan di baris awalnya bahwa ini bukan nasihat hukum dan tidak mengklaim kepatuhan, dan bahwa daftarnya tidak diverifikasi ulang terhadap instrumennya. **Yang tersisa, dan pemiliknya:** kontrol C-24, tinjauan penasihat hukum untuk lingkup produksi nyata, milik operator tiap produk turunan; hal yang sama berlaku untuk tinjauan penasihat hukum atas kata-kata persetujuan Web Push pelanggan di ADR-0048 D8.

### 17. Kontrol ISO/IEC/OWASP/PCI yang berlaku punya pemetaan bukti; tanpa klaim tak berdasar: Partial

Tidak ada klaim "patuh" atau "tersertifikasi" di mana pun (model ancaman menyebut standar sebagai "target pemetaan, bukan klaim"; [`SECURITY.md`](../SECURITY.md) tidak mengklaim apa pun). Pemetaan ada: upstream memetakan OWASP ASVS dan ISO/IEC 27001 Annex A ke permukaan kode ([pemetaan standar](../apps/cms/docs/awcms/standar-performa-dan-keamanan.md)); [ADR-0048](adr/0048-customer-web-push-identity-subscription-and-cross-origin-contract.md) memuat tabel per-instrumen untuk Web Push pelanggan; tabel kontrol model ancaman punya kolom Bukti dan desain halaman pembayaran yang di-host menjaga cakupan PCI tetap minimal (alur F2). **Kurang:** peta bukti per-standar untuk adapter booking, komisi, segmen, dan mode WhatsApp dalam format bagian 14 epik. Pemilik: repositori ini, khusus dokumen, setelah tabel kontrol pada butir 15 disegarkan.

### 18. Isu implementasi anak atomik dan sadar-dependensi: Met

54 isu Wave C sampai F dibuat pada 11 Oktober 2026 dengan graf dependensi dan repositori tujuan masing-masing ([pelacak DoR](aw-business-platform-dor.md), "Generated Wave C to F issues"), setelah gerbang ADR-0040 D7 terpenuhi. Isu Wave B khusus commerce (#360 sampai #364) mendahuluinya. Rantai Booking #378 sampai #396 sudah digabung di sini beserta adapter komisi (#391); sisa yang terblokir upstream dilacak di [#420](https://github.com/ahliweb/awcms-one/issues/420).

### 19. Bukti staging/UAT/Go-No-Go/validasi produksi ada untuk gelombang yang dikirim: Partial

Validasi tingkat templat ada: setiap penggabungan butuh kedua belas leg `local-ci/*` hijau pada SHA persisnya ([`docs/pengujian.md`](pengujian.md), ADR-0021), suite integrasi berbasis DB berjalan pada PostgreSQL nyata yang termigrasi, latihan pemulihan dengan rekonsiliasi ada untuk tabel adapter booking (isu [#396](https://github.com/ahliweb/awcms-one/issues/396), `apps/cms/tests/commerce-booking-restore-drill.test.ts`), dan tolok ukur di atas. **Kurang, dan memang tidak di sini:** staging, UAT, catatan Go/No-Go, dan validasi produksi untuk deployment nyata, yang milik produk turunan yang menjalankannya (ADR-0024: repositori ini tidak boleh menampung tenant produksi sebuah produk). **Kurang dan milik templat:** gerbang produksi Web Push pelanggan di ADR-0048 D8 (tinjauan penasihat hukum atas kata-kata persetujuan, pasangan VAPID nyata dan matriks uji operator, UAT perangkat pada aplikasi iPhone terpasang, Chrome Android, dan desktop) belum dijalankan, dan flag `customerPush` tetap mati secara bawaan (lihat [`docs/status.md`](status.md)). [Matriks uji operator](../apps/cms/docs/awcms/push-notifications-test-matrix.md) adalah prosedurnya.

### 20. Dokumentasi, cermin Indonesia, graf pengetahuan, changelog/changeset, runbook sinkron: Partial

Selesai: setiap dokumen tata kelola di sini punya cermin Indonesianya (`audit:translation`), graf pengetahuan akar disegarkan untuk rilis v0.20.0, [`CHANGELOG.md`](../CHANGELOG.md) dan `.changesets/` mutakhir (`bun run release` menghasilkan v0.20.0 dan `audit:rilis` hijau), dan runbooknya adalah [deployment](deployment.md), [rilis](rilis.md), dan [pengujian](pengujian.md), termasuk prosedur cutover ADR-0047. **Kurang, ditemukan saat menulis halaman ini dan di luar cakupannya:** butir terakhir "Not here yet" di [`docs/status.md`](status.md) masih menyebut epik #280 "architecture-only" dengan "no implementation landed", yang sudah tidak benar; dan tabel kontrol model ancaman (butir 15) usang. Pemilik: repositori ini; masing-masing perubahan kecil khusus dokumen. Halaman ini dan changeset-nya adalah bagian #397 dari butir tersebut.

## Yang tersisa

| Apa                                                                                                  | Butir      | Pemilik dan pelacakan                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hapus jalur legacy WhatsApp commerce (fase 4), paling lambat v0.22.0                                 | 11         | Repositori ini, [#394](https://github.com/ahliweb/awcms-one/issues/394), [ADR-0054](adr/0054-the-adr-0133-whatsapp-legacy-path-backstop-moves-to-v0-22-0.md) |
| Admisi `hr_payroll` dan versi aturan payroll                                                         | 9, 10      | Upstream, paket desain [ahliweb/awcms#916](https://github.com/ahliweb/awcms/issues/916)                                                                      |
| Gerbang produksi Web Push pelanggan (penasihat hukum, penyedia nyata, UAT perangkat), per deployment | 16, 19     | Produk turunan yang menyalakan `customerPush` (ADR-0048 D8)                                                                                                  |
| Tinjauan penasihat hukum atas catatan regulasi untuk lingkup nyata (C-24)                            | 16         | Operator produk turunan                                                                                                                                      |
| Staging, UAT, Go/No-Go, dan validasi produksi                                                        | 19         | Produk turunan yang melakukan deployment (ADR-0024)                                                                                                          |
| Matriks penerimaan-ke-uji; segarkan tabel kontrol model ancaman; peta standar                        | 14, 15, 17 | Repositori ini, tindak lanjut khusus dokumen                                                                                                                 |
| Segarkan butir epik `docs/status.md` yang usang                                                      | 20         | Repositori ini, khusus dokumen                                                                                                                               |
| Isu #388 dan #430 sampai #432 sudah digabung di cabang integrasi tetapi masih terbuka di GitHub      | 18         | Tutup saat cabang itu mendarat di `main`                                                                                                                     |
| Butir CRM omnichannel (#458 sampai #461, #463, #464, #466)                                           | tidak ada  | Terblokir isu upstream yang terbuka; bukan bagian DoD ini                                                                                                    |

Rilis dapat dibuat dengan `bun run release`: satu-satunya syarat adalah backlog changeset dan `audit:rilis`, dan keduanya tidak bergantung pada butir di atas.
