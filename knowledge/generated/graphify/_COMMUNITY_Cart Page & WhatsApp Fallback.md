---
type: community
cohesion: 0.18
members: 20
---

# Cart Page & WhatsApp Fallback

**Cohesion:** 0.18 - loosely connected
**Members:** 20 nodes

## Members
- [[ADR-0003_5]] - concept - apps/storefront/src/lib/wa-fallback.ts
- [[ADR-0003_3]] - concept - apps/storefront/src/scripts/keranjang.ts
- [[ADR-0007_9]] - concept - apps/storefront/src/lib/wa-fallback.ts
- [[Cart]] - code - apps/storefront/src/lib/keranjang-kontrak.ts
- [[CartLineRequest]] - code - apps/storefront/src/lib/toko-klien.ts
- [[QuoteLine]] - code - apps/storefront/src/lib/toko-klien.ts
- [[buildWhatsappCartMessage()]] - code - apps/storefront/src/lib/wa-fallback.ts
- [[formatPrice()]] - code - apps/storefront/src/lib/harga.ts
- [[hideQuoteError()]] - code - apps/storefront/src/scripts/keranjang.ts
- [[keranjang.ts]] - code - apps/storefront/src/scripts/keranjang.ts
- [[lineText()]] - code - apps/storefront/src/lib/wa-fallback.ts
- [[quoteCart()]] - code - apps/storefront/src/lib/toko-klien.ts
- [[refresh()]] - code - apps/storefront/src/scripts/keranjang.ts
- [[renderLines()]] - code - apps/storefront/src/scripts/keranjang.ts
- [[renderSummary()]] - code - apps/storefront/src/scripts/keranjang.ts
- [[root_3]] - code - apps/storefront/src/scripts/keranjang.ts
- [[showQuoteError()]] - code - apps/storefront/src/scripts/keranjang.ts
- [[statusLabel()]] - code - apps/storefront/src/scripts/keranjang.ts
- [[toLineRequests()]] - code - apps/storefront/src/scripts/keranjang.ts
- [[wa-fallback.ts]] - code - apps/storefront/src/lib/wa-fallback.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Cart_Page__WhatsApp_Fallback
SORT file.name ASC
```

## Connections to other communities
- 13 edges to [[_COMMUNITY_Cart Storage & Cart Contract]]
- 7 edges to [[_COMMUNITY_Price Formatting & Product Cards]]
- 7 edges to [[_COMMUNITY_akun-pesanan.ts]]
- 7 edges to [[_COMMUNITY_Checkout Flow & Phone Preview]]
- 6 edges to [[_COMMUNITY_Commerce Storefront Client & Order Tracking]]
- 4 edges to [[_COMMUNITY_Account Affiliate Page Script]]
- 2 edges to [[_COMMUNITY_Root RSS Feed]]
- 2 edges to [[_COMMUNITY_Site Profile & Base Layout]]
- 2 edges to [[_COMMUNITY_Product Detail Variants Script]]
- 2 edges to [[_COMMUNITY_Client-Side Search & Listing Renderer]]
- 2 edges to [[_COMMUNITY_Wishlist Storage & Account Sync]]
- 1 edge to [[_COMMUNITY_Catalog Data & Product Index]]
- 1 edge to [[_COMMUNITY_Homepage & Derived CSP Artifact]]
- 1 edge to [[_COMMUNITY_Product & Category Pages, Product JSON-LD]]
- 1 edge to [[_COMMUNITY_Account API Client]]
- 1 edge to [[_COMMUNITY_Account Dashboard Script]]
- 1 edge to [[_COMMUNITY_Account Address Book Script]]
- 1 edge to [[_COMMUNITY_akun-ulasan.ts]]
- 1 edge to [[_COMMUNITY_Registration Page Script]]
- 1 edge to [[_COMMUNITY_Login (OTP) Page Script & Request Plumbing]]

## Top bridge nodes
- [[formatPrice()]] - degree 29, connects to 13 communities
- [[wa-fallback.ts]] - degree 20, connects to 10 communities
- [[keranjang.ts]] - degree 26, connects to 6 communities
- [[quoteCart()]] - degree 6, connects to 3 communities
- [[buildWhatsappCartMessage()]] - degree 7, connects to 2 communities