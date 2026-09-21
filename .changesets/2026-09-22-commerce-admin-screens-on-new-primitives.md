---
bump: minor
type: structure
impact: internal
---

# Commerce admin screens re-composed on the new admin primitives (issue #171)

Every `apps/cms` commerce admin screen is now built on the shared primitives issue #170's admin-chrome subtree sync (upstream awcms#813) added to `admin.css` — `.admin-stat-card`, `.admin-status-pill`, `.admin-segmented`, `.admin-bulk-bar`, `.admin-two-pane`, `.admin-toggle`, `.admin-timeline` — rather than page-specific markup, so the twelve commerce screens read as one coherent surface with the rest of the redesigned admin chrome. Real data only throughout: a screen omits a stat it cannot honestly compute (the dashboard's missing conversion-rate stat, for lack of a funnel/visit projection) rather than inventing one.

- **New `/admin/commerce-dashboard`**: stat cards (orders/revenue today, low-stock count), a 14-day revenue trend from the existing sales-report projections, a "needs attention" list (orders awaiting confirmation, reviews awaiting moderation, unread inbox threads, pending affiliate commissions — each permission-gated), and a recent-orders table. All figures come from the new `fetchDashboardSummary` (`apps/cms/src/modules/commerce/application/admin-dashboard.ts`).
- **New order detail page** (`/admin/commerce-orders/{id}.astro`): lines, totals, an `.admin-timeline` built from `order_events`, and the existing gateway-session/payment-events panel.
- **New shared `CommerceMarketingTabs.astro`** (`apps/cms/src/components/`): one `.admin-segmented` tab strip across flash sales/vouchers/sliders/popup/testimonials, replacing five near-duplicate hand-rolled headers.
- Products, orders list, POS, reports, inbox, affiliates, and settings restyled on the primitives above; POS deliberately keeps its own `.pos-layout` two-pane grid rather than the generic `.admin-two-pane`, since its cart side needs POS-specific controls the generic primitive does not model.
- A new sidebar entry, `admin.layout.nav_commerce_dashboard`, gets its label/icon in `sidebar-menu.ts`'s `SIDEBAR_LABELS`/`DEFAULT_SIDEBAR_ICONS`, plus catalog entries in `locales/en.po`/`locales/id.po` ("Commerce overview" / "Ringkasan komersial").
- `apps/cms/scripts/client-asset-budget.ts`'s `APP_BUDGET_BYTES` raised 254,500 → 259,000 B (measured 258,829 B) — markup/CSS reuse of existing primitives, not a new client script.

Documented in `docs/cms.md` (+ Indonesian mirror, the admin-screens table and a new re-composition section) and `docs/ui-ux.md` (+ mirror, a new "Admin (2026-09 redesign, issue #171)" section); `.claude/skills/awcms-one-commerce/SKILL.md` (+ mirror) gets an "Admin screen composition" note naming the primitives.
