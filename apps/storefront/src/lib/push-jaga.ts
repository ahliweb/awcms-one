/**
 * The no-network safety net of customer Web Push (issue #431), small enough to
 * live in the code EVERY page loads (`akun-header.ts`): when a browser that
 * enabled notifications has no stored session any more - it expired, a request
 * answered `401`, or the shopper signed out in another tab - or the stored
 * session belongs to another account than the one that enrolled, this browser
 * stops receiving. Nothing is loaded and nothing is asked unless the enrolment
 * marker exists: on a browser that never enabled notifications this is one
 * `localStorage` read.
 *
 * Imports nothing but the storage key: the push flows are fetched with a
 * dynamic `import()` only when there is a marker to act on, so an ordinary page
 * carries no Push API code, no consent text and no account client because of
 * it. Browser-only; never throws.
 */
import { PUSH_MARKER_KEY } from "./push-kunci";

function adaPenanda(): boolean {
  try {
    return window.localStorage.getItem(PUSH_MARKER_KEY) !== null;
  } catch {
    return false;
  }
}

export async function jagaPenandaPush(): Promise<void> {
  if (!adaPenanda()) return;
  try {
    const [alur, deps] = await Promise.all([import("./push-alur"), import("./push-deps")]);
    await alur.bersihkanLokalBilaPerlu(deps.buatDepsNyata());
  } catch {
    // Best effort: the server revokes the devices of an ended session itself.
  }
}
