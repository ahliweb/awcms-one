---
bump: patch
type: fix
impact: public
---

# Thirteen commerce admin screens now render translated labels, not raw enum values (issue #245)

Issue #243 built one shared label-map module
(`apps/cms/src/lib/ui/commerce-admin-labels.ts`) but changed no screen. This
issue adopts it on the nine screens the issue named plus the three its own
comment widened the scope to — inbox, dashboard, affiliates, reports,
WhatsApp, POS, reviews, campaigns, vouchers, flash sales, customers, popup —
so a merchant reading `/admin/commerce-*` sees "Pending payment"/"Menunggu
pembayaran" instead of `pending_payment`, and so on for every status,
channel, type, and frequency those twelve screens show. `commerce-orders*`
(#246) and `commerce.astro` (#247) are out of scope here. The manager added
`commerce-settings.astro`'s one webhook-provider cell (`labels.webhookEndpointProvider`)
after #244's rewrite of that table reached main, making thirteen screens.

- Every render site now calls `commerceLabel(labels.<map>, <raw value>)` and
  keeps the raw value machine-readable in a `data-*` attribute on the same
  element (the LK PR #263 pattern) — never lost, just no longer what a
  reader sees.
- `commerce-dashboard.astro`'s and `commerce-affiliates.astro`'s own
  `STATUS_TONE` maps and `commerce-reports.astro`'s `FRESHNESS_VARIANT` map —
  each a duplicate of a tone map the shared module now exports — are gone;
  the screens import `orderStatusTone`/`affiliateStatusTone`/
  `commissionStatusTone`/`reportFreshnessTone` instead. `commerce-
  reports.astro`'s export-run status badge additionally replaces its old
  binary `completed ? success : danger` ternary with the module's
  `reportRunStatusTone`/`reportRunStatus` — a deliberate reuse across the
  narrower two-value `ExportRunStatus` the export-runs table actually reads,
  which produces the identical two tones the ternary did.
- A handful of already-`t()`-wrapped `<select>`s now iterate the shared map
  instead of repeating its options by hand, for one source of truth:
  `commerce-vouchers.astro`'s create-form type options, `commerce-
  affiliates.astro`'s commission-status filter, and `commerce-popup.astro`'s
  create-form frequency options. Two screens whose `<select>` only ever
  offers a NARROWER subset of the full enum (`commerce-flash-sales.astro`'s
  create/edit status, draft/scheduled of four) reuse the map's own label
  text directly rather than iterating it, so the tick-job-only
  `active`/`ended` values are never wrongly offered to a human editor.
- `commerce-whatsapp.astro`'s message table gets the empty state it was
  missing — a `<td class="data-table-empty">` row inside the (now
  always-rendered) table, matching every other commerce table's pattern,
  instead of a bare `<div>` that skipped the table headers entirely.
- No screen's `<script>` confirm-dialog code, or the markup just above
  `</AdminLayout>`, was touched on affiliates/campaigns/reviews/vouchers/
  flash-sales/popup — reserved for the concurrently-landing issue #242.
- Two new msgids (`apps/cms/locales/en.po`/`id.po`): the WhatsApp table's new
  empty-state body text. No other new catalog entries were needed — the
  shared module already declared every label this issue's screens use.
- New test: `apps/cms/tests/commerce-enum-labels-245.test.ts` pins, per
  screen, that `createCommerceLabels` is imported and called, that every
  listed field renders through `commerceLabel` with its `data-*` raw
  attribute, and that no superseded per-screen tone map remains.
