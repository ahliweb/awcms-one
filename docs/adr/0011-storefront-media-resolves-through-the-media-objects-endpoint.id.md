🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0011-storefront-media-resolves-through-the-media-objects-endpoint.md)

<!-- i18n-source-hash: sha256:d6979c9af3f8f7cda01db04a4f0ec83c912fc889d7a80406cb07a51005db7024 -->

# ADR-0011 — Storefront me-resolve media lewat `GET /api/v1/media/objects`, dan CSP-nya diturunkan dari apa yang benar-benar ter-resolve

- **Status:** Accepted
- **Tanggal:** 18 September 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** [ADR-0002](0002-static-output-with-build-time-fetch-for-the-storefront.id.md); issue #47, #53, #54, #59; `apps/cms/src/modules/media-library/README.md` §"Media reference resolution"

## Konteks

Increment 2 merilis permukaan berita **tanpa satu pun gambar**. Setiap field bermuatan media yang dikembalikan CMS — `featuredMediaId` sebuah pos, `mediaObjectId` sebuah item galeri, `thumbnailMediaObjectId` sebuah blok video, materi sebuah penempatan iklan — hanyalah id telanjang, dan `apps/storefront` tidak punya cara mengubahnya menjadi URL. `apps/storefront/src/lib/awcms/blog.ts` mencatat alasannya saat itu: menyusun `{origin}/{id}` berarti **mengarang** bentuk URL, yang dilarang aturan kontribusi repositori ini. Maka kartu, artikel, dan slot iklan menampilkan teks di tempat situs rujukan menampilkan foto.

`apps/cms` sudah punya permukaan yang hilang itu sejak Issue #615/#782-nya sendiri: `GET /api/v1/media/objects?ids=…` me-resolve sampai 100 id per panggilan, dijaga `media_library.media.read`, hanya mengembalikan objek `verified`/`attached` milik satu tenant, dan **melaporkan** id yang tak ter-resolve alih-alih membuangnya diam-diam.

## Keputusan

`apps/storefront` me-resolve setiap id media lewat endpoint itu pada waktu build (`apps/storefront/src/lib/awcms/media.ts`), dengan kredensial build memegang `media_library.media.read`, dan **menurunkan Content-Security-Policy-nya dari URL yang benar-benar ter-resolve**, bukan semata dari origin yang dikonfigurasi.

| | Mengarang `{origin}/{id}` | Mem-proxy gambar lewat `penyaji.mjs` | Resolve lewat `media/objects` (**dipilih**) |
| --- | --- | --- | --- |
| Kebenaran | menebak konvensi path yang tidak pernah dijanjikan CMS | benar | benar, dan id yang tak ter-resolve dilaporkan, bukan dibuang diam-diam |
| Keamanan | bisa membocorkan bentuk URL objek yang belum terbit | satu lompatan runtime yang harus mengotorisasi ulang setiap permintaan | hanya `verified`/`attached`, satu tenant, dijaga kredensial pada waktu build |
| Performa | nol saat build; gambar rusak bagi pembaca | satu lompatan per gambar pada setiap tampilan halaman, di situs statis | satu panggilan terkumpul, ter-chunk, ter-deduplikasi per build; gambar disajikan langsung dari origin media |
| Kompleksitas operasional | nol | tanggung jawab runtime baru pada server yang hari ini hanya menyajikan berkas | satu permission pada kredensial build |

## Konsekuensi

- Id disaring ke bentuk uuid **sebelum** dipanggil: route menjawab `400` untuk seluruh chunk bila ada satu id yang cacat, sehingga satu item galeri lawas bisa menggagalkan seluruh build.
- Artefak CSP (`apps/storefront/src/pages/csp.json.ts`, dikonsumsi `apps/storefront/server/penyaji.mjs`) bertambah `img-src` untuk origin setiap URL publik yang ter-resolve — bukan hanya origin media yang dikonfigurasi — sehingga baris yang masih menunjuk host media sebelumnya tetap tampil alih-alih diblokir. Video menambahkan `img-src https://i.ytimg.com` dan `frame-src https://www.youtube-nocookie.com`, dan hanya ketika build itu memang memuat pos video.
- Sematan YouTube adalah **facade klik-untuk-memuat**: poster dulu, `<iframe>` hanya setelah klik sungguhan, dan bawaan `renderPortableText` tetap tautan keluar biasa supaya halaman yang tidak memasang skrip facade (atau badan RSS) tidak pernah mengirim tombol mati.
- Klien yang sama melayani materi iklan issue #53, `og:image` #54, dan lambang lembaga #59; tidak ada bagian lain aplikasi ini yang butuh jalur media kedua.
