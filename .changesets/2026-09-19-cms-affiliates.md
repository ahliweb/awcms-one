---
bump: minor
type: structure
impact: public
---

# Affiliate program — schema, commissions on completed orders, storefront + owner API, admin screen (C4)

Issue #92 (part of epic #32, C4; contract #86's D5). Built on #87–#91's customer
accounts, a customer can now enrol as an affiliate, refer other shoppers with an
`?ref=` code, and earn a commission staff can approve/pay/void.

**Schema** (`apps/cms/sql/921_awcms_commerce_affiliates_schema.sql`,
`922_awcms_commerce_affiliates_permissions.sql`,
`923_awcms_commerce_affiliates_worker_lifecycle_purge_grants.sql`):
`awcms_commerce_affiliates` (one row per
enrolled customer — an 8-char unambiguous-alphabet `code` unique per tenant, a
`commission_rate` snapshot copied from the store's own rate at enrolment time,
`status` `active`/`suspended`) and `awcms_commerce_affiliate_commissions` (one row
per order that ever earned a commission — `order_id` unique per tenant forever,
`base_amount`/`rate`/`amount` snapshots, `status` `pending → approved/void →
paid`). Plus `awcms_commerce_orders.affiliate_id` and
`awcms_commerce_store_settings.affiliate_commission_rate` (a real column, `null` =
program off). Permissions `commerce.affiliates.{read,update}`,
`commerce.affiliate_commissions.{read,update}` (`sql/922`); worker purge grants
(`sql/923`).

**Storefront** (bearer-secured, `requireCustomerSession`): `GET`/`POST
account/affiliate` (`POST` is idempotent — a second call returns the same row;
`409 AFFILIATE_PROGRAM_DISABLED` when the tenant's rate is unset) and `GET
account/affiliate/commissions` (keyset). `POST .../storefront/orders`'s
`affiliateCode` (shape-validated since #91) is now resolved against
`awcms_commerce_affiliates.code` — an unknown or suspended code links nothing and
never fails the checkout; a valid, active code sets `orders.affiliate_id`.

**Commission lifecycle**: the ONE place a commission is created is
`order-directory.ts`'s status-transition function, on the transition to
`completed` — `base = subtotal − discount − voucher_discount` (floored at zero),
`amount = round(base × rate / 100, 2)`, both via the module's existing
integer-cent string-decimal arithmetic (ADR-0003). No commission on self-referral,
and none if the affiliate has been suspended since the order was placed
(`shouldEarnCommission` re-checks both at completion time, independently of the
order-creation-time check).

**Owner API**, gated on the new permissions: `GET`/`PATCH
commerce/affiliates(/{id})` (list, edit status/rate), `GET
commerce/affiliate-commissions?status=` (list), `POST
commerce/affiliate-commissions/{id}/{approve,pay,void}` (state machine
`pending → approved → paid`, `pending|approved → void`, each transition requiring
an `Idempotency-Key`). `GET /commerce/store-settings/public` now exposes
`affiliateProgramEnabled: boolean` only — never the rate; the owner
`GET`/`PUT /commerce/store-settings` carry `affiliateCommissionRate` (0–100, two
decimals, nullable).

**Admin screen**: `/admin/commerce-affiliates.astro` — affiliates table
(code/customer/rate/status, suspend/activate/edit-rate) and a commissions table
(filterable by status, approve/pay/void), i18n `en`+`id`;
`/admin/commerce-settings.astro` gains the commission-rate field.

Removed from `ROUTE_PARITY_EXEMPTIONS` (`apps/cms/scripts/api-spec-check.ts`),
which is now empty — every path #86 documented ahead of its handler has one.
