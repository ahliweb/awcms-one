🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](kamus-data.md)

<!-- i18n-source-hash: sha256:33a0678db7ab7aa9611638f1376f1e7cd3fbdc86e72f52fa1e87a102e0c999fd -->

# Kamus data

Setiap kolom di sembilan belas tabel `awcms_commerce_*`, maknanya, domain unit/enum-nya, dan — jika ada — kolom sumbernya di skema MySQL lawas `commerce_bj_mart`.

## Provenans, dinyatakan sekali agar setiap baris di bawah tidak perlu mengulanginya

Daftar kolom lawas **dicatat dari basis data `commerce_bj_mart` yang live pada 2026-09-14**, selama pekerjaan yang menghasilkan bagian skema-sumber issue #4 dan `apps/cms/sql/153_awcms_commerce_schema.sql`. **`commerce_bj_mart` tidak bisa dijangkau dari mesin tempat dokumentasi ini ditulis** — setiap sel "kolom sumber" dinyatakan **sebagaimana dicatat pada 2026-09-14**, tidak diperiksa ulang secara independen sejak itu. Kolom inti-katalog dan paritas-BjekMart (dua tabel pertama dokumen ini) di-porting dari nama kolom skema lawas sendiri, tanpa perubahan — header `sql/153` dan `sql/156` sendiri, serta docblock `commerce/module.ts`, semuanya menjelaskan ini sebagai port langsung; dikuatkan oleh daftar kolom-yang-ditunda yang masih cocok verbatim dengan nama kolom lawas `commerce_bj_mart.products`. Tabel marketing dan order (issue #26/#29) adalah **desain baru milik platform ini sendiri**, bukan port kolom-demi-kolom — mart.borneojek.com punya pengaturan dan catatan order dengan bentuk serupa, tapi tidak ada daftar kolom lawas untuk itu yang ditangkap selama pengembangan repositori ini, jadi tidak ada "kolom sumber" yang diklaim untuk bagian itu; makna setiap kolom dinyatakan atas dasarnya sendiri sebagai gantinya.

## `awcms_commerce_categories` ← `commerce_bj_mart.categories`

| Kolom AWCMS | Kolom sumber lawas | Makna | Unit / domain |
| --- | --- | --- | --- |
| `id` | `id` | Primary key | `uuid` di sini |
| `tenant_id` | *(tidak ada — baru)* | Kepemilikan baris di bawah model multi-tenant platform ini | `uuid`, FK ke `awcms_tenants` |
| `parent_id` | `parent_id` | Hierarki self-referencing — parent kategori ini, atau root jika null | `uuid`, FK ke tabel yang sama ini; diset sekali saat pembuatan |
| `name` | `name` | Nama tampilan | Teks bebas |
| `slug` | `slug` | Identifier yang menghadap URL | Teks bebas, unik per tenant di antara baris hidup |
| `icon` | `icon` | Referensi ikon untuk kategori ini | Teks bebas |
| `created_at`/`updated_at` | *(timestamp)* | Timestamp siklus-hidup baris | `timestamptz` |
| `deleted_at` | *(tidak ada — baru)* | Penanda soft-delete; null berarti hidup | `timestamptz`, nullable |
| `restored_at` | *(tidak ada — baru)* | Kapan soft delete dibatalkan (`sql/156`) | `timestamptz`, nullable |

## `awcms_commerce_products` ← `commerce_bj_mart.products`

| Kolom AWCMS | Kolom sumber lawas | Makna | Unit / domain |
| --- | --- | --- | --- |
| `id` | `id` | Primary key | `uuid` di sini |
| `tenant_id` | *(tidak ada — baru)* | Kepemilikan baris | `uuid`, FK `awcms_tenants` |
| `category_id` | `category_id` | Kategori produk | `uuid`, FK; referensi lintas-tenant ditolak di lapisan aplikasi |
| `type` | `type` | Jenis produk | `physical`, `digital`, `service`, `subscription` |
| `sku` | `sku` | Kode stock-keeping unit | Teks bebas, unik per tenant di antara baris hidup |
| `name` | `name` | Nama tampilan | Teks bebas |
| `slug` | `slug` | Identifier yang menghadap URL | Teks bebas, unik per tenant di antara baris hidup — lihat constraint migrasi di bawah |
| `description` | `description` | Deskripsi panjang | Teks bebas, nullable |
| `digital_note` | `digital_note` | Catatan yang ditampilkan untuk produk digital menggantikan info pengiriman | Teks bebas, nullable |
| `price` | `price` | Harga satuan (level 1) | `numeric(14,2)`, string desimal di wire — [ADR-0003](adr/0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.id.md) |
| `price_level_2`/`_3`/`_4` | `price_level_2`/`_3`/`_4` | Harga bertingkat berdasarkan level pelanggan | `numeric(14,2)`, nullable |
| `cost_price` | `cost_price` | Biaya satuan khusus-admin, untuk pelaporan margin | `numeric(14,2)`, nullable — tidak pernah ada di model baca publik |
| `discount_percent` | `discount_percent` | Diskon yang diterapkan pada `price` | Integer 0–100 |
| `stock` | `stock` | Unit yang tersedia | Integer non-negatif |
| `status` | `status` | Status siklus-hidup | `draft`, `active`, `inactive`, `archived` — lihat [`docs/cms.md`](cms.id.md) |
| `label`/`label_color` | `label`/`label_color` | Lencana merchandising dan warna latarnya | Teks bebas / string hex, nullable |
| `min_purchase` | `min_purchase` | Kuantitas order minimum untuk produk ini | Integer, `>= 1` |
| `weight_grams` | `weight_grams` | Berat pengiriman | Gram, `>= 0` |
| `manual_rating` | `manual_rating` | Rating yang dimasukkan owner, ditampilkan sampai review sungguhan terkumpul | `numeric(2,1)`, 0.0–5.0, nullable |
| `manual_sold_count` | `manual_sold_count` | Penghitung "terjual" yang dimasukkan owner, untuk social proof | Integer non-negatif |
| `with_insurance`/`insurance_required`/`insurance_fee` | `with_insurance`/`insurance_required`/`insurance_fee` | Apakah asuransi pengiriman ditawarkan/diwajibkan, dan biayanya | Boolean / boolean / `numeric(14,2)` |
| `promo_banner_show`/`_title`/`_subtitle`/`_badge`/`_icon`/`_color` | nama sama | Banner promosi opsional yang di-render di halaman detail produk | Boolean / teks bebas ×5 |
| `size_chart_type` | `size_chart_type` | Bagaimana size chart ditampilkan, jika ada | `none`, `image`, `table` |
| `size_chart_media_id` | `size_chart_media_id` | Gambar size-chart, saat `type = "image"` | `uuid`, FK `awcms_news_media_objects` (registry media), hanya validasi berbentuk-UUID |
| `size_chart_details` | `size_chart_details` | Baris-baris size-chart, saat `type = "table"` | `jsonb`, nullable |
| `service_form` | `service_form` | Definisi field formulir intake produk jasa | `jsonb`, nullable |
| `subscription_period` | `subscription_period` | Kadensi penagihan untuk produk langganan | `day`, `week`, `month`, `year`, nullable |
| `download_link` | `download_link` | Lokasi aset berbayar produk digital | Teks bebas, nullable; **tidak pernah ada di model baca publik** — lihat [`docs/cms.md`](cms.id.md) |
| `allow_dp` | `allow_dp` | Apakah checkout dengan uang muka diizinkan | Boolean |
| `allow_free_shipping` | `allow_free_shipping` | Apakah produk ini bisa dikirim gratis (mis. lewat voucher) | Boolean, default `true` |
| `variant_attributes` | `variant_attributes` | Kumpulan atribut (mis. sumbu ukuran/warna) yang menjadi variasi varian produk ini | `jsonb`, nullable |
| `is_featured`/`is_recommended` | `is_featured`/`is_recommended` | Flag penempatan di halaman utama | Boolean |
| `created_at`/`updated_at`/`deleted_at`/`restored_at` | *(timestamp / baru)* | Siklus-hidup baris | `timestamptz` |

**Tidak di-porting dari `commerce_bj_mart.products`:** setiap kolom `affiliate_*`, dan tabel lawas `product_affiliate_links` — program afiliasi adalah bagian yang harus diadmisi [issue #32](https://github.com/ahliweb/awcms-one/issues/32), bersama akun pelanggan.

## `awcms_commerce_product_images` / `awcms_commerce_product_variants` ← `commerce_bj_mart.product_images` / `.product_variants`

Keduanya adalah tabel AWCMS baru yang meneruskan konsep milik tabel lawas: gambar adalah `{product, referensi media, sort order, alt text}`; varian adalah `{product, pasangan nama/nilai atribut seperti "Warna"/"Merah", override harga/tingkat-harga/stok/berat miliknya sendiri, gambar opsional}`. Lihat [`docs/skema-basis-data.md`](skema-basis-data.id.md) untuk kolom yang persis — kamus ini tidak mengulanginya field demi field untuk kedua kalinya, karena makna kolom kedua tabel itu tidak berbeda dari deskripsi di dokumen skema.

## Constraint migrasi increment-2 (tidak berubah dari increment 1)

**Migrasi data harus membawa setiap slug produk lawas secara verbatim, termasuk akhiran keunikan 4-karakter yang dihasilkan Laravel** (misalnya `beras-5-kg-dbfc`, `jasa-jemput-kbj1`) — CMS tidak boleh pernah meregenerasi slug dari nama produk. [ADR-0005](adr/0005-product-urls-match-the-live-sites-shape.id.md) mengikat URL produk platform ini ke bentuk situs live sendiri, `/product/{slug}`, secara spesifik agar setiap tautan terindeks, bookmark, dan URL yang dibagikan tetap ter-resolve saat cutover.

## Tabel marketing: desain milik platform ini sendiri, bukan port lawas

`awcms_commerce_flash_sales`/`_flash_sale_products`, `_vouchers`, `_sliders`, `_testimonials`, `_popups`, `_store_settings` (issue #26) dirancang berdasarkan *perilaku teramati* mart.borneojek.com (strip flash-sale dengan countdown, field kode voucher saat checkout, slider halaman utama, bagian testimonial, popup promo, dan pengaturan seluruh-toko termasuk detail bank/QRIS) alih-alih berdasarkan daftar kolom lawas yang ditangkap — lihat "Provenans" di atas. Makna kolom didokumentasikan lengkap di [`docs/skema-basis-data.md`](skema-basis-data.id.md); kamus ini tidak menduplikasinya, karena tidak ada kolom pemetaan-lawas untuk ditambahkan di samping masing-masing.

## Tabel order: desain milik platform ini sendiri, dialamatkan lewat identitas tamu

`awcms_commerce_customers`/`_customer_addresses`/`_orders`/`_order_items`/`_order_events`/`_payment_confirmations`/`_reviews`/`_wishlists` (issue #29) demikian pula skema milik platform ini sendiri, dibentuk oleh [ADR-0009](adr/0009-guest-checkout-by-order-code-and-phone.id.md) (pelanggan diidentifikasi lewat telepon, bukan akun) dan [ADR-0010](adr/0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.id.md) (pembayaran manual dan biaya kurir-alternatif flat, bukan integrasi gateway/kurir live). Lihat [`docs/skema-basis-data.md`](skema-basis-data.id.md) untuk setiap kolom.

## seputarborneo.com → `blog_content` / `seo_distribution` (issue #58)

Pemetaan kolom untuk `tools/import-seputarborneo.ts` (`bun run import:seputarborneo`), yang membaca arsip MariaDB lama seputarborneo lalu menulis lewat permukaan publik `/api/v1/*` milik `apps/cms` — tidak pernah mem-port daftar kolom lawas apa adanya ke tabel baru, karena skema `blog_content` (isi Portable Text, klasifikasi term/instansi) sudah ada dan mendahului importer ini.

### `berita_red` → post `blog_content`

| Kolom lawas | Field AWCMS | Catatan |
| --- | --- | --- |
| `id_ber` | *(tidak ada — lihat di bawah)* | Tidak ada field publik yang menyimpannya; peta redirect diturunkan dari URL yang dibangun importer ini, bukan dari id lawas yang tersimpan (lihat "Yang TIDAK dipertahankan" di bawah) |
| `judul` | `title`, dan sumber slug | `slug = sbSlug(judul)`, di-dedup dengan `-{id_ber}` saat bentrok |
| `sub_judul` | `excerpt` | |
| `isi_berita` | `bodyPortableText` | HTML CKEditor → Portable Text lewat `tools/lib/html-to-portable-text.ts`; `<script>`/`<iframe>`/`<embed>`/`<object>` dibuang seluruhnya, `<img>` jadi blok `gallery` hanya setelah id objek media ter-resolve, selebihnya dibuang dan dilaporkan |
| `jenis_rubrik` + `kategori` | `termIds` / `institutionIds` | Dinormalisasi identik dengan `migrations/2026-09-02-normalize-legacy-taxonomy.sql`, lalu diklasifikasi jadi term rubrik, wilayah `daerah`, instansi `mitra-borneo`, atau anak `umum` — lihat `mapLegacyTaxonomy` milik importer sendiri |
| `tgl` + `jam` | `publishedAt` (lewat `.../schedule`) atau waktu impor (lewat `.../publish`) | Waktu-dinding Asia/Jakarta (UTC+7, tanpa DST) → instan UTC; lihat bagian "Mengimpor seputarborneo" di `docs/deployment.md` untuk alasan tanggal LAMPAU tidak bisa di-backdate lewat API publik |
| `user` | `contentJson.legacySource.author` | BUKAN byline yang dirender — `authorByline` diturunkan dari tenant user yang terautentikasi di API ini, bukan field teks bebas; lihat header importer sendiri |
| `id_logo` | *(manifest saja)* | Dicocokkan terhadap `logo` lewat id; logo instansi belum punya field di `apps/cms` — lihat [issue #59](https://github.com/ahliweb/awcms-one/issues/59) |
| `foto_berita` | `featuredMediaId` setelah diunggah | Disebutkan di daftar `mediaNeeded` manifest impor sampai saat itu |
| `status` | *(tidak pernah dibaca)* | Situs lama sendiri tidak pernah membaca kolom ini (`include/rubrik.php` memakai filter `tgl`+`jam` <= sekarang milik VIEW `berita_red_tayang`) |
| `sub_up`, `text_foto`, `uk`, `tp`, `rate_view`, `like_view`, `unlike_viuew`, `hari`, `bln` | *(tidak diimpor)* | Tidak ada konsep yang berpadanan di `blog_content` |

**Yang TIDAK dipertahankan:** `id_ber` itu sendiri. `apps/cms` MEMANG punya pasangan `legacy_source_id`/`legacy_source_system` di `awcms_blog_posts` (`sql/138`) persis untuk keperluan ini, tapi tidak ada yang menulisnya lewat API PUBLIK yang jadi batasan importer ini (AGENTS.md "Workspace boundaries") — hanya pipeline internal `bun run blog:legacy:import` yang melakukannya, dari dalam `apps/cms`. Redirect importer ini (di bawah) dibangun langsung dari baris pada saat impor, bukan diturunkan dari id tersimpan belakangan.

### `awcms_seo_redirects` (origin `legacy_blog`)

Satu baris per artikel `berita_red`/`berita_vid` yang berhasil diimpor, `target` di-set ke URL kanonik `/blog/{tenantCode}/{slug}` milik CMS sendiri (tidak pernah path storefront yang ditebak — kontrak yang didokumentasikan `docs/routing.md` sendiri untuk apa yang diharapkan pembangunan-ulang redirect-lama `penyaji.mjs`):

| Path sumber | Dibangun dari |
| --- | --- |
| `/news/{id_ber}-{sbSlug(judul)}.html` | Bentuk URL hari ini (pasca issue #6) |
| `/news/{id_ber}_{judul dengan spasi→underscore, di-rawurlencode}.html` | Bentuk pra-2.0 yang mungkin masih terindeks mesin pencari |
| `/video/?video={id_vid}-{sbSlug(judul_vid)}.html` | Bentuk URL `berita_vid` sendiri |

### `berita_vid` → post video `blog_content`

| Kolom lawas | Field AWCMS | Catatan |
| --- | --- | --- |
| `judul_vid` | `title`, sumber slug | Aturan `sbSlug`/bentrok sama seperti `berita_red` |
| `link` | `videoId` blok `videoNews` | Dinormalisasi lewat parser id/URL YouTube yang dijaga selaras persis dengan `normalizeYouTubeVideoId` milik `apps/cms` sendiri |
| `text_vid` | `bodyPortableText` (deskripsi, sebelum blok video) | Konversi HTML→Portable Text sama seperti `isi_berita` |
| `tgl` + `jam` | `publishedAt` | Berformat lawas (`YYMMDD`/`HHMMSS`, sesuai migrasi normalisasi-waktu-video milik seputarborneo sendiri), diformat ulang sebelum logika tanggal yang sama dengan `berita_red` |
| `admin` | `contentJson.legacySource.author` | Peringatan sama seperti `user` milik `berita_red` |
| `kategori`, `status` | *(tidak diimpor)* | Tidak ada konsep taksonomi atau status per-video yang dibawa |

### `ikl_online` → penempatan iklan (`POST /api/v1/news-portal/ad-placements`)

Hanya dibaca ke manifest impor — pembuatannya butuh `mediaObjectId` terverifikasi, dan `img_ikl` (nama berkas materi iklan) tidak diambil atau diunggah importer ini (lihat `docs/deployment.md`).

### `logo` → manifest logo instansi (untuk issue #59)

Dibaca ke manifest, dicocokkan lewat `nama` terhadap 24 instansi yang di-seed [issue #57](https://github.com/ahliweb/awcms-one/issues/57) — `awcms_blog_institutions` belum punya kolom `logo_media_id` di `apps/cms` repositori ini (itu datang lewat subtree pull upstream [issue #59](https://github.com/ahliweb/awcms-one/issues/59)), jadi tidak ada yang memanggil API untuk itu hari ini.

### `config` → `PUT /api/v1/site-profile` (full-replace yang di-merge dengan apa pun yang sudah di-set `bun run db:seed:cms`)

| Kolom lawas | Field AWCMS | Catatan |
| --- | --- | --- |
| `motho` | `tagline` | |
| `coppyright` | `copyrightNotice` | |
| `alamat` | `editorialAddress` | |
| `email` | `contactEmail` | |
| `wasupport` | `whatsappNumber` | |
| `fb`/`tw`/`ig`/`yt`/`tt`/`th` | `socialLinks[]` | Label platform `facebook`/`x`/`instagram`/`youtube`/`tiktok`/`threads`; hanya nilai `http(s)` yang lolos validator URL-absolut milik `/api/v1/site-profile` sendiri (nilai lain dilewati diam-diam, tidak pernah dikirim) |
| `title`, `redaksi`, `link_coppy`, `ico`, `logo` | *(tidak diterapkan)* | Tidak ada field di `/api/v1/site-profile` hari ini (dicek langsung terhadap `site-profile-validation.ts`) |

### Tidak diimpor sama sekali, dan mengapa

- **`users`** — identitas tidak dimigrasikan (PII); akun admin seputarborneo tidak punya padanan user AWCMS, dan kolom `user`/`admin` artikel jadi teks provenans (di atas), tidak pernah jadi login.
- **`counter`** — alamat IP pengunjung; tidak ada catatan persetujuan, tidak ada gunanya lagi begitu BjekMart/seputarborneo berjalan di atas `visitor-analytics` (issue #56/A10).
- **`newsletter_subscribers`** — dihitung dan dilaporkan, tidak pernah diimpor: tidak ada catatan persetujuan yang bertahan dari formulir pendaftaran lawas, dan newsletter `apps/cms` sendiri double opt-in (Keputusan 2 epic #46 sendiri). Flag `--with-subscribers` di kemudian hari mungkin menambahkan mereka sebagai `pending` setelah ada keputusan legal, sesuai Scope issue #58 sendiri.
- **`renungan_rmd`, `tanya_jawab`** — tabel mati di situs live (tidak ada yang menautkannya).
- **`foto_berita`** (tabel galeri, berbeda dari KOLOM `berita_red.foto_berita`) — fitur galeri tak terpakai yang tidak pernah dirender situs publik.

## Kolom dan tabel yang ditunda — tidak di-porting di increment ini

- **Kolom afiliasi dan `product_affiliate_links`** — [issue #32](https://github.com/ahliweb/awcms-one/issues/32), bersama akun pelanggan.
- **Tabel rate/tracking kurir RajaOngkir live** — [issue #33](https://github.com/ahliweb/awcms-one/issues/33); `shipping_method`/`shipping_service_name` pada order saat ini adalah label yang ditentukan merchant, tidak pernah respons kurir live.
- **Catatan transaksi payment-gateway** — enum `payment_method` sudah menerima `gateway` (aditif), tapi belum ada integrasi provider; harus dibangun lewat outbox sesuai [ADR-0010](adr/0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.id.md).
- **Upload media sungguhan untuk gambar produk, media slider, dan gambar bukti konfirmasi pembayaran** — diselesaikan lewat mekanisme referensi/URL yang sudah ada milik `media_library`, tapi seed increment ini memakai SVG placeholder dan endpoint upload-bukti anonim adalah stub (`503 MEDIA_UNAVAILABLE`) — lihat [`docs/cms.md`](cms.id.md) dan [`docs/deployment.md`](deployment.id.md).
