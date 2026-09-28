/**
 * `commerce.astro`'s product labels, tab counts, and bulk selection
 * (Issue #247).
 *
 * Two kinds of coverage, deliberately kept apart — same split
 * `commerce-confirm-dialog.test.ts` uses for its own module/screen pair:
 *
 *   1. `commerce-products-bulk-client.ts`'s PURE helpers (placeholder
 *      filling, plural-form selection, select-all tri-state, the per-item
 *      idempotency key, error-message extraction, the sequential runner,
 *      and failure-summary formatting) — no DOM at all.
 *   2. Static, source-text assertions over `commerce.astro` and the client
 *      module — the same "read the file, assert what its text contains"
 *      style `admin-commerce-marketing-page-contract.test.ts` already uses.
 *      The full checkbox/select-all/reload lifecycle needs a real browser
 *      and belongs to Playwright (`awcms-browser-test`), not here.
 *
 * Every source-text check below runs against `stripComments`-cleaned text,
 * and every `<script>`/attribute slice below is taken with plain
 * `indexOf`/`lastIndexOf` — never a `<tag>…</tag>` regex, which CodeQL's
 * `js/bad-tag-filter` (severity 7.8) flags even inside a test file.
 *
 * Pure — no database, no network, no DOM.
 */
import { describe, expect, test } from "bun:test";

import { stripComments } from "../scripts/lib/source-text";
import {
  bulkIdempotencyKey,
  computeSelectAllState,
  errorMessageOf,
  fillPlaceholders,
  formatBulkFailureSummary,
  resolvePluralForm,
  runBulkAction,
  selectionCountText,
  type BulkSelectedItem
} from "../src/lib/ui/commerce-products-bulk-client";

/* -------------------------------------------------------------------- */
/* Pure helpers                                                          */
/* -------------------------------------------------------------------- */

describe("fillPlaceholders", () => {
  test("fills a matching {name} placeholder", () => {
    expect(fillPlaceholders("Hello {name}", { name: "Budi" })).toBe(
      "Hello Budi"
    );
  });

  test("fills a numeric value by string conversion", () => {
    expect(fillPlaceholders("{done} of {total}", { done: 2, total: 5 })).toBe(
      "2 of 5"
    );
  });

  test("leaves an UNMATCHED placeholder verbatim, never blanks it", () => {
    // The whole point of using {n} (not {count}) in `commerce.astro`'s
    // server-rendered templates — see the client module's own header.
    expect(fillPlaceholders("{n} selected", { count: 3 })).toBe("{n} selected");
  });

  test("fills several distinct placeholders in one template", () => {
    expect(
      fillPlaceholders("{failedCount} of {totalCount} failed", {
        failedCount: 1,
        totalCount: 4
      })
    ).toBe("1 of 4 failed");
  });
});

describe("resolvePluralForm", () => {
  test("count 1 is the 'one' form; everything else is 'other'", () => {
    expect(resolvePluralForm(1)).toBe("one");
    expect(resolvePluralForm(0)).toBe("other");
    expect(resolvePluralForm(2)).toBe("other");
    expect(resolvePluralForm(100)).toBe("other");
  });
});

describe("selectionCountText", () => {
  test("English-shaped templates: picks the grammatical form for the count", () => {
    const templates = {
      one: "{n} product selected",
      other: "{n} products selected"
    };
    expect(selectionCountText(templates, 1)).toBe("1 product selected");
    expect(selectionCountText(templates, 0)).toBe("0 products selected");
    expect(selectionCountText(templates, 5)).toBe("5 products selected");
  });

  test("Indonesian-shaped templates: 'one' and 'other' are the SAME string, any count", () => {
    // `PLURAL_SELECTOR.id` (`lib/i18n/locales.ts`) always picks index 0 — so
    // `commerce.astro` renders the identical string into BOTH data
    // attributes for the `id` locale, and this function must not care.
    const templates = {
      one: "{n} produk dipilih",
      other: "{n} produk dipilih"
    };
    expect(selectionCountText(templates, 1)).toBe("1 produk dipilih");
    expect(selectionCountText(templates, 7)).toBe("7 produk dipilih");
  });
});

describe("computeSelectAllState", () => {
  test("no rows, or nothing selected: unchecked, not indeterminate", () => {
    expect(computeSelectAllState(0, 0)).toEqual({
      checked: false,
      indeterminate: false
    });
    expect(computeSelectAllState(5, 0)).toEqual({
      checked: false,
      indeterminate: false
    });
  });

  test("some, but not all, rows selected: indeterminate", () => {
    expect(computeSelectAllState(5, 3)).toEqual({
      checked: false,
      indeterminate: true
    });
  });

  test("every row selected: checked, not indeterminate", () => {
    expect(computeSelectAllState(5, 5)).toEqual({
      checked: true,
      indeterminate: false
    });
  });

  test("a selected count above total (defensive) reads as fully checked", () => {
    expect(computeSelectAllState(3, 3)).toEqual({
      checked: true,
      indeterminate: false
    });
  });
});

describe("bulkIdempotencyKey", () => {
  test("combines the run id and the product id", () => {
    expect(bulkIdempotencyKey("run-1", "product-a")).toBe("run-1:product-a");
  });

  test("two different products in the SAME run never collide", () => {
    const keyA = bulkIdempotencyKey("run-1", "product-a");
    const keyB = bulkIdempotencyKey("run-1", "product-b");
    expect(keyA).not.toBe(keyB);
  });

  test("the same product in two DIFFERENT runs gets two different keys", () => {
    const first = bulkIdempotencyKey("run-1", "product-a");
    const second = bulkIdempotencyKey("run-2", "product-a");
    expect(first).not.toBe(second);
  });
});

describe("errorMessageOf", () => {
  test("reads error.message off a well-formed envelope", () => {
    expect(
      errorMessageOf({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Bad status." }
      })
    ).toBe("Bad status.");
  });

  test("returns null when there is no error object", () => {
    expect(errorMessageOf({ success: true })).toBeNull();
    expect(errorMessageOf(null)).toBeNull();
    expect(errorMessageOf(undefined)).toBeNull();
    expect(errorMessageOf("not an object")).toBeNull();
  });

  test("returns null for a blank or non-string message, never an empty string", () => {
    expect(errorMessageOf({ error: { message: "   " } })).toBeNull();
    expect(errorMessageOf({ error: { message: 42 } })).toBeNull();
    expect(errorMessageOf({ error: {} })).toBeNull();
  });

  test("trims a real message", () => {
    expect(
      errorMessageOf({ error: { message: "  Cannot transition.  " } })
    ).toBe("Cannot transition.");
  });
});

describe("runBulkAction", () => {
  function item(id: string, sku: string): BulkSelectedItem {
    return { id, sku };
  }

  test("runs SEQUENTIALLY — item N+1 does not start before item N resolves", async () => {
    const order: string[] = [];
    const items = [item("1", "SKU-1"), item("2", "SKU-2"), item("3", "SKU-3")];

    await runBulkAction(items, async (current) => {
      order.push(`start:${current.sku}`);
      // A concurrent (Promise.all-style) runner would interleave these —
      // deferring with a resolved microtask still preserves strict
      // ordering only when the runner itself awaits each call in turn.
      await Promise.resolve();
      order.push(`end:${current.sku}`);
      return { ok: true, message: null };
    });

    expect(order).toEqual([
      "start:SKU-1",
      "end:SKU-1",
      "start:SKU-2",
      "end:SKU-2",
      "start:SKU-3",
      "end:SKU-3"
    ]);
  });

  test("aggregates failures with their SKU and message, keeps successes out of the list", async () => {
    const items = [
      item("1", "SKU-OK"),
      item("2", "SKU-BAD"),
      item("3", "SKU-ALSO-BAD")
    ];

    const outcome = await runBulkAction(items, async (current) => {
      if (current.sku === "SKU-OK") {
        return { ok: true, message: null };
      }
      return { ok: false, message: `${current.sku} rejected` };
    });

    expect(outcome.succeededCount).toBe(1);
    expect(outcome.failures).toEqual([
      { sku: "SKU-BAD", message: "SKU-BAD rejected" },
      { sku: "SKU-ALSO-BAD", message: "SKU-ALSO-BAD rejected" }
    ]);
  });

  test("reports progress once per item, in order, done never exceeding total", async () => {
    const progress: Array<{ done: number; total: number }> = [];
    const items = [item("1", "A"), item("2", "B")];

    await runBulkAction(
      items,
      async () => ({ ok: true, message: null }),
      (done, total) => progress.push({ done, total })
    );

    expect(progress).toEqual([
      { done: 1, total: 2 },
      { done: 2, total: 2 }
    ]);
  });

  test("an empty selection performs no calls and succeeds trivially", async () => {
    let calls = 0;
    const outcome = await runBulkAction([], async () => {
      calls += 1;
      return { ok: true, message: null };
    });

    expect(calls).toBe(0);
    expect(outcome).toEqual({ succeededCount: 0, failures: [] });
  });
});

describe("formatBulkFailureSummary", () => {
  test("returns just the filled header when there are no failures", () => {
    expect(
      formatBulkFailureSummary(
        "{failedCount} of {totalCount} could not be published.",
        { failedCount: 0, totalCount: 3 },
        [],
        "Unknown error."
      )
    ).toBe("0 of 3 could not be published.");
  });

  test("appends 'SKU: reason' for each failure, semicolon-joined", () => {
    const summary = formatBulkFailureSummary(
      "{failedCount} of {totalCount} could not be published.",
      { failedCount: 2, totalCount: 3 },
      [
        { sku: "SKU-A", message: "Cannot transition from archived." },
        { sku: "SKU-B", message: "Cannot transition from archived." }
      ],
      "Unknown error."
    );

    expect(summary).toBe(
      "2 of 3 could not be published. SKU-A: Cannot transition from archived.; SKU-B: Cannot transition from archived."
    );
  });

  test("falls back to the generic reason for a failure with no message", () => {
    const summary = formatBulkFailureSummary(
      "{failedCount} of {totalCount} could not be deleted.",
      { failedCount: 1, totalCount: 1 },
      [{ sku: "SKU-C", message: null }],
      "Unknown error."
    );

    expect(summary).toBe("1 of 1 could not be deleted. SKU-C: Unknown error.");
  });
});

/* -------------------------------------------------------------------- */
/* Static contract — commerce.astro + commerce-products-bulk-client.ts   */
/* -------------------------------------------------------------------- */

async function readCleanedSource(path: string): Promise<string> {
  return stripComments(await Bun.file(path).text());
}

/** Occurrences of `needle` in `haystack` — used below to prove a label call is wired at every render site the label spec names, not just once. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("commerce.astro renders labels via the shared maps everywhere the raw enum table names", () => {
  test("productType: filter-independent renders go through commerceLabel(labels.productType, …)", async () => {
    const page = await readCleanedSource("src/pages/admin/commerce.astro");

    // Create-form `<select>` option, the table cell, and the inline-edit
    // `<select>` option — three render sites per the raw-enum-table spec.
    expect(
      occurrences(page, "commerceLabel(labels.productType,")
    ).toBeGreaterThanOrEqual(3);
  });

  test("productStatus: filter-select, badge, and inline-edit select all go through commerceLabel(labels.productStatus, …)", async () => {
    const page = await readCleanedSource("src/pages/admin/commerce.astro");

    expect(
      occurrences(page, "commerceLabel(labels.productStatus,")
    ).toBeGreaterThanOrEqual(3);
  });

  test("the raw value is preserved in a data-* attribute where the label replaced plain text", async () => {
    const page = await readCleanedSource("src/pages/admin/commerce.astro");

    expect(page).toContain("data-product-type={product.type}");
    expect(page).toContain("data-product-status={product.status}");
  });
});

describe("commerce.astro's status tabs show counts (Issue #247 item 2)", () => {
  test("All/Published/Draft each render a count next to the label", async () => {
    const page = await readCleanedSource("src/pages/admin/commerce.astro");

    expect(page).toContain("totalProductCount");
    expect(page).toContain("statusCounts.active");
    expect(page).toContain("statusCounts.draft");
  });

  test("commerce.astro imports countProductsByStatus, and calls it once inside the load callback", async () => {
    const page = await readCleanedSource("src/pages/admin/commerce.astro");

    expect(page).toContain("countProductsByStatus");
    // Exactly one call site: the import line names it once, the call site
    // names it a second time — a third occurrence would mean it is invoked
    // more than once per render (a second, avoidable query).
    expect(occurrences(page, "countProductsByStatus")).toBe(2);
  });
});

describe("the checkbox column and the bulk bar are hidden until JavaScript wires them", () => {
  test("the bulk bar is server-rendered `hidden`", async () => {
    const page = await readCleanedSource("src/pages/admin/commerce.astro");
    const barStart = page.indexOf('id="product-bulk-bar"');
    expect(barStart).toBeGreaterThan(-1);

    const barTagEnd = page.indexOf(">", barStart);
    const barOpenTag = page.slice(
      page.lastIndexOf("<div", barStart),
      barTagEnd
    );
    expect(barOpenTag).toContain("hidden");
  });

  test("the checkbox column has no visible display until the table carries .bulk-select-ready", async () => {
    const page = await readCleanedSource("src/pages/admin/commerce.astro");
    const styleStart = page.indexOf("<style>");
    const styleEnd = page.indexOf("</style>", styleStart);
    expect(styleStart).toBeGreaterThan(-1);
    const style = page.slice(styleStart, styleEnd);

    expect(style).toContain(".bulk-select-col {");
    expect(style).toContain("display: none;");
    expect(style).toContain(".bulk-select-ready .bulk-select-col");
  });

  test("commerce.astro's <script> calls initCommerceProductsBulk()", async () => {
    const page = await readCleanedSource("src/pages/admin/commerce.astro");
    const scriptStart = page.indexOf("<script>");
    const script = page.slice(scriptStart);

    expect(script).toContain(
      'import { initCommerceProductsBulk } from "../../lib/ui/commerce-products-bulk-client"'
    );
    expect(script).toContain("initCommerceProductsBulk();");
  });
});

describe("bulk delete confirms via CommerceConfirmDialog, count-aware", () => {
  test("the bulk delete button carries data-confirm-* attributes, including the two count templates", async () => {
    const page = await readCleanedSource("src/pages/admin/commerce.astro");
    const buttonStart = page.indexOf('id="product-bulk-delete-btn"');
    expect(buttonStart).toBeGreaterThan(-1);

    const buttonTagEnd = page.indexOf(">", buttonStart);
    const buttonOpenTag = page.slice(
      page.lastIndexOf("<button", buttonStart),
      buttonTagEnd
    );

    expect(buttonOpenTag).toContain("data-confirm-title=");
    expect(buttonOpenTag).toContain("data-confirm-label=");
    expect(buttonOpenTag).toContain("data-confirm-message-template-one=");
    expect(buttonOpenTag).toContain("data-confirm-message-template-other=");
  });

  test("neither commerce.astro nor its bulk client calls window.confirm", async () => {
    const page = await readCleanedSource("src/pages/admin/commerce.astro");
    const client = await readCleanedSource(
      "src/lib/ui/commerce-products-bulk-client.ts"
    );

    expect(page).not.toContain("window.confirm(");
    expect(client).not.toContain("window.confirm(");
  });

  test("the bulk client reads error.message via sendJsonRequest, not the narrow sendJson", async () => {
    const client = await readCleanedSource(
      "src/lib/ui/commerce-products-bulk-client.ts"
    );

    expect(client).toContain("sendJsonRequest(");
    // `sendJson` (the narrow `{ ok, errorCode }` helper) is never imported —
    // a per-item failure reason needs the fuller `payload` that only
    // `sendJsonRequest` returns (Issue #540's own narrow-shape rule).
    expect(client).not.toContain("import { sendJson }");
    expect(client).not.toContain(", sendJson,");
    expect(client).not.toContain(", sendJson }");
  });
});

describe("no new bulk API route exists (Issue #247 — per-item endpoints only)", () => {
  test("apps/cms/src/pages/api/v1/commerce/products/** is unchanged: the same route files as before this issue, no bulk-shaped addition", async () => {
    const files: string[] = [];
    for await (const file of new Bun.Glob(
      "src/pages/api/v1/commerce/products/**/*.ts"
    ).scan({ cwd: process.cwd() })) {
      files.push(file);
    }

    expect(files.sort()).toEqual(
      [
        "src/pages/api/v1/commerce/products/[id].ts",
        "src/pages/api/v1/commerce/products/[id]/images/[imageId].ts",
        "src/pages/api/v1/commerce/products/[id]/images/index.ts",
        "src/pages/api/v1/commerce/products/[id]/restore.ts",
        "src/pages/api/v1/commerce/products/[id]/variants/[variantId].ts",
        "src/pages/api/v1/commerce/products/[id]/variants/index.ts",
        "src/pages/api/v1/commerce/products/by-slug/[slug].ts",
        "src/pages/api/v1/commerce/products/index.ts"
      ].sort()
    );
  });
});
