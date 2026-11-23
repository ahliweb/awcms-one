---
bump: minor
type: feat
impact: public
---

# The landing profile builds without CMS credentials

A `SITE_PROFILE=landing` storefront build with `AWCMS_API_URL` unset no longer fails: one helper, `buildsWithoutCms()` (`apps/storefront/src/lib/awcms/tanpa-cms.ts`), answers true only for that combination, and the build-time readers the landing profile reaches return their empty value without a network call: the static page list (empty) and a single page (`null`), the site identity (defaults plus `SITE_NAME` / `SITE_DESCRIPTION`), the store settings (empty settings) and the media public origin (unconfigured). The page set is the profile's own pages and `/csp.json` is still derived.

- No change for `toko` and `berita` (a missing `AWCMS_API_URL` still fails with the existing message) or for `landing` with a CMS configured; `client.ts` is untouched.
- `PUBLIC_AWCMS_ORIGIN` stays required on every profile because it is also the CSP `connect-src`.
- `apps/storefront/tests/tanpa-cms.test.ts` pins the helper and each reader's early return with every `fetch` forbidden.
