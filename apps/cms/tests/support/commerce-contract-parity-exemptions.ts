/**
 * awcms-one local divergence (issue #557): the commerce operations that do not
 * meet the contract-parity rules of upstream ahliweb/awcms#1385 / #1427
 * (`tests/openapi-rate-limit-and-idempotency-declared.test.ts`) and are
 * exempted by name.
 *
 * Issue #557 declared `429`, `Retry-After` and `Idempotency-Key` on every
 * `commerce` operation whose handler applies them, and made the `commerce` key
 * readers visible to the test's static call-graph scan (a handler that reached
 * `requireIdempotencyKey` through a bare `export { x } from` re-export was
 * invisible to it; `expense-http.ts`, `documents-http.ts` and
 * `booking-adapter-http.ts` now forward it through a declaration). One entry
 * remains, and it is the scan that is wrong, not the contract:
 *
 * - `POST .../quotations/{id}/convert` reaches `checkSharedRateLimit` only
 *   through `createPosOrder -> resolveStoredValueAccounts`, a branch that runs
 *   for a stored-value tender. A quotation conversion passes no tenders, so the
 *   handler can never answer `429`; declaring one would claim what the code does
 *   not do. It retires when upstream's scan can tell a reachable limiter from an
 *   unreachable one, or when conversion accepts tenders (then it declares `429`
 *   like `POST /commerce/pos/orders` does).
 *
 * The test fails when an entry is no longer needed (so the list can only
 * shrink), and a NEW commerce operation that breaks the rule is not exempt.
 * Resolution on a subtree-sync conflict: keep ours, then re-derive the list by
 * running the test.
 */
export const COMMERCE_CONTRACT_PARITY_EXEMPTIONS = {
  /** A rate-limited handler whose operation declares no `429`. */
  missing429: ["POST /api/v1/commerce/quotations/{id}/convert"],
  /** A `429` whose handler sends `Retry-After` but the operation does not declare it. */
  retryAfterUndeclared: [],
  /** A handler that reads `Idempotency-Key` but the operation does not declare it. */
  keyUndeclared: [],
  /** An operation that declares the key although the scan cannot see its handler read it. */
  keyUnread: []
} as const satisfies Record<string, readonly string[]>;
