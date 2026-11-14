/**
 * The CRM lead link (Issue #463, ADR-0056) against a REAL migrated PostgreSQL,
 * driven through the REAL route handlers (`crm_leads` and `commerce` both).
 * Gated on `DATABASE_URL`; skips cleanly without one.
 *
 * Written without a database, then executed against a scratch PostgreSQL 16
 * (migrated with `db:migrate`): 12 of 12 pass. It
 * is type-checked and linted, and its assertions follow the migrated schema of
 * `sql/1068`, `sql/1069` and the `crm_leads` migrations `sql/342`-`344`. Run it
 * with `bun test tests/integration/commerce-crm-lead-link.integration.test.ts`
 * against a disposable database before relying on it.
 *
 * Covers what only a database can prove:
 *
 *   - default-deny and the double authorization: a commerce key alone and the
 *     CRM key alone are each refused (the port checks nothing, the route asks
 *     for both);
 *   - verified evidence only: a guest customer (no verified account), another
 *     customer's paid order, an unpaid order and a cancelled order never convert
 *     a lead, and the lead stays open; a verified registration and a paid order
 *     of that customer do, recorded in `crm_leads` and linked;
 *   - no fuzzy matching: a lead and a customer that share an e-mail and a phone
 *     stay unlinked until a person names both;
 *   - replay and duplicates: the same evidence twice is `200 replayed` with one
 *     link, one conversion and one `customer.converted` event; the same evidence
 *     for another lead is `409 CRM_EVIDENCE_REUSED`; a second live link for one
 *     lead is `409 CRM_LEAD_ALREADY_LINKED`;
 *   - source attribution: the link and the event carry the lead's FIRST source
 *     kind and touch id (an anonymous website or API lead that later becomes a
 *     customer);
 *   - correction: an order cancellation flags the link `reversal_pending` (the
 *     consumer body, which needs no CRM privilege), a person with both
 *     permissions then reverses it and `crm_leads` records the reversal; a
 *     refund of an unknown or unsettled return flags nothing; a reversed link is
 *     final;
 *   - tenant isolation: two tenants with the same e-mail and external handle,
 *     tenant B's lead and tenant A's customer are a 404, tenant B reads none of
 *     tenant A's links, the table is RLS-FORCED, and a delete is refused;
 *   - privacy: no name, e-mail or phone in any audit row, event or idempotency
 *     row the flow wrote;
 *   - the worker role holds SELECT and a column-only UPDATE on the link table
 *     and no privilege at all on any `awcms_crm_*` table.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";
import { randomBytes } from "node:crypto";

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
import { grantRolePolicy } from "../../src/modules/identity-access/application/access-policy-writer";
import {
  flagCrmLeadLinksForCancelledOrder,
  flagCrmLeadLinksForReversedPayment,
  flagCrmLeadLinksForSettledRefund
} from "../../src/modules/commerce/application/crm-lead-link-directory";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { createTenantWithOwner } from "../../src/modules/tenant-admin/application/platform-bootstrap";
import { PATCH as patchSettings } from "../../src/pages/api/v1/crm-leads/settings";
import { POST as createPipeline } from "../../src/pages/api/v1/crm-leads/pipelines/index";
import { POST as createLead } from "../../src/pages/api/v1/crm-leads/leads/index";
import { GET as getLead } from "../../src/pages/api/v1/crm-leads/leads/[id]/index";
import {
  GET as listLinks,
  POST as linkLead
} from "../../src/pages/api/v1/commerce/crm-lead-links/index";
import { POST as reverseLink } from "../../src/pages/api/v1/commerce/crm-lead-links/[id]/reverse";

const OWNER_PASSWORD = randomBytes(12).toString("hex") + "-Aa1!";
const RING_KEY = Buffer.from(
  Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 251)
).toString("base64");
const HASH_KEY = Buffer.from(
  Array.from({ length: 32 }, (_, i) => (i * 13 + 17) % 251)
).toString("base64");

const SHARED_EMAIL = "Shared.Handle@Example.test";
const SHARED_PHONE = "081234567890";
const PERSON_NAME = "Prospect Secretname";

type Envelope<T = any> = {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: any };
};

type Tenant = { tenantId: string; token: string };

const savedEnv: Record<string, string | undefined> = {};
const admin = () => getHandlerAdminSql();
let userCounter = 0;
let keyCounter = 0;
let orderCounter = 0;
let A: Tenant;
let B: Tenant;

const nextKey = () => `idem-${(keyCounter += 1)}-${crypto.randomUUID()}`;

const SETUP_BODY = (tenantName: string, tenantCode: string, login: string) => ({
  tenantName,
  tenantCode,
  officeCode: "hq",
  officeName: "HQ",
  ownerLoginIdentifier: login,
  ownerPassword: OWNER_PASSWORD,
  ownerDisplayName: "Owner"
});

async function loginOwner(tenantId: string, login: string): Promise<Tenant> {
  const session = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-tenant-id": tenantId
    },
    body: { loginIdentifier: login, password: OWNER_PASSWORD },
    cookies: createCookieJar()
  });
  expect(session.status).toBe(200);
  return { tenantId, token: session.body.data.token };
}

/** The first tenant goes through the setup wizard, which claims the setup state once. */
async function bootstrap(
  tenantName: string,
  tenantCode: string,
  login: string
): Promise<Tenant> {
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: SETUP_BODY(tenantName, tenantCode, login)
  });
  expect(setup.status).toBe(200);
  return loginOwner(setup.body.data.tenantId, login);
}

/**
 * Every further tenant is provisioned the way platform provisioning does it
 * (`createTenantWithOwner`): `/setup/initialize` answers 403 once the setup
 * state is claimed, so a second call through it is not a fixture.
 */
async function provisionTenant(
  tenantName: string,
  tenantCode: string,
  login: string
): Promise<Tenant> {
  const created = await admin().begin((tx) =>
    createTenantWithOwner(tx, SETUP_BODY(tenantName, tenantCode, login), {
      grantPlatformScope: false
    })
  );
  return loginOwner(created.tenantId, login);
}

async function seedUser(
  tenantId: string,
  label: string,
  permissionKeys: readonly string[]
): Promise<{ token: string; tenantUserId: string }> {
  userCounter += 1;
  const sql = admin();
  const tag = `${label}-${userCounter}`;
  const profile = (await sql`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', ${`User ${tag}`}) RETURNING id
  `) as { id: string }[];
  const identity = (await sql`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`${tag}@example.com`}, 'x') RETURNING id
  `) as { id: string }[];
  const tenantUser = (await sql`
    INSERT INTO awcms_tenant_users (tenant_id, identity_id)
    VALUES (${tenantId}, ${identity[0]!.id}) RETURNING id
  `) as { id: string }[];
  const token = `crmlink-${tag}-${Math.random().toString(36).slice(2)}`;
  await sql`
    INSERT INTO awcms_sessions
      (tenant_id, identity_id, token_hash, expires_at, assurance_level, last_authenticated_at)
    VALUES (${tenantId}, ${identity[0]!.id}, ${hashSessionToken(token)},
            now() + interval '8 hours', 'aal1', now())
  `;

  if (permissionKeys.length > 0) {
    const role = (await sql`
      INSERT INTO awcms_roles (tenant_id, role_code, role_name)
      VALUES (${tenantId}, ${`role-${tag}`}, ${`Role ${tag}`}) RETURNING id
    `) as { id: string }[];
    for (const key of permissionKeys) {
      const [moduleKey, activityCode, action] = key.split(".");
      const permission = (await sql`
        SELECT id FROM awcms_permissions
        WHERE module_key = ${moduleKey!} AND activity_code = ${activityCode!}
          AND action = ${action!}
      `) as { id: string }[];
      if (!permission[0]) {
        throw new Error(`fixture: permission ${key} is not in the catalogue`);
      }
      await sql`
        INSERT INTO awcms_role_permissions (tenant_id, role_id, permission_id)
        VALUES (${tenantId}, ${role[0]!.id}, ${permission[0].id})
      `;
    }
    await withTenantOrThrow(getHandlerDatabaseClient(), tenantId, (tx) =>
      grantRolePolicy(tx, tenantId, {
        tenantUserId: tenantUser[0]!.id,
        roleId: role[0]!.id,
        grantedByTenantUserId: null,
        reason: "crm lead link fixture"
      })
    );
  }
  return { token, tenantUserId: tenantUser[0]!.id };
}

function call<T = any>(
  handler: Parameters<typeof invoke>[0],
  tenant: Tenant,
  options: {
    method?: string;
    path: string;
    body?: unknown;
    params?: Record<string, string>;
    token?: string | null;
    query?: string;
  }
) {
  const token = options.token === undefined ? tenant.token : options.token;
  const mutating = (options.method ?? "GET") !== "GET";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-awcms-tenant-id": tenant.tenantId
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (mutating) headers["idempotency-key"] = nextKey();
  return invoke<Envelope<T>>(handler, {
    method: options.method,
    path: options.query ? `${options.path}?${options.query}` : options.path,
    headers,
    body: options.body,
    params: options.params,
    locals: { correlationId: "corr-link-463" }
  });
}

const DEFINITION = {
  initialStageKey: "new",
  stages: [
    { key: "new", name: "New", category: "new" },
    { key: "won", name: "Won", category: "converted" },
    { key: "lost", name: "Lost", category: "lost" }
  ],
  transitions: [
    { from: "new", to: "won" },
    { from: "new", to: "lost", guards: ["reason_required"] }
  ]
};

async function enableCrm(tenant: Tenant): Promise<string> {
  const settings = await call(patchSettings, tenant, {
    method: "PATCH",
    path: "/api/v1/crm-leads/settings",
    body: { enabled: true }
  });
  expect(settings.status).toBe(200);
  const pipeline = await call(createPipeline, tenant, {
    method: "POST",
    path: "/api/v1/crm-leads/pipelines",
    body: {
      code: "sales",
      name: "Sales",
      timeZone: "Asia/Jakarta",
      definition: DEFINITION
    }
  });
  expect(pipeline.status).toBe(201);
  return pipeline.body.data.id;
}

async function newLead(
  tenant: Tenant,
  pipelineId: string,
  source: Record<string, unknown> = { kind: "manual" }
): Promise<{ id: string; version: number }> {
  const res = await call(createLead, tenant, {
    method: "POST",
    path: "/api/v1/crm-leads/leads",
    body: {
      pipelineId,
      displayName: PERSON_NAME,
      contactPoints: [{ kind: "email", value: SHARED_EMAIL }],
      source
    }
  });
  expect([200, 201]).toContain(res.status);
  return res.body.data;
}

async function seedCustomer(
  tenantId: string,
  options: { verifiedAccount: boolean; phone?: string }
): Promise<string> {
  const rows = (await admin()`
    INSERT INTO awcms_commerce_customers (tenant_id, name, phone, email)
    VALUES (${tenantId}, ${PERSON_NAME}, ${options.phone ?? SHARED_PHONE}, ${SHARED_EMAIL})
    RETURNING id
  `) as { id: string }[];
  const customerId = rows[0]!.id;
  if (options.verifiedAccount) {
    await admin()`
      INSERT INTO awcms_commerce_customer_accounts
        (tenant_id, customer_id, email_normalized, status, email_verified_at, history_from)
      VALUES (${tenantId}, ${customerId}, ${SHARED_EMAIL.toLowerCase()}, 'active', now(), now())
    `;
  }
  return customerId;
}

async function seedOrder(
  tenantId: string,
  customerId: string,
  state: { status: string; paymentStatus: string }
): Promise<string> {
  orderCounter += 1;
  const rows = (await admin()`
    INSERT INTO awcms_commerce_orders
      (tenant_id, order_code, customer_id, status, payment_method,
       payment_status, shipping_method, subtotal, total, paid_at)
    VALUES (${tenantId}, ${`LNK-${orderCounter}`}, ${customerId}, ${state.status},
            'manual_bank', ${state.paymentStatus}, 'self_pickup', 100000, 100000,
            ${state.paymentStatus === "paid" ? new Date() : null})
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

type SeededLine = { itemId: string; productId: string };

/** One 1-unit order line. Seeded as admin. */
async function seedLine(
  tenantId: string,
  orderId: string
): Promise<SeededLine> {
  const product = (await admin()`
    INSERT INTO awcms_commerce_products (tenant_id, sku, name, slug, price, stock)
    VALUES (${tenantId}, ${`SKU-${crypto.randomUUID()}`}, 'Line', ${`line-${crypto.randomUUID()}`}, 100000, 5)
    RETURNING id
  `) as { id: string }[];
  const item = (await admin()`
    INSERT INTO awcms_commerce_order_items
      (tenant_id, order_id, product_id, name, unit_price, quantity, line_total)
    VALUES (${tenantId}, ${orderId}, ${product[0]!.id}, 'Line', 100000, 1, 100000)
    RETURNING id
  `) as { id: string }[];
  return { itemId: item[0]!.id, productId: product[0]!.id };
}

/** A return of the whole of one line, of the given kind and status. */
async function seedReturn(
  tenantId: string,
  orderId: string,
  line: SeededLine,
  kind: string,
  status: string
): Promise<string> {
  const actor = (await admin()`
    SELECT id FROM awcms_tenant_users WHERE tenant_id = ${tenantId} LIMIT 1
  `) as { id: string }[];
  const ret = (await admin()`
    INSERT INTO awcms_commerce_returns
      (tenant_id, order_id, kind, status, goods_gross, discount_share,
       shipping_refund, refund_total, source_key, actor_tenant_user_id, completed_at)
    VALUES (${tenantId}, ${orderId}, ${kind}, ${status}, 100000, 0, 0,
            100000, ${`rk-${crypto.randomUUID()}`}, ${actor[0]!.id},
            ${status === "completed" ? new Date() : null})
    RETURNING id
  `) as { id: string }[];
  await admin()`
    INSERT INTO awcms_commerce_return_lines
      (tenant_id, return_id, order_id, order_item_id, product_id, quantity,
       reason, disposition, stock_effect, goods_gross, discount_share, refund_amount)
    VALUES (${tenantId}, ${ret[0]!.id}, ${orderId}, ${line.itemId}, ${line.productId}, 1,
            'other', 'not_applicable', 0, 100000, 0, 100000)
  `;
  return ret[0]!.id;
}

function link(
  tenant: Tenant,
  body: Record<string, unknown>,
  token?: string | null
) {
  return call(linkLead, tenant, {
    method: "POST",
    path: "/api/v1/commerce/crm-lead-links",
    body,
    token
  });
}

const suite = integrationEnabled ? describe : describe.skip;
let handlerReady = false;

suite("commerce CRM lead link (Issue #463)", () => {
  let operator: { token: string; tenantUserId: string };

  beforeAll(async () => {
    for (const name of [
      "CRM_LEADS_ENABLED",
      "CRM_LEADS_ENCRYPTION_KEYS",
      "CRM_LEADS_HASH_KEYS"
    ]) {
      savedEnv[name] = process.env[name];
    }
    handlerReady = await ensureHandlerDatabaseReady();
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
    process.env.CRM_LEADS_ENABLED = "true";
    process.env.CRM_LEADS_ENCRYPTION_KEYS = `k1:${RING_KEY}`;
    process.env.CRM_LEADS_HASH_KEYS = `h1:${HASH_KEY}`;
    await resetHandlerDatabase();
    A = await bootstrap("Tenant A", "tenant-a", "owner-a@example.com");
    B = await provisionTenant("Tenant B", "tenant-b", "owner-b@example.com");
    operator = await seedUser(A.tenantId, "operator", [
      "commerce.crm_lead_links.read",
      "commerce.crm_lead_links.create",
      "commerce.crm_lead_links.approve",
      "crm_leads.conversions.approve",
      "crm_leads.leads.read"
    ]);
  });

  test("default-deny and double authorization: each key alone is refused", async () => {
    if (!handlerReady) return;
    const pipeline = await enableCrm(A);
    const lead = await newLead(A, pipeline);
    const customerId = await seedCustomer(A.tenantId, {
      verifiedAccount: true
    });
    const body = {
      leadId: lead.id,
      customerId,
      evidenceKind: "customer_registration",
      expectedVersion: lead.version
    };

    expect((await link(A, body, null)).status).toBe(401);

    const commerceOnly = await seedUser(A.tenantId, "commerce-only", [
      "commerce.crm_lead_links.create"
    ]);
    const crmOnly = await seedUser(A.tenantId, "crm-only", [
      "crm_leads.conversions.approve"
    ]);
    expect((await link(A, body, commerceOnly.token)).status).toBe(403);
    expect((await link(A, body, crmOnly.token)).status).toBe(403);
    expect(
      (
        await call(listLinks, A, {
          path: "/api/v1/commerce/crm-lead-links",
          token: crmOnly.token
        })
      ).status
    ).toBe(403);

    const refused = await call(getLead, A, {
      path: `/api/v1/crm-leads/leads/${lead.id}`,
      params: { id: lead.id }
    });
    expect(refused.body.data.stageCategory).toBe("new");

    const done = await link(A, body, operator.token);
    expect(done.status).toBe(201);
  });

  test("only verified commerce facts convert; the lead stays open otherwise", async () => {
    if (!handlerReady) return;
    const pipeline = await enableCrm(A);
    const lead = await newLead(A, pipeline);
    const guest = await seedCustomer(A.tenantId, {
      verifiedAccount: false,
      phone: "081111111111"
    });
    const other = await seedCustomer(A.tenantId, {
      verifiedAccount: true,
      phone: "082222222222"
    });
    const paidOfOther = await seedOrder(A.tenantId, other, {
      status: "paid",
      paymentStatus: "paid"
    });
    const unpaid = await seedOrder(A.tenantId, guest, {
      status: "pending_payment",
      paymentStatus: "unpaid"
    });
    const cancelled = await seedOrder(A.tenantId, guest, {
      status: "cancelled",
      paymentStatus: "paid"
    });

    const attempts: [Record<string, unknown>, string][] = [
      [
        { customerId: guest, evidenceKind: "customer_registration" },
        "no_account"
      ],
      [
        { customerId: guest, evidenceKind: "paid_order", orderId: paidOfOther },
        "order_not_of_customer"
      ],
      [
        { customerId: guest, evidenceKind: "paid_order", orderId: unpaid },
        "order_not_paid"
      ],
      [
        { customerId: guest, evidenceKind: "paid_order", orderId: cancelled },
        "order_not_active"
      ]
    ];
    for (const [extra, reason] of attempts) {
      const res = await link(
        A,
        { leadId: lead.id, expectedVersion: lead.version, ...extra },
        operator.token
      );
      expect(res.status).toBe(409);
      expect(res.body.error?.code).toBe("CRM_EVIDENCE_NOT_VERIFIED");
      expect(res.body.error?.details.reason).toBe(reason);
    }

    const state = await call(getLead, A, {
      path: `/api/v1/crm-leads/leads/${lead.id}`,
      params: { id: lead.id }
    });
    expect(state.body.data.stageCategory).toBe("new");
    expect(
      await admin()`SELECT 1 FROM awcms_commerce_crm_lead_links`
    ).toHaveLength(0);
  });

  test("a lead and a customer that share an e-mail and a phone stay unlinked until a person names both", async () => {
    if (!handlerReady) return;
    const pipeline = await enableCrm(A);
    await newLead(A, pipeline);
    await seedCustomer(A.tenantId, { verifiedAccount: true });
    const list = await call(listLinks, A, {
      path: "/api/v1/commerce/crm-lead-links",
      token: operator.token
    });
    expect(list.status).toBe(200);
    expect(list.body.data.items).toEqual([]);
  });

  test("a paid order converts, replays idempotently, and its evidence cannot convert another lead", async () => {
    if (!handlerReady) return;
    const pipeline = await enableCrm(A);
    const lead = await newLead(A, pipeline, {
      kind: "api",
      externalEventId: "evt-463-api-1"
    });
    const second = await newLead(A, pipeline, { kind: "manual" });
    const customerId = await seedCustomer(A.tenantId, {
      verifiedAccount: false
    });
    const orderId = await seedOrder(A.tenantId, customerId, {
      status: "paid",
      paymentStatus: "paid"
    });
    const body = {
      leadId: lead.id,
      customerId,
      evidenceKind: "paid_order",
      orderId,
      expectedVersion: lead.version
    };

    const first = await link(A, body, operator.token);
    expect(first.status).toBe(201);
    expect(first.body.data.state).toBe("linked");
    expect(first.body.data.firstSourceKind).toBe("api");
    expect(first.body.data.firstTouchId).toBeTruthy();

    const replay = await link(A, body, operator.token);
    expect(replay.status).toBe(200);
    expect(replay.body.data.replayed).toBe(true);
    expect(replay.body.data.id).toBe(first.body.data.id);

    const events = (await admin()`
      SELECT payload FROM awcms_domain_events
      WHERE tenant_id = ${A.tenantId}
        AND event_type = 'awcms.commerce.customer.converted'
    `) as { payload: Record<string, unknown> }[];
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.firstSourceKind).toBe("api");
    expect(events[0]!.payload.evidenceKind).toBe("paid_order");

    const converted = await call(getLead, A, {
      path: `/api/v1/crm-leads/leads/${lead.id}`,
      params: { id: lead.id }
    });
    expect(converted.body.data.stageCategory).toBe("converted");

    const reused = await link(
      A,
      { ...body, leadId: second.id, expectedVersion: second.version },
      operator.token
    );
    expect(reused.status).toBe(409);
    expect(reused.body.error?.code).toBe("CRM_EVIDENCE_REUSED");

    // The converted lead cannot take a second live link with other evidence.
    const otherOrder = await seedOrder(A.tenantId, customerId, {
      status: "completed",
      paymentStatus: "paid"
    });
    const twice = await link(
      A,
      {
        ...body,
        orderId: otherOrder,
        expectedVersion: converted.body.data.version
      },
      operator.token
    );
    expect(twice.status).toBe(409);
    expect(twice.body.error?.code).toBe("CRM_LEAD_ALREADY_LINKED");
  });

  test("an order cancellation flags the link, a person reverses it, and the reversal is final", async () => {
    if (!handlerReady) return;
    const pipeline = await enableCrm(A);
    const lead = await newLead(A, pipeline);
    const customerId = await seedCustomer(A.tenantId, {
      verifiedAccount: true
    });
    const orderId = await seedOrder(A.tenantId, customerId, {
      status: "paid",
      paymentStatus: "paid"
    });
    const made = await link(
      A,
      {
        leadId: lead.id,
        customerId,
        evidenceKind: "paid_order",
        orderId,
        expectedVersion: lead.version
      },
      operator.token
    );
    expect(made.status).toBe(201);
    const linkId = made.body.data.id;

    // The consumer body, run with the app role here: it needs no CRM privilege.
    const result = await withTenantOrThrow(
      getHandlerDatabaseClient(),
      A.tenantId,
      (tx) =>
        flagCrmLeadLinksForCancelledOrder(
          tx,
          A.tenantId,
          orderId,
          crypto.randomUUID(),
          "corr-cancel"
        )
    );
    expect(result).toEqual({ kind: "flagged", count: 1 });

    const pending = await call(listLinks, A, {
      path: "/api/v1/commerce/crm-lead-links",
      query: "state=reversal_pending",
      token: operator.token
    });
    expect(pending.body.data.items.map((item: any) => item.id)).toEqual([
      linkId
    ]);
    expect(pending.body.data.items[0].reversalCause).toBe("order_cancelled");

    const reversed = await call(reverseLink, A, {
      method: "POST",
      path: `/api/v1/commerce/crm-lead-links/${linkId}/reverse`,
      params: { id: linkId },
      token: operator.token
    });
    expect(reversed.status).toBe(200);
    expect(reversed.body.data.state).toBe("reversed");

    const again = await call(reverseLink, A, {
      method: "POST",
      path: `/api/v1/commerce/crm-lead-links/${linkId}/reverse`,
      params: { id: linkId },
      token: operator.token
    });
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe("CRM_LEAD_LINK_ALREADY_REVERSED");

    const reversals = (await admin()`
      SELECT 1 FROM awcms_crm_lead_conversions
      WHERE tenant_id = ${A.tenantId} AND reversed_at IS NOT NULL
    `) as unknown[];
    expect(reversals).toHaveLength(1);

    // Flagging a reversed link does nothing, and the row is final.
    const none = await withTenantOrThrow(
      getHandlerDatabaseClient(),
      A.tenantId,
      (tx) =>
        flagCrmLeadLinksForCancelledOrder(
          tx,
          A.tenantId,
          orderId,
          crypto.randomUUID()
        )
    );
    expect(none).toEqual({ kind: "skipped", reason: "no_live_link" });
    await expect(
      admin()`UPDATE awcms_commerce_crm_lead_links SET state = 'linked' WHERE id = ${linkId}`
    ).rejects.toThrow();
  });

  test("an erased shopper is refused as paid_order evidence, and a fully returned order is not paid evidence", async () => {
    if (!handlerReady) return;
    const pipeline = await enableCrm(A);
    const lead = await newLead(A, pipeline);
    const customerId = await seedCustomer(A.tenantId, {
      verifiedAccount: false
    });
    const orderId = await seedOrder(A.tenantId, customerId, {
      status: "paid",
      paymentStatus: "paid"
    });
    await admin()`
      UPDATE awcms_commerce_customers SET erased_at = now()
      WHERE tenant_id = ${A.tenantId} AND id = ${customerId}
    `;
    const res = await link(
      A,
      {
        leadId: lead.id,
        customerId,
        evidenceKind: "paid_order",
        orderId,
        expectedVersion: lead.version
      },
      operator.token
    );
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("CRM_EVIDENCE_NOT_VERIFIED");
    expect(res.body.error?.details.reason).toBe("customer_erased");
    expect(
      await admin()`SELECT 1 FROM awcms_commerce_crm_lead_links`
    ).toHaveLength(0);
  });

  test("the crm_leads off switches bind the commerce routes: deployment flag, tenant switch, on link and reverse", async () => {
    if (!handlerReady) return;
    const pipeline = await enableCrm(A);
    const lead = await newLead(A, pipeline);
    const customerId = await seedCustomer(A.tenantId, {
      verifiedAccount: true
    });
    const body = {
      leadId: lead.id,
      customerId,
      evidenceKind: "customer_registration",
      expectedVersion: lead.version
    };
    const reverseOf = (id: string) =>
      call(reverseLink, A, {
        method: "POST",
        path: `/api/v1/commerce/crm-lead-links/${id}/reverse`,
        params: { id },
        token: operator.token
      });

    // Deployment flag off: 503 and nothing converted.
    process.env.CRM_LEADS_ENABLED = "false";
    const flagOff = await link(A, body, operator.token);
    expect(flagOff.status).toBe(503);
    expect(flagOff.body.error?.code).toBe("CRM_LEADS_DISABLED");
    expect(
      await admin()`SELECT 1 FROM awcms_commerce_crm_lead_links`
    ).toHaveLength(0);
    process.env.CRM_LEADS_ENABLED = "true";

    // Tenant switch off: 409 and nothing converted.
    const turnOff = (enabled: boolean) =>
      call(patchSettings, A, {
        method: "PATCH",
        path: "/api/v1/crm-leads/settings",
        body: { enabled }
      });
    expect((await turnOff(false)).status).toBe(200);
    const tenantOff = await link(A, body, operator.token);
    expect(tenantOff.status).toBe(409);
    expect(tenantOff.body.error?.code).toBe("CRM_LEADS_TENANT_DISABLED");
    expect(
      await admin()`SELECT 1 FROM awcms_commerce_crm_lead_links`
    ).toHaveLength(0);
    expect((await turnOff(true)).status).toBe(200);

    // Reverse: link while on, then both switches refuse the reversal.
    const made = await link(A, body, operator.token);
    expect(made.status).toBe(201);
    const linkId = made.body.data.id;
    process.env.CRM_LEADS_ENABLED = "false";
    const reverseFlag = await reverseOf(linkId);
    expect(reverseFlag.status).toBe(503);
    expect(reverseFlag.body.error?.code).toBe("CRM_LEADS_DISABLED");
    process.env.CRM_LEADS_ENABLED = "true";
    expect((await turnOff(false)).status).toBe(200);
    const reverseTenant = await reverseOf(linkId);
    expect(reverseTenant.status).toBe(409);
    expect(reverseTenant.body.error?.code).toBe("CRM_LEADS_TENANT_DISABLED");
    const still = (await admin()`
      SELECT state FROM awcms_commerce_crm_lead_links WHERE id = ${linkId}
    `) as { state: string }[];
    expect(still[0]!.state).toBe("linked");
    expect(
      await admin()`SELECT 1 FROM awcms_crm_lead_conversions WHERE reversed_at IS NOT NULL`
    ).toHaveLength(0);
  });

  test("a fully returned order is not paid evidence; a settled full return flags a live link, an open or partial one does not", async () => {
    if (!handlerReady) return;
    const pipeline = await enableCrm(A);
    const customerId = await seedCustomer(A.tenantId, {
      verifiedAccount: false
    });
    const paid = { status: "paid", paymentStatus: "paid" };

    // Fully returned (completed): refused as evidence, nothing linked.
    const returned = await seedOrder(A.tenantId, customerId, paid);
    await seedReturn(
      A.tenantId,
      returned,
      await seedLine(A.tenantId, returned),
      "return",
      "completed"
    );
    const leadA = await newLead(A, pipeline);
    const refused = await link(
      A,
      {
        leadId: leadA.id,
        customerId,
        evidenceKind: "paid_order",
        orderId: returned,
        expectedVersion: leadA.version
      },
      operator.token
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code).toBe("CRM_EVIDENCE_NOT_VERIFIED");
    expect(refused.body.error?.details.reason).toBe("order_fully_returned");
    expect(
      await admin()`SELECT 1 FROM awcms_commerce_crm_lead_links`
    ).toHaveLength(0);

    // A whole two-line order is linked; then returns arrive.
    const whole = await seedOrder(A.tenantId, customerId, paid);
    const line1 = await seedLine(A.tenantId, whole);
    const line2 = await seedLine(A.tenantId, whole);
    const leadB = await newLead(A, pipeline);
    const made = await link(
      A,
      {
        leadId: leadB.id,
        customerId,
        evidenceKind: "paid_order",
        orderId: whole,
        expectedVersion: leadB.version
      },
      operator.token
    );
    expect(made.status).toBe(201);
    const flag = (returnId: string) =>
      withTenantOrThrow(getHandlerDatabaseClient(), A.tenantId, (tx) =>
        flagCrmLeadLinksForSettledRefund(
          tx,
          A.tenantId,
          returnId,
          crypto.randomUUID(),
          "corr-refund"
        )
      );
    const stateOf = async () =>
      (
        (await admin()`
          SELECT state, reversal_cause FROM awcms_commerce_crm_lead_links
          WHERE id = ${made.body.data.id}
        `) as { state: string; reversal_cause: string | null }[]
      )[0]!;

    // A completed return of line 1 alone leaves line 2 whole (partial).
    const partial = await seedReturn(
      A.tenantId,
      whole,
      line1,
      "return",
      "completed"
    );
    expect(await flag(partial)).toEqual({
      kind: "skipped",
      reason: "partial_return"
    });
    expect((await stateOf()).state).toBe("linked");

    // Line 2's return is still open: not settled, nothing flagged.
    const rest = await seedReturn(A.tenantId, whole, line2, "return", "open");
    expect(await flag(rest)).toEqual({
      kind: "skipped",
      reason: "return_not_settled"
    });
    expect((await stateOf()).state).toBe("linked");

    // It settles: every line is now returned, so the link is flagged.
    await admin()`
      UPDATE awcms_commerce_returns SET status = 'completed', completed_at = now()
      WHERE id = ${rest}
    `;
    expect(await flag(rest)).toEqual({ kind: "flagged", count: 1 });
    const flagged = await stateOf();
    expect(flagged.state).toBe("reversal_pending");
    expect(flagged.reversal_cause).toBe("order_refunded");
  });

  test("a payment reversed by hand to refunded flags the link; a still-paid order does not", async () => {
    if (!handlerReady) return;
    const pipeline = await enableCrm(A);
    const lead = await newLead(A, pipeline);
    const customerId = await seedCustomer(A.tenantId, {
      verifiedAccount: true
    });
    const orderId = await seedOrder(A.tenantId, customerId, {
      status: "paid",
      paymentStatus: "paid"
    });
    const made = await link(
      A,
      {
        leadId: lead.id,
        customerId,
        evidenceKind: "paid_order",
        orderId,
        expectedVersion: lead.version
      },
      operator.token
    );
    expect(made.status).toBe(201);

    const flag = () =>
      withTenantOrThrow(getHandlerDatabaseClient(), A.tenantId, (tx) =>
        flagCrmLeadLinksForReversedPayment(
          tx,
          A.tenantId,
          orderId,
          crypto.randomUUID(),
          "corr-reversal"
        )
      );
    expect(await flag()).toEqual({
      kind: "skipped",
      reason: "still_paid_or_partial"
    });

    await admin()`
      UPDATE awcms_commerce_orders SET payment_status = 'refunded'
      WHERE tenant_id = ${A.tenantId} AND id = ${orderId}
    `;
    expect(await flag()).toEqual({ kind: "flagged", count: 1 });
    const state = (await admin()`
      SELECT state, reversal_cause FROM awcms_commerce_crm_lead_links
      WHERE id = ${made.body.data.id}
    `) as { state: string; reversal_cause: string }[];
    expect(state[0]).toEqual({
      state: "reversal_pending",
      reversal_cause: "order_refunded"
    });
  });

  test("a refund of an unknown or unsettled return flags nothing", async () => {
    if (!handlerReady) return;
    const pipeline = await enableCrm(A);
    const lead = await newLead(A, pipeline);
    const customerId = await seedCustomer(A.tenantId, {
      verifiedAccount: false
    });
    const orderId = await seedOrder(A.tenantId, customerId, {
      status: "paid",
      paymentStatus: "paid"
    });
    const made = await link(
      A,
      {
        leadId: lead.id,
        customerId,
        evidenceKind: "paid_order",
        orderId,
        expectedVersion: lead.version
      },
      operator.token
    );
    expect(made.status).toBe(201);

    // An unknown return is skipped; a partial or unsettled one is skipped by
    // the same function (its line sums are pinned in the unit test).
    const skipped = await withTenantOrThrow(
      getHandlerDatabaseClient(),
      A.tenantId,
      (tx) =>
        flagCrmLeadLinksForSettledRefund(
          tx,
          A.tenantId,
          crypto.randomUUID(),
          crypto.randomUUID()
        )
    );
    expect(skipped).toEqual({ kind: "skipped", reason: "return_not_found" });
    const state = (await admin()`
      SELECT state FROM awcms_commerce_crm_lead_links WHERE id = ${made.body.data.id}
    `) as { state: string }[];
    expect(state[0]!.state).toBe("linked");
  });

  test("two tenants with the same e-mail and handle are isolated, and a cross-tenant link is a 404", async () => {
    if (!handlerReady) return;
    const pipelineA = await enableCrm(A);
    const pipelineB = await enableCrm(B);
    const leadA = await newLead(A, pipelineA);
    const leadB = await newLead(B, pipelineB);
    const customerA = await seedCustomer(A.tenantId, { verifiedAccount: true });
    const customerB = await seedCustomer(B.tenantId, { verifiedAccount: true });
    const operatorB = await seedUser(B.tenantId, "operator-b", [
      "commerce.crm_lead_links.read",
      "commerce.crm_lead_links.create",
      "crm_leads.conversions.approve"
    ]);

    // Tenant B's lead with tenant A's customer, and the reverse.
    const crossCustomer = await link(
      B,
      {
        leadId: leadB.id,
        customerId: customerA,
        evidenceKind: "customer_registration",
        expectedVersion: leadB.version
      },
      operatorB.token
    );
    expect(crossCustomer.status).toBe(404);
    const crossLead = await link(
      A,
      {
        leadId: leadB.id,
        customerId: customerA,
        evidenceKind: "customer_registration",
        expectedVersion: leadB.version
      },
      operator.token
    );
    expect(crossLead.status).toBe(404);

    const inA = await link(
      A,
      {
        leadId: leadA.id,
        customerId: customerA,
        evidenceKind: "customer_registration",
        expectedVersion: leadA.version
      },
      operator.token
    );
    expect(inA.status).toBe(201);

    // The same registration evidence shape in tenant B is its own, separate fact.
    const inB = await link(
      B,
      {
        leadId: leadB.id,
        customerId: customerB,
        evidenceKind: "customer_registration",
        expectedVersion: leadB.version
      },
      operatorB.token
    );
    expect(inB.status).toBe(201);

    const listB = await call(listLinks, B, {
      path: "/api/v1/commerce/crm-lead-links",
      token: operatorB.token
    });
    expect(listB.body.data.items.map((item: any) => item.id)).toEqual([
      inB.body.data.id
    ]);

    const reverseOther = await call(reverseLink, B, {
      method: "POST",
      path: `/api/v1/commerce/crm-lead-links/${inA.body.data.id}/reverse`,
      params: { id: inA.body.data.id },
      token: operatorB.token
    });
    expect([403, 404]).toContain(reverseOther.status);
  });

  test("storage: RLS is forced, a delete is refused, nothing personal was written, the worker is narrow", async () => {
    if (!handlerReady) return;
    const pipeline = await enableCrm(A);
    const lead = await newLead(A, pipeline);
    const customerId = await seedCustomer(A.tenantId, {
      verifiedAccount: true
    });
    const made = await link(
      A,
      {
        leadId: lead.id,
        customerId,
        evidenceKind: "customer_registration",
        expectedVersion: lead.version
      },
      operator.token
    );
    expect(made.status).toBe(201);

    const rls = (await admin()`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname = 'awcms_commerce_crm_lead_links'
    `) as { relrowsecurity: boolean; relforcerowsecurity: boolean }[];
    expect(rls[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    await expect(
      admin()`DELETE FROM awcms_commerce_crm_lead_links WHERE id = ${made.body.data.id}`
    ).rejects.toThrow();

    const text = (
      (await admin()`
        SELECT to_jsonb(t)::text AS row FROM awcms_audit_events t
        UNION ALL SELECT to_jsonb(t)::text FROM awcms_idempotency_keys t
        UNION ALL SELECT to_jsonb(t)::text FROM awcms_domain_events t
        UNION ALL SELECT to_jsonb(t)::text FROM awcms_commerce_crm_lead_links t
      `) as { row: string }[]
    )
      .map((entry) => entry.row)
      .join("\n")
      .toLowerCase();
    for (const secret of [SHARED_EMAIL, SHARED_PHONE, PERSON_NAME]) {
      expect(text).not.toContain(secret.toLowerCase());
    }

    const worker = (await admin()`
      SELECT
        has_table_privilege('awcms_worker', 'awcms_commerce_crm_lead_links', 'SELECT') AS sel,
        has_table_privilege('awcms_worker', 'awcms_commerce_crm_lead_links', 'INSERT') AS ins,
        has_table_privilege('awcms_worker', 'awcms_commerce_crm_lead_links', 'DELETE') AS del,
        has_table_privilege('awcms_worker', 'awcms_commerce_crm_lead_links', 'UPDATE') AS upd,
        has_column_privilege('awcms_worker', 'awcms_commerce_crm_lead_links', 'state', 'UPDATE') AS upd_state,
        has_column_privilege('awcms_worker', 'awcms_commerce_crm_lead_links', 'reversed_at', 'UPDATE') AS upd_reversed,
        has_column_privilege('awcms_worker', 'awcms_commerce_crm_lead_links', 'lead_id', 'UPDATE') AS upd_lead,
        has_any_column_privilege('awcms_worker', 'awcms_crm_leads', 'SELECT') AS crm_leads,
        has_any_column_privilege('awcms_worker', 'awcms_crm_lead_conversions', 'UPDATE') AS crm_conversions
    `) as Record<string, boolean>[];
    expect(worker[0]).toEqual({
      sel: true,
      ins: false,
      del: false,
      upd: false,
      upd_state: true,
      upd_reversed: false,
      upd_lead: false,
      crm_leads: false,
      crm_conversions: false
    });
  });
});
