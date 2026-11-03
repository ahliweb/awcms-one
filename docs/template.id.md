🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](template.md)

<!-- i18n-source-hash: sha256:9a38a63dbee7e72ef074127887f19c17e5a56cdd42067c8e2b2735e429b14b1f -->

# Menggunakan awcms-one sebagai template

`awcms-one` adalah produk BjekMart sekaligus **template** yang menjadi titik awal aplikasi lain: `SITE_PROFILE` saat build memutuskan halaman mana yang dikirim sebuah deployment, dan `bun run template:init` yang idempoten menulis ulang permukaan merek untuk repo yang dibuat lewat flag *template repository* milik GitHub sendiri. Dokumen ini adalah referensi kerja yang dijanjikan [ADR-0018](adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.id.md): bagaimana aplikasi baru dimulai dari `awcms-one`, apa yang dilakukan `template:init` untuk menjadikan repo turunan miliknya sendiri, matriks profil build yang memutuskan halaman mana yang dikirim sebuah deployment, dan di mana BjekMart sendiri berada sekarang repo ini juga menjadi template. Setiap mekanisme yang dijelaskan dokumen ini adalah kode nyata, teruji, dan berjalan — perilaku penyaringan halaman `SITE_PROFILE` (`apps/storefront/src/config/profil.ts`, `src/profil/**`, issue #137), `bun run template:init` (`tools/template-init.ts` + `tools/template-init/**`, diuji oleh `tests/template-init.test.mjs`, dimatriks oleh keempat leg `local-ci/template-*` milik `bun run ci:template` — `tools/ci/runners/template.ts`, sebelumnya `.github/workflows/template-init-smoke.yml`, issue #138/#225), dan set seed netral per profil (`tools/seed-cms.ts`, issue #139). Lihat "Status" di bagian bawah untuk riwayat landing bertanggal dan apa yang ditutup increment 6 (issue #140).

## Kepemilikan setelah membuat repo turunan

Membuat repository dari template ini membentuk **boundary produk baru**, bukan tenant tambahan dari reference deployment. Repo turunan memiliki dan mendeploy `apps/cms`, basis data, migrasi, secret, domain, kredensial provider, dan modul spesifik produknya sendiri. Jangan pernah mengonfigurasi produk turunan memakai backend hidup `ahliweb/awcms-one` sebagai system of record produksinya.

Ketika produk turunan menemukan capability yang belum tersedia:

1. implementasikan semantik spesifik produk di repo turunan;
2. tentukan apakah foundation yang belum ada benar-benar reusable lintas produk;
3. bila reusable, usulkan capability netral kembali ke `awcms-one` (atau ke `ahliweb/awcms` bila itu owner yang sebenarnya), lengkap dengan ADR, tes, migrasi, dan bukti kompatibilitas;
4. adopsi peningkatan template yang sudah dirilis kembali ke produk secara sengaja — jangan membuat dependency runtime permanen ke repo ini.

Aturan ownership ini bersifat normatif; lihat [ADR-0024](adr/0024-awcms-one-is-template-only-derived-apps-own-their-backend.id.md).

## Aplikasi persona (Lynx) adalah repositori terpisah

Produk turunan yang menginginkan aplikasi pelanggan, kurir, pengemudi, mitra atau gudang membangunnya di **repositori terpisah** terhadap API terdokumentasi backend-nya sendiri; aplikasi itu tidak ditambahkan ke workspace ini, ke `apps/storefront` atau ke `apps/cms` (ADR-0024). LynxJS/ReactLynx adalah kandidat utama, digerbangi PoC di sisi konsumen; admin dan setiap profil publik tetap Astro. Arah disetujui, **integrasi Lynx belum diimplementasikan** di template ini. Lihat [ADR-0050](adr/0050-lynxjs-for-separate-persona-apps-astro-stays-for-admin-and-public-profiles.id.md).

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
| `--kontak-telepon` | Tidak | Menjadi `DEFAULT_IDENTITY.contactPhone` bila diberikan; jika tidak, ditulis `null` (issue #233 — `DEFAULT_IDENTITY.contactPhone` bertipe `string \| null` khusus untuk ini) alih-alih membiarkan nomor telepon asli BjekMart sebagai fallback yang hidup. Setiap konsumen sudah merender tanpa blok telepon sama sekali saat nilainya `null` |
| `--alamat` | Tidak | Menjadi `DEFAULT_IDENTITY.address` bila diberikan; jika tidak, ditulis `null` dengan cara yang sama, untuk alasan yang sama — tidak ada blok alamat yang dirender, alih-alih alamat asli BjekMart |
| `--dry-run` | Tidak | Mencetak rencana penulisan-ulang/penghapusan lengkap dan tidak menyentuh apa pun |
| `--yes` | Tidak | Wajib untuk melanjutkan pada working tree yang kotor; jika tidak, alat menolak berjalan alih-alih mencampur penulisan-ulangnya sendiri ke dalam perubahan yang belum di-commit |

**Interaktif vs. non-interaktif:** flag wajib yang hilang meminta lewat prompt saat stdin adalah TTY; jika tidak, alat keluar dengan kode **`2`**, menamai setiap flag yang hilang dalam satu baris, sehingga job CI atau skrip mendapat kegagalan yang jelas dan bisa dibaca mesin alih-alih tergantung pada prompt yang tidak bisa dijawab siapa pun.

**Idempotensi:** menjalankan `template:init` kedua kalinya dengan flag yang persis sama adalah no-op — keluar **`0`**, mencetak "nothing to do." Menjalankannya lagi dengan satu atau lebih flag berbeda menulis ulang lagi, hanya menyentuh apa yang benar-benar berubah. Inilah yang membuat aman bagi leg `local-ci/template-*` milik [#138](https://github.com/ahliweb/awcms-one/issues/138) sendiri (`bun run ci:template`) untuk berjalan tanpa pengawasan, dan aman bagi manusia untuk menjalankannya ulang setelah memperbaiki salah ketik pada flag sebelumnya.

**Kode keluar:** `0` sukses (termasuk "nothing to do"); `1` kegagalan internal (file yang diharapkan alat untuk ditulis ulang hilang, gerbang yang dijalankannya di akhir gagal); `2` flag wajib hilang dalam mode non-interaktif; `3` ditolak pada working tree yang kotor tanpa `--yes`.

### Apa yang ditulis ulang

Persis permukaan merek yang dinamai [ADR-0018 D4](adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.id.md#d4--merek-hidup-di-env--sitets-ditambah-daftar-pendek-dan-bernama-file-yang-ditulis-ulang-templateinit):

- `apps/storefront/src/config/site.ts` — `DEFAULT_IDENTITY` (`name`, `description`, `contactEmail` selalu; `contactPhone`/`address` ditulis persis bila flag yang bersangkutan diberikan, dan ditulis sebagai literal `null` — tidak pernah dibiarkan sebagai nomor telepon/alamat asli BjekMart — bila tidak diberikan, sesuai issue #233; tipe `DEFAULT_IDENTITY` sendiri mengizinkan `null` khusus untuk dua field itu), `DEFAULT_THEME_COLORS`, dan fallback `readEnvOr` `SITE_NAME`/`SITE_DESCRIPTION`
- Root `package.json` — `name`, `description`, `homepage`, `repository`, dan field `awcmsOne.templateVersion` baru yang mencatat versi awcms-one asal repo turunan ini dibuat
- `compose.yaml` — nama proyek Docker Compose
- `bun.lock` — HANYA field `name` milik workspace root (`workspaces[""].name`), agar cocok dengan `name` `package.json` yang ditulis ulang; tidak ada bagian lain lockfile yang disentuh atau dibuat ulang (issue #227 — membiarkan field ini tetap `"awcms-one"` membuat `bun run check:lockfile` gagal di setiap repo turunan)
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

Pengujian `template:init` sendiri (`tests/template-init.test.mjs`) memindai string spesifik-BjekMart hanya di dalam permukaan merek bernama milik D4 (`package.json`, `compose.yaml`, `.env.example`, `apps/storefront/.env.example`, `apps/storefront/src/config/site.ts`, `README*.md`, `SUPPORT*.md`) ditambah memastikan target penghapusan sudah tidak ada — **bukan** seluruh pohon. `docs/*`, `apps/storefront/**` (termasuk tes dan fixture-nya), dan `AGENTS.md`/riwayat `CHANGELOG.md` milik repositori ini sendiri secara sah menggambarkan BjekMart sebagai deployment referensi nyata lima-increment milik repositori ini sendiri (ADR-0018 D6) dan berada di luar cakupan `template:init`, oleh paragraf D4 yang sama yang menolak "berburu seluruh pohon tanpa daftar tertutup untuk diperiksa" sebagai opsi. Repo turunan karenanya tetap membaca nama BjekMart sendiri di seluruh dokumentasi dan fixture tes yang diwariskannya sampai ia mengeditnya sendiri — `template:init` hanya menjamin permukaan bernama miliknya SENDIRI yang bersih. Sejak issue [#476](https://github.com/ahliweb/awcms-one/issues/476) tes yang sama juga membaca nilai yang dimiliki `template:init` di `.env.example` dan `apps/storefront/.env.example` (default tenant `SEED_*`, `SITE_URL`, `SITE_NAME`, `SITE_DESCRIPTION`, `SITE_PROFILE`) serta `CHANGELOG.md` yang sudah direset, untuk ketiga profil, dan gagal bila salah satunya memuat string BjekMart.

### Apa yang tidak diketahuinya

`template:init` tidak memiliki flag `--org`/`--repo`, sehingga tidak bisa mengetahui pemilik/nama GitHub milik repo turunan. `repository.url` milik `package.json` ditulis ulang menjadi `git+https://github.com/GANTI-ORG/<slug>.git` — placeholder yang jelas terlihat, bukan tebakan — dan setiap URL GitHub di dalam `README*.md`/`SUPPORT*.md`/`SECURITY*.md` yang masih menunjuk ke `ahliweb/awcms-one` (tautan issue, tautan Security Advisory, tautan ADR) dibiarkan persis apa adanya: itu adalah tautan fungsional, bukan teks merek, dan repo yang baru dibuat dari template belum tentu sudah diganti nama atau dipindahkan. Melengkapi `GANTI-ORG` dan tautan GitHub mana pun yang ingin diarahkan pemilik repo turunan ke fork miliknya sendiri tetap menjadi langkah manual setelah `template:init` berjalan. Alat ini mencetak langkah ini dan langkah manual lainnya saat selesai — lihat "Daftar periksa pasca-init" di bawah.
- `.env.example` — `SITE_NAME`, `SITE_URL`, `SITE_PROFILE`, dan default terkait
- `CHANGELOG.md` — direset ke satu entri `## [0.1.0]` berbunyi "Created from awcms-one vX.Y.Z (\<sha\>)". Sampai issue #476 reset ini diam-diam dibatalkan: pembersihan kutipan yang dijelaskan di "Apa yang dihapus" membaca berkas lama dari disk lalu menulisnya kembali menimpa reset, sehingga repo turunan menyimpan seluruh riwayat rilis template di samping `package.json` bernomor `0.1.0`. Pembersihan kini berangkat dari teks hasil reset, dan tes memeriksa bahwa tepat satu heading `## [` yang tersisa
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

**Repositori turunan dimulai tanpa satu pun workflow GitHub Actions di root, secara sengaja (issue #225, ADR-0021).** `template:init` tidak pernah membuat atau merujuk apa pun di bawah `.github/workflows/`, di bawah flag apa pun — `awcms-one` sendiri menjalankan nol GitHub Actions, dan repositori yang dibuat darinya mewarisi titik awal itu alih-alih sebuah berkas workflow yang toh perlu ditulis ulang untuk owner/repo baru. Rangkaian gerbang yang dijalankan `tools/ci/` (`bun run ci`, `bun run ci:pr -- <pr-number>`, `bun run ci:watch`) berfungsi tanpa modifikasi di repositori turunan dengan cara yang sama seperti di sini — tidak ada apa pun di dalamnya yang spesifik-`awcms-one` di luar owner/repo GitHub yang diresolusi `tools/ci/lib/github.ts` dari `git remote get-url origin` (atau `LOCAL_CI_GITHUB_OWNER`/`LOCAL_CI_GITHUB_REPO`) — jadi menjalankan `bun run ci` secara lokal, atau menyiapkan pengaturan polling/pelaporan-status yang sama di infrastruktur milik repositori turunan sendiri, adalah jalur bawaan. Maintainer repositori turunan boleh sebaliknya memasang sistem CI lain yang disetujui, tapi itu adalah keputusan governance eksplisit milik mereka sendiri untuk repositori mereka sendiri, bukan sesuatu yang dipilih template ini untuk mereka atau diperkenalkan ulang atas nama mereka.

**`tests/template-init.test.mjs` melewati dirinya sendiri begitu mendeteksi ia tidak lagi berjalan di dalam `awcms-one` sendiri** (`package.json.name !== "awcms-one"`, dicetak sebagai satu baris SKIPPED yang jelas). Tanpa ini, `bun test` akhir ini akan menemukan dan menjalankan ulang berkas tesnya sendiri di dalam repositori yang baru saja diinisialisasinya — tes full-run milik berkas itu kemudian mencoba membangun SALINAN sementara lain dari `git ls-files`, yang masih mendaftar path yang sudah dihapus langkah penghapusan run ini sendiri (`unlinkSync` sungguhan, tidak pernah `git rm`), melempar `ENOENT` pada setiap satu darinya. Guard ini bukan solusi sementara untuk kegagalan penyalinan itu (`makeTempCopy` juga menyaring `git ls-files` lewat `existsSync`, secara defensif, sebagai lapisan pertahanan kedua yang independen) — ia adalah perbaikan sesungguhnya: pengujian ini ada untuk menguji template, dan tidak boleh pernah berjalan kedua kalinya terhadap repositori yang sudah bukan template lagi.

`TEMPLATE_INIT_TEST_SCOPE=root` (variabel lingkungan, hanya untuk local-CI) membuat `bun test` penutup itu hanya menjalankan uji gerbang akar (`bun test ./tests/` — `./` di depan itu penting, lihat di bawah), bukan seluruh workspace: leg `local-ci/template-*` milik `bun run ci:template` (sebelumnya workflow `template-init-smoke`) dan `tests/template-init.test.mjs` sudah menjalankan suite lengkap di sekeliling alat ini, dan run penuh yang bersarang menggandakan beban build stub-CMS sampai melewati tenggat mulai stub pada uji asap storefront. Repositori turunan yang sesungguhnya tidak pernah menyetelnya.

**Mengapa `./tests/`, bukan `tests` (issue #147).** Argumen posisi `bun test` adalah FILTER path — pencocokan substring terhadap path setiap berkas tes — bukan pembatas direktori. `bun test tests` karena itu juga cocok dengan `apps/storefront/tests/*.test.ts`, sebab path itu pun mengandung substring `tests`; ia cocok dengan setiap berkas tes di repositori ini, karena masing-masing memang berada di dalam direktori yang namanya persis `tests`. `TEMPLATE_INIT_TEST_SCOPE=root` diam-diam tidak pernah membatasi apa pun sebelum perbaikan ini — docblock `runFollowUpGates` milik `tools/template-init/gates.mjs` sendiri memuat reproduksi lengkapnya, dan `tests/gerbang-test-scope.test.mjs` menjaganya sebagai tes regresi permanen. Sebuah path yang diawali `./` atau `/` tidak dianggap filter; ia di-resolve sebagai direktori sungguhan.

### Daftar periksa pasca-init

`template:init` menulis ulang daftar tertutup di atas dan tidak lebih, sehingga repositori yang baru diinisialisasi masih membawa identitas template di semua tempat di luar daftar itu. Karena itu ia menutup dengan mencetak daftar periksa ini, dari `tools/template-init/checklist.mjs`, yang menjadi satu-satunya sumber tabel di bawah. **Otomatis** berarti alat menulis ulang atau mereset-nya, dan `tests/template-init.test.mjs` memeriksa klaim itu terhadap rencana yang sebenarnya; **manual** berarti alat tidak menyentuhnya, dan tes yang sama memeriksa bahwa daftar tidak mengklaim sebaliknya. Alat tetap tidak menulis ulang berkas apa pun yang tabel ini sebut manual.

| Area | Otomatis | Manual |
| --- | --- | --- |
| URL repositori | `repository.url` di `package.json` menjadi `git+https://github.com/GANTI-ORG/<slug>.git` | Ganti `GANTI-ORG`. Tautan issue, advisory, dan ADR di `README*.md`, `SUPPORT*.md`, dan `SECURITY*.md` tetap menunjuk ke `ahliweb/awcms-one` |
| README, AGENTS, CONTRIBUTING, dan dokumen root lain | Paragraf hero `README` dan kalimat hero `SUPPORT`, beserta mirror `.id` | Judul `README` dan tabel "Repo ini"-nya masih berbunyi `awcms-one`. Tulis ulang keduanya dan `AGENTS.md`, lalu tinjau `CONTRIBUTING*`, `GOVERNANCE*`, `SECURITY*`, `CODE_OF_CONDUCT*`, dan `docs/template*.md`, yang masih menggambarkan awcms-one dan BjekMart. Pertahankan atribusi historis, lalu jalankan `bun run docs:i18n:stamp` |
| Penamaan image deploy dan Compose | `compose.yaml` (basis data lokal): nama project, nama container, named volume | `compose.production.yaml` tidak ditulis ulang: nama project, container, volume, dan image-nya serta variabel `AWCMS_ONE_*` bisa menamai sumber daya yang sudah persisten. Inventarisasi dan ubah hanya lewat migrasi terpisah yang ditinjau dan punya rollback; jangan pernah cari-dan-ganti |
| Pewarisan UI/UX versus adaptasi lokal | `DEFAULT_IDENTITY` dan `DEFAULT_THEME_COLORS`, yang mengisi token tema, manifest, dan ikon PNG hasil generate | Font, tata letak, citra, dan teks diwarisi apa adanya. Adaptasi secara lokal dan batasi cakupannya (misalnya ke satu `SITE_PROFILE`) agar profil lain tetap mewarisi template; lihat [`ui-ux.md`](ui-ux.id.md) |
| Pin runtime dan metadata rilis | `version` di `package.json` menjadi `0.1.0`; `awcmsOne.templateVersion` mencatat versi template; `CHANGELOG.md` direset ke satu entri; `.changesets/*.md` dibersihkan (sekali saja) | Pin Bun (`packageManager`, `engines.bun`) diwarisi apa adanya; naikkan dengan sengaja. Changeset milik produk menua sejak hari ditulis (`audit:rilis` mengizinkan 20 berkas dan 14 hari), jadi rencanakan rilis pertama: [`.changesets/README.md`](../.changesets/README.id.md), [`rilis.md`](rilis.id.md) |
| Tautan status dan branding | `apps/storefront/.env.example`: `SITE_URL`, `SITE_NAME`, `SITE_DESCRIPTION`, `SITE_PROFILE` | [`status.md`](status.id.md) menyatakan keadaan awcms-one sendiri, bukan keadaan produk: tulis ulang. Periksa tautan kontak, advisory, dan dukungan di `SECURITY*` dan `SUPPORT*` |
| Drift versi upstream | `awcmsOne.templateVersion` mencatat dari versi template mana repositori bermula | Repositori yang dibuat dari template tidak punya riwayat `apps/cms`. Catat ancestry sekali, jaga remote `awcms` hanya `main` dengan `--no-tags`, gabungkan setiap subtree sync dengan merge commit, dan atur repositori menjadi hanya-merge-commit sebelum sync pertama: "Panduan kompatibilitas dan upgrade" di bawah |

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
| `akun/reservasi.astro` | toko | Reservasi booking milik pembeli yang sedang masuk (issue #386); dengan `?kode=` state uang muka satu reservasi dan dialog pembatalannya (issue #387) |
| `akun/ulasan.astro` | toko | Ulasan produk commerce |
| `arsip/[yyyy]/[mm].astro` | berita | Arsip bulanan berita |
| `berita/feed.xml.ts` | berita | Feed RSS berita (pos) |
| `berita/index.astro` | berita | Halaman depan berita |
| `berita/[slug].astro` | berita | Artikel berita |
| `booking/index.astro` | toko | Pencarian menginap booking, ketersediaan, dan kuota dari server (issue #386) |
| `booking/pesan.astro` | toko | Penahanan booking, hitung mundur, dan serah-terima pembayaran (issue #386) |
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
| `apple-touch-icon.png.ts` | shared | Setiap profil punya ikon aplikasi PNG hasil generate sendiri |
| `icons/[name].png.ts` | shared | Setiap profil punya ikon aplikasi PNG hasil generate sendiri |
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

**Total:** shared 10, `toko` 26, `berita` 19 (total 55).

### Navigasi, sitemap, feed, robots, CSP, dan fixture per profil

| | `toko` (default) | `berita` | `landing` |
| --- | --- | --- | --- |
| **Navigasi** | Beranda, Produk, Flash Sale, Berita, Kontak, ditambah ikon keranjang/wishlist/akun | Beranda, Berita, Rubrik, Video, Buletin, Kontak | Beranda, halaman statis, Kontak saja |
| **Tautan legal footer** | Panduan belanja, privasi, syarat, redaksi, pedoman media, disclaimer | Redaksi, pedoman media, disclaimer, privasi, syarat | Privasi, syarat saja |
| **Sumber sitemap** | Semua: `static-routes`, `static-pages`, `katalog-produk`, `katalog-kategori`, `katalog-product-detail`, `berita-front`, `berita-posts`, `berita-video`, `berita-rubrik`, `berita-daerah`, `berita-mitra`, `berita-tag` | `static-routes`, `static-pages`, dan setiap sumber `berita-*` | `static-routes`, `static-pages` saja |
| **Feed** | Feed produk + feed pos berita + feed rubrik | Feed pos berita + feed rubrik | Tidak ada |
| **Aturan robots** | Melarang path per-pengunjung commerce (`/keranjang`, `/checkout`, `/pesanan`, `/wishlist`, `/cari`, `/masuk`, `/daftar`, `/akun`, `/booking`) ditambah `/newsletter/*`, `/api/` | Melarang `/newsletter/*`, `/api/` | Melarang `/api/` saja |
| **CSP `form-action`/`connect-src`** | `form-action 'self'`, `connect-src` diperluas ke `PUBLIC_AWCMS_ORIGIN` (checkout/keranjang, dan halaman booking, yang tidak menambah origin lain) | `form-action 'self'` saja | `form-action 'self'` saja |
| **Fixture stub-CMS yang dibutuhkan** | Setiap fixture commerce ditambah setiap fixture berita (build hibrida butuh keduanya) | `blog-posts.json`, `blog-terms.json`, `blog-institutions.json`, `blog-pages-public*.json`, `seo-redirects-legacy.json`, `regions-kalteng.json`, `ad-placements-active.json`, `analytics-pages.json` | `blog-pages-public*.json`, `store-settings-public.json`, `media-objects.json`/`media-public-origin.json`; tidak ada fixture khusus commerce atau berita |

### Metadata instalasi (manifest, ikon, Layar Utama iOS)

Sama untuk ketiga profil, dan diturunkan, bukan ditulis ulang ([ADR-0049](adr/0049-install-metadata-is-derived-at-build-time-and-the-ios-help-page-is-opt-in.id.md), issue [#428](https://github.com/ahliweb/awcms-one/issues/428)):

- **`/manifest.webmanifest`** punya `id` stabil (`/`), `scope` dan `start_url` (`/`), `display: standalone`, `name` dari identitas situs, `short_name` maksimal 12 karakter, dan petunjuk `categories` per profil (`toko` shopping, `berita` news, `landing` business).
- **Ikon PNG** (`/icons/icon-192.png`, `/icons/icon-512.png`, `/icons/icon-maskable-512.png`, `/apple-touch-icon.png`) dibuat saat build dari huruf pertama `SITE_NAME` dan warna primer tema. Keduanya sudah ada di daftar "Apa yang ditulis ulang" milik `template:init` (`DEFAULT_IDENTITY`, `DEFAULT_THEME_COLORS`), sehingga **init tidak butuh target tulis-ulang baru dan tidak ada berkas ikon BjekMart yang terlupa**. Untuk memakai karya seni sungguhan, ganti endpoint di `apps/storefront/src/pages/icons/` dan `apple-touch-icon.png.ts`.
- **Metadata iOS** (`apple-touch-icon`, `apple-mobile-web-app-*`, `mobile-web-app-capable`, `theme-color`) adalah markup statis di `BaseLayout.astro`.
- **`/pasang-aplikasi`** adalah halaman bantuan opsional "Tambahkan ke Layar Utama di iPhone", **mati secara bawaan**. Setel `PUBLIC_INSTALL_HELP=1` (juga `true`, `on`, `yes`) saat build untuk menambah rute, tautan footer, dan satu skrip same-origin yang mendeteksi mode standalone. Saat mati, semuanya tidak ada (tanpa rute, tautan, skrip, atau entri sitemap) dan CSP sama di kedua kondisi. Halaman ini tidak pernah meminta izin notifikasi dan menyatakan bahwa tab browser tidak bisa menerima notifikasi setelah ditutup.
- **`/akun/notifikasi`, `/sw-notifikasi.js` dan kartu "Notifikasi" di `/akun`** adalah Web Push pelanggan ([ADR-0048](adr/0048-customer-web-push-identity-subscription-and-cross-origin-contract.id.md), issue [#431](https://github.com/ahliweb/awcms-one/issues/431)), **mati secara bawaan** dan hanya untuk `toko`. Setel `PUBLIC_CUSTOMER_PUSH=1` (juga `true`, `on`, `yes`) saat build untuk menambah halaman pengaturan opt-in, service worker khusus push di origin storefront, dan kartu di `/akun` yang tetap tersembunyi sampai CMS melaporkan kapabilitasnya. Saat mati, atau pada build `berita`/`landing` (flag diabaikan di sana, dengan peringatan), semuanya tidak ada: tanpa rute, tanpa berkas worker, tanpa kartu, tanpa entri sitemap. Dua saklar menentukan apakah pembeli pernah melihat sesuatu: flag build ini dan fitur commerce `customerPush` milik tenant di CMS (mati, CMS menjawab `404` netral dan kartu serta halaman tetap tersembunyi). Keduanya tidak ada di `ROUTES` atau matriks profil di atas (halaman di balik flag tidak boleh masuk navigasi atau sitemap), persis seperti `/pasang-aplikasi`. Lihat [`ui-ux.md`](ui-ux.id.md#notifikasi-pelanggan-pengaturan-opt-in-aktivasi-iphone-dan-keluar-yang-aman-issue-431) dan [`deployment.md`](deployment.id.md#web-push-pelanggan-flag-build-storefront-dan-daftar-periksa-aktivasi-issue-431).
- Manifest dan ikon berada di origin **storefront**. Build bawaan **tidak mendaftarkan service worker**; CMS memegang PWA admin dan `/push-sw.js` sendiri di origin-nya. Satu-satunya service worker yang bisa ada di storefront adalah `/sw-notifikasi.js` khusus push di atas, dan `tests/storefront-tanpa-service-worker.test.mjs` mengunci bahwa itu satu-satunya dan bahwa ia tidak bisa melakukan apa pun selain menampilkan notifikasi dan menangani kliknya.

## Seed contoh

`bun run db:seed:cms:profil <toko|berita|landing|contoh:borneojek-mart>` (setara dengan `bun run db:seed:cms -- --profil <nama>`; [#139](https://github.com/ahliweb/awcms-one/issues/139), `tools/seed-cms.ts`) menyemai salah satu dari:

- **`toko`, `berita`, `landing`** — konten contoh kecil, netral, dan fiktif di bawah `tools/seed-data/profil/<profile>/*`: tanpa orang nyata, nomor telepon, e-mail, atau nama merek — kontak placeholder memakai `example.com`/`example.id` dan nomor bergaya `+62 800 0000 0000`. `toko` mengirim ≤ 20 produk di ≤ 6 kategori ditambah pemasaran/halaman/syarat; `berita` mengirim ≤ 15 pos di ≤ 5 rubrik, ≤ 3 byline penulis informasional, ≤ 4 halaman, dan baris region/instansi yang dibutuhkan arsip `/daerah/{slug}`; `landing` mengirim profil situs, ≤ 4 halaman, dan detail kontak saja. Gambar placeholder adalah SVG yang dibuat sendiri di bawah `tools/seed-assets/profil/<profile>/`. Setiap seed idempoten (upsert berdasarkan slug, aman dijalankan ulang) dan memvalidasi terhadap bentuk yang sudah didokumentasikan `apps/cms/openapi/awcms-public-api.openapi.yaml` untuk endpoint yang dipanggil seeder.
- **`contoh:borneojek-mart`** — konten referensi BjekMart yang lengkap, dipindah dari lokasi aslinya ke `tools/seed-data/contoh/borneojek-mart/**`. `bun run db:seed:cms` tanpa flag `--profil` tetap menargetkan ini secara default, sehingga alur kerja deployment referensi yang hidup tidak berubah; `tools/seed-borneojek-mart.ts` (berkas yang dulu MENJADI seeder-nya) kini adalah shim deprecation satu-rilis yang mencetak peringatan lalu mendelegasikan ke `tools/seed-cms.ts --profil contoh:borneojek-mart`.

`--dry-run` memvalidasi JSON seed profil pilihan dan mencetak ringkasan inventaris tanpa membuat panggilan jaringan sama sekali — aman dijalankan terhadap basis data yang sudah berisi konten sungguhan (lihat "Seeding a profile locally" di `docs/alur-kerja-pengembangan.md` untuk runbook lengkap dan alasan basis data dev lokal bersama tidak pernah diisi dengan profil netral).

## BjekMart sebagai contoh referensi

BjekMart tidak dihapus begitu repo ini menjadi template — ia **dipertahankan, secara eksplisit diberi label sebagai contoh referensi**: deployment nyata, terus-dirawat, dan lengkap dari profil `toko`, sedalam lima increment, yang bisa dilihat siapa pun yang memulai dari template ini untuk melihat seperti apa rupa build yang selesai. `bun run dev` tanpa `template:init` dijalankan sama sekali tetap memberi Anda situs BjekMart sendiri, persis seperti sejak increment 1; `template:init` adalah yang mengubah pohon yang sama ini menjadi sesuatu yang lain, begitu Anda memilih untuk menjalankannya.

## Studi kasus: OMES-Web, produk turunan

[`ahliweb/omes-web`](https://github.com/ahliweb/omes-web) adalah produk pertama selain reference deployment yang dibangun dari template ini. Semua di bawah dibaca dari repositori itu, rilis, dan issue-nya pada 25 Oktober 2026; yang belum selesai ditandai terbuka. Ini studi kasus, bukan dependensi: tidak ada kode, seed, default, atau profil di repositori ini yang menyebut OMES-Web, dan memang tidak boleh ([ADR-0024](adr/0024-awcms-one-is-template-only-derived-apps-own-their-backend.id.md)). Koreksi spesifik produk tetap berada di issue OMES-Web sendiri.

### Siapa memiliki apa

| Permukaan | Pemilik |
| --- | --- |
| Deployment `apps/cms` OMES-Web, basis data PostgreSQL-nya, dan situs publik `landing`-nya | `ahliweb/omes-web`, dibuat dari template ini (`awcmsOne.templateVersion` `0.12.0`) |
| Kapabilitas backend generik, termasuk layar OMES Control Center dan API worker `enroll`/`poll`/`result`/`heartbeat` yang dibawa `apps/cms`-nya | `ahliweb/awcms`, tiba lewat subtree sync |
| Host OMES native: installer, job host, versi rilis, worker | `ahliweb/omes`, repositori terpisah dengan versinya sendiri (`0.6.0` saat issue OMES-Web ditulis, berbanding `0.1.0` milik OMES-Web) |
| Titik awal generik | `ahliweb/awcms-one`: bootstrap, bukan dependensi runtime |

[ADR-0021](https://github.com/ahliweb/omes-web/blob/main/docs/adr/0021-separate-omes-product-site-from-native-host-runtime.md) milik OMES-Web sendiri (status **Proposed** pada tanggal dibaca) memilih "Opsi A": dua repositori yang dihubungkan kontrak berversi, dibanding memindahkan situs ke OMES native (B) atau menggabungkan keduanya (C). Arsitekturnya dilacak di [OMES #350](https://github.com/ahliweb/omes/issues/350) dan manifest native di [OMES #352](https://github.com/ahliweb/omes/issues/352) (terbuka). Manifest kompatibilitas sisi produk adalah [OMES-Web #20](https://github.com/ahliweb/omes-web/issues/20), juga terbuka: **manifest seperti itu belum ada**, dan tidak ada yang di sini bergantung padanya.

### Yang dihadapi produk

| Bukti (OMES-Web) | Yang ditunjukkan |
| --- | --- |
| [#19](https://github.com/ahliweb/omes-web/issues/19) (terbuka): `AGENTS.md` root masih berbunyi "awcms-one re-platforms the borneojek-mart commerce store", `README.md` berjudul `# awcms-one`, `docs/template.md` adalah teks template yang belum diadaptasi, `compose.production.yaml` memakai `awcms-one-production`, dan `repository.url` berbunyi `git+https://github.com/GANTI-ORG/omes.git` | `template:init` membiarkan semua ini dengan sengaja; daftar periksa di atas kini menyebut masing-masing. #19 melarang mengganti nama project Compose produksi, volume, tag image, kunci env, role basis data, atau rentang migrasi sebagai bagian pembersihan dokumentasi |
| Catatan rilis `v0.2.0`: `DEFAULT_IDENTITY` masih membawa nomor telepon dan alamat jalan BjekMart milik template setelah `template:init` dijalankan tanpa `--kontak-telepon`/`--alamat` | Diperbaiki di template ini sebagai issue #233; tes di atas menjaganya tetap benar |
| [#16](https://github.com/ahliweb/omes-web/issues/16) (terbuka): halaman landing meng-hardcode `Pre-alpha · v0.4.0` dan URL bootstrap `v0.4.0`, padahal `VERSION` repositori native adalah `0.6.0` dan rilis stabil `v0.6.0` terbit pada 2026-09-28 | Halaman produk tidak boleh meng-hardcode versi produk lain; perbaikan yang diusulkan membaca rilis terbit yang terverifikasi dan di-pin, tidak pernah `main` atau `latest` yang mengambang |
| [#22](https://github.com/ahliweb/omes-web/issues/22) (tertutup): 8 changeset menunggu, yang tertua berumur 28 hari terhadap batas 14 hari, menggagalkan keempat leg `template-init-smoke` | Siklus rilis adalah gerbang juga di repositori turunan; #22 mewajibkan perbaikan lewat siklus rilis, bukan dengan melonggarkan `audit:rilis`, dan `v0.2.0` (2026-10-24) melipat changeset yang menunggu ke `CHANGELOG.md` |
| Commit "docs(changelog): relabel inherited awcms-one history": entri warisan `0.1.0`–`0.12.0` kini berada di bawah satu heading, "Inherited awcms-one template history (pre-fork, not OMES-Web releases)" | Tanpa itu, perkakas rilis membacanya sebagai rilis milik produk. Lihat "Changeset dan CHANGELOG setelah fork" di bawah |
| [#23](https://github.com/ahliweb/omes-web/issues/23) (terbuka): pada 2026-10-24 `main` tidak terlindungi dan merge, squash, serta rebase semuanya aktif | Squash atau rebase pada PR subtree-sync menghancurkan merge base yang dibutuhkan sync berikutnya. Dibaca sesudahnya: `main` terlindungi dan hanya merge commit yang diizinkan (di bawah) |
| [#17](https://github.com/ahliweb/omes-web/issues/17) (terbuka): sync terakhir adalah upstream `8e9bce0c` ([PR #14](https://github.com/ahliweb/omes-web/pull/14), 2026-09-28) dan 155 commit upstream menunggu | Sync diaudit dan dibertahap, tidak diasumsikan aman; rencananya branch khusus dengan merge commit |

### Aturan anti-duplikasi

Yang tidak boleh disalin, di-fork, atau diulang oleh produk turunan, beserta tujuan yang benar:

- **Backend referensi.** Jangan pernah mengarahkan produksi ke `apps/cms` hidup repositori ini ([ADR-0024](adr/0024-awcms-one-is-template-only-derived-apps-own-their-backend.id.md) D1). Produk memiliki basis data, migrasi, secret, dan domain sendiri.
- **Kapabilitas generik ke pohon produk.** Kapabilitas yang akan dipakai ulang produk lain diusulkan ke `ahliweb/awcms` (atau ke sini, dengan penamaan netral dan ADR) dan diadopsi balik lewat rilis atau subtree sync, tidak pernah di-fork secara lokal. Semantik spesifik produk tetap di produk.
- **Produk ke dalam template.** Tidak ada nama produk, teks, seed, default, atau profil milik produk turunan yang masuk ke repositori ini. Seed netralnya (`toko`, `berita`, `landing`) tetap netral.
- **Runtime produk lain.** ADR-0021 OMES-Web menolak runtime agen kedua dan modul bayangan `omes_control` di produk: host tetap di `ahliweb/omes`, dan data serta layar Control Center tetap di `apps/cms` yang dikirim sync.
- **Fakta rilis produk lain.** Versi, URL installer, atau klaim kompatibilitas di halaman produk berasal dari rilis terbit produk itu, bukan dari literal di halaman (OMES-Web #16).
- **Prosa identitas template.** `AGENTS.md`, `README`, `docs/template.md`, dan kolom manual daftar periksa menggambarkan awcms-one sampai produk menulis ulangnya. Repositori turunan yang mempertahankannya menyatakan pemilik, repositori, dan tujuan yang salah kepada setiap pembaca dan agen.
- **Nama yang persisten.** Nama project dan volume Compose, nama image, kunci env, role basis data, dan migrasi yang sudah diterapkan tidak pernah diganti dengan cari-dan-ganti; semuanya diinventarisasi dan dimigrasikan terpisah (OMES-Web #19, ADR-0021).
- **Internal upstream di luar sync.** Produk mengubah `apps/cms` hanya lewat PR subtree-sync khusus atau di dalam modulnya sendiri, mendaftar setiap divergensi di `AGENTS.md`-nya (OMES-Web #20 menyatakan aturan yang sama sebagai kriteria penerimaan).

### Panduan kompatibilitas dan upgrade

**Subtree sync.**

- Repositori yang dibuat dari template memiliki berkas `apps/cms` tetapi tidak riwayatnya, sehingga `git subtree pull` pertama tidak punya merge base. OMES-Web mencatat ancestry sekali dengan merge tanpa perubahan dari commit `awcms` yang cocok dengan `apps/cms`-nya (`git merge -s ours --allow-unrelated-histories <commit itu>`, setelah memastikan `git rev-parse HEAD:apps/cms` sama dengan tree `apps/cms` milik template, yang sync terakhirnya tercantum di `AGENTS.md` template); setiap sync sesudahnya adalah merge tiga-arah biasa. `AGENTS.md`-nya mendokumentasikan langkah itu.
- Tambahkan remote hanya `main` dan tanpa tag, persis seperti bagian "The subtree embed" di `AGENTS.md`. Fetch biasa mengimpor tag rilis upstream, dan `tools/rilis.mjs` lalu menurunkan versi berikutnya dari basis yang salah; template ini mengalaminya pada clone yang memotong `v0.2.0`-nya sendiri, dan `AGENTS.md` OMES-Web memuat aturan yang sama.
- Gabungkan PR sync dengan **merge commit**, tidak pernah squash atau rebase, dan jangan pernah menggabungkannya dengan perubahan lain yang tidak terkait. Jangan pernah menomori ulang atau menyentuh ulang migrasi yang dikirim sync atau yang sudah diterapkan.
- Audit deltanya sebelum menarik, seperti rencana OMES-Web #17 untuk 155 commit-nya: baca changelog dan migrasi upstream, daftar divergensi milik produk, regenerasi (jangan edit tangan) `bun.lock` dan inventaris kode, lalu jalankan gate root dan `apps/cms`. Bila anggaran aset klien bergerak di kedua sisi, bawa kedua garis keturunan, seperti dicatat catatan rilis `v0.2.0` OMES-Web.

**Pengaturan repositori.** Alur template GitHub menyalin berkas, bukan pengaturan. #23 OMES-Web mencatat repositori baru dengan ketiga metode merge aktif dan `main` tidak terlindungi. Teramati pada 2026-10-25, setelah perbaikan: hanya merge commit yang diizinkan, squash dan rebase dinonaktifkan, penghapusan branch setelah merge aktif, dan `main` terlindungi dengan dua belas status check wajib (harus mutakhir sebelum merge), satu review persetujuan, tanpa bypass untuk administrator, tanpa force push atau penghapusan, dan resolusi percakapan wajib; riwayat linear sengaja nonaktif, karena melarang merge commit yang dibutuhkan subtree sync. Issue #23 sendiri masih terbuka saat ini dibaca. Pengaturan repositori ini dijelaskan di `AGENTS.md`; baca dari GitHub sebelum menyalinnya, karena nama check wajib bergantung pada CI yang benar-benar dijalankan produk.

**Changeset dan CHANGELOG setelah fork.**

- `template:init` membersihkan changeset template dan mereset `CHANGELOG.md` ke satu entri (sekali saja). Changeset milik produk lalu mengikuti [`.changesets/README.md`](../.changesets/README.id.md): paling banyak 20 menunggu dan tidak ada yang lebih tua dari 14 hari, yang menghentikan keempat leg `template-init-smoke` OMES-Web sampai ia merilis.
- Repositori yang diinisialisasi sebelum perbaikan #476 menyimpan seluruh riwayat template di `CHANGELOG.md`. Bila demikian, lakukan seperti OMES-Web: pindahkan entri itu ke bawah satu heading level-1 yang menyatakan bahwa itu pra-fork, turunkan heading versinya, dan minta skrip rilis menulis rilis pertama produk di atas blok itu. OMES-Web mengubah `tools/rilis.mjs` dan `packages/gerbang/lib/changelog.mjs` miliknya sendiri agar ini bekerja (sebuah seksi berhenti di heading itu; rilis pertama disisipkan sebelumnya). Perkakas rilis template ini tidak punya dukungan semacam itu, sehingga produk yang melakukan relabel harus membuat perubahan yang sama dan mengujinya.
- Versi produk adalah miliknya sendiri. Versi `package.json` OMES-Web (`0.1.0`, lalu `0.2.0`) independen dari versi OMES native, dan kompatibilitas di antara keduanya milik manifest yang diuji produk, bukan nomor versi.

**Mengambil perbaikan template.** Adopsi rilis template yang lebih baru dengan sengaja ([ADR-0024](adr/0024-awcms-one-is-template-only-derived-apps-own-their-backend.id.md) D5): diff rilisnya, terapkan dengan rencana migrasi dan regresi milik produk sendiri, dan jaga `awcmsOne.templateVersion` tetap jujur. Ini hubungan evolusi source; template yang offline tidak boleh pernah memengaruhi ketersediaan produk.

## Status

Increment 6 (epic [#135](https://github.com/ahliweb/awcms-one/issues/135)) sudah selesai; setiap mekanisme di dokumen ini adalah kode nyata, teruji, dan berjalan, bukan rencana.

| Tanggal | Issue | Yang landing |
| --- | --- | --- |
| 20 September 2026 | [#136](https://github.com/ahliweb/awcms-one/issues/136) | [ADR-0018](adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.id.md) (D1–D8), kerangka dokumen ini, dan matriks profil (semua 52 berkas di bawah `apps/storefront/src/pages/**` ditetapkan) |
| 20 September 2026 | [#137](https://github.com/ahliweb/awcms-one/issues/137) | `SITE_PROFILE` sendiri — `apps/storefront/src/config/profil.ts`, integrasi `injectRoute` (`integrations/profil.mjs`), halaman dipindah ke `src/profil/<group>/pages/**`, default `# SITE_PROFILE=toko` yang dikomentari milik `apps/storefront/.env.example`, dan matriks build 3-leg `Check (toko|berita|landing)` milik `ci.yml`. `SITE_PROFILE` sungguh-sungguh memutuskan halaman mana yang disertakan sebuah build, persis seperti yang digambarkan matriks profil di atas |
| 20 September 2026 | [#139](https://github.com/ahliweb/awcms-one/issues/139) | `tools/seed-cms.ts`, dengan `--profil toko|berita|landing|contoh:borneojek-mart` dan `--dry-run`, ditambah set seed netral di bawah `tools/seed-data/profil/{toko,berita,landing}/*` dan SVG placeholder di bawah `tools/seed-assets/profil/**`; seed BjekMart dipindah ke `tools/seed-data/contoh/borneojek-mart/**`, tidak berubah bentuknya; `tools/seed-borneojek-mart.ts` menjadi shim deprecation satu-rilis |
| 20 September 2026 | [#138](https://github.com/ahliweb/awcms-one/issues/138) | `bun run template:init` (`tools/template-init.ts` + `tools/template-init/**`), diuji oleh `tests/template-init.test.mjs`, dimatriks di CI oleh `.github/workflows/template-init-smoke.yml` (sejak issue #225, leg `local-ci/template-*` milik `bun run ci:template`). Langkah penghapusannya dan penulisan-ulang `apps/storefront/.env.example`-nya menyasar langsung tata letak yang sudah landing dari #137 dan #139: `template:init --profil <p>` menghapus komentar dan mengatur baris `SITE_PROFILE` nyata yang ditambahkan #137, sehingga build repo turunan sungguh-sungguh menyaring halaman menurut profil pilihan sejak build pertamanya |
| 20 September 2026 | [#140](https://github.com/ahliweb/awcms-one/issues/140) | Sapuan dokumentasi ke keadaan sebenarnya (halaman ini, `README.md`, `AGENTS.md`, dokumen CI/routing/SEO/pengujian/deployment/alur-kerja, `apps/storefront/README.md`, panduan `.claude/skills/` termasuk skill baru `awcms-one-template`), flag GitHub *template repository*, pembersihan `EXCLUDED_PATHS` `packages/gerbang/audit-dokumen.mjs`, pembangunan ulang knowledge graph, dan rilis v0.8.0 yang menutup epic #135 |
| 25 Oktober 2026 | [#476](https://github.com/ahliweb/awcms-one/issues/476) | Studi kasus OMES-Web, aturan anti-duplikasi, dan panduan kompatibilitas (di atas); daftar periksa pasca-init, dicetak `template:init` dari `tools/template-init/checklist.mjs` dan dikunci oleh `tests/template-init.test.mjs`; reset `CHANGELOG.md` tidak lagi tertimpa pembersihan kutipan; tambahan kunci env dan `CHANGELOG.md` pada pemindaian tanpa-BjekMart |

Kedua belas context `local-ci/*` — leg check tiga-profil, `local-ci/check-cms`, keempat leg `local-ci/template-*`, ketiga leg `local-ci/e2e-*`, dan `local-ci/security` — adalah status check wajib di `main` (lihat [`docs/alur-kerja-pengembangan.md`](alur-kerja-pengembangan.id.md) untuk pengaturannya sebagaimana diverifikasi, dan riwayat promosinya di era GitHub Actions).
