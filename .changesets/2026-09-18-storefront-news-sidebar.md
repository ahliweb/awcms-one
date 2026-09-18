---
bump: minor
type: content
impact: public
---

# Shared news sidebar, homepage ad slots in seputarborneo's order, a real "Terpopuler" (issue #49)

Until now only `/berita` had a sidebar — an inline `<aside>` from issue #28
with a "Terpopuler" that was really "latest", one of the CMS's three sidebar
ad slots, and a tag cloud — and every other news page (article, video,
rubrik, tag, author, archive, search) had no side column at all. The site
this platform replaces (seputarborneo.com) renders one shared sidebar on
every one of those pages, and its own `include/sidebar.php` exists precisely
because the copy-pasted per-page versions before it had drifted. Two of the
three sidebar ad positions the CMS already models (`sidebar_middle`,
`sidebar_bottom`) and two of the three homepage positions (`homepage_middle`,
and `homepage_bottom` in its in-page position) had no surface to render on,
and issue #50's newsletter form existed but was mounted nowhere a reader
would find it.

- `Sidebar.astro` — one component, rendered by `/berita`, `/berita/{slug}`,
  `/video`, `/video/{slug}`, `/rubrik/**`, `/tag/{slug}`, `/penulis/{slug}`,
  `/arsip/{yyyy}/{mm}` and `/cari-berita`, in seputarborneo's order: the
  tabbed **Terbaru / Mitra Borneo** list (the real WAI-ARIA tabs pattern,
  BOTH panels in the HTML, the first shown with no JavaScript), `sidebar_top`,
  **Terpopuler**, the 24-institution Mitra Borneo directory, `sidebar_middle`,
  the newsletter box (`FormBuletin variant="sidebar"`), `sidebar_bottom`, the
  tag cloud. Every slot renders nothing when nothing is booked.
- `/berita`'s homepage slots now follow seputarborneo `index.php`'s order:
  `below_headline` after the headline, `homepage_middle` after the first
  three rubrik sections, `homepage_bottom` after the rest and before the
  video strip. `homepage_bottom` is also the key the footer leaderboard
  (issue #48) reuses — so on `/berita` that creative renders twice, a
  deliberate consequence of the issue's mapping, recorded rather than hidden,
  because a dedicated footer key is an upstream `blog_content` change.
- A top-level rubrik's front-page section now includes posts filed under
  any of its DESCENDANT rubrik — the same walk `/rubrik/{slug}` has always
  done. Surfaced by this change: a post filed straight into a grandchild
  rubrik (Hukum > Pidana) used to reach the front page only through the old
  aside's "Terpopuler" cards, so replacing that aside would otherwise have
  dropped it from `/berita` entirely.
- **"Terpopuler" is ranked from real readership.** A new
  `apps/storefront/src/lib/awcms/analitik.ts` reads `GET /api/v1/analytics/pages?range=7d`
  (route, query, `visitor_analytics.dashboard.read` permission and
  `{ range, pages: [{ name, count }] }` envelope all verified against the
  route file, not the issue text), folds every query-string variant of one
  post's `path_sanitized` into one count — that column keeps every
  non-sensitive parameter, so `/berita/x` and `/berita/x?utm_source=…` are
  separate rows the naive reading would split a post's readership across —
  ranks every post by it, and tops up with the newest posts. A 403/404
  (module off — it is off by default — permission missing, older CMS) or an
  empty answer degrades silently to exactly the pre-#49 "latest" list; the
  fallback is stated in code, never as a caveat in the UI, because a caveat
  there describes the deployment's configuration, not the news. The
  permission is added by name to the seed's storefront token set.
- **One newsletter form per page, by construction, and why.** The footer
  box is filled from `BeritaLayout.astro` with `FormBuletin variant="footer"`
  and issue #50's script is mounted there once — but that script wires the
  FIRST `[data-buletin-form]` on the page and no other, and the sidebar's
  form comes first in DOM order, so a page with both would ship a footer
  form that submits nowhere (a bare `<form>` GETs the reader's e-mail into
  the page's own URL). The layout therefore renders its page slot to a
  string, detects the sidebar's newsletter box by its exported id, and
  links the footer box to it instead of mounting a second form. Detected
  rather than declared by a prop so a future sidebar page cannot forget it.
  The permanent fix — that script wiring every form — is a one-line change
  to issue #50's file, outside this issue's ownership, and is tracked as a
  follow-up; the detection can go once it lands.
- Stub + fixture for the analytics endpoint (with the real route's `range`
  validation in front of it); `ad-placements-active.json` now books every
  sidebar and homepage slot, and leaves `article_top`/`article_bottom` empty
  so the build proves "no empty box" too. `apps/storefront/tests/analitik-terpopuler.test.ts`
  covers the mapping, ranking, fallback and the fetch's degrade rules;
  `apps/storefront/tests/sidebar-build-smoke.test.ts` asserts on the built HTML that the
  sidebar is byte-identical across page families, both tab panels ship, all
  six slots render in order, Terpopuler is ranked by the fixture, and every
  page carries exactly one newsletter form.
