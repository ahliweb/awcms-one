/**
 * Pure name helpers shared by discover.ts and fetch.ts. No I/O, no side effects
 * on import.
 */

export type OfficeLevel = "province" | "regency_city";

/** Lower-case ASCII letters and digits only: "Kota Palangka Raya" and "Kota Palangkaraya" collapse together. */
export function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export type OfficeType = "provinsi" | "kabupaten" | "kota";

/** The administrative type word a BPS name starts with, or null for a bare name. */
export function officeTypeOf(name: string): OfficeType | null {
  const m = /^\s*(provinsi|kabupaten|kota)\b/i.exec(name);
  return m ? (m[1]!.toLowerCase() as OfficeType) : null;
}

/** The name without its leading type word and without the word "Administrasi" (Jakarta). */
export function coreName(name: string): string {
  return normalizeName(
    name.replace(/^\s*(provinsi|kabupaten|kota)\b/i, "").replace(/\badministrasi\b/gi, "")
  );
}

/** Lower-case, hyphenated ASCII slug, as BPS builds it in a publication page URL. */
export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type TitleMatch = "strict" | "lenient" | null;

/**
 * Does a publication title name this office's "Dalam Angka <year>" edition?
 *
 * strict   : normalized title === normalized "<office name> Dalam Angka <year>"
 * lenient  : the title has the shape "<X> Dalam Angka <year>" where X has the same core name and a
 *            compatible type (bare, or equal). Kecamatan editions never match: their core name differs
 *            and "Kecamatan" is not a type this function accepts.
 */
export function matchTitle(title: string, officeName: string, year: number): TitleMatch {
  const suffix = new RegExp(`^(.*?)\\s+dalam\\s+angka\\s+${year}\\s*$`, "i");
  const m = suffix.exec(title.trim());
  if (!m) return null;
  const head = m[1]!;
  if (/^\s*kecamatan\b/i.test(head)) return null;
  if (normalizeName(head) === normalizeName(officeName)) return "strict";
  const headType = officeTypeOf(head);
  const officeType = officeTypeOf(officeName);
  if (headType && officeType && headType !== officeType) return null;
  return coreName(head) === coreName(officeName) && coreName(head) !== "" ? "lenient" : null;
}
