---
type: community
cohesion: 0.50
members: 5
---

# profil.test.ts

**Cohesion:** 0.50 - moderately connected
**Members:** 5 nodes

## Members
- [[DEFAULT_IDENTITY]] - code - apps/storefront/src/config/site.ts
- [[EMPTY_PAYLOAD_1]] - code - apps/storefront/tests/profil.test.ts
- [[mergeSiteIdentity()]] - code - apps/storefront/src/lib/awcms/profil.ts
- [[parseSocialLinks()]] - code - apps/storefront/src/lib/awcms/profil.ts
- [[profil.test.ts]] - code - apps/storefront/tests/profil.test.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/profiltestts
SORT file.name ASC
```

## Connections to other communities
- 5 edges to [[_COMMUNITY_profil.ts]]
- 2 edges to [[_COMMUNITY_site.ts]]
- 1 edge to [[_COMMUNITY_wilayah-checkout.ts]]

## Top bridge nodes
- [[profil.test.ts]] - degree 6, connects to 2 communities
- [[mergeSiteIdentity()]] - degree 5, connects to 2 communities
- [[DEFAULT_IDENTITY]] - degree 3, connects to 2 communities
- [[parseSocialLinks()]] - degree 3, connects to 1 community