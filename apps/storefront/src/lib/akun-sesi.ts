/**
 * The browser-only account-session client — `localStorage` read/write and the
 * `CustomEvent` dispatch, built entirely out of `src/lib/akun-kontrak.ts`'s
 * pure functions (issue #88). Mirrors `wishlist-klien.ts`/`keranjang-klien.ts`
 * exactly, for the same reason: never imported from `.astro` frontmatter (no
 * `window` at build time), only from a `<script>` block Astro bundles into an
 * external module.
 *
 * Every storage access is wrapped in try/catch — a private window, or
 * storage blocked by the browser/an extension, must read the same as "not
 * signed in", never throw and break the page.
 */
import { AKUN_EVENT_NAME, AKUN_STORAGE_KEY, isSesiKedaluwarsa, parseSesi, type SesiAkun } from "./akun-kontrak";

function tulis(sesi: SesiAkun | null): void {
  try {
    if (sesi) window.localStorage.setItem(AKUN_STORAGE_KEY, JSON.stringify(sesi));
    else window.localStorage.removeItem(AKUN_STORAGE_KEY);
  } catch {
    // A full/blocked/private-mode storage means this write did not persist —
    // the event below still fires, so a page's own in-memory state (this
    // tab, this load) stays consistent even when the NEXT load will forget.
  }

  try {
    window.dispatchEvent(new CustomEvent(AKUN_EVENT_NAME, { detail: sesi }));
  } catch {
    // No environment this app ships to lacks CustomEvent — kept defensive
    // only so a write is never the thing that throws.
  }
}

/**
 * The current session, or `null` — never throws. A session whose
 * `expiresAt` has already passed is treated as absent AND is cleared here
 * (rather than left for the next read to notice), so a stale token is never
 * handed to `akun-klien.ts` only to bounce off a `401` it could have
 * avoided.
 */
export function bacaSesi(): SesiAkun | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(AKUN_STORAGE_KEY);
  } catch {
    return null;
  }

  const sesi = parseSesi(raw);
  if (!sesi) return null;

  if (isSesiKedaluwarsa(sesi)) {
    hapusSesi();
    return null;
  }

  return sesi;
}

/** Persists `sesi` and notifies every listener on this page (`AKUN_EVENT_NAME`) — the OTP-verify success handler's whole "you are now signed in" step. */
export function simpanSesi(sesi: SesiAkun): void {
  tulis(sesi);
}

/** Clears the session and notifies every listener — logout, an expired read, and a `401 UNAUTHENTICATED` from `akun-klien.ts` all call this same function. */
export function hapusSesi(): void {
  tulis(null);
}
