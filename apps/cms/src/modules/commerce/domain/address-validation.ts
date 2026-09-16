/**
 * Shipping address shape validation — Issue #29. Pure — no database, no I/O;
 * existence checks against `idn_admin_regions` are deliberately NOT done
 * here (this module snapshots the address text/codes the customer submits,
 * `sql/165`'s header — it does not join a live region dataset).
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

/**
 * `path` prefixes every field name (`address.street`, etc.) so this can be
 * embedded inside a larger request body's error list — the order-creation
 * contract's `details: [{field, message}]` shape uses full paths like
 * `address.districtCode`.
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
      `${path}.recipientName`,
      200,
      errors
    ),
    phone: requiredText(record.phone, `${path}.phone`, 30, errors),
    provinceCode: requiredText(
      record.provinceCode,
      `${path}.provinceCode`,
      20,
      errors
    ),
    provinceName: requiredText(
      record.provinceName,
      `${path}.provinceName`,
      200,
      errors
    ),
    cityCode: requiredText(record.cityCode, `${path}.cityCode`, 20, errors),
    cityName: requiredText(record.cityName, `${path}.cityName`, 200, errors),
    districtCode: requiredText(
      record.districtCode,
      `${path}.districtCode`,
      20,
      errors
    ),
    districtName: requiredText(
      record.districtName,
      `${path}.districtName`,
      200,
      errors
    ),
    postalCode: optionalText(record.postalCode, 10),
    street: requiredText(record.street, `${path}.street`, 1000, errors),
    latitude: optionalCoordinate(record.latitude, `${path}.latitude`, errors),
    longitude: optionalCoordinate(
      record.longitude,
      `${path}.longitude`,
      errors
    ),
    notes: optionalText(record.notes, 1000)
  };

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value };
}
