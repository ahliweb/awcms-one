🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md)

<!-- i18n-source-hash: sha256:8fa162ad8808fff6efce215dcd728ffd7d02403ace113aef9b3061900df577dd -->

# ADR-0007 — Keranjang, checkout, dan pelacakan pesanan tetap statis; browser memanggil endpoint commerce anonim milik CMS langsung

- **Status:** Diterima
- **Tanggal:** 16 September 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** [ADR-0002](0002-static-output-with-build-time-fetch-for-the-storefront.id.md) (dibiarkan utuh oleh keputusan ini); [ADR-0009](0009-guest-checkout-by-order-code-and-phone.id.md); [issue #21](https://github.com/ahliweb/awcms-one/issues/21) (komentar amendemen); [issue #29](https://github.com/ahliweb/awcms-one/issues/29); [issue #30](https://github.com/ahliweb/awcms-one/issues/30); `apps/cms/docs/adr/` ADR-0049 (kredensial mesin read-only), ADR-0103/0107/0118 (endpoint cross-origin anonim untuk situs yang dibangun statis) — ruang penomoran milik `ahliweb/awcms` sendiri, dibawa oleh embed subtree

## Konteks

ADR-0002 membuat storefront sepenuhnya statis dan menyatakan bahwa begitu checkout ada, pembacaan runtime harus diargumentasikan secara terpisah. Increment 2 membangun checkout, jadi inilah argumen itu — dan ia melewati dua putaran.

Rencana pertama adalah hybrid: menjaga situs tetap statis, menjadikan keranjang/checkout/pelacakan satu-satunya rute `prerender = false`, dan membuat `apps/storefront/server/penyaji.mjs` mem-proxy-nya ke `apps/cms` dengan kredensial mesin runtime yang bercakupan `commerce.storefront.*`. Dua fakta di `apps/cms` membalikkannya:

1. **Kredensial mesin read-only secara konstruksi** (ADR-0049 milik `apps/cms` sendiri; README milik `identity_access`: "hanya aksi `read`, ditegakkan sebelum izin dikonsultasikan"). Token storefront tidak pernah bisa membuat pesanan — bukan karena kebijakan, karena kode.
2. **Keluarga ini sudah punya jawaban untuk situs yang dibangun statis tapi harus menulis.** Endpoint newsletter, site-search, dan comments yang anonim (ADR-0103, ADR-0107, ADR-0118 milik `apps/cms` sendiri) me-resolve tenant dari `Origin` request lewat `awcms_tenant_domains` — tidak pernah dari header yang dikontrol pemanggil — menjawab preflight `OPTIONS`, meng-echo origin yang diizinkan apa adanya (tidak pernah `*`), mengirim `Vary: Origin` pada setiap respons, tidak memberi kredensial apa pun, rate-limit per IP, dan menjawab netral di mana pun respons yang bisa dibedakan akan bocor. Pola itu ada persis karena "host dari sebuah request dari situs yang dibangun statis adalah CMS ini" (kata-katanya sendiri), yakni persis untuk storefront ini.

| | A. Semuanya server-rendered | B. Statis + proxy SSR dengan kredensial bercakupan (rencana pertama) | C. Statis; browser memanggil endpoint commerce anonim lintas-origin (**dipilih**) | D. "Checkout" adalah pesan WhatsApp |
| --- | --- | --- | --- | --- |
| Keamanan | kredensial live + jalur DB di setiap halaman | kredensial runtime di dalam container — dan yang toh tidak akan diizinkan menulis oleh awcms | **tanpa kredensial di mana pun**; permukaan tulis-anonim yang dikeraskan milik CMS (tenant Origin-bound, rate limit, idempotensi, respons netral) | tidak ada, dan tidak ada pesanan juga |
| Performa / skalabilitas | setiap halaman di-render | halaman statis tetap statis; hop proxy per aksi keranjang | halaman statis tetap statis dan CDN-cacheable; panggilan keranjang berjalan browser→CMS tanpa hop tengah | statis |
| SEO | setiap crawl bergantung pada CMS | statis | statis; keranjang/checkout/pelacakan bersifat `noindex` secara alami | statis |
| Aksesibilitas / UX | — | form bekerja tanpa JS | checkout butuh JavaScript — sebagaimana situs referensi (sebuah Inertia SPA) sudah lakukan; halaman keranjang membawa fallback no-JS (tautan pesan WhatsApp dengan ringkasan terisi otomatis); dukungan keyboard/screen-reader tidak terpengaruh | baik-baik saja, tanpa state pesanan |
| Maintainability | invarian ADR-0002 hilang | mode rendering kedua + daftar rute yang dienumerasi untuk dijaga | **ADR-0002 tidak berubah**; `penyaji.mjs` tidak berubah kecuali satu entri `connect-src`; satu modul klien berbicara ke CMS | tidak ada apa pun yang transaksional dibangun |
| Kompatibilitas dengan CMS | baik-baik saja | berlawanan dengan ADR-0049 | memakai pola yang dibangun CMS untuk kasus ini | — |
| Kompleksitas operasional | satu server yang harus tetap up | satu handler runtime + kredensial yang harus dirotasi | satu origin publik untuk didaftarkan di `awcms_tenant_domains` | tidak ada |
| Jangka panjang | batas terkikis secara default | daftar yang harus dijaga tetap pendek | akun (#32) tiba sebagai endpoint anonim-lalu-terautentikasi lebih banyak di rel yang sama | jalan buntu |

## Keputusan

`apps/storefront` tetap `output: "static"` dengan **tanpa** rute `prerender = false` dan **tanpa** kredensial runtime — sebuah unit test (`apps/storefront/tests/checkout-build-smoke.test.ts`) menegaskan bahwa tidak ada berkas di bawah `apps/storefront/src/pages` yang keluar dari prerendering. Keranjang, checkout, dan pelacakan pesanan adalah halaman statis yang JavaScript sisi-kliennya memanggil `https://<cms>/api/v1/commerce/storefront/*` langsung. Endpoint-endpoint itu (issue #29) dibangun di atas pola `newsletter/application/public-newsletter-tenant.ts` + `domain/newsletter-cors.ts`: tenant dari `Origin`, preflight, origin yang di-echo, `Vary: Origin`, rate limit per-IP dan per-telepon, idempotency key pada pembuatan pesanan (UUID yang dibuat klien milik keranjang, dipakai ulang sebagai idempotency key request), dan satu 404 netral yang sama untuk "pesanan tak dikenal" maupun "telepon salah".

Origin CMS adalah satu-satunya konfigurasi baru: `PUBLIC_AWCMS_ORIGIN`, sengaja diberi awalan `PUBLIC_` (ia adalah origin, bukan rahasia — nilai yang sama yang sudah diungkapkan setiap URL media), divalidasi saat build dan dipanggang ke dalam `connect-src` CSP lewat mekanisme artefak-turunan yang sama yang sudah dibangun ADR-0002 untuk `img-src` (`csp-asal-media.ts` / `dist/client/csp.json`, divalidasi ulang `apps/storefront/server/penyaji.mjs` saat startup — lihat `docs/arsitektur.md`). `AWCMS_API_TOKEN` tetap saat-build dan read-only; tidak ada apa pun setelah build yang membaca variabel `AWCMS_*` apa pun.

## Konsekuensi

- Harga dan stok pada halaman statis tetap sesegar build terakhir (trade-off yang dinyatakan ADR-0002). Halaman keranjang meng-quote ulang setiap baris terhadap CMS sebelum checkout, sehingga harga statis yang basi tidak pernah menjadi baris pesanan; harga yang berubah ditampilkan, tidak pernah dikoreksi secara diam-diam.
- Container storefront tidak pernah melihat pesanan, nomor telepon, atau instruksi pembayaran — semuanya berjalan browser ↔ CMS langsung, `mode: "cors"` / `credentials: "omit"`. Tidak ada apa pun yang terkait pelanggan disimpan di storefront, dan log-nya tidak bisa memuat PII secara konstruksi.
- Tenant yang di-seed harus punya origin storefront-nya terdaftar di `awcms_tenant_domains` (`mart.borneojek.com` dan `http://localhost:4321` untuk development, per `tools/seed-borneojek-mart.ts`); origin yang tidak terdaftar mendapat penolakan netral, yang merupakan mode kegagalan yang dimaksud.
- Akun pelanggan (#32) akan menambahkan endpoint terautentikasi di samping yang anonim ini; itu akan membutuhkan strategi sesi untuk klien browser lintas-origin (ADR-0050 milik `apps/cms` sendiri, pola BFF handoff, adalah titik awalnya) dan ADR-nya sendiri.
