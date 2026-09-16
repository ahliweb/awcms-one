import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  decodeKeysetCursor,
  type KeysetCursor
} from "../../../../../modules/_shared/keyset-pagination";
import {
  listReviewsForAdmin,
  type ReviewStatus
} from "../../../../../modules/commerce/application/review-directory";
import { COMMERCE_REVIEWS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

/** `GET /api/v1/commerce/reviews` — admin moderation list (Issue #29). */
const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_REVIEWS_ACTIVITY_CODE,
  action: "read"
} as const;

const REVIEW_STATUSES: readonly ReviewStatus[] = [
  "pending",
  "published",
  "rejected"
];

type Prepared = { cursor: KeysetCursor | null; status?: ReviewStatus };

export const GET = defineTenantRoute({
  workClass: "interactive",
  prepare: ({ url }): Prepared | Response => {
    const cursorParam = url.searchParams.get("cursor");
    let cursor: KeysetCursor | null = null;
    if (cursorParam) {
      const decoded = decodeKeysetCursor(cursorParam);
      if (!decoded)
        return fail(400, "VALIDATION_ERROR", "cursor is malformed.");
      cursor = decoded;
    }

    const statusParam = url.searchParams.get("status");
    if (statusParam && !REVIEW_STATUSES.includes(statusParam as ReviewStatus)) {
      return fail(
        400,
        "VALIDATION_ERROR",
        `status must be one of: ${REVIEW_STATUSES.join(", ")}.`
      );
    }

    return { cursor, status: statusParam as ReviewStatus | undefined };
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) =>
    ok(
      await listReviewsForAdmin(tx, tenantId, prepared.cursor, prepared.status)
    )
});
