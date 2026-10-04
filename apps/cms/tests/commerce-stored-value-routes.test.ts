/**
 * Closed-loop stored value: structure, permission separation and the "the
 * plaintext code is never stored or logged" rules (Issue #288, ADR-0030).
 * Pure - no database, no network. Every assertion reads source or evaluates the
 * real access model; none restates another.
 *
 *   1. ONE writer: only `stored-value-ledger.ts` inserts a ledger row; only the
 *      directory creates an account or a program; the only UPDATE of an
 *      account is the reconcile repair, which the database accepts only for
 *      the exact ledger sums.
 *   2. The seven permissions are declared and each is enforced by exactly the
 *      route meant to need it; a cashier grant (`commerce.pos.create` +
 *      `commerce.payments.create`) gains NONE of them - redeeming is a tender,
 *      not a stored-value permission - and adjusting is separate from issuing.
 *   3. The code never reaches a log, an audit attribute, an event payload, a
 *      response or a stored column: no audit/event attribute block names it, no
 *      stored-value source logs anything, and the screens never use
 *      `innerHTML` or raw SQL.
 *   4. The screen claims exactly the permissions its controls need, honours the
 *      feature flag, and every mutation carries an Idempotency-Key.
 *   5. No cash-out: nothing in the stored-value surface converts value to cash
 *      or moves it between accounts.
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
  COMMERCE_STORED_VALUE_ACTIVITY_CODE,
  COMMERCE_STORED_VALUE_ADJUSTMENTS_ACTIVITY_CODE,
  COMMERCE_STORED_VALUE_PROGRAMS_ACTIVITY_CODE,
  COMMERCE_STORED_VALUE_RECONCILE_ACTIVITY_CODE
} from "../src/modules/commerce/domain/commerce-permissions";

const SRC = "src";

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

// ---------------------------------------------------------------------------
// 1. One writer
// ---------------------------------------------------------------------------

describe("one writer of the stored-value tables", () => {
  test("only stored-value-ledger.ts inserts a ledger row", async () => {
    const writers: string[] = [];
    for (const file of await walk(SRC)) {
      const source = await read(file);
      if (/INSERT\s+INTO\s+awcms_commerce_stored_value_ledger/i.test(source)) {
        writers.push(file);
      }
    }
    expect(writers).toEqual([
      "src/modules/commerce/application/stored-value-ledger.ts"
    ]);
  });

  test("only the directory creates an account or a program", async () => {
    const accountWriters: string[] = [];
    const programWriters: string[] = [];
    for (const file of await walk(SRC)) {
      const source = await read(file);
      if (
        /INSERT\s+INTO\s+awcms_commerce_stored_value_accounts/i.test(source)
      ) {
        accountWriters.push(file);
      }
      if (
        /INSERT\s+INTO\s+awcms_commerce_stored_value_programs/i.test(source)
      ) {
        programWriters.push(file);
      }
    }
    expect(accountWriters).toEqual([
      "src/modules/commerce/application/stored-value-directory.ts"
    ]);
    expect(programWriters).toEqual([
      "src/modules/commerce/application/stored-value-directory.ts"
    ]);
  });

  test("the only UPDATE of an account is the reconcile repair, which sets balance/version from the ledger's own sums under the account lock", async () => {
    const updaters: string[] = [];
    for (const file of await walk(SRC)) {
      const source = await read(file);
      if (/UPDATE\s+awcms_commerce_stored_value_accounts/i.test(source)) {
        updaters.push(file);
      }
    }
    expect(updaters).toEqual([
      "src/modules/commerce/application/stored-value-directory.ts"
    ]);
    const directory = await read(updaters[0]!);
    const update = directory.indexOf(
      "UPDATE awcms_commerce_stored_value_accounts"
    );
    const lock = directory.lastIndexOf("lockStoredValueAccount(", update);
    const sums = directory.lastIndexOf("SUM(amount)", update);
    expect(lock).toBeGreaterThan(-1);
    expect(sums).toBeGreaterThan(lock);
    // No session switch of any kind: the database decides from the ledger.
    expect(directory).not.toMatch(/set_config|rebuild/);
  });

  test("nothing in src deletes from the ledger, and the ledger is never updated", async () => {
    for (const file of await walk(SRC)) {
      const source = await read(file);
      expect(source).not.toMatch(
        /DELETE\s+FROM\s+awcms_commerce_stored_value/i
      );
      expect(source).not.toMatch(
        /UPDATE\s+awcms_commerce_stored_value_ledger/i
      );
    }
  });

  test("the payment ledger writes the mirror entry only through the stored-value ledger's two functions", async () => {
    const allocation = await read(
      "src/modules/commerce/application/payment-allocation-directory.ts"
    );
    expect(allocation).toContain("redeemForAllocation(");
    expect(allocation).toContain("refundForReversal(");
    expect(allocation).not.toMatch(/awcms_commerce_stored_value_ledger/);
  });
});

// ---------------------------------------------------------------------------
// 2. Permissions
// ---------------------------------------------------------------------------

const ROUTES = {
  "stored-value/programs/index.ts": [
    [COMMERCE_STORED_VALUE_PROGRAMS_ACTIVITY_CODE, "read"]
  ],
  "stored-value/programs/[kind].ts": [
    [COMMERCE_STORED_VALUE_PROGRAMS_ACTIVITY_CODE, "update"]
  ],
  "stored-value/accounts/index.ts": [
    [COMMERCE_STORED_VALUE_ACTIVITY_CODE, "read"],
    [COMMERCE_STORED_VALUE_ACTIVITY_CODE, "create"]
  ],
  "stored-value/accounts/[id]/index.ts": [
    [COMMERCE_STORED_VALUE_ACTIVITY_CODE, "read"]
  ],
  "stored-value/accounts/[id]/ledger.ts": [
    [COMMERCE_STORED_VALUE_ACTIVITY_CODE, "read"]
  ],
  "stored-value/accounts/[id]/load.ts": [
    [COMMERCE_STORED_VALUE_ACTIVITY_CODE, "create"]
  ],
  "stored-value/accounts/[id]/adjust.ts": [
    [COMMERCE_STORED_VALUE_ADJUSTMENTS_ACTIVITY_CODE, "create"]
  ],
  "stored-value/accounts/[id]/status.ts": [
    [COMMERCE_STORED_VALUE_ACTIVITY_CODE, "update"]
  ],
  "stored-value/expire.ts": [[COMMERCE_STORED_VALUE_ACTIVITY_CODE, "update"]],
  "stored-value/reconcile.ts": [
    [COMMERCE_STORED_VALUE_ACTIVITY_CODE, "read"],
    // The repair path: checked in the handler, through the same chokepoint.
    [COMMERCE_STORED_VALUE_RECONCILE_ACTIVITY_CODE, "approve"]
  ]
} as const;

const CONSTANT_TO_CODE: Record<string, string> = {
  COMMERCE_STORED_VALUE_PROGRAMS_ACTIVITY_CODE:
    COMMERCE_STORED_VALUE_PROGRAMS_ACTIVITY_CODE,
  COMMERCE_STORED_VALUE_ACTIVITY_CODE: COMMERCE_STORED_VALUE_ACTIVITY_CODE,
  COMMERCE_STORED_VALUE_ADJUSTMENTS_ACTIVITY_CODE:
    COMMERCE_STORED_VALUE_ADJUSTMENTS_ACTIVITY_CODE,
  COMMERCE_STORED_VALUE_RECONCILE_ACTIVITY_CODE:
    COMMERCE_STORED_VALUE_RECONCILE_ACTIVITY_CODE
};

/** Every `activityCode: CONST, action: "x"` guard (or inline literal pair) in a route source. */
function guardsIn(source: string): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(
    /activityCode:\s*(COMMERCE_[A-Z_]+_ACTIVITY_CODE),\s*action:\s*"([a-z_]+)"/g
  )) {
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
  "commerce.stored_value_programs.read",
  "commerce.stored_value_programs.update",
  "commerce.stored_value.read",
  "commerce.stored_value.create",
  "commerce.stored_value.update",
  "commerce.stored_value_adjustments.create",
  "commerce.stored_value_reconcile.approve"
];

describe("stored-value permissions are declared and each is enforced by its route", () => {
  test("the module declares exactly the seven stored-value permissions", () => {
    for (const key of EXPECTED_KEYS) expect(declared.has(key)).toBe(true);
    const keys = [...declared].filter((key) =>
      key.startsWith("commerce.stored_value")
    );
    expect(keys.sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  for (const [file, expected] of Object.entries(ROUTES)) {
    test(`${file} enforces exactly its own guards`, async () => {
      const source = await read(`src/pages/api/v1/commerce/${file}`);
      const wanted = new Set(
        expected.map(([code, action]) => `commerce.${code}.${action}`)
      );
      expect([...guardsIn(source)].sort()).toEqual([...wanted].sort());
    });
  }

  test("the liability report is gated on stored_value.read", async () => {
    const source = await read(
      "src/pages/api/v1/reports/commerce/stored-value.ts"
    );
    expect([...guardsIn(source)]).toEqual(["commerce.stored_value.read"]);
  });

  test("every one of the seven keys is enforced by at least one route", async () => {
    const enforced = new Set<string>();
    for (const file of Object.keys(ROUTES)) {
      for (const key of guardsIn(
        await read(`src/pages/api/v1/commerce/${file}`)
      )) {
        enforced.add(key);
      }
    }
    for (const key of EXPECTED_KEYS) expect(enforced.has(key)).toBe(true);
  });

  test("every route is gated on the tenant's storedValue feature, and every mutation requires an Idempotency-Key (except the naturally idempotent ones)", async () => {
    for (const file of Object.keys(ROUTES)) {
      const source = await read(`src/pages/api/v1/commerce/${file}`);
      expect(source).toContain("requireStoredValueFeature(tx, tenantId)");
    }
    for (const file of [
      "stored-value/accounts/index.ts",
      "stored-value/accounts/[id]/load.ts",
      "stored-value/accounts/[id]/adjust.ts",
      "stored-value/accounts/[id]/status.ts"
    ]) {
      expect(await read(`src/pages/api/v1/commerce/${file}`)).toContain(
        "requireIdempotencyKey(request)"
      );
    }
    // PUT program = same body, same row; the sweep = deterministic source keys.
    for (const file of [
      "stored-value/programs/[kind].ts",
      "stored-value/expire.ts"
    ]) {
      expect(await read(`src/pages/api/v1/commerce/${file}`)).not.toContain(
        "requireIdempotencyKey"
      );
    }
  });

  test("no stored-value route requires a POS or payments permission", async () => {
    for (const file of Object.keys(ROUTES)) {
      const source = await read(`src/pages/api/v1/commerce/${file}`);
      expect(source).not.toContain("COMMERCE_POS_ACTIVITY_CODE");
      expect(source).not.toContain("COMMERCE_PAYMENTS_ACTIVITY_CODE");
    }
  });
});

describe("a cashier grant gains no stored-value authority", () => {
  const CONTEXT: TenantContext = {
    tenantId: "11111111-1111-4111-8111-111111111111",
    tenantUserId: "22222222-2222-4222-8222-222222222222",
    identityId: "33333333-3333-4333-8333-333333333333",
    roles: ["cashier"]
  };
  const CASHIER = new Set([
    "commerce.pos.create",
    "commerce.payments.read",
    "commerce.payments.create"
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

  test("the cashier can take a card as a tender (pos.create / payments.create) but cannot issue, load, adjust, disable, report or reconcile", () => {
    expect(allowed(CASHIER, "pos", "create")).toBe(true);
    expect(allowed(CASHIER, "payments", "create")).toBe(true);
    for (const key of EXPECTED_KEYS) {
      const [, activityCode, action] = key.split(".") as [
        string,
        string,
        AccessAction
      ];
      expect(allowed(CASHIER, activityCode, action)).toBe(false);
    }
  });

  test("issuing is not adjusting: stored_value.create does not grant stored_value_adjustments.create, and neither grants reconcile", () => {
    const issuer = new Set(["commerce.stored_value.create"]);
    expect(allowed(issuer, "stored_value", "create")).toBe(true);
    expect(allowed(issuer, "stored_value_adjustments", "create")).toBe(false);
    expect(allowed(issuer, "stored_value_reconcile", "approve")).toBe(false);
    const adjuster = new Set(["commerce.stored_value_adjustments.create"]);
    expect(allowed(adjuster, "stored_value", "create")).toBe(false);
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

  test("the reconcile repair uses the platform's high-risk verb, so a tenant may author SoD rules against it", () => {
    expect(isHighRiskAction("approve")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. The plaintext code is never stored or logged
// ---------------------------------------------------------------------------

const STORED_VALUE_SOURCES = [
  "src/modules/commerce/domain/stored-value.ts",
  "src/modules/commerce/application/stored-value-ledger.ts",
  "src/modules/commerce/application/stored-value-directory.ts",
  "src/modules/commerce/application/stored-value-tender.ts",
  "src/modules/commerce/application/stored-value-http.ts"
];

describe("the plaintext code is never stored, logged, audited or published", () => {
  test("no stored-value source logs anything (no console, no logger)", async () => {
    for (const file of STORED_VALUE_SOURCES) {
      const source = await read(file);
      expect(source).not.toMatch(/console\.(log|info|warn|error|debug)/);
      expect(source).not.toMatch(/\blogger\b|\blog\.(info|warn|error|debug)/);
    }
  });

  test("no audit-attributes or event-payload block in the stored-value sources names a code", async () => {
    for (const file of [
      ...STORED_VALUE_SOURCES,
      "src/modules/commerce/application/payment-allocation-directory.ts",
      "src/modules/commerce/application/payment-recording.ts",
      "src/modules/commerce/application/pos-directory.ts"
    ]) {
      const source = await read(file);
      for (const match of source.matchAll(
        /(attributes|payload):\s*\{([\s\S]*?)\n\s{2,6}\}/g
      )) {
        const block = match[2]!;
        expect(block).not.toMatch(
          /storedValueCode|normalized|plaintext|\bcode\b/
        );
      }
    }
  });

  test("the code appears in no column the migrations create (only a hash and the last four)", async () => {
    const sql = await read("sql/985_awcms_commerce_stored_value_schema.sql");
    const sql981 = await read(
      "sql/986_awcms_commerce_stored_value_payment_integration.sql"
    );
    const columns = [...sql.matchAll(/^\s{2}([a-z_0-9]+) [a-z]/gm)].map(
      (match) => match[1]!
    );
    expect(columns).toContain("code_hash");
    expect(columns).toContain("code_last4");
    expect(columns).not.toContain("code");
    expect(columns).not.toContain("plaintext_code");
    // The payment-ledger leg refuses to carry a reference alongside the account.
    expect(sql981).toContain(
      "stored_value_account_id IS NULL OR provider_reference IS NULL"
    );
  });

  test("the issue response is the only place a code is returned, and the stored (replayable) body has none", async () => {
    const directory = await read(
      "src/modules/commerce/application/stored-value-directory.ts"
    );
    // The saved idempotency body is built with `code: null`.
    expect(directory).toMatch(
      /const stored: IssueResponseBody = \{[\s\S]*?code: null,[\s\S]*?codeRevealed: false/
    );
    expect(
      directory.match(/code: formatStoredValueCode\(code\)/g)
    ).toHaveLength(1);
  });

  test("the idempotency hash of a tender never contains the plaintext (redactTendersForHash / hashStoredValueCode are what both callers use)", async () => {
    expect(
      await read("src/modules/commerce/application/pos-directory.ts")
    ).toContain("redactTendersForHash(tenantId, input.tenders)");
    const recording = await read(
      "src/modules/commerce/application/payment-recording.ts"
    );
    expect(recording).toContain(
      "hashStoredValueCode(tenantId, input.storedValueCode)"
    );
    expect(recording).not.toMatch(
      /computeRequestHash\(\{[^}]*storedValueCode:/
    );
  });

  test("the screens never use innerHTML or raw SQL, never call window.confirm", async () => {
    for (const page of [
      "src/pages/admin/commerce-stored-value.astro",
      "src/pages/admin/commerce-pos.astro",
      "src/pages/admin/commerce-orders/[id].astro"
    ]) {
      const source = await read(page);
      expect(source).not.toMatch(
        /\b(INSERT\s+INTO|UPDATE\s+awcms_|DELETE\s+FROM)/i
      );
      expect(source).not.toContain("window.confirm");
    }
    expect(
      await read("src/pages/admin/commerce-stored-value.astro")
    ).not.toMatch(/\.innerHTML\s*=/);
  });
});

// ---------------------------------------------------------------------------
// 4. The screen
// ---------------------------------------------------------------------------

const PAGE = "src/pages/admin/commerce-stored-value.astro";

function pageTriplesFrom(source: string): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(
    /moduleKey:\s*"([a-z_]+)",\s*\n?\s*activityCode:\s*"([a-z_]+)",\s*\n?\s*action:\s*"([a-z_]+)"/g
  )) {
    found.add(`${match[1]}.${match[2]}.${match[3]}`);
  }
  return found;
}

describe("the stored-value screen", () => {
  test("claims exactly the permissions its controls need, all declared", async () => {
    const page = await read(PAGE);
    expect([...pageTriplesFrom(page)].sort()).toEqual(
      [...EXPECTED_KEYS].sort()
    );
    for (const key of pageTriplesFrom(page))
      expect(declared.has(key)).toBe(true);
  });

  test("every mutation it posts goes to a guarded endpoint, with an Idempotency-Key where the endpoint requires one", async () => {
    const page = await read(PAGE);
    expect(page).toContain("`${BASE}/accounts`");
    for (const suffix of ["/load", "/adjust", "/status"]) {
      expect(page).toContain("`${base}" + suffix + "`");
    }
    expect(page).toContain("`${BASE}/programs/");
    expect(page).toContain("`${BASE}/expire`");
    expect(page).toContain("`${BASE}/reconcile`");
    expect(page).toContain('"Idempotency-Key"');
  });

  test("honours the feature flag, reads through the directory, and has no cash-out control", async () => {
    const page = await read(PAGE);
    expect(page).toContain("fetchCommerceFeatures(");
    expect(page).toContain("features.storedValue");
    expect(page).toContain("listStoredValueAccounts(");
    expect(page).toContain("fetchStoredValueReport(");
    // Comments aside (the header says the loop is closed), no control or label.
    const code = page.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/cash.?out|withdraw|transfer to|convert/i);
  });

  test("the sidebar entry points at the screen, is gated on account read, and requires the storedValue feature", () => {
    const nav = listModules()
      .find((module) => module.key === "commerce")
      ?.navigation?.find(
        (entry) => entry.path === "/admin/commerce-stored-value"
      );
    expect(nav).toBeDefined();
    expect(nav!.requiredPermission).toBe("commerce.stored_value.read");
    expect(declared.has(nav!.requiredPermission as string)).toBe(true);
    expect(nav!.requiredFeature).toEqual({
      moduleKey: "commerce",
      feature: "storedValue"
    });
  });

  test("the POS and order screens offer the card tenders only behind the feature, and send the code once", async () => {
    const pos = await read("src/pages/admin/commerce-pos.astro");
    expect(pos).toContain("storedValueEnabled");
    expect(pos).toContain("storedValueCode");
    for (const code of [
      "STORED_VALUE_NOT_FOUND",
      "STORED_VALUE_UNAVAILABLE",
      "STORED_VALUE_INSUFFICIENT",
      "STORED_VALUE_LOOKUP_THROTTLED"
    ]) {
      expect(pos).toContain(code);
    }
    const order = await read("src/pages/admin/commerce-orders/[id].astro");
    expect(order).toContain("storedValueEnabled");
    expect(order).toContain("storedValueCode");
  });

  test("the POS route maps every stored-value refusal through the one shared mapper", async () => {
    const route = await read("src/pages/api/v1/commerce/pos/orders/index.ts");
    expect(route).toContain("storedValueTenderErrorResponse(error)");
    const payments = await read(
      "src/pages/api/v1/commerce/orders/[id]/payments/index.ts"
    );
    expect(payments).toContain("storedValueTenderErrorResponse(error)");
    const mapper = await read(
      "src/modules/commerce/application/stored-value-http.ts"
    );
    for (const code of [
      "STORED_VALUE_NOT_FOUND",
      "STORED_VALUE_UNAVAILABLE",
      "STORED_VALUE_INSUFFICIENT",
      "STORED_VALUE_LOOKUP_THROTTLED"
    ]) {
      expect(mapper).toContain(`"${code}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Closed loop
// ---------------------------------------------------------------------------

describe("the loop is closed: no cash-out and no transfer between accounts", () => {
  test("no ledger kind, tender, route or permission models a withdrawal or a transfer", async () => {
    const domain = await read("src/modules/commerce/domain/stored-value.ts");
    const kinds = domain.match(
      /STORED_VALUE_ENTRY_KINDS = \[([\s\S]*?)\] as const/
    )![1]!;
    expect(kinds).not.toMatch(/withdraw|cash_out|cashout|transfer|payout/i);
    for (const key of declared) {
      if (key.startsWith("commerce.stored_value")) {
        expect(key).not.toMatch(/withdraw|cash|transfer|payout/i);
      }
    }
    const routeNames = Object.keys(ROUTES).join(" ");
    expect(routeNames).not.toMatch(/withdraw|cash|transfer|payout|convert/i);
    // Comments aside (the header says the loop is closed), no identifier.
    const schema = (
      await read("sql/985_awcms_commerce_stored_value_schema.sql")
    )
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(schema).not.toMatch(/cash_out|withdraw|payout/i);
  });

  test("a refund goes back to the account the value came from and nowhere else (the reversal copies the payment's account)", async () => {
    const allocation = await read(
      "src/modules/commerce/application/payment-allocation-directory.ts"
    );
    expect(allocation).toContain("original.storedValue?.accountId");
    expect(allocation).toContain("refundForReversal(");
  });
});
