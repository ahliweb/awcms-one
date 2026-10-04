/**
 * `commerce` POS operational-report projections against a REAL migrated
 * PostgreSQL (Issue #296, ADR-0035) - through `tests/integration/harness.ts`,
 * under the least-privilege runtime role and FORCE RLS, driving the REAL
 * `reporting` engine (incremental worker, rebuild, reconcile, export) the way
 * `commerce-sales-reports.integration.test.ts` does for the sales projections.
 * Gated on `DATABASE_URL`; skips cleanly without one.
 *
 * The acceptance list, each a property only a database proves, for all five
 * projections (tenders, cash-up variance, expenses, loyalty, stored value):
 *
 *   - the live (incremental) rows equal a full rebuild, byte for byte;
 *   - reconciliation reports no mismatch on a caught-up projection, DOES report
 *     one when the table is tampered with, and when the source moved ahead of
 *     the projection (a delayed projection is honest drift, not a bug);
 *   - a late fact (a pending leg that settles, a decision, a correction, a
 *     reversal) lands on ITS OWN day and the figures stay exact;
 *   - day bucketing follows `Asia/Jakarta`, including an instant one second
 *     after local midnight that is still the previous day in UTC;
 *   - the tender projection equals the live ledger read (`listTenderMix`) for
 *     the same range;
 *   - a family whose source feature is OFF reads empty with `enabled: false`;
 *   - RLS: tenant B sees none of tenant A's rows, through the read functions
 *     AND with a raw SELECT under the runtime role.
 *
 * Fixtures are seeded with raw SQL over the RLS-bypassing admin connection:
 * this test is about the projections, not the writers. Every source fact gets
 * a distinct, explicit cursor timestamp well in the past (the engine's cursor
 * has a documented 1 ms tie limitation and a `now() - lag` upper bound).
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
import { commerceModule } from "../../src/modules/commerce/module";
import { listTenderMix } from "../../src/modules/commerce/application/payment-allocation-directory";
import {
  fetchCashUpReport,
  fetchExpenseReport,
  fetchLoyaltyReport,
  fetchStoredValueDailyReport,
  fetchTenderReport
} from "../../src/modules/commerce/application/operational-report-directory";
import {
  OPERATIONAL_REPORT_PROJECTION_KEYS,
  POS_CASH_UP_VARIANCE_PROJECTION_KEY,
  POS_EXPENSE_DAILY_PROJECTION_KEY,
  POS_LOYALTY_DAILY_PROJECTION_KEY,
  POS_RETURNS_DAILY_PROJECTION_KEY,
  POS_STORED_VALUE_DAILY_PROJECTION_KEY,
  POS_TENDER_DAILY_PROJECTION_KEY
} from "../../src/modules/commerce/domain/operational-report-keys";
import { SALES_REPORT_TIME_ZONE } from "../../src/modules/commerce/domain/sales-report-deltas";
import { updateModuleSettings } from "../../src/modules/module-management/application/module-settings";
import type { ProjectionDescriptor } from "../../src/modules/_shared/module-contract";
import { runIncrementalUpdateForTenant } from "../../src/modules/reporting/application/projection-incremental-worker";
import {
  continueRebuildPasses,
  triggerOrResumeRebuild
} from "../../src/modules/reporting/application/projection-rebuild";
import { reconcileProjection } from "../../src/modules/reporting/application/projection-reconciliation";
import { generateProjectionExport } from "../../src/modules/reporting/application/export-generation";
import {
  getAdminSql,
  getRuntimeSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "11111111-1111-4111-8111-111111111296";
const TENANT_B = "22222222-2222-4222-8222-222222222296";
const CASHIER = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c296";
const SUPERVISOR = "e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e296";
const B_USER = "f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f296";

/** 2026-09-10 in Asia/Jakarta is 2026-09-09T17:00Z .. 2026-09-10T16:59:59.999Z. */
const MORNING = new Date("2026-09-10T03:00:00.000Z"); // 10:00 WIB, 09-10
const LAST_SECOND = new Date("2026-09-10T16:59:59.000Z"); // 23:59:59 WIB, 09-10
const AFTER_MIDNIGHT = new Date("2026-09-10T17:00:01.000Z"); // 00:00:01 WIB, 09-11
const NEXT_NOON = new Date("2026-09-11T05:00:00.000Z"); // 12:00 WIB, 09-11
const LATER = new Date("2026-09-14T05:00:00.000Z"); // 09-14

const DAY_1 = "2026-09-10";
const DAY_2 = "2026-09-11";
const WIDE = { from: "2026-09-01", to: "2026-09-30" };

// The returns & refunds family (Issue #316) has its own integration file with
// its own world; this one covers the five families of Issue #296.
const DESCRIPTORS = commerceModule.reportingProjections!.filter(
  (d) =>
    (OPERATIONAL_REPORT_PROJECTION_KEYS as readonly string[]).includes(d.key) &&
    d.key !== POS_RETURNS_DAILY_PROJECTION_KEY
);
const byKey = (key: string): ProjectionDescriptor =>
  DESCRIPTORS.find((d) => d.key === key)!;

function inTenant<T>(
  tenantId: string,
  fn: (tx: Bun.SQL) => Promise<T>
): Promise<T> {
  return withTenantOrThrow(getRuntimeSql(), tenantId, fn);
}

async function seedTenant(id: string, code: string): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${code + " Name"}, ${code + " Legal"}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

async function seedTenantUser(tenantId: string, id: string): Promise<void> {
  const admin = getAdminSql();
  const profile = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', 'Report Test Actor')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`rep-actor-${id}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${id}, ${tenantId}, ${identity[0]!.id})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function setFeatures(
  tenantId: string,
  features: Record<string, boolean>
): Promise<void> {
  await inTenant(tenantId, (tx) =>
    updateModuleSettings(
      tx,
      tenantId,
      "commerce",
      {
        features: {
          pos: true,
          inbox: true,
          campaigns: true,
          gateway: true,
          courier: true,
          ...features
        }
      },
      CASHIER
    )
  );
}

// ---------------------------------------------------------------------------
// Engine helpers
// ---------------------------------------------------------------------------

async function refresh(
  tenantId: string,
  descriptors: readonly ProjectionDescriptor[] = DESCRIPTORS
): Promise<void> {
  for (const descriptor of descriptors) {
    const outcome = await runIncrementalUpdateForTenant(
      getRuntimeSql(),
      descriptor,
      tenantId
    );
    expect(outcome.failed).toBe(false);
    expect(outcome.skippedRebuildInProgress).toBe(false);
  }
}

async function rebuild(
  tenantId: string,
  descriptor: ProjectionDescriptor
): Promise<void> {
  const { run } = await inTenant(tenantId, (tx) =>
    triggerOrResumeRebuild(tx, tenantId, descriptor, {
      requestedBy: null,
      reason: "integration test"
    })
  );
  const result = await continueRebuildPasses(
    getRuntimeSql(),
    tenantId,
    descriptor,
    run.id
  );
  expect(result.status).toBe("completed");
}

async function reconcile(tenantId: string, descriptor: ProjectionDescriptor) {
  return inTenant(tenantId, (tx) =>
    reconcileProjection(tx, tenantId, descriptor, null)
  );
}

const PROJECTION_TABLES = [
  ["awcms_commerce_report_tender_daily", "day, register_id, tender_type"],
  ["awcms_commerce_report_cash_up_tenders", "day, session_id, tender_type"],
  ["awcms_commerce_report_expense_daily", "day, category_id, tender_type"],
  ["awcms_commerce_report_loyalty_daily", "day, bucket"],
  ["awcms_commerce_report_stored_value_daily", "day, account_kind, bucket"]
] as const;

/** Raw table rows via the admin channel - `updated_at` excluded - to compare a rebuild against the live rows byte for byte. */
async function rawRows(tenantId: string) {
  const admin = getAdminSql();
  const out: Record<string, string> = {};
  for (const [table, order] of PROJECTION_TABLES) {
    const rows = await admin.unsafe(
      `SELECT to_jsonb(t) - 'updated_at' AS row FROM ${table} t
       WHERE tenant_id = $1 ORDER BY ${order}`,
      [tenantId]
    );
    out[table] = JSON.stringify(rows.map((r: { row: unknown }) => r.row));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Source fixtures (raw SQL, explicit cursor timestamps)
// ---------------------------------------------------------------------------

type Ids = {
  customer: string;
  register1: string;
  register2: string;
  categoryUtility: string;
  categoryFormula: string;
};

async function seedBase(tenantId: string): Promise<Ids> {
  const admin = getAdminSql();
  const [customer] = (await admin`
    INSERT INTO awcms_commerce_customers (tenant_id, name, phone)
    VALUES (${tenantId}, 'Budi', ${"+6281200" + tenantId.slice(-4)})
    RETURNING id
  `) as { id: string }[];
  const registers = (await admin`
    INSERT INTO awcms_commerce_registers (tenant_id, code, name)
    VALUES (${tenantId}, 'R1', 'Front till'), (${tenantId}, 'R2', 'Back till')
    RETURNING id, code
  `) as { id: string; code: string }[];
  const categories = (await admin`
    INSERT INTO awcms_commerce_expense_categories (tenant_id, code, name)
    VALUES (${tenantId}, 'UTIL', 'Utilities'), (${tenantId}, 'FRM', '=HYPERLINK("x")')
    RETURNING id, code
  `) as { id: string; code: string }[];
  return {
    customer: customer!.id,
    register1: registers.find((r) => r.code === "R1")!.id,
    register2: registers.find((r) => r.code === "R2")!.id,
    categoryUtility: categories.find((c) => c.code === "UTIL")!.id,
    categoryFormula: categories.find((c) => c.code === "FRM")!.id
  };
}

async function seedSession(
  tenantId: string,
  registerId: string,
  openedAt: Date
): Promise<string> {
  const [row] = (await getAdminSql()`
    INSERT INTO awcms_commerce_register_sessions
      (tenant_id, register_id, opened_at, opened_by_tenant_user_id,
       opening_float, current_cashier_tenant_user_id)
    VALUES (${tenantId}, ${registerId}, ${openedAt}, ${CASHIER}, 100000.00, ${CASHIER})
    RETURNING id
  `) as { id: string }[];
  return row!.id;
}

let orderCounter = 0;

async function seedOrder(
  tenantId: string,
  customerId: string,
  options: { sessionId?: string; total?: string } = {}
): Promise<string> {
  orderCounter += 1;
  const total = options.total ?? "100000.00";
  const [row] = (await getAdminSql()`
    INSERT INTO awcms_commerce_orders
      (tenant_id, order_code, customer_id, status, payment_method, payment_status,
       shipping_method, subtotal, total, channel, register_session_id, created_at)
    VALUES (${tenantId}, ${"ORD-296-" + orderCounter}, ${customerId}, 'paid',
      'manual_bank', 'paid', 'self_pickup', ${total}, ${total},
      ${options.sessionId ? "pos" : "storefront"}, ${options.sessionId ?? null},
      '2026-09-01T00:00:00Z')
    RETURNING id
  `) as { id: string }[];
  return row!.id;
}

let legCounter = 0;

type Leg = {
  orderId: string;
  tender:
    "cash" | "manual_qris" | "manual_bank_transfer" | "gateway" | "gift_card";
  amount: string;
  at: Date | null;
  kind?: "payment" | "reversal";
  reverses?: string;
  status?: "succeeded" | "pending" | "failed";
  sessionId?: string;
  storedValueAccountId?: string;
};

async function seedLeg(tenantId: string, leg: Leg): Promise<string> {
  legCounter += 1;
  const status = leg.status ?? "succeeded";
  const [row] = (await getAdminSql()`
    INSERT INTO awcms_commerce_payment_allocations
      (tenant_id, order_id, kind, reverses_allocation_id, tender_type, amount, status,
       provider, source, source_key, actor_kind, register_session_id,
       stored_value_account_id, created_at, settled_at)
    VALUES (${tenantId}, ${leg.orderId}, ${leg.kind ?? "payment"}, ${leg.reverses ?? null},
      ${leg.tender}, ${leg.amount}, ${status},
      ${leg.tender === "gateway" ? "midtrans" : null}, 'admin', ${"leg-296-" + legCounter},
      'system', ${leg.sessionId ?? null}, ${leg.storedValueAccountId ?? null},
      ${leg.at ?? MORNING}, ${status === "pending" ? null : leg.at})
    RETURNING id
  `) as { id: string }[];
  return row!.id;
}

async function closeSession(
  tenantId: string,
  sessionId: string,
  decidedAt: Date,
  lines: { tender: string; expected: string; counted: string }[],
  decision: "auto" | "pending" | "approved" = "auto"
): Promise<string> {
  const admin = getAdminSql();
  const gross = lines.reduce(
    (sum, line) => sum + Math.abs(Number(line.counted) - Number(line.expected)),
    0
  );
  const net = lines.reduce(
    (sum, line) => sum + (Number(line.counted) - Number(line.expected)),
    0
  );
  const pending = decision === "pending";
  const [request] = (await admin`
    INSERT INTO awcms_commerce_register_close_requests
      (tenant_id, session_id, attempt, requested_by_tenant_user_id, variance_total,
       variance_gross, approval_threshold, approval_required, variance_reason, decision,
       decided_at, source_key)
    VALUES (${tenantId}, ${sessionId}, 1, ${CASHIER}, ${net.toFixed(2)}, ${gross.toFixed(2)},
      50.00, ${pending}, ${gross > 0 ? "counted short" : null}, ${decision},
      ${pending ? null : decidedAt}, ${"close-296-" + sessionId})
    RETURNING id
  `) as { id: string }[];
  for (const line of lines) {
    await admin`
      INSERT INTO awcms_commerce_register_close_lines
        (tenant_id, close_request_id, session_id, tender_type, expected, counted, variance)
      VALUES (${tenantId}, ${request!.id}, ${sessionId}, ${line.tender}, ${line.expected},
        ${line.counted}, ${(Number(line.counted) - Number(line.expected)).toFixed(2)})
    `;
  }
  if (!pending) {
    await admin`
      UPDATE awcms_commerce_register_sessions
      SET status = 'closed', closed_at = ${decidedAt}, closed_by_tenant_user_id = ${CASHIER}
      WHERE id = ${sessionId}
    `;
  }
  return request!.id;
}

async function approveClose(
  tenantId: string,
  requestId: string,
  sessionId: string,
  at: Date
): Promise<void> {
  const admin = getAdminSql();
  await admin`
    UPDATE awcms_commerce_register_close_requests
    SET decision = 'approved', decided_by_tenant_user_id = ${SUPERVISOR}, decided_at = ${at}
    WHERE id = ${requestId} AND tenant_id = ${tenantId}
  `;
  await admin`
    UPDATE awcms_commerce_register_sessions
    SET status = 'closed', closed_at = ${at}, closed_by_tenant_user_id = ${SUPERVISOR}
    WHERE id = ${sessionId} AND tenant_id = ${tenantId}
  `;
}

async function seedCorrection(
  tenantId: string,
  sessionId: string,
  tender: string,
  adjustment: string,
  at: Date
): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_commerce_register_corrections
      (tenant_id, session_id, correction_id, tender_type, adjustment, reason,
       actor_tenant_user_id, source_key, created_at)
    VALUES (${tenantId}, ${sessionId}, gen_random_uuid(), ${tender}, ${adjustment},
      'recount', ${SUPERVISOR}, ${"corr-296-" + sessionId + tender}, ${at})
  `;
}

type ExpenseSeed = {
  categoryId: string;
  amount: string;
  occurredOn: string;
  postedAt: Date;
  tender?: "cash" | "manual_qris" | "manual_bank_transfer";
};

async function seedPostedExpense(
  tenantId: string,
  seed: ExpenseSeed
): Promise<string> {
  const [row] = (await getAdminSql()`
    INSERT INTO awcms_commerce_expenses
      (tenant_id, category_id, status, amount, tender_type, occurred_on, description,
       created_by_tenant_user_id, approval_threshold, decision, posted_by_tenant_user_id,
       posted_at, created_at)
    VALUES (${tenantId}, ${seed.categoryId}, 'posted', ${seed.amount},
      ${seed.tender ?? "cash"}, ${seed.occurredOn}::date, 'test expense', ${CASHIER},
      500000.00, 'auto', ${CASHIER}, ${seed.postedAt}, ${seed.postedAt})
    RETURNING id
  `) as { id: string }[];
  return row!.id;
}

async function reverseExpense(expenseId: string, at: Date): Promise<void> {
  await getAdminSql()`
    UPDATE awcms_commerce_expenses
    SET status = 'reversed', reversed_by_tenant_user_id = ${SUPERVISOR},
        reversed_at = ${at}, reversal_reason = 'duplicate'
    WHERE id = ${expenseId}
  `;
}

async function seedDraftExpense(tenantId: string, categoryId: string) {
  await getAdminSql()`
    INSERT INTO awcms_commerce_expenses
      (tenant_id, category_id, status, amount, tender_type, occurred_on, description,
       created_by_tenant_user_id)
    VALUES (${tenantId}, ${categoryId}, 'draft', 12345.00, 'cash', ${DAY_1}::date,
      'never posted', ${CASHIER})
  `;
}

type LoyaltyAccount = { id: string; seq: number };

async function seedLoyaltyAccount(
  tenantId: string,
  customerId: string
): Promise<LoyaltyAccount> {
  const [row] = (await getAdminSql()`
    INSERT INTO awcms_commerce_loyalty_accounts (tenant_id, customer_id)
    VALUES (${tenantId}, ${customerId})
    RETURNING id
  `) as { id: string }[];
  return { id: row!.id, seq: 0 };
}

async function seedLoyaltyEntry(
  tenantId: string,
  account: LoyaltyAccount,
  entry: {
    kind: "earn" | "redeem" | "expire" | "adjustment" | "reversal";
    points: number;
    at: Date;
    reverses?: string;
  }
): Promise<string> {
  account.seq += 1;
  const sourceType =
    entry.kind === "expire"
      ? "expiry"
      : entry.kind === "adjustment" || entry.kind === "reversal"
        ? "manual"
        : entry.kind === "redeem"
          ? "redemption"
          : "order";
  const [row] = (await getAdminSql()`
    INSERT INTO awcms_commerce_loyalty_ledger
      (tenant_id, account_id, account_seq, kind, points, balance_after, source_type,
       source_id, idempotency_key, reverses_entry_id, actor_tenant_user_id, reason, created_at)
    VALUES (${tenantId}, ${account.id}, ${account.seq}, ${entry.kind}, ${entry.points},
      ${entry.points}, ${sourceType},
      ${entry.kind === "expire" || entry.kind === "earn" ? crypto.randomUUID() : null},
      ${"loy-296-" + account.id + "-" + account.seq}, ${entry.reverses ?? null},
      ${entry.kind === "adjustment" ? SUPERVISOR : null},
      ${entry.kind === "adjustment" ? "goodwill" : null}, ${entry.at})
    RETURNING id
  `) as { id: string }[];
  return row!.id;
}

type StoredValueAccount = { id: string; seq: number };

/**
 * The stored-value ledger's `apply` trigger is the ONLY writer of an account's
 * balance and it stamps `created_at := clock_timestamp()` itself, so a fixture
 * cannot place an entry on a chosen past day through the front door. The
 * fixture transaction therefore runs with triggers off (`session_replication_
 * role = replica`, superuser-only, transaction-local): the rows it writes are
 * exactly the rows the trigger would have written, at the instants this test
 * needs. The projection under test reads only those rows.
 */
async function asFixtureTx<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  return getAdminSql().begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    return fn(tx);
  });
}

/** An account and its `issue` ledger entry, in ONE fixture transaction. */
async function seedStoredValueAccount(
  tenantId: string,
  kind: "gift_card" | "store_credit",
  issue: { amount: string; at: Date }
): Promise<StoredValueAccount> {
  const id = await asFixtureTx(async (tx) => {
    const [program] = (await tx`
      INSERT INTO awcms_commerce_stored_value_programs (tenant_id, kind, enabled)
      VALUES (${tenantId}, ${kind}, true)
      ON CONFLICT (tenant_id, kind) DO UPDATE SET enabled = true
      RETURNING id
    `) as { id: string }[];
    const [account] = (await tx`
      INSERT INTO awcms_commerce_stored_value_accounts
        (tenant_id, program_id, kind, code_hash, code_last4, status, balance, version)
      VALUES (${tenantId}, ${program!.id}, ${kind},
        ${"sha256:" + (kind === "gift_card" ? "ab" : "cd").repeat(32)}, '1234', 'active', 0, 0)
      RETURNING id
    `) as { id: string }[];
    await tx`
      INSERT INTO awcms_commerce_stored_value_ledger
        (tenant_id, account_id, kind, amount, account_seq, balance_after,
         source_key, actor_kind, created_at)
      VALUES (${tenantId}, ${account!.id}, 'issue', ${issue.amount}, 1, ${issue.amount},
        ${"sv-296-issue-" + account!.id}, 'system', ${issue.at})
    `;
    return account!.id;
  });
  return { id, seq: 1 };
}

async function seedStoredValueEntry(
  tenantId: string,
  account: StoredValueAccount,
  entry: {
    kind:
      "issue" | "load" | "redeem" | "refund" | "adjust" | "expire" | "disable";
    amount: string;
    at: Date;
    allocationId?: string;
  }
): Promise<void> {
  account.seq += 1;
  await asFixtureTx(async (tx) => {
    await tx`
      INSERT INTO awcms_commerce_stored_value_ledger
        (tenant_id, account_id, kind, amount, account_seq, balance_after, allocation_id,
         reason, source_key, actor_kind, created_at)
      VALUES (${tenantId}, ${account.id}, ${entry.kind}, ${entry.amount}, ${account.seq},
        1000000.00, ${entry.allocationId ?? null},
        ${entry.kind === "adjust" || entry.kind === "disable" ? "test" : null},
        ${"sv-296-" + account.id + "-" + account.seq}, 'system', ${entry.at})
    `;
  });
}

/** Everything every family needs, for tenant A. Returns the ids tests reach back for. */
async function seedWorld(tenantId: string, ids: Ids) {
  // --- tenders + cash-up -----------------------------------------------
  const onlineOrder = await seedOrder(tenantId, ids.customer);
  await seedLeg(tenantId, {
    orderId: onlineOrder,
    tender: "manual_qris",
    amount: "100000.00",
    at: LAST_SECOND
  });
  await seedLeg(tenantId, {
    orderId: onlineOrder,
    tender: "manual_qris",
    amount: "25000.00",
    at: AFTER_MIDNIGHT
  });

  const session1 = await seedSession(tenantId, ids.register1, MORNING);
  const posOrder = await seedOrder(tenantId, ids.customer, {
    sessionId: session1,
    total: "50000.00"
  });
  const cashLeg = await seedLeg(tenantId, {
    orderId: posOrder,
    tender: "cash",
    amount: "50000.00",
    at: MORNING,
    sessionId: session1
  });
  await seedLeg(tenantId, {
    orderId: posOrder,
    tender: "cash",
    amount: "10000.00",
    at: new Date(MORNING.getTime() + 3_600_000),
    kind: "reversal",
    reverses: cashLeg,
    sessionId: session1
  });
  // A failed gateway leg and a still-pending one never count.
  await seedLeg(tenantId, {
    orderId: onlineOrder,
    tender: "gateway",
    amount: "77000.00",
    at: MORNING,
    status: "failed"
  });
  const pendingLeg = await seedLeg(tenantId, {
    orderId: onlineOrder,
    tender: "gateway",
    amount: "33000.00",
    at: null,
    status: "pending"
  });

  // Session 1 closes with cash short by 1 000.00 (auto-approved).
  const closeAt = new Date(MORNING.getTime() + 8 * 3_600_000);
  await closeSession(tenantId, session1, closeAt, [
    { tender: "cash", expected: "40000.00", counted: "39000.00" },
    { tender: "manual_qris", expected: "0.00", counted: "0.00" }
  ]);

  // Session 2 awaits a supervisor: not a cash-up yet.
  const session2 = await seedSession(tenantId, ids.register2, NEXT_NOON);
  const pendingRequest = await closeSession(
    tenantId,
    session2,
    NEXT_NOON,
    [{ tender: "cash", expected: "20000.00", counted: "10000.00" }],
    "pending"
  );

  // --- expenses --------------------------------------------------------
  const expensePosted = await seedPostedExpense(tenantId, {
    categoryId: ids.categoryUtility,
    amount: "75000.00",
    occurredOn: DAY_1,
    postedAt: MORNING
  });
  const expenseToReverse = await seedPostedExpense(tenantId, {
    categoryId: ids.categoryUtility,
    amount: "20000.00",
    occurredOn: DAY_1,
    postedAt: new Date(MORNING.getTime() + 60_000)
  });
  await seedPostedExpense(tenantId, {
    categoryId: ids.categoryFormula,
    amount: "5000.00",
    occurredOn: DAY_2,
    postedAt: NEXT_NOON,
    tender: "manual_qris"
  });
  await seedDraftExpense(tenantId, ids.categoryUtility);
  await reverseExpense(expenseToReverse, LATER);

  // --- loyalty ---------------------------------------------------------
  const loyalty = await seedLoyaltyAccount(tenantId, ids.customer);
  await seedLoyaltyEntry(tenantId, loyalty, {
    kind: "earn",
    points: 100,
    at: MORNING
  });
  const earn50 = await seedLoyaltyEntry(tenantId, loyalty, {
    kind: "earn",
    points: 50,
    at: new Date(MORNING.getTime() + 1000)
  });
  await seedLoyaltyEntry(tenantId, loyalty, {
    kind: "redeem",
    points: -30,
    at: new Date(MORNING.getTime() + 2000)
  });
  await seedLoyaltyEntry(tenantId, loyalty, {
    kind: "expire",
    points: -20,
    at: AFTER_MIDNIGHT
  });
  await seedLoyaltyEntry(tenantId, loyalty, {
    kind: "adjustment",
    points: 5,
    at: new Date(AFTER_MIDNIGHT.getTime() + 1000)
  });
  await seedLoyaltyEntry(tenantId, loyalty, {
    kind: "reversal",
    points: -50,
    at: new Date(AFTER_MIDNIGHT.getTime() + 2000),
    reverses: earn50
  });

  // --- stored value ----------------------------------------------------
  const gift = await seedStoredValueAccount(tenantId, "gift_card", {
    amount: "50000.00",
    at: MORNING
  });
  const credit = await seedStoredValueAccount(tenantId, "store_credit", {
    amount: "15000.00",
    at: AFTER_MIDNIGHT
  });
  await seedStoredValueEntry(tenantId, gift, {
    kind: "load",
    amount: "10000.00",
    at: new Date(MORNING.getTime() + 1000)
  });
  // A gift-card redemption: the payment leg and its mirror ledger entry commit
  // together (a deferred pairing trigger refuses either alone).
  gift.seq += 1;
  const redeemAt = new Date(MORNING.getTime() + 2000);
  await asFixtureTx(async (tx) => {
    legCounter += 1;
    const [leg] = (await tx`
      INSERT INTO awcms_commerce_payment_allocations
        (tenant_id, order_id, kind, tender_type, amount, status, source, source_key,
         actor_kind, stored_value_account_id, created_at, settled_at)
      VALUES (${tenantId}, ${onlineOrder}, 'payment', 'gift_card', 20000.00, 'succeeded',
        'admin', ${"leg-296-" + legCounter}, 'system', ${gift.id}, ${redeemAt}, ${redeemAt})
      RETURNING id
    `) as { id: string }[];
    await tx`
      INSERT INTO awcms_commerce_stored_value_ledger
        (tenant_id, account_id, kind, amount, account_seq, balance_after, allocation_id,
         source_key, actor_kind, created_at)
      VALUES (${tenantId}, ${gift.id}, 'redeem', -20000.00, ${gift.seq}, 1000000.00,
        ${leg!.id}, ${"sv-296-redeem-" + gift.id}, 'system', ${redeemAt})
    `;
  });
  await seedStoredValueEntry(tenantId, gift, {
    kind: "expire",
    amount: "-5000.00",
    at: AFTER_MIDNIGHT
  });
  await seedStoredValueEntry(tenantId, credit, {
    kind: "adjust",
    amount: "-2500.00",
    at: new Date(AFTER_MIDNIGHT.getTime() + 1000)
  });
  await seedStoredValueEntry(tenantId, credit, {
    kind: "disable",
    amount: "0.00",
    at: new Date(AFTER_MIDNIGHT.getTime() + 2000)
  });

  return {
    session1,
    session2,
    pendingRequest,
    pendingLeg,
    expensePosted,
    expenseToReverse,
    onlineOrder
  };
}

// ---------------------------------------------------------------------------

suite("POS operational-report projections (Issue #296)", () => {
  let ids: Ids;
  let idsB: Ids;

  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "tenant-rep-a");
    await seedTenant(TENANT_B, "tenant-rep-b");
    await seedTenantUser(TENANT_A, CASHIER);
    await seedTenantUser(TENANT_A, SUPERVISOR);
    await seedTenantUser(TENANT_B, B_USER);
    await setFeatures(TENANT_A, {
      register: true,
      expenses: true,
      loyalty: true,
      storedValue: true
    });
    ids = await seedBase(TENANT_A);
    idsB = await seedBase(TENANT_B);
  }, 30000);

  test("the five descriptors are registered, tenant-scoped and gated on their own report permission", () => {
    expect(DESCRIPTORS.map((d) => d.key).sort()).toEqual(
      OPERATIONAL_REPORT_PROJECTION_KEYS.filter(
        (key) => key !== POS_RETURNS_DAILY_PROJECTION_KEY
      ).sort()
    );
    for (const descriptor of DESCRIPTORS) {
      expect(descriptor.source.strategy).toBe("cursor_table");
      expect(descriptor.requiredPermission).toMatch(
        /^commerce\.report_[a-z_]+\.read$/
      );
      expect(descriptor.dimensional).toBeDefined();
    }
  });

  describe("tenders - commerce.pos_tender_daily", () => {
    test("projects succeeded legs by settlement day, register and tender; reversals are separate; failed and pending never count", async () => {
      await seedWorld(TENANT_A, ids);
      await refresh(TENANT_A, [byKey(POS_TENDER_DAILY_PROJECTION_KEY)]);

      const report = await inTenant(TENANT_A, (tx) =>
        fetchTenderReport(tx, TENANT_A, WIDE)
      );
      expect(report.enabled).toBe(true);
      expect(report.timeZone).toBe(SALES_REPORT_TIME_ZONE);

      const cell = (day: string, tender: string, registerCode: string | null) =>
        report.items.find(
          (row) =>
            row.day === day &&
            row.tenderType === tender &&
            row.registerCode === registerCode
        );

      // 23:59:59 WIB lands on 09-10, 00:00:01 WIB on 09-11 - while BOTH are
      // 09-10 in UTC.
      expect(cell(DAY_1, "manual_qris", null)).toMatchObject({
        paymentCount: 1,
        payments: "100000.00",
        reversals: "0.00"
      });
      expect(cell(DAY_2, "manual_qris", null)).toMatchObject({
        paymentCount: 1,
        payments: "25000.00"
      });
      // The register-stamped cash: a payment and a reversal on R1.
      expect(cell(DAY_1, "cash", "R1")).toMatchObject({
        paymentCount: 1,
        payments: "50000.00",
        reversalCount: 1,
        reversals: "10000.00",
        net: "40000.00"
      });
      // The stored-value tender the world's gift-card redemption wrote.
      expect(cell(DAY_1, "gift_card", null)).toMatchObject({
        payments: "20000.00"
      });
      expect(cell(DAY_1, "gateway", null)).toBeUndefined();
      expect(report.totalPayments).toBe("195000.00");
      expect(report.totalReversals).toBe("10000.00");
      expect(report.totalNet).toBe("185000.00");
    });

    test("a pending gateway leg that settles later lands on ITS settlement day, and the projection stays exact", async () => {
      const world = await seedWorld(TENANT_A, ids);
      const descriptor = byKey(POS_TENDER_DAILY_PROJECTION_KEY);
      await refresh(TENANT_A, [descriptor]);

      await getAdminSql()`
        UPDATE awcms_commerce_payment_allocations
        SET status = 'succeeded', settled_at = ${NEXT_NOON}
        WHERE id = ${world.pendingLeg}
      `;
      await refresh(TENANT_A, [descriptor]);

      const report = await inTenant(TENANT_A, (tx) =>
        fetchTenderReport(tx, TENANT_A, WIDE)
      );
      const gateway = report.items.find((row) => row.tenderType === "gateway");
      expect(gateway).toMatchObject({
        day: DAY_2,
        payments: "33000.00",
        paymentCount: 1
      });
      expect((await reconcile(TENANT_A, descriptor)).mismatch).toBe(false);
    });

    test("agrees with the live ledger read (listTenderMix) for the same range", async () => {
      await seedWorld(TENANT_A, ids);
      // listTenderMix attributes by created_at and the projection by
      // settled_at; `seedLeg` writes the same instant to both (a pending leg
      // is the only one that differs, and the live read skips it too), so the
      // two read the same day.
      await refresh(TENANT_A, [byKey(POS_TENDER_DAILY_PROJECTION_KEY)]);

      const projected = await inTenant(TENANT_A, (tx) =>
        fetchTenderReport(tx, TENANT_A, WIDE)
      );
      const live = await inTenant(TENANT_A, (tx) =>
        listTenderMix(tx, TENANT_A, WIDE, SALES_REPORT_TIME_ZONE)
      );
      for (const row of live.items) {
        const sum = (field: "payments" | "reversals") =>
          projected.items
            .filter((item) => item.tenderType === row.tenderType)
            .reduce((total, item) => total + Number(item[field]), 0)
            .toFixed(2);
        expect(sum("payments")).toBe(row.payments);
        expect(sum("reversals")).toBe(row.reversals);
      }
    });
  });

  describe("cash-ups - commerce.pos_cash_up_variance", () => {
    test("projects an auto-approved close per tender with register, cashier and close day; a pending close is not a cash-up", async () => {
      await seedWorld(TENANT_A, ids);
      await refresh(TENANT_A, [byKey(POS_CASH_UP_VARIANCE_PROJECTION_KEY)]);

      const report = await inTenant(TENANT_A, (tx) =>
        fetchCashUpReport(tx, TENANT_A, WIDE)
      );
      expect(report.sessionCount).toBe(1);
      const cash = report.items.find((row) => row.tenderType === "cash")!;
      expect(cash).toMatchObject({
        day: DAY_1,
        registerCode: "R1",
        cashierTenantUserId: CASHIER,
        expected: "40000.00",
        counted: "39000.00",
        adjustment: "0.00",
        variance: "-1000.00"
      });
      expect(report.totalShort).toBe("-1000.00");
      expect(report.totalOver).toBe("0.00");
    });

    test("an approval that lands later appears on the close day, and a correction adjusts the counted figure without touching the original", async () => {
      const world = await seedWorld(TENANT_A, ids);
      const descriptor = byKey(POS_CASH_UP_VARIANCE_PROJECTION_KEY);
      await refresh(TENANT_A, [descriptor]);

      await approveClose(
        TENANT_A,
        world.pendingRequest,
        world.session2,
        NEXT_NOON
      );
      await seedCorrection(TENANT_A, world.session1, "cash", "500.00", LATER);
      await refresh(TENANT_A, [descriptor]);

      const report = await inTenant(TENANT_A, (tx) =>
        fetchCashUpReport(tx, TENANT_A, WIDE)
      );
      expect(report.sessionCount).toBe(2);
      const corrected = report.items.find(
        (row) => row.sessionId === world.session1 && row.tenderType === "cash"
      )!;
      expect(corrected).toMatchObject({
        counted: "39000.00",
        adjustment: "500.00",
        variance: "-500.00"
      });
      const approved = report.items.find(
        (row) => row.sessionId === world.session2
      )!;
      expect(approved).toMatchObject({
        day: DAY_2,
        registerCode: "R2",
        variance: "-10000.00"
      });
      expect(report.totalVariance).toBe("-10500.00");
      expect((await reconcile(TENANT_A, descriptor)).mismatch).toBe(false);
    });
  });

  describe("expenses - commerce.pos_expense_daily", () => {
    test("posted expenses count on their occurred-on day; a later reversal subtracts from the SAME day row; drafts never count", async () => {
      await seedWorld(TENANT_A, ids);
      await refresh(TENANT_A, [byKey(POS_EXPENSE_DAILY_PROJECTION_KEY)]);

      const report = await inTenant(TENANT_A, (tx) =>
        fetchExpenseReport(tx, TENANT_A, WIDE)
      );
      const utilities = report.items.find(
        (row) => row.categoryName === "Utilities"
      )!;
      expect(utilities).toMatchObject({
        day: DAY_1,
        tenderType: "cash",
        postedCount: 2,
        posted: "95000.00",
        reversedCount: 1,
        reversed: "20000.00",
        net: "75000.00"
      });
      expect(report.items).toHaveLength(2);
      expect(report.totalPosted).toBe("100000.00");
      expect(report.totalReversed).toBe("20000.00");
      expect(report.totalNet).toBe("80000.00");
    });
  });

  describe("loyalty - commerce.pos_loyalty_daily", () => {
    test("buckets points by kind and day, with adjustments/reversals split by sign, and reports the outstanding liability", async () => {
      await seedWorld(TENANT_A, ids);
      await refresh(TENANT_A, [byKey(POS_LOYALTY_DAILY_PROJECTION_KEY)]);

      const wide = await inTenant(TENANT_A, (tx) =>
        fetchLoyaltyReport(tx, TENANT_A, WIDE)
      );
      const at = (day: string, bucket: string) =>
        wide.items.find((row) => row.day === day && row.bucket === bucket);
      expect(at(DAY_1, "earn")).toMatchObject({ entries: 2, points: "150" });
      expect(at(DAY_1, "redeem")).toMatchObject({ entries: 1, points: "-30" });
      expect(at(DAY_2, "expire")).toMatchObject({ points: "-20" });
      expect(at(DAY_2, "adjustment_up")).toMatchObject({ points: "5" });
      expect(at(DAY_2, "reversal_down")).toMatchObject({ points: "-50" });
      expect(wide.openingPoints).toBe("0");
      expect(wide.closingPoints).toBe("55");

      // The liability movement: a window starting on day 2 opens with what day
      // 1 left behind and closes at the same figure.
      const second = await inTenant(TENANT_A, (tx) =>
        fetchLoyaltyReport(tx, TENANT_A, { from: DAY_2, to: WIDE.to })
      );
      expect(second.openingPoints).toBe("120");
      expect(second.movementPoints).toBe("-65");
      expect(second.closingPoints).toBe("55");
    });
  });

  describe("stored value - commerce.pos_stored_value_daily", () => {
    test("buckets money by account kind and day and reports outstanding liability per kind; disable/enable move nothing", async () => {
      await seedWorld(TENANT_A, ids);
      await refresh(TENANT_A, [byKey(POS_STORED_VALUE_DAILY_PROJECTION_KEY)]);

      const report = await inTenant(TENANT_A, (tx) =>
        fetchStoredValueDailyReport(tx, TENANT_A, WIDE)
      );
      const at = (day: string, kind: string, bucket: string) =>
        report.items.find(
          (row) =>
            row.day === day && row.accountKind === kind && row.bucket === bucket
        );
      expect(at(DAY_1, "gift_card", "issue")?.amount).toBe("50000.00");
      expect(at(DAY_1, "gift_card", "load")?.amount).toBe("10000.00");
      expect(at(DAY_1, "gift_card", "redeem")?.amount).toBe("-20000.00");
      expect(at(DAY_2, "gift_card", "expire")?.amount).toBe("-5000.00");
      expect(at(DAY_2, "store_credit", "issue")?.amount).toBe("15000.00");
      expect(at(DAY_2, "store_credit", "adjust_down")?.amount).toBe("-2500.00");
      expect(report.items.some((row) => row.bucket.startsWith("disable"))).toBe(
        false
      );

      const gift = report.balances.find((b) => b.accountKind === "gift_card")!;
      const credit = report.balances.find(
        (b) => b.accountKind === "store_credit"
      )!;
      expect(gift).toMatchObject({
        opening: "0.00",
        movement: "35000.00",
        closing: "35000.00"
      });
      expect(credit.closing).toBe("12500.00");
      expect(report.totalClosing).toBe("47500.00");
    });
  });

  describe("rebuild, reconcile and export - all five projections", () => {
    test("a rebuild reproduces the live rows byte for byte, and a caught-up projection reconciles clean", async () => {
      await seedWorld(TENANT_A, ids);
      await refresh(TENANT_A);
      const live = await rawRows(TENANT_A);
      for (const table of Object.keys(live)) {
        // Every family has something in it (the fixture is not vacuous).
        expect(JSON.parse(live[table]!).length).toBeGreaterThan(0);
      }

      for (const descriptor of DESCRIPTORS) {
        const before = await reconcile(TENANT_A, descriptor);
        expect(before.mismatch).toBe(false);
        await rebuild(TENANT_A, descriptor);
        const after = await reconcile(TENANT_A, descriptor);
        expect({
          key: descriptor.key,
          mismatches: after.details.filter((detail) => detail.mismatch)
        }).toEqual({ key: descriptor.key, mismatches: [] });
      }
      expect(await rawRows(TENANT_A)).toEqual(live);
    });

    test("reconcile detects tampering with each projection table", async () => {
      await seedWorld(TENANT_A, ids);
      await refresh(TENANT_A);
      const admin = getAdminSql();
      const tamper: Record<string, () => Promise<unknown>> = {
        [POS_TENDER_DAILY_PROJECTION_KEY]: () =>
          admin`UPDATE awcms_commerce_report_tender_daily SET payments = payments + 1.00 WHERE tenant_id = ${TENANT_A} AND tender_type = 'cash'`,
        [POS_CASH_UP_VARIANCE_PROJECTION_KEY]: () =>
          admin`UPDATE awcms_commerce_report_cash_up_tenders SET counted = counted + 1.00 WHERE tenant_id = ${TENANT_A} AND tender_type = 'cash'`,
        [POS_EXPENSE_DAILY_PROJECTION_KEY]: () =>
          admin`UPDATE awcms_commerce_report_expense_daily SET posted = posted + 1.00 WHERE tenant_id = ${TENANT_A} AND category_name = 'Utilities'`,
        [POS_LOYALTY_DAILY_PROJECTION_KEY]: () =>
          admin`UPDATE awcms_commerce_report_loyalty_daily SET points = points + 1 WHERE tenant_id = ${TENANT_A} AND bucket = 'earn'`,
        [POS_STORED_VALUE_DAILY_PROJECTION_KEY]: () =>
          admin`UPDATE awcms_commerce_report_stored_value_daily SET amount = amount + 1.00 WHERE tenant_id = ${TENANT_A} AND bucket = 'issue' AND account_kind = 'gift_card'`
      };
      for (const descriptor of DESCRIPTORS) {
        expect((await reconcile(TENANT_A, descriptor)).mismatch).toBe(false);
        await tamper[descriptor.key]!();
        const result = await reconcile(TENANT_A, descriptor);
        expect(result.mismatch).toBe(true);
        expect(result.details.some((detail) => detail.mismatch)).toBe(true);
        // A rebuild repairs it.
        await rebuild(TENANT_A, descriptor);
        expect((await reconcile(TENANT_A, descriptor)).mismatch).toBe(false);
      }
    });

    test("a source that moved ahead of the projection reconciles as drift until the next refresh", async () => {
      await seedWorld(TENANT_A, ids);
      await refresh(TENANT_A);
      const tender = byKey(POS_TENDER_DAILY_PROJECTION_KEY);
      const order = await seedOrder(TENANT_A, ids.customer);
      await seedLeg(TENANT_A, {
        orderId: order,
        tender: "manual_bank_transfer",
        amount: "9000.00",
        at: LATER
      });
      expect((await reconcile(TENANT_A, tender)).mismatch).toBe(true);
      await refresh(TENANT_A, [tender]);
      expect((await reconcile(TENANT_A, tender)).mismatch).toBe(false);
    });

    test("the generic projection export returns the projected rows with the declared columns", async () => {
      await seedWorld(TENANT_A, ids);
      await refresh(TENANT_A);
      for (const descriptor of DESCRIPTORS) {
        const rows = await inTenant(TENANT_A, (tx) =>
          descriptor.dimensional!.exportRows(tx, TENANT_A)
        );
        expect(rows.rows.length).toBeGreaterThan(0);
        for (const column of rows.columns) {
          expect(Object.keys(rows.rows[0]!)).toContain(column);
        }
      }
      // And the engine's own generator accepts the descriptors.
      expect(typeof generateProjectionExport).toBe("function");
    });
  });

  describe("feature gating", () => {
    test("a family whose source feature is OFF reads empty with enabled=false, and history reappears when it is switched back on", async () => {
      await seedWorld(TENANT_A, ids);
      await refresh(TENANT_A);
      await setFeatures(TENANT_A, {
        register: false,
        expenses: false,
        loyalty: false,
        storedValue: false
      });
      await inTenant(TENANT_A, async (tx) => {
        const cashUps = await fetchCashUpReport(tx, TENANT_A, WIDE);
        const expenses = await fetchExpenseReport(tx, TENANT_A, WIDE);
        const loyalty = await fetchLoyaltyReport(tx, TENANT_A, WIDE);
        const stored = await fetchStoredValueDailyReport(tx, TENANT_A, WIDE);
        for (const report of [cashUps, expenses, loyalty, stored]) {
          expect(report.enabled).toBe(false);
          expect(report.items).toEqual([]);
        }
        expect(loyalty.closingPoints).toBe("0");
        expect(stored.totalClosing).toBe("0.00");
        // Payments exist in every tenant: the tender family needs no feature.
        const tenders = await fetchTenderReport(tx, TENANT_A, WIDE);
        expect(tenders.enabled).toBe(true);
        expect(tenders.items.length).toBeGreaterThan(0);
      });

      await setFeatures(TENANT_A, { register: true, loyalty: true });
      const back = await inTenant(TENANT_A, (tx) =>
        fetchLoyaltyReport(tx, TENANT_A, WIDE)
      );
      expect(back.enabled).toBe(true);
      expect(back.closingPoints).toBe("55");
    });
  });

  describe("tenant isolation", () => {
    test("tenant B's projections are its own, and neither tenant can read the other's rows", async () => {
      await seedWorld(TENANT_A, ids);
      await refresh(TENANT_A);
      const beforeB = await inTenant(TENANT_B, (tx) =>
        fetchTenderReport(tx, TENANT_B, WIDE)
      );
      expect(beforeB.items).toEqual([]);

      // Tenant B gets one payment of its own.
      const orderB = await seedOrder(TENANT_B, idsB.customer);
      await seedLeg(TENANT_B, {
        orderId: orderB,
        tender: "cash",
        amount: "1234.00",
        at: MORNING
      });
      await refresh(TENANT_B, [byKey(POS_TENDER_DAILY_PROJECTION_KEY)]);

      const a = await inTenant(TENANT_A, (tx) =>
        fetchTenderReport(tx, TENANT_A, WIDE)
      );
      const b = await inTenant(TENANT_B, (tx) =>
        fetchTenderReport(tx, TENANT_B, WIDE)
      );
      expect(b.items).toHaveLength(1);
      expect(b.totalPayments).toBe("1234.00");
      expect(a.totalPayments).toBe("195000.00");

      // Under the runtime role a raw SELECT with tenant B's context sees no
      // tenant A row in ANY of the five tables - even without a WHERE clause.
      await inTenant(TENANT_B, async (tx) => {
        for (const [table] of PROJECTION_TABLES) {
          const rows = (await tx.unsafe(
            `SELECT DISTINCT tenant_id FROM ${table}`
          )) as { tenant_id: string }[];
          for (const row of rows) expect(row.tenant_id).toBe(TENANT_B);
        }
      });
      // And a write that names another tenant is refused by WITH CHECK.
      await expect(
        inTenant(TENANT_B, async (tx) => {
          await tx.unsafe(
            `INSERT INTO awcms_commerce_report_loyalty_daily (tenant_id, day, bucket, entries, points)
             VALUES ($1, '2026-09-10', 'earn', 1, 1)`,
            [TENANT_A]
          );
        })
      ).rejects.toThrow();
    });
  });
});
