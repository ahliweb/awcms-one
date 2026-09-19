---
type: community
cohesion: 0.21
members: 14
---

# Price Formatting & Product Cards

**Cohesion:** 0.21 - loosely connected
**Members:** 14 nodes

## Members
- [[ADR-0003_1]] - concept - apps/storefront/src/lib/harga.ts
- [[HARGA_FILE]] - code - apps/storefront/tests/katalog-harga.test.ts
- [[PRICE_FORMATTER]] - code - apps/storefront/src/lib/harga.ts
- [[ProductCard.astro]] - code - apps/storefront/src/components/katalog/ProductCard.astro
- [[SCANNABLE_EXTENSIONS]] - code - apps/storefront/tests/katalog-harga.test.ts
- [[SRC_ROOT]] - code - apps/storefront/tests/katalog-harga.test.ts
- [[comparePrices()]] - code - apps/storefront/src/lib/harga.ts
- [[filterProdukIndex()]] - code - apps/storefront/src/lib/catalog.ts
- [[formatDiscountPercent()]] - code - apps/storefront/src/lib/harga.ts
- [[harga.ts]] - code - apps/storefront/src/lib/harga.ts
- [[katalog-harga.test.ts]] - code - apps/storefront/tests/katalog-harga.test.ts
- [[normalizeSearchTerm()]] - code - apps/storefront/src/lib/catalog.ts
- [[priceToNumber()]] - code - apps/storefront/src/lib/harga.ts
- [[walk()_1]] - code - apps/storefront/tests/katalog-harga.test.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Price_Formatting__Product_Cards
SORT file.name ASC
```

## Connections to other communities
- 7 edges to [[_COMMUNITY_Catalog Data & Product Index]]
- 7 edges to [[_COMMUNITY_Cart Page & WhatsApp Fallback]]
- 5 edges to [[_COMMUNITY_Product & Category Pages, Product JSON-LD]]
- 4 edges to [[_COMMUNITY_Client-Side Search & Listing Renderer]]
- 2 edges to [[_COMMUNITY_Homepage & Derived CSP Artifact]]
- 1 edge to [[_COMMUNITY_Product Listing Filters & URL State]]
- 1 edge to [[_COMMUNITY_Site Profile & Base Layout]]
- 1 edge to [[_COMMUNITY_Product Detail Variants Script]]
- 1 edge to [[_COMMUNITY_Commerce Storefront Client & Order Tracking]]
- 1 edge to [[_COMMUNITY_Account Affiliate Page Script]]
- 1 edge to [[_COMMUNITY_akun-pesanan.ts]]
- 1 edge to [[_COMMUNITY_Checkout Flow & Phone Preview]]
- 1 edge to [[_COMMUNITY_Wishlist Storage & Account Sync]]

## Top bridge nodes
- [[harga.ts]] - degree 21, connects to 12 communities
- [[filterProdukIndex()]] - degree 9, connects to 4 communities
- [[ProductCard.astro]] - degree 7, connects to 4 communities
- [[priceToNumber()]] - degree 6, connects to 2 communities
- [[katalog-harga.test.ts]] - degree 9, connects to 1 community