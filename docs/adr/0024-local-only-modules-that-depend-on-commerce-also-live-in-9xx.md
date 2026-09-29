🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0024-local-only-modules-that-depend-on-commerce-also-live-in-9xx.id.md)

# ADR-0024 — Local-only modules that depend on `commerce` also live in `9xx`

- **Status:** Accepted
- **Date:** 29 September 2026
- **Decision maker:** ahliweb
- **Related:** [ADR-0015](0015-commerce-migrations-live-in-the-reserved-9xx-range.md), [ADR-0016](0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md); issue #270

## Context

ADR-0015 reserved `sql/900`-`999` so this repo's own additions to the `git subtree`-embedded `apps/cms` (ADR-0015's own `ADR-0001`) never collide with upstream `ahliweb/awcms`'s independently growing `001`-`899` numbering. It phrased the rule around `commerce` specifically, because at the time `commerce` was the only migration set this repo had ever added that upstream does not carry — `apps/cms/tests/commerce-migrations-range.test.ts` accordingly keys "is this migration exempt from the `< 900` rule" on whether the migration's filename `area` starts with `commerce`.

Issue #270 (IRMbyDUS) adds `practice_irm` — a second module that exists **only** in `awcms-one`, never in upstream `awcms`, for the same reason `commerce` does (a business-domain module built for this deployment, not part of the generic template). Its `awcms_practice_irm_sessions` table has a real, structural foreign key into `awcms_commerce_customers`/`awcms_commerce_products` — `owner_customer_id` records who owns a practice session, `product_id` records which purchased entitlement unlocked it — so its own migration cannot be numbered below `commerce`'s: `apps/cms/scripts/db-migrate.ts` applies every `sql/*.sql` file in lexical filename order, and a migration numbered under `900` runs before every `9xx` commerce migration exists, including the ones that create the two tables `practice_irm`'s own migration references. Measured directly: numbering `practice_irm`'s schema migration in the `1xx` range (attempted first) fails `db:migrate` from a fresh database with `relation "awcms_commerce_customers" does not exist` — not a style violation, a real ordering bug.

`commerce-migrations-range.test.ts`'s existing rule — every non-`commerce`-prefixed migration stays below `900` — cannot be satisfied by a module that both (a) is local-only, exactly like `commerce`, and (b) has a hard FK dependency on `commerce`'s own tables, which by construction only exist at `9xx`.

## Decision

`practice_irm`'s four migrations (`awcms_practice_irm_domains_schema`, `awcms_practice_irm_sessions_schema`, `awcms_practice_irm_permissions`, `awcms_practice_irm_worker_grants`) live in the reserved `9xx` range too, immediately after `commerce`'s own migrations (`940`-`943` today, following `commerce`'s own numbers through `939`). `commerce-migrations-range.test.ts`'s single `isCommerce` boolean becomes a small, explicit, reasoned allowlist of LOCAL-ONLY area prefixes (`commerce`, `practice_irm`) that may use `9xx` — every area not on the list still must stay below `900`, so the rule keeps catching a genuine upstream-collision mistake exactly as before.

This is a narrow amendment, not a re-litigation: it does not touch how `commerce`'s own numbers are assigned, and it does not open `9xx` to every future module — only to one this ADR names, for the two reasons above (local-only AND structurally FK-dependent on an existing `9xx` table). A future module that is local-only but has NO dependency on `commerce`'s tables has no ordering reason to leave the `< 900` range, and should not be added to this allowlist without its own justification.

### Options considered

| Option | Why not (or why chosen) |
| --- | --- |
| **Extend the `9xx` allowlist to `practice_irm`** (chosen) | Solves the actual ordering bug with the smallest, most legible change — one more reasoned entry in an already-established list, following the exact precedent ADR-0015 itself set. |
| Number `practice_irm` below 900, drop the FK, validate the reference at the application layer only | Loses real referential integrity (an orphaned session row pointing at a deleted customer/product becomes possible) for a problem that is purely about migration ORDERING, not about whether the constraint is desirable. `sql/169`'s own header already argues for the FK; giving it up to dodge a numbering rule would be solving the wrong problem. |
| Rename `practice_irm`'s tables/migrations to a `commerce_practice_irm_*` shape so the existing `commerce`-prefix rule accepts them unmodified | Misattributes ownership everywhere else a table-name prefix is read as an ownership signal (this repo has no shortage of such gates) — `practice_irm` is its own module, with its own `module.ts`, permissions, and admin screen; the migration's numbering convenience should not leak into the table's identity. |
| Widen `commerce-migrations-range.test.ts` to accept ANY area in `9xx`, dropping the allowlist entirely | Reopens exactly the upstream-collision hazard ADR-0015 exists to close — a future non-local-only migration (one that DOES exist upstream) could land in `9xx` by accident and nothing would catch it. The allowlist is small on purpose: every entry has to argue for itself. |

## Consequences

- `sql/940`-`943` are `practice_irm`'s, immediately after `commerce`'s existing `900`-`939`. A future `commerce` migration still continues at the next free number in the shared `9xx` pool (today, `944`) — the two modules share ONE reserved range, not two separate sub-ranges, since nothing about ADR-0015's collision-avoidance reasoning is per-module.
- A future local-only module that also needs a hard FK into `commerce` (or into `practice_irm`, or into any other `9xx`-numbered table) follows the same path: add its own reasoned entry to the allowlist in `commerce-migrations-range.test.ts`, in a change that (like this one) explains why leaving `9xx` genuinely is not survivable — not leaving it open as a general escape hatch.
- `apps/cms/tests/commerce-migrations-range.test.ts`'s docblock and title stay accurate in spirit (`the reserved 9xx range` is broader than only `commerce` now) but the file itself is not renamed — the smallest change that fixes the real bug, matching this ADR's own "narrow amendment" framing.
