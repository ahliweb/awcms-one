/**
 * The WhatsApp compatibility adapter and the per-tenant mode against a REAL
 * migrated PostgreSQL (Issue #392, ADR-0133 section 6 phase 2).
 *
 * What is proved, per kind of commerce message (customer OTP, order paid,
 * campaign) and, for document delivery, in
 * `commerce-document-delivery.integration.test.ts`:
 *
 *   - `legacy` (the default, with or without a settings row): the message is ONE
 *     row in `awcms_commerce_whatsapp_messages` with the columns it always had,
 *     and NOTHING in `awcms_whatsapp_messages`;
 *   - `upstream`: the message is ONE row in `awcms_whatsapp_messages` with the
 *     commerce template key, the registered purpose, the caller's correlation id
 *     and an idempotency key, and NOTHING in the legacy table;
 *   - a refusal or suppression is returned (`enqueued: false`), never thrown,
 *     and writes no row anywhere;
 *   - the mode is per tenant, survives a settings reset, and a tenant that moves
 *     to `upstream` keeps draining its old legacy rows through the legacy
 *     dispatcher while new messages enter the new queue (no copy, no dual write);
 *   - the upstream dispatcher sends a commerce message, clears an OTP at its
 *     terminal state, and a campaign dispatch tick works as `awcms_worker`.
 *
 * Gated on `DATABASE_URL` (harness).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import { withTenantOrThrow } from "../../src/lib/database/tenant-context";
import { createCampaign } from "../../src/modules/commerce/application/campaign-directory";
import { dispatchCampaignQueue } from "../../src/modules/commerce/application/campaign-dispatch";
import { createAccountForCustomer } from "../../src/modules/commerce/application/customer-account-store";
import { findOrCreateCustomerByPhone } from "../../src/modules/commerce/application/customer-directory";
import {
  requestCustomerOtp,
  updateMarketingConsent
} from "../../src/modules/commerce/application/customer-auth";
import { resetStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import { enqueueWhatsappMessage } from "../../src/modules/commerce/application/whatsapp-enqueue";
import { dispatchWhatsappQueue as dispatchLegacyQueue } from "../../src/modules/commerce/application/whatsapp-dispatch";
import { resolveWhatsappCustomerOtpChannel } from "../../src/modules/commerce/application/whatsapp-otp-channel-adapter";
import { readWhatsappMode } from "../../src/modules/commerce/application/whatsapp-mode";
import {
  createSuppression,
  grantMarketingConsent
} from "../../src/modules/whatsapp-delivery/application/whatsapp-consent-directory";
import { dispatchWhatsappQueue as dispatchUpstreamQueue } from "../../src/modules/whatsapp-delivery/application/whatsapp-dispatch";
import {
  getAdminSql,
  getRuntimeSql,
  getWorkerRoleSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "39200000-0000-4000-8000-00000000000a";
const TENANT_B = "39200000-0000-4000-8000-00000000000b";
const STAFF = "39200000-0000-4000-8000-0000000000c1";
const PHONE = "+6281234567890";

const KEY = Buffer.from(
  Array.from({ length: 32 }, (_, i) => (i * 13 + 7) % 251)
).toString("base64");

const ENV_KEYS = [
  "WHATSAPP_ENABLED",
  "WHATSAPP_PROVIDER",
  "WHATSAPP_RECIPIENT_HASH_KEYS",
  "COMMERCE_WHATSAPP_ENABLED",
  "COMMERCE_WHATSAPP_PROVIDER"
] as const;
const SAVED: Record<string, string | undefined> = {};

function setEnv(over: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
  process.env.WHATSAPP_ENABLED = "true";
  process.env.WHATSAPP_PROVIDER = "log";
  process.env.WHATSAPP_RECIPIENT_HASH_KEYS = `k1:${KEY}`;
  process.env.COMMERCE_WHATSAPP_ENABLED = "true";
  process.env.COMMERCE_WHATSAPP_PROVIDER = "log";
  for (const [name, value] of Object.entries(over)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function seedTenant(id: string, code: string): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${code + " Name"}, ${code + " Legal"}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

async function seedStaff(tenantId: string): Promise<void> {
  const admin = getAdminSql();
  const profile = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', 'Compat Test Actor')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`compat-${tenantId}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${STAFF}, ${tenantId}, ${identity[0]!.id})
    ON CONFLICT (id) DO NOTHING
  `;
}

/** Sets the tenant's mode by SQL: changing it is issue #393's tool, not this change's. */
async function setMode(tenantId: string, mode: "legacy" | "upstream") {
  await getAdminSql()`
    INSERT INTO awcms_commerce_store_settings (tenant_id, whatsapp_mode, whatsapp_mode_changed_at)
    VALUES (${tenantId}, ${mode}, now())
    ON CONFLICT (tenant_id) DO UPDATE
      SET whatsapp_mode = EXCLUDED.whatsapp_mode, whatsapp_mode_changed_at = now()
  `;
}

const inTenant = <T>(
  tenantId: string,
  fn: (tx: Bun.TransactionSQL) => Promise<T>
) => withTenantOrThrow(getRuntimeSql(), tenantId, fn);

type LegacyRow = {
  id: string;
  template_key: string;
  correlation_id: string | null;
  to_phone: string;
  to_phone_hash: string;
  to_phone_masked: string;
  variables: Record<string, string>;
  body_rendered: string;
  status: string;
};
type UpstreamRow = {
  id: string;
  template_key: string;
  purpose: string;
  correlation_id: string | null;
  idempotency_key: string;
  recipient: string;
  status: string;
  contains_secret: boolean;
  expires_at: Date | null;
  body: string;
};

async function legacyRows(tenantId: string): Promise<LegacyRow[]> {
  return (await getAdminSql()`
    SELECT id, template_key, correlation_id, to_phone, to_phone_hash,
           to_phone_masked, variables, body_rendered, status
    FROM awcms_commerce_whatsapp_messages WHERE tenant_id = ${tenantId}
    ORDER BY created_at, id
  `) as LegacyRow[];
}
async function upstreamRows(tenantId: string): Promise<UpstreamRow[]> {
  return (await getAdminSql()`
    SELECT id, template_key, purpose, correlation_id, idempotency_key, recipient,
           status, contains_secret, expires_at, body
    FROM awcms_whatsapp_messages WHERE tenant_id = ${tenantId}
    ORDER BY created_at, id
  `) as UpstreamRow[];
}

const OTP_VARIABLES = {
  code: "246810",
  expiresInMinutes: "10",
  storeName: "Toko A"
};
const OTP_REQUEST = {
  tenantId: TENANT_A,
  via: "whatsapp" as const,
  emailNormalized: null,
  phoneNormalized: PHONE,
  code: OTP_VARIABLES.code,
  purpose: "login" as const,
  expiresInMinutes: 10,
  storeName: "Toko A",
  correlationId: "otp-request-1"
};

async function seedAccount(tenantId: string, phone: string, consent: boolean) {
  return inTenant(tenantId, async (tx) => {
    await findOrCreateCustomerByPhone(
      tx,
      tenantId,
      "Campaign Shopper",
      phone,
      null
    );
    const account = await createAccountForCustomer(tx, tenantId, {
      name: "Campaign Shopper",
      phone,
      emailNormalized: `${phone.replace(/\D/g, "")}@example.test`
    });
    if (consent) await updateMarketingConsent(tx, tenantId, account, true);
    return account;
  });
}

async function sendCampaign(
  tenantId: string,
  body = "Hi {{name}}, visit {{storeName}}"
) {
  const campaign = await inTenant(tenantId, (tx) =>
    createCampaign(
      tx,
      tenantId,
      STAFF,
      {
        channel: "whatsapp",
        audience: { levels: [], hasAccount: null, lastOrderSince: null },
        subject: null,
        body
      },
      "compat-campaign"
    )
  );
  await getAdminSql()`
    UPDATE awcms_commerce_campaigns SET status = 'scheduled', scheduled_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${campaign.id}
  `;
  return campaign;
}

suite("commerce WhatsApp compatibility adapter and mode (Issue #392)", () => {
  beforeAll(async () => {
    for (const name of ENV_KEYS) SAVED[name] = process.env[name];
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    for (const name of ENV_KEYS) {
      if (SAVED[name] === undefined) delete process.env[name];
      else process.env[name] = SAVED[name];
    }
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    setEnv();
    await resetDatabase();
    await seedTenant(TENANT_A, "tenant-a");
    await seedTenant(TENANT_B, "tenant-b");
    await seedStaff(TENANT_A);
  }, 30000);

  afterEach(() => setEnv());

  // -------------------------------------------------------------------------
  describe("legacy mode is unchanged", () => {
    test("a tenant with no settings row is legacy: one legacy row with the old columns, nothing upstream", async () => {
      expect(
        await inTenant(TENANT_A, (tx) => readWhatsappMode(tx, TENANT_A))
      ).toBe("legacy");

      const result = await inTenant(TENANT_A, (tx) =>
        enqueueWhatsappMessage(tx, {
          tenantId: TENANT_A,
          toPhone: PHONE,
          templateKey: "commerce.customer_otp",
          variables: OTP_VARIABLES,
          correlationId: "corr-legacy"
        })
      );

      const rows = await legacyRows(TENANT_A);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: result.id,
        template_key: "commerce.customer_otp",
        correlation_id: "corr-legacy",
        to_phone: PHONE,
        to_phone_masked: expect.not.stringContaining("1234567"),
        variables: OTP_VARIABLES,
        status: "queued"
      });
      expect(rows[0]!.body_rendered).toBe(result.bodyRendered);
      expect(rows[0]!.body_rendered).toContain("246810");
      expect(result.enqueued).toBe(true);
      expect(await upstreamRows(TENANT_A)).toHaveLength(0);
    });

    test("an explicit `legacy` row behaves exactly like no row, for every kind of message", async () => {
      await setMode(TENANT_A, "legacy");
      for (const [templateKey, variables] of [
        ["commerce.customer_otp", OTP_VARIABLES],
        [
          "commerce.order_paid",
          { orderCode: "BJ-1", total: "30000.00", storeName: "Toko A" }
        ],
        ["commerce.campaign", { body: "Diskon", storeName: "Toko A" }]
      ] as const) {
        await inTenant(TENANT_A, (tx) =>
          enqueueWhatsappMessage(tx, {
            tenantId: TENANT_A,
            toPhone: PHONE,
            templateKey,
            variables: { ...variables },
            correlationId: `c-${templateKey}`,
            idempotencyKey: "ignored-by-legacy"
          })
        );
      }

      expect((await legacyRows(TENANT_A)).map((r) => r.template_key)).toEqual([
        "commerce.customer_otp",
        "commerce.order_paid",
        "commerce.campaign"
      ]);
      expect(await upstreamRows(TENANT_A)).toHaveLength(0);
    });

    test("a legacy campaign tick enqueues the legacy row for each consented customer, as before", async () => {
      await seedAccount(TENANT_A, "+6281300000001", true);
      await seedAccount(TENANT_A, "+6281300000002", false);
      await sendCampaign(TENANT_A);

      const tick = await dispatchCampaignQueue(getRuntimeSql(), TENANT_A, {
        correlationId: "legacy-tick"
      });

      expect(tick).toMatchObject({
        claimed: 1,
        sent: 1,
        recipientsEnqueued: 1
      });
      const rows = await legacyRows(TENANT_A);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        template_key: "commerce.campaign",
        to_phone: "+6281300000001"
      });
      expect(await upstreamRows(TENANT_A)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("upstream mode sends through the port", () => {
    beforeEach(() => setMode(TENANT_A, "upstream"));

    test("customer OTP: a `security` message that expires with the code, in the caller's transaction, and nothing legacy", async () => {
      const before = Date.now();
      const sent = await inTenant(TENANT_A, (tx) =>
        resolveWhatsappCustomerOtpChannel().sendOtp(tx, OTP_REQUEST)
      );

      expect(sent).toEqual({ sent: true });
      expect(await legacyRows(TENANT_A)).toHaveLength(0);
      const rows = await upstreamRows(TENANT_A);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        template_key: "commerce.customer_otp",
        purpose: "security",
        correlation_id: "otp-request-1",
        recipient: PHONE,
        status: "queued",
        contains_secret: true
      });
      expect(rows[0]!.body).toContain("246810");
      expect(rows[0]!.idempotency_key.startsWith("commerce:")).toBe(true);
      const ttl = rows[0]!.expires_at!.getTime() - before;
      expect(ttl).toBeGreaterThan(9 * 60_000);
      expect(ttl).toBeLessThan(11 * 60_000);
    });

    test("two OTP requests are two messages: a replayed key must never deliver the old code for the new one", async () => {
      for (const code of ["111111", "222222"]) {
        await inTenant(TENANT_A, (tx) =>
          resolveWhatsappCustomerOtpChannel().sendOtp(tx, {
            ...OTP_REQUEST,
            code,
            correlationId: "same-correlation-id"
          })
        );
      }

      const rows = await upstreamRows(TENANT_A);
      expect(rows).toHaveLength(2);
      expect(
        rows.map((r) => r.body.includes("111111") || r.body.includes("222222"))
      ).toEqual([true, true]);
    });

    test("the OTP request is available on the queue's own flag, and the legacy log adapter is not used", async () => {
      // No commerce-side flag at all: only the queue's `WHATSAPP_ENABLED` matters.
      setEnv({
        COMMERCE_WHATSAPP_ENABLED: undefined,
        COMMERCE_WHATSAPP_PROVIDER: undefined
      });
      const outcome = await inTenant(TENANT_A, (tx) =>
        requestCustomerOtp(
          tx,
          TENANT_A,
          "Toko A",
          { email: "", phone: PHONE, purpose: "login", via: "whatsapp" },
          resolveWhatsappCustomerOtpChannel(),
          "otp-corr"
        )
      );

      expect(outcome.kind).toBe("sent");
      expect(await legacyRows(TENANT_A)).toHaveLength(0);
      expect(await upstreamRows(TENANT_A)).toHaveLength(1);

      // And off when the queue is off, before an OTP row is issued.
      setEnv({ WHATSAPP_ENABLED: "false" });
      const off = await inTenant(TENANT_A, (tx) =>
        requestCustomerOtp(
          tx,
          TENANT_A,
          "Toko A",
          { email: "", phone: PHONE, purpose: "login", via: "whatsapp" },
          resolveWhatsappCustomerOtpChannel()
        )
      );
      expect(off.kind).toBe("channel_unavailable");
    });

    test("a legacy tenant is still gated by the legacy flag, whatever the queue's flag says", async () => {
      await setMode(TENANT_B, "legacy");
      setEnv({ COMMERCE_WHATSAPP_ENABLED: "false", WHATSAPP_ENABLED: "true" });
      const outcome = await inTenant(TENANT_B, (tx) =>
        requestCustomerOtp(
          tx,
          TENANT_B,
          "Toko B",
          { email: "", phone: PHONE, purpose: "login", via: "whatsapp" },
          resolveWhatsappCustomerOtpChannel()
        )
      );
      expect(outcome.kind).toBe("channel_unavailable");
    });

    test("order paid: a `transactional` message", async () => {
      const result = await inTenant(TENANT_A, (tx) =>
        enqueueWhatsappMessage(tx, {
          tenantId: TENANT_A,
          toPhone: PHONE,
          templateKey: "commerce.order_paid",
          variables: {
            orderCode: "BJ-77",
            total: "30000.00",
            storeName: "Toko A"
          },
          correlationId: "order-77",
          idempotencyKey: "order_paid:77"
        })
      );

      expect(result.enqueued).toBe(true);
      expect(result.bodyRendered).toContain("BJ-77");
      expect(await legacyRows(TENANT_A)).toHaveLength(0);
      const rows = await upstreamRows(TENANT_A);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: result.id,
        template_key: "commerce.order_paid",
        purpose: "transactional",
        correlation_id: "order-77",
        idempotency_key: "commerce:order_paid:77",
        contains_secret: false,
        expires_at: null
      });
      expect(rows[0]!.body).toBe(result.bodyRendered);
    });

    test("an idempotent replay answers the same message and queues nothing twice", async () => {
      const send = () =>
        inTenant(TENANT_A, (tx) =>
          enqueueWhatsappMessage(tx, {
            tenantId: TENANT_A,
            toPhone: PHONE,
            templateKey: "commerce.order_paid",
            variables: {
              orderCode: "BJ-5",
              total: "1.00",
              storeName: "Toko A"
            },
            idempotencyKey: "order_paid:5"
          })
        );
      const first = await send();
      const second = await send();

      expect(second).toMatchObject({ id: first.id, enqueued: true });
      expect(await upstreamRows(TENANT_A)).toHaveLength(1);
    });

    test("campaigns: a consented recipient is queued as `marketing`, an unconsented one is skipped, nothing legacy", async () => {
      const consented = await seedAccount(TENANT_A, "+6281300000011", true);
      const unrecorded = await seedAccount(TENANT_A, "+6281300000012", true);
      // The queue has its own consent store: only the first customer is opted in THERE.
      await inTenant(TENANT_A, (tx) =>
        grantMarketingConsent(tx, TENANT_A, null, {
          phone: "+6281300000011",
          source: "commerce_test"
        })
      );
      const campaign = await sendCampaign(TENANT_A);

      const tick = await dispatchCampaignQueue(getRuntimeSql(), TENANT_A, {
        correlationId: "upstream-tick"
      });

      expect(tick).toMatchObject({
        claimed: 1,
        sent: 1,
        recipientsEnqueued: 1
      });
      expect(await legacyRows(TENANT_A)).toHaveLength(0);
      const rows = await upstreamRows(TENANT_A);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        template_key: "commerce.campaign",
        purpose: "marketing",
        recipient: "+6281300000011",
        correlation_id: "upstream-tick",
        idempotency_key: `commerce:campaign:${campaign.id}:${consented.customerId}`
      });
      const recipients = (await getAdminSql()`
        SELECT customer_id, status FROM awcms_commerce_campaign_recipients
        WHERE tenant_id = ${TENANT_A} AND campaign_id = ${campaign.id}
      `) as { customer_id: string; status: string }[];
      expect(
        Object.fromEntries(recipients.map((r) => [r.customer_id, r.status]))
      ).toEqual({
        [consented.customerId]: "enqueued",
        [unrecorded.customerId]: "skipped"
      });
    }, 30000);

    test("a campaign tick runs end to end as the real awcms_worker role", async () => {
      await seedAccount(TENANT_A, "+6281300000021", true);
      await inTenant(TENANT_A, (tx) =>
        grantMarketingConsent(tx, TENANT_A, null, {
          phone: "+6281300000021",
          source: "commerce_test"
        })
      );
      await sendCampaign(TENANT_A);

      const tick = await dispatchCampaignQueue(getWorkerRoleSql(), TENANT_A, {
        correlationId: "upstream-worker-tick"
      });

      expect(tick).toMatchObject({
        claimed: 1,
        sent: 1,
        recipientsEnqueued: 1
      });
      expect(await upstreamRows(TENANT_A)).toHaveLength(1);
      expect(await legacyRows(TENANT_A)).toHaveLength(0);
    }, 30000);

    test("the upstream dispatcher sends a commerce message and clears the OTP code at the terminal state", async () => {
      await inTenant(TENANT_A, (tx) =>
        resolveWhatsappCustomerOtpChannel().sendOtp(tx, OTP_REQUEST)
      );
      await inTenant(TENANT_A, (tx) =>
        enqueueWhatsappMessage(tx, {
          tenantId: TENANT_A,
          toPhone: "+6281234567891",
          templateKey: "commerce.order_paid",
          variables: { orderCode: "BJ-9", total: "9.00", storeName: "Toko A" }
        })
      );

      const result = await dispatchUpstreamQueue(getWorkerRoleSql(), TENANT_A, {
        env: process.env
      });

      expect(result).toMatchObject({ claimed: 2, sent: 2, failed: 0 });
      const rows = await upstreamRows(TENANT_A);
      expect(rows.map((r) => r.status)).toEqual(["sent", "sent"]);
      const otp = rows.find((r) => r.template_key === "commerce.customer_otp")!;
      expect(otp.body).toBe("");
      expect(otp.body).not.toContain("246810");
    });

    test("refusals are RETURNED and write nothing: queue off, no opt-in, opted out", async () => {
      setEnv({ WHATSAPP_ENABLED: "false" });
      const off = await inTenant(TENANT_A, (tx) =>
        enqueueWhatsappMessage(tx, {
          tenantId: TENANT_A,
          toPhone: PHONE,
          templateKey: "commerce.order_paid",
          variables: { orderCode: "X", total: "1", storeName: "T" }
        })
      );
      expect(off).toMatchObject({
        id: "",
        enqueued: false,
        reason: "DISABLED"
      });
      // A refused OTP does not break the OTP channel: it reports `sent: false`.
      expect(
        await inTenant(TENANT_A, (tx) =>
          resolveWhatsappCustomerOtpChannel().sendOtp(tx, OTP_REQUEST)
        )
      ).toEqual({ sent: false });

      setEnv();
      const noConsent = await inTenant(TENANT_A, (tx) =>
        enqueueWhatsappMessage(tx, {
          tenantId: TENANT_A,
          toPhone: PHONE,
          templateKey: "commerce.campaign",
          variables: { body: "Promo", storeName: "T" }
        })
      );
      expect(noConsent).toMatchObject({
        enqueued: false,
        reason: "CONSENT_REQUIRED"
      });

      await inTenant(TENANT_A, (tx) =>
        createSuppression(tx, TENANT_A, null, {
          phone: PHONE,
          reason: "manual"
        })
      );
      const suppressed = await inTenant(TENANT_A, (tx) =>
        enqueueWhatsappMessage(tx, {
          tenantId: TENANT_A,
          toPhone: PHONE,
          templateKey: "commerce.order_paid",
          variables: { orderCode: "X", total: "1", storeName: "T" }
        })
      );
      expect(suppressed).toMatchObject({
        enqueued: false,
        reason: expect.stringMatching(/^SUPPRESSED_/)
      });

      expect(await upstreamRows(TENANT_A)).toHaveLength(0);
      expect(await legacyRows(TENANT_A)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("the mode is per tenant and moves nothing", () => {
    test("two tenants in one database use different queues at the same time", async () => {
      await setMode(TENANT_A, "upstream");
      for (const tenantId of [TENANT_A, TENANT_B]) {
        await inTenant(tenantId, (tx) =>
          enqueueWhatsappMessage(tx, {
            tenantId,
            toPhone: PHONE,
            templateKey: "commerce.order_paid",
            variables: { orderCode: "Z", total: "1.00", storeName: "T" }
          })
        );
      }

      expect(await upstreamRows(TENANT_A)).toHaveLength(1);
      expect(await legacyRows(TENANT_A)).toHaveLength(0);
      expect(await upstreamRows(TENANT_B)).toHaveLength(0);
      expect(await legacyRows(TENANT_B)).toHaveLength(1);
    });

    test("a tenant that moves to upstream drains its old legacy rows through the legacy dispatcher; new messages enter the new queue only", async () => {
      // One message queued while legacy ...
      await inTenant(TENANT_A, (tx) =>
        enqueueWhatsappMessage(tx, {
          tenantId: TENANT_A,
          toPhone: PHONE,
          templateKey: "commerce.order_paid",
          variables: { orderCode: "OLD", total: "1.00", storeName: "T" }
        })
      );
      // ... the mode flips (by hand: the guarded flip is #393) ...
      await setMode(TENANT_A, "upstream");
      await inTenant(TENANT_A, (tx) =>
        enqueueWhatsappMessage(tx, {
          tenantId: TENANT_A,
          toPhone: PHONE,
          templateKey: "commerce.order_paid",
          variables: { orderCode: "NEW", total: "2.00", storeName: "T" }
        })
      );

      // No copy: each queue holds exactly its own message.
      expect(
        (await legacyRows(TENANT_A)).map((r) => r.variables.orderCode)
      ).toEqual(["OLD"]);
      expect(
        (await upstreamRows(TENANT_A)).map((r) => r.body.includes("NEW"))
      ).toEqual([true]);

      // The legacy dispatcher still drains the legacy row and ignores the new one.
      const legacy = await dispatchLegacyQueue(getRuntimeSql(), TENANT_A, {
        env: process.env
      });
      expect(legacy).toMatchObject({ claimed: 1, sent: 1 });
      expect((await legacyRows(TENANT_A))[0]!.status).toBe("sent");
      expect((await upstreamRows(TENANT_A))[0]!.status).toBe("queued");
    });

    test("resetting the store settings keeps an upstream tenant's row live, so retention cannot purge the mode; a legacy tenant resets as before", async () => {
      await setMode(TENANT_A, "upstream");
      await inTenant(TENANT_A, (tx) => resetStoreSettings(tx, TENANT_A, STAFF));
      await setMode(TENANT_B, "legacy");
      await seedStaffFor(TENANT_B);
      await inTenant(TENANT_B, (tx) =>
        resetStoreSettings(tx, TENANT_B, STAFF_B)
      );

      const rows = (await getAdminSql()`
        SELECT tenant_id, whatsapp_mode, deleted_at FROM awcms_commerce_store_settings
        WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})
      `) as {
        tenant_id: string;
        whatsapp_mode: string;
        deleted_at: Date | null;
      }[];
      const byTenant = new Map(rows.map((r) => [r.tenant_id, r]));

      expect(byTenant.get(TENANT_A)).toMatchObject({
        whatsapp_mode: "upstream",
        deleted_at: null
      });
      expect(byTenant.get(TENANT_B)!.deleted_at).not.toBeNull();
    });

    test("the mode column refuses an unknown value", async () => {
      // Awaited inside try/catch: handing a Bun.SQL query to `expect().rejects`
      // spins the runner.
      let refused = false;
      try {
        await getAdminSql()`
          INSERT INTO awcms_commerce_store_settings (tenant_id, whatsapp_mode)
          VALUES (${TENANT_A}, 'both')
        `;
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
    });
  });
});

const STAFF_B = "39200000-0000-4000-8000-0000000000c2";

async function seedStaffFor(tenantId: string): Promise<void> {
  const admin = getAdminSql();
  const profile = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', 'Compat Test Actor B')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`compat-b-${tenantId}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${STAFF_B}, ${tenantId}, ${identity[0]!.id})
    ON CONFLICT (id) DO NOTHING
  `;
}
