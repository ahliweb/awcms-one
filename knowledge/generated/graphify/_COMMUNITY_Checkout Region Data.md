---
type: community
cohesion: 0.13
members: 30
---

# Checkout Region Data

**Cohesion:** 0.13 - loosely connected
**Members:** 30 nodes

## Members
- [[ADR-0002]] - concept - apps/storefront/src/lib/awcms/wilayah-checkout.ts
- [[ADR-0007_1]] - concept - apps/storefront/src/lib/awcms/wilayah-checkout.ts
- [[DEFAULT_PROVINCE_CODES]] - code - apps/storefront/src/lib/awcms/wilayah-checkout.ts
- [[GET()_7]] - code - apps/storefront/src/pages/index/wilayah-kabupaten-[provinceCode].json.ts
- [[GET()_8]] - code - apps/storefront/src/pages/index/wilayah-kecamatan-[cityCode].json.ts
- [[GET()_9]] - code - apps/storefront/src/pages/index/wilayah-provinsi.json.ts
- [[RegionsPage]] - code - apps/storefront/src/lib/awcms/wilayah-checkout.ts
- [[WilayahRegion]] - code - apps/storefront/src/lib/awcms/wilayah-checkout.ts
- [[configuredProvinceCodes()]] - code - apps/storefront/src/lib/awcms/wilayah-checkout.ts
- [[districtsCache]] - code - apps/storefront/src/lib/awcms/wilayah-checkout.ts
- [[getAllCheckoutRegencies()]] - code - apps/storefront/src/lib/awcms/wilayah-checkout.ts
- [[getCheckoutDistricts()]] - code - apps/storefront/src/lib/awcms/wilayah-checkout.ts
- [[getCheckoutProvinces()]] - code - apps/storefront/src/lib/awcms/wilayah-checkout.ts
- [[getCheckoutRegencies()]] - code - apps/storefront/src/lib/awcms/wilayah-checkout.ts
- [[getStaticPaths()_4]] - code - apps/storefront/src/pages/index/wilayah-kabupaten-[provinceCode].json.ts
- [[getStaticPaths()_5]] - code - apps/storefront/src/pages/index/wilayah-kecamatan-[cityCode].json.ts
- [[listRegions()]] - code - apps/storefront/src/lib/awcms/wilayah-checkout.ts
- [[matchesQuery()]] - code - apps/storefront/src/lib/awcms/wilayah-checkout.ts
- [[mockUnfilteredFetch()]] - code - apps/storefront/tests/wilayah-checkout.test.ts
- [[prerender_7]] - code - apps/storefront/src/pages/index/wilayah-kabupaten-[provinceCode].json.ts
- [[prerender_8]] - code - apps/storefront/src/pages/index/wilayah-kecamatan-[cityCode].json.ts
- [[prerender_9]] - code - apps/storefront/src/pages/index/wilayah-provinsi.json.ts
- [[regenciesCache]] - code - apps/storefront/src/lib/awcms/wilayah-checkout.ts
- [[region()]] - code - apps/storefront/tests/wilayah-checkout.test.ts
- [[resetWilayahCheckoutCachesForTests()]] - code - apps/storefront/src/lib/awcms/wilayah-checkout.ts
- [[wilayah-checkout.test.ts]] - code - apps/storefront/tests/wilayah-checkout.test.ts
- [[wilayah-checkout.ts]] - code - apps/storefront/src/lib/awcms/wilayah-checkout.ts
- [[wilayah-kabupaten-provinceCode.json.ts]] - code - apps/storefront/src/pages/index/wilayah-kabupaten-[provinceCode].json.ts
- [[wilayah-kecamatan-cityCode.json.ts]] - code - apps/storefront/src/pages/index/wilayah-kecamatan-[cityCode].json.ts
- [[wilayah-provinsi.json.ts]] - code - apps/storefront/src/pages/index/wilayah-provinsi.json.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Checkout_Region_Data
SORT file.name ASC
```

## Connections to other communities
- 4 edges to [[_COMMUNITY_AWCMS Build Client]]
- 1 edge to [[_COMMUNITY_Site Config & Env]]

## Top bridge nodes
- [[wilayah-checkout.ts]] - degree 23, connects to 2 communities
- [[configuredProvinceCodes()]] - degree 4, connects to 1 community