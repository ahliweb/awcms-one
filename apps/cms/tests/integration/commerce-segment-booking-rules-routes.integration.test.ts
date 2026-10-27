/**
 * Booking-derived segment rules through the REAL route handlers (Issue #390,
 * ADR-0052) - the HTTP half of `commerce-segment-booking-rules.integration.test.ts`:
 * the extra feature and permission a rule that reads a booking fact needs, on
 * every route that defines, counts, lists or exports it (ADR-0052 D5).
 *
 * WORLD 2 (see `harness.ts`). Every principal other than the owner holds
 * EXACTLY the keys under test, so a 403 means "that key was missing":
 *
 *   - DEFINING a booking rule (create, a new version, an unsaved preview) needs
 *     the tenant's `booking` feature (409 FEATURE_DISABLED) AND
 *     `commerce.booking_reservation_links.read` (403);
 *   - READING a saved booking rule's count / members / export needs the
 *     permission, not the feature (the facts are history that outlives it);
 *   - a rule with no booking field, a rename, and the definition itself (GET)
 *     need neither: nothing about segments without booking facts changed;
 *   - a new version is stored under rule schema 2, and the audit row says so.
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
import { getDatabaseClient } from "../../src/lib/database/client";
import { withTenantOrThrow } from "../../src/lib/database/tenant-context";
import { attachSegmentToDraft } from "../../src/modules/commerce/application/campaign-segment-http";
import { resolveEligibilityRequest } from "../../src/modules/commerce/application/loyalty-eligibility-http";
import { resetRateLimitForTests } from "../../src/lib/security/rate-limit";
import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { PATCH as patchModuleSettings } from "../../src/pages/api/v1/tenant/modules/[moduleKey]/settings";
import { POST as createSegment } from "../../src/pages/api/v1/commerce/segments/index";
import {
  GET as getSegment,
  PATCH as patchSegment
} from "../../src/pages/api/v1/commerce/segments/[id]/index";
import { POST as previewSegment } from "../../src/pages/api/v1/commerce/segments/preview";
import { GET as listMembers } from "../../src/pages/api/v1/commerce/segments/[id]/members";
import { GET as exportMembers } from "../../src/pages/api/v1/commerce/segments/[id]/export.csv";

const OWNER_PASSWORD = "integration-test-owner-password";

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

function headers(who: Principal): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-tenant-id": who.tenantId,
    authorization: `Bearer ${who.token}`
  };
}

const leaf = (field: string, op: string, value?: unknown, extra = {}) => ({
  field,
  op,
  ...(value === undefined ? {} : { value }),
  ...extra
});

type SegmentBody = {
  id: string;
  name: string;
  status: string;
  latestVersion: number;
  versions: { version: number; rules: Record<string, unknown> }[];
};

const create = (who: Principal, body: unknown) =>
  invoke<Envelope<SegmentBody>>(createSegment, {
    method: "POST",
    path: "/api/v1/commerce/segments",
    headers: headers(who),
    body
  });

const get = (who: Principal, id: string) =>
  invoke<Envelope<SegmentBody>>(getSegment, {
    path: `/api/v1/commerce/segments/${id}`,
    headers: headers(who),
    params: { id }
  });

const patch = (who: Principal, id: string, body: unknown) =>
  invoke<Envelope<SegmentBody>>(patchSegment, {
    method: "PATCH",
    path: `/api/v1/commerce/segments/${id}`,
    headers: headers(who),
    params: { id },
    body
  });

type PreviewBody = {
  segment: { id: string; version: number } | null;
  asOf: string;
  count: { suppressed: boolean; count: number | null; label?: string };
  sample: { id: string; name: string; phoneMasked: string }[] | null;
};

const preview = (who: Principal, body: unknown) =>
  invoke<Envelope<PreviewBody>>(previewSegment, {
    method: "POST",
    path: "/api/v1/commerce/segments/preview",
    headers: headers(who),
    body
  });

type MembersBody = {
  segmentId: string;
  version: number;
  asOf: string;
  items: {
    id: string;
    name: string;
    phoneMasked: string;
    emailMasked: string | null;
    level: number;
  }[];
  nextCursor: string | null;
};

const members = (who: Principal, id: string, query = "") =>
  invoke<Envelope<MembersBody>>(listMembers, {
    path: `/api/v1/commerce/segments/${id}/members${query}`,
    headers: headers(who),
    params: { id }
  });

/** The CSV export is not JSON, so `invoke` (which parses every body) cannot carry it. */
async function exportCsv(
  who: Principal,
  id: string,
  query = ""
): Promise<{ status: number; text: string; response: Response }> {
  const url = new URL(
    `http://integration.test/api/v1/commerce/segments/${id}/export.csv${query}`
  );
  const context = {
    request: new Request(url.toString(), { headers: headers(who) }),
    url,
    params: { id },
    locals: {},
    cookies: createCookieJar(),
    clientAddress: "127.0.0.1"
  } as unknown as Parameters<typeof exportMembers>[0];
  const response = await exportMembers(context);
  return { status: response.status, text: await response.text(), response };
}

const BASE = [
  "commerce.segments.read",
  "commerce.segments.create",
  "commerce.segments.update",
  "commerce.segment_previews.read",
  "commerce.segment_members.read",
  "commerce.segment_members.export",
  "commerce.customers.read"
];
const BOOKING_READ = "commerce.booking_reservation_links.read";

function setFeatures(who: Principal, features: Record<string, boolean>) {
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
        segments: true,
        booking: false,
        ...features
      }
    }
  });
}

const suite = integrationEnabled ? describe : describe.skip;
let handlerReady = false;

const stayRule = leaf("stay_count", "gte", 1);
const noShowRule = {
  and: [leaf("level", "eq", 1), leaf("no_show_count", "gte", 1)]
};

suite("booking-derived segment routes (Issue #390)", () => {
  beforeAll(async () => {
    handlerReady = await ensureHandlerDatabaseReady();
  });
  afterAll(async () => {
    await teardownHandlerDatabase();
  });
  beforeEach(async () => {
    resetRateLimitForTests();
    if (!handlerReady) return;
    await resetHandlerDatabase();
  });

  test("defining a booking rule needs the booking feature and the booking-read permission; a rule without one needs neither", async () => {
    if (!handlerReady) return;
    const owner = await bootstrapOwner();
    const withoutBooking = await seedPrincipal(owner.tenantId, "editor", BASE);
    const withBooking = await seedPrincipal(owner.tenantId, "booker", [
      ...BASE,
      BOOKING_READ
    ]);

    // Feature OFF: even a holder of the permission is refused (409), before anything is written.
    expect((await setFeatures(owner, { booking: false })).status).toBe(200);
    const off = await create(withBooking, { name: "Stayed", rules: stayRule });
    expect(off.status).toBe(409);
    expect(off.body.error?.code).toBe("FEATURE_DISABLED");
    // A rule with no booking fact is untouched by either gate.
    const plain = await create(withoutBooking, {
      name: "Plain",
      rules: leaf("level", "eq", 1)
    });
    expect(plain.status).toBe(201);

    // Feature ON, permission missing: 403, nothing written.
    expect((await setFeatures(owner, { booking: true })).status).toBe(200);
    const denied = await create(withoutBooking, {
      name: "Stayed",
      rules: stayRule
    });
    expect(denied.status).toBe(403);
    const written = (await getHandlerAdminSql()`
      SELECT count(*)::int AS n FROM awcms_commerce_segments WHERE name = 'Stayed'
    `) as { n: number }[];
    expect(written[0]!.n).toBe(0);

    // Both: created, under rule schema 2, and the audit row says which schema.
    const made = await create(withBooking, { name: "Stayed", rules: stayRule });
    expect(made.status).toBe(201);
    const stored = (await getHandlerAdminSql()`
      SELECT version, rule_schema_version FROM awcms_commerce_segment_versions
      WHERE segment_id = ${made.body.data.id}
    `) as { version: number; rule_schema_version: number }[];
    expect(stored).toEqual([{ version: 1, rule_schema_version: 2 }]);
    const audit = (await getHandlerAdminSql()`
      SELECT attributes FROM awcms_audit_events
      WHERE resource_id = ${made.body.data.id} AND action = 'commerce.segment.created'
    `) as { attributes: Record<string, unknown> }[];
    expect(audit[0]!.attributes.ruleSchemaVersion).toBe(2);
    // A pre-existing plain segment is stored under the same current schema.
    const plainStored = (await getHandlerAdminSql()`
      SELECT rule_schema_version FROM awcms_commerce_segment_versions
      WHERE segment_id = ${plain.body.data.id}
    `) as { rule_schema_version: number }[];
    expect(plainStored[0]!.rule_schema_version).toBe(2);
  });

  test("a new version that adds a booking field is gated the same way; a rename of a booking segment is not", async () => {
    if (!handlerReady) return;
    const owner = await bootstrapOwner();
    await setFeatures(owner, { booking: true });
    const withoutBooking = await seedPrincipal(owner.tenantId, "editor", BASE);
    const withBooking = await seedPrincipal(owner.tenantId, "booker", [
      ...BASE,
      BOOKING_READ
    ]);
    const plain = await create(withoutBooking, {
      name: "Plain",
      rules: leaf("level", "eq", 1)
    });
    const id = plain.body.data.id;

    const refused = await patch(withoutBooking, id, {
      baseVersion: 1,
      rules: noShowRule
    });
    expect(refused.status).toBe(403);
    const accepted = await patch(withBooking, id, {
      baseVersion: 1,
      rules: noShowRule
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.latestVersion).toBe(2);

    // Renaming it needs only the ordinary update permission.
    const renamed = await patch(withoutBooking, id, {
      baseVersion: 2,
      name: "Renamed"
    });
    expect(renamed.status).toBe(200);
    // Reading the definition (rules only, no customer) needs neither.
    const definition = await get(withoutBooking, id);
    expect(definition.status).toBe(200);
    expect(definition.body.data.versions.map((v) => v.version)).toEqual([2, 1]);
    // Feature OFF blocks a new booking version but not a rename.
    await setFeatures(owner, { booking: false });
    expect(
      (await patch(withBooking, id, { baseVersion: 2, rules: stayRule })).status
    ).toBe(409);
    expect(
      (await patch(withBooking, id, { baseVersion: 2, name: "Again" })).status
    ).toBe(200);
  });

  test("count, members and export of a saved booking segment need the permission - and keep working when the feature is switched off", async () => {
    if (!handlerReady) return;
    const owner = await bootstrapOwner();
    await setFeatures(owner, { booking: true });
    // Customers + a stay so there is a real answer (>= 5 so the count shows).
    const admin = getHandlerAdminSql();
    await admin`
      INSERT INTO awcms_commerce_customers (tenant_id, name, phone, level)
      SELECT ${owner.tenantId}, 'Guest ' || g, '+62899' || lpad(g::text, 8, '0'), 1
      FROM generate_series(1, 6) g
    `;
    const withoutBooking = await seedPrincipal(owner.tenantId, "editor", BASE);
    const withBooking = await seedPrincipal(owner.tenantId, "booker", [
      ...BASE,
      BOOKING_READ
    ]);
    const made = await create(withBooking, {
      name: "Never stayed",
      rules: leaf("last_stay_date", "never")
    });
    expect(made.status).toBe(201);
    const id = made.body.data.id;

    // Without the permission: 403 on all four reads.
    expect((await preview(withoutBooking, { segmentId: id })).status).toBe(403);
    expect((await members(withoutBooking, id)).status).toBe(403);
    expect((await exportCsv(withoutBooking, id)).status).toBe(403);
    expect(
      (
        await preview(withoutBooking, {
          rules: leaf("last_stay_date", "never")
        })
      ).status
    ).toBe(403);

    // With it: answers, and a plain segment's preview is unaffected for the editor.
    const counted = await preview(withBooking, { segmentId: id });
    expect(counted.status).toBe(200);
    expect(counted.body.data.count).toEqual({ suppressed: false, count: 6 });
    expect((await members(withBooking, id)).body.data.items).toHaveLength(6);
    expect((await exportCsv(withBooking, id)).status).toBe(200);
    const plain = await create(withoutBooking, {
      name: "Plain",
      rules: leaf("level", "eq", 1)
    });
    expect(
      (await preview(withoutBooking, { segmentId: plain.body.data.id })).status
    ).toBe(200);

    // The feature is switched off: the saved segment is still readable by a
    // holder of the permission; an UNSAVED booking rule is a definition and is
    // refused (409).
    await setFeatures(owner, { booking: false });
    expect((await preview(withBooking, { segmentId: id })).status).toBe(200);
    expect((await members(withBooking, id)).status).toBe(200);
    const unsaved = await preview(withBooking, {
      rules: leaf("last_stay_date", "never")
    });
    expect(unsaved.status).toBe(409);
    expect(unsaved.body.error?.code).toBe("FEATURE_DISABLED");
  });

  test("a schema-2 rule is refused as old input: the same body without the booking field is untouched", async () => {
    if (!handlerReady) return;
    const owner = await bootstrapOwner();
    const rejected = await create(owner, {
      name: "Bad",
      rules: leaf("stay_count", "gte", "1")
    });
    expect(rejected.status).toBe(400);
    expect(
      (rejected.body.error?.details as { field: string }[]).map((d) => d.field)
    ).toContain("rules.value");
  });

  test("the consumers - a campaign audience and a loyalty restriction - may aim at a booking segment only for someone who can read bookings", async () => {
    if (!handlerReady) return;
    const owner = await bootstrapOwner();
    await setFeatures(owner, {
      booking: true,
      campaigns: true,
      loyalty: true,
      loyaltySegments: true,
      campaignSegmentAudience: true
    });
    const withoutBooking = await seedPrincipal(owner.tenantId, "editor", BASE);
    const withBooking = await seedPrincipal(owner.tenantId, "booker", [
      ...BASE,
      BOOKING_READ
    ]);
    const booking = await create(withBooking, {
      name: "Stayed",
      rules: stayRule
    });
    const plain = await create(withBooking, {
      name: "Plain",
      rules: leaf("level", "eq", 1)
    });
    const now = new Date();
    const attach = (who: Principal, segmentId: string) =>
      withTenantOrThrow(getDatabaseClient(), who.tenantId, (tx) =>
        attachSegmentToDraft(
          tx,
          who.tenantId,
          hashSessionToken(who.token),
          now,
          { segmentId, segmentVersion: null }
        )
      );
    const restrict = (who: Principal, segmentId: string) =>
      withTenantOrThrow(getDatabaseClient(), who.tenantId, (tx) =>
        resolveEligibilityRequest(
          tx,
          who.tenantId,
          hashSessionToken(who.token),
          now,
          {
            eligibilitySegmentId: segmentId,
            eligibilitySegmentVersion: null
          }
        )
      );

    // A campaign editor without booking-read: a plain segment is fine, the booking one is a 403.
    expect((await attach(withoutBooking, plain.body.data.id)).kind).toBe("ok");
    const refusedAttach = await attach(withoutBooking, booking.body.data.id);
    expect(refusedAttach.kind).toBe("refused");
    if (refusedAttach.kind === "refused") {
      expect(refusedAttach.response.status).toBe(403);
    }
    expect((await attach(withBooking, booking.body.data.id)).kind).toBe("ok");

    // The same for a loyalty program version.
    expect((await restrict(withoutBooking, plain.body.data.id)).kind).toBe(
      "ok"
    );
    const refusedRestrict = await restrict(
      withoutBooking,
      booking.body.data.id
    );
    expect(refusedRestrict.kind).toBe("refused");
    if (refusedRestrict.kind === "refused") {
      expect(refusedRestrict.response.status).toBe(403);
    }
    expect((await restrict(withBooking, booking.body.data.id)).kind).toBe("ok");
  });
});
