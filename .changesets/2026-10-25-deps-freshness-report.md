---
bump: minor
type: dependency
impact: internal
---

# `bun run deps:freshness`: a read-only, root-owned dependency freshness report

Issue #471. `apps/cms` already has upstream's `deps:freshness` (ahliweb/awcms #1181) but it only sees `apps/cms`; nothing watched the rest of this workspace, the Bun pin, or the images this repository builds and tests with. `bun run deps:freshness` (`tools/deps-freshness.ts`, pure logic in `tools/lib/deps-freshness.ts`) reports, in upstream's output shape:

- direct dependencies of the root `package.json`, `apps/storefront` and `packages/*` (`bun outdated`; never `apps/cms`), each with a disposition — `candidate`, `held` or `needs-decision`;
- the root `overrides` against the version `bun.lock` resolved;
- advisories (`bun audit --json`, the same blocking rule as the audit gates);
- the Bun pin against the latest Bun release (GitHub first, npm as fallback) and against the storefront Dockerfile's `ARG BUN_VERSION`;
- every container image in the storefront and backup Dockerfiles, the compose files and the local-ci tool images (`postgres:18.4`, the digest-pinned gitleaks, whose tag is recovered from the registry), and floating tags;
- a held-back register, `tools/deps-held-back.json` (owner, reason, review date), seeded with TypeScript 7 (outside `@astrojs/check`'s peer range).

It is advisory: read-only, registry lookups are `GET`s with a timeout, an unreachable registry makes that section `UNKNOWN` (never a pass, never a failure), and the exit code is 0 unless `--strict` is passed. It is deliberately not part of `check` or of any `local-ci/*` leg, so there is no 13th required context and branch protection is unchanged. The register is validated offline by the root `bun test`, and an entry past its `reviewDate` fails it.

- `docs/alur-kerja-pengembangan(.id).md` "Dependency updates" gains the report, the register and the staged upgrade gates (upstream first, one atomic PR, all three build profiles, pinned images and rollback).
- `tests/deps-freshness.test.mjs` pins the parsers and the policy with fixtures under `tests/fixtures/deps-freshness/`; no test touches the network.
