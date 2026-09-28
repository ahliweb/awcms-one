/**
 * Bulk selection for the commerce product list (Issue #247) — a checkbox
 * column, a `.admin-bulk-bar` selection bar, and Publish/Move to
 * draft/Delete actions that each loop over the SAME per-item endpoints the
 * per-row controls already call (`PATCH`/`DELETE
 * /api/v1/commerce/products/{id}`). There is NO bulk API: every selected
 * product gets its own request, so every one keeps its own ABAC decision and
 * audit row exactly as if an operator had clicked it one at a time — see
 * `docs/adr/0123-…` in media-lenterakalteng (this repo's reference for the
 * pattern, LK ADR-0123 §5) and that repo's `blog.astro`/`wireBulk` for the
 * shape this file generalises from (concurrent + aggregate-count-only there;
 * this module runs SEQUENTIALLY and keeps each item's own SKU + reason,
 * since Issue #247 asks for "which SKUs failed and why", not just a count).
 *
 * ## Why this is its own module, not inline in `commerce.astro`'s `<script>`
 *
 * Same reasoning as `commerce-confirm-dialog-client.ts`: the parts that do
 * not touch the DOM (selection-state maths, result aggregation, the
 * idempotency key per item, the tiny placeholder filler below) are real
 * logic worth pinning with a unit test, and an inline `<script>` cannot be
 * imported by a test file. Only {@link initCommerceProductsBulk} — the
 * wiring — touches `document`/`window`.
 *
 * ## The `{n}` placeholder, not `{count}`
 *
 * The bar's live "N selected" text and the delete confirmation's message
 * change as the operator (un)checks a row, entirely client-side — no reload,
 * no server round-trip. But `t()`/`tn()` (`lib/i18n/catalog.ts`) only run at
 * RENDER time, server-side; there is no client-side translator. So
 * `commerce.astro` pre-renders, once, the TWO grammatical forms this
 * locale's plural rule can ever produce (`PLURAL_SELECTOR` in
 * `lib/i18n/locales.ts`: English distinguishes count===1 from everything
 * else; Indonesian's `nplurals=1` means both forms are the same string) by
 * calling `tn(msgidOne, msgidOther, 1)` and `tn(msgidOne, msgidOther, 2)` —
 * and this module fills the live count into whichever of those two strings
 * the CURRENT count selects, via {@link selectionCountText}.
 *
 * The trick that makes this possible: the msgid text uses `{n}`, never
 * `{count}`. `tn()`'s `interpolate()` (`catalog.ts`) unconditionally injects
 * `count` into its own substitution values — so a msgid written with
 * `{count}` would have it filled in at RENDER time regardless, baking in
 * whatever count was passed just to pick the grammatical form (1 or 2), not
 * the real live number. `{n}` is never one of `interpolate()`'s own
 * substitution keys, so it survives both server-side calls untouched — this
 * is documented, not accidental, behaviour of `interpolate()`: "A
 * placeholder with no matching value is left VERBATIM rather than replaced
 * with an empty string" (`catalog.ts`'s own header comment). This module is
 * the one place that relies on it.
 *
 * `i18n:catalog:check`'s placeholder-parity gate does not mind: it only
 * checks that a `.po` entry's `msgstr` declares the same placeholder names
 * as its own `msgid`/`msgid_plural` (`placeholderMismatches` in
 * `scripts/i18n-catalog-check.ts`), never that a call site supplies every
 * name it declares.
 *
 * ## No `Idempotency-Key` is actually READ by these two routes today
 *
 * `PATCH`/`DELETE /api/v1/commerce/products/{id}` do not wrap themselves in
 * `_shared/idempotency.ts` (unlike, e.g., the restore route or the
 * affiliate-commission transitions) — a repeat PATCH with the same body is
 * naturally idempotent, and a repeat DELETE 404s harmlessly the second time.
 * {@link bulkIdempotencyKey} is still generated and sent per item: it costs
 * nothing, it is what Issue #247 asks for ("its own Idempotency-Key"), it
 * gives every request in one bulk run a traceable, correlatable id (the
 * `runId` prefix ties a batch together in access logs without ever letting
 * two DIFFERENT items collide on one key), and it means this UI already
 * complies the day either route decides to start reading the header.
 */

/* -------------------------------------------------------------------- */
/* Pure helpers — no DOM, unit-tested directly.                         */
/* -------------------------------------------------------------------- */

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

/**
 * Minimal, client-safe re-implementation of `catalog.ts`'s own
 * `interpolate()` — deliberately NOT imported from there: that module closes
 * over the compiled server-side catalog and is not meant to ship to the
 * browser. Same contract: a `{name}` with no matching `values` entry is left
 * verbatim rather than blanked.
 */
export function fillPlaceholders(
  template: string,
  values: Readonly<Record<string, string | number>>
): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = values[name];
    return value === undefined ? whole : String(value);
  });
}

/** Mirrors `PLURAL_SELECTOR.en`/`.id` in `lib/i18n/locales.ts` — the only two locales this app has, and the only rule either one's plural forms follow: English's "one" is exactly `count === 1`, Indonesian has no separate "other" (both templates a page passes in are the SAME string for `id`, since `tn()` rendered them from the one form `PLURAL_SELECTOR.id` always picks). */
export function resolvePluralForm(count: number): "one" | "other" {
  return count === 1 ? "one" : "other";
}

/** The two grammatical forms `commerce.astro` pre-rendered via `tn(msgidOne, msgidOther, 1)` / `tn(msgidOne, msgidOther, 2)`, each still carrying its own unfilled `{n}`. */
export interface PluralTemplates {
  readonly one: string;
  readonly other: string;
}

/** Picks the right pre-rendered form for `count` and fills its `{n}`. What both the live bar count and the delete-confirmation message call. */
export function selectionCountText(
  templates: PluralTemplates,
  count: number
): string {
  return fillPlaceholders(templates[resolvePluralForm(count)], { n: count });
}

/** What the header checkbox should show for `selectedCount` selected out of `totalCount` rows on the page — the three-state contract a real tri-state checkbox needs (unchecked/checked/indeterminate), kept separate from the DOM so it is testable without one. */
export interface SelectAllState {
  readonly checked: boolean;
  readonly indeterminate: boolean;
}

export function computeSelectAllState(
  totalCount: number,
  selectedCount: number
): SelectAllState {
  if (totalCount <= 0 || selectedCount <= 0) {
    return { checked: false, indeterminate: false };
  }
  if (selectedCount >= totalCount) {
    return { checked: true, indeterminate: false };
  }
  return { checked: false, indeterminate: true };
}

/**
 * This bulk run's per-item `Idempotency-Key` — see this file's header for
 * why one is sent even though neither route currently reads it. `runId` is
 * minted ONCE per button click (`crypto.randomUUID()` at the DOM-dependent
 * call site, never here), so two different products in the same run never
 * collide while a genuine client retry of ONE item (not implemented today,
 * but the shape allows it) could reuse its own key.
 */
export function bulkIdempotencyKey(runId: string, productId: string): string {
  return `${runId}:${productId}`;
}

/** Reads `error.message` out of a parsed JSON response body — the field `admin-form-client.ts`'s `sendJson`/`sendJsonRequest` deliberately do NOT surface (Issue #540's narrow-shape rule for the 30-odd callers that only ever want a generic sentence). This screen's bulk actions are the documented exception: Issue #247 asks for "which SKUs failed and why", and `ApiErrorBody.error.message` (`_shared/api-response.ts`) is always a real sentence, never absent, on every `fail(...)` response. */
export function errorMessageOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.trim().length > 0
    ? message.trim()
    : null;
}

/** One selected row's identity, as the bulk actions below need it: the id to act on, and the SKU to name it by in a failure report (a UUID means nothing to the operator reading the error box). */
export interface BulkSelectedItem {
  readonly id: string;
  readonly sku: string;
}

/** One failed item, paired with why (already resolved via {@link errorMessageOf}, or `null` when the response carried none). */
export interface BulkFailure {
  readonly sku: string;
  readonly message: string | null;
}

export interface BulkActionOutcome {
  readonly succeededCount: number;
  readonly failures: readonly BulkFailure[];
}

/**
 * Runs `perform` once per item, SEQUENTIALLY (never `Promise.all` — Issue
 * #247 asks for "sequentially, or small bounded concurrency", and a strict
 * sequence is what lets {@link onProgress} report an honest, monotonic
 * "done of total" without any interleaving to reason about). Never throws:
 * `perform` is expected to catch its own network/parse failures the way
 * `sendJsonRequest` already does, and report them as `{ ok: false, message }`
 * rather than a rejection, so one item's failure never aborts the rest of
 * the run.
 */
export async function runBulkAction(
  items: readonly BulkSelectedItem[],
  perform: (
    item: BulkSelectedItem,
    index: number
  ) => Promise<{ ok: boolean; message: string | null }>,
  onProgress?: (done: number, total: number) => void
): Promise<BulkActionOutcome> {
  const failures: BulkFailure[] = [];
  let succeededCount = 0;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const result = await perform(item, index);

    if (result.ok) {
      succeededCount += 1;
    } else {
      failures.push({ sku: item.sku, message: result.message });
    }

    onProgress?.(index + 1, items.length);
  }

  return { succeededCount, failures };
}

/**
 * The error-box sentence for a run that did not fully succeed: the
 * translated, count-filled header (e.g. "2 of 5 selected products could not
 * be published.") followed by "SKU: reason" for each failure, `; `-joined.
 * Returns just the header when `failures` is empty (defensive — a caller
 * only reaches for this when `failures.length > 0`, but the function itself
 * does not require that).
 */
export function formatBulkFailureSummary(
  headerTemplate: string,
  counts: { readonly failedCount: number; readonly totalCount: number },
  failures: readonly BulkFailure[],
  fallbackReason: string
): string {
  const header = fillPlaceholders(headerTemplate, counts);
  if (failures.length === 0) return header;

  const details = failures
    .map((failure) => {
      const reason =
        failure.message && failure.message.trim().length > 0
          ? failure.message.trim()
          : fallbackReason;
      return `${failure.sku}: ${reason}`;
    })
    .join("; ");

  return `${header} ${details}`;
}

/* -------------------------------------------------------------------- */
/* DOM-dependent wiring — not unit-tested directly; exercised only via a  */
/* real browser (or the static-contract test's markup assertions).       */
/* -------------------------------------------------------------------- */

import { lockElement, messageBox, sendJsonRequest } from "./admin-form-client";
import { confirmCommerceAction } from "./commerce-confirm-dialog-client";

type BulkStatusAction = "publish" | "draft";

/** The one shape every element {@link initCommerceProductsBulk} looks up — reads them all up front so a screen missing one (a permission-gated absence, not a bug) is a single, obvious early return rather than N scattered null checks. */
interface BulkElements {
  table: HTMLTableElement;
  selectAll: HTMLInputElement;
  bar: HTMLElement;
  countEl: HTMLElement;
  publishButton: HTMLButtonElement | null;
  draftButton: HTMLButtonElement | null;
  deleteButton: HTMLButtonElement | null;
}

function queryBulkElements(): BulkElements | null {
  const table = document.getElementById("commerce-products-table");
  const selectAll = document.getElementById("commerce-products-select-all");
  const bar = document.getElementById("product-bulk-bar");
  const countEl = document.getElementById("product-bulk-bar-count");

  if (
    !(table instanceof HTMLTableElement) ||
    !(selectAll instanceof HTMLInputElement) ||
    !bar ||
    !countEl
  ) {
    return null;
  }

  const publishButton = document.getElementById("product-bulk-publish-btn");
  const draftButton = document.getElementById("product-bulk-draft-btn");
  const deleteButton = document.getElementById("product-bulk-delete-btn");

  return {
    table,
    selectAll,
    bar,
    countEl,
    publishButton:
      publishButton instanceof HTMLButtonElement ? publishButton : null,
    draftButton: draftButton instanceof HTMLButtonElement ? draftButton : null,
    deleteButton:
      deleteButton instanceof HTMLButtonElement ? deleteButton : null
  };
}

function rowCheckboxes(): HTMLInputElement[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>(".commerce-product-row-select")
  );
}

function selectedItems(): BulkSelectedItem[] {
  return rowCheckboxes()
    .filter((box) => box.checked)
    .map((box) => ({
      id: box.dataset.productId ?? "",
      sku: box.dataset.productSku ?? box.dataset.productId ?? ""
    }))
    .filter((item) => item.id.length > 0);
}

function pluralTemplatesOf(el: HTMLElement): PluralTemplates {
  return {
    one: el.dataset.countTemplateOne ?? "{n}",
    other: el.dataset.countTemplateOther ?? "{n}"
  };
}

/**
 * Entry point `commerce.astro`'s `<script>` calls once, after the page's
 * other admin-form wiring. Does nothing (silently) when the table or the
 * select-all checkbox is absent — both render only inside the
 * `(canUpdate || canDelete) && products.length > 0` branch, so "not
 * rendered" is the normal shape for a read-only viewer or an empty catalog,
 * not a bug to report.
 */
export function initCommerceProductsBulk(): void {
  const elements = queryBulkElements();
  if (!elements) return;

  const {
    table,
    selectAll,
    bar,
    countEl,
    publishButton,
    draftButton,
    deleteButton
  } = elements;

  const actionError = messageBox("product-action-error");
  const templates = pluralTemplatesOf(countEl);

  // Reveals the checkbox column and the bar — both are CSS-hidden by
  // default (`.bulk-select-col`/`[hidden]` in `commerce.astro`'s own
  // `<style>`) so a no-JS visitor keeps today's per-row-only UI.
  table.classList.add("bulk-select-ready");

  function refresh(): void {
    const boxes = rowCheckboxes();
    const selected = boxes.filter((box) => box.checked);
    const state = computeSelectAllState(boxes.length, selected.length);
    selectAll.checked = state.checked;
    selectAll.indeterminate = state.indeterminate;

    bar.hidden = selected.length === 0;
    countEl.textContent = selectionCountText(templates, selected.length);
  }

  table.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;

    if (target === selectAll) {
      for (const box of rowCheckboxes()) box.checked = target.checked;
    } else if (!target.classList.contains("commerce-product-row-select")) {
      return;
    }

    refresh();
  });

  async function performStatusChange(
    item: BulkSelectedItem,
    runId: string,
    status: "active" | "draft"
  ): Promise<{ ok: boolean; message: string | null }> {
    const result = await sendJsonRequest(
      "PATCH",
      `/api/v1/commerce/products/${item.id}`,
      { status },
      { "Idempotency-Key": bulkIdempotencyKey(runId, item.id) }
    );
    return {
      ok: result.ok,
      message: result.ok ? null : errorMessageOf(result.payload)
    };
  }

  async function performDelete(
    item: BulkSelectedItem,
    runId: string
  ): Promise<{ ok: boolean; message: string | null }> {
    const result = await sendJsonRequest(
      "DELETE",
      `/api/v1/commerce/products/${item.id}`,
      undefined,
      { "Idempotency-Key": bulkIdempotencyKey(runId, item.id) }
    );
    return {
      ok: result.ok,
      message: result.ok ? null : errorMessageOf(result.payload)
    };
  }

  async function runAndReport(
    button: HTMLButtonElement,
    items: BulkSelectedItem[],
    perform: (
      item: BulkSelectedItem,
      index: number
    ) => Promise<{ ok: boolean; message: string | null }>,
    failureHeaderTemplate: string
  ): Promise<void> {
    actionError.clear();
    const progressTemplate = bar.dataset.progressTemplate ?? "{done}/{total}";
    const fallbackReason = bar.dataset.genericFailureReason ?? "Unknown error.";
    const unlock = lockElement(
      button,
      fillPlaceholders(progressTemplate, { done: 0, total: items.length })
    );

    const outcome = await runBulkAction(items, perform, (done, total) => {
      button.textContent = fillPlaceholders(progressTemplate, {
        done,
        total
      });
    });

    if (outcome.failures.length === 0) {
      window.location.reload();
      return;
    }

    actionError.show(
      formatBulkFailureSummary(
        failureHeaderTemplate,
        { failedCount: outcome.failures.length, totalCount: items.length },
        outcome.failures,
        fallbackReason
      )
    );
    unlock();
  }

  function wireStatusButton(
    button: HTMLButtonElement | null,
    action: BulkStatusAction
  ): void {
    if (!button) return;
    const status = action === "publish" ? "active" : "draft";
    const failureHeaderTemplate =
      button.dataset.failureHeaderTemplate ?? "{failedCount}/{totalCount}";

    button.addEventListener("click", async () => {
      const items = selectedItems();
      if (items.length === 0) return;

      const runId = crypto.randomUUID();
      await runAndReport(
        button,
        items,
        (item) => performStatusChange(item, runId, status),
        failureHeaderTemplate
      );
    });
  }

  wireStatusButton(publishButton, "publish");
  wireStatusButton(draftButton, "draft");

  if (deleteButton) {
    const failureHeaderTemplate =
      deleteButton.dataset.failureHeaderTemplate ??
      "{failedCount}/{totalCount}";
    const confirmTemplates: PluralTemplates = {
      one: deleteButton.dataset.confirmMessageTemplateOne ?? "{n}",
      other: deleteButton.dataset.confirmMessageTemplateOther ?? "{n}"
    };

    deleteButton.addEventListener("click", async () => {
      const items = selectedItems();
      if (items.length === 0) return;

      const confirmed = await confirmCommerceAction({
        title: deleteButton.dataset.confirmTitle,
        message: selectionCountText(confirmTemplates, items.length),
        confirmLabel: deleteButton.dataset.confirmLabel,
        danger: true
      });
      if (!confirmed) return;

      const runId = crypto.randomUUID();
      await runAndReport(
        deleteButton,
        items,
        (item) => performDelete(item, runId),
        failureHeaderTemplate
      );
    });
  }

  refresh();
}
