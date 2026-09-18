---
bump: minor
type: content
impact: public
---

# Storefront article share row — FB/X/WhatsApp/Threads, Instagram via Web Share, TikTok/YouTube follow (issue #51)

Every article and video page (`/berita/{slug}`, `/video/{slug}`) used to end
with two text links — "Bagikan ke WhatsApp" and "Bagikan ke Facebook". The
legacy seputarborneo site this news surface replaces ships a seven-control
row (its `sb_bagikan()`, issues #61/#67 there), and its own working
contract insists the row is THREE kinds of control that must not be
conflated: platforms with a real web share URL, one platform (Instagram)
with none at all that is still a share action, and two (TikTok, YouTube)
with none that are FOLLOW links to the site's own accounts. Inventing a
share URL for the last three — the obvious shortcut — is exactly what that
contract forbids, because there is no such URL to invent. This change ports
the row with that distinction intact.

- `apps/storefront/src/components/berita/BarisBagikan.astro` replaces the
  old block in `ArtikelView.astro` (the only edit to that file — an import,
  the component, and the now-dead `encodedTitle` constant removed).
  Facebook, X, WhatsApp and Threads are plain `<a rel="noopener nofollow">`
  intent links that need no JavaScript; TikTok/YouTube are
  `<a rel="noopener me">` follow links rendered only when
  `identity.socialLinks` actually carries one; Instagram is a real
  `<button>`. Every control has a full accessible name that names the verb
  ("Bagikan ke Facebook" vs "Ikuti kami di TikTok") and a 44×44 target.
- `apps/storefront/src/lib/bagikan.ts` (build-time, pure) — the four URL
  builders (title and URL each `encodeURIComponent`-ed; Facebook's sharer
  takes only `u=` and reads the title from the page's own OG tags) and the
  follow-link resolver, which goes through issue #48's
  `apps/storefront/src/lib/ikon-sosial.ts` rather than a second filter: the same
  `http(s)`-only scheme check that closes the stored-XSS hole an
  admin-typed `javascript:` URL would open, and the same hostname-based
  platform detection, so an editor's "TikTok" label on a non-TikTok URL is
  not believed. WhatsApp's SVG path is the one glyph this row adds; every
  other icon is `ikon-sosial.ts`'s.
- `apps/storefront/src/scripts/bagikan.ts` (browser, an external module —
  the CSP's `script-src 'self'` has no `'unsafe-inline'`) — the Instagram
  flow: `navigator.share({ title, url })` first, a dismissed share sheet
  stays silent, any other failure or no Web Share API falls through to
  `navigator.clipboard.writeText(url)` with a visible "Tautan disalin…"
  status in a `role="status"`/`aria-live="polite"` region. That region
  ships EMPTY in the static HTML rather than being created on first click
  as upstream does — a live region that is created and filled in the same
  tick is announced by some screen readers and skipped by others. A denied
  or unavailable clipboard ends in a visible failure message; upstream's
  `execCommand("copy")`/`window.prompt()` last resorts were deliberately
  not ported (deprecated, and a blocking prompt is the interruption an
  `aria-live` status exists to avoid).
- The Instagram button ships `hidden` and the script reveals it once its
  handler is attached: it has nothing to do without JavaScript (no share
  URL exists to fall back to), and a control that does nothing must not be
  offered. It never reads `identity.socialLinks` — the reader shares to
  THEIR Instagram; that needs no account of ours.
- No third-party script (no Facebook SDK, no Twitter widgets, no embed.js)
  — `apps/storefront/tests/bagikan.test.ts` greps every file under `src/` for their hosts,
  and `apps/storefront/tests/bagikan-build-smoke.test.ts` builds against the stub and
  asserts the rendered row (and the follow links' correct ABSENCE, given
  the fixture profile has no TikTok/YouTube) on a real article page and the
  video page.
- `apps/storefront/src/styles/bagikan.css` is a new, component-imported
  stylesheet; `apps/storefront/src/styles/berita.css` is untouched (its `.article-share`
  rules are now unused — a follow-up cleanup once this wave's concurrent
  edits to the article templates have landed).
