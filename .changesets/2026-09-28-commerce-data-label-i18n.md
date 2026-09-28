---
bump: patch
type: fix
impact: public
---

# Commerce admin: translate stacked-table column labels

Issue #253. `apps/cms/src/styles/admin.css` renders each cell's column name
on stacked tables at 767px and below through `content: attr(data-label)`.
Every commerce admin table but `commerce-pos.astro` (Issue #171's own screen)
set `data-label="Status"`/`"Customer"`/`"Created"`/etc. as bare English
literals, so a phone-width operator on an Indonesian admin saw untranslated
column names even though the table's own `<th>` header was correctly
translated with `t()`.

- 18 commerce admin screens (`commerce.astro`, `commerce-affiliates.astro`,
  `commerce-campaigns.astro`, `commerce-categories.astro`,
  `commerce-customers.astro`, `commerce-dashboard.astro`,
  `commerce-flash-sales.astro`, `commerce-inbox.astro`,
  `commerce-orders.astro`, `commerce-orders/[id].astro`,
  `commerce-popup.astro`, `commerce-reports.astro`,
  `commerce-reviews.astro`, `commerce-settings.astro`,
  `commerce-sliders.astro`, `commerce-testimonials.astro`,
  `commerce-vouchers.astro`, `commerce-whatsapp.astro`) now write
  `data-label={t("…")}` on every table cell, reusing the exact msgid the
  matching `<th>` in the same table already calls `t()` with — the stacked
  label always equals the column header now. `commerce-pos.astro` needed no
  change.
- Two cells had no header text to copy directly:
  `commerce.astro`'s row-checkbox column (header has no visible text) now
  reuses the existing `"Select"` msgid; `commerce-affiliates.astro`'s
  commission table's first data column (header is a status-filter
  `<select>`, not a plain label) gets a new `"Affiliate"` msgid.
  `commerce-affiliates.astro`'s affiliate-rate cell was also corrected from
  `"Rate"` to the header's own `"Rate (%)"` msgid, which it had silently
  drifted from.
- New msgid: `"Affiliate"` (English + Indonesian `"Afiliasi"`).
- `apps/cms/scripts/client-asset-budget.ts`: no change to
  `APP_BUDGET_BYTES` — every cell already renders a translated string via
  the existing `t()` catalogue, so this adds no new script weight. The
  constant's docblock does record that this issue was checked against it.
- Tests: new `apps/cms/tests/commerce-data-label-i18n-253.test.ts` — a
  repo-wide regression guard forbidding a literal `data-label="…"` on any
  commerce admin screen (present or future), plus targeted assertions for
  the `"Select"`/`"Affiliate"`/`"Rate (%)"` cases above.
  `apps/cms/tests/commerce-settings-save-bar.test.ts` (Issue #244) updated
  to expect the now-translated `data-label` on its own webhook-endpoints
  table.

Out of scope: every non-commerce admin screen under `apps/cms/src/pages/
admin/` — that tree is upstream `ahliweb/awcms`'s own subtree, and this
issue only touches this platform's `commerce` module files.
