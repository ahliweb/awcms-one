🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](SKILL.md)

> Mirror terjemahan dari `SKILL.md`. Berkas yang dimuat oleh mekanisme skill (dicocokkan persis pada nama `SKILL.md`) adalah versi Inggris; berkas ini adalah salinan baca untuk pembaca Bahasa Indonesia, bukan berkas yang dimuat langsung.

# awcms-one — Menambah halaman storefront

Ikuti [`docs/arsitektur.md`](../../../docs/arsitektur.id.md), [`docs/routing.md`](../../../docs/routing.id.md), [ADR-0002](../../../docs/adr/0002-static-output-with-build-time-fetch-for-the-storefront.id.md), dan [ADR-0007](../../../docs/adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.id.md) untuk penalaran lengkapnya; skill ini adalah panduan praktisnya.

## Satu aturan yang mengatur setiap halaman di aplikasi ini

**`apps/storefront` adalah `output: "static"`. Tidak ada halaman yang boleh menyetel `prerender = false`, sama sekali — bahkan halaman yang butuh data live.** Sebuah unit test (`apps/storefront/tests/checkout-guard-no-prerender.test.ts`) meng-grep setiap berkas di bawah `apps/storefront/src/pages` untuk string itu dan menggagalkan build jika menemukannya. Ada tepat dua cara sebuah halaman mendapat data, dan setiap halaman di aplikasi ini memakai salah satunya, tidak pernah cara ketiga:

```mermaid
flowchart LR
  A[Halaman baru butuh data] --> B{Diketahui saat BUILD?}
  B -->|Ya — katalog, berita, marketing, profil situs| C["Ambil di getStaticPaths()/frontmatter lewat API OWNER milik apps/cms — AWCMS_API_TOKEN, sisi server, hanya saat build"]
  B -->|Tidak — kutipan live, sebuah pesanan, aksi keranjang| D["Kirim skrip sisi klien yang memanggil API storefront ANONIM milik apps/cms langsung dari browser — PUBLIC_AWCMS_ORIGIN, CORS, tanpa kredensial"]
```

Jika Anda mendapati diri ingin opsi ketiga — rute server-rendered, kredensial runtime di `apps/storefront/server/penyaji.mjs` — berhenti dan baca dulu tabel trade-off ADR-0007. Ide itu persis pernah diusulkan dan ditolak untuk keranjang/checkout.

## Pilih dulu group profilnya (issue #137, ADR-0018 D2/D3)

Setiap halaman memiliki tepat satu group profil build — `shared`, `toko`, atau `berita` — ditentukan oleh [matriks profil ADR-0018, dijaga tetap terkini di `docs/template.md`](../../../docs/template.id.md#matriks-profil). Sebelum menambah rute, tanyakan dulu group mana yang cocok:

- **Setiap profil mengirimnya** (halaman yang dibutuhkan setiap deployment, tanpa memandang commerce/berita) → `shared` → berkas masuk ke `apps/storefront/src/pages/**`, persis seperti routing berbasis-berkas Astro biasa.
- **Hanya build commerce yang mengirimnya** (keranjang, checkout, produk, kategori, akun…) → `toko` → berkas masuk ke `apps/storefront/src/profil/toko/pages/**`, path relatif sama seperti kalau berada di bawah `src/pages/`.
- **Hanya build berita yang mengirimnya** (artikel, rubrik, penulis, daerah…) → `berita` → `apps/storefront/src/profil/berita/pages/**`.

`apps/storefront/integrations/profil.mjs` menyuntikkan setiap halaman di bawah `pages/**` group yang aktif sebelum Astro memindai `src/pages/` — pola rute diturunkan dari path berkasnya persis seperti routing berbasis-berkas biasa (`feed.xml.ts` → `/feed.xml`), dan tidak ada halaman di lokasi mana pun yang boleh menyetel `prerender = false`. Daftarkan rute di `ROUTE_GROUPS` milik `apps/storefront/src/config/routes.ts` tanpa memandang group mana pun — key yang tidak dianotasi adalah error tipe. Tambahkan berkas baru ke matriks di `docs/template.md` dalam perubahan yang sama; `apps/storefront/tests/profil-integrasi.test.ts` menggagalkan build jika tree dan tabel itu tidak sepakat. Jika halaman menambah tautan nav, tautan footer, sumber sitemap, feed, atau aturan robots, sambungkan lewat `apps/storefront/src/config/profil.ts` (daftar per-group) alih-alih menambah kondisional berdiri sendiri di tempat lain — modul itu adalah satu-satunya tempat setiap konsumen sadar-profil membaca.

## Menambah halaman build-time (kasus umum: katalog, berita, halaman statis)

1. Tambah berkas rute di bawah direktori `pages/` group yang dipilih di atas (`apps/storefront/src/pages/` untuk `shared`, `apps/storefront/src/profil/<group>/pages/` untuk `toko`/`berita`) — routing berbasis-berkas Astro pada keduanya (`foo/[slug].astro` → `/foo/{slug}`). Daftarkan di `apps/storefront/src/config/routes.ts` jika rute itu ditautkan dari halaman lain.
2. Ambil datanya di frontmatter halaman atau `getStaticPaths()`, lewat fungsi di `apps/storefront/src/lib/awcms/` (mis. `catalog.ts`, `blog.ts`, `pemasaran.ts`) — jangan pernah `fetch()` mentah langsung di dalam halaman. Fungsi-fungsi ini memanggil API **owner** milik `apps/cms` (`AWCMS_API_TOKEN`, read-only, hanya saat build) dan di-memoize per build, sehingga beberapa halaman yang membaca resource sama tidak fetch ulang.
3. Jika halaman merender gambar yang origin-nya bukan `'self'`, atau butuh origin eksternal baru, cek bagian CSP di [`docs/arsitektur.md`](../../../docs/arsitektur.id.md) — `img-src` *diturunkan*, bukan dikonfigurasi; field gambar baru biasanya tidak butuh perubahan CSP sama sekali, karena `csp-asal-media.ts` mengumpulkan origin dari konten secara otomatis.
4. Jika halaman itu harus muncul di sitemap, daftarkan sumbernya: `registerSitemapSource(name, asyncFn)` di `apps/storefront/src/lib/sitemap-sources.ts` atau `sitemap-katalog.ts`.
5. Jika halaman itu transaksional/personal (halaman akun, halaman hasil pencarian, apa pun yang tidak boleh terindeks), tambahkan `<meta slot="head" name="robots" content="noindex, follow" />` lewat slot `head` milik `BaseLayout`, dan tambahkan ke daftar `Disallow` di `robots.txt.ts`.
6. Setiap string yang tampak ke pengguna adalah Bahasa Indonesia, tanpa syarat — tidak ada framework i18n di aplikasi ini (lihat [`docs/ui-ux.md`](../../../docs/ui-ux.id.md)).
7. Jaga kontrak landmark/skip-link: `BaseLayout` tidak merender `<h1>` — halaman Anda memiliki tepat satu. Setiap elemen interaktif adalah elemen HTML asli yang bisa di-focus — jangan pernah `<div>` dengan click handler.

## Menambah halaman atau skrip runtime (browser memanggil `apps/cms`)

Ini pola keranjang/checkout/pelacakan-pesanan/wishlist — pakai hanya saat data benar-benar tidak bisa diketahui saat build (keranjang milik seorang pembeli, sebuah pesanan spesifik).

1. Halaman itu sendiri tetap berkas `.astro` statis biasa dengan **tanpa** `prerender = false`. Semua perilaku runtime hidup di skrip sisi klien (`apps/storefront/src/scripts/`), dimuat sebagai modul eksternal biasa (`script-src 'self'` tidak punya `'unsafe-inline'` dan tidak akan pernah — setiap skrip adalah berkas asli, tidak pernah inline).
2. Panggil API **anonim** milik `apps/cms` lewat `apps/storefront/src/lib/toko-klien.ts` — satu fungsi per endpoint, setiap request `mode: "cors"` / `credentials: "omit"`, hanya header `Content-Type`. Jangan pernah panggil `fetch()` langsung ke `apps/cms` dari skrip baru; tambahkan fungsi ke `toko-klien.ts` sebagai gantinya, sehingga penanganan amplop-error (`TokoApiError`, error field-level `VALIDATION_ERROR`, `409 CART_CHANGED`, `429` dengan `Retry-After`) tetap di satu tempat.
3. `PUBLIC_AWCMS_ORIGIN` — dibaca lewat `requireAwcmsOrigin()` milik `apps/storefront/src/lib/awcms/toko-origin.ts` — adalah satu-satunya cara aplikasi ini tahu CMS mana yang dipanggil saat runtime. Ia divalidasi sekali, saat build, dari `apps/storefront/src/pages/csp.json.ts` (halaman yang selalu di-prerender tanpa syarat oleh setiap build), sehingga nilai yang hilang/salah bentuk menggagalkan **build**, bukan pemuatan halaman pembeli.
4. Sediakan tiga fallback, sama seperti setiap halaman runtime yang sudah ada: pesan `<noscript>`, fallback WhatsApp untuk kondisi JS-jalan-tapi-CMS-tak-terjangkau (`apps/storefront/src/lib/wa-fallback.ts`), dan `aria-live="polite"` pada region yang berubah (lihat [`docs/aksesibilitas.md`](../../../docs/aksesibilitas.id.md)).
5. Jangan pernah mempercayakan angka harga/stok saat build ke sebuah penulisan. Keranjang mengutip ulang secara live sebelum checkout justru karena alasan ini — angka milik halaman statis hanyalah tampilan, tidak pernah menjadi input ke sebuah pesanan.

## Menambah halaman terautentikasi (pelanggan-sudah-masuk)

Ini pola `/akun*` (issue #88/#90/#93) — varian keempat dari pola runtime di atas, untuk halaman yang perlu tahu apakah pembeli sudah masuk, bukan sekadar data runtime anonim.

1. Halaman itu sendiri tetap berkas `.astro` statis biasa — sebuah SHELL statis yang me-render kedua state (tamu dan sudah-masuk) dalam markup, tidak pernah rute yang memutuskan di sisi server. Skrip sisi-klien (`apps/storefront/src/scripts/akun-*.ts`) membaca sesi lewat `bacaSesi()` (`apps/storefront/src/lib/akun-sesi.ts`) dan mengalihkan state mana yang ditampilkan — pemisahan yang sama yang dipakai setiap halaman `/akun*` yang sudah ada.
2. Jangan pernah menciptakan bentuk sesi kedua. `akun-sesi.ts` memiliki bentuk `{token, expiresAt, account}` yang tersimpan (kunci `localStorage` `awcms-one:akun:v1`) dan memicu `akun:berubah` saat berubah; `akun-klien.ts` adalah satu-satunya tempat yang melampirkan `Authorization: Bearer …` ke request. Tambahkan endpoint baru berorientasi-akun sebagai fungsi di `akun-klien.ts`, mengikuti konvensi satu-fungsi-per-endpoint yang sudah ditetapkan `toko-klien.ts` untuk API anonim.
3. **`401 UNAUTHENTICATED` dari rute apa pun yang dijaga bearer membersihkan sesi tersimpan** (`akun-klien.ts` memanggil `hapusSesi()` untuk itu) — jangan pernah biarkan token basi/kedaluwarsa tertinggal di `localStorage` setelah sebuah panggilan melaporkannya tidak valid. Ini satu perilaku yang wajib diwarisi setiap halaman terautentikasi, bukan diimplementasikan ulang.
4. `noindex, follow` lewat slot `head` milik `BaseLayout`, sama seperti setiap halaman transaksional lain, **plus** daftar `Disallow` di `robots.txt.ts` — `Disallow: /akun` yang telanjang sudah mencakup setiap rute anak, sehingga halaman baru di bawah `/akun/*` tidak butuh perubahan `robots.txt`; rute akun TINGKAT-ATAS baru (bukan di bawah `/akun`) butuh.
5. Perluas state machine `/account/*` milik `apps/storefront/scripts/stub-awcms.mjs` dan `apps/storefront/tests/fixtures/awcms/customer-accounts.json` untuk endpoint baru, dengan cara yang sama seperti memperluas stub untuk endpoint anonim baru — dua pesanan yang di-seed fixture itu (satu sebelum, satu sesudah `historyFrom`) ada khusus supaya tes build-smoke bisa membuktikan batas seperti D4 ADR-0016 dihormati, bukan sekadar sebuah daftar ter-render.
6. Tambahkan tes build-smoke khusus (`akun-*-build-smoke.test.ts`) yang menegaskan HTML nyata yang di-build: halaman ada, membawa `noindex`, menyembunyikan apa pun yang seharusnya hanya muncul begitu JavaScript membuktikan ada sesi, dan tanpa script/style inline — standar yang sama yang sudah dipegang `akun-build-smoke.test.ts`/`akun-dashboard-build-smoke.test.ts`/`afiliasi-build-smoke.test.ts` untuk setiap halaman akun.

## Tiga hal yang ditambahkan increment 3 dan wajib dihormati halaman baru

1. **Media di-resolve, tidak pernah disusun.** Field CMS yang membawa gambar adalah id telanjang; resolve dengan `resolveMedia` (`apps/storefront/src/lib/awcms/media.ts`) dan jangan render apa pun ketika tidak ter-resolve. Jangan pernah menyusun URL dari id dan origin — [ADR-0011](../../../docs/adr/0011-storefront-media-resolves-through-the-media-objects-endpoint.md) ada justru karena tebakan itulah jawaban salah yang kelihatan paling wajar. Kalau halaman Anda memperkenalkan origin gambar baru, ia masuk ke CSP turunan secara otomatis **hanya** karena halaman itu me-resolve-nya lewat klien tersebut; origin yang ditambahkan tangan di `csp.json.ts` adalah bau busuk.
2. **Skrip sisi-klien adalah modul eksternal, dipasang sekali dari layout.** Badan `<script>` inline tidak akan pernah berjalan di bawah CSP aplikasi ini (`script-src 'self'`, tanpa nonce di situs statis). Taruh kodenya di `apps/storefront/src/scripts/`, `import` dari satu blok `<script>` di layout yang memiliki permukaan itu, dan pastikan markup-nya tetap berfungsi tanpanya — pemutar baca-nyaring (`hidden` sampai terbukti didukung) dan panel Daerah (dirender penuh, hanya dilipat skrip) adalah dua pola untuk ditiru.
3. **Halaman baru yang sekaligus landing dan induk anak tidak butuh penanganan khusus — tapi ketahui alasannya.** Di bawah `build.format: "file"` ia dipancarkan sebagai `name.html` di samping `name/`, dan `apps/storefront/server/penyaji.mjs` menulis ulang path terbayangi itu saat startup ([issue #75](https://github.com/ahliweb/awcms-one/issues/75)). Kalau Anda menambah halaman semacam itu, tambahkan ke daftar `apps/storefront/tests/penyaji-bayangan-build-smoke.test.ts` alih-alih menganggap penemuannya menutupinya diam-diam.

## Memverifikasi perubahan Anda

```bash
# terminal 1
bun scripts/stub-awcms.mjs
# terminal 2, di dalam apps/storefront
AWCMS_API_URL=http://localhost:4310 AWCMS_API_TOKEN=stub-token \
  PUBLIC_AWCMS_ORIGIN=https://cms.example.com SITE_URL=http://localhost:4321 bun run build
```

`apps/storefront/scripts/stub-awcms.mjs` melayani setiap endpoint yang dipanggil aplikasi ini, termasuk mesin-status commerce-storefront (kutip → buat pesanan → lacak → konfirmasi pembayaran → batalkan) dari fixture di `tests/fixtures/awcms/`. Jika halaman Anda memanggil endpoint baru, perluas stub dan fixture-nya dalam perubahan yang sama — halaman yang satu-satunya bukti kebenarannya adalah "berhasil dikompilasi" belumlah terbukti.

```bash
bun run check         # astro check — error tipe
bun test               # dari root repo — setiap unit/build-smoke/route test storefront berjalan di sini
bun run test:e2e        # di dalam apps/storefront, hanya untuk perubahan keranjang/checkout/pelacakan yang nyata — Playwright, Chromium asli
```

`bun run audit:dokumen`/`audit:translation` (dari root) jika Anda menyentuh berkas `docs/**` dalam perubahan yang sama — lihat [`docs/pengujian.md`](../../../docs/pengujian.id.md) untuk apa yang sebenarnya dibuktikan tiap tingkat.
