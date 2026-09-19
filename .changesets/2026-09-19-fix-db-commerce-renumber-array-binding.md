---
bump: patch
type: fix
impact: internal
---

# `db:commerce:renumber` could not run: the name list was bound as a malformed array

The one-off script from #72 passed a plain JavaScript array into `= ANY(${…})`, which Bun.SQL serialises as a comma-joined string rather than a PostgreSQL array, so the very first query failed with `malformed array literal` on every database. It now binds through `sql.array(names, "text")`, the way `data-lifecycle`'s executor already does.

- Verified against the local development database: `--dry-run` lists sixteen renames, the real run renames them, a second run reports nothing to do, and `db:migrate` then skips all 169 migrations instead of re-applying `901`.
