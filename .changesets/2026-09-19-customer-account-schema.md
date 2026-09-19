---
bump: minor
type: structure
impact: internal
---

# Customer account, OTP and session schema (C1)

Issue #87 (part of #32; contract #86/ADR-0016 — this awcms repo's own ADR,
not yet written): the first slice of storefront customer accounts — schema,
domain and application layer only, no HTTP routes yet (those are Issue
#89's).

- `apps/cms/sql/917_awcms_commerce_customer_accounts_schema.sql` and
  `apps/cms/sql/918_awcms_commerce_customer_auth_worker_lifecycle_purge_grants.sql`:
  three new tenant-scoped, FORCE-RLS tables —
  `awcms_commerce_customer_accounts` (1:1 with an existing guest
  `awcms_commerce_customers` row, no password, ever), `awcms_commerce_customer_otps`
  (6-digit e-mail OTP, hashed, 10-minute TTL, 5 attempts) and
  `awcms_commerce_customer_sessions` (opaque `cs_` bearer token, only its
  hash stored, 30-day sliding TTL).
- New pure domain functions (`customer-otp.ts`, `customer-session-token.ts`,
  `customer-account-validation.ts`) and an application store
  (`customer-account-store.ts`) implementing ADR-0016 D4's `history_from`
  rule and a race-free, single-`UPDATE` OTP attempt counter.
- A new scheduled job, `commerce:customer-auth:purge`, deleting expired
  OTPs and expired/long-revoked sessions.
- Why now, separately from the HTTP layer: the schema/domain/store are the
  part every later slice (login, registration, session guard) depends on,
  and landing them first keeps each later PR small and independently
  reviewable.
