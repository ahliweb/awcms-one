---
bump: patch
type: structure
impact: internal
---

# Weekly systemd timer for the dependency freshness report; the Bun-only manifest gate skips nested agent worktrees

- `tools/ci/systemd/awcms-one-deps-freshness.service` and `.timer` run `bun run deps:freshness -- --strict` every Monday at 06:00 on the trusted host (issue #471), writing the Markdown and JSON record to `~/.local/state/awcms-one-deps/`. A run that is not a clean all-clear leaves the unit failed, which is the weekly signal. An operator installs them like the `ci:watch` units; nothing is installed by this change.
- `tests/bun-only-deployment-manifests.test.mjs` no longer walks `.claude/worktrees/`, the gitignored git worktrees that agent tooling creates inside the checkout. Each is a full copy of the repository, so a local run with such worktrees present failed on upstream's own Dockerfile and compose services under the copies, while CI's fresh checkout stayed green.
