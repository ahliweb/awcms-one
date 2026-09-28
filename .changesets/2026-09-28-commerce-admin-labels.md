---
bump: minor
type: structure
impact: internal
---

# Shared translated label maps for commerce admin enums/statuses (issue #243)

A pattern audit of the twelve commerce admin screens found 23 spots across
eleven files rendering a raw English/snake_case value (`order.status`,
`product.type`, `run.status`, …) straight from the database instead of a
translated label — each screen that needed one had either redefined its own
ad hoc map or skipped it entirely, so the same field (order status, e.g.)
could read differently depending which screen showed it. This change adds
the one shared module those follow-up screen changes adopt, so a status has
exactly one Indonesian label no matter which of up to four screens renders
it.

- New `apps/cms/src/lib/ui/commerce-admin-labels.ts`: `createCommerceLabels(t)`
  returns one object of 15 label maps — order status, payment status, order
  channel, product status, product type, voucher type, campaign status,
  campaign channel, review status, affiliate status, commission status,
  conversation status, WhatsApp message status, and the shared `reporting`
  module's projection run/freshness status — each `satisfies
  Record<TheEnumType, string>` against the domain layer's own exported
  union, so a future new enum value is a compile error here until labelled.
  `commerceLabel(map, raw)` is the per-row lookup a screen calls; it never
  throws and falls back to the raw value. Six tone maps
  (`orderStatusTone`, `affiliateStatusTone`, `commissionStatusTone`,
  `reviewStatusTone`, `reportFreshnessTone`, `reportRunStatusTone`) are
  extracted from the `STATUS_TONE`/`FRESHNESS_VARIANT` maps that already
  exist, redundantly, on `commerce-dashboard.astro`,
  `commerce-orders/[id].astro`, `commerce-affiliates.astro` and
  `commerce-reports.astro`.
- `OrderChannel` (`"storefront" | "pos"`) and `ConversationStatus`/
  `AffiliateStatus`/`CommissionStatus` had no exported TS union anywhere in
  the commerce module; the first is derived from `sql/931`'s own CHECK
  constraint and the other three via indexed access into an already-exported
  record type (`AdminConversationRecord["status"]`, etc.) rather than
  redeclared by hand.
- `locales/en.po`/`locales/id.po` gain 23 new msgids under a
  `# commerce admin labels (#243)` comment — reusing 21 already-declared
  msgids where an existing screen or `apps/storefront`'s own
  order/affiliate/review/conversation labels already established the exact
  wording (e.g. `commerce-affiliates.astro`'s own commission-status filter
  already spells "Pending"/"Approved"/"Paid"/"Void").
- This issue ships **no screen change** — the twelve screens the audit found
  still render their own raw values today. Issues #245/#246/#247 adopt this
  module screen by screen.
