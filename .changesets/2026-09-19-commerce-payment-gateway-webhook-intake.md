---
bump: minor
type: structure
impact: public
---

# Payment gateway webhook intake, system-actor `paid`, and reconcile job (issue #113, C5 of #33)

Closes the payment-gateway loop issue #110 opened: `apps/cms` can now
actually learn that a hosted-checkout order was paid, from either an
inbound Midtrans callback or a scheduled poll, and applies it the same
way regardless of source.

- `POST /api/v1/commerce/webhooks/{provider}/{endpointToken}` — public,
  `POST`-only, tenant resolved from an opaque per-tenant token via the
  `SECURITY DEFINER` `awcms_resolve_commerce_webhook_endpoint` (`sql/926`).
  Unknown/revoked token, a provider mismatch, or no provider configured
  all answer the same padded-latency neutral `404`; a bad signature
  (`provider.verifyWebhook`) is `401`; a replayed event (`INSERT …
  ON CONFLICT DO NOTHING` on `awcms_commerce_payment_events` hitting zero
  rows) is a `200` no-op. The route never calls the provider's own
  `fetchStatus` — it only ever acts on what `verifyWebhook` already
  produced.
- `markOrderPaidBySystem` (`order-directory.ts`) — the new `system` actor
  edge `pending_payment -> paid`, alongside the existing `-> expired`.
  Idempotent (already-`paid`, or any status other than `pending_payment`,
  is a no-op). `paid -> refunded` is **deliberately never auto-applied** —
  there is no `refunded` order status at all; a gateway-reported refund is
  recorded as a payment event only, and an owner refunds manually via the
  existing admin `-> cancelled` action (see `order-status.ts`'s header and
  `docs/cms.md`'s payment-gateway runbook for the full reasoning).
- `commerce:payments:reconcile` job (every 1-2 minutes) — polls every
  gateway session still `pending` more than 2 minutes old via
  `provider.fetchStatus`, called with no database transaction open
  (timeout + circuit breaker live inside the adapter itself), and applies
  the same transition path the webhook uses; expires any session past its
  own `expires_at` regardless of what `fetchStatus` answers.
- Admin: the order list screen (`/admin/commerce-orders`) gains a
  per-row, read-only gateway session/payment-events panel and a "Cek
  status" button (`commerce.orders.update`, `Idempotency-Key` required)
  that triggers a scoped single-order reconcile
  (`POST /api/v1/commerce/orders/{id}/payment-gateway/reconcile`) rather
  than the full batch job.
- `ROUTE_PARITY_EXEMPTIONS` (`apps/cms/scripts/api-spec-check.ts`) drops
  the webhook path now that it has a handler; the OpenAPI doc gains the
  request body schema and the new reconcile-one-order path.

Documented in `docs/cms.md` (operator runbook: minting an endpoint,
pointing Midtrans's dashboard at it, the `COMMERCE_MIDTRANS_*`/
`COMMERCE_WEBHOOK_RATE_LIMIT_*` env vars, how the reconcile job works),
`docs/deployment.md`, `docs/api.md`, and the commerce module README (all
with their Indonesian mirrors).
