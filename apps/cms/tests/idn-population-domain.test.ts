/**
 * Unit tests for the pure population-statistics domain (awcms-one ADR-0051):
 * the CSV parser, the validation + consistency checks, and small-cell
 * suppression. No database, no filesystem.
 */
import { describe, expect, test } from "bun:test";

import {
  parsePopulationCsv,
  POPULATION_CSV_HEADER
} from "../src/modules/idn-admin-regions/domain/population-csv";
import { parsePopulationManifest } from "../src/modules/idn-admin-regions/domain/population-manifest";
import {
  isSmallCell,
  suppressSmallCells
} from "../src/modules/idn-admin-regions/domain/population-privacy";
import {
  doubledToleranceCents,
  validatePopulationRecords,
  type PopulationValidationResult
} from "../src/modules/idn-admin-regions/domain/population-validation";

const HEADER = POPULATION_CSV_HEADER.join(",");

/** Region dataset: province 62 with two regencies, one of which has two districts. */
const REGIONS = new Map<string, number>([
  ["62", 1],
  ["62.01", 2],
  ["62.71", 2],
  ["62.71.01", 3],
  ["62.71.02", 3],
  ["11", 1]
]);

type Cell = {
  code: string;
  dim?: string;
  cat?: string;
  sex?: string;
  value: string | number;
  unit?: string;
  year?: number;
  basis?: string;
  universe?: string;
  table?: string;
  note?: string;
  label?: string;
  level?: number;
};

function line(cell: Cell): string {
  return [
    cell.code,
    cell.level ?? cell.code.split(".").length,
    `Region ${cell.code}`,
    cell.dim ?? "total",
    cell.cat ?? "total",
    cell.sex ?? "",
    cell.value,
    cell.unit ?? "jiwa",
    cell.year ?? 2025,
    cell.basis ?? "projection",
    cell.universe ?? "total_population",
    cell.table ?? "T1",
    "10",
    cell.note ?? "",
    cell.label ?? ""
  ].join(",");
}

function run(
  cells: Cell[],
  options: { coverage?: string } = {}
): PopulationValidationResult {
  const parsed = parsePopulationCsv([HEADER, ...cells.map(line)].join("\n"));
  expect(parsed.errors).toEqual([]);
  return validatePopulationRecords(parsed.records, {
    regionLevels: REGIONS,
    coverageRegionCode: options.coverage ?? "62"
  });
}

describe("parsePopulationCsv", () => {
  test("parses a well-formed file with LF, CRLF and a BOM", () => {
    const body = `${HEADER}\n${line({ code: "62", value: 5 })}\n`;
    for (const text of [body, body.replaceAll("\n", "\r\n"), `﻿${body}`]) {
      const result = parsePopulationCsv(text);
      expect(result.errors).toEqual([]);
      expect(result.records).toHaveLength(1);
      expect(result.records[0]?.region_code).toBe("62");
      expect(result.records[0]?.lineNumber).toBe(2);
    }
  });

  test("handles quoted fields with commas, doubled quotes and newlines", () => {
    const row = `62,1,"Provinsi, ""Uji""",total,total,,5,jiwa,2025,projection,total_population,"T 1\nbis",10,,`;
    const result = parsePopulationCsv(
      `${HEADER}\n${row}\n${line({ code: "11", value: 1 })}`
    );
    expect(result.errors).toEqual([]);
    expect(result.records[0]?.source_region_name).toBe('Provinsi, "Uji"');
    expect(result.records[0]?.source_table).toBe("T 1\nbis");
    expect(result.records[1]?.lineNumber).toBe(4);
  });

  test("rejects a wrong header, a short row and an unclosed quote", () => {
    expect(parsePopulationCsv("a,b\n1,2").errors[0]).toMatch(
      /header must be exactly/
    );
    expect(parsePopulationCsv("").errors[0]).toMatch(/empty/);
    const short = parsePopulationCsv(`${HEADER}\n62,1,x`);
    expect(short.errors[0]).toMatch(/expected 15 fields, found 3/);
    expect(parsePopulationCsv(`${HEADER}\n62,"x`).errors.join()).toMatch(
      /never closed/
    );
  });

  test("ignores blank lines", () => {
    const result = parsePopulationCsv(
      `${HEADER}\n\n${line({ code: "62", value: 1 })}\n\n`
    );
    expect(result.errors).toEqual([]);
    expect(result.records).toHaveLength(1);
  });
});

describe("validatePopulationRecords: field rules", () => {
  test("accepts a valid row and stores the published digits as text", () => {
    const result = run([{ code: "62", value: "288.5", unit: "ribu_jiwa" }]);
    expect(result.errors).toEqual([]);
    expect(result.rows[0]?.value).toBe("288.50");
    expect(result.rows[0]?.unit).toBe("ribu_jiwa");
  });

  test("keeps ribu_jiwa and jiwa apart: 2.84 ribu is never read as 2840", () => {
    const ribu = run([{ code: "62", value: "2.84", unit: "ribu_jiwa" }]);
    const jiwa = run([{ code: "62", value: "2840" }]);
    expect(ribu.rows[0]?.value).toBe("2.84");
    expect(jiwa.rows[0]?.value).toBe("2840.00");
    // And a fractional jiwa is refused instead of being rounded.
    expect(run([{ code: "62", value: "2.84" }]).errors.join()).toMatch(
      /whole number/
    );
  });

  test("rejects malformed values, enums and years", () => {
    const bad = run([
      { code: "62", value: '"1,5"' },
      { code: "62.01", value: "-3", dim: "sex", cat: "laki_laki" },
      { code: "62.71", value: 1, dim: "bogus" },
      {
        code: "62.71.01",
        value: 1,
        basis: "guess",
        dim: "sex",
        cat: "perempuan"
      },
      { code: "62.71.02", value: 1, year: 1900 }
    ]);
    const text = bad.errors.join("\n");
    expect(text).toMatch(/value "1,5"/);
    expect(text).toMatch(/value "-3"/);
    expect(text).toMatch(/dimension "bogus"/);
    expect(text).toMatch(/figure_basis "guess"/);
    expect(text).toMatch(/reference_year "1900"/);
  });

  test("region_level must match the code and the active region dataset", () => {
    expect(run([{ code: "62.71", value: 1, level: 1 }]).errors.join()).toMatch(
      /does not match the shape/
    );
    expect(run([{ code: "62.09", value: 1 }]).errors.join()).toMatch(
      /absent from the active region dataset: 62\.09/
    );
    const wrongLevel = new Map(REGIONS).set("62.71", 3);
    const parsed = parsePopulationCsv(
      [HEADER, line({ code: "62.71", value: 1 })].join("\n")
    );
    const result = validatePopulationRecords(parsed.records, {
      regionLevels: wrongLevel,
      coverageRegionCode: "62"
    });
    expect(result.errors.join()).toMatch(
      /is level 3 in the active region dataset, not 2/
    );
  });

  test("every code must lie inside the covered region", () => {
    expect(run([{ code: "11", value: 1 }]).errors.join()).toMatch(
      /outside the covered region 62/
    );
    expect(
      run([{ code: "62.71", value: 1 }], { coverage: "62.71" }).errors
    ).toEqual([]);
    // '62.7' style prefix confusion: 62.71 is not inside 62.7
    expect(
      run([{ code: "62.71", value: 1 }], { coverage: "62.7" }).errors.join()
    ).toMatch(/outside/);
  });

  test("sex must be empty for total and sex dimensions; categories follow the dimension", () => {
    const text = run([
      { code: "62", value: 1, dim: "total", sex: "laki_laki" },
      { code: "62.01", value: 1, dim: "age_group", cat: "young" },
      { code: "62.71", value: 1, dim: "religion", cat: "pagan" },
      { code: "62.71.01", value: 1, dim: "sex", cat: "total" }
    ]).errors.join("\n");
    expect(text).toMatch(/sex must be empty for dimension total/);
    expect(text).toMatch(/category "young" for age_group/);
    expect(text).toMatch(/category "pagan" for religion/);
    expect(text).toMatch(/category "total" for sex/);
  });

  test("category keys may end in + after a digit, in any segment; label and key length are bounded", () => {
    const income = (cat: string, label = ""): Cell => ({
      code: "62",
      dim: "income",
      cat,
      value: 1000,
      unit: "rupiah",
      universe: "employees",
      basis: "survey_estimate",
      label
    });
    expect(run([income("kelompok_umur/60+")]).errors).toEqual([]);
    expect(run([income("kelompok_umur/25-29")]).errors).toEqual([]);
    expect(
      run([{ code: "62", dim: "age_group", cat: "75+", value: 1 }]).errors
    ).toEqual([]);
    expect(run([income("kelompok_umur/60+x")]).errors.join()).toMatch(
      /must be/
    );
    expect(run([income("kelompok_umur/a+")]).errors.join()).toMatch(/must be/);
    expect(
      run([
        { code: "62", dim: "occupation", cat: "a".repeat(81), value: 1 }
      ]).errors.join()
    ).toMatch(/longer than 80/);
    expect(
      run([{ code: "62", dim: "occupation", cat: "a".repeat(80), value: 1 }])
        .errors
    ).toEqual([]);

    const labelled = run([
      {
        code: "62",
        dim: "occupation",
        cat: "pertanian",
        value: 1,
        label: '"Pertanian, Kehutanan, dan ""Perikanan"""'
      }
    ]);
    expect(labelled.errors).toEqual([]);
    expect(labelled.rows[0]?.categoryLabel).toBe(
      'Pertanian, Kehutanan, dan "Perikanan"'
    );
    expect(run([{ code: "62", value: 1 }]).rows[0]?.categoryLabel).toBeNull();
    expect(
      run([
        {
          code: "62",
          dim: "occupation",
          cat: "x",
          value: 1,
          label: "y".repeat(501)
        }
      ]).errors.join()
    ).toMatch(/category_label is longer than 500/);
  });

  test("nil note only on zero; duplicate keys are named by line", () => {
    expect(run([{ code: "62", value: 0, note: "nil" }]).errors).toEqual([]);
    expect(run([{ code: "62", value: 3, note: "nil" }]).errors.join()).toMatch(
      /only valid on a value of 0/
    );
    const dup = run([
      { code: "62", value: 1 },
      { code: "62", value: 2 }
    ]);
    expect(dup.errors.join()).toMatch(/line 3: duplicates line 2/);
  });

  test("rupiah belongs to income/expenditure only, with their universes", () => {
    const ok = run([
      {
        code: "62",
        dim: "income",
        cat: "total",
        value: 3500000,
        unit: "rupiah",
        universe: "employees",
        basis: "survey_estimate"
      },
      {
        code: "62",
        dim: "expenditure",
        cat: "kelompok_komoditas/makanan",
        value: 900000,
        unit: "rupiah",
        universe: "per_capita",
        basis: "survey_estimate"
      }
    ]);
    expect(ok.errors).toEqual([]);
    const text = run([
      { code: "62", value: 5, unit: "rupiah" },
      {
        code: "62.01",
        dim: "income",
        cat: "total",
        value: 5,
        unit: "jiwa",
        universe: "employees"
      },
      { code: "62.71", dim: "income", cat: "total", value: 5, unit: "rupiah" }
    ]).errors.join("\n");
    expect(text).toMatch(
      /unit rupiah is only valid for income and expenditure/
    );
    expect(text).toMatch(/income must be in rupiah/);
    expect(text).toMatch(/income must use universe employees/);
  });
});

describe("validatePopulationRecords: consistency checks", () => {
  test("sex parts must equal the total (jiwa is exact)", () => {
    const base: Cell[] = [
      { code: "62", value: 100 },
      { code: "62", dim: "sex", cat: "laki_laki", value: 55 }
    ];
    const good = run([
      ...base,
      { code: "62", dim: "sex", cat: "perempuan", value: 45 }
    ]);
    expect(good.errors).toEqual([]);
    expect(good.report.checksRun.sex_sum).toBe(1);

    const bad = run([
      ...base,
      { code: "62", dim: "sex", cat: "perempuan", value: 44 }
    ]);
    expect(bad.errors.join()).toMatch(
      /sex_sum failed.*add up to 99\.00 but 100\.00/
    );
  });

  test("ribu_jiwa tolerance is 0.005 x (parts + 1): edge cases", () => {
    // Two parts + the total: tolerance 0.015 -> 1 hundredth passes, 2 fail.
    expect(doubledToleranceCents("ribu_jiwa", 2)).toBe(3);
    expect(doubledToleranceCents("jiwa", 2)).toBe(0);
    const cells = (female: string): Cell[] => [
      { code: "62", value: "10.00", unit: "ribu_jiwa" },
      {
        code: "62",
        dim: "sex",
        cat: "laki_laki",
        value: "5.00",
        unit: "ribu_jiwa"
      },
      {
        code: "62",
        dim: "sex",
        cat: "perempuan",
        value: female,
        unit: "ribu_jiwa"
      }
    ];
    expect(run(cells("5.01")).errors).toEqual([]); // diff 0.01 <= 0.015
    expect(run(cells("4.99")).errors).toEqual([]);
    expect(run(cells("5.02")).errors.join()).toMatch(/sex_sum failed/); // diff 0.02 > 0.015
    // Three parts: tolerance 0.02 -> 0.02 passes, 0.03 fails.
    const three = (extra: string): Cell[] => [
      { code: "62", value: "10.00", unit: "ribu_jiwa" },
      ...["islam", "kristen", "katolik", "hindu", "buddha", "khonghucu"].map(
        (cat, index): Cell => ({
          code: "62",
          dim: "religion",
          cat,
          unit: "ribu_jiwa",
          value: index === 0 ? extra : "1.00"
        })
      )
    ];
    // 6 parts: tolerance 0.035. islam = 5.03 -> sum 10.03, diff 0.03 passes; 5.04 fails.
    expect(run(three("5.03")).errors).toEqual([]);
    expect(run(three("5.04")).errors.join()).toMatch(/religion_sum failed/);
  });

  test("age bands add up to the total, and to each sex's figure", () => {
    const cells: Cell[] = [
      { code: "62", value: 100 },
      { code: "62", dim: "sex", cat: "laki_laki", value: 60 },
      { code: "62", dim: "sex", cat: "perempuan", value: 40 },
      { code: "62", dim: "age_group", cat: "0-14", value: 30 },
      { code: "62", dim: "age_group", cat: "15-64", value: 60 },
      { code: "62", dim: "age_group", cat: "65+", value: 10 },
      {
        code: "62",
        dim: "age_group",
        cat: "0-14",
        sex: "laki_laki",
        value: 20
      },
      {
        code: "62",
        dim: "age_group",
        cat: "15-64",
        sex: "laki_laki",
        value: 35
      },
      { code: "62", dim: "age_group", cat: "65+", sex: "laki_laki", value: 5 }
    ];
    const result = run(cells);
    expect(result.errors).toEqual([]);
    expect(result.report.checksRun.age_group_sum).toBe(1);
    expect(result.report.checksRun.age_group_by_sex_sum).toBe(1);

    cells[8] = { ...cells[8]!, value: 6 };
    expect(run(cells).errors.join()).toMatch(
      /\[laki_laki\]: age_group_by_sex_sum failed/
    );
  });

  test("an age band table with a missing band is SKIPPED, not failed and not filled", () => {
    const result = run([
      { code: "62", value: 100 },
      { code: "62", dim: "age_group", cat: "0-14", value: 30 },
      { code: "62", dim: "age_group", cat: "65+", value: 10 }
    ]);
    expect(result.errors).toEqual([]);
    expect(result.report.checksRun.age_group_sum).toBe(0);
    expect(result.report.checksSkipped.age_group_sum).toBe(1);
    expect(result.report.skippedSamples.join()).toMatch(/age_group_sum/);
  });

  test("a missing total or missing sex skips the sex check", () => {
    const noTotal = run([
      { code: "62", dim: "sex", cat: "laki_laki", value: 5 },
      { code: "62", dim: "sex", cat: "perempuan", value: 5 }
    ]);
    expect(noTotal.report.checksSkipped.sex_sum).toBe(1);
    const noFemale = run([
      { code: "62", value: 10 },
      { code: "62", dim: "sex", cat: "laki_laki", value: 5 }
    ]);
    expect(noFemale.report.checksSkipped.sex_sum).toBe(1);
    expect(noFemale.errors).toEqual([]);
  });

  test("religion sum needs all six core religions", () => {
    const religions = [
      "islam",
      "kristen",
      "katolik",
      "hindu",
      "buddha",
      "khonghucu"
    ];
    const full = (islam: number): Cell[] => [
      { code: "62", value: 100 },
      ...religions.map((cat, index): Cell => ({
        code: "62",
        dim: "religion",
        cat,
        value: index === 0 ? islam : 10
      }))
    ];
    expect(run(full(50)).errors).toEqual([]);
    expect(run(full(49)).errors.join()).toMatch(/religion_sum failed/);
    // kepercayaan on top of the six counts toward the sum.
    expect(
      run([
        ...full(45),
        { code: "62", dim: "religion", cat: "kepercayaan", value: 5 }
      ]).errors
    ).toEqual([]);
    const partial = run([
      { code: "62", value: 100 },
      { code: "62", dim: "religion", cat: "islam", value: 90 }
    ]);
    expect(partial.errors).toEqual([]);
    expect(partial.report.checksSkipped.religion_sum).toBe(1);
  });

  test("children add up to the parent, only when every child region is published", () => {
    const parent: Cell = { code: "62", value: 100 };
    const good = run([
      parent,
      { code: "62.01", value: 60 },
      { code: "62.71", value: 40 }
    ]);
    expect(good.errors).toEqual([]);
    expect(good.report.checksRun.children_sum).toBe(1);

    const bad = run([
      parent,
      { code: "62.01", value: 60 },
      { code: "62.71", value: 41 }
    ]);
    expect(bad.errors.join()).toMatch(
      /children_sum failed.*add up to 101\.00 but 100\.00/
    );

    const missingChild = run([parent, { code: "62.01", value: 60 }]);
    expect(missingChild.errors).toEqual([]);
    expect(missingChild.report.checksSkipped.children_sum).toBe(1);
    expect(missingChild.report.skippedSamples.join()).toMatch(
      /1 of 2 child regions/
    );

    // A parent with nothing published beneath it is not a check at all.
    const leaf = run([parent]);
    expect(leaf.report.checksRun.children_sum).toBe(0);
    expect(leaf.report.checksSkipped.children_sum).toBe(0);
  });

  test("children are compared only within the same measure and table", () => {
    const result = run([
      { code: "62", value: 100 },
      { code: "62.01", value: 60, table: "T2" },
      { code: "62.71", value: 999, table: "T2" }
    ]);
    // Parent in T1 has no children in T1: nothing compared, nothing failed.
    expect(result.errors).toEqual([]);
    expect(result.report.checksRun.children_sum).toBe(0);
  });

  test("sums are never mixed across reference years or figure bases", () => {
    const result = run([
      { code: "62", value: 100, year: 2025 },
      { code: "62.01", value: 60, year: 2025 },
      { code: "62.71", value: 40, year: 2024 }
    ]);
    expect(result.errors).toEqual([]);
    expect(result.report.checksSkipped.children_sum).toBe(1);
  });

  test("each table keeps its own total: an age or religion table checks against ITS total", () => {
    const religions = [
      "islam",
      "kristen",
      "katolik",
      "hindu",
      "buddha",
      "khonghucu"
    ];
    const cells = (islam: number): Cell[] => [
      { code: "62", value: 100, table: "T1" },
      { code: "62", value: 100, table: "T2" },
      ...religions.map((cat, index): Cell => ({
        code: "62",
        dim: "religion",
        cat,
        value: index === 0 ? islam : 10,
        table: "T2"
      }))
    ];
    const good = run(cells(50));
    expect(good.errors).toEqual([]);
    expect(good.report.checksRun.religion_sum).toBe(1);
    expect(good.report.checksSkipped.religion_sum).toBe(0);
    expect(good.report.warningCount).toBe(0);
    expect(run(cells(49)).errors.join()).toMatch(/religion_sum failed/);
  });

  test("the same figure in two tables is a WARNING when they disagree, never an error", () => {
    const agree = run([
      { code: "62", value: 100, table: "T1" },
      { code: "62", value: 100, table: "T2" }
    ]);
    expect(agree.errors).toEqual([]);
    expect(agree.report.warningCount).toBe(0);

    const differ = run([
      { code: "62", value: 100, table: "T1" },
      { code: "62", value: 101, table: "T2" }
    ]);
    expect(differ.errors).toEqual([]);
    expect(differ.report.warningCount).toBe(1);
    expect(differ.report.warnings[0]).toMatch(
      /T1 says 100\.00 but T2 says 101\.00/
    );

    // ribu_jiwa: one hundredth is within rounding, two are not.
    const ribu = (b: string) =>
      run([
        { code: "62", value: "10.00", unit: "ribu_jiwa", table: "T1" },
        { code: "62", value: b, unit: "ribu_jiwa", table: "T2" }
      ]).report.warningCount;
    expect(ribu("10.01")).toBe(0);
    expect(ribu("10.02")).toBe(1);
  });

  test("one table may print the same figure under two bases", () => {
    const result = run([
      { code: "62", value: 100, basis: "projection" },
      { code: "62", value: 98, basis: "registration" }
    ]);
    expect(result.errors).toEqual([]);
    // Different bases are never compared against each other.
    expect(result.report.warningCount).toBe(0);
  });

  test("a repeated key inside ONE table is still a duplicate", () => {
    const result = run([
      { code: "62", value: 1, table: "T1" },
      { code: "62", value: 1, table: "T1" }
    ]);
    expect(result.errors.join()).toMatch(/duplicates line 2/);
  });

  test("rupiah rows are never summed", () => {
    const income = (code: string, value: number): Cell => ({
      code,
      dim: "income",
      cat: "total",
      value,
      unit: "rupiah",
      universe: "employees",
      basis: "survey_estimate"
    });
    // The regencies' averages do not add up to the province's, and must not be asked to.
    const result = run([
      income("62", 3_000_000),
      income("62.01", 2_000_000),
      income("62.71", 4_000_000)
    ]);
    expect(result.errors).toEqual([]);
    expect(result.report.checksRun.children_sum).toBe(0);
    expect(result.report.checksSkipped.children_sum).toBe(0);
  });

  test("consistency checks do not run on a file that already has field errors", () => {
    const result = run([
      { code: "62", value: 100 },
      { code: "62.01", value: 1 },
      { code: "62.71", value: "x" }
    ]);
    expect(result.errors.join()).not.toMatch(/children_sum/);
  });
});

describe("parsePopulationManifest", () => {
  const valid = {
    datasetCode: "bps-6200-dalam-angka-2026",
    publicationSeries: "provinsi_dalam_angka",
    coverageRegionCode: "62",
    coverageRegionLevel: 1,
    publicationTitle: "T",
    publisherName: "BPS",
    publisherDomain: "6200",
    publisherWebsite: "https://kalteng.bps.go.id",
    attribution:
      "Data diperoleh dari situs web resmi BPS (https://kalteng.bps.go.id).",
    catalogueNumber: null,
    publicationNumber: null,
    issn: null,
    publicationYear: 2026,
    releaseDate: "2026-02-27",
    publicationUrl: "https://kalteng.bps.go.id/x",
    sourceFileSha256: "a".repeat(64),
    sourceFileBytes: 10,
    termsOfUse: "terms",
    csvSha256: "b".repeat(64)
  };

  test("accepts a complete manifest and ignores extra fields", () => {
    const result = parsePopulationManifest({
      ...valid,
      tablesUsed: [],
      knownGaps: ["x"]
    });
    expect(result.ok).toBe(true);
  });

  test("names every problem", () => {
    const result = parsePopulationManifest({
      ...valid,
      publisherWebsite: "https://example.com",
      publicationSeries: "nope",
      coverageRegionLevel: 2,
      csvSha256: "XYZ",
      attribution: "no site named here"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const text = result.errors.join("\n");
      expect(text).toMatch(/publisherWebsite must be the https/);
      expect(text).toMatch(/publicationSeries must be one of/);
      expect(text).toMatch(/coverageRegionLevel does not match/);
      expect(text).toMatch(/csvSha256 must be 64/);
    }
    expect(parsePopulationManifest([]).ok).toBe(false);
  });

  test("the attribution must name the official website", () => {
    const result = parsePopulationManifest({
      ...valid,
      attribution: "official BPS website"
    });
    expect(result.ok).toBe(false);
  });
});

describe("small-cell suppression", () => {
  const cell = (overrides: Partial<Parameters<typeof isSmallCell>[0]>) => ({
    dimension: "total",
    regionLevel: 2,
    unit: "jiwa",
    value: 50,
    ...overrides
  });

  test("religion cells under 10 are withheld at any level", () => {
    for (const regionLevel of [1, 2, 3, 4]) {
      expect(
        isSmallCell(cell({ dimension: "religion", regionLevel, value: 9 }))
      ).toBe(true);
      expect(
        isSmallCell(cell({ dimension: "religion", regionLevel, value: 10 }))
      ).toBe(false);
    }
  });

  test("every dimension under 10 is withheld at village level only", () => {
    expect(
      isSmallCell(cell({ dimension: "age_group", regionLevel: 4, value: 0 }))
    ).toBe(true);
    expect(
      isSmallCell(cell({ dimension: "age_group", regionLevel: 3, value: 0 }))
    ).toBe(false);
    expect(
      isSmallCell(cell({ dimension: "total", regionLevel: 4, value: 9 }))
    ).toBe(true);
  });

  test("ribu_jiwa and rupiah are never suppressed", () => {
    expect(
      isSmallCell(
        cell({ dimension: "religion", unit: "ribu_jiwa", value: 0.5 })
      )
    ).toBe(false);
    expect(
      isSmallCell(
        cell({ dimension: "income", regionLevel: 4, unit: "rupiah", value: 3 })
      )
    ).toBe(false);
  });

  test("suppressSmallCells keeps every cell, nulls the withheld ones and flags them", () => {
    const out = suppressSmallCells([
      { ...cell({ dimension: "religion", value: 3 }), id: "a" },
      { ...cell({ value: 3 }), id: "b" }
    ]);
    expect(out).toEqual([
      {
        dimension: "religion",
        regionLevel: 2,
        unit: "jiwa",
        value: null,
        id: "a",
        suppressed: true
      },
      {
        dimension: "total",
        regionLevel: 2,
        unit: "jiwa",
        value: 3,
        id: "b",
        suppressed: false
      }
    ]);
  });
});
