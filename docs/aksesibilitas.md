🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](aksesibilitas.id.md)

# Accessibility

What `apps/storefront` does for accessibility, and how it was checked. **Read this section first: every claim below was verified by reading the source by hand — not by running axe, Lighthouse, or any other automated accessibility tool.** No such tool is wired into this app's build or its gates today. Where automated coverage would catch more than a manual read can, that gap is real and is named here rather than implied away by a confident-sounding list.

## What is in place

- **A skip link.** `BaseLayout.astro` renders `<a class="skip-link" href="#konten">Lewati ke konten utama</a>` as the first focusable element in `<body>`, targeting `<main id="konten">` — a keyboard or screen-reader user can jump past the header and navigation on every page. (Increment 1's target id, `#main-content`, was renamed to `#konten` when the shared chrome was built in issue #24 — both the link and the target moved together.)
- **Landmarks on every page.** `<header>` (`Header.astro`), `<nav aria-label="Navigasi utama">`, `<main id="konten">`, `<footer>` (`Footer.astro`). `BaseLayout.astro` itself renders no `<h1>` — deliberately, so the page inside `<slot />` owns the single `<h1>` without the shell competing with it.
- **A mobile navigation disclosure needing no JavaScript to open or close.** `Header.astro`'s mobile nav is a native `<details>`/`<summary aria-label="Buka menu navigasi">` — keyboard-operable and screen-reader-announced by the browser's own semantics, not a custom widget.
- **`aria-live="polite"` on every place content changes without a page navigation** — the cart-count badge (`Header.astro`), the flash-sale countdown (`components/katalog/Countdown.astro`), the wishlist list (`pages/wishlist.astro`), the order-tracking body (`pages/pesanan.astro`), the cart quote lines and summary (`pages/keranjang.astro`), the checkout review summary (`pages/checkout.astro`), and the add-to-cart feedback region on the product page (`role="status" data-cart-feedback"`). This is new in increment 2 — every one of these regions is a runtime update over the anonymous commerce API (see [ADR-0007](adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md)), and none of them existed when this document last described a fully static, no-JavaScript-write app.
- **A single, global `:focus-visible` rule** (`apps/storefront/src/styles/global.css`) — a 3px outline with a 2px offset, applied uniformly rather than per-component, plus the skip link's own `:focus` rule that brings it on-screen.
- **Real `<a>` elements for every product card**, never a `<div>` with a click handler — a card is keyboard-focusable and reachable by a screen reader's link list by construction.
- **JSON-LD escaped against script-breakout**, not merely a formality — see [`docs/seo.md`](seo.md) for the XSS defence this closes.
- **Every cart/checkout/wishlist/order-tracking page carries a `<noscript>` fallback and a JS-ran-but-CMS-down WhatsApp fallback** (`apps/storefront/src/lib/wa-fallback.ts`) — a reader with JavaScript disabled, or reaching the page while `apps/cms` is unreachable, is never left with a page that silently does nothing.
- **`prefers-reduced-motion: reduce` is honoured** in `global.css`.
- **Table semantics on `apps/cms`'s own admin product list** (`<caption>`, `scope="col"`, `data-label` for the responsive stacked layout) — part of `apps/cms`, not this storefront; named here because a reader looking for it would otherwise conclude its absence from silence. See [`docs/cms.md`](cms.md).
- **The read-aloud player is additive, never a replacement for the text** (issue #52, `apps/storefront/src/components/berita/PemutarDengar.astro`). It is a `<button>`-driven control with `aria-pressed` on play/pause, full-sentence accessible names on every control, 44px targets, a `role="status" aria-live="polite"` progress line, and it is rendered `hidden` until the browser proves it has `speechSynthesis` and a voice — so a reader on a browser without the API, or with JavaScript off, is never offered a control that does nothing. The read-along highlight is an `outline`/`box-shadow` precisely so the article never reflows under a reader who is listening, and `prefers-reduced-motion: reduce` drops the surrounding glow. It is not an accessibility substitute for the article itself: the text is the article, and the player reads that same text with the reader's own device voice.
- **Colour contrast is unit-tested**, not merely computed and trusted — `apps/storefront/tests/warna.test.ts` asserts every default brand colour clears the WCAG AA text-contrast threshold against its own computed foreground; see [`docs/ui-ux.md`](ui-ux.md) for `contrastingForeground()` itself.

## What was not checked

No axe run, no Lighthouse accessibility audit, no screen-reader walkthrough with real assistive technology (VoiceOver, NVDA, JAWS, TalkBack), and no keyboard-only navigation session were performed for this document. The checkout flow's five-step progressive disclosure was read for keyboard/`aria-live` correctness, not walked with a screen reader.

## Not built

Any accessibility-specific automated test, gate, or CI step for this app — `apps/storefront`'s `bun run check` type-checks the app; it does not run an accessibility audit. Adding one (axe-core in CI, or a Lighthouse budget) is a reasonable follow-up not yet taken.
