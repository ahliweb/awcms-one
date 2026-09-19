import {
  created,
  fail,
  ok
} from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../lib/security/request-body-limit";
import {
  decodeKeysetCursor,
  type KeysetCursor
} from "../../../../../../modules/_shared/keyset-pagination";
import { mediaLibraryPortAdapter } from "../../../../../../modules/media-library/application/media-library-port-adapter";
import {
  createPosOrder,
  listPosOrders,
  PosCartChangedError
} from "../../../../../../modules/commerce/application/pos-directory";
import { InsufficientTenderError } from "../../../../../../modules/commerce/domain/pos-order-validation";
import {
  validateCreatePosOrderInput,
  type CreatePosOrderInput
} from "../../../../../../modules/commerce/domain/pos-order-validation";
import {
  COMMERCE_ORDERS_ACTIVITY_CODE,
  COMMERCE_POS_ACTIVITY_CODE
} from "../../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_ORDERS_ACTIVITY_CODE,
  action: "read"
} as const;

const CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_POS_ACTIVITY_CODE,
  action: "create"
} as const;

type PreparedList = {
  cursor: KeysetCursor | null;
  dateFrom?: Date;
  dateTo?: Date;
  cashierTenantUserId?: string;
};

/**
 * `GET /api/v1/commerce/pos/orders` — POS history (Issue #116). Reuses the
 * same admin order-list summary shape `GET /api/v1/commerce/orders` returns,
 * filtered `channel = 'pos'`; optional `dateFrom`/`dateTo`/`cashier` query
 * filters. Gated on `commerce.orders.read` (contract's own note: a POS
 * order is still an order; see `commerce-permissions.ts`'s header).
 */
export const GET = defineTenantRoute<PreparedList>({
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

    let dateFrom: Date | undefined;
    const dateFromParam = url.searchParams.get("dateFrom");
    if (dateFromParam) {
      const parsed = new Date(dateFromParam);
      if (Number.isNaN(parsed.getTime())) {
        return fail(400, "VALIDATION_ERROR", "dateFrom is not a valid date.");
      }
      dateFrom = parsed;
    }

    let dateTo: Date | undefined;
    const dateToParam = url.searchParams.get("dateTo");
    if (dateToParam) {
      const parsed = new Date(dateToParam);
      if (Number.isNaN(parsed.getTime())) {
        return fail(400, "VALIDATION_ERROR", "dateTo is not a valid date.");
      }
      dateTo = parsed;
    }

    const cashierTenantUserId = url.searchParams.get("cashier") ?? undefined;

    return { cursor, dateFrom, dateTo, cashierTenantUserId };
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) =>
    ok(
      await listPosOrders(tx, tenantId, prepared.cursor, {
        dateFrom: prepared.dateFrom,
        dateTo: prepared.dateTo,
        cashierTenantUserId: prepared.cashierTenantUserId
      })
    )
});

type Prepared = { idempotencyKey: string; input: CreatePosOrderInput };

/**
 * `POST /api/v1/commerce/pos/orders` — a counter sale, `paid` immediately
 * (Issue #116). Requires `Idempotency-Key`. Gated on `commerce.pos.create`
 * — the only order-creation path in this module that needs a permission at
 * all (every other one is anonymous or provider/system-driven).
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

    const result = validateCreatePosOrderInput(bodyRead.value ?? {});
    if (!result.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Request body failed validation.",
        {},
        result.errors
      );
    }

    return {
      idempotencyKey,
      input: { ...result.value, idempotencyKey }
    };
  },
  authorize: CREATE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    try {
      const outcome = await createPosOrder(
        tx,
        tenantId,
        auth.context.tenantUserId,
        mediaLibraryPortAdapter,
        prepared.input,
        new Date(),
        locals.correlationId
      );
      return jsonResponseFor(outcome);
    } catch (error) {
      if (error instanceof PosCartChangedError) {
        return fail(
          409,
          "CART_CHANGED",
          "One or more lines changed price/stock; re-quote and resubmit.",
          {},
          { quote: error.quote }
        );
      }
      if (error instanceof InsufficientTenderError) {
        return fail(
          409,
          "INSUFFICIENT_TENDER",
          "payment.amountTendered is less than the order total."
        );
      }
      throw error;
    }
  }
});

function jsonResponseFor(outcome: Awaited<ReturnType<typeof createPosOrder>>) {
  // Both `"created"` and `"replayed"` return the SAME 201 body shape (a
  // replay is a client network retry, not a second order), matching
  // `createOrderFromCart`'s own idempotent-replay contract.
  return created(outcome.order);
}
