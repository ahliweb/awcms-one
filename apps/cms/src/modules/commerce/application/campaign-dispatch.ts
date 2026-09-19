/**
 * `commerce:campaigns:dispatch` (Issue #114, contract #106/ADR-0017 D9) —
 * NOT a public HTTP endpoint, invoked by
 * `scripts/commerce-campaigns-dispatch.ts`, one tenant at a time. Fans a
 * `scheduled`/`sending` campaign out into the SAME e-mail/WhatsApp outboxes
 * D5/D7 already dispatch from — no third delivery mechanism, no separate
 * rate-limit story (ADR-0017 D9's own words).
 *
 * ## Three phases, all pure database work (no provider call happens here —
 * ADR-0006 — this file only ever INSERTs into `awcms_email_messages`/
 * `awcms_commerce_whatsapp_messages`; `email-dispatch.ts`/
 * `whatsapp-dispatch.ts` send from there, later, on their own tick)
 *
 * 1. **CLAIM** — one short transaction: `FOR UPDATE SKIP LOCKED` over every
 *    campaign that is either due (`status = 'scheduled' AND scheduled_at <=
 *    now()`) or already `sending` (a previous run crashed mid-dispatch), so
 *    two concurrent dispatcher processes never grab the same campaign.
 *    `scheduled` rows are flipped to `sending` in the same statement — that
 *    flip IS the durable claim; unlike the WhatsApp/email dispatchers there
 *    is no lease/expiry here, because everything from here on is pure SQL
 *    with no external round trip that could hang.
 * 2. **PAGE** — for each claimed campaign, loop: re-read its live `status`
 *    (a `cancel` call between pages must stop further pages — the
 *    contract's own words); if `cancelled`, stop without marking `sent`.
 *    Otherwise resolve one page (`CAMPAIGN_AUDIENCE_PAGE_SIZE`, currently
 *    200) of not-yet-recorded, consented, addressable customers
 *    (`resolveCampaignAudiencePage` — see that function's header for why
 *    this alone makes the loop resumable), insert one
 *    `awcms_commerce_campaign_recipients` row per customer (`UNIQUE
 *    (campaign_id, customer_id)`, `ON CONFLICT DO NOTHING` — belt-and-
 *    suspenders alongside the resolver's own `NOT EXISTS`), then enqueue
 *    into the e-mail or WhatsApp outbox and flip that recipient row to
 *    `enqueued` (or `skipped` if the outbox refused it, e.g. a suppressed
 *    e-mail address). An empty page ends the loop.
 * 3. **FINALIZE** — once a campaign's loop ends without cancellation, mark
 *    it `sent` with `sent_at = now()` and `recipient_count` = the total
 *    recipient row count.
 *
 * `MAX_PAGES_PER_CAMPAIGN_PER_RUN` bounds a single script invocation's work
 * per campaign so one huge audience cannot starve every OTHER tenant's
 * dispatch tick — a partially-drained campaign is simply picked up again
 * (as `sending`) on the next tick, same resumability the header above
 * already establishes.
 */
import { withTenantOrThrow } from "../../../lib/database/tenant-context";
import { log } from "../../../lib/logging/logger";
import { enqueueDirectAddressEmail } from "../../email/application/direct-address-notification";
import {
  fetchActiveEmailTemplateByKey,
  seedDefaultEmailTemplates
} from "../../email/application/email-template-directory";
import { registerDerivedEmailTemplateCategory } from "../../email/domain/email-template-categories";
import type { DefaultEmailTemplate } from "../../email/domain/email-default-templates";
import { maskIdentifierValue } from "../../profile-identity/domain/identifier";
import { renderCampaignText } from "../domain/campaign-content";
import { maskPhone } from "../domain/phone-normalisation";
import type {
  CampaignAudience,
  CampaignChannel
} from "../domain/campaign-validation";
import {
  resolveCampaignAudiencePage,
  CAMPAIGN_AUDIENCE_PAGE_SIZE
} from "./campaign-directory";
import { enqueueWhatsappMessage } from "./whatsapp-enqueue";

const MODULE_KEY = "commerce";
const MAX_PAGES_PER_CAMPAIGN_PER_RUN = 25;
const MAX_CAMPAIGNS_PER_TENANT_PER_RUN = 5;

// ---------------------------------------------------------------------------
// The `derived.commerce_campaign` e-mail template — a pure PASS-THROUGH
// shell (subject/body ARE the two allowed variables), because a campaign's
// content is user-authored per campaign, not reusable copy. Same
// auto-seed-on-first-miss shape `conversation-directory.ts`'s
// `ensureConversationReplyTemplate` already established for this module —
// `commerce` never writes `awcms_email_templates` directly (a module may
// not write another module's table, `modules:table-writes:check`); it
// calls `email`'s own exported seed/enqueue functions, which do the write.
// ---------------------------------------------------------------------------

export const CAMPAIGN_EMAIL_TEMPLATE_KEY = "derived.commerce_campaign";
export const CAMPAIGN_EMAIL_TEMPLATE_VARIABLES = ["subject", "body"] as const;

registerDerivedEmailTemplateCategory(
  CAMPAIGN_EMAIL_TEMPLATE_KEY,
  CAMPAIGN_EMAIL_TEMPLATE_VARIABLES
);

const CAMPAIGN_EMAIL_DEFAULT_TEMPLATE = {
  name: "Customer campaign",
  subject: { en: "{{subject}}", id: "{{subject}}" },
  textBody: { en: "{{body}}", id: "{{body}}" }
} as const;

const SEED_ACTOR_ID = "00000000-0000-0000-0000-000000000000";

async function ensureCampaignEmailTemplate(
  tx: Bun.SQL,
  tenantId: string
): Promise<boolean> {
  const existing = await fetchActiveEmailTemplateByKey(
    tx,
    tenantId,
    CAMPAIGN_EMAIL_TEMPLATE_KEY
  );
  if (existing) return true;

  const template: DefaultEmailTemplate = {
    templateKey: CAMPAIGN_EMAIL_TEMPLATE_KEY,
    name: CAMPAIGN_EMAIL_DEFAULT_TEMPLATE.name,
    subjectTemplate: { ...CAMPAIGN_EMAIL_DEFAULT_TEMPLATE.subject },
    textBodyTemplate: { ...CAMPAIGN_EMAIL_DEFAULT_TEMPLATE.textBody }
  };
  await seedDefaultEmailTemplates(tx, tenantId, SEED_ACTOR_ID, [template]);

  return (
    (await fetchActiveEmailTemplateByKey(
      tx,
      tenantId,
      CAMPAIGN_EMAIL_TEMPLATE_KEY
    )) !== null
  );
}

async function tenantStoreName(tx: Bun.SQL, tenantId: string): Promise<string> {
  const rows = (await tx`
    SELECT tenant_name FROM awcms_tenants WHERE id = ${tenantId}
  `) as { tenant_name: string | null }[];
  return rows[0]?.tenant_name ?? "Our store";
}

type ClaimedCampaignRow = {
  id: string;
  channel: CampaignChannel;
  audience: CampaignAudience;
  subject: string | null;
  body: string;
};

/** CLAIM phase — see this file's header. */
async function claimDueCampaigns(
  sql: Bun.SQL,
  tenantId: string,
  limit: number
): Promise<ClaimedCampaignRow[]> {
  return withTenantOrThrow(
    sql,
    tenantId,
    async (tx) => {
      const rows = await tx`
        UPDATE awcms_commerce_campaigns
        SET status = 'sending', updated_at = now()
        WHERE id IN (
          SELECT id FROM awcms_commerce_campaigns
          WHERE tenant_id = ${tenantId}
            AND deleted_at IS NULL
            AND (
              (status = 'scheduled' AND scheduled_at <= now())
              OR status = 'sending'
            )
          ORDER BY scheduled_at NULLS LAST, created_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        AND status IN ('scheduled', 'sending')
        RETURNING id, channel, audience, subject, body
      `;
      return rows as unknown as ClaimedCampaignRow[];
    },
    { workClass: "background_sync" }
  );
}

async function currentCampaignStatus(
  sql: Bun.SQL,
  tenantId: string,
  campaignId: string
): Promise<string | null> {
  return withTenantOrThrow(
    sql,
    tenantId,
    async (tx) => {
      const rows = (await tx`
        SELECT status FROM awcms_commerce_campaigns
        WHERE tenant_id = ${tenantId} AND id = ${campaignId}
      `) as { status: string }[];
      return rows[0]?.status ?? null;
    },
    { workClass: "background_sync" }
  );
}

type DispatchPageResult = {
  inserted: number;
  enqueued: number;
  skipped: number;
};

/** PAGE phase — one page, in one short transaction (recipient insert + outbox enqueue happen together, same "never let an insert outlive its own enqueue" discipline `conversation-directory.ts`'s reply path already follows). */
async function dispatchOnePage(
  sql: Bun.SQL,
  tenantId: string,
  campaign: ClaimedCampaignRow,
  correlationId: string
): Promise<DispatchPageResult> {
  return withTenantOrThrow(
    sql,
    tenantId,
    async (tx) => {
      const page = await resolveCampaignAudiencePage(
        tx,
        tenantId,
        campaign.id,
        campaign.channel,
        campaign.audience,
        CAMPAIGN_AUDIENCE_PAGE_SIZE
      );
      if (page.length === 0) return { inserted: 0, enqueued: 0, skipped: 0 };

      const storeName = await tenantStoreName(tx, tenantId);
      let enqueuedCount = 0;
      let skippedCount = 0;

      for (const recipient of page) {
        const renderedSubject = campaign.subject
          ? renderCampaignText(campaign.subject, {
              name: recipient.name,
              storeName
            })
          : null;
        const renderedBody = renderCampaignText(campaign.body, {
          name: recipient.name,
          storeName
        });

        let addressMasked: string;
        let enqueued = false;

        if (campaign.channel === "email") {
          const email = recipient.email;
          addressMasked = email ? maskIdentifierValue(email, "email") : "";
          if (email) {
            let result = await enqueueDirectAddressEmail(
              tx,
              tenantId,
              CAMPAIGN_EMAIL_TEMPLATE_KEY,
              email,
              { subject: renderedSubject ?? "", body: renderedBody },
              correlationId
            );
            if (!result.enqueued) {
              const seeded = await ensureCampaignEmailTemplate(tx, tenantId);
              if (seeded) {
                result = await enqueueDirectAddressEmail(
                  tx,
                  tenantId,
                  CAMPAIGN_EMAIL_TEMPLATE_KEY,
                  email,
                  { subject: renderedSubject ?? "", body: renderedBody },
                  correlationId
                );
              }
            }
            enqueued = result.enqueued;
          }
        } else {
          addressMasked = maskPhone(recipient.phone);
          if (recipient.phone) {
            await enqueueWhatsappMessage(tx, {
              tenantId,
              toPhone: recipient.phone,
              templateKey: "commerce.campaign",
              variables: { body: renderedBody, storeName },
              correlationId
            });
            enqueued = true;
          }
        }

        const rows = (await tx`
          INSERT INTO awcms_commerce_campaign_recipients (
            tenant_id, campaign_id, customer_id, address_masked, status
          )
          VALUES (
            ${tenantId}, ${campaign.id}, ${recipient.customer_id},
            ${addressMasked}, ${enqueued ? "enqueued" : "skipped"}
          )
          ON CONFLICT (campaign_id, customer_id) DO NOTHING
          RETURNING id
        `) as { id: string }[];

        if (rows.length > 0) {
          if (enqueued) enqueuedCount += 1;
          else skippedCount += 1;
        }
      }

      return {
        inserted: page.length,
        enqueued: enqueuedCount,
        skipped: skippedCount
      };
    },
    { workClass: "background_sync" }
  );
}

async function finalizeSent(
  sql: Bun.SQL,
  tenantId: string,
  campaignId: string
): Promise<void> {
  await withTenantOrThrow(
    sql,
    tenantId,
    (tx) => tx`
      UPDATE awcms_commerce_campaigns
      SET status = 'sent', sent_at = now(), updated_at = now(),
          recipient_count = (
            SELECT count(*)::int FROM awcms_commerce_campaign_recipients
            WHERE tenant_id = ${tenantId} AND campaign_id = ${campaignId}
          )
      WHERE tenant_id = ${tenantId} AND id = ${campaignId} AND status = 'sending'
    `,
    { workClass: "background_sync" }
  );
}

export type DispatchCampaignQueueResult = {
  claimed: number;
  pagesProcessed: number;
  recipientsEnqueued: number;
  recipientsSkipped: number;
  sent: number;
  cancelledMidFlight: number;
};

/** Dispatches every due/resumed campaign for one tenant. Safe to call repeatedly. */
export async function dispatchCampaignQueue(
  sql: Bun.SQL,
  tenantId: string,
  options: { correlationId?: string } = {}
): Promise<DispatchCampaignQueueResult> {
  const correlationId = options.correlationId ?? crypto.randomUUID();
  const result: DispatchCampaignQueueResult = {
    claimed: 0,
    pagesProcessed: 0,
    recipientsEnqueued: 0,
    recipientsSkipped: 0,
    sent: 0,
    cancelledMidFlight: 0
  };

  const claimed = await claimDueCampaigns(
    sql,
    tenantId,
    MAX_CAMPAIGNS_PER_TENANT_PER_RUN
  );
  result.claimed = claimed.length;
  if (claimed.length === 0) return result;

  log("info", "commerce.campaigns.dispatch.claimed", {
    correlationId,
    tenantId,
    moduleKey: MODULE_KEY,
    count: claimed.length
  });

  for (const campaign of claimed) {
    let cancelled = false;
    let exhausted = false;

    for (let page = 0; page < MAX_PAGES_PER_CAMPAIGN_PER_RUN; page += 1) {
      const status = await currentCampaignStatus(sql, tenantId, campaign.id);
      if (status === "cancelled") {
        cancelled = true;
        break;
      }
      if (status !== "sending") break;

      const pageResult = await dispatchOnePage(
        sql,
        tenantId,
        campaign,
        correlationId
      );
      result.pagesProcessed += 1;
      result.recipientsEnqueued += pageResult.enqueued;
      result.recipientsSkipped += pageResult.skipped;

      if (pageResult.inserted === 0) {
        exhausted = true;
        break;
      }
    }

    if (cancelled) {
      result.cancelledMidFlight += 1;
      log("info", "commerce.campaigns.dispatch.cancelled_mid_flight", {
        correlationId,
        tenantId,
        moduleKey: MODULE_KEY,
        campaignId: campaign.id
      });
      continue;
    }

    // `exhausted` (a page came back empty) is the ONLY signal the audience
    // is fully drained — hitting `MAX_PAGES_PER_CAMPAIGN_PER_RUN` leaves the
    // campaign `sending` on purpose, so the NEXT tick's claim (this file's
    // header) resumes it rather than prematurely marking a large campaign
    // `sent` while recipients remain unprocessed.
    if (exhausted) {
      await finalizeSent(sql, tenantId, campaign.id);
      result.sent += 1;
      log("info", "commerce.campaigns.dispatch.sent", {
        correlationId,
        tenantId,
        moduleKey: MODULE_KEY,
        campaignId: campaign.id
      });
    }
  }

  return result;
}
