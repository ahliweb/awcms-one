/**
 * The booking revenue waterfall and the hold pipeline through the REAL route
 * handlers (Issue #389, ADR-0045 amendment note) - the HTTP half that
 * `commerce-booking-revenue.integration.test.ts` (engine and read functions,
 * WORLD 1) cannot see: route wiring (`defineTenantRoute`, ABAC, the range
 * validator, the `booking` feature toggle) with real session and permission
 * machinery behind it. Same shape as `commerce-retention-routes.integration.
 * test.ts`, whose WORLD 2 note applies: handlers call `getDatabaseClient()`
 * internally, so this file runs against the migrated `DATABASE_URL` database and
 * seeds through `getHandlerAdminSql()`. Projection rows are seeded directly -
 * this file is about who may read them and what comes back, not how they are
 * filled.
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
import { resolveSalesReportDay } from "../../src/modules/commerce/domain/sales-report-deltas";
import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { PATCH as patchModuleSettings } from "../../src/pages/api/v1/tenant/modules/[moduleKey]/settings";
import { GET as revenueJson } from "../../src/pages/api/v1/reports/commerce/booking-revenue";
import { GET as pipelineJson } from "../../src/pages/api/v1/reports/commerce/booking-pipeline";
import { GET as revenueCsv } from "../../src/pages/api/v1/reports/commerce/booking-revenue.csv";
import { GET as cashJson } from "../../src/pages/api/v1/reports/commerce/booking-revenue-cash";

const OWNER_PASSWORD = "integration-test-owner-password";
const REVENUE_PATH = "/api/v1/reports/commerce/booking-revenue";
const PIPELINE_PATH = "/api/v1/reports/commerce/booking-pipeline";
const CSV_PATH = "/api/v1/reports/commerce/booking-revenue.csv";
const CASH_PATH = "/api/v1/reports/commerce/booking-revenue-cash";

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

type RevenueBody = {
  enabled: boolean;
  from: string;
  to: string;
  days: {
    day: string;
    gross: string;
    refunds: string;
    refundsPaidBack: string;
    refundsPayable: string;
    refundsUncollected: string;
    refundPayableBalance: string;
    tax: string;
    net: string;
    balanceOutstanding: string;
    noShows: number;
    noShowRatePercent: string | null;
    restated: boolean;
  }[];
  totals: { gross: string; net: string };
};

const dayAgo = (n: number) =>
  resolveSalesReportDay(new Date(Date.now() - n * 86_400_000));

/** The CSV handler returns text, which `invoke` would try to parse as JSON, so call it directly. */
function callCsv(who: Principal, query = ""): Promise<Response> {
  const url = `http://integration.test${CSV_PATH}${query}`;
  return revenueCsv({
    request: new Request(url, { headers: headers(who) }),
    url: new URL(url),
    params: {},
    locals: { correlationId: "corr-478" },
    cookies: createCookieJar(),
    clientAddress: "127.0.0.1"
  } as never) as Promise<Response>;
}

/** Two booking orders on one past day: a no-show with its balance uncollected, and a fully paid stay. */
async function seedRows(tenantId: string): Promise<void> {
  const admin = getHandlerAdminSql();
  const insert = (
    stays: number,
    noShows: number,
    paidIn: string,
    uncollected: string,
    retained: string
  ) => admin`
    INSERT INTO awcms_commerce_report_booking_orders
      (tenant_id, order_id, paid_day, source_kind, stays, no_shows, no_show_retained,
       gross, discount, shipping, insurance, tax, total, paid_in, paid_back,
       uncollected, outstanding, closed, goods_uncollected)
    VALUES (${tenantId}, gen_random_uuid(), ${dayAgo(2)}::date, 'reservation', ${stays},
      ${noShows}, ${retained}::numeric, 3000000, 0, 0, 0, 0, 3000000,
      ${paidIn}::numeric, 0, ${uncollected}::numeric, 0, ${noShows > 0},
      ${uncollected}::numeric)`;
  await insert(1, 1, "900000", "2100000", "900000");
  await insert(1, 0, "3000000", "0", "0");
}

async function setBooking(owner: Principal, on: boolean) {
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
        booking: on
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
  "booking revenue and pipeline through the route handlers (Issue #389)",
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

    test("OFF by default: 200 enabled=false and no days; on shows the waterfall of the original paid day; off again hides it", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      await seedRows(owner.tenantId);
      const path = `${REVENUE_PATH}?from=${dayAgo(5)}&to=${dayAgo(0)}`;

      const off = await invoke<Envelope<RevenueBody>>(revenueJson, {
        path,
        headers: headers(owner)
      });
      expect(off.status).toBe(200);
      expect(off.body.data.enabled).toBe(false);
      expect(off.body.data.days).toEqual([]);

      expect((await setBooking(owner, true)).status).toBe(200);
      const on = await invoke<Envelope<RevenueBody>>(revenueJson, {
        path,
        headers: headers(owner)
      });
      expect(on.status).toBe(200);
      expect(on.body.data.enabled).toBe(true);
      expect(on.body.data.days).toHaveLength(1);
      expect(on.body.data.days[0]).toMatchObject({
        day: dayAgo(2),
        gross: "6000000.00",
        refundsPaidBack: "0.00",
        refundsPayable: "0.00",
        refundsUncollected: "2100000.00",
        refunds: "2100000.00",
        refundPayableBalance: "0.00",
        net: "3900000.00",
        noShows: 1,
        noShowRatePercent: "50.0",
        restated: false
      });
      expect(on.body.data.totals).toMatchObject({
        gross: "6000000.00",
        net: "3900000.00"
      });
      // Aggregates only: no order id, customer or contact leaves the route.
      expect(JSON.stringify(on.body)).not.toMatch(
        /order_?id|customer|phone|[0-9a-f]{8}-[0-9a-f]{4}-4/i
      );

      expect((await setBooking(owner, false)).status).toBe(200);
      const hidden = await invoke<Envelope<RevenueBody>>(revenueJson, {
        path,
        headers: headers(owner)
      });
      expect(hidden.body.data.enabled).toBe(false);
    });

    test("a day outside the range is not returned, and the default range is the last 30 days", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      await seedRows(owner.tenantId);
      expect((await setBooking(owner, true)).status).toBe(200);

      const narrow = await invoke<Envelope<RevenueBody>>(revenueJson, {
        path: `${REVENUE_PATH}?from=${dayAgo(1)}&to=${dayAgo(0)}`,
        headers: headers(owner)
      });
      expect(narrow.body.data.days).toEqual([]);

      const defaults = await invoke<Envelope<RevenueBody>>(revenueJson, {
        path: REVENUE_PATH,
        headers: headers(owner)
      });
      expect(defaults.body.data.to).toBe(dayAgo(0));
      expect(defaults.body.data.days).toHaveLength(1);
    });

    test("reporting.dashboard.read opens both routes; nothing else does, and a bad range is 400 only after the permission check", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      await seedRows(owner.tenantId);
      expect((await setBooking(owner, true)).status).toBe(200);

      const reader = await seedPrincipal(owner.tenantId, "reader", [
        "reporting.dashboard.read"
      ]);
      const bystander = await seedPrincipal(owner.tenantId, "bystander", [
        "reporting.projections.read",
        "commerce.report_returns.read",
        "commerce.report_retention.read",
        "commerce.orders.read"
      ]);
      const nobody = await seedPrincipal(owner.tenantId, "nobody", []);

      for (const path of [REVENUE_PATH, PIPELINE_PATH, CASH_PATH]) {
        const handler =
          path === REVENUE_PATH
            ? revenueJson
            : path === CASH_PATH
              ? cashJson
              : pipelineJson;
        expect(
          (await invoke<Envelope>(handler, { path, headers: headers(reader) }))
            .status
        ).toBe(200);
        expect(
          (
            await invoke<Envelope>(handler, {
              path,
              headers: headers(bystander)
            })
          ).status
        ).toBe(403);
        expect(
          (await invoke<Envelope>(handler, { path, headers: headers(nobody) }))
            .status
        ).toBe(403);
        expect(
          (
            await invoke<Envelope>(handler, {
              path,
              headers: { "x-awcms-tenant-id": owner.tenantId }
            })
          ).status
        ).toBe(401);
      }

      for (const query of [
        "?from=2026-02-30",
        "?from=2026-05-02&to=2026-05-01"
      ]) {
        const denied = await invoke<Envelope>(revenueJson, {
          path: `${REVENUE_PATH}${query}`,
          headers: headers(nobody)
        });
        expect(denied.status).toBe(403);
        const bad = await invoke<Envelope>(revenueJson, {
          path: `${REVENUE_PATH}${query}`,
          headers: headers(reader)
        });
        expect(bad.status).toBe(400);
        expect(bad.body.error?.code).toBe("VALIDATION_ERROR");
      }
    });

    test("#478 waterfall CSV: the same columns as the screen, aggregates only, no-store, audited; permission, enabled:false and the range check", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      await seedRows(owner.tenantId);
      const reader = await seedPrincipal(owner.tenantId, "csv-reader", [
        "commerce.report_booking_revenue.export"
      ]);
      const bystander = await seedPrincipal(owner.tenantId, "csv-bystander", [
        // reporting.dashboard.read opens the screen and the JSON route but NOT
        // the file: the export is its own key (sql/1054).
        "reporting.dashboard.read",
        "reporting.projections.read",
        "commerce.report_retention.export",
        "commerce.report_returns.export"
      ]);
      const nobody = await seedPrincipal(owner.tenantId, "csv-nobody", []);
      const query = `?from=${dayAgo(5)}&to=${dayAgo(0)}`;

      // booking OFF (the default): 200 with the header row only.
      const off = await callCsv(reader, query);
      expect(off.status).toBe(200);
      expect(off.headers.get("content-type")).toContain("text/csv");
      const offLines = (await off.text()).split("\r\n");
      expect(offLines[0]).toContain("basis,day,orders,gross,discounts,refunds");
      expect(offLines).toHaveLength(2);
      expect(offLines[1]).toBe("");

      expect((await setBooking(owner, true)).status).toBe(200);
      const on = await callCsv(reader, query);
      expect(on.status).toBe(200);
      expect(on.headers.get("cache-control")).toBe("no-store");
      expect(on.headers.get("content-disposition")).toBe(
        `attachment; filename="booking-revenue-${dayAgo(5)}-${dayAgo(0)}.csv"`
      );
      const text = await on.text();
      const lines = text.split("\r\n");
      expect(lines).toHaveLength(3);
      const header = lines[0]!.split(",");
      const cells = Object.fromEntries(
        header.map((name, index) => [name, lines[1]!.split(",")[index]])
      );
      expect(cells).toMatchObject({
        basis: "paid_day",
        day: dayAgo(2),
        orders: "2",
        gross: "6000000.00",
        refunds: "2100000.00",
        refunds_paid_back: "0.00",
        refunds_payable: "0.00",
        refunds_uncollected: "2100000.00",
        net: "3900000.00",
        refund_payable_balance: "0.00",
        no_shows: "1",
        restated: "false"
      });
      // No cell was neutralised (nothing here begins with a formula leader),
      // and no id, customer or contact is in the file.
      expect(text).not.toContain("'");
      expect(text).not.toMatch(/customer|phone|[0-9a-f]{8}-[0-9a-f]{4}-4/i);

      // The export is audited: who, the range and the row count, never a cell.
      const audit = (await getHandlerAdminSql()`
        SELECT action, resource_type, attributes FROM awcms_audit_events
        WHERE tenant_id = ${owner.tenantId} AND action = 'booking_revenue_report.export'
        ORDER BY created_at
      `) as {
        action: string;
        resource_type: string;
        attributes: { rowCount: number; featureEnabled: boolean };
      }[];
      expect(audit).toHaveLength(2);
      expect(audit[0]!.attributes).toMatchObject({
        rowCount: 0,
        featureEnabled: false
      });
      expect(audit[1]!.resource_type).toBe("booking_revenue_report");
      expect(audit[1]!.attributes).toMatchObject({
        rowCount: 1,
        featureEnabled: true
      });

      // commerce.report_booking_revenue.export and nothing else; a bad range is 400 after it.
      expect((await callCsv(bystander, query)).status).toBe(403);
      expect((await callCsv(nobody, query)).status).toBe(403);
      expect((await callCsv(nobody, "?from=2026-02-30")).status).toBe(403);
      const bad = await callCsv(reader, "?from=2026-05-02&to=2026-05-01");
      expect(bad.status).toBe(400);
      const anonymous = await revenueCsv({
        request: new Request(`http://integration.test${CSV_PATH}`, {
          headers: { "x-awcms-tenant-id": owner.tenantId }
        }),
        url: new URL(`http://integration.test${CSV_PATH}`),
        params: {},
        locals: { correlationId: "corr-478-anon" },
        cookies: createCookieJar(),
        clientAddress: "127.0.0.1"
      } as never);
      expect(anonymous.status).toBe(401);
    });

    test("#478 cash view: enabled:false while booking is OFF, an empty labelled cash answer while it is ON, range validation after the permission check", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      const reader = await seedPrincipal(owner.tenantId, "cash-reader", [
        "reporting.dashboard.read"
      ]);
      const nobody = await seedPrincipal(owner.tenantId, "cash-nobody", []);
      const path = `${CASH_PATH}?from=${dayAgo(5)}&to=${dayAgo(0)}`;
      type CashBody = {
        enabled: boolean;
        basis: string;
        timeZone: string;
        from: string;
        to: string;
        days: unknown[];
        totals: { legs: number; refundsPaidOut: string };
      };

      const off = await invoke<Envelope<CashBody>>(cashJson, {
        path,
        headers: headers(reader)
      });
      expect(off.status).toBe(200);
      expect(off.body.data).toMatchObject({
        enabled: false,
        basis: "cash",
        days: []
      });

      expect((await setBooking(owner, true)).status).toBe(200);
      const on = await invoke<Envelope<CashBody>>(cashJson, {
        path,
        headers: headers(reader)
      });
      expect(on.status).toBe(200);
      expect(on.body.data).toMatchObject({
        enabled: true,
        basis: "cash",
        timeZone: "Asia/Jakarta",
        from: dayAgo(5),
        to: dayAgo(0),
        days: [],
        totals: { legs: 0, refundsPaidOut: "0.00" }
      });
      // The default range is the last 30 days.
      const defaults = await invoke<Envelope<CashBody>>(cashJson, {
        path: CASH_PATH,
        headers: headers(reader)
      });
      expect(defaults.body.data.to).toBe(dayAgo(0));

      expect(
        (
          await invoke<Envelope>(cashJson, {
            path: `${CASH_PATH}?from=2026-02-30`,
            headers: headers(nobody)
          })
        ).status
      ).toBe(403);
      const bad = await invoke<Envelope>(cashJson, {
        path: `${CASH_PATH}?from=2026-05-02&to=2026-05-01`,
        headers: headers(reader)
      });
      expect(bad.status).toBe(400);
      expect(bad.body.error?.code).toBe("VALIDATION_ERROR");
    });

    test("the pipeline is enabled=false while booking is OFF and an empty live read while it is ON with no holds", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      const off = await invoke<
        Envelope<{ enabled: boolean; pipeline: { holds: number } }>
      >(pipelineJson, { path: PIPELINE_PATH, headers: headers(owner) });
      expect(off.status).toBe(200);
      expect(off.body.data.enabled).toBe(false);

      expect((await setBooking(owner, true)).status).toBe(200);
      const on = await invoke<
        Envelope<{
          enabled: boolean;
          pipeline: {
            holds: number;
            units: number;
            value: string;
            oldestHoldAgeSeconds: number | null;
            nextExpiryAt: string | null;
          };
        }>
      >(pipelineJson, { path: PIPELINE_PATH, headers: headers(owner) });
      expect(on.body.data.enabled).toBe(true);
      expect(on.body.data.pipeline).toEqual({
        holds: 0,
        units: 0,
        value: "0.00",
        oldestHoldAgeSeconds: null,
        nextExpiryAt: null
      });
    });

    test("cross-tenant: a second tenant's owner reads none of the first tenant's days", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      await seedRows(owner.tenantId);
      expect((await setBooking(owner, true)).status).toBe(200);

      const other = (await getHandlerAdminSql()`
        INSERT INTO awcms_tenants
          (tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
        VALUES ('other', 'Other', 'Other', 'active', 'en', 'light')
        RETURNING id
      `) as { id: string }[];
      const stranger = await seedPrincipal(other[0]!.id, "stranger", [
        "reporting.dashboard.read"
      ]);
      const crossed = await invoke<Envelope>(revenueJson, {
        path: REVENUE_PATH,
        headers: { ...headers(stranger), "x-awcms-tenant-id": owner.tenantId }
      });
      expect([401, 403]).toContain(crossed.status);
    });
  }
);
