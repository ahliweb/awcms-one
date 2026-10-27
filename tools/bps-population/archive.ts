/**
 * Archives BPS "Dalam Angka" PDFs to Google Drive (via rclone) once their
 * population dataset has been created, verified, and only then frees the disk.
 *
 * Dry run by default. With `--commit`, each eligible PDF is copied with
 * `rclone copyto --checksum`, verified against the remote (MD5 and byte size),
 * recorded in `$BPS_CACHE_DIR/archive.json`, and only then deleted locally.
 * Any failed step keeps the local file and is reported; nothing is deleted on
 * an ambiguous or skipped verification.
 *
 * Configuration (environment only, no account is ever hardcoded):
 *   BPS_ARCHIVE_REMOTE   rclone remote and path, e.g. `myremote:Folder/Sub` (required)
 *   BPS_CACHE_DIR        default ~/.cache/awcms-bps-population
 *   BPS_DATASETS_DIR     default apps/cms/data/idn-population/datasets
 *
 * Remote layout: `<remote>/kabkota-provinsi/<year>/<file>` for PDFs directly in
 * `pdf/`, and `<remote>/kecamatan/<year>/<file>` for PDFs in `pdf/kecamatan/`.
 *
 * With `--include-unextracted`, a PDF that yields no eligible dataset but whose
 * sha256 has a `$BPS_CACHE_DIR/extract-results.json` record is archived too:
 * outcome `gap_only` goes to `<remote>/belum-diekstrak/<scope>/<year>/<file>`,
 * outcome `refused` to `<remote>/perlu-ditinjau/<scope>/<year>/<file>`. Such a
 * record carries `kind` other than `dataset`. A PDF with neither a dataset nor
 * a ledger record is never touched, and a missing or corrupt ledger means no
 * such PDF is ever touched.
 *
 * Every rclone call is an argv array through Bun.spawn; no shell is involved.
 * The decision logic is exported as pure functions so it can be tested without
 * a network, rclone, or a database.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parsePopulationCsv
} from "../../apps/cms/src/modules/idn-admin-regions/domain/population-csv";
import {
  parsePopulationManifest,
  type PopulationDatasetManifest
} from "../../apps/cms/src/modules/idn-admin-regions/domain/population-manifest";
import {
  validatePopulationRecords,
  regionLevelOfCode
} from "../../apps/cms/src/modules/idn-admin-regions/domain/population-validation";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const WILAYAH_SQL_PATH = path.join(
  REPO_ROOT,
  "apps",
  "cms",
  "data",
  "idn-admin-regions",
  "upstream",
  "cahyadsn-wilayah",
  "db",
  "wilayah.sql"
);
/**
 * One `('<dotted code>','<name>')` tuple of wilayah.sql. SQL escapes a quote inside
 * a name by doubling it (`'Panu''ut'`), so the name is `(?:[^']|'')*`.
 */
const WILAYAH_TUPLE = /\('(\d+(?:\.\d+)*)','(?:[^']|'')*'\)/g;

export const ARCHIVE_FILE_NAME = "archive.json";
export const EXTRACT_LEDGER_FILE_NAME = "extract-results.json";
const DEFAULT_CACHE_SUBDIR = path.join(".cache", "awcms-bps-population");
const DEFAULT_DATASETS_DIR = path.join("apps", "cms", "data", "idn-population", "datasets");

/** Remote folder for PDFs the extractor produced no dataset from, by ledger outcome. */
export const UNEXTRACTED_FOLDERS = {
  gap_only: "belum-diekstrak",
  refused: "perlu-ditinjau"
} as const;

/** Why a PDF was archived. Records written before `kind` existed are `dataset`. */
export type ArchiveKind = "dataset" | "gap_only" | "refused";

/** One line of `archive.json`: a PDF that has been verified on the remote. */
export type ArchiveRecord = {
  file: string;
  sha256: string;
  md5: string;
  bytes: number;
  remote: string;
  /** The dataset code for `kind: "dataset"`; the empty string otherwise. */
  datasetCode: string;
  archivedAt: string;
  kind: ArchiveKind;
};

export type ExtractOutcome = "written" | "gap_only" | "refused";

/** One line of `extract-results.json`, written by the extractor. */
export type ExtractRecord = {
  /** Path relative to `$BPS_CACHE_DIR/pdf`. */
  file: string;
  sha256: string;
  outcome: ExtractOutcome;
  datasetCode: string | null;
  reason: string | null;
  publicationYear: number;
  extractedAt: string;
};

export type ArchiveScope = "kabkota-provinsi" | "kecamatan";

/** A dataset as the eligibility check sees it: the parsed manifest plus its CSV, if any. */
export type DatasetCandidate = {
  datasetCode: string;
  manifest: PopulationDatasetManifest;
  /** The CSV's UTF-8 text, or null when `<datasetCode>.csv` is missing or unreadable. */
  csvText: string | null;
  /** sha256 of the CSV's bytes, or null when the CSV is missing. */
  csvBytesSha256: string | null;
};

export type Eligibility =
  | { eligible: true; datasetCode: string; year: number }
  | { eligible: false; reason: string };

export type RcloneResult = { code: number; stdout: string; stderr: string };
export type RcloneRunner = (args: string[]) => Promise<RcloneResult>;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function md5Hex(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("hex");
}

/**
 * Validates the configured remote. Rejects an empty value, a value that starts
 * with `-` (it would be read as an rclone flag), and one with no `remote:` colon.
 * Returns the remote with trailing slashes removed.
 */
export function normaliseRemoteRoot(raw: string | undefined): { ok: true; remote: string } | { ok: false; reason: string } {
  const value = (raw ?? "").trim();
  if (value.length === 0) {
    return { ok: false, reason: "BPS_ARCHIVE_REMOTE is not set (expected an rclone remote and path, e.g. myremote:Folder/Sub)." };
  }
  if (value.startsWith("-")) {
    return { ok: false, reason: `BPS_ARCHIVE_REMOTE "${value}" must not start with "-".` };
  }
  if (!value.includes(":")) {
    return { ok: false, reason: `BPS_ARCHIVE_REMOTE "${value}" must be an rclone remote and path, e.g. myremote:Folder/Sub.` };
  }
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.endsWith(":")) {
    return { ok: false, reason: `BPS_ARCHIVE_REMOTE "${value}" names no path after the remote.` };
  }
  return { ok: true, remote: trimmed };
}

/**
 * Builds `<remoteRoot>/<scope>/<year>/<fileName>`. The file name must be a bare
 * name (no separator, no dot segment) and the year a plain integer, so a value
 * from a dataset JSON cannot escape the scope folder.
 */
export function remoteFilePath(
  remoteRoot: string,
  scope: ArchiveScope,
  year: number,
  fileName: string,
  folder?: string
): string {
  if (!Number.isInteger(year) || year < 1961 || year > 2100) {
    throw new Error(`publication year ${year} is not a plausible integer year.`);
  }
  if (fileName.length === 0 || fileName.includes("/") || fileName.includes("\\") || fileName === "." || fileName === "..") {
    throw new Error(`file name "${fileName}" is not a bare file name.`);
  }
  if (folder !== undefined && !/^[a-z][a-z-]*$/.test(folder)) {
    throw new Error(`folder "${folder}" is not a plain folder name.`);
  }
  const prefix = folder === undefined ? "" : `${folder}/`;
  return `${remoteRoot.replace(/\/+$/, "")}/${prefix}${scope}/${year}/${fileName}`;
}

/**
 * Classifies a PDF by its path relative to `pdf/`. Direct children are the
 * kabupaten/kota/provinsi publications; the `kecamatan/` subfolder holds the
 * kecamatan publications. Anything else is refused, including paths that climb
 * out of `pdf/`.
 */
export function classifyPdfLocation(
  relativePath: string
): { ok: true; scope: ArchiveScope; fileName: string } | { ok: false; reason: string } {
  if (path.isAbsolute(relativePath) || relativePath.startsWith("..")) {
    return { ok: false, reason: "path is outside pdf/" };
  }
  const segments = relativePath.split(path.sep).filter((s) => s.length > 0);
  if (segments.some((s) => s === "..")) {
    return { ok: false, reason: "path is outside pdf/" };
  }
  const fileName = segments[segments.length - 1];
  if (!fileName || !isArchivablePdfName(fileName)) {
    return { ok: false, reason: "not a .pdf file" };
  }
  if (segments.length === 1) {
    return { ok: true, scope: "kabkota-provinsi", fileName };
  }
  if (segments.length === 2 && segments[0] === "kecamatan") {
    return { ok: true, scope: "kecamatan", fileName };
  }
  return { ok: false, reason: `unsupported location "${segments.slice(0, -1).join("/")}/" under pdf/` };
}

/** A finished `.pdf`; a `.pdf.part` download in progress never qualifies. */
export function isArchivablePdfName(name: string): boolean {
  return name.endsWith(".pdf") && !name.endsWith(".part");
}

/**
 * True only for a `.pdf` strictly inside `<cacheDir>/pdf/`. Every local delete
 * goes through this guard, so nothing outside that tree is ever removed.
 */
export function isDeletableArchiveSource(cacheDir: string, filePath: string): boolean {
  const pdfRoot = path.resolve(cacheDir, "pdf");
  const target = path.resolve(filePath);
  const rel = path.relative(pdfRoot, target);
  if (rel.length === 0 || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return isArchivablePdfName(path.basename(target));
}

/**
 * Every region of the upstream wilayah dataset, as code -> level. This is the same
 * map the importer reads from the active region dataset in the database, so the
 * validator's children and region-code checks see the full hierarchy, not only the
 * regions one PDF happened to publish.
 */
export function parseWilayahRegionLevels(sqlText: string): Map<string, number> {
  const levels = new Map<string, number>();
  for (const match of sqlText.matchAll(WILAYAH_TUPLE)) {
    const code = match[1]!;
    levels.set(code, regionLevelOfCode(code));
  }
  return levels;
}

/** Reads the upstream wilayah.sql. Throws when it is missing or holds no regions: eligibility must not be guessed. */
export async function loadWilayahRegionLevels(sqlPath: string = WILAYAH_SQL_PATH): Promise<Map<string, number>> {
  const levels = parseWilayahRegionLevels(await readFile(sqlPath, "utf8"));
  if (levels.size === 0) throw new Error(`no regions found in ${sqlPath}`);
  return levels;
}

/**
 * Decides whether a PDF may be archived. The PDF must be the source of exactly
 * one dataset, whose CSV is present, matches its manifest's checksum, and passes
 * the importer's pure validation. `regionLevels` is the full region list (see
 * `loadWilayahRegionLevels`), loaded once per run, not the CSV's own codes.
 */
export function decideEligibility(
  sha256: string,
  candidates: readonly DatasetCandidate[],
  regionLevels: ReadonlyMap<string, number>
): Eligibility {
  const matches = candidates.filter((c) => c.manifest.sourceFileSha256 === sha256);
  if (matches.length === 0) {
    return { eligible: false, reason: "no dataset yet" };
  }
  if (matches.length > 1) {
    return {
      eligible: false,
      reason: `ambiguous: ${matches.length} datasets cite this PDF (${matches.map((m) => m.datasetCode).join(", ")})`
    };
  }
  const [dataset] = matches as [DatasetCandidate];
  const { manifest } = dataset;

  if (dataset.csvText === null || dataset.csvBytesSha256 === null) {
    return { eligible: false, reason: `CSV ${dataset.datasetCode}.csv is missing or unreadable` };
  }
  if (dataset.csvBytesSha256 !== manifest.csvSha256) {
    return { eligible: false, reason: `CSV checksum does not match ${dataset.datasetCode}.json` };
  }

  const parsed = parsePopulationCsv(dataset.csvText);
  if (parsed.errors.length > 0) {
    return { eligible: false, reason: `validation failed: ${parsed.errors[0]}` };
  }
  if (parsed.records.length === 0) {
    return { eligible: false, reason: "validation failed: the CSV has no data rows" };
  }
  const validation = validatePopulationRecords(parsed.records, {
    regionLevels,
    coverageRegionCode: manifest.coverageRegionCode
  });
  if (validation.errors.length > 0) {
    return { eligible: false, reason: `validation failed: ${validation.errors[0]}` };
  }
  return { eligible: true, datasetCode: dataset.datasetCode, year: manifest.publicationYear };
}

/**
 * Extracts the MD5 for `fileName` from `rclone md5sum` output (`<md5>  <name>`
 * per line). Returns null unless exactly one line names the file and it is a
 * 32-character hex digest.
 */
export function parseRcloneMd5(output: string, fileName: string): string | null {
  const hits: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{32})\s+(.+)$/.exec(line.trim());
    if (match && match[2] === fileName) hits.push(match[1]!.toLowerCase());
  }
  return hits.length === 1 ? hits[0]! : null;
}

/** Byte count from `rclone size --json`, only when it counts exactly one object. */
export function parseRcloneSizeJson(output: string): number | null {
  try {
    const parsed = JSON.parse(output) as { count?: unknown; bytes?: unknown };
    if (parsed.count !== 1 || typeof parsed.bytes !== "number" || !Number.isInteger(parsed.bytes)) return null;
    return parsed.bytes;
  } catch {
    return null;
  }
}

/** Compares the local file with what the remote reports. Both MD5 and bytes must match. */
export function compareVerification(
  local: { md5: string; bytes: number },
  remote: { md5: string | null; bytes: number | null }
): { ok: true } | { ok: false; reason: string } {
  if (remote.md5 === null) return { ok: false, reason: "remote MD5 could not be read" };
  if (remote.bytes === null) return { ok: false, reason: "remote size could not be read" };
  if (remote.md5 !== local.md5) {
    return { ok: false, reason: `MD5 mismatch (local ${local.md5}, remote ${remote.md5})` };
  }
  if (remote.bytes !== local.bytes) {
    return { ok: false, reason: `size mismatch (local ${local.bytes} bytes, remote ${remote.bytes} bytes)` };
  }
  return { ok: true };
}

/** The archive record already holding this file on this remote, if any. */
export function findArchiveRecord(records: readonly ArchiveRecord[], sha256: string, remote: string): ArchiveRecord | undefined {
  return records.find((r) => r.sha256 === sha256 && r.remote === remote);
}

/**
 * Adds a record, replacing any earlier one with the same sha256 and remote, so
 * re-archiving the same bytes to the same place never duplicates a line.
 */
export function mergeArchiveRecord(records: readonly ArchiveRecord[], record: ArchiveRecord): ArchiveRecord[] {
  const kept = records.filter((r) => !(r.sha256 === record.sha256 && r.remote === record.remote));
  return [...kept, record];
}

/**
 * Parses archive.json. A file that is not an array of well-formed records
 * throws, so a corrupt ledger is never silently overwritten.
 */
export function parseArchiveJson(text: string): ArchiveRecord[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("archive.json must hold a JSON array.");
  return parsed.map((entry, index) => {
    const r = entry as Partial<ArchiveRecord>;
    if (
      typeof r?.file !== "string" ||
      typeof r.sha256 !== "string" ||
      typeof r.md5 !== "string" ||
      typeof r.bytes !== "number" ||
      typeof r.remote !== "string" ||
      typeof r.datasetCode !== "string" ||
      typeof r.archivedAt !== "string"
    ) {
      throw new Error(`archive.json entry ${index} is malformed.`);
    }
    // A record written before `kind` existed is a dataset archive.
    const kind: unknown = r.kind ?? "dataset";
    if (kind !== "dataset" && kind !== "gap_only" && kind !== "refused") {
      throw new Error(`archive.json entry ${index} has an unknown kind.`);
    }
    return { ...(r as ArchiveRecord), kind };
  });
}

const EXTRACT_OUTCOMES: readonly string[] = ["written", "gap_only", "refused"];

/**
 * Parses `extract-results.json`. Any malformed entry throws, so a partly
 * readable ledger is treated as corrupt as a whole and nothing is moved on its basis.
 */
export function parseExtractLedger(text: string): ExtractRecord[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("extract-results.json must hold a JSON array.");
  return parsed.map((entry, index) => {
    const r = entry as Partial<ExtractRecord>;
    if (
      typeof r?.file !== "string" ||
      typeof r.sha256 !== "string" ||
      typeof r.outcome !== "string" ||
      !EXTRACT_OUTCOMES.includes(r.outcome) ||
      (r.datasetCode !== null && typeof r.datasetCode !== "string") ||
      (r.reason !== null && typeof r.reason !== "string") ||
      typeof r.publicationYear !== "number" ||
      typeof r.extractedAt !== "string"
    ) {
      throw new Error(`extract-results.json entry ${index} is malformed.`);
    }
    return r as ExtractRecord;
  });
}

/**
 * The latest ledger record per sha256 wins. Recency is `extractedAt`; when two
 * records tie (or a timestamp does not parse), the one later in the file wins.
 */
export function latestExtractBySha(records: readonly ExtractRecord[]): Map<string, ExtractRecord> {
  const latest = new Map<string, ExtractRecord>();
  for (const record of records) {
    const current = latest.get(record.sha256);
    if (!current) {
      latest.set(record.sha256, record);
      continue;
    }
    const next = Date.parse(record.extractedAt);
    const prev = Date.parse(current.extractedAt);
    const unordered = Number.isNaN(next) || Number.isNaN(prev);
    if (unordered || next >= prev) latest.set(record.sha256, record);
  }
  return latest;
}

/**
 * Reads the ledger for `--include-unextracted`. A missing ledger is empty. A
 * corrupt one is also empty, with a warning, so nothing is moved on its basis.
 */
export async function loadExtractLedger(ledgerPath: string, warnings: string[]): Promise<Map<string, ExtractRecord>> {
  if (!existsSync(ledgerPath)) return new Map();
  try {
    return latestExtractBySha(parseExtractLedger(await readFile(ledgerPath, "utf8")));
  } catch (error) {
    warnings.push(`${EXTRACT_LEDGER_FILE_NAME} is unreadable (${(error as Error).message}); no unextracted PDFs will be archived`);
    return new Map();
  }
}

/** The remote folder for a ledger outcome that has no dataset, or null for `written`. */
export function unextractedFolder(record: ExtractRecord | undefined): { kind: "gap_only" | "refused"; folder: string } | null {
  if (!record) return null;
  if (record.outcome === "gap_only") return { kind: "gap_only", folder: UNEXTRACTED_FOLDERS.gap_only };
  if (record.outcome === "refused") return { kind: "refused", folder: UNEXTRACTED_FOLDERS.refused };
  return null;
}

export type ArchivePlacement =
  | { place: true; kind: ArchiveKind; year: number; datasetCode: string; folder?: string }
  | { place: false; reason: string };

/**
 * Decides where, if anywhere, a PDF goes. An eligible dataset always wins. Without
 * an eligible dataset, only `--include-unextracted` plus a `gap_only` or `refused`
 * ledger record for the same sha256 places it; everything else is left alone.
 */
export function decideArchivePlacement(input: {
  eligibility: Eligibility;
  extract: ExtractRecord | undefined;
  includeUnextracted: boolean;
}): ArchivePlacement {
  if (input.eligibility.eligible) {
    return { place: true, kind: "dataset", year: input.eligibility.year, datasetCode: input.eligibility.datasetCode };
  }
  const unextracted = input.includeUnextracted ? unextractedFolder(input.extract) : null;
  if (unextracted && input.extract) {
    return {
      place: true,
      kind: unextracted.kind,
      year: input.extract.publicationYear,
      datasetCode: "",
      folder: unextracted.folder
    };
  }
  return { place: false, reason: input.eligibility.reason };
}

/** Keeps only the PDFs matching `--only`: a domain (first segment of the stem) or the whole stem. */
export function matchesOnly(fileName: string, only: string | null): boolean {
  if (only === null) return true;
  const stem = fileName.replace(/\.pdf$/, "");
  return stem === only || stem.split("-")[0] === only;
}

export type ParsedArgs = { commit: boolean; only: string | null; includeUnextracted: boolean };

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let commit = false;
  let only: string | null = null;
  let includeUnextracted = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--commit") {
      commit = true;
    } else if (arg === "--include-unextracted") {
      includeUnextracted = true;
    } else if (arg === "--only") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--only needs a domain or file stem.");
      only = value;
      i++;
    } else if (arg.startsWith("--only=")) {
      only = arg.slice("--only=".length);
      if (only.length === 0) throw new Error("--only needs a domain or file stem.");
    } else {
      throw new Error(
        `unknown argument "${arg}". Usage: archive.ts [--commit] [--only <domain-or-file-stem>] [--include-unextracted]`
      );
    }
  }
  return { commit, only, includeUnextracted };
}

export type ArchiveOutcome =
  | { status: "skipped"; reason: string }
  | { status: "deleted"; uploaded: boolean; bytes: number }
  | { status: "failed"; reason: string };

/**
 * Verifies the remote copy: MD5 from `rclone md5sum`, bytes from `rclone size --json`.
 * It makes no decision beyond the comparison; the caller acts on the result.
 */
export async function verifyRemote(
  run: RcloneRunner,
  remote: string,
  fileName: string,
  local: { md5: string; bytes: number }
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const md5Result = await run(["md5sum", remote]);
  if (md5Result.code !== 0) return { ok: false, reason: `rclone md5sum exited ${md5Result.code}` };
  const sizeResult = await run(["size", "--json", remote]);
  if (sizeResult.code !== 0) return { ok: false, reason: `rclone size exited ${sizeResult.code}` };
  return compareVerification(local, {
    md5: parseRcloneMd5(md5Result.stdout, fileName),
    bytes: parseRcloneSizeJson(sizeResult.stdout)
  });
}

export type ArchiveDeps = {
  run: RcloneRunner;
  /** Reads archive.json, merges the record, and writes it atomically. Throws on failure. */
  saveRecord: (record: ArchiveRecord) => Promise<void>;
  /** Loads archive.json (empty when absent). Throws when the ledger is corrupt. */
  loadRecords: () => Promise<ArchiveRecord[]>;
  deleteLocal: (filePath: string) => Promise<void>;
  now: () => Date;
};

/**
 * Archives one eligible PDF. Order is fixed: upload, verify, record, delete.
 * Deletion happens only after the record is durably written.
 */
export async function archiveOne(
  item: {
    filePath: string;
    fileName: string;
    sha256: string;
    md5: string;
    bytes: number;
    remote: string;
    datasetCode: string;
    kind: ArchiveKind;
  },
  deps: ArchiveDeps
): Promise<ArchiveOutcome> {
  const local = { md5: item.md5, bytes: item.bytes };
  const records = await deps.loadRecords();
  const existing = findArchiveRecord(records, item.sha256, item.remote);

  if (existing) {
    // Already archived here: only the remote's presence needs proving before the local copy goes.
    // If the remote no longer matches the record, fall through and upload again.
    const check = await verifyRemote(deps.run, item.remote, item.fileName, local);
    if (check.ok) return await deleteAfterVerify(item, deps);
  }

  const copy = await deps.run(["copyto", item.filePath, item.remote, "--checksum"]);
  if (copy.code !== 0) {
    return { status: "failed", reason: `rclone copyto exited ${copy.code}: ${copy.stderr.trim().slice(0, 300)}` };
  }
  const check = await verifyRemote(deps.run, item.remote, item.fileName, local);
  if (!check.ok) {
    return { status: "failed", reason: `verification failed (local kept; remote copy left in place): ${check.reason}` };
  }

  try {
    await deps.saveRecord({
      file: item.fileName,
      sha256: item.sha256,
      md5: item.md5,
      bytes: item.bytes,
      remote: item.remote,
      datasetCode: item.datasetCode,
      archivedAt: deps.now().toISOString(),
      kind: item.kind
    });
  } catch (error) {
    return { status: "failed", reason: `could not write archive.json (local kept): ${(error as Error).message}` };
  }

  const deleted = await deleteAfterVerify(item, deps);
  if (deleted.status === "deleted") return { status: "deleted", uploaded: true, bytes: item.bytes };
  return deleted;
}

async function deleteAfterVerify(
  item: { filePath: string; bytes: number },
  deps: ArchiveDeps
): Promise<ArchiveOutcome> {
  try {
    await deps.deleteLocal(item.filePath);
  } catch (error) {
    return { status: "failed", reason: `archived and verified, but the local delete failed: ${(error as Error).message}` };
  }
  return { status: "deleted", uploaded: false, bytes: item.bytes };
}

export type Summary = {
  eligible: number;
  /** Of the eligible, those archived without a dataset (`gap_only` or `refused`). */
  unextracted: number;
  uploaded: number;
  verified: number;
  deleted: number;
  skipped: number;
  failed: number;
  freedBytes: number;
};

export function emptySummary(): Summary {
  return { eligible: 0, unextracted: 0, uploaded: 0, verified: 0, deleted: 0, skipped: 0, failed: 0, freedBytes: 0 };
}

export function formatSummary(summary: Summary): string {
  const mb = (summary.freedBytes / 1_000_000).toFixed(1);
  return [
    `eligible ${summary.eligible}`,
    `unextracted ${summary.unextracted}`,
    `uploaded ${summary.uploaded}`,
    `verified ${summary.verified}`,
    `deleted ${summary.deleted}`,
    `skipped ${summary.skipped}`,
    `failed ${summary.failed}`,
    `freed ${mb} MB`
  ].join(", ");
}

// ---------------------------------------------------------------------------
// Impure edges: filesystem, rclone, environment
// ---------------------------------------------------------------------------

/** Runs rclone with an argv array. No shell is ever involved. */
export async function runRclone(args: string[]): Promise<RcloneResult> {
  const proc = Bun.spawn(["rclone", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

async function listPdfs(pdfRoot: string, dir = pdfRoot): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listPdfs(pdfRoot, full)));
    } else if (entry.isFile() && isArchivablePdfName(entry.name)) {
      out.push(full);
    }
  }
  return out.sort();
}

async function loadDatasetCandidates(datasetsDir: string, warnings: string[]): Promise<DatasetCandidate[]> {
  if (!existsSync(datasetsDir)) return [];
  const candidates: DatasetCandidate[] = [];
  for (const name of (await readdir(datasetsDir)).sort()) {
    if (!name.endsWith(".json")) continue;
    const stem = name.slice(0, -".json".length);
    let manifest: PopulationDatasetManifest;
    try {
      const result = parsePopulationManifest(JSON.parse(await readFile(path.join(datasetsDir, name), "utf8")));
      if (!result.ok) {
        warnings.push(`${name}: not a valid dataset manifest, ignored`);
        continue;
      }
      manifest = result.manifest;
    } catch (error) {
      warnings.push(`${name}: unreadable (${(error as Error).message}), ignored`);
      continue;
    }
    if (manifest.datasetCode !== stem) {
      warnings.push(`${name}: datasetCode "${manifest.datasetCode}" does not match the file name, ignored`);
      continue;
    }
    const csvPath = path.join(datasetsDir, `${stem}.csv`);
    let csvText: string | null = null;
    let csvBytesSha256: string | null = null;
    if (existsSync(csvPath)) {
      const bytes = new Uint8Array(await readFile(csvPath));
      csvBytesSha256 = sha256Hex(bytes);
      csvText = Buffer.from(bytes).toString("utf8");
    }
    candidates.push({ datasetCode: stem, manifest, csvText, csvBytesSha256 });
  }
  return candidates;
}

async function loadArchiveRecords(archivePath: string): Promise<ArchiveRecord[]> {
  if (!existsSync(archivePath)) return [];
  return parseArchiveJson(await readFile(archivePath, "utf8"));
}

async function saveArchiveRecord(cacheDir: string, record: ArchiveRecord): Promise<void> {
  const archivePath = path.join(cacheDir, ARCHIVE_FILE_NAME);
  const merged = mergeArchiveRecord(await loadArchiveRecords(archivePath), record);
  const tmp = `${archivePath}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  await rename(tmp, archivePath);
}

type PlanItem = {
  filePath: string;
  relativePath: string;
  fileName: string;
  sha256: string;
  md5: string;
  bytes: number;
  eligibility: Eligibility;
  scope: ArchiveScope | null;
  refusal: string | null;
  remote: string | null;
  kind: ArchiveKind;
  datasetCode: string;
};

function describeSkip(item: PlanItem): string {
  if (item.refusal) return item.refusal;
  if (!item.eligibility.eligible && item.remote === null) return item.eligibility.reason;
  return "";
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }

  const remoteCheck = normaliseRemoteRoot(env.BPS_ARCHIVE_REMOTE);
  if (!remoteCheck.ok) {
    console.error(remoteCheck.reason);
    return 2;
  }
  const remoteRoot = remoteCheck.remote;

  const cacheDir = env.BPS_CACHE_DIR && env.BPS_CACHE_DIR.trim().length > 0
    ? path.resolve(env.BPS_CACHE_DIR)
    : path.join(homedir(), DEFAULT_CACHE_SUBDIR);
  const datasetsDir = env.BPS_DATASETS_DIR && env.BPS_DATASETS_DIR.trim().length > 0
    ? path.resolve(env.BPS_DATASETS_DIR)
    : path.join(REPO_ROOT, DEFAULT_DATASETS_DIR);
  const pdfRoot = path.join(cacheDir, "pdf");
  const mode = args.commit ? "COMMIT" : "DRY RUN";

  console.log(`[${mode}] remote: ${remoteRoot}`);
  console.log(`cache: ${cacheDir}`);
  console.log(`datasets: ${datasetsDir}`);
  if (args.only) console.log(`only: ${args.only}`);

  const warnings: string[] = [];
  const candidates = await loadDatasetCandidates(datasetsDir, warnings);
  for (const warning of warnings) console.log(`warning: ${warning}`);
  let regionLevels: Map<string, number>;
  try {
    regionLevels = await loadWilayahRegionLevels();
  } catch (error) {
    console.error(`cannot load the region list (${(error as Error).message}); no eligibility decided.`);
    return 2;
  }

  const pdfs = (await listPdfs(pdfRoot)).filter((p) => matchesOnly(path.basename(p), args.only));
  const ledgerWarnings: string[] = [];
  const extractBySha = args.includeUnextracted
    ? await loadExtractLedger(path.join(cacheDir, EXTRACT_LEDGER_FILE_NAME), ledgerWarnings)
    : new Map<string, ExtractRecord>();
  for (const warning of ledgerWarnings) console.log(`warning: ${warning}`);
  const plan: PlanItem[] = [];
  for (const filePath of pdfs) {
    const bytesBuf = new Uint8Array(await readFile(filePath));
    const sha256 = sha256Hex(bytesBuf);
    const md5 = md5Hex(bytesBuf);
    const relativePath = path.relative(pdfRoot, filePath);
    const location = classifyPdfLocation(relativePath);
    const eligibility = decideEligibility(sha256, candidates, regionLevels);
    let remote: string | null = null;
    let scope: ArchiveScope | null = null;
    let refusal: string | null = null;
    let kind: ArchiveKind = "dataset";
    let datasetCode = "";
    if (!location.ok) {
      refusal = location.reason;
    } else {
      scope = location.scope;
      const placement = decideArchivePlacement({
        eligibility,
        extract: extractBySha.get(sha256),
        includeUnextracted: args.includeUnextracted
      });
      if (placement.place) {
        kind = placement.kind;
        datasetCode = placement.datasetCode;
        try {
          remote = remoteFilePath(remoteRoot, scope, placement.year, location.fileName, placement.folder);
        } catch (error) {
          refusal = (error as Error).message;
        }
      } else {
        refusal = placement.reason;
      }
    }
    plan.push({
      filePath,
      relativePath,
      fileName: path.basename(filePath),
      sha256,
      md5,
      bytes: bytesBuf.byteLength,
      eligibility,
      scope,
      refusal,
      remote,
      kind,
      datasetCode
    });
  }

  const summary = emptySummary();
  if (pdfs.length === 0) {
    console.log(`no PDFs under ${pdfRoot}`);
  }

  if (!args.commit) {
    for (const item of plan) {
      const ok = !item.refusal && item.remote !== null;
      if (ok) {
        summary.eligible++;
        if (item.kind !== "dataset") summary.unextracted++;
        const tag = item.kind === "dataset" ? "" : ` [${item.kind}]`;
        console.log(`eligible  ${item.relativePath} -> ${item.remote}${tag}`);
      } else {
        summary.skipped++;
        console.log(`skipped   ${item.relativePath}: ${describeSkip(item)}`);
      }
    }
    console.log(formatSummary(summary));
    console.log("dry run: nothing was uploaded, recorded or deleted. Re-run with --commit to archive.");
    return 0;
  }

  const deps: ArchiveDeps = {
    run: runRclone,
    saveRecord: (record) => saveArchiveRecord(cacheDir, record),
    loadRecords: () => loadArchiveRecords(path.join(cacheDir, ARCHIVE_FILE_NAME)),
    deleteLocal: async (filePath) => {
      if (!isDeletableArchiveSource(cacheDir, filePath)) {
        throw new Error(`refusing to delete ${filePath}: not a .pdf under ${pdfRoot}`);
      }
      await rm(filePath);
    },
    now: () => new Date()
  };

  for (const item of plan) {
    if (item.refusal || item.remote === null) {
      summary.skipped++;
      console.log(`skipped   ${item.relativePath}: ${describeSkip(item)}`);
      continue;
    }
    summary.eligible++;
    if (item.kind !== "dataset") summary.unextracted++;
    let outcome: ArchiveOutcome;
    try {
      outcome = await archiveOne(
        {
          filePath: item.filePath,
          fileName: path.basename(item.filePath),
          sha256: item.sha256,
          md5: item.md5,
          bytes: item.bytes,
          remote: item.remote,
          datasetCode: item.datasetCode,
          kind: item.kind
        },
        deps
      );
    } catch (error) {
      // An unexpected error (for example a corrupt archive.json) keeps the local file and the run goes on.
      outcome = { status: "failed", reason: `unexpected error (local kept): ${(error as Error).message}` };
    }
    if (outcome.status === "skipped") {
      summary.skipped++;
      console.log(`skipped   ${item.relativePath}: ${outcome.reason}`);
    } else if (outcome.status === "failed") {
      summary.failed++;
      console.log(`failed    ${item.relativePath}: ${outcome.reason}`);
    } else {
      if (outcome.uploaded) summary.uploaded++;
      summary.verified++;
      summary.deleted++;
      summary.freedBytes += outcome.bytes;
      console.log(`deleted   ${item.relativePath} (verified at ${item.remote})`);
    }
  }

  console.log(formatSummary(summary));
  return summary.failed > 0 ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
