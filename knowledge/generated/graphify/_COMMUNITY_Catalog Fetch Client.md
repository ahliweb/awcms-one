---
type: community
cohesion: 0.11
members: 23
---

# Catalog Fetch Client

**Cohesion:** 0.11 - loosely connected
**Members:** 23 nodes

## Members
- [[ADR-0003_1]] - concept - apps/storefront/src/lib/catalog.ts
- [[CategoryNode]] - code - apps/storefront/src/lib/catalog.ts
- [[CommercePage]] - code - apps/storefront/src/lib/catalog.ts
- [[CommerceProductImage]] - code - apps/storefront/src/lib/catalog.ts
- [[DEFAULT_TIER_LABELS]] - code - apps/storefront/src/lib/catalog.ts
- [[PriceTierRow]] - code - apps/storefront/src/lib/catalog.ts
- [[ProdukPage]] - code - apps/storefront/src/lib/catalog.ts
- [[ServiceFormField]] - code - apps/storefront/src/lib/catalog.ts
- [[ServiceFormFieldType]] - code - apps/storefront/src/lib/catalog.ts
- [[SizeChartType]] - code - apps/storefront/src/lib/catalog.ts
- [[SubscriptionPeriod]] - code - apps/storefront/src/lib/catalog.ts
- [[VariantAttributeGroup]] - code - apps/storefront/src/lib/catalog.ts
- [[VariantAttributeOption]] - code - apps/storefront/src/lib/catalog.ts
- [[assertNeverProductStatus()]] - code - apps/storefront/src/lib/catalog.ts
- [[catalog.ts]] - code - apps/storefront/src/lib/catalog.ts
- [[comparePrices()]] - code - apps/storefront/src/lib/harga.ts
- [[filterProdukIndex()]] - code - apps/storefront/src/lib/catalog.ts
- [[isPubliclyVisible()_1]] - code - apps/storefront/src/lib/catalog.ts
- [[listAllCategories()]] - code - apps/storefront/src/lib/catalog.ts
- [[listAllPages()]] - code - apps/storefront/src/lib/catalog.ts
- [[listAllProducts()]] - code - apps/storefront/src/lib/catalog.ts
- [[normalizeSearchTerm()]] - code - apps/storefront/src/lib/catalog.ts
- [[priceToNumber()]] - code - apps/storefront/src/lib/harga.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Catalog_Fetch_Client
SORT file.name ASC
```

## Connections to other communities
- 14 edges to [[_COMMUNITY_Catalog Contract Types]]
- 10 edges to [[_COMMUNITY_Client Product Search]]
- 7 edges to [[_COMMUNITY_Flash Sale Countdown]]
- 7 edges to [[_COMMUNITY_Product Index Build]]
- 6 edges to [[_COMMUNITY_Price Formatting]]
- 4 edges to [[_COMMUNITY_Theme Token Fetch]]
- 2 edges to [[_COMMUNITY_AWCMS Build Client]]
- 2 edges to [[_COMMUNITY_Site Chrome & Navigation]]
- 2 edges to [[_COMMUNITY_Product Detail Variant Picker]]
- 2 edges to [[_COMMUNITY_Order Tracking Script]]
- 2 edges to [[_COMMUNITY_Marketing Read Models]]
- 1 edge to [[_COMMUNITY_Kontrak Type Re-exports]]
- 1 edge to [[_COMMUNITY_Site Config & Env]]

## Top bridge nodes
- [[catalog.ts]] - degree 69, connects to 13 communities
- [[filterProdukIndex()]] - degree 9, connects to 2 communities
- [[priceToNumber()]] - degree 6, connects to 2 communities
- [[comparePrices()]] - degree 5, connects to 1 community
- [[isPubliclyVisible()_1]] - degree 3, connects to 1 community