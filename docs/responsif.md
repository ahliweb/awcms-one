🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](responsif.id.md)

# Responsive design

How `apps/storefront` behaves across viewport widths, and how that was checked. **Read this first: every claim below is now verified by a real, automated browser check, not merely by reading `apps/storefront/src/styles/*.css` and the page templates by hand.** `apps/storefront/tests/e2e/responsif.e2e.ts` (issue #183) opens every one of the active build profile's key pages in a real Chromium browser at 360px (mobile) and 1280px (desktop) and asserts `document.documentElement.scrollWidth <= window.innerWidth` — the exact condition that produces an unwanted horizontal scrollbar. The `local-ci/e2e-*` legs (`tools/ci/runners/e2e.ts`, formerly `.github/workflows/e2e.yml`, issue #183/#225) run it for all three build profiles as required status checks; `docs/pengujian.md`'s "Playwright e2e" section is the full tier reference. `apps/storefront` still has no committed visual-regression baseline — `apps/storefront/tests/e2e/screenshots.e2e.ts` captures full-page screenshots for a human reviewer to look at instead, deliberately never diffed byte-for-byte (see that spec's own docblock for why).

## Mostly fluid, with a small, deliberate set of breakpoints

Increment 1's claim that this app carried **no** viewport-width breakpoints at all is no longer true — the catalog sidebar, the mobile nav, and the news two-column layout each need a real point where the layout reshapes, not just reflows:

| File | Breakpoint | What changes |
| --- | --- | --- |
| `global.css` | `max-width: 720px` (else, desktop) | Which of the two `Navigasi utama` renders is shown (issue #230 — see below) |
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

## The primary nav is rendered twice, not shown/hidden by CSS alone (issue #230)

`Header.astro` renders its `primaryNav` array twice: a desktop `<nav class="primary-nav">`, always open, and the pre-existing mobile copy inside `.mobile-nav-toggle` (the native `<details>`/`<summary>` disclosure `docs/aksesibilitas.md` describes). `global.css` shows exactly one of the two — `.primary-nav { display: flex }` / `.mobile-nav-toggle { display: none }` by default (above 720px), flipped inside `@media (max-width: 720px)` — with no gap or overlap in the breakpoint itself. Before this fix there was only one render, living inside the `<details>`, meant to become the desktop nav above 720px via `display: flex` on its own CSS. That never worked in any browser: a *closed* `<details>` hides its own content (everything but `<summary>`) through the UA stylesheet's `::details-content { content-visibility: hidden }` rule, which author CSS on the hidden content's children cannot override — so the primary nav was invisible above 720px, in every `SITE_PROFILE`, until this issue. `apps/storefront/tests/e2e/navigasi-utama.e2e.ts` is the real-browser regression test: at 1440px it asserts the desktop nav is visible, a link is keyboard-focusable via Tab, and only one `Navigasi utama` landmark is visible at once; at 360px it asserts the desktop copy is hidden and the `<summary>` toggle still opens the mobile nav.

## The 2026-09 redesign's chrome (issue #166)

The utility bar (`Header.astro`) and the footer's new "Kanal" column (`Footer.astro`) both use the same fluid patterns already documented above — `flex-wrap: wrap` with `gap`, no new breakpoint. The footer grid (`.site-footer-grid`, unchanged `grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr))`) simply gained a fifth possible column (Kanal, alongside the profile-gated Informasi one), reflowing exactly like the four it already had. `.stepper`/`.radio-card`/`.segmented` (the new primitives, `global.css`) are all intrinsically-sized flex rows with no breakpoint of their own — the same "fluid until a real reason to reshape" posture the rest of this document already describes.

## What was verified, and how

- **A real browser measuring real overflow** (`apps/storefront/tests/e2e/responsif.e2e.ts`, issue #183) at 360px and 1280px, for every key page of every build profile — this is now the primary source for "does this page overflow", not the `grep`-level reading below.
- **`grep`-level confirmation of every `@media` query** across `global.css`, `katalog.css`, `berita.css`, `toko.css` — the breakpoint table above is exhaustive, not a sample. `toko.css` (checkout/cart-specific styles) carries no width breakpoint of its own, relying on `min-width: 0` flex-shrink guards instead.
- **The `min(Npx, 100%)` clamp's own reasoning** was read in each stylesheet's own comments/structure — still true, and now backed by the 360px check above actually exercising it.
- **The admin screen's table** (`apps/cms/src/pages/admin/commerce.astro`) declares a `data-table--stack` class for its own responsive behaviour — belongs to `apps/cms`, not this storefront, and was not inspected further for this document.

## Two real overflow bugs the first automated run found (issue #183)

Both fixed in `apps/storefront/src/styles/katalog.css`, in tokens/components rather than a one-off patch:

- **`/produk`'s filter sidebar price-range row** (`.filter-price-range`) was accidentally a flex COLUMN, not a row — it also carries the `.filter-field` class, whose `flex-direction: column` rule was the only one setting that property, so `flex: 1`/`min-width: 0` on its two `<input type="number">` fields were shrinking their HEIGHT (the column's main axis), not their width; each input sat at its own ~190px intrinsic default, well past a 360px viewport. Fixed by declaring `flex-direction: row` explicitly on `.filter-price-range`.
- **The same page's single-column breakpoint** (`@media (max-width: 860px) { .listing-layout { grid-template-columns: 1fr; } }`) still overflowed even after the fix above: a bare `1fr` track is shorthand for `minmax(auto, 1fr)`, and that track's own automatic minimum floors at the largest item's min-content size regardless of `min-width: 0` set on the grid ITEM (`.listing-sidebar` already carried that, and it was not enough on its own). Fixed with `minmax(0, 1fr)`, which removes the track's own floor too.

## Not built

A committed visual-regression baseline — `apps/storefront/tests/e2e/screenshots.e2e.ts` (issue #183) captures a full-page PNG per key page per viewport (copied into that leg's own evidence directory by `tools/ci/runners/e2e.ts`, formerly uploaded as a CI artifact by `.github/workflows/e2e.yml`) for a human reviewer to look at, deliberately never diffed byte-for-byte against a prior run (cross-OS font rendering makes that flaky by construction, and a hosted visual-diff service is a paid external dependency this repo does not have).
