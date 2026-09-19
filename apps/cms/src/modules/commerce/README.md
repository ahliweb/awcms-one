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

| Aspect      | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key / type  | `commerce` · `domain`, `isCore: false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Tables      | `awcms_commerce_categories`, `awcms_commerce_products` (`sql/901`, extended `sql/904`), `awcms_commerce_product_images`, `awcms_commerce_product_variants` (`sql/905`); `awcms_commerce_flash_sales`, `awcms_commerce_flash_sale_products`, `awcms_commerce_vouchers`, `awcms_commerce_sliders`, `awcms_commerce_testimonials`, `awcms_commerce_popups` (`sql/909`), `awcms_commerce_store_settings` (`sql/910`); `awcms_commerce_customers`, `awcms_commerce_customer_addresses`, `awcms_commerce_orders`, `awcms_commerce_order_items`, `awcms_commerce_order_events`, `awcms_commerce_payment_confirmations`, `awcms_commerce_reviews`, `awcms_commerce_wishlists` (`sql/913`); `awcms_commerce_customer_accounts`, `awcms_commerce_customer_otps`, `awcms_commerce_customer_sessions` (`sql/917`-`918`); the `derived.commerce_customer_otp` `awcms_email_templates` row, seeded per existing tenant (`sql/919`); `awcms_commerce_affiliates`, `awcms_commerce_affiliate_commissions`, plus `orders.affiliate_id`/`store_settings.affiliate_commission_rate` (`sql/921`); `awcms_commerce_whatsapp_messages`, `awcms_commerce_whatsapp_delivery_attempts`, plus `awcms_commerce_customer_otps.phone_normalized` (`sql/925`); `awcms_commerce_conversations`, `awcms_commerce_messages` (`sql/927`); `awcms_commerce_customer_accounts.marketing_consent_at`, `awcms_commerce_campaigns`, `awcms_commerce_campaign_recipients` (`sql/929`) |
| Permissions | `categories.{read,create,update,delete,restore}`, `products.{read,create,update,delete,restore}` (`sql/902`, `sql/906`); `{flash_sales,vouchers,sliders,testimonials,popups}.{read,create,update,delete}`, `settings.{read,update}` (`sql/911`); `orders.{read,update}`, `customers.{read,update}`, `reviews.{read,update,delete}` (`sql/914`, deliberately no create/delete for orders or customers — see "Customers, orders and reviews" below); `affiliates.{read,update}`, `affiliate_commissions.{read,update}` (`sql/922`, same no-create/delete reasoning); `whatsapp.read` (`sql/925`, diagnostics only); `conversations.{read,update}` (`sql/928`, same no-create/delete reasoning); `campaigns.{read,update,send}` (`sql/930` — `send` split from `update`, the one action that reaches a real inbox/phone) — 49 in all                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| API         | `/api/v1/commerce/{categories,products,flash-sales,vouchers,sliders,testimonials,popups,store-settings,orders,customers,reviews,affiliates,affiliates/{id},affiliate-commissions,affiliate-commissions/{id}/{approve,pay,void},whatsapp/messages}` (owner side); `/api/v1/commerce/storefront/{cart/quote,orders,reviews}` (anonymous side, `orders`/`reviews` also accept an OPTIONAL `customerBearer`, Issue #91); `/api/v1/commerce/storefront/account/{otp/request,otp/verify,me,logout}` (anonymous OTP + `customerBearer`, Issue #89; `otp/request`/`otp/verify` gain `via`/`phone`, Issue #108; `me` gains `marketingConsent`, Issue #114); `/api/v1/commerce/storefront/account/{addresses,addresses/{id},addresses/{id}/default,wishlist,wishlist/{productId},orders,orders/{orderCode},reviews,affiliate,affiliate/commissions,conversations,conversations/{id},conversations/{id}/messages}` (`customerBearer`, Issues #91/#92/#111); `/api/v1/commerce/{conversations,conversations/{id},conversations/{id}/messages}` (owner side, Issue #111); `/api/v1/commerce/{campaigns,campaigns/{id},campaigns/{id}/{preview,send,cancel}}` (owner side, Issue #114) (`openapi/modules/commerce.openapi.yaml`)                                                                                                                                                                                                                            |
| Events      | `commerce.product.{created,updated,status_changed}`; `commerce.flash_sale.{started,ended}` (Issue #26, emitted by the tick job); `commerce.order.{created,paid,status_changed,cancelled,expired}`, `commerce.voucher.redeemed`, `commerce.review.published` (Issue #29)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Depends on  | `tenant_admin`, `identity_access`, `domain_event_runtime`, `media_library` (product images, sliders, testimonial avatars, the popup image and the store logo/favicon all resolve through `MediaLibraryPort`), `module_management` (the anonymous storefront tenant resolver checks the module is enabled for the tenant before answering), `profile_identity` (e-mail/phone masking), `email` (Issue #89 — the customer OTP channel's `email` adapter enqueues into `email`'s own outbox; Issue #108's WhatsApp dispatcher also reuses `email/domain/email-retry.ts`'s pure backoff function)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Jobs        | `commerce:flash-sales:tick` (`scripts/commerce-flash-sales-tick.ts`, every 5 minutes — persists each sale's derived status and fires the two flash-sale events); `commerce:orders:expire` (`scripts/commerce-orders-expire.ts`, every 5 minutes — expires unpaid orders past the store's configured window, restocks their lines, and fires `commerce.order.expired`); `commerce:whatsapp:dispatch`/`commerce:whatsapp:purge` (Issue #108 — the WhatsApp outbox's own drain/retention jobs)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

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
  `subtotal − discount`) → total. `previousUnitPrice` is always `null` and a
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

## External providers — contract only, except D4, D5, D8 and D9 (epic #33 wave 0 — ADR-0017, issue #106)

`openapi/modules/commerce.openapi.yaml` also now documents, AHEAD OF ANY
HANDLER, most of the increment-5 external-providers surface: a
payment-gateway session endpoint and public webhook intake (D2/D3,
Midtrans Snap), POS order creation (D6), three `reporting`-hosted sales
projections (D7), and the module-settings feature flags
plus tiered pricing at quote (D10). **D4 (courier rates), D5
(WhatsApp), D8 (the inbox) and D9 (consent-gated campaigns) are the four
exceptions — all IMPLEMENTED, not contract-only; see their own sections
below.** Every one of
D1–D10's ten decisions — why a port lives inside `commerce` rather than
`integration_hub`, why a webhook's tenant is resolved from an opaque
token rather than its payload, why the gateway flow is a redirect rather
than an embed, and so on — is recorded in
[ADR-0017](../../../../../docs/adr/0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md)
in awcms-one.

Every new path still pending a handler is named in
`ROUTE_PARITY_EXEMPTIONS` (`scripts/api-spec-check.ts`), each entry citing
the child issue that removes it: payment gateway + webhook endpoint
tokens (#110), POS (#116), sales reports (#117), gateway webhook intake +
reconciliation (#113) — the set is required to be EMPTY again once
increment 5 finishes, the same discipline #86/ADR-0016 already proved for
accounts. Courier rates', WhatsApp's, the inbox's and campaigns' own
exemption entries are already removed (#107, #108, #111, #114). ADR-0017
names every new environment variable this surface will read
(`COMMERCE_PAYMENT_GATEWAY`, `COMMERCE_MIDTRANS_SERVER_KEY`,
`COMMERCE_MIDTRANS_IS_PRODUCTION`) — none of those is read, declared in
`.env.example`, or checked by `scripts/validate-env.ts` yet; each is
added by its own adapter's issue, not by this contract-only change. The
RajaOngkir env vars (`COMMERCE_SHIPPING_RATE_PROVIDER`,
`COMMERCE_RAJAONGKIR_API_KEY`, …) and the WhatsApp env vars
(`COMMERCE_WHATSAPP_PROVIDER`, `COMMERCE_FONNTE_TOKEN`,
`COMMERCE_META_WA_TOKEN`, `COMMERCE_META_WA_PHONE_NUMBER_ID`, …) ARE
already read/declared/checked, and documented in the
[awcms-one deployment guide](../../../../../docs/deployment.md) — see
the "Courier rates"/"WhatsApp outbox" sections below.

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

## Deliberately not here

- **No payment gateway.** `payment_method` already accepts a `gateway`
  enum value, additively, with no implementing code behind it yet
  (ADR-0010, issue #33).
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
