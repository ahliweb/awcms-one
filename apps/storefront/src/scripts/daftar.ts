/**
 * `/daftar` interactivity (issue #88, S1) — name + phone + e-mail →
 * "Kirim kode" → 6-digit code → verify → `simpanSesi` → redirect to `/akun`.
 * Mirrors `src/scripts/masuk.ts` closely; kept as its own file (rather than
 * a shared "two-step OTP form" abstraction) because the two forms collect
 * different fields and branch on different error codes — the duplication is
 * smaller than the abstraction would be.
 */
import { mintaKode, verifikasiKode } from "../lib/akun-klien";
import { simpanSesi } from "../lib/akun-sesi";
import { TokoApiError } from "../lib/toko-permintaan";
import { ROUTES } from "../config/routes";
import { buildWhatsappAccountMessage, buildWhatsappUrl } from "../lib/wa-fallback";

const RESEND_SECONDS = 60;

const root = document.querySelector<HTMLElement>("[data-daftar-root]");
if (root) {
  const form = root.querySelector<HTMLFormElement>("[data-daftar-form]");
  const statusEl = root.querySelector<HTMLElement>("[data-status]");
  const submitErrorEl = root.querySelector<HTMLElement>("[data-submit-error]");
  const submitErrorMessageEl = root.querySelector<HTMLElement>("[data-submit-error-message]");
  const submitErrorLinkEl = root.querySelector<HTMLElement>("[data-submit-error-link]");
  const waFallbackLink = root.querySelector<HTMLAnchorElement>("[data-wa-fallback-link]");
  const nameInput = form?.querySelector<HTMLInputElement>('[name="name"]');
  const phoneInput = form?.querySelector<HTMLInputElement>('[name="phone"]');
  const emailInput = form?.querySelector<HTMLInputElement>('[name="email"]');
  const codeInput = form?.querySelector<HTMLInputElement>('[name="code"]');
  const kirimKodeButton = form?.querySelector<HTMLButtonElement>("[data-kirim-kode]");
  const kirimUlangButton = form?.querySelector<HTMLButtonElement>("[data-kirim-ulang]");
  const countdownEl = form?.querySelector<HTMLElement>("[data-countdown]");

  const whatsappNumber = root.dataset.whatsappNumber ?? "";
  const storeName = root.dataset.storeName ?? "toko";
  const loginHref = root.dataset.loginHref ?? ROUTES.login;

  // `/masuk`'s own `ACCOUNT_NOT_FOUND` message links here with `?email=` —
  // pre-fill it so a shopper who was just told "you have no account" does
  // not have to retype the e-mail they already gave.
  const params = new URLSearchParams(window.location.search);
  const prefillEmail = params.get("email");
  if (prefillEmail && emailInput) emailInput.value = prefillEmail;

  let resendTimer: ReturnType<typeof setInterval> | undefined;

  function clearFieldErrors(): void {
    form?.querySelectorAll<HTMLElement>("[data-error-for]").forEach((el) => (el.textContent = ""));
  }

  function hideSubmitError(): void {
    if (submitErrorEl) submitErrorEl.hidden = true;
    if (submitErrorLinkEl) submitErrorLinkEl.innerHTML = "";
    if (waFallbackLink) waFallbackLink.hidden = true;
  }

  function showStatus(message: string): void {
    if (!statusEl) return;
    statusEl.hidden = false;
    statusEl.textContent = message;
  }

  function showWaFallback(context: string): void {
    if (!waFallbackLink || !whatsappNumber) return;
    waFallbackLink.href = buildWhatsappUrl(whatsappNumber, buildWhatsappAccountMessage(storeName, context));
    waFallbackLink.hidden = false;
  }

  function showSubmitError(error: unknown, context: string): void {
    clearFieldErrors();

    if (error instanceof TokoApiError) {
      if (error.code === "VALIDATION_ERROR" && error.fieldErrors.length > 0) {
        for (const fieldError of error.fieldErrors) {
          const target = form?.querySelector<HTMLElement>(`[data-error-for="${fieldError.field}"]`);
          if (target) target.textContent = fieldError.message;
        }
        return;
      }

      if (error.code === "PHONE_ALREADY_REGISTERED") {
        if (submitErrorEl && submitErrorMessageEl && submitErrorLinkEl) {
          submitErrorEl.hidden = false;
          submitErrorMessageEl.textContent = "Nomor telepon ini sudah terdaftar pada akun lain.";
          const link = document.createElement("a");
          link.href = loginHref;
          link.textContent = "Masuk ke akun Anda";
          submitErrorLinkEl.innerHTML = "";
          submitErrorLinkEl.appendChild(link);
        }
        return;
      }

      if (error.code === "OTP_INVALID") {
        if (submitErrorEl && submitErrorMessageEl) {
          submitErrorEl.hidden = false;
          submitErrorMessageEl.textContent = "Kode salah atau kedaluwarsa.";
        }
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
    showWaFallback(context);
  }

  function startResendCountdown(): void {
    let remaining = RESEND_SECONDS;
    if (kirimUlangButton) kirimUlangButton.disabled = true;
    if (countdownEl) countdownEl.textContent = String(remaining);

    if (resendTimer) clearInterval(resendTimer);
    resendTimer = setInterval(() => {
      remaining -= 1;
      if (countdownEl) countdownEl.textContent = String(Math.max(remaining, 0));
      if (remaining <= 0) {
        clearInterval(resendTimer);
        if (kirimUlangButton) kirimUlangButton.disabled = false;
      }
    }, 1000);
  }

  function showCodeStep(): void {
    const dataStep = form?.querySelector<HTMLElement>('[data-step="data"]');
    const codeStep = form?.querySelector<HTMLElement>('[data-step="code"]');
    if (dataStep) dataStep.hidden = true;
    if (codeStep) {
      codeStep.hidden = false;
      codeInput?.focus();
    }
    startResendCountdown();
  }

  async function sendCode(): Promise<void> {
    hideSubmitError();
    clearFieldErrors();

    const name = nameInput?.value.trim() ?? "";
    const phone = phoneInput?.value.trim() ?? "";
    const email = emailInput?.value.trim() ?? "";

    let hasError = false;
    if (!name) {
      const t = form?.querySelector<HTMLElement>('[data-error-for="name"]');
      if (t) t.textContent = "Nama wajib diisi.";
      hasError = true;
    }
    if (!phone) {
      const t = form?.querySelector<HTMLElement>('[data-error-for="phone"]');
      if (t) t.textContent = "Nomor telepon wajib diisi.";
      hasError = true;
    }
    if (!email) {
      const t = form?.querySelector<HTMLElement>('[data-error-for="email"]');
      if (t) t.textContent = "E-mail wajib diisi.";
      hasError = true;
    }
    if (hasError) return;

    try {
      await mintaKode({ email, purpose: "register", name, phone });
      showStatus("Kode telah dikirim ke e-mail Anda.");
      showCodeStep();
    } catch (error) {
      showSubmitError(error, "mendaftar akun baru");
    }
  }

  kirimKodeButton?.addEventListener("click", () => void sendCode());
  kirimUlangButton?.addEventListener("click", () => void sendCode());

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideSubmitError();
    clearFieldErrors();

    const email = emailInput?.value.trim() ?? "";
    const code = codeInput?.value.trim() ?? "";

    if (!code) {
      const target = form.querySelector<HTMLElement>('[data-error-for="code"]');
      if (target) target.textContent = "Kode wajib diisi.";
      return;
    }

    try {
      const result = await verifikasiKode({ email, code, purpose: "register" });
      simpanSesi({ token: result.token, expiresAt: result.expiresAt, account: result.account });
      window.location.href = ROUTES.account;
    } catch (error) {
      showSubmitError(error, "mendaftar akun baru");
    }
  });
}
