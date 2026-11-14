🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](crm-kpi-contract.md)

<!-- i18n-source-hash: sha256:5ea2f3f5ff3541eceb615898c315e5ef80af0a974ac2a31d443de6c4a3cf98e6 -->

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

| Fakta                                                                      | Otoritas                                        | Event atau catatan                                                                                                | Waktu kejadian                               |
| -------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Lead diterima, sentuhan sumber pertama                                     | `crm_leads`                                     | `awcms.crm_leads.lead.created` (sentuhan pertama tak berubah)                                                     | `occurredAt` (bucket), `recordedAt` (server) |
| Tahap dicapai, tahap ditinggalkan                                          | `crm_leads`                                     | `awcms.crm_leads.lead.stage_changed` (menyebut revisi pipeline), ditambah transisi `stage_migrated`               | `occurredAt`, `recordedAt`                   |
| Pemilik ditetapkan pada lead                                               | `crm_leads`                                     | `awcms.crm_leads.lead.assigned`                                                                                   | `occurredAt`, `recordedAt`                   |
| Lead hilang                                                                | `crm_leads`                                     | `awcms.crm_leads.lead.lost` (tanpa alasan: alasan adalah teks bebas dan tidak pernah keluar dari `crm_leads`)     | `occurredAt`, `recordedAt`                   |
| Lead digabung atau penggabungan dibatalkan                                 | `crm_leads`                                     | `awcms.crm_leads.lead.merged`, `awcms.crm_leads.lead.merge_reverted`                                              | `occurredAt`, `recordedAt`                   |
| Konversi dikonfirmasi atau dibalik                                         | `crm_leads` (sisi CRM), `commerce` (sisi bukti) | `awcms.crm_leads.lead.converted`, `awcms.crm_leads.lead.conversion_reversed`                                      | `occurredAt`, `recordedAt`                   |
| Registrasi pelanggan terverifikasi                                         | `commerce`                                      | `awcms.commerce.customer.registered` (hanya registrasi terverifikasi OTP; checkout tamu tidak pernah menerbitkan) | waktu event                                  |
| Fakta konversi commerce terverifikasi                                      | `commerce`                                      | `awcms.commerce.customer.converted` (membawa `evidenceKind`, `orderId` buram, `firstSourceKind`, `firstTouchId`)  | waktu event                                  |
| Pesanan dibayar, dibatalkan, di-refund penuh (nilai konversi dan koreksi)  | `commerce`                                      | event pesanan dan refund yang sudah ada, sebagaimana dikonsumsi konsumer loyalti dan komisi                       | waktu event                                  |
| Interaksi masuk menunggu balasan, balasan pertama, penugasan, serah-terima | `omnichannel_inbox`                             | baris percakapan dan **riwayat aktivitas append-only**-nya (riwayat penugasan, stempel respons)                   | **waktu server yang dicatat inbox**          |
| Tugas tindak lanjut jatuh tempo, selesai, terlambat                        | `crm_follow_up`                                 | catatan tugas modul                                                                                               | waktu server yang dicatat modul              |

**Celah jujur yang harus diakui saat persetujuan (lihat Q1 dan Q2 di bagian 11).** Saat ini, baik `omnichannel_inbox` maupun `crm_follow_up` tidak menerbitkan domain event untuk respons, penugasan, atau hasil tugas: inbox mencatat respons ketika staf mengisinya setelah membalas lewat rute channel itu sendiri, dan riwayat aktivitasnya adalah tabel, bukan aliran event. Kontrak ini karenanya menetapkan **stempel waktu append-only** itu sebagai otoritas dan mewajibkan bahwa, sebelum proyeksi SLA atau tindak lanjut dibangun, upstream menerbitkan event untuknya atau membuka port baca yang ditinjau. Tidak ada yang disimpulkan dari tanda terima pengiriman penyedia, dan tidak ada yang direkonstruksi dari isi pesan.

**Waktu yang menentukan bucket.** Event `crm_leads` membawa dua instan: `occurredAt`, yang boleh diisi pemanggil staf untuk fakta yang di-backdate (dibatasi jam server dan tidak pernah di masa depan), dan `recordedAt`, milik server. Sebuah fakta **di-bucket menurut `occurredAt`** (waktu bisnis) dan **`recordedAt` menentukan restatement dan kesegaran**: fakta yang dicatat setelah jendela restatement 35 hari untuk `occurredAt` yang lebih awal me-restate hari itu dan menandainya (bagian 8). Fakta `commerce` dan inbox memakai instan server masing-masing.

**Dedup dan urutan.** Setiap penghitung berkunci **event id** fakta sumbernya; pengiriman ulang, replay, dan pembangunan ulang konvergen ke nilai yang sama. Fakta tentang satu lead diterapkan dalam urutan `(occurredAt, recordedAt, eventId)`; fakta yang tiba sebelum fakta yang menjadi sandarannya (`converted` sebelum `created`) **diparkir** pada kunci lead dan diterapkan saat dependensinya tiba, dan proyeksi yang tidak bisa menempatkannya dalam jendela restatement melaporkannya di blok kualitas data (bagian 10.1) alih-alih membuangnya.

## 3. Funnel lead

### 3.1 Tahap berasal dari kategori, bukan dari nama tahap tenant

Revisi pipeline tidak dapat diubah dan tenant menamai tahapnya sendiri, sehingga funnel tidak bisa didefinisikan pada kunci tahap. Setiap tahap membawa satu dari enam **kategori tertutup**: `new`, `working`, `qualified`, `converted`, `lost`, `disqualified`. Funnel didefinisikan **pada kategori**; kunci tahap dan revisi hanya tersedia sebagai dimensi drill-down. Lead yang dipindah transisi `stage_migrated` adalah **pemetaan ulang, bukan kemajuan**: ia mengubah hitungan "saat ini di" tetapi tidak pernah membuat peristiwa "dicapai".

### 3.2 Penghitung

Penghitung hanya naik; setiap angka yang ditampilkan diturunkan saat baca dari penghitung monotonik, persis seperti kontrak metrik. Ada dua keluarga dan selalu diberi label:

- **Dicapai (kohort, "pernah")**: jumlah lead dalam kohort yang **pertama kali masuk** ke sebuah kategori kapan saja sampai `asOf`. Lead dihitung sekali per kategori, pada masuk pertamanya, apa pun yang dilakukannya kemudian. Hitungan dicapai tidak pernah turun karena lead kemudian pindah.
- **Saat ini di (snapshot)**: lead yang transisi terakhirnya berada di kategori itu pada `asOf`. Ia snapshot dan diberi label demikian; tidak pernah dipakai sebagai pembilang funnel.

| KPI                                          | Definisi (pembilang)                                                                                                                                                                                                                                                                                                                                                           | Kunci kohort                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `leads_received`                             | Jumlah lead berbeda dengan event `lead.created` dalam jendela. Lead yang digabung keluar dikurangkan selama penggabungan berlaku dan dipulihkan oleh `merge_reverted`.                                                                                                                                                                                                         | hari `created` di zona waktu tenant |
| `leads_contacted`                            | Lead yang pertama kali masuk kategori `working` setelah `new`.                                                                                                                                                                                                                                                                                                                 | hari `created` lead                 |
| `leads_qualified`                            | Lead yang pertama kali masuk `qualified`.                                                                                                                                                                                                                                                                                                                                      | hari `created` lead                 |
| `leads_registered`                           | Lead dengan tautan commerce hidup yang `evidenceKind`-nya `customer_registration`, dari `awcms.commerce.customer.converted`.                                                                                                                                                                                                                                                   | hari `created` lead                 |
| `leads_converted`                            | Lead dengan konversi **hidup**: `lead.converted` dikurangi `lead.conversion_reversed`, dan (untuk konversi berbukti commerce) tautan tidak berstatus dibalik.                                                                                                                                                                                                                  | hari `created` lead                 |
| `leads_lost`                                 | Lead yang pertama kali masuk `lost` atau `disqualified`, dipecah menurut kategori (`lost` atau `disqualified`), sumber, dan kategori yang ditinggalkan lead; lead yang dibuka kembali tidak lagi hilang saat baca.                                                                                                                                                             | hari `created` lead                 |
| `follow_ups_completed`, `follow_ups_overdue` | Didefinisikan hanya namanya; pembilang dan otoritas event menunggu Q2.                                                                                                                                                                                                                                                                                                         | hari jatuh tempo tugas              |
| `attrition_by_reason`                        | **Belum dapat dihitung.** Alasan hilangnya lead adalah teks bebas (`reason`, panjang terbatas), terhapus bersama lead, dan sengaja tidak ada di event mana pun; ia tidak pernah dibaca, diurai, atau dibucket. Rincian alasan memerlukan **katalog kode alasan tertutup** milik `crm_leads` (Q6). Sampai ada, KPI mengembalikan `null` dengan `reason: "no_reason_catalogue"`. | hari `created` lead                 |
| `acquisition_cost`                           | **Dilaporkan hanya bila ada sumber biaya** (biaya kampanye atau channel yang dicatat modul pemiliknya). Selain itu nilainya `null` (tak diketahui), bukan `0`.                                                                                                                                                                                                                 | kampanye atau channel dan hari      |

`leads_registered` dan `leads_converted` hanya dapat **dihitung untuk lead yang telah ditautkan seseorang**: commerce tidak pernah mencocokkan lead lewat telepon, e-mail, atau handle (ADR-0056 D1), sehingga pelanggan yang mendaftar tanpa tautan terkonfirmasi **bukan** lead terdaftar. Dasbor boleh menampilkan registrasi pelanggan sisi commerce di samping funnel sebagai angka terpisah tanpa atribusi, tidak pernah dijumlahkan ke dalamnya.

### 3.3 Konversi antartahap dan drop-off

`konversi(A ke B) = dicapai(B) / dicapai(A)` pada **kohort yang sama** (lead yang dibuat dalam jendela), dihitung dari penghitung dicapai. Drop-off adalah `1 - konversi`. Karena pembilang dan penyebut berada pada satu kohort, lead yang masih berjalan menurunkan laju sampai ia maju; setiap respons karenanya membawa `cohortMaturityDays` (median usia lead dalam kohort) dan penanda `provisional: true` selama lead terbaru kohort lebih muda dari kematangan yang dikonfigurasi tenant (bawaan 30 hari, parameter kontrak). Laju tidak pernah disajikan sebagai final selagi provisional.

### 3.4 Versi pipeline

Kohort yang melintasi revisi pipeline dilaporkan pada kategori, yang stabil antarrevisi. Drill-down menurut `pipelineRevision` tepat untuk lead yang dibuat di bawah revisi itu dan diberi label "campuran" untuk lead yang dimigrasi antarrevisi. Memfilter revisi tak dikenal atau yang dipensiunkan mengembalikan hasil kosong tanpa kesalahan.

## 4. Konversi dari fakta commerce terverifikasi

- **Otoritas.** Konversi dihitung hanya bila lead memiliki tautan hidup yang dibuat oleh `POST /api/v1/commerce/crm-lead-links` (ADR-0056), yang buktinya diverifikasi server: registrasi terverifikasi OTP, atau pesanan lunas milik pelanggan itu. Tanda terima pesan, status pengiriman, klik, atau balasan **tidak pernah** menjadi konversi.
- **Nilai konversi.** Bila buktinya pesanan lunas, nilainya adalah **total lunas pesanan itu dikurangi refund yang selesai**, dalam sen bilangan bulat, dari fakta pesanan dan refund yang sudah dikonsumsi di tempat lain (loyalti, komisi). Refund setelah jendela me-restate hari konversi aslinya menurut aturan restatement (bagian 8), bukan hari refund. Konversi berbukti registrasi **tidak bernilai** (`null`), bukan `0`.
- **Pembalikan.** Tautan bertanda `reversal_pending` **tetap dihitung terkonversi** sampai seseorang menerapkan pembalikan, karena penanda adalah permintaan dan konversi CRM masih berlaku; respons menampilkan hitungan `reversalPending` terpisah agar pemilik melihat eksposurnya. Setelah orang itu membalikkannya, konversi keluar dari pembilang dan hari tempat ia dihitung di-restate.
- **Waktu menuju konversi.** `convertedAt - createdAt` lead, sebagai distribusi (median dan persentil atas kohort), bukan rata-rata.
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

- **Mulai.** Waktu terima server yang dicatat inbox untuk interaksi masuk pertama yang belum dijawab dari sebuah percakapan (instan jam SLA-nya mulai). **Berhenti.** Waktu server **catatan respons manusia** pertama yang menjawabnya. Pengakuan otomatis, gema template, balasan di luar kantor, dan balasan bot **tidak menghentikan jam**. Kedua instan adalah stempel waktu inbox sendiri; waktu kirim atau antar penyedia tidak pernah dipakai.
- **Ukur.** **Menit kerja** yang berlalu antara mulai dan berhenti, memakai kebijakan SLA yang berlaku untuk tenant atau lingkup bisnis percakapan (zona IANA, jendela hari kerja, hari libur; kebijakan inbox adalah sumber tunggal, kontrak ini tidak mendefinisikan kalender kedua). Waktu di luar jam kerja dan pada hari libur **tidak dihitung terhadap staf**. Versi kebijakan yang dipakai dicatat bersama angkanya.
- **Jeda.** Waktu percakapan berstatus `pending` (menunggu pelanggan) dijeda dan ditampilkan di respons, tidak disembunyikan.
- **Terlambat.** Percakapan terlambat bila anggaran menit kerjanya terlampaui dan belum ada respons tercatat; ia terlambat **sekali** (satu stempel pelanggaran), seberapa pun banyak pemeriksaan berjalan.
- **Distribusi, bukan rata-rata.** Laporan memberi jumlah terjawab, median dan persentil ke-90 menit kerja menuju respons pertama, persentase dalam anggaran, dan jumlah terlambat. Rata-rata tidak pernah menjadi judul.

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

> **Bentuk-bentuk ini adalah usulan untuk diterima atau diubah pemilik.** Bentuk ini **tidak** ditambahkan ke dokumen OpenAPI dan tidak ada rute, sehingga gerbang paritas rute (`ROUTE_PARITY_EXEMPTIONS`, yang harus tetap kosong) tidak terpengaruh. Issue pembangunan pertama yang mengimplementasikan salah satunya menambahkan path OpenAPI dan handler-nya **bersamaan**, sesuai aturan contract-first ADR-0016 dan `AGENTS.md`. Path mengikuti konvensi `/api/v1/reports/...` yang ada dan ADR penamaan akhir dialokasikan saat pembangunan. Uang berupa string, hitungan bilangan bulat, instan RFC 3339 UTC.

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
    { "category": "converted", "reached": 18, "currentlyIn": 18, "reversalPending": 1, "conversionFromPrevious": { } },
    { "category": "lost", "reached": 33, "bySource": [{ "sourceKind": "api", "count": 20 }] }
  ],
  "registered": { "numerator": 25, "denominator": 120, "rate": "0.2083", "suppressed": false },
  "timeToConvertDays": { "median": 9, "p90": 21, "observations": 18, "suppressed": false }
}
```

### 10.4 `GET /api/v1/reports/crm/attribution`

```jsonc
"data": {
  "model": "first_touch",
  "rows": [
    { "key": { "channel": "whatsapp", "channelAccountRef": "acc_opaque", "campaignRef": "cmp_opaque" },
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
    "pendingPausedMinutes": 3120
  },
  "queueWait": { "businessMinutes": { "median": 4, "p90": 11 } },
  "staff": [
    { "assigneeRef": "usr_opaque", "handled": 64, "outsideHoursShare": "0.18", "channels": [{ "channel": "whatsapp", "count": 50 }],
      "withinBudget": { }, "suppressed": false }
  ]
}
```

`staff` hanya dikembalikan kepada pemanggil yang berhak, tidak pernah diurutkan menurut waktu respons, dan operator di bawah ambang dilebur ke baris tim.

### 10.6 Ekspor

`GET` pada path yang sama dengan `format=csv` mengembalikan CSV aman-formula bagian 9.3; permintaan besar mengembalikan `202` dengan referensi job. Drill-down adalah panggilan terpisah yang diotorisasi ulang pada rute daftar modul sumber, bukan pada path KPI.

## 11. Daftar periksa persetujuan pemilik (gerbang untuk kode proyeksi apa pun)

Pemilik menerima kontrak dengan mencentang setiap kotak **dalam keputusan tercatat** (ADR atau amandemen bertanggal dokumen ini yang menyebut versi yang diterima). Tidak ada yang dicentang agen.

- [ ] **S1.** Tahap funnel adalah enam kategori tertutup, dengan "dicapai" (pernah, sekali per lead) sebagai pembilang funnel dan "saat ini di" sebagai snapshot berlabel (bagian 3).
- [ ] **S2.** Pemetaan ulang `stage_migrated` tidak pernah menjadi kemajuan (bagian 3.1).
- [ ] **S3.** `leads_registered` dan `leads_converted` menghitung **hanya lead yang tertaut**; registrasi pelanggan tak tertaut ditampilkan terpisah, tidak pernah dijumlahkan (bagian 3.2).
- [ ] **S4.** Konversi dikreditkan hanya dari fakta commerce terverifikasi, tidak pernah dari tanda terima pesan; tautan `reversal_pending` tetap dihitung sampai seseorang membalikkannya, dan eksposurnya ditampilkan (bagian 4).
- [ ] **S5.** Nilai konversi adalah total lunas dikurangi refund selesai, di-restate pada hari aslinya; konversi registrasi tidak bernilai (bagian 4).
- [ ] **S6.** Atribusi adalah **sentuhan pertama**, dengan lookback bawaan **90 hari** (Q3), unattributed dan unknown dilaporkan sebagai bucket sendiri (bagian 5).
- [ ] **S7.** Respons bermakna pertama berjalan dari penerimaan tercatat inbox sampai catatan respons **manusia** pertama, dalam menit kerja menurut kebijakan SLA inbox sendiri, dengan waktu pending dijeda dan balasan otomatis tidak menghentikan jam (bagian 6.1).
- [ ] **S8.** Angka staf memakai penugasan aktual, dipecah saat transfer manual, tidak pernah meranking operator, dan membebankan waktu tunggu antrean ke tim (bagian 6.2).
- [ ] **S9.** Penyebut nol adalah `null` dengan alasan; tak dikenal tidak pernah `0` (bagian 7).
- [ ] **S10.** Ambang sel kecil adalah **5**, dapat dinaikkan tenant dan tidak dapat diturunkan, dengan penekanan komplementer (bagian 7).
- [ ] **S11.** Agregat tidak memuat PII atau teks bebas; drill-down mengotorisasi ulang per baris (bagian 9.1).
- [ ] **S12.** Setiap ekspor melalui `csvCellForWrite`, menulis sel tertekan kosong dengan penanda, dan diaudit (bagian 9.3).
- [ ] **S13.** Bucket zona waktu tenant, jendela restatement 35 hari, dan paritas replay adalah syarat penerimaan (bagian 8).
- [ ] **S14.** Bentuk respons bagian 10 diterima (atau diamandemen) sebagai kontrak awal untuk issue pembangunan pertama.
- [ ] **S15.** UX layar laporan diterima pada langkah 4 alur produk (UX-26 di [`omnichannel-crm-ui-ux.md`](omnichannel-crm-ui-ux.id.md) adalah kandidatnya) **sebelum** model data proyeksi.

**Pertanyaan terbuka yang memblokir pembangunan, bukan kontrak:**

- **Q1.** Upstream tidak memiliki event untuk respons atau penugasan inbox. Mana yang dipilih pemilik: upstream menerbitkan event, atau port baca yang ditinjau atas riwayat aktivitas inbox? (Bagian 2.)
- **Q2.** KPI tindak lanjut (`follow_ups_completed`, `follow_ups_overdue`) menunggu sumber sebanding dari `crm_follow_up`.
- **Q3.** Apakah 90 hari lookback bawaan yang tepat untuk siklus penjualan tenant, dan bolehkah tenant mengubahnya (perubahan adalah versi kontrak baru)?
- **Q4.** Di mana sumber biaya dicatat, dan oleh modul mana, belum ditetapkan; KPI biaya tetap `null` sampai ada.
- **Q6.** Rincian alasan hilang (CRM-070 "attrition reasons") memerlukan `crm_leads` upstream mengadopsi katalog kode alasan tertutup dan menerbitkan kodenya pada `lead.lost`; saat ini alasan adalah teks bebas yang dijaga keluar dari event, sehingga KPI `null` alih-alih ditebak.
- **Q5.** Kepemilikan: proyeksi lintas domain dispesifikasikan di sini (aturan kontrak metrik untuk proyeksi yang menggabungkan modul), dan bagian generiknya diusulkan ke upstream; pemilik mengonfirmasi pembagian dan ADR yang mencatatnya.

## 12. Yang tidak dilakukan dokumen ini

Ia tidak menambah proyeksi, migrasi, rute, path OpenAPI, dasbor, atau layar; tidak mengubah `crm_leads`, `omnichannel_inbox`, atau `crm_follow_up`; tidak meranking staf; dan tidak mengklaim angka mana pun di atas ada hari ini. Pembangunan dibatasi bagian 11 dan dependensi biasa issue #464 (modul pipeline, inbox, dan tindak lanjut upstream, serta tautan commerce #463, yang sudah mendarat).
