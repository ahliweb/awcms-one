🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](kamus-data.md)

<!-- i18n-source-hash: sha256:27511f92c18869d1ec1619a9255a4984d328feaaef47cb954a7f3bcc774dc90f -->

# Kamus data

Setiap kolom di `awcms_commerce_categories`/`awcms_commerce_products`, maknanya, domain satuan atau enum-nya, dan kolom sumbernya di skema MySQL legacy `commerce_bj_mart`.

## Provenans, dinyatakan sekali agar setiap baris di bawah tidak perlu mengulanginya

Daftar kolom legacy **direkam dari basis data `commerce_bj_mart` yang hidup pada 2026-09-14**, satu hari sebelum dokumen ini ditulis, selama pekerjaan yang menghasilkan bagian source-schema [issue #4](https://github.com/ahliweb/awcms-one/issues/4) dan `apps/cms/sql/153_awcms_commerce_schema.sql`. **`commerce_bj_mart` tidak terjangkau dari mesin tempat dokumen ini ditulis** — tidak ada koneksi hidup untuk memverifikasi ulang pemetaan mana pun di bawah ini terhadap basis data sumber hari ini. Setiap sel "kolom sumber" karena itu dinyatakan **sebagaimana direkam pada 2026-09-14**, bukan sebagai diperiksa-ulang secara independen saat menulis dokumen ini. Jika skema legacy sudah berubah sejak tanggal itu, tabel ini belum ikut bergerak.

Kedua tabel AWCMS dibangun dengan mem-porting **kolom katalog inti** skema legacy maju di bawah nama mereka sendiri — header `sql/153` sendiri dan docblock `commerce/module.ts` sama-sama mendeskripsikan ini sebagai porting langsung, dan daftar kolom-tertunda di bawah (ditarik dari sumber yang sama) sendiri adalah daftar nama kolom `commerce_bj_mart.products` legacy, yang menguatkan bahwa kolom yang dipertahankan membawa nama legacy-nya tanpa berubah alih-alih diganti nama saat porting. Setiap sel kolom-sumber di bawah adalah nama legacy yang sama kecuali dicatat sebaliknya.

## `awcms_commerce_categories` ← `commerce_bj_mart.categories`

| Kolom AWCMS | Kolom sumber legacy | Makna | Satuan / domain |
| --- | --- | --- | --- |
| `id` | `id` | Primary key | `uuid` di sini; tipe kunci legacy sendiri tidak diverifikasi ulang untuk dokumen ini (lihat Provenans) |
| `tenant_id` | *(tidak ada — baru)* | Kepemilikan baris di bawah model multi-tenant platform ini | `uuid`, FK ke `awcms_tenants`; `commerce_bj_mart` tidak punya konsep tenant, karena ia melayani satu toko |
| `parent_id` | `parent_id` | Hierarki self-referencing — parent kategori ini, atau root jika null | `uuid`, FK ke tabel yang sama; diset sekali saat pembuatan, lihat [`docs/cms.md`](cms.md) |
| `name` | `name` | Nama tampilan | Teks bebas |
| `slug` | `slug` | Identifier yang menghadap URL | Teks bebas, unik per tenant di antara baris hidup |
| `icon` | `icon` | Referensi ikon untuk kategori ini | Teks bebas |
| `created_at` | *(timestamp)* | Waktu pembuatan baris | `timestamptz` |
| `updated_at` | *(timestamp)* | Waktu baris terakhir diubah | `timestamptz` |
| `deleted_at` | *(tidak ada — baru)* | Penanda soft-delete; null berarti hidup | `timestamptz`, nullable |

## `awcms_commerce_products` ← `commerce_bj_mart.products`

| Kolom AWCMS | Kolom sumber legacy | Makna | Satuan / domain |
| --- | --- | --- | --- |
| `id` | `id` | Primary key | `uuid` di sini |
| `tenant_id` | *(tidak ada — baru)* | Kepemilikan baris di bawah model multi-tenant platform ini | `uuid`, FK ke `awcms_tenants` |
| `category_id` | `category_id` | Kategori produk | `uuid`, FK ke `awcms_commerce_categories`; referensi lintas-tenant ditolak di lapisan aplikasi, bukan oleh FK — lihat [`docs/skema-basis-data.md`](skema-basis-data.md) |
| `type` | `type` | Jenis produk | Enum: `physical`, `digital`, `service`, `subscription` — keempatnya dibawa maju tanpa berubah; lihat `commerce/domain/product-type.ts` |
| `sku` | `sku` | Kode stock-keeping unit | Teks bebas, unik per tenant di antara baris hidup |
| `name` | `name` | Nama tampilan | Teks bebas |
| `slug` | `slug` | Identifier yang menghadap URL | Teks bebas, unik per tenant di antara baris hidup — **lihat batasan migrasi di bawah** |
| `description` | `description` | Deskripsi produk panjang | Teks bebas, nullable |
| `digital_note` | `digital_note` | Catatan yang ditampilkan untuk produk digital menggantikan informasi pengiriman | Teks bebas, nullable |
| `price` | `price` | Harga satuan | `numeric(14,2)`, string desimal di jaringan, tidak pernah float — lihat [ADR-0003](adr/0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md) |
| `discount_percent` | `discount_percent` | Diskon yang diterapkan pada `price` | Persentase integer, 0–100 |
| `stock` | `stock` | Unit yang tersedia saat ini | Integer non-negatif; lihat [`docs/cms.md`](cms.md) untuk mengapa storefront tidak pernah membacanya saat runtime |
| `status` | `status` | Status siklus hidup | Enum: `draft`, `active`, `inactive`, `archived` — lihat [`docs/cms.md`](cms.md) untuk tabel transisi legal |
| `label` | `label` | Lencana merchandising pendek, mis. "Baru" | Teks bebas, nullable |
| `label_color` | `label_color` | Warna latar lencana | String hex sembarang, nullable; lihat [`docs/ui-ux.md`](ui-ux.md) untuk bagaimana ia divalidasi dan di-render |
| `created_at` | *(timestamp)* | Waktu pembuatan baris | `timestamptz` |
| `updated_at` | *(timestamp)* | Waktu baris terakhir diubah | `timestamptz` |
| `deleted_at` | *(tidak ada — baru)* | Penanda soft-delete; null berarti hidup | `timestamptz`, nullable |

## Batasan migrasi increment-2

**Migrasi data harus membawa setiap slug produk legacy apa adanya, termasuk akhiran keunikan 4-karakter hasil-Laravel-nya (misalnya `beras-5-kg-dbfc`, `jasa-jemput-kbj1`) — CMS tidak boleh pernah menghasilkan ulang slug dari nama produk.** [ADR-0005](adr/0005-product-urls-match-the-live-sites-shape.md) mengikat URL produk platform ini pada bentuk situs live sendiri, `/product/{slug}`, justru agar setiap tautan terindeks, bookmark, dan URL yang dibagikan tetap resolve saat cutover tanpa peta pengalihan. Kecocokan itu hanya nyata jika kolom `slug` yang dimigrasikan identik byte-demi-byte dengan yang legacy; migrasi yang menurunkan ulang slug dari `name` akan menghasilkan akhiran berbeda (atau tidak ada sama sekali), dan setiap URL yang dipertahankan ADR-0005 akan diam-diam menunjuk ke ketiadaan.

## Kolom dan tabel tertunda — nama legacy, belum diporting

Ini tidak punya referensi kode di mana pun di irisan ini (header `sql/153` sendiri, docblock `commerce/module.ts`), jadi kolom sumber legacy-nya dicatat di sini hanya sebagai target untuk porting increment masa depan, bukan sebagai sesuatu yang sudah dipetakan skema ini:

- **Kolom di `commerce_bj_mart.products` yang tidak dibawa ke `awcms_commerce_products`:** `price_level_2`, `price_level_3`, `price_level_4` (tiered pricing), `cost_price`, setiap kolom `affiliate_*`, setiap kolom `size_chart_*`, setiap kolom `insurance_*`, setiap kolom `promo_banner_*`, `variant_attributes`.
- **Tabel legacy tanpa padanan AWCMS di irisan ini:** `product_images`, `product_variants`, `flash_sale_products`, `product_affiliate_links`.

Increment masa depan yang mengadopsi salah satu dari ini bersifat aditif — kolom baru dan migrasi untuk baris yang membutuhkannya, bukan penulisan ulang tabel yang didokumentasikan di atas.
