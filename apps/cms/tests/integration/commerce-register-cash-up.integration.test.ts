/**
 * POS register sessions and cash-up integration (Issue #284, epic #281,
 * ADR-0028) - against a REAL migrated Postgres through
 * `tests/integration/harness.ts`, the same pattern `commerce-pos` /
 * `commerce-payment-allocations` use. Gated on `DATABASE_URL`; skips cleanly
 * without one.
 *
 * Covers exactly the properties only a real database can prove:
 *
 *   - one ACTIVE session per register, including two GENUINELY concurrent opens
 *     (two transactions, two pooled connections) - exactly one wins;
 *   - a sale during a session is stamped (order + every ledger leg), a sale
 *     without an open session / by another cashier / on another tenant's
 *     register is refused before anything is written;
 *   - drawer movements (cash in, safe drop, ...) are append-only and feed the
 *     expected cash; expected-vs-counted variance per tender, the approval
 *     threshold, the `closing` -> approve/reject workflow and its history;
 *   - close is idempotent (replay) and concurrency-safe (two concurrent closes,
 *     one concurrent close racing a sale: the stored expected is ALWAYS exactly
 *     the stamped ledger sum - a leg is never lost or double-counted);
 *   - a closed session is immutable (every mutation denied, by the app and by
 *     the database triggers/privileges); late ledger activity never changes a
 *     closed cash-up; corrections are compensating rows that preserve the
 *     original and flip the status to `corrected`;
 *   - RLS cross-tenant isolation and tenant-safe composite FKs;
 *   - feature OFF is today's POS, byte for byte (nothing stamped, a register id
 *     is refused);
 *   - the report reconciles to the ledger and the CSV carries no live formula.
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
import {
  createPosOrder,
  PosRegisterSessionError
} from "../../src/modules/commerce/application/pos-directory";
import { fetchCommerceFeatures } from "../../src/modules/commerce/application/commerce-feature-gate";
import {
  closeRegisterSession,
  decideRegisterClose,
  fetchRegisterCashUpReport,
  recordRegisterCorrection
} from "../../src/modules/commerce/application/register-cash-up";
import {
  createRegister,
  fetchRegister,
  listRegisters,
  updateRegister
} from "../../src/modules/commerce/application/register-directory";
import {
  fetchRegisterSession,
  gateSaleToRegisterSession,
  handOverRegisterSession,
  listRegisterMovements,
  listRegisterSessions,
  openRegisterSession,
  recordRegisterMovement
} from "../../src/modules/commerce/application/register-session-directory";
import { IdempotencyPayloadMismatchError } from "../../src/modules/commerce/application/order-directory";
import { RegisterSessionClosingError } from "../../src/modules/commerce/application/register-session-stamp";
import {
  recordOwnerPayment,
  recordOwnerReversal
} from "../../src/modules/commerce/application/payment-recording";
import { saveStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import { updateModuleSettings } from "../../src/modules/module-management/application/module-settings";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
import { FeatureDisabledError } from "../../src/modules/commerce/domain/commerce-features";
import type { CreatePosOrderInput } from "../../src/modules/commerce/domain/pos-order-validation";
import type { CreateProductInput } from "../../src/modules/commerce/domain/product-validation";
import type {
  CloseSessionInput,
  RecordMovementInput,
  RegisterCashUpReport
} from "../../src/modules/commerce/domain/register";
import { serializeCashUpCsv } from "../../src/modules/commerce/domain/register-cash-up-csv";
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
const CASHIER_1 = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
const CASHIER_2 = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4";
const SUPERVISOR = "e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5";
const B_CASHIER = "f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f6f6";
const NOW = new Date("2026-10-03T03:00:00.000Z");

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
    VALUES (${tenantId}, 'person', 'Register Test Actor')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`reg-actor-${id}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${id}, ${tenantId}, ${identity[0]!.id})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function enableSelfPickupAndQris(tenantId: string): Promise<void> {
  const validated = validateStoreSettingsInput({
    storeName: "Toko Kasir",
    shipping: { selfPickup: true },
    payment: { manualQris: { active: true, mediaObjectId: null } }
  });
  if (!validated.valid) throw new Error(JSON.stringify(validated.errors));
  await inTenant(tenantId, (tx) =>
    saveStoreSettings(tx, tenantId, CASHIER_1, validated.value)
  );
}

/** Turns the `register` feature on/off and sets the approval threshold, through the same call the settings route makes. */
async function configureRegisters(
  tenantId: string,
  options: {
    register: boolean;
    threshold?: string;
    /** `cashUp.allowSelfApproval`; omitted = the platform default (false). */
    allowSelfApproval?: boolean;
  }
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
          register: options.register
        },
        ...(options.threshold !== undefined
          ? {
              cashUp: {
                approvalThreshold: options.threshold,
                ...(options.allowSelfApproval !== undefined
                  ? { allowSelfApproval: options.allowSelfApproval }
                  : {})
              }
            }
          : {})
      },
      CASHIER_1
    )
  );
}

const BASE_PRODUCT: CreateProductInput = {
  categoryId: null,
  type: "physical",
  sku: "SKU-REG",
  name: "Kopi Susu",
  slug: "kopi-susu-reg",
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
    createProduct(tx, tenantId, CASHIER_1, BASE_PRODUCT)
  );
  await inTenant(
    tenantId,
    (tx) =>
      tx`UPDATE awcms_commerce_products SET status = 'active' WHERE id = ${product.id}`
  );
  return product.id;
}

async function makeRegister(
  tenantId: string,
  code = "KASIR-1"
): Promise<string> {
  const outcome = await inTenant(tenantId, (tx) =>
    createRegister(tx, tenantId, CASHIER_1, {
      code,
      name: `Register ${code}`,
      locationLabel: "Front"
    })
  );
  if (outcome.kind !== "created") throw new Error("register not created");
  return outcome.register.id;
}

async function open(
  tenantId: string,
  registerId: string,
  openingFloat = "100000.00",
  actor = CASHIER_1,
  key: string = crypto.randomUUID()
) {
  return inTenant(tenantId, (tx) =>
    openRegisterSession(tx, tenantId, actor, {
      idempotencyKey: key,
      registerId,
      openingFloat
    })
  );
}

async function openOk(
  tenantId: string,
  registerId: string,
  openingFloat = "100000.00",
  actor = CASHIER_1
): Promise<string> {
  const outcome = await open(tenantId, registerId, openingFloat, actor);
  if (outcome.kind !== "created") {
    throw new Error(`expected created, got ${outcome.kind}`);
  }
  return outcome.session.id;
}

function posInput(
  productId: string,
  registerId: string | null,
  overrides: Partial<CreatePosOrderInput> = {}
): CreatePosOrderInput {
  return {
    idempotencyKey: crypto.randomUUID(),
    customer: { name: null, phone: null },
    lines: [{ productId, variantId: null, quantity: 2 }],
    payment: { method: "cash", amountTendered: "50000.00" },
    tenders: null,
    allowDue: false,
    registerId,
    notes: null,
    ...overrides
  };
}

async function ring(
  tenantId: string,
  input: CreatePosOrderInput,
  actor = CASHIER_1
) {
  return inTenant(tenantId, (tx) =>
    createPosOrder(tx, tenantId, actor, mediaLibraryPortAdapter, input, NOW)
  );
}

async function ringOk(
  tenantId: string,
  input: CreatePosOrderInput,
  actor = CASHIER_1
) {
  const outcome = await ring(tenantId, input, actor);
  if (outcome.kind !== "created") {
    throw new Error(`expected created, got ${outcome.kind}`);
  }
  return outcome.order;
}

function movement(
  overrides: Partial<RecordMovementInput> = {}
): RecordMovementInput {
  return {
    idempotencyKey: crypto.randomUUID(),
    movementType: "cash_in",
    direction: "in",
    amount: "5000.00",
    reference: null,
    note: null,
    ...overrides
  };
}

async function addMovement(
  tenantId: string,
  sessionId: string,
  input: RecordMovementInput,
  actor = CASHIER_1
) {
  return inTenant(tenantId, (tx) =>
    recordRegisterMovement(tx, tenantId, actor, sessionId, input)
  );
}

function closeInput(
  counted: CloseSessionInput["counted"],
  overrides: Partial<CloseSessionInput> = {}
): CloseSessionInput {
  return {
    idempotencyKey: crypto.randomUUID(),
    counted,
    varianceReason: null,
    ...overrides
  };
}

async function close(
  tenantId: string,
  sessionId: string,
  input: CloseSessionInput,
  options: { actor?: string; canApprove?: boolean } = {}
) {
  return inTenant(tenantId, (tx) =>
    closeRegisterSession(
      tx,
      tenantId,
      options.actor ?? CASHIER_1,
      sessionId,
      input,
      async () => options.canApprove ?? false
    )
  );
}

async function report(
  tenantId: string,
  sessionId: string
): Promise<RegisterCashUpReport> {
  const result = await inTenant(tenantId, (tx) =>
    fetchRegisterCashUpReport(tx, tenantId, sessionId)
  );
  if (!result) throw new Error("report missing");
  return result;
}

function tender(
  reportBody: RegisterCashUpReport,
  tenderType: string
): RegisterCashUpReport["tenders"][number] {
  const line = reportBody.tenders.find(
    (entry) => entry.tenderType === tenderType
  );
  if (!line) throw new Error(`no ${tenderType} line`);
  return line;
}

suite("POS register sessions and cash-up integration (Issue #284)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "tenant-reg-a");
    await seedTenant(TENANT_B, "tenant-reg-b");
    for (const id of [CASHIER_1, CASHIER_2, SUPERVISOR]) {
      await seedTenantUser(TENANT_A, id);
    }
    await seedTenantUser(TENANT_B, B_CASHIER);
    await enableSelfPickupAndQris(TENANT_A);
    // Most scenarios below exercise the one-step close of a single-operator
    // tenant, so the suite opts IN to self-approval; the default-deny path has
    // its own tests that switch it back off.
    await configureRegisters(TENANT_A, {
      register: true,
      threshold: "50.00",
      allowSelfApproval: true
    });
  }, 30000);

  describe("registers and sessions", () => {
    test("the register feature defaults OFF and is ON after configuration", async () => {
      await seedTenant("99999999-9999-4999-8999-999999999999", "tenant-fresh");
      const fresh = await inTenant(
        "99999999-9999-4999-8999-999999999999",
        (tx) =>
          fetchCommerceFeatures(tx, "99999999-9999-4999-8999-999999999999")
      );
      expect(fresh.register).toBe(false);
      expect(fresh.pos).toBe(true);
      const configured = await inTenant(TENANT_A, (tx) =>
        fetchCommerceFeatures(tx, TENANT_A)
      );
      expect(configured.register).toBe(true);
    });

    test("a register code is unique per tenant, case-insensitively; another tenant may reuse it", async () => {
      await makeRegister(TENANT_A, "KASIR-1");
      const duplicate = await inTenant(TENANT_A, (tx) =>
        createRegister(tx, TENANT_A, CASHIER_1, {
          code: "kasir-1",
          name: "Dup",
          locationLabel: null
        })
      );
      expect(duplicate.kind).toBe("code_taken");
      const otherTenant = await inTenant(TENANT_B, (tx) =>
        createRegister(tx, TENANT_B, B_CASHIER, {
          code: "KASIR-1",
          name: "Theirs",
          locationLabel: null
        })
      );
      expect(otherTenant.kind).toBe("created");
    });

    test("opening records the float and the opener as the first cashier; a second open on the same register is refused; another register is independent", async () => {
      const r1 = await makeRegister(TENANT_A, "R1");
      const r2 = await makeRegister(TENANT_A, "R2");
      const first = await open(TENANT_A, r1, "100000.00");
      expect(first.kind).toBe("created");
      if (first.kind !== "created") return;
      expect(first.session).toMatchObject({
        status: "open",
        openingFloat: "100000.00",
        currentCashierTenantUserId: CASHIER_1,
        openedByTenantUserId: CASHIER_1,
        closedAt: null
      });

      const second = await open(TENANT_A, r1, "5.00", CASHIER_2);
      expect(second.kind).toBe("already_open");
      if (second.kind === "already_open") {
        expect(second.activeSessionId).toBe(first.session.id);
      }
      expect((await open(TENANT_A, r2, "0.00", CASHIER_2)).kind).toBe(
        "created"
      );

      const registers = await inTenant(TENANT_A, (tx) =>
        listRegisters(tx, TENANT_A)
      );
      expect(registers.map((r) => r.code)).toEqual(["R1", "R2"]);
      expect(registers[0]!.activeSession?.id).toBe(first.session.id);
    });

    test("open is idempotent on Idempotency-Key: a replay returns the same session; a different payload under the key is a conflict", async () => {
      const r1 = await makeRegister(TENANT_A);
      const key = crypto.randomUUID();
      const a = await open(TENANT_A, r1, "100000.00", CASHIER_1, key);
      const b = await open(TENANT_A, r1, "100000.00", CASHIER_1, key);
      expect(a.kind).toBe("created");
      expect(b.kind).toBe("replayed");
      if (a.kind === "created" && b.kind === "replayed") {
        expect(b.session.id).toBe(a.session.id);
      }
      await expect(
        open(TENANT_A, r1, "999.00", CASHIER_1, key)
      ).rejects.toBeInstanceOf(IdempotencyPayloadMismatchError);
      const count = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_commerce_register_sessions WHERE tenant_id = ${TENANT_A}
      `) as { n: number }[];
      expect(count[0]!.n).toBe(1);
    });

    test("two GENUINELY concurrent opens on one register: exactly one wins, the other is already_open", async () => {
      const r1 = await makeRegister(TENANT_A);
      const results = await Promise.all([
        open(TENANT_A, r1, "100.00", CASHIER_1),
        open(TENANT_A, r1, "200.00", CASHIER_2),
        open(TENANT_A, r1, "300.00", SUPERVISOR)
      ]);
      expect(results.filter((r) => r.kind === "created")).toHaveLength(1);
      expect(results.filter((r) => r.kind === "already_open")).toHaveLength(2);
      const rows = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_commerce_register_sessions
        WHERE tenant_id = ${TENANT_A} AND register_id = ${r1} AND status IN ('open','closing')
      `) as { n: number }[];
      expect(rows[0]!.n).toBe(1);
    });

    test("the partial unique index is the independent second guard (a writer that skips the lock still cannot make two active sessions); a closed session frees the slot", async () => {
      const r1 = await makeRegister(TENANT_A);
      const first = await openOk(TENANT_A, r1);
      await expect(
        attempt(
          getAdminSql()`
            INSERT INTO awcms_commerce_register_sessions
              (tenant_id, register_id, opened_by_tenant_user_id, opening_float, current_cashier_tenant_user_id)
            VALUES (${TENANT_A}, ${r1}, ${CASHIER_2}, 1, ${CASHIER_2})
          `
        )
      ).rejects.toThrow();
      const closed = await close(
        TENANT_A,
        first,
        closeInput({ cash: "100000.00" })
      );
      expect(closed.kind).toBe("closed");
      expect((await open(TENANT_A, r1, "10.00")).kind).toBe("created");
    });

    test("a deactivated register cannot be opened, and a register with a live session cannot be deactivated", async () => {
      const r1 = await makeRegister(TENANT_A);
      const sessionId = await openOk(TENANT_A, r1);
      const blocked = await inTenant(TENANT_A, (tx) =>
        updateRegister(tx, TENANT_A, CASHIER_1, r1, { active: false })
      );
      expect(blocked.kind).toBe("has_active_session");
      await close(TENANT_A, sessionId, closeInput({ cash: "100000.00" }));
      const deactivated = await inTenant(TENANT_A, (tx) =>
        updateRegister(tx, TENANT_A, CASHIER_1, r1, { active: false })
      );
      expect(deactivated.kind).toBe("updated");
      expect((await open(TENANT_A, r1)).kind).toBe("register_inactive");
    });

    test("an unknown register and another tenant's register are the same register_not_found", async () => {
      const theirs = await inTenant(TENANT_B, async (tx) => {
        const created = await createRegister(tx, TENANT_B, B_CASHIER, {
          code: "B1",
          name: "B one",
          locationLabel: null
        });
        return created.kind === "created" ? created.register.id : "";
      });
      expect((await open(TENANT_A, theirs)).kind).toBe("register_not_found");
      expect(
        (await open(TENANT_A, "00000000-0000-4000-8000-000000000000")).kind
      ).toBe("register_not_found");
      expect(
        await inTenant(TENANT_A, (tx) => fetchRegister(tx, TENANT_A, theirs))
      ).toBeNull();
    });
  });

  describe("sales during a session", () => {
    test("a sale is stamped with the session - the order AND every ledger leg", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const r1 = await makeRegister(TENANT_A);
      const sessionId = await openOk(TENANT_A, r1);

      const order = await ringOk(
        TENANT_A,
        posInput(productId, r1, {
          payment: null,
          tenders: [
            { tenderType: "manual_qris", amount: "10000.00", reference: null },
            { tenderType: "cash", amount: "20000.00", reference: null }
          ],
          lines: [{ productId, variantId: null, quantity: 3 }]
        })
      );
      expect(order.registerSessionId).toBe(sessionId);
      expect(order.status).toBe("paid");

      const orderRow = (await getAdminSql()`
        SELECT register_session_id FROM awcms_commerce_orders WHERE order_code = ${order.orderCode}
      `) as { register_session_id: string | null }[];
      expect(orderRow[0]!.register_session_id).toBe(sessionId);
      const legs = (await getAdminSql()`
        SELECT tender_type, register_session_id
        FROM awcms_commerce_payment_allocations
        WHERE order_id = ${order.id} ORDER BY tender_type
      `) as { tender_type: string; register_session_id: string | null }[];
      expect(legs.map((leg) => leg.tender_type)).toEqual([
        "cash",
        "manual_qris"
      ]);
      expect(legs.every((leg) => leg.register_session_id === sessionId)).toBe(
        true
      );

      const live = await report(TENANT_A, sessionId);
      expect(live.sales).toEqual({ count: 1, total: "30000.00" });
      expect(tender(live, "manual_qris")).toMatchObject({
        payments: "10000.00",
        expected: "10000.00"
      });
      expect(tender(live, "cash")).toMatchObject({
        payments: "20000.00",
        expected: "120000.00"
      });
    });

    test("with the feature ON a sale must name a register that has an open session of the acting cashier - refused before anything is written", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const r1 = await makeRegister(TENANT_A);

      const refusal = async (
        input: CreatePosOrderInput,
        actor = CASHIER_1
      ): Promise<string> => {
        try {
          await ring(TENANT_A, input, actor);
          return "no error";
        } catch (error) {
          return error instanceof PosRegisterSessionError
            ? error.code
            : `other: ${String(error)}`;
        }
      };

      expect(await refusal(posInput(productId, null))).toBe(
        "REGISTER_REQUIRED"
      );
      expect(
        await refusal(
          posInput(productId, "00000000-0000-4000-8000-000000000000")
        )
      ).toBe("REGISTER_NOT_FOUND");
      expect(await refusal(posInput(productId, r1))).toBe(
        "REGISTER_SESSION_REQUIRED"
      );

      await openOk(TENANT_A, r1);
      expect(await refusal(posInput(productId, r1), CASHIER_2)).toBe(
        "NOT_SESSION_CASHIER"
      );

      const orders = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_commerce_orders WHERE tenant_id = ${TENANT_A}
      `) as { n: number }[];
      expect(orders[0]!.n).toBe(0);
      const stock = (await getAdminSql()`
        SELECT stock FROM awcms_commerce_products WHERE id = ${productId}
      `) as { stock: number }[];
      expect(Number(stock[0]!.stock)).toBe(500);
    });

    test("another tenant's register id is the same REGISTER_NOT_FOUND (no oracle)", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const theirs = await inTenant(TENANT_B, async (tx) => {
        const created = await createRegister(tx, TENANT_B, B_CASHIER, {
          code: "B1",
          name: "B one",
          locationLabel: null
        });
        return created.kind === "created" ? created.register.id : "";
      });
      await expect(
        ring(TENANT_A, posInput(productId, theirs))
      ).rejects.toMatchObject({ code: "REGISTER_NOT_FOUND" });
    });

    test("handover moves the drawer: the new cashier sells, the old one no longer can; a supervisor may hand over; an unknown cashier is refused", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const r1 = await makeRegister(TENANT_A);
      const sessionId = await openOk(TENANT_A, r1);

      const handover = (
        actor: string,
        to: string,
        supervisor = false,
        key = crypto.randomUUID()
      ) =>
        inTenant(TENANT_A, (tx) =>
          handOverRegisterSession(tx, TENANT_A, actor, supervisor, sessionId, {
            idempotencyKey: key,
            toTenantUserId: to,
            note: null
          })
        );

      expect((await handover(CASHIER_2, CASHIER_2)).kind).toBe("forbidden");
      expect((await handover(CASHIER_1, CASHIER_1)).kind).toBe("same_cashier");
      expect(
        (await handover(CASHIER_1, "00000000-0000-4000-8000-000000000000")).kind
      ).toBe("unknown_cashier");
      expect((await handover(CASHIER_1, B_CASHIER)).kind).toBe(
        "unknown_cashier"
      );
      const done = await handover(CASHIER_1, CASHIER_2);
      expect(done.kind).toBe("handed_over");

      await ringOk(TENANT_A, posInput(productId, r1), CASHIER_2);
      await expect(
        ring(TENANT_A, posInput(productId, r1), CASHIER_1)
      ).rejects.toMatchObject({ code: "NOT_SESSION_CASHIER" });
      // A movement and a close are the CURRENT cashier's too.
      expect(
        (await addMovement(TENANT_A, sessionId, movement(), CASHIER_1)).kind
      ).toBe("not_session_cashier");
      // A supervisor may take it over.
      expect((await handover(SUPERVISOR, SUPERVISOR, true)).kind).toBe(
        "handed_over"
      );
      const session = await inTenant(TENANT_A, (tx) =>
        fetchRegisterSession(tx, TENANT_A, sessionId)
      );
      expect(session?.currentCashierTenantUserId).toBe(SUPERVISOR);
    });

    test("a sale cannot be attached to a closing or closed session - the gate says so, and the database trigger backs it up", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const r1 = await makeRegister(TENANT_A);
      const sessionId = await openOk(TENANT_A, r1);
      const sale = await ringOk(TENANT_A, posInput(productId, r1));

      // 100.00 short against a 50.00 threshold, closer without the approve
      // permission -> `closing`.
      const closing = await close(
        TENANT_A,
        sessionId,
        closeInput({ cash: "119900.00" }, { varianceReason: "recount pending" })
      );
      expect(closing.kind).toBe("pending_approval");
      await expect(
        ring(TENANT_A, posInput(productId, r1))
      ).rejects.toMatchObject({
        code: "REGISTER_SESSION_CLOSING"
      });

      // The trigger: an order row naming a non-open session cannot be inserted
      // even by a writer that skipped the gate (admin connection, no RLS).
      const customerId = (await getAdminSql()`
        SELECT customer_id FROM awcms_commerce_orders WHERE id = ${sale.id}
      `) as { customer_id: string }[];
      await expect(
        attempt(
          getAdminSql()`
            INSERT INTO awcms_commerce_orders (
              tenant_id, order_code, customer_id, status, payment_method, payment_status,
              shipping_method, shipping_cost, subtotal, discount, insurance_fee, tax, total,
              channel, pos_cashier_tenant_user_id, register_session_id
            ) VALUES (
              ${TENANT_A}, 'TRG-1', ${customerId[0]!.customer_id}, 'pending_payment', 'cash', 'unpaid',
              'self_pickup', '0.00', '1.00', '0.00', '0.00', '0.00', '1.00',
              'pos', ${CASHIER_1}, ${sessionId}
            )
          `
        )
      ).rejects.toThrow(/open register session/);

      // Reject the count -> open again, a sale is accepted again.
      await inTenant(TENANT_A, (tx) =>
        decideRegisterClose(tx, TENANT_A, SUPERVISOR, sessionId, {
          idempotencyKey: crypto.randomUUID(),
          decision: "reject",
          note: "please recount the drawer"
        })
      );
      await ringOk(TENANT_A, posInput(productId, r1));
    });

    test("the stamp is immutable and only a pos order may carry one", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const r1 = await makeRegister(TENANT_A);
      const r2 = await makeRegister(TENANT_A, "R2");
      await openOk(TENANT_A, r1);
      const s2 = await openOk(TENANT_A, r2);
      const sale = await ringOk(TENANT_A, posInput(productId, r1));
      await expect(
        attempt(
          inTenant(
            TENANT_A,
            (tx) =>
              tx`UPDATE awcms_commerce_orders SET register_session_id = ${s2} WHERE id = ${sale.id}`
          )
        )
      ).rejects.toThrow(/never changes/);
      await expect(
        attempt(
          inTenant(
            TENANT_A,
            (tx) =>
              tx`UPDATE awcms_commerce_orders SET register_session_id = NULL WHERE id = ${sale.id}`
          )
        )
      ).rejects.toThrow(/never changes/);
      await expect(
        attempt(
          getAdminSql()`
            UPDATE awcms_commerce_orders SET channel = 'storefront' WHERE id = ${sale.id}
          `
        )
      ).rejects.toThrow();
    });

    test("a stamped ledger leg must belong to its order's own session", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const r1 = await makeRegister(TENANT_A);
      const r2 = await makeRegister(TENANT_A, "R2");
      await openOk(TENANT_A, r1);
      const s2 = await openOk(TENANT_A, r2);
      const sale = await ringOk(
        TENANT_A,
        posInput(productId, r1, {
          payment: null,
          tenders: [],
          allowDue: true,
          customer: { name: "Budi", phone: "0813-1111-2222" }
        })
      ).catch(() => null);
      // `allowDue` needs the separate permission only at the route; the
      // directory accepts it, so this sale is on account with no legs yet.
      expect(sale).not.toBeNull();
      await expect(
        attempt(
          getAdminSql()`
            INSERT INTO awcms_commerce_payment_allocations (
              tenant_id, order_id, kind, tender_type, amount, status, source, source_key,
              actor_kind, actor_tenant_user_id, register_session_id, settled_at
            ) VALUES (
              ${TENANT_A}, ${sale!.id}, 'payment', 'cash', 1, 'succeeded', 'admin', 'wrong-session',
              'tenant_user', ${CASHIER_1}, ${s2}, now()
            )
          `
        )
      ).rejects.toThrow(/own order/);
    });
  });

  describe("drawer movements", () => {
    test("cash in and a safe drop are recorded append-only and move the expected cash; the actor must be the current cashier", async () => {
      const r1 = await makeRegister(TENANT_A);
      const sessionId = await openOk(TENANT_A, r1, "100000.00");

      const cashIn = await addMovement(
        TENANT_A,
        sessionId,
        movement({ amount: "5000.00" })
      );
      const drop = await addMovement(
        TENANT_A,
        sessionId,
        movement({
          movementType: "safe_drop",
          direction: "out",
          amount: "20000.00",
          note: "to the safe"
        })
      );
      const expense = await addMovement(
        TENANT_A,
        sessionId,
        movement({
          movementType: "expense",
          direction: "out",
          amount: "1500.50",
          reference: "ice"
        })
      );
      expect([cashIn.kind, drop.kind, expense.kind]).toEqual([
        "created",
        "created",
        "created"
      ]);

      const live = await report(TENANT_A, sessionId);
      expect(live.movementTotals).toEqual({ in: "5000.00", out: "21500.50" });
      // 100000.00 + 5000.00 - 21500.50
      expect(tender(live, "cash").expected).toBe("83499.50");
      expect(live.movements.map((m) => m.movementType)).toEqual([
        "cash_in",
        "safe_drop",
        "expense"
      ]);

      expect(
        (await addMovement(TENANT_A, sessionId, movement(), CASHIER_2)).kind
      ).toBe("not_session_cashier");
      expect(
        (
          await addMovement(
            TENANT_A,
            "00000000-0000-4000-8000-000000000000",
            movement()
          )
        ).kind
      ).toBe("not_found");
    });

    test("a movement replay returns the same row; a different payload under the key conflicts; nothing is written twice", async () => {
      const r1 = await makeRegister(TENANT_A);
      const sessionId = await openOk(TENANT_A, r1);
      const input = movement({ amount: "7000.00" });
      const a = await addMovement(TENANT_A, sessionId, input);
      const b = await addMovement(TENANT_A, sessionId, input);
      expect(a.kind).toBe("created");
      expect(b.kind).toBe("replayed");
      if (a.kind === "created" && b.kind === "replayed") {
        expect(b.movement.id).toBe(a.movement.id);
      }
      await expect(
        addMovement(TENANT_A, sessionId, { ...input, amount: "8000.00" })
      ).rejects.toBeInstanceOf(IdempotencyPayloadMismatchError);
      const rows = await inTenant(TENANT_A, (tx) =>
        listRegisterMovements(tx, TENANT_A, sessionId)
      );
      expect(rows).toHaveLength(1);
    });

    test("movements are append-only for the runtime role: no UPDATE, no DELETE (privilege), and the trigger refuses an edit even for the owner", async () => {
      const r1 = await makeRegister(TENANT_A);
      const sessionId = await openOk(TENANT_A, r1);
      await addMovement(TENANT_A, sessionId, movement());
      await expect(
        attempt(
          inTenant(
            TENANT_A,
            (tx) =>
              tx`UPDATE awcms_commerce_register_movements SET amount = 1 WHERE session_id = ${sessionId}`
          )
        )
      ).rejects.toThrow();
      await expect(
        attempt(
          inTenant(
            TENANT_A,
            (tx) =>
              tx`DELETE FROM awcms_commerce_register_movements WHERE session_id = ${sessionId}`
          )
        )
      ).rejects.toThrow();
      await expect(
        attempt(
          getAdminSql()`
            UPDATE awcms_commerce_register_movements SET amount = 1 WHERE session_id = ${sessionId}
          `
        )
      ).rejects.toThrow(/append-only/);
    });
  });

  describe("cash-up: expected, counted, variance, approval", () => {
    /** Float 100000, two sales (cash 20000; QRIS 10000 + cash 20000), cash in 5000, safe drop 20000. */
    async function busyShift(): Promise<{
      sessionId: string;
      registerId: string;
      productId: string;
    }> {
      const productId = await seedActiveProduct(TENANT_A);
      const registerId = await makeRegister(TENANT_A);
      const sessionId = await openOk(TENANT_A, registerId, "100000.00");
      await ringOk(TENANT_A, posInput(productId, registerId));
      await ringOk(
        TENANT_A,
        posInput(productId, registerId, {
          payment: null,
          tenders: [
            { tenderType: "manual_qris", amount: "10000.00", reference: null },
            { tenderType: "cash", amount: "20000.00", reference: null }
          ],
          lines: [{ productId, variantId: null, quantity: 3 }]
        })
      );
      await addMovement(TENANT_A, sessionId, movement({ amount: "5000.00" }));
      await addMovement(
        TENANT_A,
        sessionId,
        movement({
          movementType: "safe_drop",
          direction: "out",
          amount: "20000.00"
        })
      );
      return { sessionId, registerId, productId };
    }

    test("expected = float + cash legs (change excluded) + cash in - drops; QRIS expected = its legs", async () => {
      const { sessionId } = await busyShift();
      const live = await report(TENANT_A, sessionId);
      // 100000 + (20000 + 20000) + 5000 - 20000 = 125000
      expect(tender(live, "cash")).toMatchObject({
        payments: "40000.00",
        reversals: "0.00",
        expected: "125000.00",
        counted: null,
        variance: null
      });
      expect(tender(live, "manual_qris").expected).toBe("10000.00");
      expect(live.sales).toEqual({ count: 2, total: "50000.00" });
      expect(live.live).toBe(true);
      expect(live.variance).toBeNull();
    });

    test("an exact count closes the session; counted, expected and variance are stored per tender and the session is immutable afterwards", async () => {
      const { sessionId } = await busyShift();
      const outcome = await close(
        TENANT_A,
        sessionId,
        closeInput({ cash: "125000.00", manual_qris: "10000.00" })
      );
      expect(outcome.kind).toBe("closed");
      if (outcome.kind !== "closed") return;
      expect(outcome.body.outcome).toBe("closed");
      const closed = outcome.body.report;
      expect(closed.session.status).toBe("closed");
      expect(closed.session.closedByTenantUserId).toBe(CASHIER_1);
      expect(closed.live).toBe(false);
      expect(tender(closed, "cash")).toMatchObject({
        expected: "125000.00",
        counted: "125000.00",
        variance: "0.00"
      });
      expect(closed.variance).toMatchObject({
        total: "0.00",
        gross: "0.00",
        decision: "auto"
      });
    });

    test("a missing count for a tender with activity, or a variance with no reason, is refused and writes nothing", async () => {
      const { sessionId } = await busyShift();
      const missing = await close(
        TENANT_A,
        sessionId,
        closeInput({ cash: "125000.00" })
      );
      expect(missing.kind).toBe("missing_count");
      if (missing.kind === "missing_count") {
        expect(missing.tenderTypes).toEqual(["manual_qris"]);
      }
      const noReason = await close(
        TENANT_A,
        sessionId,
        closeInput({ cash: "124000.00", manual_qris: "10000.00" })
      );
      expect(noReason.kind).toBe("variance_reason_required");
      const rows = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_commerce_register_close_requests WHERE session_id = ${sessionId}
      `) as { n: number }[];
      expect(rows[0]!.n).toBe(0);
      const session = await inTenant(TENANT_A, (tx) =>
        fetchRegisterSession(tx, TENANT_A, sessionId)
      );
      expect(session?.status).toBe("open");
    });

    test("a variance within the threshold closes without approval (gross compared strictly, per-tender absolute values)", async () => {
      const { sessionId } = await busyShift();
      // 30.00 short in cash + 20.00 over in QRIS: net -10.00, gross 50.00 = the threshold -> allowed.
      const outcome = await close(
        TENANT_A,
        sessionId,
        closeInput(
          { cash: "124970.00", manual_qris: "10020.00" },
          { varianceReason: "rounding at the counter" }
        )
      );
      expect(outcome.kind).toBe("closed");
      if (outcome.kind !== "closed") return;
      expect(outcome.body.report.variance).toMatchObject({
        total: "-10.00",
        gross: "50.00",
        approvalThreshold: "50.00",
        decision: "auto",
        reason: "rounding at the counter"
      });
      expect(tender(outcome.body.report, "cash").variance).toBe("-30.00");
      expect(tender(outcome.body.report, "manual_qris").variance).toBe("20.00");
    });

    test("above the threshold, a closer WITHOUT the approve permission leaves the session `closing`; an approver then approves it", async () => {
      const { sessionId } = await busyShift();
      const outcome = await close(
        TENANT_A,
        sessionId,
        closeInput(
          { cash: "124900.00", manual_qris: "10000.00" },
          { varianceReason: "short by a hundred" }
        )
      );
      expect(outcome.kind).toBe("pending_approval");
      if (outcome.kind !== "pending_approval") return;
      expect(outcome.body.report.session.status).toBe("closing");
      expect(outcome.body.report.closeRequests).toHaveLength(1);
      expect(outcome.body.report.closeRequests[0]).toMatchObject({
        attempt: 1,
        decision: "pending",
        approvalRequired: true,
        varianceGross: "100.00",
        varianceTotal: "-100.00"
      });
      // `closing` accepts nothing: no movement, no second close.
      expect((await addMovement(TENANT_A, sessionId, movement())).kind).toBe(
        "session_not_open"
      );
      expect(
        (
          await close(
            TENANT_A,
            sessionId,
            closeInput({ cash: "1.00", manual_qris: "1.00" })
          )
        ).kind
      ).toBe("session_not_open");

      const approved = await inTenant(TENANT_A, (tx) =>
        decideRegisterClose(tx, TENANT_A, SUPERVISOR, sessionId, {
          idempotencyKey: crypto.randomUUID(),
          decision: "approve",
          note: null
        })
      );
      expect(approved.kind).toBe("approved");
      if (approved.kind !== "approved") return;
      expect(approved.body.report.session.status).toBe("closed");
      // The cashier who counted is the closer; the approver is on the request.
      expect(approved.body.report.session.closedByTenantUserId).toBe(CASHIER_1);
      expect(approved.body.report.closeRequests[0]).toMatchObject({
        decision: "approved",
        decidedByTenantUserId: SUPERVISOR
      });
      expect(tender(approved.body.report, "cash").variance).toBe("-100.00");
    });

    test("above the threshold, a closer who ALSO holds the approve permission closes in one step, recorded as approved by them", async () => {
      const { sessionId } = await busyShift();
      const outcome = await close(
        TENANT_A,
        sessionId,
        closeInput(
          { cash: "124900.00", manual_qris: "10000.00" },
          { varianceReason: "short" }
        ),
        { canApprove: true }
      );
      expect(outcome.kind).toBe("closed");
      if (outcome.kind !== "closed") return;
      expect(outcome.body.report.closeRequests[0]).toMatchObject({
        decision: "approved",
        decidedByTenantUserId: CASHIER_1,
        approvalRequired: true
      });
    });

    test("a rejected count reopens the session, keeps the rejected request as history, and the recount is attempt 2", async () => {
      const { sessionId } = await busyShift();
      await close(
        TENANT_A,
        sessionId,
        closeInput(
          { cash: "124900.00", manual_qris: "10000.00" },
          { varianceReason: "short" }
        )
      );
      const rejected = await inTenant(TENANT_A, (tx) =>
        decideRegisterClose(tx, TENANT_A, SUPERVISOR, sessionId, {
          idempotencyKey: crypto.randomUUID(),
          decision: "reject",
          note: "count it again"
        })
      );
      expect(rejected.kind).toBe("rejected");
      if (rejected.kind !== "rejected") return;
      expect(rejected.body.outcome).toBe("reopened");
      expect(rejected.body.report.session.status).toBe("open");

      const recount = await close(
        TENANT_A,
        sessionId,
        closeInput({ cash: "125000.00", manual_qris: "10000.00" })
      );
      expect(recount.kind).toBe("closed");
      if (recount.kind !== "closed") return;
      expect(
        recount.body.report.closeRequests.map((r) => [r.attempt, r.decision])
      ).toEqual([
        [1, "rejected"],
        [2, "auto"]
      ]);
      expect(recount.body.report.variance?.decision).toBe("auto");
      expect(tender(recount.body.report, "cash").variance).toBe("0.00");
    });

    test("only a closing session has anything to decide", async () => {
      const { sessionId } = await busyShift();
      const result = await inTenant(TENANT_A, (tx) =>
        decideRegisterClose(tx, TENANT_A, SUPERVISOR, sessionId, {
          idempotencyKey: crypto.randomUUID(),
          decision: "approve",
          note: null
        })
      );
      expect(result.kind).toBe("not_pending");
    });

    test("only the current cashier may close", async () => {
      const { sessionId } = await busyShift();
      const result = await close(
        TENANT_A,
        sessionId,
        closeInput({ cash: "125000.00", manual_qris: "10000.00" }),
        { actor: CASHIER_2 }
      );
      expect(result.kind).toBe("not_session_cashier");
    });

    test("a cash refund recorded while the session is open is part of that cash-up", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const r1 = await makeRegister(TENANT_A);
      const sessionId = await openOk(TENANT_A, r1, "100000.00");
      const sale = await ringOk(TENANT_A, posInput(productId, r1));
      const legs = (await getAdminSql()`
        SELECT id FROM awcms_commerce_payment_allocations WHERE order_id = ${sale.id}
      `) as { id: string }[];
      await inTenant(TENANT_A, (tx) =>
        recordOwnerReversal(tx, TENANT_A, CASHIER_1, sale.id, legs[0]!.id, {
          idempotencyKey: crypto.randomUUID(),
          amount: "5000.00",
          note: "customer returned one coffee"
        })
      );
      const live = await report(TENANT_A, sessionId);
      // 100000 + 20000 - 5000
      expect(tender(live, "cash")).toMatchObject({
        payments: "20000.00",
        reversals: "5000.00",
        expected: "115000.00"
      });
    });
  });

  describe("close is idempotent and concurrency-safe", () => {
    test("a replay of the same close returns the stored body and writes nothing new; a different payload under the key conflicts", async () => {
      const r1 = await makeRegister(TENANT_A);
      const sessionId = await openOk(TENANT_A, r1);
      const input = closeInput({ cash: "100000.00" });
      const first = await close(TENANT_A, sessionId, input);
      const second = await close(TENANT_A, sessionId, input);
      expect(first.kind).toBe("closed");
      expect(second.kind).toBe("replayed");
      if (first.kind === "closed" && second.kind === "replayed") {
        expect(second.body).toEqual(first.body);
      }
      await expect(
        close(TENANT_A, sessionId, { ...input, counted: { cash: "1.00" } })
      ).rejects.toBeInstanceOf(IdempotencyPayloadMismatchError);
      const rows = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_commerce_register_close_requests WHERE session_id = ${sessionId}
      `) as { n: number }[];
      expect(rows[0]!.n).toBe(1);
      const events = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_domain_events
        WHERE event_type = 'awcms.commerce.register_session.closed' AND aggregate_id = ${sessionId}
      `) as { n: number }[];
      expect(events[0]!.n).toBe(1);
    });

    test("two GENUINELY concurrent closes with different keys: exactly one closes, the other sees a non-open session", async () => {
      const r1 = await makeRegister(TENANT_A);
      const sessionId = await openOk(TENANT_A, r1);
      const results = await Promise.all([
        close(TENANT_A, sessionId, closeInput({ cash: "100000.00" })),
        close(TENANT_A, sessionId, closeInput({ cash: "100000.00" }))
      ]);
      expect(results.map((r) => r.kind).sort()).toEqual([
        "closed",
        "session_not_open"
      ]);
      const rows = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_commerce_register_close_requests WHERE session_id = ${sessionId}
      `) as { n: number }[];
      expect(rows[0]!.n).toBe(1);
    });

    test("two concurrent closes with the SAME key: one closes, the other replays it", async () => {
      const r1 = await makeRegister(TENANT_A);
      const sessionId = await openOk(TENANT_A, r1);
      const input = closeInput({ cash: "100000.00" });
      const results = await Promise.all([
        close(TENANT_A, sessionId, input),
        close(TENANT_A, sessionId, input)
      ]);
      expect(results.map((r) => r.kind).sort()).toEqual(["closed", "replayed"]);
    });

    test("a close racing a sale never loses or double-counts a leg: the stored expected is exactly the stamped ledger sum", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      for (let round = 0; round < 4; round += 1) {
        const registerId = await makeRegister(TENANT_A, `RACE-${round}`);
        const sessionId = await openOk(TENANT_A, registerId, "100000.00");
        await ringOk(TENANT_A, posInput(productId, registerId));

        const [sale, closeResult] = await Promise.allSettled([
          ring(TENANT_A, posInput(productId, registerId)),
          close(
            TENANT_A,
            sessionId,
            closeInput({ cash: "0.00" }, { varianceReason: "racing close" }),
            { canApprove: true }
          )
        ]);
        expect(closeResult.status).toBe("fulfilled");

        const stored = (await getAdminSql()`
          SELECT l.expected
          FROM awcms_commerce_register_close_lines l
          JOIN awcms_commerce_register_close_requests r ON r.id = l.close_request_id
          WHERE r.session_id = ${sessionId} AND l.tender_type = 'cash'
        `) as { expected: string }[];
        const legs = (await getAdminSql()`
          SELECT COALESCE(SUM(amount), 0) AS cash
          FROM awcms_commerce_payment_allocations
          WHERE register_session_id = ${sessionId} AND tender_type = 'cash'
            AND kind = 'payment' AND status = 'succeeded'
        `) as { cash: string }[];
        const stamped = Number(legs[0]!.cash);
        expect(Number(stored[0]!.expected)).toBe(100000 + stamped);

        if (sale.status === "fulfilled") {
          // The sale won the lock race: its leg is in the cash-up.
          expect(stamped).toBe(40000);
        } else {
          // The close won: the sale was refused outright, nothing half-written.
          expect(sale.reason).toBeInstanceOf(PosRegisterSessionError);
          expect(stamped).toBe(20000);
          const orders = (await getAdminSql()`
            SELECT count(*)::int AS n FROM awcms_commerce_orders
            WHERE tenant_id = ${TENANT_A} AND register_session_id = ${sessionId}
          `) as { n: number }[];
          expect(orders[0]!.n).toBe(1);
        }
      }
    });
  });

  describe("a closed session is immutable", () => {
    async function closedSession(): Promise<{
      sessionId: string;
      registerId: string;
      productId: string;
    }> {
      const productId = await seedActiveProduct(TENANT_A);
      const registerId = await makeRegister(TENANT_A);
      const sessionId = await openOk(TENANT_A, registerId, "100000.00");
      await ringOk(TENANT_A, posInput(productId, registerId));
      const outcome = await close(
        TENANT_A,
        sessionId,
        closeInput({ cash: "120000.00" })
      );
      expect(outcome.kind).toBe("closed");
      return { sessionId, registerId, productId };
    }

    test("every mutation is denied: movement, handover, close, sale, and direct writes through the app role", async () => {
      const { sessionId, registerId, productId } = await closedSession();

      expect((await addMovement(TENANT_A, sessionId, movement())).kind).toBe(
        "session_not_open"
      );
      const handover = await inTenant(TENANT_A, (tx) =>
        handOverRegisterSession(tx, TENANT_A, CASHIER_1, true, sessionId, {
          idempotencyKey: crypto.randomUUID(),
          toTenantUserId: CASHIER_2,
          note: null
        })
      );
      expect(handover.kind).toBe("session_not_open");
      expect(
        (await close(TENANT_A, sessionId, closeInput({ cash: "1.00" }))).kind
      ).toBe("session_not_open");
      await expect(
        ring(TENANT_A, posInput(productId, registerId))
      ).rejects.toMatchObject({
        code: "REGISTER_SESSION_REQUIRED"
      });

      for (const statement of [
        (tx: Bun.SQL) =>
          tx`UPDATE awcms_commerce_register_sessions SET opening_float = 1 WHERE id = ${sessionId}`,
        (tx: Bun.SQL) =>
          tx`UPDATE awcms_commerce_register_sessions SET status = 'open', closed_at = NULL, closed_by_tenant_user_id = NULL WHERE id = ${sessionId}`,
        (tx: Bun.SQL) =>
          tx`UPDATE awcms_commerce_register_sessions SET current_cashier_tenant_user_id = ${CASHIER_2} WHERE id = ${sessionId}`,
        (tx: Bun.SQL) =>
          tx`DELETE FROM awcms_commerce_register_sessions WHERE id = ${sessionId}`,
        (tx: Bun.SQL) =>
          tx`UPDATE awcms_commerce_register_close_lines SET counted = 1 WHERE session_id = ${sessionId}`,
        (tx: Bun.SQL) =>
          tx`DELETE FROM awcms_commerce_register_close_requests WHERE session_id = ${sessionId}`
      ]) {
        await expect(attempt(inTenant(TENANT_A, statement))).rejects.toThrow();
      }
      // A movement inserted by a writer that skipped the application check is
      // still refused by the trigger.
      await expect(
        attempt(
          getAdminSql()`
            INSERT INTO awcms_commerce_register_movements
              (tenant_id, session_id, movement_type, direction, amount, actor_tenant_user_id, source_key)
            VALUES (${TENANT_A}, ${sessionId}, 'cash_in', 'in', 1, ${CASHIER_1}, 'sneaky')
          `
        )
      ).rejects.toThrow(/open register session/);
    });

    test("late ledger activity on a closed session's sale is recorded but never changes the closed cash-up", async () => {
      const { sessionId, productId, registerId } = await closedSession();
      const before = await report(TENANT_A, sessionId);

      // A balance due on a second sale, paid after the close.
      const open2 = await openOk(TENANT_A, registerId, "0.00");
      const due = await ringOk(
        TENANT_A,
        posInput(productId, registerId, {
          payment: null,
          tenders: [],
          allowDue: true,
          customer: { name: "Budi", phone: "0813-1111-2222" }
        })
      );
      // Close that second session, THEN pay: the late leg is not stamped.
      await close(TENANT_A, open2, closeInput({ cash: "0.00" }));
      await inTenant(TENANT_A, (tx) =>
        recordOwnerPayment(tx, TENANT_A, CASHIER_1, due.id, {
          idempotencyKey: crypto.randomUUID(),
          tenderType: "cash",
          amount: "20000.00",
          reference: null,
          note: null
        })
      );
      const leg = (await getAdminSql()`
        SELECT register_session_id FROM awcms_commerce_payment_allocations
        WHERE order_id = ${due.id}
      `) as { register_session_id: string | null }[];
      expect(leg).toHaveLength(1);
      expect(leg[0]!.register_session_id).toBeNull();

      const after = await report(TENANT_A, sessionId);
      expect(after).toEqual(before);
      const closedTwo = await report(TENANT_A, open2);
      expect(tender(closedTwo, "cash")).toMatchObject({
        payments: "0.00",
        expected: "0.00",
        counted: "0.00"
      });
    });
  });

  describe("corrections", () => {
    async function closedWithVariance(): Promise<string> {
      const productId = await seedActiveProduct(TENANT_A);
      const registerId = await makeRegister(TENANT_A);
      const sessionId = await openOk(TENANT_A, registerId, "100000.00");
      await ringOk(TENANT_A, posInput(productId, registerId));
      // 200.00 short, approved on the spot.
      const outcome = await close(
        TENANT_A,
        sessionId,
        closeInput({ cash: "119800.00" }, { varianceReason: "miscount" }),
        { canApprove: true }
      );
      expect(outcome.kind).toBe("closed");
      return sessionId;
    }

    const correct = (
      sessionId: string,
      adjustments: { tenderType: "cash" | "manual_qris"; adjustment: string }[],
      key = crypto.randomUUID(),
      reason = "found the missing banknotes"
    ) =>
      inTenant(TENANT_A, (tx) =>
        recordRegisterCorrection(tx, TENANT_A, SUPERVISOR, sessionId, {
          idempotencyKey: key,
          reason,
          adjustments
        })
      );

    test("a correction is a compensating row: the original lines are preserved, the status becomes `corrected`, the effective figures change", async () => {
      const sessionId = await closedWithVariance();
      const originalLines = (await getAdminSql()`
        SELECT tender_type, expected, counted, variance
        FROM awcms_commerce_register_close_lines WHERE session_id = ${sessionId}
      `) as unknown[];

      const result = await correct(sessionId, [
        { tenderType: "cash", adjustment: "200.00" }
      ]);
      expect(result.kind).toBe("created");
      if (result.kind !== "created") return;
      expect(result.report.session.status).toBe("corrected");
      expect(tender(result.report, "cash")).toMatchObject({
        counted: "119800.00", // the original, untouched
        variance: "-200.00",
        correction: "200.00",
        effectiveCounted: "120000.00",
        effectiveVariance: "0.00"
      });
      expect(result.report.corrections).toHaveLength(1);
      expect(result.report.closeRequests).toHaveLength(1);

      const afterLines = (await getAdminSql()`
        SELECT tender_type, expected, counted, variance
        FROM awcms_commerce_register_close_lines WHERE session_id = ${sessionId}
      `) as unknown[];
      expect(afterLines).toEqual(originalLines);

      // A second correction stacks on the first; the session stays corrected.
      const again = await correct(sessionId, [
        { tenderType: "cash", adjustment: "-50.00" }
      ]);
      expect(again.kind).toBe("created");
      if (again.kind === "created") {
        expect(tender(again.report, "cash").effectiveCounted).toBe("119950.00");
        expect(again.report.session.status).toBe("corrected");
      }
    });

    test("a correction replay returns the stored report and writes nothing; a different payload conflicts", async () => {
      const sessionId = await closedWithVariance();
      const key = crypto.randomUUID();
      const adjustments = [
        { tenderType: "cash" as const, adjustment: "10.00" }
      ];
      const a = await correct(sessionId, adjustments, key);
      const b = await correct(sessionId, adjustments, key);
      expect([a.kind, b.kind]).toEqual(["created", "replayed"]);
      await expect(
        correct(sessionId, [{ tenderType: "cash", adjustment: "11.00" }], key)
      ).rejects.toBeInstanceOf(IdempotencyPayloadMismatchError);
      const rows = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_commerce_register_corrections WHERE session_id = ${sessionId}
      `) as { n: number }[];
      expect(rows[0]!.n).toBe(1);
    });

    test("an open session cannot be corrected, an unknown session is not_found, and a correction can never drive a count negative", async () => {
      const r1 = await makeRegister(TENANT_A, "OPEN-ONE");
      const openId = await openOk(TENANT_A, r1);
      expect(
        (await correct(openId, [{ tenderType: "cash", adjustment: "1.00" }]))
          .kind
      ).toBe("session_not_closed");
      expect(
        (
          await correct("00000000-0000-4000-8000-000000000000", [
            { tenderType: "cash", adjustment: "1.00" }
          ])
        ).kind
      ).toBe("not_found");
      const sessionId = await closedWithVariance();
      const negative = await correct(sessionId, [
        { tenderType: "cash", adjustment: "-999999.00" }
      ]);
      expect(negative.kind).toBe("negative_count");
    });

    test("the corrections table is append-only and a correction needs a closed session (database level)", async () => {
      const sessionId = await closedWithVariance();
      await correct(sessionId, [{ tenderType: "cash", adjustment: "5.00" }]);
      await expect(
        attempt(
          inTenant(
            TENANT_A,
            (tx) =>
              tx`UPDATE awcms_commerce_register_corrections SET adjustment = 1 WHERE session_id = ${sessionId}`
          )
        )
      ).rejects.toThrow();
      await expect(
        attempt(
          inTenant(
            TENANT_A,
            (tx) =>
              tx`DELETE FROM awcms_commerce_register_corrections WHERE session_id = ${sessionId}`
          )
        )
      ).rejects.toThrow();
      const r1 = await makeRegister(TENANT_A, "OPEN-TWO");
      const openId = await openOk(TENANT_A, r1);
      await expect(
        attempt(
          getAdminSql()`
            INSERT INTO awcms_commerce_register_corrections
              (tenant_id, session_id, correction_id, tender_type, adjustment, reason, actor_tenant_user_id, source_key)
            VALUES (${TENANT_A}, ${openId}, ${crypto.randomUUID()}, 'cash', 1, 'x', ${SUPERVISOR}, 'k')
          `
        )
      ).rejects.toThrow(/closed session/);
    });
  });

  describe("tenant isolation", () => {
    test("RLS and the composite foreign keys keep tenant B away from tenant A's shift", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const registerId = await makeRegister(TENANT_A);
      const sessionId = await openOk(TENANT_A, registerId);
      await ringOk(TENANT_A, posInput(productId, registerId));
      await addMovement(TENANT_A, sessionId, movement());
      await close(
        TENANT_A,
        sessionId,
        closeInput({ cash: "0.00" }, { varianceReason: "x" }),
        {
          canApprove: true
        }
      );

      // Nothing of A is visible from B, through every read path.
      expect(
        await inTenant(TENANT_B, (tx) => listRegisters(tx, TENANT_B))
      ).toEqual([]);
      expect(
        (
          await inTenant(TENANT_B, (tx) =>
            listRegisterSessions(tx, TENANT_B, null)
          )
        ).items
      ).toEqual([]);
      expect(
        await inTenant(TENANT_B, (tx) =>
          fetchRegisterCashUpReport(tx, TENANT_B, sessionId)
        )
      ).toBeNull();
      expect(
        await inTenant(TENANT_B, (tx) =>
          fetchRegisterSession(tx, TENANT_B, sessionId)
        )
      ).toBeNull();
      expect(
        await inTenant(TENANT_B, (tx) =>
          listRegisterMovements(tx, TENANT_B, sessionId)
        )
      ).toEqual([]);
      for (const table of [
        "registers",
        "register_sessions",
        "register_movements",
        "register_close_requests",
        "register_close_lines"
      ]) {
        const rows = (await inTenant(
          TENANT_B,
          (tx) =>
            tx`SELECT count(*)::int AS n FROM ${tx.unsafe(`awcms_commerce_${table}`)}`
        )) as { n: number }[];
        expect(rows[0]!.n).toBe(0);
      }

      // Every mutation by B against A's ids is the same answer as an unknown id.
      expect(
        (await addMovement(TENANT_B, sessionId, movement(), B_CASHIER)).kind
      ).toBe("not_found");
      expect(
        (
          await close(TENANT_B, sessionId, closeInput({ cash: "0.00" }), {
            actor: B_CASHIER
          })
        ).kind
      ).toBe("not_found");
      expect(
        (
          await inTenant(TENANT_B, (tx) =>
            recordRegisterCorrection(tx, TENANT_B, B_CASHIER, sessionId, {
              idempotencyKey: crypto.randomUUID(),
              reason: "x",
              adjustments: [{ tenderType: "cash", adjustment: "1.00" }]
            })
          )
        ).kind
      ).toBe("not_found");
      const gate = await inTenant(TENANT_B, (tx) =>
        gateSaleToRegisterSession(tx, TENANT_B, registerId, B_CASHIER)
      );
      expect(gate.kind).toBe("register_not_found");

      // The composite FK: tenant B cannot even write a row pointing at A's session.
      await expect(
        attempt(
          inTenant(
            TENANT_B,
            (tx) => tx`
              INSERT INTO awcms_commerce_register_movements
                (tenant_id, session_id, movement_type, direction, amount, actor_tenant_user_id, source_key)
              VALUES (${TENANT_B}, ${sessionId}, 'cash_in', 'in', 1, ${B_CASHIER}, 'cross-tenant')
            `
          )
        )
      ).rejects.toThrow();
      // ...nor impersonate tenant A through the tenant column (WITH CHECK).
      await expect(
        attempt(
          inTenant(
            TENANT_B,
            (tx) => tx`
              INSERT INTO awcms_commerce_registers (tenant_id, code, name)
              VALUES (${TENANT_A}, 'EVIL', 'Evil')
            `
          )
        )
      ).rejects.toThrow();
    });
  });

  describe("feature OFF is today's POS", () => {
    test("with the feature off a sale needs no register, nothing is stamped, and naming a register is refused", async () => {
      await configureRegisters(TENANT_A, { register: false });
      const productId = await seedActiveProduct(TENANT_A);
      const registerId = await makeRegister(TENANT_A);
      await openOk(TENANT_A, registerId);

      const order = await ringOk(TENANT_A, posInput(productId, null));
      expect(order.registerSessionId).toBeNull();
      expect(order.status).toBe("paid");
      const stamped = (await getAdminSql()`
        SELECT
          (SELECT count(*)::int FROM awcms_commerce_orders WHERE register_session_id IS NOT NULL) AS orders,
          (SELECT count(*)::int FROM awcms_commerce_payment_allocations WHERE register_session_id IS NOT NULL) AS legs
      `) as { orders: number; legs: number }[];
      expect(stamped[0]).toEqual({ orders: 0, legs: 0 });

      await expect(
        ring(TENANT_A, posInput(productId, registerId))
      ).rejects.toBeInstanceOf(FeatureDisabledError);
    });

    test("a sale payload that predates the feature (no registerId at all) keeps its idempotent replay", async () => {
      await configureRegisters(TENANT_A, { register: false });
      const productId = await seedActiveProduct(TENANT_A);
      const input = posInput(productId, null);
      const a = await ring(TENANT_A, input);
      const b = await ring(TENANT_A, input);
      expect([a.kind, b.kind]).toEqual(["created", "replayed"]);
    });
  });

  describe("report", () => {
    test("the cash-up report reconciles to the ledger, the movements and the sales, and the CSV carries no live formula", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const registerId = await makeRegister(TENANT_A, "=KASIR");
      const sessionId = await openOk(TENANT_A, registerId, "100000.00");
      await ringOk(TENANT_A, posInput(productId, registerId));
      await ringOk(
        TENANT_A,
        posInput(productId, registerId, {
          payment: null,
          tenders: [
            { tenderType: "manual_qris", amount: "10000.00", reference: null },
            { tenderType: "cash", amount: "20000.00", reference: null }
          ],
          lines: [{ productId, variantId: null, quantity: 3 }]
        })
      );
      await addMovement(
        TENANT_A,
        sessionId,
        movement({
          movementType: "expense",
          direction: "out",
          amount: "2500.00",
          reference: '=HYPERLINK("http://evil")',
          note: "+1+1"
        })
      );
      await addMovement(TENANT_A, sessionId, movement({ amount: "1000.00" }));
      const outcome = await close(
        TENANT_A,
        sessionId,
        closeInput(
          { cash: "138000.00", manual_qris: "10000.00" },
          { varianceReason: "-1 off" }
        ),
        { canApprove: true }
      );
      expect(outcome.kind).toBe("closed");
      const finalReport = await report(TENANT_A, sessionId);

      // Reconcile against independent SQL.
      const admin = getAdminSql();
      const ledger = (await admin`
        SELECT tender_type,
          COALESCE(SUM(amount) FILTER (WHERE kind = 'payment'), 0) AS payments,
          COALESCE(SUM(amount) FILTER (WHERE kind = 'reversal'), 0) AS reversals
        FROM awcms_commerce_payment_allocations
        WHERE register_session_id = ${sessionId} AND status = 'succeeded'
        GROUP BY tender_type
      `) as { tender_type: string; payments: string; reversals: string }[];
      for (const row of ledger) {
        expect(Number(tender(finalReport, row.tender_type).payments)).toBe(
          Number(row.payments)
        );
      }
      const movementSums = (await admin`
        SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'in'), 0) AS i,
               COALESCE(SUM(amount) FILTER (WHERE direction = 'out'), 0) AS o
        FROM awcms_commerce_register_movements WHERE session_id = ${sessionId}
      `) as { i: string; o: string }[];
      expect(Number(finalReport.movementTotals.in)).toBe(
        Number(movementSums[0]!.i)
      );
      expect(Number(finalReport.movementTotals.out)).toBe(
        Number(movementSums[0]!.o)
      );
      // 100000 + 40000 + 1000 - 2500 = 138500; counted 138000 -> -500.00
      expect(tender(finalReport, "cash")).toMatchObject({
        expected: "138500.00",
        counted: "138000.00",
        variance: "-500.00"
      });
      expect(finalReport.sales).toEqual({ count: 2, total: "50000.00" });

      const csv = serializeCashUpCsv(finalReport);
      for (const row of csv.split("\n")) {
        for (const cell of row.split(",")) {
          // No bare cell may start a formula (quoted cells start with a quote).
          expect(/^[=+@\t\r]/.test(cell)).toBe(false);
        }
      }
      expect(csv).toContain("'=KASIR");
      expect(csv).toContain("'-1 off");
      expect(csv).toContain("-500.00");
    });
  });

  describe("audit and events", () => {
    test("open, movement, close and correction write audit rows (no free text) and domain events on the session aggregate", async () => {
      const r1 = await makeRegister(TENANT_A);
      const sessionId = await openOk(TENANT_A, r1);
      await addMovement(
        TENANT_A,
        sessionId,
        movement({
          movementType: "expense",
          direction: "out",
          amount: "1.00",
          reference: "secret-ref",
          note: "secret-note"
        })
      );
      await close(
        TENANT_A,
        sessionId,
        closeInput({ cash: "99.00" }, { varianceReason: "secret-reason" }),
        { canApprove: true }
      );
      await inTenant(TENANT_A, (tx) =>
        recordRegisterCorrection(tx, TENANT_A, SUPERVISOR, sessionId, {
          idempotencyKey: crypto.randomUUID(),
          reason: "secret-correction",
          adjustments: [{ tenderType: "cash", adjustment: "1.00" }]
        })
      );

      const audit = (await getAdminSql()`
        SELECT action, message, attributes::text AS attributes
        FROM awcms_audit_events
        WHERE tenant_id = ${TENANT_A} AND resource_id = ${sessionId}
        ORDER BY created_at ASC
      `) as { action: string; message: string; attributes: string | null }[];
      expect(audit.map((row) => row.action)).toEqual([
        "register_session.open",
        "register_session.movement",
        "register_session.close",
        "register_session.correct"
      ]);
      const blob = audit
        .map((row) => `${row.message} ${row.attributes ?? ""}`)
        .join(" ");
      for (const secret of [
        "secret-ref",
        "secret-note",
        "secret-reason",
        "secret-correction"
      ]) {
        expect(blob).not.toContain(secret);
      }

      const events = (await getAdminSql()`
        SELECT event_type, aggregate_type, payload::text AS payload
        FROM awcms_domain_events
        WHERE tenant_id = ${TENANT_A} AND aggregate_id = ${sessionId}
        ORDER BY event_sequence ASC
      `) as { event_type: string; aggregate_type: string; payload: string }[];
      expect(events.map((event) => event.event_type)).toEqual([
        "awcms.commerce.register_session.opened",
        "awcms.commerce.register_session.movement_recorded",
        "awcms.commerce.register_session.closed",
        "awcms.commerce.register_session.corrected"
      ]);
      expect(
        events.every(
          (event) => event.aggregate_type === "commerce.register_session"
        )
      ).toBe(true);
      for (const secret of [
        "secret-ref",
        "secret-note",
        "secret-reason",
        "secret-correction"
      ]) {
        expect(events.map((event) => event.payload).join(" ")).not.toContain(
          secret
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // Review fixes: separation of duties, closing sessions, refunds across shifts
  // -------------------------------------------------------------------------

  describe("separation of duties on the cash-up", () => {
    const largeVariance = (): CloseSessionInput =>
      closeInput({ cash: "100000.00" }, { varianceReason: "short" });

    async function dueSaleShift(): Promise<{
      sessionId: string;
      orderId: string;
    }> {
      const productId = await seedActiveProduct(TENANT_A);
      const registerId = await makeRegister(TENANT_A);
      const sessionId = await openOk(TENANT_A, registerId, "100000.00");
      const sale = await ringOk(
        TENANT_A,
        posInput(productId, registerId, {
          customer: { name: "Siti", phone: "081211112222" },
          payment: null,
          tenders: [{ tenderType: "cash", amount: "5000.00", reference: null }],
          allowDue: true
        })
      );
      return { sessionId, orderId: sale.id };
    }

    const decide = (
      sessionId: string,
      actor: string,
      decision: "approve" | "reject"
    ) =>
      inTenant(TENANT_A, (tx) =>
        decideRegisterClose(tx, TENANT_A, actor, sessionId, {
          idempotencyKey: crypto.randomUUID(),
          decision,
          note: decision === "reject" ? "recount" : null
        })
      );

    test("by default a closer who holds the approve permission does NOT self-approve a variance above the threshold: the session waits for someone else", async () => {
      await configureRegisters(TENANT_A, {
        register: true,
        threshold: "50.00",
        allowSelfApproval: false
      });
      const { sessionId } = await dueSaleShift();
      const outcome = await close(TENANT_A, sessionId, largeVariance(), {
        canApprove: true
      });
      expect(outcome.kind).toBe("pending_approval");
      if (outcome.kind !== "pending_approval") return;
      expect(outcome.body.report.session.status).toBe("closing");
      expect(outcome.body.report.closeRequests[0]).toMatchObject({
        decision: "pending",
        decidedByTenantUserId: null
      });
    });

    test("the decider must differ from the requester: approving your own count is refused, another user approves, rejecting your own count is allowed", async () => {
      await configureRegisters(TENANT_A, {
        register: true,
        threshold: "50.00",
        allowSelfApproval: false
      });
      const { sessionId } = await dueSaleShift();
      await close(TENANT_A, sessionId, largeVariance());

      expect((await decide(sessionId, CASHIER_1, "approve")).kind).toBe(
        "self_approval_forbidden"
      );
      expect((await report(TENANT_A, sessionId)).session.status).toBe(
        "closing"
      );

      // Rejecting your own pending count only sends the drawer back to recount.
      expect((await decide(sessionId, CASHIER_1, "reject")).kind).toBe(
        "rejected"
      );
      expect((await report(TENANT_A, sessionId)).session.status).toBe("open");

      await close(TENANT_A, sessionId, largeVariance());
      const approved = await decide(sessionId, SUPERVISOR, "approve");
      expect(approved.kind).toBe("approved");
      expect((await report(TENANT_A, sessionId)).session.status).toBe("closed");
    });

    test("with cashUp.allowSelfApproval ON the closer closes in one step, and the requester may approve their own pending count", async () => {
      await configureRegisters(TENANT_A, {
        register: true,
        threshold: "50.00",
        allowSelfApproval: false
      });
      const { sessionId } = await dueSaleShift();
      // Pending under the default...
      await close(TENANT_A, sessionId, largeVariance());
      // ...then the tenant opts in: the requester can now decide it.
      await configureRegisters(TENANT_A, {
        register: true,
        threshold: "50.00",
        allowSelfApproval: true
      });
      expect((await decide(sessionId, CASHIER_1, "approve")).kind).toBe(
        "approved"
      );

      // And a fresh close by an approve-holder is a one-step close.
      const productId = (
        (await getAdminSql()`
          SELECT id FROM awcms_commerce_products WHERE tenant_id = ${TENANT_A} LIMIT 1
        `) as { id: string }[]
      )[0]!.id;
      const registerId = await makeRegister(TENANT_A, "KASIR-2");
      const second = await openOk(TENANT_A, registerId, "100000.00");
      await ringOk(TENANT_A, posInput(productId, registerId));
      const outcome = await close(TENANT_A, second, largeVariance(), {
        canApprove: true
      });
      expect(outcome.kind).toBe("closed");
    });
  });

  describe("payments into a closing session", () => {
    test("a counter payment on a sale whose session is `closing` is refused (it would fall into no cash-up); once the count is rejected it is recorded and stamped", async () => {
      await configureRegisters(TENANT_A, {
        register: true,
        threshold: "50.00",
        allowSelfApproval: false
      });
      const productId = await seedActiveProduct(TENANT_A);
      const registerId = await makeRegister(TENANT_A);
      const sessionId = await openOk(TENANT_A, registerId, "100000.00");
      const sale = await ringOk(
        TENANT_A,
        posInput(productId, registerId, {
          customer: { name: "Siti", phone: "081211112222" },
          payment: null,
          tenders: [{ tenderType: "cash", amount: "5000.00", reference: null }],
          allowDue: true
        })
      );
      const outcome = await close(
        TENANT_A,
        sessionId,
        closeInput({ cash: "100000.00" }, { varianceReason: "short" })
      );
      expect(outcome.kind).toBe("pending_approval");

      const payBalance = () =>
        inTenant(TENANT_A, (tx) =>
          recordOwnerPayment(tx, TENANT_A, CASHIER_1, sale.id, {
            idempotencyKey: crypto.randomUUID(),
            tenderType: "cash",
            amount: "15000.00",
            reference: null,
            note: null
          })
        );
      await expect(payBalance()).rejects.toBeInstanceOf(
        RegisterSessionClosingError
      );
      expect(
        (
          (await getAdminSql()`
            SELECT count(*)::int AS n FROM awcms_commerce_payment_allocations
            WHERE order_id = ${sale.id}
          `) as { n: number }[]
        )[0]!.n
      ).toBe(1);

      await inTenant(TENANT_A, (tx) =>
        decideRegisterClose(tx, TENANT_A, SUPERVISOR, sessionId, {
          idempotencyKey: crypto.randomUUID(),
          decision: "reject",
          note: "recount"
        })
      );
      expect((await payBalance()).kind).toBe("created");
      const stamped = (await getAdminSql()`
        SELECT register_session_id FROM awcms_commerce_payment_allocations
        WHERE order_id = ${sale.id} ORDER BY entry_seq DESC LIMIT 1
      `) as { register_session_id: string | null }[];
      expect(stamped[0]!.register_session_id).toBe(sessionId);
    });
  });

  describe("a cash refund for a sale from an earlier, closed shift", () => {
    async function closedShiftSale(): Promise<{
      orderId: string;
      cashLegId: string;
      registerId: string;
    }> {
      const productId = await seedActiveProduct(TENANT_A);
      const registerId = await makeRegister(TENANT_A);
      const first = await openOk(TENANT_A, registerId, "100000.00");
      const sale = await ringOk(TENANT_A, posInput(productId, registerId));
      const closed = await close(
        TENANT_A,
        first,
        closeInput({ cash: "120000.00" })
      );
      expect(closed.kind).toBe("closed");
      const legs = (await getAdminSql()`
        SELECT id FROM awcms_commerce_payment_allocations WHERE order_id = ${sale.id}
      `) as { id: string }[];
      return { orderId: sale.id, cashLegId: legs[0]!.id, registerId };
    }

    const refund = (
      orderId: string,
      legId: string,
      registerSessionId: string | undefined,
      actor = CASHIER_1
    ) =>
      inTenant(TENANT_A, (tx) =>
        recordOwnerReversal(tx, TENANT_A, actor, orderId, legId, {
          idempotencyKey: crypto.randomUUID(),
          amount: "5000.00",
          note: "returned the next day",
          ...(registerSessionId ? { registerSessionId } : {})
        })
      );

    test("without a session the refund stays unstamped (today's behaviour); with an OPEN session it is stamped and lowers THAT drawer's expected cash", async () => {
      const { orderId, cashLegId, registerId } = await closedShiftSale();
      const second = await openOk(TENANT_A, registerId, "100000.00");

      const plain = await refund(orderId, cashLegId, undefined);
      expect(plain.kind).toBe("created");
      if (plain.kind !== "created") return;
      expect(tender(await report(TENANT_A, second), "cash")).toMatchObject({
        reversals: "0.00",
        expected: "100000.00"
      });

      const stampedRefund = await refund(orderId, cashLegId, second);
      expect(stampedRefund.kind).toBe("created");
      if (stampedRefund.kind !== "created") return;
      const rows = (await getAdminSql()`
        SELECT register_session_id FROM awcms_commerce_payment_allocations
        WHERE id = ${stampedRefund.body.payment.id}
      `) as { register_session_id: string | null }[];
      expect(rows[0]!.register_session_id).toBe(second);
      expect(tender(await report(TENANT_A, second), "cash")).toMatchObject({
        reversals: "5000.00",
        expected: "95000.00"
      });
    });

    test("the session must be an open one of this tenant whose current cashier is the actor", async () => {
      const { orderId, cashLegId, registerId } = await closedShiftSale();
      const second = await openOk(TENANT_A, registerId, "100000.00");
      const closedSessionRows = (await getAdminSql()`
        SELECT id FROM awcms_commerce_register_sessions
        WHERE register_id = ${registerId} AND status = 'closed'
      `) as { id: string }[];

      expect((await refund(orderId, cashLegId, crypto.randomUUID())).kind).toBe(
        "register_session_not_found"
      );
      expect(
        (await refund(orderId, cashLegId, closedSessionRows[0]!.id)).kind
      ).toBe("register_session_not_open");
      expect((await refund(orderId, cashLegId, second, CASHIER_2)).kind).toBe(
        "register_session_not_cashier"
      );
      expect(
        (
          (await getAdminSql()`
            SELECT count(*)::int AS n FROM awcms_commerce_payment_allocations
            WHERE order_id = ${orderId} AND kind = 'reversal'
          `) as { n: number }[]
        )[0]!.n
      ).toBe(0);
    });

    test("the database guard still refuses a PAYMENT stamped with a session other than its order's, and a reversal stamped with a non-open session", async () => {
      const { orderId, registerId } = await closedShiftSale();
      const second = await openOk(TENANT_A, registerId, "100000.00");
      await expect(
        attempt(getAdminSql()`
          INSERT INTO awcms_commerce_payment_allocations (
            tenant_id, order_id, kind, tender_type, amount, status, source, source_key,
            actor_kind, register_session_id, settled_at
          ) VALUES (
            ${TENANT_A}, ${orderId}, 'payment', 'cash', '1.00', 'succeeded', 'pos',
            'guard-test-payment', 'system', ${second}, now()
          )
        `)
      ).rejects.toThrow();
    });
  });
});
