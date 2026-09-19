---
bump: minor
type: docs
impact: internal
---

# ADR-0017 + OpenAPI contract for external providers — payment gateway, courier rates, WhatsApp, POS, reports, inbox, campaigns

Epic #33 (external providers) needed its ten architectural decisions settled and its
API contract argued through review **before** any handler exists, so C1–C9 (issues
#107–#118) code against a contract already reviewed and settled instead of
re-deciding it issue by issue.

- [ADR-0017](../docs/adr/0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md)
  records the integration pattern (a port + adapters inside `commerce`, modelled on
  `email`, env-per-deployment credentials), inbound webhooks (token-addressed,
  `SECURITY DEFINER`-resolved, replay-protected), the payment gateway (a
  `PaymentGatewayProvider` port, Midtrans Snap first, redirect-based storefront
  flow), courier rates (a `ShippingRateProvider` port, RajaOngkir, a 6-hour cached
  rate), WhatsApp (an outbox, Fonnte + Meta Cloud API adapters, a third
  `CustomerOtpChannel` adapter), POS, reports, an inbox, campaigns, and the
  module-settings feature flags plus tiered pricing at quote.
- `apps/cms/openapi/modules/commerce.openapi.yaml` gains the payment-gateway
  session endpoint and public webhook intake, courier/gateway fields on the
  existing cart-quote/order/store-settings paths, a WhatsApp `via` option on OTP
  request, POS order creation, three `reporting`-hosted sales projections, a
  customer inbox (bearer + owner sides), and campaign CRUD/preview/send/cancel.
  Every new path is listed by name in `ROUTE_PARITY_EXEMPTIONS`
  (`apps/cms/scripts/api-spec-check.ts`), each entry citing the child issue that
  removes it, and exactly two new operations (the webhook intake and the
  payment-gateway session endpoint) join `ALLOWED_PUBLIC_OPERATIONS`.
- `docs/api.md` documents the new "External providers — planned — #107–#118"
  table and updates the "Not built" line to say the contract now exists
  (ADR-0017, issue #106) even though no handler does yet; the commerce module's
  README gains a matching "contract only" section.
