---
type: community
cohesion: 0.14
members: 16
---

# Changeset Backlog Gate

**Cohesion:** 0.14 - loosely connected
**Members:** 16 nodes

## Members
- [[SCRIPT_DIRS]] - code - tests/standar-skrip.test.mjs
- [[audit-rilis.mjs]] - code - packages/gerbang/audit-rilis.mjs
- [[codeOnly()]] - code - tests/standar-skrip.test.mjs
- [[createReporter()]] - code - packages/gerbang/lib/reporter.mjs
- [[dated]] - code - packages/gerbang/audit-rilis.mjs
- [[daysBetween()]] - code - packages/gerbang/audit-rilis.mjs
- [[declaredDate()]] - code - packages/gerbang/audit-rilis.mjs
- [[formatReport()]] - code - packages/gerbang/lib/reporter.mjs
- [[oldest]] - code - packages/gerbang/audit-rilis.mjs
- [[pending]] - code - packages/gerbang/audit-rilis.mjs
- [[reporter]] - code - packages/gerbang/audit-rilis.mjs
- [[reporter.mjs]] - code - packages/gerbang/lib/reporter.mjs
- [[scripts_2]] - code - tests/standar-skrip.test.mjs
- [[standar-skrip.test.mjs]] - code - tests/standar-skrip.test.mjs
- [[today()]] - code - packages/gerbang/audit-rilis.mjs
- [[todayIso]] - code - packages/gerbang/audit-rilis.mjs

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Changeset_Backlog_Gate
SORT file.name ASC
```

## Connections to other communities
- 2 edges to [[_COMMUNITY_Release & Changeset Versioning]]
- 2 edges to [[_COMMUNITY_Markdown Documentation Audit]]
- 2 edges to [[_COMMUNITY_Root Knowledge-Graph Gate]]

## Top bridge nodes
- [[reporter.mjs]] - degree 6, connects to 2 communities
- [[createReporter()]] - degree 4, connects to 2 communities
- [[audit-rilis.mjs]] - degree 12, connects to 1 community