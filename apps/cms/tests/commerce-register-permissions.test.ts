/**
 * POS register / cash-up permission separation (Issue #284, ADR-0028). Pure -
 * no database. The issue's rule: separate permissions for open / use / close /
 * approve-variance / read / manage-registers, and a cashier must NOT
 * automatically gain report or admin privileges. This file proves it three
 * ways, none of them a restatement of another:
 *
 *   1. the ten keys are declared by the module and each is enforced by exactly
 *      the route that is meant to need it (read from the route SOURCE, the
 *      same technique `admin-commerce-page-contract.test.ts` uses);
 *   2. a REAL access evaluation (`evaluateAccess`) of a cashier-shaped grant -
 *      `commerce.pos.create` plus exactly what running a shift needs - is
 *      allowed on every shift route and DENIED on approval, correction, export
 *      and register administration;
 *   3. the high-risk classification: approve and export are high-risk verbs, so
 *      a tenant may author SoD rules against them.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { listModules } from "../src/modules";
import {
  evaluateAccess,
  isHighRiskAction,
  permissionKey,
  type AccessAction,
  type AccessRequest,
  type TenantContext
} from "../src/modules/identity-access/domain/access-control";
import {
  COMMERCE_REGISTER_CASH_UPS_ACTIVITY_CODE,
  COMMERCE_REGISTER_CORRECTIONS_ACTIVITY_CODE,
  COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE,
  COMMERCE_REGISTERS_ACTIVITY_CODE
} from "../src/modules/commerce/domain/commerce-permissions";

const ROUTES = {
  "registers/index.ts": [
    [COMMERCE_REGISTERS_ACTIVITY_CODE, "read"],
    [COMMERCE_REGISTERS_ACTIVITY_CODE, "create"]
  ],
  "registers/[id].ts": [
    [COMMERCE_REGISTERS_ACTIVITY_CODE, "read"],
    [COMMERCE_REGISTERS_ACTIVITY_CODE, "update"]
  ],
  "register-sessions/index.ts": [
    [COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE, "read"],
    [COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE, "create"]
  ],
  "register-sessions/[id]/index.ts": [
    [COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE, "read"]
  ],
  "register-sessions/[id]/movements.ts": [
    [COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE, "update"]
  ],
  "register-sessions/[id]/handover.ts": [
    [COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE, "update"],
    // The supervisor path of a handover: checked in the handler.
    [COMMERCE_REGISTER_CASH_UPS_ACTIVITY_CODE, "approve"]
  ],
  "register-sessions/[id]/close.ts": [
    [COMMERCE_REGISTER_CASH_UPS_ACTIVITY_CODE, "create"],
    // Whether the closer may also approve a variance: checked in the handler.
    [COMMERCE_REGISTER_CASH_UPS_ACTIVITY_CODE, "approve"]
  ],
  "register-sessions/[id]/close-decision.ts": [
    [COMMERCE_REGISTER_CASH_UPS_ACTIVITY_CODE, "approve"]
  ],
  "register-sessions/[id]/corrections.ts": [
    [COMMERCE_REGISTER_CORRECTIONS_ACTIVITY_CODE, "approve"]
  ],
  "register-sessions/[id]/report.csv.ts": [
    [COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE, "export"]
  ]
} as const;

const CONSTANT_TO_CODE: Record<string, string> = {
  COMMERCE_REGISTERS_ACTIVITY_CODE,
  COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE,
  COMMERCE_REGISTER_CASH_UPS_ACTIVITY_CODE,
  COMMERCE_REGISTER_CORRECTIONS_ACTIVITY_CODE
};

/** Every `{ activityCode: CONST, action: "x" }` guard literal in a route source. */
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
  "commerce.registers.read",
  "commerce.registers.create",
  "commerce.registers.update",
  "commerce.register_sessions.read",
  "commerce.register_sessions.create",
  "commerce.register_sessions.update",
  "commerce.register_sessions.export",
  "commerce.register_cash_ups.create",
  "commerce.register_cash_ups.approve",
  "commerce.register_corrections.approve"
];

describe("register permissions are declared and each is enforced by its route", () => {
  test("the module declares exactly the ten register permissions", () => {
    for (const key of EXPECTED_KEYS) expect(declared.has(key)).toBe(true);
    const registerKeys = [...declared].filter(
      (key) =>
        key.startsWith("commerce.register") &&
        !key.startsWith("commerce.registered")
    );
    expect(registerKeys.sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  for (const [file, expected] of Object.entries(ROUTES)) {
    test(`${file} enforces exactly its own guards`, async () => {
      const source = await readFile(
        `src/pages/api/v1/commerce/${file}`,
        "utf8"
      );
      const found = guardsIn(source);
      const wanted = new Set(
        expected.map(([code, action]) => `commerce.${code}.${action}`)
      );
      expect([...found].sort()).toEqual([...wanted].sort());
    });
  }

  test("every one of the ten keys is enforced by at least one route", async () => {
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

  test("no register route requires commerce.pos.create - ringing up a sale grants none of them", async () => {
    for (const file of Object.keys(ROUTES)) {
      const source = await readFile(
        `src/pages/api/v1/commerce/${file}`,
        "utf8"
      );
      expect(source).not.toContain("COMMERCE_POS_ACTIVITY_CODE");
    }
  });

  test("every mutating route requires an Idempotency-Key", async () => {
    for (const file of [
      "register-sessions/index.ts",
      "register-sessions/[id]/movements.ts",
      "register-sessions/[id]/handover.ts",
      "register-sessions/[id]/close.ts",
      "register-sessions/[id]/close-decision.ts",
      "register-sessions/[id]/corrections.ts"
    ]) {
      const source = await readFile(
        `src/pages/api/v1/commerce/${file}`,
        "utf8"
      );
      expect(source).toContain("requireIdempotencyKey(request)");
    }
  });

  test("every route is gated on the tenant's register feature", async () => {
    for (const file of Object.keys(ROUTES)) {
      const source = await readFile(
        `src/pages/api/v1/commerce/${file}`,
        "utf8"
      );
      expect(source).toContain("requireRegisterFeature(tx, tenantId)");
    }
  });
});

describe("a cashier grant gains no report, approval, correction or administration authority", () => {
  const CONTEXT: TenantContext = {
    tenantId: "11111111-1111-4111-8111-111111111111",
    tenantUserId: "22222222-2222-4222-8222-222222222222",
    identityId: "33333333-3333-4333-8333-333333333333",
    roles: ["cashier"]
  };

  /** What running a shift needs - and nothing else. */
  const CASHIER = new Set([
    "commerce.pos.create",
    "commerce.registers.read",
    "commerce.register_sessions.read",
    "commerce.register_sessions.create",
    "commerce.register_sessions.update",
    "commerce.register_cash_ups.create"
  ]);

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

  test("the cashier can open, use and close a session and read the registers/sessions", () => {
    expect(allowed(CASHIER, "registers", "read")).toBe(true);
    expect(allowed(CASHIER, "register_sessions", "read")).toBe(true);
    expect(allowed(CASHIER, "register_sessions", "create")).toBe(true);
    expect(allowed(CASHIER, "register_sessions", "update")).toBe(true);
    expect(allowed(CASHIER, "register_cash_ups", "create")).toBe(true);
  });

  test("the cashier cannot approve a variance, correct a closed session, export the cash-up, or administer registers", () => {
    expect(allowed(CASHIER, "register_cash_ups", "approve")).toBe(false);
    expect(allowed(CASHIER, "register_corrections", "approve")).toBe(false);
    expect(allowed(CASHIER, "register_sessions", "export")).toBe(false);
    expect(allowed(CASHIER, "registers", "create")).toBe(false);
    expect(allowed(CASHIER, "registers", "update")).toBe(false);
  });

  test("holding commerce.pos.create ALONE grants no register permission at all", () => {
    const posOnly = new Set(["commerce.pos.create"]);
    for (const key of EXPECTED_KEYS) {
      const [, activityCode, action] = key.split(".") as [
        string,
        string,
        AccessAction
      ];
      expect(allowed(posOnly, activityCode, action)).toBe(false);
    }
  });

  test("each permission is its own key: granting one does not grant a neighbour", () => {
    for (const key of EXPECTED_KEYS) {
      const [, activityCode, action] = key.split(".") as [
        string,
        string,
        AccessAction
      ];
      const only = new Set([key]);
      for (const other of EXPECTED_KEYS) {
        const [, otherCode, otherAction] = other.split(".") as [
          string,
          string,
          AccessAction
        ];
        expect(allowed(only, otherCode, otherAction)).toBe(other === key);
      }
      expect(permissionKey("commerce", activityCode, action)).toBe(key);
    }
  });

  test("approve and export are the platform's high-risk verbs, so a tenant may author SoD rules against them", () => {
    expect(isHighRiskAction("approve")).toBe(true);
    expect(isHighRiskAction("export")).toBe(true);
  });
});
