---
type: community
cohesion: 0.24
members: 10
---

# Product Index Build

**Cohesion:** 0.24 - loosely connected
**Members:** 10 nodes

## Members
- [[GET()_6]] - code - apps/storefront/src/pages/index/produk.json.ts
- [[PRODUK_PAGE_SIZE]] - code - apps/storefront/src/lib/catalog.ts
- [[buildCategoryTree()]] - code - apps/storefront/src/lib/catalog.ts
- [[buildProdukIndex()]] - code - apps/storefront/src/lib/catalog.ts
- [[categoryTree]] - code - apps/storefront/src/pages/produk.astro
- [[firstPage]] - code - apps/storefront/src/pages/produk.astro
- [[getCategories()]] - code - apps/storefront/src/lib/catalog.ts
- [[prerender_6]] - code - apps/storefront/src/pages/index/produk.json.ts
- [[produk.astro]] - code - apps/storefront/src/pages/produk.astro
- [[produk.json.ts]] - code - apps/storefront/src/pages/index/produk.json.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Product_Index_Build
SORT file.name ASC
```

## Connections to other communities
- 7 edges to [[_COMMUNITY_Catalog Fetch Client]]
- 6 edges to [[_COMMUNITY_Catalog Contract Types]]
- 5 edges to [[_COMMUNITY_Marketing Read Models]]
- 4 edges to [[_COMMUNITY_Flash Sale Countdown]]
- 3 edges to [[_COMMUNITY_Base Layout & Site Identity]]
- 2 edges to [[_COMMUNITY_Site Chrome & Navigation]]
- 1 edge to [[_COMMUNITY_Price Formatting]]
- 1 edge to [[_COMMUNITY_Client Product Search]]

## Top bridge nodes
- [[produk.astro]] - degree 13, connects to 6 communities
- [[getCategories()]] - degree 10, connects to 5 communities
- [[produk.json.ts]] - degree 8, connects to 3 communities
- [[buildCategoryTree()]] - degree 5, connects to 3 communities
- [[buildProdukIndex()]] - degree 5, connects to 2 communities