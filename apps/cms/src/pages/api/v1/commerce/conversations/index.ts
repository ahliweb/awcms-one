import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  decodeKeysetCursor,
  type KeysetCursor
} from "../../../../../modules/_shared/keyset-pagination";
import {
  listConversationsForAdmin,
  type AdminConversationFilter
} from "../../../../../modules/commerce/application/conversation-directory";
import { COMMERCE_CONVERSATIONS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

/** `GET /api/v1/commerce/conversations?status=&unread=&cursor=` — staff list, keyset (Issue #111, contract #106 D8). */
const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_CONVERSATIONS_ACTIVITY_CODE,
  action: "read"
} as const;

type Prepared = {
  cursor: KeysetCursor | null;
  filter: AdminConversationFilter;
};

export const GET = defineTenantRoute<Prepared>({
  workClass: "interactive",
  prepare: ({ url }): Prepared | Response => {
    const cursorParam = url.searchParams.get("cursor");
    let cursor: KeysetCursor | null = null;
    if (cursorParam) {
      cursor = decodeKeysetCursor(cursorParam);
      if (!cursor) return fail(400, "VALIDATION_ERROR", "cursor is malformed.");
    }

    const filter: AdminConversationFilter = {};
    const statusParam = url.searchParams.get("status");
    if (statusParam !== null) {
      if (statusParam !== "open" && statusParam !== "closed") {
        return fail(
          400,
          "VALIDATION_ERROR",
          "status must be one of: open, closed."
        );
      }
      filter.status = statusParam;
    }
    const unreadParam = url.searchParams.get("unread");
    if (unreadParam !== null) {
      if (unreadParam !== "true" && unreadParam !== "false") {
        return fail(
          400,
          "VALIDATION_ERROR",
          "unread must be one of: true, false."
        );
      }
      filter.unreadForStore = unreadParam === "true";
    }

    return { cursor, filter };
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) =>
    ok(
      await listConversationsForAdmin(
        tx,
        tenantId,
        prepared.filter,
        prepared.cursor
      )
    )
});
