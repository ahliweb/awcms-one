🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0049-install-metadata-is-derived-at-build-time-and-the-ios-help-page-is-opt-in.md)

<!-- i18n-source-hash: sha256:addd34edcabdacfac6fd41425c5ef21021dcf548f99c7e07563cea234b2a6170 -->

# ADR-0049 — Metadata instalasi diturunkan saat build, dan halaman bantuan instalasi iOS bersifat opt-in

- **Status:** Accepted
- **Tanggal:** 18 Oktober 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** issue [#428](https://github.com/ahliweb/awcms-one/issues/428); [ADR-0002](0002-static-output-with-build-time-fetch-for-the-storefront.md) (output statis); [ADR-0018](0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md) (template, profil, dan apa yang ditulis ulang `template:init`); langganan push dimiliki [#429](https://github.com/ahliweb/awcms-one/issues/429), [#430](https://github.com/ahliweb/awcms-one/issues/430) dan [#431](https://github.com/ahliweb/awcms-one/issues/431), bukan ADR ini

## Konteks

`/manifest.webmanifest` sudah ada sejak issue #24 dengan satu ikon SVG, tanpa `id`, nama yang disalin dari identitas situs, dan tanpa metadata iOS. iOS 16.4 ke atas menjalankan situs yang ditambahkan ke Layar Utama sebagai aplikasi web mandiri, dan hanya bentuk itu yang bisa menerima web push, sehingga storefront yang dapat dipasang, bermerek, dan beridentitas benar adalah prasyarat issue push. Tiga pertanyaan perlu jawaban yang awet karena setiap repo turunan mewarisinya: dari mana ikon PNG berasal tanpa membuat `template:init` menulis ulang berkas biner, apa identitas aplikasi yang terpasang, dan bagaimana halaman bantuan opsional ada tanpa membebani build yang tidak menginginkannya.

## Keputusan

**D1 — Manifest diperluas, tidak pernah digandakan.** Satu manifest, dibangun fungsi murni `buildManifest()` di `apps/storefront/src/lib/pwa-manifest.ts`, disajikan `manifest.webmanifest.ts` yang sudah ada. Ia mendapat `id`, `lang`, `categories`, dan ikon PNG; `name` dan `short_name` tetap berasal dari `getSiteIdentity()` (CMS, `SITE_NAME`, atau `DEFAULT_IDENTITY` yang ditulis ulang `template:init`), sehingga tidak ada yang khusus BjekMart ditambahkan ke template generik.

**D2 — `id` adalah `"/"`, `scope` dan `start_url` adalah `"/"`.** Id diresolusi terhadap origin, jadi dua situs, profil, atau tenant adalah aplikasi terpasang yang berbeda karena origin-nya berbeda; membuatnya tidak bergantung pada `start_url` dan profil berarti perubahan keduanya kelak tidak membuat instalasi yang ada yatim. Semuanya tetap di origin storefront. Aplikasi ini tidak mendaftarkan service worker; CMS memegang PWA `/admin` dan `/push-sw.js` sendiri di origin-nya, dan service worker tidak pernah didaftarkan lintas origin.

**D3 — Ikon PNG dibuat saat build dari huruf pertama nama situs dan warna primer tema.** `apps/storefront/src/lib/pwa-ikon.ts` adalah encoder PNG tanpa dependensi; `/icons/icon-192.png`, `/icons/icon-512.png`, `/icons/icon-maskable-512.png` dan `/apple-touch-icon.png` adalah endpoint yang diprarender. Opsi yang dipertimbangkan:

| Opsi | Putusan |
| --- | --- |
| Commit PNG hasil rasterisasi `favicon.svg` | Ditolak: `template:init` tidak bisa merasterisasi, sehingga repo turunan mengirim tanda BjekMart sampai seseorang menggantinya manual. |
| Menambah pustaka gambar (misalnya `sharp`) untuk merasterisasi SVG | Ditolak: dependensi build native dan permukaan rantai pasok baru untuk empat berkas kecil. |
| **Menurunkan dari `identity.name` dan `theme.primary`** | **Dipilih:** keduanya sudah ditulis ulang `template:init` atau diatur CMS, jadi tidak ada target tulis-ulang baru dan tidak ada yang terlupa. Imbalannya tanda huruf-di-atas-warna, bukan logo; deployment yang ingin seninya sendiri mengganti endpoint ikon. |

Ikon `maskable` dan Apple berukuran penuh (iOS mewarnai piksel transparan hitam dan membulatkan sudutnya sendiri); ikon `any` bersudut bulat transparan.

**D4 — Metadata iOS adalah markup `<head>` statis di `BaseLayout.astro`:** `apple-touch-icon`, `theme-color`, `mobile-web-app-capable`, `apple-mobile-web-app-capable`, `apple-mobile-web-app-title` (`short_name` manifest) dan `apple-mobile-web-app-status-bar-style=default`. Tanpa skrip, tanpa efek CSP.

**D5 — Halaman bantuan instalasi berada di balik `PUBLIC_INSTALL_HELP`, mati secara bawaan.** Hanya `1`, `true`, `on`, atau `yes` yang eksplisit menyalakannya, dibaca saat build di `apps/storefront/src/lib/pasang-aplikasi.ts`. Saat menyala, `integrations/profil.mjs` menyuntikkan `/pasang-aplikasi` dari `src/install/` (di luar `src/pages/`, sehingga hanya dirutekan saat menyala), footer menautkannya, dan satu modul same-origin mendeteksi mode standalone. Saat mati, semua itu tidak ada: tanpa rute, tautan, skrip, atau entri sitemap, dan artefak CSP identik di kedua kondisi (skripnya same-origin). Halaman ini `noindex` dan sengaja tidak ada di `ROUTES`, sehingga tidak masuk navigasi, sitemap, atau matriks profil. Ia tidak pernah meminta izin dan tidak pernah berlangganan push; ia menyatakan bahwa tab browser tidak bisa menerima notifikasi setelah ditutup.

## Konsekuensi

- Setiap profil (`toko`, `berita`, `landing`) mengirim manifest valid dan PNG nyata; `tests/pwa-manifest*.test.ts` dan suite e2e mengunci hal itu.
- Deployment tidak bisa mendapat ikon logo tanpa mengganti endpoint ikon; favicon unggahan CMS (`faviconMediaId`) tetap tidak diresolusi saat build, seperti sebelumnya.
- Flag ini pilihan build per deployment, seperti `PUBLIC_GA_ID`; menyalakannya perlu build ulang.
- Perilaku perangkat nyata (instalasi Layar Utama iOS, prompt instal Chrome) diverifikasi manual; suite otomatis mencakup kontrak, bukan platformnya.
