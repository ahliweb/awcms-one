import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../lib/security/request-body-limit";
import {
  fetchConversationForAdmin,
  setConversationStatus
} from "../../../../../../modules/commerce/application/conversation-directory";
import { validateConversationStatusInput } from "../../../../../../modules/commerce/domain/conversation-validation";
import { COMMERCE_CONVERSATIONS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";
import { requireCommerceFeatureForOwnerRoute } from "../../../../../../modules/commerce/application/commerce-feature-gate";

/** `GET /api/v1/commerce/conversations/{id}` — the thread + its messages; marks it read for the STORE (Issue #111). */
const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_CONVERSATIONS_ACTIVITY_CODE,
  action: "read"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const gate = await requireCommerceFeatureForOwnerRoute(
      tx,
      tenantId,
      "inbox"
    );
    if (gate) return gate;

    const conversationId = params.id;
    if (!conversationId) {
      return fail(400, "VALIDATION_ERROR", "id is required.");
    }

    const thread = await fetchConversationForAdmin(
      tx,
      tenantId,
      conversationId
    );
    if (!thread) {
      return fail(404, "RESOURCE_NOT_FOUND", "Conversation not found.");
    }
    return ok(thread);
  }
});

/** `PATCH /api/v1/commerce/conversations/{id}` — explicit close/reopen by staff. */
const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_CONVERSATIONS_ACTIVITY_CODE,
  action: "update"
} as const;

type Prepared = { status: "open" | "closed" };

export const PATCH = defineTenantRoute<Prepared>({
  workClass: "interactive",
  prepare: async ({ request }): Promise<Prepared | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateConversationStatusInput(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Invalid status.",
        {},
        validation.errors
      );
    }
    return validation.value;
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const gate = await requireCommerceFeatureForOwnerRoute(
      tx,
      tenantId,
      "inbox"
    );
    if (gate) return gate;

    const conversationId = params.id;
    if (!conversationId) {
      return fail(400, "VALIDATION_ERROR", "id is required.");
    }

    const outcome = await setConversationStatus(
      tx,
      tenantId,
      auth.context.tenantUserId,
      conversationId,
      prepared.status,
      locals.correlationId
    );
    if (outcome.kind === "not_found") {
      return fail(404, "RESOURCE_NOT_FOUND", "Conversation not found.");
    }
    return ok({ conversation: outcome.conversation });
  }
});
