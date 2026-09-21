🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](SKILL.md)

> Mirror terjemahan dari `SKILL.md`. Berkas yang dimuat oleh mekanisme skill (dicocokkan persis pada nama `SKILL.md`) adalah versi Inggris; berkas ini adalah salinan baca untuk pembaca Bahasa Indonesia, bukan berkas yang dimuat langsung.

# awcms-one — Menambah tabel + endpoint commerce

Ikuti `apps/cms/AGENTS.md`, `apps/cms/CONTRIBUTING.md` (Definition of Done), dan skill di bawah `apps/cms/.claude/skills/` yang tersentuh pekerjaan ini — `awcms-new-migration`, `awcms-new-endpoint`, `awcms-new-event`, `awcms-abac-guard`, `awcms-audit-log`, `awcms-ui-screen`, `awcms-i18n`, `awcms-testing`. Skill ini menyatakan aturan **khusus modul `commerce` platform ini**, di atas aturan generik itu; ia tidak mengulanginya.

## Ini satu modul, bukan tiga — letakkan pekerjaan Anda di dalam `apps/cms/src/modules/commerce/`

[ADR-0008](../../../docs/adr/0008-one-commerce-module-carries-the-whole-store-not-three.id.md): katalog, marketing, dan pesanan semuanya hidup di bawah satu kunci modul, `commerce`. Tabel/rute/permission/event baru menjadi bagian dari konvensi direktori `domain/{catalog,marketing,orders}/…` modul ini yang sudah ada — itu pengelompokan direktori, bukan batas modul. Jangan buat `module.ts` kedua untuk fitur commerce baru; perluas yang sudah ada. `dependencies` modul (`tenant_admin`, `identity_access`, `domain_event_runtime`, `media_library`, `module_management`) hanya bertambah saat kapabilitas yang benar-benar baru dibutuhkan, bukan per tabel.

## Setiap tabel baru

1. `NNN_awcms_commerce_<area>_<desc>.sql` di bawah `apps/cms/sql/`, melanjutkan urutan migrasi modul ini sendiri (153–168 per tulisan ini — cek `ls apps/cms/sql/ | tail` untuk nomor berikutnya yang sebenarnya).
2. `tenant_id uuid NOT NULL REFERENCES awcms_tenants`, `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` **dan** `... FORCE ROW LEVEL SECURITY`, satu policy isolasi-tenant (`tenant_id = current_setting('app.current_tenant_id')::uuid`) — salin bentuk persisnya dari tabel commerce mana pun yang sudah ada di [`docs/skema-basis-data.md`](../../../docs/skema-basis-data.id.md), jangan tulis varian baru.
3. Setiap kolom foreign-key punya indeksnya sendiri (gate `db:fk-index:check` milik `apps/cms` menegakkan ini).
4. Uang adalah `numeric(14,2)`, tidak pernah `float`/`real` — lihat [ADR-0003](../../../docs/adr/0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.id.md) dan aturan `normalizeMoney` di bawah.
5. Referensi lintas-tabel yang tidak bisa dipercayakan modul ini ke FK belaka untuk isolasi per-tenant (mis. `category_id` pada produk) diperiksa di **lapisan aplikasi**, di dalam transaksi RLS-scoped yang sama, dan id yang tak dikenal/soft-deleted/lintas-tenant ditolak **secara identik** — tidak pernah tiga pesan error berbeda yang bisa dipakai pemanggil untuk menyelidiki id milik tenant lain (lihat bagian "category_id crossing tenants" di [`docs/skema-basis-data.md`](../../../docs/skema-basis-data.id.md) untuk pola persis yang harus disalin).
6. Daftarkan deskriptor `dataLifecycle` (mesin purge generik, `cursorColumn: "deleted_at"` kecuali tabel itu append-only seperti `order_events`, yang memakai `"created_at"` dan sama sekali tak punya `deleted_at`) dan `subjectData` tabel itu di `module.ts`. Jika tabel bisa menyimpan data orang sungguhan tapi orang itu tak punya baris `tenant_user`/`identity`/`profile`/`principal` (pelanggan tamu, dikenali hanya lewat telepon), deskriptor yang jujur adalah `unreachableBySubject: true` — lihat [ADR-0009](../../../docs/adr/0009-guest-checkout-by-order-code-and-phone.id.md) untuk alasan setiap tabel pesanan/pelanggan sudah melakukan ini; jangan mengarang nilai `subjectColumns` yang sebenarnya tidak jujur ada.

## Dua keanehan `Bun.SQL` yang harus diperhitungkan setiap query commerce

- **`0.00` yang tersimpan ter-decode sebagai teks `"0"` lewat query terparameterisasi**, tapi `"0.00"` lewat query sederhana. Lewatkan setiap field uang lewat `normalizeMoney` (`domain/price-calculation.ts`) di langkah `toRecord` — tidak pernah di aritmetika — sebelum ia meninggalkan modul. `null` diteruskan tanpa perubahan.
- **`= ANY($ids)` dengan array JS mentah salah-bind secara diam-diam** — dua id atau lebih ter-bind sebagai satu nilai teks `"a,b"` (`22P02`) — array satu-elemen lolos diam-diam, persis begini cara ini pernah lolos rusak sekali. Selalu bind dengan `tx.array([...ids], "uuid")::uuid[]` untuk pencarian id secara batch.

## Setiap endpoint sisi-owner baru

Ikuti `apps/cms/.claude/skills/awcms-new-endpoint/SKILL.md` secara penuh (rute tipis, `defineTenantRoute`, ABAC, validasi, idempotensi pada mutasi berisiko tinggi, OpenAPI). Dua tambahan khusus commerce:

1. **Penamaan permission**: `commerce.<resource>.<action>`, mengikuti empat area modul yang sudah ada (katalog/marketing/store-settings/pesanan) — lihat [`docs/api.md`](../../../docs/api.id.md) untuk daftar 39 kunci lengkap. Jangan deklarasikan permission tanpa rute yang menegakkannya (`access:permissions:enforcement:check` menangkap ini).
2. **`create`/`delete` untuk `orders`/`customers` sengaja tidak ada** — pesanan atau pelanggan hanya dibuat lewat jalur storefront anonim di bawah, yang tak punya identitas admin untuk diotorisasi. Jangan tambahkan `POST .../orders` sisi-owner "demi kelengkapan"; itu butuh desainnya sendiri (aktor mana yang membuat pesanan atas nama pembeli?) yang sengaja belum dibangun modul ini.

## Menambah ke API storefront anonim (`/api/v1/commerce/storefront/*`)

Baca [ADR-0007](../../../docs/adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.id.md) sebelum menambah rute baru di sini — ini bagian modul yang paling sensitif-kepercayaan, karena sama sekali tak punya pemeriksaan permission, dengan sengaja.

1. Resolusi tenant dari `Origin`/`Host` request terhadap `awcms_tenant_domains`, sama seperti setiap rute yang sudah ada di `application/public-commerce-tenant.ts` — jangan pernah percaya header yang bisa disetel pemanggil ke apa saja (id tenant di body, header `X-Tenant-*`).
2. Jawab preflight `OPTIONS`, echo origin yang diizinkan persis (jangan pernah `*`), kirim `Vary: Origin` di setiap respons.
3. Rate-limit per IP; tambahkan limit per-identifier juga (per telepon, per kode pesanan) jika rute itu bisa dipakai untuk enumerasi atau brute-force sesuatu.
4. Saat sebuah lookup bisa gagal karena lebih dari satu alasan (kode salah, telepon salah, pesanan milik tenant lain), jawab dengan respons yang **sama** untuk semuanya — lihat 404 netral `orders/{code}?phone=` sebagai pola yang harus disalin.
5. Penulisan yang mungkin di-double-submit pembeli butuh idempotency key lewat store `awcms_idempotency_keys` bersama (`_shared/idempotency.ts`) — bukan kolom buatan sendiri di tabel baru Anda.

## Layar admin dan event

- Layar admin baru: ikuti `awcms-ui-screen`; gerbang tampilan `read`-nya pada permission `commerce.<resource>.read` yang sesuai lewat `loadAdminScreen`, dan pastikan `admin:screen-coverage:check` melihat setiap permission yang ditambah perubahan Anda diklaim di suatu tempat.
- Event domain baru: ikuti `awcms-new-event`; daftarkan di `events.publishes` milik `module.ts`, `domain-event-runtime/domain/event-type-registry.ts`, dan `apps/cms/asyncapi/awcms-domain-events.asyncapi.yaml` dalam perubahan yang **sama** — event yang dideklarasikan lebih dulu tanpa registrasi (`voucher.redeemed` dideklarasikan satu increment penuh sebelum pernah ditembakkan) tidak masalah; event yang ditembakkan tanpa registrasi, masalah.

### Komposisi layar admin (redesain 2026-09, issue #171)

Setiap layar admin `commerce` disusun di atas primitive bersama yang ditambahkan restyle admin-chrome ke `apps/cms/src/styles/admin.css` (issue #170, subtree sync dari awcms#813 upstream) — jangan menulis ulang stat tile, tab strip, atau toggle sendiri untuk sebuah layar; pakai kelas yang sudah ada:

| Primitive | Dipakai untuk |
| --- | --- |
| `.admin-stat-card` | Satu ubin KPI (jumlah/mata uang/label) — dashboard, laporan, afiliasi, status provider di settings |
| `.admin-status-pill[data-tone]` | Indikator status/nada kecil — status pesanan, provider terkonfigurasi/tidak, jumlah kembalian POS |
| `.admin-segmented` | Baris tab/filter berbobot-sama (`aria-current="page"` untuk tautan navigasi biasa, `aria-selected` yang digerakkan JS hanya untuk tablist sungguhan) — filter status, strip tab bersama `CommerceMarketingTabs.astro` |
| `.admin-bulk-bar` | Bar yang muncul setelah baris tabel dipilih via checkbox, untuk aksi massal |
| `.admin-two-pane` | Pembagian daftar + detail — inbox; **bukan** POS, yang sisi keranjangnya butuh kontrol khusus POS yang tak dimodelkan two-pane generik, sehingga POS tetap memakai `.pos-layout` sendiri |
| `.admin-toggle` | Sakelar fitur on/off — settings |
| `.admin-timeline` | Daftar event berurutan-waktu — riwayat status halaman detail pesanan dari `order_events` |
| `.admin-media-grid` | Grid gambar yang bisa dipilih dengan panel detail di samping — belum dipakai layar `commerce` mana pun; adopsi ini alih-alih membuat layout grid baru saat dibutuhkan |

**Hanya data nyata, di setiap layar** — statistik, jumlah, atau baris yang tak bisa dihitung modul ini secara jujur dari tabel atau proyeksi yang sudah ada, dihilangkan, tidak pernah diisi placeholder atau angka karangan (stat tingkat konversi yang sengaja tak ada di dashboard, karena tak ada proyeksi funnel/kunjungan, adalah pola yang harus diikuti). Partial lintas-halaman bersama (strip tab marketing) hidup di bawah `apps/cms/src/components/`, tak pernah di `apps/cms/src/pages/admin/` — `access-chokepoint-check.ts` menyusuri setiap berkas `.astro` di bawah pohon itu mencari panggilan `loadAdminScreen`, dan partial bersama yang diletakkan di sana terbaca sebagai layar tambahan tanpa chokepoint.

## Verifikasi

```bash
cd apps/cms && DATABASE_URL="" bun run check     # rantai penuh ~53 langkah
# lalu, terhadap Postgres sekali-pakai (bun run db:up dari root repo):
cd apps/cms && DATABASE_URL=postgres://... bun test tests/integration/ --timeout 60000
```

Dari root repo, jika perubahan Anda menyentuh `docs/**`, `.changesets/**`, atau apa pun milik root: `bun test`, `bun run audit:dokumen`, `audit:translation`, `audit:rilis`, `audit:graf`. Lihat [`docs/pengujian.md`](../../../docs/pengujian.id.md) untuk apa yang dibuktikan tiap tingkat dan dua keanehan `Bun.SQL` di atas secara lebih dalam.
