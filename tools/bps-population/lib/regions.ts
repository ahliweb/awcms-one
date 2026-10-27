/** Matching BPS office names to Kemendagri region codes (read-only against cahyadsn wilayah.sql). */
import { coreName, normalizeName, officeTypeOf, type OfficeLevel } from "./names";

export interface Region {
  code: string;
  name: string;
}

/** Province (2-segment-free) and regency/city rows of wilayah.sql: codes 'NN' and 'NN.NN'. */
export function parseWilayah(sql: string): Region[] {
  const out: Region[] = [];
  for (const m of sql.matchAll(/\('(\d{2}(?:\.\d{2})?)','((?:[^']|'')*)'\)/g)) {
    out.push({ code: m[1]!, name: m[2]!.replace(/''/g, "'") });
  }
  return out;
}

/**
 * Documented name equivalences between BPS spellings and Kemendagri's: abbreviations and official renames.
 * Applied to both sides before comparing; every entry is a same-entity pair, not a guess.
 */
const ALIASES: Array<[RegExp, string]> = [
  [/\bkep(?:\.|ulauan)?\s+siau\b/gi, "siau"], // BPS "Siau Tagulandang Biaro" = Kemendagri "Kep. Siau Tagulandang Biaro" (71.09)
  [/\bkep\.\s*/gi, "kepulauan "], // "Kep. Riau" = "Kepulauan Riau"
  [/\bdki\b/gi, "daerah khusus ibukota"],
  [/\bdi yogyakarta\b/gi, "daerah istimewa yogyakarta"],
  [/\bmahakam hulu\b/gi, "mahakam ulu"], // same regency (64.11), two spellings
  [/\bmaluku tenggara barat\b/gi, "kepulauan tanimbar"], // renamed 2020 (Permendagri; same regency)
];

function aliased(name: string): string {
  return ALIASES.reduce((n, [re, to]) => n.replace(re, to), name);
}

/** Key a Kemendagri region and a BPS office share: type word + core name. Provinces carry no type word. */
function regionKey(level: OfficeLevel, name: string): string {
  if (level === "province") return `p:${coreName(name)}`;
  const type = officeTypeOf(name) ?? "kabupaten";
  return `${type}:${coreName(name)}`;
}

export interface MatchResult {
  kemendagriCode: string | null;
  matchedName: string | null;
  how: "code+name" | "name" | "unmatched" | "ambiguous";
}

export function matchRegion(
  level: OfficeLevel,
  domain: string,
  bpsName: string,
  regions: Region[]
): MatchResult {
  const wanted = regionKey(level, aliased(bpsName));
  const byKey = regions.filter((r) => {
    const isProv = !r.code.includes(".");
    if (level === "province" ? !isProv : isProv) return false;
    return regionKey(level, aliased(r.name)) === wanted;
  });
  const dotted = level === "province" ? domain.slice(0, 2) : `${domain.slice(0, 2)}.${domain.slice(2)}`;
  const same = byKey.find((r) => r.code === dotted);
  if (same) return { kemendagriCode: same.code, matchedName: same.name, how: "code+name" };
  if (byKey.length === 1) return { kemendagriCode: byKey[0]!.code, matchedName: byKey[0]!.name, how: "name" };
  if (byKey.length > 1) return { kemendagriCode: null, matchedName: null, how: "ambiguous" };
  return { kemendagriCode: null, matchedName: null, how: "unmatched" };
}

export { normalizeName };
