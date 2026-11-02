import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../lib/database/client";
import { fail } from "../../../../../../modules/_shared/api-response";
import { recordAuditEvent } from "../../../../../../modules/logging/application/audit-log";
import { requireCustomerSession } from "../../../../../../modules/commerce/application/customer-session-auth";
import { revokeSession } from "../../../../../../modules/commerce/application/customer-account-store";
import { revokeCustomerPushDevicesOfSession } from "../../../../../../modules/commerce/application/customer-push-devices";
import { commercePreflightResponse } from "../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../modules/commerce/application/public-commerce-tenant";

/**
 * `POST /api/v1/commerce/storefront/account/logout` (Issue #89, contract
 * #86/ADR-0016 D3) — bearer, anonymous otherwise (no admin identity, this is
 * the shopper revoking their OWN session). `204` on success; missing/
 * invalid/expired bearer answers `401 UNAUTHENTICATED` — never `403`, even
 * for a blocked account, since revoking a session a blocked account still
 * holds is exactly what this endpoint should let them do. Issue #430: the
 * push devices the session enrolled are revoked in the same transaction.
 */
const PREFLIGHT_ALLOWED_HEADERS = ["content-type", "authorization"] as const;

export const POST: APIRoute = async ({ request, locals }) => {
  const sql = getDatabaseClient();

  const { result, corsHeaders } = await withPublicCommerceTenant(
    sql,
    request,
    async (tx, tenant) => {
      const authOutcome = await requireCustomerSession(
        request,
        tx,
        tenant.tenantId
      );

      if (!authOutcome.ok) {
        return { unauthenticated: true } as const;
      }

      await revokeSession(tx, tenant.tenantId, authOutcome.sessionId);

      // Issue #430 (ADR-0048 5.3, T6): every push device this session enrolled
      // is revoked in the SAME transaction as the session, so a failure leaves
      // both or neither. Unconditional (not behind `customerPush`): devices
      // from an earlier period must still be revoked when the flag is off.
      await revokeCustomerPushDevicesOfSession(
        tx,
        tenant.tenantId,
        authOutcome.sessionId,
        locals.correlationId
      );

      await recordAuditEvent(tx, {
        tenantId: tenant.tenantId,
        moduleKey: "commerce",
        action: "commerce.customer.logout",
        resourceType: "customer_session",
        resourceId: authOutcome.sessionId,
        message: "Customer logged out.",
        correlationId: locals.correlationId
      });

      return { unauthenticated: false } as const;
    }
  );

  if (!result || result.unauthenticated) {
    return fail(
      401,
      "UNAUTHENTICATED",
      "Missing, invalid, or expired session.",
      {},
      undefined,
      corsHeaders
    );
  }

  return new Response(null, { status: 204, headers: corsHeaders });
};

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:account:logout",
    { maxAttempts: 60, windowMs: 60_000 },
    PREFLIGHT_ALLOWED_HEADERS
  );
