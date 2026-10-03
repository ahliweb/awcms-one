🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0026-loyalty-points-are-an-append-only-ledger.id.md)

# ADR-0026 — Loyalty points are an append-only ledger with a projected balance

- **Status:** Accepted
- **Date:** 3 October 2026
- **Decision maker:** ahliweb
- **Related:** [ADR-0003](0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md) (money stays exact — the earn rule converts a `numeric(14,2)` spend to integer cents before it does anything else); [ADR-0008](0008-one-commerce-module-carries-the-whole-store-not-three.md) (the feature lives inside `commerce`, no second module); [ADR-0015](0015-commerce-migrations-live-in-the-reserved-9xx-range.md) (migrations `950`–`952`); [ADR-0016](0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) D3 (the customer-facing endpoint is bearer-secured, never a cookie); [ADR-0017](0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md) (`order.paid` is published by every payment path, which is what lets loyalty stay out of all of them); issue [#289](https://github.com/ahliweb/awcms-one/issues/289), part of epic [#281](https://github.com/ahliweb/awcms-one/issues/281)

## Context

Issue #289 asks for a loyalty/rewards capability "inspired by OSPOS rewards, but designed as an auditable points ledger rather than a mutable customer-points field": earn, redeem, expire, adjust and reverse, with an idempotent source identity, a projected balance that can be rebuilt and reconciled, eligibility decided by server-side business facts, and reporting that does not double count. Loyalty points are explicitly **not** gift-card or store-credit value (#288), and money rules from the epic apply: exact arithmetic, no destructive edits, FORCE RLS with tenant-safe references, idempotency on every high-risk write.

The constraint that shaped the design most is parallel work: payment allocations (#285) were being built at the same time and own POS order creation, the order paid transition, checkout pricing and the payment webhook paths. Loyalty therefore has to integrate through what those paths already publish, not by editing them.

## Decision

### D1 — Three tables inside `commerce`, behind a feature flag that defaults to OFF

`awcms_commerce_loyalty_programs` (versioned rules), `awcms_commerce_loyalty_accounts` (one per customer per tenant) and `awcms_commerce_loyalty_ledger` (the facts), in `sql/950`. No second `module.ts` (ADR-0008). Every reference between them is a composite `(tenant_id, id)` foreign key, so a row cannot point at another tenant's program, account or entry even through an application bug; `awcms_commerce_customers` gained the `(tenant_id, id)` unique index that makes that possible (additive — `id` was already unique).

The feature is `features.loyalty`, **default OFF**. The five existing flags default ON because they gated behaviour that already existed; loyalty is new behaviour that accrues points on every paid order and exposes a customer-visible balance, so a tenant must choose it. A tenant that never opens the Features section is unaffected. Every owner route answers `409 FEATURE_DISABLED` when it is off, the storefront route the neutral `404` (the rule in `domain/commerce-features.ts`), and the sidebar entry is hidden.

### D2 — The ledger is the truth; the account row is a projection; there is exactly one writer

Every change to a balance is one append-only row. `awcms_commerce_loyalty_accounts.balance` is `SUM(ledger.points)`, maintained **in the same transaction** as each insert while the account row is held `FOR UPDATE`. `application/loyalty-ledger.ts`'s `appendLedgerEntry` is the only function that inserts a ledger row or touches the projection (`apps/cms/tests/commerce-loyalty-routes.test.ts` fails if any other file under `src/` does).

Concurrency is solved by the row lock rather than by retry: two concurrent redemptions queue on the account, the second reads the first's committed balance and is refused if it would overdraw. The alternatives were an optimistic version check with retry (more code, a visible failure mode under contention, and the retry loop is exactly where an idempotency bug hides) and `SERIALIZABLE` (pushes serialisation failures to every caller). The lock is held for one short transaction touching one account, and no consumer or job holds more than one account lock, so there is no lock-ordering hazard.

Each ledger row carries a per-account `account_seq` (assigned under the lock) and a running `balance_after`. That makes the history ordered without trusting timestamps, makes reconcile able to detect a tampered row (the running balance stops adding up), and makes keyset pagination exact. `created_at` is `clock_timestamp()`, not `now()` — a transaction that waited on the lock would otherwise be stamped with the instant it started waiting.

**The ledger is append-only below the application:** `awcms_app` is `REVOKE`d `UPDATE` and `DELETE`, and a trigger rejects every `UPDATE` for any role. Corrections are compensating rows. Points are integers (`bigint`, bounded to ±10¹² by a CHECK, comfortably inside JavaScript's safe-integer range, asserted on every decode) — never floats, never money.

### D3 — Earn rules are versioned, effective-dated and exact

A program row is one rule *version*: `earn_points_per_unit` points for every whole `earn_unit_amount` of eligible spend, an optional minimum order, an optional per-order cap, an optional expiry in days. **Rounding is FLOOR and is recorded on the row** (`earn_rounding = 'floor'`), so the rule is self-describing and a second mode is an explicit change. Eligible spend is the order's `subtotal - discount` (merchandise net of voucher), floored at zero — shipping, insurance and tax are never rewarded — and the arithmetic is bigint integer cents via the module's existing `toCents`, so `0.9 / 0.3` is exactly 3 (a float gives 3.0000000000000004).

An earn resolves the version effective at the order's **`paid_at`** and stamps its id on the ledger row; an order paid under version 1 earns under version 1 even if its event is processed after version 2 went live. A version is immutable once active, because a ledger row says "earned under version N" and editing N would falsify it; a change of rules is a new version. Activation is immediate (`effective_from` = now) and closes the version open at that instant in the same transaction. "At most one version open at a time" is enforced by that transaction under a per-tenant advisory lock rather than by a `btree_gist` exclusion constraint, which would add an extension dependency this schema does not otherwise have; a concurrent-activation test pins the property.

Optional tiers (separate from the existing `customer.level` price levels) were in the issue's scope and are deferred — see Deferred.

### D4 — Idempotency is a database fact, not a handler habit

Every ledger row has a per-tenant unique `idempotency_key`: `earn:order:<orderId>`, `reversal:order:<orderId>`, `expire:<lotEntryId>`, `redeem:<accountId>:<clientKey>`, `adjust:<accountId>:<clientKey>`. A replayed event, a re-run job or a client retry cannot write a second row. Two partial unique indexes make the structural cases impossible independently of the key — one `reversal` per original entry, one `expire` marker per earn lot. Redeem and adjust additionally use the shared `awcms_idempotency_keys` store (a stored response is replayed; the same key with a different body is `409 IDEMPOTENCY_CONFLICT`), and the account id is part of the ledger key so one client key cannot collide across customers. A refused (insufficient) redemption is deliberately not recorded, so the same key can succeed after a top-up.

### D5 — Earn and reversal are driven by domain events; loyalty edits none of the order or payment code

`commerce.order_paid_loyalty_earner` consumes `order.paid` and `commerce.order_cancelled_loyalty_reverser` consumes `order.cancelled`, registered in `domain-event-runtime/infrastructure/consumer-registry.ts` beside the entitlement grantor (the same documented `domain_event_runtime -> commerce` exception). Every paid path — storefront, POS, gateway webhook, reconcile — already publishes `order.paid`, so none of `order-directory.ts`, `pos-directory.ts`, pricing or the payment webhook files changed. The consumer reads the order row, never the event payload (which carries no money), and tolerates an order that has since moved on (and an earn key that already belongs to another account or amount — the order's customer was reassigned after the earn — which can never succeed on retry: the earn is recorded as `skipped_conflict` with a warning audit event `commerce.loyalty.earn_skipped_conflict`, and the consumer resolves so the event is marked handled rather than dead-lettered): a cancelled order, the walk-in sentinel customer (a shared placeholder row, not a person), a blocked customer, a disabled feature or a missing/not-yet-effective program all skip silently. Skipping because the feature is off is **not retroactive**: turning loyalty on later does not back-fill earlier orders.

The dispatcher runs as `awcms_worker` when a deployment configures it, so `sql/951` grants the worker exactly what the consumers and jobs need (programs `SELECT, DELETE`; accounts `SELECT, INSERT, UPDATE, DELETE`; ledger `SELECT, INSERT, DELETE`, never `UPDATE`) and one new grant, `SELECT` on `awcms_module_settings`, because the earn consumer reads `features.loyalty`. The integration suite runs the earn and the expiry as the real `awcms_worker` role to prove it.

### D6 — Expiry is per earn lot; reversal may take a balance negative

The ledger cannot carry a decrementing "remaining" column, so how much of an earn is still unspent is **derived**: `domain/loyalty-lots.ts` replays an account's entries in `account_seq` order and allocates each debit against the positive entries ("lots") earliest-expiry-first (lots that never expire last), skipping a lot that had already expired at the debit's own instant. It is pure, deterministic and stores nothing that could drift; a property test generates 200 random ledgers and checks `balance = Σ remaining − deficit`.

`commerce:loyalty:expire` (hourly) appends one `expire` row per due lot for the points still on it. A lot already fully spent gets a **zero-point marker** (the sign CHECK allows `expire <= 0`) so the scan terminates instead of re-finding it forever; the unique `expire` index makes a second marker impossible. Correctness does not depend on the cadence: a redemption, adjustment or reversal first expires the account's due lots itself, under the same lock, so lapsed points can never be spent.

**Reversal** (order cancelled) is a compensating row, never a delete. It takes back the lot's original points **minus whatever already lapsed** (those are gone; taking them again would deduct twice), and it includes points the customer already **spent**, so the balance can go **negative** — the alternative, capping at zero, means a customer can earn, spend and cancel for free. A negative balance blocks redemption until later earns cover it. A *manual* negative adjustment may not take a balance below zero; only a system reversal may.

### D7 — Reconcile is read-only by default, repairs only the projection, and reports what it cannot fix

`commerce:loyalty:reconcile` (daily) recomputes every account from the ledger and reports (a) projection drift — `balance`/`version` disagree with the ledger — and (b) ledger breaks — a row whose running `balance_after` is not the running sum. It exits non-zero on either, so the scheduler surfaces it. It never writes. Repair is `POST /api/v1/commerce/loyalty/reconcile {"repair": true}` under `commerce.loyalty.manage`, locks each drifted account, recomputes under the lock, rewrites **only** `balance`/`version`, and audits each one. Repair only ever rebuilds a **complete** history: an account whose surviving ledger does not start at `account_seq = 1` (or has gaps, or is empty while the balance is not) — the retention purge aged its early rows out — is reported as `unrepairable_history_purged` (the report's `unrepairable` list, a subset of `drifted`) and left untouched, because `SUM(ledger)` is then not its balance and rewriting it would zero real points. A ledger break is reported and never repaired: an append-only table that disagrees with itself needs a human, not a script. The scan is whole-tenant (bounded to 1,000 findings per run); a per-tenant full ledger scan once a day is acceptable at this scale, and a keyset-chunked scan is the first thing to change if a tenant outgrows it.

### D8 — Four permissions on three activity codes, not `loyalty.adjust` / `loyalty.redeem`

`commerce.loyalty.read`, `commerce.loyalty.manage` (an existing high-risk action: it changes what every future order earns), `commerce.loyalty_adjustments.create` and `commerce.loyalty_redemptions.create`. The issue sketched `commerce.loyalty.adjust|redeem`, but `AccessAction` lives in upstream-owned `identity-access/domain/access-control.ts` and has no such members; adding them would put a new divergence in a subtree file for every future sync (the `"send"` precedent exists and is already a listed conflict site). A manual adjustment and a redemption are each the *creation* of a ledger row, so `create` on their own activity codes says the same thing, keeps them separately grantable (a cashier can redeem without being able to adjust) and touches nothing upstream. Adjustments require a reason (also a DB CHECK) and an actor, and are audited.

### D9 — One domain event for every ledger row

`awcms.commerce.loyalty.entry_recorded`, aggregate = the loyalty account, payload `{entryId, accountId, customerId, kind, points, balanceAfter, sourceType}` — no name, phone or free-text reason. One type rather than five because every consumer that wants "the balance changed" wants all five kinds, and one that wants a single kind filters on `kind`. It is registered in `module.ts`, the event-type registry and the AsyncAPI document in the same change.

### D10 — The customer endpoint is bearer-secured, owner-scoped by construction and narrower than the staff view

`GET /api/v1/commerce/storefront/account/loyalty` follows ADR-0016 D3: an opaque bearer session, no cookie, no credentialed CORS. The customer id is read **only** from the verified session — the route accepts no customer, account or ledger identifier at all — and `fetchCustomerLoyaltyOverview` resolves the account *from* that customer and reads the ledger *for that account*. A BOLA test exercises exactly that function for two customers; a structural test fails if the route ever reads an id from the request. The projection drops the staff actor, the free-text reason and the source/program ids. A storefront UI page is not part of this change (Deferred).

### D11 — Reporting is a ledger sum, not a second projection

`GET /api/v1/commerce/loyalty/summary` returns earned / redeemed / expired / adjustments (net) / reversed / net for a window, plus the all-time outstanding points, every figure a `SUM` over the one ledger grouped by `kind`. A point is counted once: an earn is only ever in `earned`; its later expiry or reversal is a different row in a different bucket. `outstanding` is the ledger's sum, not the projection, so it stays right if a projection has drifted. Two disjoint windows sum to the all-time figures (tested). A pre-aggregated projection table through the reporting engine would add a rebuild path and a freshness lag for figures a `(tenant_id, created_at)` index answers directly; revisit it if the ledger grows past what a range scan serves.

### D12 — Retention is explicit, and each cursor only reaches what is already dead

Three `dataLifecycle` descriptors (generic engine; floor five years, default and ceiling ten, `financial_tax` class), chosen so a purge cannot orphan anything: ledger by `created_at` (a `reversal` references its earn with `ON DELETE CASCADE`, so a batch can never split the pair); accounts by `updated_at` (an account idle for the whole window, whose history the ledger purge removes first; the ledger's FK to accounts is RESTRICT, so a pass that races ahead fails harmlessly and succeeds later); programs by `effective_to` (`NULL` for a draft or the open version never satisfies `< cutoff`, so a live rule is unreachable). `BOUNDED_BY_DESIGN` was deliberately **not** used: its own test requires a net shrink for any growth. The honest consequence: an *active* account whose earliest history is purged no longer sums to its projection, and reconcile reports it as `unrepairable_history_purged` and never rewrites it; ten years makes that a deliberate operator choice. All three tables are `retain_under_obligation` in `subjectData` (rows reach a person only through `commerce.customers`, which carries no tenant-user/identity id — ADR-0016 D1).

## Deferred (listed in the issue, deliberately not built here)

- **Redemption into checkout pricing and POS tender.** Redeem records the points debit only. Turning points into a discount needs #285's tender model and a decision on what a point is worth; no `redeem_value` field exists yet, rather than a placeholder number.
- **Optional tiers.** Not built; when they are, they stay separate from `customer.level` price levels unless a mapping is explicitly decided.
- **Return/refund compensation per line (#287).** Reversal today is whole-order, on cancellation — the only compensating order event that exists. There is no refunded order status/event yet.
- **Campaign/segment/promotion eligibility (#280)**, **per-line earn** (the ledger's `source_type`/`source_id` is order-level; a line column is additive), and **future-dated activation** (it would need a scheduler to be honest about when a version started).
- **A storefront UI page** for the balance and history (the endpoint exists; a page touches the toko build-profile matrix and is a separate change), **a draft-edit form** in the admin screen (the `PATCH` exists; the screen creates a new draft), and an **"expiring soon"** view.
- **Scale of the replay.** Expiry and reversal load an account's whole ledger when something is due; the cheap `EXISTS` gate keeps that off the common path, and a periodic per-account checkpoint is the follow-up if a single account ever holds tens of thousands of rows.

## Consequences

- The customer's balance in the storefront can lag the expiry job by up to its interval for an account nobody has touched; any *action* (redeem, adjust, reverse) is exact because it expires first.
- `awcms_worker` gained `SELECT` on `awcms_module_settings` (tenant-RLS, read-only) — a change to the worker matrix in `apps/cms/scripts/security-readiness.ts`, made because the earn consumer must read the feature flag.
- Adding `loyalty` to `CommerceFeatureKey` is a one-line union change that three existing tests had to learn (the default-flags expectation, the label-map count, the permission count).
- The earn consumer imports `loyalty-ledger.ts`, which imports `append-domain-event`, which imports the consumer registry: a file-level import cycle, inert because both sides use each other's exports only inside function bodies. It is stated in the registry's own comment so the next reader does not rediscover it.
