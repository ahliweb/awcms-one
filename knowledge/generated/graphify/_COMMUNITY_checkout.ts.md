---
type: community
cohesion: 0.18
members: 17
---

# checkout.ts

**Cohesion:** 0.18 - loosely connected
**Members:** 17 nodes

## Members
- [[ADR-0007_3]] - concept - apps/storefront/src/scripts/checkout.ts
- [[CartLineRequest]] - code - apps/storefront/src/lib/toko-klien.ts
- [[CartQuote]] - code - apps/storefront/src/lib/toko-klien.ts
- [[STEP_ORDER]] - code - apps/storefront/src/scripts/checkout.ts
- [[ShippingSelection]] - code - apps/storefront/src/lib/toko-klien.ts
- [[Step]] - code - apps/storefront/src/scripts/checkout.ts
- [[checkout.ts]] - code - apps/storefront/src/scripts/checkout.ts
- [[clearCart()]] - code - apps/storefront/src/lib/keranjang-klien.ts
- [[createOrder()]] - code - apps/storefront/src/lib/toko-klien.ts
- [[keepDigitsAndLeadingPlus()]] - code - apps/storefront/src/lib/telepon.ts
- [[newCartId()]] - code - apps/storefront/src/lib/keranjang-klien.ts
- [[previewIndonesianPhone()]] - code - apps/storefront/src/lib/telepon.ts
- [[root_3]] - code - apps/storefront/src/scripts/checkout.ts
- [[runCheckout()]] - code - apps/storefront/src/scripts/checkout.ts
- [[telepon.test.ts]] - code - apps/storefront/tests/telepon.test.ts
- [[telepon.ts]] - code - apps/storefront/src/lib/telepon.ts
- [[toLineRequests()]] - code - apps/storefront/src/scripts/checkout.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/checkoutts
SORT file.name ASC
```

## Connections to other communities
- 9 edges to [[_COMMUNITY_keranjang.ts]]
- 8 edges to [[_COMMUNITY_toko-klien.ts]]
- 6 edges to [[_COMMUNITY_keranjang-kontrak.ts]]
- 2 edges to [[_COMMUNITY_productslug.astro]]
- 2 edges to [[_COMMUNITY_scriptspesanan.ts]]
- 1 edge to [[_COMMUNITY_TokoApiError]]
- 1 edge to [[_COMMUNITY_BaseLayout.astro]]

## Top bridge nodes
- [[checkout.ts]] - degree 29, connects to 7 communities
- [[clearCart()]] - degree 6, connects to 2 communities
- [[newCartId()]] - degree 3, connects to 2 communities
- [[CartLineRequest]] - degree 3, connects to 2 communities
- [[CartQuote]] - degree 3, connects to 2 communities