/**
 * The paging rules of the deposit-policy admin screen's list (Issue #385,
 * follow-up #448 "Deposits screen limit"). Pure: no database, no I/O.
 *
 * The list is ordered by product name then id (an operator looks a product up
 * by name), so the shared `(created_at, id)` cursor does not fit. This cursor is
 * the last row's `(name, id)`, base64url of a small JSON pair, compared as a
 * row value (`(name, id) > (cursor)`) in the same order as the `ORDER BY`. It
 * is opaque to the browser and carries no tenant data; the tenant filter is
 * always applied by the query, so a forged cursor can only move within the
 * caller's own rows. An unreadable cursor is `null`, which the screen treats
 * as the first page, never as an error.
 */

/** Rows per page of the deposits screen. */
export const DEPOSIT_LIST_PAGE_SIZE = 50;

/**
 * The cap of the unpaged list the cancellation-policy scope selector reads.
 * Beyond it the selector says so (the screen shows a notice) instead of
 * silently omitting products.
 */
export const SERVICE_PRODUCT_SELECTOR_LIMIT = 200;

export type DepositListCursor = { name: string; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeDepositListCursor(cursor: DepositListCursor): string {
  return Buffer.from(JSON.stringify([cursor.name, cursor.id]), "utf8").toString(
    "base64url"
  );
}

export function decodeDepositListCursor(
  raw: string | null | undefined
): DepositListCursor | null {
  if (!raw || raw.length > 1024) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8")
    );
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string" &&
      UUID.test(parsed[1])
    ) {
      return { name: parsed[0], id: parsed[1] };
    }
  } catch {
    /* fall through: an unreadable cursor is the first page */
  }
  return null;
}
