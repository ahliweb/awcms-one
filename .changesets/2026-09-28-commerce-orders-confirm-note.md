---
bump: minor
type: structure
impact: public
---

# Commerce orders: confirm status changes with an optional note, translated labels

Issue #246, part of the commerce admin v2 epic. `commerce-orders.astro`
changed an order's status with no confirmation at all, even though
`PATCH /api/v1/commerce/orders/{id}/status` already accepted and recorded
an optional `note` (up to 500 characters) on the order timeline — the UI
never collected it.

- The status-save flow now opens Issue #242's `CommerceConfirmDialog` with
  its optional note field before PATCHing, naming the order code and the
  from → to status (`"{orderCode} will move from {from} to {to}."`). The
  TO status is only known once the operator changes the `<select>`, so the
  message is composed server-side with a literal `{to}` placeholder left
  unsubstituted on purpose (`src/lib/i18n/catalog.ts`'s own `interpolate()`
  leaves an unmatched placeholder verbatim) and finished client-side from
  a server-rendered, translated label map carried as JSON in
  `data-order-status-meta` — never translated in the browser. A target
  status with no outgoing edge in the domain's own transition graph
  (`completed`, `cancelled`, `expired` — derived at render time from
  `LEGAL_ORDER_STATUS_TRANSITIONS`, never a second hardcoded list) styles
  the confirm as `danger`. The note is sent in the existing `note` field,
  trimmed, only when non-empty; its 500-character ceiling matches the
  endpoint's own `.slice(0, 500)`. Cancelling the dialog leaves the
  `<select>` at whatever the operator had chosen and sends nothing — the
  least surprising outcome, since forcing it back to the order's current
  status would erase a choice the operator might still want to re-confirm.
- Adds `readConfirmOptionsWithNote`/`confirmFromTriggerWithNote` to
  `apps/cms/src/lib/ui/commerce-confirm-dialog-client.ts`, additively —
  the note variant of the existing `readConfirmOptions`/`confirmFromTrigger`
  pair, reading the same `data-confirm-note-label`/`-note-max-length`/
  `-note-placeholder` attributes `CommerceConfirmDialog`'s note field
  already accepts. No existing caller's behaviour changes.
- Every raw enum render on the orders list and the order detail page
  (status filter tabs, badge, `<option>` text, payment status, channel,
  timeline entry status, and the client-rendered payment-gateway
  panel's session provider/status and payment-event provider/outcome)
  now goes through Issue #243's `commerce-admin-labels.ts` instead of a
  raw database value or each screen's own local `STATUS_TONE` map (now
  identical to the shared `orderStatusTone`, so it is removed rather than
  kept alongside it). Every translated render keeps the underlying raw
  value in a `data-*` attribute (`data-status`, `data-channel`,
  `data-payment-status`, or `setAttribute("data-raw-*", ...)` for the
  JS-rendered gateway fields) rather than discarding it. The gateway
  panel's translated maps travel to the browser as JSON in
  `data-gateway-labels` — the same shape on both screens.
- `apps/cms/scripts/client-asset-budget.ts`'s `APP_BUDGET_BYTES` raised
  265,000 -> 266,500 B (measured 266,095 B) for the two screens' larger
  client scripts (label-lookup/JSON-dataset plumbing) and a handful of new
  i18n catalogue entries; docblock entry added in the same style as every
  prior commerce raise. No new component, no new stylesheet.
- New msgids: `"Change order status?"`, `"{orderCode} will move from
  {from} to {to}."`, `"Note (optional)"` — English + natural Indonesian
  (`"Ubah status pesanan?"` / `"{orderCode} akan berpindah dari {from} ke
  {to}."` / `"Catatan (opsional)"`).
- Tests: `apps/cms/tests/commerce-orders-confirm-note-246.test.ts` — pure
  helper tests for `readConfirmOptionsWithNote` plus the static contract of
  both screens (status-save goes through the note dialog and never a
  hand-built options literal, the note's max length matches the endpoint,
  cancelling sends nothing, every listed render site is translated with
  its raw value kept in `data-*`, no English confirm literal, no
  `window.confirm`). `commerce-confirm-dialog.test.ts`'s own
  `UNTOUCHED_SCREENS` list is updated: `commerce-orders.astro` was the one
  screen it deliberately left for a later issue, and this is that issue.

No other commerce admin screen is touched by this change.
