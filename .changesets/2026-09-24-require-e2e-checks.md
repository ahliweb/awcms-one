---
bump: minor
type: structure
impact: internal
---

# Promote the Playwright e2e matrix to required status checks

`.github/workflows/e2e.yml` (issue #183) was introduced on a deliberate
probation period: a real-browser suite carries a different flake risk than
a type-check or unit test, so it started as advisory only, pending a
proven, deterministic run history.

That bar is now met. Issue #215 reviewed the post-introduction run history
(`gh run list --workflow e2e.yml`) and found at least seven consecutive
green runs across #197/#202/#203/#204/#207/#208/#209, with no observed e2e
failure in any run since the workflow was introduced. The exact
`e2e (toko)`/`e2e (berita)`/`e2e (landing)` contexts were verified against
a real PR's checks (`gh pr checks`, `gh api .../check-runs`) rather than
inferred from the workflow file, and all three are now added to `main`'s
branch protection **additively** — every previously required check
(`check-cms`, the three `Check (*)` legs, and the four
`template-init-smoke` legs) is preserved, and `enforce_admins` stays on.

- `main`'s required status checks go from eight contexts to eleven.
- A pending or failing `e2e (toko)`/`e2e (berita)`/`e2e (landing)` leg now
  blocks a PR merge, the same as any other required check.
- No test scope, assertion, or screenshot behaviour changed — this is a
  branch-protection and documentation change only.
- `.github/workflows/e2e.yml`'s own comment, `AGENTS.md`, `README.md`,
  `docs/status.md`, and `docs/alur-kerja-pengembangan.md`/`docs/pengujian.md`
  (plus their Indonesian mirrors) no longer describe this workflow as
  optional.
