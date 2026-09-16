import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  decodeKeysetCursor,
  type KeysetCursor
} from "../../../../../modules/_shared/keyset-pagination";
import { listOrdersForAdmin } from "../../../../../modules/commerce/application/order-directory";
import { COMMERCE_ORDERS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";
import {
  ORDER_STATUSES,
  type OrderStatus
} from "../../../../../modules/commerce/domain/order-status";

/** `GET /api/v1/commerce/orders` — admin list, `status`/`paymentStatus` filters (Issue #29). */
const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_ORDERS_ACTIVITY_CODE,
  action: "read"
} as const;

type PreparedList = {
  cursor: KeysetCursor | null;
  status?: OrderStatus;
  paymentStatus?: string;
};

export const GET = defineTenantRoute({
  workClass: "interactive",
  prepare: ({ url }): PreparedList | Response => {
    const cursorParam = url.searchParams.get("cursor");
    let cursor: KeysetCursor | null = null;
    if (cursorParam) {
      const decoded = decodeKeysetCursor(cursorParam);
      if (!decoded)
        return fail(400, "VALIDATION_ERROR", "cursor is malformed.");
      cursor = decoded;
    }

    const statusParam = url.searchParams.get("status");
    if (
      statusParam &&
      !(ORDER_STATUSES as readonly string[]).includes(statusParam)
    ) {
      return fail(
        400,
        "VALIDATION_ERROR",
        `status must be one of: ${ORDER_STATUSES.join(", ")}.`
      );
    }

    const paymentStatusParam =
      url.searchParams.get("paymentStatus") ?? undefined;

    return {
      cursor,
      status: statusParam as OrderStatus | undefined,
      paymentStatus: paymentStatusParam
    };
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) =>
    ok(
      await listOrdersForAdmin(tx, tenantId, prepared.cursor, {
        status: prepared.status,
        paymentStatus: prepared.paymentStatus
      })
    )
});
