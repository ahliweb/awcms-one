🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0031-expenses-are-commerce-local-register-linked-petty-cash.id.md)

# ADR-0031 — Expenses are commerce-local, register-linked petty cash, not a ledger: a posted expense appends a register movement and never edits a cash-up

- **Status:** Accepted
- **Date:** 3 October 2026
- **Decision maker:** ahliweb
- **Related:** [ADR-0028](0028-pos-register-sessions-and-cash-up.md) (the register this plugs into; **D10 and the "Deferred" expenses item are resolved here**); [ADR-0025](0025-payments-are-an-allocation-ledger-separate-from-order-status.md) (the resource-split permission reasoning, the append-only ledger style); [ADR-0003](0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md) (money); [ADR-0015](0015-commerce-migrations-live-in-the-reserved-9xx-range.md) (migration range); [ADR-0016](0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) (customers stay outside the profile vocabulary); issue [#294](https://github.com/ahliweb/awcms-one/issues/294) under epic [#281](https://github.com/ahliweb/awcms-one/issues/281), and the epic's governance PR [#298](https://github.com/ahliweb/awcms-one/pull/298).

## Context

A till owner pays for ice, a courier tip or a gas refill out of the drawer all day, and ADR-0028 already lets the drawer record such a payment as a free-text `expense` movement. That answers "does the drawer hold what it should?" but not the questions an owner asks next: what did we spend on what, who authorised the big ones, where is the receipt, and can a mistake be undone without rewriting a closed shift? Issue #294 asks for that, with a deliberate fence around it: *"No pretending that this issue is a complete general ledger/AP system"*, and a mandatory ownership decision before any code — commerce-local petty cash, or a generic finance/expense domain upstream in `ahliweb/awcms`.

## Decision

### D1 — Ownership: a commerce-local, register-linked petty-cash model, explicitly NOT a ledger

This is classified as **commerce-local, register-linked petty cash and operational expenses**. It lives in the `commerce` module, its schema is two tables (`awcms_commerce_expense_categories`, `awcms_commerce_expenses`) plus one typed column on the register movements it produces, and its only integration with the rest of the platform is the POS register (#284). It is not a general ledger, accounts payable, a vendor master, a budget, a tax model or a chart of accounts: there are no accounts, no journal lines, no due dates, no multi-currency.

Why commerce-local and not upstream, now:

- **The only cash source in this repo today is the POS register.** Every consumer that exists wants "an expense that moves a drawer". A generic finance domain built for one consumer is a guess about the second.
- **A generic finance domain does not exist upstream.** `ahliweb/awcms` has no finance module; building one means designing accounts, periods, posting rules and tax inside a subtree this repo does not own, and a sync conflict surface the size of a ledger. The issue's own rule - "prefer upstream when the model becomes broader than register cash movements" - is the tripwire, and the model here deliberately never crosses it.
- **The boundary is kept narrow so it can be absorbed.** The three nouns are the whole surface: *expense category*, *expense record*, *posting → register movement*. A future upstream finance module would own accounts and journals; this model then becomes an adapter - each posted or reversed expense is one balanced journal entry whose cash leg is already identified by `awcms_commerce_register_movements.expense_id`. Nothing here is shaped around a particular accounting convention that the adapter would have to undo.

Alternatives weighed:

| | A. Commerce-local petty cash (chosen) | B. Generic expense/finance module upstream first | C. Keep free-text `expense` movements only (status quo) | D. A real ledger / AP in this repo |
| --- | --- | --- | --- | --- |
| **Advantages** | Ships on the one consumer that exists; tiny schema; reuses the register's locks, audit and cash-up; absorbable later through an adapter | Right long-term home for accounting; one model for every vertical | Zero new surface | Would answer every finance question |
| **Disadvantages** | A second place to look if finance later arrives; its categories are not a chart of accounts | Blocks #294 on an upstream design with no second consumer; large subtree divergence risk; slow | No categories, no approval, no receipt, no reversal; a cashier can book any amount unreviewed | Months of scope; accounting rules guessed; contradicts the issue's explicit non-goal |
| **Security** | Approval threshold, SoD, private receipts, FORCE RLS, composite FKs - all enforced at the schema as well as the code | Same controls, but designed generically and later | The raw movement path has no approval at all (the gap D6 closes) | Largest attack surface; period-lock and posting integrity to get right from day one |
| **Performance** | Two small tables; one movement insert per drawer posting; indexed keyset reads | Unknown | None added | Journal volume and balancing checks on the hot path |
| **Maintainability** | Same module, same discipline as #284; one person can hold it in their head | Cross-repo contract and release coupling | Nothing to maintain, nothing gained | A product inside the product |
| **Scalability** | Row counts track shop activity; per-tenant RLS; retention windows declared | Scales as designed, if designed | Fine | Needs partitioning and archival from the start |
| **Accessibility / UX** | One screen, native `<dialog>` confirms, labelled forms, translated stacked tables | A generic finance UI the shop owner did not ask for | Drawer-only free text | Heavy back-office UI |
| **Compatibility** | Purely additive; feature OFF = today's store | Depends on upstream release | Compatible by doing nothing | Invasive |
| **Operational complexity** | One flag, one threshold, no new job | New module lifecycle, new roles, new upgrades | None | High |
| **Long-term** | Adapter path preserved | Best end state, reached too early | Dead end | Over-built for the question asked |

### D2 — Tables (`sql/990`–`sql/993`)

`awcms_commerce_expense_categories` (`code` unique per tenant case-insensitively, `name`, `active`) and `awcms_commerce_expenses` (category, `status`, `amount numeric(14,2) > 0`, `tender_type`, `occurred_on date`, `description`, optional `payee_name`, optional `register_session_id`, optional `receipt_media_object_id`, and the creator / submitter / decider / poster / reverser / canceller stamps with their timestamps and the approval threshold in force). Both are FORCE RLS with a `WITH CHECK`, use composite `(tenant_id, …)` foreign keys backed by `UNIQUE (tenant_id, id)`, keep staff as plain tenant-user uuid stamps (a fiscal record must outlive the account), index every foreign key, and lose `DELETE` for `awcms_app` (only the retention worker may delete, past the ten-year ceiling; `sql/993`). `deleted_at` exists only as the retention engine's cursor and is never set - an expense is reversed or cancelled, never deleted, and a register movement keeps a foreign key to it. `sql/991` adds `reference_kind = 'expense'` and `expense_id` to the append-only movements (resolving ADR-0028 D10), `sql/992` seeds the permissions.

### D3 — Lifecycle, enforced by a trigger as well as by the code

`draft → posted`, or `draft → pending_approval → posted | draft (rejected)`, then `posted → reversed`; `cancelled` is a discarded draft. `reversed` and `cancelled` are terminal. A trigger refuses an illegal move and freezes the content (category, amount, tender, date, reason, payee, drawer session) once the row leaves `draft`, so the approver decides exactly what was submitted and a posted expense is evidence; the posting facts of a posted row never change; a receipt may be attached to a posted or reversed expense once and never replaced. CHECK constraints state the shapes: a drawer expense is cash; a posted expense names who posted it, how it was approved and - when drawer-paid - its movement; **an approving decider is never the creator** (`approver_check`).

### D4 — Approval by tenant threshold and segregation of duties, not `workflow_approval`

The tenant setting `expenses.approvalThreshold` (default `"0.00"`: every expense needs a second person - strict by default, relaxed deliberately; read defensively, so a corrupt value can only make posting stricter). Within it, posting is outright (`auto`). Above it, only a poster who holds `commerce.expense_postings.approve` **and did not create the expense** posts it in one step (`approved`); anyone else leaves it `pending_approval`, and a pending expense is approved or rejected by someone who holds the approve key and is **neither its creator nor its submitter** (`403 SEGREGATION_OF_DUTIES`). A rejection needs a note and returns the expense to `draft`. `approve` is a high-risk verb, so a tenant may additionally author SoD rules against it. The decision is a pure function (`domain/expense.ts`'s `decidePosting`, `approvalSegregationViolation`) and is unit-tested exhaustively.

The brief asked to prefer `workflow_approval` through its public API. It was evaluated and **not used**, for reasons that are specific, not a preference: it exposes no capability port - a consumer reaches it through tenant-authored, versioned workflow definitions and a static, reviewed condition/action registry that is upstream's source (`workflow-approval/infrastructure/condition-action-registry.ts`), so wiring an `expense` resource type means editing upstream code this repo does not own; a tenant that never published a definition would have **no approval at all** (fail-open), where a threshold with a strict default is fail-closed; and a posting must be decided inside the same transaction as the register movement it writes, which an asynchronous instance engine cannot promise. ADR-0028's cash-up approval made the same call for the same reasons. If `workflow_approval` later grows a capability port, the threshold becomes the default routing rule rather than being replaced.

### D5 — The register integration: a movement, never a total; exactly once

Posting a drawer-paid expense appends **one** `expense` cash-out movement to the expense's session through `appendRegisterMovement` - the same writer the manual movement route uses (factored out of `recordRegisterMovement` for this), so the audit row and the `movement_recorded` event are identical. The cash-up's expected cash is `opening float + … + Σ movements in − Σ movements out` (ADR-0028 D2), so the expense is reflected in it exactly when, and only when, its movement exists; nothing here ever edits a cash-up total. "Exactly once" is mechanical, in three layers: the expense row is locked `FOR NO KEY UPDATE` first and a second posting is `409 EXPENSE_NOT_POSTABLE`; the movement's `source_key` is `expense:<id>:post`; and `sql/991`'s partial UNIQUE index allows at most one `out` and one `in` movement per expense. The session is locked `FOR SHARE` after the expense row (always in that order, so there is no cycle), so a close and a posting serialise and the movement lands in a session that is open at that very moment (`sql/970`'s trigger is the backstop).

**Reversal creates a compensating movement**: a `correction` cash-**in** of the same amount. It goes into the expense's session if that is still open, otherwise into the open session of **the same register**; with none open it is refused (`409 REGISTER_SESSION_REQUIRED`) rather than silently skipping the drawer - the cash is not back until a drawer can say so. A closed shift is never rewritten: its report is byte-identical before and after (proved in the integration suite). The movement's actor is whoever finalised the action (so an approver who posts a cashier's expense is the movement's actor), and the cashier-only rule of manual movements does not apply: the expense's own authorisation (D4, D9) stands in for it. The `reference` stamped on both movements is the system-generated `EXP-XXXXXXXX`, never the expense's free text.

### D6 — A raw `expense` movement is refused once the feature is on

If a cashier could still `POST …/movements` with `movementType: "expense"`, the threshold and SoD above would be decoration. So while the tenant's `expenses` feature is ON, that route answers `409 EXPENSE_REQUIRES_EXPENSE_RECORD` for the `expense` type (other types are untouched); with the feature OFF - the default - ADR-0028's behaviour is exactly as shipped.

### D7 — Receipts are private media objects behind their own permission

The receipt reuses the media library's `visibility = 'private'` class and presigned GET (PR #278), and adds nothing to the media library: the object is attached by id, resolved from the **expense** at read time, never from a caller-supplied id. Guards, each against a different misuse:

- attaching needs a verified `private` object **that the attacher uploaded** - otherwise `commerce.expense_receipts.create` would be a confused deputy that lets any private object whose id leaks (a product's protected PDF, a colleague's file) be attached and read back;
- one object serves **one** expense (a partial UNIQUE index), and an object that gates a product download is refused;
- `GET …/receipt-url` needs `commerce.expense_receipts.read`, which is **not** implied by `commerce.expenses.read` (a receipt can show a person's name or an account number) and not satisfied by `media_library.media.download`; it re-verifies on every call that the object is still a verified private object, fails closed (a public-by-mistake or soft-deleted object is never signed), audits every issuance decision that reaches a real object through the shared `media.download` writer, returns `Cache-Control: no-store`, and short-lives the URL by the media library's existing TTL bound;
- the expense body exposes only `hasReceipt`; the media id and object key never leave through it, and the CSV carries only that boolean.

**Employee scope.** An expense belongs to its creator: editing or discarding a draft, and attaching a receipt in any attachable state (draft, posted, reversed - otherwise anyone holding `receipts.create` could occupy a posted expense's single receipt slot), is allowed to the creator or a supervisor (a caller who also holds the approve key, resolved through the access chokepoint only when needed), never to another employee who merely holds `commerce.expenses.update` (`403 NOT_EXPENSE_OWNER`). Reading stays with `commerce.expenses.read`.

### D8 — Payee is free text; a typed party reference is a documented deferral

The brief prefers a canonical party/profile reference "if one exists in the commerce module". It does not: ADR-0016 deliberately keeps customers outside the profile vocabulary, and a vendor master is a non-goal. `payee_name` is therefore bounded free text (120 characters), treated like the reason: redacted from audit and events, never exported to a subject-data export. When a party model exists, the column gains a typed sibling in a later migration the same way ADR-0028 D10 did for the movement reference.

### D9 — Twelve resource-split permissions, existing verbs only

`commerce.expense_categories.{read,create,update}`, `commerce.expenses.{read,create,update,export}`, `commerce.expense_postings.{create,approve}`, `commerce.expense_reversals.approve`, `commerce.expense_receipts.{read,create}`. Only verbs already in the upstream-owned `AccessAction` union - **it is not widened** - and none is implied by `commerce.register_sessions.update` or `commerce.pos.create`: being allowed to move cash in a drawer grants no authority to book, approve or reverse an expense. `approve` (posting decisions, reversal) and `export` are high-risk verbs, so a tenant may author SoD rules against them. A real `evaluateAccess` test and route-level tests with principals seeded with exactly one key prove every denial.

### D10 — Idempotency, audit, events

Create, post, decide, reverse and cancel require `Idempotency-Key` (shared `awcms_idempotency_keys` store, hash bound to the actor and the resource; read **after** the row lock so a retry that waited replays deterministically). Audit actions `expense.create|update|cancel|submit|post|reject|reverse|receipt_attach` carry money, ids, the tender and the decision - never the description, payee, note or reversal reason (an integration test searches every audit row and event payload for them). Events `awcms.commerce.expense.{posted,reversed}` ride the `commerce.expense` aggregate and fire once, when the status actually changes; they are registered in `module.ts`, the event-type registry and AsyncAPI.

### D11 — Reporting and export

`GET …/expenses/summary?from&to` (read) returns posted and reversed totals by category and by tender, plus draft and pending counts, in exact cents; reversed expenses are reported beside posted ones, never netted away. `GET …/expenses/export.csv?from&to` (`commerce.expenses.export`) is formula-neutralised with the cash-up CSV's own helpers (not copies), bounded to 366 days and 10,000 rows with an explicit `X-Export-Truncated` header, and `no-store`. A drawer expense also appears in its shift's cash-up report as an ordinary movement - reconciliation needed no new report.

### D12 — The feature flag defaults OFF; compatibility is additive

`features.expenses` is the second flag that defaults OFF (after `register`): a tenant that never opens "Fitur" sees today's store. A drawer-paid expense additionally needs `features.register`. The settings document gains a top-level `expenses` object (no `schemaVersion` bump, same as `cashUp`). Existing rows, payloads, hashes and responses are unchanged.

### D13 — Retention and subject data

Both tables are five-year floor / ten-year ceiling `generic` hard-delete descriptors keyed on the never-set `deleted_at` (practically unreachable, like `commerce.orders`); the `subjectData` descriptors name the staff stamps as `tenant_user` columns retained under the fiscal obligation and mark `description`, `payee_name`, `decision_note` and `reversal_reason` redacted.

## Consequences

- Positive: an owner can see what was spent on what, who authorised it, and where the receipt is; a drawer expense reconciles to the cent through the cash-up that already exists; a creator cannot approve their own expense; a mistake is undone by a compensating row, never by rewriting a closed shift; the model can be absorbed by a future finance module through an adapter.
- Cost: a third lock-ordered write path on the register (expense → session); two tables and a column; a tenant that turns the feature on must define a category before anything can be recorded and, with the strict default, set a threshold or have a second approver - a deliberate trade for a single-owner shop that is documented on the screen; `appendRegisterMovement` is now shared code.
- Compatibility: purely additive. Feature OFF is today's store; the one behavioural change to ADR-0028 (D6) applies only with the feature ON.

## Deferred (not built here, on purpose)

A general ledger, accounts payable, vendors, taxes, budgets and multi-currency (non-goals); a typed payee/party reference (D8); more than one receipt per expense and an upload control on the expense screen (the receipt is attached by media object id, uploaded through the media upload-session API with `visibility: "private"`); recurring expenses; expenses paid from a drawer that belongs to no register session (paid from the safe is recorded as a non-drawer expense); a per-category or per-register approval threshold; an `expense` projection for the dashboard (the summary is a live aggregate over indexed tables); routing the threshold through `workflow_approval` should it ever grow a capability port.
