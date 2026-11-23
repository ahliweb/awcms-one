---
bump: minor
type: fix
impact: internal
---

# A hung local-CI step now times out instead of hanging the run

`tools/ci/lib/exec.ts` ran every step with no wall-clock limit, so one step that never ended (a container that never became healthy, a browser that never exited) hung `bun run ci` / `ci:pr` forever, held the run lock and left no status posted. The `check-cms` leg, the longest, was the most exposed.

- `run()` takes an optional `timeoutMs`. On expiry the step's whole process group (it now leads its own group) gets `SIGTERM`, then `SIGKILL` after a grace period, and the result carries `timedOut`. A step with no budget behaves exactly as before.
- Every runner passes a generous budget per step (for example 60 minutes each for `apps/cms`'s `bun run check` and its integration suite) and fails the leg with `<step> timed out after N s`. The leg still returns an outcome, so the `local-ci/*` failure status is posted, the lock is released and `check-cms` removes its container.
- `LOCAL_CI_TIMEOUT_SCALE` multiplies every default for slow machines; it is documented in the root `.env.example`, and an invalid value is refused rather than read as "no limit".
- The gitleaks step checks `timedOut` first: its exit code 124 would otherwise have been read as "no leaks" under its 0/1/2 convention.
