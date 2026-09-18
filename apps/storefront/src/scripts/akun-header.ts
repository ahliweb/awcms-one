/**
 * `Header.astro`'s `[data-akun-tautan]` swap (issue #88) — server-rendered
 * as "Masuk" → `ROUTES.login`, works with no JavaScript. When
 * `bacaSesi()` finds a live session, this script swaps the text to the
 * account's first name and the `href` to `ROUTES.account`, re-running on
 * every `akun:berubah` (login/logout/profile edit on THIS tab) and the
 * native `storage` event (a write from another tab) — the same two-listener
 * pattern `keranjang-hitung.ts`/`wishlist-tombol.ts` already use to stay in
 * sync with `keranjang-kontrak.ts`/`wishlist-kontrak.ts`.
 */
import { bacaSesi } from "../lib/akun-sesi";
import { ROUTES } from "../config/routes";
import { AKUN_EVENT_NAME } from "../lib/akun-kontrak";

const link = document.querySelector<HTMLAnchorElement>("[data-akun-tautan]");
const label = link?.querySelector<HTMLElement>("[data-akun-label]") ?? null;

if (link && label) {
  const defaultLabel = label.textContent ?? "Masuk";
  const defaultHref = link.getAttribute("href") ?? ROUTES.login;

  function perbarui(): void {
    if (!link || !label) return;
    const sesi = bacaSesi();

    if (sesi) {
      const firstName = sesi.account.name.trim().split(/\s+/)[0] || sesi.account.name;
      label.textContent = firstName;
      link.href = ROUTES.account;
    } else {
      label.textContent = defaultLabel;
      link.href = defaultHref;
    }
  }

  perbarui();
  window.addEventListener(AKUN_EVENT_NAME, perbarui);
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === "awcms-one:akun:v1") perbarui();
  });
}
