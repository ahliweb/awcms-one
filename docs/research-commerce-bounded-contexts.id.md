🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](research-commerce-bounded-contexts.md)

<!-- i18n-source-hash: sha256:13190286d0c7f05f6a245648ee8a77ec7a2a2eac9e78a4221ef2d06d35a4a9e5 -->

# Bounded context commerce dan kecocokan arsitektur upstream — riset

**Versi:** v0.2.0 | **Diperbarui:** 2026-11-28 | **Status:** USULAN, riset saja. Tidak ada isi di bawah yang merupakan aturan, keputusan, hasil gerbang, atau izin untuk mengimplementasikan.
**Document changeset:** Revisi pengambilalihan: klaim dicocokkan dengan pohon repo dan ADR, tata letak modul dikoreksi, verifikasi rujukan ditambahkan.
**Pelacakan:** issue [#601](https://github.com/ahliweb/awcms-one/issues/601). Dokumen ini tidak mengubah ADR yang sudah diterima.

## Bukti dan cakupan

Dibaca saat pengambilalihan (2026-11-28) pada branch default di commit `b95d76d54cbb482587ffb2b7ef6e409c48771838`. Pin ini menggambarkan keadaan itu dan menjadi basi saat berkasnya berubah.

| Sumber | Pin saat pengambilalihan |
| --- | --- |
| [`AGENTS.md`](../AGENTS.id.md) | blob `c6ed72f8b5a29c3559d67c5b905e9344227387cd` |
| [`status.md`](status.id.md) | blob `3dde77494069a2134339e4a1708f397d02edeefd` |

Isi sumber dan apa yang diperiksa:

- [ADR-0008](adr/0008-one-commerce-module-carries-the-whole-store-not-three.id.md) (Accepted, 16 September 2026) menempatkan seluruh toko pada increment-nya di bawah satu kunci modul `commerce`. ADR itu **tidak** menggambarkan tata letak modul saat ini: `apps/cms` yang tertanam kini mendaftarkan modul lain, di antaranya `inventory`, `booking`, `procurement`, `tax`, `reporting`, `crm-leads`, dan `domain-event-runtime` (direktori modul ada di branch default yang di-pin; kontraknya tidak diaudit di sini). Peta konteks apa pun harus berangkat dari tata letak itu, bukan dari ADR-0008 saja.
- [ADR-0024](adr/0024-awcms-one-is-template-only-derived-apps-own-their-backend.id.md) (Accepted): repo ini hanya template, dan aplikasi turunan memiliki sendiri backend, basis data, migrasi, rahasia, deployment, dan rilisnya.
- [ADR-0018](adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.id.md) (Accepted) mendefinisikan tiga profil build `toko`, `berita`, dan `landing` yang dipilih lewat `SITE_PROFILE`, serta `template:init` yang idempoten.
- [ADR-0058](adr/0058-contract-parity-fixtures-with-schema-check-consumer-slice-at-the-root-and-generic-gaps-go-upstream.id.md) (Accepted, 20 November 2026) sudah mengarahkan celah generik ke upstream; dokumen ini mengikuti arah yang sama.
- [ADR-0001](adr/0001-git-subtree-with-full-history-for-apps-cms.id.md) (Accepted): `apps/cms` ditanam dengan `git subtree` berikut riwayat penuh; menurut [`AGENTS.md`](../AGENTS.id.md) PR sinkronisasi di-merge dengan merge commit.
- Topologi: `apps/cms` (subtree upstream), `apps/storefront` (Astro statis), dan `packages/kontrak` (DTO bertipe).
- Issue [#280](https://github.com/ahliweb/awcms-one/issues/280) dan [#281](https://github.com/ahliweb/awcms-one/issues/281) adalah epik yang sudah ditutup (AW Business Platform; adaptasi kesenjangan kapabilitas OSPOS). Pekerjaan kapabilitasnya tidak diulang di sini.
- Kontrol arsitektur generik berada di repo upstream `ahliweb/awcms`, yang memiliki issue riset terbuka [#1543](https://github.com/ahliweb/awcms/issues/1543) (graf dependensi modul yang dideklarasikan versus aktual), [#1544](https://github.com/ahliweb/awcms/issues/1544) (kepemilikan data modul dan integritas referensial yang aman bagi tenant), dan [#1545](https://github.com/ahliweb/awcms/issues/1545) (jaminan batas transaksi dan event). Repo ini tidak menduplikasinya.
- Tidak ada backend, data, atau runtime khusus konsumen yang ditaruh di template: setiap konsumen memiliki basis data, deployment, migrasi, rahasia, UAT, dan rilisnya sendiri (ADR-0024).

Audit kode, SQL, dan domain yang sebenarnya **belum dilakukan**. Template mempertahankan tiga pilihan `SITE_PROFILE` dan gerbang `local-ci`-nya. Dokumen ini tidak mengusulkan pemecahan modul runtime maupun perubahan SSR.

## Peta konteks kandidat (hanya logis; bukan klaim implementasi)

| Konteks | Contoh otoritas / interaksi yang perlu divalidasi |
| --- | --- |
| Catalog | definisi produk, varian, proyeksi baca publik |
| Pricing/promotion | aturan harga, snapshot kutipan/versi, keputusan voucher |
| Cart/checkout | niat pembelian, validasi input, submit idempoten |
| Order | siklus hidup pesanan dan status pesanan yang otoritatif |
| Inventory | pemilik stok/reservasi; modul `inventory` dengan buku besar stok append-only ada di upstream, sehingga kontrak sebenarnya dan pemakaiannya oleh konsumen perlu diverifikasi |
| Payment | pemilik transaksi/status penyedia lewat adapter yang ada; batas keuangan terpisah |
| Fulfillment | status dan event pengiriman, integrasi penyedia; tidak ditemukan berkas bernama shipment atau fulfillment di direktori `domain` atau `application` modul pada checkout yang di-pin (hanya pencarian nama berkas, bukan audit) |
| Returns/refunds | status retur/refund yang diotorisasi, rekonsiliasi |
| Customer | otoritas identitas/profil yang ada, pembacaan berlingkup |
| Loyalty/merchant | hanya kapabilitas kandidat; nilai dulu peta jalan dan kepemilikan aktualnya |

Prinsip usulan untuk dievaluasi (tidak ada yang diadopsi):

- Jangan membuat modul atau paket fisik baru untuk setiap konteks logis.
- Untuk setiap konteks, identifikasi: agregat dan invarian, tabel pemilik dan penulis SQL, port/DTO/versi, pemanggil, permission, lingkup tenant, batas transaksi, event, read model, pengecualian dependensi, pemilik, dan bukti. Tandai tiap konteks implemented, partial, planned, atau deferred pada checkout yang di-pin.
- Pertahankan atomisitas checkout, otorisasi, row-level security dengan `FORCE` (lihat [`skema-basis-data.md`](skema-basis-data.id.md)), invarian stok/pembayaran/buku besar, dan foreign key yang sudah disetujui. Tidak ada penghapusan join atau foreign key secara menyeluruh.
- Satu penulis kanonis per kumpulan data; tidak ada mutasi lintas domain langsung; ada jalur yang ditinjau untuk pembacaan pelaporan yang sah.
- Adapter lokal dapat berbagi transaksi; adapter jarak jauh membawa timeout, event ganda atau tidak berurutan, kegagalan sebagian, dan rekonsiliasi.
- Pakai ulang runtime outbox dan consumer upstream (direktori modul `domain-event-runtime`); tidak ada Kafka dan tidak ada dependensi baru hanya untuk menyamai sebuah demonstrasi.
- Hanya konsep mandiri; tanpa asumsi kode, lisensi, atau produk pihak luar.

## Alur adopsi (usulan)

1. Pin commit upstream dan subtree, lalu bandingkan sumber, SQL, kontrak, uji, dan catatan divergensi yang ada; selaraskan kepemilikan issue.
2. Audit konteks commerce internal dengan lima skenario bisnis sintetis: kutipan katalog dan harga, konkurensi reservasi stok, retry order/checkout, status penyedia ganda atau tidak berurutan, dan retur/refund dengan hasil tidak diketahui; tambahkan kasus akses lintas tenant yang negatif untuk masing-masing.
3. Usulkan perubahan terarah hanya setelah gerbang 9 yang berlaku. Gerbang generik ke upstream; tidak ada patch lokal pada infrastruktur bersama. DTO publik berversi; fixture kompatibilitas dan idempotensi.
4. Setelah rilis upstream yang terverifikasi, sinkronkan subtree dengan merge commit (tidak pernah squash atau rebase); tidak ada peningkatan implisit pada deployment konsumen mana pun.
5. Verifikasi `toko`, `berita`, dan `landing`, `template:init`, uji CMS dengan PostgreSQL sungguhan, paritas kontrak, keamanan, uji end-to-end, dan setiap check `local-ci` yang wajib. UAT, rilis, dan rollback konsumen tetap di repo konsumen. Lacak adopsi peningkatan template dengan bukti.
6. Ekstraksi layanan hanya di bawah ADR-0013 §7 repo upstream `ahliweb/awcms` (ruang penomoran berbeda dari [ADR-0013](adr/0013-rule-based-legacy-redirects-beside-the-row-based-map.id.md) milik repo ini): keenam kondisi terukur terpenuhi, ditambah backfill, shadow read, cutover, rollback, tanpa dual write, dan bukti observabilitas. ADR itu menyatakan dirinya bukan mandat.

Tidak ada benchmark, perubahan kode, migrasi, deployment, atau rilis dalam dokumen ini. Adopsi di masa depan memerlukan nilai terukur, bukti CI, tinjauan, dan rollback yang dikendalikan konsumen.

## Verifikasi rujukan saat pengambilalihan (2026-11-28)

Setiap URL sumber dibuka satu kali, baca-saja, pada 2026-11-28. Pembacaannya adalah ringkasan halaman oleh model, bukan salinan mentah.

- **Didukung (9 dari 12):** tiga issue upstream (judul dan status terbuka dibaca lewat GitHub API); [Constraints](https://www.postgresql.org/docs/18/ddl-constraints.html) PostgreSQL 18 (membahas foreign key dan integritas referensial) dan [Row Security Policies](https://www.postgresql.org/docs/18/ddl-rowsecurity.html) (membahas `FORCE ROW LEVEL SECURITY`); halaman transactional outbox AWS (masalah dual write, tabel outbox, consumer idempoten, urutan); halaman verifikasi Spring Modulith (siklus, akses ke internal, dependensi yang diizinkan).
- **Belum diverifikasi saat pengambilalihan (3 dari 12):** tiga tautan DOI pada Sumber. Masing-masing dialihkan ke halaman penerbit yang mengembalikan HTTP 403. Judul, penulis, dan tahunnya tidak ditulis di sini dan tidak ada isi dokumen ini yang bergantung padanya.
- **Koreksi yang dilakukan:** tidak ada sumber yang dikutip yang perlu dikoreksi. Koreksi dilakukan pada klaim tentang repo ini: status #280 dan #281 (sudah ditutup), tata letak modul (ADR-0008 saja tidak mutakhir), ambiguitas kutipan ADR-0013, serta rumusan fulfillment dan inventory yang belum terverifikasi.
- Bagian ini hanya melaporkan apa yang dibuka pada tanggal di atas; ia tidak mengklaim apa pun tentang perubahan halaman itu sesudahnya.

## Sumber

- https://github.com/ahliweb/awcms/issues/1543 ; https://github.com/ahliweb/awcms/issues/1544 ; https://github.com/ahliweb/awcms/issues/1545
- https://doi.org/10.1145/361598.361623 ; https://doi.org/10.3390/fi17110496 ; https://doi.org/10.1002/spe.70062 (belum diverifikasi saat pengambilalihan)
- https://www.postgresql.org/docs/18/ddl-constraints.html ; https://www.postgresql.org/docs/18/ddl-rowsecurity.html
- https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html ; https://docs.spring.io/spring-modulith/reference/verification.html

## Changelog

### v0.2.0 (2026-11-28)

Revisi pengambilalihan. Klaim tentang repo ini dicocokkan dengan branch default dan dikoreksi; tata letak modul diperbarui melampaui ADR-0008; epik yang ditutup dinyatakan; kutipan ADR-0013 dibuat tidak ambigu; bagian verifikasi rujukan ditambahkan; status tetap riset usulan.

### v0.1.0 (2026-11-28)

Peta konteks kandidat dan verifikasi adopsi awal, dibuat oleh sesi lain sebagai draf.
