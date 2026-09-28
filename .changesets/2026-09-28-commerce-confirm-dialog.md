---
bump: minor
type: content
impact: public
---

# An accessible confirm dialog replaces `window.confirm()` on ten commerce admin screens

Part of the commerce admin v2 epic (LK admin v2 parity, issue #242). Eleven
`window.confirm()` calls across ten `apps/cms` commerce admin screens —
categories, campaigns (send + cancel), affiliates (void commission), popup,
products, reviews, sliders, testimonials, vouchers, flash sales — are
replaced by one shared, commerce-owned accessible dialog.

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
- A campaign send and an affiliate commission approve/pay stay non-`danger`
  (styled as the ordinary primary action); a campaign cancel, an affiliate
  commission void, and every delete action are `danger` (styled destructive,
  Cancel focused first).
- No backend change: none of the endpoints these ten screens call accept or
  record a reason, so the note variant ships unused here — issue #246
  (order-status change) is the first real consumer.
- `apps/cms/scripts/client-asset-budget.ts`'s `APP_BUDGET_BYTES` raised
  259,000 B → 265,000 B (measured 264,289 B) for the new component/client
  module and the ten screens' own script growth.
- New test: `apps/cms/tests/commerce-confirm-dialog.test.ts` — pure helper
  coverage plus a static contract over all ten screens (no `window.confirm(`
  left, the component imported and rendered exactly once each, no inline
  `style=` in the component).
