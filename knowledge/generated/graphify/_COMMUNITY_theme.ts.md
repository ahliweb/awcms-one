---
type: community
cohesion: 0.20
members: 15
---

# theme.ts

**Cohesion:** 0.20 - loosely connected
**Members:** 15 nodes

## Members
- [[ADR-0009]] - concept - apps/storefront/src/lib/awcms/theme.ts
- [[DEFAULT_THEME_COLORS]] - code - apps/storefront/src/config/site.ts
- [[FIXTURE_CSS]] - code - apps/storefront/tests/theme.test.ts
- [[GET()_6]] - code - apps/storefront/src/pages/manifest.webmanifest.ts
- [[ThemeColors]] - code - apps/storefront/src/lib/awcms/theme.ts
- [[apiOrigin()]] - code - apps/storefront/src/lib/awcms/theme.ts
- [[extractThemeToken()]] - code - apps/storefront/src/lib/awcms/theme.ts
- [[fetchSiteTheme()]] - code - apps/storefront/src/lib/awcms/theme.ts
- [[getSiteTheme()]] - code - apps/storefront/src/lib/awcms/theme.ts
- [[manifest.webmanifest.ts]] - code - apps/storefront/src/pages/manifest.webmanifest.ts
- [[prerender_6]] - code - apps/storefront/src/pages/manifest.webmanifest.ts
- [[resetSiteThemeCacheForTests()]] - code - apps/storefront/src/lib/awcms/theme.ts
- [[tenantCode()]] - code - apps/storefront/src/lib/awcms/theme.ts
- [[theme.test.ts]] - code - apps/storefront/tests/theme.test.ts
- [[theme.ts]] - code - apps/storefront/src/lib/awcms/theme.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/themets
SORT file.name ASC
```

## Connections to other communities
- 4 edges to [[_COMMUNITY_readEnv]]
- 4 edges to [[_COMMUNITY_warna.ts]]
- 3 edges to [[_COMMUNITY_profil.ts]]
- 2 edges to [[_COMMUNITY_site.ts]]

## Top bridge nodes
- [[theme.ts]] - degree 15, connects to 3 communities
- [[DEFAULT_THEME_COLORS]] - degree 3, connects to 2 communities
- [[getSiteTheme()]] - degree 6, connects to 1 community
- [[manifest.webmanifest.ts]] - degree 6, connects to 1 community
- [[apiOrigin()]] - degree 3, connects to 1 community