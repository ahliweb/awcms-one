---
type: community
cohesion: 0.10
members: 45
---

# Storefront Server & CSP

**Cohesion:** 0.10 - loosely connected
**Members:** 45 nodes

## Members
- [[dot-constructor()_1]] - code - apps/storefront/src/lib/awcms/toko-origin.ts
- [[ADR-0002_1]] - concept - apps/storefront/src/lib/csp-asal-media.ts
- [[ADR-0007]] - concept - apps/storefront/src/lib/awcms/toko-origin.ts
- [[AwcmsOriginConfigError]] - code - apps/storefront/src/lib/awcms/toko-origin.ts
- [[CACHE_ASSET]] - code - apps/storefront/server/penyaji.mjs
- [[CACHE_PAGE]] - code - apps/storefront/server/penyaji.mjs
- [[CSP]] - code - apps/storefront/server/penyaji.mjs
- [[CspOriginsArtifact]] - code - apps/storefront/src/lib/csp-asal-media.ts
- [[HSTS]] - code - apps/storefront/server/penyaji.mjs
- [[PERMISSIONS_POLICY]] - code - apps/storefront/server/penyaji.mjs
- [[PRODUCTION_HEADERS]] - code - apps/storefront/server/penyaji.mjs
- [[SECURITY_HEADERS]] - code - apps/storefront/server/penyaji.mjs
- [[applyHeaders()]] - code - apps/storefront/server/penyaji.mjs
- [[berita-penyaji-legacy.test.ts]] - code - apps/storefront/tests/berita-penyaji-legacy.test.ts
- [[buildCsp()]] - code - apps/storefront/server/penyaji.mjs
- [[buildCspOriginsArtifact()]] - code - apps/storefront/src/lib/csp-asal-media.ts
- [[cacheControlFor()]] - code - apps/storefront/server/penyaji.mjs
- [[collectOrigins()]] - code - apps/storefront/src/lib/csp-asal-media.ts
- [[createServer()]] - code - apps/storefront/server/penyaji.mjs
- [[csp-asal-media.ts]] - code - apps/storefront/src/lib/csp-asal-media.ts
- [[discoverCssPreloadPaths()]] - code - apps/storefront/server/penyaji.mjs
- [[fixtureDir()]] - code - apps/storefront/tests/katalog-csp-media.test.ts
- [[isHealthzRequest()]] - code - apps/storefront/server/penyaji.mjs
- [[isProductsRedirect()]] - code - apps/storefront/server/penyaji.mjs
- [[katalog-csp-media.test.ts]] - code - apps/storefront/tests/katalog-csp-media.test.ts
- [[legacyRedirectLocation()]] - code - apps/storefront/server/penyaji.mjs
- [[normalizedPath()]] - code - apps/storefront/server/penyaji.mjs
- [[originOf()]] - code - apps/storefront/src/lib/csp-asal-media.ts
- [[penyaji.mjs]] - code - apps/storefront/server/penyaji.mjs
- [[penyaji.test.ts]] - code - apps/storefront/tests/penyaji.test.ts
- [[preloadLinkHeaderValue()]] - code - apps/storefront/server/penyaji.mjs
- [[readBuildId()]] - code - apps/storefront/server/penyaji.mjs
- [[readCspOrigins()]] - code - apps/storefront/server/penyaji.mjs
- [[readLegacyRedirectMap()]] - code - apps/storefront/server/penyaji.mjs
- [[requireAwcmsOrigin()]] - code - apps/storefront/src/lib/awcms/toko-origin.ts
- [[run()_4]] - code - apps/storefront/server/penyaji.mjs
- [[sanitizeOrigins()]] - code - apps/storefront/server/penyaji.mjs
- [[securityHeaders()]] - code - apps/storefront/server/penyaji.mjs
- [[securityHeadersWithCsp()]] - code - apps/storefront/server/penyaji.mjs
- [[toko-csp.test.ts]] - code - apps/storefront/tests/toko-csp.test.ts
- [[toko-origin.test.ts]] - code - apps/storefront/tests/toko-origin.test.ts
- [[toko-origin.ts]] - code - apps/storefront/src/lib/awcms/toko-origin.ts
- [[withServer()]] - code - apps/storefront/tests/berita-penyaji-legacy.test.ts
- [[withServer()_1]] - code - apps/storefront/tests/penyaji.test.ts
- [[writeHealthzResponse()]] - code - apps/storefront/server/penyaji.mjs

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Storefront_Server__CSP
SORT file.name ASC
```

## Connections to other communities
- 6 edges to [[_COMMUNITY_Marketing Read Models]]
- 3 edges to [[_COMMUNITY_Storefront Commerce Client]]
- 2 edges to [[_COMMUNITY_AWCMS Build Client]]
- 1 edge to [[_COMMUNITY_Site Config & Env]]

## Top bridge nodes
- [[toko-origin.ts]] - degree 9, connects to 4 communities
- [[requireAwcmsOrigin()]] - degree 8, connects to 3 communities
- [[csp-asal-media.ts]] - degree 8, connects to 1 community
- [[buildCspOriginsArtifact()]] - degree 6, connects to 1 community