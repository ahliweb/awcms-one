/**
 * Parser for the two vendored population/area dumps (awcms-one ADR-0053):
 * `data/idn-admin-regions/upstream/cahyadsn-wilayah/db/wilayah_penduduk.sql`
 * and `db/wilayah_luas.sql`.
 *
 * Both are MySQL-style dumps: a licence header in a block comment, DDL, then one
 * or more `INSERT INTO <table>(<columns>) VALUES` statements whose value tuples
 * sit one per line:
 *
 * ```sql
 * ('11.01','Kabupaten Aceh Selatan','120041','119588','239629'),
 * ('11.01','Kabupaten Aceh Selatan',4174.211),
 * ```
 *
 * ## Parsed as TEXT, strictly — the same rules as `wilayah-dump-parser.ts`
 *
 * Nothing here executes SQL: feeding upstream statements to a database would
 * hand a third-party project DDL/DML in ours. And nothing here SKIPS a line it
 * does not understand. Every line is a comment, DDL this parser knows to ignore,
 * an `INSERT`/`VALUES` header, or a value tuple; anything else lands in
 * `unparsed`, and a non-empty `unparsed` fails the import with line numbers.
 *
 * Stricter than the region parser in one way: the `INSERT` header is CHECKED.
 * A tuple is read against the column list of the statement it belongs to, and
 * that list must be exactly the one the caller expects. If upstream reorders
 * `pria`/`wanita` or adds a column, the import fails instead of silently storing
 * women as men. A tuple outside an `INSERT ... VALUES` statement is an error.
 *
 * Pure: no filesystem, no database, no network.
 */

/** One value inside a tuple: a quoted string, a bare number, or a bare `NULL`. */
export type DumpValue =
  | { kind: "string"; text: string }
  | { kind: "number"; text: string }
  | { kind: "null" };

export type DumpTuple = {
  values: DumpValue[];
  /** 1-based line number in the dump, so every error points at a real place. */
  lineNumber: number;
};

export type DumpProblem = {
  lineNumber: number;
  content: string;
  reason: string;
};

export type DumpParseResult = {
  tuples: DumpTuple[];
  /** Lines that are legitimately not data (header, DDL, blank, comment). */
  ignoredLineCount: number;
  /** Lines that could not be classified. Non-empty means the import MUST fail. */
  unparsed: DumpProblem[];
  /** How many `INSERT` statements carried the tuples (informational). */
  insertStatementCount: number;
};

export type DumpExpectation = {
  /** Table name every `INSERT INTO` must target. */
  table: string;
  /** Column list every `INSERT INTO` must name, in order. */
  columns: readonly string[];
};

/** Single-line statements and comments that carry no data. */
const IGNORABLE_LINE =
  /^(--|$|DROP\b|CREATE\b|ALTER\b|SET\b|COMMIT\b|START\b|LOCK\b|UNLOCK\b)/i;

/** Statements whose body may span lines and must be skipped whole (`CREATE TABLE … (` … `);`). */
const MULTILINE_STATEMENT_START =
  /^(DROP|CREATE|ALTER|SET|LOCK|UNLOCK|START)\b/i;

/** `INSERT INTO name(col, col, …)`, optionally followed by `VALUES` on the same line. */
const INSERT_HEADER =
  /^INSERT\s+INTO\s+`?([A-Za-z0-9_]+)`?\s*\(([^)]*)\)\s*(VALUES)?\s*$/i;

const BARE_NUMBER = /^-?[0-9]+(\.[0-9]+)?$/;

/** MySQL escaping inside single-quoted literals, exactly as the region parser handles it. */
function unescapeSqlString(value: string): string {
  return value
    .replace(/''/g, "'")
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
}

/**
 * Reads one `( … )` tuple line. Returns the values and the terminator (`,` or
 * `;`), or a reason it is not a well-formed tuple. Quoted strings may contain
 * commas, parentheses and escaped quotes; bare tokens must be numbers or NULL.
 */
export function readTupleLine(
  line: string
):
  | { ok: true; values: DumpValue[]; terminator: "," | ";" }
  | { ok: false; reason: string } {
  if (!line.startsWith("(")) return { ok: false, reason: "not a tuple" };
  const values: DumpValue[] = [];
  let index = 1;

  for (;;) {
    while (line[index] === " ") index += 1;

    if (line[index] === "'") {
      let cursor = index + 1;
      let raw = "";
      for (;;) {
        const char = line[cursor];
        if (char === undefined) {
          return { ok: false, reason: "unterminated string literal" };
        }
        if (char === "\\" && cursor + 1 < line.length) {
          raw += line.slice(cursor, cursor + 2);
          cursor += 2;
          continue;
        }
        if (char === "'") {
          if (line[cursor + 1] === "'") {
            raw += "''";
            cursor += 2;
            continue;
          }
          break;
        }
        raw += char;
        cursor += 1;
      }
      values.push({ kind: "string", text: unescapeSqlString(raw) });
      index = cursor + 1;
    } else {
      let cursor = index;
      while (
        cursor < line.length &&
        line[cursor] !== "," &&
        line[cursor] !== ")"
      ) {
        cursor += 1;
      }
      const token = line.slice(index, cursor).trim();
      if (/^NULL$/i.test(token)) {
        values.push({ kind: "null" });
      } else if (BARE_NUMBER.test(token)) {
        values.push({ kind: "number", text: token });
      } else {
        return {
          ok: false,
          reason: `unquoted value ${JSON.stringify(token)} is neither a number nor NULL`
        };
      }
      index = cursor;
    }

    while (line[index] === " ") index += 1;
    if (line[index] === ",") {
      index += 1;
      continue;
    }
    if (line[index] === ")") {
      index += 1;
      break;
    }
    return { ok: false, reason: "expected ',' or ')' after a value" };
  }

  const rest = line.slice(index).trim();
  if (rest === "," || rest === ";") {
    return { ok: true, values, terminator: rest };
  }
  return { ok: false, reason: "a tuple must end with ',' or ';'" };
}

function sameColumns(found: string[], expected: readonly string[]): boolean {
  return (
    found.length === expected.length &&
    found.every((column, i) => column === expected[i])
  );
}

/**
 * Parses a dump into raw tuples. Every tuple belongs to an `INSERT` statement
 * whose table and column list match `expected`; each tuple has exactly that
 * many values.
 */
export function parseValueDump(
  text: string,
  expected: DumpExpectation
): DumpParseResult {
  const tuples: DumpTuple[] = [];
  const unparsed: DumpProblem[] = [];
  let ignoredLineCount = 0;
  let insertStatementCount = 0;

  const lines = text.split("\n");
  let insideBlockComment = false;
  let insideDdlStatement = false;
  /** null = not inside an INSERT; "header" = INSERT seen, waiting for VALUES; "values" = reading tuples. */
  let insertState: null | "header" | "values" = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").replace(/\r$/, "").trim();
    const lineNumber = index + 1;
    const problem = (reason: string) =>
      unparsed.push({ lineNumber, content: line, reason });

    if (insideBlockComment) {
      ignoredLineCount += 1;
      if (line.includes("*/")) insideBlockComment = false;
      continue;
    }
    if (line.startsWith("/*")) {
      ignoredLineCount += 1;
      if (!line.includes("*/")) insideBlockComment = true;
      continue;
    }
    if (insideDdlStatement) {
      ignoredLineCount += 1;
      if (line.endsWith(";")) insideDdlStatement = false;
      continue;
    }

    if (line.startsWith("(")) {
      if (insertState !== "values") {
        problem("a value tuple outside an INSERT ... VALUES statement");
        continue;
      }
      const read = readTupleLine(line);
      if (!read.ok) {
        problem(read.reason);
        continue;
      }
      if (read.values.length !== expected.columns.length) {
        problem(
          `expected ${expected.columns.length} values (${expected.columns.join(", ")}), found ${read.values.length}`
        );
      } else {
        tuples.push({ values: read.values, lineNumber });
      }
      if (read.terminator === ";") insertState = null;
      continue;
    }

    const insert = INSERT_HEADER.exec(line);
    if (insert) {
      if (insertState !== null) {
        problem("a new INSERT before the previous one ended with ';'");
        continue;
      }
      const table = insert[1] ?? "";
      const columns = (insert[2] ?? "")
        .split(",")
        .map((column) => column.trim().replace(/`/g, ""));
      if (table !== expected.table || !sameColumns(columns, expected.columns)) {
        problem(
          `INSERT names ${table}(${columns.join(", ")}); expected ${expected.table}(${expected.columns.join(", ")})`
        );
        continue;
      }
      insertStatementCount += 1;
      ignoredLineCount += 1;
      insertState = insert[3] ? "values" : "header";
      continue;
    }

    if (/^VALUES$/i.test(line)) {
      if (insertState !== "header") {
        problem("VALUES without a preceding INSERT header");
        continue;
      }
      ignoredLineCount += 1;
      insertState = "values";
      continue;
    }

    if (IGNORABLE_LINE.test(line)) {
      if (line !== "" && insertState === "values") {
        problem("a statement inside an unfinished INSERT");
        continue;
      }
      ignoredLineCount += 1;
      if (MULTILINE_STATEMENT_START.test(line) && !line.endsWith(";")) {
        insideDdlStatement = true;
      }
      continue;
    }

    problem("unrecognised line");
  }

  if (insertState !== null) {
    unparsed.push({
      lineNumber: lines.length,
      content: "",
      reason: "the file ends inside an INSERT statement"
    });
  }

  return { tuples, ignoredLineCount, unparsed, insertStatementCount };
}
