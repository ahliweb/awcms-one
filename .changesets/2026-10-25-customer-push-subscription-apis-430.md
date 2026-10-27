---
bump: minor
type: content
impact: public
---

# Customer Web Push: tenant-isolated device subscription APIs

[Issue #430](https://github.com/ahliweb/awcms-one/issues/430), the first implementation step of [ADR-0048](../docs/adr/0048-customer-web-push-identity-subscription-and-cross-origin-contract.md). A shopper's browser can now be enrolled, listed and revoked for push notifications, and consent is recorded per purpose. **Nothing is sent yet and nothing is on:** the per-tenant `customerPush` commerce feature defaults to off (every route then answers the neutral `404`), the storefront UI and service worker are #431, the consumers and the dispatch loop are #432, and production activation stays gated (counsel's review of the consent wording, VAPID and key ring, the operator test matrix, device UAT; ADR-0048 D8).

The "why" of the shape: a customer is not a tenant user, so upstream's staff push tables cannot carry a customer recipient without a shadow user, and the browser endpoint is personal data (UU PDP) and a bearer-grade capability. `commerce` therefore owns four additive tables (`sql/1056`–`1059`, FORCE RLS, composite tenant keys, least-privilege worker grants) and writes no upstream table.

- New routes under `/api/v1/commerce/storefront/account/push/` (`subscriptions` GET/POST/DELETE, `subscriptions/{id}` DELETE, `preferences` GET/PUT), bearer only; and `GET /api/v1/commerce/customer-push/diagnostics` behind the new permission `commerce.customer_push.read` (aggregate counts only). OpenAPI regenerated.
- The endpoint and the auth secret are stored only as AES-256-GCM envelopes under the existing `PUSH_AUTH_SECRET_ENCRYPTION_KEYS` ring with customer-specific AAD purposes, shown only masked, and destroyed on revoke, logout, block and session end. Only a known browser push service host is accepted (Google, Mozilla, Apple, Microsoft); the new operator setting `COMMERCE_CUSTOMER_PUSH_EXTRA_ENDPOINT_HOSTS` can extend that list, a tenant or request cannot. Five devices per account; 12 notifications per hour and 40 per day per account in the outbox repository.
- Registration is idempotent; registering another account's endpoint is an atomic, audited transfer. Logout and the admin customer block revoke devices in their own transaction. Audit events: `commerce.customer_push.{device_registered,device_transferred,device_revoked,preferences_changed,data_erased}`, ids only.
- The customer bearer lookup now names the tenant in the query (`findSessionByTokenHash`), on top of FORCE RLS.
- New jobs `commerce:customer-push:maintenance` (every 15 minutes: ended-session and blocked-account sweep, 30-day purge) and `commerce:customer-push:rekey` (manual). New `customerPush` flag in `/admin/commerce-settings`.
- Customer push data is registered for subject erasure and export (`eraseCustomerPushData`, `exportCustomerPushData`); the data-subject engine cannot reach a customer account, so the descriptors say so.
- Docs (English and Indonesian): ADR-0048 implementation record, `cms`, `api`, `kamus-data`, `skema-basis-data`, `deployment`, `status`, `SECURITY`, the commerce module README.
