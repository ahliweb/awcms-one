/**
 * Publication metadata: what the PDF's own front matter says (catalogue, ISSN,
 * publication number, publisher, the copyright sentence verbatim) plus what the
 * crawl state knows (page URL, release date, host).
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

export interface StateRecord {
  domain: string;
  name?: string;
  host?: string;
  status?: string;
  foundYear?: number | null;
  targetYear?: number;
  title?: string | null;
  pageUrl?: string | null;
  releaseDate?: string | null;
  catalogueNumber?: string | null;
  publicationNumber?: string | null;
  issn?: string | null;
  pdfFile?: string | null;
  sha256?: string | null;
  bytes?: number | null;
}

export function cacheDir(env: Record<string, string | undefined> = process.env): string {
  return env.BPS_CACHE_DIR && env.BPS_CACHE_DIR !== "" ? env.BPS_CACHE_DIR : join(homedir(), ".cache", "awcms-bps-population");
}

export function loadStateRecords(dir = cacheDir()): StateRecord[] {
  const path = join(dir, "state.json");
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { offices?: Record<string, StateRecord> };
  return Object.values(parsed.offices ?? {});
}

export function findRecord(records: StateRecord[], domain: string, pdf: string): StateRecord | null {
  const base = basename(pdf);
  return (
    records.find((r) => r.domain === domain && r.pdfFile && basename(r.pdfFile) === base) ??
    records.find((r) => r.domain === domain && r.status === "done") ??
    null
  );
}

export interface FrontMatter {
  catalogueNumber: string | null;
  publicationNumber: string | null;
  issn: string | null;
  publisherName: string | null;
  termsOfUse: string | null;
  runningTitle: string | null;
  year: number | null;
}

/** Parses the text of the first pages of a publication (pure; fed by pdftotext output). */
export function parseFrontMatter(text: string): FrontMatter {
  const flat = text.replace(/\s+/g, " ");
  const cat = /Katalog\/Catalogue:\s*(\d[\d.]*\d)/.exec(flat);
  const pub = /Nomor Publikasi\/Publication Number:\s*(\d[\d.]*\d)/.exec(flat);
  const issn = /ISSN:?\s*(\d{4}-\d{3}[\dX])/.exec(flat);
  const publisher = /(?:Penerbit\/Publisher|Diterbitkan oleh\/Published by):?\s*©\s*(BPS[^/]*?)\s*\//.exec(flat);
  const terms = /(Dilarang (?:mereproduksi|mengumumkan).*?)(?=\s+It is prohibited|\s+It's prohibited|\s+Prohibited to|$)/.exec(flat);
  const running = /([A-Z][A-Z ]+?) DALAM ANGKA (20\d{2})/.exec(flat);
  return {
    catalogueNumber: cat?.[1] ?? null,
    publicationNumber: pub?.[1] ?? null,
    issn: issn?.[1] ?? null,
    publisherName: publisher?.[1]?.trim() ?? null,
    termsOfUse: terms?.[1]?.trim() ?? null,
    runningTitle: running ? `${running[1]} DALAM ANGKA ${running[2]}` : null,
    year: running ? Number(running[2]) : null,
  };
}

/** Refuse a district PDF when its readable cover names a different district. */
export function districtCoverMismatch(text: string, expectedName: string): string | null {
  const normalize = (name: string) => name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const titles = [...text.replace(/\s+/g, " ").matchAll(/\bKECAMATAN\s+([a-z -]{2,55}?)\s+DALAM\s+ANGKA\b/gi)]
    .map((match) => match[1]!.trim().replace(/^ht\s+tp\s+/i, ""))
    .filter((name) => !/^(?:x+|y+)$/.test(normalize(name)));
  if (titles.length === 0 || normalize(titles[0]!) === normalize(expectedName)) return null;
  return `PDF cover names Kecamatan ${titles[0]}, but the selected district is ${expectedName}`;
}

export async function frontMatterText(pdf: string, lastPage = 10): Promise<string> {
  const proc = Bun.spawn(["pdftotext", "-f", "1", "-l", String(lastPage), pdf, "-"], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`pdftotext failed for front matter of ${pdf}`);
  return out;
}

const SMALL = new Set(["dan", "di", "dalam", "of", "the"]);

/** "KOTA PALANGKA RAYA DALAM ANGKA 2026" -> "Kota Palangka Raya Dalam Angka 2026". */
export function titleCase(upper: string): string {
  return upper
    .toLowerCase()
    .split(" ")
    .map((w) => (SMALL.has(w) && w !== "dalam" ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/** Province domain '6200' -> '62'; regency/city '6271' -> '62.71'. */
export function coverageOfDomain(domain: string): string {
  if (!/^\d{4}$/.test(domain)) throw new Error(`domain must be four digits: ${domain}`);
  return domain.endsWith("00") ? domain.slice(0, 2) : `${domain.slice(0, 2)}.${domain.slice(2)}`;
}

export function attributionSentence(publisherName: string, website: string, title: string): string {
  return `Data diperoleh dari situs web resmi ${publisherName} (${website}), publikasi "${title}", yang dapat diunduh secara bebas oleh siapa pun.`;
}

export interface DistrictRecord extends StateRecord {
  /** Kemendagri dotted code of the kecamatan, e.g. "62.71.01". */
  districtCode: string;
}

/** Kecamatan entries of state.json (`districts`), normalised; tolerant of field naming. */
export function loadDistrictRecords(dir = cacheDir()): DistrictRecord[] {
  const path = join(dir, "state.json");
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { districts?: Record<string, Record<string, unknown>> };
  const out: DistrictRecord[] = [];
  for (const [key, raw] of Object.entries(parsed.districts ?? {})) {
    const str = (...names: string[]) => {
      for (const n of names) if (typeof raw[n] === "string" && raw[n] !== "") return raw[n] as string;
      return undefined;
    };
    const num = (...names: string[]) => {
      for (const n of names) if (typeof raw[n] === "number") return raw[n] as number;
      return undefined;
    };
    const code = str("districtCode", "kemendagriCode", "code") ?? key.split(":")[0]!;
    const compact = code.replace(/\./g, "");
    const dotted = /^\d{6}$/.test(compact) ? `${compact.slice(0, 2)}.${compact.slice(2, 4)}.${compact.slice(4, 6)}` : code;
    out.push({
      districtCode: dotted,
      domain: str("regencyDomain", "domain", "officeDomain", "parentDomain") ?? "",
      name: str("name"),
      host: str("host"),
      status: str("status"),
      foundYear: num("foundYear", "year"),
      targetYear: num("targetYear"),
      title: str("title") ?? null,
      pageUrl: str("pageUrl") ?? null,
      releaseDate: str("releaseDate") ?? null,
      catalogueNumber: str("catalogueNumber") ?? null,
      publicationNumber: str("publicationNumber") ?? null,
      issn: str("issn") ?? null,
      pdfFile: str("pdfFile") ?? null,
      sha256: str("sha256") ?? null,
    });
  }
  return out;
}
