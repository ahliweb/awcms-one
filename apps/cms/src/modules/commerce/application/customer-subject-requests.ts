/**
 * `awcms_commerce_customer_subject_requests` persistence (Issue #529,
 * ADR-0055 D1/D3): the evidence row of a shopper's export or erasure request.
 * Counts and codes only; never a bundle, a name or a token.
 *
 * Every function takes a `tx` already inside the tenant's RLS-scoped
 * transaction. The table's own guard trigger (`sql/1065`) makes a terminal row
 * immutable and refuses every delete; {@link decidePendingErasure} is the one
 * UPDATE, a conditional claim (`status = 'pending_approval'` and a checker who
 * is not the maker), so two approvers racing cannot both run the erasure.
 */
import type {
  SubjectRequestChannel,
  SubjectRequestStatus,
  SubjectRequestType
} from "../domain/customer-subject-policy";
import type { ErasureSummary } from "./customer-subject-erasure";

export type SubjectRequestRecord = {
  id: string;
  customerId: string;
  accountId: string | null;
  requestType: SubjectRequestType;
  channel: SubjectRequestChannel;
  status: SubjectRequestStatus;
  refusalCode: string | null;
  reason: string | null;
  requestedByTenantUserId: string | null;
  decidedByTenantUserId: string | null;
  decidedAt: string | null;
  completedAt: string | null;
  rowsAffected: number | null;
  retainedSummary: ErasureSummary | null;
  createdAt: string;
};

type RequestRow = {
  id: string;
  customer_id: string;
  account_id: string | null;
  request_type: string;
  channel: string;
  status: string;
  refusal_code: string | null;
  reason: string | null;
  requested_by_tenant_user_id: string | null;
  decided_by_tenant_user_id: string | null;
  decided_at: Date | null;
  completed_at: Date | null;
  rows_affected: number | null;
  retained_summary: ErasureSummary | string | null;
  created_at: Date;
};

const COLUMNS = `id, customer_id, account_id, request_type, channel, status,
  refusal_code, reason, requested_by_tenant_user_id, decided_by_tenant_user_id,
  decided_at, completed_at, rows_affected, retained_summary, created_at`;

function toRecord(row: RequestRow): SubjectRequestRecord {
  const summary =
    typeof row.retained_summary === "string"
      ? (JSON.parse(row.retained_summary) as ErasureSummary)
      : row.retained_summary;
  return {
    id: row.id,
    customerId: row.customer_id,
    accountId: row.account_id,
    requestType: row.request_type as SubjectRequestType,
    channel: row.channel as SubjectRequestChannel,
    status: row.status as SubjectRequestStatus,
    refusalCode: row.refusal_code,
    reason: row.reason,
    requestedByTenantUserId: row.requested_by_tenant_user_id,
    decidedByTenantUserId: row.decided_by_tenant_user_id,
    decidedAt: row.decided_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    rowsAffected: row.rows_affected,
    retainedSummary: summary,
    createdAt: row.created_at.toISOString()
  };
}

export type InsertSubjectRequest = {
  tenantId: string;
  customerId: string;
  accountId: string | null;
  requestType: SubjectRequestType;
  channel: SubjectRequestChannel;
  status: SubjectRequestStatus;
  refusalCode?: string | null;
  reason?: string | null;
  idempotencyKey?: string | null;
  requestedByTenantUserId?: string | null;
  rowsAffected?: number | null;
  retainedSummary?: ErasureSummary | null;
  completedAt?: Date | null;
  correlationId?: string | null;
};

export async function insertSubjectRequest(
  tx: Bun.SQL,
  input: InsertSubjectRequest
): Promise<SubjectRequestRecord> {
  const summaryJson =
    input.retainedSummary === undefined || input.retainedSummary === null
      ? null
      : JSON.stringify(input.retainedSummary);

  const rows = (await tx`
    INSERT INTO awcms_commerce_customer_subject_requests (
      tenant_id, customer_id, account_id, request_type, channel, status,
      refusal_code, reason, idempotency_key, requested_by_tenant_user_id,
      rows_affected, retained_summary, completed_at, correlation_id
    )
    VALUES (
      ${input.tenantId}, ${input.customerId}, ${input.accountId},
      ${input.requestType}, ${input.channel}, ${input.status},
      ${input.refusalCode ?? null}, ${input.reason ?? null},
      ${input.idempotencyKey ?? null}, ${input.requestedByTenantUserId ?? null},
      ${input.rowsAffected ?? null}, ${summaryJson}::jsonb,
      ${input.completedAt ?? null}, ${input.correlationId ?? null}
    )
    RETURNING ${tx.unsafe(COLUMNS)}
  `) as RequestRow[];
  return toRecord(rows[0]!);
}

/** The first request recorded under a client key, if any (a replay finds it). */
export async function findSubjectRequestByKey(
  tx: Bun.SQL,
  tenantId: string,
  idempotencyKey: string
): Promise<SubjectRequestRecord | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(COLUMNS)}
    FROM awcms_commerce_customer_subject_requests
    WHERE tenant_id = ${tenantId} AND idempotency_key = ${idempotencyKey}
  `) as RequestRow[];
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function findSubjectRequestById(
  tx: Bun.SQL,
  tenantId: string,
  id: string
): Promise<SubjectRequestRecord | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(COLUMNS)}
    FROM awcms_commerce_customer_subject_requests
    WHERE tenant_id = ${tenantId} AND id = ${id}
  `) as RequestRow[];
  return rows[0] ? toRecord(rows[0]) : null;
}

/** The same read with a row lock, so two approvers of one request are decided one after the other. */
export async function lockSubjectRequest(
  tx: Bun.SQL,
  tenantId: string,
  id: string
): Promise<SubjectRequestRecord | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(COLUMNS)}
    FROM awcms_commerce_customer_subject_requests
    WHERE tenant_id = ${tenantId} AND id = ${id}
    FOR UPDATE
  `) as RequestRow[];
  return rows[0] ? toRecord(rows[0]) : null;
}

export const SUBJECT_REQUEST_LIST_LIMIT = 100;

export async function listSubjectRequests(
  tx: Bun.SQL,
  tenantId: string,
  filter: { status?: SubjectRequestStatus; customerId?: string } = {}
): Promise<SubjectRequestRecord[]> {
  const rows = (await tx`
    SELECT ${tx.unsafe(COLUMNS)}
    FROM awcms_commerce_customer_subject_requests
    WHERE tenant_id = ${tenantId}
      AND (${filter.status ?? null}::text IS NULL OR status = ${filter.status ?? null})
      AND (${filter.customerId ?? null}::uuid IS NULL OR customer_id = ${filter.customerId ?? null})
    ORDER BY created_at DESC, id DESC
    LIMIT ${SUBJECT_REQUEST_LIST_LIMIT}
  `) as RequestRow[];
  return rows.map(toRecord);
}

export type DecideInput = {
  tenantId: string;
  requestId: string;
  decidedByTenantUserId: string;
  decision: "completed" | "rejected" | "refused";
  refusalCode?: string | null;
  rowsAffected?: number | null;
  retainedSummary?: ErasureSummary | null;
};

/**
 * Moves a PENDING erasure to its terminal status, claiming it in the same
 * statement: only a row still `pending_approval` and whose maker is not the
 * decider matches. `null` means somebody else decided it first, it is not an
 * erasure awaiting approval, or the decider is the maker (the route has already
 * told those apart for the message).
 */
export async function decidePendingErasure(
  tx: Bun.SQL,
  input: DecideInput
): Promise<SubjectRequestRecord | null> {
  const summaryJson = input.retainedSummary
    ? JSON.stringify(input.retainedSummary)
    : null;
  const completedAt = input.decision === "completed" ? new Date() : null;

  const rows = (await tx`
    UPDATE awcms_commerce_customer_subject_requests
    SET status = ${input.decision},
        decided_by_tenant_user_id = ${input.decidedByTenantUserId},
        decided_at = now(),
        completed_at = ${completedAt},
        refusal_code = ${input.refusalCode ?? null},
        rows_affected = ${input.rowsAffected ?? null},
        retained_summary = ${summaryJson}::jsonb
    WHERE tenant_id = ${input.tenantId} AND id = ${input.requestId}
      AND status = 'pending_approval'
      AND request_type = 'erasure'
      AND (requested_by_tenant_user_id IS NULL
           OR requested_by_tenant_user_id <> ${input.decidedByTenantUserId})
    RETURNING ${tx.unsafe(COLUMNS)}
  `) as RequestRow[];
  return rows[0] ? toRecord(rows[0]) : null;
}
