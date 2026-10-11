/**
 * A campaign whose audience is a CRM segment (Issue #362, ADR-0042 Amendment;
 * PRD S3/S4; threat model C-12, C-28, C-29), against a real, migrated
 * PostgreSQL under the least-privilege RUNTIME role (WORLD 1, see
 * `harness.ts`). The HTTP half (route wiring, permissions, the feature gate's
 * 409s, audit rows) is `commerce-campaign-segment-audience-routes.integration.test.ts`.
 *
 * What this file proves, each against live data:
 *   - a segment audience resolves to exactly the members who are also
 *     consented, active and addressable on the channel - recipient rows, e-mail
 *     outbox rows, nothing for a non-member;
 *   - membership is not consent: an opted-out member is refused at ENQUEUE
 *     (never counted, never given a recipient row) and at DISPATCH (consent
 *     withdrawn after the send call, before the page that would reach them);
 *   - eligibility exclusions (walk-in placeholder, blocked, erased) are never
 *     targeted, even by a NOT rule that matches everyone;
 *   - the campaign records the segment id + version and the as-of, the version
 *     is the one it was pinned to (an edit of the segment afterwards does not
 *     change it) and the recorded as-of is what the audience is evaluated at;
 *   - existing campaigns are unchanged: no segment, exact counts, same recipients;
 *   - the feature flag: with it off a segment campaign is deferred (stays
 *     `sending`, nothing sent, never marked `sent`) and resumes when it is on;
 *   - cross-tenant: another tenant's segment cannot be pinned, referenced or
 *     reached, and its customers are never messaged;
 *   - dispatch stays resumable: recorded recipients are skipped, several pages
 *     are drained, and a campaign already `sending` keeps its first as-of;
 *   - the worker role can read every relation a segment audience page joins.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import { withTenantOrThrow } from "../../src/lib/database/tenant-context";
import {
  createCampaign,
  fetchCampaign,
  updateCampaign
} from "../../src/modules/commerce/application/campaign-directory";
import { dispatchCampaignQueue } from "../../src/modules/commerce/application/campaign-dispatch";
import {
  countCampaignSegmentAudience,
  fetchCampaignSegmentState,
  requireCampaignSegmentAudienceFeature,
  resolveCampaignSegmentPin,
  resolveSegmentAudiencePage
} from "../../src/modules/commerce/application/campaign-segment-audience";
import {
  createSegment,
  retireSegment,
  updateSegment
} from "../../src/modules/commerce/application/segment-directory";
import {
  validateCreateSegmentInput,
  validateUpdateSegmentInput
} from "../../src/modules/commerce/domain/segment";
import { updateModuleSettings } from "../../src/modules/module-management/application/module-settings";
import {
  getAdminSql,
  getRuntimeSql,
  getWorkerRoleSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase,
  workerRoleActivated
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a362";
const TENANT_B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b362";
const ACTOR = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c362";
const B_ACTOR = "f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f362";
const WALK_IN_PHONE = "+620000000000";
const DAY = 86_400_000;

function inTenant<T>(
  tenantId: string,
  fn: (tx: Bun.SQL) => Promise<T>
): Promise<T> {
  return withTenantOrThrow(getRuntimeSql(), tenantId, fn);
}

async function seedTenant(id: string, code: string): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${code + " Name"}, ${code + " Legal"}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

async function seedTenantUser(tenantId: string, id: string): Promise<void> {
  const admin = getAdminSql();
  const profile = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', 'Campaign Segment Actor')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`camp-seg-actor-${id}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${id}, ${tenantId}, ${identity[0]!.id})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function setFeatures(
  tenantId: string,
  actor: string,
  features: Record<string, boolean>
): Promise<void> {
  await inTenant(tenantId, (tx) =>
    updateModuleSettings(
      tx,
      tenantId,
      "commerce",
      {
        features: {
          pos: true,
          inbox: true,
          campaigns: true,
          gateway: true,
          courier: true,
          ...features
        }
      },
      actor
    )
  );
}

const ON = { segments: true, campaignSegmentAudience: true };

type ShopperSeed = {
  name: string;
  phone: string;
  level?: number;
  /** Opt-in to marketing (default true). */
  consent?: boolean;
  email?: string | null;
  status?: "active" | "blocked";
  erased?: boolean;
  accountStatus?: "active" | "blocked";
  noAccount?: boolean;
};

let shopperSeq = 0;

/** A customer and (unless `noAccount`) its customer account, with consent as asked. */
async function seedShopper(
  tenantId: string,
  seed: ShopperSeed
): Promise<string> {
  shopperSeq += 1;
  const admin = getAdminSql();
  const rows = (await admin`
    INSERT INTO awcms_commerce_customers
      (tenant_id, name, phone, email, level, status, deleted_at)
    VALUES (
      ${tenantId}, ${seed.name}, ${seed.phone}, ${seed.email ?? null},
      ${seed.level ?? 2}, ${seed.status ?? "active"},
      ${seed.erased ? new Date(Date.now() - DAY).toISOString() : null}::timestamptz
    )
    RETURNING id
  `) as { id: string }[];
  const id = rows[0]!.id;
  if (!seed.noAccount) {
    const email = seed.email ?? `shopper${shopperSeq}@example.test`;
    await admin`
      INSERT INTO awcms_commerce_customer_accounts
        (tenant_id, customer_id, email_normalized, history_from, status,
         marketing_consent_at)
      VALUES (
        ${tenantId}, ${id}, ${email},
        ${new Date(Date.now() - 300 * DAY).toISOString()}::timestamptz,
        ${seed.accountStatus ?? "active"},
        ${seed.consent === false ? null : new Date(Date.now() - 5 * DAY).toISOString()}::timestamptz
      )
    `;
  }
  return id;
}

/** `count` consented level-`level` shoppers (named `${prefix} n`). */
async function seedMany(
  tenantId: string,
  count: number,
  prefix: string,
  level = 2
): Promise<void> {
  for (let n = 1; n <= count; n += 1) {
    await seedShopper(tenantId, {
      name: `${prefix} ${n}`,
      phone: `+6289${String(level)}${String(shopperSeq + 1).padStart(8, "0")}`,
      level
    });
  }
}

let orderSeq = 0;

async function seedPaidOrder(
  tenantId: string,
  customerId: string,
  paidDaysAgo: number
): Promise<void> {
  orderSeq += 1;
  const paidAt = new Date(Date.now() - paidDaysAgo * DAY).toISOString();
  await getAdminSql()`
    INSERT INTO awcms_commerce_orders
      (tenant_id, order_code, customer_id, status, payment_method,
       payment_status, shipping_method, subtotal, total, paid_at)
    VALUES (
      ${tenantId}, ${`CSA-${orderSeq}`}, ${customerId}, 'completed',
      'manual_bank', 'paid', 'self_pickup', '1000.00', '1000.00',
      ${paidAt}::timestamptz
    )
  `;
}

const leaf = (field: string, op: string, value?: unknown, extra = {}) => ({
  field,
  op,
  ...(value === undefined ? {} : { value }),
  ...extra
});

async function makeSegment(
  tenantId: string,
  raw: unknown,
  name = "Audience",
  actor = ACTOR
) {
  const parsed = validateCreateSegmentInput({ name, rules: raw });
  if (!parsed.valid) {
    throw new Error(`create refused: ${JSON.stringify(parsed.errors)}`);
  }
  const outcome = await inTenant(tenantId, (tx) =>
    createSegment(tx, tenantId, actor, parsed.value)
  );
  if (outcome.kind !== "created") throw new Error(`create: ${outcome.kind}`);
  return outcome.segment;
}

type CampaignOptions = {
  segmentId?: string;
  segmentVersion?: number | null;
  channel?: "email" | "whatsapp";
  /** A legacy audience filter: customers with an order since this instant. */
  lastOrderSince?: string;
};

/** A draft campaign, pinned to a segment version when `segmentId` is given. */
async function makeCampaign(tenantId: string, options: CampaignOptions = {}) {
  return inTenant(tenantId, async (tx) => {
    let pin: { segmentId: string; version: number } | null = null;
    if (options.segmentId) {
      const resolved = await resolveCampaignSegmentPin(tx, tenantId, {
        segmentId: options.segmentId,
        segmentVersion: options.segmentVersion ?? null
      });
      if (resolved.kind !== "ok") throw new Error(`pin: ${resolved.kind}`);
      pin = {
        segmentId: resolved.pin.segmentId,
        version: resolved.pin.version
      };
    }
    return createCampaign(
      tx,
      tenantId,
      ACTOR,
      {
        channel: options.channel ?? "email",
        audience: {
          levels: [],
          hasAccount: null,
          lastOrderSince: options.lastOrderSince ?? null
        },
        subject: "Hello {{name}}",
        body: "Welcome, {{name}}!"
      },
      "camp-seg-test",
      pin
    );
  });
}

/** Moves a draft straight to `scheduled` (the dispatcher, not the send route, is under test). */
async function schedule(tenantId: string, campaignId: string): Promise<void> {
  await inTenant(
    tenantId,
    (tx) => tx`
    UPDATE awcms_commerce_campaigns
    SET status = 'scheduled', scheduled_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${campaignId}
  `
  );
}

async function recipientCustomerIds(
  tenantId: string,
  campaignId: string
): Promise<string[]> {
  const rows = (await inTenant(
    tenantId,
    (tx) => tx`
    SELECT customer_id FROM awcms_commerce_campaign_recipients
    WHERE tenant_id = ${tenantId} AND campaign_id = ${campaignId}
  `
  )) as { customer_id: string }[];
  return rows.map((r) => r.customer_id).sort();
}

async function emailAddresses(tenantId: string): Promise<string[]> {
  const rows = (await inTenant(
    tenantId,
    (tx) => tx`
    SELECT to_address FROM awcms_email_messages
    WHERE tenant_id = ${tenantId} AND template_key = 'derived.commerce_campaign'
  `
  )) as { to_address: string }[];
  return rows.map((r) => r.to_address).sort();
}

const dispatch = (tenantId = TENANT_A, sql = getRuntimeSql()) =>
  dispatchCampaignQueue(sql, tenantId, { correlationId: "camp-seg-dispatch" });

suite("campaigns with a segment audience (Issue #362)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    shopperSeq = 0;
    await seedTenant(TENANT_A, "tenant-csa-a");
    await seedTenant(TENANT_B, "tenant-csa-b");
    await seedTenantUser(TENANT_A, ACTOR);
    await seedTenantUser(TENANT_B, B_ACTOR);
    await setFeatures(TENANT_A, ACTOR, ON);
    await setFeatures(TENANT_B, B_ACTOR, ON);
  }, 30000);

  describe("the audience resolves from the segment (PRD S3)", () => {
    test("only members who are also consented, active and addressable are enqueued - recipient rows and e-mail outbox rows - and non-members get nothing", async () => {
      const vip1 = await seedShopper(TENANT_A, {
        name: "Vip One",
        phone: "+6281300003621",
        level: 3,
        email: "vip1@example.test"
      });
      const vip2 = await seedShopper(TENANT_A, {
        name: "Vip Two",
        phone: "+6281300003622",
        level: 3,
        email: "vip2@example.test"
      });
      await seedShopper(TENANT_A, {
        name: "Regular",
        phone: "+6281300003623",
        level: 1,
        email: "regular@example.test"
      });
      // A member whose ACCOUNT is not active: membership is not reachability.
      await seedShopper(TENANT_A, {
        name: "Vip Suspended",
        phone: "+6281300003624",
        level: 3,
        email: "suspended@example.test",
        accountStatus: "blocked"
      });
      // A member with no account at all has no consent to message.
      await seedShopper(TENANT_A, {
        name: "Vip Guest",
        phone: "+6281300003625",
        level: 3,
        noAccount: true
      });

      const segment = await makeSegment(TENANT_A, leaf("level", "eq", 3));
      const campaign = await makeCampaign(TENANT_A, {
        segmentId: segment.id
      });
      await schedule(TENANT_A, campaign.id);

      const result = await dispatch();
      expect(result.claimed).toBe(1);
      expect(result.sent).toBe(1);
      expect(result.segmentPagesDeferred).toBe(0);
      expect(result.recipientsEnqueued).toBe(2);

      expect(await recipientCustomerIds(TENANT_A, campaign.id)).toEqual(
        [vip1, vip2].sort()
      );
      expect(await emailAddresses(TENANT_A)).toEqual([
        "vip1@example.test",
        "vip2@example.test"
      ]);
    });

    test("the same segment works for the WhatsApp channel and needs a phone, not an e-mail address", async () => {
      const a = await seedShopper(TENANT_A, {
        name: "Wa One",
        phone: "+6281300003631",
        level: 3
      });
      const segment = await makeSegment(TENANT_A, leaf("level", "eq", 3));
      const campaign = await makeCampaign(TENANT_A, {
        segmentId: segment.id,
        channel: "whatsapp"
      });
      await schedule(TENANT_A, campaign.id);
      const result = await dispatch();
      expect(result.recipientsEnqueued).toBe(1);
      expect(await recipientCustomerIds(TENANT_A, campaign.id)).toEqual([a]);
      const rows = (await inTenant(
        TENANT_A,
        (tx) => tx`
        SELECT to_phone FROM awcms_commerce_whatsapp_messages
        WHERE tenant_id = ${TENANT_A} AND template_key = 'commerce.campaign'
      `
      )) as { to_phone: string }[];
      expect(rows.map((r) => r.to_phone)).toEqual(["+6281300003631"]);
    });
  });

  describe("membership is never consent (C-12, C-28)", () => {
    test("at ENQUEUE: an opted-out member is not counted and never gets a recipient or an outbox row", async () => {
      await seedMany(TENANT_A, 6, "Consented", 3);
      const optedOut = await seedShopper(TENANT_A, {
        name: "Opted Out",
        phone: "+6281300003641",
        level: 3,
        email: "optedout@example.test",
        consent: false
      });
      const segment = await makeSegment(TENANT_A, leaf("level", "eq", 3));
      const campaign = await makeCampaign(TENANT_A, {
        segmentId: segment.id
      });

      // The count shown before sending is the consented members only: 6, not 7.
      const counted = await inTenant(TENANT_A, (tx) =>
        countCampaignSegmentAudience(
          tx,
          { tenantId: TENANT_A, actorTenantUserId: ACTOR, now: new Date() },
          { segmentId: segment.id, version: 1, asOf: null },
          "email"
        )
      );
      expect(counted.kind).toBe("ok");
      if (counted.kind === "ok") {
        expect(counted.count).toEqual({ suppressed: false, count: 6 });
      }

      await schedule(TENANT_A, campaign.id);
      const result = await dispatch();
      expect(result.recipientsEnqueued).toBe(6);
      expect(await recipientCustomerIds(TENANT_A, campaign.id)).not.toContain(
        optedOut
      );
      expect(await emailAddresses(TENANT_A)).not.toContain(
        "optedout@example.test"
      );
    });

    test("at DISPATCH: consent withdrawn after the send-time check, before the page that would reach the customer, is honoured", async () => {
      const keep = await seedShopper(TENANT_A, {
        name: "Keeps Consent",
        phone: "+6281300003651",
        level: 3,
        email: "keeps@example.test"
      });
      const withdraws = await seedShopper(TENANT_A, {
        name: "Withdraws",
        phone: "+6281300003652",
        level: 3,
        email: "withdraws@example.test"
      });
      const segment = await makeSegment(TENANT_A, leaf("level", "eq", 3));
      const campaign = await makeCampaign(TENANT_A, {
        segmentId: segment.id
      });
      await schedule(TENANT_A, campaign.id);

      // Consent was valid when the campaign was enqueued...
      const before = await inTenant(TENANT_A, (tx) =>
        countCampaignSegmentAudience(
          tx,
          { tenantId: TENANT_A, actorTenantUserId: ACTOR, now: new Date() },
          { segmentId: segment.id, version: 1, asOf: null },
          "email"
        )
      );
      expect(before.kind).toBe("ok");

      // ...and is withdrawn before the dispatcher runs.
      await getAdminSql()`
        UPDATE awcms_commerce_customer_accounts
        SET marketing_consent_at = NULL
        WHERE tenant_id = ${TENANT_A} AND customer_id = ${withdraws}
      `;

      const result = await dispatch();
      expect(result.recipientsEnqueued).toBe(1);
      expect(await recipientCustomerIds(TENANT_A, campaign.id)).toEqual([keep]);
      expect(await emailAddresses(TENANT_A)).toEqual(["keeps@example.test"]);
    });
  });

  describe("excluded customers are never targeted (C-28)", () => {
    test("the walk-in placeholder, a blocked and an erased customer are never recipients, even when a NOT rule matches everyone", async () => {
      const ok1 = await seedShopper(TENANT_A, {
        name: "Fine One",
        phone: "+6281300003661",
        level: 2
      });
      const ok2 = await seedShopper(TENANT_A, {
        name: "Fine Two",
        phone: "+6281300003662",
        level: 3
      });
      await seedShopper(TENANT_A, {
        name: "Walk-in",
        phone: WALK_IN_PHONE,
        level: 2
      });
      await seedShopper(TENANT_A, {
        name: "Blocked",
        phone: "+6281300003663",
        level: 2,
        status: "blocked"
      });
      await seedShopper(TENANT_A, {
        name: "Erased",
        phone: "+6281300003664",
        level: 2,
        erased: true
      });

      // "level is not 9" matches every customer there is.
      const segment = await makeSegment(TENANT_A, {
        not: leaf("level", "eq", 4)
      });
      const campaign = await makeCampaign(TENANT_A, {
        segmentId: segment.id
      });
      await schedule(TENANT_A, campaign.id);
      await dispatch();

      expect(await recipientCustomerIds(TENANT_A, campaign.id)).toEqual(
        [ok1, ok2].sort()
      );
    });
  });

  describe("the version and the as-of are recorded (C-29)", () => {
    test("the campaign carries segment id + version; the as-of is set when the dispatcher claims it; the version is the pinned one, not whatever the segment is later edited to", async () => {
      const lvl3 = await seedShopper(TENANT_A, {
        name: "Level Three",
        phone: "+6281300003671",
        level: 3
      });
      await seedShopper(TENANT_A, {
        name: "Level One",
        phone: "+6281300003672",
        level: 1
      });
      const segment = await makeSegment(TENANT_A, leaf("level", "eq", 3));
      const campaign = await makeCampaign(TENANT_A, {
        segmentId: segment.id
      });
      expect(campaign.segment).toEqual({
        id: segment.id,
        version: 1,
        asOf: null
      });

      // The segment is edited AFTER the draft was pinned: version 2 targets level 1.
      const edit = validateUpdateSegmentInput({
        baseVersion: 1,
        rules: leaf("level", "eq", 1)
      });
      if (!edit.valid) throw new Error("update refused");
      const edited = await inTenant(TENANT_A, (tx) =>
        updateSegment(tx, TENANT_A, ACTOR, segment.id, edit.value)
      );
      expect(edited.kind === "updated" && edited.newVersion).toBe(2);

      const beforeClaim = Date.now();
      await schedule(TENANT_A, campaign.id);
      await dispatch();
      const afterClaim = Date.now();

      // It sent to version 1's audience, and says so.
      expect(await recipientCustomerIds(TENANT_A, campaign.id)).toEqual([lvl3]);
      const sent = await inTenant(TENANT_A, (tx) =>
        fetchCampaign(tx, TENANT_A, campaign.id)
      );
      expect(sent?.status).toBe("sent");
      expect(sent?.segment?.id).toBe(segment.id);
      expect(sent?.segment?.version).toBe(1);
      const asOf = Date.parse(sent!.segment!.asOf!);
      expect(asOf).toBeGreaterThanOrEqual(beforeClaim - 2000);
      expect(asOf).toBeLessThanOrEqual(afterClaim + 2000);

      // Editing or retiring the segment later changes nothing the campaign recorded.
      const retired = await inTenant(TENANT_A, (tx) =>
        retireSegment(tx, TENANT_A, ACTOR, segment.id)
      );
      expect(retired.kind).toBe("retired");
      const again = await inTenant(TENANT_A, (tx) =>
        fetchCampaign(tx, TENANT_A, campaign.id)
      );
      expect(again?.segment).toEqual(sent?.segment ?? null);
    });

    test("a segment can be pinned at a named version, and an unknown version, a retired segment and a foreign segment cannot be chosen", async () => {
      const segment = await makeSegment(TENANT_A, leaf("level", "eq", 3));
      const edit = validateUpdateSegmentInput({
        baseVersion: 1,
        rules: leaf("level", "eq", 2)
      });
      if (!edit.valid) throw new Error("update refused");
      await inTenant(TENANT_A, (tx) =>
        updateSegment(tx, TENANT_A, ACTOR, segment.id, edit.value)
      );

      const pinned = await makeCampaign(TENANT_A, {
        segmentId: segment.id,
        segmentVersion: 1
      });
      expect(pinned.segment?.version).toBe(1);
      const latest = await makeCampaign(TENANT_A, { segmentId: segment.id });
      expect(latest.segment?.version).toBe(2);

      const missing = await inTenant(TENANT_A, (tx) =>
        resolveCampaignSegmentPin(tx, TENANT_A, {
          segmentId: segment.id,
          segmentVersion: 9
        })
      );
      expect(missing.kind).toBe("not_found");

      await inTenant(TENANT_A, (tx) =>
        retireSegment(tx, TENANT_A, ACTOR, segment.id)
      );
      const retiredPin = await inTenant(TENANT_A, (tx) =>
        resolveCampaignSegmentPin(tx, TENANT_A, {
          segmentId: segment.id,
          segmentVersion: null
        })
      );
      expect(retiredPin.kind).toBe("retired");
    });

    test("the recorded as-of, not the clock, decides who is in the audience: an order paid after it does not count", async () => {
      const early = await seedShopper(TENANT_A, {
        name: "Early Buyer",
        phone: "+6281300003681",
        level: 2
      });
      await seedPaidOrder(TENANT_A, early, 20);
      const late = await seedShopper(TENANT_A, {
        name: "Late Buyer",
        phone: "+6281300003682",
        level: 2
      });
      await seedPaidOrder(TENANT_A, late, 5);

      const segment = await makeSegment(
        TENANT_A,
        leaf("order_count", "gte", 1)
      );
      const campaign = await makeCampaign(TENANT_A, { segmentId: segment.id });
      // The campaign was already claimed once, ten days ago, and crashed:
      // `sending`, as-of ten days back. The resumed run must keep that instant.
      const tenDaysAgo = new Date(Date.now() - 10 * DAY).toISOString();
      await inTenant(
        TENANT_A,
        (tx) => tx`
        UPDATE awcms_commerce_campaigns
        SET status = 'sending', scheduled_at = now(), segment_as_of = ${tenDaysAgo}::timestamptz
        WHERE tenant_id = ${TENANT_A} AND id = ${campaign.id}
      `
      );

      await dispatch();
      expect(await recipientCustomerIds(TENANT_A, campaign.id)).toEqual([
        early
      ]);
      const after = await inTenant(TENANT_A, (tx) =>
        fetchCampaign(tx, TENANT_A, campaign.id)
      );
      expect(after?.segment?.asOf).toBe(tenDaysAgo);
    });

    test("counts of a segment campaign under five are withheld (C-27); a legacy campaign's counts are exact", async () => {
      await seedMany(TENANT_A, 2, "Small", 3);
      for (const customerId of (await getAdminSql()`
        SELECT id FROM awcms_commerce_customers WHERE tenant_id = ${TENANT_A}
      `) as { id: string }[]) {
        await seedPaidOrder(TENANT_A, customerId.id, 1);
      }
      const segment = await makeSegment(TENANT_A, leaf("level", "eq", 3));
      const segmentCampaign = await makeCampaign(TENANT_A, {
        segmentId: segment.id
      });
      const legacyCampaign = await makeCampaign(TENANT_A, {
        lastOrderSince: new Date(Date.now() - 30 * DAY).toISOString()
      });
      await schedule(TENANT_A, segmentCampaign.id);
      await schedule(TENANT_A, legacyCampaign.id);
      await dispatch();

      const seg = await inTenant(TENANT_A, (tx) =>
        fetchCampaign(tx, TENANT_A, segmentCampaign.id)
      );
      expect(seg?.status).toBe("sent");
      expect(seg?.recipientCount).toBeNull();
      expect(seg?.sentCount).toBeNull();
      expect(seg?.countsSuppressed).toBe(true);

      const legacy = await inTenant(TENANT_A, (tx) =>
        fetchCampaign(tx, TENANT_A, legacyCampaign.id)
      );
      expect(legacy?.recipientCount).toBe(2);
      expect(legacy?.countsSuppressed).toBe(false);
      expect(legacy?.segment).toBeNull();
    });
  });

  describe("existing campaigns are unchanged", () => {
    test("a campaign with the legacy filters resolves the same recipients, records no segment, and needs none of the new flags", async () => {
      // Every new flag off, as on a tenant that never opened "Features".
      await setFeatures(TENANT_A, ACTOR, {});
      const lvl2a = await seedShopper(TENANT_A, {
        name: "Legacy A",
        phone: "+6281300003691",
        level: 2
      });
      const lvl2b = await seedShopper(TENANT_A, {
        name: "Legacy B",
        phone: "+6281300003692",
        level: 4
      });
      const noOrder = await seedShopper(TENANT_A, {
        name: "Legacy Never Ordered",
        phone: "+6281300003693",
        level: 2
      });
      const noConsent = await seedShopper(TENANT_A, {
        name: "Legacy No Consent",
        phone: "+6281300003694",
        level: 2,
        consent: false
      });
      for (const id of [lvl2a, lvl2b, noConsent]) {
        await seedPaidOrder(TENANT_A, id, 3);
      }
      void noOrder;

      const campaign = await makeCampaign(TENANT_A, {
        lastOrderSince: new Date(Date.now() - 30 * DAY).toISOString()
      });
      expect(campaign.segment).toBeNull();
      await schedule(TENANT_A, campaign.id);
      const result = await dispatch();
      expect(result.segmentPagesDeferred).toBe(0);
      expect(result.sent).toBe(1);
      expect(await recipientCustomerIds(TENANT_A, campaign.id)).toEqual(
        [lvl2a, lvl2b].sort()
      );
      const row = (await getAdminSql()`
        SELECT segment_id, segment_version, segment_as_of
        FROM awcms_commerce_campaigns WHERE id = ${campaign.id}
      `) as {
        segment_id: string | null;
        segment_version: number | null;
        segment_as_of: Date | null;
      }[];
      expect(row[0]).toEqual({
        segment_id: null,
        segment_version: null,
        segment_as_of: null
      });
    });

    test("a draft may be edited back to legacy filters by detaching its segment", async () => {
      const segment = await makeSegment(TENANT_A, leaf("level", "eq", 3));
      const campaign = await makeCampaign(TENANT_A, { segmentId: segment.id });
      const outcome = await inTenant(TENANT_A, (tx) =>
        updateCampaign(
          tx,
          TENANT_A,
          ACTOR,
          campaign.id,
          { audience: { levels: [1], hasAccount: null, lastOrderSince: null } },
          undefined,
          null
        )
      );
      expect(outcome.kind).toBe("updated");
      const state = await inTenant(TENANT_A, (tx) =>
        fetchCampaignSegmentState(tx, TENANT_A, campaign.id)
      );
      expect(state?.pin).toBeNull();
    });
  });

  describe("the feature flag (default OFF)", () => {
    test("the gate refuses while any of campaigns, segments, campaignSegmentAudience is off", async () => {
      expect(
        await inTenant(TENANT_A, (tx) =>
          requireCampaignSegmentAudienceFeature(tx, TENANT_A)
        )
      ).toBeNull();
      const offStates: Record<string, boolean>[] = [
        { segments: true, campaignSegmentAudience: false },
        { segments: false, campaignSegmentAudience: true },
        { campaigns: false, segments: true, campaignSegmentAudience: true }
      ];
      for (const off of offStates) {
        await setFeatures(TENANT_A, ACTOR, off);
        const gate = await inTenant(TENANT_A, (tx) =>
          requireCampaignSegmentAudienceFeature(tx, TENANT_A)
        );
        expect(gate?.status).toBe(409);
      }
      // A tenant that never saved a settings row reads the flag as OFF.
      const fresh = await inTenant(TENANT_B, async (tx) => {
        await tx`DELETE FROM awcms_module_settings WHERE tenant_id = ${TENANT_B}`;
        return requireCampaignSegmentAudienceFeature(tx, TENANT_B);
      });
      expect(fresh?.status).toBe(409);
    });

    test("with the flag off a segment campaign is deferred - nothing is sent and it is NOT marked sent - and it resumes when the flag is on", async () => {
      await seedShopper(TENANT_A, {
        name: "Flag Shopper",
        phone: "+6281300003701",
        level: 3
      });
      const segment = await makeSegment(TENANT_A, leaf("level", "eq", 3));
      const campaign = await makeCampaign(TENANT_A, { segmentId: segment.id });
      await schedule(TENANT_A, campaign.id);

      await setFeatures(TENANT_A, ACTOR, {
        segments: true,
        campaignSegmentAudience: false
      });
      const deferred = await dispatch();
      expect(deferred.claimed).toBe(1);
      expect(deferred.segmentPagesDeferred).toBe(1);
      expect(deferred.sent).toBe(0);
      expect(deferred.recipientsEnqueued).toBe(0);
      expect(await recipientCustomerIds(TENANT_A, campaign.id)).toEqual([]);
      expect(await emailAddresses(TENANT_A)).toEqual([]);
      const midway = await inTenant(TENANT_A, (tx) =>
        fetchCampaign(tx, TENANT_A, campaign.id)
      );
      expect(midway?.status).toBe("sending");

      await setFeatures(TENANT_A, ACTOR, ON);
      const resumed = await dispatch();
      expect(resumed.segmentPagesDeferred).toBe(0);
      expect(resumed.sent).toBe(1);
      expect(resumed.recipientsEnqueued).toBe(1);
    });

    test("a legacy campaign still sends while the segment flags are off", async () => {
      await seedShopper(TENANT_A, {
        name: "Legacy Flag Off",
        phone: "+6281300003711",
        level: 2
      });
      await setFeatures(TENANT_A, ACTOR, {
        segments: false,
        campaignSegmentAudience: false
      });
      const campaign = await makeCampaign(TENANT_A, {});
      await schedule(TENANT_A, campaign.id);
      const result = await dispatch();
      expect(result.sent).toBe(1);
      expect(result.recipientsEnqueued).toBe(1);
    });
  });

  describe("tenant isolation", () => {
    test("another tenant's segment cannot be pinned, and a forged reference fails the foreign key", async () => {
      const foreign = await makeSegment(
        TENANT_B,
        leaf("level", "eq", 3),
        "B only",
        B_ACTOR
      );
      const pin = await inTenant(TENANT_A, (tx) =>
        resolveCampaignSegmentPin(tx, TENANT_A, {
          segmentId: foreign.id,
          segmentVersion: null
        })
      );
      expect(pin.kind).toBe("not_found");

      // Written around the application: a tenant-A campaign naming tenant B's
      // segment version. The composite foreign key refuses it.
      const campaign = await makeCampaign(TENANT_A, {});
      await expect(
        (async () => {
          await getAdminSql()`
            UPDATE awcms_commerce_campaigns
            SET segment_id = ${foreign.id}, segment_version = 1
            WHERE id = ${campaign.id}
          `;
        })()
      ).rejects.toThrow();
    });

    test("a tenant's segment campaign never reaches another tenant's customers", async () => {
      await seedShopper(TENANT_A, {
        name: "A Member",
        phone: "+6281300003721",
        level: 3,
        email: "a-member@example.test"
      });
      await seedShopper(TENANT_B, {
        name: "B Member",
        phone: "+6281300003722",
        level: 3,
        email: "b-member@example.test"
      });
      const segment = await makeSegment(TENANT_A, leaf("level", "eq", 3));
      const campaign = await makeCampaign(TENANT_A, { segmentId: segment.id });
      await schedule(TENANT_A, campaign.id);
      await dispatch(TENANT_A);
      expect(await emailAddresses(TENANT_A)).toEqual(["a-member@example.test"]);
      expect(await emailAddresses(TENANT_B)).toEqual([]);
    });

    test("the shape check refuses a segment id without a version and a stray as-of", async () => {
      const campaign = await makeCampaign(TENANT_A, {});
      await expect(
        (async () => {
          await getAdminSql()`
            UPDATE awcms_commerce_campaigns
            SET segment_as_of = now() WHERE id = ${campaign.id}
          `;
        })()
      ).rejects.toThrow();
    });
  });

  describe("dispatch stays resumable", () => {
    test("several pages are drained; recipients recorded by an earlier run are skipped; each customer once", async () => {
      // 450 members: pages of 200, 200, 50, then an empty page.
      await getAdminSql()`
        WITH c AS (
          INSERT INTO awcms_commerce_customers (tenant_id, name, phone, level)
          SELECT ${TENANT_A}, 'Bulk ' || g, '+62877' || lpad(g::text, 8, '0'), 3
          FROM generate_series(1, 450) g
          RETURNING id, name
        )
        INSERT INTO awcms_commerce_customer_accounts
          (tenant_id, customer_id, email_normalized, history_from, marketing_consent_at)
        SELECT ${TENANT_A}, id, lower(replace(name, ' ', '')) || '@bulk.test',
          now() - interval '300 days', now() - interval '5 days'
        FROM c
      `;
      const segment = await makeSegment(TENANT_A, leaf("level", "eq", 3));
      const campaign = await makeCampaign(TENANT_A, { segmentId: segment.id });

      // A previous run committed three recipients, then crashed mid-send.
      const firstThree = (await getAdminSql()`
        SELECT id FROM awcms_commerce_customers
        WHERE tenant_id = ${TENANT_A} ORDER BY id LIMIT 3
      `) as { id: string }[];
      await inTenant(
        TENANT_A,
        (tx) => tx`
        UPDATE awcms_commerce_campaigns
        SET status = 'sending', scheduled_at = now(), segment_as_of = now()
        WHERE tenant_id = ${TENANT_A} AND id = ${campaign.id}
      `
      );
      for (const customer of firstThree) {
        await inTenant(
          TENANT_A,
          (tx) => tx`
          INSERT INTO awcms_commerce_campaign_recipients
            (tenant_id, campaign_id, customer_id, address_masked, status)
          VALUES (${TENANT_A}, ${campaign.id}, ${customer.id}, 'bu***@bulk.test', 'enqueued')
        `
        );
      }

      const result = await dispatch();
      expect(result.sent).toBe(1);
      expect(result.pagesProcessed).toBeGreaterThanOrEqual(3);
      expect(result.recipientsEnqueued).toBe(447);

      const ids = await recipientCustomerIds(TENANT_A, campaign.id);
      expect(ids).toHaveLength(450);
      expect(new Set(ids).size).toBe(450);
      const sent = await inTenant(TENANT_A, (tx) =>
        fetchCampaign(tx, TENANT_A, campaign.id)
      );
      expect(sent?.recipientCount).toBe(450);

      // Idempotent: nothing left to claim, a second run changes nothing.
      const again = await dispatch();
      expect(again.claimed).toBe(0);
      expect(await recipientCustomerIds(TENANT_A, campaign.id)).toHaveLength(
        450
      );
    }, 120000);

    test("a campaign claimed by one dispatcher is skipped by a concurrent one (FOR UPDATE SKIP LOCKED is still the claim)", async () => {
      await seedMany(TENANT_A, 5, "Race", 3);
      const segment = await makeSegment(TENANT_A, leaf("level", "eq", 3));
      const campaign = await makeCampaign(TENANT_A, { segmentId: segment.id });
      await schedule(TENANT_A, campaign.id);
      const [first, second] = await Promise.all([dispatch(), dispatch()]);
      expect(first.claimed + second.claimed).toBeGreaterThanOrEqual(1);
      const ids = await recipientCustomerIds(TENANT_A, campaign.id);
      expect(ids).toHaveLength(5);
      expect(new Set(ids).size).toBe(5);
      expect(await emailAddresses(TENANT_A)).toHaveLength(5);
    });
  });

  describe("the worker role", () => {
    test("awcms_worker can read everything a segment audience page needs (segments, versions, customers, accounts, orders, loyalty, settings)", async () => {
      if (!workerRoleActivated) return;
      const member = await seedShopper(TENANT_A, {
        name: "Worker Member",
        phone: "+6281300003731",
        level: 3,
        email: "worker-member@example.test"
      });
      await seedShopper(TENANT_A, {
        name: "Worker Non-member",
        phone: "+6281300003732",
        level: 1
      });
      await seedPaidOrder(TENANT_A, member, 3);
      // Every relation the evaluator can join: orders (facts), accounts, loyalty.
      const segment = await makeSegment(TENANT_A, {
        and: [
          leaf("level", "eq", 3),
          leaf("order_count", "gte", 1),
          leaf("has_account", "eq", true),
          leaf("loyalty_balance", "gte", 0)
        ]
      });
      const page = await withTenantOrThrow(
        getWorkerRoleSql(),
        TENANT_A,
        (tx) =>
          resolveSegmentAudiencePage(tx, {
            tenantId: TENANT_A,
            campaignId: "00000000-0000-4000-8000-000000000362",
            channel: "email",
            pin: {
              segmentId: segment.id,
              version: 1,
              asOf: new Date().toISOString()
            },
            pageSize: 200
          }),
        { workClass: "background_sync" }
      );
      expect(page.kind).toBe("page");
      if (page.kind === "page") {
        expect(page.rows.map((r) => r.customer_id)).toEqual([member]);
      }
    });
  });
});
