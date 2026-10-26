/**
 * Validation of an extracted BPS population CSV (awcms-one ADR-0051).
 *
 * Pure functions: they take parsed CSV records plus the facts about the region
 * dataset the caller looked up (a code -> level map), and return typed rows, a
 * list of blocking errors and a report. Nothing here reads a file or a
 * database, so the importer's dry run and its real run are the same code.
 *
 * ## What is checked
 *
 *  1. Every field is well formed: enums, code shape, `region_level` matching the
 *     code's segment count, a `jiwa` value that is a whole number, a `nil` note
 *     only on a zero, no duplicate key.
 *  2. Every region code exists in the ACTIVE region dataset at the level the row
 *     claims, and lies inside the region the publication covers.
 *  3. Arithmetic consistency, only between figures that can legitimately add up
 *     (same region, reference year, universe, unit, figure basis and source
 *     table): sex parts = total; age bands = total; age bands of one sex = that
 *     sex's figure; the six religions = total; and the figures of a region's
 *     direct children = the region's own figure.
 *
 * ## Tolerance
 *
 * `jiwa` is exact. `ribu_jiwa` figures were each rounded to 0.01 by the
 * publisher, so a sum of n parts may differ from the printed total by up to
 * 0.005 x (n + 1) (n rounded parts plus the rounded total). Beyond that it is an
 * ERROR, not a warning: the dataset is rejected and the error names the region,
 * the check and the difference.
 *
 * ## Gaps are reported, never filled
 *
 * A blank / "not available" cell has no row (see the CSV contract). A check
 * whose inputs are not all published is SKIPPED and counted in the report; it is
 * never passed by assuming a value and never failed by treating the gap as zero.
 *
 * ## Rupiah is never summed
 *
 * `income` and `expenditure` rows are averages in `rupiah`. Adding averages is
 * meaningless, so no check ever involves them.
 */
import type { PopulationCsvRecord } from "./population-csv";

export const POPULATION_DIMENSIONS = [
  "total",
  "sex",
  "age_group",
  "religion",
  "occupation",
  "income",
  "expenditure"
] as const;
export const POPULATION_UNITS = ["jiwa", "ribu_jiwa", "rupiah"] as const;
export const POPULATION_FIGURE_BASES = [
  "census",
  "projection",
  "registration",
  "survey_estimate"
] as const;
export const POPULATION_UNIVERSES = [
  "total_population",
  "employed_15_plus",
  "employees",
  "per_capita"
] as const;
export const POPULATION_SEXES = ["laki_laki", "perempuan"] as const;

/** The six officially recognised religions; a religion sum is checked only when all six are published. */
export const CORE_RELIGIONS = [
  "islam",
  "kristen",
  "katolik",
  "hindu",
  "buddha",
  "khonghucu"
] as const;
const RELIGION_CATEGORIES = new Set<string>([
  ...CORE_RELIGIONS,
  "kepercayaan",
  "lainnya"
]);

export type PopulationDimension = (typeof POPULATION_DIMENSIONS)[number];
export type PopulationUnit = (typeof POPULATION_UNITS)[number];
export type PopulationFigureBasis = (typeof POPULATION_FIGURE_BASES)[number];
export type PopulationUniverse = (typeof POPULATION_UNIVERSES)[number];
export type PopulationSex = (typeof POPULATION_SEXES)[number];

/** A validated figure, ready to insert. */
export type PopulationRow = {
  lineNumber: number;
  regionCode: string;
  regionLevel: number;
  sourceRegionName: string;
  dimension: PopulationDimension;
  category: string;
  sex: PopulationSex | null;
  /** The published digits, normalised to `\d+(\.\d\d)?` text — what gets stored. */
  value: string;
  /** The same value in hundredths, for exact integer arithmetic. */
  valueCents: number;
  unit: PopulationUnit;
  referenceYear: number;
  figureBasis: PopulationFigureBasis;
  universe: PopulationUniverse;
  sourceTable: string;
  sourcePage: number | null;
  valueNote: "nil" | null;
  /** The category label as published, or null. */
  categoryLabel: string | null;
};

export type ConsistencyCheckKind =
  | "sex_sum"
  | "age_group_sum"
  | "age_group_by_sex_sum"
  | "religion_sum"
  | "children_sum";

export type PopulationValidationContext = {
  /** Region code -> level, from the ACTIVE region dataset. */
  regionLevels: ReadonlyMap<string, number>;
  /** Kemendagri code of the region the publication covers. */
  coverageRegionCode: string;
};

export type PopulationValidationReport = {
  rowCount: number;
  countsByDimension: Record<string, number>;
  checksRun: Record<ConsistencyCheckKind, number>;
  checksSkipped: Record<ConsistencyCheckKind, number>;
  /** Up to {@link SKIPPED_SAMPLE_LIMIT} human-readable reasons, for the operator. */
  skippedSamples: string[];
  /** Cross-table disagreements; informational, never block the import. */
  warningCount: number;
  /** Up to {@link WARNING_SAMPLE_LIMIT} of them. */
  warnings: string[];
};

export type PopulationValidationResult = {
  rows: PopulationRow[];
  errors: string[];
  report: PopulationValidationReport;
};

const SKIPPED_SAMPLE_LIMIT = 20;
const WARNING_SAMPLE_LIMIT = 50;
const CODE_SHAPE = /^\d{2}(\.\d{2}(\.\d{2}(\.\d{4})?)?)?$/;
const VALUE_SHAPE = /^\d{1,12}(\.\d{1,2})?$/;
const AGE_BAND = /^(\d{1,3})-(\d{1,3})$|^(\d{1,3})\+$/;
/** Category keys are at most this long (also a CHECK in sql/882). */
export const MAX_CATEGORY_KEY_LENGTH = 80;
export const MAX_CATEGORY_LABEL_LENGTH = 500;
/** One key segment: lowercase words joined by _ or -, optionally ending in "+" right after a digit ("75+", "60+"). */
const SEGMENT = "[a-z0-9]+(?:[_-][a-z0-9]+)*(?:(?<=[0-9])\\+)?";
const OCCUPATION_CATEGORY = new RegExp(`^${SEGMENT}$`);
const BREAKDOWN_CATEGORY = new RegExp(`^${SEGMENT}/${SEGMENT}$`);

/** Segment count of a Kemendagri dotted code: '62' = 1, '62.71' = 2, ... */
export function regionLevelOfCode(code: string): number {
  return code.split(".").length;
}

/** Parent of a dotted code, or null for a province. */
export function parentRegionCode(code: string): string | null {
  const cut = code.lastIndexOf(".");
  return cut === -1 ? null : code.slice(0, cut);
}

function parseCents(text: string): number | null {
  if (!VALUE_SHAPE.test(text)) return null;
  const [whole = "0", fraction = ""] = text.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

function formatCents(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const fraction = String(cents % 100).padStart(2, "0");
  return `${whole}.${fraction}`;
}

function isOneOf<T extends string>(
  list: readonly T[],
  value: string
): value is T {
  return (list as readonly string[]).includes(value);
}

function categoryProblem(
  dimension: PopulationDimension,
  category: string
): string | null {
  switch (dimension) {
    case "total":
      return category === "total" ? null : 'must be "total"';
    case "sex":
      return isOneOf(POPULATION_SEXES, category)
        ? null
        : 'must be "laki_laki" or "perempuan"';
    case "age_group":
      return AGE_BAND.test(category) ? null : 'must look like "0-4" or "75+"';
    case "religion":
      return RELIGION_CATEGORIES.has(category)
        ? null
        : `must be one of ${[...RELIGION_CATEGORIES].join(", ")}`;
    case "occupation":
      return OCCUPATION_CATEGORY.test(category) ? null : "must be snake_case";
    case "income":
    case "expenditure":
      return category === "total" || BREAKDOWN_CATEGORY.test(category)
        ? null
        : 'must be "total" or "<breakdown>/<key>"';
  }
}

/**
 * The tolerance, in hundredths, for a sum of `parts` figures against a printed
 * figure: 0 for `jiwa`, 0.005 x (parts + 1) for `ribu_jiwa`.
 * Returned doubled so the comparison stays in integers: a difference of d
 * hundredths is within tolerance exactly when `2 * d <= doubledToleranceCents`.
 */
export function doubledToleranceCents(
  unit: PopulationUnit,
  parts: number
): number {
  return unit === "ribu_jiwa" ? parts + 1 : 0;
}

function groupKey(row: PopulationRow): string {
  return [
    row.regionCode,
    row.referenceYear,
    row.universe,
    row.unit,
    row.figureBasis,
    row.sourceTable
  ].join("|");
}

type Band = { start: number; end: number | null };

function parseBand(category: string): Band | null {
  const match = AGE_BAND.exec(category);
  if (!match) return null;
  if (match[3] !== undefined) return { start: Number(match[3]), end: null };
  return { start: Number(match[1]), end: Number(match[2]) };
}

/**
 * True when the bands tile ages from 0 to the open-ended last band without a
 * hole or an overlap. Only then can their sum be compared to a total: a missing
 * band is a gap in the publication, and a gap makes the check skip, not fail.
 */
function bandsFormCompletePartition(categories: string[]): boolean {
  const bands = categories.map(parseBand);
  if (bands.some((band) => band === null)) return false;
  const sorted = (bands as Band[]).sort((a, b) => a.start - b.start);
  let next = 0;
  for (const [index, band] of sorted.entries()) {
    if (band.start !== next) return false;
    if (band.end === null) return index === sorted.length - 1;
    next = band.end + 1;
  }
  return false;
}

/** Validates the parsed records and runs every consistency check. */
export function validatePopulationRecords(
  records: readonly PopulationCsvRecord[],
  context: PopulationValidationContext
): PopulationValidationResult {
  const errors: string[] = [];
  const rows: PopulationRow[] = [];
  const seenKeys = new Map<string, number>();
  const unknownCodes = new Set<string>();

  for (const record of records) {
    const where = `line ${record.lineNumber}`;
    const problems: string[] = [];

    const regionCode = record.region_code;
    if (!CODE_SHAPE.test(regionCode)) {
      problems.push(
        `region_code "${regionCode}" is not a dotted Kemendagri code`
      );
    }

    const levelText = record.region_level;
    const regionLevel = /^[1-4]$/.test(levelText) ? Number(levelText) : null;
    if (regionLevel === null) {
      problems.push(`region_level "${levelText}" must be 1, 2, 3 or 4`);
    } else if (
      CODE_SHAPE.test(regionCode) &&
      regionLevelOfCode(regionCode) !== regionLevel
    ) {
      problems.push(
        `region_level ${regionLevel} does not match the shape of code ${regionCode}`
      );
    }

    if (record.source_region_name.trim().length === 0) {
      problems.push("source_region_name is empty");
    }

    const dimension = record.dimension;
    if (!isOneOf(POPULATION_DIMENSIONS, dimension)) {
      problems.push(`dimension "${dimension}" is not recognised`);
    }

    const sexText = record.sex;
    if (sexText !== "" && !isOneOf(POPULATION_SEXES, sexText)) {
      problems.push(`sex "${sexText}" must be empty, laki_laki or perempuan`);
    }

    const unit = record.unit;
    if (!isOneOf(POPULATION_UNITS, unit)) {
      problems.push(`unit "${unit}" must be jiwa, ribu_jiwa or rupiah`);
    }

    const basis = record.figure_basis;
    if (!isOneOf(POPULATION_FIGURE_BASES, basis)) {
      problems.push(`figure_basis "${basis}" is not recognised`);
    }

    const universe = record.universe;
    if (!isOneOf(POPULATION_UNIVERSES, universe)) {
      problems.push(`universe "${universe}" is not recognised`);
    }

    const valueCents = parseCents(record.value);
    if (valueCents === null) {
      problems.push(
        `value "${record.value}" must be digits with "." as the decimal separator and at most two decimals`
      );
    }

    const yearText = record.reference_year;
    const referenceYear = /^\d{4}$/.test(yearText) ? Number(yearText) : null;
    if (
      referenceYear === null ||
      referenceYear < 1961 ||
      referenceYear > 2100
    ) {
      problems.push(
        `reference_year "${yearText}" must be a year in 1961..2100`
      );
    }

    if (record.source_table.trim().length === 0) {
      problems.push("source_table is empty");
    }

    let sourcePage: number | null = null;
    if (record.source_page !== "") {
      if (/^[1-9]\d{0,5}$/.test(record.source_page)) {
        sourcePage = Number(record.source_page);
      } else {
        problems.push(
          `source_page "${record.source_page}" must be a positive integer`
        );
      }
    }

    let valueNote: "nil" | null = null;
    if (record.value_note !== "") {
      if (record.value_note === "nil") {
        valueNote = "nil";
        if (valueCents !== null && valueCents !== 0) {
          problems.push('value_note "nil" is only valid on a value of 0');
        }
      } else {
        problems.push(
          `value_note "${record.value_note}" must be empty or "nil"`
        );
      }
    }

    // Cross-field rules, only once the fields they read are themselves valid.
    if (record.category.length > MAX_CATEGORY_KEY_LENGTH) {
      problems.push(
        `category is longer than ${MAX_CATEGORY_KEY_LENGTH} characters`
      );
    }
    if (record.category_label.length > MAX_CATEGORY_LABEL_LENGTH) {
      problems.push(
        `category_label is longer than ${MAX_CATEGORY_LABEL_LENGTH} characters`
      );
    }

    if (isOneOf(POPULATION_DIMENSIONS, dimension)) {
      const categoryIssue = categoryProblem(dimension, record.category);
      if (categoryIssue) {
        problems.push(
          `category "${record.category}" for ${dimension} ${categoryIssue}`
        );
      }
      if ((dimension === "total" || dimension === "sex") && sexText !== "") {
        problems.push(`sex must be empty for dimension ${dimension}`);
      }
      if (isOneOf(POPULATION_UNITS, unit)) {
        const monetary = dimension === "income" || dimension === "expenditure";
        if ((unit === "rupiah") !== monetary) {
          problems.push(
            monetary
              ? `${dimension} must be in rupiah`
              : `unit rupiah is only valid for income and expenditure`
          );
        }
      }
      if (isOneOf(POPULATION_UNIVERSES, universe)) {
        if (dimension === "income" && universe !== "employees") {
          problems.push("income must use universe employees");
        } else if (dimension === "expenditure" && universe !== "per_capita") {
          problems.push("expenditure must use universe per_capita");
        } else if (
          dimension !== "income" &&
          dimension !== "expenditure" &&
          (universe === "employees" || universe === "per_capita")
        ) {
          problems.push(
            `universe ${universe} is only valid for income/expenditure`
          );
        }
      }
    }
    if (unit === "jiwa" && valueCents !== null && valueCents % 100 !== 0) {
      problems.push(`unit jiwa requires a whole number, found ${record.value}`);
    }

    // Region must exist in the active region dataset, at this level, inside coverage.
    if (CODE_SHAPE.test(regionCode)) {
      const known = context.regionLevels.get(regionCode);
      if (known === undefined) {
        unknownCodes.add(regionCode);
      } else if (regionLevel !== null && known !== regionLevel) {
        problems.push(
          `region ${regionCode} is level ${known} in the active region dataset, not ${regionLevel}`
        );
      }
      if (
        regionCode !== context.coverageRegionCode &&
        !regionCode.startsWith(`${context.coverageRegionCode}.`)
      ) {
        problems.push(
          `region ${regionCode} lies outside the covered region ${context.coverageRegionCode}`
        );
      }
    }

    if (problems.length > 0) {
      for (const problem of problems) errors.push(`${where}: ${problem}.`);
      continue;
    }

    const row: PopulationRow = {
      lineNumber: record.lineNumber,
      regionCode,
      regionLevel: regionLevel!,
      sourceRegionName: record.source_region_name,
      dimension: dimension as PopulationDimension,
      category: record.category,
      sex: sexText === "" ? null : (sexText as PopulationSex),
      value: formatCents(valueCents!),
      valueCents: valueCents!,
      unit: unit as PopulationUnit,
      referenceYear: referenceYear!,
      figureBasis: basis as PopulationFigureBasis,
      universe: universe as PopulationUniverse,
      sourceTable: record.source_table,
      sourcePage,
      valueNote,
      categoryLabel: record.category_label === "" ? null : record.category_label
    };

    // The database's unique key, so a duplicate is caught here with a line number.
    const key = [
      row.sourceTable,
      row.regionCode,
      row.dimension,
      row.category,
      row.sex ?? "",
      row.referenceYear,
      row.universe,
      row.figureBasis
    ].join("|");
    const first = seenKeys.get(key);
    if (first !== undefined) {
      errors.push(
        `${where}: duplicates line ${first} (same source table, region, dimension, category, sex, reference year, universe and figure basis).`
      );
      continue;
    }
    seenKeys.set(key, record.lineNumber);
    rows.push(row);
  }

  if (unknownCodes.size > 0) {
    const sample = [...unknownCodes].sort().slice(0, 10).join(", ");
    errors.push(
      `${unknownCodes.size} region code(s) are absent from the active region dataset: ${sample}${unknownCodes.size > 10 ? ", ..." : ""}.`
    );
  }

  const report = emptyReport(rows);
  if (errors.length === 0) runConsistencyChecks(rows, context, report, errors);

  return { rows, errors, report };
}

function emptyReport(rows: PopulationRow[]): PopulationValidationReport {
  const zero = (): Record<ConsistencyCheckKind, number> => ({
    sex_sum: 0,
    age_group_sum: 0,
    age_group_by_sex_sum: 0,
    religion_sum: 0,
    children_sum: 0
  });
  const countsByDimension: Record<string, number> = {};
  for (const row of rows) {
    countsByDimension[row.dimension] =
      (countsByDimension[row.dimension] ?? 0) + 1;
  }
  return {
    rowCount: rows.length,
    countsByDimension,
    checksRun: zero(),
    checksSkipped: zero(),
    skippedSamples: [],
    warningCount: 0,
    warnings: []
  };
}

function runConsistencyChecks(
  rows: PopulationRow[],
  context: PopulationValidationContext,
  report: PopulationValidationReport,
  errors: string[]
): void {
  const skip = (kind: ConsistencyCheckKind, why: string): void => {
    report.checksSkipped[kind] += 1;
    if (report.skippedSamples.length < SKIPPED_SAMPLE_LIMIT) {
      report.skippedSamples.push(`${kind}: ${why}`);
    }
  };

  const compare = (
    kind: ConsistencyCheckKind,
    label: string,
    expected: PopulationRow,
    parts: PopulationRow[]
  ): void => {
    report.checksRun[kind] += 1;
    const sum = parts.reduce((total, part) => total + part.valueCents, 0);
    const diff = Math.abs(sum - expected.valueCents);
    if (2 * diff > doubledToleranceCents(expected.unit, parts.length)) {
      errors.push(
        `${label}: ${kind} failed — the ${parts.length} part(s) add up to ${formatCents(sum)} but ${expected.value} is published (difference ${formatCents(diff)} ${expected.unit}, line ${expected.lineNumber}).`
      );
    }
  };

  // Rupiah rows are averages: they take part in no check at all.
  const countable = rows.filter((row) => row.unit !== "rupiah");

  // ---- Checks inside one (region, year, universe, unit, basis, table) group.
  const groups = new Map<string, PopulationRow[]>();
  for (const row of countable) {
    const key = groupKey(row);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  for (const group of groups.values()) {
    const first = group[0]!;
    const label = `${first.regionCode} ${first.sourceRegionName} (${first.referenceYear}, ${first.sourceTable})`;
    const total = group.find(
      (row) => row.dimension === "total" && row.category === "total"
    );
    const sexRows = group.filter((row) => row.dimension === "sex");
    const sexFigure = new Map(sexRows.map((row) => [row.category, row]));
    const hasBothSexes = POPULATION_SEXES.every((sex) => sexFigure.has(sex));

    if (sexRows.length > 0) {
      if (total && hasBothSexes) compare("sex_sum", label, total, sexRows);
      else skip("sex_sum", `${label}: needs the total and both sexes`);
    }

    const ageAll = group.filter(
      (row) => row.dimension === "age_group" && row.sex === null
    );
    if (ageAll.length > 0) {
      if (total && bandsFormCompletePartition(ageAll.map((r) => r.category))) {
        compare("age_group_sum", label, total, ageAll);
      } else {
        skip("age_group_sum", `${label}: needs the total and every age band`);
      }
    }

    for (const sex of POPULATION_SEXES) {
      const ageBySex = group.filter(
        (row) => row.dimension === "age_group" && row.sex === sex
      );
      if (ageBySex.length === 0) continue;
      const figure = sexFigure.get(sex);
      if (
        figure &&
        bandsFormCompletePartition(ageBySex.map((r) => r.category))
      ) {
        compare("age_group_by_sex_sum", `${label} [${sex}]`, figure, ageBySex);
      } else {
        skip(
          "age_group_by_sex_sum",
          `${label} [${sex}]: needs the sex figure and every age band`
        );
      }
    }

    const religions = group.filter(
      (row) => row.dimension === "religion" && row.sex === null
    );
    if (religions.length > 0) {
      const present = new Set(religions.map((row) => row.category));
      if (total && CORE_RELIGIONS.every((name) => present.has(name))) {
        compare("religion_sum", label, total, religions);
      } else {
        skip(
          "religion_sum",
          `${label}: needs the total and all six core religions`
        );
      }
    }
  }

  // ---- Children -> parent, over the same measure published at two levels.
  const childrenOf = new Map<string, string[]>();
  for (const [code] of context.regionLevels) {
    const parent = parentRegionCode(code);
    if (parent === null) continue;
    const list = childrenOf.get(parent);
    if (list) list.push(code);
    else childrenOf.set(parent, [code]);
  }

  const measureKey = (row: PopulationRow): string =>
    [
      row.dimension,
      row.category,
      row.sex ?? "",
      row.referenceYear,
      row.universe,
      row.unit,
      row.figureBasis,
      row.sourceTable
    ].join("|");

  // measure -> region code -> row
  const byMeasure = new Map<string, Map<string, PopulationRow>>();
  for (const row of countable) {
    const key = measureKey(row);
    let inner = byMeasure.get(key);
    if (!inner) {
      inner = new Map();
      byMeasure.set(key, inner);
    }
    inner.set(row.regionCode, row);
  }

  for (const inner of byMeasure.values()) {
    for (const parent of inner.values()) {
      const expectedChildren = childrenOf.get(parent.regionCode) ?? [];
      const published = expectedChildren
        .map((code) => inner.get(code))
        .filter((row): row is PopulationRow => row !== undefined);
      if (published.length === 0) continue; // nothing published beneath it: not a check
      const label = `${parent.regionCode} ${parent.sourceRegionName} (${parent.dimension}/${parent.category}${parent.sex ? `/${parent.sex}` : ""}, ${parent.referenceYear})`;
      if (published.length === expectedChildren.length) {
        compare("children_sum", label, parent, published);
      } else {
        skip(
          "children_sum",
          `${label}: ${published.length} of ${expectedChildren.length} child regions published`
        );
      }
    }
  }

  // ---- The same figure published in more than one table of the dataset.
  // A WARNING with the same rounding tolerance, never an error: two tables of one
  // publication may legitimately round or revise differently.
  const sameFigure = new Map<string, PopulationRow[]>();
  for (const row of countable) {
    const key = [
      row.regionCode,
      row.dimension,
      row.category,
      row.sex ?? "",
      row.referenceYear,
      row.universe,
      row.unit,
      row.figureBasis
    ].join("|");
    const list = sameFigure.get(key);
    if (list) list.push(row);
    else sameFigure.set(key, [row]);
  }
  for (const rows of sameFigure.values()) {
    if (rows.length < 2) continue;
    const base = rows[0]!;
    for (const other of rows.slice(1)) {
      const diff = Math.abs(other.valueCents - base.valueCents);
      if (2 * diff > doubledToleranceCents(base.unit, 1)) {
        report.warningCount += 1;
        if (report.warnings.length < WARNING_SAMPLE_LIMIT) {
          report.warnings.push(
            `${base.regionCode} ${base.sourceRegionName} (${base.dimension}/${base.category}${base.sex ? `/${base.sex}` : ""}, ${base.referenceYear}): ${base.sourceTable} says ${base.value} but ${other.sourceTable} says ${other.value} ${base.unit}.`
          );
        }
      }
    }
  }
}
