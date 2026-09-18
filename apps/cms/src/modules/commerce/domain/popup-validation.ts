/**
 * `awcms_commerce_popups` create/update validation (Issue #26). Pure — no
 * database, no I/O. "At most one ACTIVE popup per tenant" is enforced by
 * `sql/909`'s partial unique index, not here — this file only validates one
 * row's own shape; `application/popup-directory.ts` maps the resulting
 * unique-violation to `409 POPUP_ALREADY_ACTIVE`.
 */
export type ValidationError = { field: string; message: string };
type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 1000;
const MAX_LINK_URL_LENGTH = 2000;
const MAX_BUTTON_TEXT_LENGTH = 50;

export const POPUP_FREQUENCIES = [
  "once_per_session",
  "once_per_day",
  "always"
] as const;
export type PopupFrequency = (typeof POPUP_FREQUENCIES)[number];

export function isPopupFrequency(value: unknown): value is PopupFrequency {
  return (
    typeof value === "string" &&
    (POPUP_FREQUENCIES as readonly string[]).includes(value)
  );
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseIsoDateOrNull(
  value: unknown,
  field: string,
  errors: ValidationError[]
): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    errors.push({
      field,
      message: `${field} must be an ISO-8601 date-time string, or null.`
    });
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    errors.push({
      field,
      message: `${field} must be an ISO-8601 date-time string, or null.`
    });
    return undefined;
  }
  return date;
}

export type CreatePopupInput = {
  title: string;
  body: string | null;
  mediaObjectId: string | null;
  linkUrl: string | null;
  buttonText: string | null;
  frequency: PopupFrequency;
  isActive: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
};

export function validateCreatePopupInput(
  body: unknown
): ValidationResult<CreatePopupInput> {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];

  if (!isNonEmptyTrimmedString(record.title)) {
    errors.push({ field: "title", message: "title is required." });
  } else if ((record.title as string).trim().length > MAX_TITLE_LENGTH) {
    errors.push({
      field: "title",
      message: `title must be at most ${MAX_TITLE_LENGTH} characters.`
    });
  }

  if (
    record.body !== undefined &&
    record.body !== null &&
    (typeof record.body !== "string" ||
      record.body.trim().length > MAX_BODY_LENGTH)
  ) {
    errors.push({
      field: "body",
      message: `body must be a string of at most ${MAX_BODY_LENGTH} characters, or null.`
    });
  }

  let mediaObjectId: string | null = null;
  if (record.mediaObjectId !== undefined && record.mediaObjectId !== null) {
    if (
      typeof record.mediaObjectId !== "string" ||
      !UUID_PATTERN.test(record.mediaObjectId)
    ) {
      errors.push({
        field: "mediaObjectId",
        message: "mediaObjectId must be a valid UUID, or null."
      });
    } else {
      mediaObjectId = record.mediaObjectId;
    }
  }

  if (
    record.linkUrl !== undefined &&
    record.linkUrl !== null &&
    (typeof record.linkUrl !== "string" ||
      record.linkUrl.trim().length > MAX_LINK_URL_LENGTH)
  ) {
    errors.push({
      field: "linkUrl",
      message: `linkUrl must be a string of at most ${MAX_LINK_URL_LENGTH} characters, or null.`
    });
  }

  if (
    record.buttonText !== undefined &&
    record.buttonText !== null &&
    (typeof record.buttonText !== "string" ||
      record.buttonText.trim().length > MAX_BUTTON_TEXT_LENGTH)
  ) {
    errors.push({
      field: "buttonText",
      message: `buttonText must be a string of at most ${MAX_BUTTON_TEXT_LENGTH} characters, or null.`
    });
  }

  let frequency: PopupFrequency = "once_per_day";
  if (record.frequency !== undefined) {
    if (!isPopupFrequency(record.frequency)) {
      errors.push({
        field: "frequency",
        message: `frequency must be one of: ${POPUP_FREQUENCIES.join(", ")}.`
      });
    } else {
      frequency = record.frequency;
    }
  }

  const isActive = record.isActive !== false;

  const startsAt = parseIsoDateOrNull(record.startsAt, "startsAt", errors);
  const endsAt = parseIsoDateOrNull(record.endsAt, "endsAt", errors);
  if (startsAt && endsAt && endsAt <= startsAt) {
    errors.push({
      field: "endsAt",
      message: "endsAt must be after startsAt when both are set."
    });
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    value: {
      title: (record.title as string).trim(),
      body: normalizeOptionalText(record.body),
      mediaObjectId,
      linkUrl: normalizeOptionalText(record.linkUrl),
      buttonText: normalizeOptionalText(record.buttonText),
      frequency,
      isActive,
      startsAt: startsAt ?? null,
      endsAt: endsAt ?? null
    }
  };
}

export type UpdatePopupInput = Partial<CreatePopupInput>;

export function validateUpdatePopupInput(
  body: unknown
): ValidationResult<UpdatePopupInput> {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];
  const value: UpdatePopupInput = {};

  if (record.title !== undefined) {
    if (
      !isNonEmptyTrimmedString(record.title) ||
      (record.title as string).trim().length > MAX_TITLE_LENGTH
    ) {
      errors.push({
        field: "title",
        message: `title must be a non-empty string of at most ${MAX_TITLE_LENGTH} characters.`
      });
    } else {
      value.title = (record.title as string).trim();
    }
  }

  if (record.body !== undefined) {
    if (
      record.body !== null &&
      (typeof record.body !== "string" ||
        record.body.trim().length > MAX_BODY_LENGTH)
    ) {
      errors.push({
        field: "body",
        message: `body must be a string of at most ${MAX_BODY_LENGTH} characters, or null.`
      });
    } else {
      value.body = normalizeOptionalText(record.body);
    }
  }

  if (record.mediaObjectId !== undefined) {
    if (
      record.mediaObjectId !== null &&
      (typeof record.mediaObjectId !== "string" ||
        !UUID_PATTERN.test(record.mediaObjectId))
    ) {
      errors.push({
        field: "mediaObjectId",
        message: "mediaObjectId must be a valid UUID, or null."
      });
    } else {
      value.mediaObjectId = record.mediaObjectId as string | null;
    }
  }

  if (record.linkUrl !== undefined) {
    if (
      record.linkUrl !== null &&
      (typeof record.linkUrl !== "string" ||
        record.linkUrl.trim().length > MAX_LINK_URL_LENGTH)
    ) {
      errors.push({
        field: "linkUrl",
        message: `linkUrl must be a string of at most ${MAX_LINK_URL_LENGTH} characters, or null.`
      });
    } else {
      value.linkUrl = normalizeOptionalText(record.linkUrl);
    }
  }

  if (record.buttonText !== undefined) {
    if (
      record.buttonText !== null &&
      (typeof record.buttonText !== "string" ||
        record.buttonText.trim().length > MAX_BUTTON_TEXT_LENGTH)
    ) {
      errors.push({
        field: "buttonText",
        message: `buttonText must be a string of at most ${MAX_BUTTON_TEXT_LENGTH} characters, or null.`
      });
    } else {
      value.buttonText = normalizeOptionalText(record.buttonText);
    }
  }

  if (record.frequency !== undefined) {
    if (!isPopupFrequency(record.frequency)) {
      errors.push({
        field: "frequency",
        message: `frequency must be one of: ${POPUP_FREQUENCIES.join(", ")}.`
      });
    } else {
      value.frequency = record.frequency;
    }
  }

  if (record.isActive !== undefined) {
    if (typeof record.isActive !== "boolean") {
      errors.push({
        field: "isActive",
        message: "isActive must be a boolean."
      });
    } else {
      value.isActive = record.isActive;
    }
  }

  const startsAt = parseIsoDateOrNull(record.startsAt, "startsAt", errors);
  if (startsAt !== undefined) value.startsAt = startsAt;
  const endsAt = parseIsoDateOrNull(record.endsAt, "endsAt", errors);
  if (endsAt !== undefined) value.endsAt = endsAt;

  if (value.startsAt && value.endsAt && value.endsAt <= value.startsAt) {
    errors.push({
      field: "endsAt",
      message: "endsAt must be after startsAt when both are set."
    });
  }

  if (errors.length === 0 && Object.keys(value).length === 0) {
    errors.push({
      field: "body",
      message: "Provide at least one field to update."
    });
  }

  if (errors.length > 0) return { valid: false, errors };

  return { valid: true, value };
}
