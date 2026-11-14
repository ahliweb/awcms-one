🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](crm-kpi-contract.id.md)

# CRM KPI contract — lead funnel, conversion, campaign attribution and staff SLA (v1.0.0-draft, awaiting owner sign-off)

> **Classification:** a **specification and a gate-9 (Definition of Ready) artifact**, **not an implementation**. No projection, migration, endpoint, screen or OpenAPI path exists for anything below, and the response shapes in section 10 are a **documented proposal that is deliberately not in the OpenAPI document**. Implementation truth is [status.md](status.md). Tracker: [#464](https://github.com/ahliweb/awcms-one/issues/464); standard: [`crm-omnichannel-requirements.md`](crm-omnichannel-requirements.md) (CRM-010 to CRM-013, CRM-034, CRM-070 to CRM-073, AT-06, AT-08 to AT-10). As of **14 November 2026**.

**Why this exists.** Under product flow v2 ([`AGENTS.md`](../AGENTS.md), "Product development flow v2.0.0") a screen with no accepted data source is not ready. CRM-013 requires every KPI to define its event authority, exact numerator and denominator, timezone, window, dedup key, attribution lookback and unknown-data behaviour. Issue #464 forbids code claims before the contract is accepted. This document is that contract; the **owner sign-off checklist in section 11 is the gate**. Until every item there is ticked by the owner, no projection descriptor, route or dashboard is written.

**Reuses, does not replace:** the metric rules of [`aw-business-platform-metrics.md`](aw-business-platform-metrics.md) section 1.1 (one analytics store, counters only increase, `Asia/Jakarta` day buckets by default, UTC instants, detail re-authorised, 35-day restatement window), the segment small-group rule of [ADR-0042](adr/0042-crm-segments-are-immutable-versioned-closed-vocabulary-rules-evaluated-on-demand.md) D6, and the verified conversion facts of [ADR-0056](adr/0056-crm-lead-link-confirms-a-prospect-as-a-commerce-customer-only-from-verified-commerce-facts.md) (issue #463).

## 1. Versioning of this contract

- The contract has a semantic version. **`1.0.0-draft` is this text; it becomes `1.0.0` only when the owner completes section 11.** A change to any definition (numerator, denominator, window, lookback, suppression threshold, dimension) is a **new minor or major version**, never an edit in place; adding a KPI is minor, changing the meaning of an existing one is major.
- Every projection row and every API response **records the `contractVersion` it was computed under**. A rebuild under a new version writes a new set of rows and keeps the old set readable for the restatement window, so a trend is never silently redefined.
- The attribution lookback (section 5), the business-hours policy (section 6) and the suppression threshold (section 7) are **versioned parameters of the contract**, not free per-request options; the API echoes the values in force.
- A derived product may add a KPI or tighten a parameter in its own repository (ADR-0024); it may not loosen a privacy rule of section 7 or 8.

## 2. Event authorities

A KPI is computed **only** from facts a module has already committed. No KPI reads a transient websocket frame, a provider receipt as proof of a human outcome, or a free-text field.

| Fact                                                                     | Authority                                          | Event or record                                                                                                   | Occurrence time                                 |
| ------------------------------------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Lead received, first source touch                                        | `crm_leads`                                        | `awcms.crm_leads.lead.created` (first touch immutable)                                                            | `occurredAt` (bucketing), `recordedAt` (server) |
| Stage reached, stage left                                                | `crm_leads`                                        | `awcms.crm_leads.lead.stage_changed` (names the pipeline revision), plus `stage_migrated` transitions             | `occurredAt`, `recordedAt`                      |
| Owner assigned to a lead                                                 | `crm_leads`                                        | `awcms.crm_leads.lead.assigned`                                                                                   | `occurredAt`, `recordedAt`                      |
| Lead lost                                                                | `crm_leads`                                        | `awcms.crm_leads.lead.lost` (carries no reason: a reason is free text and never leaves `crm_leads`)               | `occurredAt`, `recordedAt`                      |
| Lead merged or merge undone                                              | `crm_leads`                                        | `awcms.crm_leads.lead.merged`, `awcms.crm_leads.lead.merge_reverted`                                              | `occurredAt`, `recordedAt`                      |
| Conversion confirmed or reversed                                         | `crm_leads` (CRM side), `commerce` (evidence side) | `awcms.crm_leads.lead.converted`, `awcms.crm_leads.lead.conversion_reversed`                                      | `occurredAt`, `recordedAt`                      |
| Verified customer registration                                           | `commerce`                                         | `awcms.commerce.customer.registered` (OTP-verified registration only; a guest checkout never publishes)           | `occurredAt`, `recordedAt`                      |
| Verified commerce conversion fact                                        | `commerce`                                         | `awcms.commerce.customer.converted` (carries `evidenceKind`, opaque `orderId`, `firstSourceKind`, `firstTouchId`) | `occurredAt`, `recordedAt`                      |
| Order paid, cancelled, fully refunded (conversion value and correction)  | `commerce`                                         | the existing order and refund events, as already consumed by the loyalty and commission consumers                 | `occurredAt`, `recordedAt`                      |
| Inbound interaction awaiting a reply, first reply, assignment, hand-over | `omnichannel_inbox`                                | the conversation row and its **append-only activity history** (assignment history, response stamps)               | **server time recorded by the inbox**           |
| Follow-up task due, completed, overdue                                   | `crm_follow_up`                                    | the module's task records                                                                                         | server time recorded by the module              |

**Honest gaps the sign-off must acknowledge (see Q1 and Q2 in section 11).** At the time of writing, neither `omnichannel_inbox` nor `crm_follow_up` publishes a domain event for a response, an assignment or a task outcome: the inbox records a response when staff post it after replying through the channel's own route, and its activity history is a table, not an event stream. This contract therefore names those **append-only timestamps** as the authority and requires that, before the SLA or follow-up projections are built, upstream either publishes an event for them or exposes a reviewed read port. Nothing is inferred from a provider delivery receipt, and nothing is reconstructed from message content.

**Which time buckets a fact.** The `crm_leads` events carry two instants: `occurredAt`, which a staff caller may supply for a back-dated fact (it is bounded by the server clock and never in the future), and `recordedAt`, the server's. A fact is **bucketed by `occurredAt`** (business time) and **`recordedAt` decides restatement and freshness**: a fact recorded after the 35-day restatement window for an earlier `occurredAt` restates that day and flags it (section 8). `commerce` and inbox facts use their own server instants.

**Dedup and ordering.** Every counter is keyed by the **event id** of the source fact; a re-delivery, a replay and a rebuild converge on the same value. Facts about one lead are applied in `(occurredAt, recordedAt, eventId)` order; a fact that arrives before the fact it depends on (a `converted` before its `created`) is **parked** on the lead's key and applied when the dependency arrives, and a projection that cannot place it within the restatement window reports it in the data-quality block (section 10.1) instead of dropping it.

## 3. Lead funnel

### 3.1 Stages come from categories, not from tenant stage names

A pipeline revision is immutable and tenants name their own stages, so a funnel cannot be defined on stage keys. Every stage carries one of six **closed categories**: `new`, `working`, `qualified`, `converted`, `lost`, `disqualified`. The funnel is defined **on categories**; the stage key and revision are available as drill-down dimensions only. A lead moved by a `stage_migrated` transition is a **re-map, not a progression**: it changes "currently in" counts but never creates a "reached" event.

### 3.2 Counters

Counters only increase; every figure shown is derived at read from monotonic counters, exactly as in the metrics contract. Two families exist and are always labelled:

- **Reached (cohort, "ever")**: the number of leads of a cohort that **first entered** a category at any time up to `asOf`. A lead is counted once per category, on its first entry, whatever it does afterwards. A reached count never falls because a lead later moved on.
- **Currently in (snapshot)**: leads whose latest transition is in the category at `asOf`. It is a snapshot and is labelled as such; it is never used as a funnel numerator.

| KPI                                          | Definition (numerator)                                                                                                                                                                                                                                                                                                                                             | Cohort key                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `leads_received`                             | Count of distinct leads with a `lead.created` event in the window. A lead merged away is removed from the count while the merge stands and restored by `merge_reverted`.                                                                                                                                                                                           | `created` day in the tenant timezone |
| `leads_contacted`                            | Leads that first entered a `working` category after `new`.                                                                                                                                                                                                                                                                                                         | the lead's `created` day             |
| `leads_qualified`                            | Leads that first entered `qualified`.                                                                                                                                                                                                                                                                                                                              | the lead's `created` day             |
| `leads_registered`                           | Leads with a live commerce link whose `evidenceKind` is `customer_registration`, from `awcms.commerce.customer.converted`.                                                                                                                                                                                                                                         | the lead's `created` day             |
| `leads_converted`                            | Leads with a **live** conversion: `lead.converted` minus `lead.conversion_reversed`, and (for a commerce-evidenced conversion) the link not in a reversed state.                                                                                                                                                                                                   | the lead's `created` day             |
| `leads_lost`                                 | Leads that first entered `lost` or `disqualified`, split by category (`lost` or `disqualified`), source and the category the lead left; a lead later re-opened is not lost any more at read time.                                                                                                                                                                  | the lead's `created` day             |
| `follow_ups_completed`, `follow_ups_overdue` | Defined by name; numerator and event authority are pending Q2.                                                                                                                                                                                                                                                                                                     | task due day                         |
| `attrition_by_reason`                        | **Not computable today.** A lead's loss reason is free text (`reason`, bounded length), is erased with the lead, and is deliberately absent from every event; it is never read, parsed or bucketed. A reason breakdown needs a **closed reason-code catalogue** owned by `crm_leads` (Q6). Until then the KPI returns `null` with `reason: "no_reason_catalogue"`. | the lead's `created` day             |
| `acquisition_cost`                           | **Reported only when a cost source exists** (a campaign or channel cost recorded by a module that owns it). Otherwise the value is `null` (unknown), never `0`.                                                                                                                                                                                                    | campaign or channel and day          |

`leads_registered` and `leads_converted` can only be **counted for a lead a person has linked**: commerce never matches a lead on phone, e-mail or handle (ADR-0056 D1), so a customer who registered without a confirmed link is **not** a registered lead. A dashboard may show the commerce-side customer registrations beside the funnel as a separate, unattributed figure, never added into it.

### 3.3 Stage-to-stage conversion and drop-off

`conversion(A to B) = reached(B) / reached(A)` over the **same cohort** (leads created in the window), computed from the reached counters. Drop-off is `1 - conversion`. Because both numerator and denominator are over one cohort, an in-flight lead lowers the rate until it advances; every response therefore carries `cohortMaturityDays` (the median lead age in the cohort) and a `provisional: true` flag while the cohort's newest lead is younger than the tenant's configured maturity (default 30 days, a contract parameter). A rate is never presented as final while provisional.

### 3.4 Pipeline version

A cohort that spans pipeline revisions is reported on categories, which are stable across revisions. A drill-down by `pipelineRevision` is exact for leads created under that revision and labelled "mixed" for leads migrated across revisions. Filtering by an unknown or retired revision returns an empty, non-error result.

## 4. Conversion from verified commerce facts

- **Authority.** A conversion counts only if the lead has a live link created by `POST /api/v1/commerce/crm-lead-links` (ADR-0056), whose evidence the server verified: an OTP-verified registration, or a paid order of that customer. A message receipt, a delivery status, a click or a reply is **never** a conversion.
- **Conversion value.** When the evidence is a paid order, the value is that order's **paid total net of completed refunds**, in integer cents, from the order and refund facts already consumed elsewhere (loyalty, commission). A refund after the window restates the day of the original conversion under the restatement rule (section 8), never the day of the refund. A registration-evidenced conversion has **no value** (`null`), not `0`.
- **Reversal.** A link flagged `reversal_pending` is **still counted as converted** until a person applies the reversal, because the flag is a request and the CRM conversion stands; the response exposes a separate `reversalPending` count so the owner sees the exposure. After the person reverses it, the conversion leaves the numerator and the day it was counted on is restated.
- **Time to convert.** `convertedAt - createdAt` of the lead, as a distribution (median and percentiles over the cohort), not an average.
- **Second conversions.** A lead converts once; a customer's later orders are commerce revenue, not funnel conversions.

## 5. Campaign attribution

- **Touch model.** Attribution reads the lead's **first source touch** (immutable, carried by `lead.created` and copied into the link as `firstSourceKind` and `firstTouchId`) and its appended later touches. The source dimensions are channel, channel account, brand and campaign, taken from the touch's own reference; a touch with no campaign reference is attributed to its channel only.
- **Default model: first touch.** A conversion is credited in full to the lead's first source touch, and to no other. A last-touch or multi-touch model is a **different contract version** and is not offered by this one.
- **Lookback.** A conversion is attributed to a campaign only if the lead's first touch occurred **no more than `lookbackDays` before the conversion confirmation time**. The default is **90 days** (a versioned contract parameter, owner decision Q3); a conversion outside the lookback is reported under `unattributed`, never dropped and never credited to the nearest campaign. The window is measured between instants (UTC), not between calendar days.
- **Source-less leads.** A manual or imported lead with no touch campaign is `unattributed` for the campaign dimension. A lead whose source data is missing is `unknown`, which is reported as its own bucket and is **not zero and not an error**.
- **Provider data.** A message the provider accepted, delivered or read is not an outcome of the funnel. Acceptance, delivery, response, registration and conversion are separate series (AT-06); a provider status that the provider never reported is `unknown`, not `0` and not `delivered`.
- **Cost-based figures.** Cost per lead and cost per conversion exist only where a cost source exists for that campaign and period (section 3.2); otherwise they are `null`.

## 6. Staff SLA

### 6.1 First meaningful response

- **Start.** The server receipt time the inbox recorded for the first unanswered inbound interaction of a conversation (the instant its SLA clock starts). **Stop.** The server time of the first **human response record** that answers it. An automatic acknowledgement, a template echo, an out-of-office reply and a bot reply **do not stop the clock**. Both instants are the inbox's own timestamps; the provider's send or delivery time is never used.
- **Measure.** The elapsed **business minutes** between start and stop, using the SLA policy in force for the conversation's tenant or business scope (IANA zone, weekday windows, holidays; the inbox policy is the single source, this contract does not define a second calendar). Time outside business hours and on holidays is **not counted against staff**. The policy version used is recorded with the figure.
- **Pauses.** Time a conversation spends `pending` (waiting on the customer) is paused and is shown in the response, not hidden.
- **Overdue.** A conversation is overdue when its business-minute budget is exceeded and it has no recorded response; it is overdue **once** (a single breach stamp), no matter how many checks run.
- **Distributions, not averages.** The report gives the count answered, the median and the 90th percentile of business minutes to first response, the within-budget percentage and the overdue count. A mean is never the headline.

### 6.2 Fairness: what may and may not be compared

- Staff figures are computed **against actual assignment**: a conversation counts for an operator only for the span it was assigned to them (from the assignment history), and a **manual transfer** splits the span; time before the first assignment belongs to the **queue**, and an unassigned conversation is never attributed to any operator.
- Each operator's row is accompanied by its **denominator**: conversations handled, share outside business hours, channel mix and the assigned workload for the period. No response ranks operators; the API has no `rank` or `sort by response time` over people, and an operator below the small-cell threshold (section 7) is shown only inside the team aggregate.
- **Queue and operator are separate figures.** Queue wait (from receipt to first assignment) is reported for the team, not charged to an operator.
- A report that compares channels states that channels have different expected response times; the comparison uses each channel's own policy budget (within-budget percentage), not raw minutes.

## 7. Denominators, zero and small cells

1. **Every ratio ships its numerator and its denominator** as integers beside the rate. A client never has to reverse-engineer a rate.
2. **Zero denominator.** `rate = null` with `reason: "zero_denominator"`. It is never `0`, `NaN`, `100%` or an omitted field, and a chart shows a gap, not a point.
3. **Unknown is not zero.** Missing provider data, a missing cost, an unreported status and a lead with no source are `null` or `unknown`, and are counted in the data-quality block.
4. **Small cells are suppressed.** Any figure whose underlying group is **fewer than 5** (the threshold already used for segments, ADR-0042 D6; a contract parameter that a tenant may raise, never lower) is returned as `value: null` with `suppressed: true, reason: "fewer_than_5"`. The suppression is **all-or-nothing across a dimension**: if one cell of a breakdown is suppressed and the total is shown, the remaining cells are also suppressed when their difference could reveal it (complementary suppression), so a narrow group cannot be recovered by subtracting.
5. **Differencing.** Two overlapping filters on the same data must not reveal a suppressed cell: the API refuses a request whose filters would produce a group below the threshold at a granularity finer than the requested one (for example a single operator on a single day), returning the coarser result instead of an error.
6. **Percentiles over fewer than 5 observations** are suppressed as well.

## 8. Time, restatement and replay

- **Timezone.** A day, week or month is a half-open interval in the **tenant's timezone**, default `Asia/Jakarta` (metrics contract 1.1.3); instants are stored and exchanged in UTC (RFC 3339). A period boundary assigns an event to the bucket of its own instant, so an event at 23:59:59 and one at 00:00:00 land in different days. A tenant's timezone change takes effect from a stated instant and does not rewrite history.
- **Late events restate the original day.** A compensating or late fact (a reversal, a refund, a delayed event) lands on the **attributed fact's** day; the day is flagged `restated` if it changed after the 35-day restatement window. Figures are corrected, never frozen.
- **Replay parity (AT-08).** Replaying the source events into an empty projection must give **exactly** the live figures, including after out-of-order and duplicate delivery; a parity test over a recorded event log is an acceptance condition of the build, not an afterthought.
- **Freshness.** Every response carries `asOf` and `freshness`; a stale projection says so rather than showing a number as current.

## 9. Privacy and exports

### 9.1 No PII in aggregates

A projection row holds **counters and opaque dimension keys only**: tenant, day, brand, channel, channel account, campaign reference, pipeline revision, stage **category**, an opaque assignee id. It holds **no name, contact point, message content, note, free text, lead id or customer id**. Re-identification by combination is the small-cell rule's job (section 7). Drill-down reads the live source tables and **re-authorises per row**; it is never served from the projection.

### 9.2 Authorization and scoping

- Reading a KPI needs its own permission, separate from the permission to read the underlying records; a **business-scope-confined** reader (as in the inbox) sees only their scopes, and a tenant-wide figure is not computed by summing hidden cells.
- Staff SLA figures are readable by team leads and administrators for their scope; an operator reads their **own** row only. No cross-tenant total exists, and a cross-tenant request is refused.
- Every export and every drill-down is audited with the actor, filters, contract version and row count, never the rows.

### 9.3 CSV and Excel-compatible exports

- Every cell is written through `csvCellForWrite` (`apps/cms/src/lib/security/csv-formula.ts`), which neutralises a leading `=`, `+`, `-`, `@`, TAB or CR; the importer side uses `restoreCsvCell`. A KPI value that is a plain signed decimal is written with the helper's `numericText` option, so money keeps its two decimals and sign. **No export writer is hand-rolled**, and the CSV formula sweep (`apps/cms/tests/csv-formula-neutralisation.test.ts`) must list the new writer.
- A suppressed cell is exported as an **empty cell with a `suppressed` marker column**, not as `0`. An unknown is empty, never `0`.
- Exports carry the header block `contractVersion`, `asOf`, `timezone`, filters and a statement that small cells are suppressed. Row and size caps apply, and a large export is produced as a job, not inline.
- An optional PDF is a rendering of the same suppressed figures, never a source of extra detail.

### 9.4 What the API never returns

No lead or customer identifier in a KPI response; no operator ranking; no message text; no raw timestamps of a single conversation in an aggregate response.

## 10. Proposed API response shapes (proposal only, not in OpenAPI)

> **These shapes are a proposal for the owner to accept or change.** They are **not** added to the OpenAPI document and no route exists, so the route-parity gate (`ROUTE_PARITY_EXEMPTIONS`, which must stay empty) is unaffected. The first build issue that implements one of them adds its OpenAPI path and its handler **together**, as ADR-0016's contract-first rule and `AGENTS.md` require. Paths follow the existing `/api/v1/reports/...` convention and a final naming ADR is allocated at build time. Money is a string, counts are integers, instants are RFC 3339 UTC.

### 10.1 Common envelope

```jsonc
{
  "contractVersion": "1.0.0",
  "asOf": "2026-11-14T03:00:00Z",
  "freshness": { "lagSeconds": 42, "stale": false },
  "timezone": "Asia/Jakarta",
  "period": { "from": "2026-11-01", "to": "2026-11-14", "granularity": "day" },
  "filters": {
    "brand": null,
    "channel": null,
    "campaign": null,
    "pipelineRevision": null,
    "assignee": null,
  },
  "parameters": {
    "lookbackDays": 90,
    "smallCellThreshold": 5,
    "cohortMaturityDays": 30,
  },
  "provisional": true,
  "dataQuality": { "parkedEvents": 0, "unknownSource": 12, "restatedDays": [] },
  "data": {},
}
```

### 10.2 Ratio object (used everywhere a rate appears)

```jsonc
{ "numerator": 18, "denominator": 120, "rate": "0.1500", "suppressed": false }
// zero denominator
{ "numerator": 0, "denominator": 0, "rate": null, "reason": "zero_denominator", "suppressed": false }
// small cell
{ "numerator": null, "denominator": null, "rate": null, "suppressed": true, "reason": "fewer_than_5" }
```

### 10.3 `GET /api/v1/reports/crm/funnel`

```jsonc
"data": {
  "cohort": { "leads": 120 },
  "stages": [
    { "category": "new", "reached": 120, "currentlyIn": 31 },
    { "category": "working", "reached": 96, "currentlyIn": 40, "conversionFromPrevious": { "numerator": 96, "denominator": 120, "rate": "0.8000", "suppressed": false } },
    { "category": "qualified", "reached": 51, "currentlyIn": 22, "conversionFromPrevious": { } },
    { "category": "converted", "reached": 18, "currentlyIn": 18, "reversalPending": 1, "conversionFromPrevious": { } },
    { "category": "lost", "reached": 33, "bySource": [{ "sourceKind": "api", "count": 20 }] }
  ],
  "registered": { "numerator": 25, "denominator": 120, "rate": "0.2083", "suppressed": false },
  "timeToConvertDays": { "median": 9, "p90": 21, "observations": 18, "suppressed": false }
}
```

### 10.4 `GET /api/v1/reports/crm/attribution`

```jsonc
"data": {
  "model": "first_touch",
  "rows": [
    { "key": { "channel": "whatsapp", "channelAccountRef": "acc_opaque", "campaignRef": "cmp_opaque" },
      "leads": 40, "converted": 7, "conversionRate": { },
      "value": { "currency": "IDR", "amount": "12500000.00" },
      "cost": null, "costPerConversion": null }
  ],
  "unattributed": { "converted": 3, "reason": "outside_lookback" },
  "unknown": { "leads": 12 }
}
```

### 10.5 `GET /api/v1/reports/crm/sla` and `/api/v1/reports/crm/sla/staff`

```jsonc
"data": {
  "policyVersion": "tenant-default@7",
  "firstResponse": {
    "answered": 210, "overdue": 6, "withinBudget": { "numerator": 198, "denominator": 210, "rate": "0.9429", "suppressed": false },
    "businessMinutes": { "median": 14, "p90": 47, "observations": 210, "suppressed": false },
    "pendingPausedMinutes": 3120
  },
  "queueWait": { "businessMinutes": { "median": 4, "p90": 11 } },
  "staff": [
    { "assigneeRef": "usr_opaque", "handled": 64, "outsideHoursShare": "0.18", "channels": [{ "channel": "whatsapp", "count": 50 }],
      "withinBudget": { }, "suppressed": false }
  ]
}
```

`staff` is returned only to a caller entitled to it, never sorted by a response time, and an operator below the threshold is folded into the team row.

### 10.6 Export

`GET` on the same paths with `format=csv` returns the formula-safe CSV of section 9.3; a large request returns `202` with a job reference. Drill-down is a separate, re-authorised call on the source module's own list route, not on the KPI path.

## 11. Owner sign-off checklist (the gate for any projection code)

The owner accepts the contract by ticking every box **in a recorded decision** (an ADR or a dated amendment of this document that names the accepted version). Nothing here is ticked by an agent.

- [ ] **S1.** Funnel stages are the six closed categories, with "reached" (ever, once per lead) as the funnel numerator and "currently in" as a labelled snapshot (section 3).
- [ ] **S2.** A `stage_migrated` re-map is never a progression (section 3.1).
- [ ] **S3.** `leads_registered` and `leads_converted` count **only linked leads**; unlinked customer registrations are shown separately, never added (section 3.2).
- [ ] **S4.** Conversion is credited only from verified commerce facts, never from a message receipt; a `reversal_pending` link still counts until a person reverses it, and the exposure is shown (section 4).
- [ ] **S5.** Conversion value is the paid total net of completed refunds, restated on the original day; a registration conversion has no value (section 4).
- [ ] **S6.** Attribution is **first touch**, with a default lookback of **90 days** (Q3), unattributed and unknown reported as their own buckets (section 5).
- [ ] **S7.** First meaningful response runs from the inbox's recorded receipt to the first **human** response record, in business minutes under the inbox's own SLA policy, with pending time paused and automatic replies not stopping the clock (section 6.1).
- [ ] **S8.** Staff figures use actual assignment, split on manual transfer, never rank operators, and charge queue wait to the team (section 6.2).
- [ ] **S9.** Zero-denominator is `null` with a reason; unknown is never `0` (section 7).
- [ ] **S10.** Small-cell threshold is **5**, tenant-raisable and never lowerable, with complementary suppression (section 7).
- [ ] **S11.** Aggregates hold no PII or free text; drill-down re-authorises per row (section 9.1).
- [ ] **S12.** Every export goes through `csvCellForWrite`, writes suppressed cells empty with a marker, and is audited (section 9.3).
- [ ] **S13.** Tenant timezone buckets, 35-day restatement window and replay parity are acceptance conditions (section 8).
- [ ] **S14.** The response shapes of section 10 are accepted (or amended) as the starting contract for the first build issue.
- [ ] **S15.** The UX of the report screens is accepted at product-flow step 4 (UX-26 of [`omnichannel-crm-ui-ux.md`](omnichannel-crm-ui-ux.md) is the candidate) **before** the data model for the projections.

**Open questions that block the build, not the contract:**

- **Q1.** Upstream has no event for an inbox response or assignment. Which does the owner prefer: upstream publishes the events, or a reviewed read port over the inbox's activity history? (Section 2.)
- **Q2.** Follow-up KPIs (`follow_ups_completed`, `follow_ups_overdue`) wait on a comparable source from `crm_follow_up`.
- **Q3.** Is 90 days the right default lookback for the tenant's sales cycle, and may a tenant change it (a change is a new contract version)?
- **Q4.** Where a cost source is recorded, and by which module, is not established; cost KPIs stay `null` until it is.
- **Q6.** A loss-reason breakdown (CRM-070 "attrition reasons") needs upstream `crm_leads` to adopt a closed reason-code catalogue and publish the code on `lead.lost`; today reasons are free text kept out of events, so the KPI is `null` rather than guessed.
- **Q5.** Ownership: the cross-domain projections are specified here (the metrics contract's rule for projections that join modules), and the generic parts proposed upstream; the owner confirms the split and the ADR that records it.

## 12. What this document does not do

It does not add a projection, a migration, a route, an OpenAPI path, a dashboard or a screen; it does not change `crm_leads`, `omnichannel_inbox` or `crm_follow_up`; it does not rank staff; and it does not claim any figure above exists today. Build is gated by section 11 and by the usual dependencies of issue #464 (the upstream pipeline, inbox and follow-up modules, and the #463 commerce link, which has landed).
