---
bump: minor
type: fix
impact: public
---

# Registration and login are safe against double submit (server side)

A customer who taps "Daftar" twice, or whose phone retries a slow request, no longer risks a `500`, a false "phone already registered", two sessions from one code or two e-mails (Issue #513, work unit B; the storefront guard is unit A).

- **The OTP is single-use under concurrency.** The consume is one `UPDATE ... WHERE ... AND consumed_at IS NULL RETURNING`; before, a verify that started before the first one committed also matched the already-consumed row, so two concurrent verifies of one code both succeeded and issued two sessions. The second is now `401 OTP_INVALID`.
- **Race-safe registration.** Registrations are serialised per e-mail and per phone (advisory locks), and `createAccountForCustomer` throws a typed `CustomerAccountUniqueViolationError` (savepoint) that `verifyCustomerOtp` resolves to the existing account. Concurrent registrations for one phone used to end in a raw unique-violation `500`; now the loser is `409 PHONE_ALREADY_REGISTERED`. A registration whose e-mail already has an account is a login, never `PHONE_ALREADY_REGISTERED`.
- **Optional `Idempotency-Key` on `POST .../account/otp/verify`** (`[A-Za-z0-9_-]{16,128}`, otherwise `400 IDEMPOTENCY_KEY_INVALID`). The same key and request within 10 minutes answers `200` with `data.replayed: true` and a FRESH session for the same account; a different request under the key is `409 IDEMPOTENCY_CONFLICT`. Stored in the shared `awcms_idempotency_keys` as `(tenant, HMAC of the key, HMAC request digest, {outcome, accountId})`: never the raw key, the code or a session token. No migration.
- **Resend window on `POST .../account/otp/request`.** A repeat for the same registration inside 60 seconds is a no-op success (same response shape, no second e-mail or WhatsApp message, no new audit row). Rate limits are unchanged.
- OpenAPI, the commerce README (EN + ID), `docs/api.md` (EN + ID, with the classification of every mutating storefront endpoint) and `docs/cms.md` (EN + ID) describe the real behaviour.
