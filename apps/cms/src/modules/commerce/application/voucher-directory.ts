import { normalizeMoney } from "../domain/price-calculation";
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  keysetCursorCreatedAtSql,
  encodeKeysetCursor,
  type KeysetCursor
} from "../../_shared/keyset-pagination";
import {
  evaluateVoucher,
  type VoucherEvaluationReason
} from "../domain/voucher-arithmetic";
import type {
  CreateVoucherInput,
  UpdateVoucherInput,
  VoucherStatus,
  VoucherType
} from "../domain/voucher-validation";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "voucher";
const POSTGRES_UNIQUE_VIOLATION = "23505";
const VOUCHERS_CODE_CONSTRAINT = "awcms_commerce_vouchers_tenant_code_key";

export const VOUCHER_LIST_LIMIT = 100;

export class DuplicateVoucherCodeError extends Error {
  constructor(code: string) {
    super(`A voucher with code "${code}" already exists for this tenant.`);
    this.name = "DuplicateVoucherCodeError";
  }
}

type VoucherRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  type: string;
  value: string;
  min_order: string;
  max_discount: string | null;
  quota: number;
  used_count: number;
  is_public: boolean;
  status: string;
  starts_at: Date;
  ends_at: Date;
};

/** The OWNER wire shape — every column, including `status` (see `voucher-validation.ts`'s header for why it is never in the PUBLIC contract's `reason` enum). */
export type VoucherRecord = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  type: VoucherType;
  value: string;
  minOrder: string;
  maxDiscount: string | null;
  quota: number;
  usedCount: number;
  isPublic: boolean;
  status: VoucherStatus;
  startsAt: string;
  endsAt: string;
};

function toRecord(row: VoucherRow): VoucherRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    type: row.type as VoucherType,
    value: normalizeMoney(row.value),
    minOrder: normalizeMoney(row.min_order),
    maxDiscount: normalizeMoney(row.max_discount),
    quota: row.quota,
    usedCount: row.used_count,
    isPublic: row.is_public,
    status: row.status as VoucherStatus,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString()
  };
}

const VOUCHER_COLUMNS = `
  id, code, name, description, type, value, min_order, max_discount,
  quota, used_count, is_public, status, starts_at, ends_at
`;

export type VoucherListPage = {
  items: VoucherRecord[];
  nextCursor: string | null;
};

export async function listVouchers(
  tx: Bun.SQL,
  tenantId: string,
  cursor: KeysetCursor | null = null
): Promise<VoucherListPage> {
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;

  const rows = (await tx`
    SELECT ${tx.unsafe(VOUCHER_COLUMNS)},
           ${tx.unsafe(keysetCursorCreatedAtSql())} AS created_at_cursor
    FROM awcms_commerce_vouchers
    WHERE tenant_id = ${tenantId}
      AND deleted_at IS NULL
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (created_at, id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${VOUCHER_LIST_LIMIT}
  `) as (VoucherRow & { created_at_cursor: string })[];

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === VOUCHER_LIST_LIMIT && last
      ? encodeKeysetCursor(last.created_at_cursor, last.id)
      : null;

  return { items: rows.map(toRecord), nextCursor };
}

export async function fetchVoucherById(
  tx: Bun.SQL,
  tenantId: string,
  voucherId: string
): Promise<VoucherRecord | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(VOUCHER_COLUMNS)}
    FROM awcms_commerce_vouchers
    WHERE tenant_id = ${tenantId} AND id = ${voucherId} AND deleted_at IS NULL
  `) as VoucherRow[];

  return rows[0] ? toRecord(rows[0]) : null;
}

export async function createVoucher(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateVoucherInput,
  correlationId?: string
): Promise<VoucherRecord> {
  let rows: VoucherRow[];

  try {
    rows = (await tx`
      INSERT INTO awcms_commerce_vouchers (
        tenant_id, code, name, description, type, value, min_order, max_discount,
        quota, is_public, starts_at, ends_at
      )
      VALUES (
        ${tenantId}, ${input.code}, ${input.name}, ${input.description}, ${input.type},
        ${input.value}, ${input.minOrder}, ${input.maxDiscount},
        ${input.quota}, ${input.isPublic}, ${input.startsAt}, ${input.endsAt}
      )
      RETURNING ${tx.unsafe(VOUCHER_COLUMNS)}
    `) as VoucherRow[];
  } catch (error) {
    if (
      error instanceof Bun.SQL.PostgresError &&
      String(error.errno) === POSTGRES_UNIQUE_VIOLATION &&
      error.constraint === VOUCHERS_CODE_CONSTRAINT
    ) {
      throw new DuplicateVoucherCodeError(input.code);
    }
    throw error;
  }

  const record = toRecord(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "create",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: record.id,
    message: `Voucher created: ${record.code}.`,
    attributes: { code: record.code, type: record.type },
    correlationId
  });

  return record;
}

export async function updateVoucher(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  voucherId: string,
  input: UpdateVoucherInput,
  correlationId?: string
): Promise<VoucherRecord | null> {
  const existing = await fetchVoucherById(tx, tenantId, voucherId);
  if (!existing) return null;

  let rows: VoucherRow[];

  try {
    rows = (await tx`
      UPDATE awcms_commerce_vouchers
      SET
        code = ${input.code ?? existing.code},
        name = ${input.name ?? existing.name},
        description = ${input.description === undefined ? existing.description : input.description},
        type = ${input.type ?? existing.type},
        value = ${input.value ?? existing.value},
        min_order = ${input.minOrder ?? existing.minOrder},
        max_discount = ${input.maxDiscount === undefined ? existing.maxDiscount : input.maxDiscount},
        quota = ${input.quota ?? existing.quota},
        is_public = ${input.isPublic ?? existing.isPublic},
        status = ${input.status ?? existing.status},
        starts_at = ${input.startsAt ?? new Date(existing.startsAt)},
        ends_at = ${input.endsAt ?? new Date(existing.endsAt)},
        updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${voucherId} AND deleted_at IS NULL
      RETURNING ${tx.unsafe(VOUCHER_COLUMNS)}
    `) as VoucherRow[];
  } catch (error) {
    if (
      error instanceof Bun.SQL.PostgresError &&
      String(error.errno) === POSTGRES_UNIQUE_VIOLATION &&
      error.constraint === VOUCHERS_CODE_CONSTRAINT
    ) {
      throw new DuplicateVoucherCodeError(input.code ?? existing.code);
    }
    throw error;
  }

  if (rows.length === 0) return null;

  const record = toRecord(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: record.id,
    message: "Voucher updated.",
    attributes: { fields: Object.keys(input) },
    correlationId
  });

  return record;
}

export async function deleteVoucher(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  voucherId: string,
  correlationId?: string
): Promise<boolean> {
  const rows = await tx`
    UPDATE awcms_commerce_vouchers
    SET deleted_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${voucherId} AND deleted_at IS NULL
    RETURNING id
  `;

  if (rows.length === 0) return false;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "delete",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: voucherId,
    severity: "warning",
    message: "Voucher soft-deleted.",
    correlationId
  });

  return true;
}

/** `GET /api/v1/commerce/vouchers/public` — public, `is_public = true`, `status = 'active'`, live rows only. Window/quota filtering happens at `/validate` time, not here — a voucher may legitimately be listed before its window opens (issue #26's own contract: "Only vouchers with isPublic = true, active window, quota remaining"). */
export async function listPublicVouchers(
  tx: Bun.SQL,
  tenantId: string,
  now: Date
): Promise<VoucherRecord[]> {
  const rows = (await tx`
    SELECT ${tx.unsafe(VOUCHER_COLUMNS)}
    FROM awcms_commerce_vouchers
    WHERE tenant_id = ${tenantId}
      AND deleted_at IS NULL
      AND is_public = true
      AND status = 'active'
      AND starts_at <= ${now}
      AND ends_at >= ${now}
      AND (quota = 0 OR used_count < quota)
    ORDER BY created_at DESC
    LIMIT ${VOUCHER_LIST_LIMIT}
  `) as VoucherRow[];

  return rows.map(toRecord);
}

export type VoucherValidationOutcome =
  | {
      valid: true;
      voucher: VoucherRecord;
      discount: string;
      freeShipping: boolean;
    }
  | { valid: false; reason: VoucherEvaluationReason | "not_found" };

/**
 * `POST /api/v1/commerce/vouchers/validate` — pure lookup + arithmetic, never
 * a write (redemption is #29's job, once a real order exists —
 * `commerce-events.ts`'s header). A voucher that is soft-deleted, `inactive`,
 * or genuinely absent all resolve to `not_found` — see
 * `voucher-validation.ts`'s header for why `status` is deliberately excluded
 * from the caller-visible `reason` enum.
 */
export async function validateVoucherCode(
  tx: Bun.SQL,
  tenantId: string,
  code: string,
  subtotal: string,
  shippingCost: string,
  now: Date
): Promise<VoucherValidationOutcome> {
  const normalizedCode = code.trim().toUpperCase();

  const rows = (await tx`
    SELECT ${tx.unsafe(VOUCHER_COLUMNS)}
    FROM awcms_commerce_vouchers
    WHERE tenant_id = ${tenantId}
      AND code = ${normalizedCode}
      AND deleted_at IS NULL
      AND status = 'active'
  `) as VoucherRow[];

  const row = rows[0];
  if (!row) return { valid: false, reason: "not_found" };

  const record = toRecord(row);
  const evaluation = evaluateVoucher(
    {
      type: record.type,
      value: record.value,
      minOrder: record.minOrder,
      maxDiscount: record.maxDiscount,
      quota: record.quota,
      usedCount: record.usedCount,
      startsAt: new Date(record.startsAt),
      endsAt: new Date(record.endsAt)
    },
    subtotal,
    shippingCost,
    now
  );

  if (!evaluation.valid) return { valid: false, reason: evaluation.reason };

  return {
    valid: true,
    voucher: record,
    discount: evaluation.discount,
    freeShipping: evaluation.freeShipping
  };
}
