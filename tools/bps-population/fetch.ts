#!/usr/bin/env bun
/**
 * Downloads BPS "Dalam Angka" publications into $BPS_CACHE_DIR/pdf/ and records everything in
 * $BPS_CACHE_DIR/state.json. Resumable at any moment (kill -9, power loss, network loss): state.json is
 * replaced atomically after every file, a leftover *.part is deleted and re-downloaded, done items are skipped.
 *
 * Run with --help for the modes.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { ChallengeError, PoliteClient, StallError, pdfPages, sha256File } from "./lib/http";
import { districtPdfName, matchDistrict, parseDistricts, parseKecamatanTitle, type DistrictRegion } from "./lib/districts";
import { matchTitle } from "./lib/names";
import {
  extractActionId,
  extractDownloadLink,
  findPublicationChunk,
  parseListResponse,
  parsePublicationPage,
  publicationPageUrl,
  type ListedPublication,
} from "./lib/parse";
import {
  MIN_FREE_BYTES,
  appendProgress,
  cacheDir,
  freeBytes,
  loadState,
  needsWork,
  saveState,
  stateKey,
  type DistrictRecord,
  type OfficeRecord,
  type State,
} from "./lib/state";

export { MIN_FREE_BYTES };

export interface Office {
  domain: string;
  level: "province" | "regency_city";
  kemendagriCode: string | null;
  name: string;
  host: string;
}

export const HELP = `bun tools/bps-population/fetch.ts <mode> [options]

Modes
  --stage 1                 Kalimantan Tengah (62): provincial office + its regency/city offices
  --stage 2                 every provincial office            (narrow with --province NN)
  --stage 3                 every regency/city office          (narrow with --province NN)
  --stage 4                 Kecamatan Dalam Angka of every regency/city office (narrow with --province NN)
  --province-full NN        one province completely: (a) provincial DA, (b) regency/city DA, (c) Kecamatan DA
  --all-provinces-full      every province in Kemendagri code order, one fully done before the next;
                            writes "PROVINCE-DONE <code> <counts>" to progress.log; already finished
                            provinces are skipped, so re-running resumes where it stopped

Options
  --year YYYY               target year (default 2026; year-1 is used only when the target is absent or its
                            download answers the JSON 404 error, and is recorded as fallbackYear)
  --limit N                 process at most N items
  --retry-missing           also retry items recorded as missing/unmatched
  --dry-run                 print the selection and exit

Resume: just run the same command again. Cache: $BPS_CACHE_DIR (default ~/.cache/awcms-bps-population).
Stop: Ctrl-C / SIGTERM abandons the current file cleanly. Pauses (polling every 10 min) while free disk < 15 GB.
`;

export function selectTargets(offices: Office[], stage: 1 | 2 | 3 | 4, province: string | null): Office[] {
  const usable = offices.filter((o) => o.domain && o.kemendagriCode);
  const prov = (o: Office) => o.kemendagriCode!.split(".")[0]!;
  let out: Office[];
  if (stage === 1) {
    const p = province ?? "62";
    out = usable.filter((o) => prov(o) === p);
  } else if (stage === 2) {
    out = usable.filter((o) => o.level === "province" && (province === null || prov(o) === province));
  } else {
    out = usable.filter((o) => o.level === "regency_city" && (province === null || prov(o) === province));
  }
  return out.sort((a, b) => a.domain.localeCompare(b.domain));
}

/** Province codes (Kemendagri) present in domains.json, ascending. */
export function provinceCodes(offices: Office[]): string[] {
  return [...new Set(offices.filter((o) => o.kemendagriCode).map((o) => o.kemendagriCode!.split(".")[0]!))].sort();
}

export function pdfPath(dir: string, domain: string, year: number): string {
  return join(dir, "pdf", `${domain}-dalam-angka-${year}.pdf`);
}

export function districtPdfPath(dir: string, code: string, year: number): string {
  return join(dir, "pdf", "kecamatan", districtPdfName(code, year));
}

interface Ctx {
  client: PoliteClient;
  dir: string;
  state: State;
  statePath: string;
  wilayah: string | null;
  listings: Map<string, Promise<Map<string, ListedPublication>>>;
}

function save(ctx: Ctx): void {
  saveState(ctx.statePath, ctx.state);
}

/** Pauses (polling every 10 min) while free disk is under the floor; the coordinator frees space. */
async function waitForDisk(ctx: Ctx): Promise<void> {
  let noted = false;
  while (freeBytes(ctx.dir) < MIN_FREE_BYTES) {
    if (!noted) appendProgress(ctx.dir, `PAUSED: free disk below ${MIN_FREE_BYTES / 1024 ** 3} GB, polling every 10 min`);
    noted = true;
    await new Promise((r) => setTimeout(r, 10 * 60_000));
  }
  if (noted) appendProgress(ctx.dir, "RESUMED: disk space available again");
}

async function discoverActionId(ctx: Ctx, host: string): Promise<string> {
  const page = await ctx.client.getText(`${host}/id/publication`);
  const chunk = findPublicationChunk(page.text);
  if (!chunk) throw new Error("publication page: JS chunk not found (layout changed)");
  const js = await ctx.client.getText(`${host}${chunk}`);
  const id = extractActionId(js.text);
  if (!id) throw new Error("publication chunk: getListPublication action id not found");
  return id;
}

async function listPage(ctx: Ctx, host: string, keyword: string, year: number, page: number) {
  const body = JSON.stringify(["id", { page, keyword, sort: "$undefined", onlyTitle: true, year }]);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!ctx.state.actionId) {
      ctx.state.actionId = await discoverActionId(ctx, host);
      save(ctx);
    }
    const res = await ctx.client.postText(`${host}/id/publication`, body, {
      "Next-Action": ctx.state.actionId,
      Accept: "text/x-component",
      "Content-Type": "text/plain;charset=UTF-8",
    });
    try {
      return parseListResponse(res.text);
    } catch (err) {
      if (attempt === 1) throw err;
      ctx.state.actionId = null; // stale id: re-read it from the office's own page, retry once
    }
  }
  throw new Error("unreachable");
}

async function findPublication(ctx: Ctx, o: Office, year: number) {
  const keyword = `${o.name} Dalam Angka`;
  let lenient: ListedPublication | null = null;
  for (let page = 1; page <= 5; page++) {
    const res = await listPage(ctx, o.host, keyword, year, page);
    for (const item of res.items) {
      const m = matchTitle(item.title, o.name, year);
      if (m === "strict") return { item, kind: "strict" as const };
      if (m === "lenient" && !lenient) lenient = item;
    }
    if (page >= res.pages) break;
  }
  return lenient ? { item: lenient, kind: "lenient" as const } : null;
}

/** All "Kecamatan X Dalam Angka <year>" publications an office lists, by normalized district name. */
async function listKecamatan(ctx: Ctx, o: Office, year: number): Promise<ListedPublication[]> {
  const out: ListedPublication[] = [];
  for (let page = 1; page <= 40; page++) {
    const res = await listPage(ctx, o.host, "Kecamatan", year, page);
    for (const item of res.items) {
      const t = parseKecamatanTitle(item.title);
      if (t && t.year === year) out.push(item);
    }
    if (page >= res.pages) break;
  }
  return out;
}

interface PubOutcome {
  kind: "done" | "missing" | "failed" | "json-missing";
  error: string | null;
  bytes: number | null;
  sha256: string | null;
  pages: number | null;
  adopted: boolean;
  pageUrl: string | null;
  catalogueNumber: string | null;
  publicationNumber: string | null;
  issn: string | null;
}

/** Page metadata + adopt-or-download of one listed publication. Shared by offices and districts. */
async function acquire(ctx: Ctx, host: string, item: ListedPublication, file: string): Promise<PubOutcome> {
  const out: PubOutcome = {
    kind: "failed", error: null, bytes: null, sha256: null, pages: null, adopted: false,
    pageUrl: item.releaseDate ? publicationPageUrl(host, item.releaseDate, item.pubId, item.title) : null,
    catalogueNumber: null, publicationNumber: null, issn: item.issn,
  };
  let pageLink: string | null = null;
  if (out.pageUrl) {
    const page = await ctx.client.getText(out.pageUrl);
    if (page.status === 200) {
      const meta = parsePublicationPage(page.text);
      out.catalogueNumber = meta.catalogueNumber;
      out.publicationNumber = meta.publicationNumber;
      out.issn = meta.issn ?? out.issn;
      pageLink = extractDownloadLink(page.text);
    }
  }
  const existingPages = existsSync(file) ? await pdfPages(file) : null;
  if (existingPages !== null) {
    out.adopted = true;
    out.pages = existingPages;
    out.bytes = statSync(file).size;
    out.sha256 = await sha256File(file);
    out.kind = "done";
    return out;
  }
  await waitForDisk(ctx);
  const links = [pageLink, item.pdf].filter((l, i, a): l is string => !!l && a.indexOf(l) === i);
  if (links.length === 0) {
    out.kind = "missing";
    out.error = "publication has no download link";
    return out;
  }
  let last = "";
  for (const link of links) {
    const dl = await ctx.client.downloadPdf(link, file);
    if (dl.kind === "pdf") {
      out.bytes = dl.bytes;
      out.sha256 = dl.sha256;
      out.pages = await pdfPages(file);
      out.kind = out.pages === null ? "failed" : "done";
      out.error = out.pages === null ? "downloaded file is not readable by pdfinfo" : null;
      return out;
    }
    last = `${dl.kind}: ${dl.detail}`;
  }
  out.kind = last.startsWith("json-error") ? "json-missing" : "failed";
  out.error = `download: ${last}`;
  return out;
}

function blank(o: Office, year: number): OfficeRecord {
  return {
    domain: o.domain, name: o.name, host: o.host, status: "failed", targetYear: year, foundYear: null,
    fallbackYear: false, matchKind: null, title: null, pubId: null, pageUrl: null, releaseDate: null,
    catalogueNumber: null, publicationNumber: null, issn: null, pdfFile: null, sha256: null, bytes: null,
    pages: null, adopted: false, error: null, attempts: 0, updatedAt: new Date().toISOString(),
  };
}

async function processOffice(ctx: Ctx, o: Office, year: number, prior: OfficeRecord | undefined): Promise<OfficeRecord> {
  const rec = blank(o, year);
  rec.attempts = (prior?.attempts ?? 0) + 1;
  try {
    let found = await findPublication(ctx, o, year);
    let foundYear = year;
    if (!found) {
      found = await findPublication(ctx, o, year - 1);
      foundYear = year - 1;
    }
    if (!found) {
      rec.status = "missing";
      rec.error = `no "${o.name} Dalam Angka ${year}" or ${year - 1} publication listed`;
      return rec;
    }
    const { item, kind } = found;
    Object.assign(rec, { foundYear, fallbackYear: foundYear !== year, matchKind: kind, title: item.title, pubId: item.pubId, releaseDate: item.releaseDate, issn: item.issn });
    rec.pdfFile = pdfPath(ctx.dir, o.domain, foundYear);
    const r = await acquire(ctx, o.host, item, rec.pdfFile);
    Object.assign(rec, { pageUrl: r.pageUrl, catalogueNumber: r.catalogueNumber, publicationNumber: r.publicationNumber, issn: r.issn, bytes: r.bytes, sha256: r.sha256, pages: r.pages, adopted: r.adopted, error: r.error });
    rec.status = r.kind === "done" ? "done" : r.kind === "json-missing" ? "missing" : r.kind === "missing" ? "missing" : "failed";
    return rec;
  } catch (err) {
    if (err instanceof ChallengeError) throw err;
    rec.status = "failed";
    rec.error = err instanceof Error ? err.message : String(err);
    return rec;
  } finally {
    rec.updatedAt = new Date().toISOString();
  }
}

function blankDistrict(d: DistrictRegion, o: Office, year: number, prior: DistrictRecord | undefined): DistrictRecord {
  return {
    code: d.code, regencyCode: o.kemendagriCode!, regencyDomain: o.domain, name: d.name, status: "failed",
    targetYear: year, foundYear: null, fallbackYear: false, title: null, pubId: null, pageUrl: null,
    releaseDate: null, catalogueNumber: null, publicationNumber: null, issn: null, pdfFile: null, sha256: null,
    bytes: null, pages: null, error: null, attempts: (prior?.attempts ?? 0) + 1, updatedAt: new Date().toISOString(),
  };
}

/** At most this many PDF transfers at once; page and server-action requests stay one at a time (lib/http.ts). */
export const DOWNLOAD_CONCURRENCY = 3;

/** Interleaves groups so consecutive items come from different groups (different regency offices). */
export function roundRobin<T>(groups: T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; groups.some((g) => i < g.length); i++) for (const g of groups) if (i < g.length) out.push(g[i]!);
  return out;
}

/** Runs `fn` over `items` with `workers` in flight; the first failure stops new work and is rethrown once all settle. */
export async function runPool<T>(items: T[], workers: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  await Promise.all(
    Array.from({ length: Math.min(workers, items.length) }, async () => {
      while (failure === null && next < items.length) {
        const item = items[next++]!;
        try {
          await fn(item);
        } catch (err) {
          failure ??= err;
        }
      }
    })
  );
  if (failure !== null) throw failure;
}

interface DistrictJob {
  office: Office;
  district: DistrictRegion;
  expected: DistrictRegion[];
}

/** Pending district jobs of the given regency/city offices, interleaved across offices. */
function districtJobs(ctx: Ctx, offices: Office[], year: number, retryMissing: boolean, tally: Record<string, number>): DistrictJob[] {
  if (!ctx.wilayah) ctx.wilayah = readFileSync(WILAYAH, "utf8");
  const groups: DistrictJob[][] = [];
  for (const o of offices) {
    const expected = parseDistricts(ctx.wilayah, o.kemendagriCode!);
    const jobs: DistrictJob[] = [];
    for (const d of expected) {
      const rec = ctx.state.districts[stateKey(d.code, year)];
      if (needsWork(rec, retryMissing)) jobs.push({ office: o, district: d, expected });
      else tally[rec!.status] = (tally[rec!.status] ?? 0) + 1;
    }
    if (jobs.length > 0) groups.push(jobs);
  }
  return roundRobin(groups);
}

/** One regency's "Kecamatan" listing for one year, fetched once and shared by every worker. */
function listFor(ctx: Ctx, o: Office, expected: DistrictRegion[], y: number): Promise<Map<string, ListedPublication>> {
  const key = `${o.domain}:${y}`;
  let p = ctx.listings.get(key);
  if (!p) {
    p = (async () => {
      const m = new Map<string, ListedPublication>();
      const unknown: string[] = [];
      for (const item of await listKecamatan(ctx, o, y)) {
        const t = parseKecamatanTitle(item.title)!;
        const match = matchDistrict(t.name, expected);
        if (match.kind === "matched") m.set(match.region.code, item);
        else unknown.push(`${item.title} (${match.kind})`);
      }
      if (unknown.length > 0) {
        appendProgress(ctx.dir, `stage 4 ${o.kemendagriCode} ${o.name} ${y}: ${unknown.length} listed Kecamatan title(s) not mapped to a district: ${unknown.slice(0, 5).join("; ")}`);
      }
      return m;
    })();
    p.catch(() => ctx.listings.delete(key)); // a failed listing is retried by the next job
    ctx.listings.set(key, p);
  }
  return p;
}

async function districtJob(ctx: Ctx, job: DistrictJob, year: number, tally: Record<string, number>): Promise<void> {
  const { office: o, district: d, expected } = job;
  const key = stateKey(d.code, year);
  const rec = blankDistrict(d, o, year, ctx.state.districts[key]);
  try {
    let chosen = false;
    const tried: string[] = [];
    for (const y of [year, year - 1]) {
      const item = (await listFor(ctx, o, expected, y)).get(d.code);
      if (!item) {
        tried.push(`${y}: not listed`);
        continue;
      }
      const file = districtPdfPath(ctx.dir, d.code, y);
      const r = await acquire(ctx, o.host, item, file);
      if (r.kind === "done") {
        Object.assign(rec, { status: "done", foundYear: y, fallbackYear: y !== year, title: item.title, pubId: item.pubId, releaseDate: item.releaseDate, pdfFile: file, pageUrl: r.pageUrl, catalogueNumber: r.catalogueNumber, publicationNumber: r.publicationNumber, issn: r.issn, bytes: r.bytes, sha256: r.sha256, pages: r.pages, error: null });
        chosen = true;
        break;
      }
      tried.push(`${y}: ${r.error}`);
      if (r.kind === "failed") {
        rec.status = "failed";
        rec.error = tried.join("; ");
        break; // a transport failure is retried later, not papered over with an older year
      }
    }
    if (!chosen && rec.status !== "failed") {
      rec.status = "missing";
      rec.error = tried.join("; ");
    }
  } catch (err) {
    if (err instanceof ChallengeError) throw err;
    rec.status = "failed";
    rec.error = err instanceof Error ? err.message : String(err);
  }
  rec.updatedAt = new Date().toISOString();
  ctx.state.districts[key] = rec;
  save(ctx);
  tally[rec.status] = (tally[rec.status] ?? 0) + 1;
  console.log(`  ${d.code} ${d.name}: ${rec.status}${rec.fallbackYear ? " (fallback)" : ""}${rec.error ? ` (${rec.error})` : ""} ${rec.pages ?? "-"}p ${rec.bytes ?? "-"}B`);
}

/** Stage 4 over regency/city offices: up to 3 downloads at once, taken from different offices where possible. */
async function runDistricts(ctx: Ctx, offices: Office[], year: number, retryMissing: boolean, limit: number): Promise<Record<string, number>> {
  const tally: Record<string, number> = {};
  const jobs = districtJobs(ctx, offices, year, retryMissing, tally).slice(0, limit);
  await runPool(jobs, DOWNLOAD_CONCURRENCY, (job) => districtJob(ctx, job, year, tally));
  return tally;
}

const WILAYAH = join(import.meta.dir, "..", "..", "apps/cms/data/idn-admin-regions/upstream/cahyadsn-wilayah/db/wilayah.sql");

function fmt(t: Record<string, number>): string {
  return Object.entries(t).sort().map(([k, v]) => `${k}=${v}`).join(",") || "none";
}

async function runOffices(ctx: Ctx, todo: Office[], year: number, label: string): Promise<Record<string, number>> {
  const tally: Record<string, number> = {};
  await runPool(todo, DOWNLOAD_CONCURRENCY, async (o) => {
    const key = stateKey(o.domain, year);
    const rec = await processOffice(ctx, o, year, ctx.state.offices[key]);
    ctx.state.offices[key] = rec;
    save(ctx);
    tally[rec.status] = (tally[rec.status] ?? 0) + 1;
    console.log(`${label} ${o.domain} ${o.name}: ${rec.status}${rec.fallbackYear ? " (fallback)" : ""}${rec.error ? ` (${rec.error})` : ""} ${rec.pages ?? "-"}p ${rec.bytes ?? "-"}B`);
  });
  return tally;
}

/** (a) provincial DA, (b) regency/city DA, (c) Kecamatan DA of one province. */
async function provinceFull(ctx: Ctx, offices: Office[], prov: string, year: number, retryMissing: boolean): Promise<void> {
  const mine = offices.filter((o) => o.kemendagriCode && o.kemendagriCode.split(".")[0] === prov);
  const provincial = mine.filter((o) => o.level === "province");
  const regencies = mine.filter((o) => o.level === "regency_city").sort((a, b) => a.kemendagriCode!.localeCompare(b.kemendagriCode!));
  const todo = (xs: Office[]) => xs.filter((o) => needsWork(ctx.state.offices[stateKey(o.domain, year)], retryMissing));
  const a = await runOffices(ctx, todo(provincial), year, "provincial");
  const b = await runOffices(ctx, todo(regencies), year, "regency");
  const c = await runDistricts(ctx, regencies, year, retryMissing, Infinity);
  const count = (xs: Office[]) => {
    const t: Record<string, number> = {};
    for (const o of xs) {
      const s = ctx.state.offices[stateKey(o.domain, year)]?.status ?? "pending";
      t[s] = (t[s] ?? 0) + 1;
    }
    return t;
  };
  const line = `provincial[${fmt(count(provincial))}] regencies[${fmt(count(regencies))}] districts[${fmt(c)}]`;
  ctx.state.provincesDone[prov] = line;
  save(ctx);
  appendProgress(ctx.dir, `PROVINCE-DONE ${prov} ${line}`);
  void a; void b;
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function sweepParts(dir: string): void {
  for (const d of [join(dir, "pdf"), join(dir, "pdf", "kecamatan")]) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) if (f.endsWith(".part")) rmSync(join(d, f), { force: true });
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h") || process.argv.length <= 2) {
    console.log(HELP);
    return;
  }
  const year = Number(arg("year") ?? 2026);
  const limit = arg("limit") ? Number(arg("limit")) : Infinity;
  const retryMissing = process.argv.includes("--retry-missing");
  const dir = cacheDir();
  const statePath = join(dir, "state.json");
  const domains = JSON.parse(readFileSync(join(import.meta.dir, "domains.json"), "utf8")) as { offices: Office[] };
  const state = loadState(statePath);
  state.stopped = null;
  sweepParts(dir);
  const ctx: Ctx = { client: new PoliteClient(), dir, state, statePath, wilayah: null, listings: new Map() };

  // Ctrl-C / SIGTERM: abandon the current file (its .part is removed), keep state.json as last written, exit.
  const bye = (sig: string) => () => {
    ctx.client.controller.abort();
    if (ctx.client.currentPart) rmSync(ctx.client.currentPart, { force: true });
    appendProgress(dir, `INTERRUPTED by ${sig}; resume by re-running the same command`);
    process.exit(130);
  };
  process.on("SIGINT", bye("SIGINT"));
  process.on("SIGTERM", bye("SIGTERM"));

  try {
    if (process.argv.includes("--all-provinces-full") || arg("province-full")) {
      const only = arg("province-full");
      const provs = only ? [only] : provinceCodes(domains.offices);
      for (const p of provs) {
        if (!only && state.provincesDone[p]) continue;
        if (process.argv.includes("--dry-run")) {
          console.log(`would walk province ${p}`);
          continue;
        }
        appendProgress(dir, `PROVINCE-START ${p}`);
        await provinceFull(ctx, domains.offices, p, year, retryMissing);
      }
      return;
    }
    const stage = Number(arg("stage"));
    if (![1, 2, 3, 4].includes(stage)) throw new Error("no mode given; see --help");
    const targets = selectTargets(domains.offices, stage as 1 | 2 | 3 | 4, arg("province"));
    if (stage === 4) {
      console.log(`stage 4: ${targets.length} regency/city offices`);
      if (process.argv.includes("--dry-run")) return;
      const t = await runDistricts(ctx, targets, year, retryMissing, limit);
      appendProgress(dir, `stage 4${arg("province") ? ` province ${arg("province")}` : ""}: ${fmt(t)}`);
      return;
    }
    const todo = targets.filter((t) => needsWork(state.offices[stateKey(t.domain, year)], retryMissing)).slice(0, limit);
    console.log(`stage ${stage}: ${targets.length} offices selected, ${todo.length} to process (year ${year})`);
    if (process.argv.includes("--dry-run")) return;
    const tally = await runOffices(ctx, todo, year, `stage ${stage}`);
    appendProgress(dir, `stage ${stage}: ${fmt(tally)}`);
  } catch (err) {
    if (err instanceof ChallengeError) {
      state.stopped = err.message;
      appendProgress(dir, `STOPPED: ${err.message}`);
    }
    save(ctx);
    console.error(err instanceof Error ? err.message : err);
    process.exit(err instanceof StallError ? 3 : 2);
  }
  save(ctx);
}

if (import.meta.main) await main();
