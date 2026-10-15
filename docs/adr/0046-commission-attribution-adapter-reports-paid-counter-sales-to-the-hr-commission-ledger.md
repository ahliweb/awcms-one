🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0046-commission-attribution-adapter-reports-paid-counter-sales-to-the-hr-commission-ledger.id.md)

# ADR-0046 — The commission attribution adapter reports paid counter sales to the `hr_commission` ledger

- **Status:** Proposed
- **Date:** 14 October 2026
- **Decision maker:** proposed in the implementing pull request for ahliweb's review, within the constraints already fixed by [ADR-0040](0040-aw-business-platform-capability-ownership-and-boundaries.md) D4 and the template-only rule of [ADR-0024](0024-awcms-one-is-template-only-derived-apps-own-their-backend.md); it becomes Accepted when the pull request is merged
- **Related:** issue [#391](https://github.com/ahliweb/awcms-one/issues/391) (this ADR and its implementation; **stays open** for the reversal half, see D8), epic [#280](https://github.com/ahliweb/awcms-one/issues/280), prerequisite [#409](https://github.com/ahliweb/awcms-one/issues/409) (the sync that brought `hr_commission` and `hr_workforce` in); [ADR-0040](0040-aw-business-platform-capability-ownership-and-boundaries.md) D4 and D5 item 4; [ADR-0037](0037-the-commerce-migration-band-is-allocated-gap-first-and-widened-upstream.md) (migrations `1030` and `1031`); [ADR-0016](0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) is not involved (nothing here authenticates a shopper); the threat model [flow F5](../aw-business-platform-threat-model.md) and F7; upstream `ahliweb/awcms` ADR-0132 and ADR-0011 (the port contract) and the `hr_commission` module README (`apps/cms/src/modules/hr-commission/README.md`, "Reversal is the next step of the ledger")

## Context

Upstream's `hr_commission` module keeps a ledger of commissions earned by employments. It accepts a **sale fact** through a neutral port, `CommissionAccrualPort` (`apps/cms/src/modules/_shared/ports/commission-accrual-port.ts`), and states plainly that verifying the sale is real, paid and the employee's is **the adapter's duty**, not the ledger's. This repository owns that adapter for `commerce` (ADR-0040 D4): a paid order line, and later the refund that reverses it. Affiliate commission in `commerce` is a different thing with an external beneficiary and stays where it is.

The port exposes **only `accrue`**. Reversals are a later phase of the ledger (the module README's own "next step"). That shapes the whole decision: this change can report a sale, and cannot take one back.

The adapter must also be a **reusable template capability** (ADR-0024): no consumer's commission scheme, no consumer names, nothing that assumes one deployment. The tenant authors its rule in `hr_commission`; `commerce` only says which paid thing is reported and for whom.

## Decision

### D1 — A descriptor-declared consumer of the order-paid fact, off by default

`commerce.order_paid_commission_attributor` is declared in `apps/cms/src/modules/commerce/module.ts` `domainEventConsumers`, subscribed to `awcms.commerce.order.paid`, with the default `runtime_effect_once` idempotency (upstream `ahliweb/awcms` ADR-0134, in `apps/cms/docs/adr/`; the handler is the side effect only and never calls the guard). It does nothing unless the tenant has switched it on in `awcms_commerce_commission_settings` (`enabled`, default `false`; a CHECK forbids `enabled` without a rule key). The settings are a small dedicated table rather than a new feature toggle in the `commerce` module-settings blob: they carry a rule key, a toggle would add a settings-screen surface and catalogue strings for a feature that has no screen yet, and the database can then refuse "on without a rule".

### D2 — The beneficiary is derived on the server, never supplied (threat model F5, row T)

No order, cart or checkout field names the employee. The consumer attributes an order only when **all** of these hold, read from the database and never from the event payload:

1. the order is past payment and not cancelled (`paid`, `processing`, `shipped`, `completed`) **and** `payment_status = 'paid'`;
2. its `channel` is `pos`;
3. it carries `pos_cashier_tenant_user_id`, which `pos-directory.ts` stamps from the authenticated session when the sale is rung up;
4. that login has a **live** staff link (D3).

A storefront order, an unstamped sale and an unlinked login are all skipped: there is no fallback beneficiary and no default employee.

The issue text and the first design named the register session's operator as the seller. The cashier stamp on the **order** is used instead: it is the login that actually rang up this sale (a session's `current_cashier_tenant_user_id` can change during a shift, and `opened_by_tenant_user_id` is who opened the till, not who sold), and it exists whether or not the tenant uses the register feature. It has the same trust as the session fact, since both are stamped server-side from the authenticated actor.

| Option for "who sold"                               | Security                                           | Correctness                                     | Compatibility                       |
| --------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------- | ----------------------------------- |
| **A. The order's own cashier stamp**                | Server-stamped from the session; client cannot set | Exact: the login that rang up _this_ sale       | Works with the register feature off |
| B. The register session's opener or current cashier | Server-stamped                                     | Wrong after a hand-over or when a manager opens | Needs the register feature on       |
| C. A field on the sale naming the employee          | Rejected: client-supplied, self-assignment (F5)    | n/a                                             | n/a                                 |

### D3 — A commerce-owned staff link maps a login to an opaque employment id

`awcms_commerce_commission_staff_links` (`tenant_id`, `tenant_user_id`, `employment_id`, who created and retired it and when) joins a tenant user to an `hr_workforce` employment id. The employment id is **opaque**: no foreign key, no read, no join (the boundary test in `apps/cms/tests/commerce-commission-boundary.test.ts` scans commerce sources and commerce migrations for `awcms_hr_*` tables and `hr-commission/` and `hr-workforce/` imports). The ledger validates the employment (it exists in the tenant, is live and employed on the sale date) under lock when an accrual is written, and refuses the sale otherwise. The tenant-user side is a composite `(tenant_id, tenant_user_id)` foreign key.

A login has at most one live link and an employment at most one (partial unique indexes). A link is **retired, never deleted**: `awcms_app` has no DELETE and a trigger refuses it for every role; who a link joins never changes; a retired link is final, and a correction is a retire plus a new link, so the history shows both. Creating and retiring are behind `commerce.commission_staff_links.manage` (a high-risk action) and audited; listing is `.read`. The settings have `commerce.commission_settings.read` and `.manage`. Existing verbs only, so the upstream-owned `AccessAction` union is not widened.

The manual mapping is a known weakness (a mistyped employment id attributes a commission to the wrong person). The mitigations are the high-risk permission, the audit row naming both ids, and the ledger's own eligibility checks; the real fix is a workforce port that resolves "the employment of this login" (D8).

### D4 — The reported fact: one line, its net base, the tenant's date

For every non-deleted order line with a positive net, the consumer calls `accrue` once with:

- **source identity** `(type, ref, line)` = `(settings.sourceType, order id, order-line id)`; `sourceType` defaults to the neutral `commerce_order_line` and must equal the `sourceType` the tenant's rule declares (the port refuses a mismatch). The ledger adds the employment to its unique key, so a replay is the same accrual;
- **base amount** = the line total less its pro-rata share of the order-level discounts (`discount` + `loyalty_discount`, the figures the loyalty earner nets off), allocated with the same largest-remainder function the returns module uses (`allocateOrderDiscount`), so a later refund-driven correction maps to the same per-line numbers. Shipping, insurance and tax are never in the base. Money is a decimal string, never a number;
- **currency** = `IDR`, commerce's single currency (documents and quotations CHECK it; the order has no currency column). A rule in another currency is refused by the port, not converted;
- **occurredAt** = the order's `paid_at`; **occurredOn** = its civil date in the **tenant's own time zone** (`awcms_tenant_settings.timezone`, falling back to commerce's reporting zone `Asia/Jakarta` when the tenant has no settings row). No consumer-specific value is hard-coded: the zone is the tenant's.

### D5 — Wired as an optional capability, through one seam

`commerce` declares `capabilities.consumes: [{ capability: "commission_accrual", providedBy: "hr_commission", optional: true }]` and **not** a lifecycle dependency: commerce must stay enablable, and keep working, for a tenant that never switches `hr_commission` on, and a hard edge would make it a prerequisite of the whole store. The consumer checks the tenant's `hr_commission` module state itself before calling anything. The concrete adapter (`createCommissionAccrualPort`) is named in exactly one file, `apps/cms/src/modules/commerce/application/commission-attribution-port.ts`, the composition root the port's contract asks for; every other file depends on the port _type_. The boundary test fails if that ever widens. No upstream-owned file is edited for behaviour, so the divergence list in the root `AGENTS.md` does not grow. The only rows this adds to a shared registry are the ones every module adds: four lines in the shrink-only `NOT_YET_SCREENED` ledger (the way `hr_commission`'s own keys were added) and the worker-grant rows in `security-readiness.ts`.

### D6 — The consumer is a system actor; a refusal is an audited outcome, not an exception

The port performs no access check and writes no audit row: the consumer's composition root must authorize and audit the business action. There is no acting user at delivery time. The authorization to pay commission is given, by holders of the two `manage` permissions, when the tenant switches the adapter on and when a login is linked, and both are audited at `warning`. The accrual's `created_by` is therefore `null` (the system), and every attempt that changes anything is audited by the consumer with the order as the resource and **no amount, base, rate, source reference or employment id**: `commerce.commission.attributed` (info, with line counts), `commerce.commission.attribution_refused` (warning, one per refusal kind) and `commerce.commission.attribution_rejected` (warning, source conflicts and invalid requests). A pure replay audits nothing.

`no_effective_rule`, `employment_not_eligible` and the other refusals are **returned** outcomes and are never thrown: a delivery that throws is retried eight times and then dead-lettered for a configuration problem no retry can fix. An order-wide refusal stops at the first line (the answer would be the same for every line). Only a genuine failure (the database) throws, rolling the delivery back, marker included. The consequence is that **a refused sale is not re-driven automatically**: the tenant fixes the rule or the link and the missed sale is not retried. Re-driving is cheap (the ledger key makes it idempotent) but needs an operator action that does not exist yet; it is recorded below.

### D7 — The worker role gets the narrowest grants the posting core needs (`sql/1031`)

The consumer runs in `domain-events:dispatch` as `awcms_worker`, and the port's posting core and its guard triggers run in the caller's transaction with the caller's privileges. Migration `1031` grants: SELECT on the two commerce tables; SELECT and INSERT on the accrual and its transition log (never UPDATE or DELETE: the worker cannot approve, void, pay or rewrite an accrual); SELECT on the rule and the employment plus a **column-level `UPDATE (id)`** on those two (PostgreSQL requires an UPDATE privilege for the `FOR SHARE` reads that keep a concurrent retire or termination from slipping between the check and the insert; the single-column grant on the immutable key is the narrowest way, the precedent being the inventory locations); SELECT on `awcms_tenant_settings` (the time zone) and `awcms_tenant_modules` (module state). `WORKER_ROLE_GRANTS` in `apps/cms/scripts/security-readiness.ts` carries the table-level rows. Integration tests run the whole job as the worker role, show that dropping the column grant breaks it, and show the worker cannot approve, void, rewrite or delete an accrual, change a rule or an employment, or touch a link or the settings.

### D8 — Reversal on refund, return or cancel is NOT implemented: the port has no void

The acceptance criterion "refund voids" **cannot be met in this repository today**. `CommissionAccrualPort` exposes only `accrue`. The only ways to void are an authenticated HTTP action (`POST /api/v1/hr-commission/accruals/{id}/void`, behind `hr_commission.accruals.void` for a user) or importing `hr_commission`'s application code, which the module boundary forbids (the port exists so commerce never does that). Reaching into the ledger's tables from commerce, or calling its application functions directly, would be exactly the back door this ADR refuses; it is not done. A voided accrual would also keep its source key, and a payable or paid accrual needs a reversal, which upstream has not built yet.

What this change therefore does is state the gap and propose the upstream extension, to be raised against `ahliweb/awcms` (generic AWCMS foundation follows upstream ownership; it is not a local divergence):

```ts
// apps/cms/src/modules/_shared/ports/commission-accrual-port.ts: a MINOR contract bump
export type CommissionVoidRequest = {
  employmentId: string;
  source: CommissionAccrualSource; // the identity the accrual was reported under
  reasonCode: string; // short code, never free text
  correlationId?: string;
};
export type CommissionVoidOutcome =
  | { outcome: "voided" | "already_voided"; accrualId: string }
  | { outcome: "not_found" }
  | { outcome: "not_voidable"; status: "payable" | "paid" } // needs the reversal phase
  | { outcome: "input_invalid"; message: string };
// CommissionAccrualPort gains:
//   void(tx, tenantId, actorTenantUserId, request): Promise<CommissionVoidOutcome>
```

A void by **source identity** (not by accrual id) is what lets a stateless adapter undo exactly what it reported. Once it lands, `commerce` adds consumers for the order-cancelled and return-recorded or refund-settled facts, reusing the same `(sourceType, order id, order-line id)` identity, mapping a partial return per line with the allocation function above, and reporting `not_voidable` accruals for the reversal phase. A second proposal rides with it: a workforce port that resolves the employment of a login, so the staff link (D3) can be validated at creation instead of trusted. **Until then a refund, return or cancellation does not reduce a commission already accrued**; the accrual stays `pending` for a human with `hr_commission.accruals.void` to void by hand, and the docs say so. The coordinating issue stays open for this half.

## Consequences

- A tenant that does nothing sees no change: the adapter is off, no table is read per order, no accrual is made.
- Replays, redeliveries and racing deliveries produce one accrual per line; the exactly-once guarantee is the ledger's unique key, tested with six racing deliveries.
- The beneficiary cannot be asserted by a client. The residual risk is the staff link typed by an administrator, which is high-risk, audited and checked at accrual time for eligibility only.
- **Residual: the paid verification is the order's own `paid`/`payment_status` fact**, not a fresh recomputation from the payment-allocation ledger (threat model F5 row S/T asks for the stronger form). It is the same fact the loyalty earner trusts; a ledger cross-check is a follow-up.
- No admin screen yet. The four permissions are on the shrink-only `NOT_YET_SCREENED` ledger; the API (and OpenAPI) is complete.
- No `ROUTE_PARITY_EXEMPTIONS` entry: all three route files exist with their contract.

## Not here yet

- Voiding or reversing a commission on refund, return or cancel (D8; upstream port extension and the reversal phase).
- A way to re-drive a sale refused for a missing rule once the tenant has fixed it.
- The settings and staff-link admin screens.
- A recomputation of "paid" from the payment-allocation ledger.
- Booking-sourced commission (the Booking adapter's own issue).
