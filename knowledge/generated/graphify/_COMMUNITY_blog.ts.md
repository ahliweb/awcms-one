---
type: community
cohesion: 0.14
members: 24
---

# blog.ts

**Cohesion:** 0.14 - loosely connected
**Members:** 24 nodes

## Members
- [[ADR-0100_3]] - concept - apps/storefront/src/lib/awcms/blog.ts
- [[ADR-0109_1]] - concept - apps/storefront/src/lib/awcms/blog.ts
- [[AD_PLACEMENT_KEYS]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[AD_SLOTS]] - code - apps/storefront/src/lib/awcms/iklan.ts
- [[AdPlacementKey]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[IklanSlot.astro]] - code - apps/storefront/src/components/berita/IklanSlot.astro
- [[PublicAdPlacement]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[RawPost]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[RawRedirect]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[berita-routes.test.ts]] - code - apps/storefront/tests/berita-routes.test.ts
- [[blog.ts]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[creativeImageUrl()]] - code - apps/storefront/src/components/berita/IklanSlot.astro
- [[fetchActiveAdPlacements()]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[fetchAllInstitutions()]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[fetchAllTerms()]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[fetchLegacyRedirectRows()]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[getActiveAdPlacements()]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[getAdSlot()]] - code - apps/storefront/src/lib/awcms/iklan.ts
- [[getAllPosts()]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[getAllTerms()]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[iklan.ts]] - code - apps/storefront/src/lib/awcms/iklan.ts
- [[isExpectedRefusal()_4]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[resetBlogCachesForTests()]] - code - apps/storefront/src/lib/awcms/blog.ts
- [[walkKeysetPages()]] - code - apps/storefront/src/lib/awcms/blog.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/blogts
SORT file.name ASC
```

## Connections to other communities
- 8 edges to [[_COMMUNITY_berita.ts]]
- 5 edges to [[_COMMUNITY_lembaga.ts]]
- 4 edges to [[_COMMUNITY_Sidebar.astro]]
- 3 edges to [[_COMMUNITY_n.astro]]
- 3 edges to [[_COMMUNITY_navigasi-berita.ts]]
- 3 edges to [[_COMMUNITY_csp.json.ts]]
- 3 edges to [[_COMMUNITY_getVideo]]
- 2 edges to [[_COMMUNITY_readEnv]]
- 2 edges to [[_COMMUNITY_routes.ts]]
- 1 edge to [[_COMMUNITY_awcmsanalitik.ts]]

## Top bridge nodes
- [[blog.ts]] - degree 35, connects to 7 communities
- [[IklanSlot.astro]] - degree 8, connects to 3 communities
- [[iklan.ts]] - degree 10, connects to 2 communities
- [[AD_SLOTS]] - degree 4, connects to 2 communities
- [[getActiveAdPlacements()]] - degree 6, connects to 1 community