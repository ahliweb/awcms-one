import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  decodeKeysetCursor,
  type KeysetCursor
} from "../../../../../../modules/_shared/keyset-pagination";
import {
  fetchWhatsappMessageEntries,
  type WhatsappMessageStatus
} from "../../../../../../modules/commerce/application/whatsapp-message-directory";
import { COMMERCE_WHATSAPP_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";

/**
 * `GET /api/v1/commerce/whatsapp/messages` (Issue #108, contract
 * #106/ADR-0017 D5) — read-only owner diagnostics over the WhatsApp outbox,
 * `commerce.whatsapp.read`. Mirrors `GET /api/v1/email/messages` /
 * `GET /api/v1/commerce/affiliates`'s keyset-pagination shape. Never
 * returns `to_phone` — only `to_phone_masked`.
 */
const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_WHATSAPP_ACTIVITY_CODE,
  action: "read"
} as const;

const VALID_STATUS_FILTERS = new Set<WhatsappMessageStatus>([
  "queued",
  "sending",
  "sent",
  "failed"
]);

type PreparedQuery = {
  status?: WhatsappMessageStatus;
  cursor?: KeysetCursor;
};

export const GET = defineTenantRoute({
  workClass: "interactive",
  prepare: ({ url }): PreparedQuery | Response => {
    const statusParam = url.searchParams.get("status");

    if (
      statusParam !== null &&
      !VALID_STATUS_FILTERS.has(statusParam as WhatsappMessageStatus)
    ) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "status must be one of queued, sending, sent, failed."
      );
    }

    const cursorParam = url.searchParams.get("cursor");
    const cursor = cursorParam ? decodeKeysetCursor(cursorParam) : null;

    if (cursorParam && !cursor) {
      return fail(400, "VALIDATION_ERROR", "cursor is malformed.");
    }

    return {
      status: (statusParam as WhatsappMessageStatus | null) ?? undefined,
      cursor: cursor ?? undefined
    };
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) => {
    const { messages, nextCursor } = await fetchWhatsappMessageEntries(
      tx,
      tenantId,
      prepared.status,
      prepared.cursor
    );

    return ok({ messages, nextCursor });
  }
});
