/**
 * `commerce` customer campaigns integration (Issue #114, contract #106
 * ADR-0017 D9) — exercised against a REAL migrated database through
 * `tests/integration/harness.ts`, the same shape `commerce-conversations`'s
 * own integration suite (#111) uses. Gated on `DATABASE_URL`; skips cleanly
 * without one.
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
  cancelCampaign,
  createCampaign,
  fetchCampaign
} from "../../src/modules/commerce/application/campaign-directory";
import { dispatchCampaignQueue } from "../../src/modules/commerce/application/campaign-dispatch";
import { createAccountForCustomer } from "../../src/modules/commerce/application/customer-account-store";
import { findOrCreateCustomerByPhone } from "../../src/modules/commerce/application/customer-directory";
import {
  fetchCustomerAccountView,
  updateMarketingConsent
} from "../../src/modules/commerce/application/customer-auth";
import type { CustomerAccountRecord } from "../../src/modules/commerce/application/customer-account-store";
import {
  getAdminSql,
  getRuntimeSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "44444444-4444-4444-4444-444444444444";
const ACTOR_ID = "55555555-5555-5555-5555-555555555555";

async function seedTenant(id: string, code: string): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${code + " Name"}, ${code + " Legal"}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

function inTenant<T>(
  tenantId: string,
  fn: (tx: Bun.TransactionSQL) => Promise<T>
): Promise<T> {
  return withTenantOrThrow(getRuntimeSql(), tenantId, fn);
}

async function seedAccount(
  tenantId: string,
  phone: string,
  consent: boolean
): Promise<CustomerAccountRecord> {
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
    if (consent) {
      await updateMarketingConsent(tx, tenantId, account, true);
    }
    return account;
  });
}

suite("commerce campaigns integration (Issue #114)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "tenant-a");
  }, 30000);

  test("marketingConsent toggle flips marketing_consent_at and is reflected on the account view", async () => {
    const account = await seedAccount(TENANT_A, "+6281300000001", false);

    const before = await inTenant(TENANT_A, (tx) =>
      fetchCustomerAccountView(tx, TENANT_A, account.id)
    );
    expect(before?.marketingConsent).toBe(false);

    await inTenant(TENANT_A, (tx) =>
      updateMarketingConsent(tx, TENANT_A, account, true)
    );
    const afterGrant = await inTenant(TENANT_A, (tx) =>
      fetchCustomerAccountView(tx, TENANT_A, account.id)
    );
    expect(afterGrant?.marketingConsent).toBe(true);

    await inTenant(TENANT_A, (tx) =>
      updateMarketingConsent(tx, TENANT_A, account, false)
    );
    const afterRevoke = await inTenant(TENANT_A, (tx) =>
      fetchCustomerAccountView(tx, TENANT_A, account.id)
    );
    expect(afterRevoke?.marketingConsent).toBe(false);

    // Both the grant and the revoke are audited (Issue #114's own instructions).
    const auditRows = (await inTenant(
      TENANT_A,
      (tx) => tx`
      SELECT action, message FROM awcms_audit_events
      WHERE tenant_id = ${TENANT_A} AND resource_type = 'customer_marketing_consent'
        AND resource_id = ${account.id}
      ORDER BY created_at ASC
    `
    )) as { action: string; message: string }[];
    expect(auditRows.length).toBe(2);
    expect(auditRows[0]?.message).toContain("granted");
    expect(auditRows[1]?.message).toContain("revoked");
  });

  test("consented vs not-consented audience: only consented, addressable customers are enqueued", async () => {
    // Every seeded account has both an e-mail and a phone (`seedAccount`), so
    // BOTH consented customers below are addressable on BOTH channels —
    // consent is a single per-account flag, not per-channel (ADR-0017 D9).
    // The un-consented customer must never be enqueued by either campaign.
    const consentedOne = await seedAccount(TENANT_A, "+6281300000010", true);
    const consentedTwo = await seedAccount(TENANT_A, "+6281300000011", true);
    const notConsented = await seedAccount(TENANT_A, "+6281300000012", false);
    void notConsented;

    const emailCampaign = await inTenant(TENANT_A, (tx) =>
      createCampaign(
        tx,
        TENANT_A,
        ACTOR_ID,
        {
          channel: "email",
          audience: { levels: [], hasAccount: null, lastOrderSince: null },
          subject: "Hello {{name}}",
          body: "Welcome to {{storeName}}, {{name}}!"
        },
        "test-correlation-email"
      )
    );

    const whatsappCampaign = await inTenant(TENANT_A, (tx) =>
      createCampaign(
        tx,
        TENANT_A,
        ACTOR_ID,
        {
          channel: "whatsapp",
          audience: { levels: [], hasAccount: null, lastOrderSince: null },
          subject: null,
          body: "Hi {{name}}, check out {{storeName}}!"
        },
        "test-correlation-whatsapp"
      )
    );

    // Move both campaigns to `scheduled` (due now) directly — bypassing the
    // route's `sendCampaign` idempotency wrapper is fine here since this
    // test exercises the DISPATCHER, not the send endpoint.
    await inTenant(
      TENANT_A,
      (tx) => tx`
      UPDATE awcms_commerce_campaigns
      SET status = 'scheduled', scheduled_at = now()
      WHERE tenant_id = ${TENANT_A} AND id IN (${emailCampaign.id}, ${whatsappCampaign.id})
    `
    );

    const runtimeSql = getRuntimeSql();
    const result = await dispatchCampaignQueue(runtimeSql, TENANT_A, {
      correlationId: "dispatch-test"
    });

    expect(result.claimed).toBe(2);
    expect(result.sent).toBe(2);
    // Both consented, addressable customers, on both campaigns.
    expect(result.recipientsEnqueued).toBe(4);

    const emailAfter = await inTenant(TENANT_A, (tx) =>
      fetchCampaign(tx, TENANT_A, emailCampaign.id)
    );
    expect(emailAfter?.status).toBe("sent");
    expect(emailAfter?.recipientCount).toBe(2);

    const whatsappAfter = await inTenant(TENANT_A, (tx) =>
      fetchCampaign(tx, TENANT_A, whatsappCampaign.id)
    );
    expect(whatsappAfter?.status).toBe("sent");
    expect(whatsappAfter?.recipientCount).toBe(2);

    // The recipient rows themselves — exactly the two consented accounts,
    // marked `enqueued`, never the un-consented one.
    const emailRecipients = (await inTenant(
      TENANT_A,
      (tx) => tx`
      SELECT customer_id, status FROM awcms_commerce_campaign_recipients
      WHERE tenant_id = ${TENANT_A} AND campaign_id = ${emailCampaign.id}
    `
    )) as { customer_id: string; status: string }[];
    expect(emailRecipients.length).toBe(2);
    expect(emailRecipients.every((r) => r.status === "enqueued")).toBe(true);
    expect(emailRecipients.map((r) => r.customer_id).sort()).toEqual(
      [consentedOne.customerId, consentedTwo.customerId].sort()
    );
    expect(
      emailRecipients.some((r) => r.customer_id === notConsented.customerId)
    ).toBe(false);

    const whatsappRecipients = (await inTenant(
      TENANT_A,
      (tx) => tx`
      SELECT customer_id, status FROM awcms_commerce_campaign_recipients
      WHERE tenant_id = ${TENANT_A} AND campaign_id = ${whatsappCampaign.id}
    `
    )) as { customer_id: string; status: string }[];
    expect(whatsappRecipients.length).toBe(2);
    expect(whatsappRecipients.every((r) => r.status === "enqueued")).toBe(true);
    expect(whatsappRecipients.map((r) => r.customer_id).sort()).toEqual(
      [consentedOne.customerId, consentedTwo.customerId].sort()
    );

    // The outboxes themselves — two e-mail rows (derived.commerce_campaign,
    // rendered subject/body), two WhatsApp rows (commerce.campaign).
    const emailMessages = (await inTenant(
      TENANT_A,
      (tx) => tx`
      SELECT template_key, subject, to_address FROM awcms_email_messages
      WHERE tenant_id = ${TENANT_A} AND template_key = 'derived.commerce_campaign'
    `
    )) as { template_key: string; subject: string; to_address: string }[];
    expect(emailMessages.length).toBe(2);
    expect(
      emailMessages.every((m) => m.subject === "Hello Campaign Shopper")
    ).toBe(true);
    expect(
      emailMessages.some((m) => m.to_address === "6281300000012@example.test")
    ).toBe(false);

    const whatsappMessages = (await inTenant(
      TENANT_A,
      (tx) => tx`
      SELECT template_key, body_rendered, to_phone FROM awcms_commerce_whatsapp_messages
      WHERE tenant_id = ${TENANT_A} AND template_key = 'commerce.campaign'
    `
    )) as { template_key: string; body_rendered: string; to_phone: string }[];
    expect(whatsappMessages.length).toBe(2);
    expect(
      whatsappMessages.every((m) =>
        m.body_rendered.includes("Hi Campaign Shopper, check out")
      )
    ).toBe(true);
    expect(whatsappMessages.some((m) => m.to_phone === "+6281300000012")).toBe(
      false
    );
  }, 30000);

  test("cancel stops further dispatch — a cancelled campaign is never fanned out", async () => {
    await seedAccount(TENANT_A, "+6281300000020", true);
    await seedAccount(TENANT_A, "+6281300000021", true);

    const campaign = await inTenant(TENANT_A, (tx) =>
      createCampaign(
        tx,
        TENANT_A,
        ACTOR_ID,
        {
          channel: "email",
          audience: { levels: [], hasAccount: null, lastOrderSince: null },
          subject: "Sale",
          body: "Big sale, {{name}}!"
        },
        "cancel-test-create"
      )
    );

    await inTenant(
      TENANT_A,
      (tx) => tx`
      UPDATE awcms_commerce_campaigns
      SET status = 'scheduled', scheduled_at = now()
      WHERE tenant_id = ${TENANT_A} AND id = ${campaign.id}
    `
    );

    // Cancel BEFORE the dispatcher ever claims it.
    const cancelOutcome = await inTenant(TENANT_A, (tx) =>
      cancelCampaign(tx, TENANT_A, ACTOR_ID, campaign.id, "cancel-test-cancel")
    );
    expect(cancelOutcome.kind).toBe("cancelled");

    const runtimeSql = getRuntimeSql();
    const result = await dispatchCampaignQueue(runtimeSql, TENANT_A, {
      correlationId: "cancel-test-dispatch"
    });

    // A `cancelled` campaign is not `scheduled`/`sending`, so the CLAIM
    // query never selects it at all — zero further pages, exactly the
    // contract's own words.
    expect(result.claimed).toBe(0);
    expect(result.recipientsEnqueued).toBe(0);

    const after = await inTenant(TENANT_A, (tx) =>
      fetchCampaign(tx, TENANT_A, campaign.id)
    );
    expect(after?.status).toBe("cancelled");

    const recipients = (await inTenant(
      TENANT_A,
      (tx) => tx`
      SELECT count(*)::int AS total FROM awcms_commerce_campaign_recipients
      WHERE tenant_id = ${TENANT_A} AND campaign_id = ${campaign.id}
    `
    )) as { total: number }[];
    expect(recipients[0]?.total).toBe(0);

    const emailMessages = (await inTenant(
      TENANT_A,
      (tx) => tx`
      SELECT count(*)::int AS total FROM awcms_email_messages
      WHERE tenant_id = ${TENANT_A} AND template_key = 'derived.commerce_campaign'
    `
    )) as { total: number }[];
    expect(emailMessages[0]?.total).toBe(0);
  }, 30000);

  test("a campaign already resumed into 'sending' (simulating a crash-recovered run) still dispatches its remaining, not-yet-recorded recipients", async () => {
    const first = await seedAccount(TENANT_A, "+6281300000040", true);
    const second = await seedAccount(TENANT_A, "+6281300000041", true);

    const campaign = await inTenant(TENANT_A, (tx) =>
      createCampaign(
        tx,
        TENANT_A,
        ACTOR_ID,
        {
          channel: "email",
          audience: { levels: [], hasAccount: null, lastOrderSince: null },
          subject: "Resume test",
          body: "Hi {{name}}"
        },
        "resume-create"
      )
    );

    // Simulate a PRIOR partial run: campaign already `sending`, and one of
    // the two consented customers already has a recipient row (as if an
    // earlier page committed before the process crashed).
    await inTenant(
      TENANT_A,
      (tx) => tx`
      UPDATE awcms_commerce_campaigns
      SET status = 'sending', scheduled_at = now()
      WHERE tenant_id = ${TENANT_A} AND id = ${campaign.id}
    `
    );
    await inTenant(
      TENANT_A,
      (tx) => tx`
      INSERT INTO awcms_commerce_campaign_recipients
        (tenant_id, campaign_id, customer_id, address_masked, status)
      VALUES (${TENANT_A}, ${campaign.id}, ${first.customerId}, 'ma***@example.test', 'enqueued')
    `
    );

    const runtimeSql = getRuntimeSql();
    const result = await dispatchCampaignQueue(runtimeSql, TENANT_A, {
      correlationId: "resume-dispatch"
    });

    // The already-recorded customer is never re-selected (`NOT EXISTS` in
    // `resolveCampaignAudiencePage`); only the second one is newly enqueued.
    expect(result.claimed).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.recipientsEnqueued).toBe(1);

    const recipients = (await inTenant(
      TENANT_A,
      (tx) => tx`
      SELECT customer_id FROM awcms_commerce_campaign_recipients
      WHERE tenant_id = ${TENANT_A} AND campaign_id = ${campaign.id}
      ORDER BY created_at ASC
    `
    )) as { customer_id: string }[];
    expect(recipients.length).toBe(2);
    expect(recipients.map((r) => r.customer_id).sort()).toEqual(
      [first.customerId, second.customerId].sort()
    );

    const after = await inTenant(TENANT_A, (tx) =>
      fetchCampaign(tx, TENANT_A, campaign.id)
    );
    expect(after?.status).toBe("sent");
    expect(after?.recipientCount).toBe(2);
  }, 30000);
});
