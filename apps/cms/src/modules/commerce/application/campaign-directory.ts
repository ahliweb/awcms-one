/**
 * `awcms_commerce_campaigns` / `awcms_commerce_campaign_recipients`
 * persistence (Issue #114, contract #106 ADR-0017 D9) — CRUD, audience
 * preview (count only, never a resolved list — `awcms-sensitive-data`'s
 * anti-enumeration posture, matching the OpenAPI's own `recipientCount`-only
 * response), `send` (moves a campaign to `scheduled`/`sending` and inserts
 * one recipient row per resolved address — actual outbox fan-out happens
 * later, in `application/campaign-dispatch.ts`), and `cancel`.
 *
 * ## Consent is load-bearing (ADR-0017 D9)
 *
 * `resolveCampaignAudiencePage`/`countCampaignAudience` below are the ONLY
 * two places a campaign's audience is ever resolved, and both share one
 * SQL builder (`buildAudienceQueryParts`): the consent predicate
 * (`a.marketing_consent_at IS NOT NULL`) and the channel-address predicate
 * are baked into the WHERE clause itself, not filtered afterwards — an
 * account that never opted in (or has no account at all — consent only
 * ever exists on `awcms_commerce_customer_accounts`) is structurally
 * unreachable, never merely skipped by convention. `audience.hasAccount:
 * false` is honoured literally: since consent requires an account, that
 * combination is defined to resolve to an EMPTY set, not an error.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  utcMicrosecondTextSql,
  type KeysetCursor
} from "../../_shared/keyset-pagination";
import { suppressSmallCount } from "../domain/segment-rules";
import type {
  CampaignAudience,
  CampaignChannel,
  CampaignStatus,
  CreateCampaignInput,
  UpdateCampaignInput
} from "../domain/campaign-validation";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "campaign";

export const CAMPAIGN_LIST_DEFAULT_LIMIT = 20;
export const CAMPAIGN_LIST_MAX_LIMIT = 50;
export const CAMPAIGN_AUDIENCE_PAGE_SIZE = 200;

export { decodeKeysetCursor };

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

type CampaignRow = {
  id: string;
  channel: CampaignChannel;
  audience: CampaignAudience;
  subject: string | null;
  body: string;
  status: CampaignStatus;
  scheduled_at: Date | null;
  sent_at: Date | null;
  recipient_count: number | null;
  created_at: Date;
  segment_id: string | null;
  segment_version: number | null;
  segment_as_of: Date | null;
};

/** Issue #362: the segment version a campaign targets and the as-of it was evaluated at (null until the dispatcher first claims it). */
export type CampaignSegmentRecord = {
  id: string;
  version: number;
  asOf: string | null;
};

export type CampaignRecord = {
  id: string;
  channel: CampaignChannel;
  audience: CampaignAudience;
  subject: string | null;
  body: string;
  status: CampaignStatus;
  recipientCount: number | null;
  sentCount: number | null;
  /** Issue #362: true when a count under five is withheld (segment campaigns only, C-27); the count is then null. */
  countsSuppressed: boolean;
  /** Issue #362: null for a campaign using the legacy audience filters. */
  segment: CampaignSegmentRecord | null;
  createdAt: string;
};

async function toRecord(
  tx: Bun.SQL,
  tenantId: string,
  row: CampaignRow
): Promise<CampaignRecord> {
  let sentCount: number | null = null;
  if (row.status === "sending" || row.status === "sent") {
    const rows = (await tx`
      SELECT count(*)::int AS sent_count
      FROM awcms_commerce_campaign_recipients
      WHERE tenant_id = ${tenantId} AND campaign_id = ${row.id}
        AND status = 'enqueued'
    `) as { sent_count: number }[];
    sentCount = rows[0]?.sent_count ?? 0;
  }
  // Issue #362 (C-27): a segment campaign's counts are the size of a segment,
  // so a small one is withheld exactly as the segment's own preview does it.
  // A legacy campaign's counts are untouched.
  const isSegment = row.segment_id !== null;
  const hide = (count: number | null): boolean =>
    isSegment && count !== null && suppressSmallCount(count).suppressed;
  const suppressed = hide(row.recipient_count) || hide(sentCount);
  return {
    id: row.id,
    channel: row.channel,
    audience: row.audience,
    subject: row.subject,
    body: row.body,
    status: row.status,
    recipientCount: hide(row.recipient_count) ? null : row.recipient_count,
    sentCount: hide(sentCount) ? null : sentCount,
    countsSuppressed: suppressed,
    segment:
      row.segment_id !== null && row.segment_version !== null
        ? {
            id: row.segment_id,
            version: Number(row.segment_version),
            asOf: row.segment_as_of?.toISOString() ?? null
          }
        : null,
    createdAt: row.created_at.toISOString()
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export type CampaignListPage = {
  items: CampaignRecord[];
  nextCursor: string | null;
};

/** `GET /api/v1/commerce/campaigns?cursor=` — newest-created-first. */
export async function listCampaigns(
  tx: Bun.SQL,
  tenantId: string,
  cursor: KeysetCursor | null,
  limit: number = CAMPAIGN_LIST_DEFAULT_LIMIT
): Promise<CampaignListPage> {
  const boundedLimit = Math.min(
    Math.max(1, Math.trunc(limit)),
    CAMPAIGN_LIST_MAX_LIMIT
  );
  const cursorSortValue = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;

  const rows = (await tx`
    SELECT id, channel, audience, subject, body, status, scheduled_at,
           sent_at, recipient_count, created_at,
           segment_id, segment_version, segment_as_of,
           ${tx.unsafe(utcMicrosecondTextSql("created_at"))} AS sort_cursor
    FROM awcms_commerce_campaigns
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
      AND (
        ${cursorSortValue}::timestamptz IS NULL
        OR (created_at, id) < (${cursorSortValue}, ${cursorId})
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${boundedLimit}
  `) as (CampaignRow & { sort_cursor: string })[];

  const items: CampaignRecord[] = [];
  for (const row of rows) items.push(await toRecord(tx, tenantId, row));

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === boundedLimit && last
      ? encodeKeysetCursor(last.sort_cursor, last.id)
      : null;

  return { items, nextCursor };
}

/** `GET /api/v1/commerce/campaigns/{id}` — `null` for an unknown/other-tenant/deleted campaign. */
export async function fetchCampaign(
  tx: Bun.SQL,
  tenantId: string,
  campaignId: string
): Promise<CampaignRecord | null> {
  const rows = (await tx`
    SELECT id, channel, audience, subject, body, status, scheduled_at,
           sent_at, recipient_count, created_at,
           segment_id, segment_version, segment_as_of
    FROM awcms_commerce_campaigns
    WHERE tenant_id = ${tenantId} AND id = ${campaignId} AND deleted_at IS NULL
  `) as CampaignRow[];
  if (rows.length === 0) return null;
  return toRecord(tx, tenantId, rows[0]!);
}

/** `POST /api/v1/commerce/campaigns` — always created as `draft`. */
export async function createCampaign(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateCampaignInput,
  correlationId?: string,
  /** Issue #362: the already-resolved segment pin, or omitted/null for a legacy-audience campaign. */
  segmentPin: { segmentId: string; version: number } | null = null
): Promise<CampaignRecord> {
  const rows = (await tx`
    INSERT INTO awcms_commerce_campaigns (
      tenant_id, channel, subject, body, audience, status, created_by,
      segment_id, segment_version
    )
    VALUES (
      ${tenantId}, ${input.channel}, ${input.subject}, ${input.body},
      ${input.audience}::jsonb, 'draft', ${actorTenantUserId},
      ${segmentPin?.segmentId ?? null}::uuid, ${segmentPin?.version ?? null}::int
    )
    RETURNING id, channel, audience, subject, body, status, scheduled_at,
              sent_at, recipient_count, created_at,
              segment_id, segment_version, segment_as_of
  `) as CampaignRow[];
  const row = rows[0]!;

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "create",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: row.id,
    message: "Campaign created.",
    attributes: {
      actorTenantUserId,
      channel: input.channel,
      ...(segmentPin
        ? {
            segmentId: segmentPin.segmentId,
            segmentVersion: segmentPin.version
          }
        : {})
    },
    correlationId
  });

  return toRecord(tx, tenantId, row);
}

export type UpdateCampaignOutcome =
  | { kind: "not_found" }
  | { kind: "not_editable" }
  | { kind: "updated"; campaign: CampaignRecord };

/** `PATCH /api/v1/commerce/campaigns/{id}` — editable only while `draft` (`409 CAMPAIGN_NOT_EDITABLE` otherwise, per the OpenAPI contract). */
export async function updateCampaign(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  campaignId: string,
  input: UpdateCampaignInput,
  correlationId?: string,
  /** Issue #362: `undefined` leaves the segment pin alone, `null` detaches it, a pin (re)attaches it. */
  segmentPin:
    { segmentId: string; version: number } | null | undefined = undefined
): Promise<UpdateCampaignOutcome> {
  const existingRows = (await tx`
    SELECT status FROM awcms_commerce_campaigns
    WHERE tenant_id = ${tenantId} AND id = ${campaignId} AND deleted_at IS NULL
  `) as { status: CampaignStatus }[];
  if (existingRows.length === 0) return { kind: "not_found" };
  if (existingRows[0]!.status !== "draft") return { kind: "not_editable" };

  // A segment is the whole audience (ADR-0042 Amendment): attaching one clears
  // the legacy filters (a body that also sends filters is refused earlier).
  const attaching = segmentPin !== undefined && segmentPin !== null;
  const detaching = segmentPin === null;
  const touchSegment = segmentPin !== undefined;

  // Bound as an OBJECT: `JSON.stringify(...)` here stored the filters as a JSON
  // string scalar (`jsonb_typeof = 'string'`), which the dispatcher then read as
  // an audience with no `levels` (found by the #362 route tests).
  const audience: CampaignAudience | null = attaching
    ? { levels: [], hasAccount: null, lastOrderSince: null }
    : (input.audience ?? null);
  const hasSubject = input.subject !== undefined;
  const hasBody = input.body !== undefined;

  const rows = (await tx`
    UPDATE awcms_commerce_campaigns
    SET
      audience = COALESCE(${audience}::jsonb, audience),
      segment_id = CASE WHEN ${touchSegment} THEN ${segmentPin?.segmentId ?? null}::uuid ELSE segment_id END,
      segment_version = CASE WHEN ${touchSegment} THEN ${segmentPin?.version ?? null}::int ELSE segment_version END,
      subject = CASE WHEN ${hasSubject} THEN ${input.subject ?? null} ELSE subject END,
      body = CASE WHEN ${hasBody} THEN ${input.body ?? null} ELSE body END,
      updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${campaignId} AND status = 'draft'
    RETURNING id, channel, audience, subject, body, status, scheduled_at,
              sent_at, recipient_count, created_at,
              segment_id, segment_version, segment_as_of
  `) as CampaignRow[];
  if (rows.length === 0) return { kind: "not_found" };

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: campaignId,
    message: "Campaign edited.",
    attributes: {
      actorTenantUserId,
      ...(attaching
        ? {
            segmentId: segmentPin.segmentId,
            segmentVersion: segmentPin.version
          }
        : {}),
      ...(detaching ? { segmentDetached: true } : {})
    },
    correlationId
  });

  return { kind: "updated", campaign: await toRecord(tx, tenantId, rows[0]!) };
}

// ---------------------------------------------------------------------------
// Audience resolution — the ONE place consent + channel-address are enforced
// ---------------------------------------------------------------------------

type AudienceRow = {
  customer_id: string;
  name: string;
  phone: string;
  email: string | null;
};

/**
 * One page (`CAMPAIGN_AUDIENCE_PAGE_SIZE`) of consented, addressable
 * customers for `channel`, matching `audience`, EXCLUDING customers who
 * already have a `awcms_commerce_campaign_recipients` row for `campaignId`
 * — this `NOT EXISTS` is what makes the dispatcher resumable without a
 * separate cursor column on the campaign row itself: a crash between pages
 * leaves already-inserted recipient rows in place, and the very next call
 * to this function naturally continues where it left off.
 */
export async function resolveCampaignAudiencePage(
  tx: Bun.SQL,
  tenantId: string,
  campaignId: string,
  channel: CampaignChannel,
  audience: CampaignAudience,
  pageSize: number = CAMPAIGN_AUDIENCE_PAGE_SIZE
): Promise<AudienceRow[]> {
  if (audience.hasAccount === false) return [];

  // Bound as a typed text array and cast; a bare JS array mis-binds ("insufficient data left in message").
  const levels =
    audience.levels.length > 0
      ? tx.array(audience.levels.map(String), "text")
      : null;
  const lastOrderSince = audience.lastOrderSince;
  const channelIsEmail = channel === "email";

  const rows = (await tx`
    SELECT c.id AS customer_id, c.name, c.phone, a.email_normalized AS email
    FROM awcms_commerce_customers c
    JOIN awcms_commerce_customer_accounts a
      ON a.customer_id = c.id AND a.tenant_id = c.tenant_id
    WHERE c.tenant_id = ${tenantId}
      AND c.deleted_at IS NULL
      AND a.deleted_at IS NULL
      AND a.status = 'active'
      AND a.marketing_consent_at IS NOT NULL
      AND (${levels}::text[] IS NULL OR c.level = ANY(${levels}::text[]::int[]))
      AND (
        ${lastOrderSince}::timestamptz IS NULL
        OR EXISTS (
          SELECT 1 FROM awcms_commerce_orders o
          WHERE o.tenant_id = c.tenant_id AND o.customer_id = c.id
            AND o.deleted_at IS NULL AND o.created_at >= ${lastOrderSince}::timestamptz
        )
      )
      AND (
        (${channelIsEmail} AND a.email_normalized IS NOT NULL AND a.email_normalized <> '')
        OR (NOT ${channelIsEmail} AND c.phone IS NOT NULL AND c.phone <> '')
      )
      AND NOT EXISTS (
        SELECT 1 FROM awcms_commerce_campaign_recipients r
        WHERE r.tenant_id = ${tenantId} AND r.campaign_id = ${campaignId}
          AND r.customer_id = c.id
      )
    ORDER BY c.id ASC
    LIMIT ${pageSize}
  `) as AudienceRow[];

  return rows;
}

/** `POST .../{id}/preview` — a COUNT only, never a resolved list (`awcms-sensitive-data`). */
export async function countCampaignAudience(
  tx: Bun.SQL,
  tenantId: string,
  channel: CampaignChannel,
  audience: CampaignAudience
): Promise<number> {
  if (audience.hasAccount === false) return 0;

  // Bound as a typed text array and cast; a bare JS array mis-binds ("insufficient data left in message").
  const levels =
    audience.levels.length > 0
      ? tx.array(audience.levels.map(String), "text")
      : null;
  const lastOrderSince = audience.lastOrderSince;
  const channelIsEmail = channel === "email";

  const rows = (await tx`
    SELECT count(*)::int AS total
    FROM awcms_commerce_customers c
    JOIN awcms_commerce_customer_accounts a
      ON a.customer_id = c.id AND a.tenant_id = c.tenant_id
    WHERE c.tenant_id = ${tenantId}
      AND c.deleted_at IS NULL
      AND a.deleted_at IS NULL
      AND a.status = 'active'
      AND a.marketing_consent_at IS NOT NULL
      AND (${levels}::text[] IS NULL OR c.level = ANY(${levels}::text[]::int[]))
      AND (
        ${lastOrderSince}::timestamptz IS NULL
        OR EXISTS (
          SELECT 1 FROM awcms_commerce_orders o
          WHERE o.tenant_id = c.tenant_id AND o.customer_id = c.id
            AND o.deleted_at IS NULL AND o.created_at >= ${lastOrderSince}::timestamptz
        )
      )
      AND (
        (${channelIsEmail} AND a.email_normalized IS NOT NULL AND a.email_normalized <> '')
        OR (NOT ${channelIsEmail} AND c.phone IS NOT NULL AND c.phone <> '')
      )
  `) as { total: number }[];

  return rows[0]?.total ?? 0;
}

// ---------------------------------------------------------------------------
// send / cancel
// ---------------------------------------------------------------------------

export type SendCampaignOutcome =
  | { kind: "not_found" }
  | { kind: "not_sendable" }
  | { kind: "sent"; campaign: CampaignRecord };

/**
 * `POST .../{id}/send` — moves a `draft`/`scheduled` campaign to `scheduled`
 * with `scheduled_at = now()` (an immediate send is just "due right now" —
 * one code path for both, matching the contract's own "scheduled_at = now
 * or a future time" framing). Does NOT itself resolve the audience or touch
 * any outbox — `commerce:campaigns:dispatch`
 * (`application/campaign-dispatch.ts`) does that, on its own tick, so this
 * route call returns immediately regardless of audience size.
 */
export async function sendCampaign(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  campaignId: string,
  scheduledAt: Date | null,
  correlationId?: string
): Promise<SendCampaignOutcome> {
  const rows = (await tx`
    UPDATE awcms_commerce_campaigns
    SET status = 'scheduled', scheduled_at = ${scheduledAt ?? new Date()}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${campaignId}
      AND status IN ('draft', 'scheduled') AND deleted_at IS NULL
    RETURNING id, channel, audience, subject, body, status, scheduled_at,
              sent_at, recipient_count, created_at,
              segment_id, segment_version, segment_as_of
  `) as CampaignRow[];

  if (rows.length === 0) {
    const existing = (await tx`
      SELECT id FROM awcms_commerce_campaigns
      WHERE tenant_id = ${tenantId} AND id = ${campaignId} AND deleted_at IS NULL
    `) as { id: string }[];
    return existing.length === 0
      ? { kind: "not_found" }
      : { kind: "not_sendable" };
  }

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: campaignId,
    message: "Campaign scheduled to send.",
    attributes: { actorTenantUserId },
    correlationId
  });

  return { kind: "sent", campaign: await toRecord(tx, tenantId, rows[0]!) };
}

export type CancelCampaignOutcome =
  | { kind: "not_found" }
  | { kind: "already_final" }
  | { kind: "cancelled"; campaign: CampaignRecord };

/**
 * `POST .../{id}/cancel` — `draft`/`scheduled`/`sending` may be cancelled;
 * `sent`/`cancelled` are final (`409 CAMPAIGN_ALREADY_FINAL`). Cancelling a
 * campaign mid-`sending` does NOT un-send already-enqueued recipient rows
 * (contract's own words) — it only flips `status`, which
 * `application/campaign-dispatch.ts`'s dispatch loop re-checks before every
 * page so no FURTHER page is ever enqueued once this commits.
 */
export async function cancelCampaign(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  campaignId: string,
  correlationId?: string
): Promise<CancelCampaignOutcome> {
  const rows = (await tx`
    UPDATE awcms_commerce_campaigns
    SET status = 'cancelled', updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${campaignId}
      AND status IN ('draft', 'scheduled', 'sending') AND deleted_at IS NULL
    RETURNING id, channel, audience, subject, body, status, scheduled_at,
              sent_at, recipient_count, created_at,
              segment_id, segment_version, segment_as_of
  `) as CampaignRow[];

  if (rows.length === 0) {
    const existing = (await tx`
      SELECT id FROM awcms_commerce_campaigns
      WHERE tenant_id = ${tenantId} AND id = ${campaignId} AND deleted_at IS NULL
    `) as { id: string }[];
    return existing.length === 0
      ? { kind: "not_found" }
      : { kind: "already_final" };
  }

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: campaignId,
    message: "Campaign cancelled.",
    attributes: { actorTenantUserId },
    correlationId
  });

  return {
    kind: "cancelled",
    campaign: await toRecord(tx, tenantId, rows[0]!)
  };
}
