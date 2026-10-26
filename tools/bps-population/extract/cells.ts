/**
 * Cell-text parsing. Indonesian number format: '.' is the thousands separator,
 * ',' the decimal mark. BPS nil symbols ('-', an en dash, '_') mean "none" and
 * become 0 with a `nil` note; '...' means "not available" and yields no row.
 */

export type CellKind = "num" | "nil" | "na" | "text";

export interface ParsedCell {
  kind: CellKind;
  /** Canonical decimal string for kind 'num' ('.' decimal, no separators), "0" for 'nil'. */
  value?: string;
  /** Number of decimals as published. */
  decimals?: number;
}

const NIL = /^[-–—_]+$/;
const NA = /^(\.{2,}|…+|x|X|\*+)$/;

/**
 * Parses a cell. Accepts "2.844,99", "14.243", "1467,14" (a separator-less
 * thousands group does occur in the printed provincial total row),
 * "1 483,00" (a space as thousands separator), "0,5", "75". Returns text for
 * anything else. Never rounds or rescales: the digits are the published digits.
 */
export function parseCell(raw: string): ParsedCell {
  const s = raw.replace(/ /g, " ").trim();
  if (s === "") return { kind: "text" };
  if (NIL.test(s)) return { kind: "nil", value: "0", decimals: 0 };
  if (NA.test(s)) return { kind: "na" };
  // thousands groups separated by '.', optionally by one space; decimal ','
  const grouped = /^(\d{1,3})((?:[. ]\d{3})+)(?:,(\d+))?$/.exec(s);
  if (grouped) {
    const int = grouped[1]! + grouped[2]!.replace(/[. ]/g, "");
    return numeric(int, grouped[3]);
  }
  const plain = /^(\d+)(?:,(\d+))?$/.exec(s);
  if (plain) return numeric(plain[1]!, plain[2]);
  return { kind: "text" };
}

function numeric(int: string, frac: string | undefined): ParsedCell {
  const intNorm = int.replace(/^0+(?=\d)/, "");
  return frac === undefined
    ? { kind: "num", value: intNorm, decimals: 0 }
    : { kind: "num", value: `${intNorm}.${frac}`, decimals: frac.length };
}

/** True for a token that can only be part of a numeric cell. */
export function isCellToken(text: string): boolean {
  return parseCell(text).kind !== "text";
}

/** True for a row index such as "1." / "14." / "010." that prefixes a region label. */
export function isIndexToken(text: string): boolean {
  return /^\d{1,3}\.$/.test(text);
}

/** BPS age band as printed ("0–4", "5-9", "75+", "60+", "75 +") -> contract key ("0-4", "75+"). */
export function ageBandKey(label: string): string | null {
  const s = label.replace(/\s+/g, "").replace(/[–—]/g, "-");
  const range = /^(\d{1,3})-(\d{1,3})(?:tahun)?$/i.exec(s);
  if (range) return `${Number(range[1])}-${Number(range[2])}`;
  const open = /^(\d{1,3})\+$/.exec(s) ?? /^(\d{1,3})(?:tahun)?(?:keatas|lebih)$/i.exec(s);
  if (open) return `${Number(open[1])}+`;
  return null;
}

/** snake_case of an Indonesian label: ASCII letters/digits and underscores only. */
export function snakeCase(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " dan ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Splits a bilingual "Indonesian/English" label at the first '/' that is
 * followed by an upper-case letter or digit ("Ikan/udang/cumi/kerang/Fish/shrimp"
 * -> "Ikan/udang/cumi/kerang"). Labels with no such slash are returned whole.
 */
export function indonesianPart(label: string): string {
  const m = /\/(?=[A-Z0-9])/.exec(label);
  return (m ? label.slice(0, m.index) : label).trim();
}
