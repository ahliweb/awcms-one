🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](api.md)

<!-- i18n-source-hash: sha256:8105f4c1728a3ab5f8e198e58f94df26342380ca7074a5bfe60b508d79963f33 -->

# API

Dua permukaan API hidup di bawah `/api/v1/commerce/*`, pada dua tingkat kepercayaan yang berbeda. Sumber kebenaran adalah [`apps/cms/openapi/modules/commerce.openapi.yaml`](../apps/cms/openapi/modules/commerce.openapi.yaml), digabung oleh `bun run openapi:bundle` (di dalam `apps/cms`) menjadi dokumen `openapi/awcms-public-api.openapi.yaml` yang lengkap; halaman ini menjelaskan bentuknya, bukan salinan kedua spesifikasinya.

| | Owner API | Storefront (anonim) API |
| --- | --- | --- |
| Base path | `/api/v1/commerce/*` | `/api/v1/commerce/storefront/*` |
| Pemanggil | Proses build `apps/storefront` (`AWCMS_API_TOKEN`); sesi browser admin | Browser pembeli, langsung, lintas-origin (`PUBLIC_AWCMS_ORIGIN`) |
| Auth | Token Bearer / sesi, diperiksa terhadap izin `commerce.*` | Tidak ada — tenant di-resolve dari header `Origin` request terhadap `awcms_tenant_domains` |
| Envelope | `{ success: true, data }` / `{ success: false, error: { code, message } }` — setiap respons, termasuk error | Envelope yang sama |
| Diperkenalkan oleh | Issue #4 (inti katalog), diperluas #23/#26 | Issue #29 (pola endpoint-anonim `ahliweb/awcms` — ADR-0103/0107/0118 miliknya sendiri — diterapkan pada commerce), dikonsumsi #30 |
| Keputusan arsitektur | — | [ADR-0007](adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.id.md) |

## Owner API: catalog, marketing, orders/customers/reviews

Dikelompokkan berdasarkan tiga area yang sama yang dideskripsikan [`docs/arsitektur.md`](arsitektur.id.md) dan [ADR-0008](adr/0008-one-commerce-module-carries-the-whole-store-not-three.md).

### Catalog (issue #4, diperdalam #23)

| Method | Jalur | Catatan |
| --- | --- | --- |
| `GET` | `/api/v1/commerce/categories` | `?parentId=`; keyset-paginated; setiap baris membawa `productCount` terhitung |
| `POST`/`GET`/`PATCH`/`DELETE` | `/api/v1/commerce/categories(/{id})` | `PATCH` tidak pernah menerima `parentId` — tak berubah setelah pembuatan, lihat [`docs/cms.md`](cms.id.md) |
| `POST` | `/api/v1/commerce/categories/{id}/restore` | Membatalkan soft delete (issue #23 menambahkan `restore` untuk kedua resource) |
| `GET` | `/api/v1/commerce/products` | `?categoryId=&status=&q=&sort=&featured=&recommended=&cursor=`; setiap baris membawa `finalPrice` terhitung-server dan `images[]`/`variants[]` yang sudah di-resolve |
| `GET` | `/api/v1/commerce/products/by-slug/{slug}` | Tidak pernah me-resolve baris yang sudah soft-delete |
| `POST`/`GET`/`PATCH`/`DELETE`/`.../restore` | `/api/v1/commerce/products(/{id})` | `POST` selalu mulai `status: draft`; `PATCH` memeriksa `LEGAL_TRANSITIONS` sebelum tulisan apa pun |
| `POST`/`PATCH`/`DELETE` | `/api/v1/commerce/products/{id}/images(/{imageId})` | `mediaObjectId` diperiksa live terhadap `MediaLibraryPort.isMediaReferenceSafe` sebelum insert |
| `POST`/`PATCH`/`DELETE` | `/api/v1/commerce/products/{id}/variants(/{variantId})` | Keunikan SKU diperiksa terhadap `awcms_commerce_products` maupun tabel varian itu sendiri |

Paginasi: keyset, terbaru lebih dulu secara default (`sort=newest`), ukuran halaman tetap 100 di sisi server. Sort `price_asc`/`price_desc`/`name` mengembalikan satu halaman terbatas tunggal (`nextCursor: null`) alih-alih penelusuran keyset — `cursor` yang dikombinasikan dengan sort selain `newest` ditolak 400.

### Marketing (issue #26)

| Keluarga | Rute owner | Model baca publik |
| --- | --- | --- |
| Flash sale | `/flash-sales`, `/{id}`, `/{id}/products(/{rowId})` | `GET /flash-sales/active` — status **diturunkan** dari jendela waktu, dipersist oleh job `commerce:flash-sales:tick`, yang memicu `commerce.flash_sale.{started,ended}` tepat sekali per transisi |
| Voucher | `/vouchers`, `/{id}`, `POST /vouchers/validate` | `GET /vouchers/public` — aritmetika sen-bulat eksak, cap `maxDiscount`; penebusannya sendiri terjadi pada pesanan (di bawah) |
| Slider / testimoni / popup | `/sliders`, `/testimonials`, `/popups` (masing-masing CRUD) | `/sliders/active`, `/testimonials/active`, `/popups/active` — paling banyak satu popup aktif per tenant (partial unique index) |
| Pengaturan toko | `GET`/`PUT`/`DELETE /store-settings` (satu dokumen `jsonb` ber-versi per tenant) | `GET /store-settings/public` — tidak pernah nomor rekening bank, pemilik rekening, atau referensi QRIS |

`DELETE /store-settings` berarti "reset ke default", bukan hapus-pengaturan-tenant: ia mencap `deleted_at`, pembacaan publik dan owner lalu menjawab dengan default, dan `PUT` berikutnya menghapus cap itu.

### Pesanan, pelanggan, ulasan (issue #29) — sisi owner

| Method | Jalur | Catatan |
| --- | --- | --- |
| `GET`/`PATCH` | `/api/v1/commerce/orders(/{id})`, `.../orders/{id}/status` | Tidak ada `POST`/`DELETE` — pesanan hanya pernah dibuat lewat jalur storefront anonim (di bawah) |
| `PATCH` | `/api/v1/commerce/orders/{id}/payment-confirmations/{cid}/review` | `{ decision: "accepted" \| "rejected" }`; menerima mengubah `paymentStatus` pesanan menjadi `paid` |
| `GET` | `/api/v1/commerce/orders/export.csv` | |
| `GET`/`PATCH` | `/api/v1/commerce/customers(/{id})` | Tidak ada `POST`/`DELETE` — baris pelanggan hanya dibuat oleh jalur pesanan anonim |
| `GET`/`PATCH`/`DELETE` | `/api/v1/commerce/reviews(/{id})` | `PATCH {status}` memoderasi `pending → published/rejected` |

## Storefront (anonim) API — `/api/v1/commerce/storefront/*`

Setiap rute me-resolve tenant-nya dari `Origin`/`Host` request terhadap `awcms_tenant_domains` — tidak pernah dari header yang dikontrol pemanggil — menjawab preflight `OPTIONS`, meng-echo origin yang diizinkan apa adanya (tidak pernah `*`), mengirim `Vary: Origin`, tidak memberi kredensial apa pun, dan rate-limit per IP (pembuatan pesanan juga per nomor telepon ternormalisasi). Lihat [ADR-0007](adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.id.md) untuk alasan ini ada alih-alih kredensial runtime.

| Method | Jalur | Catatan |
| --- | --- | --- |
| `POST` | `cart/quote` | `{ lines[], shipping, voucherCode, insurance }` → subtotal → diskon voucher → ongkir → asuransi → pajak → total, setiap angka adalah string `numeric(14,2)`; `status` sebuah baris menandai `out_of_stock`/opsi yang tidak tersedia tanpa menggagalkan seluruh quote |
| `POST` | `orders` | `{ idempotencyKey, customer, address\|null, lines[], shipping, payment, voucherCode, insurance, notes }` → `201` (atau `200` pada pengulangan idempoten kunci yang sama); `400 VALIDATION_ERROR` dengan `details[].{field,message}`; `409 CART_CHANGED` dengan `details.quote` baru kapan pun re-quote satu baris bukan `"ok"` |
| `GET` | `orders/{code}?phone=` | Bentuk pesanan penuh; **`404 NOT_FOUND`, identik byte-demi-byte, untuk kode yang tidak dikenal, telepon yang salah, atau pesanan tenant lain** — satu respons netral, bukan tiga yang bisa dibedakan (lihat [ADR-0009](adr/0009-guest-checkout-by-order-code-and-phone.id.md)) |
| `POST` | `orders/{code}/payment-confirmations` | `{phone, method, amount, bankName, accountName, transferredAt, proofMediaObjectId}`; `409 ORDER_NOT_PAYABLE` di luar `pending_payment` |
| `POST` | `orders/{code}/payment-proof/upload-sessions(/{id}/finalize)` | Selalu `503 MEDIA_UNAVAILABLE` di increment ini — lihat [`docs/cms.md`](cms.id.md) |
| `POST` | `orders/{code}/cancel` | `{phone, reason}`; `409 ORDER_NOT_CANCELLABLE` di luar `pending_payment` |
| `POST` | `reviews` | Membutuhkan pesanan `completed` untuk produk itu; dibuat dengan `status: pending`, dimoderasi di sisi owner |
| `GET` | `store-settings/public` | Juga dipakai build storefront; rute yang sama melayani pemanggil saat-build maupun (pada prinsipnya) saat-runtime |

**Idempotensi:** pembuatan pesanan memakai ulang store `awcms_idempotency_keys` yang modul-agnostik (`(tenantId, requestScope, idempotencyKey)`, tidak butuh principal — ia bekerja dari wrapper tenant anonim). UUID yang dibuat klien milik keranjang sendiri dipakai ulang sebagai idempotency key, sehingga klik "Buat pesanan" yang terkirim ganda mengembalikan `orderCode` yang sama alih-alih membuat pesanan kedua.

## Bentuk request/respons

`CommerceProduct` (pembacaan owner dan storefront berbagi bentuk yang sama; field yang ditambahkan #23 bersifat aditif):

```
{
  id: uuid, categoryId: uuid | null, type: "physical" | "digital" | "service" | "subscription",
  sku: string, name: string, slug: string, description: string | null, digitalNote: string | null,
  price: string, priceLevel2/3/4: string | null,   // string numeric(14,2) — lihat ADR-0003
  discountPercent: number, finalPrice: string,       // dihitung-server, aritmetika sen-bulat eksak
  stock: number, status: "draft" | "active" | "inactive" | "archived",
  label: string | null, labelColor: string | null,
  images: [{ id, publicUrl, sortOrder, altText }], variants: [{ id, name, value, sku, price, stock, ... }],
  isFeatured: boolean, isRecommended: boolean, manualRating: string | null, manualSoldCount: number
}
```

`price`, `priceLevel2/3/4`, `finalPrice`, dan setiap field uang pada bentuk pemasaran/pesanan di bawah adalah JSON **string**, mis. `"19999.00"`, tidak pernah angka JSON — lihat [ADR-0003](adr/0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.id.md) dan catatan `normalizeMoney` di [`docs/pengujian.md`](pengujian.id.md).

`Order` (pembacaan pelacakan storefront, `GET .../orders/{code}?phone=`):

```
{
  orderCode: string, status: "pending_payment" | "paid" | "processing" | "shipped" | "completed" | "cancelled" | "expired",
  paymentStatus: "unpaid" | "dp_paid" | "paid" | "refunded",
  customer: { name, phone }, address: {...} | null,
  items: [{ productId, variantId, name, variantName, sku, quantity, unitPrice, lineTotal }],
  subtotal, discount, shipping, insuranceFee, tax, total: string,
  timeline: [{ fromStatus, toStatus, actor, note, createdAt }],
  expiresAt: string | null, paidAt/shippedAt/completedAt/cancelledAt: string | null
}
```

## Otorisasi: 39 izin owner

Modul `commerce` mendeklarasikan 39 kunci izin secara total (10 + 22 + 7 di bawah), dikelompokkan berdasarkan tiga area yang sama dengan tabelnya — jumlah yang terlalu besar untuk konvensi "angka yang dieja cocok dengan set yang dihitung" milik dokumen ini sendiri (pengecekan hitungan-tertaut milik `bun run audit:dokumen` hanya mengenali angka yang dieja satu sampai dua puluh), sehingga di sini dinyatakan sebagai angka numeral, bukan di dalam blok terjaga.

| Area | Kunci izin |
| --- | --- |
| Catalog (10) | `commerce.categories.{read,create,update,delete,restore}`, `commerce.products.{read,create,update,delete,restore}` |
| Marketing (22) | `commerce.{flash_sales,vouchers,sliders,testimonials,popups}.{read,create,update,delete}` (20), `commerce.settings.{read,update}` (2) |
| Orders/customers (7) | `commerce.orders.{read,update}`, `commerce.customers.{read,update}`, `commerce.reviews.{read,update,delete}` |

Sengaja **tanpa `create`/`delete` untuk `orders`/`customers`**: baris pesanan atau pelanggan hanya dibuat lewat jalur storefront anonim, tanpa pengecekan izin sama sekali (tidak ada identitas admin di jalur itu untuk diperiksa). Mendeklarasikan izin yang tidak ditegakkan persis cacat yang coba ditangkap gate `access:permissions:enforcement:check` milik `apps/cms`, jadi tidak satu pun dideklarasikan. Sengaja tidak ada `restore` untuk marketing, orders, customers, atau reviews — hanya catalog (`categories`/`products`) yang mendapat `restore` di increment ini.

API storefront (anonim) sama sekali **tidak punya kunci izin** — batas kepercayaannya adalah tenant resolver yang Origin-bound, bukan RBAC/ABAC.

## Domain event: dua belas

Kedua belas event terdaftar di tiga tempat yang dijaga selaras `awcms` (`domain-event-runtime/domain/event-type-registry.ts`, `apps/cms/asyncapi/awcms-domain-events.asyncapi.yaml`, `events.publishes` milik `commerce/module.ts`):

| Agregat | Event |
| --- | --- |
| `commerce.product` | `awcms.commerce.product.{created,updated,status_changed}` |
| `commerce.flash_sale` | `awcms.commerce.flash_sale.{started,ended}` — dipicu tepat sekali per transisi oleh job tick, bukan pada setiap pembacaan |
| `commerce.voucher` | `awcms.commerce.voucher.redeemed` — dideklarasikan lebih dulu sebagai forward reference di #26, baru benar-benar dipicu begitu jalur pesanan #29 menebus satu |
| `commerce.order` | `awcms.commerce.order.{created,paid,status_changed,cancelled,expired}` |
| `commerce.review` | `awcms.commerce.review.published` |

`categories` masih tidak mempublikasikan domain event apa pun — pilihan yang sama diambil `tenant_admin` untuk `awcms_offices`; soft delete adalah fakta log-audit, bukan sesuatu yang perlu direaksi konsumen hilir.

## Error yang didefinisikan API ini di luar envelope generik

| Status | Kode | Kapan |
| --- | --- | --- |
| `400` | `VALIDATION_ERROR` | Error input level-field, `details[].{field,message}` |
| `400` | — | `categoryId`/`parentId` tidak resolve ke kategori hidup di tenant pemanggil sendiri; `status` yang diminta produk bukan transisi legal |
| `409` | `CATEGORY_SLUG_ALREADY_EXISTS` / `PRODUCT_SLUG_ALREADY_EXISTS` / `PRODUCT_SKU_ALREADY_EXISTS` | Slug/SKU sudah dipakai baris hidup di tenant ini |
| `409` | `CART_CHANGED` | Re-quote milik request pembuatan-pesanan storefront tidak sepakat dengan keranjang yang dikirim; respons membawa `details.quote` baru |
| `409` | `ORDER_NOT_PAYABLE` / `ORDER_NOT_CANCELLABLE` | Status pesanan saat ini secara legal tidak mengizinkan aksi yang diminta |
| `404` | `NOT_FOUND` | Resource tak dikenal, atau — pada API storefront — penolakan netral yang mencakup "pesanan tak dikenal", "telepon salah", dan "milik tenant lain" secara identik |
| `503` | `MEDIA_UNAVAILABLE` | Rute upload-session bukti-pembayaran, selalu, di increment ini |

`categoryId`/`parentId` yang tak dikenal, sudah soft-delete, atau milik tenant lain ditolak dengan 400 yang **sama** di setiap kasus — lihat [`docs/skema-basis-data.md`](skema-basis-data.id.md) untuk alasan mengapa membedakan ketiga penyebab itu akan menjadi existence oracle lintas-tenant. API storefront menerapkan prinsip identik pada 404: `GET orders/{code}?phone=` tidak pernah mengungkapkan apakah kodenya ada sama sekali.

## Apa yang dipanggil storefront di luar commerce

Semua di sini milik `apps/cms` sendiri, dimiliki modul-modul yang dibawa subtree; repositori ini mengonsumsinya dan mencatat yang mana, supaya pembaca yang mencari "dari mana storefront mendapat X" tidak perlu grep.

| Permukaan | Pemanggil | Tingkat kepercayaan |
| --- | --- | --- |
| `GET /api/v1/blog/{posts,terms,institutions,pages/public}` | build (`AWCMS_API_TOKEN`) | owner, hanya-baca |
| `GET /api/v1/media/objects?ids=` | build | owner, hanya-baca — `media_library.media.read`, ditambahkan di increment 3 ([ADR-0011](adr/0011-storefront-media-resolves-through-the-media-objects-endpoint.md)) |
| `GET /api/v1/news-portal/ad-placements/active` | build | owner, hanya-baca |
| `GET /api/v1/seo/redirects?state=active` | build | owner, hanya-baca |
| `GET /api/v1/site-profile/composed` | build | owner, hanya-baca |
| `GET /api/v1/idn-regions/regions` | build | owner, hanya-baca — dibatasi 6 permintaan serentak sejak [issue #71](https://github.com/ahliweb/awcms-one/issues/71), di bawah 8 slot `interactive` yang berjalan di CMS |
| `GET /api/v1/analytics/pages?range=7d` | build | owner, hanya-baca — `visitor_analytics.dashboard.read`, memberi makan "Terpopuler" |
| `POST /api/v1/analytics/collect` | **peramban pembaca** | anonim, terikat Origin ([ADR-0012](adr/0012-first-party-visitor-analytics-with-an-opt-in-ga4-switch.md)) |
| `POST /api/v1/newsletter/{subscribe,confirm,unsubscribe}` | **peramban pembaca** | anonim, terikat Origin; path konfirmasi/berhenti adalah **kontrak CMS** (`NEWSLETTER_CONFIRM_PATH`/`NEWSLETTER_UNSUBSCRIBE_PATH` di `apps/cms/src/modules/newsletter/domain/newsletter-mail.ts`), itulah sebabnya aplikasi ini menyajikan `/newsletter/confirm` dan `/newsletter/unsubscribe` persis dengan nama itu |

Himpunan permission kredensial build di-seed oleh `tools/seed-borneojek-mart.ts`; mengubahnya di sana **merotasi** kredensial pada seed run berikutnya, sehingga `AWCMS_API_TOKEN` yang masih memegang rahasia lama mulai gagal dengan 401 (langkah rekonsiliasi issue #57 mencetak penggantinya).

## Belum dibangun

Tarif kurir RajaOngkir dan payment gateway — `payment_method` sudah menerima nilai enum `gateway` (aditif, per [ADR-0010](adr/0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.md)), tapi belum ada integrasi provider; keduanya harus lewat outbox begitu mendarat ([issue #33](https://github.com/ahliweb/awcms-one/issues/33)). Akun pelanggan, login, dan endpoint storefront terautentikasi apa pun ([issue #32](https://github.com/ahliweb/awcms-one/issues/32)) — setiap rute API storefront hari ini anonim by design. Upload bukti-pembayaran yang berfungsi untuk pemanggil anonim (alur sesi `media_library` membutuhkan `actorTenantUserId` terautentikasi, yang tidak dimiliki pemanggil checkout tamu mana pun).
