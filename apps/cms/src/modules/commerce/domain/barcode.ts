/**
 * Barcode identity, symbology encoding and label layout for `commerce`
 * (Issue #292, epic #281; ADR-0032). Pure - no database, no I/O, no DOM - so it
 * is unit-testable, and so the SAME code validates a barcode on the server and
 * can render the same bars on a printed label.
 *
 * ## A barcode is an identifier, never a credential
 *
 * It names a catalogue row (a product or a variant) and nothing else. Every
 * route that resolves one authorises the CALLER first (`commerce.barcodes.*`)
 * and scopes the lookup to the caller's tenant under FORCE RLS; the string
 * itself grants nothing (ADR-0032 D1).
 *
 * ## What a code may be
 *
 * 1-48 printable ASCII characters, no spaces (0x21-0x7E) - the Code 128 subset
 * B repertoire a keyboard-wedge scanner can type back verbatim. It must not
 * look like the POS scan field's quantity-multiplier prefix (`<n>*`), or the
 * scan parser could never tell `3*ABC` (three of ABC) from a code called
 * `3*ABC`.
 *
 * ## Symbology is DERIVED, never stored
 *
 * - an all-digit code of length 8, 12, 13 or 14 is a GTIN: its GS1 check digit
 *   is validated (a wrong one is rejected, not "fixed" - a mistyped digit would
 *   otherwise print a label no scanner trusts). Printed as EAN-8 (8), EAN-13
 *   (13) or UPC-A as EAN-13 with a leading zero (12); GTIN-14 is printed as
 *   Code 128 (ITF-14 is a carton symbology whose bearer-bar rules this module
 *   does not take on);
 * - anything else is a free internal code, printed as Code 128 (set C for an
 *   even run of digits - half the width - otherwise set B).
 */

export type BarcodeSymbology = "ean13" | "ean8" | "upca" | "gtin14" | "code128";

export const BARCODE_MAX_LENGTH = 48;
const BARCODE_PATTERN = /^[\x21-\x7E]{1,48}$/;
/** The scan field's quantity-multiplier prefix; a stored code may not start like one. */
const QUANTITY_PREFIX_PATTERN = /^\d{1,3}\*/;

export type BarcodeValidation =
  | { valid: true; code: string; symbology: BarcodeSymbology }
  | { valid: false; reason: BarcodeInvalidReason };

export type BarcodeInvalidReason =
  | "empty"
  | "too_long"
  | "bad_characters"
  | "quantity_prefix"
  | "bad_check_digit";

/** GS1 mod-10 check digit for the digits BEFORE the check digit (1-based from the right, weights 3,1,3,...). */
export function gtinCheckDigit(bodyDigits: string): number {
  if (!/^\d+$/.test(bodyDigits)) {
    throw new Error("gtinCheckDigit: digits only.");
  }
  let sum = 0;
  for (let i = 0; i < bodyDigits.length; i += 1) {
    const digit = bodyDigits.charCodeAt(bodyDigits.length - 1 - i) - 48;
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/** `true` when `code` is 8/12/13/14 digits ending in a correct GS1 check digit. */
export function isValidGtin(code: string): boolean {
  if (!/^\d+$/.test(code)) return false;
  if (![8, 12, 13, 14].includes(code.length)) return false;
  return (
    gtinCheckDigit(code.slice(0, -1)) === code.charCodeAt(code.length - 1) - 48
  );
}

function gtinSymbology(code: string): BarcodeSymbology | null {
  if (!/^\d+$/.test(code)) return null;
  switch (code.length) {
    case 8:
      return "ean8";
    case 12:
      return "upca";
    case 13:
      return "ean13";
    case 14:
      return "gtin14";
    default:
      return null;
  }
}

/**
 * Validates an operator-entered barcode (it is trimmed first; a scanner never
 * sends surrounding whitespace). A numeric 8/12/13/14-digit code is by
 * definition a GTIN and MUST carry a valid check digit.
 */
export function validateBarcode(input: unknown): BarcodeValidation {
  if (typeof input !== "string") return { valid: false, reason: "empty" };
  const code = input.trim();
  if (code.length === 0) return { valid: false, reason: "empty" };
  if (code.length > BARCODE_MAX_LENGTH) {
    return { valid: false, reason: "too_long" };
  }
  if (!BARCODE_PATTERN.test(code)) {
    return { valid: false, reason: "bad_characters" };
  }
  if (QUANTITY_PREFIX_PATTERN.test(code)) {
    return { valid: false, reason: "quantity_prefix" };
  }
  const gtin = gtinSymbology(code);
  if (gtin) {
    if (!isValidGtin(code)) return { valid: false, reason: "bad_check_digit" };
    return { valid: true, code, symbology: gtin };
  }
  return { valid: true, code, symbology: "code128" };
}

/** A human message for a rejection, English (the API's wire language). */
export function barcodeInvalidMessage(reason: BarcodeInvalidReason): string {
  switch (reason) {
    case "empty":
      return "barcode must be a non-empty string.";
    case "too_long":
      return `barcode must be at most ${BARCODE_MAX_LENGTH} characters.`;
    case "bad_characters":
      return "barcode may only contain printable ASCII characters without spaces.";
    case "quantity_prefix":
      return 'barcode may not start with a quantity prefix like "3*" (the POS scan field reads that as a multiplier).';
    case "bad_check_digit":
      return "an 8, 12, 13 or 14 digit numeric barcode is a GTIN and needs a valid check digit; add a letter prefix for an internal code.";
  }
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** One encoded symbol: a string of `0`/`1` modules (`1` = bar), without quiet zones. */
export type EncodedBarcode = {
  symbology: BarcodeSymbology;
  /** What the human-readable line under the bars says. */
  text: string;
  modules: string;
  /** Quiet zone width in modules, each side, per the symbology. */
  quietZone: { left: number; right: number };
};

// Code 128: bar/space widths of symbols 0-106 (106 = stop, 7 elements).
const CODE128_PATTERNS: readonly string[] = [
  "212222",
  "222122",
  "222221",
  "121223",
  "121322",
  "131222",
  "122213",
  "122312",
  "132212",
  "221213",
  "221312",
  "231212",
  "112232",
  "122132",
  "122231",
  "113222",
  "123122",
  "123221",
  "223211",
  "221132",
  "221231",
  "213212",
  "223112",
  "312131",
  "311222",
  "321122",
  "321221",
  "312212",
  "322112",
  "322211",
  "212123",
  "212321",
  "232121",
  "111323",
  "131123",
  "131321",
  "112313",
  "132113",
  "132311",
  "211313",
  "231113",
  "231311",
  "112133",
  "112331",
  "132131",
  "113123",
  "113321",
  "133121",
  "313121",
  "211331",
  "231131",
  "213113",
  "213311",
  "213131",
  "311123",
  "311321",
  "331121",
  "312113",
  "312311",
  "332111",
  "314111",
  "221411",
  "431111",
  "111224",
  "111422",
  "121124",
  "121421",
  "141122",
  "141221",
  "112214",
  "112412",
  "122114",
  "122411",
  "142112",
  "142211",
  "241211",
  "221114",
  "413111",
  "241112",
  "134111",
  "111242",
  "121142",
  "121241",
  "114212",
  "124112",
  "124211",
  "411212",
  "421112",
  "421211",
  "212141",
  "214121",
  "412121",
  "111143",
  "111341",
  "131141",
  "114113",
  "114311",
  "411113",
  "411311",
  "113141",
  "114131",
  "311141",
  "411131",
  "211412",
  "211214",
  "211232",
  "2331112"
];

export const CODE128_SYMBOL_PATTERNS = CODE128_PATTERNS;

const CODE128_START_B = 104;
const CODE128_START_C = 105;
const CODE128_STOP = 106;

function widthsToModules(widths: string): string {
  let out = "";
  let bar = true;
  for (const char of widths) {
    out += (bar ? "1" : "0").repeat(char.charCodeAt(0) - 48);
    bar = !bar;
  }
  return out;
}

/** Code 128 symbol values for `code` (start, data, checksum, stop). */
export function code128Symbols(code: string): number[] {
  if (!BARCODE_PATTERN.test(code)) {
    throw new Error("code128Symbols: unsupported characters.");
  }
  const values: number[] = [];
  if (/^\d+$/.test(code) && code.length >= 4 && code.length % 2 === 0) {
    values.push(CODE128_START_C);
    for (let i = 0; i < code.length; i += 2) {
      values.push(Number.parseInt(code.slice(i, i + 2), 10));
    }
  } else {
    values.push(CODE128_START_B);
    for (const char of code) values.push(char.charCodeAt(0) - 32);
  }
  let checksum = values[0]!;
  for (let i = 1; i < values.length; i += 1) checksum += values[i]! * i;
  values.push(checksum % 103);
  values.push(CODE128_STOP);
  return values;
}

function encodeCode128(code: string): EncodedBarcode {
  const modules = code128Symbols(code)
    .map((value) => widthsToModules(CODE128_PATTERNS[value]!))
    .join("");
  return {
    symbology: "code128",
    text: code,
    modules,
    quietZone: { left: 10, right: 10 }
  };
}

const EAN_L = [
  "0001101",
  "0011001",
  "0010011",
  "0111101",
  "0100011",
  "0110001",
  "0101111",
  "0111011",
  "0110111",
  "0001011"
] as const;
const EAN_G = [
  "0100111",
  "0110011",
  "0011011",
  "0100001",
  "0011101",
  "0111001",
  "0000101",
  "0010001",
  "0001001",
  "0010111"
] as const;
const EAN_R = EAN_L.map((pattern) =>
  [...pattern].map((bit) => (bit === "1" ? "0" : "1")).join("")
);
/** Left-half parity per leading digit, EAN-13. */
const EAN13_PARITY = [
  "LLLLLL",
  "LLGLGG",
  "LLGGLG",
  "LLGGGL",
  "LGLLGG",
  "LGGLLG",
  "LGGGLL",
  "LGLGLG",
  "LGLGGL",
  "LGGLGL"
] as const;

function encodeEan13(digits13: string, text: string): EncodedBarcode {
  const first = digits13.charCodeAt(0) - 48;
  const parity = EAN13_PARITY[first]!;
  let modules = "101";
  for (let i = 0; i < 6; i += 1) {
    const digit = digits13.charCodeAt(i + 1) - 48;
    modules += parity[i] === "L" ? EAN_L[digit]! : EAN_G[digit]!;
  }
  modules += "01010";
  for (let i = 7; i < 13; i += 1) {
    modules += EAN_R[digits13.charCodeAt(i) - 48]!;
  }
  modules += "101";
  return {
    symbology: "ean13",
    text,
    modules,
    quietZone: { left: 11, right: 7 }
  };
}

function encodeEan8(digits8: string): EncodedBarcode {
  let modules = "101";
  for (let i = 0; i < 4; i += 1) modules += EAN_L[digits8.charCodeAt(i) - 48]!;
  modules += "01010";
  for (let i = 4; i < 8; i += 1) modules += EAN_R[digits8.charCodeAt(i) - 48]!;
  modules += "101";
  return {
    symbology: "ean8",
    text: digits8,
    modules,
    quietZone: { left: 7, right: 7 }
  };
}

/**
 * Encodes a VALID barcode (call `validateBarcode` first) into modules.
 * UPC-A is printed as EAN-13 with a leading zero - every EAN-13 reader reads
 * that as the same GTIN-12 - but the human-readable text stays the 12 digits
 * the operator typed.
 */
export function encodeBarcode(code: string): EncodedBarcode {
  const checked = validateBarcode(code);
  if (!checked.valid) {
    throw new Error(`encodeBarcode: ${barcodeInvalidMessage(checked.reason)}`);
  }
  switch (checked.symbology) {
    case "ean13":
      return encodeEan13(checked.code, checked.code);
    case "upca":
      return { ...encodeEan13(`0${checked.code}`, checked.code) };
    case "ean8":
      return encodeEan8(checked.code);
    default:
      return encodeCode128(checked.code);
  }
}

/**
 * The bars as an inline SVG string. It contains ONLY numbers (one `<path>` of
 * run-length rectangles), never tenant text - the human-readable line is
 * rendered by the caller as ordinary escaped markup - so embedding it with
 * `set:html` cannot inject anything (ADR-0032 D4). `preserveAspectRatio="none"`
 * lets the label's CSS stretch the bars to the label height while the module
 * widths stay proportional to the width.
 */
export function renderBarcodeSvg(encoded: EncodedBarcode): string {
  const { modules, quietZone } = encoded;
  const width = quietZone.left + modules.length + quietZone.right;
  let path = "";
  let index = 0;
  while (index < modules.length) {
    if (modules[index] === "1") {
      let end = index;
      while (end < modules.length && modules[end] === "1") end += 1;
      path += `M${quietZone.left + index} 0h${end - index}v1h-${end - index}z`;
      index = end;
    } else {
      index += 1;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 1" ` +
    `preserveAspectRatio="none" shape-rendering="crispEdges" role="img" ` +
    `aria-hidden="true" focusable="false"><path d="${path}"/></svg>`
  );
}

// ---------------------------------------------------------------------------
// Label sheet options
// ---------------------------------------------------------------------------

export type LabelSheetOptions = {
  columns: number;
  copies: number;
  widthMm: number;
  heightMm: number;
  showName: boolean;
  showPrice: boolean;
  showSku: boolean;
};

export const DEFAULT_LABEL_SHEET_OPTIONS: LabelSheetOptions = {
  columns: 3,
  copies: 1,
  widthMm: 60,
  heightMm: 30,
  showName: true,
  showPrice: true,
  showSku: false
};

export const LABEL_LIMITS = {
  columns: { min: 1, max: 6 },
  copies: { min: 1, max: 50 },
  widthMm: { min: 25, max: 100 },
  heightMm: { min: 15, max: 60 },
  /** Hard ceiling on labels in one render, so a batch can never be a resource attack. */
  maxLabels: 500,
  maxItems: 100
} as const;

function intParam(
  raw: string | null | undefined,
  fallback: number,
  limits: { min: number; max: number }
): number {
  if (raw === null || raw === undefined || raw === "") return fallback;
  if (!/^\d{1,4}$/.test(raw)) return fallback;
  const value = Number.parseInt(raw, 10);
  return Math.min(limits.max, Math.max(limits.min, value));
}

function flagParam(raw: string | null | undefined, fallback: boolean): boolean {
  if (raw === "1" || raw === "true" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "off") return false;
  return fallback;
}

/**
 * Reads the label layout from a query string. Never throws: every number is
 * clamped into {@link LABEL_LIMITS} and an unreadable value falls back to its
 * default, so a hand-edited URL can only ever produce a sane sheet. `show*`
 * flags are only honoured when the form was submitted (`submitted`), because
 * an unchecked checkbox sends nothing at all.
 */
export function parseLabelSheetOptions(
  params: URLSearchParams
): LabelSheetOptions {
  const submitted = params.get("layout") === "1";
  const defaults = DEFAULT_LABEL_SHEET_OPTIONS;
  return {
    columns: intParam(
      params.get("columns"),
      defaults.columns,
      LABEL_LIMITS.columns
    ),
    copies: intParam(
      params.get("copies"),
      defaults.copies,
      LABEL_LIMITS.copies
    ),
    widthMm: intParam(
      params.get("widthMm"),
      defaults.widthMm,
      LABEL_LIMITS.widthMm
    ),
    heightMm: intParam(
      params.get("heightMm"),
      defaults.heightMm,
      LABEL_LIMITS.heightMm
    ),
    showName: submitted
      ? flagParam(params.get("showName"), false)
      : defaults.showName,
    showPrice: submitted
      ? flagParam(params.get("showPrice"), false)
      : defaults.showPrice,
    showSku: submitted
      ? flagParam(params.get("showSku"), false)
      : defaults.showSku
  };
}

/** Number of labels `itemCount` items would print, capped at {@link LABEL_LIMITS.maxLabels}. */
export function plannedLabelCount(
  itemCount: number,
  options: LabelSheetOptions
): number {
  return Math.min(LABEL_LIMITS.maxLabels, itemCount * options.copies);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Which catalogue row a barcode (or a label) belongs to. */
export type BarcodeTarget = { productId: string; variantId: string | null };

export function isBarcodeTarget(value: unknown): value is BarcodeTarget {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.productId === "string" &&
    UUID_PATTERN.test(record.productId) &&
    (record.variantId === null ||
      (typeof record.variantId === "string" &&
        UUID_PATTERN.test(record.variantId)))
  );
}

export type AssignBarcodeInput = {
  target: BarcodeTarget;
  /** `null` clears the barcode. */
  code: string | null;
};

export type ValidationError = { field: string; message: string };

export function validateAssignBarcodeInput(
  body: unknown
):
  | { valid: true; value: AssignBarcodeInput }
  | { valid: false; errors: ValidationError[] } {
  const record =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : {};
  const errors: ValidationError[] = [];
  const productId = record.productId;
  const variantId = record.variantId ?? null;
  if (typeof productId !== "string" || !UUID_PATTERN.test(productId)) {
    errors.push({ field: "productId", message: "productId must be a UUID." });
  }
  if (
    variantId !== null &&
    (typeof variantId !== "string" || !UUID_PATTERN.test(variantId))
  ) {
    errors.push({
      field: "variantId",
      message: "variantId must be a UUID or null."
    });
  }
  let code: string | null = null;
  if (record.barcode === undefined) {
    errors.push({
      field: "barcode",
      message: "barcode is required (a string, or null to clear it)."
    });
  } else if (record.barcode !== null) {
    const checked = validateBarcode(record.barcode);
    if (!checked.valid) {
      errors.push({
        field: "barcode",
        message: barcodeInvalidMessage(checked.reason)
      });
    } else {
      code = checked.code;
    }
  }
  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: {
      target: {
        productId: productId as string,
        variantId: (variantId as string | null) ?? null
      },
      code
    }
  };
}

/**
 * Parses the `ids` of a label request: a comma-separated list of
 * `<productId>` or `<productId>:<variantId>` targets. Malformed or surplus
 * entries are dropped (never an error - the page must still render).
 */
export function parseLabelTargets(raw: string | null): BarcodeTarget[] {
  if (!raw) return [];
  const targets: BarcodeTarget[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const [productId, variantId = null] = part.trim().split(":");
    const target = { productId: productId ?? "", variantId };
    if (!isBarcodeTarget(target)) continue;
    const key = `${target.productId}:${target.variantId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      productId: target.productId.toLowerCase(),
      variantId: target.variantId ? target.variantId.toLowerCase() : null
    });
    if (targets.length >= LABEL_LIMITS.maxItems) break;
  }
  return targets;
}
