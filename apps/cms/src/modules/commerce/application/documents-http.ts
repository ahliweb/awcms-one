/**
 * The HTTP plumbing every document-lifecycle route (`/api/v1/commerce/held-sales*`,
 * `quotations*`, `work-orders*`, `documents*`) shares (Issue #286, ADR-0029): the
 * `documents` feature gate on top of the register routes' idempotency-header,
 * body-parsing and idempotency-error helpers (re-exported, not copied - a
 * helper is declared once).
 */
import { fail } from "../../_shared/api-response";
import { authorizeInTransaction } from "../../identity-access/application/access-guard";
import { COMMERCE_HELD_SALES_ACTIVITY_CODE } from "../domain/commerce-permissions";
import { isUuid } from "../domain/documents";
import { requireCommerceFeatureForOwnerRoute } from "./commerce-feature-gate";
import type { SupervisorCheck } from "./held-sale-directory";

export {
  idempotencyErrorResponse,
  readValidatedBody,
  requireIdempotencyKey
} from "./register-http";

/** `409 FEATURE_DISABLED` while the tenant's `documents` feature is off, else `null`. */
export function requireDocumentsFeature(
  tx: Bun.SQL,
  tenantId: string
): Promise<Response | null> {
  return requireCommerceFeatureForOwnerRoute(tx, tenantId, "documents");
}

/**
 * `409 FEATURE_DISABLED` unless BOTH the `documents` and the `documentDelivery`
 * features are on (Issue #295, ADR-0034): there is nothing to deliver without
 * the first, and sending is an opt-in on top of it. Documents is checked first
 * so the answer names the more basic missing feature.
 */
export async function requireDocumentDeliveryFeature(
  tx: Bun.SQL,
  tenantId: string
): Promise<Response | null> {
  return (
    (await requireCommerceFeatureForOwnerRoute(tx, tenantId, "documents")) ??
    (await requireCommerceFeatureForOwnerRoute(
      tx,
      tenantId,
      "documentDelivery"
    ))
  );
}

/** The neutral 404 for an unknown, malformed or other-tenant id - one answer for all three (no oracle). */
export function notFoundResponse(what: string): Response {
  return fail(404, "RESOURCE_NOT_FOUND", `${what} not found.`);
}

/** `null` when `id` is a UUID, else the neutral 404 (a non-UUID can never name a row). */
export function requireUuidParam(id: unknown, what: string): Response | null {
  return isUuid(id) ? null : notFoundResponse(what);
}

export const HELD_SALE_APPROVE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_HELD_SALES_ACTIVITY_CODE,
  action: "approve"
} as const;

/**
 * The lazy supervisor check for held sales: asks the access chokepoint whether
 * the caller also holds `commerce.held_sales.approve`, and only when the
 * directory actually needs the answer (another cashier's cart).
 */
export function heldSaleSupervisorCheck(context: {
  tx: Bun.SQL;
  tenantId: string;
  tokenHash: string;
  now: Date;
}): SupervisorCheck {
  return async () =>
    (
      await authorizeInTransaction(
        context.tx,
        context.tenantId,
        context.tokenHash,
        context.now,
        HELD_SALE_APPROVE_GUARD
      )
    ).allowed;
}
