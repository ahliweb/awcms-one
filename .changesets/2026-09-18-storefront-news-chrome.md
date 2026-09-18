---
bump: minor
type: content
impact: public
---

# `apps/storefront`: news chrome — primary nav, Daerah panel, ticker, utility bar, footer directory, footer leaderboard slot, back-to-top

Every news-surface page (`/berita`, `/rubrik/*`, `/daerah/*`, `/mitra/*`,
`/video`, `/tag/*`, `/penulis/*`, `/arsip/*`, `/cari-berita`) rendered the
STORE's commerce header/footer — product nav, a cart badge, a wishlist link —
because `BeritaLayout.astro` only ever wrapped `BaseLayout.astro` and added a
stylesheet. A reader landing on a news article saw "Keranjang"/"Wishlist" in
the header and a commerce footer with no way back into the news section's own
taxonomy. This closes issue #48 (increment 3, epic #46), porting
seputarborneo.com v2.4.0's own header/nav/footer patterns — not its PHP —
onto this app's real, live CMS data.

- `BeritaLayout.astro` now renders its own page shell (`BilahUtilitas` →
  `NavBerita` + the Daerah panel → `Ticker` → `<main id="konten">` →
  `FooterBerita`) instead of delegating to `BaseLayout.astro`'s commerce
  `Header`/`Footer` — a deliberate, documented trade-off (see that file's own
  docblock): `BaseLayout.astro` has no extension point to swap its chrome,
  and is outside this issue's file ownership this wave. A follow-up should
  extract the shared `<head>` assembly both layouts now duplicate.
- The utility bar (`BilahUtilitas.astro`): today's WIB date, the editorial
  e-mail, the Redaksi/Pedoman Media Siber/Disclaimer links (rendered only
  when actually published), and official-account social icons — Facebook, X,
  Instagram, TikTok, YouTube, Threads — detected by URL host
  (`apps/storefront/src/lib/ikon-sosial.ts`), with an independent `http(s)`-only guard even
  though the CMS already filters at the source.
- The primary nav (`NavBerita.astro`, data from `apps/storefront/src/lib/navigasi-berita.ts`):
  Beranda · Politik · Hukum · Nasional · Olah Raga · Wisata · Daerah · Video —
  a rubrik missing from this build's taxonomy is omitted, never a dead link.
  The Daerah panel (14 Kalteng regencies/cities with an institution) is
  always fully server-rendered, with no `hidden` attribute in the initial
  HTML — a `<script>` only ever ADDS `hidden` at runtime, and only when the
  reader is not already on a `/daerah/*` page; `Escape` closes it and returns
  focus to the toggle.
- The "Terkini" ticker (`Ticker.astro`): the 3 latest post titles, as a plain
  static list — no auto-scrolling marquee, so there is no motion for
  `prefers-reduced-motion` to need to disable in the first place.
- The footer (`FooterBerita.astro`): brand/contact, Rubrik, Umum, and Daerah
  columns, the full Mitra Borneo institution directory ordered
  Pemprov/DPRD Kalteng first then per regency, a `<slot name="buletin" />`
  for issue #50's newsletter form, the legal bar, and a leaderboard
  (`<IklanSlot placement="homepage_bottom">`, decision 4 of epic #46 — reuses
  the existing placement key rather than inventing one) rendered above the
  footer. Back-to-top is a real, always-present `<a href="#atas">` — CSS
  hides it until scrolled, but `:focus-visible` reveals it for keyboard users
  regardless of scroll position.
- The masthead logo stays a text wordmark this wave — this app has no
  media-object client yet (issue #47 adds one for article images only); a
  `TODO` in `NavBerita.astro` marks where a future issue resolves
  `identity.logoMediaId` to an `<img>`.

No page outside `apps/storefront` changed, and no `apps/cms` endpoint shape
is new — every field this issue reads was already verified against a route
file by earlier issues (`src/lib/awcms/{blog,wilayah,pages,profil}.ts`).
