/**
 * Commerce document permission separation (Issue #286, ADR-0029). Pure - no
 * database. The rule: holding a cart, quoting, converting a quote into an order,
 * running a work order and issuing a legal document are five different
 * authorities, and ringing up a sale (`commerce.pos.create`) gives none of
 * them. Proved the same three ways `commerce-register-permissions.test.ts`
 * proves its own: the keys are declared and each is enforced by exactly the
 * route that is meant to need it (read from the route SOURCE); a REAL access
 * evaluation of cashier-shaped grants; and the high-risk classification of the
 * supervisor override.
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
  COMMERCE_DOCUMENTS_ACTIVITY_CODE,
  COMMERCE_HELD_SALES_ACTIVITY_CODE,
  COMMERCE_POS_DUE_ACTIVITY_CODE,
  COMMERCE_QUOTATION_CONVERSIONS_ACTIVITY_CODE,
  COMMERCE_QUOTATIONS_ACTIVITY_CODE,
  COMMERCE_WORK_ORDERS_ACTIVITY_CODE
} from "../src/modules/commerce/domain/commerce-permissions";

const ROUTES = {
  "held-sales/index.ts": [
    [COMMERCE_HELD_SALES_ACTIVITY_CODE, "read"],
    [COMMERCE_HELD_SALES_ACTIVITY_CODE, "create"]
  ],
  "held-sales/[id]/resume.ts": [[COMMERCE_HELD_SALES_ACTIVITY_CODE, "update"]],
  "held-sales/[id]/discard.ts": [[COMMERCE_HELD_SALES_ACTIVITY_CODE, "update"]],
  "quotations/index.ts": [
    [COMMERCE_QUOTATIONS_ACTIVITY_CODE, "read"],
    [COMMERCE_QUOTATIONS_ACTIVITY_CODE, "create"]
  ],
  "quotations/[id]/index.ts": [[COMMERCE_QUOTATIONS_ACTIVITY_CODE, "read"]],
  "quotations/[id]/versions.ts": [
    [COMMERCE_QUOTATIONS_ACTIVITY_CODE, "create"]
  ],
  "quotations/[id]/actions/[action].ts": [
    [COMMERCE_QUOTATIONS_ACTIVITY_CODE, "update"]
  ],
  "quotations/[id]/convert.ts": [
    [COMMERCE_QUOTATION_CONVERSIONS_ACTIVITY_CODE, "create"],
    // A conversion leaves the order with a balance due: the credit-sale key.
    [COMMERCE_POS_DUE_ACTIVITY_CODE, "create"]
  ],
  "work-orders/index.ts": [
    [COMMERCE_WORK_ORDERS_ACTIVITY_CODE, "read"],
    [COMMERCE_WORK_ORDERS_ACTIVITY_CODE, "create"]
  ],
  "work-orders/[id].ts": [
    [COMMERCE_WORK_ORDERS_ACTIVITY_CODE, "read"],
    [COMMERCE_WORK_ORDERS_ACTIVITY_CODE, "update"]
  ],
  "documents/index.ts": [
    [COMMERCE_DOCUMENTS_ACTIVITY_CODE, "read"],
    [COMMERCE_DOCUMENTS_ACTIVITY_CODE, "create"]
  ],
  "documents/[id]/index.ts": [[COMMERCE_DOCUMENTS_ACTIVITY_CODE, "read"]],
  "documents/[id]/render.ts": [[COMMERCE_DOCUMENTS_ACTIVITY_CODE, "read"]]
} as const;

const CONSTANT_TO_CODE: Record<string, string> = {
  COMMERCE_HELD_SALES_ACTIVITY_CODE,
  COMMERCE_QUOTATIONS_ACTIVITY_CODE,
  COMMERCE_QUOTATION_CONVERSIONS_ACTIVITY_CODE,
  COMMERCE_WORK_ORDERS_ACTIVITY_CODE,
  COMMERCE_DOCUMENTS_ACTIVITY_CODE,
  COMMERCE_POS_DUE_ACTIVITY_CODE
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
  "commerce.held_sales.read",
  "commerce.held_sales.create",
  "commerce.held_sales.update",
  "commerce.held_sales.approve",
  "commerce.quotations.read",
  "commerce.quotations.create",
  "commerce.quotations.update",
  "commerce.quotation_conversions.create",
  "commerce.work_orders.read",
  "commerce.work_orders.create",
  "commerce.work_orders.update",
  "commerce.documents.read",
  "commerce.documents.create"
];

/** The held-sale supervisor override is checked lazily, in `documents-http.ts`. */
const SUPERVISOR_GUARD_FILE =
  "src/modules/commerce/application/documents-http.ts";

describe("document permissions are declared and each is enforced by its route", () => {
  test("the module declares exactly the thirteen document permissions", () => {
    for (const key of EXPECTED_KEYS) expect(declared.has(key)).toBe(true);
    const mine = [...declared].filter((key) =>
      /^commerce\.(held_sales|quotations|quotation_conversions|work_orders|documents)\./.test(
        key
      )
    );
    expect(mine.sort()).toEqual([...EXPECTED_KEYS].sort());
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

  test("every key but the supervisor override is enforced by a route's primary guard; the override by the shared lazy check", async () => {
    const enforced = new Set<string>();
    for (const file of Object.keys(ROUTES)) {
      const source = await readFile(
        `src/pages/api/v1/commerce/${file}`,
        "utf8"
      );
      for (const key of guardsIn(source)) enforced.add(key);
    }
    const missing = EXPECTED_KEYS.filter((key) => !enforced.has(key));
    expect(missing).toEqual(["commerce.held_sales.approve"]);
    const shared = await readFile(SUPERVISOR_GUARD_FILE, "utf8");
    expect(shared).toContain('action: "approve"');
    expect(shared).toContain("COMMERCE_HELD_SALES_ACTIVITY_CODE");
    // ... and the list route asks for it only when `scope=all` is requested.
    const list = await readFile(
      "src/pages/api/v1/commerce/held-sales/index.ts",
      "utf8"
    );
    expect(list).toContain("HELD_SALE_APPROVE_GUARD");
  });

  test("no document route requires commerce.pos.create - ringing up a sale grants none of them", async () => {
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
      "held-sales/index.ts",
      "held-sales/[id]/resume.ts",
      "held-sales/[id]/discard.ts",
      "quotations/index.ts",
      "quotations/[id]/versions.ts",
      "quotations/[id]/actions/[action].ts",
      "quotations/[id]/convert.ts",
      "work-orders/index.ts",
      "work-orders/[id].ts",
      "documents/index.ts"
    ]) {
      const source = await readFile(
        `src/pages/api/v1/commerce/${file}`,
        "utf8"
      );
      expect(source).toContain("requireIdempotencyKey(request)");
    }
  });

  test("every route is gated on the tenant's documents feature", async () => {
    for (const file of Object.keys(ROUTES)) {
      const source = await readFile(
        `src/pages/api/v1/commerce/${file}`,
        "utf8"
      );
      expect(source).toContain("requireDocumentsFeature(tx, tenantId)");
    }
  });

  test("a returned failure never follows a number allocation (allocate last)", async () => {
    // The allocation call sites: each is followed only by inserts, audit and
    // the idempotency write - never by a `return fail(` / `return { kind:`.
    for (const file of [
      "src/modules/commerce/application/quotation-directory.ts",
      "src/modules/commerce/application/work-order-directory.ts",
      "src/modules/commerce/application/document-directory.ts"
    ]) {
      const source = await readFile(file, "utf8");
      const at = source.indexOf("await allocateDocumentNumber(");
      expect(at).toBeGreaterThan(0);
      const rest = source.slice(at);
      const untilNextExport = rest.split(
        /\n(?:export )?(?:async )?function /
      )[0]!;
      const afterAllocation = untilNextExport.slice(
        untilNextExport.indexOf("\n")
      );
      // The only `return` statements after the allocation are the success ones.
      const returns = [
        ...afterAllocation.matchAll(/return \{ kind: "([a-z_]+)"/g)
      ].map((match) => match[1]);
      for (const kind of returns) {
        expect(["created", "issued"]).toContain(kind!);
      }
    }
  });
});

describe("cashier grants gain no quotation, conversion, work-order or document authority", () => {
  const CONTEXT: TenantContext = {
    tenantId: "11111111-1111-4111-8111-111111111111",
    tenantUserId: "22222222-2222-4222-8222-222222222222",
    identityId: "33333333-3333-4333-8333-333333333333",
    roles: ["cashier"]
  };

  /** Park, list and resume your own carts - and nothing else. */
  const CASHIER = new Set([
    "commerce.pos.create",
    "commerce.held_sales.read",
    "commerce.held_sales.create",
    "commerce.held_sales.update"
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

  test("the cashier can park, list and resume, and cannot touch another cashier's cart", () => {
    expect(allowed(CASHIER, "held_sales", "read")).toBe(true);
    expect(allowed(CASHIER, "held_sales", "create")).toBe(true);
    expect(allowed(CASHIER, "held_sales", "update")).toBe(true);
    expect(allowed(CASHIER, "held_sales", "approve")).toBe(false);
  });

  test("the cashier cannot quote, convert, run work orders or issue documents", () => {
    for (const [code, action] of [
      ["quotations", "read"],
      ["quotations", "create"],
      ["quotations", "update"],
      ["quotation_conversions", "create"],
      ["work_orders", "read"],
      ["work_orders", "create"],
      ["work_orders", "update"],
      ["documents", "read"],
      ["documents", "create"]
    ] as const) {
      expect(allowed(CASHIER, code, action)).toBe(false);
    }
  });

  test("holding commerce.pos.create ALONE grants no document permission at all", () => {
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

  test("converting needs BOTH the conversion key and the credit-sale key", () => {
    const onlyConversion = new Set(["commerce.quotation_conversions.create"]);
    expect(allowed(onlyConversion, "quotation_conversions", "create")).toBe(
      true
    );
    expect(
      allowed(onlyConversion, COMMERCE_POS_DUE_ACTIVITY_CODE, "create")
    ).toBe(false);
    const onlyDue = new Set(["commerce.pos_due.create"]);
    expect(allowed(onlyDue, "quotation_conversions", "create")).toBe(false);
  });

  test("each permission is its own key: granting one does not grant a neighbour", () => {
    for (const key of EXPECTED_KEYS) {
      const only = new Set([key]);
      for (const other of EXPECTED_KEYS) {
        const [, otherCode, otherAction] = other.split(".") as [
          string,
          string,
          AccessAction
        ];
        expect(allowed(only, otherCode, otherAction)).toBe(other === key);
      }
    }
  });

  test("approve is the platform's high-risk verb, so a tenant may author SoD rules against the supervisor override", () => {
    expect(isHighRiskAction("approve")).toBe(true);
  });
});
