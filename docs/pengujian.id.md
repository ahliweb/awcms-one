🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](pengujian.md)

<!-- i18n-source-hash: sha256:84490c74130b3b6d66c61d39f096334431af796dca1f757486ff2d1fc44216c0 -->

# Pengujian

Tiga suite ada di repositori ini, masing-masing dimiliki workspace berbeda, dengan hubungan berbeda terhadap PostgreSQL hidup. Dokumen ini menamai ketiganya, apa yang dicakup masing-masing, dan bagaimana menjalankan yang butuh basis data — ia tidak menyatakan ulang setiap berkas tes satu per satu.

## 1. Root gate suite (`bun test` dari root repo)

Tidak butuh basis data, tidak butuh build, dan tidak butuh jaringan di luar `bun install`. Mengecualikan `apps/cms/**` sepenuhnya lewat `[test] pathIgnorePatterns` milik `bunfig.toml` — pengaturan yang sengaja diletakkan di sana alih-alih sebagai flag pada skrip `test`, karena CI memanggil `bun test` telanjang, dan flag pada `bun run test` diam-diam tidak akan berlaku pada pemanggilan telanjang itu (lihat komentar `bunfig.toml` sendiri, dan "Configuration and toolchain" milik `AGENTS.md`).

Terukur saat dokumen ini ditulis:

```
$ bun test
bun test v1.4.2 (744846f84)
 154 pass
 0 fail
Ran 154 tests across 14 files. [2.20s]
```

Angka ini bergerak seiring gate dan dokumen ditambahkan — jalankan ulang `bun test` alih-alih mempercayai angka di atas sebagai apa pun selain snapshot. Ia mencakup gate milik-root repositori ini sendiri: audit dokumentasi, pemeriksaan artefak knowledge-graph, konvensi changeset/rilis, pemeriksaan pin-toolchain, dan [`tests/kontrak-arah-impor.test.mjs`](../tests/kontrak-arah-impor.test.mjs) — gate arah-impor yang dideskripsikan di [ADR-0004](adr/0004-a-type-only-contract-package-with-an-import-direction-gate.md).

## 2. `apps/storefront`: type-check plus bukti-build, tanpa suite `bun test` sendiri

`apps/storefront` hari ini tidak punya berkas `*.test.*` — `bun run check` (di dalam workspace itu, `bun --bun astro check`) adalah type-check, bukan test run, dan itu langkah yang dijalankan skrip `build` milik `apps/storefront/package.json` sendiri sebelum `astro build`. Yang membuktikan aplikasi benar-benar membangun situs nyata tanpa `apps/cms` hidup untuk dijangkau adalah **prosedur manual dua-terminal**, bukan langkah CI yang tersambung:

```bash
# terminal 1
bun scripts/stub-awcms.mjs
# terminal 2
AWCMS_API_URL=http://localhost:4310 AWCMS_API_TOKEN=stub-token \
  SITE_URL=http://localhost:4321 bun run build
```

[`apps/storefront/scripts/stub-awcms.mjs`](../apps/storefront/scripts/stub-awcms.mjs) melayani dua endpoint komersial yang dipanggil `apps/storefront/src/lib/catalog.ts`, membaca body responsnya langsung dari [`tests/fixtures/awcms/{products,categories}.json`](../apps/storefront/tests/fixtures/awcms/) — fixture berbentuk persis seperti envelope `{ items, nextCursor }` nyata yang benar-benar dikembalikan rute komersial `apps/cms` (lihat [`docs/api.md`](api.md)), bukan bentuk rekaan. Ia sengaja tidak tersambung ke skrip `package.json` mana pun atau build produksi: tidak ada apa pun di bawah `scripts/` yang diimpor `astro.config.mjs`, `src/`, atau `apps/storefront/server/penyaji.mjs`.

## 3. `apps/cms` (`bun run check:cms`): butuh PostgreSQL, tidak dijalankan ulang untuk menulis dokumen ini

`apps/cms` membawa rantai gate besarnya sendiri — skrip `check`-nya menjalankan kira-kira 55 gate (diverifikasi terhadap skrip `check` milik `apps/cms/package.json` saat tulisan ini dibuat: 60 langkah gabungan-`&&` total, 54 di antaranya bernama `<area>:check`, ditambah `lint`, `check:docs`, `check:docs:translation`, `typecheck`, `test`, dan `build`) plus `bun test`-nya sendiri, dilaporkan di tempat lain dalam dokumentasi basis kode ini sendiri sekitar 6.000 tes. **Tidak satu pun dari ini dijalankan ulang untuk menulis dokumen ini** — ia butuh PostgreSQL hidup yang tidak diberikan ke lingkungan ini, dan menjalankan ulang suite ~6.000-tes adalah verifikasi yang tidak diklaim dilakukan perubahan dokumentasi ini. Prosedur di bawah adalah yang didokumentasikan skill pengujian `apps/cms` sendiri ([`apps/cms/.claude/skills/awcms-testing/SKILL.md`](../apps/cms/.claude/skills/awcms-testing/SKILL.md)), dinyatakan ulang di sini karena pembaca dokumentasi repositori ini sendiri seharusnya tidak perlu mencarinya di dalam subtree yang di-embed.

### Prosedur basis-data terisolasi

1. **Basis data PostgreSQL segar dan kosong**, lalu `bun run db:migrate` (root: `bun run db:migrate:cms`) dari kosong — tidak pernah terhadap basis data yang membawa data workspace lain.
2. **Harness migrasi/tes butuh role basis-data berhak-istimewa, bukan `awcms_app`.** Ia menjalankan `CREATE DATABASE`/`ALTER ROLE`, yang tidak bisa dilakukan role aplikasi tak-berhak-istimewa by design (`permission denied to alter role`, error PostgreSQL `42501`) — kegagalan itu bukan skip dan tidak boleh salah dibaca sebagai regresi.
3. **Kehadiran `.env` saja menyalakan suite ber-gate-DB.** Bun memuat `.env` sendiri, jadi menghapus `DATABASE_URL` dari environment shell saja tidak menonaktifkannya; `.env` harus disingkirkan untuk mereproduksi run tanpa basis data terkonfigurasi.

### Kira-kira 240 kegagalan diharapkan di bawah role app tak-berhak-istimewa, dan tidak satu pun milik commerce

Menjalankan suite ber-gate-DB `apps/cms` **sebagai role `awcms_app` tak-berhak-istimewa** (alih-alih role berhak-istimewa yang dibutuhkan harness itu sendiri) gagal pada kira-kira 240 tes integrasi upstream dengan error kelas `permission denied` / `alter role` — karakteristik yang sudah ada pada suite tes `apps/cms` sendiri di bawah role itu, bukan sesuatu yang diperkenalkan modul `commerce`. `apps/cms/.claude/skills/awcms-testing/SKILL.md` mendokumentasikan kelas kegagalan yang sama dan cara menghindari memicunya (menimpa `DATABASE_URL`/`SETUP_DATABASE_URL`/`WORKER_DATABASE_URL` ke connection string berhak-istimewa yang sama saat menjalankan harness). Tidak satu pun dari ~240 kegagalan ini dihitung ulang untuk dokumen ini — angkanya dibawa dari verifikasi sebelumnya selama pengembangan platform ini sendiri, bukan diukur ulang terhadap basis data hidup saat menulis halaman ini.

## Apa yang dibutuhkan setiap suite untuk menjawab "apakah commerce benar"

| Pertanyaan | Suite |
| --- | --- |
| Apakah tabel transisi `product-status.ts` berperilaku benar secara terisolasi? | `apps/cms/tests/commerce-domain.test.ts` milik `apps/cms` (murni, tanpa basis data) |
| Apakah RLS benar-benar mengisolasi `awcms_commerce_*` per tenant? | Suite integrasi RLS generik `apps/cms` (butuh PostgreSQL) — lihat [`docs/skema-basis-data.md`](skema-basis-data.md) |
| Apakah storefront membangun situs nyata terhadap envelope API nyata? | Prosedur manual `stub-awcms.mjs` di atas |
| Apakah `apps/cms` pernah diimpor dengan arah salah dari `apps/storefront`/`packages/kontrak`? | Root `bun test` → `tests/kontrak-arah-impor.test.mjs` |
| Apakah dokumentasi dan konvensi rilis repositori ini sendiri bertahan? | Root `bun test` plus gate `audit:*` |

## Belum dibangun

Job CI yang benar-benar menjalankan suite ber-gate-DB `apps/cms` terhadap PostgreSQL yang disediakan — `check:cms` ada sebagai skrip tapi belum tersambung ke `.github/workflows/ci.yml` hari ini (lihat [`docs/deployment.md`](deployment.md) untuk alasannya: penyediaan PostgreSQL increment 2 belum terjadi). Tes smoke build-dan-serve otomatis untuk `apps/storefront` di CI — prosedur `stub-awcms.mjs` di atas hanya manual.
