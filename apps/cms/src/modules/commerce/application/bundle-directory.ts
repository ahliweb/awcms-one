/**
 * Bundles (Issue #290, ADR-0036): every database read and write the bundle
 * model needs, in one file. The pure rules live in `domain/bundle.ts`; the
 * stock MOVEMENT is `commerce-inventory.ts`'s (this file only expands lines and
 * keeps the `counter`-mode decrement, so the one-writer rule of ADR-0038 holds).
 *
 * Conventions every query here follows: `tenant_id` is bound explicitly (RLS is
 * defence in depth), ids are batched with `tx.array(..., "uuid")::uuid[]`, and
 * statements run sequentially on the one reserved `tx` connection.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { computeFinalPrice, normalizeMoney } from "../domain/price-calculation";
import {
  buildBundleSnapshot,
  componentLockOrder,
  computeBundleAvailability,
  expandBundleLines,
  validateBundleState,
  validateComponentTargets,
  type BundleComponentInput,
  type BundleLineComponent,
  type BundlePricing,
  type ComponentProductFacts,
  type ComponentStockFact,
  type ExpandableLine,
  type FieldError,
  type ProductKind,
  type ResolvedComponent
} from "../domain/bundle";

const AUDIT_MODULE_KEY = "commerce";

/** A bundle definition was refused; every field error is safe to show an admin. */
export class BundleDefinitionInvalidError extends Error {
  readonly errors: FieldError[];
  constructor(errors: FieldError[]) {
    super(
      `The bundle definition is invalid: ${errors.map((e) => `${e.field} - ${e.message}`).join(" ")}`
    );
    this.name = "BundleDefinitionInvalidError";
    this.errors = errors;
  }
}

type ComponentRow = {
  bundle_product_id: string;
  position: number;
  component_product_id: string;
  component_variant_id: string | null;
  quantity: number;
  product_sku: string;
  product_name: string;
  product_status: string;
  product_stock: number;
  product_price: string;
  product_discount_percent: number;
  product_deleted_at: Date | null;
  variant_value: string | null;
  variant_sku: string | null;
  variant_stock: number | null;
  variant_price: string | null;
  variant_deleted_at: Date | null;
  live_variants: number;
};

function toResolved(row: ComponentRow): ResolvedComponent {
  const sellable =
    row.product_deleted_at === null &&
    row.product_status === "active" &&
    (row.component_variant_id === null
      ? Number(row.live_variants) === 0
      : row.variant_deleted_at === null && row.variant_stock !== null);
  const stock = !sellable
    ? null
    : row.component_variant_id !== null
      ? row.variant_stock
      : row.product_stock;
  const unitPrice =
    row.component_variant_id !== null && row.variant_price !== null
      ? normalizeMoney(row.variant_price)
      : computeFinalPrice(row.product_price, row.product_discount_percent);

  return {
    position: row.position,
    productId: row.component_product_id,
    variantId: row.component_variant_id,
    sku: row.variant_sku ?? row.product_sku,
    name: row.product_name,
    variantName: row.variant_value,
    quantityPerBundle: row.quantity,
    stock,
    unitPrice
  };
}

/**
 * The components of each bundle in `bundleIds`, resolved against the live
 * product/variant rows (stock, list price, sellability), in position order.
 * One round trip however many bundles.
 */
export async function fetchResolvedBundleComponents(
  tx: Bun.SQL,
  tenantId: string,
  bundleIds: readonly string[]
): Promise<Map<string, ResolvedComponent[]>> {
  const map = new Map<string, ResolvedComponent[]>();
  if (bundleIds.length === 0) return map;

  const rows = (await tx`
    SELECT c.bundle_product_id, c.position, c.component_product_id,
           c.component_variant_id, c.quantity,
           p.sku AS product_sku, p.name AS product_name,
           p.status AS product_status, p.stock AS product_stock,
           p.price AS product_price,
           p.discount_percent AS product_discount_percent,
           p.deleted_at AS product_deleted_at,
           v.value AS variant_value, v.sku AS variant_sku,
           v.stock AS variant_stock, v.price AS variant_price,
           v.deleted_at AS variant_deleted_at,
           (
             SELECT count(*)::int FROM awcms_commerce_product_variants lv
             WHERE lv.tenant_id = c.tenant_id
               AND lv.product_id = c.component_product_id
               AND lv.deleted_at IS NULL
           ) AS live_variants
    FROM awcms_commerce_bundle_components c
    JOIN awcms_commerce_products p
      ON p.tenant_id = c.tenant_id AND p.id = c.component_product_id
    LEFT JOIN awcms_commerce_product_variants v
      ON v.tenant_id = c.tenant_id AND v.id = c.component_variant_id
    WHERE c.tenant_id = ${tenantId}
      AND c.bundle_product_id = ANY(${tx.array([...new Set(bundleIds)], "uuid")}::uuid[])
    ORDER BY c.bundle_product_id, c.position
  `) as ComponentRow[];

  for (const row of rows) {
    const list = map.get(row.bundle_product_id) ?? [];
    list.push(toResolved(row));
    map.set(row.bundle_product_id, list);
  }
  return map;
}

/** The public face of one component (no stock count, no cost). */
export type BundleComponentDTO = {
  position: number;
  productId: string;
  variantId: string | null;
  sku: string | null;
  name: string;
  variantName: string | null;
  quantity: number;
};

/** What a product DTO carries for a bundle: the pricing strategy and its contents. */
export type BundleDTO = {
  pricing: BundlePricing;
  discountPercent: string | null;
  components: BundleComponentDTO[];
};

/**
 * Attaches `bundle` to the bundle products among `products` and replaces their
 * `stock` with the computed availability (D4), so every existing reader of a
 * product's `stock` keeps working. A standard product passes through with
 * `bundle: null`.
 */
export async function attachBundles<
  T extends {
    id: string;
    kind: ProductKind;
    stock: number;
    bundlePricing: BundlePricing;
    bundleDiscountPercent: string | null;
  }
>(
  tx: Bun.SQL,
  tenantId: string,
  products: readonly T[]
): Promise<(T & { bundle: BundleDTO | null })[]> {
  const bundleIds = products
    .filter((product) => product.kind === "bundle")
    .map((product) => product.id);
  const resolved = await fetchResolvedBundleComponents(tx, tenantId, bundleIds);

  return products.map((product) => {
    if (product.kind !== "bundle") return { ...product, bundle: null };
    const components = resolved.get(product.id) ?? [];
    return {
      ...product,
      stock: computeBundleAvailability(components),
      bundle: {
        pricing: product.bundlePricing,
        discountPercent: product.bundleDiscountPercent,
        components: components.map((component) => ({
          position: component.position,
          productId: component.productId,
          variantId: component.variantId,
          sku: component.sku,
          name: component.name,
          variantName: component.variantName,
          quantity: component.quantityPerBundle
        }))
      }
    };
  });
}

type FactRow = { id: string; kind: string };
type VariantFactRow = { id: string; product_id: string };

async function fetchComponentFacts(
  tx: Bun.SQL,
  tenantId: string,
  productIds: readonly string[]
): Promise<Map<string, ComponentProductFacts>> {
  const facts = new Map<string, ComponentProductFacts>();
  if (productIds.length === 0) return facts;
  const ids = tx.array([...new Set(productIds)], "uuid");

  const products = (await tx`
    SELECT id, kind FROM awcms_commerce_products
    WHERE tenant_id = ${tenantId} AND id = ANY(${ids}::uuid[]) AND deleted_at IS NULL
  `) as FactRow[];
  const variants = (await tx`
    SELECT id, product_id FROM awcms_commerce_product_variants
    WHERE tenant_id = ${tenantId} AND product_id = ANY(${ids}::uuid[]) AND deleted_at IS NULL
  `) as VariantFactRow[];

  for (const product of products) {
    facts.set(product.id, {
      kind: product.kind as ProductKind,
      liveVariantIds: new Set()
    });
  }
  for (const variant of variants) {
    (
      facts.get(variant.product_id)?.liveVariantIds as Set<string> | undefined
    )?.add(variant.id);
  }
  return facts;
}

export type BundleDefinitionWrite = {
  /** The product's kind AFTER this write. */
  kind: ProductKind;
  pricing: BundlePricing;
  discountPercent: string | null;
  /** `undefined` = leave the components as they are. */
  components: BundleComponentInput[] | undefined;
  /** The product's stock and service form AFTER this write. */
  stock: number;
  hasServiceForm: boolean;
};

type CurrentBundleRow = {
  kind: string;
  bundle_pricing: string;
  bundle_discount_percent: string | null;
};

/**
 * Applies the bundle part of a product create/update: validates the merged
 * state and the component rows, then writes `kind` / pricing / discount and
 * replaces the component list. Called AFTER the product row itself exists, in
 * the same transaction; throws {@link BundleDefinitionInvalidError} (a 400) on
 * any refusal and the route's normal-return commit then rolls nothing partial:
 * the caller invokes this BEFORE its own audit/event writes.
 *
 * Order matters for the database triggers (sql/953): components are cleared
 * before a bundle becomes standard, and `kind` is set before components exist.
 */
export async function applyBundleDefinition(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  productId: string,
  write: BundleDefinitionWrite,
  correlationId?: string
): Promise<void> {
  const current = (await tx`
    SELECT kind, bundle_pricing, bundle_discount_percent
    FROM awcms_commerce_products
    WHERE tenant_id = ${tenantId} AND id = ${productId} AND deleted_at IS NULL
    FOR NO KEY UPDATE
  `) as CurrentBundleRow[];
  const row = current[0];
  if (!row) return;

  let existingCount = 0;
  if (write.components === undefined) {
    const counted = (await tx`
      SELECT count(*)::int AS n FROM awcms_commerce_bundle_components
      WHERE tenant_id = ${tenantId} AND bundle_product_id = ${productId}
    `) as { n: number }[];
    existingCount = Number(counted[0]!.n);
  }
  // A standard product has no components: a bundle turned back loses them below.
  const componentCount =
    write.kind === "standard"
      ? (write.components?.length ?? 0)
      : write.components !== undefined
        ? write.components.length
        : existingCount;

  const errors = validateBundleState({
    kind: write.kind,
    pricing: write.pricing,
    discountPercent: write.discountPercent,
    stock: write.stock,
    hasServiceForm: write.hasServiceForm,
    components: write.components ?? null,
    componentCount
  });

  if (write.kind === "bundle" && write.components !== undefined) {
    const facts = await fetchComponentFacts(
      tx,
      tenantId,
      write.components.map((component) => component.productId)
    );
    errors.push(
      ...validateComponentTargets(productId, write.components, facts)
    );
  }
  if (errors.length > 0) throw new BundleDefinitionInvalidError(errors);

  const wasBundle = row.kind === "bundle";
  const unchanged =
    write.kind === row.kind &&
    write.pricing === row.bundle_pricing &&
    write.discountPercent === (row.bundle_discount_percent ?? null) &&
    write.components === undefined;
  if (unchanged) return;

  try {
    // A bundle turned back into a standard product loses its components first.
    if (wasBundle && write.kind === "standard") {
      await tx`
        DELETE FROM awcms_commerce_bundle_components
        WHERE tenant_id = ${tenantId} AND bundle_product_id = ${productId}
      `;
    }

    await tx`
      UPDATE awcms_commerce_products
      SET kind = ${write.kind},
          bundle_pricing = ${write.kind === "bundle" ? write.pricing : "fixed"},
          bundle_discount_percent = ${write.kind === "bundle" ? write.discountPercent : null},
          stock = CASE WHEN ${write.kind === "bundle"}::boolean THEN 0 ELSE stock END,
          updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${productId}
    `;

    if (write.kind === "bundle" && write.components !== undefined) {
      await tx`
        DELETE FROM awcms_commerce_bundle_components
        WHERE tenant_id = ${tenantId} AND bundle_product_id = ${productId}
      `;
      for (const [index, component] of write.components.entries()) {
        await tx`
          INSERT INTO awcms_commerce_bundle_components (
            tenant_id, bundle_product_id, position, component_product_id,
            component_variant_id, quantity, actor_tenant_user_id
          )
          VALUES (
            ${tenantId}, ${productId}, ${index + 1}, ${component.productId},
            ${component.variantId}, ${component.quantity}, ${actorTenantUserId}
          )
        `;
      }
    }
  } catch (error) {
    // A trigger refusal (a racing nesting attempt, the 20-line cap) is a 400
    // too; the statement aborted the transaction, so nothing partial commits.
    if (
      error instanceof Bun.SQL.PostgresError &&
      String(error.errno) === "23514"
    ) {
      throw new BundleDefinitionInvalidError([
        { field: "bundleComponents", message: error.message }
      ]);
    }
    throw error;
  }

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "bundle.define",
    resourceType: "product",
    resourceId: productId,
    message: `Bundle definition saved (${write.kind}).`,
    // Ids and counts only.
    attributes: {
      kind: write.kind,
      pricing: write.pricing,
      componentCount
    },
    correlationId
  });
}

/** Writes the immutable component snapshot of one just-inserted bundle order line. */
export async function insertBundleSnapshot(
  tx: Bun.SQL,
  tenantId: string,
  orderItemId: string,
  lineTotal: string,
  bundleQuantity: number,
  components: readonly BundleLineComponent[]
): Promise<void> {
  for (const row of buildBundleSnapshot(
    lineTotal,
    bundleQuantity,
    components
  )) {
    await tx`
      INSERT INTO awcms_commerce_order_item_components (
        tenant_id, order_item_id, position, component_product_id,
        component_variant_id, sku, name, variant_name,
        quantity_per_bundle, quantity_total, allocated_value
      )
      VALUES (
        ${tenantId}, ${orderItemId}, ${row.position}, ${row.productId},
        ${row.variantId}, ${row.sku}, ${row.name}, ${row.variantName},
        ${row.quantityPerBundle}, ${row.quantityTotal}, ${row.allocatedValue}
      )
    `;
  }
}

/** `true` when any quoted line is a bundle (the counter-mode pre-lock and re-quote apply). */
export function quoteHasBundle(quote: {
  lines: readonly { bundle?: unknown }[];
}): boolean {
  return quote.lines.some((line) => line.bundle !== undefined);
}

/**
 * `counter` mode: locks every component stock row of the quoted bundle lines
 * (`FOR NO KEY UPDATE`, products then variants, ascending id - one global
 * order, so two orders sharing components cannot deadlock). The caller
 * re-quotes after this returns: the second quote reads the committed counts
 * while this transaction holds the rows, so a sale that lost the race for the
 * last unit answers `cart_changed` before any row of it exists.
 */
export async function lockBundleComponentStock(
  tx: Bun.SQL,
  tenantId: string,
  quote: {
    lines: readonly { bundle?: { components: BundleLineComponent[] } }[];
  }
): Promise<void> {
  const components = quote.lines.flatMap(
    (line) => line.bundle?.components ?? []
  );
  const order = componentLockOrder(components);
  const variantIds = order.filter((u) => u.kind === "variant").map((u) => u.id);
  const productIds = order.filter((u) => u.kind === "product").map((u) => u.id);

  if (productIds.length > 0) {
    await tx`
      SELECT id FROM awcms_commerce_products
      WHERE tenant_id = ${tenantId}
        AND id = ANY(${tx.array(productIds, "uuid")}::uuid[])
      ORDER BY id
      FOR NO KEY UPDATE
    `;
  }
  if (variantIds.length > 0) {
    await tx`
      SELECT id FROM awcms_commerce_product_variants
      WHERE tenant_id = ${tenantId}
        AND id = ANY(${tx.array(variantIds, "uuid")}::uuid[])
      ORDER BY id
      FOR NO KEY UPDATE
    `;
  }
}

/** `counter` mode: takes `quantity per bundle x bundles` off each component's counter, in lock order. */
export async function decrementBundleComponentCounters(
  tx: Bun.SQL,
  tenantId: string,
  components: readonly BundleLineComponent[],
  bundleQuantity: number
): Promise<void> {
  const ordered = [...components].sort((a, b) => {
    const ka = `${a.variantId ? "v" : "p"}|${a.variantId ?? a.productId}`;
    const kb = `${b.variantId ? "v" : "p"}|${b.variantId ?? b.productId}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  for (const component of ordered) {
    const units = component.quantityPerBundle * bundleQuantity;
    if (component.variantId) {
      await tx`
        UPDATE awcms_commerce_product_variants
        SET stock = stock - ${units}, updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${component.variantId}
      `;
    } else {
      await tx`
        UPDATE awcms_commerce_products
        SET stock = stock - ${units}, updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${component.productId}
      `;
    }
  }
}

/** The snapshot facts of the given order items (empty entries for standard lines). */
export async function loadComponentFactsByItem(
  tx: Bun.SQL,
  tenantId: string,
  orderItemIds: readonly string[]
): Promise<Map<string, ComponentStockFact[]>> {
  const map = new Map<string, ComponentStockFact[]>();
  if (orderItemIds.length === 0) return map;

  const rows = (await tx`
    SELECT order_item_id, position, component_product_id,
           component_variant_id, quantity_per_bundle
    FROM awcms_commerce_order_item_components
    WHERE tenant_id = ${tenantId}
      AND order_item_id = ANY(${tx.array([...new Set(orderItemIds)], "uuid")}::uuid[])
    ORDER BY order_item_id, position
  `) as {
    order_item_id: string;
    position: number;
    component_product_id: string;
    component_variant_id: string | null;
    quantity_per_bundle: number;
  }[];

  for (const row of rows) {
    const list = map.get(row.order_item_id) ?? [];
    list.push({
      position: row.position,
      productId: row.component_product_id,
      variantId: row.component_variant_id,
      quantityPerBundle: row.quantity_per_bundle
    });
    map.set(row.order_item_id, list);
  }
  return map;
}

type BundleQuoteLine = {
  productId: string;
  quantity: number;
  lineTotal: string;
  bundle: { components: BundleLineComponent[] };
};

/**
 * Sells one bundle order line: writes its immutable component snapshot, then
 * moves the components' stock - in `ledger` mode by pushing one `sale` line per
 * component onto `ledgerLines` (posted later, sorted with every other line of
 * the order, source line `<orderItemId>:c<position>`), in `counter` mode by
 * decrementing each component's counter (locks were taken before the re-quote).
 * The bundle line itself moves no stock.
 */
export async function sellBundleLine(
  tx: Bun.SQL,
  tenantId: string,
  mode: "counter" | "ledger",
  orderItemId: string,
  line: BundleQuoteLine,
  ledgerLines: ExpandableLine[]
): Promise<void> {
  await insertBundleSnapshot(
    tx,
    tenantId,
    orderItemId,
    line.lineTotal,
    line.quantity,
    line.bundle.components
  );

  if (mode === "ledger") {
    ledgerLines.push(
      ...expandBundleLines(
        [
          {
            lineId: orderItemId,
            productId: line.productId,
            variantId: null,
            quantity: line.quantity
          }
        ],
        new Map([[orderItemId, line.bundle.components]])
      )
    );
  } else {
    await decrementBundleComponentCounters(
      tx,
      tenantId,
      line.bundle.components,
      line.quantity
    );
  }
}

/**
 * `counter` mode: puts the components of cancelled/expired (or returned) bundle
 * lines back on their own counters, merged per stock unit and applied in the
 * same ascending-id order the sale used.
 */
export async function restockBundleComponentCounters(
  tx: Bun.SQL,
  tenantId: string,
  bundles: readonly {
    quantity: number;
    components: readonly ComponentStockFact[];
  }[]
): Promise<void> {
  const units = new Map<
    string,
    { kind: "variant" | "product"; id: string; quantity: number }
  >();
  for (const bundle of bundles) {
    for (const component of bundle.components) {
      const kind = component.variantId ? "variant" : "product";
      const id = component.variantId ?? component.productId;
      const key = `${kind}|${id}`;
      const entry = units.get(key) ?? { kind, id, quantity: 0 };
      entry.quantity += component.quantityPerBundle * bundle.quantity;
      units.set(key, entry);
    }
  }
  for (const unit of [...units.values()].sort((a, b) =>
    `${a.kind}|${a.id}` < `${b.kind}|${b.id}` ? -1 : 1
  )) {
    if (unit.kind === "variant") {
      await tx`
        UPDATE awcms_commerce_product_variants
        SET stock = stock + ${unit.quantity}, updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${unit.id}
      `;
    } else {
      await tx`
        UPDATE awcms_commerce_products
        SET stock = stock + ${unit.quantity}, updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${unit.id}
      `;
    }
  }
}
