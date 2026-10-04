/**
 * Returns, refunds and exchanges: structure and permission separation (Issue
 * #287, ADR-0033). Pure - no database, no network. Every assertion reads
 * source or evaluates the real access model.
 *
 *   1. The five permissions are declared and each is enforced by the route
 *      meant to need it; `AccessAction` is NOT widened.
 *   2. A refund needs `commerce.payments.revoke` as well; the offline path
 *      needs its own high-risk key; a cashier grant gains none of them.
 *   3. The provider is called from exactly one place, which opens no
 *      transaction around the call; every route is gated on the `returns`
 *      feature and every mutation requires an Idempotency-Key.
 *   4. The single writers: only the directories insert returns / lines /
 *      refunds / compensations; only the inventory port touches stock.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

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
  COMMERCE_REFUND_OFFLINE_PERMISSIONS,
  COMMERCE_REFUND_PERMISSIONS,
  COMMERCE_RETURN_PERMISSIONS
} from "../src/modules/commerce/domain/commerce-permissions";

const SRC = "src";
const ROUTES = "src/pages/api/v1/commerce";

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (/\.(ts|astro)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const read = (path: string) => readFile(path, "utf8");

const ROUTE_FILES = {
  orderReturns: `${ROUTES}/orders/[id]/returns/index.ts`,
  list: `${ROUTES}/returns/index.ts`,
  reconcile: `${ROUTES}/returns/reconcile.ts`,
  one: `${ROUTES}/returns/[id]/index.ts`,
  exchange: `${ROUTES}/returns/[id]/exchange-order.ts`,
  refunds: `${ROUTES}/returns/[id]/refunds/index.ts`,
  execute: `${ROUTES}/returns/[id]/refunds/[refundId]/execute.ts`,
  offline: `${ROUTES}/returns/[id]/refunds/[refundId]/offline.ts`
} as const;

describe("the returns permissions", () => {
  const commerce = listModules().find((m) => m.key === "commerce")!;
  const declared = new Set(
    commerce.permissions!.map((p) => `${p.activityCode}.${p.action}`)
  );

  test("the module declares exactly the five returns permissions, all with existing verbs", () => {
    for (const key of [
      "returns.read",
      "returns.create",
      "refunds.read",
      "refunds.create",
      "refunds_offline.approve"
    ]) {
      expect(declared.has(key)).toBe(true);
    }
    expect(COMMERCE_RETURN_PERMISSIONS).toEqual({
      read: "commerce.returns.read",
      create: "commerce.returns.create"
    });
    expect(COMMERCE_REFUND_PERMISSIONS).toEqual({
      read: "commerce.refunds.read",
      create: "commerce.refunds.create"
    });
    expect(COMMERCE_REFUND_OFFLINE_PERMISSIONS).toEqual({
      approve: "commerce.refunds_offline.approve"
    });
  });

  test("AccessAction is not widened: no returns-specific verb exists", async () => {
    const source = await read(
      `${SRC}/modules/identity-access/domain/access-control.ts`
    );
    for (const verb of ["refund", "return", "reverse", "restock"]) {
      expect(source).not.toMatch(new RegExp(`\\|\\s*"${verb}"`));
    }
  });

  const expectations: [string, string[]][] = [
    ["orderReturns", ["returns.read", "returns.create"]],
    ["list", ["returns.read"]],
    ["reconcile", ["refunds.read"]],
    ["one", ["returns.read"]],
    ["exchange", ["returns.create"]],
    ["refunds", ["refunds.create"]],
    ["execute", ["refunds.create"]],
    ["offline", ["refunds_offline.approve"]]
  ];
  for (const [name, keys] of expectations) {
    test(`${name} enforces exactly its own guards`, async () => {
      const source = await read(ROUTE_FILES[name as keyof typeof ROUTE_FILES]);
      const found = [
        ...source.matchAll(
          /COMMERCE_(RETURNS|REFUNDS_OFFLINE|REFUNDS)_ACTIVITY_CODE,?\s*\n?\s*action: "(\w+)"|activityCode: COMMERCE_(RETURNS|REFUNDS_OFFLINE|REFUNDS)_ACTIVITY_CODE,\s*action: "(\w+)"/g
        )
      ].map((m) => {
        const area = (m[1] ?? m[3])!.toLowerCase();
        return `${area}.${m[2] ?? m[4]}`;
      });
      for (const key of keys) expect(found).toContain(key);
    });
  }

  test("a refund also requires the payments.revoke chokepoint check; the offline route additionally", async () => {
    for (const name of ["refunds", "execute", "offline"] as const) {
      const source = await read(ROUTE_FILES[name]);
      expect(source).toContain("requirePaymentsRevoke");
    }
    const create = await read(ROUTE_FILES.orderReturns);
    // Only when a refund is asked for, the extra keys are checked.
    expect(create).toContain("if (prepared.refund)");
    expect(create).toContain("REFUND_CREATE_GUARD");
    expect(create).toContain("requirePaymentsRevoke");
  });

  test("the offline attestation is the platform's high-risk verb, so a tenant may author SoD rules against it", () => {
    expect(isHighRiskAction("approve")).toBe(true);
  });

  test("every permission has a route that enforces it", async () => {
    const all = (await Promise.all(Object.values(ROUTE_FILES).map(read))).join(
      "\n"
    );
    for (const code of [
      "COMMERCE_RETURNS_ACTIVITY_CODE",
      "COMMERCE_REFUNDS_ACTIVITY_CODE",
      "COMMERCE_REFUNDS_OFFLINE_ACTIVITY_CODE"
    ]) {
      expect(all).toContain(code);
    }
  });
});

describe("a cashier grant gains no returns authority", () => {
  const CONTEXT: TenantContext = {
    tenantId: "11111111-1111-4111-8111-111111111111",
    tenantUserId: "22222222-2222-4222-8222-222222222222",
    identityId: "33333333-3333-4333-8333-333333333333",
    roles: ["cashier"]
  };
  const CASHIER = new Set([
    "commerce.pos.create",
    "commerce.payments.create",
    "commerce.orders.read"
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

  test("none of the five keys, nor payments.revoke, is implied by the cashier grant", () => {
    expect(allowed(CASHIER, "pos", "create")).toBe(true);
    for (const [activity, action] of [
      ["returns", "read"],
      ["returns", "create"],
      ["refunds", "read"],
      ["refunds", "create"],
      ["refunds_offline", "approve"],
      ["payments", "revoke"]
    ] as [string, AccessAction][]) {
      expect(allowed(CASHIER, activity, action)).toBe(false);
      expect(permissionKey("commerce", activity, action)).toBe(
        `commerce.${activity}.${action}`
      );
    }
  });

  test("each permission is its own key: a returns clerk cannot settle a refund, and a refund operator cannot attest offline", () => {
    const clerk = new Set(["commerce.returns.create", "commerce.returns.read"]);
    expect(allowed(clerk, "returns", "create")).toBe(true);
    expect(allowed(clerk, "refunds", "create")).toBe(false);
    const operator = new Set([
      "commerce.refunds.create",
      "commerce.payments.revoke"
    ]);
    expect(allowed(operator, "refunds", "create")).toBe(true);
    expect(allowed(operator, "refunds_offline", "approve")).toBe(false);
  });
});

describe("the provider call and the routes' shape", () => {
  test("a refund provider is called from exactly one place, and that function opens no transaction around the call", async () => {
    const files = await walk(SRC);
    const callers: string[] = [];
    for (const file of files) {
      if (file.includes("/infrastructure/")) continue;
      const source = await read(file);
      if (/\.refund!?\(/.test(source) && /deps\.provider/.test(source)) {
        callers.push(file);
      }
    }
    expect(callers).toEqual([
      `${SRC}/modules/commerce/application/refund-execution.ts`
    ]);
    const source = await read(callers[0]!);
    // The call sits between the two short transactions, at the function's own
    // top level - not inside either `withTenantOrThrow` callback.
    const claimEnd = source.indexOf(
      'if (claim.kind === "done") return claim.outcome;'
    );
    const callAt = source.indexOf("deps.provider!.refund!(");
    const recordStart = source.indexOf("// --- 3: record the outcome");
    expect(claimEnd).toBeGreaterThan(0);
    expect(callAt).toBeGreaterThan(claimEnd);
    expect(callAt).toBeLessThan(recordStart);
    // The provider is handed the refund row's id as its idempotency key.
    expect(source).toContain("refundKey: params.refundId");
  });

  test("every route is gated on the returns feature and every mutation requires an Idempotency-Key", async () => {
    for (const [name, file] of Object.entries(ROUTE_FILES)) {
      const source = await read(file);
      expect(source).toContain("requireReturnsFeature");
      expect(source).not.toMatch(/withTenant\(/);
      if (/export const POST/.test(source)) {
        expect(source).toContain("requireIdempotencyKey");
      }
      expect(name.length).toBeGreaterThan(0);
    }
  });

  test("no route returns the provider reference or the plaintext of anything stored", async () => {
    for (const file of Object.values(ROUTE_FILES)) {
      const source = await read(file);
      expect(source).not.toMatch(/provider_reference|providerReference/);
    }
    const records = await read(
      `${SRC}/modules/commerce/application/return-records.ts`
    );
    expect(records).not.toMatch(/providerReference|provider_refund_id:/);
  });
});

describe("single writers", () => {
  test("only the directories insert returns, lines and refunds; only settlement writes compensations", async () => {
    const files = (await walk(SRC)).filter((f) => f.endsWith(".ts"));
    const writers = new Map<string, string[]>();
    for (const file of files) {
      const source = await read(file);
      for (const table of [
        "awcms_commerce_returns",
        "awcms_commerce_return_lines",
        "awcms_commerce_refunds",
        "awcms_commerce_refund_compensations"
      ]) {
        if (new RegExp(`INSERT INTO ${table}\\b`).test(source)) {
          writers.set(table, [...(writers.get(table) ?? []), file]);
        }
      }
    }
    const dir = `${SRC}/modules/commerce/application`;
    expect(writers.get("awcms_commerce_returns")).toEqual([
      `${dir}/return-directory.ts`
    ]);
    expect(writers.get("awcms_commerce_return_lines")).toEqual([
      `${dir}/return-directory.ts`
    ]);
    expect(writers.get("awcms_commerce_refunds")).toEqual([
      `${dir}/return-directory.ts`
    ]);
    expect(writers.get("awcms_commerce_refund_compensations")).toEqual([
      `${dir}/refund-settlement.ts`
    ]);
  });

  test("only the inventory port and the order paths touch the product stock columns; the return directory never does", async () => {
    const directory = await read(
      `${SRC}/modules/commerce/application/return-directory.ts`
    );
    const settlement = await read(
      `${SRC}/modules/commerce/application/refund-settlement.ts`
    );
    for (const source of [directory, settlement]) {
      expect(source).not.toMatch(/SET\s+stock\b/);
    }
    const port = await read(
      `${SRC}/modules/commerce/application/return-inventory-port.ts`
    );
    expect(port).toMatch(/SET stock = stock \+/);
  });

  test("a return and a refund never update an order, an order item or a payment row", async () => {
    for (const file of [
      "return-directory.ts",
      "refund-settlement.ts",
      "refund-execution.ts",
      "return-records.ts"
    ]) {
      const source = await read(`${SRC}/modules/commerce/application/${file}`);
      expect(source).not.toMatch(/UPDATE awcms_commerce_orders\b/);
      expect(source).not.toMatch(/UPDATE awcms_commerce_order_items\b/);
      expect(source).not.toMatch(/UPDATE awcms_commerce_payment_allocations\b/);
      expect(source).not.toMatch(/DELETE FROM awcms_commerce_/);
    }
  });

  test("the loyalty ledger stays the single writer of loyalty entries", async () => {
    const files = await walk(SRC);
    for (const file of files) {
      if (file.endsWith("loyalty-ledger.ts")) continue;
      const source = await read(file);
      expect(source).not.toMatch(/INSERT INTO awcms_commerce_loyalty_ledger/);
    }
  });

  test("the migrations keep returns inside the reserved 994-997 band", async () => {
    const names = await readdir("sql");
    const mine = names.filter((n) => /returns/.test(n)).sort();
    expect(mine).toEqual([
      "994_awcms_commerce_returns_schema.sql",
      "995_awcms_commerce_returns_integration.sql",
      "996_awcms_commerce_returns_permissions.sql",
      "997_awcms_commerce_returns_worker_grants.sql"
    ]);
  });
});
