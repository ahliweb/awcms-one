/**
 * Customer-retention rules (Issue #364, ADR-0044; metrics spec section 6) -
 * PURE, no database, so the fixed calendar dates below are fixtures of the
 * spec's own worked example (section 6.3), not wall-clock dependencies. Every
 * "now" is an explicit argument. The live-database half (rebuild equals live,
 * RLS, the toggle, late events through the engine) is
 * `tests/integration/commerce-retention.integration.test.ts`.
 *
 * Also pins the permission and registration plumbing that has no database in
 * it: the two keys, their routes (read from the route SOURCE, the technique
 * `commerce-operational-report-permissions.test.ts` uses), the seed migration
 * and the descriptor's shape.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { listModules } from "../src/modules";
import {
  evaluateAccess,
  isHighRiskAction,
  type AccessRequest,
  type TenantContext
} from "../src/modules/identity-access/domain/access-control";
import { DEFAULT_COMMERCE_FEATURES } from "../src/modules/commerce/domain/commerce-features";
import {
  RETENTION_MIN_COHORT_FOR_RATE,
  RETENTION_PROJECTION_KEY,
  RETENTION_WINDOW_MS,
  addCohortMonths,
  cohortMaturesAt,
  cohortMonthEnd,
  cohortMonthOf,
  cohortMonthStart,
  deriveCustomerRetention,
  formatRetentionRate,
  isCohortMature,
  isQualifyingRetentionOrder,
  isRepeatWithinWindow,
  restatedCohortMonths,
  shapeRetentionCohorts,
  validateRetentionRange,
  type RetentionOrderFact
} from "../src/modules/commerce/domain/retention";
import { resolveSalesReportDay } from "../src/modules/commerce/domain/sales-report-deltas";
import { serializeRetentionReportCsv } from "../src/modules/commerce/domain/retention-csv";
import type { RetentionReport } from "../src/modules/commerce/application/retention-report-directory";
import { relevantOrderIds } from "../src/modules/commerce/application/retention-projection";

/** An `Asia/Jakarta` wall-clock instant: `jkt(2026, 1, 3, 9)` is 3 Jan 2026 09:00 WIB. */
const jkt = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(Date.UTC(y, m - 1, d, h - 7, min));
const DAY = 24 * 60 * 60 * 1000;

const order = (
  id: string,
  paidAt: Date | null,
  over: Partial<RetentionOrderFact> = {}
): RetentionOrderFact => ({
  orderId: id,
  paidAt,
  status: "completed",
  paymentStatus: "paid",
  ...over
});

describe("qualifying order", () => {
  test("paid, in a paid state, not fully refunded", () => {
    expect(isQualifyingRetentionOrder(order("a", jkt(2026, 1, 3)))).toBe(true);
    for (const status of ["paid", "processing", "shipped", "completed"]) {
      expect(
        isQualifyingRetentionOrder(order("a", jkt(2026, 1, 3), { status }))
      ).toBe(true);
    }
  });

  test("an unpaid, cancelled, expired or fully refunded order does not qualify", () => {
    expect(isQualifyingRetentionOrder(order("a", null))).toBe(false);
    for (const status of ["pending_payment", "cancelled", "expired"]) {
      expect(
        isQualifyingRetentionOrder(order("a", jkt(2026, 1, 3), { status }))
      ).toBe(false);
    }
    expect(
      isQualifyingRetentionOrder(
        order("a", jkt(2026, 1, 3), { paymentStatus: "refunded" })
      )
    ).toBe(false);
  });

  test("a partial refund keeps the order qualifying (the ledger derives refunded only at zero net)", () => {
    expect(
      isQualifyingRetentionOrder(
        order("a", jkt(2026, 1, 3), { paymentStatus: "paid" })
      )
    ).toBe(true);
  });
});

describe("Asia/Jakarta calendar months", () => {
  test("a Jakarta evening after UTC midnight belongs to the Jakarta month", () => {
    // 31 Jan 2026 23:30 WIB is 31 Jan 16:30 UTC; 1 Feb 2026 00:30 WIB is 31 Jan 17:30 UTC.
    expect(cohortMonthOf(jkt(2026, 1, 31, 23, 30))).toBe("2026-01-01");
    expect(cohortMonthOf(jkt(2026, 2, 1, 0, 30))).toBe("2026-02-01");
  });

  test("the month boundary is Jakarta midnight, agreeing with the sales-report day resolver", () => {
    const start = cohortMonthStart("2026-02-01");
    expect(start.toISOString()).toBe("2026-01-31T17:00:00.000Z");
    expect(resolveSalesReportDay(start)).toBe("2026-02-01");
    expect(resolveSalesReportDay(new Date(start.getTime() - 1))).toBe(
      "2026-01-31"
    );
    expect(cohortMonthEnd("2026-01-01").getTime()).toBe(start.getTime());
    expect(cohortMonthEnd("2026-12-01").toISOString()).toBe(
      "2026-12-31T17:00:00.000Z"
    );
  });

  test("addCohortMonths crosses year ends in both directions", () => {
    expect(addCohortMonths("2026-11-01", 3)).toBe("2027-02-01");
    expect(addCohortMonths("2026-02-01", -3)).toBe("2025-11-01");
    expect(addCohortMonths("2026-01-01", -11)).toBe("2025-02-01");
  });
});

describe("the 90-day window is absolute time, inclusive of the final instant", () => {
  const first = jkt(2026, 1, 28, 10);

  test("exactly 90 x 24 h after the first is inside; one millisecond more is outside", () => {
    expect(
      isRepeatWithinWindow(
        first,
        new Date(first.getTime() + RETENTION_WINDOW_MS)
      )
    ).toBe(true);
    expect(
      isRepeatWithinWindow(
        first,
        new Date(first.getTime() + RETENTION_WINDOW_MS + 1)
      )
    ).toBe(false);
  });

  test("a second event at or before the first is never a repeat, and none is not a repeat", () => {
    expect(isRepeatWithinWindow(first, first)).toBe(false);
    expect(isRepeatWithinWindow(first, new Date(first.getTime() - 1))).toBe(
      false
    );
    expect(isRepeatWithinWindow(first, null)).toBe(false);
    expect(isRepeatWithinWindow(first, new Date(first.getTime() + 1))).toBe(
      true
    );
  });
});

describe("per-customer derivation", () => {
  test("first, second strictly after, and the qualifying count", () => {
    const derived = deriveCustomerRetention([
      order("b", jkt(2026, 2, 20)),
      order("a", jkt(2026, 1, 3)),
      order("c", jkt(2026, 3, 1))
    ])!;
    expect(derived.cohortMonth).toBe("2026-01-01");
    expect(derived.firstEventAt.toISOString()).toBe(
      jkt(2026, 1, 3).toISOString()
    );
    expect(derived.secondEventAt!.toISOString()).toBe(
      jkt(2026, 2, 20).toISOString()
    );
    expect(derived.qualifyingOrderCount).toBe(3);
  });

  test("two orders at the same instant are two orders but not a repeat", () => {
    const at = jkt(2026, 1, 3);
    const derived = deriveCustomerRetention([order("a", at), order("b", at)])!;
    expect(derived.qualifyingOrderCount).toBe(2);
    expect(derived.secondEventAt).toBeNull();
  });

  test("no qualifying order yields no row", () => {
    expect(deriveCustomerRetention([])).toBeNull();
    expect(
      deriveCustomerRetention([
        order("a", jkt(2026, 1, 3), { status: "cancelled" })
      ])
    ).toBeNull();
  });

  test("a fully refunded first purchase hands the cohort to the next order (the customer 'never really started')", () => {
    const derived = deriveCustomerRetention([
      order("a", jkt(2026, 1, 3), { paymentStatus: "refunded" }),
      order("b", jkt(2026, 2, 9))
    ])!;
    expect(derived.cohortMonth).toBe("2026-02-01");
    expect(derived.qualifyingOrderCount).toBe(1);
  });

  test("a cancelled repeat stops counting", () => {
    const derived = deriveCustomerRetention([
      order("a", jkt(2026, 1, 3)),
      order("b", jkt(2026, 1, 20), { status: "cancelled" })
    ])!;
    expect(derived.secondEventAt).toBeNull();
  });
});

/**
 * Metrics section 6.3, commerce-only: "B" rows of the spec's table become
 * orders (a booking input comes after Wave C, not here). C7 is refunded in
 * full and never starts; C4's second event sits at exactly day 90.
 */
describe("metrics section 6.3 worked example (proof item 5)", () => {
  const customers: Record<string, RetentionOrderFact[]> = {
    C1: [order("c1a", jkt(2026, 1, 3)), order("c1b", jkt(2026, 2, 20))],
    C2: [order("c2a", jkt(2026, 1, 10)), order("c2b", jkt(2026, 5, 10))],
    C3: [order("c3a", jkt(2026, 1, 15))],
    C4: [
      order("c4a", jkt(2026, 1, 28)),
      order("c4b", new Date(jkt(2026, 1, 28).getTime() + 90 * DAY))
    ],
    C5: [order("c5a", jkt(2026, 2, 2)), order("c5b", jkt(2026, 2, 12))],
    C6: [order("c6a", jkt(2026, 2, 9))],
    C7: [order("c7a", jkt(2026, 2, 21), { paymentStatus: "refunded" })]
  };

  const tallies = () => {
    const byMonth = new Map<string, { size: number; repeaters: number }>();
    for (const facts of Object.values(customers)) {
      const derived = deriveCustomerRetention(facts);
      if (derived === null) continue;
      const cell = byMonth.get(derived.cohortMonth) ?? {
        size: 0,
        repeaters: 0
      };
      cell.size += 1;
      if (isRepeatWithinWindow(derived.firstEventAt, derived.secondEventAt)) {
        cell.repeaters += 1;
      }
      byMonth.set(derived.cohortMonth, cell);
    }
    return byMonth;
  };

  test("January: 4 customers, C1 and C4 repeat (day 90 is inside), C2 at 120 days does not", () => {
    expect(tallies().get("2026-01-01")).toEqual({ size: 4, repeaters: 2 });
    expect(formatRetentionRate(2, 4)).toBe("50.0");
  });

  test("February: 2 customers, C5 repeats; C7 (refunded in full) is in no cohort", () => {
    expect(tallies().get("2026-02-01")).toEqual({ size: 2, repeaters: 1 });
    expect(tallies().size).toBe(2);
  });

  test("a cohort of 4 or 2 shows counts, not a percentage; February matures after 29 May", () => {
    const cohorts = shapeRetentionCohorts(
      [...tallies()].map(([cohortMonth, v]) => ({ cohortMonth, ...v })),
      jkt(2026, 4, 1)
    );
    expect(cohorts.map((c) => c.rateShown)).toEqual([false, false]);
    expect(cohorts.map((c) => c.ratePercent)).toEqual([null, null]);
    // 28 Feb + 90 days = 29 May (the spec's own arithmetic), at the month's closing instant.
    expect(cohortMaturesAt("2026-02-01").toISOString()).toBe(
      new Date(cohortMonthEnd("2026-02-01").getTime() + 90 * DAY).toISOString()
    );
    expect(isCohortMature("2026-02-01", jkt(2026, 5, 28))).toBe(false);
    expect(isCohortMature("2026-02-01", jkt(2026, 5, 30))).toBe(true);
    expect(cohorts.map((c) => c.mature)).toEqual([false, false]);
  });
});

describe("cohort shaping", () => {
  test("a cohort of at least 20 shows the rate to one decimal, round-half-up", () => {
    expect(RETENTION_MIN_COHORT_FOR_RATE).toBe(20);
    expect(formatRetentionRate(1, 3)).toBe("33.3");
    expect(formatRetentionRate(2, 3)).toBe("66.7");
    expect(formatRetentionRate(1, 8)).toBe("12.5");
    expect(formatRetentionRate(1, 16)).toBe("6.3"); // 6.25 rounds half up
    expect(formatRetentionRate(0, 25)).toBe("0.0");
    expect(formatRetentionRate(25, 25)).toBe("100.0");
    const [cohort] = shapeRetentionCohorts(
      [{ cohortMonth: "2026-01-01", size: 20, repeaters: 7 }],
      jkt(2027, 1, 1)
    );
    expect(cohort!.rateShown).toBe(true);
    expect(cohort!.ratePercent).toBe("35.0");
    expect(cohort!.mature).toBe(true);
  });

  test("19 customers withholds the rate, 20 shows it", () => {
    const [small, exact] = shapeRetentionCohorts(
      [
        { cohortMonth: "2026-01-01", size: 19, repeaters: 5 },
        { cohortMonth: "2026-02-01", size: 20, repeaters: 5 }
      ],
      jkt(2027, 1, 1)
    );
    expect(small!.ratePercent).toBeNull();
    expect(exact!.ratePercent).toBe("25.0");
  });

  test("the restated flag comes from the log", () => {
    const [cohort] = shapeRetentionCohorts(
      [{ cohortMonth: "2026-01-01", size: 3, repeaters: 1 }],
      jkt(2027, 1, 1),
      new Map([["2026-01-01", jkt(2026, 4, 1)]])
    );
    expect(cohort!.restated).toBe(true);
    expect(cohort!.restatedAt).toBe(jkt(2026, 4, 1).toISOString());
  });
});

describe("restatement (35-day window)", () => {
  const row = (month: string, first: Date, second: Date | null) => ({
    cohortMonth: month,
    firstEventAt: first,
    secondEventAt: second
  });
  const jan = row("2026-01-01", jkt(2026, 1, 10), null);

  test("a change inside the window is not a restatement", () => {
    // January closes 1 Feb; +35 days is 8 Mar.
    expect(restatedCohortMonths(null, jan, jkt(2026, 3, 1))).toEqual([]);
  });

  test("a customer joining or leaving a closed cohort restates it", () => {
    expect(restatedCohortMonths(null, jan, jkt(2026, 3, 9))).toEqual([
      "2026-01-01"
    ]);
    expect(restatedCohortMonths(jan, null, jkt(2026, 3, 9))).toEqual([
      "2026-01-01"
    ]);
  });

  test("moving between cohorts restates each closed side", () => {
    const feb = row("2026-02-01", jkt(2026, 2, 5), null);
    expect(restatedCohortMonths(jan, feb, jkt(2026, 3, 9))).toEqual([
      "2026-01-01"
    ]);
    expect(restatedCohortMonths(jan, feb, jkt(2026, 4, 9))).toEqual([
      "2026-01-01",
      "2026-02-01"
    ]);
  });

  test("a repeat lost after the window restates; a repeat gained before maturity is just the cohort filling in", () => {
    const withRepeat = row("2026-01-01", jkt(2026, 1, 10), jkt(2026, 2, 10));
    expect(restatedCohortMonths(withRepeat, jan, jkt(2026, 3, 9))).toEqual([
      "2026-01-01"
    ]);
    // Gained at 9 Mar: January is closed but matures only on 1 May.
    expect(restatedCohortMonths(jan, withRepeat, jkt(2026, 3, 9))).toEqual([]);
    // Gained after maturity: no ordinary order could still arrive.
    expect(restatedCohortMonths(jan, withRepeat, jkt(2026, 5, 2))).toEqual([
      "2026-01-01"
    ]);
  });

  test("an unchanged row restates nothing", () => {
    expect(restatedCohortMonths(jan, { ...jan }, jkt(2027, 1, 1))).toEqual([]);
    expect(restatedCohortMonths(null, null, jkt(2027, 1, 1))).toEqual([]);
  });
});

describe("batch relevance", () => {
  test("only events that can change qualification touch a customer", () => {
    const ids = relevantOrderIds([
      { order_id: "o1", from_status: null, to_status: "pending_payment" },
      { order_id: "o2", from_status: "pending_payment", to_status: "paid" },
      { order_id: "o3", from_status: "paid", to_status: "processing" },
      { order_id: "o4", from_status: "completed", to_status: "cancelled" },
      {
        order_id: "o5",
        from_status: "pending_payment",
        to_status: "cancelled"
      },
      {
        order_id: "o6",
        from_status: "paid",
        to_status: "returned",
        return_id: "r1"
      },
      { order_id: "o7" }
    ]);
    expect(ids).toEqual(["o2", "o4", "o6", "o7"]);
  });
});

describe("range validation", () => {
  test("default 12, bounds 1 to 36", () => {
    expect(validateRetentionRange({ months: null })).toEqual({
      valid: true,
      value: { months: 12 }
    });
    expect(validateRetentionRange({ months: "36" }).valid).toBe(true);
    for (const bad of ["0", "37", "abc", "-1", "1.5", "007x"]) {
      expect(validateRetentionRange({ months: bad }).valid).toBe(false);
    }
  });
});

describe("CSV", () => {
  const report: RetentionReport = {
    enabled: true,
    timeZone: "Asia/Jakarta",
    windowDays: 90,
    minCohortForRate: 20,
    restatementWindowDays: 35,
    asOf: "2027-01-01T00:00:00.000Z",
    from: "2026-01-01",
    to: "2026-02-01",
    unlinkedOrders: 3,
    cohorts: shapeRetentionCohorts(
      [
        { cohortMonth: "2026-01-01", size: 4, repeaters: 2 },
        { cohortMonth: "2026-02-01", size: 40, repeaters: 10 }
      ],
      jkt(2027, 1, 1)
    )
  };

  test("a small cohort has an empty percentage cell; aggregates only", () => {
    const lines = serializeRetentionReportCsv(report).trim().split("\r\n");
    expect(lines[0]).toBe(
      "cohort_month,customers,repeaters_within_90_days,retention_percent,status,matures_at,restated_at"
    );
    expect(lines[1]!.split(",").slice(0, 4)).toEqual([
      "2026-01-01",
      "4",
      "2",
      ""
    ]);
    expect(lines[2]!.split(",").slice(0, 4)).toEqual([
      "2026-02-01",
      "40",
      "10",
      "25.0"
    ]);
    expect(serializeRetentionReportCsv(report)).not.toMatch(
      /customer_id|phone|email/
    );
  });
});

describe("registration", () => {
  const commerce = listModules().find((module) => module.key === "commerce")!;

  test("the feature toggle defaults OFF", () => {
    expect(DEFAULT_COMMERCE_FEATURES.retention).toBe(false);
  });

  test("the module declares the two permission keys and the descriptor reads behind the read key", () => {
    const keys = (commerce.permissions ?? []).map(
      (p) => `commerce.${p.activityCode}.${p.action}`
    );
    expect(keys).toContain("commerce.report_retention.read");
    expect(keys).toContain("commerce.report_retention.export");
    const descriptor = commerce.reportingProjections!.find(
      (d) => d.key === RETENTION_PROJECTION_KEY
    )!;
    expect(descriptor.requiredPermission).toBe(
      "commerce.report_retention.read"
    );
    expect(descriptor.source.strategy).toBe("cursor_table");
    expect(descriptor.dimensional).toBeDefined();
  });

  test("the seed migration carries exactly the two rows", async () => {
    const sql = await readFile(
      "sql/1021_awcms_commerce_retention_projection_permissions.sql",
      "utf8"
    );
    const seeded = [
      ...sql.matchAll(/\('commerce', '(report_[a-z_]+)', '([a-z]+)'/g)
    ].map((match) => `commerce.${match[1]}.${match[2]}`);
    expect(seeded.sort()).toEqual([
      "commerce.report_retention.export",
      "commerce.report_retention.read"
    ]);
  });

  test("each route enforces exactly its own key and no route opens customers or the dashboard", async () => {
    const files = {
      "retention.ts": "read",
      "retention.csv.ts": "export"
    } as const;
    for (const [file, action] of Object.entries(files)) {
      const source = await readFile(
        `src/pages/api/v1/reports/commerce/${file}`,
        "utf8"
      );
      expect(source).toContain(
        `activityCode: COMMERCE_REPORT_RETENTION_ACTIVITY_CODE,\n    action: "${action}"`
      );
      expect(source).not.toContain('moduleKey: "reporting"');
      expect(source).not.toContain("COMMERCE_CUSTOMERS_ACTIVITY_CODE");
    }
    const csv = await readFile(
      "src/pages/api/v1/reports/commerce/retention.csv.ts",
      "utf8"
    );
    expect(csv).toContain("retention_report.export");
    expect(csv).toContain("no-store");
  });

  test("role-shaped grants: dashboard, customers.read and other report keys open nothing here; export is high risk", () => {
    const context: TenantContext = {
      tenantId: "11111111-1111-4111-8111-111111111111",
      tenantUserId: "22222222-2222-4222-8222-222222222222",
      identityId: "33333333-3333-4333-8333-333333333333",
      roles: ["manager"]
    };
    const check = (keys: string[], action: "read" | "export") => {
      const request: AccessRequest = {
        moduleKey: "commerce",
        activityCode: "report_retention",
        action
      };
      return evaluateAccess(context, request, new Set(keys)).allowed;
    };
    expect(
      check(
        [
          "reporting.dashboard.read",
          "commerce.customers.read",
          "commerce.report_tenders.read",
          "commerce.report_returns.export",
          "commerce.report_loyalty.read"
        ],
        "read"
      )
    ).toBe(false);
    expect(check(["commerce.report_retention.read"], "read")).toBe(true);
    expect(check(["commerce.report_retention.read"], "export")).toBe(false);
    expect(check(["commerce.report_retention.export"], "read")).toBe(false);
    expect(isHighRiskAction("export")).toBe(true);
  });
});
