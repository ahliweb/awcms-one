import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../../lib/database/client";
import {
  handleCustomerPushPreferencesGet,
  handleCustomerPushPreferencesPut
} from "../../../../../../../modules/commerce/application/customer-push-http";
import { commercePreflightResponse } from "../../../../../../../modules/commerce/application/public-commerce-preflight";
import { CUSTOMER_PUSH_RATE_LIMITS } from "../../../../../../../modules/commerce/domain/customer-push";

/**
 * `GET|PUT /api/v1/commerce/storefront/account/push/preferences` (Issue #430,
 * ADR-0048 sections 2.3 and 6.1) - the shopper's consent per purpose
 * (`order_updates`, `payment_updates`, `support_replies`; `marketing` is reserved
 * and refused). `PUT` takes `{ purposes: { <purpose>: boolean }, textVersion }`
 * and changes only the purposes it names; turning one ON records the consent
 * wording version, turning one OFF never needs it. Bearer only.
 */
const PREFLIGHT_ALLOWED_HEADERS = ["content-type", "authorization"] as const;

export const GET: APIRoute = ({ request, clientAddress, locals }) =>
  handleCustomerPushPreferencesGet({
    request,
    clientAddress,
    correlationId: locals.correlationId
  });

export const PUT: APIRoute = ({ request, clientAddress, locals }) =>
  handleCustomerPushPreferencesPut({
    request,
    clientAddress,
    correlationId: locals.correlationId
  });

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:push:preferences",
    CUSTOMER_PUSH_RATE_LIMITS.mutateIp,
    PREFLIGHT_ALLOWED_HEADERS
  );
