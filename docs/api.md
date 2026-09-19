🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](api.id.md)

# API

Two API surfaces live under `/api/v1/commerce/*`, at two different trust levels. **Beyond commerce, `apps/storefront` calls seven more `apps/cms` surfaces** — the news content itself and everything increment 3 added around it; they are listed in "What the storefront calls outside commerce" below. Source of truth is [`apps/cms/openapi/modules/commerce.openapi.yaml`](../apps/cms/openapi/modules/commerce.openapi.yaml), merged by `bun run openapi:bundle` (inside `apps/cms`) into the full `openapi/awcms-public-api.openapi.yaml` document; this page explains the shape, it is not a second copy of the spec.

| | Owner API | Storefront (anonymous) API |
| --- | --- | --- |
| Base path | `/api/v1/commerce/*` | `/api/v1/commerce/storefront/*` |
| Caller | `apps/storefront`'s build process (`AWCMS_API_TOKEN`); an admin's browser session | A shopper's browser, directly, cross-origin (`PUBLIC_AWCMS_ORIGIN`) |
| Auth | Bearer token / session, checked against a `commerce.*` permission | None — tenant is resolved from the request's `Origin` header against `awcms_tenant_domains` |
| Envelope | `{ success: true, data }` / `{ success: false, error: { code, message } }` — every response, including errors | Same envelope |
| Introduced by | Issue #4 (catalog core), extended by #23/#26 | Issue #29 (`ahliweb/awcms`'s anonymous-endpoint pattern — its own ADR-0103/0107/0118 — applied to commerce), consumed by #30 |
| Architecture decision | — | [ADR-0007](adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md) |

## Owner API: catalog, marketing, orders/customers/reviews

Grouped by the same three areas [`docs/arsitektur.md`](arsitektur.md) and [ADR-0008](adr/0008-one-commerce-module-carries-the-whole-store-not-three.md) describe.

### Catalog (issue #4, deepened by #23)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/v1/commerce/categories` | `?parentId=`; keyset-paginated; each row carries a computed `productCount` |
| `POST`/`GET`/`PATCH`/`DELETE` | `/api/v1/commerce/categories(/{id})` | `PATCH` never accepts `parentId` — immutable after creation, see [`docs/cms.md`](cms.md) |
| `POST` | `/api/v1/commerce/categories/{id}/restore` | Undoes a soft delete (issue #23 added `restore` for both resources) |
| `GET` | `/api/v1/commerce/products` | `?categoryId=&status=&q=&sort=&featured=&recommended=&cursor=`; every row carries a server-computed `finalPrice` and resolved `images[]`/`variants[]` |
| `GET` | `/api/v1/commerce/products/by-slug/{slug}` | Never resolves a soft-deleted row |
| `POST`/`GET`/`PATCH`/`DELETE`/`.../restore` | `/api/v1/commerce/products(/{id})` | `POST` always starts `status: draft`; `PATCH` checks `LEGAL_TRANSITIONS` before any write |
| `POST`/`PATCH`/`DELETE` | `/api/v1/commerce/products/{id}/images(/{imageId})` | `mediaObjectId` is checked live against `MediaLibraryPort.isMediaReferenceSafe` before insert |
| `POST`/`PATCH`/`DELETE` | `/api/v1/commerce/products/{id}/variants(/{variantId})` | SKU uniqueness checked against both `awcms_commerce_products` and the variants table itself |

Pagination: keyset, newest-first by default (`sort=newest`), page size fixed at 100 server-side. `price_asc`/`price_desc`/`name` sorts return a single bounded page (`nextCursor: null`) rather than a keyset walk — a `cursor` combined with a non-`newest` sort is rejected 400.

### Marketing (issue #26)

| Family | Owner routes | Public read model |
| --- | --- | --- |
| Flash sales | `/flash-sales`, `/{id}`, `/{id}/products(/{rowId})` | `GET /flash-sales/active` — status **derived** from the time window, persisted by the `commerce:flash-sales:tick` job, which fires `commerce.flash_sale.{started,ended}` once per transition |
| Vouchers | `/vouchers`, `/{id}`, `POST /vouchers/validate` | `GET /vouchers/public` — exact integer-cent arithmetic, `maxDiscount` cap; redemption itself happens on the order (below) |
| Sliders / testimonials / popup | `/sliders`, `/testimonials`, `/popups` (each CRUD) | `/sliders/active`, `/testimonials/active`, `/popups/active` — at most one active popup per tenant (a partial unique index) |
| Store settings | `GET`/`PUT`/`DELETE /store-settings` (one versioned `jsonb` document per tenant) | `GET /store-settings/public` — never a bank account number, holder, or QRIS reference |

`DELETE /store-settings` means "reset to defaults", not delete-the-tenant's-settings: it stamps `deleted_at`, the public and owner reads then answer with defaults, and the next `PUT` clears the stamp.

### Orders, customers, reviews (issue #29) — owner side

| Method | Path | Notes |
| --- | --- | --- |
| `GET`/`PATCH` | `/api/v1/commerce/orders(/{id})`, `.../orders/{id}/status` | No `POST`/`DELETE` — an order is only ever created through the anonymous storefront path (below) |
| `PATCH` | `/api/v1/commerce/orders/{id}/payment-confirmations/{cid}/review` | `{ decision: "accepted" \| "rejected" }`; accepting sets the order's `paymentStatus` to `paid` |
| `GET` | `/api/v1/commerce/orders/export.csv` | |
| `GET`/`PATCH` | `/api/v1/commerce/customers(/{id})` | No `POST`/`DELETE` — a customer row is created only by the anonymous order path |
| `GET`/`PATCH`/`DELETE` | `/api/v1/commerce/reviews(/{id})` | `PATCH {status}` moderates `pending → published/rejected` |

## Storefront (anonymous) API — `/api/v1/commerce/storefront/*`

Every route resolves its tenant from the request's `Origin`/`Host` against `awcms_tenant_domains` — never from a header the caller controls — answers the `OPTIONS` preflight, echoes the allowed origin verbatim (never `*`), sends `Vary: Origin`, grants no credentials, and rate-limits per IP (order creation also per normalised phone). See [ADR-0007](adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md) for why this exists instead of a runtime credential.

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `cart/quote` | `{ lines[], shipping, voucherCode, insurance, destination?: {districtCode} }` → subtotal → voucher discount → shipping → insurance → tax → total, every figure a `numeric(14,2)` string; a line's `status` flags `out_of_stock`/an unavailable option without failing the whole quote. `shippingOptions[]`'s courier entries (issue #109, contract: #106 D4) are either one priced `{method:"courier", serviceId, name, etd, cost, available:true}` row per service, or a single `{available:false, serviceId:null, cost:null, note}` placeholder when courier is disabled, `destination` is absent, or the provider cannot price it |
| `POST` | `orders` | `{ idempotencyKey, customer, address\|null, lines[], shipping, payment, voucherCode, insurance, notes }` → `201` (or `200` on an idempotent repeat of the same key); `400 VALIDATION_ERROR` with `details[].{field,message}`; `409 CART_CHANGED` with a fresh `details.quote` whenever any line's re-quote is not `"ok"` |
| `GET` | `orders/{code}?phone=` | Full order shape; **`404 NOT_FOUND`, byte-identical, for an unknown code, a wrong phone, or another tenant's order** — a neutral response, not three distinguishable ones (see [ADR-0009](adr/0009-guest-checkout-by-order-code-and-phone.md)) |
| `POST` | `orders/{code}/payment-confirmations` | `{phone, method, amount, bankName, accountName, transferredAt, proofMediaObjectId}`; `409 ORDER_NOT_PAYABLE` outside `pending_payment` |
| `POST` | `orders/{code}/payment-gateway/sessions` | Issue #112, contract: #106 D3. `{phone}` or `Authorization: Bearer` → `201 {redirectUrl, expiresAt, providerRef}`; idempotent per order (a repeat call answers the SAME session, never a second one); `409 PAYMENT_NOT_APPLICABLE` when the order is not a `pending_payment`, `paymentMethod: "gateway"` order; `503 GATEWAY_UNAVAILABLE` when the deployment's own provider is unreachable/misconfigured |
| `POST` | `orders/{code}/payment-proof/upload-sessions(/{id}/finalize)` | Always `503 MEDIA_UNAVAILABLE` in this increment — see [`docs/cms.md`](cms.md) |
| `POST` | `orders/{code}/cancel` | `{phone, reason}`; `409 ORDER_NOT_CANCELLABLE` outside `pending_payment` |
| `POST` | `reviews` | Requires a `completed` order for that product; created `status: pending`, moderated on the owner side |
| `GET` | `store-settings/public` | Also used by the storefront build; the same route serves both build-time and (in principle) runtime callers. Gains `payment.gatewayEnabled` (issue #112) — when `true`, `cart/quote`'s own `paymentMethods[]` may list `{method:"gateway", available:true}` |

**`orders`/`reviews` now also accept an OPTIONAL `customerBearer` (#91):** present and valid → the order/review is attributed to that account's own customer row instead of the guest phone credential (the phone is still validated for shape and still the per-phone rate limit's key); present but invalid/expired → `401 UNAUTHENTICATED`; absent entirely → unchanged. `POST orders` also accepts `affiliateCode` in the body — shape-validated (a string, at most 50 characters) and, since #92, resolved against `awcms_commerce_affiliates.code`: an unknown or suspended code links nothing and never fails the checkout; a valid, active code sets `orders.affiliate_id`, which is what a later transition to `completed` reads to record a commission.

**Idempotency:** order creation reuses the module-agnostic `awcms_idempotency_keys` store (`(tenantId, requestScope, idempotencyKey)`, no principal needed — it works from the anonymous tenant wrapper). The cart's own client-generated UUID is reused as the idempotency key, so a double-submitted "Place order" click returns the same `orderCode` rather than creating a second order.

### Customer accounts — auth + resources + affiliates implemented (#89, #91, #92)

[ADR-0016](adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) records the four decisions (identity, OTP channel, bearer session, registration binding) the whole surface was designed against, and [issue #86](https://github.com/ahliweb/awcms-one/issues/86) is where the OpenAPI shape lives (`apps/cms/openapi/modules/commerce.openapi.yaml`). A new `customerBearer` security scheme — deliberately separate from the staff `bearerAuth`/session schemes — authenticates every route below except the two OTP ones, which are anonymous by the same anti-enumeration logic as the rest of this API.

**Implemented (#89):**

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `POST` | `account/otp/request` | none | `{email, purpose: "login"\|"register", name?, phone?, via?: "email"\|"whatsapp"}` → **always** `202 {sent:true, expiresInSeconds:600}`, except `409 CHANNEL_UNAVAILABLE` for `via: "whatsapp"` when the channel is not configured (#108, see below) |
| `POST` | `account/otp/verify` | none | `{email, code, purpose}` or `{phone, code, purpose: "login"}` (#108) → `200 {token, expiresAt, account}`; `401 OTP_INVALID`, `404 ACCOUNT_NOT_FOUND` (login), `409 PHONE_ALREADY_REGISTERED` (register) |
| `GET`/`PATCH` | `account/me` | `customerBearer` | The account; `PATCH` accepts `{name}` only — no e-mail/phone change yet |
| `POST` | `account/logout` | `customerBearer` | `204`, revokes the presented session |

**Implemented (#91):**

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET`/`POST` | `account/addresses` | `customerBearer` | Max 10 per account (`409 ADDRESS_LIMIT_REACHED`); the first address ever saved becomes the default automatically; list returns default first |
| `PATCH`/`DELETE` | `account/addresses/{id}` | `customerBearer` | `PATCH` never touches `isDefault`; deleting the default promotes the most-recently-created remaining one |
| `POST` | `account/addresses/{id}/default` | `customerBearer` | Exactly one default per customer is enforced by `sql/920`'s partial unique index, not merely trusted to application code |
| `GET`/`PUT` | `account/wishlist` | `customerBearer` | `PUT {productIds:[]}` is a union merge (never a removal), max 200, returns the merged list; an id that is not a live product in this tenant is silently skipped; `GET` shows published, non-deleted products only |
| `DELETE` | `account/wishlist/{productId}` | `customerBearer` | Soft-delete, idempotent — always `204` |
| `GET` | `account/orders(/{orderCode})` | `customerBearer` | Keyset (`cursor`, `limit` ≤ 50), bounded to `created_at >= account.historyFrom`, enforced INSIDE the query; the detail route needs no phone (ownership + `historyFrom` both checked inside that same query — a neutral `404` for an unknown code, another account's order, or one before `historyFrom`) |
| `GET` | `account/reviews` | `customerBearer` | Own reviews, any moderation status, product name + order code inlined |

**Implemented (#92):**

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET`/`POST` | `account/affiliate` | `customerBearer` | `GET` never 404s (`{affiliate: null}` when not enrolled); `POST` enrols (idempotent — a second call returns the same row), `201`; `409 AFFILIATE_PROGRAM_DISABLED` when `storeSettings.affiliateCommissionRate` is null |
| `GET` | `account/affiliate/commissions` | `customerBearer` | Keyset (`cursor`), newest first; `{items, nextCursor}` |

The existing anonymous `POST orders` and `POST reviews` (#91) each accept an *optional* `customerBearer`: present and valid, the order/review is attributed to that account's own customer row instead of the guest phone credential; present but invalid/expired, `401 UNAUTHENTICATED`; absent, both endpoints behave exactly as documented above. `POST orders` also accepts an optional `affiliateCode`, now resolved (#92) against `awcms_commerce_affiliates.code` — an unknown/suspended code is silently ignored, never a checkout failure.

Owner-side staff routes for the affiliate program itself, gated on `commerce.affiliates.{read,update}`/`commerce.affiliate_commissions.{read,update}`:

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `commerce/affiliates` | Keyset, newest first |
| `PATCH` | `commerce/affiliates/{id}` | `{status?, commissionRate?}` |
| `GET` | `commerce/affiliate-commissions?status=` | Keyset, newest first |
| `POST` | `commerce/affiliate-commissions/{id}/approve` | `pending -> approved`; `Idempotency-Key` required; `409 COMMISSION_NOT_APPROVABLE` |
| `POST` | `commerce/affiliate-commissions/{id}/pay` | `approved -> paid`; `Idempotency-Key` required; `409 COMMISSION_NOT_PAYABLE` |
| `POST` | `commerce/affiliate-commissions/{id}/void` | `pending\|approved -> void`; `Idempotency-Key` required; `409 COMMISSION_ALREADY_FINAL` |

A commission is created `pending` the moment the referenced order's status reaches `completed` (never on self-referral, never for a since-suspended affiliate); `base = subtotal − discount − voucher_discount` (floored at zero), `amount = round(base × rate / 100, 2)`, both `numeric` strings (ADR-0003). `store-settings/public`'s `affiliateProgramEnabled` boolean is the only affiliate fact exposed publicly — the rate itself is owner-only (`GET /api/v1/commerce/store-settings`).

### External providers — payment gateway, courier, WhatsApp, POS, reports, inbox, campaigns (increment 5 — #107–#118)

[ADR-0017](adr/0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md) records the ten decisions (D1–D10) this surface is designed against, and [issue #106](https://github.com/ahliweb/awcms-one/issues/106) is where the OpenAPI shape lives, exactly as ADR-0016/#86 did for accounts. **D5 (WhatsApp) is implemented — see its own subsection immediately below.** No handler exists yet for any row in the table below — each is named in `ROUTE_PARITY_EXEMPTIONS` (`apps/cms/scripts/api-spec-check.ts`) with the child issue that removes it.

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `POST` | `storefront/orders/{orderCode}/payment-gateway/sessions` | none (phone) or `customerBearer` | `201 {redirectUrl, expiresAt, providerRef}` (Midtrans Snap, D3); `409 PAYMENT_NOT_APPLICABLE`; `503 GATEWAY_UNAVAILABLE` — #110 |
| `POST` | `webhooks/midtrans/{endpointToken}` | none (public) | Tenant resolved from the opaque token (D2); always `200` for a verified/deduplicated/replayed event, `401` bad signature, `404` unknown token — #113 |
| `GET`/`POST` | `storefront/account/conversations`, `GET .../{id}`, `POST .../{id}/messages` | `customerBearer` | The shopper's own inbox thread (D8) — #111 |
| `GET`/`POST` | `commerce/pos/orders` | `commerce.orders.read` / `commerce.pos.create` | Counter sale, `channel:"pos"`, created already `paid` (D6) — #116 |
| `GET`/`PATCH` | `commerce/conversations(/{id})`, `POST .../{id}/messages` | `commerce.conversations.{read,update}` | Owner side of the inbox (D8) — #111 |
| `GET`/`POST`/`PATCH` | `commerce/campaigns(/{id})`, `POST .../{id}/{preview,send,cancel}` | `commerce.campaigns.{read,update,send}` | Consent-gated mass e-mail/WhatsApp (D9) — #114 |
| `GET`/`POST`/`DELETE` | `commerce/webhook-endpoints(/{id})` | `commerce.webhook_endpoints.update` | Mints/revokes the opaque token D2 resolves a webhook's tenant from; the raw token is shown exactly once — #110 |
| `GET` | `/api/v1/reports/commerce/sales-{daily,by-product,by-category}` | `reporting.dashboard.read` | Three `reporting`-hosted projections contributed by `commerce` (D7) — #117 |

Also planned on EXISTING, already-implemented paths (additive fields, no new exemption needed): `POST cart/quote`/`POST orders` gain `destination`/`shipping.serviceId` for a real courier rate (D4, RajaOngkir — #107) and `payment.method: "gateway"` (D3 — #110); `GET`/`PATCH account/me` gains `marketingConsent` (D9 — #115); `store-settings` gains `shipping.courier`/`payment.gateway`, and `store-settings/public` gains `payment.gatewayEnabled` (D10 — #118). `POST account/otp/request`'s `via?: "email"|"whatsapp"` (D5) is no longer planned — it shipped in #108, see below.

### WhatsApp outbox — D2's follow-up, implemented (#108, contract #106/ADR-0017 D5)

`CustomerOtpChannel` gains a third adapter, `whatsapp` (Fonnte and Meta Cloud API providers, plus a `log` adapter for dev/CI), backed by a second provider outbox modelled on `email` (`awcms_commerce_whatsapp_messages`/`_delivery_attempts`, `apps/cms/sql/925_awcms_commerce_whatsapp_outbox_otp_channel.sql`). `via: "whatsapp"` on `account/otp/request` (see the row above) only ever supports `purpose: "login"` — registration stays e-mail OTP only — and requires `phone`; `account/otp/verify` accepts `phone` as an alternative to `email`, resolving the account via its customer row's phone. `COMMERCE_WHATSAPP_ENABLED` gates both claiming in the dispatcher and whether `via: "whatsapp"` is available at all.

Owner-side diagnostics, gated on `commerce.whatsapp.read`:

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `commerce/whatsapp/messages?status=` | Keyset, newest first; masked phone (`toPhoneMasked`) only — never the raw number, rendered body, or OTP code |

## Request/response shapes

`CommerceProduct` (owner and storefront reads share the same shape; fields added by #23 are additive):

```
{
  id: uuid, categoryId: uuid | null, type: "physical" | "digital" | "service" | "subscription",
  sku: string, name: string, slug: string, description: string | null, digitalNote: string | null,
  price: string, priceLevel2/3/4: string | null,   // numeric(14,2) strings — see ADR-0003
  discountPercent: number, finalPrice: string,       // server-computed, exact integer-cent arithmetic
  stock: number, status: "draft" | "active" | "inactive" | "archived",
  label: string | null, labelColor: string | null,
  images: [{ id, publicUrl, sortOrder, altText }], variants: [{ id, name, value, sku, price, stock, ... }],
  isFeatured: boolean, isRecommended: boolean, manualRating: string | null, manualSoldCount: number
}
```

`price`, `priceLevel2/3/4`, `finalPrice`, and every money field on marketing/order shapes below are JSON **strings**, e.g. `"19999.00"`, never JSON numbers — see [ADR-0003](adr/0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md) and the `normalizeMoney` note in [`docs/pengujian.md`](pengujian.md).

`Order` (storefront tracking read, `GET .../orders/{code}?phone=`):

```
{
  orderCode: string, status: "pending_payment" | "paid" | "processing" | "shipped" | "completed" | "cancelled" | "expired",
  paymentStatus: "unpaid" | "dp_paid" | "paid" | "refunded",
  customer: { name, phone }, address: {...} | null,
  items: [{ productId, variantId, name, variantName, sku, quantity, unitPrice, lineTotal }],
  subtotal, discount, shipping, insuranceFee, tax, total: string,
  timeline: [{ fromStatus, toStatus, actor, note, createdAt }],
  expiresAt: string | null, paidAt/shippedAt/completedAt/cancelledAt: string | null
}
```

## Authorization: 39 owner permissions

The `commerce` module declares 39 permission keys in total (10 + 22 + 7 below), grouped by the same three areas as its tables — a count too large for this document's own "spelled number matches a counted set" convention (`bun run audit:dokumen`'s linked-count check only recognises spelled numbers one through twenty), so it is stated here as a numeral instead of inside a guarded block.

| Area | Permission keys |
| --- | --- |
| Catalog (10) | `commerce.categories.{read,create,update,delete,restore}`, `commerce.products.{read,create,update,delete,restore}` |
| Marketing (22) | `commerce.{flash_sales,vouchers,sliders,testimonials,popups}.{read,create,update,delete}` (20), `commerce.settings.{read,update}` (2) |
| Orders/customers (7) | `commerce.orders.{read,update}`, `commerce.customers.{read,update}`, `commerce.reviews.{read,update,delete}` |

Deliberately **no `create`/`delete` for `orders`/`customers`**: an order or customer row is created only through the anonymous storefront path, with no permission check at all (there is no admin identity on that path to check). Declaring an unenforced permission is exactly the defect `apps/cms`'s `access:permissions:enforcement:check` gate exists to catch, so none is declared. There is deliberately no `restore` for marketing, orders, customers, or reviews — only catalog (`categories`/`products`) gained `restore` in this increment.

The storefront (anonymous) API has **no permission keys at all** — its trust boundary is the Origin-bound tenant resolver, not RBAC/ABAC.

## Domain events: twelve

All twelve are registered in the three places `awcms` keeps in sync (`domain-event-runtime/domain/event-type-registry.ts`, `apps/cms/asyncapi/awcms-domain-events.asyncapi.yaml`, `commerce/module.ts`'s `events.publishes`):

| Aggregate | Events |
| --- | --- |
| `commerce.product` | `awcms.commerce.product.{created,updated,status_changed}` |
| `commerce.flash_sale` | `awcms.commerce.flash_sale.{started,ended}` — fired once per transition by the tick job, not on every read |
| `commerce.voucher` | `awcms.commerce.voucher.redeemed` — pre-declared as a forward reference in #26, only actually fired once #29's order path redeems one |
| `commerce.order` | `awcms.commerce.order.{created,paid,status_changed,cancelled,expired}` |
| `commerce.review` | `awcms.commerce.review.published` |

`categories` still publishes no domain events — the same choice `tenant_admin` makes for `awcms_offices`; a soft delete is an audit-log fact, not something a downstream consumer needs to react to.

## Errors this API defines beyond the generic envelope

| Status | Code | When |
| --- | --- | --- |
| `400` | `VALIDATION_ERROR` | Field-level input errors, `details[].{field,message}` |
| `400` | — | `categoryId`/`parentId` does not resolve to a live category in the caller's own tenant; a product's requested `status` is not a legal transition |
| `409` | `CATEGORY_SLUG_ALREADY_EXISTS` / `PRODUCT_SLUG_ALREADY_EXISTS` / `PRODUCT_SKU_ALREADY_EXISTS` | A slug/SKU already taken by a live row in this tenant |
| `409` | `CART_CHANGED` | A storefront order-creation request's re-quote disagrees with the submitted cart; response carries a fresh `details.quote` |
| `409` | `ORDER_NOT_PAYABLE` / `ORDER_NOT_CANCELLABLE` | The order's current status does not legally allow the requested action |
| `404` | `NOT_FOUND` | Unknown resource, or — on the storefront API — a neutral refusal covering "unknown order", "wrong phone", and "belongs to another tenant" identically |
| `503` | `MEDIA_UNAVAILABLE` | The payment-proof upload-session routes, always, in this increment |

A `categoryId`/`parentId` that is unknown, soft-deleted, or belongs to another tenant is rejected with the **same** 400 in every case — see [`docs/skema-basis-data.md`](skema-basis-data.md) for why telling those three causes apart would be a cross-tenant existence oracle. The storefront API applies the identical principle at 404: `GET orders/{code}?phone=` never reveals whether the code exists at all.

## What the storefront calls outside commerce

Everything here is `apps/cms`'s own, owned by modules the subtree carries; this repo consumes them and documents which, so a reader looking for "where does the storefront get X" does not have to grep.

| Surface | Caller | Trust level |
| --- | --- | --- |
| `GET /api/v1/blog/{posts,terms,institutions,pages/public}` | build (`AWCMS_API_TOKEN`) | owner, read-only |
| `GET /api/v1/media/objects?ids=` | build | owner, read-only — `media_library.media.read`, added in increment 3 ([ADR-0011](adr/0011-storefront-media-resolves-through-the-media-objects-endpoint.md)) |
| `GET /api/v1/news-portal/ad-placements/active` | build | owner, read-only |
| `GET /api/v1/seo/redirects?state=active` | build | owner, read-only |
| `GET /api/v1/site-profile/composed` | build | owner, read-only |
| `GET /api/v1/idn-regions/regions` | build | owner, read-only — bounded to 6 concurrent requests since [issue #71](https://github.com/ahliweb/awcms-one/issues/71), under the CMS's 8 running `interactive` slots |
| `GET /api/v1/analytics/pages?range=7d` | build | owner, read-only — `visitor_analytics.dashboard.read`, feeds "Terpopuler" |
| `POST /api/v1/analytics/collect` | **the reader's browser** | anonymous, Origin-bound ([ADR-0012](adr/0012-first-party-visitor-analytics-with-an-opt-in-ga4-switch.md)) |
| `POST /api/v1/newsletter/{subscribe,confirm,unsubscribe}` | **the reader's browser** | anonymous, Origin-bound; the confirm/unsubscribe **paths are a CMS contract** (`NEWSLETTER_CONFIRM_PATH`/`NEWSLETTER_UNSUBSCRIBE_PATH` in `apps/cms/src/modules/newsletter/domain/newsletter-mail.ts`), which is why this app serves `/newsletter/confirm` and `/newsletter/unsubscribe` under exactly those names |

The build credential's permission set is seeded by `tools/seed-borneojek-mart.ts`; changing it there **rotates** the credential on the next seed run, so an `AWCMS_API_TOKEN` still holding the old secret starts failing with 401 (issue #57's own reconciliation step prints the replacement).

## Not built

RajaOngkir courier rates and a payment gateway — `payment_method` accepts a `gateway` enum value already (additive, per [ADR-0010](adr/0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.md)), but no provider integration exists yet; both, plus POS, reports, an inbox, and campaigns, now have a settled contract ([ADR-0017](adr/0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md), issue #106, the "External providers" table above) and go through the outbox pattern as they land, issue by issue, under [issue #33](https://github.com/ahliweb/awcms-one/issues/33) (#107, #110–#118). The storefront side of the courier half is done ([issue #109](https://github.com/ahliweb/awcms-one/issues/109)): `cart/quote`'s `destination`/courier shapes above are coded against the contract [issue #106](https://github.com/ahliweb/awcms-one/issues/106) (D4) names, currently answered by `apps/storefront/scripts/stub-awcms.mjs`'s fixture-backed rates — `apps/cms`'s own RajaOngkir adapter is what remains. Customer accounts, login, and every authenticated storefront endpoint ([issue #32](https://github.com/ahliweb/awcms-one/issues/32)) are **done**: the contract ([ADR-0016](adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md), issue #86, the "Customer accounts" table above) is fully implemented — OTP login/registration, `me`, `logout` ([issue #89](https://github.com/ahliweb/awcms-one/issues/89)), addresses/wishlist/order-history/review ([issue #91](https://github.com/ahliweb/awcms-one/issues/91)), and the affiliate program, both the shopper's own bearer-secured surface and the owner's moderation API ([issue #92](https://github.com/ahliweb/awcms-one/issues/92)). WhatsApp OTP/login (ADR-0016 D2's follow-up, ADR-0017 D5) is now also **done** ([issue #108](https://github.com/ahliweb/awcms-one/issues/108), the "WhatsApp outbox" section above) — a login-only channel for an EXISTING account, resolved by phone; registration stays e-mail OTP only, so a genuinely phone-only account (no e-mail at all) remains open, tracked in ADR-0016's own follow-up note. What ADR-0016's D6 explicitly deferred and is still not here: e-mail/phone change on an existing account, tiered pricing at quote time (now under ADR-0017 D10's contract, #118), and phone verification. A working payment-proof upload for an anonymous caller (`media_library`'s session flow needs an authenticated `actorTenantUserId`, which no guest checkout caller has).
