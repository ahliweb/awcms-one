/**
 * `/booking` interactivity (issue #386, ADR-0045, `docs/booking-ux-flows.md`
 * section 2.1): the service picker, the two native date inputs, the guest
 * count, and the live availability + quote panel.
 *
 * Everything the panel shows comes from the CMS's anonymous booking reads
 * through `toko-klien.ts` (`ambilTawaranBooking`, `ambilKetersediaanBooking`,
 * `ambilKuotaBooking`): the night count, the unit price, the total, the deposit
 * and the balance are the SERVER's strings, shown as they arrive. This script
 * only decides when to ask. A date change clears the old figures immediately
 * (never stale), a request that is no longer the latest is dropped, and the
 * "Lanjut" button stays disabled until a quote for the CURRENT dates exists.
 *
 * Availability is probed resource by resource (the offerings list names the
 * ids, never a name): the first resource with a free unit is the one the
 * hold will use. A range with no free resource is "Penuh", never an empty
 * success.
 *
 * Moving on carries the stay as plain ids and dates in the address
 * (`buatPathPesan`) and, signed out, sends the shopper through `/masuk` with
 * that address as `?kembali=`; nothing booking-related is stored.
 */
import { bacaSesi } from "../lib/akun-sesi";
import {
  buatPathPesan,
  formatTanggalPendek,
  labelZonaWaktu,
  parseParamCari,
  periksaTanggal,
  pesanGalatBooking,
  tanggalLokal,
  type TawaranBooking
} from "../lib/booking-kontrak";
import { formatPrice } from "../lib/harga";
import { ambilKetersediaanBooking, ambilKuotaBooking, ambilTawaranBooking } from "../lib/toko-klien";
import { TokoApiError } from "../lib/toko-permintaan";
import { buildWhatsappAccountMessage, buildWhatsappUrl } from "../lib/wa-fallback";

const root = document.querySelector<HTMLElement>("[data-booking-root]");
if (root) {
  const form = root.querySelector<HTMLFormElement>("[data-booking-form]")!;
  const unavailableEl = root.querySelector<HTMLElement>("[data-unavailable]")!;
  const errorEl = root.querySelector<HTMLElement>("[data-submit-error]")!;
  const errorMessageEl = root.querySelector<HTMLElement>("[data-submit-error-message]")!;
  const retryButton = root.querySelector<HTMLButtonElement>("[data-retry]")!;
  const waLink = root.querySelector<HTMLAnchorElement>("[data-wa-fallback-link]")!;
  const offeringsRegion = root.querySelector<HTMLElement>("[data-offerings-region]")!;
  const offeringsLoading = root.querySelector<HTMLElement>("[data-offerings-loading]")!;
  const offeringsEmpty = root.querySelector<HTMLElement>("[data-offerings-empty]")!;
  const offeringField = root.querySelector<HTMLElement>("[data-offering-field]")!;
  const offeringSelect = root.querySelector<HTMLSelectElement>("[data-offering-select]")!;
  const checkIn = root.querySelector<HTMLInputElement>("[data-check-in]")!;
  const checkOut = root.querySelector<HTMLInputElement>("[data-check-out]")!;
  const party = root.querySelector<HTMLInputElement>("[data-party]")!;
  const zoneHint = root.querySelector<HTMLElement>("[data-timezone-hint]")!;
  const quotePanel = root.querySelector<HTMLElement>("[data-quote-panel]")!;
  const quoteStatus = root.querySelector<HTMLElement>("[data-quote-status]")!;
  const fullEl = root.querySelector<HTMLElement>("[data-full]")!;
  const quoteList = root.querySelector<HTMLElement>("[data-quote-list]")!;
  const quoteNote = root.querySelector<HTMLElement>("[data-quote-note]")!;
  const continueButton = root.querySelector<HTMLButtonElement>("[data-continue]")!;
  const field = (name: string) => root.querySelector<HTMLElement>(`[data-error-for="${name}"]`);
  const text = (selector: string) => root.querySelector<HTMLElement>(selector)!;

  const whatsappNumber = root.dataset.whatsappNumber ?? "";
  const storeName = root.dataset.storeName ?? "toko";
  const loginHref = root.dataset.loginHref ?? "/masuk";

  let offerings: TawaranBooking[] = [];
  let sequence = 0;
  let timer: number | undefined;
  /** What the panel currently proves: set only by a complete, current answer. */
  let ready: { offeringId: string; resourceId: string; masuk: string; keluar: string; tamu: number } | null = null;

  function showError(error: unknown, retry: (() => void) | null): void {
    const code = error instanceof TokoApiError ? error.code : "NETWORK_ERROR";
    const status = error instanceof TokoApiError ? error.status : 0;
    const unreachable = code === "NETWORK_ERROR" || code === "INVALID_RESPONSE";
    errorMessageEl.textContent = unreachable
      ? "Tidak dapat memuat harga. Periksa koneksi Anda, lalu coba lagi."
      : pesanGalatBooking(code, status).message;
    errorEl.hidden = false;
    retryButton.hidden = retry === null;
    retryButton.onclick = retry ? () => retry() : null;
    if (whatsappNumber && unreachable) {
      waLink.href = buildWhatsappUrl(whatsappNumber, buildWhatsappAccountMessage(storeName, "memesan penginapan"));
      waLink.hidden = false;
    } else {
      waLink.hidden = true;
    }
  }

  function clearError(): void {
    errorEl.hidden = true;
  }

  function setFieldError(name: "checkInDate" | "checkOutDate" | "partySize", message: string | null): void {
    const target = field(name);
    const input = name === "checkInDate" ? checkIn : name === "checkOutDate" ? checkOut : party;
    if (target) target.textContent = message ?? "";
    if (message) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }

  function currentOffering(): TawaranBooking | null {
    return offerings.find((entry) => entry.offeringId === offeringSelect.value) ?? null;
  }

  function resetPanel(status: string): void {
    ready = null;
    continueButton.disabled = true;
    fullEl.hidden = true;
    quoteList.hidden = true;
    quoteNote.hidden = true;
    quoteStatus.hidden = false;
    quoteStatus.textContent = status;
    quotePanel.setAttribute("aria-busy", "false");
  }

  /** The latest answer wins: any older in-flight request is ignored. */
  async function refresh(): Promise<void> {
    sequence += 1;
    const mine = sequence;
    clearError();
    resetPanel("Pilih tanggal masuk dan tanggal keluar.");
    setFieldError("checkInDate", null);
    setFieldError("checkOutDate", null);
    setFieldError("partySize", null);

    const offering = currentOffering();
    if (!offering || !checkIn.value || !checkOut.value) return;

    const problem = periksaTanggal(checkIn.value, checkOut.value, tanggalLokal(new Date()));
    if (problem) {
      setFieldError(problem.field, problem.message);
      return;
    }
    const guests = Number.parseInt(party.value, 10);
    if (!Number.isInteger(guests) || guests < offering.minParty || guests > offering.maxParty) {
      setFieldError("partySize", `Jumlah tamu harus antara ${offering.minParty} dan ${offering.maxParty}.`);
      return;
    }

    quotePanel.setAttribute("aria-busy", "true");
    quoteStatus.textContent = "Menghitung harga...";
    const masuk = checkIn.value;
    const keluar = checkOut.value;
    const bearer = bacaSesi()?.token;

    try {
      const [chosen, quote] = await Promise.all([
        pickResource(offering, masuk, keluar),
        ambilKuotaBooking({ offeringId: offering.offeringId, checkInDate: masuk, checkOutDate: keluar }, bearer)
      ]);
      if (mine !== sequence) return;
      quotePanel.setAttribute("aria-busy", "false");

      if (!chosen) {
        quoteStatus.hidden = true;
        fullEl.hidden = false;
        return;
      }
      if (chosen.timezone) {
        zoneHint.textContent = `Zona waktu properti: ${labelZonaWaktu(chosen.timezone)}. Tanggal keluar adalah hari Anda pergi dan tidak dihitung sebagai malam.`;
      }

      quoteStatus.hidden = true;
      quoteList.hidden = false;
      text("[data-quote-name]").textContent = quote.product.name;
      text("[data-quote-stay]").textContent =
        quote.nights === null
          ? "-"
          : `${quote.nights} malam: ${formatTanggalPendek(masuk)} sampai ${formatTanggalPendek(keluar)}`;
      text("[data-quote-unit]").textContent = formatPrice(quote.unitPrice);
      text("[data-quote-total]").textContent = formatPrice(quote.total);
      const depositRow = text("[data-quote-deposit-row]");
      const balanceRow = text("[data-quote-balance-row]");
      depositRow.hidden = !quote.deposit.available;
      balanceRow.hidden = !quote.deposit.available;
      quoteNote.hidden = !quote.deposit.available;
      if (quote.deposit.available) {
        text("[data-quote-deposit]").textContent = formatPrice(quote.deposit.amount);
        text("[data-quote-balance]").textContent = formatPrice(quote.deposit.balanceDue);
      }
      if (!quote.canCheckout) {
        quoteStatus.hidden = false;
        quoteStatus.textContent = "Layanan ini belum dapat dipesan. Coba lagi nanti.";
        return;
      }
      ready = { offeringId: offering.offeringId, resourceId: chosen.resourceId, masuk, keluar, tamu: guests };
      continueButton.disabled = false;
    } catch (error) {
      if (mine !== sequence) return;
      quotePanel.setAttribute("aria-busy", "false");
      resetPanel("Pilih tanggal masuk dan tanggal keluar.");
      if (error instanceof TokoApiError && error.code === "VALIDATION_ERROR") {
        for (const entry of error.fieldErrors) {
          if (entry.field === "checkInDate" || entry.field === "checkOutDate") {
            setFieldError(entry.field, entry.message);
          }
        }
        if (error.fieldErrors.length > 0) return;
      }
      showError(error, () => void refresh());
    }
  }

  /** The first resource with a free unit for the range, probed in order; `null` when none is free. */
  async function pickResource(
    offering: TawaranBooking,
    masuk: string,
    keluar: string
  ): Promise<{ resourceId: string; timezone: string } | null> {
    for (const resourceId of offering.resourceIds) {
      const answer = await ambilKetersediaanBooking({
        offeringId: offering.offeringId,
        resourceId,
        checkInDate: masuk,
        checkOutDate: keluar
      });
      if (answer.available) return { resourceId, timezone: answer.timezone };
    }
    return null;
  }

  function schedule(): void {
    window.clearTimeout(timer);
    // The old figures are removed at once; the request follows a short pause.
    sequence += 1;
    resetPanel("Pilih tanggal masuk dan tanggal keluar.");
    timer = window.setTimeout(() => void refresh(), 250);
  }

  function applyOffering(): void {
    const offering = currentOffering();
    if (!offering) return;
    party.min = String(offering.minParty);
    party.max = String(offering.maxParty);
    const current = Number.parseInt(party.value, 10);
    if (!Number.isInteger(current) || current < offering.minParty) party.value = String(offering.minParty);
    if (current > offering.maxParty) party.value = String(offering.maxParty);
  }

  async function start(): Promise<void> {
    clearError();
    unavailableEl.hidden = true;
    form.hidden = false;
    offeringsLoading.hidden = false;
    offeringsEmpty.hidden = true;
    offeringField.hidden = true;
    offeringsRegion.setAttribute("aria-busy", "true");
    try {
      const { items } = await ambilTawaranBooking(bacaSesi()?.token);
      offerings = items.filter((entry) => entry.granularity === "stay" && entry.quantityBasis === "nights");
    } catch (error) {
      offeringsRegion.setAttribute("aria-busy", "false");
      offeringsLoading.hidden = true;
      if (error instanceof TokoApiError && error.status === 404) {
        form.hidden = true;
        unavailableEl.hidden = false;
        return;
      }
      showError(error, () => void start());
      return;
    }
    offeringsRegion.setAttribute("aria-busy", "false");
    offeringsLoading.hidden = true;
    if (offerings.length === 0) {
      offeringsEmpty.hidden = false;
      continueButton.disabled = true;
      return;
    }

    offeringSelect.innerHTML = "";
    for (const offering of offerings) {
      const option = document.createElement("option");
      option.value = offering.offeringId;
      option.textContent = `${offering.name} - ${formatPrice(offering.unitPrice)} per malam`;
      offeringSelect.appendChild(option);
    }
    offeringField.hidden = false;

    const hariIni = tanggalLokal(new Date());
    checkIn.min = hariIni;
    checkOut.min = hariIni;

    const prefill = parseParamCari(window.location.search);
    if (prefill.offeringId && offerings.some((entry) => entry.offeringId === prefill.offeringId)) {
      offeringSelect.value = prefill.offeringId;
    }
    if (prefill.masuk) checkIn.value = prefill.masuk;
    if (prefill.keluar) checkOut.value = prefill.keluar;
    if (prefill.tamu) party.value = String(prefill.tamu);
    applyOffering();
    void refresh();
  }

  offeringSelect.addEventListener("change", () => {
    applyOffering();
    schedule();
  });
  for (const input of [checkIn, checkOut, party]) {
    input.addEventListener("input", schedule);
    input.addEventListener("change", schedule);
  }
  checkIn.addEventListener("change", () => {
    // A check-out on or before the new check-in is left for the shopper to fix; the minimum only guides the picker.
    if (checkIn.value) checkOut.min = checkIn.value;
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!ready) return;
    const target = buatPathPesan({
      offeringId: ready.offeringId,
      resourceId: ready.resourceId,
      masuk: ready.masuk,
      keluar: ready.keluar,
      tamu: ready.tamu
    });
    window.location.assign(bacaSesi() ? target : `${loginHref}?kembali=${encodeURIComponent(target)}`);
  });

  void start();
}
