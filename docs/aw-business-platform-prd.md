🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](aw-business-platform-prd.id.md)

# AW Business Platform — platform blueprint and PRD (awcms-one-owned parts)

Definition of Ready (DoR) artifacts 1 (blueprint) and 2 (PRD) of epic [#280](https://github.com/ahliweb/awcms-one/issues/280), at platform level, for [#336](https://github.com/ahliweb/awcms-one/issues/336) (Wave A item A6). Tracker: [`aw-business-platform-dor.md`](aw-business-platform-dor.md). **This is a specification, not an implementation:** it adds no module, migration, OpenAPI path or table definition ([ADR-0040](adr/0040-aw-business-platform-capability-ownership-and-boundaries.md) D7). Names of tables, ports and events below are descriptions of intent, not contracts, until their own issues land.

It does not claim legal compliance. Where a rule touches personal data, payments or labour law, it states a design constraint; whether that satisfies a regulation is for the regulatory-applicability work (A8, [#338](https://github.com/ahliweb/awcms-one/issues/338)) and counsel.

**Related:** [Metric contracts](aw-business-platform-metrics.md) (with the one-screen glossary of terms used in both documents, section 13), [Adapter threat model](aw-business-platform-threat-model.md); [DoR tracker](aw-business-platform-dor.md) (cross-spec review, A9).

**Amended 10 October 2026 ([#355](https://github.com/ahliweb/awcms-one/issues/355)).** The owner answered every open question of section 9 (Q1 to Q10) on 10 October 2026; the answers are applied throughout and recorded in section 9. Cross-spec findings X3 (loyalty earn on deposit orders), X6 (deposit revenue) and X8 (statements made stale by the AWCMS v10.7.0 sync and by upstream ADR-0135) are resolved here and in the metric contracts. Deposits follow [ADR-0041](adr/0041-gateway-deposit-sessions-and-mixed-tenders-on-one-order.md).

## 1. Purpose and placement

The AW Business Platform adds booking, workforce, payroll, notification and analytics capabilities around the commerce store. [ADR-0040](adr/0040-aw-business-platform-capability-ownership-and-boundaries.md) D1 and D4 decided who owns what. This document covers **only the parts that live in this repository**:

| Capability here                                                                                                             | Why it is here (ADR-0040 D4)                                                                    |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **CRM segment definitions** over commerce customers                                                                         | The inputs are commerce facts                                                                   |
| **Loyalty eligibility and redemption** (extending the existing points ledger)                                               | The ledger is commerce-owned ([ADR-0026](adr/0026-loyalty-points-are-an-append-only-ledger.md)) |
| **Booking-commerce adapter**: offering-to-product link, hold-to-order, deposit as a payment allocation, refund coordination | Couples two contexts; commerce is this repository's                                             |
| **POS service context**                                                                                                     | An extension of the existing POS ([ADR-0028](adr/0028-pos-register-sessions-and-cash-up.md))    |

Everything generic is specified and built **upstream** in `ahliweb/awcms` and arrives here by subtree sync; this document consumes those designs and does not restate them:

- Booking engine (resources, schedules, holds, reservations, double-booking prevention): [ADR-0131](https://github.com/ahliweb/awcms/blob/main/docs/adr/0131-generic-booking-module-admission.md) and the design pack [`awcms/booking.md`](https://github.com/ahliweb/awcms/blob/main/docs/awcms/booking.md).
- Workforce, commission and payroll (`hr_workforce`, `hr_commission`, `hr_payroll`): [ADR-0132](https://github.com/ahliweb/awcms/blob/main/docs/adr/0132-hr-payroll-module-family-admission.md) and [`awcms/hr-payroll.md`](https://github.com/ahliweb/awcms/blob/main/docs/awcms/hr-payroll.md).
- Generic delivery (WhatsApp promotion, optional Telegram): [ADR-0133](https://github.com/ahliweb/awcms/blob/main/docs/adr/0133-generic-delivery-capability-whatsapp-promotion.md).
- Cross-domain ports and the event-consumer mechanism: [ADR-0134](https://github.com/ahliweb/awcms/blob/main/docs/adr/0134-descriptor-declared-domain-event-consumers.md) and [`awcms/cross-domain-contracts.md`](https://github.com/ahliweb/awcms/blob/main/docs/awcms/cross-domain-contracts.md).

The upstream Booking and `hr_payroll` packs carry their own PRD-lite sections; this PRD does not duplicate them. The KPI definitions (occupancy, retention, net revenue, loyalty, productivity) are A7's metric contracts in [`aw-business-platform-metrics.md`](aw-business-platform-metrics.md); this PRD states only which outcomes it needs from them. The threat model and privacy analysis for the adapters (A8) is likewise a separate document.

### 1.1 Blueprint in one view (DoR artifact 1)

```
 profile_identity ─────────── (upstream, bottom of the DAG)
        ▲
        │                    Booking (upstream)  ── no dependency on commerce
        │                       │  port: quote / hold / confirm / cancel / reschedule
        │                       │  events: held, confirmed, expired, cancelled, ...
        │                       ▼
 commerce (this repo) ◄── booking-commerce ADAPTER (this repo; the only place that knows both)
   customers  orders  payment ledger  loyalty ledger  returns  POS
        │
        └── CRM segments (read-only evaluation over customers + orders)
        └── loyalty eligibility / redemption (writes only the existing loyalty ledger)
        └── POS service context (a service line in the existing POS sale)
```

Invariants the blueprint inherits and this PRD must not break:

1. **Commerce stays the customer authority** (O12). No `crm_customer` table beside `awcms_commerce_customers` (ADR-0040 D5.1).
2. **Booking holds reservation state; the commerce order holds payment state** (ADR-0040 D3, D5.9). No balance or payment status in Booking.
3. **One ledger per concern.** Payments in the payment allocation ledger ([ADR-0025](adr/0025-payments-are-an-allocation-ledger-separate-from-order-status.md)); points in the loyalty ledger (ADR-0026); post-sale compensation through returns ([ADR-0033](adr/0033-returns-refunds-and-exchanges-are-additive-records-that-compensate-through-the-existing-ledgers.md)). No second analytics store; projections go on the `reporting` engine (ADR-0040 D5.2).
4. **No cycles.** Booking never calls commerce; the adapter depends on Booking's port and events, never the reverse (ADR-0040 D3).
5. **Existing behaviour is preserved.** Guest checkout, existing POS and Midtrans/manual payment keep working; every new behaviour is behind a per-tenant feature flag defaulting off, as `loyalty` and `returns` already are.

## 2. Personas

O1 put all nine in scope. The table says which touch the awcms-one-owned parts; the others are served entirely by upstream modules.

| Persona                      | Role in the awcms-one-owned parts                                                                                                                                       | Touches  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **Customer**                 | Books and pays a deposit on the storefront; earns and redeems points; may see own segment-driven offers; asks for cancellation or a refund                              | Yes      |
| **Cashier**                  | Sells a service line at the POS, takes a deposit or balance, redeems points at the till                                                                                 | Yes      |
| **Scheduler / receptionist** | Creates, confirms, cancels and reschedules reservations; needs to see deposit status of the linked order, without payment authority                                     | Yes      |
| **Tenant admin**             | Turns the feature flags on, defines segments and loyalty rules, sets the cancellation refund policy, grants permissions                                                 | Yes      |
| **Finance / auditor**        | Reads the payment ledger, deposit allocations, refunds and loyalty adjustments; reconciles                                                                              | Yes      |
| Employee, supervisor         | Staff availability and assignment are upstream (Workforce, Booking). Here only as the actor of a sale or booking (commission source events are a later adapter, Wave D) | Indirect |
| HR, payroll operator         | Entirely upstream (`hr_payroll`). No awcms-one-owned surface in this PRD                                                                                                | No       |

A persona's access is a permission set, not a role name: commerce permissions follow the existing `commerce.<resource>.<action>` convention and are granted separately (ADR-0026 D8 is the precedent: a cashier can redeem without being able to adjust). The concrete matrix is DoR artifact 5, not written here.

## 3. First vertical: hotel, villa and rental (O2)

O2 chose hotel / villa / rental, tied to no existing consumer repository. The upstream pack first left this case out of v1 ("nightly (check-in/check-out day) stays are out of v1", booking.md section 11, O2). That is no longer so: on 10 October 2026 upstream admitted day-granularity (nightly) stays into Booking v1 by [ADR-0135](https://github.com/ahliweb/awcms/blob/main/docs/adr/0135-day-granularity-stays-admitted-into-booking-v1.md) (ahliweb/awcms#931; a resource has a `slot` or `stay` booking mode, a stay is a half-open local date interval, and a second declarative exclusion constraint on dates prevents double-booking). It is **upstream's** to model stays and multi-night capacity; this PRD records only what that implies for the adapter, because the adapter is where money meets it:

- **Multi-night stays are one reservation, one order.** The linked order carries one service line for the stay (owner answer Q1: nights are the **quantity of one nightly service product**; the product is the price of one night and the order total is that price times the nights). The adapter must never split a stay into per-night orders.
- **Deposits are a share of a larger total.** A stay of several nights is typically paid in part up front. The commerce order already supports a down payment (ADR-0025 D3: `dp_amount`, status `dp_paid`, explicit outstanding balance), so a deposit is a payment allocation on the linked order, not a new concept (ADR-0040 D5.9).
- **Partial refunds on cancellation are the normal case.** Cancelling inside a cutoff may forfeit a night or the whole deposit; cancelling a multi-night stay early may release some nights. The reservation records the fact (`late_cancellation`, upstream booking.md section 3); **the money decision is commerce's**: the adapter computes a refund amount from a tenant policy and settles it through the returns/refund machinery, a leg per original payment, exact to the cent (ADR-0033 D4, D5).
- **Shortening a stay** is a partial return of a service line, not an edit of a finalised order (ADR-0033 D2: history is never edited).
- **Rental** (vehicles, equipment) shares the same shapes. A **security deposit that is returned, not earned, is out of v1** (owner answer Q3): there is no distinct tender or label, and the only deposit in v1 is the earned part of the price described by ADR-0041 D8, which a refund may return under ADR-0033.
- **Occupancy figures count confirmed stays only** (holds are a separate pipeline figure, O8). The adapter's job is to move a hold to confirmed exactly when the deposit threshold is met, so the figure is driven by payment facts.

No vertical-specific field enters the generic contract (ADR-0040 D5.7): "hotel" is the acceptance scenario for this PRD, not a column or a flag.

## 4. Workflows

Each workflow is a numbered sequence. "Booking" is the upstream engine; "adapter" is the awcms-one-owned piece. All adapter steps are idempotent and tenant-scoped; every cross-domain step carries a correlation id.

### 4.1 Booking with a deposit (storefront)

1. The customer picks a service and dates on the storefront. The adapter asks Booking to **quote** (no row written).
2. The customer proceeds. The adapter asks Booking to **hold** the slot (idempotent on a client key) and, in the same business action, creates a **pending commerce order** with one service line, storing the order id as the reservation's external reference.
3. The adapter computes the **deposit due** from the linked **product's** deposit policy (owner answer Q2: a percentage or a fixed amount, set per product; a product with no policy takes full payment, and there is no tenant default) and records it on the order as the release threshold (down payment, `dp_amount`; ADR-0041 D4). The customer is shown the amount and the hold expiry.
4. The customer pays the deposit through an existing tender (a Midtrans gateway session whose expected amount is the server-computed deposit, ADR-0041 D1 and D2; manual transfer; or QRIS). The leg is recorded in the payment ledger, pending until confirmed.
5. When the ledger shows settlement has reached the deposit threshold (the existing order-paid transition, ADR-0025 D3), the adapter asks Booking to **confirm** the reservation. The order moves to `dp_paid` with the balance outstanding.
6. If the hold **expires** or the order is cancelled/expires first, Booking releases the slot and the adapter cancels the pending order. A deposit that arrives after expiry is recorded (the ledger records externally confirmed money, ADR-0025 D5) and surfaces as an exception for an operator; it never silently confirms a released slot.
7. The balance is paid later (online, or at the POS at check-in), with any tender (ADR-0041 D5). When settlement reaches the total, the order announces **full settlement** (ADR-0041 D6 and D7); that event, not the deposit, is what loyalty earns on (section 4.6). The order's status was already `paid` since the deposit; its payment status reads `dp_paid` until settlement reaches the total.
8. The receipt/invoice for the stay is a numbered snapshot of the **order** through the existing document lifecycle ([ADR-0029](adr/0029-commerce-documents-are-separate-records-and-numbered-documents-are-immutable-order-snapshots.md)); Booking issues no document (ADR-0040 D6).

### 4.2 Cancellation and refund coordination

1. A customer, scheduler or the system (expiry) requests cancellation. Booking cancels the reservation (releases allocations) and emits its event; it knows nothing of money.
2. The adapter receives the event and reads the linked order's settlement (payment ledger, not Booking).
3. The adapter applies the tenant's **cancellation refund policy** to the reservation's facts (time before start, nights, late-cancellation flag) to get a refundable amount, possibly zero, possibly partial.
4. If the amount is above zero, the adapter creates a **return/refund** on the order for the service line through ADR-0033: a leg per original payment (newest first), capped three times, settled automatically for cash/manual/store-credit legs or through the gateway port for gateway legs, or queued for an operator's offline attestation.
5. ADR-0033 D9 compensations run in the same settlement: points earned on the refunded share are reversed in the loyalty ledger (still the single writer) and affiliate commission is adjusted.
6. If the refundable amount is zero or smaller than the deposit, the retained part stays on the order as ordinary settled revenue; the order is not edited. The decision and its policy inputs are recorded on the refund/return record and audited. How a retained deposit and an uncollected balance read in the revenue waterfall is decided in the metric contracts (section 3.7).
   An authorised person may **override** the policy-computed amount only under the rule of A5 (owner answer Q10): a manager or finance permission, step-up re-authentication, a mandatory reason, an audit event, and never an amount above what was paid.
7. A cancellation that cannot be refunded automatically (provider refuses, no adapter) follows ADR-0033's offline path with its separate high-risk permission and mandatory reason; it is never swallowed.

### 4.3 Reschedule

1. Booking reschedules by creating a new reservation and marking the old one rescheduled (upstream). The adapter moves the order's external reference to the new reservation in the same business action.
2. A price difference is an ordinary order adjustment path (new payment or refund leg), never a mutation of paid history. Owner answer Q4: the difference is priced by the **commerce order path** (product price times the new nights); Booking's offering rules do not price it.

### 4.4 POS with service context

1. A cashier opens a service line in the existing POS sale (the register session and cash-up from ADR-0028 are unchanged).
2. The line may reference a **reservation** (arrival, check-in, balance collection) or create a walk-in service sale with no reservation.
3. For a reservation, the POS shows the linked order's outstanding balance and takes the balance through the existing explicit-tenders path (ADR-0025 D8). It writes to the same order and ledger; no second POS.
4. Check-in/check-out actions call Booking's port; the POS does not store reservation state.

### 4.5 Segment definition and use

1. A tenant admin defines a **segment**: a named, saved set of rules over commerce customers (see section 6.1), with a version.
2. The system **evaluates** a segment to a member list or count on demand, read-only, with a stated as-of time; it never copies customer data into a second store.
3. Consumers read the evaluation: a campaign audience (today's campaign audience filters remain valid and are not replaced), a loyalty rule's eligibility, or an analytics cohort.
4. Changing a segment creates a new version; consumers record the version used, so a past campaign or earn can be explained.

### 4.6 Loyalty earn and redeem

1. **Earn** reverses on cancellation or refund (ADR-0026 D5, ADR-0033 D9). **Trigger (owner answer Q5, finding X3, ADR-0041 D7):** a whole-total order earns at `order.paid`, exactly as built. A **deposit order earns only at full settlement**: ADR-0025 D3 makes it `paid` at the deposit and ADR-0026 D5 would earn there, so the earner instead reacts to the settlement event ADR-0041 D7 introduces (settlement has reached the total, emitted once, in the same transaction as the ledger write that makes outstanding zero), under the same earn source key `earn:order:<orderId>`, so an order can never earn twice. A deposit alone never earns. The `paid_at` that picks the program version in force for a deposit order is the full-settlement instant. A refund of a deposit that was never completed finds nothing to reverse. The event's name and payload are a build detail of the issue that lands ADR-0041 D7, not decided here.
2. **Eligibility** (new): a loyalty program version may be restricted to a segment (for example, members only, or customers whose last order is older than N days), and a booking-originated order may earn under a service-specific rule. The version in force at `paid_at` still decides.
3. **Redemption** (new): at checkout or at the POS, the customer or cashier chooses to spend points. The points are debited from the ledger (idempotent key per ADR-0026 D4) and the **value of those points** reduces the amount due as a discount line. Owner answer Q6 fixes the value rules: a per-tenant integer number of rupiah per point with no default (redemption is unavailable until the tenant sets it); whole points only; an optional per-tenant cap on the share of the goods subtotal payable in points (a percentage); shipping and tax are never payable in points. A refused or reversed redemption restores points by a compensating row. Owner answer Q8: points redemption and a deposit order cannot be combined on one order in v1; checkout and POS refuse the combination (ADR-0041 D8).
4. A refund that returns a redeemed discount follows the existing compensations; points are never edited in place.

## 5. Non-goals

From O9 and ADR-0040:

- **No accounting or general ledger.** Commerce records are operational facts, not a chart of accounts.
- **No fiscal documents** (e-Faktur, tax invoices, Coretax numbering). Out of scope for this repository (ADR-0039 D6; upstream follow-up).
- **No payment-service activity.** The platform observes gateway payments and records settlement; it never holds, transmits or disburses customer funds, and a "deposit" is a payment toward the merchant's own order, not stored value held for third parties. A change of that model triggers a dedicated legal assessment.
- **No accounts-receivable invoicing** in Waves B to F (ADR-0040 D6). A receipt or invoice stays an immutable order snapshot with no balance or due date.

Also, by boundary:

- No `crm_customer`, no second customer master, no `profile_identity` harmonisation without its own ADR (O12).
- No generic Booking engine here: resources, schedules, holds and double-booking prevention are upstream. No payment, price or deposit field in Booking.
- No second POS, no second payment or loyalty ledger, no second analytics datastore, no new e-mail/push/WhatsApp queue.
- No automatic segment-driven messaging in this PRD: using a segment as a campaign audience reuses the existing campaign outbox; orchestration across channels is a separate, upstream-gated item (O11).
- No vertical logic (room types, rate plans, seasonal pricing, channel managers) in the template. Those are consumer or later-upstream concerns.
- No employee productivity scoring, commission or payroll logic here (Waves D and E, upstream, with awcms-one source-event adapters later).
- No legal conclusion about UU PDP, PP 71/2019 or payments regulation (A8).

## 6. Requirements and user stories

Priority is from O3: **MUST = CRM + Booking** (segments and loyalty, and the booking-commerce adapter). Workforce, Payroll, Notification and Analytics follow as Should/Could; the Analytics metric contracts that CRM and Booking KPIs need are in scope as they serve the MUST. Stories are written for the awcms-one-owned parts; a story is Ready only when its acceptance criteria are testable without choosing the unresolved items in section 9.

Conventions for all criteria: every write is tenant-scoped under row-level security and audited; every state-changing call is idempotent on a client key (same key and body replays; same key and different body is a conflict); money is exact to the cent; no personal data in events or audit detail beyond ids.

### 6.1 CRM segments (MUST)

A **segment** is a saved, versioned, tenant-owned definition evaluated against commerce customers and their order facts. Rule vocabulary for v1 (all derivable from existing commerce data): customer price level, has an account, order count and paid spend within a window, last order date (before/after), first order date, loyalty balance range, tag-like attributes already on the customer, and and, after Wave C, booking-derived facts (stays completed, last stay date) through the adapter's own events. Owner answer Q7: the v1 vocabulary is the commerce vocabulary listed here, and the booking-derived rules follow once the adapter (Wave C) exists. Combination with AND/OR/NOT to a bounded depth. No free-form query language and no raw SQL from a client.

**S1. Define a segment.** As a tenant admin, I define and name a segment from the rule vocabulary so I can reuse it.

- Given valid rules, saving creates version 1; editing creates version N+1 and never mutates N.
- Unknown fields, operators or depth above the bound are refused with a field-naming error.
- A segment never stores customer rows; deleting a segment keeps versions referenced by past campaigns/earns.

**S2. Preview and evaluate.** As a tenant admin, I preview how many customers match and see a bounded sample so I can check it.

- Evaluation returns a count and a paged member list with an as-of timestamp; the same inputs at the same as-of give the same result.
- A customer blocked or erased is excluded; the walk-in placeholder row is never a member.
- Evaluation is read-only and bounded in time and size; a segment too expensive to evaluate is refused with a clear code, not run unbounded.

**S3. Use a segment.** As a tenant admin, I attach a segment as the audience of a loyalty program version and (reusing the existing campaign flow) of a campaign.

- The consumer stores the segment id and version used.
- A campaign's existing audience filters keep working unchanged when no segment is chosen.

**S4. Privacy of segments.** As a customer, my data is used for segmentation only within the purposes the tenant has configured.

- Segment evaluation exposes no more customer fields than the caller's permission allows; staff without the customer-read permission cannot list members.
- Marketing use respects the customer's existing consent/opt-out for the channel.

### 6.2 Loyalty eligibility and redemption (MUST)

**L1. Eligibility by segment.** As a tenant admin, I restrict a program version to a segment so only those customers earn under it.

- The version effective at `paid_at` and the segment version evaluated at the same instant decide; a member who leaves the segment later keeps points already earned.
- No retroactive back-fill; turning eligibility on does not re-earn old orders (as ADR-0026 D5).

**L2. Earn from booking-originated orders.** As a tenant admin, I let booking-originated orders earn under the normal program.

- Earn keeps the idempotency key `earn:order:<orderId>`; a cancelled or refunded stay reverses proportionally (ADR-0033 D9).
- A hold or an unpaid reservation earns nothing, and a deposit order earns nothing until full settlement (owner answer Q5, section 4.6): the earn is triggered by the settlement event, once, and a deposit paid with the balance outstanding earns zero points.
- A whole-total order earns at `order.paid`, unchanged.

**L3. Redeem at checkout and POS.** As a customer or cashier, I spend points against an order.

- Redemption debits the ledger under `redeem:<accountId>:<clientKey>` and records the discount on the order; both happen in one transaction or neither.
- A balance below the amount requested refuses the whole redemption (no partial), and a refused redemption is not recorded so the same key can retry after a top-up.
- Two concurrent redemptions on one account serialise; the second sees the first's balance.
- A cancelled or refunded order restores the redeemed points by a compensating row and never edits history.
- The discount is computed from whole points at the tenant's rupiah-per-point rate, never exceeds the tenant cap on the goods subtotal when one is set, and never covers shipping or tax.
- An order whose `dp_amount` is below its total refuses redemption, and a deposit order is refused when it already carries redemption, each with a stable `409` code (ADR-0041 D8).
- A customer sees only their own balance and history through the bearer-secured endpoint (ADR-0026 D10, ADR-0016 D3).

**L4. Point value is explicit.** As a tenant admin, I set what a point is worth (owner answer Q6): a per-tenant integer number of rupiah per point and, optionally, a cap as a percentage of the goods subtotal. Until the rate is set, redemption is unavailable. No placeholder value ships, and there is no default.

### 6.3 Booking-commerce adapter (MUST)

**A1. Link an offering to a product.** As a tenant admin, I link a Booking offering to a commerce service product so that selling the product creates a reservation.

- The link is a reference, not a merge: the Booking resource is neither an inventory item nor a commerce product (ADR-0040 D5.8).
- A multi-night stay is one nightly service product sold at a quantity equal to the nights (owner answer Q1).
- One offering may be linked to at most one active product per tenant; unlinking does not touch past orders.

**A2. Hold becomes a pending order.** As a customer, when I proceed, my slot is held and an order is created for it.

- Hold and order creation are idempotent on one client key: a retry returns the same reservation and order and creates neither twice.
- If the order cannot be created the hold is released; if the hold fails no order is left behind.
- The hold's expiry is shown to the customer; the order's own expiry never outlives the hold.

**A3. Deposit as a payment allocation.** As a customer, paying the deposit confirms my reservation.

- The deposit is recorded as an allocation on the linked order through the existing payment ledger and its idempotency (gateway reference or source key); it is not stored in Booking.
- The deposit due comes from the linked product's deposit policy (a percentage or a fixed amount, owner answer Q2); a product with no policy takes full payment and the order is an ordinary whole-total order. A gateway deposit session carries the server-computed expected amount (ADR-0041 D1).
- The reservation is confirmed when, and only when, settlement reaches the deposit threshold (the order's release threshold).
- A deposit confirmation replayed by the gateway confirms once.
- A deposit arriving after the hold expired is recorded and flagged for an operator; the slot is not re-claimed automatically.
- An overpaid deposit surfaces as `overpaid` per ADR-0025 D5 rather than being dropped.

**A4. Balance and completion.** As a cashier or customer, I pay the balance before or at check-in.

- Balance payments use the existing tenders and the explicit-tenders POS path; settlement reaching the total makes the order `paid`.
- The adapter exposes the outstanding amount to the scheduler read-only.

**A5. Cancellation refund coordination.** As a tenant admin, I define a cancellation refund policy; as a scheduler or customer, cancelling applies it.

- The policy is configured per product, with a tenant-wide default that applies to a product with no policy of its own (owner answer Q9): a list of time-before-start windows to refundable share (percentage, whole-stay or per-night), versioned; the policy version used is recorded on the refund.
- The refund goes through ADR-0033 (leg per original payment, capped three times, cent-exact); a stay refunded in parts adds up to the total exactly regardless of how it was split.
- The reservation is cancelled whether or not money is refunded; a failed refund leg never leaves the slot held.
- A zero refund creates no refund legs and records why.
- Replaying the cancellation never refunds twice (the refund leg id is the provider idempotency key).
- A refund override (an amount different from the policy-computed one) needs a manager or finance permission held separately from the ordinary cancel permission, step-up re-authentication, a mandatory reason and an audit event, and can never exceed the amount paid (owner answer Q10).

**A6. Reschedule keeps money coherent.** As a scheduler, I move a stay.

- The order's reservation reference moves to the new reservation atomically; the old reservation is never left linked.
- No paid order, line or allocation is edited; a difference is a new payment or refund, priced by the commerce order path (owner answer Q4).

**A7. No-show.** As a scheduler, I mark a no-show; the adapter applies the policy's no-show retention (typically the deposit is retained) without refunding, recorded and audited.

**A8. Booking events consumed by registration, not by import.** The adapter consumes Booking events through the upstream descriptor-declared consumer mechanism (ADR-0134 in `awcms`), not by importing from the upstream module. Replays of an event are harmless (each effect is applied once).

**A9. Degradation.** When Booking is not enabled for a tenant, commerce behaves exactly as today; when commerce is not enabled, Booking works without the adapter. The adapter exists only where both are on.

### 6.4 POS service context (MUST for the hotel scenario; otherwise SHOULD)

**P1. Service line with or without reservation.** As a cashier, I sell a service at the counter, optionally tied to a reservation.

- The sale goes through the existing POS order creation, register session and payments; there is no parallel POS.
- A service line carries no stock movement.

**P2. Reservation lookup at the till.** As a cashier, I find a reservation by its code (and customer) and see status, dates and the order's outstanding balance, so I can take the balance.

- Lookup exposes only what the cashier's permission allows; customer contact details are masked unless the permission is held.

**P3. Check-in and check-out from the till** call Booking's port and are permissioned separately from taking payment.

### 6.5 Analytics inputs for the MUST items (in scope, defined in A7)

Needed from the metric contracts, not defined here: revenue reported gross, discounts, refunds, net (net headline, Asia/Jakarta day windows, O8); occupancy (holds excluded, held separately as a pipeline figure); utilization (separate); retention (repeat purchase or booking within 90 days of the first, O8). The loyalty figures (points issued, redeemed, outstanding liability, breakage, redemption rate) and the deposit-order revenue rule (section 3.7) are defined there too. This PRD requires that each is a projection on the existing `reporting` engine, rebuildable from the facts above, with no second store, and that the booking-originated share of revenue and deposit-vs-balance split are visible dimensions.

## 7. Measurable outcomes

Targets are acceptance thresholds for the first release of each item, to be confirmed by the owner at DoR review (they are proposals, marked P). Measurement definitions are A7's.

| #   | Outcome                                               | Measure                                                                                                                                                                 | Target (P)              |
| --- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| M1  | No oversold slot via the commerce path                | Reservations confirmed for a unit already allocated (concurrent final-slot test)                                                                                        | 0                       |
| M2  | Deposit and order always agree                        | Confirmed reservations whose order settlement is below the deposit threshold                                                                                            | 0 (daily reconcile)     |
| M3  | Money moves exactly once                              | Duplicate payment, refund or redemption rows from replayed requests/events                                                                                              | 0                       |
| M4  | Refunds are exact                                     | Difference between sum of refund legs and policy amount, over any split                                                                                                 | 0.00                    |
| M5  | A stay can be reconciled end to end                   | Orphan holds (no order) or orphan service orders (no reservation) after 24 h                                                                                            | 0 reported by reconcile |
| M6  | Loyalty ledger integrity is kept                      | Ledger breaks / projection drift found by the existing reconcile                                                                                                        | 0                       |
| M7  | Segment evaluation is usable interactively            | p95 preview time for a segment on a tenant of 100,000 customers                                                                                                         | at most 3 s             |
| M8  | Booking path adds little to checkout                  | p95 added latency of hold-plus-order creation over the plain order path                                                                                                 | at most 500 ms          |
| M9  | Existing behaviour is untouched when features are off | Regression suite for guest checkout, POS, payments, loyalty earn                                                                                                        | 100% green              |
| M10 | Business value signals (reported, not gated)          | Repeat booking/purchase within 90 days of first; share of revenue from bookings; points redeemed as a share of earned (the loyalty redemption rate, metrics section 12) | reported                |

## 8. MoSCoW (O3)

| Item                                                                                 | Priority                    | Notes                                                                                  |
| ------------------------------------------------------------------------------------ | --------------------------- | -------------------------------------------------------------------------------------- |
| Segment definition, versioning, preview/evaluation (S1, S2)                          | **Must**                    | CRM                                                                                    |
| Segment as loyalty eligibility and campaign audience (S3, L1)                        | **Must**                    | CRM                                                                                    |
| Loyalty redemption into checkout and POS (L3, L4)                                    | **Must**                    | Closes ADR-0026's Deferred item; Q6 answered (rate set per tenant, none by default)    |
| Loyalty earn from booking orders, with reversal (L2)                                 | **Must**                    | Reuses the existing consumers                                                          |
| Adapter: link, hold-to-order, deposit allocation, confirm, expire (A1 to A4, A8, A9) | **Must**                    | Booking + commerce                                                                     |
| Adapter: cancellation refund policy and coordination, reschedule, no-show (A5 to A7) | **Must**                    | Partial refunds are the normal hotel case                                              |
| POS service context (P1 to P3)                                                       | **Should**                  | Must for the hotel scenario's balance-at-check-in only; counter use can follow         |
| Analytics inputs for CRM and Booking KPIs (section 6.5)                              | **Must**                    | Serves the MUST items; contracts in A7                                                 |
| Customer-facing segment-driven personalisation on the storefront                     | **Could**                   |                                                                                        |
| Loyalty tiers                                                                        | **Could**                   | Stay separate from customer price levels (ADR-0026)                                    |
| Receipt per payment / credit notes for deposits                                      | **Could**                   | ADR-0029 Deferred; likelier with deposits (ADR-0040 D6)                                |
| Booking-derived segment rules beyond completed stays and last stay                   | **Could**                   | The rules themselves follow Wave C (owner answer Q7)                                   |
| Commission and payroll source-event adapters                                         | **Should** (Waves D, E)     | Follow workforce/payroll upstream                                                      |
| Notification: reminders, Telegram, orchestration                                     | **Should / Could** (Wave F) | O10 yes (optional, off by default); O11 yes but needs a value case and an upstream ADR |
| AR invoicing, accounting, fiscal documents, payment-service activity                 | **Won't**                   | O9                                                                                     |

## 9. Owner answers to the open questions

**All ten questions were answered by the owner on 10 October 2026** (issue [#355](https://github.com/ahliweb/awcms-one/issues/355)). None is open. The earlier statement that Q1, Q5 and Q6 blocked specific stories is retired: the pricing and deposit questions are settled by owner answers Q1 to Q3, and Q5 and Q6 unblock the earn and redemption stories (L2, L3, L4), so every story of section 6 is now testable without choosing an unresolved item. Building still waits on the dependencies of section 10 and on the gate tracker.

| #   | Question                                                    | Owner answer (10 October 2026)                                                                                                                                                                                                                                        | Applied in             |
| --- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Q1  | How is a multi-night stay priced on the order?              | **Nights are the quantity of one nightly service product.** One order, one line; no computed-total line.                                                                                                                                                              | Section 3, A1          |
| Q2  | Deposit policy shape, and where it lives                    | **Per product**, either a percentage or a fixed amount. A product with no policy takes full payment. There is no tenant default.                                                                                                                                      | 4.1, A3; ADR-0041 D4   |
| Q3  | Rental security deposit                                     | **Out of v1.** No distinct tender or label; the tender CHECK is not widened.                                                                                                                                                                                          | Section 3; ADR-0041 D8 |
| Q4  | Who prices a reschedule difference                          | **The commerce order path.** Booking's offering rules do not price it.                                                                                                                                                                                                | 4.3, A6                |
| Q5  | Should points earn at the deposit                           | **No. Earn only at full settlement** on a deposit order; a whole-total order earns at `order.paid`, unchanged.                                                                                                                                                        | 4.6, L2; ADR-0041 D7   |
| Q6  | What a point is worth                                       | **A per-tenant integer number of rupiah per point, with no default** (redemption is unavailable until it is set). Whole points only. An optional per-tenant cap as a percentage of the goods subtotal. Shipping and tax are never payable in points.                  | 4.6, L3, L4            |
| Q7  | Segment rule vocabulary                                     | **The v1 vocabulary of section 6.1 is the commerce vocabulary**; booking-derived rules follow after Wave C.                                                                                                                                                           | 6.1, section 8         |
| Q8  | Points and a refundable deposit on one order                | **Refused in v1.** Checkout and POS refuse the combination in both directions (ADR-0041 D8), so no refund-ordering rule is needed.                                                                                                                                    | 4.6, L3                |
| Q9  | Cancellation windows: tenant default or per product         | **Per product, with a tenant-wide default** for a product with no policy of its own.                                                                                                                                                                                  | A5                     |
| Q10 | Minimum permissions, and who may override a computed refund | **Only a manager or finance permission, with step-up re-authentication, a mandatory reason and an audit event; never above the amount paid.** The remaining persona permission sets are DoR artifact 5 (W6, [#357](https://github.com/ahliweb/awcms-one/issues/357)). | 4.2, A5                |

## 10. Dependencies and sequencing

- The descriptor-declared consumer mechanism ([ADR-0134](https://github.com/ahliweb/awcms/blob/main/docs/adr/0134-descriptor-declared-domain-event-consumers.md), `ModuleDescriptor.domainEventConsumers`) **is already in this repository's `apps/cms`** since the AWCMS v10.7.0 sync, and the commerce consumers use it. The upstream `booking` module, including its day-granularity stays ([ADR-0135](https://github.com/ahliweb/awcms/blob/main/docs/adr/0135-day-granularity-stays-admitted-into-booking-v1.md)), is **not yet in `apps/cms`**; it must arrive by subtree sync before the adapter is built (ADR-0040 D7 item 2). The deposit session and settlement-event changes of ADR-0041 are commerce work and must also land first.
- Segment definitions and loyalty eligibility/redemption depend only on commerce and, per ADR-0040 D7, may be opened first once the CRM DoR artifacts (blueprint, this PRD, threat model, metric definitions) exist.
- The adapter depends on payments (built), returns (built) and loyalty (built); it adds no schema to Booking and a small set of commerce-side records, to be designed in DoR artifact 4.

## 11. Decision provenance

Every owner decision this PRD relies on, as answered on 10 October 2026:

| ID  | Decision                                                                                                                              | Where used                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| O1  | All nine personas in scope                                                                                                            | Section 2                          |
| O2  | First vertical: hotel / villa / rental; no existing consumer repository                                                               | Section 3, workflows, A5           |
| O3  | MUST = CRM + Booking; Workforce, Payroll, Notification, Analytics follow; Analytics contracts that serve CRM and Booking are in scope | Section 8, 6.5                     |
| O5  | Platform is processor for tenant business data and controller for the operator's own account/billing data                             | Segment privacy (S4); detail in A8 |
| O8  | Occupancy excludes holds; retention window 90 days; revenue gross to net with net as headline; Asia/Jakarta day windows               | Sections 3, 6.5, 7                 |
| O9  | Non-goals: no accounting, no fiscal documents, no payment-service activity, no AR invoicing in Waves B to F                           | Section 5                          |
| O10 | Telegram admitted as an optional, off-by-default adapter                                                                              | Section 8 (Wave F)                 |
| O11 | Notification orchestration wanted, subject to a value case and upstream ADR                                                           | Section 8 (Wave F)                 |
| O12 | Commerce stays the customer authority                                                                                                 | Section 1.1, 5                     |

Not relied on here: O4, O6 and O7 (payroll profile, attendance evidence and payroll separation of duties) concern upstream `hr_payroll` only.

Owner answers Q1 to Q10 to the questions of section 9 were given on 10 October 2026 and are recorded in that section.

Existing decisions built on: [ADR-0041](adr/0041-gateway-deposit-sessions-and-mixed-tenders-on-one-order.md), [ADR-0016](adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) (customer sessions), [ADR-0025](adr/0025-payments-are-an-allocation-ledger-separate-from-order-status.md), [ADR-0026](adr/0026-loyalty-points-are-an-append-only-ledger.md), [ADR-0028](adr/0028-pos-register-sessions-and-cash-up.md), [ADR-0029](adr/0029-commerce-documents-are-separate-records-and-numbered-documents-are-immutable-order-snapshots.md), [ADR-0033](adr/0033-returns-refunds-and-exchanges-are-additive-records-that-compensate-through-the-existing-ledgers.md), [ADR-0040](adr/0040-aw-business-platform-capability-ownership-and-boundaries.md). Current commerce state: [`status.md`](status.md).
