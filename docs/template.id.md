🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](template.md)

<!-- i18n-source-hash: sha256:b88118119be97b2281bef6e534628a4c71fdfecb0d83127767c6e6bfda55edf8 -->

# Menggunakan awcms-one sebagai template

`awcms-one` adalah produk BjekMart sekaligus **template** yang menjadi titik awal aplikasi lain: `SITE_PROFILE` saat build memutuskan halaman mana yang dikirim sebuah deployment, dan `bun run template:init` yang idempoten menulis ulang permukaan merek untuk repo yang dibuat lewat flag *template repository* milik GitHub sendiri. Dokumen ini adalah referensi kerja yang dijanjikan [ADR-0018](adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.id.md): bagaimana aplikasi baru dimulai dari `awcms-one`, apa yang dilakukan `template:init` untuk menjadikan repo turunan miliknya sendiri, matriks profil build yang memutuskan halaman mana yang dikirim sebuah deployment, dan di mana BjekMart sendiri berada sekarang repo ini juga menjadi template. Setiap mekanisme yang dijelaskan dokumen ini adalah kode nyata, teruji, dan berjalan — perilaku penyaringan halaman `SITE_PROFILE` (`apps/storefront/src/config/profil.ts`, `src/profil/**`, issue #137), `bun run template:init` (`tools/template-init.ts` + `tools/template-init/**`, diuji oleh `tests/template-init.test.mjs`, dimatriks di CI oleh `.github/workflows/template-init-smoke.yml`, issue #138), dan set seed netral per profil (`tools/seed-cms.ts`, issue #139). Lihat "Status" di bagian bawah untuk riwayat landing bertanggal dan apa yang ditutup increment 6 (issue #140).

## Memulai dari template

1. **Use this template.** Klik "Use this template" pada `ahliweb/awcms-one` (flag GitHub *template repository* sudah aktif) untuk membuat repo baru tanpa riwayat — bukan fork. Clone repo itu.
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

- `apps/storefront/src/config/site.ts` — `DEFAULT_IDENTITY` (`name`, `description`, `contactEmail`, dan `contactPhone`/`address` bila diberikan), `DEFAULT_THEME_COLORS`, dan fallback `readEnvOr` `SITE_NAME`/`SITE_DESCRIPTION`
- Root `package.json` — `name`, `description`, `homepage`, `repository`, dan field `awcmsOne.templateVersion` baru yang mencatat versi awcms-one asal repo turunan ini dibuat
- `compose.yaml` — nama proyek Docker Compose
- `README.md`/`README.id.md` — bagian hero
- `SUPPORT.md`/`SUPPORT.id.md` — kalimat hero
- `.env.example` — default tenant skrip seed (`SEED_TENANT_CODE`/`SEED_TENANT_NAME`/`SEED_OFFICE_CODE`/`SEED_OFFICE_NAME`/`SEED_OWNER_EMAIL`)
- `apps/storefront/.env.example` — `SITE_URL`, `SITE_NAME`, `SITE_DESCRIPTION`, dan baris `SITE_PROFILE` milik #137 sendiri (dihapus komentarnya dan diatur ke profil pilihan)
- `tools/seed-cms.ts` (issue #139) — default `--profil`-nya, dari `contoh:borneojek-mart` menjadi profil pilihan deployment; skrip `db:seed:cms` milik `package.json` ditulis ulang dengan cara yang sama, dari `bun tools/seed-cms.ts` menjadi `bun tools/seed-cms.ts --profil <profil pilihan>`

**Tiga koreksi pada susunan kata asli bagian ini, dibuat dalam perubahan yang sama yang mengimplementasikan alat ini (issue #138), karena dokumen dan pohonnya tidak sejalan:**

- `DEFAULT_IDENTITY.description` tidak ada dalam daftar aslinya (hanya `name`/`contactEmail`/`contactPhone`/`address` yang disebut) — ditambahkan di sini karena membiarkannya tidak tersentuh mengirim kalimat khas BjekMart sendiri ("...di BjekMart") ke setiap deployment turunan selamanya, persis cacat yang dijelaskan paragraf "Ditolak (c)" milik D4 sendiri.

- `SECURITY.md`/`SECURITY.id.md` **tidak** membawa baris kontak spesifik-BjekMart apa pun sebagaimana pohonnya berdiri hari ini — setiap alamat di file itu adalah URL GitHub ke `ahliweb/awcms-one`, yang `template:init` sengaja **tidak** tulis ulang (lihat "Apa yang tidak diketahuinya" di bawah). `rewriteSecurity()` (`tools/template-init/rewriters.mjs`) adalah no-op terdokumentasi yang dipertahankan demi simetri dengan `SUPPORT.md`.
- `SITE_NAME`/`SITE_URL`/`SITE_DESCRIPTION`/`SITE_PROFILE` semuanya hidup di `apps/storefront/.env.example`, bukan `.env.example` root — file root hanya mendokumentasikan variabel milik skrip root (lihat header file itu sendiri). `SITE_PROFILE` sendiri adalah tambahan milik [#137](https://github.com/ahliweb/awcms-one/issues/137) sendiri ke file itu (default `# SITE_PROFILE=toko` yang dikomentari); `template:init` menghapus komentarnya dan mengaturnya ke profil pilihan deployment.

### Apa arti "tidak ada string BjekMart tersisa" sesungguhnya

Pengujian `template:init` sendiri (`tests/template-init.test.mjs`) memindai string spesifik-BjekMart hanya di dalam permukaan merek bernama milik D4 (`package.json`, `compose.yaml`, `.env.example`, `apps/storefront/.env.example`, `apps/storefront/src/config/site.ts`, `README*.md`, `SUPPORT*.md`) ditambah memastikan target penghapusan sudah tidak ada — **bukan** seluruh pohon. `docs/*`, `apps/storefront/**` (termasuk tes dan fixture-nya), dan `AGENTS.md`/riwayat `CHANGELOG.md` milik repositori ini sendiri secara sah menggambarkan BjekMart sebagai deployment referensi nyata lima-increment milik repositori ini sendiri (ADR-0018 D6) dan berada di luar cakupan `template:init`, oleh paragraf D4 yang sama yang menolak "berburu seluruh pohon tanpa daftar tertutup untuk diperiksa" sebagai opsi. Repo turunan karenanya tetap membaca nama BjekMart sendiri di seluruh dokumentasi dan fixture tes yang diwariskannya sampai ia mengeditnya sendiri — `template:init` hanya menjamin permukaan bernama miliknya SENDIRI yang bersih.

### Apa yang tidak diketahuinya

`template:init` tidak memiliki flag `--org`/`--repo`, sehingga tidak bisa mengetahui pemilik/nama GitHub milik repo turunan. `repository.url` milik `package.json` ditulis ulang menjadi `git+https://github.com/GANTI-ORG/<slug>.git` — placeholder yang jelas terlihat, bukan tebakan — dan setiap URL GitHub di dalam `README*.md`/`SUPPORT*.md`/`SECURITY*.md` yang masih menunjuk ke `ahliweb/awcms-one` (tautan issue, tautan Security Advisory, tautan ADR) dibiarkan persis apa adanya: itu adalah tautan fungsional, bukan teks merek, dan repo yang baru dibuat dari template belum tentu sudah diganti nama atau dipindahkan. Melengkapi `GANTI-ORG` dan tautan GitHub mana pun yang ingin diarahkan pemilik repo turunan ke fork miliknya sendiri tetap menjadi langkah manual setelah `template:init` berjalan.
- `.env.example` — `SITE_NAME`, `SITE_URL`, `SITE_PROFILE`, dan default terkait
- `CHANGELOG.md` — direset ke satu entri `## [0.1.0]` berbunyi "Created from awcms-one vX.Y.Z (\<sha\>)"
- `.changesets/*.md` — dibersihkan (README dipertahankan)

### Apa yang dihapus

Artefak khusus BjekMart yang tidak dibutuhkan deployment turunan dan tidak seharusnya dibawa sebagai beban mati atau konten contoh yang menyesatkan:

- `tools/seed-borneojek-mart.ts` (shim deprecation yang ditinggalkan [#139](https://github.com/ahliweb/awcms-one/issues/139)) dan `tools/seed-data/contoh/borneojek-mart/**` (konten referensi BjekMart lengkap yang dipindahkan #139 ke sana) — `template:init` juga memeriksa tata letak datar SEBELUM-#139 (`tools/seed-data/*.json` + `tools/seed-assets/`) dan menghapusnya juga, jika suatu saat alat ini berjalan terhadap pohon dari sebelum #139 landing. Skrip `db:seed:cms` milik `package.json` ditulis ulang, bukan dihapus: `bun tools/seed-cms.ts` (default milik BjekMart sendiri) menjadi `bun tools/seed-cms.ts --profil <profil pilihan>`, sehingga target seed default repo turunan cocok dengan pilihan `--profil`-nya sendiri, bukan contoh referensi.
- `tools/import-seputarborneo.ts`, `tests/import-seputarborneo.test.mjs`, dan entri skrip `import:seputarborneo`
- `graphify-out/` dan `knowledge/generated/` — dihapus sepenuhnya, bukan dikosongkan. **Inilah "keadaan kosong terdokumentasi" yang diterima `audit:graf`**: pemeriksaan pertama gerbang itu sendiri (`packages/gerbang/audit-graf.mjs`) adalah `!existsSync(outputDir)`, yang lulus dengan catatan ("graphify-out/ absent — no root graph artefacts to check") alih-alih gagal — direktori yang tidak ada adalah keadaan yang valid dan lulus gerbang menurut desain gerbang itu sendiri, sehingga menghapusnya lebih sederhana dan sama benarnya dengan menulis `graph.json` yang kosong-tapi-valid-skema. `bun run knowledge:graph:update` pertama milik repo turunan membuatnya kembali.

**`tests/seed-profil.test.mjs` (#139) sengaja dipertahankan, tidak dihapus**: ia memvalidasi seed netral `tools/seed-data/profil/{toko,berita,landing}/**` yang tetap dimiliki setiap repo turunan, bukan hanya contoh referensi BjekMart yang dihapus run ini. Blok describe khusus `contoh:borneojek-mart`/shim deprecation miliknya sendiri menjaga dirinya dengan pemeriksaan keberadaan (`HAS_CONTOH_SEED`/`HAS_DEPRECATION_SHIM`) dan skip bersih begitu `template:init` telah menghapus apa yang digambarkannya, alih-alih seluruh berkas menjadi target penghapusan.

### Apa yang tidak pernah disentuh

**`apps/cms/**` tidak pernah ditulis ulang, di bawah flag mana pun.** Ia adalah `ahliweb/awcms`, di-embed lewat `git subtree` ([ADR-0001](adr/0001-git-subtree-with-full-history-for-apps-cms.id.md)) — pohon upstream sendiri, dibawa ke sini agar perbaikan mengalir dua arah lewat `git subtree pull`. Alat penulis-ulang-merek yang menyentuhnya akan menciptakan persis jenis divergensi lokal yang sudah diperingatkan bagian subtree [`AGENTS.md`](../AGENTS.id.md#embed-subtree) tidak bisa diserap dengan aman oleh sinkronisasi di masa depan. Nama tenant, detail kontak, dan tema deployment turunan sendiri sepenuhnya hidup di data yang dilayani `apps/cms` (modul `site_profile`/`theming`-nya) atau di fallback saat-build `site.ts` yang disediakan `apps/storefront` — tidak pernah di source `apps/cms` sendiri.

### Setelah ia berjalan

`template:init` selesai dengan menjalankan, secara berurutan: `docs:i18n:stamp`, `bun install`, `audit:dokumen`, `audit:translation`, `audit:rilis`, dan root `bun test` — sehingga commit pertama repo turunan sudah hijau, titik awal "gerbang lulus sebelum Anda menyentuh apa pun" yang sama yang diharapkan `AGENTS.md` repo ini sendiri dari setiap perubahan di sini.

**`tests/template-init.test.mjs` melewati dirinya sendiri begitu mendeteksi ia tidak lagi berjalan di dalam `awcms-one` sendiri** (`package.json.name !== "awcms-one"`, dicetak sebagai satu baris SKIPPED yang jelas). Tanpa ini, `bun test` akhir ini akan menemukan dan menjalankan ulang berkas tesnya sendiri di dalam repositori yang baru saja diinisialisasinya — tes full-run milik berkas itu kemudian mencoba membangun SALINAN sementara lain dari `git ls-files`, yang masih mendaftar path yang sudah dihapus langkah penghapusan run ini sendiri (`unlinkSync` sungguhan, tidak pernah `git rm`), melempar `ENOENT` pada setiap satu darinya. Guard ini bukan solusi sementara untuk kegagalan penyalinan itu (`makeTempCopy` juga menyaring `git ls-files` lewat `existsSync`, secara defensif, sebagai lapisan pertahanan kedua yang independen) — ia adalah perbaikan sesungguhnya: pengujian ini ada untuk menguji template, dan tidak boleh pernah berjalan kedua kalinya terhadap repositori yang sudah bukan template lagi.

## Profil build

`SITE_PROFILE` (dibaca saat build oleh `apps/storefront/src/config/profil.ts`, [#137](https://github.com/ahliweb/awcms-one/issues/137)) memilih kelompok halaman mana yang disertakan sebuah build. Penalaran lengkap: [ADR-0018 D2/D3](adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.id.md).

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

Increment 6 (epic [#135](https://github.com/ahliweb/awcms-one/issues/135)) sudah selesai; setiap mekanisme di dokumen ini adalah kode nyata, teruji, dan berjalan, bukan rencana.

| Tanggal | Issue | Yang landing |
| --- | --- | --- |
| 20 September 2026 | [#136](https://github.com/ahliweb/awcms-one/issues/136) | [ADR-0018](adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.id.md) (D1–D8), kerangka dokumen ini, dan matriks profil (semua 52 berkas di bawah `apps/storefront/src/pages/**` ditetapkan) |
| 20 September 2026 | [#137](https://github.com/ahliweb/awcms-one/issues/137) | `SITE_PROFILE` sendiri — `apps/storefront/src/config/profil.ts`, integrasi `injectRoute` (`integrations/profil.mjs`), halaman dipindah ke `src/profil/<group>/pages/**`, default `# SITE_PROFILE=toko` yang dikomentari milik `apps/storefront/.env.example`, dan matriks build 3-leg `Check (toko|berita|landing)` milik `ci.yml`. `SITE_PROFILE` sungguh-sungguh memutuskan halaman mana yang disertakan sebuah build, persis seperti yang digambarkan matriks profil di atas |
| 20 September 2026 | [#139](https://github.com/ahliweb/awcms-one/issues/139) | `tools/seed-cms.ts`, dengan `--profil toko|berita|landing|contoh:borneojek-mart` dan `--dry-run`, ditambah set seed netral di bawah `tools/seed-data/profil/{toko,berita,landing}/*` dan SVG placeholder di bawah `tools/seed-assets/profil/**`; seed BjekMart dipindah ke `tools/seed-data/contoh/borneojek-mart/**`, tidak berubah bentuknya; `tools/seed-borneojek-mart.ts` menjadi shim deprecation satu-rilis |
| 20 September 2026 | [#138](https://github.com/ahliweb/awcms-one/issues/138) | `bun run template:init` (`tools/template-init.ts` + `tools/template-init/**`), diuji oleh `tests/template-init.test.mjs`, dimatriks di CI oleh `.github/workflows/template-init-smoke.yml`. Langkah penghapusannya dan penulisan-ulang `apps/storefront/.env.example`-nya menyasar langsung tata letak yang sudah landing dari #137 dan #139: `template:init --profil <p>` menghapus komentar dan mengatur baris `SITE_PROFILE` nyata yang ditambahkan #137, sehingga build repo turunan sungguh-sungguh menyaring halaman menurut profil pilihan sejak build pertamanya |
| 20 September 2026 | [#140](https://github.com/ahliweb/awcms-one/issues/140) | Sapuan dokumentasi ke keadaan sebenarnya (halaman ini, `README.md`, `AGENTS.md`, dokumen CI/routing/SEO/pengujian/deployment/alur-kerja, `apps/storefront/README.md`, panduan `.claude/skills/` termasuk skill baru `awcms-one-template`), flag GitHub *template repository*, pembersihan `EXCLUDED_PATHS` `packages/gerbang/audit-dokumen.mjs`, pembangunan ulang knowledge graph, dan rilis v0.8.0 yang menutup epic #135 |

Matriks `Check` tiga-leg dan `check-cms` adalah status check wajib di `main`; `template-init-smoke` belum wajib (lihat [`docs/alur-kerja-pengembangan.md`](alur-kerja-pengembangan.id.md) untuk rencana promosinya).
