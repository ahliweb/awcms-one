/** Stage 4 helpers: Kecamatan titles and Kemendagri district codes. Pure, no I/O. */
import { normalizeName } from "./names";
import type { Region } from "./regions";

export interface DistrictRegion {
  code: string;
  name: string;
}

/** Districts ('NN.NN.NN') of one regency from wilayah.sql. */
export function parseDistricts(sql: string, regencyCode: string): DistrictRegion[] {
  const out: DistrictRegion[] = [];
  const prefix = `${regencyCode}.`;
  for (const m of sql.matchAll(/\('(\d{2}\.\d{2}\.\d{2})','((?:[^']|'')*)'\)/g)) {
    if (m[1]!.startsWith(prefix)) out.push({ code: m[1]!, name: m[2]!.replace(/''/g, "'") });
  }
  return out;
}

/** "Kecamatan Pahandut Dalam Angka 2026" -> { name: "Pahandut", year: 2026 }; anything else -> null. */
export function parseKecamatanTitle(title: string): { name: string; year: number } | null {
  const m = /^\s*Kecamatan\s+(.+?)\s+Dalam\s+Angka\s+(\d{4})\s*$/i.exec(title);
  return m ? { name: m[1]!.trim(), year: Number(m[2]) } : null;
}

export type DistrictMatch =
  | { kind: "matched"; region: DistrictRegion }
  | { kind: "ambiguous"; candidates: DistrictRegion[] }
  | { kind: "unmatched" };

/** Name match scoped to one regency's districts. Never guesses between two candidates. */
export function matchDistrict(name: string, districts: DistrictRegion[]): DistrictMatch {
  const key = normalizeName(name.replace(/^\s*kecamatan\b/i, ""));
  const hits = districts.filter((d) => normalizeName(d.name.replace(/^\s*kecamatan\b/i, "")) === key);
  if (hits.length === 1) return { kind: "matched", region: hits[0]! };
  if (hits.length > 1) return { kind: "ambiguous", candidates: hits };
  return { kind: "unmatched" };
}

export function districtPdfName(code: string, year: number): string {
  return `${code}-${year}.pdf`;
}

export type { Region };
