/**
 * Shipping address shape validation — Issue #29. Pure — no database, no I/O;
 * existence checks against `idn_admin_regions` are deliberately NOT done
 * here (this module snapshots the address text/codes the customer submits,
 * `sql/913`'s header — it does not join a live region dataset).
 */
export type ValidationError = { field: string; message: string };
export type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

export type AddressInput = {
  recipientName: string;
  phone: string;
  provinceCode: string;
  provinceName: string;
  cityCode: string;
  cityName: string;
  districtCode: string;
  districtName: string;
  postalCode: string | null;
  street: string;
  latitude: number | null;
  longitude: number | null;
  notes: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(
  value: unknown,
  field: string,
  max: number,
  errors: ValidationError[]
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push({ field, message: `${field} is required.` });
    return "";
  }
  if (value.trim().length > max) {
    errors.push({
      field,
      message: `${field} must be at most ${max} characters.`
    });
  }
  return value.trim().slice(0, max);
}

function optionalText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, max);
}

function optionalCoordinate(
  value: unknown,
  field: string,
  errors: ValidationError[]
): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push({ field, message: `${field} must be a number, or null.` });
    return null;
  }
  return value;
}

/** `path ? `${path}.${field}` : field` — lets a caller with no natural prefix (Issue #91's account address resource, whose fields are top-level, not nested under `address.*`) pass `path: ""` and get a bare field name rather than a leading dot. */
function fieldName(path: string, field: string): string {
  return path ? `${path}.${field}` : field;
}

/**
 * `path` prefixes every field name (`address.street`, etc.) so this can be
 * embedded inside a larger request body's error list — the order-creation
 * contract's `details: [{field, message}]` shape uses full paths like
 * `address.districtCode`. Pass `path: ""` for a caller whose own request body
 * has no such wrapper object (Issue #91's `validateAccountAddressInput`
 * below) — see {@link fieldName}.
 */
export function validateAddressInput(
  body: unknown,
  path = "address"
): ValidationResult<AddressInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];

  const value: AddressInput = {
    recipientName: requiredText(
      record.recipientName,
      fieldName(path, "recipientName"),
      200,
      errors
    ),
    phone: requiredText(record.phone, fieldName(path, "phone"), 30, errors),
    provinceCode: requiredText(
      record.provinceCode,
      fieldName(path, "provinceCode"),
      20,
      errors
    ),
    provinceName: requiredText(
      record.provinceName,
      fieldName(path, "provinceName"),
      200,
      errors
    ),
    cityCode: requiredText(
      record.cityCode,
      fieldName(path, "cityCode"),
      20,
      errors
    ),
    cityName: requiredText(
      record.cityName,
      fieldName(path, "cityName"),
      200,
      errors
    ),
    districtCode: requiredText(
      record.districtCode,
      fieldName(path, "districtCode"),
      20,
      errors
    ),
    districtName: requiredText(
      record.districtName,
      fieldName(path, "districtName"),
      200,
      errors
    ),
    postalCode: optionalText(record.postalCode, 10),
    street: requiredText(
      record.street,
      fieldName(path, "street"),
      1000,
      errors
    ),
    latitude: optionalCoordinate(
      record.latitude,
      fieldName(path, "latitude"),
      errors
    ),
    longitude: optionalCoordinate(
      record.longitude,
      fieldName(path, "longitude"),
      errors
    ),
    notes: optionalText(record.notes, 1000)
  };

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value };
}

const MAX_LABEL_LENGTH = 100;

/**
 * The `awcms_commerce_customer_addresses` RESOURCE shape (Issue #91,
 * `GET/POST /account/addresses`, `PATCH /account/addresses/{id}`) — the same
 * shipping-address shape {@link validateAddressInput} already validates,
 * PLUS a shopper-chosen `label` (required — this is a saved, named address,
 * not a one-off order snapshot) and a REQUIRED `postalCode` (the storefront's
 * own `Alamat` contract, `apps/storefront/src/lib/akun-klien.ts`, declares
 * `postalCode: string`, never `string | null` — a SAVED address always
 * carries one, unlike an order's address snapshot where it stays optional).
 * Reuses {@link validateAddressInput} with `path: ""` for every field the two
 * shapes share, rather than a second copy of the same eleven checks.
 */
export type AccountAddressInput = Omit<AddressInput, "postalCode"> & {
  label: string;
  postalCode: string;
};

export function validateAccountAddressInput(
  body: unknown
): ValidationResult<AccountAddressInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];

  const label = requiredText(record.label, "label", MAX_LABEL_LENGTH, errors);

  const base = validateAddressInput(body, "");
  if (!base.valid) errors.push(...base.errors);

  const postalCode = requiredText(record.postalCode, "postalCode", 10, errors);

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    value: {
      ...(base as { valid: true; value: AddressInput }).value,
      label,
      postalCode
    }
  };
}
