---
type: community
cohesion: 0.24
members: 12
---

# katalog-csp-media.test.ts

**Cohesion:** 0.24 - loosely connected
**Members:** 12 nodes

## Members
- [[ADR-0002_2]] - concept - apps/storefront/src/lib/csp-asal-media.ts
- [[CSP]] - code - apps/storefront/server/penyaji.mjs
- [[CspOriginsArtifact]] - code - apps/storefront/src/lib/csp-asal-media.ts
- [[buildCsp()]] - code - apps/storefront/server/penyaji.mjs
- [[buildCspOriginsArtifact()]] - code - apps/storefront/src/lib/csp-asal-media.ts
- [[collectOrigins()]] - code - apps/storefront/src/lib/csp-asal-media.ts
- [[csp-asal-media.ts]] - code - apps/storefront/src/lib/csp-asal-media.ts
- [[fixtureDir()]] - code - apps/storefront/tests/katalog-csp-media.test.ts
- [[katalog-csp-media.test.ts]] - code - apps/storefront/tests/katalog-csp-media.test.ts
- [[originOf()]] - code - apps/storefront/src/lib/csp-asal-media.ts
- [[readCspOrigins()]] - code - apps/storefront/server/penyaji.mjs
- [[sanitizeOrigins()]] - code - apps/storefront/server/penyaji.mjs

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/katalog-csp-mediatestts
SORT file.name ASC
```

## Connections to other communities
- 8 edges to [[_COMMUNITY_penyaji.mjs]]
- 3 edges to [[_COMMUNITY_requireAwcmsOrigin]]
- 3 edges to [[_COMMUNITY_csp.json.ts]]
- 2 edges to [[_COMMUNITY_ga.ts]]

## Top bridge nodes
- [[buildCsp()]] - degree 6, connects to 3 communities
- [[csp-asal-media.ts]] - degree 8, connects to 2 communities
- [[buildCspOriginsArtifact()]] - degree 6, connects to 2 communities
- [[CSP]] - degree 4, connects to 2 communities
- [[katalog-csp-media.test.ts]] - degree 9, connects to 1 community