🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](alur-kerja-pengembangan.md)

<!-- i18n-source-hash: sha256:93017ad385fd0230b946c649202a682062b54ed5651e1823d5b96f8813dd2e12 -->

# Alur kerja pengembangan

Branching, konvensi changeset buatan-sendiri, pemotongan rilis, dan branch protection GitHub nyata repositori ini — dibaca dari pengaturan live repositori ini sendiri, bukan dari apa yang direncanakan, karena keduanya sejak itu berbeda (lihat catatan di akhir bagian ini).

## Branching dan PR

Satu branch per issue, dipotong dari `main`; PR kembali ke `main`, berjudul merujuk issue yang ditutupnya. [`CONTRIBUTING.md`](../CONTRIBUTING.md) menamai alur kontribusi lengkap dan Definition of Done di [`AGENTS.md`](../AGENTS.md#definition-of-done) — dokumen ini tidak mengulang keduanya, hanya bagian yang spesifik untuk bagaimana perubahan benar-benar mendarat.

## Branch protection pada `main`

Diverifikasi langsung terhadap pengaturan GitHub repositori ini saat tulisan ini dibuat (`gh api repos/ahliweb/awcms-one/branches/main/protection`):

| Pengaturan | Nilai |
| --- | --- |
| Status check wajib | `Check` **dan** `check-cms` — kedua job `.github/workflows/ci.yml` |
| Strict (branch harus up to date sebelum merge) | Ya |
| Force push | Ditolak |
| Penghapusan branch | Ditolak |
| Tanda tangan wajib | Tidak |
| Berlaku untuk admin | Tidak |
| Riwayat linear wajib | Tidak |
| Resolusi percakapan wajib | Tidak |

`check-cms` ditambahkan ke daftar wajib setelah dua run hijau di `main`, memakai perintah persis yang dicatat lebih dulu oleh [`docs/deployment.md`](deployment.id.md) dan PR issue #25 sendiri — lihat "CI: dua job" di bawah untuk apa yang dijalankan masing-masing. `delete_branch_on_merge` aktif di seluruh repositori (juga diverifikasi lewat `gh api repos/ahliweb/awcms-one`), jadi branch yang sudah di-merge dibersihkan otomatis tanpa memandang strategi merge. **Squash merge, rebase merge, dan merge commit biasa semuanya masih diizinkan di seluruh repositori** — branch protection di sini mensyaratkan kedua job lulus sebelum merge, ia tidak membatasi *bagaimana* PR boleh di-merge. Rekomendasi untuk menonaktifkan squash/rebase merge khusus untuk PR yang menjalankan `git subtree pull` (sehingga jebakan mekanis yang dideskripsikan [ADR-0001](adr/0001-git-subtree-with-full-history-for-apps-cms.md) ditegakkan alih-alih sekadar didokumentasikan) dicatat di sini dan di `AGENTS.md`, dan **belum** diambil — menggabung PR semacam itu dengan apa pun selain merge commit tetap aturan yang harus diingat reviewer, bukan yang ditegakkan GitHub.

## Changeset buatan-sendiri, bukan `@changesets/cli`

Perubahan yang memengaruhi perilaku publik, struktur workspace, dependensi, atau deployment mendapat berkas di [`.changesets/`](../.changesets/README.md) dalam perubahan yang sama yang menyebabkannya: `YYYY-MM-DD-ringkasan-dalam-kebab-case.md`, dengan frontmatter `bump: major | minor | patch` dipilih saat menulis perubahan, karena itu satu-satunya momen siapa pun secara andal tahu jawabannya. `bun run audit:rilis` mengawasi backlog yang menunggu dan memerah begitu melewati 20 berkas atau 14 hari usianya — sinyal bahwa rilis sudah waktunya, bukan kesalahan.

## Pengiriman berbasis wave, di epic ini

Increment 2 (epic #21) dikirimkan sebagai rangkaian PR atomik satu-issue, bukan satu perubahan besar: gelombang pertama pekerjaan fondasi independen (perbaikan `check:cms` #22, chrome storefront #24, PostgreSQL lokal + seed + `check-cms` #25), lalu pasangan CMS/storefront yang harus diserialisasi terhadap modul yang sama (katalog `commerce` #23 → marketing #26 → orders/customers #29 di sisi `apps/cms`; chrome #24 → berita #28 → katalog #27 → checkout #30 di sisi `apps/storefront`, masing-masing bergantung pada berkas bersama dari issue sebelumnya), dengan issue dokumentasi ini (#31) berjalan terakhir karena ia satu-satunya yang harus melihat setiap issue lain di-merge sebelum bisa mendeskripsikan tree secara jujur. Setiap PR menamai bagian "Notes/Deviations/Decisions for #31"-nya sendiri khusus agar refresh ini tidak perlu menurunkannya ulang dari diff.

## Pemotongan rilis

`bun run release` (aksi maintainer, [`tools/rilis.mjs`](../tools/rilis.mjs)) melipat setiap changeset yang menunggu ke `CHANGELOG.md`, memakai `bump` **terbesar** di antara mereka untuk memutuskan versi berikutnya — satu `minor` di samping sembilan entri `patch` membuat seluruh rilis `minor`, jadi ukuran rilis adalah konsekuensi dari apa yang masuk ke dalamnya, bukan penilaian yang dibuat saat rilis dari daftar nama berkas. `--commit` tambahan menandai `vX.Y.Z`. Issue #31 (refresh dokumentasi ini) tidak memotong rilis itu sendiri — lihat [`.changesets/README.md`](../.changesets/README.md) untuk batas backlog dan bagian "Gates" `README.md` untuk `audit:rilis`.

## CI: dua job — satu tanpa syarat, satu terhadap basis data nyata

`.github/workflows/ci.yml` mendefinisikan dua job.

**`check`** (`name: Check`, `timeout-minutes: 15`) berjalan pada setiap push ke `main`, setiap pull request, dan dispatch manual, tidak butuh build, tidak butuh `apps/cms` hidup, dan tidak butuh basis data: `bun run check:lockfile`, `bun install --frozen-lockfile`, langkah type-check storefront (`bun run check`, yang mendelegasikan ke `bun --bun astro check` milik `apps/storefront` sendiri — guard `if: hashFiles('apps/storefront/package.json') != ''` langkah ini adalah sisa dari sebelum workspace itu ada dan sekarang selalu benar), root `bun test`, `audit:dokumen`, `audit:translation`, `audit:graf`, `audit:rilis`, dan `bun audit --audit-level=low`. Tidak ada apa pun di job ini yang membangun image container atau men-deploy apa pun.

**`check-cms`** (`name: check-cms`, `needs: check`, `timeout-minutes: 20`) berjalan terhadap container layanan `postgres:18.4` nyata (`POSTGRES_USER=awcms`, `POSTGRES_DB=awcms`, port 5432, health-checked dengan `pg_isready`):

1. `bun install --frozen-lockfile` di root.
2. `cd apps/cms && DATABASE_URL="" bun run check` — rantai penuh ~53 langkah (lint, docs/i18n, setiap gate registry/konsistensi, typecheck, `bun test` dengan setiap suite ber-gate-DB skip bersih, `bun run build`).
3. `DATABASE_URL=postgres://awcms:awcms_ci_password@127.0.0.1:5432/awcms` ditulis ke `$GITHUB_ENV`, lalu `bun run db:migrate:cms` menerapkan setiap migrasi ke basis data layanan yang segar.
4. `cd apps/cms && bun test tests/integration/ --timeout 60000` — suite integrasi ber-gate-DB, kini benar-benar berjalan (lebih dari 670 tes per PR orders/customers).
5. Langkah job-summary (`if: always()`) meng-grep jumlah `N skip` dari kedua berkas log dan melaporkan jumlah skip ber-gate-DB sebelum/sesudah, sehingga reviewer bisa melihat suite itu benar-benar berjalan, bukan diam-diam skip dua kali.

Kedua job adalah status check wajib di `main` (lihat "Branch protection pada `main`" di atas) — ini menutup celah yang dideskripsikan draf dokumen ini sebelumnya: rantai gate `apps/cms` sendiri, dan cakupan RLS/basis datanya, berjalan di CI repositori INI sendiri pada setiap PR, tidak hanya lokal.

## CI: workflow ketiga, belum wajib — `template-init-smoke`

`.github/workflows/template-init-smoke.yml` (issue #138) adalah berkas workflow TERPISAH, bukan job ketiga di `ci.yml` — berkas itu dimiliki oleh perubahan lain yang landing bersamaan (issue #137), dan cakupan workflow ini sendiri meminta berkas baru alih-alih job yang ditempelkan ke sana. Ia mematriks `toko`/`berita`/`landing` (ADR-0018 D2): untuk setiap profil, ia menjalankan `bun run template:init --profil <profile> --yes` terhadap checkout-nya sendiri (termasuk rantai gate akhir milik alat itu sendiri), memulai stub CMS milik storefront, menjalankan `SITE_PROFILE=<profile> bun run build` dari `apps/storefront`, lalu `bun test` root. Ia **belum menjadi status check wajib** — mengikuti pola promosi yang sama yang dilalui `check-cms` sendiri (lihat "Branch protection pada `main`" di atas): ditambahkan ke daftar wajib hanya setelah berjalan hijau di `main` untuk sementara waktu.

## Belum ditegakkan hari ini

Pembatasan strategi-merge yang terikat khusus pada PR yang menyentuh `apps/cms` (aturan honour-system di [`AGENTS.md`](../AGENTS.md#the-one-rule-that-protects-every-future-sync)). Jumlah review wajib atau syarat code-owner — branch protection di sini menamai dua status check wajib dan tidak ada apa pun soal reviewer. Langkah CI yang membangun atau mempublikasikan image container, atau men-deploy ke mana pun — lihat [`docs/deployment.md`](deployment.id.md) untuk apa arti "men-deploy repositori ini" hari ini.
