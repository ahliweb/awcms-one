🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](responsif.id.md)

# Responsive design

How `apps/storefront` behaves across viewport widths, and how that was checked. **Read this first: every claim below comes from reading `apps/storefront/src/styles/*.css` and the page templates — no browser, real or headless, was opened to verify a layout at any width while writing this document.** `apps/storefront` has no visual-regression test today; it does have a real Playwright e2e suite (`apps/storefront/tests/e2e/checkout.e2e.ts`), but that suite tests checkout behaviour, not layout at a range of widths.

## Mostly fluid, with a small, deliberate set of breakpoints

Increment 1's claim that this app carried **no** viewport-width breakpoints at all is no longer true — the catalog sidebar, the mobile nav, and the news two-column layout each need a real point where the layout reshapes, not just reflows:

| File | Breakpoint | What changes |
| --- | --- | --- |
| `global.css` | `max-width: 720px` | Mobile navigation layout |
| `katalog.css` | `max-width: 860px` (×2) | The `/produk` sidebar (`minmax(0,260px) 1fr` → single column); a second product-grid collapse |
| `katalog.css` | `max-width: 720px` | Further catalog-page tightening |
| `berita.css` | `min-width: 900px` | The **only min-width (desktop-up) breakpoint** — the news two-column layout (`minmax(0,1fr)` → `minmax(0,2fr) minmax(0,1fr)`) only activates above 900px; below it, both columns stack, which is the mobile-first default rather than an exception |

Every card/product grid, though, is still fluid CSS Grid with `auto-fill`/`auto-fit`, not a breakpoint switch:

```css
/* global.css — catalog grid */
grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr));
/* katalog.css — narrower product cards */
repeat(auto-fill, minmax(min(140px, 100%), 1fr));
/* berita.css — news card grid */
repeat(auto-fill, minmax(min(220px, 100%), 1fr));
```

The `min(Npx, 100%)` clamp is deliberate throughout: a bare fixed track could force horizontal scroll the moment `box-sizing` rounding or a border adds a sub-pixel of width; wrapping it in `min(...,100%)` caps the track at whatever width the grid actually has, so it can never force overflow, while behaving identically to the fixed value above that point. `.container`'s `max-width: 1200px` bounds every page on large screens.

## Tap targets

Every interactive control added for cart/checkout/wishlist (buttons, quantity steppers, the mobile nav toggle) carries `min-width: 44px` — verified in `global.css`, `katalog.css` (three separate declarations), matching the same 44px minimum recommended by WCAG 2.5.5 and Apple/Google's own platform guidance, applied consistently rather than only on the pages that happen to need it most.

## Customer accounts: no dedicated breakpoint, fluid like the rest

`apps/storefront/src/styles/akun.css` (`/masuk`, `/daftar`, `/akun*`, issues #88/#90/#93) carries no `@media` query of its own — verified by reading the file: every rule is width-independent, and the same 44px `min-height` target size the stylesheet's own header comment names is applied uniformly across every control (the OTP code input, the address form's fields, the affiliate enrol button), not gated behind a breakpoint. The account dashboard's navigation-card grid is `grid-template-columns: repeat(auto-fill, minmax(180px, 1fr))` — the same `auto-fill` reflow mechanism the catalog and news grids use, without the extra `min(Npx, 100%)` overflow clamp those two carry (unneeded here: a 180px track never approaches a phone viewport's own width), so it still collapses to as few as one column at phone width with no breakpoint of its own.

## The 2026-09 redesign's chrome (issue #166)

The utility bar (`Header.astro`) and the footer's new "Kanal" column (`Footer.astro`) both use the same fluid patterns already documented above — `flex-wrap: wrap` with `gap`, no new breakpoint. The footer grid (`.site-footer-grid`, unchanged `grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr))`) simply gained a fifth possible column (Kanal, alongside the profile-gated Informasi one), reflowing exactly like the four it already had. `.stepper`/`.radio-card`/`.segmented` (the new primitives, `global.css`) are all intrinsically-sized flex rows with no breakpoint of their own — the same "fluid until a real reason to reshape" posture the rest of this document already describes.

## What was verified, and how

- **`grep`-level confirmation of every `@media` query** across `global.css`, `katalog.css`, `berita.css`, `toko.css` — the breakpoint table above is exhaustive, not a sample. `toko.css` (checkout/cart-specific styles) carries no width breakpoint of its own, relying on `min-width: 0` flex-shrink guards instead.
- **Reading, not measuring, the narrow-viewport floor** for every fluid grid — the `min(Npx, 100%)` reasoning above was read in each stylesheet's own comments/structure, not confirmed with an open browser window.
- **The admin screen's table** (`apps/cms/src/pages/admin/commerce.astro`) declares a `data-table--stack` class for its own responsive behaviour — belongs to `apps/cms`, not this storefront, and was not inspected further for this document.

## Not built

Any automated visual-regression test, or a CI step that renders the storefront at multiple viewport widths. `apps/storefront`'s `bun run check` is a type-check; the Playwright suite tests behaviour, not layout. A concrete next step, not yet taken, would be exactly the kind of real-browser check the `playwright` skill in this environment exists to set up.
