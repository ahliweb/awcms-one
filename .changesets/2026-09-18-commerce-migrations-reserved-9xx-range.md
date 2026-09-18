---
bump: minor
type: structure
impact: internal
---

# Commerce migrations renumbered into a reserved `9xx` range

`apps/cms/sql/*.sql` is one flat, lexically-ordered migration sequence owned by upstream `ahliweb/awcms`'s own `db-migrate.ts`. This repo's own `commerce` module originally numbered its sixteen migrations `153`–`168`, inside upstream's own `001`–`899` range — the only range that existed at the time. Upstream has since started adding its own migrations from `153` onward (`sql/153_awcms_blog_institution_logo.sql`, issue #59), and every future upstream `git subtree pull` will keep colliding with this repo's own commerce numbers.

The sixteen commerce migrations are renumbered to `901`–`916` (offset +748: `153`→`901`, … `168`→`916`), a range upstream cannot reach. Future commerce migrations continue at `917`. See [ADR-0015](../docs/adr/0015-commerce-migrations-live-in-the-reserved-9xx-range.md) for the options considered and rejected (widening the runner's pattern to four digits, keeping the numbers and documenting the tie-break, a separate `sql/commerce/` directory — all three would have required editing the upstream `db-migrate.ts` file this repo never patches locally).

- Every reference to the old `sql/153`–`sql/168` numbers across source, tests, OpenAPI, and documentation was updated to the new `sql/901`–`sql/916` numbers — except upstream's own `sql/153_awcms_blog_institution_logo.sql` and its references, which are untouched, and historical prose describing a specific past commit's diff, which stays historically accurate.
- A new `apps/cms/tests/commerce-migrations-range.test.ts` enforces the split (`9xx` for commerce, below `900` for everything else) so it stays true after every future `git subtree pull`.
- **Operator step:** a database that already ran `db:migrate` against the old file names must run `bun run db:commerce:renumber` once, from `apps/cms`, before its next `db:migrate` — a new, transactional, idempotent compatibility script (`apps/cms/scripts/commerce-migrations-renumber.ts`) that updates the sixteen already-applied rows' recorded names and checksums. No production PostgreSQL exists yet for this repo, so no database needs this today; a fresh database needs nothing at all, since it applies the new file names directly.
