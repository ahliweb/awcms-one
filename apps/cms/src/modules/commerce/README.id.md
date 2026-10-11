🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](README.md)

<!-- i18n-source-hash: sha256:10190a4e3138105971a1d87736be43629416fa818abd25d8481f8842e812944a -->

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
  dari order yang sudah selesai — dan, sejak epic #32 (issue #86–#93),
  **akun pelanggan, login OTP/sesi bearer, permukaan akun swa-layanan**
  (alamat tersimpan, wishlist tersinkron, riwayat pesanan, ulasan) **dan
  program afiliasi** yang dirancang dari nol sesuai
  [ADR-0016](../../../../../docs/adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.id.md).
  Issue #4 (bagian dari epic #1) mengirimkan
  inti katalog; Issue #23 (bagian dari epic #21) membawanya ke paritas model
  produk penuh dengan skema legacy; Issue #26 (epic yang sama) menambahkan
  tabel pemasaran; Issue #29 (epic yang sama) menambahkan pelanggan, order,
  dan permukaan checkout storefront anonim; epic #32 menambahkan akun
  pelanggan dan afiliasi di atas baris pelanggan yang sama itu.

| Aspek      | Nilai                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key / type | `commerce` · `domain`, `isCore: false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Tabel      | `awcms_commerce_categories`, `awcms_commerce_products` (`sql/901`, diperluas `sql/904`), `awcms_commerce_product_images`, `awcms_commerce_product_variants` (`sql/905`); `awcms_commerce_flash_sales`, `awcms_commerce_flash_sale_products`, `awcms_commerce_vouchers`, `awcms_commerce_sliders`, `awcms_commerce_testimonials`, `awcms_commerce_popups` (`sql/909`), `awcms_commerce_store_settings` (`sql/910`); `awcms_commerce_customers`, `awcms_commerce_customer_addresses`, `awcms_commerce_orders`, `awcms_commerce_order_items`, `awcms_commerce_order_events`, `awcms_commerce_payment_confirmations`, `awcms_commerce_reviews`, `awcms_commerce_wishlists` (`sql/913`); `awcms_commerce_customer_accounts`, `awcms_commerce_customer_otps`, `awcms_commerce_customer_sessions` (`sql/917`-`918`); baris `derived.commerce_customer_otp` di `awcms_email_templates`, di-seed per tenant yang ada (`sql/919`); `awcms_commerce_affiliates`, `awcms_commerce_affiliate_commissions`, plus `orders.affiliate_id`/`store_settings.affiliate_commission_rate` (`sql/921`); `awcms_commerce_whatsapp_messages`, `awcms_commerce_whatsapp_delivery_attempts`, plus `awcms_commerce_customer_otps.phone_normalized` (`sql/925`); `awcms_commerce_conversations`, `awcms_commerce_messages` (`sql/927`); `awcms_commerce_customer_accounts.marketing_consent_at`, `awcms_commerce_campaigns`, `awcms_commerce_campaign_recipients` (`sql/929`); `awcms_commerce_payment_gateway_sessions`, `awcms_commerce_payment_events`, `awcms_commerce_webhook_endpoints`, plus `orders.gateway_provider`/`orders.gateway_ref` (`sql/926`); `payment_events.outcome` diperlebar dengan `amount_mismatch` (`sql/934`); `awcms_commerce_sales_daily`, `awcms_commerce_sales_by_product`, `awcms_commerce_sales_by_category` (`sql/933`, Issue #117 — proyeksi reporting turunan) |
| Permission | `categories.{read,create,update,delete,restore}`, `products.{read,create,update,delete,restore}` (`sql/902`, `sql/906`); `{flash_sales,vouchers,sliders,testimonials,popups}.{read,create,update,delete}`, `settings.{read,update}` (`sql/911`); `orders.{read,update}`, `customers.{read,update}`, `reviews.{read,update,delete}` (`sql/914`, dengan sengaja tanpa create/delete untuk orders atau customers — lihat "Pelanggan, order, dan review" di bawah); `affiliates.{read,update}`, `affiliate_commissions.{read,update}` (`sql/922`, alasan sama tanpa create/delete); `whatsapp.read` (`sql/925`, hanya diagnostik); `conversations.{read,update}` (`sql/928`, alasan sama tanpa create/delete); `campaigns.{read,update,send}` (`sql/930` — `send` dipisah dari `update`, satu-satunya aksi yang benar-benar menjangkau inbox/telepon nyata); `webhook_endpoints.update` (`sql/926`, menggerbangi list/create/revoke sekaligus) — 50 total                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| API        | `/api/v1/commerce/{categories,products,flash-sales,vouchers,sliders,testimonials,popups,store-settings,orders,customers,reviews,affiliates,affiliates/{id},affiliate-commissions,affiliate-commissions/{id}/{approve,pay,void},whatsapp/messages}` (sisi pemilik); `/api/v1/commerce/storefront/{cart/quote,orders,reviews}` (sisi anonim, `orders`/`reviews` juga menerima `customerBearer` OPSIONAL, Issue #91); `/api/v1/commerce/storefront/account/{otp/request,otp/verify,me,logout}` (OTP anonim + `customerBearer`, Issue #89; `otp/request`/`otp/verify` mendapat `via`/`phone`, Issue #108; `me` mendapat `marketingConsent`, Issue #114); `/api/v1/commerce/storefront/account/{addresses,addresses/{id},addresses/{id}/default,wishlist,wishlist/{productId},orders,orders/{orderCode},reviews,affiliate,affiliate/commissions,conversations,conversations/{id},conversations/{id}/messages}` (`customerBearer`, Issue #91/#92/#111); `/api/v1/commerce/{conversations,conversations/{id},conversations/{id}/messages}` (sisi pemilik, Issue #111); `/api/v1/commerce/{campaigns,campaigns/{id},campaigns/{id}/{preview,send,cancel}}` (sisi pemilik, Issue #114); `/api/v1/reports/commerce/{sales-daily,sales-by-product,sales-by-category}` (`reporting.dashboard.read`, Issue #117) (`openapi/modules/commerce.openapi.yaml`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Event      | `commerce.product.{created,updated,status_changed}`; `commerce.flash_sale.{started,ended}` (Issue #26, dipancarkan job tick); `commerce.order.{created,paid,status_changed,cancelled,expired}`, `commerce.voucher.redeemed`, `commerce.review.published` (Issue #29)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Depends on | `tenant_admin`, `identity_access`, `domain_event_runtime`, `media_library` (gambar produk, slider, avatar testimoni, gambar popup, dan logo/favicon toko semuanya di-resolve lewat `MediaLibraryPort`), `module_management` (resolver tenant storefront anonim memeriksa modul ini aktif untuk tenant tersebut sebelum menjawab), `profile_identity` (penyamaran e-mail/telepon), `email` (Issue #89 — adapter `email` pada channel OTP pelanggan mengantre ke outbox `email` sendiri; dispatcher WhatsApp Issue #108 juga memakai ulang fungsi backoff murni `email/domain/email-retry.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Job        | `commerce:flash-sales:tick` (`scripts/commerce-flash-sales-tick.ts`, tiap 5 menit — menyimpan status turunan tiap sale dan memancarkan dua event flash sale); `commerce:orders:expire` (`scripts/commerce-orders-expire.ts`, tiap 5 menit — mengekspirasi order belum-bayar yang melewati jendela terkonfigurasi toko, me-restock lini pesanannya, dan memancarkan `commerce.order.expired`); `commerce:whatsapp:dispatch`/`commerce:whatsapp:purge` (Issue #108 — job drain/retensi milik outbox WhatsApp sendiri); `commerce:loyalty:expire`/`commerce:loyalty:reconcile` (Issue #289 — kedaluwarsa poin tiap jam; reconcile saldo harian hanya-baca)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

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
  (persentase dari `subtotal − discount` pada mode `flat`; angka modul `tax` pada mode `engine`, ADR-0039) → total. `previousUnitPrice`
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

### UI admin: primitive bersama (issue #171; commerce admin v2, epic #249)

Setiap layar di atas disusun di atas primitive bersama milik
`apps/cms/src/styles/admin.css` (`.admin-stat-card`, `.admin-status-pill`,
`.admin-segmented`, `.admin-bulk-bar`, `.admin-two-pane`, `.admin-toggle`,
`.admin-timeline`) bukan markup khusus-halaman — lihat tabel primitive milik
`.claude/skills/awcms-one-commerce/SKILL.md` sendiri untuk daftar lengkap dan
kapan memakai masing-masing. Gelombang kedua (epic #249) menambahkan EMPAT
komponen bersama milik-commerce lagi di bawah
`src/components/`/`src/lib/ui/`, masing-masing dengan docblock header-nya
sendiri:

- `CommerceConfirmDialog.astro` + `commerce-confirm-dialog-client.ts` — satu
  dialog konfirmasi aksesibel yang dipakai setiap aksi destruktif/perlu-jeda
  layar commerce sebagai ganti `window.confirm`, termasuk field catatan
  opsional (dipakai konsumsi perubahan status pesanan, issue #246).
- `commerce-admin-labels.ts` — `createCommerceLabels(t)`/`commerceLabel()`,
  satu peta label terjemahan untuk setiap enum commerce yang dirender layar
  admin, plus konstanta peta-nadanya.
- `CommerceSettingsSaveBar.astro` + `commerce-settings-save-bar-client.ts` —
  save bar selalu-dirender, tak-perlu-JS untuk formulir settings.
- `commerce-products-bulk-client.ts` — bar seleksi-massal daftar produk
  (issue #247), melakukan loop di atas endpoint per-item yang sudah ada
  bukan API massal baru.

Lihat bagian "Commerce admin v2" milik
[panduan authoring CMS](../../../../../docs/cms.id.md) awcms-one sendiri
untuk apa yang kini dilakukan setiap layar pengadopsi, dan
[dokumen desain UI/UX](../../../../../docs/ui-ux.id.md)-nya untuk rasionale
desain dan daftar yang dengan sengaja tidak diporting (ReasonPanel, menu
aksi baris, rute sampah terpisah, transisi status-pesanan massal, toast) —
keduanya dokumentasi akar milik awcms-one sendiri, di luar pohon modul ini.

## Akun pelanggan & afiliasi (epic #32 — ADR-0016)

`openapi/modules/commerce.openapi.yaml` mendokumentasikan seluruh permukaan
`/api/v1/commerce/storefront/account/*` (login/registrasi OTP, profil, alamat
tersimpan, wishlist, riwayat pesanan, ulasan, pendaftaran afiliasi) plus rute
sisi staf `/api/v1/commerce/affiliates*` — setiap satu sudah
diimplementasikan, mendarat lintas tiga gelombang (auth C2 issue #89, sumber
daya C3 issue #91, afiliasi C4 issue #92), dan `ROUTE_PARITY_EXEMPTIONS`
(`scripts/api-spec-check.ts`) kini KOSONG — setiap jalur yang didokumentasikan
#86 sebelum handler-nya kini punya satu. Empat keputusan arsitektur di balik
bentuknya — identitas tetap baris `commerce` yang tidak pernah ditautkan ke
`awcms_principals`, OTP e-mail sekarang dengan WhatsApp mendarat sebagai kanal login kedua (Issue #108, kontrak #106/ADR-0017 D5 — lihat di bawah), token
sesi `customerBearer` opaque yang disimpan di `localStorage`, dan aturan
binding baris tamu saat registrasi — plus rancangan program afiliasi sendiri
(D5) tercatat di
[ADR-0016](../../../../../docs/adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.id.md)
di awcms-one.

### Auth (Issue #89, gelombang 2 — C2)

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

**Registrasi di proses `email:dispatch` (Issue #311).** Ketiga kategori e-mail `derived.commerce_*` (`customer_otp`, `conversation_reply`, `campaign`) didaftarkan oleh SATU berkas efek-samping tanpa dependensi, `domain/email-template-categories.ts`, yang diimpor berkas application dan juga oleh `email/application/email-dispatch.ts` (satu divergensi upstream yang tercatat, lihat `AGENTS.md` root). Registri bersifat per proses dan `renderEmailTemplate` membuang semua variabel untuk kategori tak dikenal, sehingga registrasi yang hanya ada di berkas application yang tak pernah dimuat dispatcher terpisah membuat OTP e-mail terkirim dengan kode kosong. Tambahkan setiap kategori `derived.commerce_*` baru hanya di berkas itu; `tests/commerce-email-categories-dispatch.test.ts` memeriksanya dari proses baru.

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

### Sumber daya (Issue #91, gelombang 3 — C3)

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

### Afiliasi (Issue #92, gelombang 4 — C4)

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

## Provider eksternal — setiap keputusan D1–D10 kini sudah diimplementasikan (kontrak epic #33 wave 0 — ADR-0017, issue #106)

`openapi/modules/commerce.openapi.yaml` mendokumentasikan seluruh permukaan
provider-eksternal increment 5 SEBELUM ADA HANDLER APA PUN (issue #106);
setiap path yang dinamainya kini sudah punya handler. **D4 (tarif kurir),
D5 (WhatsApp), D6 (POS, issue #116), D7 (laporan penjualan), D8 (kotak
masuk), D9 (kampanye bergerbang consent), D10 (flag Fitur BjekMart + harga
bertingkat saat quote, issue #118), dan payment gateway secara PENUH (D2/D3
— pembuatan sesi, token webhook-endpoint, intake webhook, rekonsiliasi)
sudah DIIMPLEMENTASIKAN, bukan kontrak-saja; lihat bagian masing-masing di
bawah.** Setiap satu dari
sepuluh keputusan D1–D10 — mengapa port
hidup di dalam `commerce` alih-alih `integration_hub`, mengapa tenant
webhook diresolusi dari token opak alih-alih payload-nya, mengapa alur
gateway adalah redirect alih-alih embed, dan seterusnya — dicatat di
[ADR-0017](../../../../../docs/adr/0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md)
di awcms-one.

`ROUTE_PARITY_EXEMPTIONS` (`scripts/api-spec-check.ts`) KOSONG lagi —
disiplin yang sudah dibuktikan #86/ADR-0016 untuk akun, dan yang diwajibkan
`AGENTS.md` awcms-one sebelum epik ditutup. Entri pengecualian milik tarif
kurir, WhatsApp, kotak masuk, kampanye, laporan penjualan, payment gateway
secara penuh (sesi maupun intake webhook/rekonsiliasi), dan akhirnya POS
masing-masing dihapus oleh issue anak yang mendaratkan handler-nya (#107,
#108, #111, #114, #117, #110, #113, #116) — D10 (#118) tidak pernah
menambah satu pun: setiap path yang disentuhnya
(`store-settings/public`, `cart/quote`, `orders`) sudah ada sebelumnya, dan
satu-satunya permukaan tulis barunya (bagian "Fitur") memakai ulang rute
generik `module_management` sendiri yang sudah terdokumentasi,
`PATCH /api/v1/tenant/modules/{moduleKey}/settings`.
Variabel env RajaOngkir (`COMMERCE_SHIPPING_RATE_PROVIDER`,
`COMMERCE_RAJAONGKIR_API_KEY`, …), variabel env WhatsApp
(`COMMERCE_WHATSAPP_PROVIDER`, `COMMERCE_FONNTE_TOKEN`,
`COMMERCE_META_WA_TOKEN`, `COMMERCE_META_WA_PHONE_NUMBER_ID`, …), dan
variabel env payment-gateway (`COMMERCE_PAYMENT_GATEWAY`,
`COMMERCE_MIDTRANS_SERVER_KEY`, `COMMERCE_MIDTRANS_IS_PRODUCTION`, …)
SUDAH dibaca/dideklarasikan/diperiksa, dan didokumentasikan di [panduan
deployment awcms-one](../../../../../docs/deployment.md) — lihat bagian
"Tarif kurir"/"Outbox WhatsApp"/"Payment gateway" di bawah.

## Tarif kurir: RajaOngkir, ter-cache (Issue #107, contract #106 D4)

`ShippingRateProvider` (`domain/shipping-rate-provider.ts`) adalah sebuah
port — `searchDestination(query)`, `getRates({originId, destinationId,
weightGrams, couriers})` — dibentuk seperti kontrak provider `email`:
`infrastructure/rajaongkir-provider.ts` (API v2 Komerce, `withTimeout` +
`getProviderCircuitBreaker("commerce-rajaongkir")`) dan
`infrastructure/log-shipping-rate-provider.ts` (fixture deterministik)
sama-sama mengimplementasikannya, di-resolve oleh
`infrastructure/shipping-rate-provider-resolver.ts` dari
`COMMERCE_SHIPPING_RATE_PROVIDER`.

**Cache** (`sql/924`, `application/shipping-rate-directory.ts`):
`awcms_commerce_courier_destinations` memetakan kode kecamatan
`idn_admin_regions` milik tenant ke id tujuan milik provider (di-resolve
sekali lewat pencarian nama, tanpa TTL); `awcms_commerce_shipping_rates`
meng-cache tarif per `(tenant, provider, asal, tujuan, bucket berat,
kurir, layanan)`, TTL 6 jam, dihapus setiap jam oleh
`commerce:shipping-rates:purge`. `computeWeightBucketGrams` milik
`domain/weight-bucket.ts` membulatkan total berat keranjang ke atas ke
kelipatan 100 g berikutnya, dilantaikan di 1000 g (berat minimum
tertagih RajaOngkir sendiri).

**Provider tidak pernah dipanggil di dalam transaksi database**
(ADR-0006/0010): `getCourierRates`/`resolveDestination` membaca cache
dalam satu transaksi pendek, memanggil provider tanpa transaksi terbuka
sama sekali, lalu menulis-balik dalam transaksi pendek kedua
(`ON CONFLICT ... DO UPDATE` — cache miss yang bersamaan hanya berarti
penulis terakhir yang menang).

**Quote**: `POST .../cart/quote` menerima `destination: {districtCode}`
opsional; dengan `shipping.courier.enabled`, provider yang dikonfigurasi,
dan sebuah destination, entri kurir pada `shippingOptions[]` adalah tarif
langsung per layanan (`{method:"courier", serviceId:"jne:REG", name,
cost, etd, available:true}`); jika tidak, satu placeholder
`available:false` dengan `note`. **Pembuatan pesanan** memvalidasi
pilihan `{method:"courier", serviceId}` terhadap tarif ter-cache yang
belum kedaluwarsa, dikunci dari `districtCode` milik alamat pengiriman
sendiri — tidak pernah panggilan provider langsung kedua di dalam
transaksi tulis `createOrderFromCart`; pilihan yang basi/tidak dikenal
menjawab `409 CART_CHANGED` yang sama seperti ketidakcocokan lainnya.

**Pengaturan**: `shipping.courier = {enabled, originDestinationId,
couriers[]}` (owner, `PUT /store-settings`) adalah sakelar on/off-nya,
asal RajaOngkir milik tenant sendiri, dan kode kurir mana yang di-quote.
`GET /api/v1/commerce/shipping/destinations?search=` (hanya owner,
`settings.update`) mendukung pemilih asal admin. `shipping.courierEnabled`
publik adalah turunan — `true` hanya saat `courier.enabled` DAN provider
dikonfigurasi, tidak pernah salinan mentah dari flag yang tersimpan.

## Outbox & OTP WhatsApp — SUDAH DIIMPLEMENTASIKAN (Issue #108, epic #33 — kontrak #106/ADR-0017 D5)

Outbox provider kedua, dimodelkan persis seperti `email` (ADR-0017 D1 —
setiap provider eksternal adalah port + adapter di dalam `commerce`): tabel
sendiri, job dispatcher, adapter `log` untuk dev/CI, pemanggilan provider
tidak pernah di dalam transaksi DB.

**Skema** (`sql/925`): `awcms_commerce_whatsapp_messages` (`queued ->
sending -> sent|failed`, lease klaim `attempts`/`next_attempt_at` — bentuk
identik dengan `awcms_email_messages`) dan
`awcms_commerce_whatsapp_delivery_attempts` (buku besar per-percobaan,
`UNIQUE (message_id, attempt_no)`). `to_phone` disimpan apa adanya — alasan
yang sama seperti header `sql/913` untuk `customers.phone`: adapter provider
tidak bisa mengirim pesan hanya dengan hash — berdampingan dengan
`to_phone_hash`/`to_phone_masked`. `sql/925` juga menambah kolom nullable
`phone_normalized` ke `awcms_commerce_customer_otps`, melonggarkan `NOT
NULL` milik `email_normalized` menjadi `CHECK` bahwa minimal satu identifier
ada.

**Domain**: `domain/whatsapp-provider.ts` (port `WhatsappProvider` —
`send`/`healthCheck`, mencerminkan `email-provider-contract.ts`), `domain/
whatsapp-templates.ts` (registry templat MODULE-LOCAL, in-code —
`commerce.customer_otp`/`commerce.order_paid`/`commerce.campaign`, rendering
`{{var}}` dengan allowlist variabel per templat; hanya `commerce.
customer_otp` yang tersambung ke pemanggil di issue ini — sengaja BUKAN
templat `email` yang berbasis DB dan bisa diedit per tenant, karena templat
WhatsApp juga tunduk pada proses persetujuan provider sendiri, mis.
`COMMERCE_META_WA_OTP_TEMPLATE` milik Meta).

**Infrastruktur** (`infrastructure/`): `fonnte-provider.ts` (`POST
{baseUrl}/send`, header `Authorization: <token>`, form `target`/`message`,
JSON `{status, reason?, id?}`), `meta-whatsapp-provider.ts` (Graph API `POST
/{phoneNumberId}/messages`, token `Bearer`, pesan TEMPLATE untuk OTP —
`{{1}}` diisi kode, nama templat dari `COMMERCE_META_WA_OTP_TEMPLATE` — atau
pesan TEKS bebas selainnya), `log-whatsapp-provider.ts` (baris log
terstruktur, SATU-SATUNYA tempat yang mencatat kode OTP apa adanya), dan
`whatsapp-provider-resolver.ts` (`COMMERCE_WHATSAPP_PROVIDER=fonnte|meta|log`,
menurun ke provider hasil-gagal yang bersih saat salah konfigurasi alih-alih
melempar error).

**Aplikasi**: `whatsapp-enqueue.ts` (`enqueueWhatsappMessage(tx, …)` — di
dalam transaksi milik PEMANGGIL sendiri, sama seperti enqueue alamat
langsung milik `email`), `whatsapp-dispatch.ts` (`dispatchWhatsappQueue`,
claim/send/finalize, lease, circuit breaker, backoff — `bun run
commerce:whatsapp:dispatch`, `*/2 * * * *`), `whatsapp-queue-purge.ts`
(retensi baris terminal — `bun run commerce:whatsapp:purge`, `*/15 * * *
*`), `whatsapp-message-directory.ts` (baca diagnostik berpaginasi keyset).
`COMMERCE_WHATSAPP_ENABLED=true` menggerbangi klaim, persis seperti
`EMAIL_ENABLED` menggerbangi dispatcher email.

**OTP sebagai `CustomerOtpChannel` ketiga** (`application/
whatsapp-otp-channel-adapter.ts`): `createWhatsappCustomerOtpChannel`
mengantre ke outbox di dalam transaksi YANG SAMA dengan baris OTP;
`createLogWhatsappCustomerOtpChannel` mencatat kode sebagai gantinya
(dev/CI). `resolveWhatsappCustomerOtpChannel`/`isWhatsappOtpChannelAvailable`
berbagi SATU gerbang, `COMMERCE_WHATSAPP_ENABLED === "true"` — kondisi yang
sama yang dipakai `dispatchWhatsappQueue` untuk memutuskan apakah akan
mengklaim apa pun sama sekali.

`POST .../account/otp/request` menerima `via?: "email"|"whatsapp"` (default
`email`). `via: "whatsapp"` mewajibkan `phone` (E.164 lewat `domain/
phone-normalisation.ts`), hanya pernah mendukung `purpose: "login"`
(kombinasi `register` adalah `400 VALIDATION_ERROR` — pendaftaran tetap
hanya OTP e-mail, tindak lanjut WhatsApp ADR-0016 D2 mendarat lebih sempit
dari kerangka "pelanggan tidak pernah perlu e-mail" milik ADR itu sendiri),
dan menjawab `409 CHANNEL_UNAVAILABLE` — diperiksa dan dijawab SEBELUM baris
OTP pernah diterbitkan — saat kanal nonaktif/tidak dikonfigurasi (fakta
konfigurasi, bukan oracle enumerasi baru: tidak bergantung pada apakah
telepon yang diberikan punya akun). `POST .../account/otp/verify` menerima
`phone` sebagai alternatif `email` (saling eksklusif; `identifierColumn`
memilih `phone_normalized` alih-alih `email_normalized` di `issueOtp`/
`consumeOtp` milik `customer-account-store.ts`), dan menyelesaikan akun
lewat `findAccountByPhone`, bukan `findAccountByEmail` — "login lewat
telepon" berarti akun yang baris PELANGGANnya membawa telepon itu.

**Diagnostik pemilik**: `GET /api/v1/commerce/whatsapp/messages`
(`commerce.whatsapp.read`, berpaginasi keyset, telepon tersamar saja) plus
layar minimal `/admin/commerce-whatsapp` (filter status, tanpa aksi
create/update/delete atas outbox di issue ini).

## Kotak masuk komersial — SUDAH DIIMPLEMENTASIKAN (Issue #111, epic #33 — kontrak #106/ADR-0017 D8)

Percakapan milik akun pelanggan terverifikasi dengan toko — bukan
pelanggan guest checkout, yang tidak punya baris akun untuk digantungi
percakapan.

**Skema** (`sql/927`): `awcms_commerce_conversations` (`account_id NOT
NULL` FK ke `awcms_commerce_customer_accounts`, `subject` 1-150 karakter,
`status` `open|closed`, `last_message_at`, boolean `unread_for_store`/
`unread_for_customer`) dan `awcms_commerce_messages` (append-only, seperti
`awcms_commerce_order_events` — tanpa `deleted_at`/`updated_at`; `sender`
`customer|store`, `sender_tenant_user_id` diisi hanya untuk pesan toko,
`body` 1-4000 karakter). `last_message_at`/kedua flag `unread_for_*`
adalah DENORMALIZED, dijaga selaras dengan setiap penyisipan pesan di
dalam TRANSAKSI YANG SAMA — tidak pernah nilai turunan join saat baca.

**Aplikasi** (`application/conversation-directory.ts`): sisi pelanggan
(`listConversationsForAccount`, `openConversation`,
`fetchConversationForAccount` — menandai percakapan terbaca untuk
pelanggan, `postCustomerMessage` — berbentuk `409` `{kind:"closed"}`
begitu percakapan ditutup) dan sisi toko (`listConversationsForAdmin` —
bisa difilter `status`/`unreadForStore`, `fetchConversationForAdmin` —
menandai terbaca untuk toko, `postStoreReply` — secara implisit membuka
kembali percakapan yang tertutup DAN mengantre e-mail balasan dalam
transaksi yang sama, `setConversationStatus` — tutup/buka eksplisit tanpa
pesan). `ensureConversationReplyTemplate` men-seed templat e-mail
`derived.commerce_conversation_reply` otomatis saat pertama kali tak
ditemukan, pola identik yang sudah ditetapkan
`ensureCustomerOtpTemplate` milik `application/
customer-otp-channel-adapters.ts`.

**Rute**: `GET`/`POST /api/v1/commerce/storefront/account/conversations`,
`GET .../{id}` (bearer), `POST .../{id}/messages` (bearer, dibatasi laju
10/jam per akun lewat `COMMERCE_CONVERSATION_POST_RATE_LIMIT_MAX`); pemilik
`GET`/`PATCH /api/v1/commerce/conversations(/{id})`,
`POST .../{id}/messages` (`commerce.conversations.read|update`,
`Idempotency-Key` wajib pada balasan — satu-satunya mutasi berisiko tinggi
di permukaan ini, karena mengantre e-mail).

**Layar admin**: `/admin/commerce-inbox` — daftar percakapan dengan filter
status/belum-dibaca dan lencana belum-dibaca, tampilan percakapan (`?id=`),
formulir balasan (skrip klien mengirim `Idempotency-Key`), dan tombol
tutup/buka kembali.

**Data subjek**: kedua tabel `unreachableBySubject: true` di `module.ts`
— akun pelanggan pemilik tidak membawa id `tenant_user`/`identity`/
`profile`/`principal` (ADR-0016 D1), celah identik yang sudah didokumentasi
`commerce.customer_addresses`/`commerce.wishlists`; pemilik akun mencapai
percakapan miliknya sendiri lewat rute bearer di atas, di luar cakupan
mesin otomatis per-subjek repo ini menurut konstruksinya.

## Kampanye pelanggan — SUDAH DIIMPLEMENTASIKAN (Issue #114, epic #33 — kontrak #106/ADR-0017 D9)

Pengiriman massal e-mail/WhatsApp yang bergerbang consent, memakai KEMBALI
outbox yang sama yang sudah dipakai D5/D8 — tanpa mekanisme pengiriman
ketiga.

**Skema** (`sql/929`): `awcms_commerce_customer_accounts` mendapat kolom
`marketing_consent_at timestamptz` (nullable — non-null berarti setuju
pada saat itu); `awcms_commerce_campaigns` (`channel` `email|whatsapp`,
`subject`/`body`, `audience jsonb`, `status`
`draft|scheduled|sending|sent|cancelled`, `scheduled_at`/`sent_at`,
`recipient_count`) dan `awcms_commerce_campaign_recipients` (satu baris
per penerima yang terselesaikan, `UNIQUE (campaign_id, customer_id)`,
`address_masked` tidak pernah alamat mentah, `status`
`queued|enqueued|skipped`) — buku besar keteresumeannya/audit yang
diandalkan pengiriman parsial. Seed permission `sql/930`
(`commerce.campaigns.{read,update,send}`).

**Domain** (`domain/campaign-validation.ts`, `domain/campaign-content.ts`):
validasi bentuk audiens (`{levels[], hasAccount, lastOrderSince}`),
kewajiban `subject` bersyarat kanal (wajib untuk `email`, diabaikan untuk
`whatsapp`), dan rendering `{{name}}`/`{{storeName}}` yang di-allowlist —
placeholder yang tak dikenal dibiarkan sebagai literal, fail-closed.

**Aplikasi** (`application/campaign-directory.ts`): CRUD (`create` selalu
`draft`, `update` hanya selagi `draft`), `resolveCampaignAudiencePage`/
`countCampaignAudience` — SATU-SATUNYA tempat consent
(`marketing_consent_at IS NOT NULL`) dan syarat alamat-per-kanal
ditegakkan, keduanya dipanggang ke dalam klausa WHERE itu sendiri, tidak
pernah difilter belakangan; `sendCampaign` (pindah ke `scheduled`,
`scheduled_at = now()` untuk kirim seketika — penyebaran sesungguhnya
terjadi kemudian, pada giliran dispatcher sendiri) dan `cancelCampaign`
(menghentikan pengiriman lebih lanjut; penerima yang sudah dienqueue tidak
dibatalkan-kirim).

**Dispatcher** (`application/campaign-dispatch.ts`, skrip
`commerce:campaigns:dispatch`, tiap 1-2 menit sebagai `awcms_worker`):
CLAIM (satu transaksi singkat, `FOR UPDATE SKIP LOCKED` atas kampanye yang
jatuh tempo/dilanjutkan) → PAGE (loop halaman 200 pelanggan yang belum
tercatat — `NOT EXISTS` milik resolver terhadap
`awcms_commerce_campaign_recipients` inilah yang membuatnya bisa
dilanjutkan tanpa kolom cursor terpisah; memeriksa ulang `status` hidup
kampanye sebelum tiap halaman, jadi `cancel` menghentikan pengiriman lebih
lanjut seketika) → FINALIZE (halaman kosong menandai kampanye `sent`,
`recipient_count` = total baris penerima). Penyebaran e-mail memanggil
`enqueueDirectAddressEmail` milik modul `email` sendiri terhadap templat
pass-through `derived.commerce_campaign` (di-seed otomatis saat pertama
tak ditemukan, pola sama yang ditetapkan
`ensureConversationReplyTemplate`) — `commerce` tidak pernah menulis
`awcms_email_messages` langsung (`modules:table-writes:check`). Penyebaran
WhatsApp memakai kunci templat `commerce.campaign` yang sudah dicadangkan
(`domain/whatsapp-templates.ts`).

**Rute**: pemilik `GET`/`POST /api/v1/commerce/campaigns`,
`GET`/`PATCH .../{id}`, `POST .../{id}/preview` (hanya hitungan, tidak
pernah daftar yang terselesaikan), `POST .../{id}/{send,cancel}`
(`Idempotency-Key` wajib, digerbang permission terpisah
`commerce.campaigns.send` — peran yang dipercaya menyusun/mengedit tidak
otomatis dipercaya mengirim/membatalkan). `GET`/`PATCH
/api/v1/commerce/storefront/account/me` mendapat `marketingConsent:
boolean` — hanya diubah oleh akun itu sendiri, diaudit pada pemberian
maupun pencabutan.

**Layar admin**: `/admin/commerce-campaigns` — daftar kampanye, formulir
buat-draf (kanal, subjek, pesan, centang level pelanggan), dan panel
detail/editor (`?id=`) dengan tombol pratinjau-audiens (hanya hitungan)
serta aksi kirim/batalkan (keduanya digerbang `window.confirm`).

## Payment gateway — pembuatan sesi (Issue #110, epic #33 — kontrak #106/ADR-0017 D2/D3)

`PaymentGatewayProvider` (`domain/payment-gateway-provider.ts`) adalah
sebuah port — `createSession`, `fetchStatus`, `verifyWebhook` — dibentuk
seperti `ShippingRateProvider`: `infrastructure/midtrans-provider.ts`
(Snap `POST /snap/v1/transactions`, `GET /v2/{orderId}/status`,
`withTimeout` + `getProviderCircuitBreaker("commerce-midtrans")`, base
URL sandbox/production lewat `COMMERCE_MIDTRANS_IS_PRODUCTION`) dan
`infrastructure/log-payment-gateway-provider.ts` (tanpa panggilan
jaringan; `redirectUrl` adalah `${COMMERCE_STOREFRONT_PUBLIC_URL}/
pesanan?kode=...&gateway=log`; `fetchStatus` menjawab `paid` begitu 60
detik nyata berlalu, lewat clock yang bisa disuntik dan timestamp yang
dilipat ke dalam `providerRef` — deterministik, tanpa sleep di test)
sama-sama mengimplementasikannya, di-resolve
`infrastructure/payment-gateway-provider-resolver.ts` dari
`COMMERCE_PAYMENT_GATEWAY` (`log` ditolak di luar non-production).

**Skema** (`sql/926`): `awcms_commerce_payment_gateway_sessions` (satu
baris per percobaan hosted-checkout, `UNIQUE (provider, provider_ref)`),
`awcms_commerce_payment_events` (buku besar anti-replay D2, `UNIQUE
(tenant_id, provider, event_key)` — ditulis oleh rute intake webhook,
lihat "Payment gateway — intake webhook + rekonsiliasi" di bawah), `awcms_commerce_webhook_endpoints`
(token opak ter-hash per (tenant, provider)); `orders` mendapat
`gateway_provider`/`gateway_ref`. Fungsi `SECURITY DEFINER`
`awcms_resolve_commerce_webhook_endpoint(token_hash)` meniru pola
bootstrap `awcms_resolve_tenant_domain_lookup` persis.

**Application** (`application/payment-gateway-directory.ts`):
`createGatewaySession(sql, tenantId, orderCode, auth, provider,
providerKey)` — memvalidasi pesanan (`payment.method: "gateway"`,
`pending_payment`) dan mengecek sesi yang masih hidup dalam satu transaksi
pendek, memanggil provider tanpa transaksi terbuka, menyimpan dalam
transaksi pendek kedua (ADR-0006/0010, disiplin yang sama yang sudah
ditetapkan `getCourierRates` milik `shipping-rate-directory.ts`);
pembuatan ganda yang benar-benar bersamaan tertangkap constraint `UNIQUE
(provider, provider_ref)` dan mengambil-ulang pemenang, bukan 500. Auth
adalah `{phone}` atau bearer pelanggan, sesuai pola bearer opsional milik
`POST .../orders`; telepon salah, pesanan tak dikenal, atau bearer hidup
milik pemilik pesanan lain semuanya menjawab `404` netral yang sama
seperti rute pelacakan pesanan.

**Quote**: `paymentMethods[]` milik `POST .../cart/quote` mendapat
`{method: "gateway", available}` — `true` hanya saat
`payment.gateway.enabled` DAN provider dikonfigurasi.

**Rute**: `POST .../storefront/orders/{orderCode}/payment-gateway/sessions`
(anonim, dibatasi laju, `409 PAYMENT_NOT_APPLICABLE`, `503
GATEWAY_UNAVAILABLE`); owner `GET|POST /api/v1/commerce/webhook-endpoints`
(daftar tersamar; token mentah ditampilkan tepat sekali saat pembuatan,
di-hash saat disimpan — sengaja TIDAK ber-idempotency-key, alasan yang
sama yang diberikan `machine-credential-directory.ts` milik
`identity-access` untuk rute penerbitannya sendiri) dan `DELETE
.../webhook-endpoints/{id}` (cabut, idempoten); keduanya digerbangi
`commerce.webhook_endpoints.update`.

**Pengaturan**: `payment.gateway = {enabled}` (owner, `PUT
/store-settings`) adalah sakelar on/off-nya; `payment.gatewayEnabled`
publik diturunkan — `true` hanya saat `gateway.enabled` DAN provider
dikonfigurasi, tidak pernah salinan mentah flag tersimpan.
`/admin/commerce-settings` mendapat sakelar enable plus panel
webhook-endpoints.

## Payment gateway — intake webhook + rekonsiliasi SUDAH DIIMPLEMENTASIKAN (Issue #113, epic #33 — kontrak #106/ADR-0017 D2)

**Rute webhook** (`src/pages/api/v1/commerce/webhooks/[provider]/
[endpointToken].ts`, tipis sesuai `awcms-new-endpoint`; logikanya di
`application/payment-webhook-intake.ts`): publik, `POST`-saja, terdaftar
di daftar pengecualian `lib/security/api-body-auth-boundary.ts` (keluarga
yang sama dengan entri HMAC `/api/v1/sync/push`). Urutan gerbang:
pembacaan body (dibatasi ukuran) → `resolveWebhookEndpoint` (meng-hash
token, memanggil `awcms_resolve_commerce_webhook_endpoint` pada pool
client biasa, belum ada konteks tenant) → token tak dikenal/dicabut ATAU
segmen path `{provider}` tidak cocok ATAU tidak ada provider dikonfigurasi
— semuanya menjawab `404` netral YANG SAMA, dipadatkan ke latensi lantai
(`NEUTRAL_404_MIN_LATENCY_MS`) → `provider.verifyWebhook(...)` (signature
salah → `401`) → `applyVerifiedWebhookEvent`, SATU transaksi
`withTenantOrThrow`: `INSERT … ON CONFLICT (tenant_id, provider,
event_key) DO NOTHING` (0 baris → `{kind: "replay"}`, `200`, tanpa efek
samping) → penerapan sesuai pemetaan status. Rute ini TIDAK PERNAH
memanggil `fetchStatus` milik provider — itu tetap urusan eksklusif job
reconcile.

**Penjaga nominal** (`domain/payment-amount-guard.ts`, `sql/934`):
`gross_amount` yang dilaporkan provider harus sama dengan `total` pesanan
dalam sen bulat sebelum transisi pesanan APA PUN. Ketidakcocokan/nominal
tak terbaca mencatat peristiwa sebagai `outcome = 'amount_mismatch'`,
menulis entri audit, memindah sesi ke `failed` hanya pada kegagalan
terminal provider (selain itu dibiarkan `pending`), tidak pernah menandai
pesanan lunas, dan tetap menjawab `200`. Job reconcile menerapkan penjaga
yang sama pada `gross_amount` dari `fetchStatus`.

**`markOrderPaidBySystem`** (`application/order-directory.ts`) — aktor
`system`, menyetel `paid_at`/`payment_status`/`gateway_provider`/
`gateway_ref`, satu baris `order_events`, dan satu entri audit-log;
idempoten (sudah-`paid` atau status apa pun selain `pending_payment`
adalah no-op, tidak pernah error). `domain/order-status.ts` mendapat edge
`system` `pending_payment -> paid` di samping `-> expired` yang sudah ada.
**`paid -> refunded` sengaja TIDAK PERNAH diterapkan otomatis** — tidak
ada status pesanan `refunded` sama sekali; refund yang dilaporkan gateway
dicatat hanya sebagai peristiwa pembayaran, dan owner me-refund secara
manual lewat aksi admin `-> cancelled` yang sudah ada. Lihat header
`order-status.ts` sendiri untuk alasan lengkapnya.

**Job reconcile** `commerce:payments:reconcile`
(`scripts/commerce-payments-reconcile.ts`, terdaftar di `jobs` milik
`module.ts`, `*/2 * * * *`, work class `background_sync`): untuk setiap
tenant aktif, setiap sesi gateway yang masih `pending` lebih dari 2 menit
mendapat satu panggilan `provider.fetchStatus` TANPA transaksi terbuka
(timeout + circuit breaker hidup DI DALAM adapter itu sendiri); kegagalan
fetch cukup melewati sesi itu untuk tick ini. Setiap sesi yang sudah lewat
`expires_at` di-expire terlepas dari jawaban `fetchStatus`.
`application/payment-reconcile.ts` juga mengekspos
`reconcileOneOrderPaymentSession` — varian tercakup satu-pesanan milik
aksi admin "Cek status" (`POST /api/v1/commerce/orders/{id}/payment-
gateway/reconcile`, digerbangi `commerce.orders.update`,
`Idempotency-Key` wajib), tidak pernah batch penuh.

**Admin**: layar daftar pesanan (`/admin/commerce-orders` — modul ini
tidak punya halaman DETAIL pesanan terpisah) mendapat panel baca-saja
yang bisa diperluas per baris (status/provider/kedaluwarsa sesi gateway
plus daftar peristiwa pembayaran, lewat field `gateway` baru pada `GET
/api/v1/commerce/orders/{id}`) dan tombol "Cek status" di atas.

**Tes**: unit test mencakup urutan gerbang rute (publik/POST-saja, token
tak dikenal → 404 dipadatkan), kegagalan `verifyWebhook` → 401, dan
replay → 200 no-op, semuanya dengan provider tiruan; sebuah integration
test terhadap Postgres nyata yang sudah dimigrasikan mencakup jalur penuh
webhook-`paid`, replay-adalah-no-op, job reconcile dengan provider `log`,
dan isolasi RLS lintas-tenant milik token webhook-endpoint.

## Toggle fitur & harga bertingkat — SUDAH DIIMPLEMENTASIKAN (Issue #118, epic #33 C9 — kontrak #106/ADR-0017 D10, ADR-0016 D6)

Layar "Fitur" BjekMart adalah `settings.defaults.features` milik `module.ts`
sendiri — `{pos, inbox, campaigns, gateway, courier}`, setiap flag `true`
secara default (`DEFAULT_COMMERCE_FEATURES` milik
`domain/commerce-features.ts`) — dibaca/ditulis lewat layanan
pengaturan-tenant GENERIK milik `module_management`
(`fetchModuleSettingsView`/`updateModuleSettings`, `awcms_module_settings`),
kali pertama `commerce` mendeklarasikan kontrak `settings` sama sekali.
`resolveCommerceFeatures` me-resolve setiap flag secara INDEPENDEN terhadap
default (tidak pernah mengasumsikan seluruh objek `features` ada), yang
membuat flag keenam di masa depan bebas-migrasi untuk tenant yang sudah
menyimpan baris pengaturan — alasan yang sama yang sudah diberikan merge
dangkal tingkat-atas milik `module-settings.ts` sendiri untuk modul secara
keseluruhan, satu tingkat lebih dalam.

**Aturan 409-vs-404** (header `domain/commerce-features.ts` sendiri,
`requireCommerceFeatureForOwnerRoute`/`requireCommerceFeatureForPublicRoute`
milik `application/commerce-feature-gate.ts`): fitur nonaktif menjawab
`409 FEATURE_DISABLED` pada setiap rute pemilik yang TERAUTENTIKASI
(pemanggil sudah membuktikan siapa dirinya — konfigurasi tenant sendirilah
yang menghalanginya, dan mereka perlu melihat alasannya) dan `404` netral —
atau, pada satu-satunya rute yang sudah punya kode "tidak dapat dipakai
sekarang" tersendiri, `503 GATEWAY_UNAVAILABLE` yang sudah ada — pada
setiap rute PUBLIK/anonim (tidak pernah `409`, yang akan memberitahu
prober bahwa sebuah rute memang ada, aturan anti-oracle yang sama yang
sudah ditegakkan `public-commerce-tenant.ts` untuk tenant yang tak
ter-resolve).

**Yang di-gate**: kotak masuk (pemilik `/conversations*`, etalase
`/storefront/account/conversations*`), kampanye (pemilik `/campaigns*`),
gerbang (pemilik `/webhook-endpoints*`; etalase
`.../payment-gateway/sessions` dilipat ke 503 yang sudah ada; intake
PUBLIK `/webhooks/{provider}/{endpointToken}` menjawab 404 netral yang
sama seperti token tak dikenal), kurir (pemilik
`GET /shipping/destinations`). `pos` belum punya rute penegak — issue #116
memasang gate itu di cabangnya sendiri, secara paralel; flag-nya sudah ada
sekarang agar bentuk dokumen pengaturan tidak berubah lagi saat itu tiba.

**Navigasi admin** menyembunyikan entri sidebar Kotak Masuk/Kampanye begitu
fiturnya nonaktif (`ModuleNavigationEntry.requiredFeature`, field baru dan
aditif pada kontrak entri-nav bersama; di-resolve per-request di
`AdminLayout.astro` dari panggilan `fetchCommerceFeatures` yang SAMA yang
dipakai rute — `sidebar-menu.ts`/`sidebar-menu-config.ts` milik
`module_management` sendiri tidak pernah mengimpor `commerce`, menjaga arah
ketergantungan modul satu-arah yang sudah ada).

**Pengaturan toko publik** (`GET .../store-settings/public`) —
`toPublicRecord` kini menerima dua parameter lagi, keduanya berdefault
sehingga setiap titik panggil sebelum-#118 (termasuk literal test) tetap
kompilasi dan menghitung jawaban yang SAMA seperti sebelumnya:
`shipping.courierEnabled`/`payment.gatewayEnabled` mendapat suku-DAN
TAMBAHAN `features.courier`/`features.gateway` (nama tak berubah, disiplin
masking yang sama), dan dua boolean tingkat-atas baru bergabung —
`inboxEnabled`/`campaignsEnabled` (flag mentah; keduanya tak punya toggle
pengaturan-toko sendiri untuk di-AND-kan) dan `whatsappOtpEnabled`
(`isWhatsappProviderConfigured` baru milik
`infrastructure/whatsapp-provider-resolver.ts` — BUKAN flag `features.*`,
karena Issue #108 tak pernah mendapat satu; `masuk.astro`/`daftar.astro`
milik `apps/storefront` sudah membaca kunci persis ini).

**Formulir pengaturan**: `/admin/commerce-settings` mendapat bagian "Fitur"
yang menulis lewat rute GENERIK `PATCH /api/v1/tenant/modules/commerce/settings`
— yaitu `updateModuleSettings`, diaudit di bawah
`module_management.settings_updated` dengan diff aman berupa nama-kunci
saja — di-gate pada `module_management.settings.update`, izin yang BERBEDA
dari `commerce.settings.update` milik layar ini sendiri (perbedaan yang
sama yang sudah ditarik bagian webhook-endpoints terhadap
`commerce.webhook_endpoints.update`). Klien selalu mengirim SELURUH objek
`features`: merge `updateModuleSettings` bersifat dangkal dan tingkat-atas,
sehingga patch parsial akan diam-diam menonaktifkan setiap flag yang belum
baru saja disentuh tenant.

**Harga bertingkat** (menutup catatan tertangguh
[ADR-0016](../../../../../docs/adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md)
D6 sendiri): `quoteCart` milik `domain/cart-quote.ts` menerima
`customerLevel` opsional (1–4); `resolveTierPrice` memilih `price_level_{n}`
untuk baris tanpa flash sale aktif dan tanpa override harga varian, jatuh
kembali ke `price` saat merchant tak pernah mengatur tingkat itu atau
levelnya 1/tidak ada — diterapkan SEBELUM `discountPercent` milik
`computeFinalPrice` sendiri, sehingga aturan diskon yang sama tetap berlaku
apa pun harga dasar yang menang. `POST .../storefront/cart/quote`
me-resolve level dari `Authorization: Bearer` OPSIONAL
(`requireCustomerSession`; hilang/tak valid tak pernah menggagalkan quote —
itu hanya berarti level 1). `createOrderFromCart` milik
`application/order-directory.ts` kini mengambil baris pelanggan milik akun
(saat `accountCustomerId` ada) SEBELUM re-quote internalnya, bukan sesudah,
sehingga level yang SAMA memberi harga pada quote yang sudah dilihat
pembeli maupun pesanan yang menjadi hasilnya — quote dan pesanan tak pernah
bisa berselisih. **Level di-snapshot pada pesanan hanya secara IMPLISIT**,
lewat harga satuan yang dipanggang ke `order_items.unit_price` saat
pembuatan; tidak ada kolom `orders.customer_level` terpisah (issue ini tak
perlu migrasi), dan perubahan level pelanggan di kemudian hari tak pernah
mengubah harga pesanan lampau secara retroaktif. Edit `level` di layar
admin pelanggan (`/admin/commerce-customers`, `commerce.customers.update`,
diaudit) sudah ada sejak Issue #29 — #118 tidak menambah permukaan
pengeditan pelanggan baru, hanya konsumen sisi quote/pesanan atas kolom
yang sama itu.

## Laporan penjualan — SUDAH DIIMPLEMENTASIKAN (Issue #117, epic #33 — kontrak #106/ADR-0017 D7)

Tiga proyeksi `cursor_table` yang disumbangkan modul ini ke mesin
`reporting` (Issue #753) dari `module.ts`-nya sendiri
(`reportingProjections`) — `commerce.sales_daily`,
`commerce.sales_by_product`, `commerce.sales_by_category` — di atas
`awcms_commerce_order_events`, log transisi status yang append-only. Mesin
tetap memegang kursor, kesegaran, run rebuild, rekonsiliasi, dan mesin
ekspornya; modul ini memasok deskriptor, aturan delta murni, dan sink yang
menulis tiga tabel miliknya sendiri (`sql/933`).

| Bagian | Di mana | Apa yang dilakukan |
| -------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ---------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aturan delta | `domain/sales-report-deltas.ts` (murni) | `resolveSalesDeltaDirection`: `-> paid` dari status yang belum terbayar adalah `+1`; `-> cancelled                                                                                                                                                                                                                                                                                                                                                                                                                                 | refunded` dari status terbayar (`paid | processing | shipped | completed`) adalah `-1`; selainnya `0`(pembuatan, langkah pemenuhan, pembatalan/kedaluwarsa yang belum pernah dibayar, refund setelah pembatalan).`computeSales{Daily,ByProduct,ByCategory}Delta(s)` mengubah satu snapshot pesanan + tanda + hari menjadi delta aditif dalam sen bilangan bulat (`bigint`, `toCents`); `formatCentsDelta`merender string`numeric(14,2)`BERTANDA. Hari =`paid_at`pesanan dalam`SALES_REPORT_TIME_ZONE` (`Asia/Jakarta`), sehingga pembalikan mendarat di baris hari yang sama dengan pembayarannya |
| Kunci | `domain/sales-report-keys.ts` | Kunci proyeksi, kunci stream bersama, kunci metrik skalar (`paid_events`), dan kunci kontrol rekonsiliasi |
| Sink + hook | `application/sales-report-projection.ts` | `applySales{Daily,ByProduct,ByCategory}Batch` (para `ProjectionDimensionalSink`): buang baris `0`, muat satu snapshot per pesanan (header + item hidup + kategori produk tiap item, LEFT JOIN), jalankan fungsi delta, upsert `ON CONFLICT DO UPDATE SET x = x + EXCLUDED.x`. Para `ProjectionDimensionalContract`: `resetForTenant` (reset rebuild), `readProjectionTotals` (`SUM()` atas tabel), `computeSourceTotals` (menyusuri seluruh aliran peristiwa lewat fungsi delta yang sama), `exportRows` (ekspor CSV/JSON tabular) |
| Validasi query | `domain/sales-report-query.ts` (murni) | `from`/`to` hari zona-laporan `YYYY-MM-DD` inklusif, bawaan 30 hari terakhir, paling banyak 366; `limit` 1–200, bawaan 20 |
| Pembacaan | `application/sales-report-directory.ts` | `listSalesDaily`, `listSalesByProduct` (tergabung, terlaris menurut bruto lebih dulu), `listSalesByCategory` (sentinel → `categoryId: null`) — dipakai rute dan layar sekaligus |
| Rute | `src/pages/api/v1/reports/commerce/{sales-daily,sales-by-product,sales-by-category}.ts` | `defineTenantRoute`, `reporting.dashboard.read`, work class `reporting`; dimiliki modul ini lewat `api.routes: ["/api/v1/reports/commerce"]` |
| Layar | `src/pages/admin/commerce-reports.astro` | Rentang tanggal (formulir GET), tiga tabel, panel kesegaran (`reporting.projections.read`), **Ekspor CSV** per proyeksi lewat `POST /api/v1/reports/exports/trigger` (`reporting.exports.export`), riwayat ekspor terbaru dengan tautan unduh (`reporting.exports.read`). Entri nav urutan 16, digerbangi `reporting.dashboard.read` |
| Uji | `tests/commerce-sales-report-domain.test.ts`, `tests/integration/commerce-sales-reports.integration.test.ts` | Aturan murni + pasangan registri; terhadap Postgres nyata: paid → baris, batal-setelah-bayar → dikurangkan di hari yang sama, rebuild identik byte-per-byte dengan live, rekonsiliasi tanpa selisih (dan tabel yang diutak-atik MEMANG ditandai), ekspor tabular, RLS |

**Satu-satunya perubahan mesin** (`MODULE_CONTRACT_VERSION` 4.1.0 → 4.2.0,
aditif): `ProjectionCursorStream.dimensional` (`selectColumns` +
`applyBatch`) dan `ProjectionDescriptor.dimensional` (empat hook). Worker
inkremental dan pass rebuild memanggil sink pada setiap batch yang diambil
di dalam transaksi yang sama, setelah advisory lock (tenant, proyeksi) dan
sebelum kursor maju; reset rebuild memanggil `resetForTenant` dalam
transaksi yang sama dengan reset kursor/metrik; rekonsiliasi menggabungkan
total kontrol berdimensi ke baris detailnya; pembuatan ekspor menulis baris
berdimensi alih-alih snapshot metrik skalar.
`reporting:projections:registry:check` memaksa pasangan itu dua arah. Tidak
ada deskriptor lama yang berubah.

**Mengapa `from_status` yang memutuskan "setelah peristiwa paid".** Graf
status (`domain/order-status.ts`) hanya membiarkan pesanan mencapai status
terbayar lewat `paid`, sehingga peristiwa yang MENINGGALKAN status terbayar,
secara konstruksi, adalah peristiwa setelah peristiwa paid — dapat diputuskan
dari satu baris yang ada di tangan, tanpa state per pesanan yang harus dibawa
antar-pass. `refunded` bukan status yang dipancarkan graf saat ini (refund
datang lewat `payment_status`), tetapi kontrak menamainya dan notifikasi
refund gateway mungkin mencatatnya, jadi ditangani persis seperti
`cancelled`; `cancelled -> refunded` tidak berkontribusi apa pun, sehingga
sebuah pesanan tak pernah dikurangkan dua kali.

**Keterbatasan yang diketahui — kategori adalah join hidup.**
`awcms_commerce_order_items` menyimpan snapshot nama produk tetapi bukan
kategorinya, sehingga atribusi per kategori membaca `products.category_id`
saat pemrosesan; mengubah kategori produk tidak memindahkan penjualan
lampau, dan rebuild mengatribusikannya ulang di bawah kategori baru. Total
kontrol rekonsiliasi tidak bergantung kategori, jadi ini perbedaan antara
dua rebuild, bukan selisih rekonsiliasi.

**Grant worker, retensi.** `awcms_worker` mendapat `SELECT, INSERT, UPDATE,
DELETE` pada ketiga tabel (`sql/933`, dicerminkan di `WORKER_ROLE_GRANTS`) —
upsert butuh UPDATE, purge data-lifecycle generik butuh DELETE; delete milik
reset rebuild sendiri berjalan sebagai `awcms_app` dalam transaksi rute API.
Retensi dijawab tiga deskriptor `dataLifecycle` di `module.ts` (kursor
`day`, 365–3650 hari, jendela yang sama dengan `commerce.order_events`:
baris yang lebih tua dari retensi sumbernya tak pernah bisa dibangun ulang
dan aman dipurge); data subjek oleh `NO_SUBJECT_DATA` di ledger skrip —
agregat turunan yang dapat dibangun ulang, tentang tidak seorang pun.

## Kasir (POS) — SUDAH DIIMPLEMENTASIKAN (Issue #116, epic #33 C7 — kontrak #106/ADR-0017 D6)

Kasir BjekMart sebagai satu jalur pembuatan pesanan lagi di atas tabel
pesanan, mesin quote, dan graf status yang SAMA — bukan buku penjualan
kedua. Anggota staf yang memegang `commerce.pos.create` mencatat penjualan
konter; pesanan dibuat SUDAH `paid`, dikaitkan ke pelanggan walk-in atau
pelanggan yang teridentifikasi lewat telepon, dan distempel `channel =
'pos'`.

| Bagian                  | Di mana                                                                                                                                 | Yang dilakukannya                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skema                   | `sql/931`, `sql/932`                                                                                                                    | `orders.channel text NOT NULL DEFAULT 'storefront' CHECK IN ('storefront','pos')`; `orders.pos_cashier_tenant_user_id uuid` (stempel biasa — BUKAN FK: catatan fiskal hidup lebih lama daripada akun staf); CHECK `payment_method` di-drop dan dibuat ulang dengan `cash` ditambahkan (alasan ia `text + CHECK`, bukan `ENUM`); `(tenant_id, channel, created_at DESC)` untuk pemindaian riwayat; indeks parsial `(tenant_id, pos_cashier_tenant_user_id, created_at DESC) WHERE … IS NOT NULL` untuk filter kasir; satu seed izin `commerce.pos.create`. Tanpa tabel baru, tanpa grant worker baru.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Domain                  | `domain/pos-order-validation.ts`, `domain/commerce-order-types.ts`, `domain/phone-normalisation.ts`                                     | `PaymentMethod` += `"cash"` (di-re-export oleh `packages/kontrak`); allow-list `order-request-validation.ts` milik storefront sengaja TIDAK diperlebar. `validateCreatePosOrderInput(body, headerIdempotencyKey)`: `lines[] {productId, variantId?, quantity 1..10000}`, `customer {name?, phone?}` opsional, `payment {method: cash\|manual_qris, amountTendered}` — `amountTendered` WAJIB untuk tunai sebagai STRING `numeric(14,2)` (angka JSON ditolak), dipaksa `null` untuk QRIS. `computeChange(amountTendered, total)` mengurangkan dalam sen `bigint`, mengembalikan string (ADR-0003), melempar `InsufficientTenderError` (membawa `shortfall`) saat pembayaran kurang. `POS_WALK_IN_CUSTOMER_SENTINEL_PHONE = "+620000000000"`, `POS_WALK_IN_CUSTOMER_NAME = "Pelanggan Walk-in"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Aplikasi                | `application/pos-directory.ts`                                                                                                          | `createPosOrder`: pencarian idempotensi (scope `commerce.pos.create`, hash terikat ke tenant user yang bertindak; ketidakcocokan → `IdempotencyPayloadMismatchError`) → pelanggan LEBIH DULU (tanpa telepon → baris walk-in lewat `findOrCreateCustomerByPhone` + sentinel; dengan telepon → cari-atau-buat ternormalisasi, outcome `invalid_phone` bila tidak dapat dinormalisasi; `level` pelanggan memberi harga quote, #118) → `buildCartQuote` (`self_pickup`, tanpa voucher/asuransi/alamat; hanya `canCheckout` yang memutuskan — tenant yang tidak pernah mengaktifkan self-pickup tetap bisa berjualan di konter; pengaturan pajak toko berlaku) → sisipkan pesanan (`pending_payment`/`unpaid`/`channel pos`/stempel kasir) + item, kurangi stok/kuota flash sale, baris `order_events` awal beraktor `admin`, audit `commerce.pos.sale` (tanpa PII), `commerce.order.created` (`payload.channel: "pos"`) → `applyPosOrderPaidTransition` (`order-directory.ts`, `transitionOrderStatus` bersama dengan aktor `admin`: `paid_at`, `payment_status paid`, baris `order_events` kedua, audit `update`, `commerce.order.paid` — yang dikonsumsi proyeksi #117) → `saveIdempotencyRecord` atas body 201. `listPosOrders`: keyset, `channel = 'pos'`, `dateFrom`/`dateTo` inklusif, `cashierTenantUserId`, 50/halaman. |
| Pengecualian storefront | `application/order-directory.ts`                                                                                                        | `fetchOrderForTracking`, `listOrdersForAccount`, `fetchOrderForAccount` hanya melayani `channel = 'storefront'` (telepon sentinel terdokumentasi — menghormatinya pada pencarian pelacakan akan membuat setiap struk walk-in terbaca lewat kode pesanan); `createOrderFromCart` menolak telepon sentinel sebagai identitas pelanggan (`invalid_phone`). Daftar pesanan admin tetap tidak membedakan channel.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Rute                    | `pages/api/v1/commerce/pos/orders/index.ts`                                                                                             | `defineTenantRoute`, kedua handler di-gate `requireCommerceFeatureForOwnerRoute(tx, tenantId, "pos")` (→ `409 FEATURE_DISABLED`). `GET` (`commerce.orders.read`): `?cursor&dateFrom&dateTo&cashier` (`YYYY-MM-DD` polos mencakup seluruh hari UTC; `cashier` harus UUID). `POST` (`commerce.pos.create`): header `Idempotency-Key` WAJIB (`400 IDEMPOTENCY_REQUIRED`), `readJsonBody`, → `201` record pesanan admin + `change`/`amountTendered`/`cashierTenantUserId`; `400 VALIDATION_ERROR` (termasuk telepon yang tidak dapat dinormalisasi), `409 IDEMPOTENCY_CONFLICT` / `CART_CHANGED` (`details.quote`) / `INSUFFICIENT_TENDER` (`details.shortfall`); `IdempotencyRaceLostError` di-replay/409 seperti rute storefront.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Layar admin             | `pages/admin/commerce-pos.astro`                                                                                                        | `loadAdminScreen`, entri salah-satu-dari `commerce.pos.create` (panel penjualan) / `commerce.orders.read` (tab riwayat, `?tab=history`); satu pemberitahuan "dimatikan" saat `features.pos` false. Penjualan baru: pencarian produk debounced atas `GET /api/v1/commerce/products?q=&status=active` milik owner yang sudah ada (varian ditampilkan satu per satu, stok habis dinonaktifkan), keranjang dengan kuantitas yang dapat diedit dan pratinjau subtotal dalam sen `bigint`, nama/telepon pelanggan opsional, tunai/QRIS dengan jumlah dibayar + kembalian langsung, catatan, kirim dengan `Idempotency-Key` baru per set percobaan (`sendJsonForData` + `lockElement`), struk yang dapat dicetak (`@media print` mengisolasi `#pos-receipt` pada 58 mm; `change` milik SERVER yang dicetak). Riwayat: tabel SSR, filter tanggal/kasir, tautan halaman berikutnya keyset. Setiap string klien berasal dari `t()` lewat atribut `data-*`; data katalog mencapai DOM hanya lewat `textContent`.                                                                                                                                                                                                                                                                                                                       |
| Navigasi                | `module.ts`                                                                                                                             | `admin.layout.nav_commerce_pos` → `/admin/commerce-pos`, `requiredPermission: commerce.pos.create`, `requiredFeature: {moduleKey: "commerce", feature: "pos"}` (urutan 17).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Data subjek             | `module.ts` (deskriptor `commerce.orders`)                                                                                              | Bertambah `subjectColumns: [{column: "pos_cashier_tenant_user_id", references: "tenant_user"}]` (rencana subjek seorang staf menjangkau penjualan yang ia catat); erasure tetap `retain_under_obligation` (catatan fiskal; stempel me-resolve ke tidak siapa pun begitu identitas dianonimkan). Sisi PELANGGAN tetap tak terjangkau seperti sebelumnya.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Pengujian               | `tests/commerce-pos-domain.test.ts`, `tests/integration/commerce-pos.integration.test.ts`, `tests/admin-commerce-page-contract.test.ts` | Unit: setiap bentuk validasi, aritmetika kembalian berbasis string (termasuk kasus gagal IEEE-754 dan nominal dua belas digit), penolakan `cash` oleh storefront, round-trip sentinel. Integrasi (Postgres nyata): lunas seketika + stok berkurang + peristiwa/audit; riwayat vs. pengecualian jalur storefront; pemakaian ulang walk-in + harga per level; `cash`/sentinel storefront ditolak; replay idempoten, konflik payload/kasir, pembayaran kurang tidak menulis apa pun; `409 FEATURE_DISABLED`. Kontrak: halaman di-gate tepat pada dua kunci yang ditegakkan rute, mengirim dengan `Idempotency-Key`, tidak pernah menetapkan `innerHTML`, menghormati flag; entri nav mewajibkan fitur.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

**Yang sengaja TIDAK dilakukan POS (increment ini):** tanpa antrean
offline/`SyncIndicator` (bentuk POS LAN-first dok 14/15 — POS ini
online-saja, seperti setiap rute lain di sini), tanpa rekonsiliasi laci
kas/shift, tanpa refund dari layar POS (admin membatalkan/me-refund lewat
`/admin/commerce-orders` seperti pesanan mana pun), tanpa diskon per-baris
atau voucher di konter, tanpa struk e-mail/WhatsApp, tanpa
`commerce.pos.read` terpisah (riwayat memakai ulang `commerce.orders.read`
— kunci baca kedua tanpa sesuatu yang berbeda untuk ditegakkan adalah cacat
"izin tanpa kode penegak" yang diperingatkan header izin berkas ini).

## Ledger alokasi pembayaran — SUDAH DIIMPLEMENTASIKAN (Issue #285, epik #281 — [ADR-0025](../../../../../docs/adr/0025-payments-are-an-allocation-ledger-separate-from-order-status.id.md))

| Lapisan     | Berkas                                                                                                                                                                                                                             | Fungsinya                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skema       | `sql/940` (tabel, FK komposit, trigger append-only, `REVOKE DELETE`, `partially_paid`), `sql/941` (izin), `sql/942` (grant purge worker), `sql/943` (backfill)                                                                     | `awcms_commerce_payment_allocations`: append-only, RLS FORCE, `UNIQUE (tenant_id, source_key)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Domain      | `domain/payment-allocation.ts`                                                                                                                                                                                                     | Murni, persis-sen: `computeSettlement`, `derivePaymentStatus`, `releaseThresholdCents`, `planTenders` (non-tunai dulu, kembalian hanya dari leg tunai), validator request                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Application | `application/payment-allocation-directory.ts`, `application/payment-recording.ts`                                                                                                                                                  | `recordPaymentAllocation` (kunci baris pesanan `FOR NO KEY UPDATE`, pemeriksaan kelebihan bayar, insert, hitung ulang, callback rilis, audit, event), `recordPaymentReversal`, `openPendingGatewayAllocation` / `resolveGatewayAllocation` / `failPendingGatewayAllocation`, `fetchOrderPaymentSummary`, `listTenderMix`, `listOutstandingBalances`; `payment-recording.ts` menyusunnya dengan store idempotensi bersama untuk dua mutasi sisi-pemilik. `order-directory.ts` mengekspor `makeOrderRelease` (closure atas satu `transitionOrderStatus`-nya) dan mengalirkan jalur terima-konfirmasi / `markOrderPaidBySystem` lewat ledger; `pos-directory.ts` merencanakan tender dan menulis satu leg masing-masing |
| Rute        | `pages/api/v1/commerce/orders/[id]/payments/index.ts`, `.../payments/[paymentId]/reversals.ts`, `pages/api/v1/reports/commerce/{tender-mix,outstanding-balances}.ts`, penanganan `tenders[]`/`allowDue` pada rute POS              | Izin `commerce.payments.{read,create,revoke}`, `commerce.pos_due.create`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Event       | `awcms.commerce.payment.recorded`, `awcms.commerce.payment.reversed`                                                                                                                                                               | Pada agregat pesanan; terdaftar di `module.ts`, registri tipe-event, dan AsyncAPI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Layar       | `/admin/commerce-pos` (baris tender terbagi, ringkasan langsung, struk per tender), `/admin/commerce-orders/{id}` (penyelesaian, ledger, catat pembayaran / pembalikan), `/admin/commerce-reports` (bauran tender, saldo terutang) |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Tes         | `tests/commerce-payment-allocation-domain.test.ts`, `tests/integration/commerce-payment-allocations.integration.test.ts`                                                                                                           | Lihat [cms.id.md di akar](../../../../../docs/cms.id.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Register POS dan tutup kas — SUDAH DIIMPLEMENTASIKAN (Issue #284, epik #281 — [ADR-0028](../../../../../docs/adr/0028-pos-register-sessions-and-cash-up.md))

Enam tabel (`sql/970`: `awcms_commerce_registers`, `…_register_sessions`, `…_register_movements`, `…_register_close_requests`, `…_register_close_lines`, `…_register_corrections`), dua kolom stempel (`sql/971`: `register_session_id` pada `awcms_commerce_orders` dan `awcms_commerce_payment_allocations`), sepuluh izin (`sql/972`), grant purge worker (`sql/973`).

- **Di mana kodenya.** `domain/register.ts` (kosakata, validator, seharusnya / selisih / ambang / koreksi sen-eksak — murni), `domain/register-cash-up-csv.ts` (CSV yang menetralkan formula), `domain/register-lifecycle.ts` (enam deskriptor `dataLifecycle` dan `subjectData`), `application/register-directory.ts` (definisi), `application/register-session-directory.ts` (buka, mutasi, serah terima, gerbang POS, helper kunci), `application/register-cash-up.ts` (seharusnya, laporan, penutupan, keputusan, koreksi), `application/register-session-stamp.ts` (satu keputusan "apakah leg ini milik sebuah sesi?", dipakai penulis ledger pembayaran), `application/register-http.ts` (pipa `Idempotency-Key` / gerbang fitur / error yang dipakai bersama sepuluh rute).
- **Aturan yang harus dijaga perubahan.** Seharusnya DITURUNKAN dari leg ledger yang distempel + mutasi, tidak pernah disimpan sebagai total berjalan dan tidak pernah jendela waktu; setiap mutasi berlingkup sesi mengunci sesi terlebih dulu (`FOR SHARE` untuk penjualan / mutasi / leg yang distempel, `FOR NO KEY UPDATE` untuk serah terima / penutupan / persetujuan / koreksi) dan membaca store idempotensi setelah kunci; sesi yang sudah ditutup tidak dapat diubah (trigger) dan hanya dikoreksi lewat baris kompensasi; tutup kas hanya menulis tabel register, tidak pernah penjualan atau pembayaran; satu sesi aktif per register adalah indeks unik parsial yang ditopang kunci baris register; ambang persetujuan membandingkan selisih KOTOR dan pengaturan yang rusak kembali ke `0.00` yang ketat.
- **Flag fitur.** `features.register` (`domain/commerce-features.ts`) default MATI — satu-satunya flag yang demikian. Mati: rute owner menjawab `409 FEATURE_DISABLED`, penjualan POS tidak butuh register dan tidak distempel, dan menyebut `registerId` ditolak. Nyala: penjualan POS mensyaratkan `registerId` yang register-nya punya sesi `open` milik kasir yang bertindak (`PosRegisterSessionError`, dipetakan `pages/api/v1/commerce/pos/orders/index.ts`). Ambangnya adalah `cashUp.approvalThreshold` di pengaturan modul.
- **Izin.** `commerce.registers.{read,create,update}`, `commerce.register_sessions.{read,create,update,export}`, `commerce.register_cash_ups.{create,approve}`, `commerce.register_corrections.approve` — hanya verba `AccessAction` yang sudah ada; tidak ada yang tersirat dari `commerce.pos.create`.
- **Event.** `awcms.commerce.register_session.{opened,movement_recorded,closed,corrected}` pada agregat `commerce.register_session`; audit `register.*` / `register_session.*` (uang, tipe, id — tidak pernah teks bebas).
- **Layar.** `/admin/commerce-registers`, `/admin/commerce-registers/[id]`, banner register di `/admin/commerce-pos` (lihat panduan cms di root awcms-one, [panduan modul commerce](../../../../../docs/cms.id.md)).
- **Ditunda.** Angka "dicatat setelah penutupan" untuk aktivitas ledger terlambat, ambang per register, pemilih kasir untuk serah terima — lihat [ADR-0028](../../../../../docs/adr/0028-pos-register-sessions-and-cash-up.md).

## Siklus dokumen: penjualan tertahan, penawaran, perintah kerja, struk, dan faktur — SUDAH DIIMPLEMENTASIKAN (Issue #286, epik #281 — [ADR-0029](../../../../../docs/adr/0029-commerce-documents-are-separate-records-and-numbered-documents-are-immutable-order-snapshots.id.md))

Tujuh tabel (`sql/980`: `awcms_commerce_document_sequences`, `…_held_sales`, `…_quotations`, `…_quotation_versions`, `…_work_orders`, `…_work_order_events`, `…_documents`), tiga belas izin (`sql/981`), hak hapus untuk worker retensi (`sql/982`). Tidak ada kolom yang ditambahkan ke tabel yang sudah ada.

- **Di mana kodenya.** `domain/documents.ts` (kosakata, mesin status, validator, format penomoran, JSON kanonik + SHA-256, perbandingan sen yang tepat, kontrak render json/text/html — murni), `domain/documents-lifecycle.ts` (deskriptor `dataLifecycle` dan `subjectData`), `application/document-numbering.ts` (pengalokasi tanpa celah satu pernyataan), `application/held-sale-directory.ts`, `application/quotation-directory.ts` (buat / revisi / aksi / konversi), `application/work-order-directory.ts`, `application/document-directory.ts` (terbitkan / daftar / render), `application/documents-http.ts` (gerbang fitur dan pemeriksaan supervisor malas yang dipakai tiga belas rute).
- **Aturan yang harus dijaga perubahan.** Satu otoritas uang: uang dokumen adalah salinan yang diverifikasi trigger, penawaran dikonversi dengan memanggil `createPosOrder`, tidak pernah dengan menulis pesanan. Alokasikan nomor **paling akhir**, dan jangan pernah mengembalikan _respons_ gagal setelah mengalokasikan (`409` yang dikembalikan di-commit; hanya lemparan yang me-rollback) — batalkan-lalu-jawab memakai savepoint (`convertQuotation`). Versi penawaran, event perintah kerja, dan dokumen bersifat append-only: revisi atau koreksi adalah baris baru. Penjualan tertahan tidak mencadangkan stok dan tidak menyimpan harga. Id asing adalah `404` netral. Jangan pernah menyunting `awcms_commerce_document_sequences` dengan tangan.
- **Feature flag.** `features.documents` bawaannya MATI (flag kedua yang demikian, setelah `register`): rute pemilik menjawab `409 FEATURE_DISABLED` dan entri sidebar disembunyikan.
- **Izin.** `commerce.held_sales.{read,create,update,approve}`, `commerce.quotations.{read,create,update}`, `commerce.quotation_conversions.create`, `commerce.work_orders.{read,create,update}`, `commerce.documents.{read,create}` — hanya kata kerja `AccessAction` yang sudah ada; konversi juga membutuhkan `commerce.pos_due.create`.
- **Event.** `awcms.commerce.quotation.{accepted,converted}`, `awcms.commerce.work_order.status_changed`, `awcms.commerce.document.issued`; audit `held_sale.*`, `quotation.*`, `work_order.*`, `document.*` (id, nomor, status, jumlah — tidak pernah teks bebas).
- **Layar.** `/admin/commerce-documents` (empat tab) dan kontrol tahan / lanjutkan pada `/admin/commerce-pos` (lihat panduan cms di akar awcms-one, [panduan modul commerce](../../../../../docs/cms.id.md)).
- **Ditunda.** Faktur piutang (AR) dan nota kredit, pembatalan atau penggantian dokumen, struk per pembayaran, pengiriman digital dan PDF, tahun penomoran menurut zona waktu tenant, pemilih varian pada editor penawaran, referensi booking pada perintah kerja — lihat [ADR-0029](../../../../../docs/adr/0029-commerce-documents-are-separate-records-and-numbered-documents-are-immutable-order-snapshots.id.md).

## Buku besar poin loyalitas — SUDAH DIIMPLEMENTASIKAN (Issue #289, epic #281 — ADR-0026)

Program poin sebagai **buku besar** append-only, bukan kolom poin yang bisa
diubah pada pelanggan. Setiap perubahan saldo adalah satu baris
`awcms_commerce_loyalty_ledger`; `awcms_commerce_loyalty_accounts.balance`
adalah proyeksinya (`balance = SUM(points)`), dijaga dalam transaksi yang sama
dengan setiap insert di bawah kunci `FOR UPDATE` pada baris akun. Poin adalah
bilangan bulat (`bigint`, dibatasi ±10¹²) — bukan float, bukan uang, dan bukan
store credit atau nilai tersimpan (itu buku besar terpisah, #288). Seluruh
fitur berada di balik `features.loyalty`, default **MATI**.

| Bagian | Lokasi | Fungsinya |
| ------ | ------ | --------- |

## Barcode, label, input pemindai, dan pintasan kasir - TERIMPLEMENTASI (Issue #292, epic #281 - [ADR-0032](../../../../../docs/adr/0032-barcodes-are-a-derived-identifier-and-the-cashier-keyboard-layer-is-chord-only.md))

Dua kolom `barcode` nullable (`sql/975`: produk dan varian), dua izin (`commerce.barcodes.{read,update}`, `sql/976`), tanpa tabel baru.

- **Lokasi kode.** `domain/barcode.ts` (digit pemeriksa GTIN, kebijakan validasi, encoder Code 128 / EAN-13 / EAN-8, perender SVG, opsi label - murni), `domain/pos-scan.ts` (parsing kolom pindai dan `ScanBurstDetector`, diberi cap waktu eksplisit - murni), `domain/pos-shortcuts.ts` (kebijakan kombinasi, bentrok, pelapisan bawaan -> tenant -> pengguna - murni), `application/barcode-directory.ts` (lookup, katalog, penetapan, baris label), `application/barcode-http.ts` (guard, gerbang fitur, pengaturan pintasan tenant), rute di `pages/api/v1/commerce/barcodes/`, layar `pages/admin/commerce-labels.astro`, dan sisi klien `src/lib/ui/pos-keyboard-client.ts` (satu-satunya tempat skrip layar POS dijangkau: satu kait `addScanned`, sisanya id elemen).
- **Aturan yang harus dijaga perubahan.** Barcode adalah pengenal, bukan otoritas: otorisasi pemanggil terlebih dahulu. Simbologi tetap diturunkan. Keunikan adalah tugas database (indeks parsial + trigger lintas tabel); jangan ganti advisory lock berstrip dengan satu lock per kode (menghabiskan tabel kunci pada pemuatan massal). Lookup yang meleset adalah satu `404` netral. SVG label hanya berisi angka dan teks tenant di-escape, tidak pernah `set:html`. Pintasan adalah kombinasi - tidak pernah karakter polos, tidak pernah tombol yang dicadangkan peramban - dan detektor tidak pernah aktif di kolom teks.
- **Feature flag.** `features.barcode` bawaannya MATI (flag ketiga seperti itu, setelah `register` dan `documents`).
- **Ditunda.** Beberapa barcode per barang, barcode bundel kini adalah barcode milik produk bundel itu sendiri (#290), barcode dengan harga/berat tertanam, ekspor label PDF, simbologi lain, layar penyunting pintasan tingkat tenant, penyimpanan pintasan per pengguna di server.

## Pengiriman dokumen — TERIMPLEMENTASI (Issue #295, epic #281 — [ADR-0034](../../../../../docs/adr/0034-commercial-documents-are-delivered-through-the-existing-outboxes-as-transactional-messages-built-from-immutable-sources.md))

Satu tabel (`sql/965`: `awcms_commerce_document_deliveries`), tiga izin (`sql/966`), hak purge worker (`sql/967`). Tidak ada kolom yang ditambahkan ke tabel yang sudah ada; satu indeks parsial ditambahkan pada `awcms_commerce_whatsapp_messages` untuk join correlation-id.

- **Letak kodenya.** `domain/document-delivery.ts` (kosakata, validator permintaan, pembuat pesan murni, kontrak templat berversi, token tautan pribadi — murni), `application/document-delivery-directory.ts` (permintaan / riwayat / resolusi tautan), `application/documents-http.ts` (`requireDocumentDeliveryFeature`), rute `src/pages/api/v1/commerce/document-deliveries/index.ts` dan `src/pages/api/v1/commerce/storefront/document-links/[token].ts`, serta dialog admin `src/components/CommerceDeliveryDialog.astro` + `src/lib/ui/commerce-delivery-dialog-client.ts`.
- **Aturan yang harus dijaga perubahan.** Tidak ada antrean ketiga: antrekan ke outbox yang sudah ada milik saluran, jangan pernah memanggil penyedia. Susun pesan hanya dari sumber tersimpan (tidak ada pembacaan pesanan hidup — sebuah tes mengunci hal ini). Penerima disimpan tersamar; token tautan mentah tidak pernah disimpan, dikembalikan, atau dicatat. E-mail memakai kategori dasar `derived.transactional` (kategori turunan tak terlihat oleh proses `email:dispatch` yang terpisah). Mengubah daftar variabel atau redaksi salah satu templat menaikkan `DOCUMENT_DELIVERY_TEMPLATE_VERSION`. Baris permintaan append-only; kirim ulang adalah baris baru.
- **Feature flag.** `features.documentDelivery` bawaannya MATI dan juga mensyaratkan `documents`.
- **Izin.** `commerce.document_deliveries.{read,create}`, `commerce.document_delivery_overrides.create` — hanya kata kerja `AccessAction` yang ada.
- **Event.** `awcms.commerce.document.delivery_requested`; audit `document_delivery.{request,denied,link_opened,link_expired}` (id, nomor, saluran, status, penerima tersamar — tidak pernah alamat, nama, atau isi).
- **Env.** `COMMERCE_DOCUMENT_LINK_BASE_URL` (opsional; cadangan `APP_URL`).
- **Ditunda.** Kirim ulang atas permintaan pelanggan, PDF, push, pengiriman otomatis saat pembayaran/perubahan status, daftar berhenti WhatsApp, pencabutan tautan — lihat [ADR-0034](../../../../../docs/adr/0034-commercial-documents-are-delivered-through-the-existing-outboxes-as-transactional-messages-built-from-immutable-sources.md).
  | Skema | `sql/950`, `sql/951`, `sql/952` | `awcms_commerce_loyalty_programs` (aturan perolehan berversi dengan tanggal berlaku), `_accounts` (satu per pelanggan, `balance`/`version` hasil proyeksi), `_ledger` (append-only; jenis `earn`/`redeem`/`expire`/`adjustment`/`reversal`; `idempotency_key` unik per tenant; FK komposit `(tenant_id, id)`). RLS FORCE; `awcms_app` dicabut UPDATE/DELETE pada ledger dan trigger menolak setiap UPDATE. |
  | Domain | `domain/loyalty.ts`, `loyalty-earn.ts`, `loyalty-lots.ts`, `loyalty-validation.ts` | Tipe bilangan bulat dan aturan tanda; aturan perolehan dalam sen bulat dengan pembulatan FLOOR eksplisit; replay lot murni (alokasi yang paling cepat kedaluwarsa dulu) di balik kedaluwarsa dan pembatalan; validasi request. |
  | Ledger (satu-satunya penulis) | `application/loyalty-ledger.ts` | `appendLedgerEntry` (kunci idempotensi, `account_seq` berikutnya, `balance_after` berjalan, pembaruan proyeksi, event `loyalty.entry_recorded` — satu transaksi); `earnPointsForPaidOrder`, `reverseEarnForCancelledOrder`, `redeemPoints`, `adjustPoints`, `expireDueLoyaltyPointsForTenant`, `reconcileLoyaltyForTenant`, `fetchLoyaltySummary`. |
  | Program | `application/loyalty-program-directory.ts` | Draf -> aktif -> pensiun. Aktivasi berlaku segera dan menutup versi yang sedang terbuka dalam transaksi yang sama di bawah advisory lock per tenant; versi aktif/pensiun tidak dapat diubah (baris ledger menyebut versi tempat poin diperoleh). |
  | Perolehan / pembatalan | `commerce/module.ts` (`domainEventConsumers`, ADR-0134) | `commerce.order_paid_loyalty_earner` (`order.paid`) dan `commerce.order_cancelled_loyalty_reverser` (`order.cancelled`) — loyalitas tidak pernah menyentuh `order-directory.ts`, `pos-directory.ts`, penetapan harga, atau jalur webhook pembayaran; semuanya sudah menerbitkan event tersebut. |
  | Job | `scripts/commerce-loyalty-expire.ts`, `scripts/commerce-loyalty-reconcile.ts` | `commerce:loyalty:expire` (tiap jam, append-only, idempoten, 200 akun/tenant/run) dan `commerce:loyalty:reconcile` (harian, hanya-baca, exit non-nol bila ada drift). |
  | Route | `pages/api/v1/commerce/loyalty/**`, `pages/api/v1/commerce/storefront/account/loyalty/index.ts` | Pemilik: program (list/buat/ambil/ubah/aktifkan/pensiunkan), akun (list + pencarian `?phone=`, ambil, ledger, **redeem**, **adjust**), ringkasan, reconcile. Pelanggan: saldo + riwayat milik sendiri dengan bearer (ADR-0016 D3), id pelanggan hanya dari sesi. |
  | Layar admin | `pages/admin/commerce-loyalty.astro` | Angka kunci dari ledger, versi program (buat draf / aktifkan / pensiunkan dengan dialog konfirmasi), pencarian pelanggan dengan ledger + form redeem + adjust (masing-masing di balik izinnya sendiri), pemeriksaan saldo hanya-baca dengan perbaikan eksplisit yang dikonfirmasi. |
  | Izin | `domain/commerce-permissions.ts`, `sql/952` | `commerce.loyalty.read`, `commerce.loyalty.manage` (berisiko tinggi), `commerce.loyalty_adjustments.create`, `commerce.loyalty_redemptions.create` — tiga kode aktivitas, karena `AccessAction` (milik upstream) tidak punya anggota `adjust`/`redeem`. |
  | Tes | `tests/commerce-loyalty-{earn,lots,validation,routes}.test.ts`, `tests/integration/commerce-loyalty.integration.test.ts` | Unit: aritmetika bilangan bulat/floor, replay lot dan identitas akuntansinya (200 ledger hasil generate), validasi, penjaga struktural kepemilikan/satu-penulis. Integrasi (Postgres nyata): perolehan sekali walau di-replay, redeem konkuren, idempotensi kedaluwarsa, pembatalan, append-only, RLS, BOLA, reconcile, ringkasan, grant role worker. |

**Aturan yang perlu diketahui sebelum mengubah apa pun**

- Perolehan **tepat sekali per order** (kunci `earn:order:<id>` + penanda
  consumer), hanya dari `subtotal - discount` pada baris order, untuk versi
  program yang berlaku pada `paid_at`. Pelanggan walk-in/terblokir dan order
  yang dibatalkan tidak pernah memperoleh poin; mengaktifkan fitur belakangan
  tidak berlaku surut.
- **Kedaluwarsa** per lot perolehan, yang paling cepat kedaluwarsa lebih dulu.
  Baris `expire` ditambahkan, bukan di-update; lot yang sudah habis terpakai
  mendapat penanda nol poin agar pemindaian berhenti. Redeem/penyesuaian/
  pembatalan mengekspirasi sendiri lot akun yang jatuh tempo di bawah kunci,
  sehingga poin yang sudah lewat tidak pernah bisa dibelanjakan.
- **Pembatalan** adalah baris `reversal` kompensasi untuk perolehan order yang
  dibatalkan, bukan penghapusan. Ia mengambil kembali yang belum kedaluwarsa,
  termasuk poin yang sudah dipakai, sehingga saldo bisa **negatif** (dan
  memblokir redeem). Penyesuaian negatif manual tidak boleh begitu.
- Redeem **hanya mencatat pengurangan poin**. Mengubah poin menjadi diskon saat
  checkout membutuhkan model tender #285 dan ditunda (ADR-0026).

## Atribut katalog bertipe & impor/ekspor CSV — SUDAH DIIMPLEMENTASIKAN (Issue #291, epik #281 — ADR-0027)

Atribut kustom **bertipe** yang didefinisikan tenant pada produk dan varian, difilter lewat tata bahasa ber-allowlist, ditambah impor CSV validasi-lalu-terapkan dan ekspor yang aman-formula. Semua di bawah ini ada di dalam satu modul ini (ADR-0008); [ADR-0027](../../../../../docs/adr/0027-catalog-custom-attributes-are-typed-and-allowlisted.md) di root memuat penalaran, model ancaman, strategi rollback, dan rencana kueri terukur.

| Bagian             | Berkas                                                                                                                                                                   | Yang dimilikinya                                                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tata bahasa nilai  | `domain/attribute-value.ts`                                                                                                                                              | Parse/normalisasi tak-bergantung-locale untuk setiap tipe (`1234.5` ya, `1,5` tidak), representasi integer berskala eksak `nilai × 10^6`, string kanonik, nilai kawat                                                                          |
| Definisi           | `domain/attribute-definition.ts`, `application/attribute-definition-directory.ts`                                                                                        | Skema constraint tertutup, `key`/`valueType` yang tak dapat diubah, batas 100 per tenant, opsi enum unik tanpa membedakan huruf, penolakan "sedang dipakai" saat update                                                                        |
| Penetapan          | `domain/attribute-assignment.ts`, `application/attribute-value-directory.ts`                                                                                             | SATU validator untuk peta `{key: nilai \| null}` (endpoint atribut, formulir produk, dan impor CSV semuanya memanggilnya), penulisan upsert/hapus-lunak, `loadAttributeSets` (sadar audiens), `attachPublicAttributes` (`attributes[]` aditif) |
| Tata bahasa filter | `domain/attribute-filter.ts`, `application/attribute-filter-sql.ts`                                                                                                      | `attr=<key>:<op>:<value>`: cek bentuk, key → id definisi, keabsahan operator/tipe, operand bertipe; lalu SATU template SQL literal per (tipe, operator) dengan parameter ter-bind                                                              |
| CSV                | `domain/catalog-csv.ts`                                                                                                                                                  | Pembaca/penulis RFC 4180 dengan batas; netralisasi formula (dan pembalikannya saat impor)                                                                                                                                                      |
| Impor              | `domain/catalog-import.ts`, `application/catalog-import.ts`                                                                                                              | Kontrak file (kolom inti + `attr:<key>`, tanpa kolom media), `planCatalogImport` (hanya SELECT), `applyCatalogImport` (rencana yang sama, satu savepoint, baris batch + audit)                                                                 |
| Ekspor             | `application/catalog-export.ts`                                                                                                                                          | Halaman keyset terbatas → satu CSV, diaudit                                                                                                                                                                                                    |
| Rute               | `pages/api/v1/commerce/attributes/**`, `products/[id]/attributes.ts`, `products/[id]/variants/[variantId]/attributes.ts`, `products/import.ts`, `products/export.csv.ts` | Tipis; `defineTenantRoute`; `import` juga butuh `create` + `update` untuk apply                                                                                                                                                                |
| Layar              | `pages/admin/commerce-attributes.astro`, `commerce-catalog-import.astro`, dan formulir/filter/tautan ekspor atribut di `commerce.astro`                                  | Komponen `CommerceAttributeInputs.astro`, `CommerceAttributeConstraintFields.astro`; helper klien `lib/ui/commerce-attributes-client.ts`, `commerce-catalog-import-client.ts`                                                                  |

### Aturan yang harus dijaga perubahan di sini

- **Tidak ada teks SQL dari request.** `attribute-filter-sql.ts` tidak punya `tx.unsafe`, `${column}`, atau `${operator}`; menambah operator atau tipe adalah galat kompilasi sampai ia punya template literal sendiri (`switch` eksaustif). Tes tingkat-sumber dan tes integrasi payload-injeksi menegakkannya.
- **Angka eksak dan bebas locale.** Jangan pernah `Number(...)`, `parseFloat`, atau `Intl` pada nilai atribut; lewat `parseAttributeValue`. Kolom penyimpanannya `bigint` berskala _karena_ perbandingan `numeric` tidak dapat memakai indeks di bawah FORCE RLS (hanya operator leakproof) — jangan "disederhanakan" kembali.
- **Dua audiens.** API katalog (`GET /products…`) adalah audiens PUBLIK: hanya kunci `filterable && visible_public` yang memfilter, hanya nilai `visible_public` yang dikembalikan, hanya atribut `searchable && visible_public` yang ikut `q`. Himpunan lengkap dijaga `attributes.read`, tidak pernah `products.read` (kredensial etalase memegangnya).
- **Setiap pembacaan, filter, dan pemeriksaan keunikan mengulang `deleted_at IS NULL`** pada tabel nilai; menghapus nilai adalah soft delete.
- **Impor tidak pernah memecah validasi.** Ia memanggil `validateCreateProductInput`/`validateUpdateProductInput`/`validateAttributeAssignments` dan `createProduct`/`updateProduct`; jalur tulis privat yang lebih cepat akan melewati audit, event, mesin status, dan keunikan. Dry-run dan apply berbagi `planCatalogImport`.
- **Impor tidak menerima referensi media dan tidak melakukan I/O selain database.** Kolom tak dikenal menolak file.

### Izin

`commerce.attributes.read`/`.manage` (definisi adalah skema: satu aksi berisiko tinggi), `commerce.products.export` dan `commerce.products.import` (aksi akses `import` baru, berisiko tinggi di samping `export`). _Nilai_ atribut produk ditulis dengan `commerce.products.update` dan dibaca lengkap dengan `commerce.attributes.read`.

## Kartu hadiah dan kredit toko — SUDAH DIIMPLEMENTASIKAN (Issue #288, epik #281 — [ADR-0030](../../../../../docs/adr/0030-stored-value-is-a-closed-loop-liability-ledger.id.md))

Tiga tabel (`sql/985`: `awcms_commerce_stored_value_programs`, `…_accounts`, `…_ledger`), integrasi ledger pembayaran (`sql/986`: `stored_value_account_id`, dua jenis tender, trigger pasangan tertangguh, petunjuk `payment_method` yang dilebarkan), tujuh izin (`sql/987`), grant purge worker (`sql/988`).

- **Letak kodenya.** `domain/stored-value.ts` (kosakata, kode — pembuatan, normalisasi, karakter cek, hash berlingkup tenant, topeng —, sen bertanda, `evaluateEntry` dan `replayLedger`, validator; murni), `domain/stored-value-lifecycle.ts` (tiga deskriptor `dataLifecycle` dan `subjectData`), `application/stored-value-ledger.ts` (**satu-satunya penulis**: `appendStoredValueEntry`, kunci akun, `settleLapse`, dan kait redeem/refund yang dipanggil ledger pembayaran), `application/stored-value-directory.ts` (program, penerbitan, load/adjust/status, sweep kedaluwarsa, pembacaan, laporan kewajiban, reconcile), `application/stored-value-tender.ts` (resolusi kode → akun dengan throttle pencarian, preflight POS, penolakan bertipe, `redactTendersForHash`), `application/stored-value-http.ts` (gerbang fitur dan satu pemetaan penolakan ke respons).
- **Aturan yang harus dijaga perubahan.** Ledger append-only dan trigger database adalah satu-satunya yang menggerakkan `balance`/`version`/`status` akun — jangan menulis `UPDATE` atasnya (satu-satunya pengecualian adalah perbaikan reconcile, yang diterima database hanya untuk jumlah ledger yang persis); urutan kunci adalah baris pesanan → baris akun (`FOR NO KEY UPDATE`, tidak pernah `FOR UPDATE`); penolakan nilai tersimpan diputuskan SEBELUM baris apa pun ditulis (respons yang dikembalikan meng-commit — hanya error yang dilempar yang me-rollback), dan pelanggaran invarian setelah preflight melempar `StoredValueInvariantError`, yang tidak dipetakan rute mana pun; kode plaintext tidak pernah mencapai tabel, log, atribut audit, payload event, atau store idempotensi (hash dengan `hashStoredValueCode` / `redactTendersForHash`); setiap pencarian kode yang gagal adalah satu `STORED_VALUE_NOT_FOUND` netral; tidak ada tarik tunai dan tidak ada transfer, dan pengembalian dana kembali ke akun yang dipakai pembayaran atau tidak sama sekali.
- **Flag fitur.** `features.storedValue` (`domain/commerce-features.ts`) default MATI — bersama `register`, satu-satunya flag yang demikian. Mati: rute pemilik menjawab `409 FEATURE_DISABLED`, entri sidebar disembunyikan, dan tender kartu ditolak sebelum apa pun ditulis (pembalikan pembayaran kartu yang sudah ada tidak digerbangkan: ia mengkompensasi data yang ada).
- **Izin.** `commerce.stored_value_programs.{read,update}`, `commerce.stored_value.{read,create,update}`, `commerce.stored_value_adjustments.create`, `commerce.stored_value_reconcile.approve` — hanya verba `AccessAction` yang sudah ada; menukar adalah tender pada `commerce.pos.create` / `commerce.payments.create`, bukan salah satunya.
- **Event.** `awcms.commerce.stored_value.entry_recorded` pada agregat `commerce.stored_value_account` (satu per entri ledger); audit `stored_value.*` / `stored_value_program.update` (id, jenis, uang — tidak pernah kode, pelanggan, atau teks bebas).
- **Layar.** `/admin/commerce-stored-value`; baris tender kartu hadiah / kredit toko di `/admin/commerce-pos` dan `/admin/commerce-orders/[id]` (hanya dengan fitur menyala); toggle "Gift cards and store credit" di layar pengaturan.
- **Ditunda.** Job kedaluwarsa terjadwal, pencarian/penukaran publik atau tampilan saldo pelanggan apa pun, pengembalian dana ke kartu yang lewat batas, tarik tunai/transfer (ditolak), menjual kartu sebagai produk katalog, kredit toko dari retur — lihat [ADR-0030](../../../../../docs/adr/0030-stored-value-is-a-closed-loop-liability-ledger.id.md).

## Pengembalian barang, pengembalian dana, dan penukaran — TERIMPLEMENTASI (Issue #287, epik #281 — [ADR-0033](../../../../../docs/adr/0033-returns-refunds-and-exchanges-are-additive-records-that-compensate-through-the-existing-ledgers.md))

Empat tabel (`sql/994`: `awcms_commerce_returns`, `…_return_lines`, `…_refunds`, `…_refund_compensations`), integrasi pada tabel yang ada (`sql/995`: `order_events.return_id`, trigger batas reversal ledger pembayaran, sumber `refund` loyalitas, `affiliate_commissions.adjusted_amount`), lima izin (`sql/996`) dan hak akses worker retensi (`sql/997`).

- **Letak kode.** `domain/returns.ts` (kosakata, dekomposisi sen per unit, alokasi diskon sisa-terbesar, perencanaan refund, aritmetika proporsional, validator; murni), `domain/returns-lifecycle.ts` (deskriptor retensi / data subjek), `application/return-directory.ts` (buat, refund susulan, tautan penukaran, reconcile), `application/refund-settlement.ts` (menyelesaikan satu leg — satu-satunya tempat refund menjadi fakta), `application/refund-execution.ts` (panggilan penyedia di luar setiap transaksi; penyelesaian offline), `application/return-inventory-port.ts` (batas stok), `application/return-records.ts` (pembacaan), `application/return-http.ts` (satu pemetaan hasil → respons).
- **Aturan yang harus dipertahankan perubahan.** Tidak ada yang final diubah: tak ada `UPDATE` pesanan, item pesanan, atau alokasi pembayaran (tes memindainya). Setiap penolakan diputuskan SEBELUM tulisan pertama (`checkRefundSettlement`) — route yang mengembalikan respons meng-commit transaksinya. Urutan kunci: baris pesanan → baris item pesanan (menurut id) → baris pembayaran / kartu hadiah / laci. Penyedia dipanggil dari tepat satu tempat dan tak pernah dengan transaksi terbuka; ia diberi id leg refund sebagai kunci idempotensinya pada setiap percobaan. Stok hanya disentuh port inventori; loyalitas hanya oleh `loyalty-ledger.ts`.
- **Batas inventori.** Baris `restock` kembali lewat `ReturnInventoryPort`, `damaged`/`quarantine` dicatat dan tak mengubah stok yang dapat dijual. #282 mendarat sebagai `ledgerInventoryPort` di samping `singleCountInventoryPort`; `modeAwareInventoryPort` (bawaan) memilih satu per tenant — lihat "Otoritas stok" di bawah.
- **Feature flag.** `features.returns` (`domain/commerce-features.ts`) default MATI. Mati: route owner menjawab `409 FEATURE_DISABLED` dan detail pesanan tak menampilkan panel.
- **Izin.** `commerce.returns.{read,create}`, `commerce.refunds.{read,create}`, `commerce.refunds_offline.approve` — hanya kata kerja `AccessAction` yang ada; leg refund juga memerlukan `commerce.payments.revoke`.
- **Event.** `awcms.commerce.return.recorded`, `awcms.commerce.refund.settled` pada agregat `commerce.return`; audit `return.create`, `return.refund`, `return.link_exchange`, `refund.settle`.
- **Layar.** Panel dan wizard "Pengembalian barang dan dana" di detail pesanan (`src/components/CommerceReturnsPanel.astro`, `src/lib/ui/commerce-returns-client.ts`); sakelar "Pengembalian barang, dana, dan penukaran" di layar pengaturan.
- **Laporan penjualan.** `sales-report-deltas.ts` / `sales-report-projection.ts` menetralkan event pesanan `returned` (dan, untuk pembatalan berikutnya, retur sebelumnya) sehingga ketiga proyeksi tetap sama dengan rebuild.
- **Ditunda.** Pergerakan stok multi-lokasi, refund pajak/asuransi otomatis, permintaan dari pelanggan, job refund terjadwal, membatalkan retur terbuka, laporan retur — lihat [ADR-0033](../../../../../docs/adr/0033-returns-refunds-and-exchanges-are-additive-records-that-compensate-through-the-existing-ledgers.md).

## Laporan operasional POS — TERIMPLEMENTASI (Issue #296, epik #281 — [ADR-0035](../../../../../docs/adr/0035-pos-operational-reports-are-commerce-projections-over-the-existing-ledgers-on-the-reporting-engine.md))

Lima `reportingProjections` lagi pada mekanisme laporan penjualan di atas (tanpa mesin baru): `commerce.pos_tender_daily`, `commerce.pos_cash_up_variance`, `commerce.pos_expense_daily`, `commerce.pos_loyalty_daily`, `commerce.pos_stored_value_daily` (`sql/998`–`999`).

| Bagian                | Letaknya                                                                                                                                         | Fungsinya                                                                                                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aturan delta          | `domain/operational-report-deltas.ts` (murni)                                                                                                    | Leg pembayaran → kolom pembayaran/pembalikan pada hari penyelesaian dan kasir; baris tutup + koreksi → diharapkan/dihitung/penyesuaian pada hari tutup; pembukuan / pembalikan pengeluaran → kolom dibukukan / dibalik pada tanggal terjadi; entri buku besar → bucket bertanda pada hari lokalnya |
| Kunci, keluarga       | `domain/operational-report-keys.ts`                                                                                                              | Kunci proyeksi, aliran, metrik dan kontrol; `OPERATIONAL_REPORT_FAMILIES` (gerbang fitur, proyeksi) — registri tempat keluarga baru (retur, inventori, pajak) menambah satu entri                                                                                                                  |
| Penampung + kait      | `application/operational-report-projection.ts`                                                                                                   | Satu `load*Deltas` per sumber (dipakai bersama penampung dan rekonsiliasi), upsert aditif, `walkSource` (paginasi kursor teks), `ProjectionDimensionalContract` tiap proyeksi                                                                                                                      |
| View sumber           | `sql/998` `awcms_commerce_report_src_*`                                                                                                          | View `security_invoker` atas baris yang kursornya terisi — pindaian rebuild mesin tidak dapat menerima kursor NULL                                                                                                                                                                                 |
| Bacaan, CSV           | `application/operational-report-directory.ts`, `domain/operational-report-csv.ts`                                                                | Laporan rentang dengan larik `summary` sen persis dan gerbang `enabled`; CSV dinetralkan formula (memakai ulang `csvCell`/`csvNumber`)                                                                                                                                                             |
| Rute                  | `src/pages/api/v1/reports/commerce/operational-*.ts` dan `.csv.ts`                                                                               | Sepuluh rute, masing-masing dengan penjaga literalnya sendiri (`commerce.report_<keluarga>.read` / `.export`); rute CSV mengaudit ekspor                                                                                                                                                           |
| Layar                 | `src/components/CommerceOperationalReports.astro` pada `/admin/commerce-reports`                                                                 | Lima panel, masing-masing hanya untuk pemegang kunci `read` keluarganya dan tersembunyi selama fiturnya mati                                                                                                                                                                                       |
| Retensi / data subjek | `domain/operational-report-lifecycle.ts`                                                                                                         | Kursor `day`, batas atas 3650 hari; tabel tutup kasir memuat uuid kasir (staf)                                                                                                                                                                                                                     |
| Tes                   | `tests/commerce-operational-report-{domain,permissions}.test.ts`, `tests/integration/commerce-operational-reports{,-routes}.integration.test.ts` | Aturan dan batas zona waktu; pemisahan izin; langsung = rebuild byte demi byte, penyimpangan dan perusakan terdeteksi rekonsiliasi, peristiwa terlambat, fitur mati, RLS, BOLA, CSV dan audit                                                                                                      |

**Irisan retur & refund — SUDAH ADA (Isu #316).** Proyeksi keenam, `commerce.pos_returns_daily` (`sql/945` tabel + grant worker, `sql/946` pasangan `commerce.report_returns.read|export`), mengikuti kontrak ADR-0035 D1 dan adendumnya. Tiga aliran ke satu tabel panjang `awcms_commerce_report_returns_daily` (`(day, register_id, section, bucket, detail)`): `awcms_commerce_returns` (`section = return`: retur dan penukaran tercatat, dengan total refund), `awcms_commerce_return_lines` (`section = disposition`: baris, unit, dan nilai menurut `restock` / `damaged` = dihapuskan / `quarantine`) dan leg reversal buku besar pembayaran yang ditunjuk sebuah refund (`section = refund`: leg dan uang menurut metode dan menurut `original_tender` / `store_credit`). Pemuat `loadReturnDeltas`, `loadReturnLineDeltas`, `loadRefundLegDeltas` ada di `application/operational-report-projection.ts` dan memberi makan sink sekaligus total kontrol; aturannya `computeReturnDelta`, `computeReturnLineDelta`, `computeRefundLegDelta` di `domain/operational-report-deltas.ts`. Tidak ada view `security_invoker` baru: kursor sumbernya NOT NULL sejak insert, dan aliran refund membaca view alokasi sql/998. Di balik fitur `returns` (`enabled: false` selama mati); rute `operational-returns` dan `.csv`; panel di `/admin/commerce-reports`. Tes: `tests/integration/commerce-returns-report.integration.test.ts`.

**Ditunda dengan menyebut nama:** penerimaan (#283), margin, diskon, dan laporan bundel (#290 mengirim bundel; laporannya ditunda, ADR-0036 D8) — lihat ADR-0035 D1 (saldo/mutasi/stok menipis adalah layar dan proyeksi `inventory` hulu, ADR-0038 D8; pajak adalah laporan milik modul `tax` sendiri, ADR-0039 D5).

## Otoritas stok: counter atau ledger inventori — TERIMPLEMENTASI (Issue #282, epik #281 — [ADR-0038](../../../../../docs/adr/0038-commerce-stock-is-a-write-through-cache-of-the-inventory-ledger.md))

- **Mode.** `awcms_commerce_store_settings.inventory_mode` (`counter` bawaan | `ledger`) dan `inventory_location_id` (FK komposit ke `awcms_inventory_locations`), `sql/947`. Kolom, bukan bagian dari jsonb pengaturan; pada mode `ledger` reset pengaturan mengganti blob dan tidak pernah memberi cap `deleted_at` (purge retensi akan menghapus baris pembawa mode).
- **Satu sambungan.** `application/commerce-inventory.ts` adalah satu-satunya berkas yang menyebut `inventoryLedgerPortAdapter` (secara lazy — rantai impor adapter mencapai registri konsumen). `resolveInventoryConfig` membaca mode di bawah kunci advisory shared; cut-over dan rollback memegang yang eksklusif. `withInventorySavepoint` menjalankan unit penggerak stok dalam savepoint pada mode `ledger` sehingga penolakan (`InventoryLedgerRefusedError`) tidak meninggalkan apa pun.
- **Penulisan.** `createOrderFromCart` / `createPosOrder` → `sale` per baris (`commerce_order`, id pesanan, id item pesanan); `transitionOrderStatus` batal/kedaluwarsa → `sale_return` (`commerce_order_restock`); `createReturn` → `ledgerInventoryPort` (`commerce_return`, id retur, id baris retur). Diposting terurut menurut `(itemType, itemRef, baris)`; `stock` ditulis `max(0, floor(balanceAfter))`. Stok habis adalah `cart_changed` / `PosCartChangedError`; penolakan lain `409 INVENTORY_UNAVAILABLE`.
- **Perawatan cache.** `application/commerce-inventory-cache-projector.ts`, dideklarasikan di `commerce/module.ts` `domainEventConsumers` (ADR-0134) sebagai `commerce.inventory_stock_cache_projector` pada `awcms.inventory.movement.posted`: membaca ulang `getOnHand`, bukan payload, hanya untuk lokasi penjualan dan item `commerce.*`.
- **Cut-over.** `application/commerce-inventory-cutover.ts` + `scripts/commerce-inventory-cutover.ts` (`bun run commerce:inventory:cutover`, dry-run secara bawaan). Opening tidak ada di port, sehingga skrip (composition root) menyerahkan inti posting modul inventori sebagai callback.
- **API operator.** `GET /api/v1/commerce/inventory`, `GET …/reconciliation`, `POST …/resync`, `POST …/rollback` (`application/commerce-inventory-reconciliation.ts`; `commerce.inventory.read` / `.configure`).
- **Suntingan.** `assertStockWritable` di direktori produk/varian dan galat baris saat-rencana di impor CSV menolak perubahan stok pada mode `ledger` (`409 STOCK_MANAGED_BY_INVENTORY`).
- **Procurement (#283).** `procurement` hulu adalah konsumennya; commerce hanya menambah konvensi, pencarian, dan pemeriksaan. Baris pengadaan yang menambah stok barang commerce memakai `itemType` `commerce.variant` (uuid varian) atau `commerce.product` (uuid produk tanpa varian aktif), satuan `unit`, di lokasi penjualan (atau di tempat lain lalu `transfer`); `GET /api/v1/commerce/inventory/items?q=` (`application/commerce-inventory-items.ts`, `commerce.inventory.read`, keyset, maks 50) menerjemahkan SKU ke rujukan itu. Penerimaan tenant `counter` tidak mengubah stok commerce - lakukan cut-over lebih dulu. Halaman pertama rekonsiliasi juga melaporkan `orphans` (`listLedgerOrphans`: saldo `commerce.*` non-nol di lokasi penjualan yang tak menunjuk unit aktif; didaftarkan lewat `InventoryLedgerPort.listBalances`, diklasifikasikan per halaman terhadap tabel commerce; pemindaian dibatasi `ORPHAN_SCAN_MAX_PAGES`, yang juga menyalakan `truncated`). Laporan penerimaan adalah proyeksi `procurement.*` hulu. Tes: `tests/integration/commerce-procurement-stock-flow.integration.test.ts`, `…/commerce-inventory-items-routes.integration.test.ts`.
- **Tes.** `tests/commerce-inventory-domain.test.ts`, `tests/commerce-inventory-permissions.test.ts`, `tests/integration/commerce-inventory-adapter.integration.test.ts`.

## Pajak: persentase tetap, atau modul `tax` — TERIMPLEMENTASI (Issue #293, epik #281 — [ADR-0039](../../../../../docs/adr/0039-commerce-tax-is-computed-by-the-tax-module-behind-a-per-tenant-mode.md))

`commerce` bergantung pada modul `tax` (ADR-0127) dan memanggil fungsi aplikasinya in-process; tanpa panggilan jaringan dan tanpa port pajak `_shared/ports/`.

| Bagian     | Di mana                                                                                                                                                            | Fungsi                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mode       | `awcms_commerce_store_settings.tax_mode` / `tax_profile_code` (`sql/948`), `application/tax-adapter-directory.ts` (`fetchTaxAdapterConfig`, `setTaxAdapterConfig`) | `flat` (bawaan) = `percent` dari `subtotal − voucher` milik `quoteCart` yang asli; `engine` = modul pajak. Kolom nyata, hanya-baca pada `GET /store-settings`, `PUT` yang membawanya ditolak. Reset pengaturan tidak pernah menghapus baris engine                                                                                                                                                                        |
| Pemetaan   | `domain/tax-adapter.ts` (murni)                                                                                                                                    | Kuotasi menjadi baris pajak (`quantity`, `unitPrice`, voucher dialokasikan ke baris dengan sisa terbesar dalam sen, kategori produk); pajak engine sama persis dengan angka flat untuk persentase/mode/pembulatan yang sama (uji properti berbenih); harga inklusif tidak ditambahkan ke total; penolakan (`TAX_RULE_VERSION_NOT_FOUND`, `TAX_RULE_NOT_FOUND`, skala selain 2) mengisi `tax.error` dan memblokir checkout |
| Kuotasi    | `domain/cart-quote.ts` + `application/cart-quote-service.ts`                                                                                                       | Menentukan versi untuk tanggal bisnis `Asia/Jakarta` toko dan `tax_category_code` produk; `quoteCart` murni memanggil kalkulator. `tax` mendapat `mode`, `inclusive`, `error`, `engine` (aditif)                                                                                                                                                                                                                          |
| Penempatan | `order-directory.ts`, `pos-directory.ts` -> `finaliseOrderTax`                                                                                                     | Satu snapshot per pesanan (`documentType = "order"`, referensi baris = id item pesanan) dalam transaksi yang sama, `awcms_commerce_orders.tax_snapshot_id` disimpan, audit `tax.snapshot.finalise` + event outbox modul; gagal tertutup (`OrderTaxMismatchError`) bila pajak snapshot berbeda dari pajak yang dihitung                                                                                                    |
| Pembalikan | `return-directory.ts`, `order-directory.ts` -> `reverseOrderTaxForReturn` / `reverseOrderTaxForCancellation`                                                       | Dari snapshot ASLI: retur membalik unit yang dikembalikan (baris pembalikan `{ lineRef: id item pesanan, quantity }`, id dokumen `return:<id>`); pembatalan/kedaluwarsa membalik sisanya. Pesanan mode flat dan sebelum cut-over tanpa snapshot: tidak melakukan apa-apa                                                                                                                                                  |
| Cut-over   | `scripts/commerce-tax-cutover.ts` -> `application/tax-cutover.ts`                                                                                                  | Khusus-ops, dry-run bawaan: turunkan dan terbitkan `store-default`, paritas bayangan atas pesanan terbaru (tolak kecuali persis), balik `tax_mode`; `--rollback`                                                                                                                                                                                                                                                          |
| Admin      | `src/pages/admin/commerce.astro`, `commerce-settings.astro`                                                                                                        | Bidang Kategori pajak produk; lencana mode hanya-baca bertaut ke `/admin/tax`                                                                                                                                                                                                                                                                                                                                             |
| Tes        | `tests/commerce-tax-adapter.test.ts`, `tests/integration/commerce-tax-adapter.integration.test.ts`                                                                 | Paritas (2.000 + 500 keranjang berbenih), alokasi, kategori, harga inklusif, penolakan; flat tidak berubah, cut-over/penolakan/rollback, satu snapshot per pesanan storefront dan POS, pemutaran ulang, imutabilitas riwayat, pembalikan retur/pembatalan/kedaluwarsa (peran worker), RLS dan FK komposit, pajak dari klien diabaikan                                                                                     |

- **Laporan pajak adalah milik modul pajak** (`tax.snapshot_activity`, `GET /api/v1/tax/reports/reconciliation`), bukan irisan commerce (ADR-0039 D5). Proyeksi penjualan tetap membaca kolom `tax` pesanan, yang pada mode engine adalah angka snapshot.
- **Refund pajak (isu #323).** Retur mengembalikan pajak yang dikenakan pada unit yang dikembalikan: `refund_total = goods_gross − discount_share + shipping_refund + tax_refund` (`sql/1000`). Mode flat (dan pesanan tanpa snapshot pajak) memprorata pajak pesanan per unit dengan dekomposisi yang sama seperti barang dan diskon; mode engine dengan harga eksklusif mengembalikan persis total pajak snapshot pembalikan, sehingga uang dan buku besar pajak sama; harga inklusif tidak menambah apa pun (pajak sudah ada di nilai barang). Lihat adendum pajak ADR-0033. Biaya asuransi tetap tidak dikembalikan.
- **Netralitas regulasi.** Tidak ada tarif yang ditegaskan di sini; perubahan tarif atau regulasi adalah versi berlaku-tanggal baru yang disusun di `/admin/tax` (ADR-0039 D6). Ekspor Coretax / e-Faktur di luar cakupan.

## Bundel: kit barang yang stoknya lewat komponennya — TERIMPLEMENTASI (Issue #290, epik #281 — [ADR-0036](../../../../../docs/adr/0036-bundles-are-component-stocked-products-sold-as-one-line.md))

- **Model.** Bundel adalah produk dengan `kind = 'bundle'` (`sql/953`); tanpa varian, tanpa stok sendiri (kolom ditahan di `0`; model baca melaporkan ketersediaan hitungan sebagai `stock`), bukan produk jasa, dan tidak layak flash sale. 1–20 komponennya adalah baris `awcms_commerce_bundle_components` (FK tenant komposit, RLS FORCE). **Tanpa nesting**: trigger menolak komponen yang berupa bundel dan produk komponen yang menjadi bundel, sehingga siklus tidak mungkin ada. (Jangan tertukar dengan `type = 'bundle'` dari issue #266, tipe deskriptif tanpa semantik stok.)
- **Harga.** `bundle_pricing` `fixed` (harga produk sendiri) atau `derived` (Σ harga daftar komponen × kuantitas dikurangi `bundle_discount_percent`, half-up ke sen) — `domain/bundle.ts`, sen bilangan bulat. `finalPrice` publik bundel derived membawa harga turunan; `price` dibiarkan.
- **Satu baris, satu snapshot.** `application/cart-quote-service.ts` melipat bundel ke snapshot produknya (`stock` = `min floor(stok komponen / kuantitas)`); bundel dijual sebagai SATU item pesanan, plus baris append-only `awcms_commerce_order_item_components` (`sql/954`: unit, teks saat terjual, `allocated_value` dibagi dengan sisa-terbesar, Σ = total baris) yang ditulis `sellBundleLine` di `application/bundle-directory.ts`.
- **Stok.** Baris bundel tidak menggerakkan apa pun; komponennya yang bergerak. `counter`: komponen dikunci (`FOR NO KEY UPDATE`, produk lalu varian, id menaik), keranjang ditawar ulang terhadap hitungan terkunci, baru dikurangi. `ledger`: satu `sale` per komponen lewat seam ADR-0038, baris sumber `<orderItemId>:c<position>`, diurutkan bersama baris lain dalam savepoint yang sama. Batal/kedaluwarsa (`commerce_order_restock`) dan retur bundel utuh (`commerce_return`, `<returnLineId>:c<position>`) membaca snapshot, bukan definisi saat ini.
- **Pajak.** Satu baris, dipajaki menurut kategori pajak produk bundel sendiri (kelas per komponen ditunda).
- **Admin.** Formulir produk punya sakelar Bundle, strategi harga, persen diskon, dan textarea isi `SKU x jumlah` (`lib/ui/commerce-bundle-form.ts`); `POST/PATCH /products` menerima `kind`, `bundlePricing`, `bundleDiscountPercent`, dan `bundleComponents` (id atau SKU). Tanpa izin baru. Pencarian POS dan pemindaian barcode menemukan bundel seperti produk lain; halaman produk etalase mendaftar "Isi paket".
- **Tes.** `tests/commerce-bundles-domain.test.ts`, `tests/commerce-bundle-form.test.ts`, `tests/integration/commerce-bundles.integration.test.ts`; etalase (workspace `apps/storefront`, tes build-smoke `paket-build-smoke`).

## Segmen CRM — TERIMPLEMENTASI (Issue #360, epik #280 — [ADR-0042](../../../../../docs/adr/0042-crm-segments-are-immutable-versioned-closed-vocabulary-rules-evaluated-on-demand.md))

Di balik bendera `features.segments` (bawaan MATI). Segmen adalah aturan tersimpan, bernama, berversi atas pelanggan; keanggotaan diturunkan sesuai permintaan dan tidak pernah disimpan.

| Lapisan     | Letak                                                                                                                                                                | Catatan                                                                                                                                                                                                                                                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Skema       | `sql/1001`–`1004`                                                                                                                                                    | `awcms_commerce_segments` (kepala), `awcms_commerce_segment_versions` (tak dapat diubah: tanpa UPDATE/DELETE untuk `awcms_app`, trigger menolak UPDATE bagi semua), satu indeks cakupan parsial pada pesanan lunas, tujuh izin, grant worker                                                                                                                                         |
| Domain      | `domain/segment-rules.ts`, `domain/segment.ts`, `domain/segment-lifecycle.ts`                                                                                        | Kosakata TERTUTUP (`FIELD_SPECS`) dan validatornya dengan `SEGMENT_RULE_LIMITS` (kedalaman 4, 25 simpul, 10 anak, 3 jendela, 8 KiB); validator permintaan (kunci badan di luar daftar izin, seperti `tenantId`, ditolak dengan menyebut namanya); `SEGMENT_EVALUATION_LIMITS`; penyembunyian kelompok kecil (<5); topeng; CSV netral-rumus; deskriptor `dataLifecycle`/`subjectData` |
| SQL         | `application/segment-sql.ts`                                                                                                                                         | Satu templat literal per (bidang, operator); operand terikat; kelayakan (hidup, aktif, bukan placeholder walk-in) sebelum aturan; satu pemindaian terkelompok pesanan lunas untuk semua fakta pesanan; relasi yang tidak dibaca tidak digabung                                                                                                                                       |
| Evaluasi    | `application/segment-evaluator.ts`                                                                                                                                   | `runBoundedEvaluation`: try-lock advisory (2/tenant, 1/aktor), `statement_timeout` dalam savepoint, as-of server; `previewSegment`, `listSegmentMembersPage`, `exportSegmentMembers`                                                                                                                                                                                                 |
| Persistensi | `application/segment-directory.ts`                                                                                                                                   | Buat (kepala + versi 1), sunting dengan `baseVersion` di bawah `FOR UPDATE` (versi baru, tidak pernah perubahan), pensiunkan (menjaga versi), `resolveSegmentRules` (memvalidasi ulang versi tersimpan; sambungan untuk #361/#362), audit                                                                                                                                            |
| HTTP        | `application/segment-http.ts`, `src/pages/api/v1/commerce/segments/**`                                                                                               | Gerbang fitur, izin kedua (`commerce.customers.read`) pada anggota/ekspor, pembatas pratinjau, pemetaan penolakan                                                                                                                                                                                                                                                                    |
| Layar       | `src/pages/admin/commerce-segments.astro`                                                                                                                            | Definisikan (pembangun semua/salah satu yang datar atau JSON), daftar, satu segmen: aturan, versi, pratinjau, pelanggan, sunting, pensiunkan                                                                                                                                                                                                                                         |
| Pengujian   | `tests/commerce-segment-domain.test.ts`, `tests/integration/commerce-segments.integration.test.ts`, `tests/integration/commerce-segments-routes.integration.test.ts` | Kosakata dan batas; setiap bidang terhadap data hidup, pengecualian, ketakbisaubahan, RLS, batas waktu/konkurensi, pengukuran M7; sakelar dan pemisahan izin lewat HTTP                                                                                                                                                                                                              |

Aturan yang harus dijaga perubahan di sini: tambah bidang aturan hanya dengan ADR, templat literal, dan tes; jangan pernah membangun teks SQL dari aturan; jangan pernah menyimpan anggota; jangan pernah menerima as-of dari klien; jaga kelayakan di depan aturan.

## Dengan sengaja tidak ada di sini

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

## Pengeluaran: kas kecil lokal-commerce — TERIMPLEMENTASI (Issue #294, epik #281 — [ADR-0031](../../../../../docs/adr/0031-expenses-are-commerce-local-register-linked-petty-cash.md))

Dua tabel (`sql/990`: `awcms_commerce_expense_categories`, `awcms_commerce_expenses`), referensi pengeluaran bertipe pada mutasi register (`sql/991`: `reference_kind = 'expense'` + `expense_id`, indeks unik parsial paling banyak satu mutasi keluar dan satu masuk per pengeluaran), dua belas izin (`sql/992`), grant purge worker (`sql/993`).

- **Letak kodenya.** `domain/expense.ts` (kosakata, validator, keputusan persetujuan dan SoD, pengaturan ambang, pelipatan laporan sen yang tepat — murni), `domain/expense-csv.ts` (CSV yang dinetralkan dari formula, memakai helper CSV tutup kas), `domain/expense-lifecycle.ts` (deskriptor `dataLifecycle` / `subjectData`), `application/expense-category-directory.ts`, `application/expense-directory.ts` (pembacaan, draf, pembuangan, struk, ringkasan, ekspor), `application/expense-posting.ts` (post, decide, reverse — satu-satunya kode yang menulis mutasi register untuk pengeluaran, lewat `appendRegisterMovement` di `register-session-directory.ts`), `application/expense-http.ts` (gerbang fitur dan satu-satunya pemetaan penolakan-ke-HTTP).
- **Aturan yang harus dijaga perubahan.** Pengeluaran tidak pernah mengedit total tutup kas — ia menambahkan mutasi (keluar saat posting, `correction` masuk penyeimbang saat pembalikan) dan tidak lebih; urutan kunci baris pengeluaran, lalu sesi, selalu; setiap mutasi mengunci dulu dan membaca penyimpanan idempotensi sesudahnya; isi dibekukan begitu baris meninggalkan `draft` (trigger); pembuat tidak pernah menyetujui pengeluarannya sendiri (CHECK dan kode); struk adalah objek media privat, terverifikasi, milik pengunggah, sekali pakai yang diselesaikan dari pengeluaran, tidak pernah dari id yang diberikan pemanggil; payload audit dan event membawa uang dan id, tidak pernah deskripsi, payee, catatan, atau alasan.
- **Flag fitur.** `features.expenses` bawaannya MATI (pengeluaran laci juga memerlukan `register`); ambangnya `expenses.approvalThreshold` di pengaturan modul (bawaan ketat `0.00`; nilai rusak kembali ke sana). Selama MENYALA, rute mutasi manual menolak `movementType: "expense"`.
- **Izin.** `commerce.expense_categories.{read,create,update}`, `commerce.expenses.{read,create,update,export}`, `commerce.expense_postings.{create,approve}`, `commerce.expense_reversals.approve`, `commerce.expense_receipts.{read,create}` — hanya kata kerja `AccessAction` yang ada.
- **Event.** `awcms.commerce.expense.{posted,reversed}` pada agregat `commerce.expense`; audit `expense.*` / `expense_category.*`.
- **Layar.** `/admin/commerce-expenses` (lihat panduan cms akar awcms-one, [panduan modul commerce](../../../../../docs/cms.md)).
- **Ditunda.** Referensi payee/pihak bertipe, beberapa struk per pengeluaran dan kontrol unggah di layar, pengeluaran berulang, ambang per kategori — lihat [ADR-0031](../../../../../docs/adr/0031-expenses-are-commerce-local-register-linked-petty-cash.md).

## Segmen CRM sebagai audiens kampanye - TERIMPLEMENTASI (Issue #362, epic #280 - [Amendemen ADR-0042](../../../../../docs/adr/0042-crm-segments-are-immutable-versioned-closed-vocabulary-rules-evaluated-on-demand.id.md))

Di balik `features.campaignSegmentAudience` (bawaan MATI; juga butuh `campaigns` dan `segments`). Kampanye dapat menyebut segmen sebagai seluruh audiensnya; dispatcher tetap menelusuri buku penerima yang ada.

| Lapisan  | Letak                                                                                                                                                                                                             | Catatan                                                                                                                                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skema    | `sql/1007`                                                                                                                                                                                                        | `segment_id`, `segment_version`, `segment_as_of` pada `awcms_commerce_campaigns`; FK komposit ke versi yang tak berubah                                                                                                       |
| Aplikasi | `application/campaign-segment-audience.ts`                                                                                                                                                                        | Gerbang tiga sakelar, penguncian versi, hitungan berbatas, dan penyelesai halaman dispatcher (ditunda, tidak pernah difinalisasi, pada setiap penolakan)                                                                      |
| SQL      | `application/segment-sql.ts` (`CampaignReach`)                                                                                                                                                                    | Persetujuan, akun aktif, alamat kanal dan kursor lanjut ditambahkan SETELAH aturan, sehingga jangkauan hanya dapat mengurangi orang                                                                                           |
| HTTP     | `application/campaign-segment-http.ts`, `src/pages/api/v1/commerce/campaigns/**`                                                                                                                                  | `commerce.segments.read` untuk memilih segmen, `commerce.segment_previews.read` untuk hitungannya, pemetaan penolakan                                                                                                         |
| Dispatch | `application/campaign-dispatch.ts`                                                                                                                                                                                | Klaim mengisi `segment_as_of` sekali; halaman tertunda membuat kampanye tetap `sending`                                                                                                                                       |
| Uji      | `tests/commerce-campaign-segment-audience.test.ts`, `tests/integration/commerce-campaign-segment-audience.integration.test.ts`, `tests/integration/commerce-campaign-segment-audience-routes.integration.test.ts` | Validasi dan kontrak statis; penyelesaian, persetujuan saat enqueue dan dispatch, pengecualian, versi dan as-of, kampanye lama tidak berubah, sakelar mati, lintas-tenant, dispatch yang dapat dilanjutkan; rute, izin, audit |

Aturan yang harus dijaga perubahan di sini: persetujuan dan pengecualian tetap bagian kueri halaman; jangan pernah memmaterialisasi daftar pelanggan kedua; halaman yang ditolak menunda, tidak pernah memfinalisasi; kampanye lama (tanpa segmen) memakai penyelesai lama tanpa disentuh.
