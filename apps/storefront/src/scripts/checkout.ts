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
  createOrder,
  quoteCart,
  TokoApiError,
  type CartLineRequest,
  type CartQuote,
  type CreateOrderRequest,
  type ShippingSelection
} from "../lib/toko-klien";
import { formatPrice } from "../lib/harga";
import { previewIndonesianPhone } from "../lib/telepon";
import { buildWhatsappCartMessage, buildWhatsappUrl } from "../lib/wa-fallback";
import { PESANAN_PHONE_KEY } from "../lib/pesanan-sesi";

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

    // --- address: region selects ---------------------------------------------

    const provinceSelect = formEl.querySelector<HTMLSelectElement>("[data-province-select]");
    const citySelect = formEl.querySelector<HTMLSelectElement>("[data-city-select]");
    const districtSelect = formEl.querySelector<HTMLSelectElement>("[data-district-select]");

    async function fetchJson<T>(path: string): Promise<T> {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
      return (await response.json()) as T;
    }

    function fillOptions(select: HTMLSelectElement, items: { code: string; name: string }[], placeholder: string): void {
      select.innerHTML = "";
      const placeholderOption = document.createElement("option");
      placeholderOption.value = "";
      placeholderOption.textContent = placeholder;
      select.appendChild(placeholderOption);

      for (const item of items) {
        const option = document.createElement("option");
        option.value = item.code;
        option.textContent = item.name;
        select.appendChild(option);
      }
    }

    if (provinceSelect) {
      fetchJson<{ code: string; name: string }[]>("/index/wilayah-provinsi.json")
        .then((provinces) => fillOptions(provinceSelect, provinces, "Pilih provinsi"))
        .catch(() => {
          // Degrades to an empty select — the shopper can still type a
          // street address; a missing region index must not block checkout.
        });

      provinceSelect.addEventListener("change", () => {
        if (citySelect) {
          citySelect.disabled = !provinceSelect.value;
          fillOptions(citySelect, [], "Pilih kabupaten/kota");
        }
        if (districtSelect) {
          districtSelect.disabled = true;
          fillOptions(districtSelect, [], "Pilih kabupaten/kota dahulu");
        }

        if (provinceSelect.value && citySelect) {
          fetchJson<{ code: string; name: string }[]>(`/index/wilayah-kabupaten-${provinceSelect.value}.json`)
            .then((regencies) => fillOptions(citySelect, regencies, "Pilih kabupaten/kota"))
            .catch(() => {});
        }
      });
    }

    if (citySelect) {
      citySelect.addEventListener("change", () => {
        if (districtSelect) {
          districtSelect.disabled = !citySelect.value;
          fillOptions(districtSelect, [], "Pilih kecamatan");
        }

        if (citySelect.value && districtSelect) {
          fetchJson<{ code: string; name: string }[]>(`/index/wilayah-kecamatan-${citySelect.value}.json`)
            .then((districts) => fillOptions(districtSelect, districts, "Pilih kecamatan"))
            .catch(() => {});
        }
      });
    }

    // --- shipping / insurance -------------------------------------------------

    const shippingOptionsEl = formEl.querySelector<HTMLElement>("[data-shipping-options]");
    const insuranceField = formEl.querySelector<HTMLElement>("[data-insurance-field]");
    const insuranceCheckbox = formEl.querySelector<HTMLInputElement>("[data-insurance-checkbox]");
    const insuranceFeeEl = formEl.querySelector<HTMLElement>("[data-insurance-fee]");

    function renderShippingOptions(quote: CartQuote): void {
      if (!shippingOptionsEl) return;
      shippingOptionsEl.innerHTML = "";

      quote.shippingOptions.forEach((option, index) => {
        const id = `shipping-option-${index}`;
        const label = document.createElement("label");
        label.className = "toko-field";

        const input = document.createElement("input");
        input.type = "radio";
        input.name = "shippingOption";
        input.id = id;
        input.disabled = !option.available;
        input.value = JSON.stringify({ method: option.method, serviceId: option.serviceId });

        const isSelected =
          selectedShipping !== null &&
          selectedShipping.method === option.method &&
          (selectedShipping.method !== "alternative" || selectedShipping.serviceId === option.serviceId);
        input.checked = isSelected;

        input.addEventListener("change", () => {
          selectedShipping = JSON.parse(input.value) as ShippingSelection;
          void refreshQuote();
        });

        const costText = option.available ? (option.cost ? formatPrice(option.cost) : "Gratis") : "Segera hadir";
        label.append(input, document.createTextNode(` ${option.name} — ${costText}`));
        shippingOptionsEl.appendChild(label);
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
      dp: "Bayar DP"
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

      try {
        const quote = await quoteCart({
          lines: toLineRequests(currentCart),
          shipping: selectedShipping,
          voucherCode: voucherInput?.value.trim() || null,
          insurance: insuranceSelected
        });

        latestQuote = quote;
        renderShippingOptions(quote);
        renderPaymentOptions(quote);
        hideSubmitError();
      } catch (error) {
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
        notes: notes || null
      };

      submitting = true;
      const submitButton = formEl.querySelector<HTMLButtonElement>("[data-submit-order]");
      if (submitButton) submitButton.disabled = true;

      try {
        const order = await createOrder(request);
        clearCart();
        try {
          window.sessionStorage.setItem(PESANAN_PHONE_KEY, request.customer.phone);
        } catch {
          // A blocked sessionStorage means `/pesanan` will ask for the
          // phone again — not ideal, but not a lost order either.
        }
        window.location.href = `/pesanan?kode=${encodeURIComponent(order.orderCode)}`;
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
