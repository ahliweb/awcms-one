/**
 * Loyalty program directory — versioned, effective-dated earn rules
 * (Issue #289, ADR-0026 D3/D4).
 *
 * A row is one rule VERSION. Lifecycle: `draft` (editable, no window) ->
 * `active` (immutable; `effective_from` = the instant it was activated) ->
 * `retired` (`effective_to` closes the window). Activating a version closes
 * the one that was open at that instant, in the same transaction and under a
 * per-tenant advisory lock, so there is never an instant with two versions in
 * force and never one the rules changed "retroactively": an earn resolves the
 * version effective at the order's `paid_at` (`selectEffectiveProgram`) and
 * stamps its id on the ledger row.
 *
 * Why immutable once active: a ledger row says "earned under version 3". If
 * version 3's rate could be edited afterwards, that sentence would stop being
 * true. A change of rules is a NEW version.
 */
import { createHash } from "node:crypto";

import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  assertPoints,
  isLoyaltyProgramStatus,
  type LoyaltyProgram
} from "../domain/loyalty";
import { selectEffectiveProgram } from "../domain/loyalty-earn";
import type {
  LoyaltyProgramInput,
  LoyaltyProgramPatch
} from "../domain/loyalty-validation";
import { normalizeMoney } from "../domain/price-calculation";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "commerce_loyalty_program";

/** `int4` namespace for the two-`int4` advisory-lock form — distinct from the job (`890_417_233`) and reporting-projection (`604_918_377`) namespaces, which share one lock space. */
const LOYALTY_PROGRAM_LOCK_NAMESPACE = 604_918_411;

function programLockKey(tenantId: string): number {
  return (
    createHash("sha256")
      .update(`loyalty_program|${tenantId}`)
      .digest()
      .readUInt32BE(0) & 0x7fffffff
  );
}

async function lockProgramsForTenant(
  tx: Bun.SQL,
  tenantId: string
): Promise<void> {
  await tx`
    SELECT pg_advisory_xact_lock(
      ${LOYALTY_PROGRAM_LOCK_NAMESPACE},
      ${programLockKey(tenantId)}
    )
  `;
}

type ProgramRow = {
  id: string;
  version: number;
  name: string;
  status: string;
  effective_from: Date | string | null;
  effective_to: Date | string | null;
  earn_unit_amount: string;
  earn_points_per_unit: number;
  earn_rounding: string;
  min_order_amount: string;
  max_points_per_order: number | null;
  expiry_days: number | null;
  notes: string | null;
  eligibility_segment_id: string | null;
  eligibility_segment_version: number | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const toIso = (value: Date | string): string => new Date(value).toISOString();

function toProgram(row: ProgramRow): LoyaltyProgram {
  if (!isLoyaltyProgramStatus(row.status)) {
    throw new Error(`Unknown loyalty program status "${row.status}".`);
  }
  return {
    id: row.id,
    version: Number(row.version),
    name: row.name,
    status: row.status,
    effectiveFrom:
      row.effective_from === null ? null : toIso(row.effective_from),
    effectiveTo: row.effective_to === null ? null : toIso(row.effective_to),
    earnUnitAmount: normalizeMoney(String(row.earn_unit_amount)),
    earnPointsPerUnit: Number(row.earn_points_per_unit),
    earnRounding: "floor",
    minOrderAmount: normalizeMoney(String(row.min_order_amount)),
    maxPointsPerOrder:
      row.max_points_per_order === null
        ? null
        : assertPoints(row.max_points_per_order, "max_points_per_order"),
    expiryDays: row.expiry_days === null ? null : Number(row.expiry_days),
    notes: row.notes,
    eligibilitySegmentId: row.eligibility_segment_id,
    eligibilitySegmentVersion:
      row.eligibility_segment_version === null
        ? null
        : Number(row.eligibility_segment_version),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

/** Every version, newest first — a tenant has a handful, so no pagination. */
export async function listLoyaltyPrograms(
  tx: Bun.SQL,
  tenantId: string
): Promise<LoyaltyProgram[]> {
  const rows = (await tx`
    SELECT id, version, name, status, effective_from, effective_to,
      earn_unit_amount, earn_points_per_unit, earn_rounding, min_order_amount,
      max_points_per_order, expiry_days, notes, eligibility_segment_id,
      eligibility_segment_version, created_at, updated_at
    FROM awcms_commerce_loyalty_programs
    WHERE tenant_id = ${tenantId}
    ORDER BY version DESC
  `) as ProgramRow[];
  return rows.map(toProgram);
}

export async function fetchLoyaltyProgram(
  tx: Bun.SQL,
  tenantId: string,
  programId: string
): Promise<LoyaltyProgram | null> {
  const rows = (await tx`
    SELECT id, version, name, status, effective_from, effective_to,
      earn_unit_amount, earn_points_per_unit, earn_rounding, min_order_amount,
      max_points_per_order, expiry_days, notes, eligibility_segment_id,
      eligibility_segment_version, created_at, updated_at
    FROM awcms_commerce_loyalty_programs
    WHERE tenant_id = ${tenantId} AND id = ${programId}
  `) as ProgramRow[];
  return rows[0] ? toProgram(rows[0]) : null;
}

/**
 * The version in force at `at` (`selectEffectiveProgram`'s rule), or `null`.
 * The candidate set is every non-draft version; the pure selector picks the
 * one whose window contains `at`, so there is exactly one definition of
 * "effective" shared with the unit tests.
 */
export async function fetchEffectiveProgramAt(
  tx: Bun.SQL,
  tenantId: string,
  at: Date
): Promise<LoyaltyProgram | null> {
  const rows = (await tx`
    SELECT id, version, name, status, effective_from, effective_to,
      earn_unit_amount, earn_points_per_unit, earn_rounding, min_order_amount,
      max_points_per_order, expiry_days, notes, eligibility_segment_id,
      eligibility_segment_version, created_at, updated_at
    FROM awcms_commerce_loyalty_programs
    WHERE tenant_id = ${tenantId} AND status IN ('active', 'retired')
    ORDER BY version DESC
  `) as ProgramRow[];
  return selectEffectiveProgram(rows.map(toProgram), at);
}

export async function createLoyaltyProgram(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: LoyaltyProgramInput,
  correlationId?: string
): Promise<LoyaltyProgram> {
  // The version number is `max + 1`; the lock makes that read-then-insert
  // atomic per tenant (the unique `(tenant_id, version)` index is the
  // backstop, not the mechanism).
  await lockProgramsForTenant(tx, tenantId);

  const rows = (await tx`
    INSERT INTO awcms_commerce_loyalty_programs (
      tenant_id, version, name, status, earn_unit_amount, earn_points_per_unit,
      min_order_amount, max_points_per_order, expiry_days, notes,
      eligibility_segment_id, eligibility_segment_version,
      created_by_tenant_user_id
    ) VALUES (
      ${tenantId},
      (SELECT COALESCE(MAX(version), 0) + 1
         FROM awcms_commerce_loyalty_programs WHERE tenant_id = ${tenantId}),
      ${input.name}, 'draft', ${input.earnUnitAmount}, ${input.earnPointsPerUnit},
      ${input.minOrderAmount}, ${input.maxPointsPerOrder}::integer,
      ${input.expiryDays}::integer, ${input.notes}::text,
      ${input.eligibilitySegmentId}::uuid, ${input.eligibilitySegmentVersion}::integer,
      ${actorTenantUserId}
    )
    RETURNING id, version, name, status, effective_from, effective_to,
      earn_unit_amount, earn_points_per_unit, earn_rounding, min_order_amount,
      max_points_per_order, expiry_days, notes, eligibility_segment_id,
      eligibility_segment_version, created_at, updated_at
  `) as ProgramRow[];
  const program = toProgram(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "commerce.loyalty.program_created",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: program.id,
    message: `Loyalty program version ${program.version} created (draft).`,
    attributes: {
      version: program.version,
      eligibilitySegmentId: program.eligibilitySegmentId,
      eligibilitySegmentVersion: program.eligibilitySegmentVersion
    },
    correlationId
  });
  return program;
}

export type EligibilityReference = {
  segmentId: string;
  version: number;
};

/**
 * Resolves the segment a program is to be restricted to (Issue #361): the
 * segment must exist in this tenant and be live (a retired segment is not a
 * choice for a NEW restriction, though a program that already recorded it
 * keeps it), and the version is the one asked for or, when omitted, the
 * segment's latest AT THIS INSTANT - the pinned number is what gets stored, so
 * a later edit of the segment never moves the program. `null` for an unknown,
 * foreign-tenant, retired or non-existent id/version, indistinguishably.
 */
export async function resolveEligibilityReference(
  tx: Bun.SQL,
  tenantId: string,
  segmentId: string,
  version: number | null
): Promise<EligibilityReference | null> {
  const rows = (await tx`
    SELECT v.version
    FROM awcms_commerce_segments s
    JOIN awcms_commerce_segment_versions v
      ON v.tenant_id = s.tenant_id AND v.segment_id = s.id
      AND v.version = COALESCE(${version}::int, s.latest_version)
    WHERE s.tenant_id = ${tenantId} AND s.id = ${segmentId}
      AND s.retired_at IS NULL
  `) as { version: number }[];
  return rows[0] ? { segmentId, version: Number(rows[0].version) } : null;
}

export type UpdateProgramResult =
  | { kind: "updated"; program: LoyaltyProgram }
  | { kind: "not_found" }
  | { kind: "not_draft" };

/** Edits a DRAFT version. An active/retired version is immutable (see this file's header). */
export async function updateLoyaltyProgram(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  programId: string,
  patch: LoyaltyProgramPatch,
  correlationId?: string
): Promise<UpdateProgramResult> {
  const existing = await fetchLoyaltyProgram(tx, tenantId, programId);
  if (!existing) return { kind: "not_found" };
  if (existing.status !== "draft") return { kind: "not_draft" };

  const next = {
    name: patch.name ?? existing.name,
    earnUnitAmount: patch.earnUnitAmount ?? existing.earnUnitAmount,
    earnPointsPerUnit: patch.earnPointsPerUnit ?? existing.earnPointsPerUnit,
    minOrderAmount: patch.minOrderAmount ?? existing.minOrderAmount,
    maxPointsPerOrder:
      patch.maxPointsPerOrder !== undefined
        ? patch.maxPointsPerOrder
        : existing.maxPointsPerOrder,
    expiryDays:
      patch.expiryDays !== undefined ? patch.expiryDays : existing.expiryDays,
    notes: patch.notes !== undefined ? patch.notes : existing.notes,
    eligibilitySegmentId:
      patch.eligibilitySegmentId !== undefined
        ? patch.eligibilitySegmentId
        : existing.eligibilitySegmentId,
    eligibilitySegmentVersion:
      patch.eligibilitySegmentId !== undefined
        ? (patch.eligibilitySegmentVersion ?? null)
        : existing.eligibilitySegmentVersion
  };

  const rows = (await tx`
    UPDATE awcms_commerce_loyalty_programs
    SET name = ${next.name}, earn_unit_amount = ${next.earnUnitAmount},
      earn_points_per_unit = ${next.earnPointsPerUnit},
      min_order_amount = ${next.minOrderAmount},
      max_points_per_order = ${next.maxPointsPerOrder}::integer,
      expiry_days = ${next.expiryDays}::integer, notes = ${next.notes}::text,
      eligibility_segment_id = ${next.eligibilitySegmentId}::uuid,
      eligibility_segment_version = ${next.eligibilitySegmentVersion}::integer,
      updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${programId} AND status = 'draft'
    RETURNING id, version, name, status, effective_from, effective_to,
      earn_unit_amount, earn_points_per_unit, earn_rounding, min_order_amount,
      max_points_per_order, expiry_days, notes, eligibility_segment_id,
      eligibility_segment_version, created_at, updated_at
  `) as ProgramRow[];
  if (!rows[0]) return { kind: "not_draft" };
  const program = toProgram(rows[0]);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "commerce.loyalty.program_updated",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: program.id,
    message: `Loyalty program version ${program.version} edited.`,
    attributes: {
      version: program.version,
      fields: Object.keys(patch),
      eligibilitySegmentId: program.eligibilitySegmentId,
      eligibilitySegmentVersion: program.eligibilitySegmentVersion
    },
    correlationId
  });
  return { kind: "updated", program };
}

export type ActivateProgramResult =
  | { kind: "activated"; program: LoyaltyProgram; closedVersion: number | null }
  | { kind: "not_found" }
  | { kind: "not_draft" };

/**
 * Activates a draft NOW: `effective_from = now`, and the version that was open
 * at that instant is closed (`effective_to = now`, `retired`) in the same
 * transaction, under the per-tenant lock. Activation is immediate by design —
 * a future-dated switch would need a scheduler to be honest about "when did
 * this start", and an immediate one needs none.
 */
export async function activateLoyaltyProgram(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  programId: string,
  now: Date,
  correlationId?: string
): Promise<ActivateProgramResult> {
  await lockProgramsForTenant(tx, tenantId);

  const target = await fetchLoyaltyProgram(tx, tenantId, programId);
  if (!target) return { kind: "not_found" };
  if (target.status !== "draft") return { kind: "not_draft" };

  const open = (await tx`
    SELECT id, version, effective_from
    FROM awcms_commerce_loyalty_programs
    WHERE tenant_id = ${tenantId} AND status = 'active' AND effective_to IS NULL
    FOR UPDATE
  `) as { id: string; version: number; effective_from: Date | string }[];

  // The window check demands `to > from`; never start at or before the
  // version being closed (only reachable by two activations in one millisecond).
  let startMs = now.getTime();
  for (const row of open) {
    startMs = Math.max(startMs, new Date(row.effective_from).getTime() + 1);
  }
  const start = new Date(startMs);

  let closedVersion: number | null = null;
  for (const row of open) {
    await tx`
      UPDATE awcms_commerce_loyalty_programs
      SET status = 'retired', effective_to = ${start}, updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${row.id}
    `;
    closedVersion = Number(row.version);
  }

  const rows = (await tx`
    UPDATE awcms_commerce_loyalty_programs
    SET status = 'active', effective_from = ${start}, effective_to = NULL,
      updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${programId} AND status = 'draft'
    RETURNING id, version, name, status, effective_from, effective_to,
      earn_unit_amount, earn_points_per_unit, earn_rounding, min_order_amount,
      max_points_per_order, expiry_days, notes, eligibility_segment_id,
      eligibility_segment_version, created_at, updated_at
  `) as ProgramRow[];
  const program = toProgram(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "commerce.loyalty.program_activated",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: program.id,
    message: `Loyalty program version ${program.version} activated${closedVersion === null ? "" : `, replacing version ${closedVersion}`}.`,
    attributes: {
      version: program.version,
      closedVersion,
      eligibilitySegmentId: program.eligibilitySegmentId,
      eligibilitySegmentVersion: program.eligibilitySegmentVersion
    },
    correlationId
  });
  return { kind: "activated", program, closedVersion };
}

export type RetireProgramResult =
  | { kind: "retired"; program: LoyaltyProgram }
  | { kind: "not_found" }
  | { kind: "not_active" };

/** Ends the open active version NOW. Orders paid afterwards earn nothing until another version is activated; points already earned are untouched. */
export async function retireLoyaltyProgram(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  programId: string,
  now: Date,
  correlationId?: string
): Promise<RetireProgramResult> {
  await lockProgramsForTenant(tx, tenantId);

  const target = await fetchLoyaltyProgram(tx, tenantId, programId);
  if (!target) return { kind: "not_found" };
  if (target.status !== "active" || target.effectiveTo !== null) {
    return { kind: "not_active" };
  }

  const endMs = Math.max(now.getTime(), Date.parse(target.effectiveFrom!) + 1);
  const rows = (await tx`
    UPDATE awcms_commerce_loyalty_programs
    SET status = 'retired', effective_to = ${new Date(endMs)}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${programId} AND status = 'active'
    RETURNING id, version, name, status, effective_from, effective_to,
      earn_unit_amount, earn_points_per_unit, earn_rounding, min_order_amount,
      max_points_per_order, expiry_days, notes, eligibility_segment_id,
      eligibility_segment_version, created_at, updated_at
  `) as ProgramRow[];
  const program = toProgram(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "commerce.loyalty.program_retired",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: program.id,
    message: `Loyalty program version ${program.version} retired.`,
    attributes: { version: program.version },
    correlationId
  });
  return { kind: "retired", program };
}
