🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](pengujian.md)

<!-- i18n-source-hash: sha256:34cf701aa0a2cc9f5dc8875b4b0a3dc743890acd0612c1b2733907a23481b838 -->

# Pengujian

Tiga tingkat, masing-masing dimiliki workspace berbeda, dijalankan oleh dua job CI. Dokumen ini menamai ketiganya dan bagaimana menjalankan masing-masing — ia tidak menyatakan ulang setiap berkas tes satu per satu.

## 1. Root gate suite (`bun test` dari root repo)

Tidak butuh basis data, tidak butuh build, dan tidak butuh jaringan di luar `bun install`. Mengecualikan `apps/cms/**` sepenuhnya lewat `[test] pathIgnorePatterns` milik `bunfig.toml` (CI memanggil `bun test` telanjang, dan flag pada `bun run test` diam-diam tidak akan berlaku pada pemanggilan telanjang itu). Mencakup gate milik-root repositori ini sendiri (audit dokumentasi, pemeriksaan artefak knowledge-graph, konvensi changeset/rilis, pemeriksaan pin-toolchain, [`tests/kontrak-arah-impor.test.mjs`](../tests/kontrak-arah-impor.test.mjs)) **plus setiap tes unit, build-smoke, dan rute milik `apps/storefront` sendiri** — `apps/storefront` tidak punya skrip `test` sendiri; berkas `tests/*.test.ts`-nya berjalan sebagai bagian dari pemanggilan `bun test` root yang sama ini, di seluruh workspace.

## 2. `apps/storefront`: tes unit, type-check, dan dua tingkat build-smoke

`apps/storefront/tests/` menyimpan sekitar 40 berkas (tidak termasuk `e2e/`), dikelompokkan kira-kira per area:

| Kelompok | Yang dicakup |
| --- | --- |
| News/`berita-*` | Rendering Portable Text (`videoNews`/`gallery`), hierarki rubrik, pembangunan dan pencarian peta legacy-redirect, pemformatan tanggal WIB, validitas RSS, bentuk JSON-LD, guard `/news/**` (dinamai untuk ADR-0071 milik `ahliweb/awcms` sendiri) |
| Catalog/`katalog-*` | Pencarian/filter, pemformatan harga, kontrak keranjang, penurunan origin-media CSP, JSON-LD, toleransi permukaan marketing |
| Runtime/checkout | `toko-klien`/`toko-origin`/`toko-csp` (klien API anonim, validasi `PUBLIC_AWCMS_ORIGIN`, `connect-src` CSP), `checkout-guard-no-prerender` (tidak ada berkas `apps/storefront/src/pages` yang keluar dari output statis), `checkout-build-smoke`, `wilayah-checkout`, `wishlist-kontrak` |
| Server/build/umum | `build-smoke`, `penyaji`, `portable-text`, `profil`, `routes`, `sitemap`, `telepon`, `theme`, `wa-fallback`, `warna` (kontras) |

`bun --bun astro check` (skrip `check` milik `apps/storefront/package.json`) adalah type-check, dijalankan sebagai langkah pertama `bun run build`. **Build manual dua-terminal berbasis stub** tambahan membuktikan aplikasi benar-benar membangun situs nyata tanpa `apps/cms` hidup untuk dijangkau — tidak tersambung ke CI, tapi dijalankan tangan pada setiap PR yang menyentuh workspace ini:

```bash
# terminal 1
bun scripts/stub-awcms.mjs
# terminal 2
AWCMS_API_URL=http://localhost:4310 AWCMS_API_TOKEN=stub-token \
  PUBLIC_AWCMS_ORIGIN=https://cms.example.com SITE_URL=http://localhost:4321 bun run build
```

`apps/storefront/scripts/stub-awcms.mjs` melayani setiap endpoint yang dipanggil storefront, termasuk state machine storefront-commerce (quote → buat pesanan → lacak → konfirmasi pembayaran → batalkan) yang dijalankan alur checkout, membaca body respons dari `apps/storefront/tests/fixtures/awcms/`. Ia sengaja tidak diimpor oleh `astro.config.mjs`, `src/`, atau `apps/storefront/server/penyaji.mjs` — tidak ada apa pun di jalur build produksi yang bisa menjangkaunya secara tidak sengaja.

### Playwright e2e — tingkat keempat, perintahnya sendiri, bukan bagian dari `bun test`

`apps/storefront/tests/e2e/checkout.e2e.ts` menjalankan browser Chromium nyata terhadap build+serve+stub nyata, dijalankan dengan `bun run test:e2e` **di dalam `apps/storefront`** (tidak pernah root `bun test` — sufiks `.e2e.ts` sengaja menjaganya di luar discovery itu). Mencakup add-to-cart → quote keranjang me-render total → checkout submit → pelacakan menampilkan pesanan, plus state not-found netral untuk telepon yang salah. **Tidak tersambung ke `.github/workflows/ci.yml`** — ini di luar cakupan berkas CI milik-ops untuk issue yang menambahkannya; `apps/storefront/README.md` mendokumentasikan persis bagaimana job CI di masa depan akan menjalankannya (install Chromium, jalankan stub, build dengan env yang tepat, serve, arahkan `E2E_BASE_URL`/`STUB_ALLOWED_ORIGIN` satu sama lain).

## 3. `apps/cms` (job CI `check-cms`): PostgreSQL nyata yang disediakan

Berbeda dari increment 1, ini bukan lagi prosedur manual-saja — [issue #25](https://github.com/ahliweb/awcms-one/issues/25) menyediakan PostgreSQL baik untuk pengembangan lokal maupun CI. `apps/cms` membawa rantai gate besarnya sendiri (skrip `check` milik `apps/cms/package.json`: 53 langkah gabungan-`&&` — lint, docs/i18n, setiap gate registry/konsistensi, typecheck, `bun test`, `bun run build`) plus `bun test`-nya sendiri (sekitar 6.200 tes per PR orders/customers) dan suite `tests/integration/` yang butuh basis data hidup.

### Menjalankannya secara lokal

```bash
cd apps/cms && DATABASE_URL="" bun run check   # every DB-gated suite skips cleanly
```

Lalu, terhadap basis data sekali-pakai (root: `bun run db:up`, atau container buang-pakai Anda sendiri):

```bash
DATABASE_URL=postgres://awcms:<password>@localhost:<port>/awcms bun run db:migrate:cms
cd apps/cms && DATABASE_URL=postgres://awcms:<password>@localhost:<port>/awcms \
  bun test tests/integration/ --timeout 60000
```

**Harness migrasi/tes butuh role basis-data berhak-istimewa, bukan `awcms_app`.** Ia menjalankan `CREATE DATABASE`/`ALTER ROLE`, yang tidak bisa dilakukan role aplikasi tak-berhak-istimewa by design (`permission denied to alter role`, error PostgreSQL `42501`) — bukan regresi. **Kehadiran `.env` milik `apps/cms` saja menyalakan suite ber-gate-DB** — Bun memuat `.env` sendiri, jadi menghapus `DATABASE_URL` dari shell saja tidak menonaktifkannya.

### Apa yang persis dijalankan `check-cms` di CI (`.github/workflows/ci.yml`)

Container layanan `postgres:18.4` (`POSTGRES_USER=awcms`, `POSTGRES_DB=awcms`, health-checked dengan `pg_isready`), lalu: `cd apps/cms && DATABASE_URL="" bun run check`, lalu `bun run db:migrate:cms` terhadap layanan itu, lalu `cd apps/cms && bun test tests/integration/ --timeout 60000` — lebih dari 670 tes per PR orders/customers, termasuk `commerce-catalog.integration.test.ts` (filter list, by-slug, CRUD gambar/varian, restore, RLS lintas-tenant), `commerce-marketing.integration.test.ts` (penurunan flash-sale, job tick yang menembak persis sekali, voucher publik, indeks single-active popup, round-trip settings). Langkah job-summary melaporkan jumlah skip ber-gate-DB sebelum dan sesudah basis data hidup tersambung, sehingga reviewer bisa melihat suite itu benar-benar berjalan.

**Orders/customers (issue #29) adalah satu-satunya area tanpa `apps/cms/tests/integration/commerce-orders.integration.test.ts` yang di-commit.** Pengurangan stok, double-submit idempoten, pelacakan telepon-salah, expire-lalu-restock, dan isolasi RLS lintas-tenant semuanya dibuktikan dengan tangan terhadap instans Postgres nyata yang baru dimigrasi selama pengembangan issue itu sendiri (menangkap dan memperbaiki dua bug nyata — id foreign-key yang salah pada baris pesanan flash-sale, dan grant worker yang hilang untuk tulisan job expiry itu sendiri) — tapi ini tidak tambahan dikodekan sebagai berkas tes yang di-commit dan bisa diulang. Dicatat di sini sebagai celah nyata, bukan diam-diam dijatuhkan.

## Dua hal yang harus diketahui kontributor sebelum menulis query di sini

- **Uang terbaca sebagai `"0"`, bukan `"0.00"`, lewat query `Bun.SQL` yang diparameterisasi.** `0.00` yang tersimpan ter-decode sebagai teks `"0"` saat dibaca lewat protokol extended (query yang diparameterisasi) tapi sebagai `"0.00"` lewat query simple — setiap nilai non-nol menjaga skalanya di kedua kasus. `normalizeMoney` (`apps/cms/src/modules/commerce/domain/price-calculation.ts`) ada khusus untuk membuat bentuk wire tidak bergantung pada protokol mana yang kebetulan melayani baris itu; setiap `toRecord` di modul commerce melewatkan setiap field uang lewatnya sebelum pernah meninggalkan modul (`null` lewat tanpa berubah — nilai uang yang tidak ada adalah `null` di wire, tidak pernah `"0.00"`). Terapkan di jalur baca, tidak pernah di aritmetika.
- **`= ANY($ids)` dengan array JS biasa diam-diam mis-bind di bawah `Bun.SQL`.** Dilewatkan langsung, array berisi dua atau lebih id ter-bind sebagai satu nilai teks `"a,b"` (error PostgreSQL `22P02`); array satu-elemen lolos diam-diam, yang persis inilah yang membuat ini pernah lolos sekali (memengaruhi setiap list produk #23 dengan dua atau lebih produk yang membawa gambar, sampai seeding #26 sendiri menangkapnya). Perbaikan yang dipakai di seluruh modul commerce adalah `tx.array([...ids], "uuid")::uuid[]` — bind array secara eksplisit sebagai `uuid[]` Postgres, tidak pernah parameter telanjang.

## Apa yang dibutuhkan setiap tingkat untuk menjawab "apakah commerce benar"

| Pertanyaan | Tingkat |
| --- | --- |
| Apakah state machine produk/pesanan/flash-sale berperilaku benar secara terisolasi? | `apps/cms/tests/commerce-domain.test.ts`, `apps/cms/tests/commerce-marketing-domain.test.ts` milik `apps/cms` (murni, tanpa basis data) |
| Apakah RLS benar-benar mengisolasi setiap tabel `awcms_commerce_*` per tenant? | Suite integrasi RLS generik milik `apps/cms`, diturunkan dari pernyataan `ENABLE`/`FORCE` masing-masing tabel (butuh PostgreSQL) |
| Apakah API storefront anonim me-resolve tenant dengan benar dan menolak sisanya? | `commerce-catalog.integration.test.ts`/`commerce-marketing.integration.test.ts` milik `apps/cms` (butuh PostgreSQL); orders/customers hanya dibuktikan dengan tangan, lihat di atas |
| Apakah storefront membangun situs nyata terhadap envelope API nyata, termasuk checkout? | Build berbasis stub milik `apps/storefront`, dan `bun run test:e2e` |
| Apakah `apps/cms` pernah diimpor dengan arah salah dari `apps/storefront`/`packages/kontrak`? | Root `bun test` → `tests/kontrak-arah-impor.test.mjs` |
| Apakah dokumentasi dan konvensi rilis repositori ini sendiri bertahan? | Root `bun test` plus gate `audit:*` |

## Belum dibangun

Job CI untuk suite Playwright e2e milik `apps/storefront` (berjalan dan lulus secara lokal; lihat "Playwright e2e" di atas). `apps/cms/tests/integration/commerce-orders.integration.test.ts` yang di-commit untuk area orders/customers (lihat di atas). Tooling visual-regression atau accessibility-audit apa pun — lihat [`docs/aksesibilitas.md`](aksesibilitas.id.md) dan [`docs/responsif.md`](responsif.id.md) untuk apa yang diverifikasi dengan membaca kode sebagai gantinya.
