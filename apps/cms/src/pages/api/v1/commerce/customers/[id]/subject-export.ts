/**
 * `POST /api/v1/commerce/customers/{id}/subject-export` (Issue #529,
 * ADR-0055 D3/D4) - an administrator produces a shopper's data-subject export
 * bundle on their behalf (the shopper asked by another channel).
 *
 * Needs `commerce.customer_subject_requests.export` (high-risk) and an
 * `Idempotency-Key`. Answers `200 { bundle, requestId }`, `Cache-Control:
 * no-store`. The bundle is built and returned, never stored; the disclosure is
 * audited at `critical` (who, when, row count, never content). A repeated key is
 * `409 IDEMPOTENCY_REPLAYED`: the bundle is not kept to replay, use a new key to
 * produce another. An unknown customer (or another tenant's) is `404`.
 */
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { adminExport } from "../../../../../../modules/commerce/application/customer-subject-flow";
import {
  NO_STORE_HEADERS,
  requireSubjectIdempotencyKey
} from "../../../../../../modules/commerce/application/customer-subject-http";
import { COMMERCE_CUSTOMER_SUBJECT_REQUESTS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/customer-subject-permissions";
import { isUuid } from "../../../../../../modules/commerce/domain/register";

const EXPORT_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_CUSTOMER_SUBJECT_REQUESTS_ACTIVITY_CODE,
  action: "export"
} as const;

export const POST = defineTenantRoute<{ idempotencyKey: string }>({
  workClass: "interactive",
  prepare: ({ request }) => {
    const key = requireSubjectIdempotencyKey(request);
    if ("response" in key) return key.response;
    return { idempotencyKey: key.key };
  },
  authorize: EXPORT_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const customerId = params.id;
    if (!isUuid(customerId)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Customer not found.");
    }

    const outcome = await adminExport(
      tx,
      tenantId,
      auth.context.tenantUserId,
      customerId,
      prepared.idempotencyKey,
      { correlationId: locals.correlationId }
    );

    switch (outcome.kind) {
      case "not_found":
        return fail(404, "RESOURCE_NOT_FOUND", "Customer not found.");
      case "key_replayed":
        return fail(
          409,
          "IDEMPOTENCY_REPLAYED",
          "This export was already produced. A bundle is not stored; use a new Idempotency-Key to produce another."
        );
      case "ok":
        return ok(
          { requestId: outcome.request.id, bundle: outcome.bundle },
          {},
          { ...NO_STORE_HEADERS }
        );
    }
  }
});
