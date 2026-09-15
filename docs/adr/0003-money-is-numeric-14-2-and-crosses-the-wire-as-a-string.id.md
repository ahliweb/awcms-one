🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md)

<!-- i18n-source-hash: sha256:e4e657b19837f64ff31a082836e4eff403f4f96f07663692db18ff2c54deb86f -->

# ADR-0003 — Uang adalah `numeric(14,2)`, dan melintasi jaringan sebagai string

- **Status:** Diterima
- **Tanggal:** 15 September 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** [issue #4](https://github.com/ahliweb/awcms-one/issues/4) (modul `commerce`, tempat keputusan ini dibuat); [`apps/cms/sql/153_awcms_commerce_schema.sql`](../../apps/cms/sql/153_awcms_commerce_schema.sql); [`docs/skema-basis-data.md`](../skema-basis-data.md); [`docs/kamus-data.md`](../kamus-data.md)

## Konteks

`awcms_commerce_products.price` adalah satu-satunya kolom di irisan ini di mana representasi yang salah adalah cacat tak kasatmata dan menumpuk, bukan bug yang jelas. Floating point biner tidak bisa merepresentasikan `0.10` secara persis (kegagalan klasik `0.1 + 0.2 !== 0.3`), dan aritmetika berulang atas harga berbasis float — diskon diterapkan, total dijumlahkan lintas keranjang — melenceng sepeser demi sepeser dengan cara yang tidak pernah melempar error dan tidak pernah menggagalkan tes yang kebetulan memakai angka bulat. Invoice pelanggan adalah audiens dari pelencengan itu.

Kolom `commerce_bj_mart.products.price` legacy datang dari stack MySQL/Laravel di mana kelas kegagalan ini persis umum terjadi; re-platform adalah momen untuk menutupnya, bukan membawanya lanjut tanpa diperiksa.

## Keputusan

`price` adalah `numeric(14,2)` di PostgreSQL (`sql/153`) — 12 digit bulat dan 2 desimal, fixed-point eksak, nyaman mencakup harga Rupiah hingga ratusan miliar. `Bun.SQL` mengembalikan kolom `numeric` sebagai **string**, tidak pernah `number` JS, dan `toRecord()` milik `commerce/application/product-directory.ts` — satu-satunya tempat bentuk-jaringan dirakit — tidak pernah mem-parse-nya. DTO `CommerceProduct` (`openapi/modules/commerce.openapi.yaml`, disebut juga dalam diskusi cakupan `packages/kontrak` meski DTO itu sendiri hidup di `application/`, bukan `domain/` — lihat [ADR-0004](0004-a-type-only-contract-package-with-an-import-direction-gate.md)) mendeklarasikan `price` sebagai `string`, sampai ke storefront, yang memformatnya untuk tampilan dengan `Intl.NumberFormat` (`formatPrice` milik `apps/storefront/src/lib/catalog.ts`) dan tidak pernah melakukan aritmetika apa pun atasnya — ia menampilkan harga dan **persentase** `discountPercent` yang dikirim `apps/cms`, tidak pernah jumlah diskon yang dihitung, sehingga ia tidak pernah harus menciptakan aturan pembulatan yang mungkin berbeda dari apa pun yang dihitung checkout di masa depan.

`discount_percent` dan `stock` adalah `integer` biasa di PostgreSQL, sengaja bukan `numeric`: keduanya bukan uang, dan keduanya eksak dalam floating point (persentase 0–100 dan hitungan unit), sehingga `numeric` di sana hanya menambah seremoni tanpa menutup celah nyata.

`CHECK (price >= 0)` di level basis data menguatkan invarian yang sama di sisi server; `commerce/domain/product-validation.ts` memvalidasi bentuk string yang masuk (desimal non-negatif, paling banyak dua digit desimal) sebelum pernah mencapai basis data.

## Konsekuensi

- Setiap lapisan yang menyentuh `price` — kolom SQL, perilaku driver `Bun.SQL`, validator domain, DTO, skema OpenAPI, dan rendering storefront — sepakat bahwa ia string. Hanya ada persis satu tempat di seluruh sistem yang pernah memanggil `Number()` atasnya: `formatPrice`, hanya untuk tampilan, langsung diumpankan ke `Intl.NumberFormat.prototype.format()` (yang tidak punya overload string) dan tidak pernah disimpan atau dikombinasikan ulang.
- Fitur masa depan yang butuh menghitung dengan uang — subtotal keranjang, total checkout — mewarisi nilai yang sudah eksak dan sudah string; ia harus memilih strategi aritmetikanya sendiri (pustaka desimal, atau minor-unit integer) alih-alih mengasumsikan `Number(price) + Number(price)` aman, karena tidak.
- `openapi/modules/commerce.openapi.yaml` mendokumentasikan `price` sebagai `type: string` dengan catatan "tidak pernah angka JSON" persis agar konsumen API masa depan tidak perlu menemukan ini dengan membaca `product-directory.ts`.
