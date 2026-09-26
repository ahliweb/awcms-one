---
bump: patch
type: fix
impact: internal
---

# Local CI runs every leg with `CI=true`, as GitHub Actions did

GitHub Actions set `CI=true` for every step, and both Playwright configs key
their CI behaviour off it. Without it, the local e2e legs silently ran
without `forbidOnly` (a stray `test.only` would have skipped the rest of the
suite and still passed), without the one retry for a flaky
`Page.captureScreenshot` protocol error, and without the HTML report the leg
keeps as evidence. `tools/ci/lib/orchestrate.ts` now sets it once, after the
Bun pin check, for every leg.
