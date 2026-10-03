/**
 * Commerce-local petty cash and register-linked expenses through the REAL route
 * handlers (Issue #294, epic #281, ADR-0031): route wiring (`defineTenantRoute`,
 * ABAC, the `expenses` / `register` feature gates, body validation,
 * `Idempotency-Key`, the refusal -> status mapping) with real
 * argon2/session/permission machinery and a real, migrated PostgreSQL behind it.
 *
 * WORLD 2 (see `harness.ts`): handlers call `getDatabaseClient()` internally, so
 * this file runs against the migrated `DATABASE_URL` database and seeds through
 * `getHandlerAdminSql()`. The owner comes from the real setup + login endpoints
 * (every permission granted); every other principal is seeded with EXACTLY the
 * permission keys under test, so a 403 below means "that key was missing", never
 * "the actor had nothing".
 *
 * What this proves, in the issue's own words:
 *
 *   - a posted drawer expense is reflected in the cash-up EXACTLY ONCE (the
 *     derived expected cash moves by the amount, a replay and a second post
 *     change nothing), and a reversal compensates with a second movement while
 *     the original row stays;
 *   - the approval threshold and segregation of duties are enforced, not
 *     conventions: a creator can never approve their own expense above it;
 *   - a receipt is a PRIVATE object, reachable only through its own permission,
 *     and only the object attached to that expense;
 *   - RLS / BOLA: another tenant's ids are 404s everywhere;
 *   - idempotent post / reverse, exact money, audit redaction, the CSV, and the
 *     feature flag that defaults OFF.
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
  assertRejected,
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
import { POST as createRegister } from "../../src/pages/api/v1/commerce/registers/index";
import { POST as openSession } from "../../src/pages/api/v1/commerce/register-sessions/index";
import { GET as getSession } from "../../src/pages/api/v1/commerce/register-sessions/[id]/index";
import { POST as postMovement } from "../../src/pages/api/v1/commerce/register-sessions/[id]/movements";
import { POST as postClose } from "../../src/pages/api/v1/commerce/register-sessions/[id]/close";
import {
  GET as listCategories,
  POST as createCategory
} from "../../src/pages/api/v1/commerce/expense-categories/index";
import {
  GET as getCategory,
  PATCH as patchCategory
} from "../../src/pages/api/v1/commerce/expense-categories/[id]";
import {
  GET as listExpenses,
  POST as createExpense
} from "../../src/pages/api/v1/commerce/expenses/index";
import {
  GET as getExpense,
  PATCH as patchExpense
} from "../../src/pages/api/v1/commerce/expenses/[id]/index";
import { POST as postExpense } from "../../src/pages/api/v1/commerce/expenses/[id]/post";
import { POST as decideExpense } from "../../src/pages/api/v1/commerce/expenses/[id]/decision";
import { POST as reverseExpense } from "../../src/pages/api/v1/commerce/expenses/[id]/reverse";
import { POST as cancelExpense } from "../../src/pages/api/v1/commerce/expenses/[id]/cancel";
import { POST as attachReceipt } from "../../src/pages/api/v1/commerce/expenses/[id]/receipt";
import { GET as getReceiptUrl } from "../../src/pages/api/v1/commerce/expenses/[id]/receipt-url";
import { GET as getSummary } from "../../src/pages/api/v1/commerce/expenses/summary";
import { GET as getExportCsv } from "../../src/pages/api/v1/commerce/expenses/export.csv";

const OWNER_PASSWORD = "integration-test-owner-password";
const TODAY = new Date().toISOString().slice(0, 10);

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

/** A second, unrelated tenant (RLS / BOLA subject), inserted directly. */
async function seedTenant(code: string): Promise<string> {
  const rows = (await getHandlerAdminSql()`
    INSERT INTO awcms_tenants
      (tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${code}, ${code + " Name"}, ${code + " Legal"}, 'active', 'en', 'light')
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
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

type ExpenseBody = {
  id: string;
  status: string;
  amount: string;
  tenderType: string;
  registerSessionId: string | null;
  hasReceipt: boolean;
  decision: string | null;
  decidedByTenantUserId: string | null;
  createdByTenantUserId: string;
  postedMovementId: string | null;
  reversalMovementId: string | null;
  reversalSessionId: string | null;
  decisionNote: string | null;
};
type ActionBody = { expense: ExpenseBody; outcome: string };
type SessionBody = { id: string; status: string };
type ReportBody = {
  session: SessionBody;
  tenders: { tenderType: string; expected: string }[];
  movements: {
    movementType: string;
    direction: string;
    amount: string;
    reference: string | null;
  }[];
};

const key = () => ({ "idempotency-key": crypto.randomUUID() });

const CLERK_PERMISSIONS = [
  "commerce.expenses.read",
  "commerce.expenses.create",
  "commerce.expenses.update",
  "commerce.expense_postings.create",
  "commerce.expense_receipts.create",
  "commerce.expense_categories.read",
  "commerce.register_sessions.read"
];
const SUPERVISOR_PERMISSIONS = [
  "commerce.expenses.read",
  "commerce.expenses.update",
  "commerce.expense_postings.create",
  "commerce.expense_postings.approve",
  "commerce.expense_reversals.approve",
  "commerce.expense_receipts.read"
];
const ALL_EXPENSE_PERMISSIONS = [
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
  "commerce.expense_receipts.create",
  "module_management.settings.update"
];

async function configureTenant(
  who: Principal,
  options: { expenses: boolean; register: boolean; threshold?: string }
) {
  return invoke<Envelope>(patchModuleSettings, {
    method: "PATCH",
    path: "/api/v1/tenant/modules/commerce/settings",
    headers: headers(who),
    params: { moduleKey: "commerce" },
    body: {
      features: {
        pos: true,
        inbox: true,
        campaigns: true,
        gateway: true,
        courier: true,
        register: options.register,
        expenses: options.expenses
      },
      cashUp: { approvalThreshold: "500000.00" },
      expenses: { approvalThreshold: options.threshold ?? "50000.00" }
    }
  });
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

const R2_ENV = {
  NEWS_MEDIA_R2_ENABLED: "true",
  NEWS_MEDIA_R2_ACCOUNT_ID: "acct-test",
  NEWS_MEDIA_R2_ACCESS_KEY_ID: "key-test",
  NEWS_MEDIA_R2_SECRET_ACCESS_KEY: "secret-test",
  NEWS_MEDIA_R2_BUCKET: "bucket-test",
  NEWS_MEDIA_R2_PUBLIC_BASE_URL: "https://media.example.test"
} as const;

suite(
  "Register-linked expenses through the route handlers (Issue #294)",
  () => {
    const savedEnv: Record<string, string | undefined> = {};

    beforeAll(async () => {
      handlerReady = await ensureHandlerDatabaseReady();
      for (const [name, value] of Object.entries(R2_ENV)) {
        savedEnv[name] = process.env[name];
        process.env[name] = value;
      }
    });

    afterAll(async () => {
      for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await teardownHandlerDatabase();
    });

    beforeEach(async () => {
      if (!handlerReady) return;
      await resetHandlerDatabase();
    });

    // -- helpers --------------------------------------------------------------

    async function world(options?: {
      register?: boolean;
      expenses?: boolean;
      threshold?: string;
    }) {
      const owner = await bootstrapOwner();
      const configured = await configureTenant(owner, {
        expenses: options?.expenses ?? true,
        register: options?.register ?? true,
        threshold: options?.threshold
      });
      expect(configured.status).toBe(200);
      const clerk = await seedPrincipal(
        owner.tenantId,
        "clerk",
        CLERK_PERMISSIONS
      );
      const supervisor = await seedPrincipal(
        owner.tenantId,
        "supervisor",
        SUPERVISOR_PERMISSIONS
      );
      return { owner, clerk, supervisor };
    }

    async function newCategory(who: Principal, code = "ICE"): Promise<string> {
      const created = await invoke<Envelope<{ id: string }>>(createCategory, {
        method: "POST",
        path: "/api/v1/commerce/expense-categories",
        headers: headers(who),
        body: { code, name: `Category ${code}` }
      });
      expect(created.status).toBe(201);
      return created.body.data.id;
    }

    async function openDrawer(
      who: Principal,
      code = "KASIR-1",
      openingFloat = "100000.00"
    ): Promise<{ registerId: string; sessionId: string }> {
      const register = await invoke<Envelope<{ id: string }>>(createRegister, {
        method: "POST",
        path: "/api/v1/commerce/registers",
        headers: headers(who),
        body: { code, name: `Register ${code}` }
      });
      expect(register.status).toBe(201);
      const session = await invoke<Envelope<SessionBody>>(openSession, {
        method: "POST",
        path: "/api/v1/commerce/register-sessions",
        headers: headers(who, key()),
        body: { registerId: register.body.data.id, openingFloat }
      });
      expect(session.status).toBe(201);
      return {
        registerId: register.body.data.id,
        sessionId: session.body.data.id
      };
    }

    function draft(
      who: Principal,
      categoryId: string,
      over: Record<string, unknown> = {},
      idempotency: Record<string, string> = key()
    ) {
      return invoke<Envelope<ExpenseBody>>(createExpense, {
        method: "POST",
        path: "/api/v1/commerce/expenses",
        headers: headers(who, idempotency),
        body: {
          categoryId,
          amount: "25000.00",
          tenderType: "cash",
          occurredOn: TODAY,
          description: "Ice for the cooler",
          payeeName: null,
          registerSessionId: null,
          ...over
        }
      });
    }

    function post(
      who: Principal,
      expenseId: string,
      idempotency: Record<string, string> = key()
    ) {
      return invoke<Envelope<ActionBody>>(postExpense, {
        method: "POST",
        path: `/api/v1/commerce/expenses/${expenseId}/post`,
        headers: headers(who, idempotency),
        params: { id: expenseId }
      });
    }

    function decide(
      who: Principal,
      expenseId: string,
      body: Record<string, unknown>,
      idempotency: Record<string, string> = key()
    ) {
      return invoke<Envelope<ActionBody>>(decideExpense, {
        method: "POST",
        path: `/api/v1/commerce/expenses/${expenseId}/decision`,
        headers: headers(who, idempotency),
        params: { id: expenseId },
        body
      });
    }

    function reverse(
      who: Principal,
      expenseId: string,
      reason = "Entered twice",
      idempotency: Record<string, string> = key()
    ) {
      return invoke<Envelope<ActionBody>>(reverseExpense, {
        method: "POST",
        path: `/api/v1/commerce/expenses/${expenseId}/reverse`,
        headers: headers(who, idempotency),
        params: { id: expenseId },
        body: { reason }
      });
    }

    async function report(
      who: Principal,
      sessionId: string
    ): Promise<ReportBody> {
      const result = await invoke<Envelope<ReportBody>>(getSession, {
        path: `/api/v1/commerce/register-sessions/${sessionId}`,
        headers: headers(who),
        params: { id: sessionId }
      });
      expect(result.status).toBe(200);
      return result.body.data;
    }

    const expectedCash = (r: ReportBody): string =>
      r.tenders.find((tender) => tender.tenderType === "cash")!.expected;

    async function movementRows(expenseId: string) {
      return (await getHandlerAdminSql()`
      SELECT movement_type, direction, amount::text AS amount, reference_kind,
             session_id, actor_tenant_user_id, source_key
      FROM awcms_commerce_register_movements
      WHERE expense_id = ${expenseId}
      ORDER BY direction DESC
    `) as {
        movement_type: string;
        direction: string;
        amount: string;
        reference_kind: string;
        session_id: string;
        actor_tenant_user_id: string;
        source_key: string;
      }[];
    }

    /** A verified media object, private unless told otherwise, uploaded by `uploader`. */
    async function seedMedia(
      tenantId: string,
      uploader: string,
      visibility: "private" | "public" = "private"
    ): Promise<string> {
      const id = crypto.randomUUID();
      const objectKey = `news-media/${tenantId}/2026/10/${id}.pdf`;
      const rows = (await getHandlerAdminSql()`
      INSERT INTO awcms_news_media_objects
        (id, tenant_id, bucket_name, object_key, public_url, mime_type, status,
         visibility, created_by_tenant_user_id)
      VALUES (
        ${id}, ${tenantId}, 'bucket-test', ${objectKey},
        ${visibility === "public" ? `https://media.example.test/${objectKey}` : null},
        'application/pdf', 'verified', ${visibility}, ${uploader}
      )
      RETURNING id
    `) as { id: string }[];
      return rows[0]!.id;
    }

    // -- tests ----------------------------------------------------------------

    test("the feature flag defaults OFF: every expense route is 409 FEATURE_DISABLED until the tenant opts in, and a drawer expense also needs the register feature", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      const uuid = "00000000-0000-4000-8000-000000000000";

      const calls = [
        await invoke<Envelope>(listCategories, {
          path: "/api/v1/commerce/expense-categories",
          headers: headers(owner)
        }),
        await invoke<Envelope>(createCategory, {
          method: "POST",
          path: "/api/v1/commerce/expense-categories",
          headers: headers(owner),
          body: { code: "X", name: "X" }
        }),
        await invoke<Envelope>(listExpenses, {
          path: "/api/v1/commerce/expenses",
          headers: headers(owner)
        }),
        await invoke<Envelope>(createExpense, {
          method: "POST",
          path: "/api/v1/commerce/expenses",
          headers: headers(owner, key()),
          body: {
            categoryId: uuid,
            amount: "1.00",
            tenderType: "cash",
            occurredOn: TODAY,
            description: "x"
          }
        }),
        await invoke<Envelope>(getSummary, {
          path: `/api/v1/commerce/expenses/summary?from=${TODAY}&to=${TODAY}`,
          headers: headers(owner)
        }),
        await invoke<Envelope>(postExpense, {
          method: "POST",
          path: `/api/v1/commerce/expenses/${uuid}/post`,
          headers: headers(owner, key()),
          params: { id: uuid }
        })
      ];
      for (const result of calls) {
        expect(result.status).toBe(409);
        expect(result.body.error?.code).toBe("FEATURE_DISABLED");
      }

      // Expenses ON, register OFF: a plain expense works, a drawer one is refused.
      expect(
        (await configureTenant(owner, { expenses: true, register: false }))
          .status
      ).toBe(200);
      const categoryId = await newCategory(owner);
      expect((await draft(owner, categoryId)).status).toBe(201);
      const drawer = await draft(owner, categoryId, {
        registerSessionId: uuid
      });
      expect(drawer.status).toBe(409);
      expect(drawer.body.error?.code).toBe("FEATURE_DISABLED");
    });

    test("categories: create, duplicate code (case-insensitive), get, patch, an inactive category takes no new expense", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner } = await world();

      const categoryId = await newCategory(owner, "ICE");
      const dup = await invoke<Envelope>(createCategory, {
        method: "POST",
        path: "/api/v1/commerce/expense-categories",
        headers: headers(owner),
        body: { code: "ice", name: "Another" }
      });
      expect(dup.status).toBe(409);
      expect(dup.body.error?.code).toBe("EXPENSE_CATEGORY_CODE_TAKEN");

      const bad = await invoke<Envelope>(createCategory, {
        method: "POST",
        path: "/api/v1/commerce/expense-categories",
        headers: headers(owner),
        body: { code: "-nope", name: "" }
      });
      expect(bad.status).toBe(400);

      const fetched = await invoke<Envelope<{ code: string; active: boolean }>>(
        getCategory,
        {
          path: `/api/v1/commerce/expense-categories/${categoryId}`,
          headers: headers(owner),
          params: { id: categoryId }
        }
      );
      expect(fetched.body.data).toMatchObject({ code: "ICE", active: true });

      const codeChange = await invoke<Envelope>(patchCategory, {
        method: "PATCH",
        path: `/api/v1/commerce/expense-categories/${categoryId}`,
        headers: headers(owner),
        params: { id: categoryId },
        body: { code: "NEW" }
      });
      expect(codeChange.status).toBe(400);

      const deactivated = await invoke<Envelope<{ active: boolean }>>(
        patchCategory,
        {
          method: "PATCH",
          path: `/api/v1/commerce/expense-categories/${categoryId}`,
          headers: headers(owner),
          params: { id: categoryId },
          body: { active: false }
        }
      );
      expect(deactivated.body.data.active).toBe(false);

      const refused = await draft(owner, categoryId);
      expect(refused.status).toBe(409);
      expect(refused.body.error?.code).toBe("EXPENSE_CATEGORY_INACTIVE");

      const list = await invoke<Envelope<{ items: { code: string }[] }>>(
        listCategories,
        { path: "/api/v1/commerce/expense-categories", headers: headers(owner) }
      );
      expect(list.body.data.items.map((c) => c.code)).toEqual(["ICE"]);
    });

    test("a drawer expense is reflected in the cash-up EXACTLY ONCE; replay and a second post change nothing; the shift closes with zero variance", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, clerk } = await world({ threshold: "50000.00" });
      const categoryId = await newCategory(owner);
      const { sessionId } = await openDrawer(owner);
      expect(expectedCash(await report(owner, sessionId))).toBe("100000.00");

      const created = await draft(clerk, categoryId, {
        amount: "25000.00",
        registerSessionId: sessionId
      });
      expect(created.status).toBe(201);
      const expenseId = created.body.data.id;
      // A draft touches no register.
      expect(expectedCash(await report(owner, sessionId))).toBe("100000.00");
      expect(await movementRows(expenseId)).toHaveLength(0);

      const replayKey = key();
      const posted = await post(clerk, expenseId, replayKey);
      expect(posted.status).toBe(200);
      expect(posted.body.data.outcome).toBe("posted");
      expect(posted.body.data.expense).toMatchObject({
        status: "posted",
        decision: "auto",
        decidedByTenantUserId: null
      });
      expect(posted.body.data.expense.postedMovementId).not.toBeNull();

      const afterPost = await report(owner, sessionId);
      expect(expectedCash(afterPost)).toBe("75000.00");
      const expenseMovements = afterPost.movements.filter(
        (m) => m.movementType === "expense"
      );
      expect(expenseMovements).toHaveLength(1);
      expect(expenseMovements[0]).toMatchObject({
        direction: "out",
        amount: "25000.00"
      });
      expect(expenseMovements[0]!.reference).toMatch(/^EXP-[0-9A-F]{8}$/);

      // The same Idempotency-Key replays the stored answer; nothing moves.
      const replay = await post(clerk, expenseId, replayKey);
      expect(replay.status).toBe(200);
      expect(replay.body.data.expense.id).toBe(expenseId);
      // A NEW key on an already-posted expense is a state conflict, not a second posting.
      const second = await post(clerk, expenseId);
      expect(second.status).toBe(409);
      expect(second.body.error?.code).toBe("EXPENSE_NOT_POSTABLE");

      const rows = await movementRows(expenseId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        movement_type: "expense",
        direction: "out",
        amount: "25000.00",
        reference_kind: "expense",
        source_key: `expense:${expenseId}:post`
      });
      expect(expectedCash(await report(owner, sessionId))).toBe("75000.00");

      // Cash-up reconciliation: counting exactly the derived figure closes cleanly.
      const closed = await invoke<Envelope<{ outcome: string }>>(postClose, {
        method: "POST",
        path: `/api/v1/commerce/register-sessions/${sessionId}/close`,
        headers: headers(owner, key()),
        params: { id: sessionId },
        body: { counted: { cash: "75000.00" }, varianceReason: null }
      });
      expect(closed.status).toBe(200);
      expect(closed.body.data.outcome).toBe("closed");
    });

    test("a reversal compensates with a second movement; the original row stays; replay and a second reversal change nothing; the expense is then immutable", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, clerk, supervisor } = await world();
      const categoryId = await newCategory(owner);
      const { sessionId } = await openDrawer(owner);

      const expenseId = (
        await draft(clerk, categoryId, {
          amount: "20000.00",
          registerSessionId: sessionId
        })
      ).body.data.id;
      expect((await post(clerk, expenseId)).status).toBe(200);
      expect(expectedCash(await report(owner, sessionId))).toBe("80000.00");

      // A clerk holds no reversal permission.
      expect((await reverse(clerk, expenseId)).status).toBe(403);

      const reversalKey = key();
      const reversed = await reverse(
        supervisor,
        expenseId,
        "Entered twice",
        reversalKey
      );
      expect(reversed.status).toBe(200);
      expect(reversed.body.data.outcome).toBe("reversed");
      expect(reversed.body.data.expense).toMatchObject({
        status: "reversed",
        reversalSessionId: sessionId
      });
      expect(expectedCash(await report(owner, sessionId))).toBe("100000.00");

      const rows = await movementRows(expenseId);
      expect(
        rows.map((r) => `${r.movement_type}:${r.direction}`).sort()
      ).toEqual(["correction:in", "expense:out"]);
      expect(rows.every((r) => r.amount === "20000.00")).toBe(true);

      expect(
        (await reverse(supervisor, expenseId, "Entered twice", reversalKey))
          .status
      ).toBe(200);
      const again = await reverse(supervisor, expenseId);
      expect(again.status).toBe(409);
      expect(again.body.error?.code).toBe("EXPENSE_NOT_REVERSIBLE");
      expect(await movementRows(expenseId)).toHaveLength(2);
      expect(expectedCash(await report(owner, sessionId))).toBe("100000.00");

      // The schema agrees: neither the reversed expense nor either movement can change.
      const admin = getHandlerAdminSql();
      const edit = await assertRejected(
        Promise.resolve(
          admin`UPDATE awcms_commerce_expenses SET amount = 1.00 WHERE id = ${expenseId}`
        ),
        "an edit of a reversed expense"
      );
      expect(String(edit.message)).toContain("immutable");
      await assertRejected(
        Promise.resolve(
          admin`UPDATE awcms_commerce_register_movements SET amount = 1.00 WHERE expense_id = ${expenseId}`
        ),
        "an edit of an append-only movement"
      );
      // ...and a duplicate posting movement for the same expense is impossible.
      await assertRejected(
        Promise.resolve(admin`
        INSERT INTO awcms_commerce_register_movements
          (tenant_id, session_id, movement_type, direction, amount, reference_kind,
           reference, actor_tenant_user_id, source_key, expense_id)
        VALUES (${owner.tenantId}, ${sessionId}, 'expense', 'out', 5.00, 'expense',
                'dup', ${owner.tenantUserId}, 'expense:dup:post', ${expenseId})
      `),
        "a second out movement for one expense"
      );
    });

    test("reversing after the shift closed never rewrites the closed cash-up: it needs an open session of the same register and lands there", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, clerk, supervisor } = await world();
      const categoryId = await newCategory(owner);
      const { sessionId } = await openDrawer(owner);

      const expenseId = (
        await draft(clerk, categoryId, {
          amount: "30000.00",
          registerSessionId: sessionId
        })
      ).body.data.id;
      expect((await post(clerk, expenseId)).status).toBe(200);

      const closed = await invoke<Envelope<{ outcome: string }>>(postClose, {
        method: "POST",
        path: `/api/v1/commerce/register-sessions/${sessionId}/close`,
        headers: headers(owner, key()),
        params: { id: sessionId },
        body: { counted: { cash: "70000.00" }, varianceReason: null }
      });
      expect(closed.body.data.outcome).toBe("closed");
      const closedReport = await report(owner, sessionId);

      // No open session on the register: refused, and the expense stays posted.
      const refused = await reverse(supervisor, expenseId);
      expect(refused.status).toBe(409);
      expect(refused.body.error?.code).toBe("REGISTER_SESSION_REQUIRED");
      expect(await movementRows(expenseId)).toHaveLength(1);

      // Open a fresh session on the same register; the compensating cash lands there.
      const registerId = (
        (await getHandlerAdminSql()`
        SELECT register_id FROM awcms_commerce_register_sessions WHERE id = ${sessionId}
      `) as { register_id: string }[]
      )[0]!.register_id;
      const next = await invoke<Envelope<SessionBody>>(openSession, {
        method: "POST",
        path: "/api/v1/commerce/register-sessions",
        headers: headers(owner, key()),
        body: { registerId, openingFloat: "70000.00" }
      });
      expect(next.status).toBe(201);
      const nextId = next.body.data.id;

      const reversed = await reverse(supervisor, expenseId);
      expect(reversed.status).toBe(200);
      expect(reversed.body.data.expense.reversalSessionId).toBe(nextId);
      expect(expectedCash(await report(owner, nextId))).toBe("100000.00");
      // The closed shift reads exactly as it did.
      const stillClosed = await report(owner, sessionId);
      expect(stillClosed.movements).toEqual(closedReport.movements);
      expect(expectedCash(stillClosed)).toBe(expectedCash(closedReport));
    });

    test("approval threshold and segregation of duties: a creator can never approve their own expense above it", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, clerk, supervisor } = await world({
        threshold: "50000.00"
      });
      const categoryId = await newCategory(owner);

      // The OWNER holds every permission, including approve - and still cannot
      // approve an expense they created: posting leaves it pending.
      const own = (
        await draft(owner, categoryId, {
          amount: "80000.00",
          tenderType: "manual_bank_transfer"
        })
      ).body.data.id;
      const submitted = await post(owner, own);
      expect(submitted.status).toBe(200);
      expect(submitted.body.data.outcome).toBe("pending_approval");
      expect(submitted.body.data.expense.status).toBe("pending_approval");
      const selfApprove = await decide(owner, own, { decision: "approve" });
      expect(selfApprove.status).toBe(403);
      expect(selfApprove.body.error?.code).toBe("SEGREGATION_OF_DUTIES");
      // The pending content is frozen: the draft edit route refuses it.
      const edit = await invoke<Envelope>(patchExpense, {
        method: "PATCH",
        path: `/api/v1/commerce/expenses/${own}`,
        headers: headers(owner),
        params: { id: own },
        body: { amount: "1.00" }
      });
      expect(edit.status).toBe(409);
      expect(edit.body.error?.code).toBe("EXPENSE_NOT_DRAFT");

      // A clerk (no approve key) can neither approve nor, being unable to approve, post one-step.
      expect((await decide(clerk, own, { decision: "approve" })).status).toBe(
        403
      );

      // A different approver approves: posted, approver recorded.
      const approved = await decide(supervisor, own, { decision: "approve" });
      expect(approved.status).toBe(200);
      expect(approved.body.data.expense).toMatchObject({
        status: "posted",
        decision: "approved",
        decidedByTenantUserId: supervisor.tenantUserId,
        createdByTenantUserId: owner.tenantUserId
      });
      // ...once: a second decision is a state conflict.
      const twice = await decide(supervisor, own, { decision: "approve" });
      expect(twice.status).toBe(409);
      expect(twice.body.error?.code).toBe("EXPENSE_NOT_PENDING");

      // Within the threshold nobody else is needed.
      const small = (await draft(clerk, categoryId, { amount: "50000.00" }))
        .body.data.id;
      expect((await post(clerk, small)).body.data.outcome).toBe("posted");
      // One cent above: the clerk's own post waits.
      const justOver = (await draft(clerk, categoryId, { amount: "50000.01" }))
        .body.data.id;
      expect((await post(clerk, justOver)).body.data.outcome).toBe(
        "pending_approval"
      );
      // ...and an approver who did not create it posts a draft in one step.
      const other = (await draft(clerk, categoryId, { amount: "90000.00" }))
        .body.data.id;
      const oneStep = await post(supervisor, other);
      expect(oneStep.body.data.outcome).toBe("posted");
      expect(oneStep.body.data.expense).toMatchObject({
        decision: "approved",
        decidedByTenantUserId: supervisor.tenantUserId
      });

      // The schema states the same rule: an approver equal to the creator is impossible.
      const selfApproval = await assertRejected(
        Promise.resolve(getHandlerAdminSql()`
        UPDATE awcms_commerce_expenses
        SET decision = 'approved', decided_by_tenant_user_id = created_by_tenant_user_id,
            decided_at = now()
        WHERE id = ${justOver} AND status = 'pending_approval'
      `),
        "an update where the approver is the creator"
      );
      expect(String(selfApproval.message)).toContain("approver_check");
    });

    test("a drawer expense approved by a supervisor writes its movement with the APPROVER as actor; an approval after the session closed is refused and the expense stays pending", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, clerk, supervisor } = await world({
        threshold: "10000.00"
      });
      const categoryId = await newCategory(owner);
      const { sessionId } = await openDrawer(owner);

      const expenseId = (
        await draft(clerk, categoryId, {
          amount: "40000.00",
          registerSessionId: sessionId
        })
      ).body.data.id;
      expect((await post(clerk, expenseId)).body.data.outcome).toBe(
        "pending_approval"
      );
      expect(await movementRows(expenseId)).toHaveLength(0);
      expect(expectedCash(await report(owner, sessionId))).toBe("100000.00");

      const approved = await decide(supervisor, expenseId, {
        decision: "approve"
      });
      expect(approved.status).toBe(200);
      const rows = await movementRows(expenseId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor_tenant_user_id).toBe(supervisor.tenantUserId);
      expect(expectedCash(await report(owner, sessionId))).toBe("60000.00");

      // Pending, then the shift closes: approval is refused, nothing is written.
      const late = (
        await draft(clerk, categoryId, {
          amount: "15000.00",
          registerSessionId: sessionId
        })
      ).body.data.id;
      expect((await post(clerk, late)).body.data.outcome).toBe(
        "pending_approval"
      );
      const closed = await invoke<Envelope<{ outcome: string }>>(postClose, {
        method: "POST",
        path: `/api/v1/commerce/register-sessions/${sessionId}/close`,
        headers: headers(owner, key()),
        params: { id: sessionId },
        body: { counted: { cash: "60000.00" }, varianceReason: null }
      });
      expect(closed.body.data.outcome).toBe("closed");
      const refused = await decide(supervisor, late, { decision: "approve" });
      expect(refused.status).toBe(409);
      expect(refused.body.error?.code).toBe("REGISTER_SESSION_NOT_OPEN");
      expect(await movementRows(late)).toHaveLength(0);
      const stillPending = await invoke<Envelope<ExpenseBody>>(getExpense, {
        path: `/api/v1/commerce/expenses/${late}`,
        headers: headers(owner),
        params: { id: late }
      });
      expect(stillPending.body.data.status).toBe("pending_approval");

      // A drawer draft on a closed session is refused up front.
      const onClosed = await draft(clerk, categoryId, {
        registerSessionId: sessionId
      });
      expect(onClosed.status).toBe(409);
      expect(onClosed.body.error?.code).toBe("REGISTER_SESSION_NOT_OPEN");
    });

    test("rejecting needs a note and returns the expense to a draft, which can be corrected and submitted again", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, clerk, supervisor } = await world({ threshold: "0.00" });
      const categoryId = await newCategory(owner);

      const expenseId = (await draft(clerk, categoryId, { amount: "12000.00" }))
        .body.data.id;
      expect((await post(clerk, expenseId)).body.data.outcome).toBe(
        "pending_approval"
      );

      const noNote = await decide(supervisor, expenseId, {
        decision: "reject"
      });
      expect(noNote.status).toBe(400);
      const rejected = await decide(supervisor, expenseId, {
        decision: "reject",
        note: "Missing receipt"
      });
      expect(rejected.status).toBe(200);
      expect(rejected.body.data.outcome).toBe("rejected");
      expect(rejected.body.data.expense).toMatchObject({
        status: "draft",
        decision: "rejected",
        decisionNote: "Missing receipt"
      });

      const fixed = await invoke<Envelope<ExpenseBody>>(patchExpense, {
        method: "PATCH",
        path: `/api/v1/commerce/expenses/${expenseId}`,
        headers: headers(clerk),
        params: { id: expenseId },
        body: { amount: "9000.00" }
      });
      expect(fixed.status).toBe(200);
      expect(fixed.body.data.amount).toBe("9000.00");
      expect((await post(clerk, expenseId)).body.data.outcome).toBe(
        "pending_approval"
      );
      expect(
        (await decide(supervisor, expenseId, { decision: "approve" })).body.data
          .expense.status
      ).toBe("posted");
    });

    test("employee scope: another employee cannot edit or discard someone else's draft; a supervisor can; a posted expense cannot be edited", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, clerk, supervisor } = await world();
      const clerk2 = await seedPrincipal(
        owner.tenantId,
        "clerk2",
        CLERK_PERMISSIONS
      );
      const categoryId = await newCategory(owner);

      const expenseId = (await draft(clerk, categoryId)).body.data.id;
      const patch = (who: Principal, body: Record<string, unknown>) =>
        invoke<Envelope<ExpenseBody>>(patchExpense, {
          method: "PATCH",
          path: `/api/v1/commerce/expenses/${expenseId}`,
          headers: headers(who),
          params: { id: expenseId },
          body
        });
      const cancel = (who: Principal, idempotency = key()) =>
        invoke<Envelope<ExpenseBody>>(cancelExpense, {
          method: "POST",
          path: `/api/v1/commerce/expenses/${expenseId}/cancel`,
          headers: headers(who, idempotency),
          params: { id: expenseId }
        });

      const denied = await patch(clerk2, { description: "Not mine" });
      expect(denied.status).toBe(403);
      expect(denied.body.error?.code).toBe("NOT_EXPENSE_OWNER");
      expect((await cancel(clerk2)).status).toBe(403);

      expect((await patch(clerk, { description: "Mine" })).status).toBe(200);
      expect(
        (await patch(supervisor, { description: "Supervised" })).status
      ).toBe(200);

      const cancelKey = key();
      const cancelled = await cancel(clerk, cancelKey);
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.data.status).toBe("cancelled");
      expect((await cancel(clerk, cancelKey)).status).toBe(200); // replay
      const afterCancel = await cancel(clerk);
      expect(afterCancel.status).toBe(409);
      expect(afterCancel.body.error?.code).toBe("EXPENSE_NOT_DRAFT");
      // A discarded draft cannot be posted.
      const postCancelled = await post(clerk, expenseId);
      expect(postCancelled.status).toBe(409);
      expect(postCancelled.body.error?.code).toBe("EXPENSE_NOT_POSTABLE");
    });

    test("idempotent create: the same key and body replays the same expense; a different body under that key conflicts; only one row exists", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, clerk } = await world();
      const categoryId = await newCategory(owner);
      const idempotency = key();

      const first = await draft(
        clerk,
        categoryId,
        { amount: "11000.00" },
        idempotency
      );
      const second = await draft(
        clerk,
        categoryId,
        { amount: "11000.00" },
        idempotency
      );
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.data.id).toBe(first.body.data.id);

      const conflict = await draft(
        clerk,
        categoryId,
        { amount: "12000.00" },
        idempotency
      );
      expect(conflict.status).toBe(409);
      expect(conflict.body.error?.code).toBe("IDEMPOTENCY_CONFLICT");

      const count = (await getHandlerAdminSql()`
      SELECT count(*)::int AS n FROM awcms_commerce_expenses WHERE tenant_id = ${owner.tenantId}
    `) as { n: number }[];
      expect(count[0]!.n).toBe(1);

      // A missing key is a 400 before anything is written.
      const missing = await invoke<Envelope>(createExpense, {
        method: "POST",
        path: "/api/v1/commerce/expenses",
        headers: headers(clerk),
        body: {
          categoryId,
          amount: "1.00",
          tenderType: "cash",
          occurredOn: TODAY,
          description: "x"
        }
      });
      expect(missing.status).toBe(400);
      expect(missing.body.error?.code).toBe("IDEMPOTENCY_REQUIRED");
    });

    test("two concurrent posts of one draft with different keys: exactly one posts, the other conflicts, one movement exists", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, clerk } = await world({ threshold: "1000000.00" });
      const categoryId = await newCategory(owner);
      const { sessionId } = await openDrawer(owner);
      const expenseId = (
        await draft(clerk, categoryId, {
          amount: "5000.00",
          registerSessionId: sessionId
        })
      ).body.data.id;

      const [a, b] = await Promise.all([
        post(clerk, expenseId),
        post(clerk, expenseId)
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(await movementRows(expenseId)).toHaveLength(1);
      expect(expectedCash(await report(owner, sessionId))).toBe("95000.00");
    });

    test("money is exact: 0.10 + 0.20 leaves the drawer at exactly float minus 0.30, and the summary says 0.30", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, clerk } = await world({ threshold: "1000000.00" });
      const categoryId = await newCategory(owner);
      const { sessionId } = await openDrawer(owner, "KASIR-1", "1000.00");

      for (const amount of ["0.10", "0.20"]) {
        const id = (
          await draft(clerk, categoryId, {
            amount,
            registerSessionId: sessionId
          })
        ).body.data.id;
        expect((await post(clerk, id)).status).toBe(200);
      }
      expect(expectedCash(await report(owner, sessionId))).toBe("999.70");

      const summary = await invoke<
        Envelope<{
          postedTotal: string;
          reversedTotal: string;
          byCategory: { postedCount: number; postedTotal: string }[];
          byTender: {
            tenderType: string;
            postedTotal: string;
            postedCount: number;
          }[];
        }>
      >(getSummary, {
        path: `/api/v1/commerce/expenses/summary?from=${TODAY}&to=${TODAY}`,
        headers: headers(clerk)
      });
      expect(summary.status).toBe(200);
      expect(summary.body.data.postedTotal).toBe("0.30");
      expect(summary.body.data.reversedTotal).toBe("0.00");
      expect(summary.body.data.byCategory[0]).toMatchObject({
        postedCount: 2,
        postedTotal: "0.30"
      });
      expect(summary.body.data.byTender).toEqual([
        { tenderType: "cash", postedTotal: "0.30", postedCount: 2 }
      ]);

      // JSON numbers are refused outright - money is a string.
      const asNumber = await draft(clerk, categoryId, { amount: 5 });
      expect(asNumber.status).toBe(400);
    });

    test("the summary range is required and bounded; reversed expenses are reported beside posted ones, never netted away", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, clerk, supervisor } = await world({
        threshold: "1000000.00"
      });
      const categoryId = await newCategory(owner);
      const a = (
        await draft(clerk, categoryId, {
          amount: "100.00",
          tenderType: "manual_qris"
        })
      ).body.data.id;
      const b = (
        await draft(clerk, categoryId, {
          amount: "40.00",
          tenderType: "manual_qris"
        })
      ).body.data.id;
      await post(clerk, a);
      await post(clerk, b);
      expect((await reverse(supervisor, b)).status).toBe(200);

      const summary = await invoke<
        Envelope<{
          postedTotal: string;
          reversedTotal: string;
          draftCount: number;
        }>
      >(getSummary, {
        path: `/api/v1/commerce/expenses/summary?from=${TODAY}&to=${TODAY}`,
        headers: headers(clerk)
      });
      expect(summary.body.data).toMatchObject({
        postedTotal: "100.00",
        reversedTotal: "40.00",
        draftCount: 0
      });

      for (const query of [
        "",
        "?from=2026-01-01",
        "?from=2026-01-01&to=2027-06-01",
        "?from=2026-10-05&to=2026-10-01"
      ]) {
        const bad = await invoke<Envelope>(getSummary, {
          path: `/api/v1/commerce/expenses/summary${query}`,
          headers: headers(clerk)
        });
        expect(bad.status).toBe(400);
      }
    });

    test("the CSV: export is its own permission, ranges are bounded, formulas are neutralised, and no receipt datum appears", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, clerk } = await world({ threshold: "1000000.00" });
      const categoryId = await newCategory(owner);
      const id = (
        await draft(clerk, categoryId, {
          amount: "10.00",
          description: '=HYPERLINK("http://evil.example")',
          payeeName: "+62 811 000"
        })
      ).body.data.id;
      await post(clerk, id);

      const csvRequest = (who: Principal, query: string) => {
        const path = `/api/v1/commerce/expenses/export.csv${query}`;
        return getExportCsv({
          request: new Request(`http://integration.test${path}`, {
            headers: headers(who)
          }),
          url: new URL(`http://integration.test${path}`),
          params: {},
          locals: {},
          cookies: createCookieJar(),
          clientAddress: "127.0.0.1"
        } as never);
      };

      // Reading expenses grants no export.
      expect(
        (await csvRequest(clerk, `?from=${TODAY}&to=${TODAY}`)).status
      ).toBe(403);

      const csv = await csvRequest(owner, `?from=${TODAY}&to=${TODAY}`);
      expect(csv.status).toBe(200);
      expect(csv.headers.get("content-type")).toContain("text/csv");
      expect(csv.headers.get("x-export-truncated")).toBe("false");
      expect(csv.headers.get("cache-control")).toBe("no-store");
      const text = await csv.text();
      const lines = text.trimEnd().split("\n");
      expect(lines[0]).toBe(
        "id,occurred_on,status,category_code,category_name,amount,tender,register_session,payee,description,created_by,posted_at,decision,reversed_at,reversal_reason,has_receipt"
      );
      expect(lines).toHaveLength(2);
      expect(text).toContain("'=HYPERLINK");
      expect(text).toContain("'+62 811 000");
      expect(text).toContain(",10.00,");

      expect((await csvRequest(owner, "")).status).toBe(400);
      expect(
        (await csvRequest(owner, "?from=2020-01-01&to=2026-12-31")).status
      ).toBe(400);
    });

    test("attachment access control: a private receipt is read only through its own permission, only the object attached to that expense, and fails closed", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, clerk, supervisor } = await world();
      const clerk2 = await seedPrincipal(
        owner.tenantId,
        "clerk2",
        CLERK_PERMISSIONS
      );
      const viewer = await seedPrincipal(owner.tenantId, "viewer", [
        "commerce.expenses.read"
      ]);
      const categoryId = await newCategory(owner);
      const expenseId = (await draft(clerk, categoryId)).body.data.id;

      const attach = (who: Principal, id: string, mediaObjectId: string) =>
        invoke<Envelope<ExpenseBody>>(attachReceipt, {
          method: "POST",
          path: `/api/v1/commerce/expenses/${id}/receipt`,
          headers: headers(who),
          params: { id },
          body: { mediaObjectId }
        });
      const receiptUrl = (who: Principal, id: string) =>
        invoke<Envelope<{ url: string; expenseId: string; expiresAt: string }>>(
          getReceiptUrl,
          {
            path: `/api/v1/commerce/expenses/${id}/receipt-url`,
            headers: headers(who),
            params: { id }
          }
        );

      // Eligibility: a PUBLIC object, someone else's upload and a malformed id are refused.
      const publicObject = await seedMedia(
        owner.tenantId,
        clerk.tenantUserId,
        "public"
      );
      const foreignObject = await seedMedia(owner.tenantId, owner.tenantUserId);
      const own = await seedMedia(owner.tenantId, clerk.tenantUserId);
      expect(
        (await attach(clerk, expenseId, publicObject)).body.error?.code
      ).toBe("EXPENSE_RECEIPT_NOT_ELIGIBLE");
      expect(
        (await attach(clerk, expenseId, foreignObject)).body.error?.code
      ).toBe("EXPENSE_RECEIPT_NOT_ELIGIBLE");
      expect((await attach(clerk, expenseId, "not-a-uuid")).status).toBe(400);
      expect((await attach(clerk, expenseId, crypto.randomUUID())).status).toBe(
        404
      );
      // Another employee cannot attach to this draft even with the permission.
      const own2 = await seedMedia(owner.tenantId, clerk2.tenantUserId);
      expect((await attach(clerk2, expenseId, own2)).status).toBe(403);

      const attached = await attach(clerk, expenseId, own);
      expect(attached.status).toBe(200);
      expect(attached.body.data.hasReceipt).toBe(true);
      // The object id / key never leave through the expense body.
      const detail = await invoke<Envelope<ExpenseBody>>(getExpense, {
        path: `/api/v1/commerce/expenses/${expenseId}`,
        headers: headers(clerk),
        params: { id: expenseId }
      });
      expect(JSON.stringify(detail.body)).not.toContain(own);
      expect(JSON.stringify(detail.body)).not.toContain("news-media");

      // One object serves one expense; a product's protected download is never a receipt.
      const other = (await draft(clerk, categoryId)).body.data.id;
      expect((await attach(clerk, other, own)).body.error?.code).toBe(
        "EXPENSE_RECEIPT_ALREADY_USED"
      );

      // Reading: reading EXPENSES is not reading RECEIPTS; so is attaching.
      expect((await receiptUrl(viewer, expenseId)).status).toBe(403);
      expect((await receiptUrl(clerk, expenseId)).status).toBe(403);
      // Unauthenticated.
      const anonymous = await invoke<Envelope>(getReceiptUrl, {
        path: `/api/v1/commerce/expenses/${expenseId}/receipt-url`,
        headers: { "x-awcms-tenant-id": owner.tenantId },
        params: { id: expenseId }
      });
      expect([401, 403]).toContain(anonymous.status);

      const issued = await receiptUrl(supervisor, expenseId);
      expect(issued.status).toBe(200);
      expect(issued.response.headers.get("cache-control")).toBe("no-store");
      expect(issued.body.data.expenseId).toBe(expenseId);
      expect(issued.body.data.url).toContain("X-Amz-Signature");
      expect(issued.body.data.url).not.toContain(
        R2_ENV.NEWS_MEDIA_R2_SECRET_ACCESS_KEY
      );
      // An expense with no receipt: 404, never a URL.
      expect((await receiptUrl(supervisor, other)).status).toBe(404);

      // The issuance is audited as media.download, with the actor, and no URL in it.
      const audit = (await getHandlerAdminSql()`
      SELECT actor_tenant_user_id, attributes::text AS attributes
      FROM awcms_audit_events
      WHERE tenant_id = ${owner.tenantId} AND action = 'media.download' AND resource_id = ${own}
    `) as { actor_tenant_user_id: string; attributes: string }[];
      expect(audit).toHaveLength(1);
      expect(audit[0]!.actor_tenant_user_id).toBe(supervisor.tenantUserId);
      expect(audit[0]!.attributes).not.toContain("X-Amz-Signature");

      // Fail closed: the object turning public (a misconfiguration) is never signed.
      await getHandlerAdminSql()`
      UPDATE awcms_news_media_objects
      SET visibility = 'public', public_url = 'https://media.example.test/x.pdf'
      WHERE id = ${own}
    `;
      const unavailable = await receiptUrl(supervisor, expenseId);
      expect(unavailable.status).toBe(409);
      expect(unavailable.body.error?.code).toBe("EXPENSE_RECEIPT_UNAVAILABLE");

      // A product's protected download is not attachable as a receipt.
      const productObject = await seedMedia(owner.tenantId, clerk.tenantUserId);
      const product = (await getHandlerAdminSql()`
      INSERT INTO awcms_commerce_products (tenant_id, sku, name, slug, price, type)
      VALUES (${owner.tenantId}, 'SKU-RCPT', 'Guide', 'guide-rcpt', 10000, 'digital')
      RETURNING id
    `) as { id: string }[];
      await getHandlerAdminSql()`
      INSERT INTO awcms_commerce_protected_media_links (tenant_id, product_id, media_object_id)
      VALUES (${owner.tenantId}, ${product[0]!.id}, ${productObject})
    `;
      expect((await attach(clerk, other, productObject)).body.error?.code).toBe(
        "EXPENSE_RECEIPT_ALREADY_USED"
      );
    });

    test("a posted expense accepts its receipt once and never replaces it", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, clerk } = await world({ threshold: "1000000.00" });
      const categoryId = await newCategory(owner);
      const expenseId = (await draft(clerk, categoryId)).body.data.id;
      expect((await post(clerk, expenseId)).status).toBe(200);

      const attach = (mediaObjectId: string) =>
        invoke<Envelope<ExpenseBody>>(attachReceipt, {
          method: "POST",
          path: `/api/v1/commerce/expenses/${expenseId}/receipt`,
          headers: headers(clerk),
          params: { id: expenseId },
          body: { mediaObjectId }
        });
      const first = await seedMedia(owner.tenantId, clerk.tenantUserId);
      const second = await seedMedia(owner.tenantId, clerk.tenantUserId);
      expect((await attach(first)).status).toBe(200);
      const replaced = await attach(second);
      expect(replaced.status).toBe(409);
      expect(replaced.body.error?.code).toBe(
        "EXPENSE_RECEIPT_ALREADY_ATTACHED"
      );
      // The schema agrees.
      await assertRejected(
        Promise.resolve(getHandlerAdminSql()`
        UPDATE awcms_commerce_expenses SET receipt_media_object_id = ${second} WHERE id = ${expenseId}
      `),
        "replacing a posted expense's receipt"
      );
    });

    test("RLS and BOLA: another tenant's ids are 404 on every route, its data never lists, and cross-tenant references are refused", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, clerk } = await world({ threshold: "0.00" });
      const categoryId = await newCategory(owner);
      const { sessionId } = await openDrawer(owner);
      const expenseId = (
        await draft(clerk, categoryId, { registerSessionId: sessionId })
      ).body.data.id;
      const mediaId = await seedMedia(owner.tenantId, clerk.tenantUserId);
      const own = await invoke<Envelope>(attachReceipt, {
        method: "POST",
        path: `/api/v1/commerce/expenses/${expenseId}/receipt`,
        headers: headers(clerk),
        params: { id: expenseId },
        body: { mediaObjectId: mediaId }
      });
      expect(own.status).toBe(200);

      const tenantB = await seedTenant("globex");
      const b = await seedPrincipal(
        tenantB,
        "b-admin",
        ALL_EXPENSE_PERMISSIONS
      );
      expect(
        (await configureTenant(b, { expenses: true, register: true })).status
      ).toBe(200);
      const bCategory = await newCategory(b, "B-ICE");

      const probes = [
        await invoke<Envelope>(getExpense, {
          path: `/api/v1/commerce/expenses/${expenseId}`,
          headers: headers(b),
          params: { id: expenseId }
        }),
        await invoke<Envelope>(patchExpense, {
          method: "PATCH",
          path: `/api/v1/commerce/expenses/${expenseId}`,
          headers: headers(b),
          params: { id: expenseId },
          body: { description: "hijack" }
        }),
        await post(b, expenseId),
        await decide(b, expenseId, { decision: "approve" }),
        await reverse(b, expenseId),
        await invoke<Envelope>(cancelExpense, {
          method: "POST",
          path: `/api/v1/commerce/expenses/${expenseId}/cancel`,
          headers: headers(b, key()),
          params: { id: expenseId }
        }),
        await invoke<Envelope>(attachReceipt, {
          method: "POST",
          path: `/api/v1/commerce/expenses/${expenseId}/receipt`,
          headers: headers(b),
          params: { id: expenseId },
          body: { mediaObjectId: mediaId }
        }),
        await invoke<Envelope>(getReceiptUrl, {
          path: `/api/v1/commerce/expenses/${expenseId}/receipt-url`,
          headers: headers(b),
          params: { id: expenseId }
        }),
        await invoke<Envelope>(getCategory, {
          path: `/api/v1/commerce/expense-categories/${categoryId}`,
          headers: headers(b),
          params: { id: categoryId }
        }),
        await invoke<Envelope>(patchCategory, {
          method: "PATCH",
          path: `/api/v1/commerce/expense-categories/${categoryId}`,
          headers: headers(b),
          params: { id: categoryId },
          body: { active: false }
        })
      ];
      for (const probe of probes) {
        expect(probe.status).toBe(404);
        expect(probe.body.error?.code).toBe("RESOURCE_NOT_FOUND");
      }

      // The foreign expense is neither listed nor counted for tenant B.
      const list = await invoke<Envelope<{ items: unknown[] }>>(listExpenses, {
        path: "/api/v1/commerce/expenses",
        headers: headers(b)
      });
      expect(list.body.data.items).toHaveLength(0);

      // Cross-tenant references on create: tenant A's category / session ids.
      const foreignCategory = await draft(b, categoryId);
      expect(foreignCategory.status).toBe(404);
      const foreignSession = await draft(b, bCategory, {
        registerSessionId: sessionId
      });
      expect(foreignSession.status).toBe(404);

      // The database agrees, below the application: a B row cannot point at A's
      // category even with a superuser credential that skips RLS and every
      // application check (the composite FK). The RLS half - B's tenant context
      // seeing no A row - needs a non-superuser role, so it lives in
      // `commerce-register-expenses-rls.integration.test.ts`.
      await assertRejected(
        Promise.resolve(getHandlerAdminSql()`
        INSERT INTO awcms_commerce_expenses
          (tenant_id, category_id, amount, tender_type, occurred_on, description, created_by_tenant_user_id)
        VALUES (${tenantB}, ${categoryId}, 1.00, 'cash', ${TODAY}::date, 'x', ${b.tenantUserId})
      `),
        "an expense pointing at another tenant's category"
      );
    });

    test("a raw `expense` drawer movement is refused once the expenses feature is on (it would bypass the threshold), and unchanged while it is off", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner } = await world({ expenses: false, register: true });
      const { sessionId } = await openDrawer(owner);
      const raw = (who: Principal) =>
        invoke<Envelope>(postMovement, {
          method: "POST",
          path: `/api/v1/commerce/register-sessions/${sessionId}/movements`,
          headers: headers(who, key()),
          params: { id: sessionId },
          body: { movementType: "expense", amount: "1000.00", reference: "ice" }
        });

      // Feature OFF (the default): exactly what #284 shipped.
      expect((await raw(owner)).status).toBe(201);

      expect(
        (await configureTenant(owner, { expenses: true, register: true }))
          .status
      ).toBe(200);
      const refused = await raw(owner);
      expect(refused.status).toBe(409);
      expect(refused.body.error?.code).toBe("EXPENSE_REQUIRES_EXPENSE_RECORD");
      // Other movement types are untouched.
      const cashOut = await invoke<Envelope>(postMovement, {
        method: "POST",
        path: `/api/v1/commerce/register-sessions/${sessionId}/movements`,
        headers: headers(owner, key()),
        params: { id: sessionId },
        body: { movementType: "cash_out", amount: "500.00" }
      });
      expect(cashOut.status).toBe(201);
    });

    test("audit and events carry money and ids but never the free text; the posted event fires once", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, clerk, supervisor } = await world({
        threshold: "1000000.00"
      });
      const categoryId = await newCategory(owner);
      const { sessionId } = await openDrawer(owner);
      const secret = "Pak Budi Santoso warung ES-123";
      const reasonText = "typo, entered twice by mistake";
      const id = (
        await draft(clerk, categoryId, {
          amount: "7000.00",
          description: secret,
          payeeName: "Pak Budi Santoso",
          registerSessionId: sessionId
        })
      ).body.data.id;
      const key1 = key();
      expect((await post(clerk, id, key1)).status).toBe(200);
      expect((await post(clerk, id, key1)).status).toBe(200); // replay: no second event
      expect((await reverse(supervisor, id, reasonText)).status).toBe(200);

      const admin = getHandlerAdminSql();
      const audits = (await admin`
      SELECT action, message, attributes::text AS attributes
      FROM awcms_audit_events
      WHERE tenant_id = ${owner.tenantId} AND resource_id = ${id}
      ORDER BY created_at
    `) as { action: string; message: string; attributes: string | null }[];
      expect(audits.map((a) => a.action)).toEqual([
        "expense.create",
        "expense.post",
        "expense.reverse"
      ]);
      for (const row of audits) {
        const blob = `${row.message} ${row.attributes ?? ""}`;
        expect(blob).not.toContain("Budi");
        expect(blob).not.toContain("ES-123");
        expect(blob).not.toContain(reasonText);
      }

      const events = (await admin`
      SELECT event_type, aggregate_id::text AS aggregate_id, payload::text AS payload
      FROM awcms_domain_events
      WHERE tenant_id = ${owner.tenantId} AND aggregate_type = 'commerce.expense'
      ORDER BY event_sequence
    `) as { event_type: string; aggregate_id: string; payload: string }[];
      expect(events.map((e) => e.event_type)).toEqual([
        "awcms.commerce.expense.posted",
        "awcms.commerce.expense.reversed"
      ]);
      for (const event of events) {
        expect(event.aggregate_id).toBe(id);
        expect(event.payload).not.toContain("Budi");
        expect(event.payload).not.toContain(reasonText);
        expect(JSON.parse(event.payload)).toMatchObject({
          expenseId: id,
          amount: "7000.00"
        });
      }
      // Posting and reversing each left a drawer movement event in the SESSION stream too.
      const movementEvents = (await admin`
      SELECT count(*)::int AS n FROM awcms_domain_events
      WHERE tenant_id = ${owner.tenantId}
        AND event_type = 'awcms.commerce.register_session.movement_recorded'
        AND aggregate_id = ${sessionId}
    `) as { n: number }[];
      expect(movementEvents[0]!.n).toBe(2);
    });

    test("validation: the date, the tender, the drawer rule and ownership of ids are enforced before anything is written", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, clerk } = await world();
      const categoryId = await newCategory(owner);
      const { sessionId } = await openDrawer(owner);

      for (const over of [
        { occurredOn: "2026-02-30" },
        { occurredOn: "2099-01-01" },
        { tenderType: "gateway" },
        { tenderType: "manual_qris", registerSessionId: sessionId },
        { description: "   " },
        { amount: "0.00" },
        { amount: "-1.00" }
      ]) {
        const result = await draft(clerk, categoryId, over);
        expect(result.status).toBe(400);
        expect(result.body.error?.code).toBe("VALIDATION_ERROR");
      }
      const noRows = (await getHandlerAdminSql()`
      SELECT count(*)::int AS n FROM awcms_commerce_expenses WHERE tenant_id = ${owner.tenantId}
    `) as { n: number }[];
      expect(noRows[0]!.n).toBe(0);

      // Editing a draft keeps the drawer rule: switching a drawer draft to QRIS is refused.
      const id = (
        await draft(clerk, categoryId, { registerSessionId: sessionId })
      ).body.data.id;
      const switched = await invoke<Envelope>(patchExpense, {
        method: "PATCH",
        path: `/api/v1/commerce/expenses/${id}`,
        headers: headers(clerk),
        params: { id },
        body: { tenderType: "manual_qris" }
      });
      expect(switched.status).toBe(400);
      const detached = await invoke<Envelope<ExpenseBody>>(patchExpense, {
        method: "PATCH",
        path: `/api/v1/commerce/expenses/${id}`,
        headers: headers(clerk),
        params: { id },
        body: { tenderType: "manual_qris", registerSessionId: null }
      });
      expect(detached.status).toBe(200);
      expect(detached.body.data.registerSessionId).toBeNull();
    });

    test("a non-drawer expense (bank transfer) posts and reverses without touching any register", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, clerk, supervisor } = await world({
        threshold: "1000000.00"
      });
      const categoryId = await newCategory(owner);
      const { sessionId } = await openDrawer(owner);
      const id = (
        await draft(clerk, categoryId, {
          tenderType: "manual_bank_transfer",
          amount: "250000.00"
        })
      ).body.data.id;
      const posted = await post(clerk, id);
      expect(posted.body.data.expense.postedMovementId).toBeNull();
      expect(
        (await reverse(supervisor, id)).body.data.expense.reversalMovementId
      ).toBeNull();
      expect(await movementRows(id)).toHaveLength(0);
      expect(expectedCash(await report(owner, sessionId))).toBe("100000.00");
    });
  }
);
