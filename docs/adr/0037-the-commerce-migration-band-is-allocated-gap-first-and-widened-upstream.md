🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0037-the-commerce-migration-band-is-allocated-gap-first-and-widened-upstream.id.md)

# ADR-0037 — The commerce migration band is allocated gap-first, and widened upstream

- **Status:** Accepted
- **Date:** 5 October 2026
- **Decision maker:** ahliweb
- **Related:** [ADR-0015](0015-commerce-migrations-live-in-the-reserved-9xx-range.md), [ADR-0024](0024-awcms-one-is-template-only-derived-apps-own-their-backend.md), [ADR-0035](0035-pos-operational-reports-are-commerce-projections-over-the-existing-ledgers-on-the-reporting-engine.md); issues #281, #282, #283, #290, #293

## Context

ADR-0015 gave this repo's `commerce` module the `900`–`999` band of `apps/cms/sql/`. The OSPOS epic (#281) used the top of it: `sql/998` and `sql/999` exist, and nothing above them can. The epic's last status note said the band was "full apart from 947–949 and 953–959". A scan of `main` on 5 October 2026 found more room than that. Twenty numbers have never been used on any branch: `900`, `944`, `947`–`949`, `953`–`959`, `968`, `969`, `977`–`979`, `983`, `984` and `989`.

Three open issues now need migrations, because upstream `ahliweb/awcms` v10.5.0 shipped the foundations they were waiting for:

- #282 is the commerce adapter over the inventory ledger.
- #293 is the commerce adapter over the tax module.
- #290 is bundles, and already holds `953`–`959`.

#283 (procurement) may need one more.

The number of free slots is not the binding constraint. **Order** is. `apps/cms/scripts/db-migrate.ts` (upstream, never edited here) applies every _unapplied_ file in lexical order. A file placed in a gap therefore runs at two different points in two different databases:

| Database                                 | When a new `948_…` runs                                  |
| ---------------------------------------- | -------------------------------------------------------- |
| Fresh (CI, a new derived app, a restore) | Before `949`–`999`, in its lexical place                 |
| Already migrated past `999`              | After `999`, because everything below it already applied |

A gap migration that references an object created by a higher-numbered file therefore works on every existing database and fails on every fresh one. It can also apply but behave differently, for example a `DO` block that tests for a table's existence. No free number sits above `989`. Anything that must reference the returns tables (`994`–`997`) or the operational-report tables (`998`, `999`) has no valid slot left.

## Decision

**D1. Allocate the gaps explicitly, by issue.** Recorded here and nowhere else:

| Number(s)           | Owner                                                       |
| ------------------- | ----------------------------------------------------------- |
| `947`               | #282 — commerce inventory adapter (used)                    |
| `948`               | #293 — commerce tax adapter (used)                          |
| `949`               | Unallocated pool (#283 needed no migration)                 |
| `953`–`955`         | #290 — bundles / item kits (used); `956`–`959` back to pool |
| `968`, `969`        | Unallocated pool                                            |
| `977`–`979`         | Unallocated pool                                            |
| `983`, `984`, `989` | Unallocated pool                                            |
| `900`, `944`        | Held back. Taken only with an amendment to this ADR         |

A later issue takes the lowest pool number that satisfies D2. It records the allocation by amending this table in the same change.

**D2. A gap migration may depend only on objects created by lower-numbered files.** That covers every table, column, function, type, role grant and permission row it references, including the ones a trigger or a `DO` block touches. Upstream's `001`–`899` and this repo's `880`–`899` band always sort lower, so they are always safe. The check that enforces this is the one that already runs: `local-ci/check-cms` migrates a **fresh** PostgreSQL 18 from `001` on every PR, so a forward reference fails CI rather than a deployment. A change that cannot satisfy D2 does not get a gap number. It waits for D3.

**D3. Widen the band upstream, not here.** The durable fix is for `db-migrate.ts` to accept a four-digit prefix and order files by the numeric value of their prefix. Once it does, this repo continues at `1000` with no renumbering. Every existing name is exactly three digits, and among names of equal width, numeric order is lexical order. The change is backwards compatible for upstream and for every derived application. It is proposed upstream as a generic runner improvement under upstream ADR-0024 D3, as [ahliweb/awcms#911](https://github.com/ahliweb/awcms/issues/911). It is **not** patched locally: ADR-0015 already rejected editing `db-migrate.ts` here, for the reason that still holds, namely a silent conflict on every future subtree pull. When the upstream change arrives through a normal sync, `apps/cms/tests/commerce-migrations-range.test.ts` is widened in that same sync to accept `900`–`9999`.

### Options considered

| Option                                                                                    | Assessment                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Gap-first allocation now, four-digit widening upstream** (chosen)                       | It unblocks #282, #283, #290 and #293 today. Each has been checked to depend only on `901`–`905` (catalog and orders), upstream `169`–`175` and the settings tables, never on `994`–`999`. Fresh-database CI enforces the ordering rule. The durable fix lands where the runner lives.                                                                                                             |
| Reuse a prefix (`999_awcms_commerce_z_…`), relying on the runner's within-prefix ordering | It works mechanically, because the runner does not require prefixes to be unique and the range test accepts it. But the order then depends on the alphabetical spelling of the rest of the name, which nobody reads as an ordering signal. ADR-0015 rejected exactly this "document the lexical tie-break" approach. Within our own band it is less dangerous, but it is just as opaque. Rejected. |
| Patch `MIGRATION_FILE_PATTERN` locally                                                    | A standing divergence on the one upstream file every deployment runs. Rejected by ADR-0015 and still rejected.                                                                                                                                                                                                                                                                                     |
| Renumber the existing commerce migrations to open space at the top                        | The checksums of applied migrations are immutable and every deployed database keys them by name. Every operator would need a ledger rename, the same cost as ADR-0015's one-off `db:commerce:renumber`, and it buys only a few dozen slots. Rejected.                                                                                                                                              |
| Fold several concerns into one migration file                                             | Still allowed, and encouraged, where the concerns ship in one PR. It reduces demand but does not remove the ordering constraint. A complement, not an alternative.                                                                                                                                                                                                                                 |

## Consequences

- #282, #293, #283 and #290 can take migrations without a further numbering decision. Their numbers are D1's.
- A migration that needs the returns or report tables (`994`–`999`) cannot be written until D3 lands. A follow-up that needs one, for example a returns report column, waits or is designed so the schema change does not reference those tables.
- On an existing database, gap migrations apply after `999`, in ascending gap order. Their effect is the same as on a fresh database precisely because D2 holds.
- `apps/cms/tests/commerce-migrations-range.test.ts` is unchanged by this ADR. It changes only in the sync that brings D3.

## Security, compliance and operations

There is no runtime change. The rule protects schema reproducibility: a backup restore into an empty cluster, followed by `db:migrate`, must reach the same schema an incrementally migrated cluster has. That reproducibility is an evidence point for business-continuity and change-management controls (ISO/IEC 22301 recovery, ISO/IEC 27001 Annex A 8.32 change management).
