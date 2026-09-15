🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](aksesibilitas.id.md)

# Accessibility

What `apps/storefront` does for accessibility, and how it was checked. **Read this section first: every claim below was verified by reading the built HTML and the source by hand — not by running axe, Lighthouse, or any other automated accessibility tool.** No such tool is wired into this app's build or its gates today. Where automated coverage would catch more than a manual read can, that gap is real and is named here rather than implied away by a confident-sounding list.

## What is in place

- **A skip link.** `BaseLayout.astro` renders `<a class="skip-link" href="#main-content">Lewati ke konten utama</a>` as the first focusable element in `<body>`, targeting `<main id="main-content">` — a keyboard or screen-reader user can jump past the header and navigation on every page.
- **One `<h1>` per page, deliberately not owned by the shared layout.** `BaseLayout.astro` renders no heading of its own — its docblock states this explicitly as a contract it does *not* fulfil, precisely so the page inside `<slot />` can own the single `<h1>` without the shell competing with it. The catalog page's `<h1>` is "Katalog Produk"; the product page's `<h1>` is the product's own name.
- **Real `<a>` elements for every product card**, both on the catalog grid (`index.astro`) and nowhere else needed (the product page has no card of its own) — never a `<div>` with a click handler. A card is keyboard-focusable and reachable by a screen reader's link list by construction, not by an added ARIA role standing in for a real link.
- **`aria-hidden="true"` on purely decorative glyphs** — the breadcrumb separator (`/`) and the stock-badge/empty-state icons carry it, so a screen reader does not announce a character that conveys nothing on its own.
- **`aria-label` on the two navigation landmarks that need one** — the primary nav (`aria-label="Navigasi utama"`) and the product-page breadcrumb (`aria-label="Remah roti"`), so a screen reader's landmark list distinguishes them from each other and from the header/footer.
- **`aria-current="page"` on the breadcrumb's current item**, so assistive technology can tell the current page apart from the link before it without relying on visual styling alone.
- **`prefers-reduced-motion: reduce` is honoured** — `apps/storefront/src/styles/global.css` carries a media query for it (verified: `grep -n "prefers-reduced-motion" src/styles/global.css`), so a reader who has asked their system for reduced motion is not shown animation this app defines regardless of that preference.
- **Table semantics on the admin product list** — `apps/cms/src/pages/admin/commerce.astro`'s product table uses `<caption>`, `scope="col"` table headers, and `data-label` attributes for its responsive stacked layout, though that screen is part of `apps/cms` (see [`docs/cms.md`](cms.md)), not this storefront.

## What was not checked

No axe run, no Lighthouse accessibility audit, no screen-reader walkthrough with real assistive technology (VoiceOver, NVDA, JAWS, TalkBack), and no keyboard-only navigation session were performed for this document. Color contrast for the merchandiser-chosen `labelColor` badges is *computed* — see [`docs/ui-ux.md`](ui-ux.md)'s `contrastingForeground` — but that computation was not independently re-verified against a contrast-checking tool while writing this document; it is a property of code that was read, not a result that was measured here.

## Not built

Any accessibility-specific automated test, gate, or CI step for this app — `apps/storefront`'s `bun run check` type-checks the app; it does not run an accessibility audit. Adding one (axe-core in CI, or a Lighthouse budget) is a reasonable follow-up not yet taken.
