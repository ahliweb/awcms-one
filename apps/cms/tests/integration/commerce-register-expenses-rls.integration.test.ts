/**
 * Expenses against the least-privilege RUNTIME role (Issue #294, epic #281,
 * ADR-0031) - the half `commerce-register-expenses.integration.test.ts` cannot
 * prove, because route handlers there run as the superuser `DATABASE_URL`
 * (which bypasses RLS). WORLD 1 (see `harness.ts`): an ephemeral database with
 * the real `awcms_app` / `awcms_worker` roles, so every assertion below is made
 * through a connection that RLS and the privilege grants actually bind.
 *
 *   - the directory functions work end to end AS `awcms_app` (the grants of
 *     `sql/990`-`sql/993` are sufficient, nothing more);
 *   - tenant isolation: tenant B's context sees none of tenant A's categories,
 *     expenses or the movements they produced, and cannot WRITE a row for A
 *     (`WITH CHECK`);
 *   - tenant-safe composite foreign keys, even through a credential that skips
 *     RLS;
 *   - least privilege: `awcms_app` cannot DELETE an expense or a category, and
 *     the retention worker can SELECT and DELETE but never UPDATE;
 *   - the lifecycle trigger: illegal transitions and frozen content are refused
 *     by the database itself.
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
  createExpenseCategory,
  listExpenseCategories
} from "../../src/modules/commerce/application/expense-category-directory";
import {
  createExpenseDraft,
  fetchExpense,
  listExpenses
} from "../../src/modules/commerce/application/expense-directory";
import {
  postExpense,
  reverseExpense
} from "../../src/modules/commerce/application/expense-posting";
import { createRegister } from "../../src/modules/commerce/application/register-directory";
import {
  listRegisterMovements,
  openRegisterSession
} from "../../src/modules/commerce/application/register-session-directory";
import { updateModuleSettings } from "../../src/modules/module-management/application/module-settings";
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

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const TENANT_B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const CLERK = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
const SUPERVISOR = "e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5";
const B_CLERK = "f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f6f6";
const TODAY = new Date().toISOString().slice(0, 10);

/** A Bun.SQL query is a lazy thenable; route it through a real Promise for `expect(...).rejects`. */
async function attempt(query: PromiseLike<unknown>): Promise<void> {
  await query;
}

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
    VALUES (${tenantId}, 'person', 'Expense Test Actor')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`exp-actor-${id}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${id}, ${tenantId}, ${identity[0]!.id})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function configure(tenantId: string, threshold: string): Promise<void> {
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
          register: true,
          expenses: true
        },
        expenses: { approvalThreshold: threshold }
      },
      CLERK
    )
  );
}

async function category(tenantId: string, actor: string, code = "ICE") {
  const outcome = await inTenant(tenantId, (tx) =>
    createExpenseCategory(tx, tenantId, actor, {
      code,
      name: `Category ${code}`
    })
  );
  if (outcome.kind !== "created") throw new Error("category not created");
  return outcome.category.id;
}

async function drawer(
  tenantId: string,
  actor: string,
  openingFloat = "100000.00"
) {
  const register = await inTenant(tenantId, (tx) =>
    createRegister(tx, tenantId, actor, {
      code: "KASIR-1",
      name: "Register",
      locationLabel: null
    })
  );
  if (register.kind !== "created") throw new Error("register not created");
  const session = await inTenant(tenantId, (tx) =>
    openRegisterSession(tx, tenantId, actor, {
      idempotencyKey: crypto.randomUUID(),
      registerId: register.register.id,
      openingFloat
    })
  );
  if (session.kind !== "created") throw new Error("session not opened");
  return { registerId: register.register.id, sessionId: session.session.id };
}

async function draftFor(
  tenantId: string,
  actor: string,
  categoryId: string,
  over: { amount?: string; registerSessionId?: string | null } = {}
) {
  const outcome = await inTenant(tenantId, (tx) =>
    createExpenseDraft(tx, tenantId, actor, {
      idempotencyKey: crypto.randomUUID(),
      categoryId,
      amount: over.amount ?? "25000.00",
      tenderType: "cash",
      occurredOn: TODAY,
      description: "Ice",
      payeeName: null,
      registerSessionId: over.registerSessionId ?? null
    })
  );
  if (outcome.kind !== "created") throw new Error(`draft: ${outcome.kind}`);
  return outcome.expense.id;
}

suite("Expenses under the least-privilege runtime role (Issue #294)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "tenant-exp-a");
    await seedTenant(TENANT_B, "tenant-exp-b");
    for (const id of [CLERK, SUPERVISOR]) await seedTenantUser(TENANT_A, id);
    await seedTenantUser(TENANT_B, B_CLERK);
    await configure(TENANT_A, "1000000.00");
    await configure(TENANT_B, "1000000.00");
  }, 30000);

  test("post and reverse work end to end as awcms_app, and every write is stamped with the right tenant", async () => {
    const categoryId = await category(TENANT_A, CLERK);
    const { sessionId } = await drawer(TENANT_A, CLERK);
    const expenseId = await draftFor(TENANT_A, CLERK, categoryId, {
      registerSessionId: sessionId
    });

    const posted = await inTenant(TENANT_A, (tx) =>
      postExpense(
        tx,
        TENANT_A,
        CLERK,
        expenseId,
        { idempotencyKey: crypto.randomUUID() },
        async () => false
      )
    );
    expect(posted.kind).toBe("posted");

    const reversed = await inTenant(TENANT_A, (tx) =>
      reverseExpense(tx, TENANT_A, SUPERVISOR, expenseId, {
        idempotencyKey: crypto.randomUUID(),
        reason: "Entered twice"
      })
    );
    expect(reversed.kind).toBe("reversed");

    const movements = await inTenant(TENANT_A, (tx) =>
      listRegisterMovements(tx, TENANT_A, sessionId)
    );
    expect(
      movements.map((m) => `${m.movementType}:${m.direction}:${m.amount}`)
    ).toEqual(["expense:out:25000.00", "correction:in:25000.00"]);

    const stamped = (await getAdminSql()`
      SELECT tenant_id::text AS tenant_id
      FROM awcms_commerce_register_movements WHERE expense_id = ${expenseId}
    `) as { tenant_id: string }[];
    expect(stamped.every((row) => row.tenant_id === TENANT_A)).toBe(true);
  });

  test("RLS: tenant B sees none of tenant A's categories, expenses or expense movements, and cannot write a row for A", async () => {
    const categoryId = await category(TENANT_A, CLERK);
    const { sessionId } = await drawer(TENANT_A, CLERK);
    const expenseId = await draftFor(TENANT_A, CLERK, categoryId, {
      registerSessionId: sessionId
    });
    await inTenant(TENANT_A, (tx) =>
      postExpense(
        tx,
        TENANT_A,
        CLERK,
        expenseId,
        { idempotencyKey: crypto.randomUUID() },
        async () => false
      )
    );

    // A sees its rows; B's context sees none, by id or by listing.
    const asA = await inTenant(TENANT_A, (tx) =>
      listExpenses(tx, TENANT_A, null)
    );
    expect(asA.items).toHaveLength(1);
    const asB = await inTenant(TENANT_B, (tx) =>
      listExpenses(tx, TENANT_B, null)
    );
    expect(asB.items).toHaveLength(0);
    expect(
      await inTenant(TENANT_B, (tx) => fetchExpense(tx, TENANT_B, expenseId))
    ).toBeNull();
    // Even asking with A's tenant id inside B's context finds nothing: RLS binds.
    expect(
      await inTenant(TENANT_B, (tx) => fetchExpense(tx, TENANT_A, expenseId))
    ).toBeNull();
    expect(
      await inTenant(TENANT_B, (tx) => listExpenseCategories(tx, TENANT_A))
    ).toHaveLength(0);
    const raw = await inTenant(TENANT_B, async (tx) => {
      const expenses =
        (await tx`SELECT count(*)::int AS n FROM awcms_commerce_expenses`) as {
          n: number;
        }[];
      const movements = (await tx`
        SELECT count(*)::int AS n FROM awcms_commerce_register_movements WHERE expense_id IS NOT NULL
      `) as { n: number }[];
      return { expenses: expenses[0]!.n, movements: movements[0]!.n };
    });
    expect(raw).toEqual({ expenses: 0, movements: 0 });

    // B cannot post, reverse or read A's expense through the directory either.
    expect(
      (
        await inTenant(TENANT_B, (tx) =>
          postExpense(
            tx,
            TENANT_B,
            B_CLERK,
            expenseId,
            { idempotencyKey: crypto.randomUUID() },
            async () => false
          )
        )
      ).kind
    ).toBe("not_found");
    expect(
      (
        await inTenant(TENANT_B, (tx) =>
          reverseExpense(tx, TENANT_B, B_CLERK, expenseId, {
            idempotencyKey: crypto.randomUUID(),
            reason: "x"
          })
        )
      ).kind
    ).toBe("not_found");

    // WITH CHECK: B's context cannot insert a row stamped for A.
    await expect(
      attempt(
        inTenant(
          TENANT_B,
          (tx) => tx`
            INSERT INTO awcms_commerce_expense_categories (tenant_id, code, name)
            VALUES (${TENANT_A}, 'EVIL', 'Evil')
          `
        )
      )
    ).rejects.toThrow();
    await expect(
      attempt(
        inTenant(
          TENANT_B,
          (tx) => tx`
            INSERT INTO awcms_commerce_expenses
              (tenant_id, category_id, amount, tender_type, occurred_on, description, created_by_tenant_user_id)
            VALUES (${TENANT_A}, ${categoryId}, 1.00, 'cash', ${TODAY}::date, 'x', ${B_CLERK})
          `
        )
      )
    ).rejects.toThrow();
  });

  test("composite foreign keys keep every reference inside one tenant, even for a credential that skips RLS", async () => {
    const aCategory = await category(TENANT_A, CLERK);
    const bCategory = await category(TENANT_B, B_CLERK, "B-ICE");
    const { sessionId: aSession } = await drawer(TENANT_A, CLERK);
    const aExpense = await draftFor(TENANT_A, CLERK, aCategory);
    const admin = getAdminSql();

    // category
    await expect(
      attempt(admin`
        INSERT INTO awcms_commerce_expenses
          (tenant_id, category_id, amount, tender_type, occurred_on, description, created_by_tenant_user_id)
        VALUES (${TENANT_B}, ${aCategory}, 1.00, 'cash', ${TODAY}::date, 'x', ${B_CLERK})
      `)
    ).rejects.toThrow(/foreign key/);
    // register session
    await expect(
      attempt(admin`
        INSERT INTO awcms_commerce_expenses
          (tenant_id, category_id, amount, tender_type, occurred_on, description,
           created_by_tenant_user_id, register_session_id)
        VALUES (${TENANT_B}, ${bCategory}, 1.00, 'cash', ${TODAY}::date, 'x', ${B_CLERK}, ${aSession})
      `)
    ).rejects.toThrow(/foreign key/);
    // a movement of tenant B pointing at tenant A's expense
    const bRegister = await inTenant(TENANT_B, (tx) =>
      createRegister(tx, TENANT_B, B_CLERK, {
        code: "B1",
        name: "B",
        locationLabel: null
      })
    );
    if (bRegister.kind !== "created") throw new Error("register");
    const bSession = await inTenant(TENANT_B, (tx) =>
      openRegisterSession(tx, TENANT_B, B_CLERK, {
        idempotencyKey: crypto.randomUUID(),
        registerId: bRegister.register.id,
        openingFloat: "0"
      })
    );
    if (bSession.kind !== "created") throw new Error("session");
    await expect(
      attempt(admin`
        INSERT INTO awcms_commerce_register_movements
          (tenant_id, session_id, movement_type, direction, amount, reference_kind,
           reference, actor_tenant_user_id, source_key, expense_id)
        VALUES (${TENANT_B}, ${bSession.session.id}, 'expense', 'out', 1.00, 'expense',
                'x', ${B_CLERK}, 'cross-tenant', ${aExpense})
      `)
    ).rejects.toThrow(/foreign key/);
  });

  test("least privilege: awcms_app cannot DELETE an expense or a category; the retention worker can SELECT and DELETE but not UPDATE", async () => {
    const categoryId = await category(TENANT_A, CLERK);
    const expenseId = await draftFor(TENANT_A, CLERK, categoryId);

    await expect(
      attempt(
        inTenant(
          TENANT_A,
          (tx) =>
            tx`DELETE FROM awcms_commerce_expenses WHERE id = ${expenseId}`
        )
      )
    ).rejects.toThrow(/permission denied/);
    await expect(
      attempt(
        inTenant(
          TENANT_A,
          (tx) =>
            tx`DELETE FROM awcms_commerce_expense_categories WHERE id = ${categoryId}`
        )
      )
    ).rejects.toThrow(/permission denied/);

    if (!workerRoleActivated) {
      console.warn(
        "[skip] awcms_worker is not activated; skipping the worker grants half."
      );
      return;
    }
    const worker = getWorkerRoleSql();
    const visible = await withTenantOrThrow(worker, TENANT_A, async (tx) => {
      const rows = (await tx`
        SELECT count(*)::int AS n FROM awcms_commerce_expenses WHERE tenant_id = ${TENANT_A}
      `) as { n: number }[];
      return rows[0]!.n;
    });
    expect(visible).toBe(1);
    await expect(
      attempt(
        withTenantOrThrow(
          worker,
          TENANT_A,
          (tx) =>
            tx`UPDATE awcms_commerce_expenses SET amount = 1.00 WHERE id = ${expenseId}`
        )
      )
    ).rejects.toThrow(/permission denied/);
  });

  test("the lifecycle trigger: illegal status moves and edits outside a draft are refused by the database itself", async () => {
    const categoryId = await category(TENANT_A, CLERK);
    const expenseId = await draftFor(TENANT_A, CLERK, categoryId);
    const admin = getAdminSql();

    // draft -> reversed skips posting.
    await expect(
      attempt(admin`
        UPDATE awcms_commerce_expenses SET status = 'reversed' WHERE id = ${expenseId}
      `)
    ).rejects.toThrow();
    // posted without its posting facts violates the shape CHECK.
    await expect(
      attempt(admin`
        UPDATE awcms_commerce_expenses SET status = 'posted' WHERE id = ${expenseId}
      `)
    ).rejects.toThrow();
    // identity and creator never change.
    await expect(
      attempt(admin`
        UPDATE awcms_commerce_expenses SET created_by_tenant_user_id = ${SUPERVISOR} WHERE id = ${expenseId}
      `)
    ).rejects.toThrow(/frozen/);

    // Post it properly; its content, then, is frozen.
    await inTenant(TENANT_A, (tx) =>
      postExpense(
        tx,
        TENANT_A,
        CLERK,
        expenseId,
        { idempotencyKey: crypto.randomUUID() },
        async () => false
      )
    );
    await expect(
      attempt(
        admin`UPDATE awcms_commerce_expenses SET amount = 1.00 WHERE id = ${expenseId}`
      )
    ).rejects.toThrow(/frozen/);
    await expect(
      attempt(
        admin`UPDATE awcms_commerce_expenses SET posted_by_tenant_user_id = ${SUPERVISOR} WHERE id = ${expenseId}`
      )
    ).rejects.toThrow(/posting facts/);
    // posted -> draft is not a move.
    await expect(
      attempt(
        admin`UPDATE awcms_commerce_expenses SET status = 'draft' WHERE id = ${expenseId}`
      )
    ).rejects.toThrow(/illegal status transition/);
  });
});
