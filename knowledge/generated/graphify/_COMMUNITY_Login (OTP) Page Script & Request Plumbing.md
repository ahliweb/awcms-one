---
type: community
cohesion: 0.16
members: 19
---

# Login (OTP) Page Script & Request Plumbing

**Cohesion:** 0.16 - loosely connected
**Members:** 19 nodes

## Members
- [[dot-constructor()_5]] - code - apps/storefront/src/lib/toko-permintaan.ts
- [[dot-fieldErrors()]] - code - apps/storefront/src/lib/toko-permintaan.ts
- [[dot-retryAfterSeconds()]] - code - apps/storefront/src/lib/toko-permintaan.ts
- [[Envelope_2]] - code - apps/storefront/src/lib/toko-permintaan.ts
- [[STOREFRONT_PATH_PREFIX]] - code - apps/storefront/src/lib/toko-permintaan.ts
- [[TokoApiError]] - code - apps/storefront/src/lib/toko-permintaan.ts
- [[ValidationErrorDetail]] - code - apps/storefront/src/lib/toko-permintaan.ts
- [[clearFieldErrors()_2]] - code - apps/storefront/src/scripts/masuk.ts
- [[hideSubmitError()_6]] - code - apps/storefront/src/scripts/masuk.ts
- [[masuk.ts]] - code - apps/storefront/src/scripts/masuk.ts
- [[root_12]] - code - apps/storefront/src/scripts/masuk.ts
- [[sendCode()_1]] - code - apps/storefront/src/scripts/masuk.ts
- [[showCodeStep()_1]] - code - apps/storefront/src/scripts/masuk.ts
- [[showStatus()_2]] - code - apps/storefront/src/scripts/masuk.ts
- [[showSubmitError()_6]] - code - apps/storefront/src/scripts/masuk.ts
- [[showWaFallback()_2]] - code - apps/storefront/src/scripts/masuk.ts
- [[startResendCountdown()_1]] - code - apps/storefront/src/scripts/masuk.ts
- [[toko-permintaan.ts]] - code - apps/storefront/src/lib/toko-permintaan.ts
- [[validKembaliPath()]] - code - apps/storefront/src/scripts/masuk.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Login_OTP_Page_Script__Request_Plumbing
SORT file.name ASC
```

## Connections to other communities
- 6 edges to [[_COMMUNITY_akun-pesanan.ts]]
- 5 edges to [[_COMMUNITY_Customer Session Store]]
- 4 edges to [[_COMMUNITY_Account API Client]]
- 4 edges to [[_COMMUNITY_Registration Page Script]]
- 4 edges to [[_COMMUNITY_Commerce Storefront Client & Order Tracking]]
- 3 edges to [[_COMMUNITY_Checkout Flow & Phone Preview]]
- 2 edges to [[_COMMUNITY_Newsletter Forms & Visitor Beacon]]
- 2 edges to [[_COMMUNITY_routes.ts]]
- 2 edges to [[_COMMUNITY_Account Dashboard Script]]
- 2 edges to [[_COMMUNITY_Account Affiliate Page Script]]
- 2 edges to [[_COMMUNITY_Account Address Book Script]]
- 2 edges to [[_COMMUNITY_akun-ulasan.ts]]
- 1 edge to [[_COMMUNITY_Cart Page & WhatsApp Fallback]]
- 1 edge to [[_COMMUNITY_Site Profile & Base Layout]]

## Top bridge nodes
- [[toko-permintaan.ts]] - degree 18, connects to 11 communities
- [[TokoApiError]] - degree 17, connects to 10 communities
- [[masuk.ts]] - degree 23, connects to 7 communities
- [[sendCode()_1]] - degree 7, connects to 1 community
- [[showWaFallback()_2]] - degree 4, connects to 1 community