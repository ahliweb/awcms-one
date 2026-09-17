---
type: community
cohesion: 0.16
members: 20
---

# Cart Contract & WhatsApp Fallback

**Cohesion:** 0.16 - loosely connected
**Members:** 20 nodes

## Members
- [[ADR-0003_4]] - concept - apps/storefront/src/lib/wa-fallback.ts
- [[ADR-0003_5]] - concept - apps/storefront/src/scripts/keranjang.ts
- [[ADR-0007_3]] - concept - apps/storefront/src/lib/wa-fallback.ts
- [[Cart]] - code - apps/storefront/src/lib/keranjang-kontrak.ts
- [[CartLineRequest]] - code - apps/storefront/src/lib/toko-klien.ts
- [[CartQuote]] - code - apps/storefront/src/lib/toko-klien.ts
- [[QuoteLine]] - code - apps/storefront/src/lib/toko-klien.ts
- [[buildWhatsappCartMessage()]] - code - apps/storefront/src/lib/wa-fallback.ts
- [[buildWhatsappUrl()]] - code - apps/storefront/src/lib/wa-fallback.ts
- [[hideQuoteError()]] - code - apps/storefront/src/scripts/keranjang.ts
- [[keranjang.ts]] - code - apps/storefront/src/scripts/keranjang.ts
- [[lineText()]] - code - apps/storefront/src/lib/wa-fallback.ts
- [[refresh()]] - code - apps/storefront/src/scripts/keranjang.ts
- [[renderLines()]] - code - apps/storefront/src/scripts/keranjang.ts
- [[renderSummary()]] - code - apps/storefront/src/scripts/keranjang.ts
- [[root_4]] - code - apps/storefront/src/scripts/keranjang.ts
- [[showQuoteError()]] - code - apps/storefront/src/scripts/keranjang.ts
- [[statusLabel()]] - code - apps/storefront/src/scripts/keranjang.ts
- [[toLineRequests()_1]] - code - apps/storefront/src/scripts/keranjang.ts
- [[wa-fallback.ts]] - code - apps/storefront/src/lib/wa-fallback.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Cart_Contract__WhatsApp_Fallback
SORT file.name ASC
```

## Connections to other communities
- 14 edges to [[_COMMUNITY_Cart Client Storage]]
- 6 edges to [[_COMMUNITY_Order Session & Phone]]
- 6 edges to [[_COMMUNITY_Storefront Commerce Client]]
- 5 edges to [[_COMMUNITY_Order Tracking Script]]
- 2 edges to [[_COMMUNITY_Price Formatting]]
- 1 edge to [[_COMMUNITY_Storefront API Error]]
- 1 edge to [[_COMMUNITY_Base Layout & Site Identity]]

## Top bridge nodes
- [[keranjang.ts]] - degree 27, connects to 6 communities
- [[wa-fallback.ts]] - degree 12, connects to 4 communities
- [[buildWhatsappCartMessage()]] - degree 7, connects to 3 communities
- [[refresh()]] - degree 8, connects to 2 communities
- [[renderLines()]] - degree 6, connects to 2 communities