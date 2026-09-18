/**
 * tools/lib/mysql-dump-reader.ts — issue #58.
 *
 * A streaming reader for a `mariadb-dump`/`mysqldump` `.sql.gz` file, built to
 * read the seputarborneo backup (`db-232-20260912-060738.sql.gz`, 228 MB
 * decompressed) without ever holding the whole file — or even one whole
 * `INSERT` statement — in memory. `berita_red` alone ships as 58 separate
 * extended-insert statements in the real dump (mysqldump's own packet-size
 * chunking), each one many megabytes long on a single line.
 *
 * ## Why this is not "just split on commas"
 *
 * A dump's `VALUES (...),(...);` line is not CSV: a quoted string can itself
 * contain commas, parentheses, and escaped quotes (`isi_berita` is CKEditor
 * HTML, so it is full of `<p style=\"...\">`), and the line can be split
 * across two `Bun.file(...).stream()` chunks at an arbitrary byte — including
 * mid-escape-sequence or mid-multibyte-UTF-8-character. Every function below
 * is written to be fed a chunk at a time and to say "not enough yet" rather
 * than parse garbage when a tuple/value is not fully buffered.
 *
 * ## Column order comes from the dump itself, not a hard-coded list
 *
 * Checked against the REAL dump (2026-09-18): `berita_vid`'s live production
 * schema has 9 columns (`id_vid`..`admin`), not the 25-column, post-migration
 * shape recorded in the seputarborneo repo's `tests/fixtures/schema.sql` — the
 * migrations that add `jadwal_tayang_normalized` etc. had not reached this
 * backup. A hard-coded column list keyed to the *reference repo's* schema
 * would silently misalign every value by one column the day a table's shape
 * differs even slightly from what a fixture recorded. This reader instead
 * parses each wanted table's own `CREATE TABLE` statement — which always
 * precedes its data in a `mysqldump` file — and uses THAT column order.
 *
 * `mysqldump`'s default (no `--complete-insert`) omits the column list on
 * `INSERT INTO`, so values are positional against the table's own `CREATE
 * TABLE` order — confirmed against this real dump's own `INSERT INTO
 * \`berita_red\` VALUES (...)` lines, which carry no column list.
 */

export type SqlValue = string | number | null;

export type DumpRow = {
  table: string;
  row: Record<string, SqlValue>;
};

/**
 * Finds the index of the `)` that matches the `(` at `text[openIndex]`,
 * respecting single/double-quoted spans (with backslash escaping) so a
 * literal `)` or `,` inside a quoted default value (`enum('a)','b')`) is
 * never mistaken for structure. Returns `null` when the buffered text ends
 * before the match is found — the caller's signal to wait for more data.
 */
function findMatchingParen(text: string, openIndex: number): number | null {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;

  for (let i = openIndex; i < text.length; i++) {
    const c = text[i];

    if (inSingle) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === "'") inSingle = false;
      continue;
    }

    if (inDouble) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }

    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "(") {
      depth++;
      continue;
    }
    if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }

  return null;
}

/**
 * Extracts ordered column names from the BODY of a `CREATE TABLE (...)`
 * statement (the text strictly between the outer `(` and its matching `)`).
 * Each top-level, comma-separated segment is either a column definition
 * (starts with a backtick-quoted identifier — captured) or a table-level
 * clause (`PRIMARY KEY (...)`, `KEY ... (...)`, `CONSTRAINT ...` — skipped,
 * since none of those start with a backtick). Depth/quote tracking is
 * required because a column definition's own type can carry commas
 * (`decimal(10,2)`) and quoted commas (`enum('a,b','c')`) that are not
 * segment separators.
 */
export function extractCreateTableColumns(inner: string): string[] {
  const names: string[] = [];
  const n = inner.length;
  let i = 0;

  while (i < n) {
    while (i < n && /[\s,]/.test(inner[i]!)) i++;
    if (i >= n) break;

    if (inner[i] === "`") {
      let j = i + 1;
      while (j < n && inner[j] !== "`") j++;
      names.push(inner.slice(i + 1, j));
      i = j + 1;
    }

    // Advance to the next TOP-LEVEL comma (depth 0 relative to this call),
    // whether or not the segment just handled was a column definition.
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    while (i < n) {
      const c = inner[i]!;
      if (inSingle) {
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "'") inSingle = false;
        i++;
        continue;
      }
      if (inDouble) {
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === '"') inDouble = false;
        i++;
        continue;
      }
      if (c === "'") {
        inSingle = true;
        i++;
        continue;
      }
      if (c === '"') {
        inDouble = true;
        i++;
        continue;
      }
      if (c === "(") {
        depth++;
        i++;
        continue;
      }
      if (c === ")") {
        depth--;
        i++;
        continue;
      }
      if (c === "," && depth === 0) break;
      i++;
    }
  }

  return names;
}

/**
 * MySQL/MariaDB backslash-escape decoding for a single-quoted string literal,
 * as `mysqldump` emits it (NOT the SQL-standard `''` doubling, which
 * `mysqldump` does not use by default). `\'`, `\"`, `\\`, `\n`, `\r`, `\0`,
 * `\Z` (Ctrl-Z) map to their real character; any other `\x` maps to the
 * literal `x` (MySQL's own rule for an escape sequence it does not recognise).
 */
function unescapeChar(escaped: string): string {
  switch (escaped) {
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "0":
      return "\0";
    case "Z":
      return "";
    case "t":
      return "\t";
    case "b":
      return "\b";
    default:
      return escaped;
  }
}

export type TupleParseResult =
  | { ok: true; values: SqlValue[]; endIndex: number }
  | { ok: false };

/**
 * Parses ONE `(...)` value tuple starting at `text[start] === "("`. Returns
 * `{ ok: false }` when the buffered text ends before the tuple's closing `)`
 * is found — the caller's signal to buffer more and retry from the same
 * `start`, never to guess. Exported for direct unit testing of the escape/
 * NULL/number/multi-value handling without going through the full tokenizer.
 */
export function tryParseValueTuple(
  text: string,
  start: number
): TupleParseResult {
  const n = text.length;
  if (text[start] !== "(") {
    throw new Error(
      `tryParseValueTuple: expected "(" at index ${start}, found ${JSON.stringify(text[start])}`
    );
  }

  let i = start + 1;
  const values: SqlValue[] = [];

  for (;;) {
    while (i < n && /\s/.test(text[i]!)) i++;
    if (i >= n) return { ok: false };

    // Empty tuple `()` — a table with zero columns never occurs here, but a
    // trailing `)` right after `(` (or after a comma, handled below) closes
    // the tuple cleanly rather than being treated as a missing value.
    if (text[i] === ")" && values.length === 0) {
      return { ok: true, values, endIndex: i + 1 };
    }

    const ch = text[i]!;

    // Dispatch on the FIRST character alone. Every valid token starts with
    // `'`, a digit/sign, or `N`/`n` (the only case genuinely ambiguous with
    // "not enough buffered yet" — everything else can never become a valid
    // token no matter how much more text arrives, so it is safe to throw on
    // it immediately rather than stall waiting for data that would not help).
    if (ch === "'") {
      let j = i + 1;
      let out = "";
      for (;;) {
        if (j >= n) return { ok: false };
        const c = text[j];
        if (c === "\\") {
          if (j + 1 >= n) return { ok: false };
          out += unescapeChar(text[j + 1]!);
          j += 2;
          continue;
        }
        if (c === "'") {
          j++;
          break;
        }
        out += c;
        j++;
      }
      values.push(out);
      i = j;
    } else if (ch === "N" || ch === "n") {
      // Need "NULL" (4 chars) PLUS one more to confirm it does not continue
      // into a longer bare word — without that lookahead char we cannot yet
      // tell "NULL" from a chunk boundary landing mid "NULLxyz".
      if (i + 5 > n) return { ok: false };
      const isNull =
        text.slice(i, i + 4).toUpperCase() === "NULL" &&
        !/[A-Za-z0-9_]/.test(text[i + 4]!);
      if (!isNull) {
        throw new Error(
          `tryParseValueTuple: unexpected token near ${JSON.stringify(text.slice(i, i + 10))} at index ${i}`
        );
      }
      values.push(null);
      i += 4;
    } else if (/[0-9+-]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9.eE+-]/.test(text[j]!)) j++;
      if (j >= n) return { ok: false }; // number might continue past this chunk
      values.push(Number(text.slice(i, j)));
      i = j;
    } else {
      throw new Error(
        `tryParseValueTuple: unexpected character ${JSON.stringify(ch)} ` +
          `at index ${i} (context: ${JSON.stringify(text.slice(Math.max(0, i - 20), i + 20))})`
      );
    }

    while (i < n && /\s/.test(text[i]!)) i++;
    if (i >= n) return { ok: false };

    if (text[i] === ",") {
      i++;
      continue;
    }
    if (text[i] === ")") {
      return { ok: true, values, endIndex: i + 1 };
    }
    return { ok: false };
  }
}

export type TupleEvent = { table: string; values: SqlValue[] };

type Mode =
  | { kind: "scanning" }
  | { kind: "seeking-schema-open"; table: string }
  | { kind: "seeking-values"; table: string }
  | { kind: "reading-tuples"; table: string };

/**
 * Finds the earliest of `CREATE TABLE` / `INSERT INTO` in `text`, from
 * `fromIndex`. Returns `null` when neither occurs (yet) in the buffered text.
 */
function findNextStatementStart(
  text: string,
  fromIndex: number
): { index: number; matchEnd: number; kind: "create" | "insert"; table: string } | null {
  const re = /(CREATE\s+TABLE|INSERT\s+INTO)\s+`?(\w+)`?/gi;
  re.lastIndex = fromIndex;
  const match = re.exec(text);
  if (!match) return null;

  return {
    index: match.index,
    matchEnd: match.index + match[0].length,
    kind: match[1]!.toUpperCase().startsWith("CREATE") ? "create" : "insert",
    table: match[2]!
  };
}

/**
 * Incremental tokenizer over dump TEXT (already gunzip-decompressed and
 * UTF-8-decoded). Feed it chunks in stream order; it returns every complete
 * row tuple it can extract from what has been buffered so far, for tables
 * named in `wantedTables` — and internally still walks (but discards) tuples
 * of every OTHER table, since skipping requires no less parsing than reading.
 *
 * Memory bound: the buffer only ever holds the tail from the last unresolved
 * boundary (a `CREATE TABLE` schema block, or one in-progress value tuple) —
 * never a whole `INSERT` statement, however many rows it holds.
 */
export class SqlInsertTokenizer {
  private buffer = "";
  private mode: Mode = { kind: "scanning" };
  private readonly wanted: ReadonlySet<string>;
  private readonly columnsByTable = new Map<string, string[]>();

  constructor(wantedTables: readonly string[]) {
    this.wanted = new Set(wantedTables);
  }

  /** Column order this tokenizer learned from the dump's own `CREATE TABLE` statements, for tests/diagnostics. */
  columnsFor(table: string): readonly string[] | undefined {
    return this.columnsByTable.get(table);
  }

  /**
   * True once the stream has ended cleanly at a statement boundary. `mode`
   * being back to `"scanning"` is sufficient — a real dump's own trailing
   * footer (the trailing `SET ...` housekeeping lines after the last `INSERT`) is exactly
   * more scanning-mode text with nothing of interest left in it, and is
   * expected to sit in the buffer's small kept tail at end of stream.
   * `false` means the file ended mid-schema-block or mid-value-tuple, which
   * is a truncated or corrupt dump, not a row this reader silently dropped.
   */
  isAtRest(): boolean {
    return this.mode.kind === "scanning";
  }

  feed(chunk: string): TupleEvent[] {
    this.buffer += chunk;
    const events: TupleEvent[] = [];

    for (;;) {
      if (this.mode.kind === "scanning") {
        const found = findNextStatementStart(this.buffer, 0);
        if (!found) {
          // No statement start buffered yet. Keep only a small tail — long
          // enough that "CREATE TABLE"/"INSERT INTO" can never be split
          // across the boundary undetected — so scanning through comments,
          // LOCK/UNLOCK TABLES, DROP TABLE, etc. does not grow unbounded.
          const KEYWORD_MARGIN = 24;
          if (this.buffer.length > KEYWORD_MARGIN) {
            this.buffer = this.buffer.slice(this.buffer.length - KEYWORD_MARGIN);
          }
          return events;
        }

        this.buffer = this.buffer.slice(found.matchEnd);
        this.mode =
          found.kind === "create"
            ? { kind: "seeking-schema-open", table: found.table }
            : { kind: "seeking-values", table: found.table };
        continue;
      }

      if (this.mode.kind === "seeking-schema-open") {
        const openIndex = this.buffer.indexOf("(");
        if (openIndex === -1) {
          // A schema preamble (options, comments) between the name and its
          // column list is short; bail to scanning if it runs away, rather
          // than buffering forever on a shape this reader did not expect.
          if (this.buffer.length > 512) this.mode = { kind: "scanning" };
          return events;
        }

        const closeIndex = findMatchingParen(this.buffer, openIndex);
        if (closeIndex === null) {
          return events; // need more of the schema block
        }

        if (this.wanted.has(this.mode.table)) {
          const inner = this.buffer.slice(openIndex + 1, closeIndex);
          this.columnsByTable.set(
            this.mode.table,
            extractCreateTableColumns(inner)
          );
        }

        this.buffer = this.buffer.slice(closeIndex + 1);
        this.mode = { kind: "scanning" };
        continue;
      }

      if (this.mode.kind === "seeking-values") {
        const match = /VALUES\s*/i.exec(this.buffer);
        if (!match) {
          // A column list (`INSERT INTO t (`a`,`b`) VALUES`) is short; if
          // "VALUES" has not appeared within a generous margin, this is not
          // the shape this reader understands and we resync by scanning.
          if (this.buffer.length > 4096) this.mode = { kind: "scanning" };
          return events;
        }

        this.buffer = this.buffer.slice(match.index + match[0].length);
        this.mode = { kind: "reading-tuples", table: this.mode.table };
        continue;
      }

      // this.mode.kind === "reading-tuples"
      {
        let i = 0;
        const n = this.buffer.length;
        while (i < n && /\s/.test(this.buffer[i]!)) i++;
        if (i >= n) {
          this.buffer = "";
          return events;
        }

        if (this.buffer[i] === ",") {
          this.buffer = this.buffer.slice(i + 1);
          continue;
        }

        if (this.buffer[i] === ";") {
          this.buffer = this.buffer.slice(i + 1);
          this.mode = { kind: "scanning" };
          continue;
        }

        if (this.buffer[i] !== "(") {
          throw new Error(
            `SqlInsertTokenizer: expected "(", "," or ";" while reading tuples ` +
              `for table "${this.mode.table}", found ${JSON.stringify(this.buffer[i])} ` +
              `at buffer offset ${i}.`
          );
        }

        const result = tryParseValueTuple(this.buffer, i);
        if (!result.ok) {
          // Incomplete tuple — wait for more data. Trim the buffer's already-
          // consumed leading whitespace/comma so it does not regrow every feed.
          if (i > 0) this.buffer = this.buffer.slice(i);
          return events;
        }

        if (this.wanted.has(this.mode.table)) {
          events.push({ table: this.mode.table, values: result.values });
        }

        this.buffer = this.buffer.slice(result.endIndex);
        continue;
      }
    }
  }
}

/**
 * Streams every row of `wantedTables` out of a gzip-compressed MariaDB/MySQL
 * dump at `path`, using `Bun.file(...).stream()` piped through a
 * `DecompressionStream("gzip")` — the file's compressed AND decompressed
 * bytes are both processed a chunk at a time, never read whole.
 *
 * Column order for each table is learned from the dump's own `CREATE TABLE`
 * statement (see this file's header for why that beats a hard-coded list);
 * a table named in `wantedTables` for which no `CREATE TABLE` was ever seen
 * before its data throws, since every value would otherwise be silently
 * unlabelled.
 */
export async function* readMysqlDumpRows(
  path: string,
  wantedTables: readonly string[]
): AsyncGenerator<DumpRow> {
  const tokenizer = new SqlInsertTokenizer(wantedTables);
  const stream = Bun.file(path)
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");

  function* toRows(events: TupleEvent[]): Generator<DumpRow> {
    for (const event of events) {
      const columns = tokenizer.columnsFor(event.table);
      if (!columns) {
        throw new Error(
          `readMysqlDumpRows: reached data for table "${event.table}" before ` +
            "its CREATE TABLE statement was parsed — cannot label its columns."
        );
      }
      const row: Record<string, SqlValue> = {};
      columns.forEach((name, index) => {
        row[name] = event.values[index] ?? null;
      });
      yield { table: event.table, row };
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      yield* toRows(tokenizer.feed(text));
    }
    const tail = decoder.decode();
    if (tail) yield* toRows(tokenizer.feed(tail));

    if (!tokenizer.isAtRest()) {
      throw new Error(
        `readMysqlDumpRows: ${path} ended mid-statement — the dump looks ` +
          "truncated or corrupt, so rows may have been silently lost. Re-download it."
      );
    }
  } finally {
    reader.releaseLock();
  }
}
