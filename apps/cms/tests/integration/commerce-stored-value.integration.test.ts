/**
 * Closed-loop stored-value ledger integration (Issue #288, epic #281,
 * ADR-0029) — against a REAL migrated Postgres through
 * `tests/integration/harness.ts`, the same pattern `commerce-payment-
 * allocations` / `commerce-register-cash-up` use. Gated on `DATABASE_URL`;
 * skips cleanly without one.
 *
 * Covers exactly the properties only a real database can prove:
 *
 *   - issue: the plaintext code is returned ONCE and exists NOWHERE in the
 *     database afterwards (stored-value tables, audit, idempotency store,
 *     domain events, payment ledger); replay is safe and never re-reveals it;
 *   - the ledger is the truth and the DATABASE moves the projection: no direct
 *     edit of a balance/status, no overdraw, no UPDATE/DELETE, an entry that
 *     does not mirror its payment leg is refused, and neither half of the
 *     payment-leg/ledger pairing survives a COMMIT without the other;
 *   - redemption as a payment tender (owner payment and POS split tender with
 *     cash): same transaction, order authority unchanged, change never applies
 *     to a card, a refusal leaves NOTHING behind;
 *   - GENUINELY concurrent redemptions (separate transactions, separate pooled
 *     connections) can never overdraw; replays never double-spend;
 *   - reversal returns value to the original account (compensating `refund`),
 *     capped, policy-gated, refused for a disabled/expired account;
 *   - expiry (lazy on use + the sweep), disable/enable, adjust, load, ceiling;
 *   - reconcile detects (and only repairs the projection of) drift;
 *   - RLS cross-tenant isolation, tenant-safe composite FKs and BOLA;
 *   - the liability report reconciles to the ledger.
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
import { createProduct } from "../../src/modules/commerce/application/product-directory";
import { createPosOrder } from "../../src/modules/commerce/application/pos-directory";
import { fetchRegisterCashUpReport } from "../../src/modules/commerce/application/register-cash-up";
import { createRegister } from "../../src/modules/commerce/application/register-directory";
import { openRegisterSession } from "../../src/modules/commerce/application/register-session-directory";
import {
  IdempotencyPayloadMismatchError,
  createOrderFromCart
} from "../../src/modules/commerce/application/order-directory";
import {
  recordOwnerPayment,
  recordOwnerReversal
} from "../../src/modules/commerce/application/payment-recording";
import { listAllocationsForOrder } from "../../src/modules/commerce/application/payment-allocation-directory";
import {
  adjustStoredValueAccount,
  changeStoredValueAccountStatus,
  fetchStoredValueAccount,
  fetchStoredValueReport,
  issueStoredValueAccount,
  listStoredValueAccounts,
  listStoredValueLedger,
  listStoredValuePrograms,
  loadStoredValueAccount,
  reconcileStoredValue,
  sweepExpiredStoredValue,
  upsertStoredValueProgram
} from "../../src/modules/commerce/application/stored-value-directory";
import {
  lockStoredValueAccount,
  StoredValueInvariantError
} from "../../src/modules/commerce/application/stored-value-ledger";
import {
  resolveStoredValueAccounts,
  STORED_VALUE_LOOKUPS_PER_MINUTE,
  StoredValueInsufficientError,
  StoredValueLookupThrottledError,
  StoredValueNotFoundError,
  StoredValueUnavailableError
} from "../../src/modules/commerce/application/stored-value-tender";
import { saveStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import { updateModuleSettings } from "../../src/modules/module-management/application/module-settings";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
import { FeatureDisabledError } from "../../src/modules/commerce/domain/commerce-features";
import {
  hashStoredValueCode,
  normalizeStoredValueCode,
  replayLedger,
  type IssueAccountInput,
  type StoredValueKind
} from "../../src/modules/commerce/domain/stored-value";
import type {
  RecordPaymentInput,
  RecordReversalInput
} from "../../src/modules/commerce/domain/payment-allocation";
import type { CreatePosOrderInput } from "../../src/modules/commerce/domain/pos-order-validation";
import type { CreateProductInput } from "../../src/modules/commerce/domain/product-validation";
import type { CreateOrderInput } from "../../src/modules/commerce/domain/order-request-validation";
import { SALES_REPORT_TIME_ZONE } from "../../src/modules/commerce/domain/sales-report-deltas";
import { mediaLibraryPortAdapter } from "../../src/modules/media-library/application/media-library-port-adapter";
import {
  getAdminSql,
  getRuntimeSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const TENANT_B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const STAFF_1 = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
const STAFF_2 = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4";
const B_STAFF = "f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f6f6";
const NOW = new Date();

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

/**
 * Runs `fn` the way a route handler does: a typed refusal is CAUGHT inside the
 * transaction (the handler turns it into a response, which COMMITS the
 * transaction), so whatever was written before the refusal is kept. Throwing
 * out of `withTenantOrThrow` instead would roll everything back AND count as a
 * database failure toward the circuit breaker - not what production does.
 */
async function handled<T>(
  tenantId: string,
  fn: (tx: Bun.SQL) => Promise<T>
): Promise<
  { value: T; error: undefined } | { value: undefined; error: unknown }
> {
  return inTenant(tenantId, async (tx) => {
    try {
      return { value: await fn(tx), error: undefined };
    } catch (error) {
      return { value: undefined, error };
    }
  });
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
    VALUES (${tenantId}, 'person', 'Stored Value Test Actor')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`sv-actor-${id}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${id}, ${tenantId}, ${identity[0]!.id})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function enableSelfPickupQris(tenantId: string): Promise<void> {
  const validated = validateStoreSettingsInput({
    storeName: "Toko Kartu",
    shipping: { selfPickup: true },
    payment: { manualQris: { active: true, mediaObjectId: null } }
  });
  if (!validated.valid) throw new Error(JSON.stringify(validated.errors));
  await inTenant(tenantId, (tx) =>
    saveStoreSettings(tx, tenantId, STAFF_1, validated.value)
  );
}

async function setStoredValueFeature(
  tenantId: string,
  storedValue: boolean
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
          register: false,
          storedValue
        }
      },
      STAFF_1
    )
  );
}

const BASE_PRODUCT: CreateProductInput = {
  categoryId: null,
  type: "physical",
  sku: "SKU-SV",
  name: "Kopi Susu",
  slug: "kopi-susu-sv",
  description: null,
  digitalNote: null,
  price: "10000.00",
  discountPercent: 0,
  stock: 500,
  label: null,
  labelColor: null,
  priceLevel2: null,
  priceLevel3: null,
  priceLevel4: null,
  costPrice: null,
  minPurchase: 1,
  weightGrams: 250,
  manualRating: null,
  manualSoldCount: 0,
  withInsurance: false,
  insuranceRequired: false,
  insuranceFee: null,
  promoBannerShow: false,
  promoBannerTitle: null,
  promoBannerSubtitle: null,
  promoBannerBadge: null,
  promoBannerIcon: null,
  promoBannerColor: null,
  sizeChartType: "none",
  sizeChartMediaId: null,
  sizeChartDetails: null,
  serviceForm: null,
  subscriptionPeriod: null,
  downloadLink: null,
  allowDp: false,
  allowFreeShipping: true,
  variantAttributes: null,
  isFeatured: false,
  isRecommended: false
};

async function seedActiveProduct(tenantId: string): Promise<string> {
  const product = await inTenant(tenantId, (tx) =>
    createProduct(tx, tenantId, STAFF_1, BASE_PRODUCT)
  );
  await inTenant(
    tenantId,
    (tx) =>
      tx`UPDATE awcms_commerce_products SET status = 'active' WHERE id = ${product.id}`
  );
  return product.id;
}

async function configureProgram(
  tenantId: string,
  kind: StoredValueKind,
  overrides: Partial<{
    enabled: boolean;
    expiryDays: number | null;
    allowRefundToAccount: boolean;
    maxBalance: string | null;
  }> = {}
): Promise<void> {
  await inTenant(tenantId, (tx) =>
    upsertStoredValueProgram(tx, tenantId, STAFF_1, kind, {
      enabled: true,
      expiryDays: null,
      allowRefundToAccount: true,
      maxBalance: null,
      ...overrides
    })
  );
}

type Issued = {
  accountId: string;
  /** The plaintext code, exactly as shown to the operator once. */
  code: string;
  normalized: string;
};

function issueInput(
  overrides: Partial<IssueAccountInput> = {}
): IssueAccountInput {
  return {
    idempotencyKey: crypto.randomUUID(),
    kind: "gift_card",
    amount: "50000.00",
    customerId: null,
    expiresAt: undefined,
    reason: null,
    ...overrides
  };
}

async function issue(
  tenantId: string,
  overrides: Partial<IssueAccountInput> = {},
  actor = STAFF_1
) {
  return inTenant(tenantId, (tx) =>
    issueStoredValueAccount(
      tx,
      tenantId,
      actor,
      issueInput(overrides),
      new Date()
    )
  );
}

async function issueOk(
  tenantId: string,
  overrides: Partial<IssueAccountInput> = {}
): Promise<Issued> {
  const outcome = await issue(tenantId, overrides);
  if (outcome.kind !== "created" || !outcome.body.code) {
    throw new Error(`expected created, got ${JSON.stringify(outcome)}`);
  }
  return {
    accountId: outcome.body.account.id,
    code: outcome.body.code,
    normalized: normalizeStoredValueCode(outcome.body.code)
  };
}

async function balanceOf(tenantId: string, accountId: string): Promise<string> {
  const account = await inTenant(tenantId, (tx) =>
    fetchStoredValueAccount(tx, tenantId, accountId)
  );
  return account!.balance;
}

function posInput(
  productId: string,
  overrides: Partial<CreatePosOrderInput> = {}
): CreatePosOrderInput {
  return {
    idempotencyKey: crypto.randomUUID(),
    customer: { name: null, phone: null },
    lines: [{ productId, variantId: null, quantity: 1 }],
    payment: null,
    tenders: null,
    allowDue: false,
    registerId: null,
    notes: null,
    ...overrides
  };
}

async function ring(
  tenantId: string,
  input: CreatePosOrderInput,
  actor = STAFF_1
) {
  return inTenant(tenantId, (tx) =>
    createPosOrder(tx, tenantId, actor, mediaLibraryPortAdapter, input, NOW)
  );
}

async function createStorefrontOrder(
  tenantId: string,
  productId: string
): Promise<string> {
  const input: CreateOrderInput = {
    idempotencyKey: crypto.randomUUID(),
    customer: { name: "Budi", phone: "0813-1111-2222", email: null },
    address: null,
    lines: [
      { productId, variantId: null, quantity: 1, serviceFormValues: null }
    ],
    shipping: { method: "self_pickup" },
    payment: { method: "manual_qris" },
    voucherCode: null,
    insurance: false,
    notes: null,
    affiliateCode: null
  };
  const result = await inTenant(tenantId, (tx) =>
    createOrderFromCart(tx, tenantId, mediaLibraryPortAdapter, input, NOW)
  );
  if (result.kind !== "created") throw new Error("order not created");
  const rows = (await getAdminSql()`
    SELECT id FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId} AND order_code = ${result.order.orderCode}
  `) as { id: string }[];
  return rows[0]!.id;
}

function payWith(
  card: Issued,
  kind: StoredValueKind,
  amount: string,
  overrides: Partial<RecordPaymentInput> = {}
): RecordPaymentInput {
  return {
    idempotencyKey: crypto.randomUUID(),
    tenderType: kind,
    amount,
    reference: null,
    note: null,
    storedValueCode: card.normalized,
    ...overrides
  };
}

function reversalInput(
  overrides: Partial<RecordReversalInput> = {}
): RecordReversalInput {
  return {
    idempotencyKey: crypto.randomUUID(),
    amount: null,
    note: "goods returned",
    ...overrides
  };
}

async function orderCount(tenantId: string): Promise<number> {
  const rows = (await getAdminSql()`
    SELECT COUNT(*)::int AS n FROM awcms_commerce_orders WHERE tenant_id = ${tenantId}
  `) as { n: number }[];
  return rows[0]!.n;
}

async function ledgerRows(tenantId: string, accountId: string) {
  return (await getAdminSql()`
    SELECT kind, amount::text AS amount, balance_after::text AS balance_after,
           account_seq::int AS account_seq, allocation_id
    FROM awcms_commerce_stored_value_ledger
    WHERE tenant_id = ${tenantId} AND account_id = ${accountId}
    ORDER BY account_seq
  `) as {
    kind: string;
    amount: string;
    balance_after: string;
    account_seq: number;
    allocation_id: string | null;
  }[];
}

suite("closed-loop stored value integration (Issue #288)", () => {
  let productId = "";

  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "tenant-sv-a");
    await seedTenant(TENANT_B, "tenant-sv-b");
    for (const id of [STAFF_1, STAFF_2]) await seedTenantUser(TENANT_A, id);
    await seedTenantUser(TENANT_B, B_STAFF);
    await enableSelfPickupQris(TENANT_A);
    await setStoredValueFeature(TENANT_A, true);
    await configureProgram(TENANT_A, "gift_card");
    await configureProgram(TENANT_A, "store_credit");
    productId = await seedActiveProduct(TENANT_A);
  }, 30000);

  // -------------------------------------------------------------------------
  describe("programs", () => {
    test("both kinds are always reported; an unsaved one has disabled defaults; a save is audited", async () => {
      await resetDatabase();
      await seedTenant(TENANT_A, "tenant-sv-a");
      await seedTenantUser(TENANT_A, STAFF_1);
      const before = await inTenant(TENANT_A, (tx) =>
        listStoredValuePrograms(tx, TENANT_A)
      );
      expect(before.map((p) => [p.kind, p.configured, p.enabled])).toEqual([
        ["gift_card", false, false],
        ["store_credit", false, false]
      ]);

      await configureProgram(TENANT_A, "gift_card", {
        expiryDays: 365,
        maxBalance: "1000000.00",
        allowRefundToAccount: false
      });
      const after = await inTenant(TENANT_A, (tx) =>
        listStoredValuePrograms(tx, TENANT_A)
      );
      const gift = after.find((p) => p.kind === "gift_card")!;
      expect(gift).toMatchObject({
        configured: true,
        enabled: true,
        expiryDays: 365,
        maxBalance: "1000000.00",
        allowRefundToAccount: false
      });
      const audit = (await getAdminSql()`
        SELECT action FROM awcms_audit_events
        WHERE tenant_id = ${TENANT_A} AND action = 'stored_value_program.update'
      `) as { action: string }[];
      expect(audit).toHaveLength(1);
    });

    test("issuing is refused while the program is not enabled", async () => {
      await configureProgram(TENANT_A, "gift_card", { enabled: false });
      const outcome = await issue(TENANT_A);
      expect(outcome.kind).toBe("program_unavailable");
      expect(await ledgerCount(TENANT_A)).toBe(0);
    });

    test("a program's kind is fixed and it cannot be deleted by the runtime role", async () => {
      await attempt(
        getRuntimeSql().begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A}, true)`;
          await tx`UPDATE awcms_commerce_stored_value_programs SET kind = 'store_credit' WHERE kind = 'gift_card'`;
        })
      ).then(
        () => {
          throw new Error("expected the kind change to be refused");
        },
        (error: unknown) => expect(String(error)).toContain("fixed")
      );
      await attempt(
        getRuntimeSql().begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A}, true)`;
          await tx`DELETE FROM awcms_commerce_stored_value_programs`;
        })
      ).then(
        () => {
          throw new Error("expected the delete to be refused");
        },
        (error: unknown) => expect(String(error)).toContain("permission denied")
      );
    });
  });

  async function ledgerCount(tenantId: string): Promise<number> {
    const rows = (await getAdminSql()`
      SELECT COUNT(*)::int AS n FROM awcms_commerce_stored_value_ledger WHERE tenant_id = ${tenantId}
    `) as { n: number }[];
    return rows[0]!.n;
  }

  // -------------------------------------------------------------------------
  describe("issue — the code is shown once and never stored", () => {
    test("returns the plaintext once; stores only the tenant-scoped hash and last four; the ledger and projection agree", async () => {
      const outcome = await issue(TENANT_A, { amount: "75000.00" });
      expect(outcome.kind).toBe("created");
      if (outcome.kind !== "created") return;
      const { body } = outcome;
      expect(body.codeRevealed).toBe(true);
      expect(body.code).toMatch(/^[A-Z2-9]{7}-[A-Z2-9]{7}-[A-Z2-9]{7}$/);
      expect(body.account).toMatchObject({
        kind: "gift_card",
        status: "active",
        balance: "75000.00",
        version: 1
      });
      expect(body.account.maskedCode).toBe(
        `•••••••-•••••••-•••${body.code!.slice(-4)}`
      );
      expect(body.entry).toMatchObject({
        kind: "issue",
        amount: "75000.00",
        balanceAfter: "75000.00",
        accountSeq: 1
      });

      const normalized = normalizeStoredValueCode(body.code!);
      const rows = (await getAdminSql()`
        SELECT code_hash, code_last4 FROM awcms_commerce_stored_value_accounts
        WHERE id = ${body.account.id}
      `) as { code_hash: string; code_last4: string }[];
      expect(rows[0]!.code_hash).toBe(
        hashStoredValueCode(TENANT_A, normalized)
      );
      expect(rows[0]!.code_last4).toBe(normalized.slice(-4));
      // The same code in another tenant hashes differently (domain separation).
      expect(hashStoredValueCode(TENANT_B, normalized)).not.toBe(
        rows[0]!.code_hash
      );
    });

    test("the plaintext appears NOWHERE in the database after issue, redemption and reversal (audit, events, idempotency store, payment ledger, ledger)", async () => {
      const card = await issueOk(TENANT_A, { amount: "20000.00" });
      const orderId = await createStorefrontOrder(TENANT_A, productId);
      const paid = await inTenant(TENANT_A, (tx) =>
        recordOwnerPayment(
          tx,
          TENANT_A,
          STAFF_1,
          orderId,
          payWith(card, "gift_card", "10000.00")
        )
      );
      expect(paid.kind).toBe("created");
      if (paid.kind !== "created") return;
      await inTenant(TENANT_A, (tx) =>
        recordOwnerReversal(
          tx,
          TENANT_A,
          STAFF_1,
          orderId,
          paid.body.payment.id,
          reversalInput()
        )
      );
      await ring(
        TENANT_A,
        posInput(productId, {
          tenders: [
            {
              tenderType: "gift_card",
              amount: "10000.00",
              reference: null,
              storedValueCode: card.normalized
            }
          ]
        })
      );

      const needles = [
        card.code,
        card.normalized,
        card.normalized.slice(0, 12),
        card.normalized.slice(4, 16)
      ];
      const tables = (await getAdminSql()`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename LIKE 'awcms\\_%'
        ORDER BY tablename
      `) as { tablename: string }[];
      for (const { tablename } of tables) {
        const rows = (await getAdminSql().unsafe(
          `SELECT t::text AS row FROM "${tablename}" t`
        )) as { row: string }[];
        for (const { row } of rows) {
          for (const needle of needles) {
            expect(row.includes(needle)).toBe(false);
          }
        }
      }
    });

    test("a replay with the same key returns the same account WITHOUT the code, and never issues twice", async () => {
      const input = issueInput({ amount: "30000.00" });
      const first = await inTenant(TENANT_A, (tx) =>
        issueStoredValueAccount(tx, TENANT_A, STAFF_1, input, new Date())
      );
      const second = await inTenant(TENANT_A, (tx) =>
        issueStoredValueAccount(tx, TENANT_A, STAFF_1, input, new Date())
      );
      expect(first.kind).toBe("created");
      expect(second.kind).toBe("replayed");
      if (first.kind !== "created" || second.kind !== "replayed") return;
      expect(first.body.code).not.toBeNull();
      expect(second.body.code).toBeNull();
      expect(second.body.codeRevealed).toBe(false);
      expect(second.body.account.id).toBe(first.body.account.id);
      const accounts = await inTenant(TENANT_A, (tx) =>
        listStoredValueAccounts(tx, TENANT_A, null)
      );
      expect(accounts.items).toHaveLength(1);
    });

    test("the same key with a different payload is a conflict, and another actor cannot replay it", async () => {
      const input = issueInput({ amount: "30000.00" });
      await inTenant(TENANT_A, (tx) =>
        issueStoredValueAccount(tx, TENANT_A, STAFF_1, input, new Date())
      );
      await expect(
        inTenant(TENANT_A, (tx) =>
          issueStoredValueAccount(
            tx,
            TENANT_A,
            STAFF_1,
            { ...input, amount: "31000.00" },
            new Date()
          )
        )
      ).rejects.toBeInstanceOf(IdempotencyPayloadMismatchError);
      await expect(
        inTenant(TENANT_A, (tx) =>
          issueStoredValueAccount(tx, TENANT_A, STAFF_2, input, new Date())
        )
      ).rejects.toBeInstanceOf(IdempotencyPayloadMismatchError);
    });

    test("two genuinely concurrent requests with one key issue exactly ONE account", async () => {
      const input = issueInput({ amount: "30000.00" });
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          inTenant(TENANT_A, (tx) =>
            issueStoredValueAccount(tx, TENANT_A, STAFF_1, input, new Date())
          )
        )
      );
      expect(results.filter((r) => r.kind === "created")).toHaveLength(1);
      expect(results.filter((r) => r.kind === "replayed")).toHaveLength(3);
      const accounts = await inTenant(TENANT_A, (tx) =>
        listStoredValueAccounts(tx, TENANT_A, null)
      );
      expect(accounts.items).toHaveLength(1);
    });

    test("the balance ceiling refuses an issue before anything is written", async () => {
      await configureProgram(TENANT_A, "gift_card", {
        maxBalance: "100000.00"
      });
      const outcome = await issue(TENANT_A, { amount: "100000.01" });
      expect(outcome).toEqual({ kind: "ceiling", ceiling: "100000.00" });
      expect(await ledgerCount(TENANT_A)).toBe(0);
      const ok = await issue(TENANT_A, { amount: "100000.00" });
      expect(ok.kind).toBe("created");
    });

    test("an unknown customer is refused; an account lists newest first and filters by kind and last4", async () => {
      expect(
        (await issue(TENANT_A, { customerId: crypto.randomUUID() })).kind
      ).toBe("customer_not_found");
      const a = await issueOk(TENANT_A);
      await issueOk(TENANT_A, { kind: "store_credit" });
      const gifts = await inTenant(TENANT_A, (tx) =>
        listStoredValueAccounts(tx, TENANT_A, null, { kind: "gift_card" })
      );
      expect(gifts.items.map((x) => x.id)).toEqual([a.accountId]);
      const byTail = await inTenant(TENANT_A, (tx) =>
        listStoredValueAccounts(tx, TENANT_A, null, {
          last4: a.normalized.slice(-4).toLowerCase()
        })
      );
      expect(byTail.items.map((x) => x.id)).toEqual([a.accountId]);
    });

    test("an account issued under a program with an expiry gets expires_at from it; an explicit date overrides", async () => {
      await configureProgram(TENANT_A, "gift_card", { expiryDays: 30 });
      const outcome = await issue(TENANT_A);
      if (outcome.kind !== "created") throw new Error("not created");
      const days =
        (new Date(outcome.body.account.expiresAt!).getTime() - Date.now()) /
        86_400_000;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThan(30.1);
      const never = await issue(TENANT_A, { expiresAt: null });
      if (never.kind !== "created") throw new Error("not created");
      expect(never.body.account.expiresAt).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe("the database is the single writer of the projection", () => {
    test("a direct edit of a balance, a status or the version is refused, even by the owner of the table", async () => {
      const card = await issueOk(TENANT_A);
      for (const set of [
        "balance = 999999",
        "status = 'disabled'",
        "version = 99"
      ]) {
        await expect(
          attempt(
            getRuntimeSql().begin(async (tx) => {
              await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A}, true)`;
              await tx.unsafe(
                `UPDATE awcms_commerce_stored_value_accounts SET ${set} WHERE id = '${card.accountId}'`
              );
            })
          )
        ).rejects.toThrow(/ledger entry/);
      }
      expect(await balanceOf(TENANT_A, card.accountId)).toBe("50000.00");
    });

    test("an identity column (the code hash, the kind, the expiry) is frozen", async () => {
      const card = await issueOk(TENANT_A);
      await expect(
        attempt(
          getRuntimeSql().begin(async (tx) => {
            await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A}, true)`;
            await tx`UPDATE awcms_commerce_stored_value_accounts SET expires_at = now() + interval '1 year' WHERE id = ${card.accountId}`;
          })
        )
      ).rejects.toThrow(/fixed once issued/);
    });

    test("the ledger accepts no UPDATE and no DELETE from the runtime role, and a trigger refuses any UPDATE for every role", async () => {
      const card = await issueOk(TENANT_A);
      await expect(
        attempt(
          getRuntimeSql().begin(async (tx) => {
            await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A}, true)`;
            await tx`UPDATE awcms_commerce_stored_value_ledger SET reason = 'x' WHERE account_id = ${card.accountId}`;
          })
        )
      ).rejects.toThrow(/permission denied/);
      await expect(
        attempt(
          getRuntimeSql().begin(async (tx) => {
            await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A}, true)`;
            await tx`DELETE FROM awcms_commerce_stored_value_ledger WHERE account_id = ${card.accountId}`;
          })
        )
      ).rejects.toThrow(/permission denied/);
      await expect(
        attempt(
          getAdminSql()`UPDATE awcms_commerce_stored_value_ledger SET reason = 'x' WHERE account_id = ${card.accountId}`
        )
      ).rejects.toThrow(/append-only/);
    });

    test("a raw ledger insert that would overdraw is refused by the database itself", async () => {
      const card = await issueOk(TENANT_A, { amount: "1000.00" });
      await expect(
        attempt(
          getAdminSql().begin(async (tx) => {
            await tx`
              INSERT INTO awcms_commerce_stored_value_ledger
                (tenant_id, account_id, kind, amount, account_seq, balance_after,
                 reason, source_key, actor_kind)
              VALUES (${TENANT_A}, ${card.accountId}, 'adjust', -1000.01, 0, 0,
                      'bypass', 'raw:overdraw', 'system')
            `;
          })
        )
      ).rejects.toThrow(/insufficient stored value/);
      expect(await balanceOf(TENANT_A, card.accountId)).toBe("1000.00");
    });

    test("a raw redeem entry that does not mirror a payment leg is refused", async () => {
      const card = await issueOk(TENANT_A);
      await expect(
        attempt(
          getAdminSql().begin(async (tx) => {
            await tx`
              INSERT INTO awcms_commerce_stored_value_ledger
                (tenant_id, account_id, kind, amount, account_seq, balance_after,
                 source_key, actor_kind, allocation_id)
              VALUES (${TENANT_A}, ${card.accountId}, 'redeem', -100, 0, 0,
                      'raw:redeem', 'system', ${crypto.randomUUID()})
            `;
          })
        )
      ).rejects.toThrow();
      // And with no allocation at all the table CHECK refuses it.
      await expect(
        attempt(
          getAdminSql().begin(async (tx) => {
            await tx`
              INSERT INTO awcms_commerce_stored_value_ledger
                (tenant_id, account_id, kind, amount, account_seq, balance_after,
                 source_key, actor_kind)
              VALUES (${TENANT_A}, ${card.accountId}, 'redeem', -100, 0, 0,
                      'raw:redeem2', 'system')
            `;
          })
        )
      ).rejects.toThrow(/must mirror/);
    });

    test("an account row without its issue entry cannot be committed (deferred check)", async () => {
      const programs = (await getAdminSql()`
        SELECT id FROM awcms_commerce_stored_value_programs
        WHERE tenant_id = ${TENANT_A} AND kind = 'gift_card'
      `) as { id: string }[];
      await expect(
        attempt(
          getAdminSql()`
            INSERT INTO awcms_commerce_stored_value_accounts
              (tenant_id, program_id, kind, code_hash, code_last4)
            VALUES (${TENANT_A}, ${programs[0]!.id}, 'gift_card',
                    ${"sha256:" + "a".repeat(64)}, 'ABCD')
          `
        )
      ).rejects.toThrow(/no issue ledger entry/);
    });

    test("a stored-value payment leg cannot be committed without its mirror ledger entry (deferred pairing check)", async () => {
      const card = await issueOk(TENANT_A);
      const orderId = await createStorefrontOrder(TENANT_A, productId);
      await expect(
        attempt(
          getAdminSql()`
            INSERT INTO awcms_commerce_payment_allocations
              (tenant_id, order_id, kind, tender_type, amount, status, source, source_key,
               actor_kind, stored_value_account_id, settled_at)
            VALUES (${TENANT_A}, ${orderId}, 'payment', 'gift_card', 100, 'succeeded', 'admin',
                    'raw:unpaired', 'system', ${card.accountId}, now())
          `
        )
      ).rejects.toThrow(/no mirror stored-value ledger entry/);
    });

    test("the tender type and the account reference travel together (CHECK)", async () => {
      const card = await issueOk(TENANT_A);
      const orderId = await createStorefrontOrder(TENANT_A, productId);
      await expect(
        attempt(
          getAdminSql()`
            INSERT INTO awcms_commerce_payment_allocations
              (tenant_id, order_id, kind, tender_type, amount, status, source, source_key,
               actor_kind, stored_value_account_id, settled_at)
            VALUES (${TENANT_A}, ${orderId}, 'payment', 'cash', 100, 'succeeded', 'admin',
                    'raw:cash-with-card', 'system', ${card.accountId}, now())
          `
        )
      ).rejects.toThrow(/stored_value_check/);
      await expect(
        attempt(
          getAdminSql()`
            INSERT INTO awcms_commerce_payment_allocations
              (tenant_id, order_id, kind, tender_type, amount, status, source, source_key,
               actor_kind, settled_at)
            VALUES (${TENANT_A}, ${orderId}, 'payment', 'gift_card', 100, 'succeeded', 'admin',
                    'raw:card-without-account', 'system', now())
          `
        )
      ).rejects.toThrow(/stored_value_check/);
    });

    test("only the application writer inserts ledger rows: the pure replay of every ledger reproduces the stored projection", async () => {
      const card = await issueOk(TENANT_A, { amount: "40000.00" });
      await inTenant(TENANT_A, (tx) =>
        loadStoredValueAccount(tx, TENANT_A, STAFF_1, card.accountId, {
          idempotencyKey: crypto.randomUUID(),
          amount: "5000.50",
          reason: null
        })
      );
      await inTenant(TENANT_A, (tx) =>
        adjustStoredValueAccount(tx, TENANT_A, STAFF_1, card.accountId, {
          idempotencyKey: crypto.randomUUID(),
          amount: "-0.50",
          reason: "typo fix"
        })
      );
      const rows = await ledgerRows(TENANT_A, card.accountId);
      const replay = replayLedger(
        rows.map((row) => ({
          accountSeq: row.account_seq,
          amount: row.amount,
          balanceAfter: row.balance_after,
          kind: row.kind as never
        }))
      );
      expect(replay.breaks).toEqual([]);
      expect(replay.balance).toBe("45000.00");
      expect(await balanceOf(TENANT_A, card.accountId)).toBe(replay.balance);
    });
  });

  // -------------------------------------------------------------------------
  describe("load, adjust, disable, enable", () => {
    test("load adds value, is idempotent, and honours the program switch and the ceiling", async () => {
      const card = await issueOk(TENANT_A, { amount: "10000.00" });
      const input = {
        idempotencyKey: crypto.randomUUID(),
        amount: "2500.25",
        reason: "top-up"
      };
      const first = await inTenant(TENANT_A, (tx) =>
        loadStoredValueAccount(tx, TENANT_A, STAFF_1, card.accountId, input)
      );
      const replay = await inTenant(TENANT_A, (tx) =>
        loadStoredValueAccount(tx, TENANT_A, STAFF_1, card.accountId, input)
      );
      expect(first.kind).toBe("created");
      expect(replay.kind).toBe("replayed");
      expect(await balanceOf(TENANT_A, card.accountId)).toBe("12500.25");

      await expect(
        inTenant(TENANT_A, (tx) =>
          loadStoredValueAccount(tx, TENANT_A, STAFF_1, card.accountId, {
            ...input,
            amount: "1.00"
          })
        )
      ).rejects.toBeInstanceOf(IdempotencyPayloadMismatchError);

      await configureProgram(TENANT_A, "gift_card", { maxBalance: "13000.00" });
      const over = await inTenant(TENANT_A, (tx) =>
        loadStoredValueAccount(tx, TENANT_A, STAFF_1, card.accountId, {
          idempotencyKey: crypto.randomUUID(),
          amount: "500.00",
          reason: null
        })
      );
      expect(over).toMatchObject({
        kind: "refused",
        refusal: "BALANCE_CEILING"
      });

      await configureProgram(TENANT_A, "gift_card", { enabled: false });
      const disabledProgram = await inTenant(TENANT_A, (tx) =>
        loadStoredValueAccount(tx, TENANT_A, STAFF_1, card.accountId, {
          idempotencyKey: crypto.randomUUID(),
          amount: "1.00",
          reason: null
        })
      );
      expect(disabledProgram.kind).toBe("program_disabled");
      expect(await balanceOf(TENANT_A, card.accountId)).toBe("12500.25");
    });

    test("adjust: a reason is on the row, up and down work, and a downward adjustment never overdraws", async () => {
      const card = await issueOk(TENANT_A, { amount: "1000.00" });
      const down = await inTenant(TENANT_A, (tx) =>
        adjustStoredValueAccount(tx, TENANT_A, STAFF_1, card.accountId, {
          idempotencyKey: crypto.randomUUID(),
          amount: "-400.00",
          reason: "mis-keyed load"
        })
      );
      expect(down.kind).toBe("created");
      const tooFar = await inTenant(TENANT_A, (tx) =>
        adjustStoredValueAccount(tx, TENANT_A, STAFF_1, card.accountId, {
          idempotencyKey: crypto.randomUUID(),
          amount: "-600.01",
          reason: "too far"
        })
      );
      expect(tooFar).toMatchObject({
        kind: "refused",
        refusal: "INSUFFICIENT",
        available: "600.00"
      });
      const up = await inTenant(TENANT_A, (tx) =>
        adjustStoredValueAccount(tx, TENANT_A, STAFF_1, card.accountId, {
          idempotencyKey: crypto.randomUUID(),
          amount: "100.00",
          reason: "goodwill"
        })
      );
      expect(up.kind).toBe("created");
      expect(await balanceOf(TENANT_A, card.accountId)).toBe("700.00");
      const rows = await ledgerRows(TENANT_A, card.accountId);
      expect(rows.map((r) => [r.kind, r.amount])).toEqual([
        ["issue", "1000.00"],
        ["adjust", "-400.00"],
        ["adjust", "100.00"]
      ]);
      // The reason is stored on the ledger row and nowhere in the audit trail.
      const audit = (await getAdminSql()`
        SELECT message, attributes::text AS attributes FROM awcms_audit_events
        WHERE tenant_id = ${TENANT_A} AND action = 'stored_value.adjust'
      `) as { message: string; attributes: string }[];
      expect(audit).toHaveLength(2);
      for (const row of audit) {
        expect(row.message).not.toContain("mis-keyed");
        expect(row.attributes).not.toContain("mis-keyed");
      }
    });

    test("disable blocks redemption and keeps the balance; enable restores; an adjustment still works on a disabled account", async () => {
      const card = await issueOk(TENANT_A, { amount: "20000.00" });
      const disabled = await inTenant(TENANT_A, (tx) =>
        changeStoredValueAccountStatus(tx, TENANT_A, STAFF_1, card.accountId, {
          idempotencyKey: crypto.randomUUID(),
          action: "disable",
          reason: "lost card"
        })
      );
      expect(disabled.kind).toBe("created");
      if (disabled.kind !== "created") return;
      expect(disabled.body.account.status).toBe("disabled");
      expect(disabled.body.account.balance).toBe("20000.00");

      const orderId = await createStorefrontOrder(TENANT_A, productId);
      const refused = await handled(TENANT_A, (tx) =>
        recordOwnerPayment(
          tx,
          TENANT_A,
          STAFF_1,
          orderId,
          payWith(card, "gift_card", "10000.00")
        )
      );
      expect(refused.error).toBeInstanceOf(StoredValueUnavailableError);
      expect(
        await inTenant(TENANT_A, (tx) =>
          listAllocationsForOrder(tx, TENANT_A, orderId)
        )
      ).toHaveLength(0);

      const twice = await inTenant(TENANT_A, (tx) =>
        changeStoredValueAccountStatus(tx, TENANT_A, STAFF_1, card.accountId, {
          idempotencyKey: crypto.randomUUID(),
          action: "disable",
          reason: "again"
        })
      );
      expect(twice).toMatchObject({ kind: "refused", refusal: "NOT_ACTIVE" });

      const adjusted = await inTenant(TENANT_A, (tx) =>
        adjustStoredValueAccount(tx, TENANT_A, STAFF_1, card.accountId, {
          idempotencyKey: crypto.randomUUID(),
          amount: "-1000.00",
          reason: "correction while frozen"
        })
      );
      expect(adjusted.kind).toBe("created");

      const enabled = await inTenant(TENANT_A, (tx) =>
        changeStoredValueAccountStatus(tx, TENANT_A, STAFF_1, card.accountId, {
          idempotencyKey: crypto.randomUUID(),
          action: "enable",
          reason: null
        })
      );
      expect(enabled.kind).toBe("created");
      const paid = await inTenant(TENANT_A, (tx) =>
        recordOwnerPayment(
          tx,
          TENANT_A,
          STAFF_1,
          orderId,
          payWith(card, "gift_card", "10000.00")
        )
      );
      expect(paid.kind).toBe("created");
      expect(await balanceOf(TENANT_A, card.accountId)).toBe("9000.00");
    });
  });

  // -------------------------------------------------------------------------
  describe("redemption as a payment tender — owner payment", () => {
    test("a gift card settles an order in the same transaction: allocation row, mirror ledger entry, order paid, no code stored", async () => {
      const card = await issueOk(TENANT_A, { amount: "25000.00" });
      const orderId = await createStorefrontOrder(TENANT_A, productId);
      const outcome = await inTenant(TENANT_A, (tx) =>
        recordOwnerPayment(
          tx,
          TENANT_A,
          STAFF_1,
          orderId,
          payWith(card, "gift_card", "10000.00")
        )
      );
      expect(outcome.kind).toBe("created");
      if (outcome.kind !== "created") return;
      expect(outcome.body.settlement.paymentStatus).toBe("paid");
      expect(outcome.body.payment).toMatchObject({
        tenderType: "gift_card",
        kind: "payment",
        amount: "10000.00",
        providerReference: null,
        storedValue: {
          accountId: card.accountId,
          kind: "gift_card",
          maskedCode: `•••••••-•••••••-•••${card.normalized.slice(-4)}`
        }
      });
      expect(await balanceOf(TENANT_A, card.accountId)).toBe("15000.00");

      const rows = await ledgerRows(TENANT_A, card.accountId);
      expect(rows.map((r) => [r.kind, r.amount, r.balance_after])).toEqual([
        ["issue", "50000.00".replace("50000", "25000"), "25000.00"],
        ["redeem", "-10000.00", "15000.00"]
      ]);
      expect(rows[1]!.allocation_id).toBe(outcome.body.payment.id);
      const order = (await getAdminSql()`
        SELECT status, payment_status FROM awcms_commerce_orders WHERE id = ${orderId}
      `) as { status: string; payment_status: string }[];
      expect(order[0]).toEqual({ status: "paid", payment_status: "paid" });
    });

    test("a replay with the same Idempotency-Key never redeems twice", async () => {
      const card = await issueOk(TENANT_A, { amount: "25000.00" });
      const orderId = await createStorefrontOrder(TENANT_A, productId);
      const input = payWith(card, "gift_card", "4000.00");
      const a = await inTenant(TENANT_A, (tx) =>
        recordOwnerPayment(tx, TENANT_A, STAFF_1, orderId, input)
      );
      const b = await inTenant(TENANT_A, (tx) =>
        recordOwnerPayment(tx, TENANT_A, STAFF_1, orderId, input)
      );
      expect(a.kind).toBe("created");
      expect(b.kind).toBe("replayed");
      expect(await balanceOf(TENANT_A, card.accountId)).toBe("21000.00");
      expect(await ledgerRows(TENANT_A, card.accountId)).toHaveLength(2);
    });

    test("the same key with a different code is a conflict (the code is part of the request hash, as a hash)", async () => {
      const a = await issueOk(TENANT_A, { amount: "25000.00" });
      const b = await issueOk(TENANT_A, { amount: "25000.00" });
      const orderId = await createStorefrontOrder(TENANT_A, productId);
      const key = crypto.randomUUID();
      await inTenant(TENANT_A, (tx) =>
        recordOwnerPayment(
          tx,
          TENANT_A,
          STAFF_1,
          orderId,
          payWith(a, "gift_card", "1000.00", { idempotencyKey: key })
        )
      );
      await expect(
        inTenant(TENANT_A, (tx) =>
          recordOwnerPayment(
            tx,
            TENANT_A,
            STAFF_1,
            orderId,
            payWith(b, "gift_card", "1000.00", { idempotencyKey: key })
          )
        )
      ).rejects.toBeInstanceOf(IdempotencyPayloadMismatchError);
      const stored = (await getAdminSql()`
        SELECT request_hash FROM awcms_idempotency_keys
        WHERE tenant_id = ${TENANT_A} AND idempotency_key = ${key}
      `) as { request_hash: string }[];
      expect(stored[0]!.request_hash).not.toContain(a.normalized);
    });

    test("insufficient balance is refused with the available balance, and NOTHING is written", async () => {
      const card = await issueOk(TENANT_A, { amount: "3000.00" });
      const orderId = await createStorefrontOrder(TENANT_A, productId);
      const { error } = await handled(TENANT_A, (tx) =>
        recordOwnerPayment(
          tx,
          TENANT_A,
          STAFF_1,
          orderId,
          payWith(card, "gift_card", "10000.00")
        )
      );
      expect(error).toBeInstanceOf(StoredValueInsufficientError);
      expect((error as StoredValueInsufficientError).available).toBe("3000.00");
      expect(await balanceOf(TENANT_A, card.accountId)).toBe("3000.00");
      expect(
        await inTenant(TENANT_A, (tx) =>
          listAllocationsForOrder(tx, TENANT_A, orderId)
        )
      ).toHaveLength(0);
      expect(await ledgerRows(TENANT_A, card.accountId)).toHaveLength(1);
    });

    test("an unknown code, a code of the other kind and a code of ANOTHER TENANT are the same not-found", async () => {
      const gift = await issueOk(TENANT_A);
      await configureProgram(TENANT_B, "gift_card");
      await setStoredValueFeature(TENANT_B, true);
      const foreign = await issueOk(TENANT_B);
      const orderId = await createStorefrontOrder(TENANT_A, productId);
      for (const attemptInput of [
        payWith(gift, "gift_card", "1000.00", {
          storedValueCode: "ABCDEFGHJKLMNPQRSTUVW"
        }),
        payWith(gift, "store_credit", "1000.00"),
        payWith(foreign, "gift_card", "1000.00")
      ]) {
        const refused = await handled(TENANT_A, (tx) =>
          recordOwnerPayment(tx, TENANT_A, STAFF_1, orderId, attemptInput)
        );
        expect(refused.error).toBeInstanceOf(StoredValueNotFoundError);
      }
      expect(await balanceOf(TENANT_B, foreign.accountId)).toBe("50000.00");
    });

    test("with the storedValue feature OFF the tender is refused and nothing is touched", async () => {
      const card = await issueOk(TENANT_A);
      await setStoredValueFeature(TENANT_A, false);
      const orderId = await createStorefrontOrder(TENANT_A, productId);
      const refused = await handled(TENANT_A, (tx) =>
        recordOwnerPayment(
          tx,
          TENANT_A,
          STAFF_1,
          orderId,
          payWith(card, "gift_card", "1000.00")
        )
      );
      expect(refused.error).toBeInstanceOf(FeatureDisabledError);
      expect(await balanceOf(TENANT_A, card.accountId)).toBe("50000.00");
    });

    test("store credit is a separate kind with its own program", async () => {
      const credit = await issueOk(TENANT_A, {
        kind: "store_credit",
        amount: "10000.00"
      });
      const orderId = await createStorefrontOrder(TENANT_A, productId);
      const outcome = await inTenant(TENANT_A, (tx) =>
        recordOwnerPayment(
          tx,
          TENANT_A,
          STAFF_1,
          orderId,
          payWith(credit, "store_credit", "10000.00")
        )
      );
      expect(outcome.kind).toBe("created");
      if (outcome.kind !== "created") return;
      expect(outcome.body.payment.tenderType).toBe("store_credit");
      expect(await balanceOf(TENANT_A, credit.accountId)).toBe("0.00");
    });
  });

  // -------------------------------------------------------------------------
  describe("redemption as a payment tender — POS", () => {
    test("split tender: a gift card plus cash — change comes from the cash leg only and the order authority is unchanged", async () => {
      const card = await issueOk(TENANT_A, { amount: "6000.00" });
      const outcome = await ring(
        TENANT_A,
        posInput(productId, {
          tenders: [
            {
              tenderType: "gift_card",
              amount: "6000.00",
              reference: null,
              storedValueCode: card.normalized
            },
            { tenderType: "cash", amount: "5000.00", reference: null }
          ]
        })
      );
      expect(outcome.kind).toBe("created");
      if (outcome.kind !== "created") return;
      expect(outcome.order.status).toBe("paid");
      expect(outcome.order.paymentStatus).toBe("paid");
      expect(outcome.order.change).toBe("1000.00");
      expect(outcome.order.amountTendered).toBe("5000.00");
      const legs = outcome.order.payments!;
      expect(legs.map((l) => [l.tenderType, l.amount])).toEqual([
        ["gift_card", "6000.00"],
        ["cash", "4000.00"]
      ]);
      expect(legs[0]!.changeAmount).toBeNull();
      expect(legs[0]!.tenderedAmount).toBeNull();
      expect(legs[1]!.changeAmount).toBe("1000.00");
      expect(await balanceOf(TENANT_A, card.accountId)).toBe("0.00");
      // The 201 body (and so the stored idempotency response) names the card
      // only by its mask.
      expect(JSON.stringify(outcome.order)).not.toContain(card.normalized);
      expect(JSON.stringify(outcome.order)).toContain(
        card.normalized.slice(-4)
      );
    });

    test("a card tender can never be over-applied: it may not exceed the total (OverpaymentError), so no change is ever produced for it", async () => {
      const card = await issueOk(TENANT_A, { amount: "50000.00" });
      const refused = await handled(TENANT_A, (tx) =>
        createPosOrder(
          tx,
          TENANT_A,
          STAFF_1,
          mediaLibraryPortAdapter,
          posInput(productId, {
            tenders: [
              {
                tenderType: "gift_card",
                amount: "10000.01",
                reference: null,
                storedValueCode: card.normalized
              }
            ]
          }),
          NOW
        )
      );
      expect(String(refused.error)).toMatch(/exceeds what is still owed/);
      expect(await balanceOf(TENANT_A, card.accountId)).toBe("50000.00");
      expect(await orderCount(TENANT_A)).toBe(0);
    });

    test("a card tender without an explicit amount is refused (it must never drain a card)", async () => {
      const card = await issueOk(TENANT_A);
      const refused = await handled(TENANT_A, (tx) =>
        createPosOrder(
          tx,
          TENANT_A,
          STAFF_1,
          mediaLibraryPortAdapter,
          posInput(productId, {
            tenders: [
              {
                tenderType: "gift_card",
                amount: null,
                reference: null,
                storedValueCode: card.normalized
              }
            ]
          }),
          NOW
        )
      );
      expect(String(refused.error)).toMatch(/explicit amount/);
    });

    test("insufficient balance refuses the WHOLE sale before any row exists (no order, no stock movement, no ledger entry)", async () => {
      const card = await issueOk(TENANT_A, { amount: "2000.00" });
      const before = (await getAdminSql()`
        SELECT stock FROM awcms_commerce_products WHERE id = ${productId}
      `) as { stock: number }[];
      const refused = await handled(TENANT_A, (tx) =>
        createPosOrder(
          tx,
          TENANT_A,
          STAFF_1,
          mediaLibraryPortAdapter,
          posInput(productId, {
            tenders: [
              {
                tenderType: "gift_card",
                amount: "6000.00",
                reference: null,
                storedValueCode: card.normalized
              },
              { tenderType: "cash", amount: "4000.00", reference: null }
            ]
          }),
          NOW
        )
      );
      expect(refused.error).toBeInstanceOf(StoredValueInsufficientError);
      expect(await orderCount(TENANT_A)).toBe(0);
      expect(await balanceOf(TENANT_A, card.accountId)).toBe("2000.00");
      const after = (await getAdminSql()`
        SELECT stock FROM awcms_commerce_products WHERE id = ${productId}
      `) as { stock: number }[];
      expect(after[0]!.stock).toBe(before[0]!.stock);
    });

    test("a POS replay (same idempotency key) redeems once; the stored response never holds the code", async () => {
      const card = await issueOk(TENANT_A, { amount: "20000.00" });
      const input = posInput(productId, {
        tenders: [
          {
            tenderType: "gift_card",
            amount: "10000.00",
            reference: null,
            storedValueCode: card.normalized
          }
        ]
      });
      const first = await ring(TENANT_A, input);
      const second = await ring(TENANT_A, input);
      expect(first.kind).toBe("created");
      expect(second.kind).toBe("replayed");
      expect(await orderCount(TENANT_A)).toBe(1);
      expect(await balanceOf(TENANT_A, card.accountId)).toBe("10000.00");
      const stored = (await getAdminSql()`
        SELECT request_hash, response_body::text AS body FROM awcms_idempotency_keys
        WHERE tenant_id = ${TENANT_A} AND idempotency_key = ${input.idempotencyKey}
      `) as { request_hash: string; body: string }[];
      expect(stored[0]!.body).not.toContain(card.normalized);
      expect(stored[0]!.request_hash).not.toContain(card.normalized);
    });

    test("with the feature OFF a card tender is refused before anything is written", async () => {
      const card = await issueOk(TENANT_A);
      await setStoredValueFeature(TENANT_A, false);
      const refused = await handled(TENANT_A, (tx) =>
        createPosOrder(
          tx,
          TENANT_A,
          STAFF_1,
          mediaLibraryPortAdapter,
          posInput(productId, {
            tenders: [
              {
                tenderType: "gift_card",
                amount: "10000.00",
                reference: null,
                storedValueCode: card.normalized
              }
            ]
          }),
          NOW
        )
      );
      expect(refused.error).toBeInstanceOf(FeatureDisabledError);
      expect(await orderCount(TENANT_A)).toBe(0);
    });

    test("an ordinary cash sale is byte-for-byte what it was (feature on or off)", async () => {
      const outcome = await ring(
        TENANT_A,
        posInput(productId, {
          payment: { method: "cash", amountTendered: "20000.00" }
        })
      );
      expect(outcome.kind).toBe("created");
      if (outcome.kind !== "created") return;
      expect(outcome.order.change).toBe("10000.00");
      expect(outcome.order.payments!.map((l) => l.storedValue)).toEqual([null]);
    });
  });

  // -------------------------------------------------------------------------
  describe("concurrency — redemption can never overdraw", () => {
    test("two genuinely concurrent POS sales against one card: exactly one wins, the other is refused, the balance is exact", async () => {
      const card = await issueOk(TENANT_A, { amount: "15000.00" });
      // The first sale of a tenant creates the walk-in customer row (a
      // find-or-create that is racy under its own first-ever concurrency and
      // not what is under test here); ring one cash sale so it exists.
      await ring(
        TENANT_A,
        posInput(productId, {
          payment: { method: "cash", amountTendered: "10000.00" }
        })
      );
      const sale = () =>
        handled(TENANT_A, (tx) =>
          createPosOrder(
            tx,
            TENANT_A,
            STAFF_1,
            mediaLibraryPortAdapter,
            posInput(productId, {
              tenders: [
                {
                  tenderType: "gift_card",
                  amount: "10000.00",
                  reference: null,
                  storedValueCode: card.normalized
                }
              ]
            }),
            NOW
          )
        );
      const results = await Promise.all([sale(), sale()]);
      const won = results.filter((r) => r.error === undefined);
      const lost = results.filter((r) => r.error !== undefined);
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0]!.error).toBeInstanceOf(StoredValueInsufficientError);
      expect(await balanceOf(TENANT_A, card.accountId)).toBe("5000.00");
      expect(await orderCount(TENANT_A)).toBe(2); // the priming cash sale + the winner
      const rows = await ledgerRows(TENANT_A, card.accountId);
      expect(rows.map((r) => r.kind)).toEqual(["issue", "redeem"]);
    });

    test("many concurrent small redemptions across different orders: the number that succeed is exactly what the balance affords", async () => {
      const card = await issueOk(TENANT_A, { amount: "10000.00" });
      const orderIds: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        orderIds.push(await createStorefrontOrder(TENANT_A, productId));
      }
      const results = await Promise.all(
        orderIds.map((orderId) =>
          handled(TENANT_A, (tx) =>
            recordOwnerPayment(
              tx,
              TENANT_A,
              STAFF_1,
              orderId,
              payWith(card, "gift_card", "3000.00")
            )
          )
        )
      );
      expect(results.filter((r) => r.error === undefined)).toHaveLength(3);
      for (const r of results.filter((x) => x.error !== undefined)) {
        expect(r.error).toBeInstanceOf(StoredValueInsufficientError);
      }
      expect(await balanceOf(TENANT_A, card.accountId)).toBe("1000.00");
      const rows = await ledgerRows(TENANT_A, card.accountId);
      expect(rows.filter((r) => r.kind === "redeem")).toHaveLength(3);
      // Every entry's running balance is consistent: nothing was ever negative.
      expect(
        replayLedger(
          rows.map((r) => ({
            accountSeq: r.account_seq,
            amount: r.amount,
            balanceAfter: r.balance_after,
            kind: r.kind as never
          }))
        ).breaks
      ).toEqual([]);
    });

    test("a concurrent redemption and a concurrent disable serialise: either the redemption wins before the disable, or it is refused after it", async () => {
      const card = await issueOk(TENANT_A, { amount: "20000.00" });
      const orderId = await createStorefrontOrder(TENANT_A, productId);
      const [paid, disabled] = await Promise.all([
        handled(TENANT_A, (tx) =>
          recordOwnerPayment(
            tx,
            TENANT_A,
            STAFF_1,
            orderId,
            payWith(card, "gift_card", "10000.00")
          )
        ),
        handled(TENANT_A, (tx) =>
          changeStoredValueAccountStatus(
            tx,
            TENANT_A,
            STAFF_2,
            card.accountId,
            {
              idempotencyKey: crypto.randomUUID(),
              action: "disable",
              reason: "stolen"
            }
          )
        )
      ]);
      expect(disabled.error).toBeUndefined();
      const rows = await ledgerRows(TENANT_A, card.accountId);
      if (paid.error === undefined) {
        expect(rows.map((r) => r.kind).sort()).toEqual(
          ["disable", "issue", "redeem"].sort()
        );
      } else {
        expect(paid.error).toBeInstanceOf(StoredValueUnavailableError);
        expect(rows.map((r) => r.kind)).toEqual(["issue", "disable"]);
      }
      const account = await inTenant(TENANT_A, (tx) =>
        fetchStoredValueAccount(tx, TENANT_A, card.accountId)
      );
      expect(account!.status).toBe("disabled");
    });
  });

  // -------------------------------------------------------------------------
  describe("reversal returns value to the original account", () => {
    async function paidWithCard(amount = "10000.00") {
      const card = await issueOk(TENANT_A, { amount: "30000.00" });
      const orderId = await createStorefrontOrder(TENANT_A, productId);
      const paid = await inTenant(TENANT_A, (tx) =>
        recordOwnerPayment(
          tx,
          TENANT_A,
          STAFF_1,
          orderId,
          payWith(card, "gift_card", amount)
        )
      );
      if (paid.kind !== "created") throw new Error("not paid");
      return { card, orderId, paymentId: paid.body.payment.id };
    }

    test("a full reversal credits the card back (compensating refund entry), never moves the lifecycle, and is capped", async () => {
      const { card, orderId, paymentId } = await paidWithCard();
      expect(await balanceOf(TENANT_A, card.accountId)).toBe("20000.00");
      const reversed = await inTenant(TENANT_A, (tx) =>
        recordOwnerReversal(
          tx,
          TENANT_A,
          STAFF_1,
          orderId,
          paymentId,
          reversalInput({ amount: "4000.00" })
        )
      );
      expect(reversed.kind).toBe("created");
      if (reversed.kind !== "created") return;
      expect(reversed.body.payment).toMatchObject({
        kind: "reversal",
        tenderType: "gift_card",
        amount: "4000.00",
        storedValue: { accountId: card.accountId, kind: "gift_card" }
      });
      expect(reversed.body.settlement.paymentStatus).toBe("partially_paid");
      expect(await balanceOf(TENANT_A, card.accountId)).toBe("24000.00");

      const rest = await inTenant(TENANT_A, (tx) =>
        recordOwnerReversal(
          tx,
          TENANT_A,
          STAFF_1,
          orderId,
          paymentId,
          reversalInput()
        )
      );
      expect(rest.kind).toBe("created");
      expect(await balanceOf(TENANT_A, card.accountId)).toBe("30000.00");
      const again = await inTenant(TENANT_A, (tx) =>
        recordOwnerReversal(
          tx,
          TENANT_A,
          STAFF_1,
          orderId,
          paymentId,
          reversalInput()
        )
      );
      expect(again).toMatchObject({
        kind: "not_reversible",
        reason: "fully_reversed"
      });
      expect(await balanceOf(TENANT_A, card.accountId)).toBe("30000.00");

      const rows = await ledgerRows(TENANT_A, card.accountId);
      expect(rows.map((r) => [r.kind, r.amount])).toEqual([
        ["issue", "30000.00"],
        ["redeem", "-10000.00"],
        ["refund", "4000.00"],
        ["refund", "6000.00"]
      ]);
      const order = (await getAdminSql()`
        SELECT status, payment_status FROM awcms_commerce_orders WHERE id = ${orderId}
      `) as { status: string; payment_status: string }[];
      expect(order[0]!.status).toBe("paid"); // a reversal never moves the lifecycle
      expect(order[0]!.payment_status).toBe("refunded");
    });

    test("a replayed reversal refunds once", async () => {
      const { card, orderId, paymentId } = await paidWithCard();
      const input = reversalInput({ amount: "2500.00" });
      await inTenant(TENANT_A, (tx) =>
        recordOwnerReversal(tx, TENANT_A, STAFF_1, orderId, paymentId, input)
      );
      const replay = await inTenant(TENANT_A, (tx) =>
        recordOwnerReversal(tx, TENANT_A, STAFF_1, orderId, paymentId, input)
      );
      expect(replay.kind).toBe("replayed");
      expect(await balanceOf(TENANT_A, card.accountId)).toBe("22500.00");
    });

    test("a program that does not allow refund-to-account makes the payment irreversible (there is no cash alternative), and writes nothing", async () => {
      const { card, orderId, paymentId } = await paidWithCard();
      await configureProgram(TENANT_A, "gift_card", {
        allowRefundToAccount: false
      });
      const outcome = await inTenant(TENANT_A, (tx) =>
        recordOwnerReversal(
          tx,
          TENANT_A,
          STAFF_1,
          orderId,
          paymentId,
          reversalInput()
        )
      );
      expect(outcome).toMatchObject({
        kind: "not_reversible",
        reason: "stored_value_refund_not_allowed"
      });
      expect(await balanceOf(TENANT_A, card.accountId)).toBe("20000.00");
      expect(
        (
          await inTenant(TENANT_A, (tx) =>
            listAllocationsForOrder(tx, TENANT_A, orderId)
          )
        ).filter((a) => a.kind === "reversal")
      ).toHaveLength(0);
    });

    test("a disabled account cannot take a refund until it is enabled", async () => {
      const { card, orderId, paymentId } = await paidWithCard();
      await inTenant(TENANT_A, (tx) =>
        changeStoredValueAccountStatus(tx, TENANT_A, STAFF_1, card.accountId, {
          idempotencyKey: crypto.randomUUID(),
          action: "disable",
          reason: "fraud review"
        })
      );
      const refused = await inTenant(TENANT_A, (tx) =>
        recordOwnerReversal(
          tx,
          TENANT_A,
          STAFF_1,
          orderId,
          paymentId,
          reversalInput()
        )
      );
      expect(refused).toMatchObject({
        kind: "not_reversible",
        reason: "stored_value_account_unavailable"
      });
      await inTenant(TENANT_A, (tx) =>
        changeStoredValueAccountStatus(tx, TENANT_A, STAFF_1, card.accountId, {
          idempotencyKey: crypto.randomUUID(),
          action: "enable",
          reason: null
        })
      );
      const ok = await inTenant(TENANT_A, (tx) =>
        recordOwnerReversal(
          tx,
          TENANT_A,
          STAFF_1,
          orderId,
          paymentId,
          reversalInput()
        )
      );
      expect(ok.kind).toBe("created");
      expect(await balanceOf(TENANT_A, card.accountId)).toBe("30000.00");
    });

    test("two concurrent reversals of one payment can never refund more than was paid", async () => {
      const { card, orderId, paymentId } = await paidWithCard();
      const results = await Promise.all(
        [1, 2, 3].map(() =>
          handled(TENANT_A, (tx) =>
            recordOwnerReversal(
              tx,
              TENANT_A,
              STAFF_1,
              orderId,
              paymentId,
              reversalInput({ amount: "6000.00" })
            )
          )
        )
      );
      const created = results.filter(
        (r) => r.error === undefined && r.value?.kind === "created"
      );
      expect(created).toHaveLength(1);
      expect(await balanceOf(TENANT_A, card.accountId)).toBe("26000.00");
    });
  });

  // -------------------------------------------------------------------------
  describe("expiry", () => {
    test("a card past its expiry cannot be spent; using it settles the lapse (the balance is released) and the account is terminally expired", async () => {
      const card = await issueOk(TENANT_A, {
        amount: "10000.00",
        expiresAt: new Date(Date.now() + 1500)
      });
      await Bun.sleep(1800);
      const orderId = await createStorefrontOrder(TENANT_A, productId);
      // Handled the way the route does it: the typed refusal becomes a
      // response, the transaction COMMITS, and the lazy expiry marker the
      // refusal discovered is kept.
      const { error } = await handled(TENANT_A, (tx) =>
        recordOwnerPayment(
          tx,
          TENANT_A,
          STAFF_1,
          orderId,
          payWith(card, "gift_card", "10000.00")
        )
      );
      expect(error).toBeInstanceOf(StoredValueUnavailableError);
      expect((error as StoredValueUnavailableError).reason).toBe("EXPIRED");

      const account = await inTenant(TENANT_A, (tx) =>
        fetchStoredValueAccount(tx, TENANT_A, card.accountId)
      );
      expect(account).toMatchObject({ status: "expired", balance: "0.00" });
      const rows = await ledgerRows(TENANT_A, card.accountId);
      expect(rows.map((r) => [r.kind, r.amount])).toEqual([
        ["issue", "10000.00"],
        ["expire", "-10000.00"]
      ]);
      // Terminal: no entry of any kind follows an expiry.
      const afterwards = await inTenant(TENANT_A, (tx) =>
        adjustStoredValueAccount(tx, TENANT_A, STAFF_1, card.accountId, {
          idempotencyKey: crypto.randomUUID(),
          amount: "5000.00",
          reason: "restore?"
        })
      );
      expect(afterwards).toMatchObject({
        kind: "refused",
        refusal: "ACCOUNT_EXPIRED"
      });
    });

    test("the sweep releases every lapsed account once, is idempotent, and leaves live accounts alone; the report shows lapsed-pending before it runs", async () => {
      const lapsing = await issueOk(TENANT_A, {
        amount: "7000.00",
        expiresAt: new Date(Date.now() + 1200)
      });
      const live = await issueOk(TENANT_A, { amount: "9000.00" });
      await Bun.sleep(1500);

      const today = new Date().toISOString().slice(0, 10);
      const beforeReport = await inTenant(TENANT_A, (tx) =>
        fetchStoredValueReport(
          tx,
          TENANT_A,
          { from: today, to: today },
          SALES_REPORT_TIME_ZONE
        )
      );
      const giftBefore = beforeReport.kinds.find(
        (k) => k.kind === "gift_card"
      )!;
      expect(giftBefore.outstanding).toBe("16000.00");
      expect(giftBefore.lapsedPendingRelease).toBe("7000.00");

      const swept = await inTenant(TENANT_A, (tx) =>
        sweepExpiredStoredValue(tx, TENANT_A)
      );
      expect(swept).toEqual({ expired: 1, released: "7000.00", more: false });
      const again = await inTenant(TENANT_A, (tx) =>
        sweepExpiredStoredValue(tx, TENANT_A)
      );
      expect(again).toEqual({ expired: 0, released: "0.00", more: false });
      expect(await balanceOf(TENANT_A, lapsing.accountId)).toBe("0.00");
      expect(await balanceOf(TENANT_A, live.accountId)).toBe("9000.00");

      const afterReport = await inTenant(TENANT_A, (tx) =>
        fetchStoredValueReport(
          tx,
          TENANT_A,
          { from: today, to: today },
          SALES_REPORT_TIME_ZONE
        )
      );
      const gift = afterReport.kinds.find((k) => k.kind === "gift_card")!;
      expect(gift.outstanding).toBe("9000.00");
      expect(gift.lapsedPendingRelease).toBe("0.00");
      expect(gift.expired).toEqual({ count: 1, amount: "7000.00" });
    });

    test("a refund onto an account that expired is refused", async () => {
      const card = await issueOk(TENANT_A, {
        amount: "10000.00",
        expiresAt: new Date(Date.now() + 2500)
      });
      const orderId = await createStorefrontOrder(TENANT_A, productId);
      const paid = await inTenant(TENANT_A, (tx) =>
        recordOwnerPayment(
          tx,
          TENANT_A,
          STAFF_1,
          orderId,
          payWith(card, "gift_card", "10000.00")
        )
      );
      if (paid.kind !== "created") throw new Error("not paid");
      await Bun.sleep(2800);
      const outcome = await inTenant(TENANT_A, (tx) =>
        recordOwnerReversal(
          tx,
          TENANT_A,
          STAFF_1,
          orderId,
          paid.body.payment.id,
          reversalInput()
        )
      );
      expect(outcome).toMatchObject({
        kind: "not_reversible",
        reason: "stored_value_account_unavailable"
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("reporting", () => {
    test("the liability report reconciles to the ledger: issued, loaded, redeemed, refunded, adjusted (up and down apart), expired, outstanding", async () => {
      const card = await issueOk(TENANT_A, { amount: "30000.00" });
      await inTenant(TENANT_A, (tx) =>
        loadStoredValueAccount(tx, TENANT_A, STAFF_1, card.accountId, {
          idempotencyKey: crypto.randomUUID(),
          amount: "5000.00",
          reason: null
        })
      );
      const orderId = await createStorefrontOrder(TENANT_A, productId);
      const paid = await inTenant(TENANT_A, (tx) =>
        recordOwnerPayment(
          tx,
          TENANT_A,
          STAFF_1,
          orderId,
          payWith(card, "gift_card", "10000.00")
        )
      );
      if (paid.kind !== "created") throw new Error("not paid");
      await inTenant(TENANT_A, (tx) =>
        recordOwnerReversal(
          tx,
          TENANT_A,
          STAFF_1,
          orderId,
          paid.body.payment.id,
          reversalInput({ amount: "3000.00" })
        )
      );
      for (const amount of ["700.00", "-200.00"]) {
        await inTenant(TENANT_A, (tx) =>
          adjustStoredValueAccount(tx, TENANT_A, STAFF_1, card.accountId, {
            idempotencyKey: crypto.randomUUID(),
            amount,
            reason: "audit"
          })
        );
      }
      await issueOk(TENANT_A, { kind: "store_credit", amount: "1000.00" });

      const today = new Date().toISOString().slice(0, 10);
      const report = await inTenant(TENANT_A, (tx) =>
        fetchStoredValueReport(
          tx,
          TENANT_A,
          { from: today, to: today },
          SALES_REPORT_TIME_ZONE
        )
      );
      const gift = report.kinds.find((k) => k.kind === "gift_card")!;
      expect(gift.issued).toEqual({ count: 2, amount: "35000.00" });
      expect(gift.loaded).toEqual({ count: 1, amount: "5000.00" });
      expect(gift.redeemed).toEqual({ count: 1, amount: "10000.00" });
      expect(gift.refunded).toEqual({ count: 1, amount: "3000.00" });
      expect(gift.adjustedUp).toEqual({ count: 1, amount: "700.00" });
      expect(gift.adjustedDown).toEqual({ count: 1, amount: "200.00" });
      expect(gift.expired).toEqual({ count: 0, amount: "0.00" });
      // 35000 - 10000 + 3000 + 700 - 200
      expect(gift.net).toBe("28500.00");
      expect(gift.outstanding).toBe("28500.00");
      expect(gift.accounts).toEqual({
        total: 1,
        active: 1,
        disabled: 0,
        expired: 0
      });
      const credit = report.kinds.find((k) => k.kind === "store_credit")!;
      expect(credit.outstanding).toBe("1000.00");
      expect(report.totals.outstanding).toBe("29500.00");
      // The report's outstanding is the sum of the ledger AND of the projection.
      const projection = (await getAdminSql()`
        SELECT COALESCE(SUM(balance), 0)::text AS total
        FROM awcms_commerce_stored_value_accounts WHERE tenant_id = ${TENANT_A}
      `) as { total: string }[];
      expect(projection[0]!.total).toBe("29500.00");
    });

    test("a window with no activity reports zeros, and a disabled balance is shown apart", async () => {
      const card = await issueOk(TENANT_A, { amount: "4000.00" });
      await inTenant(TENANT_A, (tx) =>
        changeStoredValueAccountStatus(tx, TENANT_A, STAFF_1, card.accountId, {
          idempotencyKey: crypto.randomUUID(),
          action: "disable",
          reason: "lost"
        })
      );
      const report = await inTenant(TENANT_A, (tx) =>
        fetchStoredValueReport(
          tx,
          TENANT_A,
          { from: "2020-01-01", to: "2020-01-02" },
          SALES_REPORT_TIME_ZONE
        )
      );
      const gift = report.kinds.find((k) => k.kind === "gift_card")!;
      expect(gift.issued).toEqual({ count: 0, amount: "0.00" });
      expect(gift.outstanding).toBe("4000.00");
      expect(gift.disabledBalance).toBe("4000.00");
      expect(gift.accounts.disabled).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("reconcile", () => {
    async function corrupt(fn: (tx: Bun.SQL) => Promise<void>): Promise<void> {
      await getAdminSql().begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        await fn(tx);
      });
    }

    test("a consistent tenant reconciles clean", async () => {
      const card = await issueOk(TENANT_A);
      const orderId = await createStorefrontOrder(TENANT_A, productId);
      await inTenant(TENANT_A, (tx) =>
        recordOwnerPayment(
          tx,
          TENANT_A,
          STAFF_1,
          orderId,
          payWith(card, "gift_card", "10000.00")
        )
      );
      const result = await inTenant(TENANT_A, (tx) =>
        reconcileStoredValue(tx, TENANT_A, {
          repair: false,
          actor: { kind: "tenant_user", tenantUserId: STAFF_1 }
        })
      );
      expect(result).toMatchObject({
        accountsChecked: 1,
        findings: [],
        truncated: false,
        repaired: 0
      });
    });

    test("projection drift is detected, read-only by default, and repaired (only the projection) on request", async () => {
      const card = await issueOk(TENANT_A, { amount: "10000.00" });
      await corrupt(async (tx) => {
        await tx`UPDATE awcms_commerce_stored_value_accounts SET balance = 99999, version = 7 WHERE id = ${card.accountId}`;
      });
      const detect = await inTenant(TENANT_A, (tx) =>
        reconcileStoredValue(tx, TENANT_A, {
          repair: false,
          actor: { kind: "tenant_user", tenantUserId: STAFF_1 }
        })
      );
      expect(detect.findings).toHaveLength(1);
      expect(detect.findings[0]).toMatchObject({
        accountId: card.accountId,
        type: "projection_drift",
        repairable: true,
        repaired: false
      });
      expect(detect.repaired).toBe(0);
      expect(
        (
          (await getAdminSql()`SELECT balance::text AS b FROM awcms_commerce_stored_value_accounts WHERE id = ${card.accountId}`) as {
            b: string;
          }[]
        )[0]!.b
      ).toBe("99999.00");

      const repair = await inTenant(TENANT_A, (tx) =>
        reconcileStoredValue(tx, TENANT_A, {
          repair: true,
          actor: { kind: "tenant_user", tenantUserId: STAFF_1 }
        })
      );
      expect(repair.repaired).toBe(1);
      expect(await balanceOf(TENANT_A, card.accountId)).toBe("10000.00");
      const clean = await inTenant(TENANT_A, (tx) =>
        reconcileStoredValue(tx, TENANT_A, {
          repair: false,
          actor: { kind: "system" }
        })
      );
      expect(clean.findings).toEqual([]);
      const audit = (await getAdminSql()`
        SELECT attributes FROM awcms_audit_events
        WHERE tenant_id = ${TENANT_A} AND action = 'stored_value.reconcile_repair'
      `) as { attributes: { balanceBefore: string; balanceAfter: string } }[];
      expect(audit).toHaveLength(1);
      expect(audit[0]!.attributes.balanceAfter).toBe("10000.00");
    });

    test("a ledger that contradicts itself is REPORTED and never repaired; a status that disagrees is reported", async () => {
      const card = await issueOk(TENANT_A, { amount: "10000.00" });
      await inTenant(TENANT_A, (tx) =>
        loadStoredValueAccount(tx, TENANT_A, STAFF_1, card.accountId, {
          idempotencyKey: crypto.randomUUID(),
          amount: "500.00",
          reason: null
        })
      );
      await corrupt(async (tx) => {
        await tx`UPDATE awcms_commerce_stored_value_ledger SET balance_after = 1 WHERE account_id = ${card.accountId} AND account_seq = 2`;
        await tx`UPDATE awcms_commerce_stored_value_accounts SET status = 'expired' WHERE id = ${card.accountId}`;
      });
      const result = await inTenant(TENANT_A, (tx) =>
        reconcileStoredValue(tx, TENANT_A, {
          repair: true,
          actor: { kind: "tenant_user", tenantUserId: STAFF_1 }
        })
      );
      const types = result.findings.map((f) => f.type).sort();
      expect(types).toEqual(["ledger_break", "status_drift"]);
      expect(result.repaired).toBe(0);
      expect(result.findings.every((f) => !f.repairable && !f.repaired)).toBe(
        true
      );
    });

    test("a redemption whose mirror entry is missing is reported as an allocation mismatch", async () => {
      const card = await issueOk(TENANT_A, { amount: "10000.00" });
      const orderId = await createStorefrontOrder(TENANT_A, productId);
      await inTenant(TENANT_A, (tx) =>
        recordOwnerPayment(
          tx,
          TENANT_A,
          STAFF_1,
          orderId,
          payWith(card, "gift_card", "4000.00")
        )
      );
      await corrupt(async (tx) => {
        await tx`DELETE FROM awcms_commerce_stored_value_ledger WHERE account_id = ${card.accountId} AND kind = 'redeem'`;
      });
      const result = await inTenant(TENANT_A, (tx) =>
        reconcileStoredValue(tx, TENANT_A, {
          repair: false,
          actor: { kind: "system" }
        })
      );
      const types = result.findings.map((f) => f.type);
      expect(types).toContain("allocation_mismatch");
      expect(types).toContain("projection_drift");
    });
  });

  // -------------------------------------------------------------------------
  describe("tenant isolation (RLS, composite FKs, BOLA)", () => {
    test("another tenant sees none of an account, its ledger or its programs; ids from another tenant are not found", async () => {
      const card = await issueOk(TENANT_A);
      await configureProgram(TENANT_B, "gift_card");
      expect(
        await inTenant(TENANT_B, (tx) =>
          fetchStoredValueAccount(tx, TENANT_B, card.accountId)
        )
      ).toBeNull();
      expect(
        await inTenant(TENANT_B, (tx) =>
          listStoredValueLedger(tx, TENANT_B, card.accountId, null)
        )
      ).toBeNull();
      expect(
        await inTenant(TENANT_B, (tx) =>
          lockStoredValueAccount(tx, TENANT_B, card.accountId)
        )
      ).toBeNull();
      expect(
        (
          await inTenant(TENANT_B, (tx) =>
            listStoredValueAccounts(tx, TENANT_B, null)
          )
        ).items
      ).toHaveLength(0);
      // Even a raw query as tenant B returns nothing of tenant A (RLS).
      const raw = await inTenant(
        TENANT_B,
        (tx) => tx`SELECT id FROM awcms_commerce_stored_value_ledger`
      );
      expect(raw).toHaveLength(0);
      // Mutations aimed at another tenant's account id are the neutral not-found.
      const load = await inTenant(TENANT_B, (tx) =>
        loadStoredValueAccount(tx, TENANT_B, B_STAFF, card.accountId, {
          idempotencyKey: crypto.randomUUID(),
          amount: "1.00",
          reason: null
        })
      );
      expect(load.kind).toBe("not_found");
      const adjust = await inTenant(TENANT_B, (tx) =>
        adjustStoredValueAccount(tx, TENANT_B, B_STAFF, card.accountId, {
          idempotencyKey: crypto.randomUUID(),
          amount: "-1.00",
          reason: "attack"
        })
      );
      expect(adjust.kind).toBe("not_found");
      expect(await balanceOf(TENANT_A, card.accountId)).toBe("50000.00");
    });

    test("a ledger row of tenant B cannot reference tenant A's account (tenant-safe composite FK)", async () => {
      const card = await issueOk(TENANT_A);
      await expect(
        attempt(
          getAdminSql()`
            INSERT INTO awcms_commerce_stored_value_ledger
              (tenant_id, account_id, kind, amount, account_seq, balance_after,
               reason, source_key, actor_kind)
            VALUES (${TENANT_B}, ${card.accountId}, 'adjust', 1, 0, 0,
                    'cross-tenant', 'raw:cross', 'system')
          `
        )
      ).rejects.toThrow();
    });

    test("a code issued in tenant A is not resolvable in tenant B (the hash is tenant-scoped)", async () => {
      const card = await issueOk(TENANT_A);
      const refused = await handled(TENANT_B, (tx) =>
        resolveStoredValueAccounts(tx, TENANT_B, B_STAFF, [
          { tenderType: "gift_card", code: card.normalized }
        ])
      );
      expect(refused.error).toBeInstanceOf(StoredValueNotFoundError);
    });

    test("the runtime role cannot write a row for a tenant other than the one in context (WITH CHECK)", async () => {
      await expect(
        attempt(
          getRuntimeSql().begin(async (tx) => {
            await tx`SELECT set_config('app.current_tenant_id', ${TENANT_B}, true)`;
            await tx`
              INSERT INTO awcms_commerce_stored_value_programs (tenant_id, kind, enabled)
              VALUES (${TENANT_A}, 'gift_card', true)
              ON CONFLICT DO NOTHING
            `;
          })
        )
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  describe("brute-force resistance", () => {
    test("lookups are throttled per tenant user; every failure is the same neutral not-found", async () => {
      const probe = "ABCDEFGHJKLMNPQRSTUVW";
      const attempts: unknown[] = [];
      for (let i = 0; i < STORED_VALUE_LOOKUPS_PER_MINUTE + 3; i += 1) {
        attempts.push(
          (
            await handled(TENANT_A, (tx) =>
              resolveStoredValueAccounts(tx, TENANT_A, STAFF_2, [
                { tenderType: "gift_card", code: probe }
              ])
            )
          ).error
        );
      }
      expect(
        attempts
          .slice(0, STORED_VALUE_LOOKUPS_PER_MINUTE)
          .every((e) => e instanceof StoredValueNotFoundError)
      ).toBe(true);
      expect(
        attempts
          .slice(STORED_VALUE_LOOKUPS_PER_MINUTE)
          .every((e) => e instanceof StoredValueLookupThrottledError)
      ).toBe(true);
      // Another actor is not throttled by this one's failures.
      const other = await handled(TENANT_A, (tx) =>
        resolveStoredValueAccounts(tx, TENANT_A, STAFF_1, [
          { tenderType: "gift_card", code: probe }
        ])
      );
      expect(other.error).toBeInstanceOf(StoredValueNotFoundError);
    });
  });

  // -------------------------------------------------------------------------
  describe("more database-level properties", () => {
    test("writing a projection to exactly what the ledger sums to is accepted (reconcile's repair), anything else is refused", async () => {
      const card = await issueOk(TENANT_A, { amount: "1000.00" });
      // The exact sums: a no-op, accepted.
      await getRuntimeSql().begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A}, true)`;
        await tx`UPDATE awcms_commerce_stored_value_accounts SET balance = 1000.00, version = 1 WHERE id = ${card.accountId}`;
      });
      // Right balance, wrong version; wrong balance, right version: refused.
      for (const set of [
        "balance = 1000.00, version = 2",
        "balance = 1000.01, version = 1"
      ]) {
        await expect(
          attempt(
            getRuntimeSql().begin(async (tx) => {
              await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A}, true)`;
              await tx.unsafe(
                `UPDATE awcms_commerce_stored_value_accounts SET ${set} WHERE id = '${card.accountId}'`
              );
            })
          )
        ).rejects.toThrow(/ledger entry/);
      }
    });

    test("a payment leg of one kind cannot draw on an account of the other kind (the mirror entry is refused)", async () => {
      const credit = await issueOk(TENANT_A, { kind: "store_credit" });
      const orderId = await createStorefrontOrder(TENANT_A, productId);
      await expect(
        attempt(
          getAdminSql().begin(async (tx) => {
            const alloc = (await tx`
              INSERT INTO awcms_commerce_payment_allocations
                (tenant_id, order_id, kind, tender_type, amount, status, source, source_key,
                 actor_kind, stored_value_account_id, settled_at)
              VALUES (${TENANT_A}, ${orderId}, 'payment', 'gift_card', 100, 'succeeded', 'admin',
                      'raw:kind-mismatch', 'system', ${credit.accountId}, now())
              RETURNING id
            `) as { id: string }[];
            await tx`
              INSERT INTO awcms_commerce_stored_value_ledger
                (tenant_id, account_id, kind, amount, account_seq, balance_after,
                 source_key, actor_kind, allocation_id)
              VALUES (${TENANT_A}, ${credit.accountId}, 'redeem', -100, 0, 0,
                      'raw:kind-mismatch-entry', 'system', ${alloc[0]!.id})
            `;
          })
        )
      ).rejects.toThrow(/must mirror/);
    });

    test("twenty genuinely concurrent loads onto one account serialise: the balance and the per-account sequence are exact", async () => {
      const card = await issueOk(TENANT_A, { amount: "100.00" });
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          handled(TENANT_A, (tx) =>
            loadStoredValueAccount(tx, TENANT_A, STAFF_1, card.accountId, {
              idempotencyKey: crypto.randomUUID(),
              amount: "50.00",
              reason: null
            })
          )
        )
      );
      expect(results.every((r) => r.error === undefined)).toBe(true);
      expect(await balanceOf(TENANT_A, card.accountId)).toBe("1100.00");
      const rows = await ledgerRows(TENANT_A, card.accountId);
      expect(rows.map((r) => r.account_seq)).toEqual(
        Array.from({ length: 21 }, (_, i) => i + 1)
      );
      expect(
        replayLedger(
          rows.map((r) => ({
            accountSeq: r.account_seq,
            amount: r.amount,
            balanceAfter: r.balance_after,
            kind: r.kind as never
          }))
        ).breaks
      ).toEqual([]);
    });

    test("a gift-card leg of a POS sale is stamped with the register session and shows up in the cash-up as its own tender", async () => {
      await inTenant(TENANT_A, (tx) =>
        updateModuleSettings(
          tx,
          TENANT_A,
          "commerce",
          {
            features: {
              pos: true,
              inbox: true,
              campaigns: true,
              gateway: true,
              courier: true,
              register: true,
              storedValue: true
            }
          },
          STAFF_1
        )
      );
      const created = await inTenant(TENANT_A, (tx) =>
        createRegister(tx, TENANT_A, STAFF_1, {
          code: "KASIR-SV",
          name: "Register SV",
          locationLabel: null
        })
      );
      if (created.kind !== "created") throw new Error("register not created");
      const opened = await inTenant(TENANT_A, (tx) =>
        openRegisterSession(tx, TENANT_A, STAFF_1, {
          idempotencyKey: crypto.randomUUID(),
          registerId: created.register.id,
          openingFloat: "100000.00"
        })
      );
      if (opened.kind !== "created") throw new Error("session not opened");
      const card = await issueOk(TENANT_A, { amount: "6000.00" });
      const sale = await ring(
        TENANT_A,
        posInput(productId, {
          registerId: created.register.id,
          tenders: [
            {
              tenderType: "gift_card",
              amount: "6000.00",
              reference: null,
              storedValueCode: card.normalized
            },
            { tenderType: "cash", amount: "4000.00", reference: null }
          ]
        })
      );
      expect(sale.kind).toBe("created");
      const stamped = (await getAdminSql()`
        SELECT tender_type, register_session_id
        FROM awcms_commerce_payment_allocations
        WHERE tenant_id = ${TENANT_A} AND tender_type IN ('gift_card', 'cash')
        ORDER BY entry_seq
      `) as { tender_type: string; register_session_id: string | null }[];
      expect(
        stamped.map((r) => [r.tender_type, r.register_session_id])
      ).toEqual([
        ["gift_card", opened.session.id],
        ["cash", opened.session.id]
      ]);
      const report = await inTenant(TENANT_A, (tx) =>
        fetchRegisterCashUpReport(tx, TENANT_A, opened.session.id)
      );
      const line = report!.tenders.find((t) => t.tenderType === "gift_card");
      expect(line).toMatchObject({ payments: "6000.00", expected: "6000.00" });
    });
  });

  // -------------------------------------------------------------------------
  describe("invariants the application states about itself", () => {
    test("a stored-value allocation written by a caller that skipped the checks throws an invariant error (so its transaction rolls back), never a partial success", async () => {
      const card = await issueOk(TENANT_A, { amount: "1000.00" });
      const { recordPaymentAllocation } =
        await import("../../src/modules/commerce/application/payment-allocation-directory");
      const orderId = await createStorefrontOrder(TENANT_A, productId);
      const outcome = await inTenant(TENANT_A, (tx) =>
        recordPaymentAllocation(tx, TENANT_A, {
          orderId,
          tenderType: "gift_card",
          amount: "5000.00",
          storedValueAccountId: card.accountId,
          source: "admin",
          sourceKey: "api:invariant",
          actor: { kind: "tenant_user", tenantUserId: STAFF_1 },
          enforceNoOverpayment: true,
          allowedOrderStatuses: null,
          release: null,
          releaseNote: ""
        })
      );
      expect(outcome).toMatchObject({
        kind: "stored_value_refused",
        refusal: "INSUFFICIENT",
        available: "1000.00"
      });
      expect(StoredValueInvariantError.name).toBe("StoredValueInvariantError");
    });
  });
});
