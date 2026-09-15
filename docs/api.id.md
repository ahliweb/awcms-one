🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](api.md)

<!-- i18n-source-hash: sha256:2b117b2b03062e9b7b7adc2e1aac8c6dd16ca7c0e7e0427b04bda7b2e68454c7 -->

# API

Endpoint `/api/v1/commerce/*` yang diekspos `apps/cms` dan dibaca `apps/storefront` saat build. Sumber kebenaran adalah [`apps/cms/openapi/modules/commerce.openapi.yaml`](../apps/cms/openapi/modules/commerce.openapi.yaml) — fragmen sumber yang digabung `bun run openapi:bundle` (di dalam `apps/cms`) menjadi dokumen `openapi/awcms-public-api.openapi.yaml` lengkap; halaman ini menjelaskan bentuknya, bukan salinan kedua spesifikasinya.

## Endpoint

| Method | Jalur | Tujuan |
| --- | --- | --- |
| `GET` | `/api/v1/commerce/categories` | Daftar kategori untuk tenant saat ini, keyset-paginated |
| `POST` | `/api/v1/commerce/categories` | Buat kategori |
| `GET` | `/api/v1/commerce/categories/{id}` | Ambil satu kategori |
| `PATCH` | `/api/v1/commerce/categories/{id}` | Ubah `name`/`slug`/`icon` kategori — **tanpa `parentId`**, lihat di bawah |
| `DELETE` | `/api/v1/commerce/categories/{id}` | Soft-delete kategori (teraudit) |
| `GET` | `/api/v1/commerce/products` | Daftar produk untuk tenant saat ini, keyset-paginated |
| `POST` | `/api/v1/commerce/products` | Buat produk (selalu mulai `status: draft`) |
| `GET` | `/api/v1/commerce/products/{id}` | Ambil satu produk |
| `PATCH` | `/api/v1/commerce/products/{id}` | Ubah produk, termasuk transisi status yang legal |
| `DELETE` | `/api/v1/commerce/products/{id}` | Soft-delete produk (teraudit) |

## Envelope

Setiap respons dibungkus `{ success: true, data }` atau `{ success: false, error: { code, message } }` — bentuk yang sama dipakai setiap modul `awcms`, selalu, termasuk respons error, sehingga respons non-2xx tetap ter-parse sebagai JSON. Kedua endpoint daftar meletakkan halamannya di dalam `data`: `{ success: true, data: { items: [...], nextCursor } }`.

## Paginasi: keyset, ukuran halaman tetap, tanpa filter

Kedua endpoint daftar **keyset-paginated**, terbaru lebih dulu (`ORDER BY created_at DESC, id DESC`), hanya menerima parameter query `cursor` yang opak (dari `nextCursor` respons sebelumnya, `null` di halaman terakhir). Ukuran halaman **tetap 100 di sisi server** dan bukan parameter request — mengirim `?limit=` tidak berefek, karena langkah `prepare` milik `commerce/application/{product,category}-directory.ts` hanya membaca `cursor` dari query string.

**Tidak ada filter `status` pada rute daftar produk.** `GET /api/v1/commerce/products` mengembalikan setiap produk hidup tanpa memandang status siklus hidup; pemanggil yang hanya menginginkan produk `active` memfilter di sisi klien. Ini persis yang dilakukan `getProducts()` milik `apps/storefront/src/lib/catalog.ts` — mengambil setiap halaman, lalu hanya menyimpan `status === "active"` lewat `switch` exhaustive (`isPubliclyVisible`) yang gagal compile jika `apps/cms` suatu saat menambah status kelima tanpa storefront diperbarui untuk menyatakan maknanya. Menambah filter `status` di sisi server adalah tindak lanjut yang masuk akal demi efisiensi saat build — storefront saat ini mengambil lalu membuang produk non-active — tapi belum dibangun di irisan ini, dan melakukannya adalah perubahan CMS dengan riak OpenAPI dan gate-nya sendiri, bukan celah dokumentasi.

## Bentuk request/respons

`CommerceCategory`:

```
{ id: uuid, parentId: uuid | null, name: string, slug: string, icon: string | null }
```

`CommerceProduct`:

```
{
  id: uuid, categoryId: uuid | null, type: "physical" | "digital" | "service" | "subscription",
  sku: string, name: string, slug: string, description: string | null, digitalNote: string | null,
  price: string,            // numeric(14,2), string desimal — lihat ADR-0003
  discountPercent: number,  // 0-100
  stock: number,
  status: "draft" | "active" | "inactive" | "archived",
  label: string | null, labelColor: string | null
}
```

`price` adalah satu-satunya field yang layak disebut eksplisit di sini meski [`docs/skema-basis-data.md`](skema-basis-data.md) dan [ADR-0003](adr/0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md) membahasnya lengkap: ia **string** JSON, mis. `"19999.00"`, tidak pernah angka JSON, di setiap request dan respons.

## Error yang didefinisikan API ini di luar envelope generik

| Status | Kapan | Kode |
| --- | --- | --- |
| `400` | `categoryId`/`parentId` tidak resolve ke kategori hidup di tenant pemanggil sendiri | — (lihat di bawah) |
| `400` | `status` yang diminta produk bukan transisi legal dari statusnya saat ini | — |
| `409` | `slug` kategori sudah dipakai baris hidup di tenant ini | `CATEGORY_SLUG_ALREADY_EXISTS` |
| `409` | `slug`/`sku` produk sudah dipakai baris hidup di tenant ini | `PRODUCT_SLUG_ALREADY_EXISTS` / `PRODUCT_SKU_ALREADY_EXISTS` |

`categoryId`/`parentId` yang tidak dikenal, sudah soft-delete, atau milik tenant lain ditolak dengan 400 yang **sama** di setiap kasus — lihat [`docs/skema-basis-data.md`](skema-basis-data.md) untuk alasan mengapa membedakan ketiga penyebab itu akan menjadi existence oracle lintas-tenant.

## Otorisasi: delapan izin

Modul ini mendefinisikan delapan kunci izin, masing-masing terdaftar di bawah. (Jumlah ini dijaga otomatis oleh penanda `hitung:` di [`api.md`](api.md), sumber Inggris dokumen ini — lihat berkas itu.)

| Kunci izin | Memberikan |
| --- | --- |
| `commerce.categories.read` | Daftar/ambil kategori |
| `commerce.categories.create` | Buat kategori |
| `commerce.categories.update` | Ubah kategori |
| `commerce.categories.delete` | Soft-delete kategori |
| `commerce.products.read` | Daftar/ambil produk |
| `commerce.products.create` | Buat produk |
| `commerce.products.update` | Ubah produk, termasuk statusnya |
| `commerce.products.delete` | Soft-delete produk |

Dua activity code (`categories`, `products`), masing-masing dengan empat aksi CRUD yang sama — dicerminkan persis di [`apps/cms/sql/154_awcms_commerce_permissions.sql`](../apps/cms/sql/154_awcms_commerce_permissions.sql), dengan gate yang menjaga seed dan array `permissions` milik `commerce/module.ts` selaras. Tidak ada izin `restore` untuk resource mana pun — irisan ini sama sekali tidak mengirim endpoint restore (lihat [`docs/skema-basis-data.md`](skema-basis-data.md)).

## Domain event: tiga, hanya produk

`categories` tidak mempublikasikan domain event apa pun — pilihan yang sama diambil `tenant_admin` untuk tabel yang paling dekat secara struktural di basis kode ini (`awcms_offices`); soft delete adalah fakta log-audit, bukan sesuatu yang perlu direaksi konsumen hilir. `products` mempublikasikan tiga, semua pada agregat `commerce.product`, terdaftar di tiga tempat yang dijaga selaras `awcms` (`domain-event-runtime/domain/event-type-registry.ts`, `asyncapi/awcms-domain-events.asyncapi.yaml`, `events.publishes` milik `commerce/module.ts`):

- `awcms.commerce.product.created` — produk dibuat (selalu `status: draft`).
- `awcms.commerce.product.updated` — field apa pun selain `status` berubah.
- `awcms.commerce.product.status_changed` — `status` bertransisi; membawa `previousStatus` dan `status`.

Satu `PATCH` yang mengubah field biasa maupun `status` dalam request yang sama mempublikasikan `.updated` dan `.status_changed` sekaligus — keduanya mencatat fakta independen. Tidak ada event `product.deleted`, dengan alasan yang sama kategori tidak mempublikasikan apa-apa: konsumen yang peduli apakah produk masih bisa dijual sudah punya `.status_changed` (mis. transisi ke `archived`).

## Belum dibangun

Pembacaan runtime API ini oleh storefront — setiap panggilan terjadi hanya saat `astro build` (lihat [ADR-0002](adr/0002-static-output-with-build-time-fetch-for-the-storefront.md)). Endpoint keranjang, checkout, pembayaran, pesanan, pengiriman, varian, flash-sale, dan afiliasi — tidak satu pun ada; API ini hanya menampilkan dua resource yang disebutkan di atas. Endpoint media/gambar untuk resource mana pun — tidak ada tabel `product_images` di irisan ini (lihat [`docs/skema-basis-data.md`](skema-basis-data.md)).
