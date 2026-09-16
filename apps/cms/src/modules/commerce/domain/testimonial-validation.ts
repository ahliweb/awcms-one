/**
 * `awcms_commerce_testimonials` create/update validation (Issue #26). Pure —
 * no database, no I/O.
 *
 * `authorName`/`authorRole`/`body` are free text an ADMIN types (or copies
 * from a real customer's own words) — see `module.ts`'s `subjectData` entry
 * for this table for why that still leaves the table `unreachableBySubject`.
 */
export type ValidationError = { field: string; message: string };
type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AUTHOR_NAME_LENGTH = 200;
const MAX_AUTHOR_ROLE_LENGTH = 100;
const MAX_BODY_LENGTH = 2000;
const MIN_RATING = 1;
const MAX_RATING = 5;

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type CreateTestimonialInput = {
  authorName: string;
  authorRole: string | null;
  body: string;
  rating: number;
  avatarMediaObjectId: string | null;
  isActive: boolean;
  sortOrder: number;
};

export function validateCreateTestimonialInput(
  body: unknown
): ValidationResult<CreateTestimonialInput> {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];

  if (!isNonEmptyTrimmedString(record.authorName)) {
    errors.push({ field: "authorName", message: "authorName is required." });
  } else if (
    (record.authorName as string).trim().length > MAX_AUTHOR_NAME_LENGTH
  ) {
    errors.push({
      field: "authorName",
      message: `authorName must be at most ${MAX_AUTHOR_NAME_LENGTH} characters.`
    });
  }

  if (
    record.authorRole !== undefined &&
    record.authorRole !== null &&
    (typeof record.authorRole !== "string" ||
      record.authorRole.trim().length > MAX_AUTHOR_ROLE_LENGTH)
  ) {
    errors.push({
      field: "authorRole",
      message: `authorRole must be a string of at most ${MAX_AUTHOR_ROLE_LENGTH} characters, or null.`
    });
  }

  if (!isNonEmptyTrimmedString(record.body)) {
    errors.push({ field: "body", message: "body is required." });
  } else if ((record.body as string).trim().length > MAX_BODY_LENGTH) {
    errors.push({
      field: "body",
      message: `body must be at most ${MAX_BODY_LENGTH} characters.`
    });
  }

  let rating = MAX_RATING;
  if (record.rating !== undefined) {
    if (
      typeof record.rating !== "number" ||
      !Number.isInteger(record.rating) ||
      record.rating < MIN_RATING ||
      record.rating > MAX_RATING
    ) {
      errors.push({
        field: "rating",
        message: `rating must be an integer between ${MIN_RATING} and ${MAX_RATING}.`
      });
    } else {
      rating = record.rating;
    }
  }

  let avatarMediaObjectId: string | null = null;
  if (
    record.avatarMediaObjectId !== undefined &&
    record.avatarMediaObjectId !== null
  ) {
    if (
      typeof record.avatarMediaObjectId !== "string" ||
      !UUID_PATTERN.test(record.avatarMediaObjectId)
    ) {
      errors.push({
        field: "avatarMediaObjectId",
        message: "avatarMediaObjectId must be a valid UUID, or null."
      });
    } else {
      avatarMediaObjectId = record.avatarMediaObjectId;
    }
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

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    value: {
      authorName: (record.authorName as string).trim(),
      authorRole: normalizeOptionalText(record.authorRole),
      body: (record.body as string).trim(),
      rating,
      avatarMediaObjectId,
      isActive,
      sortOrder
    }
  };
}

export type UpdateTestimonialInput = Partial<CreateTestimonialInput>;

export function validateUpdateTestimonialInput(
  body: unknown
): ValidationResult<UpdateTestimonialInput> {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];
  const value: UpdateTestimonialInput = {};

  if (record.authorName !== undefined) {
    if (
      !isNonEmptyTrimmedString(record.authorName) ||
      (record.authorName as string).trim().length > MAX_AUTHOR_NAME_LENGTH
    ) {
      errors.push({
        field: "authorName",
        message: `authorName must be a non-empty string of at most ${MAX_AUTHOR_NAME_LENGTH} characters.`
      });
    } else {
      value.authorName = (record.authorName as string).trim();
    }
  }

  if (record.authorRole !== undefined) {
    if (
      record.authorRole !== null &&
      (typeof record.authorRole !== "string" ||
        record.authorRole.trim().length > MAX_AUTHOR_ROLE_LENGTH)
    ) {
      errors.push({
        field: "authorRole",
        message: `authorRole must be a string of at most ${MAX_AUTHOR_ROLE_LENGTH} characters, or null.`
      });
    } else {
      value.authorRole = normalizeOptionalText(record.authorRole);
    }
  }

  if (record.body !== undefined) {
    if (
      !isNonEmptyTrimmedString(record.body) ||
      (record.body as string).trim().length > MAX_BODY_LENGTH
    ) {
      errors.push({
        field: "body",
        message: `body must be a non-empty string of at most ${MAX_BODY_LENGTH} characters.`
      });
    } else {
      value.body = (record.body as string).trim();
    }
  }

  if (record.rating !== undefined) {
    if (
      typeof record.rating !== "number" ||
      !Number.isInteger(record.rating) ||
      record.rating < MIN_RATING ||
      record.rating > MAX_RATING
    ) {
      errors.push({
        field: "rating",
        message: `rating must be an integer between ${MIN_RATING} and ${MAX_RATING}.`
      });
    } else {
      value.rating = record.rating;
    }
  }

  if (record.avatarMediaObjectId !== undefined) {
    if (
      record.avatarMediaObjectId !== null &&
      (typeof record.avatarMediaObjectId !== "string" ||
        !UUID_PATTERN.test(record.avatarMediaObjectId))
    ) {
      errors.push({
        field: "avatarMediaObjectId",
        message: "avatarMediaObjectId must be a valid UUID, or null."
      });
    } else {
      value.avatarMediaObjectId = record.avatarMediaObjectId as string | null;
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

  if (errors.length === 0 && Object.keys(value).length === 0) {
    errors.push({
      field: "body",
      message: "Provide at least one field to update."
    });
  }

  if (errors.length > 0) return { valid: false, errors };

  return { valid: true, value };
}
