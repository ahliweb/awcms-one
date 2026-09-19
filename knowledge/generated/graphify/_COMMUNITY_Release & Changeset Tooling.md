---
type: community
cohesion: 0.08
members: 45
---

# Release & Changeset Tooling

**Cohesion:** 0.08 - loosely connected
**Members:** 45 nodes

## Members
- [[BUMP_LEVELS]] - code - packages/gerbang/lib/semver.mjs
- [[CHANGESET_IMPACTS]] - code - packages/gerbang/lib/changeset.mjs
- [[CHANGESET_TYPES]] - code - packages/gerbang/lib/changeset.mjs
- [[apply]] - code - tools/rilis.mjs
- [[args]] - code - tools/rilis.mjs
- [[atLeastAsSignificant()]] - code - packages/gerbang/lib/semver.mjs
- [[audit-rilis.mjs]] - code - packages/gerbang/audit-rilis.mjs
- [[body]] - code - tools/rilis.mjs
- [[bumpVersion()]] - code - packages/gerbang/lib/semver.mjs
- [[changeset.mjs]] - code - packages/gerbang/lib/changeset.mjs
- [[changesetBody()]] - code - packages/gerbang/lib/changeset.mjs
- [[changesetContent]] - code - tools/rilis.mjs
- [[changesets]] - code - tests/versi-changeset.test.mjs
- [[commit]] - code - tools/rilis.mjs
- [[dated]] - code - packages/gerbang/audit-rilis.mjs
- [[daysBetween()]] - code - packages/gerbang/audit-rilis.mjs
- [[declaredDate()]] - code - packages/gerbang/audit-rilis.mjs
- [[derivedLevel]] - code - tools/rilis.mjs
- [[entries]] - code - tests/versi-changeset.test.mjs
- [[formatTag()]] - code - packages/gerbang/lib/semver.mjs
- [[formatVersion()]] - code - packages/gerbang/lib/semver.mjs
- [[found]] - code - tools/rilis.mjs
- [[git()]] - code - tools/rilis.mjs
- [[gitRunOrThrow()]] - code - packages/gerbang/lib/git.mjs
- [[highestBump()]] - code - packages/gerbang/lib/semver.mjs
- [[invalid]] - code - tools/rilis.mjs
- [[isChangesetFile()]] - code - packages/gerbang/lib/changeset.mjs
- [[next]] - code - tools/rilis.mjs
- [[oldest]] - code - packages/gerbang/audit-rilis.mjs
- [[parseChangeset()]] - code - packages/gerbang/lib/changeset.mjs
- [[parseTag()]] - code - packages/gerbang/lib/semver.mjs
- [[parseVersion()]] - code - packages/gerbang/lib/semver.mjs
- [[pending_1]] - code - packages/gerbang/audit-rilis.mjs
- [[pkg]] - code - tools/rilis.mjs
- [[reporter_2]] - code - packages/gerbang/audit-rilis.mjs
- [[requestedBumps]] - code - tools/rilis.mjs
- [[requestedLevel]] - code - tools/rilis.mjs
- [[rilis.mjs]] - code - tools/rilis.mjs
- [[semver.mjs]] - code - packages/gerbang/lib/semver.mjs
- [[tag]] - code - tools/rilis.mjs
- [[today]] - code - tools/rilis.mjs
- [[today()]] - code - packages/gerbang/audit-rilis.mjs
- [[todayIso]] - code - packages/gerbang/audit-rilis.mjs
- [[validateChangeset()]] - code - packages/gerbang/lib/changeset.mjs
- [[versi-changeset.test.mjs]] - code - tests/versi-changeset.test.mjs

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Release__Changeset_Tooling
SORT file.name ASC
```

## Connections to other communities
- 2 edges to [[_COMMUNITY_Documentation & Graph Audit Gates]]
- 2 edges to [[_COMMUNITY_Build Smoke Harness (Bun Spawn)]]
- 2 edges to [[_COMMUNITY_Documentation Link Audit]]

## Top bridge nodes
- [[rilis.mjs]] - degree 29, connects to 2 communities
- [[gitRunOrThrow()]] - degree 4, connects to 2 communities
- [[audit-rilis.mjs]] - degree 12, connects to 1 community