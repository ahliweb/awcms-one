/**
 * `/keranjang` interactivity (issue #30): renders the cart from
 * `localStorage`, re-quotes it live against the CMS
 * (`POST …/cart/quote`, `src/lib/toko-klien.ts`), and lets a shopper adjust
 * quantity, remove a line, or apply a voucher — always re-quoting after any
 * change, never computing a new total itself (ADR-0003 posture, one layer
 * up from `harga.ts`).
 *
 * Shipping/insurance selection is the CHECKOUT step's job, not this page's
 * — the quote requested here always sends `shipping: null, insurance:
 * false`, which the CMS answers with `shippingOptions`/`canCheckout` still
 * computed (just with no shipping cost added yet) so a shopper sees an
 * accurate "this line is out of stock" flag before ever reaching checkout.
 */
import { loadCart, removeCartLine, updateCartLineQuantity } from "../lib/keranjang-klien";
import type { Cart } from "../lib/keranjang-kontrak";
import { quoteCart, TokoApiError, type CartLineRequest, type CartQuote, type QuoteLine } from "../lib/toko-klien";
import { formatPrice } from "../lib/harga";
import { buildWhatsappCartMessage, buildWhatsappUrl } from "../lib/wa-fallback";

const root = document.querySelector<HTMLElement>("[data-keranjang-root]");
if (root) {
  const linesEl = root.querySelector<HTMLElement>("[data-keranjang-lines]");
  const emptyEl = root.querySelector<HTMLElement>("[data-keranjang-empty]");
  const bodyEl = root.querySelector<HTMLElement>("[data-keranjang-body]");
  const errorEl = root.querySelector<HTMLElement>("[data-quote-error]");
  const errorMessageEl = root.querySelector<HTMLElement>("[data-quote-error-message]");
  const retryButton = root.querySelector<HTMLButtonElement>("[data-quote-retry]");
  const waFallbackLink = root.querySelector<HTMLAnchorElement>("[data-wa-fallback-link]");
  const voucherInput = root.querySelector<HTMLInputElement>("[data-voucher-input]");
  const voucherButton = root.querySelector<HTMLButtonElement>("[data-voucher-apply]");
  const voucherMessageEl = root.querySelector<HTMLElement>("[data-voucher-message]");
  const summaryBodyEl = root.querySelector<HTMLElement>("[data-summary-body]");
  const checkoutLink = root.querySelector<HTMLAnchorElement>("[data-checkout-link]");

  const whatsappNumber = root.dataset.whatsappNumber ?? "";
  const storeName = root.dataset.storeName ?? "toko";

  let voucherCode: string | null = null;

  function toLineRequests(cart: Cart): CartLineRequest[] {
    return cart.lines.map((line) => ({
      productId: line.productId,
      variantId: line.variantId,
      quantity: line.quantity,
      serviceFormValues: line.serviceFormValues
    }));
  }

  function statusLabel(status: QuoteLine["status"]): string | null {
    switch (status) {
      case "ok":
        return null;
      case "price_changed":
        return "Harga berubah";
      case "out_of_stock":
        return "Stok habis";
      case "quantity_reduced":
        return "Jumlah disesuaikan dengan stok tersedia";
      case "unavailable":
        return "Produk tidak lagi tersedia";
      case "min_purchase":
        return "Belum memenuhi minimum pembelian";
      case "service_form_invalid":
        return "Data layanan belum lengkap";
      default:
        return "Perlu diperiksa kembali";
    }
  }

  function renderLines(cart: Cart, quoteLines: QuoteLine[] | null): void {
    if (!linesEl) return;
    linesEl.innerHTML = "";

    cart.lines.forEach((line, index) => {
      const quoteLine = quoteLines?.[index] ?? null;
      const li = document.createElement("li");
      li.className = "toko-line";

      if (line.image) {
        const img = document.createElement("img");
        img.className = "toko-line-image";
        img.src = line.image.url;
        img.alt = line.image.alt;
        img.loading = "lazy";
        li.appendChild(img);
      }

      const info = document.createElement("div");
      info.className = "toko-line-info";

      const title = document.createElement("p");
      title.textContent = line.variantName ? `${line.name} (${line.variantName})` : line.name;
      info.appendChild(title);

      const price = document.createElement("p");
      price.textContent = formatPrice(quoteLine?.unitPrice ?? line.unitPrice);
      info.appendChild(price);

      const label = statusLabel(quoteLine?.status ?? "ok");
      if (label) {
        const badge = document.createElement("span");
        badge.className = "toko-line-status toko-line-status--warn";
        badge.textContent = label;
        info.appendChild(badge);
      }

      const qtyWrap = document.createElement("div");
      qtyWrap.className = "toko-qty";

      const qtyInput = document.createElement("input");
      qtyInput.type = "number";
      qtyInput.min = String(line.minPurchase);
      qtyInput.max = String(line.maxQuantity);
      qtyInput.value = String(line.quantity);
      qtyInput.setAttribute("aria-label", `Jumlah ${line.name}`);
      qtyInput.addEventListener("change", () => {
        const next = Number(qtyInput.value);
        if (!Number.isFinite(next)) return;
        updateCartLineQuantity(index, Math.trunc(next));
        refresh();
      });
      qtyWrap.appendChild(qtyInput);

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.textContent = "Hapus";
      removeButton.setAttribute("aria-label", `Hapus ${line.name} dari keranjang`);
      removeButton.addEventListener("click", () => {
        removeCartLine(index);
        refresh();
      });
      qtyWrap.appendChild(removeButton);

      info.appendChild(qtyWrap);
      li.appendChild(info);
      linesEl.appendChild(li);
    });
  }

  function renderSummary(quote: CartQuote | null): void {
    if (!summaryBodyEl || !checkoutLink) return;

    if (!quote) {
      summaryBodyEl.textContent = "";
      checkoutLink.setAttribute("aria-disabled", "true");
      return;
    }

    summaryBodyEl.innerHTML = "";

    const row = (label: string, value: string, emphasise = false) => {
      const div = document.createElement("div");
      div.className = emphasise ? "toko-summary-row toko-summary-row--total" : "toko-summary-row";
      const labelSpan = document.createElement("span");
      labelSpan.textContent = label;
      const valueSpan = document.createElement("span");
      valueSpan.textContent = value;
      div.append(labelSpan, valueSpan);
      summaryBodyEl.appendChild(div);
    };

    row("Subtotal", formatPrice(quote.subtotal));
    if (Number(quote.discount) > 0) row("Diskon", `-${formatPrice(quote.discount)}`);
    row("Perkiraan total (belum termasuk ongkir)", formatPrice(quote.total), true);

    if (!quote.canCheckout) {
      const notice = document.createElement("p");
      notice.className = "toko-field-error";
      notice.textContent = "Selesaikan item yang bermasalah di atas sebelum melanjutkan ke checkout.";
      summaryBodyEl.appendChild(notice);
    }

    checkoutLink.setAttribute("aria-disabled", quote.canCheckout ? "false" : "true");
  }

  function showQuoteError(error: unknown, cart: Cart): void {
    if (!errorEl || !errorMessageEl) return;
    errorEl.hidden = false;
    errorMessageEl.textContent =
      error instanceof TokoApiError
        ? error.message
        : "Tidak dapat menghubungi server toko. Periksa koneksi Anda.";

    if (waFallbackLink && whatsappNumber) {
      const message = buildWhatsappCartMessage(cart, storeName);
      waFallbackLink.href = buildWhatsappUrl(whatsappNumber, message);
      waFallbackLink.hidden = false;
    }
  }

  function hideQuoteError(): void {
    if (errorEl) errorEl.hidden = true;
    if (waFallbackLink) waFallbackLink.hidden = true;
  }

  async function refresh(): Promise<void> {
    const cart = loadCart();

    if (cart.lines.length === 0) {
      if (emptyEl) emptyEl.hidden = false;
      if (bodyEl) bodyEl.hidden = true;
      if (linesEl) linesEl.innerHTML = "";
      return;
    }

    if (emptyEl) emptyEl.hidden = true;
    if (bodyEl) bodyEl.hidden = false;

    renderLines(cart, null);
    hideQuoteError();

    try {
      const quote = await quoteCart({
        lines: toLineRequests(cart),
        shipping: null,
        voucherCode,
        insurance: false
      });

      renderLines(cart, quote.lines);
      renderSummary(quote);

      if (voucherMessageEl) {
        voucherMessageEl.textContent = quote.voucher
          ? quote.voucher.valid
            ? `Voucher ${quote.voucher.code} diterapkan.`
            : (quote.voucher.reason ?? "Voucher tidak berlaku.")
          : "";
      }
    } catch (error) {
      renderSummary(null);
      showQuoteError(error, cart);
    }
  }

  retryButton?.addEventListener("click", () => {
    void refresh();
  });

  voucherButton?.addEventListener("click", () => {
    voucherCode = voucherInput?.value.trim() || null;
    void refresh();
  });

  checkoutLink?.addEventListener("click", (event) => {
    if (checkoutLink.getAttribute("aria-disabled") === "true") {
      event.preventDefault();
    }
  });

  void refresh();
}
