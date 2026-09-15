🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](alur-kerja-pengembangan.md)

<!-- i18n-source-hash: sha256:e1dc70a9b88e2229a9674794f7ce42756655692e914d21acb06f4ec4d8b14571 -->

# Alur kerja pengembangan

Branching, konvensi changeset buatan-sendiri, pemotongan rilis, dan branch protection GitHub nyata repositori ini — dibaca dari pengaturan live repositori ini sendiri, bukan dari apa yang direncanakan, karena keduanya sejak itu berbeda (lihat catatan di akhir bagian ini).

## Branching dan PR

Satu branch per issue, dipotong dari `main`; PR kembali ke `main`, berjudul merujuk issue yang ditutupnya. [`CONTRIBUTING.md`](../CONTRIBUTING.md) menamai alur kontribusi lengkap dan Definition of Done di [`AGENTS.md`](../AGENTS.md#definition-of-done) — dokumen ini tidak mengulang keduanya, hanya bagian yang spesifik untuk bagaimana perubahan benar-benar mendarat.

## Branch protection pada `main`

Diverifikasi langsung terhadap pengaturan GitHub repositori ini saat tulisan ini dibuat (`gh api repos/ahliweb/awcms-one/branches/main/protection`):

| Pengaturan | Nilai |
| --- | --- |
| Status check wajib | `Check` (satu-satunya job yang didefinisikan `.github/workflows/ci.yml`) |
| Strict (branch harus up to date sebelum merge) | Ya |
| Force push | Ditolak |
| Penghapusan branch | Ditolak |
| Tanda tangan wajib | Tidak |
| Berlaku untuk admin | Tidak |
| Riwayat linear wajib | Tidak |
| Resolusi percakapan wajib | Tidak |

`delete_branch_on_merge` aktif di seluruh repositori (juga diverifikasi lewat `gh api repos/ahliweb/awcms-one`), jadi branch yang sudah di-merge dibersihkan otomatis tanpa memandang strategi merge. **Squash merge, rebase merge, dan merge commit biasa semuanya masih diizinkan di seluruh repositori** — branch protection di sini mensyaratkan job `Check` lulus sebelum merge, ia tidak membatasi *bagaimana* PR boleh di-merge. Rekomendasi untuk menonaktifkan squash/rebase merge khusus untuk PR yang menjalankan `git subtree pull` (sehingga jebakan mekanis yang dideskripsikan [ADR-0001](adr/0001-git-subtree-with-full-history-for-apps-cms.md) ditegakkan alih-alih sekadar didokumentasikan) dicatat di sini dan di `AGENTS.md`, dan **belum** diambil — menggabung PR semacam itu dengan apa pun selain merge commit tetap aturan yang harus diingat reviewer, bukan yang ditegakkan GitHub.

## Changeset buatan-sendiri, bukan `@changesets/cli`

Perubahan yang memengaruhi perilaku publik, struktur workspace, dependensi, atau deployment mendapat berkas di [`.changesets/`](../.changesets/README.md) dalam perubahan yang sama yang menyebabkannya: `YYYY-MM-DD-ringkasan-dalam-kebab-case.md`, dengan frontmatter `bump: major | minor | patch` dipilih saat menulis perubahan, karena itu satu-satunya momen siapa pun secara andal tahu jawabannya. `bun run audit:rilis` mengawasi backlog yang menunggu dan memerah begitu melewati 10 berkas atau 14 hari usianya — sinyal bahwa rilis sudah waktunya, bukan kesalahan. Saat tulisan ini dibuat, 5 changeset menunggu, yang tertua bertanggal hari dokumen ini ditulis.

## Pemotongan rilis

`bun run release` (aksi maintainer, [`tools/rilis.mjs`](../tools/rilis.mjs)) melipat setiap changeset yang menunggu ke `CHANGELOG.md`, memakai `bump` **terbesar** di antara mereka untuk memutuskan versi berikutnya — satu `minor` di samping sembilan entri `patch` membuat seluruh rilis `minor`, jadi ukuran rilis adalah konsekuensi dari apa yang masuk ke dalamnya, bukan penilaian yang dibuat saat rilis dari daftar nama berkas. `--commit` tambahan menandai `vX.Y.Z`.

## CI: satu job, semuanya tanpa syarat

`.github/workflows/ci.yml` mendefinisikan satu job, `Check`, berjalan pada setiap push ke `main`, setiap pull request, dan dispatch manual. Setiap langkah di dalamnya tidak butuh build, tidak butuh `apps/cms` hidup, dan tidak butuh basis data — pemeriksaan lockfile, `bun install --frozen-lockfile`, langkah type-check storefront yang mengaktifkan diri sendiri begitu `apps/storefront/package.json` ada (memang ada, per dokumen ini), root `bun test`, `audit:dokumen`, `audit:translation`, `audit:graf`, `audit:rilis`, dan `bun audit --audit-level=low`. Tidak ada apa pun di workflow ini yang membangun image container, men-deploy apa pun, atau menjalankan rantai gate `apps/cms` sendiri (`check:cms`) — lihat [`docs/deployment.md`](deployment.md) dan [`docs/pengujian.md`](pengujian.md) untuk mengapa yang belakangan butuh basis data yang tidak disediakan job CI ini.

## Belum ditegakkan hari ini

Pembatasan strategi-merge yang terikat khusus pada PR yang menyentuh `apps/cms` (aturan honour-system di atas). Jumlah review wajib atau syarat code-owner — branch protection di sini menamai satu status check wajib dan tidak ada apa pun soal reviewer. `check:cms` (atau gate `apps/cms` mana pun) berjalan di CI repositori ini sendiri.
