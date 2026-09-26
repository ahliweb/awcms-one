---
bump: minor
type: structure
impact: public
---

# Remove GitHub Actions; required contexts are now `local-ci/*` (#225 part 3, closes #225)

The owner's zero-GitHub-Actions decision (ADR-0021), started in part 1 (`tools/ci/`) and part 2 (`tools/release/`, ADR-0023), is now complete: every root workflow is deleted and GitHub Actions no longer executes anything in this repository.

- Removed `.github/workflows/{ci,codeql,e2e,images,release,template-init-smoke}.yml` and `.github/dependabot.yml` (its only ecosystem, `github-actions`, is now meaningless).
- Added `tests/tanpa-github-actions.test.mjs` — a root gate test that fails if a workflow file ever exists again under root `.github/workflows/`, and explicitly excludes `apps/cms/.github/**` (upstream's own subtree files, inert here since GitHub only reads a repository's own root `.github/workflows/`). Subsumes issue #224's workflow-guardrail requirement.
- Fixed every test/tool that read a now-deleted workflow file: `tests/versi-toolchain.test.mjs` now checks `tools/ci/lib/orchestrate.ts`'s Bun-pin enforcement instead of a `bun-version:` line; the test that guarded `.github/dependabot.yml`'s own shape is removed with the config file it guarded; several tools/tests updated their comments to point at the `tools/ci/`/`tools/release/` successors instead of claiming current GitHub Actions behaviour (artifact uploads, automatic tag-push publication).
- `docs/template.md` confirms and documents that `tools/template-init/**` never generates or references workflows — a derived repository starts with zero root GitHub Actions workflows too, and runs `bun run ci`/`ci:watch` locally or attaches its own approved CI by its own governance decision.
- Full documentation sweep (EN + ID mirrors): `AGENTS.md` (new explicit rule that GitHub Actions is not an accepted implementation path; the gates table now lists the twelve `local-ci/*` legs; the Bun-pin/Dependabot paragraphs rewritten; Definition of Done requires `bun run ci:pr -- <n>`), `README.md`, `SECURITY.md`, `docs/alur-kerja-pengembangan.md` (five old per-workflow CI sections folded into one "Local CI: the twelve legs" section, keeping each leg's promotion history for the record), `docs/pengujian.md`, `docs/deployment.md`, `docs/status.md`, `docs/template.md`, `docs/aksesibilitas.md`, `docs/responsif.md`, `docs/routing.md`. ADR-0018 and ADR-0020 keep their original decisions; each gets a short "Superseded in part by ADR-0021/0023" note (their own CI/publish *mechanism* moved, not the decision itself), and the ADR index status column reflects it.
- The twelve required status checks on `main` are now `local-ci/*` (posted by `bun run ci:pr`/`ci:watch`) instead of the old GitHub Actions contexts — branch protection was switched over in a companion change before this PR merged, so no Actions checks ever needed to run on it.
