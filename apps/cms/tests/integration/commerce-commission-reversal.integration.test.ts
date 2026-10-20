/**
 * Commission REVERSAL (Issue #391 second half, ADR-0046 D9) against a REAL
 * migrated PostgreSQL through `tests/integration/harness.ts`. Gated on
 * `DATABASE_URL`; skips cleanly without one.
 *
 * Covers what only a database can prove about the two reversing consumers
 * (`commerce.order_cancelled_commission_reverser`,
 * `commerce.refund_settled_commission_reverser`), which void the accrual the
 * accrue half posted through `CommissionAccrualPort.void`:
 *
 *   - pay -> accrue -> refund -> void, and cancel -> void, driven directly as the
 *     app role. DORMANT (ADR-0046 D10): `sql/1053` revoked the worker's
 *     payroll-table grants, so the consumers are not registered and the real
 *     dispatcher, as `awcms_worker`, reverses nothing (last block);
 *   - replay: the same event twice, and a different event for the same fact, are
 *     one void, one transition, one `voided` domain event, one audit row;
 *   - a void with nothing to void (never accrued) is a quiet no-op;
 *   - `period_closed` (payable / paid) is NOT voided, is audited once for a
 *     human, and never throws (so it is never retried);
 *   - a partly returned line keeps its accrual until the last unit is returned;
 *   - tenant isolation, a retired link, the adapter switched off, `hr_commission`
 *     switched off, a missing actor, and what the worker still cannot do.
 *
 * The `hr_workforce` / `hr_commission` fixtures are written straight into those
 * tables - tests only; the module under test never touches them.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import { DORMANT_COMMISSION_CONSUMERS } from "../../src/modules/commerce/module";
import { withTenantOrThrow } from "../../src/lib/database/tenant-context";
import {
  createStaffLink,
  retireStaffLink,
  saveCommissionSettings
} from "../../src/modules/commerce/application/commission-attribution-directory";
import {
  reverseCommissionForCancelledOrder,
  reverseCommissionForSettledRefund
} from "../../src/modules/commerce/application/commission-reversal";
import { transitionAccrual } from "../../src/modules/hr-commission/application/hr-commission-accrual-ledger";
import { appendDomainEvent } from "../../src/modules/domain-event-runtime/application/append-domain-event";
import { dispatchDomainEventsForTenant } from "../../src/modules/domain-event-runtime/application/dispatch-domain-events";
import { listDomainEventConsumers } from "../../src/modules/domain-event-runtime/infrastructure/consumer-registry";
import type { DomainEventForHandler } from "../../src/modules/domain-event-runtime/domain/consumer-types";
import {
  getAdminSql,
  getRuntimeSql,
  getWorkerRoleSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase,
  workerRoleActivated
} from "./harness";

const consumers = DORMANT_COMMISSION_CONSUMERS;
const attributorConsumer = consumers.find(
  (consumer) => consumer.name === "commerce.order_paid_commission_attributor"
)!;
const cancelReverser = consumers.find(
  (consumer) => consumer.name === "commerce.order_cancelled_commission_reverser"
)!;
const refundReverser = consumers.find(
  (consumer) => consumer.name === "commerce.refund_settled_commission_reverser"
)!;

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "aaaaaaaa-0391-4000-8000-000000000001";
const TENANT_B = "bbbbbbbb-0391-4000-8000-000000000002";
const ADMIN_A = "cccccccc-0391-4000-8000-000000000003";

const RULE_KEY = "pos-sales";
const SOURCE_TYPE = "commerce_order_line";
const PAID = "awcms.commerce.order.paid";

/** A recent instant (the ledger refuses a sale older than two years or in the future). */
function recentInstant(daysAgo: number, hourUtc: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  date.setUTCHours(hourUtc, 0, 0, 0);
  return date;
}

function inTenant<T>(
  tenantId: string,
  fn: (tx: Bun.TransactionSQL) => Promise<T>,
  sql: Bun.SQL = getRuntimeSql()
): Promise<T> {
  return withTenantOrThrow(sql, tenantId, fn);
}

async function seedTenant(id: string, code: string): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${code + " Name"}, ${code + " Legal"}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

let userCounter = 0;
async function seedTenantUser(tenantId: string): Promise<string> {
  userCounter += 1;
  const admin = getAdminSql();
  const unique = `commission-${userCounter}`;
  const [profile] = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', ${`Person ${unique}`}) RETURNING id
  `) as { id: string }[];
  const [identity] = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile!.id}, ${`${unique}@example.com`}, 'x') RETURNING id
  `) as { id: string }[];
  const [user] = (await admin`
    INSERT INTO awcms_tenant_users (tenant_id, identity_id)
    VALUES (${tenantId}, ${identity!.id}) RETURNING id
  `) as { id: string }[];
  return user!.id;
}

let employmentCounter = 0;
async function seedEmployment(
  tenantId: string,
  values: { hiredOn?: string; terminatedOn?: string } = {}
): Promise<string> {
  employmentCounter += 1;
  const admin = getAdminSql();
  const [profile] = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', ${`Employee ${employmentCounter}`}) RETURNING id
  `) as { id: string }[];
  const [employment] = (await admin`
    INSERT INTO awcms_hr_employments (tenant_id, profile_id, employee_no, hired_on)
    VALUES (${tenantId}, ${profile!.id}, ${`E-${employmentCounter}`},
            ${values.hiredOn ?? "2026-01-01"}::date)
    RETURNING id
  `) as { id: string }[];
  if (values.terminatedOn) {
    await admin`
      UPDATE awcms_hr_employments SET terminated_on = ${values.terminatedOn}::date
      WHERE id = ${employment!.id}
    `;
  }
  return employment!.id;
}

let versionCounter = 0;
/** A PUBLISHED 10 % rule in IDR, made the only way the database allows: a draft, then published. */
async function publishedRule(
  tenantId: string,
  values: { key?: string; from?: string; sourceType?: string } = {}
): Promise<void> {
  versionCounter += 1;
  const id = await inTenant(
    tenantId,
    async (tx) =>
      (
        (await tx`
          INSERT INTO awcms_hr_commission_rules
            (tenant_id, rule_key, version_no, name, source_type, calculation, rate,
             currency_code, rounding_mode, rounding_scale, effective_from)
          VALUES (${tenantId}, ${values.key ?? RULE_KEY}, ${versionCounter}, 'POS sales',
                  ${values.sourceType ?? SOURCE_TYPE}, 'percent', 10, 'IDR', 'half_up', 2,
                  ${values.from ?? "2026-01-01"}::date)
          RETURNING id
        `) as { id: string }[]
      )[0]!.id
  );
  await inTenant(
    tenantId,
    (tx) => tx`
      UPDATE awcms_hr_commission_rules
      SET status = 'published', published_at = now(), backdated_reason = 'fixture'
      WHERE id = ${id}
    `
  );
}

async function seedProduct(tenantId: string): Promise<string> {
  const [row] = (await getAdminSql()`
    INSERT INTO awcms_commerce_products (tenant_id, sku, name, slug, price, stock)
    VALUES (${tenantId}, ${"SKU-" + Math.random().toString(36).slice(2, 8)}, 'Kopi',
            ${"kopi-" + Math.random().toString(36).slice(2, 8)}, 10000.00, 100)
    RETURNING id
  `) as { id: string }[];
  return row!.id;
}

async function seedCustomer(tenantId: string): Promise<string> {
  const [row] = (await getAdminSql()`
    INSERT INTO awcms_commerce_customers (tenant_id, name, phone)
    VALUES (${tenantId}, 'Walk-in', ${"+62812" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0")})
    RETURNING id
  `) as { id: string }[];
  return row!.id;
}

type OrderOptions = {
  channel?: "pos" | "storefront";
  cashier?: string | null;
  status?: string;
  lines?: string[];
  /** Units per line (default 1 each); the line total is NOT scaled - only the quantity column. */
  quantities?: number[];
  discount?: string;
  loyaltyDiscount?: string;
  paidAt?: Date;
};

let orderCounter = 0;
async function seedOrder(
  tenantId: string,
  options: OrderOptions = {}
): Promise<{ orderId: string; lineIds: string[] }> {
  orderCounter += 1;
  const admin = getAdminSql();
  const lines = options.lines ?? ["100000.00"];
  const subtotal = lines
    .reduce((sum, line) => sum + Math.round(Number(line) * 100), 0)
    .toString();
  const subtotalDecimal = `${subtotal.slice(0, -2) || "0"}.${subtotal.slice(-2)}`;
  const customerId = await seedCustomer(tenantId);
  const productId = await seedProduct(tenantId);
  const [order] = (await admin`
    INSERT INTO awcms_commerce_orders
      (tenant_id, order_code, customer_id, status, payment_method, payment_status,
       shipping_method, subtotal, discount, loyalty_discount, total, paid_at,
       channel, pos_cashier_tenant_user_id)
    VALUES (${tenantId}, ${"COM-" + orderCounter + "-" + Math.random().toString(36).slice(2, 7)},
            ${customerId}, ${options.status ?? "paid"}, 'manual_qris', 'paid', 'self_pickup',
            ${subtotalDecimal}, ${options.discount ?? "0.00"}, ${options.loyaltyDiscount ?? "0.00"},
            ${subtotalDecimal}, ${options.paidAt ?? recentInstant(2, 10)},
            ${options.channel ?? "pos"}, ${options.cashier ?? null})
    RETURNING id
  `) as { id: string }[];
  const lineIds: string[] = [];
  for (const [index, total] of lines.entries()) {
    const [item] = (await admin`
      INSERT INTO awcms_commerce_order_items
        (tenant_id, order_id, product_id, name, unit_price, quantity, line_total)
      VALUES (${tenantId}, ${order!.id}, ${productId}, 'Kopi', ${total}, ${options.quantities?.[index] ?? 1}, ${total})
      RETURNING id
    `) as { id: string }[];
    lineIds.push(item!.id);
  }
  return { orderId: order!.id, lineIds };
}

async function enable(tenantId: string, on = true): Promise<void> {
  await inTenant(tenantId, (tx) =>
    saveCommissionSettings(
      tx,
      tenantId,
      settingsAdmins.get(tenantId) ?? ADMIN_A,
      {
        enabled: on,
        ruleKey: RULE_KEY,
        sourceType: SOURCE_TYPE
      }
    )
  );
}

async function link(
  tenantId: string,
  tenantUserId: string,
  employmentId: string
): Promise<string> {
  const outcome = await inTenant(tenantId, (tx) =>
    createStaffLink(tx, tenantId, ADMIN_A, { tenantUserId, employmentId })
  );
  if (outcome.kind !== "created") {
    throw new Error(`fixture: link failed (${outcome.kind})`);
  }
  return outcome.link.id;
}

let eventCounter = 0;
function paidEvent(orderId: string, eventId?: string): DomainEventForHandler {
  eventCounter += 1;
  return {
    id:
      eventId ??
      `00000391-0000-4000-8000-${String(eventCounter).padStart(12, "0")}`,
    eventType: PAID,
    eventVersion: "1.0",
    aggregateType: "commerce.order",
    aggregateId: orderId,
    orderKey: `commerce.order:${orderId}`,
    correlationId: null,
    causationId: null,
    producerModule: "commerce",
    // A hostile payload: the consumer must read the ORDER, never this.
    payload: {
      orderId,
      employmentId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      amount: "999999999.00"
    },
    occurredAt: new Date(),
    recordedAt: new Date()
  };
}

async function deliver(
  tenantId: string,
  event: DomainEventForHandler,
  sql: Bun.SQL = getRuntimeSql()
): Promise<void> {
  await inTenant(
    tenantId,
    (tx) =>
      attributorConsumer.handle(tx, event, {
        tenantId,
        correlationId: "corr-391"
      }),
    sql
  );
}

async function auditActions(tenantId: string): Promise<string[]> {
  const rows = (await getAdminSql()`
    SELECT action FROM awcms_audit_events
    WHERE tenant_id = ${tenantId} AND action LIKE 'commerce.commission.%'
    ORDER BY created_at, action
  `) as { action: string }[];
  return rows.map((row) => row.action);
}

const CANCELLED = "awcms.commerce.order.cancelled";

/** The person who last saved each tenant's commission settings (the voider the ledger stamps). */
const settingsAdmins = new Map<string, string>();

function reversalEvent(
  eventType: string,
  aggregateType: string,
  aggregateId: string
): DomainEventForHandler {
  eventCounter += 1;
  return {
    id: `00000391-1111-4000-8000-${String(eventCounter).padStart(12, "0")}`,
    eventType,
    eventVersion: "1.0",
    aggregateType,
    aggregateId,
    orderKey: `${aggregateType}:${aggregateId}`,
    correlationId: null,
    causationId: null,
    producerModule: "commerce",
    // A hostile payload: the consumers must read the database, never this.
    payload: {
      orderId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      amount: "999999999.00"
    },
    occurredAt: new Date(),
    recordedAt: new Date()
  };
}

const cancelledEvent = (orderId: string) =>
  reversalEvent(CANCELLED, "commerce.order", orderId);
const refundEvent = (returnId: string) =>
  reversalEvent("awcms.commerce.refund.settled", "commerce.return", returnId);

async function deliverWith(
  consumer: typeof cancelReverser,
  tenantId: string,
  event: DomainEventForHandler,
  sql: Bun.SQL = getRuntimeSql()
): Promise<void> {
  await inTenant(
    tenantId,
    (tx) =>
      consumer.handle(tx, event, { tenantId, correlationId: "corr-391v" }),
    sql
  );
}

/** A return with its lines written straight into the tables (the consumer reads only these). */
async function seedReturn(
  tenantId: string,
  orderId: string,
  lines: { itemId: string; quantity: number }[],
  status: "open" | "completed" = "completed"
): Promise<string> {
  const admin = getAdminSql();
  const actor = await seedTenantUser(tenantId);
  const items = (await admin`
    SELECT id, product_id
    FROM awcms_commerce_order_items WHERE order_id = ${orderId}
  `) as { id: string; product_id: string }[];
  // Money is irrelevant to the consumer: one rupiah per unit keeps the CHECKs true.
  const total = lines.reduce((sum, line) => sum + line.quantity, 0);
  const totalDecimal = `${total}.00`;
  eventCounter += 1;
  const [ret] = (await admin`
    INSERT INTO awcms_commerce_returns
      (tenant_id, order_id, kind, status, goods_gross, discount_share,
       shipping_refund, refund_total, source_key, actor_tenant_user_id, completed_at)
    VALUES (${tenantId}, ${orderId}, 'return', 'open', ${totalDecimal}, 0, 0,
            ${totalDecimal}, ${`ret-391v-${eventCounter}`}, ${actor}, NULL)
    RETURNING id
  `) as { id: string }[];
  for (const line of lines) {
    const item = items.find((candidate) => candidate.id === line.itemId)!;
    await admin`
      INSERT INTO awcms_commerce_return_lines
        (tenant_id, return_id, order_id, order_item_id, product_id, quantity,
         reason, disposition, stock_effect, goods_gross, discount_share, refund_amount)
      VALUES (${tenantId}, ${ret!.id}, ${orderId}, ${line.itemId}, ${item.product_id},
              ${line.quantity}, 'changed_mind', 'damaged', 0,
              ${`${line.quantity}.00`}, 0, ${`${line.quantity}.00`})
    `;
  }
  if (status === "completed") {
    await admin`
      UPDATE awcms_commerce_returns
      SET status = 'completed', completed_at = now()
      WHERE id = ${ret!.id}
    `;
  }
  return ret!.id;
}

async function accrualStates(tenantId: string) {
  return (await getAdminSql()`
    SELECT id, status, source_ref, source_line, voided_by, void_reason_code,
           voided_at IS NOT NULL AS has_voided_at
    FROM awcms_hr_commission_accruals
    WHERE tenant_id = ${tenantId}
    ORDER BY source_ref, source_line
  `) as {
    id: string;
    status: string;
    source_ref: string;
    source_line: string;
    voided_by: string | null;
    void_reason_code: string | null;
    has_voided_at: boolean;
  }[];
}

async function count(
  sqlText: "transitions" | "voided_events",
  tenantId: string
) {
  const admin = getAdminSql();
  const rows =
    sqlText === "transitions"
      ? ((await admin`SELECT count(*)::int AS n FROM awcms_hr_commission_transitions WHERE tenant_id = ${tenantId} AND to_status = 'voided'`) as {
          n: number;
        }[])
      : ((await admin`SELECT count(*)::int AS n FROM awcms_domain_events WHERE tenant_id = ${tenantId} AND event_type = 'awcms.hr.commission.voided'`) as {
          n: number;
        }[]);
  return rows[0]!.n;
}

async function setHrCommission(tenantId: string, enabled: boolean) {
  await getAdminSql()`
    INSERT INTO awcms_modules (module_key, module_name)
    VALUES ('hr_commission', 'HR Commission') ON CONFLICT DO NOTHING
  `;
  await getAdminSql()`
    INSERT INTO awcms_tenant_modules (tenant_id, module_key, enabled)
    VALUES (${tenantId}, 'hr_commission', ${enabled})
    ON CONFLICT (tenant_id, module_key) DO UPDATE SET enabled = EXCLUDED.enabled
  `;
}

suite(
  "commerce commission reversal integration (Issue #391, ADR-0046 D9)",
  () => {
    beforeAll(async () => {
      await setupIntegrationDatabase();
    }, 120000);

    afterAll(async () => {
      await teardownIntegrationDatabase();
    }, 60000);

    let cashier = "";
    let employment = "";
    let admin = "";

    beforeEach(async () => {
      await resetDatabase();
      settingsAdmins.clear();
      await seedTenant(TENANT_A, "COMA");
      await seedTenant(TENANT_B, "COMB");
      cashier = await seedTenantUser(TENANT_A);
      admin = await seedTenantUser(TENANT_A);
      settingsAdmins.set(TENANT_A, admin);
      employment = await seedEmployment(TENANT_A);
      await publishedRule(TENANT_A);
    });

    /** A paid counter sale accrued through the real accrue consumer: the starting point of every case. */
    async function accruedSale(
      options: OrderOptions = {}
    ): Promise<{ orderId: string; lineIds: string[] }> {
      await link(TENANT_A, cashier, employment);
      await enable(TENANT_A);
      const sale = await seedOrder(TENANT_A, { cashier, ...options });
      await deliver(TENANT_A, paidEvent(sale.orderId));
      expect((await accrualStates(TENANT_A)).length).toBe(sale.lineIds.length);
      return sale;
    }

    // -------------------------------------------------------------------------
    describe("wiring", () => {
      test("each consumer is declared on its fact, with the default runtime_effect_once guard", () => {
        expect(cancelReverser.eventTypes).toEqual([CANCELLED]);
        expect(refundReverser.eventTypes).toEqual([
          "awcms.commerce.refund.settled"
        ]);
        const declared = DORMANT_COMMISSION_CONSUMERS.filter(
          (consumer) =>
            consumer.name === cancelReverser.name ||
            consumer.name === refundReverser.name
        );
        expect(declared).toHaveLength(2);
        // ... and, being dormant (sql/1053), none is registered with the dispatcher.
        const registered = listDomainEventConsumers().map((c) => c.name);
        for (const consumer of DORMANT_COMMISSION_CONSUMERS) {
          expect(registered).not.toContain(consumer.name);
        }
        for (const consumer of declared) {
          expect(consumer.idempotency ?? "runtime_effect_once").toBe(
            "runtime_effect_once"
          );
        }
      });
    });

    // -------------------------------------------------------------------------
    describe("cancel -> void", () => {
      test("every line of a cancelled sale is voided by the same source identity, stamped with the configuring person and a reason code", async () => {
        const { orderId } = await accruedSale({
          lines: ["100000.00", "50000.00"]
        });

        await deliverWith(cancelReverser, TENANT_A, cancelledEvent(orderId));

        const rows = await accrualStates(TENANT_A);
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row.status).toBe("voided");
          expect(row.voided_by).toBe(admin);
          expect(row.void_reason_code).toBe("order_cancelled");
          expect(row.has_voided_at).toBe(true);
        }
        expect(await count("transitions", TENANT_A)).toBe(2);
        expect(await count("voided_events", TENANT_A)).toBe(2);
        expect(await auditActions(TENANT_A)).toContain(
          "commerce.commission.reversed"
        );
        // The ledger still reconciles to its own transition log.
        const attention = (await auditActions(TENANT_A)).filter(
          (action) => action === "commerce.commission.reversal_needs_attention"
        );
        expect(attention).toHaveLength(0);
      });

      test("replay: the same event twice and a different event for the same order are one void", async () => {
        const { orderId } = await accruedSale({ lines: ["100000.00"] });

        const event = cancelledEvent(orderId);
        await deliverWith(cancelReverser, TENANT_A, event);
        await deliverWith(cancelReverser, TENANT_A, event); // the runtime's effect guard
        await deliverWith(cancelReverser, TENANT_A, cancelledEvent(orderId)); // the ledger's already_voided

        expect(await count("transitions", TENANT_A)).toBe(1);
        expect(await count("voided_events", TENANT_A)).toBe(1);
        expect(
          (await auditActions(TENANT_A)).filter(
            (action) => action === "commerce.commission.reversed"
          )
        ).toHaveLength(1);
      });

      test("a voided accrual is not resurrected by a redelivery of the paid event", async () => {
        const { orderId } = await accruedSale();
        await deliverWith(cancelReverser, TENANT_A, cancelledEvent(orderId));

        await deliver(TENANT_A, paidEvent(orderId));

        const rows = await accrualStates(TENANT_A);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toBe("voided");
      });

      test("a void before any accrual is a quiet no-op: not_found, nothing written, nothing audited, no error", async () => {
        await link(TENANT_A, cashier, employment);
        await enable(TENANT_A);
        // A sale the accrue half never reported (it was never delivered).
        const { orderId } = await seedOrder(TENANT_A, { cashier });

        await deliverWith(cancelReverser, TENANT_A, cancelledEvent(orderId));

        expect(await accrualStates(TENANT_A)).toEqual([]);
        expect(await auditActions(TENANT_A)).toEqual([
          // the two settings/link audit rows from the fixtures only
          ...(await auditActions(TENANT_A)).filter(
            (action) =>
              action === "commerce.commission.settings_updated" ||
              action === "commerce.commission.staff_link_created"
          )
        ]);
        expect(
          (await auditActions(TENANT_A)).some(
            (action) =>
              action.endsWith(".reversed") ||
              action.endsWith(".reversal_needs_attention")
          )
        ).toBe(false);
      });

      test("a storefront order, an unstamped sale and a tenant that never configured the adapter are skipped", async () => {
        const unconfigured = await seedOrder(TENANT_A, { cashier });
        const skippedNever = await inTenant(TENANT_A, (tx) =>
          reverseCommissionForCancelledOrder(tx, TENANT_A, unconfigured.orderId)
        );
        expect(skippedNever).toEqual({ kind: "skipped", reason: "disabled" });

        await link(TENANT_A, cashier, employment);
        await enable(TENANT_A);
        const unstamped = await seedOrder(TENANT_A, { cashier: null });
        expect(
          await inTenant(TENANT_A, (tx) =>
            reverseCommissionForCancelledOrder(tx, TENANT_A, unstamped.orderId)
          )
        ).toEqual({ kind: "skipped", reason: "no_cashier_stamp" });
      });

      test("a link retired (or re-pointed) after the sale does not strand the accrual", async () => {
        const { orderId } = await accruedSale();
        const links = (await getAdminSql()`
        SELECT id FROM awcms_commerce_commission_staff_links WHERE tenant_id = ${TENANT_A}
      `) as { id: string }[];
        await inTenant(TENANT_A, (tx) =>
          retireStaffLink(tx, TENANT_A, admin, links[0]!.id)
        );
        const other = await seedEmployment(TENANT_A);
        await link(TENANT_A, cashier, other);

        await deliverWith(cancelReverser, TENANT_A, cancelledEvent(orderId));

        expect((await accrualStates(TENANT_A))[0]!.status).toBe("voided");
      });

      test("switching the adapter OFF after accruing still reverses a cancelled sale; switching hr_commission off does not", async () => {
        const first = await accruedSale();
        await enable(TENANT_A, false);
        await deliverWith(
          cancelReverser,
          TENANT_A,
          cancelledEvent(first.orderId)
        );
        expect((await accrualStates(TENANT_A))[0]!.status).toBe("voided");

        const second = await seedOrder(TENANT_A, { cashier });
        await enable(TENANT_A, true);
        await deliver(TENANT_A, paidEvent(second.orderId));
        await setHrCommission(TENANT_A, false);
        const result = await inTenant(TENANT_A, (tx) =>
          reverseCommissionForCancelledOrder(tx, TENANT_A, second.orderId)
        );
        expect(result).toEqual({
          kind: "skipped",
          reason: "hr_commission_disabled"
        });
        const states = await accrualStates(TENANT_A);
        expect(states.filter((row) => row.status === "pending")).toHaveLength(
          1
        );
      });
    });

    // -------------------------------------------------------------------------
    describe("pay -> accrue -> refund -> void", () => {
      test("a fully returned line is voided when the return's refund settles; an open return does nothing", async () => {
        const { orderId, lineIds } = await accruedSale({
          lines: ["100000.00"],
          quantities: [2]
        });

        const open = await seedReturn(
          TENANT_A,
          orderId,
          [{ itemId: lineIds[0]!, quantity: 2 }],
          "open"
        );
        await deliverWith(refundReverser, TENANT_A, refundEvent(open));
        expect((await accrualStates(TENANT_A))[0]!.status).toBe("pending");

        await getAdminSql()`
        UPDATE awcms_commerce_returns SET status = 'completed', completed_at = now()
        WHERE id = ${open}
      `;
        const event = refundEvent(open);
        await deliverWith(refundReverser, TENANT_A, event);

        const rows = await accrualStates(TENANT_A);
        expect(rows[0]!.status).toBe("voided");
        expect(rows[0]!.void_reason_code).toBe("line_returned");
        expect(rows[0]!.voided_by).toBe(admin);

        // Replays: the second refund leg's event, and a repeat of the first.
        await deliverWith(refundReverser, TENANT_A, refundEvent(open));
        await deliverWith(refundReverser, TENANT_A, event);
        expect(await count("transitions", TENANT_A)).toBe(1);
        expect(await count("voided_events", TENANT_A)).toBe(1);
      });

      test("a missing return is skipped, not an error", async () => {
        await accruedSale();
        const result = await inTenant(TENANT_A, (tx) =>
          reverseCommissionForSettledRefund(
            tx,
            TENANT_A,
            "99999999-9999-4999-8999-999999999999"
          )
        );
        expect(result).toEqual({ kind: "skipped", reason: "return_not_found" });
      });
    });

    // -------------------------------------------------------------------------
    describe("partial refunds (ADR-0046 D9: a line is reversed only when fully returned)", () => {
      test("a partly returned line keeps its accrual and is flagged for a person; returning the rest voids it", async () => {
        const { orderId, lineIds } = await accruedSale({
          lines: ["90000.00", "30000.00"],
          quantities: [3, 1]
        });

        // One of three units of line 0 comes back.
        const first = await seedReturn(TENANT_A, orderId, [
          { itemId: lineIds[0]!, quantity: 1 }
        ]);
        const partial = await inTenant(TENANT_A, (tx) =>
          reverseCommissionForSettledRefund(tx, TENANT_A, first)
        );
        expect(partial).toMatchObject({
          kind: "reversed",
          tally: { partial: 1, voided: 0 }
        });
        expect(
          (await accrualStates(TENANT_A)).every(
            (row) => row.status === "pending"
          )
        ).toBe(true);
        const attention = await getAdminSql()`
        SELECT attributes FROM awcms_audit_events
        WHERE tenant_id = ${TENANT_A}
          AND action = 'commerce.commission.reversal_needs_attention'
      `;
        expect(attention).toHaveLength(1);
        expect(attention[0]!.attributes).toMatchObject({
          cause: "refund_settled",
          partiallyReturnedLines: 1
        });

        // The other two units come back later: now the line is whole.
        const second = await seedReturn(TENANT_A, orderId, [
          { itemId: lineIds[0]!, quantity: 2 }
        ]);
        await deliverWith(refundReverser, TENANT_A, refundEvent(second));

        const rows = await accrualStates(TENANT_A);
        const byLine = new Map(rows.map((row) => [row.source_line, row]));
        expect(byLine.get(lineIds[0]!)!.status).toBe("voided");
        // The untouched line is still earning.
        expect(byLine.get(lineIds[1]!)!.status).toBe("pending");
      });

      test("only the lines a return covers are considered: returning line 1 whole leaves line 0 alone", async () => {
        const { orderId, lineIds } = await accruedSale({
          lines: ["90000.00", "30000.00"],
          quantities: [3, 1]
        });
        const ret = await seedReturn(TENANT_A, orderId, [
          { itemId: lineIds[1]!, quantity: 1 }
        ]);
        await deliverWith(refundReverser, TENANT_A, refundEvent(ret));

        const byLine = new Map(
          (await accrualStates(TENANT_A)).map((row) => [row.source_line, row])
        );
        expect(byLine.get(lineIds[1]!)!.status).toBe("voided");
        expect(byLine.get(lineIds[0]!)!.status).toBe("pending");
      });
    });

    // -------------------------------------------------------------------------
    describe("period_closed is a human's problem, never retried", () => {
      async function advance(
        tenantId: string,
        accrualId: string,
        to: "payable" | "paid"
      ) {
        // approve / release / pay refuse an accrual whose beneficiary cannot be
        // identified: give the employment its own login (a different person from
        // every actor below).
        const [emp] = (await getAdminSql()`
          SELECT profile_id FROM awcms_hr_employments WHERE tenant_id = ${tenantId} AND id = (
            SELECT employment_id FROM awcms_hr_commission_accruals WHERE id = ${accrualId})
        `) as { profile_id: string }[];
        const [identity] = (await getAdminSql()`
          INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
          VALUES (${tenantId}, ${emp!.profile_id}, ${`beneficiary-${accrualId}@example.com`}, 'x')
          RETURNING id
        `) as { id: string }[];
        const [beneficiary] = (await getAdminSql()`
          INSERT INTO awcms_tenant_users (tenant_id, identity_id)
          VALUES (${tenantId}, ${identity!.id}) RETURNING id
        `) as { id: string }[];
        await getAdminSql()`
          UPDATE awcms_hr_employments SET tenant_user_id = ${beneficiary!.id}
          WHERE tenant_id = ${tenantId} AND profile_id = ${emp!.profile_id}
        `;
        const approver = await seedTenantUser(tenantId);
        const releaser = await seedTenantUser(tenantId);
        await inTenant(tenantId, async (tx) => {
          const approved = await transitionAccrual(
            tx,
            tenantId,
            accrualId,
            "approve",
            {
              actorTenantUserId: approver,
              correlationId: "c-391v"
            }
          );
          expect(approved.outcome).toBe("ok");
          const released = await transitionAccrual(
            tx,
            tenantId,
            accrualId,
            "release",
            {
              actorTenantUserId: releaser,
              correlationId: "c-391v"
            }
          );
          expect(released.outcome).toBe("ok");
          if (to === "paid") {
            const paid = await transitionAccrual(
              tx,
              tenantId,
              accrualId,
              "pay",
              {
                actorTenantUserId: await seedTenantUser(tenantId),
                correlationId: "c-391v"
              },
              { paymentReference: "PAY-391" }
            );
            expect(paid.outcome).toBe("ok");
          }
        });
      }

      for (const state of ["payable", "paid"] as const) {
        test(`a ${state} accrual is left untouched, one warning audit row records it, and the delivery completes`, async () => {
          const { orderId } = await accruedSale({
            lines: ["100000.00", "20000.00"]
          });
          const [first] = await accrualStates(TENANT_A);
          await advance(TENANT_A, first!.id, state);

          // Does not throw: a throw would be retried eight times and dead-lettered.
          await deliverWith(cancelReverser, TENANT_A, cancelledEvent(orderId));

          const rows = await accrualStates(TENANT_A);
          const closed = rows.find((row) => row.id === first!.id)!;
          expect(closed.status).toBe(state);
          expect(closed.voided_by).toBeNull();
          // The other line of the same order WAS reversible and was reversed.
          expect(rows.find((row) => row.id !== first!.id)!.status).toBe(
            "voided"
          );

          const attention = (await getAdminSql()`
          SELECT attributes, severity FROM awcms_audit_events
          WHERE tenant_id = ${TENANT_A}
            AND action = 'commerce.commission.reversal_needs_attention'
        `) as { attributes: Record<string, unknown>; severity: string }[];
          expect(attention).toHaveLength(1);
          expect(attention[0]!.severity).toBe("warning");
          expect(attention[0]!.attributes).toMatchObject({
            cause: "order_cancelled",
            periodClosedPayable: state === "payable" ? 1 : 0,
            periodClosedPaid: state === "paid" ? 1 : 0
          });
          // No money, source reference, accrual or employment id in the row.
          const text = JSON.stringify(attention[0]!.attributes);
          expect(text).not.toContain(first!.id);
          expect(text).not.toContain(employment);
          expect(text).not.toContain(orderId);
          expect(await count("voided_events", TENANT_A)).toBe(1);
        });
      }

      test("a refusal for a missing person (actor_required) is also an audited outcome, not an exception", async () => {
        const { orderId } = await accruedSale();
        await getAdminSql()`
        UPDATE awcms_commerce_commission_settings
        SET updated_by_tenant_user_id = NULL WHERE tenant_id = ${TENANT_A}
      `;

        await deliverWith(cancelReverser, TENANT_A, cancelledEvent(orderId));

        expect((await accrualStates(TENANT_A))[0]!.status).toBe("pending");
        const attention = (await getAdminSql()`
        SELECT attributes FROM awcms_audit_events
        WHERE tenant_id = ${TENANT_A}
          AND action = 'commerce.commission.reversal_needs_attention'
      `) as { attributes: Record<string, unknown> }[];
        expect(attention).toHaveLength(1);
        expect(attention[0]!.attributes).toMatchObject({ actorRequired: 1 });
      });
    });

    // -------------------------------------------------------------------------
    describe("tenant isolation", () => {
      test("tenant A's cancellation never voids tenant B's accrual, even for an identical shape of sale", async () => {
        const a = await accruedSale();
        const cashierB = await seedTenantUser(TENANT_B);
        const adminB = await seedTenantUser(TENANT_B);
        settingsAdmins.set(TENANT_B, adminB);
        const employmentB = await seedEmployment(TENANT_B);
        await publishedRule(TENANT_B);
        await link(TENANT_B, cashierB, employmentB);
        await enable(TENANT_B);
        const b = await seedOrder(TENANT_B, { cashier: cashierB });
        await deliver(TENANT_B, paidEvent(b.orderId));

        await deliverWith(cancelReverser, TENANT_A, cancelledEvent(a.orderId));

        expect((await accrualStates(TENANT_A))[0]!.status).toBe("voided");
        expect((await accrualStates(TENANT_B))[0]!.status).toBe("pending");

        // Tenant A's event delivered in tenant B's context finds no order to act on.
        const crossed = await inTenant(TENANT_B, (tx) =>
          reverseCommissionForCancelledOrder(tx, TENANT_B, a.orderId)
        );
        expect(crossed).toEqual({ kind: "skipped", reason: "order_not_found" });
        expect((await accrualStates(TENANT_B))[0]!.status).toBe("pending");
        // Nor can B's return reversal be driven by A's return id.
        const ret = await seedReturn(TENANT_A, a.orderId, [
          { itemId: a.lineIds[0]!, quantity: 1 }
        ]);
        expect(
          await inTenant(TENANT_B, (tx) =>
            reverseCommissionForSettledRefund(tx, TENANT_B, ret)
          )
        ).toEqual({ kind: "skipped", reason: "return_not_found" });
      });
    });

    // -------------------------------------------------------------------------
    describe("dormant: the real dispatcher, as the real worker role, does nothing (sql/1053)", () => {
      test("a paid then cancelled counter sale dispatched as awcms_worker accrues and voids nothing", async () => {
        if (!workerRoleActivated) return;
        await link(TENANT_A, cashier, employment);
        await enable(TENANT_A);
        const { orderId } = await seedOrder(TENANT_A, {
          cashier,
          lines: ["100000.00", "50000.00"]
        });
        for (const eventType of [PAID, CANCELLED]) {
          await inTenant(TENANT_A, (tx) =>
            appendDomainEvent(tx, TENANT_A, {
              eventType,
              eventVersion: "1.0",
              aggregateType: "commerce.order",
              aggregateId: orderId,
              producerModule: "commerce",
              payload: { orderId }
            })
          );
        }
        await dispatchDomainEventsForTenant(getWorkerRoleSql(), TENANT_A);
        expect(await accrualStates(TENANT_A)).toHaveLength(0);
      });
    });
  }
);
