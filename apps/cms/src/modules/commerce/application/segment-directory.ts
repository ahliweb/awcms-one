/**
 * CRM segment persistence (Issue #360, ADR-0042): the mutable head and its
 * immutable versions.
 *
 * - Creating a segment inserts the head and version 1 in one transaction.
 * - Editing the rules inserts version N+1 and moves the head's
 *   `latest_version`; version N is never touched (and cannot be: `sql/1001`
 *   gives `awcms_app` no UPDATE or DELETE on the versions table and a trigger
 *   refuses it anyway).
 * - An edit names the `baseVersion` it started from. The head row is locked
 *   `FOR UPDATE` and a mismatch is `version_conflict` - a double submit or a
 *   stale tab cannot silently create an unreviewed version or lose an update.
 * - Retiring sets `retired_at`; every version stays so a consumer that recorded
 *   `(segment_id, version)` can still be explained (C-29).
 *
 * Every mutation writes an audit event with the actor and the segment version
 * (attributes name ids and counts, never a rule value or a customer).
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  keysetCursorCreatedAtSql,
  type KeysetCursor
} from "../../_shared/keyset-pagination";
import type { CreateSegmentInput, UpdateSegmentInput } from "../domain/segment";
import {
  validateSegmentRules,
  type SegmentNode,
  type SegmentRuleStats
} from "../domain/segment-rules";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "commerce_segment";
const POSTGRES_UNIQUE_VIOLATION = "23505";
const LIST_PAGE_SIZE = 50;
const MAX_VERSIONS_IN_DETAIL = 100;

export type SegmentVersionRecord = {
  version: number;
  rules: Record<string, unknown>;
  nodeCount: number;
  depth: number;
  createdAt: string;
};

export type SegmentRecord = {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "retired";
  latestVersion: number;
  createdAt: string;
  updatedAt: string;
  retiredAt: string | null;
};

export type SegmentDetail = SegmentRecord & {
  versions: SegmentVersionRecord[];
};

type SegmentRow = {
  id: string;
  name: string;
  description: string | null;
  latest_version: number;
  retired_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  created_at_cursor?: string;
};

type VersionRow = {
  version: number;
  rules: Record<string, unknown> | string;
  node_count: number;
  depth: number;
  created_at: Date | string;
};

const toIso = (value: Date | string): string => new Date(value).toISOString();

function toRecord(row: SegmentRow): SegmentRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.retired_at === null ? "active" : "retired",
    latestVersion: Number(row.latest_version),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    retiredAt: row.retired_at === null ? null : toIso(row.retired_at)
  };
}

function toVersion(row: VersionRow): SegmentVersionRecord {
  return {
    version: Number(row.version),
    rules:
      typeof row.rules === "string"
        ? (JSON.parse(row.rules) as Record<string, unknown>)
        : row.rules,
    nodeCount: Number(row.node_count),
    depth: Number(row.depth),
    createdAt: toIso(row.created_at)
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    String((error as { errno?: unknown }).errno) === POSTGRES_UNIQUE_VIOLATION
  );
}

/** Live segments, newest first; `includeRetired` adds the retired ones. */
export async function listSegments(
  tx: Bun.SQL,
  tenantId: string,
  cursor: KeysetCursor | null,
  includeRetired: boolean
): Promise<{ items: SegmentRecord[]; nextCursor: string | null }> {
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;
  const rows = (await tx`
    SELECT id, name, description, latest_version, retired_at, created_at,
      updated_at, ${tx.unsafe(keysetCursorCreatedAtSql())} AS created_at_cursor
    FROM awcms_commerce_segments
    WHERE tenant_id = ${tenantId}
      AND (${includeRetired}::boolean OR retired_at IS NULL)
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (created_at, id) < (${cursorCreatedAt}::timestamptz, ${cursorId}::uuid)
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${LIST_PAGE_SIZE + 1}
  `) as SegmentRow[];
  const hasMore = rows.length > LIST_PAGE_SIZE;
  const visible = hasMore ? rows.slice(0, LIST_PAGE_SIZE) : rows;
  const last = visible[visible.length - 1];
  return {
    items: visible.map(toRecord),
    nextCursor:
      hasMore && last?.created_at_cursor
        ? encodeKeysetCursor(last.created_at_cursor, last.id)
        : null
  };
}

export { decodeKeysetCursor };

async function fetchVersions(
  tx: Bun.SQL,
  tenantId: string,
  segmentId: string,
  limit: number
): Promise<SegmentVersionRecord[]> {
  const rows = (await tx`
    SELECT version, rules, node_count, depth, created_at
    FROM awcms_commerce_segment_versions
    WHERE tenant_id = ${tenantId} AND segment_id = ${segmentId}
    ORDER BY version DESC
    LIMIT ${limit}
  `) as VersionRow[];
  return rows.map(toVersion);
}

export async function fetchSegment(
  tx: Bun.SQL,
  tenantId: string,
  segmentId: string
): Promise<SegmentDetail | null> {
  const rows = (await tx`
    SELECT id, name, description, latest_version, retired_at, created_at, updated_at
    FROM awcms_commerce_segments
    WHERE tenant_id = ${tenantId} AND id = ${segmentId}
  `) as SegmentRow[];
  if (!rows[0]) return null;
  return {
    ...toRecord(rows[0]),
    versions: await fetchVersions(
      tx,
      tenantId,
      segmentId,
      MAX_VERSIONS_IN_DETAIL
    )
  };
}

export type ResolvedSegmentRules = {
  segmentId: string;
  version: number;
  node: SegmentNode;
  stats: SegmentRuleStats;
};

/**
 * The rule tree of `segmentId` at `version` (the latest when `version` is
 * null), re-validated through the same closed vocabulary - a stored row is
 * never trusted to be well-formed. A retired segment still resolves, so a past
 * consumer's `(segment, version)` stays explainable. `null` for an unknown,
 * foreign-tenant or never-existing id/version, indistinguishably.
 */
export async function resolveSegmentRules(
  tx: Bun.SQL,
  tenantId: string,
  segmentId: string,
  version: number | null
): Promise<ResolvedSegmentRules | null> {
  const rows = (await tx`
    SELECT v.version, v.rules, v.node_count, v.depth, v.created_at
    FROM awcms_commerce_segments s
    JOIN awcms_commerce_segment_versions v
      ON v.tenant_id = s.tenant_id AND v.segment_id = s.id
      AND v.version = COALESCE(${version}::int, s.latest_version)
    WHERE s.tenant_id = ${tenantId} AND s.id = ${segmentId}
  `) as VersionRow[];
  if (!rows[0]) return null;
  const stored = toVersion(rows[0]);
  const checked = validateSegmentRules(stored.rules);
  if (!checked.valid) {
    throw new Error(
      `Stored segment ${segmentId} version ${stored.version} no longer validates.`
    );
  }
  return {
    segmentId,
    version: stored.version,
    node: checked.node,
    stats: checked.stats
  };
}

export type CreateSegmentOutcome =
  { kind: "created"; segment: SegmentDetail } | { kind: "name_taken" };

export async function createSegment(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateSegmentInput,
  correlationId?: string
): Promise<CreateSegmentOutcome> {
  let head: SegmentRow;
  try {
    // A savepoint: a unique violation must not poison the tenant transaction.
    head = await (tx as Bun.TransactionSQL).savepoint(async (sp) => {
      const rows = (await sp`
        INSERT INTO awcms_commerce_segments (
          tenant_id, name, description, latest_version, created_by_tenant_user_id
        ) VALUES (
          ${tenantId}, ${input.name}, ${input.description}, 1, ${actorTenantUserId}
        )
        RETURNING id, name, description, latest_version, retired_at, created_at, updated_at
      `) as SegmentRow[];
      await sp`
        INSERT INTO awcms_commerce_segment_versions (
          tenant_id, segment_id, version, rules, node_count, depth,
          created_by_tenant_user_id
        ) VALUES (
          ${tenantId}, ${rows[0]!.id}, 1, ${input.canonicalRules}::jsonb,
          ${input.stats.nodeCount}, ${input.stats.depth}, ${actorTenantUserId}
        )
      `;
      return rows[0]!;
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { kind: "name_taken" };
    throw error;
  }

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "commerce.segment.created",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: head.id,
    message: "Segment defined (version 1).",
    attributes: {
      version: 1,
      nodeCount: input.stats.nodeCount,
      depth: input.stats.depth
    },
    correlationId
  });
  const detail = await fetchSegment(tx, tenantId, head.id);
  return { kind: "created", segment: detail! };
}

export type UpdateSegmentOutcome =
  | { kind: "updated"; segment: SegmentDetail; newVersion: number | null }
  | { kind: "not_found" }
  | { kind: "retired" }
  | { kind: "version_conflict"; latestVersion: number }
  | { kind: "name_taken" };

export async function updateSegment(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  segmentId: string,
  input: UpdateSegmentInput,
  correlationId?: string
): Promise<UpdateSegmentOutcome> {
  const locked = (await tx`
    SELECT id, name, description, latest_version, retired_at, created_at, updated_at
    FROM awcms_commerce_segments
    WHERE tenant_id = ${tenantId} AND id = ${segmentId}
    FOR UPDATE
  `) as SegmentRow[];
  const head = locked[0];
  if (!head) return { kind: "not_found" };
  if (head.retired_at !== null) return { kind: "retired" };
  if (Number(head.latest_version) !== input.baseVersion) {
    return {
      kind: "version_conflict",
      latestVersion: Number(head.latest_version)
    };
  }

  const nextVersion = input.rules ? input.baseVersion + 1 : null;
  const name = input.name ?? head.name;
  const description =
    input.description === undefined ? head.description : input.description;

  try {
    await (tx as Bun.TransactionSQL).savepoint(async (sp) => {
      if (input.rules && nextVersion !== null) {
        await sp`
          INSERT INTO awcms_commerce_segment_versions (
            tenant_id, segment_id, version, rules, node_count, depth,
            created_by_tenant_user_id
          ) VALUES (
            ${tenantId}, ${segmentId}, ${nextVersion},
            ${input.rules.canonicalRules}::jsonb,
            ${input.rules.stats.nodeCount}, ${input.rules.stats.depth},
            ${actorTenantUserId}
          )
        `;
      }
      await sp`
        UPDATE awcms_commerce_segments
        SET name = ${name},
          description = ${description},
          latest_version = ${nextVersion ?? Number(head.latest_version)},
          updated_by_tenant_user_id = ${actorTenantUserId},
          updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${segmentId}
      `;
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { kind: "name_taken" };
    throw error;
  }

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action:
      nextVersion !== null
        ? "commerce.segment.version_created"
        : "commerce.segment.updated",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: segmentId,
    message:
      nextVersion !== null
        ? `Segment rules changed (version ${nextVersion}).`
        : "Segment renamed or described.",
    attributes: {
      version: nextVersion ?? Number(head.latest_version),
      previousVersion: input.baseVersion,
      renamed: input.name !== undefined,
      ...(input.rules
        ? {
            nodeCount: input.rules.stats.nodeCount,
            depth: input.rules.stats.depth
          }
        : {})
    },
    correlationId
  });
  const detail = await fetchSegment(tx, tenantId, segmentId);
  return { kind: "updated", segment: detail!, newVersion: nextVersion };
}

export type RetireSegmentOutcome =
  | { kind: "retired"; segment: SegmentDetail }
  | { kind: "not_found" }
  | { kind: "already_retired" };

export async function retireSegment(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  segmentId: string,
  correlationId?: string
): Promise<RetireSegmentOutcome> {
  const rows = (await tx`
    SELECT retired_at, latest_version
    FROM awcms_commerce_segments
    WHERE tenant_id = ${tenantId} AND id = ${segmentId}
    FOR UPDATE
  `) as { retired_at: Date | string | null; latest_version: number }[];
  if (!rows[0]) return { kind: "not_found" };
  if (rows[0].retired_at !== null) return { kind: "already_retired" };

  await tx`
    UPDATE awcms_commerce_segments
    SET retired_at = now(),
      retired_by_tenant_user_id = ${actorTenantUserId},
      updated_by_tenant_user_id = ${actorTenantUserId},
      updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${segmentId}
  `;
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "commerce.segment.deleted",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: segmentId,
    severity: "warning",
    message: "Segment retired; its versions are kept.",
    attributes: { latestVersion: Number(rows[0].latest_version) },
    correlationId
  });
  const detail = await fetchSegment(tx, tenantId, segmentId);
  return { kind: "retired", segment: detail! };
}

/** Audit for a member-list page or an export (C-27): who looked, at which version, how many - never who they saw. */
export async function recordSegmentMemberAccess(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    actorTenantUserId: string;
    segmentId: string;
    version: number;
    action: "commerce.segment.members_listed" | "commerce.segment.exported";
    returned: number;
    truncated?: boolean;
    correlationId?: string;
  }
): Promise<void> {
  await recordAuditEvent(tx, {
    tenantId: input.tenantId,
    actorTenantUserId: input.actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: input.action,
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: input.segmentId,
    severity: input.action === "commerce.segment.exported" ? "warning" : "info",
    message:
      input.action === "commerce.segment.exported"
        ? "Segment members exported."
        : "Segment members listed.",
    attributes: {
      version: input.version,
      returned: input.returned,
      ...(input.truncated === undefined ? {} : { truncated: input.truncated })
    },
    correlationId: input.correlationId
  });
}
