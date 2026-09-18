🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0015-commerce-migrations-live-in-the-reserved-9xx-range.id.md)

# ADR-0015 — Commerce migrations live in the reserved `9xx` range

- **Status:** Accepted
- **Date:** 18 September 2026
- **Decision maker:** ahliweb
- **Related:** [ADR-0001](0001-git-subtree-with-full-history-for-apps-cms.md), [ADR-0008](0008-one-commerce-module-carries-the-whole-store-not-three.md); issue #72

## Context

`apps/cms` is `ahliweb/awcms` embedded whole via `git subtree` (ADR-0001). This repo's own `commerce` module (ADR-0008, issue #4) added sixteen migrations in `apps/cms/sql/`, numbered 153 (`awcms_commerce_schema`) through 168 (`awcms_commerce_orders_expire_worker_write_grants`), inside upstream's own `001`-`899` numbering — the only range that existed at the time.

Upstream has since added its own `sql/153_awcms_blog_institution_logo.sql` (issue #59, upstream `ahliweb/awcms#806`/`#807`), and will keep adding `154`, `155`, … as its own development continues. `apps/cms/scripts/db-migrate.ts` — an upstream file this repo never edits locally — applies every `sql/*.sql` file in lexical order and keys applied rows in `awcms_schema_migrations` by the full filename; it requires the pattern `^\d{3}_awcms_[a-z0-9_]+\.sql$`, three digits, and refuses any file name outside it. Two files can share the same three-digit prefix (the runner does not require it to be unique across the whole directory), but that only postpones the real problem: this repo's own sixteen commerce migrations sit exactly where upstream's own future migrations are going to land next, forever, for as long as both count from `001`.

## Decision

Renumber the sixteen commerce migrations into a reserved `901`-`916` range — offset **+748** from their original numbers (`153`→`901`, `154`→`902`, … `168`→`916`) — a range upstream's own `001`-`899` numbering will never reach. Every future commerce migration continues at `917`, `918`, and so on. `apps/cms/tests/commerce-migrations-range.test.ts` (new, issue #72) asserts every `*_awcms_commerce_*.sql` file has a prefix in `900`-`999` and every other file has a prefix below `900`, so the rule stays true after every future `git subtree pull` without anyone having to remember it.

### Options considered

| Option | Why not (or why chosen) |
| --- | --- |
| **Renumber to `901`-`916`** (chosen) | A pure rename, no upstream file touched. `apps/cms/scripts/db-migrate.ts`'s existing three-digit pattern (`^\d{3}_awcms_[a-z0-9_]+\.sql$`) already accepts it unmodified — nothing about the runner changes. |
| Widen the pattern to four digits | Requires editing `MIGRATION_FILE_PATTERN` inside `apps/cms/scripts/db-migrate.ts` itself — an upstream file this repo does not patch locally (see "What is, and is not, this repo's to edit" in the root `AGENTS.md`). Every future `git subtree pull` would then have to re-apply that patch, and a merge conflict there is exactly the kind of silent, easy-to-resolve-wrong hazard this repo's subtree discipline exists to avoid. |
| Keep the numbers, document the lexical tie-break | `db-migrate.ts` applies files in `localeCompare` order and does not care that two files share a prefix, so this would technically still run — but it commits this repo to permanent, growing collisions with upstream's own numbering, checked by nothing, noticed only when a human happens to read both file names side by side. A rule that depends on a human noticing is not a rule. |
| A separate `sql/commerce/` directory | `discoverMigrationFiles()` reads exactly one flat directory (`path.resolve(process.cwd(), "sql")`) — moving commerce's migrations out of it means either editing `db-migrate.ts` to read a second directory (the same upstream-edit problem as widening the pattern) or flattening two directories into one migration stream by some other mechanism nothing here defines. Same rejection as widening the pattern, for the same reason. |

## Consequences

- A future commerce migration is the next free number in `9xx` — `917` today — chosen from a range upstream cannot collide with, ever, without also renumbering by hand into three digits (which would itself now violate `commerce-migrations-range.test.ts`).
- A database that has **never** run `db:migrate` needs nothing extra: it simply applies the sixteen files under their new `901`-`916` names, in order, like any other migration.
- A database that **already ran** `db:migrate` against the old `153`-`168` names has those sixteen old filenames recorded in `awcms_schema_migrations`. Before that database's next `db:migrate`, its operator runs `bun run db:commerce:renumber` once (`apps/cms/scripts/commerce-migrations-renumber.ts`, issue #72) — a one-off, transactional, idempotent script that updates each of the sixteen rows' `migration_name` to its new filename and recomputes its `checksum` from the file now on disk. Without this step, `db-migrate.ts` would see sixteen "new" files under their `9xx` names and try to re-apply already-applied schema changes.
- No production PostgreSQL exists yet for this repo (see the root `AGENTS.md`'s "What is here today, and what is not"), so this ADR's compatibility path is exercised by `commerce-migrations-renumber.test.ts`'s pure `planRenames` tests today, not by an operator yet — but the step is documented in [`docs/deployment.md`](../deployment.md) and [`docs/skema-basis-data.md`](../skema-basis-data.md) for the day one does.
