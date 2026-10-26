#!/usr/bin/env bun
/**
 * Extracts population statistics from a BPS "Dalam Angka" PDF into the dataset
 * contract: <datasetCode>.csv + <datasetCode>.json.
 *
 *   bun tools/bps-population/extract/run.ts --pdf <path> --domain <dddd> [--out <dir>]
 *   bun tools/bps-population/extract/run.ts --from-state [--only <dddd>] [--out <dir>]
 *
 * A dataset whose tables fail self-validation is NOT written; a review file is
 * left under <cache>/review/ instead. Nothing is invented, rounded or filled.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { dedupe, runChecks, type CheckReport } from "./checks";
import { analysePage, type PageInfo } from "./rows";
import { buildIndex, coreLabel, levelOfCode, parseWilayahSql, typeOfName, type RegionIndex } from "./regions";
import { rowsToCsv } from "./output";
import {
  ageByRegionColumns,
  expenditureTable,
  industryByRegion,
  religionByRegion,
  sexTable,
  totalByRegion,
  wageByAge,
  type Ctx,
  type OutRow,
  type TableResult,
} from "./tables";
import {
  attributionSentence,
  cacheDir,
  coverageOfDomain,
  findRecord,
  frontMatterText,
  loadStateRecords,
  parseFrontMatter,
  titleCase,
  type StateRecord,
} from "./meta";
import { loadPages, sha256OfFile } from "./words";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const WILAYAH = join(REPO_ROOT, "apps/cms/data/idn-admin-regions/upstream/cahyadsn-wilayah/db/wilayah.sql");
const DEFAULT_OUT = join(REPO_ROOT, "apps/cms/data/idn-population/datasets");

type Handler = { id: string; description: string; multi?: boolean; run: (ctx: Ctx, nth: number) => TableResult | null };

export const HANDLERS: Handler[] = [
  { id: "total-by-region", description: "Total population per child region (3.1.1)", run: totalByRegion },
  {
    id: "age-by-sex",
    description: "Population by age group and sex of the covered region (3.1.2)",
    run: (c) => sexTable(c, "age-by-sex", (k) => /^jumlahpendudukmenurutkelompokumurdanjeniskelamin/.test(k), "age"),
  },
  {
    id: "sex-by-region",
    description: "Population by sex per child region (3.1.3 / registration 3.1.3-3.1.4)",
    multi: true,
    run: (c, nth) =>
      sexTable(
        c,
        "sex-by-region",
        (k) =>
          /^jumlahpenduduk(dan|menurut)?(rasio)?jeniskelamin/.test(k) &&
          !/laju|kelompokumur/.test(k) &&
          /menurut(kabupaten\/kota|kecamatan|kelurahan|desa)/.test(k),
        "region",
        nth
      ),
  },
  { id: "age-by-region", description: "Age groups down, regions across (3.1.4)", run: ageByRegionColumns },
  {
    id: "religion-by-sex",
    description: "Religion by sex of the covered region (4.3.4)",
    run: (c) => sexTable(c, "religion-by-sex", (k) => /menurutagama(\/aliran)?kepercayaandanjeniskelamin|menurutagamadanjeniskelamin/.test(k), "religion"),
  },
  { id: "religion-by-region", description: "Religion per child region (4.5.4 / 4.3.1)", multi: true, run: religionByRegion },
  { id: "employed-by-industry", description: "Employed 15+ by industry group per region (3.2.14)", run: (c) => industryByRegion(c, "employed") },
  { id: "wage-by-industry", description: "Net wage by industry group per region (3.2.30)", run: (c) => industryByRegion(c, "wage") },
  { id: "wage-by-age", description: "Net wage by age group (3.2.31)", run: wageByAge },
  { id: "expenditure-by-commodity", description: "Per-capita expenditure by commodity group (10.1)", run: expenditureTable },
];

/**
 * The Kemendagri region a BPS office covers. BPS regency domains are numbered
 * in BPS's own order (6207 is Lamandau) which differs from Kemendagri's (62.07
 * is Seruyan), so a regency/city is resolved by its NAME under the province;
 * only a province, or an office without a recorded name, falls back to the
 * digits of the domain.
 */
export function resolveCoverage(index: RegionIndex, domain: string, officeName?: string | null): string {
  const prov = domain.slice(0, 2);
  if (domain.endsWith("00")) return prov;
  if (officeName) {
    const kind = typeOfName(officeName);
    const core = coreLabel(officeName);
    const hits = (index.childrenOf.get(prov) ?? []).filter((r) => coreLabel(r.name) === core && (kind === null || typeOfName(r.name) === kind));
    if (hits.length === 1) return hits[0]!.code;
    throw new Error(`office "${officeName}" (${domain}) matched ${hits.length} regions under ${prov}`);
  }
  return coverageOfDomain(domain);
}

export interface ExtractOptions {
  officeName?: string | null;
  pdf: string;
  domain: string;
  outDir: string;
  reviewDir: string;
  record?: StateRecord | null;
  url?: string;
  releaseDate?: string;
  website?: string;
  dropFailedTables?: boolean;
}

export interface ExtractOutcome {
  datasetCode: string;
  status: "written" | "refused";
  rowCounts: Record<string, number>;
  total: number;
  gaps: string[];
  report: CheckReport;
  problems: string[];
  pagesVisited: number[];
}

/** The running page header "KOTA X DALAM ANGKA 2026" (upper case, repeated on every even page). */
export function runningHeader(pages: { words: { text: string; x0: number; y0: number }[] }[]): { text: string; year: number } | null {
  for (const p of pages.slice(8, 120)) {
    const top = p.words.filter((w) => w.y0 < 40).sort((a, b) => a.x0 - b.x0).map((w) => w.text);
    const m = /^((?:[A-Z]+ )+)DALAM ANGKA (20\d{2})$/.exec(top.join(" "));
    if (m) return { text: `${m[1]}DALAM ANGKA ${m[2]}`, year: Number(m[2]) };
  }
  return null;
}

let cachedIndex: RegionIndex | null = null;
function regionIndex(): RegionIndex {
  cachedIndex ??= buildIndex(parseWilayahSql(readFileSync(WILAYAH, "utf8")));
  return cachedIndex;
}

export async function extractPdf(opt: ExtractOptions): Promise<ExtractOutcome> {
  const index = regionIndex();
  const coverage = resolveCoverage(index, opt.domain, opt.officeName ?? opt.record?.name);
  if (!index.byCode.has(coverage)) throw new Error(`coverage region ${coverage} is not in wilayah.sql`);
  const coverageLevel = levelOfCode(coverage);

  const pages = await loadPages(opt.pdf);
  const infos: PageInfo[] = [];
  for (const p of pages) {
    const info = analysePage(p);
    if (info) infos.push(info);
  }
  const ctx: Ctx = { infos, index, coverage };

  const results: TableResult[] = [];
  const gaps: string[] = [];
  for (const h of HANDLERS) {
    let found = 0;
    for (let nth = 0; nth < (h.multi ? 8 : 1); nth++) {
      const r = h.run(ctx, nth);
      if (r === null) break;
      found++;
      results.push(r);
    }
    if (found === 0) gaps.push(`${h.description}: no table with this title was found in the publication`);
  }

  const problems: string[] = [];
  let usable = results;
  const failedTables = results.filter((r) => r.problems.length > 0);
  for (const r of failedTables) for (const p of r.problems) problems.push(`table ${r.table} (${r.id}): ${p}`);
  if (opt.dropFailedTables) {
    usable = results.filter((r) => r.problems.length === 0);
    for (const r of failedTables) gaps.push(`table ${r.table} (${r.id}) could not be read reliably and is not included`);
  }
  for (const r of usable) for (const g of r.gaps) gaps.push(`table ${r.table}: ${g}`);

  const all: OutRow[] = usable.flatMap((r) => r.rows);
  const dd = dedupe(all);
  // checks run on every table's own rows (before cross-table duplicates are merged)
  const report = runChecks(all, index);
  report.keyCollisions = dd.report.keyCollisions;
  report.duplicatesDropped = dd.report.duplicatesDropped;
  report.conflicts = dd.report.conflicts;

  // front matter and publication metadata
  const front = parseFrontMatter(await frontMatterText(opt.pdf));
  const rec = opt.record ?? null;
  const header = runningHeader(pages);
  const year = rec?.foundYear ?? header?.year ?? front.year ?? rec?.targetYear ?? 0;
  const runTitle = header?.text ?? front.runningTitle;
  const title = rec?.title ?? (runTitle ? titleCase(runTitle) : null) ?? `${opt.domain} Dalam Angka ${year}`;
  const datasetCode = `bps-${opt.domain}-dalam-angka-${year}`;
  const rowCounts: Record<string, number> = {};
  for (const r of all) rowCounts[r.dimension] = (rowCounts[r.dimension] ?? 0) + 1;

  const blocking: string[] = [...problems];
  for (const f of report.failures) blocking.push(`check ${f.check} [${f.sourceTable}] region ${f.region}: ${f.detail}`);
  for (const c of report.conflicts) blocking.push(`cross-table conflict: ${c}`);
  for (const r of all) if (r.category.length > 80) blocking.push(`category key longer than 80 characters: ${r.category}`);
  if (all.length === 0) blocking.push("no rows extracted");
  const website = opt.website ?? (rec?.host ? `https://${rec.host}` : undefined);
  const pageUrl = opt.url ?? rec?.pageUrl ?? undefined;
  if (!website) blocking.push("publisher website unknown (state.json host or --website)");
  if (!pageUrl) blocking.push("publication page URL unknown (state.json pageUrl or --url)");
  if (!front.termsOfUse) blocking.push("copyright sentence not found on the front pages");
  if (!front.publisherName) blocking.push("publisher not found on the front pages");

  const pagesVisited = [...new Set(usable.flatMap((r) => r.printedPages))].sort((a, b) => a - b);
  const outcome: ExtractOutcome = {
    datasetCode,
    status: blocking.length ? "refused" : "written",
    rowCounts,
    total: all.length,
    gaps,
    report,
    problems: blocking,
    pagesVisited,
  };

  mkdirSync(opt.reviewDir, { recursive: true });
  const reviewPath = join(opt.reviewDir, `${datasetCode}.review.md`);
  const summary = [
    `# ${datasetCode} - extraction review`,
    "",
    `Status: ${outcome.status}`,
    `Rows: ${all.length} (${Object.entries(rowCounts).map(([k, v]) => `${k}=${v}`).join(", ")})`,
    `Skipped checks: ${JSON.stringify(report.skipReasons)}`,
    `Checks: ${report.passed} passed, ${report.skipped} skipped, ${report.failures.length} failed; duplicates dropped ${report.duplicatesDropped}; key collisions (same spec key, different unit/basis) ${report.keyCollisions}`,
    "",
    "## Blocking findings",
    ...(blocking.length ? blocking.map((b) => `- ${b}`) : ["- none"]),
    "",
    "## Gaps",
    ...(gaps.length ? gaps.map((g) => `- ${g}`) : ["- none"]),
    "",
    "## Tables",
    ...results.map((r) => `- ${r.table} ${r.id}: ${r.rows.length} rows, pages ${r.printedPages.join(",")}, problems ${r.problems.length}`),
    "",
  ].join("\n");
  writeFileSync(reviewPath, summary);
  if (outcome.status === "refused") return outcome;

  const csv = rowsToCsv(all);
  const csvSha = new Bun.CryptoHasher("sha256").update(csv).digest("hex");
  const src = await sha256OfFile(opt.pdf);
  const series = opt.domain.endsWith("00") ? "provinsi_dalam_angka" : "kabupaten_kota_dalam_angka";
  const publisherName = front.publisherName!;
  const entry = {
    datasetCode,
    publicationSeries: series,
    coverageRegionCode: coverage,
    coverageRegionLevel: coverageLevel,
    publicationTitle: title,
    publisherName,
    publisherDomain: opt.domain,
    publisherWebsite: website,
    attribution: attributionSentence(publisherName, website!, title),
    catalogueNumber: front.catalogueNumber ?? rec?.catalogueNumber ?? null,
    publicationNumber: front.publicationNumber ?? rec?.publicationNumber ?? null,
    issn: front.issn ?? rec?.issn ?? null,
    publicationYear: year,
    releaseDate: opt.releaseDate ?? rec?.releaseDate ?? null,
    publicationUrl: pageUrl,
    sourceFileSha256: src.sha256,
    sourceFileBytes: src.bytes,
    sourcePages: pagesVisited,
    termsOfUse: front.termsOfUse,
    csvPath: `datasets/${datasetCode}.csv`,
    csvSha256: csvSha,
    tablesUsed: usable
      .filter((r) => r.rows.length > 0)
      .map((r) => ({
        table: r.table,
        title: r.title,
        printedPages: r.printedPages,
        referenceYears: r.referenceYears,
        figureBasis: r.figureBasis.length === 1 ? r.figureBasis[0] : r.figureBasis.join("+"),
        unit: r.units.length === 1 ? r.units[0] : r.units.join("+"),
      })),
    knownGaps: gaps,
  };
  mkdirSync(opt.outDir, { recursive: true });
  writeFileSync(join(opt.outDir, `${datasetCode}.csv`), csv);
  writeFileSync(join(opt.outDir, `${datasetCode}.json`), `${JSON.stringify(entry, null, 2)}\n`);
  return outcome;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function print(o: ExtractOutcome): void {
  console.log(
    `${o.status.toUpperCase()} ${o.datasetCode}: ${o.total} rows ${JSON.stringify(o.rowCounts)}; checks ${o.report.passed} ok / ${o.report.skipped} skipped / ${o.report.failures.length} failed; dup-dropped ${o.report.duplicatesDropped}; key-collisions ${o.report.keyCollisions}`
  );
  for (const p of o.problems.slice(0, 15)) console.log(`  ! ${p}`);
  if (o.problems.length > 15) console.log(`  ... ${o.problems.length - 15} more (see review file)`);
  for (const g of o.gaps) console.log(`  gap: ${g}`);
}

async function main(): Promise<number> {
  const cdir = cacheDir();
  const outDir = resolve(arg("out") ?? DEFAULT_OUT);
  const reviewDir = join(cdir, "review");
  const records = loadStateRecords(cdir);
  const dropFailedTables = flag("drop-failed-tables");
  if (flag("from-state")) {
    const only = arg("only");
    let refused = 0;
    for (const rec of records) {
      if (rec.status !== "done" || !rec.pdfFile) continue;
      if (only && rec.domain !== only) continue;
      const pdf = rec.pdfFile.startsWith("/") ? rec.pdfFile : join(cdir, "pdf", basename(rec.pdfFile));
      const year = rec.foundYear ?? rec.targetYear;
      const code = `bps-${rec.domain}-dalam-angka-${year}`;
      if (!flag("force") && existsSync(join(outDir, `${code}.json`))) continue;
      if (!existsSync(pdf)) continue;
      try {
        const o = await extractPdf({ pdf, domain: rec.domain, officeName: rec.name, outDir, reviewDir, record: rec, dropFailedTables });
        print(o);
        if (o.status === "refused") refused++;
      } catch (e) {
        refused++;
        console.log(`ERROR ${rec.domain}: ${(e as Error).message}`);
      }
    }
    return refused ? 2 : 0;
  }
  const pdf = arg("pdf");
  const domain = arg("domain");
  if (!pdf || !domain) {
    console.error("usage: run.ts --pdf <path> --domain <dddd> [--out <dir>] [--url U] [--website W] [--release-date D] [--drop-failed-tables] | --from-state [--only dddd] [--force]");
    return 64;
  }
  const o = await extractPdf({
    pdf: resolve(pdf),
    domain,
    outDir,
    reviewDir,
    record: findRecord(records, domain, pdf),
    url: arg("url"),
    website: arg("website"),
    releaseDate: arg("release-date"),
    dropFailedTables,
  });
  print(o);
  return o.status === "written" ? 0 : 2;
}

if (import.meta.main) process.exit(await main());
