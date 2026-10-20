/**
 * Versioned cancellation refund policies of the booking adapter (Issue #381,
 * ADR-0045 D6, owner answer Q9; data model section 4.4; UX flows 11.4).
 *
 * ## Versions, not edits
 *
 * A policy is per product with a tenant-wide default (`product_id IS NULL`). It
 * is IMMUTABLE once active (sql/1037): a change is a NEW version. A version is
 * authored as a draft with its windows in one call (the windows table is
 * insert-only, so a draft is not edited - a correction is a new draft), then
 * `approve` activates it: the scope's current active version is retired in the
 * same transaction (the partial unique index allows one active per scope) and
 * the approver is recorded. `retire` ends an active version without a
 * successor, so the scope falls back to the tenant default, and to NONE when
 * there is none (refund 0, ADR-0045 D6).
 *
 * ## "The version that applied" is the version in force WHEN THE BOOKING WAS MADE
 *
 * A guest agrees to the policy they were shown (UX 4.1), and a later version
 * must not change what they were promised (threat control C-37). The decision
 * therefore resolves the policy AS OF the creation of the reservation link at
 * the root of the booking's reschedule chain: the policy row whose
 * `[activated_at, retired_at)` interval contains that instant, the product's
 * before the tenant default's. {@link resolvePolicyForLink} does it in one SQL
 * statement joining the link's own `created_at`, so no timestamp is rounded
 * through a JavaScript `Date`, and no snapshot column is needed on the link.
 *
 * Every mutation takes an `Idempotency-Key` through the shared store and writes
 * one audit event with identifiers and enums only.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord,
  userIdempotencyActor
} from "../../_shared/idempotency";
import {
  basisPointsToPercent,
  percentToBasisPoints,
  windowsAreMonotone,
  type CancellationRefundBasis,
  type CancellationRules,
  type PolicyDraftInput
} from "../domain/booking-cancellation";
import type { RefundPolicySource } from "../domain/booking-adapter";
import { IdempotencyPayloadMismatchError } from "./order-directory";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "commerce_booking_cancellation_policy";
const CREATE_SCOPE = "commerce.booking_cancellation_policies.create";
const APPROVE_SCOPE = "commerce.booking_cancellation_policies.approve";
const RETIRE_SCOPE = "commerce.booking_cancellation_policies.retire";
const LIST_LIMIT = 200;

export type PolicyWindowRecord = {
  minHoursBeforeStart: number;
  refundablePercent: string;
};

export type PolicyStatus = "draft" | "active" | "retired";

export type PolicyRecord = {
  id: string;
  /** `null` is the tenant default. */
  productId: string | null;
  version: number;
  status: PolicyStatus;
  refundBasis: CancellationRefundBasis;
  noShowRetention: "retain_deposit" | "retain_all" | "refund_per_windows";
  windows: PolicyWindowRecord[];
  createdAt: string;
  activatedAt: string | null;
  retiredAt: string | null;
  createdByTenantUserId: string | null;
  approvedByTenantUserId: string | null;
};

type PolicyRow = {
  id: string;
  product_id: string | null;
  version: number;
  status: PolicyStatus;
  refund_basis: CancellationRefundBasis;
  no_show_retention: PolicyRecord["noShowRetention"];
  created_at: Date | string;
  activated_at: Date | string | null;
  retired_at: Date | string | null;
  created_by_tenant_user_id: string | null;
  approved_by_tenant_user_id: string | null;
};

type WindowRow = {
  policy_id: string;
  min_hours_before_start: number;
  refundable_percent: string | number;
};

const iso = (value: Date | string): string => new Date(value).toISOString();

const POLICY_COLUMNS = `id, product_id, version, status, refund_basis,
  no_show_retention, created_at, activated_at, retired_at,
  created_by_tenant_user_id, approved_by_tenant_user_id`;

function percentText(value: string | number): string {
  // `numeric(5,2)` through a parameterised query decodes `100.00` as "100".
  return basisPointsToPercent(Math.round(Number(value) * 100));
}

async function hydrate(
  tx: Bun.SQL,
  tenantId: string,
  rows: PolicyRow[]
): Promise<PolicyRecord[]> {
  if (rows.length === 0) return [];
  const windows = (await tx`
    SELECT policy_id, min_hours_before_start, refundable_percent
    FROM awcms_commerce_cancellation_policy_windows
    WHERE tenant_id = ${tenantId}
      AND policy_id = ANY(${tx.array(
        rows.map((row) => row.id),
        "uuid"
      )}::uuid[])
    ORDER BY min_hours_before_start DESC
  `) as WindowRow[];
  return rows.map((row) => ({
    id: row.id,
    productId: row.product_id,
    version: Number(row.version),
    status: row.status,
    refundBasis: row.refund_basis,
    noShowRetention: row.no_show_retention,
    windows: windows
      .filter((window) => window.policy_id === row.id)
      .map((window) => ({
        minHoursBeforeStart: Number(window.min_hours_before_start),
        refundablePercent: percentText(window.refundable_percent)
      })),
    createdAt: iso(row.created_at),
    activatedAt: row.activated_at === null ? null : iso(row.activated_at),
    retiredAt: row.retired_at === null ? null : iso(row.retired_at),
    createdByTenantUserId: row.created_by_tenant_user_id,
    approvedByTenantUserId: row.approved_by_tenant_user_id
  }));
}

/** The rules the quote arithmetic needs, from a stored policy. */
export function rulesOf(policy: PolicyRecord): CancellationRules {
  return {
    refundBasis: policy.refundBasis,
    windows: policy.windows.map((window) => ({
      minHoursBeforeStart: window.minHoursBeforeStart,
      refundableBp: percentToBasisPoints(window.refundablePercent) ?? 0
    }))
  };
}

export type PolicyScope =
  | { kind: "all" }
  | { kind: "default" }
  | { kind: "product"; productId: string };

/**
 * The versions of a scope (or every scope), active first, then drafts, then the
 * history, newest version first. Bounded; the screen filters by scope.
 */
export async function listPolicies(
  tx: Bun.SQL,
  tenantId: string,
  scope: PolicyScope,
  status: PolicyStatus | null = null
): Promise<PolicyRecord[]> {
  const productId = scope.kind === "product" ? scope.productId : null;
  const rows = (await tx`
    SELECT ${tx.unsafe(POLICY_COLUMNS)}
    FROM awcms_commerce_cancellation_policies
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
      AND (
        ${scope.kind}::text = 'all'
        OR (${scope.kind}::text = 'default' AND product_id IS NULL)
        OR (${scope.kind}::text = 'product' AND product_id = ${productId}::uuid)
      )
      AND (${status}::text IS NULL OR status = ${status})
    ORDER BY
      CASE status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
      product_id NULLS FIRST, version DESC
    LIMIT ${LIST_LIMIT}
  `) as PolicyRow[];
  return hydrate(tx, tenantId, rows);
}

export async function fetchPolicy(
  tx: Bun.SQL,
  tenantId: string,
  policyId: string
): Promise<PolicyRecord | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(POLICY_COLUMNS)}
    FROM awcms_commerce_cancellation_policies
    WHERE tenant_id = ${tenantId} AND id = ${policyId} AND deleted_at IS NULL
  `) as PolicyRow[];
  return (await hydrate(tx, tenantId, rows))[0] ?? null;
}

/** A single advisory lock per (tenant, scope), so version numbers and the one-active rule cannot race. */
async function lockScope(
  tx: Bun.SQL,
  tenantId: string,
  productId: string | null
): Promise<void> {
  await tx`
    SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:cancellation-policy:${productId ?? "default"}`}, 0))
  `;
}

export type CreateDraftOutcome =
  | { kind: "created" | "replayed"; policy: PolicyRecord }
  | { kind: "refused"; refusal: "product_not_found" };

/**
 * Authors a draft version with its windows.
 *
 * @throws {IdempotencyPayloadMismatchError} same key, different request.
 */
export async function createPolicyDraft(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: PolicyDraftInput,
  idempotencyKey: string,
  correlationId?: string
): Promise<CreateDraftOutcome> {
  const requestHash = computeRequestHash(input);
  const actor = userIdempotencyActor(actorTenantUserId);
  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    CREATE_SCOPE,
    idempotencyKey,
    actor
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      policy: existing.responseBody as PolicyRecord
    };
  }

  if (input.productId !== null) {
    const products = (await tx`
      SELECT 1 AS present FROM awcms_commerce_products
      WHERE tenant_id = ${tenantId} AND id = ${input.productId} AND deleted_at IS NULL
    `) as unknown[];
    if (products.length === 0) {
      return { kind: "refused", refusal: "product_not_found" };
    }
  }

  await lockScope(tx, tenantId, input.productId);
  const next = (await tx`
    SELECT COALESCE(MAX(version), 0) + 1 AS version
    FROM awcms_commerce_cancellation_policies
    WHERE tenant_id = ${tenantId}
      AND product_id IS NOT DISTINCT FROM ${input.productId}::uuid
  `) as { version: number }[];

  const inserted = (await tx`
    INSERT INTO awcms_commerce_cancellation_policies
      (tenant_id, product_id, version, refund_basis, no_show_retention,
       created_by_tenant_user_id)
    VALUES (${tenantId}, ${input.productId}, ${Number(next[0]!.version)},
            ${input.refundBasis}, ${input.noShowRetention}, ${actorTenantUserId})
    RETURNING id
  `) as { id: string }[];
  const policyId = inserted[0]!.id;
  for (const window of input.windows) {
    await tx`
      INSERT INTO awcms_commerce_cancellation_policy_windows
        (tenant_id, policy_id, min_hours_before_start, refundable_percent)
      VALUES (${tenantId}, ${policyId}, ${window.minHoursBeforeStart},
              ${window.refundablePercent})
    `;
  }
  const policy = (await fetchPolicy(tx, tenantId, policyId))!;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "commerce.booking_cancellation_policy.created",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: policyId,
    message: "Booking cancellation policy draft created.",
    attributes: {
      productId: policy.productId,
      version: policy.version,
      refundBasis: policy.refundBasis,
      windows: policy.windows.length
    },
    correlationId
  });
  await saveIdempotencyRecord(
    tx,
    tenantId,
    CREATE_SCOPE,
    idempotencyKey,
    actor,
    requestHash,
    201,
    policy
  );
  return { kind: "created", policy };
}

export type ApprovePolicyOutcome =
  | {
      kind: "activated" | "replayed";
      policy: PolicyRecord;
      retiredPolicyId: string | null;
    }
  | { kind: "not_found" }
  | { kind: "not_a_draft"; status: PolicyStatus }
  | { kind: "windows_not_monotone" };

/**
 * Activates a draft: retires the scope's current active version and makes the
 * draft the active one, recording the approver. The caller has already passed
 * the `approve` permission AND the step-up gate.
 *
 * @throws {IdempotencyPayloadMismatchError} same key, different request.
 */
export async function approvePolicy(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  policyId: string,
  idempotencyKey: string,
  correlationId?: string
): Promise<ApprovePolicyOutcome> {
  const requestHash = computeRequestHash({ policyId, action: "approve" });
  const actor = userIdempotencyActor(actorTenantUserId);
  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    APPROVE_SCOPE,
    idempotencyKey,
    actor
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return existing.responseBody as ApprovePolicyOutcome;
  }

  const draft = await fetchPolicy(tx, tenantId, policyId);
  if (!draft) return { kind: "not_found" };
  if (draft.status !== "draft") {
    return { kind: "not_a_draft", status: draft.status };
  }
  if (!windowsAreMonotone(rulesOf(draft).windows)) {
    return { kind: "windows_not_monotone" };
  }

  await lockScope(tx, tenantId, draft.productId);
  // Re-read under the lock: two approvals of the same draft queue here.
  const locked = (await tx`
    SELECT status FROM awcms_commerce_cancellation_policies
    WHERE tenant_id = ${tenantId} AND id = ${policyId}
    FOR NO KEY UPDATE
  `) as { status: PolicyStatus }[];
  if (locked[0]?.status !== "draft") {
    return { kind: "not_a_draft", status: locked[0]?.status ?? "retired" };
  }

  const retired = (await tx`
    UPDATE awcms_commerce_cancellation_policies
    SET status = 'retired', retired_at = now()
    WHERE tenant_id = ${tenantId} AND status = 'active'
      AND product_id IS NOT DISTINCT FROM ${draft.productId}::uuid
    RETURNING id
  `) as { id: string }[];
  await tx`
    UPDATE awcms_commerce_cancellation_policies
    SET status = 'active', activated_at = now(),
        approved_by_tenant_user_id = ${actorTenantUserId}
    WHERE tenant_id = ${tenantId} AND id = ${policyId} AND status = 'draft'
  `;
  const policy = (await fetchPolicy(tx, tenantId, policyId))!;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "commerce.booking_cancellation_policy.activated",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: policyId,
    severity: "warning",
    message:
      "Booking cancellation policy version activated; it decides every later refund of the scope.",
    attributes: {
      productId: policy.productId,
      version: policy.version,
      retiredPolicyId: retired[0]?.id ?? null,
      authoredBy: policy.createdByTenantUserId
    },
    correlationId
  });
  const outcome: ApprovePolicyOutcome = {
    kind: "activated",
    policy,
    retiredPolicyId: retired[0]?.id ?? null
  };
  await saveIdempotencyRecord(
    tx,
    tenantId,
    APPROVE_SCOPE,
    idempotencyKey,
    actor,
    requestHash,
    200,
    { ...outcome, kind: "replayed" }
  );
  return outcome;
}

export type RetirePolicyOutcome =
  | { kind: "retired" | "replayed"; policy: PolicyRecord }
  | { kind: "not_found" }
  | { kind: "not_active"; status: PolicyStatus };

/** Ends an ACTIVE version without a successor. The caller has passed `approve` and the step-up gate. */
export async function retirePolicy(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  policyId: string,
  idempotencyKey: string,
  correlationId?: string
): Promise<RetirePolicyOutcome> {
  const requestHash = computeRequestHash({ policyId, action: "retire" });
  const actor = userIdempotencyActor(actorTenantUserId);
  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    RETIRE_SCOPE,
    idempotencyKey,
    actor
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      policy: existing.responseBody as PolicyRecord
    };
  }

  const current = await fetchPolicy(tx, tenantId, policyId);
  if (!current) return { kind: "not_found" };
  if (current.status !== "active") {
    return { kind: "not_active", status: current.status };
  }
  await lockScope(tx, tenantId, current.productId);
  await tx`
    UPDATE awcms_commerce_cancellation_policies
    SET status = 'retired', retired_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${policyId} AND status = 'active'
  `;
  const policy = (await fetchPolicy(tx, tenantId, policyId))!;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "commerce.booking_cancellation_policy.retired",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: policyId,
    severity: "warning",
    message:
      "Booking cancellation policy version retired without a successor; the scope falls back to the tenant default, then to no refund.",
    attributes: { productId: policy.productId, version: policy.version },
    correlationId
  });
  await saveIdempotencyRecord(
    tx,
    tenantId,
    RETIRE_SCOPE,
    idempotencyKey,
    actor,
    requestHash,
    200,
    policy
  );
  return { kind: "retired", policy };
}

export type ResolvedPolicy = {
  source: RefundPolicySource;
  policy: PolicyRecord | null;
};

/**
 * The policy version in force WHEN THE LINK WAS MADE (see the header): the
 * product's, else the tenant default's, else none. `linkId` is the root of the
 * reschedule chain; `productId` is the product its offering link names.
 */
export async function resolvePolicyForLink(
  tx: Bun.SQL,
  tenantId: string,
  linkId: string,
  productId: string
): Promise<ResolvedPolicy> {
  const rows = (await tx`
    SELECT ${tx.unsafe(
      POLICY_COLUMNS.split(",")
        .map((column) => `p.${column.trim()}`)
        .join(", ")
    )}
    FROM awcms_commerce_booking_reservation_links l
    JOIN awcms_commerce_cancellation_policies p
      ON p.tenant_id = l.tenant_id
     AND (p.product_id = ${productId}::uuid OR p.product_id IS NULL)
     AND p.status IN ('active', 'retired')
     AND p.deleted_at IS NULL
     AND p.activated_at <= l.created_at
     AND (p.retired_at IS NULL OR p.retired_at > l.created_at)
    WHERE l.tenant_id = ${tenantId} AND l.id = ${linkId}
    ORDER BY (p.product_id IS NOT NULL) DESC, p.activated_at DESC, p.version DESC
    LIMIT 1
  `) as PolicyRow[];
  const policy = (await hydrate(tx, tenantId, rows))[0] ?? null;
  if (!policy) return { source: "none", policy: null };
  return {
    source: policy.productId === null ? "tenant_default" : "product",
    policy
  };
}
