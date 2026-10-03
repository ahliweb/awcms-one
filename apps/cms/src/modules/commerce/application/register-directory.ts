/**
 * POS register definitions (Issue #284, ADR-0028) — the CRUD half of the
 * register model: a register is a named till (`code`, `name`, optional
 * `locationLabel`, `active`). Sessions, movements and the cash-up live in
 * `register-session-directory.ts` / `register-cash-up.ts`.
 *
 * A register is never deleted: it is deactivated (`active = false`), because
 * its sessions are fiscal records that keep pointing at it. A register with a
 * live (open/closing) session cannot be deactivated — that would orphan a
 * shift mid-flight with no way to open its replacement.
 *
 * Tenant isolation: every query filters on `tenant_id` explicitly on top of
 * RLS, and an id from another tenant resolves to nothing, exactly like an
 * unknown id (no BOLA oracle).
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import type {
  CreateRegisterInput,
  RegisterSessionStatus,
  UpdateRegisterInput
} from "../domain/register";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "register";
const POSTGRES_UNIQUE_VIOLATION = "23505";
const CODE_CONSTRAINT = "awcms_commerce_registers_tenant_code_key";

export const REGISTER_LIST_LIMIT = 200;

export type RegisterActiveSession = {
  id: string;
  status: RegisterSessionStatus;
  currentCashierTenantUserId: string;
  openedAt: string;
};

export type RegisterRecord = {
  id: string;
  code: string;
  name: string;
  locationLabel: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  /** The register's single active (open/closing) session, if any. */
  activeSession: RegisterActiveSession | null;
};

type RegisterRow = {
  id: string;
  code: string;
  name: string;
  location_label: string | null;
  active: boolean;
  created_at: Date;
  updated_at: Date;
  session_id: string | null;
  session_status: string | null;
  session_cashier: string | null;
  session_opened_at: Date | null;
};

function toRecord(row: RegisterRow): RegisterRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    locationLabel: row.location_label,
    active: row.active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    activeSession:
      row.session_id !== null
        ? {
            id: row.session_id,
            status: row.session_status as RegisterSessionStatus,
            currentCashierTenantUserId: row.session_cashier!,
            openedAt: row.session_opened_at!.toISOString()
          }
        : null
  };
}

/** Registers, active ones first then by code; each carries its live session (at most one, the partial unique index guarantees it). */
export async function listRegisters(
  tx: Bun.SQL,
  tenantId: string,
  options: { includeInactive?: boolean } = {}
): Promise<RegisterRecord[]> {
  const includeInactive = options.includeInactive ?? true;
  const rows = (await tx`
    SELECT r.id, r.code, r.name, r.location_label, r.active, r.created_at, r.updated_at,
           s.id AS session_id, s.status AS session_status,
           s.current_cashier_tenant_user_id AS session_cashier,
           s.opened_at AS session_opened_at
    FROM awcms_commerce_registers r
    LEFT JOIN awcms_commerce_register_sessions s
      ON s.tenant_id = r.tenant_id AND s.register_id = r.id
     AND s.status IN ('open', 'closing')
    WHERE r.tenant_id = ${tenantId}
      AND r.deleted_at IS NULL
      AND (${includeInactive}::boolean OR r.active)
    ORDER BY r.active DESC, lower(r.code) ASC, r.id ASC
    LIMIT ${REGISTER_LIST_LIMIT}
  `) as RegisterRow[];
  return rows.map(toRecord);
}

export async function fetchRegister(
  tx: Bun.SQL,
  tenantId: string,
  registerId: string
): Promise<RegisterRecord | null> {
  const rows = (await tx`
    SELECT r.id, r.code, r.name, r.location_label, r.active, r.created_at, r.updated_at,
           s.id AS session_id, s.status AS session_status,
           s.current_cashier_tenant_user_id AS session_cashier,
           s.opened_at AS session_opened_at
    FROM awcms_commerce_registers r
    LEFT JOIN awcms_commerce_register_sessions s
      ON s.tenant_id = r.tenant_id AND s.register_id = r.id
     AND s.status IN ('open', 'closing')
    WHERE r.tenant_id = ${tenantId} AND r.id = ${registerId} AND r.deleted_at IS NULL
  `) as RegisterRow[];
  return rows[0] ? toRecord(rows[0]) : null;
}

export type CreateRegisterOutcome =
  { kind: "created"; register: RegisterRecord } | { kind: "code_taken" };

export async function createRegister(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateRegisterInput,
  correlationId?: string
): Promise<CreateRegisterOutcome> {
  let id: string;
  try {
    const rows = (await tx`
      INSERT INTO awcms_commerce_registers (
        tenant_id, code, name, location_label,
        created_by_tenant_user_id, updated_by_tenant_user_id
      )
      VALUES (
        ${tenantId}, ${input.code}, ${input.name}, ${input.locationLabel},
        ${actorTenantUserId}, ${actorTenantUserId}
      )
      RETURNING id
    `) as { id: string }[];
    id = rows[0]!.id;
  } catch (error) {
    if (
      error instanceof Bun.SQL.PostgresError &&
      String(error.errno) === POSTGRES_UNIQUE_VIOLATION &&
      error.constraint === CODE_CONSTRAINT
    ) {
      return { kind: "code_taken" };
    }
    throw error;
  }

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "register.create",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: id,
    message: `POS register ${input.code} defined.`,
    attributes: { code: input.code },
    correlationId
  });

  const register = await fetchRegister(tx, tenantId, id);
  return { kind: "created", register: register! };
}

export type UpdateRegisterOutcome =
  | { kind: "not_found" }
  | { kind: "has_active_session" }
  | { kind: "updated"; register: RegisterRecord };

export async function updateRegister(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  registerId: string,
  input: UpdateRegisterInput,
  correlationId?: string
): Promise<UpdateRegisterOutcome> {
  // The register row lock serialises this against a concurrent open (which
  // locks the same row): a register cannot be deactivated in the instant a
  // session is being opened on it.
  const locked = (await tx`
    SELECT id, code, name, location_label, active
    FROM awcms_commerce_registers
    WHERE tenant_id = ${tenantId} AND id = ${registerId} AND deleted_at IS NULL
    FOR NO KEY UPDATE
  `) as {
    id: string;
    code: string;
    name: string;
    location_label: string | null;
    active: boolean;
  }[];
  const current = locked[0];
  if (!current) return { kind: "not_found" };

  if (input.active === false && current.active) {
    const live = (await tx`
      SELECT 1 AS present
      FROM awcms_commerce_register_sessions
      WHERE tenant_id = ${tenantId} AND register_id = ${registerId}
        AND status IN ('open', 'closing')
      LIMIT 1
    `) as { present: number }[];
    if (live.length > 0) return { kind: "has_active_session" };
  }

  const name = input.name ?? current.name;
  const locationLabel =
    input.locationLabel !== undefined
      ? input.locationLabel
      : current.location_label;
  const active = input.active ?? current.active;

  await tx`
    UPDATE awcms_commerce_registers
    SET name = ${name}, location_label = ${locationLabel}, active = ${active},
        updated_by_tenant_user_id = ${actorTenantUserId}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${registerId}
  `;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "register.update",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: registerId,
    message: `POS register ${current.code} updated.`,
    attributes: {
      code: current.code,
      nameChanged: name !== current.name,
      locationChanged: locationLabel !== current.location_label,
      active
    },
    correlationId
  });

  const register = await fetchRegister(tx, tenantId, registerId);
  return { kind: "updated", register: register! };
}
