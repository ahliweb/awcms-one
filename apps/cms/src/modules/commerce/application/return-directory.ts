/**
 * Recording a return, planning and creating its refund legs, linking an
 * exchange's replacement order, and reconciling the whole (Issue #287,
 * ADR-0033). The writes of a return live here; settling a leg is
 * `refund-settlement.ts`, calling a payment provider is `refund-execution.ts`.
 *
 * ## One transaction, one lock order
 *
 * `createReturn` runs entirely inside the caller's transaction, in the lock
 * order every ledger writer uses (ADR-0025 D4): the ORDER row first
 * (`FOR NO KEY UPDATE`), then the requested order-item rows (sorted by id),
 * then - inside settlement - the payment rows, a gift card, a drawer. Two
 * returns of one order therefore queue on the order lock, and the second sees
 * the first's lines when it counts what is still eligible; the database
 * trigger on `awcms_commerce_return_lines` is the independent second guard.
 *
 * ## Atomicity of a refusal
 *
 * A route handler that returns a response commits its transaction, so every
 * refusal is decided BEFORE the first write: quantities and the order's state
 * are read under the locks, the refund is planned against what each payment can
 * still give back, and `checkRefundSettlement` (the same function the
 * settlement itself runs) vets every immediate leg. Only then does anything get
 * written; a failure after that point is a bug, throws, and rolls everything
 * back.
 *
 * ## What is written, in order
 *
 *   1. the return row and its lines (exact-cent value per line);
 *   2. the stock effect, through the inventory port (`restock` only);
 *   3. one `order_events` row (`to_status = 'returned'`, `return_id`) - the
 *      record the three sales-report projections already read, so the sales
 *      reports net the return with no second pipeline;
 *   4. one refund leg per original payment it goes back along;
 *   5. every leg that can settle now (cash, a manual refund, value back to a
 *      gift card, store credit) is settled; a gateway leg stays `pending` for
 *      `refund-execution.ts`;
 *   6. the `return.recorded` event, the audit row and the idempotency record.
 *
 * Finalised order history is never edited: no order, order item or payment row
 * is updated. A return only ever ADDS rows.
 */
import { reverseOrderTaxForReturn } from "./tax-adapter-directory";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../_shared/idempotency";
import {
  COMMERCE_EVENT_VERSION,
  COMMERCE_RETURN_AGGREGATE_TYPE,
  COMMERCE_RETURN_RECORDED_EVENT_TYPE
} from "../domain/commerce-events";
import { fromCents, toCents } from "../domain/price-calculation";
import {
  RETURN_ORDER_EVENT_STATUS,
  allocateOrderDiscount,
  computeReturnValue,
  isReturnableOrderStatus,
  planRefundLegs,
  remainingEligibleQuantity,
  type CreateReturnInput,
  type CreateReturnRefundInput,
  type RefundablePayment
} from "../domain/returns";
import {
  resolveInventoryConfig,
  withInventorySavepoint
} from "./commerce-inventory";
import { IdempotencyPayloadMismatchError } from "./order-directory";
import { lockOrderForSettlement } from "./payment-allocation-directory";
import { fetchCommerceFeatures } from "./commerce-feature-gate";
import {
  modeAwareInventoryPort,
  type ReturnInventoryPort
} from "./return-inventory-port";
import {
  checkRefundSettlement,
  RefundInvariantError,
  settleRefundLeg,
  type IssuedStoreCredit,
  type SettleRefundRefusal
} from "./refund-settlement";
import { fetchReturn, type ReturnRecord } from "./return-records";

const AUDIT_MODULE_KEY = "commerce";
const PRODUCER_MODULE = "commerce";
const CREATE_SCOPE = "commerce.returns.create";
const REFUND_SCOPE = "commerce.returns.refund";
const EXCHANGE_SCOPE = "commerce.returns.link_exchange";

/** The stored/returned body of a mutation. `storeCredit.code` is present ONLY in the response of the request that issued the account. */
export type ReturnMutationBody = {
  return: ReturnRecord;
  storeCredit: IssuedStoreCredit | null;
};

export type ReturnDeps = {
  inventory: ReturnInventoryPort;
};

const DEFAULT_DEPS: ReturnDeps = { inventory: modeAwareInventoryPort };

export type CreateReturnOutcome =
  | { kind: "feature_disabled" }
  | { kind: "order_not_found" }
  | { kind: "order_not_returnable"; status: string }
  | { kind: "line_not_found"; orderItemId: string }
  | {
      kind: "quantity_exceeded";
      orderItemId: string;
      requested: number;
      remaining: number;
    }
  | { kind: "shipping_refund_exceeded"; remaining: string }
  | { kind: "exchange_order_invalid" }
  | { kind: "refund_exceeds_refundable"; refundable: string; requested: string }
  | { kind: "refund_refused"; refusal: SettleRefundRefusal }
  | { kind: "created" | "replayed"; body: ReturnMutationBody };

type OrderFacts = {
  subtotal: string;
  discount: string;
  voucher_discount: string;
  shipping_cost: string;
};

type ItemRow = {
  id: string;
  product_id: string;
  variant_id: string | null;
  quantity: number;
  line_total: string;
};

type PaymentRow = {
  id: string;
  tender_type: string;
  amount: string;
  created_at: Date;
  entry_seq: string | number;
  reversed: string;
  promised: string;
};

/** The payments of an order with what each can still give back, ready for {@link planRefundLegs}. */
async function loadRefundablePayments(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<RefundablePayment[]> {
  const rows = (await tx`
    SELECT a.id, a.tender_type, a.amount, a.created_at, a.entry_seq,
      COALESCE((
        SELECT SUM(r.amount) FROM awcms_commerce_payment_allocations r
        WHERE r.tenant_id = a.tenant_id AND r.reverses_allocation_id = a.id
          AND r.status = 'succeeded'
      ), 0) AS reversed,
      COALESCE((
        SELECT SUM(f.amount) FROM awcms_commerce_refunds f
        WHERE f.tenant_id = a.tenant_id AND f.allocation_id = a.id
          AND f.status IN ('pending', 'processing')
      ), 0) AS promised
    FROM awcms_commerce_payment_allocations a
    WHERE a.tenant_id = ${tenantId} AND a.order_id = ${orderId}
      AND a.kind = 'payment' AND a.status = 'succeeded'
  `) as PaymentRow[];
  return rows.map((row) => ({
    allocationId: row.id,
    tenderType: row.tender_type,
    amountCents: toCents(String(row.amount)),
    reversedCents: toCents(String(row.reversed)),
    promisedCents: toCents(String(row.promised)),
    createdAt: row.created_at.toISOString(),
    entrySeq: Number(row.entry_seq)
  }));
}

/** The body the stored idempotency record keeps: the plaintext store-credit code is NEVER stored. */
function redactForStore(body: ReturnMutationBody): ReturnMutationBody {
  return {
    return: body.return,
    storeCredit: body.storeCredit
      ? { ...body.storeCredit, code: null, codeRevealed: false }
      : null
  };
}

type PlannedLeg = {
  allocationId: string;
  tenderType: string;
  amountCents: bigint;
  destination: "original_tender" | "store_credit";
};

/**
 * A gateway leg waits for the provider; every other leg settles now. A leg on
 * a stored-value tender always goes back to its own account (closed loop), so
 * a `store_credit` destination is applied to the other tenders only.
 */
function legDestination(
  tenderType: string,
  requested: "original_tender" | "store_credit"
): "original_tender" | "store_credit" {
  if (tenderType === "gift_card" || tenderType === "store_credit") {
    return "original_tender";
  }
  return requested;
}

function isImmediate(leg: PlannedLeg): boolean {
  return !(
    leg.destination === "original_tender" && leg.tenderType === "gateway"
  );
}

/**
 * Plans the refund legs for `amountCents` and vets every immediate one.
 * Returns the legs, or the refusal. Locks (it reads under the caller's order
 * lock) but writes nothing.
 */
async function planAndVetRefund(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string,
  amountCents: bigint,
  refund: CreateReturnRefundInput,
  actorTenantUserId: string
): Promise<
  { ok: true; legs: PlannedLeg[] } | { ok: false; outcome: CreateReturnOutcome }
> {
  const payments = await loadRefundablePayments(tx, tenantId, orderId);
  const plan = planRefundLegs(payments, amountCents);
  if (!plan.ok) {
    return {
      ok: false,
      outcome: {
        kind: "refund_exceeds_refundable",
        refundable: fromCents(plan.refundableCents),
        requested: fromCents(amountCents)
      }
    };
  }
  const legs: PlannedLeg[] = plan.legs.map((leg) => ({
    allocationId: leg.allocationId,
    tenderType: leg.tenderType,
    amountCents: leg.amountCents,
    destination: legDestination(leg.tenderType, refund.destination)
  }));

  const creditTotalCents = legs
    .filter((leg) => leg.destination === "store_credit")
    .reduce((sum, leg) => sum + leg.amountCents, 0n);
  for (const leg of legs.filter(isImmediate)) {
    const check = await checkRefundSettlement(tx, tenantId, {
      orderId,
      allocationId: leg.allocationId,
      amountCents: leg.amountCents,
      destination: leg.destination,
      actorTenantUserId,
      registerSessionId: refund.registerSessionId,
      storeCreditAccountId: refund.storeCreditAccountId,
      creditTotalCents
    });
    if (!check.ok) {
      return {
        ok: false,
        outcome: { kind: "refund_refused", refusal: check.refusal }
      };
    }
  }
  return { ok: true, legs };
}

/**
 * Writes the planned legs (all `pending`, which fires the database's refund
 * cap) and settles every immediate one. For a store-credit destination the
 * FIRST leg issues the account (or loads the named one) and the rest load that
 * same account, so the customer ends up with one code, not one per payment.
 */
async function writeAndSettleLegs(
  tx: Bun.SQL,
  tenantId: string,
  params: {
    returnId: string;
    orderId: string;
    legs: PlannedLeg[];
    refund: CreateReturnRefundInput;
    sourceKeyPrefix: string;
    actorTenantUserId: string;
    now: Date;
    correlationId?: string;
  }
): Promise<{ storeCredit: IssuedStoreCredit | null }> {
  const refundIds: string[] = [];
  for (const [index, leg] of params.legs.entries()) {
    const inserted = (await tx`
      INSERT INTO awcms_commerce_refunds (
        tenant_id, return_id, order_id, allocation_id, tender_type, amount,
        destination, status, source_key, actor_tenant_user_id
      )
      VALUES (
        ${tenantId}, ${params.returnId}, ${params.orderId}, ${leg.allocationId},
        ${leg.tenderType}, ${fromCents(leg.amountCents)}, ${leg.destination},
        'pending', ${`${params.sourceKeyPrefix}:${index}`}, ${params.actorTenantUserId}
      )
      RETURNING id
    `) as { id: string }[];
    refundIds.push(inserted[0]!.id);
  }

  const creditTotalCents = params.legs
    .filter((leg) => leg.destination === "store_credit")
    .reduce((sum, leg) => sum + leg.amountCents, 0n);
  let creditAccountId: string | null = params.refund.storeCreditAccountId;
  let storeCredit: IssuedStoreCredit | null = null;

  for (const [index, leg] of params.legs.entries()) {
    if (!isImmediate(leg)) continue;
    const outcome = await settleRefundLeg(tx, tenantId, {
      refundId: refundIds[index]!,
      actorTenantUserId: params.actorTenantUserId,
      via: "auto",
      registerSessionId: params.refund.registerSessionId,
      storeCreditAccountId:
        leg.destination === "store_credit" ? creditAccountId : null,
      creditTotalCents,
      now: params.now,
      correlationId: params.correlationId
    });
    if (outcome.kind !== "settled") {
      throw new RefundInvariantError(
        `A refund leg could not be settled after the pre-checks (${outcome.kind}${
          outcome.kind === "refused" ? `: ${outcome.refusal.reason}` : ""
        }).`
      );
    }
    if (outcome.storeCredit) {
      creditAccountId = outcome.storeCredit.accountId;
      storeCredit = storeCredit ?? outcome.storeCredit;
    }
  }
  return { storeCredit };
}

/**
 * Records a return (or exchange) of goods sold on `orderId`, optionally with
 * its refund. See the file header for the order of operations.
 *
 * @throws {IdempotencyPayloadMismatchError} same key, different payload.
 * @throws {RefundInvariantError} an impossible state after the first write
 *   (the transaction rolls back).
 */
export async function createReturn(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  orderId: string,
  input: CreateReturnInput,
  now: Date,
  correlationId?: string,
  deps: ReturnDeps = DEFAULT_DEPS
): Promise<CreateReturnOutcome> {
  // Issue #282 (ADR-0038 D2): in `ledger` mode the whole return runs in a
  // savepoint, so a ledger refusal on the restock rolls the return rows back and
  // the route's 409 leaves nothing half-written.
  const inventory = await resolveInventoryConfig(tx, tenantId);

  return withInventorySavepoint(tx, inventory, (db) =>
    createReturnWrite(
      db,
      tenantId,
      actorTenantUserId,
      orderId,
      input,
      now,
      correlationId,
      deps
    )
  );
}

async function createReturnWrite(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  orderId: string,
  input: CreateReturnInput,
  now: Date,
  correlationId: string | undefined,
  deps: ReturnDeps
): Promise<CreateReturnOutcome> {
  const features = await fetchCommerceFeatures(tx, tenantId);
  if (!features.returns) return { kind: "feature_disabled" };

  const requestHash = computeRequestHash({
    action: CREATE_SCOPE,
    actorTenantUserId,
    orderId,
    kind: input.kind,
    note: input.note,
    exchangeOrderId: input.exchangeOrderId,
    lines: [...input.lines]
      .sort((a, b) => a.orderItemId.localeCompare(b.orderItemId))
      .map((line) => ({
        orderItemId: line.orderItemId,
        quantity: line.quantity,
        reason: line.reason,
        disposition: line.disposition,
        note: line.note
      })),
    refund: input.refund
  });

  // The order lock first: it also serialises a same-key retry behind the
  // request that is still running.
  const header = await lockOrderForSettlement(tx, tenantId, orderId);
  if (!header) return { kind: "order_not_found" };

  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    CREATE_SCOPE,
    input.idempotencyKey
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      body: existing.responseBody as ReturnMutationBody
    };
  }
  // The table's own guard, for a key whose store record is gone.
  const sourceKey = `api:${input.idempotencyKey}`;
  const prior = (await tx`
    SELECT id, order_id FROM awcms_commerce_returns
    WHERE tenant_id = ${tenantId} AND source_key = ${sourceKey}
  `) as { id: string; order_id: string }[];
  if (prior[0]) {
    if (prior[0].order_id !== orderId) {
      throw new IdempotencyPayloadMismatchError();
    }
    const record = (await fetchReturn(tx, tenantId, prior[0].id))!;
    return { kind: "replayed", body: { return: record, storeCredit: null } };
  }

  if (!isReturnableOrderStatus(header.status)) {
    return { kind: "order_not_returnable", status: header.status };
  }

  // --- the order's lines and what is still eligible --------------------------
  const facts = (
    (await tx`
      SELECT subtotal, discount, voucher_discount, shipping_cost
      FROM awcms_commerce_orders
      WHERE tenant_id = ${tenantId} AND id = ${orderId}
    `) as OrderFacts[]
  )[0]!;
  const items = (await tx`
    SELECT id, product_id, variant_id, quantity, line_total
    FROM awcms_commerce_order_items
    WHERE tenant_id = ${tenantId} AND order_id = ${orderId} AND deleted_at IS NULL
    ORDER BY created_at ASC, id ASC
  `) as ItemRow[];
  const itemById = new Map(items.map((item) => [item.id, item]));

  const requestedIds = input.lines.map((line) => line.orderItemId).sort();
  for (const line of input.lines) {
    if (!itemById.has(line.orderItemId)) {
      return { kind: "line_not_found", orderItemId: line.orderItemId };
    }
  }
  // Lock the requested lines in id order (the trigger takes the same lock).
  await tx`
    SELECT id FROM awcms_commerce_order_items
    WHERE tenant_id = ${tenantId}
      AND id = ANY(${tx.array(requestedIds, "uuid")}::uuid[])
    ORDER BY id
    FOR NO KEY UPDATE
  `;
  const returnedRows = (await tx`
    SELECT order_item_id, COALESCE(SUM(quantity), 0)::int AS returned
    FROM awcms_commerce_return_lines
    WHERE tenant_id = ${tenantId} AND order_id = ${orderId}
    GROUP BY order_item_id
  `) as { order_item_id: string; returned: number }[];
  const returnedByItem = new Map(
    returnedRows.map((row) => [row.order_item_id, Number(row.returned)])
  );

  const discountShares = allocateOrderDiscount(
    items.map((item) => toCents(String(item.line_total))),
    toCents(String(facts.discount)) + toCents(String(facts.voucher_discount))
  );
  const discountByItem = new Map(
    items.map((item, index) => [item.id, discountShares[index]!])
  );

  const valued = [];
  let goodsGross = 0n;
  let discountShare = 0n;
  let lineRefund = 0n;
  for (const line of input.lines) {
    const item = itemById.get(line.orderItemId)!;
    const already = returnedByItem.get(item.id) ?? 0;
    const remaining = remainingEligibleQuantity(Number(item.quantity), already);
    if (line.quantity > remaining) {
      return {
        kind: "quantity_exceeded",
        orderItemId: item.id,
        requested: line.quantity,
        remaining
      };
    }
    const value = computeReturnValue({
      lineTotalCents: toCents(String(item.line_total)),
      lineDiscountCents: discountByItem.get(item.id)!,
      quantity: Number(item.quantity),
      alreadyReturned: already,
      returning: line.quantity
    });
    goodsGross += value.goodsGrossCents;
    discountShare += value.discountShareCents;
    lineRefund += value.refundCents;
    valued.push({ line, item, value });
  }

  // --- shipping refund -------------------------------------------------------
  const shippingRefundCents =
    input.refund?.shippingRefund != null
      ? toCents(input.refund.shippingRefund)
      : 0n;
  if (shippingRefundCents > 0n) {
    const refundedShipping = (await tx`
      SELECT COALESCE(SUM(shipping_refund), 0) AS refunded
      FROM awcms_commerce_returns
      WHERE tenant_id = ${tenantId} AND order_id = ${orderId}
    `) as { refunded: string }[];
    const remainingShipping =
      toCents(String(facts.shipping_cost)) -
      toCents(String(refundedShipping[0]!.refunded));
    if (shippingRefundCents > remainingShipping) {
      return {
        kind: "shipping_refund_exceeded",
        remaining: fromCents(remainingShipping > 0n ? remainingShipping : 0n)
      };
    }
  }
  const refundTotal = lineRefund + shippingRefundCents;

  // --- exchange link ---------------------------------------------------------
  if (input.exchangeOrderId !== null) {
    const exchange = (await tx`
      SELECT status FROM awcms_commerce_orders
      WHERE tenant_id = ${tenantId} AND id = ${input.exchangeOrderId}
        AND id <> ${orderId} AND deleted_at IS NULL
    `) as { status: string }[];
    if (!exchange[0] || ["cancelled", "expired"].includes(exchange[0].status)) {
      return { kind: "exchange_order_invalid" };
    }
  }

  // --- the refund plan and every refusal, before the first write ------------
  let legs: PlannedLeg[] = [];
  if (input.refund && refundTotal > 0n) {
    const planned = await planAndVetRefund(
      tx,
      tenantId,
      orderId,
      refundTotal,
      input.refund,
      actorTenantUserId
    );
    if (!planned.ok) return planned.outcome;
    legs = planned.legs;
  }

  // --- writes ----------------------------------------------------------------
  const returnRows = (await tx`
    INSERT INTO awcms_commerce_returns (
      tenant_id, order_id, kind, status, note, goods_gross, discount_share,
      shipping_refund, refund_total, exchange_order_id, source_key,
      actor_tenant_user_id
    )
    VALUES (
      ${tenantId}, ${orderId}, ${input.kind}, 'open', ${input.note},
      ${fromCents(goodsGross)}, ${fromCents(discountShare)},
      ${fromCents(shippingRefundCents)}, ${fromCents(refundTotal)},
      ${input.exchangeOrderId}, ${sourceKey}, ${actorTenantUserId}
    )
    RETURNING id
  `) as { id: string }[];
  const returnId = returnRows[0]!.id;

  const stockLines = [];
  for (const { line, item, value } of valued) {
    const inserted = (await tx`
      INSERT INTO awcms_commerce_return_lines (
        tenant_id, return_id, order_id, order_item_id, product_id, variant_id,
        quantity, reason, disposition, stock_effect, goods_gross,
        discount_share, refund_amount, note
      )
      VALUES (
        ${tenantId}, ${returnId}, ${orderId}, ${item.id}, ${item.product_id},
        ${item.variant_id}, ${line.quantity}, ${line.reason}, ${line.disposition},
        ${line.disposition === "restock" ? line.quantity : 0},
        ${fromCents(value.goodsGrossCents)}, ${fromCents(value.discountShareCents)},
        ${fromCents(value.refundCents)}, ${line.note}
      )
      RETURNING id
    `) as { id: string }[];
    stockLines.push({
      returnId,
      returnLineId: inserted[0]!.id,
      productId: item.product_id,
      variantId: item.variant_id,
      quantity: line.quantity,
      disposition: line.disposition
    });
  }

  // Issue #293 (ADR-0039) — engine mode: reverse the returned units' tax from
  // the order's ORIGINAL snapshot (a no-op for flat-mode / pre-cut-over orders).
  const taxReversal = await reverseOrderTaxForReturn(
    tx,
    tenantId,
    actorTenantUserId,
    {
      orderId,
      returnId,
      lines: valued.map(({ line, item }) => ({
        orderItemId: item.id,
        quantity: line.quantity
      })),
      correlationId
    }
  );
  if (taxReversal.kind === "invalid") {
    throw new RefundInvariantError(
      `The tax reversal for return ${returnId} was refused: ${taxReversal.message}`
    );
  }

  const stock = await deps.inventory.applyReturn(tx, tenantId, stockLines, {
    actorTenantUserId,
    correlationId
  });
  const expectedRestock = stockLines
    .filter((line) => line.disposition === "restock")
    .reduce((sum, line) => sum + line.quantity, 0);
  if (stock.restockedUnits !== expectedRestock) {
    throw new RefundInvariantError(
      `The inventory port restocked ${stock.restockedUnits} unit(s); the return lines say ${expectedRestock}.`
    );
  }

  await tx`
    INSERT INTO awcms_commerce_order_events
      (tenant_id, order_id, from_status, to_status, actor, note, return_id)
    VALUES (
      ${tenantId}, ${orderId}, ${header.status}, ${RETURN_ORDER_EVENT_STATUS},
      'admin', ${`Return ${returnId} recorded.`}, ${returnId}
    )
  `;

  let storeCredit: IssuedStoreCredit | null = null;
  if (legs.length > 0 && input.refund) {
    const settled = await writeAndSettleLegs(tx, tenantId, {
      returnId,
      orderId,
      legs,
      refund: input.refund,
      sourceKeyPrefix: `return:${returnId}`,
      actorTenantUserId,
      now,
      correlationId
    });
    storeCredit = settled.storeCredit;
  } else if (refundTotal === 0n) {
    // Nothing is owed back (a free line): the return is complete as recorded.
    await tx`
      UPDATE awcms_commerce_returns
      SET status = 'completed', completed_at = now(), updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${returnId}
    `;
  }

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "return.create",
    resourceType: "commerce_return",
    resourceId: returnId,
    message: `${input.kind === "exchange" ? "Exchange" : "Return"} of ${valued.length} line(s) recorded against order ${header.orderCode}.`,
    // Ids, counts and money only - never the customer or the free-text notes.
    attributes: {
      orderId,
      orderCode: header.orderCode,
      kind: input.kind,
      lines: valued.length,
      units: valued.reduce((sum, v) => sum + v.line.quantity, 0),
      restockedUnits: stock.restockedUnits,
      goodsGross: fromCents(goodsGross),
      refundTotal: fromCents(refundTotal),
      refundLegs: legs.length
    },
    correlationId
  });

  await appendDomainEvent(tx, tenantId, {
    eventType: COMMERCE_RETURN_RECORDED_EVENT_TYPE,
    eventVersion: COMMERCE_EVENT_VERSION,
    aggregateType: COMMERCE_RETURN_AGGREGATE_TYPE,
    aggregateId: returnId,
    producerModule: PRODUCER_MODULE,
    correlationId,
    actorTenantUserId,
    payload: {
      returnId,
      orderId,
      kind: input.kind,
      lines: valued.map(({ line, item, value }) => ({
        orderItemId: item.id,
        quantity: line.quantity,
        reason: line.reason,
        disposition: line.disposition,
        refundAmount: fromCents(value.refundCents)
      })),
      goodsGross: fromCents(goodsGross),
      discountShare: fromCents(discountShare),
      shippingRefund: fromCents(shippingRefundCents),
      refundTotal: fromCents(refundTotal)
    }
  });

  const record = (await fetchReturn(tx, tenantId, returnId))!;
  const body: ReturnMutationBody = { return: record, storeCredit };
  await saveIdempotencyRecord(
    tx,
    tenantId,
    CREATE_SCOPE,
    input.idempotencyKey,
    requestHash,
    201,
    redactForStore(body)
  );
  return { kind: "created", body };
}

// ---------------------------------------------------------------------------
// Refund an existing return (the part left unrefunded)
// ---------------------------------------------------------------------------

export type CreateRefundsOutcome =
  | { kind: "feature_disabled" }
  | { kind: "return_not_found" }
  | { kind: "nothing_to_refund" }
  | { kind: "refund_exceeds_refundable"; refundable: string; requested: string }
  | { kind: "refund_refused"; refusal: SettleRefundRefusal }
  | { kind: "created" | "replayed"; body: ReturnMutationBody };

/**
 * Plans and creates the refund legs for the part of a return that has no
 * refund leg yet (a return recorded without a refund, or after a leg was
 * abandoned). The unrefunded amount is
 * `refund_total - Σ legs that are not failed`; a failed leg is retried, not
 * duplicated, so it does not count as refunded and is never re-planned here -
 * the operator retries or settles it offline.
 */
export async function createRefundsForReturn(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  returnId: string,
  idempotencyKey: string,
  refund: CreateReturnRefundInput,
  now: Date,
  correlationId?: string
): Promise<CreateRefundsOutcome> {
  const features = await fetchCommerceFeatures(tx, tenantId);
  if (!features.returns) return { kind: "feature_disabled" };

  const peek = (await tx`
    SELECT order_id FROM awcms_commerce_returns
    WHERE tenant_id = ${tenantId} AND id = ${returnId}
  `) as { order_id: string }[];
  if (!peek[0]) return { kind: "return_not_found" };
  const orderId = peek[0].order_id;

  const requestHash = computeRequestHash({
    action: REFUND_SCOPE,
    actorTenantUserId,
    returnId,
    refund
  });
  const header = await lockOrderForSettlement(tx, tenantId, orderId);
  if (!header) return { kind: "return_not_found" };

  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    REFUND_SCOPE,
    idempotencyKey
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      body: existing.responseBody as ReturnMutationBody
    };
  }

  const totals = (await tx`
    SELECT r.refund_total,
      COALESCE((
        SELECT SUM(f.amount) FROM awcms_commerce_refunds f
        WHERE f.tenant_id = r.tenant_id AND f.return_id = r.id
          AND f.status <> 'failed'
      ), 0) AS covered
    FROM awcms_commerce_returns r
    WHERE r.tenant_id = ${tenantId} AND r.id = ${returnId}
  `) as { refund_total: string; covered: string }[];
  const owedCents =
    toCents(String(totals[0]!.refund_total)) -
    toCents(String(totals[0]!.covered));
  if (owedCents <= 0n) return { kind: "nothing_to_refund" };

  const planned = await planAndVetRefund(
    tx,
    tenantId,
    orderId,
    owedCents,
    refund,
    actorTenantUserId
  );
  if (!planned.ok) {
    const outcome = planned.outcome;
    if (
      outcome.kind === "refund_exceeds_refundable" ||
      outcome.kind === "refund_refused"
    ) {
      return outcome;
    }
    throw new RefundInvariantError("Unexpected refund planning outcome.");
  }

  const serial = (await tx`
    SELECT count(*)::int AS legs FROM awcms_commerce_refunds
    WHERE tenant_id = ${tenantId} AND return_id = ${returnId}
  `) as { legs: number }[];
  const settled = await writeAndSettleLegs(tx, tenantId, {
    returnId,
    orderId,
    legs: planned.legs,
    refund,
    // The key is part of the leg's source key so a replay after a lost
    // idempotency record cannot create a second set of legs.
    sourceKeyPrefix: `return:${returnId}:late:${idempotencyKey}:${Number(serial[0]!.legs)}`,
    actorTenantUserId,
    now,
    correlationId
  });

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "return.refund",
    resourceType: "commerce_return",
    resourceId: returnId,
    message: `Refund of ${fromCents(owedCents)} planned for return ${returnId} on order ${header.orderCode}.`,
    attributes: {
      orderId,
      orderCode: header.orderCode,
      amount: fromCents(owedCents),
      legs: planned.legs.length
    },
    correlationId
  });

  const record = (await fetchReturn(tx, tenantId, returnId))!;
  const body: ReturnMutationBody = {
    return: record,
    storeCredit: settled.storeCredit
  };
  await saveIdempotencyRecord(
    tx,
    tenantId,
    REFUND_SCOPE,
    idempotencyKey,
    requestHash,
    201,
    redactForStore(body)
  );
  return { kind: "created", body };
}

// ---------------------------------------------------------------------------
// Exchange link
// ---------------------------------------------------------------------------

export type LinkExchangeOutcome =
  | { kind: "feature_disabled" }
  | { kind: "return_not_found" }
  | { kind: "not_an_exchange" }
  | { kind: "already_linked"; exchangeOrderId: string }
  | { kind: "exchange_order_invalid" }
  | { kind: "linked" | "replayed"; return: ReturnRecord };

/**
 * Links the replacement order of an exchange to its return - once. An
 * exchange is a return plus a SEPARATE new order; the original order's lines
 * are never edited. Idempotent on `(returnId, orderId)`: linking the same order
 * again replays, linking a different one is refused.
 */
export async function linkExchangeOrder(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  returnId: string,
  exchangeOrderId: string,
  idempotencyKey: string,
  correlationId?: string
): Promise<LinkExchangeOutcome> {
  const features = await fetchCommerceFeatures(tx, tenantId);
  if (!features.returns) return { kind: "feature_disabled" };

  const peek = (await tx`
    SELECT order_id FROM awcms_commerce_returns
    WHERE tenant_id = ${tenantId} AND id = ${returnId}
  `) as { order_id: string }[];
  if (!peek[0]) return { kind: "return_not_found" };
  const header = await lockOrderForSettlement(tx, tenantId, peek[0].order_id);
  if (!header) return { kind: "return_not_found" };

  const requestHash = computeRequestHash({
    action: EXCHANGE_SCOPE,
    actorTenantUserId,
    returnId,
    exchangeOrderId
  });
  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    EXCHANGE_SCOPE,
    idempotencyKey
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    const record = await fetchReturn(tx, tenantId, returnId);
    return { kind: "replayed", return: record! };
  }

  const rows = (await tx`
    SELECT kind, exchange_order_id FROM awcms_commerce_returns
    WHERE tenant_id = ${tenantId} AND id = ${returnId}
    FOR UPDATE
  `) as { kind: string; exchange_order_id: string | null }[];
  const row = rows[0]!;
  if (row.kind !== "exchange") return { kind: "not_an_exchange" };
  if (row.exchange_order_id !== null) {
    if (row.exchange_order_id === exchangeOrderId) {
      return {
        kind: "replayed",
        return: (await fetchReturn(tx, tenantId, returnId))!
      };
    }
    return { kind: "already_linked", exchangeOrderId: row.exchange_order_id };
  }

  const orders = (await tx`
    SELECT status FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId} AND id = ${exchangeOrderId}
      AND id <> ${peek[0].order_id} AND deleted_at IS NULL
  `) as { status: string }[];
  if (!orders[0] || ["cancelled", "expired"].includes(orders[0].status)) {
    return { kind: "exchange_order_invalid" };
  }

  await tx`
    UPDATE awcms_commerce_returns
    SET exchange_order_id = ${exchangeOrderId}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${returnId}
  `;
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "return.link_exchange",
    resourceType: "commerce_return",
    resourceId: returnId,
    message: `Exchange order linked to return ${returnId}.`,
    attributes: {
      orderId: peek[0].order_id,
      exchangeOrderId
    },
    correlationId
  });
  const record = (await fetchReturn(tx, tenantId, returnId))!;
  await saveIdempotencyRecord(
    tx,
    tenantId,
    EXCHANGE_SCOPE,
    idempotencyKey,
    requestHash,
    200,
    { returnId }
  );
  return { kind: "linked", return: record };
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

export type ReturnsReconcileFinding = {
  kind:
    | "over_returned_line"
    | "settled_refund_without_reversal"
    | "reversal_without_refund"
    | "refund_exceeds_payment"
    | "return_refund_total_mismatch"
    | "restock_mismatch"
    | "open_return_fully_refunded";
  id: string;
  detail: string;
};

export type ReturnsReconcileReport = {
  checkedReturns: number;
  findings: ReturnsReconcileFinding[];
};

export const RETURNS_RECONCILE_FINDING_LIMIT = 500;

/**
 * Read-only reconciliation of the returns / refunds / payment-ledger trio.
 * Each check is a set-based query that returns only the BROKEN rows (bounded
 * to {@link RETURNS_RECONCILE_FINDING_LIMIT}); a healthy tenant costs six
 * index-backed aggregates and returns an empty list. Nothing is repaired -
 * every table involved is append-only or a state machine, and a disagreement
 * between them needs a human.
 */
export async function reconcileReturns(
  tx: Bun.SQL,
  tenantId: string
): Promise<ReturnsReconcileReport> {
  const findings: ReturnsReconcileFinding[] = [];
  const push = (finding: ReturnsReconcileFinding) => {
    if (findings.length < RETURNS_RECONCILE_FINDING_LIMIT) {
      findings.push(finding);
    }
  };

  const over = (await tx`
    SELECT i.id, i.quantity, SUM(l.quantity)::int AS returned
    FROM awcms_commerce_order_items i
    JOIN awcms_commerce_return_lines l
      ON l.tenant_id = i.tenant_id AND l.order_item_id = i.id
    WHERE i.tenant_id = ${tenantId}
    GROUP BY i.id, i.quantity
    HAVING SUM(l.quantity) > i.quantity
    LIMIT ${RETURNS_RECONCILE_FINDING_LIMIT}
  `) as { id: string; quantity: number; returned: number }[];
  for (const row of over) {
    push({
      kind: "over_returned_line",
      id: row.id,
      detail: `${row.returned} returned of ${row.quantity} sold.`
    });
  }

  const noReversal = (await tx`
    SELECT f.id
    FROM awcms_commerce_refunds f
    LEFT JOIN awcms_commerce_payment_allocations a
      ON a.tenant_id = f.tenant_id AND a.id = f.reversal_allocation_id
         AND a.kind = 'reversal' AND a.status = 'succeeded'
         AND a.amount = f.amount AND a.reverses_allocation_id = f.allocation_id
    WHERE f.tenant_id = ${tenantId} AND f.status = 'succeeded' AND a.id IS NULL
    LIMIT ${RETURNS_RECONCILE_FINDING_LIMIT}
  `) as { id: string }[];
  for (const row of noReversal) {
    push({
      kind: "settled_refund_without_reversal",
      id: row.id,
      detail:
        "A succeeded refund has no matching payment-ledger reversal (same payment, same amount)."
    });
  }

  const orphanReversal = (await tx`
    SELECT a.id
    FROM awcms_commerce_payment_allocations a
    WHERE a.tenant_id = ${tenantId} AND a.kind = 'reversal'
      AND a.source_key LIKE 'refund:%'
      AND NOT EXISTS (
        SELECT 1 FROM awcms_commerce_refunds f
        WHERE f.tenant_id = a.tenant_id AND f.reversal_allocation_id = a.id
      )
    LIMIT ${RETURNS_RECONCILE_FINDING_LIMIT}
  `) as { id: string }[];
  for (const row of orphanReversal) {
    push({
      kind: "reversal_without_refund",
      id: row.id,
      detail: "A refund-sourced payment reversal belongs to no refund leg."
    });
  }

  const overRefund = (await tx`
    SELECT a.id, a.amount,
      COALESCE(SUM(f.amount) FILTER (WHERE f.status IN ('pending','processing','succeeded')), 0) AS refunded
    FROM awcms_commerce_payment_allocations a
    JOIN awcms_commerce_refunds f
      ON f.tenant_id = a.tenant_id AND f.allocation_id = a.id
    WHERE a.tenant_id = ${tenantId}
    GROUP BY a.id, a.amount
    HAVING COALESCE(SUM(f.amount) FILTER (WHERE f.status IN ('pending','processing','succeeded')), 0) > a.amount
    LIMIT ${RETURNS_RECONCILE_FINDING_LIMIT}
  `) as { id: string; amount: string; refunded: string }[];
  for (const row of overRefund) {
    push({
      kind: "refund_exceeds_payment",
      id: row.id,
      detail: `${row.refunded} refunded along a payment of ${row.amount}.`
    });
  }

  const totalMismatch = (await tx`
    SELECT r.id, r.goods_gross, r.discount_share, r.shipping_refund, r.refund_total,
      COALESCE(SUM(l.goods_gross), 0) AS lines_gross,
      COALESCE(SUM(l.discount_share), 0) AS lines_discount
    FROM awcms_commerce_returns r
    LEFT JOIN awcms_commerce_return_lines l
      ON l.tenant_id = r.tenant_id AND l.return_id = r.id
    WHERE r.tenant_id = ${tenantId}
    GROUP BY r.id
    HAVING r.goods_gross <> COALESCE(SUM(l.goods_gross), 0)
        OR r.discount_share <> COALESCE(SUM(l.discount_share), 0)
    LIMIT ${RETURNS_RECONCILE_FINDING_LIMIT}
  `) as { id: string }[];
  for (const row of totalMismatch) {
    push({
      kind: "return_refund_total_mismatch",
      id: row.id,
      detail:
        "A return's goods / discount split differs from the sum of its lines."
    });
  }

  const restock = (await tx`
    SELECT l.id, l.quantity, l.stock_effect, l.disposition
    FROM awcms_commerce_return_lines l
    WHERE l.tenant_id = ${tenantId}
      AND l.stock_effect <> CASE WHEN l.disposition = 'restock' THEN l.quantity ELSE 0 END
    LIMIT ${RETURNS_RECONCILE_FINDING_LIMIT}
  `) as { id: string }[];
  for (const row of restock) {
    push({
      kind: "restock_mismatch",
      id: row.id,
      detail: "A return line's stock effect disagrees with its disposition."
    });
  }

  const stale = (await tx`
    SELECT r.id
    FROM awcms_commerce_returns r
    WHERE r.tenant_id = ${tenantId} AND r.status = 'open' AND r.refund_total > 0
      AND r.refund_total = (
        SELECT COALESCE(SUM(f.amount), 0) FROM awcms_commerce_refunds f
        WHERE f.tenant_id = r.tenant_id AND f.return_id = r.id AND f.status = 'succeeded'
      )
    LIMIT ${RETURNS_RECONCILE_FINDING_LIMIT}
  `) as { id: string }[];
  for (const row of stale) {
    push({
      kind: "open_return_fully_refunded",
      id: row.id,
      detail: "Every leg settled but the return is still open."
    });
  }

  const counted = (await tx`
    SELECT count(*)::int AS n FROM awcms_commerce_returns WHERE tenant_id = ${tenantId}
  `) as { n: number }[];
  return { checkedReturns: Number(counted[0]!.n), findings };
}
