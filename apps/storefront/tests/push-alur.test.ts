/**
 * `src/lib/push-alur.ts` - the customer Web Push flows (issue #431, ADR-0048
 * section 7). Every assertion is about ORDER and OUTCOME of operations against
 * fake ports: the permission prompt is the first thing a click does, a refused
 * registration leaves no subscription behind, and - the binding part - sign-out
 * and a login over a stored session revoke on the server BEFORE the stored
 * session is cleared or replaced.
 */
import { describe, expect, test } from "bun:test";
import { createECDH } from "node:crypto";
import {
  aktifkanPerangkat,
  bersihkanLokalBilaPerlu,
  cabutPerangkatLain,
  keluarAman,
  keluarLokal,
  matikanPerangkatIni,
  siapkanSesiBaru,
  type DepsPush,
  type LanggananInfo
} from "../src/lib/push-alur";
import { PUSH_PURPOSES, type PemberitahuanPush, type PenandaPush, type PushCapability } from "../src/lib/push-pelanggan";
import { TokoApiError } from "../src/lib/toko-permintaan";

const VAPID = (() => {
  const curve = createECDH("prime256v1");
  curve.generateKeys();
  return curve.getPublicKey().toString("base64url");
})();

const CAPABILITY: PushCapability = {
  enabled: true,
  reason: null,
  applicationServerKey: VAPID,
  purposes: [...PUSH_PURPOSES],
  consentTextVersion: "draft-2026-10",
  maxDevices: 5
};

const SUBSCRIPTION: LanggananInfo = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: "P256", auth: "AUTH" };

const DEVICE = {
  id: "dev-1",
  endpointMasked: "fcm.googleapis.com/…abc",
  userAgentSummary: "Chrome on Android (mobile)",
  status: "active",
  lastSuccessAt: null,
  registeredAt: "2026-10-25T10:00:00.000Z",
  current: true
};

function api(status: number, code: string, details?: unknown): TokoApiError {
  return new TokoApiError("English operator message", status, code, details);
}

type Options = {
  permission?: NotificationPermission;
  /** What `requestPermission` answers. */
  asked?: NotificationPermission;
  marker?: PenandaPush | null;
  /** Account of the stored session; `null` = signed out. */
  sessionAccount?: string | null;
  subscribeThrows?: unknown;
  /** `baru` of the subscription this browser hands back. */
  subscriptionIsNew?: boolean;
  register?: () => Promise<unknown>;
  revoke?: (id: string) => Promise<void>;
  logout?: () => Promise<void>;
};

function harness(options: Options = {}) {
  const log: string[] = [];
  let marker: PenandaPush | null = options.marker ?? null;
  let sessionAccount: string | null = options.sessionAccount === undefined ? "acc-1" : options.sessionAccount;
  let permission: NotificationPermission = options.permission ?? "default";
  const notices: PemberitahuanPush[] = [];
  const registered: unknown[] = [];

  const deps: DepsPush = {
    browser: {
      izin() {
        log.push("izin");
        return permission;
      },
      async mintaIzin() {
        log.push("mintaIzin");
        permission = options.asked ?? "granted";
        return permission;
      },
      async daftarkanPekerja() {
        log.push("daftarkanPekerja");
      },
      async ambilLangganan() {
        log.push("ambilLangganan");
        return SUBSCRIPTION;
      },
      async berlangganan() {
        log.push("berlangganan");
        if (options.subscribeThrows) throw options.subscribeThrows;
        return { info: SUBSCRIPTION, baru: options.subscriptionIsNew ?? true };
      },
      async berhentiLangganan() {
        log.push("berhentiLangganan");
      },
      async lepasPekerja() {
        log.push("lepasPekerja");
      }
    },
    server: {
      async daftar(input) {
        log.push("server.daftar");
        registered.push(input);
        return options.register ? options.register() : { device: DEVICE, preferences: [] };
      },
      async cabut(id) {
        log.push(`server.cabut:${id}`);
        if (options.revoke) await options.revoke(id);
      },
      async keluar() {
        log.push("server.keluar");
        if (options.logout) await options.logout();
      }
    },
    sesi: {
      akunId: () => sessionAccount,
      hapus() {
        log.push("sesi.hapus");
        sessionAccount = null;
      }
    },
    penanda: {
      baca: () => marker,
      tulis(penanda) {
        log.push("penanda.tulis");
        marker = penanda;
      },
      hapus() {
        log.push("penanda.hapus");
        marker = null;
      }
    },
    pemberitahuan: {
      catat(n) {
        log.push(`catat:${n}`);
        notices.push(n);
      }
    },
    sekarang: () => new Date("2026-10-25T12:00:00.000Z")
  };

  return { deps, log, registered, notices, marker: () => marker, session: () => sessionAccount };
}

const MARKER: PenandaPush = { deviceId: "dev-1", accountId: "acc-1", at: "2026-10-25T10:00:00.000Z" };

const index = (log: string[], entry: string): number => log.indexOf(entry);

describe("aktifkanPerangkat - turning notifications on", () => {
  test("the permission prompt is the FIRST thing a click does (it must stay inside the gesture)", async () => {
    const h = harness({ permission: "default" });
    const pending = aktifkanPerangkat(h.deps, { capability: CAPABILITY, purposes: ["order_updates"], akunId: "acc-1" });
    // Nothing has been awaited yet: the synchronous prefix alone already asked.
    expect(h.log.slice(0, 2)).toEqual(["izin", "mintaIzin"]);
    const result = await pending;
    expect(result.ok).toBe(true);
  });

  test("a full success: permission, worker, subscribe, POST, then the marker - in that order", async () => {
    const h = harness({ permission: "default" });
    const result = await aktifkanPerangkat(h.deps, {
      capability: CAPABILITY,
      purposes: ["order_updates", "payment_updates"],
      akunId: "acc-1"
    });

    expect(result.ok).toBe(true);
    expect(h.log).toEqual(["izin", "mintaIzin", "daftarkanPekerja", "berlangganan", "server.daftar", "penanda.tulis"]);
    expect(h.registered[0]).toEqual({
      endpoint: SUBSCRIPTION.endpoint,
      keys: { p256dh: "P256", auth: "AUTH" },
      consent: { purposes: ["order_updates", "payment_updates"], textVersion: "draft-2026-10" }
    });
    expect(h.marker()).toEqual({ deviceId: "dev-1", accountId: "acc-1", at: "2026-10-25T12:00:00.000Z" });
  });

  test("an already granted permission asks nothing a second time", async () => {
    const h = harness({ permission: "granted" });
    await aktifkanPerangkat(h.deps, { capability: CAPABILITY, purposes: ["order_updates"], akunId: "acc-1" });
    expect(h.log).not.toContain("mintaIzin");
    expect(h.log).toContain("server.daftar");
  });

  test("a denied permission stops before any worker, subscription or request", async () => {
    const h = harness({ permission: "denied" });
    const result = await aktifkanPerangkat(h.deps, { capability: CAPABILITY, purposes: ["order_updates"], akunId: "acc-1" });
    expect(result).toMatchObject({ ok: false, galat: { kode: "PERMISSION_DENIED" } });
    expect(h.log).toEqual(["izin"]);
  });

  test("a prompt dismissed (still 'default') is a retry, with nothing created", async () => {
    const h = harness({ permission: "default", asked: "default" });
    const result = await aktifkanPerangkat(h.deps, { capability: CAPABILITY, purposes: ["order_updates"], akunId: "acc-1" });
    expect(result).toMatchObject({ ok: false, galat: { kode: "PERMISSION_DISMISSED", tindakan: "coba_lagi" } });
    expect(h.log).not.toContain("daftarkanPekerja");
    expect(h.log).not.toContain("server.daftar");
  });

  test("a prompt answered 'denied' is reported as denied", async () => {
    const h = harness({ permission: "default", asked: "denied" });
    const result = await aktifkanPerangkat(h.deps, { capability: CAPABILITY, purposes: ["order_updates"], akunId: "acc-1" });
    expect(result).toMatchObject({ ok: false, galat: { kode: "PERMISSION_DENIED" } });
  });

  test("no purpose chosen: nothing is asked and nothing is sent (no default consent)", async () => {
    const h = harness();
    const result = await aktifkanPerangkat(h.deps, { capability: CAPABILITY, purposes: [], akunId: "acc-1" });
    expect(result).toMatchObject({ ok: false, galat: { kode: "NO_PURPOSE" } });
    expect(h.log).toEqual([]);
  });

  test("a consent text version this page has no text for refuses to enrol - no grant against unseen wording", async () => {
    const h = harness();
    const result = await aktifkanPerangkat(h.deps, {
      capability: { ...CAPABILITY, consentTextVersion: "draft-2099-01" },
      purposes: ["order_updates"],
      akunId: "acc-1"
    });
    expect(result).toMatchObject({ ok: false, galat: { kode: "CONSENT_TEXT_UNKNOWN", tindakan: "muat_ulang" } });
    expect(h.log).toEqual([]);
  });

  test("an unusable server key never reaches the browser", async () => {
    const h = harness();
    const result = await aktifkanPerangkat(h.deps, {
      capability: { ...CAPABILITY, applicationServerKey: "short" },
      purposes: ["order_updates"],
      akunId: "acc-1"
    });
    expect(result).toMatchObject({ ok: false, galat: { kode: "KEY_INVALID" } });
    expect(h.log).toEqual([]);
  });

  test("a browser push failure is mapped, the worker dropped, and no request is made", async () => {
    const h = harness({ permission: "granted", subscribeThrows: Object.assign(new Error("push service error"), { name: "AbortError" }) });
    const result = await aktifkanPerangkat(h.deps, { capability: CAPABILITY, purposes: ["order_updates"], akunId: "acc-1" });
    expect(result).toMatchObject({ ok: false, galat: { kode: "PUSH_SERVICE_ERROR" } });
    expect(h.log).toContain("lepasPekerja");
    expect(h.log).not.toContain("server.daftar");
    expect(h.marker()).toBeNull();
  });

  for (const [name, error, kode] of [
    ["409 DEVICE_LIMIT", api(409, "DEVICE_LIMIT"), "DEVICE_LIMIT"],
    ["422 ENDPOINT_NOT_ALLOWED", api(422, "ENDPOINT_NOT_ALLOWED"), "ENDPOINT_NOT_ALLOWED"],
    ["422 ORIGIN_NOT_ALLOWED", api(422, "ORIGIN_NOT_ALLOWED"), "ORIGIN_NOT_ALLOWED"],
    ["409 PUSH_UNAVAILABLE", api(409, "PUSH_UNAVAILABLE"), "PUSH_UNAVAILABLE"],
    ["429", api(429, "RATE_LIMITED", { retryAfter: 30 }), "RATE_LIMITED"],
    ["network", api(0, "NETWORK_ERROR"), "NETWORK_ERROR"],
    ["401", api(401, "UNAUTHENTICATED"), "UNAUTHENTICATED"]
  ] as const) {
    test(`a refused registration (${name}) rolls the NEW subscription back and writes no marker`, async () => {
      const h = harness({ permission: "granted", subscriptionIsNew: true, register: () => Promise.reject(error) });
      const result = await aktifkanPerangkat(h.deps, { capability: CAPABILITY, purposes: ["order_updates"], akunId: "acc-1" });

      expect(result).toMatchObject({ ok: false, galat: { kode } });
      expect(h.log.slice(-3)).toEqual(["server.daftar", "berhentiLangganan", "lepasPekerja"]);
      expect(h.marker()).toBeNull();
    });
  }

  test("a refused registration keeps a subscription this call did not create", async () => {
    const h = harness({ permission: "granted", subscriptionIsNew: false, register: () => Promise.reject(api(0, "NETWORK_ERROR")) });
    await aktifkanPerangkat(h.deps, { capability: CAPABILITY, purposes: ["order_updates"], akunId: "acc-1" });
    expect(h.log).not.toContain("berhentiLangganan");
  });

  test("an unreadable 2xx body is not an enrolment", async () => {
    const h = harness({ permission: "granted", register: async () => ({ nonsense: true }) });
    const result = await aktifkanPerangkat(h.deps, { capability: CAPABILITY, purposes: ["order_updates"], akunId: "acc-1" });
    expect(result.ok).toBe(false);
    expect(h.marker()).toBeNull();
    expect(h.log).toContain("berhentiLangganan");
  });
});

describe("keluarAman - sign out", () => {
  test("not enrolled: issue #88's rule - the server is asked, the session is cleared, even when the request fails", async () => {
    const h = harness({ marker: null, logout: () => Promise.reject(api(0, "NETWORK_ERROR")) });
    const result = await keluarAman(h.deps);
    expect(result).toEqual({ hasil: "keluar" });
    expect(h.log).toEqual(["server.keluar", "sesi.hapus"]);
    expect(h.session()).toBeNull();
  });

  test("enrolled: revoke this device, log out, THEN unsubscribe, forget the marker and only then clear the session", async () => {
    const h = harness({ marker: MARKER });
    const result = await keluarAman(h.deps);

    expect(result).toEqual({ hasil: "keluar" });
    expect(h.log).toEqual([
      "server.cabut:dev-1",
      "server.keluar",
      "berhentiLangganan",
      "lepasPekerja",
      "penanda.hapus",
      "sesi.hapus"
    ]);
    // The ADR's binding order, stated as comparisons:
    expect(index(h.log, "server.keluar")).toBeLessThan(index(h.log, "berhentiLangganan"));
    expect(index(h.log, "berhentiLangganan")).toBeLessThan(index(h.log, "sesi.hapus"));
    expect(index(h.log, "server.keluar")).toBeLessThan(index(h.log, "sesi.hapus"));
    expect(h.marker()).toBeNull();
  });

  test("enrolled + network failure: NOTHING is cleared silently, nothing unsubscribed, the caller is told", async () => {
    const h = harness({ marker: MARKER, logout: () => Promise.reject(api(0, "NETWORK_ERROR")) });
    const result = await keluarAman(h.deps);

    expect(result).toMatchObject({ hasil: "belum_terkonfirmasi", galat: { kode: "NETWORK_ERROR", tindakan: "coba_lagi" } });
    expect(h.log).not.toContain("sesi.hapus");
    expect(h.log).not.toContain("berhentiLangganan");
    expect(h.log).not.toContain("penanda.hapus");
    expect(h.session()).toBe("acc-1");
    expect(h.marker()).toEqual(MARKER);
  });

  test("enrolled + a 5xx or 429 on logout is equally unconfirmed", async () => {
    for (const error of [api(500, "INTERNAL_ERROR"), api(429, "RATE_LIMITED")]) {
      const h = harness({ marker: MARKER, logout: () => Promise.reject(error) });
      const result = await keluarAman(h.deps);
      expect(result.hasil).toBe("belum_terkonfirmasi");
      expect(h.session()).toBe("acc-1");
    }
  });

  test("retry after an unconfirmed attempt completes the sign-out", async () => {
    let attempts = 0;
    const h = harness({
      marker: MARKER,
      logout: async () => {
        attempts += 1;
        if (attempts === 1) throw api(0, "NETWORK_ERROR");
      }
    });
    expect((await keluarAman(h.deps)).hasil).toBe("belum_terkonfirmasi");
    expect((await keluarAman(h.deps)).hasil).toBe("keluar");
    expect(h.session()).toBeNull();
    expect(h.marker()).toBeNull();
  });

  test("enrolled + the server already ended the session (401): that IS a confirmed sign-out", async () => {
    const h = harness({ marker: MARKER, logout: () => Promise.reject(api(401, "UNAUTHENTICATED")) });
    const result = await keluarAman(h.deps);
    expect(result).toEqual({ hasil: "keluar" });
    expect(h.log).toContain("berhentiLangganan");
    expect(h.session()).toBeNull();
  });

  test("a failed per-device revoke is not fatal: the logout is the authoritative server step", async () => {
    const h = harness({ marker: MARKER, revoke: () => Promise.reject(api(500, "INTERNAL_ERROR")) });
    const result = await keluarAman(h.deps);
    expect(result).toEqual({ hasil: "keluar" });
    expect(h.log).toContain("server.keluar");
  });

  test("keluarLokal (the explicit 'sign out here anyway'): stops this browser receiving, forgets the marker, clears the session - no server call", async () => {
    const h = harness({ marker: MARKER });
    await keluarLokal(h.deps);
    expect(h.log).toEqual(["berhentiLangganan", "lepasPekerja", "penanda.hapus", "sesi.hapus"]);
    expect(h.session()).toBeNull();
  });
});

describe("siapkanSesiBaru - login over a stored session / account switch", () => {
  test("no old session and no marker: nothing to do", async () => {
    const h = harness({ sessionAccount: null, marker: null });
    expect(await siapkanSesiBaru(h.deps)).toEqual({ hasil: "tidak_perlu" });
    expect(h.log).toEqual([]);
  });

  test("the OLD session is revoked and logged out on the server, then this browser stops receiving - before the caller stores the new session", async () => {
    const h = harness({ marker: MARKER, sessionAccount: "acc-1" });
    const result = await siapkanSesiBaru(h.deps);

    expect(result).toEqual({ hasil: "dibersihkan", terkonfirmasi: true });
    expect(h.log).toEqual(["server.cabut:dev-1", "server.keluar", "berhentiLangganan", "lepasPekerja", "penanda.hapus"]);
    expect(h.marker()).toBeNull();
    // It never clears the session itself: the caller overwrites it with the new one.
    expect(h.log).not.toContain("sesi.hapus");
  });

  test("an unconfirmed old-session logout still stops this browser receiving, and leaves a notice (no silent transfer)", async () => {
    const h = harness({ marker: MARKER, logout: () => Promise.reject(api(0, "NETWORK_ERROR")) });
    const result = await siapkanSesiBaru(h.deps);

    expect(result).toEqual({ hasil: "dibersihkan", terkonfirmasi: false });
    expect(h.log).toContain("berhentiLangganan");
    expect(h.log).toContain("penanda.hapus");
    expect(h.notices).toEqual(["sesi_lama_belum_terkonfirmasi"]);
  });

  test("an old session with no push enrolment is still logged out first", async () => {
    const h = harness({ marker: null, sessionAccount: "acc-1" });
    await siapkanSesiBaru(h.deps);
    expect(h.log[0]).toBe("server.keluar");
  });

  test("a leftover marker with no session just stops this browser receiving", async () => {
    const h = harness({ marker: MARKER, sessionAccount: null });
    const result = await siapkanSesiBaru(h.deps);
    expect(result).toEqual({ hasil: "dibersihkan", terkonfirmasi: true });
    expect(h.log).not.toContain("server.keluar");
    expect(h.log).toContain("berhentiLangganan");
  });
});

describe("bersihkanLokalBilaPerlu - the no-network safety net", () => {
  test("no marker: nothing happens", async () => {
    const h = harness({ marker: null });
    expect(await bersihkanLokalBilaPerlu(h.deps)).toBe(false);
    expect(h.log).toEqual([]);
  });

  test("a marker and the same account's session: nothing happens", async () => {
    const h = harness({ marker: MARKER, sessionAccount: "acc-1" });
    expect(await bersihkanLokalBilaPerlu(h.deps)).toBe(false);
    expect(h.log).toEqual([]);
  });

  test("a marker and NO session (expired, a 401, signed out in another tab): this browser stops receiving", async () => {
    const h = harness({ marker: MARKER, sessionAccount: null });
    expect(await bersihkanLokalBilaPerlu(h.deps)).toBe(true);
    expect(h.log).toEqual(["berhentiLangganan", "lepasPekerja", "penanda.hapus"]);
  });

  test("a marker of ANOTHER account than the stored session (a switch that skipped the login flow): stops receiving", async () => {
    const h = harness({ marker: MARKER, sessionAccount: "acc-2" });
    expect(await bersihkanLokalBilaPerlu(h.deps)).toBe(true);
    expect(h.marker()).toBeNull();
  });
});

describe("matikanPerangkatIni / cabutPerangkatLain", () => {
  test("turning this device off: server revoke first, then unsubscribe, worker and marker", async () => {
    const h = harness({ marker: MARKER });
    const result = await matikanPerangkatIni(h.deps, "dev-1");
    expect(result).toEqual({ terkonfirmasi: true, galat: null });
    expect(h.log).toEqual(["server.cabut:dev-1", "berhentiLangganan", "lepasPekerja", "penanda.hapus"]);
  });

  test("an id from the marker is used when the caller gives none", async () => {
    const h = harness({ marker: MARKER });
    await matikanPerangkatIni(h.deps, null);
    expect(h.log[0]).toBe("server.cabut:dev-1");
  });

  test("the server unreachable: this browser still stops receiving, and the result says it was not confirmed", async () => {
    const h = harness({ marker: MARKER, revoke: () => Promise.reject(api(0, "NETWORK_ERROR")) });
    const result = await matikanPerangkatIni(h.deps, "dev-1");
    expect(result.terkonfirmasi).toBe(false);
    expect(result.galat?.kode).toBe("NETWORK_ERROR");
    expect(h.log).toContain("berhentiLangganan");
    expect(h.marker()).toBeNull();
  });

  test("a 404 (already gone) counts as confirmed", async () => {
    const h = harness({ marker: MARKER, revoke: () => Promise.reject(api(404, "NOT_FOUND")) });
    expect((await matikanPerangkatIni(h.deps, "dev-1")).terkonfirmasi).toBe(true);
  });

  test("removing another device only touches the server, never this browser's subscription", async () => {
    const h = harness({ marker: MARKER });
    expect(await cabutPerangkatLain(h.deps, "dev-2")).toEqual({ galat: null });
    expect(h.log).toEqual(["server.cabut:dev-2"]);
    expect(h.marker()).toEqual(MARKER);
  });

  test("removing another device: 404 is fine, other failures are reported", async () => {
    const gone = harness({ revoke: () => Promise.reject(api(404, "NOT_FOUND")) });
    expect((await cabutPerangkatLain(gone.deps, "x")).galat).toBeNull();
    const down = harness({ revoke: () => Promise.reject(api(500, "INTERNAL_ERROR")) });
    expect((await cabutPerangkatLain(down.deps, "x")).galat?.tindakan).toBe("coba_lagi");
  });
});
