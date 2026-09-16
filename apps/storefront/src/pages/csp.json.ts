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

  const artifact = buildCspOriginsArtifact(imageUrls);

  return new Response(JSON.stringify(artifact), {
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
