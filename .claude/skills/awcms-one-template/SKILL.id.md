🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](SKILL.md)

> Mirror terjemahan dari `SKILL.md`. Berkas yang dimuat oleh mekanisme skill (dicocokkan persis pada nama `SKILL.md`) adalah versi Inggris; berkas ini adalah salinan baca untuk pembaca Bahasa Indonesia, bukan berkas yang dimuat langsung.

# awcms-one — Memulai aplikasi baru dari template ini

Ikuti [ADR-0018](../../../docs/adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.id.md) dan [`docs/template.md`](../../../docs/template.id.md) untuk penalaran dan referensi lengkapnya; skill ini adalah panduan praktis untuk benar-benar menjalankannya.

## Apa repositori ini, dua kali lipat

`awcms-one` tetap berjalan sebagai produk BjekMart **sekaligus** menjadi *template repository* GitHub yang menjadi titik awal aplikasi lain. Membuat aplikasi baru berarti memakai tombol "Use this template" milik GitHub sendiri (repo baru tanpa riwayat — bukan fork, bukan salinan manual), lalu menjalankan `bun run template:init` sekali di dalam klonnya untuk menjadikannya milik sendiri.

## Langkah 1 — pilih profil build sebelum apa pun lainnya

Setiap aplikasi turunan adalah salah satu dari tiga bentuk, ditentukan `SITE_PROFILE` saat build ([ADR-0018 D2](../../../docs/adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.id.md)):

| Profil | Komposisi | Pilih ini saat aplikasinya… |
| --- | --- | --- |
| `toko` (default) | shared + commerce + berita | Toko online, opsional dengan bagian berita/blog — bentuk BjekMart hari ini |
| `berita` | shared + berita | Portal berita/blog saja, tanpa commerce |
| `landing` | shared saja | Profil perusahaan atau situs landing — halaman, kontak, chrome SEO; tanpa commerce, tanpa berita |

Pilihan ini tidak mudah dibalik setelah konten ada: ia menentukan group halaman mana yang disertakan build, set seed mana yang cocok, dan fixture mana yang dibutuhkan pemeriksaan smoke CI. Lihat [`docs/template.md`](../../../docs/template.id.md#matriks-profil) untuk persis rute mana yang dikirim tiap profil.

## Langkah 2 — jalankan `template:init`

```bash
bun install
bun run template:init \
  --nama "Toko Contoh" \
  --slug toko-contoh \
  --domain toko-contoh.id \
  --profil toko|berita|landing \
  --warna-primer "#0ea5e9" \
  --kontak-email owner@toko-contoh.id \
  [--warna-sekunder "#0369a1"] [--warna-aksen "#f59e0b"] \
  [--kontak-telepon "+62 812-0000-0000"] [--alamat "Jl. Contoh No. 1"] \
  [--dry-run] [--yes]
```

- Flag wajib yang hilang meminta lewat prompt saat TTY; dalam skrip/CI ia keluar dengan kode **`2`**, menamai setiap flag yang hilang.
- Jalankan `--dry-run` dulu untuk melihat rencana penulisan-ulang/penghapusan persis tanpa menyentuh apa pun — selalu aman, tanpa jaringan, tanpa efek samping.
- Alat ini menolak berjalan pada working tree yang kotor tanpa `--yes` (kode keluar `3`) — commit atau stash dulu, lalu jalankan ulang.
- Menjalankannya dua kali dengan flag identik adalah no-op (kode keluar `0`, "nothing to do"); flag berbeda menulis ulang lagi, hanya menyentuh yang berubah.
- Referensi flag lengkap, kode keluar, dan jaminan idempotensi: [`docs/template.md`](../../../docs/template.id.md#templateinit--referensi-cli).

**Yang ditulis ulang** (dan tidak ada di luar daftar ini): `apps/storefront/src/config/site.ts` (`DEFAULT_IDENTITY`, `DEFAULT_THEME_COLORS`, fallback `SITE_NAME`/`SITE_DESCRIPTION`), `package.json` root (name/description/homepage/repository — `repository.url` menjadi placeholder mencolok `GANTI-ORG` karena alat ini tidak punya flag `--org`/`--repo`), `compose.yaml`, hero `README*.md`/`SUPPORT*.md`, kedua berkas `.env.example` (termasuk menghapus komentar dan mengatur `SITE_PROFILE`), default profil `tools/seed-cms.ts` dan baris skrip `db:seed:cms`, `CHANGELOG.md` (direset ke `0.1.0`), dan `.changesets/*.md` (dikosongkan).

**Yang dihapus**: seed referensi khusus BjekMart (`tools/seed-borneojek-mart.ts`, `tools/seed-data/contoh/borneojek-mart/**`), importer seputarborneo beserta tesnya, dan `graphify-out/`/`knowledge/generated/` (direktori yang absen adalah keadaan valid — `bun run knowledge:graph:update` yang baru membuatnya ulang).

**Yang tidak pernah disentuhnya, di bawah flag mana pun**: `apps/cms/**`. Pohon itu adalah `ahliweb/awcms` yang disematkan lewat `git subtree` — kode upstream sendiri, tidak pernah ditulis ulang secara lokal (lihat [`AGENTS.md`](../../../AGENTS.md#the-subtree-embed) root). Nama tenant, detail kontak, dan tema aplikasi turunan hidup di apa yang disajikan `apps/cms` saat runtime atau di fallback `site.ts` saat-build milik `apps/storefront` sendiri, tidak pernah di source `apps/cms`.

**Yang TIDAK dijaminnya**: sapuan seluruh-pohon untuk setiap string berbentuk-BjekMart. Tes `template:init` sendiri hanya memindai permukaan merek bernama di atas — `docs/*`, fixture tes, dan riwayat `AGENTS.md`/`CHANGELOG.md` repositori ini sendiri secara sah tetap mendeskripsikan BjekMart sebagai deployment referensi repositori *ini* sendiri. Repo turunan masih membaca "BjekMart" di docs dan fixture yang diwariskan sampai ia mengubahnya sendiri.

## Langkah 3 — seed dan jalankan

```bash
cp .env.example .env
cp apps/cms/.env.example apps/cms/.env   # isi kredensial DB + kunci provider mana pun — lihat ADR-0017
bun run db:up                             # PostgreSQL lokal lewat docker compose
bun run db:migrate:cms
bun run db:seed:cms:profil <toko|berita|landing>   # cocokkan dengan profil di langkah 1
bun run dev
```

`bun run db:seed:cms:profil <name>` menyemai konten kecil, netral, dan fiktif dari `tools/seed-data/profil/<name>/**` — tidak ada orang sungguhan, nomor telepon, e-mail, atau nama merek (placeholder memakai `example.com`/`example.id` dan nomor bergaya `+62 800 0000 0000`). Jangan pernah mengarahkan seed profil netral ke basis data yang sudah punya konten sungguhan — `POST /api/v1/setup/initialize` adalah kunci singleton sekali-per-database.

## Setelah `template:init` berjalan, periksa

`template:init` sudah menjalankan `docs:i18n:stamp`, `bun install`, `audit:dokumen`, `audit:translation`, `audit:rilis`, dan `bun test` root untuk Anda — commit pertama repo turunan sudah hijau. Di luar itu, verifikasi dengan tangan:

1. **`repository.url` di `package.json`** masih berbunyi `GANTI-ORG` — ganti, beserta tautan GitHub mana pun di `README*.md`/`SUPPORT*.md`/`SECURITY*.md` yang masih menunjuk ke `ahliweb/awcms-one`, begitu repo baru punya pemilik.
2. **`SITE_PROFILE`** di `apps/storefront/.env.example` cocok dengan profil yang dipilih — `bun run build` tanpa override seharusnya mengirim persis halaman profil itu.
3. **Tidak ada artefak khusus-BjekMart yang tertinggal** — `tools/seed-borneojek-mart.ts` dan `tools/seed-data/contoh/**` seharusnya sudah hilang; kasus tes contoh-referensi `tests/seed-profil.test.mjs` melewati dirinya sendiri begitu itu terjadi.
4. **`cd apps/storefront && SITE_PROFILE=<pilihan> bun run check`** lulus, dan `bun run build` yang sungguhan hanya menghasilkan rute milik profil yang dipilih.

## Kesalahan umum

- **Mengubah `apps/cms/**` untuk "memperbaiki" string merek** — ia tidak pernah membawa data merek; cari padanannya di `apps/storefront/src/config/site.ts` atau data seed sebagai gantinya.
- **Menjalankan `template:init` pada tree kotor dengan `--yes` karena kebiasaan** — flag itu ada untuk CI, bukan untuk melewati peninjauan apa yang akan ditulis ulang; baca dulu output `--dry-run` pada aplikasi turunan yang sungguhan.
- **Memilih profil setelah konten sudah ada** — pilih di langkah 1, sebelum menyemai atau menulis halaman, karena ia menentukan group halaman dan fixture mana yang relevan.
