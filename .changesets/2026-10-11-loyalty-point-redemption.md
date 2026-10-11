---
bump: minor
type: content
impact: public
---

# Loyalty points can be spent at checkout and the POS (issue #363, ADR-0043)

Closes the redemption item ADR-0026 deferred. Behind a new per-tenant commerce feature toggle, `loyaltyRedemption`, that **defaults OFF** and is independent of `loyalty`; and unavailable until a tenant sets a point value, which has **no default** (owner answer Q6).

- A signed-in shopper at checkout (`loyaltyRedemption: { points }` on `POST /storefront/orders`, bearer session, no cookie) or a cashier at the POS (the same field on `POST /pos/orders`, needing `commerce.loyalty_redemptions.create` in addition to `commerce.pos.create`) sends **only whole points**. The server prices a discount line: `points × rupiah-per-point` in integer cents, bounded by the goods (`subtotal − voucher discount`) and the tenant's optional cap; shipping, insurance and tax stay payable in money. Any other key in the object is a `400`.
- The ledger debit, the write-once `awcms_commerce_loyalty_redemptions` record and the order's `loyalty_discount` commit in one transaction under the account row lock; replay returns the same order and debits once, the same key with a different request is a conflict, an overdraw is refused whole, and two parallel redemptions of one balance have exactly one winner. Refusals are stable `409` codes found before any order row is written.
- Cancelling or expiring an order gives the points back in the same transaction, and a settled refund gives back the proportional share, each by a compensating `restore` ledger row with its own identity (`restore:order:<id>` / `restore:refund:<id>`), exactly once.
- Points and a refundable deposit cannot share an order (a `409` and a database CHECK); points paid for are not rewarded again; an issued invoice's discount and the returns refund share include the points discount.
- New: `GET/PUT/DELETE /api/v1/commerce/loyalty/redemption-settings` and a "Point value" panel on `/admin/commerce-loyalty`; the storefront account loyalty read gains `redemption`; the POS screen gains a "Spend loyalty points" field; the storefront checkout gains an optional points field for a signed-in shopper.
- Migrations `1010`–`1012` (`1013`–`1014` held), ADR-0043, OpenAPI fragments, i18n (en/id), subject-data, data-lifecycle and worker-grant registrations.
- Not here yet (ADR-0043): the cashier own-account guard (needs a customer-to-identity link), refunding a fully points-paid order, and the points discount in the sales-report `discount` figure.
