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
  there describes the deployment's configuration, not the news. The route
  returns the tenant-wide top 50 paths with no limit parameter, so a post
  ranked 51st or lower overall is invisible to the ranking and loses to a
  zero-view top-up post — documented, not worked around. The permission is
  added by name to the seed's storefront token set — **which changes the
  credential's scope: the seed's scope-reconcile (issue #57) revokes and
  reissues the live storefront credential on its next run against an
  already-seeded tenant, and a build still holding the previous
  `AWCMS_API_TOKEN` gets `401` until it is given the newly printed one.**
- **The newsletter form is mounted in the footer of every news page AND in
  the sidebar's box** — two forms on most news pages, as seputarborneo has.
  That exposed a defect in issue #50's `apps/storefront/src/scripts/buletin.ts`:
  it wired the FIRST `[data-buletin-form]` only, so the footer form (second
  in DOM order) would have submitted nowhere — a bare `<form>` GETs the
  reader's e-mail into the page's own URL. `wireBuletinForms(root)` now
  wires every form with its own closure (no shared mutable state), takes
  its root as a parameter, and is covered by a two-forms-on-one-document
  unit test with a hand-rolled fake DOM (`apps/storefront/tests/buletin-forms.test.ts`).
  The footer's own form CSS (`berita-chrome.css`, written before the form
  existed) is stacked instead of a single flex row, so the consent sentence
  no longer sits beside the input.
- Stub + fixture for the analytics endpoint (with the real route's `range`
  validation in front of it); `ad-placements-active.json` now books every
  sidebar and homepage slot, and leaves `article_top`/`article_bottom` empty
  so the build proves "no empty box" too. `apps/storefront/tests/analitik-terpopuler.test.ts`
  covers the mapping, ranking, fallback and the fetch's degrade rules;
  `apps/storefront/tests/sidebar-build-smoke.test.ts` asserts on the built HTML that the
  sidebar is byte-identical across page families, both tab panels ship, all
  six slots render in order, Terpopuler is ranked by the fixture, and a
  sidebar page carries both newsletter forms with distinct ids. The
  now-unused `getTerpopuler()` in `apps/storefront/src/lib/berita.ts` is removed.
