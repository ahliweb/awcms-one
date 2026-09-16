---
type: community
cohesion: 0.33
members: 7
---

# Recent News Loader

**Cohesion:** 0.33 - loosely connected
**Members:** 7 nodes

## Members
- [[BeritaLoader]] - code - apps/storefront/src/lib/berita-terkini.ts
- [[BeritaModule]] - code - apps/storefront/src/lib/berita-terkini.ts
- [[RecentPost]] - code - apps/storefront/src/lib/berita-terkini.ts
- [[berita-terkini.ts]] - code - apps/storefront/src/lib/berita-terkini.ts
- [[defaultLoader()]] - code - apps/storefront/src/lib/berita-terkini.ts
- [[getRecentPosts()]] - code - apps/storefront/src/lib/berita-terkini.ts
- [[katalog-berita-terkini.test.ts]] - code - apps/storefront/tests/katalog-berita-terkini.test.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Recent_News_Loader
SORT file.name ASC
```

## Connections to other communities
- 2 edges to [[_COMMUNITY_Marketing Read Models]]
- 1 edge to [[_COMMUNITY_Rubrik & Region Rendering]]

## Top bridge nodes
- [[berita-terkini.ts]] - degree 7, connects to 1 community
- [[getRecentPosts()]] - degree 3, connects to 1 community
- [[defaultLoader()]] - degree 2, connects to 1 community