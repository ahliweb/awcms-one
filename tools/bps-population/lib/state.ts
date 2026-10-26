/** Resumable crawl state: one JSON file in the cache dir, written atomically after every item. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function cacheDir(env: Record<string, string | undefined> = process.env): string {
  return env.BPS_CACHE_DIR && env.BPS_CACHE_DIR !== "" ? env.BPS_CACHE_DIR : join(homedir(), ".cache", "awcms-bps-population");
}

export type ItemStatus = "done" | "failed" | "missing";

export interface OfficeRecord {
  domain: string;
  name: string;
  host: string;
  status: ItemStatus;
  targetYear: number;
  foundYear: number | null;
  /** True when the requested year was absent and year-1 was used. */
  fallbackYear: boolean;
  matchKind: "strict" | "lenient" | null;
  title: string | null;
  pubId: string | null;
  pageUrl: string | null;
  releaseDate: string | null;
  catalogueNumber: string | null;
  publicationNumber: string | null;
  issn: string | null;
  pdfFile: string | null;
  sha256: string | null;
  bytes: number | null;
  pages: number | null;
  adopted: boolean;
  error: string | null;
  attempts: number;
  updatedAt: string;
}

/** One Kecamatan Dalam Angka publication (stage 4), keyed by the Kemendagri district code. */
export interface DistrictRecord {
  code: string;
  regencyCode: string;
  regencyDomain: string;
  name: string;
  status: ItemStatus | "unmatched";
  targetYear: number;
  foundYear: number | null;
  fallbackYear: boolean;
  title: string | null;
  pubId: string | null;
  pageUrl: string | null;
  releaseDate: string | null;
  catalogueNumber: string | null;
  publicationNumber: string | null;
  issn: string | null;
  pdfFile: string | null;
  sha256: string | null;
  bytes: number | null;
  pages: number | null;
  error: string | null;
  attempts: number;
  updatedAt: string;
}

export interface State {
  version: 1;
  actionId: string | null;
  stopped: string | null;
  offices: Record<string, OfficeRecord>;
  /** Stage 4: Kecamatan publications by `<kemendagri-code>:<year>`. */
  districts: Record<string, DistrictRecord>;
  /** Provinces whose three levels were fully walked, with the counts logged at that time. */
  provincesDone: Record<string, string>;
}

export function emptyState(): State {
  return { version: 1, actionId: null, stopped: null, offices: {}, districts: {}, provincesDone: {} };
}

export function stateKey(domain: string, year: number): string {
  return `${domain}:${year}`;
}

export function loadState(path: string): State {
  if (!existsSync(path)) return emptyState();
  const parsed = JSON.parse(readFileSync(path, "utf8")) as State;
  if (parsed.version !== 1 || typeof parsed.offices !== "object") throw new Error(`${path}: unsupported state file`);
  parsed.districts ??= {};
  parsed.provincesDone ??= {};
  return parsed;
}

export function saveState(path: string, state: State): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

/** True when an item must be processed: not done, and not a terminal `missing` unless retryMissing. */
export function needsWork(rec: { status: string } | undefined, retryMissing: boolean): boolean {
  if (!rec) return true;
  if (rec.status === "done") return false;
  if (rec.status === "missing" || rec.status === "unmatched") return retryMissing;
  return true;
}

export function appendProgress(dir: string, line: string): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "progress.log"), `${new Date().toISOString()} ${line}\n`);
}

export function freeBytes(dir: string): number {
  const s = statfsSync(existsSync(dir) ? dir : join(dir, ".."));
  return Number(s.bavail) * Number(s.bsize);
}

/** Writes are atomic: a kill -9 leaves either the previous or the new file, never a torn one. */
export const MIN_FREE_BYTES = 15 * 1024 ** 3;
