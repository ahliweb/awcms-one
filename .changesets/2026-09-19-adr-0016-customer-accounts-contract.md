---
bump: minor
type: docs
impact: internal
---

# ADR-0016 + OpenAPI contract for customer accounts, OTP, bearer sessions, affiliates

Epic #32 (customer accounts) needed its four architectural decisions settled and its
API contract argued through review **before** any handler exists, so C2–C4 (issues
#87–#93) code against a contract already reviewed and settled instead of re-deciding
it wave by wave.

- [ADR-0016](../docs/adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md)
  records identity (a `commerce` row, never `awcms_principals`), the OTP channel
  (e-mail now, WhatsApp deferred to #33), the bearer session transport (opaque
  token, `localStorage`, 30-day sliding TTL), the guest-row registration binding
  rule, the affiliate program's fresh design, and what stays explicitly out of scope.
- `apps/cms/openapi/modules/commerce.openapi.yaml` gains the full
  `/api/v1/commerce/storefront/account/*` surface plus the staff-side
  `/api/v1/commerce/affiliates*` routes, a new `customerBearer` security scheme kept
  deliberately separate from the staff `bearerAuth`/session schemes, and an optional
  bearer + `affiliateCode` on the existing anonymous order/review endpoints.
  Every new path is listed by name in `ROUTE_PARITY_EXEMPTIONS`
  (`apps/cms/scripts/api-spec-check.ts`) because no route file exists yet — each
  entry is removed the moment its own handler lands.
- `docs/api.md` documents the new "Customer accounts — planned — #87–#93" table and
  updates the "Not built" line to say the contract now exists (ADR-0016, issue #86)
  even though no handler does yet.
