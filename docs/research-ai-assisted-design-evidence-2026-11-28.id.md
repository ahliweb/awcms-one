🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](research-ai-assisted-design-evidence-2026-11-28.md)

<!-- i18n-source-hash: sha256:5a5c3ffea2c7e80bf37c8fe8a88cc0aeee568db34a67263767d2ba84dfed4a57 -->

# Bukti desain dan spesifikasi berbantuan AI — template multi-profil yang dapat dipakai ulang

- Versi: 0.2.0
- Tanggal: 2026-11-28
- Status: usulan riset, bukan perubahan normatif atau implementasi. Setiap butir desain, kontrol, dan pemetaan di bawah ini berstatus **usulan**.
- Issue terkait: #596 (tetap terbuka)
- Snapshot bukti: blob `AGENTS.md` `c6ed72f8b5a29c3559d67c5b905e9344227387cd` dan blob `docs/template.md` `29ed1fea28a0ee069430e28b9b74d27cea0e4a42` pada `origin/main` di `b95d76d54cbb482587ffb2b7ef6e409c48771838` (SHA blob, bukan SHA commit; keduanya dibaca ulang saat pengambilalihan 2026-11-28).

## Metode riset dan bukti

Tinjauan cepat atas sumber publik primer, bukan tinjauan sistematis dan bukan uji produk. Riset ini dipicu uraian publik perangkat perencanaan dan desain berbantuan AI yang komersial; uraian itu adalah klaim fitur vendor, bukan bukti efektivitas, sehingga tidak ada produk yang disebut atau dinilai di sini. Hanya konsep fungsional umum dan standar terbuka yang dipakai.

- Cui dkk., studi eksperimen lapangan produktivitas pengembang ([halaman penerbit](https://doi.org/10.1287/mnsc.2025.00535)): **tidak terverifikasi saat pengambilalihan** (halaman penerbit menolak akses). Tahun, jumlah peserta, dan angka efeknya tidak ditulis di sini dan tidak boleh dikutip sebelum diperiksa.
- [METR 2025](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/): studi acak atas 16 pengembang berpengalaman pada 246 issue, melaporkan waktu penyelesaian 19% lebih lama; halaman itu menandai hasilnya tidak mutakhir. [Pembaruan 2026](https://metr.org/blog/2026-02-24-uplift-update/) menguraikan perubahan desain studi dan efek seleksi. Hasil antarstudi berbeda: jangan digabungkan dan jangan menjanjikan penghematan.
- [Perry dkk.](https://arxiv.org/abs/2211.03622): dalam studi terbatas, peserta lebih cenderung percaya kodenya aman; dibaca sebagai sinyal risiko keamanan dan terlalu percaya diri, bukan sebagai angka laju.
- Laporan DORA 2025: ringkasan halamannya sesuai dengan pemakaian di sini; PDF lengkap tidak dibuka (tautan tidak ditambahkan).
- ISO/IEC/IEEE 12207 (proses siklus hidup perangkat lunak) dan ISO 9241-210 (desain berpusat pada manusia): **tidak terverifikasi saat pengambilalihan** (halaman katalog menolak akses); tahun edisi karena itu tidak ditulis.
- [Format Design Tokens Community Group 2025.10](https://www.designtokens.org/tr/2025.10/format/) adalah laporan akhir Community Group bertanggal 28 Oktober 2025, bukan W3C Recommendation. [Draf spesifikasi DESIGN.md](https://blog.google/innovation-and-ai/models-and-research/google-labs/stitch-design-md/) bertanggal 21 April 2026. Keduanya rujukan interoperabilitas, bukan alat wajib.
- [NIST SSDF](https://csrc.nist.gov/projects/ssdf/publications): versi 1.1 final (Februari 2022); versi 1.2 adalah draf yang dirilis 17 Desember 2025.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) adalah W3C Recommendation yang terbit 12 Desember 2024.

## Batas dan validasi yang diusulkan

Ini template Bun/Astro/PostgreSQL dengan deployment referensi sendiri; repo konsumen memiliki backend, data, domain, dan operasinya ([ADR-0024](adr/0024-awcms-one-is-template-only-derived-apps-own-their-backend.id.md)). `SITE_PROFILE` adalah `toko`, `berita`, atau `landing`.

Usulan: tinjau pemakaian ulang tema dan token kanonis; repo tidak memiliki `DESIGN.md` saat pengambilalihan dan materi desain yang ada berada di bawah `design/`, sehingga narasi DESIGN.md akan baru. Uji tangkapan layar per profil, inventaris state, branding netral `template:init`, dan ketiadaan data konsumen. Pakai konvensi tangkapan layar dan CI lokal yang ada (lihat `docs/pengujian.md`) dan bandingkan dengan baseline tanpa mengganti arsitektur.

Tidak ada dependensi runtime konsumen dan tidak ada UAT di sini. Fondasi yang dapat dipakai ulang dipromosikan secara eksplisit lewat ADR hulu dan ujinya sendiri (aturan "Promotion is explicit" di `AGENTS.md`), bukan secara implisit. Tidak ada workspace Lynx di repo ini ([ADR-0050](adr/0050-lynxjs-for-separate-persona-apps-astro-stays-for-admin-and-public-profiles.id.md)).

## Kontrak bukti (usulan)

- Langkah 2 dan 4: kebutuhan dan kriteria penerimaan, ID layar, konteks tinjauan, dan prototipe sintetis.
- Langkah 5 sampai 8: data, izin, dan operasi eksplisit, serta mock yang dibangkitkan dari kontrak bila berlaku.
- Gerbang 9: deteksi tautan yang hilang atau bertentangan; koreksi kembali ke spesifikasi asalnya.
- Langkah 11: uji per slice hanya setelah persetujuan yang berlaku.
- Langkah 12: baseline visual deterministik, ditambah pemeriksaan WCAG 2.2 manual dan otomatis; otomasi saja tidak membuktikan aksesibilitas.
- Catat fakta teramati, disetujui, disimpulkan, tidak diketahui, dan diusulkan secara terpisah; pin SHA sumber yang sebenarnya sebelum pilot apa pun. Bila UI tidak ada, tandai butir N/A. Pakai artefak kanonis, jangan menduplikasinya.
- Ukur waktu termasuk tinjauan dan pengerjaan ulang, lolosnya cacat, keberhasilan tugas, dan biaya terhadap baseline yang sepadan. Tidak ada uji, UAT, atau CI rekaan.

## Keamanan dan lisensi (usulan)

Adopsi konsep saja, secara independen: tidak menyalin aset atau sumber berhak milik pihak lain, dan tidak mengirim data rahasia ke penyedia yang belum disetujui. Pakai fixture sintetis, hak akses minimum, redaksi, dan tinjauan lisensi. Instrumen Indonesia yang berlaku adalah undang-undang pelindungan data pribadi ([UU 27/2022](https://peraturan.bpk.go.id/Details/229798/uu-no-27-tahun-2022); teks pasalnya **tidak terverifikasi saat pengambilalihan**, halaman hanya memberi metadata) dan undang-undang hak cipta ([UU 28/2014](https://peraturan.bpk.go.id/Details/38690/uu-no-28-tahun-2014); halaman terbuka, teks pasal tidak tampil). Tidak ada klaim sertifikasi kepatuhan atau hasil kinerja.

## Keputusan berikutnya

Issue #596 memiliki inspeksi lebih dalam (ADR, dokumen, kode sebenarnya, CI, dan tumpang tindih), usulan terbatas, dan keputusan peninjau. Catatan ini tidak mengizinkan implementasi, dependensi, rilis, atau persetujuan gerbang.

## Koordinasi siklus hidup lewat GitHub Projects (usulan, 2026-11-28)

Arahan pemilik, hanya yang bersifat umum: koordinasikan langkah siklus hidup yang berlaku lewat GitHub Projects (v2), terintegrasi dengan manajemen proyek yang ada dan bukan papan kedua atau pengganti otoritas repositori. Hanya template; profil `toko`, `berita`, `landing`; UAT dan deployment konsumen tetap di issue dan proyek konsumen. Pekerjaan yang ada: #596.

- Langkah 1 sampai 8: lacak hasil riset dan spesifikasi dengan ketergantungan, peninjau, kriteria penerimaan, dan URL bukti; tidak ada issue implementasi sebelum gerbang 9 yang berlaku. Pelacak gerbang merujuk keputusan yang tercatat dan tidak pernah menyimpulkannya dari kolom papan.
- Langkah 10 sampai 12: satu issue kanonis per unit S/M, relasi parent/sub-issue dan blocked-by native bila didukung, milestone, prioritas, dan assignee dipertahankan; PR merujuk issue dan bukti CI. Langkah 13 sampai 15: staging/UAT hanya bila berlaku, bukti kesiapan rilis dan keputusan. Langkah 16 sampai 18: deployment, validasi, pemantauan, dan tindak lanjut dengan bukti rilis atau insiden.
- Pakai proyek yang disetujui beserta field yang ada; nama field (tahap, pelaksana, prioritas, mulai, target) dan nilai hidupnya **tidak terverifikasi saat pengambilalihan**. Pemetaan status yang diusulkan: rencana = backlog, siap = definition of ready yang berlaku, berjalan = diklaim, menunggu = ketergantungan, tinjauan, atau persetujuan, selesai = hasil terverifikasi, batal = dibatalkan dengan alasan. Langkah siklus hidup adalah field terpisah atau metadata issue yang ada, tidak pernah disimpulkan dari status. Penolakan gerbang tetap tercatat walau pelacak ditutup. PR yang ditutup tanpa merge, issue duplikat atau not-planned, atau bukti yang hilang tidak pernah otomatis ditandai selesai. Pertahankan pemilik, assignee, dan target; jangan mengarang tenggat.
- Perubahan keanggotaan dan field proyek: temukan pemilik, nomor, akses, dan ID field yang hidup; pakai URL atau node ID issue yang sebenarnya, penambahan idempoten, diff dry-run, baca ulang, dan rekonsiliasi; pertahankan satu issue kanonis dan bedakan butir PR dari hitungan pekerjaan. Tanpa kartu draf bersama atau konteks rahasia. Tinjau izin, hindari seeding luas atau konflik otomasi status, dan jangan pernah memindahkan butir melintasi batas visibilitas secara otomatis. Papan hanya untuk koordinasi, bukan otoritas merge atau deploy. Tidak ada keanggotaan proyek yang diperiksa dalam riset ini.

Rujukan: [perencanaan dan pelacakan dengan Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects); [memakai API untuk mengelola Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects); [ketergantungan issue](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies); [status issue](https://docs.github.com/en/issues/tracking-your-work-with-issues/learning-about-issues/about-issue-statuses). Keempat halaman dokumentasi GitHub ini **tidak terverifikasi saat pengambilalihan**.

## Verifikasi rujukan saat pengambilalihan (2026-11-28)

Dari lima belas rujukan yang diperiksa pada draf awal, sebelas didukung (dua dengan koreksi yang diterapkan di atas: METR menghitung 246 issue, bukan tugas, dan hasilnya ditandai tidak mutakhir; laporan ROI DORA tidak punya tahun terbit di halamannya), satu didukung sebagian, dan tiga tidak dapat diverifikasi (Cui dkk. dan ISO 12207, keduanya dikutip di sini dan ditandai di atas, serta ISO 25010 yang tidak dikutip catatan ini). Dua rujukan produk komersial dihapus, bukan diverifikasi (lihat "For human review" di pull request). Diperiksa tambahan: WCAG 2.2 (Recommendation, 12 Desember 2024) dan UU 28/2014 sebagai undang-undang hak cipta (teks pasal tidak tampil). Ditandai tidak terverifikasi: empat halaman dokumentasi GitHub, ISO 9241-210 (akses ditolak), dan teks pasal UU 27/2022. Semua pemeriksaan bersifat baca-saja, lewat ringkasan halaman, bukan salinan mentah. Catatan ini tidak membuat klaim kinerja, uji, atau kepatuhan.

## Changelog

- v0.2.0 (2026-11-28): verifikasi pengambilalihan; perumusan ulang ke status usulan; uraian produk vendor dihapus; rujukan yang tak dapat diverifikasi ditandai; klaim repo diperiksa terhadap pohon; indeks dan changeset ditambahkan; mirror Indonesia ditambahkan.
- v0.1.0 (2026-11-28): catatan riset awal dan bagian koordinasi GitHub Projects.
