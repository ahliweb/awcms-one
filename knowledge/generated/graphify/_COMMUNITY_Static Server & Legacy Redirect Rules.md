---
type: community
cohesion: 0.05
members: 80
---

# Static Server & Legacy Redirect Rules

**Cohesion:** 0.05 - loosely connected
**Members:** 80 nodes

## Members
- [[ADR-0002_2]] - concept - apps/storefront/src/lib/csp-asal-media.ts
- [[CACHE_ASSET]] - code - apps/storefront/server/penyaji.mjs
- [[CACHE_PAGE]] - code - apps/storefront/server/penyaji.mjs
- [[CSP]] - code - apps/storefront/server/penyaji.mjs
- [[CspOriginsArtifact]] - code - apps/storefront/src/lib/csp-asal-media.ts
- [[DAERAH_ENTRIES]] - code - apps/storefront/server/pengalihan-aturan.mjs
- [[DAERAH_NAMES]] - code - apps/storefront/server/pengalihan-aturan.mjs
- [[DAERAH_SLUG_BY_ALIAS]] - code - apps/storefront/server/pengalihan-aturan.mjs
- [[EMPTY_SET]] - code - apps/storefront/server/penyaji.mjs
- [[GA_CONNECT_SRC]] - code - apps/storefront/server/penyaji.mjs
- [[GA_IMG_SRC]] - code - apps/storefront/server/penyaji.mjs
- [[HSTS]] - code - apps/storefront/server/penyaji.mjs
- [[MITRA_BORNEO_NAMES]] - code - apps/storefront/server/pengalihan-aturan.mjs
- [[PERMISSIONS_POLICY]] - code - apps/storefront/server/penyaji.mjs
- [[PRODUCTION_HEADERS]] - code - apps/storefront/server/penyaji.mjs
- [[ROW_ID_INDEX_CACHE]] - code - apps/storefront/server/pengalihan-aturan.mjs
- [[ROW_MAP]] - code - apps/storefront/tests/pengalihan-aturan.test.ts
- [[ROW_MAP_SYNTHETIC_VIDEO_KEYS]] - code - apps/storefront/tests/pengalihan-aturan.test.ts
- [[RUBRIK_SLUG_ALIASES]] - code - apps/storefront/server/pengalihan-aturan.mjs
- [[SECURITY_HEADERS]] - code - apps/storefront/server/penyaji.mjs
- [[STATIC_PAGE_REDIRECTS]] - code - apps/storefront/server/pengalihan-aturan.mjs
- [[UMUM_NAMES]] - code - apps/storefront/server/pengalihan-aturan.mjs
- [[applyHeaders()]] - code - apps/storefront/server/penyaji.mjs
- [[berita-penyaji-legacy.test.ts]] - code - apps/storefront/tests/berita-penyaji-legacy.test.ts
- [[buildCsp()]] - code - apps/storefront/server/penyaji.mjs
- [[buildCspOriginsArtifact()]] - code - apps/storefront/src/lib/csp-asal-media.ts
- [[cacheControlFor()]] - code - apps/storefront/server/penyaji.mjs
- [[canonicalRubrikSlug()]] - code - apps/storefront/server/pengalihan-aturan.mjs
- [[collectOrigins()]] - code - apps/storefront/src/lib/csp-asal-media.ts
- [[createServer()]] - code - apps/storefront/server/penyaji.mjs
- [[csp-asal-media.ts]] - code - apps/storefront/src/lib/csp-asal-media.ts
- [[decodeSegment()]] - code - apps/storefront/server/pengalihan-aturan.mjs
- [[discoverCssPreloadPaths()]] - code - apps/storefront/server/penyaji.mjs
- [[discoverShadowedHtmlPaths()]] - code - apps/storefront/server/penyaji.mjs
- [[findNewsRowTargetById()]] - code - apps/storefront/server/pengalihan-aturan.mjs
- [[findVideoRowTargetById()]] - code - apps/storefront/server/pengalihan-aturan.mjs
- [[fixtureDir()]] - code - apps/storefront/tests/katalog-csp-media.test.ts
- [[ga-csp.test.ts]] - code - apps/storefront/tests/ga-csp.test.ts
- [[ga.test.ts]] - code - apps/storefront/tests/ga.test.ts
- [[ga.ts]] - code - apps/storefront/src/lib/ga.ts
- [[isHealthzRequest()]] - code - apps/storefront/server/penyaji.mjs
- [[isProductsRedirect()]] - code - apps/storefront/server/penyaji.mjs
- [[isValidGaMeasurementId()]] - code - apps/storefront/src/lib/ga.ts
- [[katalog-csp-media.test.ts]] - code - apps/storefront/tests/katalog-csp-media.test.ts
- [[lastPathSegment()]] - code - apps/storefront/server/pengalihan-aturan.mjs
- [[legacyRedirectLocation()]] - code - apps/storefront/server/penyaji.mjs
- [[normalizeSlugSegment()]] - code - apps/storefront/server/pengalihan-aturan.mjs
- [[normalizedPath()]] - code - apps/storefront/server/penyaji.mjs
- [[originOf()]] - code - apps/storefront/src/lib/csp-asal-media.ts
- [[ownKeys()]] - code - apps/storefront/tests/pengalihan-aturan.test.ts
- [[parseLegacyUrl()]] - code - apps/storefront/server/pengalihan-aturan.mjs
- [[pengalihan-aturan.mjs]] - code - apps/storefront/server/pengalihan-aturan.mjs
- [[pengalihan-aturan.test.ts]] - code - apps/storefront/tests/pengalihan-aturan.test.ts
- [[penyaji-bayangan-html.test.ts]] - code - apps/storefront/tests/penyaji-bayangan-html.test.ts
- [[penyaji.mjs]] - code - apps/storefront/server/penyaji.mjs
- [[penyaji.test.ts]] - code - apps/storefront/tests/penyaji.test.ts
- [[preloadLinkHeaderValue()]] - code - apps/storefront/server/penyaji.mjs
- [[readBuildId()]] - code - apps/storefront/server/penyaji.mjs
- [[readCspOrigins()]] - code - apps/storefront/server/penyaji.mjs
- [[readGaMeasurementId()]] - code - apps/storefront/src/lib/ga.ts
- [[readLegacyRedirectMap()]] - code - apps/storefront/server/penyaji.mjs
- [[resolveImgQuery()]] - code - apps/storefront/server/pengalihan-aturan.mjs
- [[resolveRubriksQuery()]] - code - apps/storefront/server/pengalihan-aturan.mjs
- [[resolveSearchQuery()]] - code - apps/storefront/server/pengalihan-aturan.mjs
- [[resolveTwoSegmentHtml()]] - code - apps/storefront/server/pengalihan-aturan.mjs
- [[resolveVideoQuery()]] - code - apps/storefront/server/pengalihan-aturan.mjs
- [[rowIdIndexFor()]] - code - apps/storefront/server/pengalihan-aturan.mjs
- [[ruleBasedRedirectLocation()]] - code - apps/storefront/server/pengalihan-aturan.mjs
- [[run()_4]] - code - apps/storefront/server/penyaji.mjs
- [[sanitizeOrigins()]] - code - apps/storefront/server/penyaji.mjs
- [[securityHeaders()]] - code - apps/storefront/server/penyaji.mjs
- [[securityHeadersWithCsp()]] - code - apps/storefront/server/penyaji.mjs
- [[shadowedHtmlUrl()]] - code - apps/storefront/server/penyaji.mjs
- [[toko-csp.test.ts]] - code - apps/storefront/tests/toko-csp.test.ts
- [[twoSegmentHtmlMatch()]] - code - apps/storefront/server/pengalihan-aturan.mjs
- [[withServer()]] - code - apps/storefront/tests/berita-penyaji-legacy.test.ts
- [[withServer()_2]] - code - apps/storefront/tests/penyaji-bayangan-html.test.ts
- [[withServer()_1]] - code - apps/storefront/tests/penyaji.test.ts
- [[writeFixtureTree()]] - code - apps/storefront/tests/penyaji-bayangan-html.test.ts
- [[writeHealthzResponse()]] - code - apps/storefront/server/penyaji.mjs

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Static_Server__Legacy_Redirect_Rules
SORT file.name ASC
```

## Connections to other communities
- 6 edges to [[_COMMUNITY_Homepage & Derived CSP Artifact]]
- 3 edges to [[_COMMUNITY_Build-Time CMS Client & Region Data]]
- 2 edges to [[_COMMUNITY_Newsletter Forms & Visitor Beacon]]
- 2 edges to [[_COMMUNITY_Site Profile & Base Layout]]

## Top bridge nodes
- [[ga.ts]] - degree 8, connects to 3 communities
- [[readGaMeasurementId()]] - degree 7, connects to 3 communities
- [[csp-asal-media.ts]] - degree 8, connects to 1 community
- [[buildCspOriginsArtifact()]] - degree 6, connects to 1 community
- [[toko-csp.test.ts]] - degree 6, connects to 1 community