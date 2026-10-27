/**
 * The customer Web Push flows (issue #431, ADR-0048 section 5.3 and 7): turn
 * notifications on, turn this device off, sign out and switch accounts without
 * leaving a subscription behind. Every flow is a function of a `DepsPush`
 * bundle of ports, so the ORDER of operations - the part ADR-0048 makes
 * binding - is unit-tested with fakes (`tests/push-alur.test.ts`) and the real
 * browser is only a thin adapter at the bottom of this file.
 *
 * ## The ordering rules this file owns
 *
 * Turn on (a single user gesture):
 *   1. read the permission and, only if it is `default`, ask for it - the very
 *      first thing, before any other `await`, because Safari/iOS only shows the
 *      prompt inside the gesture's call stack;
 *   2. register the worker, subscribe (re-subscribing when the server's VAPID key
 *      changed), POST the subscription with the consent the shopper ticked;
 *   3. only on a confirmed 2xx write the marker. A failure after step 2 rolls the
 *      browser subscription back, so a refused registration (device limit,
 *      endpoint not allowed) leaves nothing half-enrolled.
 *
 * Sign out (`keluarAman`) when this browser is enrolled:
 *   1. revoke this device on the server, then call logout and WAIT;
 *   2. only on a confirmed logout: `unsubscribe()` best effort, remove the
 *      marker, and only then clear the stored session;
 *   3. on a network failure nothing is cleared and nothing is unsubscribed: the
 *      caller says the sign-out could not be confirmed and offers retry or an
 *      explicit local-only exit (`keluarLokal`).
 *
 * Log in over a stored session (`siapkanSesiBaru`), called BEFORE the new
 * session is saved: log the OLD session out first; whatever the outcome,
 * unsubscribe this browser (so the previous account's notifications cannot
 * reach it and the next account cannot inherit the endpoint silently), and
 * leave a one-shot notice when the server did not confirm.
 *
 * The service worker never holds the token: everything here runs on the page.
 */
import { TokoApiError } from "./toko-permintaan";
import {
  PUSH_MARKER_KEY,
  PUSH_NOTICE_KEY,
  PUSH_WORKER_PATH,
  PUSH_WORKER_SCOPE,
  kunciSama,
  kunciServerKeBytes,
  parsePenanda,
  parseRegistrasi,
  petakanGalat,
  petakanGalatPeramban,
  teksPersetujuan,
  type GalatPush,
  type PemberitahuanPush,
  type PenandaPush,
  type PushCapability,
  type PushDevice,
  type PushPreference,
  type PushPurpose
} from "./push-pelanggan";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** What a browser push subscription must expose for a registration. */
export type LanggananInfo = { endpoint: string; p256dh: string; auth: string };

export interface PortPeramban {
  /** `Notification.permission`, synchronously. */
  izin(): NotificationPermission;
  /** `Notification.requestPermission()`. Called only from a user gesture. */
  mintaIzin(): Promise<NotificationPermission>;
  /** Registers the fixed worker URL at the fixed scope and waits until it is ready. */
  daftarkanPekerja(): Promise<void>;
  /** The existing subscription of OUR registration, or `null`. Never creates one. */
  ambilLangganan(): Promise<LanggananInfo | null>;
  /** The subscription for `kunci`, reusing the current one when its key matches. `baru` says whether this call created it. */
  berlangganan(kunci: Uint8Array): Promise<{ info: LanggananInfo; baru: boolean }>;
  /** `unsubscribe()`, best effort: never rejects. */
  berhentiLangganan(): Promise<void>;
  /** Unregisters the worker once nothing is subscribed; best effort, never rejects. */
  lepasPekerja(): Promise<void>;
}

export interface PortServer {
  daftar(input: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    consent: { purposes: string[]; textVersion: string };
  }): Promise<unknown>;
  cabut(id: string): Promise<void>;
  /** `POST .../account/logout` with the stored (old) token. */
  keluar(): Promise<void>;
}

export interface PortSesi {
  /** The stored session's account id, or `null`. */
  akunId(): string | null;
  hapus(): void;
}

export interface PortPenanda {
  baca(): PenandaPush | null;
  tulis(penanda: PenandaPush): void;
  hapus(): void;
}

export interface PortPemberitahuan {
  catat(pemberitahuan: PemberitahuanPush): void;
}

export type DepsPush = {
  browser: PortPeramban;
  server: PortServer;
  sesi: PortSesi;
  penanda: PortPenanda;
  pemberitahuan: PortPemberitahuan;
  /** Injectable clock for the marker timestamp. */
  sekarang?: () => Date;
};

function adalah401(error: unknown): boolean {
  return error instanceof TokoApiError && (error.code === "UNAUTHENTICATED" || error.status === 401);
}

function adalah404(error: unknown): boolean {
  return error instanceof TokoApiError && error.status === 404;
}

/** Stops this browser receiving: unsubscribe, then drop the worker, then forget the marker. All three are best effort. */
async function putusLokal(deps: DepsPush): Promise<void> {
  await deps.browser.berhentiLangganan();
  await deps.browser.lepasPekerja();
  deps.penanda.hapus();
}

// ---------------------------------------------------------------------------
// Turn on
// ---------------------------------------------------------------------------

export type HasilAktifkan =
  | { ok: true; device: PushDevice; preferences: PushPreference[] }
  | { ok: false; galat: GalatPush };

/**
 * Turn notifications on for THIS browser. Must be called straight from a click
 * handler. `purposes` are the ones the shopper ticked - never defaulted here.
 */
export async function aktifkanPerangkat(
  deps: DepsPush,
  input: { capability: PushCapability; purposes: PushPurpose[]; akunId: string }
): Promise<HasilAktifkan> {
  const { capability, purposes, akunId } = input;

  const teks = teksPersetujuan(capability.consentTextVersion);
  if (!teks) {
    return {
      ok: false,
      galat: {
        kode: "CONSENT_TEXT_UNKNOWN",
        pesan: "Teks persetujuan di halaman ini belum cocok dengan versi terbaru toko. Muat ulang halaman, lalu coba lagi.",
        tindakan: "muat_ulang",
        tunggu: null
      }
    };
  }
  if (purposes.length === 0) {
    return {
      ok: false,
      galat: {
        kode: "NO_PURPOSE",
        pesan: "Pilih minimal satu jenis notifikasi yang ingin Anda terima.",
        tindakan: "tidak_ada",
        tunggu: null
      }
    };
  }
  const kunci = capability.applicationServerKey ? kunciServerKeBytes(capability.applicationServerKey) : null;
  if (!kunci) {
    return {
      ok: false,
      galat: {
        kode: "KEY_INVALID",
        pesan: "Notifikasi belum siap di toko ini. Coba lagi nanti.",
        tindakan: "tidak_ada",
        tunggu: null
      }
    };
  }

  // 1. The permission prompt - first, before any other await (the gesture).
  let izin: NotificationPermission = deps.browser.izin();
  if (izin === "default") {
    try {
      izin = await deps.browser.mintaIzin();
    } catch (error) {
      return { ok: false, galat: petakanGalatPeramban(error) };
    }
  }
  if (izin === "denied") return { ok: false, galat: petakanGalatPeramban({ name: "NotAllowedError" }) };
  if (izin !== "granted") {
    return {
      ok: false,
      galat: {
        kode: "PERMISSION_DISMISSED",
        pesan: "Izin notifikasi belum diberikan. Ketuk Aktifkan Notifikasi lagi, lalu pilih Izinkan.",
        tindakan: "coba_lagi",
        tunggu: null
      }
    };
  }

  // 2. Worker and subscription.
  let langganan: { info: LanggananInfo; baru: boolean };
  try {
    await deps.browser.daftarkanPekerja();
    langganan = await deps.browser.berlangganan(kunci);
  } catch (error) {
    await deps.browser.lepasPekerja();
    return { ok: false, galat: petakanGalatPeramban(error) };
  }

  // 3. The server write, then the marker.
  try {
    const jawaban = await deps.server.daftar({
      endpoint: langganan.info.endpoint,
      keys: { p256dh: langganan.info.p256dh, auth: langganan.info.auth },
      consent: { purposes, textVersion: teks.version }
    });
    const registrasi = parseRegistrasi(jawaban);
    if (!registrasi) throw new TokoApiError("The registration answer could not be read.", 200, "INVALID_RESPONSE");

    deps.penanda.tulis({
      deviceId: registrasi.device.id,
      accountId: akunId,
      at: (deps.sekarang ?? (() => new Date()))().toISOString()
    });
    return { ok: true, device: registrasi.device, preferences: registrasi.preferences };
  } catch (error) {
    // Roll back what THIS call created: a refused registration must not leave a
    // live browser subscription the server knows nothing about.
    if (langganan.baru) {
      await deps.browser.berhentiLangganan();
      await deps.browser.lepasPekerja();
    }
    return { ok: false, galat: petakanGalat(error, { maxDevices: capability.maxDevices }) };
  }
}

// ---------------------------------------------------------------------------
// Turn off
// ---------------------------------------------------------------------------

export type HasilMatikan = { terkonfirmasi: boolean; galat: GalatPush | null };

/**
 * Turn THIS device off: revoke it on the server, then stop the browser
 * receiving. The local stop happens even when the server could not be reached -
 * the shopper's intent is "no more here", and an unsubscribed endpoint is dead
 * whatever the server still believes - and `terkonfirmasi: false` lets the page
 * say the server row is still to be removed.
 */
export async function matikanPerangkatIni(deps: DepsPush, deviceId: string | null): Promise<HasilMatikan> {
  let galat: GalatPush | null = null;
  const id = deviceId ?? deps.penanda.baca()?.deviceId ?? null;

  if (id !== null) {
    try {
      await deps.server.cabut(id);
    } catch (error) {
      if (!adalah404(error)) galat = petakanGalat(error);
    }
  }
  await putusLokal(deps);
  return { terkonfirmasi: galat === null, galat };
}

/** Remove another device of this account (never this browser's - see `matikanPerangkatIni`). A `404` means it is already gone. */
export async function cabutPerangkatLain(deps: DepsPush, id: string): Promise<{ galat: GalatPush | null }> {
  try {
    await deps.server.cabut(id);
    return { galat: null };
  } catch (error) {
    return { galat: adalah404(error) ? null : petakanGalat(error) };
  }
}

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------

export type HasilKeluar = { hasil: "keluar" } | { hasil: "belum_terkonfirmasi"; galat: GalatPush };

/**
 * The ADR-0048 section 7 logout. When this browser is NOT enrolled this is
 * issue #88's rule unchanged: ask the server, then clear the local session
 * whatever happened. When it IS enrolled, the local session is cleared only
 * after the server confirmed the logout (see the file header).
 */
export async function keluarAman(deps: DepsPush): Promise<HasilKeluar> {
  const penanda = deps.penanda.baca();

  if (!penanda) {
    try {
      await deps.server.keluar();
    } catch {
      // #88: a network failure must not strand a shopper signed in locally.
    }
    deps.sesi.hapus();
    return { hasil: "keluar" };
  }

  // The logout below revokes every device of THIS session; revoking the one the
  // marker names first also covers a device an older session enrolled.
  try {
    await deps.server.cabut(penanda.deviceId);
  } catch {
    // Not fatal: logout is the authoritative server step.
  }

  try {
    await deps.server.keluar();
  } catch (error) {
    // A 401 means the server already considers this session over.
    if (!adalah401(error)) return { hasil: "belum_terkonfirmasi", galat: petakanGalat(error) };
  }

  await putusLokal(deps);
  deps.sesi.hapus();
  return { hasil: "keluar" };
}

/**
 * The explicit "sign out here anyway" after an unconfirmed logout: stop this
 * browser receiving, forget the marker, clear the session. The server keeps the
 * session until it expires; it will revoke the devices then.
 */
export async function keluarLokal(deps: DepsPush): Promise<void> {
  await putusLokal(deps);
  deps.sesi.hapus();
}

// ---------------------------------------------------------------------------
// Log in over a stored session / account switch
// ---------------------------------------------------------------------------

export type HasilSesiBaru = { hasil: "tidak_perlu" } | { hasil: "dibersihkan"; terkonfirmasi: boolean };

/**
 * Call BEFORE `simpanSesi` of a freshly verified login. The old session is
 * logged out on the server first (its token is still the stored one), and this
 * browser stops receiving for it whatever the outcome. A login flow cannot
 * block on a failed old-session logout - the one-time code is already spent -
 * so the unconfirmed case is a notice on the settings page instead.
 */
export async function siapkanSesiBaru(deps: DepsPush): Promise<HasilSesiBaru> {
  const penanda = deps.penanda.baca();
  const adaSesiLama = deps.sesi.akunId() !== null;
  if (!adaSesiLama && !penanda) return { hasil: "tidak_perlu" };

  let terkonfirmasi = true;
  if (adaSesiLama) {
    if (penanda) {
      try {
        await deps.server.cabut(penanda.deviceId);
      } catch {
        // The logout below revokes the session's devices too.
      }
    }
    try {
      await deps.server.keluar();
    } catch (error) {
      if (!adalah401(error)) terkonfirmasi = false;
    }
  }

  await putusLokal(deps);
  if (!terkonfirmasi) deps.pemberitahuan.catat("sesi_lama_belum_terkonfirmasi");
  return { hasil: "dibersihkan", terkonfirmasi };
}

/**
 * The no-network safety net: when there is no stored session, or the marker
 * belongs to a different account than the stored session (an account switch
 * that did not go through a login flow), stop this browser receiving. Returns
 * whether it acted. Used on every account page load and on `akun:berubah`.
 */
export async function bersihkanLokalBilaPerlu(deps: DepsPush): Promise<boolean> {
  const penanda = deps.penanda.baca();
  if (!penanda) return false;

  const akunId = deps.sesi.akunId();
  if (akunId !== null && akunId === penanda.accountId) return false;

  await putusLokal(deps);
  return true;
}

// ---------------------------------------------------------------------------
// The real browser
// ---------------------------------------------------------------------------

function base64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return "";
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function infoDari(langganan: PushSubscription): LanggananInfo {
  return {
    endpoint: langganan.endpoint,
    p256dh: base64Url(langganan.getKey("p256dh")),
    auth: base64Url(langganan.getKey("auth"))
  };
}

async function registrasiKita(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return (await navigator.serviceWorker.getRegistration(PUSH_WORKER_SCOPE)) ?? null;
  } catch {
    return null;
  }
}

/** Whether this browser can do Web Push at all (service worker, Push API and Notification API). */
export function pushDidukungPeramban(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function buatPortPeramban(): PortPeramban {
  return {
    izin: () => ("Notification" in window ? Notification.permission : "denied"),
    mintaIzin: () => Notification.requestPermission(),

    async daftarkanPekerja() {
      await navigator.serviceWorker.register(PUSH_WORKER_PATH, {
        scope: PUSH_WORKER_SCOPE,
        updateViaCache: "none"
      });
      await navigator.serviceWorker.ready;
    },

    async ambilLangganan() {
      const registrasi = await registrasiKita();
      if (!registrasi) return null;
      try {
        const langganan = await registrasi.pushManager.getSubscription();
        return langganan ? infoDari(langganan) : null;
      } catch {
        return null;
      }
    },

    async berlangganan(kunci) {
      const registrasi = await navigator.serviceWorker.ready;
      const ada = await registrasi.pushManager.getSubscription();
      if (ada && kunciSama(ada.options?.applicationServerKey, kunci)) {
        return { info: infoDari(ada), baru: false };
      }
      // A different key means the operator rotated VAPID: the old subscription
      // can never receive again, so replace it.
      if (ada) await ada.unsubscribe();
      const baru = await registrasi.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: kunci as BufferSource
      });
      return { info: infoDari(baru), baru: true };
    },

    async berhentiLangganan() {
      try {
        const registrasi = await registrasiKita();
        const langganan = registrasi ? await registrasi.pushManager.getSubscription() : null;
        if (langganan) await langganan.unsubscribe();
      } catch {
        // Best effort: an endpoint the server has revoked is dead anyway.
      }
    },

    async lepasPekerja() {
      try {
        const registrasi = await registrasiKita();
        if (!registrasi) return;
        const langganan = await registrasi.pushManager.getSubscription();
        if (!langganan) await registrasi.unregister();
      } catch {
        // Best effort.
      }
    }
  };
}

export function buatPortPenanda(): PortPenanda {
  return {
    baca() {
      try {
        return parsePenanda(window.localStorage.getItem(PUSH_MARKER_KEY));
      } catch {
        return null;
      }
    },
    tulis(penanda) {
      try {
        window.localStorage.setItem(PUSH_MARKER_KEY, JSON.stringify(penanda));
      } catch {
        // Private mode: the enrolment still works; sign-out falls back to the server's own logout revocation.
      }
    },
    hapus() {
      try {
        window.localStorage.removeItem(PUSH_MARKER_KEY);
      } catch {
        // Nothing to do.
      }
    }
  };
}

export function buatPortPemberitahuan(): PortPemberitahuan {
  return {
    catat(pemberitahuan) {
      try {
        window.sessionStorage.setItem(PUSH_NOTICE_KEY, pemberitahuan);
      } catch {
        // A notice is a courtesy.
      }
    }
  };
}

/** Reads and clears the one-shot notice, if any. */
export function ambilPemberitahuan(): PemberitahuanPush | null {
  try {
    const nilai = window.sessionStorage.getItem(PUSH_NOTICE_KEY);
    window.sessionStorage.removeItem(PUSH_NOTICE_KEY);
    return nilai === "sesi_lama_belum_terkonfirmasi" ? nilai : null;
  } catch {
    return null;
  }
}
