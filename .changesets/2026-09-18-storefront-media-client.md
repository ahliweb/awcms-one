---
bump: minor
type: content
impact: public
---

# Storefront media client: article images, ad creatives, YouTube facade

`apps/storefront` could see that a post, a gallery item, or an ad
placement HAD a photo or a video, but had no way to turn that into a URL —
`src/lib/awcms/media.ts` had no `media_library` read client at all, so
every image-bearing block degraded to a stated placeholder (issue #28's own
recorded deviation). A reader of the news surface saw text, never a photo;
a video post linked out to YouTube instead of playing inline; an ad slot
showed its name, never its creative.

`src/lib/awcms/media.ts` batch-resolves a media object id to its public
reference via `GET /api/v1/media/objects` (chunked at 100 ids per call,
memoized per build) and reads the deployment's media origin via
`GET /api/v1/media/public-origin` for the CSP artifact — both newly
verified against `apps/cms`'s own route files rather than guessed from the
issue text. `src/lib/berita.ts` collects every visible post's
`featuredMediaId` and every gallery item's `mediaObjectId` up front and
resolves them in one batched call; an id that does not resolve (unverified,
deleted, or never uploaded) is logged once and renders as no image, never a
broken `<img>`.

- A news card and an article's hero figure now render a real, sized `<img>`
  (no CLS) with a credit line when the CMS has verified the media's rights.
- A gallery image and an ad creative render as real `<img>`s.
- A `videoNews` block renders a click-to-load facade — a poster image from
  YouTube's own fixed CDN convention, swapped for a real
  `youtube-nocookie.com` `<iframe>` only after a genuine click
  (`src/scripts/video-facade.ts`) — never a third-party frame/script before
  that.
- `src/pages/csp.json.ts` widens `img-src` with the resolved media origin
  and, only when this build has a video post, `img-src`/`frame-src` with
  the two YouTube origins the facade needs.
- The storefront build credential's permission set
  (`tools/seed-borneojek-mart.ts`) gains `media_library.media.read`.

**Known cross-PR dependency:** `apps/storefront/server/penyaji.mjs`'s
`buildCsp` (a sibling issue this wave, not this change) does not yet read
the CSP artifact's new `frameSrc` field — until it does, a real deployment
still serves `frame-src 'none'` and the facade's `<iframe>` will not load,
even though every other piece (the resolved images, the artifact itself)
already works. The artifact change is additive and does not regress an
older reader.
