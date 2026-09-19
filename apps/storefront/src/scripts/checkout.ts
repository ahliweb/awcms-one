/**
 * `/checkout` interactivity (issue #30) — the whole ADR-0007-revised flow:
 * read the cart, re-quote it live with the shopper's shipping/insurance/
 * voucher choices, collect contact+address, submit `POST …/orders`, and on
 * success hand off to `/pesanan`. See `checkout.astro`'s own docblock for
 * the step/field-error wiring this script assumes.
 */
import { loadCart, clearCart } from "../lib/keranjang-klien";
import type { Cart } from "../lib/keranjang-kontrak";
import {
  createGatewaySession,
  createOrder,
  quoteCart,
  TokoApiError,
  type CartLineRequest,
  type CartQuote,
  type CreateOrderRequest,
  type ShippingSelection
} from "../lib/toko-klien";
import { isValidGatewayRedirectUrl } from "../lib/gateway-redirect";
import { formatPrice } from "../lib/harga";
import { describeShippingOption, isShippingOptionSelected } from "../lib/kurir-opsi";
import { previewIndonesianPhone } from "../lib/telepon";
import { buildWhatsappCartMessage, buildWhatsappUrl } from "../lib/wa-fallback";
import { PESANAN_PHONE_KEY } from "../lib/pesanan-sesi";
import { bacaSesi } from "../lib/akun-sesi";
import { ambilAlamat, type Alamat } from "../lib/akun-klien";
import { bacaKodeAfiliasi } from "../lib/afiliasi-kontrak";
import { applyRegionSelection, wireCascadingRegionSelects } from "../lib/wilayah-region-select";

const STEP_ORDER = ["contact", "address", "shipping", "payment", "review"] as const;
type Step = (typeof STEP_ORDER)[number];

const root = document.querySelector<HTMLElement>("[data-checkout-root]");
if (root) {
  const form = root.querySelector<HTMLFormElement>("[data-checkout-form]");
  const emptyEl = root.querySelector<HTMLElement>("[data-checkout-empty]");
  const submitErrorEl = root.querySelector<HTMLElement>("[data-submit-error]");
  const submitErrorMessageEl = root.querySelector<HTMLElement>("[data-submit-error-message]");
  const waFallbackLink = root.querySelector<HTMLAnchorElement>("[data-wa-fallback-link]");

  const whatsappNumber = root.dataset.whatsappNumber ?? "";
  const storeName = root.dataset.storeName ?? "toko";
  const pinpointEnabled = root.dataset.pinpointEnabled === "true";

  const cart = loadCart();

  if (cart.lines.length === 0) {
    if (emptyEl) emptyEl.hidden = false;
    if (form) form.hidden = true;
  } else if (form) {
    runCheckout(form, cart);
  }

  function toLineRequests(c: Cart): CartLineRequest[] {
    return c.lines.map((line) => ({
      productId: line.productId,
      variantId: line.variantId,
      quantity: line.quantity,
      serviceFormValues: line.serviceFormValues
    }));
  }

  function runCheckout(formEl: HTMLFormElement, currentCart: Cart): void {
    let selectedShipping: ShippingSelection = null;
    let selectedPaymentMethod: CreateOrderRequest["payment"]["method"] | null = null;
    let insuranceSelected = false;
    let latestQuote: CartQuote | null = null;
    let submitting = false;

    const pinpointFields = formEl.querySelector<HTMLElement>("[data-pinpoint-fields]");
    if (pinpointFields) pinpointFields.hidden = !pinpointEnabled;

    // --- step navigation ----------------------------------------------------

    function showStep(step: Step): void {
      for (const section of formEl.querySelectorAll<HTMLElement>("[data-step]")) {
        section.hidden = section.dataset.step !== step;
      }
      const heading = formEl.querySelector<HTMLElement>(`[data-step="${step}"] h2`);
      if (heading) {
        // A heading is not natively focusable — moving keyboard/AT focus to
        // the step a shopper just entered (or was routed back to after a
        // field error) needs `tabindex="-1"` first.
        heading.setAttribute("tabindex", "-1");
        heading.focus();
      }
    }

    function clearFieldErrors(): void {
      for (const el of formEl.querySelectorAll<HTMLElement>("[data-error-for]")) {
        el.textContent = "";
      }
    }

    for (const button of formEl.querySelectorAll<HTMLButtonElement>("[data-step-next]")) {
      button.addEventListener("click", async () => {
        const from = button.dataset.stepNext as Step;
        const section = formEl.querySelector<HTMLElement>(`[data-step="${from}"]`);

        if (section) {
          for (const input of section.querySelectorAll<HTMLInputElement>("[required]")) {
            if (!input.checkValidity()) {
              input.reportValidity();
              return;
            }
          }
        }

        const nextIndex = STEP_ORDER.indexOf(from) + 1;
        const next = STEP_ORDER[nextIndex];
        if (!next) return;

        if (next === "shipping" || next === "review") {
          await refreshQuote();
        }
        if (next === "review") {
          renderReview();
        }

        showStep(next);
      });
    }

    for (const button of formEl.querySelectorAll<HTMLButtonElement>("[data-step-prev]")) {
      button.addEventListener("click", () => {
        const from = button.dataset.stepPrev as Step;
        const prevIndex = STEP_ORDER.indexOf(from) - 1;
        const prev = STEP_ORDER[prevIndex];
        if (prev) showStep(prev);
      });
    }

    // --- contact: phone preview ----------------------------------------------

    const phoneInput = formEl.querySelector<HTMLInputElement>('[name="customer.phone"]');
    const phonePreview = formEl.querySelector<HTMLElement>("[data-phone-preview]");
    phoneInput?.addEventListener("input", () => {
      if (!phonePreview) return;
      const preview = previewIndonesianPhone(phoneInput.value);
      phonePreview.textContent = preview ? `Akan dikirim sebagai: ${preview}` : "";
    });

    // --- address: region selects (shared with /akun/alamat, see wilayah-region-select.ts) --

    const provinceSelect = formEl.querySelector<HTMLSelectElement>("[data-province-select]");
    const citySelect = formEl.querySelector<HTMLSelectElement>("[data-city-select]");
    const districtSelect = formEl.querySelector<HTMLSelectElement>("[data-district-select]");

    if (provinceSelect && citySelect && districtSelect) {
      wireCascadingRegionSelects({ province: provinceSelect, city: citySelect, district: districtSelect });
    }

    // --- shipping destination (issue #109, contract: #106 D4) -----------------
    //
    // As soon as the district `<select>` carries a value, every quote from
    // here on sends it as `destination` — the CMS (and this repo's own stub)
    // then prices real courier services for it instead of the single
    // disabled placeholder. A district CHANGE (a shopper picking a different
    // kecamatan, or clearing it by re-picking a province/city) re-quotes
    // immediately so the shipping step's rates never silently go stale.

    function currentDestination(): { districtCode: string } | null {
      const code = districtSelect?.value.trim();
      return code ? { districtCode: code } : null;
    }

    districtSelect?.addEventListener("change", () => {
      void refreshQuote();
    });

    // --- address: saved-address autofill (issue #90) — only offered once a
    // customer session is confirmed, per this issue's own "hidden by default
    // until session is confirmed" rule. A network failure here degrades to
    // simply not offering the select — a shopper can still fill the form
    // manually, the same posture every other fetch on this page takes.

    const alamatWrap = formEl.querySelector<HTMLElement>("[data-alamat-tersimpan-wrap]");
    const alamatSelect = formEl.querySelector<HTMLSelectElement>("[data-alamat-tersimpan]");
    const recipientInput = formEl.querySelector<HTMLInputElement>('[name="address.recipientName"]');
    const addressPhoneInput = formEl.querySelector<HTMLInputElement>('[name="address.phone"]');
    const postalInput = formEl.querySelector<HTMLInputElement>('[name="address.postalCode"]');
    const streetInput = formEl.querySelector<HTMLTextAreaElement>('[name="address.street"]');
    const addressNotesInput = formEl.querySelector<HTMLInputElement>('[name="address.notes"]');

    const sesi = bacaSesi();
    let alamatTersimpan: Alamat[] = [];

    if (sesi && alamatWrap && alamatSelect && provinceSelect && citySelect && districtSelect) {
      ambilAlamat()
        .then(({ items }) => {
          alamatTersimpan = items;
          if (items.length === 0) return;

          for (const alamat of items) {
            const option = document.createElement("option");
            option.value = alamat.id;
            option.textContent = `${alamat.label} — ${alamat.recipientName}${alamat.isDefault ? " (Utama)" : ""}`;
            alamatSelect.appendChild(option);
          }
          alamatWrap.hidden = false;
        })
        .catch(() => {
          // No saved addresses reachable — the manual form stays the only path.
        });

      alamatSelect.addEventListener("change", () => {
        const alamat = alamatTersimpan.find((item) => item.id === alamatSelect.value);
        if (!alamat) return;

        if (recipientInput) recipientInput.value = alamat.recipientName;
        if (addressPhoneInput) addressPhoneInput.value = alamat.phone;
        if (postalInput) postalInput.value = alamat.postalCode;
        if (streetInput) streetInput.value = alamat.street;
        if (addressNotesInput) addressNotesInput.value = alamat.notes ?? "";

        // `applyRegionSelection` sets `districtSelect.value` PROGRAMMATICALLY
        // — it never fires the select's own `change` event — so the district
        // listener above would otherwise never see this autofill. Re-quoting
        // here explicitly keeps "the district select has a value → send
        // destination" true regardless of how that value got there.
        void applyRegionSelection(
          { province: provinceSelect, city: citySelect, district: districtSelect },
          { provinceCode: alamat.provinceCode, cityCode: alamat.cityCode, districtCode: alamat.districtCode }
        ).then(() => refreshQuote());
      });
    }

    // --- shipping / insurance -------------------------------------------------

    const shippingOptionsEl = formEl.querySelector<HTMLElement>("[data-shipping-options]");
    const shippingStatusEl = formEl.querySelector<HTMLElement>("[data-shipping-status]");
    const insuranceField = formEl.querySelector<HTMLElement>("[data-insurance-field]");
    const insuranceCheckbox = formEl.querySelector<HTMLInputElement>("[data-insurance-checkbox]");
    const insuranceFeeEl = formEl.querySelector<HTMLElement>("[data-insurance-fee]");

    function renderShippingOptions(quote: CartQuote): void {
      if (!shippingOptionsEl) return;
      shippingOptionsEl.innerHTML = "";

      quote.shippingOptions.forEach((option, index) => {
        const view = describeShippingOption(option);
        const id = `shipping-option-${index}`;
        const noteId = `${id}-note`;

        const label = document.createElement("label");
        label.className = "toko-field toko-shipping-option";

        const input = document.createElement("input");
        input.type = "radio";
        input.name = "shippingOption";
        input.id = id;
        input.disabled = view.disabled;
        input.value = view.key;
        if (view.noteText) input.setAttribute("aria-describedby", noteId);

        input.checked = isShippingOptionSelected(selectedShipping, option);

        input.addEventListener("change", () => {
          selectedShipping = JSON.parse(input.value) as ShippingSelection;
          void refreshQuote();
        });

        const text = document.createElement("span");
        text.className = "toko-shipping-option-text";
        const nameText = view.etdText ? `${view.name} (${view.etdText})` : view.name;
        text.textContent = `${nameText} — ${view.priceText}`;

        label.append(input, text);
        shippingOptionsEl.appendChild(label);

        // The disabled placeholder's own reason (courier not enabled, no
        // destination chosen yet, or the provider could not price this
        // destination) stays visible next to the row, not just hidden inside
        // `aria-describedby` — a11y and a sighted shopper both see it.
        if (view.noteText) {
          const note = document.createElement("p");
          note.id = noteId;
          note.className = "toko-field-hint";
          note.textContent = view.noteText;
          shippingOptionsEl.appendChild(note);
        }
      });

      if (insuranceField) insuranceField.hidden = !quote.insurance.available;
      if (insuranceFeeEl) insuranceFeeEl.textContent = formatPrice(quote.insurance.fee);
      if (insuranceCheckbox) {
        insuranceCheckbox.checked = quote.insurance.required || insuranceSelected;
        insuranceCheckbox.disabled = quote.insurance.required;
      }
    }

    insuranceCheckbox?.addEventListener("change", () => {
      insuranceSelected = insuranceCheckbox.checked;
      void refreshQuote();
    });

    // --- payment ---------------------------------------------------------------

    const paymentOptionsEl = formEl.querySelector<HTMLElement>("[data-payment-options]");

    const PAYMENT_LABELS: Record<string, string> = {
      manual_qris: "QRIS",
      manual_bank: "Transfer Bank",
      dp: "Bayar DP",
      // Issue #112 (contract: #106 D3) — listed only when the quote's own
      // `paymentMethods[]` includes `gateway` at all (this loop below never
      // renders a method the quote did not list), so this label never
      // appears on a tenant whose gateway is off.
      gateway: "Bayar online (kartu, VA, e-wallet)"
    };

    function renderPaymentOptions(quote: CartQuote): void {
      if (!paymentOptionsEl) return;
      paymentOptionsEl.innerHTML = "";

      // A method that was SELECTED but is no longer available/listed after
      // a re-quote (voucher/shipping change) must not silently stay
      // "chosen" — the submit-time check re-validates this regardless, but
      // clearing it here keeps the visible radio state honest too.
      if (selectedPaymentMethod && !quote.paymentMethods.some((m) => m.method === selectedPaymentMethod && m.available)) {
        selectedPaymentMethod = null;
      }

      for (const method of quote.paymentMethods) {
        const label = document.createElement("label");
        label.className = "toko-field";

        const input = document.createElement("input");
        input.type = "radio";
        input.name = "paymentMethod";
        input.value = method.method;
        input.disabled = !method.available;
        // Re-quoting (e.g. entering the review step) rebuilds this list from
        // scratch — without restoring the PREVIOUSLY chosen method here, a
        // shopper's payment choice would silently vanish on every refresh,
        // the same bug this file's own `selectedShipping` state already
        // avoids for the shipping radios above.
        input.checked = method.method === selectedPaymentMethod;

        input.addEventListener("change", () => {
          selectedPaymentMethod = method.method;
        });

        label.append(input, document.createTextNode(` ${PAYMENT_LABELS[method.method] ?? method.method}`));
        paymentOptionsEl.appendChild(label);
      }
    }

    // --- quoting -----------------------------------------------------------

    async function refreshQuote(): Promise<void> {
      const voucherInput = formEl.querySelector<HTMLInputElement>('[name="voucherCode"]');

      if (shippingStatusEl) shippingStatusEl.textContent = "Menghitung ongkir…";

      try {
        const quote = await quoteCart({
          lines: toLineRequests(currentCart),
          shipping: selectedShipping,
          voucherCode: voucherInput?.value.trim() || null,
          insurance: insuranceSelected,
          destination: currentDestination()
        });

        latestQuote = quote;
        renderShippingOptions(quote);
        renderPaymentOptions(quote);
        hideSubmitError();
        if (shippingStatusEl) shippingStatusEl.textContent = "";
      } catch (error) {
        if (shippingStatusEl) shippingStatusEl.textContent = "Gagal menghitung ongkir. Silakan coba lagi.";
        showSubmitError(error);
      }
    }

    // --- review --------------------------------------------------------------

    const reviewSummaryEl = formEl.querySelector<HTMLElement>("[data-review-summary]");

    function renderReview(): void {
      if (!reviewSummaryEl) return;
      reviewSummaryEl.innerHTML = "";

      if (!latestQuote) {
        reviewSummaryEl.textContent = "Tidak dapat memuat ringkasan pesanan.";
        return;
      }

      const rows: [string, string][] = [
        ["Subtotal", formatPrice(latestQuote.subtotal)],
        ["Diskon", `-${formatPrice(latestQuote.discount)}`],
        ["Ongkos kirim", latestQuote.shipping ? formatPrice(latestQuote.shipping.cost) : "-"],
        ["Asuransi", formatPrice(latestQuote.insurance.fee)],
        ["Total", formatPrice(latestQuote.total)]
      ];

      for (const [label, value] of rows) {
        const row = document.createElement("div");
        row.className = "toko-summary-row";
        const labelSpan = document.createElement("span");
        labelSpan.textContent = label;
        const valueSpan = document.createElement("span");
        valueSpan.textContent = value;
        row.append(labelSpan, valueSpan);
        reviewSummaryEl.appendChild(row);
      }

      if (!latestQuote.canCheckout) {
        const warning = document.createElement("p");
        warning.className = "toko-field-error";
        warning.textContent =
          "Salah satu item di keranjang bermasalah (stok/harga berubah). Silakan kembali ke keranjang.";
        reviewSummaryEl.appendChild(warning);
      }
    }

    // --- error handling --------------------------------------------------------

    function hideSubmitError(): void {
      if (submitErrorEl) submitErrorEl.hidden = true;
      if (waFallbackLink) waFallbackLink.hidden = true;
    }

    function fieldStepOf(field: string): Step | null {
      if (field.startsWith("customer.")) return "contact";
      if (field.startsWith("address.")) return "address";
      if (field === "shipping") return "shipping";
      if (field.startsWith("payment.")) return "payment";
      return null;
    }

    function showSubmitError(error: unknown): void {
      clearFieldErrors();

      if (error instanceof TokoApiError) {
        if (error.code === "VALIDATION_ERROR" && error.fieldErrors.length > 0) {
          let firstStep: Step | null = null;
          let firstInput: HTMLElement | null = null;

          for (const fieldError of error.fieldErrors) {
            const target = formEl.querySelector<HTMLElement>(`[data-error-for="${fieldError.field}"]`);
            if (target) {
              target.textContent = fieldError.message;
              firstStep ??= fieldStepOf(fieldError.field);
              firstInput ??= formEl.querySelector<HTMLElement>(`[name="${fieldError.field}"]`);
            }
          }

          if (firstStep) showStep(firstStep);
          firstInput?.focus();

          if (submitErrorEl && submitErrorMessageEl) {
            submitErrorEl.hidden = false;
            submitErrorMessageEl.textContent = "Beberapa data belum lengkap atau tidak valid — lihat di bawah tiap kolom.";
          }
          return;
        }

        if (error.code === "CART_CHANGED") {
          const fresh = error.freshQuote;
          if (fresh) {
            latestQuote = fresh;
            renderShippingOptions(fresh);
            renderPaymentOptions(fresh);
          }
          if (submitErrorEl && submitErrorMessageEl) {
            submitErrorEl.hidden = false;
            submitErrorMessageEl.textContent =
              "Keranjang berubah (harga atau stok) sejak terakhir Anda lihat — opsi telah diperbarui, silakan periksa kembali.";
          }
          showStep("shipping");
          return;
        }

        if (error.code === "RATE_LIMITED") {
          const seconds = error.retryAfterSeconds;
          if (submitErrorEl && submitErrorMessageEl) {
            submitErrorEl.hidden = false;
            submitErrorMessageEl.textContent = seconds
              ? `Terlalu banyak percobaan. Coba lagi dalam ${seconds} detik.`
              : "Terlalu banyak percobaan. Coba lagi sebentar lagi.";
          }
          return;
        }
      }

      if (submitErrorEl && submitErrorMessageEl) {
        submitErrorEl.hidden = false;
        submitErrorMessageEl.textContent =
          error instanceof Error ? error.message : "Terjadi kesalahan yang tidak terduga.";
      }

      if (waFallbackLink && whatsappNumber) {
        const message = buildWhatsappCartMessage(currentCart, storeName);
        waFallbackLink.href = buildWhatsappUrl(whatsappNumber, message);
        waFallbackLink.hidden = false;
      }
    }

    // --- submit ------------------------------------------------------------

    formEl.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (submitting) return;

      if (!selectedShipping) {
        const error = formEl.querySelector<HTMLElement>('[data-error-for="shipping"]');
        if (error) error.textContent = "Pilih metode pengiriman terlebih dahulu.";
        showStep("shipping");
        return;
      }

      if (!selectedPaymentMethod) {
        const error = formEl.querySelector<HTMLElement>('[data-error-for="payment.method"]');
        if (error) error.textContent = "Pilih metode pembayaran terlebih dahulu.";
        showStep("payment");
        return;
      }

      const data = new FormData(formEl);
      const email = String(data.get("customer.email") ?? "").trim();
      const notes = String(data.get("notes") ?? "").trim();
      const voucherCode = String(data.get("voucherCode") ?? "").trim();

      const request: CreateOrderRequest = {
        idempotencyKey: currentCart.id,
        customer: {
          name: String(data.get("customer.name") ?? "").trim(),
          phone: String(data.get("customer.phone") ?? "").trim(),
          email: email || null
        },
        address:
          selectedShipping.method === "self_pickup"
            ? null
            : {
                recipientName: String(data.get("address.recipientName") ?? "").trim(),
                phone: String(data.get("address.phone") ?? "").trim(),
                provinceCode: String(data.get("address.provinceCode") ?? ""),
                provinceName: provinceSelect?.selectedOptions[0]?.textContent ?? "",
                cityCode: String(data.get("address.cityCode") ?? ""),
                cityName: citySelect?.selectedOptions[0]?.textContent ?? "",
                districtCode: String(data.get("address.districtCode") ?? ""),
                districtName: districtSelect?.selectedOptions[0]?.textContent ?? "",
                postalCode: String(data.get("address.postalCode") ?? ""),
                street: String(data.get("address.street") ?? ""),
                latitude: data.get("address.latitude") ? Number(data.get("address.latitude")) : null,
                longitude: data.get("address.longitude") ? Number(data.get("address.longitude")) : null,
                notes: String(data.get("address.notes") ?? "").trim() || null
              },
        lines: toLineRequests(currentCart),
        shipping: selectedShipping,
        payment: { method: selectedPaymentMethod },
        voucherCode: voucherCode || null,
        insurance: insuranceSelected,
        notes: notes || null,
        // Issue #93: re-read at submit time, same as `bacaSesi()` above —
        // an expired (>30-day) capture must not attribute a sale, and
        // `bacaKodeAfiliasi` already drops one that has aged out. The CMS
        // ignores an unknown/suspended code (#86's D5), so this never
        // blocks checkout regardless of what it resolves to.
        affiliateCode: bacaKodeAfiliasi()?.code ?? null
      };

      submitting = true;
      const submitButton = formEl.querySelector<HTMLButtonElement>("[data-submit-order]");
      if (submitButton) submitButton.disabled = true;

      try {
        // Re-read at submit time: `bacaSesi()` drops an expired session, so a
        // shopper whose 30-day token lapsed mid-checkout places a guest order
        // instead of sending a stale Bearer the CMS would reject.
        const bearerToken = bacaSesi()?.token;
        const order = await createOrder(request, bearerToken);
        clearCart();
        try {
          window.sessionStorage.setItem(PESANAN_PHONE_KEY, request.customer.phone);
        } catch {
          // A blocked sessionStorage means `/pesanan` will ask for the
          // phone again — not ideal, but not a lost order either.
        }

        const trackingUrl = `/pesanan?kode=${encodeURIComponent(order.orderCode)}`;

        // Issue #112 (contract: #106 D3) — the order itself is placed
        // exactly as before regardless of payment method; a `gateway` order
        // additionally needs its OWN session, created right after, whose
        // `redirectUrl` this whole tab navigates to. Any failure here — the
        // session call itself, or an invalid `redirectUrl` — still falls
        // through to `/pesanan`, which offers "Bayar sekarang" to retry: the
        // order was already placed successfully, so this is never treated
        // as a checkout failure.
        if (request.payment.method === "gateway") {
          try {
            const session = await createGatewaySession(order.orderCode, request.customer.phone, bearerToken);
            if (!isValidGatewayRedirectUrl(session.redirectUrl)) {
              throw new Error(`Gateway returned an unusable redirectUrl: ${session.redirectUrl}`);
            }
            window.location.assign(session.redirectUrl);
            return;
          } catch {
            window.location.href = trackingUrl;
            return;
          }
        }

        window.location.href = trackingUrl;
      } catch (error) {
        showSubmitError(error);
      } finally {
        submitting = false;
        if (submitButton) submitButton.disabled = false;
      }
    });

    // Kick off the first quote right away so line issues surface before the
    // shopper reaches the shipping step.
    void refreshQuote();
  }
}
