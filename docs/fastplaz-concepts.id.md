🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](fastplaz-concepts.md)

<!-- i18n-source-hash: sha256:0708a5c5ba22286f61ff99b12a1a137d8e0ab593f1509392199ae5c0661e760d -->

# Template AWCMS-One dan wizard inisialisasi — konsep FastPlaz, arsitektur khusus repositori

## Kontrol dokumen

- **Versi:** v1.0.0
- **Diperbarui:** 2026-11-10
- **Status:** Usulan arsitektur / riset saja; bukan fitur produksi.
- **Document Changeset:** Pemetaan rujukan pertama dan batas implementasi.
- **Issue pemilik:** [#521](https://github.com/ahliweb/awcms-one/issues/521).

## Ringkasan dan baseline lokal yang terkonfirmasi

Repositori ini sudah mengimplementasikan `bun run template:init` dengan `SITE_PROFILE` (`toko`, `berita`, `landing`), seed netral, dan scaffolding produk turunan yang teruji.

## Maksud dan adaptasi kandidat

Tingkatkan `template:init`, jangan menggantinya: perencanaan sebelum init, manifes perubahan yang deterministik, validasi pasca-init, tanpa branding usang atau telepon/alamat warisan, konsistensi lockfile/metadata repositori, serta pemeriksaan smoke profil dan deployment.

## Kewenangan dan larangan

Template yang dapat dipakai ulang ada di sini; pekerjaan backend AWCMS generik dikerjakan di upstream; aplikasi turunan memiliki CMS, DB, secret, dan deployment-nya sendiri; produksi aplikasi turunan tidak pernah diarahkan ke deployment template.

## Issue terkait yang sudah ada dan pencegahan duplikasi

Arsitektur baru [#521](https://github.com/ahliweb/awcms-one/issues/521); drift template yang sudah ada [#476](https://github.com/ahliweb/awcms-one/issues/476); regresi sebelumnya [#227](https://github.com/ahliweb/awcms-one/issues/227) dan [#233](https://github.com/ahliweb/awcms-one/issues/233).

## Enam skenario validasi konkret

1. Profil landing tanpa telepon/alamat tidak boleh mewarisi identitas toko asli.
2. Profil toko memiliki nama root `package.json`/`bun.lock` yang cocok.
3. Profil berita hanya mengirim rute yang diizinkan, canonical, dan identitas situs.
4. Dua inisialisasi yang identik menghasilkan nol diff tak terduga.
5. Profil atau domain yang tidak valid gagal sebelum ada berkas yang berubah.
6. Produk turunan mendapat checklist onboarding deployment dan secret miliknya sendiri.

## Pemeriksaan yang diusulkan dan bukti uji

Pakai ulang `bun run ci:template`, `bun run check:lockfile`, smoke profil, dan gerbang dokumentasi; periksa tes template-init. Tidak ada generator independen di `apps/cms`.

## Peluncuran / serah terima

Koordinasikan implementasi lewat #476 bila tumpang tindih; issue #521 hanya dokumentasi/arsitektur. Periksa kapabilitas generik sebelum membuka issue baru.

## Rujukan sumber dan batasan

Dokumen ini hanya mengambil **konsep** dari [FastPlaz](https://github.com/fastplaz/fastplaz): [MCP/AI Agent Plane](https://github.com/fastplaz/fastplaz/blob/master/docs/MCP.md), [alur kerja IDE](https://github.com/fastplaz/fastplaz/blob/master/docs/AI_AGENT_by_FASTPLAZ.md), dan [konsep operator standalone](https://github.com/fastplaz/fastplaz/blob/master/docs/STANDALONE-deployment.md). Tanpa Pascal, Lazarus, CGI, mesin MVC/tema, atau penyalinan kode sumber. [Teks lisensi FastPlaz](https://github.com/fastplaz/fastplaz/blob/master/LICENSE.txt) tidak menunjukkan izin eksplisit atas kode sumber; hanya implementasi independen.

## Invarian rekayasa lintas-portofolio

Menerapkan **standar lintas-portofolio internal**, bersama AGENTS, ADR, CONTRIBUTING repositori ini sendiri, dan realitas kode saat ini. **Gate 9 (Definition of Ready lintas-spesifikasi)** yang disetujui manusia mendahului kode fitur produksi; **Gate 15 (kesiapan rilis)** yang disetujui manusia mendahului produksi. Satu issue/branch/PR per lingkup atomik. Jangan pernah menyajikan spesifikasi, pemeriksaan dokumentasi yang hijau, atau riset sebagai fungsionalitas produksi yang berjalan.

Konektor MCP/alat lokal, bila kelak diperlukan: loopback atau IPC terautentikasi, pembatasan host/Origin untuk HTTP, kredensial bercakupan yang dirotasi, perlindungan canonical-path dan symlink, tingkat persetujuan baca/tulis/destruktif, tanpa shell sembarang, tanpa akses SQL/DB mentah/secret secara bawaan, sumber daya/waktu/pembatalan yang dibatasi, kebijakan pada runtime alat/OS yang sebenarnya, fail-closed untuk yang tidak dikenal dan log yang disamarkan. Persetujuan manusia untuk perubahan pada otorisasi, konfigurasi produksi, atau data sensitif.

## Rujukan regulasi dan kontrol yang relevan

Evaluasi keberlakuan, bukan kepatuhan berdasarkan pernyataan: UU 27/2022 (PDP), PP 71/2019 (PSTE), Perpres 95/2018 bila SPBE berlaku; ISO/IEC 27001, 27002, 27005, 27017, 27018, 27034, 27701, ISO 22301, ISO/IEC 20000-1, ISO/IEC 42001, ISO/IEC 15408; OWASP LLM/Agentic Security, NIST AI RMF. Dapatkan bukti kontrol independen dan edisi yang berlaku sebelum klaim sertifikasi apa pun.

## Rubrik bukti penerimaan

Untuk setiap tindak lanjut: tautkan spesifikasi/ADR dan issue pemilik; catat commit sumber, versi toolchain/runtime, perintah yang dijalankan, galat/hasil aktual, uji akses yang ditolak, dan SHA bukti. Tandai pemeriksaan yang tidak dijalankan sebagai **NOT EXECUTED**. Persetujuan dan status publikasi/deployment adalah hal yang berbeda. Tanpa data pribadi sensitif atau secret produksi di prompt, log, atau artefak GitHub.

## Changelog

- **v1.0.0 — 2026-11-10:** Mendokumentasikan batas adopsi khusus repositori yang berbasis bukti, enam kasus praktis, dan rubrik penerimaan.
