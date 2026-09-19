---
bump: minor
type: structure
impact: public
---

# Customer account auth endpoints — OTP request/verify, me, logout (C2)

Issue #89 (part of #32; contract #86/ADR-0016): the storefront's first four
`/api/v1/commerce/storefront/account/*` routes actually run. Built on #87's
schema/domain/store.

- `POST otp/request` — validates `{email, purpose, name?, phone?}` (register
  runs the full registration validator before an e-mail ever goes out), then
  always issues a code and always asks a new `CustomerOtpChannel` port to
  deliver it, answering `202 {sent:true, expiresInSeconds}` for every outcome
  (ADR-0016 D2's anti-enumeration rule); rate-limited 10/IP/h + 5/e-mail/h,
  env-tunable (`COMMERCE_ACCOUNT_OTP_RATE_LIMIT_*`).
- `POST otp/verify` — collapses every OTP failure reason into one
  `401 OTP_INVALID`; `purpose: "login"` with no account answers
  `404 ACCOUNT_NOT_FOUND`; `purpose: "register"` checks the phone against
  every existing account before binding (D4), answering
  `409 PHONE_ALREADY_REGISTERED` on conflict; a blocked account cannot
  verify into a session (`403 ACCOUNT_BLOCKED`). Success mints an opaque
  `cs_…` bearer session (D3) and answers `200 {token, expiresAt, account}`.
  Rate-limited 20/IP/h.
- `GET`/`PATCH me`, `POST logout` — bearer-secured via a new
  `application/customer-session-auth.ts` guard; a blocked account can still
  log out.
- `CustomerOtpChannel` (`domain/customer-otp-channel.ts`): an `email`
  adapter enqueues into `email`'s outbox, inside the same transaction as the
  OTP row, under a new derived category `derived.commerce_customer_otp`
  (`sql/919` seeds an EN+ID template per existing tenant); a `log` adapter
  (selected when `EMAIL_PROVIDER=log`/`EMAIL_ENABLED` isn't `"true"`) keeps
  dev/CI working without mail credentials. `commerce` gains a dependency on
  `email` for this.
- Commerce CORS preflight (`domain/commerce-cors.ts`) now accepts an
  `allowedHeaders` list, so the bearer routes' `OPTIONS` grants
  `authorization` alongside `content-type` — still no
  `Access-Control-Allow-Credentials` anywhere in the family.
- Audit events (masked e-mail/phone, never a code/token):
  `commerce.customer.otp_requested`, `otp_verified`, `login_failed`,
  `account_registered`, `logout`.
- The four implemented paths are removed from `ROUTE_PARITY_EXEMPTIONS`
  (`apps/cms/scripts/api-spec-check.ts`); OpenAPI/docs regenerated.
- Fixes a latent bug in #87's `consumeOtp`: the `registration` jsonb column
  round-tripped through `Bun.SQL`'s `UPDATE … RETURNING` as a raw JSON
  string rather than a parsed object, which #87's own tests never exercised
  far enough to notice — caught by this issue's integration suite.
