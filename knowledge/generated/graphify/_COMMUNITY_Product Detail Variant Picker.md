---
type: community
cohesion: 0.26
members: 12
---

# Product Detail Variant Picker

**Cohesion:** 0.26 - loosely connected
**Members:** 12 nodes

## Members
- [[FlashSalePayload]] - code - apps/storefront/src/scripts/produk-detail.ts
- [[ProdukDetailPayload]] - code - apps/storefront/src/scripts/produk-detail.ts
- [[ServiceFormFieldPayload]] - code - apps/storefront/src/scripts/produk-detail.ts
- [[currentVariant()]] - code - apps/storefront/src/scripts/produk-detail.ts
- [[effectiveMaxQuantity()]] - code - apps/storefront/src/scripts/produk-detail.ts
- [[effectivePrice()]] - code - apps/storefront/src/scripts/produk-detail.ts
- [[findVariantForSelection()]] - code - apps/storefront/src/lib/catalog.ts
- [[hasSelection()]] - code - apps/storefront/src/scripts/produk-detail.ts
- [[produk-detail.ts]] - code - apps/storefront/src/scripts/produk-detail.ts
- [[refresh()_1]] - code - apps/storefront/src/scripts/produk-detail.ts
- [[root_6]] - code - apps/storefront/src/scripts/produk-detail.ts
- [[selectedOptionNames()]] - code - apps/storefront/src/scripts/produk-detail.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Product_Detail_Variant_Picker
SORT file.name ASC
```

## Connections to other communities
- 2 edges to [[_COMMUNITY_Catalog Fetch Client]]
- 2 edges to [[_COMMUNITY_Catalog Contract Types]]
- 2 edges to [[_COMMUNITY_Order Tracking Script]]
- 2 edges to [[_COMMUNITY_Cart Client Storage]]
- 1 edge to [[_COMMUNITY_Price Formatting]]
- 1 edge to [[_COMMUNITY_Flash Sale Countdown]]

## Top bridge nodes
- [[produk-detail.ts]] - degree 18, connects to 6 communities
- [[findVariantForSelection()]] - degree 4, connects to 2 communities
- [[refresh()_1]] - degree 6, connects to 1 community