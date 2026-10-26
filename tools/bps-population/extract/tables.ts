/**
 * Table handlers. Each one finds its table by the Indonesian title pattern
 * (the numbering differs between the 552 offices; the wording does not), reads
 * the numbers by x-position and returns contract rows. A handler that cannot
 * read a table reliably returns no rows and a gap/problem - it never guesses.
 */
import { ageBandKey, indonesianPart, parseCell, snakeCase } from "./cells";
import {
  clusterLines,
  cx,
  headerWords,
  labelColumnCount,
  nearestMarker,
  readBody,
  type BodyRow,
  type PageInfo,
} from "./rows";
import { kindFromGroupLine, levelOfCode, resolveLabel, type KindHint, type RegionIndex } from "./regions";
import type { Word } from "./words";

export interface OutRow {
  region_code: string;
  region_level: number;
  source_region_name: string;
  dimension: string;
  category: string;
  sex: string;
  value: string;
  unit: string;
  reference_year: number;
  figure_basis: string;
  universe: string;
  source_table: string;
  source_page: number | null;
  value_note: string;
  /** The category label exactly as published (empty when the key is the label). */
  category_label: string;
}

export interface TableResult {
  id: string;
  /** Printed table number, e.g. "3.1.2". */
  table: string;
  title: string;
  printedPages: number[];
  referenceYears: number[];
  figureBasis: string[];
  units: string[];
  rows: OutRow[];
  gaps: string[];
  problems: string[];
}

export interface Ctx {
  infos: PageInfo[];
  index: RegionIndex;
  coverage: string;
}

interface Found {
  start: PageInfo;
  pages: PageInfo[];
}

type RowKind = "kabkota" | "kecamatan" | "kelurahan" | null;

export function rowKindOf(headKey: string): RowKind {
  const m = /menurut(kabupaten\/kota|kecamatan|kelurahan|desa\/kelurahan|desa)/.exec(headKey);
  if (!m) return null;
  if (m[1] === "kabupaten/kota") return "kabkota";
  if (m[1] === "kecamatan") return "kecamatan";
  return "kelurahan";
}

function levelOk(kind: RowKind, coverageLevel: number): boolean {
  if (kind === null) return true;
  if (kind === "kabkota") return coverageLevel === 1;
  if (kind === "kecamatan") return coverageLevel === 2;
  return coverageLevel >= 2;
}

/** The first non-continuation page whose title matches, with its "Lanjutan" pages. */
export function findTable(ctx: Ctx, test: (headKey: string) => boolean, nth = 0): Found | null {
  const coverageLevel = levelOfCode(ctx.coverage);
  let seen = 0;
  for (let i = 0; i < ctx.infos.length; i++) {
    const info = ctx.infos[i]!;
    if (info.continued || info.tableNumber === null || !test(info.headKey)) continue;
    if (!levelOk(rowKindOf(info.headKey), coverageLevel)) continue;
    if (seen++ < nth) continue;
    const pages = [info];
    for (let j = i + 1; j < ctx.infos.length; j++) {
      const next = ctx.infos[j]!;
      const prev = pages[pages.length - 1]!;
      if (next.page.no !== prev.page.no + 1 || !next.continued || next.tableNumber !== info.tableNumber) break;
      pages.push(next);
    }
    return { start: info, pages };
  }
  return null;
}

/** The Indonesian part of a heading: everything before the English translation line. */
export function indonesianTitle(head: string): string {
  const flat = head.replace(/\s+/g, " ").trim();
  const eng = flat.search(/\s(Population|Average|Monthly|Number|Percentage|Poor|Gross)\b/);
  return (eng > 0 ? flat.slice(0, eng) : flat).slice(0, 240);
}

function blank(id: string, found: Found): TableResult {
  return {
    id,
    table: found.start.tableNumber ?? "?",
    title: indonesianTitle(found.start.head),
    printedPages: [],
    referenceYears: [],
    figureBasis: [],
    units: [],
    rows: [],
    gaps: [],
    problems: [],
  };
}

function unitOfHead(info: PageInfo, fallback?: string): string | null {
  if (/ribujiwa|thousandpeople|thousandpersons/.test(info.headKey)) return "ribu_jiwa";
  if (/\(rupiah|\(rupiahs/.test(info.headKey)) return "rupiah";
  if (/\(jiwa\)|\(person\)/.test(info.headKey)) return "jiwa";
  return fallback ?? null;
}

function titleYears(info: PageInfo): number[] {
  // years of the Indonesian title only: stop at the English translation
  const eng = info.head.search(/\b(Population|Average|Monthly|Table|Number)\b/);
  const text = eng > 0 ? info.head.slice(0, eng) : info.head;
  return [...new Set([...text.matchAll(/\b((?:19|20)\d{2})\b/g)].map((m) => Number(m[1])))];
}

export function basisOf(infos: PageInfo | PageInfo[], year: number): string | null {
  const list = Array.isArray(infos) ? infos : [infos];
  const t = list.map((i) => i.headKey + i.notesKey).join("");
  const info = { headKey: list[0]!.headKey };
  if (/registrasi|dkb|konsolidasibersih|siak|catatansipil|dukcapil|kementerianagama|kantorkementerianagama/.test(t)) return "registration";
  if (/sakernas|susenas|survei/.test(t)) return "survey_estimate";
  if (year <= 2020 && year % 10 === 0 && /sensus/.test(t) && !/proyeksi/.test(info.headKey)) return "census";
  if (/proyeksi/.test(t)) return "projection";
  return null;
}

function mk(
  info: PageInfo,
  table: string,
  region: { code: string; name: string },
  dimension: string,
  category: string,
  sex: string,
  cell: string | undefined,
  unit: string,
  year: number,
  basis: string,
  universe: string,
  label = ""
): OutRow | null {
  if (cell === undefined) return null;
  const p = parseCell(cell);
  if (p.kind === "na" || p.kind === "text") return null;
  return {
    region_code: region.code,
    region_level: levelOfCode(region.code),
    source_region_name: region.name,
    dimension,
    category,
    sex,
    value: p.value ?? "0",
    unit,
    reference_year: year,
    figure_basis: basis,
    universe,
    source_table: table,
    source_page: info.printedPage,
    value_note: p.kind === "nil" ? "nil" : "",
    category_label: label,
  };
}

function totalLabel(label: string): boolean {
  return /^jumlah(\s*\/\s*total)?$|^total$/i.test(label.trim());
}

function sexColumns(info: PageInfo, firstData: number, titleYear: number | null) {
  const words = headerWords(info, 60);
  const groups: { key: string; cx: number; text: string }[] = [];
  for (const w of words) {
    if (cx(w) < info.markers[firstData]!.cx - 40) continue;
    if (/^laki-?laki$/i.test(w.text)) groups.push({ key: "laki_laki", cx: cx(w), text: w.text });
    else if (/^perempuan$/i.test(w.text)) groups.push({ key: "perempuan", cx: cx(w), text: w.text });
    else if (/^jumlah$/i.test(w.text)) groups.push({ key: "jumlah", cx: cx(w), text: w.text });
    else if (/^rasio$/i.test(w.text)) groups.push({ key: "rasio", cx: cx(w), text: w.text });
  }
  const years = words.filter((w) => /^(?:19|20)\d{2}$/.test(w.text));
  const cols: { pos: number; group: string; year: number | null; label: string }[] = [];
  for (let k = firstData; k < info.markers.length; k++) {
    const m = info.markers[k]!;
    let best: { key: string; d: number; text: string } | null = null;
    for (const g of groups) {
      const d = Math.abs(g.cx - m.cx);
      if (!best || d < best.d) best = { key: g.key, d, text: g.text };
    }
    let year: number | null = titleYear;
    if (years.length) {
      const near = years.filter((y) => nearestMarker(info, cx(y), firstData) === k);
      if (near.length === 1) year = Number(near[0]!.text);
      else if (near.length > 1) year = null;
    }
    cols.push({ pos: k, group: best?.key ?? "?", year, label: best?.text ?? "" });
  }
  return cols;
}

const DISTRICT_TOTAL = /^jumlah\s+di\s+(?:kecamatan|kelurahan|desa)\s+(.+?)(?:\s+total\s+in\b.*)?$/i;

interface RegionState {
  hint: KindHint;
  district: string | null;
}

/** Resolves the region(s) of a body row; null when the row names none. */
function rowRegion(
  ctx: Ctx,
  row: BodyRow,
  st: RegionState,
  parent: string,
  problems: string[]
): { code: string; name: string; subtotal: boolean } | null | "skip" {
  const g = kindFromGroupLine(row.label1);
  if (g !== undefined) {
    st.hint = g;
    return "skip";
  }
  const m1 = row.label1.trim();
  const m2 = row.label2.trim();
  const dt = DISTRICT_TOTAL.exec(m1) ?? DISTRICT_TOTAL.exec(m2);
  if (dt) {
    const r = resolveLabel(ctx.index, ctx.coverage, dt[1]!, null);
    if (r.status !== "ok") {
      problems.push(`district total "${dt[1]}": ${r.status} ${r.candidates.join(",")}`);
      return "skip";
    }
    return { code: r.code!, name: dt[1]!, subtotal: true };
  }
  let label = m2 !== "" ? m2 : m1;
  let scope = parent;
  if (m2 !== "" && m1 !== "") {
    const d = resolveLabel(ctx.index, ctx.coverage, m1, st.hint);
    if (d.status !== "ok") {
      problems.push(`district "${m1}": ${d.status} ${d.candidates.join(",")}`);
      return "skip";
    }
    st.district = d.code;
  }
  if (m2 !== "" && st.district) scope = st.district;
  else if (m2 === "" && m1 !== "") {
    st.district = null;
  }
  if (label === "") return "skip";
  const r = resolveLabel(ctx.index, scope, label, st.hint, row.last);
  if (r.status === "ok") {
    if (m2 === "" && m1 !== "" && r.code !== ctx.coverage) st.district = r.code;
    return { code: r.code!, name: label.replace(/^\s*\d{1,3}\.\s*/, ""), subtotal: false };
  }
  problems.push(`row "${label}": ${r.status} ${r.candidates.join(",")}`);
  return "skip";
}

/** Age/religion/total row classification for rows that are not regions. */
function categoryOfRow(label: string): { dimension: string; category: string } | null {
  const age = ageBandKey(label.replace(/^\s*\d{1,3}\.\s*(?=\d)/, ""));
  if (age) return { dimension: "age_group", category: age };
  return null;
}

const RELIGIONS: [RegExp, string][] = [
  [/islam/, "islam"],
  [/protestan|kristen|protestant/, "kristen"],
  [/katolik|catholic/, "katolik"],
  [/hindu/, "hindu"],
  [/bud+ha/, "buddha"],
  [/kh?ongh?ucu/, "khonghucu"],
  [/kepercayaan|belief/, "kepercayaan"],
  [/lainnya|others/, "lainnya"],
];

export function religionKey(text: string): string | null {
  const t = text.toLowerCase().replace(/\s+/g, "");
  for (const [re, key] of RELIGIONS) if (re.test(t)) return key === "buddha" ? "buddha" : key;
  return null;
}

/* ------------------------------------------------------------------ */

/** 3.1.1 - population (total) per region. */
export function totalByRegion(ctx: Ctx): TableResult | null {
  const found = findTable(ctx, (k) => /lajupertumbuhanpenduduk/.test(k) && /menurut(kabupaten\/kota|kecamatan)/.test(k));
  if (!found) return null;
  const res = blank("total-by-region", found);
  const info = found.start;
  const tbl = info.tableNumber!;
  const L = labelColumnCount(info);
  const hw = headerWords(info, 70);
  const yearWords = hw.filter((w) => /^(?:19|20)\d{2}$/.test(w.text) && cx(w) > info.markers[1]!.cx - 30);
  const unit = unitOfHead(info);
  if (!unit || unit === "rupiah") {
    res.problems.push("population unit not stated in the heading");
    return res;
  }
  const cols: { pos: number; year: number }[] = [];
  for (let k = L; k < info.markers.length; k++) {
    const near = yearWords.filter((w) => nearestMarker(info, cx(w), L) === k);
    if (near.length === 1) {
      cols.push({ pos: k, year: Number(near[0]!.text) });
    } else if (near.length === 0) {
      const bandText = hw
        .filter((w) => nearestMarker(info, cx(w), L) === k)
        .map((w) => w.text)
        .join(" ");
      const years = titleYears(info);
      if (/penduduk/i.test(bandText) && !/laju|persentase|kepadatan|rasio|distribusi/i.test(bandText) && years.length === 1) {
        cols.push({ pos: k, year: years[0]! });
      }
    }
  }
  if (cols.length === 0) {
    res.problems.push("no population column recognised");
    return res;
  }
  const st: RegionState = { hint: null, district: null };
  for (const row of readBody(info, L)) {
    const r = rowRegion(ctx, row, st, ctx.coverage, res.problems);
    if (r === "skip" || r === null || !row.hasNum) continue;
    for (const c of cols) {
      const basis = basisOf(found.pages, c.year);
      if (!basis) {
        res.problems.push(`basis of ${c.year} not determinable`);
        continue;
      }
      const o = mk(info, tbl, r, "total", "total", "", row.cells[c.pos], unit, c.year, basis, "total_population");
      if (o) res.rows.push(o);
    }
  }
  finish(res, [info]);
  return res;
}

/** 3.1.2 / 3.1.3 / 3.1.4(reg) / 4.3.4: sex columns; rows are age bands, regions or religions. */
export function sexTable(
  ctx: Ctx,
  id: string,
  test: (k: string) => boolean,
  rowMode: "age" | "region" | "religion",
  nth = 0
): TableResult | null {
  const found = findTable(ctx, test, nth);
  if (!found) return null;
  const res = blank(id, found);
  const tbl = found.start.tableNumber!;
  for (const info of found.pages) {
    const L = labelColumnCount(info);
    const unit = unitOfHead(found.start, rowMode === "religion" ? "jiwa" : undefined);
    if (!unit || unit === "rupiah") {
      res.problems.push("unit not stated in the heading");
      return res;
    }
    const ty = titleYears(found.start);
    const cols = sexColumns(info, L, ty.length === 1 ? ty[0]! : null);
    const st: RegionState = { hint: null, district: null };
    for (const row of readBody(info, L)) {
      if (!row.hasNum) continue;
      const label = (row.label2 || row.label1).trim();
      let dimBase: { dimension: string; category: string } | null = null;
      let region: { code: string; name: string } | null = null;
      if (rowMode === "age") {
        dimBase = categoryOfRow(label);
        if (!dimBase) {
          if (totalLabel(label)) {
            dimBase = { dimension: "total", category: "total" };
          } else {
            const r = rowRegion(ctx, row, st, ctx.coverage, res.problems);
            if (r === "skip" || r === null) continue;
            region = r;
          }
        }
        if (!region) region = { code: ctx.coverage, name: ctx.index.byCode.get(ctx.coverage)?.name ?? ctx.coverage };
      } else if (rowMode === "religion") {
        region = { code: ctx.coverage, name: ctx.index.byCode.get(ctx.coverage)?.name ?? ctx.coverage };
        if (totalLabel(label)) dimBase = { dimension: "total", category: "total" };
        else {
          const k = religionKey(label);
          if (!k) {
            res.problems.push(`religion label "${label}" not recognised`);
            continue;
          }
          dimBase = { dimension: "religion", category: k };
        }
      } else {
        const r = rowRegion(ctx, row, st, ctx.coverage, res.problems);
        if (r === "skip" || r === null) continue;
        region = r;
      }
      for (const c of cols) {
        if (c.group === "rasio" || c.group === "?") continue;
        if (c.year === null) {
          res.problems.push("year of a column not determinable");
          continue;
        }
        const basis = basisOf(found.pages, c.year);
        if (!basis) {
          res.problems.push(`basis of ${c.year} not determinable`);
          continue;
        }
        const cell = row.cells[c.pos];
        let o: OutRow | null;
        if (dimBase) {
          // age / religion rows keep the sex of the column; their total row is the sex dimension
          if (dimBase.dimension === "total") {
            o =
              c.group === "jumlah"
                ? mk(info, tbl, region!, "total", "total", "", cell, unit, c.year, basis, "total_population")
                : mk(info, tbl, region!, "sex", c.group, "", cell, unit, c.year, basis, "total_population", c.label);
          } else {
            o = mk(info, tbl, region!, dimBase.dimension, dimBase.category, c.group === "jumlah" ? "" : c.group, cell, unit, c.year, basis, "total_population", label.replace(/^\s*\d{1,3}\.\s*(?=\D)/, ""));
          }
        } else {
          o =
            c.group === "jumlah"
              ? mk(info, tbl, region!, "total", "total", "", cell, unit, c.year, basis, "total_population")
              : mk(info, tbl, region!, "sex", c.group, "", cell, unit, c.year, basis, "total_population", c.label);
        }
        if (o) res.rows.push(o);
      }
    }
  }
  finish(res, found.pages);
  return res;
}

/** 3.1.4 (province): age groups down, regions across (several column pages). */
export function ageByRegionColumns(ctx: Ctx): TableResult | null {
  const found = findTable(ctx, (k) => /menurutkelompokumurdan(kabupaten\/kota|kecamatan)/.test(k));
  if (!found) return null;
  const res = blank("age-by-region", found);
  const tbl = found.start.tableNumber!;
  const unit = unitOfHead(found.start);
  const ty = titleYears(found.start);
  if (!unit || unit === "rupiah" || ty.length !== 1) {
    res.problems.push("unit or year not determinable");
    return res;
  }
  const basis = basisOf(found.pages, ty[0]!);
  if (!basis) {
    res.problems.push("basis not determinable");
    return res;
  }
  for (const info of found.pages) {
    const names = new Map<number, string>();
    const hw = headerWords(info, 60).filter(
      (w) => cx(w) > info.markers[0]!.cx + (info.markers[1]!.cx - info.markers[0]!.cx) / 2 && !/^(kabupaten\/kota|regency\/municipality)$/i.test(w.text)
    );
    for (let k = 1; k < info.markers.length; k++) {
      const band = hw.filter((w) => nearestMarker(info, cx(w), 1) === k);
      const lines = clusterLines(band, 3);
      names.set(k, lines.map((l) => l.map((w) => w.text).join(" ")).join(" "));
    }
    const regionOf = new Map<number, { code: string; name: string }>();
    for (const [k, name] of names) {
      const r = resolveLabel(ctx.index, ctx.coverage, name, null);
      if (r.status === "ok") regionOf.set(k, { code: r.code!, name });
      else res.problems.push(`column header "${name}": ${r.status} ${r.candidates.join(",")}`);
    }
    for (const row of readBody(info, 1)) {
      if (!row.hasNum) continue;
      const label = row.label1.trim();
      const band = categoryOfRow(label);
      const isTotal = totalLabel(label);
      if (!band && !isTotal) continue;
      for (const [k, region] of regionOf) {
        const o = band
          ? mk(info, tbl, region, band.dimension, band.category, "", row.cells[k], unit, ty[0]!, basis, "total_population", label)
          : mk(info, tbl, region, "total", "total", "", row.cells[k], unit, ty[0]!, basis, "total_population");
        if (o) res.rows.push(o);
      }
    }
  }
  finish(res, found.pages);
  return res;
}

/** 4.5.4 / 4.3.1: religion columns, region rows (columns may continue over pages). */
export function religionByRegion(ctx: Ctx, nth = 0): TableResult | null {
  const found = findTable(ctx, (k) => /menurut(kabupaten\/kota|kecamatan|kelurahan|desa)danagama/.test(k), nth);
  if (!found) return null;
  const res = blank("religion-by-region", found);
  const tbl = found.start.tableNumber!;
  const ty = titleYears(found.start);
  if (ty.length !== 1) {
    res.problems.push("year not determinable");
    return res;
  }
  const basis = basisOf(found.pages, ty[0]!);
  if (!basis) {
    res.problems.push("basis not determinable");
    return res;
  }
  const st: RegionState = { hint: null, district: null };
  for (const info of found.pages) {
    const L = labelColumnCount(info);
    const hw = headerWords(info, 60);
    const colKey = new Map<number, string>();
    const colLabel = new Map<number, string>();
    for (let k = L; k < info.markers.length; k++) {
      const text = hw
        .filter((w) => nearestMarker(info, cx(w), L) === k)
        .map((w) => w.text)
        .join(" ");
      const key = /jumlah|total/i.test(text) && !religionKey(text) ? "total" : religionKey(text);
      if (key) {
        colKey.set(k, key);
        const band = hw.filter((w) => nearestMarker(info, cx(w), L) === k);
        colLabel.set(k, clusterLines(band.filter((w) => religionKey(w.text) !== null), 3)[0]?.map((w) => w.text).join(" ") ?? "");
      } else res.problems.push(`religion column ${k + 1} header "${text}" not recognised`);
    }
    for (const row of readBody(info, L)) {
      const r = rowRegion(ctx, row, st, ctx.coverage, res.problems);
      if (r === "skip" || r === null || !row.hasNum) continue;
      for (const [k, key] of colKey) {
        const o =
          key === "total"
            ? mk(info, tbl, r, "total", "total", "", row.cells[k], "jiwa", ty[0]!, basis, "total_population")
            : mk(info, tbl, r, "religion", key, "", row.cells[k], "jiwa", ty[0]!, basis, "total_population", colLabel.get(k) ?? "");
        if (o) res.rows.push(o);
      }
    }
  }
  finish(res, found.pages);
  return res;
}

/**
 * Short stable key for an industry group: the KBLI 2020 section letters when the
 * footnote states them ("A, B. Pertanian ..."), otherwise a slug of the first four
 * words, at most 40 characters. The full label travels in category_label.
 */
export function shortIndustryKey(label: string): string {
  const letters = /^\(?([A-U](?:\s*[,;&]\s*[A-U])*)\)?\s*[.:\-)]\s/.exec(label);
  if (letters) return letters[1]!.toLowerCase().replace(/[^a-u]+/g, "_");
  const slug = snakeCase(label.split(/\s+/).slice(0, 4).join(" "));
  return slug.length <= 40 ? slug : slug.slice(0, 40).replace(/_[^_]*$/, "");
}

/** Parses "Catatan" footnotes "1. <Indonesian>/<English>" into group labels. */
export function footnoteLabels(info: PageInfo): Map<string, string> {
  const out = new Map<string, string>();
  const items: { n: string; lines: string[] }[] = [];
  for (const rawLine of info.noteLines) {
    const line = rawLine[0] && /^catatan/i.test(rawLine[0].text) ? rawLine.slice(1) : rawLine;
    const first = line[0];
    if (!first) continue;
    const m = /^([1-9])\.$/.exec(first.text);
    if (m) {
      items.push({ n: m[1]!, lines: [line.slice(1).map((w) => w.text).join(" ")] });
    } else if (items.length && !/^(sumber|catatan)/i.test(first.text)) {
      items[items.length - 1]!.lines.push(line.map((w) => w.text).join(" "));
    }
  }
  for (const it of items) {
    const joined = it.lines.join(" ");
    const slash = /\/(?=[A-Z])/.exec(joined);
    if (it.lines.length === 1 && slash) {
      out.set(it.n, joined.slice(0, slash.index).trim());
    } else if (it.lines.length >= 2 && it.lines.length % 2 === 0) {
      out.set(it.n, it.lines.slice(0, it.lines.length / 2).join(" ").replace(/\s+/g, " ").trim());
    } else if (slash) {
      out.set(it.n, joined.slice(0, slash.index).trim());
    }
  }
  return out;
}

/**
 * 3.2.14 (employed by industry group) and 3.2.30 (net wage by industry group):
 * region rows, columns are numbered industry groups plus a total/average column.
 */
export function industryByRegion(ctx: Ctx, kind: "employed" | "wage"): TableResult | null {
  const found = findTable(ctx, (k) =>
    kind === "employed"
      ? /pendudukberumur15tahunkeatasyangbekerja.*menurut(kabupaten\/kota|kecamatan)danlapanganpekerjaanutama/.test(k)
      : /upah\/gajibersih.*menurut(kabupaten\/kota|kecamatan)danlapanganpekerjaan/.test(k)
  );
  if (!found) return null;
  const res = blank(kind === "employed" ? "employed-by-industry" : "wage-by-industry", found);
  return industryColumns(ctx, found, res, kind, "region");
}

/** 3.2.31: net wage by age group; rows are age bands, columns industry groups plus an average. */
export function wageByAge(ctx: Ctx): TableResult | null {
  const found = findTable(ctx, (k) => /upah\/gajibersih.*menurutkelompokumurdanlapanganpekerjaan/.test(k));
  if (!found) return null;
  const res = blank("wage-by-age", found);
  return industryColumns(ctx, found, res, "wage", "age");
}

function industryColumns(ctx: Ctx, found: Found, res: TableResult, kind: "employed" | "wage", rows: "region" | "age"): TableResult {
  const info = found.start;
  const tbl = info.tableNumber!;
  const ty = titleYears(info);
  if (ty.length !== 1) {
    res.problems.push("year not determinable");
    return res;
  }
  const year = ty[0]!;
  const basis = basisOf(found.pages, year);
  if (!basis) {
    res.problems.push("basis not determinable");
    return res;
  }
  const unit = kind === "wage" ? "rupiah" : "jiwa";
  const labels = footnoteLabels(info);
  const hw = headerWords(info, 60);
  const colKind = new Map<number, { group?: string; total?: boolean }>();
  for (let k = 1; k < info.markers.length; k++) {
    const band = hw.filter((w) => nearestMarker(info, cx(w), 1) === k);
    const texts = band.map((w) => w.text);
    if (texts.some((t) => /^(jumlah|rata-?rata)$/i.test(t))) {
      colKind.set(k, { total: true });
      continue;
    }
    const digits = texts.filter((t) => /^[1-9]$/.test(t));
    if (digits.length === 1) colKind.set(k, { group: digits[0]! });
  }
  const st: RegionState = { hint: null, district: null };
  for (const row of readBody(info, 1)) {
    if (!row.hasNum) continue;
    const label = row.label1.trim();
    let region: { code: string; name: string };
    let prefix = "";
    let totalDim: { dimension: string; category: string };
    if (rows === "age") {
      region = { code: ctx.coverage, name: ctx.index.byCode.get(ctx.coverage)?.name ?? ctx.coverage };
      const band = ageBandKey(label);
      if (band) {
        prefix = `kelompok_umur/${band}`;
      } else {
        const r = rowRegion(ctx, row, st, ctx.coverage, res.problems);
        if (r === "skip" || r === null) continue;
        prefix = "";
      }
      totalDim = { dimension: kind === "wage" ? "income" : "occupation", category: prefix || "total" };
      // age-by-industry cross-tabs have no contract category: only the average column is stored
      const col = [...colKind.entries()].find(([, v]) => v.total);
      if (!col) {
        res.problems.push("no average column");
        return res;
      }
      const o = mk(info, tbl, region, totalDim.dimension, totalDim.category, "", row.cells[col[0]], unit, year, basis, kind === "wage" ? "employees" : "employed_15_plus", prefix ? label : "");
      if (o) res.rows.push(o);
      continue;
    }
    const r = rowRegion(ctx, row, st, ctx.coverage, res.problems);
    if (r === "skip" || r === null) continue;
    for (const [k, v] of colKind) {
      if (v.total) {
        const o =
          kind === "wage"
            ? mk(info, tbl, r, "income", "total", "", row.cells[k], unit, year, basis, "employees")
            : mk(info, tbl, r, "total", "total", "", row.cells[k], unit, year, basis, "employed_15_plus");
        if (o) res.rows.push(o);
      } else {
        const lab = labels.get(v.group!);
        if (!lab) {
          if (!res.gaps.some((g) => g.includes(`group ${v.group}`))) res.gaps.push(`industry group ${v.group}: footnote label not parseable; its column is not stored`);
          continue;
        }
        const key = shortIndustryKey(lab);
        const o =
          kind === "wage"
            ? mk(info, tbl, r, "income", `lapangan_pekerjaan_utama/${key}`, "", row.cells[k], unit, year, basis, "employees", lab)
            : mk(info, tbl, r, "occupation", key, "", row.cells[k], unit, year, basis, "employed_15_plus", lab);
        if (o) res.rows.push(o);
      }
    }
  }
  if (rows === "age") res.gaps.push("age group by industry cross-tab columns are not stored (only the per-age average)");
  finish(res, [info]);
  return res;
}

/** 10.1 - monthly per-capita expenditure by commodity group (regency/city publications). */
export function expenditureTable(ctx: Ctx): TableResult | null {
  const found = findTable(ctx, (k) => /rata-?ratapengeluaranperkapitasebulanmenurutkelompokkomoditasdi(kota|kabupaten|provinsi)/.test(k));
  if (!found) return null;
  const res = blank("expenditure-by-commodity", found);
  const info = found.start;
  const tbl = info.tableNumber!;
  const hw = headerWords(info, 45);
  const years = new Map<number, number>();
  for (const w of hw) {
    if (/^(?:19|20)\d{2}$/.test(w.text)) years.set(nearestMarker(info, cx(w), 1), Number(w.text));
  }
  if (years.size === 0) {
    res.problems.push("no year column recognised");
    return res;
  }
  const region = { code: ctx.coverage, name: ctx.index.byCode.get(ctx.coverage)?.name ?? ctx.coverage };
  for (const row of readBody(info, 1)) {
    if (!row.hasNum) continue;
    const indo = indonesianPart(row.label1).trim();
    const key = totalLabel(indo) ? "total" : `kelompok_komoditas/${snakeCase(indo)}`;
    for (const [k, year] of years) {
      const basis = basisOf(found.pages, year) ?? "survey_estimate";
      const o = mk(info, tbl, region, "expenditure", key, "", row.cells[k], "rupiah", year, basis, "per_capita", totalLabel(indo) ? "" : indo);
      if (o) res.rows.push(o);
    }
  }
  finish(res, [info]);
  return res;
}

function finish(res: TableResult, infos: PageInfo[]): void {
  // A heading that says "(jiwa)" over figures printed with decimals is a printing error in
  // the source (persons are whole numbers). The digits are kept; only the unit label is
  // corrected, to the thousands the decimals imply, and the correction is recorded.
  const people = res.rows.filter((r) => r.unit === "jiwa" && r.dimension !== "occupation" && r.universe !== "employed_15_plus");
  if (people.some((r) => r.value.includes("."))) {
    if (people.every((r) => r.value.includes(".") || r.value === "0")) {
      for (const r of people) r.unit = "ribu_jiwa";
      res.gaps.push("the heading states 'jiwa' but every figure carries decimals (whole persons cannot); stored as ribu_jiwa with the digits unchanged");
    } else {
      res.problems.push("heading says jiwa but only some figures carry decimals");
    }
  }
  res.printedPages = [...new Set(infos.map((i) => i.printedPage).filter((p): p is number => p !== null))];
  res.referenceYears = [...new Set(res.rows.map((r) => r.reference_year))].sort();
  res.figureBasis = [...new Set(res.rows.map((r) => r.figure_basis))];
  res.units = [...new Set(res.rows.map((r) => r.unit))];
  if (res.rows.length === 0 && res.problems.length === 0) res.problems.push("no rows read");
}

export type { Word };
