🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](ui-ux.id.md)

# UI / UX

The storefront's visual and interaction design decisions that are load-bearing enough to need explaining, rather than a restatement of every CSS rule in `apps/storefront/src/styles/global.css`.

## No product imagery, anywhere

Neither the catalog grid nor the product detail page renders a product photo. This is not an oversight to be filled in later within this document's scope — `CommerceProduct` carries no image field in this slice at all, because `product_images` is one of the tables this increment defers (see [`docs/skema-basis-data.md`](skema-basis-data.md) and [`docs/cms.md`](cms.md)). Every product card and detail page is composed from text (name, SKU, price, description) and, where set, a color-coded label badge.

## `labelColor`: a CMS-chosen color, rendered safely

`label`/`labelColor` on a product is a free-form merchandising badge — e.g. a "Baru" (new) tag — where `labelColor` is an **arbitrary hex string a merchandiser typed**, with no fixed palette this app could pre-declare as ordinary CSS classes. Two obvious ways to apply an arbitrary per-instance color — an inline `style="background: ..."` attribute, or a hand-written `<style>` block — are both exactly what this app's strict CSP (`style-src 'self'`, no `'unsafe-inline'`, see [`apps/storefront/server/penyaji.mjs`](../apps/storefront/server/penyaji.mjs)) refuses without an exemption this app is built never to need.

The third way: `apps/storefront/src/pages/product-labels.css.ts` is a build-time endpoint that scans every product in the catalog, collects the distinct `labelColor` values, and emits one small, genuinely external, same-origin stylesheet — `.label-bg-1a2b3c { background-color: #1a2b3c; color: ... }` — because every color in the catalog is already known at build time (the static-output decision, [ADR-0002](adr/0002-static-output-with-build-time-fetch-for-the-storefront.md), is what makes this possible at all). `style-src 'self'` allows it with no exemption, because it is a file like any other this build emits, not an inline anything.

## Contrast is computed, not assumed

A badge's text color is not hardcoded white or black — `contrastingForeground()` (`apps/storefront/src/lib/catalog.ts`) computes the WCAG relative luminance of the background color and picks whichever of pure black or pure white yields the higher contrast ratio against it, rather than testing luminance against a single midpoint threshold (the two contrast formulas, against white and against black, are not symmetric around one fixed point, so a fixed threshold picks the worse option across a real range of colors). This closes a real bug class named directly in the code's own comments: assuming white text is always readable on a merchandiser-chosen background fails outright on a pale color — a light yellow "Baru" tag with white text, for instance.

**A stated limit, not hidden:** for a background color near the middle of the luminance range, *neither* pure black nor pure white may reach the 4.5:1 body-text contrast minimum — picking the higher-contrast one is the best a function of the background color alone can do, without altering the merchandiser's chosen color, which this app does not do silently.

A `labelColor` that is not a clean 6-digit `#rrggbb` hex string (free text, `rgb(...)`, a typo) gets **no** generated class at all — `isValidHexColor()` rejects it, `labelClassName()` returns `undefined`, and the product falls back to the plain `.label-badge` style already in `global.css`. One merchandiser's bad color value degrades a single badge's background; it does not fail the build.

## Stock and price presentation

`formatPrice()` renders `price` (a `numeric(14,2)` decimal string, see [ADR-0003](adr/0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md)) through `Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR" })` — the one place this app ever converts the price string to a number, immediately fed into a formatter with no string overload and never stored or recombined. `discountPercent` is shown as the percentage awcms sends ("Diskon 20%"), never as a computed discounted price — this app performs no price arithmetic anywhere, so it never has to invent a rounding rule that might disagree with whatever a future checkout computes. Stock is shown as a binary badge — "Stok tersedia" / "Stok habis" — derived from `stock > 0`, not the numeric count itself.

## Language: Indonesian, unconditionally

Every user-facing string in this app is written directly in Indonesian (`<html lang="id">`, "Katalog Produk", "Stok tersedia", "Lewati ke konten utama") — there is no i18n framework, no locale switcher, and no English copy anywhere in the rendered output. This is a smaller app than the sibling `awcms-astro`/`media-lenterakalteng` templates it is modelled on, which do carry multi-locale machinery; this storefront does not need it and does not carry it.

## Not built

Product imagery of any kind, a category-browse UI (see [`docs/routing.md`](routing.md)), any cart or checkout affordance, a locale switcher, and any dark-mode-specific product imagery decision (the color-scheme media query in `global.css` governs the app's own chrome, not product-supplied color like `labelColor`, which is rendered as the merchandiser set it regardless of the reader's OS theme).
