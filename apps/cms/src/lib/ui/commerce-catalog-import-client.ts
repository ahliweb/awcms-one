/**
 * Browser side of `/admin/commerce-catalog-import` (Issue #291): pick a CSV,
 * validate it (dry-run), read the per-row report, then apply exactly the file
 * that was reviewed. The server is the authority for every decision — this
 * module only transports the file and paints the report.
 *
 * ## Why apply sends `expectedSha256`
 *
 * The dry-run report carries the SHA-256 of the bytes it validated. Apply sends
 * that value back, so a file edited between "Validate" and "Apply" is refused
 * (409 `IMPORT_FILE_MISMATCH`) instead of importing something nobody reviewed.
 * Apply also sends a fresh `Idempotency-Key` per click-through, reused for a
 * retry of the SAME apply (a double-click or a network retry cannot apply
 * twice).
 *
 * ## No innerHTML
 *
 * Every cell is created with `textContent`. The report contains SKUs and
 * message text derived from the uploaded file; none of it is ever parsed as
 * markup.
 *
 * All sentences the page shows are rendered server-side into `data-*`
 * attributes of the root element (translated); nothing here owns an English
 * literal except the machine-readable header names it sends.
 */

import { sendTextRequest } from "./admin-form-client";

type ReportRow = {
  row: number;
  line: number;
  sku: string | null;
  action: "create" | "update" | "unchanged" | "error";
  errors: { column: string; message: string }[];
};

export type ImportReportView = {
  mode: "dry_run" | "apply";
  valid: boolean;
  fileSha256: string;
  rowCount: number;
  summary: { create: number; update: number; unchanged: number; error: number };
  fatalErrors: { line?: number; column?: string; message: string }[];
  rows: ReportRow[];
  rowsTruncated: boolean;
  batchId?: string;
};

/** Fills `{name}` placeholders. */
export function fillTemplate(
  template: string,
  values: Record<string, string | number>
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match
  );
}

export async function postCatalogCsv(
  mode: "dry_run" | "apply",
  csvText: string,
  options: { expectedSha256?: string; idempotencyKey?: string } = {}
): Promise<{
  ok: boolean;
  code: string | null;
  report: ImportReportView | null;
}> {
  const query = new URLSearchParams({ mode });
  if (options.expectedSha256)
    query.set("expectedSha256", options.expectedSha256);
  const headers: Record<string, string> = {};
  if (options.idempotencyKey)
    headers["Idempotency-Key"] = options.idempotencyKey;

  // The shared core owns the fetch and the envelope contract; this module only
  // picks the report out of it (`data` on success, `error.details` on a 422/409
  // that still carries the per-row diagnostics).
  const result = await sendTextRequest(
    `/api/v1/commerce/products/import?${query}`,
    csvText,
    "text/csv; charset=utf-8",
    headers
  );
  const report = (result.payload?.data ??
    result.payload?.error?.details ??
    null) as ImportReportView | null;
  return {
    ok: result.ok,
    code: result.errorCode,
    report: report && typeof report === "object" ? report : null
  };
}

function cell(
  text: string,
  label: string,
  className?: string
): HTMLTableCellElement {
  const td = document.createElement("td");
  td.textContent = text;
  td.dataset.label = label;
  if (className) td.className = className;
  return td;
}

/** Paints the per-row report into the page's (server-rendered) table body. */
export function paintReport(
  report: ImportReportView,
  root: HTMLElement,
  tbody: HTMLTableSectionElement,
  summaryEl: HTMLElement,
  fatalEl: HTMLElement
): void {
  const text = (key: string): string => root.dataset[key] ?? "";

  summaryEl.textContent = fillTemplate(text("summaryTemplate"), {
    create: report.summary.create,
    update: report.summary.update,
    unchanged: report.summary.unchanged,
    error: report.summary.error,
    rows: report.rowCount
  });

  fatalEl.replaceChildren();
  for (const fatal of report.fatalErrors) {
    const item = document.createElement("li");
    const where = [
      fatal.line === undefined
        ? ""
        : fillTemplate(text("lineTemplate"), { line: fatal.line }),
      fatal.column ?? ""
    ]
      .filter((part) => part.length > 0)
      .join(" · ");
    item.textContent = where ? `${where}: ${fatal.message}` : fatal.message;
    fatalEl.append(item);
  }
  fatalEl.hidden = report.fatalErrors.length === 0;

  tbody.replaceChildren();
  const actionLabel: Record<string, string> = {
    create: text("actionCreate"),
    update: text("actionUpdate"),
    unchanged: text("actionUnchanged"),
    error: text("actionError")
  };
  for (const row of report.rows) {
    const tr = document.createElement("tr");
    tr.dataset.action = row.action;
    tr.append(
      cell(String(row.row), text("columnRow")),
      cell(String(row.line), text("columnLine")),
      cell(row.sku ?? "—", text("columnSku"), "cell-code"),
      cell(actionLabel[row.action] ?? row.action, text("columnAction")),
      cell(
        row.errors
          .map((error) => `${error.column}: ${error.message}`)
          .join("\n"),
        text("columnDetails")
      )
    );
    tbody.append(tr);
  }
}

/** A fresh idempotency key for one apply attempt (reused if that attempt is retried). */
export function newIdempotencyKey(): string {
  return `catalog-import-${crypto.randomUUID()}`;
}
