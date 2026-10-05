/**
 * The commerce <-> `tax` module seam (Issue #293, ADR-0039; upstream ADR-0127,
 * `docs/awcms/tax-calculation.md` §11). Everything here runs inside the CALLER's
 * tenant transaction and calls the tax module's application functions in
 * process — the accepted pattern (commerce already calls `email`/`logging` the
 * same way). There is no network call and no `_shared/ports/` tax port: the
 * tax module is a declared dependency of commerce.
 *
 * ## What lives where
 *
 * - `fetchTaxAdapterConfig` / `setTaxAdapterConfig` — the per-tenant mode
 *   (`flat` | `engine`) and profile code, real columns on
 *   `awcms_commerce_store_settings` (`sql/948`).
 * - `resolveCartTaxContext` — engine mode only: resolves the published version
 *   for the store's business date and the products' tax categories, so the pure
 *   `quoteCart` never touches the database.
 * - `finaliseOrderTax` — order placement: finalises the snapshot for the order,
 *   stores its id on the order, and FAILS CLOSED if the snapshot's tax is not the
 *   figure the order was priced with (it never recomputes locally).
 * - `reverseOrderTaxForReturn` / `reverseOrderTaxForCancellation` — reverse from
 *   the ORIGINAL snapshot (never today's rule) through the module's own reversal.
 *
 * Every function is a no-op in flat mode and for an order with no snapshot
 * (flat-mode or pre-cut-over orders keep the amounts they were issued with —
 * `tax-calculation.md` §11 E).
 */
import { computeRequestHash } from "../../_shared/idempotency";
import { recordAuditEvent } from "../../logging/application/audit-log";
import { publishSnapshotEvent } from "../../tax/application/tax-event-publisher";
import { resolveRuleVersion } from "../../tax/application/tax-rule-version-directory";
import {
  finaliseSnapshot,
  reverseSnapshot,
  type SnapshotView
} from "../../tax/application/tax-snapshot-directory";
import { TAX_MODULE_KEY } from "../../tax/domain/tax-permissions";
import { calculateTax } from "../../tax/domain/tax-calculator";
import { SALES_REPORT_TIME_ZONE } from "../domain/sales-report-deltas";
import type { CartQuoteResult } from "../domain/cart-quote";
import {
  DEFAULT_TAX_PROFILE_CODE,
  TAX_ORDER_DOCUMENT_TYPE,
  businessDateInTimeZone,
  buildTaxLineInputs,
  isTaxMode,
  type CartQuoteTaxContext,
  type TaxMode
} from "../domain/tax-adapter";
import { fromCents, toCents } from "../domain/price-calculation";
import { fetchStoreSettings } from "./store-settings-directory";

export type TaxAdapterConfig = { mode: TaxMode; profileCode: string };

export const FLAT_TAX_ADAPTER_CONFIG: TaxAdapterConfig = {
  mode: "flat",
  profileCode: DEFAULT_TAX_PROFILE_CODE
};

/**
 * The tenant's tax mode. A tenant with no settings row reads as `flat` — the
 * default. `resetStoreSettings` never stamps an engine-mode row for purge (it
 * resets the blob in place), so the mode survives a settings reset and
 * retention.
 */
export async function fetchTaxAdapterConfig(
  tx: Bun.SQL,
  tenantId: string
): Promise<TaxAdapterConfig> {
  const rows = (await tx`
    SELECT tax_mode, tax_profile_code
    FROM awcms_commerce_store_settings
    WHERE tenant_id = ${tenantId}
  `) as { tax_mode: string; tax_profile_code: string }[];
  const row = rows[0];

  if (!row || !isTaxMode(row.tax_mode)) return FLAT_TAX_ADAPTER_CONFIG;

  return { mode: row.tax_mode, profileCode: row.tax_profile_code };
}

/**
 * Writes the mode. Audited (the cut-over and its rollback are the same audited
 * setting change — ADR-0039 D4). Creates the settings row from the defaults when
 * the tenant never saved any, so the switch has somewhere to live; a live row's
 * `settings` blob is never touched, and a RESET (purge-stamped) row is revived on
 * the defaults so retention can never erase the mode.
 */
export async function setTaxAdapterConfig(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string | null,
  next: TaxAdapterConfig,
  attributes: Record<string, unknown>,
  correlationId?: string
): Promise<{ previous: TaxAdapterConfig }> {
  const previous = await fetchTaxAdapterConfig(tx, tenantId);
  const defaults = await fetchStoreSettings(tx, tenantId);

  await tx`
    INSERT INTO awcms_commerce_store_settings
      (tenant_id, settings, tax_mode, tax_profile_code, deleted_at)
    VALUES (${tenantId}, ${defaults}::jsonb, ${next.mode}, ${next.profileCode}, NULL)
    ON CONFLICT (tenant_id) DO UPDATE
      SET tax_mode = EXCLUDED.tax_mode,
          tax_profile_code = EXCLUDED.tax_profile_code,
          -- A RESET row (stamped for purge) would take the mode with it when the
          -- retention engine removes it: bring it back to life on the defaults.
          settings = CASE
            WHEN awcms_commerce_store_settings.deleted_at IS NOT NULL
              THEN EXCLUDED.settings
            ELSE awcms_commerce_store_settings.settings
          END,
          deleted_at = NULL,
          updated_at = now()
  `;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId: actorTenantUserId ?? undefined,
    moduleKey: "commerce",
    action: "tax_mode.update",
    resourceType: "store_settings",
    resourceId: tenantId,
    severity: "critical",
    message: `Commerce tax mode ${previous.mode} -> ${next.mode} (profile ${next.profileCode}).`,
    attributes: {
      previousMode: previous.mode,
      mode: next.mode,
      profileCode: next.profileCode,
      ...attributes
    },
    correlationId
  });

  return { previous };
}

/** `product id -> tax category code` (`null` = standard). Products with no row are absent. */
export async function fetchProductTaxCategories(
  tx: Bun.SQL,
  tenantId: string,
  productIds: readonly string[]
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();

  if (productIds.length === 0) return map;

  const rows = (await tx`
    SELECT id, tax_category_code
    FROM awcms_commerce_products
    WHERE tenant_id = ${tenantId}
      AND id = ANY(${tx.array([...new Set(productIds)], "uuid")}::uuid[])
      AND deleted_at IS NULL
  `) as { id: string; tax_category_code: string | null }[];

  for (const row of rows) map.set(row.id, row.tax_category_code);

  return map;
}

/**
 * The tax input of a quote. Flat mode: `{ mode: "flat" }` and not one extra
 * query beyond the config read. Engine mode: the published version for the
 * store's business date today plus the products' categories.
 */
export async function resolveCartTaxContext(
  tx: Bun.SQL,
  tenantId: string,
  productIds: readonly string[],
  now: Date
): Promise<CartQuoteTaxContext> {
  const config = await fetchTaxAdapterConfig(tx, tenantId);

  if (config.mode === "flat") return { mode: "flat" };

  const taxDate = businessDateInTimeZone(now, SALES_REPORT_TIME_ZONE);

  return {
    mode: "engine",
    profileCode: config.profileCode,
    taxDate,
    version: await resolveRuleVersion(
      tx,
      tenantId,
      config.profileCode,
      taxDate
    ),
    categoryByProductId: await fetchProductTaxCategories(
      tx,
      tenantId,
      productIds
    )
  };
}

export class OrderTaxMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderTaxMismatchError";
  }
}

/** The order-side figures `finaliseOrderTax` needs, from the `quote` the order was priced with. */
export type FinaliseOrderTaxInput = {
  orderId: string;
  /** `[orderItemId, quote line]` in quote order — the snapshot's `lineRef` is the order item id. */
  items: { orderItemId: string; productId: string }[];
  quote: CartQuoteResult;
  now: Date;
  actorTenantUserId: string | null;
  correlationId?: string;
};

/**
 * Finalises the order's tax snapshot (engine mode only) and links it. Call after
 * the order and its items exist, inside the same transaction.
 *
 * The tax is NOT recomputed from the order's columns: the quote already ran the
 * calculator with the same version, the same date and the same inputs, so the
 * snapshot's total must equal the figure the order was inserted with. If it does
 * not (a rule published between the quote and the finalise, in the same
 * transaction's snapshot of the world, is impossible — but a bug is not), the
 * order fails closed with `OrderTaxMismatchError` instead of carrying two
 * different tax figures. Replays are free: `finaliseSnapshot` is naturally
 * idempotent on `(order, orderId)`.
 */
export async function finaliseOrderTax(
  tx: Bun.SQL,
  tenantId: string,
  input: FinaliseOrderTaxInput
): Promise<SnapshotView | null> {
  const { quote } = input;

  if (quote.tax.mode !== "engine" || !quote.tax.engine) return null;

  const config = await fetchTaxAdapterConfig(tx, tenantId);
  const taxDate = businessDateInTimeZone(input.now, SALES_REPORT_TIME_ZONE);
  const version = await resolveRuleVersion(
    tx,
    tenantId,
    config.profileCode,
    taxDate
  );

  if (!version) {
    throw new OrderTaxMismatchError(
      `No published rule version for profile "${config.profileCode}" covers ${taxDate}.`
    );
  }

  const categories = await fetchProductTaxCategories(
    tx,
    tenantId,
    input.items.map((item) => item.productId)
  );
  const discountCents = toCents(quote.discount);
  const lineInputs = buildTaxLineInputs(
    quote.lines.map((line, index) => ({
      lineRef: input.items[index]!.orderItemId,
      categoryCode: categories.get(line.productId) ?? null,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal
    })),
    discountCents
  );
  const calculation = calculateTax(version, lineInputs);
  const inputHash = computeRequestHash({
    profileCode: version.profileCode,
    taxDate,
    documentType: TAX_ORDER_DOCUMENT_TYPE,
    documentId: input.orderId,
    lines: lineInputs
  });
  const outcome = await finaliseSnapshot(
    tx,
    tenantId,
    input.actorTenantUserId as string,
    {
      documentType: TAX_ORDER_DOCUMENT_TYPE,
      documentId: input.orderId,
      taxDate,
      version,
      calculation,
      inputHash
    }
  );

  if (outcome.kind === "conflict") {
    throw new OrderTaxMismatchError(
      `Order ${input.orderId} already has a tax snapshot finalised from a different request.`
    );
  }

  const snapshot = outcome.snapshot;

  if (toCents(snapshot.taxTotal) !== toCents(quote.tax.amount)) {
    throw new OrderTaxMismatchError(
      `The tax snapshot (${snapshot.taxTotal}) differs from the tax the order was priced with (${quote.tax.amount}).`
    );
  }

  await tx`
    UPDATE awcms_commerce_orders
    SET tax_snapshot_id = ${snapshot.id}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${input.orderId}
  `;

  if (outcome.kind === "created") {
    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: input.actorTenantUserId ?? undefined,
      moduleKey: TAX_MODULE_KEY,
      action: "tax.snapshot.finalise",
      resourceType: "tax_snapshot",
      resourceId: snapshot.id,
      severity: "info",
      message: "Document tax finalised.",
      attributes: {
        documentType: snapshot.documentType,
        documentId: snapshot.documentId,
        profileCode: snapshot.profileCode,
        versionNo: snapshot.versionNo,
        taxDate: snapshot.taxDate,
        backdated: false,
        netTotal: snapshot.netTotal,
        taxTotal: snapshot.taxTotal,
        grossTotal: snapshot.grossTotal,
        origin: "commerce"
      },
      correlationId: input.correlationId
    });
    await publishSnapshotEvent(tx, tenantId, snapshot, {
      // An anonymous storefront order has no tenant user; the outbox accepts null.
      actorTenantUserId: input.actorTenantUserId as string,
      correlationId: input.correlationId
    });
  }

  return snapshot;
}

async function fetchOrderSnapshotId(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<string | null> {
  const rows = (await tx`
    SELECT tax_snapshot_id FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId} AND id = ${orderId}
  `) as { tax_snapshot_id: string | null }[];

  return rows[0]?.tax_snapshot_id ?? null;
}

export type ReverseOrderTaxResult =
  | { kind: "skipped" }
  | { kind: "reversed" | "replayed"; snapshot: SnapshotView }
  | { kind: "invalid"; message: string };

async function reverseFromOriginal(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string | null,
  args: {
    orderId: string;
    documentId: string;
    requested: { lineRef: string; quantity: string }[] | null;
    reason: string;
    correlationId?: string;
  }
): Promise<ReverseOrderTaxResult> {
  const originalId = await fetchOrderSnapshotId(tx, tenantId, args.orderId);

  if (!originalId) return { kind: "skipped" };

  const outcome = await reverseSnapshot(
    tx,
    tenantId,
    actorTenantUserId as string,
    {
      originalId,
      documentId: args.documentId,
      requested: args.requested,
      // The reversal reports in the period it happened in: the SERVER's date,
      // exactly as an omitted `taxDate` does on the API (`tax-calculation.md` §6).
      taxDate: null,
      reason: args.reason,
      inputHash: computeRequestHash({
        originalId,
        documentId: args.documentId,
        lines: args.requested,
        reason: args.reason
      })
    }
  );

  if (outcome.kind === "invalid") {
    return { kind: "invalid", message: outcome.message };
  }

  if (outcome.kind === "original_not_found") {
    // The snapshot aged out under retention (it is not an FK target): nothing to reverse from.
    return { kind: "skipped" };
  }

  if (outcome.kind === "conflict") {
    return {
      kind: "invalid",
      message: `Reversal document ${args.documentId} was already used with a different request.`
    };
  }

  if (outcome.kind === "created") {
    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: actorTenantUserId ?? undefined,
      moduleKey: TAX_MODULE_KEY,
      action: "tax.snapshot.reverse",
      resourceType: "tax_snapshot",
      resourceId: outcome.snapshot.id,
      severity: "critical",
      message: "Document tax reversed.",
      attributes: {
        originalSnapshotId: originalId,
        documentType: outcome.snapshot.documentType,
        documentId: outcome.snapshot.documentId,
        taxTotal: outcome.snapshot.taxTotal,
        grossTotal: outcome.snapshot.grossTotal,
        reason: outcome.snapshot.reason,
        backdated: false,
        origin: "commerce"
      },
      correlationId: args.correlationId
    });
    await publishSnapshotEvent(tx, tenantId, outcome.snapshot, {
      actorTenantUserId: actorTenantUserId as string,
      correlationId: args.correlationId
    });
  }

  return {
    kind: outcome.kind === "created" ? "reversed" : "replayed",
    snapshot: outcome.snapshot
  };
}

/**
 * A return reverses the tax of exactly the units returned, from the order's
 * ORIGINAL snapshot. The mapping onto the tax module's reversal API (§6):
 * each returned order line becomes one reversal line `{ lineRef: <order item id>,
 * quantity: <units returned> }`; the module takes `round(original x q / Q)` of the
 * line's net and of each component (the exact remainder when the last units
 * come back), capped at what earlier reversals left. The return's own id is the
 * reversal's `documentId`, so a replay of the same return is idempotent.
 *
 * Returns `skipped` for an order with no snapshot (flat mode / pre-cut-over).
 */
export async function reverseOrderTaxForReturn(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string | null,
  args: {
    orderId: string;
    returnId: string;
    lines: { orderItemId: string; quantity: number }[];
    correlationId?: string;
  }
): Promise<ReverseOrderTaxResult> {
  return reverseFromOriginal(tx, tenantId, actorTenantUserId, {
    orderId: args.orderId,
    documentId: `return:${args.returnId}`,
    requested: args.lines.map((line) => ({
      lineRef: line.orderItemId,
      quantity: String(line.quantity)
    })),
    reason: "return",
    correlationId: args.correlationId
  });
}

/**
 * A cancelled or expired order reverses whatever tax is still standing on its
 * snapshot (every line not already reversed by a return). A no-op when nothing
 * is left or the order carries no snapshot.
 */
export async function reverseOrderTaxForCancellation(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string | null,
  args: {
    orderId: string;
    reason: "order_cancelled" | "order_expired";
    correlationId?: string;
  }
): Promise<ReverseOrderTaxResult> {
  return reverseFromOriginal(tx, tenantId, actorTenantUserId, {
    orderId: args.orderId,
    documentId: `${args.reason}:${args.orderId}`,
    requested: null,
    reason: args.reason,
    correlationId: args.correlationId
  });
}

// Re-exported for the cut-over script (the composition root) and tests.
export { fromCents };
