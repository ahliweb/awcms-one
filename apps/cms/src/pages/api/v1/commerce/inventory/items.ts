/**
 * `GET /api/v1/commerce/inventory/items?q=&cursor=&limit=` - resolves a SKU or a
 * name to the ledger reference (`itemType`, `itemRef`, `unitCode`) a procurement
 * line must carry to stock a live commerce product or variant (Issue #283,
 * ADR-0038 addendum). `commerce.inventory.read`. Read-only, keyset-paged
 * (default 20, at most 50); a product that has live variants is not a stock unit
 * and is not listed. Works in either stock mode - only the `ledger` mode makes a
 * procurement receipt move the storefront count.
 */
import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { INVENTORY_READ_GUARD } from "../../../../../modules/commerce/application/commerce-inventory-http";
import {
  ITEM_LOOKUP_DEFAULT_LIMIT,
  ITEM_LOOKUP_MAX_LIMIT,
  ITEM_LOOKUP_MAX_QUERY_LENGTH,
  lookupInventoryItems
} from "../../../../../modules/commerce/application/commerce-inventory-items";

type Prepared = { query: string | null; cursor: string | null; limit: number };

export const GET = defineTenantRoute<Prepared>({
  workClass: "interactive",
  prepare: ({ url }) => {
    const q = url.searchParams.get("q")?.trim() ?? "";
    if (q.length > ITEM_LOOKUP_MAX_QUERY_LENGTH) {
      return fail(
        400,
        "VALIDATION_ERROR",
        `q must be at most ${ITEM_LOOKUP_MAX_QUERY_LENGTH} characters.`
      );
    }

    const cursor = url.searchParams.get("cursor");
    if (cursor !== null && cursor.length > 300) {
      return fail(400, "VALIDATION_ERROR", "cursor is too long.");
    }

    let limit = ITEM_LOOKUP_DEFAULT_LIMIT;
    const rawLimit = url.searchParams.get("limit");
    if (rawLimit !== null) {
      const value = Number(rawLimit);
      if (
        rawLimit.trim() === "" ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > ITEM_LOOKUP_MAX_LIMIT
      ) {
        return fail(
          400,
          "VALIDATION_ERROR",
          `limit must be an integer from 1 to ${ITEM_LOOKUP_MAX_LIMIT}.`
        );
      }
      limit = value;
    }

    return { query: q === "" ? null : q, cursor, limit };
  },
  authorize: INVENTORY_READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) => {
    const page = await lookupInventoryItems(
      tx,
      tenantId,
      prepared.query,
      prepared.cursor,
      prepared.limit
    );

    return page === "invalid_cursor"
      ? fail(400, "VALIDATION_ERROR", "cursor is not valid.")
      : ok(page);
  }
});
