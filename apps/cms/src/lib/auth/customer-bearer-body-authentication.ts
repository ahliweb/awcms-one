/**
 * The pre-body credential check for endpoints authenticated by a CUSTOMER
 * bearer session (ADR-0016), the counterpart of `api-body-authentication.ts`.
 *
 * Called from `src/middleware.ts` for the endpoints declared in
 * `CUSTOMER_BEARER_BODY_ENDPOINTS` (`api-body-auth-boundary.ts`), which the
 * staff check would refuse for every real shopper. It keeps the boundary's
 * property: nobody without a live credential reaches body parsing.
 *
 * Authentication only, and READ only: the sliding-TTL touch stays with the
 * handler's own `requireCustomerSession`. The tenant is resolved exactly as
 * the handlers resolve it (`withPublicCommerceTenant`: Origin first for a
 * cross-origin storefront, host otherwise), so an unresolvable tenant, a
 * disabled `commerce` module and a refused origin all collapse into the same
 * `401 UNAUTHENTICATED` the handlers answer, carrying the same CORS headers
 * (a browser cannot read a CORS-less 401, and the storefront clears its stored
 * session on that status; see `apps/storefront/src/lib/akun-klien.ts`).
 */
import { getDatabaseClient } from "../database/client";
import { fail } from "../../modules/_shared/api-response";
import { findLiveCustomerSession } from "../../modules/commerce/application/customer-session-auth";
import { withPublicCommerceTenant } from "../../modules/commerce/application/public-commerce-tenant";

/** `null` when the request holds a live customer session; otherwise the refusal. */
export async function refuseUnauthenticatedCustomerBody(
  request: Request,
  now: Date
): Promise<Response | null> {
  const { result, corsHeaders } = await withPublicCommerceTenant<boolean>(
    getDatabaseClient(),
    request,
    async (tx, tenant) =>
      (await findLiveCustomerSession(request, tx, tenant.tenantId, now)) !==
      null
  );

  if (result === true) return null;

  return fail(
    401,
    "UNAUTHENTICATED",
    "Missing, invalid, or expired session.",
    {},
    undefined,
    corsHeaders
  );
}
