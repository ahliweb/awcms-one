🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](README.md)

<!-- i18n-source-hash: sha256:2802375d4623caf9a34604b5cb1c1c706103510ffeca04cdabfe4614abd06f84 -->

# `commerce`

Kategori produk (hierarkis, self-referencing) dan produk (dengan gambar dan
varian), tenant-scoped, di-port dari skema MySQL legacy
`commerce_bj_mart.{categories,products}` — ditambah, sejak Issue #26,
**permukaan pemasaran** yang menjalankan beranda dan promosi BjekMart: flash
sale, voucher, slider, testimoni, popup promo, dan satu dokumen pengaturan
toko per tenant — dan, sejak Issue #29, **pelanggan, order, dan review**:
guest checkout yang tak pernah mewajibkan akun, cart quote yang menghitung
ulang harga di sisi server, pelacakan dan pembatalan order lewat `orderCode`

- nomor telepon, konfirmasi pembayaran manual, dan review yang ditinggalkan
  dari order yang sudah selesai. Issue #4 (bagian dari epic #1) mengirimkan
  inti katalog; Issue #23 (bagian dari epic #21) membawanya ke paritas model
  produk penuh dengan skema legacy; Issue #26 (epic yang sama) menambahkan
  tabel pemasaran; Issue #29 (epic yang sama) menambahkan pelanggan, order,
  dan permukaan checkout storefront anonim.

| Aspek      | Nilai                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key / type | `commerce` · `domain`, `isCore: false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Tabel      | `awcms_commerce_categories`, `awcms_commerce_products` (`sql/901`, diperluas `sql/904`), `awcms_commerce_product_images`, `awcms_commerce_product_variants` (`sql/905`); `awcms_commerce_flash_sales`, `awcms_commerce_flash_sale_products`, `awcms_commerce_vouchers`, `awcms_commerce_sliders`, `awcms_commerce_testimonials`, `awcms_commerce_popups` (`sql/909`), `awcms_commerce_store_settings` (`sql/910`); `awcms_commerce_customers`, `awcms_commerce_customer_addresses`, `awcms_commerce_orders`, `awcms_commerce_order_items`, `awcms_commerce_order_events`, `awcms_commerce_payment_confirmations`, `awcms_commerce_reviews`, `awcms_commerce_wishlists` (`sql/913`); `awcms_commerce_customer_accounts`, `awcms_commerce_customer_otps`, `awcms_commerce_customer_sessions` (`sql/917`-`918`); baris `derived.commerce_customer_otp` di `awcms_email_templates`, di-seed per tenant yang ada (`sql/919`); `awcms_commerce_affiliates`, `awcms_commerce_affiliate_commissions`, plus `orders.affiliate_id`/`store_settings.affiliate_commission_rate` (`sql/921`) |
| Permission | `categories.{read,create,update,delete,restore}`, `products.{read,create,update,delete,restore}` (`sql/902`, `sql/906`); `{flash_sales,vouchers,sliders,testimonials,popups}.{read,create,update,delete}`, `settings.{read,update}` (`sql/911`); `orders.{read,update}`, `customers.{read,update}`, `reviews.{read,update,delete}` (`sql/914`, dengan sengaja tanpa create/delete untuk orders atau customers — lihat "Pelanggan, order, dan review" di bawah); `affiliates.{read,update}`, `affiliate_commissions.{read,update}` (`sql/922`, alasan sama tanpa create/delete) — 43 total                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| API        | `/api/v1/commerce/{categories,products,flash-sales,vouchers,sliders,testimonials,popups,store-settings,orders,customers,reviews,affiliates,affiliates/{id},affiliate-commissions,affiliate-commissions/{id}/{approve,pay,void}}` (sisi pemilik); `/api/v1/commerce/storefront/{cart/quote,orders,reviews}` (sisi anonim, `orders`/`reviews` juga menerima `customerBearer` OPSIONAL, Issue #91); `/api/v1/commerce/storefront/account/{otp/request,otp/verify,me,logout}` (OTP anonim + `customerBearer`, Issue #89); `/api/v1/commerce/storefront/account/{addresses,addresses/{id},addresses/{id}/default,wishlist,wishlist/{productId},orders,orders/{orderCode},reviews,affiliate,affiliate/commissions}` (`customerBearer`, Issue #91/#92) (`openapi/modules/commerce.openapi.yaml`)                                                                                                                                                                                                                                                                                       |
| Event      | `commerce.product.{created,updated,status_changed}`; `commerce.flash_sale.{started,ended}` (Issue #26, dipancarkan job tick); `commerce.order.{created,paid,status_changed,cancelled,expired}`, `commerce.voucher.redeemed`, `commerce.review.published` (Issue #29)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Depends on | `tenant_admin`, `identity_access`, `domain_event_runtime`, `media_library` (gambar produk, slider, avatar testimoni, gambar popup, dan logo/favicon toko semuanya di-resolve lewat `MediaLibraryPort`), `module_management` (resolver tenant storefront anonim memeriksa modul ini aktif untuk tenant tersebut sebelum menjawab), `profile_identity` (penyamaran e-mail/telepon), `email` (Issue #89 — adapter `email` pada channel OTP pelanggan mengantre ke outbox `email` sendiri)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Job        | `commerce:flash-sales:tick` (`scripts/commerce-flash-sales-tick.ts`, tiap 5 menit — menyimpan status turunan tiap sale dan memancarkan dua event flash sale); `commerce:orders:expire` (`scripts/commerce-orders-expire.ts`, tiap 5 menit — mengekspirasi order belum-bayar yang melewati jendela terkonfigurasi toko, me-restock lini pesanannya, dan memancarkan `commerce.order.expired`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

**Migrasi hidup di rentang cadangan `901`–`999`, bukan `001`–`899` milik upstream (issue #72, [ADR-0015](../../../../../docs/adr/0015-commerce-migrations-live-in-the-reserved-9xx-range.id.md) di awcms-one).** Enam belas migrasi asli modul ini, bernomor 153 sampai 168, bertabrakan dengan penomoran `ahliweb/awcms` upstream sendiri begitu ia mulai memakai nomor yang sama untuk migrasinya sendiri (`sql/153_awcms_blog_institution_logo.sql`, issue #59). Keenam belasnya diberi nomor ulang jadi `sql/901_awcms_commerce_schema.sql` sampai `sql/916_awcms_commerce_orders_expire_worker_write_grants.sql` (offset +748); migrasi commerce berikutnya adalah `917`. `tests/commerce-migrations-range.test.ts` menegakkan pemisahan ini dua arah. Basis data yang bermigrasi sebelum rename ini menjalankan `bun run db:commerce:renumber` sekali, sebelum `bun run db:migrate` berikutnya (`scripts/commerce-migrations-renumber.ts`).

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
  `averageRating`/`soldCount` — review dan hitungan lini order sungguhan
  milik Issue #29 TIDAK mengalir balik ke kedua kolom ini; keduanya tetap
  nilai seed yang dimasukkan merchant, dan merekonsiliasikannya dengan
  aktivitas sungguhan adalah peningkatan berikutnya.
- **Asuransi**: `withInsurance`, `insuranceRequired`, `insuranceFee`.
- **Promo banner**: `promoBannerShow` plus title/subtitle/badge/icon/color.
- **Size chart**: `sizeChartType` (`none`/`image`/`table`),
  `sizeChartMediaId` (wajib saat `image`), `sizeChartDetails` (`jsonb`, wajib
  saat `table`) — aturan cross-field-nya hidup di `reconcileSizeChart` milik
  `domain/size-chart.ts`, dipanggil dari validator create (terhadap nilai
  yang sudah di-default) maupun `updateProduct` (terhadap baris yang
  DIGABUNG dengan patch), dan dicerminkan sebagai `CHECK` kasar di
  `sql/904`. `sizeChartMediaId` hanya divalidasi bentuk UUID-nya, tidak
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
| Popup           | `/popups`, `/{id}`                                                  | `GET /popups/active` (satu atau `null`) | paling banyak SATU aktif per tenant — partial unique index (`sql/909`), bukan konvensi               |
| Pengaturan toko | `GET`/`PUT`/`DELETE /store-settings`                                | `GET /store-settings/public`            | nomor dan pemilik rekening bank, id media QRIS, aturan diskon level pelanggan                        |

**Aritmetika voucher eksak** (`domain/voucher-arithmetic.ts`): sen bulat,
pembulatan setengah ke atas, persentase dibatasi `maxDiscount`,
`free_shipping` berupa flag bukan nominal; `POST /vouchers/validate` tetap
BACA. Penebusan kini milik order yang memakai kodenya (Issue #29):
`application/cart-quote-service.ts` dan `application/order-directory.ts`
sama-sama memanggil `evaluateVoucher` YANG SAMA yang dijelaskan bagian ini,
dan hanya pembuatan order yang menambah `used_count` — di dalam transaksi
yang sama dengan insert order, sehingga kuota voucher tak bisa oversold oleh
dua checkout konkuren. **Status flash sale diturunkan**, tidak pernah
dipercaya dari kolom: editor menyetel
`draft`/`scheduled` dan `commerce:flash-sales:tick` menyimpan apa yang
disiratkan `now()`, memancarkan `commerce.flash_sale.{started,ended}` pada
transisi dan tidak pernah dua kali.

**Pengaturan toko adalah satu dokumen `jsonb` berversi per tenant**
(`domain/store-settings-validation.ts`, kunci tak dikenal ditolak, `PUT`
adalah penggantian penuh). `DELETE` berarti "reset ke bawaan": ia mencap
`deleted_at` alih-alih menghapus singleton (header `sql/910`), setiap pembaca
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
berbayar produk digital, kini di `ProductAdminRecord` di samping `costPrice`.
**Yang masuk:** `sizeChartImageUrl`, di-resolve lewat batch media yang sama
dengan `images[]`. Issue #29 pun, pada kenyataannya, tidak mengirimkan
`downloadLink` lewat jalur order — lihat "Apa yang tidak dilakukan Issue
#29" di bawah; ia tetap celah yang dicatat untuk #31, bukan forward
reference yang ditutup diam-diam.

## Pelanggan, order, dan review (Issue #29)

Guest checkout: pembeli tak pernah membuat akun, dan baris pelanggan
(`awcms_commerce_customers`, unik pada `(tenant_id, phone)` di antara baris
hidup) di-cari-atau-dibuat begitu order ditempatkan. `domain/phone-normalisation.ts`
mengubah apa pun yang dikirim form checkout menjadi E.164 atau menolaknya
secara langsung — nomor telepon, bukan sesi, adalah kredensial yang dipakai
storefront untuk setiap lookup berikutnya, sehingga nomor yang salah
diperlakukan sebagai "tidak terautentikasi", bukan "validation error"
(`maskPhone` adalah yang ditampilkan admin UI dan log, bukan nomor mentah).

**Permukaan publiknya sepenuhnya anonim**, di bawah
`/api/v1/commerce/storefront/{cart/quote,orders,reviews}`, tenant-resolved
dari Origin/Host request dengan cara yang sama seperti `newsletter` dan
bacaan publik pemasaran (`application/public-commerce-tenant.ts`
mencerminkan `newsletter`'s `public-newsletter-tenant.ts` file demi file) —
tak pernah header pemanggil, 404 netral untuk tenant yang tak bisa
di-resolve atau modul yang nonaktif, `Vary: Origin`, origin digemakan
kembali apa adanya dan tak pernah `*`, tanpa kredensial. Setiap POST
di-rate-limit per IP dan membaca body-nya lewat `readJsonBody`, tak pernah
`request.json()` mentah.

- **`POST /storefront/cart/quote`** menghitung ulang harga cart dari state
  produk/varian/flash-sale/voucher sisi tenant — tak pernah mempercayai
  harga kiriman klien — lewat `quoteCart` milik `domain/cart-quote.ts`,
  dipanggil dari `application/cart-quote-service.ts`. Urutan aritmetikanya
  tetap: subtotal → diskon voucher → ongkir (dinolkan oleh flag
  `freeShipping` milik voucher atau ambang gratis-ongkir toko, hanya saat
  setiap lini mengizinkan gratis ongkir) → asuransi (`max(minFee, subtotal ×
ratePercent)`, dipaksa aktif saat ada lini yang mewajibkannya) → pajak
  (persentase dari `subtotal − discount`) → total. `previousUnitPrice`
  selalu `null` dan line-diff `"price_changed"` tak pernah dipancarkan —
  tak ada harga yang diharapkan dari klien untuk dibandingkan dalam kontrak
  ini, celah yang didokumentasikan, bukan kelalaian (header
  `domain/cart-quote.ts`).
- **`POST /storefront/orders`** membuat order dari input quote yang sama,
  di dalam satu transaksi: pelanggan di-cari-atau-dibuat, alamat disimpan,
  stok dan kuota flash-sale dikurangi, `used_count` voucher ditambah,
  `order_code` dicetak (`domain/order-code.ts`, `BJM-YYYYMMDD-XXXX`,
  mengecualikan `0/O/1/I`), dan `commerce.order.created` dipancarkan.
  Idempotensinya memakai store BERSAMA (`_shared/idempotency.ts`), bukan
  kolom khusus — dengan kunci `(tenantId, "commerce.orders.create",
idempotencyKey)` — sehingga submit yang diulang me-replay response
  pertama alih-alih membuat order kedua; race antara dua submit identik
  yang konkuren ditangkap secara terpusat (`IdempotencyRaceLostError`) dan
  dijawab sebagai replay, bukan 500.
- **`GET /storefront/orders/:orderCode`**, **`POST .../cancel`**, **`POST
.../payment-confirmations`**, **`POST /storefront/reviews`** semuanya
  memakai `orderCode` + nomor telepon sebagai pasangan kredensial, diperiksa
  terhadap `customer_id` milik order itu sendiri sebelum apa pun dibaca
  atau ditulis.
- **Upload bukti pembayaran adalah stub di peningkatan ini.** Kedua
  endpoint `.../payment-proof/upload-sessions` selalu menjawab `503
MEDIA_UNAVAILABLE` (header `application/order-directory.ts` menjelaskan
  alasannya: belum ada kontrak upload-media untuk pemanggil anonim
  tak-terautentikasi di `media_library`) — konfirmasi pembayaran manual
  tetap berfungsi tanpa foto; hanya jalur bukti-upload-pembeli yang
  ditunda, dicatat untuk #31.
- **Status order adalah state machine kecil** (`domain/order-status.ts`):
  `LEGAL_ORDER_STATUS_TRANSITIONS` ditambah `actorMayApplyOrderStatus`
  menentukan, per jenis aktor (customer vs. admin vs. system), transisi
  mana yang sah — customer hanya boleh membatalkan dari state yang masih
  bisa dibayar, admin menjalankan state pemenuhan, dan system (job expiry)
  hanya boleh meng-expire order belum-bayar yang melewati jendela
  terkonfigurasi toko (`store-settings.orders.expiryHours`, bawaan 24).
  Setiap transisi menambahkan baris `awcms_commerce_order_events`
  (append-only, tanpa `deleted_at`) alih-alih hanya memutasi kolom
  `status` milik order itu sendiri, sehingga riwayat lengkapnya tetap
  bertahan bahkan setelah order itu sendiri habis masa retensinya.
- **`commerce:orders:expire`** (`scripts/commerce-orders-expire.ts`, tiap
  5 menit) mendaftar order yang sudah melewati jendela expiry-nya,
  mentransisikan masing-masing ke `expired`, me-restock lininya (termasuk
  kuota flash-sale), dan memancarkan `commerce.order.expired` — jalur
  restock yang sama yang dipakai `cancelOrderByCustomer`, sehingga
  "cancelled" dan "expired" tak bisa berbeda dalam apa yang mereka
  kembalikan.
- **Review** di-gate pada keharusan punya order YANG SUDAH SELESAI untuk
  produk tersebut: guest tak bisa me-review produk yang tak pernah
  dibelinya. `POST /storefront/reviews` mewajibkan pasangan kredensial di
  atas; layar admin `reviews` memoderasi (publish/reject) dan bisa
  hard-delete sebuah review, satu-satunya permukaan hard-delete yang
  dimiliki modul ini (`reviews.delete`, entitlement revoke-only).
- **Pelanggan guest tak bisa direpresentasikan secara jujur dalam kosakata
  subject-data milik `ADR-0094`** — `SubjectDataColumn.references` hanya
  menyebut konsep identitas sisi staf (`tenant_user`/`identity`/`profile`/
  `principal`), dan pelanggan phone-only tanpa akun bukan salah satunya.
  Kedelapan tabel baru dideklarasikan `unreachableBySubject: true` di
  `module.ts`, bentuk yang sama yang sudah dipakai `commerce.testimonials`
  untuk pengirim anonim — keterbatasan kosakata yang terdokumentasi, bukan
  keputusan privasi yang dibuat modul ini.

### Apa yang tidak dilakukan Issue #29

- **Tidak ada pengiriman produk digital.** `downloadLink` (Issue #23)
  masih tak pernah dikembalikan oleh endpoint order atau storefront mana
  pun — order berbayar untuk produk digital tidak menyerahkan asetnya.
  Dicatat untuk #31, bukan dijatuhkan diam-diam.
- **Tidak ada akun pelanggan, login, atau riwayat order lintas-order.**
  Setiap lookup bersifat single-order, lewat `orderCode` + nomor telepon;
  tak ada daftar "order saya" untuk pembeli yang kembali di peningkatan
  ini.
- **`awcms_commerce_wishlists` mengirimkan skemanya tapi tanpa rute API.**
  Kata-kata issue-nya sendiri: "Wishlist tetap client-side di peningkatan
  ini (tanpa akun) — tanpa endpoint" — belum ada identitas pelanggan untuk
  menyimpannya. Tabelnya ada supaya peningkatan berikutnya yang membawa
  akun tak perlu migrasi sendiri.
- **Tidak ada permission admin `orders.create`/`orders.delete`/
  `customers.create`/`customers.delete`.** Tak ada rute admin yang membuat
  atau hard-delete order atau pelanggan, by design — order hanya pernah
  datang dari `POST /storefront/orders` milik storefront sendiri, dan
  baris pelanggan hanya dari find-or-create yang dilakukan pembuatan
  order.
- **Tidak ada test suite integrasi formal ber-gate `DATABASE_URL`** untuk
  pembuatan order, replay idempotensi double-submit, pemeriksaan
  kredensial nomor-telepon-salah, siklus expire-lalu-restock, atau
  isolasi RLS lintas-tenant pada tabel baru. Kelima hal itu dibuktikan
  secara manual terhadap instance Postgres sungguhan selama verifikasi
  issue ini sendiri (lihat bagian Verification milik PR-nya) alih-alih
  dikomit sebagai file `tests/integration/*.test.ts` — celah sungguhan
  dalam durabilitas test suite, ditandai di sini alih-alih dibiarkan
  implisit.

## Layar admin: delapan, CRUD penuh (Issue #23 dan #26); tiga lagi (Issue #29)

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

Issue #26 menambahkan `/admin/commerce-flash-sales`, `-vouchers`, `-sliders`,
`-testimonials`, `-popup`, dan `-settings`, masing-masing daftar + form buat

- edit/hapus per baris terhadap rute pemiliknya (layar pengaturan adalah
  satu form dengan aksi "reset ke bawaan"). Issue #29 menambahkan
  `/admin/commerce-orders` (daftar + filter berdasarkan status, tampilan
  detail, transisi status, review konfirmasi-pembayaran), `-customers`
  (daftar, detail, edit), dan `-reviews` (daftar, moderasi, hapus) — tanpa
  form buat pada ketiganya, karena tak satu pun permission-nya mencakup
  `create`. Kesebelas layar sudah keluar dari `NOT_YET_SCREENED` milik
  `scripts/admin-screen-coverage-ledger.ts` — setiap satu dari 39 permission
  yang dideklarasikan diklaim salah satunya, dan
  `tests/admin-commerce-marketing-page-contract.test.ts` /
  `tests/admin-commerce-page-contract.test.ts` menuntut layar-layar baru itu
  pada sifat yang sama yang dipenuhi layar-layar sebelumnya.

## Akun pelanggan — auth (Issue #89, epic #32 gelombang 2 — C2)

`openapi/modules/commerce.openapi.yaml` mendokumentasikan seluruh permukaan
`/api/v1/commerce/storefront/account/*` (login/registrasi OTP, profil, alamat
tersimpan, wishlist, riwayat pesanan, ulasan, pendaftaran afiliasi) plus rute
sisi staf `/api/v1/commerce/affiliates*`. **Empat dari jalur itu sudah
diimplementasikan sejak Issue #89** — `otp/request`, `otp/verify`, `me`
(`GET`/`PATCH`), dan `logout` — dan dihapus dari `ROUTE_PARITY_EXEMPTIONS`
(`scripts/api-spec-check.ts`) sesuai itu; jalur yang tersisa (alamat,
wishlist, riwayat pesanan, ulasan, afiliasi) mendarat lintas C3/C4 (issue
#91/#92 — lihat bagian-bagian itu di bawah), dan `ROUTE_PARITY_EXEMPTIONS`
kini kosong. Empat keputusan arsitektur di balik bentuknya —
identitas tetap baris `commerce` yang tidak pernah ditautkan ke
`awcms_principals`, OTP e-mail sekarang dengan WhatsApp ditunda ke #33, token
sesi `customerBearer` opaque yang disimpan di `localStorage`, dan aturan
binding baris tamu saat registrasi — tercatat di
[ADR-0016](../../../../../docs/adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md)
di awcms-one.

**Lapisan aplikasi** (`application/customer-auth.ts`): `requestCustomerOtp`
memvalidasi `{email, purpose, name?, phone?}` — `purpose: "register"`
menjalankan validator registrasi PENUH (`domain/
customer-account-validation.ts`) sebelum menerbitkan apa pun, sehingga
nama/telepon yang salah bentuk menjawab `400` sebelum e-mail pernah
terkirim — lalu selalu menerbitkan kode dan selalu meminta port
`CustomerOtpChannel` mengirimkannya, sehingga sebuah permintaan selalu
menjawab `202 {sent:true, expiresInSeconds:600}` yang sama apa pun yang
terjadi (aturan anti-enumerasi D2; tenant yang tak teresolusi membayar
latensi yang sama lewat `padUnresolvedCommerceTenantLatency`).
`verifyCustomerOtp` meruntuhkan SETIAP alasan kegagalan `consumeOtp`
(salah/kedaluwarsa/terpakai/habis) menjadi satu `401 OTP_INVALID`;
`purpose: "login"` tanpa akun yang cocok menjawab `404 ACCOUNT_NOT_FOUND`
(pengecualian yang diterima dan terdokumentasi — pemilik kotak surat sudah
menerima kodenya); `purpose: "register"` memeriksa nomor telepon terhadap
SETIAP akun yang SUDAH ADA (`findAccountByPhone`) sebelum memanggil
`createAccountForCustomer` yang sudah dikirim (#87), menjawab
`409 PHONE_ALREADY_REGISTERED` pada konflik. Akun yang diblokir tidak
pernah bisa verifikasi menjadi sesi (`403 ACCOUNT_BLOCKED`) tetapi TETAP
bisa logout — lihat header `application/customer-session-auth.ts` sendiri
untuk alasan keduanya sengaja berbeda.

**Pengiriman** (`domain/customer-otp-channel.ts` + `application/
customer-otp-channel-adapters.ts`): port `CustomerOtpChannel` dengan
adapter `email` (mengantre ke outbox `email`, di dalam transaksi YANG SAMA
dengan baris OTP, di bawah kategori turunan baru
`derived.commerce_customer_otp` — lihat dokumen deployment cms.md di root awcms-one)
dan adapter `log` (menulis baris log terstruktur YANG MENYERTAKAN kodenya —
satu-satunya tempat di basis kode ini yang melakukan itu — dipilih setiap
kali `EMAIL_PROVIDER=log` atau `EMAIL_ENABLED` bukan `"true"`, sehingga
dev/CI bekerja tanpa kredensial e-mail). `commerce` mendapat dependensi ke
`email` untuk ini (lihat `module.ts`), sama seperti `newsletter` yang sudah
bergantung padanya untuk e-mail konfirmasinya sendiri.

**Sesi** (`application/customer-session-auth.ts`): `requireCustomerSession`
mem-parsing `Authorization: Bearer cs_…`, mencari baris hidup di
`awcms_commerce_customer_sessions` (`findSessionByTokenHash`), dan
menggeser TTL-nya (`touchSession`, paling banyak sekali per 5 menit) —
namespace sesi kelima yang independen dari `awcms_sessions` (lihat
`domain/customer-session-token.ts`), sehingga
`identity:session-readers:check` tidak punya urusan dengannya.

**Audit** (e-mail/telepon tersamar saja, tak pernah kode/token):
`commerce.customer.otp_requested`, `otp_verified`, `login_failed` (setiap
kegagalan verifikasi, apa pun alasannya — alasannya hanya ada di
`attributes.reason`), `account_registered`, `logout`.

## Akun pelanggan — sumber daya (Issue #91, epic #32 gelombang 3 — C3)

Enam jalur `/api/v1/commerce/storefront/account/*` lagi mendarat:
`addresses` (`GET`/`POST`), `addresses/{id}` (`PATCH`/`DELETE`),
`addresses/{id}/default` (`POST`), `wishlist` (`GET`/`PUT`),
`wishlist/{productId}` (`DELETE`), `orders` (`GET`, keyset), `orders/
{orderCode}` (`GET`), dan `reviews` (`GET`) — semuanya dihapus dari
`ROUTE_PARITY_EXEMPTIONS` sesuai itu.

**Alamat** (`application/customer-account-resources.ts`,
`domain/address-validation.ts`'s `validateAccountAddressInput`): bentuk
alamat pengiriman yang sama yang divalidasi pembuatan order, DITAMBAH
`label` yang wajib dan `postalCode` yang wajib (bukan opsional) — alamat
YANG DISIMPAN selalu membawa keduanya, tidak seperti snapshot order
sekali pakai. Maksimal 10 alamat hidup per akun (`409
ADDRESS_LIMIT_REACHED`); alamat PERTAMA yang pernah disimpan otomatis
menjadi default; menghapus default mempromosikan yang paling baru dibuat
di antara yang tersisa. Persis satu default per pelanggan ditegakkan oleh
DATABASE, bukan sekadar dipercayakan ke kode aplikasi ini — indeks unik
parsial `sql/920` pada `(tenant_id, customer_id) WHERE is_default AND
deleted_at IS NULL` (duplikat mana pun yang mungkin ditinggalkan era
checkout tamu diturunkan menjadi satu penyintas oleh migrasi yang sama,
sebelum indeks dibuat).

**Wishlist** (berkas yang sama): `PUT` menggabung-union `{productIds}` ke
apa pun yang sudah dimiliki akun, maksimal 200 baris hidup, dan
mengembalikan daftar gabungan yang otoritatif; id yang bukan produk hidup
DI TENANT INI dilewati secara diam-diam (tidak pernah `400`) — penjagaan
skill `awcms-one-commerce` sendiri "FK telanjang tidak bisa mengisolasi
per tenant", diperiksa di sini pada lapisan aplikasi di dalam transaksi
yang sama yang berlingkup RLS. `GET` hanya menampilkan produk yang
dipublikasikan (`status = 'active'`), belum dihapus — produk yang
dimoderasi keluar dari status itu, atau dihapus lunak, langsung berhenti
muncul; baris wishlist-nya sendiri tidak tersentuh. `DELETE
/wishlist/{productId}` menghapus lunak dan idempoten (selalu `204`,
bahkan untuk produk yang belum pernah di-wishlist atau id yang salah
bentuk).

**Order** (`application/order-directory.ts`'s `listOrdersForAccount`/
`fetchOrderForAccount`): berpaginasi keyset (`cursor`, `limit` ≤ 50,
default 20), terbaru dulu, `created_at >= account.historyFrom` (ADR-0016
D4) ditegakkan DI DALAM query — tidak pernah sekadar di rute. `GET
/orders/{orderCode}` tidak perlu nomor telepon (bearer sudah membuktikan
kepemilikan); kepemilikan dan `historyFrom` KEDUANYA diperiksa di dalam
query yang sama, sehingga kode yang tidak dikenal, order akun lain, dan
yang lebih lama dari `historyFrom` semuanya menjawab `404` netral yang
identik. Keduanya memakai ulang `toPublicOrderRecord` per baris — bentuk
YANG SAMA yang dikembalikan `GET .../orders/{code}?phone=`, sesuai aturan
kontrak sendiri "bentuk item daftar yang sama dengan endpoint pelacakan
minus apa pun yang sensitif".

**Ulasan** (`application/review-directory.ts`'s `listReviewsForAccount`):
setiap ulasan yang akun ini sendiri kirimkan, status moderasi apa pun,
dengan nama produk dan kode order disematkan.

**Kedua rute anonim yang sudah ada kini menerima bearer OPSIONAL** —
`POST /storefront/orders` dan `POST /storefront/reviews`. Hadir dan valid:
pelanggan order/ulasan adalah baris pelanggan MILIK akun itu SENDIRI
(`accountCustomerId` milik `createOrderFromCart`/`createReview`), tidak
pernah pencarian `findOrCreateCustomerByPhone`/kecocokan telepon — nomor
telepon yang diketik tetap divalidasi bentuknya dan tetap menjadi kunci
rate limit per telepon. Hadir tetapi tidak valid/kedaluwarsa: `401
UNAUTHENTICATED`, eksplisit — storefront membaca ulang sesinya sendiri
tepat sebelum submit dan perlu diberi tahu secara jelas. Tidak hadir sama
sekali: jalur tamu tidak berubah. `POST .../orders` juga
menerima `affiliateCode` di body — divalidasi bentuknya (string, maksimal
50 karakter) dan, sejak Issue #92, diresolusi terhadap
`awcms_commerce_affiliates.code` (lihat bagian berikutnya).

**Siklus hidup data / data subjek**: `commerce.customer_addresses` dan
`commerce.wishlists` (array `subjectData` milik `module.ts`) tetap
`unreachableBySubject: true` — kosakata subjek registry ini adalah
`tenant_user_id`/`identity_id`/`profile_id`/`principal_id`, dan akun
pelanggan (ADR-0016 D1) dengan sengaja tidak membawa satu pun itu — tetapi
rationale-nya kini mencatat bahwa Issue #91 memberi pemilik akun jalur
SWALAYAN sungguhan ke baris miliknya sendiri (rute bearer di atas), yang
sebelum issue ini tidak ada.

## Akun pelanggan — afiliasi (Issue #92, epic #32 gelombang 4 — C4)

Dua jalur terakhir yang tadinya hanya kontrak kini mendarat: `account/affiliate`
(`GET`/`POST`) dan `account/affiliate/commissions` (`GET`, keyset) — keduanya
dihapus dari `ROUTE_PARITY_EXEMPTIONS`, yang kini KOSONG (setiap jalur yang
didokumentasikan #86 lebih dulu dari handler-nya kini punya satu). Plus sisi
pemilik: `/api/v1/commerce/affiliates(/{id})` dan
`/api/v1/commerce/affiliate-commissions(/{id}/{approve,pay,void})`, digerbangi
permission baru `affiliates.{read,update}`/`affiliate_commissions.{read,update}`
(`sql/922`).

**Skema** (`sql/921`): `awcms_commerce_affiliates` — satu baris per pelanggan
yang bergabung, `code` (`domain/affiliate-code.ts`: 8 karakter, CSPRNG,
alfabet tanpa ambiguitas `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — tanpa
`I`/`O`/`0`/`1`), `commission_rate` (SNAPSHOT yang disalin dari
`store_settings.affiliate_commission_rate` saat pendaftaran, tidak pernah
diturunkan ulang setelahnya), `status` (`active`/`suspended`).
`awcms_commerce_affiliate_commissions` — satu baris per pesanan yang pernah
menghasilkan komisi (`order_id` unik, selamanya), snapshot
`base_amount`/`rate`/`amount`, `status` (`pending → approved/void → paid`).
Plus `awcms_commerce_orders.affiliate_id` (FK nullable, diatur sekali saat
pesanan dibuat) dan `awcms_commerce_store_settings.affiliate_commission_rate`
(`numeric(5,2)` nullable, kolom nyata di luar blob jsonb settings — `null`
berarti program MATI).

**Domain** (`domain/affiliate-commission.ts`, murni): `computeCommissionBase`
(`subtotal − discount − voucher_discount`, dibatasi minimum nol, aritmetika
`BigInt` cent-integer lewat `toCents`/`fromCents` milik `price-calculation.ts`
— ADR-0003, tidak pernah float) dan `computeCommissionAmount` (`base × rate /
100`, dibulatkan ke sen). `shouldEarnCommission({affiliateCustomerId,
orderCustomerId, affiliateStatus})` bernilai `false` untuk referral diri
sendiri ATAU afiliasi yang ditangguhkan — dievaluasi DUA KALI:
`application/affiliate-directory.ts`'s `resolveAffiliateForOrder` hanya
menautkan kode `active` ke pesanan BARU (kode tak dikenal/ditangguhkan
diresolusi ke `null`, tidak pernah error validasi — referral yang buruk
tidak boleh menggagalkan checkout); `shouldEarnCommission` memeriksa ulang
kedua kondisi itu lagi, memakai status TERKINI afiliasi tersebut, tepat
saat pesanan mencapai `completed` — kode yang valid saat checkout bisa saja
milik afiliasi yang ditangguhkan sebelum pesanan selesai.

**Application** (`application/affiliate-directory.ts`): `enrolAffiliate`
idempoten (pelanggan yang sudah terdaftar mendapatkan baris miliknya
kembali, tidak pernah yang kedua) dan melempar
`AffiliateProgramDisabledError` (`409 AFFILIATE_PROGRAM_DISABLED`) saat
`store_settings.affiliate_commission_rate` bernilai `null`.
`fetchAccountAffiliate` mengembalikan `stats: {referredOrders,
pendingAmount, approvedAmount, paidAmount}`, dihitung langsung dari
`awcms_commerce_orders`/`_affiliate_commissions`, tidak pernah di-cache.
SATU-SATUNYA tempat komisi dibuat adalah `transitionOrderStatus` milik
`order-directory.ts`, pada transisi ke `completed` — memanggil
`recordAffiliateCommissionOnOrderCompleted` dalam transaksi YANG SAMA dengan
perubahan status; transisi `cancelled` memanggil
`voidAffiliateCommissionForOrder` (hook defensif: `completed` tidak punya
edge keluar pada graf `domain/order-status.ts` saat ini, jadi ini tidak bisa
terpicu hari ini, tapi menggunakan kembali penegakan yang sama begitu jalur
refund/cancel-setelah-completed di masa depan ditambahkan, alih-alih
menumbuhkan yang kedua). Moderasi komisi sisi pemilik adalah mesin status
kecil (`pending → approved → paid`, `pending|approved → void`, selain itu
berbentuk `409 INVALID_TRANSITION`), setiap transisi mewajibkan
`Idempotency-Key` (skill `awcms-idempotency`) dan event audit miliknya
sendiri.

**Paparan publik**: `GET .../store-settings/public` mengekspos
`affiliateProgramEnabled: boolean` SAJA — tarifnya sendiri tidak pernah
masuk ke bentuk itu, disiplin masking yang sama yang sudah diterapkan
`payment.manualBank`/`manualQris` pada detail bank. `GET
/api/v1/commerce/store-settings` yang owner-only dan `PUT`-nya JUSTRU
membawa `affiliateCommissionRate` (divalidasi 0–100, dua desimal,
nullable) — disimpan di kolomnya sendiri, bukan blob jsonb `settings`
(lihat header `sql/921` untuk alasannya).

**Layar admin**: `/admin/commerce-affiliates` — tabel afiliasi (kode,
pelanggan, tarif dengan kontrol edit inline, status, suspend/aktifkan) dan
tabel komisi (afiliasi, pesanan, jumlah, status, dapat difilter berdasarkan
status, tombol approve/pay/void), i18n `en`+`id`.
`/admin/commerce-settings` mendapat field tarif komisi.

## Dengan sengaja tidak ada di sini

- **Tidak ada integrasi kurir pengiriman.** `shippingMethod` pada sebuah
  order adalah label yang didefinisikan merchant, bukan tarif live atau
  nomor resi dari API kurir — di luar cakupan epic ini sejauh ini.
- **Tidak ada restore untuk tabel pemasaran, maupun untuk
  orders/customers/reviews.** Hanya soft delete; voucher, slider, order,
  atau pelanggan yang dihapus dibuat ulang, bukan dikembalikan — jejak
  audit menyimpan catatannya. `order_code` adalah satu-satunya
  pengecualian dari "unik di antara baris hidup": indeks keunikannya TAK
  PERNAH dibatasi pada `deleted_at IS NULL` (header `sql/913`), karena
  kode order harus tetap unik untuk tenant itu selamanya, bukan hanya
  selama order-nya masih hidup.
- **Tidak ada ranking relevansi full-text pada `q`.** Pencocokan
  trigram/`ILIKE` (`sql/907`) adalah pencarian substring, bukan indeks
  pencarian ber-ranking — `site_search` adalah modul pencarian
  lintas-konten base ini, dan `commerce` tidak berintegrasi dengannya di
  peningkatan ini.
