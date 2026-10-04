/**
 * POS operational reports through the REAL route handlers (Issue #296,
 * ADR-0035) - the HTTP half that `commerce-operational-reports.integration
 * .test.ts` (which drives the projection engine and the read functions)
 * cannot see: route wiring (`defineTenantRoute`, ABAC, the range validator,
 * the feature gate, CSV neutralisation, the export audit) with real session and
 * permission machinery behind it.
 *
 * WORLD 2 (see `harness.ts`): handlers call `getDatabaseClient()` internally,
 * so this file runs against the migrated `DATABASE_URL` database and seeds
 * through `getHandlerAdminSql()`. The projection tables are seeded directly -
 * this file is about who may read them and what comes back, not how they are
 * filled. The owner comes from the real setup + login endpoints; every other
 * principal is seeded with EXACTLY the permission keys under test, so a 403
 * below means "that key was missing", never "the actor had nothing".
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import {
  createCookieJar,
  ensureHandlerDatabaseReady,
  getHandlerAdminSql,
  integrationEnabled,
  invoke,
  resetHandlerDatabase,
  teardownHandlerDatabase
} from "./harness";
import { hashSessionToken } from "../../src/lib/auth/session-token";
import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { PATCH as patchModuleSettings } from "../../src/pages/api/v1/tenant/modules/[moduleKey]/settings";
import { GET as tendersJson } from "../../src/pages/api/v1/reports/commerce/operational-tenders";
import { GET as tendersCsv } from "../../src/pages/api/v1/reports/commerce/operational-tenders.csv";
import { GET as cashUpsJson } from "../../src/pages/api/v1/reports/commerce/operational-cash-ups";
import { GET as cashUpsCsv } from "../../src/pages/api/v1/reports/commerce/operational-cash-ups.csv";
import { GET as expensesJson } from "../../src/pages/api/v1/reports/commerce/operational-expenses";
import { GET as expensesCsv } from "../../src/pages/api/v1/reports/commerce/operational-expenses.csv";
import { GET as loyaltyJson } from "../../src/pages/api/v1/reports/commerce/operational-loyalty";
import { GET as loyaltyCsv } from "../../src/pages/api/v1/reports/commerce/operational-loyalty.csv";
import { GET as storedValueJson } from "../../src/pages/api/v1/reports/commerce/operational-stored-value";
import { GET as storedValueCsv } from "../../src/pages/api/v1/reports/commerce/operational-stored-value.csv";
import { GET as returnsJson } from "../../src/pages/api/v1/reports/commerce/operational-returns";
import { GET as returnsCsv } from "../../src/pages/api/v1/reports/commerce/operational-returns.csv";

const OWNER_PASSWORD = "integration-test-owner-password";
const RANGE = "?from=2026-09-01&to=2026-09-30";

type Principal = { tenantId: string; token: string; tenantUserId: string };

async function bootstrapOwner(): Promise<Principal> {
  const loginIdentifier = "owner@example.com";
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName: "Acme",
      tenantCode: "acme",
      officeCode: "hq",
      officeName: "HQ",
      ownerLoginIdentifier: loginIdentifier,
      ownerPassword: OWNER_PASSWORD,
      ownerDisplayName: "Owner"
    }
  });
  expect(setup.status).toBe(200);
  const tenantId = setup.body.data.tenantId;

  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-tenant-id": tenantId
    },
    body: { loginIdentifier, password: OWNER_PASSWORD },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);

  const rows = (await getHandlerAdminSql()`
    SELECT tu.id FROM awcms_tenant_users tu
    JOIN awcms_identities i ON i.id = tu.identity_id
    WHERE tu.tenant_id = ${tenantId} AND i.login_identifier = ${loginIdentifier}
  `) as { id: string }[];
  return { tenantId, token: login.body.data.token, tenantUserId: rows[0]!.id };
}

/** A tenant user holding ONLY the given permission keys, with a live session. */
async function seedPrincipal(
  tenantId: string,
  label: string,
  perms: string[]
): Promise<Principal> {
  const admin = getHandlerAdminSql();
  const profile = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', ${`Profile ${label}`})
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`${label}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  const tenantUser = (await admin`
    INSERT INTO awcms_tenant_users (tenant_id, identity_id)
    VALUES (${tenantId}, ${identity[0]!.id})
    RETURNING id
  `) as { id: string }[];
  const role = (await admin`
    INSERT INTO awcms_roles (tenant_id, role_code, role_name)
    VALUES (${tenantId}, ${label}, ${label})
    RETURNING id
  `) as { id: string }[];
  for (const key of perms) {
    const [moduleKey, activityCode, action] = key.split(".");
    const permission = (await admin`
      SELECT id FROM awcms_permissions
      WHERE module_key = ${moduleKey!} AND activity_code = ${activityCode!} AND action = ${action!}
    `) as { id: string }[];
    if (!permission[0]) throw new Error(`permission ${key} is not seeded`);
    await admin`
      INSERT INTO awcms_role_permissions (tenant_id, role_id, permission_id)
      VALUES (${tenantId}, ${role[0]!.id}, ${permission[0].id})
    `;
  }
  await admin`
    INSERT INTO awcms_access_policies (tenant_id, tenant_user_id, role_id, scope_type, scope_id)
    VALUES (${tenantId}, ${tenantUser[0]!.id}, ${role[0]!.id}, 'tenant', ${tenantId})
  `;
  const token = `it-token-${label}-${Date.now()}`;
  await admin`
    INSERT INTO awcms_sessions (tenant_id, identity_id, token_hash, expires_at)
    VALUES (${tenantId}, ${identity[0]!.id}, ${hashSessionToken(token)}, ${new Date(Date.now() + 3_600_000)})
  `;
  return { tenantId, token, tenantUserId: tenantUser[0]!.id };
}

function headers(
  who: Principal,
  tenantId = who.tenantId
): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-tenant-id": tenantId,
    authorization: `Bearer ${who.token}`
  };
}

type Envelope<T = unknown> = {
  success: boolean;
  data: T;
  error?: { code: string; details?: unknown };
};

type Report = {
  enabled: boolean;
  items: Record<string, unknown>[];
} & Record<string, unknown>;

const JSON_ROUTES = [
  ["tenders", tendersJson, "operational-tenders"],
  ["cash-ups", cashUpsJson, "operational-cash-ups"],
  ["expenses", expensesJson, "operational-expenses"],
  ["loyalty", loyaltyJson, "operational-loyalty"],
  ["stored-value", storedValueJson, "operational-stored-value"],
  ["returns", returnsJson, "operational-returns"]
] as const;

const CSV_ROUTES = [
  ["tenders", tendersCsv, "operational-tenders"],
  ["cash-ups", cashUpsCsv, "operational-cash-ups"],
  ["expenses", expensesCsv, "operational-expenses"],
  ["loyalty", loyaltyCsv, "operational-loyalty"],
  ["stored-value", storedValueCsv, "operational-stored-value"],
  ["returns", returnsCsv, "operational-returns"]
] as const;

const FAMILY_KEYS = {
  tenders: "report_tenders",
  "cash-ups": "report_cash_ups",
  expenses: "report_expenses",
  loyalty: "report_loyalty",
  "stored-value": "report_stored_value",
  returns: "report_returns"
} as const;

/** Rows in the five projection tables, with one value per tenant that tells them apart. */
async function seedProjectionRows(
  tenantId: string,
  scale: number
): Promise<void> {
  const admin = getHandlerAdminSql();
  const register = (await admin`
    INSERT INTO awcms_commerce_registers (tenant_id, code, name)
    VALUES (${tenantId}, 'R1', 'Front till')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_commerce_report_tender_daily
      (tenant_id, day, register_id, tender_type, payment_count, payments)
    VALUES (${tenantId}, '2026-09-10', ${register[0]!.id}, 'cash', ${scale},
      ${(scale * 1000).toFixed(2)})
  `;
  await admin`
    INSERT INTO awcms_commerce_report_cash_up_tenders
      (tenant_id, session_id, tender_type, register_id, cashier_tenant_user_id, day,
       line_count, expected, counted)
    VALUES (${tenantId}, gen_random_uuid(), 'cash', ${register[0]!.id}, gen_random_uuid(),
      '2026-09-10', 1, ${(scale * 1000).toFixed(2)}, ${(scale * 900).toFixed(2)})
  `;
  await admin`
    INSERT INTO awcms_commerce_report_expense_daily
      (tenant_id, day, category_id, tender_type, category_name, posted_count, posted)
    VALUES (${tenantId}, '2026-09-10', gen_random_uuid(), 'cash',
      '=cmd|''/C calc''!A0', ${scale}, ${(scale * 10).toFixed(2)})
  `;
  await admin`
    INSERT INTO awcms_commerce_report_loyalty_daily (tenant_id, day, bucket, entries, points)
    VALUES (${tenantId}, '2026-09-10', 'earn', ${scale}, ${scale * 10})
  `;
  await admin`
    INSERT INTO awcms_commerce_report_stored_value_daily
      (tenant_id, day, account_kind, bucket, entries, amount)
    VALUES (${tenantId}, '2026-09-10', 'gift_card', 'issue', ${scale},
      ${(scale * 500).toFixed(2)})
  `;
  // Issue #316 - the register name is tenant-typed, so the CSV must neutralise it.
  const named = (await admin`
    INSERT INTO awcms_commerce_registers (tenant_id, code, name)
    VALUES (${tenantId}, 'R2', '=cmd|''/C calc''!A0')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_commerce_report_returns_daily
      (tenant_id, day, register_id, section, bucket, detail, entry_count, units, amount)
    VALUES (${tenantId}, '2026-09-10', ${named[0]!.id}, 'refund', 'cash',
      'original_tender', ${scale}, 0, ${(scale * 250).toFixed(2)})
  `;
}

async function setAllFeatures(owner: Principal, on: boolean) {
  return invoke<Envelope>(patchModuleSettings, {
    method: "PATCH",
    path: "/api/v1/tenant/modules/commerce/settings",
    headers: headers(owner),
    params: { moduleKey: "commerce" },
    body: {
      features: {
        pos: true,
        inbox: true,
        campaigns: true,
        gateway: true,
        courier: true,
        register: on,
        expenses: on,
        loyalty: on,
        storedValue: on,
        returns: on
      }
    }
  });
}

const suite = integrationEnabled ? describe : describe.skip;

let handlerReady = false;

function skipUnlessHandlerReady(): boolean {
  if (handlerReady) return false;
  console.warn(
    "[skip] handler database is not migrated - run 'bun run db:migrate' against DATABASE_URL."
  );
  return true;
}

suite("POS operational reports through the route handlers (Issue #296)", () => {
  beforeAll(async () => {
    handlerReady = await ensureHandlerDatabaseReady();
  });

  afterAll(async () => {
    await teardownHandlerDatabase();
  });

  beforeEach(async () => {
    if (!handlerReady) return;
    await resetHandlerDatabase();
  });

  test("the owner reads all six families; a family whose feature is off is 200 enabled=false and empty, never an error", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await seedProjectionRows(owner.tenantId, 3);

    // Features default OFF for register/expenses/loyalty/storedValue.
    for (const [family, handler, path] of JSON_ROUTES) {
      const result = await invoke<Envelope<Report>>(handler, {
        path: `/api/v1/reports/commerce/${path}${RANGE}`,
        headers: headers(owner)
      });
      expect(result.status).toBe(200);
      if (family === "tenders") {
        expect(result.body.data.enabled).toBe(true);
        expect(result.body.data.items).toHaveLength(1);
      } else {
        expect(result.body.data.enabled).toBe(false);
        expect(result.body.data.items).toEqual([]);
      }
    }

    expect((await setAllFeatures(owner, true)).status).toBe(200);
    for (const [, handler, path] of JSON_ROUTES) {
      const result = await invoke<Envelope<Report>>(handler, {
        path: `/api/v1/reports/commerce/${path}${RANGE}`,
        headers: headers(owner)
      });
      expect(result.status).toBe(200);
      expect(result.body.data.enabled).toBe(true);
      expect(result.body.data.items).toHaveLength(1);
    }

    // Switching a feature back off hides the family again; the rows stay.
    expect((await setAllFeatures(owner, false)).status).toBe(200);
    const hidden = await invoke<Envelope<Report>>(loyaltyJson, {
      path: `/api/v1/reports/commerce/operational-loyalty${RANGE}`,
      headers: headers(owner)
    });
    expect(hidden.body.data.enabled).toBe(false);
  });

  test("a principal holds exactly the report it was given: every other family and every export is 403", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await seedProjectionRows(owner.tenantId, 2);
    expect((await setAllFeatures(owner, true)).status).toBe(200);

    for (const [family, key] of Object.entries(FAMILY_KEYS)) {
      const reader = await seedPrincipal(owner.tenantId, `reader-${family}`, [
        `commerce.${key}.read`
      ]);
      for (const [otherFamily, handler, path] of JSON_ROUTES) {
        const result = await invoke<Envelope>(handler, {
          path: `/api/v1/reports/commerce/${path}${RANGE}`,
          headers: headers(reader)
        });
        expect(result.status).toBe(otherFamily === family ? 200 : 403);
      }
      for (const [, handler, path] of CSV_ROUTES) {
        const result = await invoke<Envelope>(handler, {
          path: `/api/v1/reports/commerce/${path}.csv${RANGE}`,
          headers: headers(reader)
        });
        // Reading is not exporting, for any family.
        expect(result.status).toBe(403);
      }
    }
  });

  test("the dashboard permission and every source-domain permission open none of the reports", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await seedProjectionRows(owner.tenantId, 2);
    expect((await setAllFeatures(owner, true)).status).toBe(200);
    const bystander = await seedPrincipal(owner.tenantId, "bystander", [
      "reporting.dashboard.read",
      "commerce.payments.read",
      "commerce.expenses.read",
      "commerce.expenses.export",
      "commerce.register_sessions.read",
      "commerce.register_sessions.export",
      "commerce.stored_value.read",
      "commerce.loyalty.read",
      "commerce.returns.read",
      "commerce.refunds.read"
    ]);
    for (const [, handler, path] of JSON_ROUTES) {
      const result = await invoke<Envelope>(handler, {
        path: `/api/v1/reports/commerce/${path}${RANGE}`,
        headers: headers(bystander)
      });
      expect(result.status).toBe(403);
    }
    for (const [, handler, path] of CSV_ROUTES) {
      const result = await invoke<Envelope>(handler, {
        path: `/api/v1/reports/commerce/${path}.csv${RANGE}`,
        headers: headers(bystander)
      });
      expect(result.status).toBe(403);
    }
  });

  test("an unauthenticated call is 401 and a missing tenant header is 400", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    const anonymous = await invoke<Envelope>(tendersJson, {
      path: `/api/v1/reports/commerce/operational-tenders${RANGE}`,
      headers: { "x-awcms-tenant-id": owner.tenantId }
    });
    expect(anonymous.status).toBe(401);
    const noTenant = await invoke<Envelope>(tendersJson, {
      path: `/api/v1/reports/commerce/operational-tenders${RANGE}`,
      headers: { authorization: `Bearer ${owner.token}` }
    });
    expect(noTenant.status).toBe(400);
  });

  test("a malformed or oversized range is 400 VALIDATION_ERROR only AFTER the permission check", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    const nobody = await seedPrincipal(owner.tenantId, "nobody", []);
    for (const query of [
      "?from=2026-02-30&to=2026-03-01",
      "?from=2026-09-30&to=2026-09-01",
      "?from=2025-01-01&to=2026-12-31",
      "?from=yesterday"
    ]) {
      const allowed = await invoke<Envelope>(tendersJson, {
        path: `/api/v1/reports/commerce/operational-tenders${query}`,
        headers: headers(owner)
      });
      expect(allowed.status).toBe(400);
      expect(allowed.body.error?.code).toBe("VALIDATION_ERROR");
      // A caller with no permission learns nothing about the range schema.
      const denied = await invoke<Envelope>(tendersJson, {
        path: `/api/v1/reports/commerce/operational-tenders${query}`,
        headers: headers(nobody)
      });
      expect(denied.status).toBe(403);
    }
  });

  test("BOLA: tenant A's principal cannot read tenant B's rows, by header or by id, and each tenant sees only its own figures", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    const tenantB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await getHandlerAdminSql()`
      INSERT INTO awcms_tenants
        (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
      VALUES (${tenantB}, 'tenant-b', 'B', 'B Legal', 'active', 'en', 'light')
    `;
    await seedProjectionRows(owner.tenantId, 3);
    await seedProjectionRows(tenantB, 7);

    // A's token with B's header: refused, nothing of B's comes back.
    const crossed = await invoke<Envelope>(tendersJson, {
      path: `/api/v1/reports/commerce/operational-tenders${RANGE}`,
      headers: headers(owner, tenantB)
    });
    expect([401, 403]).toContain(crossed.status);
    expect(JSON.stringify(crossed.body)).not.toContain("7000.00");

    // A's own read carries only A's figure (3 x 1000.00), never B's.
    const own = await invoke<Envelope<Report>>(tendersJson, {
      path: `/api/v1/reports/commerce/operational-tenders${RANGE}`,
      headers: headers(owner)
    });
    expect(own.status).toBe(200);
    expect(own.body.data.totalPayments).toBe("3000.00");
    expect(JSON.stringify(own.body)).not.toContain("7000.00");

    // The CSV is bound the same way.
    const csv = await tendersCsv({
      request: new Request(
        `http://integration.test/api/v1/reports/commerce/operational-tenders.csv${RANGE}`,
        { headers: headers(owner, tenantB) }
      ),
      url: new URL(
        `http://integration.test/api/v1/reports/commerce/operational-tenders.csv${RANGE}`
      ),
      params: {},
      locals: {},
      cookies: createCookieJar(),
      clientAddress: "127.0.0.1"
    } as never);
    expect([401, 403]).toContain(csv.status);
    expect(await csv.text()).not.toContain("7000.00");
  });

  test("the CSV export: needs the export key, neutralises a formula-shaped name, is no-store, and is audited without cell data", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await seedProjectionRows(owner.tenantId, 2);
    expect((await setAllFeatures(owner, true)).status).toBe(200);

    const exporter = await seedPrincipal(owner.tenantId, "exporter", [
      "commerce.report_expenses.export"
    ]);
    const result = await expensesCsv({
      request: new Request(
        `http://integration.test/api/v1/reports/commerce/operational-expenses.csv${RANGE}`,
        { headers: headers(exporter) }
      ),
      url: new URL(
        `http://integration.test/api/v1/reports/commerce/operational-expenses.csv${RANGE}`
      ),
      params: {},
      locals: { correlationId: "corr-296" },
      cookies: createCookieJar(),
      clientAddress: "127.0.0.1"
    } as never);
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("text/csv");
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("content-disposition")).toContain(
      "pos-expenses-2026-09-01-2026-09-30.csv"
    );
    const body = await result.text();
    const lines = body.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "day,category_name,tender_type,posted_count,posted,reversed_count,reversed,net"
    );
    // The category name started with `=`: a spreadsheet must see text.
    expect(lines[1]).toBe(
      "2026-09-10,'=cmd|'/C calc'!A0,cash,2,20.00,0,0.00,20.00"
    );
    expect(lines[1]!.split(",")[1]!.startsWith("'=")).toBe(true);

    const audit = (await getHandlerAdminSql()`
      SELECT actor_tenant_user_id, resource_type, message, attributes
      FROM awcms_audit_events
      WHERE tenant_id = ${owner.tenantId} AND action = 'operational_report.export'
    `) as {
      actor_tenant_user_id: string;
      resource_type: string;
      message: string;
      attributes: Record<string, unknown>;
    }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_tenant_user_id).toBe(exporter.tenantUserId);
    expect(audit[0]!.attributes).toMatchObject({
      family: "expenses",
      from: "2026-09-01",
      to: "2026-09-30",
      rowCount: 1
    });
    // The audit row carries counts and the range - never a cell.
    expect(JSON.stringify(audit[0])).not.toContain("calc");
  });

  test("the returns CSV (Issue #316): needs report_returns.export, is one long file, neutralises the register name and is audited", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await seedProjectionRows(owner.tenantId, 2);
    expect((await setAllFeatures(owner, true)).status).toBe(200);

    const reader = await seedPrincipal(owner.tenantId, "returns-reader", [
      "commerce.report_returns.read"
    ]);
    const call = (who: Principal) =>
      returnsCsv({
        request: new Request(
          `http://integration.test/api/v1/reports/commerce/operational-returns.csv${RANGE}`,
          { headers: headers(who) }
        ),
        url: new URL(
          `http://integration.test/api/v1/reports/commerce/operational-returns.csv${RANGE}`
        ),
        params: {},
        locals: { correlationId: "corr-316" },
        cookies: createCookieJar(),
        clientAddress: "127.0.0.1"
      } as never);
    expect((await call(reader)).status).toBe(403);

    const exporter = await seedPrincipal(owner.tenantId, "returns-exporter", [
      "commerce.report_returns.export"
    ]);
    const result = await call(exporter);
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("content-disposition")).toContain(
      "pos-returns-2026-09-01-2026-09-30.csv"
    );
    const lines = (await result.text()).trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "day,register_code,register_name,section,bucket,detail,count,units,amount"
    );
    expect(lines[1]).toBe(
      "2026-09-10,R2,'=cmd|'/C calc'!A0,refund,cash,original_tender,2,0,500.00"
    );
    const audit = (await getHandlerAdminSql()`
      SELECT actor_tenant_user_id, attributes FROM awcms_audit_events
      WHERE tenant_id = ${owner.tenantId} AND action = 'operational_report.export'
    `) as {
      actor_tenant_user_id: string;
      attributes: Record<string, unknown>;
    }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_tenant_user_id).toBe(exporter.tenantUserId);
    expect(audit[0]!.attributes).toMatchObject({
      family: "returns",
      rowCount: 1
    });
    expect(JSON.stringify(audit[0])).not.toContain("calc");
  });

  test("a CSV of a family whose feature is off is a header row only", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await seedProjectionRows(owner.tenantId, 2);
    const result = await loyaltyCsv({
      request: new Request(
        `http://integration.test/api/v1/reports/commerce/operational-loyalty.csv${RANGE}`,
        { headers: headers(owner) }
      ),
      url: new URL(
        `http://integration.test/api/v1/reports/commerce/operational-loyalty.csv${RANGE}`
      ),
      params: {},
      locals: {},
      cookies: createCookieJar(),
      clientAddress: "127.0.0.1"
    } as never);
    expect(result.status).toBe(200);
    expect(await result.text()).toBe("day,bucket,entries,points\r\n");
  });
});
