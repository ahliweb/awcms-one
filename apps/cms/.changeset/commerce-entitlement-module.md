---
"awcms": minor
---

feat(commerce): add commerce entitlement module (Issue #267, IRMbyDUS)

New `awcms_commerce_entitlements` table (`sql/936`/`937`, permission catalog seed `sql/938`) recording which customer holds access to which product, granted idempotently the moment the sourcing order reaches `paid` (`commerce.order_paid_entitlement_grantor`, a `domain_event_runtime` consumer on `COMMERCE_ORDER_PAID_EVENT_TYPE`, guarded by both `applyConsumerEffectOnce` and a `(tenant_id, source_order_id, product_id)` unique index — firing the same event twice yields exactly one row per product), checked live with no cache (`verifyEntitlement`), and revoked only by an admin today (`POST /api/v1/commerce/entitlements/{id}/revoke`) since no `refunded` order status/event exists yet to auto-revoke from.

**Deliberately namespaced apart from `identity-access`'s unrelated ADR-0084 entitlement concept** (tenant/plan feature-gating) — see `sql/936`'s header for the full disambiguation. Every new file is `commerce-entitlement*`/`commerce.entitlements.*`, never a bare `entitlement.ts`/`awcms_entitlements`.

New endpoints:

- `GET /api/v1/commerce/entitlements` — admin list, `ownerCustomerId`/`productId`/`status` filters (`entitlements.read`)
- `POST /api/v1/commerce/entitlements/{id}/revoke` — admin revoke (`entitlements.update`)
- `GET /api/v1/commerce/storefront/account/entitlements` — "my entitlements", bearer session
- `GET /api/v1/commerce/storefront/account/entitlements/check?productId=` — entitlement-check for the calling customer

`entitlement.granted`/`entitlement.revoked` audit events via the existing `logging/application/audit-log.ts` writer — no new logging subsystem. `dataLifecycle`/`subjectData` descriptors added to `commerce/module.ts` (owner-scoped, no subject vocabulary reaches a storefront customer, ADR-0016 D1 — same as `commerce.customer_accounts`). Admin screen deliberately deferred (API-only this PR, recorded in `DELIBERATELY_UNSCREENED`); a list+revoke screen is reasonable follow-up work.
