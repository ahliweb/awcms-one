---
type: community
cohesion: 0.09
members: 32
---

# Storefront Commerce Client

**Cohesion:** 0.09 - loosely connected
**Members:** 32 nodes

## Members
- [[ADR-0007_2]] - concept - apps/storefront/src/lib/toko-klien.ts
- [[CartLineStatus]] - code - apps/storefront/src/lib/toko-klien.ts
- [[Envelope_1]] - code - apps/storefront/src/lib/toko-klien.ts
- [[Order]] - code - apps/storefront/src/lib/toko-klien.ts
- [[OrderAddressInput]] - code - apps/storefront/src/lib/toko-klien.ts
- [[OrderCustomerInput]] - code - apps/storefront/src/lib/toko-klien.ts
- [[OrderLine]] - code - apps/storefront/src/lib/toko-klien.ts
- [[OrderPaymentInput]] - code - apps/storefront/src/lib/toko-klien.ts
- [[OrderStatus]] - code - apps/storefront/src/lib/toko-klien.ts
- [[OrderTimelineEntry]] - code - apps/storefront/src/lib/toko-klien.ts
- [[PaymentConfirmation]] - code - apps/storefront/src/lib/toko-klien.ts
- [[PaymentConfirmationRequest]] - code - apps/storefront/src/lib/toko-klien.ts
- [[PaymentMethodAvailability]] - code - apps/storefront/src/lib/toko-klien.ts
- [[QUOTE_REQUEST]] - code - apps/storefront/tests/toko-klien.test.ts
- [[QuoteRequest]] - code - apps/storefront/src/lib/toko-klien.ts
- [[QuoteVoucher]] - code - apps/storefront/src/lib/toko-klien.ts
- [[ReviewRequest]] - code - apps/storefront/src/lib/toko-klien.ts
- [[ShippingOption]] - code - apps/storefront/src/lib/toko-klien.ts
- [[UploadSession]] - code - apps/storefront/src/lib/toko-klien.ts
- [[ValidationErrorDetail]] - code - apps/storefront/src/lib/toko-klien.ts
- [[cancelOrder()]] - code - apps/storefront/src/lib/toko-klien.ts
- [[createOrder()]] - code - apps/storefront/src/lib/toko-klien.ts
- [[createPaymentProofUploadSession()]] - code - apps/storefront/src/lib/toko-klien.ts
- [[finalizePaymentProofUpload()]] - code - apps/storefront/src/lib/toko-klien.ts
- [[getOrder()]] - code - apps/storefront/src/lib/toko-klien.ts
- [[mockFetch()_1]] - code - apps/storefront/tests/toko-klien.test.ts
- [[quoteCart()]] - code - apps/storefront/src/lib/toko-klien.ts
- [[request()]] - code - apps/storefront/src/lib/toko-klien.ts
- [[submitPaymentConfirmation()]] - code - apps/storefront/src/lib/toko-klien.ts
- [[submitReview()]] - code - apps/storefront/src/lib/toko-klien.ts
- [[toko-klien.test.ts]] - code - apps/storefront/tests/toko-klien.test.ts
- [[toko-klien.ts]] - code - apps/storefront/src/lib/toko-klien.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Storefront_Commerce_Client
SORT file.name ASC
```

## Connections to other communities
- 7 edges to [[_COMMUNITY_Order Session & Phone]]
- 6 edges to [[_COMMUNITY_Cart Contract & WhatsApp Fallback]]
- 6 edges to [[_COMMUNITY_Order Tracking Script]]
- 3 edges to [[_COMMUNITY_Storefront Server & CSP]]
- 2 edges to [[_COMMUNITY_Storefront API Error]]

## Top bridge nodes
- [[toko-klien.ts]] - degree 40, connects to 5 communities
- [[toko-klien.test.ts]] - degree 12, connects to 2 communities
- [[quoteCart()]] - degree 6, connects to 2 communities
- [[request()]] - degree 10, connects to 1 community
- [[createOrder()]] - degree 5, connects to 1 community