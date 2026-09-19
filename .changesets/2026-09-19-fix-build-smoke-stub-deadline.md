---
bump: patch
type: fix
impact: internal
---

# Build-smoke tests wait 20 s, not 5 s, for the stub CMS to boot

Sixteen storefront build-smoke tests each spawn `apps/storefront/scripts/stub-awcms.mjs` and waited a hard-coded five seconds for its first answer. The stub now loads a dozen fixtures and state machines and the root `bun test` runs those builds concurrently, so a cold start on a two-core CI runner regularly crossed the line and a green change failed CI on a timing accident — four reruns in two days.

- One shared constant, `apps/storefront/tests/stub-deadline.ts` (`STUB_START_DEADLINE_MS = 20_000`), replaces every literal; a stub that truly cannot start still fails inside the test's own budget.
