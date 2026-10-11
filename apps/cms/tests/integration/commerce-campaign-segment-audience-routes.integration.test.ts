/**
 * Campaigns with a segment audience through the REAL route handlers (Issue
 * #362, ADR-0042 Amendment) - the HTTP half
 * `commerce-campaign-segment-audience.integration.test.ts` (resolution,
 * consent, versions, dispatch as the runtime role) cannot see: route wiring,
 * the three-flag gate, the permission to aim a campaign at a segment, the
 * segment-preview permission on a segment campaign's count, the small-group
 * suppression, validation, audit rows and the unchanged legacy routes.
 *
 * WORLD 2 (see `harness.ts`): handlers use `getDatabaseClient()`, so this file
 * runs against the migrated `DATABASE_URL`. Every non-owner principal holds
 * EXACTLY the keys under test, so a 403 means "that key was missing".
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
import { POST as createSegment } from "../../src/pages/api/v1/commerce/segments/index";
import { DELETE as retireSegment } from "../../src/pages/api/v1/commerce/segments/[id]/index";
import {
  GET as listCampaigns,
  POST as createCampaign
} from "../../src/pages/api/v1/commerce/campaigns/index";
import {
  GET as getCampaign,
  PATCH as patchCampaign
} from "../../src/pages/api/v1/commerce/campaigns/[id]/index";
import { POST as previewCampaign } from "../../src/pages/api/v1/commerce/campaigns/[id]/preview";
import { POST as sendCampaign } from "../../src/pages/api/v1/commerce/campaigns/[id]/send";

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
        ...features
      }
    }
  });
}

const FLAGS_ON = { segments: true, campaignSegmentAudience: true };

const leaf = (field: string, op: string, value?: unknown) => ({
  field,
  op,
  ...(value === undefined ? {} : { value })
});

type SegmentBody = { id: string; latestVersion: number };
type CampaignBody = {
  id: string;
  status: string;
  audience: { levels: number[]; lastOrderSince: string | null };
  recipientCount: number | null;
  countsSuppressed: boolean;
  segment: { id: string; version: number; asOf: string | null } | null;
};

const makeSegment = (who: Principal, rules: unknown, name = "Audience") =>
  invoke<Envelope<SegmentBody>>(createSegment, {
    method: "POST",
    path: "/api/v1/commerce/segments",
    headers: headers(who),
    body: { name, rules }
  });

const retire = (who: Principal, id: string) =>
  invoke<Envelope>(retireSegment, {
    method: "DELETE",
    path: `/api/v1/commerce/segments/${id}`,
    headers: headers(who),
    params: { id }
  });

const create = (who: Principal, body: Record<string, unknown>) =>
  invoke<Envelope<CampaignBody>>(createCampaign, {
    method: "POST",
    path: "/api/v1/commerce/campaigns",
    headers: headers(who),
    body: { channel: "email", subject: "Hi", body: "Hello {{name}}", ...body }
  });

const getOne = (who: Principal, id: string) =>
  invoke<Envelope<CampaignBody>>(getCampaign, {
    path: `/api/v1/commerce/campaigns/${id}`,
    headers: headers(who),
    params: { id }
  });

const patch = (who: Principal, id: string, body: unknown) =>
  invoke<Envelope<CampaignBody>>(patchCampaign, {
    method: "PATCH",
    path: `/api/v1/commerce/campaigns/${id}`,
    headers: headers(who),
    params: { id },
    body
  });

type PreviewBody = {
  recipientCount: number | null;
  suppressed?: boolean;
  label?: string;
  segment?: { id: string; version: number };
  asOf?: string;
};

const preview = (who: Principal, id: string) =>
  invoke<Envelope<PreviewBody>>(previewCampaign, {
    method: "POST",
    path: `/api/v1/commerce/campaigns/${id}/preview`,
    headers: headers(who),
    params: { id }
  });

let sendSeq = 0;
const send = (who: Principal, id: string) => {
  sendSeq += 1;
  return invoke<Envelope<CampaignBody>>(sendCampaign, {
    method: "POST",
    path: `/api/v1/commerce/campaigns/${id}/send`,
    headers: headers(who, { "idempotency-key": `camp-seg-send-${sendSeq}` }),
    params: { id }
  });
};

let memberSeq = 0;

/** `count` level-`level` shoppers with accounts, consented unless `consent` is false. */
async function seedMembers(
  tenantId: string,
  count: number,
  level = 3,
  consent = true
): Promise<void> {
  const offset = memberSeq;
  memberSeq += count;
  await getHandlerAdminSql()`
    WITH c AS (
      INSERT INTO awcms_commerce_customers (tenant_id, name, phone, level)
      SELECT ${tenantId}, 'Member ' || (${offset} + g),
        '+62850' || lpad((${offset} + g)::text, 9, '0'), ${level}
      FROM generate_series(1, ${count}) g
      RETURNING id, phone
    )
    INSERT INTO awcms_commerce_customer_accounts
      (tenant_id, customer_id, email_normalized, history_from, marketing_consent_at)
    SELECT ${tenantId}, id, 'member' || substr(phone, 6) || '@routes.test',
      now() - interval '300 days',
      CASE WHEN ${consent} THEN now() - interval '5 days' ELSE NULL END
    FROM c
  `;
}

async function campaignAudit(
  tenantId: string,
  campaignId: string
): Promise<{ action: string; attributes: Record<string, unknown> }[]> {
  return (await getHandlerAdminSql()`
    SELECT action, attributes FROM awcms_audit_events
    WHERE tenant_id = ${tenantId} AND resource_type = 'campaign'
      AND resource_id = ${campaignId}
    ORDER BY created_at
  `) as { action: string; attributes: Record<string, unknown> }[];
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

suite("campaign segment audience routes (Issue #362)", () => {
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

  test("a legacy campaign is created, edited, previewed and listed exactly as before - with every new flag off, and with the segment audience keys absent", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await setFeatures(owner, {});

    const made = await create(owner, {
      audience: { levels: [], hasAccount: null, lastOrderSince: null }
    });
    expect(made.status).toBe(201);
    expect(made.body.data.segment).toBeNull();
    expect(made.body.data.countsSuppressed).toBe(false);

    const edited = await patch(owner, made.body.data.id, {
      audience: {
        levels: [],
        hasAccount: null,
        lastOrderSince: "2026-01-01T00:00:00.000Z"
      },
      subject: "New subject"
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data.audience.lastOrderSince).toBe(
      "2026-01-01T00:00:00.000Z"
    );
    expect(edited.body.data.segment).toBeNull();

    // The legacy preview answers `{ recipientCount }` as a plain number, even for a tiny audience.
    await seedMembers(owner.tenantId, 2, 1);
    const counted = await preview(owner, made.body.data.id);
    expect(counted.status).toBe(200);
    expect(counted.body.data).toEqual({ recipientCount: 0 });

    const listed = await invoke<Envelope<{ items: CampaignBody[] }>>(
      listCampaigns,
      { path: "/api/v1/commerce/campaigns", headers: headers(owner) }
    );
    expect(listed.body.data.items).toHaveLength(1);
  });

  test("a segment audience is 409 FEATURE_DISABLED until the tenant opts in to BOTH segments and campaignSegmentAudience, and nothing is written", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await setFeatures(owner, { segments: true });
    // Create the segment while segments is on, then take the new flag away.
    const segment = await makeSegment(owner, leaf("level", "eq", 3));
    expect(segment.status).toBe(201);

    const withheld: Record<string, boolean>[] = [
      {},
      { segments: true },
      { campaignSegmentAudience: true },
      { segments: true, campaignSegmentAudience: false }
    ];
    for (const features of withheld) {
      await setFeatures(owner, features);
      const refused = await create(owner, { segmentId: segment.body.data.id });
      expect(refused.status).toBe(409);
      expect(refused.body.error?.code).toBe("FEATURE_DISABLED");
    }
    const rows = (await getHandlerAdminSql()`
      SELECT count(*)::int AS n FROM awcms_commerce_campaigns
    `) as { n: number }[];
    expect(rows[0]!.n).toBe(0);

    await setFeatures(owner, FLAGS_ON);
    const made = await create(owner, { segmentId: segment.body.data.id });
    expect(made.status).toBe(201);
    expect(made.body.data.segment).toEqual({
      id: segment.body.data.id,
      version: 1,
      asOf: null
    });
  });

  test("choosing a segment needs commerce.segments.read in addition to editing campaigns; the audit row records the segment and version", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await setFeatures(owner, FLAGS_ON);
    const segment = await makeSegment(owner, leaf("level", "eq", 3));

    const editor = await seedPrincipal(owner.tenantId, "editor", [
      "commerce.campaigns.read",
      "commerce.campaigns.update"
    ]);
    const denied = await create(editor, { segmentId: segment.body.data.id });
    expect(denied.status).toBe(403);

    // The same editor still creates a legacy campaign.
    expect((await create(editor, {})).status).toBe(201);

    const aimer = await seedPrincipal(owner.tenantId, "aimer", [
      "commerce.campaigns.read",
      "commerce.campaigns.update",
      "commerce.segments.read"
    ]);
    const made = await create(aimer, { segmentId: segment.body.data.id });
    expect(made.status).toBe(201);
    const audit = await campaignAudit(owner.tenantId, made.body.data.id);
    expect(audit.map((a) => a.action)).toEqual(["create"]);
    expect(audit[0]!.attributes.segmentId).toBe(segment.body.data.id);
    expect(audit[0]!.attributes.segmentVersion).toBe(1);
  });

  test("validation: a segment AND legacy filters, a version without an id, a bad id, a foreign or unknown segment, and a retired one are refused", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await setFeatures(owner, FLAGS_ON);
    const segment = await makeSegment(owner, leaf("level", "eq", 3));
    const id = segment.body.data.id;

    const both = await create(owner, {
      segmentId: id,
      audience: { levels: [1], hasAccount: null, lastOrderSince: null }
    });
    expect(both.status).toBe(400);
    expect(
      (both.body.error?.details as { field: string }[]).map((d) => d.field)
    ).toContain("audience");

    expect((await create(owner, { segmentVersion: 1 })).status).toBe(400);
    expect((await create(owner, { segmentId: "not-a-uuid" })).status).toBe(400);
    expect(
      (await create(owner, { segmentId: id, segmentVersion: 0 })).status
    ).toBe(400);

    // Unknown id, unknown version and another tenant's segment are the SAME 404.
    const unknown = await create(owner, { segmentId: UNKNOWN_ID });
    expect(unknown.status).toBe(404);
    expect(
      (await create(owner, { segmentId: id, segmentVersion: 9 })).status
    ).toBe(404);
    await getHandlerAdminSql()`
      INSERT INTO awcms_tenants (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
      VALUES (${OTHER_TENANT}, 'other', 'Other', 'Other', 'active', 'en', 'light')
    `;
    const foreignUser = await seedPrincipal(OTHER_TENANT, "foreigner", [
      "commerce.segments.create"
    ]);
    const foreignRow = (await getHandlerAdminSql()`
      INSERT INTO awcms_commerce_segments (tenant_id, name, latest_version, created_by_tenant_user_id)
      VALUES (${OTHER_TENANT}, 'Theirs', 1, ${foreignUser.tenantUserId})
      RETURNING id
    `) as { id: string }[];
    await getHandlerAdminSql()`
      INSERT INTO awcms_commerce_segment_versions
        (tenant_id, segment_id, version, rules, node_count, depth, created_by_tenant_user_id)
      VALUES (${OTHER_TENANT}, ${foreignRow[0]!.id}, 1,
        ${leaf("level", "eq", 3)}::jsonb, 1, 0, ${foreignUser.tenantUserId})
    `;
    const foreign = await create(owner, { segmentId: foreignRow[0]!.id });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error?.message).toBe(unknown.body.error?.message);

    expect((await retire(owner, id)).status).toBe(200);
    const retired = await create(owner, { segmentId: id });
    expect(retired.status).toBe(409);
    expect(retired.body.error?.code).toBe("SEGMENT_RETIRED");
  });

  test("editing a draft: attach clears the legacy filters, filters on a segment campaign and a bare detach are refused, a detach with filters works", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await setFeatures(owner, FLAGS_ON);
    const segment = await makeSegment(owner, leaf("level", "eq", 3));
    const id = segment.body.data.id;

    const legacy = await create(owner, {
      audience: { levels: [2], hasAccount: null, lastOrderSince: null }
    });
    const attached = await patch(owner, legacy.body.data.id, { segmentId: id });
    expect(attached.status).toBe(200);
    expect(attached.body.data.segment?.id).toBe(id);
    expect(attached.body.data.audience.levels).toEqual([]);

    // Filters on a campaign that keeps its segment would silently be ignored.
    const filtered = await patch(owner, legacy.body.data.id, {
      audience: { levels: [1], hasAccount: null, lastOrderSince: null }
    });
    expect(filtered.status).toBe(400);
    // Dropping the segment without saying who it is for would widen the audience.
    const bare = await patch(owner, legacy.body.data.id, { segmentId: null });
    expect(bare.status).toBe(400);

    const detached = await patch(owner, legacy.body.data.id, {
      segmentId: null,
      audience: { levels: [1], hasAccount: null, lastOrderSince: null }
    });
    expect(detached.status).toBe(200);
    expect(detached.body.data.segment).toBeNull();
    expect(detached.body.data.audience.levels).toEqual([1]);

    // Once sent, it is no longer editable (unchanged legacy rule).
    const second = await create(owner, { segmentId: id });
    await seedMembers(owner.tenantId, 5);
    expect((await send(owner, second.body.data.id)).status).toBe(200);
    expect(
      (await patch(owner, second.body.data.id, { subject: "late" })).status
    ).toBe(409);
  });

  test("the audience count of a segment campaign needs commerce.segment_previews.read, withholds a count under five, and excludes the opted-out", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await setFeatures(owner, FLAGS_ON);
    const segment = await makeSegment(owner, leaf("level", "eq", 3));
    const made = await create(owner, { segmentId: segment.body.data.id });
    const campaignId = made.body.data.id;

    // A campaign reader without the segment-preview permission is refused.
    const reader = await seedPrincipal(owner.tenantId, "reader", [
      "commerce.campaigns.read"
    ]);
    expect((await preview(reader, campaignId)).status).toBe(403);
    // ...yet the same reader previews a legacy campaign as before.
    const legacy = await create(owner, {});
    expect((await preview(reader, legacy.body.data.id)).status).toBe(200);

    // Two members and an opted-out one: "fewer than 5", never a number.
    await seedMembers(owner.tenantId, 2);
    await seedMembers(owner.tenantId, 1, 3, false);
    const small = await preview(owner, campaignId);
    expect(small.status).toBe(200);
    expect(small.body.data.recipientCount).toBeNull();
    expect(small.body.data.suppressed).toBe(true);
    expect(small.body.data.label).toBe("fewer_than_5");
    expect(small.body.data.segment).toEqual({
      id: segment.body.data.id,
      version: 1
    });

    // Seven consented members, the opted-out one still excluded.
    await seedMembers(owner.tenantId, 5, 3);
    const big = await preview(owner, campaignId);
    expect(big.body.data.suppressed).toBe(false);
    expect(big.body.data.recipientCount).toBe(7);
    expect(Date.parse(big.body.data.asOf!)).not.toBeNaN();

    const flagsOff = await setFeatures(owner, { segments: true });
    expect(flagsOff.status).toBe(200);
    const off = await preview(owner, campaignId);
    expect(off.status).toBe(409);
    expect(off.body.error?.code).toBe("FEATURE_DISABLED");
  });

  test("send re-checks the flags and the audience at enqueue: 409 when the flag was switched off after the draft, 200 when on, and a legacy send is untouched", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await setFeatures(owner, FLAGS_ON);
    await seedMembers(owner.tenantId, 6);
    const segment = await makeSegment(owner, leaf("level", "eq", 3));
    const made = await create(owner, { segmentId: segment.body.data.id });
    const campaignId = made.body.data.id;

    await setFeatures(owner, { segments: true });
    const refused = await send(owner, campaignId);
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code).toBe("FEATURE_DISABLED");
    expect((await getOne(owner, campaignId)).body.data.status).toBe("draft");

    await setFeatures(owner, FLAGS_ON);
    const sent = await send(owner, campaignId);
    expect(sent.status).toBe(200);
    expect(sent.body.data.status).toBe("scheduled");
    // The as-of is set by the dispatcher, not by the send call.
    expect(sent.body.data.segment?.asOf).toBeNull();

    // A legacy campaign sends with every new flag off.
    await setFeatures(owner, {});
    const legacy = await create(owner, {});
    expect((await send(owner, legacy.body.data.id)).status).toBe(200);
  });

  test("another tenant's campaign is a 404 on every segment-aware route", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await setFeatures(owner, FLAGS_ON);
    const segment = await makeSegment(owner, leaf("level", "eq", 3));
    const made = await create(owner, { segmentId: segment.body.data.id });

    await getHandlerAdminSql()`
      INSERT INTO awcms_tenants (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
      VALUES (${OTHER_TENANT}, 'other', 'Other', 'Other', 'active', 'en', 'light')
    `;
    const intruder = await seedPrincipal(OTHER_TENANT, "intruder", [
      "commerce.campaigns.read",
      "commerce.campaigns.update",
      "commerce.campaigns.send",
      "commerce.segments.read",
      "commerce.segment_previews.read"
    ]);
    await getHandlerAdminSql()`
      INSERT INTO awcms_module_settings (tenant_id, module_key, settings)
      VALUES (${OTHER_TENANT}, 'commerce',
        ${JSON.stringify({ features: { campaigns: true, ...FLAGS_ON } })}::jsonb)
      ON CONFLICT (tenant_id, module_key) DO UPDATE SET settings = EXCLUDED.settings
    `;
    expect((await getOne(intruder, made.body.data.id)).status).toBe(404);
    expect((await preview(intruder, made.body.data.id)).status).toBe(404);
    expect(
      (await patch(intruder, made.body.data.id, { segmentId: null })).status
    ).toBe(404);
    expect((await send(intruder, made.body.data.id)).status).toBe(404);
  });
});
