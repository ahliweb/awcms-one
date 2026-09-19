🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](template.md)

<!-- i18n-source-hash: sha256:971fcfd0b173ed6490c941bbf12a1eb33ce5c575bd77166f6663729092f9ab0b -->

# Menggunakan awcms-one sebagai template

Dokumen ini adalah kerangka yang dijanjikan [ADR-0018](adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.id.md) untuk diisi: bagaimana aplikasi baru dimulai dari `awcms-one`, apa yang dilakukan `bun run template:init` untuk menjadikan repo turunan miliknya sendiri, matriks profil build yang memutuskan halaman mana yang dikirim sebuah deployment, dan di mana BjekMart sendiri berada begitu repo ini juga menjadi template. **Per penulisan dokumen ini (wave 0, issue #136), tidak satu pun mekanisme di bawah ada di kode** — tidak ada tata letak `src/profil/**`, tidak ada skrip `template:init`, tidak ada data seed per profil. Halaman ini menjelaskan target yang menjadi dasar pembangunan #137, #138, dan #139, dan diperbarui seiring pohonnya seperti yang dijelaskan di "Status" di bagian bawah. **Pembaruan, wave 1 (#139):** bagian "Seed contoh" di bawah kini sungguhan — `tools/seed-cms.ts` dan set seed netral per profil sudah ada; `src/profil/**` dan `template:init` (#137/#138) belum.

## Memulai dari template

1. **Use this template.** Setelah [#140](https://github.com/ahliweb/awcms-one/issues/140) mengatur flag GitHub *template repository*, klik "Use this template" pada `ahliweb/awcms-one` untuk membuat repo baru tanpa riwayat — bukan fork. Clone repo itu.
2. **`bun install`**, lalu **`bun run template:init`** (lihat referensi CLI di bawah) — penulisan ulang permukaan merek repo ini yang idempoten dan satu kali (nama, domain, warna, kontak, profil terpilih) menjadi milik Anda sendiri. Jawab prompt-nya, atau berikan semua flag secara non-interaktif (berguna dalam skrip atau CI).
3. **`.env`** — `cp .env.example .env` di root, dan `cp apps/cms/.env.example apps/cms/.env` untuk backend; isi apa yang belum diatur `template:init` (kredensial database, kunci provider mana pun yang ingin Anda pakai — lihat [ADR-0017](adr/0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.id.md) untuk kebutuhan setiap provider).
4. **`bun run db:up`** — PostgreSQL lokal lewat `docker compose`.
5. **`bun run db:migrate:cms`** — menjalankan rantai migrasi `apps/cms` sendiri terhadap database itu.
6. **`bun run db:seed:cms:profil <toko|berita|landing>`** — menyemai konten contoh netral yang sesuai profil pilihan Anda (D6, #139); `bun run db:seed:cms` (tanpa argumen) tetap menyemai konten referensi BjekMart yang lengkap (`contoh:borneojek-mart`, default yang tidak berubah).
7. **`bun run dev`** — menjalankan `apps/cms` dan `apps/storefront` untuk pengembangan lokal, storefront dibangun sesuai `SITE_PROFILE` dari langkah 2.
8. **Deploy** sesuai [`docs/deployment.md`](deployment.id.md) — build, lalu serve, persis seperti deployment referensi repo ini sendiri; tidak ada yang berubah dari mekanisme itu hanya karena "menjadi repo turunan."

## `template:init` — referensi CLI

```
bun run template:init \
  --nama "Toko Contoh" \
  --slug toko-contoh \
  --domain toko-contoh.id \
  --profil toko|berita|landing \
  --warna-primer "#0ea5e9" \
  [--warna-sekunder "#0369a1"] \
  [--warna-aksen "#f59e0b"] \
  --kontak-email owner@toko-contoh.id \
  [--kontak-telepon "+62 812-0000-0000"] \
  [--alamat "Jl. Contoh No. 1, Kota Contoh"] \
  [--dry-run] \
  [--yes]
```

| Flag | Wajib | Arti |
| --- | --- | --- |
| `--nama` | Ya | Nama tampilan deployment — menjadi `DEFAULT_IDENTITY.name`, `description` root `package.json`, dan hero `README*.md`/`SUPPORT*.md`/`SECURITY*.md` |
| `--slug` | Ya | Identifier kebab-case — menjadi `name` root `package.json`, nama proyek `compose.yaml`, dan kode tenant seed default |
| `--domain` | Ya | Domain produksi kanonis — menjadi default `SITE_URL` di `.env.example` dan `homepage` `package.json` |
| `--profil` | Ya | `toko`, `berita`, atau `landing` — menjadi default `SITE_PROFILE` di `.env.example` dan memilih set seed netral mana yang menjadi target default `db:seed:cms` |
| `--warna-primer` | Ya | Warna hex — menjadi `DEFAULT_THEME_COLORS.primary` |
| `--warna-sekunder` | Tidak | Default ke corak lebih gelap dari `--warna-primer` bila tidak diberikan — `DEFAULT_THEME_COLORS.secondary` |
| `--warna-aksen` | Tidak | Default ke aksen kontras bila tidak diberikan — `DEFAULT_THEME_COLORS.accent` |
| `--kontak-email` | Ya | Menjadi `DEFAULT_IDENTITY.contactEmail` dan baris kontak `SUPPORT*.md`/`SECURITY*.md` |
| `--kontak-telepon` | Tidak | Menjadi `DEFAULT_IDENTITY.contactPhone` bila diberikan; jika tidak, tidak ada baris telepon alih-alih mengarang satu |
| `--alamat` | Tidak | Menjadi `DEFAULT_IDENTITY.address` bila diberikan |
| `--dry-run` | Tidak | Mencetak rencana penulisan-ulang/penghapusan lengkap dan tidak menyentuh apa pun |
| `--yes` | Tidak | Wajib untuk melanjutkan pada working tree yang kotor; jika tidak, alat menolak berjalan alih-alih mencampur penulisan-ulangnya sendiri ke dalam perubahan yang belum di-commit |

**Interaktif vs. non-interaktif:** flag wajib yang hilang meminta lewat prompt saat stdin adalah TTY; jika tidak, alat keluar dengan kode **`2`**, menamai setiap flag yang hilang dalam satu baris, sehingga job CI atau skrip mendapat kegagalan yang jelas dan bisa dibaca mesin alih-alih tergantung pada prompt yang tidak bisa dijawab siapa pun.

**Idempotensi:** menjalankan `template:init` kedua kalinya dengan flag yang persis sama adalah no-op — keluar **`0`**, mencetak "nothing to do." Menjalankannya lagi dengan satu atau lebih flag berbeda menulis ulang lagi, hanya menyentuh apa yang benar-benar berubah. Inilah yang membuat aman bagi job CI `template-init-smoke` milik [#138](https://github.com/ahliweb/awcms-one/issues/138) sendiri untuk berjalan tanpa pengawasan, dan aman bagi manusia untuk menjalankannya ulang setelah memperbaiki salah ketik pada flag sebelumnya.

**Kode keluar:** `0` sukses (termasuk "nothing to do"); `1` kegagalan internal (file yang diharapkan alat untuk ditulis ulang hilang, gerbang yang dijalankannya di akhir gagal); `2` flag wajib hilang dalam mode non-interaktif; `3` ditolak pada working tree yang kotor tanpa `--yes`.

### Apa yang ditulis ulang

Persis permukaan merek yang dinamai [ADR-0018 D4](adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.id.md#d4--merek-hidup-di-env--sitets-ditambah-daftar-pendek-dan-bernama-file-yang-ditulis-ulang-templateinit):

- `apps/storefront/src/config/site.ts` — `DEFAULT_IDENTITY`, `DEFAULT_THEME_COLORS`
- Root `package.json` — `name`, `description`, `homepage`, `repository`, dan field `awcmsOne.templateVersion` baru yang mencatat versi awcms-one asal repo turunan ini dibuat
- `compose.yaml` — nama proyek Docker Compose
- `README.md`/`README.id.md` — bagian hero
- `SUPPORT.md`/`SUPPORT.id.md`, `SECURITY.md`/`SECURITY.id.md` — baris kontak
- `.env.example` — `SITE_NAME`, `SITE_URL`, `SITE_PROFILE`, dan default terkait
- `CHANGELOG.md` — direset ke satu entri `## [0.1.0]` berbunyi "Created from awcms-one vX.Y.Z (\<sha\>)"
- `.changesets/*.md` — dibersihkan (README dipertahankan)

### Apa yang dihapus

Artefak khusus BjekMart yang tidak dibutuhkan deployment turunan dan tidak seharusnya dibawa sebagai beban mati atau konten contoh yang menyesatkan:

- `tools/seed-borneojek-mart.ts` (atau, setelah [#139](https://github.com/ahliweb/awcms-one/issues/139) landing, titik masuk `contoh:borneojek-mart` milik `tools/seed-cms.ts` sendiri dan `tools/seed-data/contoh/borneojek-mart/**`)
- `tools/import-seputarborneo.ts` dan `tests/import-seputarborneo.test.mjs`
- `graphify-out/` dan `knowledge/generated/` — direset ke keadaan kosong terdokumentasi, siap untuk `bun run knowledge:graph:update` pertama milik repo turunan sendiri

### Apa yang tidak pernah disentuh

**`apps/cms/**` tidak pernah ditulis ulang, di bawah flag mana pun.** Ia adalah `ahliweb/awcms`, di-embed lewat `git subtree` ([ADR-0001](adr/0001-git-subtree-with-full-history-for-apps-cms.id.md)) — pohon upstream sendiri, dibawa ke sini agar perbaikan mengalir dua arah lewat `git subtree pull`. Alat penulis-ulang-merek yang menyentuhnya akan menciptakan persis jenis divergensi lokal yang sudah diperingatkan bagian subtree [`AGENTS.md`](../AGENTS.id.md#embed-subtree) tidak bisa diserap dengan aman oleh sinkronisasi di masa depan. Nama tenant, detail kontak, dan tema deployment turunan sendiri sepenuhnya hidup di data yang dilayani `apps/cms` (modul `site_profile`/`theming`-nya) atau di fallback saat-build `site.ts` yang disediakan `apps/storefront` — tidak pernah di source `apps/cms` sendiri.

### Setelah ia berjalan

`template:init` selesai dengan menjalankan, secara berurutan: `docs:i18n:stamp`, `bun install`, `audit:dokumen`, `audit:translation`, `audit:rilis`, dan root `bun test` — sehingga commit pertama repo turunan sudah hijau, titik awal "gerbang lulus sebelum Anda menyentuh apa pun" yang sama yang diharapkan `AGENTS.md` repo ini sendiri dari setiap perubahan di sini.

## Profil build

`SITE_PROFILE` (dibaca saat build oleh `apps/storefront/src/config/profil.ts`, setelah #137 landing) memilih kelompok halaman mana yang disertakan sebuah build. Penalaran lengkap: [ADR-0018 D2/D3](adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.id.md).

| Profil | Komposisi | Apa itu |
| --- | --- | --- |
| `toko` (default) | shared + toko + berita | Bentuk BjekMart hari ini — commerce dan berita bersama |
| `berita` | shared + berita | Portal berita saja, tanpa commerce |
| `landing` | shared saja | Profil perusahaan / situs landing — halaman, kontak, chrome SEO; tanpa commerce, tanpa berita |

### Matriks profil

Setiap file di bawah `apps/storefront/src/pages/**` termasuk tepat satu kelompok. Tabel ini mencerminkan salinan [ADR-0018](adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.id.md#matriks-profil) sendiri; salinan ADR itu adalah kontrak wave-0, yang ini dijaga tetap terkini seiring halaman benar-benar pindah ke `src/profil/<group>/pages/**`.

| Path | Kelompok | Kenapa |
| --- | --- | --- |
| `404.astro` | shared | Setiap profil butuh halaman tidak-ditemukan |
| `akun/afiliasi.astro` | toko | Dashboard afiliasi commerce |
| `akun/alamat.astro` | toko | Buku alamat commerce |
| `akun/index.astro` | toko | Shell dashboard akun commerce |
| `akun/pesanan.astro` | toko | Riwayat pesanan commerce |
| `akun/pesan.astro` | toko | Thread inbox pelanggan commerce |
| `akun/ulasan.astro` | toko | Ulasan produk commerce |
| `arsip/[yyyy]/[mm].astro` | berita | Arsip bulanan berita |
| `berita/feed.xml.ts` | berita | Feed RSS berita (pos) |
| `berita/index.astro` | berita | Halaman depan berita |
| `berita/[slug].astro` | berita | Artikel berita |
| `buletin/index.astro` | berita | Halaman berlangganan newsletter |
| `cari.astro` | toko | Pencarian produk (dibangun dari `/index/produk.json`) |
| `cari-berita.astro` | berita | Pencarian berita |
| `checkout.astro` | toko | Checkout commerce |
| `csp.json.ts` | shared | Setiap profil menurunkan artefak CSP-nya sendiri |
| `daerah/[slug].astro` | berita | Bagian regional berita |
| `daftar.astro` | toko | Registrasi pelanggan commerce |
| `feed.xml.ts` | toko | Feed RSS produk (bukan feed berita — itu `berita/feed.xml.ts`) |
| `flash-sale.astro` | toko | Flash sale commerce |
| `halaman/[slug].astro` | shared | Halaman CMS statis (privasi, syarat, redaksi, dll.) |
| `index.astro` | shared (varian per profil) | Setiap profil punya halaman utama; kontennya berbeda per profil |
| `index/berita.json.ts` | berita | Indeks pencarian berita saat build |
| `index/pengalihan-legacy.json.ts` | berita | Peta redirect URL berita legacy |
| `index/produk.json.ts` | toko | Indeks pencarian produk saat build |
| `index/wilayah-kabupaten-[provinceCode].json.ts` | toko | Cascade wilayah-alamat checkout (bukan wilayah berita) |
| `index/wilayah-kecamatan-[cityCode].json.ts` | toko | Cascade wilayah-alamat checkout |
| `index/wilayah-provinsi.json.ts` | toko | Cascade wilayah-alamat checkout |
| `kategori/[slug].astro` | toko | Daftar kategori commerce |
| `keranjang.astro` | toko | Keranjang commerce |
| `kontak.astro` | shared | Setiap profil butuh halaman kontak |
| `manifest.webmanifest.ts` | shared | Setiap profil adalah situs yang bisa dipasang |
| `masuk.astro` | toko | Sign-in pelanggan commerce |
| `mitra/[slug].astro` | berita | Direktori institusi/"Mitra" — fitur kemitraan berita, bukan commerce (lihat catatan kasus-tepi ADR-0018 sendiri) |
| `newsletter/confirm.astro` | berita | Konfirmasi opt-in ganda newsletter |
| `newsletter/unsubscribe.astro` | berita | Unsubscribe newsletter |
| `penulis/[slug].astro` | berita | Halaman penulis berita |
| `pesanan.astro` | toko | Pelacakan pesanan commerce |
| `product-labels.css.ts` | toko | Styling badge produk commerce |
| `product/[slug].astro` | toko | Detail produk commerce |
| `produk.astro` | toko | Daftar produk commerce |
| `robots.txt.ts` | shared | Setiap profil butuh aturan robots-nya sendiri |
| `rubrik/[slug]/feed.xml.ts` | berita | Feed RSS rubrik berita |
| `rubrik/[slug]/halaman/[n].astro` | berita | Paginasi rubrik berita |
| `rubrik/[slug]/index.astro` | berita | Halaman depan rubrik berita |
| `sitemap-index.xml.ts` | shared | Setiap profil punya sitemap-nya sendiri |
| `sitemap-[n].xml.ts` | shared | Paginasi sitemap |
| `tag/[slug].astro` | berita | Halaman tag berita |
| `theme-tokens.css.ts` | shared | Setiap profil punya warna temanya sendiri |
| `video/index.astro` | berita | Daftar video berita |
| `video/[slug].astro` | berita | Artikel video berita |
| `wishlist.astro` | toko | Wishlist commerce |

**Total:** shared 10, `toko` 23, `berita` 19 (total 52).

### Navigasi, sitemap, feed, robots, CSP, dan fixture per profil

| | `toko` (default) | `berita` | `landing` |
| --- | --- | --- | --- |
| **Navigasi** | Beranda, Produk, Flash Sale, Berita, Kontak, ditambah ikon keranjang/wishlist/akun | Beranda, Berita, Rubrik, Video, Buletin, Kontak | Beranda, halaman statis, Kontak saja |
| **Tautan legal footer** | Panduan belanja, privasi, syarat, redaksi, pedoman media, disclaimer | Redaksi, pedoman media, disclaimer, privasi, syarat | Privasi, syarat saja |
| **Sumber sitemap** | Semua: `static-routes`, `static-pages`, `katalog-produk`, `katalog-kategori`, `katalog-product-detail`, `berita-front`, `berita-posts`, `berita-video`, `berita-rubrik`, `berita-daerah`, `berita-mitra`, `berita-tag` | `static-routes`, `static-pages`, dan setiap sumber `berita-*` | `static-routes`, `static-pages` saja |
| **Feed** | Feed produk + feed pos berita + feed rubrik | Feed pos berita + feed rubrik | Tidak ada |
| **Aturan robots** | Melarang path per-pengunjung commerce (`/keranjang`, `/checkout`, `/pesanan`, `/wishlist`, `/cari`, `/masuk`, `/daftar`, `/akun`) ditambah `/newsletter/*`, `/api/` | Melarang `/newsletter/*`, `/api/` | Melarang `/api/` saja |
| **CSP `form-action`/`connect-src`** | `form-action 'self'`, `connect-src` diperluas ke `PUBLIC_AWCMS_ORIGIN` (checkout/keranjang) | `form-action 'self'` saja | `form-action 'self'` saja |
| **Fixture stub-CMS yang dibutuhkan** | Setiap fixture commerce ditambah setiap fixture berita (build hibrida butuh keduanya) | `blog-posts.json`, `blog-terms.json`, `blog-institutions.json`, `blog-pages-public*.json`, `seo-redirects-legacy.json`, `regions-kalteng.json`, `ad-placements-active.json`, `analytics-pages.json` | `blog-pages-public*.json`, `store-settings-public.json`, `media-objects.json`/`media-public-origin.json`; tidak ada fixture khusus commerce atau berita |

## Seed contoh

`bun run db:seed:cms:profil <toko|berita|landing|contoh:borneojek-mart>` (setara dengan `bun run db:seed:cms -- --profil <nama>`; [#139](https://github.com/ahliweb/awcms-one/issues/139), `tools/seed-cms.ts`) menyemai salah satu dari:

- **`toko`, `berita`, `landing`** — konten contoh kecil, netral, dan fiktif di bawah `tools/seed-data/profil/<profile>/*`: tanpa orang nyata, nomor telepon, e-mail, atau nama merek — kontak placeholder memakai `example.com`/`example.id` dan nomor bergaya `+62 800 0000 0000`. `toko` mengirim ≤ 20 produk di ≤ 6 kategori ditambah pemasaran/halaman/syarat; `berita` mengirim ≤ 15 pos di ≤ 5 rubrik, ≤ 3 byline penulis informasional, ≤ 4 halaman, dan baris region/instansi yang dibutuhkan arsip `/daerah/{slug}`; `landing` mengirim profil situs, ≤ 4 halaman, dan detail kontak saja. Gambar placeholder adalah SVG yang dibuat sendiri di bawah `tools/seed-assets/profil/<profile>/`. Setiap seed idempoten (upsert berdasarkan slug, aman dijalankan ulang) dan memvalidasi terhadap bentuk yang sudah didokumentasikan `apps/cms/openapi/awcms-public-api.openapi.yaml` untuk endpoint yang dipanggil seeder.
- **`contoh:borneojek-mart`** — konten referensi BjekMart yang lengkap, dipindah dari lokasi aslinya ke `tools/seed-data/contoh/borneojek-mart/**`. `bun run db:seed:cms` tanpa flag `--profil` tetap menargetkan ini secara default, sehingga alur kerja deployment referensi yang hidup tidak berubah; `tools/seed-borneojek-mart.ts` (berkas yang dulu MENJADI seeder-nya) kini adalah shim deprecation satu-rilis yang mencetak peringatan lalu mendelegasikan ke `tools/seed-cms.ts --profil contoh:borneojek-mart`.

`--dry-run` memvalidasi JSON seed profil pilihan dan mencetak ringkasan inventaris tanpa membuat panggilan jaringan sama sekali — aman dijalankan terhadap basis data yang sudah berisi konten sungguhan (lihat "Seeding a profile locally" di `docs/alur-kerja-pengembangan.md` untuk runbook lengkap dan alasan basis data dev lokal bersama tidak pernah diisi dengan profil netral).

## BjekMart sebagai contoh referensi

BjekMart tidak dihapus begitu repo ini menjadi template — ia **dipertahankan, secara eksplisit diberi label sebagai contoh referensi**: deployment nyata, terus-dirawat, dan lengkap dari profil `toko`, sedalam lima increment, yang bisa dilihat siapa pun yang memulai dari template ini untuk melihat seperti apa rupa build yang selesai. `bun run dev` tanpa `template:init` dijalankan sama sekali tetap memberi Anda situs BjekMart sendiri, persis seperti sejak increment 1; `template:init` adalah yang mengubah pohon yang sama ini menjadi sesuatu yang lain, begitu Anda memilih untuk menjalankannya.

## Status

**20 September 2026 — wave 0 (issue #136):** dokumen ini adalah kerangka yang dijanjikan ADR-0018. Belum ada tata letak `apps/storefront/src/profil/**`, belum ada skrip `template:init`, dan belum ada data seed per profil di pohonnya. Halaman ini diperbarui untuk menjelaskan mekanisme sebenarnya seiring [#137](https://github.com/ahliweb/awcms-one/issues/137) (profil storefront + matriks CI), [#138](https://github.com/ahliweb/awcms-one/issues/138) (`template:init`), dan [#139](https://github.com/ahliweb/awcms-one/issues/139) (seed profil) landing, dan flag GitHub *template repository* sendiri diatur di [#140](https://github.com/ahliweb/awcms-one/issues/140).

**20 September 2026 — wave 1 (issue #139):** `tools/seed-cms.ts` landing, dengan `--profil toko|berita|landing|contoh:borneojek-mart` dan `--dry-run`, ditambah set seed netral kecil di bawah `tools/seed-data/profil/{toko,berita,landing}/*` dan SVG placeholder di bawah `tools/seed-assets/profil/**` yang dijelaskan bagian di atas. `tools/seed-data/*.json` dipindah ke `tools/seed-data/contoh/borneojek-mart/**`, tidak berubah bentuknya; `tools/seed-borneojek-mart.ts` kini adalah shim deprecation satu-rilis. `#137` (profil storefront + matriks CI) dan `#138` (`template:init`) masih tertunda — referensi CLI `template:init` dan matriks profil build di halaman ini masih menjelaskan TARGET yang dibangun kedua issue itu, bukan kode yang sudah ada.
