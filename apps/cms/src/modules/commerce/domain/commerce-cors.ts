/**
 * Cross-origin policy for the anonymous storefront commerce endpoints
 * (Issue #29), copied from `newsletter/domain/newsletter-cors.ts` almost
 * verbatim — the storefront-endpoints contract states plainly that this
 * family follows "the same cross-origin pattern awcms already hardened for
 * newsletter, search and comments." See that file's own header for the full
 * "what was actually broken" history this repeats rather than relitigates:
 * an unanswered preflight, an unreadable answer with no
 * `Access-Control-Allow-Origin`, and a tenant resolved from the wrong thing
 * (the request HOST, which for a statically built storefront is always this
 * CMS, never the shopper's own site).
 *
 * ## Never `*`, `Vary: Origin` on every response, no credentials
 *
 * Same three rules, same reasons, as `newsletter-cors.ts`. This surface
 * additionally never sets `Access-Control-Allow-Credentials` — no route
 * under `/api/v1/commerce/storefront/*` reads or sets a cookie; every
 * "session" here is a `(orderCode, phone)` pair or a client-generated
 * `idempotencyKey`, carried in the request body/query, never a cookie.
 */
export type CommerceOriginDecision =
  | { kind: "same_origin" }
  | { kind: "granted"; origin: string }
  | { kind: "refused" };

/** Same value newsletter/search settled on — long enough a shopper's whole checkout flow pays for one preflight, short enough a removed domain takes effect promptly. */
export const COMMERCE_PREFLIGHT_MAX_AGE_SECONDS = 600;

export function commerceCorsHeaders(
  decision: CommerceOriginDecision
): Record<string, string> {
  if (decision.kind === "granted") {
    return { "access-control-allow-origin": decision.origin, vary: "Origin" };
  }
  return { vary: "Origin" };
}

export function commercePreflightHeaders(
  decision: CommerceOriginDecision
): Record<string, string> {
  const granted = commerceCorsHeaders(decision);
  if (decision.kind !== "granted") return granted;

  return {
    ...granted,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": String(COMMERCE_PREFLIGHT_MAX_AGE_SECONDS)
  };
}
