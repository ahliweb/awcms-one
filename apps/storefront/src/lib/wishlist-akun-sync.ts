/**
 * The account-wishlist sync issue #90 asks for, kept in one shared module so
 * `wishlist-tombol.ts` (every heart button, site-wide) and `wishlist.ts`
 * (the `/wishlist` page's own listing) write through to the account the SAME
 * way rather than each re-implementing it.
 *
 * - **On login** (`akun:berubah` with a truthy detail): `PUT
 *   …/account/wishlist` with the local wishlist's product ids, then replace
 *   the local copy with the union of what was already local and what the
 *   CMS answered — `wishlist-sinkron.ts`'s pure `gabungkanWishlist`, so the
 *   LOCAL `addedAt` (the only place that timestamp is genuinely known for an
 *   item just pushed up) survives rather than being overwritten by "now".
 * - **While logged in**, every add/remove ALSO calls the account endpoint
 *   (`PUT` to add, `DELETE` to remove) — the local copy becomes a render
 *   cache, per this issue's own framing, not the source of truth.
 * - **On logout**, nothing here runs — the local copy is left exactly as it
 *   is (this issue's own "keep the local copy as-is" rule).
 * - **Any network failure** degrades to local-only operation: the local
 *   write already happened (`wishlist-klien.ts`'s `toggleWishlist`/
 *   `removeFromWishlist` run first, synchronously), and this module only
 *   reports the sync failure through a polite, shared `aria-live` region —
 *   it never throws into a click handler, and the heart button never looks
 *   broken.
 */
import { AKUN_EVENT_NAME } from "./akun-kontrak";
import { bacaSesi } from "./akun-sesi";
import { hapusWishlistAkunItem, simpanWishlistAkun } from "./akun-klien";
import { loadWishlist, saveWishlist } from "./wishlist-klien";
import { gabungkanWishlist } from "./wishlist-sinkron";

const STATUS_ELEMENT_ID = "wishlist-sinkron-status";

/** Creates (once) and returns the shared `aria-live="polite"` status region every wishlist write-through failure reports through — a single region reused by every heart button on the page, appended to `<body>` lazily so no page's own markup has to carry it. */
function statusElement(): HTMLElement {
  let el = document.getElementById(STATUS_ELEMENT_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = STATUS_ELEMENT_ID;
    el.className = "visually-hidden";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  return el;
}

function laporkanKegagalan(pesan: string): void {
  statusElement().textContent = pesan;
}

let sedangSinkron = false;

/**
 * Runs the login-time sync described above. Exported (not just wired
 * internally) so a page that already knows a session exists at load time —
 * rather than only learning it from a same-page `akun:berubah` — can call it
 * directly.
 */
export async function sinkronkanWishlistSaatMasuk(): Promise<void> {
  const sesi = bacaSesi();
  if (!sesi || sedangSinkron) return;

  sedangSinkron = true;
  try {
    const local = loadWishlist();
    const { items: serverItems } = await simpanWishlistAkun(local.items.map((item) => item.productId));
    const merged = gabungkanWishlist(local.items, serverItems);
    saveWishlist({ items: merged });
  } catch {
    laporkanKegagalan("Wishlist tidak dapat disinkronkan ke akun Anda saat ini — daftar di perangkat ini tetap tersimpan.");
  } finally {
    sedangSinkron = false;
  }
}

/**
 * The write-through half: call this AFTER a local toggle/remove has already
 * happened (`wishlist-klien.ts` already updated `localStorage`) — a no-op
 * when signed out, per this issue's own "localStorage otherwise" rule.
 */
export async function tulisKeAkunJikaMasuk(productId: string, ditambahkan: boolean): Promise<void> {
  const sesi = bacaSesi();
  if (!sesi) return;

  try {
    if (ditambahkan) await simpanWishlistAkun([productId]);
    else await hapusWishlistAkunItem(productId);
  } catch {
    laporkanKegagalan("Perubahan wishlist tersimpan di perangkat ini, tetapi belum tersinkron ke akun Anda.");
  }
}

let wired = false;

/** Attaches the `akun:berubah` login-sync listener exactly once per page (idempotent — every page that imports `wishlist-tombol.ts` calls this, so a second call from a second import must not double-wire), and runs one sync immediately if a session is already present when this runs. */
export function pasangSinkronisasiWishlist(): void {
  if (wired) return;
  wired = true;

  window.addEventListener(AKUN_EVENT_NAME, (event) => {
    const detail = (event as CustomEvent).detail;
    if (detail) void sinkronkanWishlistSaatMasuk();
  });

  if (bacaSesi()) void sinkronkanWishlistSaatMasuk();
}
