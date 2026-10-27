/**
 * Parser for the population CSV contract (awcms-one ADR-0051).
 *
 * `data/idn-population/datasets/<dataset_code>.csv` is the hand-off between the
 * extraction of a BPS publication and `idn-population:import`: UTF-8, RFC 4180,
 * one fixed header. This module only turns text into records of STRINGS and
 * checks the shape of the file (header, field count, quoting). What a field
 * MEANS — enums, code shape, arithmetic — is `population-validation.ts`'s job,
 * so a malformed file and a malformed figure are reported by different code.
 *
 * Pure: no filesystem, no database, no clock.
 */

export const POPULATION_CSV_HEADER = [
  "region_code",
  "region_level",
  "source_region_name",
  "dimension",
  "category",
  "sex",
  "value",
  "unit",
  "reference_year",
  "figure_basis",
  "universe",
  "source_table",
  "source_page",
  "value_note",
  "category_label"
] as const;

export type PopulationCsvField = (typeof POPULATION_CSV_HEADER)[number];

/** One data record, every field still the text that was in the file. */
export type PopulationCsvRecord = Record<PopulationCsvField, string> & {
  /** 1-based line number of the record's first line, for error messages. */
  lineNumber: number;
};

export type PopulationCsvParseResult = {
  records: PopulationCsvRecord[];
  /** File-shape problems. A non-empty list means `records` must not be trusted. */
  errors: string[];
};

/**
 * Splits RFC 4180 text into rows of fields. Handles quoted fields containing
 * commas, doubled quotes and embedded newlines; accepts LF or CRLF and a
 * leading byte-order mark. A trailing newline does not produce an empty row.
 */
function splitRows(text: string): {
  rows: { fields: string[]; lineNumber: number }[];
  errors: string[];
} {
  const rows: { fields: string[]; lineNumber: number }[] = [];
  const errors: string[] = [];
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldWasQuoted = false;
  let line = 1;
  let rowStartLine = 1;
  let rowHasContent = false;

  const endField = (): void => {
    fields.push(field);
    field = "";
    fieldWasQuoted = false;
  };
  const endRow = (): void => {
    endField();
    if (rowHasContent) rows.push({ fields, lineNumber: rowStartLine });
    fields = [];
    rowHasContent = false;
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;

    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === "\n") line += 1;
        field += char;
      }
      continue;
    }

    if (char === '"') {
      if (field.length > 0 || fieldWasQuoted) {
        errors.push(`line ${line}: a quote appears inside an unquoted field.`);
      }
      inQuotes = true;
      fieldWasQuoted = true;
      rowHasContent = true;
    } else if (char === ",") {
      rowHasContent = true;
      endField();
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      endRow();
      line += 1;
      rowStartLine = line;
    } else {
      rowHasContent = true;
      field += char;
    }
  }

  if (inQuotes) {
    errors.push(`line ${rowStartLine}: a quoted field is never closed.`);
  } else if (rowHasContent) {
    endRow();
  }

  return { rows, errors };
}

/**
 * Parses the CSV text. The header must be EXACTLY {@link POPULATION_CSV_HEADER}
 * — same names, same order — because the importer indexes by name and a column
 * silently renamed upstream of it is how a figure ends up in the wrong field.
 */
export function parsePopulationCsv(text: string): PopulationCsvParseResult {
  const { rows, errors } = splitRows(text);
  const records: PopulationCsvRecord[] = [];

  const header = rows[0];
  if (!header) {
    return { records, errors: [...errors, "The CSV file is empty."] };
  }

  const expected = POPULATION_CSV_HEADER.join(",");
  if (header.fields.join(",") !== expected) {
    return {
      records,
      errors: [
        ...errors,
        `The CSV header must be exactly "${expected}", found "${header.fields.join(",")}".`
      ]
    };
  }

  for (const row of rows.slice(1)) {
    if (row.fields.length !== POPULATION_CSV_HEADER.length) {
      errors.push(
        `line ${row.lineNumber}: expected ${POPULATION_CSV_HEADER.length} fields, found ${row.fields.length}.`
      );
      continue;
    }

    const record = { lineNumber: row.lineNumber } as PopulationCsvRecord;
    POPULATION_CSV_HEADER.forEach((name, position) => {
      record[name] = row.fields[position]!;
    });
    records.push(record);
  }

  return { records, errors };
}
