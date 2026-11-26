/**
 * Unit tests for the Kepmendagri population importer (awcms-one ADR-0053),
 * without a database: the strict dump parser, the typed row readers, the
 * validation and mapping onto regions (including the float-truncated-code
 * repair), the provenance verification of the source files, and one run over
 * the REAL vendored files against the REAL vendored region dump.
 */
import { rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import {
  planPopulationImport,
  PopulationImportError,
  readPopulationSources,
  type ActiveRegionDataset
} from "../src/modules/idn-admin-regions/application/population-import";
import {
  parseValueDump,
  readTupleLine
} from "../src/modules/idn-admin-regions/domain/population-dump-parser";
import {
  AREA_DUMP_EXPECTATION,
  AREA_SOURCE_TABLE,
  derivePopulationDatasetCode,
  headerCites,
  POPULATION_DECREE_REFERENCE,
  POPULATION_DUMP_EXPECTATION,
  POPULATION_SOURCE_TABLE,
  readAreaRows,
  readPopulationRows
} from "../src/modules/idn-admin-regions/domain/population-source";
import {
  areaToThousandths,
  buildPopulationFigures,
  floatTruncationCandidate,
  type RegionFact
} from "../src/modules/idn-admin-regions/domain/population-validation";
import { normalizeRegionRow } from "../src/modules/idn-admin-regions/domain/region-normalization";
import { parseWilayahDump } from "../src/modules/idn-admin-regions/domain/wilayah-dump-parser";
import {
  FIXTURE_REGION_ROWS,
  readFixture,
  stageSources,
  type StageOptions
} from "./fixtures/idn-population/stage-sources";

const FIXTURE_REGIONS = new Map<string, RegionFact>(
  FIXTURE_REGION_ROWS.map((row) => [
    row.code,
    { level: row.code.split(".").length, name: row.name }
  ])
);

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function stage(options: StageOptions = {}): Promise<string> {
  const root = await stageSources(options);
  roots.push(root);
  return root;
}

function figuresOf(
  populationText: string,
  areaText: string,
  regions: ReadonlyMap<string, RegionFact> = FIXTURE_REGIONS
) {
  const population = readPopulationRows(
    parseValueDump(populationText, POPULATION_DUMP_EXPECTATION)
  );
  const area = readAreaRows(parseValueDump(areaText, AREA_DUMP_EXPECTATION));
  expect([...population.errors, ...area.errors]).toEqual([]);
  return buildPopulationFigures({
    population: {
      rows: population.rows,
      sourceTable: POPULATION_SOURCE_TABLE,
      referenceYear: 2025
    },
    area: {
      rows: area.rows,
      sourceTable: AREA_SOURCE_TABLE,
      referenceYear: 2024
    },
    regions
  });
}

function fixtureRegionDataset(
  overrides: Partial<ActiveRegionDataset> = {}
): ActiveRegionDataset {
  return {
    regionDatasetId: "00000000-0000-0000-0000-000000000001",
    datasetCode: "fixture-regions",
    decreeReference: POPULATION_DECREE_REFERENCE,
    regions: new Map(FIXTURE_REGIONS),
    ...overrides
  };
}

describe("parseValueDump", () => {
  test("reads the fixture dumps: header, DDL and split INSERT statements", async () => {
    const population = parseValueDump(
      await readFixture("wilayah_penduduk.sql"),
      POPULATION_DUMP_EXPECTATION
    );
    expect(population.unparsed).toEqual([]);
    expect(population.tuples).toHaveLength(5);
    expect(population.insertStatementCount).toBe(1);

    const area = parseValueDump(
      await readFixture("wilayah_luas.sql"),
      AREA_DUMP_EXPECTATION
    );
    expect(area.unparsed).toEqual([]);
    expect(area.tuples).toHaveLength(4);
    expect(area.insertStatementCount).toBe(2);
    expect(area.tuples[0]?.values).toEqual([
      { kind: "string", text: "62.0" },
      { kind: "string", text: "Provinsi Uji" },
      { kind: "number", text: "153.564" }
    ]);
  });

  test("an INSERT naming other columns, or columns in another order, is refused", () => {
    const text = [
      "INSERT INTO wilayah_penduduk(kode, nama, wanita, pria, total)",
      "VALUES",
      "('11','Aceh','1','2','3');"
    ].join("\n");
    const result = parseValueDump(text, POPULATION_DUMP_EXPECTATION);
    expect(result.tuples).toEqual([]);
    expect(result.unparsed.map((p) => p.reason).join()).toMatch(
      /expected wilayah_penduduk\(kode, nama, pria, wanita, total\)/
    );
    // ...and its tuple, now outside any accepted INSERT, is refused too.
    expect(result.unparsed.map((p) => p.reason).join()).toMatch(
      /outside an INSERT/
    );
  });

  test("unknown lines, wrong value counts, bare words and an unfinished INSERT are all errors", () => {
    const text = [
      "INSERT INTO wilayah_luas(kode,nama,luas)",
      "VALUES",
      "('11','Aceh'),",
      "('12','Sumut',abc),",
      "this is not sql",
      "('13','Sumbar',1.5),"
    ].join("\n");
    const result = parseValueDump(text, AREA_DUMP_EXPECTATION);
    const reasons = result.unparsed.map((p) => `${p.lineNumber}:${p.reason}`);
    expect(reasons).toEqual([
      "3:expected 3 values (kode, nama, luas), found 2",
      '4:unquoted value "abc" is neither a number nor NULL',
      "5:unrecognised line",
      "6:the file ends inside an INSERT statement"
    ]);
    expect(result.tuples).toHaveLength(1);
  });

  test("quoted strings keep commas, parentheses and escaped quotes", () => {
    expect(readTupleLine("('11','Ma\\'rang, (x)','1'),")).toEqual({
      ok: true,
      values: [
        { kind: "string", text: "11" },
        { kind: "string", text: "Ma'rang, (x)" },
        { kind: "string", text: "1" }
      ],
      terminator: ","
    });
    expect(readTupleLine("('O''Brien',NULL);")).toEqual({
      ok: true,
      values: [{ kind: "string", text: "O'Brien" }, { kind: "null" }],
      terminator: ";"
    });
    expect(readTupleLine("('x','y')")).toMatchObject({ ok: false });
  });
});

describe("typed rows", () => {
  test("population counts must be quoted whole numbers", () => {
    const text = [
      "INSERT INTO wilayah_penduduk(kode, nama, pria, wanita, total)",
      "VALUES",
      "('11','Aceh','1.5','2','3'),",
      "('12','Sumut',1,'2','3'),",
      "('1x','Bad','1','2','3');"
    ].join("\n");
    const { rows, errors } = readPopulationRows(
      parseValueDump(text, POPULATION_DUMP_EXPECTATION)
    );
    expect(rows).toEqual([]);
    expect(errors).toEqual([
      'line 3: pria must be a whole number, found "1.5"',
      "line 4: pria must be a quoted string",
      'line 5: kode "1x" is not a dotted numeric code'
    ]);
  });

  test("an area must be a bare number and a name is required", () => {
    const text = [
      "INSERT INTO wilayah_luas(kode,nama,luas)",
      "VALUES",
      "('11',NULL,1.5),",
      "('12','Sumut','7');"
    ].join("\n");
    const { rows, errors } = readAreaRows(
      parseValueDump(text, AREA_DUMP_EXPECTATION)
    );
    expect(rows).toEqual([]);
    expect(errors).toEqual([
      "line 3: nama is missing",
      "line 4: luas must be a bare number"
    ]);
  });
});

describe("buildPopulationFigures", () => {
  test("the fixture maps cleanly: four figures per region, the national row checked and skipped", async () => {
    const result = figuresOf(
      await readFixture("wilayah_penduduk.sql"),
      await readFixture("wilayah_luas.sql")
    );
    expect(result.errors).toEqual([]);
    expect(result.report.rowCount).toBe(16);
    expect(result.report.countsByDimension).toEqual({
      total: 4,
      sex: 8,
      area: 4
    });
    expect(result.report.countsByLevel).toEqual({ "1": 4, "2": 12 });
    expect(result.report.checksRun).toEqual({
      sex_sum: 5,
      national_sum: 1,
      children_sum_population: 1,
      children_sum_area: 1,
      completeness: 8
    });
    expect(result.report.skipped).toEqual([
      expect.objectContaining({
        code: "0",
        sourceTable: POPULATION_SOURCE_TABLE
      })
    ]);
    expect(
      result.report.codeRepairs.map((r) => [r.sourceCode, r.code])
    ).toEqual([
      ["62.0", "62"],
      ["62.1", "62.10"]
    ]);
    // The abbreviated "Kab" is a warning, never an error, and is stored verbatim.
    expect(result.report.warningCount).toBe(1);
    expect(result.report.warnings[0]).toMatch(/Kab Uji Sepuluh/);

    const province = result.rows.filter((row) => row.regionCode === "62");
    expect(
      province.map((row) => [row.dimension, row.category, row.value, row.unit])
    ).toEqual([
      ["total", "total", "1000", "jiwa"],
      ["sex", "laki_laki", "520", "jiwa"],
      ["sex", "perempuan", "480", "jiwa"],
      ["area", "total", "153.564", "km2"]
    ]);
    const area = province.find((row) => row.dimension === "area");
    expect(area).toMatchObject({
      figureBasis: "geospatial_calculation",
      universe: "region_area",
      referenceYear: 2024,
      sourceTable: AREA_SOURCE_TABLE,
      sourceRegionName: "Provinsi Uji"
    });
    const total = province.find((row) => row.dimension === "total");
    expect(total).toMatchObject({
      figureBasis: "decree",
      universe: "total_population",
      referenceYear: 2025,
      sourceTable: POPULATION_SOURCE_TABLE
    });
  });

  test("pria + wanita must equal total, exactly", async () => {
    const result = figuresOf(
      (await readFixture("wilayah_penduduk.sql")).replace(
        "'160','140','300'",
        "'160','141','300'"
      ),
      await readFixture("wilayah_luas.sql")
    );
    expect(result.errors.join("\n")).toMatch(
      /line 31: sex_sum failed for 62\.01 .*pria 160 \+ wanita 141 = 301, total 300/
    );
  });

  test("an unknown kode is an error, and a duplicate is named by line", async () => {
    const population = (await readFixture("wilayah_penduduk.sql")).replace(
      "('62.71','Kota Uji Dua','260','240','500');",
      "('62.71','Kota Uji Dua','260','240','500'),\n('62.99','Kota Hilang','1','1','2'),\n('62.01','Kabupaten Uji Satu','160','140','300');"
    );
    const result = figuresOf(population, await readFixture("wilayah_luas.sql"));
    const errors = result.errors.join("\n");
    expect(errors).toMatch(
      /kode "62\.99" \("Kota Hilang"\) is not a province or regency\/city of the active region dataset/
    );
    expect(errors).toMatch(/kode 62\.01 is a duplicate of line 31/);
    // Aggregate checks do not pile noise onto a file whose codes are wrong.
    expect(result.report.checksSkipped.join()).toMatch(
      /completeness, children_sum_population, national_sum/
    );
  });

  test("the float-truncation repair needs the witness name, and never shadows a literal code", async () => {
    const wrongName = (await readFixture("wilayah_luas.sql")).replace(
      "('62.1','Kabupaten Uji Sepuluh',40.064)",
      "('62.1','Kabupaten Lain',40.064)"
    );
    expect(
      figuresOf(
        await readFixture("wilayah_penduduk.sql"),
        wrongName
      ).errors.join()
    ).toMatch(
      /the name "Kabupaten Lain" does not match 62\.10's official name/
    );

    const collision = (await readFixture("wilayah_luas.sql")).replace(
      "('62.71','Kota Uji Dua',13.0);",
      "('62.71','Kota Uji Dua',13.0),\n('62.10','Kabupaten Uji Sepuluh',40.064);"
    );
    expect(
      figuresOf(
        await readFixture("wilayah_penduduk.sql"),
        collision
      ).errors.join()
    ).toMatch(/62\.10 also appears literally in the same file/);

    expect(floatTruncationCandidate("11.1")).toBe("11.10");
    expect(floatTruncationCandidate("31.0")).toBe("31");
    expect(floatTruncationCandidate("11.01")).toBeNull();
    expect(floatTruncationCandidate("1.1")).toBeNull();
  });

  test("an area is positive with at most three decimals; it is never rounded", async () => {
    const fourDecimals = (await readFixture("wilayah_luas.sql")).replace(
      "13.0",
      "13.0001"
    );
    expect(
      figuresOf(
        await readFixture("wilayah_penduduk.sql"),
        fourDecimals
      ).errors.join()
    ).toMatch(
      /luas 13\.0001 for 62\.71 must be a positive number with at most three decimals/
    );

    const zero = (await readFixture("wilayah_luas.sql")).replace(
      "13.0",
      "0.000"
    );
    expect(
      figuresOf(await readFixture("wilayah_penduduk.sql"), zero).errors.join()
    ).toMatch(/luas for 62\.71 must be greater than zero/);

    expect(areaToThousandths("1851.615")).toBe(1851615n);
    expect(areaToThousandths("125.0")).toBe(125000n);
    expect(areaToThousandths("7")).toBe(7000n);
  });

  test("children must add up to their province, and provinces to the national row", async () => {
    const population = (await readFixture("wilayah_penduduk.sql")).replace(
      "('0','INDONESIA','520','480','1000')",
      "('0','INDONESIA','521','480','1001')"
    );
    const area = (await readFixture("wilayah_luas.sql")).replace(
      "153.564",
      "153.565"
    );
    const errors = figuresOf(population, area).errors.join("\n");
    expect(errors).toMatch(/national_sum failed: the provinces add up to 1000/);
    expect(errors).toMatch(
      /children_sum_area failed for province 62: its regencies\/cities add up to 153\.564 km2, the province row says 153\.565 km2/
    );

    const child = (await readFixture("wilayah_penduduk.sql")).replace(
      "'260','240','500'",
      "'261','240','501'"
    );
    expect(
      figuresOf(child, await readFixture("wilayah_luas.sql")).errors.join()
    ).toMatch(/children_sum_population failed for province 62/);
  });

  test("every level-1/2 region of the active dataset needs a figure in both files", async () => {
    const regions = new Map(FIXTURE_REGIONS);
    regions.set("62.72", { level: 2, name: "Kota Uji Tiga" });
    const errors = figuresOf(
      await readFixture("wilayah_penduduk.sql"),
      await readFixture("wilayah_luas.sql"),
      regions
    ).errors.join("\n");
    expect(errors).toMatch(
      /region 62\.72 \("Kota Uji Tiga"\) of the active region dataset has no population row/
    );
    expect(errors).toMatch(
      /region 62\.72 \("Kota Uji Tiga"\) of the active region dataset has no area row/
    );
  });
});

describe("readPopulationSources and planPopulationImport", () => {
  test("a self-consistent tree verifies, and the plan derives its code from both digests", async () => {
    const root = await stage();
    const sources = await readPopulationSources(root);
    expect(sources.files.population.figures).toEqual(["total", "sex"]);
    expect(sources.files.area.origin).toMatch(/Badan Informasi Geospasial/);

    const plan = planPopulationImport(sources, fixtureRegionDataset());
    expect(plan.errors).toEqual([]);
    expect(plan.rows).toHaveLength(16);
    expect(plan.datasetCode).toBe(
      derivePopulationDatasetCode(
        sources.files.population.sha256,
        sources.files.area.sha256
      )
    );
    expect(plan.datasetCode).toMatch(
      /^kepmendagri-300\.2\.2-2138-2025-[0-9a-f]{8}-[0-9a-f]{8}$/
    );
  });

  test("a file whose bytes disagree with manifest.json is refused, naming the file", async () => {
    const root = await stage({ tamper: "area" });
    const error = await readPopulationSources(root).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PopulationImportError);
    const problems = (error as PopulationImportError).problems.join("\n");
    expect(problems).toMatch(
      /Checksum mismatch for upstream\/cahyadsn-wilayah\/db\/wilayah_luas\.sql: manifest\.json records/
    );
    expect(problems).toMatch(
      /Size mismatch for upstream\/cahyadsn-wilayah\/db\/wilayah_luas\.sql/
    );
  });

  test("checksums.sha256 is checked too, not only the manifest", async () => {
    const root = await stage({ staleChecksumsLine: "population" });
    const error = await readPopulationSources(root).catch((e: unknown) => e);
    expect((error as PopulationImportError).problems.join()).toMatch(
      /checksums\.sha256 records f{64}/
    );
  });

  test("a header that no longer cites the decree, or a manifest that does not mark the file, is refused", async () => {
    const population = (await readFixture("wilayah_penduduk.sql")).replace(
      "No 300.2.2-2138 Tahun 2025",
      "No 300.2.2-9999 Tahun 2026"
    );
    const root = await stage({
      population,
      populationEntry: { importedBy: null }
    });
    const problems = await readPopulationSources(root).catch(
      (e: unknown) => (e as PopulationImportError).problems
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/importedBy "idn_admin_regions\.population"/),
        expect.stringMatching(
          /its header no longer cites "Kepmendagri No 300\.2\.2-2138 Tahun 2025"/
        )
      ])
    );
  });

  test("a region dataset under another decree is an error, not a silent comparison", async () => {
    const sources = await readPopulationSources(await stage());
    const plan = planPopulationImport(
      sources,
      fixtureRegionDataset({
        decreeReference: "Kepmendagri No 100.1.1-6117 Tahun 2022"
      })
    );
    expect(plan.errors.join()).toMatch(
      /cites "Kepmendagri No 100\.1\.1-6117 Tahun 2022"; the population and area files cite/
    );
  });
});

describe("the REAL vendored files against the REAL vendored region dump", () => {
  test("verify, parse and validate with no error: 552 regions, 2,208 figures, 5 repairs", async () => {
    const root = process.cwd();
    const sources = await readPopulationSources(root);
    expect(
      headerCites(sources.text.population, POPULATION_DECREE_REFERENCE)
    ).toBe(true);

    const dump = parseWilayahDump(
      await readFile(
        path.join(
          root,
          "data/idn-admin-regions/upstream/cahyadsn-wilayah/db/wilayah.sql"
        ),
        "utf8"
      )
    );
    const regions = new Map<string, RegionFact>();
    for (const row of dump.rows) {
      if (row.code.split(".").length > 2) continue;
      const region = normalizeRegionRow(row);
      regions.set(region.code, {
        level: region.level,
        name: region.officialName
      });
    }
    expect(regions.size).toBe(552);

    const plan = planPopulationImport(sources, {
      regionDatasetId: "00000000-0000-0000-0000-000000000002",
      datasetCode: "real",
      decreeReference: POPULATION_DECREE_REFERENCE,
      regions
    });
    expect(plan.errors).toEqual([]);
    expect(plan.datasetCode).toBe(
      "kepmendagri-300.2.2-2138-2025-b0b6b9dc-3ffd506e"
    );
    expect(plan.report.rowCount).toBe(2208);
    expect(plan.report.countsByDimension).toEqual({
      total: 552,
      sex: 1104,
      area: 552
    });
    expect(plan.report.countsByLevel).toEqual({ "1": 152, "2": 2056 });
    expect(
      plan.report.codeRepairs.map((r) => `${r.sourceCode}->${r.code}`)
    ).toEqual([
      "11.1->11.10",
      "12.1->12.10",
      "12.2->12.20",
      "14.1->14.10",
      "31.0->31"
    ]);
    expect(plan.report.skipped.map((s) => s.code)).toEqual(["0"]);
    expect(plan.report.warningCount).toBe(4);
    expect(plan.report.checksRun).toEqual({
      sex_sum: 553,
      national_sum: 1,
      children_sum_population: 38,
      children_sum_area: 38,
      completeness: 1104
    });

    const jakarta = plan.rows.filter((row) => row.regionCode === "31");
    expect(
      jakarta.map((row) => `${row.dimension}/${row.category}=${row.value}`)
    ).toEqual([
      "total/total=11038216",
      "sex/laki_laki=5537335",
      "sex/perempuan=5500881",
      "area/total=661.53"
    ]);
  });
});
