/**
 * CRM segments through the REAL route handlers (Issue #360, ADR-0042) - the
 * HTTP half `commerce-segments.integration.test.ts` (evaluation, versions, RLS
 * as the runtime role) cannot see: route wiring (`defineTenantRoute`, ABAC
 * default-deny, the `segments` feature toggle, body validation, error ->
 * status mapping) and the permission split of threat-model control C-27.
 *
 * WORLD 2 (see `harness.ts`): handlers use `getDatabaseClient()`, so this file
 * runs against the migrated `DATABASE_URL` and seeds through
 * `getHandlerAdminSql()`. The owner comes from the real setup + login
 * endpoints; every other principal holds EXACTLY the keys under test, so a 403
 * means "that key was missing":
 *
 *   - the feature gate answers 409 FEATURE_DISABLED on every route until the
 *     tenant opts in, and again once it opts back out (toggle-off);
 *   - define / preview / list members / export are four separate powers:
 *     previewing needs no customer permission and shows no sample without it,
 *     listing and exporting additionally need `commerce.customers.read`;
 *   - an unknown field, operator or key, depth over the bound, and a foreign
 *     tenant id in the body are 400s that name the path, and nothing is written;
 *   - another tenant's segment id is the SAME 404 as an unknown id on every
 *     route (no oracle), and its customers are never counted;
 *   - the count under five is withheld, the sample is masked, the CSV is
 *     formula-neutral, and member reads and exports are audited.
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
import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { PATCH as patchModuleSettings } from "../../src/pages/api/v1/tenant/modules/[moduleKey]/settings";
import {
  GET as listSegments,
  POST as createSegment
} from "../../src/pages/api/v1/commerce/segments/index";
import {
  DELETE as retireSegment,
  GET as getSegment,
  PATCH as patchSegment
} from "../../src/pages/api/v1/commerce/segments/[id]/index";
import { POST as previewSegment } from "../../src/pages/api/v1/commerce/segments/preview";
import { GET as listMembers } from "../../src/pages/api/v1/commerce/segments/[id]/members";
import { GET as exportMembers } from "../../src/pages/api/v1/commerce/segments/[id]/export.csv";

const OWNER_PASSWORD = "integration-test-owner-password";
const OTHER_TENANT = "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b9b";
const UNKNOWN_ID = "00000000-0000-4000-8000-0000000000aa";

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

function setSegmentsFeature(who: Principal, segments: boolean) {
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
        segments
      }
    }
  });
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

const list = (who: Principal, query = "") =>
  invoke<Envelope<{ items: SegmentBody[]; nextCursor: string | null }>>(
    listSegments,
    { path: `/api/v1/commerce/segments${query}`, headers: headers(who) }
  );

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

const retire = (who: Principal, id: string) =>
  invoke<Envelope<SegmentBody>>(retireSegment, {
    method: "DELETE",
    path: `/api/v1/commerce/segments/${id}`,
    headers: headers(who),
    params: { id }
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

async function seedCustomers(
  tenantId: string,
  count: number,
  prefix = "C",
  level = 1
): Promise<void> {
  await getHandlerAdminSql()`
    INSERT INTO awcms_commerce_customers (tenant_id, name, phone, email, level)
    SELECT ${tenantId}, ${prefix} || ' ' || g,
      '+62' || ${String(level)} || lpad(g::text, 9, '0') || ${prefix.length > 1 ? "1" : "0"},
      lower(${prefix}) || g || '@example.com', ${level}
    FROM generate_series(1, ${count}) g
  `;
}

async function auditActions(tenantId: string): Promise<string[]> {
  const rows = (await getHandlerAdminSql()`
    SELECT action FROM awcms_audit_events
    WHERE tenant_id = ${tenantId} AND resource_type = 'commerce_segment'
    ORDER BY created_at
  `) as { action: string }[];
  return rows.map((r) => r.action);
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

suite("segment routes (Issue #360)", () => {
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

  test("every segment route is 409 FEATURE_DISABLED until the tenant opts in, and again after it opts out", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();

    const everyRoute = async () => [
      await list(owner),
      await create(owner, { name: "x", rules: leaf("level", "eq", 1) }),
      await get(owner, UNKNOWN_ID),
      await patch(owner, UNKNOWN_ID, { baseVersion: 1, name: "y" }),
      await retire(owner, UNKNOWN_ID),
      await preview(owner, { rules: leaf("level", "eq", 1) }),
      await members(owner, UNKNOWN_ID),
      await exportCsv(owner, UNKNOWN_ID)
    ];

    for (const response of await everyRoute()) {
      expect(response.status).toBe(409);
    }
    const sample = await list(owner);
    expect(sample.body.error?.code).toBe("FEATURE_DISABLED");

    expect((await setSegmentsFeature(owner, true)).status).toBe(200);
    const made = await create(owner, {
      name: "Open",
      rules: leaf("level", "eq", 1)
    });
    expect(made.status).toBe(201);

    // Turning it back off closes every route again; the data is kept, not served.
    expect((await setSegmentsFeature(owner, false)).status).toBe(200);
    for (const response of await everyRoute()) {
      expect(response.status).toBe(409);
    }
    expect((await get(owner, made.body.data.id)).status).toBe(409);
    expect((await setSegmentsFeature(owner, true)).status).toBe(200);
    expect((await get(owner, made.body.data.id)).status).toBe(200);
    expect((await list(owner)).body.data.items).toHaveLength(1);
  });

  test("a tenant that never touched Features has the flag OFF (default), with no write", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    const response = await create(owner, {
      name: "x",
      rules: leaf("level", "eq", 1)
    });
    expect(response.status).toBe(409);
    const rows = (await getHandlerAdminSql()`
      SELECT count(*)::int AS n FROM awcms_commerce_segments
    `) as { n: number }[];
    expect(rows[0]!.n).toBe(0);
  });

  test("validation names the path: unknown field, operator and key, depth over the bound, a money number, and a foreign tenant id are 400 and write nothing", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await setSegmentsFeature(owner, true);

    const cases: {
      rules: unknown;
      extra?: Record<string, unknown>;
      field: string;
    }[] = [
      { rules: leaf("email_domain", "eq", 1), field: "rules.field" },
      { rules: leaf("level", "gte", 2), field: "rules.op" },
      {
        rules: { ...leaf("level", "eq", 1), tenant_id: "x" },
        field: "rules.tenant_id"
      },
      {
        rules: leaf("level", "eq", "1; DROP TABLE awcms_commerce_customers"),
        field: "rules.value"
      },
      { rules: leaf("paid_spend", "gte", 150000), field: "rules.value" },
      {
        rules: {
          not: { not: { not: { not: { not: leaf("level", "eq", 1) } } } }
        },
        field: "rules.not.not.not.not.not"
      },
      {
        rules: leaf("level", "eq", 1),
        extra: { tenantId: OTHER_TENANT },
        field: "tenantId"
      }
    ];
    for (const entry of cases) {
      const response = await create(owner, {
        name: "Bad",
        rules: entry.rules,
        ...entry.extra
      });
      expect(response.status).toBe(400);
      expect(response.body.error?.code).toBe("VALIDATION_ERROR");
      const fields = (response.body.error?.details as { field: string }[]).map(
        (d) => d.field
      );
      expect(fields).toContain(entry.field);
    }
    const rows = (await getHandlerAdminSql()`
      SELECT count(*)::int AS n FROM awcms_commerce_segments
    `) as { n: number }[];
    expect(rows[0]!.n).toBe(0);

    // A foreign tenant id in a PREVIEW body is refused too, never honoured.
    const foreign = await preview(owner, {
      rules: leaf("level", "eq", 1),
      tenantId: OTHER_TENANT
    });
    expect(foreign.status).toBe(400);
    // The as-of is the server's: a client-supplied one is refused by name.
    const asOf = await preview(owner, {
      rules: leaf("level", "eq", 1),
      asOf: "2020-01-01T00:00:00Z"
    });
    expect(asOf.status).toBe(400);
    expect((asOf.body.error?.details as { field: string }[])[0]!.field).toBe(
      "asOf"
    );
  });

  test("define, read, version, conflict, retire: the full lifecycle through the routes, audited", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await setSegmentsFeature(owner, true);

    const made = await create(owner, {
      name: "Big spenders",
      description: "paid at least 1m",
      rules: {
        and: [
          leaf("paid_spend", "gte", "1000000"),
          leaf("level", "in", [3, 1, 3])
        ]
      }
    });
    expect(made.status).toBe(201);
    const id = made.body.data.id;
    expect(made.body.data.latestVersion).toBe(1);
    // The stored form is canonical: money to two places, levels sorted and unique.
    expect(made.body.data.versions[0]!.rules).toEqual({
      and: [
        { field: "paid_spend", op: "gte", value: "1000000.00" },
        { field: "level", op: "in", value: [1, 3] }
      ]
    });

    expect(
      (
        await create(owner, {
          name: "big SPENDERS",
          rules: leaf("level", "eq", 1)
        })
      ).body.error?.code
    ).toBe("SEGMENT_NAME_TAKEN");

    const edited = await patch(owner, id, {
      baseVersion: 1,
      rules: leaf("level", "eq", 4)
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data.latestVersion).toBe(2);
    expect(edited.body.data.versions.map((v) => v.version)).toEqual([2, 1]);

    const stale = await patch(owner, id, {
      baseVersion: 1,
      rules: leaf("level", "eq", 2)
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe("SEGMENT_VERSION_CONFLICT");
    expect(stale.body.error?.details).toEqual({ latestVersion: 2 });

    expect((await patch(owner, id, { name: "no base" })).status).toBe(400);
    expect((await patch(owner, id, { baseVersion: 2 })).status).toBe(400);

    const gone = await retire(owner, id);
    expect(gone.status).toBe(200);
    expect(gone.body.data.status).toBe("retired");
    expect(gone.body.data.versions).toHaveLength(2);
    expect((await retire(owner, id)).body.error?.code).toBe("SEGMENT_RETIRED");
    expect(
      (await patch(owner, id, { baseVersion: 2, name: "again" })).body.error
        ?.code
    ).toBe("SEGMENT_RETIRED");

    expect((await list(owner)).body.data.items).toHaveLength(0);
    expect(
      (await list(owner, "?includeRetired=true")).body.data.items
    ).toHaveLength(1);
    expect((await get(owner, id)).body.data.versions).toHaveLength(2);

    expect(await auditActions(owner.tenantId)).toEqual([
      "commerce.segment.created",
      "commerce.segment.version_created",
      "commerce.segment.deleted"
    ]);

    expect((await get(owner, "not-a-uuid")).status).toBe(404);
    expect((await get(owner, UNKNOWN_ID)).status).toBe(404);
  });

  test("the four powers are separate: define, preview (count only), list members, export", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await setSegmentsFeature(owner, true);
    await seedCustomers(owner.tenantId, 12);
    const made = await create(owner, {
      name: "Level one",
      rules: leaf("level", "eq", 1)
    });
    const id = made.body.data.id;

    const definer = await seedPrincipal(owner.tenantId, "definer", [
      "commerce.segments.read",
      "commerce.segments.create",
      "commerce.segments.update",
      "commerce.segments.delete"
    ]);
    const previewer = await seedPrincipal(owner.tenantId, "previewer", [
      "commerce.segment_previews.read"
    ]);
    const lister = await seedPrincipal(owner.tenantId, "lister", [
      "commerce.segment_members.read"
    ]);
    const listerWithCustomers = await seedPrincipal(owner.tenantId, "lister2", [
      "commerce.segment_members.read",
      "commerce.customers.read"
    ]);
    const exportOnly = await seedPrincipal(owner.tenantId, "exportonly", [
      "commerce.segment_members.export"
    ]);
    const exporter = await seedPrincipal(owner.tenantId, "exporter", [
      "commerce.segment_members.export",
      "commerce.customers.read"
    ]);
    const customersOnly = await seedPrincipal(owner.tenantId, "customersonly", [
      "commerce.customers.read"
    ]);

    // Define: can read and create, cannot preview, list members or export.
    expect((await list(definer)).status).toBe(200);
    expect(
      (await create(definer, { name: "Mine", rules: leaf("level", "eq", 2) }))
        .status
    ).toBe(201);
    expect((await preview(definer, { segmentId: id })).status).toBe(403);
    expect((await members(definer, id)).status).toBe(403);
    expect((await exportCsv(definer, id)).status).toBe(403);

    // Preview: a count needs no customer permission, and shows no sample without one.
    expect((await list(previewer)).status).toBe(403);
    expect(
      (await create(previewer, { name: "No", rules: leaf("level", "eq", 1) }))
        .status
    ).toBe(403);
    const counted = await preview(previewer, { segmentId: id });
    expect(counted.status).toBe(200);
    expect(counted.body.data.count).toEqual({ suppressed: false, count: 12 });
    expect(counted.body.data.sample).toBeNull();
    expect((await members(previewer, id)).status).toBe(403);
    expect((await exportCsv(previewer, id)).status).toBe(403);

    // Listing members needs BOTH the member key and customer-read.
    expect((await members(lister, id)).status).toBe(403);
    expect((await members(customersOnly, id)).status).toBe(403);
    const page = await members(listerWithCustomers, id, "?limit=5");
    expect(page.status).toBe(200);
    expect(page.body.data.items).toHaveLength(5);
    expect(page.body.data.nextCursor).not.toBeNull();
    // ...and reading members does not grant export.
    expect((await exportCsv(listerWithCustomers, id)).status).toBe(403);

    // Export needs the export key AND customer-read; the member key does not stand in.
    expect((await exportCsv(exportOnly, id)).status).toBe(403);
    const csv = await exportCsv(exporter, id);
    expect(csv.status).toBe(200);
    expect(csv.response.headers.get("content-type")).toContain("text/csv");
    expect(csv.response.headers.get("x-export-truncated")).toBe("false");
    expect(csv.response.headers.get("cache-control")).toBe("no-store");
    expect(csv.text.trim().split("\r\n")).toHaveLength(13);

    // A preview by someone who may also see members carries the bounded, masked sample.
    const withSample = await preview(listerWithCustomers, { segmentId: id });
    // (this principal holds no preview key: default deny)
    expect(withSample.status).toBe(403);
    const both = await seedPrincipal(owner.tenantId, "both", [
      "commerce.segment_previews.read",
      "commerce.segment_members.read",
      "commerce.customers.read"
    ]);
    const sampled = await preview(both, { segmentId: id });
    expect(sampled.status).toBe(200);
    expect(sampled.body.data.sample).toHaveLength(10);
    for (const member of sampled.body.data.sample!) {
      expect(member.phoneMasked).toContain("•");
    }
    // Member key without customer-read: the preview degrades to count-only, it does not 403.
    const halfway = await seedPrincipal(owner.tenantId, "halfway", [
      "commerce.segment_previews.read",
      "commerce.segment_members.read"
    ]);
    const countOnly = await preview(halfway, { segmentId: id });
    expect(countOnly.status).toBe(200);
    expect(countOnly.body.data.sample).toBeNull();
  });

  test("small groups are withheld, the as-of is the server's, and the same rule gives the same count", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await setSegmentsFeature(owner, true);
    await seedCustomers(owner.tenantId, 3, "Few", 3);
    await seedCustomers(owner.tenantId, 7, "Many", 2);

    const few = await preview(owner, { rules: leaf("level", "eq", 3) });
    expect(few.status).toBe(200);
    expect(few.body.data.count).toEqual({
      suppressed: true,
      count: null,
      label: "fewer_than_5"
    });
    // The owner may see members, and can; the SAMPLE is the owner's to read.
    expect(few.body.data.sample).toHaveLength(3);

    const many = await preview(owner, { rules: leaf("level", "eq", 2) });
    expect(many.body.data.count).toEqual({ suppressed: false, count: 7 });
    expect(Math.abs(Date.parse(many.body.data.asOf) - Date.now())).toBeLessThan(
      60_000
    );
    const again = await preview(owner, { rules: leaf("level", "eq", 2) });
    expect(again.body.data.count).toEqual(many.body.data.count);
  });

  test("members: masked fields, keyset pages without a gap, audited; the export is formula-neutral, bounded to the version, and audited", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await setSegmentsFeature(owner, true);
    await seedCustomers(owner.tenantId, 7, "Page");
    await getHandlerAdminSql()`
      INSERT INTO awcms_commerce_customers (tenant_id, name, phone, level)
      VALUES (${owner.tenantId}, '=cmd|calc', '+6285500000001', 1)
    `;
    const made = await create(owner, {
      name: "Pages",
      rules: leaf("level", "eq", 1)
    });
    const id = made.body.data.id;

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const response: Awaited<ReturnType<typeof members>> = await members(
        owner,
        id,
        `?limit=3${cursor ? `&cursor=${cursor}` : ""}`
      );
      expect(response.status).toBe(200);
      expect(response.body.data.version).toBe(1);
      for (const item of response.body.data.items) {
        expect(item.phoneMasked).toContain("•");
        expect(item.phoneMasked).not.toBe("+6285500000001");
        seen.push(item.id);
      }
      cursor = response.body.data.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);

    expect((await members(owner, id, "?limit=101")).status).toBe(400);
    expect((await members(owner, id, "?cursor=bogus")).status).toBe(400);
    expect((await members(owner, id, "?version=7")).status).toBe(404);

    const csv = await exportCsv(owner, id);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain("'=cmd|calc");
    expect(csv.text).not.toContain("+6285500000001");
    expect(csv.text.split("\r\n")[0]).toBe(
      "customer_id,name,phone_masked,email_masked,price_level"
    );

    const actions = await auditActions(owner.tenantId);
    expect(
      actions.filter((a) => a === "commerce.segment.members_listed")
    ).toHaveLength(3);
    expect(
      actions.filter((a) => a === "commerce.segment.exported")
    ).toHaveLength(1);
    const exportRow = (await getHandlerAdminSql()`
      SELECT severity, attributes FROM awcms_audit_events
      WHERE action = 'commerce.segment.exported'
    `) as { severity: string; attributes: Record<string, unknown> }[];
    expect(exportRow[0]!.severity).toBe("warning");
    expect(exportRow[0]!.attributes).toMatchObject({
      version: 1,
      returned: 8,
      truncated: false
    });
    // No customer name or contact detail reaches the audit log.
    expect(JSON.stringify(exportRow)).not.toContain("cmd");
  });

  test("another tenant's segment is the same 404 as an unknown id on every route, and its customers are never counted (no oracle)", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await setSegmentsFeature(owner, true);
    await seedCustomers(owner.tenantId, 9, "Acme");
    const mine = await create(owner, {
      name: "Acme only",
      rules: leaf("level", "eq", 1)
    });

    await getHandlerAdminSql()`
      INSERT INTO awcms_tenants (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
      VALUES (${OTHER_TENANT}, 'other', 'Other', 'Other', 'active', 'en', 'light')
    `;
    const intruder = await seedPrincipal(OTHER_TENANT, "intruder", [
      "module_management.settings.update",
      "commerce.segments.read",
      "commerce.segments.create",
      "commerce.segments.update",
      "commerce.segments.delete",
      "commerce.segment_previews.read",
      "commerce.segment_members.read",
      "commerce.segment_members.export",
      "commerce.customers.read"
    ]);
    expect((await setSegmentsFeature(intruder, true)).status).toBe(200);
    await seedCustomers(OTHER_TENANT, 2, "Out");

    const unknown = await get(intruder, UNKNOWN_ID);
    const foreign = await get(intruder, mine.body.data.id);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(unknown.body);

    const responses = [
      [
        await patch(intruder, mine.body.data.id, { baseVersion: 1, name: "x" }),
        await patch(intruder, UNKNOWN_ID, { baseVersion: 1, name: "x" })
      ],
      [
        await retire(intruder, mine.body.data.id),
        await retire(intruder, UNKNOWN_ID)
      ],
      [
        await members(intruder, mine.body.data.id),
        await members(intruder, UNKNOWN_ID)
      ],
      [
        await preview(intruder, { segmentId: mine.body.data.id }),
        await preview(intruder, { segmentId: UNKNOWN_ID })
      ]
    ];
    for (const [foreignResponse, unknownResponse] of responses) {
      expect(foreignResponse!.status).toBe(404);
      expect(foreignResponse!.body).toEqual(unknownResponse!.body);
    }
    const foreignExport = await exportCsv(intruder, mine.body.data.id);
    const unknownExport = await exportCsv(intruder, UNKNOWN_ID);
    expect(foreignExport.status).toBe(404);
    expect(foreignExport.text).toEqual(unknownExport.text);

    expect((await list(intruder)).body.data.items).toHaveLength(0);
    // The intruder's own rule counts only the intruder's customers (2, withheld as "fewer than 5").
    const own = await preview(intruder, { rules: leaf("level", "eq", 1) });
    expect(own.body.data.count).toEqual({
      suppressed: true,
      count: null,
      label: "fewer_than_5"
    });
    // ...and the owner's segment is intact.
    expect((await get(owner, mine.body.data.id)).body.data.status).toBe(
      "active"
    );
  });

  test("an actor without a session or with no permission at all is refused before the feature gate answers anything about segments", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await setSegmentsFeature(owner, true);
    const nobody = await seedPrincipal(owner.tenantId, "nobody", []);
    expect((await list(nobody)).status).toBe(403);
    expect(
      (await create(nobody, { name: "x", rules: leaf("level", "eq", 1) }))
        .status
    ).toBe(403);
    expect(
      (await preview(nobody, { rules: leaf("level", "eq", 1) })).status
    ).toBe(403);
    const anonymous = await invoke<Envelope>(listSegments, {
      path: "/api/v1/commerce/segments",
      headers: { "x-awcms-tenant-id": owner.tenantId }
    });
    expect(anonymous.status).toBe(401);
  });

  test("previews are throttled per actor: past the per-minute cap the answer is 429 RATE_LIMITED with Retry-After", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await setSegmentsFeature(owner, true);
    let last: Awaited<ReturnType<typeof preview>> | null = null;
    for (let i = 0; i < 31; i += 1) {
      last = await preview(owner, { rules: leaf("level", "eq", 1) });
      if (i < 30) expect(last.status).toBe(200);
    }
    expect(last!.status).toBe(429);
    expect(last!.body.error?.code).toBe("RATE_LIMITED");
    expect(last!.response.headers.get("retry-after")).not.toBeNull();
  });
});
