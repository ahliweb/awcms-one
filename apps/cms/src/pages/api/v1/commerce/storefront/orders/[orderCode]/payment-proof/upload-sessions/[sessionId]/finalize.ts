import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../../../../../lib/database/client";
import { fail } from "../../../../../../../../../../modules/_shared/api-response";
import { commercePreflightResponse } from "../../../../../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../../../../../modules/commerce/application/public-commerce-tenant";

/**
 * `POST …/payment-proof/upload-sessions/{sessionId}/finalize` (Issue #29) —
 * always `503 MEDIA_UNAVAILABLE`. See the sibling `upload-sessions/index.ts`
 * for the full reasoning; kept as its own route (rather than folded away)
 * so the contract's documented path exists and answers a stable, honest
 * error instead of a bare 404 a client would have to special-case.
 */
export const POST: APIRoute = async ({ request }) => {
  const sql = getDatabaseClient();

  const { result, corsHeaders } = await withPublicCommerceTenant(
    sql,
    request,
    async () => true
  );

  if (!result) {
    return fail(404, "NOT_FOUND", "Not found.", {}, undefined, {
      vary: "Origin"
    });
  }

  return fail(
    503,
    "MEDIA_UNAVAILABLE",
    "Payment-proof upload is not available on this deployment.",
    {},
    undefined,
    corsHeaders
  );
};

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:orders:payment-proof",
    { maxAttempts: 60, windowMs: 60_000 }
  );
