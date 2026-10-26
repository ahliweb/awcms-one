#!/usr/bin/env bun
/**
 * Downloads each BPS office's "<Name> Dalam Angka <year>" publication into $BPS_CACHE_DIR/pdf/ and records
 * everything in $BPS_CACHE_DIR/state.json (resumable: done items are skipped, failures carry their reason).
 *
 *   bun tools/bps-population/fetch.ts --stage <1|2|3> [--province 62] [--limit N] [--year 2026]
 *                                     [--retry-missing] [--dry-run]
 *
 *   stage 1: the Kalimantan Tengah (62) provincial office + its regency/city offices
 *   stage 2: every provincial office
 *   stage 3: every regency/city office (batch with --province <Kemendagri province code>)
 *
 * Politeness (lib/http.ts): one request at a time, >= 2 s apart, backoff on 429/5xx, hard stop on 403 or a
 * Cloudflare challenge. Needs `pdfinfo` (poppler-utils) on PATH. Stops when free disk drops below 15 GB.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ChallengeError, PoliteClient, pdfPages, sha256File } from "./lib/http";
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
  appendProgress,
  cacheDir,
  freeBytes,
  loadState,
  needsWork,
  saveState,
  stateKey,
  type OfficeRecord,
  type State,
} from "./lib/state";

export interface Office {
  domain: string;
  level: "province" | "regency_city";
  kemendagriCode: string | null;
  name: string;
  host: string;
}

export const MIN_FREE_BYTES = 15 * 1024 ** 3;

export function selectTargets(offices: Office[], stage: 1 | 2 | 3, province: string | null): Office[] {
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

export function pdfPath(dir: string, domain: string, year: number): string {
  return join(dir, "pdf", `${domain}-dalam-angka-${year}.pdf`);
}

interface Ctx {
  client: PoliteClient;
  dir: string;
  state: State;
  statePath: string;
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
      saveState(ctx.statePath, ctx.state);
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
      ctx.state.actionId = null; // stale id: rediscover once
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

function blank(o: Office, year: number): OfficeRecord {
  return {
    domain: o.domain,
    name: o.name,
    host: o.host,
    status: "failed",
    targetYear: year,
    foundYear: null,
    fallbackYear: false,
    matchKind: null,
    title: null,
    pubId: null,
    pageUrl: null,
    releaseDate: null,
    catalogueNumber: null,
    publicationNumber: null,
    issn: null,
    pdfFile: null,
    sha256: null,
    bytes: null,
    pages: null,
    adopted: false,
    error: null,
    attempts: 0,
    updatedAt: new Date().toISOString(),
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
    rec.foundYear = foundYear;
    rec.fallbackYear = foundYear !== year;
    rec.matchKind = kind;
    rec.title = item.title;
    rec.pubId = item.pubId;
    rec.releaseDate = item.releaseDate;
    rec.issn = item.issn;
    if (item.releaseDate) rec.pageUrl = publicationPageUrl(o.host, item.releaseDate, item.pubId, item.title);

    let pageLink: string | null = null;
    if (rec.pageUrl) {
      const page = await ctx.client.getText(rec.pageUrl);
      if (page.status === 200) {
        const meta = parsePublicationPage(page.text);
        rec.catalogueNumber = meta.catalogueNumber;
        rec.publicationNumber = meta.publicationNumber;
        rec.issn = meta.issn ?? rec.issn;
        pageLink = extractDownloadLink(page.text);
      }
    }

    const file = pdfPath(ctx.dir, o.domain, foundYear);
    rec.pdfFile = file;
    const existingPages = existsSync(file) ? await pdfPages(file) : null;
    if (existingPages !== null) {
      rec.adopted = true;
      rec.pages = existingPages;
      rec.bytes = statSync(file).size;
      rec.sha256 = await sha256File(file);
      rec.status = "done";
      return rec;
    }

    if (freeBytes(ctx.dir) < MIN_FREE_BYTES) {
      ctx.state.stopped = `free disk below ${MIN_FREE_BYTES / 1024 ** 3} GB`;
      rec.error = ctx.state.stopped;
      return rec;
    }
    const links = [pageLink, item.pdf].filter((l, i, a): l is string => !!l && a.indexOf(l) === i);
    if (links.length === 0) {
      rec.status = "missing";
      rec.error = "publication has no download link";
      return rec;
    }
    let last = "";
    for (const link of links) {
      const dl = await ctx.client.downloadPdf(link, file);
      if (dl.kind === "pdf") {
        rec.bytes = dl.bytes;
        rec.sha256 = dl.sha256;
        rec.pages = await pdfPages(file);
        rec.status = rec.pages === null ? "failed" : "done";
        rec.error = rec.pages === null ? "downloaded file is not readable by pdfinfo" : null;
        return rec;
      }
      last = `${dl.kind}: ${dl.detail}`;
    }
    rec.status = last.startsWith("json-error") ? "missing" : "failed";
    rec.error = `download: ${last}`;
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

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const stage = Number(arg("stage"));
  if (stage !== 1 && stage !== 2 && stage !== 3) throw new Error("usage: fetch.ts --stage <1|2|3> [--province NN] [--limit N] [--year YYYY]");
  const year = Number(arg("year") ?? 2026);
  const limit = arg("limit") ? Number(arg("limit")) : Infinity;
  const retryMissing = process.argv.includes("--retry-missing");
  const dir = cacheDir();
  const statePath = join(dir, "state.json");
  const domains = JSON.parse(readFileSync(join(import.meta.dir, "domains.json"), "utf8")) as { offices: Office[] };
  const targets = selectTargets(domains.offices, stage, arg("province"));
  const state = loadState(statePath);
  state.stopped = null;
  const todo = targets.filter((t) => needsWork(state.offices[stateKey(t.domain, year)], retryMissing)).slice(0, limit);
  console.log(`stage ${stage}: ${targets.length} offices selected, ${todo.length} to process (year ${year})`);
  if (process.argv.includes("--dry-run")) return;

  const ctx: Ctx = { client: new PoliteClient(), dir, state, statePath };
  const provOf = (o: Office) => o.kemendagriCode!.split(".")[0]!;
  const tally = new Map<string, Record<string, number>>();
  const flush = (prov: string) => {
    const t = tally.get(prov);
    if (t) appendProgress(dir, `stage ${stage} province ${prov}: ${Object.entries(t).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    tally.delete(prov);
  };
  let prev: string | null = null;
  try {
    for (const o of todo) {
      const prov = provOf(o);
      if (prev !== null && prev !== prov) flush(prev);
      prev = prov;
      const key = stateKey(o.domain, year);
      const rec = await processOffice(ctx, o, year, state.offices[key]);
      state.offices[key] = rec;
      saveState(statePath, state);
      const t = tally.get(prov) ?? {};
      t[rec.status] = (t[rec.status] ?? 0) + 1;
      tally.set(prov, t);
      console.log(`${o.domain} ${o.name}: ${rec.status}${rec.error ? ` (${rec.error})` : ""} ${rec.pages ?? "-"}p ${rec.bytes ?? "-"}B`);
      if (state.stopped) throw new Error(`stopped: ${state.stopped}`);
    }
    if (prev !== null) flush(prev);
  } catch (err) {
    if (prev !== null) flush(prev);
    if (err instanceof ChallengeError) {
      state.stopped = err.message;
      appendProgress(dir, `STOPPED: ${err.message}`);
    }
    saveState(statePath, state);
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }
  saveState(statePath, state);
}

if (import.meta.main) await main();
