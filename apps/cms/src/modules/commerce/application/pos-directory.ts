/**
 * `POST /api/v1/commerce/pos/orders` / `GET /api/v1/commerce/pos/orders` —
 * counter (POS) sales (Issue #116, epic #33 C7, contract #106's D6,
 * ADR-0017). The transactional heart mirrors
 * `application/order-directory.ts`'s `createOrderFromCart` — ONE function
 * re-quotes the cart, writes the order + items, decrements stock/a
 * flash-sale's quota, all inside one transaction — but is its OWN function
 * rather than a call into `createOrderFromCart` itself, for three reasons a
 * counter sale genuinely differs on:
 *
 * 1. **Payment**: `createOrderFromCart` gates the chosen method against
 *    `quote.paymentMethods` (store-settings-driven — manual bank/QRIS/DP/
 *    gateway availability), which knows nothing about `"cash"`. A POS sale
 *    is paid on the spot, through one or more TENDERS (Issue #285,
 *    ADR-0025) — there is no `paymentMethods` availability question to ask.
 * 2. **Status**: `createOrderFromCart` always leaves an order
 *    `pending_payment`. A POS sale inserts `pending_payment` (reusing the
 *    SAME initial `order_events` row shape) and then records its tenders in
 *    the payment-allocation ledger (`payment-allocation-directory.ts`); the
 *    moment settlement covers the total the order moves to `paid` through
 *    `order-directory.ts`'s one `transitionOrderStatus` (actor `"admin"`) —
 *    for an ordinary fully-tendered sale that is within this same call, so
 *    the observable result is unchanged. A sale rung up with `allowDue`
 *    (permission `commerce.pos_due.create`) legitimately ends with a balance
 *    DUE: it stays `pending_payment`, `payment_status` `unpaid`/
 *    `partially_paid`, `expires_at` NULL (the expiry job never reclaims a
 *    counter sale's stock), and later payments settle it.
 *
 * ## Tenders (Issue #285, ADR-0025)
 *
 * The request carries EITHER the legacy `payment: { method, amountTendered }`
 * (adapted here to exactly one ledger leg — same arithmetic, same errors as
 * before) OR an explicit `tenders[]`. `domain/payment-allocation.ts`'s
 * `planTenders` turns either into the legs to write: non-cash tenders are
 * subtracted from the amount due first, cash is applied to what is left, and
 * change comes from the cash leg ONLY (never hiding a shortfall on another
 * tender). `orders.payment_method` is kept as a legacy summary hint (the
 * tender with the largest applied amount); the ledger is the truth.
 * 3. **No address/voucher/affiliate/DP**: none of `createOrderFromCart`'s
 *    address snapshot, voucher redemption, or affiliate attribution apply
 *    to a counter sale — `shipping` is always `self_pickup`, no address is
 *    ever stored.
 *
 * The QUOTE/STOCK path IS reused, though — `buildCartQuote` (the same
 * function `createOrderFromCart` calls) re-prices every line and re-checks
 * stock inside this transaction, so a cashier can never ring up a price the
 * catalog no longer honours or a quantity the shelf no longer has. A
 * phone-identified customer's `level` is passed through as `customerLevel`
 * (#118 tiered pricing) — a level-2 partner buying at the counter pays the
 * same `price_level_2` they would online.
 *
 * ## Walk-in customer (contract #106 D6)
 *
 * `awcms_commerce_customers.phone` is `NOT NULL` (`sql/913`), so a counter
 * sale with no phone at all still needs a real customer row. When
 * `customer.phone` is blank, `createPosOrder` calls the SAME
 * `findOrCreateCustomerByPhone` a phone-identified sale uses, with
 * `domain/phone-normalisation.ts`'s documented
 * `POS_WALK_IN_CUSTOMER_SENTINEL_PHONE` — so every tenant gets exactly ONE
 * walk-in row, reused (never re-created) across every no-phone sale. A
 * phone that IS given but does not normalise is a `400` (`invalid_phone`),
 * never a silent fall-back to the walk-in row — the cashier typed something
 * and must be told it was wrong.
 *
 * ## Idempotency
 *
 * Same shared `awcms_idempotency_keys` store every other high-risk mutation
 * uses (`_shared/idempotency.ts`), scoped `"commerce.pos.create"` —
 * `(tenantId, scope, idempotencyKey)`. Same key + same payload replays the
 * stored 201 body; same key + different payload is
 * `IdempotencyPayloadMismatchError` (409 `IDEMPOTENCY_CONFLICT`). The acting
 * tenant user is part of the hashed payload (`awcms-idempotency` skill's
 * "bind the hash to the resource" rule): two cashiers who happen to reuse
 * one key value can never have the second replay the first's sale.
 */
import { finaliseOrderTax } from "./tax-adapter-directory";
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  InventoryLedgerRefusedError,
  postOrderSale,
  resolveInventoryConfig,
  withInventorySavepoint,
  type InventoryConfig,
  type SaleLine
} from "./commerce-inventory";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../_shared/idempotency";
import {
  keysetCursorCreatedAtSql,
  encodeKeysetCursor,
  type KeysetCursor
} from "../../_shared/keyset-pagination";
import type { MediaLibraryPort } from "../../_shared/ports/media-library-port";
import { normalizeMoney } from "../domain/price-calculation";
import {
  normalizePhoneNumber,
  maskPhone,
  POS_WALK_IN_CUSTOMER_SENTINEL_PHONE
} from "../domain/phone-normalisation";
import { generateOrderCode } from "../domain/order-code";
import type { OrderStatus } from "../domain/order-status";
import type { CustomerLevel } from "../domain/cart-quote";
import {
  POS_WALK_IN_CUSTOMER_NAME,
  type CreatePosOrderInput
} from "../domain/pos-order-validation";
import {
  planTenders,
  tenderToOrderPaymentMethod,
  type OrderPaymentMethodHint,
  type TenderInput,
  type TenderPlan
} from "../domain/payment-allocation";
import { isStoredValueTender } from "../domain/stored-value";
import {
  preflightStoredValueLegs,
  redactTendersForHash,
  resolveStoredValueAccounts
} from "./stored-value-tender";
import { StoredValueInvariantError } from "./stored-value-ledger";
import { fromCents, toCents } from "../domain/price-calculation";
import {
  COMMERCE_EVENT_VERSION,
  COMMERCE_ORDER_AGGREGATE_TYPE,
  COMMERCE_ORDER_CREATED_EVENT_TYPE
} from "../domain/commerce-events";
import { buildCartQuote } from "./cart-quote-service";
import { fetchCommerceFeatures } from "./commerce-feature-gate";
import { FeatureDisabledError } from "../domain/commerce-features";
import { gateSaleToRegisterSession } from "./register-session-directory";
import { findOrCreateCustomerByPhone } from "./customer-directory";
import {
  fetchOrderDetailForAdmin,
  IdempotencyPayloadMismatchError,
  makeOrderRelease,
  toAdminOrderRecord,
  type OrderAdminDetailRecord,
  type OrderAdminSummary
} from "./order-directory";
import { recordPaymentAllocation } from "./payment-allocation-directory";
import type { CartQuoteResult } from "../domain/cart-quote";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "order";
const PRODUCER_MODULE = "commerce";
const IDEMPOTENCY_SCOPE = "commerce.pos.create";
/** The audit action every counter sale records (skill `awcms-audit-log`: a posted transaction MUST be audited). */
export const POS_SALE_AUDIT_ACTION = "commerce.pos.sale";
const POSTGRES_UNIQUE_VIOLATION = "23505";
const ORDER_CODE_CONSTRAINT = "awcms_commerce_orders_tenant_code_key";
const MAX_ORDER_CODE_ATTEMPTS = 5;

export const POS_ORDER_LIST_LIMIT = 50;

export class PosCartChangedError extends Error {
  public readonly quote: CartQuoteResult;
  constructor(quote: CartQuoteResult) {
    super(
      "One or more lines changed price/stock since the cart was priced; re-quote."
    );
    this.name = "PosCartChangedError";
    this.quote = quote;
  }
}

/**
 * A sale with a balance DUE needs a customer who can be asked to pay it — the
 * tenant's single walk-in row cannot. Raised before anything is written; the
 * route answers `400 VALIDATION_ERROR` on `customer.phone`.
 */
export class PosDueRequiresCustomerError extends Error {
  constructor() {
    super(
      "A sale left with a balance due must be attached to a customer phone."
    );
    this.name = "PosDueRequiresCustomerError";
  }
}

/**
 * Issue #284 (ADR-0028) - the register gate refused a sale. `code` is the
 * route's `409`/`400`/`404` discriminator:
 *   - `REGISTER_REQUIRED`: the tenant's `register` feature is on and the
 *     request named no register (`400 VALIDATION_ERROR` on `registerId`);
 *   - `REGISTER_NOT_FOUND`: the register does not exist for this tenant (the
 *     same answer for an unknown and another tenant's id - no oracle);
 *   - `REGISTER_SESSION_REQUIRED`: the register has no open session;
 *   - `REGISTER_SESSION_CLOSING`: its session is counting/awaiting approval;
 *   - `NOT_SESSION_CASHIER`: the session belongs to another cashier.
 * Raised BEFORE anything is written.
 */
export class PosRegisterSessionError extends Error {
  public readonly code:
    | "REGISTER_REQUIRED"
    | "REGISTER_NOT_FOUND"
    | "REGISTER_SESSION_REQUIRED"
    | "REGISTER_SESSION_CLOSING"
    | "NOT_SESSION_CASHIER";
  constructor(code: PosRegisterSessionError["code"]) {
    super(`POS sale refused by the register gate: ${code}.`);
    this.name = "PosRegisterSessionError";
    this.code = code;
  }
}

/**
 * The 201 body — the admin order record (unmasked phone: this is a staff
 * context; it carries the order's `settlement` and its `payments` ledger rows,
 * so a receipt can print every tender) plus the aggregate `change` (the cash
 * leg's change, `numeric(14,2)` string; `null` when the sale had no cash leg),
 * the cash `amountTendered` echoed back (`null` when no cash leg), and the
 * cashier's own tenant user id. `settlement.outstanding` is the explicit due
 * balance of an `allowDue` sale (`"0.00"` for an ordinary one).
 */
export type PosOrderRecord = OrderAdminDetailRecord & {
  change: string | null;
  amountTendered: string | null;
  cashierTenantUserId: string;
  /** Issue #284 - the register session the sale was attached to; `null` when the tenant's `register` feature is off. */
  registerSessionId: string | null;
};

/** The legacy single-tender payload, adapted to the tender vocabulary. */
function adaptLegacyPayment(
  payment: NonNullable<CreatePosOrderInput["payment"]>
): TenderInput[] {
  return payment.method === "cash"
    ? [
        {
          tenderType: "cash",
          amount: payment.amountTendered,
          reference: null
        }
      ]
    : // A legacy QRIS payload carries no amount: the sale is paid exactly.
      [{ tenderType: "manual_qris", amount: null, reference: null }];
}

/** The legacy `orders.payment_method` summary hint: the tender with the largest applied amount (first on a tie); `cash` when nothing was tendered at all. */
function summaryPaymentMethod(plan: TenderPlan): OrderPaymentMethodHint {
  let best: TenderPlan["legs"][number] | null = null;
  for (const leg of plan.legs) {
    if (best === null || toCents(leg.amount) > toCents(best.amount)) best = leg;
  }
  return best ? tenderToOrderPaymentMethod(best.tenderType) : "cash";
}

export type CreatePosOrderOutcome =
  | { kind: "replayed"; order: PosOrderRecord }
  | { kind: "created"; order: PosOrderRecord }
  | { kind: "invalid_phone" };

/**
 * `POST /api/v1/commerce/pos/orders` — a `paid`, `self_pickup`, `channel:
 * "pos"` counter sale, created and settled in one call. See this file's
 * header for the full reasoning.
 *
 * @throws {IdempotencyPayloadMismatchError} same key, different payload.
 * @throws {PosCartChangedError} a line's price/stock no longer allows checkout.
 * @throws {InsufficientTenderError} cash tendered is less than the total.
 */
export async function createPosOrder(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  mediaPort: MediaLibraryPort,
  input: CreatePosOrderInput,
  now: Date = new Date(),
  correlationId?: string
): Promise<CreatePosOrderOutcome> {
  // Issue #282 (ADR-0038 D2): in `ledger` mode the whole sale runs in a
  // savepoint, so a ledger refusal leaves no half-written order behind and the
  // route's 409 (which the handler's commit then honours) is safe.
  const inventory = await resolveInventoryConfig(tx, tenantId);

  try {
    return await withInventorySavepoint(tx, inventory, (db) =>
      createPosOrderWrite(
        db,
        tenantId,
        actorTenantUserId,
        mediaPort,
        input,
        now,
        correlationId,
        inventory
      )
    );
  } catch (error) {
    // Out of stock is the answer the cashier already gets for a cart that
    // changed; any other refusal is an operator's problem (409 from the route).
    if (
      error instanceof InventoryLedgerRefusedError &&
      error.kind === "insufficient_stock" &&
      error.quote
    ) {
      throw new PosCartChangedError(error.quote);
    }
    throw error;
  }
}

async function createPosOrderWrite(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  mediaPort: MediaLibraryPort,
  input: CreatePosOrderInput,
  now: Date,
  correlationId: string | undefined,
  inventory: InventoryConfig
): Promise<CreatePosOrderOutcome> {
  const requestHash = computeRequestHash({
    action: IDEMPOTENCY_SCOPE,
    actorTenantUserId,
    customer: input.customer,
    lines: input.lines,
    // `undefined` drops out of the hash, so a LEGACY request hashes exactly
    // as it did before Issue #285 (a replay across the deploy still matches).
    payment: input.payment ?? undefined,
    // Issue #288 - a gift-card / store-credit code is replaced by its
    // tenant-scoped hash: the idempotency table must never hold anything
    // derived from the plaintext by a weaker function. A tender without a code
    // hashes exactly as before.
    tenders: redactTendersForHash(tenantId, input.tenders),
    allowDue: input.allowDue ? true : undefined,
    // Issue #284 - `undefined` drops out, so a request without a register
    // hashes exactly as before.
    registerId: input.registerId ?? undefined,
    notes: input.notes
  });

  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    IDEMPOTENCY_SCOPE,
    input.idempotencyKey
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      order: existing.responseBody as PosOrderRecord
    };
  }

  // Issue #284 (ADR-0028) - with the tenant's `register` feature on, the sale
  // must be rung up on a register with an OPEN session whose current cashier
  // is the actor; the session is locked FOR SHARE for the rest of this
  // transaction, so a close cannot land between this check and the order
  // insert. With the feature off, POS is exactly what it was - and naming a
  // register is refused (the sale would otherwise look attached and not be).
  let registerSessionId: string | null = null;
  const features = await fetchCommerceFeatures(tx, tenantId);
  if (features.register) {
    if (!input.registerId)
      throw new PosRegisterSessionError("REGISTER_REQUIRED");
    const gate = await gateSaleToRegisterSession(
      tx,
      tenantId,
      input.registerId,
      actorTenantUserId
    );
    switch (gate.kind) {
      case "ok":
        registerSessionId = gate.sessionId;
        break;
      case "register_not_found":
        throw new PosRegisterSessionError("REGISTER_NOT_FOUND");
      case "no_open_session":
        throw new PosRegisterSessionError("REGISTER_SESSION_REQUIRED");
      case "session_closing":
        throw new PosRegisterSessionError("REGISTER_SESSION_CLOSING");
      case "not_session_cashier":
        throw new PosRegisterSessionError("NOT_SESSION_CASHIER");
    }
  } else if (input.registerId) {
    throw new FeatureDisabledError("register");
  }

  // Walk-in when no phone was given; otherwise find-or-create by the
  // normalised phone, exactly like a storefront guest checkout — resolved
  // BEFORE the quote so the customer's `level` can price it (#118).
  let customerPhone = POS_WALK_IN_CUSTOMER_SENTINEL_PHONE;
  if (input.customer.phone) {
    const phoneResult = normalizePhoneNumber(input.customer.phone);
    if (!phoneResult.valid) return { kind: "invalid_phone" };
    customerPhone = phoneResult.value;
  }
  const isWalkIn = customerPhone === POS_WALK_IN_CUSTOMER_SENTINEL_PHONE;
  const customerName =
    input.customer.name ??
    (isWalkIn ? POS_WALK_IN_CUSTOMER_NAME : "Pelanggan POS");

  const customer = await findOrCreateCustomerByPhone(
    tx,
    tenantId,
    customerName,
    customerPhone,
    null,
    correlationId
  );
  const customerLevel: CustomerLevel | null =
    !isWalkIn && customer.level >= 1 && customer.level <= 4
      ? (customer.level as CustomerLevel)
      : null;

  const quote = await buildCartQuote(
    tx,
    tenantId,
    mediaPort,
    {
      lines: input.lines.map((line) => ({
        productId: line.productId,
        variantId: line.variantId,
        quantity: line.quantity,
        serviceFormValues: null
      })),
      shipping: { method: "self_pickup" },
      voucherCode: null,
      insurance: false,
      destination: null,
      customerLevel
    },
    now
  );

  // `canCheckout` is lines-only (every line `status: "ok"`): `quote.shipping`
  // may legitimately be `null` when the tenant never enabled self-pickup in
  // its store settings — a counter sale IS a pickup by definition, so the
  // storefront's shipping/payment availability never decides a POS sale.
  // The store's tax setting DOES apply (`quote.tax`), exactly as online.
  if (!quote.canCheckout) {
    throw new PosCartChangedError(quote);
  }

  // Throws `InsufficientTenderError` on a short tender (unless `allowDue`),
  // `OverpaymentError` when non-cash tenders exceed the total — the route maps
  // them to a `409`, never silently records a negative change or hides a
  // shortfall behind another tender's change. A legacy QRIS payload is exact.
  const tenders: TenderInput[] =
    input.tenders ?? adaptLegacyPayment(input.payment!);
  const plan = planTenders(quote.total, tenders, { allowDue: input.allowDue });
  if (toCents(plan.dueAmount) > 0n && isWalkIn) {
    throw new PosDueRequiresCustomerError();
  }
  const change = plan.changeAmount;
  const amountTendered = plan.cashTendered;

  // Issue #288 (ADR-0030) - stored-value tenders. Resolve each code to its
  // account, then lock every account involved and refuse (with a typed error,
  // BEFORE any row of this sale exists) whatever cannot be redeemed in full.
  // The locks last to the end of this transaction, so nothing can spend the
  // card between this check and the redemption below; the order does not
  // exist yet, so no other transaction can hold or want a lock on it
  // (lock order stays order -> account everywhere it can matter).
  const storedValueLegs = plan.legs.flatMap((leg, index) =>
    isStoredValueTender(leg.tenderType) && leg.storedValueCode
      ? [{ index, leg, code: leg.storedValueCode }]
      : []
  );
  const storedValueAccountByLeg = new Map<number, string>();
  if (storedValueLegs.length > 0) {
    if (!features.storedValue) throw new FeatureDisabledError("storedValue");
    const accountIds = await resolveStoredValueAccounts(
      tx,
      tenantId,
      actorTenantUserId,
      storedValueLegs.map(({ leg, code }) => ({
        tenderType: leg.tenderType as "gift_card" | "store_credit",
        code
      }))
    );
    storedValueLegs.forEach(({ index }, position) => {
      storedValueAccountByLeg.set(index, accountIds[position]!);
    });
    await preflightStoredValueLegs(
      tx,
      tenantId,
      storedValueLegs.map(({ index, leg }) => ({
        accountId: storedValueAccountByLeg.get(index)!,
        tenderType: leg.tenderType as "gift_card" | "store_credit",
        amount: leg.amount
      }))
    );
  }

  let orderId = "";
  let orderCode = "";
  for (let attempt = 0; attempt < MAX_ORDER_CODE_ATTEMPTS; attempt += 1) {
    const candidateCode = generateOrderCode(now);
    try {
      const rows = (await tx`
        INSERT INTO awcms_commerce_orders (
          tenant_id, order_code, customer_id, status, payment_method, payment_status,
          shipping_method, shipping_cost, subtotal, discount, insurance_fee, tax, total,
          notes, channel, pos_cashier_tenant_user_id, register_session_id
        )
        VALUES (
          ${tenantId}, ${candidateCode}, ${customer.id}, 'pending_payment', ${summaryPaymentMethod(plan)}, 'unpaid',
          'self_pickup', '0.00', ${quote.subtotal}, ${quote.discount}, ${quote.insurance.fee}, ${quote.tax.amount},
          ${quote.total}, ${input.notes}, 'pos', ${actorTenantUserId}, ${registerSessionId}
        )
        RETURNING id, order_code
      `) as { id: string; order_code: string }[];
      orderId = rows[0]!.id;
      orderCode = rows[0]!.order_code;
      break;
    } catch (error) {
      const isCollision =
        error instanceof Bun.SQL.PostgresError &&
        String(error.errno) === POSTGRES_UNIQUE_VIOLATION &&
        error.constraint === ORDER_CODE_CONSTRAINT;
      if (!isCollision || attempt === MAX_ORDER_CODE_ATTEMPTS - 1) throw error;
    }
  }

  // Issue #282 (ADR-0038 D2) - the stock authority. A POS sale is a commerce
  // order with order items, so in `ledger` mode it posts the SAME
  // `{commerce_order, orderId, orderItemId}` identity a storefront order does,
  // and the cancel/expiry restock finds it there.
  const ledgerLines: SaleLine[] = [];

  // Sequential — one reserved `tx` connection (`tenant-route.ts`'s header).
  const orderItemIds: string[] = [];
  for (const line of quote.lines) {
    const itemRows = (await tx`
      INSERT INTO awcms_commerce_order_items (
        tenant_id, order_id, product_id, variant_id, flash_sale_id,
        name, variant_name, sku, unit_price, quantity, weight_grams, line_total
      )
      VALUES (
        ${tenantId}, ${orderId}, ${line.productId}, ${line.variantId}, ${line.flashSaleId},
        ${line.name}, ${line.variantName}, ${line.sku}, ${line.unitPrice}, ${line.quantity},
        ${line.weightGrams}, ${line.lineTotal}
      )
      RETURNING id
    `) as { id: string }[];
    orderItemIds.push(itemRows[0]!.id);

    if (inventory.mode === "ledger") {
      ledgerLines.push({
        lineId: itemRows[0]!.id,
        productId: line.productId,
        variantId: line.variantId,
        quantity: line.quantity
      });
    } else if (line.variantId) {
      await tx`
        UPDATE awcms_commerce_product_variants
        SET stock = stock - ${line.quantity}, updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${line.variantId} AND deleted_at IS NULL
      `;
    } else {
      await tx`
        UPDATE awcms_commerce_products
        SET stock = stock - ${line.quantity}, updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${line.productId} AND deleted_at IS NULL
      `;
    }

    if (line.flashSaleId) {
      await tx`
        UPDATE awcms_commerce_flash_sale_products
        SET sold = sold + ${line.quantity}, updated_at = now()
        WHERE tenant_id = ${tenantId}
          AND flash_sale_id = ${line.flashSaleId}
          AND product_id = ${line.productId}
          AND variant_id IS NOT DISTINCT FROM ${line.variantId}
          AND deleted_at IS NULL
      `;
    }
  }

  if (inventory.mode === "ledger") {
    try {
      await postOrderSale(tx, tenantId, inventory, orderId, ledgerLines, {
        actorTenantUserId,
        correlationId
      });
    } catch (error) {
      // The wrapper rolls the savepoint back and answers; the quote rides along.
      if (error instanceof InventoryLedgerRefusedError) error.quote = quote;
      throw error;
    }
  }

  // Issue #293 (ADR-0039) — engine mode: finalise this sale's tax snapshot and
  // link it; a no-op in flat mode.
  await finaliseOrderTax(tx, tenantId, {
    orderId,
    items: quote.lines.map((line, index) => ({
      orderItemId: orderItemIds[index]!,
      productId: line.productId
    })),
    quote,
    now,
    actorTenantUserId,
    correlationId
  });

  // Initial `order_events` row — actor `"admin"` (a POS sale is staff-rung,
  // never `"customer"`), mirroring `createOrderFromCart`'s own insert shape.
  await tx`
    INSERT INTO awcms_commerce_order_events (tenant_id, order_id, from_status, to_status, actor)
    VALUES (${tenantId}, ${orderId}, NULL, 'pending_payment', 'admin')
  `;

  // Attributes carry no PII: order code, money, method, walk-in flag —
  // never the customer's name/phone (skill `awcms-audit-log` redaction).
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: POS_SALE_AUDIT_ACTION,
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: orderId,
    message: `POS sale ${orderCode} rung up at the counter (${plan.legs.map((leg) => leg.tenderType).join(" + ") || "on account"}).`,
    attributes: {
      orderCode,
      total: quote.total,
      method: summaryPaymentMethod(plan),
      tenders: plan.legs.map((leg) => ({
        tenderType: leg.tenderType,
        amount: leg.amount
      })),
      amountTendered,
      change,
      due: plan.dueAmount,
      walkIn: isWalkIn,
      lineCount: quote.lines.length,
      registerSessionId
    },
    correlationId
  });

  await appendDomainEvent(tx, tenantId, {
    eventType: COMMERCE_ORDER_CREATED_EVENT_TYPE,
    eventVersion: COMMERCE_EVENT_VERSION,
    aggregateType: COMMERCE_ORDER_AGGREGATE_TYPE,
    aggregateId: orderId,
    producerModule: PRODUCER_MODULE,
    correlationId,
    actorTenantUserId,
    payload: { orderId, orderCode, total: quote.total, channel: "pos" }
  });

  // Settle: one ledger leg per planned tender, in order (non-cash first, the
  // cash leg last). Each insert re-derives the order's settlement under the
  // order-row lock; the leg that brings it to the total moves the order
  // `pending_payment -> paid` through `order-directory.ts`'s one
  // `transitionOrderStatus` (actor `"admin"`, via `makeOrderRelease`) — never
  // a second copy of the status bookkeeping. A due balance leaves the order
  // `pending_payment` with its outstanding amount on the ledger.
  const release = makeOrderRelease(
    tx,
    tenantId,
    "admin",
    actorTenantUserId,
    orderId,
    correlationId
  );
  const releaseNote = "POS counter sale — paid at the register.";
  for (const [index, leg] of plan.legs.entries()) {
    const outcome = await recordPaymentAllocation(tx, tenantId, {
      orderId,
      tenderType: leg.tenderType,
      amount: leg.amount,
      providerReference: leg.reference,
      tenderedAmount: leg.tenderedAmount,
      changeAmount: leg.changeAmount,
      storedValueAccountId: storedValueAccountByLeg.get(index) ?? null,
      source: "pos",
      sourceKey: `pos:${input.idempotencyKey}:${index}`,
      actor: { kind: "tenant_user", tenantUserId: actorTenantUserId },
      enforceNoOverpayment: true,
      allowedOrderStatuses: null,
      release,
      releaseNote,
      correlationId
    });
    if (outcome.kind === "stored_value_refused") {
      // Unreachable while the preflight above holds its locks; if it ever
      // fires, throw (never return a response): the unmapped error rolls the
      // whole sale back instead of committing a half-settled one.
      throw new StoredValueInvariantError(
        `A stored-value leg was refused after the preflight (${outcome.refusal}).`
      );
    }
  }
  if (plan.legs.length === 0 && toCents(quote.total) === 0n) {
    // A free sale (total 0.00) owes nothing and has no leg to write: settled
    // by definition, so it is released directly.
    await release(releaseNote);
  }

  const detail = await fetchOrderDetailForAdmin(
    tx,
    tenantId,
    mediaPort,
    orderId
  );
  const record = await toAdminOrderRecord(tx, tenantId, detail!, {
    includePayments: true
  });
  const responseBody: PosOrderRecord = {
    ...record,
    change,
    amountTendered,
    cashierTenantUserId: actorTenantUserId,
    registerSessionId
  };

  await saveIdempotencyRecord(
    tx,
    tenantId,
    IDEMPOTENCY_SCOPE,
    input.idempotencyKey,
    requestHash,
    201,
    responseBody
  );

  return { kind: "created", order: responseBody };
}

// ---------------------------------------------------------------------------
// POS history — `GET /api/v1/commerce/pos/orders`
// ---------------------------------------------------------------------------

export type PosOrderSummary = OrderAdminSummary & {
  paymentMethod: string;
  cashierTenantUserId: string | null;
  /** Issue #285 — what the sale still owes, derived from its payment ledger (`"0.00"` for a settled sale). */
  outstanding: string;
};

export type PosOrderListPage = {
  items: PosOrderSummary[];
  nextCursor: string | null;
};

export type PosOrderListFilters = {
  dateFrom?: Date;
  dateTo?: Date;
  cashierTenantUserId?: string;
};

/**
 * Keyset history, newest first, `channel = 'pos'` only (contract's own
 * `(tenant, channel, created_at)` index, `sql/931`). Optional `dateFrom`/
 * `dateTo` (inclusive bounds) and `cashierTenantUserId` filters narrow the
 * same scan.
 */
export async function listPosOrders(
  tx: Bun.SQL,
  tenantId: string,
  cursor: KeysetCursor | null,
  filters: PosOrderListFilters = {}
): Promise<PosOrderListPage> {
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;
  const dateFrom = filters.dateFrom ?? null;
  const dateTo = filters.dateTo ?? null;
  const cashierTenantUserId = filters.cashierTenantUserId ?? null;

  const rows = (await tx`
    SELECT o.id, o.order_code, o.status, o.payment_status, o.payment_method,
           o.pos_cashier_tenant_user_id, o.total, o.created_at,
           c.name AS customer_name, c.phone AS customer_phone,
           COALESCE(p.settled, 0) AS settled,
           ${tx.unsafe(keysetCursorCreatedAtSql("o"))} AS created_at_cursor
    FROM awcms_commerce_orders o
    JOIN awcms_commerce_customers c ON c.id = o.customer_id
    LEFT JOIN LATERAL (
      SELECT SUM(CASE WHEN a.kind = 'payment' THEN a.amount ELSE -a.amount END) AS settled
      FROM awcms_commerce_payment_allocations a
      WHERE a.tenant_id = o.tenant_id AND a.order_id = o.id AND a.status = 'succeeded'
    ) p ON true
    WHERE o.tenant_id = ${tenantId}
      AND o.channel = 'pos'
      AND o.deleted_at IS NULL
      AND (${dateFrom}::timestamptz IS NULL OR o.created_at >= ${dateFrom})
      AND (${dateTo}::timestamptz IS NULL OR o.created_at <= ${dateTo})
      AND (
        ${cashierTenantUserId}::uuid IS NULL
        OR o.pos_cashier_tenant_user_id = ${cashierTenantUserId}
      )
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (o.created_at, o.id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY o.created_at DESC, o.id DESC
    LIMIT ${POS_ORDER_LIST_LIMIT}
  `) as {
    id: string;
    order_code: string;
    status: string;
    payment_status: string;
    payment_method: string;
    pos_cashier_tenant_user_id: string | null;
    total: string;
    created_at: Date;
    customer_name: string;
    customer_phone: string;
    settled: string;
    created_at_cursor: string;
  }[];

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === POS_ORDER_LIST_LIMIT && last
      ? encodeKeysetCursor(last.created_at_cursor, last.id)
      : null;

  return {
    items: rows.map((row) => ({
      id: row.id,
      orderCode: row.order_code,
      status: row.status as OrderStatus,
      paymentStatus: row.payment_status,
      paymentMethod: row.payment_method,
      cashierTenantUserId: row.pos_cashier_tenant_user_id,
      customerName: row.customer_name,
      customerPhoneMasked: maskPhone(row.customer_phone),
      total: normalizeMoney(row.total),
      outstanding: outstandingOf(row.total, row.settled),
      createdAt: row.created_at.toISOString()
    })),
    nextCursor
  };
}

/** `max(0, total - settled)` in integer cents (ADR-0003). */
function outstandingOf(total: string, settled: string): string {
  const owed =
    toCents(normalizeMoney(total)) - toCents(normalizeMoney(String(settled)));
  return fromCents(owed > 0n ? owed : 0n);
}
