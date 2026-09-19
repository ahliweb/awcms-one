---
type: community
cohesion: 0.18
members: 27
---

# Site Profile & Base Layout

**Cohesion:** 0.18 - loosely connected
**Members:** 27 nodes

## Members
- [[ADR-0102]] - concept - apps/storefront/src/lib/awcms/profil.ts
- [[BaseLayout.astro]] - code - apps/storefront/src/layouts/BaseLayout.astro
- [[ComposedSiteIdentity]] - code - apps/storefront/src/lib/awcms/profil.ts
- [[EMPTY_PAYLOAD]] - code - apps/storefront/src/lib/awcms/profil.ts
- [[NAV_CARDS]] - code - apps/storefront/src/pages/akun/index.astro
- [[SiteIdentity]] - code - apps/storefront/src/lib/awcms/profil.ts
- [[SocialLink]] - code - apps/storefront/src/lib/awcms/profil.ts
- [[afiliasi.astro]] - code - apps/storefront/src/pages/akun/afiliasi.astro
- [[akunindex.astro]] - code - apps/storefront/src/pages/akun/index.astro
- [[akunpesanan.astro]] - code - apps/storefront/src/pages/akun/pesanan.astro
- [[alamat.astro]] - code - apps/storefront/src/pages/akun/alamat.astro
- [[checkout.astro]] - code - apps/storefront/src/pages/checkout.astro
- [[daftar.astro]] - code - apps/storefront/src/pages/daftar.astro
- [[fetchSiteIdentity()]] - code - apps/storefront/src/lib/awcms/profil.ts
- [[flash-sale.astro]] - code - apps/storefront/src/pages/flash-sale.astro
- [[getSiteIdentity()]] - code - apps/storefront/src/lib/awcms/profil.ts
- [[getStoreSettings()]] - code - apps/storefront/src/lib/awcms/pemasaran.ts
- [[isExpectedRefusal()_1]] - code - apps/storefront/src/lib/awcms/profil.ts
- [[jsonForScript()]] - code - apps/storefront/src/layouts/BaseLayout.astro
- [[keranjang.astro]] - code - apps/storefront/src/pages/keranjang.astro
- [[kontak.astro]] - code - apps/storefront/src/pages/kontak.astro
- [[masuk.astro]] - code - apps/storefront/src/pages/masuk.astro
- [[pagespesanan.astro]] - code - apps/storefront/src/pages/pesanan.astro
- [[profil.ts]] - code - apps/storefront/src/lib/awcms/profil.ts
- [[resetSiteIdentityCacheForTests()]] - code - apps/storefront/src/lib/awcms/profil.ts
- [[ulasan.astro]] - code - apps/storefront/src/pages/akun/ulasan.astro
- [[warnDegraded()]] - code - apps/storefront/src/lib/awcms/profil.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Site_Profile__Base_Layout
SORT file.name ASC
```

## Connections to other communities
- 17 edges to [[_COMMUNITY_routes.ts]]
- 15 edges to [[_COMMUNITY_Marketing Data (Flash Sales, Vouchers, Settings)]]
- 9 edges to [[_COMMUNITY_Portable Text & Static Pages]]
- 9 edges to [[_COMMUNITY_Homepage & Derived CSP Artifact]]
- 7 edges to [[_COMMUNITY_Build-Time CMS Client & Region Data]]
- 6 edges to [[_COMMUNITY_BeritaLayout.astro]]
- 5 edges to [[_COMMUNITY_Site Config, Sitemaps & Theme]]
- 5 edges to [[_COMMUNITY_Site Profile Merge Test]]
- 4 edges to [[_COMMUNITY_Product & Category Pages, Product JSON-LD]]
- 4 edges to [[_COMMUNITY_Article Pages & News JSON-LD]]
- 4 edges to [[_COMMUNITY_Newsletter Forms & Visitor Beacon]]
- 3 edges to [[_COMMUNITY_Root RSS Feed]]
- 3 edges to [[_COMMUNITY_Catalog Data & Product Index]]
- 2 edges to [[_COMMUNITY_Share Row & Social Icons]]
- 2 edges to [[_COMMUNITY_navigasi-berita.ts]]
- 2 edges to [[_COMMUNITY_slugfeed.xml.ts]]
- 2 edges to [[_COMMUNITY_Cart Page & WhatsApp Fallback]]
- 2 edges to [[_COMMUNITY_Static Server & Legacy Redirect Rules]]
- 1 edge to [[_COMMUNITY_Price Formatting & Product Cards]]
- 1 edge to [[_COMMUNITY_Client-Side Search & Listing Renderer]]
- 1 edge to [[_COMMUNITY_Flash Sale Countdown]]
- 1 edge to [[_COMMUNITY_Commerce Storefront Client & Order Tracking]]
- 1 edge to [[_COMMUNITY_Wishlist Storage & Account Sync]]
- 1 edge to [[_COMMUNITY_GA4 Init]]
- 1 edge to [[_COMMUNITY_Affiliate Referral Capture]]
- 1 edge to [[_COMMUNITY_Account Affiliate Page Script]]
- 1 edge to [[_COMMUNITY_Account Address Book Script]]
- 1 edge to [[_COMMUNITY_Account Dashboard Script]]
- 1 edge to [[_COMMUNITY_akun-pesanan.ts]]
- 1 edge to [[_COMMUNITY_akun-ulasan.ts]]
- 1 edge to [[_COMMUNITY_Checkout Flow & Phone Preview]]
- 1 edge to [[_COMMUNITY_Registration Page Script]]
- 1 edge to [[_COMMUNITY_Login (OTP) Page Script & Request Plumbing]]

## Top bridge nodes
- [[BaseLayout.astro]] - degree 42, connects to 14 communities
- [[profil.ts]] - degree 48, connects to 13 communities
- [[getSiteIdentity()]] - degree 28, connects to 8 communities
- [[flash-sale.astro]] - degree 9, connects to 6 communities
- [[getStoreSettings()]] - degree 19, connects to 3 communities