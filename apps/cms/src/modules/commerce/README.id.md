🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](README.md)

<!-- i18n-source-hash: sha256:45adeefd84615055de6e96523c8f2a491fde2ad718ec3c07177db9b6b4f03d6c -->

# `commerce`

Irisan katalog dari storefront yang di-re-platform (Issue #4, bagian dari epic #1): **kategori** produk (hierarkis, self-referencing) dan **produk**, tenant-scoped, di-port dari kolom katalog inti tabel MySQL legacy `commerce_bj_mart.{categories,products}`.

| Aspek      | Nilai                                                                                                           |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| Key / type | `commerce` · `domain`, `isCore: false`                                                                          |
| Tabel      | `awcms_commerce_categories`, `awcms_commerce_products` (`sql/153`)                                              |
| Permission | `categories.{read,create,update,delete}`, `products.{read,create,update,delete}` (`sql/154`)                    |
| API        | `/api/v1/commerce/{categories,products}` (`openapi/modules/commerce.openapi.yaml`)                              |
| Event      | `commerce.product.{created,updated,status_changed}` — lihat di bawah                                            |
| Depends on | `tenant_admin`, `identity_access`, `domain_event_runtime` — belum ada modul lain yang bergantung pada modul ini |

## Hanya katalog, dan apa yang TIDAK ada di sini

Ini dengan sengaja sebuah irisan, bukan skema upstream penuh. Tabel sumbernya membawa 40+ kolom produk; modul ini mengambil intinya (`categoryId`, `type`, `sku`, `name`, `slug`, `description`, `digitalNote`, `price`, `discountPercent`, `stock`, `status`, `label`, `labelColor`) dan menyisakan sisanya untuk peningkatan berikutnya: harga bertingkat (`price_level_2/3/4`), `cost_price`, field afiliasi, size chart, field asuransi, promo banner, `variant_attributes`, dan tabel-tabel terkait `product_images`, `product_variants`, `flash_sale_products`, `product_affiliate_links`. Tidak ada kode di modul ini yang mereferensikan satu pun dari itu, jadi mengadopsinya nanti bersifat aditif — kolom baru dan sebuah migrasi, bukan penulisan ulang.

Itu juga sebabnya modul ini **tidak punya dependensi `media_library`**: `product_images` adalah salah satu tabel yang ditunda, jadi belum ada apa pun di sini yang me-resolve referensi media.

## Uang adalah `numeric(14,2)`, dan melintasi wire sebagai string

`price` tidak pernah berupa float — binary floating point tidak bisa merepresentasikan `0.10` secara eksak, dan aritmetika uang di atasnya melenceng. `numeric(14,2)` PostgreSQL eksak; `Bun.SQL` mengembalikan kolom `numeric` sebagai **string**, dan `application/product-directory.ts` tidak pernah mem-parsingnya menjadi angka. DTO menjaganya tetap string sampai ke response API; storefront memformatnya dengan `Intl.NumberFormat`, bukan menghitung dengannya di sini. `discountPercent` dan `stock` adalah `integer` biasa — keduanya bukan uang, dan keduanya eksak dalam floating point.

## Dua sumbu independen: `status` dan soft delete

Status siklus hidup produk (`draft` → `active`/`archived`, `active` ⇄ `inactive`, keduanya → `archived`, `archived` → `draft` saja — `LEGAL_TRANSITIONS` milik `domain/product-status.ts`) dan apakah baris itu soft-deleted (`deleted_at`) dengan sengaja dipisah. Menarik produk dari penjualan tanpa kehilangan recordnya adalah `status = 'inactive'`; menghapusnya dari tampilan katalog admin tenant adalah `deleted_at`. Tidak ada endpoint transisi-status khusus — `status` melintas lewat `PATCH /api/v1/commerce/products/{id}` yang sama dengan field lainnya, dan `updateProduct` milik `application/product-directory.ts` yang memeriksa transisinya sah (sebelum tulisan apa pun — lihat komentarnya soal kenapa urutannya krusial) dan menolak yang tidak sah dengan 400, menyebutkan status yang benar-benar bisa dicapai dari status produk saat ini.

Kategori tidak punya status dan tidak punya `parentId` di update (lihat bagian berikutnya) — analog struktural terdekat di base ini, `awcms_offices`, mengambil dua pilihan yang sama, dan untuk alasan yang sama: posisi hierarki ditetapkan sekali, dan re-parenting akan butuh deteksi siklus yang bahkan tidak dibangun codebase ini untuk offices.

## Hierarki, dan ongkos re-parenting

`parentId` self-referencing dan hanya ditetapkan saat pembuatan (`CreateCategoryInput`); `UpdateCategoryInput` sama sekali tidak membawanya. Memindahkan kategori ke parent baru karena itu adalah "hapus lalu buat ulang", bukan edit — keterbatasan yang sama yang diterima `office-directory.ts` untuk `parentOfficeId`. Kategori yang `parentId`-nya menyebut baris tenant lain, id yang tidak ada, atau yang sudah soft-deleted ditolak secara identik (400, `ParentCategoryNotFoundError`) — ketiga penyebabnya sengaja tak terbedakan, supaya field itu tak bisa dipakai untuk menyelidiki id kategori di tempat lain di platform (bentuk yang sama dengan GHSA-r7cx-c4jh-cvvw). `products.categoryId` mendapat perlakuan yang sama (`ProductCategoryNotFoundError`), dan tak seperti parent kategori, ia **bisa** ditetapkan ulang lewat update.

## Belum ada endpoint restore

Tak seperti `awcms_offices`, kedua tabel ini tak punya kolom `deleted_by`/`restored_at`/`restored_by`, dan tak ada rute `[id]/restore.ts` atau permission `restore`. Kategori atau produk yang soft-deleted tetap disimpan — supaya baris apa pun yang masih mereferensikannya (kategori anak, `category_id` sebuah produk) menjaga FK yang valid — tapi irisan ini tidak menyediakan cara untuk mengembalikannya. Menambahkan restore nanti bersifat aditif: dua kolom nullable, satu permission, dan satu endpoint.

SIAPA yang membuat/mengubah/menghapus sebuah baris hanya hidup di log audit (`actorTenantUserId` milik `recordAuditEvent`), tak pernah di kolom pada kedua tabel ini — itu juga yang membuat entri `subjectData` di `module.ts` jujur ber-`unreachableBySubject`: tak ada kolom di sini yang bisa menautkan sebuah baris ke seseorang bahkan secara prinsip.

## Domain event: hanya produk, tiga event

`categories` tidak mempublikasikan apa pun — pilihan yang sama yang diambil `tenant_admin` untuk `awcms_offices`, tabel yang struktural paling dekat di base ini. `products` mempublikasikan tiga, semuanya pada aggregate `commerce.product`:

- `commerce.product.created` — sebuah produk dibuat (selalu `status: draft`).
- `commerce.product.updated` — field apa pun selain `status` berubah.
- `commerce.product.status_changed` — `status` bertransisi; membawa `previousStatus` dan `status`, jadi consumer yang hanya peduli apakah produk masih bisa dijual tak perlu men-diff barisnya.

Satu `PATCH` yang mengubah field biasa maupun `status` sekaligus mempublikasikan keduanya — keduanya fakta independen. Tidak ada event `product.deleted`: soft delete adalah urusan admin/audit (tercatat di log audit, sama seperti delete pada `categories`), bukan urusan visibilitas katalog — consumer yang peduli apakah produk masih bisa dijual sudah punya `status_changed`.

## Keunikan

`(tenant_id, slug)` unik per tabel di antara baris yang **hidup** (indeks parsial, `WHERE deleted_at IS NULL` — slug baris yang dihapus langsung bebas dipakai ulang), dan produk tambahan menegakkan `(tenant_id, sku)`. Benturan pada salah satunya muncul sebagai `409` dengan kode spesifik-field (`CATEGORY_SLUG_ALREADY_EXISTS`, `PRODUCT_SLUG_ALREADY_EXISTS`, `PRODUCT_SKU_ALREADY_EXISTS`) alih-alih `500` yang tak tertangani — `product-directory.ts` membedakan dua constraint produk lewat nama `PostgresError.constraint`, karena satu tangkapan `23505` saja tak bisa mengatakan field mana yang harus diperbaiki.

## Layar admin: satu, hanya-baca, khusus produk

`/admin/commerce` (`src/pages/admin/commerce.astro`) mendaftar produk — SKU, nama, tipe, harga, stok, status — ber-gate pada `commerce.products.read`. Tidak ada form buat/edit: checklist Issue #4 adalah API, dan setiap modul tetap butuh minimal satu layar ("no active module is left without an admin screen" milik `admin-media-page-contract.test.ts`), jadi inilah minimum yang sekaligus jujur dan benar. `categories.*` dan setiap aksi `products.*` selain `read` tetap berada di `NOT_YET_SCREENED` milik `scripts/admin-screen-coverage-ledger.ts` sampai layar CRUD yang lebih lengkap dibangun.

## Dengan sengaja tidak ada di sini

- **Tidak ada filter/pencarian di endpoint list.** `GET .../products` dan `GET .../categories` hanya menerima `cursor`, mengikuti bentuk `GET /api/v1/offices` — belum ada `?categoryId=`/`?status=`.
- **Tidak ada aksi `restore`** — lihat di atas.
