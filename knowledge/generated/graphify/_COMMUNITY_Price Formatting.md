---
type: community
cohesion: 0.24
members: 10
---

# Price Formatting

**Cohesion:** 0.24 - loosely connected
**Members:** 10 nodes

## Members
- [[ADR-0003_2]] - concept - apps/storefront/src/lib/harga.ts
- [[HARGA_FILE]] - code - apps/storefront/tests/katalog-harga.test.ts
- [[PRICE_FORMATTER]] - code - apps/storefront/src/lib/harga.ts
- [[ProductCard.astro]] - code - apps/storefront/src/components/katalog/ProductCard.astro
- [[SCANNABLE_EXTENSIONS]] - code - apps/storefront/tests/katalog-harga.test.ts
- [[SRC_ROOT]] - code - apps/storefront/tests/katalog-harga.test.ts
- [[formatDiscountPercent()]] - code - apps/storefront/src/lib/harga.ts
- [[harga.ts]] - code - apps/storefront/src/lib/harga.ts
- [[katalog-harga.test.ts]] - code - apps/storefront/tests/katalog-harga.test.ts
- [[walk()_1]] - code - apps/storefront/tests/katalog-harga.test.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Price_Formatting
SORT file.name ASC
```

## Connections to other communities
- 6 edges to [[_COMMUNITY_Catalog Fetch Client]]
- 5 edges to [[_COMMUNITY_Order Tracking Script]]
- 4 edges to [[_COMMUNITY_Flash Sale Countdown]]
- 2 edges to [[_COMMUNITY_Marketing Read Models]]
- 2 edges to [[_COMMUNITY_Cart Contract & WhatsApp Fallback]]
- 1 edge to [[_COMMUNITY_Catalog Contract Types]]
- 1 edge to [[_COMMUNITY_Product Index Build]]
- 1 edge to [[_COMMUNITY_Order Session & Phone]]
- 1 edge to [[_COMMUNITY_Product Detail Variant Picker]]
- 1 edge to [[_COMMUNITY_Client Product Search]]
- 1 edge to [[_COMMUNITY_Wishlist Client Storage]]

## Top bridge nodes
- [[harga.ts]] - degree 19, connects to 9 communities
- [[ProductCard.astro]] - degree 7, connects to 6 communities
- [[katalog-harga.test.ts]] - degree 9, connects to 2 communities
- [[formatDiscountPercent()]] - degree 3, connects to 1 community
- [[PRICE_FORMATTER]] - degree 2, connects to 1 community