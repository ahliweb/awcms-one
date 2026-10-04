---
"awcms": minor
---

feat(commerce): petty cash and register-linked expenses (Issue #294, epic #281)

New tables `awcms_commerce_expense_categories` and `awcms_commerce_expenses` (`sql/990` schema + lifecycle guard trigger + REVOKEs, `sql/991` the typed `expense_id` / `reference_kind = 'expense'` on `awcms_commerce_register_movements` with a partial unique index — at most one out and one in movement per expense, `sql/992` twelve permissions, `sql/993` worker purge grants). Commerce-local and explicitly not a ledger (ADR-0031).

A posted drawer-paid expense appends one `expense` cash-out register movement through the shared `appendRegisterMovement` writer (extracted from `recordRegisterMovement`; behaviour unchanged); a reversal appends a compensating `correction` cash-in to the same session if open, else the open session of the same register. Lock order is always expense row (`FOR NO KEY UPDATE`) then session (`FOR SHARE`); every mutation locks first and reads the idempotency store after. Approval is the tenant setting `expenses.approvalThreshold` (strict `0.00` default) with segregation of duties enforced in code and by an `approver_check` CHECK.

New endpoints (all behind the `expenses` feature flag, default OFF → `409 FEATURE_DISABLED`; a drawer expense also needs `register`; every mutation requires `Idempotency-Key` except the natural-idempotent draft `PATCH`, category writes and receipt attach):

- `GET`/`POST /api/v1/commerce/expense-categories`, `GET`/`PATCH .../expense-categories/{id}`
- `GET`/`POST /api/v1/commerce/expenses`, `GET`/`PATCH .../expenses/{id}` (draft edit; creator or supervisor)
- `POST .../expenses/{id}/post` (`commerce.expense_postings.create`), `/decision` (`.approve`), `/reverse` (`commerce.expense_reversals.approve`), `/cancel`
- `POST .../expenses/{id}/receipt` (`commerce.expense_receipts.create`; a verified private object the caller uploaded) and `GET .../receipt-url` (`commerce.expense_receipts.read`; presigned, `no-store`, audited as `media.download`, resolved server-side from the expense)
- `GET .../expenses/summary`, `GET .../expenses/export.csv` (`commerce.expenses.export`, formula-neutralised, bounded)

`POST .../register-sessions/{id}/movements` with `movementType: "expense"` now answers `409 EXPENSE_REQUIRES_EXPENSE_RECORD` while the tenant's `expenses` feature is on (feature off: unchanged). Events `awcms.commerce.expense.{posted,reversed}` on the `commerce.expense` aggregate (registered in `module.ts`, the event-type registry and AsyncAPI). `dataLifecycle`/`subjectData` descriptors for both tables (`domain/expense-lifecycle.ts`). Admin: `/admin/commerce-expenses`, a sidebar entry, a "Petty cash and expenses" toggle in the commerce Features section.
