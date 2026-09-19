import {
  fail,
  jsonResponse
} from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../lib/security/request-body-limit";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../../modules/_shared/idempotency";
import { postStoreReply } from "../../../../../../modules/commerce/application/conversation-directory";
import { validateConversationMessageInput } from "../../../../../../modules/commerce/domain/conversation-validation";
import { COMMERCE_CONVERSATIONS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";

const IDEMPOTENCY_SCOPE = "commerce_conversation_reply";

const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_CONVERSATIONS_ACTIVITY_CODE,
  action: "update"
} as const;

type Prepared = { idempotencyKey: string; body: string };

/**
 * `POST /api/v1/commerce/conversations/{id}/messages` — the staff reply
 * (Issue #111, contract #106 D8). High-risk mutation (it enqueues an
 * e-mail): requires `Idempotency-Key`, per `awcms-idempotency` — the hash is
 * bound to `conversationId` + the literal `action` string per that skill's
 * own "recurring 4x" rule, not the raw body alone.
 */
export const POST = defineTenantRoute<Prepared>({
  workClass: "interactive",
  prepare: async ({ request }): Promise<Prepared | Response> => {
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey) {
      return fail(
        400,
        "IDEMPOTENCY_REQUIRED",
        "Idempotency-Key header is required."
      );
    }

    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateConversationMessageInput(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Invalid message.",
        {},
        validation.errors
      );
    }

    return { idempotencyKey, body: validation.value.body };
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const conversationId = params.id;
    if (!conversationId) {
      return fail(400, "VALIDATION_ERROR", "id is required.");
    }

    const requestHash = computeRequestHash({
      conversationId,
      body: prepared.body,
      action: "reply"
    });

    const existing = await findIdempotencyRecord(
      tx,
      tenantId,
      IDEMPOTENCY_SCOPE,
      prepared.idempotencyKey
    );
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used with a different request."
        );
      }
      return jsonResponse(existing.responseBody, {
        status: existing.responseStatus
      });
    }

    const outcome = await postStoreReply(
      tx,
      tenantId,
      auth.context.tenantUserId,
      conversationId,
      prepared.body,
      locals.correlationId
    );
    if (outcome.kind === "not_found") {
      return fail(404, "RESOURCE_NOT_FOUND", "Conversation not found.");
    }

    const successResponse = jsonResponse(
      { success: true, data: { message: outcome.message }, meta: {} },
      { status: 201 }
    );
    const successBody = await successResponse.clone().json();
    await saveIdempotencyRecord(
      tx,
      tenantId,
      IDEMPOTENCY_SCOPE,
      prepared.idempotencyKey,
      requestHash,
      201,
      successBody
    );
    return successResponse;
  }
});
