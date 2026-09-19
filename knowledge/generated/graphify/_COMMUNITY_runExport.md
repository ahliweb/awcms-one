---
type: community
cohesion: 0.20
members: 15
---

# runExport

**Cohesion:** 0.20 - loosely connected
**Members:** 15 nodes

## Members
- [[assertOk()]] - code - tools/lib/awcms-api.ts
- [[buildRedirectEntry()]] - code - tools/import-seputarborneo.ts
- [[buildSiteProfileUpdateFromConfig()]] - code - tools/import-seputarborneo.ts
- [[collectPendingAssignments()]] - code - tools/import-seputarborneo.ts
- [[flag()]] - code - tools/import-seputarborneo.ts
- [[formatPushSummary()]] - code - tools/lib/redirect-push.ts
- [[main()]] - code - tools/import-seputarborneo.ts
- [[parseRedirectFile()]] - code - tools/lib/redirect-push.ts
- [[resolveExistingTenantSession()]] - code - tools/lib/awcms-api.ts
- [[row()]] - code - tests/import-seputarborneo.test.mjs
- [[runAssignInstitutions()]] - code - tools/import-seputarborneo.ts
- [[runExport()_1]] - code - tools/import-seputarborneo.ts
- [[runPushRedirects()]] - code - tools/import-seputarborneo.ts
- [[termMapHintFor()]] - code - tools/import-seputarborneo.ts
- [[usage()]] - code - tools/import-seputarborneo.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/runExport
SORT file.name ASC
```

## Connections to other communities
- 14 edges to [[_COMMUNITY_import-seputarborneo.ts]]
- 9 edges to [[_COMMUNITY_import-seputarborneo.test.mjs]]
- 7 edges to [[_COMMUNITY_redirect-push.ts]]
- 2 edges to [[_COMMUNITY_bun]]
- 2 edges to [[_COMMUNITY_mysql-dump-reader.ts]]

## Top bridge nodes
- [[runExport()_1]] - degree 11, connects to 4 communities
- [[runPushRedirects()]] - degree 9, connects to 3 communities
- [[collectPendingAssignments()]] - degree 6, connects to 3 communities
- [[formatPushSummary()]] - degree 4, connects to 3 communities
- [[parseRedirectFile()]] - degree 4, connects to 3 communities