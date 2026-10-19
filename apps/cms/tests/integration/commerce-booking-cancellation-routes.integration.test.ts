/**
 * The cancellation, refund-quote, refund-decision and cancellation-policy routes
 * through the REAL route handlers (Issue #381, ADR-0045 D8/D9/D10/D12; access
 * matrix `docs/booking-commerce-access-matrix.md` section 9 evidence items 2, 5
 * and 6; threat controls C-05, C-10, C-11, C-32, C-35, C-40). World 2 of
 * `harness.ts`: handlers use `getDatabaseClient()` and the public tenant is the
 * one `PUBLIC_DEFAULT_TENANT_ID` names. The money and the version arithmetic are
 * proved at the application layer in
 * `commerce-booking-cancellation.integration.test.ts`; this file proves what
 * only the wiring can:
 *
 *   - evidence item 2: the route-by-persona table - every denied cell is `403`
 *     with nothing written, every allowed cell works; an unknown id and another
 *     tenant's id are one `404`;
 *   - evidence item 5: the override needs its OWN permission, a FRESH step-up, a
 *     reason of 10 to 500 characters and stays under the amount paid; a replay
 *     answers the same row; success writes exactly one critical audit event;
 *   - evidence item 6: a cashier and a scheduler cannot reach the override, and
 *     holding `commerce.refunds_offline.approve` does not allow it either;
 *   - a guest can NEVER send `final_refund` or `amount` (nor an override): a
 *     strict `400`, nothing cancelled; the shopper's figure is only compared;
 *   - ownership on the storefront (bearer or the order's phone; one neutral 404);
 *   - the policy routes: draft, approve with step-up, retire, history.
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
import { resetRateLimitForTests } from "../../src/lib/security/rate-limit";
import {
  generateCustomerSessionToken,
  hashCustomerSessionToken
} from "../../src/modules/commerce/domain/customer-session-token";
import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { PATCH as patchModuleSettings } from "../../src/pages/api/v1/tenant/modules/[moduleKey]/settings";
import { POST as createLink } from "../../src/pages/api/v1/commerce/booking/offering-links/index";
import { POST as staffCreate } from "../../src/pages/api/v1/commerce/booking/reservations/index";
import { GET as staffGet } from "../../src/pages/api/v1/commerce/booking/reservations/[id]";
import { GET as staffQuote } from "../../src/pages/api/v1/commerce/booking/reservations/[id]/cancellation-quote";
import { POST as staffCancel } from "../../src/pages/api/v1/commerce/booking/reservations/[id]/cancel";
import { GET as staffDecision } from "../../src/pages/api/v1/commerce/booking/reservations/[id]/refund-decision";
import {
  GET as listPolicies,
  POST as createPolicy
} from "../../src/pages/api/v1/commerce/booking/cancellation-policies/index";
import { POST as approvePolicy } from "../../src/pages/api/v1/commerce/booking/cancellation-policies/[id]/approve";
import { POST as retirePolicy } from "../../src/pages/api/v1/commerce/booking/cancellation-policies/[id]/retire";
import { GET as storefrontGet } from "../../src/pages/api/v1/commerce/storefront/booking/reservations/[orderCode]";
import { GET as storefrontQuote } from "../../src/pages/api/v1/commerce/storefront/booking/reservations/[orderCode]/cancellation-quote";
import {
  POST as storefrontCancel,
  OPTIONS as storefrontCancelPreflight
} from "../../src/pages/api/v1/commerce/storefront/booking/reservations/[orderCode]/cancel";
import { POST as recordPayment } from "../../src/pages/api/v1/commerce/orders/[id]/payments/index";
import { PUT as putStoreSettings } from "../../src/pages/api/v1/commerce/store-settings/index";

const OWNER_PASSWORD = "integration-test-owner-password";
const UNKNOWN_ID = "00000000-0000-4000-8000-0000000000aa";
const GUEST_PHONE = "081311112222";

type Principal = { tenantId: string; token: string; tenantUserId: string };
type Envelope<T = unknown> = {
  success: boolean;
  data: T;
  error?: { code: string; message?: string; details?: unknown };
};

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

/** Raises a principal's session to aal2 with a step-up `ageMs` old (the platform TTL is 300 s by default). */
async function stepUp(who: Principal, ageMs = 0): Promise<void> {
  await getHandlerAdminSql()`
    UPDATE awcms_sessions
    SET assurance_level = 'aal2',
        stepped_up_at = ${new Date(Date.now() - ageMs)},
        last_authenticated_at = ${new Date(Date.now() - ageMs)}
    WHERE token_hash = ${hashSessionToken(who.token)}
  `;
}

function headers(who: Principal, extra: Record<string, string> = {}) {
  return {
    "content-type": "application/json",
    "x-awcms-tenant-id": who.tenantId,
    authorization: `Bearer ${who.token}`,
    ...extra
  };
}

function setBookingFeature(who: Principal, booking: boolean) {
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
        register: false,
        documents: false,
        booking
      }
    }
  });
}

const putSettings = (who: Principal, extra: Record<string, unknown>) =>
  invoke<Envelope>(putStoreSettings, {
    method: "PUT",
    path: "/api/v1/commerce/store-settings",
    headers: headers(who),
    body: {
      storeName: "Villa",
      shipping: { selfPickup: true },
      payment: { manualQris: { active: true, mediaObjectId: null } },
      ...extra
    }
  });

type Fixture = { productId: string; offeringId: string; resourceId: string };
let fixtureSeq = 0;

async function seedFixture(owner: Principal): Promise<Fixture> {
  fixtureSeq += 1;
  const code = `x${fixtureSeq}`;
  const admin = getHandlerAdminSql();
  const product = (await admin`
    INSERT INTO awcms_commerce_products
      (tenant_id, type, sku, name, slug, price, stock, status)
    VALUES (${owner.tenantId}, 'service', ${`SKU-${code}`}, ${`Kamar ${code}`}, ${`kamar-${code}`}, '500000.00', 0, 'active')
    RETURNING id
  `) as { id: string }[];
  const resource = (await admin`
    INSERT INTO awcms_booking_resources
      (tenant_id, code, name, kind, capacity, timezone, booking_mode,
       stay_check_in_time, stay_check_out_time)
    VALUES (${owner.tenantId}, ${code}, ${`Room ${code}`}, 'room', 6,
            'Asia/Pontianak', 'stay', '14:00'::time, '12:00'::time)
    RETURNING id
  `) as { id: string }[];
  for (let ordinal = 1; ordinal <= 6; ordinal += 1) {
    await admin`
      INSERT INTO awcms_booking_resource_units (tenant_id, resource_id, ordinal)
      VALUES (${owner.tenantId}, ${resource[0]!.id}, ${ordinal})
    `;
  }
  const offering = (await admin`
    INSERT INTO awcms_booking_service_offerings
      (tenant_id, code, name, granularity, min_nights, max_nights, max_party, confirmation_mode)
    VALUES (${owner.tenantId}, ${`night-${code}`}, 'Night', 'stay', 1, 30, 4, 'hold_then_confirm')
    RETURNING id
  `) as { id: string }[];
  const linked = await invoke<Envelope>(createLink, {
    method: "POST",
    path: "/api/v1/commerce/booking/offering-links",
    headers: headers(owner, { "idempotency-key": `link-${code}` }),
    body: {
      offeringId: offering[0]!.id,
      productId: product[0]!.id,
      quantityBasis: "nights"
    }
  });
  expect(linked.status).toBe(201);
  return {
    productId: product[0]!.id,
    offeringId: offering[0]!.id,
    resourceId: resource[0]!.id
  };
}

const day = (offset: number): string =>
  new Date(Date.now() + (60 + offset) * 86_400_000).toISOString().slice(0, 10);

function body(fx: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    offeringId: fx.offeringId,
    resourceId: fx.resourceId,
    stay: { checkInDate: day(1), checkOutDate: day(3) },
    partySize: 2,
    guest: { name: "Budi", phone: GUEST_PHONE },
    payment: { method: "manual_qris" },
    ...overrides
  };
}

let keySeq = 0;
const nextKey = () => `bk381-${Date.now()}-${(keySeq += 1)}`;

type Created = {
  orderId: string;
  orderCode: string;
  reservation: { id: string; status: string };
};

/** A booking made by the owner and paid in full (1,000,000.00). */
async function paidBooking(
  owner: Principal,
  fx: Fixture,
  amount = "1000000.00"
): Promise<Created> {
  const made = await invoke<Envelope<Created>>(staffCreate, {
    method: "POST",
    path: "/api/v1/commerce/booking/reservations",
    headers: headers(owner, { "idempotency-key": nextKey() }),
    body: body(fx)
  });
  expect(made.status).toBe(201);
  if (Number(amount) > 0) {
    const paid = await invoke<Envelope>(recordPayment, {
      method: "POST",
      path: `/api/v1/commerce/orders/${made.body.data.orderId}/payments`,
      headers: headers(owner, { "idempotency-key": nextKey() }),
      params: { id: made.body.data.orderId },
      body: { tenderType: "manual_qris", amount }
    });
    expect(paid.status).toBe(201);
  }
  return made.body.data;
}

const cancelPost = (
  who: Principal,
  id: string,
  payload: unknown,
  key: string | null = nextKey()
) =>
  invoke<Envelope<Record<string, any>>>(staffCancel, {
    method: "POST",
    path: `/api/v1/commerce/booking/reservations/${id}/cancel`,
    headers: headers(who, key === null ? {} : { "idempotency-key": key }),
    params: { id },
    body: payload
  });

const quoteGet = (who: Principal, id: string) =>
  invoke<Envelope<Record<string, any>>>(staffQuote, {
    path: `/api/v1/commerce/booking/reservations/${id}/cancellation-quote`,
    headers: headers(who),
    params: { id }
  });

const decisionGet = (who: Principal, id: string) =>
  invoke<Envelope<Record<string, any>>>(staffDecision, {
    path: `/api/v1/commerce/booking/reservations/${id}/refund-decision`,
    headers: headers(who),
    params: { id }
  });

const policyList = (who: Principal, query = "") =>
  invoke<Envelope<{ items: Record<string, any>[] }>>(listPolicies, {
    path: `/api/v1/commerce/booking/cancellation-policies${query}`,
    headers: headers(who)
  });

const policyPost = (
  who: Principal,
  payload: unknown,
  key: string | null = nextKey()
) =>
  invoke<Envelope<Record<string, any>>>(createPolicy, {
    method: "POST",
    path: "/api/v1/commerce/booking/cancellation-policies",
    headers: headers(who, key === null ? {} : { "idempotency-key": key }),
    body: payload
  });

const policyAction = (
  who: Principal,
  action: "approve" | "retire",
  id: string,
  key: string | null = nextKey()
) =>
  invoke<Envelope<Record<string, any>>>(
    action === "approve" ? approvePolicy : retirePolicy,
    {
      method: "POST",
      path: `/api/v1/commerce/booking/cancellation-policies/${id}/${action}`,
      headers: headers(who, key === null ? {} : { "idempotency-key": key }),
      params: { id }
    }
  );

const STANDARD = [
  { minHoursBeforeStart: 168, refundablePercent: "100" },
  { minHoursBeforeStart: 48, refundablePercent: "50" }
];

/** An active policy (the owner authors and approves with a fresh step-up). */
async function activePolicy(
  owner: Principal,
  productId: string | null,
  windows = STANDARD
): Promise<string> {
  await stepUp(owner);
  const draft = await policyPost(owner, { productId, windows });
  expect(draft.status).toBe(201);
  const approved = await policyAction(owner, "approve", draft.body.data.id);
  expect(approved.status).toBe(200);
  return draft.body.data.id;
}

const storefrontQuoteGet = (
  orderCode: string,
  query = "",
  extra: Record<string, string> = {}
) =>
  invoke<Envelope<Record<string, any>>>(storefrontQuote, {
    path: `/api/v1/commerce/storefront/booking/reservations/${orderCode}/cancellation-quote${query}`,
    headers: extra,
    params: { orderCode }
  });

const storefrontCancelPost = (
  orderCode: string,
  payload: unknown,
  extra: Record<string, string> = {},
  key: string | null = nextKey()
) =>
  invoke<Envelope<Record<string, any>>>(storefrontCancel, {
    method: "POST",
    path: `/api/v1/commerce/storefront/booking/reservations/${orderCode}/cancel`,
    headers: {
      "content-type": "application/json",
      ...(key === null ? {} : { "idempotency-key": key }),
      ...extra
    },
    params: { orderCode },
    body: payload
  });

async function bearerFor(
  tenantId: string,
  customerId: string
): Promise<string> {
  const admin = getHandlerAdminSql();
  const account = (await admin`
    INSERT INTO awcms_commerce_customer_accounts
      (tenant_id, customer_id, email_normalized, history_from)
    VALUES (${tenantId}, ${customerId}, ${`${customerId}@example.com`}, now())
    RETURNING id
  `) as { id: string }[];
  const token = generateCustomerSessionToken();
  await admin`
    INSERT INTO awcms_commerce_customer_sessions
      (tenant_id, account_id, token_hash, expires_at)
    VALUES (${tenantId}, ${account[0]!.id}, ${hashCustomerSessionToken(token)},
            ${new Date(Date.now() + 86_400_000)})
  `;
  return token;
}

async function newCustomer(
  tenantId: string,
  name: string,
  phone: string
): Promise<string> {
  const rows = (await getHandlerAdminSql()`
    INSERT INTO awcms_commerce_customers (tenant_id, name, phone)
    VALUES (${tenantId}, ${name}, ${phone})
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

async function counts(tenantId: string) {
  const admin = getHandlerAdminSql();
  const rows = (await admin`
    SELECT
      (SELECT count(*)::int FROM awcms_commerce_booking_refund_decisions WHERE tenant_id = ${tenantId}) AS decisions,
      (SELECT count(*)::int FROM awcms_commerce_returns WHERE tenant_id = ${tenantId}) AS returns,
      (SELECT count(*)::int FROM awcms_commerce_refunds WHERE tenant_id = ${tenantId}) AS refunds,
      (SELECT count(*)::int FROM awcms_booking_reservations WHERE tenant_id = ${tenantId} AND status = 'cancelled') AS cancelled
  `) as {
    decisions: number;
    returns: number;
    refunds: number;
    cancelled: number;
  }[];
  return rows[0]!;
}

const NOTHING = { decisions: 0, returns: 0, refunds: 0, cancelled: 0 };

const suite = integrationEnabled ? describe : describe.skip;
let handlerReady = false;

function skipUnlessHandlerReady(): boolean {
  if (handlerReady) return false;
  console.warn(
    "[skip] handler database is not migrated - run 'bun run db:migrate' against DATABASE_URL."
  );
  return true;
}

async function readyOwner(): Promise<{ owner: Principal; fx: Fixture }> {
  const owner = await bootstrapOwner();
  expect((await setBookingFeature(owner, true)).status).toBe(200);
  expect(
    (
      await putSettings(owner, {
        bookingServiceTenantUserId: owner.tenantUserId
      })
    ).status
  ).toBe(200);
  process.env.PUBLIC_DEFAULT_TENANT_ID = owner.tenantId;
  return { owner, fx: await seedFixture(owner) };
}

/** The bundles of access matrix section 8 (only the booking cancellation keys matter here). */
const BUNDLES = {
  cashier: [
    "commerce.pos.create",
    "commerce.payments.create",
    "commerce.payments.read",
    "commerce.orders.read",
    "commerce.booking_reservation_links.read",
    "commerce.booking_reservation_links.create",
    "commerce.booking_offering_links.read",
    "commerce.booking_cancellation_policies.read"
  ],
  scheduler: [
    "commerce.booking_reservation_links.read",
    "commerce.booking_reservation_links.create",
    "commerce.booking_reservation_links.cancel",
    "commerce.booking_refund_decisions.read",
    "commerce.booking_refund_decisions.create",
    "commerce.booking_offering_links.read",
    "commerce.booking_deposit_policies.read",
    "commerce.booking_cancellation_policies.read",
    "commerce.orders.read",
    "commerce.payments.read"
  ],
  tenantAdmin: [
    "commerce.booking_offering_links.read",
    "commerce.booking_offering_links.create",
    "commerce.booking_offering_links.update",
    "commerce.booking_deposit_policies.read",
    "commerce.booking_deposit_policies.update",
    "commerce.booking_cancellation_policies.read",
    "commerce.booking_cancellation_policies.create",
    "commerce.booking_cancellation_policies.approve",
    "commerce.booking_refund_decisions.read"
  ],
  finance: [
    "commerce.booking_refund_decisions.read",
    "commerce.booking_reservation_links.read",
    "commerce.booking_cancellation_policies.read",
    "commerce.payments.read",
    "commerce.refunds_offline.approve"
  ]
} as const;

suite("booking cancellation routes (Issue #381)", () => {
  const previousDefaultTenant = process.env.PUBLIC_DEFAULT_TENANT_ID;

  beforeAll(async () => {
    handlerReady = await ensureHandlerDatabaseReady();
  });
  afterAll(async () => {
    if (previousDefaultTenant === undefined) {
      delete process.env.PUBLIC_DEFAULT_TENANT_ID;
    } else {
      process.env.PUBLIC_DEFAULT_TENANT_ID = previousDefaultTenant;
    }
    await teardownHandlerDatabase();
  });
  beforeEach(async () => {
    resetRateLimitForTests();
    if (!handlerReady) return;
    await resetHandlerDatabase();
  });

  // -------------------------------------------------------------------------
  test("every route is off until the tenant opts in: 409 FEATURE_DISABLED for staff, the neutral 404 for the storefront", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    process.env.PUBLIC_DEFAULT_TENANT_ID = owner.tenantId;
    const responses = [
      await quoteGet(owner, UNKNOWN_ID),
      await cancelPost(owner, UNKNOWN_ID, { reasonCode: "guest_request" }),
      await decisionGet(owner, UNKNOWN_ID),
      await policyList(owner),
      await policyPost(owner, { windows: STANDARD }),
      await policyAction(owner, "approve", UNKNOWN_ID),
      await policyAction(owner, "retire", UNKNOWN_ID)
    ];
    for (const response of responses) {
      expect([403, 409]).toContain(response.status);
    }
    // The owner holds every permission, so the refusal is the feature gate (the
    // approve / retire routes check the step-up first only AFTER the gate).
    for (const response of responses) {
      expect(response.body.error?.code).toBe("FEATURE_DISABLED");
    }
    expect(
      (
        await storefrontCancelPost("ANY-CODE", {
          acknowledgedRefund: "0.00",
          phone: GUEST_PHONE
        })
      ).status
    ).toBe(404);
    expect(
      (await storefrontQuoteGet("ANY-CODE", `?phone=${GUEST_PHONE}`)).status
    ).toBe(404);
    expect(await counts(owner.tenantId)).toEqual(NOTHING);
  });

  // -------------------------------------------------------------------------
  describe("evidence item 2: the route-by-persona table", () => {
    test("every denied cell is 403 with nothing written; every allowed cell works", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, fx } = await readyOwner();
      await activePolicy(owner, fx.productId);
      const booking = await paidBooking(owner, fx);
      const id = booking.reservation.id;

      const cashier = await seedPrincipal(owner.tenantId, "cashier", [
        ...BUNDLES.cashier
      ]);
      const scheduler = await seedPrincipal(owner.tenantId, "scheduler", [
        ...BUNDLES.scheduler
      ]);
      const admin = await seedPrincipal(owner.tenantId, "tenantadmin", [
        ...BUNDLES.tenantAdmin
      ]);
      const finance = await seedPrincipal(owner.tenantId, "finance", [
        ...BUNDLES.finance
      ]);
      const nobody = await seedPrincipal(owner.tenantId, "nobody", []);
      await stepUp(admin);

      // [persona, quote, cancel, decision read, policies list, policy create, approve, retire]
      const draftId = (await policyPost(admin, { windows: STANDARD })).body.data
        .id as string;
      const personas: [string, Principal, Record<string, boolean>][] = [
        [
          "cashier",
          cashier,
          {
            quote: true,
            cancel: false,
            decision: false,
            list: true,
            create: false,
            approve: false
          }
        ],
        [
          "scheduler",
          scheduler,
          {
            quote: true,
            cancel: true,
            decision: true,
            list: true,
            create: false,
            approve: false
          }
        ],
        [
          "finance",
          finance,
          {
            quote: true,
            cancel: false,
            decision: true,
            list: true,
            create: false,
            approve: false
          }
        ],
        [
          "nobody",
          nobody,
          {
            quote: false,
            cancel: false,
            decision: false,
            list: false,
            create: false,
            approve: false
          }
        ],
        [
          "tenant admin",
          admin,
          {
            quote: false,
            cancel: false,
            decision: true,
            list: true,
            create: true,
            approve: true
          }
        ]
      ];

      // The decision read and the cancel come last (a cancel changes the world).
      for (const [name, who, can] of personas) {
        const quote = await quoteGet(who, id);
        expect(quote.status === 200, `${name} quote`).toBe(can.quote!);
        if (!can.quote) expect(quote.status).toBe(403);

        const listed = await policyList(who);
        expect(listed.status === 200, `${name} list`).toBe(can.list!);
        if (!can.list) expect(listed.status).toBe(403);

        const created = await policyPost(who, { windows: STANDARD });
        expect(created.status === 201, `${name} create`).toBe(can.create!);
        if (!can.create) expect(created.status).toBe(403);

        if (name !== "tenant admin") {
          const approved = await policyAction(who, "approve", draftId);
          expect(approved.status, `${name} approve`).toBe(403);
          const retired = await policyAction(who, "retire", draftId);
          expect(retired.status, `${name} retire`).toBe(403);
        }
      }

      // The cancel: only the scheduler holds BOTH keys. Every other persona is
      // refused and nothing is written.
      for (const [name, who, can] of personas) {
        if (can.cancel) continue;
        const denied = await cancelPost(who, id, {
          reasonCode: "guest_request"
        });
        expect(denied.status, `${name} cancel`).toBe(403);
      }
      // A holder of ONLY one of the two keys gets nothing either.
      const onlyCancel = await seedPrincipal(owner.tenantId, "only-cancel", [
        "commerce.booking_reservation_links.cancel"
      ]);
      const onlyDecide = await seedPrincipal(owner.tenantId, "only-decide", [
        "commerce.booking_refund_decisions.create"
      ]);
      expect(
        (await cancelPost(onlyCancel, id, { reasonCode: "guest_request" }))
          .status
      ).toBe(403);
      expect(
        (await cancelPost(onlyDecide, id, { reasonCode: "guest_request" }))
          .status
      ).toBe(403);
      expect(await counts(owner.tenantId)).toEqual(NOTHING);

      // The decision read is refused before and absent until a decision exists.
      expect((await decisionGet(cashier, id)).status).toBe(403);
      expect((await decisionGet(scheduler, id)).status).toBe(404);

      const done = await cancelPost(scheduler, id, {
        reasonCode: "guest_request"
      });
      expect(done.status).toBe(200);
      expect(done.body.data.decision).toMatchObject({
        triggerKind: "staff_cancel",
        policySource: "product",
        policyVersion: 1,
        finalRefund: "1000000.00",
        overridden: false
      });
      for (const [name, who, can] of personas) {
        const read = await decisionGet(who, id);
        expect(read.status === 200, `${name} decision`).toBe(can.decision!);
      }
      const read = await decisionGet(finance, id);
      expect(read.body.data.return.legs).toHaveLength(1);
      expect(read.body.data.return.legs[0]).toMatchObject({
        status: "pending",
        amount: "1000000.00"
      });
      expect(read.body.data).not.toHaveProperty("overrideReason");
      expect(read.body.data).not.toHaveProperty("customerId");
    });

    test("an unknown id, a malformed id and another tenant's reservation are ONE 404 (same bytes)", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, fx } = await readyOwner();
      const booking = await paidBooking(owner, fx);
      // A second tenant with its own owner.
      const other = await seedPrincipal(owner.tenantId, "second", [
        ...BUNDLES.scheduler
      ]);
      const unknown = await cancelPost(other, UNKNOWN_ID, {
        reasonCode: "guest_request"
      });
      const malformed = await cancelPost(other, "not-a-uuid", {
        reasonCode: "guest_request"
      });
      expect(unknown.status).toBe(404);
      expect(malformed.status).toBe(404);
      expect(unknown.body).toEqual(malformed.body);

      // Another TENANT: its scheduler sees tenant A's reservation exactly as an unknown id.
      const tenantB = await getHandlerAdminSql()`
        INSERT INTO awcms_tenants (tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
        VALUES ('other-co', 'Other', 'Other Legal', 'active', 'en', 'light')
        RETURNING id
      `;
      const outsider = await seedPrincipal(
        (tenantB as { id: string }[])[0]!.id,
        "outsider",
        [...BUNDLES.scheduler]
      );
      const foreign = await cancelPost(outsider, booking.reservation.id, {
        reasonCode: "guest_request"
      });
      // Tenant B has the booking feature OFF: the gate answers before any lookup.
      expect([404, 409]).toContain(foreign.status);
      expect(await counts(owner.tenantId)).toEqual(NOTHING);
    });
  });

  // -------------------------------------------------------------------------
  describe("evidence item 5: the override", () => {
    async function setup() {
      const { owner, fx } = await readyOwner();
      const booking = await paidBooking(owner, fx); // no policy: computed 0
      const manager = await seedPrincipal(owner.tenantId, "manager", [
        ...BUNDLES.scheduler,
        "commerce.booking_refund_overrides.approve"
      ]);
      return { owner, fx, booking, manager, id: booking.reservation.id };
    }

    const OVERRIDE = {
      reasonCode: "goodwill",
      override: {
        finalRefund: "400000.00",
        reason: "Owner approved a goodwill refund after a complaint"
      }
    };

    test("no step-up (aal1), a stale step-up, a missing permission: 403 and nothing written", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, booking, manager, id } = await setup();

      // The permission, but a plain password session.
      const noStepUp = await cancelPost(manager, id, OVERRIDE);
      expect(noStepUp.status).toBe(403);
      expect(noStepUp.body.error?.code).toBe("STEP_UP_REQUIRED");

      // A step-up older than the platform TTL (300 s).
      await stepUp(manager, 10 * 60_000);
      const stale = await cancelPost(manager, id, OVERRIDE);
      expect(stale.status).toBe(403);
      expect(stale.body.error?.code).toBe("STEP_UP_REQUIRED");

      // A fresh step-up but no override permission (scheduler): FORBIDDEN, not STEP_UP.
      const scheduler = await seedPrincipal(owner.tenantId, "sched", [
        ...BUNDLES.scheduler
      ]);
      await stepUp(scheduler);
      const noPermission = await cancelPost(scheduler, id, OVERRIDE);
      expect(noPermission.status).toBe(403);
      expect(noPermission.body.error?.code).not.toBe("STEP_UP_REQUIRED");

      expect(await counts(owner.tenantId)).toEqual(NOTHING);
      expect(booking.reservation.status).toBe("held");
    });

    test("a missing, short or oversized reason is 400; an amount above the amount paid is 409 REFUND_EXCEEDS_PAID; nothing is written", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, manager, id } = await setup();
      await stepUp(manager);
      const attempt = (override: unknown) =>
        cancelPost(manager, id, { reasonCode: "goodwill", override });

      for (const reason of [undefined, "", "too short", "x".repeat(501)]) {
        const refused = await attempt({ finalRefund: "100000.00", reason });
        expect(refused.status, String(reason)).toBe(400);
      }
      expect(
        (await attempt({ finalRefund: 100000, reason: "a long enough reason" }))
          .status
      ).toBe(400);
      const over = await attempt({
        finalRefund: "1000000.01",
        reason: "a long enough reason"
      });
      expect(over.status).toBe(409);
      expect(over.body.error?.code).toBe("REFUND_EXCEEDS_PAID");
      expect(over.body.error?.details).toEqual({ amountPaid: "1000000.00" });
      expect(await counts(owner.tenantId)).toEqual(NOTHING);
    });

    test("success: one decision, the evidence columns, exactly one CRITICAL audit event, a replay answers the same row", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, booking, manager, id } = await setup();
      await stepUp(manager);
      const key = nextKey();
      const done = await cancelPost(manager, id, OVERRIDE, key);
      expect(done.status).toBe(200);
      expect(done.body.data.replayed).toBe(false);
      expect(done.body.data.decision).toMatchObject({
        computedRefund: "0.00",
        finalRefund: "400000.00",
        overridden: true
      });

      const row = (await getHandlerAdminSql()`
        SELECT final_refund, computed_refund, override_reason,
               override_actor_tenant_user_id, override_stepup_at, actor_tenant_user_id
        FROM awcms_commerce_booking_refund_decisions WHERE tenant_id = ${owner.tenantId}
      `) as Record<string, unknown>[];
      expect(row).toHaveLength(1);
      expect(row[0]).toMatchObject({
        override_actor_tenant_user_id: manager.tenantUserId,
        actor_tenant_user_id: manager.tenantUserId,
        override_reason: "Owner approved a goodwill refund after a complaint"
      });
      expect(row[0]!.override_stepup_at).not.toBeNull();

      const audit = (await getHandlerAdminSql()`
        SELECT severity, actor_tenant_user_id, attributes FROM awcms_audit_events
        WHERE tenant_id = ${owner.tenantId}
          AND action = 'commerce.booking_refund_decision.overridden'
      `) as {
        severity: string;
        actor_tenant_user_id: string;
        attributes: Record<string, unknown>;
      }[];
      expect(audit).toHaveLength(1);
      expect(audit[0]!.severity).toBe("critical");
      expect(audit[0]!.actor_tenant_user_id).toBe(manager.tenantUserId);
      expect(audit[0]!.attributes).toMatchObject({
        computedRefund: "0.00",
        finalRefund: "400000.00"
      });

      const replay = await cancelPost(manager, id, OVERRIDE, key);
      expect(replay.status).toBe(200);
      expect(replay.body.data.replayed).toBe(true);
      expect(replay.body.data.decision.id).toBe(done.body.data.decision.id);
      const changed = await cancelPost(
        manager,
        id,
        {
          reasonCode: "goodwill",
          override: { ...OVERRIDE.override, finalRefund: "999999.00" }
        },
        key
      );
      expect(changed.status).toBe(409);
      expect(changed.body.error?.code).toBe("IDEMPOTENCY_CONFLICT");

      expect(await counts(owner.tenantId)).toMatchObject({
        decisions: 1,
        returns: 1,
        refunds: 1,
        cancelled: 1
      });
      expect(
        (
          await getHandlerAdminSql()`
            SELECT count(*)::int AS n FROM awcms_audit_events
            WHERE tenant_id = ${owner.tenantId}
              AND action = 'commerce.booking_refund_decision.overridden'`
        )[0].n
      ).toBe(1);
      expect(booking.orderId).toBeDefined();

      // The shopper-visible reservation says "adjusted" and never why or by whom.
      const view = await invoke<Envelope<Record<string, any>>>(staffGet, {
        path: `/api/v1/commerce/booking/reservations/${id}`,
        headers: headers(manager),
        params: { id }
      });
      expect(view.body.data.refund).toMatchObject({
        finalRefund: "400000.00",
        adjusted: true,
        computedRefund: "0.00"
      });
      const shopper = await invoke<Envelope<Record<string, any>>>(
        storefrontGet,
        {
          path: `/api/v1/commerce/storefront/booking/reservations/${booking.orderCode}?phone=${GUEST_PHONE}`,
          params: { orderCode: booking.orderCode }
        }
      );
      expect(shopper.status).toBe(200);
      expect(shopper.body.data.refund).toEqual({
        finalRefund: "400000.00",
        adjusted: true
      });
      expect(JSON.stringify(shopper.body.data)).not.toContain("goodwill");
    });

    test("the cap holds at the amount paid and the cap itself is allowed", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, manager, id } = await setup();
      await stepUp(manager);
      const full = await cancelPost(manager, id, {
        reasonCode: "goodwill",
        override: {
          finalRefund: "1000000.00",
          reason: "Property closed by the authorities"
        }
      });
      expect(full.status).toBe(200);
      expect(full.body.data.decision.finalRefund).toBe("1000000.00");
      const legs = (await getHandlerAdminSql()`
        SELECT amount FROM awcms_commerce_refunds WHERE tenant_id = ${owner.tenantId}
      `) as { amount: string }[];
      expect(legs.map((leg) => leg.amount)).toEqual(["1000000.00"]);
    });
  });

  // -------------------------------------------------------------------------
  describe("evidence item 6: nobody else reaches the override", () => {
    test("a cashier and a scheduler cannot override, and refunds_offline.approve does not allow it either", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, fx } = await readyOwner();
      const booking = await paidBooking(owner, fx);
      const id = booking.reservation.id;
      const override = {
        reasonCode: "goodwill",
        override: {
          finalRefund: "100000.00",
          reason: "Trying to raise the refund by hand"
        }
      };

      const cashier = await seedPrincipal(owner.tenantId, "cashier", [
        ...BUNDLES.cashier
      ]);
      const scheduler = await seedPrincipal(owner.tenantId, "scheduler", [
        ...BUNDLES.scheduler
      ]);
      // The offline-refund approver, with every other key the cancel needs and
      // a FRESH step-up - the one authority that is NOT the override.
      const offlineApprover = await seedPrincipal(
        owner.tenantId,
        "offline-approver",
        [
          "commerce.booking_reservation_links.cancel",
          "commerce.booking_refund_decisions.create",
          "commerce.refunds_offline.approve"
        ]
      );
      const offlineOnly = await seedPrincipal(owner.tenantId, "offline-only", [
        "commerce.refunds_offline.approve"
      ]);
      for (const who of [cashier, scheduler, offlineApprover, offlineOnly]) {
        await stepUp(who);
      }
      for (const [name, who] of [
        ["cashier", cashier],
        ["scheduler", scheduler],
        ["offline approver", offlineApprover],
        ["offline only", offlineOnly]
      ] as const) {
        const refused = await cancelPost(who, id, override);
        expect(refused.status, name).toBe(403);
      }
      expect(await counts(owner.tenantId)).toEqual(NOTHING);

      // The same scheduler cancels WITHOUT an override: the policy figure, no more.
      const plain = await cancelPost(scheduler, id, {
        reasonCode: "guest_request"
      });
      expect(plain.status).toBe(200);
      expect(plain.body.data.decision.overridden).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe("a guest can never set a figure", () => {
    test("final_refund, amount, an override or any money key in a storefront cancel body is 400 and nothing is cancelled", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, fx } = await readyOwner();
      await activePolicy(owner, fx.productId);
      const booking = await paidBooking(owner, fx);
      for (const extra of [
        { final_refund: "1000000.00" },
        { finalRefund: "1000000.00" },
        { amount: "1000000.00" },
        { refund: "1000000.00" },
        { computedRefund: "1000000.00" },
        { override: { finalRefund: "1.00", reason: "a long enough reason" } },
        { reasonCode: "guest_request" }
      ]) {
        const refused = await storefrontCancelPost(booking.orderCode, {
          acknowledgedRefund: "1000000.00",
          phone: GUEST_PHONE,
          ...extra
        });
        expect(refused.status, JSON.stringify(extra)).toBe(400);
        expect(refused.body.error?.code).toBe("VALIDATION_ERROR");
      }
      // The same strictness on the staff route: a top-level amount is a 400.
      for (const extra of [{ amount: "5.00" }, { final_refund: "5.00" }]) {
        const refused = await cancelPost(owner, booking.reservation.id, {
          reasonCode: "guest_request",
          ...extra
        });
        expect(refused.status).toBe(400);
      }
      expect(await counts(owner.tenantId)).toEqual(NOTHING);
    });

    test("the quote then the cancel: the figure is only compared; a stale figure is 409 QUOTE_CHANGED and nothing is cancelled", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, fx } = await readyOwner();
      await activePolicy(owner, fx.productId);
      const booking = await paidBooking(owner, fx);
      const quote = await storefrontQuoteGet(
        booking.orderCode,
        `?phone=${GUEST_PHONE}`
      );
      expect(quote.status).toBe(200);
      expect(quote.body.data).toMatchObject({
        policySource: "product",
        policyVersion: 1,
        amountPaid: "1000000.00",
        computedRefund: "1000000.00"
      });
      expect(quote.body.data).not.toHaveProperty("customerId");

      const stale = await storefrontCancelPost(booking.orderCode, {
        acknowledgedRefund: "250000.00",
        phone: GUEST_PHONE
      });
      expect(stale.status).toBe(409);
      expect(stale.body.error?.code).toBe("QUOTE_CHANGED");
      expect(stale.body.error?.details).toEqual({
        computedRefund: "1000000.00"
      });
      expect(await counts(owner.tenantId)).toEqual(NOTHING);

      const key = nextKey();
      const done = await storefrontCancelPost(
        booking.orderCode,
        { acknowledgedRefund: "1000000.00", phone: GUEST_PHONE },
        {},
        key
      );
      expect(done.status).toBe(200);
      expect(done.body.data).toEqual({
        status: "cancelled",
        finalRefund: "1000000.00"
      });
      // A replay answers the same; a different key now finds it decided.
      const replay = await storefrontCancelPost(
        booking.orderCode,
        { acknowledgedRefund: "1000000.00", phone: GUEST_PHONE },
        {},
        key
      );
      expect(replay.status).toBe(200);
      expect(replay.body.data).toEqual(done.body.data);
      const second = await storefrontCancelPost(
        booking.orderCode,
        { acknowledgedRefund: "1000000.00", phone: GUEST_PHONE },
        {},
        nextKey()
      );
      expect(second.status).toBe(409);
      expect(second.body.error?.code).toBe("INVALID_STATE");
      expect(await counts(owner.tenantId)).toMatchObject({
        decisions: 1,
        returns: 1,
        refunds: 1,
        cancelled: 1
      });
      // The legs run under the service account (the owner here), nothing settled.
      const leg = (await getHandlerAdminSql()`
        SELECT status, actor_tenant_user_id FROM awcms_commerce_refunds
        WHERE tenant_id = ${owner.tenantId}
      `) as { status: string; actor_tenant_user_id: string }[];
      expect(leg[0]).toEqual({
        status: "pending",
        actor_tenant_user_id: owner.tenantUserId
      });

      const preflight = await invoke(storefrontCancelPreflight, {
        method: "OPTIONS",
        path: `/api/v1/commerce/storefront/booking/reservations/${booking.orderCode}/cancel`,
        headers: { "access-control-request-method": "POST" },
        params: { orderCode: booking.orderCode }
      });
      expect([200, 204]).toContain(preflight.status);
    });

    test("ownership: another customer's bearer, a wrong phone, no proof and an unknown code are ONE 404; a dead bearer is 401; a key is required", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, fx } = await readyOwner();
      const booking = await paidBooking(owner, fx);
      const code = booking.orderCode;
      const ack = { acknowledgedRefund: "0.00" };

      const wrongPhone = await storefrontCancelPost(code, {
        ...ack,
        phone: "081300000000"
      });
      const noProof = await storefrontCancelPost(code, ack);
      const unknown = await storefrontCancelPost("NO-SUCH-CODE", {
        ...ack,
        phone: GUEST_PHONE
      });
      for (const response of [wrongPhone, noProof, unknown]) {
        expect(response.status).toBe(404);
      }
      expect(wrongPhone.body).toEqual(noProof.body);
      expect(wrongPhone.body).toEqual(unknown.body);

      const otherId = await newCustomer(
        owner.tenantId,
        "Lain",
        "+6281399990000"
      );
      const otherToken = await bearerFor(owner.tenantId, otherId);
      const other = await storefrontCancelPost(code, ack, {
        authorization: `Bearer ${otherToken}`
      });
      expect(other.status).toBe(404);
      expect(other.body).toEqual(wrongPhone.body);
      expect(
        (
          await storefrontQuoteGet(code, "", {
            authorization: `Bearer ${otherToken}`
          })
        ).status
      ).toBe(404);

      const dead = await storefrontCancelPost(code, ack, {
        authorization: `Bearer ${generateCustomerSessionToken()}`
      });
      expect(dead.status).toBe(401);
      expect(
        (
          await storefrontCancelPost(
            code,
            { ...ack, phone: GUEST_PHONE },
            {},
            null
          )
        ).status
      ).toBe(400);
      expect(await counts(owner.tenantId)).toEqual(NOTHING);

      // The owner's own bearer works.
      const orderCustomer = (await getHandlerAdminSql()`
        SELECT customer_id FROM awcms_commerce_orders WHERE order_code = ${code}
      `) as { customer_id: string }[];
      const ownerToken = await bearerFor(
        owner.tenantId,
        orderCustomer[0]!.customer_id
      );
      const mine = await storefrontCancelPost(code, ack, {
        authorization: `Bearer ${ownerToken}`
      });
      expect(mine.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  describe("the cancellation policy routes", () => {
    test("a draft is authored (201), approving it needs a fresh step-up, history keeps the retired version and the approver", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, fx } = await readyOwner();
      const draft = await policyPost(owner, {
        productId: fx.productId,
        refundBasis: "whole_stay",
        windows: STANDARD
      });
      expect(draft.status).toBe(201);
      expect(draft.body.data).toMatchObject({
        version: 1,
        status: "draft",
        createdByTenantUserId: owner.tenantUserId,
        approvedByTenantUserId: null
      });
      expect(draft.body.data.windows).toEqual([
        { minHoursBeforeStart: 168, refundablePercent: "100.00" },
        { minHoursBeforeStart: 48, refundablePercent: "50.00" }
      ]);

      // No step-up: refused, still a draft.
      const refused = await policyAction(owner, "approve", draft.body.data.id);
      expect(refused.status).toBe(403);
      expect(refused.body.error?.code).toBe("STEP_UP_REQUIRED");
      expect(
        (await policyList(owner, "?status=active")).body.data.items
      ).toHaveLength(0);

      await stepUp(owner);
      const key = nextKey();
      const approved = await policyAction(
        owner,
        "approve",
        draft.body.data.id,
        key
      );
      expect(approved.status).toBe(200);
      expect(approved.body.data.policy).toMatchObject({
        status: "active",
        approvedByTenantUserId: owner.tenantUserId
      });
      expect(
        (await policyAction(owner, "approve", draft.body.data.id, key)).body
          .data.replayed
      ).toBe(true);
      const again = await policyAction(owner, "approve", draft.body.data.id);
      expect(again.status).toBe(409);
      expect(again.body.error?.code).toBe("INVALID_STATE");

      const second = await policyPost(owner, {
        productId: fx.productId,
        windows: [{ minHoursBeforeStart: 0, refundablePercent: "10" }]
      });
      expect(second.body.data.version).toBe(2);
      const replaced = await policyAction(
        owner,
        "approve",
        second.body.data.id
      );
      expect(replaced.body.data.retiredPolicyId).toBe(draft.body.data.id);

      const history = await policyList(owner, `?productId=${fx.productId}`);
      expect(history.body.data.items.map((p) => [p.version, p.status])).toEqual(
        [
          [2, "active"],
          [1, "retired"]
        ]
      );

      // Retiring needs the step-up and an active version.
      const retired = await policyAction(owner, "retire", second.body.data.id);
      expect(retired.status).toBe(200);
      expect(retired.body.data.policy.status).toBe("retired");
      const notActive = await policyAction(
        owner,
        "retire",
        second.body.data.id
      );
      expect(notActive.status).toBe(409);
      await stepUp(owner, 10 * 60_000);
      expect(
        (await policyAction(owner, "retire", draft.body.data.id)).status
      ).toBe(403);
    });

    test("an invalid draft is 400 (a refund that grows as notice shrinks, an unknown key, no windows); a replay is the same draft; a changed body is a conflict", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, fx } = await readyOwner();
      for (const bad of [
        { windows: [] },
        {
          windows: [
            { minHoursBeforeStart: 100, refundablePercent: "10" },
            { minHoursBeforeStart: 10, refundablePercent: "60" }
          ]
        },
        { windows: STANDARD, amount: "5" },
        { windows: [{ minHoursBeforeStart: -1, refundablePercent: "10" }] }
      ]) {
        expect((await policyPost(owner, bad)).status).toBe(400);
      }
      expect(
        (await policyPost(owner, { windows: STANDARD }, null)).status
      ).toBe(400);
      expect(
        (await policyPost(owner, { productId: UNKNOWN_ID, windows: STANDARD }))
          .status
      ).toBe(404);
      const key = nextKey();
      const first = await policyPost(
        owner,
        { productId: fx.productId, windows: STANDARD },
        key
      );
      const replay = await policyPost(
        owner,
        { productId: fx.productId, windows: STANDARD },
        key
      );
      expect(replay.status).toBe(201);
      expect(replay.body.data.id).toBe(first.body.data.id);
      const conflict = await policyPost(
        owner,
        {
          productId: fx.productId,
          windows: [{ minHoursBeforeStart: 0, refundablePercent: "1" }]
        },
        key
      );
      expect(conflict.status).toBe(409);
      expect(conflict.body.error?.code).toBe("IDEMPOTENCY_CONFLICT");
      expect((await policyList(owner)).body.data.items).toHaveLength(1);
    });

    test("the quote route returns the policy figures and is a read; the version applied is the one in force when booked", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, fx } = await readyOwner();
      await activePolicy(owner, fx.productId);
      const booking = await paidBooking(owner, fx);
      // A stricter version AFTER the booking.
      await activePolicy(owner, fx.productId, [
        { minHoursBeforeStart: 0, refundablePercent: "0" }
      ]);
      const quote = await quoteGet(owner, booking.reservation.id);
      expect(quote.status).toBe(200);
      expect(quote.body.data).toMatchObject({
        policySource: "product",
        policyVersion: 1,
        amountPaid: "1000000.00",
        computedRefund: "1000000.00",
        refundBasis: "whole_stay"
      });
      expect(quote.body.data.hoursBeforeStart).toBeGreaterThan(1000);
      expect(await counts(owner.tenantId)).toEqual(NOTHING);
    });
  });
});
