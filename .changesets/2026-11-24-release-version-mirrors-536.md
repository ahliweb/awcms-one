---
bump: minor
type: structure
impact: internal
---

# The release step can rewrite declared version mirrors

An image built from a subfolder alone cannot read the root `package.json`, so a product version shown inside it needs its own copy, and a hand-edited copy drifts. `tools/rilis.mjs` now reads `tools/version-mirrors.json` (issue #536): each declared mirror is a file plus a regular expression with one capture group, and `--apply` rewrites the captured text to the new version after the root `package.json` bump, in the same release change.

- The template ships an empty list, so its release flow and output are unchanged.
- Every rewrite is planned in memory first, in the preview too. A missing file, a pattern that matches nothing or more than once, or a captured value that is not `X.Y.Z` refuses the release with the tree untouched.
- `tests/version-mirrors.test.mjs` fails when a declared mirror differs from the root version. The logic lives in `packages/gerbang/lib/version-mirrors.mjs`; see [`docs/rilis.md`](../docs/rilis.md).
