🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.id.md)

# ADR-0010 — Manual payment and alternative courier first; gateways and aggregators arrive through the outbox

- **Status:** Accepted
- **Date:** 16 September 2026
- **Decision maker:** ahliweb
- **Related:** `apps/cms/AGENTS.md` ("Outbox/queue untuk integrasi eksternal"); issues #26, #29, #30, #33, #106, #109, #112

## Context

The live store has manual bank transfer, manual QRIS, a payment gateway (configured `none`), down-payment, RajaOngkir courier rates, a flat "BORNEOJEK" courier at Rp 15.000, and self-pickup. Only manual QRIS, the alternative courier and self-pickup are actually active on the live site today.

## Decision

Increment 2 implements exactly what is active: manual bank transfer and manual QRIS (payment proof uploaded by the customer, accepted or rejected by an admin), down-payment when the product allows it, alternative courier services with a flat cost, and self-pickup. The order status machine (`pending_payment → paid → processing → shipped → completed`, with `cancelled`/`expired` reachable from `pending_payment`) is built so that a gateway webhook later transitions `pending_payment → paid` through the same `order-status.ts` rules an admin uses today. RajaOngkir and a payment gateway are external providers and — per `apps/cms`'s standing rule — must be called through the outbox, never synchronously on the order path; they are #33, with their own ADR each.

| | Gateway + aggregator now | Manual + flat courier now (**chosen**) |
| --- | --- | --- |
| Operational complexity | two provider accounts, webhooks, secrets, sandbox/production split | none beyond the store's existing bank/QRIS |
| Security | webhook signature verification, replay protection, PCI-adjacent handling | payment proof is an image reviewed by a person |
| Time to a working order | blocked on provider onboarding | immediate |
| Long-term | same tables either way; the status machine is provider-agnostic | the `payment_method` enum already names `gateway`; adding it is additive |

## Consequences

- Unpaid orders expire (`commerce:orders:expire` job, every 1–5 minutes) and restock their line items, un-redeeming any voucher through the same code path a customer's own cancel already runs; the expiry window is a store setting (`orders.expiryHours`).
- The payment-proof upload path (`POST .../orders/{code}/payment-proof/upload-sessions`) answers `503 MEDIA_UNAVAILABLE` in this increment — the existing `media_library` upload-session flow needs an authenticated `actorTenantUserId`, which an anonymous storefront caller does not have; `payment.proofUpload: false` on the public store-settings read model tells the storefront to hide the control, and a payment confirmation without a proof image is still fully accepted.
- Checkout showed courier options as "segera" (disabled) until [issue #109](https://github.com/ahliweb/awcms-one/issues/109) (S1 of #33) gave the storefront real, per-destination courier rates against a stub-backed fixture — the same UI shape this ADR anticipated, now filled in: real rates once a district is chosen, the same single disabled placeholder (now carrying a `note`) when courier is off, no destination yet, or the provider cannot price it. `apps/cms`'s own RajaOngkir provider adapter — the contract [issue #106](https://github.com/ahliweb/awcms-one/issues/106) (D4) names — was the remaining half of #33 at the time this consequence was written; [issue #107](https://github.com/ahliweb/awcms-one/issues/107) landed it (see the **Status — 19 September 2026** note below), and this storefront change needed no UI change once it did.
- [Issue #112](https://github.com/ahliweb/awcms-one/issues/112) (S2 of #33) gave the storefront the gateway half this ADR named as future work ("the `payment_method` enum already names `gateway`; adding it is additive"): `Bayar online (kartu, VA, e-wallet)` at checkout, a redirect-based flow (`window.location.assign` a hosted page's `redirectUrl`, never an embed — #106's own D3 decision, "Snap.js embed (CSP), form-POST handoff (`form-action 'self'`)" were both rejected), and `/pesanan`/`/akun/pesanan` polling the order every 5 s with a "Bayar sekarang" retry path while `pending_payment`. `apps/cms`'s own Midtrans Snap adapter — [issue #106](https://github.com/ahliweb/awcms-one/issues/106) (D3), [#110](https://github.com/ahliweb/awcms-one/issues/110)/[#113](https://github.com/ahliweb/awcms-one/issues/113) — was the remaining half at the time this consequence was written; those two issues landed it (see the **Status** note below), and `apps/storefront/scripts/stub-awcms.mjs` continues to stand in for it in dev/CI with its own hosted "Bayar (simulasi)"/"Batal" page.

## Status — 19 September 2026

Both halves this ADR left open are done, closing epic [#33](https://github.com/ahliweb/awcms-one/issues/33) (D4/D2/D3 of contract [#106](https://github.com/ahliweb/awcms-one/issues/106), recorded fully in [ADR-0017](0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md)): [issue #107](https://github.com/ahliweb/awcms-one/issues/107) shipped the RajaOngkir `ShippingRateProvider` adapter and its rate cache (`sql/924`); [issues #110](https://github.com/ahliweb/awcms-one/issues/110)/[#113](https://github.com/ahliweb/awcms-one/issues/113) shipped the Midtrans Snap `PaymentGatewayProvider` adapter, the token-addressed public webhook intake route, and the `commerce:payments:reconcile` job (`sql/926`, `sql/934`). Both providers are called exactly as this ADR specified — never inside a database transaction, and never on the order path synchronously.
