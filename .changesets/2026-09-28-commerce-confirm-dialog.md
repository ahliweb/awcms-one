---
bump: minor
type: content
impact: public
---

# An accessible, fully-translated confirm dialog replaces `window.confirm()` on ten commerce admin screens

Part of the commerce admin v2 epic (LK admin v2 parity, issue #242). Eleven
`window.confirm()` calls across ten `apps/cms` commerce admin screens —
categories, campaigns (send + cancel), affiliates (approve/pay/void
commission), popup, products, reviews, sliders, testimonials, vouchers,
flash sales — are replaced by one shared, commerce-owned accessible dialog,
with every string an operator reads translated through `t()`.

- New `apps/cms/src/components/CommerceConfirmDialog.astro`: a native
  `<dialog role="alertdialog">`, rendered once per page, with
  `aria-labelledby`/`aria-describedby` wired to its own title/message
  regions, an optional (hidden-by-default) note `<textarea>` region for a
  future note-taking confirm, and Cancel/Confirm buttons reusing the
  existing `.btn-secondary`/`.btn-primary`/`.btn-danger`/`.btn-danger--solid`
  classes — no new button chrome invented.
- New `apps/cms/src/lib/ui/commerce-confirm-dialog-client.ts`:
  `confirmCommerceAction`/`confirmCommerceActionWithNote` drive the dialog
  via `showModal()` (focus trap, Escape-to-cancel, backdrop, focus
  restoration to the opener all free), explicitly focusing the safe Cancel
  button first for a `danger` action. Falls back to `window.confirm` only
  when `HTMLDialogElement`/`showModal()` is unsupported or the dialog is
  missing from the page — the one remaining reference, documented as such.
  Pure option-normalization/note-trimming helpers are exported separately
  and unit-tested without a DOM.
- **No English literal ever reaches a screen's `<script>`.** Every trigger
  button (delete/send/cancel/approve/pay/void) carries its own
  `t()`-translated `data-confirm-title`/`-message`/`-label`/`-danger`
  attributes, rendered server-side with any per-row value (a SKU, a name, a
  code) already interpolated via the catalogue's `{placeholder}` syntax. The
  new `confirmFromTrigger(el)` reads them back — the ONLY thing a screen's
  `<script>` calls; the pure `readConfirmOptions(dataset)` half is
  unit-tested without a DOM. Natural, professional Indonesian copy for all
  thirteen trigger actions is in `id.po` (e.g. "Hapus produk?" / "Produk
  {sku} akan dipindahkan ke sampah dan dapat dipulihkan nanti." / "Hapus
  produk"; "Kirim kampanye" is not danger, "Batalkan kampanye" is).
- Affiliate commission approve/pay gained a confirmation they never had
  before ("Setujui komisi"/"Tandai dibayar", both non-`danger`) alongside
  void ("Batalkan komisi", `danger`) — a small UX addition, not a backend
  change, made possible by the same trigger now existing on all three
  buttons.
- A campaign send stays non-`danger` (styled as the ordinary primary
  action); a campaign cancel, every affiliate void, and every delete action
  are `danger` (styled destructive, Cancel focused first).
- No backend change: none of the endpoints these ten screens call accept or
  record a reason, so the note variant ships unused here — issue #246
  (order-status change) is the first real consumer.
- `apps/cms/scripts/client-asset-budget.ts`'s `APP_BUDGET_BYTES` raised
  259,000 B → 265,000 B for the new component/client module. Moving the
  confirm copy server-side ultimately measured LIGHTER than the first,
  literal-based pass (262,861 B vs. an interim 264,289 B), since every
  screen's own script shrank to a one-line `confirmFromTrigger(button)`
  call.
- New test: `apps/cms/tests/commerce-confirm-dialog.test.ts` — pure helper
  coverage (including `readConfirmOptions`) plus a static contract over all
  ten screens: no `window.confirm(` or hand-built
  `confirmCommerceAction({ title, message })` literal left, the component
  imported and rendered exactly once each, every trigger's `data-confirm-*`
  attributes present (checked per occurrence, since `commission-void-btn`
  renders twice), no inline `style=` in the component.
