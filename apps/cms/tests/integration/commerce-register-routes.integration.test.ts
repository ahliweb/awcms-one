/**
 * POS register / cash-up through the REAL route handlers (Issue #284, epic
 * #281, ADR-0028) - the HTTP half that `commerce-register-cash-up
 * .integration.test.ts` (which drives the directory functions) cannot see:
 * route wiring (`defineTenantRoute`, ABAC, the `register` feature gate, body
 * validation, `Idempotency-Key`, the error -> status mapping) with real
 * argon2/session/permission machinery behind it.
 *
 * WORLD 2 (see `harness.ts`): handlers call `getDatabaseClient()` internally,
 * so this file runs against the migrated `DATABASE_URL` database and seeds
 * through `getHandlerAdminSql()`. The owner comes from the real setup + login
 * endpoints (every permission granted); the other principals are seeded with
 * EXACTLY the permission keys under test, so a 403 below means "that key was
 * missing", never "the actor had nothing":
 *
 *   - a CASHIER (pos.create + what running a shift needs) can open, use and
 *     close a session - and nothing more: no approval, no correction, no CSV,
 *     no register administration;
 *   - a POS-ONLY user (commerce.pos.create) gets none of the register keys;
 *   - the feature gate answers 409 FEATURE_DISABLED until the tenant opts in.
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
  getHandlerDatabaseClient,
  integrationEnabled,
  invoke,
  resetHandlerDatabase,
  teardownHandlerDatabase
} from "./harness";
import { hashSessionToken } from "../../src/lib/auth/session-token";
import { withTenantOrThrow } from "../../src/lib/database/tenant-context";
import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { PATCH as patchModuleSettings } from "../../src/pages/api/v1/tenant/modules/[moduleKey]/settings";
import {
  GET as listRegisters,
  POST as createRegister
} from "../../src/pages/api/v1/commerce/registers/index";
import {
  GET as getRegister,
  PATCH as patchRegister
} from "../../src/pages/api/v1/commerce/registers/[id]";
import {
  GET as listSessions,
  POST as openSession
} from "../../src/pages/api/v1/commerce/register-sessions/index";
import { GET as getSession } from "../../src/pages/api/v1/commerce/register-sessions/[id]/index";
import { POST as postMovement } from "../../src/pages/api/v1/commerce/register-sessions/[id]/movements";
import { POST as postHandover } from "../../src/pages/api/v1/commerce/register-sessions/[id]/handover";
import { POST as postClose } from "../../src/pages/api/v1/commerce/register-sessions/[id]/close";
import { POST as postDecision } from "../../src/pages/api/v1/commerce/register-sessions/[id]/close-decision";
import { POST as postCorrection } from "../../src/pages/api/v1/commerce/register-sessions/[id]/corrections";
import { GET as getCsv } from "../../src/pages/api/v1/commerce/register-sessions/[id]/report.csv";
import { POST as postPosOrder } from "../../src/pages/api/v1/commerce/pos/orders/index";
import { createProduct } from "../../src/modules/commerce/application/product-directory";
import { saveStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
import type { CreateProductInput } from "../../src/modules/commerce/domain/product-validation";

const OWNER_PASSWORD = "integration-test-owner-password";

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
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-tenant-id": who.tenantId,
    authorization: `Bearer ${who.token}`,
    ...extra
  };
}

type Envelope<T = unknown> = {
  success: boolean;
  data: T;
  error?: { code: string; details?: unknown };
};

const CASHIER_PERMISSIONS = [
  "commerce.pos.create",
  "commerce.registers.read",
  "commerce.register_sessions.read",
  "commerce.register_sessions.create",
  "commerce.register_sessions.update",
  "commerce.register_cash_ups.create"
];

type SessionBody = {
  id: string;
  status: string;
  currentCashierTenantUserId: string;
};
type ReportBody = {
  session: SessionBody;
  tenders: {
    tenderType: string;
    expected: string;
    counted: string | null;
    variance: string | null;
    effectiveCounted: string | null;
  }[];
  closeRequests: { decision: string }[];
  variance: { decision: string } | null;
};
type CloseBody = { outcome: string; report: ReportBody };

const key = () => ({ "idempotency-key": crypto.randomUUID() });

async function enableRegisters(owner: Principal, threshold = "50.00") {
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
        register: true
      },
      cashUp: { approvalThreshold: threshold }
    }
  });
}

const BASE_PRODUCT: CreateProductInput = {
  categoryId: null,
  type: "physical",
  sku: "SKU-RT",
  name: "Teh Tarik",
  slug: "teh-tarik-rt",
  description: null,
  digitalNote: null,
  price: "10000.00",
  discountPercent: 0,
  stock: 100,
  label: null,
  labelColor: null,
  priceLevel2: null,
  priceLevel3: null,
  priceLevel4: null,
  costPrice: null,
  minPurchase: 1,
  weightGrams: 250,
  manualRating: null,
  manualSoldCount: 0,
  withInsurance: false,
  insuranceRequired: false,
  insuranceFee: null,
  promoBannerShow: false,
  promoBannerTitle: null,
  promoBannerSubtitle: null,
  promoBannerBadge: null,
  promoBannerIcon: null,
  promoBannerColor: null,
  sizeChartType: "none",
  sizeChartMediaId: null,
  sizeChartDetails: null,
  serviceForm: null,
  subscriptionPeriod: null,
  downloadLink: null,
  allowDp: false,
  allowFreeShipping: true,
  variantAttributes: null,
  isFeatured: false,
  isRecommended: false
};

async function seedProduct(owner: Principal): Promise<string> {
  const db = getHandlerDatabaseClient();
  const settings = validateStoreSettingsInput({
    storeName: "Toko Rute",
    shipping: { selfPickup: true },
    payment: { manualQris: { active: true, mediaObjectId: null } }
  });
  if (!settings.valid) throw new Error(JSON.stringify(settings.errors));
  await withTenantOrThrow(db, owner.tenantId, (tx) =>
    saveStoreSettings(tx, owner.tenantId, owner.tenantUserId, settings.value)
  );
  const product = await withTenantOrThrow(db, owner.tenantId, (tx) =>
    createProduct(tx, owner.tenantId, owner.tenantUserId, BASE_PRODUCT)
  );
  await withTenantOrThrow(
    db,
    owner.tenantId,
    (tx) =>
      tx`UPDATE awcms_commerce_products SET status = 'active' WHERE id = ${product.id}`
  );
  return product.id;
}

const suite = integrationEnabled ? describe : describe.skip;

let handlerReady = false;

function skipUnlessHandlerReady(): boolean {
  if (handlerReady) return false;
  console.warn(
    "[skip] handler database is not migrated — run 'bun run db:migrate' against DATABASE_URL."
  );
  return true;
}

suite(
  "POS registers and cash-up through the route handlers (Issue #284)",
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

    async function newRegister(
      owner: Principal,
      code = "KASIR-1"
    ): Promise<string> {
      const created = await invoke<Envelope<{ id: string }>>(createRegister, {
        method: "POST",
        path: "/api/v1/commerce/registers",
        headers: headers(owner),
        body: { code, name: `Register ${code}`, locationLabel: "Front" }
      });
      expect(created.status).toBe(201);
      return created.body.data.id;
    }

    function open(
      who: Principal,
      registerId: string,
      openingFloat = "100000.00"
    ) {
      return invoke<Envelope<SessionBody>>(openSession, {
        method: "POST",
        path: "/api/v1/commerce/register-sessions",
        headers: headers(who, key()),
        body: { registerId, openingFloat }
      });
    }

    function close(
      who: Principal,
      sessionId: string,
      counted: Record<string, string>,
      varianceReason: string | null = null,
      idempotency: Record<string, string> = key()
    ) {
      return invoke<Envelope<CloseBody>>(postClose, {
        method: "POST",
        path: `/api/v1/commerce/register-sessions/${sessionId}/close`,
        headers: headers(who, idempotency),
        params: { id: sessionId },
        body: { counted, varianceReason }
      });
    }

    test("the register feature gate: every route is 409 FEATURE_DISABLED until the tenant opts in", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();

      const created = await invoke<Envelope>(createRegister, {
        method: "POST",
        path: "/api/v1/commerce/registers",
        headers: headers(owner),
        body: { code: "K1", name: "One" }
      });
      expect(created.status).toBe(409);
      expect(created.body.error?.code).toBe("FEATURE_DISABLED");

      for (const result of [
        await invoke<Envelope>(listRegisters, {
          path: "/api/v1/commerce/registers",
          headers: headers(owner)
        }),
        await invoke<Envelope>(listSessions, {
          path: "/api/v1/commerce/register-sessions",
          headers: headers(owner)
        }),
        await invoke<Envelope>(openSession, {
          method: "POST",
          path: "/api/v1/commerce/register-sessions",
          headers: headers(owner, key()),
          body: {
            registerId: "00000000-0000-4000-8000-000000000000",
            openingFloat: "0"
          }
        })
      ]) {
        expect(result.status).toBe(409);
        expect(result.body.error?.code).toBe("FEATURE_DISABLED");
      }

      // The settings route is the opt-in; afterwards the same call works.
      expect((await enableRegisters(owner)).status).toBe(200);
      const again = await invoke<Envelope<{ id: string }>>(createRegister, {
        method: "POST",
        path: "/api/v1/commerce/registers",
        headers: headers(owner),
        body: { code: "K1", name: "One" }
      });
      expect(again.status).toBe(201);
    });

    test("registers: create, duplicate code, list, get, patch, validation, unknown id", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      await enableRegisters(owner);

      const id = await newRegister(owner, "KASIR-1");
      const duplicate = await invoke<Envelope>(createRegister, {
        method: "POST",
        path: "/api/v1/commerce/registers",
        headers: headers(owner),
        body: { code: "kasir-1", name: "Dup" }
      });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error?.code).toBe("REGISTER_CODE_TAKEN");

      const invalid = await invoke<Envelope>(createRegister, {
        method: "POST",
        path: "/api/v1/commerce/registers",
        headers: headers(owner),
        body: { code: "bad code", name: "" }
      });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error?.code).toBe("VALIDATION_ERROR");

      const list = await invoke<Envelope<{ items: { code: string }[] }>>(
        listRegisters,
        { path: "/api/v1/commerce/registers", headers: headers(owner) }
      );
      expect(list.body.data.items.map((r) => r.code)).toEqual(["KASIR-1"]);

      const patched = await invoke<Envelope<{ name: string; active: boolean }>>(
        patchRegister,
        {
          method: "PATCH",
          path: `/api/v1/commerce/registers/${id}`,
          headers: headers(owner),
          params: { id },
          body: { name: "Front counter", active: false }
        }
      );
      expect(patched.status).toBe(200);
      expect(patched.body.data).toMatchObject({
        name: "Front counter",
        active: false
      });

      expect(
        (
          await invoke<Envelope>(patchRegister, {
            method: "PATCH",
            path: `/api/v1/commerce/registers/${id}`,
            headers: headers(owner),
            params: { id },
            body: { code: "NEW" }
          })
        ).status
      ).toBe(400);
      for (const bad of [
        "not-a-uuid",
        "00000000-0000-4000-8000-000000000000"
      ]) {
        const missing = await invoke<Envelope>(getRegister, {
          path: `/api/v1/commerce/registers/${bad}`,
          headers: headers(owner),
          params: { id: bad }
        });
        expect(missing.status).toBe(404);
      }
    });

    test("a full shift through the routes: open, movement, close within the threshold, report, CSV, correction", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      await enableRegisters(owner);
      const registerId = await newRegister(owner);

      const opened = await open(owner, registerId);
      expect(opened.status).toBe(201);
      const sessionId = opened.body.data.id;
      expect(opened.body.data.currentCashierTenantUserId).toBe(
        owner.tenantUserId
      );

      // A second open is refused; a malformed one is a 400; a missing key is a 400.
      expect((await open(owner, registerId)).status).toBe(409);
      const noKey = await invoke<Envelope>(openSession, {
        method: "POST",
        path: "/api/v1/commerce/register-sessions",
        headers: headers(owner),
        body: { registerId, openingFloat: "0" }
      });
      expect(noKey.status).toBe(400);
      expect(noKey.body.error?.code).toBe("IDEMPOTENCY_REQUIRED");

      const movementKey = key();
      const movement = await invoke<Envelope>(postMovement, {
        method: "POST",
        path: `/api/v1/commerce/register-sessions/${sessionId}/movements`,
        headers: headers(owner, movementKey),
        params: { id: sessionId },
        body: {
          movementType: "safe_drop",
          amount: "20000.00",
          note: "to the safe"
        }
      });
      expect(movement.status).toBe(201);
      // Replay: the same body and key return the same 201, not a second row.
      const replay = await invoke<Envelope<{ id: string }>>(postMovement, {
        method: "POST",
        path: `/api/v1/commerce/register-sessions/${sessionId}/movements`,
        headers: headers(owner, movementKey),
        params: { id: sessionId },
        body: {
          movementType: "safe_drop",
          amount: "20000.00",
          note: "to the safe"
        }
      });
      expect(replay.status).toBe(201);
      expect((movement.body.data as { id: string }).id).toBe(
        replay.body.data.id
      );
      // A different body under the same key is a conflict.
      const conflict = await invoke<Envelope>(postMovement, {
        method: "POST",
        path: `/api/v1/commerce/register-sessions/${sessionId}/movements`,
        headers: headers(owner, movementKey),
        params: { id: sessionId },
        body: { movementType: "safe_drop", amount: "1.00" }
      });
      expect(conflict.status).toBe(409);
      expect(conflict.body.error?.code).toBe("IDEMPOTENCY_CONFLICT");
      // Validation: an expense with no reference.
      const noReference = await invoke<Envelope>(postMovement, {
        method: "POST",
        path: `/api/v1/commerce/register-sessions/${sessionId}/movements`,
        headers: headers(owner, key()),
        params: { id: sessionId },
        body: { movementType: "expense", amount: "1.00" }
      });
      expect(noReference.status).toBe(400);

      const live = await invoke<Envelope<ReportBody>>(getSession, {
        path: `/api/v1/commerce/register-sessions/${sessionId}`,
        headers: headers(owner),
        params: { id: sessionId }
      });
      expect(live.status).toBe(200);
      // 100000 - 20000
      expect(live.body.data.tenders[0]).toMatchObject({
        tenderType: "cash",
        expected: "80000.00",
        counted: null
      });

      // A missing count is a 400 naming the tender; a variance needs a reason.
      const missing = await close(owner, sessionId, { manual_qris: "1.00" });
      expect(missing.status).toBe(400);
      const noReason = await close(owner, sessionId, { cash: "79990.00" });
      expect(noReason.status).toBe(400);

      const closeKey = key();
      const closed = await close(
        owner,
        sessionId,
        { cash: "79990.00" },
        "10.00 short",
        closeKey
      );
      expect(closed.status).toBe(200);
      expect(closed.body.data.outcome).toBe("closed");
      expect(closed.body.data.report.variance?.decision).toBe("auto");
      // Replay of the close.
      const closeAgain = await close(
        owner,
        sessionId,
        { cash: "79990.00" },
        "10.00 short",
        closeKey
      );
      expect(closeAgain.status).toBe(200);
      expect(closeAgain.body.data).toEqual(closed.body.data);

      // Closed: a movement and a second close are refused.
      expect(
        (
          await invoke<Envelope>(postMovement, {
            method: "POST",
            path: `/api/v1/commerce/register-sessions/${sessionId}/movements`,
            headers: headers(owner, key()),
            params: { id: sessionId },
            body: { movementType: "cash_in", amount: "1.00" }
          })
        ).body.error?.code
      ).toBe("REGISTER_SESSION_NOT_OPEN");
      expect((await close(owner, sessionId, { cash: "1.00" })).status).toBe(
        409
      );

      // CSV: right type, neutralised formula, no live formula cell.
      const csv = await getCsv({
        request: new Request(
          `http://integration.test/api/v1/commerce/register-sessions/${sessionId}/report.csv`,
          { headers: headers(owner) }
        ),
        url: new URL(
          `http://integration.test/api/v1/commerce/register-sessions/${sessionId}/report.csv`
        ),
        params: { id: sessionId },
        locals: {},
        cookies: createCookieJar(),
        clientAddress: "127.0.0.1"
      } as never);
      expect(csv.status).toBe(200);
      expect(csv.headers.get("content-type")).toContain("text/csv");
      const csvText = await csv.text();
      expect(csvText.split("\n")[0]).toBe(
        "section,key,tender,amount,expected,counted,variance,count,at,actor,text"
      );
      expect(csvText).toContain("-10.00");

      // Correction by the owner (holds register_corrections.approve).
      const corrected = await invoke<Envelope<ReportBody>>(postCorrection, {
        method: "POST",
        path: `/api/v1/commerce/register-sessions/${sessionId}/corrections`,
        headers: headers(owner, key()),
        params: { id: sessionId },
        body: {
          reason: "found a banknote",
          adjustments: [{ tenderType: "cash", adjustment: "10.00" }]
        }
      });
      expect(corrected.status).toBe(201);
      expect(corrected.body.data.session.status).toBe("corrected");
      expect(corrected.body.data.tenders[0]).toMatchObject({
        counted: "79990.00",
        effectiveCounted: "80000.00"
      });
      const negative = await invoke<Envelope>(postCorrection, {
        method: "POST",
        path: `/api/v1/commerce/register-sessions/${sessionId}/corrections`,
        headers: headers(owner, key()),
        params: { id: sessionId },
        body: {
          reason: "x",
          adjustments: [{ tenderType: "cash", adjustment: "-999999.00" }]
        }
      });
      expect(negative.status).toBe(400);
    });

    test("a CASHIER can open, use and close a session but gets no approval, correction, export or register administration", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      await enableRegisters(owner, "50.00");
      const registerId = await newRegister(owner);
      const cashier = await seedPrincipal(
        owner.tenantId,
        "cashier",
        CASHIER_PERMISSIONS
      );

      const opened = await open(cashier, registerId);
      expect(opened.status).toBe(201);
      const sessionId = opened.body.data.id;

      const listed = await invoke<Envelope>(listRegisters, {
        path: "/api/v1/commerce/registers",
        headers: headers(cashier)
      });
      expect(listed.status).toBe(200);
      expect(
        (
          await invoke<Envelope>(postMovement, {
            method: "POST",
            path: `/api/v1/commerce/register-sessions/${sessionId}/movements`,
            headers: headers(cashier, key()),
            params: { id: sessionId },
            body: { movementType: "cash_in", amount: "5000.00" }
          })
        ).status
      ).toBe(201);

      // Register administration, approval, correction and export are all 403.
      const forbidden = [
        await invoke<Envelope>(createRegister, {
          method: "POST",
          path: "/api/v1/commerce/registers",
          headers: headers(cashier),
          body: { code: "NOPE", name: "Nope" }
        }),
        await invoke<Envelope>(patchRegister, {
          method: "PATCH",
          path: `/api/v1/commerce/registers/${registerId}`,
          headers: headers(cashier),
          params: { id: registerId },
          body: { name: "Renamed" }
        }),
        await invoke<Envelope>(postDecision, {
          method: "POST",
          path: `/api/v1/commerce/register-sessions/${sessionId}/close-decision`,
          headers: headers(cashier, key()),
          params: { id: sessionId },
          body: { decision: "approve" }
        }),
        await invoke<Envelope>(postCorrection, {
          method: "POST",
          path: `/api/v1/commerce/register-sessions/${sessionId}/corrections`,
          headers: headers(cashier, key()),
          params: { id: sessionId },
          body: {
            reason: "x",
            adjustments: [{ tenderType: "cash", adjustment: "1.00" }]
          }
        })
      ];
      for (const result of forbidden) expect(result.status).toBe(403);
      const csvDenied = await getCsv({
        request: new Request("http://integration.test/x", {
          headers: headers(cashier)
        }),
        url: new URL("http://integration.test/x"),
        params: { id: sessionId },
        locals: {},
        cookies: createCookieJar(),
        clientAddress: "127.0.0.1"
      } as never);
      expect(csvDenied.status).toBe(403);

      // 105000 expected; counted 104900 -> 100.00 short, above the 50.00
      // threshold, and the cashier cannot approve -> the session waits.
      const pending = await close(
        cashier,
        sessionId,
        { cash: "104900.00" },
        "short"
      );
      expect(pending.status).toBe(200);
      expect(pending.body.data.outcome).toBe("pending_approval");
      expect(pending.body.data.report.session.status).toBe("closing");

      // The cashier cannot decide their own close; the owner can.
      const selfApprove = await invoke<Envelope>(postDecision, {
        method: "POST",
        path: `/api/v1/commerce/register-sessions/${sessionId}/close-decision`,
        headers: headers(cashier, key()),
        params: { id: sessionId },
        body: { decision: "approve" }
      });
      expect(selfApprove.status).toBe(403);
      const reject = await invoke<Envelope<CloseBody>>(postDecision, {
        method: "POST",
        path: `/api/v1/commerce/register-sessions/${sessionId}/close-decision`,
        headers: headers(owner, key()),
        params: { id: sessionId },
        body: { decision: "reject", note: "count again" }
      });
      expect(reject.status).toBe(200);
      expect(reject.body.data.outcome).toBe("reopened");
      const reject400 = await invoke<Envelope>(postDecision, {
        method: "POST",
        path: `/api/v1/commerce/register-sessions/${sessionId}/close-decision`,
        headers: headers(owner, key()),
        params: { id: sessionId },
        body: { decision: "reject" }
      });
      expect(reject400.status).toBe(400);

      await close(cashier, sessionId, { cash: "104900.00" }, "still short");
      const approve = await invoke<Envelope<CloseBody>>(postDecision, {
        method: "POST",
        path: `/api/v1/commerce/register-sessions/${sessionId}/close-decision`,
        headers: headers(owner, key()),
        params: { id: sessionId },
        body: { decision: "approve" }
      });
      expect(approve.status).toBe(200);
      expect(approve.body.data.report.session.status).toBe("closed");
      expect(
        approve.body.data.report.closeRequests.map((r) => r.decision)
      ).toEqual(["rejected", "approved"]);
      // Nothing is left to decide.
      const again = await invoke<Envelope>(postDecision, {
        method: "POST",
        path: `/api/v1/commerce/register-sessions/${sessionId}/close-decision`,
        headers: headers(owner, key()),
        params: { id: sessionId },
        body: { decision: "approve" }
      });
      expect(again.status).toBe(409);
      expect(again.body.error?.code).toBe("REGISTER_CLOSE_NOT_PENDING");
    });

    test("a closer who also holds the approve permission closes a large variance in one step", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      await enableRegisters(owner, "50.00");
      const registerId = await newRegister(owner);
      const supervisor = await seedPrincipal(owner.tenantId, "supervisor", [
        ...CASHIER_PERMISSIONS,
        "commerce.register_cash_ups.approve"
      ]);
      const sessionId = (await open(supervisor, registerId)).body.data.id;
      const closed = await close(
        supervisor,
        sessionId,
        { cash: "99000.00" },
        "short a lot"
      );
      expect(closed.status).toBe(200);
      expect(closed.body.data.outcome).toBe("closed");
      expect(closed.body.data.report.closeRequests[0]).toMatchObject({
        decision: "approved"
      });
    });

    test("a POS-only user holds none of the register permissions", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      await enableRegisters(owner);
      const registerId = await newRegister(owner);
      const posOnly = await seedPrincipal(owner.tenantId, "posonly", [
        "commerce.pos.create"
      ]);

      expect((await open(posOnly, registerId)).status).toBe(403);
      expect(
        (
          await invoke<Envelope>(listRegisters, {
            path: "/api/v1/commerce/registers",
            headers: headers(posOnly)
          })
        ).status
      ).toBe(403);
      expect(
        (
          await invoke<Envelope>(listSessions, {
            path: "/api/v1/commerce/register-sessions",
            headers: headers(posOnly)
          })
        ).status
      ).toBe(403);
    });

    test("handover: the current cashier hands over, a stranger cannot, the new cashier owns the drawer", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      await enableRegisters(owner);
      const registerId = await newRegister(owner);
      const first = await seedPrincipal(
        owner.tenantId,
        "first",
        CASHIER_PERMISSIONS
      );
      const second = await seedPrincipal(
        owner.tenantId,
        "second",
        CASHIER_PERMISSIONS
      );
      const sessionId = (await open(first, registerId)).body.data.id;

      const handover = (who: Principal, to: string) =>
        invoke<Envelope<SessionBody>>(postHandover, {
          method: "POST",
          path: `/api/v1/commerce/register-sessions/${sessionId}/handover`,
          headers: headers(who, key()),
          params: { id: sessionId },
          body: { toTenantUserId: to }
        });

      // `second` is not the cashier and holds no supervisor permission.
      expect((await handover(second, second.tenantUserId)).status).toBe(403);
      const done = await handover(first, second.tenantUserId);
      expect(done.status).toBe(200);
      expect(done.body.data.currentCashierTenantUserId).toBe(
        second.tenantUserId
      );
      expect((await handover(first, first.tenantUserId)).status).toBe(403);
      const unknown = await handover(
        second,
        "00000000-0000-4000-8000-000000000000"
      );
      expect(unknown.status).toBe(409);
      expect(unknown.body.error?.code).toBe("UNKNOWN_CASHIER");
      // The owner holds every permission, including the supervisor one.
      expect((await handover(owner, first.tenantUserId)).status).toBe(200);
    });

    test("POS through the route: a registerId is required while the feature is on, attaches the sale, and is refused once the session closes", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      const productId = await seedProduct(owner);

      const sale = (registerId: string | null) =>
        invoke<Envelope<{ registerSessionId: string | null; status: string }>>(
          postPosOrder,
          {
            method: "POST",
            path: "/api/v1/commerce/pos/orders",
            headers: headers(owner, key()),
            body: {
              lines: [{ productId, variantId: null, quantity: 2 }],
              payment: { method: "cash", amountTendered: "50000.00" },
              ...(registerId ? { registerId } : {})
            }
          }
        );

      // Feature OFF: today's POS, byte for byte.
      const plain = await sale(null);
      expect(plain.status).toBe(201);
      expect(plain.body.data.registerSessionId).toBeNull();

      await enableRegisters(owner);
      const registerId = await newRegister(owner);

      const required = await sale(null);
      expect(required.status).toBe(400);
      expect(required.body.error?.code).toBe("VALIDATION_ERROR");
      const noSession = await sale(registerId);
      expect(noSession.status).toBe(409);
      expect(noSession.body.error?.code).toBe("REGISTER_SESSION_REQUIRED");

      const sessionId = (await open(owner, registerId)).body.data.id;
      const attached = await sale(registerId);
      expect(attached.status).toBe(201);
      expect(attached.body.data.registerSessionId).toBe(sessionId);

      const unknownRegister = await sale(
        "00000000-0000-4000-8000-000000000000"
      );
      expect(unknownRegister.status).toBe(404);

      // 100000 float + 20000 cash sale.
      const closed = await close(owner, sessionId, { cash: "120000.00" });
      expect(closed.body.data.outcome).toBe("closed");
      const afterClose = await sale(registerId);
      expect(afterClose.status).toBe(409);
      expect(afterClose.body.error?.code).toBe("REGISTER_SESSION_REQUIRED");

      // Turning the feature off again: a register id is refused, not ignored.
      await invoke<Envelope>(patchModuleSettings, {
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
            register: false
          }
        }
      });
      const refused = await sale(registerId);
      expect(refused.status).toBe(409);
      expect(refused.body.error?.code).toBe("FEATURE_DISABLED");
      expect((await sale(null)).status).toBe(201);
    });

    test("the session list filters and paginates; an unknown session is the same 404 as another tenant's", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      await enableRegisters(owner);
      const r1 = await newRegister(owner, "R1");
      const r2 = await newRegister(owner, "R2");
      const s1 = (await open(owner, r1)).body.data.id;
      await open(owner, r2);
      await close(owner, s1, { cash: "100000.00" });

      const all = await invoke<
        Envelope<{ items: SessionBody[]; nextCursor: string | null }>
      >(listSessions, {
        path: "/api/v1/commerce/register-sessions",
        headers: headers(owner)
      });
      expect(all.body.data.items).toHaveLength(2);
      const open1 = await invoke<Envelope<{ items: SessionBody[] }>>(
        listSessions,
        {
          path: "/api/v1/commerce/register-sessions?status=open",
          headers: headers(owner)
        }
      );
      expect(open1.body.data.items).toHaveLength(1);
      const byRegister = await invoke<Envelope<{ items: SessionBody[] }>>(
        listSessions,
        {
          path: `/api/v1/commerce/register-sessions?registerId=${r1}`,
          headers: headers(owner)
        }
      );
      expect(byRegister.body.data.items.map((s) => s.id)).toEqual([s1]);
      expect(
        (
          await invoke<Envelope>(listSessions, {
            path: "/api/v1/commerce/register-sessions?status=bogus",
            headers: headers(owner)
          })
        ).status
      ).toBe(400);
      expect(
        (
          await invoke<Envelope>(getSession, {
            path: "/api/v1/commerce/register-sessions/00000000-0000-4000-8000-000000000000",
            headers: headers(owner),
            params: { id: "00000000-0000-4000-8000-000000000000" }
          })
        ).status
      ).toBe(404);
    });
  }
);
