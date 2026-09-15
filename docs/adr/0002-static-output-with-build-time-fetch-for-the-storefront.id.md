🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0002-static-output-with-build-time-fetch-for-the-storefront.md)

<!-- i18n-source-hash: sha256:5a9a3f7ed13acc5cf6718982e71b70fa66f4ca94fe5a85e90c4e044caedacbf7 -->

# ADR-0002 — Storefront adalah `output: "static"`, mengambil katalog saat build

- **Status:** Diterima
- **Tanggal:** 15 September 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** [issue #1](https://github.com/ahliweb/awcms-one/issues/1); [issue #5](https://github.com/ahliweb/awcms-one/issues/5) (storefront itu sendiri, dan keputusan yang dicatat di sana); [`docs/arsitektur.md`](../arsitektur.md); [`docs/deployment.md`](../deployment.md)

## Konteks

`apps/storefront` dimodelkan dari keluarga `ahliweb/awcms-astro`/`ahliweb/media-lenterakalteng` — situs publik yang membaca dari backend `awcms` dan mempublikasikan HTML. Keluarga itu sudah membuat keputusan yang sama sebelum repositori ini ada; issue #5 mengargumentasikannya ulang di sini karena increment 1 tidak punya keranjang, tidak punya checkout, dan tidak punya tulis saat runtime — persis kasus di mana build statis paling kuat dan jalur request hidup tidak membeli apa pun.

Alternatifnya adalah `output: "server"` dengan `@astrojs/node` me-render setiap request sesuai permintaan, menjangkau API `apps/cms` secara live, per kunjungan.

## Keputusan

`apps/storefront` di-build dengan `output: "static"` (`astro.config.mjs`). `astro build` mengambil seluruh katalog produk dan kategori dari API publik `apps/cms` **sekali, saat build**, memakai token Bearer read-only khusus-build (`AWCMS_API_TOKEN`), dan memanggang setiap halaman menjadi berkas statis. Adapter `standalone` milik `@astrojs/node` hadir hanya untuk **melayani** build itu — `apps/storefront/server/penyaji.mjs` adalah server HTTP Bun yang ditulis tangan, menyerahkan request ke pencarian-berkas adapter dan mengatur header respons; tidak ada rute yang mendeklarasikan `prerender = false`, dan container yang berjalan tidak pernah membuka koneksi ke `apps/cms` atau basis datanya kapan pun setelah build selesai.

| | pengambilan statis saat build | pengambilan server-rendered saat runtime |
| --- | --- | --- |
| Keamanan | container tidak memegang token API, tidak ada jalur basis data — kompromi storefront tidak menjangkau data pelanggan | kredensial live dan jalur jaringan live ada di jalur request, setiap saat |
| Performa | setiap halaman adalah berkas statis; tidak ada round trip per-request ke `apps/cms` | satu atau lebih panggilan `apps/cms` per request |
| SEO | HTML ter-render penuh di byte pertama, URL kanonik stabil | sama, jika di-render server-side, tapi menambah ketergantungan live pada setiap crawl |
| Biaya operasional | gangguan `apps/cms` tidak membuat storefront turut mati | gangguan `apps/cms` adalah gangguan storefront |
| Kesegaran | harga dan stok hanya sesegar build terakhir | selalu terkini |

**Trade-off-nya dinyatakan terus terang, tidak disembunyikan:** harga dan stok hanya sesegar build terakhir. Untuk increment 1 — listing katalog dan detail produk, tanpa keranjang — itu trade-off yang tepat; harga basi di halaman yang belum bisa dimasukkan siapa pun ke keranjang tidak berbiaya apa-apa yang tidak bisa diperbaiki rebuild. Begitu checkout ada, stok dan harga butuh pembacaan runtime untuk menghindari kelebihan jual atau salah kutip — dan **itu harus menjadi perubahan yang disengaja dan diargumentasikan terpisah atas keputusan ini — bukan pengikisan** yang dimulai dengan menambahkan "cuma satu" panggilan runtime lalu berakhir dengan container diam-diam memegang kredensial live lagi.

Pengaturan build CSP-ketat menguatkan batas yang sama dari sudut berbeda: `compressHTML: true`, `build.inlineStylesheets: "never"`, dan `vite.build.assetsInlineLimit: 0` (`astro.config.mjs`) berarti tidak ada stylesheet, skrip, atau aset kecil yang pernah di-inline — semuanya dikirim sebagai berkas same-origin, sehingga CSP `apps/storefront/server/penyaji.mjs` (`style-src 'self'`, `script-src 'self'`, tanpa `'unsafe-inline'` di mana pun) tidak butuh pengecualian untuk tetap berlaku. `build.format: "file"` dan `trailingSlash: "never"` menjaga berkas yang dihasilkan dan URL yang dilayani identik byte-demi-byte (lihat [ADR-0005](0005-product-urls-match-the-live-sites-shape.md)), jadi tidak ada penulisan-ulang directory-index yang berdiri di antara apa yang di-build dan apa yang diindeks crawler.

## Konsekuensi

- Build yang tidak bisa menjangkau `apps/cms`, atau yang menerima envelope error, **gagal keras** (`awcmsGet` milik `apps/storefront/src/lib/awcms/client.ts` melempar pada respons non-2xx atau `{success: false}`, tanpa retry). Build statis bukan jalur request: mode kegagalan yang harus dihindari aplikasi ini adalah deploy *sukses* yang diam-diam mengirim katalog kosong atau basi, bukan build merah.
- `getProducts()` (`apps/storefront/src/lib/catalog.ts`) tambahan menolak untuk build jika `apps/cms` mengembalikan produk tapi tidak satu pun berstatus `"active"` — penalaran yang sama satu tingkat di atas: filter yang hanya bisa mempersempit katalog butuh batas bawah, karena build yang diam-diam mempublikasikan nol produk dengan setiap gate hijau lebih buruk daripada yang menyatakan alasannya.
- Tidak ada apa pun di increment ini yang membaca `apps/cms` saat runtime. Pembacaan stok runtime, pengecekan harga live, atau apa pun berbentuk keranjang secara eksplisit **belum dibangun** — lihat [`docs/arsitektur.md`](../arsitektur.md) dan [`docs/cms.md`](../cms.md) untuk daftar lengkap apa yang dikecualikan irisan ini.
