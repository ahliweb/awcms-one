/**
 * Item kits / product bundles - Issue #290 (ADR-0036). Pure: no database, no
 * I/O, no import from another module. Everything that can be decided without a
 * connection is decided here so it is unit-testable: the definition's shape,
 * the nesting rule, the availability arithmetic, derived pricing, the
 * allocation of a bundle line's value across its components and the ledger
 * source-line scheme.
 *
 * ## The model in one paragraph
 *
 * A bundle is a product with `kind = 'bundle'`. It has no variants and no
 * stock of its own; its 1-20 components each name a component product (and a
 * variant when that product has live variants) and a quantity per bundle.
 * Nesting is refused, so a component is always a standard product and a cycle
 * cannot exist. A bundle sells as ONE order line; the components are what the
 * stock movement touches.
 *
 * ## Money
 *
 * Every figure is an integer-cent `bigint` (ADR-0003) via `price-calculation`'s
 * `toCents`/`fromCents`; a percentage with two decimals is carried as integer
 * hundredths of a percent (`12.50` -> `1250`). Rounding is half-up to the cent,
 * the rule `computeFinalPrice` already uses.
 */
import { fromCents, toCents } from "./price-calculation";

export const PRODUCT_KINDS = ["standard", "bundle"] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

/**
 * `fixed` is the bundle product's own price; `derived` is the sum of the
 * components' list prices x quantity less `bundleDiscountPercent`. A further
 * strategy is a versioned extension (a new value here and in sql/953's CHECK),
 * never a free-form formula.
 */
export const BUNDLE_PRICING_STRATEGIES = ["fixed", "derived"] as const;
export type BundlePricing = (typeof BUNDLE_PRICING_STRATEGIES)[number];

export const MIN_BUNDLE_COMPONENTS = 1;
export const MAX_BUNDLE_COMPONENTS = 20;
export const MAX_COMPONENT_QUANTITY = 10_000;

export function isProductKind(value: unknown): value is ProductKind {
  return value === "standard" || value === "bundle";
}

export function isBundlePricing(value: unknown): value is BundlePricing {
  return value === "fixed" || value === "derived";
}

export type FieldError = { field: string; message: string };

/** One line of a bundle definition as an admin submits it. */
export type BundleComponentInput = {
  productId: string;
  variantId: string | null;
  quantity: number;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Integer hundredths of a percent (`0..10000`) from `12`, `"12.5"` or
 * `"12.50"`; `null` when it is not a percentage with at most two decimals in
 * `0..100`. Never goes through a float for a string input.
 */
export function parsePercentHundredths(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value > 100) return null;
    const hundredths = Math.round(value * 100);
    return Math.abs(hundredths / 100 - value) < 1e-9 ? hundredths : null;
  }
  if (typeof value !== "string") return null;
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0") || "0");
  const hundredths = whole * 100 + fraction;
  return hundredths > 10_000 ? null : hundredths;
}

/** `1250` -> `"12.50"` (the `numeric(5,2)` text). */
export function formatPercentHundredths(hundredths: number): string {
  const whole = Math.trunc(hundredths / 100);
  const fraction = String(hundredths % 100).padStart(2, "0");
  return `${whole}.${fraction}`;
}

export type BundleDefinitionFields = {
  kind?: ProductKind;
  bundlePricing?: BundlePricing;
  /** `numeric(5,2)` text, or `null` to clear. */
  bundleDiscountPercent?: string | null;
  bundleComponents?: BundleComponentInput[];
};

/**
 * Shape-validates the bundle fields of a create/update body, keeping only the
 * keys that were sent (an update's "absent means unchanged"). Cross-field and
 * cross-row rules are {@link validateBundleState} and
 * {@link validateComponentTargets}.
 */
export function validateBundleDefinitionFields(
  record: Record<string, unknown>,
  errors: FieldError[]
): BundleDefinitionFields {
  const value: BundleDefinitionFields = {};

  if (record.kind !== undefined) {
    if (isProductKind(record.kind)) value.kind = record.kind;
    else {
      errors.push({
        field: "kind",
        message: `kind must be one of: ${PRODUCT_KINDS.join(", ")}.`
      });
    }
  }

  if (record.bundlePricing !== undefined) {
    if (isBundlePricing(record.bundlePricing)) {
      value.bundlePricing = record.bundlePricing;
    } else {
      errors.push({
        field: "bundlePricing",
        message: `bundlePricing must be one of: ${BUNDLE_PRICING_STRATEGIES.join(", ")}.`
      });
    }
  }

  if (record.bundleDiscountPercent !== undefined) {
    if (record.bundleDiscountPercent === null) {
      value.bundleDiscountPercent = null;
    } else {
      const hundredths = parsePercentHundredths(record.bundleDiscountPercent);
      if (hundredths === null) {
        errors.push({
          field: "bundleDiscountPercent",
          message:
            "bundleDiscountPercent must be a percentage from 0 to 100 with at most two decimals, or null."
        });
      } else {
        value.bundleDiscountPercent = formatPercentHundredths(hundredths);
      }
    }
  }

  if (record.bundleComponents !== undefined) {
    const raw = record.bundleComponents;
    if (!Array.isArray(raw)) {
      errors.push({
        field: "bundleComponents",
        message: "bundleComponents must be an array."
      });
    } else if (raw.length > MAX_BUNDLE_COMPONENTS) {
      errors.push({
        field: "bundleComponents",
        message: `A bundle has at most ${MAX_BUNDLE_COMPONENTS} component lines.`
      });
    } else {
      const components: BundleComponentInput[] = [];
      raw.forEach((entry, index) => {
        const field = `bundleComponents[${index}]`;
        if (typeof entry !== "object" || entry === null) {
          errors.push({ field, message: "Each component must be an object." });
          return;
        }
        const item = entry as Record<string, unknown>;
        const productOk =
          typeof item.productId === "string" &&
          UUID_PATTERN.test(item.productId);
        const variantOk =
          item.variantId === undefined ||
          item.variantId === null ||
          (typeof item.variantId === "string" &&
            UUID_PATTERN.test(item.variantId));
        const quantityOk =
          typeof item.quantity === "number" &&
          Number.isInteger(item.quantity) &&
          item.quantity >= 1 &&
          item.quantity <= MAX_COMPONENT_QUANTITY;
        if (!productOk) {
          errors.push({
            field: `${field}.productId`,
            message: "productId must be a UUID."
          });
        }
        if (!variantOk) {
          errors.push({
            field: `${field}.variantId`,
            message: "variantId must be a UUID or null."
          });
        }
        if (!quantityOk) {
          errors.push({
            field: `${field}.quantity`,
            message: `quantity must be an integer from 1 to ${MAX_COMPONENT_QUANTITY}.`
          });
        }
        if (productOk && variantOk && quantityOk) {
          components.push({
            productId: item.productId as string,
            variantId: (item.variantId as string | null | undefined) ?? null,
            quantity: item.quantity as number
          });
        }
      });
      value.bundleComponents = components;
    }
  }

  return value;
}

export type BundleState = {
  kind: ProductKind;
  pricing: BundlePricing;
  discountPercent: string | null;
  stock: number;
  hasServiceForm: boolean;
  /** `null` when the caller is not changing the components (an update). */
  components: readonly BundleComponentInput[] | null;
  /** How many component lines the bundle will hold after the write. */
  componentCount: number;
};

/**
 * The cross-field rules of a bundle's own columns, over the MERGED next state:
 * a standard product carries no bundle settings; a bundle has no stock of its
 * own, is not a service product, has 1-20 components, and a discount percent
 * only makes sense for `derived`.
 */
export function validateBundleState(state: BundleState): FieldError[] {
  const errors: FieldError[] = [];

  if (state.kind === "standard") {
    if (state.pricing !== "fixed") {
      errors.push({
        field: "bundlePricing",
        message: "bundlePricing applies to bundles only."
      });
    }
    if (state.discountPercent !== null) {
      errors.push({
        field: "bundleDiscountPercent",
        message: "bundleDiscountPercent applies to bundles only."
      });
    }
    if (state.componentCount > 0) {
      errors.push({
        field: "bundleComponents",
        message: "Only a bundle has components."
      });
    }
    return errors;
  }

  if (state.stock !== 0) {
    errors.push({
      field: "stock",
      message:
        "A bundle has no stock of its own: its availability is computed from its components."
    });
  }
  if (state.hasServiceForm) {
    errors.push({
      field: "serviceForm",
      message: "A bundle cannot be a service product."
    });
  }
  if (state.pricing === "fixed" && state.discountPercent !== null) {
    errors.push({
      field: "bundleDiscountPercent",
      message: "bundleDiscountPercent applies to derived pricing only."
    });
  }
  if (
    state.componentCount < MIN_BUNDLE_COMPONENTS ||
    state.componentCount > MAX_BUNDLE_COMPONENTS
  ) {
    errors.push({
      field: "bundleComponents",
      message: `A bundle has ${MIN_BUNDLE_COMPONENTS} to ${MAX_BUNDLE_COMPONENTS} component lines.`
    });
  }
  return errors;
}

/** What the directory read about one candidate component product. */
export type ComponentProductFacts = {
  kind: ProductKind;
  /** Ids of its LIVE variants. */
  liveVariantIds: ReadonlySet<string>;
};

/**
 * The row-dependent rules of a component list, evaluated over facts the caller
 * read inside the same RLS-scoped transaction. `facts` holds only the LIVE,
 * same-tenant products: an unknown, soft-deleted or cross-tenant id is absent,
 * and all three are refused with the SAME message (the tenant-probing rule).
 *
 * No nesting: a component whose product is itself a bundle is refused, and so
 * is a bundle naming itself, so no cycle can ever be written (sql/953's trigger
 * enforces the same rule under concurrency).
 */
export function validateComponentTargets(
  bundleProductId: string | null,
  components: readonly BundleComponentInput[],
  facts: ReadonlyMap<string, ComponentProductFacts>
): FieldError[] {
  const errors: FieldError[] = [];
  const seen = new Set<string>();

  components.forEach((component, index) => {
    const field = `bundleComponents[${index}]`;
    const key = `${component.productId}|${component.variantId ?? ""}`;
    if (seen.has(key)) {
      errors.push({
        field,
        message: "The same product and variant appears twice in this bundle."
      });
      return;
    }
    seen.add(key);

    if (bundleProductId !== null && component.productId === bundleProductId) {
      errors.push({
        field: `${field}.productId`,
        message: "A bundle cannot contain itself."
      });
      return;
    }

    const product = facts.get(component.productId);
    if (!product) {
      errors.push({
        field: `${field}.productId`,
        message: "The component product was not found."
      });
      return;
    }
    if (product.kind === "bundle") {
      errors.push({
        field: `${field}.productId`,
        message:
          "A component cannot itself be a bundle (bundles are not nested)."
      });
      return;
    }
    if (component.variantId !== null) {
      if (!product.liveVariantIds.has(component.variantId)) {
        errors.push({
          field: `${field}.variantId`,
          message: "The component variant was not found on that product."
        });
      }
    } else if (product.liveVariantIds.size > 0) {
      errors.push({
        field: `${field}.variantId`,
        message: "That product has variants: choose one."
      });
    }
  });

  return errors;
}

/** A component as resolved at quote time. */
export type ResolvedComponent = {
  position: number;
  productId: string;
  variantId: string | null;
  sku: string | null;
  name: string;
  variantName: string | null;
  quantityPerBundle: number;
  /** The sellable count of the component's stock unit; `null` when the unit cannot be sold at all. */
  stock: number | null;
  /** List unit price in `numeric(14,2)` text: the variant's price override, else the product's price after its own discount. */
  unitPrice: string;
};

/** A resolved component as a cart line / order carries it (no stock figure). */
export type BundleLineComponent = Omit<ResolvedComponent, "stock">;

/**
 * Bundles available = min over components of `floor(stock / quantity)`.
 * A component that cannot be sold (`stock === null`: deleted, inactive, or a
 * variant that was never named) makes the bundle unavailable; so does an empty
 * component list. Never negative.
 */
export function computeBundleAvailability(
  components: readonly Pick<ResolvedComponent, "stock" | "quantityPerBundle">[]
): number {
  if (components.length === 0) return 0;
  let available = Number.POSITIVE_INFINITY;
  for (const component of components) {
    if (component.stock === null) return 0;
    const units = Math.floor(
      Math.max(component.stock, 0) / component.quantityPerBundle
    );
    if (units < available) available = units;
  }
  return available;
}

/** `sum(unit price x quantity)` of the components, in cents: one bundle's list value. */
export function bundleListValueCents(
  components: readonly Pick<
    ResolvedComponent,
    "unitPrice" | "quantityPerBundle"
  >[]
): bigint {
  return components.reduce(
    (sum, component) =>
      sum + toCents(component.unitPrice) * BigInt(component.quantityPerBundle),
    0n
  );
}

/**
 * The `derived` unit price: the components' list value less the percent,
 * rounded half-up to the cent. `discountPercent` is the `numeric(5,2)` text
 * (or `null` = 0).
 */
export function computeDerivedBundlePrice(
  components: readonly Pick<
    ResolvedComponent,
    "unitPrice" | "quantityPerBundle"
  >[],
  discountPercent: string | null
): string {
  const hundredths =
    discountPercent === null ? 0 : parsePercentHundredths(discountPercent);
  if (hundredths === null) {
    throw new Error(`Not a percentage: ${discountPercent}`);
  }
  const total = bundleListValueCents(components);
  const kept = BigInt(10_000 - hundredths);
  return fromCents((total * kept + 5000n) / 10_000n);
}

/**
 * Splits a bundle LINE's total across its components by list value
 * (`unit price x quantity per bundle x bundles sold`), largest remainder, so
 * the shares sum to `lineTotalCents` exactly. Ties break to the earlier
 * position; when every component has a zero list value the line is split
 * evenly (still exact). Returns one share per component, in input order.
 */
export function allocateBundleValue(
  lineTotalCents: bigint,
  components: readonly Pick<
    ResolvedComponent,
    "unitPrice" | "quantityPerBundle"
  >[],
  bundleQuantity: number
): bigint[] {
  if (components.length === 0) return [];
  if (lineTotalCents <= 0n) return components.map(() => 0n);

  let weights = components.map(
    (component) =>
      toCents(component.unitPrice) *
      BigInt(component.quantityPerBundle) *
      BigInt(Math.max(bundleQuantity, 1))
  );
  let totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);
  if (totalWeight === 0n) {
    weights = components.map(() => 1n);
    totalWeight = BigInt(components.length);
  }

  const shares = weights.map(
    (weight) => (lineTotalCents * weight) / totalWeight
  );
  let leftover =
    lineTotalCents - shares.reduce((sum, share) => sum + share, 0n);
  const order = weights
    .map((weight, index) => ({
      index,
      remainder: (lineTotalCents * weight) % totalWeight
    }))
    .sort((a, b) =>
      a.remainder === b.remainder
        ? a.index - b.index
        : a.remainder > b.remainder
          ? -1
          : 1
    );
  for (const { index } of order) {
    if (leftover === 0n) break;
    shares[index]! += 1n;
    leftover -= 1n;
  }
  return shares;
}

/** One immutable snapshot row, ready for `awcms_commerce_order_item_components`. */
export type BundleSnapshotRow = {
  position: number;
  productId: string;
  variantId: string | null;
  sku: string | null;
  name: string;
  variantName: string | null;
  quantityPerBundle: number;
  quantityTotal: number;
  allocatedValue: string;
};

export function buildBundleSnapshot(
  lineTotal: string,
  bundleQuantity: number,
  components: readonly BundleLineComponent[]
): BundleSnapshotRow[] {
  const shares = allocateBundleValue(
    toCents(lineTotal),
    components,
    bundleQuantity
  );
  return components.map((component, index) => ({
    position: component.position,
    productId: component.productId,
    variantId: component.variantId,
    sku: component.sku,
    name: component.name,
    variantName: component.variantName,
    quantityPerBundle: component.quantityPerBundle,
    quantityTotal: component.quantityPerBundle * bundleQuantity,
    allocatedValue: fromCents(shares[index]!)
  }));
}

/**
 * The ledger source line of one component of a sold/returned line:
 * `<line id>:c<position>`. Distinct per component, stable, <= 64 chars
 * (a uuid is 36), and inside the ledger's opaque-id alphabet.
 */
export function componentSourceLine(lineId: string, position: number): string {
  return `${lineId}:c${position}`;
}

/** A line the stock layer posts or restocks; the shape `SaleLine` has in `commerce-inventory.ts`. */
export type ExpandableLine = {
  lineId: string;
  productId: string;
  variantId: string | null;
  quantity: number;
};

/** Component snapshot facts the stock layer needs, keyed by the order item they belong to. */
export type ComponentStockFact = {
  position: number;
  productId: string;
  variantId: string | null;
  quantityPerBundle: number;
};

/**
 * Replaces each bundle line by one line per component (`quantity per bundle x
 * bundle units`, source line {@link componentSourceLine}); a standard line
 * passes through. The bundle line itself is NEVER posted: it has no stock.
 * `componentsByLine` is keyed by the line id the snapshot belongs to.
 */
export function expandBundleLines(
  lines: readonly ExpandableLine[],
  componentsByLine: ReadonlyMap<string, readonly ComponentStockFact[]>
): ExpandableLine[] {
  const expanded: ExpandableLine[] = [];
  for (const line of lines) {
    const components = componentsByLine.get(line.lineId);
    if (!components || components.length === 0) {
      expanded.push(line);
      continue;
    }
    for (const component of components) {
      expanded.push({
        lineId: componentSourceLine(line.lineId, component.position),
        productId: component.productId,
        variantId: component.variantId,
        quantity: component.quantityPerBundle * line.quantity
      });
    }
  }
  return expanded;
}

/** Component stock units (variant id, else product id) in a deterministic lock order. */
export function componentLockOrder(
  components: readonly { productId: string; variantId: string | null }[]
): { kind: "variant" | "product"; id: string }[] {
  const unique = new Map<string, { kind: "variant" | "product"; id: string }>();
  for (const component of components) {
    const unit = component.variantId
      ? { kind: "variant" as const, id: component.variantId }
      : { kind: "product" as const, id: component.productId };
    unique.set(`${unit.kind}|${unit.id}`, unit);
  }
  return [...unique.values()].sort((a, b) =>
    a.kind === b.kind
      ? a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0
      : a.kind < b.kind
        ? -1
        : 1
  );
}
