🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](status.md)

<!-- i18n-source-hash: sha256:e5f3b946e5a857e7e527fcc0fb58bf2d29fd6e7c4b40eacf1156ec196049d2da -->

# Status

Referensi keadaan-terkini tunggal untuk `awcms-one` — apa yang ada, per permukaan, dan apa yang belum, masing-masing item menaut ke dokumen atau ADR yang punya detailnya. Bukan kronik increment: riwayat hidup di [`CHANGELOG.md`](../CHANGELOG.md) dan [indeks ADR](adr/README.id.md); halaman ini hanya menyatakan apa yang benar tentang tree hari ini. Di mana halaman ini dan dokumen lain berbeda, detail dokumen lain itu yang menang dan halaman ini sudah usang — ajukan issue.

## Platform ini

`awcms-one` mem-replatform toko commerce borneojek-mart — PHP/Laravel/MySQL/React-Inertia — ke Bun, Astro, dan PostgreSQL di bawah row-level security: sebuah re-platform, bukan refactor, dengan skema sumber dibaca dari basis data MySQL `commerce_bj_mart` yang hidup dan dinyatakan ulang sebagai tabel modul AWCMS (framing: [issue #1](https://github.com/ahliweb/awcms-one/issues/1)). Ia juga sebuah repositori template GitHub tempat aplikasi lain bermula — lihat "Mekanisme template dan profil build" di bawah.

## Workspace

Sebuah workspace Bun: `apps/cms` (backend/system of record, `ahliweb/awcms` disematkan utuh lewat `git subtree` — lihat [`AGENTS.md`](../AGENTS.md#the-subtree-embed)), `apps/storefront` (situs publik, output statis), `packages/kontrak` (kontrak DTO type-only di antara keduanya), `packages/gerbang`/`packages/config` (tooling akar), `tools/` (seeding, rilis, template-init), `knowledge/` (graf Graphify terfederasi). [`README.md`](../README.md) punya peta direktori lengkap.

## `apps/cms` — modul `commerce` (ADR-0008)

Satu modul, bukan tiga, membawa seluruh toko: katalog (gambar, varian, harga bertingkat, tabel ukuran, formulir layanan), marketing (flash sale, voucher, slider, testimonial, popup, pengaturan toko berversi, banner promo), dan pesanan (checkout tamu lewat kode pesanan + telepon — [ADR-0009](adr/0009-guest-checkout-by-order-code-and-phone.md) — konfirmasi pembayaran, ulasan). Keluarga `/api/v1/commerce/storefront/*` yang anonim dan terikat Origin, yang dipanggil langsung oleh browser statis, adalah [ADR-0007](adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md). Detail per-field: [`docs/cms.md`](cms.id.md), [`docs/api.md`](api.id.md), [`docs/skema-basis-data.md`](skema-basis-data.id.md), [`docs/kamus-data.md`](kamus-data.id.md).

## Akun pelanggan dan afiliasi (ADR-0016)

Tingkat kepercayaan ketiga, terverifikasi-OTP, di atas pelanggan checkout-tamu: login/registrasi OTP e-mail (dan WhatsApp, lihat integrasi di bawah), sesi bearer opaque berawalan `cs_` (di-hash `sha256:` saat disimpan, `Authorization: Bearer`, disimpan di `localStorage` milik browser sendiri — tidak pernah cookie, lihat aturan bearer-session milik [`AGENTS.md`](../AGENTS.md)), dashboard akun (alamat, riwayat pesanan, ulasan, wishlist yang tersinkron, kotak pesan pelanggan), dan program afiliasi (penangkapan `?ref=`, atribusi checkout, `/akun/afiliasi`, layar moderasi owner). **Belum ada:** ubah e-mail/telepon pada akun yang sudah ada, dan verifikasi telepon — dua item yang ditunda [ADR-0016](adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) D6.

## Integrasi eksternal (ADR-0017)

Masing-masing adalah port penyedia + adapter + outbox milik `commerce`, mengikuti pola `email` — tidak pernah panggilan sinkron di jalur pesanan ([ADR-0010](adr/0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.md), [ADR-0017](adr/0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md) D1): caching tarif kurir RajaOngkir, outbox WhatsApp (adapter Fonnte + Meta Cloud API) termasuk OTP WhatsApp, gateway pembayaran Midtrans Snap dengan intake webhook publik beralamat-token dan job `commerce:payments:reconcile`, POS (`orders.channel`, penjualan tunai), proyeksi laporan penjualan, kotak pesan pelanggan, dan kampanye marketing yang di-gate pada `marketing_consent_at`. Harga bertingkat (`price_level_1..4`) berlaku saat kuotasi. **Belum ada:** adapter gateway pembayaran Xendit dan pelacakan kurir, keduanya disebut sebagai tindak lanjut eksplisit di belakang port yang sudah dibangun.

## `apps/storefront` — profil build (ADR-0018)

`SITE_PROFILE` ∈ `{toko, berita, landing}`, dibaca saat build oleh `apps/storefront/src/config/profil.ts`:

- **`toko`** (default) — hibrida penuh: commerce (katalog, keranjang, checkout, pelacakan pesanan, wishlist, halaman akun/afiliasi) plus IA berita di bawah.
- **`berita`** — portal berita saja, mencerminkan IA dan chrome milik seputarborneo.com/beritasampit.co.id sendiri: navigasi 8-item, panel "Daerah", ticker "Terkini", direktori institusi Mitra, leaderboard footer, opt-in ganda newsletter, baris share, pemutar baca-keras, popup iklan, pengalihan legacy berbasis aturan ([ADR-0013](adr/0013-rule-based-legacy-redirects-beside-the-row-based-map.md)), dan analitik pengunjung first-party dengan saklar opt-in GA4 ([ADR-0012](adr/0012-first-party-visitor-analytics-with-an-opt-in-ga4-switch.md)).
- **`landing`** — situs profil perusahaan/landing: halaman, kontak, chrome SEO; tanpa commerce, tanpa berita.

Media (fotografi produk, hero artikel, kreatif iklan) diresolusi lewat `GET /api/v1/media/objects`, dan CSP diturunkan saat build dari apa yang sungguh terresolusi ([ADR-0011](adr/0011-storefront-media-resolves-through-the-media-objects-endpoint.md)). Lihat [`docs/template.md`](template.id.md) untuk mekanisme dan matriks profil lengkap, [`docs/routing.md`](routing.id.md) untuk setiap rute, dan [`docs/ui-ux.md`](ui-ux.id.md) untuk sistem desain (token, gambar produk, kontras lencana terhitung, presentasi harga/stok) — termasuk redesign 2026-09 yang mencakup chrome admin dan publik (issue #166–#171).

## Mekanisme template

`bun run template:init` (`tools/template-init.ts`) adalah CLI idempoten yang dijalankan repositori turunan sekali untuk menulis ulang permukaan brand-nya — nama, domain, warna, kontak, profil pilihan — tidak pernah menyentuh `apps/cms/**`. `.github/workflows/template-init-smoke.yml` mematriks-kannya atas tiga profil di setiap push; keempat leg-nya (`toko`, `berita`, `landing`, `root-suite`) adalah status check wajib. Seed per profil hidup di `tools/seed-data/profil/{toko,berita,landing}/**`; konten referensi BjekMart sendiri (dipertahankan sebagai contoh kerja template) adalah `tools/seed-data/contoh/borneojek-mart/**`. Walkthrough lengkap: [`docs/template.md`](template.id.md) dan [ADR-0018](adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md).

## Ops dan deployment

`compose.production.yaml` memberikan topologi produksi: dua image `apps/cms` (`runtime` untuk servis `cms`, `jobs` untuk servis `jobs`/`migrate`) dibangun dari `apps/cms/Dockerfile.production` upstream yang tak diubah, sebuah jobs sidecar, model basis data dua-peran, dan `commerce:deploy:preflight`/`deploy:preflight` yang fail-closed ([ADR-0019](adr/0019-production-topology-two-images-a-jobs-sidecar-and-a-fail-closed-preflight.md)). Kedua image `apps/cms` itu dipublikasikan ke GHCR — atestasi SBOM dan provenance di setiap push, dapat diverifikasi dengan `gh attestation verify` — pada tag versi atau dispatch eksplisit, oleh `.github/workflows/images.yml`; image `apps/storefront` sendiri sengaja tidak pernah dipublikasikan dengan cara ini, karena build-nya memanggang konten katalog/berita hidup milik sebuah tenant memakai token owner CMS sebagai BuildKit secret ([ADR-0020](adr/0020-publish-only-the-cms-images-to-ghcr-with-sbom-and-provenance.md) D2) — ia tetap `docker build` manual di host deploy, per `SITE_PROFILE`, per perubahan konten. Job `storefront-smoke` milik workflow itu sendiri tetap membuktikan `apps/storefront/Dockerfile` berhasil build terhadap stub CMS repo ini sendiri di setiap push/PR yang relevan. **Belum ada:** konfigurasi reverse-proxy/terminasi-TLS di luar contoh milik [`docs/deployment.md`](deployment.id.md) sendiri, enkripsi backup saat-istirahat, dan PostgreSQL produksi yang dioperasikan repositori ini sendiri (servis `postgres` milik `compose.production.yaml` sendiri adalah kenyamanan self-hosted, bukan tawaran terkelola). Runbook lengkap: [`docs/deployment.md`](deployment.id.md).

## Rilis

`bun run release` melipat backlog `.changesets/` yang menunggu ke `CHANGELOG.md`, menaikkan `package.json`, dan (dengan `--commit`) men-tag `vX.Y.Z`. Mendorong tag itu mempublikasikan GitHub Release yang cocok dari bagian `CHANGELOG.md` milik tag tersebut (`.github/workflows/release.yml`), secara idempoten — sebuah jalankan `workflow_dispatch` bisa back-fill atau mempublikasikan ulang catatan tag lama. Lihat bagian "Rilis" milik [`docs/alur-kerja-pengembangan.md`](alur-kerja-pengembangan.id.md).

## Gate dan pengerasan repositori

["The gates"](../AGENTS.id.md#the-gates) milik `AGENTS.md` adalah daftar otoritatif apa yang berjalan di setiap push dan mana yang menjadi status check wajib. Di luar itu: `.github/workflows/codeql.yml` menjalankan analisis CodeQL `security-extended` milik GitHub atas JavaScript/TypeScript workspace ini sendiri (dan sumber `apps/cms`, meski bukan berkas `.astro`-nya — CodeQL tidak punya ekstraktor Astro) di setiap push, PR, dan jadwal mingguan — belum menjadi status check wajib. `.github/workflows/e2e.yml` menjalankan suite Playwright e2e milik `apps/storefront` — checkout, popup iklan, aksesibilitas axe-core (tag `wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa`, gagal pada pelanggaran `serious`/`critical`), pemeriksaan responsif/overflow deterministik, dan screenshot penuh-halaman per profil yang diunggah sebagai artifact CI — dimatriks-kan atas tiga profil build; ketiga leg-nya (`e2e (toko)`, `e2e (berita)`, `e2e (landing)`) menjadi status check wajib di issue #215, setelah rekam jejak jalan pasca-perkenalan yang terverifikasi tanpa kegagalan e2e yang teramati. `.github/CODEOWNERS`, template PR, dan formulir issue (laporan bug, permintaan fitur, sync upstream) merutekan review dan intake tapi bukan gate merge — repo ini punya satu maintainer, jadi tidak ada review code-owner yang diwajibkan untuk merge. `.github/dependabot.yml` membuka PR pembaruan versi bulanan dan terkelompok untuk GitHub Actions saja; sengaja tidak ada blok ekosistem `bun` (updater `bun` milik Dependabot belum bisa mem-parsing `lockfileVersion` 2 milik `bun.lock` repo ini), jadi dependency workspace milik repo ini sendiri dinaikkan dengan tangan — lihat "Configuration and toolchain" milik `AGENTS.md`. `audit:graf` tambahan membatasi seberapa jauh graf pengetahuan yang di-commit boleh melenceng dari tree yang dideskripsikannya (`MAX_STALE_FILES`), berbasis content-hash karena checkout CI tidak dijamin penuh.

## Belum ada — daftar singkat

- Ubah e-mail/telepon pada akun pelanggan yang sudah ada, dan verifikasi telepon ([ADR-0016](adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) D6).
- Media library ter-upload sungguhan untuk gambar produk/slider/testimonial — sesi `media_library` berbasis-R2 sudah ada, tapi belum ada yang mengisinya di repo ini (lihat [`docs/deployment.md`](deployment.id.md), [`docs/cms.md`](cms.id.md)).
- Adapter gateway pembayaran Xendit dan pelacakan kurir, keduanya disebut sebagai tindak lanjut eksplisit di belakang port yang sudah dibangun [ADR-0017](adr/0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md).
- Pipeline CI yang mempublikasikan image per-profil milik `apps/storefront` ke registry — [ADR-0020](adr/0020-publish-only-the-cms-images-to-ghcr-with-sbom-and-provenance.md) D2 menolak ini secara eksplisit, bukan sekadar menundanya.
- Konfigurasi reverse-proxy/terminasi-TLS di luar contoh milik [`docs/deployment.md`](deployment.id.md) sendiri, enkripsi backup saat-istirahat, dan PostgreSQL produksi yang dioperasikan repositori ini sendiri.
- CodeQL sebagai status check wajib — ia berjalan di setiap push hari ini tapi belum mengumpulkan rekam jejak hijau yang dideskripsikan komentar milik `.github/workflows/template-init-smoke.yml` sendiri sebagai jalur promosi (workflow Playwright e2e/aksesibilitas/responsif melalui promosi yang sama di issue #215).
- Baseline visual-regression yang di-commit untuk screenshot Playwright di atas — sebuah keputusan yang disengaja (reviewer membuka artifact CI dan melihat sendiri, bukan byte-diff yang menggerbangi jalankan), bukan celah.

Lihat [`docs/arsitektur.md`](arsitektur.id.md), [`docs/cms.md`](cms.id.md), dan [`docs/skema-basis-data.md`](skema-basis-data.id.md) untuk apa yang ditunda masing-masing dokumen area secara lebih detail.
