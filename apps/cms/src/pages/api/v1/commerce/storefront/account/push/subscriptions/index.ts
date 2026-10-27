import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../../../lib/database/client";
import {
  handleCustomerPushRevokeAll,
  handleCustomerPushState,
  handleCustomerPushSubscribe
} from "../../../../../../../../modules/commerce/application/customer-push-http";
import { commercePreflightResponse } from "../../../../../../../../modules/commerce/application/public-commerce-preflight";
import { CUSTOMER_PUSH_RATE_LIMITS } from "../../../../../../../../modules/commerce/domain/customer-push";

/**
 * `GET|POST|DELETE /api/v1/commerce/storefront/account/push/subscriptions`
 * (Issue #430, ADR-0048 section 6.1) - the shopper's OWN browser push devices.
 *
 * - `GET`    capability (what the server knows), consent preferences, this
 *            account's active devices.
 * - `POST`   register or re-register this browser: `201` when the caller newly
 *            owns the device (new, transferred, revived), `200` for a no-op.
 * - `DELETE` revoke every device of this account (`204`, idempotent).
 *
 * Bearer only (`customerBearer`): no cookie, no staff credential. Behind the
 * per-tenant `customerPush` feature (default OFF = the neutral `404`). All
 * behaviour lives in `application/customer-push-http.ts`; this file is the Astro
 * adapter.
 */
const PREFLIGHT_ALLOWED_HEADERS = ["content-type", "authorization"] as const;

export const GET: APIRoute = ({ request, clientAddress, locals }) =>
  handleCustomerPushState({
    request,
    clientAddress,
    correlationId: locals.correlationId
  });

export const POST: APIRoute = ({ request, clientAddress, locals }) =>
  handleCustomerPushSubscribe({
    request,
    clientAddress,
    correlationId: locals.correlationId
  });

export const DELETE: APIRoute = ({ request, clientAddress, locals }) =>
  handleCustomerPushRevokeAll({
    request,
    clientAddress,
    correlationId: locals.correlationId
  });

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:push:subscriptions",
    CUSTOMER_PUSH_RATE_LIMITS.mutateIp,
    PREFLIGHT_ALLOWED_HEADERS
  );
