---
bump: patch
type: fix
impact: public
---

# Commerce storefront CORS exposes `Retry-After`

A cross-origin storefront could see a `429` from `/api/v1/commerce/storefront/*` but not read how long to wait: `Retry-After` is not a CORS-safelisted response header, so `headers.get("retry-after")` returned `null` and the shopper only saw "try again later". Found by the notification settings page of Issue #431.

- Every granted commerce CORS answer now carries `Access-Control-Expose-Headers: retry-after` (same-origin and refused answers are unchanged: still only `Vary: Origin`).
- Still no `*` and no `Access-Control-Allow-Credentials` in this family; a new unit test pins all three.
