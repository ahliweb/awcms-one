/**
 * `/pesanan` interactivity (issue #30) — reads `?kode=` and a `sessionStorage`
 * phone (or asks for one), fetches the order, and renders status/items/
 * totals/payment instructions/timeline, with a countdown while
 * `pending_payment`, a payment-confirmation form, and a cancel action.
 *
 * The phone NEVER touches the URL — see `checkout.ts`'s `PESANAN_PHONE_KEY`
 * and this file's own read of it below.
 */
import { cancelOrder, getOrder, submitPaymentConfirmation, TokoApiError } from "../lib/toko-klien";
import { PESANAN_PHONE_KEY } from "../lib/pesanan-sesi";
import { createPesananRenderer } from "../lib/pesanan-render";

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

  const { renderOrder: renderOrderBody } = createPesananRenderer({
    statusEl,
    orderCodeEl,
    countdownEl,
    timelineEl,
    paymentSection,
    paymentInstructionsEl,
    linesEl,
    summaryEl,
    confirmSection,
    cancelButton,
    contactWaLink
  });

  function renderOrder(order: Parameters<typeof renderOrderBody>[0]): void {
    if (orderBodyEl) orderBodyEl.hidden = false;
    if (orderErrorEl) orderErrorEl.hidden = true;
    renderOrderBody(order);
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
