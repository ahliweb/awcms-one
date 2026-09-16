/**
 * `awcms_commerce_sliders` create/update validation (Issue #26). Pure — no
 * database, no I/O.
 */
export type ValidationError = { field: string; message: string };
type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TITLE_LENGTH = 200;
const MAX_SUBTITLE_LENGTH = 300;
const MAX_LINK_URL_LENGTH = 2000;
const MAX_BUTTON_TEXT_LENGTH = 50;

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

export type CreateSliderInput = {
  title: string;
  subtitle: string | null;
  mediaObjectId: string;
  linkUrl: string | null;
  buttonText: string | null;
  sortOrder: number;
  isActive: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
};

export function validateCreateSliderInput(
  body: unknown
): ValidationResult<CreateSliderInput> {
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
    record.subtitle !== undefined &&
    record.subtitle !== null &&
    (typeof record.subtitle !== "string" ||
      record.subtitle.trim().length > MAX_SUBTITLE_LENGTH)
  ) {
    errors.push({
      field: "subtitle",
      message: `subtitle must be a string of at most ${MAX_SUBTITLE_LENGTH} characters, or null.`
    });
  }

  if (
    typeof record.mediaObjectId !== "string" ||
    !UUID_PATTERN.test(record.mediaObjectId)
  ) {
    errors.push({
      field: "mediaObjectId",
      message: "mediaObjectId is required and must be a valid UUID."
    });
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

  let sortOrder = 0;
  if (record.sortOrder !== undefined) {
    if (
      typeof record.sortOrder !== "number" ||
      !Number.isInteger(record.sortOrder)
    ) {
      errors.push({
        field: "sortOrder",
        message: "sortOrder must be an integer."
      });
    } else {
      sortOrder = record.sortOrder;
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
      subtitle: normalizeOptionalText(record.subtitle),
      mediaObjectId: record.mediaObjectId as string,
      linkUrl: normalizeOptionalText(record.linkUrl),
      buttonText: normalizeOptionalText(record.buttonText),
      sortOrder,
      isActive,
      startsAt: startsAt ?? null,
      endsAt: endsAt ?? null
    }
  };
}

export type UpdateSliderInput = Partial<CreateSliderInput>;

export function validateUpdateSliderInput(
  body: unknown
): ValidationResult<UpdateSliderInput> {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];
  const value: UpdateSliderInput = {};

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

  if (record.subtitle !== undefined) {
    if (
      record.subtitle !== null &&
      (typeof record.subtitle !== "string" ||
        record.subtitle.trim().length > MAX_SUBTITLE_LENGTH)
    ) {
      errors.push({
        field: "subtitle",
        message: `subtitle must be a string of at most ${MAX_SUBTITLE_LENGTH} characters, or null.`
      });
    } else {
      value.subtitle = normalizeOptionalText(record.subtitle);
    }
  }

  if (record.mediaObjectId !== undefined) {
    if (
      typeof record.mediaObjectId !== "string" ||
      !UUID_PATTERN.test(record.mediaObjectId)
    ) {
      errors.push({
        field: "mediaObjectId",
        message: "mediaObjectId must be a valid UUID."
      });
    } else {
      value.mediaObjectId = record.mediaObjectId;
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

  if (record.sortOrder !== undefined) {
    if (
      typeof record.sortOrder !== "number" ||
      !Number.isInteger(record.sortOrder)
    ) {
      errors.push({
        field: "sortOrder",
        message: "sortOrder must be an integer."
      });
    } else {
      value.sortOrder = record.sortOrder;
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
