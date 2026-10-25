---
bump: minor
type: content
impact: public
---

# Storefront: reservation detail with its deposit state, and the cancellation and refund dialog

`/akun/reservasi?kode=<orderCode>` now shows one own reservation (issue #387, epic #280 item 16; `docs/booking-ux-flows.md` surfaces B and C): the stay, the status and payment pills, the deposit and balance rows exactly as the server's settlement returns them, the refund line, "Bayar uang muka" / "Bayar sisa pembayaran" through the existing gateway session, and "Batalkan reservasi".

- **The refund is the server's, shown before confirming.** The cancel dialog (a native `<dialog>`; no `confirm()`) reads `GET …/cancellation-quote` and shows the amount paid, the policy window, the refund and what is retained. Nothing is cancelled by opening it.
- **The quote is read again on confirm.** A changed refund is shown and needs a fresh confirmation; an unchanged one is sent as `acknowledgedRefund`, the only body field, under one `Idempotency-Key` per figure. A cancel whose answer was lost is replayed with the same key instead of asking for a new quote. No guest control sets an amount.
- **Refusals in the words of the spec:** 409 `QUOTE_CHANGED` / `INVALID_STATE` / `IDEMPOTENCY_CONFLICT`, 400/422, 429, 401, 404 and a dropped connection each have their copy and next action.
- **Accessible:** focus moves into the dialog and returns to the opener, `Escape` closes without cancelling, results are announced in `role="status"`, refusals in `role="alert"`, and the dialog fits 360px. Checked with axe and a 360px overflow test in `apps/storefront/tests/e2e/booking.e2e.ts`.
- **No CMS change.** The routes and OpenAPI entries of #381 are used as published. The stub CMS gains the cancellation quote and cancel routes for the e2e suite.
- **Not covered:** per-allocation payment history, the policy table before paying, the concrete cut-off date, and real-device screen-reader checks (see `docs/booking-ux-flows.md`).
