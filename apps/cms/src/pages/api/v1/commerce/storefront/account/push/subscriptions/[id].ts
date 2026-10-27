import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../../../lib/database/client";
import { handleCustomerPushRevokeOne } from "../../../../../../../../modules/commerce/application/customer-push-http";
import { commercePreflightResponse } from "../../../../../../../../modules/commerce/application/public-commerce-preflight";
import { CUSTOMER_PUSH_RATE_LIMITS } from "../../../../../../../../modules/commerce/domain/customer-push";

/**
 * `DELETE /api/v1/commerce/storefront/account/push/subscriptions/{id}` (Issue
 * #430, ADR-0048 section 6.1) - revoke ONE of the shopper's own devices.
 * `204` on success; an absent, someone else's or already-revoked id is the same
 * neutral `404` (ownership is enforced inside the `WHERE`, not by a comparison
 * the answer could reveal). A blocked account may still revoke. Bearer only.
 */
const PREFLIGHT_ALLOWED_HEADERS = ["content-type", "authorization"] as const;

export const DELETE: APIRoute = ({ request, clientAddress, locals, params }) =>
  handleCustomerPushRevokeOne(
    { request, clientAddress, correlationId: locals.correlationId },
    params.id
  );

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:push:subscription",
    CUSTOMER_PUSH_RATE_LIMITS.mutateIp,
    PREFLIGHT_ALLOWED_HEADERS
  );
