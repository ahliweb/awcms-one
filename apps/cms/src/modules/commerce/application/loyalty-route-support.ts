/**
 * Small request-parsing helpers the loyalty routes share (Issue #289), kept
 * out of the route files so each stays a thin adapter. Pure apart from
 * building a `Response` for a rejected parameter.
 */
import { fail } from "../../_shared/api-response";
import {
  decodeKeysetCursor,
  type KeysetCursor
} from "../../_shared/keyset-pagination";

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `?cursor=&limit=` for a keyset-paginated list, as a plain result a CORS-aware (storefront) route can render itself. */
export function readPageParams(
  url: URL,
  defaultLimit: number,
  maxLimit: number
):
  | { ok: true; cursor: KeysetCursor | null; limit: number }
  | { ok: false; message: string } {
  const cursorParam = url.searchParams.get("cursor");
  let cursor: KeysetCursor | null = null;
  if (cursorParam) {
    const decoded = decodeKeysetCursor(cursorParam);
    if (!decoded) return { ok: false, message: "cursor is malformed." };
    cursor = decoded;
  }

  const limitParam = url.searchParams.get("limit");
  let limit = defaultLimit;
  if (limitParam !== null) {
    if (!/^\d{1,4}$/.test(limitParam) || Number(limitParam) < 1) {
      return { ok: false, message: "limit must be a positive integer." };
    }
    limit = Math.min(Number(limitParam), maxLimit);
  }

  return { ok: true, cursor, limit };
}

/** The owner-route form of {@link readPageParams}: a malformed cursor/limit is a `400 Response`, never silently ignored. */
export function parsePageParams(
  url: URL,
  defaultLimit: number,
  maxLimit: number
): { cursor: KeysetCursor | null; limit: number } | Response {
  const page = readPageParams(url, defaultLimit, maxLimit);
  if (!page.ok) return fail(400, "VALIDATION_ERROR", page.message);
  return { cursor: page.cursor, limit: page.limit };
}

/** A `:customerId` path parameter. */
export function parseCustomerIdParam(
  value: string | undefined
): string | Response {
  if (!value || !UUID_PATTERN.test(value)) {
    return fail(400, "VALIDATION_ERROR", "customerId must be a valid uuid.");
  }
  return value;
}

/** `?from=&to=` ISO instants or bare `YYYY-MM-DD` days (a bare `to` day is inclusive of that day). */
export function parseDateRange(
  url: URL
): { from?: Date; to?: Date } | Response {
  const range: { from?: Date; to?: Date } = {};

  for (const name of ["from", "to"] as const) {
    const raw = url.searchParams.get(name);
    if (!raw) continue;
    const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
    const parsed = new Date(dayOnly ? `${raw}T00:00:00.000Z` : raw);
    if (Number.isNaN(parsed.getTime())) {
      return fail(400, "VALIDATION_ERROR", `${name} is not a valid date.`);
    }
    // `to` is an exclusive upper bound in the query; a bare day means "through
    // the end of that day".
    range[name] =
      name === "to" && dayOnly
        ? new Date(parsed.getTime() + 86_400_000)
        : parsed;
  }

  if (range.from && range.to && range.from >= range.to) {
    return fail(400, "VALIDATION_ERROR", "from must be before to.");
  }
  return range;
}
