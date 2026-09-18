/**
 * `/masuk` interactivity (issue #88, S1) — e-mail → "Kirim kode" → 6-digit
 * code → verify → `simpanSesi` → redirect to `?kembali=` (validated,
 * same-origin path only) or `/akun`.
 */
import { mintaKode, verifikasiKode } from "../lib/akun-klien";
import { simpanSesi } from "../lib/akun-sesi";
import { TokoApiError } from "../lib/toko-permintaan";
import { ROUTES } from "../config/routes";
import { buildWhatsappAccountMessage, buildWhatsappUrl } from "../lib/wa-fallback";

const RESEND_SECONDS = 60;

/** Only a same-origin, root-relative path is honoured — an absolute URL or a `//host` path is an open-redirect vector this function refuses rather than "sanitises". */
function validKembaliPath(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  try {
    // Resolving against a fixed, harmless base and checking the result
    // stayed same-origin catches every "looks like a path but isn't" trick
    // (backslashes, `\t`/control characters URL parsers treat as scheme
    // separators) without hand-rolling that parsing here.
    const resolved = new URL(raw, "https://kembali.invalid");
    if (resolved.origin !== "https://kembali.invalid") return null;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return null;
  }
}

const root = document.querySelector<HTMLElement>("[data-masuk-root]");
if (root) {
  const form = root.querySelector<HTMLFormElement>("[data-masuk-form]");
  const statusEl = root.querySelector<HTMLElement>("[data-status]");
  const submitErrorEl = root.querySelector<HTMLElement>("[data-submit-error]");
  const submitErrorMessageEl = root.querySelector<HTMLElement>("[data-submit-error-message]");
  const submitErrorLinkEl = root.querySelector<HTMLElement>("[data-submit-error-link]");
  const waFallbackLink = root.querySelector<HTMLAnchorElement>("[data-wa-fallback-link]");
  const emailInput = form?.querySelector<HTMLInputElement>('[name="email"]');
  const codeInput = form?.querySelector<HTMLInputElement>('[name="code"]');
  const kirimKodeButton = form?.querySelector<HTMLButtonElement>("[data-kirim-kode]");
  const kirimUlangButton = form?.querySelector<HTMLButtonElement>("[data-kirim-ulang]");
  const countdownEl = form?.querySelector<HTMLElement>("[data-countdown]");

  const whatsappNumber = root.dataset.whatsappNumber ?? "";
  const storeName = root.dataset.storeName ?? "toko";
  const registerHref = root.dataset.registerHref ?? ROUTES.register;

  const params = new URLSearchParams(window.location.search);
  const kembali = validKembaliPath(params.get("kembali"));

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

      if (error.code === "ACCOUNT_NOT_FOUND") {
        if (submitErrorEl && submitErrorMessageEl && submitErrorLinkEl) {
          submitErrorEl.hidden = false;
          submitErrorMessageEl.textContent = "Akun dengan e-mail ini belum terdaftar.";
          const email = emailInput?.value.trim() ?? "";
          const link = document.createElement("a");
          link.href = `${registerHref}?email=${encodeURIComponent(email)}`;
          link.textContent = "Daftar akun baru";
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
    const emailStep = form?.querySelector<HTMLElement>('[data-step="email"]');
    const codeStep = form?.querySelector<HTMLElement>('[data-step="code"]');
    if (emailStep) emailStep.hidden = true;
    if (codeStep) {
      codeStep.hidden = false;
      codeInput?.focus();
    }
    startResendCountdown();
  }

  async function sendCode(): Promise<void> {
    if (!emailInput) return;
    hideSubmitError();
    clearFieldErrors();

    const email = emailInput.value.trim();
    if (!email) {
      const target = form?.querySelector<HTMLElement>('[data-error-for="email"]');
      if (target) target.textContent = "E-mail wajib diisi.";
      return;
    }

    try {
      await mintaKode({ email, purpose: "login" });
      showStatus("Kode telah dikirim ke e-mail Anda.");
      showCodeStep();
    } catch (error) {
      showSubmitError(error, "mendapatkan kode masuk");
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
      const result = await verifikasiKode({ email, code, purpose: "login" });
      simpanSesi({ token: result.token, expiresAt: result.expiresAt, account: result.account });
      window.location.href = kembali ?? ROUTES.account;
    } catch (error) {
      showSubmitError(error, "masuk ke akun");
    }
  });
}
