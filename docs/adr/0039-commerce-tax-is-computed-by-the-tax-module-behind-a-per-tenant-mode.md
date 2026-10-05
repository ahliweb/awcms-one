🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0039-commerce-tax-is-computed-by-the-tax-module-behind-a-per-tenant-mode.id.md)

# ADR-0039 — Commerce tax is computed by the `tax` module, behind a per-tenant mode

- **Status:** Accepted
- **Date:** 5 October 2026
- **Decision maker:** ahliweb
- **Related:** issue [#293](https://github.com/ahliweb/awcms-one/issues/293) (parent epic [#281](https://github.com/ahliweb/awcms-one/issues/281); template-only: a generic, reusable capability with no consumer-specific coupling, [ADR-0024](0024-awcms-one-is-template-only-derived-apps-own-their-backend.md)); upstream ahliweb/awcms#889 and its `awcms` ADR-0127 (the `tax` module, brought in by the v10.5.0 subtree sync, issue [#319](https://github.com/ahliweb/awcms-one/issues/319)) and `apps/cms/docs/awcms/tax-calculation.md` §11 (the migration adapter contract this ADR implements); [ADR-0003](0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md) (money); [ADR-0025](0025-payments-are-an-allocation-ledger-separate-from-order-status.md) (payment ledger); [ADR-0029](0029-commerce-documents-are-separate-records-and-numbered-documents-are-immutable-order-snapshots.md) (documents copy the order's money); [ADR-0033](0033-returns-refunds-and-exchanges-are-additive-records-that-compensate-through-the-existing-ledgers.md) (returns); [ADR-0035](0035-pos-operational-reports-are-commerce-projections-over-the-existing-ledgers-on-the-reporting-engine.md) (reports). Migration numbering follows the migration-numbering ADR (0037) D2 (a migration may depend only on lower-numbered objects and never on the returns/report tables `994`–`999`).

## Context

Today the store's tax is one number: `payment.tax.percent` (an integer) and an `active` switch in the store settings. `quoteCart` computes `tax = (subtotal - voucher discount) x percent`, once, half-up, in cents, and adds it to the total. That figure is copied onto the order, the POS sale, a quotation version and every document; refunds (ADR-0033) deliberately do not give it back.

That is enough for a shop whose rate never changes. It cannot express a rate that changes on a date (a back-dated or late-synced sale must be taxed at the rate of its own day), a category that is exempt or zero-rated, prices that already include tax, a stacked levy, or a refund that takes back exactly the tax that was charged. Upstream AWCMS now ships a generic, jurisdiction-neutral module that does all of this (`awcms` ADR-0127): effective-dated rule versions, a pure exact calculator, an append-only snapshot per finalised document, and a reversal computed from the original snapshot alone. Its §11 specifies how a consumer that holds a flat percentage should move onto it, and says that, with matching settings, the difference to the legacy figure is exactly zero.

The questions: _where_ is the switch, _how_ does a document-level voucher become per-line tax input without changing a cent, _what_ is the unit of tax that a return reverses, _how_ does a tenant move over safely and back, and _where_ do tax reports live.

## Decision

### D1 — A per-tenant mode, `flat` (default) or `engine`

|               | A. Replace the percentage for everyone                     | B. Keep the flat percentage and never adopt the module             | **C. A per-tenant mode over the upstream engine (chosen)**                                       |
| ------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Advantages    | one code path                                              | zero work                                                          | existing tenants unchanged until an operator moves them; the engine is exercised in shadow first |
| Disadvantages | a silent re-pricing of every tenant on deploy; no rollback | cannot express effective dates, exemptions, inclusive prices       | two paths exist until the last tenant is moved                                                   |
| Correctness   | parity unproven per tenant                                 | rate changes edit history's meaning; a refund cannot mirror a sale | parity is _checked per tenant_ before the flip and the flat path stays byte for byte             |
| Reversibility | none                                                       | n/a                                                                | the mode flips back; engine-mode orders keep their snapshots                                     |

`awcms_commerce_store_settings` gains `tax_mode` (`flat` | `engine`, default `flat`) and `tax_profile_code` (default `store-default`), and `awcms_commerce_products` gains `tax_category_code` (nullable; `NULL` = standard, i.e. the version's fallback rule), and `awcms_commerce_orders` gains `tax_snapshot_id` (nullable; composite FK `(tenant_id, tax_snapshot_id)` to `awcms_tax_snapshots`, `ON DELETE SET NULL (tax_snapshot_id)` because snapshot retention must not be blocked by, or cascade into, an order; a unique partial index makes a snapshot belong to at most one order). All of it is `sql/948_awcms_commerce_tax_adapter.sql`, the only migration this change uses; it depends on upstream `171`–`173` and on commerce `<= 947` only.

- **The mode lives in real columns, not in the `settings` jsonb blob**, for the reason `affiliate_commission_rate` does (`sql/921`): the admin's full-replace `PUT /store-settings` must not be able to flip or clobber it, and a `PUT` carrying `taxMode` is refused as an unrecognised field. `GET` returns it read-only. Only the audited cut-over tooling writes it (D4).
- **A settings reset never erases the mode.** The reset stamps a row for purge; an engine-mode row is reset in place instead, and enabling the mode revives a stamped row, so retention cannot silently put a tenant back on a rate it no longer maintains.
- **Tax category is per product, not per variant.** A variant is a size or a colour of the same supply; a different tax class is a different product. This keeps the quote's per-line input a function of `product_id` alone.
- **No `taxMode` toggle in the settings API.** The issue's "setting tax*mode reuses commerce settings permissions" is honoured for \_reading* (`commerce.settings.read`); flipping is ops-only (D4, D7) because a flip without a parity check is exactly the accident §11 F warns about.

### D2 — Engine-mode runtime: quote in memory, snapshot at placement, reverse from the original

- **Quote** (cart, POS preview, quotation version): `buildCartQuote` resolves the tenant's mode; in engine mode it resolves the published version for the store's **business date** (`Asia/Jakarta`, the constant the sales reports already use — a calendar date, never the server's clock) and the products' categories, and hands both to the pure `quoteCart`, which calls the tax module's calculator in place of the percentage multiplication. Nothing is persisted. In flat mode not one extra query beyond the one-row mode read runs.
- **Order placement** (storefront `createOrderFromCart` and `createPosOrder`): after the order and its items exist, in the same tenant transaction, `finaliseOrderTax` resolves the version for the business date, calls the calculator and `finaliseSnapshot` (`documentType = "order"`, `documentId = <order id>`, line refs = the order item ids), stores `tax_snapshot_id`, audits `tax.snapshot.finalise` and appends the module's own outbox event. It is in process: no network call, no `Idempotency-Key` (the snapshot's natural key `(tenant, kind, documentType, documentId)` already makes it idempotent, and the request-level idempotency of the order itself returns the stored order before any of this runs). The order's tax is **the snapshot's**: the figure is computed once, by the quote, from the same version, date and inputs, and the finalise **fails closed** with `OrderTaxMismatchError` if the snapshot's total differs from what the order was priced with. Commerce never recomputes tax locally.
- **Return** (ADR-0033): `createReturn` reverses, from the order's **original** snapshot (never today's rule), the tax of exactly the units returned. Mapping onto the module's reversal API (`tax-calculation.md` §6): each returned order line becomes one reversal line `{ lineRef: <order item id>, quantity: <units returned> }`; the module takes `round(original x q / Q)` of the line's net and of each component with the snapshot's own rounding mode and scale (the exact remainder when the last units come back), capped at what earlier reversals left, so the sum of all reversals can never exceed — and, when everything is returned, equals — the original. The reversal's `documentId` is `return:<return id>`, so a replay is idempotent; **no column on the return or refund is needed**, which is also what the migration-numbering ADR (0037) D2 requires.
- **Cancellation and expiry** reverse whatever tax still stands on the snapshot (every line not already reversed by a return). Without this an abandoned checkout would sit in the tax ledger as a sale forever. The expiry job runs as `awcms_worker`, which `sql/172` gave only `SELECT`/`DELETE` on the ledger; `sql/948` adds `INSERT` (the reversal row) and `UPDATE` (solely so `SELECT ... FOR UPDATE` may lock the original — the immutability trigger still refuses every real `UPDATE` for every role), asserted in `security-readiness.ts`.
- **The client never submits tax.** Order, POS and quote request validators ignore any `tax`/`taxAmount`/`total` key; the order is repriced by the server. The module's own API still refuses a tax amount by name (`TAX_AMOUNT_NOT_ACCEPTED`).
- **A tax the engine cannot answer blocks checkout.** No published version for the date, a category with no rule and no fallback, or a rounding scale other than 2 (commerce money is `numeric(14,2)`) make the quote carry `tax.error` and `canCheckout: false`. A line is never silently untaxed.
- **Inclusive pricing is supported**: when the version prices tax into the line amounts the quote reports the extracted tax and does not add it to `total` (`tax.inclusive: true`).
- **The tax date window is not re-guarded in process.** The API's `guardTaxDate` (server date -7/+1 days unless `tax.snapshots.backdate`) protects a caller-stated date; here the date is derived from the order's own creation instant, so the guard has nothing to guard. An offline-POS sync that wants a past date still goes through the API (§11 G).

### D3 — A document-level voucher becomes per-line discounts, allocated in cents; parity is proven

The flat path taxes `subtotal - voucher discount`. The module's discount is per line. The voucher is allocated across the quoted lines by the largest-remainder method in cents (`allocateOrderDiscount`, the function returns already use, ties to the lower index, capped at each line), so the lines' amounts sum to exactly `subtotal - voucher discount`. With a `taxable` fallback rule at the same percentage, `exclusive` pricing, `half_up`, scale 2 and `document` level, the engine's total equals the flat figure **exactly**. This is a test, not an argument: a seeded property test (fixed seed) prices 2,000 random carts at the adapter and 500 through the real `quoteCart` (random catalogue, tier discounts, percentage and nominal vouchers) and asserts equality of tax and total in both modes. One pre-existing flat-mode oddity is deliberately **not** reproduced: a nominal voucher larger than the subtotal makes the flat tax negative; the engine caps the discount at the subtotal (tax 0). It is outside the parity domain and flat mode is not changed.

### D4 — Setup tooling: `bun run commerce:tax:cutover`

An ops-only CLI (the composition root; it calls the tax module's application functions directly), **dry-run by default**:

1. Derive the `store-default` profile from the current settings (§11 A): one fallback rule, `taxable` with one `net` component at the store's percentage (`exempt` when the percentage is off or zero); `exclusive` pricing — today's total adds tax on top of the prices, so prices exclude it; `half_up`, scale 2, `document` level; `effectiveFrom` = the server's date (a version cannot be published into the past). A version already in force for the profile is **reused**, never overwritten.
2. Shadow parity (§11 F): re-price the tenant's most recent flat-mode orders (`--sample`, default 200; `--since` to skip orders from before a rate change) through the engine and compare with the tax each stored. **Any difference refuses the flip** and writes nothing; it is a configuration mismatch, not a rounding tolerance.
3. On `--commit` and exact parity, in one tenant transaction: create and publish the version (if needed; audited, with the module's `rule_version.published` event) and set `tax_mode = engine` (audited `commerce / tax_mode.update`, critical). `--tenant <code>` stages the rollout.
4. Rollback = `--rollback --commit`: set the mode back to `flat` (the same audited setting change). Engine-mode orders already placed keep their snapshots and stay reversible from them; new orders are priced by the percentage again. Historical orders are never recomputed or imported (§11 E).

### D5 — Reporting: the snapshot ledger is the tax report; no commerce tax family

Upstream's `tax.snapshot_activity` projection and `GET /api/v1/tax/reports/reconciliation` on the same reporting engine are the tax report: by rule version, by component, by treatment, netted per currency, with an integrity block. This **supersedes ADR-0035 D1's note that a tax slice would be commerce's own** for #293 — a second tax report derived from orders would be a second source of truth that can disagree with the ledger the law cares about. Commerce's own sales projections (ADR-0035) read the order's `tax` column, which in engine mode is the snapshot's figure, so they are unchanged; the new cancel/return reversals take the tax back out of the ledger, not out of those projections (see Consequences).

### D6 — Regulatory neutrality; an Indonesia applicability note

The core stays jurisdiction-neutral (`awcms` ADR-0127; ADR-0024: nothing country-specific ships in the template). **Indonesia applicability:** a PPN rate, a regulation change (a PMK) or a category's treatment is expressed as a **new effective-dated rule version authored by the merchant or their tax adviser** and published through `/admin/tax` (a separately granted permission), never as code. Nothing in this change asserts a rate: the cut-over copies whatever percentage the merchant already configured. Coretax / e-Faktur export and VAT-invoice numbering are out of scope here and are an upstream follow-up of `awcms` ADR-0127.

### D7 — Module descriptor, permissions

`commerce` declares `tax` in `dependencies` (`modules:dag:check`; `tax` never depends on commerce). No new permission: reading the mode and editing a product's category reuse `commerce.settings.read` and `commerce.products.update`; the cut-over CLI is an operator action with no HTTP surface; the tax screens and API keep their own `tax.*` permissions. A tenant created before `sql/173` ran needs `bun run identity-access:permissions:backfill` once so its `owner` role holds the `tax.*` permissions (the runbook carries the step); the commerce paths themselves call the tax module in process and are not gated by them. Because `module_management` keeps an enabled module's dependencies satisfied, a tenant that had explicitly disabled `tax` cannot re-enable `commerce` until it enables `tax`, and `tax` cannot be disabled while `commerce` is active. A tenant with no `awcms_tenant_modules` row for `tax` (the default) is unaffected, and behaviour is still governed by the per-tenant mode, so a tenant that never cuts over never calls `tax`.

### D8 — Admin UI

The product form gains a `Tax category` field (create and edit; blank = standard). Store settings shows the mode as a read-only badge with a link to `/admin/tax`. The additions are two inputs and one payload key in an existing script — no new client asset.

## Options considered

- **Keep the flat percentage — rejected.** It cannot express a dated rate change, an exemption, inclusive prices or a refund that mirrors the sale, and every future need would grow the same single number.
- **Hard-code Indonesian PPN in commerce — rejected.** The core is jurisdiction-neutral (`awcms` ADR-0127) and the template carries nothing country-specific (ADR-0024); a rate in code is a release for every rate change and asserts a legal position the merchant owns.
- **A commerce-side snapshot table — rejected.** The module already owns the immutable ledger, the reversal arithmetic and the reconciliation report; copying them would fork the one source of truth.
- **Per-tenant mode over the upstream engine — chosen** (D1).
- **Mode as a settings-blob field flippable through `PUT` — rejected** (D1): a flip without the parity check is the failure §11 F exists to prevent.

## Consequences

- Flat tenants see no change: the same arithmetic, one extra one-row read per quote, no snapshot.
- An engine-mode tenant has one snapshot per order and a reversal per return, cancellation or expiry; the tax ledger and the commerce `tax` columns are two views of the same figures.
- **Known gap, unchanged by this ADR:** ADR-0033's `refund_total` is goods less discount plus shipping and a `CHECK` pins it, so a return does **not** refund the tax to the customer; engine mode reverses it in the _tax ledger_ (the liability), and an operator who wants the customer repaid still does it as today. Changing the refund arithmetic would touch the returns schema (`994`), which this migration may not depend on (the migration-numbering ADR (0037) D2); it is a follow-up.
- Engine-mode order documents (receipt, invoice, quotation) copy the order's `tax` as before. Under inclusive pricing the "Tax" row reads as the tax contained in the total.
- A rule version cannot be published before the server's UTC date; `effectiveFrom` is therefore the cut-over day, and the store-time business date (`Asia/Jakarta`, never behind UTC) always falls on or after it.
- The settings screen can no longer change what tax a tenant pays once in engine mode (`payment.tax` is ignored); that is the point, and the badge says so.
- Two new unit suites and one integration suite carry the proof (parity, categories, inclusive pricing, cut-over, single snapshot per order, history immutability, reversals, RLS).

## Security & privacy

- **Money is server-authoritative.** No client field reaches the tax figure; the quote, the order and the snapshot come from one calculator and a mismatch aborts the order.
- **No personal data enters the tax module.** A snapshot is keyed by the order id and carries line refs (order item ids), codes and decimal strings; audit attributes and events carry ids and totals only.
- **Tenant isolation.** The new columns sit on tables that are already `FORCE ROW LEVEL SECURITY`; the order's FK to a snapshot is composite on `(tenant_id, id)`, so an order cannot cite another tenant's snapshot (tested).
- **Privilege.** The mode and the version are written only by an audited operator tool (no HTTP route); the worker's new grant on the ledger is `INSERT` plus a lock-only `UPDATE`, with the append-only trigger intact.
- **Retention.** Snapshots keep their 1826-day floor; `ON DELETE SET NULL (tax_snapshot_id)` lets retention proceed without touching the order.

## Rollback

`bun run commerce:tax:cutover --rollback --commit` (per tenant, audited) sets the mode to `flat`. Nothing else needs undoing: engine-mode orders keep their snapshots and reversals, the published version stays (immutable) and a later cut-over reuses it. Reverting the code leaves the three nullable/defaulted columns in place and unused.
