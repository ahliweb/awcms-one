/**
 * `commerce-orders.astro` + `commerce-orders/[id].astro` (Issue #246, depends
 * on #242's `CommerceConfirmDialog` and #243's `commerce-admin-labels.ts`).
 *
 * Two kinds of coverage, deliberately kept apart — the same split
 * `commerce-confirm-dialog.test.ts` and `commerce-admin-labels.test.ts` each
 * use for their own modules:
 *
 *   1. `readConfirmOptionsWithNote` (the one new PURE helper this issue adds
 *      to `commerce-confirm-dialog-client.ts`, additively) — no DOM.
 *   2. Static, source-text assertions over both screens — the order-status
 *      save flow now goes through the note-confirm dialog rather than a bare
 *      PATCH, and every raw-enum render site this issue's own row of
 *      `raw-enum-table.md` lists is translated via `commerce-admin-labels.ts`
 *      while keeping the raw value in a `data-*` attribute.
 *
 * Every source-text check below runs against `stripComments`-cleaned text,
 * whitespace-normalized before any multi-line substring check — this file's
 * own prose says "window.confirm"/"{to}" more than once, and Astro/Prettier
 * are free to reflow the exact line breaks in the screens themselves, so a
 * check tied to one specific wrapping would be fragile without adding any
 * real coverage (see `commerce-confirm-dialog.test.ts`'s own header for the
 * same comment-stripping reasoning).
 *
 * Pure — no database, no network, no DOM.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { stripComments } from "../scripts/lib/source-text";
import {
  DEFAULT_NOTE_MAX_LENGTH,
  readConfirmOptionsWithNote,
  type ConfirmCommerceActionWithNoteOptions
} from "../src/lib/ui/commerce-confirm-dialog-client";
import {
  ORDER_STATUSES,
  LEGAL_ORDER_STATUS_TRANSITIONS
} from "../src/modules/commerce/domain/order-status";

const ORDERS_LIST_PATH = "src/pages/admin/commerce-orders.astro";
const ORDER_DETAIL_PATH = "src/pages/admin/commerce-orders/[id].astro";
const STATUS_ENDPOINT_PATH = "src/pages/api/v1/commerce/orders/[id]/status.ts";

async function readCode(path: string): Promise<string> {
  return stripComments(await readFile(path, "utf8"));
}

/** Collapses all whitespace runs to a single space — for a multi-line snippet whose exact line breaks are Prettier's concern, not this test's. */
function normalizeWhitespace(code: string): string {
  return code.replace(/\s+/g, " ").trim();
}

/**
 * The text between a screen's single `<script>`...`</script>` pair, found
 * with plain `indexOf`/`lastIndexOf` slicing rather than a `<tag>…</tag>`
 * regex — CodeQL's `js/bad-tag-filter` (security-extended,
 * severity 7.8) flags an HTML-tag-matching regex even in a test file, so
 * this repeats the fix `commerce-confirm-dialog.test.ts`'s own sibling check
 * needs, without a second hand-rolled parser.
 */
function extractScriptBody(code: string): string {
  const openTag = "<script>";
  const closeTag = "</script>";
  const start = code.indexOf(openTag);
  const end = code.lastIndexOf(closeTag);
  if (start === -1 || end === -1 || end <= start) return "";
  return code.slice(start + openTag.length, end);
}

describe("readConfirmOptionsWithNote", () => {
  test("maps the three note attributes alongside the base confirm-trigger fields", () => {
    const options = readConfirmOptionsWithNote({
      confirmTitle: "Change order status?",
      confirmMessage: "ORD-1 will move from Paid to Shipped.",
      confirmDanger: "true",
      confirmNoteLabel: "Note (optional)",
      confirmNoteMaxLength: "500",
      confirmNotePlaceholder: "Optional context"
    });

    expect(options).toEqual({
      title: "Change order status?",
      message: "ORD-1 will move from Paid to Shipped.",
      confirmLabel: undefined,
      danger: true,
      dialogId: undefined,
      noteLabel: "Note (optional)",
      noteMaxLength: 500,
      notePlaceholder: "Optional context"
    } satisfies ConfirmCommerceActionWithNoteOptions);
  });

  test("a missing confirmNoteLabel degrades to '' rather than throwing", () => {
    expect(readConfirmOptionsWithNote({}).noteLabel).toBe("");
  });

  test("a missing or non-numeric confirmNoteMaxLength degrades to undefined (the caller's own default applies)", () => {
    expect(readConfirmOptionsWithNote({}).noteMaxLength).toBeUndefined();
    expect(
      readConfirmOptionsWithNote({ confirmNoteMaxLength: "not-a-number" })
        .noteMaxLength
    ).toBeUndefined();
  });

  test("a real numeric confirmNoteMaxLength passes through as a number, not a string", () => {
    const options = readConfirmOptionsWithNote({
      confirmNoteMaxLength: "500"
    });
    expect(options.noteMaxLength).toBe(500);
    expect(typeof options.noteMaxLength).toBe("number");
  });

  test("a missing confirmNotePlaceholder passes through as undefined", () => {
    expect(readConfirmOptionsWithNote({}).notePlaceholder).toBeUndefined();
  });

  test("does not change readConfirmOptions' own existing behaviour — the base fields still read the same way", () => {
    const options = readConfirmOptionsWithNote({
      confirmMessage: "x",
      confirmDanger: "false"
    });
    expect(options.message).toBe("x");
    expect(options.danger).toBe(false);
  });
});

describe("the domain's own terminal-status set (what `danger` is keyed on)", () => {
  test("completed, cancelled, and expired have no outgoing edge — nothing else does", () => {
    const terminal: string[] = ORDER_STATUSES.filter(
      (status) => LEGAL_ORDER_STATUS_TRANSITIONS[status].length === 0
    );
    expect(terminal.slice().sort()).toEqual(
      ["cancelled", "completed", "expired"].sort()
    );
  });
});

describe("commerce-orders.astro", () => {
  test("renders CommerceConfirmDialog exactly once", async () => {
    const code = await readCode(ORDERS_LIST_PATH);
    expect(
      code.split(
        'import CommerceConfirmDialog from "../../components/CommerceConfirmDialog.astro";'
      ).length - 1
    ).toBe(1);
    expect(code.split("<CommerceConfirmDialog").length - 1).toBe(1);
  });

  test("has no window.confirm( call", async () => {
    const code = await readCode(ORDERS_LIST_PATH);
    expect(code).not.toContain("window.confirm(");
  });

  test("drives the status-save button through confirmCommerceActionWithNote + readConfirmOptionsWithNote, never a hand-built options literal", async () => {
    const code = await readCode(ORDERS_LIST_PATH);
    const normalized = normalizeWhitespace(code);

    expect(normalized).toContain(
      'import { confirmCommerceActionWithNote, readConfirmOptionsWithNote } from "../../lib/ui/commerce-confirm-dialog-client";'
    );
    expect(code).toContain("confirmCommerceActionWithNote(");
    expect(code).toContain("readConfirmOptionsWithNote(");

    // No hand-built `{ title: "...", message: "..." }` literal anywhere in
    // the script — same discipline `commerce-confirm-dialog.test.ts` enforces
    // for the ten #242 screens.
    const scriptBody = extractScriptBody(code);
    expect(scriptBody.length).toBeGreaterThan(0);
    expect(scriptBody).not.toMatch(/\btitle:\s*["'`]/);
    expect(scriptBody).not.toMatch(/\bmessage:\s*["'`][A-Za-z]/);
  });

  test("the status-save button carries data-confirm-title/-message/-note-label and a note max length of 500", async () => {
    const code = await readCode(ORDERS_LIST_PATH);
    const buttonTag = code.match(
      /<button[^>]*\border-status-save-btn\b[^>]*>/
    )?.[0];
    expect(buttonTag).toBeDefined();
    expect(buttonTag).toContain("data-confirm-title=");
    expect(buttonTag).toContain("data-confirm-message=");
    expect(buttonTag).toContain("data-confirm-note-label=");
    expect(buttonTag).toContain('data-confirm-note-max-length="500"');
    // No data-confirm-danger on the trigger itself — danger depends on the
    // TO status, which is only known client-side once the operator picks it.
    expect(buttonTag).not.toContain("data-confirm-danger=");
  });

  test("the note's 500-character ceiling matches the status endpoint's own truncation", async () => {
    const endpointCode = await readCode(STATUS_ENDPOINT_PATH);
    expect(endpointCode).toContain(".slice(0, 500)");
    expect(DEFAULT_NOTE_MAX_LENGTH).toBe(500);
  });

  test("the confirm message is composed server-side with a literal {to} placeholder, finished client-side from the server-rendered label map (never translated in the browser)", async () => {
    const code = await readCode(ORDERS_LIST_PATH);
    expect(code).toContain("{orderCode} will move from {from} to {to}.");
    expect(code).toContain('options.message.replace("{to}", toLabel)');
    // The lookup table travels as JSON, not as a second t()-translated pass
    // in the browser.
    expect(code).toContain("data-order-status-meta={JSON.stringify(");
    expect(code).toContain("orderStatusMeta.labels[toStatus]");
  });

  test("danger is computed client-side from the domain's own terminal-status set, never hand-listed in the script", async () => {
    const code = await readCode(ORDERS_LIST_PATH);
    const normalized = normalizeWhitespace(code);
    expect(code).toContain("orderStatusMeta.terminal.includes(toStatus)");
    // The terminal set itself is derived in the frontmatter from
    // LEGAL_ORDER_STATUS_TRANSITIONS, not a second hardcoded literal array.
    expect(normalized).toContain(
      "ORDER_STATUSES.filter( (status) => LEGAL_ORDER_STATUS_TRANSITIONS[status].length === 0 )"
    );
  });

  test("cancelling leaves the select untouched and sends nothing", async () => {
    const code = await readCode(ORDERS_LIST_PATH);
    expect(code).toContain("if (!result) return;");
    // Never a second write to `select.value` after a cancelled confirm.
    const afterCancel = code.split("if (!result) return;")[1] ?? "";
    const beforeNextHandler =
      afterCancel.split("await mutateAndReload")[0] ?? "";
    expect(beforeNextHandler).not.toContain("select.value =");
  });

  test("the note is sent in the existing `note` field only when non-empty", async () => {
    const code = await readCode(ORDERS_LIST_PATH);
    expect(code).toContain("...(result.note ? { note: result.note } : {})");
  });

  test("uses the shared orderStatusTone/commerceLabel instead of a local STATUS_TONE map", async () => {
    const code = await readCode(ORDERS_LIST_PATH);
    const normalized = normalizeWhitespace(code);
    expect(code).not.toContain("STATUS_TONE");
    expect(normalized).toContain(
      'import { createCommerceLabels, commerceLabel, orderStatusTone } from "../../lib/ui/commerce-admin-labels";'
    );
  });

  test("every raw-enum render site named for this screen in raw-enum-table.md is translated, with the raw value kept in a data-* attribute", async () => {
    const code = await readCode(ORDERS_LIST_PATH);
    const normalized = normalizeWhitespace(code);

    // Status filter tabs.
    expect(code).toContain("commerceLabel(labels.orderStatus, status)} (");
    expect(code).toContain("data-status={status}");

    // Status badge.
    expect(code).toContain("commerceLabel(labels.orderStatus, order.status)");
    expect(code).toContain("data-status={order.status}");
    expect(code).toContain('orderStatusTone[order.status] ?? "neutral"');

    // Status <option> text (value stays the raw enum — the form control's
    // own canonical raw-value holder).
    expect(normalized).toContain(
      "<option value={status} selected={order.status === status} > {commerceLabel(labels.orderStatus, status)}"
    );

    // Payment status cell.
    expect(code).toContain("data-payment-status={order.paymentStatus}");
    expect(normalized).toContain(
      "commerceLabel( labels.paymentStatus, order.paymentStatus )"
    );

    // Gateway panel — session provider/status, event provider/outcome — all
    // JS-rendered, all fed a translated map from a data attribute, raw value
    // kept via setAttribute.
    expect(code).toContain("data-gateway-labels={JSON.stringify(");
    expect(code).toContain(
      'provider.setAttribute("data-raw-value", session.provider)'
    );
    expect(code).toContain(
      'status.setAttribute("data-raw-value", session.status)'
    );
    expect(code).toContain(
      'item.setAttribute("data-raw-provider", event.provider)'
    );
    expect(code).toContain(
      'item.setAttribute("data-raw-outcome", event.outcome)'
    );
    expect(code).toContain("gatewayLabels.provider[session.provider]");
    expect(code).toContain("gatewayLabels.status[session.status]");
    expect(code).toContain("gatewayLabels.provider[event.provider]");
    expect(code).toContain("gatewayLabels.outcome[event.outcome]");
  });
});

describe("commerce-orders/[id].astro", () => {
  test("has no window.confirm( call and does not render CommerceConfirmDialog (no status control on this page)", async () => {
    const code = await readCode(ORDER_DETAIL_PATH);
    expect(code).not.toContain("window.confirm(");
    expect(code).not.toContain("CommerceConfirmDialog");
  });

  test("uses the shared orderStatusTone/commerceLabel instead of a local STATUS_TONE map", async () => {
    const code = await readCode(ORDER_DETAIL_PATH);
    expect(code).not.toContain("STATUS_TONE");
    expect(code).toContain('orderStatusTone[order.status] ?? "neutral"');
  });

  test("translates status pill, channel pill, and timeline entry status, keeping the raw value in data-*", async () => {
    const code = await readCode(ORDER_DETAIL_PATH);

    // Status pill.
    expect(code).toContain("data-status={order.status}");
    expect(code).toContain("commerceLabel(labels.orderStatus, order.status)");

    // Channel pill.
    expect(code).toContain("data-channel={order.channel}");
    expect(code).toContain("commerceLabel(labels.orderChannel, order.channel)");

    // Timeline entry status.
    expect(code).toContain("data-status={entry.status}");
    expect(code).toContain("commerceLabel(labels.orderStatus, entry.status)");
  });

  test("still renders the timeline entry's note unchanged", async () => {
    const code = await readCode(ORDER_DETAIL_PATH);
    expect(code).toContain("{entry.note && <> &mdash; {entry.note}</>}");
  });

  test("passes the gateway panel's translated maps via data-gateway-labels, same shape as commerce-orders.astro", async () => {
    const code = await readCode(ORDER_DETAIL_PATH);
    expect(code).toContain(
      "data-gateway-labels={JSON.stringify(gatewayLabels)}"
    );
    expect(code).toContain(
      'provider.setAttribute("data-raw-value", session.provider)'
    );
    expect(code).toContain(
      'status.setAttribute("data-raw-value", session.status)'
    );
    expect(code).toContain(
      'item.setAttribute("data-raw-provider", event.provider)'
    );
    expect(code).toContain(
      'item.setAttribute("data-raw-outcome", event.outcome)'
    );
  });

  test("has no status-change control on this page (the list owns the only Save button)", async () => {
    const code = await readCode(ORDER_DETAIL_PATH);
    expect(code).not.toContain("order-status-save-btn");
    expect(code).not.toContain("order-status-input");
  });
});
