/**
 * The WhatsApp order fallback — ADR-0007 (revised)'s "no customer hits a
 * dead end": every page with a JavaScript-only checkout path
 * (`/keranjang`, `/checkout`) also offers a `wa.me` link carrying a plain-
 * text summary of the cart, for two DIFFERENT situations that both end up
 * needing the same link:
 *
 *   1. **True no-JS** (`<noscript>`): nothing here can run — a page renders
 *      a static message plus a GENERIC WhatsApp contact link (no cart
 *      summary is possible; `localStorage` is unreadable with no
 *      JavaScript). See each page's own `<noscript>` block.
 *   2. **JS ran, but the live quote/checkout request failed** (CMS down,
 *      tenant unresolved, a network error) — `src/scripts/keranjang.ts`/
 *      `checkout.ts` build a REAL cart-summary link with this file, because
 *      at that point the cart WAS readable, only the CMS call was not.
 *
 * Kept pure and framework-free specifically so it is unit-testable with no
 * DOM and no `fetch` — the only thing that can be "wrong" here is text
 * formatting and URL encoding, and a test should be able to say so directly.
 */
import type { Cart } from "./keranjang-kontrak";
import { formatPrice } from "./harga";

/** One line of a cart, as plain text — `"2x Mie Gacoan (Pedas)"` or `"2x Mie Gacoan"` when there is no variant. */
function lineText(line: Cart["lines"][number]): string {
  const name = line.variantName ? `${line.name} (${line.variantName})` : line.name;
  return `${line.quantity}x ${name}`;
}

/**
 * A plain-text WhatsApp message summarising `cart` — line quantities/names
 * and the sum of `unitPrice * quantity` (a DISPLAY-ONLY subtotal computed
 * the same way `harga.ts`'s own docblock allows for a range/sort filter,
 * never presented as the CMS's authoritative total: a human reads this
 * message and quotes the real price back, so it is not the ADR-0003
 * arithmetic boundary a stored order total would be).
 */
export function buildWhatsappCartMessage(cart: Cart, storeName: string): string {
  if (cart.lines.length === 0) {
    return `Halo ${storeName}, saya ingin bertanya tentang produk di toko.`;
  }

  const lines = cart.lines.map((line) => `- ${lineText(line)}`);
  const subtotalCents = cart.lines.reduce(
    (total, line) => total + Math.round(Number(line.unitPrice) * 100) * line.quantity,
    0
  );
  const subtotal = (subtotalCents / 100).toFixed(2);

  return [
    `Halo ${storeName}, saya ingin memesan:`,
    ...lines,
    ``,
    `Perkiraan subtotal: ${formatPrice(subtotal)}`,
    `(Checkout via situs sedang tidak dapat diakses — mohon bantu proses pesanan ini melalui WhatsApp.)`
  ].join("\n");
}

/** A `wa.me` link for `number` (digits only, no leading `+`/`0` — the same shape the CMS's own `store-settings-public.json`'s `whatsapp` field already uses) carrying `message` as the prefilled text. */
export function buildWhatsappUrl(number: string, message: string): string {
  const digitsOnly = number.replace(/\D/g, "");
  return `https://wa.me/${digitsOnly}?text=${encodeURIComponent(message)}`;
}

/**
 * A plain-text "the CMS is unreachable" message for a page with no cart to
 * summarise — issue #88's `/masuk`, `/daftar`, `/akun` (an OTP/profile
 * request has no line items the way `buildWhatsappCartMessage` above
 * describes). `context` names what the reader was trying to do
 * ("mendapatkan kode masuk", "mendaftar akun baru", …) so the store's own
 * reply can pick up where the page left off.
 */
export function buildWhatsappAccountMessage(storeName: string, context: string): string {
  return (
    `Halo ${storeName}, saya sedang ${context} di situs, tetapi sistemnya tidak dapat diakses. ` +
    `Mohon bantuannya.`
  );
}
