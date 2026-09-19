---
bump: minor
type: structure
impact: public
---

# Payment gateway checkout — "Bayar sekarang" + polling (issue #112, S2 of #33)

Checkout gains a fourth, redirect-based payment method — "Bayar online
(kartu, VA, e-wallet)" — and `/pesanan`/`/akun/pesanan` gain a live-polled
"Bayar sekarang" retry path. Coded against the contract
[issue #106](https://github.com/ahliweb/awcms-one/issues/106) (D3) names, so
wiring `apps/cms`'s own Midtrans Snap adapter in later needs no storefront
change.

- Checkout lists `Bayar online (kartu, VA, e-wallet)` whenever the quote's
  `paymentMethods[]` includes `gateway`. Placing the order is unchanged; a
  separate `createGatewaySession` call then sends the whole tab to the
  session's `redirectUrl` (`window.location.assign`, never an embed) —
  validated as `https:` (or `http:` only when this build's own
  `PUBLIC_AWCMS_ORIGIN` is itself `http:`, i.e. the local/CI stub). Any
  failure falls through to `/pesanan?kode=` instead, never a checkout error.
- `/pesanan` and `/akun/pesanan`'s detail view render a "Bayar sekarang"
  button in place of manual-transfer instructions for a `gateway` order
  still `pending_payment`, with an `aria-live="polite"` status line
  ("Menunggu konfirmasi pembayaran…" → "Pembayaran diterima.") and a 5-second
  poller (`apps/storefront/src/lib/pesanan-poll.ts`) that stops once the
  order leaves `pending_payment`, once its `expiresAt` passes, after 15
  minutes, or pauses (never stops) while the tab is hidden.
- `toko-klien.ts` gains `createGatewaySession`, `PaymentMethodAvailability`/
  `OrderPaymentInput` gain `"gateway"`, and `Order` gains an optional
  `gateway?: {provider, status}`.
- `apps/storefront/scripts/stub-awcms.mjs` lists `gateway` when
  `payment.gatewayEnabled` is on, mints an idempotent-per-order session
  pointing at its own hosted `GET /stub/gateway/{id}` page ("Bayar
  (simulasi)"/"Batal"), and redirects back to `/pesanan?kode=…` either way.

A pure `nextPollDecision` scheduler (`apps/storefront/src/lib/pesanan-poll.ts`)
and `isValidGatewayRedirectUrl` (`apps/storefront/src/lib/gateway-redirect.ts`)
are both unit-tested with no DOM/timer at all;
`apps/storefront/tests/e2e/checkout.e2e.ts` gains a full gateway scenario
against the stub's own hosted page.
