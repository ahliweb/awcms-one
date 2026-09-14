/**
 * Site configuration for this deployment.
 *
 * Everything a deployment changes lives here or in `.env` — no other file
 * should need editing to point this app at a different name or origin.
 */
import { readEnvOr } from "../lib/env";

/**
 * `SITE_URL` is read at BUILD time and must be the canonical absolute
 * origin — it is what canonical links, Open Graph URLs, and the Product
 * JSON-LD are all built from. A wrong value does not break the build; it
 * publishes a site that points every crawler and every share somewhere
 * else, which is why it has no silent default in production.
 *
 * Also read directly in `astro.config.mjs` (Astro needs it before this
 * module can run) — the two are kept in step by reading the same
 * environment variable, not by importing one from the other.
 */
const siteUrl = readEnvOr("SITE_URL", "http://localhost:4321").replace(
  /\/+$/,
  ""
);

export const siteConfig = {
  name: readEnvOr("SITE_NAME", "Borneojek Mart"),
  description: readEnvOr("SITE_DESCRIPTION", "Katalog produk borneojek-mart."),
  siteUrl,
  domain: new URL(siteUrl).host
};

/** Resolves a site-relative path (e.g. `/product/produk-x`) to an absolute URL under `siteConfig.siteUrl`. */
export function absoluteUrl(path: string): string {
  return new URL(path, siteConfig.siteUrl).toString();
}
