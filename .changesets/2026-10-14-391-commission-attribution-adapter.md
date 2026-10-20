---
bump: minor
type: content
impact: public
---

# Paid counter sales are reported to the `hr_commission` ledger (issue #391, ADR-0046)

A reusable `commerce` adapter for the employee-commission ledger that arrived with the #409 sync. **Off by default**; the tenant authors its rule in `hr_commission` and names the rule key in the new settings. Nothing consumer-specific lives here (ADR-0024).

- The `commerce.order_paid_commission_attributor` domain-event consumer (descriptor-declared, default `runtime_effect_once`) reports each line of a **paid POS sale** through the neutral `CommissionAccrualPort`: source `(sourceType, order id, order-line id)`, base = the line's net after its pro-rata share of the order discounts, currency `IDR`, dated in the tenant's own time zone. A replay, a redelivery and racing deliveries are one accrual per line (the ledger's unique key).
- **The beneficiary is never a client field.** It is the employment linked to the login the server stamped on the order as its cashier, through a commerce-owned staff link (an opaque employment id, no foreign key, retired never deleted, one live link per login and per employment). A storefront order, an unstamped sale and an unlinked login are not attributed.
- New API (OpenAPI, no admin screen yet): `GET|PUT /api/v1/commerce/commission/settings`, `GET|POST /api/v1/commerce/commission/staff-links`, `POST .../staff-links/{id}/retire`; four permissions `commerce.commission_settings.{read,manage}`, `commerce.commission_staff_links.{read,manage}` (`manage` is high-risk and audited). The ledger's refusals (no rule in force, employment not eligible, source type or currency mismatch) are audited outcomes, never exceptions, and no audit row carries an amount.
- Commerce reads no commission table and imports `hr-commission` code in exactly one file (the port seam); `hr_commission` is an optional consumed capability, not a lifecycle dependency. `apps/cms/tests/commerce-commission-boundary.test.ts` enforces this. Migrations `1030`–`1031` (the latter gives `awcms_worker` the narrow grants the port's posting core needs, including a column-level `UPDATE (id)` for its `FOR SHARE` reads).
- **Reversal is the second half** (`2026-10-18-391-commission-void.md`, ADR-0046 D9): the port had no `void` when this adapter was written (D8). Also not here: a way to re-drive a sale refused for a missing rule, the two admin screens, and recomputing "paid" from the payment ledger.
- **The source identity is frozen once an attribution exists (issue #413 review, ADR-0046 D9).** Migration `1052` adds the insert-only `awcms_commerce_commission_attributed_sources` marker, written by the consumer in the same transaction as the accrual under a shared tenant advisory lock. The settings `PUT` takes the exclusive lock and answers `409 COMMISSION_SOURCE_LOCKED` (audited as `commerce.commission.settings_refused`) for a changed `sourceType` or `ruleKey` once a marker exists, so a later void or redelivery cannot key a different identity. Unchanged values and `enabled` stay free.
