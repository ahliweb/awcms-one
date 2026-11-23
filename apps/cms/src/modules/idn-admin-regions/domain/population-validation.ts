/**
 * Validation of the Kepmendagri population and area figures (awcms-one
 * ADR-0053), and their mapping onto the regions of the ACTIVE region dataset.
 *
 * Pure: it takes the typed source rows of both files plus the facts about the
 * region dataset the caller looked up (code -> level and official name, levels
 * 1-2 only), and returns the figures to store, every blocking error and a
 * report. Nothing here reads a file or a database, so the importer's dry run and
 * its real run are the same code.
 *
 * ## What is checked — fail closed, every problem reported
 *
 *  1. Each `kode` resolves to a province (level 1) or regency/city (level 2) of
 *     the active region dataset, with a depth that matches that level. No code
 *     appears twice in one file.
 *  2. `pria + wanita = total` for every population row, exactly.
 *  3. Every area is greater than zero and printed with at most three decimals:
 *     a fourth decimal is refused, never rounded.
 *  4. Completeness: every level-1/2 region of the active dataset has exactly one
 *     population row and one area row.
 *  5. Consistency: the regencies/cities of each province add up to the
 *     province (persons by total and by sex; area in exact thousandths of a
 *     km2), and the provinces add up to the national row.
 *
 * Checks 4-5 run only when a file's codes all resolved: on a file with unknown
 * or duplicate codes they would only repeat the same problem as noise, and the
 * report says they were skipped.
 *
 * ## The national row
 *
 * `('0','INDONESIA',…)` is not a region of `awcms_idn_admin_regions`, and it is
 * derivable. It is checked against the sum of the provinces, then skipped and
 * listed in the report — never stored.
 *
 * ## The one repair, and why it is not a guess
 *
 * Five rows of the vendored `wilayah_luas.sql` carry codes that went through a
 * floating-point number on their way into the file: `11.1` is `11.10` (Aceh
 * Singkil) with its trailing zero dropped, and `31.0` is the province `31`
 * (DKI Jakarta). A code that does not resolve is read that way ONLY when all of
 * these hold, and every repair is listed in the report and on the dataset row:
 *
 *   * its shape is `NN.0` (read as `NN`) or `NN.D`, D = 1..9 (read as `NN.D0`);
 *   * the repaired code IS a region of the active dataset at the matching level;
 *   * the repaired code does not ALSO appear literally in the same file;
 *   * the row's name equals that region's official name (case and spacing
 *     folded) — the name is the independent witness that the reading is right.
 *
 * Anything else is an unknown code, and an error.
 *
 * A name that differs from the region's official name on a code that DID
 * resolve (`Kab Timor Tengah Selatan`, a typo such as `Papua Barat Oaya`) is a
 * WARNING: the code is the key, and the source's spelling is kept verbatim as
 * `source_region_name`.
 */
import { normalizeRegionName } from "./region-normalization";
import type { AreaSourceRow, PopulationSourceRow } from "./population-source";

export type PopulationDimension = "total" | "sex" | "area";
export type PopulationCategory = "total" | "laki_laki" | "perempuan";
export type PopulationUnit = "jiwa" | "km2";
export type PopulationFigureBasis = "decree" | "geospatial_calculation";
export type PopulationUniverse = "total_population" | "region_area";

/** What the caller knows about one level-1/2 region of the active region dataset. */
export type RegionFact = { level: number; name: string };

/** A validated figure, ready to insert. */
export type PopulationFigure = {
  regionCode: string;
  regionLevel: number;
  /** The region name exactly as the source file spells it. */
  sourceRegionName: string;
  dimension: PopulationDimension;
  category: PopulationCategory;
  /** The printed digits: a whole number of persons, or km2 with at most three decimals. */
  value: string;
  unit: PopulationUnit;
  referenceYear: number;
  figureBasis: PopulationFigureBasis;
  universe: PopulationUniverse;
  sourceTable: string;
  sourceLine: number;
};

export type CodeRepair = {
  sourceTable: string;
  lineNumber: number;
  sourceCode: string;
  code: string;
  name: string;
};

export type SkippedRow = {
  sourceTable: string;
  lineNumber: number;
  code: string;
  reason: string;
};

export type PopulationCheckKind =
  | "sex_sum"
  | "national_sum"
  | "children_sum_population"
  | "children_sum_area"
  | "completeness";

export type PopulationValidationReport = {
  rowCount: number;
  countsByDimension: Record<PopulationDimension, number>;
  countsByLevel: Record<string, number>;
  /** Every float-truncated code that was read back, with its witness name. */
  codeRepairs: CodeRepair[];
  /** Rows deliberately not stored (the national row). */
  skipped: SkippedRow[];
  checksRun: Record<PopulationCheckKind, number>;
  /** Checks that could not run, and why. */
  checksSkipped: string[];
  /** Name spellings that differ from the region dataset; informational. */
  warningCount: number;
  warnings: string[];
};

export type PopulationValidationResult = {
  rows: PopulationFigure[];
  errors: string[];
  report: PopulationValidationReport;
};

export type PopulationValidationInput = {
  population: {
    rows: readonly PopulationSourceRow[];
    sourceTable: string;
    referenceYear: number;
  };
  area: {
    rows: readonly AreaSourceRow[];
    sourceTable: string;
    referenceYear: number;
  };
  /** Level-1/2 regions of the ACTIVE region dataset, by dotted code. */
  regions: ReadonlyMap<string, RegionFact>;
};

/** The code the source uses for the whole country. */
export const NATIONAL_CODE = "0";

const WARNING_SAMPLE_LIMIT = 50;
const AREA_SHAPE = /^[0-9]+(\.[0-9]{1,3})?$/;

/** The float-truncation reading of a code (`11.1` -> `11.10`, `31.0` -> `31`), or null. */
export function floatTruncationCandidate(code: string): string | null {
  const province = /^([0-9]{2})\.0$/.exec(code);
  if (province) return province[1] ?? null;
  const regency = /^([0-9]{2})\.([1-9])$/.exec(code);
  if (regency) return `${regency[1]}.${regency[2]}0`;
  return null;
}

/** km2 text -> exact integer thousandths. Only called on {@link AREA_SHAPE} input. */
export function areaToThousandths(areaKm2: string): bigint {
  const [whole = "0", fraction = ""] = areaKm2.split(".");
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, "0"));
}

function formatThousandths(value: bigint): string {
  const whole = value / 1000n;
  const fraction = (value % 1000n).toString().padStart(3, "0");
  return `${whole}.${fraction}`;
}

type Resolved = { code: string; level: number; repaired: boolean };

/**
 * Resolves one source code to a level-1/2 region, applying the one documented
 * repair. Returns an error string when the code cannot be resolved.
 */
function resolveCode(
  sourceCode: string,
  name: string,
  regions: ReadonlyMap<string, RegionFact>,
  literalCodes: ReadonlySet<string>
): Resolved | { error: string } {
  const direct = regions.get(sourceCode);
  if (direct) return { code: sourceCode, level: direct.level, repaired: false };

  const candidate = floatTruncationCandidate(sourceCode);
  if (candidate === null) {
    return {
      error: `kode ${JSON.stringify(sourceCode)} ("${name}") is not a province or regency/city of the active region dataset`
    };
  }
  const region = regions.get(candidate);
  const reason = !region
    ? `${candidate} is not a region of the active dataset either`
    : literalCodes.has(candidate)
      ? `${candidate} also appears literally in the same file`
      : normalizeRegionName(region.name) !== normalizeRegionName(name)
        ? `the name "${name}" does not match ${candidate}'s official name "${region.name}"`
        : null;
  if (reason !== null || !region) {
    return {
      error: `kode ${JSON.stringify(sourceCode)} ("${name}") is not a province or regency/city of the active region dataset, and its float-truncation reading was refused: ${reason}`
    };
  }
  return { code: candidate, level: region.level, repaired: true };
}

type Placed<T> = { row: T; code: string; level: number };

/**
 * Resolves every row of one file: national row out, codes resolved (with the
 * repair), depth checked against the level, duplicates refused, names compared.
 */
function placeRows<
  T extends { code: string; name: string; lineNumber: number }
>(
  rows: readonly T[],
  sourceTable: string,
  regions: ReadonlyMap<string, RegionFact>,
  report: PopulationValidationReport,
  warnings: string[]
): { placed: Placed<T>[]; national: T[]; errors: string[] } {
  const errors: string[] = [];
  const placed: Placed<T>[] = [];
  const national: T[] = [];
  const literalCodes = new Set(rows.map((row) => row.code));
  const seen = new Map<string, number>();

  for (const row of rows) {
    const where = `${sourceTable} line ${row.lineNumber}`;
    if (row.code === NATIONAL_CODE) {
      national.push(row);
      if (national.length > 1) {
        errors.push(`${where}: a second national row ('${NATIONAL_CODE}').`);
      }
      continue;
    }

    const resolved = resolveCode(row.code, row.name, regions, literalCodes);
    if ("error" in resolved) {
      errors.push(`${where}: ${resolved.error}.`);
      continue;
    }
    const depth = resolved.code.split(".").length;
    if (depth !== resolved.level || depth > 2) {
      errors.push(
        `${where}: kode ${resolved.code} has depth ${depth} but the region dataset says level ${resolved.level}.`
      );
      continue;
    }
    const firstLine = seen.get(resolved.code);
    if (firstLine !== undefined) {
      errors.push(
        `${where}: kode ${resolved.code} is a duplicate of line ${firstLine}.`
      );
      continue;
    }
    seen.set(resolved.code, row.lineNumber);

    if (resolved.repaired) {
      report.codeRepairs.push({
        sourceTable,
        lineNumber: row.lineNumber,
        sourceCode: row.code,
        code: resolved.code,
        name: row.name
      });
    } else {
      const official = regions.get(resolved.code)?.name ?? "";
      if (normalizeRegionName(official) !== normalizeRegionName(row.name)) {
        warnings.push(
          `${where}: kode ${resolved.code} is spelled "${row.name}" here and "${official}" in the region dataset (the source spelling is kept).`
        );
      }
    }
    placed.push({ row, code: resolved.code, level: resolved.level });
  }

  return { placed, national, errors };
}

function emptyReport(): PopulationValidationReport {
  return {
    rowCount: 0,
    countsByDimension: { total: 0, sex: 0, area: 0 },
    countsByLevel: {},
    codeRepairs: [],
    skipped: [],
    checksRun: {
      sex_sum: 0,
      national_sum: 0,
      children_sum_population: 0,
      children_sum_area: 0,
      completeness: 0
    },
    checksSkipped: [],
    warningCount: 0,
    warnings: []
  };
}

/** Validates both files against the region dataset and returns the figures to store. */
export function buildPopulationFigures(
  input: PopulationValidationInput
): PopulationValidationResult {
  const report = emptyReport();
  const errors: string[] = [];
  const warnings: string[] = [];
  const { regions } = input;
  const popTable = input.population.sourceTable;
  const areaTable = input.area.sourceTable;

  // --- Population: placement and the per-row sex sum.
  const population = placeRows(
    input.population.rows,
    popTable,
    regions,
    report,
    warnings
  );
  errors.push(...population.errors);
  for (const row of input.population.rows) {
    report.checksRun.sex_sum += 1;
    if (row.male + row.female !== row.total) {
      errors.push(
        `${popTable} line ${row.lineNumber}: sex_sum failed for ${row.code} ("${row.name}"): pria ${row.male} + wanita ${row.female} = ${row.male + row.female}, total ${row.total}.`
      );
    }
  }
  for (const row of population.national) {
    report.skipped.push({
      sourceTable: popTable,
      lineNumber: row.lineNumber,
      code: row.code,
      reason:
        "national row: not a region of awcms_idn_admin_regions, and derivable as the sum of the provinces (checked, not stored)"
    });
  }

  // --- Area: placement and the per-row shape.
  const area = placeRows(input.area.rows, areaTable, regions, report, warnings);
  errors.push(...area.errors);
  for (const row of area.national) {
    report.skipped.push({
      sourceTable: areaTable,
      lineNumber: row.lineNumber,
      code: row.code,
      reason:
        "national row: not a region of awcms_idn_admin_regions (not stored)"
    });
  }
  let areaShapeErrors = 0;
  for (const row of input.area.rows) {
    if (!AREA_SHAPE.test(row.areaKm2)) {
      areaShapeErrors += 1;
      errors.push(
        `${areaTable} line ${row.lineNumber}: luas ${row.areaKm2} for ${row.code} must be a positive number with at most three decimals (it is never rounded).`
      );
    } else if (areaToThousandths(row.areaKm2) <= 0n) {
      areaShapeErrors += 1;
      errors.push(
        `${areaTable} line ${row.lineNumber}: luas for ${row.code} must be greater than zero, found ${row.areaKm2}.`
      );
    }
  }

  // --- Completeness and consistency, only over cleanly resolved files.
  const popByCode = new Map(population.placed.map((p) => [p.code, p.row]));
  const areaByCode = new Map(area.placed.map((p) => [p.code, p.row]));
  const populationClean = population.errors.length === 0;
  const areaClean = area.errors.length === 0 && areaShapeErrors === 0;
  const provinces = [...regions.entries()]
    .filter(([, fact]) => fact.level === 1)
    .map(([code]) => code)
    .sort();
  const childrenOf = (province: string) =>
    [...regions.entries()]
      .filter(
        ([code, fact]) => fact.level === 2 && code.startsWith(`${province}.`)
      )
      .map(([code]) => code)
      .sort();

  if (populationClean) {
    for (const code of [...regions.keys()].sort()) {
      report.checksRun.completeness += 1;
      if (!popByCode.has(code)) {
        errors.push(
          `${popTable}: region ${code} ("${regions.get(code)?.name}") of the active region dataset has no population row.`
        );
      }
    }
    for (const province of provinces) {
      const parent = popByCode.get(province);
      const children = childrenOf(province).map((code) => popByCode.get(code));
      if (!parent || children.some((child) => !child)) continue;
      report.checksRun.children_sum_population += 1;
      const sum = { male: 0, female: 0, total: 0 };
      for (const child of children) {
        sum.male += child?.male ?? 0;
        sum.female += child?.female ?? 0;
        sum.total += child?.total ?? 0;
      }
      if (
        sum.total !== parent.total ||
        sum.male !== parent.male ||
        sum.female !== parent.female
      ) {
        errors.push(
          `${popTable}: children_sum_population failed for province ${province}: its regencies/cities add up to ${sum.total} (pria ${sum.male}, wanita ${sum.female}), the province row says ${parent.total} (pria ${parent.male}, wanita ${parent.female}).`
        );
      }
    }
    const nationalRow = population.national[0];
    if (nationalRow && population.national.length === 1) {
      report.checksRun.national_sum += 1;
      const sum = { male: 0, female: 0, total: 0 };
      for (const province of provinces) {
        const row = popByCode.get(province);
        sum.male += row?.male ?? 0;
        sum.female += row?.female ?? 0;
        sum.total += row?.total ?? 0;
      }
      if (
        sum.total !== nationalRow.total ||
        sum.male !== nationalRow.male ||
        sum.female !== nationalRow.female
      ) {
        errors.push(
          `${popTable} line ${nationalRow.lineNumber}: national_sum failed: the provinces add up to ${sum.total} (pria ${sum.male}, wanita ${sum.female}), the national row says ${nationalRow.total} (pria ${nationalRow.male}, wanita ${nationalRow.female}).`
        );
      }
    } else if (!nationalRow) {
      report.checksSkipped.push(
        `national_sum: ${popTable} has no national row.`
      );
    }
  } else {
    report.checksSkipped.push(
      `completeness, children_sum_population, national_sum: ${popTable} has code errors.`
    );
  }

  if (areaClean) {
    for (const code of [...regions.keys()].sort()) {
      report.checksRun.completeness += 1;
      if (!areaByCode.has(code)) {
        errors.push(
          `${areaTable}: region ${code} ("${regions.get(code)?.name}") of the active region dataset has no area row.`
        );
      }
    }
    for (const province of provinces) {
      const parent = areaByCode.get(province);
      const children = childrenOf(province).map((code) => areaByCode.get(code));
      if (!parent || children.some((child) => !child)) continue;
      report.checksRun.children_sum_area += 1;
      const sum = children.reduce(
        (acc, child) => acc + areaToThousandths(child?.areaKm2 ?? "0"),
        0n
      );
      const own = areaToThousandths(parent.areaKm2);
      if (sum !== own) {
        errors.push(
          `${areaTable}: children_sum_area failed for province ${province}: its regencies/cities add up to ${formatThousandths(sum)} km2, the province row says ${formatThousandths(own)} km2.`
        );
      }
    }
  } else {
    report.checksSkipped.push(
      `completeness, children_sum_area: ${areaTable} has code or value errors.`
    );
  }

  // --- The figures, in a stable order: by code, then total, sex, area.
  const rows: PopulationFigure[] = [];
  const allCodes = [
    ...new Set([...popByCode.keys(), ...areaByCode.keys()])
  ].sort();
  for (const code of allCodes) {
    const level = regions.get(code)?.level ?? code.split(".").length;
    const pop = popByCode.get(code);
    if (pop) {
      const base = {
        regionCode: code,
        regionLevel: level,
        sourceRegionName: pop.name,
        unit: "jiwa" as const,
        referenceYear: input.population.referenceYear,
        figureBasis: "decree" as const,
        universe: "total_population" as const,
        sourceTable: popTable,
        sourceLine: pop.lineNumber
      };
      rows.push(
        {
          ...base,
          dimension: "total",
          category: "total",
          value: String(pop.total)
        },
        {
          ...base,
          dimension: "sex",
          category: "laki_laki",
          value: String(pop.male)
        },
        {
          ...base,
          dimension: "sex",
          category: "perempuan",
          value: String(pop.female)
        }
      );
    }
    const measured = areaByCode.get(code);
    if (measured && AREA_SHAPE.test(measured.areaKm2)) {
      rows.push({
        regionCode: code,
        regionLevel: level,
        sourceRegionName: measured.name,
        dimension: "area",
        category: "total",
        value: measured.areaKm2,
        unit: "km2",
        referenceYear: input.area.referenceYear,
        figureBasis: "geospatial_calculation",
        universe: "region_area",
        sourceTable: areaTable,
        sourceLine: measured.lineNumber
      });
    }
  }

  report.rowCount = rows.length;
  for (const row of rows) {
    report.countsByDimension[row.dimension] += 1;
    const level = String(row.regionLevel);
    report.countsByLevel[level] = (report.countsByLevel[level] ?? 0) + 1;
  }
  report.warningCount = warnings.length;
  report.warnings = warnings.slice(0, WARNING_SAMPLE_LIMIT);

  return { rows, errors, report };
}
