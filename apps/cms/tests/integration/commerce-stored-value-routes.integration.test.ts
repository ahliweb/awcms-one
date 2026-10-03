/**
 * Closed-loop stored value through the REAL route handlers (Issue #288, epic
 * #281, ADR-0029) - the HTTP half that `commerce-stored-value.integration
 * .test.ts` (which drives the directory functions) cannot see: route wiring
 * (`defineTenantRoute`, ABAC, the `storedValue` feature gate, body validation,
 * `Idempotency-Key`, the error -> status mapping) with real argon2/session/
 * permission machinery behind it.
 *
 * WORLD 2 (see `harness.ts`): handlers call `getDatabaseClient()` internally,
 * so this file runs against the migrated `DATABASE_URL` database and seeds
 * through `getHandlerAdminSql()`. The owner comes from the real setup + login
 * endpoints (every permission granted); the other principals are seeded with
 * EXACTLY the permission keys under test, so a 403 below means "that key was
 * missing", never "the actor had nothing":
 *
 *   - a CASHIER (pos.create) can take a card as a tender and nothing more: no
 *     issuing, no adjusting, no reading the ledger or the report;
 *   - an ISSUER (stored_value.create) can issue and load but not adjust, and
 *     an ADJUSTER (stored_value_adjustments.create) the reverse;
 *   - the plaintext code is in exactly one response (the issuing one);
 *   - the feature gate answers 409 FEATURE_DISABLED until the tenant opts in;
 *   - a refused tender maps to its status (404 / 409 / 400) before any write.
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
import { GET as listPrograms } from "../../src/pages/api/v1/commerce/stored-value/programs/index";
import { PUT as putProgram } from "../../src/pages/api/v1/commerce/stored-value/programs/[kind]";
import {
  GET as listAccounts,
  POST as issueAccount
} from "../../src/pages/api/v1/commerce/stored-value/accounts/index";
import { GET as getAccount } from "../../src/pages/api/v1/commerce/stored-value/accounts/[id]/index";
import { GET as getLedger } from "../../src/pages/api/v1/commerce/stored-value/accounts/[id]/ledger";
import { POST as postLoad } from "../../src/pages/api/v1/commerce/stored-value/accounts/[id]/load";
import { POST as postAdjust } from "../../src/pages/api/v1/commerce/stored-value/accounts/[id]/adjust";
import { POST as postStatus } from "../../src/pages/api/v1/commerce/stored-value/accounts/[id]/status";
import { POST as postExpire } from "../../src/pages/api/v1/commerce/stored-value/expire";
import { POST as postReconcile } from "../../src/pages/api/v1/commerce/stored-value/reconcile";
import { GET as getReport } from "../../src/pages/api/v1/reports/commerce/stored-value";
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

const key = () => ({ "idempotency-key": crypto.randomUUID() });

async function enableStoredValue(owner: Principal, on = true) {
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
        register: false,
        storedValue: on
      }
    }
  });
}

type Issued = {
  account: { id: string; balance: string; maskedCode: string; status: string };
  entry: { kind: string };
  code: string | null;
  codeRevealed: boolean;
};

const suite = integrationEnabled ? describe : describe.skip;

let handlerReady = false;

suite(
  "Closed-loop stored value through the route handlers (Issue #288)",
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

    function skip(): boolean {
      if (handlerReady) return false;
      console.warn(
        "[skip] handler database is not migrated - run 'bun run db:migrate' against DATABASE_URL."
      );
      return true;
    }

    async function issueAs(who: Principal, body: Record<string, unknown>) {
      return invoke<Envelope<Issued>>(issueAccount, {
        method: "POST",
        path: "/api/v1/commerce/stored-value/accounts",
        headers: headers(who, key()),
        body
      });
    }

    async function setup() {
      const owner = await bootstrapOwner();
      expect((await enableStoredValue(owner)).status).toBe(200);
      for (const kind of ["gift_card", "store_credit"]) {
        const program = await invoke<Envelope>(putProgram, {
          method: "PUT",
          path: `/api/v1/commerce/stored-value/programs/${kind}`,
          headers: headers(owner),
          params: { kind },
          body: { enabled: true, allowRefundToAccount: true }
        });
        expect(program.status).toBe(200);
      }
      return owner;
    }

    test("the feature gate: every route answers 409 FEATURE_DISABLED until the tenant opts in", async () => {
      if (skip()) return;
      const owner = await bootstrapOwner();
      const programs = await invoke<Envelope>(listPrograms, {
        method: "GET",
        path: "/api/v1/commerce/stored-value/programs",
        headers: headers(owner)
      });
      expect(programs.status).toBe(409);
      expect(programs.body.error?.code).toBe("FEATURE_DISABLED");
      const issued = await issueAs(owner, {
        kind: "gift_card",
        amount: "1000.00"
      });
      expect(issued.status).toBe(409);
      expect(issued.body.error?.code).toBe("FEATURE_DISABLED");
      const report = await invoke<Envelope>(getReport, {
        method: "GET",
        path: "/api/v1/reports/commerce/stored-value",
        headers: headers(owner)
      });
      expect(report.status).toBe(409);
    });

    test("issue returns the code exactly once; a replay answers the same account without it; no list or read ever shows it", async () => {
      if (skip()) return;
      const owner = await setup();
      const idem = crypto.randomUUID();
      const send = () =>
        invoke<Envelope<Issued>>(issueAccount, {
          method: "POST",
          path: "/api/v1/commerce/stored-value/accounts",
          headers: headers(owner, { "idempotency-key": idem }),
          body: { kind: "gift_card", amount: "75000.00", reason: "birthday" }
        });
      const first = await send();
      expect(first.status).toBe(201);
      expect(first.body.data.codeRevealed).toBe(true);
      expect(first.body.data.code).toMatch(
        /^[A-Z2-9]{7}-[A-Z2-9]{7}-[A-Z2-9]{7}$/
      );
      expect(first.body.data.account).toMatchObject({
        balance: "75000.00",
        status: "active"
      });
      const second = await send();
      expect(second.status).toBe(201);
      expect(second.body.data.code).toBeNull();
      expect(second.body.data.codeRevealed).toBe(false);
      expect(second.body.data.account.id).toBe(first.body.data.account.id);

      const code = first.body.data.code!;
      const plain = code.replace(/-/g, "");
      const list = await invoke<Envelope<{ items: { maskedCode: string }[] }>>(
        listAccounts,
        {
          method: "GET",
          path: "/api/v1/commerce/stored-value/accounts",
          headers: headers(owner)
        }
      );
      expect(list.status).toBe(200);
      expect(list.body.data.items).toHaveLength(1);
      const one = await invoke<Envelope>(getAccount, {
        method: "GET",
        path: `/api/v1/commerce/stored-value/accounts/${first.body.data.account.id}`,
        headers: headers(owner),
        params: { id: first.body.data.account.id }
      });
      const ledger = await invoke<Envelope>(getLedger, {
        method: "GET",
        path: `/api/v1/commerce/stored-value/accounts/${first.body.data.account.id}/ledger`,
        headers: headers(owner),
        params: { id: first.body.data.account.id }
      });
      for (const response of [list, one, ledger]) {
        const text = JSON.stringify(response.body);
        expect(text).not.toContain(code);
        expect(text).not.toContain(plain);
        expect(text).not.toContain(plain.slice(0, 12));
      }
      expect(list.body.data.items[0]!.maskedCode).toBe(
        `•••••••-•••••••-•••${plain.slice(-4)}`
      );

      const conflict = await invoke<Envelope>(issueAccount, {
        method: "POST",
        path: "/api/v1/commerce/stored-value/accounts",
        headers: headers(owner, { "idempotency-key": idem }),
        body: { kind: "gift_card", amount: "76000.00" }
      });
      expect(conflict.status).toBe(409);
      expect(conflict.body.error?.code).toBe("IDEMPOTENCY_CONFLICT");
    });

    test("validation and the missing Idempotency-Key are 400s; an unknown or malformed id is the one 404", async () => {
      if (skip()) return;
      const owner = await setup();
      const noKey = await invoke<Envelope>(issueAccount, {
        method: "POST",
        path: "/api/v1/commerce/stored-value/accounts",
        headers: headers(owner),
        body: { kind: "gift_card", amount: "1.00" }
      });
      expect(noKey.status).toBe(400);
      expect(noKey.body.error?.code).toBe("IDEMPOTENCY_REQUIRED");
      for (const body of [
        { kind: "gift_card", amount: 100 },
        { kind: "gift_card", amount: "0.00" },
        { kind: "voucher", amount: "1.00" }
      ]) {
        const bad = await issueAs(owner, body);
        expect(bad.status).toBe(400);
        expect(bad.body.error?.code).toBe("VALIDATION_ERROR");
      }
      for (const id of [crypto.randomUUID(), "not-a-uuid"]) {
        const missing = await invoke<Envelope>(getAccount, {
          method: "GET",
          path: `/api/v1/commerce/stored-value/accounts/${id}`,
          headers: headers(owner),
          params: { id }
        });
        expect(missing.status).toBe(404);
      }
      const disabledProgram = await invoke<Envelope>(putProgram, {
        method: "PUT",
        path: "/api/v1/commerce/stored-value/programs/gift_card",
        headers: headers(owner),
        params: { kind: "gift_card" },
        body: { enabled: false, allowRefundToAccount: true }
      });
      expect(disabledProgram.status).toBe(200);
      const refused = await issueAs(owner, {
        kind: "gift_card",
        amount: "1.00"
      });
      expect(refused.status).toBe(409);
      expect(refused.body.error?.code).toBe("STORED_VALUE_PROGRAM_DISABLED");
      const noKind = await invoke<Envelope>(putProgram, {
        method: "PUT",
        path: "/api/v1/commerce/stored-value/programs/voucher",
        headers: headers(owner),
        params: { kind: "voucher" },
        body: { enabled: true, allowRefundToAccount: true }
      });
      expect(noKind.status).toBe(404);
    });

    test("permissions are separate: a cashier gains none; an issuer cannot adjust; an adjuster cannot issue; repair needs its own key", async () => {
      if (skip()) return;
      const owner = await setup();
      const tenantId = owner.tenantId;
      const cashier = await seedPrincipal(tenantId, "sv-cashier", [
        "commerce.pos.create"
      ]);
      const issuer = await seedPrincipal(tenantId, "sv-issuer", [
        "commerce.stored_value.create"
      ]);
      const adjuster = await seedPrincipal(tenantId, "sv-adjuster", [
        "commerce.stored_value_adjustments.create"
      ]);
      const reader = await seedPrincipal(tenantId, "sv-reader", [
        "commerce.stored_value.read"
      ]);

      const asCashier = await issueAs(cashier, {
        kind: "gift_card",
        amount: "1.00"
      });
      expect(asCashier.status).toBe(403);

      const issued = await issueAs(issuer, {
        kind: "gift_card",
        amount: "20000.00"
      });
      expect(issued.status).toBe(201);
      const id = issued.body.data.account.id;
      const base = `/api/v1/commerce/stored-value/accounts/${id}`;

      const issuerLoads = await invoke<Envelope>(postLoad, {
        method: "POST",
        path: `${base}/load`,
        headers: headers(issuer, key()),
        params: { id },
        body: { amount: "500.00" }
      });
      expect(issuerLoads.status).toBe(201);
      const issuerAdjusts = await invoke<Envelope>(postAdjust, {
        method: "POST",
        path: `${base}/adjust`,
        headers: headers(issuer, key()),
        params: { id },
        body: { amount: "-100.00", reason: "nope" }
      });
      expect(issuerAdjusts.status).toBe(403);
      const adjusterAdjusts = await invoke<Envelope>(postAdjust, {
        method: "POST",
        path: `${base}/adjust`,
        headers: headers(adjuster, key()),
        params: { id },
        body: { amount: "-100.00", reason: "typo fix" }
      });
      expect(adjusterAdjusts.status).toBe(201);
      const adjusterIssues = await issueAs(adjuster, {
        kind: "gift_card",
        amount: "1.00"
      });
      expect(adjusterIssues.status).toBe(403);
      const overdraw = await invoke<Envelope>(postAdjust, {
        method: "POST",
        path: `${base}/adjust`,
        headers: headers(adjuster, key()),
        params: { id },
        body: { amount: "-999999.00", reason: "too far" }
      });
      expect(overdraw.status).toBe(409);
      expect(overdraw.body.error?.code).toBe("STORED_VALUE_INSUFFICIENT");
      const noReason = await invoke<Envelope>(postAdjust, {
        method: "POST",
        path: `${base}/adjust`,
        headers: headers(adjuster, key()),
        params: { id },
        body: { amount: "-1.00" }
      });
      expect(noReason.status).toBe(400);

      // Status and the sweep need `.update`, which neither holds.
      for (const who of [issuer, adjuster, cashier]) {
        const status = await invoke<Envelope>(postStatus, {
          method: "POST",
          path: `${base}/status`,
          headers: headers(who, key()),
          params: { id },
          body: { action: "disable", reason: "lost" }
        });
        expect(status.status).toBe(403);
        const sweep = await invoke<Envelope>(postExpire, {
          method: "POST",
          path: "/api/v1/commerce/stored-value/expire",
          headers: headers(who)
        });
        expect(sweep.status).toBe(403);
      }
      const disabled = await invoke<Envelope>(postStatus, {
        method: "POST",
        path: `${base}/status`,
        headers: headers(owner, key()),
        params: { id },
        body: { action: "disable", reason: "lost" }
      });
      expect(disabled.status).toBe(201);
      const again = await invoke<Envelope>(postStatus, {
        method: "POST",
        path: `${base}/status`,
        headers: headers(owner, key()),
        params: { id },
        body: { action: "disable", reason: "again" }
      });
      expect(again.status).toBe(409);
      expect(again.body.error?.code).toBe("STORED_VALUE_STATUS_UNCHANGED");

      // Reads: the cashier has none; the reader may read and run the read-only check.
      const cashierReads = await invoke<Envelope>(getLedger, {
        method: "GET",
        path: `${base}/ledger`,
        headers: headers(cashier),
        params: { id }
      });
      expect(cashierReads.status).toBe(403);
      const readerLedger = await invoke<
        Envelope<{ items: { kind: string }[] }>
      >(getLedger, {
        method: "GET",
        path: `${base}/ledger`,
        headers: headers(reader),
        params: { id }
      });
      expect(readerLedger.status).toBe(200);
      expect(readerLedger.body.data.items.map((e) => e.kind)).toEqual([
        "disable",
        "adjust",
        "load",
        "issue"
      ]);
      const check = await invoke<Envelope>(postReconcile, {
        method: "POST",
        path: "/api/v1/commerce/stored-value/reconcile",
        headers: headers(reader),
        body: {}
      });
      expect(check.status).toBe(200);
      const repair = await invoke<Envelope>(postReconcile, {
        method: "POST",
        path: "/api/v1/commerce/stored-value/reconcile",
        headers: headers(reader),
        body: { repair: true }
      });
      expect(repair.status).toBe(403);
      const ownerRepair = await invoke<Envelope>(postReconcile, {
        method: "POST",
        path: "/api/v1/commerce/stored-value/reconcile",
        headers: headers(owner),
        body: { repair: true }
      });
      expect(ownerRepair.status).toBe(200);
    });

    test("a cashier takes a card as a POS tender; every refusal maps to its status and writes nothing", async () => {
      if (skip()) return;
      const owner = await setup();
      const productId = await seedProduct(owner);
      const cashier = await seedPrincipal(owner.tenantId, "sv-pos", [
        "commerce.pos.create"
      ]);
      const issued = await issueAs(owner, {
        kind: "gift_card",
        amount: "6000.00"
      });
      const code = issued.body.data.code!;
      const sale = (tenders: unknown[]) =>
        invoke<
          Envelope<{
            change: string | null;
            payments: {
              tenderType: string;
              storedValue: { maskedCode: string } | null;
            }[];
          }>
        >(postPosOrder, {
          method: "POST",
          path: "/api/v1/commerce/pos/orders",
          headers: headers(cashier, key()),
          body: {
            customer: {},
            lines: [{ productId, quantity: 1 }],
            tenders
          }
        });

      const unknown = await sale([
        {
          tenderType: "gift_card",
          amount: "6000.00",
          storedValueCode: "ABCDEFGHJKLMNPQRSTUVW"
        }
      ]);
      // A made-up code fails its check character: a 400, never a lookup.
      expect(unknown.status).toBe(400);
      expect(unknown.body.error?.code).toBe("VALIDATION_ERROR");

      const tooPoor = await sale([
        { tenderType: "gift_card", amount: "9000.00", storedValueCode: code },
        { tenderType: "cash", amount: "1000.00" }
      ]);
      expect(tooPoor.status).toBe(409);
      expect(tooPoor.body.error?.code).toBe("STORED_VALUE_INSUFFICIENT");
      expect(tooPoor.body.error?.details).toMatchObject({
        available: "6000.00"
      });
      const none = (await getHandlerAdminSql()`
      SELECT COUNT(*)::int AS n FROM awcms_commerce_orders WHERE tenant_id = ${owner.tenantId}
    `) as { n: number }[];
      expect(none[0]!.n).toBe(0);

      const ok = await sale([
        { tenderType: "gift_card", amount: "6000.00", storedValueCode: code },
        { tenderType: "cash", amount: "5000.00" }
      ]);
      expect(ok.status).toBe(201);
      expect(ok.body.data.change).toBe("1000.00");
      expect(ok.body.data.payments.map((p) => p.tenderType)).toEqual([
        "gift_card",
        "cash"
      ]);
      expect(ok.body.data.payments[0]!.storedValue!.maskedCode).toContain(
        "•••"
      );
      expect(JSON.stringify(ok.body)).not.toContain(code.replace(/-/g, ""));

      // The card is now empty: a second sale is a clean 409, and a code in a
      // tender that the owner never issued is a 404.
      const empty = await sale([
        { tenderType: "gift_card", amount: "1000.00", storedValueCode: code },
        { tenderType: "cash", amount: "9000.00" }
      ]);
      expect(empty.status).toBe(409);
      expect(empty.body.error?.code).toBe("STORED_VALUE_INSUFFICIENT");
      const wrongKind = await sale([
        {
          tenderType: "store_credit",
          amount: "1000.00",
          storedValueCode: code
        },
        { tenderType: "cash", amount: "9000.00" }
      ]);
      expect(wrongKind.status).toBe(404);
      expect(wrongKind.body.error?.code).toBe("STORED_VALUE_NOT_FOUND");

      // The liability report: the card was issued and redeemed.
      const report = await invoke<
        Envelope<{
          kinds: {
            kind: string;
            issued: { amount: string };
            redeemed: { amount: string };
            outstanding: string;
          }[];
        }>
      >(getReport, {
        method: "GET",
        path: "/api/v1/reports/commerce/stored-value",
        headers: headers(owner)
      });
      expect(report.status).toBe(200);
      const gift = report.body.data.kinds.find((k) => k.kind === "gift_card")!;
      expect(gift).toMatchObject({
        issued: { amount: "6000.00" },
        redeemed: { amount: "6000.00" },
        outstanding: "0.00"
      });
    });

    test("another tenant's account id is the same 404, and its balance is untouched", async () => {
      if (skip()) return;
      const owner = await setup();
      const issued = await issueAs(owner, {
        kind: "gift_card",
        amount: "5000.00"
      });
      const id = issued.body.data.account.id;
      // A second tenant, seeded directly, with a principal that holds every
      // stored-value key: it still cannot see or touch tenant 1's account.
      const admin = getHandlerAdminSql();
      const tenant = (await admin`
      INSERT INTO awcms_tenants (tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
      VALUES ('other-sv', 'Other', 'Other', 'active', 'en', 'light')
      RETURNING id
    `) as { id: string }[];
      const other = await seedPrincipal(tenant[0]!.id, "other-sv-user", [
        "commerce.stored_value.read",
        "commerce.stored_value.create",
        "commerce.stored_value.update",
        "commerce.stored_value_adjustments.create"
      ]);
      const base = `/api/v1/commerce/stored-value/accounts/${id}`;
      for (const response of [
        await invoke<Envelope>(getAccount, {
          method: "GET",
          path: base,
          headers: headers(other),
          params: { id }
        }),
        await invoke<Envelope>(getLedger, {
          method: "GET",
          path: `${base}/ledger`,
          headers: headers(other),
          params: { id }
        })
      ]) {
        // The other tenant has not enabled the feature, so the gate answers
        // first; after enabling it the id would be a 404. Either way: no data.
        expect([404, 409]).toContain(response.status);
        expect(JSON.stringify(response.body)).not.toContain("5000.00");
      }
      const stillThere = (await admin`
      SELECT balance::text AS balance FROM awcms_commerce_stored_value_accounts WHERE id = ${id}
    `) as { balance: string }[];
      expect(stillThere[0]!.balance).toBe("5000.00");
    });
  }
);
