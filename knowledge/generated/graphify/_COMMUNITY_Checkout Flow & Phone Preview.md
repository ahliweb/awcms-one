---
type: community
cohesion: 0.18
members: 16
---

# Checkout Flow & Phone Preview

**Cohesion:** 0.18 - loosely connected
**Members:** 16 nodes

## Members
- [[dot-freshQuote()]] - code - apps/storefront/src/lib/toko-permintaan.ts
- [[ADR-0007_11]] - concept - apps/storefront/src/scripts/checkout.ts
- [[Alamat]] - code - apps/storefront/src/lib/akun-klien.ts
- [[CartQuote]] - code - apps/storefront/src/lib/toko-klien.ts
- [[STEP_ORDER]] - code - apps/storefront/src/scripts/checkout.ts
- [[ShippingSelection]] - code - apps/storefront/src/lib/toko-klien.ts
- [[Step]] - code - apps/storefront/src/scripts/checkout.ts
- [[checkout.ts]] - code - apps/storefront/src/scripts/checkout.ts
- [[createOrder()]] - code - apps/storefront/src/lib/toko-klien.ts
- [[keepDigitsAndLeadingPlus()]] - code - apps/storefront/src/lib/telepon.ts
- [[previewIndonesianPhone()]] - code - apps/storefront/src/lib/telepon.ts
- [[root_10]] - code - apps/storefront/src/scripts/checkout.ts
- [[runCheckout()]] - code - apps/storefront/src/scripts/checkout.ts
- [[telepon.test.ts]] - code - apps/storefront/tests/telepon.test.ts
- [[telepon.ts]] - code - apps/storefront/src/lib/telepon.ts
- [[toLineRequests()_1]] - code - apps/storefront/src/scripts/checkout.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Checkout_Flow__Phone_Preview
SORT file.name ASC
```

## Connections to other communities
- 8 edges to [[_COMMUNITY_Commerce Storefront Client & Order Tracking]]
- 7 edges to [[_COMMUNITY_Cart Page & WhatsApp Fallback]]
- 5 edges to [[_COMMUNITY_Cart Storage & Cart Contract]]
- 5 edges to [[_COMMUNITY_Account API Client]]
- 5 edges to [[_COMMUNITY_Cascading Region Selects]]
- 3 edges to [[_COMMUNITY_Affiliate Referral Capture]]
- 3 edges to [[_COMMUNITY_Customer Session Store]]
- 3 edges to [[_COMMUNITY_Login (OTP) Page Script & Request Plumbing]]
- 1 edge to [[_COMMUNITY_Price Formatting & Product Cards]]
- 1 edge to [[_COMMUNITY_Account Address Book Script]]
- 1 edge to [[_COMMUNITY_akun-pesanan.ts]]
- 1 edge to [[_COMMUNITY_Site Profile & Base Layout]]

## Top bridge nodes
- [[checkout.ts]] - degree 39, connects to 11 communities
- [[runCheckout()]] - degree 11, connects to 5 communities
- [[CartQuote]] - degree 5, connects to 3 communities
- [[createOrder()]] - degree 5, connects to 2 communities
- [[Alamat]] - degree 3, connects to 2 communities