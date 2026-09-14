🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](README.id.md)

# Changesets

One file per change, written in the same iteration as the change itself. The purpose is simple: when a release is versioned, its notes already exist, written by the person who understood the context best — not reconstructed from `git log` months later.

## When one is required

A change affecting public behaviour, workspace structure, dependencies, or deployment. A typo fix with no change of meaning does not need one.

## Format

File name: `YYYY-MM-DD-summary-in-kebab-case.md`.

```markdown
---
bump: major | minor | patch
type: content | structure | fix | dependency | docs
impact: public | internal
---

# A short title

What changed and **why**. The "why" is the valuable half —
the "what" can be read from the diff, the "why" cannot.

- A point of change a reader or operator would notice.
- A point of change only felt while developing.
```

## `bump` decides the version

This is the field the release reads. The next version is the **largest** `bump` among the waiting changesets: one `minor` beside nine `patch` entries makes the whole release `minor`.

| `bump` | In this repo, that means | Example |
| ------- | ----------------------- | -------- |
| `major` | a public contract breaks — a published package's exported shape, a workspace's public API, a documented CLI flag | a gate's exit-code contract changes |
| `minor` | something is gained: a new gate, a new script, a new workspace, a new capability | `packages/kontrak` lands |
| `patch` | a fix that does not change the shape of anything | a typo, a dependency bump, a corrected gate message |

Choose it **while writing the change**, which is the only moment anyone reliably knows the answer. A level decided later, by whoever happens to run the release script, is a level decided from a list of file names rather than from the change itself — precisely the failure this convention exists to avoid.

Two rules follow from `bump` being load-bearing, both enforced by `tests/versi-changeset.test.mjs`:

- **A changeset without a valid `bump` fails the gate.** Not because the field is paperwork, but because the failure it prevents is invisible: a changeset the release cannot read stops contributing to the version and nothing looks wrong.
- **`bun run release` may be told a level, and it may only be a LARGER one.** A releaser who knows the change is bigger than its changesets admit may say so; a smaller one is refused, because it would publish a break behind a number promising there is none.

Versions are `MAJOR.MINOR.PATCH`, tagged `vX.Y.Z`. This repo is still `0.x`, where semver itself makes no compatibility promise — `bump` records intent now so the record is already true when `1.0.0` makes it binding.

## The backlog has two bounds

`bump` decides how big a release is; it never decides **when**. `bun run audit:rilis` bounds the waiting backlog in this directory and runs in CI beside the other gates:

| Bound | Value |
| --- | --- |
| Files waiting | **10** |
| Age of the oldest | **14 days** |

Both numbers are starting assumptions rather than a measured rate — this repo has no release history yet to measure one from (see `packages/gerbang/audit-rilis.mjs`'s own docblock). Revisit them once an actual cadence exists.

The file name is what carries the age, so `YYYY-MM-DD-` is **required rather than merely documented**: a name the gate cannot date never ages, and it would sit here invisible to the one check built to see it. A date the calendar does not have (`2026-02-31`) is refused, and so is one more than a day ahead of the machine checking it — one day of slack, because the author names the file in their own timezone and CI keeps UTC.

Crossing a bound is not a fault to apologise for — it is the signal that `bun run release --apply` is due. The release script does not run this gate, because folding the changesets is exactly what clears it.

## Notes

Files here are folded into [`CHANGELOG.md`](../CHANGELOG.md) by `bun run release`, then deleted. Their titles are demoted two levels so they nest neatly under the version heading.

**Relative links are written from the point of view of `.changesets/`.** The release script rewrites those paths to the repo root's point of view as it folds them — `../docs/x.md` becomes `docs/x.md`. `bun run audit:dokumen` resolves every link from the location of the file that contains it, so that same rule is checked with no special case for this directory.

Changesets themselves are **not** mirrored into Indonesian, unlike the rest of the documents here: they are ephemeral by construction — folded into the changelog and deleted on release — so a mirror would outlive its source by exactly one release. This README is a document like any other, and is mirrored.
