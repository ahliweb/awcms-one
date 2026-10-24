---
bump: patch
type: dependency
impact: internal
---

# launch-editor 2.14.2 clears a high-severity advisory

`launch-editor` 2.14.1, which `@changesets/cli` pulls in for `apps/cms`'s release tooling, matched three new advisories: GHSA-587h-7wmj-h5pm (high), GHSA-r825-w8mm-5pxw and GHSA-698v-4r3x-3vcv. `apps/cms`'s `deps:audit:check` refuses an unhandled high-severity advisory, so `local-ci/check-cms` was red on `main` and on every branch. 2.14.2 is inside the existing `^2.14.1` range, so only `bun.lock` moves, regenerated with `bun update launch-editor`, and no exception entry is needed.

- `bun audit` reports no vulnerabilities, and `deps:audit:check` passes with zero registered exceptions.
