/**
 * `/booking/pesan` interactivity (issue #386, ADR-0045,
 * `docs/booking-ux-flows.md` sections 2.2 and 3): confirm the stay, hold it,
 * count the hold down, and hand the shopper to the existing payment flow.
 *
 * ## Views, one at a time
 *
 * `memuat` -> `kosong` (no/invalid stay) | `masuk` (no session) |
 * `tidak-tersedia` (the tenant's booking feature is off) | `form`; `form` ->
 * `menahan` -> `tahan` | back to `form` with the refusal; `tahan` ->
 * `berhasil` (the server confirmed it) | `habis` (the server expired it).
 *
 * ## The hold, the clock and the server
 *
 * The hold response carries `holdExpiresAt` and the server's own `serverNow`;
 * the remaining time is their difference minus the time elapsed on this
 * device's MONOTONIC clock (`performance.now()`), so a wrong device clock cannot
 * lengthen or shorten a hold. The ticking digits sit in a plain element, never
 * a live region; a visually-hidden status region announces only at the start, 5
 * minutes, 1 minute (alert) and expiry (alert). At zero the page does NOT decide:
 * it asks the server, which is authoritative (a payment that landed in the last
 * second wins, and a hold the server still shows live keeps counting). The page
 * re-asks when it regains visibility, when the network returns, and every few
 * seconds while held (the payment may have settled in another tab).
 *
 * ## Money
 *
 * Nights, totals and the deposit are the server's strings (the quote, then the
 * hold's settlement); this file computes none of them. The idempotency key is
 * generated once per attempt and reused for a retry of the SAME request; a
 * changed request takes a fresh key. The only thing kept across a reload is the
 * order code of this tab's hold, in `sessionStorage`.
 */
import { buatReservasiBooking, ambilReservasiSaya, ambilReservasiSayaByKode } from "../lib/akun-klien";
import { bacaSesi } from "../lib/akun-sesi";
import {
  BOOKING_AKTIF_KEY,
  buatHoldAktif,
  buatPathPesan,
  formatSisa,
  formatTanggalPendek,
  isNol,
  parseHoldAktif,
  parseParamPesan,
  pengumumanAmbang,
  pesanGalatBooking,
  sidikPermintaan,
  sisaDetik,
  teksSisa,
  tujuanSesiGateway,
  type KuotaBooking,
  type MetodeBayarBooking,
  type ParamPesan,
  type ReservasiSaya,
  type RingkasanPembayaranBooking
} from "../lib/booking-kontrak";
import { isValidGatewayRedirectUrl } from "../lib/gateway-redirect";
import { formatPrice } from "../lib/harga";
import { PESANAN_PHONE_KEY } from "../lib/pesanan-sesi";
import { ambilKuotaBooking, createGatewaySession } from "../lib/toko-klien";
import { TokoApiError } from "../lib/toko-permintaan";
import { buildWhatsappAccountMessage, buildWhatsappUrl } from "../lib/wa-fallback";

const POLL_START_MS = 10_000;
const POLL_MAX_MS = 60_000;

const root = document.querySelector<HTMLElement>("[data-pesan-root]");
if (root) {
  const views = Array.from(root.querySelectorAll<HTMLElement>("[data-view]"));
  const q = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const announce = q("[data-announce]");
  const announceUrgent = q("[data-announce-urgent]");
  const errorEl = q("[data-submit-error]");
  const errorMessageEl = q("[data-submit-error-message]");
  const errorChangeDates = q<HTMLAnchorElement>("[data-error-change-dates]");
  const waLink = q<HTMLAnchorElement>("[data-wa-fallback-link]");
  const form = q<HTMLFormElement>("[data-pesan-form]");
  const submitButton = q<HTMLButtonElement>("[data-submit]");
  const paymentOptions = q("[data-payment-options]");
  const pointsNote = q("[data-points-note]");
  const notesInput = q<HTMLTextAreaElement>("#pesan-catatan");
  const countdownEl = q("[data-countdown]");
  const oneMinuteNote = q("[data-one-minute-note]");
  const holdStatus = q("[data-hold-status]");
  const payButton = q<HTMLButtonElement>("[data-pay]");
  const instructionsLink = q<HTMLAnchorElement>("[data-instructions]");

  const whatsappNumber = root.dataset.whatsappNumber ?? "";
  const storeName = root.dataset.storeName ?? "toko";
  const loginHref = root.dataset.loginHref ?? "/masuk";

  const param: ParamPesan | null = parseParamPesan(window.location.search);

  let quote: KuotaBooking | null = null;
  let attemptKey: string | null = null;
  let attemptPrint = "";

  // The live hold.
  let hold: {
    item: ReservasiSaya;
    receivedAt: number;
    initialSeconds: number;
    lastSeconds: number | null;
  } | null = null;
  let tickTimer: number | undefined;
  let pollTimer: number | undefined;
  let pollDelay = POLL_START_MS;

  // --- views ------------------------------------------------------------------

  function show(name: string): void {
    for (const view of views) view.hidden = view.dataset.view !== name;
    if (name !== "form") hideError();
  }

  function focusHeading(selector: string): void {
    root!.querySelector<HTMLElement>(selector)?.focus();
  }

  function hideError(): void {
    errorEl.hidden = true;
  }

  function showError(message: string, options: { changeDates?: boolean; whatsapp?: boolean } = {}): void {
    errorMessageEl.textContent = message;
    errorChangeDates.hidden = !options.changeDates;
    if (param) errorChangeDates.href = backToSearchHref();
    if (options.whatsapp && whatsappNumber) {
      waLink.href = buildWhatsappUrl(whatsappNumber, buildWhatsappAccountMessage(storeName, "menahan kamar"));
      waLink.hidden = false;
    } else {
      waLink.hidden = true;
    }
    errorEl.hidden = false;
    errorEl.focus();
  }

  function backToSearchHref(): string {
    if (!param) return "/booking";
    const query = new URLSearchParams({
      o: param.offeringId,
      in: param.masuk,
      out: param.keluar,
      n: String(param.tamu)
    });
    return `/booking?${query.toString()}`;
  }

  function say(message: string, urgent: boolean): void {
    const target = urgent ? announceUrgent : announce;
    // Clear first so an identical message is announced again.
    target.textContent = "";
    window.setTimeout(() => {
      target.textContent = message;
    }, 50);
  }

  function rememberHold(kode: string): void {
    if (!param) return;
    try {
      window.sessionStorage.setItem(
        BOOKING_AKTIF_KEY,
        buatHoldAktif({ kode, offeringId: param.offeringId, masuk: param.masuk, keluar: param.keluar })
      );
    } catch {
      // A blocked storage only means a reload forgets the hold; it is on the server.
    }
  }

  function forgetHold(): void {
    try {
      window.sessionStorage.removeItem(BOOKING_AKTIF_KEY);
    } catch {
      // See rememberHold.
    }
  }

  // --- start ------------------------------------------------------------------

  async function start(): Promise<void> {
    show("memuat");
    const sesi = bacaSesi();
    if (!param) {
      show("kosong");
      return;
    }
    if (!sesi) {
      q<HTMLAnchorElement>("[data-login-link]").href =
        `${loginHref}?kembali=${encodeURIComponent(window.location.pathname + window.location.search)}`;
      show("masuk");
      return;
    }

    let remembered = null;
    try {
      remembered = parseHoldAktif(window.sessionStorage.getItem(BOOKING_AKTIF_KEY));
    } catch {
      remembered = null;
    }
    if (
      remembered &&
      remembered.offeringId === param.offeringId &&
      remembered.masuk === param.masuk &&
      remembered.keluar === param.keluar
    ) {
      if (await recover(remembered.kode)) return;
      forgetHold();
    }
    await loadForm();
  }

  /** A reload of this stay's page after a hold was made: find the reservation again and show its state. */
  async function recover(kode: string): Promise<boolean> {
    try {
      const page = await ambilReservasiSaya();
      const item = page.items.find((entry) => entry.orderCode === kode);
      if (!item) return false;
      try {
        quote = await ambilKuotaBooking(
          { offeringId: param!.offeringId, checkInDate: param!.masuk, checkOutDate: param!.keluar },
          bacaSesi()?.token
        );
      } catch {
        quote = null;
      }
      present(item);
      return true;
    } catch {
      return false;
    }
  }

  async function loadForm(): Promise<void> {
    show("memuat");
    try {
      quote = await ambilKuotaBooking(
        { offeringId: param!.offeringId, checkInDate: param!.masuk, checkOutDate: param!.keluar },
        bacaSesi()?.token
      );
    } catch (error) {
      if (error instanceof TokoApiError && error.status === 404) {
        show("tidak-tersedia");
        return;
      }
      if (error instanceof TokoApiError && error.code === "UNAUTHENTICATED") {
        void start();
        return;
      }
      show("kosong");
      const unreachable = !(error instanceof TokoApiError) || error.code === "NETWORK_ERROR" || error.code === "INVALID_RESPONSE";
      showError(
        unreachable ? "Tidak dapat memuat harga. Periksa koneksi Anda, lalu coba lagi." : "Tanggal yang dipilih tidak dapat dipesan.",
        { changeDates: true, whatsapp: unreachable }
      );
      return;
    }
    renderForm(quote);
    show("form");
    q("#pesan-judul-ringkasan").scrollIntoView?.({ block: "nearest" });
  }

  // --- the form ---------------------------------------------------------------

  const METODE_LABEL: Record<MetodeBayarBooking, (kuota: KuotaBooking) => { title: string; hint: string } | null> = {
    gateway: (kuota) => ({
      title: "Bayar penuh sekarang (online)",
      hint: `Bayar ${formatPrice(kuota.total)} lewat halaman pembayaran aman.`
    }),
    dp: (kuota) =>
      kuota.deposit.available
        ? {
            title: `Uang muka ${formatPrice(kuota.deposit.amount)}`,
            hint: `Sisa ${formatPrice(kuota.deposit.balanceDue)} dibayar saat check-in atau lebih awal.`
          }
        : null,
    manual_bank: (kuota) => ({
      title: "Transfer bank (bayar penuh)",
      hint: `Transfer ${formatPrice(kuota.total)} lalu konfirmasi pembayaran.`
    }),
    manual_qris: (kuota) => ({
      title: "QRIS (bayar penuh)",
      hint: `Bayar ${formatPrice(kuota.total)} dengan QRIS lalu konfirmasi pembayaran.`
    })
  };

  function renderForm(kuota: KuotaBooking): void {
    const sesi = bacaSesi();
    q("[data-sum-name]").textContent = kuota.product.name;
    q("[data-sum-stay]").textContent =
      kuota.nights === null
        ? "-"
        : `${kuota.nights} malam: ${formatTanggalPendek(param!.masuk)} sampai ${formatTanggalPendek(param!.keluar)}`;
    q("[data-sum-unit]").textContent = formatPrice(kuota.unitPrice);
    q("[data-sum-total]").textContent = formatPrice(kuota.total);
    q<HTMLAnchorElement>("[data-change-dates]").href = backToSearchHref();
    q("[data-guest-line]").textContent = sesi ? `Atas nama ${sesi.account.name} (${sesi.account.phone})` : "";

    paymentOptions.innerHTML = "";
    let first = true;
    for (const entry of kuota.paymentMethods) {
      if (!entry.available) continue;
      const metode = entry.method as MetodeBayarBooking;
      const label = METODE_LABEL[metode]?.(kuota);
      if (!label) continue;
      const wrap = document.createElement("label");
      wrap.className = "booking-radio";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "payment.method";
      input.value = metode;
      input.checked = first;
      first = false;
      input.addEventListener("change", updatePointsNote);
      const text = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = label.title;
      const hint = document.createElement("span");
      hint.className = "toko-field-hint";
      hint.textContent = ` ${label.hint}`;
      text.append(strong, document.createElement("br"), hint);
      wrap.append(input, text);
      paymentOptions.appendChild(wrap);
    }
    submitButton.disabled = first;
    if (first) {
      paymentOptions.textContent = "Belum ada metode pembayaran yang tersedia untuk layanan ini.";
    }
    updatePointsNote();
  }

  function selectedMethod(): MetodeBayarBooking | null {
    const checked = paymentOptions.querySelector<HTMLInputElement>('input[name="payment.method"]:checked');
    return checked ? (checked.value as MetodeBayarBooking) : null;
  }

  function updatePointsNote(): void {
    pointsNote.hidden = selectedMethod() !== "dp";
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit();
  });

  async function submit(): Promise<void> {
    const method = selectedMethod();
    if (!method || !param || !quote) return;
    for (const target of root!.querySelectorAll<HTMLElement>("[data-error-for]")) target.textContent = "";
    const notes = notesInput.value.trim();
    const request = {
      offeringId: param.offeringId,
      resourceId: param.resourceId,
      stay: { checkInDate: param.masuk, checkOutDate: param.keluar },
      partySize: param.tamu,
      payment: { method },
      notes: notes.length > 0 ? notes : null
    };
    // One key per attempt: a retry of the SAME request reuses it, a changed request takes a new one.
    const print = sidikPermintaan(request);
    if (attemptKey === null || print !== attemptPrint) {
      attemptKey = crypto.randomUUID();
      attemptPrint = print;
    }

    show("menahan");
    try {
      const created = await buatReservasiBooking(request, attemptKey);
      attemptKey = null;
      rememberHold(created.orderCode);
      present({
        serverNow: created.serverNow,
        reservationId: created.reservation.id,
        reservationNo: created.reservation.reservationNo,
        orderId: created.orderId,
        orderCode: created.orderCode,
        orderStatus: "pending_payment",
        status: created.reservation.status,
        linkStatus: "active",
        holdExpiresAt: created.reservation.holdExpiresAt,
        startsAt: created.reservation.startsAt,
        endsAt: created.reservation.endsAt,
        settlement: created.settlement,
        productName: quote.product.name,
        nights: quote.nights,
        paymentMethod: method
      });
    } catch (error) {
      show("form");
      handleSubmitError(error);
    }
  }

  function handleSubmitError(error: unknown): void {
    if (!(error instanceof TokoApiError)) {
      showError("Terjadi gangguan. Coba lagi.");
      return;
    }
    if (error.code === "UNAUTHENTICATED") {
      // The client already cleared the session; the chosen stay is in the address and survives sign-in.
      void start();
      return;
    }
    if (error.code === "VALIDATION_ERROR" && error.fieldErrors.length > 0) {
      for (const entry of error.fieldErrors) {
        const target = root!.querySelector<HTMLElement>(`[data-error-for="${entry.field}"]`);
        if (target) target.textContent = entry.message;
      }
      showError(pesanGalatBooking("VALIDATION_ERROR").message);
      return;
    }
    const unreachable = error.code === "NETWORK_ERROR" || error.code === "INVALID_RESPONSE";
    const mapped = pesanGalatBooking(error.code, error.status);
    // The same stay may be tried again with the same key (the call is idempotent); a refusal needs other dates.
    showError(unreachable ? "Terjadi gangguan. Coba lagi." : mapped.message, {
      changeDates: mapped.next === "pilih-tanggal" || mapped.next === "mulai-ulang",
      whatsapp: unreachable
    });
  }

  // --- the hold ---------------------------------------------------------------

  /** Shows whichever view the reservation's state calls for. */
  function present(item: ReservasiSaya): void {
    stopTimers();
    if (item.status === "confirmed" || item.status === "checked_in" || item.status === "completed") {
      showConfirmed(item);
      return;
    }
    if (item.status !== "held") {
      showExpired(item);
      return;
    }
    showHold(item);
  }

  function showHold(item: ReservasiSaya): void {
    const expiresAt = item.holdExpiresAt;
    if (!expiresAt) {
      showExpired(item);
      return;
    }
    hold = {
      item,
      receivedAt: performance.now(),
      initialSeconds: sisaDetik(expiresAt, item.serverNow, 0),
      lastSeconds: null
    };

    q("[data-hold-order]").textContent = item.orderCode;
    q("[data-hold-stay]").textContent =
      quote && quote.nights !== null
        ? `${quote.nights} malam: ${formatTanggalPendek(param!.masuk)} sampai ${formatTanggalPendek(param!.keluar)}`
        : item.nights !== null
          ? `${item.nights} malam`
          : "-";
    q("[data-hold-total]").textContent = formatPrice(item.settlement.total);
    const deposit = item.paymentMethod === "dp";
    q("[data-hold-deposit-label]").textContent = deposit ? "Uang muka yang harus dibayar sekarang" : "Bayar penuh sekarang";
    q("[data-hold-deposit]").textContent = formatPrice(
      deposit ? (item.settlement.deposit ?? item.settlement.total) : item.settlement.total
    );
    const balanceRow = q("[data-hold-balance-row]");
    balanceRow.hidden = !(deposit && quote?.deposit.available);
    if (!balanceRow.hidden && quote) q("[data-hold-balance]").textContent = formatPrice(quote.deposit.balanceDue);
    holdStatus.textContent = "";
    oneMinuteNote.hidden = true;

    const purpose = tujuanSesiGateway(item);
    payButton.hidden = purpose === null;
    payButton.disabled = false;
    payButton.textContent = purpose === "deposit" ? "Bayar uang muka sekarang" : "Bayar sekarang";
    instructionsLink.hidden = item.paymentMethod === "gateway";
    instructionsLink.href = `/pesanan?kode=${encodeURIComponent(item.orderCode)}`;

    show("tahan");
    focusHeading("[data-hold-heading]");
    tick();
    tickTimer = window.setInterval(tick, 1000);
    pollDelay = POLL_START_MS;
    schedulePoll();
  }

  function remaining(): number {
    if (!hold || !hold.item.holdExpiresAt) return 0;
    return sisaDetik(hold.item.holdExpiresAt, hold.item.serverNow, performance.now() - hold.receivedAt);
  }

  function tick(): void {
    if (!hold) return;
    const sisa = remaining();
    countdownEl.textContent = teksSisa(sisa);
    countdownEl.classList.toggle("booking-countdown--urgent", sisa > 0 && sisa < 60);
    const announcement = pengumumanAmbang(hold.lastSeconds, sisa, hold.initialSeconds);
    hold.lastSeconds = sisa;
    if (announcement) {
      say(announcement.message, announcement.urgent);
      if (announcement.kind === "satu-menit") oneMinuteNote.hidden = false;
    }
    if (sisa <= 0) {
      window.clearInterval(tickTimer);
      tickTimer = undefined;
      // The server decides: a payment may have landed, or the hold may still be live.
      void resync(true);
    }
  }

  /** Asks the server for the reservation's state and re-bases the countdown on its answer. */
  async function resync(atZero = false): Promise<void> {
    if (!hold) return;
    const current = hold.item;
    try {
      const fresh = await ambilReservasiSayaByKode(current.orderCode);
      // A reply that arrives after the hold was replaced (a new attempt) is ignored.
      if (!hold || hold.item.orderCode !== current.orderCode) return;
      const merged: ReservasiSaya = {
        ...current,
        ...fresh,
        productName: current.productName,
        nights: current.nights,
        paymentMethod: current.paymentMethod
      };
      if (merged.status !== "held") {
        present(merged);
        return;
      }
      hold = { ...hold, item: merged, receivedAt: performance.now() };
      if (remaining() > 0) {
        if (atZero && tickTimer === undefined) tickTimer = window.setInterval(tick, 1000);
        tick();
      } else if (atZero) {
        showExpired(merged);
      }
    } catch (error) {
      if (error instanceof TokoApiError && error.code === "UNAUTHENTICATED") {
        void start();
        return;
      }
      // Unreachable at expiry: the local count already ended, so say so; the list page shows the truth.
      if (atZero) showExpired(current);
    }
  }

  function schedulePoll(): void {
    window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(async () => {
      if (!hold) return;
      if (document.visibilityState === "visible" && remaining() > 0) await resync();
      pollDelay = Math.min(POLL_MAX_MS, Math.round(pollDelay * 1.5));
      if (hold) schedulePoll();
    }, pollDelay);
  }

  function stopTimers(): void {
    window.clearInterval(tickTimer);
    window.clearTimeout(pollTimer);
    tickTimer = undefined;
    pollTimer = undefined;
    hold = null;
  }

  function showExpired(item: ReservasiSaya): void {
    stopTimers();
    forgetHold();
    const text =
      item.status === "cancelled"
        ? "Reservasi ini dibatalkan. Pilih tanggal lagi jika Anda masih ingin menginap."
        : isNol(item.settlement.settled)
          ? "Waktu penahanan habis. Kamar dilepas. Pilih tanggal lagi."
          : `Waktu penahanan habis sebelum pembayaran kami terima. Jika Anda sudah membayar, tim kami akan menghubungi Anda untuk pengembalian dana atau penjadwalan ulang. Nomor pesanan: ${item.orderCode}`;
    q("[data-expired-text]").textContent = text;
    q<HTMLAnchorElement>("[data-restart]").href = backToSearchHref();
    show("habis");
    say("Waktu penahanan habis. Kamar dilepas.", true);
    focusHeading("[data-expired-heading]");
  }

  function showConfirmed(item: ReservasiSaya): void {
    stopTimers();
    forgetHold();
    const sisa = item.settlement.balanceDue ?? item.settlement.outstanding;
    q("[data-success-text]").textContent = isNol(sisa)
      ? "Pembayaran diterima. Reservasi Anda terkonfirmasi."
      : `Uang muka diterima. Reservasi Anda terkonfirmasi. Sisa pembayaran ${formatPrice(sisa)} dibayar saat check-in atau lebih awal.`;
    show("berhasil");
    say("Reservasi Anda terkonfirmasi.", false);
    focusHeading("[data-success-heading]");
  }

  // --- payment handoff --------------------------------------------------------

  payButton.addEventListener("click", async () => {
    if (!hold) return;
    const sesi = bacaSesi();
    if (!sesi) {
      void start();
      return;
    }
    const purpose = tujuanSesiGateway(hold.item);
    if (!purpose) return;
    payButton.disabled = true;
    holdStatus.textContent = "Membuka halaman pembayaran...";
    try {
      const session = await createGatewaySession(hold.item.orderCode, null, sesi.token, purpose);
      if (!isValidGatewayRedirectUrl(session.redirectUrl)) {
        throw new Error("Gateway returned an unusable redirectUrl.");
      }
      window.location.assign(session.redirectUrl);
    } catch (error) {
      payButton.disabled = false;
      if (error instanceof TokoApiError && error.code === "UNAUTHENTICATED") {
        void start();
        return;
      }
      holdStatus.textContent =
        error instanceof TokoApiError && error.code === "GATEWAY_UNAVAILABLE"
          ? "Pembayaran online sedang tidak tersedia. Gunakan instruksi pembayaran."
          : error instanceof TokoApiError && error.code === "RATE_LIMITED"
            ? pesanGalatBooking("RATE_LIMITED").message
            : "Gagal membuka halaman pembayaran. Coba lagi.";
    }
  });

  instructionsLink.addEventListener("click", () => {
    // `/pesanan` asks for the order's phone; the signed-in account's own number answers it (same as checkout).
    const sesi = bacaSesi();
    if (!sesi) return;
    try {
      window.sessionStorage.setItem(PESANAN_PHONE_KEY, sesi.account.phone);
    } catch {
      // Blocked storage: /pesanan will simply ask for the phone.
    }
  });

  // --- keep the countdown honest ---------------------------------------------

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && hold) void resync();
  });
  window.addEventListener("online", () => {
    if (hold) void resync();
  });
  window.addEventListener("akun:berubah", () => {
    if (!bacaSesi() && root) void start();
  });

  void start();
}

export {};
