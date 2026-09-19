/**
 * Cart quoting — Issue #29. Pure — no database, no I/O; the caller
 * (`application/cart-quote-service.ts`) resolves products/variants/flash
 * sales/store settings/voucher row from the database first and hands this
 * function a fully-resolved snapshot, the same "fetch first, compute after"
 * split `domain/voucher-arithmetic.ts` already follows for a single
 * voucher.
 *
 * Every money figure is a `numeric(14,2)` STRING computed with integer-CENT
 * `BigInt` arithmetic via `price-calculation.ts`'s `toCents`/`fromCents`
 * (ADR-0003) — never a float, never `parseFloat`.
 *
 * ## Arithmetic order (the contract's own words, `commerce-storefront-
 * endpoints.md`)
 *
 * `subtotal` -> voucher discount (percentage capped by `maxDiscount`,
 * nominal, or `freeShipping`) -> shipping (`0` when free shipping applies by
 * voucher OR by store threshold with every line `allowFreeShipping`) ->
 * insurance (`max(minFee, subtotal x ratePercent)` when selected or
 * required) -> tax (`percent` of `subtotal - discount` when active) ->
 * `total`.
 *
 * ## What this function does NOT do
 *
 * It never decrements stock or a flash sale's `sold` counter, and never
 * redeems a voucher (`used_count`) — this is a READ, called by both the
 * public `POST .../cart/quote` endpoint (no write at all) and internally by
 * `application/order-directory.ts`'s `createOrderFromCart` (which re-quotes
 * inside the same transaction that performs the writes, so the two paths
 * can never compute a different price for the same cart).
 *
 * ## `previousUnitPrice` / `"price_changed"` — a documented gap, not an
 * oversight
 *
 * The storefront contract's per-line shape carries `previousUnitPrice` and a
 * `"price_changed"` status value, but neither the quote request nor the
 * order-creation request carries an "expected price" the client believes is
 * still current — there is nothing here to diff a freshly computed price
 * AGAINST. This function therefore always returns `previousUnitPrice: null`
 * and never emits `"price_changed"`; a future increment that wants this
 * would need to add an optional `expectedUnitPrice` to the request line
 * shape first. `409 CART_CHANGED` on order creation is still fully
 * implemented — `application/order-directory.ts`'s own re-quote fails
 * whenever ANY line's status is not `"ok"`, which already covers "the price
 * moved because a flash sale ended" via `"out_of_stock"`/other statuses.
 */
import {
  fromCents,
  normalizeMoney,
  toCents,
  computeFinalPrice
} from "./price-calculation";
import {
  evaluateVoucher,
  type VoucherEvaluationInput
} from "./voucher-arithmetic";
import type { ServiceFormField } from "./service-form-validation";
import type { ProductStatus } from "./product-status";
import type {
  PaymentMethod,
  ShippingMethod,
  CartLineStatus
} from "./commerce-order-types";
import type { StoreSettingsData } from "./store-settings-validation";

export type CartQuoteLineInput = {
  productId: string;
  variantId: string | null;
  quantity: number;
  serviceFormValues: Record<string, string> | null;
};

export type CartQuoteShippingInput =
  | { method: "alternative"; serviceId: string }
  | { method: "self_pickup" }
  | { method: "courier"; serviceId: string }
  | null;

/**
 * Issue #107 (contract #106 D4) — one available courier rate, already
 * resolved by `application/shipping-rate-directory.ts`'s `getCourierRates`
 * (a provider call, so it can never happen inside this pure function).
 * `quoteCart`'s caller (`application/cart-quote-service.ts`) fetches these
 * BEFORE calling `quoteCart`, the same "fetch first, compute after" split
 * this file's own header describes for the voucher row.
 */
export type CartQuoteCourierOption = {
  serviceId: string;
  courier: string;
  service: string;
  name: string;
  cost: string;
  etd: string | null;
};

/**
 * `null` when courier rates were never attempted for this quote (the
 * feature is off, or no provider is configured) — `buildShippingOptions`
 * then falls back to the pre-Issue-#107 single disabled placeholder.
 */
export type CartQuoteCourierContext = {
  /** `settings.shipping.courier.enabled && a provider is configured`. */
  enabled: boolean;
  /** Whether the caller's request carried a `destination`. */
  destinationProvided: boolean;
  /** Resolved rates — empty when `destinationProvided` but nothing resolved. */
  options: CartQuoteCourierOption[];
  /** Set whenever `options` is empty but courier rates WERE attempted — the reason the single disabled placeholder should show. */
  unavailableReason: string | null;
};

export type CartQuoteProductSnapshot = {
  id: string;
  slug: string;
  name: string;
  sku: string;
  price: string;
  discountPercent: number;
  stock: number;
  status: ProductStatus;
  minPurchase: number;
  weightGrams: number;
  withInsurance: boolean;
  insuranceRequired: boolean;
  allowDp: boolean;
  allowFreeShipping: boolean;
  serviceForm: ServiceFormField[] | null;
  imageUrl: string | null;
  imageAlt: string | null;
};

export type CartQuoteVariantSnapshot = {
  id: string;
  productId: string;
  value: string;
  sku: string | null;
  price: string | null;
  stock: number;
  weightGrams: number;
};

export type CartQuoteFlashSaleSnapshot = {
  flashSaleId: string;
  productId: string;
  variantId: string | null;
  salePrice: string;
  quota: number;
  sold: number;
};

export type CartQuoteVoucherRowLookup =
  { found: true; row: VoucherEvaluationInput } | { found: false };

export type CartQuoteContext = {
  products: ReadonlyMap<string, CartQuoteProductSnapshot>;
  variants: ReadonlyMap<string, CartQuoteVariantSnapshot>;
  /** Keyed `${productId}:${variantId ?? ""}` — only entries for CURRENTLY ACTIVE flash sales (the caller pre-filters the window). */
  flashSales: ReadonlyMap<string, CartQuoteFlashSaleSnapshot>;
  storeSettings: StoreSettingsData;
  voucher: { code: string; lookup: CartQuoteVoucherRowLookup } | null;
  now: Date;
  /** Issue #107 — `null`/absent when courier rates were never attempted (see {@link CartQuoteCourierContext}'s own header); optional so every pre-#107 `CartQuoteContext` literal keeps compiling unchanged. */
  courier?: CartQuoteCourierContext | null;
};

export type CartQuoteLineResult = {
  productId: string;
  variantId: string | null;
  slug: string | null;
  name: string | null;
  variantName: string | null;
  sku: string | null;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  weightGrams: number;
  image: { url: string; alt: string } | null;
  flashSaleId: string | null;
  allowDp: boolean;
  allowFreeShipping: boolean;
  withInsurance: boolean;
  insuranceRequired: boolean;
  status: CartLineStatus;
  previousUnitPrice: string | null;
  availableStock: number | null;
  minPurchase: number | null;
  serviceFormErrors: { fieldId: string; message: string }[] | null;
  serviceFormValues: Record<string, string> | null;
};

export type CartQuoteShippingOption = {
  method: ShippingMethod;
  serviceId: string | null;
  name: string;
  cost: string | null;
  available: boolean;
  /** Issue #107 — the courier's own estimated delivery time (provider text, e.g. "2-3"), `null` for every non-courier method. */
  etd?: string | null;
  /** Issue #107 — set on an UNAVAILABLE courier placeholder to explain why (e.g. "Tujuan belum dikenali kurir"); `null`/absent otherwise. */
  note?: string | null;
};

export type CartQuoteVoucherResult = {
  code: string;
  valid: boolean;
  discount: string;
  freeShipping: boolean;
  reason: string | null;
} | null;

export type CartQuoteResult = {
  lines: CartQuoteLineResult[];
  subtotal: string;
  weightGrams: number;
  shippingOptions: CartQuoteShippingOption[];
  shipping: {
    method: ShippingMethod;
    serviceId: string | null;
    name: string;
    cost: string;
  } | null;
  freeShippingApplied: boolean;
  voucher: CartQuoteVoucherResult;
  insurance: {
    available: boolean;
    required: boolean;
    selected: boolean;
    fee: string;
  };
  tax: { active: boolean; percent: number; amount: string };
  discount: string;
  total: string;
  downPayment: { available: boolean; percent: number; amount: string };
  paymentMethods: { method: PaymentMethod; available: boolean }[];
  canCheckout: boolean;
  quotedAt: string;
};

function flashSaleKey(productId: string, variantId: string | null): string {
  return `${productId}:${variantId ?? ""}`;
}

function validateServiceFormAnswers(
  fields: ServiceFormField[] | null,
  values: Record<string, string> | null
): { fieldId: string; message: string }[] {
  if (!fields || fields.length === 0) return [];
  const answers = values ?? {};
  const errors: { fieldId: string; message: string }[] = [];

  for (const field of fields) {
    const answer = answers[field.id];
    const isBlank = typeof answer !== "string" || answer.trim().length === 0;

    if (field.required && isBlank) {
      errors.push({
        fieldId: field.id,
        message: `${field.label} is required.`
      });
      continue;
    }

    if (
      !isBlank &&
      field.type === "select" &&
      (!field.options || !field.options.includes(answer as string))
    ) {
      errors.push({
        fieldId: field.id,
        message: `${field.label} must be one of the offered options.`
      });
    }
  }

  return errors;
}

function resolveLine(
  input: CartQuoteLineInput,
  context: CartQuoteContext
): CartQuoteLineResult {
  const product = context.products.get(input.productId);

  if (!product || product.status !== "active") {
    return {
      productId: input.productId,
      variantId: input.variantId,
      slug: product?.slug ?? null,
      name: product?.name ?? null,
      variantName: null,
      sku: null,
      quantity: input.quantity,
      unitPrice: "0.00",
      lineTotal: "0.00",
      weightGrams: 0,
      image: null,
      flashSaleId: null,
      allowDp: false,
      allowFreeShipping: false,
      withInsurance: false,
      insuranceRequired: false,
      status: "unavailable",
      previousUnitPrice: null,
      availableStock: null,
      minPurchase: null,
      serviceFormErrors: null,
      serviceFormValues: input.serviceFormValues
    };
  }

  const variant = input.variantId
    ? context.variants.get(input.variantId)
    : null;

  if (input.variantId && (!variant || variant.productId !== product.id)) {
    return {
      productId: product.id,
      variantId: input.variantId,
      slug: product.slug,
      name: product.name,
      variantName: null,
      sku: null,
      quantity: input.quantity,
      unitPrice: "0.00",
      lineTotal: "0.00",
      weightGrams: 0,
      image:
        product.imageUrl !== null
          ? { url: product.imageUrl, alt: product.imageAlt ?? product.name }
          : null,
      flashSaleId: null,
      allowDp: product.allowDp,
      allowFreeShipping: product.allowFreeShipping,
      withInsurance: product.withInsurance,
      insuranceRequired: product.insuranceRequired,
      status: "unavailable",
      previousUnitPrice: null,
      availableStock: null,
      minPurchase: product.minPurchase,
      serviceFormErrors: null,
      serviceFormValues: input.serviceFormValues
    };
  }

  const flashSale = context.flashSales.get(
    flashSaleKey(product.id, input.variantId)
  );

  const availableStock = flashSale
    ? flashSale.quota > 0
      ? Math.max(flashSale.quota - flashSale.sold, 0)
      : variant
        ? variant.stock
        : product.stock
    : variant
      ? variant.stock
      : product.stock;

  const unitPrice = flashSale
    ? normalizeMoney(flashSale.salePrice)
    : variant && variant.price !== null
      ? normalizeMoney(variant.price)
      : computeFinalPrice(product.price, product.discountPercent);

  const serviceFormErrors = validateServiceFormAnswers(
    product.serviceForm,
    input.serviceFormValues
  );

  let status: CartLineStatus = "ok";

  if (input.quantity < product.minPurchase) {
    status = "min_purchase";
  } else if (availableStock <= 0) {
    status = "out_of_stock";
  } else if (input.quantity > availableStock) {
    status = "quantity_reduced";
  } else if (serviceFormErrors.length > 0) {
    status = "service_form_invalid";
  }

  const weightGrams = variant ? variant.weightGrams : product.weightGrams;
  const lineTotal =
    status === "ok" ||
    status === "quantity_reduced" ||
    status === "min_purchase"
      ? fromCents(toCents(unitPrice) * BigInt(Math.max(input.quantity, 0)))
      : "0.00";

  return {
    productId: product.id,
    variantId: input.variantId,
    slug: product.slug,
    name: product.name,
    variantName: variant ? variant.value : null,
    sku: variant?.sku ?? product.sku,
    quantity: input.quantity,
    unitPrice,
    lineTotal,
    weightGrams: weightGrams * Math.max(input.quantity, 0),
    image:
      product.imageUrl !== null
        ? { url: product.imageUrl, alt: product.imageAlt ?? product.name }
        : null,
    flashSaleId: flashSale?.flashSaleId ?? null,
    allowDp: product.allowDp,
    allowFreeShipping: product.allowFreeShipping,
    withInsurance: product.withInsurance,
    insuranceRequired: product.insuranceRequired,
    status,
    previousUnitPrice: null,
    availableStock,
    minPurchase: product.minPurchase,
    serviceFormErrors: serviceFormErrors.length > 0 ? serviceFormErrors : null,
    serviceFormValues: input.serviceFormValues
  };
}

/**
 * Issue #107 — courier options now come from `context.courier` (fetched by
 * `application/cart-quote-service.ts` BEFORE this pure function ever runs).
 * `context.courier === null` (feature off / no provider configured) falls
 * back to the pre-#107 single disabled placeholder; a caller who never sent
 * a `destination` gets a disabled placeholder explaining that; a resolved
 * destination with no rates gets the resolver's own `unavailableReason`.
 */
export function buildShippingOptions(
  settings: StoreSettingsData,
  courier: CartQuoteCourierContext | null
): CartQuoteShippingOption[] {
  const options: CartQuoteShippingOption[] =
    settings.shipping.alternativeServices.map((service) => ({
      method: "alternative" as ShippingMethod,
      serviceId: service.id,
      name: service.name,
      cost: normalizeMoney(service.cost),
      available: true
    }));

  options.push({
    method: "self_pickup",
    serviceId: null,
    name: "Ambil di toko",
    cost: "0.00",
    available: settings.shipping.selfPickup
  });

  if (!courier || !courier.enabled) {
    options.push({
      method: "courier",
      serviceId: null,
      name: "Kurir (segera)",
      cost: null,
      available: false,
      note: null
    });
  } else if (!courier.destinationProvided) {
    options.push({
      method: "courier",
      serviceId: null,
      name: "Kurir",
      cost: null,
      available: false,
      note: "Pilih tujuan pengiriman untuk melihat opsi kurir."
    });
  } else if (courier.options.length === 0) {
    options.push({
      method: "courier",
      serviceId: null,
      name: "Kurir",
      cost: null,
      available: false,
      note: courier.unavailableReason ?? "Kurir tidak tersedia."
    });
  } else {
    for (const option of courier.options) {
      options.push({
        method: "courier",
        serviceId: option.serviceId,
        name: option.name,
        cost: normalizeMoney(option.cost),
        available: true,
        etd: option.etd,
        note: null
      });
    }
  }

  return options;
}

function resolveSelectedShipping(
  shippingInput: CartQuoteShippingInput,
  options: CartQuoteShippingOption[]
): {
  method: ShippingMethod;
  serviceId: string | null;
  name: string;
  cost: string;
} | null {
  if (!shippingInput) return null;

  if (shippingInput.method === "self_pickup") {
    const option = options.find((entry) => entry.method === "self_pickup");
    if (!option || !option.available) return null;
    return {
      method: "self_pickup",
      serviceId: null,
      name: option.name,
      cost: "0.00"
    };
  }

  if (shippingInput.method === "alternative") {
    const option = options.find(
      (entry) =>
        entry.method === "alternative" &&
        entry.serviceId === shippingInput.serviceId
    );
    if (!option || !option.available || option.cost === null) return null;
    return {
      method: "alternative",
      serviceId: option.serviceId,
      name: option.name,
      cost: option.cost
    };
  }

  if (shippingInput.method === "courier") {
    const option = options.find(
      (entry) =>
        entry.method === "courier" &&
        entry.serviceId === shippingInput.serviceId
    );
    if (!option || !option.available || option.cost === null) return null;
    return {
      method: "courier",
      serviceId: option.serviceId,
      name: option.name,
      cost: option.cost
    };
  }

  return null;
}

export function quoteCart(
  input: {
    lines: CartQuoteLineInput[];
    shipping: CartQuoteShippingInput;
    insurance: boolean;
  },
  context: CartQuoteContext
): CartQuoteResult {
  const lines = input.lines.map((line) => resolveLine(line, context));

  const subtotalCents = lines.reduce(
    (sum, line) => sum + toCents(line.lineTotal),
    0n
  );
  const subtotal = fromCents(subtotalCents);
  const weightGrams = lines.reduce((sum, line) => sum + line.weightGrams, 0);

  const shippingOptions = buildShippingOptions(
    context.storeSettings,
    context.courier ?? null
  );
  const selectedShipping = resolveSelectedShipping(
    input.shipping,
    shippingOptions
  );

  // -- Voucher --------------------------------------------------------
  let voucherResult: CartQuoteVoucherResult = null;
  let voucherDiscountCents = 0n;
  let freeShippingByVoucher = false;

  if (context.voucher) {
    if (!context.voucher.lookup.found) {
      voucherResult = {
        code: context.voucher.code,
        valid: false,
        discount: "0.00",
        freeShipping: false,
        reason: "not_found"
      };
    } else {
      const evaluation = evaluateVoucher(
        context.voucher.lookup.row,
        subtotal,
        selectedShipping?.cost ?? "0.00",
        context.now
      );

      if (evaluation.valid) {
        voucherDiscountCents = toCents(evaluation.discount);
        freeShippingByVoucher = evaluation.freeShipping;
        voucherResult = {
          code: context.voucher.code,
          valid: true,
          discount: evaluation.discount,
          freeShipping: evaluation.freeShipping,
          reason: null
        };
      } else {
        voucherResult = {
          code: context.voucher.code,
          valid: false,
          discount: "0.00",
          freeShipping: false,
          reason: evaluation.reason
        };
      }
    }
  }

  const discount = fromCents(voucherDiscountCents);

  // -- Shipping (free-shipping override) -------------------------------
  const freeShippingByThreshold =
    context.storeSettings.shipping.freeShipping.active &&
    lines.length > 0 &&
    lines.every((line) => line.allowFreeShipping) &&
    subtotalCents >=
      toCents(context.storeSettings.shipping.freeShipping.minOrder);

  const freeShippingApplied = freeShippingByVoucher || freeShippingByThreshold;

  const shippingCents = freeShippingApplied
    ? 0n
    : selectedShipping
      ? toCents(selectedShipping.cost)
      : 0n;

  const shipping = selectedShipping
    ? { ...selectedShipping, cost: fromCents(shippingCents) }
    : null;

  // -- Insurance --------------------------------------------------------
  const insuranceAvailable =
    context.storeSettings.payment.insurance.active &&
    lines.some((line) => line.withInsurance);
  const insuranceRequired =
    insuranceAvailable && lines.some((line) => line.insuranceRequired);
  const insuranceSelected =
    insuranceAvailable && (input.insurance || insuranceRequired);

  let insuranceFeeCents = 0n;
  if (insuranceSelected) {
    const minFeeCents = toCents(context.storeSettings.payment.insurance.minFee);
    const rateBasisPoints = toCents(
      context.storeSettings.payment.insurance.ratePercent
    );
    const computedCents = (subtotalCents * rateBasisPoints + 5000n) / 10000n;
    insuranceFeeCents =
      computedCents > minFeeCents ? computedCents : minFeeCents;
  }
  const insuranceFee = fromCents(insuranceFeeCents);

  // -- Tax ---------------------------------------------------------------
  const taxActive = context.storeSettings.payment.tax.active;
  const taxPercent = context.storeSettings.payment.tax.percent;
  const taxableCents = subtotalCents - voucherDiscountCents;
  const taxAmountCents = taxActive
    ? (taxableCents * BigInt(taxPercent) + 50n) / 100n
    : 0n;
  const taxAmount = fromCents(taxAmountCents);

  // -- Total ---------------------------------------------------------------
  const totalCents =
    subtotalCents -
    voucherDiscountCents +
    shippingCents +
    insuranceFeeCents +
    taxAmountCents;
  const total = fromCents(totalCents < 0n ? 0n : totalCents);

  // -- Down payment -------------------------------------------------------
  const downPaymentAvailable =
    context.storeSettings.payment.downPayment.active &&
    lines.length > 0 &&
    lines.every((line) => line.allowDp);
  const downPaymentPercent = context.storeSettings.payment.downPayment.percent;
  const downPaymentAmountCents = downPaymentAvailable
    ? (totalCents * BigInt(downPaymentPercent) + 50n) / 100n
    : 0n;

  const paymentMethods: { method: PaymentMethod; available: boolean }[] = [
    {
      method: "manual_qris",
      available: context.storeSettings.payment.manualQris.active
    },
    {
      method: "manual_bank",
      available: context.storeSettings.payment.manualBank.active
    },
    { method: "dp", available: downPaymentAvailable }
  ];

  const canCheckout =
    lines.length > 0 && lines.every((line) => line.status === "ok");

  return {
    lines,
    subtotal,
    weightGrams,
    shippingOptions,
    shipping,
    freeShippingApplied,
    voucher: voucherResult,
    insurance: {
      available: insuranceAvailable,
      required: insuranceRequired,
      selected: insuranceSelected,
      fee: insuranceFee
    },
    tax: { active: taxActive, percent: taxPercent, amount: taxAmount },
    discount,
    total,
    downPayment: {
      available: downPaymentAvailable,
      percent: downPaymentPercent,
      amount: fromCents(downPaymentAmountCents)
    },
    paymentMethods,
    canCheckout,
    quotedAt: context.now.toISOString()
  };
}
