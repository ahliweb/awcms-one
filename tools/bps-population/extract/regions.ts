/**
 * Kemendagri region lookup against the vendored cahyadsn wilayah.sql. Matching
 * is scoped (a table row is only ever compared with the children of the region
 * the publication covers), code-first and then by normalised name. A label that
 * matches more than one sibling is reported as ambiguous and never guessed -
 * Indonesia has sibling pairs that share a name (Kabupaten X / Kota X), so the
 * "Kabupaten/Regency" and "Kota/Municipality" group lines of a BPS table are
 * carried as a kind hint.
 */

export interface RegionRow {
  code: string;
  name: string;
}

export type KindHint = "kabupaten" | "kota" | null;

export interface RegionIndex {
  byCode: Map<string, RegionRow>;
  childrenOf: Map<string, RegionRow[]>;
}

export function parseWilayahSql(sql: string): RegionRow[] {
  const out: RegionRow[] = [];
  for (const m of sql.matchAll(/\('(\d{2}(?:\.\d{2}(?:\.\d{2}(?:\.\d{4})?)?)?)','((?:[^']|'')*)'\)/g)) {
    out.push({ code: m[1]!, name: m[2]!.replace(/''/g, "'") });
  }
  return out;
}

export function buildIndex(rows: RegionRow[]): RegionIndex {
  const byCode = new Map<string, RegionRow>();
  const childrenOf = new Map<string, RegionRow[]>();
  for (const r of rows) {
    byCode.set(r.code, r);
    const parent = parentCode(r.code);
    if (parent) {
      const list = childrenOf.get(parent) ?? [];
      list.push(r);
      childrenOf.set(parent, list);
    }
  }
  return { byCode, childrenOf };
}

export function parentCode(code: string): string | null {
  const i = code.lastIndexOf(".");
  return i < 0 ? null : code.slice(0, i);
}

export function levelOfCode(code: string): number {
  return code.split(".").length;
}

/** Letters and digits only, lower-case, accents removed; apostrophes (straight or typographic) vanish. */
export function normalizeLabel(value: string): string {
  return value
    .replace(/\bgn\.\s*/gi, "gunung ")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

const TYPE_PREFIX = /^\s*(kabupaten|kab\.?|kota administrasi|kota|kecamatan|kec\.?|kelurahan|kel\.?|desa)\s+/i;

export function typeOfName(name: string): KindHint | "other" {
  const m = /^\s*(kabupaten|kab\.?|kota)\b/i.exec(name);
  if (!m) return null;
  return m[1]!.toLowerCase().startsWith("kab") ? "kabupaten" : "kota";
}

export function coreLabel(name: string): string {
  return normalizeLabel(name.replace(TYPE_PREFIX, ""));
}

export interface Resolution {
  code: string | null;
  name: string | null;
  status: "ok" | "ambiguous" | "unmatched";
  candidates: string[];
}

const GROUP_LINE = /^(kabupaten|kota)\s*\/\s*(regency|municipality|city)$/i;

/** Recognises the "Kabupaten/Regency" and "Kota/Municipality" group lines. */
export function kindFromGroupLine(label: string): KindHint | undefined {
  const m = GROUP_LINE.exec(label.trim());
  if (!m) return undefined;
  return m[1]!.toLowerCase() === "kabupaten" ? "kabupaten" : "kota";
}

/**
 * Resolves a printed row label against the children of `parent` (or against
 * `parent` itself when the label names the coverage region, i.e. a total row).
 */
export function resolveLabel(
  index: RegionIndex,
  parent: string,
  rawLabel: string,
  hint: KindHint = null,
  isTotalRow = true
): Resolution {
  const hadIndex = /^\s*\d{1,3}\.\s*/.test(rawLabel);
  const label = rawLabel.replace(/^\s*\d{1,3}\.\s*/, "").replace(/(?<=\p{L})\d{1,2}$/u, "").trim();
  const dotted = /(\d{2}(?:\.\d{2}(?:\.\d{2}(?:\.\d{4})?)?)?)/.exec(label);
  if (dotted && index.byCode.has(dotted[1]!) && dotted[1]!.startsWith(parent)) {
    const r = index.byCode.get(dotted[1]!)!;
    return { code: r.code, name: r.name, status: "ok", candidates: [r.code] };
  }
  const children = index.childrenOf.get(parent) ?? [];
  const selfRow = index.byCode.get(parent);
  const selfMatches =
    selfRow !== undefined && (normalizeLabel(selfRow.name) === normalizeLabel(label) || coreLabel(selfRow.name) === coreLabel(label));
  // A total row carries no index prefix; it names the covered region itself.
  if (selfRow && selfMatches && !hadIndex && isTotalRow) return { code: selfRow.code, name: selfRow.name, status: "ok", candidates: [selfRow.code] };
  const wantFull = normalizeLabel(label);
  const wantCore = coreLabel(label);
  const explicit = typeOfName(label);
  let found = children.filter((c) => normalizeLabel(c.name) === wantFull);
  if (found.length === 0) found = children.filter((c) => coreLabel(c.name) === wantCore);
  if (found.length > 1) {
    const kind = explicit ?? hint;
    if (kind) {
      const narrowed = found.filter((c) => typeOfName(c.name) === kind);
      if (narrowed.length > 0) found = narrowed;
    }
  }
  if (found.length === 1) return { code: found[0]!.code, name: found[0]!.name, status: "ok", candidates: [found[0]!.code] };
  if (found.length > 1) return { code: null, name: null, status: "ambiguous", candidates: found.map((c) => c.code) };
  if (selfRow && selfMatches && isTotalRow) return { code: selfRow.code, name: selfRow.name, status: "ok", candidates: [selfRow.code] };
  return { code: null, name: null, status: "unmatched", candidates: [] };
}
