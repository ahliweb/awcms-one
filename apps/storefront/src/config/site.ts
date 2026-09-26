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

/**
 * The identity/theme fallback for this deployment (issue #24) — the live
 * site's own public values, used whenever `apps/cms`'s `site-profile`/
 * `theming` modules have nothing for a field (the tenant has not configured
 * it, or the endpoint 403s/404s on a build credential minted before that
 * module existed). Never a placeholder invented for this app: every value
 * below is BjekMart's real, already-public identity.
 *
 * `SITE_NAME`/`SITE_DESCRIPTION` env vars, when set, override even a value
 * the CMS returns — see `src/lib/awcms/profil.ts`'s `getSiteIdentity()`,
 * which is the ONE place this constant and the env vars above are combined
 * with a live CMS fetch. Nothing else should read `DEFAULT_IDENTITY`
 * directly.
 *
 * `contactPhone`/`address` are typed `string | null` (issue #233): a
 * derived repo's `template:init` run writes `null` for whichever of
 * `--kontak-telepon`/`--alamat` was omitted, rather than leaving BjekMart's
 * own real phone number and street address as a live fallback forever.
 * Every consumer of `SiteIdentity.contactPhone`/`.address`
 * (`src/lib/awcms/profil.ts`'s `mergeSiteIdentity`, and every page/
 * component that renders them) already guards for `null` — see
 * `src/pages/kontak.astro`'s "Alamat" card and `src/components/Footer.astro`
 * / `src/components/berita/FooterBerita.astro` / `src/profil/landing/
 * Beranda.astro`.
 */
export type DefaultIdentity = {
  readonly name: string;
  readonly description: string;
  readonly contactEmail: string;
  readonly contactPhone: string | null;
  readonly address: string | null;
};

export const DEFAULT_IDENTITY: DefaultIdentity = {
  name: "BjekMart",
  description: "Belanja online hemat, mudah, dan terpercaya di BjekMart",
  contactEmail: "borneojekpangkalanbun@gmail.com",
  contactPhone: "0851-2868-8885",
  address: "Jl. Ahmad Wongso RT 19 Kelurahan Madurejo, Kotawaringin Barat"
};

/**
 * The default theme palette (issue #24) — BjekMart's own emerald brand
 * colors, used whenever `apps/cms`'s `theming` module has nothing published
 * for this tenant. See `src/lib/awcms/theme.ts` for how (and how rarely)
 * this is overridden by a live CMS value, and its docblock for why
 * `secondary` in particular has no CMS equivalent to override it with.
 */
export const DEFAULT_THEME_COLORS = {
  primary: "#10b981",
  secondary: "#0f766e",
  accent: "#f59e0b"
} as const;
