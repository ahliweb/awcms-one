/**
 * The inventory boundary of a return (Issue #287, ADR-0033 D3).
 *
 * `commerce` today keeps ONE stock count per product or variant
 * (`awcms_commerce_products.stock` / `awcms_commerce_product_variants.stock`)
 * - the count an order decrements at creation and the order-expiry job
 * restores. The multi-location inventory ledger of issue #282 is AWCMS
 * upstream-first and is NOT here yet. A return therefore talks to inventory
 * through THIS small port, and nothing else in the return code touches a
 * stock column: #282 landed as one new implementation of
 * {@link ReturnInventoryPort} ({@link ledgerInventoryPort}) beside
 * {@link singleCountInventoryPort}, and {@link modeAwareInventoryPort} - the
 * default - picks between them per tenant; no return, refund or report code
 * changed.
 *
 * ## What the port is told, and what it must do
 *
 * It receives the lines of ONE return, each with its disposition:
 *
 *   - `restock`   - the unit is sellable again: the port puts it back.
 *   - `damaged`   - the unit is not sellable (written off).
 *   - `quarantine`- the unit is held, not sellable until someone decides.
 *
 * Only `restock` changes SELLABLE stock. `damaged` and `quarantine` change
 * nothing here by design: the single-count model has no "non-sellable on-hand"
 * bucket, and inventing one would be a second stock concept the multi-location
 * ledger would then have to reconcile. They are RECORDED - on the return line
 * (immutable, with the reason and the quantity) - which is the audit trail #282
 * will turn into movements into a damaged / quarantine location.
 *
 * The call runs inside the caller's transaction (so the stock change commits
 * or rolls back with the return rows) and makes no network call. It returns
 * the units actually put back into sellable stock, which the caller checks
 * against the return line's own `stock_effect`.
 */
import {
  postReturnRestock,
  resolveInventoryConfig,
  type InventoryConfig
} from "./commerce-inventory";

export type ReturnStockLine = {
  /** The return these lines belong to (the ledger source id). */
  returnId: string;
  returnLineId: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  disposition: "restock" | "damaged" | "quarantine";
};

/**
 * Who is recording the return and under which request: the ledger implementation
 * stamps both on its movements (Issue #282). Optional, so a caller or fake that
 * predates it keeps working.
 */
export type ReturnInventoryContext = {
  actorTenantUserId?: string | null;
  correlationId?: string;
};

export interface ReturnInventoryPort {
  applyReturn(
    tx: Bun.SQL,
    tenantId: string,
    lines: readonly ReturnStockLine[],
    context?: ReturnInventoryContext
  ): Promise<{ restockedUnits: number }>;
}

/**
 * The default implementation: the existing single stock count. The same
 * statements the order-expiry restock runs (`order-directory.ts`'s
 * `restockCancelledOrRefreshedOrder`), for the units whose disposition is
 * `restock` only. Lines are applied in a deterministic order so two returns
 * touching the same products cannot deadlock on the stock rows.
 */
export const singleCountInventoryPort: ReturnInventoryPort = {
  async applyReturn(tx, tenantId, lines) {
    const restock = lines
      .filter((line) => line.disposition === "restock")
      .sort((a, b) =>
        `${a.variantId ?? a.productId}`.localeCompare(
          `${b.variantId ?? b.productId}`
        )
      );
    let restockedUnits = 0;
    for (const line of restock) {
      if (line.variantId) {
        await tx`
          UPDATE awcms_commerce_product_variants
          SET stock = stock + ${line.quantity}, updated_at = now()
          WHERE tenant_id = ${tenantId} AND id = ${line.variantId}
        `;
      } else {
        await tx`
          UPDATE awcms_commerce_products
          SET stock = stock + ${line.quantity}, updated_at = now()
          WHERE tenant_id = ${tenantId} AND id = ${line.productId}
        `;
      }
      restockedUnits += line.quantity;
    }
    return { restockedUnits };
  }
};

/**
 * The `ledger`-mode implementation (Issue #282, ADR-0038 D2): every `restock`
 * unit is a `sale_return` posted through `InventoryLedgerPort`, source
 * `{commerce_return, returnId, returnLineId}`, and the stock cache is written
 * through from the balance the post returns. `damaged` and `quarantine` change
 * nothing here, exactly as in the counter model - they stay recorded on the
 * immutable return line until a non-sellable location exists.
 *
 * The ledger takes a return's id from the lines' own `returnId`: every line of
 * one `applyReturn` call belongs to the same return, and the first line names it.
 */
export function ledgerInventoryPort(
  config: Extract<InventoryConfig, { mode: "ledger" }>
): ReturnInventoryPort {
  return {
    async applyReturn(tx, tenantId, lines, context) {
      const restock = lines.filter((line) => line.disposition === "restock");
      if (restock.length === 0) return { restockedUnits: 0 };

      await postReturnRestock(
        tx,
        tenantId,
        config,
        restock[0]!.returnId,
        restock.map((line) => ({
          lineId: line.returnLineId,
          productId: line.productId,
          variantId: line.variantId,
          quantity: line.quantity
        })),
        {
          actorTenantUserId: context?.actorTenantUserId ?? null,
          correlationId: context?.correlationId
        }
      );

      return {
        restockedUnits: restock.reduce((sum, line) => sum + line.quantity, 0)
      };
    }
  };
}

/**
 * The default: asks the tenant's stock authority (under the shared mode lock)
 * and delegates, so a return recorded in `counter` mode behaves byte-for-byte as
 * before and one recorded in `ledger` mode posts to the ledger.
 */
export const modeAwareInventoryPort: ReturnInventoryPort = {
  async applyReturn(tx, tenantId, lines, context) {
    const config = await resolveInventoryConfig(tx, tenantId);

    return config.mode === "ledger"
      ? ledgerInventoryPort(config).applyReturn(tx, tenantId, lines, context)
      : singleCountInventoryPort.applyReturn(tx, tenantId, lines, context);
  }
};
