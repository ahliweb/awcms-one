/**
 * Issue #245 — adoption of the shared `src/lib/ui/commerce-admin-labels.ts`
 * module (Issue #243) across the twelve commerce admin screens that still
 * rendered a raw enum value as visible text: inbox, dashboard, affiliates,
 * reports, WhatsApp, POS, reviews, campaigns, vouchers, flash sales,
 * customers, popup. `commerce-orders*.astro` (#246), `commerce.astro` (#247)
 * and `commerce-settings.astro`'s webhook-provider cell are explicitly out
 * of scope here.
 *
 * Pure — reads source files only, no database, no network. Each test pins
 * the shape the fix introduced: every listed render site goes through
 * `commerceLabel(labels.<map>, <raw value>)` and keeps the raw value
 * machine-readable in a `data-*` attribute on the same element, so a
 * regression that reintroduces a bare enum interpolation — or drops the
 * `data-*` attribute a client script or a future screen might depend on —
 * is caught here. Where a screen carried its own `STATUS_TONE`/
 * `FRESHNESS_VARIANT` map that duplicated a tone map the shared module now
 * exports, this also pins that the local map is gone and the shared tone map
 * (or, for `commerce-reports.astro`'s export-run status, the
 * `reportRunStatusTone`/`reportRunStatus` pair — a deliberate reuse across
 * the narrower `ExportRunStatus` subset, see that screen's own diff) is used
 * in its place.
 *
 * Assertions compare against a WHITESPACE-NORMALIZED copy of the source
 * (`hasNormalized`) rather than an exact multi-line string: Prettier is free
 * to re-wrap a JSX attribute list across lines however `printWidth` dictates,
 * and this test should pin token order/presence, not a specific line break.
 *
 * Deliberately NOT touched by this issue's screens (checked, left alone):
 * - `commerce-campaigns.astro`'s create-form channel `<select>` — its own
 *   literal option text ("E-mail") is not the same msgid as
 *   `campaignChannel.email` ("Email"), so switching it to the shared map
 *   would change what a merchant reads; out of scope per the issue's own
 *   "already-correct selects" list.
 * - `commerce-customers.astro`'s status `<select>` and
 *   `commerce-flash-sales.astro`'s two-of-four-value status `<select>`s —
 *   not named in the issue's "should switch" list, and (for flash sales) a
 *   full map iteration would wrongly offer the tick-job-only
 *   `active`/`ended` options to a human editor.
 * - Any confirm-dialog script code on affiliates/campaigns/reviews/vouchers/
 *   flash-sales/popup — that is #242's (PR #252), pinned by its own
 *   `commerce-confirm-dialog.test.ts`, not here.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

// Strips ALL whitespace, not merely collapsing runs to one space: Prettier's
// re-wrap can turn `commerceLabel(x, y)` into `commerceLabel(\n  x,\n  y\n)`,
// which a collapse-to-one-space normalization would render as
// `commerceLabel( x, y )` — a space after `(` and before `)` that never
// appears in a one-line snippet written by hand. Removing whitespace
// entirely sidesteps that mismatch; every separator in the snippets below is
// punctuation (`(`, `,`, `)`, `.`, `{`, `}`, `"`, …), never two identifiers
// that whitespace alone keeps apart, so this cannot merge unrelated tokens.
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, "");
}

/** True when `snippet`'s tokens appear in `source`, in order, regardless of how Prettier wrapped the whitespace between them. */
function hasNormalized(source: string, snippet: string): boolean {
  return normalizeWhitespace(source).includes(normalizeWhitespace(snippet));
}

const INBOX_PAGE = "src/pages/admin/commerce-inbox.astro";
const DASHBOARD_PAGE = "src/pages/admin/commerce-dashboard.astro";
const AFFILIATES_PAGE = "src/pages/admin/commerce-affiliates.astro";
const REPORTS_PAGE = "src/pages/admin/commerce-reports.astro";
const WHATSAPP_PAGE = "src/pages/admin/commerce-whatsapp.astro";
const POS_PAGE = "src/pages/admin/commerce-pos.astro";
const REVIEWS_PAGE = "src/pages/admin/commerce-reviews.astro";
const CAMPAIGNS_PAGE = "src/pages/admin/commerce-campaigns.astro";
const VOUCHERS_PAGE = "src/pages/admin/commerce-vouchers.astro";
const FLASH_SALES_PAGE = "src/pages/admin/commerce-flash-sales.astro";
const CUSTOMERS_PAGE = "src/pages/admin/commerce-customers.astro";
const POPUP_PAGE = "src/pages/admin/commerce-popup.astro";

const ALL_TWELVE = [
  INBOX_PAGE,
  DASHBOARD_PAGE,
  AFFILIATES_PAGE,
  REPORTS_PAGE,
  WHATSAPP_PAGE,
  POS_PAGE,
  REVIEWS_PAGE,
  CAMPAIGNS_PAGE,
  VOUCHERS_PAGE,
  FLASH_SALES_PAGE,
  CUSTOMERS_PAGE,
  POPUP_PAGE
];

describe("every one of the twelve screens imports and calls createCommerceLabels", () => {
  for (const page of ALL_TWELVE) {
    test(`${page} imports createCommerceLabels/commerceLabel and builds labels from its own t`, async () => {
      const source = await readFile(page, "utf8");

      expect(source).toContain("createCommerceLabels");
      expect(source).toContain("commerceLabel");
      expect(source).toContain('from "../../lib/ui/commerce-admin-labels"');
      expect(
        hasNormalized(source, "const labels = createCommerceLabels(t);")
      ).toBe(true);
    });
  }
});

describe("commerce-inbox.astro — conversation status in the list and the thread header", () => {
  test("the list badge renders through conversationStatus and carries data-status", async () => {
    const source = await readFile(INBOX_PAGE, "utf8");

    expect(source).not.toContain(
      '<span class="status-badge">{conversation.status}</span>'
    );
    expect(source).toContain("data-status={conversation.status}");
    expect(
      hasNormalized(
        source,
        "commerceLabel(labels.conversationStatus, conversation.status)"
      )
    ).toBe(true);
  });

  test("the thread header badge renders through conversationStatus and carries data-status", async () => {
    const source = await readFile(INBOX_PAGE, "utf8");

    expect(source).not.toContain(
      '<span class="status-badge">{thread.conversation.status}</span>'
    );
    expect(source).toContain("data-status={thread.conversation.status}");
    expect(
      hasNormalized(
        source,
        "commerceLabel(labels.conversationStatus, thread.conversation.status)"
      )
    ).toBe(true);
  });
});

describe("commerce-dashboard.astro — recent-orders status pill reuses the shared tone map", () => {
  test("the local STATUS_TONE map is gone", async () => {
    const source = await readFile(DASHBOARD_PAGE, "utf8");
    expect(source).not.toContain("const STATUS_TONE");
  });

  test("the pill uses orderStatusTone, commerceLabel(labels.orderStatus, …) and data-status", async () => {
    const source = await readFile(DASHBOARD_PAGE, "utf8");

    expect(source).toContain("orderStatusTone");
    expect(
      hasNormalized(
        source,
        'data-tone={orderStatusTone[order.status] ?? "neutral"}'
      )
    ).toBe(true);
    expect(source).toContain("data-status={order.status}");
    expect(
      hasNormalized(source, "commerceLabel(labels.orderStatus, order.status)")
    ).toBe(true);
    expect(hasNormalized(source, "{order.status} </span>")).toBe(false);
  });
});

describe("commerce-affiliates.astro — affiliate/commission status pills reuse the shared tone maps, and the commission filter reuses the shared map", () => {
  test("the local STATUS_TONE map is gone", async () => {
    const source = await readFile(AFFILIATES_PAGE, "utf8");
    expect(source).not.toContain("const STATUS_TONE");
  });

  test("the affiliate pill uses affiliateStatusTone/commerceLabel(labels.affiliateStatus, …) and data-status", async () => {
    const source = await readFile(AFFILIATES_PAGE, "utf8");

    expect(source).toContain("affiliateStatusTone");
    expect(
      hasNormalized(
        source,
        'data-tone={affiliateStatusTone[affiliate.status] ?? "neutral"}'
      )
    ).toBe(true);
    expect(source).toContain("data-status={affiliate.status}");
    expect(
      hasNormalized(
        source,
        "commerceLabel(labels.affiliateStatus, affiliate.status)"
      )
    ).toBe(true);
  });

  test("the commission pill uses commissionStatusTone/commerceLabel(labels.commissionStatus, …) and data-status", async () => {
    const source = await readFile(AFFILIATES_PAGE, "utf8");

    expect(source).toContain("commissionStatusTone");
    expect(
      hasNormalized(
        source,
        'data-tone={commissionStatusTone[commission.status] ?? "neutral"}'
      )
    ).toBe(true);
    expect(source).toContain("data-status={commission.status}");
    expect(
      hasNormalized(
        source,
        "commerceLabel(labels.commissionStatus, commission.status)"
      )
    ).toBe(true);
  });

  test("the commission-status filter <select> iterates labels.commissionStatus instead of four hand-written <option>s", async () => {
    const source = await readFile(AFFILIATES_PAGE, "utf8");

    expect(source).not.toContain('selected={statusFilter === "pending"}');
    expect(source).toContain("Object.entries(labels.commissionStatus).map(");
  });
});

describe("commerce-reports.astro — projection-freshness and export-run status reuse the shared tone maps", () => {
  test("the local FRESHNESS_VARIANT map is gone", async () => {
    const source = await readFile(REPORTS_PAGE, "utf8");
    expect(source).not.toContain("const FRESHNESS_VARIANT");
  });

  test("projection freshness uses reportFreshnessTone/commerceLabel(labels.reportFreshnessStatus, …) and data-status", async () => {
    const source = await readFile(REPORTS_PAGE, "utf8");

    expect(source).toContain("reportFreshnessTone");
    expect(
      hasNormalized(
        source,
        "reportFreshnessTone[projection.freshness.status] ??"
      )
    ).toBe(true);
    expect(source).toContain("data-status={projection.freshness.status}");
    expect(
      hasNormalized(
        source,
        "commerceLabel(labels.reportFreshnessStatus, projection.freshness.status)"
      )
    ).toBe(true);
  });

  test("the export-run status badge replaces its inline completed/danger ternary with reportRunStatusTone/commerceLabel(labels.reportRunStatus, …) and data-status", async () => {
    const source = await readFile(REPORTS_PAGE, "utf8");

    expect(source).not.toContain(
      'run.status === "completed" ? "success" : "danger"'
    );
    expect(hasNormalized(source, "reportRunStatusTone[run.status] ??")).toBe(
      true
    );
    expect(source).toContain("data-status={run.status}");
    expect(
      hasNormalized(source, "commerceLabel(labels.reportRunStatus, run.status)")
    ).toBe(true);
  });
});

describe("commerce-whatsapp.astro — status filter/cell are labelled and the table gets a real empty state", () => {
  test("the status filter <select> renders through commerceLabel(labels.whatsappMessageStatus, …)", async () => {
    const source = await readFile(WHATSAPP_PAGE, "utf8");

    expect(
      hasNormalized(
        source,
        "<option value={status} selected={statusFilter === status}> {status}"
      )
    ).toBe(false);
    expect(
      hasNormalized(
        source,
        "commerceLabel(labels.whatsappMessageStatus, status)"
      )
    ).toBe(true);
  });

  test("the Status column renders through commerceLabel(labels.whatsappMessageStatus, …) and carries data-status", async () => {
    const source = await readFile(WHATSAPP_PAGE, "utf8");

    expect(source).not.toContain('<td data-label="Status">{entry.status}</td>');
    expect(source).toContain("data-status={entry.status}");
    expect(
      hasNormalized(
        source,
        "commerceLabel(labels.whatsappMessageStatus, entry.status)"
      )
    ).toBe(true);
  });

  test('an empty result now renders a <td class="data-table-empty"> row inside the table, matching the other commerce tables\' empty-state pattern', async () => {
    const source = await readFile(WHATSAPP_PAGE, "utf8");

    expect(source).toContain('class="data-table-empty"');
    expect(source).toContain('class="empty-state"');
    expect(source).toContain('class="empty-state-icon"');
    expect(source).toContain('id="commerce-whatsapp-empty"');
    // The table itself must always render (headers visible even when
    // empty) — the old bare `<div class="empty-state">` short-circuit that
    // skipped the table entirely is gone.
    expect(
      hasNormalized(
        source,
        '{entries.length === 0 ? ( <div class="empty-state">'
      )
    ).toBe(false);
  });
});

describe("commerce-pos.astro — the sale-history Status column is labelled", () => {
  test("the badge renders through commerceLabel(labels.orderStatus, …) and carries data-status", async () => {
    const source = await readFile(POS_PAGE, "utf8");

    expect(source).not.toContain(
      '<span class="status-badge">{order.status}</span>'
    );
    expect(source).toContain("data-status={order.status}");
    expect(
      hasNormalized(source, "commerceLabel(labels.orderStatus, order.status)")
    ).toBe(true);
  });
});

describe("commerce-reviews.astro — the Status column is labelled without touching the delete confirm script", () => {
  test("the cell renders through commerceLabel(labels.reviewStatus, …) and carries data-status", async () => {
    const source = await readFile(REVIEWS_PAGE, "utf8");

    expect(source).not.toContain(
      '<td data-label="Status">{review.status}</td>'
    );
    expect(source).toContain("data-status={review.status}");
    expect(
      hasNormalized(source, "commerceLabel(labels.reviewStatus, review.status)")
    ).toBe(true);
  });
});

describe("commerce-campaigns.astro — channel/status are labelled in the list and the detail heading, without touching send/cancel confirms", () => {
  test("the list cells render through campaignChannel/campaignStatus and carry data-channel/data-status", async () => {
    const source = await readFile(CAMPAIGNS_PAGE, "utf8");

    expect(source).not.toContain(
      '<td data-label="Channel">{campaign.channel}</td>'
    );
    expect(source).not.toContain(
      '<span class="status-badge">{campaign.status}</span>'
    );
    expect(source).toContain("data-channel={campaign.channel}");
    expect(
      hasNormalized(
        source,
        "commerceLabel(labels.campaignChannel, campaign.channel)"
      )
    ).toBe(true);
    expect(source).toContain("data-status={campaign.status}");
    expect(
      hasNormalized(
        source,
        "commerceLabel(labels.campaignStatus, campaign.status)"
      )
    ).toBe(true);
  });

  test("the detail heading renders through campaignChannel/campaignStatus and carries data-channel/data-status", async () => {
    const source = await readFile(CAMPAIGNS_PAGE, "utf8");

    expect(
      hasNormalized(
        source,
        '{selected.channel} ·{" "} <span class="status-badge">{selected.status}</span>'
      )
    ).toBe(false);
    expect(source).toContain("data-channel={selected.channel}");
    expect(
      hasNormalized(
        source,
        "commerceLabel(labels.campaignChannel, selected.channel)"
      )
    ).toBe(true);
    expect(source).toContain("data-status={selected.status}");
    expect(
      hasNormalized(
        source,
        "commerceLabel(labels.campaignStatus, selected.status)"
      )
    ).toBe(true);
  });

  test("the create-form channel <select>'s own literal E-mail/WhatsApp text is left untouched (different msgid than the shared map)", async () => {
    const source = await readFile(CAMPAIGNS_PAGE, "utf8");
    expect(
      hasNormalized(source, '<option value="email">{t("E-mail")}</option>')
    ).toBe(true);
  });
});

describe("commerce-vouchers.astro — type/status are labelled, and the create-form type <select> reuses the shared map", () => {
  test("the create-form type <select> iterates labels.voucherType instead of three hand-written <option>s", async () => {
    const source = await readFile(VOUCHERS_PAGE, "utf8");

    expect(source).not.toContain(
      '<option value="percentage">{t("Percentage")}</option>'
    );
    expect(source).toContain("Object.entries(labels.voucherType).map(");
  });

  test("the Type column renders through commerceLabel(labels.voucherType, …) and carries data-type", async () => {
    const source = await readFile(VOUCHERS_PAGE, "utf8");

    expect(source).not.toContain('<td data-label="Type">{voucher.type}</td>');
    expect(source).toContain("data-type={voucher.type}");
    expect(
      hasNormalized(source, "commerceLabel(labels.voucherType, voucher.type)")
    ).toBe(true);
  });

  test("the read-only Status fallback renders through commerceLabel(labels.voucherStatus, …) and carries data-status", async () => {
    const source = await readFile(VOUCHERS_PAGE, "utf8");

    expect(hasNormalized(source, ") : ( voucher.status )}")).toBe(false);
    expect(source).toContain("data-status={voucher.status}");
    expect(
      hasNormalized(
        source,
        "commerceLabel(labels.voucherStatus, voucher.status)"
      )
    ).toBe(true);
  });
});

describe("commerce-flash-sales.astro — the create/edit status <select>s reuse the shared map's own labels, and the read-only fallback is labelled", () => {
  test("the create-form status <select> uses labels.flashSaleStatus.draft/.scheduled, not literal t() calls", async () => {
    const source = await readFile(FLASH_SALES_PAGE, "utf8");

    expect(source).not.toContain('<option value="draft">{t("Draft")}</option>');
    expect(
      hasNormalized(
        source,
        '<option value="draft">{labels.flashSaleStatus.draft}</option>'
      )
    ).toBe(true);
    expect(
      hasNormalized(
        source,
        '<option value="scheduled">{labels.flashSaleStatus.scheduled}</option>'
      )
    ).toBe(true);
  });

  test("the edit-row status <select> uses labels.flashSaleStatus.draft/.scheduled", async () => {
    const source = await readFile(FLASH_SALES_PAGE, "utf8");

    expect(source).toContain("{labels.flashSaleStatus.draft}");
    expect(source).toContain("{labels.flashSaleStatus.scheduled}");
  });

  test("the read-only fallback renders through commerceLabel(labels.flashSaleStatus, …) and carries data-status", async () => {
    const source = await readFile(FLASH_SALES_PAGE, "utf8");

    expect(hasNormalized(source, ") : ( sale.status )}")).toBe(false);
    expect(source).toContain("data-status={sale.status}");
    expect(
      hasNormalized(
        source,
        "commerceLabel(labels.flashSaleStatus, sale.status)"
      )
    ).toBe(true);
  });
});

describe("commerce-customers.astro — the read-only Status fallback is labelled", () => {
  test("it renders through commerceLabel(labels.customerStatus, …) and carries data-status", async () => {
    const source = await readFile(CUSTOMERS_PAGE, "utf8");

    expect(hasNormalized(source, ") : ( customer.status )}")).toBe(false);
    expect(source).toContain("data-status={customer.status}");
    expect(
      hasNormalized(
        source,
        "commerceLabel(labels.customerStatus, customer.status)"
      )
    ).toBe(true);
  });
});

describe("commerce-popup.astro — the create-form frequency <select> reuses the shared map, and the table cell is labelled", () => {
  test("the create-form frequency <select> iterates labels.popupFrequency instead of three hand-written <option>s", async () => {
    const source = await readFile(POPUP_PAGE, "utf8");

    expect(source).not.toContain(
      '<option value="once_per_session">{t("Once per session")}</option>'
    );
    expect(source).toContain("Object.entries(labels.popupFrequency).map(");
    expect(source).toContain('selected={value === "once_per_day"}');
  });

  test("the Frequency column renders through commerceLabel(labels.popupFrequency, …) and carries data-frequency", async () => {
    const source = await readFile(POPUP_PAGE, "utf8");

    expect(source).not.toContain(
      '<td data-label="Frequency">{popup.frequency}</td>'
    );
    expect(source).toContain("data-frequency={popup.frequency}");
    expect(
      hasNormalized(
        source,
        "commerceLabel(labels.popupFrequency, popup.frequency)"
      )
    ).toBe(true);
  });
});

describe("commerce-settings.astro (webhook endpoint provider)", () => {
  const SETTINGS_PAGE = "src/pages/admin/commerce-settings.astro";

  test("the Provider cell renders through commerceLabel(labels.webhookEndpointProvider, …) and carries data-provider", async () => {
    const source = await readFile(SETTINGS_PAGE, "utf8");
    expect(source).toContain("createCommerceLabels(t)");
    expect(source).toContain("data-provider={endpoint.provider}");
    expect(
      hasNormalized(
        source,
        "commerceLabel(labels.webhookEndpointProvider, endpoint.provider)"
      )
    ).toBe(true);
    expect(source).not.toContain("{endpoint.provider}</td>");
  });
});
