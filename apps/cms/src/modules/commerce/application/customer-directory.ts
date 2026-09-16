/**
 * `awcms_commerce_customers` persistence — Issue #29.
 *
 * A **guest** order creates or reuses the customer row by phone
 * (`findOrCreateCustomerByPhone`) — there is no login/password yet
 * (accounts are Issue #32), so "the customer" is entirely defined by having
 * placed at least one order under a given phone number. `phone` is stored
 * in the clear (`sql/165`'s header) since it is also the tracking
 * CREDENTIAL; every place this module hands a customer record to a caller
 * outside the transaction that authenticated the phone (the admin screens)
 * masks it first via `domain/phone-normalisation.ts`'s `maskPhone`.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  keysetCursorCreatedAtSql,
  encodeKeysetCursor,
  type KeysetCursor
} from "../../_shared/keyset-pagination";
import { maskPhone } from "../domain/phone-normalisation";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "customer";

export const CUSTOMER_LIST_LIMIT = 100;

type CustomerRow = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  level: number;
  status: string;
  created_at: Date;
};

/** The OWNER shape — `phone` unmasked, for the admin screen only. Never returned by an anonymous route. */
export type CustomerAdminRecord = {
  id: string;
  name: string;
  phone: string;
  phoneMasked: string;
  email: string | null;
  level: number;
  status: "active" | "blocked";
  createdAt: string;
};

function toAdminRecord(row: CustomerRow): CustomerAdminRecord {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    phoneMasked: maskPhone(row.phone),
    email: row.email,
    level: row.level,
    status: row.status as "active" | "blocked",
    createdAt: row.created_at.toISOString()
  };
}

/**
 * Finds a LIVE customer by their normalised phone in this tenant, creating
 * one when none exists — the "guest checkout" identity model this increment
 * ships (no password, no session). Runs inside the SAME transaction as the
 * order it is being resolved for, so a concurrent double-submit either finds
 * the row the other request just committed or collides on the unique index
 * and retries once (mirroring `createProduct`'s slug-collision handling).
 */
export async function findOrCreateCustomerByPhone(
  tx: Bun.SQL,
  tenantId: string,
  name: string,
  phone: string,
  email: string | null,
  correlationId?: string
): Promise<CustomerAdminRecord> {
  const existingRows = (await tx`
    SELECT id, name, phone, email, level, status, created_at
    FROM awcms_commerce_customers
    WHERE tenant_id = ${tenantId} AND phone = ${phone} AND deleted_at IS NULL
  `) as CustomerRow[];

  if (existingRows[0]) return toAdminRecord(existingRows[0]);

  let rows: CustomerRow[];
  try {
    rows = (await tx`
      INSERT INTO awcms_commerce_customers (tenant_id, name, phone, email)
      VALUES (${tenantId}, ${name}, ${phone}, ${email})
      RETURNING id, name, phone, email, level, status, created_at
    `) as CustomerRow[];
  } catch (error) {
    if (
      error instanceof Bun.SQL.PostgresError &&
      String(error.errno) === "23505"
    ) {
      // Lost a create race against a concurrent double-submit — the row now
      // exists, read it back rather than failing the order.
      const retryRows = (await tx`
        SELECT id, name, phone, email, level, status, created_at
        FROM awcms_commerce_customers
        WHERE tenant_id = ${tenantId} AND phone = ${phone} AND deleted_at IS NULL
      `) as CustomerRow[];
      if (retryRows[0]) return toAdminRecord(retryRows[0]);
    }
    throw error;
  }

  const record = toAdminRecord(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "create",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: record.id,
    message: "Customer created via guest checkout.",
    attributes: { phoneMasked: record.phoneMasked },
    correlationId
  });

  return record;
}

export async function fetchCustomerById(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string
): Promise<CustomerAdminRecord | null> {
  const rows = (await tx`
    SELECT id, name, phone, email, level, status, created_at
    FROM awcms_commerce_customers
    WHERE tenant_id = ${tenantId} AND id = ${customerId} AND deleted_at IS NULL
  `) as CustomerRow[];
  return rows[0] ? toAdminRecord(rows[0]) : null;
}

export type CustomerListPage = {
  items: CustomerAdminRecord[];
  nextCursor: string | null;
};

/** Admin list — `GET /api/v1/commerce/customers`. */
export async function listCustomers(
  tx: Bun.SQL,
  tenantId: string,
  cursor: KeysetCursor | null = null
): Promise<CustomerListPage> {
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;

  const rows = (await tx`
    SELECT id, name, phone, email, level, status, created_at,
           ${tx.unsafe(keysetCursorCreatedAtSql())} AS created_at_cursor
    FROM awcms_commerce_customers
    WHERE tenant_id = ${tenantId}
      AND deleted_at IS NULL
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (created_at, id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${CUSTOMER_LIST_LIMIT}
  `) as (CustomerRow & { created_at_cursor: string })[];

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === CUSTOMER_LIST_LIMIT && last
      ? encodeKeysetCursor(last.created_at_cursor, last.id)
      : null;

  return { items: rows.map(toAdminRecord), nextCursor };
}

export type UpdateCustomerInput = {
  level?: number;
  status?: "active" | "blocked";
};

/** Admin edit — `PATCH /api/v1/commerce/customers/{id}` (level/status only; `name`/`phone`/`email` are the guest's own submission, never admin-edited in this increment). */
export async function updateCustomer(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  customerId: string,
  input: UpdateCustomerInput,
  correlationId?: string
): Promise<CustomerAdminRecord | null> {
  const existing = await fetchCustomerById(tx, tenantId, customerId);
  if (!existing) return null;

  const rows = (await tx`
    UPDATE awcms_commerce_customers
    SET
      level = ${input.level ?? existing.level},
      status = ${input.status ?? existing.status},
      updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${customerId} AND deleted_at IS NULL
    RETURNING id, name, phone, email, level, status, created_at
  `) as CustomerRow[];

  if (rows.length === 0) return null;

  const record = toAdminRecord(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: record.id,
    message: "Customer updated.",
    attributes: { fields: Object.keys(input) },
    correlationId
  });

  return record;
}

/**
 * Persists one address snapshot against the customer — a plain append, no
 * dedup/merge in this increment (a returning guest simply accumulates
 * addresses; there is no address-management UI yet to edit/delete one). The
 * first address a customer ever gets is marked `is_default`.
 */
export async function saveCustomerAddress(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string,
  address: {
    label: string | null;
    recipientName: string;
    phone: string;
    provinceCode: string;
    provinceName: string;
    cityCode: string;
    cityName: string;
    districtCode: string;
    districtName: string;
    postalCode: string | null;
    street: string;
    latitude: number | null;
    longitude: number | null;
    notes: string | null;
  }
): Promise<void> {
  const existingRows = (await tx`
    SELECT 1 FROM awcms_commerce_customer_addresses
    WHERE tenant_id = ${tenantId} AND customer_id = ${customerId} AND deleted_at IS NULL
  `) as unknown[];
  const isFirst = existingRows.length === 0;

  await tx`
    INSERT INTO awcms_commerce_customer_addresses (
      tenant_id, customer_id, label, recipient_name, phone,
      province_code, province_name, city_code, city_name,
      district_code, district_name, postal_code, street,
      latitude, longitude, notes, is_default
    )
    VALUES (
      ${tenantId}, ${customerId}, ${address.label}, ${address.recipientName}, ${address.phone},
      ${address.provinceCode}, ${address.provinceName}, ${address.cityCode}, ${address.cityName},
      ${address.districtCode}, ${address.districtName}, ${address.postalCode}, ${address.street},
      ${address.latitude}, ${address.longitude}, ${address.notes}, ${isFirst}
    )
  `;
}
