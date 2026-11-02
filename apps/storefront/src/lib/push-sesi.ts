/**
 * The places the account pages (`/akun`, `/masuk`, `/daftar`) meet customer Web
 * Push (issue #431, ADR-0048 section 7): sign-out and login over a stored
 * session. The safety net for a session that ended by itself is `push-jaga.ts`,
 * kept apart because every page loads it. Everything heavy lives in
 * `push-alur.ts`/`push-deps.ts` and is loaded with a dynamic `import()` ONLY
 * when this browser carries an enrolment marker - so a browser that never
 * enabled notifications (the great majority, and every build with the push
 * flag off) pays one `localStorage` read and loads no push code at all.
 *
 * Browser-only. None of these functions throws: they run inside login and
 * logout, which must not break on a push problem.
 */
import { keluar } from "./akun-klien";
import { bacaSesi, hapusSesi } from "./akun-sesi";
import { PUSH_MARKER_KEY } from "./push-kunci";
import type { HasilKeluar } from "./push-alur";

/** Whether this browser has ever enrolled for push (the marker exists). */
export function adaPenandaPush(): boolean {
  try {
    return window.localStorage.getItem(PUSH_MARKER_KEY) !== null;
  } catch {
    return false;
  }
}

async function muatAlur() {
  const [alur, deps] = await Promise.all([import("./push-alur"), import("./push-deps")]);
  return { alur, deps: deps.buatDepsNyata() };
}

/**
 * Sign out. Not enrolled: issue #88's rule - ask the server, then clear the
 * local session whatever happened. Enrolled: ADR-0048 section 7's order, and an
 * unconfirmed logout is RETURNED instead of swallowed so the page can offer
 * retry or an explicit local-only exit.
 */
export async function keluarDenganPush(): Promise<HasilKeluar> {
  if (!adaPenandaPush()) {
    try {
      await keluar();
    } catch {
      // #88: never strand a shopper signed in locally.
    } finally {
      hapusSesi();
    }
    return { hasil: "keluar" };
  }

  let muat: Awaited<ReturnType<typeof muatAlur>>;
  try {
    muat = await muatAlur();
  } catch {
    // The lazily loaded chunk could not be fetched (offline): nothing is cleared,
    // exactly like any other unconfirmed sign-out, and the shopper can retry.
    return {
      hasil: "belum_terkonfirmasi",
      galat: {
        kode: "NETWORK_ERROR",
        pesan: "Tidak bisa terhubung ke toko. Periksa koneksi internet Anda, lalu coba lagi.",
        tindakan: "coba_lagi",
        tunggu: null
      }
    };
  }
  return muat.alur.keluarAman(muat.deps);
}

/** The explicit "sign out here anyway" after an unconfirmed logout. */
export async function keluarLokalDenganPush(): Promise<void> {
  if (!adaPenandaPush()) {
    hapusSesi();
    return;
  }
  try {
    const { alur, deps } = await muatAlur();
    await alur.keluarLokal(deps);
  } catch {
    // The push chunk is unreachable: the shopper asked to leave anyway, so the
    // session goes; the header's safety net stops this browser on its next load.
    hapusSesi();
  }
}

/**
 * Call BEFORE `simpanSesi` of a freshly verified login: the old session (if
 * any) is logged out on the server first, and an enrolled browser stops
 * receiving for it. Never blocks the login on a failure.
 */
export async function bersihkanSebelumSesiBaru(): Promise<void> {
  try {
    if (adaPenandaPush()) {
      const { alur, deps } = await muatAlur();
      await alur.siapkanSesiBaru(deps);
      return;
    }
    if (bacaSesi()) await keluar();
  } catch {
    // A login must complete; the server expires the old session by itself.
  }
}
