export type ValidationError = { field: string; message: string };

type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same grammar as `product-validation.ts`'s `SLUG_PATTERN` — see its comment. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 200;
const MAX_NAME_LENGTH = 150;
const MAX_ICON_LENGTH = 100;

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type CreateCategoryInput = {
  parentId: string | null;
  name: string;
  slug: string;
  icon: string | null;
};

export function validateCreateCategoryInput(
  body: unknown
): ValidationResult<CreateCategoryInput> {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];

  if (
    typeof record.name !== "string" ||
    record.name.trim().length === 0 ||
    record.name.trim().length > MAX_NAME_LENGTH
  ) {
    errors.push({
      field: "name",
      message: `name is required and must be at most ${MAX_NAME_LENGTH} characters.`
    });
  }

  if (
    typeof record.slug !== "string" ||
    record.slug.length === 0 ||
    record.slug.length > MAX_SLUG_LENGTH ||
    !SLUG_PATTERN.test(record.slug)
  ) {
    errors.push({
      field: "slug",
      message:
        "slug is required and must be lowercase alphanumeric segments separated by single hyphens."
    });
  }

  let parentId: string | null = null;
  if (record.parentId !== undefined && record.parentId !== null) {
    if (
      typeof record.parentId !== "string" ||
      !UUID_PATTERN.test(record.parentId)
    ) {
      errors.push({
        field: "parentId",
        message: "parentId must be a valid UUID."
      });
    } else {
      parentId = record.parentId;
    }
  }

  if (
    record.icon !== undefined &&
    record.icon !== null &&
    (typeof record.icon !== "string" ||
      record.icon.trim().length > MAX_ICON_LENGTH)
  ) {
    errors.push({
      field: "icon",
      message: `icon must be a string of at most ${MAX_ICON_LENGTH} characters.`
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      parentId,
      name: (record.name as string).trim(),
      slug: record.slug as string,
      icon: normalizeOptionalText(record.icon)
    }
  };
}

/**
 * No `parentId` here, deliberately — same choice
 * `office-validation.ts`'s `UpdateOfficeInput` makes for
 * `parentOfficeId`: a category's position in the hierarchy is set once, at
 * creation, and re-parenting is out of this slice's scope (it would need
 * cycle detection this codebase's closest analog, offices, does not have
 * either). Move a category by deleting and recreating it.
 */
export type UpdateCategoryInput = {
  name?: string;
  slug?: string;
  icon?: string | null;
};

export function validateUpdateCategoryInput(
  body: unknown
): ValidationResult<UpdateCategoryInput> {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];
  const value: UpdateCategoryInput = {};

  if (record.name !== undefined) {
    if (
      typeof record.name !== "string" ||
      record.name.trim().length === 0 ||
      record.name.trim().length > MAX_NAME_LENGTH
    ) {
      errors.push({
        field: "name",
        message: `name must be a non-empty string of at most ${MAX_NAME_LENGTH} characters.`
      });
    } else {
      value.name = record.name.trim();
    }
  }

  if (record.slug !== undefined) {
    if (
      typeof record.slug !== "string" ||
      record.slug.length === 0 ||
      record.slug.length > MAX_SLUG_LENGTH ||
      !SLUG_PATTERN.test(record.slug)
    ) {
      errors.push({
        field: "slug",
        message:
          "slug must be lowercase alphanumeric segments separated by single hyphens."
      });
    } else {
      value.slug = record.slug;
    }
  }

  if (record.icon !== undefined) {
    if (
      record.icon !== null &&
      (typeof record.icon !== "string" ||
        record.icon.trim().length > MAX_ICON_LENGTH)
    ) {
      errors.push({
        field: "icon",
        message: `icon must be a string of at most ${MAX_ICON_LENGTH} characters, or null.`
      });
    } else {
      value.icon = normalizeOptionalText(record.icon);
    }
  }

  if (errors.length === 0 && Object.keys(value).length === 0) {
    errors.push({
      field: "body",
      message: "Provide at least one of name, slug, icon."
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, value };
}
