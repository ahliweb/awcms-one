---
bump: patch
type: fix
impact: public
---

# Storefront build no longer floods the CMS with 56 concurrent region requests

`apps/storefront`'s `/index/wilayah-kecamatan-{code}.json` route fetched the
districts of every regency under every configured province in one
`Promise.all` — 56 concurrent `GET /api/v1/idn-regions/regions?level=3` calls
with the default `PUBLIC_WILAYAH_PROVINSI`. `apps/cms` admits at most 40
`interactive` requests at once (8 running + a bounded queue of 32,
`apps/cms/src/lib/database/work-class.ts`) and rejects the rest with a 503, so a
build against a real, seeded CMS failed deterministically with 16
`database.pool.rejected` — while every stub-backed gate stayed green, because
the stub never refuses anything. Found while verifying issue #57 against the
local database (issue #71).

- Every region request in `apps/storefront/src/lib/awcms/wilayah-checkout.ts`
  now passes through one module-level, dependency-free concurrency limiter
  (`MAX_IN_FLIGHT_REGION_REQUESTS` = 6). The bound lives inside the one function
  every request goes through, not in the routes, so no present or future caller
  can fan out past it by forgetting a helper; the routes' `Promise.all` stays,
  fanning out promises rather than requests.
- Why 6: under the CMS's 8 *running* `interactive` slots, not merely under the
  40 it admits — the region walk never queues on an idle CMS and leaves room
  for the rest of the same `astro build` and the CMS's own admin users.
- Fewer, bigger calls were considered and rejected: the route filters
  `parentCode` as an exact match on the direct parent and documents `after`
  only as "the last code of the previous page", so a province-wide level-3
  walk would mean either walking the whole country or inventing cursor
  semantics the API does not promise.
- `apps/storefront/tests/wilayah-checkout.test.ts` asserts the ceiling over the
  real 56-regency fan-out with a mocked client; `apps/storefront/README.md`
  documents the ceiling and the CMS limit it stays under.
