🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](README.md)

<!-- i18n-source-hash: sha256:f1429d5228b4d00b8ab7093b12a1e606f284bceb4c5e3a5932e8246b12e7888c -->

# `practice_irm`

Issue [#270](https://github.com/ahliweb/awcms-one/issues/270) (IRMbyDUS: modul practice-irm), ADR-0002 (`web-irmbydus:docs/adr/0002-irm-domain-extension-strategy.md` — repositori BERBEDA, repo produk yang dilayani modul ini, karenanya cakupan lintas-repo `web-irmbydus:` dipakai alih-alih tautan relatif; dibaca sebagai referensi desain, tidak diduplikasi). Ini adalah modul yang genuinely BARU: tidak ada model konten IRM/practice yang ada di mana pun di `apps/cms` sebelum PR ini.

## Tujuan

Dua hal, keduanya digerbangi oleh lapisan entitlement `commerce` (Issue #267):

1. **Lima domain IRM kanonik** — IDENTIFY / NEUTRALIZE / NAVIGATE / EMBED / REINFORCE — sebagai konten yang dapat diedit admin di CMS. `web-irmbydus.com` merender apa pun yang dikembalikan `GET /api/v1/practice-irm/storefront/account/content` dan tidak menyimpan salinan independen dari nama/deskripsi/copy sebuah domain. Inilah cara risiko "IRM terminology drift" PRD (tabel Major Risks, §40) dimitigasi: perbaikan kata-kata dirilis sebagai satu edit admin di sini, tidak pernah deploy frontend.
2. **`practice_sessions`** — catatan jurnal terpandu 12-field dari PRD §16, dimiliki oleh seorang pelanggan `commerce`, digerbangi per panggilan oleh `verifyEntitlement(ownerCustomerId, productId)`.

`program-21day` (modul kedua ADR-0002, `program_enrollments`/`program_day_states`) secara eksplisit di luar cakupan PR ini.

## Kenapa modul ini bergantung pada `commerce`, bukan membuat identitasnya sendiri

Akun pelanggan `commerce` ([ADR-0016](../../../../../docs/adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md)) sudah menjadi identitas sesi bearer yang dipegang seorang pelanggan berbayar di sistem ini, dan lapisan entitlement `commerce` (Issue #267, `application/commerce-entitlement-directory.ts`) sudah menjawab "apakah pelanggan ini membeli akses ke produk ini" — pertanyaan persis yang perlu dijawab setiap rute di modul ini sebelum melakukan apa pun. `requireCustomerSession` dan `verifyEntitlement` diimpor langsung, lintas-modul.

## Tabel

### `awcms_practice_irm_domains` (`sql/940`)

| Kolom                         | Tipe                    | Catatan                                                                                                                                                                      |
| ----------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                          | uuid PK                 |                                                                                                                                                                              |
| `tenant_id`                   | uuid FK `awcms_tenants` |                                                                                                                                                                              |
| `domain_key`                  | text                    | salah satu dari `identify`/`neutralize`/`navigate`/`embed`/`reinforce`, dibatasi CHECK                                                                                       |
| `name`, `description`, `copy` | text                    | konten yang dapat diedit admin                                                                                                                                               |
| `display_order`               | integer                 |                                                                                                                                                                              |
| `deleted_at`                  | timestamptz, nullable   | diisi berarti "reset ke bawaan bawaan" — konvensi yang sama yang ditetapkan `awcms_commerce_store_settings` (`sql/910`). Tidak pernah ada `DELETE` sungguhan pada tabel ini. |
| `created_at`/`updated_at`     | timestamptz             |                                                                                                                                                                              |

Paling banyak satu baris LIVE per `(tenant_id, domain_key)` (indeks unik parsial pada `deleted_at IS NULL`). RLS: hanya isolasi tenant — tabel ini tidak punya dimensi pelanggan/pemilik.

`DEFAULT_PRACTICE_IRM_DOMAIN_CONTENT` (`domain/practice-irm-domain-content.ts`) adalah bawaan yang menjadi fallback setiap jalur baca (`listPracticeIrmDomains`/`getPracticeIrmDomain`) untuk `domain_key` tanpa baris live — sehingga konten publik tidak pernah kosong, bahkan untuk tenant baru yang belum pernah membuka layar admin, dan sebuah "reset" juga tidak pernah meninggalkannya kosong.

### `awcms_practice_irm_sessions` (`sql/941`)

| Kolom                                                                                                                        | Tipe                               | Catatan                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `id`                                                                                                                         | uuid PK                            |                                                                                                                |
| `tenant_id`                                                                                                                  | uuid FK `awcms_tenants`            |                                                                                                                |
| `owner_customer_id`                                                                                                          | uuid FK `awcms_commerce_customers` | pemilik — lihat "Pemilikan-terskop" di bawah                                                                   |
| `product_id`                                                                                                                 | uuid FK `awcms_commerce_products`  | entitlement mana yang membuka sesi ini saat pembuatan                                                          |
| `status`                                                                                                                     | text                               | `draft` \| `completed`; `draft -> completed` adalah satu-satunya transisi                                      |
| `situation`, `emotion`, `body`, `automatic_thought`, `meaning`, `neutralize`, `navigate`, `embed`, `reinforce`, `reflection` | text, nullable                     | field teks bebas PRD §16                                                                                       |
| `intensity`, `post_intensity`                                                                                                | integer, nullable                  | **integer polos 0-10, dibatasi CHECK, tidak ada yang diturunkan** — lihat "Tanpa skor turunan" di bawah        |
| `completed_at`                                                                                                               | timestamptz, nullable              | diisi tepat saat `status` menjadi `completed`                                                                  |
| `deleted_at`                                                                                                                 | timestamptz, nullable              | ada demi keseragaman skema; **tidak ada rute di PR ini yang mengisinya** (lihat "Keterbatasan yang diketahui") |
| `created_at`/`updated_at`                                                                                                    | timestamptz                        |                                                                                                                |

Kedua belas field itu menyusuri lima domain secara berurutan: `situation`/`emotion`/`intensity`/`body`/`automatic_thought`/`meaning` adalah IDENTIFY; `neutralize` adalah NEUTRALIZE; `post_intensity` mengukur ulang setelahnya; `navigate`/`embed`/`reinforce` adalah domainnya masing-masing; `reflection` menutup sesi.

## RLS dan pemilikan-terskop

Kedua tabel: `ENABLE` + `FORCE ROW LEVEL SECURITY`, satu kebijakan `USING` isolasi-tenant (`tenant_id = current_setting('app.current_tenant_id')::uuid`) — bentuk identik dengan `awcms_commerce_entitlements` (`sql/936`).

Untuk `awcms_practice_irm_sessions`, pemilikan-terskop bersifat **level-aplikasi**, dengan cara yang sama seperti `listEntitlementsForCustomer` milik `commerce-entitlement-directory.ts` sudah melakukannya (ADR-0016 D1: tidak ada variabel sesi `app.current_customer_id` di mana pun dalam basis kode ini, jadi kebijakan RLS kedua yang terkait dengan pelanggan pemanggil bukan bentuk yang dimiliki sistem ini). `owner_customer_id` dibaca **hanya** dari sesi bearer terverifikasi (`requireCustomerSession`, dipakai ulang langsung dari `commerce/application/customer-session-auth.ts`), tidak pernah diterima dari input permintaan, dan setiap kueri di `application/practice-session-directory.ts` memfilternya secara eksplisit.

## Gerbang entitlement

Setiap fungsi di `application/practice-session-directory.ts` — buat, baca satu, daftar, perbarui, selesaikan — memanggil `verifyEntitlement(tx, tenantId, ownerCustomerId, productId)` **lebih dulu**, langsung, tanpa cache, sebelum menyentuh satu baris pun. Pelanggan tanpa entitlement aktif untuk `productId` mendapat `{ kind: "forbidden" }` → rute menjawab `403 ENTITLEMENT_REQUIRED` dan tidak mengembalikan apa pun — tidak pernah konten practice, tidak pernah kemampuan mencatat atau membaca sesi, termasuk riwayat. Sebuah pencabutan karena itu langsung memutus akses pada panggilan berikutnya, persis seperti perilaku `verifyEntitlement` sendiri untuk pemeriksaan entitlement.

Gerbang yang sama berlaku untuk membaca konten lima-domain lewat rute yang menghadap pelanggan (`GET .../storefront/account/content`) — konten, bukan hanya sesi, memerlukan entitlement aktif untuk `productId` yang disebutkan pemanggil.

## Tanpa skor turunan — sebuah aturan, bukan preferensi

Non-Goal Eksplisit PRD (§38) melarang "skor klinis"/"profiling psikologis"; Konsekuensi ADR-0002 menyatakan aturannya secara langsung: `intensity`/`post_intensity` adalah integer polos 0-10 tanpa logika skor turunan di mana pun. Ini ditegakkan dengan tiga cara:

1. Batasan `CHECK` basis data (0-10 inklusif) pada kedua kolom (`sql/941`).
2. `isValidIntensityValue` milik `domain/practice-session.ts` adalah **satu-satunya** fungsi di modul ini yang menyentuh salah satu field itu, dan yang dilakukannya hanya memeriksa rentang.
3. `tests/practice-session-no-derived-score.test.ts` men-grep sumber modul sendiri untuk tanda-tanda tanggung jawab kedua (menjumlahkan, merata-ratakan, mengelompokkan ke label keparahan) yang tumbuh pada salah satu field itu — penjaga terhadap penyimpangan di masa depan, bukan hanya kebenaran saat ini.

## Permukaan akses

### Admin (staf tenant, `defineTenantRoute`)

| Rute                                              | Izin                          | Catatan                                                         |
| ------------------------------------------------- | ----------------------------- | --------------------------------------------------------------- |
| `GET /api/v1/practice-irm/domains`                | `practice_irm.domains.read`   | Selalu 5 entri (baris live atau bawaan built-in).               |
| `POST /api/v1/practice-irm/domains`               | `practice_irm.domains.create` | `409 ALREADY_EXISTS` jika baris live sudah ada.                 |
| `GET /api/v1/practice-irm/domains/{domainKey}`    | `practice_irm.domains.read`   |                                                                 |
| `PUT /api/v1/practice-irm/domains/{domainKey}`    | `practice_irm.domains.update` | `404` jika belum ada baris live.                                |
| `DELETE /api/v1/practice-irm/domains/{domainKey}` | `practice_irm.domains.delete` | Mereset ke bawaan — pembalikan status, bukan penghapusan baris. |

Layar admin: `/admin/practice-irm-domains` (`src/pages/admin/practice-irm-domains.astro`).

**Sengaja tidak ada izin admin, rute admin, atau layar admin atas `awcms_practice_irm_sessions`.** Tabel Major Risks PRD (§40) menamai "Journal leakage" sebagai Kritis, dimitigasi oleh "RLS + ABAC + tes + audit" — bentuk paling kuat dari mitigasi itu adalah konten sesi pelanggan sama sekali tidak pernah diekspos ke permukaan staf-tenant dalam PR ini.

### Pelanggan (sesi bearer, `customerBearer` milik `commerce`)

Semua di bawah `/api/v1/practice-irm/storefront/account/*`, semua memerlukan `Authorization: Bearer cs_…` dan, kecuali disebutkan, sebuah `productId`:

| Rute                                         | Catatan                                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET .../content?productId=`                 | Konten terkini kelima domain.                                                                         |
| `GET .../sessions?productId=&cursor=&limit=` | Riwayat "sesi saya", dipaginasi keyset, terbaru dulu.                                                 |
| `POST .../sessions`                          | Membuat sesi `draft` baru (body menyertakan `productId`). Setiap field konten bersifat opsional.      |
| `GET .../sessions/{id}?productId=`           | Membaca satu sesi.                                                                                    |
| `PATCH .../sessions/{id}`                    | Menyimpan field konten draft (body menyertakan `productId`). `409 SESSION_COMPLETED` setelah selesai. |
| `POST .../sessions/{id}/complete`            | `draft -> completed`. `409 INCOMPLETE_FIELDS` kecuali `situation`/`intensity` sudah terisi.           |

Resolusi tenant mencerminkan pola resolusi-tenant-anonim milik `newsletter`/`commerce` sendiri (`application/public-practice-irm-tenant.ts`, disalin dari `commerce/application/public-commerce-tenant.ts`): Origin-dulu untuk pemanggil lintas-origin, host-dulu untuk yang se-origin, setiap kasus tak-teresolusi/nonaktif/ditolak jatuh ke hasil netral yang sama.

## Dependensi

`tenant_admin`, `identity_access`, `module_management`, `logging`, `commerce`. Dependensi pada `commerce` bersifat struktural, bukan sekadar impor kenyamanan — baik `owner_customer_id` maupun `product_id` pada `awcms_practice_irm_sessions` adalah foreign key ke tabel `commerce` sendiri.

## Siklus hidup data / data subjek

Kedua tabel mendeklarasikan deskriptor `dataLifecycle` dan `subjectData` di `module.ts`. `awcms_practice_irm_sessions.owner_customer_id` tidak terjangkau oleh kosakata tenant_user/identity/profile/principal mesin data-subjek karena alasan struktural yang sama dengan `commerce.entitlements`/`commerce.customers` (ADR-0016 D1) — lihat komentar `module.ts` sendiri untuk penalaran lengkapnya.

## Keterbatasan yang diketahui (eksplisit, bukan diam-diam)

- **Tidak ada rute soft-delete/penghapusan untuk `practice_sessions`.** `deleted_at` ada di tabel demi keseragaman skema, tetapi tidak ada kode di PR ini yang pernah mengisinya. Sebuah rute ekspor/hapus mandiri di masa depan — mencerminkan rute `/account/addresses` bearer-secured milik `commerce` sendiri — adalah jalur jujur bagi pelanggan untuk menjalankan hak-hak ini atas konten sesinya sendiri; di luar cakupan di sini.
- **Tidak ada visibilitas admin ke konten sesi**, by design (lihat "Permukaan akses" di atas) — seorang operator tidak dapat melihat sesi pelanggan dari modul ini sama sekali, bahkan untuk keperluan dukungan.
- **`program-21day`** (modul kedua ADR-0002) adalah modul terpisah yang belum dibangun; tidak ada apa pun di sini yang mereferensikan pendaftaran program atau status hari.

## Tes

- `tests/practice-irm-domain-content.test.ts` — domain murni: penggabungan konten bawaan, validasi kunci domain.
- `tests/practice-session-domain.test.ts` — domain murni: validasi rentang intensity, pemeriksaan field-minimum-untuk-selesai.
- `tests/practice-session-no-derived-score.test.ts` — menjaga agar tidak ada helper skor/klasifikasi turunan yang ditambahkan pada `intensity`/`postIntensity`.
- `tests/integration/practice-irm-domain-directory.integration.test.ts` — CRUD basis data nyata + reset-ke-bawaan + isolasi RLS.
- `tests/integration/practice-session-directory.integration.test.ts` — CRUD basis data nyata, penegakan gerbang entitlement (403 tanpa entitlement, di setiap fungsi), batasan CHECK `intensity`/`post_intensity` (menolak nilai di luar rentang di basis data), imutabilitas sesi yang sudah selesai, dan isolasi pemilik/RLS.
