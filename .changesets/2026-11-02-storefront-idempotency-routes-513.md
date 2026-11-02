---
bump: minor
type: fix
impact: public
---

# The other mutating storefront endpoints are safe against double submit (server side)

A shopper who double-taps "Simpan alamat", "Kirim", "Konfirmasi pembayaran", "Batalkan pesanan" or "Kirim ulasan", or whose phone retries a slow request, no longer ends up with a duplicate record or a confusing error (Issue #513, work unit C; unit B did registration, unit A the storefront guard).

- **Optional `Idempotency-Key` on six routes:** `POST account/addresses`, `account/conversations`, `account/conversations/{id}/messages`, `orders/{code}/payment-confirmations`, `orders/{code}/cancel` and `reviews`. Same shape as `otp/verify` (`[A-Za-z0-9_-]{16,128}`, else `400 IDEMPOTENCY_KEY_INVALID`). The same key and request within one hour answers the original success again with `data.replayed: true`; the same key with a different request (another order, conversation, phone or text) is `409 IDEMPOTENCY_CONFLICT`, never the stored answer. Scoped per tenant, per route and, for the bearer routes, per account; concurrent same-key requests create one record. A replay does not spend the per-account message limit and writes one `commerce.storefront.idempotency_replayed` audit event (never the key). Stored in the shared `awcms_idempotency_keys` (no migration): the key only as an HMAC, the request as an HMAC digest, a marker or the owner's own `201` body, never a token.
- **Cancelling an already-cancelled order is a success.** It answered `409 ORDER_NOT_CANCELLABLE` to a retrying customer, and two concurrent cancels both ran the transition (two `cancelled` events, two audit rows, a second restock). The order row is now locked while it is cancelled and a repeat answers `200` with the order; any other refusal is unchanged.
- **Concurrent first address no longer ends in a `500`.** Two simultaneous address creates for a customer with no address raced into the default-address unique index; creates are now serialised per customer, so the 10-address limit also holds under concurrency.
- **`POST reviews`:** the unique index already prevented a duplicate row; a keyed retry now replays the `201` with the same review id instead of `409 REVIEW_NOT_ALLOWED`. Without a key nothing changes.
- **CORS:** every one of the six routes lists `idempotency-key` in its preflight (never `*`, no allow-credentials header); a browser blocks the header otherwise.
- OpenAPI, `docs/api.md` (EN + ID, with the classification of each route) and the commerce README (EN + ID) describe the real behaviour.
