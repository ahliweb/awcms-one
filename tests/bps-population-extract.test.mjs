/**
 * Unit tests for the BPS population extractor (tools/bps-population/extract).
 * Fixtures are real pages cut from the "Dalam Angka 2026" PDFs
 * (tests/fixtures/bps-population/), not hand-typed values.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ageBandKey, indonesianPart, parseCell, snakeCase } from "../tools/bps-population/extract/cells.ts";
import { dedupe, runChecks, toScaled } from "../tools/bps-population/extract/checks.ts";
import { parseFrontMatter, coverageOfDomain, attributionSentence } from "../tools/bps-population/extract/meta.ts";
import { csvField, rowsToCsv, CSV_HEADER } from "../tools/bps-population/extract/output.ts";
import {
  buildIndex,
  kindFromGroupLine,
  normalizeLabel,
  parseWilayahSql,
  resolveLabel,
} from "../tools/bps-population/extract/regions.ts";
import { analysePage, joinLabel, readBody } from "../tools/bps-population/extract/rows.ts";
import { footnoteLabels, industryByRegion, religionByRegion, religionKey, sexTable, shortIndustryKey, villageSex } from "../tools/bps-population/extract/tables.ts";
import { recordResult, websiteOfHost } from "../tools/bps-population/extract/run.ts";
import { parseBboxPages } from "../tools/bps-population/extract/words.ts";

const FIX = new URL("./fixtures/bps-population/", import.meta.url).pathname;
const WILAYAH = new URL("../apps/cms/data/idn-admin-regions/upstream/cahyadsn-wilayah/db/wilayah.sql", import.meta.url).pathname;

const fixture = (name) => readFileSync(FIX + name, "utf8");
const pageOf = (name, no = 1) => parseBboxPages(fixture(name), no)[0];
const index = buildIndex(parseWilayahSql(readFileSync(WILAYAH, "utf8")));
const ctxOf = (name, coverage) => ({ infos: [analysePage(pageOf(name))], index, coverage });

describe("number parsing", () => {
  test("Indonesian formats are read digit for digit", () => {
    assert.deepEqual(parseCell("2.844,99"), { kind: "num", value: "2844.99", decimals: 2 });
    assert.equal(parseCell("14.243").value, "14243");
    assert.equal(parseCell("1.417.683").value, "1417683");
    assert.equal(parseCell("288,56").value, "288.56");
    assert.equal(parseCell("1483,00").value, "1483.00");
    assert.equal(parseCell("75").value, "75");
  });

  test("the printed typographic variants are accepted without changing the figure", () => {
    assert.equal(parseCell("1467,14").value, "1467.14"); // no thousands separator (province total row)
    assert.equal(parseCell("1 483,00").value, "1483.00"); // a space as thousands separator
  });

  test("nil symbols become 0 with a nil kind; not-available markers yield nothing", () => {
    for (const s of ["–", "-", "_", "—"]) assert.deepEqual(parseCell(s), { kind: "nil", value: "0", decimals: 0 });
    assert.equal(parseCell("...").kind, "na");
    assert.equal(parseCell("…").kind, "na");
  });

  test("labels are text, never numbers", () => {
    for (const s of ["0–4", "75+", "Kapuas", "1.", "2.84.9"]) assert.equal(parseCell(s).kind, "text", s);
  });

  test("age bands map to contract keys", () => {
    assert.equal(ageBandKey("0–4"), "0-4");
    assert.equal(ageBandKey("10-14"), "10-14");
    assert.equal(ageBandKey("75+"), "75+");
    assert.equal(ageBandKey("60+"), "60+");
    assert.equal(ageBandKey("Kapuas"), null);
  });

  test("snake_case and bilingual labels", () => {
    assert.equal(snakeCase("Pertanian, Kehutanan dan Perikanan"), "pertanian_kehutanan_dan_perikanan");
    assert.equal(indonesianPart("Ikan/udang/cumi/kerang/Fish/shrimp/common squid/shells"), "Ikan/udang/cumi/kerang");
    assert.equal(indonesianPart("Padi-padian/Cereals"), "Padi-padian");
    assert.equal(indonesianPart("Keperluan pesta dan upacara/kenduri/Parties and ceremonies"), "Keperluan pesta dan upacara/kenduri");
  });
});

describe("watermark and superscript stripping", () => {
  test("the diagonal watermark fragments never reach the word list", () => {
    const page = pageOf("prov-3.1.1-distribution-swapped-rows.bbox.xml");
    const texts = new Set(page.words.map((w) => w.text));
    for (const frag of [".id", "go", "s.", ".b", "ng", "te", "al", "//k", "s:", "tp", "ht"]) {
      assert.ok(!texts.has(frag), `watermark fragment ${frag} survived`);
    }
    assert.ok(texts.has("Kotawaringin"));
  });

  test("footnote superscripts are dropped from year headers", () => {
    const page = pageOf("prov-3.1.1-distribution-swapped-rows.bbox.xml");
    const years = page.words.filter((w) => /^20\d\d$/.test(w.text) && w.y0 > 150 && w.y0 < 215).map((w) => w.text);
    assert.deepEqual(years.sort(), ["2020", "2025", "2026"]);
  });

  test("a letter-spaced label is rejoined", () => {
    assert.equal(joinLabel(["3.", "K", "a", "p", "u", "a", "s"]), "3. Kapuas");
    assert.equal(joinLabel(["Pulang", "Pisau"]), "Pulang Pisau");
  });
});

describe("column assignment by x-position", () => {
  test("rows whose numbers the text layer emitted out of order keep their own values", () => {
    const info = analysePage(pageOf("prov-3.1.1-distribution-swapped-rows.bbox.xml"));
    const rows = readBody(info, 1);
    const kapuas = rows.find((r) => r.label1.includes("Kapuas"));
    const selatan = rows.find((r) => r.label1.includes("Barito Selatan"));
    assert.deepEqual(kapuas.cells.slice(1), ["15,37", "15,29", "15,27"]);
    assert.deepEqual(selatan.cells.slice(1), ["4,91", "4,82", "4,80"]);
  });

  test("a stray watermark glyph between columns is not a label", () => {
    const info = analysePage(pageOf("prov-3.1.3-sex-by-regency.bbox.xml"));
    const rows = readBody(info, 1);
    const sukamara = rows.find((r) => r.label1.includes("Sukamara"));
    assert.equal(sukamara.label1, "6. Sukamara");
    assert.deepEqual(sukamara.cells.slice(1, 4), ["35,97", "33,01", "68,98"]);
  });

  test("nil symbols and a repeated column marker are read as printed", () => {
    const info = analysePage(pageOf("prov-4.5.4-religion-continued.bbox.xml"));
    const rows = readBody(info, 1);
    const timur = rows.find((r) => r.label1.includes("Kotawaringin Timur"));
    assert.deepEqual(timur.cells.slice(1), ["1.289", "94", "–"]);
  });
});

describe("name to Kemendagri code mapping", () => {
  test("a printed name resolves against the children of the covered region", () => {
    assert.equal(resolveLabel(index, "62", "3. Kapuas").code, "62.03");
    assert.equal(resolveLabel(index, "62", "14. Palangka Raya").code, "62.71"); // "Kota Palangkaraya"
    assert.equal(resolveLabel(index, "62", "Kalimantan Tengah").code, "62"); // total row names the region itself
  });

  test("unknown names are reported, never guessed", () => {
    const r = resolveLabel(index, "62", "99. Atlantis");
    assert.equal(r.status, "unmatched");
    assert.equal(r.code, null);
  });

  test("same-name siblings are ambiguous without a kind hint and resolved with one", () => {
    const bare = resolveLabel(index, "33", "Magelang");
    assert.equal(bare.status, "ambiguous");
    assert.deepEqual(bare.candidates.sort(), ["33.08", "33.71"]);
    assert.equal(resolveLabel(index, "33", "Magelang", "kota").code, "33.71");
    assert.equal(resolveLabel(index, "33", "Magelang", "kabupaten").code, "33.08");
    assert.equal(resolveLabel(index, "33", "Kota Magelang").code, "33.71");
    assert.equal(kindFromGroupLine("Kota/Municipality"), "kota");
    assert.equal(kindFromGroupLine("Kabupaten/Regency"), "kabupaten");
  });

  test("a documented spelling variant resolves only inside its own regency", () => {
    assert.equal(resolveLabel(index, "62.13", "Benua Lima").code, "62.13.02");
    assert.equal(resolveLabel(index, "62.12", "Benua Lima").status, "unmatched");
  });

  test("apostrophes, straight or typographic, do not split a name", () => {
    assert.equal(normalizeLabel("Ba'a"), normalizeLabel("Ba’a"));
    assert.equal(normalizeLabel("Baʼa"), normalizeLabel("Ba'a"));
  });

  test("a village is resolved inside its own kecamatan only", () => {
    assert.equal(resolveLabel(index, "62.71.01", "001. Pahandut").code, "62.71.01.1001");
    assert.equal(resolveLabel(index, "62.71.04", "001. Pahandut").status, "unmatched");
  });
});

describe("table handlers on real pages", () => {
  const sexTest = (k) => /^jumlahpenduduk(dan|menurut)?(rasio)?jeniskelamin/.test(k);

  test("province: sex per regency (3.1.3) reads every cell and the province total", () => {
    const res = sexTable(ctxOf("prov-3.1.3-sex-by-regency.bbox.xml", "62"), "t", sexTest, "region");
    assert.deepEqual(res.problems, []);
    const get = (code, dim, cat) => res.rows.find((r) => r.region_code === code && r.dimension === dim && r.category === cat);
    assert.equal(get("62.03", "sex", "laki_laki").value, "223.72");
    assert.equal(get("62.03", "total", "total").value, "435.07");
    assert.equal(get("62.71", "sex", "perempuan").value, "156.80");
    assert.equal(get("62", "sex", "laki_laki").value, "1467.14");
    assert.equal(get("62", "total", "total").value, "2844.99");
    assert.ok(res.rows.every((r) => r.unit === "ribu_jiwa" && r.figure_basis === "projection" && r.reference_year === 2025));
    assert.equal(res.rows.length, 45); // 14 regencies/cities + province, three figures each; the sex ratio column is not stored
    const report = runChecks(res.rows, index);
    assert.equal(report.failures.length, 0);
    assert.ok(report.passed > 0);
  });

  test("province: age by sex with a 'no thousands separator' and a 'space separator' total", () => {
    const res = sexTable(
      ctxOf("prov-3.1.2-age-by-sex.bbox.xml", "62"),
      "t",
      (k) => /^jumlahpendudukmenurutkelompokumurdanjeniskelamin/.test(k),
      "age"
    );
    assert.deepEqual(res.problems, []);
    const get = (cat, sex, year) => res.rows.find((r) => r.dimension === "age_group" && r.category === cat && r.sex === sex && r.reference_year === year);
    assert.equal(get("0-4", "laki_laki", 2025).value, "129.44");
    assert.equal(get("75+", "perempuan", 2026).value, "23.21");
    const sex = res.rows.find((r) => r.dimension === "sex" && r.category === "laki_laki" && r.reference_year === 2026);
    assert.equal(sex.value, "1483.00");
    assert.equal(runChecks(res.rows, index).failures.length, 0);
  });

  test("city: two label columns, wrapped labels and district subtotals (registration, jiwa)", () => {
    const res = sexTable(ctxOf("city-3.1.3-registration-by-kelurahan.bbox.xml", "62.71"), "t", sexTest, "region");
    assert.deepEqual(res.problems, []);
    const total = (code) => res.rows.find((r) => r.region_code === code && r.dimension === "total");
    assert.equal(total("62.71.01.1005").value, "5991"); // "006. Pahandut Seberang" wrapped over two lines
    assert.equal(total("62.71.01.1005").source_region_name, "006. Pahandut Seberang".replace(/^\d+\.\s*/, ""));
    assert.equal(total("62.71.01").value, "106686"); // "Jumlah di Kecamatan Pahandut"
    assert.equal(total("62.71.01").region_level, 3);
    assert.ok(res.rows.every((r) => r.unit === "jiwa" && r.figure_basis === "registration"));
    const report = runChecks(res.rows, index);
    assert.equal(report.failures.length, 0);
    assert.ok(report.passed >= 3);
  });

  test("industry groups are labelled from the footnote, and the groups add up to the total", () => {
    const ctx = ctxOf("prov-3.2.14-employed-by-industry.bbox.xml", "62");
    const labels = footnoteLabels(ctx.infos[0]);
    assert.equal(labels.get("1"), "Pertanian, Kehutanan dan Perikanan");
    assert.ok(labels.get("2").startsWith("Pertambangan dan Penggalian; Industri Pengolahan"));
    const res = industryByRegion(ctx, "employed");
    assert.deepEqual(res.problems, []);
    const row = res.rows.filter((r) => r.region_code === "62.05");
    assert.deepEqual(row.map((r) => r.value), ["24521", "19691", "44283", "88495"]);
    assert.equal(runChecks(res.rows, index).failures.length, 0);
  });

  test("industry keys are short, stable and carry the full label separately", () => {
    assert.equal(shortIndustryKey("A. Pertanian, Kehutanan dan Perikanan"), "a");
    assert.equal(shortIndustryKey("B, C, D. Pertambangan; Industri"), "b_c_d");
    assert.equal(shortIndustryKey("Pertanian, Kehutanan dan Perikanan"), "pertanian_kehutanan_dan_perikanan");
    const long = shortIndustryKey("Perdagangan Besar dan Eceran; Reparasi Mobil dan Sepeda Motor");
    assert.equal(long, "perdagangan_besar_dan_eceran");
    assert.ok(long.length <= 40);
    const res = industryByRegion(ctxOf("prov-3.2.14-employed-by-industry.bbox.xml", "62"), "employed");
    const g2 = res.rows.find((r) => r.category === "pertambangan_dan_penggalian_industri");
    assert.ok(g2.category_label.startsWith("Pertambangan dan Penggalian; Industri Pengolahan"));
    assert.ok(res.rows.every((r) => r.category.length <= 80));
  });

  test("religion labels map to contract keys", () => {
    assert.equal(religionKey("Protestan Protestant"), "kristen");
    assert.equal(religionKey("Budha Buddha"), "buddha");
    assert.equal(religionKey("Konghucu"), "khonghucu");
    assert.equal(religionKey("Aliran Kepercayaan"), "kepercayaan");
    assert.equal(religionKey("Lainnya Others"), "lainnya");
    assert.equal(religionKey("Kabupaten/Kota"), null);
  });
});

describe("Kecamatan yearbooks (village level)", () => {
  const soft = (name) => ({ ...ctxOf(name, "62.71.01"), soft: true, defaultBasis: "registration" });

  test("population by sex per kelurahan, labels with a trailing slash and a growth-rate column", () => {
    const res = villageSex(soft("kec-pahandut-p68.bbox.xml"));
    assert.deepEqual(res.problems, []);
    const get = (code, dim, cat) => res.rows.find((r) => r.region_code === code && r.dimension === dim && r.category === cat);
    assert.equal(get("62.71.01.1001", "sex", "laki_laki").value, "14243");
    assert.equal(get("62.71.01.1005", "total", "total").value, "5900");
    assert.equal(get("62.71.01", "total", "total").value, "105743"); // the unindexed last row is the kecamatan itself
    assert.ok(res.rows.every((r) => r.unit === "jiwa" && r.reference_year === 2024 && r.region_level >= 3));
    assert.equal(res.rows.length, 21); // 6 kelurahan + the kecamatan, three figures each; the growth rate is not a population figure
    assert.equal(runChecks(res.rows, index).failures.length, 0);
  });

  test("religion per kelurahan: nil symbol, wrapped first row", () => {
    const res = religionByRegion(soft("kec-pahandut-p121.bbox.xml"));
    assert.deepEqual(res.problems, []);
    const get = (code, cat) => res.rows.find((r) => r.region_code === code && r.category === cat);
    assert.equal(get("62.71.01.1001", "islam").value, "26080");
    assert.equal(get("62.71.01.1004", "katolik").value, "0");
    assert.equal(get("62.71.01.1004", "katolik").value_note, "nil");
  });

  test("an unknown village is a gap, not a failure", () => {
    const ctx = soft("kec-pahandut-p68.bbox.xml");
    const wrongDistrict = { ...ctx, coverage: "62.71.04" };
    const res = villageSex(wrongDistrict);
    assert.ok(res.gaps.some((g) => g.startsWith("row not stored")));
  });
});

describe("extract-results ledger", () => {
  test("one record per sha256, the latest wins, written atomically with relative file names", () => {
    const dir = mkdtempSync(join(tmpdir(), "bps-ledger-"));
    const outcome = (status, reason) => ({ year: 2026, reason, datasetCode: "bps-x", status });
    recordResult(dir, join(dir, "pdf", "kecamatan", "62.01.02-2026.pdf"), "a".repeat(64), outcome("refused", "no rows"));
    recordResult(dir, join(dir, "pdf", "6208-dalam-angka-2026.pdf"), "b".repeat(64), outcome("gap-only", "no text layer (needs OCR)"));
    recordResult(dir, join(dir, "pdf", "kecamatan", "62.01.02-2026.pdf"), "a".repeat(64), outcome("written", null));
    const rows = JSON.parse(readFileSync(join(dir, "extract-results.json"), "utf8"));
    assert.equal(rows.length, 2);
    const a = rows.find((r) => r.sha256 === "a".repeat(64));
    assert.deepEqual([a.file, a.outcome, a.datasetCode, a.reason], ["kecamatan/62.01.02-2026.pdf", "written", "bps-x", null]);
    const b = rows.find((r) => r.sha256 === "b".repeat(64));
    assert.deepEqual([b.file, b.outcome, b.datasetCode, b.reason], ["6208-dalam-angka-2026.pdf", "gap_only", null, "no text layer (needs OCR)"]);
    assert.ok(!readdirSync(dir).some((f) => f.endsWith(".tmp")));
  });
});

describe("self-validation", () => {
  const row = (over) => ({
    region_code: "62.71",
    region_level: 2,
    source_region_name: "x",
    dimension: "sex",
    category: "laki_laki",
    sex: "",
    value: "10",
    unit: "jiwa",
    reference_year: 2025,
    figure_basis: "registration",
    universe: "total_population",
    source_table: "T",
    source_page: 1,
    value_note: "",
    ...over,
  });

  test("a sex split that does not add up fails; one that does passes", () => {
    const good = [row({ value: "10" }), row({ category: "perempuan", value: "5" }), row({ dimension: "total", category: "total", value: "15" })];
    assert.equal(runChecks(good, index).failures.length, 0);
    const bad = [row({ value: "10" }), row({ category: "perempuan", value: "5" }), row({ dimension: "total", category: "total", value: "16" })];
    assert.equal(runChecks(bad, index).failures.length, 1);
  });

  test("ribu_jiwa tolerates rounding of each published figure, jiwa does not", () => {
    const mk = (unit, f, m, t) => [
      row({ unit, value: f }),
      row({ unit, category: "perempuan", value: m }),
      row({ unit, dimension: "total", category: "total", value: t }),
    ];
    assert.equal(runChecks(mk("ribu_jiwa", "10.01", "5.01", "15.03"), index).failures.length, 0);
    assert.equal(runChecks(mk("ribu_jiwa", "10.00", "5.00", "15.05"), index).failures.length, 1);
    assert.equal(runChecks(mk("jiwa", "10", "5", "16"), index).failures.length, 1);
  });

  test("children must add up to their parent when all children are published", () => {
    const kids = [...index.childrenOf.get("62.71")];
    const rows = kids.map((k) => row({ region_code: k.code, region_level: 3, dimension: "total", category: "total", value: "100" }));
    rows.push(row({ dimension: "total", category: "total", value: String(100 * kids.length) }));
    assert.equal(runChecks(rows, index).failures.length, 0);
    rows[rows.length - 1].value = String(100 * kids.length + 1);
    assert.equal(runChecks(rows, index).failures.length, 1);
    // one child missing -> the check is skipped, never failed
    const partial = rows.slice(1);
    const rep = runChecks(partial, index);
    assert.equal(rep.failures.length, 0);
    assert.ok(rep.skipped >= 1);
  });

  test("the same figure read from two tables is merged; a different figure is a conflict", () => {
    const a = row({ dimension: "total", category: "total", value: "15", source_table: "A" });
    const same = row({ dimension: "total", category: "total", value: "15", source_table: "B" });
    const other = row({ dimension: "total", category: "total", value: "16", source_table: "C" });
    const merged = dedupe([a, same]);
    assert.equal(merged.rows.length, 1);
    assert.equal(merged.report.duplicatesDropped, 1);
    const conflict = dedupe([a, other]);
    assert.equal(conflict.report.conflicts.length, 1);
    const collide = dedupe([a, row({ dimension: "total", category: "total", value: "0.015", unit: "ribu_jiwa", figure_basis: "projection", source_table: "D" })]);
    assert.equal(collide.rows.length, 2);
    assert.equal(collide.report.keyCollisions, 1);
  });

  test("scaled arithmetic has no floating point error", () => {
    assert.equal(toScaled("0.10") + toScaled("0.20"), toScaled("0.30"));
  });
});

describe("output and metadata", () => {
  test("CSV has the contract header, LF endings and RFC 4180 quoting", () => {
    assert.equal(
      CSV_HEADER,
      "region_code,region_level,source_region_name,dimension,category,sex,value,unit,reference_year,figure_basis,universe,source_table,source_page,value_note,category_label"
    );
    assert.equal(csvField('a,"b"'), '"a,""b"""');
    const csv = rowsToCsv([]);
    assert.equal(csv, `${CSV_HEADER}\n`);
    assert.ok(!csv.includes("\r"));
  });

  test("front matter: catalogue, ISSN, publication number, publisher and the copyright sentence verbatim", () => {
    const fm = parseFrontMatter(fixture("city-front-matter.txt"));
    assert.equal(fm.catalogueNumber, "1102001.6271");
    assert.equal(fm.issn, "0215-5990");
    assert.equal(fm.publicationNumber, "62710.26003");
    assert.equal(fm.publisherName, "BPS Kota Palangka Raya");
    assert.equal(
      fm.termsOfUse,
      "Dilarang mereproduksi dan/atau menggandakan sebagian atau seluruh isi buku ini untuk tujuan komersial tanpa izin tertulis dari Badan Pusat Statistik Kota Palangka Raya."
    );
  });

  test("a host that already carries a scheme is never prefixed twice", () => {
    assert.equal(websiteOfHost("https://kobarkab.bps.go.id"), "https://kobarkab.bps.go.id");
    assert.equal(websiteOfHost("kobarkab.bps.go.id"), "https://kobarkab.bps.go.id");
    assert.equal(websiteOfHost("http://kobarkab.bps.go.id/"), "https://kobarkab.bps.go.id");
  });

  test("domain to coverage code, and the attribution sentence", () => {
    assert.equal(coverageOfDomain("6200"), "62");
    assert.equal(coverageOfDomain("6271"), "62.71");
    assert.equal(
      attributionSentence("BPS Kota Palangka Raya", "https://palangkakota.bps.go.id", "Kota Palangka Raya Dalam Angka 2026"),
      'Data diperoleh dari situs web resmi BPS Kota Palangka Raya (https://palangkakota.bps.go.id), publikasi "Kota Palangka Raya Dalam Angka 2026", yang dapat diunduh secara bebas oleh siapa pun.'
    );
  });
});
