---
"awcms": minor
---

feat(commerce): WhatsApp outbox + Fonnte/Meta adapters, OTP via WhatsApp, login by phone (Issue #108, contract #106/ADR-0017 D5)

`commerce` gains a second provider outbox modelled on `email` (ADR-0017 D1): `awcms_commerce_whatsapp_messages`/`awcms_commerce_whatsapp_delivery_attempts` (`sql/925`), a claim/send/finalize dispatcher (`bun run commerce:whatsapp:dispatch`) with the same lease/retry/circuit-breaker shape as `email-dispatch.ts`, and a retention purge (`bun run commerce:whatsapp:purge`). Two real adapters — Fonnte (`COMMERCE_WHATSAPP_PROVIDER=fonnte`) and the Meta WhatsApp Cloud API (`meta`) — plus a `log` adapter for dev/CI, resolved by `COMMERCE_WHATSAPP_PROVIDER`/gated by `COMMERCE_WHATSAPP_ENABLED`.

`CustomerOtpChannel` gains a third adapter, `whatsapp`: `POST .../account/otp/request` accepts `via?: "email"|"whatsapp"` (default `email`); `via: "whatsapp"` requires `phone`, only ever supports `purpose: "login"` (registration stays e-mail OTP only), and answers `409 CHANNEL_UNAVAILABLE` — before an OTP is ever issued — when the tenant has no WhatsApp channel configured (configuration, not enumeration). `POST .../account/otp/verify` accepts `phone` as an alternative to `email`; a phone-keyed OTP resolves the account via `findAccountByPhone`. `awcms_commerce_customer_otps` gains a nullable `phone_normalized` column (`email_normalized`'s own `NOT NULL` relaxed to a CHECK that at least one identifier is present).

New owner diagnostics: `GET /api/v1/commerce/whatsapp/messages` (`commerce.whatsapp.read`) plus a minimal `/admin/commerce-whatsapp` screen — masked phone only, never the raw number/rendered body/OTP code.

- `to_phone` is kept in the clear in the outbox (same reasoning `customers.phone` already documents — a provider adapter cannot deliver a message knowing only a hash), alongside `to_phone_hash`/`to_phone_masked`.
- Module-local WhatsApp template registry (`commerce.customer_otp`/`commerce.order_paid`/`commerce.campaign`) — `{{var}}` rendering with a per-template variable allowlist; only `commerce.customer_otp` is wired to a caller in this issue.
- New env vars: `COMMERCE_WHATSAPP_ENABLED`, `COMMERCE_WHATSAPP_PROVIDER`, `COMMERCE_WHATSAPP_SEND_TIMEOUT_MS`, `COMMERCE_WHATSAPP_SEND_MAX_RETRIES`, `COMMERCE_FONNTE_TOKEN`, `COMMERCE_FONNTE_API_BASE_URL`, `COMMERCE_META_WA_TOKEN`, `COMMERCE_META_WA_PHONE_NUMBER_ID`, `COMMERCE_META_WA_OTP_TEMPLATE`, `COMMERCE_META_WA_API_BASE_URL`.
