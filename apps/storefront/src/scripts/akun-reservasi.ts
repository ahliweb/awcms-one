/**
 * `/akun/reservasi` interactivity (issue #386, ADR-0045,
 * `docs/booking-ux-flows.md` sections 2.3 and 2.4): the signed-in shopper's own
 * reservations, a keyset list ("Muat lebih banyak") over
 * `GET …/booking/reservations` through `akun-klien.ts`, so the bearer session is
 * attached in one place and a `401 UNAUTHENTICATED` clears it (the guest view
 * then shows the sign-in prompt, with this page as the return address).
 *
 * Every figure is the server's: the status is Booking's, the money rows are the
 * ledger's settlement strings, the nights are the order line's quantity. What
 * this script adds is presentation (labels, pills, dates) and one live fact: a
 * `held` row shows how long its hold has left, computed from the server's
 * `holdExpiresAt` and `serverNow` and this device's monotonic clock; its text
 * is updated each second WITHOUT a live region. While any row is held the list
 * is re-read politely (backing off to a minute) so a payment that settles in
 * another tab or from the provider shows up, and a row whose hold ends is
 * re-read from the server instead of being declared expired locally.
 */
import { ambilReservasiSaya } from "../lib/akun-klien";
import { bacaSesi, hapusSesi } from "../lib/akun-sesi";
import { AKUN_EVENT_NAME } from "../lib/akun-kontrak";
import {
  formatSisa,
  formatTanggalPendek,
  isNol,
  labelPembayaran,
  labelStatusReservasi,
  pesanGalatBooking,
  sisaDetik,
  statusEfektif,
  tujuanSesiGateway,
  type NadaPil,
  type ReservasiSaya
} from "../lib/booking-kontrak";
import { isValidGatewayRedirectUrl } from "../lib/gateway-redirect";
import { formatPrice } from "../lib/harga";
import { createGatewaySession } from "../lib/toko-klien";
import { TokoApiError } from "../lib/toko-permintaan";
import { ROUTES } from "../config/routes";
import { buildWhatsappAccountMessage, buildWhatsappUrl } from "../lib/wa-fallback";

const POLL_START_MS = 15_000;
const POLL_MAX_MS = 60_000;

const root = document.querySelector<HTMLElement>("[data-reservasi-root]");
if (root) {
  const q = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const guestView = q("[data-guest-view]");
  const listView = q("[data-list-view]");
  const listEl = q<HTMLUListElement>("[data-list]");
  const emptyEl = q("[data-empty]");
  const loadingEl = q("[data-loading]");
  const loadMore = q<HTMLButtonElement>("[data-load-more]");
  const errorEl = q("[data-submit-error]");
  const errorMessageEl = q("[data-submit-error-message]");
  const retryButton = q<HTMLButtonElement>("[data-retry]");
  const waLink = q<HTMLAnchorElement>("[data-wa-fallback-link]");
  const announce = q("[data-announce]");

  const whatsappNumber = root.dataset.whatsappNumber ?? "";
  const storeName = root.dataset.storeName ?? "toko";

  type Row = { item: ReservasiSaya; receivedAt: number; countdownEl: HTMLElement | null };
  let rows: Row[] = [];
  let nextCursor: string | null = null;
  let tickTimer: number | undefined;
  let pollTimer: number | undefined;
  let pollDelay = POLL_START_MS;
  let generation = 0;

  function showError(error: unknown, context: string): void {
    const unreachable = !(error instanceof TokoApiError) || error.code === "NETWORK_ERROR" || error.code === "INVALID_RESPONSE";
    errorMessageEl.textContent = unreachable
      ? "Tidak dapat memuat reservasi. Periksa koneksi Anda, lalu coba lagi."
      : pesanGalatBooking(error.code, error.status).message;
    errorEl.hidden = false;
    if (whatsappNumber && unreachable) {
      waLink.href = buildWhatsappUrl(whatsappNumber, buildWhatsappAccountMessage(storeName, context));
      waLink.hidden = false;
    } else {
      waLink.hidden = true;
    }
  }

  function pill(label: string, tone: NadaPil): HTMLElement {
    const el = document.createElement("span");
    el.className = tone === "neutral" ? "pill" : `pill pill--${tone}`;
    el.textContent = label;
    return el;
  }

  function stayText(item: ReservasiSaya): string {
    // Check-in is at midday-ish in the property's zone; the UTC calendar date is the stay's date in every zone this storefront serves.
    const masuk = item.startsAt.slice(0, 10);
    const nights = item.nights;
    if (nights === null) return formatTanggalPendek(masuk);
    const keluarMs = Date.parse(`${masuk}T00:00:00Z`) + nights * 86_400_000;
    const keluar = new Date(keluarMs).toISOString().slice(0, 10);
    return `${formatTanggalPendek(masuk)} sampai ${formatTanggalPendek(keluar)} (${nights} malam)`;
  }

  function renderRow(row: Row): HTMLLIElement {
    // A hold past its server-clock expiry with nothing settled reads as expired at once; the
    // refresh below re-reads the server for the final word.
    const item: ReservasiSaya = {
      ...row.item,
      status: statusEfektif(row.item, performance.now() - row.receivedAt)
    };
    const li = document.createElement("li");
    li.className = "akun-card booking-reservation";
    li.dataset.orderCode = item.orderCode;

    const head = document.createElement("div");
    head.className = "booking-reservation-head";
    const title = document.createElement("h2");
    title.textContent = item.productName;
    const status = labelStatusReservasi(item.status);
    head.append(title, pill(status.label, status.tone));
    const payment = labelPembayaran(item, formatPrice);
    head.append(pill(payment.label, payment.tone));
    li.appendChild(head);

    const stay = document.createElement("p");
    stay.textContent = stayText(item);
    li.appendChild(stay);

    const meta = document.createElement("p");
    meta.className = "toko-field-hint";
    const balance = item.settlement.balanceDue ?? item.settlement.outstanding;
    const parts = [`No. reservasi ${item.reservationNo}`, `Pesanan ${item.orderCode}`];
    if (item.status !== "expired" && item.status !== "cancelled") {
      parts.push(`Sisa pembayaran ${isNol(balance) ? "lunas" : formatPrice(balance)}`);
    }
    meta.textContent = parts.join(" · ");
    li.appendChild(meta);

    if (item.status === "held" && item.holdExpiresAt) {
      const countdown = document.createElement("p");
      countdown.dataset.holdLeft = "";
      li.appendChild(countdown);
      row.countdownEl = countdown;
    }

    const actions = document.createElement("div");
    actions.className = "booking-reservation-actions";
    const purpose = tujuanSesiGateway(item);
    if (purpose) {
      const pay = document.createElement("button");
      pay.type = "button";
      pay.className = "btn btn--primary btn--sm";
      pay.textContent =
        purpose === "deposit" ? "Bayar uang muka" : purpose === "balance" ? "Bayar sisa pembayaran" : "Bayar sekarang";
      pay.addEventListener("click", () => void payNow(item, purpose, pay));
      actions.appendChild(pay);
    }
    const detail = document.createElement("a");
    detail.className = "btn btn--secondary btn--sm";
    detail.href = ROUTES.accountOrder(item.orderCode);
    detail.textContent = "Detail pesanan";
    actions.appendChild(detail);
    li.appendChild(actions);

    const note = document.createElement("p");
    note.className = "toko-field-hint";
    note.dataset.rowStatus = "";
    note.setAttribute("role", "status");
    li.appendChild(note);
    return li;
  }

  function appendRows(items: ReservasiSaya[]): void {
    const received = performance.now();
    for (const item of items) {
      const row: Row = { item, receivedAt: received, countdownEl: null };
      rows.push(row);
      listEl.appendChild(renderRow(row));
    }
    emptyEl.hidden = rows.length > 0;
    updateCountdowns();
    ensureTimers();
  }

  function holdLeft(row: Row): number {
    const { item } = row;
    if (!item.holdExpiresAt) return 0;
    return sisaDetik(item.holdExpiresAt, item.serverNow, performance.now() - row.receivedAt);
  }

  /** Plain text updates, no live region: a per-second announcement is unusable (WCAG 2.2.1 / 4.1.3). */
  function updateCountdowns(): void {
    let anyExpired = false;
    for (const row of rows) {
      if (!row.countdownEl) continue;
      const left = holdLeft(row);
      row.countdownEl.textContent =
        left > 0 ? `Kamar ditahan, sisa waktu ${formatSisa(left)}` : "Menunggu pembaruan dari server...";
      if (left <= 0) anyExpired = true;
    }
    // The server, not this clock, says whether a hold is over: ask once, then at most every 10 seconds.
    if (anyExpired && !refreshing && Date.now() - lastExpiryRefresh > 10_000) {
      lastExpiryRefresh = Date.now();
      void refresh();
    }
  }

  function hasLiveHold(): boolean {
    return rows.some((row) => row.item.status === "held" && statusEfektif(row.item, performance.now() - row.receivedAt) === "held");
  }

  function ensureTimers(): void {
    if (hasLiveHold() && tickTimer === undefined) tickTimer = window.setInterval(updateCountdowns, 1000);
    if (!hasLiveHold()) {
      window.clearInterval(tickTimer);
      tickTimer = undefined;
      window.clearTimeout(pollTimer);
      pollTimer = undefined;
      return;
    }
    if (pollTimer === undefined) schedulePoll();
  }

  function schedulePoll(): void {
    pollTimer = window.setTimeout(async () => {
      pollTimer = undefined;
      if (document.visibilityState === "visible" && hasLiveHold()) await refresh();
      pollDelay = Math.min(POLL_MAX_MS, Math.round(pollDelay * 1.5));
      if (hasLiveHold()) schedulePoll();
    }, pollDelay);
  }

  let refreshing = false;
  let lastExpiryRefresh = 0;
  /** Re-reads as many pages as are already shown (a live hold is on the first) and replaces the rows. */
  async function refresh(): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    const mine = generation;
    try {
      const before = new Map(rows.map((row) => [row.item.orderCode, row.item.status]));
      const wanted = rows.length;
      const collected: ReservasiSaya[] = [];
      let cursor: string | null = null;
      for (let pages = 0; pages < 5; pages += 1) {
        const page = await ambilReservasiSaya(cursor);
        collected.push(...page.items);
        cursor = page.nextCursor;
        if (!cursor || collected.length >= wanted) break;
      }
      if (mine !== generation) return;
      nextCursor = cursor;
      loadMore.hidden = !cursor;
      rows = [];
      listEl.innerHTML = "";
      appendRows(collected);
      for (const row of rows) {
        const was = before.get(row.item.orderCode);
        if (was && was !== row.item.status) {
          announce.textContent = `Status reservasi ${row.item.orderCode}: ${labelStatusReservasi(row.item.status).label}.`;
        }
      }
    } catch (error) {
      if (error instanceof TokoApiError && error.code === "UNAUTHENTICATED") render();
      // A transient failure while polling is not a stop condition.
    } finally {
      refreshing = false;
    }
  }

  async function payNow(item: ReservasiSaya, purpose: "full" | "deposit" | "balance", button: HTMLButtonElement): Promise<void> {
    const sesi = bacaSesi();
    if (!sesi) {
      render();
      return;
    }
    const note = listEl.querySelector<HTMLElement>(`[data-order-code="${CSS.escape(item.orderCode)}"] [data-row-status]`);
    button.disabled = true;
    if (note) note.textContent = "Membuka halaman pembayaran...";
    try {
      const session = await createGatewaySession(item.orderCode, null, sesi.token, purpose);
      if (!isValidGatewayRedirectUrl(session.redirectUrl)) throw new Error("Gateway returned an unusable redirectUrl.");
      window.location.assign(session.redirectUrl);
    } catch (error) {
      button.disabled = false;
      if (error instanceof TokoApiError && error.code === "UNAUTHENTICATED") {
        hapusSesi();
        render();
        return;
      }
      if (note) {
        note.textContent =
          error instanceof TokoApiError && error.code === "GATEWAY_UNAVAILABLE"
            ? "Pembayaran online sedang tidak tersedia. Buka detail pesanan untuk instruksi pembayaran."
            : error instanceof TokoApiError && error.code === "RATE_LIMITED"
              ? pesanGalatBooking("RATE_LIMITED").message
              : "Gagal membuka halaman pembayaran. Coba lagi.";
      }
    }
  }

  async function load(): Promise<void> {
    errorEl.hidden = true;
    loadingEl.hidden = false;
    listEl.setAttribute("aria-busy", "true");
    try {
      const page = await ambilReservasiSaya(nextCursor);
      appendRows(page.items);
      nextCursor = page.nextCursor;
      loadMore.hidden = !nextCursor;
    } catch (error) {
      if (error instanceof TokoApiError && error.code === "UNAUTHENTICATED") {
        render();
        return;
      }
      showError(error, "memuat daftar reservasi saya");
    } finally {
      loadingEl.hidden = true;
      listEl.setAttribute("aria-busy", "false");
    }
  }

  retryButton.addEventListener("click", () => void load());
  loadMore.addEventListener("click", () => void load());

  function reset(): void {
    generation += 1;
    window.clearInterval(tickTimer);
    window.clearTimeout(pollTimer);
    tickTimer = undefined;
    pollTimer = undefined;
    pollDelay = POLL_START_MS;
    rows = [];
    nextCursor = null;
    listEl.innerHTML = "";
    emptyEl.hidden = true;
    loadMore.hidden = true;
  }

  function render(): void {
    reset();
    errorEl.hidden = true;
    const sesi = bacaSesi();
    if (!sesi) {
      guestView.hidden = false;
      listView.hidden = true;
      return;
    }
    guestView.hidden = true;
    listView.hidden = false;
    void load();
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && hasLiveHold()) void refresh();
  });
  window.addEventListener("online", () => {
    if (hasLiveHold()) void refresh();
  });
  render();
  window.addEventListener(AKUN_EVENT_NAME, render);
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === "awcms-one:akun:v1") render();
  });
}

export {};
