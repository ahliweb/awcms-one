/**
 * Loyalty point redemption into an order - Issue #363, ADR-0043.
 *
 * Spending points on an order is two facts that commit together or not at all
 * (threat-model control C-30): a `redeem` row on the points ledger (the debit)
 * and a discount line on the order. They are written in the order's own
 * transaction, in two steps that bracket the order insert:
 *
 *   1. {@link prepareRedemption} - BEFORE the order row exists. Resolves the
 *      tenant's terms, refuses (writing nothing but lazy expiry rows, see
 *      below) whatever cannot be honoured, locks the customer's account row
 *      `FOR UPDATE` and returns the discount to put on the order. The lock is
 *      held to the end of the transaction, so nothing can spend the points
 *      between this check and the debit.
 *   2. {@link commitRedemption} - AFTER the order row exists. Appends the
 *      `redeem` ledger row through `loyalty-ledger.ts`'s one writer, and
 *      inserts the write-once redemption record. It cannot fail for a
 *      balance reason - the lock is still held - so a thrown error here is a
 *      bug or a database fault and rolls the whole order back.
 *
 * Refusing BEFORE writing matters because a returned 4xx commits the
 * transaction (`tenant-route.ts`): a refusal found after the order insert would
 * leave a half-built order behind. The only rows a refusal can leave are the
 * lazy `expire` rows for lots that had already lapsed, which are true facts
 * about the account and idempotent (the same thing the manual redeem does).
 *
 * ## Who the account is
 *
 * The caller passes a CUSTOMER id that it took from a verified bearer session
 * (storefront) or from the customer already attached to the order (POS). No
 * function here reads an account, customer or ledger id from a request.
 *
 * ## Giving points back
 *
 * A cancelled or expired order restores what it spent, once, with a
 * `restore` row keyed `restore:order:<orderId>`; a settled refund restores the
 * share of it that the money refunded represents, keyed
 * `restore:refund:<refundId>`. Both are compensating rows with their own source
 * identity and both run regardless of the feature toggles - turning the
 * feature off must not strand points an order is later cancelled over.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { fetchCommerceFeatures } from "./commerce-feature-gate";
import {
  appendLedgerEntry,
  expireDueLotsForLockedAccount,
  findEntryByKey,
  loadReplayEntries,
  lockAccountById,
  lockAccountForCustomer,
  type LockedAccount
} from "./loyalty-ledger";
import { assertPoints, type LoyaltyLedgerEntry } from "../domain/loyalty";
import { soonestExpiryConsumedBy } from "../domain/loyalty-lots";
import {
  computeRedemptionDiscount,
  LOYALTY_REDEMPTION_ERROR_CODES,
  pointsToHaveRestored,
  type RedemptionRate,
  type RedemptionSettingsInput
} from "../domain/loyalty-redemption";
import { fromCents, normalizeMoney } from "../domain/price-calculation";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "commerce_loyalty";

// ---------------------------------------------------------------------------
// Tenant settings: the point value and the cap
// ---------------------------------------------------------------------------

export type LoyaltyRedemptionSettings = {
  rupiahPerPoint: number;
  maxGoodsPercent: number | null;
  updatedAt: string;
};

type SettingsRow = {
  rupiah_per_point: number;
  max_goods_percent: number | null;
  updated_at: Date | string;
};

function toSettings(row: SettingsRow): LoyaltyRedemptionSettings {
  return {
    rupiahPerPoint: Number(row.rupiah_per_point),
    maxGoodsPercent:
      row.max_goods_percent === null ? null : Number(row.max_goods_percent),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

/** The tenant's point value, or `null` when it never set one (redemption unavailable - there is no default). */
export async function fetchRedemptionSettings(
  tx: Bun.SQL,
  tenantId: string
): Promise<LoyaltyRedemptionSettings | null> {
  const rows = (await tx`
    SELECT rupiah_per_point, max_goods_percent, updated_at
    FROM awcms_commerce_loyalty_redemption_settings
    WHERE tenant_id = ${tenantId}
  `) as SettingsRow[];
  return rows[0] ? toSettings(rows[0]) : null;
}

/**
 * Sets (or changes) the tenant's point value and cap. A change affects only
 * orders created afterwards: every redemption row snapshots the rate it used.
 * Audited with the old and new figures (threat-model C-31 evidence).
 */
export async function saveRedemptionSettings(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: RedemptionSettingsInput,
  correlationId?: string
): Promise<LoyaltyRedemptionSettings> {
  const before = await fetchRedemptionSettings(tx, tenantId);
  const rows = (await tx`
    INSERT INTO awcms_commerce_loyalty_redemption_settings
      (tenant_id, rupiah_per_point, max_goods_percent, updated_by_tenant_user_id)
    VALUES (${tenantId}, ${input.rupiahPerPoint}, ${input.maxGoodsPercent}, ${actorTenantUserId})
    ON CONFLICT (tenant_id) DO UPDATE
    SET rupiah_per_point = EXCLUDED.rupiah_per_point,
        max_goods_percent = EXCLUDED.max_goods_percent,
        updated_by_tenant_user_id = EXCLUDED.updated_by_tenant_user_id,
        updated_at = now()
    RETURNING rupiah_per_point, max_goods_percent, updated_at
  `) as SettingsRow[];
  const settings = toSettings(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "commerce.loyalty.redemption_settings_updated",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: tenantId,
    severity: "warning",
    message: "Loyalty point value or cap changed.",
    attributes: {
      before: before
        ? {
            rupiahPerPoint: before.rupiahPerPoint,
            maxGoodsPercent: before.maxGoodsPercent
          }
        : null,
      after: {
        rupiahPerPoint: settings.rupiahPerPoint,
        maxGoodsPercent: settings.maxGoodsPercent
      }
    },
    correlationId
  });
  return settings;
}

/** Removes the tenant's point value: redemption becomes unavailable again. `false` when there was none. */
export async function clearRedemptionSettings(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  correlationId?: string
): Promise<boolean> {
  const before = await fetchRedemptionSettings(tx, tenantId);
  if (!before) return false;
  await tx`
    DELETE FROM awcms_commerce_loyalty_redemption_settings
    WHERE tenant_id = ${tenantId}
  `;
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "commerce.loyalty.redemption_settings_cleared",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: tenantId,
    severity: "warning",
    message: "Loyalty point value removed; redemption is unavailable.",
    attributes: {
      before: {
        rupiahPerPoint: before.rupiahPerPoint,
        maxGoodsPercent: before.maxGoodsPercent
      }
    },
    correlationId
  });
  return true;
}

/**
 * What a customer or cashier may redeem at: the terms, or `null` when
 * redemption is unavailable for ANY reason (loyalty off, redemption off, no
 * point value set). One answer for all three, so a prober learns nothing about
 * which one it was.
 */
export async function fetchRedemptionTerms(
  tx: Bun.SQL,
  tenantId: string
): Promise<RedemptionRate | null> {
  const features = await fetchCommerceFeatures(tx, tenantId);
  if (!features.loyalty || !features.loyaltyRedemption) return null;
  const settings = await fetchRedemptionSettings(tx, tenantId);
  if (!settings) return null;
  return {
    rupiahPerPoint: settings.rupiahPerPoint,
    maxGoodsPercent: settings.maxGoodsPercent
  };
}

// ---------------------------------------------------------------------------
// Step 1: prepare (before the order row exists)
// ---------------------------------------------------------------------------

export type RedemptionRefusal =
  | { code: typeof LOYALTY_REDEMPTION_ERROR_CODES.unavailable }
  | { code: typeof LOYALTY_REDEMPTION_ERROR_CODES.depositConflict }
  | { code: typeof LOYALTY_REDEMPTION_ERROR_CODES.customerUnavailable }
  | {
      code: typeof LOYALTY_REDEMPTION_ERROR_CODES.exceedsLimit;
      reason: "goods" | "cap";
      maxPoints: number;
    }
  | {
      code: typeof LOYALTY_REDEMPTION_ERROR_CODES.insufficientPoints;
      balance: number;
      requested: number;
    };

export type PreparedRedemption = {
  account: LockedAccount;
  points: number;
  rate: RedemptionRate;
  goodsBasisCents: bigint;
  discountCents: bigint;
  /** `numeric(14,2)` decimal string. */
  discount: string;
  /** The key suffix of `redeem:<accountId>:<clientKey>`. */
  clientKey: string;
  /** When the points would lapse if given back (see `sql/1010`). */
  restoreExpiresAt: Date | null;
};

export type PrepareRedemptionResult =
  | { ok: true; prepared: PreparedRedemption }
  | { ok: false; refusal: RedemptionRefusal };

export async function prepareRedemption(
  tx: Bun.SQL,
  tenantId: string,
  input: {
    /** Taken from the verified session / the order's attached customer - never from a request field. */
    customerId: string;
    points: number;
    goodsBasisCents: bigint;
    /** `order:<order idempotency key>` (storefront) or `pos:<key>`. */
    clientKey: string;
    /** `true` for a deposit order (`payment.method = dp`): points and a deposit never combine (Q8). */
    depositOrder: boolean;
    now: Date;
    correlationId?: string;
  }
): Promise<PrepareRedemptionResult> {
  const terms = await fetchRedemptionTerms(tx, tenantId);
  if (!terms) {
    return {
      ok: false,
      refusal: { code: LOYALTY_REDEMPTION_ERROR_CODES.unavailable }
    };
  }
  if (input.depositOrder) {
    return {
      ok: false,
      refusal: { code: LOYALTY_REDEMPTION_ERROR_CODES.depositConflict }
    };
  }

  const customerRows = (await tx`
    SELECT status, deleted_at
    FROM awcms_commerce_customers
    WHERE tenant_id = ${tenantId} AND id = ${input.customerId}
  `) as { status: string; deleted_at: Date | string | null }[];
  const customer = customerRows[0];
  if (
    !customer ||
    customer.deleted_at !== null ||
    customer.status !== "active"
  ) {
    return {
      ok: false,
      refusal: { code: LOYALTY_REDEMPTION_ERROR_CODES.customerUnavailable }
    };
  }

  const computation = computeRedemptionDiscount(
    input.points,
    terms,
    input.goodsBasisCents
  );
  if (!computation.ok) {
    return {
      ok: false,
      refusal: {
        code: LOYALTY_REDEMPTION_ERROR_CODES.exceedsLimit,
        reason: computation.reason,
        maxPoints: computation.maxPoints
      }
    };
  }

  // Serialise on the account. From here to the end of the transaction nothing
  // else can spend these points.
  const account = await lockAccountForCustomer(tx, tenantId, input.customerId);
  if (!account) {
    return {
      ok: false,
      refusal: {
        code: LOYALTY_REDEMPTION_ERROR_CODES.insufficientPoints,
        balance: 0,
        requested: input.points
      }
    };
  }

  await expireDueLotsForLockedAccount(
    tx,
    tenantId,
    account,
    input.now,
    input.correlationId
  );

  if (account.balance < input.points) {
    return {
      ok: false,
      refusal: {
        code: LOYALTY_REDEMPTION_ERROR_CODES.insufficientPoints,
        balance: account.balance,
        requested: input.points
      }
    };
  }

  const entries = await loadReplayEntries(tx, tenantId, account.id);
  const restoreExpiresAt = soonestExpiryConsumedBy(
    entries,
    input.points,
    input.now.getTime()
  );

  return {
    ok: true,
    prepared: {
      account,
      points: input.points,
      rate: terms,
      goodsBasisCents: input.goodsBasisCents,
      discountCents: computation.discountCents,
      discount: computation.discount,
      clientKey: input.clientKey,
      restoreExpiresAt
    }
  };
}

// ---------------------------------------------------------------------------
// Step 2: commit (after the order row exists)
// ---------------------------------------------------------------------------

export class LoyaltyRedemptionInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoyaltyRedemptionInvariantError";
  }
}

/**
 * Appends the `redeem` ledger row and the redemption record for `orderId`.
 * `LoyaltyIdempotencyConflictError` (the ledger key exists for another
 * account or amount) propagates - the caller's transaction rolls back and the
 * route answers `409 IDEMPOTENCY_CONFLICT`.
 */
export async function commitRedemption(
  tx: Bun.SQL,
  tenantId: string,
  prepared: PreparedRedemption,
  context: {
    orderId: string;
    channel: "storefront" | "pos";
    actorTenantUserId: string | null;
    correlationId?: string;
  }
): Promise<LoyaltyLedgerEntry> {
  const result = await appendLedgerEntry(tx, tenantId, prepared.account, {
    kind: "redeem",
    points: -prepared.points,
    sourceType: "redemption",
    sourceId: context.orderId,
    idempotencyKey: `redeem:${prepared.account.id}:${prepared.clientKey}`,
    actorTenantUserId: context.actorTenantUserId,
    correlationId: context.correlationId
  });
  if (!result.inserted) {
    // The key already had a row. A fresh order id cannot meet an old key unless
    // the same client key was reused for a different order: never a replay here
    // (a replayed order request is answered before this code runs).
    throw new LoyaltyRedemptionInvariantError(
      "The redemption's ledger key was already used."
    );
  }

  await tx`
    INSERT INTO awcms_commerce_loyalty_redemptions (
      tenant_id, order_id, account_id, ledger_entry_id, channel, points,
      rupiah_per_point, max_goods_percent, goods_basis, discount,
      restore_expires_at, actor_tenant_user_id
    )
    VALUES (
      ${tenantId}, ${context.orderId}, ${prepared.account.id}, ${result.entry.id},
      ${context.channel}, ${prepared.points}, ${prepared.rate.rupiahPerPoint},
      ${prepared.rate.maxGoodsPercent},
      ${fromCents(prepared.goodsBasisCents)},
      ${prepared.discount},
      ${prepared.restoreExpiresAt}::timestamptz, ${context.actorTenantUserId}
    )
  `;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId: context.actorTenantUserId ?? undefined,
    moduleKey: AUDIT_MODULE_KEY,
    action: "commerce.loyalty.redemption_applied",
    resourceType: "order",
    resourceId: context.orderId,
    message: `Redeemed ${prepared.points} loyalty points against an order.`,
    // Ids and figures only: no name, phone or free text.
    attributes: {
      accountId: prepared.account.id,
      ledgerEntryId: result.entry.id,
      channel: context.channel,
      points: prepared.points,
      rupiahPerPoint: prepared.rate.rupiahPerPoint,
      maxGoodsPercent: prepared.rate.maxGoodsPercent,
      discount: prepared.discount,
      balanceAfter: prepared.account.balance
    },
    correlationId: context.correlationId
  });

  return result.entry;
}

// ---------------------------------------------------------------------------
// Reading an order's redemption
// ---------------------------------------------------------------------------

export type OrderRedemption = {
  id: string;
  orderId: string;
  accountId: string;
  ledgerEntryId: string;
  channel: "storefront" | "pos";
  points: number;
  rupiahPerPoint: number;
  maxGoodsPercent: number | null;
  goodsBasis: string;
  discount: string;
  restoreExpiresAt: string | null;
  /** Points already given back (cancellation and refunds together). */
  restoredPoints: number;
  createdAt: string;
};

type RedemptionRow = {
  id: string;
  order_id: string;
  account_id: string;
  ledger_entry_id: string;
  channel: string;
  points: string | number | bigint;
  rupiah_per_point: number;
  max_goods_percent: number | null;
  goods_basis: string;
  discount: string;
  restore_expires_at: Date | string | null;
  created_at: Date | string;
};

async function restoredPointsFor(
  tx: Bun.SQL,
  tenantId: string,
  ledgerEntryId: string
): Promise<number> {
  const rows = (await tx`
    SELECT COALESCE(SUM(points), 0) AS restored
    FROM awcms_commerce_loyalty_ledger
    WHERE tenant_id = ${tenantId}
      AND kind = 'restore'
      AND reverses_entry_id = ${ledgerEntryId}
  `) as { restored: string | number | bigint }[];
  return assertPoints(rows[0]?.restored ?? 0, "restored");
}

export async function fetchRedemptionForOrder(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<OrderRedemption | null> {
  const rows = (await tx`
    SELECT id, order_id, account_id, ledger_entry_id, channel, points,
      rupiah_per_point, max_goods_percent, goods_basis, discount,
      restore_expires_at, created_at
    FROM awcms_commerce_loyalty_redemptions
    WHERE tenant_id = ${tenantId} AND order_id = ${orderId}
  `) as RedemptionRow[];
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.order_id,
    accountId: row.account_id,
    ledgerEntryId: row.ledger_entry_id,
    channel: row.channel as "storefront" | "pos",
    points: assertPoints(row.points),
    rupiahPerPoint: Number(row.rupiah_per_point),
    maxGoodsPercent:
      row.max_goods_percent === null ? null : Number(row.max_goods_percent),
    goodsBasis: normalizeMoney(String(row.goods_basis)),
    discount: normalizeMoney(String(row.discount)),
    restoreExpiresAt:
      row.restore_expires_at === null
        ? null
        : new Date(row.restore_expires_at).toISOString(),
    restoredPoints: await restoredPointsFor(tx, tenantId, row.ledger_entry_id),
    createdAt: new Date(row.created_at).toISOString()
  };
}

// ---------------------------------------------------------------------------
// Giving the points back
// ---------------------------------------------------------------------------

export type RestoreOutcome =
  | { kind: "restored"; entry: LoyaltyLedgerEntry }
  | { kind: "already_restored"; entry: LoyaltyLedgerEntry }
  | { kind: "no_redemption" }
  | { kind: "nothing_to_restore" };

async function restoreRedemption(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string,
  source: { type: "order" | "refund"; id: string; key: string },
  /** Total points that must have been given back by now, including this call. */
  wantedTotal: (redemption: OrderRedemption) => number,
  correlationId: string | undefined
): Promise<RestoreOutcome> {
  const redemption = await fetchRedemptionForOrder(tx, tenantId, orderId);
  if (!redemption) return { kind: "no_redemption" };

  const account = await lockAccountById(tx, tenantId, redemption.accountId);
  if (!account) return { kind: "no_redemption" };

  const prior = await findEntryByKey(tx, tenantId, source.key);
  if (prior) return { kind: "already_restored", entry: prior };

  // Re-read under the lock: the restored total is a function of the ledger.
  const restoredSoFar = await restoredPointsFor(
    tx,
    tenantId,
    redemption.ledgerEntryId
  );
  const target = Math.min(wantedTotal(redemption), redemption.points);
  const points = target - restoredSoFar;
  if (points <= 0) return { kind: "nothing_to_restore" };

  const result = await appendLedgerEntry(tx, tenantId, account, {
    kind: "restore",
    points,
    sourceType: source.type,
    sourceId: source.id,
    idempotencyKey: source.key,
    reversesEntryId: redemption.ledgerEntryId,
    expiresAt:
      redemption.restoreExpiresAt === null
        ? null
        : new Date(redemption.restoreExpiresAt),
    correlationId
  });

  if (result.inserted) {
    await recordAuditEvent(tx, {
      tenantId,
      moduleKey: AUDIT_MODULE_KEY,
      action: "commerce.loyalty.redemption_restored",
      resourceType: "order",
      resourceId: orderId,
      message: `Gave back ${points} redeemed loyalty points (${source.type}).`,
      attributes: {
        accountId: account.id,
        ledgerEntryId: result.entry.id,
        points,
        sourceType: source.type,
        sourceId: source.id
      },
      correlationId
    });
  }

  return result.inserted
    ? { kind: "restored", entry: result.entry }
    : { kind: "already_restored", entry: result.entry };
}

/**
 * Gives back every redeemed point not yet returned, because the order was
 * cancelled or expired. Exactly once: the key is `restore:order:<orderId>`.
 */
export function restoreRedemptionForOrder(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string,
  correlationId?: string
): Promise<RestoreOutcome> {
  return restoreRedemption(
    tx,
    tenantId,
    orderId,
    { type: "order", id: orderId, key: `restore:order:${orderId}` },
    (redemption) => redemption.points,
    correlationId
  );
}

/**
 * Gives back the share of the redeemed points a settled refund represents:
 * the refund's cumulative money out of the money paid, in proportion (see
 * `pointsToHaveRestored`). Exactly once per refund: `restore:refund:<refundId>`.
 */
export function restoreRedemptionForRefund(
  tx: Bun.SQL,
  tenantId: string,
  params: {
    orderId: string;
    refundId: string;
    cumulativeRefundedCents: bigint;
    orderTotalCents: bigint;
    correlationId?: string;
  }
): Promise<RestoreOutcome> {
  return restoreRedemption(
    tx,
    tenantId,
    params.orderId,
    {
      type: "refund",
      id: params.refundId,
      key: `restore:refund:${params.refundId}`
    },
    (redemption) =>
      pointsToHaveRestored(
        redemption.points,
        params.cumulativeRefundedCents,
        params.orderTotalCents
      ),
    params.correlationId
  );
}
