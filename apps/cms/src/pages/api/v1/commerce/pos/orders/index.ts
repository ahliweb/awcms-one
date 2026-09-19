/**
 * `GET|POST /api/v1/commerce/pos/orders` — POS history + counter sale
 * (Issue #116, epic #33 C7, contract #106 D6, ADR-0017). Both handlers are
 * gated by the tenant's `pos` feature flag (#118) right after their ABAC
 * guard: a tenant that turned POS off answers `409 FEATURE_DISABLED` on
 * both, exactly like the inbox/campaign owner routes.
 */
import {
  created,
  fail,
  jsonResponse,
  ok
} from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { IdempotencyRaceLostError } from "../../../../../../modules/_shared/idempotency";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../lib/security/request-body-limit";
import {
  decodeKeysetCursor,
  type KeysetCursor
} from "../../../../../../modules/_shared/keyset-pagination";
import { mediaLibraryPortAdapter } from "../../../../../../modules/media-library/application/media-library-port-adapter";
import { requireCommerceFeatureForOwnerRoute } from "../../../../../../modules/commerce/application/commerce-feature-gate";
import {
  createPosOrder,
  listPosOrders,
  PosCartChangedError
} from "../../../../../../modules/commerce/application/pos-directory";
import { IdempotencyPayloadMismatchError } from "../../../../../../modules/commerce/application/order-directory";
import {
  InsufficientTenderError,
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PreparedList = {
  cursor: KeysetCursor | null;
  dateFrom?: Date;
  dateTo?: Date;
  cashierTenantUserId?: string;
};

function parseDateParam(
  url: URL,
  name: string,
  endOfDay: boolean
): Date | Response | undefined {
  const raw = url.searchParams.get(name);
  if (!raw) return undefined;
  // A bare `YYYY-MM-DD` (the admin screen's `<input type="date">`) is read
  // as a whole day — inclusive end for `dateTo` — rather than the midnight
  // instant `new Date()` would give it.
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const parsed = new Date(
    dayOnly ? `${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z` : raw
  );
  if (Number.isNaN(parsed.getTime())) {
    return fail(400, "VALIDATION_ERROR", `${name} is not a valid date.`);
  }
  return parsed;
}

/**
 * `GET /api/v1/commerce/pos/orders` — POS history (Issue #116). The admin
 * order-list summary shape plus `paymentMethod`/`cashierTenantUserId`,
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

    const dateFrom = parseDateParam(url, "dateFrom", false);
    if (dateFrom instanceof Response) return dateFrom;
    const dateTo = parseDateParam(url, "dateTo", true);
    if (dateTo instanceof Response) return dateTo;

    const cashierParam = url.searchParams.get("cashier");
    if (cashierParam && !UUID_PATTERN.test(cashierParam)) {
      return fail(400, "VALIDATION_ERROR", "cashier must be a UUID.");
    }

    return {
      cursor,
      dateFrom,
      dateTo,
      cashierTenantUserId: cashierParam ?? undefined
    };
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) => {
    const gate = await requireCommerceFeatureForOwnerRoute(tx, tenantId, "pos");
    if (gate) return gate;

    return ok(
      await listPosOrders(tx, tenantId, prepared.cursor, {
        dateFrom: prepared.dateFrom,
        dateTo: prepared.dateTo,
        cashierTenantUserId: prepared.cashierTenantUserId
      })
    );
  }
});

/**
 * `POST /api/v1/commerce/pos/orders` — a counter sale, `paid` immediately
 * (Issue #116). Requires `Idempotency-Key`. Gated on `commerce.pos.create`
 * — the only order-creation path in this module that needs a permission at
 * all (every other one is anonymous or provider/system-driven).
 */
export const POST = defineTenantRoute<CreatePosOrderInput>({
  workClass: "interactive",
  prepare: async ({ request }): Promise<CreatePosOrderInput | Response> => {
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      return fail(
        400,
        "IDEMPOTENCY_REQUIRED",
        "Idempotency-Key header is required."
      );
    }

    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const result = validateCreatePosOrderInput(
      bodyRead.value ?? {},
      idempotencyKey
    );
    if (!result.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Request body failed validation.",
        {},
        result.errors
      );
    }

    return result.value;
  },
  authorize: CREATE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    const gate = await requireCommerceFeatureForOwnerRoute(tx, tenantId, "pos");
    if (gate) return gate;

    try {
      const outcome = await createPosOrder(
        tx,
        tenantId,
        auth.context.tenantUserId,
        mediaLibraryPortAdapter,
        prepared,
        new Date(),
        locals.correlationId
      );
      if (outcome.kind === "invalid_phone") {
        return fail(
          400,
          "VALIDATION_ERROR",
          "customer.phone is not a valid Indonesian phone number.",
          {},
          [
            {
              field: "customer.phone",
              message: "customer.phone is not a valid Indonesian phone number."
            }
          ]
        );
      }
      // Both `"created"` and `"replayed"` return the SAME 201 body (a
      // replay is a client network retry, not a second order), matching
      // `createOrderFromCart`'s own idempotent-replay contract.
      return created(outcome.order);
    } catch (error) {
      if (error instanceof IdempotencyRaceLostError) {
        if (error.replay) {
          return jsonResponse(error.replay.responseBody, {
            status: error.replay.responseStatus
          });
        }
        return fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used with a different request."
        );
      }
      if (error instanceof IdempotencyPayloadMismatchError) {
        return fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used with a different request."
        );
      }
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
          "payment.amountTendered is less than the order total.",
          {},
          { shortfall: error.shortfall }
        );
      }
      throw error;
    }
  }
});
