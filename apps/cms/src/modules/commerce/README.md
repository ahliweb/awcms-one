🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](README.id.md)

# `commerce`

Tenant-scoped product **categories** (hierarchical, self-referencing) and
**products** (with images and variants), ported from the legacy MySQL
`commerce_bj_mart.{categories,products}` schema — plus, since Issue #26, the
**marketing surface** BjekMart's home page and promotions run on: flash
sales, vouchers, sliders, testimonials, a promo popup, and a per-tenant
store-settings document — and, since Issue #29, **customers, orders and
reviews**: a guest checkout that never requires an account, a cart quote that
re-prices server-side, order tracking and cancellation by `orderCode` +
phone, manual payment confirmations, and a review left from a completed
order — and, since epic #32 (issues #86–#93), **customer accounts, OTP
login/bearer sessions, a self-service account surface** (saved addresses, a
synced wishlist, order history, reviews) **and an affiliate program**
designed fresh per [ADR-0016](../../../../../docs/adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md).
Issue #4 (part of epic #1) shipped the catalog core; Issue #23 (part
of epic #21) brought it to full product-model parity with the legacy schema;
Issue #26 (same epic) added the marketing tables; Issue #29 (same epic) added
customers, orders and the anonymous storefront checkout surface; epic #32
added customer accounts and affiliates on top of that same customer row.

| Aspect      | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key / type  | `commerce` · `domain`, `isCore: false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Tables      | `awcms_commerce_categories`, `awcms_commerce_products` (`sql/901`, extended `sql/904`), `awcms_commerce_product_images`, `awcms_commerce_product_variants` (`sql/905`); `awcms_commerce_flash_sales`, `awcms_commerce_flash_sale_products`, `awcms_commerce_vouchers`, `awcms_commerce_sliders`, `awcms_commerce_testimonials`, `awcms_commerce_popups` (`sql/909`), `awcms_commerce_store_settings` (`sql/910`); `awcms_commerce_customers`, `awcms_commerce_customer_addresses`, `awcms_commerce_orders`, `awcms_commerce_order_items`, `awcms_commerce_order_events`, `awcms_commerce_payment_confirmations`, `awcms_commerce_reviews`, `awcms_commerce_wishlists` (`sql/913`); `awcms_commerce_customer_accounts`, `awcms_commerce_customer_otps`, `awcms_commerce_customer_sessions` (`sql/917`-`918`); the `derived.commerce_customer_otp` `awcms_email_templates` row, seeded per existing tenant (`sql/919`); `awcms_commerce_affiliates`, `awcms_commerce_affiliate_commissions`, plus `orders.affiliate_id`/`store_settings.affiliate_commission_rate` (`sql/921`); `awcms_commerce_whatsapp_messages`, `awcms_commerce_whatsapp_delivery_attempts`, plus `awcms_commerce_customer_otps.phone_normalized` (`sql/925`); `awcms_commerce_conversations`, `awcms_commerce_messages` (`sql/927`); `awcms_commerce_customer_accounts.marketing_consent_at`, `awcms_commerce_campaigns`, `awcms_commerce_campaign_recipients` (`sql/929`); `awcms_commerce_payment_gateway_sessions`, `awcms_commerce_payment_events`, `awcms_commerce_webhook_endpoints`, plus `orders.gateway_provider`/`orders.gateway_ref` (`sql/926`); `payment_events.outcome` widened with `amount_mismatch` (`sql/934`); `awcms_commerce_sales_daily`, `awcms_commerce_sales_by_product`, `awcms_commerce_sales_by_category` (`sql/933`, Issue #117 — derived reporting projections) |
| Permissions | `categories.{read,create,update,delete,restore}`, `products.{read,create,update,delete,restore}` (`sql/902`, `sql/906`); `{flash_sales,vouchers,sliders,testimonials,popups}.{read,create,update,delete}`, `settings.{read,update}` (`sql/911`); `orders.{read,update}`, `customers.{read,update}`, `reviews.{read,update,delete}` (`sql/914`, deliberately no create/delete for orders or customers — see "Customers, orders and reviews" below); `affiliates.{read,update}`, `affiliate_commissions.{read,update}` (`sql/922`, same no-create/delete reasoning); `whatsapp.read` (`sql/925`, diagnostics only); `conversations.{read,update}` (`sql/928`, same no-create/delete reasoning); `campaigns.{read,update,send}` (`sql/930` — `send` split from `update`, the one action that reaches a real inbox/phone); `webhook_endpoints.update` (`sql/926`, gates list/create/revoke alike) — 50 in all                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| API         | `/api/v1/commerce/{categories,products,flash-sales,vouchers,sliders,testimonials,popups,store-settings,orders,customers,reviews,affiliates,affiliates/{id},affiliate-commissions,affiliate-commissions/{id}/{approve,pay,void},whatsapp/messages}` (owner side); `/api/v1/commerce/storefront/{cart/quote,orders,reviews}` (anonymous side, `orders`/`reviews` also accept an OPTIONAL `customerBearer`, Issue #91); `/api/v1/commerce/storefront/account/{otp/request,otp/verify,me,logout}` (anonymous OTP + `customerBearer`, Issue #89; `otp/request`/`otp/verify` gain `via`/`phone`, Issue #108; `me` gains `marketingConsent`, Issue #114); `/api/v1/commerce/storefront/account/{addresses,addresses/{id},addresses/{id}/default,wishlist,wishlist/{productId},orders,orders/{orderCode},reviews,affiliate,affiliate/commissions,conversations,conversations/{id},conversations/{id}/messages}` (`customerBearer`, Issues #91/#92/#111); `/api/v1/commerce/{conversations,conversations/{id},conversations/{id}/messages}` (owner side, Issue #111); `/api/v1/commerce/{campaigns,campaigns/{id},campaigns/{id}/{preview,send,cancel}}` (owner side, Issue #114); `/api/v1/reports/commerce/{sales-daily,sales-by-product,sales-by-category}` (`reporting.dashboard.read`, Issue #117) (`openapi/modules/commerce.openapi.yaml`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Events      | `commerce.product.{created,updated,status_changed}`; `commerce.flash_sale.{started,ended}` (Issue #26, emitted by the tick job); `commerce.order.{created,paid,status_changed,cancelled,expired}`, `commerce.voucher.redeemed`, `commerce.review.published` (Issue #29)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Depends on  | `tenant_admin`, `identity_access`, `domain_event_runtime`, `media_library` (product images, sliders, testimonial avatars, the popup image and the store logo/favicon all resolve through `MediaLibraryPort`), `module_management` (the anonymous storefront tenant resolver checks the module is enabled for the tenant before answering), `profile_identity` (e-mail/phone masking), `email` (Issue #89 — the customer OTP channel's `email` adapter enqueues into `email`'s own outbox; Issue #108's WhatsApp dispatcher also reuses `email/domain/email-retry.ts`'s pure backoff function)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Jobs        | `commerce:flash-sales:tick` (`scripts/commerce-flash-sales-tick.ts`, every 5 minutes — persists each sale's derived status and fires the two flash-sale events); `commerce:orders:expire` (`scripts/commerce-orders-expire.ts`, every 5 minutes — expires unpaid orders past the store's configured window, restocks their lines, and fires `commerce.order.expired`); `commerce:whatsapp:dispatch`/`commerce:whatsapp:purge` (Issue #108 — the WhatsApp outbox's own drain/retention jobs); `commerce:loyalty:expire`/`commerce:loyalty:reconcile` (Issue #289 — hourly points expiry; daily read-only balance reconcile)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Migrations live in the reserved `901`–`999` range, not upstream's `001`–`899` (issue #72, [ADR-0015](../../../../../docs/adr/0015-commerce-migrations-live-in-the-reserved-9xx-range.md) in awcms-one).** This module's original sixteen migrations, numbered 153 through 168, collided with upstream `ahliweb/awcms`'s own numbering the moment it started using the same numbers for its own migrations (`sql/153_awcms_blog_institution_logo.sql`, issue #59). All sixteen were renumbered to `sql/901_awcms_commerce_schema.sql` through `sql/916_awcms_commerce_orders_expire_worker_write_grants.sql` (offset +748); the next commerce migration is `917`. `tests/commerce-migrations-range.test.ts` enforces the split both ways. A database migrated before this rename runs `bun run db:commerce:renumber` once, before its next `bun run db:migrate` (`scripts/commerce-migrations-renumber.ts`).

## What Issue #23 adds, and what stays a later increment

Issue #4's slice took the catalog core (`categoryId`, `type`, `sku`, `name`,
`slug`, `description`, `digitalNote`, `price`, `discountPercent`, `stock`,
`status`, `label`, `labelColor`) and deferred the rest of the legacy
`products` table. Issue #23 lands every one of those deferred fields:

- **Tiered pricing & cost**: `priceLevel2/3/4` (nullable `numeric(14,2)`
  strings), `costPrice` (same shape, **admin-only** — see below).
- **Inventory & shipping**: `minPurchase` (`>= 1`), `weightGrams`, `allowDp`,
  `allowFreeShipping`.
- **Merchandising**: `isFeatured`, `isRecommended` — explicit flags that
  replace BjekMart's ad-hoc `featuredProducts`/`recommendedProducts`
  heuristics; `manualRating`/`manualSoldCount`, exposed on the DTO as
  `averageRating`/`soldCount` — Issue #29's real reviews and order line counts
  do not feed back into these two columns; they stay the merchant-entered
  seed values, and reconciling them against real activity is a later
  increment.
- **Insurance**: `withInsurance`, `insuranceRequired`, `insuranceFee`.
- **Promo banner**: `promoBannerShow` plus title/subtitle/badge/icon/color.
- **Size chart**: `sizeChartType` (`none`/`image`/`table`), `sizeChartMediaId`
  (required when `image`), `sizeChartDetails` (`jsonb`, required when
  `table`) — the cross-field rule lives in `domain/size-chart.ts`'s
  `reconcileSizeChart`, called from both the create validator (against
  already-defaulted values) and `updateProduct` (against the row MERGED with
  the patch), and mirrored as a coarse `CHECK` in `sql/904`.
  `sizeChartMediaId` is validated as UUID-shaped only, not checked for live
  existence — see "What is still NOT checked" below.
- **Service intake form**: `serviceForm` (`jsonb`, `domain/service-form-validation.ts`)
  — an array of `{id, type, label, required, options}` field descriptors for
  a `type: "service"` product's booking form. Shape-validated, stored as-is;
  nothing renders it server-side.
- **Subscription / digital**: `subscriptionPeriod` (`day`/`week`/`month`/`year`,
  descriptively tied to `type: "subscription"` but not cross-validated —
  BjekMart's own column carries a value independent of `type`), `downloadLink`.
- **Variant attributes**: `variantAttributes` (`jsonb`,
  `domain/variant-attributes-validation.ts`) — the DECLARED set of attribute
  groups/options a merchant has defined (e.g. `[{name: "Size", options:
[{name: "M"}, {name: "L"}]}]`). Descriptive metadata, not a constraint
  enforced against actual variant rows.
- **Restore**: `restoredAt` on both tables — see "Restore" below.

**`costPrice` never reaches a public response.**
`application/product-directory.ts` keeps two mappers over the same row:
`toRecord` (the public `ProductRecord`/`CommerceProduct` DTO — no
`costPrice`) and `toAdminRecord` (`ProductAdminRecord`, `costPrice` included)
— used only by `src/pages/admin/commerce.astro`'s own fetch. The type system
makes the promise, not a convention every route has to remember.

## Money is `numeric(14,2)`, and crosses the wire as a string

Unchanged principle from Issue #4, now covering more columns: `price`,
`priceLevel2/3/4`, `costPrice`, `insuranceFee`, and the computed `finalPrice`
are all `numeric(14,2)`, never a float — `Bun.SQL` hands each back as a
STRING, and nothing in this module parses one to a `number`. `finalPrice`
(`price` after `discountPercent` off) is computed server-side in
`domain/price-calculation.ts`, entirely in integer CENTS via `BigInt` —
`"19.10"` at 10% becomes `"17.19"`, never `17.189999999999998`.
`discountPercent`, `stock`, `minPurchase`, `weightGrams`, and
`manualSoldCount` are plain `integer`: none is money, and all are exact in
floating point anyway.

## Two independent axes: `status` and soft delete

Unchanged from Issue #4. A product's lifecycle status (`draft` →
`active`/`archived`, `active` ⇄ `inactive`, either → `archived`, `archived` →
`draft` only — `domain/product-status.ts`'s `LEGAL_TRANSITIONS`) and whether
the row is soft-deleted (`deleted_at`) are deliberately separate. Pulling a
product from sale without losing it is `status = 'inactive'`; removing it
from the tenant's own catalog view is `deleted_at`. There is still no
dedicated status-transition endpoint — `status` travels through the same
`PATCH /api/v1/commerce/products/{id}` as every other field, checked by
`updateProduct` before any write.

## Hierarchy, and what re-parenting would cost

Unchanged: `parentId` is self-referencing and set only at creation
(`CreateCategoryInput`); `UpdateCategoryInput` does not carry it at all.
Moving a category to a new parent is therefore "delete and recreate", the
same limitation `office-directory.ts` accepts for `parentOfficeId`. A
category whose `parentId` names another tenant's row, an absent id, or a
soft-deleted one is rejected identically (400, `ParentCategoryNotFoundError`)
— the three causes stay indistinguishable on purpose (GHSA-r7cx-c4jh-cvvw's
shape). `products.categoryId` gets the same treatment and, unlike a
category's parent, IS re-assignable via update.

## Restore (Issue #23)

Both tables now carry a `restored_at timestamptz` column (categories' was not
in the issue's own column table, which only lists it for products — added
here for symmetry: the categories restore endpoint needs the same "when" fact,
and `awcms_offices` is this module's own precedent for both). Unlike offices,
neither table gained `deleted_by`/`delete_reason`/`restored_by` — this
module's tables carry no actor-stamp columns at all (Issue #4's original
choice, unchanged); WHO restored a row is the audit log's own
`actorTenantUserId`.

`POST /api/v1/commerce/{categories,products}/{id}/restore` follow
`office-directory.ts`'s shape: 404 when the id is not currently soft-deleted
(idempotent-safe — a repeat restore is a 404, never a duplicate), 409 when a
live row has since taken the same slug (categories, products) or sku
(products). `restore` is its OWN permission on both activity codes — unlike
`offices/[id]/restore.ts`'s reuse of `.update`, so a future policy can grant
one without the other; see `domain/commerce-permissions.ts`'s header.

## Domain events: products only, three of them — unchanged

Categories still publish none. Products still publish exactly the three
Issue #4 defined (`created`/`updated`/`status_changed`) — Issue #23 adds no
new event type, and image/variant CRUD does not publish events either (same
"a soft delete/sub-resource change is an audit-log fact, not a catalog
event" choice categories' own delete already made). A PATCH that touches
both ordinary fields and `status` still fires both events independently.

## Uniqueness

`(tenant_id, slug)` stays unique per table among LIVE rows; products
additionally enforce `(tenant_id, sku)`. **New in Issue #23**: a variant's
`sku`, when set, must be unique against BOTH `awcms_commerce_products` AND
`awcms_commerce_product_variants` in the tenant — a single-table partial
unique index cannot express that cross-table rule, so
`application/product-variant-directory.ts`'s `checkVariantSkuAvailable` checks
both tables BEFORE every INSERT/UPDATE (load-bearing ordering, same rule as
every other pre-write existence check in this module), and the DB partial
unique index on `awcms_commerce_product_variants` itself remains the
same-table race-safety net. A collision surfaces as `409
VARIANT_SKU_ALREADY_EXISTS`.

## Images and variants (Issue #23)

`awcms_commerce_product_images` (`media_object_id NOT NULL` — the row IS the
reference) and `awcms_commerce_product_variants` are owned by a product and
edited through it: `POST/PATCH/DELETE /api/v1/commerce/products/{id}/images`
(`+ /{imageId}`) and `.../variants` (`+ /{variantId}`), all gated on
`products.update` — sub-resources of editing a product, not a resource with
its own audience.

A product image's `mediaObjectId` IS checked for live/verified/same-tenant
existence before insert — `MediaLibraryPort.isMediaReferenceSafe`, the same
capability `blog_content` consumes, injected at the route (composition-root
pattern: the route imports `mediaLibraryPortAdapter`, `application/` never
imports `media_library` directly). `GET` responses (list/detail/by-slug)
resolve every image's `mediaObjectId` (and a variant's own optional
`imageMediaObjectId`) to a `publicUrl`/`imageUrl` in ONE batched
`resolveMediaReferences` call per response — never N+1 — via
`product-directory.ts`'s `attachProductRelations`.

### What is still NOT checked

- **`sizeChartMediaId` (product) and `imageMediaObjectId` (variant) are
  validated as UUID-shaped only** — not checked for live/verified existence
  the way an image row's `mediaObjectId` is. A stale or foreign id simply
  resolves to no `publicUrl` at render time (RLS still keeps a cross-tenant
  id from ever resolving to another tenant's media); a deliberate scope
  reduction recorded for #31, not a security gap — every reference is
  tenant-isolated regardless.
- **Keyset pagination stays scoped to `sort=newest`.** `?sort=price_asc`/
  `price_desc`/`name` return a single bounded page
  (`PRODUCT_LIST_LIMIT` = 100, `nextCursor: null`) rather than a keyset walk
  ordered by a second column — see `domain/product-sort.ts`'s header.
- **`price_level_n <= price` is not enforced** — BjekMart lets a distributor
  price exceed the retail price, so this module does not second-guess it.

## The marketing surface (Issue #26)

Six resource families, one per admin screen, all following the catalog's
conventions (RLS `FORCE`, soft delete via `deleted_at`, money as
`numeric(14,2)` strings, keyset-paginated owner lists, audit events on every
mutation) and each with a **public read model** — the endpoint
`apps/storefront` (in `ahliweb/awcms-one`) bakes its home page from, gated on
the family's `read` permission and returning only what a shopper may see:

| Family         | Owner routes                                                        | Public read model                    | What the read model hides                                                                  |
| -------------- | ------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| Flash sales    | `/flash-sales`, `/{id}`, `/{id}/products`, `/{id}/products/{rowId}` | `GET /flash-sales/active`            | draft and ended sales; `status` is DERIVED from the window (`domain/flash-sale-status.ts`) |
| Vouchers       | `/vouchers`, `/{id}`, `POST /vouchers/validate`                     | `GET /vouchers/public`               | non-public codes, inactive ones, exhausted quota — a private code still WORKS when typed   |
| Sliders        | `/sliders`, `/{id}`                                                 | `GET /sliders/active`                | inactive rows, rows outside their window; the media id becomes a resolved URL              |
| Testimonials   | `/testimonials`, `/{id}`                                            | `GET /testimonials/active`           | inactive rows                                                                              |
| Popup          | `/popups`, `/{id}`                                                  | `GET /popups/active` (one or `null`) | at most ONE active per tenant — a partial unique index (`sql/909`), not a convention       |
| Store settings | `GET`/`PUT`/`DELETE /store-settings`                                | `GET /store-settings/public`         | bank account numbers and holders, the QRIS media id, customer-level discount rules         |

**Voucher arithmetic is exact** (`domain/voucher-arithmetic.ts`): integer
cents, half-up, a percentage capped by `maxDiscount`, `free_shipping` a flag
rather than an amount; `POST /vouchers/validate` stays a READ. Redemption now
belongs to the order that uses the code (Issue #29): `application/cart-quote-service.ts`
and `application/order-directory.ts` both call the SAME `evaluateVoucher`
this section describes, and only order creation increments `used_count` —
inside the same transaction as the order insert, so a voucher's quota cannot
be oversold by two concurrent checkouts. **Flash-sale status is derived**,
never trusted from the column: the editor sets `draft`/`scheduled` and
`commerce:flash-sales:tick` persists what `now()` implies, firing
`commerce.flash_sale.{started,ended}` on the transition and never twice.

**Store settings are one versioned `jsonb` document per tenant**
(`domain/store-settings-validation.ts`, unknown keys rejected, `PUT` is a
full replace). `DELETE` is "reset to defaults": it stamps `deleted_at` rather
than removing the singleton (`sql/910`'s header), every reader then answers
with the defaults, and the next `PUT` clears the stamp — which is also what
lets the row answer the retention question with a real column instead of an
exemption. The public projection (`application/store-settings-directory.ts`'s
`toPublicRecord`) is the security boundary for the bank accounts: they exist
only on the owner `GET`, and the audit event for a change names the SECTIONS
that changed, never a value.

**Money on the wire is always two decimals.** `Bun.SQL` decodes a stored
`0.00` as `"0"` through a parameterised query and as `"0.00"` through a
simple one; every `toRecord` in this module now passes money through
`domain/price-calculation.ts`'s `normalizeMoney` so the contract does not
depend on which protocol served the row.

**What left the public product DTO in this issue:** `downloadLink` — a digital
product's paid asset, now on `ProductAdminRecord` beside `costPrice`. **What
joined it:** `sizeChartImageUrl`, resolved through the same media batch as
`images[]`. Issue #29 does not, in fact, deliver `downloadLink` through the
order path either — see "What Issue #29 does not do" below; it stays a gap
recorded for #31, not a silently-closed forward reference.

## Customers, orders and reviews (Issue #29)

A guest checkout: the shopper never creates an account, and a customer row
(`awcms_commerce_customers`, unique on `(tenant_id, phone)` among live rows)
is found-or-created the moment an order is placed. `domain/phone-normalisation.ts`
turns whatever the checkout form sent into E.164 or refuses it outright — the
phone number, not a session, is the credential the storefront uses for every
subsequent lookup, so a wrong number is treated as "not authenticated", not
"validation error" (`maskPhone` is what the admin UI and logs show instead of
the raw number).

**The public surface is entirely anonymous**, under
`/api/v1/commerce/storefront/{cart/quote,orders,reviews}`, tenant-resolved
from the request Origin/Host the same way `newsletter` and the marketing
public reads are (`application/public-commerce-tenant.ts` mirrors
`newsletter`'s `public-newsletter-tenant.ts` file for file) — never a caller
header, a neutral 404 for an unresolvable tenant or a disabled module, `Vary:
Origin`, the origin echoed back verbatim and never `*`, no credentials. Every
POST is rate-limited per IP and reads its body through `readJsonBody`, never
raw `request.json()`.

- **`POST /storefront/cart/quote`** re-prices a cart from tenant-side product/
  variant/flash-sale/voucher state — never trusts a client-supplied price —
  via `domain/cart-quote.ts`'s `quoteCart`, called from
  `application/cart-quote-service.ts`. The arithmetic order is fixed:
  subtotal → voucher discount → shipping (zeroed by the voucher's
  `freeShipping` flag or by the store's free-shipping threshold, only when
  every line allows free shipping) → insurance (`max(minFee, subtotal ×
ratePercent)`, forced on when any line requires it) → tax (a percentage of
  `subtotal − discount` in `flat` mode; the `tax` module's figure in `engine` mode, ADR-0039) → total. `previousUnitPrice` is always `null` and a
  `"price_changed"` line-diff is never emitted — there is no client-supplied
  expected price to diff against in this contract, a documented gap rather
  than an oversight (`domain/cart-quote.ts`'s header).
- **`POST /storefront/orders`** creates the order from the same quote inputs,
  inside one transaction: customer found-or-created, address saved, stock
  and flash-sale quota decremented, the voucher's `used_count` incremented,
  `order_code` minted (`domain/order-code.ts`, `BJM-YYYYMMDD-XXXX`, excluding
  `0/O/1/I`), and `commerce.order.created` published. Idempotency is the
  SHARED store (`_shared/idempotency.ts`), not a bespoke column — keyed
  `(tenantId, "commerce.orders.create", idempotencyKey)` — so a retried
  submit replays the first response rather than creating a second order; a
  race between two concurrent identical submits is caught centrally
  (`IdempotencyRaceLostError`) and answered as a replay, not a 500.
- **`GET /storefront/orders/:orderCode`**, **`POST .../cancel`**, **`POST
.../payment-confirmations`**, **`POST /storefront/reviews`** all take
  `orderCode` + phone as the credential pair, checked against the order's own
  `customer_id` before anything is read or written.
- **Payment proof upload is a stub in this increment.** Both
  `.../payment-proof/upload-sessions` endpoints always answer `503
MEDIA_UNAVAILABLE` (`application/order-directory.ts`'s header explains why:
  no media-upload contract for an anonymous, unauthenticated caller exists
  yet in `media_library`) — a manual payment confirmation still works without
  a photo; only the buyer-uploaded-proof path is deferred, recorded for #31.
- **Order status is a small state machine** (`domain/order-status.ts`):
  `LEGAL_ORDER_STATUS_TRANSITIONS` plus `actorMayApplyOrderStatus` decide, per
  actor kind (customer vs. admin vs. system), which transition is legal —
  a customer may only cancel from a payable state, an admin drives the
  fulfilment states, and the system (the expiry job) may only expire an
  unpaid order past the store's configured window
  (`store-settings.orders.expiryHours`, default 24). Every transition appends
  an `awcms_commerce_order_events` row (append-only, no `deleted_at`) rather
  than only mutating the order's own `status` column, so the full history
  survives even once the order itself ages out under retention.
- **`commerce:orders:expire`** (`scripts/commerce-orders-expire.ts`, every 5
  minutes) lists orders past their expiry window, transitions each to
  `expired`, restocks its lines (including flash-sale quota), and fires
  `commerce.order.expired` — the same restock path `cancelOrderByCustomer`
  uses, so "cancelled" and "expired" cannot diverge in what they give back.
- **Reviews** are gated on having a COMPLETED order for that product: a guest
  cannot review a product they never bought. `POST /storefront/reviews`
  requires the credential pair above; the admin `reviews` screen moderates
  (publish/reject) and can hard-delete a review, the only hard-delete surface
  this module has (`reviews.delete`, revoke-only entitlement).
- **A guest customer cannot be honestly represented in `ADR-0094`'s
  subject-data vocabulary** — `SubjectDataColumn.references` names only
  staff-side identity concepts (`tenant_user`/`identity`/`profile`/
  `principal`), and a phone-only customer with no account is none of those.
  All eight new tables are declared `unreachableBySubject: true` in
  `module.ts`, the same shape `commerce.testimonials` already used for an
  anonymous submitter — a documented limitation of the vocabulary, not a
  privacy decision made in this module.

### What Issue #29 does not do

- **No digital-product delivery.** `downloadLink` (Issue #23) is still never
  returned by any order or storefront endpoint — a paid order for a digital
  product does not hand back the asset. Recorded for #31, not silently
  dropped.
- **No customer account, login, or order history across orders.** Every
  lookup is single-order, by `orderCode` + phone; there is no "my orders"
  list for a returning shopper in this increment.
- **`awcms_commerce_wishlists` ships its schema but no API route.** The
  issue's own words: "Wishlist stays client-side in this increment (no
  account) — no endpoint" — there is no customer identity yet to persist one
  against. The table exists so a later, account-bearing increment does not
  need its own migration.
- **No `orders.create`/`orders.delete`/`customers.create`/`customers.delete`
  admin permissions.** No admin route creates or hard-deletes an order or a
  customer by design — an order only ever comes from the storefront's own
  `POST /storefront/orders`, and a customer row only from the
  find-or-create that order creation does.
- **No formal `DATABASE_URL`-gated integration test suite** for order
  creation, the double-submit idempotency replay, the wrong-phone credential
  check, the expire-then-restock cycle, or cross-tenant RLS isolation on the
  new tables. All five were proven by hand against a real Postgres instance
  during this issue's own verification (see the PR's Verification section)
  rather than committed as `tests/integration/*.test.ts` files — a real gap
  in the test suite's durability, flagged here rather than left implicit.

## Admin screens: eight, full CRUD (Issues #23 and #26); three more (Issue #29)

`/admin/commerce` (`src/pages/admin/commerce.astro`) — filters
(`categoryId`/`status`/`q`/`featured`/`recommended`), a create form covering
every core field plus the common merchandising flags, per-row inline edit for
the core fields, an "Advanced fields (JSON)" editor for the long tail of
parity columns (tiered pricing, insurance, promo banner, size chart, service
form, subscription/digital, variant attributes — a deliberate compression:
thirty individual controls would dwarf the screen, and this keeps every field
genuinely editable without it), an images picker sourced from
`media_library`'s registry, a variants editor, status transition, soft
delete, and restore.

`/admin/commerce-categories` (new) — category CRUD: create with parent, inline
edit (name/slug — `parentId` is create-only, see "Hierarchy" above), soft
delete, restore.

Issue #26 adds `/admin/commerce-flash-sales`, `-vouchers`, `-sliders`,
`-testimonials`, `-popup` and `-settings`, each a list + create form + per-row
edit/delete against its owner routes (the settings screen is one form with a
"reset to defaults" action). Issue #29 adds `/admin/commerce-orders` (list +
filter by status, detail view, status transition, payment-confirmation
review), `-customers` (list, detail, edit), and `-reviews` (list, moderate,
delete) — no create form on any of the three, since none of their
permissions include `create`. All eleven screens are off
`scripts/admin-screen-coverage-ledger.ts`'s `NOT_YET_SCREENED` — every one of
the 39 declared permissions is claimed by one of them, and
`tests/admin-commerce-marketing-page-contract.test.ts` /
`tests/admin-commerce-page-contract.test.ts` hold the new screens to the same
properties the earlier ones satisfy.

### Admin UI: shared primitives (issue #171; commerce admin v2, epic #249)

Every screen above composes on `apps/cms/src/styles/admin.css`'s shared
primitives (`.admin-stat-card`, `.admin-status-pill`, `.admin-segmented`,
`.admin-bulk-bar`, `.admin-two-pane`, `.admin-toggle`, `.admin-timeline`)
rather than page-specific markup — see
`.claude/skills/awcms-one-commerce/SKILL.md`'s own primitive table for the
full list and when to use each. A second wave (epic #249) added four MORE
shared, commerce-owned components under `src/components/`/`src/lib/ui/`,
each with its own header docblock:

- `CommerceConfirmDialog.astro` + `commerce-confirm-dialog-client.ts` — the
  one accessible confirm dialog every commerce screen's destructive/
  pausable action uses instead of `window.confirm`, including an optional
  note field (consumed by the order-status change, issue #246).
- `commerce-admin-labels.ts` — `createCommerceLabels(t)`/`commerceLabel()`,
  the one translated label map for every commerce enum an admin screen
  renders, plus its tone-map constants.
- `CommerceSettingsSaveBar.astro` + `commerce-settings-save-bar-client.ts` —
  an always-rendered, no-JS-required save/reset bar for a settings form.
- `commerce-products-bulk-client.ts` — the products list's bulk-selection
  bar (issue #247), looping over the existing per-item endpoints rather than
  a new bulk API.

See awcms-one's own ["Commerce admin v2" section of its CMS authoring
guide](../../../../../docs/cms.md) for what each adopting screen now does,
and its [UI/UX design document](../../../../../docs/ui-ux.md) for the
design rationale and the deliberately-not-ported list (ReasonPanel, row
action menus, a separate trash route, bulk order-status transitions,
toasts) — both are awcms-one's own root documentation, outside this
module's tree.

## Customer accounts & affiliates (epic #32 — ADR-0016)

`openapi/modules/commerce.openapi.yaml` documents the full
`/api/v1/commerce/storefront/account/*` surface (OTP login/registration,
profile, saved addresses, wishlist, order history, reviews, affiliate
enrolment) plus the staff-side `/api/v1/commerce/affiliates*` routes — every
one of them implemented, landed across three waves (C2 auth issue #89, C3
resources issue #91, C4 affiliates issue #92), and `ROUTE_PARITY_EXEMPTIONS`
(`scripts/api-spec-check.ts`) is now EMPTY — every path #86 documented ahead
of its handler has one. The four architectural decisions behind the shape —
identity stays a `commerce` row never linked to `awcms_principals`, e-mail
OTP now with WhatsApp landed as a second login channel (Issue #108, contract
#106/ADR-0017 D5 — see below), an opaque `customerBearer` session
token kept in `localStorage`, and the guest-row binding rule at registration
— plus the affiliate program's own design (D5) are recorded in
[ADR-0016](../../../../../docs/adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md)
in awcms-one.

### Auth (Issue #89, wave 2 — C2)

**Application layer** (`application/customer-auth.ts`): `requestCustomerOtp`
validates `{email, purpose, name?, phone?}` — `purpose: "register"` runs the
FULL registration validator (`domain/customer-account-validation.ts`) before
issuing anything, so a malformed name/phone answers `400` before an e-mail is
ever sent — then always issues a code and always asks the
`CustomerOtpChannel` port to deliver it, so a request answers the same
`202 {sent:true, expiresInSeconds:600}` whatever happened (D2's
anti-enumeration rule; an unresolved tenant pays the same latency via
`padUnresolvedCommerceTenantLatency`). `verifyCustomerOtp` collapses EVERY
`consumeOtp` failure reason (wrong/expired/consumed/exhausted) into one
`401 OTP_INVALID`; a `purpose: "login"` with no matching account answers
`404 ACCOUNT_NOT_FOUND` (an accepted, documented exception — the mailbox
owner already received the code); `purpose: "register"` checks the phone
against every EXISTING account (`findAccountByPhone`) before calling the
already-shipped (#87) `createAccountForCustomer`, answering
`409 PHONE_ALREADY_REGISTERED` on a conflict. A blocked account can never
verify into a session (`403 ACCOUNT_BLOCKED`) but CAN still log out — see
`application/customer-session-auth.ts`'s own header for why those two are
deliberately different.

**Delivery** (`domain/customer-otp-channel.ts` + `application/
customer-otp-channel-adapters.ts`): a `CustomerOtpChannel` port with an
`email` adapter (enqueues into `email`'s outbox, inside the SAME transaction
as the OTP row, under a new derived category `derived.commerce_customer_otp`
— see the awcms-one root's cms.md deployment doc) and a `log` adapter
(writes a structured log line INCLUDING the code — the one place in this
codebase that does — selected whenever `EMAIL_PROVIDER=log` or
`EMAIL_ENABLED` is not `"true"`, so dev/CI work without mail credentials).
`commerce` gained a dependency on `email` for this (see `module.ts`), the
same way `newsletter` already depends on it for its own confirmation mail.

**Registration in the `email:dispatch` process (Issue #311).** The three `derived.commerce_*` e-mail categories (`customer_otp`, `conversation_reply`, `campaign`) are registered by ONE dependency-free side-effect file, `domain/email-template-categories.ts`, which the application files import and which `email/application/email-dispatch.ts` imports too (one recorded upstream divergence, see the root `AGENTS.md`). The registry is per process and `renderEmailTemplate` drops every variable for an unknown category, so a registration that lived only in application files the separate dispatcher never loaded sent OTP e-mails with an empty code. Add every new `derived.commerce_*` category in that file only; `tests/commerce-email-categories-dispatch.test.ts` checks it from a fresh process.

**Sessions** (`application/customer-session-auth.ts`): `requireCustomerSession`
parses `Authorization: Bearer cs_…`, looks up a live row in
`awcms_commerce_customer_sessions` (`findSessionByTokenHash`), and slides its
TTL (`touchSession`, at most once per 5 minutes) — a fifth, independent
session namespace from `awcms_sessions` (see `domain/
customer-session-token.ts`), so `identity:session-readers:check` has nothing
to say about it.

**Audit** (masked e-mail/phone only, never a code/token): `commerce.customer.
otp_requested`, `otp_verified`, `login_failed` (every verify failure,
whatever the reason — the reason lives only in `attributes.reason`),
`account_registered`, `logout`.

### Resources (Issue #91, wave 3 — C3)

Six more `/api/v1/commerce/storefront/account/*` paths land: `addresses`
(`GET`/`POST`), `addresses/{id}` (`PATCH`/`DELETE`),
`addresses/{id}/default` (`POST`), `wishlist` (`GET`/`PUT`),
`wishlist/{productId}` (`DELETE`), `orders` (`GET`, keyset), `orders/
{orderCode}` (`GET`), and `reviews` (`GET`) — every one removed from
`ROUTE_PARITY_EXEMPTIONS` accordingly.

**Addresses** (`application/customer-account-resources.ts`,
`domain/address-validation.ts`'s `validateAccountAddressInput`): the same
shipping-address shape order creation validates, PLUS a required `label`
and a required (not optional) `postalCode` — a SAVED address always carries
both, unlike a one-off order snapshot. Max 10 live addresses per account
(`409 ADDRESS_LIMIT_REACHED`); the FIRST address ever saved becomes the
default automatically; deleting the default promotes the
most-recently-created remaining one. Exactly one default per customer is
enforced by the DATABASE, not merely trusted to this application code —
`sql/920`'s partial unique index on `(tenant_id, customer_id) WHERE
is_default AND deleted_at IS NULL` (any duplicate the guest-checkout era
may have left is demoted to a single survivor by that same migration,
before the index is created).

**Wishlist** (same file): `PUT` union-merges `{productIds}` into whatever
the account already has, max 200 live rows, and returns the merged,
authoritative list; an id that is not a live product IN THIS TENANT is
silently skipped (never a `400`) — the `awcms-one-commerce` skill's own
"a bare FK cannot isolate by tenant" guard, checked here in the application
layer inside the same RLS-scoped transaction. `GET` shows published
(`status = 'active'`), non-deleted products only — a product moderated back
out of that status, or soft-deleted, simply stops appearing; the wishlist
row itself is untouched. `DELETE /wishlist/{productId}` soft-deletes and is
idempotent (always `204`, even for a product never wishlisted or a
malformed id).

**Orders** (`application/order-directory.ts`'s `listOrdersForAccount`/
`fetchOrderForAccount`): keyset-paginated (`cursor`, `limit` ≤ 50, default
20), newest first, `created_at >= account.historyFrom` (ADR-0016 D4)
enforced INSIDE the query — never merely in the route. `GET /orders/
{orderCode}` needs no phone (the bearer already proves ownership); ownership
and `historyFrom` are BOTH checked inside that same query, so an unknown
code, another account's order, and one that predates `historyFrom` all
answer the identical neutral `404`. Both reuse `toPublicOrderRecord` per
row — the SAME shape `GET .../orders/{code}?phone=` returns, per the
contract's own "same list item shape as the tracking endpoint minus nothing
sensitive".

**Reviews** (`application/review-directory.ts`'s `listReviewsForAccount`):
every review this account itself submitted, any moderation status, with the
product name and order code inlined.

**The two existing anonymous routes now accept an OPTIONAL bearer** —
`POST /storefront/orders` and `POST /storefront/reviews`. Present and valid:
the order/review's customer is the account's OWN customer row
(`createOrderFromCart`'s/`createReview`'s `accountCustomerId`), never a
`findOrCreateCustomerByPhone`/phone-matched lookup — the typed phone is
still validated for shape and is still the per-phone rate limit's key.
Present but invalid/expired: `401 UNAUTHENTICATED`, explicit — the
storefront re-reads its own session right before submit and needs to be
told plainly. Absent entirely: unchanged guest path. `POST .../orders` also
accepts `affiliateCode` in the body — shape-validated (a string, at most 50
characters) and, since Issue #92, resolved against
`awcms_commerce_affiliates.code` (see the next section).

**Data lifecycle / subject data**: `commerce.customer_addresses` and
`commerce.wishlists` (`module.ts`'s `subjectData` array) stay
`unreachableBySubject: true` — this registry's subject vocabulary is
`tenant_user_id`/`identity_id`/`profile_id`/`principal_id`, and a customer
account (ADR-0016 D1) deliberately carries none of those — but their
rationale now records that Issue #91 gives the account holder a genuine
SELF-SERVICE path to their own rows (the bearer-secured routes above),
where before this issue there was none.

### Affiliates (Issue #92, wave 4 — C4)

The last two contract-only paths land: `account/affiliate` (`GET`/`POST`)
and `account/affiliate/commissions` (`GET`, keyset) — both removed from
`ROUTE_PARITY_EXEMPTIONS`, which is now EMPTY (every path #86 documented
ahead of its handler now has one). Plus the owner side:
`/api/v1/commerce/affiliates(/{id})` and
`/api/v1/commerce/affiliate-commissions(/{id}/{approve,pay,void})`, gated on
the new `affiliates.{read,update}`/`affiliate_commissions.{read,update}`
permissions (`sql/922`).

**Schema** (`sql/921`): `awcms_commerce_affiliates` — one row per enrolled
customer, `code` (`domain/affiliate-code.ts`: 8 chars, CSPRNG, the
unambiguous alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — no `I`/`O`/`0`/`1`),
`commission_rate` (a SNAPSHOT copied from
`store_settings.affiliate_commission_rate` at enrolment time, never
re-derived afterwards), `status` (`active`/`suspended`).
`awcms_commerce_affiliate_commissions` — one row per order that ever earned
a commission (`order_id` unique, forever), `base_amount`/`rate`/`amount`
snapshots, `status` (`pending → approved/void → paid`). Plus
`awcms_commerce_orders.affiliate_id` (nullable FK, set once at
order-creation time) and `awcms_commerce_store_settings.
affiliate_commission_rate` (nullable `numeric(5,2)`, a real column outside
the settings jsonb blob — `null` means the program is OFF).

**Domain** (`domain/affiliate-commission.ts`, pure): `computeCommissionBase`
(`subtotal − discount − voucher_discount`, floored at zero, integer-cent
`BigInt` arithmetic via `price-calculation.ts`'s `toCents`/`fromCents` —
ADR-0003, never a float) and `computeCommissionAmount` (`base × rate / 100`,
rounded to the cent). `shouldEarnCommission({affiliateCustomerId,
orderCustomerId, affiliateStatus})` is `false` on self-referral OR a
suspended affiliate — evaluated TWICE: `application/affiliate-directory.ts`'s
`resolveAffiliateForOrder` only links an `active` code to a NEW order (an
unknown/suspended code resolves to `null`, never a validation error — a bad
referral must never fail a checkout); `shouldEarnCommission` re-checks both
conditions again, using the affiliate's CURRENT status, the moment the order
reaches `completed` — a code valid at checkout may belong to an affiliate
suspended before the order completes.

**Application** (`application/affiliate-directory.ts`): `enrolAffiliate` is
idempotent (an already-enrolled customer gets their existing row back, never
a second one) and throws `AffiliateProgramDisabledError` (`409
AFFILIATE_PROGRAM_DISABLED`) when `store_settings.affiliate_commission_rate`
is `null`. `fetchAccountAffiliate` returns `stats: {referredOrders,
pendingAmount, approvedAmount, paidAmount}`, computed live from
`awcms_commerce_orders`/`_affiliate_commissions`, never cached. The ONE place
a commission is created is `order-directory.ts`'s `transitionOrderStatus`,
on the transition to `completed` — calling
`recordAffiliateCommissionOnOrderCompleted` in the SAME transaction as the
status change; a `cancelled` transition calls `voidAffiliateCommissionForOrder`
(a defensive hook: `completed` has no outgoing edge in the current
`domain/order-status.ts` graph, so this cannot fire today, but reuses the
same enforcement the moment a future refund/cancel-after-completion path is
added, rather than growing a second one). Owner-side commission moderation
is a small state machine (`pending → approved → paid`, `pending|approved →
void`, anything else `409 INVALID_TRANSITION`-shaped), each transition
requiring an `Idempotency-Key` (skill `awcms-idempotency`) and its own audit
event.

**Public exposure**: `GET .../store-settings/public` exposes
`affiliateProgramEnabled: boolean` ONLY — the rate itself never crosses into
that shape, the same masking discipline `payment.manualBank`/`manualQris`
already apply to bank details. The owner-only `GET /api/v1/commerce/
store-settings` and its `PUT` DO carry `affiliateCommissionRate` (validated
0–100, two decimals, nullable) — stored in its own column, not the jsonb
`settings` blob (see `sql/921`'s header for why).

**Admin screen**: `/admin/commerce-affiliates` — an affiliates table
(code, customer, rate with an inline edit control, status,
suspend/activate) and a commissions table (affiliate, order, amount,
status, filterable by status, approve/pay/void buttons), i18n `en`+`id`.
`/admin/commerce-settings` gains the commission-rate field.

## External providers — every D1–D10 decision now implemented (epic #33 wave 0 contract — ADR-0017, issue #106)

`openapi/modules/commerce.openapi.yaml` documented the whole increment-5
external-providers surface AHEAD OF ANY HANDLER (issue #106); every path
it named now has one. **D4 (courier rates), D5 (WhatsApp), D6 (POS, issue
#116), D7 (sales reports), D8 (the inbox), D9 (consent-gated campaigns),
D10 (BjekMart Features flags + tiered pricing at quote, issue #118), and
the FULL payment gateway (D2/D3 — session creation, webhook-endpoint
tokens, webhook intake, reconcile) are IMPLEMENTED, not contract-only; see
their own sections below.** Every one of
D1–D10's ten decisions — why a port lives inside `commerce` rather than
`integration_hub`, why a webhook's tenant is resolved from an opaque
token rather than its payload, why the gateway flow is a redirect rather
than an embed, and so on — is recorded in
[ADR-0017](../../../../../docs/adr/0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md)
in awcms-one.

`ROUTE_PARITY_EXEMPTIONS` (`scripts/api-spec-check.ts`) is EMPTY again —
the discipline #86/ADR-0016 already proved for accounts, and what
awcms-one's `AGENTS.md` requires before the epic closes. Courier rates',
WhatsApp's, the inbox's, campaigns', the sales reports', the full payment
gateway's (session half AND webhook intake/reconcile) and finally POS's own
exemption entries were each removed by the child that landed the handler
(#107, #108, #111, #114, #117, #110, #113, #116) — D10 (#118) never added
one at all: every path it touches (`store-settings/public`, `cart/quote`,
`orders`) already existed, and its one new write surface (the "Fitur"
section) reuses `module_management`'s own generic, already-documented
`PATCH /api/v1/tenant/modules/{moduleKey}/settings`. The RajaOngkir env vars
(`COMMERCE_SHIPPING_RATE_PROVIDER`, `COMMERCE_RAJAONGKIR_API_KEY`, …), the
WhatsApp env vars (`COMMERCE_WHATSAPP_PROVIDER`, `COMMERCE_FONNTE_TOKEN`,
`COMMERCE_META_WA_TOKEN`, `COMMERCE_META_WA_PHONE_NUMBER_ID`, …), and the
payment-gateway env vars (`COMMERCE_PAYMENT_GATEWAY`,
`COMMERCE_MIDTRANS_SERVER_KEY`, `COMMERCE_MIDTRANS_IS_PRODUCTION`, …) ARE
already read/declared/checked, and documented in the
[awcms-one deployment guide](../../../../../docs/deployment.md) — see
the "Courier rates"/"WhatsApp outbox"/"Payment gateway" sections below.

## Courier rates: RajaOngkir, cached (Issue #107, contract #106 D4)

`ShippingRateProvider` (`domain/shipping-rate-provider.ts`) is a port —
`searchDestination(query)`, `getRates({originId, destinationId,
weightGrams, couriers})` — modelled on `email`'s provider contract:
`infrastructure/rajaongkir-provider.ts` (Komerce API v2, `withTimeout` +
`getProviderCircuitBreaker("commerce-rajaongkir")`) and
`infrastructure/log-shipping-rate-provider.ts` (deterministic fixtures)
both implement it, resolved by `infrastructure/shipping-rate-provider-
resolver.ts` from `COMMERCE_SHIPPING_RATE_PROVIDER`.

**Caching** (`sql/924`, `application/shipping-rate-directory.ts`):
`awcms_commerce_courier_destinations` maps a tenant's own
`idn_admin_regions` district code to the provider's own destination id
(resolved once by a name search, no TTL); `awcms_commerce_shipping_rates`
caches a rate per `(tenant, provider, origin, destination, weight bucket,
courier, service)`, TTL 6 hours, purged hourly by
`commerce:shipping-rates:purge`. `domain/weight-bucket.ts`'s
`computeWeightBucketGrams` rounds a cart's total weight up to the next
100 g, floored at 1000 g (RajaOngkir's own minimum billable weight).

**The provider is never called inside a DB transaction** (ADR-0006/0010):
`getCourierRates`/`resolveDestination` read the cache in one short
transaction, call the provider with none open at all, then write back in a
second short transaction (`ON CONFLICT ... DO UPDATE` — a concurrent miss
just means the last writer wins).

**Quote**: `POST .../cart/quote` accepts an optional `destination:
{districtCode}`; with `shipping.courier.enabled`, a configured provider,
and a destination, `shippingOptions[]`'s courier entries are live per-
service rates (`{method:"courier", serviceId:"jne:REG", name, cost, etd,
available:true}`); otherwise a single `available:false` placeholder with a
`note`. **Order creation** validates a `{method:"courier", serviceId}`
selection against a non-expired cached rate keyed off the delivery
address's own `districtCode` — never a second live provider call inside
`createOrderFromCart`'s write transaction; a stale/unknown selection
answers the same `409 CART_CHANGED` every other mismatch does.

**Settings**: `shipping.courier = {enabled, originDestinationId,
couriers[]}` (owner, `PUT /store-settings`) is the on/off switch, this
tenant's own RajaOngkir origin, and which courier codes to quote.
`GET /api/v1/commerce/shipping/destinations?search=` (owner-only,
`settings.update`) backs the admin origin picker. The public
`shipping.courierEnabled` is derived — `true` only when `courier.enabled`
AND a provider is configured, never a raw copy of the stored flag.

## WhatsApp outbox & OTP — IMPLEMENTED (Issue #108, epic #33 — contract #106/ADR-0017 D5)

A second provider outbox, modelled on `email` exactly (ADR-0017 D1 — every
external provider is a port + adapters inside `commerce`): own table(s), a
dispatcher job, `log` adapter for dev/CI, provider calls never inside a DB
transaction.

**Schema** (`sql/925`): `awcms_commerce_whatsapp_messages` (`queued ->
sending -> sent|failed`, `attempts`/`next_attempt_at` claim lease —
identical shape to `awcms_email_messages`) and
`awcms_commerce_whatsapp_delivery_attempts` (per-attempt ledger, `UNIQUE
(message_id, attempt_no)`). `to_phone` is kept in the clear — same
reasoning `sql/913`'s header gives for `customers.phone`: a provider adapter
cannot deliver a message knowing only a hash — alongside `to_phone_hash`/
`to_phone_masked`. `sql/925` also adds a nullable `phone_normalized` column
to `awcms_commerce_customer_otps`, relaxing `email_normalized`'s own `NOT
NULL` to a `CHECK` that at least one identifier is present.

**Domain**: `domain/whatsapp-provider.ts` (the `WhatsappProvider` port —
`send`/`healthCheck`, mirrors `email-provider-contract.ts`), `domain/
whatsapp-templates.ts` (a MODULE-LOCAL, in-code template registry —
`commerce.customer_otp`/`commerce.order_paid`/`commerce.campaign`, `{{var}}`
rendering with a per-template variable allowlist; only `commerce.
customer_otp` is wired to a caller in this issue — deliberately NOT the
`email` module's DB-backed, per-tenant-editable templates, since a WhatsApp
template is also subject to the provider's own approval process, e.g. Meta's
`COMMERCE_META_WA_OTP_TEMPLATE`).

**Infrastructure** (`infrastructure/`): `fonnte-provider.ts` (`POST
{baseUrl}/send`, `Authorization: <token>` header, form `target`/`message`,
JSON `{status, reason?, id?}`), `meta-whatsapp-provider.ts` (Graph API `POST
/{phoneNumberId}/messages`, `Bearer` token, a TEMPLATE message for OTP —
`{{1}}` filled with the code, template name from
`COMMERCE_META_WA_OTP_TEMPLATE` — or a free TEXT message otherwise),
`log-whatsapp-provider.ts` (structured log line, the ONE place that logs an
OTP code in the clear), and `whatsapp-provider-resolver.ts` (`COMMERCE_
WHATSAPP_PROVIDER=fonnte|meta|log`, degrading to a clean failed-result
provider on misconfiguration rather than throwing).

**Application**: `whatsapp-enqueue.ts` (`enqueueWhatsappMessage(tx, …)` —
inside the CALLER's own transaction, same as `email`'s direct-address
enqueue), `whatsapp-dispatch.ts` (`dispatchWhatsappQueue`, claim/send/
finalize, lease, circuit breaker, backoff — `bun run
commerce:whatsapp:dispatch`, `*/2 * * * *`), `whatsapp-queue-purge.ts`
(terminal-row retention — `bun run commerce:whatsapp:purge`, `*/15 * * * *`),
`whatsapp-message-directory.ts` (keyset-paginated diagnostics read).
`COMMERCE_WHATSAPP_ENABLED=true` gates claiming, exactly like
`EMAIL_ENABLED` gates the email dispatcher.

**OTP as a third `CustomerOtpChannel`** (`application/
whatsapp-otp-channel-adapter.ts`): `createWhatsappCustomerOtpChannel`
enqueues into the outbox inside the SAME transaction as the OTP row;
`createLogWhatsappCustomerOtpChannel` logs the code instead (dev/CI).
`resolveWhatsappCustomerOtpChannel`/`isWhatsappOtpChannelAvailable` share
ONE gate, `COMMERCE_WHATSAPP_ENABLED === "true"` — the same condition
`dispatchWhatsappQueue` uses to decide whether to claim anything at all.

`POST .../account/otp/request` accepts `via?: "email"|"whatsapp"` (default
`email`). `via: "whatsapp"` requires `phone` (E.164 via `domain/
phone-normalisation.ts`), only ever supports `purpose: "login"` (a `register`
combination is a `400 VALIDATION_ERROR` — registration stays e-mail OTP
only, ADR-0016 D2's WhatsApp follow-up landed narrower than that ADR's own
"a customer never needs an e-mail" framing), and answers `409
CHANNEL_UNAVAILABLE` — checked and answered BEFORE an OTP row is ever
issued — when the channel is disabled/unconfigured (a configuration fact,
not a new enumeration oracle: independent of whether the phone supplied has
an account). `POST .../account/otp/verify` accepts `phone` as an
alternative to `email` (mutually exclusive; `identifierColumn` picks
`phone_normalized` over `email_normalized` in `customer-account-store.ts`'s
`issueOtp`/`consumeOtp`), and resolves the account via `findAccountByPhone`
rather than `findAccountByEmail` — "login by phone" means the account whose
CUSTOMER row carries that phone.

**Owner diagnostics**: `GET /api/v1/commerce/whatsapp/messages`
(`commerce.whatsapp.read`, keyset-paginated, masked phone only) plus a
minimal `/admin/commerce-whatsapp` screen (status filter, no create/update/
delete action over the outbox in this issue).

## Commerce inbox — IMPLEMENTED (Issue #111, epic #33 — contract #106/ADR-0017 D8)

A verified customer account's own thread with the store — never a guest
checkout customer, who has no account row to hang a thread off of.

**Schema** (`sql/927`): `awcms_commerce_conversations` (`account_id NOT
NULL` FK to `awcms_commerce_customer_accounts`, `subject` 1-150 chars,
`status` `open|closed`, `last_message_at`, `unread_for_store`/
`unread_for_customer` booleans) and `awcms_commerce_messages` (append-only,
like `awcms_commerce_order_events` — no `deleted_at`/`updated_at`; `sender`
`customer|store`, `sender_tenant_user_id` set for a store message only,
`body` 1-4000 chars). `last_message_at`/both `unread_for_*` flags are
DENORMALIZED, kept in step with every message insert inside the SAME
transaction — never a join-derived value at read time.

**Application** (`application/conversation-directory.ts`): customer-side
(`listConversationsForAccount`, `openConversation`,
`fetchConversationForAccount` — marks the thread read for the customer,
`postCustomerMessage` — `409`-shaped `{kind:"closed"}` once the thread is
closed) and store-side (`listConversationsForAdmin` — filterable by
`status`/`unreadForStore`, `fetchConversationForAdmin` — marks it read for
the store, `postStoreReply` — implicitly reopens a closed thread AND
enqueues the reply e-mail in the same transaction, `setConversationStatus`
— the explicit close/reopen with no message attached).
`ensureConversationReplyTemplate` auto-seeds the
`derived.commerce_conversation_reply` e-mail template on first miss, the
identical pattern `application/customer-otp-channel-adapters.ts`'s
`ensureCustomerOtpTemplate` already established.

**Routes**: `GET`/`POST /api/v1/commerce/storefront/account/conversations`,
`GET .../{id}` (bearer), `POST .../{id}/messages` (bearer, rate-limited
10/h per account via `COMMERCE_CONVERSATION_POST_RATE_LIMIT_MAX`); owner
`GET`/`PATCH /api/v1/commerce/conversations(/{id})`,
`POST .../{id}/messages` (`commerce.conversations.read|update`,
`Idempotency-Key` required on the reply — the one high-risk mutation in
this surface, since it enqueues an e-mail).

**Admin screen**: `/admin/commerce-inbox` — a conversation list with
status/unread filters and an unread badge, a thread view (`?id=`), a reply
form (client script sends `Idempotency-Key`), and close/reopen buttons.

## Customer campaigns — IMPLEMENTED (Issue #114, epic #33 — contract #106/ADR-0017 D9)

A consent-gated mass e-mail/WhatsApp send, reusing the SAME outboxes D5/D8
already dispatch from — no third delivery mechanism.

**Schema** (`sql/929`): `awcms_commerce_customer_accounts` gains
`marketing_consent_at timestamptz` (nullable — non-null means opted in at
that instant); `awcms_commerce_campaigns` (`channel` `email|whatsapp`,
`subject`/`body`, `audience jsonb`, `status`
`draft|scheduled|sending|sent|cancelled`, `scheduled_at`/`sent_at`,
`recipient_count`) and `awcms_commerce_campaign_recipients` (one row per
resolved recipient, `UNIQUE (campaign_id, customer_id)`, `address_masked`
never a raw address, `status` `queued|enqueued|skipped`) — the
resumability/audit ledger a partial send relies on. Permission seed
`sql/930` (`commerce.campaigns.{read,update,send}`).

**Domain** (`domain/campaign-validation.ts`, `domain/campaign-content.ts`):
audience shape validation (`{levels[], hasAccount, lastOrderSince}`),
channel-conditional `subject` requirement (required for `email`, ignored
for `whatsapp`), and allowlisted `{{name}}`/`{{storeName}}` rendering — an
unknown placeholder is left as a literal, fail-closed.

**Application** (`application/campaign-directory.ts`): CRUD (`create`
always `draft`, `update` only while `draft`), `resolveCampaignAudiencePage`/
`countCampaignAudience` — the ONE place consent (`marketing_consent_at IS
NOT NULL`) and the channel-address requirement are enforced, both baked
into the WHERE clause itself, never filtered afterwards; `sendCampaign`
(moves to `scheduled`, `scheduled_at = now()` for an immediate send —
actual fan-out happens later, on the dispatcher's own tick) and
`cancelCampaign` (stops further dispatch; already-enqueued recipients are
not un-sent).

**Dispatcher** (`application/campaign-dispatch.ts`, script
`commerce:campaigns:dispatch`, every 1-2 minutes as `awcms_worker`):
CLAIM (one short transaction, `FOR UPDATE SKIP LOCKED` over
due/resumed campaigns) → PAGE (loop pages of 200 not-yet-recorded
customers — the resolver's own `NOT EXISTS` against
`awcms_commerce_campaign_recipients` is what makes this resumable without
a separate cursor column; re-checks the campaign's live `status` before
every page, so a `cancel` stops further dispatch immediately) → FINALIZE
(an empty page marks the campaign `sent`, `recipient_count` = the total
recipient rows). E-mail fan-out calls the `email` module's own
`enqueueDirectAddressEmail` against a pass-through `derived.commerce_campaign`
template (auto-seeded on first miss, same pattern
`ensureConversationReplyTemplate` established) — `commerce` never writes
`awcms_email_messages` directly (`modules:table-writes:check`). WhatsApp
fan-out uses the pre-reserved `commerce.campaign` template key
(`domain/whatsapp-templates.ts`).

**Routes**: owner `GET`/`POST /api/v1/commerce/campaigns`,
`GET`/`PATCH .../{id}`, `POST .../{id}/preview` (count only, never a
resolved list), `POST .../{id}/{send,cancel}` (`Idempotency-Key` required,
gated on the separate `commerce.campaigns.send` permission — a role
trusted to draft/edit is not automatically trusted to fire/cancel).
`GET`/`PATCH /api/v1/commerce/storefront/account/me` gains
`marketingConsent: boolean` — toggled only by the account itself, audited
on both grant and revoke.

**Admin screen**: `/admin/commerce-campaigns` — a campaign list, a
create-draft form (channel, subject, message, customer-level checkboxes),
and a detail/editor panel (`?id=`) with an audience-preview button
(count only) and send/cancel actions (both `window.confirm`-gated).

**Subject data**: both tables are `unreachableBySubject: true` in
`module.ts` — the owning customer account carries no `tenant_user`/
`identity`/`profile`/`principal` id (ADR-0016 D1), the identical gap
`commerce.customer_addresses`/`commerce.wishlists` already document; an
account holder reaches their own threads through the bearer routes above,
outside this repo's automated per-subject engine by construction.

## Payment gateway — session creation (Issue #110, epic #33 — contract #106/ADR-0017 D2/D3)

`PaymentGatewayProvider` (`domain/payment-gateway-provider.ts`) is a
port — `createSession`, `fetchStatus`, `verifyWebhook` — modelled on
`ShippingRateProvider`: `infrastructure/midtrans-provider.ts` (Snap `POST
/snap/v1/transactions`, `GET /v2/{orderId}/status`, `withTimeout` +
`getProviderCircuitBreaker("commerce-midtrans")`, sandbox/production base
URLs by `COMMERCE_MIDTRANS_IS_PRODUCTION`) and
`infrastructure/log-payment-gateway-provider.ts` (no network call;
`redirectUrl` is `${COMMERCE_STOREFRONT_PUBLIC_URL}/pesanan?kode=...
&gateway=log`; `fetchStatus` answers `paid` once 60 real seconds have
elapsed, via an injectable clock and a timestamp folded into
`providerRef` — deterministic, no sleeping in tests) both implement it,
resolved by `infrastructure/payment-gateway-provider-resolver.ts` from
`COMMERCE_PAYMENT_GATEWAY` (`log` refused outside non-production).

**Schema** (`sql/926`): `awcms_commerce_payment_gateway_sessions` (one row
per hosted-checkout attempt, `UNIQUE (provider, provider_ref)`),
`awcms_commerce_payment_events` (the D2 replay-protection ledger, `UNIQUE
(tenant_id, provider, event_key)` — written by the webhook intake route,
see "Payment gateway — webhook intake + reconcile" below), `awcms_commerce_webhook_endpoints` (a hashed
opaque token per (tenant, provider)); `orders` gains `gateway_provider`/
`gateway_ref`. A `SECURITY DEFINER` `awcms_resolve_commerce_webhook_endpoint
(token_hash)` mirrors `awcms_resolve_tenant_domain_lookup`'s bootstrap
pattern exactly.

**Application** (`application/payment-gateway-directory.ts`):
`createGatewaySession(sql, tenantId, orderCode, auth, provider,
providerKey)` — validate the order (`payment.method: "gateway"`,
`pending_payment`) and check for a still-live session in one short
transaction, call the provider with NONE open, persist in a second short
transaction (ADR-0006/0010, the same discipline
`shipping-rate-directory.ts`'s `getCourierRates` established); a
genuinely concurrent double-create is caught by the `UNIQUE (provider,
provider_ref)` constraint and re-fetches the winner rather than 500ing.
Auth is `{phone}` or a customer bearer, matching `POST .../orders`'s own
optional-bearer pattern; a wrong phone, unknown order, or a live bearer
for a different order's owner all answer the SAME neutral 404 the
order-tracking route uses.

**Quote**: `POST .../cart/quote`'s `paymentMethods[]` gains `{method:
"gateway", available}` — `true` only when `payment.gateway.enabled` AND a
provider is configured.

**Routes**: `POST .../storefront/orders/{orderCode}/payment-gateway/sessions`
(anonymous, rate-limited, `409 PAYMENT_NOT_APPLICABLE`, `503
GATEWAY_UNAVAILABLE`); owner `GET|POST /api/v1/commerce/webhook-endpoints`
(masked list; the raw token is shown exactly once at creation, hashed at
rest — deliberately NOT idempotency-keyed, the same reasoning
`identity-access`'s `machine-credential-directory.ts` gives for its own
issuance route) and `DELETE .../webhook-endpoints/{id}` (revoke,
idempotent); both gated on `commerce.webhook_endpoints.update`.

**Settings**: `payment.gateway = {enabled}` (owner, `PUT /store-settings`)
is the on/off switch; the public `payment.gatewayEnabled` is derived —
`true` only when `gateway.enabled` AND a provider is configured, never a
raw copy of the stored flag. `/admin/commerce-settings` gains the enable
toggle plus a webhook-endpoints panel.

## Payment gateway — webhook intake + reconcile IMPLEMENTED (Issue #113, epic #33 — contract #106/ADR-0017 D2)

**Webhook route** (`src/pages/api/v1/commerce/webhooks/[provider]/[endpointToken].ts`,
thin per `awcms-new-endpoint`; logic in `application/payment-webhook-
intake.ts`): public, `POST`-only, registered in `lib/security/api-body-
auth-boundary.ts`'s exemption list (same family as `/api/v1/sync/push`'s
HMAC entries — a credential OTHER than a session). Gate order: body read
(size-capped) → `resolveWebhookEndpoint` (hashes the token, calls
`awcms_resolve_commerce_webhook_endpoint` on the plain pool client, no
tenant context yet) → unknown/revoked token OR a `{provider}` path segment
mismatch OR no provider configured all answer the SAME neutral `404`,
padded to a floor latency (`NEUTRAL_404_MIN_LATENCY_MS`) → `provider.
verifyWebhook(...)` (bad signature → `401`) → `applyVerifiedWebhookEvent`,
ONE `withTenantOrThrow` transaction: `INSERT … ON CONFLICT (tenant_id,
provider, event_key) DO NOTHING` (0 rows → `{kind: "replay"}`, `200`, no
side effect) → status-mapped apply. This route NEVER calls the provider's
`fetchStatus` — that stays the reconcile job's own exclusive concern.

**Amount guard** (`domain/payment-amount-guard.ts`, `sql/934`): the
provider-reported `gross_amount` must equal the order's `total` in integer
cents before ANY order transition. A mismatch/unparseable amount records
the event as `outcome = 'amount_mismatch'`, writes an audit entry, moves
the session to `failed` only on a terminal provider failure (otherwise
leaves it `pending`), never marks the order paid, and still answers `200`.
The reconcile job applies the same guard to `fetchStatus`'s `gross_amount`.

**`markOrderPaidBySystem`** (`application/order-directory.ts`) — actor
`system`, sets `paid_at`/`payment_status`/`gateway_provider`/`gateway_ref`,
an `order_events` row, and an audit-log entry; idempotent (already-`paid`
or any non-`pending_payment` status is a no-op, never an error).
`domain/order-status.ts` gains the `system` edge `pending_payment -> paid`
alongside the existing `-> expired`. **`paid -> refunded` is deliberately
NEVER auto-applied** — there is no `refunded` order status at all; a
gateway-reported refund is recorded as a payment event only, and the owner
refunds manually via the existing admin `-> cancelled` action. See
`order-status.ts`'s own header for the full reasoning.

**Reconcile job** `commerce:payments:reconcile` (`scripts/commerce-
payments-reconcile.ts`, registered in `module.ts`'s `jobs`, `*/2 * * * *`,
`background_sync` work class): for every active tenant, every gateway
session still `pending` more than 2 minutes old gets one `provider.
fetchStatus` call with NO transaction open (timeout + circuit breaker live
INSIDE the adapter itself); a fetch failure just skips that session for
this tick. Every session past `expires_at` is expired regardless of what
`fetchStatus` says. `application/payment-reconcile.ts` also exposes
`reconcileOneOrderPaymentSession` — the admin "Cek status" action's own
SCOPED single-order variant (`POST /api/v1/commerce/orders/{id}/payment-
gateway/reconcile`, gated `commerce.orders.update`, `Idempotency-Key`
required), never the full batch.

**Admin**: the order list screen (`/admin/commerce-orders` — this module
has no separate order DETAIL page) gains a per-row expandable read-only
panel (gateway session status/provider/expiry plus the payment-events
list, via `GET /api/v1/commerce/orders/{id}`'s new `gateway` field) and
the "Cek status" button described above.

**Tests**: unit tests cover route gate ordering (public/POST-only, unknown
token → padded 404), `verifyWebhook` failure → 401, and replay → 200
no-op, all with a mocked provider; an integration test against a real,
migrated Postgres covers the full webhook-paid path, replay-is-a-no-op,
the reconcile job with the `log` provider, and cross-tenant RLS isolation
of a webhook-endpoint token.

## Feature toggles & tiered pricing — IMPLEMENTED (Issue #118, epic #33 C9 — contract #106/ADR-0017 D10, ADR-0016 D6)

BjekMart's "Features" screen is `module.ts`'s own `settings.defaults.features`
— `{pos, inbox, campaigns, gateway, courier}`, every flag `true` by default
(`domain/commerce-features.ts`'s `DEFAULT_COMMERCE_FEATURES`) — read/written
through `module_management`'s GENERIC tenant-settings service
(`fetchModuleSettingsView`/`updateModuleSettings`, `awcms_module_settings`),
the first time `commerce` declares a `settings` contract at all.
`resolveCommerceFeatures` resolves each flag INDEPENDENTLY against the
defaults (never assumes the whole `features` object exists), which is what
makes a future sixth flag migration-free for a tenant who already saved a
settings row — the same reasoning `module-settings.ts`'s own shallow
top-level merge already gives for the module as a whole, one level deeper.

**The 409-vs-404 rule** (`domain/commerce-features.ts`'s own header,
`application/commerce-feature-gate.ts`'s `requireCommerceFeatureForOwnerRoute`/
`requireCommerceFeatureForPublicRoute`): a disabled feature answers
`409 FEATURE_DISABLED` on every AUTHENTICATED owner route (the caller already
proved who they are — the tenant's own configuration is what blocks them, and
they need to see why) and a neutral `404` — or, on the ONE route that already
had a dedicated "not usable right now" code, the pre-existing
`503 GATEWAY_UNAVAILABLE` — on every ANONYMOUS/public route (never `409`,
which would tell a prober a route exists at all, the same anti-oracle rule
`public-commerce-tenant.ts` already enforces for an unresolved tenant).

**Gated**: inbox (owner `/conversations*`, storefront
`/storefront/account/conversations*`), campaigns (owner `/campaigns*`),
gateway (owner `/webhook-endpoints*`; storefront `.../payment-gateway/sessions`
folded into its existing 503; the PUBLIC `/webhooks/{provider}/{endpointToken}`
intake answers the SAME neutral 404 an unknown token does), courier (owner
`GET /shipping/destinations`). `pos` has no enforcing route yet — issue #116
lands that gate on its own branch, in parallel; the flag exists now so the
settings document's shape does not change again when it does.

**Admin navigation** hides the Inbox/Campaigns sidebar entries the instant
their feature is off (`ModuleNavigationEntry.requiredFeature`, a new,
additive field on the shared nav-entry contract; resolved per-request in
`AdminLayout.astro` from the same `fetchCommerceFeatures` call the routes
use — `module_management`'s own `sidebar-menu.ts`/`sidebar-menu-config.ts`
never import `commerce`, keeping the existing one-way module dependency
direction).

**Public store settings** (`GET .../store-settings/public`) — `toPublicRecord`
now takes two more parameters, both defaulted so every pre-#118 call site
(including test literals) keeps compiling and computing the SAME answer it
always did: `shipping.courierEnabled`/`payment.gatewayEnabled` gain an
ADDITIONAL `features.courier`/`features.gateway` AND-term (unchanged names,
same masking discipline), and two new top-level booleans join them —
`inboxEnabled`/`campaignsEnabled` (the raw flag; neither has its own
store-setting toggle to AND against) and `whatsappOtpEnabled`
(`infrastructure/whatsapp-provider-resolver.ts`'s new
`isWhatsappProviderConfigured` — NOT a `features.*` flag, since Issue #108
never gained one; `apps/storefront`'s `masuk.astro`/`daftar.astro` already
read this exact key).

**Settings form**: `/admin/commerce-settings` gains a "Fitur" section that
writes through the GENERIC `PATCH /api/v1/tenant/modules/commerce/settings`
route — i.e. `updateModuleSettings`, audited under
`module_management.settings_updated` with a safe key-names-only diff — gated
on `module_management.settings.update`, a DIFFERENT permission from this
screen's own `commerce.settings.update` (the same distinction the
webhook-endpoints section already draws against
`commerce.webhook_endpoints.update`). The client always submits the WHOLE
`features` object: `updateModuleSettings`'s merge is shallow and top-level,
so a partial patch would silently disable every flag the tenant did not just
touch.

**Tiered pricing** (closing [ADR-0016](../../../../../docs/adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md)
D6's own deferred note): `domain/cart-quote.ts`'s `quoteCart` accepts an
optional `customerLevel` (1–4); `resolveTierPrice` picks `price_level_{n}`
for a line with no active flash sale and no variant price override, falling
back to `price` when the merchant never set that tier or the level is
1/absent — applied BEFORE `computeFinalPrice`'s own `discountPercent`, so
the same discount rule still governs whichever base price won.
`POST .../storefront/cart/quote` resolves the level from an OPTIONAL
`Authorization: Bearer` (`requireCustomerSession`; missing/invalid never
fails the quote — it just means level 1). `application/order-directory.ts`'s
`createOrderFromCart` now fetches the account's own customer row (when
`accountCustomerId` is present) BEFORE its internal re-quote, not after, so
the SAME level prices both the quote the shopper already saw and the order
it becomes — quote and order can never disagree. **The level is snapshotted
on the order only IMPLICITLY**, through the unit price baked into
`order_items.unit_price` at creation time; there is no separate
`orders.customer_level` column (this issue needs no migration), and a later
change to the customer's own level never retroactively re-prices a past
order. The customers admin screen's `level` edit (`/admin/commerce-customers`,
`commerce.customers.update`, audited) already existed since Issue #29 —
#118 adds no new customer-editing surface, only this quote/order-side
consumer of that same column.

## Sales reports — IMPLEMENTED (Issue #117, epic #33 — contract #106/ADR-0017 D7)

Three `cursor_table` projections this module contributes to the `reporting`
engine (Issue #753) from its own `module.ts` (`reportingProjections`) —
`commerce.sales_daily`, `commerce.sales_by_product`,
`commerce.sales_by_category` — over `awcms_commerce_order_events`, the
append-only status-transition log. The engine keeps its cursor, freshness,
rebuild-run, reconciliation and export machinery; this module supplies the
descriptor, the pure delta rules and the sinks that write its own three
tables (`sql/933`).

| Piece | Where | What it does |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delta rules | `domain/sales-report-deltas.ts` (pure) | `resolveSalesDeltaDirection`: `-> paid` from a not-yet-paid state is `+1`; `-> cancelled                                                                                                                                                                                                                                                                                                                                                                                                                                                      | refunded` from a paid state (`paid | processing | shipped | completed`) is `-1`; everything else is `0`(creation, fulfilment steps, a never-paid cancellation/expiry, a refund after a cancellation).`computeSales{Daily,ByProduct,ByCategory}Delta(s)` turn one order snapshot + a sign + a day into additive deltas in integer cents (`bigint`, `toCents`); `formatCentsDelta`renders a SIGNED`numeric(14,2)`string. Day = the order's`paid_at`in`SALES_REPORT_TIME_ZONE` (`Asia/Jakarta`), so a reversal lands on the same day row as its payment |
| Keys | `domain/sales-report-keys.ts` | Projection keys, the shared stream key, the scalar metric key (`paid_events`) and the reconciliation control keys |
| Sinks + hooks | `application/sales-report-projection.ts` | `applySales{Daily,ByProduct,ByCategory}Batch` (the `ProjectionDimensionalSink`s): drop the `0` rows, load one snapshot per order (header + live items + each item's product category, LEFT JOINs), run the delta functions, upsert `ON CONFLICT DO UPDATE SET x = x + EXCLUDED.x`. The `ProjectionDimensionalContract`s: `resetForTenant` (rebuild reset), `readProjectionTotals` (`SUM()` over the table), `computeSourceTotals` (walks the whole event stream through the same delta functions), `exportRows` (the tabular CSV/JSON export) |
| Query validation | `domain/sales-report-query.ts` (pure) | `from`/`to` inclusive `YYYY-MM-DD` report-zone days, default the last 30 days, at most 366; `limit` 1–200, default 20 |
| Reads | `application/sales-report-directory.ts` | `listSalesDaily`, `listSalesByProduct` (grouped, best-selling by gross first), `listSalesByCategory` (sentinel → `categoryId: null`) — used by the routes and the screen alike |
| Routes | `src/pages/api/v1/reports/commerce/{sales-daily,sales-by-product,sales-by-category}.ts` | `defineTenantRoute`, `reporting.dashboard.read`, `reporting` work class; owned by this module via `api.routes: ["/api/v1/reports/commerce"]` |
| Screen | `src/pages/admin/commerce-reports.astro` | Date range (GET form), three tables, freshness panel (`reporting.projections.read`), **Export CSV** per projection through `POST /api/v1/reports/exports/trigger` (`reporting.exports.export`), recent export runs with download links (`reporting.exports.read`). Nav entry order 16, gated on `reporting.dashboard.read` |
| Tests | `tests/commerce-sales-report-domain.test.ts`, `tests/integration/commerce-sales-reports.integration.test.ts` | Pure rules + registry pairing; against a real Postgres: paid → rows, cancel-after-paid → subtracted on the same day, rebuild byte-equal to live, reconcile with no mismatch (and a tampered table IS flagged), tabular export, RLS |

**The one engine change** (`MODULE_CONTRACT_VERSION` 4.1.0 → 4.2.0,
additive): `ProjectionCursorStream.dimensional` (`selectColumns` +
`applyBatch`) and `ProjectionDescriptor.dimensional` (the four hooks). The
incremental worker and the rebuild pass call the sink on every fetched batch
inside the same transaction, after the (tenant, projection) advisory lock
and before the cursor advance; the rebuild reset calls `resetForTenant` in
the same transaction as the cursor/metric reset; reconciliation merges the
dimensional control totals into its detail rows; export generation writes
the dimensional rows instead of the scalar metric snapshot.
`reporting:projections:registry:check` enforces the pairing both ways. No
existing descriptor changes.

**Why `from_status` decides "after a paid event".** The status graph
(`domain/order-status.ts`) only lets an order reach a paid state through
`paid`, so an event LEAVING a paid state is, by construction, an event after
a paid event — decidable from the one row in hand, no per-order state to
carry between passes. `refunded` is not a status the current graph emits
(refunds arrive through `payment_status`), but the contract names it and a
gateway's refund notification may log it, so it is handled exactly like
`cancelled`; `cancelled -> refunded` contributes nothing, so an order is
never subtracted twice.

**Known limitation — category is a live join.** `awcms_commerce_order_items`
snapshots the product name but not its category, so by-category attribution
reads `products.category_id` at processing time; recategorising a product
does not move past sales, and a rebuild re-attributes them under the new
category. The reconciliation control totals are category-agnostic, so this
is a difference between two rebuilds, never a reconcile mismatch.

**Worker grants, retention.** `awcms_worker` gets `SELECT, INSERT, UPDATE,
DELETE` on the three tables (`sql/933`, mirrored in `WORKER_ROLE_GRANTS`) —
the upsert needs UPDATE, the generic data-lifecycle purge needs DELETE; the
rebuild reset's own delete runs as `awcms_app` in the API route's
transaction. Retention is answered by three `dataLifecycle` descriptors in
`module.ts` (cursor `day`, 365–3650 days, the same window as
`commerce.order_events`: a row older than its source's retention can never
be rebuilt and is safe to purge); subject data by `NO_SUBJECT_DATA` in the
script ledger — derived, rebuildable aggregates about nobody.

## Point of sale — IMPLEMENTED (Issue #116, epic #33 C7 — contract #106/ADR-0017 D6)

BjekMart's kasir as one more order-creation path over the SAME order
tables, quote engine and status graph — never a second sales ledger. A
staff member holding `commerce.pos.create` rings up a counter sale; the
order is created ALREADY `paid`, attributed to a walk-in or a
phone-identified customer, and stamped `channel = 'pos'`.

| Piece                | Where                                                                                                                                   | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema               | `sql/931`, `sql/932`                                                                                                                    | `orders.channel text NOT NULL DEFAULT 'storefront' CHECK IN ('storefront','pos')`; `orders.pos_cashier_tenant_user_id uuid` (a plain stamp — NOT a FK: a fiscal record outlives a staff account); `payment_method`'s CHECK dropped and re-created with `cash` added (why it is `text + CHECK`, not an `ENUM`); `(tenant_id, channel, created_at DESC)` for the history scan; partial `(tenant_id, pos_cashier_tenant_user_id, created_at DESC) WHERE … IS NOT NULL` for the cashier filter; the one permission seed `commerce.pos.create`. No new table, no new worker grant.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Domain               | `domain/pos-order-validation.ts`, `domain/commerce-order-types.ts`, `domain/phone-normalisation.ts`                                     | `PaymentMethod` += `"cash"` (re-exported by `packages/kontrak`); the storefront's `order-request-validation.ts` allow-list deliberately does NOT widen. `validateCreatePosOrderInput(body, idempotencyKeyHeader)`: `lines[] {productId, variantId?, quantity 1..10000}`, optional `customer {name?, phone?}`, `payment {method: cash\|manual_qris, amountTendered}` — `amountTendered` REQUIRED for cash as a `numeric(14,2)` STRING (a JSON number is refused), forced `null` for QRIS. `computeChange(amountTendered, total)` subtracts in `bigint` cents, returns a string (ADR-0003), throws `InsufficientTenderError` (carrying `shortfall`) on a short tender. `POS_WALK_IN_CUSTOMER_SENTINEL_PHONE = "+620000000000"`, `POS_WALK_IN_CUSTOMER_NAME = "Pelanggan Walk-in"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Application          | `application/pos-directory.ts`                                                                                                          | `createPosOrder`: idempotency lookup (scope `commerce.pos.create`, hash bound to the acting tenant user; mismatch → `IdempotencyPayloadMismatchError`) → customer FIRST (no phone → walk-in row via `findOrCreateCustomerByPhone` + sentinel; a phone → normalised find-or-create, `invalid_phone` outcome if it does not normalise; the customer's `level` prices the quote, #118) → `buildCartQuote` (`self_pickup`, no voucher/insurance/address; only `canCheckout` decides — a tenant that never enabled self-pickup can still sell at the counter; the store's tax setting applies) → insert order (`pending_payment`/`unpaid`/`channel pos`/cashier stamp) + items, decrement stock/flash-sale quota, initial `order_events` row actor `admin`, audit `commerce.pos.sale` (no PII), `commerce.order.created` (`payload.channel: "pos"`) → `applyPosOrderPaidTransition` (`order-directory.ts`, the shared `transitionOrderStatus` with actor `admin`: `paid_at`, `payment_status paid`, second `order_events` row, `update` audit, `commerce.order.paid` — which is what #117's projections consume) → `saveIdempotencyRecord` of the 201 body. `listPosOrders`: keyset, `channel = 'pos'`, inclusive `dateFrom`/`dateTo`, `cashierTenantUserId`, 50/page. |
| Storefront exclusion | `application/order-directory.ts`                                                                                                        | `fetchOrderForTracking`, `listOrdersForAccount`, `fetchOrderForAccount` serve `channel = 'storefront'` only (the sentinel phone is documented — honouring it on the tracking lookup would make every walk-in receipt readable by order code); `createOrderFromCart` refuses the sentinel phone as a customer identity (`invalid_phone`). The admin order list stays channel-agnostic.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Routes               | `pages/api/v1/commerce/pos/orders/index.ts`                                                                                             | `defineTenantRoute`, both handlers gated by `requireCommerceFeatureForOwnerRoute(tx, tenantId, "pos")` (→ `409 FEATURE_DISABLED`). `GET` (`commerce.orders.read`): `?cursor&dateFrom&dateTo&cashier` (a bare `YYYY-MM-DD` covers the whole UTC day; `cashier` must be a UUID). `POST` (`commerce.pos.create`): `Idempotency-Key` header REQUIRED (`400 IDEMPOTENCY_REQUIRED`), `readJsonBody`, → `201` admin order record + `change`/`amountTendered`/`cashierTenantUserId`; `400 VALIDATION_ERROR` (incl. an un-normalisable phone), `409 IDEMPOTENCY_CONFLICT` / `CART_CHANGED` (`details.quote`) / `INSUFFICIENT_TENDER` (`details.shortfall`); `IdempotencyRaceLostError` replayed/409'd like the storefront route.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Admin screen         | `pages/admin/commerce-pos.astro`                                                                                                        | `loadAdminScreen`, entry any-of `commerce.pos.create` (sale panel) / `commerce.orders.read` (history tab, `?tab=history`); one "turned off" notice when `features.pos` is false. New sale: debounced product search over the existing owner `GET /api/v1/commerce/products?q=&status=active` (variants listed individually, out-of-stock disabled), cart with editable quantities and a `bigint`-cents subtotal preview, optional customer name/phone, cash/QRIS with tendered amount + live change, notes, submit with a fresh `Idempotency-Key` per attempt-set (`sendJsonForData` + `lockElement`), printable receipt (`@media print` isolates `#pos-receipt` at 58 mm; the SERVER's `change` prints). History: SSR table, date/cashier filters, keyset next-page links. Every client string comes from `t()` via `data-*` attributes; catalog data reaches the DOM through `textContent` only.                                                                                                                                                                                                                                                                                                                                                                |
| Navigation           | `module.ts`                                                                                                                             | `admin.layout.nav_commerce_pos` → `/admin/commerce-pos`, `requiredPermission: commerce.pos.create`, `requiredFeature: {moduleKey: "commerce", feature: "pos"}` (order 17).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Subject data         | `module.ts` (`commerce.orders` descriptor)                                                                                              | Gains `subjectColumns: [{column: "pos_cashier_tenant_user_id", references: "tenant_user"}]` (a staff subject's plan reaches the sales they rang up); erasure stays `retain_under_obligation` (fiscal record; the stamp resolves to nobody once identities anonymise). The CUSTOMER side stays unreachable as before.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Tests                | `tests/commerce-pos-domain.test.ts`, `tests/integration/commerce-pos.integration.test.ts`, `tests/admin-commerce-page-contract.test.ts` | Unit: every validation shape, the string change arithmetic (incl. the IEEE-754 failure cases and twelve-digit amounts), the storefront's refusal of `cash`, the sentinel round-trip. Integration (real Postgres): paid immediately + stock decremented + events/audit; history vs. storefront-path exclusion; walk-in reuse + level pricing; storefront `cash`/sentinel refused; idempotent replay, payload/cashier conflict, short tender writes nothing; `409 FEATURE_DISABLED`. Contract: the page gates on exactly the two keys the route enforces, posts with `Idempotency-Key`, never assigns `innerHTML`, honours the flag; the nav entry requires the feature.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

**What POS deliberately does NOT do (this increment):** no offline
queue/`SyncIndicator` (doc 14/15's LAN-first POS shape — this POS is
online-only, like every other route here), no cash-drawer/shift
reconciliation, no refunds from the POS screen (an admin cancels/refunds
through `/admin/commerce-orders` like any order), no per-line discount or
voucher at the counter, no receipt e-mail/WhatsApp, no separate
`commerce.pos.read` (history reuses `commerce.orders.read` — a second read
key with nothing distinct to enforce would be the "permission with no
enforcing code" defect this file's permissions header warns against).

## Payment-allocation ledger — IMPLEMENTED (Issue #285, epic #281 — [ADR-0025](../../../../../docs/adr/0025-payments-are-an-allocation-ledger-separate-from-order-status.md))

| Layer       | Files                                                                                                                                                                                                                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema      | `sql/940` (table, composite FKs, append-only trigger, `REVOKE DELETE`, `partially_paid`), `sql/941` (permissions), `sql/942` (worker purge grant), `sql/943` (backfill)                                                   | `awcms_commerce_payment_allocations`: append-only, FORCE RLS, `UNIQUE (tenant_id, source_key)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Domain      | `domain/payment-allocation.ts`                                                                                                                                                                                            | Pure, exact-cent: `computeSettlement`, `derivePaymentStatus`, `releaseThresholdCents`, `planTenders` (non-cash first, change from the cash leg only), the request validators                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Application | `application/payment-allocation-directory.ts`, `application/payment-recording.ts`                                                                                                                                         | `recordPaymentAllocation` (order-row lock `FOR NO KEY UPDATE`, overpayment check, insert, recompute, release callback, audit, event), `recordPaymentReversal`, `openPendingGatewayAllocation` / `resolveGatewayAllocation` / `failPendingGatewayAllocation`, `fetchOrderPaymentSummary`, `listTenderMix`, `listOutstandingBalances`; `payment-recording.ts` composes them with the shared idempotency store for the two owner mutations. `order-directory.ts` exports `makeOrderRelease` (a closure over its one `transitionOrderStatus`) and routes the confirmation-accept / `markOrderPaidBySystem` paths through the ledger; `pos-directory.ts` plans tenders and writes one leg each |
| Routes      | `pages/api/v1/commerce/orders/[id]/payments/index.ts`, `.../payments/[paymentId]/reversals.ts`, `pages/api/v1/reports/commerce/{tender-mix,outstanding-balances}.ts`, the POS route's `tenders[]`/`allowDue` handling     | Permissions `commerce.payments.{read,create,revoke}`, `commerce.pos_due.create`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Events      | `awcms.commerce.payment.recorded`, `awcms.commerce.payment.reversed`                                                                                                                                                      | On the order aggregate; registered in `module.ts`, the event-type registry and AsyncAPI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Screens     | `/admin/commerce-pos` (split tender lines, live summary, per-tender receipt), `/admin/commerce-orders/{id}` (settlement, ledger, record payment / reversal), `/admin/commerce-reports` (tender mix, outstanding balances) |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Tests       | `tests/commerce-payment-allocation-domain.test.ts`, `tests/integration/commerce-payment-allocations.integration.test.ts`                                                                                                  | See [the root cms.md](../../../../../docs/cms.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## POS registers and cash-up — IMPLEMENTED (Issue #284, epic #281 — [ADR-0028](../../../../../docs/adr/0028-pos-register-sessions-and-cash-up.md))

Six tables (`sql/970`: `awcms_commerce_registers`, `…_register_sessions`, `…_register_movements`, `…_register_close_requests`, `…_register_close_lines`, `…_register_corrections`), two stamp columns (`sql/971`: `register_session_id` on `awcms_commerce_orders` and `awcms_commerce_payment_allocations`), ten permissions (`sql/972`), worker purge grants (`sql/973`).

- **Where the code is.** `domain/register.ts` (vocabulary, validators, exact-cent expected / variance / threshold / corrections — pure), `domain/register-cash-up-csv.ts` (the formula-neutralising CSV), `domain/register-lifecycle.ts` (the six `dataLifecycle` and `subjectData` descriptors), `application/register-directory.ts` (definitions), `application/register-session-directory.ts` (open, movements, handover, the POS gate, the lock helpers), `application/register-cash-up.ts` (expected, report, close, decision, corrections), `application/register-session-stamp.ts` (the one "does this leg belong to a session?" decision, used by the payment-ledger writers), `application/register-http.ts` (the `Idempotency-Key` / feature-gate / error plumbing shared by ten routes).
- **The rules a change must keep.** Expected is DERIVED from stamped ledger legs + movements, never stored as a running total and never a time window; every session-scoped mutation locks the session first (`FOR SHARE` for a sale / movement / stamped leg, `FOR NO KEY UPDATE` for handover / close / approve / correct) and reads the idempotency store after the lock; a closed session is immutable (trigger) and corrected only by compensating rows; the cash-up writes only register tables, never a sale or a payment; one active session per register is a partial unique index backed by a register-row lock; the approval threshold compares GROSS variance and a corrupt setting falls back to the strict `0.00`.
- **Feature flag.** `features.register` (`domain/commerce-features.ts`) defaults OFF — the only flag that does. Off: the owner routes answer `409 FEATURE_DISABLED`, a POS sale needs no register and is not stamped, and naming a `registerId` is refused. On: a POS sale requires a `registerId` whose register has an `open` session of the acting cashier (`PosRegisterSessionError`, mapped by `pages/api/v1/commerce/pos/orders/index.ts`). The threshold is `cashUp.approvalThreshold` in the module settings.
- **Permissions.** `commerce.registers.{read,create,update}`, `commerce.register_sessions.{read,create,update,export}`, `commerce.register_cash_ups.{create,approve}`, `commerce.register_corrections.approve` — existing `AccessAction` verbs only; none implied by `commerce.pos.create`.
- **Events.** `awcms.commerce.register_session.{opened,movement_recorded,closed,corrected}` on the `commerce.register_session` aggregate; audit `register.*` / `register_session.*` (money, types, ids — never free text).
- **Screens.** `/admin/commerce-registers`, `/admin/commerce-registers/[id]`, the register banner on `/admin/commerce-pos` (see the awcms-one root's cms guide, [commerce module guide](../../../../../docs/cms.md)).
- **Deferred.** A "recorded after close" figure for late ledger activity, a per-register threshold, a cashier picker for handover — see [ADR-0028](../../../../../docs/adr/0028-pos-register-sessions-and-cash-up.md).

## Document lifecycle: held sales, quotations, work orders, receipts and invoices — IMPLEMENTED (Issue #286, epic #281 — [ADR-0029](../../../../../docs/adr/0029-commerce-documents-are-separate-records-and-numbered-documents-are-immutable-order-snapshots.md))

Seven tables (`sql/980`: `awcms_commerce_document_sequences`, `…_held_sales`, `…_quotations`, `…_quotation_versions`, `…_work_orders`, `…_work_order_events`, `…_documents`), thirteen permissions (`sql/981`), worker purge grants (`sql/982`). No column was added to an existing table.

- **Where the code is.** `domain/documents.ts` (vocabulary, status machines, validators, numbering format, canonical JSON + SHA-256, exact-cent comparisons, the json/text/html render contract — pure), `domain/documents-lifecycle.ts` (the `dataLifecycle` and `subjectData` descriptors), `application/document-numbering.ts` (the one-statement gapless allocator), `application/held-sale-directory.ts`, `application/quotation-directory.ts` (create / revise / actions / conversion), `application/work-order-directory.ts`, `application/document-directory.ts` (issue / list / render), `application/documents-http.ts` (the feature gate and the lazy supervisor check shared by thirteen routes).
- **The rules a change must keep.** One money authority: a document's money is a copy a trigger verifies, a quotation converts by calling `createPosOrder`, never by writing an order. Allocate a number **last**, and never return a failure _response_ after allocating (a returned `409` commits; only a throw rolls back) — undo-and-answer uses a savepoint (`convertQuotation`). A quotation version, a work-order event and a document are append-only: a revision or a correction is a new row. A held sale reserves no stock and stores no price. Foreign ids are the neutral `404`. Never edit `awcms_commerce_document_sequences` by hand.
- **Feature flag.** `features.documents` defaults OFF (the second flag that does, after `register`): the owner routes answer `409 FEATURE_DISABLED` and the sidebar entry is hidden.
- **Permissions.** `commerce.held_sales.{read,create,update,approve}`, `commerce.quotations.{read,create,update}`, `commerce.quotation_conversions.create`, `commerce.work_orders.{read,create,update}`, `commerce.documents.{read,create}` — existing `AccessAction` verbs only; a conversion additionally needs `commerce.pos_due.create`.
- **Events.** `awcms.commerce.quotation.{accepted,converted}`, `awcms.commerce.work_order.status_changed`, `awcms.commerce.document.issued`; audit `held_sale.*`, `quotation.*`, `work_order.*`, `document.*` (ids, numbers, statuses, amounts — never free text).
- **Screens.** `/admin/commerce-documents` (four tabs) and the hold / resume controls on `/admin/commerce-pos` (see the awcms-one root's cms guide, [commerce module guide](../../../../../docs/cms.md)).
- **Deferred.** An accounts-receivable invoice and credit notes, voiding or replacing a document, a receipt per payment, digital delivery and PDF, a tenant-timezone numbering year, a variant picker in the quotation editor, a booking reference on a work order — see [ADR-0029](../../../../../docs/adr/0029-commerce-documents-are-separate-records-and-numbered-documents-are-immutable-order-snapshots.md).

## Loyalty points ledger — IMPLEMENTED (Issue #289, epic #281 — ADR-0026)

A points programme as an append-only **ledger**, not a mutable points column
on a customer. Every balance change is one row of
`awcms_commerce_loyalty_ledger`; `awcms_commerce_loyalty_accounts.balance` is a
projection of it (`balance = SUM(points)`), kept in the same transaction as
each insert under a `FOR UPDATE` lock on the account row. Points are integers
(`bigint`, bounded to ±10¹²) — never a float, never money, and not
store-credit or stored-value (that is a separate ledger, #288). The whole
feature sits behind `features.loyalty`, default **OFF**.

## Barcodes, labels, scanner input and cashier shortcuts - IMPLEMENTED (Issue #292, epic #281 - [ADR-0032](../../../../../docs/adr/0032-barcodes-are-a-derived-identifier-and-the-cashier-keyboard-layer-is-chord-only.md))

Two nullable `barcode` columns (`sql/975`: products and variants), two permissions (`commerce.barcodes.{read,update}`, `sql/976`), no new table.

- **Where the code is.** `domain/barcode.ts` (GTIN check digit, validation policy, Code 128 / EAN-13 / EAN-8 encoders, the SVG renderer, label options - pure), `domain/pos-scan.ts` (scan-field parsing and the `ScanBurstDetector`, fed explicit timestamps - pure), `domain/pos-shortcuts.ts` (combo policy, conflicts, defaults -> tenant -> user layering - pure), `application/barcode-directory.ts` (lookup, catalogue, assign, label rows), `application/barcode-http.ts` (guards, feature gate, the tenant shortcut setting), routes under `pages/api/v1/commerce/barcodes/`, the screen `pages/admin/commerce-labels.astro`, and the client half `src/lib/ui/pos-keyboard-client.ts` (the only place the POS screen's script reaches into: one `addScanned` hook, everything else is element ids).
- **The rules a change must keep.** A barcode is an identifier, never authority: authorise the caller first. Symbology stays derived. Uniqueness is the database's job (partial indexes + the cross-table trigger); never replace the striped advisory lock with one lock per code (it exhausts the lock table in a bulk load). Lookup misses are one neutral `404`. Label SVG contains numbers only and tenant text is escaped, never `set:html`. A shortcut is a chord - never a bare character, never a browser-reserved key - and the detector never fires in a text field.
- **Feature flag.** `features.barcode` defaults OFF (the third flag that does, after `register` and `documents`).
- **Deferred.** Multiple barcodes per item, bundle barcodes are now the bundle product's own barcode (#290), embedded price/weight barcodes, PDF label export, further symbologies, a tenant-level shortcut editor screen, a server-side per-user shortcut store.

## Document delivery — IMPLEMENTED (Issue #295, epic #281 — [ADR-0034](../../../../../docs/adr/0034-commercial-documents-are-delivered-through-the-existing-outboxes-as-transactional-messages-built-from-immutable-sources.md))

One table (`sql/965`: `awcms_commerce_document_deliveries`), three permissions (`sql/966`), a worker purge grant (`sql/967`). No column was added to an existing table; one partial index was added to `awcms_commerce_whatsapp_messages` for the correlation-id join.

- **Where the code is.** `domain/document-delivery.ts` (vocabulary, the request validator, the pure message builders, the versioned template contract, the private-link token — pure), `application/document-delivery-directory.ts` (request / history / link resolution), `application/documents-http.ts` (`requireDocumentDeliveryFeature`), the routes `src/pages/api/v1/commerce/document-deliveries/index.ts` and `src/pages/api/v1/commerce/storefront/document-links/[token].ts`, and the admin dialog `src/components/CommerceDeliveryDialog.astro` + `src/lib/ui/commerce-delivery-dialog-client.ts`.
- **The rules a change must keep.** No third queue: enqueue into the channel's existing outbox, never call a provider. Build the message from a stored source only (no live order read — a test pins it). The recipient is stored masked; the raw link token is never stored, returned or logged. The e-mail uses the base category `derived.transactional` (a derived category is invisible to the separate `email:dispatch` process). Changing the variable list or wording of either template bumps `DOCUMENT_DELIVERY_TEMPLATE_VERSION`. The request row is append-only; a re-send is a new row.
- **Feature flag.** `features.documentDelivery` defaults OFF and also requires `documents`.
- **Permissions.** `commerce.document_deliveries.{read,create}`, `commerce.document_delivery_overrides.create` — existing `AccessAction` verbs only.
- **Events.** `awcms.commerce.document.delivery_requested`; audit `document_delivery.{request,denied,link_opened,link_expired}` (ids, numbers, channel, status, masked recipient — never an address, name or body).
- **Env.** `COMMERCE_DOCUMENT_LINK_BASE_URL` (optional; falls back to `APP_URL`).
- **Deferred.** Customer-requested resend, PDF, push, automatic delivery on payment/status change, a WhatsApp opt-out list, link revocation — see [ADR-0034](../../../../../docs/adr/0034-commercial-documents-are-delivered-through-the-existing-outboxes-as-transactional-messages-built-from-immutable-sources.md).
  | Piece                   | Where                                                                                                                    | What it does                                                                                                                                                                                                                                                                                                                                                                                       |
  | ----------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Schema                  | `sql/950`, `sql/951`, `sql/952`                                                                                          | `awcms_commerce_loyalty_programs` (versioned, effective-dated earn rules), `_accounts` (one per customer, projected `balance`/`version`), `_ledger` (append-only; kinds `earn`/`redeem`/`expire`/`adjustment`/`reversal`; unique per-tenant `idempotency_key`; composite `(tenant_id, id)` FKs). FORCE RLS; `awcms_app` is REVOKEd UPDATE/DELETE on the ledger and a trigger rejects every UPDATE. |
  | Domain                  | `domain/loyalty.ts`, `loyalty-earn.ts`, `loyalty-lots.ts`, `loyalty-validation.ts`                                       | Integer types and sign rules; the earn rule in integer cents with explicit FLOOR rounding; the pure lot replay (earliest-expiry-first allocation) behind expiry and reversal; request validation.                                                                                                                                                                                                  |
  | Ledger (the one writer) | `application/loyalty-ledger.ts`                                                                                          | `appendLedgerEntry` (idempotency key, next `account_seq`, running `balance_after`, projection update, `loyalty.entry_recorded` event — one transaction); `earnPointsForPaidOrder`, `reverseEarnForCancelledOrder`, `redeemPoints`, `adjustPoints`, `expireDueLoyaltyPointsForTenant`, `reconcileLoyaltyForTenant`, `fetchLoyaltySummary`.                                                          |
  | Programs                | `application/loyalty-program-directory.ts`                                                                               | Draft -> active -> retired. Activation is immediate and closes the open version in the same transaction under a per-tenant advisory lock; an active/retired version is immutable (a ledger row names the version it earned under).                                                                                                                                                                 |
  | Earn / reverse          | `commerce/module.ts` `domainEventConsumers` (ADR-0134)                                                                   | `commerce.order_paid_loyalty_earner` (`order.paid`) and `commerce.order_cancelled_loyalty_reverser` (`order.cancelled`) — loyalty never touches `order-directory.ts`, `pos-directory.ts`, pricing or the payment webhook paths; they already publish those events.                                                                                                                                 |
  | Jobs                    | `scripts/commerce-loyalty-expire.ts`, `scripts/commerce-loyalty-reconcile.ts`                                            | `commerce:loyalty:expire` (hourly, append-only, idempotent, 200 accounts/tenant/run) and `commerce:loyalty:reconcile` (daily, read-only, non-zero exit on drift).                                                                                                                                                                                                                                  |
  | Routes                  | `pages/api/v1/commerce/loyalty/**`, `pages/api/v1/commerce/storefront/account/loyalty/index.ts`                          | Owner: programs (list/create/get/patch/activate/retire), accounts (list + `?phone=` lookup, get, ledger, **redeem**, **adjust**), summary, reconcile. Customer: bearer-secured own balance + history (ADR-0016 D3), customer id from the session only.                                                                                                                                             |
  | Admin screen            | `pages/admin/commerce-loyalty.astro`                                                                                     | Key figures from the ledger, program versions (create draft / activate / retire with confirm dialogs), customer lookup with ledger + redeem + adjust forms (each behind its own permission), a read-only balance check with an explicit confirmed repair.                                                                                                                                          |
  | Permissions             | `domain/commerce-permissions.ts`, `sql/952`                                                                              | `commerce.loyalty.read`, `commerce.loyalty.manage` (high-risk), `commerce.loyalty_adjustments.create`, `commerce.loyalty_redemptions.create` — three activity codes, because `AccessAction` (upstream-owned) has no `adjust`/`redeem` member.                                                                                                                                                      |
  | Tests                   | `tests/commerce-loyalty-{earn,lots,validation,routes}.test.ts`, `tests/integration/commerce-loyalty.integration.test.ts` | Unit: integer/floor arithmetic, the lot replay and its accounting identity (200 generated ledgers), validation, structural owner-scoping/one-writer guards. Integration (real Postgres): replay-once earn, concurrent redemption, expiry idempotency, reversal, append-only, RLS, BOLA, reconcile, summary, worker-role grants.                                                                    |

**Rules worth knowing before you change anything**

- Earn is **exactly once per order** (`earn:order:<id>` key + the consumer
  marker), from the order row's `subtotal - discount` only, for the program
  version effective at `paid_at`. Walk-in/blocked customers and cancelled
  orders never earn; enabling the feature later is not retroactive.
- **Expiry** is per earn lot, earliest-expiry-first. `expire` rows are
  appended, never an update; a fully-spent lot gets a zero-point marker so the
  scan terminates. A redemption/adjustment/reversal expires the account's due
  lots itself under the lock, so lapsed points can never be spent.
- **Reversal** is a compensating `reversal` row for the cancelled order's earn,
  never a delete. It takes back what has not already lapsed, including points
  already spent, so a balance can go **negative** (and blocks redemption). A
  manual negative adjustment may not.
- Redemption **records the points debit only**. Turning points into a discount
  at checkout needs #285's tender model and is deferred (ADR-0026).

## Typed catalog attributes & CSV import/export — IMPLEMENTED (Issue #291, epic #281 — ADR-0027)

Tenant-defined, **typed** custom attributes on products and variants, filtered through an allowlisted grammar, plus a validate-then-apply CSV import and a formula-safe export. Everything below lives inside this one module (ADR-0008); the root [ADR-0027](../../../../../docs/adr/0027-catalog-custom-attributes-are-typed-and-allowlisted.md) has the reasoning, the threat model, the rollback strategy and the measured query plans.

| Piece          | File                                                                                                                                                                     | What it owns                                                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Value grammar  | `domain/attribute-value.ts`                                                                                                                                              | The locale-independent parse/normalise of every type (`1234.5` yes, `1,5` no), the exact `value × 10^6` scaled-integer representation, canonical strings, wire values                                                                              |
| Definitions    | `domain/attribute-definition.ts`, `application/attribute-definition-directory.ts`                                                                                        | The closed constraint schema, immutable `key`/`valueType`, the 100-per-tenant cap, enum options unique case-insensitively, the in-use refusals on update                                                                                           |
| Assignments    | `domain/attribute-assignment.ts`, `application/attribute-value-directory.ts`                                                                                             | ONE validator for a `{key: value \| null}` map (the attribute endpoints, the product forms and the CSV import all call it), the upsert/soft-clear writes, `loadAttributeSets` (audience-aware), `attachPublicAttributes` (additive `attributes[]`) |
| Filter grammar | `domain/attribute-filter.ts`, `application/attribute-filter-sql.ts`                                                                                                      | `attr=<key>:<op>:<value>`: shape check, key → definition id, operator/type legality, typed operand; then ONE literal SQL template per (type, operator) with bound parameters                                                                       |
| CSV            | `domain/catalog-csv.ts`                                                                                                                                                  | RFC 4180 reader/writer with limits; formula neutralisation (and its reversal on import)                                                                                                                                                            |
| Import         | `domain/catalog-import.ts`, `application/catalog-import.ts`                                                                                                              | The file contract (core columns + `attr:<key>`, no media column), `planCatalogImport` (SELECT-only), `applyCatalogImport` (same plan, one savepoint, batch row + audit)                                                                            |
| Export         | `application/catalog-export.ts`                                                                                                                                          | Bounded keyset pages → one CSV, audited                                                                                                                                                                                                            |
| Routes         | `pages/api/v1/commerce/attributes/**`, `products/[id]/attributes.ts`, `products/[id]/variants/[variantId]/attributes.ts`, `products/import.ts`, `products/export.csv.ts` | Thin; `defineTenantRoute`; `import` also needs `create` + `update` to apply                                                                                                                                                                        |
| Screens        | `pages/admin/commerce-attributes.astro`, `commerce-catalog-import.astro`, and the attribute forms/filters/export link in `commerce.astro`                                | Components `CommerceAttributeInputs.astro`, `CommerceAttributeConstraintFields.astro`; client helpers `lib/ui/commerce-attributes-client.ts`, `commerce-catalog-import-client.ts`                                                                  |

### Rules a change here must keep

- **No SQL text from a request.** `attribute-filter-sql.ts` has no `tx.unsafe`, no `${column}`, no `${operator}`; adding an operator or a type is a compile error until it gets its own literal template (the `switch`es are exhaustive). A source-level test and an injection-payload integration test enforce it.
- **Numbers are exact and locale-free.** Never `Number(...)`, `parseFloat` or `Intl` on an attribute value; go through `parseAttributeValue`. The storage column is a scaled `bigint` _because_ `numeric` comparisons cannot use an index under FORCE RLS (leakproof operators only) — do not "simplify" it back.
- **Two audiences.** The catalog API (`GET /products…`) is the PUBLIC audience: only `filterable && visible_public` keys filter, only `visible_public` values are returned, only `searchable && visible_public` attributes join `q`. The full set is `attributes.read`-gated, never `products.read` (a storefront credential holds that).
- **Every read, filter and uniqueness check repeats `deleted_at IS NULL`** on the values table; clearing a value is a soft delete.
- **The import never forks validation.** It calls `validateCreateProductInput`/`validateUpdateProductInput`/`validateAttributeAssignments` and `createProduct`/`updateProduct`; a faster private write path would bypass audit, events, the status machine and uniqueness. Dry-run and apply share `planCatalogImport`.
- **An import accepts no media reference and does no I/O but the database.** An unknown column rejects the file.

### Permissions

`commerce.attributes.read`/`.manage` (definitions are schema: one high-risk action), `commerce.products.export` and `commerce.products.import` (new `import` access action, high-risk beside `export`). A product's attribute _values_ are written with `commerce.products.update` and read in full with `commerce.attributes.read`.

## Gift cards and store credit — IMPLEMENTED (Issue #288, epic #281 — [ADR-0030](../../../../../docs/adr/0030-stored-value-is-a-closed-loop-liability-ledger.md))

Three tables (`sql/985`: `awcms_commerce_stored_value_programs`, `…_accounts`, `…_ledger`), the payment-ledger integration (`sql/986`: `stored_value_account_id`, the two tender types, the deferred pairing trigger, the widened `payment_method` hint), seven permissions (`sql/987`), worker purge grants (`sql/988`).

- **Where the code is.** `domain/stored-value.ts` (vocabulary, the code — generation, normalisation, check character, tenant-scoped hash, mask —, signed cents, `evaluateEntry` and `replayLedger`, validators; pure), `domain/stored-value-lifecycle.ts` (the three `dataLifecycle` and `subjectData` descriptors), `application/stored-value-ledger.ts` (**the one writer**: `appendStoredValueEntry`, the account lock, `settleLapse`, and the redeem/refund hooks the payment ledger calls), `application/stored-value-directory.ts` (programs, issue, load/adjust/status, the expiry sweep, reads, the liability report, reconcile), `application/stored-value-tender.ts` (code → account resolution with the lookup throttle, the POS preflight, the typed refusals, `redactTendersForHash`), `application/stored-value-http.ts` (the feature gate and the one mapping of refusals to responses).
- **The rules a change must keep.** The ledger is append-only and the database trigger is the only thing that moves an account's `balance`/`version`/`status` — never write an `UPDATE` of them (the one exception is reconcile's repair, which the database accepts only for the exact ledger sums); the lock order is order row → account row (`FOR NO KEY UPDATE`, never `FOR UPDATE`); a stored-value refusal is decided BEFORE any row is written (a returned response commits — only a thrown error rolls back), and an invariant violation after the preflight throws `StoredValueInvariantError`, which no route maps; the plaintext code never reaches a table, a log, an audit attribute, an event payload or the idempotency store (hash it with `hashStoredValueCode` / `redactTendersForHash`); every failed code lookup is the one neutral `STORED_VALUE_NOT_FOUND`; there is no cash-out and no transfer, and a refund goes back to the account the payment drew on or not at all.
- **Feature flag.** `features.storedValue` (`domain/commerce-features.ts`) defaults OFF — with `register`, the only flags that do. Off: the owner routes answer `409 FEATURE_DISABLED`, the sidebar entry is hidden and a card tender is refused before anything is written (a reversal of an existing card payment is not gated: it compensates data that exists).
- **Permissions.** `commerce.stored_value_programs.{read,update}`, `commerce.stored_value.{read,create,update}`, `commerce.stored_value_adjustments.create`, `commerce.stored_value_reconcile.approve` — existing `AccessAction` verbs only; redeeming is a tender on `commerce.pos.create` / `commerce.payments.create`, not one of them.
- **Events.** `awcms.commerce.stored_value.entry_recorded` on the `commerce.stored_value_account` aggregate (one per ledger entry); audit `stored_value.*` / `stored_value_program.update` (ids, kinds, money — never the code, the customer or the free text).
- **Screens.** `/admin/commerce-stored-value`; gift-card / store-credit tender lines on `/admin/commerce-pos` and `/admin/commerce-orders/[id]` (only with the feature on); the "Gift cards and store credit" toggle in the settings screen.
- **Deferred.** A scheduled expiry job, any public lookup/redeem or customer balance view, refund to a lapsed card, cash-out/transfer (rejected), selling a card as a catalogue product, store credit from a return — see [ADR-0030](../../../../../docs/adr/0030-stored-value-is-a-closed-loop-liability-ledger.md).

## Returns, refunds and exchanges — IMPLEMENTED (Issue #287, epic #281 — [ADR-0033](../../../../../docs/adr/0033-returns-refunds-and-exchanges-are-additive-records-that-compensate-through-the-existing-ledgers.md))

Four tables (`sql/994`: `awcms_commerce_returns`, `…_return_lines`, `…_refunds`, `…_refund_compensations`), the integrations on existing tables (`sql/995`: `order_events.return_id`, the payment-ledger reversal cap trigger, the loyalty `refund` source, `affiliate_commissions.adjusted_amount`), the five permissions (`sql/996`) and the retention worker's grants (`sql/997`).

- **Where the code is.** `domain/returns.ts` (vocabulary, the per-unit cent decomposition, largest-remainder discount allocation, refund planning, proportional arithmetic, validators; pure), `domain/returns-lifecycle.ts` (retention / subject-data descriptors), `application/return-directory.ts` (create, later refund, exchange link, reconcile), `application/refund-settlement.ts` (settling one leg — the only place a refund becomes a fact), `application/refund-execution.ts` (the provider call outside every transaction; offline settlement), `application/return-inventory-port.ts` (the stock boundary), `application/return-records.ts` (reads), `application/return-http.ts` (the one outcome → response mapping).
- **The rules a change must keep.** Nothing finalised is edited: no `UPDATE` of an order, an order item or a payment allocation (a test scans for it). Every refusal is decided BEFORE the first write (`checkRefundSettlement`) — a route that returns a response commits its transaction. Lock order: order row → order-item rows (by id) → payment / gift-card / drawer rows. The provider is called from exactly one place and never with a transaction open; it is handed the refund leg's id as its idempotency key on every attempt. Stock is touched only by the inventory port; loyalty only by `loyalty-ledger.ts`.
- **Inventory boundary.** `restock` lines go back through `ReturnInventoryPort`, `damaged`/`quarantine` are recorded and change no sellable stock. #282 landed as `ledgerInventoryPort` beside `singleCountInventoryPort`; `modeAwareInventoryPort` (the default) picks one per tenant — see "Stock authority" below.
- **Feature flag.** `features.returns` (`domain/commerce-features.ts`) defaults OFF. Off: the owner routes answer `409 FEATURE_DISABLED` and the order detail shows no panel.
- **Permissions.** `commerce.returns.{read,create}`, `commerce.refunds.{read,create}`, `commerce.refunds_offline.approve` — existing `AccessAction` verbs only; a refund leg also needs `commerce.payments.revoke`.
- **Events.** `awcms.commerce.return.recorded`, `awcms.commerce.refund.settled` on the `commerce.return` aggregate; audit `return.create`, `return.refund`, `return.link_exchange`, `refund.settle`.
- **Screens.** The order detail's "Returns and refunds" panel and wizard (`src/components/CommerceReturnsPanel.astro`, `src/lib/ui/commerce-returns-client.ts`); the "Returns, refunds and exchanges" toggle in the settings screen.
- **Sales reports.** `sales-report-deltas.ts` / `sales-report-projection.ts` net a `returned` order event (and, for a later cancellation, the earlier returns) so the three projections stay equal to a rebuild.
- **Deferred.** Multi-location stock movements, automatic tax/insurance refund, customer-initiated requests, a scheduled refund job, voiding an open return, a returns report — see [ADR-0033](../../../../../docs/adr/0033-returns-refunds-and-exchanges-are-additive-records-that-compensate-through-the-existing-ledgers.md).

## POS operational reports — IMPLEMENTED (Issue #296, epic #281 — [ADR-0035](../../../../../docs/adr/0035-pos-operational-reports-are-commerce-projections-over-the-existing-ledgers-on-the-reporting-engine.md))

Five more `reportingProjections` (plus the returns one, below) on the sales-report mechanism above (no new engine): `commerce.pos_tender_daily`, `commerce.pos_cash_up_variance`, `commerce.pos_expense_daily`, `commerce.pos_loyalty_daily`, `commerce.pos_stored_value_daily` (`sql/998`–`999`).

| Piece                    | Where                                                                                                                                            | What it does                                                                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delta rules              | `domain/operational-report-deltas.ts` (pure)                                                                                                     | Tender leg → payment/reversal columns on the settlement day and register; close line + correction → expected/counted/adjustment on the close day; expense posting / reversal → posted / reversed columns on the occurred-on date; ledger entry → signed bucket on its local day |
| Keys, families           | `domain/operational-report-keys.ts`                                                                                                              | Projection, stream, metric and control keys; `OPERATIONAL_REPORT_FAMILIES` (feature gate, projection) — the registry a new family (returns, inventory, tax) adds one entry to                                                                                                   |
| Sinks + hooks            | `application/operational-report-projection.ts`                                                                                                   | One `load*Deltas` per source (shared by the sink and by reconciliation), additive upserts, `walkSource` (text-cursor paging), the `ProjectionDimensionalContract` of each projection                                                                                            |
| Source views             | `sql/998` `awcms_commerce_report_src_*`                                                                                                          | `security_invoker` views of the rows whose cursor is set — the engine's rebuild scan cannot take a NULL cursor                                                                                                                                                                  |
| Reads, CSV               | `application/operational-report-directory.ts`, `domain/operational-report-csv.ts`                                                                | Range reports with exact-cent `summary` arrays and `enabled` gating; formula-neutralised CSV (reuses `csvCell`/`csvNumber`)                                                                                                                                                     |
| Routes                   | `src/pages/api/v1/reports/commerce/operational-*.ts` and `.csv.ts`                                                                               | Ten routes, each with its own literal guard (`commerce.report_<family>.read` / `.export`); the CSV routes audit the export                                                                                                                                                      |
| Screen                   | `src/components/CommerceOperationalReports.astro` on `/admin/commerce-reports`                                                                   | Five panels, each shown only to a holder of the family's `read` key and hidden while its feature is off                                                                                                                                                                         |
| Retention / subject data | `domain/operational-report-lifecycle.ts`                                                                                                         | Cursor `day`, 3650-day ceiling; the cash-up table names the cashier uuid (staff)                                                                                                                                                                                                |
| Tests                    | `tests/commerce-operational-report-{domain,permissions}.test.ts`, `tests/integration/commerce-operational-reports{,-routes}.integration.test.ts` | Rules and timezone boundaries; permission separation; live = rebuild byte for byte, reconcile drift and tamper detection, late events, feature off, RLS, BOLA, CSV and audit                                                                                                    |

**Returns & refunds slice — IMPLEMENTED (Issue #316).** A sixth projection, `commerce.pos_returns_daily` (`sql/945` table + worker grant, `sql/946` the `commerce.report_returns.read|export` pair), following ADR-0035 D1's contract and its addendum. Three streams into the one long table `awcms_commerce_report_returns_daily` (`(day, register_id, section, bucket, detail)`): `awcms_commerce_returns` (`section = return`: returns and exchanges recorded, with the refund total), `awcms_commerce_return_lines` (`section = disposition`: lines, units and value by `restock` / `damaged` = written off / `quarantine`) and the payment ledger's reversal legs that a refund points at (`section = refund`: legs and money by tender and by `original_tender` / `store_credit`). Loaders `loadReturnDeltas`, `loadReturnLineDeltas`, `loadRefundLegDeltas` live in `application/operational-report-projection.ts` and feed both the sinks and the control totals; the rules are `computeReturnDelta`, `computeReturnLineDelta`, `computeRefundLegDelta` in `domain/operational-report-deltas.ts`. No `security_invoker` view is added: the sources' cursors are NOT NULL from insert, and the refund stream reads the sql/998 allocation view. Gated on the `returns` feature (`enabled: false` while off); routes `operational-returns` and `.csv`; a panel on `/admin/commerce-reports`. Test: `tests/integration/commerce-returns-report.integration.test.ts`.

**Deferred by name:** receiving (#283), margin, discounts and a bundle report (#290 shipped bundles; the report is deferred, ADR-0036 D8) — see ADR-0035 D1 (stock balance/movement/low-stock are the upstream `inventory` screens and projection, ADR-0038 D8; tax is the `tax` module's own report, ADR-0039 D5).

## Stock authority: counter or inventory ledger — IMPLEMENTED (Issue #282, epic #281 — [ADR-0038](../../../../../docs/adr/0038-commerce-stock-is-a-write-through-cache-of-the-inventory-ledger.md))

- **Mode.** `awcms_commerce_store_settings.inventory_mode` (`counter` default | `ledger`) and `inventory_location_id` (composite FK to `awcms_inventory_locations`), `sql/947`. Columns, not part of the settings jsonb; in `ledger` mode a settings reset replaces the blob and never stamps `deleted_at` (the retention purge would otherwise delete the row that carries the mode).
- **One seam.** `application/commerce-inventory.ts` is the only file that names `inventoryLedgerPortAdapter` (lazily — the adapter's import chain reaches the consumer registry). `resolveInventoryConfig` reads the mode under a shared advisory lock; the cut-over and the rollback hold the exclusive one. `withInventorySavepoint` runs a stock-moving unit in a savepoint in `ledger` mode so a refusal (`InventoryLedgerRefusedError`) leaves nothing behind.
- **Writes.** `createOrderFromCart` / `createPosOrder` → `sale` per line (`commerce_order`, order id, order-item id); `transitionOrderStatus` cancel/expiry → `sale_return` (`commerce_order_restock`); `createReturn` → `ledgerInventoryPort` (`commerce_return`, return id, return-line id). Posted sorted by `(itemType, itemRef, line)`; `stock` is written through as `max(0, floor(balanceAfter))`. Out of stock is `cart_changed` / `PosCartChangedError`; any other refusal is `409 INVENTORY_UNAVAILABLE`.
- **Cache upkeep.** `application/commerce-inventory-cache-projector.ts`, declared in `commerce/module.ts` `domainEventConsumers` (ADR-0134) as `commerce.inventory_stock_cache_projector` on `awcms.inventory.movement.posted`: re-reads `getOnHand`, never the payload, only for the sales location and `commerce.*` items.
- **Cut-over.** `application/commerce-inventory-cutover.ts` + `scripts/commerce-inventory-cutover.ts` (`bun run commerce:inventory:cutover`, dry-run by default). Openings are not on the port, so the script (a composition root) passes the inventory module's own posting core in as a callback.
- **Operator API.** `GET /api/v1/commerce/inventory`, `GET …/reconciliation`, `POST …/resync`, `POST …/rollback` (`application/commerce-inventory-reconciliation.ts`; `commerce.inventory.read` / `.configure`).
- **Procurement (#283).** Upstream's `procurement` is the consumer; commerce adds only a convention, a lookup and a check. A procurement line that stocks commerce goods uses `itemType` `commerce.variant` (variant uuid) or `commerce.product` (uuid of a product with no live variant), unit `unit`, at the sales location (or elsewhere, then a `transfer`); `GET /api/v1/commerce/inventory/items?q=` (`application/commerce-inventory-items.ts`, `commerce.inventory.read`, keyset, at most 50) resolves a SKU to that reference. A `counter` tenant's receipt does not change commerce stock - cut over first. The reconciliation's first page also reports `orphans` (`listLedgerOrphans`: non-zero `commerce.*` balances at the sales location naming no live unit; listed through `InventoryLedgerPort.listBalances`, classified per page against commerce's tables; the scan is capped at `ORPHAN_SCAN_MAX_PAGES`, which also sets `truncated`). Receiving reports are upstream's `procurement.*` projections. Test: `tests/integration/commerce-procurement-stock-flow.integration.test.ts`, `…/commerce-inventory-items-routes.integration.test.ts`.
- **Edits.** `assertStockWritable` in the product/variant directories and a plan-time row error in the CSV import refuse a stock change in `ledger` mode (`409 STOCK_MANAGED_BY_INVENTORY`).
- **Tests.** `tests/commerce-inventory-domain.test.ts`, `tests/commerce-inventory-permissions.test.ts`, `tests/integration/commerce-inventory-adapter.integration.test.ts`.

## Tax: the flat percentage, or the `tax` module — IMPLEMENTED (Issue #293, epic #281 — [ADR-0039](../../../../../docs/adr/0039-commerce-tax-is-computed-by-the-tax-module-behind-a-per-tenant-mode.md))

`commerce` depends on the `tax` module (ADR-0127) and calls its application functions in process; there is no network call and no `_shared/ports/` tax port.

| Piece     | Where                                                                                                                                                              | What it does                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mode      | `awcms_commerce_store_settings.tax_mode` / `tax_profile_code` (`sql/948`), `application/tax-adapter-directory.ts` (`fetchTaxAdapterConfig`, `setTaxAdapterConfig`) | `flat` (default) = `quoteCart`'s original `percent` of `subtotal − voucher`; `engine` = the tax module. Real columns, read-only on `GET /store-settings`, a `PUT` carrying them is refused. A settings reset never erases an engine row                                                                                                                                                                                       |
| Mapping   | `domain/tax-adapter.ts` (pure)                                                                                                                                     | A quote becomes tax lines (`quantity`, `unitPrice`, the voucher allocated across lines by largest remainder in cents, the product's category); engine tax equals the flat figure exactly for the same percentage/mode/rounding (seeded property test); inclusive pricing is not added to the total; a refusal (`TAX_RULE_VERSION_NOT_FOUND`, `TAX_RULE_NOT_FOUND`, a scale other than 2) sets `tax.error` and blocks checkout |
| Quote     | `domain/cart-quote.ts` + `application/cart-quote-service.ts`                                                                                                       | Resolves the version for the store's `Asia/Jakarta` business date and the products' `tax_category_code`; the pure `quoteCart` calls the calculator. `tax` gains `mode`, `inclusive`, `error`, `engine` (additive)                                                                                                                                                                                                             |
| Placement | `order-directory.ts`, `pos-directory.ts` -> `finaliseOrderTax`                                                                                                     | One snapshot per order (`documentType = "order"`, line refs = order item ids) in the same transaction, `awcms_commerce_orders.tax_snapshot_id` stored, audit `tax.snapshot.finalise` + the module's outbox event; fails closed (`OrderTaxMismatchError`) if the snapshot's tax differs from the priced tax                                                                                                                    |
| Reversal  | `return-directory.ts`, `order-directory.ts` -> `reverseOrderTaxForReturn` / `reverseOrderTaxForCancellation`                                                       | From the ORIGINAL snapshot: a return reverses the returned units (reversal line `{ lineRef: order item id, quantity }`, document id `return:<id>`); a cancel/expiry reverses what remains. Flat-mode and pre-cut-over orders have no snapshot: no-op                                                                                                                                                                          |
| Cut-over  | `scripts/commerce-tax-cutover.ts` -> `application/tax-cutover.ts`                                                                                                  | Ops-only, dry-run by default: derive and publish `store-default`, shadow-parity over recent orders (refuse unless exact), flip `tax_mode`; `--rollback`                                                                                                                                                                                                                                                                       |
| Admin     | `src/pages/admin/commerce.astro`, `commerce-settings.astro`                                                                                                        | Product Tax category field; read-only mode badge linking to `/admin/tax`                                                                                                                                                                                                                                                                                                                                                      |
| Tests     | `tests/commerce-tax-adapter.test.ts`, `tests/integration/commerce-tax-adapter.integration.test.ts`                                                                 | Parity (2,000 + 500 seeded carts), allocation, categories, inclusive pricing, refusals; flat unchanged, cut-over/refusal/rollback, one snapshot per storefront and POS order, replay, history immutability, return/cancel/expiry reversals (worker role), RLS and the composite FK, client tax ignored                                                                                                                        |

- **Tax reports are the tax module's** (`tax.snapshot_activity`, `GET /api/v1/tax/reports/reconciliation`), not a commerce slice (ADR-0039 D5). The sales projections keep reading the order's `tax` column, which in engine mode is the snapshot's figure.
- **Tax refund (issue #323).** A return refunds the tax charged on the returned units: `refund_total = goods_gross − discount_share + shipping_refund + tax_refund` (`sql/1000`). Flat mode (and an order with no tax snapshot) prorates the order's tax per unit with the same decomposition as goods and discount; engine mode with exclusive pricing refunds exactly the reversal snapshot's tax total, so the money and the tax ledger agree; inclusive pricing adds nothing (the tax is inside the goods value). See ADR-0033's tax addendum. The insurance fee is still not refunded.
- **Regulatory neutrality.** No rate is asserted here; a rate or regulation change is a new effective-dated version authored in `/admin/tax` (ADR-0039 D6). Coretax / e-Faktur export is out of scope.

## Bundles: item kits stocked through their components — IMPLEMENTED (Issue #290, epic #281 — [ADR-0036](../../../../../docs/adr/0036-bundles-are-component-stocked-products-sold-as-one-line.md))

- **Model.** A bundle is a product with `kind = 'bundle'` (`sql/953`); it has no variants, no stock of its own (the column is held at `0`; the read model reports the computed availability as `stock`), is not a service product and is not flash-sale eligible. Its 1–20 components are `awcms_commerce_bundle_components` rows (composite tenant FKs, FORCE RLS). **No nesting**: a trigger refuses a component that is a bundle and a product used as a component becoming one, so cycles cannot exist. (Not to be confused with `type = 'bundle'` from issue #266, a descriptive type with no stock semantics.)
- **Pricing.** `bundle_pricing` `fixed` (the product's own price) or `derived` (Σ component list price × quantity less `bundle_discount_percent`, half-up to the cent) — `domain/bundle.ts`, integer cents. A derived bundle's public `finalPrice` carries the derived price; `price` is left alone.
- **One line, one snapshot.** `application/cart-quote-service.ts` folds a bundle into its product snapshot (`stock` = `min floor(component stock / quantity)`); a bundle sells as ONE order item, plus append-only `awcms_commerce_order_item_components` rows (`sql/954`: units, text as sold, `allocated_value` split by largest remainder, Σ = line total) written by `application/bundle-directory.ts`'s `sellBundleLine`.
- **Stock.** The bundle line moves nothing; its components do. `counter`: components locked (`FOR NO KEY UPDATE`, products then variants, ascending id), the cart re-quoted against the locked counts, then decremented. `ledger`: one `sale` per component through the ADR-0038 seam, source line `<orderItemId>:c<position>`, sorted with every other line in the same savepoint. Cancel/expiry (`commerce_order_restock`) and a whole-bundle return (`commerce_return`, `<returnLineId>:c<position>`) read the snapshot, never the current definition.
- **Tax.** One line, taxed by the bundle product's own tax category (per-component classes deferred).
- **Admin.** The product form has a Bundle toggle, a pricing strategy, a discount percent and a `SKU x quantity` contents textarea (`lib/ui/commerce-bundle-form.ts`); `POST/PATCH /products` take `kind`, `bundlePricing`, `bundleDiscountPercent` and `bundleComponents` (ids or SKUs). No new permission. POS search and barcode scan find a bundle like any product; the storefront product page lists "Isi paket".
- **Tests.** `tests/commerce-bundles-domain.test.ts`, `tests/commerce-bundle-form.test.ts`, `tests/integration/commerce-bundles.integration.test.ts`; storefront (workspace `apps/storefront`, the `paket-build-smoke` build-smoke test).

## Customer retention — IMPLEMENTED (Issue #364, epic #280 — [ADR-0044](../../../../../docs/adr/0044-customer-retention-is-a-per-customer-recompute-projection-on-the-reporting-engine.md))

The commerce-only half of the metrics spec's section 6 ([metric contracts](../../../../../docs/aw-business-platform-metrics.md)): the 90-day repeat rate of customer cohorts, as the `reporting` projection `commerce.customer_retention` (`sql/1020`–`1021`). No second analytics store, no engine change, no domain event or consumer.

- **Where the code is.** `domain/retention.ts` (qualifying order, per-customer derivation, cohort months and windows, tallies, restatement rule, control totals, range — pure), `application/retention-projection.ts` (the two cursor-stream sinks and the dimensional hooks — the DB half), `application/retention-report-directory.ts` (the read), `domain/retention-csv.ts`, `domain/retention-lifecycle.ts`, `src/pages/api/v1/reports/commerce/retention{,.csv}.ts`, `src/components/CommerceRetentionReport.astro`.
- **The rules a change must keep.** The sink RECOMPUTES a customer from their current orders; it never applies a delta (a late event moves a customer between cohorts). The blocked, purged and walk-in exclusions are applied at READ (a join), not stored. "Within 90 days" is `<= 90 × 24 h` evaluated at read. The restatement log is written only while no rebuild run is `running` and is left alone by a rebuild's reset.
- **Feature flag.** `features.retention` defaults OFF: the routes answer `200 enabled: false`, the panel is hidden, the CSV is a header row.
- **Permissions.** `commerce.report_retention.{read,export}`, not implied by `reporting.dashboard.read` or `commerce.customers.read`. Every CSV is audited (`retention_report.export`).
- **Deferred.** The booking input (after Wave C), a CRM win-back list, a configurable N, `profile_identity` harmonisation of customer ids.

## Deliberately not here

- **No restore for the marketing tables, nor for orders/customers/reviews.**
  Soft delete only; a deleted voucher, slider, order or customer is
  recreated, not brought back — the audit trail keeps the record. `order_code`
  is the one exception to "unique among live rows": its uniqueness index is
  NEVER scoped to `deleted_at IS NULL` (`sql/913`'s header), because an order
  code must stay unique for the tenant forever, not just while the order is
  live.
- **No full-text relevance ranking on `q`.** The trigram/`ILIKE` match
  (`sql/907`) is substring search, not a ranked search index — `site_search`
  is this base's cross-content search module, and `commerce` does not
  integrate with it in this increment.

## Expenses: commerce-local petty cash — IMPLEMENTED (Issue #294, epic #281 — [ADR-0031](../../../../../docs/adr/0031-expenses-are-commerce-local-register-linked-petty-cash.md))

Two tables (`sql/990`: `awcms_commerce_expense_categories`, `awcms_commerce_expenses`), the typed expense reference on register movements (`sql/991`: `reference_kind = 'expense'` + `expense_id`, a partial unique index of at most one out and one in movement per expense), twelve permissions (`sql/992`), worker purge grants (`sql/993`).

- **Where the code is.** `domain/expense.ts` (vocabulary, validators, the approval decision and SoD, the threshold setting, exact-cent report folding — pure), `domain/expense-csv.ts` (formula-neutralised CSV, reusing the cash-up CSV's helpers), `domain/expense-lifecycle.ts` (`dataLifecycle` / `subjectData` descriptors), `application/expense-category-directory.ts`, `application/expense-directory.ts` (reads, drafts, discard, receipts, summary, export), `application/expense-posting.ts` (post, decide, reverse — the only code that writes a register movement for an expense, through `appendRegisterMovement` in `register-session-directory.ts`), `application/expense-http.ts` (the feature gate and the one refusal-to-HTTP mapping).
- **The rules a change must keep.** An expense never edits a cash-up total — it appends a movement (out on posting, a compensating `correction` in on reversal) and nothing else; lock order is expense row, then session, always; every mutation locks first and reads the idempotency store after; content is frozen once a row leaves `draft` (trigger); a creator never approves their own expense (CHECK and code); a receipt is a private, verified, uploader-owned, single-use media object resolved from the expense, never from a caller-supplied id; audit and event payloads carry money and ids, never the description, payee, note or reason.
- **Feature flag.** `features.expenses` defaults OFF (a drawer expense also needs `register`); the threshold is `expenses.approvalThreshold` in the module settings (strict `0.00` default; a corrupt value falls back to it). While ON, the manual movement route refuses `movementType: "expense"`.
- **Permissions.** `commerce.expense_categories.{read,create,update}`, `commerce.expenses.{read,create,update,export}`, `commerce.expense_postings.{create,approve}`, `commerce.expense_reversals.approve`, `commerce.expense_receipts.{read,create}` — existing `AccessAction` verbs only.
- **Events.** `awcms.commerce.expense.{posted,reversed}` on the `commerce.expense` aggregate; audit `expense.*` / `expense_category.*`.
- **Screen.** `/admin/commerce-expenses` (see the awcms-one root's cms guide, [commerce module guide](../../../../../docs/cms.md)).
- **Deferred.** A typed payee/party reference, several receipts per expense and an upload control on the screen, recurring expenses, per-category thresholds — see [ADR-0031](../../../../../docs/adr/0031-expenses-are-commerce-local-register-linked-petty-cash.md).
