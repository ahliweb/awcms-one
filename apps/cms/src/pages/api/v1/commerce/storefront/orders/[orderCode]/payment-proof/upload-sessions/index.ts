import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../../../../lib/database/client";
import { fail } from "../../../../../../../../../modules/_shared/api-response";
import { commercePreflightResponse } from "../../../../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../../../../modules/commerce/application/public-commerce-tenant";

/**
 * `POST /api/v1/commerce/storefront/orders/{orderCode}/payment-proof/
 * upload-sessions` (Issue #29) — always `503 MEDIA_UNAVAILABLE` in this
 * increment.
 *
 * `media-library`'s existing presigned-upload-session flow
 * (`createPendingNewsMediaObject`/`finalizeNewsMediaUploadSession`) requires
 * a real authenticated `actorTenantUserId` and checks
 * `authorizeInTransaction` with a session `tokenHash` — there is no
 * anonymous caller here to supply either. Building a SECOND, parallel
 * anonymous-safe upload-session seam bound to `(orderCode, phoneHash)`
 * instead of a principal is a real, security-sensitive design (a session an
 * attacker could otherwise use to write arbitrary files under this
 * tenant's media registry) that this increment did not have the room to
 * design and review carefully enough to ship — see
 * `application/order-directory.ts`'s header for the full reasoning.
 *
 * A payment confirmation WITHOUT a proof image is still fully accepted
 * (`POST .../payment-confirmations`); the public store-settings read model
 * says `payment.proofUpload: false` precisely so the storefront hides the
 * "attach a proof" control rather than offering one that always fails.
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
    "Payment-proof upload is not available on this deployment. Submit the confirmation without a proof image.",
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
