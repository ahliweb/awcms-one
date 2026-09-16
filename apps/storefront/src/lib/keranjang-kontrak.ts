/**
 * The cart contract — shape, storage key, event name, and every PURE
 * operation on a cart. Issue #30 (checkout) builds on exactly what is
 * exported here, so this file is the one place that shape is allowed to be
 * decided.
 *
 * Split from `src/lib/keranjang-klien.ts` on purpose: everything below is a
 * plain function of its arguments — no `window`, no `localStorage`, no
 * `CustomEvent` — so `tests/katalog-keranjang.test.ts` can exercise the
 * cart-line validation and merge rules the issue's own acceptance criteria
 * name, with no DOM and no browser. `keranjang-klien.ts` is the thin,
 * browser-only wrapper that reads/writes `localStorage` and dispatches the
 * event named below, built ENTIRELY out of the functions here.
 *
 * `Header.astro`'s cart-count script (`src/scripts/keranjang-hitung.ts`)
 * reads the exact same key/shape/event — see that file.
 */

/** `localStorage` key this app's cart lives under — replaces increment-1's bare `"cart"` array (issue #27: "you own that `<script>` block now"). */
export const KERANJANG_STORAGE_KEY = "awcms-one:keranjang:v1";

/** `CustomEvent` name dispatched on `window` after every write — the header's cart count (and any other listener) re-counts on this, and on the native `storage` event for a change made in another tab. */
export const KERANJANG_EVENT_NAME = "keranjang:berubah";

/** A `numeric(14,2)`-shaped decimal string — the same pattern `apps/cms`'s own `price-calculation.ts` validates against, reused here so a corrupted/tampered `localStorage` value is rejected rather than trusted. */
const PRICE_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

/** ISO-8601 — validated loosely (parses to a real date) rather than against a strict regex; `Date.prototype.toISOString()` is the only producer, so a stored value that fails this was tampered with or corrupted. */
function isIsoDateString(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * One line in the cart — `serviceFormValues` travels with the line (issue
 * #27: "values travel with the cart line — #30") because a service
 * product's booking details are chosen at add-to-cart time, not at
 * checkout. `maxQuantity` is a STOCK SNAPSHOT at the moment the line was
 * added/updated, never re-validated live against awcms (this is a static
 * site with no runtime CMS connection) — issue #30 is expected to
 * re-validate against a live stock check before an order is placed.
 */
export type CartLine = {
  productId: string;
  variantId: string | null;
  slug: string;
  name: string;
  variantName: string | null;
  sku: string;
  /** `numeric(14,2)` string — the unit price AT THE MOMENT this line was added, never recomputed (ADR-0003). */
  unitPrice: string;
  quantity: number;
  minPurchase: number;
  /** Stock snapshot at add-to-cart time — see this type's own docblock. */
  maxQuantity: number;
  weightGrams: number;
  image: { url: string; alt: string } | null;
  serviceFormValues: Record<string, string> | null;
  flashSaleId: string | null;
  /** ISO-8601, from `new Date().toISOString()` at the moment this line was first added. */
  addedAt: string;
};

export type Cart = {
  id: string;
  lines: CartLine[];
  updatedAt: string;
};

/** A fresh, empty cart — `keranjang-klien.ts`'s `loadCart()` calls this the first time a visitor's browser has no stored cart. */
export function createEmptyCart(id: string, updatedAt: string): Cart {
  return { id, lines: [], updatedAt };
}

/**
 * Validates one candidate cart line, returning `null` (never throwing) for
 * anything that does not match {@link CartLine} exactly — the same
 * "degrade per-item rather than fail the whole read" rule `src/lib/awcms/
 * profil.ts`'s `parseSocialLinks` already applies to `localStorage`/network
 * data this app does not fully control.
 */
export function validateCartLine(value: unknown): CartLine | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;

  if (typeof candidate.productId !== "string" || candidate.productId.length === 0) return null;
  if (candidate.variantId !== null && typeof candidate.variantId !== "string") return null;
  if (typeof candidate.slug !== "string" || candidate.slug.length === 0) return null;
  if (typeof candidate.name !== "string" || candidate.name.length === 0) return null;
  if (candidate.variantName !== null && typeof candidate.variantName !== "string") return null;
  if (typeof candidate.sku !== "string") return null;
  if (typeof candidate.unitPrice !== "string" || !PRICE_PATTERN.test(candidate.unitPrice)) {
    return null;
  }
  if (
    typeof candidate.quantity !== "number" ||
    !Number.isInteger(candidate.quantity) ||
    candidate.quantity <= 0
  ) {
    return null;
  }
  if (typeof candidate.minPurchase !== "number" || !Number.isInteger(candidate.minPurchase)) {
    return null;
  }
  if (typeof candidate.maxQuantity !== "number" || !Number.isInteger(candidate.maxQuantity)) {
    return null;
  }
  if (typeof candidate.weightGrams !== "number" || !Number.isFinite(candidate.weightGrams)) {
    return null;
  }

  if (candidate.image !== null) {
    if (typeof candidate.image !== "object") return null;
    const image = candidate.image as Record<string, unknown>;
    if (typeof image.url !== "string" || typeof image.alt !== "string") return null;
  }

  if (candidate.serviceFormValues !== null) {
    if (typeof candidate.serviceFormValues !== "object") return null;
    for (const fieldValue of Object.values(candidate.serviceFormValues as Record<string, unknown>)) {
      if (typeof fieldValue !== "string") return null;
    }
  }

  if (candidate.flashSaleId !== null && typeof candidate.flashSaleId !== "string") return null;
  if (!isIsoDateString(candidate.addedAt)) return null;

  return {
    productId: candidate.productId,
    variantId: candidate.variantId as string | null,
    slug: candidate.slug,
    name: candidate.name,
    variantName: candidate.variantName as string | null,
    sku: candidate.sku,
    unitPrice: candidate.unitPrice,
    quantity: candidate.quantity,
    minPurchase: candidate.minPurchase,
    maxQuantity: candidate.maxQuantity,
    weightGrams: candidate.weightGrams,
    image: candidate.image as CartLine["image"],
    serviceFormValues: candidate.serviceFormValues as CartLine["serviceFormValues"],
    flashSaleId: candidate.flashSaleId as string | null,
    addedAt: candidate.addedAt
  };
}

/**
 * Parses a raw `localStorage` string into a {@link Cart}, or `null` for
 * anything that is not at least a well-shaped `{id, lines, updatedAt}`
 * object — `null` means "treat this visitor as having no cart", never a
 * thrown error over a private window, cleared storage, or a future format
 * this build does not recognise. Individual malformed LINES are dropped
 * rather than voiding the whole cart, via {@link validateCartLine}.
 */
export function parseCart(raw: string | null | undefined): Cart | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;

  if (typeof candidate.id !== "string" || candidate.id.length === 0) return null;
  if (!isIsoDateString(candidate.updatedAt)) return null;
  if (!Array.isArray(candidate.lines)) return null;

  const lines: CartLine[] = [];
  for (const entry of candidate.lines) {
    const line = validateCartLine(entry);
    if (line) lines.push(line);
  }

  return { id: candidate.id, lines, updatedAt: candidate.updatedAt };
}

/** Total item count across every line — the header's cart-count badge. */
export function countCartItems(cart: Cart | null): number {
  if (!cart) return 0;
  return cart.lines.reduce((total, line) => total + line.quantity, 0);
}

/** Whether two lines refer to the SAME purchasable configuration — same product, same variant (or lack of one), same service-form answers, same flash sale. Two such lines merge quantities rather than sitting side by side. */
function isSameConfiguration(a: CartLine, b: CartLine): boolean {
  return (
    a.productId === b.productId &&
    a.variantId === b.variantId &&
    a.flashSaleId === b.flashSaleId &&
    JSON.stringify(a.serviceFormValues) === JSON.stringify(b.serviceFormValues)
  );
}

/**
 * Adds `line` to `cart`, merging into an existing line of the same
 * configuration (summing quantity, clamped to the INCOMING line's
 * `maxQuantity` — the freshest stock snapshot available) rather than
 * appending a duplicate row. Pure: returns a NEW `Cart`, never mutates
 * `cart` or `line` — `keranjang-klien.ts` is what actually persists the
 * result.
 */
export function addOrMergeLine(cart: Cart, line: CartLine, now: string): Cart {
  const existingIndex = cart.lines.findIndex((candidate) => isSameConfiguration(candidate, line));

  if (existingIndex === -1) {
    return { ...cart, lines: [...cart.lines, line], updatedAt: now };
  }

  const existing = cart.lines[existingIndex] as CartLine;
  const mergedQuantity = Math.min(existing.quantity + line.quantity, line.maxQuantity);

  const merged: CartLine = {
    ...line,
    quantity: mergedQuantity,
    // The line's OWN `addedAt` is when this configuration first entered the
    // cart — a re-add (increasing quantity of something already there)
    // should not reset that.
    addedAt: existing.addedAt
  };

  const lines = [...cart.lines];
  lines[existingIndex] = merged;

  return { ...cart, lines, updatedAt: now };
}

/** Removes the line at `index`, or returns `cart` unchanged if `index` is out of range (never throws — a stale UI reference to an already-removed line is a no-op, not an error). */
export function removeLine(cart: Cart, index: number, now: string): Cart {
  if (index < 0 || index >= cart.lines.length) return cart;
  const lines = cart.lines.filter((_, candidateIndex) => candidateIndex !== index);
  return { ...cart, lines, updatedAt: now };
}

/** Sets the quantity of the line at `index`, clamped to `[minPurchase, maxQuantity]` — never below the product's own minimum purchase, never above the stock snapshot. Removes the line entirely when `quantity` is `0` or less. */
export function setLineQuantity(cart: Cart, index: number, quantity: number, now: string): Cart {
  if (index < 0 || index >= cart.lines.length) return cart;

  if (quantity <= 0) return removeLine(cart, index, now);

  const existing = cart.lines[index] as CartLine;
  const clamped = Math.min(Math.max(quantity, existing.minPurchase), existing.maxQuantity);

  const lines = [...cart.lines];
  lines[index] = { ...existing, quantity: clamped };

  return { ...cart, lines, updatedAt: now };
}
