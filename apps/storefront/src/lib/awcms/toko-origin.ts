/**
 * `PUBLIC_AWCMS_ORIGIN` — the ONE new variable ADR-0007 (revised, issue #30)
 * introduces: the CMS origin the BROWSER calls directly for cart/checkout/
 * order-tracking, cross-origin, with no bearer token at all (the CMS
 * resolves the tenant from the request `Origin` — see the #29⇄#30 contract,
 * `commerce-storefront-endpoints.md`).
 *
 * ## Why this is `PUBLIC_`, and `AWCMS_API_TOKEN` (`src/lib/awcms/client.ts`) never is
 *
 * An origin is not a secret — it is the address a browser is being told to
 * call, the same way a `<link rel="canonical">` or an Open Graph URL is
 * public by construction. `AWCMS_API_TOKEN` is a credential; shipping it to
 * the browser would let every reader mint requests as this build's own
 * identity. Astro only inlines a variable into client code when it is
 * prefixed `PUBLIC_`, so the naming IS the boundary: get it backwards in
 * either direction (a `PUBLIC_` token, a non-`PUBLIC_` origin the checkout
 * script silently can't read) and the failure is exactly the kind that
 * passes every other gate and is only found by someone reading network
 * traffic.
 *
 * ## Why an unset value fails the BUILD, not just a browser request
 *
 * A storefront that ships with no configured CMS origin would render a
 * checkout page that looks complete and posts nowhere — silently, for
 * every visitor, until someone tries to buy something. `requireAwcmsOrigin`
 * is called from `src/pages/csp.json.ts`, a page that is unconditionally
 * PRERENDERED (`export const prerender = true`) as part of every
 * `astro build`, specifically so a thrown error here fails the build itself
 * with a message naming the variable — not a runtime surprise discovered by
 * a shopper.
 *
 * `src/lib/toko-klien.ts` (the browser-side client this origin is FOR) also
 * calls this function, so a build that somehow shipped anyway (a build
 * pipeline change that stops treating `csp.json.ts` as load-bearing) still
 * fails loudly in the browser console rather than silently fetching
 * `undefined`.
 */
import { readEnv } from "../env";

export class AwcmsOriginConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AwcmsOriginConfigError";
  }
}

const VARIABLE_NAME = "PUBLIC_AWCMS_ORIGIN";

/**
 * The configured CMS origin, validated as a bare `http(s)` origin with no
 * path/query/fragment/credential — the same shape `server/penyaji.mjs`'s
 * `sanitizeOrigins` already requires of a CSP source expression, checked
 * here too because this value is about to become one (`csp.json.ts`'s
 * `connectSrc`).
 *
 * Throws — never returns a fallback — for both "unset" and "set but not a
 * bare origin": a checkout page posting to a wrong or malformed address is
 * the same class of silent failure as posting to nothing.
 */
export function requireAwcmsOrigin(): string {
  const raw = readEnv(VARIABLE_NAME);

  if (!raw) {
    throw new AwcmsOriginConfigError(
      `${VARIABLE_NAME} is not set. This storefront's cart/checkout/order-tracking ` +
        `pages call the CMS directly from the browser (ADR-0007, revised) and need its ` +
        `public origin at build time to know where to send that request and to widen ` +
        `the CSP's connect-src to allow it. Set ${VARIABLE_NAME} to the CMS's own ` +
        `origin, e.g. https://cms.example.com — see .env.example.`
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AwcmsOriginConfigError(
      `${VARIABLE_NAME} is set to ${JSON.stringify(raw)}, which is not a valid URL. ` +
        `It must be a bare origin, e.g. https://cms.example.com — no path, query, or ` +
        `trailing slash.`
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AwcmsOriginConfigError(
      `${VARIABLE_NAME} must be an http(s) origin; got ${JSON.stringify(raw)}.`
    );
  }

  if (url.username || url.password || url.origin !== raw) {
    throw new AwcmsOriginConfigError(
      `${VARIABLE_NAME} must be a BARE origin (scheme://host[:port]) — no path, query, ` +
        `fragment, or credential. Got ${JSON.stringify(raw)}; did you mean ${JSON.stringify(url.origin)}?`
    );
  }

  return url.origin;
}
