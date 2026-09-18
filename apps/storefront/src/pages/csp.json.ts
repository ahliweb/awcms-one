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

export const prerender = true;

export async function GET(): Promise<Response> {
  const [products, sliders, testimonials, popup, flashSales, storeSettings] = await Promise.all([
    getProducts(),
    getActiveSliders(),
    getActiveTestimonials(),
    getActivePopup(),
    getActiveFlashSales(),
    getStoreSettings()
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

  // Throws (naming the variable) when `PUBLIC_AWCMS_ORIGIN` is unset or
  // malformed — see this file's own docblock for why that failure belongs
  // HERE, in a page every build unconditionally prerenders.
  const awcmsOrigin = requireAwcmsOrigin();

  const derivedArtifact = buildCspOriginsArtifact(imageUrls, [awcmsOrigin]);

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
