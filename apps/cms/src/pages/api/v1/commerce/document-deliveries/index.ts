/**
 * `GET|POST /api/v1/commerce/document-deliveries` - transactional delivery of a
 * commercial document through the existing e-mail and WhatsApp outboxes
 * (Issue #295, ADR-0034). Gated on the tenant's `documents` AND
 * `documentDelivery` features (the latter defaults OFF).
 *
 * `GET` (`commerce.document_deliveries.read`) is the delivery history of ONE
 * source (`targetType` + `targetId`), newest first, each entry carrying the
 * outbox's live status, provider message id, retry count and last error. An
 * unknown id and another tenant's id are the same empty list.
 *
 * `POST` (`commerce.document_deliveries.create`, requires `Idempotency-Key`)
 * REQUESTS one delivery: the message is rendered from the immutable source and
 * enqueued into the channel's existing outbox in this transaction; a dispatcher
 * calls the provider later. A replay of the same key returns the stored result
 * and enqueues nothing; a NEW key is an explicit re-send. A recipient other
 * than the source's own customer needs the separate
 * `commerce.document_delivery_overrides.create` key.
 */
import { created, fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { authorizeInTransaction } from "../../../../../modules/identity-access/application/access-guard";
import {
  listDocumentDeliveries,
  requestDocumentDelivery
} from "../../../../../modules/commerce/application/document-delivery-directory";
import {
  idempotencyErrorResponse,
  notFoundResponse,
  readValidatedBody,
  requireDocumentDeliveryFeature,
  requireIdempotencyKey
} from "../../../../../modules/commerce/application/documents-http";
import {
  COMMERCE_DOCUMENT_DELIVERIES_ACTIVITY_CODE,
  COMMERCE_DOCUMENT_DELIVERY_OVERRIDES_ACTIVITY_CODE
} from "../../../../../modules/commerce/domain/commerce-permissions";
import {
  DELIVERY_RATE_LIMIT_WINDOW_MINUTES,
  DELIVERY_TARGET_TYPES,
  validateRequestDeliveryInput,
  type DeliveryTargetType,
  type RequestDeliveryInput
} from "../../../../../modules/commerce/domain/document-delivery";
import { isUuid } from "../../../../../modules/commerce/domain/documents";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_DOCUMENT_DELIVERIES_ACTIVITY_CODE,
  action: "read"
} as const;

const CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_DOCUMENT_DELIVERIES_ACTIVITY_CODE,
  action: "create"
} as const;

const OVERRIDE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_DOCUMENT_DELIVERY_OVERRIDES_ACTIVITY_CODE,
  action: "create"
} as const;

type PreparedHistory = { targetType: DeliveryTargetType; targetId: string };

export const GET = defineTenantRoute<PreparedHistory>({
  workClass: "interactive",
  prepare: ({ url }): PreparedHistory | Response => {
    const targetType = url.searchParams.get("targetType");
    if (
      !(DELIVERY_TARGET_TYPES as readonly string[]).includes(targetType ?? "")
    ) {
      return fail(
        400,
        "VALIDATION_ERROR",
        `targetType must be one of: ${DELIVERY_TARGET_TYPES.join(", ")}.`
      );
    }
    const targetId = url.searchParams.get("targetId");
    if (!isUuid(targetId)) {
      return fail(400, "VALIDATION_ERROR", "targetId must be a UUID.");
    }
    return { targetType: targetType as DeliveryTargetType, targetId };
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) => {
    const gate = await requireDocumentDeliveryFeature(tx, tenantId);
    if (gate) return gate;
    return ok({
      items: await listDocumentDeliveries(tx, tenantId, prepared)
    });
  }
});

export const POST = defineTenantRoute<RequestDeliveryInput>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, (body) =>
      validateRequestDeliveryInput(body, key.key)
    );
  },
  authorize: CREATE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, tokenHash, now, locals }) => {
    const gate = await requireDocumentDeliveryFeature(tx, tenantId);
    if (gate) return gate;

    // The override key is consulted only when the caller named a recipient.
    const overrideAllowed =
      prepared.recipientOverride === null
        ? false
        : (
            await authorizeInTransaction(
              tx,
              tenantId,
              tokenHash,
              now,
              OVERRIDE_GUARD
            )
          ).allowed;

    try {
      const outcome = await requestDocumentDelivery(
        tx,
        {
          tenantId,
          actorTenantUserId: auth.context.tenantUserId,
          overrideAllowed,
          now,
          correlationId: locals.correlationId
        },
        prepared
      );
      switch (outcome.kind) {
        case "not_found":
          return notFoundResponse("Document");
        case "denied":
          switch (outcome.reason) {
            case "OVERRIDE_FORBIDDEN":
              return fail(
                403,
                "ACCESS_DENIED",
                "Sending to a recipient other than the customer on file needs an additional permission."
              );
            case "DELIVERY_RATE_LIMITED":
              return fail(
                429,
                "DELIVERY_RATE_LIMITED",
                "Too many deliveries were requested for this document. Try again later.",
                {},
                undefined,
                {
                  "retry-after": String(DELIVERY_RATE_LIMIT_WINDOW_MINUTES * 60)
                }
              );
            case "CHANNEL_UNAVAILABLE":
              return fail(
                409,
                "CHANNEL_UNAVAILABLE",
                "This delivery channel is not enabled on this deployment."
              );
            case "RECIPIENT_UNAVAILABLE":
              return fail(
                409,
                "RECIPIENT_UNAVAILABLE",
                "The document has no usable recipient for this channel."
              );
            case "SOURCE_NOT_DELIVERABLE":
              return fail(
                409,
                "SOURCE_NOT_DELIVERABLE",
                "A cancelled quotation cannot be sent."
              );
            default:
              return fail(
                409,
                "DOCUMENT_INTEGRITY_FAILURE",
                "The stored document no longer matches its content hash and cannot be sent."
              );
          }
        case "not_enqueued":
          return fail(
            409,
            outcome.delivery.failureReason ?? "NOT_ENQUEUED",
            outcome.delivery.failureReason === "RECIPIENT_SUPPRESSED"
              ? "The recipient is on the suppression list; nothing was sent."
              : "No message template is available; nothing was sent.",
            {},
            outcome.delivery
          );
        default:
          return created(outcome.delivery);
      }
    } catch (error) {
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      throw error;
    }
  }
});
