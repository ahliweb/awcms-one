🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0015-commerce-migrations-live-in-the-reserved-9xx-range.md)

<!-- i18n-source-hash: sha256:408cf0a4f502db4cc677cd027e6808ea2f5b3e5ec9872ec998b5c99fb5ca91c6 -->

# ADR-0015 — Migrasi commerce hidup di rentang cadangan `9xx`

- **Status:** Diterima
- **Tanggal:** 18 September 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** [ADR-0001](0001-git-subtree-with-full-history-for-apps-cms.id.md), [ADR-0008](0008-one-commerce-module-carries-the-whole-store-not-three.id.md); issue #72

## Konteks

`apps/cms` adalah `ahliweb/awcms` yang di-embed utuh lewat `git subtree` (ADR-0001). Modul `commerce` milik repo ini (ADR-0008, issue #4) menambah enam belas migrasi di `apps/cms/sql/`, bernomor 153 (`awcms_commerce_schema`) sampai 168 (`awcms_commerce_orders_expire_worker_write_grants`), di dalam penomoran `001`-`899` milik upstream sendiri — satu-satunya rentang yang ada saat itu.

Upstream sejak itu menambah `sql/153_awcms_blog_institution_logo.sql` miliknya sendiri (issue #59, upstream `ahliweb/awcms#806`/`#807`), dan akan terus menambah `154`, `155`, … seiring pengembangannya sendiri berlanjut. `apps/cms/scripts/db-migrate.ts` — berkas upstream yang tidak pernah disunting secara lokal oleh repo ini — menerapkan setiap berkas `sql/*.sql` dalam urutan leksikal dan mengunci baris yang diterapkan di `awcms_schema_migrations` dengan nama berkas penuh; ia mewajibkan pola `^\d{3}_awcms_[a-z0-9_]+\.sql$`, tiga digit, dan menolak nama berkas apa pun di luar itu. Dua berkas boleh berbagi prefiks tiga digit yang sama (runner tidak mewajibkan keunikan di seluruh direktori), tapi itu hanya menunda masalah sesungguhnya: enam belas migrasi commerce milik repo ini persis berada di tempat migrasi upstream berikutnya akan mendarat, selamanya, selama keduanya menghitung dari `001`.

## Keputusan

Beri nomor ulang enam belas migrasi commerce ke rentang cadangan `901`-`916` — offset **+748** dari nomor aslinya (`153`→`901`, `154`→`902`, … `168`→`916`) — rentang yang tidak akan pernah dijangkau oleh penomoran `001`-`899` milik upstream. Setiap migrasi commerce mendatang melanjutkan di `917`, `918`, dan seterusnya. `apps/cms/tests/commerce-migrations-range.test.ts` (baru, issue #72) menegaskan setiap berkas `*_awcms_commerce_*.sql` punya prefiks di `900`-`999` dan setiap berkas lain punya prefiks di bawah `900`, sehingga aturan ini tetap benar setelah setiap `git subtree pull` mendatang tanpa ada yang harus mengingatnya.

### Opsi yang dipertimbangkan

| Opsi | Kenapa tidak (atau kenapa dipilih) |
| --- | --- |
| **Beri nomor ulang ke `901`-`916`** (dipilih) | Rename murni, tidak ada berkas upstream yang disentuh. Pola tiga digit `apps/cms/scripts/db-migrate.ts` yang sudah ada (`^\d{3}_awcms_[a-z0-9_]+\.sql$`) sudah menerimanya tanpa perubahan — tidak ada apa pun tentang runner yang berubah. |
| Lebarkan pola jadi empat digit | Membutuhkan penyuntingan `MIGRATION_FILE_PATTERN` di dalam `apps/cms/scripts/db-migrate.ts` sendiri — berkas upstream yang tidak ditambal secara lokal oleh repo ini (lihat "What is, and is not, this repo's to edit" di `AGENTS.md` root). Setiap `git subtree pull` mendatang harus menerapkan ulang tambalan itu, dan konflik merge di sana persis jenis bahaya diam-diam-mudah-diselesaikan-salah yang ingin dihindari disiplin subtree repo ini. |
| Pertahankan nomor, dokumentasikan tie-break leksikal | `db-migrate.ts` menerapkan berkas dalam urutan `localeCompare` dan tidak peduli dua berkas berbagi prefiks, jadi ini secara teknis masih akan berjalan — tapi ini mengikat repo ini pada tabrakan permanen dan terus bertambah dengan penomoran upstream sendiri, tidak diperiksa apa pun, hanya disadari saat seseorang kebetulan membaca kedua nama berkas berdampingan. Aturan yang bergantung pada seseorang menyadari bukanlah aturan. |
| Direktori `sql/commerce/` terpisah | `discoverMigrationFiles()` membaca persis satu direktori datar (`path.resolve(process.cwd(), "sql")`) — memindahkan migrasi commerce keluar darinya berarti menyunting `db-migrate.ts` untuk membaca direktori kedua (masalah sunting-upstream yang sama seperti melebarkan pola) atau meratakan dua direktori jadi satu aliran migrasi lewat mekanisme lain yang tidak didefinisikan apa pun di sini. Penolakan sama seperti melebarkan pola, dengan alasan yang sama. |

## Konsekuensi

- Migrasi commerce mendatang adalah nomor bebas berikutnya di `9xx` — `917` hari ini — dipilih dari rentang yang tidak bisa ditabrak upstream, selamanya, kecuali upstream juga memberi nomor ulang secara manual ke tiga digit (yang justru akan melanggar `commerce-migrations-range.test.ts`).
- Basis data yang **belum pernah** menjalankan `db:migrate` tidak butuh apa pun tambahan: ia cukup menerapkan enam belas berkas di bawah nama `901`-`916` barunya, secara berurutan, seperti migrasi lain mana pun.
- Basis data yang **sudah pernah** menjalankan `db:migrate` terhadap nama lama `153`-`168` memiliki enam belas nama berkas lama itu tercatat di `awcms_schema_migrations`. Sebelum `db:migrate` berikutnya pada basis data itu, operatornya menjalankan `bun run db:commerce:renumber` sekali (`apps/cms/scripts/commerce-migrations-renumber.ts`, issue #72) — skrip satu-kali, transaksional, idempotent yang memperbarui `migration_name` masing-masing dari enam belas baris ke nama berkas barunya dan menghitung ulang `checksum`-nya dari berkas yang kini ada di disk. Tanpa langkah ini, `db-migrate.ts` akan melihat enam belas berkas "baru" dengan nama `9xx`-nya dan mencoba menerapkan ulang perubahan skema yang sudah diterapkan.
- Belum ada PostgreSQL produksi untuk repo ini (lihat "What is here today, and what is not" di `AGENTS.md` root), jadi jalur kompatibilitas ADR ini diuji lewat tes `planRenames` murni milik `commerce-migrations-renumber.test.ts` hari ini, bukan oleh operator — tapi langkahnya didokumentasikan di [`docs/deployment.md`](../deployment.id.md) dan [`docs/skema-basis-data.md`](../skema-basis-data.id.md) untuk hari itu tiba.
