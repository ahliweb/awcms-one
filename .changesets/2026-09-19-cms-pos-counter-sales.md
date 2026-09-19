---
bump: minor
type: structure
impact: public
---

# POS — cash counter sales, `orders.channel`, `commerce.pos.create`, POS screen + history

Issue #116 (epic #33 C7, contract #106 D6, ADR-0017). BjekMart's kasir as
one more order-creation path over the SAME order tables, quote engine and
status graph — never a second sales ledger. With it the last path #106
merged ahead of its handler has one, and `ROUTE_PARITY_EXEMPTIONS` is
empty again as `AGENTS.md` requires before the epic closes.

- `apps/cms/sql/931_awcms_commerce_pos_schema.sql`: `awcms_commerce_orders`
  gains `channel text NOT NULL DEFAULT 'storefront' CHECK IN
  ('storefront','pos')` (every pre-existing order is `storefront` by the
  default) and `pos_cashier_tenant_user_id uuid` (a plain stamp, not a
  foreign key — a fiscal record outlives a staff account); the
  `payment_method` CHECK is dropped and re-created with `cash`; indexes
  `(tenant_id, channel, created_at DESC)` and a partial cashier index.
  `sql/932` seeds the one new permission, `commerce.pos.create`.
- `PaymentMethod` gains `"cash"` — re-exported unchanged by
  `packages/kontrak`'s `pesanan.ts`, so `apps/storefront` sees the widened
  union at compile time (additive; the storefront's own checkout validator
  still refuses `cash`, and even a body that reached the application layer
  finds no available `cash` method). New `domain/pos-order-validation.ts`:
  lines/customer/payment shape, `amountTendered` REQUIRED for cash as a
  `numeric(14,2)` STRING, `computeChange` in `bigint` cents (ADR-0003).
- `application/pos-directory.ts`: `createPosOrder` — customer first (no
  phone → the tenant's single walk-in row under the documented sentinel
  `+620000000000`; a phone → find-or-create by normalised number, and that
  customer's `level` prices the sale), then the SAME `buildCartQuote` the
  storefront uses, insert `channel='pos'` + cashier stamp, decrement stock,
  audit `commerce.pos.sale`, and `pending_payment → paid` in the same
  transaction (actor `admin`) through the shared status transition, so
  #117's sales projections pick the sale up like any paid order.
  `Idempotency-Key` header required; the hash binds the acting cashier.
  `listPosOrders`: keyset history, `channel='pos'`, date/cashier filters.
- Owner routes `GET|POST /api/v1/commerce/pos/orders` (`commerce.orders.read`
  / `commerce.pos.create`), both `409 FEATURE_DISABLED` when the tenant's
  `pos` feature (#118) is off; `409 CART_CHANGED` / `INSUFFICIENT_TENDER` /
  `IDEMPOTENCY_CONFLICT` on the write.
- The storefront never serves a POS order: the anonymous tracking lookup and
  the bearer account history filter `channel = 'storefront'` (the sentinel
  phone is documented, so honouring it on tracking would expose every
  walk-in receipt by order code), and the storefront checkout refuses the
  sentinel phone as a customer identity.
- Admin screen `/admin/commerce-pos` (entry any-of `commerce.pos.create` /
  `commerce.orders.read`, nav entry `requiredFeature: pos`): product search
  + cart island, optional customer quick-fields, cash (tendered + live
  change) / QRIS, submit with `Idempotency-Key`, printable receipt
  (`@media print`), history tab with filters and keyset paging. Every
  client string is `t()`-rendered into `data-*` attributes; catalog data
  reaches the DOM through `textContent` only. English + Indonesian
  catalogue entries added.
- `apps/cms/scripts/client-asset-budget.ts` `APP_BUDGET_BYTES` 237,800 → 246,500:
  measured 246,276 B, +8,718 B = exactly this screen's own script (5,854 B)
  and scoped stylesheet (2,864 B) — the one admin screen that IS a client
  island by design.
- `commerce.orders`'s `subjectData` descriptor gains the cashier stamp as a
  `tenant_user` subject column; erasure stays `retain_under_obligation`.
- Tests: `apps/cms/tests/commerce-pos-domain.test.ts` (validation, string change
  arithmetic incl. the IEEE-754 failure cases, storefront refuses cash),
  `apps/cms/tests/integration/commerce-pos.integration.test.ts` (real Postgres: paid
  immediately + stock decremented + events/audit, history vs. storefront
  exclusion, walk-in reuse + level pricing, idempotent replay/conflict,
  short tender writes nothing, `409 FEATURE_DISABLED`), and the POS block
  of `apps/cms/tests/admin-commerce-page-contract.test.ts`.
- Docs: `docs/cms.md` (POS workflow + receipt), `docs/skema-basis-data.md`,
  `docs/kamus-data.md` (`channel`, `cash`, the walk-in sentinel),
  `docs/api.md`, the commerce module README, and their Indonesian mirrors.
