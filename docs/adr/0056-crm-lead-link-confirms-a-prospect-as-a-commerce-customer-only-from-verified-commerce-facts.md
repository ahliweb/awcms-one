🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0056-crm-lead-link-confirms-a-prospect-as-a-commerce-customer-only-from-verified-commerce-facts.id.md)

# ADR-0056 — The CRM lead link confirms a prospect as a commerce customer only from verified commerce facts

- **Status:** Proposed
- **Date:** 14 November 2026
- **Decision maker:** proposed in the implementing pull request for ahliweb's review, within the constraints already fixed by [ADR-0040](0040-aw-business-platform-capability-ownership-and-boundaries.md) D4 and the template-only rule of [ADR-0024](0024-awcms-one-is-template-only-derived-apps-own-their-backend.md); it becomes Accepted when the pull request is merged
- **Related:** issue [#463](https://github.com/ahliweb/awcms-one/issues/463) (this ADR and its implementation), CRM requirements standard issue [#462](https://github.com/ahliweb/awcms-one/issues/462); upstream `ahliweb/awcms` ADR-0153 (the `crm_leads` pipeline, section 6 the port), ADR-0011 (the port contract) and the `crm_leads` module README (`apps/cms/src/modules/crm-leads/README.md`); [ADR-0016](0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) (a verified registration is an OTP-verified account); [ADR-0046](0046-commission-attribution-adapter-reports-paid-counter-sales-to-the-hr-commission-ledger.md) and [ADR-0045](0045-booking-commerce-adapter.md) (the adapter shape this follows: optional capability, one composition root, consumers that cannot reach the other module's tables); [ADR-0055](0055-commerce-customers-have-a-commerce-owned-subject-rights-flow-keyed-by-customer-id.md) (the shopper's export and erasure, whose registry lists the new table); [ADR-0037](0037-the-commerce-migration-band-is-allocated-gap-first-and-widened-upstream.md) (migrations `1068` and `1069`)

## Context

Upstream's `crm_leads` module keeps a pre-customer pipeline of prospects. It owns the lead and nothing else: it never owns the customer, only an opaque `external_customer_ref` written by a conversion, and it states plainly that confirming the conversion is **the customer authority's duty** (`CrmLeadPort`, `apps/cms/src/modules/_shared/ports/crm-lead-port.ts`: `readLeadState`, `confirmConversion`, `reverseConversion`). In this repository the customer authority is `commerce` (`awcms_commerce_customers`).

Issue #463 asks for the adapter: link a prospect to a commerce customer **by authorization and explicit verified evidence**, publish source-attributed customer facts, support an anonymous lead that later becomes a customer and a cancelled or refunded conversion's correction, and do all of it without fuzzy matching, without a second customer master and without inventing a conversion from a message receipt.

Four facts of the platform shape the whole decision:

1. **The port performs no access check and writes no audit row.** The composition root must authorize `crm_leads.conversions.approve` itself (`authorizeInTransaction`) and audit the business action.
2. **`awcms_worker` holds no privilege at all on any `awcms_crm_*` table** (upstream `sql/342`: "no job reads or writes this module"). The port's functions run in the caller's transaction with the caller's privileges, so a domain-event consumer, which runs in `domain-events:dispatch` as `awcms_worker`, **cannot call** `confirmConversion` or `reverseConversion`. Granting the worker rights on the CRM tables from a commerce migration would be the back door upstream closed on purpose, and the module README records that even a re-key job there is "a reviewed change of its own".
3. **An evidence reference is globally unique per tenant inside `crm_leads`** (`evidence_ref` unique, replay on the same key), which makes it the natural idempotency key on both sides.
4. **`crm_leads` is optional.** A tenant that never switches it on must still run `commerce`, and the migration that adds commerce's table must not depend on a CRM table.

The adapter must also be a **reusable template capability** (ADR-0024): neutral names, no consumer's program, cohort or registration schema. A derived product may define its own program and registration-specific events itself; this template owns only the neutral customer-conversion mapping.

## Decision

### D1 — A person confirms, on evidence the server reads; no consumer converts anything

A conversion is confirmed by `POST /api/v1/commerce/crm-lead-links`, called by a person who holds **both** `commerce.crm_lead_links.create` and `crm_leads.conversions.approve` (D6). The body names the lead, the customer, the evidence kind and the lead version the person saw. **No domain-event consumer, job or message handler confirms a conversion.** This follows from fact 2 (a consumer could not) and from the issue's rule that no conversion is invented from a message receipt: the commerce facts below are _necessary evidence the server checks_, not a trigger. The decision of which prospect is which customer stays a person's, audited at `warning`.

### D2 — Reached through the port only, from one composition root

`commerce` declares `capabilities.consumes: [{ capability: "crm_lead", providedBy: "crm_leads", optional: true }]` and **not** a lifecycle dependency (the same reasoning as ADR-0046 D5). The concrete adapter is named in exactly one file, `apps/cms/src/lib/composition/crm-lead-port.ts` (the shape of the booking port's root: it lives in `src/lib/`, outside both module directories, and loads the adapter lazily), imported only by the two link routes. Everything else depends on the port _type_. `apps/cms/tests/commerce-crm-lead-boundary.test.ts` fails if a commerce file names an `awcms_crm_*` table or imports `crm-leads/` code, if anything else imports the composition root, or if a commerce migration references or grants on a CRM table. No upstream-owned file is edited for behaviour; the only rows added to shared registries are the usual ones (event registry, AsyncAPI, worker-grant pins, the screen ledger, the OpenAPI document), so the divergence list in the root `AGENTS.md` does not grow.

### D3 — Verified evidence, and no fuzzy matching

The evidence is read from the database in the same transaction; no field of the request states it.

| Kind                    | Verified when                                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customer_registration` | the customer has an account that is `active`, not soft-deleted, with `email_verified_at` set (the shopper proved the address by OTP, ADR-0016), and the customer is not erased (`erased_at`)                                          |
| `paid_order`            | `orderId` is an order **of that customer** with `payment_status = 'paid'`, a status past payment (`paid`, `processing`, `shipped`, `completed`), not cancelled or expired, not soft-deleted (a deposit-only `dp_paid` does not count) |

A guest customer row made by a checkout, a customer that merely shares a phone number or e-mail with the lead, an unpaid, deposit-only, refunded or cancelled order, another customer's order, and an erased customer are all refused with `409 CRM_EVIDENCE_NOT_VERIFIED` and a closed `details.reason`. The lead stays open and nothing is written.

**There is no matching on phone, e-mail, social handle or name, anywhere in this code.** The request accepts ids only (unknown fields are a `400`), the SQL compares ids, and a static test fails on a `LIKE`, a similarity function or a comparison of a contact column. A tenant that wants candidates for review uses `crm_leads`' own exact-hash candidate list, which is a person's tool, never a merge. A lead or customer of another tenant is indistinguishable from a missing one (RLS filters both, the port reads under the same tenant setting): `404`.

| Option for "which prospect is this customer"                          | Safety                                                         | Correctness                                        | Verdict    |
| --------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------- | ---------- |
| **A. A person names both ids; the server verifies the commerce fact** | A wrong id is the only error, audited, reversible              | Exact; one verified fact converts at most one lead | **Chosen** |
| B. Auto-link when the lead's contact equals the customer's            | Silent wrong merge across people who share a phone or an inbox | Wrong for shared and recycled numbers              | Rejected   |
| C. A consumer converts on `customer.registered` / `order.paid`        | Cannot run: the worker has no CRM privilege (fact 2)           | Would still need B's matching to find the lead     | Rejected   |

### D4 — The reference vocabulary: opaque, deterministic, one per fact

`externalCustomerRef` is `commerce:customer:<customer id>`. `evidenceRef` (the port's replay key) is `commerce:registration:<customer id>` or `commerce:order:<order id>`; a reversal's is `commerce:reversal:<link id>`. All are inside the port's alphabet (`A-Za-z0-9._:-`, 128 characters) and carry no contact value, name or national id (the port's contract). Because the evidence reference is unique per tenant in both `crm_leads` and `awcms_commerce_crm_lead_links`, **one verified fact converts at most one lead** (a second lead with the same evidence is `409 CRM_EVIDENCE_REUSED`), a replay of the same request is a no-op (`200` with the existing link, `replayed: true`, nothing published), and a reversed conversion cannot be re-asserted with the same fact (a correction needs a different fact, for example a later paid order). A lead has at most one live link (`409 CRM_LEAD_ALREADY_LINKED`; a conversion reversed directly in CRM leaves the link `linked` until a person reverses the link, which reconciles it).

Concurrent confirmations of one lead or one evidence serialise on two transaction-scoped advisory locks taken before the probes, so the probes are authoritative and the link insert cannot lose a unique race after the port has recorded the conversion in the same transaction. The insert deliberately has no unique-violation handler: a failure there rolls the whole request back instead of being mapped to a response that would commit a half-written pair.

### D5 — Reversal on cancel or refund: the worker flags, a person reverses

When the order a `paid_order` conversion rests on is cancelled (`order.cancelled`) or every line of it is fully returned and the return is `completed` (`refund.settled`, summed over all completed returns, the rule the commission reverser uses), a flagger consumer moves the link `linked` to `reversal_pending` and audits it at `warning` (cause `order_cancelled` or `order_refunded`, plus the person who cancelled or refunded, from the delivered event's envelope). A partial return flags nothing: a real sale remains. A registration-based link is flagged by no order event.

The flaggers are `commerce.order_cancelled_crm_lead_link_flagger` and `commerce.refund_settled_crm_lead_link_flagger`, declared in `module.ts` `domainEventConsumers` with the default `runtime_effect_once` idempotency (the handler is the side effect only; it never calls the guard). The worker holds `SELECT` and a **column-only** `UPDATE (state, reversal_cause, reversal_requested_at, reversal_actor_tenant_user_id, updated_at)` on the link table and nothing on any CRM table; a guard trigger and a state CHECK bound the legal moves (`linked -> reversal_pending -> reversed`, or `linked -> reversed`; `reversed` is final; no row is ever deleted).

The reversal itself is `POST /api/v1/commerce/crm-lead-links/{id}/reverse` (`commerce.crm_lead_links.approve`, high-risk, **and** `crm_leads.conversions.approve`): it calls `reverseConversion` through the port (a stamped reversal plus a new transition in `crm_leads`, never an edit of history), then marks the link `reversed`. If CRM reports the conversion already reversed there, the link is reconciled rather than left disagreeing. **This is the honest limit of the acceptance criterion "reversed on cancel/refund":** the reversal is _recorded as required_ automatically and _applied_ by a person, because the only automatic path would need a worker grant on CRM tables that upstream withholds. A scheduled reconciler that applies pending reversals as a system actor needs either such a grant (an upstream decision) or a port that accepts a null actor; it is recorded as a follow-up, not built here.

### D6 — Two permissions are always needed; nothing widens

`commerce.crm_lead_links.{read,create,approve}` (migration `1069`) use existing `AccessAction` verbs only, so the upstream-owned union is not widened. `create` and `approve` are never sufficient alone: the routes call `authorizeInTransaction` for `crm_leads.conversions.approve` through the same chokepoint (ABAC, SoD and the decision log apply; the client address is passed explicitly, upstream `awcms` ADR-0092), and a denial is the chokepoint's own response. Neither implies any `crm_leads.*` key and no `crm_leads.*` key implies either. Existing roles do not gain them retroactively. The screens do not exist yet, so the three keys sit in the admin screen ledger's `NOT_YET_SCREENED` list, which may only shrink.

### D7 — Storage: one commerce-owned table, opaque on the CRM side, RLS FORCE

`awcms_commerce_crm_lead_links` (`sql/1068`): `lead_id` and `conversion_id` are **opaque** (no foreign key, no read, no join: the migration must apply where `crm_leads` is off); `customer_id` and `order_id` are tenant-composite foreign keys; `evidence_kind`, `evidence_ref` (unique per tenant), `lead_first_source_kind` and `lead_first_touch_id` (the lead's first, immutable, source touch, copied from `readLeadState` for attribution), `state`, staff actor stamps as plain uuids (not foreign keys: the record of who decided must outlive the account) and timestamps. **No name, contact, note, stage or reason is stored.** RLS is enabled and forced with one tenant policy, `awcms_app` is revoked `DELETE` and `TRUNCATE` and a trigger refuses delete for every role. The table is registered:

- in `dataLifecycle` as `delegated`, no purge, kept for the life of the tenant (an age-based delete would orphan a CRM conversion that still stands);
- in `subjectData` as `retain_under_obligation`, with the three actor columns as `tenant_user` subject columns;
- in the shopper's registry of ADR-0055 (`domain/customer-subject-data.ts`, section `crmLeadLinks`, key set `customer`), **exported** (the shopper's acquisition record: opaque ids, evidence kind, first source kind, state; staff stamps redacted) and **retained** through an erasure under the recorded basis, resolving to the anonymised customer, because the link is the handle a reversal needs on a CRM conversion that still stands. The prospect's own personal data lives in `crm_leads`, which erases it itself (`/anonymize`) under its own permission. Coordination with #529: the registry's guard test (a new commerce table with a customer column must be listed) and its erasure list agree with this entry, and the wording of the legal basis awaits the same counsel confirmation as ADR-0055 D2.

### D8 — Events: two versioned customer facts, ids only

`awcms.commerce.customer.registered` (version `1.0`, aggregate `commerce.customer`) is appended in the transaction that creates a verified registration (`tryCreateAccountForCustomer`), payload `customerId` and `accountId`. A guest checkout never reaches that function, so it never publishes it: only a verified registration is a registration fact. `awcms.commerce.customer.converted` is appended in the transaction of the link, payload `linkId`, `customerId`, `leadId`, `conversionId`, `evidenceKind`, `orderId`, `firstSourceKind` and `firstTouchId` (source attribution without reading the lead again). Both carry the correlation id of the request, are pseudonymous (opaque ids and codes; never a name, e-mail, phone or note), and are idempotent in the way the table is: one `registered` per account row, one `converted` per link, none for a replay. They are registered in the runtime's event-type registry and the AsyncAPI document (parity gates) and listed in `events.publishes`. The reversal of a conversion is `crm_leads`' own `awcms.crm_leads.lead.conversion_reversed`; commerce adds no third event. Generic training, cohort and re-registration events stay in the derived products that need them.

### D9 — Views refer to a lead by reference; commerce segments and campaigns are not changed

The segment and campaign storage of `commerce` is untouched: no lead column, no copy of a prospect. A view that wants "customers who were prospects, from this source" reads `GET /api/v1/commerce/crm-lead-links?customerId=` (or `?leadId=`, `?state=`), which returns opaque ids and the first source kind, and resolves the lead through `crm_leads` under its own permission. A segment condition over links is a possible later addition with its own ADR; it is not built, so no second prospect storage can appear by accident. Anonymous website leads that later become customers need nothing more: the lead exists first, its first source touch is already attributed, and the link carries that source when a person confirms it.

### D10 — Non-goals, restated from the issue

No new customer master. No fuzzy or automatic merge on phone, e-mail or handle. No conversion invented from a message receipt or an unconfirmed manual conversion (a manual conversion in `crm_leads` stays `authority_unconfirmed` and is reported separately there; commerce neither creates nor links one). No program, cohort or registration schema of any consumer. No Lynx or other front-end work. No new runtime dependency on another repository's deployment, and no provider key. A derived product that wants an admin screen builds it against the three routes.

## Consequences

- A prospect becomes a commerce customer through one audited act with verifiable evidence; a wrong id is the only way to be wrong, and it is reversible.
- Cancelling or fully refunding the evidence order is recorded the moment it happens and is visible as `GET ...?state=reversal_pending`, but a person applies the reversal. Until a scheduled reconciler exists, a pending link overstates conversions in CRM funnels (CRM keeps counting the converted stage until the reversal is applied), and an operator must work the pending list.
- `commerce` gains one table, three permissions, two events, two consumers and three routes, and a boundary test; `crm_leads` and every upstream-owned file are unchanged in behaviour.
- A single registration or order can convert at most one lead, forever. This is deliberate (no double counting) and costs a correction needing a different fact.

## What is not here yet

- **A scheduled reconciler** that applies `reversal_pending` links (needs an upstream grant or a null-actor port; D5).
- **An admin screen** for the links and the pending list (the three permissions are in `NOT_YET_SCREENED`).
- **A segment condition or campaign filter** over links (D9).
- **Reversal triggered by registration facts** (an erased or blocked customer): a registration link is reversed by a person only.
- **The DB-backed integration suite has not been executed** where this was written (no PostgreSQL); `commerce-crm-lead-link.integration.test.ts` runs through local CI and must be run before the ADR is accepted.
- The legal-basis wording for retaining a link through an erasure awaits counsel (ADR-0055 D2).
