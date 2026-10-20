/**
 * DORMANT (ADR-0046 D10): the adapter ships without a registered consumer and
 * without any worker grant on a payroll-family table (sql/1053), because
 * upstream's payroll boundary (ahliweb/awcms#1015) lets only `awcms_app` hold
 * them. The tests below drive the consumer's code directly as the app role
 * (`DORMANT_COMMISSION_CONSUMERS`); the last block pins the dormant state.
 *
 * Employee-commission sale attribution (Issue #391, ADR-0046) against a REAL
 * migrated PostgreSQL through `tests/integration/harness.ts`. Gated on
 * `DATABASE_URL`; skips cleanly without one.
 *
 * Covers the properties only a real database can prove:
 *
 *   - OFF by default: a paid counter sale in a tenant that never enabled the
 *     adapter, or that switched `hr_commission` off, produces no accrual;
 *   - the beneficiary is derived, never supplied: only a paid COUNTER sale whose
 *     server-stamped cashier has a LIVE staff link is attributed - a storefront
 *     order, an unstamped sale, an unlinked login and a retired link are not;
 *   - exactly once: the same event delivered twice (the runtime's effect guard)
 *     and a DIFFERENT event for the same order (the ledger's unique key) both
 *     leave one accrual per line;
 *   - the amount is the published rule's evaluation of the line's NET base
 *     (order discount shared pro rata), dated in the tenant's own time zone;
 *   - a ledger refusal (no rule in force, employment not eligible) is an audited
 *     outcome that neither throws nor writes an accrual;
 *   - tenant isolation: tenant B's sales never use tenant A's links, settings or
 *     rules, and the two new tables are RLS-FORCED;
 *   - the worker role - the one that really runs the consumer - can do the whole
 *     job with the narrow grants of `sql/1031` and nothing more (it cannot
 *     approve, pay or rewrite an accrual, change a rule or an employment; the
 *     void grant of `sql/1051` is covered by the reversal suite).
 *
 * The `hr_workforce` / `hr_commission` fixtures here (employment, published
 * rule) are written straight into those tables - tests only; the module under
 * test never touches them.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import { withTenantOrThrow } from "../../src/lib/database/tenant-context";
import {
  createStaffLink,
  fetchCommissionSettings,
  retireStaffLink,
  saveCommissionSettings
} from "../../src/modules/commerce/application/commission-attribution-directory";
import { attributeCommissionForPaidOrder } from "../../src/modules/commerce/application/commission-attribution";
import { DORMANT_COMMISSION_CONSUMERS } from "../../src/modules/commerce/module";
import { listDomainEventConsumers } from "../../src/modules/domain-event-runtime/infrastructure/consumer-registry";
import type { DomainEventForHandler } from "../../src/modules/domain-event-runtime/domain/consumer-types";
import {
  assertRejected,
  getAdminSql,
  getOwnerSql,
  getRuntimeSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const attributorConsumer = DORMANT_COMMISSION_CONSUMERS.find(
  (consumer) => consumer.name === "commerce.order_paid_commission_attributor"
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

function isoDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
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
  for (const total of lines) {
    const [item] = (await admin`
      INSERT INTO awcms_commerce_order_items
        (tenant_id, order_id, product_id, name, unit_price, quantity, line_total)
      VALUES (${tenantId}, ${order!.id}, ${productId}, 'Kopi', ${total}, 1, ${total})
      RETURNING id
    `) as { id: string }[];
    lineIds.push(item!.id);
  }
  return { orderId: order!.id, lineIds };
}

async function enable(tenantId: string, on = true): Promise<void> {
  const outcome = await inTenant(tenantId, (tx) =>
    saveCommissionSettings(tx, tenantId, ADMIN_A, {
      enabled: on,
      ruleKey: RULE_KEY,
      sourceType: SOURCE_TYPE
    })
  );
  if (outcome.kind !== "saved") {
    throw new Error(`fixture: settings not saved (${outcome.kind})`);
  }
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

type AccrualRow = {
  employment_id: string;
  source_type: string;
  source_ref: string;
  source_line: string;
  amount: string;
  base_amount: string;
  currency_code: string;
  occurred_on: string;
  status: string;
  created_by: string | null;
  correlation_id: string | null;
};

async function accrualsOf(tenantId: string): Promise<AccrualRow[]> {
  return (await getAdminSql()`
    SELECT employment_id, source_type, source_ref, source_line,
           amount::text AS amount, base_amount::text AS base_amount, currency_code,
           to_char(occurred_on, 'YYYY-MM-DD') AS occurred_on, status, created_by,
           correlation_id
    FROM awcms_hr_commission_accruals
    WHERE tenant_id = ${tenantId}
    ORDER BY source_ref, source_line
  `) as AccrualRow[];
}

async function auditActions(tenantId: string): Promise<string[]> {
  const rows = (await getAdminSql()`
    SELECT action FROM awcms_audit_events
    WHERE tenant_id = ${tenantId} AND action LIKE 'commerce.commission.%'
    ORDER BY created_at, action
  `) as { action: string }[];
  return rows.map((row) => row.action);
}

suite("commerce commission attribution integration (Issue #391)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  let cashier = "";
  let employment = "";

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "COMA");
    await seedTenant(TENANT_B, "COMB");
    cashier = await seedTenantUser(TENANT_A);
    employment = await seedEmployment(TENANT_A);
    await publishedRule(TENANT_A);
  });

  // -------------------------------------------------------------------------
  describe("off by default, and only for a counter sale of a linked login", () => {
    test("a tenant that never enabled the adapter gets no accrual and no order read", async () => {
      await link(TENANT_A, cashier, employment);
      const { orderId } = await seedOrder(TENANT_A, { cashier });

      await deliver(TENANT_A, paidEvent(orderId));
      expect(await accrualsOf(TENANT_A)).toEqual([]);

      const result = await inTenant(TENANT_A, (tx) =>
        attributeCommissionForPaidOrder(tx, TENANT_A, orderId)
      );
      expect(result).toEqual({ kind: "skipped", reason: "disabled" });
    });

    test("switched on then off again, nothing is accrued for later sales", async () => {
      await link(TENANT_A, cashier, employment);
      await enable(TENANT_A, true);
      await enable(TENANT_A, false);
      const { orderId } = await seedOrder(TENANT_A, { cashier });
      await deliver(TENANT_A, paidEvent(orderId));
      expect(await accrualsOf(TENANT_A)).toEqual([]);
    });

    test("a paid counter sale of a linked login accrues one row per line, from the ORDER, not the event payload", async () => {
      await link(TENANT_A, cashier, employment);
      await enable(TENANT_A);
      const { orderId, lineIds } = await seedOrder(TENANT_A, {
        cashier,
        lines: ["100000.00", "50000.00"]
      });

      await deliver(TENANT_A, paidEvent(orderId));

      const rows = await accrualsOf(TENANT_A);
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.source_line).sort()).toEqual(
        [...lineIds].sort()
      );
      for (const row of rows) {
        // The hostile payload named another employment and an amount: neither is used.
        expect(row.employment_id).toBe(employment);
        expect(row.source_type).toBe(SOURCE_TYPE);
        expect(row.source_ref).toBe(orderId);
        expect(row.currency_code).toBe("IDR");
        expect(row.status).toBe("pending");
        expect(row.created_by).toBeNull();
        expect(row.correlation_id).toBe("corr-391");
      }
      const byLine = new Map(rows.map((row) => [row.source_line, row]));
      expect(Number(byLine.get(lineIds[0]!)!.amount)).toBe(10000);
      expect(Number(byLine.get(lineIds[1]!)!.amount)).toBe(5000);
      expect(await auditActions(TENANT_A)).toContain(
        "commerce.commission.attributed"
      );
    });

    test("a storefront order is never attributed, even if a cashier stamp is somehow present", async () => {
      await link(TENANT_A, cashier, employment);
      await enable(TENANT_A);
      const stamped = await seedOrder(TENANT_A, {
        channel: "storefront",
        cashier
      });
      const unstamped = await seedOrder(TENANT_A, {
        channel: "storefront",
        cashier: null
      });

      await deliver(TENANT_A, paidEvent(stamped.orderId));
      await deliver(TENANT_A, paidEvent(unstamped.orderId));

      expect(await accrualsOf(TENANT_A)).toEqual([]);
      const result = await inTenant(TENANT_A, (tx) =>
        attributeCommissionForPaidOrder(tx, TENANT_A, stamped.orderId)
      );
      expect(result).toEqual({ kind: "skipped", reason: "not_a_counter_sale" });
    });

    test("a counter sale with no cashier stamp has no fallback beneficiary", async () => {
      await link(TENANT_A, cashier, employment);
      await enable(TENANT_A);
      const { orderId } = await seedOrder(TENANT_A, { cashier: null });
      await deliver(TENANT_A, paidEvent(orderId));
      expect(await accrualsOf(TENANT_A)).toEqual([]);
    });

    test("a login with no live staff link, or a retired one, is not attributed (and an accrual already made stays)", async () => {
      await enable(TENANT_A);
      const unlinked = await seedOrder(TENANT_A, { cashier });
      await deliver(TENANT_A, paidEvent(unlinked.orderId));
      expect(await accrualsOf(TENANT_A)).toEqual([]);

      const linkId = await link(TENANT_A, cashier, employment);
      const first = await seedOrder(TENANT_A, { cashier });
      await deliver(TENANT_A, paidEvent(first.orderId));
      expect(await accrualsOf(TENANT_A)).toHaveLength(1);

      const retired = await inTenant(TENANT_A, (tx) =>
        retireStaffLink(tx, TENANT_A, ADMIN_A, linkId)
      );
      expect(retired.kind).toBe("retired");

      const second = await seedOrder(TENANT_A, { cashier });
      await deliver(TENANT_A, paidEvent(second.orderId));
      const rows = await accrualsOf(TENANT_A);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.source_ref).toBe(first.orderId);
    });

    test("an order that is not past payment (cancelled) is not attributed", async () => {
      await link(TENANT_A, cashier, employment);
      await enable(TENANT_A);
      const { orderId } = await seedOrder(TENANT_A, {
        cashier,
        status: "cancelled"
      });
      await deliver(TENANT_A, paidEvent(orderId));
      expect(await accrualsOf(TENANT_A)).toEqual([]);
    });

    test("a tenant that switched hr_commission off gets nothing", async () => {
      await link(TENANT_A, cashier, employment);
      await enable(TENANT_A);
      await getAdminSql()`
        INSERT INTO awcms_modules (module_key, module_name)
        VALUES ('hr_commission', 'HR Commission') ON CONFLICT DO NOTHING
      `;
      await getAdminSql()`
        INSERT INTO awcms_tenant_modules (tenant_id, module_key, enabled)
        VALUES (${TENANT_A}, 'hr_commission', false)
      `;
      const { orderId } = await seedOrder(TENANT_A, { cashier });
      await deliver(TENANT_A, paidEvent(orderId));
      expect(await accrualsOf(TENANT_A)).toEqual([]);
      const result = await inTenant(TENANT_A, (tx) =>
        attributeCommissionForPaidOrder(tx, TENANT_A, orderId)
      );
      expect(result).toEqual({
        kind: "skipped",
        reason: "hr_commission_disabled"
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("exactly once", () => {
    test("the same event twice, and a different event for the same order, leave one accrual per line", async () => {
      await link(TENANT_A, cashier, employment);
      await enable(TENANT_A);
      const { orderId } = await seedOrder(TENANT_A, {
        cashier,
        lines: ["100000.00", "50000.00"]
      });

      const event = paidEvent(orderId);
      await deliver(TENANT_A, event);
      await deliver(TENANT_A, event); // redelivery: the runtime's effect guard
      await deliver(TENANT_A, paidEvent(orderId)); // a manual replay: the ledger's unique key

      expect(await accrualsOf(TENANT_A)).toHaveLength(2);
      const transitions = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_hr_commission_transitions
        WHERE tenant_id = ${TENANT_A}
      `) as { n: number }[];
      expect(transitions[0]!.n).toBe(2);
      // A replay audits nothing new: one `attributed` row, from the first delivery.
      expect(
        (await auditActions(TENANT_A)).filter(
          (action) => action === "commerce.commission.attributed"
        )
      ).toHaveLength(1);
    });

    test("racing deliveries of the same order are still one accrual per line", async () => {
      await link(TENANT_A, cashier, employment);
      await enable(TENANT_A);
      const { orderId } = await seedOrder(TENANT_A, {
        cashier,
        lines: ["100000.00", "50000.00", "25000.00"]
      });

      await Promise.all(
        Array.from({ length: 6 }, () => deliver(TENANT_A, paidEvent(orderId)))
      );

      expect(await accrualsOf(TENANT_A)).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  describe("the amount and the date", () => {
    test("the base is the line's NET: the order discount and the points discount are shared pro rata", async () => {
      await link(TENANT_A, cashier, employment);
      await enable(TENANT_A);
      const { orderId, lineIds } = await seedOrder(TENANT_A, {
        cashier,
        lines: ["100000.00", "50000.00"],
        discount: "10000.00",
        loyaltyDiscount: "5000.00"
      });

      await deliver(TENANT_A, paidEvent(orderId));

      const byLine = new Map(
        (await accrualsOf(TENANT_A)).map((row) => [row.source_line, row])
      );
      // 15 000 over 150 000: 10 000 and 5 000 -> bases 90 000 / 45 000 -> 10 % = 9 000 / 4 500.
      expect(Number(byLine.get(lineIds[0]!)!.base_amount)).toBe(90000);
      expect(Number(byLine.get(lineIds[1]!)!.base_amount)).toBe(45000);
      expect(Number(byLine.get(lineIds[0]!)!.amount)).toBe(9000);
      expect(Number(byLine.get(lineIds[1]!)!.amount)).toBe(4500);
    });

    test("a fully discounted order reports nothing", async () => {
      await link(TENANT_A, cashier, employment);
      await enable(TENANT_A);
      const { orderId } = await seedOrder(TENANT_A, {
        cashier,
        lines: ["100000.00"],
        discount: "100000.00"
      });
      const result = await inTenant(TENANT_A, (tx) =>
        attributeCommissionForPaidOrder(tx, TENANT_A, orderId)
      );
      expect(result).toEqual({
        kind: "skipped",
        reason: "no_commissionable_lines"
      });
      expect(await accrualsOf(TENANT_A)).toEqual([]);
    });

    test("the sale's civil date is the tenant's own: Jakarta by default, UTC when the tenant says so", async () => {
      await link(TENANT_A, cashier, employment);
      await enable(TENANT_A);
      // 20:00 UTC is already the next day in Jakarta (+07:00).
      const paidAt = recentInstant(3, 20);
      const first = await seedOrder(TENANT_A, { cashier, paidAt });
      await deliver(TENANT_A, paidEvent(first.orderId));

      await getAdminSql()`
        INSERT INTO awcms_tenant_settings (tenant_id, timezone)
        VALUES (${TENANT_A}, 'UTC')
        ON CONFLICT (tenant_id) DO UPDATE SET timezone = 'UTC'
      `;
      const second = await seedOrder(TENANT_A, { cashier, paidAt });
      await deliver(TENANT_A, paidEvent(second.orderId));

      const byOrder = new Map(
        (await accrualsOf(TENANT_A)).map((row) => [row.source_ref, row])
      );
      expect(byOrder.get(first.orderId)!.occurred_on).toBe(
        isoDate(paidAt, "Asia/Jakarta")
      );
      expect(byOrder.get(second.orderId)!.occurred_on).toBe(
        isoDate(paidAt, "UTC")
      );
      expect(isoDate(paidAt, "Asia/Jakarta")).not.toBe(isoDate(paidAt, "UTC"));
    });
  });

  // -------------------------------------------------------------------------
  describe("a ledger refusal is an audited outcome, never an exception", () => {
    test("no published rule in force on the sale date: nothing accrued, one refused audit row, the delivery completes", async () => {
      await link(TENANT_A, cashier, employment);
      await inTenant(TENANT_A, (tx) =>
        saveCommissionSettings(tx, TENANT_A, ADMIN_A, {
          enabled: true,
          ruleKey: "no-such-rule",
          sourceType: SOURCE_TYPE
        })
      );
      const { orderId } = await seedOrder(TENANT_A, {
        cashier,
        lines: ["1000.00", "2000.00"]
      });

      await deliver(TENANT_A, paidEvent(orderId));

      expect(await accrualsOf(TENANT_A)).toEqual([]);
      const refused = (await getAdminSql()`
        SELECT attributes FROM awcms_audit_events
        WHERE tenant_id = ${TENANT_A} AND action = 'commerce.commission.attribution_refused'
      `) as { attributes: { reason: string; lines: number } }[];
      // An order-wide refusal stops at the first line.
      expect(refused).toHaveLength(1);
      expect(refused[0]!.attributes.reason).toBe("no_effective_rule");
      expect(refused[0]!.attributes.lines).toBe(1);
      expect(JSON.stringify(refused[0]!.attributes)).not.toContain("1000");
    });

    test("the rule declares another source type: refused as a mismatch", async () => {
      await link(TENANT_A, cashier, employment);
      await getAdminSql()`TRUNCATE awcms_hr_commission_rules CASCADE`;
      await publishedRule(TENANT_A, { sourceType: "booking_service" });
      await enable(TENANT_A);
      const { orderId } = await seedOrder(TENANT_A, { cashier });
      await deliver(TENANT_A, paidEvent(orderId));
      expect(await accrualsOf(TENANT_A)).toEqual([]);
      const refused = (await getAdminSql()`
        SELECT attributes->>'reason' AS reason FROM awcms_audit_events
        WHERE tenant_id = ${TENANT_A} AND action = 'commerce.commission.attribution_refused'
      `) as { reason: string }[];
      expect(refused.map((row) => row.reason)).toEqual([
        "source_type_mismatch"
      ]);
    });

    test("an employment that had ended before the sale is refused as not eligible", async () => {
      const ended = await seedEmployment(TENANT_A, {
        hiredOn: "2026-01-01",
        terminatedOn: "2026-02-01"
      });
      const other = await seedTenantUser(TENANT_A);
      await link(TENANT_A, other, ended);
      await enable(TENANT_A);
      const { orderId } = await seedOrder(TENANT_A, { cashier: other });
      await deliver(TENANT_A, paidEvent(orderId));
      expect(await accrualsOf(TENANT_A)).toEqual([]);
      const refused = (await getAdminSql()`
        SELECT attributes->>'reason' AS reason FROM awcms_audit_events
        WHERE tenant_id = ${TENANT_A} AND action = 'commerce.commission.attribution_refused'
      `) as { reason: string }[];
      expect(refused.map((row) => row.reason)).toEqual([
        "employment_not_eligible"
      ]);
    });

    test("a linked employment id that exists nowhere is refused as not found", async () => {
      await link(TENANT_A, cashier, "99999999-9999-4999-8999-999999999999");
      await enable(TENANT_A);
      const { orderId } = await seedOrder(TENANT_A, { cashier });
      await deliver(TENANT_A, paidEvent(orderId));
      expect(await accrualsOf(TENANT_A)).toEqual([]);
      const refused = (await getAdminSql()`
        SELECT attributes->>'reason' AS reason FROM awcms_audit_events
        WHERE tenant_id = ${TENANT_A} AND action = 'commerce.commission.attribution_refused'
      `) as { reason: string }[];
      expect(refused.map((row) => row.reason)).toEqual([
        "employment_not_found"
      ]);
    });

    test("a changed order discount after the first delivery is a source conflict: audited, the original accrual stands", async () => {
      await link(TENANT_A, cashier, employment);
      await enable(TENANT_A);
      const { orderId } = await seedOrder(TENANT_A, { cashier });
      await deliver(TENANT_A, paidEvent(orderId));
      const before = await accrualsOf(TENANT_A);

      // Anything that makes the redelivered request differ from the stored one.
      await getAdminSql()`
        UPDATE awcms_commerce_orders SET discount = 20000.00 WHERE id = ${orderId}
      `;
      await deliver(TENANT_A, paidEvent(orderId));

      expect(await accrualsOf(TENANT_A)).toEqual(before);
      expect(await auditActions(TENANT_A)).toContain(
        "commerce.commission.attribution_rejected"
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("tenant isolation", () => {
    test("tenant B's sales never use tenant A's link, settings or rule", async () => {
      await link(TENANT_A, cashier, employment);
      await enable(TENANT_A);
      // B has its own login, enabled settings and NO link; A's cashier id is
      // even stamped on B's order (a hostile or mistaken value).
      const cashierB = await seedTenantUser(TENANT_B);
      await enable(TENANT_B);
      const sale = await seedOrder(TENANT_B, { cashier });
      const own = await seedOrder(TENANT_B, { cashier: cashierB });

      await deliver(TENANT_B, paidEvent(sale.orderId));
      await deliver(TENANT_B, paidEvent(own.orderId));

      expect(await accrualsOf(TENANT_B)).toEqual([]);
      expect(await accrualsOf(TENANT_A)).toEqual([]);
    });

    test("tenant B cannot see or retire tenant A's links, and cannot link A's login", async () => {
      const linkId = await link(TENANT_A, cashier, employment);

      const seenByB = await inTenant(TENANT_B, async (tx) => ({
        links: await tx`SELECT id FROM awcms_commerce_commission_staff_links`,
        settings:
          await tx`SELECT tenant_id FROM awcms_commerce_commission_settings`,
        retire: await retireStaffLink(tx, TENANT_B, ADMIN_A, linkId),
        link: await createStaffLink(tx, TENANT_B, ADMIN_A, {
          tenantUserId: cashier,
          employmentId: employment
        })
      }));
      expect(seenByB.links).toEqual([]);
      expect(seenByB.settings).toEqual([]);
      expect(seenByB.retire).toEqual({ kind: "not_found" });
      expect(seenByB.link).toEqual({ kind: "tenant_user_not_found" });

      const stillLive = (await getAdminSql()`
        SELECT retired_at FROM awcms_commerce_commission_staff_links WHERE id = ${linkId}
      `) as { retired_at: Date | null }[];
      expect(stillLive[0]!.retired_at).toBeNull();
    });

    test("both tables have RLS enabled and FORCED, and the owner connection with no tenant sees nothing", async () => {
      const flags = (await getAdminSql()`
        SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname IN ('awcms_commerce_commission_settings', 'awcms_commerce_commission_staff_links')
        ORDER BY relname
      `) as {
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }[];
      expect(flags).toHaveLength(2);
      for (const flag of flags) {
        expect(flag.relrowsecurity).toBe(true);
        expect(flag.relforcerowsecurity).toBe(true);
      }

      await link(TENANT_A, cashier, employment);
      await enable(TENANT_A);
      const seen = await assertNoTenantRows();
      expect(seen).toBe(0);
    });

    async function assertNoTenantRows(): Promise<number> {
      // No `app.current_tenant_id` set: the policy compares against the empty
      // setting and matches nothing (or errors) - either way no row is visible.
      try {
        const rows = (await getOwnerSql()`
          SELECT (SELECT count(*) FROM awcms_commerce_commission_staff_links)
               + (SELECT count(*) FROM awcms_commerce_commission_settings) AS n
        `) as { n: string | number }[];
        return Number(rows[0]!.n);
      } catch {
        return 0;
      }
    }
  });

  // -------------------------------------------------------------------------
  describe("the staff-link table", () => {
    test("one live link per login and per employment; a retired link frees both; who it joins never changes; it is never deleted", async () => {
      const linkId = await link(TENANT_A, cashier, employment);

      const sameLogin = await inTenant(TENANT_A, (tx) =>
        createStaffLink(tx, TENANT_A, ADMIN_A, {
          tenantUserId: cashier,
          employmentId: "88888888-8888-4888-8888-888888888888"
        })
      );
      expect(sameLogin).toEqual({ kind: "login_already_linked" });

      const otherLogin = await seedTenantUser(TENANT_A);
      const sameEmployment = await inTenant(TENANT_A, (tx) =>
        createStaffLink(tx, TENANT_A, ADMIN_A, {
          tenantUserId: otherLogin,
          employmentId: employment
        })
      );
      expect(sameEmployment).toEqual({ kind: "employment_already_linked" });

      await assertRejected(
        inTenant(
          TENANT_A,
          (tx) => tx`
            UPDATE awcms_commerce_commission_staff_links
            SET employment_id = '88888888-8888-4888-8888-888888888888'
            WHERE id = ${linkId}
          `
        ),
        "rewriting who a link joins"
      );
      await assertRejected(
        inTenant(
          TENANT_A,
          (tx) => tx`
            DELETE FROM awcms_commerce_commission_staff_links WHERE id = ${linkId}
          `
        ),
        "deleting a link"
      );

      expect(
        (
          await inTenant(TENANT_A, (tx) =>
            retireStaffLink(tx, TENANT_A, ADMIN_A, linkId)
          )
        ).kind
      ).toBe("retired");
      expect(
        await inTenant(TENANT_A, (tx) =>
          retireStaffLink(tx, TENANT_A, ADMIN_A, linkId)
        )
      ).toEqual({ kind: "already_retired" });

      // Retired: both the login and the employment can be linked again.
      const relinked = await inTenant(TENANT_A, (tx) =>
        createStaffLink(tx, TENANT_A, ADMIN_A, {
          tenantUserId: otherLogin,
          employmentId: employment
        })
      );
      expect(relinked.kind).toBe("created");

      // A retired link is final.
      await assertRejected(
        getAdminSql()`
          UPDATE awcms_commerce_commission_staff_links
          SET retired_at = NULL, retired_by_tenant_user_id = NULL WHERE id = ${linkId}
        `,
        "un-retiring a link"
      );
    });

    test("a login that is not a user of the tenant cannot be linked (404, same as another tenant's)", async () => {
      const outcome = await inTenant(TENANT_A, (tx) =>
        createStaffLink(tx, TENANT_A, ADMIN_A, {
          tenantUserId: "77777777-7777-4777-8777-777777777777",
          employmentId: employment
        })
      );
      expect(outcome).toEqual({ kind: "tenant_user_not_found" });
    });

    test("the adapter cannot be switched on without a rule key, below the application too", async () => {
      await assertRejected(
        inTenant(
          TENANT_A,
          (tx) => tx`
            INSERT INTO awcms_commerce_commission_settings (tenant_id, enabled)
            VALUES (${TENANT_A}, true)
          `
        ),
        "enabling without a rule key"
      );
    });

    test("settings and link changes are audited with their before/after and ids, and no amount", async () => {
      await enable(TENANT_A);
      const linkId = await link(TENANT_A, cashier, employment);
      await inTenant(TENANT_A, (tx) =>
        retireStaffLink(tx, TENANT_A, ADMIN_A, linkId)
      );
      expect(await auditActions(TENANT_A)).toEqual([
        "commerce.commission.settings_updated",
        "commerce.commission.staff_link_created",
        "commerce.commission.staff_link_retired"
      ]);
    });
  });

  // -------------------------------------------------------------------------
  describe("the source identity is frozen once an attribution exists (#413 review)", () => {
    test("before any accrual the source type and rule key may change; after the first accrual they are refused (409 path) and audited, unchanged values still accepted", async () => {
      await link(TENANT_A, cashier, employment);
      await enable(TENANT_A);

      const beforeAccrual = await inTenant(TENANT_A, (tx) =>
        saveCommissionSettings(tx, TENANT_A, ADMIN_A, {
          enabled: true,
          ruleKey: RULE_KEY,
          sourceType: SOURCE_TYPE
        })
      );
      expect(beforeAccrual.kind).toBe("saved");

      const { orderId } = await seedOrder(TENANT_A, { cashier });
      await deliver(TENANT_A, paidEvent(orderId));
      expect(await accrualsOf(TENANT_A)).toHaveLength(1);

      const markers = (await getAdminSql()`
        SELECT source_type, rule_key
        FROM awcms_commerce_commission_attributed_sources
        WHERE tenant_id = ${TENANT_A}
      `) as { source_type: string; rule_key: string }[];
      expect(markers).toEqual([
        { source_type: SOURCE_TYPE, rule_key: RULE_KEY }
      ]);

      const refused = await inTenant(TENANT_A, (tx) =>
        saveCommissionSettings(tx, TENANT_A, ADMIN_A, {
          enabled: true,
          ruleKey: RULE_KEY,
          sourceType: "another_source"
        })
      );
      expect(refused).toEqual({
        kind: "source_locked",
        fields: ["sourceType"]
      });

      const refusedRule = await inTenant(TENANT_A, (tx) =>
        saveCommissionSettings(tx, TENANT_A, ADMIN_A, {
          enabled: true,
          ruleKey: "another_rule",
          sourceType: SOURCE_TYPE
        })
      );
      expect(refusedRule).toEqual({
        kind: "source_locked",
        fields: ["ruleKey"]
      });

      // The stored settings are untouched, and the refusal audit row COMMITTED.
      const stored = await inTenant(TENANT_A, (tx) =>
        fetchCommissionSettings(tx, TENANT_A)
      );
      expect(stored.sourceType).toBe(SOURCE_TYPE);
      expect(stored.ruleKey).toBe(RULE_KEY);
      expect(await auditActions(TENANT_A)).toContain(
        "commerce.commission.settings_refused"
      );

      // Unchanged identity: switching off and on again stays free.
      await enable(TENANT_A, false);
      await enable(TENANT_A, true);

      // A redelivery still accrues under the same identity: one row.
      await deliver(TENANT_A, paidEvent(orderId));
      expect(await accrualsOf(TENANT_A)).toHaveLength(1);
    });

    test("a settings update waits for an in-flight attribution (lock-then-refuse)", async () => {
      await link(TENANT_A, cashier, employment);
      await enable(TENANT_A);
      const { orderId } = await seedOrder(TENANT_A, { cashier });

      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });

      // The consumer's transaction: attribution done, transaction still open.
      const attribution = inTenant(TENANT_A, async (tx) => {
        await attributeCommissionForPaidOrder(tx, TENANT_A, orderId);
        entered();
        await held;
      });
      await started;

      // The settings update queues behind the shared lock, then sees the marker.
      const update = inTenant(TENANT_A, (tx) =>
        saveCommissionSettings(tx, TENANT_A, ADMIN_A, {
          enabled: true,
          ruleKey: RULE_KEY,
          sourceType: "late_change"
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      release();
      await attribution;

      expect(await update).toEqual({
        kind: "source_locked",
        fields: ["sourceType"]
      });
    });

    test("the marker is tenant-isolated and cannot be updated or deleted, by any role", async () => {
      await link(TENANT_A, cashier, employment);
      await enable(TENANT_A);
      const { orderId } = await seedOrder(TENANT_A, { cashier });
      await deliver(TENANT_A, paidEvent(orderId));

      const seenByB = await inTenant(
        TENANT_B,
        (tx) => tx`SELECT 1 FROM awcms_commerce_commission_attributed_sources`
      );
      expect(seenByB).toEqual([]);
      await assertRejected(
        getAdminSql()`UPDATE awcms_commerce_commission_attributed_sources SET rule_key = 'x'`,
        "rewriting a marker"
      );
      await assertRejected(
        getAdminSql()`DELETE FROM awcms_commerce_commission_attributed_sources`,
        "deleting a marker"
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("dormant: the worker role holds nothing on the payroll tables (sql/1053)", () => {
    test("the consumers are not registered with the dispatcher", () => {
      const registered = listDomainEventConsumers().map(
        (consumer) => consumer.name
      );
      for (const consumer of DORMANT_COMMISSION_CONSUMERS) {
        expect(registered).not.toContain(consumer.name);
      }
    });

    test("awcms_worker holds no table or column privilege on any awcms_hr_commission_* table, and no UPDATE (id) on awcms_hr_employments", async () => {
      const rows = (await getAdminSql()`
        SELECT c.relname AS table_name,
               has_table_privilege('awcms_worker', c.oid, 'SELECT, INSERT, UPDATE, DELETE') AS any_table,
               has_any_column_privilege('awcms_worker', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES') AS any_column
        FROM pg_class c
        WHERE c.relname IN (
          'awcms_hr_commission_accruals', 'awcms_hr_commission_transitions',
          'awcms_hr_commission_rules'
        ) AND c.relkind = 'r'
      `) as { table_name: string; any_table: boolean; any_column: boolean }[];
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect([row.table_name, row.any_table, row.any_column]).toEqual([
          row.table_name,
          false,
          false
        ]);
      }
    });

    test("the worker's only UPDATE on awcms_hr_employments is upstream's updated_at", async () => {
      const rows = (await getAdminSql()`
        SELECT a.attname AS column_name
        FROM pg_attribute a
        WHERE a.attrelid = 'awcms_hr_employments'::regclass
          AND a.attnum > 0 AND NOT a.attisdropped
          AND has_column_privilege('awcms_worker', a.attrelid, a.attnum, 'UPDATE')
      `) as { column_name: string }[];
      expect(rows.map((row) => row.column_name)).toEqual(["updated_at"]);
    });

    test("the worker keeps only its commerce-owned reads", async () => {
      const rows = (await getAdminSql()`
        SELECT has_table_privilege('awcms_worker', 'awcms_commerce_commission_settings', 'SELECT') AS settings,
               has_table_privilege('awcms_worker', 'awcms_commerce_commission_staff_links', 'SELECT') AS links
      `) as { settings: boolean; links: boolean }[];
      expect(rows[0]).toEqual({ settings: true, links: true });
    });
  });
});
