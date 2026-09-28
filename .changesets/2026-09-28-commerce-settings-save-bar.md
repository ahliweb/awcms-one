---
bump: minor
type: structure
impact: public
---

# Commerce settings: sticky save bar, webhook table stacks on mobile

Issue #244, part of the commerce admin v2 epic. `commerce-settings.astro`
had three forms, each with its own inline submit button and no persistent
save control once a form scrolled out of view. Ported from
`media-lenterakalteng`'s `SettingsSaveBar` (that fork's ADR-0124) into
this module's own `src/components/`, since `apps/cms/src/lib/ui/admin-
form-client.ts` and `admin-screens.css` are upstream `ahliweb/awcms` files
this repo does not edit locally.

- New `apps/cms/src/components/CommerceSettingsSaveBar.astro` +
  `apps/cms/src/lib/ui/commerce-settings-save-bar-client.ts`: `formId`
  (required) and `saveLabel` (required) props, optional `resetLabel`/
  `ariaLabel`/`class`, a named `status` slot. Always rendered — `<button
  type="submit" form={formId}>`/`<button type="reset" form={formId}>` work
  with JavaScript disabled, exactly like a submit button written inside
  the form. The optional client module adds only a dirty/clean visual
  distinction (an `is-dirty` class, a `data-dirty-label`/`data-clean-label`
  status-text swap on `input`/`change`/`reset`) — it never hides or
  disables the buttons, and deliberately adds no `beforeunload` guard (see
  the client module's own docblock for why: the dirty flag has no signal
  for "the page's own async save actually succeeded", so a leave-guard
  keyed off it would still warn right after a successful save). Buttons
  reuse the shared `.btn`/`.btn-primary` classes rather than a bespoke
  button, and the bar's own surface is a plain `--color-surface` card, so
  the existing global `:focus-visible` ring needs no override.
- `commerce-settings.astro` adopts the bar for its two SETTINGS forms
  (`#store-settings-form`, `#commerce-features-form`), removing each
  form's own inline submit button so the bar's button is the one primary
  submit control — the same "one submit control per form" resolution
  `media-lenterakalteng`'s adopting screens used for the same
  `admin-form-client.ts` submit-lock interaction, reached here by looking
  the bar's button up through the new client module's own
  `commerceSaveBarButton(formId)` (this module's own file, so the upstream
  `admin-form-client.ts` never needed a matching export). Each form is
  wrapped, together with its own bar, in a shared block ancestor
  (`#store-settings-section` new; `#commerce-features-section` already
  existed) — `position: sticky; bottom: 0` is scoped by that containing
  block, so each bar sticks only while ITS OWN section is in view and the
  two bars never overlap. `#webhook-endpoint-create-form` is a CRUD create
  form, not a settings form, and keeps its own inline button unchanged.
- The webhook endpoints table joins the shared `data-table`/
  `data-table--stack` convention every other commerce table already uses:
  a `data-table-scroll` wrapper, a `<caption>` reporting a real count via
  the plural translator, `data-label` on every cell, the action cell
  wrapped in `.row-actions` and marked `stacked-block`, and an
  `.empty-state` block when a tenant has minted no webhook endpoint yet
  (there was previously no empty state at all).
- `apps/cms/scripts/client-asset-budget.ts`'s `APP_BUDGET_BYTES` raised
  259,000 -> 261,000 B (measured 260,541 B) for the new component's scoped
  stylesheet and the page's larger client script; docblock entry added in
  the same style as every prior commerce raise.
- New msgids: `"Saved"`, `"Unsaved changes"`, the `"{count} webhook
  endpoint"`/`"{count} webhook endpoints"` plural pair, `"No webhook
  endpoints yet"`, and `"Webhook endpoints created for this tenant will
  appear here."` — English + natural Indonesian. Both settings forms'
  save/reset labels reuse the screen's EXISTING `"Save store settings"`/
  `"Save features"`/`"Reset"` catalogue entries rather than a new generic
  `"Save changes"` string, since a page with two bars benefits more from
  each one naming what it saves.
- Tests: `apps/cms/tests/commerce-settings-save-bar.test.ts` — pure client
  helper tests (`resolveStatusText`, no `.disabled =`/`.hidden =`
  assignment, no `beforeunload` listener) plus the static contract of
  both the component (no-JS-safe buttons, no inline style/script, shared
  button classes) and the page (bar adoption, one submit control per
  form, each bar's section wrapping, the webhook table's stacking
  convention and empty state).

No other commerce admin screen is touched by this change.
