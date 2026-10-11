/**
 * A campaign whose audience is a CRM segment (Issue #362, ADR-0042 Amendment;
 * PRD S3/S4; threat model C-12, C-28, C-29).
 *
 * ## What is and is not new
 *
 * The campaign still resolves its audience page by page, resumably, in the
 * existing dispatcher (`campaign-dispatch.ts`): a page is "the next 200
 * messageable customers not yet recorded in
 * `awcms_commerce_campaign_recipients`", and that table is the only list of
 * people that exists. This file only supplies a SECOND page resolver for the
 * case where the campaign names a segment; it creates no membership table and
 * copies no customer row. The rule is evaluated by the segment evaluator
 * (`segment-evaluator.ts` / `segment-sql.ts`) under the same bounds as any
 * segment preview (concurrency slots, statement timeout), with the campaign's
 * reach (consent, active account, channel address, not already a recipient)
 * appended in the same statement - so it can only ever REMOVE people from the
 * segment, never add one.
 *
 * ## Consent is independent of membership (C-12, C-28)
 *
 * - at ENQUEUE (the send call and every dispatch page that inserts recipient
 *   rows and outbox rows): the page query joins the customer's own account and
 *   requires `marketing_consent_at IS NOT NULL`; an opted-out member of the
 *   segment is never selected, so it never gets a recipient row or an outbox
 *   row. The count shown before sending uses the same predicate.
 * - at DISPATCH: the dispatcher re-evaluates every page at the moment it runs,
 *   not once at send time, so a customer who withdraws consent between the
 *   send call and the page that would have reached them is not messaged. The
 *   e-mail / WhatsApp outbox dispatchers then send what was enqueued, exactly
 *   as for every other campaign.
 * - eligibility exclusions (the walk-in placeholder, blocked and erased
 *   customers) are applied by the evaluator before the rule, so a `NOT` rule
 *   cannot resurrect them.
 *
 * ## The as-of and the version (C-29)
 *
 * The campaign is pinned to a segment VERSION when the draft is saved. The
 * as-of instant is chosen by the server when the dispatcher first claims the
 * campaign and then kept (`segment_as_of`), so every page of one send, however
 * many ticks it takes, is evaluated against the same instant.
 *
 * ## Fail closed
 *
 * A page whose evaluation is `busy` or `too_expensive`, whose segment cannot be
 * resolved, or whose tenant has switched the feature off, enqueues NOTHING and
 * is reported as `deferred`; the campaign stays `sending` and the next tick
 * tries again. It is never treated as "audience exhausted", so a refusal can
 * not mark a campaign `sent`.
 */
import { fail } from "../../_shared/api-response";
import type { CampaignChannel } from "../domain/campaign-validation";
import type { CommerceFeatures } from "../domain/commerce-features";
import { suppressSmallCount, type SegmentCount } from "../domain/segment-rules";
import { fetchCommerceFeatures } from "./commerce-feature-gate";
import { resolveSegmentRules } from "./segment-directory";
import { runBoundedEvaluation } from "./segment-evaluator";
import {
  countSegmentCampaignAudience,
  selectSegmentCampaignAudiencePage,
  type CampaignAudienceRow
} from "./segment-sql";

/** The segment version a campaign is pinned to, with the as-of once the dispatcher has claimed it. */
export type CampaignSegmentPin = {
  segmentId: string;
  version: number;
  asOf: string | null;
};

// ---------------------------------------------------------------------------
// Feature gate
// ---------------------------------------------------------------------------

/** A segment audience needs campaigns, segments AND the dedicated flag; this names the first one that is off. */
export function firstDisabledSegmentAudienceFeature(
  features: CommerceFeatures
): "campaigns" | "segments" | "campaignSegmentAudience" | null {
  if (!features.campaigns) return "campaigns";
  if (!features.segments) return "segments";
  if (!features.campaignSegmentAudience) return "campaignSegmentAudience";
  return null;
}

/** `409 FEATURE_DISABLED` while any of the three flags is off, else `null`. */
export async function requireCampaignSegmentAudienceFeature(
  tx: Bun.SQL,
  tenantId: string
): Promise<Response | null> {
  const features = await fetchCommerceFeatures(tx, tenantId);
  const disabled = firstDisabledSegmentAudienceFeature(features);
  if (disabled === null) return null;
  return fail(
    409,
    "FEATURE_DISABLED",
    `The "${disabled}" feature is disabled for this tenant, so a campaign cannot use a segment audience.`
  );
}

// ---------------------------------------------------------------------------
// Pinning a segment version to a draft
// ---------------------------------------------------------------------------

export type ResolvePinOutcome =
  | { kind: "ok"; pin: CampaignSegmentPin }
  | { kind: "not_found" }
  | { kind: "retired" };

/**
 * Looks the requested segment up under the caller's tenant (RLS plus an
 * explicit predicate) and pins the requested version, or the latest when none
 * was named. A retired segment cannot be NEWLY chosen (its versions stay
 * readable for the campaigns that already used them). An unknown id, another
 * tenant's id and an unknown version are the same `not_found`.
 */
export async function resolveCampaignSegmentPin(
  tx: Bun.SQL,
  tenantId: string,
  request: { segmentId: string; segmentVersion: number | null }
): Promise<ResolvePinOutcome> {
  const heads = (await tx`
    SELECT latest_version, retired_at
    FROM awcms_commerce_segments
    WHERE tenant_id = ${tenantId} AND id = ${request.segmentId}
  `) as { latest_version: number; retired_at: Date | null }[];
  const head = heads[0];
  if (!head) return { kind: "not_found" };
  if (head.retired_at !== null) return { kind: "retired" };

  const version = request.segmentVersion ?? Number(head.latest_version);
  const resolved = await resolveSegmentRules(
    tx,
    tenantId,
    request.segmentId,
    version
  );
  if (!resolved) return { kind: "not_found" };
  return {
    kind: "ok",
    pin: {
      segmentId: resolved.segmentId,
      version: resolved.version,
      asOf: null
    }
  };
}

export type CampaignSegmentState = {
  channel: CampaignChannel;
  status: string;
  pin: CampaignSegmentPin | null;
};

/** The pin of a campaign (null pin for a legacy-audience campaign); null for an unknown or foreign campaign. */
export async function fetchCampaignSegmentState(
  tx: Bun.SQL,
  tenantId: string,
  campaignId: string
): Promise<CampaignSegmentState | null> {
  const rows = (await tx`
    SELECT channel, status, segment_id, segment_version, segment_as_of
    FROM awcms_commerce_campaigns
    WHERE tenant_id = ${tenantId} AND id = ${campaignId} AND deleted_at IS NULL
  `) as {
    channel: CampaignChannel;
    status: string;
    segment_id: string | null;
    segment_version: number | null;
    segment_as_of: Date | null;
  }[];
  const row = rows[0];
  if (!row) return null;
  return {
    channel: row.channel,
    status: row.status,
    pin:
      row.segment_id !== null && row.segment_version !== null
        ? {
            segmentId: row.segment_id,
            version: Number(row.segment_version),
            asOf: row.segment_as_of?.toISOString() ?? null
          }
        : null
  };
}

// ---------------------------------------------------------------------------
// Counting (preview and the send-time check)
// ---------------------------------------------------------------------------

export type SegmentAudienceCountOutcome =
  | { kind: "ok"; count: SegmentCount; asOf: string }
  | { kind: "busy" }
  | { kind: "too_expensive" }
  | { kind: "segment_missing" };

/**
 * How many members of the pinned segment version the campaign may message
 * right now: the segment, minus everyone without consent, an active account or
 * an address on the channel. Bounded like any segment evaluation. The count is
 * small-group suppressed (C-27): a campaign reader must not be able to
 * difference a narrow segment into a person any more than a segment reader.
 */
export async function countCampaignSegmentAudience(
  tx: Bun.SQL,
  context: { tenantId: string; actorTenantUserId: string; now: Date },
  pin: CampaignSegmentPin,
  channel: CampaignChannel
): Promise<SegmentAudienceCountOutcome> {
  const resolved = await resolveSegmentRules(
    tx,
    context.tenantId,
    pin.segmentId,
    pin.version
  );
  if (!resolved) return { kind: "segment_missing" };

  const outcome = await runBoundedEvaluation(tx, context, (db, asOf) =>
    countSegmentCampaignAudience(
      db,
      {
        tenantId: context.tenantId,
        node: resolved.node,
        stats: resolved.stats,
        asOf
      },
      channel
    )
  );
  if (outcome.kind !== "ok") return outcome;
  return {
    kind: "ok",
    count: suppressSmallCount(outcome.value),
    asOf: outcome.asOf
  };
}

// ---------------------------------------------------------------------------
// The dispatcher's page resolver
// ---------------------------------------------------------------------------

export type SegmentAudiencePage =
  | { kind: "page"; rows: CampaignAudienceRow[] }
  | { kind: "deferred"; reason: DeferralReason };

export type DeferralReason =
  "feature_disabled" | "segment_missing" | "busy" | "too_expensive";

/**
 * One page of the campaign's segment audience, evaluated at the campaign's
 * recorded as-of. `rows` is empty only when the audience is genuinely drained;
 * every refusal is a `deferred`, which the dispatcher must not read as "done".
 */
export async function resolveSegmentAudiencePage(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    campaignId: string;
    channel: CampaignChannel;
    pin: CampaignSegmentPin & { asOf: string };
    pageSize: number;
  }
): Promise<SegmentAudiencePage> {
  const features = await fetchCommerceFeatures(tx, input.tenantId);
  if (firstDisabledSegmentAudienceFeature(features) !== null) {
    return { kind: "deferred", reason: "feature_disabled" };
  }
  const resolved = await resolveSegmentRules(
    tx,
    input.tenantId,
    input.pin.segmentId,
    input.pin.version
  );
  if (!resolved) return { kind: "deferred", reason: "segment_missing" };

  const outcome = await runBoundedEvaluation(
    tx,
    {
      tenantId: input.tenantId,
      // The concurrency slot is per actor; a campaign has none, so it takes a
      // slot of its own and cannot starve a person's previews (or the reverse).
      actorTenantUserId: `campaign:${input.campaignId}`,
      now: new Date(input.pin.asOf)
    },
    (db, asOf) =>
      selectSegmentCampaignAudiencePage(
        db,
        {
          tenantId: input.tenantId,
          node: resolved.node,
          stats: resolved.stats,
          asOf
        },
        { channel: input.channel, campaignId: input.campaignId },
        input.pageSize
      )
  );
  if (outcome.kind === "busy") return { kind: "deferred", reason: "busy" };
  if (outcome.kind === "too_expensive") {
    return { kind: "deferred", reason: "too_expensive" };
  }
  return { kind: "page", rows: outcome.value };
}
