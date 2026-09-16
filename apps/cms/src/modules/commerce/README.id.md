🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](README.md)

<!-- i18n-source-hash: sha256:3a6c11280e2c6d262032a240a8ff05226e645bfd4649f97ca626a96c01408e0e -->

# `commerce`

Kategori produk (hierarkis, self-referencing) dan produk (dengan gambar dan
varian), tenant-scoped, di-port dari skema MySQL legacy
`commerce_bj_mart.{categories,products}` — ditambah, sejak Issue #26,
**permukaan pemasaran** yang menjalankan beranda dan promosi BjekMart: flash
sale, voucher, slider, testimoni, popup promo, dan satu dokumen pengaturan
toko per tenant. Issue #4 (bagian dari epic #1) mengirimkan inti katalog;
Issue #23 (bagian dari epic #21) membawanya ke paritas model produk penuh
dengan skema legacy; Issue #26 (epic yang sama) menambahkan tabel pemasaran.

| Aspek      | Nilai                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key / type | `commerce` · `domain`, `isCore: false`                                                                                                                                                                                                                                                                                                                                                                            |
| Tabel      | `awcms_commerce_categories`, `awcms_commerce_products` (`sql/153`, diperluas `sql/156`), `awcms_commerce_product_images`, `awcms_commerce_product_variants` (`sql/157`); `awcms_commerce_flash_sales`, `awcms_commerce_flash_sale_products`, `awcms_commerce_vouchers`, `awcms_commerce_sliders`, `awcms_commerce_testimonials`, `awcms_commerce_popups` (`sql/161`), `awcms_commerce_store_settings` (`sql/162`) |
| Permission | `categories.{read,create,update,delete,restore}`, `products.{read,create,update,delete,restore}` (`sql/154`, `sql/158`); `{flash_sales,vouchers,sliders,testimonials,popups}.{read,create,update,delete}`, `settings.{read,update}` (`sql/163`) — 32 total                                                                                                                                                        |
| API        | `/api/v1/commerce/{categories,products,flash-sales,vouchers,sliders,testimonials,popups,store-settings}` (`openapi/modules/commerce.openapi.yaml`)                                                                                                                                                                                                                                                                |
| Event      | `commerce.product.{created,updated,status_changed}`; `commerce.flash_sale.{started,ended}` (Issue #26, dipancarkan job tick)                                                                                                                                                                                                                                                                                      |
| Depends on | `tenant_admin`, `identity_access`, `domain_event_runtime`, `media_library` (gambar produk, slider, avatar testimoni, gambar popup, dan logo/favicon toko semuanya di-resolve lewat `MediaLibraryPort`)                                                                                                                                                                                                            |
| Job        | `commerce:flash-sales:tick` (`scripts/commerce-flash-sales-tick.ts`, tiap 5 menit — menyimpan status turunan tiap sale dan memancarkan dua event flash sale)                                                                                                                                                                                                                                                      |

## Apa yang ditambahkan Issue #23, dan apa yang masih peningkatan berikutnya

Irisan Issue #4 mengambil inti katalog (`categoryId`, `type`, `sku`, `name`,
`slug`, `description`, `digitalNote`, `price`, `discountPercent`, `stock`,
`status`, `label`, `labelColor`) dan menunda sisa field tabel `products`
legacy. Issue #23 mengirimkan setiap field yang ditunda itu:

- **Harga bertingkat & biaya**: `priceLevel2/3/4` (string `numeric(14,2)`
  nullable), `costPrice` (bentuk sama, **admin-only** — lihat di bawah).
- **Inventori & pengiriman**: `minPurchase` (`>= 1`), `weightGrams`,
  `allowDp`, `allowFreeShipping`.
- **Merchandising**: `isFeatured`, `isRecommended` — flag eksplisit yang
  menggantikan heuristik ad-hoc `featuredProducts`/`recommendedProducts`
  milik BjekMart; `manualRating`/`manualSoldCount`, diekspos di DTO sebagai
  `averageRating`/`soldCount` sampai Issue #29 mengirimkan review/order
  sungguhan.
- **Asuransi**: `withInsurance`, `insuranceRequired`, `insuranceFee`.
- **Promo banner**: `promoBannerShow` plus title/subtitle/badge/icon/color.
- **Size chart**: `sizeChartType` (`none`/`image`/`table`),
  `sizeChartMediaId` (wajib saat `image`), `sizeChartDetails` (`jsonb`, wajib
  saat `table`) — aturan cross-field-nya hidup di `reconcileSizeChart` milik
  `domain/size-chart.ts`, dipanggil dari validator create (terhadap nilai
  yang sudah di-default) maupun `updateProduct` (terhadap baris yang
  DIGABUNG dengan patch), dan dicerminkan sebagai `CHECK` kasar di
  `sql/156`. `sizeChartMediaId` hanya divalidasi bentuk UUID-nya, tidak
  diperiksa keberadaannya — lihat "Apa yang masih TIDAK diperiksa" di bawah.
- **Form intake service**: `serviceForm` (`jsonb`,
  `domain/service-form-validation.ts`) — array deskriptor field
  `{id, type, label, required, options}` untuk form booking sebuah produk
  `type: "service"`. Divalidasi bentuknya, disimpan apa adanya; tak ada yang
  me-render-nya di sisi server.
- **Langganan / digital**: `subscriptionPeriod`
  (`day`/`week`/`month`/`year`, secara deskriptif terkait `type:
"subscription"` tapi tidak divalidasi silang — kolom BjekMart sendiri
  membawa nilai yang independen dari `type`), `downloadLink`.
- **Atribut varian**: `variantAttributes` (`jsonb`,
  `domain/variant-attributes-validation.ts`) — kumpulan grup atribut/opsi
  yang DIDEKLARASIKAN merchant (mis. `[{name: "Size", options: [{name:
"M"}, {name: "L"}]}]`). Metadata deskriptif, bukan constraint yang
  ditegakkan terhadap baris varian sungguhan.
- **Restore**: `restoredAt` di kedua tabel — lihat "Restore" di bawah.

**`costPrice` tidak pernah sampai ke response publik.**
`application/product-directory.ts` menjaga dua mapper atas baris yang sama:
`toRecord` (DTO publik `ProductRecord`/`CommerceProduct` — tanpa
`costPrice`) dan `toAdminRecord` (`ProductAdminRecord`, `costPrice`
disertakan) — hanya dipakai oleh fetch milik
`src/pages/admin/commerce.astro` sendiri. Sistem tipe yang membuat janji
itu, bukan konvensi yang harus diingat setiap rute.

## Uang adalah `numeric(14,2)`, dan melintasi wire sebagai string

Prinsip tak berubah dari Issue #4, kini mencakup lebih banyak kolom:
`price`, `priceLevel2/3/4`, `costPrice`, `insuranceFee`, dan `finalPrice`
yang dihitung semuanya `numeric(14,2)`, tak pernah float — `Bun.SQL`
mengembalikan masing-masing sebagai STRING, dan tak ada kode di modul ini
yang mem-parsingnya menjadi `number`. `finalPrice` (`price` setelah dipotong
`discountPercent`) dihitung di sisi server di
`domain/price-calculation.ts`, seluruhnya dalam satuan SEN via `BigInt` —
`"19.10"` pada diskon 10% menjadi `"17.19"`, tak pernah
`17.189999999999998`. `discountPercent`, `stock`, `minPurchase`,
`weightGrams`, dan `manualSoldCount` adalah `integer` biasa: bukan uang, dan
eksak di floating point.

## Dua sumbu independen: `status` dan soft delete

Tak berubah dari Issue #4. Status siklus hidup produk (`draft` →
`active`/`archived`, `active` ⇄ `inactive`, keduanya → `archived`,
`archived` → `draft` saja — `LEGAL_TRANSITIONS` milik
`domain/product-status.ts`) dan apakah baris itu soft-deleted (`deleted_at`)
dengan sengaja dipisah. Menarik produk dari penjualan tanpa kehilangan
recordnya adalah `status = 'inactive'`; menghapusnya dari tampilan katalog
tenant adalah `deleted_at`. Masih tak ada endpoint transisi-status khusus —
`status` melintas lewat `PATCH /api/v1/commerce/products/{id}` yang sama
dengan field lain, diperiksa `updateProduct` sebelum tulisan apa pun.

## Hierarki, dan ongkos re-parenting

Tak berubah: `parentId` self-referencing dan hanya ditetapkan saat pembuatan
(`CreateCategoryInput`); `UpdateCategoryInput` sama sekali tidak
membawanya. Memindahkan kategori ke parent baru karena itu adalah "hapus
lalu buat ulang", keterbatasan yang sama yang diterima
`office-directory.ts` untuk `parentOfficeId`. Kategori yang `parentId`-nya
menyebut baris tenant lain, id yang tidak ada, atau yang sudah soft-deleted
ditolak secara identik (400, `ParentCategoryNotFoundError`) — ketiga
penyebabnya sengaja tak terbedakan (bentuk yang sama dengan
GHSA-r7cx-c4jh-cvvw). `products.categoryId` mendapat perlakuan sama, dan tak
seperti parent kategori, ia BISA ditetapkan ulang lewat update.

## Restore (Issue #23)

Kedua tabel kini punya kolom `restored_at timestamptz` (milik kategori
tidak ada di tabel kolom Issue #23 sendiri, yang hanya mendaftarkannya
untuk produk — ditambahkan di sini demi simetri: endpoint restore kategori
butuh fakta "kapan" yang sama, dan `awcms_offices` adalah preseden modul ini
untuk kedua tabel). Tak seperti offices, kedua tabel tidak mendapat
`deleted_by`/`delete_reason`/`restored_by` — tabel modul ini sama sekali
tidak membawa kolom actor-stamp (pilihan asli Issue #4, tak berubah); SIAPA
yang me-restore sebuah baris adalah `actorTenantUserId` milik log audit
sendiri.

`POST /api/v1/commerce/{categories,products}/{id}/restore` mengikuti bentuk
`office-directory.ts`: 404 saat id sedang tidak soft-deleted (aman-idempoten
— restore berulang adalah 404, tak pernah duplikat), 409 saat baris hidup
lain sudah memakai slug yang sama (kategori, produk) atau sku yang sama
(produk). `restore` adalah permission-nya SENDIRI di kedua activity code —
tak seperti `offices/[id]/restore.ts` yang memakai ulang `.update`, supaya
kebijakan masa depan bisa memberikan salah satu tanpa yang lain; lihat
header `domain/commerce-permissions.ts`.

## Domain event: hanya produk, tiga event — tak berubah

Kategori masih tidak mempublikasikan apa pun. Produk masih mempublikasikan
persis tiga yang didefinisikan Issue #4
(`created`/`updated`/`status_changed`) — Issue #23 tidak menambah tipe event
baru, dan CRUD gambar/varian juga tidak mempublikasikan event (pilihan yang
sama "soft delete/perubahan sub-resource adalah fakta log audit, bukan
event katalog" yang sudah diambil delete milik kategori sendiri). Satu
`PATCH` yang mengubah field biasa maupun `status` sekaligus tetap
mempublikasikan keduanya secara independen.

## Keunikan

`(tenant_id, slug)` tetap unik per tabel di antara baris HIDUP; produk
tambahan menegakkan `(tenant_id, sku)`. **Baru di Issue #23**: `sku` sebuah
varian, saat ditetapkan, harus unik terhadap BAIK
`awcms_commerce_products` MAUPUN `awcms_commerce_product_variants` di
tenant tersebut — indeks unik parsial satu-tabel tidak bisa menyatakan
aturan lintas-tabel itu, jadi `checkVariantSkuAvailable` milik
`application/product-variant-directory.ts` memeriksa kedua tabel SEBELUM
setiap INSERT/UPDATE (urutan krusial, aturan yang sama dengan setiap
pemeriksaan keberadaan sebelum-tulis lain di modul ini), dan indeks unik
parsial DB pada `awcms_commerce_product_variants` sendiri tetap menjadi
jaring pengaman race satu-tabel. Benturan muncul sebagai `409
VARIANT_SKU_ALREADY_EXISTS`.

## Gambar dan varian (Issue #23)

`awcms_commerce_product_images` (`media_object_id NOT NULL` — baris ITU
SENDIRI adalah referensinya) dan `awcms_commerce_product_variants` dimiliki
sebuah produk dan diedit melaluinya:
`POST/PATCH/DELETE /api/v1/commerce/products/{id}/images` (`+ /{imageId}`)
dan `.../variants` (`+ /{variantId}`), semuanya ber-gate pada
`products.update` — sub-resource dari mengedit sebuah produk, bukan
resource dengan audiensnya sendiri.

`mediaObjectId` sebuah gambar produk DIPERIKSA keberadaan
hidup/terverifikasi/tenant-yang-sama sebelum insert —
`MediaLibraryPort.isMediaReferenceSafe`, kapabilitas yang sama yang
dikonsumsi `blog_content`, disuntikkan di rute (pola composition-root: rute
mengimpor `mediaLibraryPortAdapter`, `application/` tak pernah mengimpor
`media_library` langsung). Response `GET` (list/detail/by-slug)
me-resolve setiap `mediaObjectId` gambar (dan `imageMediaObjectId` opsional
milik sebuah varian) menjadi `publicUrl`/`imageUrl` dalam SATU panggilan
`resolveMediaReferences` yang di-batch per response — tak pernah N+1 —
lewat `attachProductRelations` milik `product-directory.ts`.

### Apa yang masih TIDAK diperiksa

- **`sizeChartMediaId` (produk) dan `imageMediaObjectId` (varian) hanya
  divalidasi bentuk UUID-nya** — tidak diperiksa keberadaan
  hidup/terverifikasi seperti `mediaObjectId` sebuah baris gambar. Id yang
  basi atau asing cukup me-resolve menjadi tanpa `publicUrl` saat render
  (RLS tetap menjaga id lintas-tenant tak pernah me-resolve ke media tenant
  lain); pengurangan cakupan yang disengaja, dicatat untuk #31, bukan celah
  keamanan — setiap referensi tetap terisolasi per-tenant.
- **Keyset pagination tetap terbatas pada `sort=newest`.**
  `?sort=price_asc`/`price_desc`/`name` mengembalikan satu halaman terbatas
  (`PRODUCT_LIST_LIMIT` = 100, `nextCursor: null`) alih-alih walk keyset
  yang diurutkan kolom kedua — lihat header `domain/product-sort.ts`.
- **`price_level_n <= price` tidak ditegakkan** — BjekMart membiarkan harga
  distributor melebihi harga eceran, jadi modul ini tidak
  mempertanyakannya.

## Permukaan pemasaran (Issue #26)

Enam keluarga resource, satu per layar admin, semuanya mengikuti konvensi
katalog (RLS `FORCE`, soft delete lewat `deleted_at`, uang sebagai string
`numeric(14,2)`, daftar pemilik ber-keyset, event audit pada tiap mutasi)
dan masing-masing punya **read model publik** — endpoint yang dipakai
`apps/storefront` (di `ahliweb/awcms-one`) untuk membangun berandanya,
dijaga permission `read` keluarganya dan hanya mengembalikan apa yang boleh
dilihat pembeli:

| Keluarga        | Rute pemilik                                                        | Read model publik                       | Yang disembunyikan read model                                                                        |
| --------------- | ------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Flash sale      | `/flash-sales`, `/{id}`, `/{id}/products`, `/{id}/products/{rowId}` | `GET /flash-sales/active`               | sale draft dan yang sudah berakhir; `status` DITURUNKAN dari jendela (`domain/flash-sale-status.ts`) |
| Voucher         | `/vouchers`, `/{id}`, `POST /vouchers/validate`                     | `GET /vouchers/public`                  | kode non-publik, yang nonaktif, kuota habis — kode privat tetap BERLAKU bila diketik                 |
| Slider          | `/sliders`, `/{id}`                                                 | `GET /sliders/active`                   | baris nonaktif, baris di luar jendelanya; id media menjadi URL ter-resolve                           |
| Testimoni       | `/testimonials`, `/{id}`                                            | `GET /testimonials/active`              | baris nonaktif                                                                                       |
| Popup           | `/popups`, `/{id}`                                                  | `GET /popups/active` (satu atau `null`) | paling banyak SATU aktif per tenant — partial unique index (`sql/161`), bukan konvensi               |
| Pengaturan toko | `GET`/`PUT`/`DELETE /store-settings`                                | `GET /store-settings/public`            | nomor dan pemilik rekening bank, id media QRIS, aturan diskon level pelanggan                        |

**Aritmetika voucher eksak** (`domain/voucher-arithmetic.ts`): sen bulat,
pembulatan setengah ke atas, persentase dibatasi `maxDiscount`,
`free_shipping` berupa flag bukan nominal; `POST /vouchers/validate` adalah
BACA — penebusan milik order yang memakai kodenya (Issue #29). **Status flash
sale diturunkan**, tidak pernah dipercaya dari kolom: editor menyetel
`draft`/`scheduled` dan `commerce:flash-sales:tick` menyimpan apa yang
disiratkan `now()`, memancarkan `commerce.flash_sale.{started,ended}` pada
transisi dan tidak pernah dua kali.

**Pengaturan toko adalah satu dokumen `jsonb` berversi per tenant**
(`domain/store-settings-validation.ts`, kunci tak dikenal ditolak, `PUT`
adalah penggantian penuh). `DELETE` berarti "reset ke bawaan": ia mencap
`deleted_at` alih-alih menghapus singleton (header `sql/162`), setiap pembaca
lalu menjawab dengan bawaan, dan `PUT` berikutnya menghapus capnya — itu pula
yang membuat baris ini menjawab pertanyaan retensi dengan kolom sungguhan,
bukan pengecualian. Proyeksi publik (`toPublicRecord` di
`application/store-settings-directory.ts`) adalah batas keamanan rekening
bank: hanya ada pada `GET` pemilik, dan event audit perubahan menyebut
BAGIAN yang berubah, tidak pernah nilainya.

**Uang di wire selalu dua desimal.** `Bun.SQL` mendekode `0.00` tersimpan
sebagai `"0"` lewat query berparameter dan `"0.00"` lewat query sederhana;
setiap `toRecord` di modul ini kini melewatkan uang lewat `normalizeMoney`
milik `domain/price-calculation.ts` agar kontrak tidak bergantung pada
protokol mana yang kebetulan melayani barisnya.

**Yang keluar dari DTO produk publik di issue ini:** `downloadLink` — aset
berbayar produk digital, kini di `ProductAdminRecord` di samping `costPrice`
dan hanya diserahkan lewat jalur order (Issue #29). **Yang masuk:**
`sizeChartImageUrl`, di-resolve lewat batch media yang sama dengan `images[]`.

## Layar admin: delapan, CRUD penuh (Issue #23 dan #26)

`/admin/commerce` (`src/pages/admin/commerce.astro`) — filter
(`categoryId`/`status`/`q`/`featured`/`recommended`), form buat yang
mencakup setiap field inti plus flag merchandising umum, edit inline
per-baris untuk field inti, editor "Advanced fields (JSON)" untuk ekor
panjang kolom paritas (harga bertingkat, asuransi, promo banner, size
chart, form service, langganan/digital, atribut varian — kompresi yang
disengaja: tiga puluh kontrol individual akan membanjiri layar, dan ini
menjaga setiap field tetap benar-benar bisa diedit tanpa itu), pemilih
gambar bersumber dari registry `media_library`, editor varian, transisi
status, soft delete, dan restore.

`/admin/commerce-categories` (baru) — CRUD kategori: buat dengan parent,
edit inline (name/slug — `parentId` hanya-saat-buat, lihat "Hierarki" di
atas), soft delete, restore.

Kedua layar sudah keluar dari `NOT_YET_SCREENED` milik
`scripts/admin-screen-coverage-ledger.ts` — setiap satu dari sepuluh
permission yang dideklarasikan (lima per activity code, termasuk
`restore`) diklaim salah satu dari dua layar.

Issue #26 menambahkan `/admin/commerce-flash-sales`, `-vouchers`, `-sliders`,
`-testimonials`, `-popup`, dan `-settings`, masing-masing daftar + form buat +
edit/hapus per baris terhadap rute pemiliknya (layar pengaturan adalah satu
form dengan aksi "reset ke bawaan"). Kedelapan layar lepas dari
`NOT_YET_SCREENED` — setiap satu dari 32 permission yang dideklarasikan
diklaim salah satunya, dan
`tests/admin-commerce-marketing-page-contract.test.ts` menuntut enam layar
baru itu pada tiga sifat yang sama dengan layar #23.

## Dengan sengaja tidak ada di sini

- **Tidak ada permukaan cart/checkout/payment/order/shipping/affiliate-link**
  — Issue #29 menambahkan pelanggan, order, dan endpoint storefront anonim.
- **Tidak ada restore untuk tabel pemasaran.** Hanya soft delete; voucher
  atau slider yang dihapus dibuat ulang, bukan dikembalikan — jejak audit
  menyimpan catatannya.
- **Tidak ada penebusan voucher.** `validate` membaca; order yang memakai
  kode menebusnya (Issue #29), dan `used_count` bergerak di sana.
- **Tidak ada ranking relevansi full-text pada `q`.** Pencocokan
  trigram/`ILIKE` (`sql/159`) adalah pencarian substring, bukan indeks
  pencarian ber-ranking — `site_search` adalah modul pencarian
  lintas-konten base ini, dan `commerce` tidak berintegrasi dengannya di
  peningkatan ini.
