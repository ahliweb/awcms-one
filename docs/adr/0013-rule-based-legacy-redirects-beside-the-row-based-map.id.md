🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0013-rule-based-legacy-redirects-beside-the-row-based-map.md)

<!-- i18n-source-hash: sha256:b211ddb54b5ed131d23ead7cf1df365674c1111a5e76b54d7d0ffb6245db8dd6 -->

# ADR-0013 — Pengalihan lawas berbasis aturan berdampingan dengan peta berbasis baris, dan baris selalu menang

- **Status:** Accepted
- **Tanggal:** 18 September 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** [ADR-0005](0005-product-urls-match-the-live-sites-shape.id.md); issue #55, #58, #75; `docs/routing.id.md`

## Konteks

Increment 2 mengalihkan URL lawas dari **baris**: satu entri `awcms_seo_redirects` per URL, dipanggang ke dalam build (`/index/pengalihan-legacy.json`) dan dicari oleh `apps/storefront/server/penyaji.mjs`. Itu tepat untuk sebuah artikel, yang id numerik lamanya memetakan ke slug baru lewat fakta yang tak bisa diturunkan siapa pun — tetapi bentuk lawas seputarborneo yang lain justru kebalikannya. Arsip rubrik, daerah, dan Mitra Borneo-nya, dua halaman statisnya, serta kotak pencariannya mengikuti pola terbatas dan deterministik yang justru sudah dikodekan `include/nav_menu.php` sebagai tabel pencarian: 14 kabupaten/kota, 24 lembaga, segelintir rubrik. Menyemai satu baris per URL berarti ratusan baris untuk tautan yang selamanya ter-resolve sama.

## Keputusan

Sebuah modul murni berbasis tabel (`apps/storefront/server/pengalihan-aturan.mjs`) me-resolve bentuk-bentuk itu tanpa satu pun baris CMS, dan `legacyRedirectLocation()` menanyainya **hanya setelah** peta baris meleset.

| | Baris untuk semuanya | Aturan untuk semuanya | Baris dulu, aturan kemudian (**dipilih**) |
| --- | --- | --- | --- |
| Id artikel | benar (fakta tersimpan) | mustahil diturunkan | benar |
| URL arsip | ratusan baris seed untuk dipelihara | satu tabel, tanpa data | satu tabel, tanpa data |
| Konflik | — | — | fakta yang ditulis operator mengalahkan tebakan turunan |
| Keteruji-an | butuh CMS yang di-seed | fungsi murni | fungsi murni plus uji baris yang sudah ada |

## Konsekuensi

- Dua ruang id numerik yang **berbeda** dijaga tetap terpisah: `berita_red.id_ber` di balik `/news/{id}-…` dan `berita_vid.id_vid` di balik `/video/?video={id}-…`. Keduanya diindeks terpisah; mencampurnya mengirim URL video ke artikel yang tak berhubungan.
- CMS membuang query string dari path **sumber** sebuah pengalihan, jadi baris video disimpan di bawah kunci sintetis bebas-query `/video/{id}-{slug}.html`; exporter (#58) menulis bentuk itu dan modul aturan menerima keduanya, termasuk bentuk historis `?video=`.
- Peta baris pada waktu build me-resolve slug pos video ke `/video/{slug}`, tidak pernah `/berita/{slug}` — satu URL kanonik per pos, sebagaimana `getPosts()`/`getVideo()` sudah memisahkannya.
- Pencarian dialihkan dengan `302`, bukan `301`: itu kueri, bukan dokumen yang pindah.
- Jebakan terkait yang lain ditemukan dan diperbaiki dengan cara sama (#75): di bawah `build.format: "file"`, halaman landing yang juga punya anak dipancarkan sebagai berkas **di samping** direktori bernama sama, dan adapter node menulis ulang path berbentuk direktori menjadi `index.html` yang tidak ada. `apps/storefront/server/penyaji.mjs` menemukan halaman terbayangi itu sekali saat startup dan menulis ulangnya ke `{path}.html` sebagai langkah terakhir sebelum adapter — setelah kedua lapisan pengalihan, sehingga tidak ada pengalihan yang bisa terbayangi olehnya.
