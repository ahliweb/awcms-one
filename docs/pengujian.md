🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](pengujian.id.md)

# Testing

Three suites exist in this repository, each owned by a different workspace, with a different relationship to a live PostgreSQL. This document names all three, what each covers, and how to run the one that needs a database — it does not restate every individual test file.

## 1. Root gate suite (`bun test` from the repo root)

Needs no database, no build, and no network beyond `bun install`. Excludes `apps/cms/**` entirely via `bunfig.toml`'s `[test] pathIgnorePatterns` — a setting deliberately placed there rather than as a flag on the `test` script, because CI invokes `bun test` bare, and a flag on `bun run test` would silently not apply to that bare invocation (see `bunfig.toml`'s own comment, and `AGENTS.md`'s "Configuration and toolchain").

Measured at the time this document was written:

```
$ bun test
bun test v1.4.2 (744846f84)
 154 pass
 0 fail
Ran 154 tests across 14 files. [2.20s]
```

This count moves as gates and documents are added — re-run `bun test` rather than trusting the number above as anything but a snapshot. It covers this repository's own root-owned gates: the documentation audits, the knowledge-graph artefact checks, the changeset/release conventions, the toolchain-pin checks, and [`tests/kontrak-arah-impor.test.mjs`](../tests/kontrak-arah-impor.test.mjs) — the import-direction gate described in [ADR-0004](adr/0004-a-type-only-contract-package-with-an-import-direction-gate.md).

## 2. `apps/storefront`: type-check plus a build proof, no `bun test` suite of its own

`apps/storefront` has no `*.test.*` files today — `bun run check` (inside that workspace, `bun --bun astro check`) is a type-check, not a test run, and it is the step `apps/storefront/package.json`'s own `build` script runs before `astro build`. What proves the app actually builds a real site with no live `apps/cms` to reach is a **manual, two-terminal procedure**, not a wired-in CI step:

```bash
# terminal 1
bun scripts/stub-awcms.mjs
# terminal 2
AWCMS_API_URL=http://localhost:4310 AWCMS_API_TOKEN=stub-token \
  SITE_URL=http://localhost:4321 bun run build
```

[`apps/storefront/scripts/stub-awcms.mjs`](../apps/storefront/scripts/stub-awcms.mjs) serves the two commerce endpoints `apps/storefront/src/lib/catalog.ts` calls, reading its response bodies straight from [`tests/fixtures/awcms/{products,categories}.json`](../apps/storefront/tests/fixtures/awcms/) — fixtures shaped exactly like the real `{ items, nextCursor }` envelope `apps/cms`'s commerce routes actually return (see [`docs/api.md`](api.md)), not an invented shape. It is deliberately not wired into any `package.json` script or the production build: nothing under `scripts/` is imported by `astro.config.mjs`, `src/`, or `apps/storefront/server/penyaji.mjs`.

## 3. `apps/cms` (`bun run check:cms`): needs PostgreSQL, not re-run to write this document

`apps/cms` carries its own large gate chain — its `check` script runs roughly 55 gates (verified against `apps/cms/package.json`'s `check` script at the time of writing: 60 `&&`-joined steps in total, 54 of them named `<area>:check`, plus `lint`, `check:docs`, `check:docs:translation`, `typecheck`, `test`, and `build`) plus its own `bun test`, reported elsewhere in this codebase's own documentation at roughly 6,000 tests. **None of this was re-run to write this document** — it needs a live PostgreSQL this environment was not given, and re-running a ~6,000-test suite is a verification this documentation change does not claim to have performed. The procedure below is the one `apps/cms`'s own testing skill documents ([`apps/cms/.claude/skills/awcms-testing/SKILL.md`](../apps/cms/.claude/skills/awcms-testing/SKILL.md)), restated here because a reader of this repository's own docs should not have to go looking for it inside the embedded subtree.

### The isolated-database procedure

1. **A fresh, empty PostgreSQL database**, then `bun run db:migrate` (root: `bun run db:migrate:cms`) from empty — never against a database carrying another workspace's data.
2. **The migration/test harness needs a privileged database role, not `awcms_app`.** It runs `CREATE DATABASE`/`ALTER ROLE`, which the unprivileged application role cannot do by design (`permission denied to alter role`, PostgreSQL error `42501`) — that failure is not a skip and should not be misread as a regression.
3. **`.env`'s mere presence turns the DB-gated suite on.** Bun loads `.env` itself, so removing `DATABASE_URL` from the shell environment alone does not disable it; `.env` has to be moved aside to reproduce a run with no database configured.

### Roughly 240 failures are expected under the unprivileged app role, and none of them are commerce's

Running `apps/cms`'s DB-gated suites **as the unprivileged `awcms_app` role** (rather than the privileged role the harness itself needs) fails on the order of 240 upstream integration tests with `permission denied` / `alter role`-class errors — a pre-existing characteristic of `apps/cms`'s own test suite under that role, not something the `commerce` module introduces. `apps/cms/.claude/skills/awcms-testing/SKILL.md` documents the same class of failure and how to avoid triggering it (override `DATABASE_URL`/`SETUP_DATABASE_URL`/`WORKER_DATABASE_URL` to the same privileged connection string when running the harness). None of these ~240 failures were re-counted for this document — the figure is carried from prior verification during this platform's own development, not re-measured against a live database while writing this page.

## What each suite would need to answer "is commerce correct"

| Question | Suite |
| --- | --- |
| Does `product-status.ts`'s transition table behave correctly in isolation? | `apps/cms`'s `apps/cms/tests/commerce-domain.test.ts` (pure, no database) |
| Does RLS actually isolate `awcms_commerce_*` by tenant? | `apps/cms`'s generic RLS integration suite (needs PostgreSQL) — see [`docs/skema-basis-data.md`](skema-basis-data.md) |
| Does the storefront build a real site against the real API envelope? | The manual `stub-awcms.mjs` procedure above |
| Does `apps/cms` ever get imported the wrong way from `apps/storefront`/`packages/kontrak`? | Root `bun test` → `tests/kontrak-arah-impor.test.mjs` |
| Do this repository's own documentation and release conventions hold? | Root `bun test` plus the `audit:*` gates |

## Not built

A CI job that actually runs `apps/cms`'s DB-gated suite against a provisioned PostgreSQL — `check:cms` exists as a script but is not wired into `.github/workflows/ci.yml` today (see [`docs/deployment.md`](deployment.md) for why: increment 2's PostgreSQL provisioning has not happened). An automated build-and-serve smoke test for `apps/storefront` in CI — the `stub-awcms.mjs` procedure above is manual only.
