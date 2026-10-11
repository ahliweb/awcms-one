/**
 * POS operational-report permission separation (Issue #296, ADR-0035). Pure -
 * no database. The rule: a report is an aggregate OVER a source, not the
 * source, so reading or exporting one is its own authority, never implied by
 * the dashboard permission, the source-domain permission or another report.
 * Proven three ways, none a restatement of another:
 *
 *   1. the twelve keys are declared by the module and each is enforced by exactly
 *      the route meant to need it (read from the route SOURCE, the technique
 *      `commerce-expense-permissions.test.ts` uses);
 *   2. a REAL access evaluation (`evaluateAccess`) of role-shaped grants - a
 *      till supervisor, a bookkeeper, a dashboard reader - allows what each
 *      role needs and DENIES the rest;
 *   3. the high-risk classification: `export` is a high-risk verb, and the
 *      upstream-owned `AccessAction` union was not widened.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { listModules } from "../src/modules";
import {
  evaluateAccess,
  isHighRiskAction,
  type AccessAction,
  type AccessRequest,
  type TenantContext
} from "../src/modules/identity-access/domain/access-control";
import {
  COMMERCE_REPORT_CASH_UPS_ACTIVITY_CODE,
  COMMERCE_REPORT_EXPENSES_ACTIVITY_CODE,
  COMMERCE_REPORT_LOYALTY_ACTIVITY_CODE,
  COMMERCE_REPORT_RETURNS_ACTIVITY_CODE,
  COMMERCE_REPORT_STORED_VALUE_ACTIVITY_CODE,
  COMMERCE_REPORT_TENDERS_ACTIVITY_CODE
} from "../src/modules/commerce/domain/commerce-permissions";

const TENDERS = COMMERCE_REPORT_TENDERS_ACTIVITY_CODE;
const CASH_UPS = COMMERCE_REPORT_CASH_UPS_ACTIVITY_CODE;
const EXPENSES = COMMERCE_REPORT_EXPENSES_ACTIVITY_CODE;
const LOYALTY = COMMERCE_REPORT_LOYALTY_ACTIVITY_CODE;
const STORED_VALUE = COMMERCE_REPORT_STORED_VALUE_ACTIVITY_CODE;
const RETURNS = COMMERCE_REPORT_RETURNS_ACTIVITY_CODE;

/** Route file -> the guard it enforces. */
const ROUTES = {
  "operational-tenders.ts": [TENDERS, "read"],
  "operational-tenders.csv.ts": [TENDERS, "export"],
  "operational-cash-ups.ts": [CASH_UPS, "read"],
  "operational-cash-ups.csv.ts": [CASH_UPS, "export"],
  "operational-expenses.ts": [EXPENSES, "read"],
  "operational-expenses.csv.ts": [EXPENSES, "export"],
  "operational-loyalty.ts": [LOYALTY, "read"],
  "operational-loyalty.csv.ts": [LOYALTY, "export"],
  "operational-stored-value.ts": [STORED_VALUE, "read"],
  "operational-stored-value.csv.ts": [STORED_VALUE, "export"],
  // Issue #316 - the returns & refunds family.
  "operational-returns.ts": [RETURNS, "read"],
  "operational-returns.csv.ts": [RETURNS, "export"]
} as const;

const CONSTANT_TO_CODE: Record<string, string> = {
  COMMERCE_REPORT_TENDERS_ACTIVITY_CODE: TENDERS,
  COMMERCE_REPORT_CASH_UPS_ACTIVITY_CODE: CASH_UPS,
  COMMERCE_REPORT_EXPENSES_ACTIVITY_CODE: EXPENSES,
  COMMERCE_REPORT_LOYALTY_ACTIVITY_CODE: LOYALTY,
  COMMERCE_REPORT_STORED_VALUE_ACTIVITY_CODE: STORED_VALUE,
  COMMERCE_REPORT_RETURNS_ACTIVITY_CODE: RETURNS
};

function guardsIn(source: string): Set<string> {
  const found = new Set<string>();
  const pattern =
    /activityCode:\s*(COMMERCE_[A-Z_]+_ACTIVITY_CODE),\s*action:\s*"([a-z_]+)"/g;
  for (const match of source.matchAll(pattern)) {
    const code = CONSTANT_TO_CODE[match[1]!];
    found.add(`commerce.${code ?? match[1]}.${match[2]}`);
  }
  return found;
}

const EXPECTED_KEYS = Object.values(ROUTES).map(
  ([code, action]) => `commerce.${code}.${action}`
);

const declared = new Set(
  (
    listModules().find((module) => module.key === "commerce")?.permissions ?? []
  ).map(
    (permission) => `commerce.${permission.activityCode}.${permission.action}`
  )
);

describe("operational-report permissions are declared and each is enforced by its route", () => {
  test("the module declares exactly the twelve report permissions", () => {
    // Issue #364's `report_retention` pair is a different family (cohorts, not
    // POS operational rows) and is pinned by commerce-retention-domain.test.ts.
    const reportKeys = [...declared].filter(
      (key) =>
        key.startsWith("commerce.report_") &&
        !key.startsWith("commerce.report_retention.")
    );
    expect(reportKeys.sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  for (const [file, [code, action]] of Object.entries(ROUTES)) {
    test(`${file} enforces exactly commerce.${code}.${action}`, async () => {
      const source = await readFile(
        `src/pages/api/v1/reports/commerce/${file}`,
        "utf8"
      );
      expect([...guardsIn(source)]).toEqual([`commerce.${code}.${action}`]);
    });
  }

  test("no report route is satisfied by the dashboard or by a source-domain permission", async () => {
    for (const file of Object.keys(ROUTES)) {
      const source = await readFile(
        `src/pages/api/v1/reports/commerce/${file}`,
        "utf8"
      );
      expect(source).not.toContain('moduleKey: "reporting"');
      expect(source).not.toContain("COMMERCE_PAYMENTS_ACTIVITY_CODE");
      expect(source).not.toContain("COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE");
      expect(source).not.toContain("COMMERCE_EXPENSES_ACTIVITY_CODE");
      expect(source).not.toContain("COMMERCE_STORED_VALUE_ACTIVITY_CODE");
      expect(source).not.toContain("COMMERCE_RETURNS_ACTIVITY_CODE");
    }
  });

  test("every CSV route audits the export and no JSON route does", async () => {
    for (const file of Object.keys(ROUTES)) {
      const source = await readFile(
        `src/pages/api/v1/reports/commerce/${file}`,
        "utf8"
      );
      if (file.endsWith(".csv.ts")) {
        expect(source).toContain("recordOperationalExportAudit(");
      } else {
        expect(source).not.toContain("recordOperationalExportAudit(");
      }
    }
  });

  test("the seed migrations (sql/999 and #316's sql/946) carry exactly the same twelve rows", async () => {
    const sql =
      (await readFile(
        "sql/999_awcms_commerce_operational_reports_permissions.sql",
        "utf8"
      )) +
      (await readFile(
        "sql/946_awcms_commerce_returns_report_permissions.sql",
        "utf8"
      ));
    const seeded = [
      ...sql.matchAll(/\('commerce', '(report_[a-z_]+)', '([a-z]+)'/g)
    ].map((match) => `commerce.${match[1]}.${match[2]}`);
    expect(seeded.sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  test("each projection's own requiredPermission is its family's .read key", () => {
    const commerce = listModules().find((module) => module.key === "commerce")!;
    const required = Object.fromEntries(
      (commerce.reportingProjections ?? [])
        .filter((descriptor) => descriptor.key.startsWith("commerce.pos_"))
        .map((descriptor) => [descriptor.key, descriptor.requiredPermission])
    );
    expect(required).toEqual({
      "commerce.pos_tender_daily": "commerce.report_tenders.read",
      "commerce.pos_cash_up_variance": "commerce.report_cash_ups.read",
      "commerce.pos_expense_daily": "commerce.report_expenses.read",
      "commerce.pos_loyalty_daily": "commerce.report_loyalty.read",
      "commerce.pos_stored_value_daily": "commerce.report_stored_value.read",
      "commerce.pos_returns_daily": "commerce.report_returns.read"
    });
  });
});

describe("role-shaped grants gain no authority beyond their own keys", () => {
  const CONTEXT: TenantContext = {
    tenantId: "11111111-1111-4111-8111-111111111111",
    tenantUserId: "22222222-2222-4222-8222-222222222222",
    identityId: "33333333-3333-4333-8333-333333333333",
    roles: ["supervisor"]
  };

  const allowed = (
    keys: ReadonlySet<string>,
    activityCode: string,
    action: AccessAction,
    moduleKey = "commerce"
  ): boolean => {
    const request: AccessRequest = { moduleKey, activityCode, action };
    return evaluateAccess(CONTEXT, request, keys).allowed;
  };

  const split = (key: string) => {
    const [moduleKey, activityCode, action] = key.split(".") as [
      string,
      string,
      AccessAction
    ];
    return { moduleKey, activityCode, action };
  };

  test("reading a report grants no export and no other family", () => {
    const reader = new Set(["commerce.report_tenders.read"]);
    expect(allowed(reader, TENDERS, "read")).toBe(true);
    expect(allowed(reader, TENDERS, "export")).toBe(false);
    for (const other of [CASH_UPS, EXPENSES, LOYALTY, STORED_VALUE, RETURNS]) {
      expect(allowed(reader, other, "read")).toBe(false);
      expect(allowed(reader, other, "export")).toBe(false);
    }
  });

  test("a bookkeeper (tender + expense reports, with export) cannot see cash-up variance, loyalty or stored value", () => {
    const bookkeeper = new Set([
      "commerce.report_tenders.read",
      "commerce.report_tenders.export",
      "commerce.report_expenses.read",
      "commerce.report_expenses.export"
    ]);
    expect(allowed(bookkeeper, TENDERS, "export")).toBe(true);
    expect(allowed(bookkeeper, EXPENSES, "export")).toBe(true);
    for (const other of [CASH_UPS, LOYALTY, STORED_VALUE, RETURNS]) {
      expect(allowed(bookkeeper, other, "read")).toBe(false);
    }
  });

  test("the dashboard permission, every source-domain read and every cashier key grant no report key", () => {
    const holders = new Set([
      "reporting.dashboard.read",
      "reporting.projections.read",
      "reporting.exports.export",
      "commerce.payments.read",
      "commerce.expenses.read",
      "commerce.expenses.export",
      "commerce.register_sessions.read",
      "commerce.register_sessions.export",
      "commerce.register_cash_ups.approve",
      "commerce.stored_value.read",
      "commerce.loyalty.read",
      "commerce.returns.read",
      "commerce.refunds.read",
      "commerce.pos.create"
    ]);
    for (const key of EXPECTED_KEYS) {
      const { activityCode, action } = split(key);
      expect(allowed(holders, activityCode, action)).toBe(false);
    }
  });

  test("a report key opens no source-domain row", () => {
    const everyReport = new Set(EXPECTED_KEYS);
    for (const key of [
      "commerce.payments.read",
      "commerce.expenses.read",
      "commerce.register_sessions.read",
      "commerce.stored_value.read",
      "commerce.loyalty.read",
      "commerce.returns.read",
      "commerce.refunds.read"
    ]) {
      const { activityCode, action } = split(key);
      expect(allowed(everyReport, activityCode, action)).toBe(false);
    }
  });

  test("export is a high-risk verb (so a tenant may author SoD rules against it) and the verbs used already existed", () => {
    expect(isHighRiskAction("export")).toBe(true);
    expect(isHighRiskAction("read")).toBe(false);
    for (const key of EXPECTED_KEYS) {
      const { action } = split(key);
      expect(["read", "export"]).toContain(action);
    }
  });
});
