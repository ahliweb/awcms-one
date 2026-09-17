🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0008-one-commerce-module-carries-the-whole-store-not-three.md)

<!-- i18n-source-hash: sha256:865daeaf038fa7435a7760f06e318661eeba7427e4c25e5687b27dc07e38f83a -->

# ADR-0008 — Satu modul `commerce` membawa seluruh toko, bukan tiga

- **Status:** Diterima
- **Tanggal:** 16 September 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** [ADR-0001](0001-git-subtree-with-full-history-for-apps-cms.id.md) (Konsekuensi: 29 berkas bersama yang tersentuh admisi modul); [ADR-0007](0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.id.md); [issue #21](https://github.com/ahliweb/awcms-one/issues/21); issue #23, #26, #29; [`apps/cms/src/modules/commerce/README.md`](../../apps/cms/src/modules/commerce/README.id.md)

## Konteks

Increment 2 menambahkan kedalaman katalog (gambar, varian, tingkat harga), marketing (flash sale, voucher, slider, testimonial, popup, pengaturan toko) dan transaksi (pelanggan, order, pembayaran, review) ke `apps/cms`. Pertanyaannya adalah apakah itu tiga modul (`commerce`, `commerce_marketing`, `commerce_orders`) atau satu.

| | Tiga modul | Satu modul (**dipilih**) |
| --- | --- | --- |
| Pengiriman paralel | tiga agent bisa menyentuh tiga berkas `module.ts` — tapi setiap admisi tetap mengedit `apps/cms/src/modules/index.ts`, registry event, menu sidebar, coverage ledger, bundle OpenAPI, dan inventori yang sama yang dihasilkan (daftar 29-berkas milik ADR-0001, tiga kali) | Pekerjaan CMS diserialkan per wave; pekerjaan storefront dan ops berjalan di sampingnya |
| Maintainability | tiga edge `dependencies` di antara apa yang sebenarnya satu aggregate (order mereferensikan produk, varian, harga flash-sale, dan voucher) | satu bounded context, granularitas yang sudah dipakai `blog_content` (empat puluh berkas application di bawah satu key) |
| Keamanan | tiga namespace izin dengan aktor yang sama | satu namespace `commerce.*` untuk owner/admin; permukaan yang menghadap pelanggan bersifat anonim dan terikat-Origin (ADR-0007), jadi itu adalah tingkat kepercayaan berbeda berdasarkan keluarga rute, bukan berdasarkan modul |
| Data lifecycle / subject data | deskriptor terpecah di seluruh modul yang semuanya menjawab untuk pelanggan yang sama | satu registry menjawab "apa yang kita pegang tentang nomor telepon ini" |
| Jangka panjang | pemecahan di kemudian hari bersifat mekanis (tabel dan direktori sudah dikelompokkan per area) | penggabungan tiga modul di kemudian hari tidak |

## Keputusan

Semua tabel, direktori, rute, izin, event, job, dan layar admin commerce hidup di bawah satu key modul `commerce`, dikelompokkan per area di dalamnya (`domain/{catalog,marketing,orders}/…` adalah konvensi direktori, bukan batas modul). `dependencies` milik modul itu bertambah `media_library` (gambar produk) dan tidak ada lagi.

## Konsekuensi

- Issue CMS di epic ini digabungkan satu per satu; setiap PR meregenerasi inventori setelah PR sebelumnya mendarat (`bun run check` milik `apps/cms` menyebut setiap generator yang basi).
- [`README.md`](../../apps/cms/src/modules/commerce/README.id.md) milik modul `commerce` sendiri adalah peta modul dan ditulis ulang di setiap PR CMS epic ini — itu adalah deliverable, bukan follow-up. [`docs/skema-basis-data.md`](../skema-basis-data.id.md), [`docs/kamus-data.md`](../kamus-data.id.md), dan [`docs/cms.md`](../cms.id.md) milik repositori ini sendiri menautkannya alih-alih menduplikasinya field demi field.
