---
bump: minor
type: content
impact: public
---

# Storefront ad popup: a native `<dialog>` on creative click

Since issue #47 an ad slot on the news surface renders its creative as a
real `<img>` — 300×250, the slot's own size — inside an anchor straight to
the advertiser. seputarborneo (the site this news surface mirrors) does
something more useful with that click: `js/main.js`'s `initAdPopup()`
opens the creative at full size in a modal, with a clear disclosure and a
deliberate "open the ad" step, so a reader can look at an ad without being
sent off-site by a mis-tap on a small image. Issue #53 ports that
behaviour, dropping the jQuery and the hand-rolled modal the original
needed: the native `<dialog>` already gives focus trapping, `Escape`, an
inert page behind it, and the backdrop.

`apps/storefront/src/scripts/iklan-popup.ts` is mounted once from
`apps/storefront/src/layouts/BeritaLayout.astro` (an external module —
this app's `script-src 'self'` allows nothing inline) and listens for one
delegated click on `.ad-slot [data-iklan-popup]`, so every slot on every
news page — including the sidebar slots issue #49 adds in parallel — is
covered without any page knowing the module exists. The dialog is built on
the first click and reused. `IklanSlot.astro` marks a linked creative's
anchor with `data-iklan-popup`/`data-iklan-nama`/`data-iklan-label` and
nothing else changes there; an UNLINKED creative, which had no anchor to
decorate, now wraps its image in a real `<button type="button">` so the
"no destination" state is reachable by keyboard too.

- A reader who clicks an ad creative sees it at natural size (capped at
  90vw/90vh), the advertiser's name, the disclosure label, and a "Buka
  iklan" CTA to the real destination (`rel="sponsored noopener"`); a
  creative with no destination shows "Iklan ini belum memiliki tautan
  tujuan" and no CTA. ✕, backdrop, and `Escape` close it; focus returns to
  the creative; the page does not scroll underneath.
- No JavaScript, or no `<dialog>` support: the anchor navigates as before.
  A Ctrl/Cmd/Shift/Alt or middle click is left to the browser.
- The CTA never trusts the CMS's `linkUrl` into a new `href` unchecked —
  anything that is not an absolute `http(s)` URL is treated as no
  destination.
- Tests: a Playwright spec through the existing `bun run test:e2e` harness
  (`apps/storefront/tests/e2e/iklan-popup.e2e.ts`) plus DOM-free unit and
  wiring guards (`apps/storefront/tests/iklan-popup.test.ts`). The ad
  fixture gains one unlinked `article_bottom` creative so an article page
  carries both trigger shapes.
- Found, not fixed (outside this issue's files): the preview server
  answers `/berita` and `/video` with the 404 page — `build.format:
  "file"` emits `berita.html` beside the `berita/` directory, and
  `@astrojs/node`'s static handler rewrites a directory-shaped URL to
  `berita/index.html` before `send`'s `.html` fallback runs. Recorded in
  `apps/storefront/README.md`'s "Ad popup" section for follow-up.
