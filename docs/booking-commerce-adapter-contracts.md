🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](booking-commerce-adapter-contracts.id.md)

# Booking-commerce adapter — OpenAPI and AsyncAPI contract drafts

DoR artifact 7 of epic [#280](https://github.com/ahliweb/awcms-one/issues/280), work item W7 ([#358](https://github.com/ahliweb/awcms-one/issues/358)), tracked in [`aw-business-platform-dor.md`](aw-business-platform-dor.md). It drafts the HTTP routes and domain events the booking-commerce adapter would add to the `commerce` module, using the tables of [`booking-commerce-adapter-data-model.md`](booking-commerce-adapter-data-model.md) and the permission keys of [`booking-commerce-access-matrix.md`](booking-commerce-access-matrix.md).

> **Drafts only. Every path and event below is "draft — not in the live spec".** Nothing here is a file under `apps/cms/openapi/` or `apps/cms/asyncapi/`, so `ROUTE_PARITY_EXEMPTIONS` in `apps/cms/scripts/api-spec-check.ts` stays empty and no gate sees these paths ([ADR-0040](adr/0040-aw-business-platform-capability-ownership-and-boundaries.md) D7). The YAML blocks are written in the shape the real fragments use so that a later implementation can lift them, but they are prose in a Markdown page: they are not validated, bundled or served. Table, permission, error-code and event names are proposals that the implementation issue may adjust. Do not read this page as describing the current API; [`status.md`](status.md) and the files under `apps/cms/openapi/` do that.

## 1. Inputs and the conventions they fix

| Source                                                                                                                                                                                                                                                                                                                            | What it fixes for these drafts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/cms/openapi/modules/commerce.openapi.yaml` and the root fragment `apps/cms/openapi/awcms-public-api.src.yaml`                                                                                                                                                                                                               | Success envelope `{ success: true, data }`; error envelope `ApiError` (`{ success: false, error: { code, message, details? }, meta }`); staff routes inherit the global `bearerAuth` plus `tenantHeader`; anonymous storefront routes declare `security: []` and, where a shopper may sign in, an optional `customerBearer` ([ADR-0016](adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) D3); the shared `#/components/parameters/IdempotencyKey` component (1 to 255 visible ASCII characters, ADR-0129) is referenced, never re-declared; money is a `numeric(14,2)` **string**; staff paths live under `/api/v1/commerce/...`, anonymous shopper paths under `/api/v1/commerce/storefront/...` |
| `apps/cms/docs/awcms/cross-domain-contracts.md` section 3 (Booking port)                                                                                                                                                                                                                                                          | The adapter reaches Booking only through `BookingPort` (`quote`, `hold`, `confirm`, `cancel`, `reschedule`), each with a required idempotency key. Booking refusals (`SLOT_UNAVAILABLE`, `HOLD_EXPIRED`, `INVALID_STATE`, and so on) are mapped to `409` here under the same code. Booking accepts no price, deposit, payment state or customer contact                                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/cms/asyncapi/provisional/awcms-cross-domain-events.provisional.asyncapi.yaml` and the Booking pack after [ADR-0135](../apps/cms/docs/adr/0135-day-granularity-stays-admitted-into-booking-v1.md) (`booking.md` sections 2.5 and 3.1, synced into `apps/cms`)                                                                | Nine provisional `awcms.booking.reservation.*` events with one shared payload; a stay adds an additive `stays[]` array (`resourceId`, `checkInDate`, `checkOutDate`, `nights`, `timezone`); payloads hold no customer, no contact and no payment state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| [ADR-0041](adr/0041-gateway-deposit-sessions-and-mixed-tenders-on-one-order.md) D1, D5, D6, D7, D8                                                                                                                                                                                                                                | A gateway session has `purpose` (`full`, `deposit`, `balance`) and a server-computed `expected_amount`; the client supplies no amount; one live session per order; the order shows a derived `settlement` with `deposit`, `balanceDue`, `settledAt`; a settlement event fires once at zero outstanding; points and a deposit never share an order                                                                                                                                                                                                                                                                                                                                                                                       |
| [ADR-0025](adr/0025-payments-are-an-allocation-ledger-separate-from-order-status.md), [ADR-0033](adr/0033-returns-refunds-and-exchanges-are-additive-records-that-compensate-through-the-existing-ledgers.md), [ADR-0134](https://github.com/ahliweb/awcms/blob/main/docs/adr/0134-descriptor-declared-domain-event-consumers.md) | The ledger is the settlement authority; a refund is a leg per original payment under a return; consumers are declared in the module descriptor (`domainEventConsumers`) with a stated idempotency mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Owner answers of 10 October 2026 (Q1 to Q4, Q8 to Q10)                                                                                                                                                                                                                                                                            | Nights are the quantity of one product; a reschedule difference is priced by the order path; cancellation is computed from a per-product policy with a tenant default; only a manager or finance permission may override a refund, with step-up, reason and audit                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Rules that apply to every draft below:

1. **No client-supplied money.** No request carries `amount`, `expectedAmount`, `computedRefund` or `price`. The server computes them from the ledger and the policy. A body naming one is refused `400 VALIDATION_ERROR`, as the existing stock-ledger routes refuse a client balance. The single exception is the override's `finalRefund`, which only its own permission may send (section 3.6).
2. **The customer is never an input and never an output field of a reservation.** A shopper is identified by the bearer session or, for a guest, by the order's own mechanism (`orderCode` plus `phone`, exactly as the existing anonymous order routes). Responses carry the order code, never a customer id (finding X7).
3. **Every mutating route requires `Idempotency-Key`.** For hold-to-order the key is stored as `client_key` on the reservation link (`UNIQUE (tenant_id, client_key)`); a replay with the same key and body returns the original result, the same key with a different body or another actor is `409 IDEMPOTENCY_CONFLICT`.
4. **No provider call inside a transaction** ([ADR-0017](adr/0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md) rule, restated by ADR-0041 D5.4). The deposit-session route fixes the expected amount in one short transaction and calls the provider with none open.

## 2. Draft path inventory

All paths are **draft — not in the live spec**. "Perm" is the proposed (not registered) key from the access matrix. Section numbers point to the YAML below.

| #   | Method and path                                                                       | Caller                        | Perm / auth                                                                                                                                                      | Purpose                                                                              | Sec. |
| --- | ------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---- |
| 1   | `GET /api/v1/commerce/booking/offering-links`                                         | Staff                         | `commerce.booking_offering_links.read`                                                                                                                           | List offering-to-product links                                                       | 3.1  |
| 2   | `POST /api/v1/commerce/booking/offering-links`                                        | Staff                         | `commerce.booking_offering_links.create`                                                                                                                         | Link one offering to one service product                                             | 3.1  |
| 3   | `PATCH /api/v1/commerce/booking/offering-links/{id}`                                  | Staff                         | `commerce.booking_offering_links.update`                                                                                                                         | Unlink (a status change; no delete)                                                  | 3.1  |
| 4   | `POST /api/v1/commerce/storefront/booking/reservations`                               | Shopper (anonymous or bearer) | none; optional `customerBearer`                                                                                                                                  | Hold a slot or stay and create the order, one idempotent call                        | 3.2  |
| 5   | `POST /api/v1/commerce/booking/reservations`                                          | Staff or cashier              | `commerce.booking_reservation_links.create` (POS also `commerce.pos.create`)                                                                                     | The same, on behalf of a guest or at the till                                        | 3.2  |
| 6   | `POST /api/v1/commerce/storefront/orders/{orderCode}/payment-gateway/sessions`        | Shopper                       | none; optional `customerBearer`                                                                                                                                  | **Amends the existing route**: body gains `purpose`, response gains `expectedAmount` | 3.3  |
| 7   | `POST /api/v1/commerce/orders/{id}/payment-gateway/sessions`                          | Staff                         | `commerce.payments.create`                                                                                                                                       | Deposit or balance session started by staff (ADR-0041 D5.3)                          | 3.3  |
| 8   | `GET /api/v1/commerce/booking/reservations/{id}`                                      | Staff                         | `commerce.booking_reservation_links.read`                                                                                                                        | Reservation link, order code and derived settlement                                  | 3.4  |
| 9   | `GET /api/v1/commerce/storefront/booking/reservations/{orderCode}`                    | Shopper                       | none; `customerBearer` or `phone` query                                                                                                                          | Own reservation with deposit, balance due and settled time                           | 3.4  |
| 10  | `GET /api/v1/commerce/booking/reservations/{id}/cancellation-quote`                   | Staff                         | `commerce.booking_reservation_links.read`                                                                                                                        | Non-binding computed refund                                                          | 3.5  |
| 11  | `GET /api/v1/commerce/storefront/booking/reservations/{orderCode}/cancellation-quote` | Shopper                       | none; `customerBearer` or `phone` query                                                                                                                          | The same, for the shopper's own reservation                                          | 3.5  |
| 12  | `POST /api/v1/commerce/booking/reservations/{id}/cancel`                              | Staff                         | `commerce.booking_reservation_links.cancel`, `commerce.booking_refund_decisions.create` (inline override also needs `commerce.booking_refund_overrides.approve`) | Cancel and record the decision                                                       | 3.5  |
| 13  | `POST /api/v1/commerce/storefront/booking/reservations/{orderCode}/cancel`            | Shopper                       | none; `customerBearer` or `phone`                                                                                                                                | Customer confirms a quoted cancellation                                              | 3.5  |
| 14  | `POST /api/v1/commerce/booking/reservations/{id}/refund-override`                     | Manager or finance            | `commerce.booking_refund_overrides.approve` and fresh step-up                                                                                                    | Set a final refund other than the computed one                                       | 3.6  |
| 15  | `POST /api/v1/commerce/booking/reservations/{id}/reschedule`                          | Staff                         | `commerce.booking_reservation_links.update`                                                                                                                      | Move a reservation; the price difference rides the order path                        | 3.7  |
| 16  | `POST /api/v1/commerce/booking/reservations/{id}/no-show`                             | Staff                         | `commerce.booking_reservation_links.cancel`, `commerce.booking_refund_decisions.create`                                                                          | Mark no-show and apply the policy's retention rule                                   | 3.8  |
| 17  | `POST /api/v1/commerce/pos/booking/reservations/{id}/check-in`                        | Cashier or staff              | `commerce.pos.create`, `commerce.payments.create`, `commerce.booking_reservation_links.read`                                                                     | Collect the balance in the open register session, then check in                      | 3.9  |

Not drafted here because they are not booking-specific or belong elsewhere: the deposit policy edit (it is a field of the product form, [`booking-commerce-adapter-data-model.md`](booking-commerce-adapter-data-model.md) section 7 point 2), the cancellation policy versions and windows (an admin CRUD whose UX is W8, [#359](https://github.com/ahliweb/awcms-one/issues/359)), the attention-flag resolve action, and the Wave B surfaces (segments [#360](https://github.com/ahliweb/awcms-one/issues/360), redemption [#363](https://github.com/ahliweb/awcms-one/issues/363)). Each follows the same conventions and gets its own draft in its own issue.

## 3. OpenAPI 3.1 fragment drafts

Every operation carries `x-awcms-draft: true` as a marker that it is not in the live spec; the marker would not exist in a real fragment. `$ref` targets such as `#/components/schemas/ApiError` resolve only after the real bundle merges the fragments, exactly as the commerce fragment's own header says of itself.

### 3.1 Link offering and product

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

### 3.2 Hold to order (one idempotent call)

The adapter does, in order: quote through `BookingPort.quote`, `BookingPort.hold` with `externalRef = { type: "commerce_order", id: <order id> }` and the request's idempotency key, create the order with the line (quantity = nights for a stay, 1 for a slot) and the `dp_amount` snapshot (ADR-0041 D4), then insert the reservation link. The natural key `(tenant, externalRef.type, externalRef.id)` lets a retry with a fresh key still not duplicate a live reservation. If order creation fails after the hold, the hold is cancelled through the port in a compensating step and the hold would in any case lapse by expiry.

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

### 3.3 Deposit session (ADR-0041)

Route 6 is an additive amendment to the existing `createCommerceStorefrontPaymentGatewaySession`: `purpose` defaults to `full`, so every existing caller is unchanged (ADR-0041 D3). The client asks for "pay the deposit" or "pay the balance" and supplies no amount.

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

The webhook and reconcile guard (`checkPaymentAmount`) is not an HTTP contract change: it compares the provider figure to the session's `expected_amount` in integer cents (ADR-0041 D2), and a verified `deposit` or `balance` leg is recorded with the session's `expected_amount` under the existing `gateway:{provider}:{ref}` source key. The public webhook path and its payload are unchanged.

### 3.4 Order settlement view

The settlement object is the existing derived `CommerceSettlement` made deposit-aware (ADR-0041 D6). Nothing is stored independently; it is computed from the ledger. The extra fields are additive and null or equal to `total` on a whole-total order.

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

### 3.5 Cancellation quote and confirm

The quote is a read and writes nothing. The cancel route recomputes the refund under the order lock and, if the shopper acknowledged a figure that no longer matches (the policy was activated in between, or a payment was reversed), refuses with `409 QUOTE_CHANGED` and the new figure rather than refunding a different amount than the one the shopper agreed to. No client amount ever sets the refund; `acknowledgedRefund` is compared, never stored as the refund.

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

### 3.6 Refund override (manager or finance, step-up)

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

The adapter calls `BookingPort.reschedule` (one transaction on Booking's side: release, replace, supersede), then supersedes the old reservation link with a new one that points at the new reservation. It stores no price difference (Q4). The difference is priced by the order path and returned as a pointer.

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

### 3.9 POS check-in with balance collection

The cashier takes the balance as ordinary ledger legs in their **own** open register session (the existing `commerce.payments.create` semantics, `cash`, `manual_qris`, `manual_bank_transfer`, `gift_card`, `store_credit`; a `gateway` tender cannot be typed). Points redemption and a deposit never share an order (ADR-0041 D8), so no redemption field exists here.

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

## 4. Error codes introduced by the drafts

Booking refusals keep the code Booking gives them (the final union is fixed by Booking's implementation PR, which also fixes the OpenAPI `ErrorCode` enumeration; cross-domain-contracts section 3). The adapter-owned codes are proposals:

| Code                                                | HTTP | Meaning                                                                                                              |
| --------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------- |
| `OFFERING_NOT_LINKED`                               | 409  | The offering has no active link to a product                                                                         |
| `OFFERING_ALREADY_LINKED`, `PRODUCT_ALREADY_LINKED` | 409  | One active link per offering and per product                                                                         |
| `PRODUCT_NOT_SERVICE`, `QUANTITY_BASIS_MISMATCH`    | 409  | The linked product is not `service`, or `quantityBasis` disagrees with the offering's granularity                    |
| `POINTS_DEPOSIT_NOT_COMBINABLE`                     | 409  | ADR-0041 D8; its stable code is "defined in the implementation issue", this name is a proposal                       |
| `PURPOSE_NOT_ALLOWED`                               | 409  | A `deposit` or `balance` session on an order whose state or deposit policy does not admit it (ADR-0041 D1, D3)       |
| `QUOTE_CHANGED`                                     | 409  | The recomputed refund differs from the figure the shopper acknowledged; nothing was cancelled                        |
| `OVERRIDE_EXCEEDS_PAID`                             | 409  | `finalRefund` above the recomputed amount paid                                                                       |
| `DECISION_ALREADY_EXECUTED`                         | 409  | The decision's refund legs are already planned; the amount can no longer change                                      |
| `STEP_UP_REQUIRED`                                  | 403  | Existing identity-access code; first used by commerce here. The caller holds the permission but has no fresh step-up |
| `BALANCE_NOT_SETTLED`                               | 409  | Tenant requires settlement before check-in                                                                           |
| `INVALID_STATE`, `IDEMPOTENCY_CONFLICT`             | 409  | Booking's codes, passed through unchanged                                                                            |

## 5. AsyncAPI 3.0 drafts

Both blocks reuse the live `DomainEventEnvelope` (`apps/cms/asyncapi/awcms-domain-events.asyncapi.yaml`). They are drafts: nothing is added to that file or to `DOMAIN_EVENT_TYPE_REGISTRY`, and the provisional Booking file is not edited here.

### 5.1 Events the adapter consumes

Booking's nine provisional events share one payload and carry **no customer, no contact, no amount and no payment state**. The adapter derives the customer through the order, never from the event (finding X7). After [ADR-0135](../apps/cms/docs/adr/0135-day-granularity-stays-admitted-into-booking-v1.md) a reservation with stay items adds an additive `stays[]` (`resourceId`, `checkInDate`, `checkOutDate`, `nights`, `timezone`) to every event's payload; `startsAt` and `endsAt` are the earliest arrival and latest departure instants. The adapter must tolerate its absence (slot reservations) and unknown additional fields. It also consumes one event of its own module, `awcms.commerce.order.paid`, to confirm.

Under [ADR-0134](https://github.com/ahliweb/awcms/blob/main/docs/adr/0134-descriptor-declared-domain-event-consumers.md) each consumer would be declared in the commerce module descriptor's `domainEventConsumers`; the names below are proposals and would key delivery rows and the effect ledger, so they must not change once chosen. `runtime_effect_once` means the registry wraps `handle` and the commerce code never calls the effect-once helper; `self_managed` means the consumer enforces its own natural key.

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

What each consumer does, and the traps it must avoid:

| Consumer (proposed name)                        | Event                        | Effect                                                                                                                                                            | Idempotency and rule                                                                                                                                                                                                                                             |
| ----------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commerce.booking_order_paid_confirmer`         | `awcms.commerce.order.paid`  | For an order with an active reservation link, `BookingPort.confirm`. On a refusal (`HOLD_EXPIRED`) set `attention_reason` and do not fail the delivery repeatedly | `self_managed`: confirm is idempotent by the port key (`confirm:<reservation_id>`). A deposit order reaches `paid` at the deposit (ADR-0041 D6), so the reservation confirms on the deposit, not at full settlement                                              |
| `commerce.booking_expired_order_canceller`      | `...reservation.expired`     | Cancel the **pending** order named by `externalRef`                                                                                                               | `runtime_effect_once`. **An order that holds received money is never cancelled by expiry** (ADR-0025 "Behaviour changes"): flag `attention_reason = 'deposit_after_expiry'` for an operator instead of silently confirming a released slot (ADR-0041 D5.5)       |
| `commerce.booking_cancelled_order_canceller`    | `...reservation.cancelled`   | Cancel the pending order when no money was received                                                                                                               | `runtime_effect_once`; a no-op when the order holds payments                                                                                                                                                                                                     |
| `commerce.booking_cancelled_refund_coordinator` | `...reservation.cancelled`   | If the cancel did **not** come from this adapter (a Booking-side cancel) and money was paid, create the decision and refund request                               | `self_managed`; natural key is the decision's `source_key` `booking-cancel:<reservation_id>` (unique per tenant), so the adapter's own cancel route and this consumer cannot both refund. `lateCancellation` is Booking's fact; any fee is the policy's decision |
| `commerce.booking_rescheduled_link_reconciler`  | `...reservation.rescheduled` | Ensure the active link points at the replacement (`rescheduledFromId`, `supersededById`); mark the old link `superseded`                                          | `runtime_effect_once`; reconciliation only, because the reschedule route already re-pointed it                                                                                                                                                                   |
| `commerce.booking_no_show_decision_recorder`    | `...reservation.no_show`     | Record the no-show decision under the policy's retention rule if staff marked it in Booking directly                                                              | `self_managed`; same unique decision key as above                                                                                                                                                                                                                |

`...reservation.held`, `.created`, `.checked_in` and `.completed` have no required effect in v1; `checked_in` and `completed` are consumed only for the POS and reporting read models (metrics section 6) and need no new consumer. Booking holds no payment state, so no consumer reads one from an event; the ledger is the only source.

### 5.2 Events the adapter emits

Commerce events may carry amounts (the live `payment.recorded` does) and must not carry a customer name, phone, address, payment reference or free-text reason. They use the same envelope, `aggregateType: order`, and are written in the same transaction as the change they announce.

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

The existing live events stay the vocabulary for money: `awcms.commerce.payment.recorded`, `awcms.commerce.payment.reversed`, `awcms.commerce.return.recorded` and `awcms.commerce.refund.settled` already announce each ledger leg and refund leg of a booking order, so this adapter adds no second payment event.

## 6. How these become live

The drafts are pages; the live spec is two generated bundles plus per-module source fragments that `bun run openapi:bundle` and the AsyncAPI check read. The path from one to the other is the contract-first rule of [`AGENTS.md`](../AGENTS.md):

1. **Decide first.** The adapter ADR (the open points of the data model, section 7, and this page's section 7) is accepted, and the upstream-first check is done: anything that belongs to `ahliweb/awcms` (a Booking refusal code, the `stays[]` payload fields, the final Booking events) is implemented upstream and arrives by subtree sync, not authored here. The adapter issue then lands tables, then handlers.
2. **Lift the YAML into the `commerce` fragment, with a handler.** Routes are added to the commerce OpenAPI module fragment in the same pull request as the handler, with the `x-awcms-draft` marker dropped, `operationId`s checked against the existing ones, and each error code added to the `ErrorCode` enumeration. `api-spec-check.ts` then proves route parity (every OpenAPI path has a handler file and the reverse).
3. **A path merged ahead of its handler is a named exception.** If the contract must precede the code so that storefront or UX work can build against a reviewed shape (as the customer-account contract did for ADR-0016), each such path is named in `ROUTE_PARITY_EXEMPTIONS` in `apps/cms/scripts/api-spec-check.ts` with a comment pointing at the issue that will land its handler. The set is empty on `main` today; **it must be empty again before the epic closes**, and a contract-only pull request that leaves an entry behind past its epic is a defect.
4. **Events move from draft to live in the implementation pull request that emits them.** The three emitted events are added to the live AsyncAPI file and to `DOMAIN_EVENT_TYPE_REGISTRY` together, with their publishers and the consumers declared in the commerce module descriptor. Booking's own events leave the provisional file in the Booking implementation pull request, not here; this repo only consumes them.
5. **Permissions, audit and RLS are registered with the code,** not with the contract: the access matrix keys become registered permissions, the audit event names are added, and the RLS proof runs under the unprivileged role.
6. **Amendments to live operations** (route 6 and the `CommerceSettlement` schema) are additive and default to today's behaviour; the existing whole-total gateway tests must pass unchanged (ADR-0041 D3) and the bundle idempotency and contract tests must stay green.

Until step 2 happens for a path, that path does not exist, no client should be written against it as if it did, and no gate enforces it.

## 6a. Control traceability

The drafts above implement these threat-model controls ([threat model](aw-business-platform-threat-model.md) section 7, including the #354 addendum): C-05 and C-32 (ownership on every ID-based path), C-07 (server-computed deposit amount), C-10 and C-40 (server-side refund amount, override), C-34 and C-35 (POS lookup and permission separation), C-36 (balance read from the ledger, no reservation state written by the POS), C-37 to C-39 (reschedule and cancellation window, order-reference move, price difference through the order path) and C-41 (no-show retention by policy). The threat model is authoritative for the control text; a path that cannot show its control in review does not go live.

## 7. Open points the adapter ADR must settle

Recorded, not decided, because each needs a code-level or upstream check that docs cannot do.

1. **Refund legs and `return`.** Whether the cancellation return is a `return` of kind `return` or a distinct kind (data model section 7 point 1). It changes `returnId` semantics in `CommerceBookingRefundDecision`, not the routes.
2. **Override timing.** Section 3.5 and 3.6 assume refund legs are planned after the decision, so a decision can still be amended while `return_id` is null, plus an inline `override` on staff cancel. If legs are always planned inside the cancel transaction, the standalone override route becomes a pre-commit parameter only and `DECISION_ALREADY_EXECUTED` disappears.
3. **Step-up wiring.** The access matrix notes that no commerce route calls the platform step-up today; route 14 would be the first, so the `STEP_UP_REQUIRED` challenge shape and TTL are taken from `identity-access` and confirmed against its implementation, not defined here.
4. **The reschedule difference vehicle** (supplementary order or a new line on an unpaid order; data model section 7 point 4). `priceDifference.vehicle` is open.
5. **Check-in with a balance due.** Whether a tenant may require full settlement before check-in, and whether it is a setting or a per-product rule. `BALANCE_NOT_SETTLED` is conditional on that decision.
6. **Name of the settlement event.** `awcms.commerce.order.settled` is a placeholder until #355 decides its name and payload (ADR-0041 D7).
7. **Hold-to-order compensation.** The draft cancels the hold through the port if order creation fails after a successful hold. Whether to create the order first (reserving a code) and hold second, or the reverse, depends on the lock order Booking publishes; the choice must keep the single idempotency key authoritative.
8. **Customer reschedule request.** v1 gives the shopper no reschedule route (staff complete it). Whether a request route is wanted is a UX decision for W8 ([#359](https://github.com/ahliweb/awcms-one/issues/359)).

## 8. What this document is not

It is not an OpenAPI or AsyncAPI file, a handler, a permission registration, a migration or a UX specification (W8, [#359](https://github.com/ahliweb/awcms-one/issues/359)). It does not change [ADR-0041](adr/0041-gateway-deposit-sessions-and-mixed-tenders-on-one-order.md), the data model or the access matrix; where one of them is ambiguous the drafts cite the open point instead of choosing. It adds nothing to `ROUTE_PARITY_EXEMPTIONS`, so no gate sees it and nothing it names exists in the product.
