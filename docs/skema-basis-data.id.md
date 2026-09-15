🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](skema-basis-data.md)

<!-- i18n-source-hash: sha256:7c8fa7a5f1415e789bea47dce24359351e73325a0cc1b3f8ccc9d0ea7d08feeb -->

# Skema basis data

Tabel `awcms_commerce_*`: kolom, tipe, constraint, indeks, dan row-level security yang membatasi setiap query ke satu tenant. Sumber kebenaran adalah [`apps/cms/sql/153_awcms_commerce_schema.sql`](../apps/cms/sql/153_awcms_commerce_schema.sql) (tabel dan indeks), [`sql/154_awcms_commerce_permissions.sql`](../apps/cms/sql/154_awcms_commerce_permissions.sql) (seed katalog izin), dan [`sql/155_awcms_commerce_worker_lifecycle_purge_grants.sql`](../apps/cms/sql/155_awcms_commerce_worker_lifecycle_purge_grants.sql) (grant untuk worker purge) — dokumen ini menjelaskannya, tidak menggantikan membacanya.

## `awcms_commerce_categories`

Hierarkis, self-referencing.

| Kolom | Tipe | Catatan |
| --- | --- | --- |
| `id` | `uuid` | PK, `DEFAULT gen_random_uuid()` |
| `tenant_id` | `uuid NOT NULL` | `REFERENCES awcms_tenants (id)` |
| `parent_id` | `uuid` | `REFERENCES awcms_commerce_categories (id)`, nullable; diset hanya saat pembuatan — lihat "Tanpa re-parenting" di bawah |
| `name` | `text NOT NULL` | |
| `slug` | `text NOT NULL` | Unik per tenant di antara baris hidup — lihat Indeks |
| `icon` | `text` | Nullable |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `deleted_at` | `timestamptz` | Nullable — lihat "Dua sumbu independen" di bawah |

**Indeks:** indeks unik pada `(tenant_id, slug) WHERE deleted_at IS NULL` (slug baris yang dihapus langsung bebas untuk dipakai ulang); indeks biasa pada `tenant_id`; indeks komposit pada `(tenant_id, deleted_at)` (bentuk filter mesin purge data-lifecycle generik); indeks pada `parent_id` (baik untuk penyusuran hierarki maupun gate `db:fk-index:check` milik `apps/cms`, yang mensyaratkan setiap kolom FK membawa satu).

## `awcms_commerce_products`

| Kolom | Tipe | Catatan |
| --- | --- | --- |
| `id` | `uuid` | PK, `DEFAULT gen_random_uuid()` |
| `tenant_id` | `uuid NOT NULL` | `REFERENCES awcms_tenants (id)` |
| `category_id` | `uuid` | `REFERENCES awcms_commerce_categories (id)`, nullable |
| `type` | `text NOT NULL DEFAULT 'physical'` | `CHECK IN ('physical', 'digital', 'service', 'subscription')` |
| `sku` | `text NOT NULL` | Unik per tenant di antara baris hidup |
| `name` | `text NOT NULL` | |
| `slug` | `text NOT NULL` | Unik per tenant di antara baris hidup |
| `description` | `text` | Nullable |
| `digital_note` | `text` | Nullable |
| `price` | `numeric(14, 2) NOT NULL` | `CHECK (price >= 0)` — lihat [ADR-0003](adr/0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md) |
| `discount_percent` | `integer NOT NULL DEFAULT 0` | `CHECK BETWEEN 0 AND 100` |
| `stock` | `integer NOT NULL DEFAULT 0` | `CHECK (stock >= 0)` |
| `status` | `text NOT NULL DEFAULT 'draft'` | `CHECK IN ('draft', 'active', 'inactive', 'archived')` — lihat [`docs/cms.md`](cms.md) untuk tabel transisi legal |
| `label` | `text` | Nullable, mis. lencana merchandising seperti "Baru" |
| `label_color` | `text` | Nullable, string hex sembarang; lihat [`docs/ui-ux.md`](ui-ux.md) untuk bagaimana storefront me-render-nya dengan aman |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `deleted_at` | `timestamptz` | Nullable |

**Indeks:** indeks unik pada `(tenant_id, slug) WHERE deleted_at IS NULL` dan `(tenant_id, sku) WHERE deleted_at IS NULL`; indeks biasa pada `tenant_id`; indeks komposit pada `(tenant_id, deleted_at)`; indeks pada `category_id` (gate indeks-FK, dan indeks alami yang akan dibutuhkan halaman category-browse di masa depan).

## Row-level security: `ENABLE` dan `FORCE`, terbukti di bawah role tak-berhak-istimewa

Kedua tabel membawa `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` **dan** `ALTER TABLE ... FORCE ROW LEVEL SECURITY`, masing-masing dengan satu kebijakan:

```sql
CREATE POLICY awcms_commerce_products_tenant_isolation
  ON awcms_commerce_products
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
```

`FORCE` penting justru karena pemilik tabel jika tidak akan melewati RLS sepenuhnya — `ENABLE` saja melindungi terhadap setiap role kecuali yang membuat tabelnya. Aplikasi terhubung sebagai `awcms_app`, role tak-berhak-istimewa, non-superuser (`apps/cms/sql/019_awcms_db_role_separation.sql`) — tidak pernah sebagai pemilik — jadi kebijakan ini adalah batas tenant nyata dan mengikat untuk setiap query komersial, bukan garis pertahanan-berlapis yang tidak pernah benar-benar diuji.

Ini terbukti, bukan sekadar dinyatakan: suite tes RLS generik milik `apps/cms` (`apps/cms/tests/db-role-separation-migration.test.ts`, `apps/cms/tests/security-readiness-rls.test.ts`, `apps/cms/tests/integration/db-role-separation.integration.test.ts`) menurunkan daftar tabelnya dari pernyataan `ENABLE`/`FORCE` setiap tabel `awcms_%` sendiri di seluruh `sql/` (`apps/cms/scripts/lib/table-rls-states.ts`), bukan menamai tabel dengan tangan — jadi `awcms_commerce_categories`/`awcms_commerce_products` tercakup otomatis, dengan cara yang sama seperti setiap tabel RLS lain di basis kode ini, tanpa perlu tes khusus-commerce. Sebagai role `awcms_app` yang tak-berhak-istimewa: query yang diajukan tanpa konteks tenant yang diset gagal tertutup (`current_setting('app.current_tenant_id')` milik kebijakan itu melempar error alih-alih mengembalikan string kosong yang kebetulan tidak cocok apa-apa), dan percobaan memasukkan baris di bawah konteks satu tenant sambil menamai id tenant lain ditolak kebijakan yang sama. Tes integrasi ini butuh PostgreSQL hidup dan tidak dijalankan ulang untuk menulis dokumen ini (lihat [`docs/pengujian.md`](pengujian.md) untuk alasannya); klaim di atas adalah jaminan generik dan berdiri milik basis kode untuk setiap tabel `FORCE ROW LEVEL SECURITY`, commerce termasuk, bukan verifikasi-ulang yang dilakukan khusus untuk dokumen ini.

**`category_id` yang melintasi tenant ditutup di lapisan aplikasi, bukan oleh foreign key.** Constraint FK PostgreSQL tidak punya kesadaran tenant — ia hanya membuktikan `category_id` menamai *suatu* baris di `awcms_commerce_categories`, bukan satu yang milik tenant si pemanggil sendiri. `createProduct`/`updateProduct` milik `commerce/application/product-directory.ts` sebaliknya memanggil `fetchCategoryById(tx, tenantId, categoryId)` — query yang dibatasi transaksi ber-RLS, di dalam `tx` yang sama — dan menolak request (400) jika itu tidak mengembalikan apa-apa. Id yang tidak dikenal, sudah soft-delete, atau benar-benar milik tenant lain ditolak **secara identik**, dengan sengaja: membedakan ketiga penyebab itu dalam respons akan membiarkan field itu dipakai untuk menyelidik id kategori yang ada di tempat lain platform (bentuk existence-oracle GHSA-r7cx-c4jh-cvvw). Pola yang sama, untuk alasan yang sama, menjaga `parentId` milik kategori sendiri.

## `status` dan `deleted_at`: dua sumbu independen

`status` siklus-hidup produk (`draft`/`active`/`inactive`/`archived`) dan apakah barisnya soft-delete (`deleted_at`) menjawab dua pertanyaan berbeda dan tidak pernah dicampur. Menarik produk dari penjualan tanpa kehilangan catatannya adalah `status = 'inactive'`; menghapusnya sepenuhnya dari tampilan katalog tenant adalah `deleted_at`. Kategori membawa `deleted_at` tapi tidak punya kolom `status` sama sekali — kategori tidak punya siklus hidup independen selain ada atau dihapus.

## Tanpa kolom stempel-pelaku

Tidak satu pun tabel membawa `created_by`, `updated_by`, atau `deleted_by`. SIAPA yang membuat, mengubah, atau soft-delete suatu baris hidup **hanya** di log audit (`actorTenantUserId` milik `recordAuditEvent` — lihat [`docs/cms.md`](cms.md)), tidak pernah sebagai kolom di sini. Ini juga yang membuat deskriptor `subjectData` milik `commerce/module.ts` jujur `unreachableBySubject: true`: tanpa kolom yang bisa menghubungkan baris ke seseorang bahkan secara prinsip, tidak ada apa pun di sini yang bisa dijangkau permintaan subjek-data.

## Tanpa endpoint restore di irisan ini

Tidak satu pun tabel membawa `restored_at`/`restored_by`, dan tidak ada rute `[id]/restore.ts` atau izin `restore` untuk resource mana pun. Kategori atau produk yang soft-delete dipertahankan — sehingga baris apa pun yang masih mereferensikannya (kategori anak, `category_id` milik produk) menjaga foreign key yang valid — tapi irisan ini tidak mengekspos cara mengembalikannya lewat API. Header `sql/153` sendiri menyebut ini sebagai aditif: dua kolom nullable dan satu endpoint, bukan migrasi baris yang sudah ada, kapan pun restore benar-benar dibangun.

## `dataLifecycle`: mesin purge tidak pernah bisa menjangkau baris hidup

Kedua tabel opt-in ke mesin purge data-lifecycle generik milik `apps/cms` (array `dataLifecycle` milik `commerce/module.ts`) alih-alih job purge buatan tangan, dengan `cursorColumn: "deleted_at"` — bukan `created_at`, berbeda dari kebanyakan tabel yang memakai mesin ini. Ini sengaja yang membuat purge aman: query mesin itu sendiri adalah `WHERE ... AND deleted_at < $2`, dan di SQL `NULL < $2` bukan benar maupun salah, jadi baris **hidup** (`deleted_at IS NULL`) tidak pernah bisa cocok dengan predikat itu. Hanya baris yang sudah soft-delete yang menjadi memenuhi-syarat-purge, dan hanya setelah duduk terhapus selama jendela retensi yang dikonfigurasi (30–3650 hari, default 365) — mesin ini secara matematis tidak mampu menjangkau baris hidup, bukan sekadar dikonfigurasi untuk tidak melakukannya.

## Izin (`sql/154`)

Dua activity code, `categories` dan `products`, masing-masing dengan empat aksi CRUD yang sama, di-seed ke katalog global `awcms_permissions` dan dicerminkan persis oleh array `permissions` milik `commerce/module.ts` (sebuah gate menjaga keduanya selaras): `commerce.categories.{read,create,update,delete}`, `commerce.products.{read,create,update,delete}` — delapan izin total. Sengaja tidak ada izin `restore` untuk resource mana pun, sejalan dengan tidak adanya endpoint restore di atas.

## Grant worker (`sql/155`)

`awcms_worker` — role yang dipakai job purge data-lifecycle untuk terhubung — mendapat `GRANT SELECT, DELETE` pada kedua tabel, dan tidak lebih luas. Tanpa `UPDATE`: mesin purge hanya pernah menghapus baris yang memenuhi syarat, tidak pernah menganonimkan satu pun, jadi grant yang tidak pernah dipakai kode tidak diterbitkan. Privilese default milik `apps/cms/sql/019_awcms_db_role_separation.sql` hanya pernah mencakup `awcms_app`; `awcms_worker` butuh grant eksplisit per-tabel ini untuk bisa berjalan sama sekali.

## Sengaja tidak ada di skema ini

Sesuai header `sql/153` sendiri dan [`docs/kamus-data.md`](kamus-data.md), kolom dan tabel ini tidak punya referensi kode di mana pun di irisan ini, jadi mengadopsinya nanti bersifat aditif alih-alih migrasi data yang sudah ada: tiered pricing (`price_level_2`, `price_level_3`, `price_level_4`), `cost_price`, setiap kolom `affiliate_*`, setiap kolom `size_chart_*`, setiap kolom `insurance_*`, setiap kolom `promo_banner_*`, `variant_attributes`, dan tabel terkait `product_images`, `product_variants`, `flash_sale_products`, `product_affiliate_links`.
