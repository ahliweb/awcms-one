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
  villageSex,
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
  loadDistrictRecords,
  loadStateRecords,
  parseFrontMatter,
  titleCase,
  type StateRecord,
} from "./meta";
import { loadPages, sha256OfFile } from "./words";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const WILAYAH = join(REPO_ROOT, "apps/cms/data/idn-admin-regions/upstream/cahyadsn-wilayah/db/wilayah.sql");
const DEFAULT_OUT = join(REPO_ROOT, "apps/cms/data/idn-population/datasets");

type Handler = { id: string; description: string; multi?: boolean; scope?: "district" | "not-district"; run: (ctx: Ctx, nth: number) => TableResult | null };

export const HANDLERS: Handler[] = [
  { id: "sex-by-village", description: "Population by sex per desa/kelurahan (Kecamatan 3.1.1)", scope: "district", run: (c, nth) => villageSex(c, nth) },
  { id: "total-by-region", description: "Total population per child region (3.1.1)", run: totalByRegion },
  {
    id: "age-by-sex",
    description: "Population by age group and sex of the covered region (3.1.2)",
    run: (c) => sexTable(c, "age-by-sex", (k) => /^jumlahpenduduk(\(ribu\))?menurutkelompokumurdanjeniskelamin/.test(k), "age"),
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
  /** Kemendagri code of the kecamatan when the PDF is a "Kecamatan Dalam Angka" yearbook. */
  districtCode?: string;
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
  status: "written" | "refused" | "gap-only";
  rowCounts: Record<string, number>;
  total: number;
  gaps: string[];
  report: CheckReport;
  problems: string[];
  pagesVisited: number[];
}

/** A host as state.json records it (with or without a scheme) -> `https://host`, exactly one scheme. */
export function websiteOfHost(host: string): string {
  return `https://${host.trim().replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "")}`;
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

/**
 * Runs the importer's own pure manifest, CSV and consistency validators before
 * anything is written, so a dataset the importer would refuse is never produced.
 */
async function importerCheck(entry: Record<string, unknown>, csv: string, index: RegionIndex, coverage: string): Promise<string[]> {
  const base = join(REPO_ROOT, "apps/cms/src/modules/idn-admin-regions/domain");
  const { parsePopulationManifest } = await import(join(base, "population-manifest.ts"));
  const { parsePopulationCsv } = await import(join(base, "population-csv.ts"));
  const { validatePopulationRecords } = await import(join(base, "population-validation.ts"));
  const errors: string[] = [];
  const m = parsePopulationManifest(entry);
  if (!m.ok) errors.push(...m.errors);
  const p = parsePopulationCsv(csv);
  if (p.errors.length) errors.push(...p.errors);
  else {
    const regionLevels = new Map<string, number>();
    for (const code of index.byCode.keys()) regionLevels.set(code, levelOfCode(code));
    const v = validatePopulationRecords(p.records, { regionLevels, coverageRegionCode: coverage });
    errors.push(...v.errors.slice(0, 20));
  }
  return errors;
}

export async function extractPdf(opt: ExtractOptions): Promise<ExtractOutcome> {
  const index = regionIndex();
  const isDistrict = opt.districtCode !== undefined;
  if (isDistrict && (levelOfCode(opt.districtCode!) !== 3 || !index.byCode.has(opt.districtCode!))) {
    throw new Error(`district code ${opt.districtCode} is not a kecamatan in wilayah.sql`);
  }
  const coverage = isDistrict ? opt.districtCode! : resolveCoverage(index, opt.domain, opt.officeName ?? opt.record?.name);
  if (!index.byCode.has(coverage)) throw new Error(`coverage region ${coverage} is not in wilayah.sql`);
  const coverageLevel = levelOfCode(coverage);

  const pages = await loadPages(opt.pdf);
  const infos: PageInfo[] = [];
  for (const p of pages) {
    const info = analysePage(p);
    if (info) infos.push(info);
  }
  const ctx: Ctx = { infos, index, coverage, soft: coverageLevel >= 2 };
  if (isDistrict) {
    // Kecamatan yearbooks often print the source only once: use the publication-wide basis
    const notes = infos.map((i) => i.notesKey).join("");
    const reg = /registrasi|dkb|siak|catatansipil|dukcapil|kementerianagama/.test(notes);
    const proj = /proyeksi/.test(notes);
    ctx.defaultBasis = reg && !proj ? "registration" : proj && !reg ? "projection" : null;
  }
  const districtHandlers = new Set(["sex-by-village", "age-by-sex", "religion-by-region"]);
  const handlers = isDistrict ? HANDLERS.filter((h) => districtHandlers.has(h.id)) : HANDLERS.filter((h) => h.scope !== "district");

  const results: TableResult[] = [];
  const gaps: string[] = [];
  for (const h of handlers) {
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
  if (!opt.dropFailedTables) for (const r of failedTables) for (const p of r.problems) problems.push(`table ${r.table} (${r.id}): ${p}`);
  if (opt.dropFailedTables) {
    usable = results.filter((r) => r.problems.length === 0);
    for (const r of failedTables) gaps.push(`table ${r.table} (${r.id}) could not be read reliably and is not included (${r.problems[0]})`);
  }
  for (const r of usable) for (const g of r.gaps) gaps.push(`table ${r.table}: ${g}`);

  let all: OutRow[] = usable.flatMap((r) => r.rows);
  let report = runChecks(all, index);
  if (opt.dropFailedTables && report.failures.length > 0) {
    // a table whose own figures contradict each other (a printing error in the source) is
    // left out whole and recorded; the rest of the publication is still usable
    const bad = new Set(report.failures.map((f) => f.sourceTable));
    for (const t of bad) {
      const sample = report.failures.find((f) => f.sourceTable === t)!;
      gaps.push(`table ${t} is not included: its published figures do not add up (${sample.detail}); the source itself is inconsistent`);
    }
    all = all.filter((r) => !bad.has(r.source_table));
    report = runChecks(all, index);
  }
  const dd = dedupe(all);
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
  const datasetCode = isDistrict
    ? `bps-${opt.domain}-kecamatan-${opt.districtCode!.replace(/\./g, "")}-dalam-angka-${year}`
    : `bps-${opt.domain}-dalam-angka-${year}`;
  const rowCounts: Record<string, number> = {};
  for (const r of all) rowCounts[r.dimension] = (rowCounts[r.dimension] ?? 0) + 1;

  const blocking: string[] = [...problems];
  for (const f of report.failures) blocking.push(`check ${f.check} [${f.sourceTable}] region ${f.region}: ${f.detail}`);
  for (const c of report.conflicts) blocking.push(`cross-table conflict: ${c}`);
  for (const r of all) if (r.category.length > 80) blocking.push(`category key longer than 80 characters: ${r.category}`);
  if (all.length === 0) blocking.push("no rows extracted");
  const pageUrl = opt.url ?? rec?.pageUrl ?? undefined;
  const website = opt.website ?? (rec?.host ? websiteOfHost(rec.host) : pageUrl ? new URL(pageUrl).origin : undefined);
  if (!website) blocking.push("publisher website unknown (state.json host or --website)");
  if (!pageUrl) blocking.push("publication page URL unknown (state.json pageUrl or --url)");
  if (!front.termsOfUse) blocking.push("copyright sentence not found on the front pages");
  const publisherName = front.publisherName ?? (opt.officeName ? `BPS ${opt.officeName}` : null);
  if (!publisherName) blocking.push("publisher not found on the front pages");

  const pagesVisited = [...new Set(usable.flatMap((r) => r.printedPages))].sort((a, b) => a - b);
  // nothing readable at all and nothing wrong with what was read: a gap-only publication
  const gapOnly = all.length === 0 && problems.length === 0 && report.failures.length === 0;
  if (gapOnly) {
    const reason = infos.length < 5 ? "no text layer (needs OCR)" : "no readable figures: every table cell is unavailable or not in the text layer (needs OCR)";
    gaps.unshift(reason);
  }
  const outcome: ExtractOutcome = {
    datasetCode,
    status: gapOnly ? "gap-only" : blocking.length ? "refused" : "written",
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
  if (outcome.status !== "written") return outcome;

  const csv = rowsToCsv(all);
  const csvSha = new Bun.CryptoHasher("sha256").update(csv).digest("hex");
  const src = await sha256OfFile(opt.pdf);
  const series = isDistrict ? "kecamatan_dalam_angka" : opt.domain.endsWith("00") ? "provinsi_dalam_angka" : "kabupaten_kota_dalam_angka";
  const entry = {
    datasetCode,
    publicationSeries: series,
    coverageRegionCode: coverage,
    coverageRegionLevel: coverageLevel,
    publicationTitle: title,
    publisherName: publisherName!,
    publisherDomain: opt.domain,
    publisherWebsite: website,
    attribution: attributionSentence(publisherName!, website!, title),
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
  const importerErrors = await importerCheck(entry, csv, index, coverage);
  if (importerErrors.length) {
    outcome.status = "refused";
    outcome.problems.push(...importerErrors.map((e) => `importer check: ${e}`));
    writeFileSync(reviewPath, `${summary}\n## Importer checks failed\n${importerErrors.map((e) => `- ${e}`).join("\n")}\n`);
    return outcome;
  }
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
    for (const rec of flag("districts-only") ? [] : records) {
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
    for (const rec of loadDistrictRecords(cdir)) {
      if (rec.status !== "done" || !rec.pdfFile || rec.domain === "") continue;
      const compact = rec.districtCode.replace(/\./g, "");
      if (only && only !== rec.districtCode && only !== compact && only !== rec.domain) continue;
      const pdf = rec.pdfFile.startsWith("/") ? rec.pdfFile : join(cdir, "pdf", "kecamatan", basename(rec.pdfFile));
      const year = rec.foundYear ?? rec.targetYear;
      const code = `bps-${rec.domain}-kecamatan-${compact}-dalam-angka-${year}`;
      if (!flag("force") && existsSync(join(outDir, `${code}.json`))) continue;
      if (!existsSync(pdf)) continue;
      try {
        const o = await extractPdf({ pdf, domain: rec.domain, districtCode: rec.districtCode, officeName: records.find((r) => r.domain === rec.domain)?.name, outDir, reviewDir, record: rec, dropFailedTables });
        print(o);
        if (o.status === "refused") refused++;
      } catch (e) {
        refused++;
        console.log(`ERROR ${code}: ${(e as Error).message}`);
      }
    }
    return refused ? 2 : 0;
  }
  const pdf = arg("pdf");
  const domain = arg("domain");
  if (!pdf || !domain) {
    console.error("usage: run.ts --pdf <path> --domain <dddd> [--district 62.71.01] [--out <dir>] [--url U] [--website W] [--release-date D] [--drop-failed-tables] | --from-state [--only dddd] [--force]");
    return 64;
  }
  const o = await extractPdf({
    pdf: resolve(pdf),
    domain,
    districtCode: arg("district"),
    outDir,
    reviewDir,
    record: arg("district") ? null : findRecord(records, domain, pdf),
    url: arg("url"),
    website: arg("website"),
    releaseDate: arg("release-date"),
    dropFailedTables,
  });
  print(o);
  return o.status === "written" ? 0 : 2;
}

if (import.meta.main) process.exit(await main());
