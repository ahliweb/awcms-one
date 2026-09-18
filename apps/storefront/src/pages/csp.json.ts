/**
 * `/csp.json` — the external origins this build's pages reference, written
 * as a build artifact and read back at startup by `server/penyaji.mjs` to
 * widen its `img-src` to exactly those origins.
 *
 * Emitted as an Astro endpoint rather than a `scripts/*.mjs` build step for
 * one reason: the URLs it collects come from the SAME memoized
 * `getProducts()`/`getActive*()` calls every page already made, so the
 * artifact is derived from precisely the data that was rendered — not from
 * a second fetch that could disagree with it (a product published between
 * two requests, a marketing item whose image changed). It costs no extra
 * request to `apps/cms`.
 *
 * See `src/lib/csp-asal-media.ts` for why the policy is derived from content
 * instead of configured through an env variable, and what that trades away.
 *
 * The file is public by construction. It names only origins that already
 * appear in the HTML this same build published, so it reveals nothing a
 * reader could not read off a product page's `<img src>`.
 *
 * ## Issue #30: `connectSrc` stops being permanently empty
 *
 * `src/lib/csp-asal-media.ts`'s `connectSrc` field existed since issue #27
 * but had no producer — no page made a browser-side request to another
 * origin yet. Cart/checkout/order-tracking are the first: the browser calls
 * `<PUBLIC_AWCMS_ORIGIN>/api/v1/commerce/storefront/*` directly
 * (`src/lib/toko-klien.ts`, ADR-0007 revised). `requireAwcmsOrigin()`
 * (`src/lib/awcms/toko-origin.ts`) is called HERE, in a page that is
 * unconditionally prerendered as part of every `astro build`, specifically
 * so an unset/malformed `PUBLIC_AWCMS_ORIGIN` fails the BUILD — a checkout
 * page that silently posts nowhere is the failure this exists to prevent —
 * with a message naming the variable, rather than shipping a storefront
 * that only fails once a shopper tries to check out. This is the ONE place
 * that origin is added to the CSP artifact; there is no second mechanism.
 *
 * ## Issue #56 (A10): the GA branch — a FLAG, not a derived origin
 *
 * Kept deliberately separate from everything above (which derives origins
 * from CMS-sent DATA — see `src/lib/csp-asal-media.ts`'s own "why DERIVED,
 * not configured"). GA's origins are the opposite: fixed, Google-owned
 * constants, gated by one build-time boolean (`PUBLIC_GA_ID` shaped like a
 * real GA4 id — `src/lib/ga.ts`). There is nothing to derive, so this does
 * not extend `buildCspOriginsArtifact`/`CspOriginsArtifact` (owned by A1,
 * issue #47, for the media-origin/`frame-src` work) — it appends one extra
 * `ga` boolean onto that same artifact object right before it is written.
 * `server/penyaji.mjs`'s `buildCsp` reads that flag and adds its OWN
 * hardcoded GA origins to `script-src`/`connect-src` — never origins that
 * flow through this file's `sanitizeOrigins`-style validation, because a
 * literal `https://*.google-analytics.com` (GA's own documented CSP
 * snippet, wildcard subdomain and all) is exactly the shape
 * `server/penyaji.mjs`'s `sanitizeOrigins` deliberately refuses from
 * anything CMS/attacker-influenced (`*` is rejected outright — see that
 * function's own tests). A hardcoded constant controlled entirely by this
 * app's own code does not need — and must not go through — that guard.
 *
 * ## Issue #47: the media origin, and the two fixed YouTube origins
 *
 * `getMediaPublicOrigin()` (`src/lib/awcms/media.ts`) is the verified,
 * purpose-built source for the media host every resolved `<img>` (hero
 * figures, card thumbnails, gallery images, ad creatives) is served
 * from — see that function's own docblock for why this reads better than
 * deriving the origin from the resolved URLs this build happened to render
 * (a build with zero images would then emit no `img-src` entry and the next
 * image added would need a rebuild to show, same trade `apps/cms`'s own
 * docblock states for that endpoint).
 *
 * `https://i.ytimg.com` (the poster) and `https://www.youtube-nocookie.com`
 * (the `<iframe>` the click-to-load facade swaps in) are genuinely DERIVED,
 * not hard-coded unconditionally: they are added only when `getVideo()`
 * (`src/lib/berita.ts`) answers at least one post, i.e. this build actually
 * has a page the facade can appear on — a build with no video posts widens
 * neither directive, matching this file's own "derived from content"
 * philosophy for every other origin here.
 *
 * ## Review finding: `mediaOrigin` alone is not enough
 *
 * `getMediaPublicOrigin()` names the CURRENTLY CONFIGURED media host — but a
 * resolved `publicUrl` (a post's hero, a gallery item, an ad creative) is
 * whatever host was configured WHEN that row's object was uploaded, which a
 * deployment that migrated media hosts since can disagree with. Relying on
 * `mediaOrigin` alone would silently CSP-block an older row's image the
 * exact way the pre-issue-#27 bug blocked every product photo. Every
 * resolved media object's `publicUrl` (`getResolvedMedia()`) and every
 * active ad creative's `mediaPublicUrl` (`getActiveAdPlacements()`) are
 * therefore pushed into `imageUrls` the same way a product's own images
 * already are, ABOVE and IN ADDITION TO `mediaOrigin.origin` — the latter
 * stays too, so a build with a resolved image but a currently-unconfigured
 * host still degrades correctly, and a build with zero resolved images yet
 * still gets an `img-src` entry ready for the first one.
 */
import { getProducts } from "../lib/catalog";
import {
  getActiveSliders,
  getActiveTestimonials,
  getActivePopup,
  getActiveFlashSales,
  getStoreSettings
} from "../lib/awcms/pemasaran";
import { buildCspOriginsArtifact } from "../lib/csp-asal-media";
import { requireAwcmsOrigin } from "../lib/awcms/toko-origin";
import { readGaMeasurementId } from "../lib/ga";
import { getMediaPublicOrigin } from "../lib/awcms/media";
import { getVideo, getResolvedMedia } from "../lib/berita";
import { getActiveAdPlacements } from "../lib/awcms/blog";

/** YouTube's own fixed poster CDN — see this file's own header. */
const YOUTUBE_POSTER_ORIGIN = "https://i.ytimg.com";
/** The `youtube-nocookie` embed origin the click-to-load facade's `<iframe>` points at. */
const YOUTUBE_EMBED_ORIGIN = "https://www.youtube-nocookie.com";

export const prerender = true;

export async function GET(): Promise<Response> {
  const [
    products,
    sliders,
    testimonials,
    popup,
    flashSales,
    storeSettings,
    mediaOrigin,
    videoPosts,
    resolvedMedia,
    adSlots
  ] = await Promise.all([
    getProducts(),
    getActiveSliders(),
    getActiveTestimonials(),
    getActivePopup(),
    getActiveFlashSales(),
    getStoreSettings(),
    getMediaPublicOrigin(),
    getVideo(),
    getResolvedMedia(),
    getActiveAdPlacements()
  ]);

  const imageUrls: Array<string | null | undefined> = [];

  for (const product of products) {
    for (const image of product.images) imageUrls.push(image.publicUrl);
    for (const variant of product.variants) imageUrls.push(variant.imageUrl);
  }

  for (const slider of sliders) imageUrls.push(slider.image?.url);
  for (const testimonial of testimonials) imageUrls.push(testimonial.avatar?.url);
  for (const sale of flashSales) {
    for (const entry of sale.products) imageUrls.push(entry.product.image?.url);
  }

  imageUrls.push(popup?.image?.url);
  imageUrls.push(storeSettings.logo?.url);
  imageUrls.push(storeSettings.favicon?.url);

  // Issue #47: every ACTUAL resolved article/gallery image and ad
  // creative's own URL — pushed the same way a product's own images are
  // above, so a row on a different (e.g. pre-migration) host still widens
  // the policy correctly. See this file's own header, "Review finding:
  // mediaOrigin alone is not enough".
  for (const media of resolvedMedia.values()) imageUrls.push(media.publicUrl);
  for (const creatives of Object.values(adSlots)) {
    for (const ad of creatives ?? []) imageUrls.push(ad.mediaPublicUrl);
  }

  // The CURRENTLY CONFIGURED media host, in ADDITION to the above — covers
  // a build with zero resolved images yet (see this file's own header).
  if (mediaOrigin.configured && mediaOrigin.origin) {
    imageUrls.push(mediaOrigin.origin);
  }

  const frameUrls: Array<string | null | undefined> = [];
  if (videoPosts.length > 0) {
    imageUrls.push(YOUTUBE_POSTER_ORIGIN);
    frameUrls.push(YOUTUBE_EMBED_ORIGIN);
  }

  // Throws (naming the variable) when `PUBLIC_AWCMS_ORIGIN` is unset or
  // malformed — see this file's own docblock for why that failure belongs
  // HERE, in a page every build unconditionally prerenders.
  const awcmsOrigin = requireAwcmsOrigin();

  const derivedArtifact = buildCspOriginsArtifact(imageUrls, [awcmsOrigin], frameUrls);

  // GA branch (issue #56, A10) — see this file's own docblock. `ga` is
  // simply omitted (not `false`) in the default build; `readCspOrigins`
  // treats a missing flag the same way it treats every other missing
  // field — as "off".
  const artifact = readGaMeasurementId()
    ? { ...derivedArtifact, ga: true }
    : derivedArtifact;

  return new Response(JSON.stringify(artifact), {
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
