🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](responsif.id.md)

# Responsive design

How `apps/storefront` behaves across viewport widths, and how that was checked. **Read this first: every claim below comes from reading `apps/storefront/src/styles/global.css` and the page templates — no browser, real or headless, was opened to verify a layout at any width while writing this document.** `apps/storefront` has no Playwright suite, no visual-regression test, and no responsive-specific CI step today.

## Fluid, not breakpoint-based

The catalog grid (`.grid-cards` in `apps/storefront/src/styles/global.css`) uses CSS Grid with `auto-fill`, not a fixed set of `@media` breakpoints:

```css
grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr));
```

The number of columns is a function of available width, computed by the browser at every width, not a small set of hand-picked layouts switched at hand-picked thresholds. The `min(280px, 100%)` clamp is deliberate: at a narrow viewport, a bare `280px` track could force horizontal scroll the moment `box-sizing` rounding or a border adds even a sub-pixel of width; wrapping it in `min(..., 100%)` caps the track at whatever width the grid actually has, so it can never force overflow, while behaving identically to a fixed `280px` above that point. `.container`'s own `max-width: 1200px` bounds the grid on large screens without a breakpoint either.

## What was verified, and how

- **`grep`-level confirmation that no `@media (min-width:` / `@media (max-width:` breakpoint exists in `apps/storefront/src/styles/global.css`** — the only `@media` queries present are `(prefers-color-scheme: dark)` and `(prefers-reduced-motion: reduce)`, neither of which is about viewport width. The layout's responsiveness is therefore a property of the fluid grid and flex layouts throughout the stylesheet, not of a breakpoint system this document could otherwise enumerate.
- **Reading, not measuring, the 320px floor.** The stylesheet's own comment beside `.grid-cards` reasons explicitly about the narrow-viewport case (a `min()`-clamped track to avoid forced overflow at the low end of supported widths) — this document repeats that reasoning because it was read in the source, not because a 320px-wide browser window was opened and measured.
- **The admin screen's table** (`apps/cms/src/pages/admin/commerce.astro`) declares a `data-table--stack` class with per-cell `data-label` attributes — a conventional CSS technique for turning a table into a stacked card layout below some width — but this belongs to `apps/cms`, not `apps/storefront`, and its own breakpoint (if any) was not inspected for this document.

## Not built

Any automated responsive or visual-regression test — Playwright, a screenshot-diff tool, or a CI step that renders the storefront at multiple viewport widths. `apps/storefront`'s `bun run check` is a type-check; it asserts nothing about rendered layout at any width. A concrete next step, not yet taken, would be exactly the kind of real-browser check the `playwright` skill in this environment exists to set up.
