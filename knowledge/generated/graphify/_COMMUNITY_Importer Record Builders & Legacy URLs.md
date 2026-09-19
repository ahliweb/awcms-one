---
type: community
cohesion: 0.22
members: 18
---

# Importer Record Builders & Legacy URLs

**Cohesion:** 0.22 - loosely connected
**Members:** 18 nodes

## Members
- [[REDIRECT_ORIGIN]] - code - tools/import-seputarborneo.ts
- [[buildPostRecord()]] - code - tools/import-seputarborneo.ts
- [[buildVideoRecord()]] - code - tools/import-seputarborneo.ts
- [[chunkIdempotencyKey()]] - code - tools/lib/redirect-push.ts
- [[fakeEntries()]] - code - tests/import-seputarborneo.test.mjs
- [[fakePoster()]] - code - tests/import-seputarborneo.test.mjs
- [[import-seputarborneo.test.mjs]] - code - tests/import-seputarborneo.test.mjs
- [[legacyNewsUrlCurrent()]] - code - tools/import-seputarborneo.ts
- [[legacyNewsUrlPre2000()]] - code - tools/import-seputarborneo.ts
- [[legacyVideoIdSlug()]] - code - tools/import-seputarborneo.ts
- [[legacyVideoUrl()]] - code - tools/import-seputarborneo.ts
- [[newPostSlug()]] - code - tools/import-seputarborneo.ts
- [[normalizeYoutubeVideoId()]] - code - tools/import-seputarborneo.ts
- [[phpRawUrlEncode()]] - code - tools/import-seputarborneo.ts
- [[resolvePublishedAt()]] - code - tools/import-seputarborneo.ts
- [[sbSlug()]] - code - tools/import-seputarborneo.ts
- [[stableStringify()]] - code - tools/lib/redirect-push.ts
- [[videoRedirectSourcePath()]] - code - tools/import-seputarborneo.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Importer_Record_Builders__Legacy_URLs
SORT file.name ASC
```

## Connections to other communities
- 18 edges to [[_COMMUNITY_Legacy Taxonomy Mapping (Importer)]]
- 11 edges to [[_COMMUNITY_redirect-push.ts]]
- 9 edges to [[_COMMUNITY_runExport]]
- 5 edges to [[_COMMUNITY_MySQL Dump Reader]]

## Top bridge nodes
- [[import-seputarborneo.test.mjs]] - degree 38, connects to 4 communities
- [[buildPostRecord()]] - degree 9, connects to 2 communities
- [[buildVideoRecord()]] - degree 8, connects to 2 communities
- [[legacyNewsUrlCurrent()]] - degree 5, connects to 1 community
- [[legacyVideoIdSlug()]] - degree 5, connects to 1 community