---
type: community
cohesion: 0.16
members: 22
---

# Theme Token Fetch

**Cohesion:** 0.16 - loosely connected
**Members:** 22 nodes

## Members
- [[ADR-0009]] - concept - apps/storefront/src/lib/awcms/theme.ts
- [[DEFAULT_THEME_COLORS]] - code - apps/storefront/src/config/site.ts
- [[FIXTURE_CSS]] - code - apps/storefront/tests/theme.test.ts
- [[GET()_15]] - code - apps/storefront/src/pages/theme-tokens.css.ts
- [[ThemeColors]] - code - apps/storefront/src/lib/awcms/theme.ts
- [[WCAG_AA_TEXT_CONTRAST]] - code - apps/storefront/src/lib/warna.ts
- [[apiOrigin()]] - code - apps/storefront/src/lib/awcms/theme.ts
- [[contrastRatio()]] - code - apps/storefront/src/lib/warna.ts
- [[contrastingForeground()]] - code - apps/storefront/src/lib/warna.ts
- [[extractThemeToken()]] - code - apps/storefront/src/lib/awcms/theme.ts
- [[fetchSiteTheme()]] - code - apps/storefront/src/lib/awcms/theme.ts
- [[getSiteTheme()]] - code - apps/storefront/src/lib/awcms/theme.ts
- [[isValidHexColor()]] - code - apps/storefront/src/lib/warna.ts
- [[prerender_15]] - code - apps/storefront/src/pages/theme-tokens.css.ts
- [[relativeLuminance()]] - code - apps/storefront/src/lib/warna.ts
- [[resetSiteThemeCacheForTests()]] - code - apps/storefront/src/lib/awcms/theme.ts
- [[tenantCode()]] - code - apps/storefront/src/lib/awcms/theme.ts
- [[theme-tokens.css.ts]] - code - apps/storefront/src/pages/theme-tokens.css.ts
- [[theme.test.ts]] - code - apps/storefront/tests/theme.test.ts
- [[theme.ts]] - code - apps/storefront/src/lib/awcms/theme.ts
- [[warna.test.ts]] - code - apps/storefront/tests/warna.test.ts
- [[warna.ts]] - code - apps/storefront/src/lib/warna.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Theme_Token_Fetch
SORT file.name ASC
```

## Connections to other communities
- 4 edges to [[_COMMUNITY_Site Config & Env]]
- 4 edges to [[_COMMUNITY_Catalog Fetch Client]]
- 3 edges to [[_COMMUNITY_AWCMS Build Client]]
- 3 edges to [[_COMMUNITY_Base Layout & Site Identity]]
- 1 edge to [[_COMMUNITY_Flash Sale Countdown]]

## Top bridge nodes
- [[theme.ts]] - degree 15, connects to 3 communities
- [[warna.test.ts]] - degree 8, connects to 2 communities
- [[isValidHexColor()]] - degree 5, connects to 2 communities
- [[warna.ts]] - degree 8, connects to 1 community
- [[contrastingForeground()]] - degree 7, connects to 1 community