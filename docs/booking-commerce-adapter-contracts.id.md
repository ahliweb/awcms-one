🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](booking-commerce-adapter-contracts.md)

<!-- i18n-source-hash: sha256:9ec22536335ef16367dbfc2225d661871458980d351e4bb50325308a48b09e7a -->

# Adapter booking-commerce — draf kontrak OpenAPI dan AsyncAPI

Artefak DoR 7 epic [#280](https://github.com/ahliweb/awcms-one/issues/280), item kerja W7 ([#358](https://github.com/ahliweb/awcms-one/issues/358)), dilacak di [`aw-business-platform-dor.md`](aw-business-platform-dor.id.md). Dokumen ini merancang rute HTTP dan event domain yang akan ditambahkan adapter booking-commerce ke modul `commerce`, memakai tabel dari [`booking-commerce-adapter-data-model.md`](booking-commerce-adapter-data-model.id.md) dan kunci izin dari [`booking-commerce-access-matrix.md`](booking-commerce-access-matrix.id.md).

> **Hanya draf. Setiap path dan event di bawah berstatus "draf — tidak ada di spesifikasi live".** Tidak ada yang berupa berkas di bawah `apps/cms/openapi/` atau `apps/cms/asyncapi/`, sehingga `ROUTE_PARITY_EXEMPTIONS` di `apps/cms/scripts/api-spec-check.ts` tetap kosong dan tidak ada gerbang yang melihat path ini ([ADR-0040](adr/0040-aw-business-platform-capability-ownership-and-boundaries.id.md) D7). Blok YAML ditulis dalam bentuk yang dipakai fragmen sungguhan agar implementasi kelak dapat mengangkatnya, tetapi ia hanyalah teks dalam halaman Markdown: tidak divalidasi, tidak dibundel, tidak disajikan. Nama tabel, izin, kode galat, dan event adalah usulan yang boleh disesuaikan isu implementasi. Jangan membaca halaman ini sebagai gambaran API saat ini; [`status.md`](status.id.md) dan berkas di bawah `apps/cms/openapi/` yang menjelaskannya.

## 1. Masukan dan konvensi yang ditetapkannya

| Sumber                                                                                                                                                                                                                                                                                                                                  | Yang ditetapkannya bagi draf ini                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/cms/openapi/modules/commerce.openapi.yaml` dan fragmen akar `apps/cms/openapi/awcms-public-api.src.yaml`                                                                                                                                                                                                                          | Amplop sukses `{ success: true, data }`; amplop galat `ApiError`; rute staf mewarisi `bearerAuth` global ditambah `tenantHeader`; rute storefront anonim mendeklarasikan `security: []` dan, bila pembeli boleh masuk, `customerBearer` opsional ([ADR-0016](adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.id.md) D3); komponen bersama `#/components/parameters/IdempotencyKey` (ADR-0129) dirujuk, tidak dideklarasikan ulang; uang berupa **string** `numeric(14,2)`; path staf di `/api/v1/commerce/...`, path pembeli anonim di `/api/v1/commerce/storefront/...` |
| `apps/cms/docs/awcms/cross-domain-contracts.md` bagian 3 (port Booking)                                                                                                                                                                                                                                                                 | Adapter menjangkau Booking hanya lewat `BookingPort` (`quote`, `hold`, `confirm`, `cancel`, `reschedule`), masing-masing dengan kunci idempotensi wajib. Penolakan Booking (`SLOT_UNAVAILABLE`, `HOLD_EXPIRED`, `INVALID_STATE`, dan seterusnya) dipetakan ke `409` dengan kode yang sama. Booking tidak menerima harga, deposit, status pembayaran, atau kontak pelanggan                                                                                                                                                                                                                                  |
| `apps/cms/asyncapi/provisional/awcms-cross-domain-events.provisional.asyncapi.yaml` dan paket Booking setelah [ADR-0135](https://github.com/ahliweb/awcms/blob/main/docs/adr/0135-day-granularity-stays-admitted-into-booking-v1.md) (`booking.md` bagian 2.5 dan 3.1, di cabang sinkronisasi subtree yang menunggu)                    | Sembilan event provisional `awcms.booking.reservation.*` dengan satu payload bersama; menginap menambah larik aditif `stays[]` (`resourceId`, `checkInDate`, `checkOutDate`, `nights`, `timezone`); payload tidak memuat pelanggan, kontak, atau status pembayaran                                                                                                                                                                                                                                                                                                                                          |
| [ADR-0041](adr/0041-gateway-deposit-sessions-and-mixed-tenders-on-one-order.id.md) D1, D5, D6, D7, D8                                                                                                                                                                                                                                   | Sesi gateway punya `purpose` (`full`, `deposit`, `balance`) dan `expected_amount` hasil hitungan server; klien tidak mengirim jumlah; satu sesi aktif per pesanan; pesanan menampilkan `settlement` turunan dengan `deposit`, `balanceDue`, `settledAt`; event pelunasan terbit sekali saat sisa nol; poin dan deposit tidak pernah berbagi pesanan                                                                                                                                                                                                                                                         |
| [ADR-0025](adr/0025-payments-are-an-allocation-ledger-separate-from-order-status.id.md), [ADR-0033](adr/0033-returns-refunds-and-exchanges-are-additive-records-that-compensate-through-the-existing-ledgers.id.md), [ADR-0134](https://github.com/ahliweb/awcms/blob/main/docs/adr/0134-descriptor-declared-domain-event-consumers.md) | Buku besar adalah otoritas pelunasan; refund adalah satu leg per pembayaran asal di bawah sebuah return; konsumen dideklarasikan di deskriptor modul (`domainEventConsumers`) dengan mode idempotensi yang dinyatakan                                                                                                                                                                                                                                                                                                                                                                                       |
| Jawaban pemilik 10 Oktober 2026 (Q1 sampai Q4, Q8 sampai Q10)                                                                                                                                                                                                                                                                           | Malam adalah kuantitas satu produk; selisih reschedule dihargai oleh jalur pesanan; pembatalan dihitung dari kebijakan per produk dengan bawaan tenant; hanya izin manajer atau keuangan yang boleh menimpa refund, dengan step-up, alasan, dan audit                                                                                                                                                                                                                                                                                                                                                       |

Aturan yang berlaku untuk setiap draf di bawah:

1. **Tidak ada uang dari klien.** Tidak ada permintaan yang membawa `amount`, `expectedAmount`, `computedRefund`, atau `price`. Server menghitungnya dari buku besar dan kebijakan. Isi yang menyebutnya ditolak `400 VALIDATION_ERROR`, seperti rute buku stok yang menolak saldo dari klien. Satu-satunya pengecualian adalah `finalRefund` pada override, yang hanya boleh dikirim pemegang izinnya (bagian 3.6).
2. **Pelanggan tidak pernah menjadi masukan dan tidak pernah menjadi kolom keluaran sebuah reservasi.** Pembeli dikenali dari sesi bearer atau, untuk tamu, dari mekanisme pesanan itu sendiri (`orderCode` ditambah `phone`, persis seperti rute pesanan anonim yang ada). Respons membawa kode pesanan, bukan id pelanggan (temuan X7).
3. **Setiap rute yang mengubah data mewajibkan `Idempotency-Key`.** Pada hold-ke-pesanan kunci itu disimpan sebagai `client_key` di tautan reservasi (`UNIQUE (tenant_id, client_key)`); ulangan dengan kunci dan isi sama mengembalikan hasil asli, kunci sama dengan isi berbeda atau aktor lain adalah `409 IDEMPOTENCY_CONFLICT`.
4. **Tidak ada panggilan penyedia di dalam transaksi** (aturan [ADR-0017](adr/0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.id.md), diulang oleh ADR-0041 D5.4). Rute sesi deposit menetapkan jumlah yang diharapkan dalam satu transaksi singkat dan memanggil penyedia tanpa transaksi terbuka.

## 2. Inventaris path draf

Semua path **draf — tidak ada di spesifikasi live**. "Izin" adalah kunci usulan (belum terdaftar) dari matriks akses. Nomor bagian menunjuk ke YAML di bawah.

| #   | Metode dan path                                                                       | Pemanggil                    | Izin / autentikasi                                                                                                                                               | Tujuan                                                                                | Bag. |
| --- | ------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---- |
| 1   | `GET /api/v1/commerce/booking/offering-links`                                         | Staf                         | `commerce.booking_offering_links.read`                                                                                                                           | Daftar tautan offering ke produk                                                      | 3.1  |
| 2   | `POST /api/v1/commerce/booking/offering-links`                                        | Staf                         | `commerce.booking_offering_links.create`                                                                                                                         | Tautkan satu offering ke satu produk jasa                                             | 3.1  |
| 3   | `PATCH /api/v1/commerce/booking/offering-links/{id}`                                  | Staf                         | `commerce.booking_offering_links.update`                                                                                                                         | Lepas tautan (perubahan status; tanpa hapus)                                          | 3.1  |
| 4   | `POST /api/v1/commerce/storefront/booking/reservations`                               | Pembeli (anonim atau bearer) | tidak ada; `customerBearer` opsional                                                                                                                             | Hold slot atau menginap dan buat pesanan, satu panggilan idempoten                    | 3.2  |
| 5   | `POST /api/v1/commerce/booking/reservations`                                          | Staf atau kasir              | `commerce.booking_reservation_links.create` (POS also `commerce.pos.create`)                                                                                     | Sama, atas nama tamu atau di kasir                                                    | 3.2  |
| 6   | `POST /api/v1/commerce/storefront/orders/{orderCode}/payment-gateway/sessions`        | Pembeli                      | tidak ada; `customerBearer` opsional                                                                                                                             | **Mengubah rute yang ada**: isi menambah `purpose`, respons menambah `expectedAmount` | 3.3  |
| 7   | `POST /api/v1/commerce/orders/{id}/payment-gateway/sessions`                          | Staf                         | `commerce.payments.create`                                                                                                                                       | Sesi deposit atau pelunasan yang dimulai staf (ADR-0041 D5.3)                         | 3.3  |
| 8   | `GET /api/v1/commerce/booking/reservations/{id}`                                      | Staf                         | `commerce.booking_reservation_links.read`                                                                                                                        | Tautan reservasi, kode pesanan, dan pelunasan turunan                                 | 3.4  |
| 9   | `GET /api/v1/commerce/storefront/booking/reservations/{orderCode}`                    | Pembeli                      | tidak ada; `customerBearer` atau query `phone`                                                                                                                   | Reservasi sendiri dengan deposit, sisa tagihan, dan waktu lunas                       | 3.4  |
| 10  | `GET /api/v1/commerce/booking/reservations/{id}/cancellation-quote`                   | Staf                         | `commerce.booking_reservation_links.read`                                                                                                                        | Refund hasil hitung yang tidak mengikat                                               | 3.5  |
| 11  | `GET /api/v1/commerce/storefront/booking/reservations/{orderCode}/cancellation-quote` | Pembeli                      | tidak ada; `customerBearer` atau query `phone`                                                                                                                   | Sama, untuk reservasi milik pembeli sendiri                                           | 3.5  |
| 12  | `POST /api/v1/commerce/booking/reservations/{id}/cancel`                              | Staf                         | `commerce.booking_reservation_links.cancel`, `commerce.booking_refund_decisions.create` (inline override also needs `commerce.booking_refund_overrides.approve`) | Batalkan dan catat keputusan                                                          | 3.5  |
| 13  | `POST /api/v1/commerce/storefront/booking/reservations/{orderCode}/cancel`            | Pembeli                      | tidak ada; `customerBearer` atau `phone`                                                                                                                         | Pelanggan mengonfirmasi pembatalan yang telah dikutip                                 | 3.5  |
| 14  | `POST /api/v1/commerce/booking/reservations/{id}/refund-override`                     | Manajer atau keuangan        | `commerce.booking_refund_overrides.approve` dan step-up segar                                                                                                    | Tetapkan refund akhir selain hasil hitung                                             | 3.6  |
| 15  | `POST /api/v1/commerce/booking/reservations/{id}/reschedule`                          | Staf                         | `commerce.booking_reservation_links.update`                                                                                                                      | Pindahkan reservasi; selisih harga lewat jalur pesanan                                | 3.7  |
| 16  | `POST /api/v1/commerce/booking/reservations/{id}/no-show`                             | Staf                         | `commerce.booking_reservation_links.cancel`, `commerce.booking_refund_decisions.create`                                                                          | Tandai no-show dan terapkan aturan retensi kebijakan                                  | 3.8  |
| 17  | `POST /api/v1/commerce/pos/booking/reservations/{id}/check-in`                        | Kasir atau staf              | `commerce.pos.create`, `commerce.payments.create`, `commerce.booking_reservation_links.read`                                                                     | Pungut pelunasan di sesi register terbuka, lalu check-in                              | 3.9  |

Tidak didrafkan di sini karena bukan khusus booking atau milik tempat lain: penyuntingan kebijakan deposit (ia kolom form produk, [`booking-commerce-adapter-data-model.md`](booking-commerce-adapter-data-model.id.md) bagian 7 butir 2), versi dan jendela kebijakan pembatalan (CRUD admin yang UX-nya W8, [#359](https://github.com/ahliweb/awcms-one/issues/359)), aksi penyelesaian bendera perhatian, dan permukaan Wave B (segmen [#360](https://github.com/ahliweb/awcms-one/issues/360), redemption [#363](https://github.com/ahliweb/awcms-one/issues/363)). Masing-masing mengikuti konvensi yang sama dan mendapat drafnya di isunya sendiri.

## 3. Draf fragmen OpenAPI 3.1

Setiap operasi membawa `x-awcms-draft: true` sebagai penanda bahwa ia tidak ada di spesifikasi live; penanda itu tidak akan ada di fragmen sungguhan. Target `$ref` seperti `#/components/schemas/ApiError` baru terselesaikan setelah bundel sungguhan menggabungkan fragmen, persis seperti kata header fragmen commerce tentang dirinya.

### 3.1 Menautkan offering dan produk

```yaml
# DRAFT — not in the live spec.
paths:
  /api/v1/commerce/booking/offering-links:
    get:
      operationId: listCommerceBookingOfferingLinks
      x-awcms-draft: true
      tags: [Commerce]
      summary: "List offering-to-product links (newest first, keyset-paginated). Gated on commerce.booking_offering_links.read."
      parameters:
        - { name: cursor, in: query, required: false, schema: { type: string } }
        - {
            name: status,
            in: query,
            required: false,
            schema: { type: string, enum: [active, unlinked] },
          }
      responses:
        "200":
          description: Links for the tenant, with an opaque nextCursor (null on the last page).
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, enum: [true] }
                  data:
                    type: object
                    properties:
                      items:
                        type: array
                        items:
                          {
                            $ref: "#/components/schemas/CommerceBookingOfferingLink",
                          }
                      nextCursor: { type: string, nullable: true }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
    post:
      operationId: createCommerceBookingOfferingLink
      x-awcms-draft: true
      tags: [Commerce]
      summary: "Link one Booking offering to one service product. Gated on commerce.booking_offering_links.create; requires Idempotency-Key."
      description: >-
        One offering has at most one active link and one product has at most one
        active link. The product must be type `service`; `quantityBasis` must agree
        with the offering's granularity (`nights` for a stay offering, `booking`
        for a time-slot offering). Booking is read through its port; it is not altered.
      parameters:
        - $ref: "#/components/parameters/IdempotencyKey"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [offeringId, productId, quantityBasis]
              properties:
                offeringId: { type: string, format: uuid }
                productId: { type: string, format: uuid }
                quantityBasis: { type: string, enum: [nights, booking] }
      responses:
        "201":
          description: Link created (or the original returned on an idempotent replay).
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, enum: [true] }
                  data:
                    { $ref: "#/components/schemas/CommerceBookingOfferingLink" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "409":
          description: "OFFERING_ALREADY_LINKED, PRODUCT_ALREADY_LINKED, PRODUCT_NOT_SERVICE, QUANTITY_BASIS_MISMATCH or IDEMPOTENCY_CONFLICT."
          content:
            {
              application/json:
                { schema: { $ref: "#/components/schemas/ApiError" } },
            }
  /api/v1/commerce/booking/offering-links/{id}:
    patch:
      operationId: updateCommerceBookingOfferingLink
      x-awcms-draft: true
      tags: [Commerce]
      summary: "Unlink an offering (status active to unlinked). Gated on commerce.booking_offering_links.update; requires Idempotency-Key. Past orders and reservation links are untouched."
      parameters:
        - {
            name: id,
            in: path,
            required: true,
            schema: { type: string, format: uuid },
          }
        - $ref: "#/components/parameters/IdempotencyKey"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [status]
              properties:
                status: { type: string, enum: [unlinked] }
      responses:
        "200":
          description: The updated link.
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, enum: [true] }
                  data:
                    { $ref: "#/components/schemas/CommerceBookingOfferingLink" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
components:
  schemas:
    CommerceBookingOfferingLink:
      type: object
      properties:
        id: { type: string, format: uuid }
        offeringId: { type: string, format: uuid }
        productId: { type: string, format: uuid }
        quantityBasis: { type: string, enum: [nights, booking] }
        status: { type: string, enum: [active, unlinked] }
        unlinkedAt: { type: string, format: date-time, nullable: true }
        createdAt: { type: string, format: date-time }
```

### 3.2 Hold ke pesanan (satu panggilan idempoten)

Urutan kerja adapter: kutipan lewat `BookingPort.quote`, `BookingPort.hold` dengan `externalRef = { type: "commerce_order", id: <id pesanan> }` dan kunci idempotensi permintaan, pembuatan pesanan dengan baris (kuantitas = jumlah malam untuk menginap, 1 untuk slot) dan salinan `dp_amount` (ADR-0041 D4), lalu penyisipan tautan reservasi. Kunci alami `(tenant, externalRef.type, externalRef.id)` membuat ulangan dengan kunci baru pun tidak menggandakan reservasi aktif. Bila pembuatan pesanan gagal setelah hold, hold dibatalkan lewat port dalam langkah kompensasi, dan hold toh akan kedaluwarsa dengan sendirinya.

```yaml
# DRAFT — not in the live spec.
paths:
  /api/v1/commerce/storefront/booking/reservations:
    post:
      operationId: createCommerceStorefrontBookingReservation
      x-awcms-draft: true
      tags: [Commerce]
      summary: "Hold a slot or stay and create the order from it in one idempotent request. Anonymous, with an optional customerBearer (ADR-0016 D3). The customer is the bearer session's, or the guest fields on the order; it is never an input id."
      description: >-
        Idempotency-Key is stored as the reservation link's `client_key`. A replay
        with the same key and body returns the original response with
        `replayed: true` and creates neither a second reservation nor a second
        order. A cart whose product has no deposit policy is an ordinary whole-total
        order (ADR-0041 D3). Redeeming points on an order with a deposit is refused
        (ADR-0041 D8). Booking is reached through BookingPort only; no price,
        deposit or payment field is sent to it.
      security: [{}, { customerBearer: [] }]
      parameters:
        - $ref: "#/components/parameters/IdempotencyKey"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/CommerceBookingReservationCreate"
      responses:
        "201":
          description: Reservation held and order created.
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, enum: [true] }
                  data: { $ref: "#/components/schemas/CommerceBookingReservationCreated" }
        "200":
          description: Idempotent replay; the original result with `replayed: true`.
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, enum: [true] }
                  data: { $ref: "#/components/schemas/CommerceBookingReservationCreated" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401":
          description: "UNAUTHENTICATED — an Authorization header was present but not a live customer session."
          content: { application/json: { schema: { $ref: "#/components/schemas/ApiError" } } }
        "404": { $ref: "#/components/responses/NotFound" }
        "409":
          description: >-
            OFFERING_NOT_LINKED, or a Booking refusal under its own code
            (SLOT_UNAVAILABLE, OUTSIDE_SCHEDULE, LEAD_TIME_VIOLATION, HORIZON_EXCEEDED,
            PARTY_SIZE_OUT_OF_RANGE, MIN_STAY_VIOLATION, MAX_STAY_EXCEEDED,
            STAY_DATES_INVALID), or POINTS_DEPOSIT_NOT_COMBINABLE, or IDEMPOTENCY_CONFLICT.
          content: { application/json: { schema: { $ref: "#/components/schemas/ApiError" } } }
        "429":
          description: "HOLD_LIMIT_EXCEEDED — the per-shopper hold ceiling of the Booking module."
          content: { application/json: { schema: { $ref: "#/components/schemas/ApiError" } } }
  /api/v1/commerce/booking/reservations:
    post:
      operationId: createCommerceBookingReservation
      x-awcms-draft: true
      tags: [Commerce]
      summary: "Staff or till variant of the same operation. Gated on commerce.booking_reservation_links.create (a till sale also needs commerce.pos.create and an own open register session). The request adds guest contact fields exactly as the existing POS order does."
      parameters:
        - $ref: "#/components/parameters/IdempotencyKey"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              allOf:
                - $ref: "#/components/schemas/CommerceBookingReservationCreate"
                - type: object
                  properties:
                    registerSessionId: { type: string, format: uuid, description: "Required for a till sale; must be the caller's own open session." }
      responses:
        "201":
          description: Reservation held and order created.
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, enum: [true] }
                  data: { $ref: "#/components/schemas/CommerceBookingReservationCreated" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "409":
          description: "As the storefront route."
          content: { application/json: { schema: { $ref: "#/components/schemas/ApiError" } } }
components:
  schemas:
    CommerceBookingReservationCreate:
      type: object
      required: [offeringId, partySize]
      description: >-
        Exactly one of `stay` and `startsAt`, by the offering's granularity. `stay`
        carries local dates in the resource's zone (ADR-0135); an instant for a stay is
        refused. No amount, price, deposit or customer id is accepted.
      properties:
        offeringId: { type: string, format: uuid }
        resourceId: { type: string, format: uuid }
        startsAt: { type: string, format: date-time }
        stay:
          type: object
          required: [checkInDate, checkOutDate]
          properties:
            checkInDate: { type: string, format: date }
            checkOutDate: { type: string, format: date }
        partySize: { type: integer, minimum: 1 }
        guest:
          type: object
          description: "Commerce order guest fields; required for an anonymous request, ignored when a valid customerBearer is presented."
          properties:
            name: { type: string }
            phone: { type: string }
        payment:
          type: object
          properties:
            method: { type: string, description: "As the existing storefront order payment method, including gateway." }
    CommerceBookingReservationCreated:
      type: object
      properties:
        replayed: { type: boolean }
        orderId: { type: string, format: uuid }
        orderCode: { type: string }
        reservation:
          type: object
          properties:
            id: { type: string, format: uuid }
            reservationNo: { type: string }
            status: { type: string, enum: [held, confirmed] }
            holdExpiresAt: { type: string, format: date-time, nullable: true }
            startsAt: { type: string, format: date-time }
            endsAt: { type: string, format: date-time }
            stays:
              type: array
              description: "Present for a stay; mirrors the Booking event's additive field."
              items:
                type: object
                properties:
                  resourceId: { type: string, format: uuid }
                  checkInDate: { type: string, format: date }
                  checkOutDate: { type: string, format: date }
                  nights: { type: integer }
                  timezone: { type: string }
        settlement: { $ref: "#/components/schemas/CommerceBookingSettlement" }
```

### 3.3 Sesi deposit (ADR-0041)

Rute 6 adalah perubahan aditif pada `createCommerceStorefrontPaymentGatewaySession` yang sudah ada: `purpose` bawaannya `full`, sehingga semua pemanggil yang ada tidak berubah (ADR-0041 D3). Klien meminta "bayar deposit" atau "bayar pelunasan" dan tidak mengirim jumlah.

```yaml
# DRAFT — not in the live spec. Amendment to an existing live operation, shown as the delta.
paths:
  /api/v1/commerce/storefront/orders/{orderCode}/payment-gateway/sessions:
    post:
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                phone:
                  {
                    type: string,
                    description: "Required unless a valid customerBearer is presented instead (unchanged).",
                  }
                purpose:
                  type: string
                  enum: [full, deposit, balance]
                  default: full
                  description: >-
                    full: only while settled = 0. deposit: only on a down-payment order
                    still below its release threshold. balance: only on a down-payment
                    order that has reached the threshold and is below the total. A
                    whole-total order can never obtain deposit or balance.
      responses:
        "201":
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: object
                    properties:
                      redirectUrl: { type: string }
                      expiresAt: { type: string, format: date-time }
                      providerRef: { type: string }
                      purpose: { type: string, enum: [full, deposit, balance] }
                      expectedAmount:
                        {
                          type: string,
                          description: "numeric(14,2), computed by the server inside the order lock; exactly the gross_amount sent to the provider.",
                        }
        "409":
          description: >-
            Existing codes unchanged (PAYMENT_NOT_APPLICABLE, ORDER_PARTIALLY_SETTLED for a
            `full` session) plus PURPOSE_NOT_ALLOWED (the order's state does not admit
            that purpose; `details.allowed` lists the permitted ones).
  /api/v1/commerce/orders/{id}/payment-gateway/sessions:
    post:
      operationId: createCommerceOrderPaymentGatewaySession
      x-awcms-draft: true
      tags: [Commerce]
      summary: "Staff-started deposit or balance session, handed to the guest as a link. Gated on commerce.payments.create; requires Idempotency-Key. Staff still cannot type a `gateway` tender (ADR-0025 D7); this route goes through the gateway port."
      description: >-
        At most one live session per order (ADR-0041 D5.1): while one is `created` or
        `pending` the same session is returned. The expected amount is fixed in a first
        short transaction under the order lock; the provider is called with no
        transaction open; the result is persisted in a second one.
      parameters:
        - {
            name: id,
            in: path,
            required: true,
            schema: { type: string, format: uuid },
          }
        - $ref: "#/components/parameters/IdempotencyKey"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [purpose]
              properties:
                purpose: { type: string, enum: [deposit, balance] }
      responses:
        "201":
          description: Session created, or the still-live one returned.
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, enum: [true] }
                  data:
                    type: object
                    properties:
                      redirectUrl: { type: string }
                      expiresAt: { type: string, format: date-time }
                      providerRef: { type: string }
                      purpose: { type: string, enum: [deposit, balance] }
                      expectedAmount: { type: string }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "409":
          description: "PURPOSE_NOT_ALLOWED or IDEMPOTENCY_CONFLICT."
          content:
            {
              application/json:
                { schema: { $ref: "#/components/schemas/ApiError" } },
            }
        "503":
          description: "GATEWAY_UNAVAILABLE, as the existing session route."
          content:
            {
              application/json:
                { schema: { $ref: "#/components/schemas/ApiError" } },
            }
```

Penjaga webhook dan rekonsiliasi (`checkPaymentAmount`) bukan perubahan kontrak HTTP: ia membandingkan angka penyedia dengan `expected_amount` sesi dalam sen bulat (ADR-0041 D2), dan leg `deposit` atau `balance` yang terverifikasi dicatat dengan `expected_amount` sesi di bawah kunci sumber `gateway:{provider}:{ref}` yang sudah ada. Path webhook publik dan payload-nya tidak berubah.

### 3.4 Tampilan pelunasan pesanan

Objek pelunasan adalah `CommerceSettlement` turunan yang sudah ada, dibuat sadar-deposit (ADR-0041 D6). Tidak ada yang disimpan terpisah; semuanya dihitung dari buku besar. Kolom tambahan bersifat aditif dan null atau sama dengan `total` pada pesanan total utuh.

```yaml
# DRAFT — not in the live spec.
components:
  schemas:
    CommerceBookingSettlement:
      description: "CommerceSettlement plus the ADR-0041 D6 deposit fields. Derived from the allocation ledger on every read."
      allOf:
        - $ref: "#/components/schemas/CommerceSettlement"
        - type: object
          properties:
            deposit:
              {
                type: string,
                description: "The order's snapshotted dp_amount (the release threshold). Equals total on a whole-total order.",
              }
            balanceDue:
              {
                type: string,
                description: "total minus settled, never negative.",
              }
            settledAt:
              {
                type: string,
                format: date-time,
                nullable: true,
                description: "Set once outstanding is zero: the settled time of the ledger leg that got it there.",
              }
paths:
  /api/v1/commerce/booking/reservations/{id}:
    get:
      operationId: getCommerceBookingReservation
      x-awcms-draft: true
      tags: [Commerce]
      summary: "A reservation link with its order code, its derived settlement and any attention flag. Gated on commerce.booking_reservation_links.read; a cashier is limited to the order of their own open register session."
      parameters:
        - {
            name: id,
            in: path,
            required: true,
            schema: { type: string, format: uuid },
            description: "The reservation id (Booking's), resolved to its active link.",
          }
      responses:
        "200":
          description: The reservation.
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, enum: [true] }
                  data:
                    {
                      $ref: "#/components/schemas/CommerceBookingReservationView",
                    }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
  /api/v1/commerce/storefront/booking/reservations/{orderCode}:
    get:
      operationId: getCommerceStorefrontBookingReservation
      x-awcms-draft: true
      tags: [Commerce]
      summary: "A shopper's own reservation: status, dates, and 'Deposit paid Rp X, balance due Rp Y' from the settlement. Anonymous; identified by customerBearer or by the order's phone."
      security: [{}, { customerBearer: [] }]
      parameters:
        - {
            name: orderCode,
            in: path,
            required: true,
            schema: { type: string },
          }
        - {
            name: phone,
            in: query,
            required: false,
            schema: { type: string },
            description: "Required unless a valid customerBearer is presented.",
          }
      responses:
        "200":
          description: The reservation view without staff-only fields (no attention flag, no decision internals beyond the refund amount).
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, enum: [true] }
                  data:
                    {
                      $ref: "#/components/schemas/CommerceBookingReservationView",
                    }
        "401":
          description: "UNAUTHENTICATED — a bearer was presented but is not a live customer session."
          content:
            {
              application/json:
                { schema: { $ref: "#/components/schemas/ApiError" } },
            }
        "404":
          description: "An unknown code and another customer's code are indistinguishable."
          content:
            {
              application/json:
                { schema: { $ref: "#/components/schemas/ApiError" } },
            }
components:
  schemas:
    CommerceBookingReservationView:
      type: object
      properties:
        reservationId: { type: string, format: uuid }
        reservationNo: { type: string }
        orderId: { type: string, format: uuid }
        orderCode: { type: string }
        status:
          {
            type: string,
            enum:
              [
                held,
                confirmed,
                rescheduled,
                cancelled,
                checked_in,
                completed,
                no_show,
                expired,
              ],
          }
        linkStatus: { type: string, enum: [active, superseded, released] }
        startsAt: { type: string, format: date-time }
        endsAt: { type: string, format: date-time }
        stays: { type: array, items: { type: object } }
        settlement: { $ref: "#/components/schemas/CommerceBookingSettlement" }
        attentionReason:
          {
            type: string,
            enum: [deposit_after_expiry, confirm_failed],
            nullable: true,
            description: "Staff route only.",
          }
        refund:
          type: object
          nullable: true
          description: "Present once a cancellation or no-show decision exists."
          properties:
            finalRefund: { type: string }
            overridden: { type: boolean }
```

### 3.5 Kutipan dan konfirmasi pembatalan

Kutipan adalah pembacaan dan tidak menulis apa pun. Rute pembatalan menghitung ulang refund di bawah kunci pesanan dan, bila pembeli menyetujui angka yang kini tidak cocok (kebijakan diaktifkan di antaranya, atau pembayaran dibalik), menolak dengan `409 QUOTE_CHANGED` beserta angka baru, alih-alih me-refund jumlah yang berbeda dari yang disetujui pembeli. Tidak ada jumlah dari klien yang menetapkan refund; `acknowledgedRefund` dibandingkan, tidak pernah disimpan sebagai refund.

```yaml
# DRAFT — not in the live spec.
paths:
  /api/v1/commerce/booking/reservations/{id}/cancellation-quote:
    get:
      operationId: getCommerceBookingCancellationQuote
      x-awcms-draft: true
      tags: [Commerce]
      summary: "Non-binding quote: which policy applies, how many whole hours before arrival, and the computed refund. Gated on commerce.booking_reservation_links.read. Writes nothing."
      parameters:
        - {
            name: id,
            in: path,
            required: true,
            schema: { type: string, format: uuid },
          }
      responses:
        "200":
          description: The quote.
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, enum: [true] }
                  data:
                    {
                      $ref: "#/components/schemas/CommerceBookingCancellationQuote",
                    }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "409":
          description: "INVALID_STATE — the reservation is already cancelled, completed, expired or has a decision."
          content:
            {
              application/json:
                { schema: { $ref: "#/components/schemas/ApiError" } },
            }
  /api/v1/commerce/storefront/booking/reservations/{orderCode}/cancellation-quote:
    get:
      operationId: getCommerceStorefrontBookingCancellationQuote
      x-awcms-draft: true
      tags: [Commerce]
      summary: "The same quote for a shopper's own reservation (customerBearer or the order's phone)."
      security: [{}, { customerBearer: [] }]
      parameters:
        - {
            name: orderCode,
            in: path,
            required: true,
            schema: { type: string },
          }
        - { name: phone, in: query, required: false, schema: { type: string } }
      responses:
        "200":
          description: The quote.
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, enum: [true] }
                  data:
                    {
                      $ref: "#/components/schemas/CommerceBookingCancellationQuote",
                    }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404": { $ref: "#/components/responses/NotFound" }
        "409":
          {
            description: "INVALID_STATE.",
            content:
              {
                application/json:
                  { schema: { $ref: "#/components/schemas/ApiError" } },
              },
          }
  /api/v1/commerce/booking/reservations/{id}/cancel:
    post:
      operationId: cancelCommerceBookingReservation
      x-awcms-draft: true
      tags: [Commerce]
      summary: "Cancel a held or confirmed reservation and record the refund decision (computed refund; legs ride a return under ADR-0033). Gated on commerce.booking_reservation_links.cancel and commerce.booking_refund_decisions.create; requires Idempotency-Key."
      description: >-
        Order of work: the Booking port cancel (idempotent), then the decision row
        (`UNIQUE (tenant_id, reservation_link_id)`, source key
        `booking-cancel:<reservation_id>`), then the refund legs by the system
        actor. A replay finds the same decision and refunds nothing twice. The
        optional `override` makes the final refund differ from the computed one and is
        accepted only from a caller who also holds
        `commerce.booking_refund_overrides.approve` with a fresh step-up (see 3.6);
        otherwise it is `403`. Without it, `final_refund = computed_refund`.
      parameters:
        - {
            name: id,
            in: path,
            required: true,
            schema: { type: string, format: uuid },
          }
        - $ref: "#/components/parameters/IdempotencyKey"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [reasonCode]
              properties:
                reasonCode:
                  {
                    type: string,
                    description: "A closed short code, never free text about a person.",
                  }
                override:
                  { $ref: "#/components/schemas/CommerceBookingRefundOverride" }
      responses:
        "200":
          description: Cancelled; the decision.
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, enum: [true] }
                  data:
                    {
                      $ref: "#/components/schemas/CommerceBookingRefundDecision",
                    }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403":
          description: "FORBIDDEN, or — when an override is sent — STEP_UP_REQUIRED (see 3.6)."
          content:
            {
              application/json:
                { schema: { $ref: "#/components/schemas/ApiError" } },
            }
        "404": { $ref: "#/components/responses/NotFound" }
        "409":
          description: "INVALID_STATE, OVERRIDE_EXCEEDS_PAID or IDEMPOTENCY_CONFLICT."
          content:
            {
              application/json:
                { schema: { $ref: "#/components/schemas/ApiError" } },
            }
  /api/v1/commerce/storefront/booking/reservations/{orderCode}/cancel:
    post:
      operationId: cancelCommerceStorefrontBookingReservation
      x-awcms-draft: true
      tags: [Commerce]
      summary: "The shopper confirms a quoted cancellation of their own reservation. Anonymous with customerBearer or phone; requires Idempotency-Key. A cashier or scheduler cannot use this route; it never accepts an override."
      security: [{}, { customerBearer: [] }]
      parameters:
        - {
            name: orderCode,
            in: path,
            required: true,
            schema: { type: string },
          }
        - $ref: "#/components/parameters/IdempotencyKey"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [acknowledgedRefund]
              properties:
                phone: { type: string }
                acknowledgedRefund:
                  {
                    type: string,
                    description: "The quote's computedRefund the shopper saw. Compared with the figure recomputed under the order lock; never used as the refund.",
                  }
      responses:
        "200":
          description: Cancelled; the shopper-visible decision (amount only).
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, enum: [true] }
                  data:
                    type: object
                    properties:
                      status: { type: string, enum: [cancelled] }
                      finalRefund: { type: string }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404": { $ref: "#/components/responses/NotFound" }
        "409":
          description: "QUOTE_CHANGED (`details.computedRefund` carries the new figure; nothing was cancelled), INVALID_STATE or IDEMPOTENCY_CONFLICT."
          content:
            {
              application/json:
                { schema: { $ref: "#/components/schemas/ApiError" } },
            }
components:
  schemas:
    CommerceBookingCancellationQuote:
      type: object
      properties:
        quotedAt: { type: string, format: date-time }
        hoursBeforeStart:
          {
            type: integer,
            description: "Whole hours, floored; negative after arrival.",
          }
        policySource: { type: string, enum: [product, tenant_default, none] }
        policyId: { type: string, format: uuid, nullable: true }
        policyVersion: { type: integer, nullable: true }
        refundBasis: { type: string, enum: [whole_stay, per_night] }
        refundablePercent: { type: string }
        amountPaid:
          {
            type: string,
            description: "Σ succeeded payments − Σ succeeded reversals (ADR-0025 D1): the ceiling for any refund.",
          }
        computedRefund: { type: string }
    CommerceBookingRefundDecision:
      type: object
      properties:
        id: { type: string, format: uuid }
        triggerKind:
          { type: string, enum: [customer_cancel, staff_cancel, no_show] }
        policySource: { type: string, enum: [product, tenant_default, none] }
        amountPaid: { type: string }
        computedRefund: { type: string }
        finalRefund: { type: string }
        overridden: { type: boolean }
        returnId:
          {
            type: string,
            format: uuid,
            nullable: true,
            description: "Set once the refund legs are planned; null while no money moves.",
          }
```

### 3.6 Override refund (manajer atau keuangan, step-up)

```yaml
# DRAFT — not in the live spec.
paths:
  /api/v1/commerce/booking/reservations/{id}/refund-override:
    post:
      operationId: overrideCommerceBookingRefund
      x-awcms-draft: true
      tags: [Commerce]
      summary: "Set the final refund of a decision to an amount other than the policy-computed one. Gated on commerce.booking_refund_overrides.approve (high-risk approve) AND a fresh step-up; mandatory reason; critical audit event; never above the amount paid. Requires Idempotency-Key."
      description: >-
        The only route that may write `final_refund <> computed_refund`. It amends a
        decision whose refund legs are not yet planned (`return_id` null); once legs
        exist it is `409 DECISION_ALREADY_EXECUTED`. The step-up proof is checked
        in the handler through the platform's existing `evaluateStepUp`; its
        acceptance time is stored as `override_stepup_at`. A stale or absent proof
        answers `403 STEP_UP_REQUIRED` with a challenge hint and changes nothing;
        it is never a silent allow. The override chooses an amount; it moves no
        money, and the legs still run under the system actor (ADR-0033). Approving an
        offline settlement (`commerce.refunds_offline.approve`) is a different
        authority and does not imply this one.
      parameters:
        - {
            name: id,
            in: path,
            required: true,
            schema: { type: string, format: uuid },
          }
        - $ref: "#/components/parameters/IdempotencyKey"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/CommerceBookingRefundOverride"
      responses:
        "200":
          description: The amended decision. A replay with the same key and body returns the same row.
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, enum: [true] }
                  data:
                    {
                      $ref: "#/components/schemas/CommerceBookingRefundDecision",
                    }
        "400":
          description: "VALIDATION_ERROR — reason shorter than 10 or longer than 500 characters, or matching a personal-data pattern the order-note validator already rejects; finalRefund not a numeric(14,2) string."
          content:
            {
              application/json:
                { schema: { $ref: "#/components/schemas/ApiError" } },
            }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403":
          description: >-
            FORBIDDEN (the caller lacks the permission; a cashier, scheduler and a
            holder of refunds_offline.approve alone all get this, and no decision row
            is written) or STEP_UP_REQUIRED (the caller has the permission but the
            session has no fresh step-up; `details.challenge` points at
            POST /api/v1/auth/mfa/step-up).
          content:
            {
              application/json:
                { schema: { $ref: "#/components/schemas/ApiError" } },
            }
        "404": { $ref: "#/components/responses/NotFound" }
        "409":
          description: "OVERRIDE_EXCEEDS_PAID (finalRefund above the recomputed amount paid), DECISION_ALREADY_EXECUTED, or IDEMPOTENCY_CONFLICT."
          content:
            {
              application/json:
                { schema: { $ref: "#/components/schemas/ApiError" } },
            }
components:
  schemas:
    CommerceBookingRefundOverride:
      type: object
      required: [finalRefund, reason]
      properties:
        finalRefund:
          {
            type: string,
            description: "numeric(14,2); 0 up to the amount paid.",
          }
        reason: { type: string, minLength: 10, maxLength: 500 }
```

### 3.7 Reschedule

Adapter memanggil `BookingPort.reschedule` (satu transaksi di sisi Booking: lepas, ganti, gantikan), lalu menggantikan tautan reservasi lama dengan yang baru yang menunjuk reservasi baru. Adapter tidak menyimpan selisih harga (Q4). Selisih dihargai oleh jalur pesanan dan dikembalikan sebagai penunjuk.

```yaml
# DRAFT — not in the live spec.
paths:
  /api/v1/commerce/booking/reservations/{id}/reschedule:
    post:
      operationId: rescheduleCommerceBookingReservation
      x-awcms-draft: true
      tags: [Commerce]
      summary: "Move a held or confirmed reservation to new dates or a new start. Gated on commerce.booking_reservation_links.update; requires Idempotency-Key. The price difference is computed by the order path, not here."
      description: >-
        A refusal (SLOT_UNAVAILABLE and the other Booking refusals) rolls back to
        the untouched original, on both sides. On success the old link becomes
        `superseded` and the new one `active` with `supersedes_link_id` set. A
        customer-initiated reschedule is a request that staff completes; the shopper
        has no direct route in v1.
      parameters:
        - {
            name: id,
            in: path,
            required: true,
            schema: { type: string, format: uuid },
          }
        - $ref: "#/components/parameters/IdempotencyKey"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              description: "Exactly one of startsAt and stay, as on creation."
              properties:
                startsAt: { type: string, format: date-time }
                stay:
                  type: object
                  required: [checkInDate, checkOutDate]
                  properties:
                    checkInDate: { type: string, format: date }
                    checkOutDate: { type: string, format: date }
      responses:
        "200":
          description: Rescheduled.
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, enum: [true] }
                  data:
                    type: object
                    properties:
                      reservationId:
                        {
                          type: string,
                          format: uuid,
                          description: "The replacement reservation.",
                        }
                      supersededReservationId: { type: string, format: uuid }
                      priceDifference:
                        type: object
                        properties:
                          direction:
                            { type: string, enum: [charge, refund, none] }
                          amount:
                            {
                              type: string,
                              description: "Priced by the order path (nights x unit price, tax, discounts), never by Booking.",
                            }
                          vehicle:
                            {
                              type: string,
                              enum: [supplementary_order, order_line],
                              description: "OPEN: see section 7 point 4.",
                            }
                          orderCode: { type: string, nullable: true }
                      settlement:
                        {
                          $ref: "#/components/schemas/CommerceBookingSettlement",
                        }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "409":
          description: "A Booking refusal under its own code, INVALID_STATE, or IDEMPOTENCY_CONFLICT."
          content:
            {
              application/json:
                { schema: { $ref: "#/components/schemas/ApiError" } },
            }
```

### 3.8 No-show

```yaml
# DRAFT — not in the live spec.
paths:
  /api/v1/commerce/booking/reservations/{id}/no-show:
    post:
      operationId: markCommerceBookingNoShow
      x-awcms-draft: true
      tags: [Commerce]
      summary: "Mark a confirmed reservation no-show (after arrival plus grace, measured by Booking) and apply the policy's no_show_retention rule. Gated on commerce.booking_reservation_links.cancel and commerce.booking_refund_decisions.create; requires Idempotency-Key."
      description: >-
        `retain_deposit` keeps the deposit already paid and refunds nothing;
        `retain_all` refunds nothing; `refund_per_windows` evaluates the cancellation
        windows at the arrival instant. The decision uses `trigger_kind = 'no_show'`
        and `hours_before_start` may be negative. Booking's own `no_show` transition
        is a person's act and is not driven by this route alone: the adapter marks it
        through the Booking module's admin action, and then records the decision.
        A cashier cannot call this route.
      parameters:
        - {
            name: id,
            in: path,
            required: true,
            schema: { type: string, format: uuid },
          }
        - $ref: "#/components/parameters/IdempotencyKey"
      responses:
        "200":
          description: Marked no-show; the decision (finalRefund is 0 under retain_deposit and retain_all).
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, enum: [true] }
                  data:
                    {
                      $ref: "#/components/schemas/CommerceBookingRefundDecision",
                    }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "409":
          description: "INVALID_STATE (not confirmed, or the grace has not elapsed) or IDEMPOTENCY_CONFLICT."
          content:
            {
              application/json:
                { schema: { $ref: "#/components/schemas/ApiError" } },
            }
```

### 3.9 Check-in POS dengan pemungutan pelunasan

Kasir menerima pelunasan sebagai leg buku besar biasa di sesi register **miliknya sendiri** yang terbuka (semantik `commerce.payments.create` yang ada: `cash`, `manual_qris`, `manual_bank_transfer`, `gift_card`, `store_credit`; tender `gateway` tidak bisa diketik). Penukaran poin dan deposit tidak pernah berbagi pesanan (ADR-0041 D8), jadi tidak ada kolom penukaran di sini.

```yaml
# DRAFT — not in the live spec.
paths:
  /api/v1/commerce/pos/booking/reservations/{id}/check-in:
    post:
      operationId: checkInCommerceBookingReservationAtPos
      x-awcms-draft: true
      tags: [Commerce]
      summary: "Collect the outstanding balance at the till and check the guest in. Gated on commerce.pos.create, commerce.payments.create and commerce.booking_reservation_links.read; the register session must be the caller's own and open. Requires Idempotency-Key."
      description: >-
        Each payment is recorded exactly as `recordCommerceOrderPayment` records one
        (order row locked, `409 OVERPAYMENT` on a second final payment, change derived
        server-side for cash). Booking's `checked_in` transition is requested through
        the Booking admin action after the legs commit. Whether check-in may proceed
        with a balance still due is a tenant decision (section 7 point 5); the draft
        returns `409 BALANCE_NOT_SETTLED` only when the tenant requires settlement.
        A cashier can read the reservation to take its balance but cannot cancel,
        reschedule or resolve it.
      parameters:
        - {
            name: id,
            in: path,
            required: true,
            schema: { type: string, format: uuid },
          }
        - $ref: "#/components/parameters/IdempotencyKey"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [registerSessionId]
              properties:
                registerSessionId: { type: string, format: uuid }
                payments:
                  type: array
                  description: "Zero or more tender legs; amount is what the customer handed over for cash."
                  items:
                    type: object
                    required: [tenderType, amount]
                    properties:
                      tenderType:
                        {
                          type: string,
                          enum:
                            [
                              cash,
                              manual_qris,
                              manual_bank_transfer,
                              gift_card,
                              store_credit,
                            ],
                        }
                      amount: { type: string }
      responses:
        "200":
          description: Balance recorded and guest checked in.
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, enum: [true] }
                  data:
                    type: object
                    properties:
                      checkedIn: { type: boolean }
                      change:
                        {
                          type: string,
                          description: "Cash change, derived by the server.",
                        }
                      settlement:
                        {
                          $ref: "#/components/schemas/CommerceBookingSettlement",
                        }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "409":
          description: "OVERPAYMENT, REGISTER_SESSION_NOT_OWN_OR_CLOSED, BALANCE_NOT_SETTLED, INVALID_STATE or IDEMPOTENCY_CONFLICT."
          content:
            {
              application/json:
                { schema: { $ref: "#/components/schemas/ApiError" } },
            }
```

## 4. Kode galat yang diperkenalkan draf

Penolakan Booking mempertahankan kode yang diberikan Booking (gabungan akhir ditetapkan PR implementasi Booking, yang juga menetapkan enumerasi `ErrorCode` OpenAPI; cross-domain-contracts bagian 3). Kode milik adapter adalah usulan:

| Kode                                                | HTTP | Arti                                                                                                                                 |
| --------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `OFFERING_NOT_LINKED`                               | 409  | Offering tidak punya tautan aktif ke produk                                                                                          |
| `OFFERING_ALREADY_LINKED`, `PRODUCT_ALREADY_LINKED` | 409  | Satu tautan aktif per offering dan per produk                                                                                        |
| `PRODUCT_NOT_SERVICE`, `QUANTITY_BASIS_MISMATCH`    | 409  | Produk tertaut bukan `service`, atau `quantityBasis` tidak sesuai granularitas offering                                              |
| `POINTS_DEPOSIT_NOT_COMBINABLE`                     | 409  | ADR-0041 D8; kode stabilnya "ditetapkan di isu implementasi", nama ini usulan                                                        |
| `PURPOSE_NOT_ALLOWED`                               | 409  | Sesi `deposit` atau `balance` pada pesanan yang status atau kebijakan depositnya tidak mengizinkan (ADR-0041 D1, D3)                 |
| `QUOTE_CHANGED`                                     | 409  | Refund yang dihitung ulang berbeda dari angka yang disetujui pembeli; tidak ada yang dibatalkan                                      |
| `OVERRIDE_EXCEEDS_PAID`                             | 409  | `finalRefund` di atas jumlah terbayar yang dihitung ulang                                                                            |
| `DECISION_ALREADY_EXECUTED`                         | 409  | Leg refund keputusan sudah direncanakan; jumlahnya tidak bisa berubah lagi                                                           |
| `STEP_UP_REQUIRED`                                  | 403  | Kode identity-access yang sudah ada; di sini pertama kali dipakai commerce. Pemanggil memegang izin tetapi tidak punya step-up segar |
| `BALANCE_NOT_SETTLED`                               | 409  | Tenant mewajibkan pelunasan sebelum check-in                                                                                         |
| `INVALID_STATE`, `IDEMPOTENCY_CONFLICT`             | 409  | Kode Booking, diteruskan tanpa perubahan                                                                                             |

## 5. Draf AsyncAPI 3.0

Kedua blok memakai ulang `DomainEventEnvelope` live (`apps/cms/asyncapi/awcms-domain-events.asyncapi.yaml`). Keduanya draf: tidak ada yang ditambahkan ke berkas itu atau ke `DOMAIN_EVENT_TYPE_REGISTRY`, dan berkas Booking provisional tidak disunting di sini.

### 5.1 Event yang dikonsumsi adapter

Sembilan event provisional Booking berbagi satu payload dan **tidak membawa pelanggan, kontak, jumlah, maupun status pembayaran**. Adapter menurunkan pelanggan lewat pesanan, tidak pernah dari event (temuan X7). Setelah [ADR-0135](https://github.com/ahliweb/awcms/blob/main/docs/adr/0135-day-granularity-stays-admitted-into-booking-v1.md) reservasi dengan item menginap menambah `stays[]` aditif (`resourceId`, `checkInDate`, `checkOutDate`, `nights`, `timezone`) pada payload setiap event; `startsAt` dan `endsAt` adalah saat kedatangan paling awal dan keberangkatan paling akhir. Adapter harus menoleransi ketidakhadirannya (reservasi slot) dan kolom tambahan yang tak dikenal. Adapter juga mengonsumsi satu event modulnya sendiri, `awcms.commerce.order.paid`, untuk konfirmasi.

Di bawah [ADR-0134](https://github.com/ahliweb/awcms/blob/main/docs/adr/0134-descriptor-declared-domain-event-consumers.md) tiap konsumen dideklarasikan di `domainEventConsumers` deskriptor modul commerce; nama di bawah adalah usulan dan akan menjadi kunci baris pengiriman dan buku efek, sehingga tidak boleh berubah setelah dipilih. `runtime_effect_once` berarti registri membungkus `handle` dan kode commerce tidak pernah memanggil helper efek-sekali; `self_managed` berarti konsumen menjaga kunci alaminya sendiri.

```yaml
# DRAFT — not in the live spec.
asyncapi: 3.0.0
info:
  title: Booking-commerce adapter — consumed events (DRAFT)
  version: 0.0.0
  x-awcms-status: draft
channels:
  awcms.booking.reservation.confirmed:
    address: awcms.booking.reservation.confirmed
    messages:
      {
        BookingReservationConfirmed:
          { $ref: "#/components/messages/BookingReservationEvent" },
      }
  awcms.booking.reservation.cancelled:
    address: awcms.booking.reservation.cancelled
    messages:
      {
        BookingReservationCancelled:
          { $ref: "#/components/messages/BookingReservationEvent" },
      }
  awcms.booking.reservation.expired:
    address: awcms.booking.reservation.expired
    messages:
      {
        BookingReservationExpired:
          { $ref: "#/components/messages/BookingReservationEvent" },
      }
  awcms.booking.reservation.rescheduled:
    address: awcms.booking.reservation.rescheduled
    messages:
      {
        BookingReservationRescheduled:
          { $ref: "#/components/messages/BookingReservationEvent" },
      }
  awcms.booking.reservation.checked_in:
    address: awcms.booking.reservation.checked_in
    messages:
      {
        BookingReservationCheckedIn:
          { $ref: "#/components/messages/BookingReservationEvent" },
      }
  awcms.booking.reservation.completed:
    address: awcms.booking.reservation.completed
    messages:
      {
        BookingReservationCompleted:
          { $ref: "#/components/messages/BookingReservationEvent" },
      }
  awcms.booking.reservation.no_show:
    address: awcms.booking.reservation.no_show
    messages:
      {
        BookingReservationNoShow:
          { $ref: "#/components/messages/BookingReservationEvent" },
      }
  awcms.commerce.order.paid:
    address: awcms.commerce.order.paid
    messages: { OrderPaid: { $ref: "#/components/messages/CommerceOrderPaid" } }
operations:
  onBookingExpiredCancelPendingOrder:
    action: receive
    x-awcms-consumer: commerce.booking_expired_order_canceller
    x-awcms-idempotency: runtime_effect_once
    channel: { $ref: "#/channels/awcms.booking.reservation.expired" }
  onBookingCancelledCancelPendingOrder:
    action: receive
    x-awcms-consumer: commerce.booking_cancelled_order_canceller
    x-awcms-idempotency: runtime_effect_once
    channel: { $ref: "#/channels/awcms.booking.reservation.cancelled" }
  onBookingCancelledCoordinateRefund:
    action: receive
    x-awcms-consumer: commerce.booking_cancelled_refund_coordinator
    x-awcms-idempotency: self_managed
    channel: { $ref: "#/channels/awcms.booking.reservation.cancelled" }
  onOrderPaidConfirmReservation:
    action: receive
    x-awcms-consumer: commerce.booking_order_paid_confirmer
    x-awcms-idempotency: self_managed
    channel: { $ref: "#/channels/awcms.commerce.order.paid" }
  onBookingRescheduledRepointLink:
    action: receive
    x-awcms-consumer: commerce.booking_rescheduled_link_reconciler
    x-awcms-idempotency: runtime_effect_once
    channel: { $ref: "#/channels/awcms.booking.reservation.rescheduled" }
  onBookingNoShowRecordDecision:
    action: receive
    x-awcms-consumer: commerce.booking_no_show_decision_recorder
    x-awcms-idempotency: self_managed
    channel: { $ref: "#/channels/awcms.booking.reservation.no_show" }
components:
  messages:
    BookingReservationEvent:
      contentType: application/json
      payload:
        allOf:
          - $ref: "#/components/schemas/DomainEventEnvelope"
          - type: object
            properties:
              aggregateType: { const: reservation }
              payload:
                { $ref: "#/components/schemas/BookingReservationPayload" }
    CommerceOrderPaid:
      contentType: application/json
      payload: { $ref: "#/components/schemas/DomainEventEnvelope" }
  schemas:
    BookingReservationPayload:
      description: "Upstream provisional schema, restated with the ADR-0135 additive field. Owned by booking; if it differs from the upstream file, upstream wins."
      type: object
      required:
        [
          reservationId,
          reservationNo,
          lineageId,
          status,
          previousStatus,
          startsAt,
          endsAt,
          resourceIds,
          offeringIds,
          partySize,
          occurredAt,
        ]
      properties:
        reservationId: { type: string, format: uuid }
        reservationNo: { type: string }
        lineageId: { type: string, format: uuid }
        status:
          {
            type: string,
            enum:
              [
                held,
                confirmed,
                rescheduled,
                cancelled,
                checked_in,
                completed,
                no_show,
                expired,
              ],
          }
        previousStatus: { type: [string, "null"] }
        startsAt: { type: string, format: date-time }
        endsAt: { type: string, format: date-time }
        resourceIds: { type: array, items: { type: string, format: uuid } }
        offeringIds: { type: array, items: { type: string, format: uuid } }
        partySize: { type: integer, minimum: 1 }
        externalRefType:
          {
            type: [string, "null"],
            description: "The adapter's own opaque pair; commerce_order.",
          }
        externalRef: { type: [string, "null"], description: "The order id." }
        lateCancellation: { type: boolean }
        supersededById: { type: string, format: uuid }
        rescheduledFromId: { type: string, format: uuid }
        stays:
          type: array
          description: "ADR-0135, additive; absent for slot reservations."
          items:
            type: object
            required: [resourceId, checkInDate, checkOutDate, nights, timezone]
            properties:
              resourceId: { type: string, format: uuid }
              checkInDate: { type: string, format: date }
              checkOutDate: { type: string, format: date }
              nights: { type: integer, minimum: 1 }
              timezone: { type: string }
        occurredAt: { type: string, format: date-time }
        correlationId: { type: string }
```

Apa yang dilakukan tiap konsumen, dan jebakan yang harus dihindarinya:

| Konsumen (nama usulan)                          | Event                        | Efek                                                                                                                                                                          | Idempotensi dan aturan                                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commerce.booking_order_paid_confirmer`         | `awcms.commerce.order.paid`  | Untuk pesanan dengan tautan reservasi aktif, `BookingPort.confirm`. Pada penolakan (`HOLD_EXPIRED`) setel `attention_reason` dan jangan menggagalkan pengiriman berulang kali | `self_managed`: confirm idempoten lewat kunci port (`confirm:<reservation_id>`). Pesanan deposit mencapai `paid` pada deposit (ADR-0041 D6), sehingga reservasi terkonfirmasi saat deposit, bukan saat pelunasan penuh                                                                  |
| `commerce.booking_expired_order_canceller`      | `...reservation.expired`     | Batalkan pesanan yang **pending** yang disebut `externalRef`                                                                                                                  | `runtime_effect_once`. **Pesanan yang sudah menerima uang tidak pernah dibatalkan oleh kedaluwarsa** (ADR-0025 "Perubahan perilaku"): tandai `attention_reason = 'deposit_after_expiry'` untuk operator alih-alih diam-diam mengonfirmasi slot yang sudah dilepas (ADR-0041 D5.5)       |
| `commerce.booking_cancelled_order_canceller`    | `...reservation.cancelled`   | Batalkan pesanan pending bila belum ada uang diterima                                                                                                                         | `runtime_effect_once`; tidak melakukan apa-apa bila pesanan memegang pembayaran                                                                                                                                                                                                         |
| `commerce.booking_cancelled_refund_coordinator` | `...reservation.cancelled`   | Bila pembatalan **tidak** berasal dari adapter ini (pembatalan di sisi Booking) dan uang sudah dibayar, buat keputusan dan permintaan refund                                  | `self_managed`; kunci alaminya `source_key` keputusan `booking-cancel:<reservation_id>` (unik per tenant), sehingga rute pembatalan adapter sendiri dan konsumen ini tidak dapat sama-sama me-refund. `lateCancellation` adalah fakta Booking; biaya apa pun adalah keputusan kebijakan |
| `commerce.booking_rescheduled_link_reconciler`  | `...reservation.rescheduled` | Pastikan tautan aktif menunjuk pengganti (`rescheduledFromId`, `supersededById`); tandai tautan lama `superseded`                                                             | `runtime_effect_once`; hanya rekonsiliasi, karena rute reschedule sudah mengarahkan ulang                                                                                                                                                                                               |
| `commerce.booking_no_show_decision_recorder`    | `...reservation.no_show`     | Catat keputusan no-show di bawah aturan retensi kebijakan bila staf menandainya langsung di Booking                                                                           | `self_managed`; kunci keputusan unik yang sama seperti di atas                                                                                                                                                                                                                          |

`...reservation.held`, `.created`, `.checked_in`, dan `.completed` tidak punya efek wajib di v1; `checked_in` dan `completed` dikonsumsi hanya untuk model baca POS dan pelaporan (metrik bagian 6) dan tidak butuh konsumen baru. Booking tidak menyimpan status pembayaran, jadi tidak ada konsumen yang membacanya dari event; buku besar adalah satu-satunya sumber.

### 5.2 Event yang diterbitkan adapter

Event commerce boleh membawa jumlah (`payment.recorded` live membawanya) dan tidak boleh membawa nama, telepon, alamat pelanggan, referensi pembayaran, atau alasan teks bebas. Mereka memakai amplop yang sama, `aggregateType: order`, dan ditulis dalam transaksi yang sama dengan perubahan yang diumumkannya.

```yaml
# DRAFT — not in the live spec.
asyncapi: 3.0.0
info:
  title: Booking-commerce adapter — emitted events (DRAFT)
  version: 0.0.0
  x-awcms-status: draft
channels:
  awcms.commerce.order.settled:
    address: awcms.commerce.order.settled
    description: >-
      PROPOSED NAME (ADR-0041 D7; final name and payload are decided in #355).
      Settlement on an order reached its total. Emitted exactly once, in the same
      transaction as the ledger write that makes outstanding zero, for a deposit
      order and for a whole-total order alike. The loyalty earner reacts to
      order.paid for a whole-total order and to this event for a deposit order,
      under the existing earn source key so no order earns twice.
    messages: { OrderSettled: { $ref: "#/components/messages/OrderSettled" } }
  awcms.commerce.booking_refund.decided:
    address: awcms.commerce.booking_refund.decided
    description: >-
      A cancellation or no-show decision was recorded, or its final refund was
      overridden. Same transaction as the decision row.
    messages:
      {
        BookingRefundDecided:
          { $ref: "#/components/messages/BookingRefundDecided" },
      }
  awcms.commerce.booking_reservation_link.attention_raised:
    address: awcms.commerce.booking_reservation_link.attention_raised
    description: "A deposit arrived after the hold expired, or a confirmation failed. For an operator."
    messages:
      { AttentionRaised: { $ref: "#/components/messages/AttentionRaised" } }
operations:
  publishCommerceOrderSettled:
    action: send
    channel: { $ref: "#/channels/awcms.commerce.order.settled" }
  publishCommerceBookingRefundDecided:
    action: send
    channel: { $ref: "#/channels/awcms.commerce.booking_refund.decided" }
  publishCommerceBookingAttentionRaised:
    action: send
    channel:
      {
        $ref: "#/channels/awcms.commerce.booking_reservation_link.attention_raised",
      }
components:
  messages:
    OrderSettled:
      contentType: application/json
      payload:
        allOf:
          - $ref: "#/components/schemas/DomainEventEnvelope"
          - type: object
            properties:
              eventType: { const: awcms.commerce.order.settled }
              eventVersion: { const: "1.0" }
              aggregateType: { const: order }
              payload:
                type: object
                additionalProperties: false
                required: [orderId, orderCode, total, settledAt, hadDeposit]
                properties:
                  orderId: { type: string, format: uuid }
                  orderCode: { type: string }
                  total: { type: string }
                  settledAt: { type: string, format: date-time }
                  hadDeposit:
                    {
                      type: boolean,
                      description: "True when dp_amount was below total.",
                    }
    BookingRefundDecided:
      contentType: application/json
      payload:
        allOf:
          - $ref: "#/components/schemas/DomainEventEnvelope"
          - type: object
            properties:
              eventType: { const: awcms.commerce.booking_refund.decided }
              eventVersion: { const: "1.0" }
              aggregateType: { const: order }
              payload:
                type: object
                additionalProperties: false
                required:
                  [
                    decisionId,
                    orderId,
                    reservationId,
                    triggerKind,
                    policySource,
                    amountPaid,
                    computedRefund,
                    finalRefund,
                    overridden,
                  ]
                properties:
                  decisionId: { type: string, format: uuid }
                  orderId: { type: string, format: uuid }
                  reservationId: { type: string, format: uuid }
                  triggerKind:
                    {
                      type: string,
                      enum: [customer_cancel, staff_cancel, no_show],
                    }
                  policySource:
                    { type: string, enum: [product, tenant_default, none] }
                  amountPaid: { type: string }
                  computedRefund: { type: string }
                  finalRefund: { type: string }
                  overridden:
                    {
                      type: boolean,
                      description: "No reason text and no actor name in the payload; the actor is in the envelope and the reason in the decision row and audit log.",
                    }
    AttentionRaised:
      contentType: application/json
      payload:
        allOf:
          - $ref: "#/components/schemas/DomainEventEnvelope"
          - type: object
            properties:
              eventType:
                {
                  const: awcms.commerce.booking_reservation_link.attention_raised,
                }
              eventVersion: { const: "1.0" }
              aggregateType: { const: order }
              payload:
                type: object
                additionalProperties: false
                required: [orderId, reservationId, reason]
                properties:
                  orderId: { type: string, format: uuid }
                  reservationId: { type: string, format: uuid }
                  reason:
                    {
                      type: string,
                      enum: [deposit_after_expiry, confirm_failed],
                    }
```

Event live yang ada tetap menjadi kosakata uang: `awcms.commerce.payment.recorded`, `awcms.commerce.payment.reversed`, `awcms.commerce.return.recorded`, dan `awcms.commerce.refund.settled` sudah mengumumkan tiap leg buku besar dan leg refund pesanan booking, sehingga adapter ini tidak menambah event pembayaran kedua.

## 6. Bagaimana draf ini menjadi live

Draf adalah halaman; spesifikasi live adalah dua bundel hasil generate ditambah fragmen sumber per modul yang dibaca `bun run openapi:bundle` dan pemeriksaan AsyncAPI. Jalan dari yang satu ke yang lain adalah aturan contract-first dari [`AGENTS.md`](../AGENTS.id.md):

1. **Putuskan dahulu.** ADR adapter (butir terbuka model data bagian 7, dan bagian 7 halaman ini) diterima, dan pemeriksaan upstream-first selesai: apa pun yang milik `ahliweb/awcms` (kode penolakan Booking, kolom payload `stays[]`, event Booking akhir) diimplementasikan di upstream dan tiba lewat sinkronisasi subtree, tidak ditulis di sini. Isu adapter lalu mendaratkan tabel, kemudian handler.
2. **Angkat YAML ke fragmen `commerce`, bersama handler.** Rute ditambahkan ke fragmen modul OpenAPI commerce dalam pull request yang sama dengan handler, penanda `x-awcms-draft` dibuang, `operationId` dicek terhadap yang ada, dan tiap kode galat ditambahkan ke enumerasi `ErrorCode`. `api-spec-check.ts` lalu membuktikan paritas rute (tiap path OpenAPI punya berkas handler dan sebaliknya).
3. **Path yang digabung mendahului handler-nya adalah pengecualian bernama.** Bila kontrak harus mendahului kode agar pekerjaan storefront atau UX dapat dibangun terhadap bentuk yang sudah ditinjau (seperti kontrak akun pelanggan untuk ADR-0016), setiap path itu disebut di `ROUTE_PARITY_EXEMPTIONS` dalam `apps/cms/scripts/api-spec-check.ts` dengan komentar yang menunjuk isu yang akan mendaratkan handler-nya. Himpunan itu kosong di `main` hari ini; **ia harus kosong lagi sebelum epik ditutup**, dan pull request hanya-kontrak yang meninggalkan entri melewati epiknya adalah cacat.
4. **Event pindah dari draf ke live dalam pull request implementasi yang menerbitkannya.** Tiga event yang diterbitkan ditambahkan ke berkas AsyncAPI live dan ke `DOMAIN_EVENT_TYPE_REGISTRY` bersamaan, dengan penerbit dan konsumennya dideklarasikan di deskriptor modul commerce. Event Booking sendiri keluar dari berkas provisional dalam pull request implementasi Booking, bukan di sini; repo ini hanya mengonsumsinya.
5. **Izin, audit, dan RLS didaftarkan bersama kode,** bukan bersama kontrak: kunci matriks akses menjadi izin terdaftar, nama event audit ditambahkan, dan bukti RLS dijalankan di bawah peran tanpa hak istimewa.
6. **Perubahan pada operasi live** (rute 6 dan skema `CommerceSettlement`) bersifat aditif dan bawaannya perilaku hari ini; uji gateway total-utuh yang ada harus lolos tanpa perubahan (ADR-0041 D3) dan uji idempotensi bundel dan kontrak harus tetap hijau.

Sampai langkah 2 terjadi untuk sebuah path, path itu tidak ada, tidak boleh ada klien yang ditulis terhadapnya seolah ada, dan tidak ada gerbang yang menegakkannya.

## 7. Butir terbuka yang harus ditetapkan ADR adapter

Dicatat, tidak diputuskan, karena masing-masing butuh pemeriksaan tingkat kode atau upstream yang tidak bisa dilakukan dokumen.

1. **Leg refund dan `return`.** Apakah return pembatalan berjenis `return` atau jenis tersendiri (model data bagian 7 butir 1). Ini mengubah semantik `returnId` di `CommerceBookingRefundDecision`, bukan rute.
2. **Waktu override.** Bagian 3.5 dan 3.6 mengasumsikan leg refund direncanakan setelah keputusan, sehingga keputusan masih dapat diubah selama `return_id` null, ditambah `override` inline pada pembatalan staf. Bila leg selalu direncanakan di dalam transaksi pembatalan, rute override mandiri menjadi parameter pra-commit saja dan `DECISION_ALREADY_EXECUTED` hilang.
3. **Pengawatan step-up.** Matriks akses mencatat tidak ada rute commerce yang memanggil step-up platform hari ini; rute 14 akan menjadi yang pertama, sehingga bentuk tantangan `STEP_UP_REQUIRED` dan TTL-nya diambil dari `identity-access` dan dikonfirmasi terhadap implementasinya, tidak ditetapkan di sini.
4. **Wahana selisih reschedule** (pesanan tambahan atau baris baru pada pesanan belum dibayar; model data bagian 7 butir 4). `priceDifference.vehicle` masih terbuka.
5. **Check-in dengan pelunasan tertunggak.** Apakah tenant boleh mewajibkan pelunasan penuh sebelum check-in, dan apakah itu pengaturan atau aturan per produk. `BALANCE_NOT_SETTLED` bergantung pada keputusan itu.
6. **Nama event pelunasan.** `awcms.commerce.order.settled` adalah placeholder sampai #355 memutuskan nama dan payload-nya (ADR-0041 D7).
7. **Kompensasi hold-ke-pesanan.** Draf membatalkan hold lewat port bila pembuatan pesanan gagal setelah hold berhasil. Apakah membuat pesanan lebih dulu (menyimpan kode) lalu hold, atau sebaliknya, bergantung pada urutan kunci yang diterbitkan Booking; pilihan itu harus menjaga satu kunci idempotensi tetap otoritatif.
8. **Permintaan reschedule pelanggan.** v1 tidak memberi pembeli rute reschedule (staf menyelesaikannya). Apakah rute permintaan diinginkan adalah keputusan UX untuk W8 ([#359](https://github.com/ahliweb/awcms-one/issues/359)).

## 8. Apa yang bukan dokumen ini

Ini bukan berkas OpenAPI atau AsyncAPI, handler, pendaftaran izin, migrasi, atau spesifikasi UX (W8, [#359](https://github.com/ahliweb/awcms-one/issues/359)). Ia tidak mengubah [ADR-0041](adr/0041-gateway-deposit-sessions-and-mixed-tenders-on-one-order.id.md), model data, atau matriks akses; bila salah satunya ambigu, draf mengutip butir terbuka alih-alih memilih. Ia tidak menambahkan apa pun ke `ROUTE_PARITY_EXEMPTIONS`, sehingga tidak ada gerbang yang melihatnya dan tidak ada yang disebutnya ada di produk.
