/**
 * Pure validation for the commerce inbox (Issue #111, contract #106 D8) —
 * no database, no I/O. Mirrors `domain/address-validation.ts`'s
 * `ValidationError`/`ValidationResult` shape so every route in this module
 * switches on the same `{field, message}[]` list.
 */
export type ValidationError = { field: string; message: string };
export type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

export const CONVERSATION_SUBJECT_MIN_LENGTH = 1;
export const CONVERSATION_SUBJECT_MAX_LENGTH = 150;
export const CONVERSATION_MESSAGE_MIN_LENGTH = 1;
export const CONVERSATION_MESSAGE_MAX_LENGTH = 4000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type OpenConversationInput = { subject: string; body: string };

/** `POST /account/conversations` — the opening subject + first message, per the storefront's own `BuatPercakapanInput` (`akun-klien.ts`). */
export function validateOpenConversationInput(
  body: unknown
): ValidationResult<OpenConversationInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];

  const subjectRaw =
    typeof record.subject === "string" ? record.subject.trim() : "";
  if (subjectRaw.length < CONVERSATION_SUBJECT_MIN_LENGTH) {
    errors.push({ field: "subject", message: "subject is required." });
  } else if (subjectRaw.length > CONVERSATION_SUBJECT_MAX_LENGTH) {
    errors.push({
      field: "subject",
      message: `subject must be at most ${CONVERSATION_SUBJECT_MAX_LENGTH} characters.`
    });
  }

  const bodyRaw = typeof record.body === "string" ? record.body.trim() : "";
  if (bodyRaw.length < CONVERSATION_MESSAGE_MIN_LENGTH) {
    errors.push({ field: "body", message: "body is required." });
  } else if (bodyRaw.length > CONVERSATION_MESSAGE_MAX_LENGTH) {
    errors.push({
      field: "body",
      message: `body must be at most ${CONVERSATION_MESSAGE_MAX_LENGTH} characters.`
    });
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    value: {
      subject: subjectRaw.slice(0, CONVERSATION_SUBJECT_MAX_LENGTH),
      body: bodyRaw.slice(0, CONVERSATION_MESSAGE_MAX_LENGTH)
    }
  };
}

/** `POST .../conversations/{id}/messages` — a reply on an existing thread, either side. */
export function validateConversationMessageInput(
  body: unknown
): ValidationResult<{ body: string }> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];

  const bodyRaw = typeof record.body === "string" ? record.body.trim() : "";
  if (bodyRaw.length < CONVERSATION_MESSAGE_MIN_LENGTH) {
    errors.push({ field: "body", message: "body is required." });
  } else if (bodyRaw.length > CONVERSATION_MESSAGE_MAX_LENGTH) {
    errors.push({
      field: "body",
      message: `body must be at most ${CONVERSATION_MESSAGE_MAX_LENGTH} characters.`
    });
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    value: { body: bodyRaw.slice(0, CONVERSATION_MESSAGE_MAX_LENGTH) }
  };
}

/** `PATCH /api/v1/commerce/conversations/{id}` — owner status transition. */
export function validateConversationStatusInput(
  body: unknown
): ValidationResult<{ status: "open" | "closed" }> {
  const record = isRecord(body) ? body : {};
  const status = record.status;

  if (status !== "open" && status !== "closed") {
    return {
      valid: false,
      errors: [
        { field: "status", message: "status must be one of: open, closed." }
      ]
    };
  }

  return { valid: true, value: { status } };
}
