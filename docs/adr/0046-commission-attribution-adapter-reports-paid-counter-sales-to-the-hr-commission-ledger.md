🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0046-commission-attribution-adapter-reports-paid-counter-sales-to-the-hr-commission-ledger.id.md)

# ADR-0046 — The commission attribution adapter reports paid counter sales to the `hr_commission` ledger

- **Status:** Proposed
- **Date:** 14 October 2026
- **Decision maker:** proposed in the implementing pull request for ahliweb's review, within the constraints already fixed by [ADR-0040](0040-aw-business-platform-capability-ownership-and-boundaries.md) D4 and the template-only rule of [ADR-0024](0024-awcms-one-is-template-only-derived-apps-own-their-backend.md); it becomes Accepted when the pull request is merged
- **Related:** issue [#391](https://github.com/ahliweb/awcms-one/issues/391) (this ADR and its implementation; the accrue half is D1-D8, the reversal half is D9), epic [#280](https://github.com/ahliweb/awcms-one/issues/280), prerequisite [#409](https://github.com/ahliweb/awcms-one/issues/409) (the sync that brought `hr_commission` and `hr_workforce` in); [ADR-0040](0040-aw-business-platform-capability-ownership-and-boundaries.md) D4 and D5 item 4; [ADR-0037](0037-the-commerce-migration-band-is-allocated-gap-first-and-widened-upstream.md) (migrations `1030` and `1031`); [ADR-0016](0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) is not involved (nothing here authenticates a shopper); the threat model [flow F5](../aw-business-platform-threat-model.md) and F7; upstream `ahliweb/awcms` ADR-0132 and ADR-0011 (the port contract) and the `hr_commission` module README (`apps/cms/src/modules/hr-commission/README.md`, "Reversal is the next step of the ledger")

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

### D9 — Amendment (second half of #391): cancel and refund void the accrual through `CommissionAccrualPort.void`

D8 is superseded in its conclusion, not in its reasoning. Upstream shipped the extension D8 asked for (ahliweb/awcms#1109, port contract `commission_accrual` 1.1.0, synced by #427): `void(tx, tenantId, actorTenantUserId, { source, employmentId, reason, correlationId })` keyed by the same source identity as `accrue`, with the outcomes `voided`, `already_voided`, `not_found`, `period_closed`, `actor_required` and `input_invalid`. The extension also made two choices that differ from D8's proposal and are followed as shipped: a `payable` or `paid` accrual is refused as `period_closed` (`not_voidable` in the proposal), and the voider must be a person.

**Two more descriptor-declared consumers, both `runtime_effect_once` by default (the handler is only the effect, it never calls the guard):**

| Consumer                                       | Event                            | What it reverses                                            |
| ---------------------------------------------- | -------------------------------- | ----------------------------------------------------------- |
| `commerce.order_cancelled_commission_reverser` | `awcms.commerce.order.cancelled` | every line of the order                                     |
| `commerce.refund_settled_commission_reverser`  | `awcms.commerce.refund.settled`  | each line of the refunded return that is now fully returned |

Both read the database, never the payload, and re-derive the beneficiary as the accrue does (the order's cashier stamp, then the staff link), with the source identity `(settings.sourceType, order id, order-line id)`. They try **every employment the login was ever linked to, live or retired**: the link may have been retired or re-pointed between the sale and its refund, and an accrual belongs to the employment linked when the sale was paid. A void for an employment that never earned the line is `not_found`, a harmless no-op. Commerce still reads no commission table and holds no ledger id; the audit rows carry the order as the resource and counts only.

**Partial refunds (the decision).** The port voids a whole accrual and a voided accrual is never resurrected, so a partly refunded line cannot be reversed pro rata. Two options were weighed: void the line's accrual on any refund of it, or do nothing for the line until it is fully returned. The second is chosen, per line: a refund reverses a line's accrual only when the summed quantity of that line across all `completed` returns of the order reaches the quantity ordered (`isLineFullyReturned`). Reasons: it is the conservative direction for an irreversible operation (a wrongly kept commission is one human `void` away, through `hr_commission.accruals.void`, and is _flagged_; a wrongly voided one cannot be undone and takes earned pay from a person for units the customer kept); it never needs a rate or an amount in commerce (D4: the ledger owns the arithmetic); and it matches D8's own statement that a partial return maps per line. The deferred case is not silent: it is counted, and one `commerce.commission.reversal_needs_attention` warning row records `partiallyReturnedLines`. A return is considered only when `completed` (its last refund leg has settled): an earlier leg's event finds it open and does nothing, so money still outstanding reverses nothing. A return that moves no money (an exchange with no refund leg) publishes no `refund.settled` and reverses nothing.

**`period_closed`.** The consumer never retries it and never throws on it: a thrown delivery is retried eight times and dead-lettered for something no retry can change. The line stays as it is, the tally is carried into one `commerce.commission.reversal_needs_attention` warning audit row (cause, how many were `payable`, how many `paid`) and the delivery completes. That row is the human's work item (a clawback, which the family has no mechanism for yet; upstream records a compensating negative row as the follow-up of `sql/188`). There is no separate attention table: commerce's existing pattern for "a person must look" is a warning-severity audit row (D6), and a new queue would be a second concept with no screen. `actor_required` and `input_invalid` take the same route.

**The actor.** `void` stamps a person (`voided_by`, NOT NULL by the lifecycle CHECK; `null` is `actor_required`), and an event consumer has no acting user (the envelope's actor does not reach a handler, and a customer's own cancellation or the expiry job has none anyway). The voider is the tenant user who last saved the commission settings, the person who authorised commission to be paid for this tenant (D6 already rests the system accrual on that authorisation). The ledger's own audit row therefore names that person as voider, and the commerce audit row says the reversal was automatic; this is the one place where the ledger's `voided_by` is an attribution, not a hand on the till, and it is stated here rather than hidden. If there is none, the outcome is `actor_required` and the reversal waits for a person. There is no invented service-account login.

**Gating.** A reversal needs `hr_commission` to be on and the adapter to have been configured once (a settings row exists); it does **not** need `enabled` to be true. Switching the adapter off stops new accruals; it must not strand the accruals already made when their sale is cancelled. The source type is the settings' current one: changing it after accruing orphans the older accruals from automatic reversal (they surface as nothing to void, so the tenant must void them by hand), the same constraint the accrue's `source_type_mismatch` already imposes on a rule.

**Grants (`sql/1051`, the first number above the `1035`-`1049` band reserved for the Booking adapter and the `1050` fallback held by #386).** D7's "the worker never UPDATEs an accrual" is narrowed, not dropped: `awcms_worker` gets `UPDATE (status, voided_at, voided_by, void_reason_code)` on `awcms_hr_commission_accruals` and nothing else. The table-level matrix keeps `SELECT, INSERT`; `WORKER_COLUMN_GRANTS` records the four columns. The lifecycle CHECK, the immutability trigger and the append-only transition log still decide which edge is legal, and the port refuses a `payable` or `paid` accrual before any write, so the worker still cannot approve, release, pay, change an amount, a rule, a source or a beneficiary, or delete. The integration suite runs the whole path as the real worker role, shows that revoking the column grant breaks the reversal and restoring it repairs it, and shows the other writes are still refused.

**Boundaries.** The AGENTS.md divergence list does not grow: no upstream-owned file changes behaviour; the additions to shared registries are the same kind D5 already lists (a `WORKER_COLUMN_GRANTS` row in `security-readiness.ts`, two consumer names in `domain-event-consumer-declarations.test.ts`).

## Consequences

- A tenant that does nothing sees no change: the adapter is off, no table is read per order, no accrual is made.
- Replays, redeliveries and racing deliveries produce one accrual per line; the exactly-once guarantee is the ledger's unique key, tested with six racing deliveries.
- The beneficiary cannot be asserted by a client. The residual risk is the staff link typed by an administrator, which is high-risk, audited and checked at accrual time for eligibility only.
- **Residual: the paid verification is the order's own `paid`/`payment_status` fact**, not a fresh recomputation from the payment-allocation ledger (threat model F5 row S/T asks for the stronger form). It is the same fact the loyalty earner trusts; a ledger cross-check is a follow-up.
- No admin screen yet. The four permissions are on the shrink-only `NOT_YET_SCREENED` ledger; the API (and OpenAPI) is complete.
- No `ROUTE_PARITY_EXEMPTIONS` entry: all three route files exist with their contract.

## Not here yet

- A clawback of a `payable` or `paid` accrual after a refund or cancel (D9 records it for a person; the family has no reversal-into-the-current-period mechanism yet).
- Pro-rata reversal of a partly returned line (D9: the port voids a whole accrual).
- Reversing the commission of a return that moves no money (an exchange with no refund leg).
- A way to re-drive a sale refused for a missing rule once the tenant has fixed it.
- The settings and staff-link admin screens.
- A recomputation of "paid" from the payment-allocation ledger.
- Booking-sourced commission (the Booking adapter's own issue).

### D9 — The source identity is frozen once an attribution exists (issue #413 review, `sql/1052`)

The accrual source identity is `(settings.sourceType, order id, order-line id)`, and the ledger treats the same identity under a different `ruleKey` as a `source_conflict`. A later void is addressed by the same identity. If an administrator changed `sourceType` or `ruleKey` after accruals existed, a void keyed from the current settings would silently miss and a redelivered event could accrue a second time under the new identity.

Decision: the settings `PUT` **refuses to change `sourceType` or `ruleKey` while any accrual has been reported under the stored pair**: `409 COMMISSION_SOURCE_LOCKED`, audited at `warning` as `commerce.commission.settings_refused` (stored and requested codes only). Re-sending the stored values, and changing only `enabled`, are always accepted. Commerce cannot ask the ledger whether an accrual exists (it reads no commission table, D3, and `CommissionAccrualPort` has only `accrue`), and the audit trail is subject to purge, so the answer is commerce's own: `awcms_commerce_commission_attributed_sources`, one insert-only row per `(tenant, source_type, rule_key)`, written by the consumer in the SAME transaction as the accrual it protects (`ON CONFLICT DO NOTHING`; a replay also writes it). The consumer takes `pg_advisory_xact_lock_shared` on a tenant-scoped key before it reads the settings; the settings update takes the exclusive lock on the same key, reads the marker and decides under it, so a change cannot interleave with an in-flight attribution (the inventory mode lock's shape). The worker has `SELECT, INSERT` only and a guard trigger refuses UPDATE and DELETE for every role. The table holds two codes and a timestamp: no subject data, retained for the life of the tenant. The deliberately blunt consequence: to use another rule or source type after the first attribution, the tenant needs a deliberate migration, not a settings edit.
