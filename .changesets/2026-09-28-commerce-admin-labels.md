---
bump: minor
type: structure
impact: internal
---

# Shared translated label maps for commerce admin enums/statuses (issue #243)

A full sweep of every `apps/cms/src/pages/admin/commerce*.astro` screen plus
`commerce-orders/[id].astro` — every `<option>` text, table cell, status/tone
badge, detail field, and filter-tab label that shows an enum value — found
the same defect repeated across sixteen screens: a raw English/snake_case
value (`order.status`, `session.provider`, `run.status`, …) rendered straight
from the database instead of a translated label, each screen that needed one
either redefining its own ad hoc map or skipping it entirely, so the same
field (order status, e.g.) could read differently depending which of up to
four screens showed it. This change adds the one shared module the follow-up
screen changes adopt, so a status has exactly one Indonesian label everywhere
it appears.

- New `apps/cms/src/lib/ui/commerce-admin-labels.ts`: `createCommerceLabels(t)`
  returns one object of 23 label maps — order status, payment status, order
  channel, product status, product type, voucher type and status, campaign
  status and channel, review status, affiliate status, commission status,
  conversation status, customer status, WhatsApp message status, flash-sale
  status, popup frequency, webhook-endpoint provider, payment-gateway session
  status/provider, payment-event outcome, and the shared `reporting` module's
  projection run/freshness status — each `satisfies Record<TheEnumType,
  string>` against the domain layer's own exported union, so a future new
  enum value is a compile error here until labelled. `commerceLabel(map,
  raw)` is the per-row lookup a screen calls; it never throws and falls back
  to the raw value. Six tone maps (`orderStatusTone`, `affiliateStatusTone`,
  `commissionStatusTone`, `reviewStatusTone`, `reportFreshnessTone`,
  `reportRunStatusTone`) are extracted from the `STATUS_TONE`/
  `FRESHNESS_VARIANT` maps that already exist, redundantly, on
  `commerce-dashboard.astro`, `commerce-orders/[id].astro`,
  `commerce-affiliates.astro` and `commerce-reports.astro` — no tone map for
  an enum no screen already colour-codes.
- Nine of the 23 unions had no exported TS type anywhere: `OrderChannel`,
  `PaymentGatewaySessionProvider` and `PaymentEventOutcome` are derived from
  the owning column's own database `CHECK` constraint (`sql/931`, `sql/926`
  twice); `ConversationStatus`/`AffiliateStatus`/`CommissionStatus`/
  `CustomerStatus` are derived via indexed access into an already-exported
  record type (`AdminConversationRecord["status"]`, etc.) rather than
  redeclared by hand.
- `locales/en.po`/`locales/id.po` gain 26 new msgids under a
  `# commerce admin labels (#243)` comment. The 23 label maps use 54
  distinct msgids in total; the other 28 already existed — reused verbatim
  where an existing screen or `apps/storefront`'s own
  order/affiliate/review/conversation labels already established the exact
  wording (e.g. `commerce-affiliates.astro`'s own commission-status filter
  already spells "Pending"/"Approved"/"Paid"/"Void"; `commerce-vouchers.astro`,
  `commerce-customers.astro` and `commerce-popup.astro`'s own `<select>`
  options already spell out every value their respective enum needs).
- This issue ships **no screen change** — the sixteen screens the sweep
  found still render their own raw values today. Issues #245/#246/#247 adopt
  this module screen by screen; the adopting issues' own PR descriptions are
  the place to enumerate exactly which `labels.<map>` key replaces which
  file:line.
