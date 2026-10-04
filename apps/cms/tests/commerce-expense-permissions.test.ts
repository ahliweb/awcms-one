/**
 * Expense permission separation (Issue #294, ADR-0031). Pure - no database. The
 * rule: being allowed to move cash in a drawer (or to ring up a sale) grants no
 * authority to book, approve, reverse, export or read the receipt of an
 * expense, and each of the twelve keys is its own key. Proven three ways, none a
 * restatement of another:
 *
 *   1. the twelve keys are declared by the module and each is enforced by
 *      exactly the route meant to need it (read from the route SOURCE, the same
 *      technique `commerce-register-permissions.test.ts` uses);
 *   2. a REAL access evaluation (`evaluateAccess`) of role-shaped grants - a
 *      clerk, a supervisor, a drawer cashier - allows what each role needs and
 *      DENIES the rest;
 *   3. the high-risk classification: approve and export are high-risk verbs, so
 *      a tenant may author SoD rules against them, and the upstream-owned
 *      `AccessAction` union was not widened.
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
  COMMERCE_EXPENSE_CATEGORIES_ACTIVITY_CODE,
  COMMERCE_EXPENSE_POSTINGS_ACTIVITY_CODE,
  COMMERCE_EXPENSE_RECEIPTS_ACTIVITY_CODE,
  COMMERCE_EXPENSE_REVERSALS_ACTIVITY_CODE,
  COMMERCE_EXPENSES_ACTIVITY_CODE
} from "../src/modules/commerce/domain/commerce-permissions";

const CATEGORIES = COMMERCE_EXPENSE_CATEGORIES_ACTIVITY_CODE;
const EXPENSES = COMMERCE_EXPENSES_ACTIVITY_CODE;
const POSTINGS = COMMERCE_EXPENSE_POSTINGS_ACTIVITY_CODE;
const REVERSALS = COMMERCE_EXPENSE_REVERSALS_ACTIVITY_CODE;
const RECEIPTS = COMMERCE_EXPENSE_RECEIPTS_ACTIVITY_CODE;

/** Route file -> the guards it enforces (the supervisor checks in handlers are listed too). */
const ROUTES = {
  "expense-categories/index.ts": [
    [CATEGORIES, "read"],
    [CATEGORIES, "create"]
  ],
  "expense-categories/[id].ts": [
    [CATEGORIES, "read"],
    [CATEGORIES, "update"]
  ],
  "expenses/index.ts": [
    [EXPENSES, "read"],
    [EXPENSES, "create"]
  ],
  "expenses/[id]/index.ts": [
    [EXPENSES, "read"],
    [EXPENSES, "update"],
    // Supervisor path of a draft edit: checked in the handler.
    [POSTINGS, "approve"]
  ],
  "expenses/[id]/post.ts": [
    [POSTINGS, "create"],
    // Whether the poster may also approve an above-threshold expense.
    [POSTINGS, "approve"]
  ],
  "expenses/[id]/decision.ts": [[POSTINGS, "approve"]],
  "expenses/[id]/reverse.ts": [[REVERSALS, "approve"]],
  "expenses/[id]/cancel.ts": [
    [EXPENSES, "update"],
    [POSTINGS, "approve"]
  ],
  "expenses/[id]/receipt.ts": [
    [RECEIPTS, "create"],
    [POSTINGS, "approve"]
  ],
  "expenses/[id]/receipt-url.ts": [[RECEIPTS, "read"]],
  "expenses/summary.ts": [[EXPENSES, "read"]],
  "expenses/export.csv.ts": [[EXPENSES, "export"]]
} as const;

const CONSTANT_TO_CODE: Record<string, string> = {
  COMMERCE_EXPENSE_CATEGORIES_ACTIVITY_CODE: CATEGORIES,
  COMMERCE_EXPENSES_ACTIVITY_CODE: EXPENSES,
  COMMERCE_EXPENSE_POSTINGS_ACTIVITY_CODE: POSTINGS,
  COMMERCE_EXPENSE_REVERSALS_ACTIVITY_CODE: REVERSALS,
  COMMERCE_EXPENSE_RECEIPTS_ACTIVITY_CODE: RECEIPTS
};

function guardsIn(source: string): Set<string> {
  const found = new Set<string>();
  const pattern =
    /activityCode:\s*(COMMERCE_[A-Z_]+_ACTIVITY_CODE),\s*action:\s*"([a-z_]+)"/g;
  for (const match of source.matchAll(pattern)) {
    const code = CONSTANT_TO_CODE[match[1]!];
    if (code) found.add(`commerce.${code}.${match[2]}`);
  }
  return found;
}

const declared = new Set(
  (
    listModules().find((module) => module.key === "commerce")?.permissions ?? []
  ).map(
    (permission) => `commerce.${permission.activityCode}.${permission.action}`
  )
);

const EXPECTED_KEYS = [
  "commerce.expense_categories.read",
  "commerce.expense_categories.create",
  "commerce.expense_categories.update",
  "commerce.expenses.read",
  "commerce.expenses.create",
  "commerce.expenses.update",
  "commerce.expenses.export",
  "commerce.expense_postings.create",
  "commerce.expense_postings.approve",
  "commerce.expense_reversals.approve",
  "commerce.expense_receipts.read",
  "commerce.expense_receipts.create"
];

describe("expense permissions are declared and each is enforced by its route", () => {
  test("the module declares exactly the twelve expense permissions", () => {
    const expenseKeys = [...declared].filter((key) =>
      key.startsWith("commerce.expense")
    );
    expect(expenseKeys.sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  for (const [file, expected] of Object.entries(ROUTES)) {
    test(`${file} enforces exactly its own guards`, async () => {
      const source = await readFile(
        `src/pages/api/v1/commerce/${file}`,
        "utf8"
      );
      const wanted = new Set(
        expected.map(([code, action]) => `commerce.${code}.${action}`)
      );
      expect([...guardsIn(source)].sort()).toEqual([...wanted].sort());
    });
  }

  test("every one of the twelve keys is enforced by at least one route", async () => {
    const enforced = new Set<string>();
    for (const file of Object.keys(ROUTES)) {
      const source = await readFile(
        `src/pages/api/v1/commerce/${file}`,
        "utf8"
      );
      for (const key of guardsIn(source)) enforced.add(key);
    }
    for (const key of EXPECTED_KEYS) expect(enforced.has(key)).toBe(true);
  });

  test("no expense route is satisfied by the POS or drawer permissions", async () => {
    for (const file of Object.keys(ROUTES)) {
      const source = await readFile(
        `src/pages/api/v1/commerce/${file}`,
        "utf8"
      );
      expect(source).not.toContain("COMMERCE_POS_ACTIVITY_CODE");
      expect(source).not.toContain("COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE");
      // The media library's own permission must never gate (or satisfy) an
      // expense route; the route only reuses its issuance helpers.
      expect(source).not.toContain('moduleKey: "media_library"');
      expect(source).not.toContain("MEDIA_PERMISSION_ACTIVITY_CODE");
    }
  });

  test("every mutating route requires an Idempotency-Key, except the natural-idempotent draft edit, category writes and receipt attach", async () => {
    for (const file of [
      "expenses/index.ts",
      "expenses/[id]/post.ts",
      "expenses/[id]/decision.ts",
      "expenses/[id]/reverse.ts",
      "expenses/[id]/cancel.ts"
    ]) {
      const source = await readFile(
        `src/pages/api/v1/commerce/${file}`,
        "utf8"
      );
      expect(source).toContain("requireIdempotencyKey(request)");
    }
  });
});

describe("role-shaped grants gain no authority beyond their own keys", () => {
  const CONTEXT: TenantContext = {
    tenantId: "11111111-1111-4111-8111-111111111111",
    tenantUserId: "22222222-2222-4222-8222-222222222222",
    identityId: "33333333-3333-4333-8333-333333333333",
    roles: ["clerk"]
  };

  const allowed = (
    keys: ReadonlySet<string>,
    activityCode: string,
    action: AccessAction
  ): boolean => {
    const request: AccessRequest = {
      moduleKey: "commerce",
      activityCode,
      action
    };
    return evaluateAccess(CONTEXT, request, keys).allowed;
  };

  const split = (key: string) => {
    const [, activityCode, action] = key.split(".") as [
      string,
      string,
      AccessAction
    ];
    return { activityCode, action };
  };

  const CLERK = new Set([
    "commerce.expenses.read",
    "commerce.expenses.create",
    "commerce.expenses.update",
    "commerce.expense_postings.create",
    "commerce.expense_receipts.create"
  ]);

  test("a clerk can record, edit, post and attach - and cannot approve, reverse, export or read a receipt", () => {
    expect(allowed(CLERK, EXPENSES, "create")).toBe(true);
    expect(allowed(CLERK, EXPENSES, "update")).toBe(true);
    expect(allowed(CLERK, POSTINGS, "create")).toBe(true);
    expect(allowed(CLERK, RECEIPTS, "create")).toBe(true);
    expect(allowed(CLERK, POSTINGS, "approve")).toBe(false);
    expect(allowed(CLERK, REVERSALS, "approve")).toBe(false);
    expect(allowed(CLERK, EXPENSES, "export")).toBe(false);
    expect(allowed(CLERK, RECEIPTS, "read")).toBe(false);
    expect(allowed(CLERK, CATEGORIES, "create")).toBe(false);
  });

  test("reading expenses grants neither the export nor the receipt", () => {
    const reader = new Set(["commerce.expenses.read"]);
    expect(allowed(reader, EXPENSES, "export")).toBe(false);
    expect(allowed(reader, RECEIPTS, "read")).toBe(false);
    expect(allowed(reader, RECEIPTS, "create")).toBe(false);
  });

  test("a drawer cashier (pos + register session keys) gains no expense permission at all", () => {
    const cashier = new Set([
      "commerce.pos.create",
      "commerce.registers.read",
      "commerce.register_sessions.read",
      "commerce.register_sessions.create",
      "commerce.register_sessions.update",
      "commerce.register_cash_ups.create",
      "commerce.register_cash_ups.approve",
      "media_library.media.download"
    ]);
    for (const key of EXPECTED_KEYS) {
      const { activityCode, action } = split(key);
      expect(allowed(cashier, activityCode, action)).toBe(false);
    }
  });

  test("each permission is its own key: granting one does not grant a neighbour", () => {
    for (const key of EXPECTED_KEYS) {
      const only = new Set([key]);
      for (const other of EXPECTED_KEYS) {
        const { activityCode, action } = split(other);
        expect(allowed(only, activityCode, action)).toBe(other === key);
      }
    }
  });

  test("approve and export are the platform's high-risk verbs, so a tenant may author SoD rules against them", () => {
    expect(isHighRiskAction("approve")).toBe(true);
    expect(isHighRiskAction("export")).toBe(true);
    // Every verb the expense keys use already existed upstream: the union was not widened.
    const verbs = new Set(EXPECTED_KEYS.map((key) => split(key).action));
    const used: string[] = [...verbs];
    expect(used.sort()).toEqual(
      ["approve", "create", "export", "read", "update"].sort()
    );
  });
});
