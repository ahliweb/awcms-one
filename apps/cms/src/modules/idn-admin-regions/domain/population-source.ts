/**
 * The Kepmendagri population and area source (awcms-one ADR-0053): what the two
 * vendored files are, where they came from, and how their tuples become typed
 * source rows.
 *
 * ONE place for the provenance facts, so the importer, the dataset row it
 * writes and the tests cannot drift apart. Every statement here is checked
 * against the files themselves by the importer (sha256 against
 * `manifest.json` and `checksums.sha256`, the decree and the BIG letter
 * against each file's own header) before a single figure is read.
 *
 * ## Provenance, per file, truthfully
 *
 *   * `db/wilayah_penduduk.sql` — "Data jumlah penduduk dan kode wilayah sesuai
 *     Kepmendagri No 300.2.2-2138 Tahun 2025". Persons (total, male, female)
 *     per province and regency/city, plus one national row.
 *   * `db/wilayah_luas.sql` — "Data Kode Wilayah sesuai Kepmendagri No
 *     300.2.2-2138 Tahun 2025", and "Data Luas Wilayah berdasar dari Badan
 *     Informasi Geospasial" (letter B-16.10/DIGD-BIG/IGD.04.04/12/2024 of 16
 *     December 2024). The CODES are the decree's; the AREA is BIG's, never
 *     Kemendagri's.
 *
 * Both are a community packaging (cahyadsn/wilayah, MIT), not an official
 * Kemendagri or BIG export: {@link IDN_ADMIN_REGIONS_OFFICIAL_REFERENCE_CAVEAT}
 * travels with every dataset row.
 *
 * Pure: no filesystem, no database.
 */
import {
  IDN_ADMIN_REGIONS_DUMP_DECREE_REFERENCE,
  IDN_ADMIN_REGIONS_OFFICIAL_REFERENCE_CAVEAT,
  IDN_ADMIN_REGIONS_SOURCE_LICENSE,
  IDN_ADMIN_REGIONS_SOURCE_REPOSITORY
} from "./source-provenance";
import type {
  DumpExpectation,
  DumpParseResult
} from "./population-dump-parser";

/** Directory of the vendored dataset, relative to `apps/cms`. */
export const POPULATION_DATA_DIR = "data/idn-admin-regions";

/** `checksums.sha256`, relative to {@link POPULATION_DATA_DIR}; lists files relative to its own folder. */
export const POPULATION_CHECKSUMS_PATH =
  "upstream/cahyadsn-wilayah/checksums.sha256";

/** The population file, as `manifest.json` names it (relative to {@link POPULATION_DATA_DIR}). */
export const POPULATION_FILE_PATH =
  "upstream/cahyadsn-wilayah/db/wilayah_penduduk.sql";

/** The area file, as `manifest.json` names it (relative to {@link POPULATION_DATA_DIR}). */
export const AREA_FILE_PATH = "upstream/cahyadsn-wilayah/db/wilayah_luas.sql";

/** The `importedBy` value `manifest.json` records for both files. */
export const POPULATION_IMPORTED_BY = "idn_admin_regions.population";

/** The decree both files cite; the same one the region dump cites. */
export const POPULATION_DECREE_REFERENCE =
  IDN_ADMIN_REGIONS_DUMP_DECREE_REFERENCE;

/** BIG's letter number, as `wilayah_luas.sql`'s header prints it. */
export const AREA_LETTER_NUMBER = "B-16.10/DIGD-BIG/IGD.04.04/12/2024";

/** Where the area figures come from, in full. */
export const AREA_SOURCE_REFERENCE = `Badan Informasi Geospasial, Surat Deputi Bidang Informasi Geospasial Dasar Nomor ${AREA_LETTER_NUMBER}, 16 Desember 2024, Hal Penghitungan Luas Wilayah di Seluruh Indonesia`;

export const POPULATION_SOURCE_TYPE = "kepmendagri_decree";
export const POPULATION_PUBLICATION_SERIES = "kepmendagri_kode_data_wilayah";
/** The decree covers the whole country: level 0, written `ID` (sql/883). */
export const POPULATION_COVERAGE_REGION_CODE = "ID";
export const POPULATION_COVERAGE_REGION_LEVEL = 0;
export const POPULATION_PUBLICATION_YEAR = 2025;

/**
 * Reference year stored on each figure. The files state no reference period
 * other than the decree (2025) and BIG's letter (2024), and none is guessed.
 */
export const POPULATION_REFERENCE_YEAR = 2025;
export const AREA_REFERENCE_YEAR = 2024;

/** `source_table` on each figure: the file it was read from. */
export const POPULATION_SOURCE_TABLE = "db/wilayah_penduduk.sql";
export const AREA_SOURCE_TABLE = "db/wilayah_luas.sql";

export const POPULATION_DUMP_EXPECTATION: DumpExpectation = {
  table: "wilayah_penduduk",
  columns: ["kode", "nama", "pria", "wanita", "total"]
};

export const AREA_DUMP_EXPECTATION: DumpExpectation = {
  table: "wilayah_luas",
  columns: ["kode", "nama", "luas"]
};

export const POPULATION_PUBLICATION_TITLE = `${POPULATION_DECREE_REFERENCE}: jumlah penduduk per provinsi dan kabupaten/kota, dengan luas wilayah dari Badan Informasi Geospasial`;

export const POPULATION_PUBLISHER_NAME =
  "Kementerian Dalam Negeri (kode wilayah dan jumlah penduduk); Badan Informasi Geospasial (luas wilayah)";

export const POPULATION_ATTRIBUTION = `Kode wilayah dan jumlah penduduk sesuai ${POPULATION_DECREE_REFERENCE}; luas wilayah dari ${AREA_SOURCE_REFERENCE}. Dibaca dari salinan komunitas ${IDN_ADMIN_REGIONS_SOURCE_REPOSITORY} (lisensi ${IDN_ADMIN_REGIONS_SOURCE_LICENSE}) yang di-vendor di repositori ini, bukan dari API atau ekspor resmi Kemendagri maupun BIG.`;

export const POPULATION_TERMS_OF_USE = `The files are distributed by ${IDN_ADMIN_REGIONS_SOURCE_REPOSITORY} under the ${IDN_ADMIN_REGIONS_SOURCE_LICENSE} License (data/idn-admin-regions/upstream/cahyadsn-wilayah/LICENSE). The licence covers that packaging; the figures are the decree's (persons, codes) and Badan Informasi Geospasial's (area), attributed to them. ${IDN_ADMIN_REGIONS_OFFICIAL_REFERENCE_CAVEAT}`;

/** `https://github.com/cahyadsn/wilayah/tree/<commit>/db` — where the files were read from. */
export function populationPublicationUrl(upstreamCommit: string): string {
  return `${IDN_ADMIN_REGIONS_SOURCE_REPOSITORY}/tree/${upstreamCommit}/db`;
}

/**
 * Deterministic dataset code: the decree plus the first eight hex digits of
 * each file's sha256, e.g. `kepmendagri-300.2.2-2138-2025-b0b6b9dc-3ffd506e`.
 * Re-importing identical bytes collides on it (a no-op by design); a corrected
 * file under the same decree gets a new code, and so a new dataset to activate.
 */
export function derivePopulationDatasetCode(
  populationSha256: string,
  areaSha256: string
): string {
  const match = /No\s+(\S+)\s+Tahun\s+(\d{4})/.exec(
    POPULATION_DECREE_REFERENCE
  );
  const decree = match ? `${match[1]}-${match[2]}` : "unknown";
  return `kepmendagri-${decree}-${populationSha256.slice(0, 8)}-${areaSha256.slice(0, 8)}`;
}

/** Whitespace-folded, so a reference wrapped across header lines still matches. */
export function foldWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** True when `reference` appears in the first 2000 characters of `text`, ignoring line wrapping. */
export function headerCites(text: string, reference: string): boolean {
  return foldWhitespace(text.slice(0, 2000)).includes(
    foldWhitespace(reference)
  );
}

/** One row of `wilayah_penduduk.sql`, typed. Counts are exact integers. */
export type PopulationSourceRow = {
  code: string;
  name: string;
  male: number;
  female: number;
  total: number;
  lineNumber: number;
};

/** One row of `wilayah_luas.sql`, typed. `areaKm2` is the printed digits. */
export type AreaSourceRow = {
  code: string;
  name: string;
  areaKm2: string;
  lineNumber: number;
};

const CODE_SHAPE = /^[0-9]+(\.[0-9]+)*$/;
const COUNT_SHAPE = /^[0-9]+$/;

function describe(lineNumber: number, column: string): string {
  return `line ${lineNumber}: ${column}`;
}

/**
 * Types the tuples of `wilayah_penduduk.sql`. Every value must be a quoted
 * string (the file quotes its counts), the code dotted digits, and each count a
 * whole, safe integer. Every problem is reported; a bad row is not returned.
 */
export function readPopulationRows(parsed: DumpParseResult): {
  rows: PopulationSourceRow[];
  errors: string[];
} {
  const rows: PopulationSourceRow[] = [];
  const errors: string[] = [];

  for (const tuple of parsed.tuples) {
    const [code, name, male, female, total] = tuple.values;
    const problems: string[] = [];
    const text = (value: typeof code, column: string): string => {
      if (value?.kind !== "string") {
        problems.push(
          `${describe(tuple.lineNumber, column)} must be a quoted string`
        );
        return "";
      }
      return value.text;
    };
    const count = (value: typeof code, column: string): number => {
      const raw = text(value, column);
      if (raw === "") return 0;
      if (!COUNT_SHAPE.test(raw) || !Number.isSafeInteger(Number(raw))) {
        problems.push(
          `${describe(tuple.lineNumber, column)} must be a whole number, found ${JSON.stringify(raw)}`
        );
        return 0;
      }
      return Number(raw);
    };

    const row: PopulationSourceRow = {
      code: text(code, "kode"),
      name: text(name, "nama").trim(),
      male: count(male, "pria"),
      female: count(female, "wanita"),
      total: count(total, "total"),
      lineNumber: tuple.lineNumber
    };
    if (row.code !== "" && !CODE_SHAPE.test(row.code)) {
      problems.push(
        `${describe(tuple.lineNumber, "kode")} ${JSON.stringify(row.code)} is not a dotted numeric code`
      );
    }
    if (code?.kind === "string" && row.name === "") {
      problems.push(`${describe(tuple.lineNumber, "nama")} is empty`);
    }

    if (problems.length > 0) errors.push(...problems);
    else rows.push(row);
  }

  return { rows, errors };
}

/**
 * Types the tuples of `wilayah_luas.sql`. The code and name are quoted strings
 * and the area a bare number; NULL is refused.
 */
export function readAreaRows(parsed: DumpParseResult): {
  rows: AreaSourceRow[];
  errors: string[];
} {
  const rows: AreaSourceRow[] = [];
  const errors: string[] = [];

  for (const tuple of parsed.tuples) {
    const [code, name, area] = tuple.values;
    const problems: string[] = [];

    const codeText = code?.kind === "string" ? code.text : "";
    if (code?.kind !== "string") {
      problems.push(
        `${describe(tuple.lineNumber, "kode")} must be a quoted string`
      );
    } else if (!CODE_SHAPE.test(codeText)) {
      problems.push(
        `${describe(tuple.lineNumber, "kode")} ${JSON.stringify(codeText)} is not a dotted numeric code`
      );
    }
    const nameText = name?.kind === "string" ? name.text.trim() : "";
    if (nameText === "") {
      problems.push(`${describe(tuple.lineNumber, "nama")} is missing`);
    }
    const areaText = area?.kind === "number" ? area.text : "";
    if (area?.kind !== "number") {
      problems.push(
        `${describe(tuple.lineNumber, "luas")} must be a bare number`
      );
    }

    if (problems.length > 0) errors.push(...problems);
    else
      rows.push({
        code: codeText,
        name: nameText,
        areaKm2: areaText,
        lineNumber: tuple.lineNumber
      });
  }

  return { rows, errors };
}
