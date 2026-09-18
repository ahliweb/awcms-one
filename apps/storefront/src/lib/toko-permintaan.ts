/**
 * The shared request plumbing behind every anonymous/bearer call this app
 * makes to `<cms>/api/v1/commerce/storefront/*` from the BROWSER — extracted
 * out of `toko-klien.ts` (issue #30) so `akun-klien.ts` (issue #88) can reuse
 * the exact same envelope/error handling for the new `/account/*` routes
 * without a second, drifting copy of it.
 *
 * `toko-klien.ts`'s own public exports and behaviour are unchanged by this
 * split — it now imports `kirimPermintaan`/`TokoApiError` from here instead
 * of declaring them itself, and re-exports `TokoApiError` so every existing
 * caller (`src/scripts/checkout.ts`, `pesanan.ts`, and this repo's own
 * `tests/toko-klien.test.ts`) keeps working with no import changed.
 *
 * ## Every request, the same way, on purpose
 *
 * - `mode: "cors"` / `credentials: "omit"` — always, anonymous or bearer
 *   alike. A bearer session token in `Authorization` is a capability the
 *   BROWSER attaches explicitly, per request; it is never a cookie, and
 *   `credentials: "omit"` staying fixed here is what keeps that true even
 *   for the new `/account/*` routes this file was extracted for.
 * - `Content-Type: application/json` is set ONLY when a body is sent — the
 *   same rule `toko-klien.ts` already followed, now enforced in one place.
 * - `extraHeaders` (only `Authorization: Bearer <token>` today, from
 *   `akun-sesi.ts`) is merged in last, so a caller that needs it never has
 *   to duplicate the rest of this function's request-shaping.
 */
import { requireAwcmsOrigin } from "./awcms/toko-origin";
import type { CartQuote } from "./toko-klien";

export type ValidationErrorDetail = { field: string; message: string };

/**
 * One typed error for every failure this file can produce — a non-2xx
 * envelope, a network failure, or a non-JSON response. `code` is the
 * envelope's own `error.code` (`VALIDATION_ERROR`, `UNAUTHENTICATED`,
 * `ACCOUNT_NOT_FOUND`, `OTP_INVALID`, `PHONE_ALREADY_REGISTERED`,
 * `CART_CHANGED`, `NOT_FOUND`, `RATE_LIMITED`, …) or `"NETWORK_ERROR"` when
 * the request never got an HTTP response at all — every caller switches on
 * this field, never on `status` alone, because the contract itself is
 * defined in terms of `code`.
 */
export class TokoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "TokoApiError";
  }

  /** `details.field`-shaped array from a `400 VALIDATION_ERROR` — `[]` for anything else, so a caller can always iterate without a type guard. */
  get fieldErrors(): ValidationErrorDetail[] {
    if (this.code !== "VALIDATION_ERROR" || !Array.isArray(this.details)) return [];
    return this.details.filter(
      (entry): entry is ValidationErrorDetail =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as ValidationErrorDetail).field === "string" &&
        typeof (entry as ValidationErrorDetail).message === "string"
    );
  }

  /** The fresh quote a `409 CART_CHANGED` carries in `details.quote`, or `null` for any other error. The `CartQuote` import is type-only — erased at compile time — so the runtime dependency still points one way (`toko-klien.ts` → here). */
  get freshQuote(): CartQuote | null {
    if (this.code !== "CART_CHANGED") return null;
    const details = this.details as { quote?: CartQuote } | undefined;
    return details?.quote ?? null;
  }

  /** `Retry-After` seconds for a `429 RATE_LIMITED`, or `null`. */
  get retryAfterSeconds(): number | null {
    if (this.code !== "RATE_LIMITED") return null;
    const details = this.details as { retryAfter?: number } | undefined;
    return typeof details?.retryAfter === "number" ? details.retryAfter : null;
  }
}

type Envelope<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string; details?: unknown } };

export const STOREFRONT_PATH_PREFIX = "/api/v1/commerce/storefront";

/**
 * One request against the CMS's storefront commerce API (anonymous or
 * bearer, depending on `extraHeaders`), built and answered exactly the way
 * this file's own header describes. Never retried — a shopper's own retry
 * button, or an explicit "Kirim ulang" action, is the correct UI for a
 * failed mutation, not a hidden one that could double-submit.
 */
export async function kirimPermintaan<T>(
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<T> {
  const origin = requireAwcmsOrigin();
  const url = `${origin}${STOREFRONT_PATH_PREFIX}${path}`;

  const init: RequestInit = {
    method,
    mode: "cors",
    credentials: "omit"
  };

  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (extraHeaders) Object.assign(headers, extraHeaders);
  if (Object.keys(headers).length > 0) init.headers = headers;
  if (body !== undefined) init.body = JSON.stringify(body);

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    throw new TokoApiError(
      `Could not reach the store (${cause instanceof Error ? cause.message : String(cause)}). ` +
        `Check your connection and try again.`,
      0,
      "NETWORK_ERROR"
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  let payload: Envelope<T>;
  try {
    payload = (await response.json()) as Envelope<T>;
  } catch {
    throw new TokoApiError(
      `The store returned an unreadable response (HTTP ${response.status}).`,
      response.status,
      "INVALID_RESPONSE"
    );
  }

  if (!payload.success) {
    throw new TokoApiError(payload.error.message, response.status, payload.error.code, payload.error.details);
  }

  return payload.data;
}
