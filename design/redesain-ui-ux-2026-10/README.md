# UI/UX redesign — commerce admin (October 2026)

Reference-only design proposal for the commerce screens of `apps/cms`. It uses
the same shell and tokens as the `ahliweb/awcms` proposal (same folder name
there) and adds what commerce needs: the 32 commerce screens grouped into seven
sub-groups, a tenant brand accent, and an orders screen with a status timeline.
UI copy is Indonesian.

**Not implemented.** These pages render example data only and call no API.
`apps/cms` is a `git subtree` of `ahliweb/awcms`, so a shell change belongs
upstream first; only the commerce-specific parts would land here.

## How to view

```bash
python3 -m http.server 8080   # from the repository root
# then open http://localhost:8080/design/redesain-ui-ux-2026-10/OneDashboard.dc.html
```

Serve the repository root: the pages load this repo's own fonts and storefront
mark by relative path. [`support.js`](support.js) is a byte-identical copy of the
vendor runtime in `ahliweb/omes` `ui/control-center/support.js`; it loads React
from unpkg, so viewing needs network access. [`canvas.json`](canvas.json)
records the artboard layout.

## Contents

| File                                           | Screen                                                                                                                             | Interactive                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| [`Main.dc.html`](Main.dc.html)                 | 00 · Analysis of awcms, awcms-one, omes and awcms-astro                                                                            | no                            |
| [`OneDashboard.dc.html`](OneDashboard.dc.html) | Commerce dashboard: channel filter (all / storefront / POS), KPIs, 14-day gross revenue, attention list, recent orders, low stock  | channel filter                |
| [`OneOrders.dc.html`](OneOrders.dc.html)       | Orders: search, status tabs with counts, filters, keyset paging footer, order detail with status timeline, items, Midtrans session | search, tabs, paging, row     |
| [`PolaData.dc.html`](PolaData.dc.html)         | Data-page pattern shared by the family: which search and paging each page function gets                                            | no                            |
| [`OneSpec.dc.html`](OneSpec.dc.html)           | Per-screen spec of the 32 commerce screens by proposed sidebar sub-group, with what the code does today                            | search, filter, paging        |
| [`OneProducts.dc.html`](OneProducts.dc.html)   | Products: name/SKU/barcode search, status tabs, category, low-stock and featured filters, table or grid, keyset 25/24 per page     | search, filters, view, paging |

[`spec-one.json`](spec-one.json) is the data behind the spec screen; its
"current" column comes from a heuristic scan of
`apps/cms/src/pages/admin/commerce*.astro`, the rest is the proposal. The
products screen uses the same query parameters as `/admin/commerce`
(`q`, `categoryId`, `status`, `featured`, `recommended`, `cursor`).

Both commerce artboards expose an `accent` tweak: the colour `template:init`
writes for the brand would become the admin `--color-primary` once it passes the
contrast check (`#0369a1` default — `#0284c7` with white text is below 4.5:1).

## Assets used

| Asset                       | Source in this repo                                                              |
| --------------------------- | -------------------------------------------------------------------------------- |
| Public Sans, JetBrains Mono | [`apps/cms/public/fonts/*.woff2`](../../apps/cms/public/fonts)                   |
| BjekMart mark               | [`apps/storefront/public/favicon.svg`](../../apps/storefront/public/favicon.svg) |

## Data provenance

All orders, products, customers and amounts are example data, marked on each
screen. Order and payment status labels come from
`apps/cms/src/lib/ui/commerce-admin-labels.ts`.
