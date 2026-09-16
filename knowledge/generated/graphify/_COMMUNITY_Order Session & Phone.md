---
type: community
cohesion: 0.20
members: 15
---

# Order Session & Phone

**Cohesion:** 0.20 - loosely connected
**Members:** 15 nodes

## Members
- [[ADR-0007_5]] - concept - apps/storefront/src/scripts/checkout.ts
- [[CreateOrderRequest]] - code - apps/storefront/src/lib/toko-klien.ts
- [[PESANAN_PHONE_KEY]] - code - apps/storefront/src/lib/pesanan-sesi.ts
- [[STEP_ORDER]] - code - apps/storefront/src/scripts/checkout.ts
- [[ShippingSelection]] - code - apps/storefront/src/lib/toko-klien.ts
- [[Step]] - code - apps/storefront/src/scripts/checkout.ts
- [[checkout.ts]] - code - apps/storefront/src/scripts/checkout.ts
- [[keepDigitsAndLeadingPlus()]] - code - apps/storefront/src/lib/telepon.ts
- [[pesanan-sesi.ts]] - code - apps/storefront/src/lib/pesanan-sesi.ts
- [[previewIndonesianPhone()]] - code - apps/storefront/src/lib/telepon.ts
- [[root_3]] - code - apps/storefront/src/scripts/checkout.ts
- [[runCheckout()]] - code - apps/storefront/src/scripts/checkout.ts
- [[telepon.test.ts]] - code - apps/storefront/tests/telepon.test.ts
- [[telepon.ts]] - code - apps/storefront/src/lib/telepon.ts
- [[toLineRequests()]] - code - apps/storefront/src/scripts/checkout.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Order_Session__Phone
SORT file.name ASC
```

## Connections to other communities
- 7 edges to [[_COMMUNITY_Storefront Commerce Client]]
- 6 edges to [[_COMMUNITY_Cart Contract & WhatsApp Fallback]]
- 5 edges to [[_COMMUNITY_Cart Client Storage]]
- 3 edges to [[_COMMUNITY_Order Tracking Script]]
- 1 edge to [[_COMMUNITY_Price Formatting]]
- 1 edge to [[_COMMUNITY_Storefront API Error]]
- 1 edge to [[_COMMUNITY_Base Layout & Site Identity]]

## Top bridge nodes
- [[checkout.ts]] - degree 29, connects to 7 communities
- [[runCheckout()]] - degree 6, connects to 2 communities
- [[pesanan-sesi.ts]] - degree 3, connects to 1 community
- [[PESANAN_PHONE_KEY]] - degree 3, connects to 1 community
- [[CreateOrderRequest]] - degree 3, connects to 1 community