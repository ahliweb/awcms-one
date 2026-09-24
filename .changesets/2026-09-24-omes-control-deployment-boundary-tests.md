---
bump: minor
type: content
impact: internal
---

# Test awcms-one's deployment/migration boundary around the synchronized `omes_control` module

Issue #210 pulled upstream's `omes_control` domain module into `apps/cms`
(`sql/154`-`sql/158`, `awcms`'s own ADR-0122). Upstream already tests that module's own unit
and application semantics; issue #212 adds the AWCMS-One-specific integration
boundary around it — deployment/migration shape this repo owns, not a re-test
of upstream's own coverage, and no OMES/Hermes runtime-execution behaviour
(issue #146 moved that ownership to `ahliweb/omes` on purpose).

- `apps/cms/tests/integration/omes-control-deployment-boundary.integration.test.ts`
  (12 tests, real PostgreSQL): `154`-`158` and the full commerce `901`-`934`
  range apply to one clean database with no numeric-prefix collision and a
  migration ledger that matches the files on disk (ADR-0015's reserved-range
  rule); `awcms_setup`/`awcms_app`/`awcms_worker` are three distinct roles on
  a migrated cluster, matching `compose.production.yaml`'s three DSNs; all
  eight `omes_control` tables carry RLS both `ENABLE`d and `FORCE`d;
  cross-tenant reads/writes on `omes_control` data fail closed; a freshly
  migrated tenant holds zero `omes_control` role-permission grants
  (default-deny survives deployment); existing commerce RLS/tenant isolation
  stays green alongside the new module; and, as the required **negative
  test**, deliberately re-granting `awcms_worker` the exact `INSERT`/`UPDATE`
  privileges `sql/156` revoked is caught by the least-privilege assertion
  (with an over-grant message naming the table and both verbs), then reverted
  and re-verified passing.
- `apps/cms/tests/omes-control-execution-boundary.test.ts` (DB-free, 2 tests):
  no source file under `src/modules/omes-control/` or
  `src/pages/api/v1/omes/` imports `child_process`/`ssh2`, calls
  `Bun.spawn`, or calls a raw `exec`/`execSync` — the module stays a
  tenant-scoped control-plane record store, never a shell/SSH executor.
- Both suites run in the existing DB-backed `check-cms` CI leg (`apps/cms`'s
  own `bun test tests/integration/` step and its plain `bun test`
  respectively) — no second migration/test pipeline was added, and root
  `bun test` remains PostgreSQL-free.
- `docs/pengujian.md`/`.id.md` document the new coverage under `check-cms`'s
  section.
