🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](pengujian.md)

<!-- i18n-source-hash: sha256:934b5ed84279c9ff489e7d9d354a98d9ca8bc04da90a52e86635178c23946112 -->

# Pengujian

Tiga tingkat, masing-masing dimiliki workspace berbeda, dijalankan oleh dua job CI. Dokumen ini menamai ketiganya dan bagaimana menjalankan masing-masing — ia tidak menyatakan ulang setiap berkas tes satu per satu.

## 1. Root gate suite (`bun test` dari root repo)

Tidak butuh basis data, tidak butuh build, dan tidak butuh jaringan di luar `bun install`. Mengecualikan `apps/cms/**` sepenuhnya lewat `[test] pathIgnorePatterns` milik `bunfig.toml` (CI memanggil `bun test` telanjang, dan flag pada `bun run test` diam-diam tidak akan berlaku pada pemanggilan telanjang itu). Mencakup gate milik-root repositori ini sendiri (audit dokumentasi, pemeriksaan artefak knowledge-graph, konvensi changeset/rilis, pemeriksaan pin-toolchain, [`tests/kontrak-arah-impor.test.mjs`](../tests/kontrak-arah-impor.test.mjs)) **plus setiap tes unit, build-smoke, dan rute milik `apps/storefront` sendiri** — `apps/storefront` tidak punya skrip `test` sendiri; berkas `tests/*.test.ts`-nya berjalan sebagai bagian dari pemanggilan `bun test` root yang sama ini, di seluruh workspace.

## 2. `apps/storefront`: tes unit, type-check, dan dua tingkat build-smoke

`apps/storefront/tests/` menyimpan sekitar 55 berkas (tidak termasuk `e2e/`), dikelompokkan kira-kira per area:

| Kelompok | Yang dicakup |
| --- | --- |
| News/`berita-*` | Rendering Portable Text (`videoNews`/`gallery`), hierarki rubrik, pembangunan dan pencarian peta legacy-redirect, pemformatan tanggal WIB, validitas RSS, bentuk JSON-LD, guard `/news/**` (dinamai untuk ADR-0071 milik `ahliweb/awcms` sendiri) |
| Catalog/`katalog-*` | Pencarian/filter, pemformatan harga, kontrak keranjang, penurunan origin-media CSP, JSON-LD, toleransi permukaan marketing |
| Runtime/checkout | `toko-klien`/`toko-origin`/`toko-csp` (klien API anonim, validasi `PUBLIC_AWCMS_ORIGIN`, `connect-src` CSP), `checkout-guard-no-prerender` (tidak ada berkas `apps/storefront/src/pages` yang keluar dari output statis), `checkout-build-smoke`, `wilayah-checkout`, `wishlist-kontrak` |
| Server/build/umum | `build-smoke`, `penyaji`, `portable-text`, `profil`, `routes`, `sitemap`, `telepon`, `theme`, `wa-fallback`, `warna` (kontras) |
| Increment 3 (issue #47–#59) | `awcms-media` (chunking, id tak ter-resolve, saringan uuid), `navigasi-berita`/`ikon-sosial` (nav dan deteksi platform), `buletin-klien`, `bagikan` (pembangun URL bagikan, tabel keputusan Web Share/clipboard), `dengar` (unit baca, pemecahan kalimat, saringan suara, kegagalan penyimpanan), `meta-sosial` (pembangun OG/Twitter), `analitik`/`ga`/`ga-csp` (muatan beacon, DNT/GPC, cabang CSP GA), `analitik-terpopuler`, `pengalihan-aturan` (tabel aturan, ujung ke ujung), `penyaji-bayangan-html` (penulisan ulang halaman terbayangi), `logo-instansi`, `wilayah-checkout` (batas konkurensi permintaan), `iklan-popup` |
| Akun pelanggan/afiliasi (issue #88/#90/#93) | `akun-kontrak` (bentuk sesi `localStorage`, storage ber-guard), `akun-klien` (cakupan mocked-fetch untuk setiap fungsi klien akun: request/verify OTP, `me`/`logout`, alamat/wishlist/pesanan/ulasan, gabung/komisi afiliasi), `wishlist-sinkron` (fungsi union-merge murni), `afiliasi-kontrak` (bentuk kode `?ref=`, penangkapan `localStorage` dengan TTL 30 hari, storage ber-guard) |

**Satu build-smoke per fitur, bukan satu berkas bersama.** Kini ada lima belas (`build-smoke` #24, `berita-build-smoke` #28, `katalog-build-smoke` #27, `checkout-build-smoke` #30, `buletin-build-smoke` #50, `bagikan-build-smoke` #51, `dengar-build-smoke` #52, `sidebar-build-smoke` #49, `logo-instansi-build-smoke` #59, `meta-sosial-build-smoke` #54, `analitik-build-smoke`, `penyaji-bayangan-build-smoke` #75, `akun-build-smoke` #88, `akun-dashboard-build-smoke` #90, `afiliasi-build-smoke` #93). Masing-masing menyalakan stub, menjalankan `astro build` **sungguhan**, lalu memeriksa HTML yang benar-benar mendarat di `dist/client/` — satu-satunya tempat beberapa cacat bisa terlihat sama sekali: pemutar yang dirender tampak alih-alih `hidden`, pemutar di pos video, lambang di artikel yang lembaganya tak punya, `og:image` yang berubah untuk halaman toko, halaman yang 404 hanya ketika disajikan. Setiap satunya SKIP dengan pesan jelas alih-alih lulus ketika `bun` tidak bisa dijalankan.

`bun --bun astro check` (skrip `check` milik `apps/storefront/package.json`) adalah type-check, dijalankan sebagai langkah pertama `bun run build`. **Build manual dua-terminal berbasis stub** tambahan membuktikan aplikasi benar-benar membangun situs nyata tanpa `apps/cms` hidup untuk dijangkau — tidak tersambung ke CI, tapi dijalankan tangan pada setiap PR yang menyentuh workspace ini:

```bash
# terminal 1
bun scripts/stub-awcms.mjs
# terminal 2
AWCMS_API_URL=http://localhost:4310 AWCMS_API_TOKEN=stub-token \
  PUBLIC_AWCMS_ORIGIN=https://cms.example.com SITE_URL=http://localhost:4321 bun run build
```

`apps/storefront/scripts/stub-awcms.mjs` melayani setiap endpoint yang dipanggil storefront, termasuk state machine storefront-commerce (quote → buat pesanan → lacak → konfirmasi pembayaran → batalkan) yang dijalankan alur checkout, membaca body respons dari `apps/storefront/tests/fixtures/awcms/`. Ia sengaja tidak diimpor oleh `astro.config.mjs`, `src/`, atau `apps/storefront/server/penyaji.mjs` — tidak ada apa pun di jalur build produksi yang bisa menjangkaunya secara tidak sengaja.

**State machine `/account/*` milik stub sendiri (issue #88/#90/#93).** `otp/request` selalu menjawab `202` netral; `otp/verify` menerima persis satu kode tetap, `123456`, dan selebihnya menjawab error yang sama yang didefinisikan API sungguhan (`ACCOUNT_NOT_FOUND`, `PHONE_ALREADY_REGISTERED`, `OTP_INVALID`); `me`/`logout` dan setiap rute `account/{addresses,wishlist,orders,reviews,affiliate}` hanya-Bearer, diperiksa terhadap header `Authorization` persis seperti `requireCustomerSession` milik CMS sendiri. Fixture `customer-accounts.json` men-seed satu akun (`budi@example.test`, `+6281234567890`) dengan dua pesanan stub, satu bertanggal sebelum dan satu sesudah `historyFrom` akun itu sendiri — sehingga `akun-dashboard-build-smoke` bisa menegaskan bahwa pesanan sebelum-`historyFrom` tidak pernah muncul di `/akun/pesanan`, persis yang ditegakkan query `GET account/orders` sungguhan di sisi server. Ini pengganti perilaku sungguhan `apps/cms`, bukan salinan kedua logikanya — ia ada agar suite build-smoke dan unit `apps/storefront` sendiri bisa menjalankan skenario pembeli-sudah-masuk tanpa `apps/cms` yang hidup.

**Satu konstanta deadline bersama untuk setiap penantian stub build-smoke (`STUB_START_DEADLINE_MS = 20_000` milik `apps/storefront/tests/stub-deadline.ts`).** Increment 5 membesarkan stub menjadi selusin fixture dan mesin status (akun, percakapan, sesi gateway, tarif kurir, …), dan enam belas test build-smoke kini memulainya sekaligus di runner CI dua-core — cold start rutin melewati literal 5 detik lama yang dahulu diulang tiap tes, menggagalkan PR yang sungguh hijau karena kecelakaan timing (PR #122 butuh empat kali rerun sebelum perbaikan ini). Setiap test build-smoke kini mengimpor satu konstanta ini alih-alih meng-hardcode penantiannya sendiri, sehingga penyesuaian berikutnya cukup satu baris, bukan lima belas.

**Halaman payment-gateway hosted milik stub sendiri (issue #112), `GET /stub/gateway/{sessionId}`.** Sesi gateway setara-`log` milik `apps/storefront/scripts/stub-awcms.mjs` mengarahkan `redirectUrl` ke `/stub/gateway/{sessionId}` milik proses ini sendiri — halaman HTML minimal dengan dua `<form>` (`POST /stub/gateway/{sessionId}/pay`, `.../cancel`) yang menjadi pengganti halaman Midtrans Snap sungguhan di dev/CI/e2e, sehingga `checkout.e2e.ts` dan build stub apa pun secara manual bisa menjalankan seluruh loop redirect → bayar/batal → polling tanpa akun gateway sungguhan. Halaman ini hanya dijangkau lewat respons `createSession` milik stub sendiri, tidak pernah ditautkan dari halaman `apps/storefront` sendiri.

## Suite integrasi `apps/cms` milik increment 5 (issue #107/#108/#110/#111/#113/#114/#116/#117/#118)

Masing-masing mendarat dengan berkas `tests/integration/` sendiri, dijalankan sungguhan terhadap PostgreSQL hidup persis seperti setiap suite commerce sebelumnya — tidak pernah sekadar ditulis dan dibiarkan skip ber-gerbang-DB: `commerce-shipping-rates.integration.test.ts` (baca/tulis-balik cache RajaOngkir di luar transaksi, weight bucketing, purge TTL), `commerce-whatsapp.integration.test.ts` (claim/kirim/selesaikan outbox, login OTP WhatsApp, rate limit per telepon), `commerce-payment-gateway.integration.test.ts` (idempotensi pembuatan sesi, penanganan replay/tanda tangan/ketidakcocokan-jumlah intake webhook, `markOrderPaidBySystem`, job rekonsiliasi), `commerce-conversations.integration.test.ts` (buka/balas/tutup thread, denormalisasi flag unread, rate limit per akun), `commerce-campaigns.integration.test.ts` (resolusi audiens ber-gate consent, dispatch resumable lewat `FOR UPDATE SKIP LOCKED`, kirim/batal), `commerce-pos.integration.test.ts` (penjualan konter langsung lunas, reuse walk-in, harga bertingkat di konter, penolakan `cash` storefront, replay idempoten), `commerce-sales-reports.integration.test.ts` (paid → baris, batal-setelah-paid → dikurangi, rebuild identik-byte dengan live, rekonsiliasi tanpa mismatch), dan `commerce-feature-toggles.integration.test.ts` (`409` pada rute terautentikasi, `404` netral/`503` yang sudah ada pada rute anonim, cakupan gate per-fitur).

### Playwright e2e — tingkat keempat, perintahnya sendiri, bukan bagian dari `bun test`

`apps/storefront/tests/e2e/checkout.e2e.ts` menjalankan browser Chromium nyata terhadap build+serve+stub nyata, dijalankan dengan `bun run test:e2e` **di dalam `apps/storefront`** (tidak pernah root `bun test` — sufiks `.e2e.ts` sengaja menjaganya di luar discovery itu). Mencakup add-to-cart → quote keranjang me-render total → checkout submit → pelacakan menampilkan pesanan, plus state not-found netral untuk telepon yang salah. **Tidak tersambung ke `.github/workflows/ci.yml`** — ini di luar cakupan berkas CI milik-ops untuk issue yang menambahkannya; `apps/storefront/README.md` mendokumentasikan persis bagaimana job CI di masa depan akan menjalankannya (install Chromium, jalankan stub, build dengan env yang tepat, serve, arahkan `E2E_BASE_URL`/`STUB_ALLOWED_ORIGIN` satu sama lain).

## 3. `apps/cms` (job CI `check-cms`): PostgreSQL nyata yang disediakan

Berbeda dari increment 1, ini bukan lagi prosedur manual-saja — [issue #25](https://github.com/ahliweb/awcms-one/issues/25) menyediakan PostgreSQL baik untuk pengembangan lokal maupun CI. `apps/cms` membawa rantai gate besarnya sendiri (skrip `check` milik `apps/cms/package.json`: 53 langkah gabungan-`&&` — lint, docs/i18n, setiap gate registry/konsistensi, typecheck, `bun test`, `bun run build`) plus `bun test`-nya sendiri (sekitar 7.170 tes per PR afiliasi) dan suite `tests/integration/` yang butuh basis data hidup.

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

Container layanan `postgres:18.4` (`POSTGRES_USER=awcms`, `POSTGRES_DB=awcms`, health-checked dengan `pg_isready`), lalu: `cd apps/cms && DATABASE_URL="" bun run check`, lalu `bun run db:migrate:cms` terhadap layanan itu, lalu `cd apps/cms && bun test tests/integration/ --timeout 60000` — lebih dari 710 tes per PR afiliasi, termasuk `commerce-catalog.integration.test.ts` (filter list, by-slug, CRUD gambar/varian, restore, RLS lintas-tenant), `commerce-marketing.integration.test.ts` (penurunan flash-sale, job tick yang menembak persis sekali, voucher publik, indeks single-active popup, round-trip settings), dan keempat suite increment-4 di bawah. Langkah job-summary melaporkan jumlah skip ber-gate-DB sebelum dan sesudah basis data hidup tersambung, sehingga reviewer bisa melihat suite itu benar-benar berjalan.

**Akun pelanggan dan afiliasi (issue #87/#89/#91/#92) masing-masing mengirim suite `tests/integration/`-nya sendiri, setiap satunya benar-benar dijalankan terhadap PostgreSQL hidup, tidak pernah sekadar ditulis lalu dibiarkan skip-ber-gate-DB:** `commerce-customer-account-store.integration.test.ts` (9 tes — membuat/mengikat akun menerapkan aturan history-from D4, menerbitkan/mengonsumsi OTP dengan penghitungan attempt dalam satu `UPDATE … RETURNING`, terbitkan/temukan/sentuh/cabut sesi), `commerce-customer-auth.integration.test.ts` (9 — request/verify OTP ujung ke ujung, kasus daftar-pada-e-mail-yang-sudah-ada-jadi-login, auto-seed per-tenant template e-mail turunan saat pertama kali hilang), `commerce-customer-account-resources.integration.test.ts` (14 — alamat/wishlist/pesanan/ulasan, batas `historyFrom` yang ditegakkan di dalam query, invarian alamat-default indeks-unik-parsial), dan `commerce-affiliates.integration.test.ts` (7 — pendaftaran, pembuatan komisi saat transisi `completed`, pengecualian referral-diri-sendiri dan afiliasi ditangguhkan, state machine approve/pay/void). Setiap PR yang mendaratkan salah satu suite ini menjalankannya terhadap PostgreSQL dev lokal `apps/cms` sendiri (basis data ber-gate-`DATABASE_URL` yang sama yang disediakan `bun run db:up`/`db:migrate:cms`), bukan sekadar diasersi secara struktural — sikap ber-gate-DATABASE_URL yang sama yang sudah ditetapkan lebih dulu oleh suite `commerce-orders.integration.test.ts`.

## Dua hal yang harus diketahui kontributor sebelum menulis query di sini

- **Uang terbaca sebagai `"0"`, bukan `"0.00"`, lewat query `Bun.SQL` yang diparameterisasi.** `0.00` yang tersimpan ter-decode sebagai teks `"0"` saat dibaca lewat protokol extended (query yang diparameterisasi) tapi sebagai `"0.00"` lewat query simple — setiap nilai non-nol menjaga skalanya di kedua kasus. `normalizeMoney` (`apps/cms/src/modules/commerce/domain/price-calculation.ts`) ada khusus untuk membuat bentuk wire tidak bergantung pada protokol mana yang kebetulan melayani baris itu; setiap `toRecord` di modul commerce melewatkan setiap field uang lewatnya sebelum pernah meninggalkan modul (`null` lewat tanpa berubah — nilai uang yang tidak ada adalah `null` di wire, tidak pernah `"0.00"`). Terapkan di jalur baca, tidak pernah di aritmetika.
- **`= ANY($ids)` dengan array JS biasa diam-diam mis-bind di bawah `Bun.SQL`.** Dilewatkan langsung, array berisi dua atau lebih id ter-bind sebagai satu nilai teks `"a,b"` (error PostgreSQL `22P02`); array satu-elemen lolos diam-diam, yang persis inilah yang membuat ini pernah lolos sekali (memengaruhi setiap list produk #23 dengan dua atau lebih produk yang membawa gambar, sampai seeding #26 sendiri menangkapnya). Perbaikan yang dipakai di seluruh modul commerce adalah `tx.array([...ids], "uuid")::uuid[]` — bind array secara eksplisit sebagai `uuid[]` Postgres, tidak pernah parameter telanjang.

## Apa yang dibutuhkan setiap tingkat untuk menjawab "apakah commerce benar"

| Pertanyaan | Tingkat |
| --- | --- |
| Apakah state machine produk/pesanan/flash-sale berperilaku benar secara terisolasi? | `apps/cms/tests/commerce-domain.test.ts`, `apps/cms/tests/commerce-marketing-domain.test.ts` milik `apps/cms` (murni, tanpa basis data) |
| Apakah setiap migrasi commerce tetap di dalam rentang cadangan `9xx`, dan setiap migrasi lain di luarnya (issue #72)? | `apps/cms/tests/commerce-migrations-range.test.ts` milik `apps/cms` (murni, hanya membaca nama berkas `apps/cms/sql/`) |
| Apakah rencana rename `db:commerce:renumber` berperilaku benar untuk basis data baru, sudah-bermigrasi, campuran, atau sudah-diberi-nomor-ulang (issue #72)? | `apps/cms/tests/commerce-migrations-renumber.test.ts` milik `apps/cms` (murni, tanpa basis data) |
| Apakah RLS benar-benar mengisolasi setiap tabel `awcms_commerce_*` per tenant? | Suite integrasi RLS generik milik `apps/cms`, diturunkan dari pernyataan `ENABLE`/`FORCE` masing-masing tabel (butuh PostgreSQL) |
| Apakah API storefront anonim me-resolve tenant dengan benar dan menolak sisanya? | `commerce-catalog.integration.test.ts`/`commerce-marketing.integration.test.ts`/`commerce-orders.integration.test.ts` milik `apps/cms` (semua butuh PostgreSQL) |
| Apakah storefront membangun situs nyata terhadap envelope API nyata, termasuk checkout? | Build berbasis stub milik `apps/storefront`, dan `bun run test:e2e` |
| Apakah `apps/cms` pernah diimpor dengan arah salah dari `apps/storefront`/`packages/kontrak`? | Root `bun test` → `tests/kontrak-arah-impor.test.mjs` |
| Apakah dokumentasi dan konvensi rilis repositori ini sendiri bertahan? | Root `bun test` plus gate `audit:*` |

## Belum dibangun

Job CI untuk suite Playwright e2e milik `apps/storefront` (berjalan dan lulus secara lokal; lihat "Playwright e2e" di atas). Tooling visual-regression atau accessibility-audit apa pun — lihat [`docs/aksesibilitas.md`](aksesibilitas.id.md) dan [`docs/responsif.md`](responsif.id.md) untuk apa yang diverifikasi dengan membaca kode sebagai gantinya.
