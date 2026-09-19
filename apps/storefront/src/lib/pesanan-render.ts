/**
 * The order-detail rendering logic `src/scripts/pesanan.ts` (issue #30)
 * originally had inline, extracted here (issue #90) so `/akun/pesanan`'s own
 * detail view (`akun-pesanan.ts`) renders an `Order` EXACTLY the same way
 * `/pesanan` does, rather than a second, drifting copy of this markup-
 * building code. `/pesanan`'s own behaviour is UNCHANGED by this extraction
 * — `pesanan.ts` now calls `createPesananRenderer` instead of declaring
 * these functions itself.
 *
 * This module still touches the DOM (it builds and writes real elements),
 * so — like every other `src/scripts/*`-adjacent file — it is never imported
 * from `.astro` frontmatter, only from a `<script>` block.
 */
import type { Order } from "./toko-klien";
import { formatPrice } from "./harga";

export const STATUS_LABELS: Record<string, string> = {
  pending_payment: "Menunggu pembayaran",
  paid: "Sudah dibayar",
  processing: "Sedang diproses",
  shipped: "Sedang dikirim",
  completed: "Selesai",
  cancelled: "Dibatalkan",
  expired: "Kedaluwarsa"
};

/**
 * Every element `createPesananRenderer` writes to — all optional, so a page
 * that omits one section (`/akun/pesanan`'s detail view has no
 * confirm-payment/cancel actions, see that page's own docblock) simply gets
 * no-ops for the pieces it did not render, rather than a runtime error.
 */
export type PesananRenderRefs = {
  statusEl?: HTMLElement | null;
  orderCodeEl?: HTMLElement | null;
  countdownEl?: HTMLElement | null;
  timelineEl?: HTMLOListElement | null;
  paymentSection?: HTMLElement | null;
  paymentInstructionsEl?: HTMLElement | null;
  /** Issue #112 — the "Bayar sekarang" button, shown ONLY for a `gateway` order still `pending_payment`, in place of the manual-transfer instructions above. Click wiring is the PAGE script's job (`pesanan.ts`/`akun-pesanan.ts`), not this renderer's — this module only decides whether it is visible. */
  gatewayPayButton?: HTMLButtonElement | null;
  /** Issue #112 — the `aria-live` status line beside the button, "Menunggu konfirmasi pembayaran…" while pending, the paid confirmation once the poller's next fetch sees `status: "paid"`. */
  gatewayStatusEl?: HTMLElement | null;
  linesEl?: HTMLElement | null;
  summaryEl?: HTMLElement | null;
  confirmSection?: HTMLElement | null;
  cancelButton?: HTMLButtonElement | null;
  contactWaLink?: HTMLAnchorElement | null;
};

export type PesananRenderer = { renderOrder: (order: Order) => void };

/** Builds one renderer bound to `refs` — one call per page load, per detail view (`pesanan.ts` and `akun-pesanan.ts` each create their own). */
export function createPesananRenderer(refs: PesananRenderRefs): PesananRenderer {
  let countdownTimer: ReturnType<typeof setInterval> | undefined;

  function renderCountdown(expiresAt: string | null): void {
    if (countdownTimer) clearInterval(countdownTimer);
    if (!refs.countdownEl) return;

    if (!expiresAt) {
      refs.countdownEl.textContent = "";
      return;
    }

    const deadline = new Date(expiresAt).getTime();

    function tick(): void {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        refs.countdownEl!.textContent = "Batas waktu pembayaran telah lewat.";
        if (countdownTimer) clearInterval(countdownTimer);
        return;
      }
      const minutes = Math.floor(remainingMs / 60000);
      const hours = Math.floor(minutes / 60);
      const remMinutes = minutes % 60;
      refs.countdownEl!.textContent =
        hours > 0 ? `Bayar dalam ${hours} jam ${remMinutes} menit.` : `Bayar dalam ${remMinutes} menit.`;
    }

    tick();
    countdownTimer = setInterval(tick, 30_000);
  }

  function renderTimeline(order: Order): void {
    if (!refs.timelineEl) return;
    refs.timelineEl.innerHTML = "";
    for (const entry of order.timeline) {
      const li = document.createElement("li");
      const date = new Date(entry.at);
      li.textContent = `${STATUS_LABELS[entry.status] ?? entry.status} — ${date.toLocaleString("id-ID")}${
        entry.note ? ` (${entry.note})` : ""
      }`;
      refs.timelineEl.appendChild(li);
    }
  }

  function renderLines(order: Order): void {
    if (!refs.linesEl) return;
    refs.linesEl.innerHTML = "";
    for (const line of order.lines) {
      const li = document.createElement("li");
      li.className = "toko-line";
      if (line.image) {
        const img = document.createElement("img");
        img.className = "toko-line-image";
        img.src = line.image.url;
        img.alt = line.image.alt;
        li.appendChild(img);
      }
      const info = document.createElement("div");
      info.className = "toko-line-info";
      const title = document.createElement("p");
      title.textContent = `${line.quantity}x ${line.variantName ? `${line.name} (${line.variantName})` : line.name}`;
      const price = document.createElement("p");
      price.textContent = formatPrice(line.lineTotal);
      info.append(title, price);
      li.appendChild(info);
      refs.linesEl.appendChild(li);
    }
  }

  function renderSummary(order: Order): void {
    if (!refs.summaryEl) return;
    refs.summaryEl.innerHTML = "";
    const rows: [string, string][] = [
      ["Subtotal", formatPrice(order.subtotal)],
      ["Diskon", `-${formatPrice(order.discount)}`],
      ["Ongkos kirim", formatPrice(order.shippingCost)],
      ["Asuransi", formatPrice(order.insuranceFee)],
      ["Total", formatPrice(order.total)]
    ];
    for (const [label, value] of rows) {
      const row = document.createElement("div");
      row.className = "toko-summary-row";
      const l = document.createElement("span");
      l.textContent = label;
      const v = document.createElement("span");
      v.textContent = value;
      row.append(l, v);
      refs.summaryEl.appendChild(row);
    }
  }

  /**
   * Issue #112 — a `gateway` order still `pending_payment` renders the
   * "Bayar sekarang" button INSTEAD of manual-transfer instructions (this
   * repo's own `paymentInstructions` is `null` for a gateway order in the
   * first place — the CMS never sends bank/QRIS instructions for one — but
   * this function does not rely on that alone; it decides from
   * `paymentMethod`/`status` directly, which is what actually governs the
   * button's own visibility too).
   */
  function renderPaymentSection(order: Order): void {
    const isGatewayPending = order.paymentMethod === "gateway" && order.status === "pending_payment";
    const instructions = order.paymentInstructions;

    if (refs.paymentSection) refs.paymentSection.hidden = !instructions && !isGatewayPending;

    if (refs.paymentInstructionsEl) {
      refs.paymentInstructionsEl.innerHTML = "";
      refs.paymentInstructionsEl.hidden = isGatewayPending;

      if (!isGatewayPending && instructions) {
        if (instructions.qrisImage) {
          const img = document.createElement("img");
          img.src = instructions.qrisImage.url;
          img.alt = "Kode QRIS";
          img.className = "toko-line-image";
          refs.paymentInstructionsEl.appendChild(img);
        }

        for (const bank of instructions.banks) {
          const p = document.createElement("p");
          p.textContent = `${bank.bankName} — ${bank.accountNumber} a.n. ${bank.accountName}`;
          refs.paymentInstructionsEl.appendChild(p);
        }

        const due = document.createElement("p");
        due.textContent = `Jumlah yang harus dibayar: ${formatPrice(instructions.amountDue)}`;
        refs.paymentInstructionsEl.appendChild(due);
      }
    }

    if (refs.gatewayPayButton) refs.gatewayPayButton.hidden = !isGatewayPending;

    if (refs.gatewayStatusEl) {
      if (isGatewayPending) {
        refs.gatewayStatusEl.textContent = "Menunggu konfirmasi pembayaran…";
      } else if (order.paymentMethod === "gateway" && order.status === "paid") {
        refs.gatewayStatusEl.textContent = "Pembayaran diterima.";
      } else {
        refs.gatewayStatusEl.textContent = "";
      }
    }
  }

  function renderOrder(order: Order): void {
    if (refs.statusEl) refs.statusEl.textContent = STATUS_LABELS[order.status] ?? order.status;
    if (refs.orderCodeEl) refs.orderCodeEl.textContent = `Kode Pesanan: ${order.orderCode}`;

    renderCountdown(order.status === "pending_payment" ? order.expiresAt : null);
    renderTimeline(order);
    renderLines(order);
    renderSummary(order);
    renderPaymentSection(order);

    if (refs.confirmSection) refs.confirmSection.hidden = !order.canConfirmPayment;
    if (refs.cancelButton) refs.cancelButton.hidden = !order.canCancel;

    if (refs.contactWaLink) {
      refs.contactWaLink.href = `https://wa.me/${order.whatsapp.number}?text=${encodeURIComponent(order.whatsapp.text)}`;
    }
  }

  return { renderOrder };
}
