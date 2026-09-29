/**
 * Cross-origin policy for the anonymous-tenant-resolution, bearer-secured
 * `/api/v1/practice-irm/storefront/account/*` endpoints (Issue #270),
 * copied from `commerce/domain/commerce-cors.ts` almost verbatim — see that
 * file's header for the full "what was actually broken" history this
 * repeats rather than relitigates.
 *
 * Same three rules, same reasons: never `*`, `Vary: Origin` on every
 * response, no `Access-Control-Allow-Credentials` (a bearer token is a
 * capability the browser attaches explicitly via `Authorization`, never a
 * cookie it sends automatically).
 */
export type PracticeIrmOriginDecision =
  | { kind: "same_origin" }
  | { kind: "granted"; origin: string }
  | { kind: "refused" };

export const PRACTICE_IRM_PREFLIGHT_MAX_AGE_SECONDS = 600;

export function practiceIrmCorsHeaders(
  decision: PracticeIrmOriginDecision
): Record<string, string> {
  if (decision.kind === "granted") {
    return { "access-control-allow-origin": decision.origin, vary: "Origin" };
  }
  return { vary: "Origin" };
}

/**
 * `authorization` is always in the allow-list here (unlike commerce's
 * anonymous storefront family, which defaults to `content-type` only) —
 * every route under `/practice-irm/storefront/account/*` is bearer-secured
 * from the start (Issue #270 ships no anonymous route in this family at
 * all).
 */
export function practiceIrmPreflightHeaders(
  decision: PracticeIrmOriginDecision
): Record<string, string> {
  const granted = practiceIrmCorsHeaders(decision);
  if (decision.kind !== "granted") return granted;

  return {
    ...granted,
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-max-age": String(PRACTICE_IRM_PREFLIGHT_MAX_AGE_SECONDS)
  };
}
