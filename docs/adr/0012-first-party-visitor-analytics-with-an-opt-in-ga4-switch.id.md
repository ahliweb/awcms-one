🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0012-first-party-visitor-analytics-with-an-opt-in-ga4-switch.md)

<!-- i18n-source-hash: sha256:a9e972c5faf38ab91ef9bfc586dab247338928001d2847bfb07a1d0d94748958 -->

# ADR-0012 — Analitik pengunjung bersifat first-party secara bawaan; GA4 adalah sakelar opt-in

- **Status:** Accepted
- **Tanggal:** 18 September 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** issue #49, #56; `apps/cms/src/modules/visitor-analytics/README.md`; `apps/cms/src/modules/visitor-analytics/domain/beacon-cors.ts`

## Konteks

seputarborneo.com memuat GA4 di setiap halaman dan, terpisah dari itu, memelihara tabel `counter` per-IP-per-hari miliknya sendiri. `apps/storefront` tidak mengirim apa pun, dengan dua akibat: operator tidak punya angka trafik, dan modul `visitor_analytics` milik `apps/cms` — mengutamakan privasi, mati secara bawaan, dengan endpoint ingest publik sejak porting-nya — tidak punya pemanggil, sehingga rollup yang dibutuhkan blok "Terpopuler" tetap kosong.

## Keputusan

Setiap halaman mengirim beacon tampilan-halaman first-party ke `POST /api/v1/analytics/collect`; GA4 dipancarkan **hanya** ketika `PUBLIC_GA_ID` diisi pada waktu build.

| | GA4 saja (situs rujukan) | First-party saja | First-party + GA4 opt-in (**dipilih**) |
| --- | --- | --- | --- |
| Privasi | setiap tampilan halaman pembaca keluar ke pihak ketiga secara bawaan | tidak ada yang keluar dari infrastruktur operator sendiri | tidak ada yang keluar secara bawaan; operator memilih ikut dengan sadar |
| CSP | satu origin skrip/koneksi pihak ketiga di setiap halaman | nol | nol secara bawaan; origin GA hanya muncul pada build ber-GA |
| "Terpopuler" | mustahil (storefront tidak bisa membaca GA) | nyata, dari rollup modul itu sendiri | nyata |
| Keakraban operator | tinggi | laporan berbentuk GA tidak ada | keduanya tersedia |

## Konsekuensi

- Beacon memakai `fetch` dengan `keepalive`, tidak pernah `navigator.sendBeacon`: muatan `sendBeacon` mendarat sebagai `text/plain`, yang ditolak pemeriksaan CORS/origin milik CMS secara lintas-origin — kegagalan yang sudah pernah didiagnosis dan diperbaiki docblock modul itu sendiri.
- Ia mengirim persis yang divalidasi route (`tenantCode`, `path`, `referrer?`), tidak membawa cookie atau pengenal sisi-klien miliknya sendiri, dan diam ketika `navigator.doNotTrack === "1"` atau Global Privacy Control aktif.
- Bootstrap GA4 adalah modul terbundel biasa, bukan snippet inline milik Google: CSP aplikasi ini tidak punya `'unsafe-inline'` maupun nonce per-permintaan, jadi badan inline tidak akan pernah berjalan. Hanya tag `gtag.js`-nya sendiri yang butuh pelebaran `script-src`/`connect-src`/`img-src`.
- "Terpopuler" memeringkat dari laporan `pages` milik modul itu selama tujuh hari terakhir dan jatuh ke "terbaru" ketika modulnya mati atau menjawab kosong — fallback itu dicatat di kode, tidak pernah didandani sebagai peringkat di antarmuka.
