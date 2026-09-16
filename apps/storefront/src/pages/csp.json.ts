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

  const artifact = buildCspOriginsArtifact(imageUrls, [awcmsOrigin]);

  return new Response(JSON.stringify(artifact), {
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
