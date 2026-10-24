🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](crm-omnichannel-requirements.md)

<!-- i18n-source-hash: sha256:24f42736d60dc3b46c2adc612835265ed678e00d5039706110fa9470fdd8b0a1 -->

# Standar kebutuhan CRM omnichannel — reusable (v1.0, usulan)

> **Klasifikasi:** standar kebutuhan target / masukan Definition of Ready, **BUKAN pernyataan fitur sudah tersedia**. Kondisi implementasi yang berlaku tercatat di [status.md](status.id.md). Lingkup: template `ahliweb/awcms-one`, produk turunannya, dan fondasi generik yang dimiliki [`ahliweb/awcms`](https://github.com/ahliweb/awcms). Pelacakan [#462](https://github.com/ahliweb/awcms-one/issues/462). Posisi pemeriksaan **24 Oktober 2026**.

## 1. Asal kebutuhan, batas dokumen sumber, dan keputusan generalisasi

Dokumen ini berangkat dari berkas pengguna **“SPESIFIKASI KEBUTUHAN SISTEM CRM OMNICHANNEL LPP ENTER”**, lima halaman, ditelaah pada 24 Oktober 2026. Hasilnya dibandingkan dengan [PRD AW Business Platform](aw-business-platform-prd.id.md), [ADR-0024](adr/0024-awcms-one-is-template-only-derived-apps-own-their-backend.md), [ADR-0040](adr/0040-aw-business-platform-capability-ownership-and-boundaries.md), kode terbaru dan blueprint omnichannel multi-akun v1.2.0 sebelumnya. Dokumen khusus pelanggan **tidak disalin menjadi konfigurasi baku template**.

**Bagian yang benar-benar ada di sumber:** §1 Dashboard Utama; §2 Integrasi Omnichannel; §3 Unified Inbox; §6 WA Blast; §7 Follow-up Automation; §8 AI Assistant Marketing; §9 Laporan Marketing dan Admin; §10 Notifikasi. **Bagian bernomor 4 dan 5 tidak terdapat di dokumen sumber.** Kebutuhan lead/pipeline dan adapter pendaftaran di bawah adalah **rekomendasi pelengkap hasil analisis**, bukan kutipan dari dua bagian yang tidak tersedia.

**Aturan generalisasi:** kebutuhan dasar harus cocok untuk retail, layanan, media, agency, pendidikan dan turunan lainnya. Istilah LPP ENTER seperti “program pelatihan”, “angkatan”, “pendaftar” dan “daftar ulang” menjadi **dimensi dan tahap pipeline yang dapat dikonfigurasi**; bukan kolom wajib khusus lembaga pendidikan, nama tenant bawaan, data seed atau tahapan universal. Klaim penempatan kerja atau jaminan keberangkatan luar negeri merupakan larangan/aturan persetujuan dalam profil bisnis tertentu.

**Keputusan bisnis WhatsApp / pengganti persyaratan sumber (24 Oktober 2026):** sumber §2 dan §6 semula mensyaratkan API WhatsApp resmi. **Pemilik produk kini secara eksplisit menggantikan syarat transport tersebut untuk LPP ENTER:** **StarSender adalah provider default produk**, dan **Meta WhatsApp Cloud API tetap tersedia sebagai pilihan alternatif**. Redaksi asli tetap dicatat sebagai *riwayat persyaratan yang digantikan*, bukan acceptance criterion yang masih berlaku. StarSender **bukan mitra API resmi Meta** dan memiliki risiko pemblokiran nomor; operator harus menerima risiko secara sadar sekaligus menjaga persetujuan penerima, pemulihan, dan perlindungan data. Pilihan bisnis ini tidak membuktikan kepatuhan kebijakan WhatsApp atau menjamin pesan sampai. **Template AWCMS-One tidak memiliki provider default global yang di-hard-code**; konfigurasi default bersifat per tenant/brand dan produk LPP menetapkan StarSender setelah koneksi device autentik/healthy. Aturan template dan jendela 24 jam Meta hanya diterapkan untuk jalur Meta; StarSender memakai kemampuan providernya sendiri, tanpa klaim approval Meta. Ketersediaan API bukan izin mengirim semua pesan.

## 2. Kepemilikan modul dan larangan duplikasi

| Otoritas | Tanggung jawab | Bukan tanggung jawab |
| --- | --- | --- |
| AWCMS upstream | Tenant, RBAC/ABAC/RLS, registry multi-akun, OAuth/referensi kredensial, kontrak interaksi masuk terverifikasi, port pengiriman/publikasi, notifikasi, workflow approval, reporting engine | Aturan biaya/angkatan/pendaftaran lembaga tertentu |
| AWCMS-One `commerce` | Customer master yang sudah ada, segmen terversi, kampanye berdasarkan consent, fakta konversi commerce dan adapter/proyeksi yang dibenarkan | `crm_customer` kedua, outbox pengiriman duplikat, panggilan langsung provider dari transaksi |
| Repo produk turunan | Tahap dan atribut bisnis, event konversi final seperti pendaftaran/daftar ulang, UAT dan deployment | Ketergantungan produksi pada backend template referensi |
| Hermes Agent | Penalaran, routing model, skills, sesi dan runtime agen | Data pelanggan otoritatif, kredensial provider dan pengiriman yang tidak lolos aturan |
| OMES | Siklus hidup host, health, backup, kontrol keamanan dan jaminan runtime | Runtime agen kedua, mesin CRM kedua atau arbitrary shell |
| AWCMS Control Center | Perizinan tenant, otorisasi deterministik, review/persetujuan, proyeksi dan audit | Database pribadi Hermes, prompt mentah dan secret agen |

**Sudah terverifikasi:** akun customer commerce, segmentasi, audience campaign email/WhatsApp, Mailketing v1, newsletter, suppression email, Telegram *staf saja*, antrean WhatsApp generik dan pemantauan OMES/Hermes. **Belum terbukti lengkap:** lead/prospect/pipeline generik, unified inbox lintas provider beserta assignment, follow-up engine, atribusi konversi generik, routing multi-sender, social publishing, otomasi AI untuk CRM dan seluruh KPI CRM. Epic yang sudah ditutup bukan bukti semua kemampuan itu sudah berjalan.

## 3. Katalog kebutuhan fungsional (MUST kecuali ditetapkan lain)

### 3.1 Identitas lead, lifecycle dan ekstensi bisnis — rekomendasi pelengkap (§§4–5 tidak ada)

- **CRM-001** Identitas lead/prospect per tenant dengan sumber dan audit; tautkan ke customer commerce melalui mekanisme verifikasi dan kewenangan, **bukan membuat master customer ganda**. Lead boleh ada sebelum seseorang menjadi pelanggan.
- **CRM-002** Tangkap lead dari form website terverifikasi, event/pesan sosial yang diizinkan, input manual, impor CSV/XLSX hasil pratinjau. Simpan kanal, akun, kampanye, UTM, waktu, bukti persetujuan dan keandalan sumber.
- **CRM-003** Pipeline tahapan berversi dan dapat diatur per tenant, transisi berizin, histori dan alasan. Contoh `baru → dihubungi → potensial → follow_up → terdaftar → konversi`; lembaga pelatihan boleh mengonfigurasi tahap `daftar_ulang`, toko dapat memakai `penawaran → lunas`. Bukan status tetap di seluruh bisnis.
- **CRM-004** Penanggung jawab, tim, cabang/brand, minat layanan, label, atribut kustom, calon duplikat serta proses penggabungan berizin dan teraudit. Nama pengguna media sosial bukan ID orang yang otomatis dianggap sama dengan kontak CRM.
- **CRM-005** Opportunity/deal, nilai perkiraan dan won/lost **opsional** setelah admission sendiri; pesan masuk tidak otomatis merupakan pendaftaran atau pembayaran sah.
- **CRM-006** Retensi, ekspor/penghapusan subjek data, tujuan pemrosesan, pemisahan PII dan catatan pelanggan dari agregasi KPI/AI pihak ketiga.
- **CRM-007** Dua tenant dengan alamat/nomor/handle sama tidak boleh saling melihat, mencocokkan atau menggabungkan lead (FORCE RLS dan default-deny).

### 3.2 Executive Dashboard — sumber §1

- **CRM-010** Agregasi lead hari/minggu/bulan/periode bebas berdasarkan kanal, akun, kampanye, dimensi bisnis, tahap, admin dan tim.
- **CRM-011** Hitungan lead baru/direspons/potensial/follow-up/pendaftar/konversi, pesan belum dibalas, pekerjaan terlambat, tren, perpindahan funnel dan rasio konversi; tangani pembagi nol.
- **CRM-012** Filter dan drill-down sesuai hak akses, ekspor CSV/Excel dan PDF opsional dengan netralisasi formula spreadsheet serta masking PII.
- **CRM-013** Setiap KPI memiliki definisi event otoritatif, pembilang/penyebut, zona waktu, rentang tanggal, deduplikasi, jendela atribusi, dan keadaan `unknown`; data provider yang tidak ada bukan keberhasilan.

### 3.3 Akun terhubung, integrasi sosial — sumber §2

- **CRM-020** Banyak akun per tenant/platform (dibatasi lisensi/kuota kebijakan, bukan satu akun per platform): WhatsApp Meta Cloud API serta device StarSender dengan persetujuan risiko operator, Facebook Page/Messenger, Instagram Professional, TikTok, YouTube, LinkedIn Page, Threads, bot/channel Telegram, Mailketing, domain website dan platform lain yang diizinkan.
- **CRM-021** Matriks kemampuan riil per akun `publish/reply/dm/inbound/comments/analytics/lead_ads/broadcast`; tolak tindakan yang tidak didukung. Jangan mengklaim TikTok DM umum, pemanfaatan data anggota LinkedIn untuk enrichment CRM, atau YouTube DM.
- **CRM-022** OAuth/persetujuan, token via referensi secret, kedaluwarsa/pencabutan, status koneksi, kuota, verifikasi sender, perizinan minimum dan peringatan. Secret tidak tampil di browser, AI, log atau issue.
- **CRM-023** Hanya event masuk resmi yang dapat diautentikasi; verifikasi webhook, binding akun + tenant, batas ukuran, deduplikasi, proteksi replay dan fetch media aman; event tanpa autentikasi tidak boleh langsung mengubah fakta CRM.
- **CRM-024** Tombol share/follow sosial pada situs bukan bukti akun API sudah terhubung.

### 3.4 Unified Inbox dan SLA — sumber §3

- **CRM-030** Satu **proyeksi** percakapan lintas provider yang memang diizinkan, dengan identitas akun/thread asli; bukan customer master tambahan atau klaim semua platform dapat membalas.
- **CRM-031** Pencarian/filter akun, kanal, waktu, kontak, penanggung jawab, tahap/status dan dimensi bisnis; status dibaca/dikirim harus sesuai yang tersedia atau diberi label tidak diketahui.
- **CRM-032** Assignment/reassignment dengan audit, catatan internal yang tak terkirim keluar, tag, jawaban cepat, lampiran yang disetujui kanal, tutup/buka kembali, follow-up dan kendali konflik antaroperator.
- **CRM-033** Balasan hanya pada jendela/perizinan resmi dan sender yang cocok; ketika tidak tersedia UI menjelaskan alasan pengiriman tidak diizinkan.
- **CRM-034** SLA tenant/kanal dan kalender jam kerja: waktu antre, first meaningful response, tenggat, eskalasi dan hari libur. Waktu di luar jam kerja ditandai agar evaluasi pegawai adil.
- **CRM-035** Hindari admin ganda atau AI dan manusia membalas pesan sama tanpa sengaja melalui concurrency dan idempotensi.

### 3.5 Broadcast dan kampanye — sumber §6

- **CRM-040** Impor data kontak dengan dry-run, validasi, dedup dan mitigasi CSV injection; nomor/email hasil impor **tidak otomatis menjadi persetujuan marketing**.
- **CRM-041** Audience dari segmen CRM/customer dan persetujuan penerima, snapshot versi segmen tetap; program/angkatan/wilayah/sumber/status/tanggal interaksi hanya bila dimensi produk tersedia.
- **CRM-042** Definisi template/pesan terversi, personalisasi dan preview; template persetujuan Meta **khusus jalur Meta Cloud API**, sedangkan StarSender memvalidasi format pesan dan kemampuan API miliknya tanpa mengklaim persetujuan Meta. Kirim uji, jadwal, pembatalan/retry aman, kuota/biaya, persetujuan manusia, dan cek opt-out saat enqueue **serta saat kirim**.
- **CRM-043** Status penerima dibedakan `queued/provider_accepted/delivered` (hanya jika tervalidasi), `failed/suppressed/replied`; log korelasi, bounce, opt-out dan replay; diterima provider bukan bukti delivered.
- **CRM-044** Atribusi balasan, lead aktif kembali, pendaftaran, konversi akhir dan biaya hanya bila event otoritatif serta tautan kampanye benar-benar dapat ditelusuri. `Unknown` tidak dianggap nol.
- **CRM-045** Pertahankan satu antrean yang sudah ada per kanal; jangan bangun universal blast tanpa aturan atau fallback WhatsApp→Telegram→Email otomatis setelah gagal/consent dicabut.
- **CRM-046** Mailketing dan newsletter mengikuti API yang benar-benar tersedia, double opt-in dan suppression; Telegram notifikasi staf tidak dipakai untuk pemasaran pelanggan.

### 3.6 Otomasi follow-up — sumber §7

- **CRM-050** Workflow konfigurabel dari tahapan lead, pesan belum dibalas, tenggat, pendaftaran sah atau event kampanye, menggunakan aturan berversi, simulasi dan job teraudit.
- **CRM-051** Daftar kerja harian pemilik/tim, tugas manual, overdue/escalation, SLA, template dan batas frekuensi.
- **CRM-052** Batalkan/evaluasi ulang pesan berikutnya ketika lead membalas, mendaftar, berkonversi, mengirim `/stop`, unsubscribe, terkena suppression, consent dicabut atau sender tidak aktif.
- **CRM-053** Persetujuan manusia untuk kampanye dan respons sensitif; pemeriksaan kebijakan deterministik **setelah saran AI dan tepat sebelum enqueue**.

### 3.7 AI knowledge dan marketing — sumber §8

- **CRM-060** AI menyusun draf, meringkas, klasifikasi minat/tahap, saran follow-up, copy kampanye dan menemukan pertanyaan yang belum ada jawaban resmi, dengan biaya serta jejak per tenant.
- **CRM-061** Jawaban program/produk, syarat, harga, jadwal, lokasi, fasilitas dan pendaftaran harus berdasarkan **knowledge resmi, disetujui, berversi dan bertanggal berlaku**; ketidakpastian/konflik wajib eskalasi.
- **CRM-062** Tiga mode: `assist` (default, admin menyetujui), `limited_auto` (FAQ terverifikasi berisiko rendah dan hanya kanal/jendela yang diizinkan), `escalate` (sensitif, keluhan, penawaran biaya khusus, informasi tidak pasti). Operator bisa menonaktifkan mode otomatis segera.
- **CRM-063** AI **tidak boleh mengarang harga, syarat, jaminan pekerjaan, jaminan keberangkatan luar negeri atau klaim tanpa persetujuan**. Contoh LPP ini harus menjadi kebijakan larangan klaim yang bisa dikonfigurasi, bukan fitur khusus template.
- **CRM-064** Hermes sebagai runtime; OMES sebagai host assurance/observabilitas yang terdukung; AWCMS sebagai otoritas tenant/knowledge/approval/outbound. Proteksi prompt injection dan egress data RESTRICTED ke cloud.

### 3.8 Pelaporan, notifikasi, operasional — sumber §§9–10

- **CRM-070** Laporan marketing: lead per waktu/kanal/kampanye, perpindahan tahap, rasio respons, atribusi, alasan batal, biaya akuisisi ketika tersedia.
- **CRM-071** Laporan admin: jumlah percakapan, follow-up selesai/terlambat, sebaran waktu respons pertama, kontribusi konversi, aktivitas, memperhitungkan jam kerja, jumlah tugas dan perbedaan kanal.
- **CRM-072** Notifikasi per peran: pesan/lead baru, pesan belum dibalas, follow-up terlambat, kampanye dijadwalkan/selesai/gagal, koneksi API putus dan ringkasan harian, dengan dedup dan quiet hours.
- **CRM-073** Diagnostik webhook gagal, token expired, data provider basi, antrian tertunda/dead-letter, biaya dan rotasi secret, log audit tanpa isi pesan sensitif.

## 4. Skenario penerimaan dan gerbang rilis

| Tes | Bukti yang wajib diperlihatkan |
| --- | --- |
| **AT-01** | Dua tenant dengan banyak akun provider yang sama tidak dapat melihat/mengubah data atau sender tenant lain (FORCE RLS dan default-deny). |
| **AT-02** | Lead dari website berproses menjadi opportunity/customer/konversi tanpa master customer ganda; sumber kampanye dan transisi tercatat. |
| **AT-03** | Retry webhook hanya menghasilkan satu interaksi; assignment tepat; reply tidak didukung provider tetap ditolak. |
| **AT-04** | Jadwal follow-up menghormati jam kerja/libur; balasan atau opt-out sebelum dispatch menghentikan pesan lanjutan. |
| **AT-05** | Impor duplikat, sender tidak aktif/tak terverifikasi, consent hilang atau DM sosial tak diizinkan harus ditolak; default StarSender memilih device sah per tenant, pilihan Meta eksplisit hanya WABA/nomor sah; tanpa fallback diam-diam atau kirim ganda. |
| **AT-06** | Status queued/diterima provider/terkirim/bounce/dibalas/pendaftaran/konversi dicatat berbeda; tanpa data berarti unknown. |
| **AT-07** | AI hanya memakai knowledge terverifikasi; janji/harga tak disetujui dieskalasi; prompt injection tidak bisa memanggil tool atau menghindari approval. |
| **AT-08** | KPI dapat di-rebuild dari event yang sama; perhitungan SLA dan denominator konversi konsisten. |
| **AT-09** | Penarikan consent, ekspor/hapus data, isolasi tenant, redaksi audit, rotasi secret, webhook palsu dan CSV formula berbahaya diuji. |
| **AT-10** | Build profil `toko`, `berita`, `landing` dan `template:init` lulus tanpa konten/branding/kredensial spesifik pelanggan. |

**Definition of Ready:** glosarium dan pipeline, keputusan ADR ownership, threat model dan penilaian UU PDP 27/2022, ERD dan kamus data, RBAC/ABAC/FORCE RLS, matriks kemampuan provider, OpenAPI/AsyncAPI, UX/WCAG, kalender SLA, model persetujuan, definisi KPI, fixtures, operasional dan rollback.

## 5. Status dan referensi issue

| Kapabilitas | Status terverifikasi pada `main` (24 Oktober 2026) | Pelacakan |
| --- | --- | --- |
| Customer commerce, aturan segmen, audience campaign | **Sudah ada** dalam lingkup commerce | [PRD bisnis](aw-business-platform-prd.id.md), [status](status.id.md) |
| Email/Mailketing v1, newsletter dan suppression | **Sudah ada** dari upstream | [AWCMS email](https://github.com/ahliweb/awcms/blob/main/src/modules/email/README.md) |
| Pipeline lead/prospect generik | **Belum terbukti** sebagai modul reusable | [AWCMS #1163](https://github.com/ahliweb/awcms/issues/1163) (ADR), [#1166](https://github.com/ahliweb/awcms/issues/1166) (implementasi) |
| Inbox lintas provider, assignment dan SLA | **Belum terbukti**; inbox commerce lebih sempit | [AWCMS #1144](https://github.com/ahliweb/awcms/issues/1144) (arsitektur), [#1164](https://github.com/ahliweb/awcms/issues/1164) (inbox/SLA) |
| Registry multi-akun dan OAuth | **Direncanakan** | [AWCMS #1139](https://github.com/ahliweb/awcms/issues/1139), [#1140](https://github.com/ahliweb/awcms/issues/1140) |
| Multi-nomor StarSender dan Meta | **Direncanakan**; konfigurasi LPP: StarSender default, Meta alternatif (keputusan pemilik menggantikan klausul sumber) | [AWCMS #1141](https://github.com/ahliweb/awcms/issues/1141)–[#1143](https://github.com/ahliweb/awcms/issues/1143), [AWCMS-One #458](https://github.com/ahliweb/awcms-one/issues/458) |
| Telegram notifikasi staf | **Sudah ada**; khusus staf | [Modul AWCMS](https://github.com/ahliweb/awcms/blob/main/src/modules/telegram-delivery/README.md) |
| Telegram CRM dan publikasi channel | **Direncanakan** pada konteks terpisah | [AWCMS #1155](https://github.com/ahliweb/awcms/issues/1155)–[#1157](https://github.com/ahliweb/awcms/issues/1157), [AWCMS-One #460](https://github.com/ahliweb/awcms-one/issues/460) |
| Publikasi sosial dan inbox media lainnya | **Direncanakan**, port social sekarang no-op | [AWCMS #1145](https://github.com/ahliweb/awcms/issues/1145) dan isu provider |
| Mailketing v2/multi-sender/webhook | **Direncanakan** | [AWCMS #1158](https://github.com/ahliweb/awcms/issues/1158)–[#1162](https://github.com/ahliweb/awcms/issues/1162), [AWCMS-One #461](https://github.com/ahliweb/awcms-one/issues/461) |
| Rekomendasi CRM Hermes dan AI Management | **Direncanakan**, pengamatan OMES sudah tersedia | [AWCMS-One #459](https://github.com/ahliweb/awcms-one/issues/459), [OMES #343](https://github.com/ahliweb/omes/issues/343)–[#344](https://github.com/ahliweb/omes/issues/344) |
| Rangkaian follow-up dan KPI konversi CRM | **Belum terbukti** | [AWCMS #1165](https://github.com/ahliweb/awcms/issues/1165) (follow-up), [AWCMS-One #464](https://github.com/ahliweb/awcms-one/issues/464) (KPI) |

**Urutan implementasi:** putuskan ADR pipeline prospek, kontrak interaksi/SLA dan event; implementasi port generik upstream + tes; sinkronkan `apps/cms` dengan subtree **MERGE COMMIT** bersejarah utuh (tidak squash/rebase); buat adapter/proyeksi commerce di sini; jalankan tiga profil dan validasi template. Setiap perubahan pada issue/branch atomik. Tidak boleh mengubah migrasi terapan atau `bun.lock` secara manual.

## 6. Contoh pemetaan kebutuhan LPP ENTER (bukan default template)

| Istilah LPP ENTER | Ekstensi CRM netral | Sumber |
| --- | --- | --- |
| Program pelatihan | Dimensi minat produk/layanan | §§1, 6, 8, 9 |
| Angkatan | Dimensi cohort/kampanye opsional | §6 |
| Pendaftar | Tahap/event `registered` terkonfigurasi | §§1, 8, 9 |
| Daftar ulang | Event terverifikasi `converted` atau `re_registered` | §§1, 8, 9 |
| Admin marketing | Assignee/tim terbatas kewenangan | §§1, 3, 7, 9, 10 |
| Biaya/syarat/jadwal/program | Knowledge resmi dengan sumber dan masa berlaku | §8 |
| Pemilihan provider WhatsApp | **Keputusan LPP 24 Okt 2026:** `starsender` default per tenant/brand, `meta_cloud_api` alternatif; klausul resmi pada sumber §6 diganti oleh keputusan pemilik | §2, §6 + keputusan terbaru |
| Klaim penempatan kerja/keberangkatan | Aturan klaim terlarang dan eskalasi admin | §8 |

Tidak ada konten bisnis spesifik atau token provider yang dimasukkan ke template. Produk turunan AWCMS-One memiliki backend produksi, pengaturan tenant, UAT dan deployment sendiri. Dokumen asli bisnis semestinya disimpan di repositori kebutuhan produk tersebut, sedangkan standar ini hanya membawa kontrol yang berlaku umum.

## 7. Kepemilikan eksekusi atomik (kesenjangan tervalidasi, 24 Oktober 2026)

1. [AWCMS #1163](https://github.com/ahliweb/awcms/issues/1163) **arsitektur dulu** → [#1166](https://github.com/ahliweb/awcms/issues/1166) lifecycle generik `crm_leads`; pipeline netral dan tanpa customer master ganda.
2. [AWCMS #1144](https://github.com/ahliweb/awcms/issues/1144) arsitektur interaksi masuk terverifikasi → [#1164](https://github.com/ahliweb/awcms/issues/1164) unified inbox, assignment dan SLA; jangan menggantikan inbox commerce tanpa adapter yang disetujui.
3. [AWCMS #1165](https://github.com/ahliweb/awcms/issues/1165) tugas follow-up deterministik dan kebijakan notifikasi; gunakan kembali engine workflow/notifikasi.
4. [AWCMS-One #463](https://github.com/ahliweb/awcms-one/issues/463) **hanya adapter commerce** untuk lead→customer serta event konversi terverifikasi; tahapan produk tetap milik repo turunan.
5. [AWCMS-One #464](https://github.com/ahliweb/awcms-one/issues/464) proyeksi funnel/atribusi/SLA staf pada reporting engine; kunci definisi KPI sebelum coding.
6. Konsumen yang sudah dilacak: [#458](https://github.com/ahliweb/awcms-one/issues/458), [#459](https://github.com/ahliweb/awcms-one/issues/459), [#460](https://github.com/ahliweb/awcms-one/issues/460), [#461](https://github.com/ahliweb/awcms-one/issues/461), serta upstream [#1139](https://github.com/ahliweb/awcms/issues/1139)–[#1162](https://github.com/ahliweb/awcms/issues/1162) sesuai dependensi. Tidak membuat provider engine kedua.

Seluruh issue implementasi **masih terbuka/direncanakan** saat dokumen diterbitkan; memerlukan branch, PR dan validasi masing-masing. PR standar ini **hanya dokumentasi persyaratan**.

## 8. Kebijakan pemilihan provider WhatsApp — perubahan keputusan (24 Oktober 2026)

**Cakupan keputusan:** Pada aplikasi turunan **LPP ENTER**, `starsender` menjadi provider default setelah device tenant terdaftar/terverifikasi; `meta_cloud_api` tersedia sebagai provider alternatif yang dipilih secara eksplisit. **Template AWCMS-One** tetap **belum menetapkan default provider global** sehingga setiap turunan bisa memilih sesuai kebutuhan. Ini merupakan keputusan pemilik yang menggantikan syarat API resmi di sumber §2/§6, **bukan perubahan diam-diam pada dokumen historis**.

### Persyaratan routing multi-pengirim

- **WA-SEL-01** Simpan `tenant_id + business_scope/brand_id + default_sender_account_id + default_provider_kind` terverifikasi dan teraudit; hindari pemakaian sender global antar-tenant. Default `starsender` pada LPP hanya aktif setelah kredensial device, status layanan, consent dan penerimaan risiko memenuhi syarat; jika tidak, **fail closed**, bukan otomatis beralih Meta.
- **WA-SEL-02** Mendukung **banyak device StarSender** dan **banyak WABA/phone_number_id Meta**. Operator dapat melihat kesehatan, kemampuan, biaya dan memilih nomor tertentu. Perubahan provider perlu otorisasi dan versi konfigurasi prospektif; item antrean lama tetap memakai sender aslinya.
- **WA-SEL-03** Gunakan **antrean tunggal `whatsapp_delivery` upstream**. Untuk Meta Cloud API, terapkan template yang disetujui dan jendela layanan 24 jam bila relevan; untuk StarSender, validasi `messageType/body/media` dan endpoint sesuai dokumentasinya. Consent, suppression serta opt-out berlaku untuk **keduanya**.
- **WA-SEL-04** Tolak sender lintas tenant, pengiriman ganda, device StarSender putus/terblokir, token/nomor Meta dicabut, pesan/media yang tak didukung, consent hilang atau webhook lintas-tenant. Jangan rotasi nomor untuk mengakali aturan spam; rate limit/circuit breaker per sender, emergency stop dan eskalasi petugas.
- **WA-SEL-05** Bedakan status `queued`, `provider_accepted`, `verified_delivered`, `failed`, `unknown` dan `suppressed`. HTTP sukses StarSender **bukan bukti delivered**. Jika autentikasi webhook StarSender belum terbukti, jangan mengizinkan perubahan fakta CRM atau status final dari event tersebut; pakai `unknown` dan kontrol kompensasi tersetujui atau tunda intake.
- **WA-SEL-06** Tes minimal satu tenant default StarSender dengan dua device, pemilihan Meta dengan dua nomor, tenant kedua default berbeda, koneksi putus, pencabutan kredensial, webhook palsu, rollback, consent dicabut dan crash/duplikasi; profil `toko/berita/landing` tetap netral.

**Risiko dan komersial:** StarSender menyatakan layanannya *bukan API WhatsApp resmi* serta memperingatkan potensi pemblokiran akun/nomor. Operator wajib memahami risiko akun, privasi, kontinuitas dan vendor. Provider default adalah **keputusan deployment produk**, bukan dukungan resmi Meta, jaminan anti-blokir atau izin broadcast tanpa consent. [API Kirim StarSender](https://docs.starsender.online/docs/message-api/kirim-pesan/); [Webhook StarSender](https://docs.starsender.online/docs/webhook/); [FAQ StarSender](https://starsender.id/); [Kebijakan WhatsApp Business](https://whatsappbusiness.com/id/policy/).

**Pelacakan:** [AWCMS #1139](https://github.com/ahliweb/awcms/issues/1139) ADR, [#1141](https://github.com/ahliweb/awcms/issues/1141) routing, [#1142](https://github.com/ahliweb/awcms/issues/1142) StarSender, [#1143](https://github.com/ahliweb/awcms/issues/1143) Meta, [#1154](https://github.com/ahliweb/awcms/issues/1154) admin; [AWCMS-One #458](https://github.com/ahliweb/awcms-one/issues/458) kampanye CRM. Isu tes end-to-end ditautkan setelah dibuat.
