---
bump: minor
type: content
impact: public
---

# Storefront link previews: `og:image`, `article:*`, `video.other`, Twitter cards, `rel=prev/next`

A news article or video shared from `apps/storefront` previewed as a bare
title-and-description card on WhatsApp, Facebook, X and Telegram — no
picture, no date — because `BaseLayout.astro` rendered one fixed
six-tag Open Graph block for every page and had no way for a page to add
a `<meta>` of its own. Issue #28 recorded the gap twice (the article
docblock, `docs/seo.md`'s "Not built"); issue #47 then made the picture
AVAILABLE (`PostDetail.image`, `post.video`) without a tag to put it in.
For a news site, the share card IS the front page most readers see first,
so this is a reach problem, not a polish one.

`BaseLayout.astro` now takes two optional props — `ogType` (`website`
default, `article`, `video.other`) and `meta` (a typed list of
`property=`/`name=` + `content=` pairs, rendered one `<meta>` each after
the fixed block). Both default to "render exactly what rendered before",
so no store page's `<head>` changed — a build-smoke test holds
`/`, `/produk`, `/kategori/{slug}`, `/product/{slug}` and `/halaman/{slug}`
to a frozen snapshot of the pre-change block. `apps/storefront/src/lib/meta-sosial.ts`
builds the tags as plain data, one builder per `og:type`, so a page cannot
pair one type's `og:type` with another type's namespace (Open Graph
silently drops `article:*` under `video.other` — a mistake that would
never fail a build).

- `/berita/{slug}`: `og:type=article`, `og:image` + width/height/alt when
  the featured image resolved, `article:published_time`/`modified_time`
  (the same ISO timestamps the `NewsArticle` JSON-LD already carries),
  `article:section`, one `article:tag` per tag, and a Twitter card
  (`summary_large_image` with an image, `summary` without).
- `/video/{slug}`: `og:type=video.other`, `og:image` = the post's own
  featured image or else the same `hqdefault.jpg` YouTube poster the card
  and the facade already load (featured-first, like the card thumbnail;
  never `maxresdefault`, which YouTube 404s for SD-only uploads and would
  leave a `summary_large_image` card empty), `og:video:url` = the
  identical `youtube-nocookie.com/embed/{id}` the click-to-load facade
  loads, `video:release_date`/`video:tag`.
- News listing pages (`/berita`, rubrik/daerah/mitra/tag/penulis/arsip,
  `/video`): the site logo as `og:image` when `identity.logoMediaId`
  resolves through the issue-#47 media client — applied once in
  `BeritaLayout.astro`, deliberately not in `BaseLayout.astro`, which is
  what keeps the store pages provably unchanged. An unresolved logo emits
  nothing.
- `/rubrik/{slug}` and `/rubrik/{slug}/halaman/{n}`: `<link rel="prev">`/
  `<link rel="next">` through the layout's `head` slot; page 2's `prev` is
  the bare rubrik URL, never `/halaman/1`.
- Every `content` value reaches the page only through Astro's attribute
  escaping at the one render boundary — `jsonForScript()` stays reserved
  for the JSON-LD script block, where its JSON escapes are the right ones.
- `docs/seo.md` (and its mirror) gains an "Open Graph and Twitter Card by
  page type" section and a truthful "Not built"; the article page's
  docblock no longer claims either gap.
