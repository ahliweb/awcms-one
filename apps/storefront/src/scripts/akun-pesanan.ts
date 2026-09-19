/**
 * `/akun/pesanan` interactivity (issue #90) — a signed-in shopper's own order
 * history. Two views, chosen once per load from `?kode=`:
 *
 *   - No `?kode=`: a keyset-paginated LIST (`GET …/account/orders?cursor=`),
 *     newest first, each row linking to `ROUTES.accountOrder(kode)` (a
 *     "Muat lebih banyak" button asks for the next page rather than
 *     rendering all of it at once).
 *   - `?kode=` present: the DETAIL view, `GET …/account/orders/{kode}` — an
 *     owned order, so unlike `/pesanan` this needs NO phone prompt at all
 *     (the session already proves ownership, #86's own point of this
 *     endpoint existing). Rendered through the SAME `createPesananRenderer`
 *     `/pesanan` uses (`src/lib/pesanan-render.ts`) — this page renders no
 *     confirm-payment/cancel controls, a deliberate scope reduction: those
 *     actions are phone-gated on the CMS's own tracking routes, and #86
 *     names no account-authenticated equivalent for them.
 *
 * The `/account/orders` list is ALREADY filtered server-side to
 * `created_at >= historyFrom` (#86's D4) — this script trusts that filtering
 * completely and applies none of its own; `scripts/stub-awcms.mjs` seeds one
 * order deliberately dated before `historyFrom` specifically to prove the
 * SERVER does the filtering, not this client.
 */
import { ambilPesananAkunByKode, ambilPesananAkun, type AkunPesananHalaman } from "../lib/akun-klien";
import { bacaSesi } from "../lib/akun-sesi";
import { AKUN_EVENT_NAME } from "../lib/akun-kontrak";
import { createPesananRenderer, STATUS_LABELS } from "../lib/pesanan-render";
import { formatPrice } from "../lib/harga";
import { TokoApiError } from "../lib/toko-permintaan";
import { ROUTES } from "../config/routes";
import { buildWhatsappAccountMessage, buildWhatsappUrl } from "../lib/wa-fallback";

const root = document.querySelector<HTMLElement>("[data-akun-pesanan-root]");
if (root) {
  const guestView = root.querySelector<HTMLElement>("[data-guest-view]");
  const listView = root.querySelector<HTMLElement>("[data-list-view]");
  const detailView = root.querySelector<HTMLElement>("[data-detail-view]");
  const submitErrorEl = root.querySelector<HTMLElement>("[data-submit-error]");
  const submitErrorMessageEl = root.querySelector<HTMLElement>("[data-submit-error-message]");
  const waFallbackLink = root.querySelector<HTMLAnchorElement>("[data-wa-fallback-link]");

  const whatsappNumber = root.dataset.whatsappNumber ?? "";
  const storeName = root.dataset.storeName ?? "toko";

  const params = new URLSearchParams(window.location.search);
  const orderCode = params.get("kode");

  function hideSubmitError(): void {
    if (submitErrorEl) submitErrorEl.hidden = true;
    if (waFallbackLink) waFallbackLink.hidden = true;
  }

  function showSubmitError(error: unknown, context: string): void {
    if (submitErrorEl && submitErrorMessageEl) {
      submitErrorEl.hidden = false;
      submitErrorMessageEl.textContent =
        error instanceof TokoApiError ? error.message : "Terjadi kesalahan yang tidak terduga.";
    }
    if (waFallbackLink && whatsappNumber) {
      waFallbackLink.href = buildWhatsappUrl(whatsappNumber, buildWhatsappAccountMessage(storeName, context));
      waFallbackLink.hidden = false;
    }
  }

  // --- list view ------------------------------------------------------------

  const listEl = listView?.querySelector<HTMLElement>("[data-order-list]") ?? null;
  const listEmptyEl = listView?.querySelector<HTMLElement>("[data-order-list-empty]") ?? null;
  const loadMoreButton = listView?.querySelector<HTMLButtonElement>("[data-load-more]") ?? null;
  let nextCursor: string | null = null;

  function appendOrderRows(page: AkunPesananHalaman): void {
    if (!listEl) return;
    for (const order of page.items) {
      const li = document.createElement("li");
      li.className = "akun-card";

      const link = document.createElement("a");
      link.href = ROUTES.accountOrder(order.orderCode);

      const title = document.createElement("strong");
      title.textContent = order.orderCode;
      const status = document.createElement("span");
      status.textContent = ` — ${STATUS_LABELS[order.status] ?? order.status} — ${formatPrice(order.total)}`;

      link.append(title, status);
      li.appendChild(link);
      listEl.appendChild(li);
    }

    nextCursor = page.nextCursor;
    if (loadMoreButton) loadMoreButton.hidden = !nextCursor;
    if (listEmptyEl) listEmptyEl.hidden = (listEl?.children.length ?? 0) > 0;
  }

  async function loadMore(): Promise<void> {
    try {
      const page = await ambilPesananAkun(nextCursor);
      appendOrderRows(page);
      hideSubmitError();
    } catch (error) {
      showSubmitError(error, "memuat daftar pesanan saya");
    }
  }

  loadMoreButton?.addEventListener("click", () => void loadMore());

  // --- detail view ------------------------------------------------------------

  const detailStatusEl = detailView?.querySelector<HTMLElement>("[data-order-status]") ?? null;
  const detailOrderCodeEl = detailView?.querySelector<HTMLElement>("[data-order-code]") ?? null;
  const detailCountdownEl = detailView?.querySelector<HTMLElement>("[data-order-countdown]") ?? null;
  const detailTimelineEl = detailView?.querySelector<HTMLOListElement>("[data-order-timeline]") ?? null;
  const detailPaymentSection = detailView?.querySelector<HTMLElement>("[data-payment-section]") ?? null;
  const detailPaymentInstructionsEl = detailView?.querySelector<HTMLElement>("[data-payment-instructions]") ?? null;
  const detailLinesEl = detailView?.querySelector<HTMLElement>("[data-order-lines]") ?? null;
  const detailSummaryEl = detailView?.querySelector<HTMLElement>("[data-order-summary]") ?? null;
  const detailErrorEl = detailView?.querySelector<HTMLElement>("[data-order-error]") ?? null;
  const detailBodyEl = detailView?.querySelector<HTMLElement>("[data-order-body]") ?? null;
  const backToListLink = detailView?.querySelector<HTMLAnchorElement>("[data-back-to-list]") ?? null;

  const { renderOrder } = createPesananRenderer({
    statusEl: detailStatusEl,
    orderCodeEl: detailOrderCodeEl,
    countdownEl: detailCountdownEl,
    timelineEl: detailTimelineEl,
    paymentSection: detailPaymentSection,
    paymentInstructionsEl: detailPaymentInstructionsEl,
    linesEl: detailLinesEl,
    summaryEl: detailSummaryEl
    // No confirmSection/cancelButton/contactWaLink — see this file's own docblock.
  });

  async function loadDetail(kode: string): Promise<void> {
    try {
      const order = await ambilPesananAkunByKode(kode);
      if (detailBodyEl) detailBodyEl.hidden = false;
      if (detailErrorEl) detailErrorEl.hidden = true;
      renderOrder(order);
    } catch (error) {
      if (detailErrorEl) detailErrorEl.hidden = false;
      if (detailBodyEl) detailBodyEl.hidden = true;
      if (!(error instanceof TokoApiError)) showSubmitError(error, "melihat detail pesanan saya");
    }
  }

  if (backToListLink) backToListLink.href = ROUTES.accountOrders;

  // --- guest/account toggle, and which view to show --------------------------

  function render(): void {
    hideSubmitError();
    const sesi = bacaSesi();

    if (!sesi) {
      if (guestView) guestView.hidden = false;
      if (listView) listView.hidden = true;
      if (detailView) detailView.hidden = true;
      return;
    }

    if (guestView) guestView.hidden = true;

    if (orderCode) {
      if (listView) listView.hidden = true;
      if (detailView) detailView.hidden = false;
      void loadDetail(orderCode);
    } else {
      if (detailView) detailView.hidden = true;
      if (listView) listView.hidden = false;
      if (listEl) listEl.innerHTML = "";
      nextCursor = null;
      void loadMore();
    }
  }

  render();
  window.addEventListener(AKUN_EVENT_NAME, render);
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === "awcms-one:akun:v1") render();
  });
}
