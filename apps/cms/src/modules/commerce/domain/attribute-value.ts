/**
 * Typed catalog attribute values (Issue #291) — the ONE place a raw value
 * (a JSON scalar from the API, or a CSV cell) becomes a stored, typed,
 * deterministic value. Pure: no database, no I/O, no locale.
 *
 * ## Locale-independent persisted values
 *
 * A stored value never depends on the operator's locale, the server's locale,
 * or the `Intl` data in the runtime. The accepted grammars are deliberately
 * narrow and ASCII-only:
 *
 *   - `integer` : `[+-]?[0-9]+`, magnitude at most 2^53 - 1 (so the JSON wire
 *     form is always an exactly-representable number).
 *   - `decimal` : `[+-]?[0-9]+(\.[0-9]+)?` — `.` is the ONLY decimal
 *     separator, a leading digit is required (`.5` is rejected), and there is
 *     no exponent, no grouping separator, no whitespace inside the number.
 *     `1.234,5` and `1,5` are REJECTED, never guessed at: whether `1,234` is
 *     "1234" or "1.234" is exactly the ambiguity that corrupts a catalog, so
 *     the grammar has no reading of it at all. A value with more fractional
 *     digits than the definition's `scale` is rejected, never rounded.
 *   - `boolean` : the JSON booleans, or the case-insensitive strings `true` /
 *     `false` (the CSV spelling). No `1`/`0`/`yes`/`on`.
 *   - `date`    : strict ISO `YYYY-MM-DD`, a real calendar date (leap years
 *     honoured), no time, no time zone.
 *   - `text`    : NFC-normalised, trimmed, single line (no control
 *     characters), bounded length.
 *   - `enum`    : an exact (case-sensitive) member of the definition's closed
 *     option list.
 *
 * Decimal comparison is done on integers (`BigInt`, scaled by 10^6 — the same
 * representation the database stores), never on floats — the exact-arithmetic
 * rule ADR-0003 sets for money. `integer` and `decimal` values are limited to 12
 * integer digits and (decimal) 6 fractional digits.
 */

export const ATTRIBUTE_VALUE_TYPES = [
  "text",
  "integer",
  "decimal",
  "boolean",
  "date",
  "enum"
] as const;

export type AttributeValueType = (typeof ATTRIBUTE_VALUE_TYPES)[number];

export function isAttributeValueType(
  value: unknown
): value is AttributeValueType {
  return (
    typeof value === "string" &&
    (ATTRIBUTE_VALUE_TYPES as readonly string[]).includes(value)
  );
}

export type AttributeEnumOption = { value: string; label: string };

/**
 * The CLOSED constraint schema. Which keys are legal depends on the type
 * (`ALLOWED_CONSTRAINT_KEYS`); `attribute-definition.ts` rejects anything
 * else. There is deliberately no `pattern` (a tenant-authored regular
 * expression is a ReDoS vector and a second, un-auditable grammar) and no
 * free-form expression of any kind.
 */
export type AttributeConstraints = {
  /** text */
  minLength?: number;
  /** text */
  maxLength?: number;
  /** integer | decimal (canonical decimal string); date (ISO date) */
  min?: string;
  /** integer | decimal (canonical decimal string); date (ISO date) */
  max?: string;
  /** decimal — the maximum number of fractional digits (1..8). */
  scale?: number;
  /** enum — the closed list of allowed values. */
  options?: AttributeEnumOption[];
};

export type ValueDefinitionShape = {
  valueType: AttributeValueType;
  constraints: AttributeConstraints;
};

/**
 * A parsed value in storage shape: exactly one of the four typed columns is
 * non-null. `search` is the deterministic normalised text a `text`/`enum`
 * value is matched on (`NFKC` + `toLowerCase()` — locale-independent, unlike
 * `toLocaleLowerCase`); it is `null` for every other type.
 */
export type ParsedAttributeValue = {
  text: string | null;
  /** The canonical decimal string of an integer/decimal value. */
  numeric: string | null;
  /** `value x 10^6` as a base-10 integer string — the `value_scaled bigint` column. */
  scaled: string | null;
  boolean: boolean | null;
  date: string | null;
  search: string | null;
  /** The canonical string form — what the CSV export writes and what equality is decided on. */
  canonical: string;
};

export type AttributeValueParseResult =
  | { valid: true; value: ParsedAttributeValue }
  | { valid: false; message: string };

export const DEFAULT_TEXT_MAX_LENGTH = 500;
export const HARD_TEXT_MAX_LENGTH = 2000;
export const DEFAULT_DECIMAL_SCALE = 4;
/**
 * Numbers are stored as a `bigint` holding `value x 10^6` (`value_scaled`,
 * `sql/960`), so the fixed storage scale is 6 fractional digits and the largest
 * magnitude is 12 integer digits (10^12 x 10^6 = 10^18 < 2^63). Why a scaled
 * integer rather than `numeric`: under FORCE ROW LEVEL SECURITY Postgres only
 * pushes LEAKPROOF operators into an index condition, and `numeric`'s
 * comparison operators are not leakproof while `int8`'s are — the measured
 * reason, recorded in ADR-0027, that a numeric range filter can use a b-tree
 * here at all.
 */
export const MAX_DECIMAL_SCALE = 6;
export const MAX_INTEGER_DIGITS = 12;
export const MAX_ENUM_OPTIONS = 100;
export const MAX_ENUM_VALUE_LENGTH = 64;

const INTEGER_PATTERN = /^[+-]?[0-9]+$/;
const DECIMAL_PATTERN = /^[+-]?[0-9]+(\.[0-9]+)?$/;
const ISO_DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
/** C0 controls (incl. tab/CR/LF) and DEL. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;
export const ENUM_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const SCALE_FACTOR_DIGITS = MAX_DECIMAL_SCALE;

type DecimalParts = { negative: boolean; integer: string; fraction: string };

/**
 * Splits a grammar-valid decimal string into sign/integer/fraction, stripping
 * leading zeros of the integer part and trailing zeros of the fraction, and
 * normalising `-0` to `0`. Returns `null` when the string is outside the
 * grammar or either part exceeds its digit bound.
 */
function splitDecimal(
  raw: string,
  integerOnly: boolean
): DecimalParts | "grammar" | "digits" {
  const pattern = integerOnly ? INTEGER_PATTERN : DECIMAL_PATTERN;
  if (!pattern.test(raw)) return "grammar";

  let negative = false;
  let body = raw;
  if (body.startsWith("+")) body = body.slice(1);
  else if (body.startsWith("-")) {
    negative = true;
    body = body.slice(1);
  }

  const [integerRaw = "", fractionRaw = ""] = body.split(".");
  const integer = integerRaw.replace(/^0+(?=[0-9])/, "");
  const fraction = fractionRaw.replace(/0+$/, "");

  if (integer.length > MAX_INTEGER_DIGITS) return "digits";

  const isZero = /^0*$/.test(integer) && fraction.length === 0;
  return { negative: negative && !isZero, integer, fraction };
}

function formatDecimal(parts: DecimalParts): string {
  const fraction = parts.fraction.length > 0 ? `.${parts.fraction}` : "";
  return `${parts.negative ? "-" : ""}${parts.integer}${fraction}`;
}

/**
 * Exact scaled integer (value x 10^8) for ordering comparisons. Input must be
 * a canonical decimal string produced by this module.
 */
export function scaledDecimal(canonical: string): bigint {
  const parts = splitDecimal(canonical, false);
  if (typeof parts === "string") {
    throw new Error(`Not a canonical decimal: ${canonical}`);
  }
  const fraction = parts.fraction.padEnd(SCALE_FACTOR_DIGITS, "0");
  const magnitude = BigInt(`${parts.integer}${fraction}`);
  return parts.negative ? -magnitude : magnitude;
}

/** Compares two canonical decimal strings exactly: -1 | 0 | 1. */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const left = scaledDecimal(a);
  const right = scaledDecimal(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function parseDecimalString(
  raw: string,
  integerOnly: boolean,
  scale: number
): { ok: true; canonical: string } | { ok: false; message: string } {
  const trimmed = raw.trim();
  const parts = splitDecimal(trimmed, integerOnly);

  if (parts === "grammar") {
    return {
      ok: false,
      message: integerOnly
        ? "must be a whole number written with digits only (for example 42 or -7)."
        : 'must be a number written with digits and "." as the only decimal separator (for example 1234.5); grouping separators, a decimal comma and exponents are not accepted.'
    };
  }
  if (parts === "digits") {
    return {
      ok: false,
      message: `must have at most ${MAX_INTEGER_DIGITS} integer digits.`
    };
  }
  if (!integerOnly && parts.fraction.length > scale) {
    return {
      ok: false,
      message: `must have at most ${scale} fractional digits (values are never rounded).`
    };
  }

  return { ok: true, canonical: formatDecimal(parts) };
}

function isCalendarDate(raw: string): boolean {
  if (!ISO_DATE_PATTERN.test(raw)) return false;
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(5, 7));
  const day = Number(raw.slice(8, 10));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const probe = new Date(Date.UTC(2000, month - 1, day));
  probe.setUTCFullYear(year);
  // Re-derive each part: `Date.UTC` rolls 31 Feb over into March.
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/** Deterministic search normalisation: NFKC + `toLowerCase()` (never a locale-sensitive lower-casing). */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

const EMPTY_VALUE = {
  text: null,
  numeric: null,
  scaled: null,
  boolean: null,
  date: null,
  search: null
} as const;

/**
 * Parses and normalises one raw value against one definition's type and
 * constraints. `raw` is whatever the transport carried: a JSON scalar from the
 * API, or a `string` CSV cell. `null`/`undefined` are NOT handled here — a
 * caller treats those as "clear the value" before calling.
 */
export function parseAttributeValue(
  definition: ValueDefinitionShape,
  raw: unknown
): AttributeValueParseResult {
  const { valueType, constraints } = definition;

  switch (valueType) {
    case "text": {
      if (typeof raw !== "string") {
        return { valid: false, message: "must be a string." };
      }
      const text = raw.normalize("NFC").trim();
      if (text.length === 0) {
        return { valid: false, message: "must not be empty." };
      }
      if (CONTROL_CHARACTER_PATTERN.test(text)) {
        return {
          valid: false,
          message: "must be a single line without control characters."
        };
      }
      const maxLength = constraints.maxLength ?? DEFAULT_TEXT_MAX_LENGTH;
      // `[...text].length` counts code points, not UTF-16 units, so an emoji
      // is one character against the bound.
      const length = [...text].length;
      if (length > maxLength) {
        return {
          valid: false,
          message: `must be at most ${maxLength} characters.`
        };
      }
      if (
        constraints.minLength !== undefined &&
        length < constraints.minLength
      ) {
        return {
          valid: false,
          message: `must be at least ${constraints.minLength} characters.`
        };
      }
      return {
        valid: true,
        value: {
          ...EMPTY_VALUE,
          text,
          search: normalizeSearchText(text),
          canonical: text
        }
      };
    }

    case "integer":
    case "decimal": {
      const integerOnly = valueType === "integer";
      let source: string;
      if (typeof raw === "string") {
        source = raw;
      } else if (typeof raw === "number" && integerOnly) {
        // A JSON number is only trusted for an integer, and only when it is
        // an exactly-representable one. A decimal arrives as a STRING: a JSON
        // `0.1` is already a float by the time it reaches the parser.
        if (!Number.isSafeInteger(raw)) {
          return {
            valid: false,
            message: "must be a safe whole number."
          };
        }
        source = String(raw);
      } else {
        return {
          valid: false,
          message: integerOnly
            ? "must be a whole number."
            : "must be a decimal number sent as a string."
        };
      }

      const scale = constraints.scale ?? DEFAULT_DECIMAL_SCALE;
      const parsed = parseDecimalString(source, integerOnly, scale);
      if (!parsed.ok) return { valid: false, message: parsed.message };

      if (
        constraints.min !== undefined &&
        compareDecimal(parsed.canonical, constraints.min) < 0
      ) {
        return {
          valid: false,
          message: `must be at least ${constraints.min}.`
        };
      }
      if (
        constraints.max !== undefined &&
        compareDecimal(parsed.canonical, constraints.max) > 0
      ) {
        return { valid: false, message: `must be at most ${constraints.max}.` };
      }

      return {
        valid: true,
        value: {
          ...EMPTY_VALUE,
          numeric: parsed.canonical,
          scaled: scaledDecimal(parsed.canonical).toString(),
          canonical: parsed.canonical
        }
      };
    }

    case "boolean": {
      let flag: boolean | null = null;
      if (typeof raw === "boolean") flag = raw;
      else if (typeof raw === "string") {
        const lowered = raw.trim().toLowerCase();
        if (lowered === "true") flag = true;
        else if (lowered === "false") flag = false;
      }
      if (flag === null) {
        return { valid: false, message: 'must be "true" or "false".' };
      }
      return {
        valid: true,
        value: {
          ...EMPTY_VALUE,
          boolean: flag,
          canonical: flag ? "true" : "false"
        }
      };
    }

    case "date": {
      if (typeof raw !== "string") {
        return { valid: false, message: "must be a YYYY-MM-DD date string." };
      }
      const date = raw.trim();
      if (!isCalendarDate(date)) {
        return {
          valid: false,
          message: "must be a real calendar date written as YYYY-MM-DD."
        };
      }
      // ISO dates compare correctly as plain strings.
      if (constraints.min !== undefined && date < constraints.min) {
        return {
          valid: false,
          message: `must be on or after ${constraints.min}.`
        };
      }
      if (constraints.max !== undefined && date > constraints.max) {
        return {
          valid: false,
          message: `must be on or before ${constraints.max}.`
        };
      }
      return {
        valid: true,
        value: { ...EMPTY_VALUE, date, canonical: date }
      };
    }

    case "enum": {
      if (typeof raw !== "string") {
        return { valid: false, message: "must be one of the allowed options." };
      }
      const candidate = raw.trim();
      const options = constraints.options ?? [];
      if (!options.some((option) => option.value === candidate)) {
        return {
          valid: false,
          message: `must be one of: ${options.map((option) => option.value).join(", ")}.`
        };
      }
      return {
        valid: true,
        value: {
          ...EMPTY_VALUE,
          text: candidate,
          search: normalizeSearchText(candidate),
          canonical: candidate
        }
      };
    }
  }
}

/** Calendar-date validity, exported for `attribute-definition.ts`'s `min`/`max` checks. */
export function isIsoCalendarDate(value: string): boolean {
  return isCalendarDate(value);
}

/**
 * A stored row (as read back from the database) in the typed columns — the
 * input of {@link attributeWireValue}/{@link attributeCanonicalValue}.
 */
export type StoredAttributeColumns = {
  valueText: string | null;
  /** `value_scaled::text` — the integer `value x 10^6`. */
  valueScaled: string | null;
  valueBoolean: boolean | null;
  valueDate: string | null;
};

/**
 * Turns the stored `value_scaled` integer (as text, e.g. `"1500000"`) back into
 * the canonical decimal string (`"1.5"`) `parseAttributeValue` produced — the
 * exact inverse of {@link scaledDecimal}, by digit manipulation (no float, no
 * division), so the wire and the CSV always show the canonical form.
 */
export function canonicalFromScaled(stored: string): string {
  const negative = stored.startsWith("-");
  const digits = (negative ? stored.slice(1) : stored).padStart(
    SCALE_FACTOR_DIGITS + 1,
    "0"
  );
  const integer = digits.slice(0, digits.length - SCALE_FACTOR_DIGITS);
  const fraction = digits
    .slice(digits.length - SCALE_FACTOR_DIGITS)
    .replace(/0+$/, "");
  const body = fraction.length > 0 ? `${integer}.${fraction}` : integer;
  return negative && body !== "0" ? `-${body}` : body;
}

/** The canonical string of a stored value — the CSV cell, and the equality key for "unchanged". */
export function attributeCanonicalValue(
  valueType: AttributeValueType,
  stored: StoredAttributeColumns
): string | null {
  switch (valueType) {
    case "text":
    case "enum":
      return stored.valueText;
    case "integer":
    case "decimal":
      return stored.valueScaled === null
        ? null
        : canonicalFromScaled(stored.valueScaled);
    case "boolean":
      return stored.valueBoolean === null
        ? null
        : stored.valueBoolean
          ? "true"
          : "false";
    case "date":
      return stored.valueDate;
  }
}

/**
 * The JSON wire value: `integer` is a JSON number (always exactly
 * representable — see the grammar above), `decimal` stays a STRING (never a
 * float, ADR-0003's rule applied to every exact numeric), `boolean` a JSON
 * boolean, the rest strings.
 */
export function attributeWireValue(
  valueType: AttributeValueType,
  stored: StoredAttributeColumns
): string | number | boolean | null {
  const canonical = attributeCanonicalValue(valueType, stored);
  if (canonical === null) return null;
  switch (valueType) {
    case "integer":
      return Number(canonical);
    case "boolean":
      return canonical === "true";
    default:
      return canonical;
  }
}
