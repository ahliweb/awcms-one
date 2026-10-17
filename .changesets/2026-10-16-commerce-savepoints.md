---
bump: patch
type: fix
impact: public
---

# Commerce statements whose errors are caught now run in savepoints

A failing statement aborts its PostgreSQL transaction; where a commerce handler caught the error (a duplicate register, barcode, expense-category, category, product, voucher, popup, flash-sale or attribute code answered as `409`/`400`, a customer or order-code collision retried, a bundle trigger refusal) and then let the transaction commit, the `COMMIT` was answered with `ROLLBACK`. Bun 1.4.2 hid that and silently dropped earlier writes of the same transaction; Bun 1.4.3 throws `ERR_POSTGRES_COMMIT_ROLLED_BACK`. Every such statement now runs through `inSavepoint` (`apps/cms/src/modules/commerce/application/savepoint.ts`), so only the savepoint rolls back. HTTP codes, rows and audit are unchanged on Bun 1.4.2. New regression test `commerce-caught-error-savepoints.integration.test.ts`; the rule is documented in the commerce README.
