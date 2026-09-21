🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](alur-kerja-pengembangan.md)

<!-- i18n-source-hash: sha256:e778960c660d8a9d876981ad3eb834d712ca4d28c50d901c787a57d552fd34da -->

# Alur kerja pengembangan

Branching, konvensi changeset buatan-sendiri, pemotongan rilis, dan branch protection GitHub nyata repositori ini — dibaca dari pengaturan live repositori ini sendiri, bukan dari apa yang direncanakan, karena keduanya sejak itu berbeda (lihat catatan di akhir bagian ini).

## Branching dan PR

Satu branch per issue, dipotong dari `main`; PR kembali ke `main`, berjudul merujuk issue yang ditutupnya. [`CONTRIBUTING.md`](../CONTRIBUTING.md) menamai alur kontribusi lengkap dan Definition of Done di [`AGENTS.md`](../AGENTS.md#definition-of-done) — dokumen ini tidak mengulang keduanya, hanya bagian yang spesifik untuk bagaimana perubahan benar-benar mendarat.

## Branch protection pada `main`

Diverifikasi langsung terhadap pengaturan GitHub repositori ini saat tulisan ini dibuat (`gh api repos/ahliweb/awcms-one/branches/main/protection`):

| Pengaturan | Nilai |
| --- | --- |
| Status check wajib | `Check (toko)`, `Check (berita)`, `Check (landing)` **dan** `check-cms` — sejak increment 6 (issue #137) job `Check` storefront adalah matriks 3-leg, keempat leg/job `.github/workflows/ci.yml` wajib |
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

**`check`** (`name: Check`, `timeout-minutes: 15`) berjalan pada setiap push ke `main`, setiap pull request, dan dispatch manual, tidak butuh build, tidak butuh `apps/cms` hidup, dan tidak butuh basis data. Sejak increment 6 (issue #137, [ADR-0018 D7](adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.id.md)), ia adalah **matriks 3-leg** (`strategy.matrix.profile: [toko, berita, landing]`, `fail-fast: false`) — GitHub menampilkan tiap leg sebagai `Check (toko)`, `Check (berita)`, `Check (landing)`. Setiap leg menjalankan `bun run check:lockfile`, `bun install --frozen-lockfile`, lalu `SITE_PROFILE=<leg> bun run check` (type-check storefront yang mencakup `src/profil/**` tanpa memandang group mana yang aktif) dan `cd apps/storefront && SITE_PROFILE=<leg> bun test tests/profil-build-smoke.test.ts tests/profil-routes.test.ts` — build milik leg itu sendiri terhadap stub CMS, membuktikan group halaman yang dikecualikan sungguh-sungguh absen dari `dist/` dan sitemap. `bun test` root, `audit:dokumen`, `audit:translation`, `audit:graf`, `audit:rilis`, dan `bun audit --audit-level=low` tidak bergantung pada profil, jadi ia berjalan **sekali saja, di leg `toko`** (`if: matrix.profile == 'toko'`), tanpa `SITE_PROFILE` diatur — di langkah itu, `profil-build-smoke` sendiri membangun ketiga profil, jadi leg `toko` sendiri sudah membuktikan seluruh matriks. Tidak ada apa pun di job ini yang membangun image container atau men-deploy apa pun.

**`check-cms`** (`name: check-cms`, `needs: check`, `timeout-minutes: 20`) berjalan terhadap container layanan `postgres:18.4` nyata (`POSTGRES_USER=awcms`, `POSTGRES_DB=awcms`, port 5432, health-checked dengan `pg_isready`):

1. `bun install --frozen-lockfile` di root.
2. `cd apps/cms && DATABASE_URL="" bun run check` — rantai penuh ~53 langkah (lint, docs/i18n, setiap gate registry/konsistensi, typecheck, `bun test` dengan setiap suite ber-gate-DB skip bersih, `bun run build`).
3. `DATABASE_URL=postgres://awcms:awcms_ci_password@127.0.0.1:5432/awcms` ditulis ke `$GITHUB_ENV`, lalu `bun run db:migrate:cms` menerapkan setiap migrasi ke basis data layanan yang segar.
4. `cd apps/cms && bun test tests/integration/ --timeout 60000` — suite integrasi ber-gate-DB, kini benar-benar berjalan (lebih dari 670 tes per PR orders/customers).
5. Langkah job-summary (`if: always()`) meng-grep jumlah `N skip` dari kedua berkas log dan melaporkan jumlah skip ber-gate-DB sebelum/sesudah, sehingga reviewer bisa melihat suite itu benar-benar berjalan, bukan diam-diam skip dua kali.

Ketiga leg `Check` dan `check-cms` semuanya status check wajib di `main` (lihat "Branch protection pada `main`" di atas) — ini menutup celah yang dideskripsikan draf dokumen ini sebelumnya: rantai gate `apps/cms` sendiri, dan cakupan RLS/basis datanya, berjalan di CI repositori INI sendiri pada setiap PR, tidak hanya lokal.

## CI: workflow ketiga, belum wajib — `template-init-smoke`

`.github/workflows/template-init-smoke.yml` (issue #138) adalah berkas workflow TERPISAH, bukan job ketiga di `ci.yml` — berkas itu dimiliki oleh perubahan lain yang sejak itu landing (issue #137), dan cakupan workflow ini sendiri meminta berkas baru alih-alih job yang ditempelkan ke sana. Ia **belum menjadi status check wajib** — mengikuti pola promosi yang sama yang dilalui `check-cms` sendiri (lihat "Branch protection pada `main`" di atas): ditambahkan ke daftar wajib hanya setelah berjalan hijau di `main` untuk sementara waktu, DAN hanya setelah setidaknya tiga run berturut-turut terhadap kondisi kode yang sama semuanya kembali hijau (kriteria penerimaan issue #147 sendiri — lihat di bawah untuk alasan batas itu ada).

**Bentuk sejak issue #147.** Workflow aslinya menjalankan `bun test` root penuh — termasuk setiap tes build-smoke storefront, yang masing-masing memulai stub CMS-nya sendiri dan `astro build`-nya sendiri — satu kali per leg matriks, sehingga tiga salinan suite itu berebut CPU/IO runner dua-core yang sama secara bersamaan. Dua run `main` berturut-turut masing-masing gagal pada langkah `Root bun test` milik leg yang BERBEDA, pada tenggat mulai-stub tes build-smoke yang BERBEDA pula — perebutan sumber daya, bukan cacat profil yang nyata, tetapi justru jenis kegagalan sesekali yang membuat status "wajib" tidak bisa dipercaya. Perbaikannya adalah pemisahan tanggung jawab, bukan tenggat yang diperbesar:

- **Job matriks `template-init-smoke`** (`toko`/`berita`/`landing`, ADR-0018 D2) tetap menjalankan hal yang sungguhan per profil: `bun run template:init --profil <profile> --yes` terhadap checkout-nya sendiri (`TEMPLATE_INIT_TEST_SCOPE=root` menjaga `bun test` akhir milik alat itu sendiri tetap tercakup pada tes gate akar saja, bukan seluruh workspace), memulai stub CMS milik storefront (PID-nya ditulis ke berkas agar langkah berikutnya selalu bisa menemukan dan mematikannya), menjalankan `SITE_PROFILE=<profile> bun run build` dari `apps/storefront`, lalu `bun scripts/assert-profil-dist.ts` — pemeriksaan deterministik atas `dist/client` yang SAMA yang sudah dibangun (berkas/direktori grup yang dikecualikan tidak ada, grup yang aktif ada, tidak ada entri sitemap atau tautan halaman terbangun yang menyeberang ke rute yang dikecualikan), diturunkan dari `apps/storefront/src/config/profil.ts` dengan cara yang sama seperti `apps/storefront/tests/profil-build-smoke.test.ts`/`apps/storefront/tests/profil-routes.test.ts`, tetapi tanpa memicu build KEDUA seperti yang terjadi bila kedua berkas tes itu dijalankan lagi. Langkah `if: always()` di akhir mematikan PID stub itu dan, `if: failure()`, mencetak `/tmp/stub-awcms.log`.
- **Job `root-suite` terpisah**, tanpa matriks, menjalankan `template:init --profil toko` (lagi-lagi `TEMPLATE_INIT_TEST_SCOPE=root`) lalu `bun test` penuh TEPAT SATU KALI, di runner-nya sendiri tanpa apa pun lain yang berebut CPU. Inilah kini satu-satunya tempat di seluruh workflow ini di mana suite derived-repository penuh berjalan.

Dua detail menjaga rantai gate workflow ini sendiri tidak gagal terhadap dirinya sendiri. Pertama, probe kesiapan stub CMS memeriksa **dengan bearer token** (`curl -sf -H "Authorization: Bearer stub" http://localhost:4310/api/v1/commerce/products`) — stub menjawab `401` untuk request tanpa autentikasi memang disengaja (`apps/storefront/scripts/stub-awcms.mjs`), dan `curl -f` polos akan membaca `401` itu sebagai "belum siap" selamanya. Kedua, `tests/template-init.test.mjs` melewati dirinya sendiri begitu mendeteksi ia tidak lagi berjalan di dalam `awcms-one` (`package.json.name !== "awcms-one"`) — tanpa guard itu, `bun test` akhir milik sebuah run `template:init` akan menemukan dan menjalankan ulang berkas tesnya sendiri di dalam repositori yang baru saja diinisialisasinya, yang tes full-run-nya kemudian mencoba membangun salinan sementara lain dari `git ls-files`, yang masih mendaftar path yang sudah di-`unlinkSync` (tidak pernah di-`git rm`) oleh langkah penghapusan run itu sendiri, melempar `ENOENT` pada setiap satu darinya.

## Seeding profil secara lokal

`tools/seed-cms.ts` (`bun run db:seed:cms` / `bun run db:seed:cms:profil <nama>`, issue #139) menyemai `apps/cms` yang sudah dimigrasi dengan salah satu dari empat profil: set contoh netral dan fiktif `toko`/`berita`/`landing` di bawah `tools/seed-data/profil/**`, atau `contoh:borneojek-mart` (default di repositori INI — `template:init`, issue #138, menulis ulang default itu menjadi profil pilihan deployment di repo turunan, lihat [`docs/template.md`](template.md)) — konten lengkap deployment referensi yang hidup di bawah `tools/seed-data/contoh/borneojek-mart/**`. Lihat bagian "Seed contoh" di [`docs/template.md`](template.md) untuk isi tiap profil.

**Jangan pernah menyemai profil netral ke basis data dev lokal bersama milik repositori ini** (`postgres://awcms:awcms_dev_password@localhost:5433/awcms`, default `bun run db:up`) — basis data itu sudah berisi tenant BjekMart milik repositori ini, dan `POST /api/v1/setup/initialize` adalah kunci singleton sekali-per-basis-data (lihat `ensureTenantAndSession` milik `tools/seed-cms.ts` sendiri): run `--profil` kedua terhadap basis data yang sama akan gagal di langkah bootstrap, bukan membuat tenant kedua. Pakai `--dry-run` untuk melihat apa yang AKAN disemai suatu profil (ia memvalidasi JSON profil dan mencetak ringkasan inventaris, tanpa panggilan jaringan sama sekali, sehingga tidak butuh `apps/cms` yang berjalan dan selalu aman dijalankan), atau arahkan `AWCMS_BASE_URL`/`POSTGRES_*` ke basis data sekali-pakai saat run sungguhan terhadap suatu profil memang dibutuhkan.

## Belum ditegakkan hari ini

Pembatasan strategi-merge yang terikat khusus pada PR yang menyentuh `apps/cms` (aturan honour-system di [`AGENTS.md`](../AGENTS.md#the-one-rule-that-protects-every-future-sync)). Jumlah review wajib atau syarat code-owner — branch protection di sini menamai dua status check wajib dan tidak ada apa pun soal reviewer. Langkah CI yang membangun atau mempublikasikan image container, atau men-deploy ke mana pun — lihat [`docs/deployment.md`](deployment.id.md) untuk apa arti "men-deploy repositori ini" hari ini.
