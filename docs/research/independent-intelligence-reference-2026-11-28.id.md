🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](independent-intelligence-reference-2026-11-28.md)

<!-- i18n-source-hash: sha256:9b7beafdb55b80f1e8bfdace666f7f5383a83c93e87d3cda84d052fcfcad033c -->

# Riset kapabilitas intelligence independen

## Metadata

- Versi: v1.3.0
- Terakhir diperbarui: 2026-11-28
- Changeset: verifikasi pengambilalihan; pernyataan vendor dihapus; rujukan yang tak dapat diverifikasi ditandai; mirror dan indeks ditambahkan.
- Status: hanya riset dan rujukan, **usulan**; tanpa kode produk, tanpa dependensi yang disetujui, tanpa keputusan Gerbang 9 atau Gerbang 15.
- Pelacak: #598 (tetap terbuka)
- Bukti: snapshot blob pada `origin/main` di `b95d76d54cbb482587ffb2b7ef6e409c48771838`: `AGENTS.md` `c6ed72f8b5a29c3559d67c5b905e9344227387cd`, `docs/template.md` `29ed1fea28a0ee069430e28b9b74d27cea0e4a42` (SHA blob, bukan SHA commit; dibaca ulang saat pengambilalihan). Audit penuh kode, migrasi, status issue, dan CI masih tertunda.

## Bukti dan kekayaan intelektual

Riset ini dipicu uraian publik sebuah produk komersial di bidang ini. Uraian itu adalah klaim mandiri vendor, tidak diuji secara independen, dan tidak dinilai di sini; catatan ini hanya memakai konsep fungsional umum dan standar terbuka. Tidak ada lisensi untuk mereproduksi produk pihak ketiga yang terbukti. Pakai konsep fungsional publik serta kebutuhan, spesifikasi, desain, dan implementasi yang orisinal. Tanpa kode, UI, aset, teks, dataset, merek, SDK berhak milik, aturan, atau API pihak ketiga, tanpa reverse engineering, dan tanpa pengujian tanpa izin.

Hukum hak cipta Indonesia (UU 28/2014) adalah konteks hukum untuk pembedaan antara ekspresi yang dilindungi dan ide atau metode ([UU 28/2014 di situs BPK](https://peraturan.bpk.go.id/Details/38690/uu-no-28-tahun-2014): halaman terbuka, tetapi pasal 40 dan 41 **tidak terverifikasi saat pengambilalihan**; [entri WIPO Lex](https://www.wipo.int/wipolex/en/legislation/details/15600) terbuka dan teks pasalnya tidak dibaca). Tinjauan paten, merek dagang, rahasia dagang, dan kontrak tetap diperlukan. Tidak ada dependensi yang diperkenalkan: setiap dependensi, model, atau sumber data yang diusulkan memerlukan versi atau SHA, pengenal lisensi/SPDX, hak komersial dan SaaS, pemberitahuan, SBOM transitif, persetujuan pemilik, dan rencana keluar sebelum dipakai. Jangan mereproduksi teks standar berlisensi.

## Disposisi repositori (usulan)

Pakai ulang template; ADR-0024 ([ADR-0024](../adr/0024-awcms-one-is-template-only-derived-apps-own-their-backend.id.md)) menjaga backend, basis data, migrasi, dan rahasia konsumen tetap independen; kapabilitas generik dipromosikan di platform hulu lewat aturan promosi eksplisit repositori; sinkronisasi subtree memakai merge commit. Evaluasi profil `landing`, `berita`, dan `toko` untuk kebutuhan dasbor yang dapat dipakai ulang. Tidak ada mesin intelligence dan tidak ada runtime bersama di sini.

## Kontrol, validasi, dan bukti (usulan)

Kontrak mock, tanpa data privat pada pembangkitan statis, serta semua gerbang profil, `template:init`, dan CI lokal beserta regresi. UAT dijalankan di konsumen, bukan di hulu. Tidak ada profil baru dan tidak ada server-side rendering tanpa ADR. Hindari dependensi basis data graf dan vektor sampai ada bukti.

Catat kebutuhan dan ancaman, lalu kontrol, kontrak berversi, uji sintetis yang dapat diulang, bukti, dan SOP atau pemantauan. Baseline dan ambang adalah hipotesis sampai diukur. Pakai hak akses minimum, RBAC/ABAC default-tolak dan RLS terpaksa (forced) bila berlaku, tanpa memercayai tenant dari klien, tanpa rahasia atau PII di log, persetujuan dan pemulihan yang diaudit. Tidak ada target vendor, pelanggan, atau publik yang diuji secara langsung. Verifikasi tujuan data, retensi, dasar hukum, dan pembagian pengendali/prosesor. Tidak ada berbagi data lintas tenant tanpa pemberian akses terbatas yang eksplisit.

## Register rujukan profesional

Setiap entri menunjukkan statusnya saat pengambilalihan (2026-11-28).

| Rujukan | Status saat pengambilalihan |
| --- | --- |
| [W3C PROV-O](https://www.w3.org/TR/prov-o/) | Didukung: W3C Recommendation, 30 April 2013 |
| [Lewis dkk., NeurIPS 2020, retrieval-augmented generation](https://papers.nips.cc/paper/2020/hash/6b493230205f780e1bc26945df7481e5-Abstract.html) | Didukung |
| [NIST SP 800-218 SSDF v1.1](https://csrc.nist.gov/pubs/sp/800/218/final) | Didukung: final, Februari 2022 |
| [NIST SP 800-218A](https://csrc.nist.gov/pubs/sp/800/218/a/final) | Didukung: final, Juli 2024 |
| [NIST SP 800-61 Rev. 3](https://csrc.nist.gov/pubs/sp/800/61/r3/final) | Didukung: final, April 2025 |
| [OASIS STIX 2.1](https://docs.oasis-open.org/cti/stix/v2.1/os/stix-v2.1-os.html) | Didukung: OASIS Standard, 10 Juni 2021 |
| [OWASP ASVS](https://owasp.org/projects/asvs) | Didukung: 5.0.0 stabil (situs ASVS menyatakan terbit 30 Mei 2025) |
| [WCAG 2.2](https://www.w3.org/TR/WCAG22/) | Didukung: W3C Recommendation, 12 Desember 2024 |
| [NIST Cybersecurity Framework](https://www.nist.gov/cyberframework) | Halaman menyajikan CSF 2.0; tahun terbit tidak tertulis di halaman, sehingga tidak ditulis di sini |
| [NIST AI RMF 1.0](https://doi.org/10.6028/NIST.AI.100-1) | **Tidak terverifikasi saat pengambilalihan**: tautan dialihkan ke PDF yang tidak dapat dibaca |
| Hall dan Llinas (1997), fusi data ([DOI](https://doi.org/10.1109/5.554205)) | **Tidak terverifikasi saat pengambilalihan** (halaman penerbit tidak memberi isi) |
| Entri katalog ISO/IEC (27001, 27002, 27005, 27017, 27018, 27034-1, 27701, 15408-1, 20000-1, 22301, 42001, 23894, 25010, 27035, 27036-3, 27037) | **Tidak terverifikasi saat pengambilalihan** (katalog menolak akses); tahun edisi karena itu tidak ditulis, dan tidak ada klaim sertifikasi, kepatuhan, atau audit klausul |
| UU 27/2022 tentang pelindungan data pribadi ([halaman BPK](https://peraturan.bpk.go.id/Details/229798/uu-no-27-tahun-2022)) | Halaman terbuka, hanya metadata; isi pasal 46 (pemberitahuan kegagalan dalam 3 x 24 jam) **tidak terverifikasi saat pengambilalihan** |
| [PP 71/2019](https://jdih.komdigi.go.id/produk_hukum/view/id/695/t/common) | Didukung sebagai "Penyelenggaraan Sistem dan Transaksi Elektronik" |
| [Perpres 82/2022](https://peraturan.bpk.go.id/Details/211029/perpres-no-82-tahun-2022) | Didukung sebagai "Pelindungan Infrastruktur Informasi Vital" |

Tinjau UU ITE, undang-undang sektoral, dan aturan pelaksana terkini sebelum rilis apa pun. Tidak ada tenggat atau nomor peraturan dari pernyataan vendor yang dipakai.

## Gerbang berikutnya

Ikuti siklus hidup 18 langkah standar lintas-portofolio internal. Penemuan dan UX, model privasi dan ancaman, data dan otorisasi, algoritma dan kontrak berada sebelum Gerbang 9; hanya issue riset yang diizinkan saat ini. Validasi CI, indeks, changeset, serta papan proyek, milestone, dan ketergantungan yang khusus repositori selama tinjauan; UAT konsumen dan Gerbang 15 mendahului produksi. Rollback berupa penghapusan dokumen ini (tanpa efek runtime); fitur mendatang memerlukan pemulihan dan rollback yang teruji serta pemantauan. Tidak ada eksekusi CI atau uji yang diklaim untuk riset ini.

## Riset lanjutan: kontrol keamanan dan penerimaan lisensi (isi v1.1.0, dirumuskan ulang saat pengambilalihan)

Status: hanya riset; tanpa gerbang implementasi, tanpa penerimaan dependensi. Halaman vendor tidak dikutip dan tidak ada harga, jam layanan, penilaian, atau perangkat vendor yang diasumsikan. Hanya konsep fungsional: tanpa salinan UI, kode, rumus penilaian, teks, API berhak milik, aset, templat pindai, atau data. Tanpa akun, tanpa pengujian target, tanpa mengunduh internal pihak ketiga. Klaim residensi data bukan bukti tempat semua pemrosesan terjadi: tinjau sub-prosesor, transfer, penghapusan, dan kontrak secara terpisah. Kesiapan pelindungan data pribadi bukan sertifikasi.

### Register penerimaan lisensi (teramati pada default branch, bukan rilis terpin)

| Kandidat | Bukti dan disposisi |
| --- | --- |
| ZAP | Apache-2.0 ([LICENSE](https://github.com/zaproxy/zaproxy/blob/main/LICENSE)); kandidat belum disetujui; periksa add-on dan NOTICE |
| Nuclei | MIT ([LICENSE](https://github.com/projectdiscovery/nuclei/blob/dev/LICENSE.md)); kandidat belum disetujui, tanpa dependensi baru |
| Templat resmi Nuclei | MIT ([LICENSE](https://github.com/projectdiscovery/nuclei-templates/blob/main/LICENSE.md)); tinjau asal-usul, tanda tangan, dan keamanan secara terpisah; tanpa templat pihak ketiga yang tidak dikenal |
| testssl.sh | GPL-2.0 ([repositori](https://github.com/testssl/testssl.sh)); tahan sampai tinjauan distribusi dan integrasi |
| Wazuh | Menurut [README](https://github.com/wazuh/wazuh/blob/main/README.md)-nya: mesin AGPL-3.0-or-later, sebagian pustaka bersama "GPL-2.0-only OR AGPL-3.0-or-later", sisanya GPLv2; periksa semua paket, indexer, dashboard, agent, dan rilis sebenarnya; tahan |
| MVT | Lisensi khusus dengan pembatasan persetujuan ([LICENSE](https://github.com/mvt-project/mvt/blob/main/LICENSE)), MVT License 1.1, dengan pembatasan pemakaian atas persetujuan; tahan; persetujuan pemilik data yang eksplisit, berinformasi, dan tanpa paksaan; data IOC memiliki lisensi terpisah |

Tidak ada perangkat yang disetujui, dipasang, atau dibundel. Sebelum ADR apa pun: pin rilis, tag, atau SHA, catat digest, SBOM transitif, kewajiban lisensi dan NOTICE, ketentuan distribusi dan pemakaian jaringan, ketentuan dataset dan feed, dukungan dan rencana keluar, serta selesaikan tinjauan hukum. Pemisahan proses tidak menghapus kewajiban lisensi. Utamakan fondasi native yang disetujui; adaptor eksternal hanya setelah gerbang. Tanpa reverse engineering API apa pun.

### Metode ilmiah dan profesional (usulan)

- FIRST [FAQ CVSS v4.0](https://www.first.org/cvss/faq): keparahan dasar bukan risiko bisnis. [FIRST EPSS](https://www.first.org/epss/): skor kini memperkirakan probabilitas sebuah CVE terpublikasi dieksploitasi di dunia nyata dalam 30 hari ke depan, bukan probabilitas kompromi sebuah aset tertentu. [Halaman riset](https://www.first.org/epss/research) FIRST mencantumkan makalah asli 2021 dan sebuah pembaruan; cakrawala keduanya tidak dibandingkan saat pengambilalihan, dan makalah asli (Jacobs dkk., 2021) **tidak terverifikasi saat pengambilalihan**.
- [CISA KEV](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) mencatat eksploitasi yang diketahui; [SSVC](https://www.cisa.gov/ssvc) adalah metode keputusan khusus pemangku kepentingan. Catat tanggal dan versi feed; data basi atau tidak diketahui dinyatakan tidak diketahui dan tidak diberi skor nol. Keputusan risiko menggabungkan eksposur terverifikasi, dampak aset, kontrol, bukti eksploitasi, dan tinjauan manusia; tidak ada rumus produksi yang dikarang dan tidak ada yang ditutup otomatis. Evaluasi pada dataset sintetis atau historis berizin yang dibagi menurut waktu: cakupan dan efisiensi, presisi dan recall, kalibrasi (skor Brier), dan beban analis terhadap baseline keparahan saja. Tidak ada hasil terukur yang diklaim.
- [NIST SP 800-115](https://csrc.nist.gov/pubs/sp/800/115/final) (September 2008) untuk perencanaan asesmen; SP 800-61 Rev. 3 untuk respons insiden yang terintegrasi dengan CSF 2.0; ASVS 5.0.0; PROV-O; WCAG 2.2. ISO 27035, 27036-3, dan 27037 melengkapi pemetaan kontrol yang ada dan bukan sertifikasi maupun teks berlisensi.
- Hukum data pribadi: pemberitahuan kegagalan UU 27/2022 (pasal 46) memerlukan validasi manusia dan hukum atas pemicu dan penerimanya; tanpa pelaporan otomatis. Diperlukan tinjauan hukum atas dasar hukum, DPIA, transfer data, kewajiban PSE dan sektoral, UU ITE, PP 71/2019, Perpres 82/2022, dan UU 28/2014.

### Uji keselamatan dan penerimaan yang diusulkan

Semua uji di bawah ini adalah usulan; tidak ada yang dijalankan, dan ID-nya sementara serta harus direkonsiliasi dengan ID CAP dan REQ yang ada.

- SEC-001: aset terverifikasi dan pemberian cakupan bertanda tangan; kedaluwarsa dan pencabutan; periksa ulang sebelum setiap job. Bukti DNS atau berkas saja bukan izin menyeluruh; pihak ketiga dan hosting bersama memerlukan otorisasi terpisah.
- SEC-002: tolak tujuan, pengalihan, perubahan DNS, SSRF, dan target privat atau link-local yang tidak disetujui; tanpa uji luas atau mengganggu, tanpa eksploitasi, tanpa pengumpulan kredensial, tanpa callback eksternal; fixture sintetis di sandbox, anggaran sumber daya terbatas, sakelar henti, dan identitas worker independen.
- SEC-003: pemeriksaan penerimaan, SBOM, dan versi atau tanda tangan; tanpa templat atau shell sembarang dari pengguna.
- SEC-004: hash temuan dan bukti, keluaran yang disamarkan, akses terbatas per tenant, penanda basi, audit dan uji ulang, serta alur false-positive.
- SEC-005: keputusan risiko yang dapat dijelaskan dengan provenans dan ketidakpastian.
- SEC-008: bukti tata kelola, risiko, dan kepatuhan dengan tinjauan hukum. SEC-009: kronologi insiden, tenggat pemberitahuan yang dapat dikonfigurasi, persetujuan, dan latihan pemulihan. SEC-010: retensi dan penghapusan bukti terbatas dengan audit akses.
- SEC-011: issue GitHub hanya setelah otorisasi terbatas dan penyamaran; tanpa tindakan otomatis.
- SEC-012: AI hanya boleh menyusun draf; tanpa rahasia atau telemetri mentah pelanggan; uji prompt-injection dan egress; sitasi dan abstain.
- SEC-013: pemantauan endpoint hanya metadata, bila diizinkan. SEC-014: hanya laporan pemegang hak yang sah, tinjauan manusia, tanpa tindakan balasan. SEC-015: persetujuan pemilik perangkat, tanpa membaca komunikasi, tanpa jaminan forensik.

Tidak ada aset atau data pelanggan nyata yang dipakai dalam riset ini.

### Hasil kerja riset lokal (#598, usulan)

Evaluasi mock dasbor dan laporan keamanan milik produk pada tiga nilai `SITE_PROFILE`; keluaran statis publik hanya untuk agregat yang sengaja disetujui. Tanpa pemindai, tanpa data produksi tenant, tanpa rahasia, tanpa API atau runtime bersama, dan tanpa layanan laporan keamanan di template. Fondasi generik datang lewat platform hulu dan merge commit subtree yang teruji; tidak ada profil baru dan tidak ada server-side rendering tanpa ADR. Uji `template:init`, pemeriksaan CI lokal yang ada, kontrak, pengecualian laporan privat dari keluaran build, serta upgrade dan rollback konsumen. Konsumen memiliki otorisasi, worker asesmen, penyimpanan, UAT, dan deployment; UAT hulu N/A.

## Arah rekonstruksi independen (2026-11-28, usulan)

Arahan, dinyatakan secara umum: pakai kapabilitas orisinal, bukan dependensi yang belum disetujui. Ini menggantikan status "tahan sebagai kandidat" sebelumnya untuk testssl.sh (GPL-2.0), Wazuh (mesin AGPL-3.0-or-later, lisensi campuran), dan MVT (lisensi khusus dengan persetujuan). Jangan memasang, menautkan, mem-vendor, mem-port, menerjemahkan, atau menyalin sumber, struktur, UI, aturan, templat, IOC, atau dataset produk-produk ini maupun produk komersial mana pun, jangan memakainya sebagai oracle, dan jangan merekayasa baliknya. GPL dan AGPL bukan larangan komersial: implementasi independen adalah pilihan bisnis dan arsitektur, bukan pengecualian hukum. Persetujuan pemilik perangkat yang berinformasi dan tanpa paksaan dipertahankan apa pun implementasinya. ZAP dan Nuclei tetap kandidat yang belum disetujui tanpa penerimaan dependensi. Pakai hanya deskripsi fungsional publik dan standar independen; wajibkan provenans dan atestasi kontributor, register sumber, kebutuhan independen, peninjau, pemeriksaan kemiripan dan dependensi/SBOM, serta pin versi, SHA, lisensi, pemberitahuan, paten, ketentuan data, dan rencana keluar. Tidak ada klaim clean-room formal atau kepatuhan. Tidak ada materi terbatas yang masuk ke prompt agent.

### Standar independen dan cakupan (usulan)

- TLS: [RFC 9846](https://www.rfc-editor.org/info/rfc9846/) (Juli 2026) menggantikan RFC 8446. [BCP 195](https://www.rfc-editor.org/info/bcp195/) terdiri dari RFC 8996, RFC 9325, dan RFC 9852; RFC 9325 juga diperbarui oleh RFC 10015, yang **di luar** BCP 195. [RFC 9525](https://www.rfc-editor.org/rfc/rfc9525.html) mengatur identitas layanan. [NIST SP 800-52 Rev. 2](https://csrc.nist.gov/pubs/sp/800/52/r2/final) (Agustus 2019). Pakai API TLS runtime yang disetujui dan jangan pernah kriptografi baru; amati hanya versi hasil negosiasi, rantai, identitas, dan kedaluwarsa; tidak diketahui bukan lulus. Koneksi TLS 1.2 yang teramati bukan kepatuhan BCP; tanpa probe paritas atau eksploit.
- Pencatatan dan integritas: Denning (1987, model deteksi intrusi) **tidak terverifikasi saat pengambilalihan**. [NIST SP 800-92](https://csrc.nist.gov/pubs/sp/800/92/final) (2006; Revisi 1 masih draf), [SP 800-137](https://csrc.nist.gov/pubs/sp/800/137/final) (September 2011), [SP 800-53 Rev. 5](https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final) dengan Release 5.2.0 (27 Agustus 2025; kontrol AU-6, SI-7, dan SI-4 tidak dibaca satu per satu), [RFC 5424](https://www.rfc-editor.org/info/rfc5424/) (Maret 2009), dan [model data log OpenTelemetry](https://opentelemetry.io/docs/specs/otel/logs/data-model/) hanya sebagai rujukan.
- Mobile: [NIST SP 800-124 Rev. 2](https://csrc.nist.gov/pubs/sp/800/124/r2/final) (Mei 2023) dan [SP 800-101 Rev. 1](https://csrc.nist.gov/pubs/sp/800/101/r1/final) (Mei 2014, forensik perangkat bergerak) menandai batas cakupan, bukan akuisisi forensik.
- SSDF 1.1 final; 1.2 adalah draf publik awal, belum final. Pemetaan ISO dan hukum Indonesia tercantum di register di atas beserta status verifikasinya; keduanya bukti, bukan sertifikasi.

ID sementara (semua usulan): IND-01 postur TLS (worker konsumen), IND-02 metadata host (perangkat host di sisi konsumen), IND-03 normalisasi dan korelasi peristiwa (kontrak dan ringkasan hulu), IND-04 bukti integritas (perangkat host di sisi konsumen), IND-05 postur mobile (penemuan produk), IND-06 risiko, bukti, dan kasus (platform hulu dan konsumen). Tidak ada klaim SIEM, XDR, atau forensik penuh dan tidak ada klaim deteksi spyware. Pemberian akses terbatas yang eksplisit, kedaluwarsa dan pencabutan, worker independen, data sintetis, tanpa I/O atau data privat tanpa izin, dan tanpa tindakan tanpa persetujuan berlaku sepanjang riset.

Sebuah spike referensi untuk logika keputusan murni atas observasi yang diberikan disiapkan di luar repositori ini oleh sesi riset, yang melaporkan bahwa spike itu lulus 19 uji sintetis di Node v22.16.0. Spike itu **tidak dijalankan di repositori ini** dan bukan bukti implementasi untuknya; tidak ada pengujian Bun, CI, TLS nyata, perangkat, RLS, atau produksi. Rekonsiliasi ID CAP dan REQ, provenans sumber, ADR, dan Gerbang 9 dan 15; tanpa kode produk baru atau deployment.

### Kebutuhan dan penerimaan lokal (usulan)

IND-01 dan IND-06: UI mock postur dan laporan yang dapat dipakai ulang, hanya kontrak yang disetujui; tanpa pemindai, mesin, kolektor, atau dependensi baru di template. Konsumen memiliki backend, cakupan, worker, rahasia, UAT, dan cadangan; fondasi generik hulu tiba lewat merge commit subtree. Verifikasi `template:init`, semua profil, privasi keluaran statis, dan regresi. Tidak ada profil baru dan tidak ada server-side rendering tanpa ADR.

## Verifikasi rujukan saat pengambilalihan (2026-11-28)

Rujukan diperiksa dengan membuka halamannya pada 2026-11-28 (baca-saja; ringkasan halaman, bukan salinan mentah). Didukung: halaman RFC dan BCP, publikasi NIST yang disebut di atas beserta tanggalnya, STIX 2.1, PROV-O, makalah retrieval-augmented generation, ASVS 5.0.0, EPSS, CVSS v4.0, CISA KEV dan SSVC, RFC 5424, halaman OpenTelemetry, WCAG 2.2, PP 71/2019, Perpres 82/2022, dan halaman lisensi ZAP, Nuclei, templatnya, testssl.sh, Wazuh, dan MVT. Koreksi yang diterapkan: RFC 10015 di luar BCP 195; SP 800-53 disebut sebagai Rev. 5 dengan Release 5.2.0 (27 Agustus 2025); tahun CSF tidak ditulis; tanggal terbit ASVS kini bersumber. Ditandai **tidak terverifikasi saat pengambilalihan**: setiap entri katalog ISO dan tahun edisinya, UU 27/2022 pasal 46 dan UU 28/2014 pasal 40 dan 41, NIST AI RMF 1.0, Hall dan Llinas, Denning, dan Jacobs dkk. Pernyataan vendor (harga, jam layanan, daftar perangkat, tenggat) dihapus, bukan diverifikasi. Pernyataan 19 uji adalah klaim sesi riset, bukan hasil repositori ini. Pemeriksaan ini tidak memberi klaim kinerja, uji, atau kepatuhan.

## Changelog

- v1.3.0 (2026-11-28): verifikasi pengambilalihan; pernyataan produk vendor dihapus dan diganti satu kalimat netral; rujukan yang tak dapat diverifikasi ditandai; klaim spike dirumuskan ulang; mirror dan indeks ditambahkan.
- v1.2.0 (2026-11-28): rekonstruksi independen menggantikan komponen yang belum disetujui; penerimaan lokal yang diusulkan.
- v1.1.0 (2026-11-28): bukti situs vendor, disposisi lisensi, metodologi risiko, dan kriteria riset lokal (isi vendor kemudian dihapus).
- v1.0.0 (2026-11-28): riset awal, kepemilikan lokal, dan kontrol.
