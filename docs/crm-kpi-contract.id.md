🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](crm-kpi-contract.md)

<!-- i18n-source-hash: sha256:a1d99475b796cd8de758365c5018c8c4d8573c5e0f60c5a77698e5664743a496 -->

<!-- i18n-source-hash: sha256:0 -->

# Kontrak KPI CRM — funnel lead, konversi, atribusi kampanye dan SLA staf (v1.0.0-draft, menunggu persetujuan pemilik)

> **Klasifikasi:** **spesifikasi dan artefak gerbang 9 (Definition of Ready)**, **bukan implementasi**. Tidak ada proyeksi, migrasi, endpoint, layar, atau path OpenAPI untuk apa pun di bawah ini, dan bentuk respons di bagian 10 adalah **usulan terdokumentasi yang sengaja tidak dimasukkan ke dokumen OpenAPI**. Kebenaran implementasi ada di [status.md](status.id.md). Pelacakan: [#464](https://github.com/ahliweb/awcms-one/issues/464); standar: [`crm-omnichannel-requirements.md`](crm-omnichannel-requirements.id.md) (CRM-010 sampai CRM-013, CRM-034, CRM-070 sampai CRM-073, AT-06, AT-08 sampai AT-10). Posisi **14 November 2026**.

**Mengapa dokumen ini ada.** Pada alur produk v2 ([`AGENTS.md`](../AGENTS.id.md), "Product development flow v2.0.0") layar tanpa sumber data yang telah diterima belum siap. CRM-013 mewajibkan setiap KPI mendefinisikan otoritas event, pembilang dan penyebut yang tepat, zona waktu, jendela, kunci dedup, lookback atribusi, dan perilaku data tak dikenal. Issue #464 melarang klaim kode sebelum kontrak diterima. Dokumen ini adalah kontrak itu; **daftar periksa persetujuan pemilik di bagian 11 adalah gerbangnya**. Sebelum pemilik mencentang setiap butir di sana, tidak ada deskriptor proyeksi, rute, atau dasbor yang ditulis.

**Memakai ulang, bukan menggantikan:** aturan metrik di [`aw-business-platform-metrics.md`](aw-business-platform-metrics.id.md) bagian 1.1 (satu penyimpanan analitik, penghitung hanya naik, bucket hari `Asia/Jakarta` secara bawaan, instan UTC, detail diotorisasi ulang, jendela restatement 35 hari), aturan kelompok kecil segmen dari [ADR-0042](adr/0042-crm-segments-are-immutable-versioned-closed-vocabulary-rules-evaluated-on-demand.id.md) D6, dan fakta konversi commerce terverifikasi dari [ADR-0056](adr/0056-crm-lead-link-confirms-a-prospect-as-a-commerce-customer-only-from-verified-commerce-facts.id.md) (issue #463).

## 1. Versi kontrak ini

- Kontrak memiliki versi semantik. **`1.0.0-draft` adalah teks ini; menjadi `1.0.0` hanya setelah pemilik menuntaskan bagian 11.** Perubahan definisi apa pun (pembilang, penyebut, jendela, lookback, ambang penekanan, dimensi) adalah **versi minor atau mayor baru**, tidak pernah suntingan di tempat; menambah KPI adalah minor, mengubah makna KPI yang ada adalah mayor.
- Setiap baris proyeksi dan setiap respons API **mencatat `contractVersion` yang dipakai menghitungnya**. Pembangunan ulang di bawah versi baru menulis himpunan baris baru dan membiarkan himpunan lama terbaca selama jendela restatement, sehingga tren tidak pernah didefinisikan ulang diam-diam.
- Lookback atribusi (bagian 5), kebijakan jam kerja (bagian 6), dan ambang penekanan (bagian 7) adalah **parameter berversi dari kontrak**, bukan opsi bebas per permintaan; API menggemakan nilai yang berlaku.
- Produk turunan boleh menambah KPI atau memperketat parameter di repositorinya sendiri (ADR-0024); ia tidak boleh melonggarkan aturan privasi bagian 7 atau 8.

## 2. Otoritas event

KPI dihitung **hanya** dari fakta yang sudah di-commit sebuah modul. Tidak ada KPI yang membaca frame websocket sementara, tanda terima penyedia sebagai bukti hasil manusiawi, atau kolom teks bebas.

| Fakta                                                                                     | Otoritas                                        | Event atau catatan                                                                                                                          | Waktu kejadian dan pencatatan (kolom persisnya)                                                                                      |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Lead diterima, sentuhan sumber pertama                                                    | `crm_leads`                                     | `awcms.crm_leads.lead.created` (sentuhan pertama tak berubah)                                                                               | `occurredAt` payload (bucket), `recordedAt` payload                                                                                  |
| Tahap dicapai, tahap ditinggalkan                                                         | `crm_leads`                                     | `awcms.crm_leads.lead.stage_changed` (menyebut revisi pipeline), ditambah transisi `stage_migrated`                                         | `occurredAt` payload (bucket), `recordedAt` payload                                                                                  |
| Pemilik ditetapkan pada lead                                                              | `crm_leads`                                     | `awcms.crm_leads.lead.assigned`                                                                                                             | `assignedAt` payload (bucket dan urutan); payload tanpa `recordedAt`, sehingga kolom amplop `recorded_at` pada `awcms_domain_events` |
| Lead hilang                                                                               | `crm_leads`                                     | `awcms.crm_leads.lead.lost` (tanpa alasan: alasan adalah teks bebas dan tidak pernah keluar dari `crm_leads`)                               | tidak dipakai untuk funnel (lihat 3.2); `occurredAt` payload, tanpa `recordedAt`, sehingga kolom amplop `recorded_at`                |
| Lead digabung atau penggabungan dibatalkan                                                | `crm_leads`                                     | `awcms.crm_leads.lead.merged`, `awcms.crm_leads.lead.merge_reverted`                                                                        | `mergedAt` / `revertedAt` payload (`undoUntil` bukan waktu fakta); tanpa `recordedAt`, sehingga kolom amplop `recorded_at`           |
| Konversi dikonfirmasi atau dibalik                                                        | `crm_leads` (sisi CRM), `commerce` (sisi bukti) | `awcms.crm_leads.lead.converted`, `awcms.crm_leads.lead.conversion_reversed`                                                                | `occurredAt` payload (bucket), `recordedAt` payload                                                                                  |
| Registrasi pelanggan terverifikasi                                                        | `commerce`                                      | `awcms.commerce.customer.registered` (hanya registrasi terverifikasi OTP; checkout tamu tidak pernah menerbitkan)                           | payload tanpa kolom waktu: kolom amplop `occurred_at` dan `recorded_at` baris `awcms_domain_events`                                  |
| Fakta konversi commerce terverifikasi                                                     | `commerce`                                      | `awcms.commerce.customer.converted` (membawa `evidenceKind`, `orderId` buram, `firstSourceKind`, `firstTouchId`)                            | payload tanpa kolom waktu: kolom amplop `occurred_at` dan `recorded_at` baris `awcms_domain_events`                                  |
| Status tautan (`linked`, `reversal_pending`, `reversed`) untuk eksposur `reversalPending` | `commerce`                                      | kolom `state` pada `awcms_commerce_crm_lead_links` (penanda hanya meng-UPDATE baris; **tidak ada event**), dibaca langsung sebagai snapshot | bukan event; `asOf` pembacaan                                                                                                        |
| Pesanan dibayar, dibatalkan, di-refund penuh (nilai konversi dan koreksi)                 | `commerce`                                      | event pesanan dan refund yang sudah ada, sebagaimana dikonsumsi konsumer loyalti dan komisi                                                 | kolom amplop `occurred_at` dan `recorded_at` event pesanan atau refund                                                               |
| Interaksi masuk menunggu balasan, balasan pertama, penugasan, serah-terima                | `omnichannel_inbox`                             | baris percakapan dan **riwayat aktivitas append-only**-nya (riwayat penugasan, stempel respons)                                             | lihat bagian 6.1: **tidak dapat dihitung dari riwayat append-only saat ini** (Q1)                                                    |
| Tugas tindak lanjut jatuh tempo, selesai, terlambat                                       | `crm_follow_up`                                 | catatan tugas modul                                                                                                                         | waktu server yang dicatat modul (menunggu Q2)                                                                                        |

**Celah jujur yang harus diakui saat persetujuan (lihat Q1 dan Q2 di bagian 11).** Saat ini, baik `omnichannel_inbox` maupun `crm_follow_up` tidak menerbitkan domain event untuk respons, penugasan, atau hasil tugas: inbox mencatat respons ketika staf mengisinya setelah membalas lewat rute channel itu sendiri, dan riwayat aktivitasnya adalah tabel, bukan aliran event. Kontrak ini karenanya menetapkan **stempel waktu append-only** itu sebagai otoritas dan mewajibkan bahwa, sebelum proyeksi SLA atau tindak lanjut dibangun, upstream menerbitkan event untuknya atau membuka port baca yang ditinjau. Tidak ada yang disimpulkan dari tanda terima pengiriman penyedia, dan tidak ada yang direkonstruksi dari isi pesan.

**Waktu yang menentukan bucket.** Payload tidak semuanya membawa kolom yang sama (`apps/cms/src/modules/crm-leads/domain/crm-leads-events.ts`), sehingga kontrak menyebut kolom per event alih-alih mengandaikan dua instan. Aturannya seragam: **waktu bucket** adalah instan bisnis payload bila ada (`occurredAt` untuk `lead.created`, `lead.stage_changed`, `lead.converted`, `lead.conversion_reversed`; `assignedAt` untuk `lead.assigned`; `mergedAt` atau `revertedAt` untuk event penggabungan) dan selain itu kolom amplop **`occurred_at`** baris `awcms_domain_events` (setiap event `awcms.commerce.*`, yang payload-nya tidak membawa kolom waktu sama sekali). **Waktu pencatatan** adalah `recordedAt` payload bila ada dan selain itu kolom amplop **`recorded_at`**. Pemanggil staf boleh me-backdate `occurredAt` (dibatasi jam server, tidak pernah di masa depan); `recorded_at` amplop selalu milik server. Fakta di-bucket menurut waktu bucket-nya dan **waktu pencatatan menentukan restatement dan kesegaran**: fakta yang dicatat setelah jendela restatement 35 hari untuk waktu bucket yang lebih awal me-restate hari itu dan menandainya (bagian 8).

**Dedup dan urutan.** Setiap penghitung berkunci **event id** fakta sumbernya; pengiriman ulang, replay, dan pembangunan ulang konvergen ke nilai yang sama. Fakta tentang satu lead diterapkan dalam urutan `(waktu bucket, waktu pencatatan, eventId)`, masing-masing diselesaikan seperti di atas; fakta yang tiba sebelum fakta yang menjadi sandarannya (`converted` sebelum `created`) **diparkir** pada kunci lead dan diterapkan saat dependensinya tiba, dan proyeksi yang tidak bisa menempatkannya dalam jendela restatement melaporkannya di blok kualitas data (bagian 10.1) alih-alih membuangnya.

## 3. Funnel lead

### 3.1 Tahap berasal dari kategori, bukan dari nama tahap tenant

Revisi pipeline tidak dapat diubah dan tenant menamai tahapnya sendiri, sehingga funnel tidak bisa didefinisikan pada kunci tahap. Setiap tahap membawa satu dari enam **kategori tertutup**: `new`, `working`, `qualified`, `converted`, `lost`, `disqualified`. Funnel didefinisikan **pada kategori**; kunci tahap dan revisi hanya tersedia sebagai dimensi drill-down. Lead yang dipindah transisi `stage_migrated` adalah **pemetaan ulang, bukan kemajuan**: ia mengubah hitungan "saat ini di" tetapi tidak pernah membuat peristiwa "dicapai". Setiap angka dicapai karenanya dihitung dari `awcms.crm_leads.lead.stage_changed` dan `transitionKind`-nya, mengabaikan `stage_migrated`; kategori pertama lead adalah `stageCategory` dari `lead.created`-nya.

### 3.2 Penghitung

Penghitung hanya naik; setiap angka yang ditampilkan diturunkan saat baca dari penghitung monotonik, persis seperti kontrak metrik. Ada dua keluarga dan selalu diberi label:

- **Dicapai (kohort, "pernah")**: jumlah lead dalam kohort yang **pertama kali masuk** ke sebuah kategori kapan saja sampai `asOf`. Lead dihitung sekali per kategori, pada masuk pertamanya, apa pun yang dilakukannya kemudian. Hitungan dicapai tidak pernah turun karena lead kemudian pindah **atau dibuka kembali** (satu semantik di seluruh dokumen: lead yang pernah masuk `lost` lalu dibuka kembali tetap dihitung di `leads_lost` dan juga muncul di kategori berikutnya yang dicapainya; apakah ia hilang _sekarang_ adalah snapshot `currentlyIn`, yang diberi label demikian).
- **Saat ini di (snapshot)**: lead yang transisi terakhirnya berada di kategori itu pada `asOf`. Ia snapshot dan diberi label demikian; tidak pernah dipakai sebagai pembilang funnel.

| KPI                                          | Definisi (pembilang)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Kunci kohort                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `leads_received`                             | Jumlah lead berbeda dengan event `lead.created` dalam jendela. Lead yang digabung keluar dikurangkan selama penggabungan berlaku dan dipulihkan oleh `merge_reverted`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | hari `created` di zona waktu tenant |
| `leads_contacted`                            | Lead yang pertama kali masuk kategori `working` setelah `new`, dari `lead.stage_changed` dengan `transitionKind` bukan `stage_migrated`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | hari `created` lead                 |
| `leads_qualified`                            | Lead yang pertama kali masuk `qualified`, dari `lead.stage_changed` dengan `transitionKind` bukan `stage_migrated`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | hari `created` lead                 |
| `leads_registered`                           | **Bukan langkah funnel tersendiri: rincian `leads_converted` menurut bukti.** Lead terkonversi yang tautan hidupnya ber-`evidenceKind = customer_registration`. Pasangannya `evidenceKind = paid_order`. Keduanya berjumlah `leads_converted`; `registered` karenanya tidak pernah lebih besar dari `converted`.                                                                                                                                                                                                                                                                                                                                                  | hari `created` lead                 |
| `leads_converted`                            | Lead dengan konversi **terverifikasi dan hidup**: event `lead.converted` dengan **`mode = authority_confirmed`** yang `conversionId`-nya punya baris hidup di `awcms_commerce_crm_lead_links` (status `linked`, atau `reversal_pending` yang tetap dihitung, bagian 4), dan tanpa `lead.conversion_reversed` berikutnya untuk `conversionId` itu. `lead.converted` dengan `mode = authority_unconfirmed` adalah konversi manual staf tanpa bukti terverifikasi dan **tidak pernah** masuk angka ini. Konversi terkonfirmasi tanpa tautan adalah butir kualitas data (`confirmedWithoutLink`), bukan konversi.                                                     | hari `created` lead                 |
| `leads_converted_manual`                     | Lead dengan `lead.converted` hidup ber-**`mode = authority_unconfirmed`** (konversi yang dinyatakan staf tanpa bukti commerce terverifikasi), dikurangi `lead.conversion_reversed`. Selalu ditampilkan sebagai angka berlabel sendiri, "manual (belum terverifikasi)", **tidak pernah dijumlahkan atau dinetkan ke** `leads_converted`, tidak pernah diberi nilai konversi, dan tidak dipakai dalam atribusi.                                                                                                                                                                                                                                                     | hari `created` lead                 |
| `leads_lost`                                 | Lead yang pertama kali masuk `lost` atau `disqualified`, dihitung dari event **`lead.stage_changed`** yang `toCategory`-nya `lost` atau `disqualified` dan `transitionKind`-nya **bukan** `stage_migrated`. Event `awcms.crm_leads.lead.lost` **bukan** sumber: ia diterbitkan untuk setiap transisi non-created ke kategori hilang, termasuk pemetaan ulang pipeline, dan tidak membawa `transitionKind`, sehingga menghitungnya akan menghitung pemetaan ulang sebagai kehilangan. Dipecah menurut kategori, sumber, dan kategori yang ditinggalkan lead (`fromCategory`). Pembukaan kembali tidak mengeluarkan lead dari hitungan dicapai ini (lihat di atas). | hari `created` lead                 |
| `follow_ups_completed`, `follow_ups_overdue` | Didefinisikan hanya namanya; pembilang dan otoritas event menunggu Q2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | hari jatuh tempo tugas              |
| `attrition_by_reason`                        | **Belum dapat dihitung.** Alasan hilangnya lead adalah teks bebas (`reason`, panjang terbatas), terhapus bersama lead, dan sengaja tidak ada di event mana pun; ia tidak pernah dibaca, diurai, atau dibucket. Rincian alasan memerlukan **katalog kode alasan tertutup** milik `crm_leads` (Q6). Sampai ada, KPI mengembalikan `null` dengan `reason: "no_reason_catalogue"`.                                                                                                                                                                                                                                                                                    | hari `created` lead                 |
| `acquisition_cost`                           | **Dilaporkan hanya bila ada sumber biaya** (biaya kampanye atau channel yang dicatat modul pemiliknya). Selain itu nilainya `null` (tak diketahui), bukan `0`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | kampanye atau channel dan hari      |

Tahap `converted` pada funnel **adalah `leads_converted`** (terverifikasi), bukan "masuk kategori `converted`": lead yang dipindahkan staf ke kategori `converted` lewat konversi manual telah masuk kategori itu tetapi hanya dilaporkan di `leads_converted_manual`. Menurut ADR-0056 D4 sebuah lead punya paling banyak satu tautan hidup, dan membuat tautan `customer_registration` itu sendiri adalah konversi CRM (memanggil port CRM dan menerbitkan `awcms.commerce.customer.converted`), sehingga konversi registrasi adalah satu **jenis** lead terkonversi, dipecah menurut `evidenceKind`, dan lead yang terkonversi lewat pesanan lunas tidak pernah juga dihitung sebagai terdaftar.

`leads_converted` hanya dapat **dihitung untuk lead yang telah ditautkan seseorang**: commerce tidak pernah mencocokkan lead lewat telepon, e-mail, atau handle (ADR-0056 D1), sehingga pelanggan yang mendaftar tanpa tautan terkonfirmasi **bukan** lead terkonversi. Dasbor boleh menampilkan registrasi pelanggan sisi commerce di samping funnel sebagai angka terpisah tanpa atribusi, tidak pernah dijumlahkan ke dalamnya.

### 3.3 Konversi antartahap dan drop-off

`konversi(A ke B) = dicapai(B) / dicapai(A)` pada **kohort yang sama** (lead yang dibuat dalam jendela), dihitung dari penghitung dicapai. Drop-off adalah `1 - konversi`. Karena pembilang dan penyebut berada pada satu kohort, lead yang masih berjalan menurunkan laju sampai ia maju; setiap respons karenanya membawa `cohortMaturityDays` (median usia lead dalam kohort) dan penanda `provisional: true` selama lead terbaru kohort lebih muda dari kematangan yang dikonfigurasi tenant (bawaan 30 hari, parameter kontrak). Laju tidak pernah disajikan sebagai final selagi provisional.

### 3.4 Versi pipeline

Kohort yang melintasi revisi pipeline dilaporkan pada kategori, yang stabil antarrevisi. Drill-down menurut `pipelineRevision` tepat untuk lead yang dibuat di bawah revisi itu dan diberi label "campuran" untuk lead yang dimigrasi antarrevisi. Memfilter revisi tak dikenal atau yang dipensiunkan mengembalikan hasil kosong tanpa kesalahan.

## 4. Konversi dari fakta commerce terverifikasi

- **Otoritas.** Konversi dihitung hanya bila `lead.converted`-nya ber-`mode = authority_confirmed` **dan** lead memiliki tautan hidup yang dibuat oleh `POST /api/v1/commerce/crm-lead-links` (ADR-0056), yang buktinya diverifikasi server: registrasi terverifikasi OTP, atau pesanan lunas milik pelanggan itu. Tanda terima pesan, status pengiriman, klik, atau balasan **tidak pernah** menjadi konversi.
- **Nilai konversi.** Bila buktinya pesanan lunas, nilainya adalah **total lunas pesanan itu dikurangi refund yang selesai**, sebagai string desimal dua tempat (teks `numeric(14,2)`, cara commerce membawa uang; contoh `"12500000.00"`), dari fakta pesanan dan refund yang sudah dikonsumsi di tempat lain (loyalti, komisi). Refund setelah jendela me-restate hari konversi aslinya menurut aturan restatement (bagian 8), bukan hari refund. Konversi berbukti registrasi **tidak bernilai** (`null`), bukan `0`. Konversi pesanan lunas yang pesanannya di-refund penuh membawa **`"0.00"`** (nilai nol neto yang diketahui), bukan `null`, termasuk selama tautannya masih `reversal_pending`.
- **Pembalikan.** Tautan bertanda `reversal_pending` **tetap dihitung terkonversi** sampai seseorang menerapkan pembalikan, karena penanda adalah permintaan dan konversi CRM masih berlaku; respons menampilkan hitungan `reversalPending` terpisah agar pemilik melihat eksposurnya. Hitungan itu **tidak punya event** (penanda commerce hanya meng-UPDATE baris tautan), sehingga ia adalah **snapshot yang dibaca langsung dari `awcms_commerce_crm_lead_links.state`** pada `asOf`, diberi label demikian dan dikecualikan dari paritas replay; pembalikannya sendiri tiba sebagai `lead.conversion_reversed`. Setelah orang itu membalikkannya, konversi keluar dari pembilang dan hari tempat ia dihitung di-restate.
- **Waktu menuju konversi.** `convertedAt - createdAt` lead, sebagai distribusi (median dan persentil atas kohort), bukan rata-rata.
- **Konversi manual.** `lead.converted` dengan `mode = authority_unconfirmed` dilaporkan terpisah sebagai `leads_converted_manual` (bagian 3.2): tanpa bukti terverifikasi, tanpa nilai, tanpa kredit atribusi, dan tidak masuk laju konversi mana pun, sehingga pembilang funnel dan bagian ini sepakat.
- **Konversi kedua.** Lead berkonversi sekali; pesanan pelanggan berikutnya adalah pendapatan commerce, bukan konversi funnel.

## 5. Atribusi kampanye

- **Model sentuhan.** Atribusi membaca **sentuhan sumber pertama** lead (tak berubah, dibawa `lead.created` dan disalin ke tautan sebagai `firstSourceKind` dan `firstTouchId`) serta sentuhan lanjutan yang ditambahkan. Dimensi sumber adalah channel, akun channel, brand, dan kampanye, diambil dari referensi sentuhan itu sendiri; sentuhan tanpa referensi kampanye diatribusikan ke channel-nya saja.
- **Model bawaan: sentuhan pertama.** Konversi dikreditkan penuh ke sentuhan sumber pertama lead, dan tidak ke yang lain. Model sentuhan terakhir atau multi-sentuhan adalah **versi kontrak yang berbeda** dan tidak ditawarkan kontrak ini.
- **Lookback.** Konversi diatribusikan ke kampanye hanya bila sentuhan pertama lead terjadi **tidak lebih dari `lookbackDays` sebelum waktu konfirmasi konversi**. Bawaannya **90 hari** (parameter kontrak berversi, keputusan pemilik Q3); konversi di luar lookback dilaporkan di bawah `unattributed`, tidak pernah dibuang dan tidak pernah dikreditkan ke kampanye terdekat. Jendela diukur antarinstan (UTC), bukan antartanggal kalender.
- **Lead tanpa sumber.** Lead manual atau impor tanpa kampanye sentuhan adalah `unattributed` untuk dimensi kampanye. Lead yang data sumbernya hilang adalah `unknown`, dilaporkan sebagai bucket sendiri dan **bukan nol dan bukan kesalahan**.
- **Data penyedia.** Pesan yang diterima, terkirim, atau dibaca penyedia bukan hasil funnel. Penerimaan, pengiriman, respons, registrasi, dan konversi adalah deret terpisah (AT-06); status penyedia yang tidak pernah dilaporkan penyedia adalah `unknown`, bukan `0` dan bukan `delivered`.
- **Angka berbasis biaya.** Biaya per lead dan biaya per konversi hanya ada bila ada sumber biaya untuk kampanye dan periode itu (bagian 3.2); selain itu `null`.

## 6. SLA staf

### 6.1 Respons bermakna pertama

**Apa yang dapat dan belum dapat dihitung saat ini.** Bagian ini menyatakan definisi yang dimaksud dan, secara jujur, apa yang didukung data inbox. Ia **tidak** mendefinisikan kalender SLA kedua: jam inbox sendiri adalah definisi tunggal (`omnichannel_inbox`: `awaiting_since`, `response_due_at`, `sla_breached_at`, dan hanya status `resolved` dan `closed` yang menyelesaikan percakapan).

- **Mulai.** Instan penerimaan interaksi masuk pertama yang belum dijawab dari sebuah episode menunggu (`awaiting_since` inbox). **Celah (Q1):** riwayat aktivitas append-only inbox memiliki jenis `assigned`, `unassigned`, `assignee_revoked`, `status_changed`, `response_recorded`, `tag_added`, `tag_removed`, dan `sla_breached`, tetapi **tidak ada jenis untuk penerimaan masuk**; `awaiting_since` dan `answered_through` adalah kolom mutable yang ditimpa. Instan mulai karenanya tidak dapat di-replay dari riwayat, dan paritas replay (AT-08, S13) tidak dapat dipenuhi untuk waktu berlalu sampai upstream menerbitkan event atau baris append-only untuk "episode menunggu dimulai" yang membawa instan penerimaan dan kebijakan yang berlaku.
- **Berhenti.** Waktu server baris **`response_recorded` manusia** pertama yang menjawab episode. Pengakuan otomatis, gema template, balasan di luar kantor, dan balasan bot tidak menghentikan jam. Waktu kirim atau antar penyedia tidak pernah dipakai.
- **Ukur.** **Menit kerja** yang berlalu antara mulai dan berhenti menurut kebijakan SLA yang berlaku (zona IANA, jendela hari kerja, hari libur; versi kebijakan dicatat bersama angkanya).
- **Tidak ada jeda pada `pending`.** Inbox **tidak** menjeda jamnya untuk `pending`: `pending` bukan status penyelesai dan `response_due_at` terus berjalan, sehingga KPI juga tidak menjedanya (aturan lain akan membuat laporan ini berbeda dari stempel pelanggaran inbox sendiri). Waktu berstatus `pending` ditampilkan hanya sebagai angka informasional.
- **Terlambat (otoritas historis).** Percakapan terlambat untuk sebuah episode bila ada **baris aktivitas `sla_breached`** append-only untuknya. Kolom `sla_breached_at` **bukan** otoritas: `recordResponse` dan worker mengembalikannya ke NULL, sehingga ia melupakan sejarah. Terlambat dihitung **sekali per episode**.
- **Diselesaikan tanpa respons.** Percakapan yang diselesaikan dengan `resolved` atau `closed` tanpa `response_recorded` setelah awal episode dilaporkan sebagai `settledWithoutResponse`: ia **dikecualikan dari `answered`, dari penyebut dalam-anggaran, dan dari persentil**, ikut dihitung di `overdue` hanya bila ada baris `sla_breached` untuk episode itu, dan ditampilkan sebagai angka tersendiri agar tidak pernah dibuang diam-diam.
- **Penyebut.** `withinBudget` = episode terjawab dengan menit kerja berlalu tidak melebihi anggaran, atas episode terjawab ditambah episode terlambat-belum-terjawab (episode yang masih terbuka dan belum jatuh tempo, serta `settledWithoutResponse`, dilaporkan di sampingnya dan dikecualikan).
- **Distribusi, bukan rata-rata.** Laporan memberi jumlah terjawab, median dan persentil ke-90 menit kerja menuju respons pertama, rasio dalam anggaran, jumlah terlambat, dan `settledWithoutResponse`. Rata-rata tidak pernah menjadi judul.
- **Sampai Q1 terselesaikan**, proyeksi SLA **tidak dibangun**; jumlah terlambat saja bisa berasal dari baris `sla_breached`, tetapi persentase dalam-anggaran tidak dapat di-replay, sehingga mengirim angka parsial ditolak.

### 6.2 Keadilan: apa yang boleh dan tidak boleh dibandingkan

- Angka staf dihitung **terhadap penugasan aktual**: percakapan dihitung untuk seorang operator hanya selama rentang ia ditugaskan (dari riwayat penugasan), dan **transfer manual** memecah rentang; waktu sebelum penugasan pertama milik **antrean**, dan percakapan tanpa penugasan tidak pernah diatribusikan ke operator mana pun.
- Baris tiap operator disertai **penyebutnya**: percakapan yang ditangani, porsi di luar jam kerja, bauran channel, dan beban kerja yang ditugaskan untuk periode itu. Tidak ada respons yang meranking operator; API tidak memiliki `rank` atau `sort by response time` atas orang, dan operator di bawah ambang sel kecil (bagian 7) hanya ditampilkan di dalam agregat tim.
- **Antrean dan operator adalah angka terpisah.** Waktu tunggu antrean (dari penerimaan sampai penugasan pertama) dilaporkan untuk tim, tidak dibebankan ke operator.
- Laporan yang membandingkan channel menyatakan bahwa channel memiliki waktu respons yang diharapkan berbeda; perbandingan memakai anggaran kebijakan tiap channel (persentase dalam anggaran), bukan menit mentah.

## 7. Penyebut, nol, dan sel kecil

1. **Setiap rasio dikirim bersama pembilang dan penyebutnya** sebagai bilangan bulat di samping lajunya. Klien tidak perlu merekayasa balik laju.
2. **Penyebut nol.** `rate = null` dengan `reason: "zero_denominator"`. Tidak pernah `0`, `NaN`, `100%`, atau kolom yang dihilangkan, dan grafik menampilkan celah, bukan titik.
3. **Tak dikenal bukan nol.** Data penyedia yang hilang, biaya yang hilang, status yang tak dilaporkan, dan lead tanpa sumber adalah `null` atau `unknown`, dan dihitung di blok kualitas data.
4. **Sel kecil ditekan.** Angka apa pun yang kelompok dasarnya **kurang dari 5** (ambang yang sudah dipakai segmen, ADR-0042 D6; parameter kontrak yang boleh dinaikkan tenant, tidak pernah diturunkan) dikembalikan sebagai `value: null` dengan `suppressed: true, reason: "fewer_than_5"`. Penekanan bersifat **semua-atau-tidak sama sekali di seluruh dimensi**: bila satu sel rincian ditekan dan total ditampilkan, sel lain juga ditekan bila selisihnya dapat mengungkapnya (penekanan komplementer), sehingga kelompok sempit tidak dapat dipulihkan dengan pengurangan.
5. **Pembedaan (differencing).** Dua filter yang tumpang tindih pada data yang sama tidak boleh mengungkap sel yang ditekan: API menolak permintaan yang filternya menghasilkan kelompok di bawah ambang pada granularitas lebih halus daripada yang diminta (misalnya satu operator pada satu hari), mengembalikan hasil yang lebih kasar alih-alih kesalahan.
6. **Persentil atas kurang dari 5 pengamatan** juga ditekan.

## 8. Waktu, restatement, dan replay

- **Zona waktu.** Hari, minggu, atau bulan adalah interval setengah-terbuka di **zona waktu tenant**, bawaan `Asia/Jakarta` (kontrak metrik 1.1.3); instan disimpan dan dipertukarkan dalam UTC (RFC 3339). Batas periode menempatkan event pada bucket instannya sendiri, sehingga event pukul 23:59:59 dan pukul 00:00:00 jatuh di hari berbeda. Perubahan zona waktu tenant berlaku dari instan yang dinyatakan dan tidak menulis ulang sejarah.
- **Event terlambat me-restate hari aslinya.** Fakta kompensasi atau terlambat (pembalikan, refund, event tertunda) jatuh pada hari **fakta yang diatribusikan**; hari ditandai `restated` bila berubah setelah jendela restatement 35 hari. Angka dikoreksi, tidak pernah dibekukan.
- **Paritas replay (AT-08).** Memutar ulang event sumber ke proyeksi kosong harus memberi angka **persis** sama dengan yang hidup, termasuk setelah pengiriman tak berurutan dan ganda; uji paritas atas log event terekam adalah syarat penerimaan pembangunan, bukan renungan belakangan.
- **Kesegaran.** Setiap respons membawa `asOf` dan `freshness`; proyeksi basi menyatakannya alih-alih menampilkan angka sebagai terkini.

## 9. Privasi dan ekspor

### 9.1 Tanpa PII di agregat

Baris proyeksi hanya memuat **penghitung dan kunci dimensi buram**: tenant, hari, brand, channel, akun channel, referensi kampanye, revisi pipeline, **kategori** tahap, id assignee buram. Ia **tidak memuat nama, titik kontak, isi pesan, catatan, teks bebas, id lead, atau id pelanggan**. Identifikasi ulang lewat kombinasi adalah tugas aturan sel kecil (bagian 7). Drill-down membaca tabel sumber yang hidup dan **mengotorisasi ulang per baris**; ia tidak pernah dilayani dari proyeksi.

### 9.2 Otorisasi dan pelingkupan

- Membaca KPI memerlukan izinnya sendiri, terpisah dari izin membaca catatan dasarnya; pembaca yang **dibatasi lingkup bisnis** (seperti di inbox) hanya melihat lingkupnya, dan angka seluruh tenant tidak dihitung dengan menjumlah sel tersembunyi.
- Angka SLA staf dapat dibaca pemimpin tim dan administrator untuk lingkupnya; operator membaca barisnya **sendiri** saja. Tidak ada total lintas tenant, dan permintaan lintas tenant ditolak.
- Setiap ekspor dan setiap drill-down diaudit dengan aktor, filter, versi kontrak, dan jumlah baris, tidak pernah barisnya.

### 9.3 Ekspor CSV dan kompatibel Excel

- Setiap sel ditulis melalui `csvCellForWrite` (`apps/cms/src/lib/security/csv-formula.ts`), yang menetralkan `=`, `+`, `-`, `@`, TAB, atau CR di awal; sisi impor memakai `restoreCsvCell`. Nilai KPI berupa desimal bertanda polos ditulis dengan opsi `numericText` pembantu itu, sehingga uang mempertahankan dua desimal dan tandanya. **Tidak ada penulis ekspor yang dibuat sendiri**, dan sapuan formula CSV (`apps/cms/tests/csv-formula-neutralisation.test.ts`) harus mendaftar penulis baru.
- Sel yang ditekan diekspor sebagai **sel kosong dengan kolom penanda `suppressed`**, bukan sebagai `0`. Tak dikenal kosong, tidak pernah `0`.
- Ekspor membawa blok header `contractVersion`, `asOf`, `timezone`, filter, dan pernyataan bahwa sel kecil ditekan. Batas baris dan ukuran berlaku, dan ekspor besar dibuat sebagai job, bukan inline.
- PDF opsional adalah render angka tertekan yang sama, tidak pernah sumber rincian tambahan.

### 9.4 Yang tidak pernah dikembalikan API

Tidak ada pengenal lead atau pelanggan dalam respons KPI; tidak ada peringkat operator; tidak ada teks pesan; tidak ada stempel waktu mentah satu percakapan dalam respons agregat.

## 10. Bentuk respons API yang diusulkan (hanya usulan, bukan di OpenAPI)

> **Bentuk-bentuk ini adalah usulan untuk diterima atau diubah pemilik.** Bentuk ini **tidak** ditambahkan ke dokumen OpenAPI dan tidak ada rute, sehingga gerbang paritas rute (`ROUTE_PARITY_EXEMPTIONS`, yang harus tetap kosong) tidak terpengaruh. Issue pembangunan pertama yang mengimplementasikan salah satunya menambahkan path OpenAPI dan handler-nya **bersamaan**, sesuai aturan contract-first ADR-0016 dan `AGENTS.md`. Path mengikuti konvensi `/api/v1/reports/...` yang ada dan ADR penamaan akhir dialokasikan saat pembangunan. Uang berupa string desimal dua tempat (teks `numeric(14,2)`, seperti di seluruh commerce dan bagian 4), hitungan bilangan bulat, instan RFC 3339 UTC.

### 10.1 Amplop umum

```jsonc
{
  "contractVersion": "1.0.0",
  "asOf": "2026-11-14T03:00:00Z",
  "freshness": { "lagSeconds": 42, "stale": false },
  "timezone": "Asia/Jakarta",
  "period": { "from": "2026-11-01", "to": "2026-11-14", "granularity": "day" },
  "filters": {
    "brand": null,
    "channel": null,
    "campaign": null,
    "pipelineRevision": null,
    "assignee": null,
  },
  "parameters": {
    "lookbackDays": 90,
    "smallCellThreshold": 5,
    "cohortMaturityDays": 30,
  },
  "provisional": true,
  "dataQuality": { "parkedEvents": 0, "unknownSource": 12, "restatedDays": [] },
  "data": {},
}
```

### 10.2 Objek rasio (dipakai di mana pun laju muncul)

```jsonc
{ "numerator": 18, "denominator": 120, "rate": "0.1500", "suppressed": false }
// penyebut nol
{ "numerator": 0, "denominator": 0, "rate": null, "reason": "zero_denominator", "suppressed": false }
// sel kecil
{ "numerator": null, "denominator": null, "rate": null, "suppressed": true, "reason": "fewer_than_5" }
```

### 10.3 `GET /api/v1/reports/crm/funnel`

```jsonc
"data": {
  "cohort": { "leads": 120 },
  "stages": [
    { "category": "new", "reached": 120, "currentlyIn": 31 },
    { "category": "working", "reached": 96, "currentlyIn": 40, "conversionFromPrevious": { "numerator": 96, "denominator": 120, "rate": "0.8000", "suppressed": false } },
    { "category": "qualified", "reached": 51, "currentlyIn": 22, "conversionFromPrevious": { } },
    { "category": "converted", "reached": 18, "currentlyIn": 18, "reversalPending": 1, "conversionFromPrevious": { },
      "byEvidence": [
        { "evidenceKind": "paid_order", "count": 13 },
        { "evidenceKind": "customer_registration", "count": 5 }
      ] },
    { "category": "lost", "reached": 33, "bySource": [{ "sourceKind": "api", "count": 20 }] }
  ],
  "manualConversions": { "count": 4, "verified": false },
  "timeToConvertDays": { "median": 9, "p90": 21, "observations": 18, "suppressed": false }
}
```

`byEvidence` selalu berjumlah `reached` terverifikasi dari `converted` (13 + 5 = 18), dan `manualConversions` tidak pernah dijumlahkan ke dalamnya.

### 10.4 `GET /api/v1/reports/crm/attribution`

```jsonc
"data": {
  "model": "first_touch",
  "rows": [
    { "key": { "sourceKind": "inbound_message", "channelAccountRef": "acc_opaque", "campaignRef": "cmp_opaque" },
      "leads": 40, "converted": 7, "conversionRate": { },
      "value": { "currency": "IDR", "amount": "12500000.00" },
      "cost": null, "costPerConversion": null }
  ],
  "unattributed": { "converted": 3, "reason": "outside_lookback" },
  "unknown": { "leads": 12 }
}
```

### 10.5 `GET /api/v1/reports/crm/sla` dan `/api/v1/reports/crm/sla/staff`

```jsonc
"data": {
  "policyVersion": "tenant-default@7",
  "firstResponse": {
    "answered": 210, "overdue": 6, "withinBudget": { "numerator": 198, "denominator": 210, "rate": "0.9429", "suppressed": false },
    "businessMinutes": { "median": 14, "p90": 47, "observations": 210, "suppressed": false },
    "settledWithoutResponse": 9,
    "pendingMinutesInformational": 3120
  },
  "queueWait": { "businessMinutes": { "median": 4, "p90": 11 } },
  "staff": [
    { "assigneeRef": "usr_opaque", "handled": 64, "outsideHoursShare": "0.18", "channels": [{ "channel": "telegram", "count": 50 }],
      "withinBudget": { }, "suppressed": false }
  ]
}
```

`staff` hanya dikembalikan kepada pemanggil yang berhak, tidak pernah diurutkan menurut waktu respons, dan operator di bawah ambang dilebur ke baris tim.

### 10.6 Ekspor

Konvensi laporan yang ada adalah **path saudara `.csv`** (misalnya `/api/v1/reports/commerce/booking-revenue.csv`, `.../retention.csv`), sehingga setiap path KPI punya saudara: `GET /api/v1/reports/crm/funnel.csv`, `.../attribution.csv`, `.../sla.csv`, `.../sla/staff.csv`, masing-masing dijaga izin kata kerja `export` sendiri. Path saudara mengembalikan CSV aman-formula bagian 9.3; permintaan besar mengembalikan `202` dengan referensi job. Drill-down adalah panggilan terpisah yang diotorisasi ulang pada rute daftar modul sumber, bukan pada path KPI.

## 11. Daftar periksa persetujuan pemilik (gerbang untuk kode proyeksi apa pun)

Pemilik menerima kontrak dengan mencentang setiap kotak **dalam keputusan tercatat** (ADR atau amandemen bertanggal dokumen ini yang menyebut versi yang diterima). Tidak ada yang dicentang agen.

- [ ] **S1.** Tahap funnel adalah enam kategori tertutup, dengan "dicapai" (pernah, sekali per lead) sebagai pembilang funnel dan "saat ini di" sebagai snapshot berlabel (bagian 3).
- [ ] **S2.** Pemetaan ulang `stage_migrated` tidak pernah menjadi kemajuan; angka dicapai dan hilang berasal dari `lead.stage_changed` (bukan `lead.lost`) dengan `transitionKind` bukan `stage_migrated`, dan hitungan dicapai tidak pernah turun, termasuk saat dibuka kembali (bagian 3.1, 3.2).
- [ ] **S3.** `leads_converted` menghitung **hanya lead tertaut yang terverifikasi (`authority_confirmed`)**; `leads_registered` adalah rincian terkonversi menurut `evidenceKind`, bukan langkah funnel tersendiri atau lebih besar; registrasi pelanggan tak tertaut ditampilkan terpisah, tidak pernah dijumlahkan (bagian 3.2).
- [ ] **S4.** Konversi dikreditkan hanya dari fakta commerce terverifikasi, tidak pernah dari tanda terima pesan; konversi manual (`authority_unconfirmed`) adalah angka berlabel terpisah, tidak pernah dinetkan; tautan `reversal_pending` tetap dihitung sampai seseorang membalikkannya, dan eksposurnya ditampilkan sebagai snapshot langsung (bagian 4).
- [ ] **S5.** Nilai konversi adalah total lunas dikurangi refund selesai, di-restate pada hari aslinya; konversi registrasi tidak bernilai (bagian 4).
- [ ] **S6.** Atribusi adalah **sentuhan pertama**, dengan lookback bawaan **90 hari** (Q3), unattributed dan unknown dilaporkan sebagai bucket sendiri (bagian 5).
- [ ] **S7.** Respons bermakna pertama berjalan dari instan penerimaan inbox sampai `response_recorded` **manusia** pertama, dalam menit kerja menurut kebijakan SLA inbox sendiri, **tanpa jeda pada `pending`**, terlambat diambil dari baris `sla_breached` append-only, diselesaikan-tanpa-respons dilaporkan terpisah, dan tidak ada yang dibangun sampai Q1 memberi instan mulai yang dapat di-replay (bagian 6.1).
- [ ] **S8.** Angka staf memakai penugasan aktual, dipecah saat transfer manual, tidak pernah meranking operator, dan membebankan waktu tunggu antrean ke tim (bagian 6.2).
- [ ] **S9.** Penyebut nol adalah `null` dengan alasan; tak dikenal tidak pernah `0` (bagian 7).
- [ ] **S10.** Ambang sel kecil adalah **5**, dapat dinaikkan tenant dan tidak dapat diturunkan, dengan penekanan komplementer (bagian 7).
- [ ] **S11.** Agregat tidak memuat PII atau teks bebas; drill-down mengotorisasi ulang per baris (bagian 9.1).
- [ ] **S12.** Setiap ekspor melalui `csvCellForWrite`, menulis sel tertekan kosong dengan penanda, dan diaudit (bagian 9.3).
- [ ] **S13.** Bucket zona waktu tenant, jendela restatement 35 hari, dan paritas replay adalah syarat penerimaan, dengan kolom waktu per event pada bagian 2 (bagian 8).
- [ ] **S14.** Bentuk respons bagian 10 diterima (atau diamandemen) sebagai kontrak awal untuk issue pembangunan pertama.
- [ ] **S15.** UX layar laporan diterima pada langkah 4 alur produk (UX-26 di [`omnichannel-crm-ui-ux.md`](omnichannel-crm-ui-ux.id.md) adalah kandidatnya) **sebelum** model data proyeksi.

**Pertanyaan terbuka yang memblokir pembangunan, bukan kontrak:**

- **Q1.** Upstream tidak memiliki event untuk respons atau penugasan inbox, **dan tidak ada catatan append-only untuk penerimaan masuk** (instan mulai hanya ada di `awaiting_since` yang mutable). Mana yang dipilih pemilik: upstream menerbitkan event (episode-dimulai dengan kebijakan yang berlaku, respons, penugasan), atau port baca yang ditinjau atas riwayat append-only yang mendapat baris penerimaan yang hilang? Keduanya harus memungkinkan paritas replay. (Bagian 2 dan 6.1.)
- **Q2.** KPI tindak lanjut (`follow_ups_completed`, `follow_ups_overdue`) menunggu sumber sebanding dari `crm_follow_up`.
- **Q3.** Apakah 90 hari lookback bawaan yang tepat untuk siklus penjualan tenant, dan bolehkah tenant mengubahnya (perubahan adalah versi kontrak baru)?
- **Q4.** Di mana sumber biaya dicatat, dan oleh modul mana, belum ditetapkan; KPI biaya tetap `null` sampai ada.
- **Q5.** Kepemilikan: proyeksi lintas domain dispesifikasikan di sini (aturan kontrak metrik untuk proyeksi yang menggabungkan modul), dan bagian generiknya diusulkan ke upstream; pemilik mengonfirmasi pembagian dan ADR yang mencatatnya.
- **Q6.** Rincian alasan hilang (CRM-070 "attrition reasons") memerlukan `crm_leads` upstream mengadopsi katalog kode alasan tertutup dan menerbitkan kodenya pada `lead.lost`; saat ini alasan adalah teks bebas yang dijaga keluar dari event, sehingga KPI `null` alih-alih ditebak.

## 12. Yang tidak dilakukan dokumen ini

Ia tidak menambah proyeksi, migrasi, rute, path OpenAPI, dasbor, atau layar; tidak mengubah `crm_leads`, `omnichannel_inbox`, atau `crm_follow_up`; tidak meranking staf; dan tidak mengklaim angka mana pun di atas ada hari ini. Pembangunan dibatasi bagian 11 dan dependensi biasa issue #464 (modul pipeline, inbox, dan tindak lanjut upstream, serta tautan commerce #463, yang sudah mendarat).
