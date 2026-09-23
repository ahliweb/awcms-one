---
bump: minor
type: structure
impact: internal
---

# GitHub Releases are published from CHANGELOG.md on tag push

Ten release tags (`v0.1.0`–`v0.10.0`) existed with zero GitHub Release
objects behind them — a template user landing on this repo's own GitHub page
saw no release notes at all, even though every one of those tags already has
a perfectly good entry sitting in `CHANGELOG.md`. Writing the Release by hand
is exactly the kind of mechanical, easily-postponed step `tools/rilis.mjs`
already exists to take off a maintainer's plate for the rest of a release —
this closes the one part it did not yet cover.

- **`packages/gerbang/lib/changelog.mjs`** (new, pure, unit-tested): reads one
  version's section out of a `CHANGELOG.md`-shaped document, refusing —
  rather than silently mis-splitting — when a `##` heading has drifted from
  the one shape (`## [X.Y.Z] — <date>`) every version heading relies on.
- **`tools/rilis-catatan.mjs`** (new): the CLI shell around it — prints one
  version's section to stdout, accepting `v0.10.0` or `0.10.0`, exiting
  non-zero with a clear stderr message when the version is missing or the
  file is malformed. `tests/rilis-catatan.test.mjs` covers the parser
  directly (middle/first/last section, missing version, optional `v`
  prefix, CRLF, heading-format drift) and the CLI's own exit-code contract.
- **`.github/workflows/release.yml`** (new): `push: tags: ['v*']` plus a
  `workflow_dispatch` `tag` input, `permissions: contents: write` only.
  Extracts the pushed version's notes with the tool above and runs
  `gh release create --verify-tag`, marking `--latest` only when that tag is
  the highest `v*` semver (`git tag --sort=-v:refname`, the same comparison
  `tools/rilis.mjs` itself already relies on) — or `gh release edit` when a
  Release already exists, so a `workflow_dispatch` backfill or a re-publish
  is idempotent rather than failing. The tag is validated against
  `^v[0-9]+\.[0-9]+\.[0-9]+$` and only ever reaches a shell script through
  `env:`, never spliced into `run:` as a `${{ }}` expression, to close off
  script injection through a hostile tag name or dispatch input.
- **`tools/rilis.mjs`**: its printed next steps after `--apply` now say that
  pushing the tag publishes the GitHub Release automatically, and how to
  back-fill or re-publish one via `workflow_dispatch`.
- Docs: `docs/alur-kerja-pengembangan.md`'s "The release cut" section and
  `AGENTS.md`'s "Changesets and releases" section now describe the publish
  step, both with their Indonesian mirrors re-stamped.

After this merges, the manager backfills Releases for `v0.1.0`–`v0.10.0` by
dispatching this workflow once per tag.
