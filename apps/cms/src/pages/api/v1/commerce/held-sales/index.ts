/**
 * `GET|POST /api/v1/commerce/held-sales` — parked POS carts (Issue #286, epic
 * #281, ADR-0029). `GET` (`commerce.held_sales.read`) lists the caller's OWN
 * parked carts, newest first, filterable by `status`; `scope=all` lists every
 * cashier's and additionally needs the supervisor key
 * `commerce.held_sales.approve`. `POST` (`commerce.held_sales.create`, requires
 * `Idempotency-Key`) parks a cart - lines only, never a price, never a stock
 * reservation. Both are gated on the tenant's `documents` feature.
 */
import { created, fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  decodeKeysetCursor,
  type KeysetCursor
} from "../../../../../modules/_shared/keyset-pagination";
import { authorizeInTransaction } from "../../../../../modules/identity-access/application/access-guard";
import {
  holdSale,
  listHeldSales
} from "../../../../../modules/commerce/application/held-sale-directory";
import {
  HELD_SALE_APPROVE_GUARD,
  idempotencyErrorResponse,
  readValidatedBody,
  requireDocumentsFeature,
  requireIdempotencyKey
} from "../../../../../modules/commerce/application/documents-http";
import {
  HELD_SALE_STATUSES,
  validateHoldSaleInput,
  type HeldSaleStatus,
  type HoldSaleInput
} from "../../../../../modules/commerce/domain/documents";
import { COMMERCE_HELD_SALES_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_HELD_SALES_ACTIVITY_CODE,
  action: "read"
} as const;

const CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_HELD_SALES_ACTIVITY_CODE,
  action: "create"
} as const;

type PreparedList = {
  cursor: KeysetCursor | null;
  status: HeldSaleStatus | null;
  all: boolean;
};

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
    const status = url.searchParams.get("status");
    if (status && !(HELD_SALE_STATUSES as readonly string[]).includes(status)) {
      return fail(
        400,
        "VALIDATION_ERROR",
        `status must be one of: ${HELD_SALE_STATUSES.join(", ")}.`
      );
    }
    const scope = url.searchParams.get("scope");
    if (scope !== null && scope !== "own" && scope !== "all") {
      return fail(400, "VALIDATION_ERROR", "scope must be own or all.");
    }
    return {
      cursor,
      status: (status as HeldSaleStatus | null) ?? null,
      all: scope === "all"
    };
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, tokenHash, now }) => {
    const gate = await requireDocumentsFeature(tx, tenantId);
    if (gate) return gate;
    if (prepared.all) {
      // Another cashier's carts are a supervisor's: a second, named key.
      const supervisor = await authorizeInTransaction(
        tx,
        tenantId,
        tokenHash,
        now,
        HELD_SALE_APPROVE_GUARD
      );
      if (!supervisor.allowed) return supervisor.denied;
    }
    return ok(
      await listHeldSales(
        tx,
        tenantId,
        { actorTenantUserId: auth.context.tenantUserId, all: prepared.all },
        prepared.cursor,
        prepared.status,
        now
      )
    );
  }
});

export const POST = defineTenantRoute<HoldSaleInput>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, (body) =>
      validateHoldSaleInput(body, key.key)
    );
  },
  authorize: CREATE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, now, locals }) => {
    const gate = await requireDocumentsFeature(tx, tenantId);
    if (gate) return gate;
    try {
      const outcome = await holdSale(
        tx,
        tenantId,
        auth.context.tenantUserId,
        prepared,
        now,
        locals.correlationId
      );
      switch (outcome.kind) {
        case "register_not_found":
          return fail(404, "RESOURCE_NOT_FOUND", "Register not found.");
        case "limit_reached":
          return fail(
            409,
            "HELD_SALE_LIMIT",
            "Too many parked sales; resume or discard some first.",
            {},
            { limit: outcome.limit }
          );
        default:
          return created(outcome.heldSale);
      }
    } catch (error) {
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      throw error;
    }
  }
});
