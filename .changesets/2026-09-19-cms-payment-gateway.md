---
bump: minor
type: structure
impact: public
---

# Payment gateway — schema, Midtrans Snap adapter, session endpoint, webhook endpoint tokens (C3)

Issue #110 (part of epic #33, C3; contract #106's D2/D3, ADR-0017). The second
external-provider integration under `commerce`, following the same
`rajaongkir-provider.ts` shape #107 established: a port + adapters, credentials
env-only per deployment, `withTimeout` + `getProviderCircuitBreaker`, provider calls
never inside a DB transaction (ADR-0006/0010).

**Schema** (`apps/cms/sql/926_awcms_commerce_payment_gateway_schema.sql`):
`awcms_commerce_payment_gateway_sessions` (one row per hosted-checkout attempt,
`UNIQUE (provider, provider_ref)`), `awcms_commerce_payment_events` (the D2
replay-protection ledger, `UNIQUE (tenant_id, provider, event_key)` — no writer yet,
the webhook INTAKE route is #113's own scope), `awcms_commerce_webhook_endpoints`
(a hashed opaque token per (tenant, provider)); `orders` gains `gateway_provider`/
`gateway_ref`. All three new tables `FORCE RLS`, indexed for the generic
purge/batching path, `awcms_worker`-granted. A `SECURITY DEFINER`
`awcms_resolve_commerce_webhook_endpoint(token_hash)` mirrors
`awcms_resolve_tenant_domain_lookup`'s bootstrap pattern exactly (dedicated NOLOGIN
owner role, a scoped read policy, EXECUTE restricted to `awcms_app`) — the bootstrap
lookup the webhook INTAKE route will use, before any tenant context exists.

**Domain**: `payment-gateway-provider.ts` (the `PaymentGatewayProvider` port —
`createSession`/`fetchStatus`/`verifyWebhook`), `midtrans-signature.ts`
(`sha512(order_id + status_code + gross_amount + ServerKey)`, timing-safe compare),
`gateway-status-mapping.ts` (Midtrans `transaction_status`/`fraud_status` →
`paid|pending|expired|failed|refunded`), `payment.gateway = {enabled}` added to
`store-settings-validation.ts`.

**Application** (`payment-gateway-directory.ts`): `createGatewaySession(sql,
tenantId, orderCode, auth, provider, providerKey)` — validate the order (gateway
method, `pending_payment`) and check for a still-live session in one short
transaction, call the provider with NONE open, persist in a second short
transaction; a genuinely concurrent double-create is caught by the `(provider,
provider_ref)` UNIQUE constraint and re-fetches the winner rather than 500ing.
Auth is `{phone}` or a customer bearer, matching `POST .../orders`'s own optional-
bearer pattern; a wrong phone, unknown order, or a live bearer for a different
order's owner all answer the SAME neutral 404 the order-tracking route uses.
Adapters `infrastructure/midtrans-provider.ts` (Snap `POST /snap/v1/transactions`,
`GET /v2/{orderId}/status`, sandbox/production base URLs by
`COMMERCE_MIDTRANS_IS_PRODUCTION`, both env-overridable) and
`log-payment-gateway-provider.ts` (no network call; `redirectUrl` is
`${COMMERCE_STOREFRONT_PUBLIC_URL}/pesanan?kode=...&gateway=log`; `fetchStatus`
answers `paid` once 60 real seconds have elapsed since creation, via an injectable
clock and a timestamp folded into `providerRef` — deterministic, no sleeping in
tests), resolved by `COMMERCE_PAYMENT_GATEWAY=midtrans|log` (`log` refused outside
non-production).

**Quote/order**: `POST .../cart/quote`'s `paymentMethods[]` gains `{method:
"gateway", available}` — `true` only when `payment.gateway.enabled` AND a
`PaymentGatewayProvider` is configured; `POST .../orders`'s `payment.method:
"gateway"` was already accepted by the orders schema and validator (additive,
already-shipped columns/checks), unchanged here.

**Routes**: `POST .../storefront/orders/{orderCode}/payment-gateway/sessions`
(anonymous, rate-limited, `409 PAYMENT_NOT_APPLICABLE` for a non-gateway/non-payable
order, `503 GATEWAY_UNAVAILABLE` when no provider is configured); owner
`GET|POST /api/v1/commerce/webhook-endpoints` (masked list; the raw token is
returned exactly once at creation, hashed at rest — deliberately NOT
idempotency-keyed, the same reasoning `machine-credential-directory.ts`'s issuance
route already gives) and `DELETE .../webhook-endpoints/{id}` (revoke, idempotent);
both gated on the new `commerce.webhook_endpoints.update` permission.

**Store settings / admin**: owner `PUT /store-settings` gains `payment.gateway`;
the public `payment.gatewayEnabled` is derived the same way `shipping.courierEnabled`
already is. `/admin/commerce-settings` gains a gateway-enable toggle and a
webhook-endpoints panel (list/create/revoke, built entirely from the shared
`onSubmit`/`onAction`/`mutateAndReload` admin-form-client helpers
`machine-credentials.astro` already established — no new lifecycle code).
`APP_BUDGET_BYTES` raised from 231,500 to 232,000 B for this genuinely new control
— reasoning recorded in that file's own docblock.

**Tests**: unit (Midtrans signature, status mapping, both adapters against a local
fake HTTP server / an injected clock, a static-text contract test on the migration's
SQL for the SECURITY DEFINER function) and integration against a real migrated
database (session creation idempotent with the `log` provider, phone- and
bearer-based auth, the neutral-404 mismatch cases, the 409 non-applicable case, the
webhook-endpoint token round-trip through the SECURITY DEFINER lookup with a revoked
token no longer resolving, RLS isolation for both new resource kinds) —
`apps/cms/tests/integration/commerce-payment-gateway.integration.test.ts`.

OpenAPI: the three DRAFT paths from #106 (`.../payment-gateway/sessions`,
`.../webhook-endpoints`, `.../webhook-endpoints/{id}`) are now backed by real
handlers and removed from `ROUTE_PARITY_EXEMPTIONS`; `CommerceWebhookEndpoint`
gains `label`/`revokedAt`; the revoke response is `200 {endpoint}` (not `204`) to
match this module's own DELETE convention; bundled.

Out of scope, explicitly: the webhook INTAKE route itself
(`POST /api/v1/commerce/webhooks/midtrans/{token}`), `markOrderPaidBySystem`, and
the `commerce:payments:reconcile` job — all #113.
