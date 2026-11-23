---
bump: patch
type: docs
impact: public
---

# Commerce operations declare `429`, `Retry-After` and `Idempotency-Key` where their handlers apply them (#557)

Upstream's contract-parity test (ahliweb/awcms#1385) wants the public contract to say `429` (with `Retry-After`) and the `Idempotency-Key` header exactly where a handler applies them. The `commerce` OpenAPI fragment now does, for about a hundred operations, each checked against its handler:

- `429`: an operation whose handler rate-limits declares the shared `RateLimited` response (or `RateLimitedNoRetryAfter` where it sends no header); an operation that already declared an inline `429` keeps its description and gains the `Retry-After` header. `POST /commerce/orders/{id}/payments` and `POST /commerce/pos/orders` describe the stored-value lookup throttle they really answer.
- `Idempotency-Key`: the required `IdempotencyKey` component on the owner operations whose handler requires the header (affiliate commissions, campaign send/cancel, gateway reconcile) and `IdempotencyKeyOptional` on the storefront operations where the key is optional (address create, order cancel, payment confirmation, review, conversation, message, OTP verify). The prose that said the shared component was "required, wider" is replaced.
- `requireIdempotencyKey` in `expense-http.ts`, `documents-http.ts` and `booking-adapter-http.ts` is now a one-line forward instead of a bare `export { x } from`, so the static scan can see the header read of `register-http.ts`. No behaviour change.
- `apps/cms/tests/support/commerce-contract-parity-exemptions.ts` shrinks from about 100 entries to one, `POST /commerce/quotations/{id}/convert`, whose limiter the scan reaches only through a stored-value tender branch that conversion never takes. `AGENTS.md` (and its mirror) record it.

No runtime change. The bundle and the API reference are regenerated.
