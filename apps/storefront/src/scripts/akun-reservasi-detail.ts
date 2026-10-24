/**
 * `/akun/reservasi?kode=<orderCode>` - one own reservation (issue #387, ADR-0045,
 * `docs/booking-ux-flows.md` sections 3.3 and 4): Surface B's order view with the
 * deposit state and Surface C's cancellation and refund view. Driven by
 * `akun-reservasi.ts`, which owns the session guard and the list.
 *
 * ## What is the server's, and what is this file's
 *
 * Every figure on screen - total, deposit, paid, balance, refund - is a string
 * the server returned, formatted by `formatPrice`. This file never works out a
 * refund. The cancellation dialog:
 *
 * 1. opens on "Batalkan reservasi" and asks the SERVER for the cancellation quote
 *    (`GET …/cancellation-quote`); nothing is cancelled by opening it;
 * 2. shows the quote's amount paid, policy window, refund and retained amount;
 * 3. on confirm asks for the quote AGAIN and compares it with the one on screen:
 *    a different refund re-renders the new figure and asks for a fresh
 *    confirmation (the shopper is never cancelled against a number they did not
 *    see); only an unchanged figure is sent, as `acknowledgedRefund`, which the
 *    server compares once more under its own lock (`409 QUOTE_CHANGED`);
 * 4. sends one `Idempotency-Key` per (reservation, figure): a retry after a
 *    dropped connection replays, a changed figure takes a new key.
 *
 * Focus: `showModal()` traps it and makes the page inert; the safe button
 * ("Tidak, tetap pesan") holds the initial focus; closing returns focus to the
 * opener, or - after a cancellation, when the opener is gone - to the result
 * heading. `Escape` closes without cancelling (and is ignored while a request is
 * in flight so the outcome is never hidden). Results are announced through
 * `role="status"`, refusals through `role="alert"`.
 */
import { ambilDetailReservasi, ambilKuotaPembatalan, ambilPesananAkunByKode, batalkanReservasi } from "../lib/akun-klien";
import { labelTombolBayar, mulaiPembayaranGateway } from "../lib/booking-aksi";
import {
  alasanTidakBisaBatal,
  bandingkanUang,
  barisUang,
  catatanPembayaran,
  formatSisa,
  labelPembayaran,
  labelPengembalian,
  labelStatusReservasi,
  pesanBerhasilBatal,
  pesanGalatPembatalan,
  rincianPembatalan,
  sisaDetik,
  statusEfektif,
  teksMenginap,
  tujuanSesiGateway,
  type DetailReservasi,
  type KuotaPembatalan,
  type NadaPil,
  type PesanGalatBatal
} from "../lib/booking-kontrak";
import { formatPrice } from "../lib/harga";
import type { Order } from "../lib/toko-klien";
import { TokoApiError } from "../lib/toko-permintaan";
import { buildWhatsappAccountMessage, buildWhatsappUrl } from "../lib/wa-fallback";

const KEEP_LABEL = "Tidak, tetap pesan";
const POLL_START_MS = 15_000;
const POLL_MAX_MS = 60_000;

export type DetailReservasiKontrol = {
  /** Shows the detail of `kode` (loads it); `null` is a malformed code and shows the neutral not-found. */
  tampil: (kode: string | null) => void;
  /** Hides everything and stops every timer (the guest view, or a different mode, took over). */
  sembunyi: () => void;
};

export function buatDetailReservasi(
  root: HTMLElement,
  hooks: { onBelumMasuk: () => void }
): DetailReservasiKontrol {
  const q = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const view = q("[data-detail-view]");
  const loadingEl = q("[data-detail-loading]");
  const errorEl = q("[data-detail-error]");
  const errorMessageEl = q("[data-detail-error-message]");
  const retryButton = q<HTMLButtonElement>("[data-detail-retry]");
  const notFoundEl = q("[data-detail-notfound]");
  const resultEl = q("[data-detail-result]");
  const article = q("[data-detail]");
  const headingEl = q("[data-detail-heading]");
  const pillsEl = q("[data-detail-pills]");
  const stayEl = q("[data-detail-stay]");
  const metaEl = q("[data-detail-meta]");
  const holdEl = q("[data-detail-hold]");
  const moneyEl = q("[data-detail-money]");
  const paymentNoteEl = q("[data-detail-payment-note]");
  const refundEl = q("[data-detail-refund]");
  const actionsEl = q("[data-detail-actions]");
  const cancelReasonEl = q("[data-detail-cancel-reason]");
  const actionStatusEl = q("[data-detail-action-status]");
  const announce = q("[data-announce]");

  const dialog = q<HTMLDialogElement>("[data-cancel-dialog]");
  const cancelBody = q("[data-cancel-body]");
  const cancelLoading = q("[data-cancel-loading]");
  const cancelDl = q<HTMLElement>("[data-cancel-dl]");
  const cancelRetained = q("[data-cancel-retained]");
  const cancelError = q("[data-cancel-error]");
  const cancelErrorMessage = q("[data-cancel-error-message]");
  const cancelRetry = q<HTMLButtonElement>("[data-cancel-retry]");
  const cancelWa = q<HTMLAnchorElement>("[data-cancel-wa]");
  const cancelStatus = q("[data-cancel-status]");
  const keepButton = q<HTMLButtonElement>("[data-cancel-keep]");
  const confirmButton = q<HTMLButtonElement>("[data-cancel-confirm]");

  const whatsappNumber = root.dataset.whatsappNumber ?? "";
  const storeName = root.dataset.storeName ?? "toko";

  let kode: string | null = null;
  let generation = 0;
  let current: DetailReservasi | null = null;
  let order: Order | null = null;
  let receivedAt = 0;
  let tickTimer: number | undefined;
  let pollTimer: number | undefined;
  let pollDelay = POLL_START_MS;
  let lastExpiryRefresh = 0;
  let refreshing = false;

  // ---- dialog state -------------------------------------------------------
  let opener: HTMLElement | null = null;
  let shownQuote: KuotaPembatalan | null = null;
  let busy = false;
  let attempt: { print: string; key: string } | null = null;
  /** A cancel whose answer never arrived: the server may or may not have cancelled. Its retry REPLAYS the same request (same figure, same key) instead of asking for a new quote, which would refuse a reservation that is in fact already cancelled. */
  let inDoubt: { code: string; refund: string } | null = null;

  function pill(label: string, tone: NadaPil): HTMLElement {
    const el = document.createElement("span");
    el.className = tone === "neutral" ? "pill" : `pill pill--${tone}`;
    el.textContent = label;
    return el;
  }

  function setBanner(el: HTMLElement, tone: NadaPil, text: string): void {
    el.className = `toko-banner${tone === "neutral" || tone === "info" ? " toko-banner--info" : tone === "danger" ? " toko-banner--danger" : ""}`;
    el.textContent = text;
    el.hidden = false;
  }

  // ---- loading and rendering ---------------------------------------------

  function showOnly(state: "loading" | "error" | "notfound" | "detail"): void {
    loadingEl.hidden = state !== "loading";
    errorEl.hidden = state !== "error";
    notFoundEl.hidden = state !== "notfound";
    article.hidden = state !== "detail";
  }

  function stopTimers(): void {
    window.clearInterval(tickTimer);
    window.clearTimeout(pollTimer);
    tickTimer = undefined;
    pollTimer = undefined;
    pollDelay = POLL_START_MS;
  }

  function efektif(): string {
    return current ? statusEfektif(current, performance.now() - receivedAt) : "";
  }

  async function ambil(code: string): Promise<{ reservation: DetailReservasi; order: Order | null }> {
    const [reservation, orderResult] = await Promise.all([
      ambilDetailReservasi(code),
      // The order supplies only presentation (the service name, the nights, the tender); losing it must not lose the reservation.
      ambilPesananAkunByKode(code).catch((error: unknown) => {
        if (error instanceof TokoApiError && error.code === "UNAUTHENTICATED") throw error;
        return null;
      })
    ]);
    return { reservation, order: orderResult };
  }

  function handleLoadError(error: unknown): void {
    if (error instanceof TokoApiError && error.code === "UNAUTHENTICATED") {
      hooks.onBelumMasuk();
      return;
    }
    if (error instanceof TokoApiError && (error.status === 404 || error.code === "NOT_FOUND")) {
      showOnly("notfound");
      return;
    }
    const unreachable = !(error instanceof TokoApiError) || error.code === "NETWORK_ERROR" || error.code === "INVALID_RESPONSE";
    errorMessageEl.textContent = unreachable
      ? "Tidak dapat memuat reservasi. Periksa koneksi Anda, lalu coba lagi."
      : pesanGalatPembatalan(error.code, error.status, "kuota").message;
    showOnly("error");
  }

  async function load(): Promise<void> {
    if (kode === null) {
      showOnly("notfound");
      return;
    }
    const mine = ++generation;
    showOnly("loading");
    try {
      const loaded = await ambil(kode);
      if (mine !== generation) return;
      apply(loaded.reservation, loaded.order);
      showOnly("detail");
    } catch (error) {
      if (mine !== generation) return;
      handleLoadError(error);
    }
  }

  /** Re-reads the reservation without leaving the detail (polling, returning from the provider, after a cancellation). Announces a changed status. */
  async function refresh(): Promise<boolean> {
    if (kode === null || refreshing) return false;
    refreshing = true;
    const mine = generation;
    try {
      const before = current ? statusEfektif(current, performance.now() - receivedAt) : null;
      const loaded = await ambil(kode);
      if (mine !== generation) return false;
      apply(loaded.reservation, loaded.order ?? order);
      const after = efektif();
      if (before && before !== after) {
        announce.textContent = `Status reservasi ${loaded.reservation.orderCode}: ${labelStatusReservasi(after).label}.`;
      }
      return true;
    } catch (error) {
      if (error instanceof TokoApiError && error.code === "UNAUTHENTICATED") hooks.onBelumMasuk();
      // A transient failure while refreshing is not a stop condition.
      return false;
    } finally {
      refreshing = false;
    }
  }

  function apply(reservation: DetailReservasi, orderData: Order | null): void {
    current = reservation;
    order = orderData;
    receivedAt = performance.now();
    render();
    ensureTimers();
  }

  function render(): void {
    if (!current) return;
    const status = efektif();
    const item = { ...current, status };
    const productName = order?.lines[0]?.name ?? null;
    // Nights are an order line's quantity - the server's count (UX ground rule 3).
    const nights = order && order.lines.length > 0 ? order.lines[0].quantity : null;

    headingEl.textContent = productName ?? `Reservasi ${current.reservationNo}`;
    pillsEl.replaceChildren();
    const st = labelStatusReservasi(status);
    pillsEl.append(pill(st.label, st.tone));
    const pay = labelPembayaran(item, formatPrice);
    pillsEl.append(" ", pill(pay.label, pay.tone));

    stayEl.textContent = teksMenginap(current.startsAt, nights);
    metaEl.textContent = `No. reservasi ${current.reservationNo} · Pesanan ${current.orderCode}`;

    moneyEl.replaceChildren();
    for (const baris of barisUang(item, formatPrice)) {
      const row = document.createElement("div");
      row.dataset.row = baris.key;
      if (baris.key === "total") row.className = "booking-dl-total";
      const dt = document.createElement("dt");
      dt.textContent = baris.label;
      const dd = document.createElement("dd");
      dd.textContent = baris.value;
      row.append(dt, dd);
      moneyEl.appendChild(row);
    }

    const note = catatanPembayaran(item, formatPrice);
    if (note) setBanner(paymentNoteEl, note.tone, note.message);
    else paymentNoteEl.hidden = true;

    const refund = labelPengembalian(current.refund, current.settlement, formatPrice);
    if (refund) setBanner(refundEl, refund.tone, refund.label);
    else refundEl.hidden = true;

    // Actions: pay (deposit, balance, full) and cancel; a reason in plain text when cancelling is not possible.
    actionsEl.replaceChildren();
    const purpose = order ? tujuanSesiGateway({ ...item, paymentMethod: order.paymentMethod }) : null;
    if (purpose) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn--primary";
      button.textContent = labelTombolBayar(purpose);
      button.addEventListener("click", () => void bayar(purpose, button));
      actionsEl.appendChild(button);
    }
    const reason = alasanTidakBisaBatal(status);
    if (reason === null) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn btn--secondary";
      cancel.dataset.openCancel = "";
      cancel.textContent = "Batalkan reservasi";
      cancel.addEventListener("click", () => void bukaDialog(cancel));
      actionsEl.appendChild(cancel);
      cancelReasonEl.hidden = true;
    } else {
      cancelReasonEl.textContent = reason;
      cancelReasonEl.hidden = false;
    }
    const orderLink = document.createElement("a");
    orderLink.className = "btn btn--secondary";
    orderLink.href = `/akun/pesanan?kode=${encodeURIComponent(current.orderCode)}`;
    orderLink.textContent = "Lihat pesanan";
    actionsEl.appendChild(orderLink);

    updateHold();
  }

  async function bayar(purpose: "full" | "deposit" | "balance", button: HTMLButtonElement): Promise<void> {
    if (!current) return;
    button.disabled = true;
    actionStatusEl.textContent = "Membuka halaman pembayaran...";
    const result = await mulaiPembayaranGateway(current.orderCode, purpose);
    if (result.kind === "dialihkan") return;
    button.disabled = false;
    if (result.kind === "belum-masuk") {
      actionStatusEl.textContent = "";
      hooks.onBelumMasuk();
      return;
    }
    actionStatusEl.textContent = result.message;
  }

  // ---- the hold countdown and the polite re-read -------------------------

  function liveHold(): boolean {
    return efektif() === "held" && !!current?.holdExpiresAt;
  }

  /** Plain text updates, no live region: a per-second announcement is unusable (WCAG 2.2.1 / 4.1.3). */
  function updateHold(): void {
    if (!current || !liveHold()) {
      holdEl.hidden = true;
      return;
    }
    const left = sisaDetik(current.holdExpiresAt!, current.serverNow, performance.now() - receivedAt);
    holdEl.hidden = false;
    holdEl.textContent = left > 0 ? `Kamar ditahan, sisa waktu ${formatSisa(left)}` : "Menunggu pembaruan dari server...";
    // The server, not this clock, says whether a hold is over: ask once, then at most every 10 seconds.
    if (left <= 0 && !refreshing && Date.now() - lastExpiryRefresh > 10_000) {
      lastExpiryRefresh = Date.now();
      void refresh();
    }
  }

  function ensureTimers(): void {
    if (!current || current.status !== "held") {
      stopTimers();
      return;
    }
    if (tickTimer === undefined) tickTimer = window.setInterval(updateHold, 1000);
    if (pollTimer === undefined) schedulePoll();
  }

  function schedulePoll(): void {
    pollTimer = window.setTimeout(async () => {
      pollTimer = undefined;
      if (document.visibilityState === "visible" && !dialog.open) await refresh();
      pollDelay = Math.min(POLL_MAX_MS, Math.round(pollDelay * 1.5));
      if (current?.status === "held") schedulePoll();
    }, pollDelay);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && kode !== null && current && !view.hidden && !dialog.open) void refresh();
  });
  window.addEventListener("online", () => {
    if (kode !== null && current && !view.hidden && !dialog.open) void refresh();
  });
  retryButton.addEventListener("click", () => void load());

  // ---- the cancellation dialog -------------------------------------------

  function setDialogLoading(): void {
    cancelBody.setAttribute("aria-busy", "true");
    cancelLoading.hidden = false;
    cancelDl.hidden = true;
    cancelRetained.hidden = true;
    cancelError.hidden = true;
    cancelRetry.hidden = true;
    cancelWa.hidden = true;
    confirmButton.disabled = true;
    cancelStatus.textContent = "";
  }

  function setDialogBusy(value: boolean): void {
    busy = value;
    keepButton.disabled = value;
    confirmButton.disabled = value || shownQuote === null || rincianPembatalan(shownQuote, formatPrice).tanpaKebijakan;
  }

  function renderQuote(quote: KuotaPembatalan): void {
    shownQuote = quote;
    const detailQuote = rincianPembatalan(quote, formatPrice);
    cancelBody.setAttribute("aria-busy", "false");
    cancelLoading.hidden = true;
    cancelDl.replaceChildren();
    for (const baris of detailQuote.baris) {
      const row = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = baris.label;
      const dd = document.createElement("dd");
      dd.textContent = baris.value;
      row.append(dt, dd);
      cancelDl.appendChild(row);
    }
    cancelDl.hidden = false;
    if (detailQuote.tanpaPengembalian && detailQuote.ditahan && !detailQuote.tanpaKebijakan) {
      cancelRetained.textContent = `Tidak ada pengembalian: ${detailQuote.ditahan} ditahan sesuai kebijakan`;
      cancelRetained.hidden = false;
    } else {
      cancelRetained.hidden = true;
    }
    confirmButton.textContent = detailQuote.labelKonfirmasi;
    confirmButton.disabled = detailQuote.tanpaKebijakan;
    if (detailQuote.tanpaKebijakan) {
      cancelError.hidden = false;
      cancelErrorMessage.textContent = detailQuote.ringkasan;
      showContact("pembatalan");
    }
  }

  function showContact(context: string): void {
    if (!whatsappNumber) {
      cancelWa.hidden = true;
      return;
    }
    cancelWa.href = buildWhatsappUrl(whatsappNumber, buildWhatsappAccountMessage(storeName, context));
    cancelWa.hidden = false;
  }

  function showDialogError(refusal: PesanGalatBatal): void {
    cancelBody.setAttribute("aria-busy", "false");
    cancelLoading.hidden = true;
    cancelStatus.textContent = "";
    cancelErrorMessage.textContent = refusal.message;
    cancelError.hidden = false;
    cancelRetry.hidden = !(refusal.next === "coba-lagi" || refusal.next === "tunggu" || refusal.next === "tinjau-ulang");
    if (refusal.next === "hubungi") showContact("pembatalan reservasi");
    else cancelWa.hidden = true;
  }

  function errorInfo(error: unknown, fase: "kuota" | "batal"): { refusal: PesanGalatBatal } {
    if (error instanceof TokoApiError) {
      return { refusal: pesanGalatPembatalan(error.code, error.status, fase, error.retryAfterSeconds) };
    }
    return { refusal: pesanGalatPembatalan("NETWORK_ERROR", 0, fase) };
  }

  /** Asks the server for the quote and renders it; on a refusal shows the error state with the confirm button disabled. */
  async function muatKuota(): Promise<boolean> {
    if (kode === null) return false;
    shownQuote = null;
    setDialogLoading();
    try {
      renderQuote(await ambilKuotaPembatalan(kode));
      return true;
    } catch (error) {
      const info = errorInfo(error, "kuota");
      handleDialogRefusal(info.refusal);
      return false;
    }
  }

  /** What the page does after a refusal that ends the dialog's job (session gone, reservation moved on). */
  function handleDialogRefusal(refusal: PesanGalatBatal): void {
    // When the dialog can no longer lead to a cancellation, its safe button becomes a plain "Tutup".
    keepButton.textContent = refusal.next === "muat-ulang" || refusal.next === "hubungi" ? "Tutup" : KEEP_LABEL;
    if (refusal.next === "masuk") {
      tutupDialog(false);
      hooks.onBelumMasuk();
      return;
    }
    if (refusal.next === "muat-ulang") {
      // The reservation moved on (or is not the shopper's): say so inside the dialog, then show the server's current state.
      showDialogError(refusal);
      confirmButton.disabled = true;
      void refresh();
      return;
    }
    showDialogError(refusal);
    confirmButton.disabled = true;
  }

  async function bukaDialog(trigger: HTMLElement): Promise<void> {
    if (kode === null) return;
    opener = trigger;
    attempt = null;
    inDoubt = null;
    busy = false;
    keepButton.disabled = false;
    keepButton.textContent = KEEP_LABEL;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    keepButton.focus();
    await muatKuota();
  }

  function tutupDialog(kembaliKeOpener: boolean): void {
    if (dialog.open) dialog.close();
    if (kembaliKeOpener && opener && opener.isConnected) opener.focus();
  }

  /** Same figure, same key; a different figure (or request) takes a fresh one. */
  function kunciUntuk(code: string, refund: string): string {
    const print = `${code}|${refund}`;
    if (attempt === null || attempt.print !== print) attempt = { print, key: crypto.randomUUID() };
    return attempt.key;
  }

  function sama(a: KuotaPembatalan, b: KuotaPembatalan): boolean {
    const refund = bandingkanUang(a.computedRefund, b.computedRefund);
    const paid = bandingkanUang(a.amountPaid, b.amountPaid);
    return refund === 0 && paid === 0 && a.policySource === b.policySource;
  }

  async function konfirmasi(): Promise<void> {
    if (busy || kode === null || shownQuote === null) return;
    const code = kode;
    const shown = shownQuote;
    setDialogBusy(true);
    cancelError.hidden = true;
    cancelStatus.textContent = inDoubt !== null ? "Mengirim ulang permintaan yang sama..." : "Memeriksa jumlah pengembalian dana terbaru...";

    let fresh: KuotaPembatalan;
    if (inDoubt !== null && inDoubt.code === code && bandingkanUang(inDoubt.refund, shown.computedRefund) === 0) {
      // Replaying an in-doubt request: the same figure under the same key; the server answers with the recorded result.
      fresh = shown;
    } else {
      inDoubt = null;
      // The quote is asked for again on confirm: the figure on screen is only what the shopper last saw.
      try {
        fresh = await ambilKuotaPembatalan(code);
      } catch (error) {
        setDialogBusy(false);
        handleDialogRefusal(errorInfo(error, "kuota").refusal);
        keepButton.disabled = false;
        return;
      }
      if (!sama(shown, fresh)) {
        setDialogBusy(false);
        renderQuote(fresh);
        cancelStatus.textContent = "Jumlah pengembalian dana berubah. Tidak ada yang dibatalkan. Periksa jumlah yang baru, lalu konfirmasi lagi.";
        return;
      }
      renderQuote(fresh);
    }

    cancelStatus.textContent = "Membatalkan reservasi...";
    try {
      const result = await batalkanReservasi(code, fresh.computedRefund, kunciUntuk(code, fresh.computedRefund));
      attempt = null;
      inDoubt = null;
      setDialogBusy(false);
      tutupDialog(false);
      await sesudahBatal(result.finalRefund);
    } catch (error) {
      const info = errorInfo(error, "batal");
      setDialogBusy(false);
      cancelStatus.textContent = "";
      const unknownOutcome = !(error instanceof TokoApiError) || error.code === "NETWORK_ERROR" || error.code === "INVALID_RESPONSE";
      inDoubt = unknownOutcome ? { code, refund: fresh.computedRefund } : null;
      if (info.refusal.next === "tinjau-ulang") {
        // Nothing was cancelled: show the server's current figure for a fresh confirmation.
        const reloaded = await muatKuota();
        if (reloaded) {
          cancelError.hidden = false;
          cancelErrorMessage.textContent = info.refusal.message;
          cancelRetry.hidden = true;
          if (!(shownQuote && rincianPembatalan(shownQuote, formatPrice).tanpaKebijakan)) confirmButton.disabled = false;
        }
        return;
      }
      handleDialogRefusal(info.refusal);
      // A retry of the SAME request (a dropped connection) keeps the confirm button usable and reuses the key.
      if (info.refusal.next === "coba-lagi" || info.refusal.next === "tunggu") confirmButton.disabled = false;
    }
  }

  async function sesudahBatal(finalRefund: string): Promise<void> {
    const message = pesanBerhasilBatal(finalRefund, formatPrice);
    resultEl.replaceChildren();
    const heading = document.createElement("h3");
    heading.tabIndex = -1;
    heading.textContent = "Reservasi dibatalkan";
    const text = document.createElement("p");
    text.textContent = message;
    resultEl.append(heading, text);
    resultEl.classList.add("booking-result--shown");
    // The server's own state is the final word: re-read it so the pills, the money rows and the refund line follow.
    await refresh();
    heading.focus();
  }

  keepButton.addEventListener("click", () => tutupDialog(true));
  confirmButton.addEventListener("click", () => void konfirmasi());
  cancelRetry.addEventListener("click", () => {
    if (shownQuote === null) void muatKuota();
    else void konfirmasi();
  });
  // Escape closes without cancelling anything - except while a request is in flight, when the outcome must stay visible.
  dialog.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
  dialog.addEventListener("close", () => {
    shownQuote = null;
    if (opener && opener.isConnected && document.activeElement !== opener) opener.focus();
  });

  function resetDialog(): void {
    if (dialog.open) dialog.close();
    shownQuote = null;
    attempt = null;
    inDoubt = null;
    busy = false;
    opener = null;
  }

  return {
    tampil(code) {
      stopTimers();
      resetDialog();
      kode = code;
      current = null;
      order = null;
      resultEl.replaceChildren();
      resultEl.classList.remove("booking-result--shown");
      actionStatusEl.textContent = "";
      view.hidden = false;
      void load();
    },
    sembunyi() {
      generation += 1;
      stopTimers();
      resetDialog();
      view.hidden = true;
    }
  };
}
