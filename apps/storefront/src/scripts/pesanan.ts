/**
 * `/pesanan` interactivity (issue #30) — reads `?kode=` and a `sessionStorage`
 * phone (or asks for one), fetches the order, and renders status/items/
 * totals/payment instructions/timeline, with a countdown while
 * `pending_payment`, a payment-confirmation form, and a cancel action.
 *
 * The phone NEVER touches the URL — see `checkout.ts`'s `PESANAN_PHONE_KEY`
 * and this file's own read of it below.
 */
import {
  cancelOrder,
  getOrder,
  submitPaymentConfirmation,
  TokoApiError,
  type Order
} from "../lib/toko-klien";
import { formatPrice } from "../lib/harga";
import { PESANAN_PHONE_KEY } from "../lib/pesanan-sesi";

const STATUS_LABELS: Record<string, string> = {
  pending_payment: "Menunggu pembayaran",
  paid: "Sudah dibayar",
  processing: "Sedang diproses",
  shipped: "Sedang dikirim",
  completed: "Selesai",
  cancelled: "Dibatalkan",
  expired: "Kedaluwarsa"
};

const root = document.querySelector<HTMLElement>("[data-pesanan-root]");
if (root) {
  const noCodeEl = root.querySelector<HTMLElement>("[data-no-code]");
  const phoneForm = root.querySelector<HTMLFormElement>("[data-phone-form]");
  const orderErrorEl = root.querySelector<HTMLElement>("[data-order-error]");
  const orderBodyEl = root.querySelector<HTMLElement>("[data-order-body]");
  const statusEl = root.querySelector<HTMLElement>("[data-order-status]");
  const orderCodeEl = root.querySelector<HTMLElement>("[data-order-code]");
  const countdownEl = root.querySelector<HTMLElement>("[data-order-countdown]");
  const timelineEl = root.querySelector<HTMLOListElement>("[data-order-timeline]");
  const paymentSection = root.querySelector<HTMLElement>("[data-payment-section]");
  const paymentInstructionsEl = root.querySelector<HTMLElement>("[data-payment-instructions]");
  const linesEl = root.querySelector<HTMLElement>("[data-order-lines]");
  const summaryEl = root.querySelector<HTMLElement>("[data-order-summary]");
  const confirmSection = root.querySelector<HTMLElement>("[data-confirm-payment-section]");
  const confirmForm = root.querySelector<HTMLFormElement>("[data-confirm-payment-form]");
  const confirmErrorEl = root.querySelector<HTMLElement>("[data-confirm-error]");
  const cancelButton = root.querySelector<HTMLButtonElement>("[data-cancel-order]");
  const contactWaLink = root.querySelector<HTMLAnchorElement>("[data-contact-wa]");

  const params = new URLSearchParams(window.location.search);
  const orderCode = params.get("kode");

  let countdownTimer: ReturnType<typeof setInterval> | undefined;

  function readStoredPhone(): string | null {
    try {
      return window.sessionStorage.getItem(PESANAN_PHONE_KEY);
    } catch {
      return null;
    }
  }

  function storePhone(phone: string): void {
    try {
      window.sessionStorage.setItem(PESANAN_PHONE_KEY, phone);
    } catch {
      // Best-effort only — a blocked sessionStorage means the phone form
      // reappears on the next visit, not a functional break.
    }
  }

  function renderCountdown(expiresAt: string | null): void {
    if (countdownTimer) clearInterval(countdownTimer);
    if (!countdownEl) return;

    if (!expiresAt) {
      countdownEl.textContent = "";
      return;
    }

    const deadline = new Date(expiresAt).getTime();

    function tick(): void {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        countdownEl!.textContent = "Batas waktu pembayaran telah lewat.";
        if (countdownTimer) clearInterval(countdownTimer);
        return;
      }
      const minutes = Math.floor(remainingMs / 60000);
      const hours = Math.floor(minutes / 60);
      const remMinutes = minutes % 60;
      countdownEl!.textContent =
        hours > 0
          ? `Bayar dalam ${hours} jam ${remMinutes} menit.`
          : `Bayar dalam ${remMinutes} menit.`;
    }

    tick();
    countdownTimer = setInterval(tick, 30_000);
  }

  function renderTimeline(order: Order): void {
    if (!timelineEl) return;
    timelineEl.innerHTML = "";
    for (const entry of order.timeline) {
      const li = document.createElement("li");
      const date = new Date(entry.at);
      li.textContent = `${STATUS_LABELS[entry.status] ?? entry.status} — ${date.toLocaleString("id-ID")}${
        entry.note ? ` (${entry.note})` : ""
      }`;
      timelineEl.appendChild(li);
    }
  }

  function renderLines(order: Order): void {
    if (!linesEl) return;
    linesEl.innerHTML = "";
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
      linesEl.appendChild(li);
    }
  }

  function renderSummary(order: Order): void {
    if (!summaryEl) return;
    summaryEl.innerHTML = "";
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
      summaryEl.appendChild(row);
    }
  }

  function renderPaymentInstructions(order: Order): void {
    if (!paymentSection || !paymentInstructionsEl) return;
    const instructions = order.paymentInstructions;
    paymentSection.hidden = !instructions;
    paymentInstructionsEl.innerHTML = "";
    if (!instructions) return;

    if (instructions.qrisImage) {
      const img = document.createElement("img");
      img.src = instructions.qrisImage.url;
      img.alt = "Kode QRIS";
      img.className = "toko-line-image";
      paymentInstructionsEl.appendChild(img);
    }

    for (const bank of instructions.banks) {
      const p = document.createElement("p");
      p.textContent = `${bank.bankName} — ${bank.accountNumber} a.n. ${bank.accountName}`;
      paymentInstructionsEl.appendChild(p);
    }

    const due = document.createElement("p");
    due.textContent = `Jumlah yang harus dibayar: ${formatPrice(instructions.amountDue)}`;
    paymentInstructionsEl.appendChild(due);
  }

  function renderOrder(order: Order): void {
    if (orderBodyEl) orderBodyEl.hidden = false;
    if (orderErrorEl) orderErrorEl.hidden = true;
    if (statusEl) statusEl.textContent = STATUS_LABELS[order.status] ?? order.status;
    if (orderCodeEl) orderCodeEl.textContent = `Kode Pesanan: ${order.orderCode}`;

    renderCountdown(order.status === "pending_payment" ? order.expiresAt : null);
    renderTimeline(order);
    renderLines(order);
    renderSummary(order);
    renderPaymentInstructions(order);

    if (confirmSection) confirmSection.hidden = !order.canConfirmPayment;
    if (cancelButton) cancelButton.hidden = !order.canCancel;

    if (contactWaLink) {
      contactWaLink.href = `https://wa.me/${order.whatsapp.number}?text=${encodeURIComponent(order.whatsapp.text)}`;
    }
  }

  async function loadOrder(phone: string): Promise<void> {
    if (!orderCode) return;
    try {
      const order = await getOrder(orderCode, phone);
      storePhone(phone);
      if (phoneForm) phoneForm.hidden = true;
      renderOrder(order);
    } catch (error) {
      if (orderErrorEl) orderErrorEl.hidden = false;
      if (orderBodyEl) orderBodyEl.hidden = true;
      if (error instanceof TokoApiError && error.code !== "NOT_FOUND") {
        // Any other error still shows the SAME neutral state — this page
        // never distinguishes "CMS down" from "wrong phone" to a shopper,
        // matching the contract's own neutral-refusal rule.
      }
    }
  }

  if (!orderCode) {
    if (noCodeEl) noCodeEl.hidden = false;
  } else {
    const storedPhone = readStoredPhone();
    if (storedPhone) {
      void loadOrder(storedPhone);
    } else if (phoneForm) {
      phoneForm.hidden = false;
    }
  }

  phoneForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const phone = new FormData(phoneForm).get("phone");
    if (typeof phone === "string" && phone.trim()) {
      void loadOrder(phone.trim());
    }
  });

  cancelButton?.addEventListener("click", async () => {
    const phone = readStoredPhone();
    if (!orderCode || !phone) return;
    if (!window.confirm("Yakin ingin membatalkan pesanan ini?")) return;

    try {
      const order = await cancelOrder(orderCode, { phone, reason: null });
      renderOrder(order);
    } catch {
      // The order/error banner state is left as-is; a shopper can retry.
    }
  });

  confirmForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const phone = readStoredPhone();
    if (!orderCode || !phone) return;

    const data = new FormData(confirmForm);
    const method = String(data.get("method") ?? "manual_qris") as "manual_qris" | "manual_bank";
    const amount = String(data.get("amount") ?? "").trim();
    const bankName = String(data.get("bankName") ?? "").trim() || null;
    const accountName = String(data.get("accountName") ?? "").trim() || null;
    const transferredAtRaw = String(data.get("transferredAt") ?? "");
    const transferredAt = transferredAtRaw ? new Date(transferredAtRaw).toISOString() : new Date().toISOString();

    if (confirmErrorEl) confirmErrorEl.textContent = "";

    try {
      const order = await submitPaymentConfirmation(orderCode, {
        phone,
        method,
        amount,
        bankName,
        accountName,
        transferredAt,
        proofMediaObjectId: null
      });
      renderOrder(order);
      confirmForm.reset();
    } catch (error) {
      if (confirmErrorEl) {
        confirmErrorEl.textContent =
          error instanceof TokoApiError ? error.message : "Gagal mengirim konfirmasi pembayaran.";
      }
    }
  });
}
