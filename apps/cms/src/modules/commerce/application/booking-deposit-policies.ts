/**
 * The per-product deposit policy write path (Issue #378, ADR-0045 D5, ADR-0041
 * D4, owner answer Q2; data model section 4.3).
 *
 * A product without an ACTIVE policy row is paid in full; there is no tenant
 * default. A row is a percent of the line's taxed total or a fixed amount per
 * unit of quantity. The order path (a later issue) reads ONLY this table and
 * snapshots the result on the order as `dp_amount`, so editing a policy never
 * alters an existing order.
 *
 * ## `allow_dp` is a mirror kept in step by the same write (D5)
 *
 * Setting a policy sets `awcms_commerce_products.allow_dp = true`; removing it
 * (`kind: "full"`) retires the row and sets `allow_dp = false`, in one
 * transaction, with the product row locked so two writers cannot interleave.
 * While the tenant's `booking` feature is ON the product form can no longer edit
 * `allow_dp` by itself ({@link assertAllowDpWritable}): the two cannot disagree.
 * Turning `booking` ON is NOT retroactive for a product that already has
 * `allow_dp = true` and no row: that product keeps today's store-wide
 * down-payment rule (the cart quote falls back to it only when no row exists,
 * G10), and is corrected only by writing its policy here.
 *
 * Removal is a retirement (`retired_at`), not a DELETE: the application role has
 * none (`sql/1036`). Writing the SAME policy again is a no-op that still
 * repairs the mirror. Every refusal is returned, never thrown.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import type {
  DepositPolicyKind,
  SetDepositPolicyInput
} from "../domain/booking-adapter";
import { normalizeMoney } from "../domain/price-calculation";
import { fetchCommerceFeatures } from "./commerce-feature-gate";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "commerce_product_deposit_policy";

export type DepositPolicyRecord = {
  kind: DepositPolicyKind;
  /** `numeric(5,2)` as a string; set iff `kind` is `percent`. */
  percent: string | null;
  /** `numeric(14,2)` as a string, PER UNIT of quantity; set iff `kind` is `fixed`. */
  fixedAmount: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProductDepositPolicy = {
  productId: string;
  /** `null` = no active policy = paid in full. */
  policy: DepositPolicyRecord | null;
  /** The mirrored legacy flag. */
  allowDp: boolean;
};

type PolicyRow = {
  kind: DepositPolicyKind;
  percent: string | null;
  fixed_amount: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const iso = (value: Date | string): string => new Date(value).toISOString();

function toRecord(row: PolicyRow): DepositPolicyRecord {
  return {
    kind: row.kind,
    percent: row.percent === null ? null : normalizeMoney(row.percent),
    fixedAmount:
      row.fixed_amount === null ? null : normalizeMoney(row.fixed_amount),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

async function fetchActivePolicyRow(
  tx: Bun.SQL,
  tenantId: string,
  productId: string
): Promise<(PolicyRow & { id: string }) | null> {
  const rows = (await tx`
    SELECT id, kind, percent, fixed_amount, created_at, updated_at
    FROM awcms_commerce_product_deposit_policies
    WHERE tenant_id = ${tenantId} AND product_id = ${productId}
      AND retired_at IS NULL
  `) as (PolicyRow & { id: string })[];
  return rows[0] ?? null;
}

/** `null` for an unknown, foreign-tenant or soft-deleted product, indistinguishably. */
export async function fetchProductDepositPolicy(
  tx: Bun.SQL,
  tenantId: string,
  productId: string
): Promise<ProductDepositPolicy | null> {
  const products = (await tx`
    SELECT allow_dp FROM awcms_commerce_products
    WHERE tenant_id = ${tenantId} AND id = ${productId} AND deleted_at IS NULL
  `) as { allow_dp: boolean }[];
  if (!products[0]) return null;
  const row = await fetchActivePolicyRow(tx, tenantId, productId);
  return {
    productId,
    policy: row ? toRecord(row) : null,
    allowDp: products[0].allow_dp
  };
}

export type SetDepositPolicyOutcome =
  | { kind: "product_not_found" }
  | { kind: "set" | "removed" | "unchanged"; result: ProductDepositPolicy };

/** Sets, replaces or removes a product's deposit policy and mirrors `allow_dp`. */
export async function setProductDepositPolicy(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  productId: string,
  input: SetDepositPolicyInput,
  correlationId?: string
): Promise<SetDepositPolicyOutcome> {
  // The product row lock serialises concurrent writers of one product's policy.
  const products = (await tx`
    SELECT allow_dp FROM awcms_commerce_products
    WHERE tenant_id = ${tenantId} AND id = ${productId} AND deleted_at IS NULL
    FOR UPDATE
  `) as { allow_dp: boolean }[];
  if (!products[0]) return { kind: "product_not_found" };

  const active = await fetchActivePolicyRow(tx, tenantId, productId);
  const wantPercent = input.kind === "percent" ? input.percent : null;
  const wantFixed = input.kind === "fixed" ? input.fixedAmount : null;
  let outcome: "set" | "removed" | "unchanged";

  if (input.kind === "full") {
    if (active) {
      await tx`
        UPDATE awcms_commerce_product_deposit_policies
        SET retired_at = now(), updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${active.id}
      `;
      outcome = "removed";
    } else {
      outcome = "unchanged";
    }
  } else if (
    active &&
    active.kind === input.kind &&
    (active.percent === null ? null : normalizeMoney(active.percent)) ===
      wantPercent &&
    (active.fixed_amount === null
      ? null
      : normalizeMoney(active.fixed_amount)) === wantFixed
  ) {
    outcome = "unchanged";
  } else if (active) {
    await tx`
      UPDATE awcms_commerce_product_deposit_policies
      SET kind = ${input.kind}, percent = ${wantPercent},
          fixed_amount = ${wantFixed}, updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${active.id}
    `;
    outcome = "set";
  } else {
    await tx`
      INSERT INTO awcms_commerce_product_deposit_policies
        (tenant_id, product_id, kind, percent, fixed_amount)
      VALUES (${tenantId}, ${productId}, ${input.kind}, ${wantPercent}, ${wantFixed})
    `;
    outcome = "set";
  }

  const allowDp = input.kind !== "full";
  if (products[0].allow_dp !== allowDp) {
    await tx`
      UPDATE awcms_commerce_products
      SET allow_dp = ${allowDp}, updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${productId}
    `;
  }

  if (outcome !== "unchanged") {
    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId,
      moduleKey: AUDIT_MODULE_KEY,
      action:
        outcome === "removed"
          ? "commerce.product_deposit_policy.removed"
          : "commerce.product_deposit_policy.set",
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: productId,
      message:
        outcome === "removed"
          ? "Product deposit policy removed (full payment)."
          : "Product deposit policy set.",
      attributes: {
        kind: input.kind,
        percent: wantPercent,
        fixedAmount: wantFixed
      },
      correlationId
    });
  }

  const result = (await fetchProductDepositPolicy(tx, tenantId, productId))!;
  return { kind: outcome, result };
}

/** Thrown by {@link assertAllowDpWritable}; the product routes map it to `409 ALLOW_DP_MANAGED_BY_POLICY`. */
export class AllowDpManagedByPolicyError extends Error {
  constructor() {
    super(
      "allowDp is managed by the product's deposit policy while the booking feature is on; set or remove the policy instead."
    );
    this.name = "AllowDpManagedByPolicyError";
  }
}

/**
 * ADR-0045 D5: once the tenant's `booking` feature is on, `allow_dp` follows the
 * deposit policy row and is no longer separately editable. Cheap by design: it
 * queries nothing unless the write would CHANGE the flag.
 */
export async function assertAllowDpWritable(
  tx: Bun.SQL,
  tenantId: string,
  requested: boolean | undefined,
  current: boolean
): Promise<void> {
  if (requested === undefined || requested === current) return;
  const features = await fetchCommerceFeatures(tx, tenantId);
  if (features.booking) throw new AllowDpManagedByPolicyError();
}

export type ServiceProductDepositRow = {
  productId: string;
  name: string;
  sku: string;
  status: string;
  allowDp: boolean;
  /** `null` = no active policy = paid in full. */
  policy: Pick<DepositPolicyRecord, "kind" | "percent" | "fixedAmount"> | null;
};

/**
 * The deposit-policy admin screen's read (Issue #385): every live SERVICE
 * product of the tenant (the only kind an offering can be linked to) with its
 * active policy, one query. Bounded to 200 rows; the screen is a configuration
 * surface, not a catalogue browser.
 */
export async function listServiceProductDepositPolicies(
  tx: Bun.SQL,
  tenantId: string
): Promise<ServiceProductDepositRow[]> {
  const rows = (await tx`
    SELECT p.id, p.name, p.sku, p.status, p.allow_dp,
           d.kind, d.percent, d.fixed_amount
    FROM awcms_commerce_products p
    LEFT JOIN awcms_commerce_product_deposit_policies d
      ON d.tenant_id = p.tenant_id AND d.product_id = p.id AND d.retired_at IS NULL
    WHERE p.tenant_id = ${tenantId} AND p.type = 'service' AND p.deleted_at IS NULL
    ORDER BY p.name ASC, p.id ASC
    LIMIT 200
  `) as {
    id: string;
    name: string;
    sku: string;
    status: string;
    allow_dp: boolean;
    kind: DepositPolicyKind | null;
    percent: string | null;
    fixed_amount: string | null;
  }[];
  return rows.map((row) => ({
    productId: row.id,
    name: row.name,
    sku: row.sku,
    status: row.status,
    allowDp: row.allow_dp,
    policy:
      row.kind === null
        ? null
        : {
            kind: row.kind,
            percent: row.percent === null ? null : normalizeMoney(row.percent),
            fixedAmount:
              row.fixed_amount === null
                ? null
                : normalizeMoney(row.fixed_amount)
          }
  }));
}
