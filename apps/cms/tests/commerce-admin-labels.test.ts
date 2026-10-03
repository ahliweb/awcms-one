/**
 * `src/lib/ui/commerce-admin-labels.ts` (Issue #243). Pure — no database, no
 * network, no I/O beyond reading the already-committed `.po` catalogs
 * `compileLocale` parses. This issue ships no screen, so these tests cover
 * only the shared module's own contract: every enum value the commerce
 * module (or, for the two report statuses, the shared `reporting` module)
 * defines gets a real Indonesian label, `commerceLabel` never throws and
 * falls back sensibly, and every msgid the module's `t(...)` calls use is
 * declared in BOTH catalogs.
 */
import { describe, expect, test } from "bun:test";

import { getTranslator } from "../src/lib/i18n";
import { compileLocale } from "../scripts/i18n-compile";
import { SUPPORTED_LOCALES } from "../src/lib/i18n/locales";
import { catalogKey } from "../src/lib/i18n/po";
import {
  createCommerceLabels,
  commerceLabel,
  orderStatusTone,
  affiliateStatusTone,
  commissionStatusTone,
  reviewStatusTone,
  reportFreshnessTone,
  reportRunStatusTone,
  type CommerceLabels
} from "../src/lib/ui/commerce-admin-labels";

const idLabels = createCommerceLabels(getTranslator("id").t);
const enLabels = createCommerceLabels(getTranslator("en").t);

/** Every label map's own entries, flattened to `[enumKey, mapName, value]` — used by every "for every map" assertion below so a map added to {@link createCommerceLabels} without being listed here is caught by the "not empty" test rather than silently skipped. */
function flatten(
  labels: CommerceLabels
): { map: string; key: string; value: string }[] {
  return Object.entries(labels).flatMap(([map, values]) =>
    Object.entries(values as Record<string, string>).map(([key, value]) => ({
      map,
      key,
      value
    }))
  );
}

const idEntries = flatten(idLabels);

describe("createCommerceLabels", () => {
  test("returns a non-empty map for every enum (a vacuous pass is not a pass)", () => {
    expect(Object.keys(idLabels).length).toBe(32);
    for (const [, values] of Object.entries(idLabels)) {
      expect(Object.keys(values as object).length).toBeGreaterThan(0);
    }
  });

  test("every Indonesian label is non-empty", () => {
    const empty = idEntries.filter((entry) => entry.value.trim() === "");
    expect(empty).toEqual([]);
  });

  test("every Indonesian label differs from its own raw snake_case key", () => {
    // The untranslated fallback IS the raw key for `en` (msgid === English
    // source) — this test is specifically about `id` never silently
    // rendering the same machine-readable value a raw, unlabelled render
    // already showed the reader.
    const unlabelled = idEntries.filter((entry) => entry.value === entry.key);
    expect(unlabelled).toEqual([]);
  });

  test("orderStatus covers every value order-status.ts declares", () => {
    expect(Object.keys(idLabels.orderStatus).sort()).toEqual(
      [
        "pending_payment",
        "paid",
        "processing",
        "shipped",
        "completed",
        "cancelled",
        "expired"
      ].sort()
    );
  });

  test('productStatus\'s "active" reads "Published", matching commerce.astro\'s own existing tab', () => {
    expect(enLabels.productStatus.active).toBe("Published");
  });

  test("flashSaleStatus covers the full derived state, not just the two editable values", () => {
    // `sale.status` on the read-only fallback (`commerce-flash-sales.astro`)
    // can be the TICK JOB's derived `active`/`ended`, not only the two
    // values a human may `PATCH` — the map must cover all four.
    expect(Object.keys(idLabels.flashSaleStatus).sort()).toEqual(
      ["draft", "scheduled", "active", "ended"].sort()
    );
  });

  test("voucherStatus/customerStatus are the plain active/inactive|blocked pairs their own screens' <select> options already declare", () => {
    expect(Object.keys(idLabels.voucherStatus).sort()).toEqual(
      ["active", "inactive"].sort()
    );
    expect(Object.keys(idLabels.customerStatus).sort()).toEqual(
      ["active", "blocked"].sort()
    );
  });

  test("paymentGatewayStatus is the RAW gateway session state, distinct from orderStatus", () => {
    expect(Object.keys(idLabels.paymentGatewayStatus).sort()).toEqual(
      ["pending", "paid", "expired", "failed", "refunded"].sort()
    );
  });

  test("paymentGatewaySessionProvider covers midtrans and the dev/CI log adapter", () => {
    expect(Object.keys(idLabels.paymentGatewaySessionProvider).sort()).toEqual(
      ["midtrans", "log"].sort()
    );
  });

  test("webhookEndpointProvider is midtrans-only, a NARROWER union than paymentGatewaySessionProvider", () => {
    expect(Object.keys(idLabels.webhookEndpointProvider)).toEqual(["midtrans"]);
  });

  test("paymentEventOutcome covers applied/ignored/replay", () => {
    expect(Object.keys(idLabels.paymentEventOutcome).sort()).toEqual(
      ["applied", "ignored", "replay"].sort()
    );
  });

  test("popupFrequency covers the three values commerce-popup.astro's own create form already offers", () => {
    expect(Object.keys(idLabels.popupFrequency).sort()).toEqual(
      ["once_per_session", "once_per_day", "always"].sort()
    );
  });
});

describe("commerceLabel", () => {
  const map = { active: "Aktif", suspended: "Ditangguhkan" };

  test("returns the mapped label for a known value", () => {
    expect(commerceLabel(map, "active")).toBe("Aktif");
  });

  test("falls back to the raw value for an unknown value, never throwing", () => {
    expect(commerceLabel(map, "banned")).toBe("banned");
  });

  test("returns an empty string for null", () => {
    expect(commerceLabel(map, null)).toBe("");
  });

  test("returns an empty string for undefined", () => {
    expect(commerceLabel(map, undefined)).toBe("");
  });

  test("never throws for any input, including an empty string", () => {
    expect(() => commerceLabel(map, "")).not.toThrow();
    expect(commerceLabel(map, "")).toBe("");
  });
});

describe("tone maps", () => {
  test("orderStatusTone/affiliateStatusTone/commissionStatusTone/reviewStatusTone/reportFreshnessTone/reportRunStatusTone each cover exactly their own enum's keys", () => {
    expect(Object.keys(orderStatusTone).sort()).toEqual(
      Object.keys(idLabels.orderStatus).sort()
    );
    expect(Object.keys(affiliateStatusTone).sort()).toEqual(
      Object.keys(idLabels.affiliateStatus).sort()
    );
    expect(Object.keys(commissionStatusTone).sort()).toEqual(
      Object.keys(idLabels.commissionStatus).sort()
    );
    expect(Object.keys(reviewStatusTone).sort()).toEqual(
      Object.keys(idLabels.reviewStatus).sort()
    );
    expect(Object.keys(reportFreshnessTone).sort()).toEqual(
      Object.keys(idLabels.reportFreshnessStatus).sort()
    );
    expect(Object.keys(reportRunStatusTone).sort()).toEqual(
      Object.keys(idLabels.reportRunStatus).sort()
    );
  });

  const validTones = [
    "success",
    "warning",
    "info",
    "primary",
    "danger",
    "neutral"
  ];

  test("every tone value is one of the six known CSS variant names", () => {
    const allTones = [
      ...Object.values(orderStatusTone),
      ...Object.values(affiliateStatusTone),
      ...Object.values(commissionStatusTone),
      ...Object.values(reviewStatusTone),
      ...Object.values(reportFreshnessTone),
      ...Object.values(reportRunStatusTone)
    ];
    const invalid = allTones.filter((tone) => !validTones.includes(tone));
    expect(invalid).toEqual([]);
  });
});

describe("catalog coverage — every msgid this module asks for exists in both en.po and id.po", () => {
  const declaredKeysByLocale = new Map(
    SUPPORTED_LOCALES.map((locale) => [
      locale,
      new Set(compileLocale(locale).declaredKeys)
    ])
  );

  // Calling the factory with the IDENTITY function collects the exact set of
  // msgids the module's own `t(...)` calls pass — the same literals
  // `i18n:catalog:check`'s regex harvester would find, gathered here by
  // actually invoking the code instead, so this test cannot drift from what
  // the module really asks for.
  const identityLabels = createCommerceLabels((msgid) => msgid);
  const usedMsgids = new Set(
    Object.values(identityLabels).flatMap((values) =>
      Object.values(values as Record<string, string>)
    )
  );

  test("at least one msgid was collected (a vacuous pass is not a pass)", () => {
    expect(usedMsgids.size).toBeGreaterThan(0);
  });

  for (const locale of SUPPORTED_LOCALES) {
    test(`every msgid is declared in ${locale}.po`, () => {
      const declared = declaredKeysByLocale.get(locale);
      const missing = [...usedMsgids].filter(
        (msgid) => !declared?.has(catalogKey(msgid))
      );
      expect(missing).toEqual([]);
    });
  }
});
