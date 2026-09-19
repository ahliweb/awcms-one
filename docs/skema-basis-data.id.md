🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](skema-basis-data.md)

<!-- i18n-source-hash: sha256:66d8bcd34657b4aee1b3172df0083c7c015223eff29299d0c6a5ef6f3bc4a983 -->

# Skema basis data

Setiap tabel `awcms_commerce_*`: kolom, tipe, constraint, indeks, dan row-level security yang membatasi setiap query ke satu tenant. Sumber kebenaran adalah `apps/cms/sql/901_awcms_commerce_schema.sql` sampai `apps/cms/sql/916_awcms_commerce_orders_expire_worker_write_grants.sql` — enam belas migrasi, satu modul `commerce` (lihat [ADR-0008](adr/0008-one-commerce-module-carries-the-whole-store-not-three.id.md)) — plus [`apps/cms/src/modules/commerce/README.md`](../apps/cms/src/modules/commerce/README.id.md); dokumen ini menjelaskannya, tidak menggantikan membacanya.

## Katalog: `awcms_commerce_categories`, `awcms_commerce_products`, `_product_images`, `_product_variants`

### `awcms_commerce_categories` (`sql/901`, `+restored_at` di `sql/904`)

Hierarkis, self-referencing.

| Kolom | Tipe | Catatan |
| --- | --- | --- |
| `id` | `uuid` | PK, `DEFAULT gen_random_uuid()` |
| `tenant_id` | `uuid NOT NULL` | `REFERENCES awcms_tenants (id)` |
| `parent_id` | `uuid` | `REFERENCES awcms_commerce_categories (id)`, nullable; diset hanya saat pembuatan — lihat [`docs/cms.md`](cms.id.md) |
| `name` | `text NOT NULL` | |
| `slug` | `text NOT NULL` | Unik per tenant di antara baris hidup |
| `icon` | `text` | Nullable |
| `created_at`/`updated_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `deleted_at` | `timestamptz` | Nullable — soft delete |
| `restored_at` | `timestamptz` | Nullable, ditambahkan di `sql/904` — fakta "kapan" yang dibutuhkan `restore`, mengikuti preseden yang sudah dipakai `awcms_offices` |

**Indeks:** unik `(tenant_id, slug) WHERE deleted_at IS NULL`; `(tenant_id)`; `(tenant_id, deleted_at)`; `(parent_id)`; `(tenant_id, parent_id) WHERE deleted_at IS NULL` (`sql/907`).

### `awcms_commerce_products` (inti `sql/901` + kolom paritas BjekMart `sql/904`)

| Kolom | Tipe | Catatan |
| --- | --- | --- |
| `id` | `uuid` | PK |
| `tenant_id` | `uuid NOT NULL` | FK `awcms_tenants` |
| `category_id` | `uuid` | FK `awcms_commerce_categories`, nullable |
| `type` | `text NOT NULL DEFAULT 'physical'` | `CHECK IN ('physical','digital','service','subscription')` |
| `sku` | `text NOT NULL` | Unik per tenant di antara baris hidup |
| `name`, `slug` | `text NOT NULL` | `slug` unik per tenant di antara baris hidup |
| `description`, `digital_note` | `text` | Nullable |
| `price` | `numeric(14,2) NOT NULL` | `CHECK (price >= 0)` — lihat [ADR-0003](adr/0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.id.md) |
| `price_level_2`, `price_level_3`, `price_level_4` | `numeric(14,2)` | Nullable — harga bertingkat berdasarkan level pelanggan (`sql/904`) |
| `cost_price` | `numeric(14,2)` | Nullable, khusus admin — tidak pernah ada di model baca publik |
| `discount_percent` | `integer NOT NULL DEFAULT 0` | `CHECK BETWEEN 0 AND 100` |
| `stock` | `integer NOT NULL DEFAULT 0` | `CHECK (stock >= 0)` |
| `status` | `text NOT NULL DEFAULT 'draft'` | `CHECK IN ('draft','active','inactive','archived')` — lihat [`docs/cms.md`](cms.id.md) |
| `label`, `label_color` | `text` | Nullable, lencana merchandising |
| `min_purchase` | `integer NOT NULL DEFAULT 1` | `CHECK (>= 1)` |
| `weight_grams` | `integer NOT NULL DEFAULT 0` | `CHECK (>= 0)` |
| `manual_rating` | `numeric(2,1)` | `CHECK BETWEEN 0 AND 5`, nullable |
| `manual_sold_count` | `integer NOT NULL DEFAULT 0` | `CHECK (>= 0)` |
| `with_insurance`, `insurance_required` | `boolean NOT NULL DEFAULT false` | |
| `insurance_fee` | `numeric(14,2)` | Nullable |
| `promo_banner_show` | `boolean NOT NULL DEFAULT false` | |
| `promo_banner_{title,subtitle,badge,icon,color}` | `text` | Nullable |
| `size_chart_type` | `text NOT NULL DEFAULT 'none'` | `CHECK IN ('none','image','table')`, plus CHECK lintas-kolom yang menyelaraskannya dengan dua kolom berikutnya |
| `size_chart_media_id` | `uuid` | `REFERENCES awcms_news_media_objects` — nama tabel asli registry media, dipertahankan melewati penggabungan `news_portal`→`blog_content`; hanya divalidasi berbentuk UUID, tidak dicek secara live (lihat [`docs/cms.md`](cms.id.md)) |
| `size_chart_details` | `jsonb` | Nullable |
| `service_form` | `jsonb` | Nullable — daftar field formulir intake produk jasa |
| `subscription_period` | `text` | `CHECK IN ('day','week','month','year')`, nullable |
| `download_link` | `text` | Nullable — aset berbayar produk digital; sengaja dikecualikan dari setiap model baca publik (lihat [`docs/cms.md`](cms.id.md)) |
| `allow_dp` | `boolean NOT NULL DEFAULT false` | |
| `allow_free_shipping` | `boolean NOT NULL DEFAULT true` | |
| `variant_attributes` | `jsonb` | Nullable |
| `is_featured`, `is_recommended` | `boolean NOT NULL DEFAULT false` | |
| `created_at`/`updated_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `deleted_at`, `restored_at` | `timestamptz` | Nullable |

**Indeks:** unik `(tenant_id, slug)`/`(tenant_id, sku)` keduanya `WHERE deleted_at IS NULL`; `(tenant_id)`; `(tenant_id, deleted_at)`; `(category_id)`; `(size_chart_media_id)`; indeks GIN trigram pada `name`/`sku` (`pg_trgm`, `sql/907`, mendukung filter substring `q` milik daftar owner); parsial `(tenant_id) WHERE deleted_at IS NULL AND is_featured/is_recommended = true`; `(tenant_id, price)`/`(tenant_id, name)` keduanya `WHERE deleted_at IS NULL`; `(tenant_id, status) WHERE deleted_at IS NULL`.

### `awcms_commerce_product_images` / `awcms_commerce_product_variants` (`sql/905`)

| Tabel | Kolom kunci |
| --- | --- |
| `_product_images` | `product_id` (FK products), `media_object_id NOT NULL` (FK `awcms_news_media_objects`, dicek secara live lewat `MediaLibraryPort.isMediaReferenceSafe` sebelum insert), `sort_order`, `alt_text` |
| `_product_variants` | `product_id` (FK products), `name NOT NULL`, `value NOT NULL`, `color_hex`, `image_media_object_id` (FK, validasi hanya-berbentuk-UUID), `sku` (unik per tenant di antara baris hidup, **dicek terhadap tabel ini maupun `awcms_commerce_products` itu sendiri** — indeks satu-tabel tidak bisa menyatakan itu), `price`/`price_level_2/3/4`, `stock`, `weight_grams`, `sort_order` |

Keduanya: `id`/`tenant_id`/`created_at`/`updated_at`/`deleted_at` seperti biasa; RLS `ENABLE`+`FORCE`, kebijakan isolasi-tenant; indeks FK pada setiap kolom referensi.

## Marketing: lima keluarga, plus pengaturan toko (`sql/909`–`sql/910`)

| Tabel | Kolom kunci |
| --- | --- |
| `awcms_commerce_flash_sales` | `name`, `slug` (unik per tenant, baris hidup), `starts_at`/`ends_at NOT NULL` (`CHECK ends_at > starts_at`), `status` (`CHECK IN ('draft','scheduled','active','ended')` — `active`/`ended` diturunkan oleh job, tidak pernah diset owner secara langsung) |
| `awcms_commerce_flash_sale_products` | `flash_sale_id`, `product_id`, `variant_id` (nullable), `sale_price NOT NULL` (`CHECK >= 0`), `quota`/`sold integer NOT NULL DEFAULT 0`; unik `(flash_sale_id, product_id, variant_id) NULLS NOT DISTINCT WHERE deleted_at IS NULL` |
| `awcms_commerce_vouchers` | `code` (unik per tenant, baris hidup), `type` (`CHECK IN ('percentage','nominal','free_shipping')`), `value NOT NULL` (`CHECK >= 0`), `min_order`, `max_discount`, `quota`/`used_count`, `is_public`, `status` (`CHECK IN ('active','inactive')`), `starts_at`/`ends_at NOT NULL` |
| `awcms_commerce_sliders` | `title NOT NULL`, `subtitle`, `media_object_id NOT NULL` (FK), `link_url`, `button_text`, `sort_order`, `is_active`, `starts_at`/`ends_at` (nullable, berjendela) |
| `awcms_commerce_testimonials` | `author_name NOT NULL`, `author_role`, `body NOT NULL`, `rating integer NOT NULL DEFAULT 5` (`CHECK BETWEEN 1 AND 5`), `avatar_media_object_id` (FK, nullable), `is_active`, `sort_order` |
| `awcms_commerce_popups` | `title NOT NULL`, `body`, `media_object_id` (FK, nullable), `link_url`, `button_text`, `frequency` (`CHECK IN ('once_per_session','once_per_day','always')`), `is_active`, `starts_at`/`ends_at`; **indeks parsial unik `(tenant_id) WHERE deleted_at IS NULL AND is_active = true`** — paling banyak satu popup aktif per tenant, ditegakkan oleh skema, bukan kode aplikasi |
| `awcms_commerce_store_settings` | `tenant_id uuid PRIMARY KEY` (satu baris per tenant — singleton, bukan daftar), `settings jsonb NOT NULL DEFAULT '{}'` (`CHECK jsonb_typeof(settings) = 'object'`), `deleted_at` (di sini berarti "reset ke default", bukan penghapusan tenant — lihat [`docs/api.md`](api.id.md)) |

Keenamnya: `id`/`created_at`/`updated_at`/`deleted_at` standar, RLS `ENABLE`+`FORCE`, kebijakan isolasi-tenant, indeks FK.

## Orders: delapan tabel (`sql/913`)

| Tabel | Kolom kunci | Catatan |
| --- | --- | --- |
| `awcms_commerce_customers` | `name NOT NULL`, `phone NOT NULL` (unik per tenant, baris hidup), `email`, `level integer NOT NULL DEFAULT 1` (`CHECK BETWEEN 1 AND 4`), `status` (`CHECK IN ('active','blocked')`) | Tanpa `password_hash`/`identity_id` di tabel ini sendiri — pelanggan tetap terjangkau lewat kode order + telepon sebagai tamu ([ADR-0009](adr/0009-guest-checkout-by-order-code-and-phone.id.md)); identitas akun/OTP/sesi yang dibangun di atasnya hidup di `awcms_commerce_customer_accounts`/`_customer_otps`/`_customer_sessions` di bawah (ADR-0016) |
| `awcms_commerce_customer_addresses` | `customer_id` (FK), `label`, `recipient_name NOT NULL`, `phone NOT NULL`, `province_code`/`name`, `city_code`/`name`, `district_code`/`name` (semuanya `text NOT NULL` **snapshot**, bukan FK live ke `idn_admin_regions`), `postal_code`, `street NOT NULL`, `latitude numeric(9,6)`, `longitude numeric(9,6)`, `is_default` | Di-snapshot sehingga perubahan data-induk wilayah di kemudian hari tidak pernah menulis ulang alamat terkirim milik pelanggan sendiri. Persis satu `is_default` per `(tenant_id, customer_id)` di antara baris hidup ditegakkan oleh indeks unik parsial `sql/920` (`WHERE is_default AND deleted_at IS NULL`), ditambahkan untuk rute alamat akun Issue #91 — duplikat default mana pun yang mungkin ditinggalkan era checkout tamu diturunkan menjadi penyintas yang paling baru dibuat oleh migrasi yang sama, sebelum indeks dibuat |
| `awcms_commerce_orders` | `order_code NOT NULL` (unik per tenant — **selamanya**, tidak dibatasi ke baris hidup, karena order tidak pernah benar-benar dihapus), `customer_id` (FK), `status` (CHECK 7-nilai, lihat [`docs/cms.md`](cms.id.md)), `payment_method` (`CHECK IN ('manual_bank','manual_qris','dp','gateway')` — `gateway` diterima, belum diimplementasikan, lihat [ADR-0010](adr/0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.id.md)), `payment_status` (`CHECK IN ('unpaid','dp_paid','paid','refunded')`), `shipping_method` (`CHECK IN ('alternative','self_pickup','courier')`), `shipping_service_name`, `shipping_cost`, `address jsonb` (snapshot, nullable untuk self-pickup), `subtotal`/`discount`/`voucher_code`/`voucher_discount`/`insurance_fee`/`tax`/`total`/`dp_amount`, `notes`, `paid_at`/`shipped_at`/`completed_at`/`cancelled_at`/`expires_at` | Indeks mencakup bentuk-scan milik job expiry sendiri, `(tenant_id, status, expires_at) WHERE status = 'pending_payment'`, dan milik daftar admin `(tenant_id, status, created_at DESC)` |
| `awcms_commerce_order_items` | `order_id`, `product_id`, `variant_id` (nullable), `flash_sale_id` (FK nullable — diset saat baris dibeli dengan harga flash-sale), `name`/`variant_name`/`sku` (snapshot), `unit_price NOT NULL`, `quantity integer NOT NULL CHECK (> 0)`, `weight_grams`, `service_form_values jsonb`, `line_total NOT NULL` | |
| `awcms_commerce_order_events` | `order_id`, `from_status` (nullable — null pada baris pembuatan), `to_status NOT NULL`, `actor` (`CHECK IN ('customer','admin','system')`), `note`, `created_at` | **Append-only — sama sekali tanpa `deleted_at`**, satu-satunya pengecualian dari bentuk soft-delete setiap tabel lain; sumber asli timeline order-tracking |
| `awcms_commerce_payment_confirmations` | `order_id`, `method` (`CHECK IN ('manual_bank','manual_qris')`), `amount NOT NULL`, `bank_name`, `account_name`, `transferred_at`, `proof_media_object_id` (**tanpa constraint FK, tanpa indeks** — kolom stub, sejalan dengan jalur upload yang selalu-`503`, lihat [`docs/cms.md`](cms.id.md)), `status` (`CHECK IN ('submitted','accepted','rejected')`), `reviewed_by` (**tanpa constraint FK**), `reviewed_at` | |
| `awcms_commerce_reviews` | `product_id`, `customer_id`, `order_id` (semuanya FK `NOT NULL`), `rating integer NOT NULL CHECK BETWEEN 1 AND 5`, `body NOT NULL`, `status` (`CHECK IN ('pending','published','rejected')`) | Unik `(customer_id, product_id, order_id) WHERE deleted_at IS NULL` — satu review per pelanggan, per produk, per order |
| `awcms_commerce_wishlists` | `customer_id`, `product_id` (keduanya FK `NOT NULL`) | Unik `(customer_id, product_id) WHERE deleted_at IS NULL`; dikirim mendahului sistem akun yang dibutuhkannya, kini terjangkau lewat `GET`/`PUT /api/v1/commerce/storefront/account/wishlist` dan `DELETE .../wishlist/{productId}` (Issue #91) |

Kedelapannya: RLS `ENABLE`+`FORCE`, kebijakan isolasi-tenant. `deleted_at` ada pada tujuh dari delapan (setiap tabel kecuali `order_events`) murni sebagai kursor purge data-lifecycle yang seragam — order, item order, pelanggan, dan konfirmasi pembayaran tidak pernah benar-benar di-soft-delete oleh kode modul ini sendiri.

## Akun pelanggan, OTP, sesi: tiga tabel (`sql/917`-`918`)

Issue #87 (C1, kontrak #86/[ADR-0016](adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.id.md)). Tanpa kata sandi sama sekali — autentikasi adalah OTP e-mail 6 digit; sesi adalah token bearer opak, hanya hash `sha256:`-nya yang disimpan.

| Tabel | Kolom kunci | Catatan |
| --- | --- | --- |
| `awcms_commerce_customer_accounts` | `customer_id` (FK, `UNIQUE (tenant_id, customer_id)` — 1:1 dengan `awcms_commerce_customers`), `email_normalized` (`UNIQUE (tenant_id, email_normalized)`), `status` (`CHECK IN ('active','blocked')`), `email_verified_at`, `history_from timestamptz NOT NULL`, `last_login_at` | Tanpa `password_hash`, tanpa `identity_id`/`principal_id` — ADR-0016 D1 (kontrak issue #86). Membawa kolom `deleted_at` yang tidak pernah diset oleh kode modul ini sendiri — diblokir berarti `status = 'blocked'`, tidak pernah dihapus; kolom ini ada hanya sebagai kursor yang selalu-`NULL` dan jujur untuk deskriptor `dataLifecycle` (`module.ts`), trik yang sama yang sudah dipakai `awcms_commerce_orders`. `history_from` adalah titik-awal riwayat order hasil resolusi ADR-0016 D4, dihitung sekali saat registrasi oleh fungsi murni `resolveHistoryFrom` |
| `awcms_commerce_customer_otps` | `email_normalized NOT NULL`, `purpose` (`CHECK IN ('login','register')`), `code_hash NOT NULL` (bukan kode mentah), `registration jsonb` (name/phone tertunda untuk `register`), `attempts integer NOT NULL DEFAULT 0`, `expires_at NOT NULL`, `consumed_at` | TTL 10 menit, 5 percobaan, sekali pakai — ADR-0016 D2. `consumeOtp` memverifikasi + mengonsumsi dalam satu `UPDATE ... RETURNING`, tidak pernah read-then-write |
| `awcms_commerce_customer_sessions` | `account_id` (FK), `token_hash text NOT NULL UNIQUE` (berawalan `sha256:` — namespace BARU, bukan hash sesi admin milik `apps/cms/src/lib/auth`), `issued_at`, `expires_at`, `last_seen_at`, `revoked_at`, `client_ip_hash`, `user_agent_summary` | TTL sliding 30 hari (`touchSession` hanya menulis saat `last_seen_at` sudah basi 5+ menit); token bearer `cs_` + 32 byte acak base64url — ADR-0016 D3 |

Ketiganya: RLS `ENABLE`+`FORCE`, kebijakan isolasi-tenant, indeks FK. `commerce:customer-auth:purge` (role worker, hibah `sql/918`) menghapus OTP kedaluwarsa dan sesi kedaluwarsa/dicabut-7-hari-lalu secara terjadwal; tabel akun tidak punya perilaku purge sama sekali (lihat komentar `dataLifecycle` di `module.ts`).

## Program afiliasi: dua tabel (`sql/921`)

Issue #92, keputusan D5 kontrak #86 — rancangan baru, tidak ada kolom lawas `affiliate_*` atau baris `product_affiliate_links` yang dibawa (lihat [`docs/kamus-data.md`](kamus-data.id.md)).

| Tabel | Kolom kunci | Catatan |
| --- | --- | --- |
| `awcms_commerce_affiliates` | `customer_id NOT NULL` (FK, `UNIQUE (tenant_id, customer_id) WHERE deleted_at IS NULL` — 1:1 dengan `awcms_commerce_customers`), `code NOT NULL` (`UNIQUE (tenant_id, code) WHERE deleted_at IS NULL`, alfabet 8 karakter tanpa ambiguitas — `domain/affiliate-code.ts`), `commission_rate numeric(5,2) NOT NULL` (`CHECK BETWEEN 0 AND 100`), `status` (`CHECK IN ('active','suspended')`, default `active`) | `commission_rate` adalah SNAPSHOT yang disalin dari `store_settings.affiliate_commission_rate` saat pendaftaran — perubahan tarif toko-lebar berikutnya tidak pernah menetapkan ulang harga afiliasi yang sudah terdaftar; hanya `PATCH /api/v1/commerce/affiliates/{id}` yang mengubah tarif satu afiliasi setelahnya |
| `awcms_commerce_affiliate_commissions` | `affiliate_id NOT NULL` (FK), `order_id NOT NULL` (FK, `UNIQUE` — **tidak dibatasi ke baris hidup**, satu komisi per pesanan selamanya, bentuk "unik untuk seumur hidup target FK" yang sama dengan `awcms_commerce_orders.order_code`), `base_amount numeric(14,2) NOT NULL`, `rate numeric(5,2) NOT NULL`, `amount numeric(14,2) NOT NULL`, `status` (`CHECK IN ('pending','approved','paid','void')`, default `pending`), `approved_at`/`paid_at`/`voided_at` | `base_amount`/`rate`/`amount` semuanya SNAPSHOT yang diambil saat pesanan yang direferensikan mencapai `completed` (`domain/affiliate-commission.ts`); `base = subtotal − discount − voucher_discount` dibatasi minimum nol, `amount = round(base × rate / 100, 2)` |

Ditambah satu kolom pada masing-masing dari dua tabel yang sudah ada: `awcms_commerce_orders.affiliate_id` (FK nullable, terindeks `WHERE affiliate_id IS NOT NULL`) — diatur sekali saat pesanan dibuat oleh `resolveAffiliateForOrder` (kode tak dikenal/ditangguhkan → `NULL`, tidak pernah error validasi) dan tidak pernah diubah setelahnya; `awcms_commerce_store_settings.affiliate_commission_rate numeric(5,2)` (nullable, `CHECK BETWEEN 0 AND 100` saat diisi) — kolom nyata di luar blob jsonb `settings` (lihat entri tabel itu sendiri di atas untuk alasan jsonb menjadi pilihan default; kolom ini dibaca oleh jalur panas `resolveAffiliateForOrder`/pemeriksaan pendaftaran dan tidak pernah membutuhkan versi skema jsonb itu sendiri), `NULL` berarti program afiliasi MATI untuk tenant tersebut.

## Tarif kurir: dua tabel cache (`sql/924`)

Issue #107, D4 kontrak #106 — cache kode-kecamatan→id-tujuan-provider dan cache tarif per (asal, tujuan, bucket berat, kurir, layanan), keduanya murni cache aditif tanpa `deleted_at` (baris basi dihapus langsung, tidak pernah dihapus lunak — tidak ada apa pun untuk dipulihkan dari harga ter-cache).

| Tabel | Kolom kunci | Catatan |
| --- | --- | --- |
| `awcms_commerce_courier_destinations` | `district_code NOT NULL`, `provider NOT NULL`, `destination_id NOT NULL`, `label NOT NULL`, `resolved_at NOT NULL DEFAULT now()`, `UNIQUE (tenant_id, provider, district_code)` | Tanpa TTL — id tujuan provider milik sebuah kecamatan nyaris tidak pernah berubah. Di-resolve sekali per (tenant, provider, kecamatan) lewat pencarian nama terhadap `idn_admin_regions`, lalu di-cache selamanya (kecuali sapuan penyegaran di masa depan) |
| `awcms_commerce_shipping_rates` | `provider NOT NULL`, `origin_id NOT NULL`, `destination_id NOT NULL`, `weight_bucket integer NOT NULL` (`CHECK >= 1000`), `courier NOT NULL`, `service NOT NULL`, `name NOT NULL`, `cost numeric(14,2) NOT NULL`, `etd`, `fetched_at NOT NULL DEFAULT now()`, `expires_at NOT NULL`, `UNIQUE (tenant_id, provider, origin_id, destination_id, weight_bucket, courier, service)` | TTL 6 jam (`expires_at`); `weight_bucket` selalu keluaran `computeWeightBucketGrams` milik `domain/weight-bucket.ts` (dibulatkan ke atas ke kelipatan 100 g berikutnya, dilantaikan di 1000 g — berat minimum tertagih RajaOngkir sendiri), tidak pernah berat mentah keranjang, sehingga dua keranjang dalam pita 100 g yang sama berbagi satu baris. `commerce:shipping-rates:purge` (setiap jam) meng-`DELETE` setiap baris yang lewat `expires_at`, lintas tenant, di-GRANT ke `awcms_worker` seperti job purge lain di modul ini |

Kedua tabel mengikuti konvensi `sql/901` (`ENABLE`/`FORCE ROW LEVEL SECURITY`, satu kebijakan isolasi tenant, indeks FK pada `tenant_id`) tapi tidak pernah ditulis langsung oleh transaksi tulis `application/order-directory.ts` untuk tarif BARU — `getCourierRates`/`resolveDestination` milik `application/shipping-rate-directory.ts` selalu membaca cache dalam satu transaksi pendek, memanggil `ShippingRateProvider` (API v2 RajaOngkir Komerce, atau adapter fixture `log`) tanpa transaksi terbuka sama sekali, lalu menulis-balik hasilnya dalam transaksi pendek kedua (aturan "jangan pernah memanggil provider di dalam transaksi database" ADR-0006/0010, diterapkan di sini sama seperti outbox `email` sudah menerapkannya). Pembuatan pesanan memvalidasi `{courier, service, cost}` yang dipilih HANYA terhadap `awcms_commerce_shipping_rates` — `SELECT ... WHERE expires_at > now()` biasa yang aman-transaksi, tidak pernah panggilan provider langsung kedua dari dalam transaksi tulis pesanan itu sendiri.

Kedua tabel baru: RLS `ENABLE`+`FORCE`, kebijakan isolasi-tenant, indeks FK. Tak satu pun pernah di-soft-delete oleh kode modul ini sendiri dalam praktiknya — `deleted_at` ada murni sebagai kursor purge data-lifecycle yang seragam, bentuk "kursor selalu-`NULL`" yang sama dengan yang sudah dipakai `awcms_commerce_orders` dan `awcms_commerce_customer_accounts`.

## Kampanye pelanggan: dua tabel + satu kolom (`sql/929`)

Issue #114, D9 kontrak #106 — pengiriman massal e-mail/WhatsApp bergerbang consent.

| Tabel | Kolom kunci | Catatan |
| --- | --- | --- |
| `awcms_commerce_customer_accounts.marketing_consent_at` (kolom baru, bukan tabel baru) | `timestamptz`, nullable | Non-null berarti akun setuju menerima komunikasi pemasaran pada saat itu; `NULL` berarti tidak pernah setuju (atau sudah dicabut). Hanya diubah oleh akun itu sendiri lewat `PATCH .../account/me {marketingConsent}` — tidak pernah oleh staf |
| `awcms_commerce_campaigns` | `channel NOT NULL` (`CHECK IN ('email','whatsapp')`), `subject` (nullable — wajib untuk `email`, diabaikan untuk `whatsapp` di batas aplikasi), `body NOT NULL` (`CHECK char_length BETWEEN 1 AND 4000`), `audience jsonb NOT NULL DEFAULT '{}'` (divalidasi di batas aplikasi, bukan oleh CHECK database — bentuk filter kecil yang terus berevolusi), `status NOT NULL` (`CHECK IN ('draft','scheduled','sending','sent','cancelled')`, default `draft`), `scheduled_at`/`sent_at timestamptz`, `recipient_count integer` | `recipient_count`/`sent_at` dimulai `NULL` pada `draft` baru, terisi hanya setelah kampanye benar-benar dikirim (fase FINALIZE milik `commerce:campaigns:dispatch`) |
| `awcms_commerce_campaign_recipients` | `campaign_id NOT NULL` (FK), `customer_id NOT NULL` (FK), `address_masked NOT NULL` (alamat e-mail/telepon tersamar SAJA, tidak pernah alamat mentah), `status NOT NULL` (`CHECK IN ('queued','enqueued','skipped')`, default `queued`), `outbox_ref` (nullable), `UNIQUE (campaign_id, customer_id)` | Satu baris per penerima yang terselesaikan — buku besar keteresumeannya/audit yang diandalkan pengiriman parsial. Constraint `UNIQUE` plus `ON CONFLICT DO NOTHING` saat penyisipan inilah yang membuat pemulihan-dari-crash dispatcher aman diulang; `NOT EXISTS` milik `resolveCampaignAudiencePage` sendiri terhadap tabel ini yang membuat cursor lanjutannya benar tanpa kolom cursor terpisah pada baris kampanye |

Kedua tabel baru: RLS `ENABLE`+`FORCE`, kebijakan isolasi-tenant, indeks FK. Deskriptor `dataLifecycle` milik `commerce.campaigns` memakai kursor `deleted_at` yang biasa; `commerce.campaign_recipients`, karena append-only per kampanye, memakai `created_at` — bentuk yang sama dengan `commerce.messages` di atas. Seed katalog permission: `sql/930` (`commerce.campaigns.{read,update,send}`).

## Row-level security: `ENABLE` dan `FORCE`, terbukti di bawah role tak-berhak-istimewa

Setiap tabel di atas membawa `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` **dan** `ALTER TABLE ... FORCE ROW LEVEL SECURITY`, masing-masing dengan satu kebijakan isolasi-tenant:

```sql
CREATE POLICY awcms_commerce_products_tenant_isolation
  ON awcms_commerce_products
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
```

`FORCE` penting justru karena pemilik tabel jika tidak akan melewati RLS sepenuhnya. Aplikasi terhubung sebagai `awcms_app`, role tak-berhak-istimewa, non-superuser — tidak pernah sebagai pemilik — jadi kebijakan ini adalah batas tenant nyata dan mengikat untuk setiap query commerce. Suite tes RLS generik milik `apps/cms` menurunkan daftar tabelnya dari pernyataan `ENABLE`/`FORCE` setiap tabel `awcms_%` sendiri di seluruh `sql/`, alih-alih menamai tabel dengan tangan, jadi setiap tabel di atas tercakup otomatis, dengan cara yang sama seperti setiap tabel RLS lain di basis kode ini — tidak ada tes RLS khusus-commerce yang dibutuhkan atau ditulis. **Resolusi tenant milik API storefront anonim sendiri adalah batas kedua, lebih awal**, bukan pengganti RLS: `application/public-commerce-tenant.ts` meresolusi tenant dari `Origin`/`Host` request terhadap `awcms_tenant_domains` sebelum transaksi bahkan dibuka; RLS kemudian tetap membatasi setiap query di dalam transaksi itu ke tenant yang ditemukan resolver. Pencarian `orders/{code}?phone=` lintas-tenant dan request origin-tak-teresolusi keduanya menjawab dengan `404` netral yang identik.

**`category_id` yang melintasi tenant ditutup di lapisan aplikasi, bukan oleh foreign key** — FK PostgreSQL hanya membuktikan `category_id` menamai *suatu* baris, bukan satu yang milik tenant si pemanggil sendiri. `commerce/application/product-directory.ts` memanggil `fetchCategoryById(tx, tenantId, categoryId)` di dalam transaksi ber-RLS yang sama dan menolak request (400) jika itu tidak mengembalikan apa-apa — id yang tidak dikenal, sudah soft-delete, atau lintas-tenant ditolak secara identik, dengan sengaja (bentuk existence-oracle GHSA-r7cx-c4jh-cvvw). Pola yang sama menjaga setiap referensi lintas-tabel lain yang ditulis modul ini (`category_id` milik produk, `product_id`/`variant_id`/`flash_sale_id` milik item order, `product_id`/`customer_id`/`order_id` milik review).

## `status`/`payment_status` dan `deleted_at`: dua sumbu independen

`status` milik produk, `status`/`payment_status` milik order, dan apakah barisnya soft-delete (`deleted_at`) menjawab pertanyaan yang berbeda dan tidak pernah dicampur — lihat [`docs/cms.md`](cms.id.md) untuk kedua state machine secara lengkap. Hanya `order_events` yang tidak membawa `deleted_at`: ia append-only by design, satu-satunya catatan riwayat order yang tahan lama dan tak-bisa-diedit.

## Tanpa kolom stempel-pelaku di mana pun dalam modul ini

Tidak satu pun tabel commerce membawa `created_by`/`updated_by`/`deleted_by`. SIAPA yang membuat, mengubah, atau soft-delete baris sisi-owner hanya ada di log audit; SIAPA yang mendorong perubahan status order sendiri ada di kolom `actor` milik `order_events` (`customer`/`admin`/`system`) — lihat [`docs/cms.md`](cms.id.md).

## `dataLifecycle` dan `subjectData`: mesin purge tidak pernah bisa menjangkau baris hidup, dan setiap tabel adalah `unreachableBySubject`

Kesembilan belas tabel commerce, masing-masing, opt-in ke mesin purge data-lifecycle generik milik `apps/cms` (array `dataLifecycle` milik `commerce/module.ts`), dengan `cursorColumn: "deleted_at"` untuk delapan belas di antaranya dan `"created_at"` untuk `order_events` yang append-only — `NULL < $2` bukan benar maupun salah di SQL, jadi baris hidup tidak pernah bisa cocok dengan predikat purge; hanya baris yang sudah soft-delete, melewati jendela retensinya, yang menjadi memenuhi-syarat. `orders`/`order_items`/`payment_confirmations` memakai jendela retensi fiskal (`retentionMinDays: 365`, `defaultRetentionDays: 3650`); sisanya memakai `30`/`3650`/`365`.

Kesembilan belas tabel itu juga `unreachableBySubject: true` dalam deskriptor `subjectData` milik modul, `exportable: false`, `erasure: "retain_under_obligation"` — **termasuk tabel customer/address/order yang memegang PII tamu sungguhan.** Ini adalah pembacaan yang disengaja atas kosakata subject-data milik `apps/cms` (`SubjectDataColumn.references` adalah `"tenant_user" | "identity" | "profile" | "principal"` — semuanya konsep identitas sisi-staf), bukan kelalaian: tamu yang diidentifikasi hanya lewat nomor telepon yang diketik ke formulir checkout tidak punya satu pun dari itu. Permintaan erasure/export yang sungguhan ditangani sebagai lookup admin biasa (`GET`/`PATCH /api/v1/commerce/customers/{id}`), di luar cakupan mesin otomatis itu by construction — lihat [ADR-0009](adr/0009-guest-checkout-by-order-code-and-phone.id.md). Sejak Issue #91, `customer_addresses` dan `wishlists` tambahan terjangkau oleh SUBJEK secara langsung, lewat rute `/api/v1/commerce/storefront/account/{addresses,wishlist}` miliknya sendiri yang dijaga bearer — jalur swalayan sungguhan yang kosakata tetap registry ini masih tidak bisa deskripsikan, sehingga keduanya tetap `unreachableBySubject: true`, tetapi rationale `module.ts` kini mencatat bahwa celah itu tertutup untuk orangnya sendiri, hanya bukan untuk mesin otomatis ini.

## Izin (`sql/902`, `sql/906`, `sql/911`, `sql/914`)

39 kunci total di empat area — lihat [`docs/cms.md`](cms.id.md) dan [`docs/api.md`](api.id.md) untuk tabel lengkapnya. Grant worker untuk `SELECT, DELETE` generik milik mesin purge data-lifecycle di-seed per tabel di `sql/903`/`908`/`912`/`915`; `sql/916` memberi privilese tulis tambahan yang lebih sempit (`UPDATE`/`INSERT` pada tabel tertentu) yang dibutuhkan `commerce:orders:expire` dan `commerce:flash-sales:tick` agar bisa berjalan sama sekali sebagai role `awcms_worker` yang least-privilege.

## Sengaja tidak ada di skema ini

Integrasi kurir live (tanpa tabel rate/tracking RajaOngkir — `shipping_method`/`shipping_service_name` pada order adalah label yang ditentukan merchant, tidak pernah respons kurir live); catatan transaksi payment-gateway (nilai enum `gateway` diterima, belum diimplementasikan); kolom `password_hash` di mana pun — akun pelanggan hanya-OTP by design ([ADR-0016](adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.id.md) D1), tidak pernah ada kata sandi untuk disimpan atau di-reset; kolom/endpoint `restore` untuk tabel marketing, order, customer, atau review mana pun.
