---
type: community
cohesion: 0.14
members: 25
---

# Ad Placements & Blog Client

**Cohesion:** 0.14 - loosely connected
**Members:** 25 nodes

## Members
- [[ADR-0100]] - concept - apps/storefront/src/lib/awcms/blog.ts
- [[ADR-0109]] - concept - apps/storefront/src/lib/awcms/blog.ts
- [[AD_PLACEMENT_KEYS]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[AD_SLOTS]] - code - apps/storefront/src/lib/awcms/iklan.ts
- [[AdPlacementKey]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[IklanSlot.astro]] - code - apps/storefront/src/components/berita/IklanSlot.astro
- [[PublicAdPlacement]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[RawPost]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[RawRedirect]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[berita-routes.test.ts]] - code - apps/storefront/tests/berita-routes.test.ts
- [[blog.ts]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[disclosureLabel]] - code - apps/storefront/src/components/berita/IklanSlot.astro
- [[fetchActiveAdPlacements()]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[fetchAllInstitutions()]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[fetchAllTerms()]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[fetchLegacyRedirectRows()]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[getActiveAdPlacements()]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[getAdSlot()]] - code - apps/storefront/src/lib/awcms/iklan.ts
- [[getAllInstitutions()]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[getAllPosts()]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[getAllTerms()]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[iklan.ts]] - code - apps/storefront/src/lib/awcms/iklan.ts
- [[isExpectedRefusal()]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[resetBlogCachesForTests()]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[walkKeysetPages()]] - code - apps/storefront/src/lib/awcms/blog.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Ad_Placements__Blog_Client
SORT file.name ASC
```

## Connections to other communities
- 10 edges to [[_COMMUNITY_Rubrik & Region Rendering]]
- 4 edges to [[_COMMUNITY_Mitra Institutions]]
- 3 edges to [[_COMMUNITY_AWCMS Build Client]]
- 3 edges to [[_COMMUNITY_Article Card & View]]
- 3 edges to [[_COMMUNITY_News Front Page]]
- 3 edges to [[_COMMUNITY_Legacy Redirect Map]]
- 2 edges to [[_COMMUNITY_Site Chrome & Navigation]]

## Top bridge nodes
- [[blog.ts]] - degree 31, connects to 4 communities
- [[iklan.ts]] - degree 10, connects to 2 communities
- [[IklanSlot.astro]] - degree 6, connects to 2 communities
- [[getAllInstitutions()]] - degree 6, connects to 2 communities
- [[AD_SLOTS]] - degree 4, connects to 2 communities