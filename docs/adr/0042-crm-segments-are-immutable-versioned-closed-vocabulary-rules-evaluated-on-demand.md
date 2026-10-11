🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0042-crm-segments-are-immutable-versioned-closed-vocabulary-rules-evaluated-on-demand.id.md)

# ADR-0042 — CRM segments are immutable, versioned rules in a closed vocabulary, evaluated on demand and never stored as members

- **Status:** Accepted
- **Date:** 11 October 2026
- **Decision maker:** ahliweb
- **Related:** [ADR-0040](0040-aw-business-platform-capability-ownership-and-boundaries.md) (the commerce-only carve-out, D7, that allows this to start in Wave B); [ADR-0026](0026-loyalty-points-are-an-append-only-ledger.md) (versioned, effective-dated rules and the ledger that will record a segment version); [ADR-0017](0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md) (the per-tenant feature toggles and the campaign audience this does not replace); [ADR-0003](0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md) (money); [ADR-0016](0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) (customers stay outside the profile vocabulary); [ADR-0037](0037-the-commerce-migration-band-is-allocated-gap-first-and-widened-upstream.md) (migration numbering, `sql/1001`–`sql/1004`); [PRD](../aw-business-platform-prd.md) sections 4.5 and 6.1 (stories S1, S2, S4) and outcome M7; [metrics](../aw-business-platform-metrics.md) section 8.5; [threat model](../aw-business-platform-threat-model.md) flow F8 and controls C-25 to C-29; issue [#360](https://github.com/ahliweb/awcms-one/issues/360) under epic [#280](https://github.com/ahliweb/awcms-one/issues/280).

## Context

A tenant wants to say "customers on price level 2 who spent at least 1,000,000 in the last 90 days and have not ordered for a month", name it, reuse it, and later aim a campaign or a loyalty rule at it. Three things make that more than a saved filter. First, a segment turns a rule into a list of people, so what is at risk is customer data (disclosure, enumeration by differencing) and availability (an expensive rule is a denial of service for every tenant on the database). Second, a segment is _used_ later: a campaign sent to a segment, a loyalty earn restricted to one, must stay explainable after the segment is edited, so what a segment _was_ is evidence. Third, the existing campaign audience (a few levels, an account flag, a last-order date) is hand-written SQL per filter; a vocabulary three times bigger with AND / OR / NOT cannot be hand-written per combination.

The owner answered the open questions (PRD Q7): the v1 vocabulary is the PRD section 6.1 commerce list only; booking-derived rules wait for Wave C. Consent stays independent of membership. Segments never copy customer rows.

## Decision

### D1 — Ownership: commerce-local, behind a per-tenant feature that defaults OFF

Segments live in the `commerce` module (one module, ADR-0008), under the ADR-0040 D7 carve-out for commerce-only work. The `segments` feature in the tenant's `commerce` settings defaults **OFF**: it is a new surface with disclosure and cost risks of its own, so a tenant chooses it, and a tenant that never opens "Features" sees no change (no route answers, no sidebar entry). Every owner route answers `409 FEATURE_DISABLED` while it is off.

### D2 — The rule is a closed, versioned JSON vocabulary mapped to fixed parameterised predicates (C-25)

A rule is a tree: `{ and: [...] }`, `{ or: [...] }`, `{ not: node }` or a leaf `{ field, op, value?, windowDays? }`. The vocabulary is a finite table in `apps/cms/src/modules/commerce/domain/segment-rules.ts`: `level`, `has_account`, `has_email`, `customer_since`, `order_count`, `paid_spend`, `last_order_date`, `first_order_date`, `loyalty_balance` - the PRD 6.1 list, nothing booking-derived. Each field has a fixed operator set and a fixed value type (an integer, a boolean, a `numeric(14,2)` **string**, an ISO instant, or `{ daysAgo }`); there is **no free string anywhere in a rule**, so an injection string has nowhere to live. Validation refuses an unknown field, operator or key, a value of the wrong type, and anything beyond the bounds in D5, with an error that names the path (`rules.and[1].field`). A rule carries no tenant, table or column name and the request bodies take no key outside their allow-list, so a `tenantId` in the body is refused by name. In `apps/cms/src/modules/commerce/application/segment-sql.ts` each (field, operator) pair maps to **one literal SQL template** whose operands are bound parameters; the `switch` is exhaustive over both unions, so a new field is a compile error until it has its template. **Adding a field is ADR-gated.**

The stored form is the canonical rendering (sorted unique levels, two-decimal money, ISO instants), and every stored version is re-validated through the same validator when it is read, so a row written around the application fails closed instead of being evaluated.

|                            | A. Closed JSON vocabulary + fixed templates (chosen)                                                   | B. Expression language (CEL, JSONLogic, a mini-SQL)                                                          | C. Client-supplied SQL predicates behind an allow-list           | D. One column per filter, as the campaign audience does |
| -------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------- |
| **Security**               | Nothing but typed scalars reaches a query; no identifier, operator or expression position is reachable | A parser and an evaluator are a new attack surface; function and regex features are denial-of-service levers | Allow-lists of SQL are the classic bypass; one miss is injection | Safe, but each new filter is new code and new risk      |
| **Performance**            | One fact scan whatever the shape (D3); cost is bounded by the rule bounds                              | Hard to bound; the engine decides the plan                                                                   | Unbounded                                                        | Fast per filter, no AND / OR / NOT                      |
| **Maintainability**        | One table to read; a field is one template and one test                                                | A language to document, version and keep compatible                                                          | An allow-list to audit forever                                   | Combinatorial growth                                    |
| **Scalability**            | Bounded depth and nodes keep the planner's work flat                                                   | Unbounded expression size                                                                                    | n/a                                                              | Does not scale past a handful of filters                |
| **Compatibility**          | Versioned data; old versions stay evaluable                                                            | A grammar change breaks stored rules                                                                         | n/a                                                              | Schema change per filter                                |
| **Operational complexity** | None beyond the gates                                                                                  | A language runtime to patch                                                                                  | High                                                             | Low, until it is not                                    |

### D3 — Membership is derived on demand and never stored (S1, S2)

A segment stores rules, not members. Evaluation reads `awcms_commerce_customers` and three fact relations - the customer account (for `has_account`), the loyalty account (for `loyalty_balance`) and **one grouped scan of the tenant's paid orders** that yields order count, paid spend and first and last paid date for the all-time figure and up to three windowed variants in a single pass (`FILTER` aggregates). A relation the rule does not read is neither joined nor scanned. "Paid order" is a live order with `paid_at` set, status not `cancelled` or `expired`, and paid at or before the as-of; spend is the sum of order totals. `sql/1002` adds one partial covering index on the existing orders table so that scan is index-only.

|                            | A. Derived on demand, one fact scan (chosen)                                                              | B. Materialised membership table, refreshed by events                                | C. Per-customer correlated subqueries                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| **Security / privacy**     | No second copy of customer data exists to leak, erase or retain; erasure and blocking take effect at once | A members table is a customer list that must be erased, exported and kept consistent | Same as A                                                          |
| **Performance**            | Measured on 100,000 customers (below): p95 well under the 3 s target                                      | Fast reads, but write amplification on every order and loyalty event                 | Measured the slowest; 100,000 index probes per fact per evaluation |
| **Scalability**            | Linear in a tenant's paid orders, per evaluation; no background work                                      | Scales reads; refresh lag and backfill grow with data                                | Poor                                                               |
| **Correctness**            | The result is always the current truth at the as-of                                                       | Stale until refreshed; an unlisted event type silently stales it                     | Same as A                                                          |
| **Operational complexity** | None                                                                                                      | A refresh job, a backfill, drift detection                                           | None                                                               |
| **Long-term**              | A cohort snapshot can be added later for a consumer that needs one (D10)                                  | Hard to remove once consumers depend on it                                           | n/a                                                                |

### D4 — Versions are immutable; delete keeps referenced versions (S1, C-29)

`awcms_commerce_segments` is the mutable head (name, description, `latest_version`, `retired_at`); `awcms_commerce_segment_versions` holds one **immutable** row per version. An edit that changes the rules inserts version N+1; version N is never touched - `awcms_app` holds no UPDATE or DELETE on the versions table and a trigger refuses an UPDATE from any role. An edit carries the `baseVersion` it started from and the head is locked `FOR UPDATE`: a stale tab or a double submit is `409 SEGMENT_VERSION_CONFLICT`, never an unreviewed extra version. A rename or description change does not add a version (the name is not part of what a past audience was). **Delete retires** the head and keeps every version, so a campaign or earn that recorded `(segment_id, version)` can still be explained. The tables declare `deleted_at` only as the retention engine's cursor and never set it, so the purge predicate cannot match: the same "practically unreachable" shape as the register and expense tables. Rules hold no personal data, so keeping them retains nothing sensitive.

### D5 — Evaluation is bounded in rule size, time, concurrency and result size (C-26)

- **Rule:** depth 4, 25 nodes, 10 children per group, 3 distinct windows (1 to 3,650 days), 8 KiB of JSON. A very deep hostile tree is refused without being walked to its end.
- **Time:** a 5 s `statement_timeout` set for the evaluation inside a savepoint; a cancelled statement is the stable `422 SEGMENT_TOO_EXPENSIVE`, the savepoint rolls back so the tenant transaction stays usable, and the previous setting is restored.
- **Concurrency:** transaction-scoped advisory try-locks - 2 slots per tenant, 1 per actor; a refused evaluation is `429 SEGMENT_EVALUATION_BUSY` with `Retry-After` and never queues. Locks release with the transaction, so a crash leaks nothing. Previews are also throttled to 30 per actor per minute.
- **Size:** member lists are keyset pages of at most 100 ordered by customer id; the preview sample is 10 and not pageable; an export is capped at 10,000 rows and says `X-Export-Truncated: true` when it cut.

Statement timeout, concurrency and row caps are tuning knobs in `domain/segment.ts`'s `SEGMENT_EVALUATION_LIMITS`; the threat model left their exact values to this ADR.

### D6 — Four separate powers, masked output, small groups withheld (S4, C-27)

Seven permissions, existing `AccessAction` verbs only (the upstream-owned union is not widened): `commerce.segments.{read,create,update,delete}` (define; `delete` is high-risk), `commerce.segment_previews.read` (a count), `commerce.segment_members.read` (list) and `commerce.segment_members.export` (high-risk). A count-only preview needs **no customer permission**. Listing members and exporting each additionally require `commerce.customers.read`, checked through the one access chokepoint. The preview's bounded sample appears only for a caller who holds both member-read and customer-read; otherwise it degrades to count-only rather than failing. A count **below five is withheld**: `{ suppressed: true, count: null, label: "fewer_than_5" }` (metrics section 8.5). Members are returned with name, masked phone, masked e-mail and price level; the CSV carries the same masked fields and is formula-neutralised with the cash-up CSV's helpers. Every member page and every export is audited (actor, version, row count - never who); the export at `warning` severity.

### D7 — Eligibility is the evaluator's, and consent stays independent (C-28)

The evaluator applies eligibility **before** the rule: an erased (soft-deleted) customer, a blocked customer and the POS walk-in placeholder are never members, so `NOT` cannot resurrect them and no consumer has to remember to filter. Membership is never consent: a consumer checks the customer's channel consent at enqueue and again at dispatch, exactly as the campaign dispatcher does today. Nothing in this ADR changes consent handling.

### D8 — The as-of instant is the server's (C-25)

Every time-relative operand (`windowDays`, `{ daysAgo }`) is resolved against an as-of instant taken from the server clock for the request and **returned with the result**. A request has no as-of field and one is refused by name. Orders paid after the as-of are not counted, so the same rule at the same as-of over the same data gives the same count. A consumer that needs a past audience records the as-of it was given; each member page is evaluated at the server's current instant.

### D9 — The seam for consumers (#361, #362)

`resolveSegmentRules(tx, tenantId, segmentId, version)` returns a validated rule tree for any version, retired or not (`null` for an unknown or foreign id, indistinguishably), and `listSegmentMembersPage` / `previewSegment` evaluate it under the bounds above with a caller-supplied `now`. A campaign audience or a loyalty rule stores the segment id and version it used. The existing campaign audience filters are untouched and keep working when no segment is chosen. No consumer is wired in this change.

### D10 — Evidence for M7, and what is deliberately not cached

On a tenant of 100,000 customers with about 250,000 paid orders, 100,000-row account and loyalty relations and five rule shapes up to AND / OR / NOT with three windows (`apps/cms/tests/integration/commerce-segments.integration.test.ts`), 20 previews measured p95 from 0.3 s to 1.2 s across runs (the slowest single preview 1.27 s) against the 3 s target. Counts are **not cached**: the threat model permits a cache only if keyed by tenant and segment version and served only to a caller holding the preview permission, and the measured cost does not justify the invalidation risk. A cohort snapshot (a consumer's recorded audience) is a consumer concern.

### D11 — Audit, no domain events yet

Create, new version, rename, retire, member-list read and export each write an audit row with the actor and the version. No domain event is published: no consumer exists yet, and a forward-declared event with no registration is what the registry gates exist to prevent. A consumer issue adds one with its registration.

## Consequences

- Positive: a vocabulary three times the campaign audience's with AND / OR / NOT and no SQL from a client; no second copy of customer data; a past audience is explainable by `(segment, version)` and the as-of; an expensive rule is refused with a stable code and cannot starve the database; the count-only preview needs no customer permission.
- Cost: seven permissions and a screen to review; a bounded vocabulary means a new field is an ADR and a template; every evaluation scans the tenant's paid orders once (linear in orders, covered by an index); the all-or-nothing small-group rule means a very narrow segment shows no number.
- Compatibility: purely additive. Feature OFF is today's store; existing tables are unchanged apart from one index; existing tenants gain no permission retroactively (global catalog, `ON CONFLICT DO NOTHING`).

## Deferred (not built here, on purpose)

Booking-derived fields (stays completed, last stay date) - after Wave C, through the adapter's own events, each with its ADR (owner answer Q7); wiring a segment into a loyalty program version (#361) and a campaign audience (#362); analytics slices by segment (metrics section 8.5) as a consumer; a cohort snapshot or a result cache; scheduled or event-driven re-evaluation; a visual rule builder for nested groups (the screen offers a flat all / any builder and a JSON box); domain events for segment changes.
