/**
 * Held (parked) POS sales (Issue #286, ADR-0029 D4): park a cart, list the
 * parked ones, resume or discard one.
 *
 * ## What a held sale is NOT
 *
 * It is not an order, not a reservation and not a price. It stores the cart's
 * lines (`productId`, `variantId`, `quantity`), an optional customer and notes
 * - nothing else. Stock is NEVER reserved while a sale is parked (a held cart
 * that silently blocked stock would let a forgotten cart sell out the shelf);
 * a resumed cart goes back through the ordinary POS quote, which re-prices it
 * and re-checks stock, so a sale parked yesterday is honoured at today's price
 * and today's stock - never a stale one.
 *
 * ## Ownership, expiry, resume
 *
 * A held sale belongs to the cashier who parked it. Only that cashier (under
 * `commerce.held_sales.update`) or a supervisor holding
 * `commerce.held_sales.approve` can list-all, resume or discard it; anyone else
 * gets the neutral `404` (no oracle on another cashier's carts). It expires
 * `ttlHours` after parking (default 24, at most 168): an expired cart reads as
 * `expired` the moment its time passes (no job needed - `effectiveHeldSaleStatus`)
 * and the first attempt to resume or discard it persists that. RESUME is
 * single-use: it returns the cart once and wipes the stored copy (a CHECK pins
 * a non-held row to an empty cart), because the cart now lives in the POS
 * screen's own state - exactly where an unparked cart always lived. The shared
 * idempotency store keeps the response for its own short TTL, so a lost
 * response is recoverable by retrying with the same key.
 *
 * Every mutation locks the row `FOR NO KEY UPDATE` FIRST and reads the
 * idempotency store AFTER the lock, so a retry that waited replays the first
 * request's committed answer deterministically.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../_shared/idempotency";
import {
  encodeKeysetCursor,
  keysetCursorCreatedAtSql,
  type KeysetCursor
} from "../../_shared/keyset-pagination";
import {
  buildHeldCart,
  effectiveHeldSaleStatus,
  type HeldSaleDecisionInput,
  type HeldSaleStatus,
  type HoldSaleInput
} from "../domain/documents";
import { IdempotencyPayloadMismatchError } from "./order-directory";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "held_sale";
const HOLD_SCOPE = "commerce.held_sales.hold";
const RESUME_SCOPE = "commerce.held_sales.resume";
const DISCARD_SCOPE = "commerce.held_sales.discard";

export const HELD_SALE_LIST_LIMIT = 50;
/** Parked carts one cashier may have open at once: the bound on a forgotten-cart pile. */
export const MAX_ACTIVE_HELD_SALES_PER_OWNER = 50;

export type HeldSaleRecord = {
  id: string;
  ownerTenantUserId: string;
  registerId: string | null;
  label: string | null;
  lineCount: number;
  /** Effective status: a still-held cart past its expiry reads `expired`. */
  status: HeldSaleStatus;
  heldAt: string;
  expiresAt: string;
  closedAt: string | null;
};

/** The resumed cart (the 200 body of a resume): lines only - the POS re-quotes them. */
export type ResumedHeldSale = HeldSaleRecord & {
  cart: {
    lines: { productId: string; variantId: string | null; quantity: number }[];
    customer: { name: string | null; phone: string | null } | null;
    notes: string | null;
  };
};

type HeldRow = {
  id: string;
  owner_tenant_user_id: string;
  register_id: string | null;
  label: string | null;
  cart: unknown;
  line_count: number;
  status: string;
  held_at: Date;
  expires_at: Date;
  closed_at: Date | null;
};

const HELD_COLUMNS = `id, owner_tenant_user_id, register_id, label, cart, line_count,
  status, held_at, expires_at, closed_at`;

function toRecord(row: HeldRow, now: Date): HeldSaleRecord {
  return {
    id: row.id,
    ownerTenantUserId: row.owner_tenant_user_id,
    registerId: row.register_id,
    label: row.label,
    lineCount: Number(row.line_count),
    status: effectiveHeldSaleStatus(
      row.status as HeldSaleStatus,
      row.expires_at,
      now
    ),
    heldAt: row.held_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    closedAt: row.closed_at ? row.closed_at.toISOString() : null
  };
}

// ---------------------------------------------------------------------------
// Hold
// ---------------------------------------------------------------------------

export type HoldSaleOutcome =
  | { kind: "register_not_found" }
  | { kind: "limit_reached"; limit: number }
  | { kind: "created" | "replayed"; heldSale: HeldSaleRecord };

export async function holdSale(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: HoldSaleInput,
  now: Date = new Date(),
  correlationId?: string
): Promise<HoldSaleOutcome> {
  const requestHash = computeRequestHash({
    action: HOLD_SCOPE,
    actorTenantUserId,
    label: input.label,
    lines: input.lines,
    customer: input.customer,
    notes: input.notes,
    registerId: input.registerId,
    ttlHours: input.ttlHours
  });
  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    HOLD_SCOPE,
    input.idempotencyKey
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      heldSale: existing.responseBody as HeldSaleRecord
    };
  }

  if (input.registerId) {
    const registers = (await tx`
      SELECT id FROM awcms_commerce_registers
      WHERE tenant_id = ${tenantId} AND id = ${input.registerId} AND deleted_at IS NULL
    `) as { id: string }[];
    if (!registers[0]) return { kind: "register_not_found" };
  }

  const active = (await tx`
    SELECT count(*)::int AS n
    FROM awcms_commerce_held_sales
    WHERE tenant_id = ${tenantId} AND owner_tenant_user_id = ${actorTenantUserId}
      AND status = 'held' AND expires_at > ${now}
  `) as { n: number }[];
  if (Number(active[0]!.n) >= MAX_ACTIVE_HELD_SALES_PER_OWNER) {
    return { kind: "limit_reached", limit: MAX_ACTIVE_HELD_SALES_PER_OWNER };
  }

  const expiresAt = new Date(now.getTime() + input.ttlHours * 3_600_000);
  const cart = buildHeldCart(input);
  const rows = (await tx`
    INSERT INTO awcms_commerce_held_sales (
      tenant_id, owner_tenant_user_id, register_id, label, cart, line_count,
      held_at, expires_at
    )
    VALUES (
      ${tenantId}, ${actorTenantUserId}, ${input.registerId}, ${input.label},
      ${cart}::jsonb, ${input.lines.length}, ${now}, ${expiresAt}
    )
    RETURNING ${tx.unsafe(HELD_COLUMNS)}
  `) as HeldRow[];
  const heldSale = toRecord(rows[0]!, now);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "held_sale.hold",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: heldSale.id,
    message: `A sale of ${heldSale.lineCount} line(s) was held until ${heldSale.expiresAt}.`,
    attributes: {
      lineCount: heldSale.lineCount,
      registerId: heldSale.registerId,
      expiresAt: heldSale.expiresAt
    },
    correlationId
  });

  await saveIdempotencyRecord(
    tx,
    tenantId,
    HOLD_SCOPE,
    input.idempotencyKey,
    requestHash,
    201,
    heldSale
  );
  return { kind: "created", heldSale };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export type HeldSaleListPage = {
  items: HeldSaleRecord[];
  nextCursor: string | null;
};

/**
 * Keyset history, newest first. A caller without the supervisor key sees only
 * their own carts (`scope.all` false); `status` filters on the EFFECTIVE status.
 */
export async function listHeldSales(
  tx: Bun.SQL,
  tenantId: string,
  scope: { actorTenantUserId: string; all: boolean },
  cursor: KeysetCursor | null,
  status: HeldSaleStatus | null,
  now: Date = new Date()
): Promise<HeldSaleListPage> {
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;
  const owner = scope.all ? null : scope.actorTenantUserId;

  const rows = (await tx`
    SELECT ${tx.unsafe(HELD_COLUMNS)},
           ${tx.unsafe(keysetCursorCreatedAtSql("h"))} AS created_at_cursor
    FROM awcms_commerce_held_sales h
    WHERE h.tenant_id = ${tenantId}
      AND (${owner}::uuid IS NULL OR h.owner_tenant_user_id = ${owner})
      AND (
        ${status}::text IS NULL
        OR (${status}::text = 'held' AND h.status = 'held' AND h.expires_at > ${now})
        OR (${status}::text = 'expired' AND (h.status = 'expired' OR (h.status = 'held' AND h.expires_at <= ${now})))
        OR (${status}::text IN ('resumed', 'discarded') AND h.status = ${status}::text)
      )
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (h.created_at, h.id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY h.created_at DESC, h.id DESC
    LIMIT ${HELD_SALE_LIST_LIMIT}
  `) as (HeldRow & { created_at_cursor: string })[];

  const last = rows[rows.length - 1];
  return {
    items: rows.map((row) => toRecord(row, now)),
    nextCursor:
      rows.length === HELD_SALE_LIST_LIMIT && last
        ? encodeKeysetCursor(last.created_at_cursor, last.id)
        : null
  };
}

// ---------------------------------------------------------------------------
// Resume / discard
// ---------------------------------------------------------------------------

export type HeldSaleDecisionOutcome =
  | { kind: "not_found" }
  | { kind: "not_held"; status: HeldSaleStatus }
  | { kind: "expired"; heldSale: HeldSaleRecord }
  | { kind: "done" | "replayed"; heldSale: HeldSaleRecord | ResumedHeldSale };

async function decide(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  canOverride: SupervisorCheck,
  heldSaleId: string,
  input: HeldSaleDecisionInput,
  scope: string,
  target: "resumed" | "discarded",
  now: Date,
  correlationId: string | undefined
): Promise<HeldSaleDecisionOutcome> {
  const rows = (await tx`
    SELECT ${tx.unsafe(HELD_COLUMNS)}
    FROM awcms_commerce_held_sales
    WHERE tenant_id = ${tenantId} AND id = ${heldSaleId}
    FOR NO KEY UPDATE
  `) as HeldRow[];
  const row = rows[0];
  // Another cashier's cart is the same neutral 404 as a missing one. The
  // supervisor key is consulted only when the caller is NOT the owner.
  if (!row) return { kind: "not_found" };
  if (
    row.owner_tenant_user_id !== actorTenantUserId &&
    !(await canOverride())
  ) {
    return { kind: "not_found" };
  }

  const requestHash = computeRequestHash({
    action: scope,
    actorTenantUserId,
    heldSaleId
  });
  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    scope,
    input.idempotencyKey
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      heldSale: existing.responseBody as HeldSaleRecord | ResumedHeldSale
    };
  }

  if (row.status !== "held") {
    return { kind: "not_held", status: row.status as HeldSaleStatus };
  }

  if (row.expires_at.getTime() <= now.getTime()) {
    // Persist the lazy expiry (a returned 409 still commits this).
    const expired = (await tx`
      UPDATE awcms_commerce_held_sales
      SET status = 'expired', cart = '{}'::jsonb, closed_at = ${now},
          closed_by_tenant_user_id = ${actorTenantUserId}, updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${heldSaleId}
      RETURNING ${tx.unsafe(HELD_COLUMNS)}
    `) as HeldRow[];
    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId,
      moduleKey: AUDIT_MODULE_KEY,
      action: "held_sale.expire",
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: heldSaleId,
      message: "A held sale was found past its expiry and closed.",
      attributes: { expiresAt: row.expires_at.toISOString() },
      correlationId
    });
    return { kind: "expired", heldSale: toRecord(expired[0]!, now) };
  }

  const cart = row.cart as ResumedHeldSale["cart"];
  const updated = (await tx`
    UPDATE awcms_commerce_held_sales
    SET status = ${target}, cart = '{}'::jsonb, closed_at = ${now},
        closed_by_tenant_user_id = ${actorTenantUserId}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${heldSaleId}
    RETURNING ${tx.unsafe(HELD_COLUMNS)}
  `) as HeldRow[];
  const record = toRecord(updated[0]!, now);
  const body: HeldSaleRecord | ResumedHeldSale =
    target === "resumed" ? { ...record, cart } : record;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: target === "resumed" ? "held_sale.resume" : "held_sale.discard",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: heldSaleId,
    message: `A held sale was ${target}${row.owner_tenant_user_id === actorTenantUserId ? "" : " by a supervisor"}.`,
    attributes: {
      lineCount: record.lineCount,
      ownerTenantUserId: row.owner_tenant_user_id,
      bySupervisor: row.owner_tenant_user_id !== actorTenantUserId
    },
    correlationId
  });

  await saveIdempotencyRecord(
    tx,
    tenantId,
    scope,
    input.idempotencyKey,
    requestHash,
    200,
    body
  );
  return { kind: "done", heldSale: body };
}

/** Lazily answers "does the caller hold `commerce.held_sales.approve`?" - only invoked for another cashier's cart. */
export type SupervisorCheck = () => Promise<boolean>;

export function resumeHeldSale(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  canOverride: SupervisorCheck,
  heldSaleId: string,
  input: HeldSaleDecisionInput,
  now: Date = new Date(),
  correlationId?: string
): Promise<HeldSaleDecisionOutcome> {
  return decide(
    tx,
    tenantId,
    actorTenantUserId,
    canOverride,
    heldSaleId,
    input,
    RESUME_SCOPE,
    "resumed",
    now,
    correlationId
  );
}

export function discardHeldSale(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  canOverride: SupervisorCheck,
  heldSaleId: string,
  input: HeldSaleDecisionInput,
  now: Date = new Date(),
  correlationId?: string
): Promise<HeldSaleDecisionOutcome> {
  return decide(
    tx,
    tenantId,
    actorTenantUserId,
    canOverride,
    heldSaleId,
    input,
    DISCARD_SCOPE,
    "discarded",
    now,
    correlationId
  );
}
