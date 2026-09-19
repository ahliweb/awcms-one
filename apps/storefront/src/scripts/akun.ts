/**
 * `/akun` interactivity (issue #88, S1) — toggles the guest/account view per
 * `bacaSesi()`, fetches the live profile (`GET …/account/me`, so a stale
 * `localStorage` copy is never shown as current), handles "Ubah nama"
 * (`PATCH …/account/me`) and "Keluar" (`POST …/account/logout`, ALWAYS
 * clearing the local session afterwards — issue #88's own rule — even when
 * the request itself failed over the network).
 *
 * Issue #115 adds the marketing-consent toggle: a real checkbox that saves
 * on `change` (`PATCH …/account/me {marketingConsent}`), confirms through
 * the SAME `aria-live` region `renderProfile` already updates for a name
 * change, and reverts its own checked state (without a page reload) if the
 * save fails — the checkbox is never left showing a state the server does
 * not actually hold.
 */
import { ambilProfil, keluar, ubahProfil } from "../lib/akun-klien";
import { bacaSesi, hapusSesi } from "../lib/akun-sesi";
import { AKUN_EVENT_NAME } from "../lib/akun-kontrak";
import { TokoApiError } from "../lib/toko-permintaan";
import { buildWhatsappAccountMessage, buildWhatsappUrl } from "../lib/wa-fallback";

const LEVEL_LABELS: Record<number, string> = {};

function levelLabel(level: number): string {
  return LEVEL_LABELS[level] ?? `Level ${level}`;
}

const root = document.querySelector<HTMLElement>("[data-akun-root]");
if (root) {
  const statusEl = root.querySelector<HTMLElement>("[data-status]");
  const submitErrorEl = root.querySelector<HTMLElement>("[data-submit-error]");
  const submitErrorMessageEl = root.querySelector<HTMLElement>("[data-submit-error-message]");
  const waFallbackLink = root.querySelector<HTMLAnchorElement>("[data-wa-fallback-link]");
  const guestView = root.querySelector<HTMLElement>("[data-guest-view]");
  const accountView = root.querySelector<HTMLElement>("[data-account-view]");
  const profileNameEl = root.querySelector<HTMLElement>("[data-profile-name]");
  const profileEmailEl = root.querySelector<HTMLElement>("[data-profile-email]");
  const profilePhoneEl = root.querySelector<HTMLElement>("[data-profile-phone]");
  const profileLevelEl = root.querySelector<HTMLElement>("[data-profile-level]");
  const ubahNamaForm = root.querySelector<HTMLFormElement>("[data-ubah-nama-form]");
  const ubahNamaInput = ubahNamaForm?.querySelector<HTMLInputElement>('[name="name"]');
  const keluarButton = root.querySelector<HTMLButtonElement>("[data-keluar]");
  const consentCheckbox = root.querySelector<HTMLInputElement>("[data-consent-checkbox]");
  const consentStatusEl = root.querySelector<HTMLElement>("[data-consent-status]");

  const whatsappNumber = root.dataset.whatsappNumber ?? "";
  const storeName = root.dataset.storeName ?? "toko";

  function hideSubmitError(): void {
    if (submitErrorEl) submitErrorEl.hidden = true;
    if (waFallbackLink) waFallbackLink.hidden = true;
  }

  function showWaFallback(context: string): void {
    if (!waFallbackLink || !whatsappNumber) return;
    waFallbackLink.href = buildWhatsappUrl(whatsappNumber, buildWhatsappAccountMessage(storeName, context));
    waFallbackLink.hidden = false;
  }

  function showSubmitError(error: unknown, context: string): void {
    if (submitErrorEl && submitErrorMessageEl) {
      submitErrorEl.hidden = false;
      submitErrorMessageEl.textContent =
        error instanceof TokoApiError ? error.message : "Terjadi kesalahan yang tidak terduga.";
    }
    showWaFallback(context);
  }

  function showGuestView(): void {
    if (guestView) guestView.hidden = false;
    if (accountView) accountView.hidden = true;
  }

  function renderProfile(account: {
    name: string;
    email: string;
    phone: string;
    level: number;
    marketingConsent: boolean;
  }): void {
    if (profileNameEl) profileNameEl.textContent = account.name;
    if (profileEmailEl) profileEmailEl.textContent = account.email;
    if (profilePhoneEl) profilePhoneEl.textContent = account.phone;
    if (profileLevelEl) profileLevelEl.textContent = levelLabel(account.level);
    if (ubahNamaInput) ubahNamaInput.value = account.name;
    if (consentCheckbox) consentCheckbox.checked = account.marketingConsent;
  }

  async function showAccountView(): Promise<void> {
    if (guestView) guestView.hidden = true;
    if (accountView) accountView.hidden = false;

    try {
      const { account } = await ambilProfil();
      renderProfile(account);
    } catch (error) {
      if (error instanceof TokoApiError && error.code === "UNAUTHENTICATED") {
        // The session was already cleared by akun-klien.ts's own 401
        // handling — re-render as the guest view rather than leaving a
        // half-populated profile card on screen.
        showGuestView();
        return;
      }
      showSubmitError(error, "membuka akun saya");
    }
  }

  function render(): void {
    hideSubmitError();
    const sesi = bacaSesi();
    if (sesi) {
      renderProfile(sesi.account);
      void showAccountView();
    } else {
      showGuestView();
    }
  }

  ubahNamaForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideSubmitError();
    const errorEl = ubahNamaForm.querySelector<HTMLElement>('[data-error-for="name"]');
    if (errorEl) errorEl.textContent = "";

    const name = ubahNamaInput?.value.trim() ?? "";
    if (!name) {
      if (errorEl) errorEl.textContent = "Nama wajib diisi.";
      return;
    }

    try {
      const { account } = await ubahProfil({ name });
      renderProfile(account);
      if (statusEl) {
        statusEl.hidden = false;
        statusEl.textContent = "Nama berhasil diperbarui.";
      }
    } catch (error) {
      if (error instanceof TokoApiError && error.code === "VALIDATION_ERROR" && errorEl) {
        const fieldError = error.fieldErrors.find((f) => f.field === "name");
        errorEl.textContent = fieldError?.message ?? error.message;
        return;
      }
      if (error instanceof TokoApiError && error.code === "UNAUTHENTICATED") {
        showGuestView();
        return;
      }
      showSubmitError(error, "mengubah nama akun");
    }
  });

  consentCheckbox?.addEventListener("change", async () => {
    const desired = consentCheckbox.checked;
    hideSubmitError();
    if (consentStatusEl) consentStatusEl.textContent = "";

    try {
      const { account } = await ubahProfil({ marketingConsent: desired });
      consentCheckbox.checked = account.marketingConsent;
      if (consentStatusEl) {
        consentStatusEl.textContent = account.marketingConsent
          ? "Anda akan menerima promo lewat e-mail/WhatsApp."
          : "Anda tidak akan menerima promo lewat e-mail/WhatsApp.";
      }
    } catch (error) {
      // Revert the checkbox to what the server actually holds — never leave
      // it showing a state the save did not confirm.
      consentCheckbox.checked = !desired;
      if (error instanceof TokoApiError && error.code === "UNAUTHENTICATED") {
        showGuestView();
        return;
      }
      if (consentStatusEl) {
        consentStatusEl.textContent =
          error instanceof TokoApiError ? error.message : "Gagal menyimpan preferensi. Coba lagi.";
      }
      showWaFallback("mengubah preferensi promo");
    }
  });

  keluarButton?.addEventListener("click", async () => {
    hideSubmitError();
    try {
      await keluar();
    } catch {
      // #88's own rule: the local session is cleared regardless of outcome
      // (a network failure must not strand a shopper "signed in" locally
      // while the server has no way to know they meant to sign out).
    } finally {
      hapusSesi();
      showGuestView();
    }
  });

  render();
  window.addEventListener(AKUN_EVENT_NAME, render);
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === "awcms-one:akun:v1") render();
  });
}
