/**
 * The customer-retention report through the REAL route handlers (Issue #364,
 * ADR-0044) - the HTTP half that `commerce-retention.integration.test.ts`
 * (engine and read function, WORLD 1) cannot see: route wiring
 * (`defineTenantRoute`, ABAC, the range validator, the feature toggle, the CSV
 * audit) with real session and permission machinery behind it. Same shape as
 * `commerce-operational-reports-routes.integration.test.ts`, whose WORLD 2
 * note applies: handlers call `getDatabaseClient()` internally, so this file
 * runs against the migrated `DATABASE_URL` database and seeds through
 * `getHandlerAdminSql()`. Cohort rows are seeded directly - this file is about
 * who may read them and what comes back, not how they are filled.
 *
 * Every fixture month is relative to `new Date()`.
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
import {
  addCohortMonths,
  cohortMonthOf
} from "../../src/modules/commerce/domain/retention";
import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { PATCH as patchModuleSettings } from "../../src/pages/api/v1/tenant/modules/[moduleKey]/settings";
import { GET as retentionJson } from "../../src/pages/api/v1/reports/commerce/retention";
import { GET as retentionCsv } from "../../src/pages/api/v1/reports/commerce/retention.csv";

const OWNER_PASSWORD = "integration-test-owner-password";
const PATH = "/api/v1/reports/commerce/retention";

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

/** The CSV handler returns text, which `invoke` would try to parse as JSON, so call it directly. */
function callCsv(who: Principal, query = ""): Promise<Response> {
  const url = `http://integration.test${PATH}.csv${query}`;
  return retentionCsv({
    request: new Request(url, { headers: headers(who) }),
    url: new URL(url),
    params: {},
    locals: { correlationId: "corr-364" },
    cookies: createCookieJar(),
    clientAddress: "127.0.0.1"
  } as never) as Promise<Response>;
}

function headers(who: Principal): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-tenant-id": who.tenantId,
    authorization: `Bearer ${who.token}`
  };
}

type Envelope<T = unknown> = {
  success: boolean;
  data: T;
  error?: { code: string };
};

type RetentionBody = {
  enabled: boolean;
  cohorts: { cohortMonth: string; size: number; repeaters: number }[];
  unlinkedOrders: number;
};

const COHORT = addCohortMonths(cohortMonthOf(new Date()), -4);

/** Twenty-two customers' worth of projection rows in one past cohort, 11 repeating. */
async function seedCohort(tenantId: string): Promise<void> {
  const admin = getHandlerAdminSql();
  const base = new Date(Date.now() - 120 * 24 * 3_600_000);
  for (let i = 0; i < 22; i += 1) {
    const customer = (await admin`
      INSERT INTO awcms_commerce_customers (tenant_id, name, phone)
      VALUES (${tenantId}, ${`C${i}`}, ${`+6281300${String(i).padStart(6, "0")}`})
      RETURNING id
    `) as { id: string }[];
    await admin`
      INSERT INTO awcms_commerce_report_retention_customers
        (tenant_id, customer_id, cohort_month, first_event_at, second_event_at,
         qualifying_order_count)
      VALUES (${tenantId}, ${customer[0]!.id}, ${COHORT}::date, ${base},
        ${i < 11 ? new Date(base.getTime() + 20 * 24 * 3_600_000) : null},
        ${i < 11 ? 2 : 1})
    `;
  }
}

async function setRetention(owner: Principal, on: boolean) {
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
        retention: on
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

suite(
  "customer-retention report through the route handlers (Issue #364)",
  () => {
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

    test("OFF by default: 200 enabled=false and no cohorts; on shows the cohort with its rate; off again hides it", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      await seedCohort(owner.tenantId);

      const off = await invoke<Envelope<RetentionBody>>(retentionJson, {
        path: PATH,
        headers: headers(owner)
      });
      expect(off.status).toBe(200);
      expect(off.body.data.enabled).toBe(false);
      expect(off.body.data.cohorts).toEqual([]);

      expect((await setRetention(owner, true)).status).toBe(200);
      const on = await invoke<
        Envelope<
          RetentionBody & {
            cohorts: { ratePercent: string | null; rateShown: boolean }[];
          }
        >
      >(retentionJson, { path: PATH, headers: headers(owner) });
      expect(on.status).toBe(200);
      expect(on.body.data.enabled).toBe(true);
      expect(on.body.data.cohorts).toHaveLength(1);
      expect(on.body.data.cohorts[0]).toMatchObject({
        cohortMonth: COHORT,
        size: 22,
        repeaters: 11,
        rateShown: true,
        ratePercent: "50.0"
      });
      // Counts only: nothing identifying leaves the route.
      expect(JSON.stringify(on.body)).not.toMatch(
        /customer_?id|phone|\+6281300/i
      );

      expect((await setRetention(owner, false)).status).toBe(200);
      const hidden = await invoke<Envelope<RetentionBody>>(retentionJson, {
        path: PATH,
        headers: headers(owner)
      });
      expect(hidden.body.data.enabled).toBe(false);
    });

    test("a principal holds exactly its key: read does not export, export does not read, and the dashboard or customers.read open neither", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      await seedCohort(owner.tenantId);
      expect((await setRetention(owner, true)).status).toBe(200);

      const reader = await seedPrincipal(owner.tenantId, "reader", [
        "commerce.report_retention.read"
      ]);
      const exporter = await seedPrincipal(owner.tenantId, "exporter", [
        "commerce.report_retention.export"
      ]);
      const bystander = await seedPrincipal(owner.tenantId, "bystander", [
        "reporting.dashboard.read",
        "reporting.projections.read",
        "commerce.customers.read",
        "commerce.report_returns.read",
        "commerce.report_loyalty.export"
      ]);

      const get = (who: Principal) =>
        invoke<Envelope>(retentionJson, { path: PATH, headers: headers(who) });

      expect((await get(reader)).status).toBe(200);
      expect((await callCsv(reader)).status).toBe(403);
      expect((await get(exporter)).status).toBe(403);
      expect((await callCsv(exporter)).status).toBe(200);
      expect((await get(bystander)).status).toBe(403);
      expect((await callCsv(bystander)).status).toBe(403);
    });

    test("the CSV is aggregates only, no-store, audited, and withholds nothing it should show", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      await seedCohort(owner.tenantId);
      expect((await setRetention(owner, true)).status).toBe(200);

      const result = await callCsv(owner, "?months=12");
      expect(result.status).toBe(200);
      expect(result.headers.get("content-type")).toContain("text/csv");
      expect(result.headers.get("cache-control")).toBe("no-store");
      const lines = (await result.text()).trim().split("\r\n");
      expect(lines[0]).toBe(
        "cohort_month,customers,repeaters_within_90_days,retention_percent,status,matures_at,restated_at"
      );
      expect(lines[1]!.split(",").slice(0, 4)).toEqual([
        COHORT,
        "22",
        "11",
        "50.0"
      ]);

      const audit = (await getHandlerAdminSql()`
      SELECT action, resource_type FROM awcms_audit_events
      WHERE tenant_id = ${owner.tenantId} AND action = 'retention_report.export'
    `) as { action: string; resource_type: string }[];
      expect(audit).toHaveLength(1);
      expect(audit[0]!.resource_type).toBe("retention_report");
    });

    test("an unauthenticated call is 401, and a bad months value is 400 only after the permission check", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      const anonymous = await invoke<Envelope>(retentionJson, {
        path: PATH,
        headers: { "x-awcms-tenant-id": owner.tenantId }
      });
      expect(anonymous.status).toBe(401);

      const nobody = await seedPrincipal(owner.tenantId, "nobody", []);
      const reader = await seedPrincipal(owner.tenantId, "reader2", [
        "commerce.report_retention.read"
      ]);
      for (const months of ["0", "37", "abc"]) {
        const denied = await invoke<Envelope>(retentionJson, {
          path: `${PATH}?months=${months}`,
          headers: headers(nobody)
        });
        expect(denied.status).toBe(403);
        const bad = await invoke<Envelope>(retentionJson, {
          path: `${PATH}?months=${months}`,
          headers: headers(reader)
        });
        expect(bad.status).toBe(400);
        expect(bad.body.error?.code).toBe("VALIDATION_ERROR");
      }
    });

    test("cross-tenant: a second tenant's owner reads none of the first tenant's cohorts", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      await seedCohort(owner.tenantId);
      expect((await setRetention(owner, true)).status).toBe(200);

      const admin = getHandlerAdminSql();
      const other = (await admin`
      INSERT INTO awcms_tenants
        (tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
      VALUES ('other', 'Other', 'Other', 'active', 'en', 'light')
      RETURNING id
    `) as { id: string }[];
      const stranger = await seedPrincipal(other[0]!.id, "stranger", [
        "commerce.report_retention.read"
      ]);
      // Asking for the first tenant's id with the second tenant's session is refused.
      const crossed = await invoke<Envelope>(retentionJson, {
        path: PATH,
        headers: { ...headers(stranger), "x-awcms-tenant-id": owner.tenantId }
      });
      expect([401, 403]).toContain(crossed.status);
    });
  }
);
