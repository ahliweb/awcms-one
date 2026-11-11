🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](aw-business-platform-dod.id.md)

# AW Business Platform — Definition of Done walkthrough

Walks the 20 items of section 20 ("Definition of Done for this epic") of epic [#280](https://github.com/ahliweb/awcms-one/issues/280), as assessed on **11 November 2026** for issue [#397](https://github.com/ahliweb/awcms-one/issues/397). The epic itself was closed on 7 October 2026, at its Definition of Ready; this page assesses delivery, and it replaces the open question "can the DoD be ticked?" with one verdict per item. It does not tick an item on the strength of an issue title: every verdict names files, tests or records that exist in this tree or in the embedded upstream tree (`apps/cms`).

"Upstream" means `ahliweb/awcms`; "here" means `ahliweb/awcms-one`. This repository is a template ([ADR-0024](adr/0024-awcms-one-is-template-only-derived-apps-own-their-backend.md)): anything that needs a real deployment, real tenants or real customers is owned by the derived product, not by this repository.

## Verdict key

- **Met**: the evidence exists in this repository or upstream.
- **Met for the template scope**: the template-side obligation is met; the remainder belongs to derived products (ADR-0024), and the row says exactly what remains and who owns it.
- **Partial**: part of the item is missing, and the row says what.
- **Not met**: the item is not done; the row says why and which issue tracks it.

## Summary

| #   | DoD item (shortened)                                       | Verdict                    |
| --- | ---------------------------------------------------------- | -------------------------- |
| 1   | Every capability has an owner and a classification         | Met                        |
| 2   | No accidental `awcms-one` divergence of generic capability | Met                        |
| 3   | CRM customer authority and `profile_identity` documented   | Met                        |
| 4   | Booking admission ADR and double-book prevention           | Met                        |
| 5   | No permanent duplicate booking engines in consumers        | Met for the template scope |
| 6   | Commerce order, payment, POS reused and regression-tested  | Met                        |
| 7   | Invoice and accounting boundary explicit                   | Met                        |
| 8   | Workforce identity references the canonical party/profile  | Met                        |
| 9   | Attendance, shift, commission, payroll boundaries          | Met for the template scope |
| 10  | Payroll rules effective-dated, not hard-coded              | Partial                    |
| 11  | E-mail and push reused; WhatsApp and Telegram no duplicate | Partial                    |
| 12  | Analytics through reporting projections, defined metrics   | Met                        |
| 13  | Threat model, privacy, ERD, matrix, specs, UX, migrations  | Met                        |
| 14  | Acceptance Criteria to automated tests traceable           | Partial                    |
| 15  | Threat/Risk to Control to security test traceable          | Partial                    |
| 16  | UU PDP, PP PSTE, labour-payroll, payment applicability     | Met for the template scope |
| 17  | ISO/IEC/OWASP/PCI evidence mappings, no unsupported claims | Partial                    |
| 18  | Child issues atomic and dependency-aware                   | Met                        |
| 19  | Staging, UAT, Go/No-Go, production validation evidence     | Partial                    |
| 20  | Docs, mirrors, graph, changelog, runbooks synchronised     | Partial                    |

No item is **Not met** outright. Thirteen are Met or Met for the template scope; seven are Partial. The open work is in the "What remains" section at the end.

## Items

### 1. Every capability has an explicit owner and classification: Met

[ADR-0040](adr/0040-aw-business-platform-capability-ownership-and-boundaries.md) D2 is a re-validated reuse/extend/new matrix against the tree (each row has evidence, a class and a placement), D4 is the ownership summary, and D1 is the placement rule that sorts every capability into upstream-first, awcms-one adapter, or owner decision. The classes are Reuse, Extend, Redesign, New and Deferred, as the epic asks. The matrix is cross-checked item by item in the [DoR tracker](aw-business-platform-dor.md) (cross-spec review A9, issue [#339](https://github.com/ahliweb/awcms-one/issues/339)) and the owner accepted it on 8 October 2026 ([#335](https://github.com/ahliweb/awcms-one/issues/335)).

### 2. Generic AWCMS capabilities are not accidental `awcms-one` divergences: Met

Booking, HR workforce, HR commission and WhatsApp delivery were specified and built **upstream** (`awcms` ADR-0131 to ADR-0133, [Booking](../apps/cms/docs/awcms/booking.md), [HR and payroll](../apps/cms/docs/awcms/hr-payroll.md)) and arrived here by subtree sync (issues [#347](https://github.com/ahliweb/awcms-one/issues/347), [#409](https://github.com/ahliweb/awcms-one/issues/409), [#377](https://github.com/ahliweb/awcms-one/issues/377), [#424](https://github.com/ahliweb/awcms-one/issues/424), [#427](https://github.com/ahliweb/awcms-one/issues/427), [#452](https://github.com/ahliweb/awcms-one/issues/452)); `commerce` only adds adapters on top of upstream ports. The divergences that do exist are deliberate, listed one by one in [`AGENTS.md`](../AGENTS.md) ("Known local divergences"), each with its resolution rule, and tracked for upstreaming in [#420](https://github.com/ahliweb/awcms-one/issues/420). `apps/cms/tests/module-boundary.test.ts` and `apps/cms/tests/commerce-migrations-range.test.ts` hold the structural line (no module imports another; commerce migrations stay in their band).

### 3. CRM customer authority and the future `profile_identity` relationship: Met

Documented as an owner decision (O12): commerce stays the customer authority and no second customer master (`crm_customer`) is created, in [ADR-0040](adr/0040-aw-business-platform-capability-ownership-and-boundaries.md) D2/D5 and the [PRD](aw-business-platform-prd.md) sections 1.1 and 5. Harmonising customers with `profile_identity` is explicitly deferred to its own expand/map/backfill ADR; it is not a gap in this item. The customer-reference rule for bookings (the customer is derived through the linked order) is in the [booking-commerce adapter data model](booking-commerce-adapter-data-model.md) and [ADR-0045](adr/0045-booking-commerce-adapter.md).

### 4. Booking has an admission ADR and a proven double-book prevention strategy: Met

Upstream `awcms` [ADR-0131](../apps/cms/docs/adr/0131-generic-booking-module-admission.md) admits `booking` and section 2 puts double-booking prevention in the database: `EXCLUDE USING gist` over the resource unit and time range, with a database-clock hold expiry. [ADR-0135](../apps/cms/docs/adr/0135-day-granularity-stays-admitted-into-booking-v1.md) admits day-granularity stays. Proof is executable: `apps/cms/tests/booking-allocation.test.ts`, and the DB-gated concurrency suites `apps/cms/tests/integration/booking-concurrency.integration.test.ts` and `apps/cms/tests/integration/booking-stay.integration.test.ts` (which also prove the "detects the defect" case by dropping the constraint). The commerce adapter does not re-implement allocation: [ADR-0045](adr/0045-booking-commerce-adapter.md) calls `BookingPort` only.

### 5. Consumer-specific booking implementations do not become permanent duplicate engines: Met for the template scope

[ADR-0024](adr/0024-awcms-one-is-template-only-derived-apps-own-their-backend.md) and `AGENTS.md` ("Template-only ownership rule") state that vertical booking code stays in the consumer repository and that only a neutralised, versioned capability is promoted. The generic engine is upstream and versioned (`BookingPort` 1.1.0 since the #427 sync; `apps/cms/tests/booking-port-additions.test.ts`; [cross-domain contracts](../apps/cms/docs/awcms/cross-domain-contracts.md)), and the adapter's vocabulary carries no vertical field ([PRD](aw-business-platform-prd.md) section 3: "hotel" is the acceptance scenario, not a column). IRMbyDUS-specific code is owned by `ahliweb/web-irmbydus.com`, as `AGENTS.md` records for issue #297. **What remains, and who owns it:** each derived product's migration of its own booking code onto the upstream `booking` module is that product's plan; this repository cannot verify it.

### 6. Commerce order/payment/POS remain reused and regression-tested: Met

The adapters sit on the existing ledgers rather than beside them: [ADR-0025](adr/0025-payments-are-an-allocation-ledger-separate-from-order-status.md) (payments), [ADR-0041](adr/0041-gateway-deposit-sessions-and-mixed-tenders-on-one-order.md) (deposits and mixed tenders), [ADR-0028](adr/0028-pos-register-sessions-and-cash-up.md) (POS), [ADR-0033](adr/0033-returns-refunds-and-exchanges-are-additive-records-that-compensate-through-the-existing-ledgers.md) (returns). Regression coverage is DB-backed: `apps/cms/tests/integration/commerce-orders.integration.test.ts`, `commerce-payment-allocations.integration.test.ts`, `commerce-payment-webhook.integration.test.ts`, `commerce-pos.integration.test.ts` and `commerce-returns.integration.test.ts` in the same directory, plus the whole `local-ci/check-cms` leg ([`docs/pengujian.md`](pengujian.md)). Load and concurrency benchmarks for the new paths exist ([benchmarks](benchmarks-commerce-load.md), issue [#395](https://github.com/ahliweb/awcms-one/issues/395)).

### 7. The invoice/accounting boundary is explicit: Met

[ADR-0040](adr/0040-aw-business-platform-capability-ownership-and-boundaries.md) D6 and [ADR-0029](adr/0029-commerce-documents-are-separate-records-and-numbered-documents-are-immutable-order-snapshots.md) D1: a commercial receipt or invoice is a numbered, immutable snapshot of an order and holds no balance; a booking never issues a numbered document (the linked order does); the fiscal tax document is out of scope ([ADR-0039](adr/0039-commerce-tax-is-computed-by-the-tax-module-behind-a-per-tenant-mode.md) D6); an accounts-receivable invoice stays Deferred until a finance domain exists upstream. Expenses are likewise commerce-local ([ADR-0031](adr/0031-expenses-are-commerce-local-register-linked-petty-cash.md)).

### 8. Workforce employee identity references the canonical party/profile: Met

Upstream design: employment stores a `profile_identity` reference and never copies name, contact or national id ([HR and payroll](../apps/cms/docs/awcms/hr-payroll.md), section 3, composite foreign key, "no personal column in any HR table"). It is built: `hr_workforce` is in the registry (`sql/176`-`177`, `184`-`185`), and `apps/cms/tests/payroll-data-boundary.test.ts` and `apps/cms/tests/payroll-catalog-boundary-1077.test.ts` hold the boundary mechanically. ADR-0040 D3 records the dependency direction.

### 9. Attendance/shift/commission/payroll boundaries are specified and authorized: Met for the template scope

Specified upstream in [HR and payroll](../apps/cms/docs/awcms/hr-payroll.md) and ADR-0132, ADR-0136 (configurable segregation of duties, default three-way), ADR-0137 (payout accounts encrypted and keyed-hashed), ADR-0138 (geolocation: verdict only, off by default); authorized by the permission and ABAC model recorded in the same pack, and by [ADR-0046](adr/0046-commission-attribution-adapter-reports-paid-counter-sales-to-the-hr-commission-ledger.md) for the one place `commerce` touches the commission ledger (paid counter sales, with a reversal). The payroll boundary gates (`payroll:sql-boundary:check`, `sensitive-reads:check`) run in `bun run check:cms`; `apps/cms/tests/commerce-commission-boundary.test.ts` and `apps/cms/tests/commerce-commission-attribution.test.ts` pin the adapter's side. **What remains:** `hr_payroll` itself is not admitted into the registry; its admission, build and any payroll-data privacy review belong upstream (design pack, [ahliweb/awcms#916](https://github.com/ahliweb/awcms/issues/916)) and then to each derived product's payroll deployment.

### 10. Payroll regulatory rules are effective-dated/versioned: Partial

Done: commission rules are versioned data with pure evaluation (upstream `hr_commission`, [HR and payroll](../apps/cms/docs/awcms/hr-payroll.md) section 6), and employment terms are effective-dated and append-only (section 4.1). The payroll rule model (section 7.3: jurisdiction-neutral, effective-dated rule data, never a template constant) is **specified**, and the threat model records the applicable instruments as inputs. **Missing:** payroll is design only, so there is no implemented rule-version table or independently testable tax calculation to point at. Owner: upstream `hr_payroll` (phase 3), with the Indonesian payroll profile as a consumer-owned or upstream rule-data decision (owner answer O4, recorded in the pack). Nothing in this repository hard-codes a payroll rule.

### 11. Email/push reused; WhatsApp migration and Telegram do not duplicate delivery: Partial

Reused: e-mail through the upstream outbox ([ADR-0034](adr/0034-commercial-documents-are-delivered-through-the-existing-outboxes-as-transactional-messages-built-from-immutable-sources.md)); customer Web Push is built on the upstream `push_delivery` module ([ADR-0048](adr/0048-customer-web-push-identity-subscription-and-cross-origin-contract.md), issues #430 to #432, `apps/cms/tests/commerce-customer-push.test.ts`, `apps/cms/tests/commerce-customer-push-fanout.test.ts`); WhatsApp moves to the upstream queue through a per-tenant mode router ([ADR-0047](adr/0047-commerce-whatsapp-moves-to-the-upstream-queue-through-a-per-tenant-mode-router.md), phases 2 and 3 built, `apps/cms/tests/commerce-whatsapp-upstream-boundary.test.ts`); Telegram is an upstream adapter for staff alerts only (ADR-0140) and cross-channel orchestration was not admitted (ADR-0139). **Missing:** phase 4, removing commerce's own WhatsApp outbox and legacy path, is open as [#394](https://github.com/ahliweb/awcms-one/issues/394); until then a second queue exists by design. [ADR-0054](adr/0054-the-adr-0133-whatsapp-legacy-path-backstop-moves-to-v0-22-0.md) sets the backstop: removal no later than v0.22.0. The CRM omnichannel follow-ups (#458 to #461, #463, #464, #466) are blocked on open upstream issues and are not part of this item.

### 12. Analytics uses reporting projections with formally defined metrics: Met

Metric contracts for revenue, occupancy, utilisation, retention and employee productivity: [metrics](aw-business-platform-metrics.md). Implementation is on the reporting engine, not a parallel store: [ADR-0035](adr/0035-pos-operational-reports-are-commerce-projections-over-the-existing-ledgers-on-the-reporting-engine.md) (POS reports), [ADR-0044](adr/0044-customer-retention-is-a-per-customer-recompute-projection-on-the-reporting-engine.md) (retention), the booking revenue slice ([#389](https://github.com/ahliweb/awcms-one/issues/389), [#478](https://github.com/ahliweb/awcms-one/issues/478); `apps/cms/tests/commerce-booking-revenue-domain.test.ts`), upstream ADR-0143 and [workforce metrics](../apps/cms/docs/awcms/workforce-metrics.md).

### 13. Threat model, privacy, ERD, matrix, domain specs, contracts, UX and migration plan complete: Met

All ten DoR artifacts are recorded as satisfied or explicitly waived in the [DoR tracker](aw-business-platform-dor.md): [threat model and privacy analysis](aw-business-platform-threat-model.md), [ERD and data dictionary](booking-commerce-adapter-data-model.md), [RBAC/ABAC/RLS matrix](booking-commerce-access-matrix.md), [OpenAPI/AsyncAPI drafts](booking-commerce-adapter-contracts.md) (drafts; the live paths are in `apps/cms/openapi/modules/commerce.openapi.yaml`), [UX](booking-ux-flows.md) (plus [omnichannel UI/UX](omnichannel-crm-ui-ux.md)), the PRD and metrics. The migration plan is [ADR-0037](adr/0037-the-commerce-migration-band-is-allocated-gap-first-and-widened-upstream.md) and the band rules in `AGENTS.md`, enforced by `apps/cms/tests/commerce-migrations-range.test.ts`. The three residuals the owner waived on 11 October 2026 (R1 to R3) are recorded there with their reasons.

### 14. Acceptance Criteria to automated tests is traceable: Partial

Each child issue carries its acceptance criteria, and each shipped feature has unit and DB-gated integration tests named for it (for example `apps/cms/tests/integration/commerce-booking-hold-to-order.integration.test.ts` for #380). The PRD ([measurable outcomes, section 7](aw-business-platform-prd.md)) defines the outcomes. **Missing:** there is no single matrix mapping each PRD story or criterion to its test file; the mapping lives in issue and PR text and in test names. Owner: this repository, a docs-only follow-up; it is not a blocker for a release.

### 15. Threat/Risk to Control to security regression test is traceable: Partial

The threat model has STRIDE tables per flow F1 to F11 and a control table C-01 to C-41 ([threat model](aw-business-platform-threat-model.md) sections 4 and 7), and the adapter contracts carry a [control traceability](booking-commerce-adapter-contracts.md) section. Tests cite their control: C-05 to C-12 and C-25 to C-41 appear in test files (for example `apps/cms/tests/commerce-booking-cancellation-domain.test.ts`, `apps/cms/tests/commerce-segment-contract.test.ts`, `apps/cms/tests/commerce-gateway-deposit-domain.test.ts`). **Missing:** section 7's own text still says every row is "planned" and names tests "planned"; it was never refreshed to implemented status, and C-01 to C-04 and C-13 to C-24 are not cited by any test, so the forward link (control to test) is incomplete in the document even where a test exists. Owner: this repository, a docs-only refresh of that table.

### 16. UU PDP / PP PSTE / labour-payroll / payment regulatory applicability documented: Met for the template scope

[Threat model](aw-business-platform-threat-model.md) section 6 lists UU 27/2022 (PDP), PP 71/2019, PP 49/2025, PMK 168/2023, PBI 10/2025 and PADG 32/2025 with the flows each may touch, the unknowns and the action; section 5 is the privacy analysis (legal role per deployment, minimisation, retention, data-subject hooks); upstream adds [privacy analysis](../apps/cms/docs/awcms/privacy-analysis.md). The document states in its first lines that it is not legal advice and makes no compliance claim, and that the list was not re-verified against the instruments. **What remains, and who owns it:** control C-24, counsel's review for the real production scope, belongs to each derived product's operator; the same applies to ADR-0048 D8's counsel review of consent wording for customer push.

### 17. Applicable ISO/IEC/OWASP/PCI controls have evidence mappings; no unsupported claim: Partial

No "compliant" or "certified" claim is made anywhere (the threat model says standards are "mapping targets, not claims"; [`SECURITY.md`](../SECURITY.md) claims none). Mappings exist: upstream maps OWASP ASVS and ISO/IEC 27001 Annex A to code surfaces ([standards mapping](../apps/cms/docs/awcms/standar-performa-dan-keamanan.md)); [ADR-0048](adr/0048-customer-web-push-identity-subscription-and-cross-origin-contract.md) carries an instrument-by-instrument table for customer push; the threat model's control table has an Evidence column and the hosted-payment-page design keeps PCI scope minimal (flow F2). **Missing:** a per-standard evidence map for the booking, commission, segment and WhatsApp-mode adapters, in the epic's section 14 format. Owner: this repository, docs-only, after the control table of item 15 is refreshed.

### 18. Child implementation issues are atomic and dependency-aware: Met

54 Wave C to F issues were created on 11 October 2026 with the dependency graph and target repository each ([DoR tracker](aw-business-platform-dor.md), "Generated Wave C to F issues"), after the ADR-0040 D7 gate held. The commerce-only Wave B issues (#360 to #364) preceded them. The Booking chain #378 to #396 is merged here and the commission adapter (#391) with it; upstream-blocked remainders are tracked in [#420](https://github.com/ahliweb/awcms-one/issues/420).

### 19. Staging/UAT/Go-No-Go/production validation evidence exists for delivered waves: Partial

Template-level validation exists: every merge needs all twelve `local-ci/*` legs green at its exact SHA ([`docs/pengujian.md`](pengujian.md), ADR-0021), the DB-backed integration suite runs against a real migrated PostgreSQL, a restore drill with reconciliation exists for the booking adapter tables (issue [#396](https://github.com/ahliweb/awcms-one/issues/396), `apps/cms/tests/commerce-booking-restore-drill.test.ts`), and the benchmarks above. **Missing, and by design not here:** staging, UAT, a Go/No-Go record and production validation for a real deployment, which belong to the derived product that runs it (ADR-0024: this repository must not host a product's production tenant). **Missing and owned by the template:** the customer Web Push production gates in ADR-0048 D8 (counsel review of the consent wording, a real VAPID pair and operator test matrix, device UAT on an installed iPhone app, Chrome Android and desktop) have not been run, and the `customerPush` flag stays off by default (see [`docs/status.md`](status.md)). The [operator test matrix](../apps/cms/docs/awcms/push-notifications-test-matrix.md) is the procedure.

### 20. Documentation, Indonesian mirrors, knowledge graph, changelog/changeset, runbooks synchronised: Partial

Done: every governance document here has its Indonesian mirror (`audit:translation`), the root knowledge graph was refreshed for the v0.20.0 release, [`CHANGELOG.md`](../CHANGELOG.md) and `.changesets/` are current (`bun run release` produced v0.20.0 and `audit:rilis` is green), and the runbooks are [deployment](deployment.md), [release](rilis.md) and [testing](pengujian.md), including the ADR-0047 cutover procedure. **Missing, found while writing this page and outside its scope:** the last "Not here yet" bullet of [`docs/status.md`](status.md) still says epic #280 is "architecture-only" with "no implementation landed", which is no longer true; and the threat-model control table (item 15) is stale. Owner: this repository; each is a small docs-only change. This page and its changeset are the #397 part of the item.

## What remains

| What                                                                                       | Item(s)    | Owner and tracking                                                                                                                                            |
| ------------------------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remove commerce's WhatsApp legacy path (phase 4), no later than v0.22.0                    | 11         | This repository, [#394](https://github.com/ahliweb/awcms-one/issues/394), [ADR-0054](adr/0054-the-adr-0133-whatsapp-legacy-path-backstop-moves-to-v0-22-0.md) |
| `hr_payroll` admission and the payroll rule versions                                       | 9, 10      | Upstream, [ahliweb/awcms#916](https://github.com/ahliweb/awcms/issues/916) design pack                                                                        |
| Customer Web Push production gates (counsel, real provider, device UAT), per deployment    | 16, 19     | The derived product that turns `customerPush` on (ADR-0048 D8)                                                                                                |
| Counsel review of the regulatory notes for the real scope (C-24)                           | 16         | The derived product's operator                                                                                                                                |
| Staging, UAT, Go/No-Go and production validation                                           | 19         | The derived product that deploys (ADR-0024)                                                                                                                   |
| Acceptance-to-test matrix; refresh the threat-model control table; standards map           | 14, 15, 17 | This repository, docs-only follow-ups                                                                                                                         |
| Refresh the stale `docs/status.md` epic bullet                                             | 20         | This repository, docs-only                                                                                                                                    |
| CRM omnichannel items (#458 to #461, #463, #464, #466)                                     | none       | Blocked on open upstream issues; not part of this DoD                                                                                                         |
| Issues #388 and #430 to #432 are merged on the integration branch but still open on GitHub | 18         | Close when that branch lands on `main`                                                                                                                        |

A release can be cut with `bun run release`: the changeset backlog and `audit:rilis` are the only conditions, and neither depends on the items above.
