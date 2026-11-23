---
bump: patch
type: dependency
impact: internal
---

# apps/cms synced from ahliweb/awcms main at 32863de8; picomatch GHSA-fc5q-39xc-vjpf mitigation removed

GitHub and OSV withdrew `GHSA-fc5q-39xc-vjpf` on 2026-11-18 (the maintainers: not a library vulnerability; the fix PR was closed unmerged and no release followed). `bun run deps:audit:check` in `apps/cms` then reported the exception as stale, which reddened `local-ci/check-cms` on every pull request. The owner decided (2026-11-19) to remove the mitigation entirely in all three repositories.

- Subtree sync, two upstream commits (ahliweb/awcms#1373, #1374), one merge commit: upstream deletes its `patches/picomatch@*.patch`, the `patchedDependencies` field, `picomatch-local-patch.test.ts` and the audit exception, and the `apps/cms` list is `[]` again.
- Root remnants removed in the same change: `patches/picomatch@4.0.7.patch` and `patches/picomatch@2.3.2.patch`, the root `patchedDependencies` (`package.json` and `bun.lock`), the root picomatch patch test, and the root audit exception (`tools/ci/dependency-audit-exceptions.json` is `[]`). Resolved `picomatch` versions are unchanged (the patch changed files, not versions).
- AGENTS.md, SECURITY.md and `docs/alur-kerja-pengembangan.md` (and their Indonesian counterparts) describe the real state: both exception lists empty, no local picomatch patch.
