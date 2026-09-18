/**
 * tools/lib/redirect-push.ts — the `--push-redirects` mode of
 * `tools/import-seputarborneo.ts` (issue #58, review round 2).
 *
 * `POST /api/v1/seo/redirects/import` accepts at most
 * `MAX_REDIRECT_IMPORT_ITEMS` (200) items per call and is ALL-OR-NOTHING per
 * call. The exporter writes ~51,000 entries, i.e. ~256 calls — the first
 * runbook told the operator to `curl` those by hand, which is not a runbook.
 * This module is the loop: chunk, dry-run the WHOLE file, then commit chunk
 * by chunk under a deterministic `Idempotency-Key`.
 *
 * ## What was verified against the route, not guessed
 *
 * Read directly off `apps/cms/src/pages/api/v1/seo/redirects/import.ts`:
 *
 *  - Body: `{ redirects: RedirectRuleInput[], dryRun?: boolean }`.
 *  - Header: `idempotency-key` — REQUIRED on every call, dry-run included
 *    (the route rejects `IDEMPOTENCY_REQUIRED` before it looks at `dryRun`),
 *    but only LOOKED UP and STORED on a real import.
 *  - Success envelope: `{ success: true, data: { dryRun, total, valid | created,
 *    results: ItemReport[] } }`; `ItemReport = { index, ok,
 *    normalizedSourcePath?, code?, errors? }`.
 *  - Failure envelope: `{ success: false, error: { code, message, details:
 *    { results } } }` with `code: "IMPORT_VALIDATION_FAILED"` (400) when any
 *    item of a REAL import is refused — nothing written for that chunk.
 *  - Duplicates are detected INTRA-chunk only (`seenScopeKeys` is per
 *    request), against `normalizedSourcePath` — which is the source path
 *    with its QUERY STRING STRIPPED (`validateRedirectInput` calls
 *    `normalizeRedirectPath(rawSource)` without `keepQuery`). A file-wide
 *    duplicate therefore only surfaces as a CONFLICT on the SECOND chunk's
 *    real import, after the first has already been written — so
 *    `findFileWideDuplicates` below runs the same normalization over the
 *    whole file BEFORE any network call and refuses on the first duplicate.
 *
 * ## Why the `--commit` pass does NOT dry-run first
 *
 * A dry run only knows whether a rule COULD be created now. After a crash
 * halfway through a commit run, every already-committed chunk's rows exist,
 * so a fresh dry run of those chunks reports every item as a CONFLICT with
 * its own row and would stop the rerun — the exact rerun this key derivation
 * is meant to make safe. The real import handles that case correctly by
 * itself: the CMS replays a committed chunk from its idempotency record
 * (same key, same request hash → the stored 200) and validates only a chunk
 * it has never seen. So the default (no `--commit`) mode is the file-wide
 * dry run, and `--commit` goes straight to real imports.
 *
 * ## Why the key is derived from the chunk's CONTENT, not its position
 *
 * The CMS pairs a key with a request hash and answers 409
 * `IDEMPOTENCY_CONFLICT` when the same key returns with a different body. A
 * key that only encoded the chunk index (`…-0`, `…-1`) would collide with
 * itself the moment the file is regenerated with one extra row (every
 * boundary shifts) — and turn a safe rerun into 256 confusing 409s. Hashing
 * the canonical JSON of the chunk means: identical content → identical key
 * → a replay; different content → a different key → a fresh, fully
 * validated import that fails loudly on the first row that now conflicts.
 *
 * Pure except for `pushRedirects`'s injected `post`/`log` — so
 * `tests/import-seputarborneo.test.mjs` drives the whole flow with a fake
 * poster and a mocked `fetch`, never a live CMS.
 */
import { createHash } from "node:crypto";

import { apiCall, type ApiResult, type Session } from "./awcms-api";

/**
 * A documented COPY of `apps/cms/src/modules/seo-distribution/domain/
 * redirect-rule.ts`'s `MAX_REDIRECT_IMPORT_ITEMS` — root `tools/` never
 * imports from the `apps/cms` subtree (see `tools/seed-borneojek-mart.ts`'s
 * header for the rule and its reason). A chunk larger than the route's cap
 * is refused outright with `VALIDATION_ERROR`, so a drift here fails the
 * very first call, loudly, not silently.
 */
export const MAX_REDIRECT_IMPORT_ITEMS = 200;

export const REDIRECT_IMPORT_PATH = "/api/v1/seo/redirects/import";

/** One entry of `tools/out/seputarborneo/redirects.json` — the exporter's `RedirectEntry`, re-read from disk so this module needs no import from the exporter. */
export type RedirectImportItem = {
  sourcePath: string;
  target: string;
  origin: string;
  statusCode: number;
};

/** The route's own per-item report — field-for-field `ItemReport` in `import.ts`. */
export type ImportItemReport = {
  index: number;
  ok: boolean;
  normalizedSourcePath?: string;
  code?: string;
  errors?: unknown;
};

type ImportSuccessData = {
  dryRun: boolean;
  total: number;
  valid?: number;
  created?: number;
  results: ImportItemReport[];
};

type ImportErrorEnvelope = {
  success: false;
  error: { code: string; message: string; details?: { results?: ImportItemReport[] } };
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Splits `items` into consecutive slices of at most `size` (the route's cap by default); the last slice may be shorter. */
export function chunkRedirects<T>(items: readonly T[], size: number = MAX_REDIRECT_IMPORT_ITEMS): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`chunk size must be a positive integer, got ${size}`);
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

/** JSON with every object's keys sorted, recursively — so two files that differ only in key order hash the same (the same idea as `apps/cms`'s own `computeRequestHash`). */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * `seputarborneo-redirects-<sha256 of the chunk's canonical JSON>` — the
 * `Idempotency-Key` for one chunk. Deterministic across runs, machines, and
 * key order; different for any change to any item (see the module header
 * for why content, not position).
 */
export function chunkIdempotencyKey(chunk: readonly RedirectImportItem[]): string {
  const digest = createHash("sha256").update(stableStringify(chunk)).digest("hex");
  return `seputarborneo-redirects-${digest}`;
}

/**
 * The route's `normalizedSourcePath`, approximated client-side for the ONE
 * purpose of spotting file-wide duplicates before any call: fragment and
 * QUERY dropped, duplicate slashes collapsed, percent-escapes upper-cased,
 * one trailing slash removed (`normalizeRedirectPath` in `redirect-path.ts`,
 * checked directly). It is deliberately not a full port — eligibility and
 * open-redirect checks stay the route's job and are reported by the dry run.
 */
export function importScopeKey(sourcePath: string): string {
  const withoutFragment = sourcePath.split("#")[0] ?? "";
  const withoutQuery = withoutFragment.split("?")[0] ?? "";
  let path = (withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`)
    .replace(/\/{2,}/g, "/")
    .replace(/%[0-9a-fA-F]{2}/g, (m) => m.toUpperCase());
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}

export type FileWideDuplicate = { scopeKey: string; indexes: number[] };

/** Every scope key that more than one entry of the file collapses onto, with the entries' 0-based positions — the defect the route can only see per chunk. */
export function findFileWideDuplicates(items: readonly RedirectImportItem[]): FileWideDuplicate[] {
  const byKey = new Map<string, number[]>();
  items.forEach((item, index) => {
    const key = importScopeKey(item.sourcePath);
    const list = byKey.get(key);
    if (list) list.push(index);
    else byKey.set(key, [index]);
  });
  return [...byKey.entries()]
    .filter(([, indexes]) => indexes.length > 1)
    .map(([scopeKey, indexes]) => ({ scopeKey, indexes }));
}

/** Reads and shape-checks `redirects.json`'s parsed content; refuses anything that is not an array of `{ sourcePath, target }` objects rather than posting garbage. */
export function parseRedirectFile(parsed: unknown): RedirectImportItem[] {
  if (!Array.isArray(parsed)) throw new Error("redirects.json must be a JSON array.");
  return parsed.map((entry, index) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as RedirectImportItem).sourcePath !== "string" ||
      typeof (entry as RedirectImportItem).target !== "string"
    ) {
      throw new Error(`redirects.json entry #${index} is not a { sourcePath, target } object.`);
    }
    return entry as RedirectImportItem;
  });
}

// ---------------------------------------------------------------------------
// The poster — `apiCall` bound to the import route. Separate from
// `pushRedirects` so a test can mock `fetch` under it and assert the exact
// header/body the route reads, while `pushRedirects` itself is driven by a
// fake poster with no HTTP at all.
// ---------------------------------------------------------------------------

export type ImportPoster = (
  body: { redirects: RedirectImportItem[]; dryRun: boolean },
  idempotencyKey: string
) => Promise<ApiResult<ImportSuccessData>>;

export function createRedirectImportPoster(baseUrl: string, session: Session): ImportPoster {
  return (body, idempotencyKey) =>
    apiCall<ImportSuccessData>(baseUrl, "POST", REDIRECT_IMPORT_PATH, { session, body, idempotencyKey });
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export type ChunkOutcome = {
  chunkIndex: number;
  /** 0-based position of the chunk's first item in the file — so a per-item `index` in the report can be mapped back to a line of `redirects.json`. */
  offset: number;
  size: number;
  idempotencyKey: string;
  status: number;
  ok: boolean;
  /** The route's own `code` on failure (`IMPORT_VALIDATION_FAILED`, `IDEMPOTENCY_CONFLICT`, …). */
  code?: string;
  /** Per-item reports the route returned — only the refused ones are kept. */
  refused: ImportItemReport[];
  created?: number;
};

export type PushSummary = {
  mode: "dry-run" | "commit";
  totalItems: number;
  chunks: number;
  attempted: number;
  succeeded: number;
  failed: number;
  created: number;
  duplicates: FileWideDuplicate[];
  outcomes: ChunkOutcome[];
};

export type PushOptions = {
  commit: boolean;
  post: ImportPoster;
  log?: (line: string) => void;
  chunkSize?: number;
};

function refusedItems(results: ImportItemReport[] | undefined): ImportItemReport[] {
  return (results ?? []).filter((item) => !item.ok);
}

/**
 * Runs the file through the route. Never throws on a refused chunk — every
 * outcome is in the returned summary and `failed > 0` is the caller's exit
 * code; a thrown error means the CALL itself could not be made (network,
 * unparseable response), which is a different failure and stays one.
 *
 * Stops at the FIRST failed chunk in either mode. In dry-run mode that is
 * enough to act on (and the remaining chunks' answers would not change the
 * decision); in commit mode it leaves every later chunk untouched, so the
 * operator fixes the reported rows and reruns — the committed chunks
 * replay, the rest import.
 */
export async function pushRedirects(
  items: readonly RedirectImportItem[],
  options: PushOptions
): Promise<PushSummary> {
  const log = options.log ?? (() => {});
  const mode: PushSummary["mode"] = options.commit ? "commit" : "dry-run";
  const size = options.chunkSize ?? MAX_REDIRECT_IMPORT_ITEMS;
  const chunks = chunkRedirects(items, size);

  const summary: PushSummary = {
    mode,
    totalItems: items.length,
    chunks: chunks.length,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    created: 0,
    duplicates: findFileWideDuplicates(items),
    outcomes: []
  };

  if (summary.duplicates.length > 0) {
    log(
      `${summary.duplicates.length} source path(s) appear more than once in the file once the CMS's ` +
        `own normalization (query string dropped) is applied — nothing was sent. The route would ` +
        `only catch these per chunk, as a CONFLICT after an earlier chunk had already been written:`
    );
    for (const duplicate of summary.duplicates.slice(0, 20)) {
      log(`  ${duplicate.scopeKey}  <- entries ${duplicate.indexes.join(", ")}`);
    }
    if (summary.duplicates.length > 20) log(`  … and ${summary.duplicates.length - 20} more`);
    summary.failed = 1;
    return summary;
  }

  log(`${mode.toUpperCase()}: ${items.length} entries in ${chunks.length} chunk(s) of at most ${size}.`);

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex]!;
    const offset = chunkIndex * size;
    const idempotencyKey = chunkIdempotencyKey(chunk);
    summary.attempted++;

    const result = await options.post({ redirects: chunk, dryRun: !options.commit }, idempotencyKey);

    const outcome: ChunkOutcome = {
      chunkIndex,
      offset,
      size: chunk.length,
      idempotencyKey,
      status: result.status,
      ok: false,
      refused: []
    };

    if (result.ok) {
      const data = result.data;
      outcome.refused = refusedItems(data?.results);
      // A dry run answers 200 even when items are refused (`valid < total`);
      // a real import answers 200 ONLY when every item was created.
      outcome.ok = outcome.refused.length === 0;
      if (options.commit && typeof data?.created === "number") {
        outcome.created = data.created;
        summary.created += data.created;
      }
    } else {
      const envelope = result.raw as ImportErrorEnvelope | null;
      outcome.code = envelope?.error?.code;
      outcome.refused = refusedItems(envelope?.error?.details?.results);
    }

    summary.outcomes.push(outcome);

    if (outcome.ok) {
      summary.succeeded++;
      log(
        `  chunk ${chunkIndex + 1}/${chunks.length}  ok   entries ${offset}-${offset + chunk.length - 1}` +
          (options.commit ? `  created=${outcome.created ?? "?"}` : "") +
          `  key=${idempotencyKey.slice(-12)}`
      );
      continue;
    }

    summary.failed++;
    log(
      `  chunk ${chunkIndex + 1}/${chunks.length}  FAILED  HTTP ${result.status}` +
        (outcome.code ? ` ${outcome.code}` : "") +
        `  entries ${offset}-${offset + chunk.length - 1}  key=${idempotencyKey}`
    );
    for (const item of outcome.refused.slice(0, 50)) {
      log(
        `    entry ${offset + item.index}  ${item.code ?? "REFUSED"}` +
          (item.normalizedSourcePath ? `  ${item.normalizedSourcePath}` : "") +
          (item.errors !== undefined ? `  ${JSON.stringify(item.errors)}` : "")
      );
    }
    if (outcome.refused.length > 50) log(`    … and ${outcome.refused.length - 50} more refused item(s)`);
    if (outcome.refused.length === 0 && result.raw) {
      log(`    ${JSON.stringify(result.raw).slice(0, 500)}`);
    }
    break;
  }

  return summary;
}

/** The operator-facing tail of a run — counts only, one line each. */
export function formatPushSummary(summary: PushSummary): string {
  const lines = [
    `import-seputarborneo --push-redirects ${summary.mode === "commit" ? "COMMITTED" : "DRY RUN"}`,
    `  entries            ${summary.totalItems}`,
    `  chunks             ${summary.chunks} (attempted ${summary.attempted})`,
    `  chunks ok          ${summary.succeeded}`,
    `  chunks failed      ${summary.failed}`
  ];
  if (summary.mode === "commit") lines.push(`  rules created      ${summary.created}`);
  if (summary.duplicates.length > 0) lines.push(`  file-wide dupes    ${summary.duplicates.length}`);
  if (summary.failed > 0) {
    lines.push(
      summary.mode === "commit"
        ? "  stopped at the first failed chunk — fix the reported entries and rerun; committed chunks replay from their Idempotency-Key, the rest import"
        : "  fix the reported entries (or the exporter) and rerun the dry run before --commit"
    );
  } else if (summary.mode === "dry-run") {
    lines.push("  every chunk validated — rerun with --commit to import");
  }
  return lines.join("\n");
}
