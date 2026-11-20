🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0058-contract-parity-fixtures-with-schema-check-consumer-slice-at-the-root-and-generic-gaps-go-upstream.md)

<!-- i18n-source-hash: sha256:8016cd0e85483e8b6112a5310896831b1e654e4087296145cd4a9f427484d59c -->

# ADR-0058 — Paritas kontrak: fixture plus pemeriksaan skema lebih dulu, irisan consumer-contract storefront di akar repositori, dan celah kontrak generik dilaporkan ke upstream

- **Status:** Accepted
- **Tanggal:** 20 November 2026
- **Pengambil keputusan:** ahliweb (keputusan pemilik 20 November 2026, dipilih lewat dialog keputusan)
- **Terkait:** [`docs/audit-paritas-kontrak-cms-storefront.md`](../audit-paritas-kontrak-cms-storefront.md) (issue #547, bagian 8.1: tiga keputusan yang menunggu pemilik); [ADR-0024](0024-awcms-one-is-template-only-derived-apps-own-their-backend.md) (kepemilikan: ini template); issue [#6](https://github.com/ahliweb/awcms-one/issues/6) (`packages/kontrak` hanya tipe); issue upstream [ahliweb/awcms#1385](https://github.com/ahliweb/awcms/issues/1385); issue backlog [#553](https://github.com/ahliweb/awcms-one/issues/553), [#554](https://github.com/ahliweb/awcms-one/issues/554), [#555](https://github.com/ahliweb/awcms-one/issues/555), [#556](https://github.com/ahliweb/awcms-one/issues/556), [#557](https://github.com/ahliweb/awcms-one/issues/557)

## Konteks

Audit paritas kontrak menemukan bahwa tes dan run browser storefront memakai stub tulisan tangan (`apps/storefront/scripts/stub-awcms.mjs` dan `apps/storefront/tests/fixtures/awcms`) yang tidak dibandingkan dengan dokumen OpenAPI tempat CMS diperiksa (temuan F-01 dan F-02). Audit juga menemukan celah di kontrak publik generik yang milik provider, bukan template ini: tidak ada `429` yang dideklarasikan pada 25 operasi yang memunculkan `RATE_LIMITED`, dan tidak ada header idempotency opsional yang terbaca mesin (F-08 dan F-09). Bagian 8.1 audit mencantumkan tiga keputusan yang menunggu pemilik. Pemilik memutuskannya pada 20 November 2026. ADR ini mencatatnya agar issue backlog menunjuk satu tempat.

## Keputusan

**D1 — Strategi mock: fixture plus pemeriksaan skema lebih dulu.** Setiap fixture storefront divalidasi terhadap skema respons OpenAPI yang bersangkutan oleh gerbang tanpa database dan tanpa jaringan yang berjalan di `local-ci/check-toko`; fixture yang dideklarasikan sebagai subset mencantumkan field yang dibaca konsumen. Mock hasil generasi (server yang dihasilkan dari dokumen OpenAPI, dengan contoh error dan `429`) ditunda: ia menyusul hanya bila kebutuhan muncul, dan menurut tabel kepemilikan audit generatornya milik upstream sedangkan data seed per produk milik repo produk. Tingkatan ini tidak saling eksklusif; pemeriksaan skema adalah peningkatan murni atas fixture biasa dan tidak menambah dependensi runtime.

**D2 — Irisan consumer-contract storefront ditempatkan di `tests/` akar repositori ini, bukan di `apps/cms`.** `apps/cms` adalah subtree `ahliweb/awcms`; divergensi lokal di sana berbiaya di setiap sinkron subtree dan bertentangan dengan ADR-0024 (template tidak mengedit backend generik secara langsung). Irisan mengikuti aturan superset aditif yang sudah dipakai `api:consumer-contract:check` untuk `awcms-astro`, membaca bundle OpenAPI, tidak mengimpor apa pun saat runtime dari `packages/kontrak`, dan mempertahankan guard arah impor.

**D3 — `RATE_LIMITED` (`429`) dan komponen header idempotency opsional dilaporkan ke upstream, tidak ditambal di `apps/cms`.** Laporannya [ahliweb/awcms#1385](https://github.com/ahliweb/awcms/issues/1385). Upstream juga memilih menerbitkan paket fixture terpatok untuk konsumen (opsi C'-nya). Repo ini mengadopsi hasilnya setelah sinkron subtree berikutnya yang membawanya, dilacak [#557](https://github.com/ahliweb/awcms-one/issues/557); sampai saat itu stub tidak boleh mengarang bentuk `429` yang tidak dideklarasikan kontrak.

### Alternatif yang ditolak

- **Mock hasil generasi lebih dulu.** Ditolak sebagai langkah pertama: ia menambah dependensi dan generator yang harus dirawat, sedangkan celah terbesar yang terverifikasi (fixture yang bertentangan dengan skema) tertutup oleh pemeriksaan skema saja. Ia tetap terbuka sebagai usulan upstream bila lebih dari satu konsumen membutuhkannya.
- **Irisan di dalam `apps/cms` di samping irisan `awcms-astro`.** Ditolak: ia menjadi divergensi lokal di subtree, berulang di setiap sinkron, kecuali diusulkan dan diterima upstream lebih dulu, yang menunda gerbang yang bisa dimulai hari ini.
- **Menambal `429` dan idempotency di salinan `apps/cms`.** Ditolak: sinkron subtree berikutnya menimpa atau berbenturan dengannya, dan konsumen selain template ini (`awcms-astro`, `awcms-lynx`) tidak mendapat manfaat.

### Kriteria

| Kriteria | D1 fixture plus pemeriksaan skema | D2 `tests/` akar | D3 upstream |
| --- | --- | --- | --- |
| Keamanan | tanpa permukaan runtime baru | tidak ada | memperbaiki kontrak pada pemilik handler |
| Performa | pemeriksaan statis, tanpa database dan jaringan | pemeriksaan statis | tidak ada di sini |
| Kemudahan perawatan | satu gerbang menggantikan perbandingan manual | tanpa divergensi subtree | satu perbaikan untuk semua konsumen |
| Skalabilitas | fixture per produk memakai gerbang yang sama | irisan per produk memakai format yang sama | dipakai bersama semua konsumen |
| Kompatibilitas | aturan subset aditif sudah dipakai | aturan sama dengan `awcms-astro` | mengikuti sinkron subtree |
| Kompleksitas operasional | satu langkah `check-toko` tambahan | satu berkas beku | menunggu rilis upstream |
| Jangka panjang | generator dapat ditambah kelak | tetap berlaku bila upstream menerbitkan paket | selaras dengan opsi C' upstream |

Aksesibilitas, SEO, dan UI/UX tidak terdampak: ini keputusan tes dan kontrak tanpa permukaan yang dirender.

## Konsekuensi

- Lima issue backlog ada, semuanya menunggu gerbang 9 dan Definition of Ready; tidak ada yang diimplementasikan oleh keputusan ini: [#553](https://github.com/ahliweb/awcms-one/issues/553) (gerbang fixture terhadap skema), [#554](https://github.com/ahliweb/awcms-one/issues/554) (koreksi fixture F-03 sampai F-05 setelah gerbang ada), [#555](https://github.com/ahliweb/awcms-one/issues/555) (irisan beku, pembacaan saat build), [#556](https://github.com/ahliweb/awcms-one/issues/556) (irisan beku, panggilan browser), [#557](https://github.com/ahliweb/awcms-one/issues/557) (adopsi `429` dan idempotency setelah sinkron subtree).
- Bagian 8.1 laporan audit kini menunjuk ke sini, bukan mendaftar keputusan terbuka. Temuannya tidak berubah.
- Tidak ada kode, skema, workflow, atau tes yang berubah bersama ADR ini. `apps/cms` tidak tersentuh.
- F-07 (rute `tokens.css` di luar bundle) tetap laporan upstream; #555 menamai rute itu secara eksplisit tetapi tidak memperbaikinya di sini.
