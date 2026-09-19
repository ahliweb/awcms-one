import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  fetchOrderDetailForAdmin,
  toAdminOrderRecord
} from "../../../../../modules/commerce/application/order-directory";
import {
  fetchLatestGatewaySessionForOrder,
  listPaymentEventsForOrder
} from "../../../../../modules/commerce/application/payment-gateway-directory";
import { mediaLibraryPortAdapter } from "../../../../../modules/media-library/application/media-library-port-adapter";
import { COMMERCE_ORDERS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

/** `GET /api/v1/commerce/orders/{id}` — admin detail (Issue #29). */
const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_ORDERS_ACTIVITY_CODE,
  action: "read"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const orderId = params.id;
    if (!orderId) return fail(400, "VALIDATION_ERROR", "id is required.");

    const detail = await fetchOrderDetailForAdmin(
      tx,
      tenantId,
      mediaLibraryPortAdapter,
      orderId
    );
    if (!detail) return fail(404, "RESOURCE_NOT_FOUND", "Order not found.");

    const record = await toAdminOrderRecord(tx, tenantId, detail);

    // Issue #113 — read-only gateway session/payment-events panel on the
    // admin order detail screen. `null` when the order was never a gateway
    // order (`payment_method !== "gateway"`) — the screen hides the panel
    // in that case rather than showing an empty one.
    const gatewaySession = await fetchLatestGatewaySessionForOrder(
      tx,
      tenantId,
      orderId
    );
    const paymentEvents = await listPaymentEventsForOrder(
      tx,
      tenantId,
      orderId
    );

    return ok({
      ...record,
      gateway: { session: gatewaySession, events: paymentEvents }
    });
  }
});
