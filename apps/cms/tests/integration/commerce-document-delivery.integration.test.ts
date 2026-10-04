/**
 * Transactional document delivery through the REAL route handlers and the REAL
 * outboxes (Issue #295, epic #281, ADR-0034).
 *
 * WORLD 2 (see `harness.ts`): handlers call `getDatabaseClient()` internally, so
 * this file runs against the migrated `DATABASE_URL` database and seeds through
 * `getHandlerAdminSql()`. The owner comes from the real setup + login
 * endpoints; the other principals are seeded with EXACTLY the permission keys
 * under test, so a 403 below means "that key was missing".
 *
 * What is proved, end to end:
 *   - the `documentDelivery` feature (default OFF) gates every route;
 *   - a delivery per channel lands as ONE row in the channel's EXISTING outbox
 *     (`awcms_email_messages` / `awcms_commerce_whatsapp_messages`) carrying the
 *     delivery id as its correlation id, with the receipt's own money strings;
 *   - a replayed `Idempotency-Key` never double-sends; a new key is an explicit
 *     re-send with its own row, linked to the one it repeats;
 *   - an order edited AFTER issue cannot change what a re-send says;
 *   - the real dispatchers (with fake providers) move the outbox row to `sent`,
 *     and the history shows the provider message id read back from the outbox;
 *   - a recipient other than the customer on file needs its own permission;
 *   - the private link: opaque, hashed at rest, expires, never a document id;
 *   - disabled channels, suppressed addresses, a missing recipient, the rolling
 *     rate limit and a tampered snapshot each end in a precise refusal, audited;
 *   - another tenant's id is the same answer as an unknown one (BOLA), and RLS
 *     hides one tenant's delivery rows from another.
 */
import type { APIContext, APIRoute } from "astro";
import {
  afterAll,
  afterEach,
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
import { POST as postDocument } from "../../src/pages/api/v1/commerce/documents/index";
import { POST as postPosOrder } from "../../src/pages/api/v1/commerce/pos/orders/index";
import { POST as postQuotation } from "../../src/pages/api/v1/commerce/quotations/index";
import { POST as postWorkOrder } from "../../src/pages/api/v1/commerce/work-orders/index";
import {
  GET as listDeliveries,
  POST as postDelivery
} from "../../src/pages/api/v1/commerce/document-deliveries/index";
import { GET as openLink } from "../../src/pages/api/v1/commerce/storefront/document-links/[token]";
import {
  requestDocumentDelivery,
  resolveDocumentLink
} from "../../src/modules/commerce/application/document-delivery-directory";
import { dispatchWhatsappQueue } from "../../src/modules/commerce/application/whatsapp-dispatch";
import { dispatchEmailQueue } from "../../src/modules/email/application/email-dispatch";
import { createProduct } from "../../src/modules/commerce/application/product-directory";
import { saveStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
import type { CreateProductInput } from "../../src/modules/commerce/domain/product-validation";
import {
  DELIVERY_RATE_LIMIT_MAX,
  hashDocumentLinkToken
} from "../../src/modules/commerce/domain/document-delivery";
import { resolveSalesReportDay } from "../../src/modules/commerce/domain/sales-report-deltas";

const OWNER_PASSWORD = `pw-${crypto.randomUUID()}`;
const PHONE = "081234567890";
const CUSTOMER_EMAIL = "siti.pelanggan@example.test";
const OVERRIDE_EMAIL = "pihak.lain@example.test";

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

const key = () => ({ "idempotency-key": crypto.randomUUID() });

const BASE_PRODUCT: CreateProductInput = {
  categoryId: null,
  type: "physical",
  sku: "SKU-DR",
  name: "Servis Rutin",
  slug: "servis-rutin-dr",
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
    storeName: "Toko <Rute>",
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

/** As `invoke`, but hands back the raw body text (the link page is not JSON). */
async function invokeText(
  handler: APIRoute,
  options: {
    path: string;
    params: Record<string, string>;
    headers?: Record<string, string>;
  }
): Promise<{ status: number; text: string; response: Response }> {
  const url = new URL(`http://integration.test${options.path}`);
  const context = {
    request: new Request(url.toString(), { headers: options.headers ?? {} }),
    url,
    params: options.params,
    locals: {},
    cookies: createCookieJar(),
    clientAddress: "127.0.0.1"
  } as unknown as APIContext;
  const response = await handler(context);
  return { status: response.status, text: await response.text(), response };
}

async function setFeatures(
  owner: Principal,
  flags: { documents: boolean; documentDelivery: boolean }
) {
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
        ...flags
      }
    }
  });
}

type Delivery = {
  id: string;
  targetType: string;
  targetId: string;
  docNumber: string;
  channel: string;
  purpose: string;
  recipientSource: string;
  recipientMasked: string;
  templateKey: string;
  templateVersion: number;
  contentHash: string;
  status: string;
  failureReason: string | null;
  resendOfId: string | null;
  hasLink: boolean;
  linkExpiresAt: string | null;
  createdAt: string;
  outbox: {
    status: string | null;
    providerMessageId: string | null;
    retryCount: number;
    lastError: string | null;
  };
};

/** Runs `run` and requires it to fail. (A Bun.SQL query is a lazy thenable: `expect(query).rejects` would never start it.) */
async function expectDbError(run: () => PromiseLike<unknown>): Promise<void> {
  let failed = false;
  try {
    await run();
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
}

/**
 * Runs `fn` in a transaction as the REAL runtime role (`awcms_app`) under the
 * given tenant's RLS context. The handler database client in this world is the
 * superuser from `DATABASE_URL`, which bypasses both RLS and revoked
 * privileges - so privilege and isolation claims are proved here, not there.
 */
async function asApp<T>(
  tenantId: string,
  fn: (tx: Bun.SQL) => Promise<T>
): Promise<T> {
  return (await getHandlerAdminSql().begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE awcms_app");
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
    return fn(tx as unknown as Bun.SQL);
  })) as T;
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

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = ["EMAIL_ENABLED", "COMMERCE_WHATSAPP_ENABLED"] as const;

function setChannels(email: boolean, whatsapp: boolean): void {
  process.env.EMAIL_ENABLED = email ? "true" : "false";
  process.env.COMMERCE_WHATSAPP_ENABLED = whatsapp ? "true" : "false";
}

const SENDER = [
  "commerce.document_deliveries.read",
  "commerce.document_deliveries.create"
];

suite("transactional document delivery (Issue #295)", () => {
  beforeAll(async () => {
    handlerReady = await ensureHandlerDatabaseReady();
    for (const name of ENV_KEYS) SAVED_ENV[name] = process.env[name];
  });

  afterAll(async () => {
    for (const name of ENV_KEYS) {
      if (SAVED_ENV[name] === undefined) delete process.env[name];
      else process.env[name] = SAVED_ENV[name];
    }
    await teardownHandlerDatabase();
  });

  beforeEach(async () => {
    setChannels(true, true);
    if (!handlerReady) return;
    await resetHandlerDatabase();
  });

  afterEach(() => {
    for (const name of ENV_KEYS) {
      if (SAVED_ENV[name] === undefined) delete process.env[name];
      else process.env[name] = SAVED_ENV[name];
    }
  });

  /** A tenant with both features on, one paid POS sale (3 x 10000.00) and its issued receipt. */
  async function world(options: { customerEmail?: boolean } = {}) {
    const owner = await bootstrapOwner();
    const productId = await seedProduct(owner);
    expect(
      (await setFeatures(owner, { documents: true, documentDelivery: true }))
        .status
    ).toBe(200);
    const sale = await invoke<
      Envelope<{ id: string; orderCode: string; total: string }>
    >(postPosOrder, {
      method: "POST",
      path: "/api/v1/commerce/pos/orders",
      headers: headers(owner, key()),
      body: {
        customer: { name: "Siti <img src=x>", phone: PHONE },
        lines: [{ productId, quantity: 3 }],
        payment: { method: "cash", amountTendered: "50000.00" }
      }
    });
    expect(sale.status).toBe(201);
    const admin = getHandlerAdminSql();
    if (options.customerEmail !== false) {
      await admin`
        UPDATE awcms_commerce_customers SET email = ${CUSTOMER_EMAIL}
        WHERE tenant_id = ${owner.tenantId}
      `;
    }
    const customers = (await admin`
      SELECT id FROM awcms_commerce_customers WHERE tenant_id = ${owner.tenantId}
    `) as { id: string }[];
    const issued = await invoke<
      Envelope<{ id: string; number: string; total: string }>
    >(postDocument, {
      method: "POST",
      path: "/api/v1/commerce/documents",
      headers: headers(owner, key()),
      body: { orderId: sale.body.data.id, docType: "receipt" }
    });
    expect(issued.status).toBe(201);
    return {
      owner,
      productId,
      orderId: sale.body.data.id,
      customerId: customers[0]!.id,
      documentId: issued.body.data.id,
      number: issued.body.data.number,
      total: issued.body.data.total
    };
  }

  function deliver(
    who: Principal,
    body: Record<string, unknown>,
    idempotency: Record<string, string> = key()
  ) {
    return invoke<Envelope<Delivery>>(postDelivery, {
      method: "POST",
      path: "/api/v1/commerce/document-deliveries",
      headers: headers(who, idempotency),
      body
    });
  }

  function history(who: Principal, targetType: string, targetId: string) {
    return invoke<Envelope<{ items: Delivery[] }>>(listDeliveries, {
      path: `/api/v1/commerce/document-deliveries?targetType=${targetType}&targetId=${targetId}`,
      headers: headers(who)
    });
  }

  async function emailRows(tenantId: string, correlationId?: string) {
    const admin = getHandlerAdminSql();
    return (await admin`
      SELECT id, category, correlation_id, to_address, to_address_masked,
             subject, variables, status, provider_message_id, retry_count, last_error
      FROM awcms_email_messages
      WHERE tenant_id = ${tenantId}
        AND (${correlationId ?? null}::text IS NULL OR correlation_id = ${correlationId ?? null})
      ORDER BY created_at
    `) as {
      id: string;
      category: string;
      correlation_id: string;
      to_address: string;
      to_address_masked: string;
      subject: string;
      variables: Record<string, string>;
      status: string;
      provider_message_id: string | null;
      retry_count: number;
      last_error: string | null;
    }[];
  }

  async function whatsappRows(tenantId: string, correlationId?: string) {
    const admin = getHandlerAdminSql();
    return (await admin`
      SELECT id, template_key, correlation_id, to_phone, to_phone_masked,
             body_rendered, status, attempts, provider_ref, last_error
      FROM awcms_commerce_whatsapp_messages
      WHERE tenant_id = ${tenantId}
        AND (${correlationId ?? null}::text IS NULL OR correlation_id = ${correlationId ?? null})
      ORDER BY created_at
    `) as {
      id: string;
      template_key: string;
      correlation_id: string;
      to_phone: string;
      to_phone_masked: string;
      body_rendered: string;
      status: string;
      attempts: number;
      provider_ref: string | null;
      last_error: string | null;
    }[];
  }

  const DOC = (w: { documentId: string }, channel: string) => ({
    targetType: "document",
    targetId: w.documentId,
    channel
  });

  test("the documentDelivery feature gate: 409 FEATURE_DISABLED until the tenant opts in, and documents must be on too", async () => {
    if (skipUnlessHandlerReady()) return;
    const w = await world();
    expect(
      (await setFeatures(w.owner, { documents: true, documentDelivery: false }))
        .status
    ).toBe(200);
    const off = await deliver(w.owner, DOC(w, "email"));
    expect(off.status).toBe(409);
    expect(off.body.error?.code).toBe("FEATURE_DISABLED");
    const offList = await history(w.owner, "document", w.documentId);
    expect(offList.status).toBe(409);
    expect(await emailRows(w.owner.tenantId)).toHaveLength(0);

    // Delivery on but documents off: the more basic feature is named.
    expect(
      (await setFeatures(w.owner, { documents: false, documentDelivery: true }))
        .status
    ).toBe(200);
    const noDocs = await deliver(w.owner, DOC(w, "email"));
    expect(noDocs.status).toBe(409);
    expect(noDocs.body.error?.code).toBe("FEATURE_DISABLED");
    expect(JSON.stringify(noDocs.body)).toContain("documents");

    expect(
      (await setFeatures(w.owner, { documents: true, documentDelivery: true }))
        .status
    ).toBe(200);
    expect((await deliver(w.owner, DOC(w, "email"))).status).toBe(201);
  });

  test("default deny and resource-split keys: reading a document is not sending it", async () => {
    if (skipUnlessHandlerReady()) return;
    const w = await world();
    const reader = await seedPrincipal(w.owner.tenantId, "doc-reader", [
      "commerce.documents.read",
      "commerce.documents.create"
    ]);
    expect((await deliver(reader, DOC(w, "email"))).status).toBe(403);
    expect((await history(reader, "document", w.documentId)).status).toBe(403);

    const historian = await seedPrincipal(w.owner.tenantId, "historian", [
      "commerce.document_deliveries.read"
    ]);
    expect((await history(historian, "document", w.documentId)).status).toBe(
      200
    );
    expect((await deliver(historian, DOC(w, "email"))).status).toBe(403);

    const sender = await seedPrincipal(w.owner.tenantId, "sender", SENDER);
    expect((await deliver(sender, DOC(w, "email"))).status).toBe(201);
    expect(await emailRows(w.owner.tenantId)).toHaveLength(1);
  });

  test("one delivery per channel lands as ONE row in the channel's existing outbox, carrying the receipt's own figures", async () => {
    if (skipUnlessHandlerReady()) return;
    const w = await world();
    const email = await deliver(w.owner, DOC(w, "email"));
    expect(email.status).toBe(201);
    const wa = await deliver(w.owner, DOC(w, "whatsapp"));
    expect(wa.status).toBe(201);

    const e = email.body.data;
    expect(e.purpose).toBe("transactional");
    expect(e.status).toBe("queued");
    expect(e.recipientSource).toBe("source_customer");
    expect(e.templateVersion).toBe(1);
    expect(e.docNumber).toBe(w.number);
    expect(e.hasLink).toBe(false);
    expect(e.outbox.status).toBe("queued");
    // Masked everywhere the API shows it - never the address itself.
    expect(e.recipientMasked).not.toContain("siti.pelanggan");
    expect(JSON.stringify(email.body)).not.toContain(CUSTOMER_EMAIL);
    expect(JSON.stringify(wa.body)).not.toContain("81234567890");

    const emails = await emailRows(w.owner.tenantId, e.id);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.category).toBe("derived.transactional");
    expect(emails[0]!.to_address).toBe(CUSTOMER_EMAIL);
    expect(emails[0]!.to_address_masked).toBe(e.recipientMasked);
    expect(emails[0]!.subject).toContain(w.number);
    expect(emails[0]!.variables.body).toContain(w.number);
    expect(emails[0]!.variables.body).toContain("30000.00");
    expect(w.total).toBe("30000.00");

    const waId = wa.body.data.id;
    const waMessages = await whatsappRows(w.owner.tenantId, waId);
    expect(waMessages).toHaveLength(1);
    expect(waMessages[0]!.template_key).toBe("commerce.document");
    expect(waMessages[0]!.to_phone).toBe("+6281234567890");
    expect(waMessages[0]!.body_rendered).toContain(w.number);
    expect(waMessages[0]!.body_rendered).toContain("30000.00");
    expect(waMessages[0]!.body_rendered).not.toContain("{{");
    expect(wa.body.data.recipientMasked).toBe(waMessages[0]!.to_phone_masked);

    // The history reads both back, newest first, joined on the correlation id.
    const list = await history(w.owner, "document", w.documentId);
    expect(list.body.data.items.map((item) => item.id)).toEqual([waId, e.id]);
    expect(list.body.data.items[0]!.outbox.status).toBe("queued");

    // Nothing else was created: no third queue, no extra outbox rows.
    expect(await emailRows(w.owner.tenantId)).toHaveLength(1);
    expect(await whatsappRows(w.owner.tenantId)).toHaveLength(1);

    // The history read joins the two outboxes: the runtime role can do that
    // (the handlers above run as the superuser, which would hide a missing grant).
    const asRuntime = await asApp(w.owner.tenantId, async (tx) => ({
      email:
        await tx`SELECT count(*)::int AS n FROM awcms_email_messages WHERE correlation_id = ${e.id}`,
      whatsapp:
        await tx`SELECT count(*)::int AS n FROM awcms_commerce_whatsapp_messages WHERE correlation_id = ${waId}`
    }));
    expect(asRuntime.email[0].n).toBe(1);
    expect(asRuntime.whatsapp[0].n).toBe(1);
  });

  test("a replayed Idempotency-Key never double-sends; a different request under the same key is a conflict", async () => {
    if (skipUnlessHandlerReady()) return;
    const w = await world();
    const idem = key();
    const first = await deliver(w.owner, DOC(w, "whatsapp"), idem);
    expect(first.status).toBe(201);
    const replay = await deliver(w.owner, DOC(w, "whatsapp"), idem);
    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(await whatsappRows(w.owner.tenantId)).toHaveLength(1);
    expect(
      (await history(w.owner, "document", w.documentId)).body.data.items
    ).toHaveLength(1);

    const conflict = await deliver(
      w.owner,
      { ...DOC(w, "whatsapp"), locale: "en" },
      idem
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await whatsappRows(w.owner.tenantId)).toHaveLength(1);

    expect((await deliver(w.owner, DOC(w, "whatsapp"), {})).status).toBe(400);
  });

  test("a re-send is an explicit new request: a new row, linked to the one it repeats, identical content", async () => {
    if (skipUnlessHandlerReady()) return;
    const w = await world();
    const first = await deliver(w.owner, DOC(w, "email"));
    const second = await deliver(w.owner, DOC(w, "email"));
    expect(second.status).toBe(201);
    expect(second.body.data.id).not.toBe(first.body.data.id);
    expect(second.body.data.resendOfId).toBe(first.body.data.id);
    expect(first.body.data.resendOfId).toBeNull();
    expect(second.body.data.contentHash).toBe(first.body.data.contentHash);
    expect(await emailRows(w.owner.tenantId)).toHaveLength(2);

    const rows = (await getHandlerAdminSql()`
      SELECT id FROM awcms_audit_events
      WHERE tenant_id = ${w.owner.tenantId} AND action = 'document_delivery.request'
    `) as { id: string }[];
    expect(rows).toHaveLength(2);
  });

  test("snapshot immutability: changing the order, the customer and the price after issue does not change a re-send", async () => {
    if (skipUnlessHandlerReady()) return;
    const w = await world();
    const first = await deliver(w.owner, DOC(w, "whatsapp"));
    const before = (
      await whatsappRows(w.owner.tenantId, first.body.data.id)
    )[0]!;

    const admin = getHandlerAdminSql();
    await admin`
      UPDATE awcms_commerce_customers SET name = 'Orang Lain Sama Sekali'
      WHERE tenant_id = ${w.owner.tenantId}
    `;
    await admin`
      UPDATE awcms_commerce_products SET price = 99999.00, name = 'Barang Lain'
      WHERE tenant_id = ${w.owner.tenantId}
    `;
    // The order itself may be guarded by triggers; try, and do not care which.
    await admin`
      UPDATE awcms_commerce_orders SET notes = 'diubah setelah terbit'
      WHERE tenant_id = ${w.owner.tenantId} AND id = ${w.orderId}
    `.catch(() => undefined);

    const second = await deliver(w.owner, DOC(w, "whatsapp"));
    expect(second.status).toBe(201);
    const after = (
      await whatsappRows(w.owner.tenantId, second.body.data.id)
    )[0]!;
    expect(after.body_rendered).toBe(before.body_rendered);
    expect(second.body.data.contentHash).toBe(first.body.data.contentHash);
    expect(after.body_rendered).not.toContain("Orang Lain");
    expect(after.body_rendered).not.toContain("Barang Lain");
    expect(after.body_rendered).toContain("30000.00");
  });

  test("the real dispatchers move the outbox row to sent, and the history shows the provider message id and retries read back from it", async () => {
    if (skipUnlessHandlerReady()) return;
    const w = await world();
    const email = await deliver(w.owner, DOC(w, "email"));
    const wa = await deliver(w.owner, DOC(w, "whatsapp"));
    const db = getHandlerDatabaseClient();

    const sentEmails: { subject: string; textBody?: string; to: string }[] = [];
    const emailResult = await dispatchEmailQueue(db, w.owner.tenantId, {
      fromAddress: "toko@example.test",
      fromName: "Toko",
      env: { ...process.env, EMAIL_ENABLED: "true" },
      resolveProvider: () => ({
        send: async (message) => {
          sentEmails.push({
            subject: message.subject,
            textBody: message.textBody,
            to: message.to[0]!.address
          });
          return { ok: true, providerMessageId: "fake-mail-1" };
        },
        healthCheck: async () => ({ ok: true })
      })
    });
    expect(emailResult.sent).toBe(1);
    // The base `derived.transactional` category is registered in the
    // dispatcher process, so the template received its variables.
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.to).toBe(CUSTOMER_EMAIL);
    expect(sentEmails[0]!.textBody).toContain(w.number);
    expect(sentEmails[0]!.textBody).toContain("30000.00");
    expect(sentEmails[0]!.textBody).not.toContain("{{");

    const waResult = await dispatchWhatsappQueue(db, w.owner.tenantId, {
      env: { ...process.env, COMMERCE_WHATSAPP_ENABLED: "true" },
      resolveProvider: () => ({
        send: async () => ({
          ok: false as const,
          error: "gateway timeout",
          retryable: true
        }),
        healthCheck: async () => ({ ok: true })
      })
    });
    expect(waResult.retried).toBe(1);

    const list = await history(w.owner, "document", w.documentId);
    const byId = new Map(list.body.data.items.map((item) => [item.id, item]));
    expect(byId.get(email.body.data.id)!.outbox).toMatchObject({
      status: "sent",
      providerMessageId: "fake-mail-1",
      retryCount: 0
    });
    expect(byId.get(wa.body.data.id)!.outbox).toMatchObject({
      status: "queued",
      retryCount: 1,
      lastError: expect.stringContaining("gateway timeout")
    });
    // The failure surfaces on the document's own history; nothing was written
    // to the delivery row (it is append-only).
    const row = (await getHandlerAdminSql()`
      SELECT status FROM awcms_commerce_document_deliveries WHERE id = ${wa.body.data.id}
    `) as { status: string }[];
    expect(row[0]!.status).toBe("queued");
  });

  test("a recipient other than the customer on file needs its own permission, and is stored masked", async () => {
    if (skipUnlessHandlerReady()) return;
    const w = await world();
    const sender = await seedPrincipal(w.owner.tenantId, "sender", SENDER);
    const denied = await deliver(sender, {
      ...DOC(w, "email"),
      recipient: OVERRIDE_EMAIL
    });
    expect(denied.status).toBe(403);
    expect(await emailRows(w.owner.tenantId)).toHaveLength(0);
    const audit = (await getHandlerAdminSql()`
      SELECT attributes FROM awcms_audit_events
      WHERE tenant_id = ${w.owner.tenantId} AND action = 'document_delivery.denied'
    `) as { attributes: { reason: string } }[];
    expect(audit.map((row) => row.attributes.reason)).toContain(
      "OVERRIDE_FORBIDDEN"
    );
    // ... and not even for a made-up source id: the refusal precedes the lookup.
    const unknownDenied = await deliver(sender, {
      targetType: "document",
      targetId: "00000000-0000-4000-8000-000000000000",
      channel: "email",
      recipient: OVERRIDE_EMAIL
    });
    expect(unknownDenied.status).toBe(403);

    const trusted = await seedPrincipal(w.owner.tenantId, "trusted", [
      ...SENDER,
      "commerce.document_delivery_overrides.create"
    ]);
    const allowed = await deliver(trusted, {
      ...DOC(w, "email"),
      recipient: OVERRIDE_EMAIL
    });
    expect(allowed.status).toBe(201);
    expect(allowed.body.data.recipientSource).toBe("override");
    expect(allowed.body.data.recipientMasked).not.toContain("pihak.lain");
    const rows = await emailRows(w.owner.tenantId, allowed.body.data.id);
    expect(rows[0]!.to_address).toBe(OVERRIDE_EMAIL);

    // The override key alone does not let a caller send at all.
    const overrideOnly = await seedPrincipal(
      w.owner.tenantId,
      "override-only",
      ["commerce.document_delivery_overrides.create"]
    );
    expect(
      (
        await deliver(overrideOnly, {
          ...DOC(w, "email"),
          recipient: OVERRIDE_EMAIL
        })
      ).status
    ).toBe(403);
  });

  test("the private link: opaque, hashed at rest, a real page before expiry, 410 after, never the document id", async () => {
    if (skipUnlessHandlerReady()) return;
    const w = await world();
    const sent = await deliver(w.owner, {
      ...DOC(w, "whatsapp"),
      includeLink: true,
      linkTtlHours: 1
    });
    expect(sent.status).toBe(201);
    expect(sent.body.data.hasLink).toBe(true);
    expect(JSON.stringify(sent.body)).not.toContain("dl_");

    const message = (
      await whatsappRows(w.owner.tenantId, sent.body.data.id)
    )[0]!;
    const match = message.body_rendered.match(
      /\/api\/v1\/commerce\/storefront\/document-links\/(dl_[A-Za-z0-9_-]{43})/
    );
    expect(match).not.toBeNull();
    const token = match![1]!;
    expect(message.body_rendered).not.toContain(w.documentId);
    expect(message.body_rendered).toContain("berlaku sampai");

    const stored = (await getHandlerAdminSql()`
      SELECT link_token_hash, link_expires_at FROM awcms_commerce_document_deliveries
      WHERE id = ${sent.body.data.id}
    `) as { link_token_hash: string; link_expires_at: Date }[];
    expect(stored[0]!.link_token_hash).toBe(hashDocumentLinkToken(token));
    expect(stored[0]!.link_token_hash).not.toContain(token.slice(3));
    // One hour from the request, exactly - the TTL the caller asked for.
    expect(
      stored[0]!.link_expires_at.getTime() -
        new Date(sent.body.data.createdAt).getTime()
    ).toBe(3_600_000);
    expect(stored[0]!.link_expires_at.toISOString()).toBe(
      sent.body.data.linkExpiresAt!
    );

    // Before expiry: the page, escaped, under a locked-down CSP, never cached.
    const page = await invokeText(openLink, {
      path: `/api/v1/commerce/storefront/document-links/${token}`,
      params: { token },
      headers: { host: "localhost" }
    });
    expect(page.status).toBe(200);
    expect(page.response.headers.get("content-security-policy")).toContain(
      "default-src 'none'"
    );
    expect(page.response.headers.get("cache-control")).toContain("no-store");
    expect(page.text).toContain(w.number);
    expect(page.text).toContain("&lt;img src=x&gt;");
    expect(page.text).not.toContain("<img src=x>");

    const db = getHandlerDatabaseClient();
    const hash = hashDocumentLinkToken(token);
    const open = await withTenantOrThrow(db, w.owner.tenantId, (tx) =>
      resolveDocumentLink(tx, w.owner.tenantId, hash, new Date())
    );
    expect(open.kind).toBe("ok");
    if (open.kind === "ok") {
      expect(open.html).toContain(w.number);
      expect(open.html).toContain("&lt;img src=x&gt;");
      expect(open.html).not.toContain("<img src=x>");
    }
    // After expiry (the clock is the argument; the row is append-only).
    const later = new Date(Date.now() + 2 * 3_600_000);
    const expired = await withTenantOrThrow(db, w.owner.tenantId, (tx) =>
      resolveDocumentLink(tx, w.owner.tenantId, hash, later)
    );
    expect(expired.kind).toBe("expired");
    // An unknown token is just not found.
    const unknown = await withTenantOrThrow(db, w.owner.tenantId, (tx) =>
      resolveDocumentLink(
        tx,
        w.owner.tenantId,
        hashDocumentLinkToken(`dl_${"A".repeat(43)}`),
        new Date()
      )
    );
    expect(unknown.kind).toBe("not_found");
    // A malformed token never reaches the database.
    const malformed = await invokeText(openLink, {
      path: "/api/v1/commerce/storefront/document-links/nope",
      params: { token: "nope" }
    });
    expect(malformed.status).toBe(404);

    // Both the successful open and the expired open were audited.
    const audits = (await getHandlerAdminSql()`
      SELECT action FROM awcms_audit_events
      WHERE tenant_id = ${w.owner.tenantId} AND action LIKE 'document_delivery.link_%'
    `) as { action: string }[];
    expect(audits.map((row) => row.action).sort()).toContain(
      "document_delivery.link_expired"
    );
    expect(audits.map((row) => row.action)).toContain(
      "document_delivery.link_opened"
    );
  });

  test("a private link is only for a document, and its lifetime is capped", async () => {
    if (skipUnlessHandlerReady()) return;
    const w = await world();
    const bad = await deliver(w.owner, {
      targetType: "work_order",
      targetId: "00000000-0000-4000-8000-000000000000",
      channel: "email",
      includeLink: true
    });
    expect(bad.status).toBe(400);
    const tooLong = await deliver(w.owner, {
      ...DOC(w, "email"),
      includeLink: true,
      linkTtlHours: 500
    });
    expect(tooLong.status).toBe(400);
    expect(await emailRows(w.owner.tenantId)).toHaveLength(0);
    // The database caps it too, independent of the application.
    await expectDbError(
      () => getHandlerAdminSql()`
        INSERT INTO awcms_commerce_document_deliveries (
          tenant_id, target_type, document_id, doc_number, channel, recipient_source,
          recipient_masked, locale, template_key, template_version, content_hash,
          status, link_token_hash, link_expires_at, requested_by_tenant_user_id
        ) VALUES (
          ${w.owner.tenantId}, 'document', ${w.documentId}, ${w.number}, 'email',
          'override', 'x***@example.test', 'id', 'derived.transactional', 1, ${"a".repeat(64)},
          'queued', ${hashDocumentLinkToken(`dl_${"B".repeat(43)}`)},
          now() + interval '200 hours', ${w.owner.tenantUserId}
        )
      `
    );
  });

  test("refusals are precise and audited: disabled channel, no recipient, tampered snapshot, unknown id", async () => {
    if (skipUnlessHandlerReady()) return;
    const w = await world({ customerEmail: false });
    const admin = getHandlerAdminSql();

    // The customer has no e-mail on file: nothing to default to.
    const noEmail = await deliver(w.owner, DOC(w, "email"));
    expect(noEmail.status).toBe(409);
    expect(noEmail.body.error?.code).toBe("RECIPIENT_UNAVAILABLE");

    // A disabled channel is refused before anything is enqueued.
    setChannels(false, false);
    const emailOff = await deliver(w.owner, {
      ...DOC(w, "email"),
      recipient: OVERRIDE_EMAIL
    });
    expect(emailOff.status).toBe(409);
    expect(emailOff.body.error?.code).toBe("CHANNEL_UNAVAILABLE");
    const waOff = await deliver(w.owner, DOC(w, "whatsapp"));
    expect(waOff.status).toBe(409);
    expect(waOff.body.error?.code).toBe("CHANNEL_UNAVAILABLE");
    setChannels(true, true);
    expect(await emailRows(w.owner.tenantId)).toHaveLength(0);
    expect(await whatsappRows(w.owner.tenantId)).toHaveLength(0);

    // The walk-in sentinel is never a recipient.
    const sentinel = await deliver(w.owner, {
      ...DOC(w, "whatsapp"),
      recipient: "+620000000000"
    });
    expect(sentinel.status).toBe(400);

    // An unknown source is the neutral 404.
    const unknown = await deliver(w.owner, {
      targetType: "document",
      targetId: "00000000-0000-4000-8000-000000000000",
      channel: "whatsapp"
    });
    expect(unknown.status).toBe(404);

    // A document whose stored snapshot no longer matches its hash is never sent.
    await admin`ALTER TABLE awcms_commerce_documents DISABLE TRIGGER USER`;
    try {
      await admin`
        UPDATE awcms_commerce_documents
        SET snapshot = jsonb_set(snapshot, '{totals,total}', '"1.00"')
        WHERE id = ${w.documentId}
      `;
    } finally {
      await admin`ALTER TABLE awcms_commerce_documents ENABLE TRIGGER USER`;
    }
    const tampered = await deliver(w.owner, DOC(w, "whatsapp"));
    expect(tampered.status).toBe(409);
    expect(tampered.body.error?.code).toBe("DOCUMENT_INTEGRITY_FAILURE");
    expect(await whatsappRows(w.owner.tenantId)).toHaveLength(0);

    const reasons = (await admin`
      SELECT attributes->>'reason' AS reason, severity FROM awcms_audit_events
      WHERE tenant_id = ${w.owner.tenantId} AND action = 'document_delivery.denied'
    `) as { reason: string; severity: string }[];
    const seen = new Set(reasons.map((row) => row.reason));
    for (const reason of [
      "RECIPIENT_UNAVAILABLE",
      "CHANNEL_UNAVAILABLE",
      "DOCUMENT_INTEGRITY_FAILURE"
    ]) {
      expect(seen.has(reason)).toBe(true);
    }
    expect(
      reasons.find((row) => row.reason === "DOCUMENT_INTEGRITY_FAILURE")!
        .severity
    ).toBe("critical");
  });

  test("a suppressed e-mail address is recorded as not_enqueued, nothing is sent, and the same key can be retried after", async () => {
    if (skipUnlessHandlerReady()) return;
    const w = await world();
    const db = getHandlerDatabaseClient();
    const admin = getHandlerAdminSql();

    const { hashIdentifierValue, maskIdentifierValue } =
      await import("../../src/modules/profile-identity/domain/identifier");
    await withTenantOrThrow(
      db,
      w.owner.tenantId,
      (tx) => tx`
        INSERT INTO awcms_email_suppression_list
          (tenant_id, recipient_hash, recipient_masked, reason, created_by)
        VALUES (${w.owner.tenantId}, ${hashIdentifierValue(CUSTOMER_EMAIL)},
                ${maskIdentifierValue(CUSTOMER_EMAIL, "email")}, 'bounced', ${w.owner.tenantUserId})
      `
    );
    const idem = key();
    const refused = await deliver(w.owner, DOC(w, "email"), idem);
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code).toBe("RECIPIENT_SUPPRESSED");
    expect(await emailRows(w.owner.tenantId)).toHaveLength(0);
    const list = await history(w.owner, "document", w.documentId);
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.items[0]!.status).toBe("not_enqueued");
    expect(list.body.data.items[0]!.failureReason).toBe("RECIPIENT_SUPPRESSED");
    expect(list.body.data.items[0]!.outbox.status).toBeNull();

    // WhatsApp has no suppression list: the other channel is unaffected.
    expect((await deliver(w.owner, DOC(w, "whatsapp"))).status).toBe(201);

    // Un-suppress, retry with the SAME key: it was not stored, so it succeeds.
    await admin`DELETE FROM awcms_email_suppression_list WHERE tenant_id = ${w.owner.tenantId}`;
    const retried = await deliver(w.owner, DOC(w, "email"), idem);
    expect(retried.status).toBe(201);
    expect(await emailRows(w.owner.tenantId)).toHaveLength(1);
  });

  test("a rolling-window limit per source bounds a stuck client", async () => {
    if (skipUnlessHandlerReady()) return;
    const w = await world();
    for (let i = 0; i < DELIVERY_RATE_LIMIT_MAX; i += 1) {
      expect((await deliver(w.owner, DOC(w, "whatsapp"))).status).toBe(201);
    }
    const limited = await deliver(w.owner, DOC(w, "whatsapp"));
    expect(limited.status).toBe(429);
    expect(limited.body.error?.code).toBe("DELIVERY_RATE_LIMITED");
    expect(limited.response.headers.get("retry-after")).toBe("3600");
    expect(await whatsappRows(w.owner.tenantId)).toHaveLength(
      DELIVERY_RATE_LIMIT_MAX
    );
  });

  test("quotation versions and work orders are delivered from their stored rows", async () => {
    if (skipUnlessHandlerReady()) return;
    const w = await world();
    const quote = await invoke<
      Envelope<{ id: string; number: string; total: string }>
    >(postQuotation, {
      method: "POST",
      path: "/api/v1/commerce/quotations",
      headers: headers(w.owner, key()),
      body: {
        customer: { name: "Pak Budi", phone: PHONE },
        lines: [{ productId: w.productId, quantity: 2 }]
      }
    });
    expect(quote.status).toBe(201);
    const sent = await deliver(w.owner, {
      targetType: "quotation_version",
      targetId: quote.body.data.id,
      channel: "whatsapp",
      locale: "en"
    });
    expect(sent.status).toBe(201);
    expect(sent.body.data.docNumber).toBe(quote.body.data.number);
    expect(sent.body.data.targetId).toBe(quote.body.data.id);
    const message = (
      await whatsappRows(w.owner.tenantId, sent.body.data.id)
    )[0]!;
    expect(message.body_rendered).toContain("Quotation");
    expect(message.body_rendered).toContain("Version: 1");
    expect(message.body_rendered).toContain(`Total: ${quote.body.data.total}`);
    expect(message.body_rendered).toContain(
      `Valid until: ${resolveSalesReportDay(new Date(Date.now() + 14 * 86_400_000))}`
    );
    const qHistory = await history(
      w.owner,
      "quotation_version",
      quote.body.data.id
    );
    expect(qHistory.body.data.items.map((item) => item.id)).toEqual([
      sent.body.data.id
    ]);
    // A version that does not exist is the neutral 404.
    expect(
      (
        await deliver(w.owner, {
          targetType: "quotation_version",
          targetId: quote.body.data.id,
          channel: "whatsapp",
          version: 9
        })
      ).status
    ).toBe(404);
    // The quotation's customer is the same customer row, whose e-mail is on
    // file: the default recipient for the e-mail channel resolves through it.
    const byEmail = await deliver(w.owner, {
      targetType: "quotation_version",
      targetId: quote.body.data.id,
      channel: "email"
    });
    expect(byEmail.status).toBe(201);
    expect(
      (await emailRows(w.owner.tenantId, byEmail.body.data.id))[0]!.to_address
    ).toBe(CUSTOMER_EMAIL);

    const order = await invoke<Envelope<{ id: string; status: string }>>(
      postWorkOrder,
      {
        method: "POST",
        path: "/api/v1/commerce/work-orders",
        headers: headers(w.owner, key()),
        body: {
          title: "Servis <rahasia>",
          description: "Catatan internal",
          customerId: w.customerId,
          dueAt: "2026-12-24T03:00:00.000Z"
        }
      }
    );
    expect(order.status).toBe(201);
    const notice = await deliver(w.owner, {
      targetType: "work_order",
      targetId: order.body.data.id,
      channel: "email"
    });
    expect(notice.status).toBe(201);
    const mail = (await emailRows(w.owner.tenantId, notice.body.data.id))[0]!;
    expect(mail.variables.body).toContain("Status: Diterima");
    expect(mail.variables.body).toContain("Target selesai: 2026-12-24");
    // Free text a staff member wrote for staff is not in the customer's message.
    expect(JSON.stringify(mail.variables)).not.toContain("rahasia");
    expect(JSON.stringify(mail.variables)).not.toContain("Catatan internal");
  });

  test("another tenant's source is the same 404 as an unknown one, and RLS hides one tenant's deliveries from another (BOLA)", async () => {
    if (skipUnlessHandlerReady()) return;
    const w = await world();
    const sent = await deliver(w.owner, DOC(w, "whatsapp"));
    expect(sent.status).toBe(201);

    const admin = getHandlerAdminSql();
    const otherTenant = "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b9b";
    await admin`
      INSERT INTO awcms_tenants (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
      VALUES (${otherTenant}, 'other-delivery', 'Other', 'Other', 'active', 'en', 'light')
    `;
    const db = getHandlerDatabaseClient();

    // Under the OTHER tenant's context, tenant A's document does not exist.
    const outcome = await withTenantOrThrow(db, otherTenant, (tx) =>
      requestDocumentDelivery(
        tx,
        {
          tenantId: otherTenant,
          actorTenantUserId: w.owner.tenantUserId,
          overrideAllowed: false,
          env: { ...process.env, COMMERCE_WHATSAPP_ENABLED: "true" }
        },
        {
          idempotencyKey: "bola-1",
          targetType: "document",
          targetId: w.documentId,
          version: null,
          channel: "whatsapp",
          locale: "id",
          recipientOverride: null,
          includeLink: false,
          linkTtlHours: 72
        }
      )
    );
    expect(outcome.kind).toBe("not_found");

    // RLS, as the real runtime role: the other tenant sees none of tenant A's
    // delivery rows (and tenant A sees its own) ...
    const visible = await asApp(
      otherTenant,
      (tx) =>
        tx`SELECT id FROM awcms_commerce_document_deliveries WHERE id = ${sent.body.data.id}`
    );
    expect(visible).toHaveLength(0);
    const own = await asApp(
      w.owner.tenantId,
      (tx) =>
        tx`SELECT id FROM awcms_commerce_document_deliveries WHERE id = ${sent.body.data.id}`
    );
    expect(own).toHaveLength(1);
    // ... and cannot write one pointing at tenant A's document under its OWN
    // tenant id: the source must exist in the writer's own tenant.
    await expectDbError(() =>
      asApp(
        otherTenant,
        (tx) => tx`
          INSERT INTO awcms_commerce_document_deliveries (
            tenant_id, target_type, document_id, doc_number, channel, recipient_source,
            recipient_masked, locale, template_key, template_version, content_hash,
            status, requested_by_tenant_user_id
          ) VALUES (
            ${otherTenant}, 'document', ${w.documentId}, ${w.number}, 'email', 'override',
            'x***@example.test', 'id', 'derived.transactional', 1, ${"a".repeat(64)},
            'queued', ${w.owner.tenantUserId}
          )
        `
      )
    );
    // ... nor forge tenant A's id: the policy's WITH CHECK refuses the row.
    await expectDbError(() =>
      asApp(
        otherTenant,
        (tx) => tx`
          INSERT INTO awcms_commerce_document_deliveries (
            tenant_id, target_type, document_id, doc_number, channel, recipient_source,
            recipient_masked, locale, template_key, template_version, content_hash,
            status, requested_by_tenant_user_id
          ) VALUES (
            ${w.owner.tenantId}, 'document', ${w.documentId}, ${w.number}, 'email', 'override',
            'x***@example.test', 'id', 'derived.transactional', 1, ${"a".repeat(64)},
            'queued', ${w.owner.tenantUserId}
          )
        `
      )
    );

    // An unknown id and the same call through the route agree.
    const unknownRoute = await deliver(w.owner, {
      targetType: "document",
      targetId: "00000000-0000-4000-8000-000000000000",
      channel: "whatsapp"
    });
    expect(unknownRoute.status).toBe(404);
    const foreignHistory = await history(
      w.owner,
      "document",
      "00000000-0000-4000-8000-000000000000"
    );
    expect(foreignHistory.body.data.items).toHaveLength(0);
  });

  test("a delivery row is append-only and the table refuses what its constraints forbid", async () => {
    if (skipUnlessHandlerReady()) return;
    const w = await world();
    const sent = await deliver(w.owner, DOC(w, "whatsapp"));
    // As the runtime role: UPDATE and DELETE are revoked ...
    await expectDbError(() =>
      asApp(
        w.owner.tenantId,
        (tx) =>
          tx`UPDATE awcms_commerce_document_deliveries SET status = 'not_enqueued' WHERE id = ${sent.body.data.id}`
      )
    );
    await expectDbError(() =>
      asApp(
        w.owner.tenantId,
        (tx) =>
          tx`DELETE FROM awcms_commerce_document_deliveries WHERE id = ${sent.body.data.id}`
      )
    );
    // ... and for anyone else the trigger refuses the rewrite (the table owner included).
    await expectDbError(
      () =>
        getHandlerAdminSql()`UPDATE awcms_commerce_document_deliveries SET locale = 'en' WHERE id = ${sent.body.data.id}`
    );
    // A wrong number for the named source is refused by the integrity trigger.
    await expectDbError(
      () => getHandlerAdminSql()`
        INSERT INTO awcms_commerce_document_deliveries (
          tenant_id, target_type, document_id, doc_number, channel, recipient_source,
          recipient_masked, locale, template_key, template_version, content_hash,
          status, requested_by_tenant_user_id
        ) VALUES (
          ${w.owner.tenantId}, 'document', ${w.documentId}, 'RCP-1999-000001', 'email',
          'override', 'x***@example.test', 'id', 'derived.transactional', 1, ${"a".repeat(64)},
          'queued', ${w.owner.tenantUserId}
        )
      `
    );
    // This table can never carry a marketing send.
    await expectDbError(
      () => getHandlerAdminSql()`
        INSERT INTO awcms_commerce_document_deliveries (
          tenant_id, target_type, document_id, doc_number, channel, purpose, recipient_source,
          recipient_masked, locale, template_key, template_version, content_hash,
          status, requested_by_tenant_user_id
        ) VALUES (
          ${w.owner.tenantId}, 'document', ${w.documentId}, ${w.number}, 'email', 'marketing',
          'override', 'x***@example.test', 'id', 'derived.transactional', 1, ${"a".repeat(64)},
          'queued', ${w.owner.tenantUserId}
        )
      `
    );
  });

  test("validation answers 400 with field errors, and the history needs a valid target", async () => {
    if (skipUnlessHandlerReady()) return;
    const w = await world();
    const bad = await deliver(w.owner, { targetType: "order", channel: "sms" });
    expect(bad.status).toBe(400);
    expect(bad.body.error?.code).toBe("VALIDATION_ERROR");
    const noTarget = await invoke<Envelope>(listDeliveries, {
      path: "/api/v1/commerce/document-deliveries",
      headers: headers(w.owner)
    });
    expect(noTarget.status).toBe(400);
  });
});
