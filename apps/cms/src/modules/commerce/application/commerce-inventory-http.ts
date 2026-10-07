/**
 * HTTP mapping of the two commerce-inventory errors (Issue #282, ADR-0038),
 * shared by every route whose handler can reach a stock write.
 *
 * Both are raised only AFTER the unit of work that raised them was rolled back
 * (`withInventorySavepoint`) or before it wrote anything, so a route may return
 * the response and let `defineTenantRoute` commit: nothing is left to commit.
 */
import { fail } from "../../_shared/api-response";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../lib/security/request-body-limit";
import { COMMERCE_INVENTORY_ACTIVITY_CODE } from "../domain/commerce-permissions";
import {
  RECONCILIATION_MAX_LIMIT,
  clampLimit
} from "./commerce-inventory-reconciliation";
import {
  STOCK_MANAGED_BY_INVENTORY_CODE,
  describeRefusal
} from "../domain/commerce-inventory";
import {
  InventoryLedgerRefusedError,
  StockManagedByInventoryError
} from "./commerce-inventory";

export const INVENTORY_UNAVAILABLE_CODE = "INVENTORY_UNAVAILABLE";

/** `409 STOCK_MANAGED_BY_INVENTORY` / `409 INVENTORY_UNAVAILABLE`, or `null` for any other error. */
export function inventoryErrorResponse(
  error: unknown,
  headers?: Record<string, string>
): Response | null {
  if (error instanceof StockManagedByInventoryError) {
    return fail(
      409,
      STOCK_MANAGED_BY_INVENTORY_CODE,
      error.message,
      {},
      undefined,
      headers
    );
  }

  if (error instanceof InventoryLedgerRefusedError) {
    // Only the kind and a sentence: never the balance, the location or an item id
    // on a surface an anonymous shopper can reach.
    return fail(
      409,
      INVENTORY_UNAVAILABLE_CODE,
      describeRefusal(error.kind),
      {},
      undefined,
      headers
    );
  }

  return null;
}

export const INVENTORY_READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_INVENTORY_ACTIVITY_CODE,
  action: "read"
} as const;

export const INVENTORY_CONFIGURE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_INVENTORY_ACTIVITY_CODE,
  action: "configure"
} as const;

export type PageRequest = { cursor: string | null; limit: number };

function parsePage(cursor: unknown, limit: unknown): PageRequest | Response {
  if (cursor !== null && cursor !== undefined && typeof cursor !== "string") {
    return fail(400, "VALIDATION_ERROR", "cursor must be a string.");
  }
  if (typeof cursor === "string" && cursor.length > 300) {
    return fail(400, "VALIDATION_ERROR", "cursor is too long.");
  }

  let parsedLimit: number | null = null;
  if (limit !== null && limit !== undefined) {
    const value = typeof limit === "string" ? Number(limit) : limit;
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > RECONCILIATION_MAX_LIMIT
    ) {
      return fail(
        400,
        "VALIDATION_ERROR",
        `limit must be an integer from 1 to ${RECONCILIATION_MAX_LIMIT}.`
      );
    }
    parsedLimit = value;
  }

  return {
    cursor: (cursor as string | null | undefined) ?? null,
    limit: clampLimit(parsedLimit)
  };
}

/** `?cursor=&limit=` of the reconciliation read. */
export function parsePageQuery(url: URL): PageRequest | Response {
  return parsePage(
    url.searchParams.get("cursor"),
    url.searchParams.get("limit")
  );
}

/** The optional `{ cursor?, limit? }` JSON body of the resync. An empty body is the first page. */
export async function parsePageBody(
  request: Request
): Promise<PageRequest | Response> {
  const read = await readJsonBody(request);
  if (read.tooLarge) return bodyTooLargeResponse(read.limitBytes);
  if (read.malformed) {
    return fail(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
  }
  if (read.value === null) return parsePage(null, null);

  const body = read.value as Record<string, unknown>;
  if (
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => key !== "cursor" && key !== "limit")
  ) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Body may contain only cursor and limit. A stock count is recomputed from the ledger and can never be supplied."
    );
  }

  return parsePage(body.cursor, body.limit);
}
