/**
 * The HTTP edge shared by the storefront and admin data-subject routes
 * (Issue #529, ADR-0055 D3): one place maps a refusal to its `409` body, so the
 * storefront page and the admin screen read the same `code` and `refusals`.
 */
import { fail } from "../../_shared/api-response";
import {
  SUBJECT_REFUSAL_MESSAGES,
  validateSubjectIdempotencyKey,
  type SubjectRefusalCode
} from "../domain/customer-subject-policy";

/** `409 ERASURE_REFUSED` with every applicable code and its message. */
export function erasureRefusedResponse(
  codes: readonly SubjectRefusalCode[],
  headers: Record<string, string> = {}
): Response {
  const first = codes[0] ?? "OPEN_ORDER";
  return fail(
    409,
    "ERASURE_REFUSED",
    SUBJECT_REFUSAL_MESSAGES[first],
    {},
    {
      refusals: codes.map((code) => ({
        code,
        message: SUBJECT_REFUSAL_MESSAGES[code]
      }))
    },
    headers
  );
}

/** Every failure of a one-time code is ONE generic answer (ADR-0016). */
export function subjectOtpInvalidResponse(
  headers: Record<string, string> = {}
): Response {
  return fail(
    400,
    "OTP_INVALID",
    "The verification code is invalid or has expired.",
    {},
    undefined,
    headers
  );
}

export function subjectKeyRequiredResponse(
  message: string,
  headers: Record<string, string> = {}
): Response {
  return fail(400, "IDEMPOTENCY_KEY_REQUIRED", message, {}, undefined, headers);
}

/** The `Idempotency-Key` an ADMIN subject mutation requires, or the `400` to return. */
export function requireSubjectIdempotencyKey(
  request: Request
): { key: string } | { response: Response } {
  const raw = request.headers.get("idempotency-key");
  const problem = validateSubjectIdempotencyKey(raw);
  if (problem) return { response: subjectKeyRequiredResponse(problem) };
  return { key: raw as string };
}

/** The `Cache-Control` of a response that carries a bundle or a code: never cached. */
export const NO_STORE_HEADERS = { "cache-control": "no-store" } as const;
