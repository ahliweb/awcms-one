/**
 * `src/lib/push-pelanggan.ts` - the pure customer Web Push contract (issue
 * #431, ADR-0048 section 7): capability states, the error mapping, iOS
 * detection, the VAPID key, the versioned consent text and its agreement with
 * the CMS. No browser, no network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createECDH } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  PUSH_PURPOSES,
  PUSH_TARGET_PATHS,
  TEKS_PERSETUJUAN,
  deteksiPlatform,
  iosMendukungPush,
  isCustomerPushEnabled,
  kunciSama,
  kunciServerKeBytes,
  parseCapability,
  parsePenanda,
  parseStatus,
  perangkatIni,
  petakanGalat,
  petakanGalatPeramban,
  teksPersetujuan,
  tentukanKeadaan,
  tujuanDitawarkan,
  type HasilMuat,
  type LingkunganPush,
  type PushCapability,
  type PushDevice,
  type PushStatus
} from "../src/lib/push-pelanggan";
import { TokoApiError } from "../src/lib/toko-permintaan";
import { APPLICATION_SERVER_KEY as STUB_SERVER_KEY, CONSENT_TEXT_VERSION as STUB_CONSENT_VERSION } from "../scripts/stub-push.mjs";

const VAPID = (() => {
  const curve = createECDH("prime256v1");
  curve.generateKeys();
  return curve.getPublicKey().toString("base64url");
})();

const IPHONE_17 = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const IPHONE_16_3 = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const IPHONE_16_4 = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const IPAD_AS_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36";
const DESKTOP = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36";

function env(over: Partial<LingkunganPush> = {}): LingkunganPush {
  return {
    userAgent: DESKTOP,
    maxTouchPoints: 0,
    displayModeStandalone: false,
    navigatorStandalone: undefined,
    secureContext: true,
    hasServiceWorker: true,
    hasPushManager: true,
    hasNotification: true,
    permission: "default",
    ...over
  };
}

function capability(over: Partial<PushCapability> = {}): PushCapability {
  return {
    enabled: true,
    reason: null,
    applicationServerKey: VAPID,
    purposes: [...PUSH_PURPOSES],
    consentTextVersion: "draft-2026-10",
    maxDevices: 5,
    ...over
  };
}

function device(over: Partial<PushDevice> = {}): PushDevice {
  return {
    id: "dev-1",
    endpointMasked: "fcm.googleapis.com/…abc123",
    userAgentSummary: "Chrome on Android (mobile)",
    lastSuccessAt: null,
    registeredAt: "2026-10-25T10:00:00.000Z",
    current: false,
    ...over
  };
}

function tersedia(over: { capability?: Partial<PushCapability>; devices?: PushDevice[] } = {}): HasilMuat {
  const status: PushStatus = {
    capability: capability(over.capability),
    preferences: [],
    devices: over.devices ?? []
  };
  return { jenis: "tersedia", status };
}

describe("the build flag", () => {
  const ORIGINAL = process.env.PUBLIC_CUSTOMER_PUSH;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PUBLIC_CUSTOMER_PUSH;
    else process.env.PUBLIC_CUSTOMER_PUSH = ORIGINAL;
  });

  test("off by default", () => {
    delete process.env.PUBLIC_CUSTOMER_PUSH;
    expect(isCustomerPushEnabled()).toBe(false);
  });

  test("only an explicit truthy value turns it on", () => {
    for (const on of ["1", "true", "TRUE", "on", "yes"]) {
      process.env.PUBLIC_CUSTOMER_PUSH = on;
      expect(isCustomerPushEnabled()).toBe(true);
    }
    for (const off of ["", "0", "false", "off", "no", "maybe"]) {
      process.env.PUBLIC_CUSTOMER_PUSH = off;
      expect(isCustomerPushEnabled()).toBe(false);
    }
  });
});

describe("parseStatus / parseCapability", () => {
  test("a well-formed answer parses; the raw endpoint is never part of a device", () => {
    const status = parseStatus({
      capability: {
        enabled: true,
        reason: null,
        applicationServerKey: VAPID,
        transports: ["web_push"],
        purposes: ["order_updates", "payment_updates", "support_replies"],
        consentTextVersion: "draft-2026-10",
        maxDevices: 5
      },
      preferences: [{ purpose: "order_updates", enabled: true, consentTextVersion: "draft-2026-10", grantedAt: "x", revokedAt: null }],
      devices: [
        {
          id: "d1",
          endpointMasked: "fcm.googleapis.com/…abc",
          userAgentSummary: "Chrome on Android (mobile)",
          status: "active",
          lastSuccessAt: null,
          registeredAt: "2026-10-25T00:00:00Z",
          current: true,
          endpoint: "https://fcm.googleapis.com/fcm/send/SECRET"
        }
      ]
    });
    expect(status?.capability.enabled).toBe(true);
    expect(status?.preferences).toEqual([{ purpose: "order_updates", enabled: true, consentTextVersion: "draft-2026-10" }]);
    expect(status?.devices).toHaveLength(1);
    expect(JSON.stringify(status)).not.toContain("SECRET");
  });

  test("a disabled capability keeps its reason and drops the key", () => {
    const off = parseCapability({
      enabled: false,
      reason: "origin_not_supported",
      applicationServerKey: VAPID,
      purposes: [],
      consentTextVersion: "v",
      maxDevices: 5
    });
    expect(off).toMatchObject({ enabled: false, reason: "origin_not_supported", applicationServerKey: null });
  });

  test("a disabled capability with an unknown reason is still disabled (never offered)", () => {
    const off = parseCapability({ enabled: false, reason: "something_new", consentTextVersion: "v" });
    expect(off?.enabled).toBe(false);
    expect(off?.reason).toBe("push_not_configured");
  });

  test("an unknown purpose (a future marketing) is dropped, never offered", () => {
    const cap = parseCapability({
      enabled: true,
      reason: null,
      applicationServerKey: VAPID,
      purposes: ["order_updates", "marketing"],
      consentTextVersion: "v",
      maxDevices: 5
    });
    expect(cap?.purposes).toEqual(["order_updates"]);
  });

  test("malformed bodies are not trusted", () => {
    expect(parseStatus(null)).toBeNull();
    expect(parseStatus({})).toBeNull();
    expect(parseStatus({ capability: { enabled: "yes" } })).toBeNull();
    expect(parseStatus({ capability: { enabled: true } })).toBeNull();
    expect(parseStatus("x")).toBeNull();
  });

  test("devices without an id or a masked endpoint are dropped", () => {
    const status = parseStatus({
      capability: { enabled: true, applicationServerKey: VAPID, purposes: [], consentTextVersion: "v", maxDevices: 5 },
      preferences: "nope",
      devices: [{ id: "", endpointMasked: "x", registeredAt: "t" }, { id: "ok", endpointMasked: "x", registeredAt: "t" }, 7]
    });
    expect(status?.devices.map((d) => d.id)).toEqual(["ok"]);
    expect(status?.preferences).toEqual([]);
  });
});

describe("the VAPID key", () => {
  test("a real P-256 key decodes to 65 bytes starting 0x04", () => {
    const bytes = kunciServerKeBytes(VAPID);
    expect(bytes?.length).toBe(65);
    expect(bytes?.[0]).toBe(0x04);
  });

  test("anything else is refused", () => {
    expect(kunciServerKeBytes("")).toBeNull();
    expect(kunciServerKeBytes("abc")).toBeNull();
    expect(kunciServerKeBytes("not base64 url!")).toBeNull();
    // 65 bytes but the wrong prefix
    const wrong = Buffer.concat([Buffer.from([0x03]), Buffer.alloc(64, 1)]).toString("base64url");
    expect(kunciServerKeBytes(wrong)).toBeNull();
  });

  test("kunciSama compares by value", () => {
    const bytes = kunciServerKeBytes(VAPID)!;
    expect(kunciSama(bytes.slice().buffer, bytes)).toBe(true);
    const other = bytes.slice();
    other[10] = (other[10] ?? 0) ^ 1;
    expect(kunciSama(other, bytes)).toBe(false);
    expect(kunciSama(null, bytes)).toBe(false);
    expect(kunciSama(new Uint8Array(3), bytes)).toBe(false);
  });
});

describe("deteksiPlatform (iOS)", () => {
  test("an iPhone Safari tab is iOS and not standalone", () => {
    const p = deteksiPlatform(env({ userAgent: IPHONE_17, navigatorStandalone: false }));
    expect(p).toMatchObject({ ios: true, standalone: false });
    expect(p.iosVersion).toEqual({ major: 17, minor: 4 });
  });

  test("navigator.standalone or display-mode: standalone means launched from the Home Screen", () => {
    expect(deteksiPlatform(env({ userAgent: IPHONE_17, navigatorStandalone: true })).standalone).toBe(true);
    expect(deteksiPlatform(env({ userAgent: ANDROID, displayModeStandalone: true })).standalone).toBe(true);
  });

  test("16.4 is the first iOS that can do Web Push", () => {
    expect(iosMendukungPush(deteksiPlatform(env({ userAgent: IPHONE_16_3 })))).toBe(false);
    expect(iosMendukungPush(deteksiPlatform(env({ userAgent: IPHONE_16_4 })))).toBe(true);
    expect(iosMendukungPush(deteksiPlatform(env({ userAgent: IPHONE_17 })))).toBe(true);
  });

  test("iPadOS reporting a Mac is iOS with an unknown version, and is not blocked on version", () => {
    const p = deteksiPlatform(env({ userAgent: IPAD_AS_MAC, maxTouchPoints: 5 }));
    expect(p.ios).toBe(true);
    expect(p.iosVersion).toBeNull();
    expect(iosMendukungPush(p)).toBe(true);
  });

  test("a desktop Mac and Android are not iOS", () => {
    expect(deteksiPlatform(env({ userAgent: IPAD_AS_MAC })).ios).toBe(false);
    expect(deteksiPlatform(env({ userAgent: ANDROID })).ios).toBe(false);
  });

  test("push support needs the service worker, the Push API and Notification together", () => {
    expect(deteksiPlatform(env()).pushDidukung).toBe(true);
    expect(deteksiPlatform(env({ hasServiceWorker: false })).pushDidukung).toBe(false);
    expect(deteksiPlatform(env({ hasPushManager: false })).pushDidukung).toBe(false);
    expect(deteksiPlatform(env({ hasNotification: false })).pushDidukung).toBe(false);
  });
});

describe("tentukanKeadaan - the screen state", () => {
  const desktop = deteksiPlatform(env());
  const base = { perangkatTersimpan: null, langgananAda: false };

  test("the server decides first: signed out, hidden (404), blocked, unverified, error", () => {
    for (const hasil of [
      { jenis: "memuat" },
      { jenis: "tamu" },
      { jenis: "disembunyikan" },
      { jenis: "diblokir" },
      { jenis: "belum_verifikasi" }
    ] as const) {
      expect(tentukanKeadaan({ ...base, hasil, platform: desktop }).jenis).toBe(hasil.jenis);
    }
    const galat = petakanGalat(new TokoApiError("x", 500, "INTERNAL"));
    expect(tentukanKeadaan({ ...base, hasil: { jenis: "galat", galat }, platform: desktop }).jenis).toBe("galat");
  });

  test("a disabled capability explains itself whatever the browser can do (even an iPhone tab)", () => {
    const iphoneTab = deteksiPlatform(env({ userAgent: IPHONE_17, hasPushManager: false }));
    for (const alasan of ["push_not_configured", "origin_not_supported"] as const) {
      const hasil = tersedia({ capability: { enabled: false, reason: alasan, applicationServerKey: null } });
      expect(tentukanKeadaan({ ...base, hasil, platform: iphoneTab })).toEqual({ jenis: "server_nonaktif", alasan });
    }
  });

  test("an unusable VAPID key is its own state, not a browser exception", () => {
    expect(tentukanKeadaan({ ...base, hasil: tersedia({ capability: { applicationServerKey: "short" } }), platform: desktop }).jenis).toBe(
      "kunci_rusak"
    );
    expect(tentukanKeadaan({ ...base, hasil: tersedia({ capability: { applicationServerKey: null } }), platform: desktop }).jenis).toBe(
      "kunci_rusak"
    );
  });

  test("iPhone Safari tab: install guide (16.4+); old iOS: update guide", () => {
    const tab = deteksiPlatform(env({ userAgent: IPHONE_17, navigatorStandalone: false, hasPushManager: false }));
    expect(tentukanKeadaan({ ...base, hasil: tersedia(), platform: tab }).jenis).toBe("ios_pasang");
    const old = deteksiPlatform(env({ userAgent: IPHONE_16_3, navigatorStandalone: false, hasPushManager: false }));
    expect(tentukanKeadaan({ ...base, hasil: tersedia(), platform: old }).jenis).toBe("ios_lama");
  });

  test("an installed iPhone app with the Push API gets the opt-in; without it (iOS < 16.4) the update guide", () => {
    const app = deteksiPlatform(env({ userAgent: IPHONE_17, navigatorStandalone: true }));
    expect(tentukanKeadaan({ ...base, hasil: tersedia(), platform: app }).jenis).toBe("siap");
    const oldApp = deteksiPlatform(env({ userAgent: IPHONE_16_3, navigatorStandalone: true, hasPushManager: false }));
    expect(tentukanKeadaan({ ...base, hasil: tersedia(), platform: oldApp }).jenis).toBe("ios_lama");
  });

  test("a web view / old browser without the Push API is unsupported", () => {
    const view = deteksiPlatform(env({ userAgent: ANDROID, hasPushManager: false }));
    expect(tentukanKeadaan({ ...base, hasil: tersedia(), platform: view }).jenis).toBe("tidak_didukung");
    const insecure = deteksiPlatform(env({ secureContext: false }));
    expect(tentukanKeadaan({ ...base, hasil: tersedia(), platform: insecure }).jenis).toBe("tidak_didukung");
  });

  test("permission denied explains how to re-enable (the page cannot)", () => {
    const denied = deteksiPlatform(env({ permission: "denied" }));
    expect(tentukanKeadaan({ ...base, hasil: tersedia(), platform: denied }).jenis).toBe("izin_ditolak");
  });

  test("permission default or granted-but-not-enrolled offers the opt-in", () => {
    expect(tentukanKeadaan({ ...base, hasil: tersedia(), platform: deteksiPlatform(env({ permission: "default" })) }).jenis).toBe("siap");
    expect(tentukanKeadaan({ ...base, hasil: tersedia(), platform: deteksiPlatform(env({ permission: "granted" })) }).jenis).toBe("siap");
  });

  test("enrolled needs a granted permission, a live subscription AND this browser's device on the server", () => {
    const granted = deteksiPlatform(env({ permission: "granted" }));
    const mine = tersedia({ devices: [device({ id: "dev-1", current: true })] });

    expect(tentukanKeadaan({ hasil: mine, platform: granted, perangkatTersimpan: "dev-1", langgananAda: true }).jenis).toBe("aktif");
    // the device is listed but this browser has no subscription any more
    expect(tentukanKeadaan({ hasil: mine, platform: granted, perangkatTersimpan: "dev-1", langgananAda: false }).jenis).toBe("siap");
    // a subscription exists but the server lists no device of this browser
    expect(tentukanKeadaan({ hasil: tersedia(), platform: granted, perangkatTersimpan: "dev-1", langgananAda: true }).jenis).toBe("siap");
    // another browser's device is not this one
    const other = tersedia({ devices: [device({ id: "dev-2", current: false })] });
    expect(tentukanKeadaan({ hasil: other, platform: granted, perangkatTersimpan: null, langgananAda: true }).jenis).toBe("siap");
    // the marker alone identifies it when the session differs
    expect(tentukanKeadaan({ hasil: other, platform: granted, perangkatTersimpan: "dev-2", langgananAda: true }).jenis).toBe("aktif");
  });

  test("perangkatIni marks the current session's device or the remembered id", () => {
    expect(perangkatIni(device({ current: true }), null)).toBe(true);
    expect(perangkatIni(device({ id: "x" }), "x")).toBe(true);
    expect(perangkatIni(device({ id: "x" }), "y")).toBe(false);
    expect(perangkatIni(device({ id: "x" }), null)).toBe(false);
  });
});

describe("petakanGalat - every code ADR-0048 section 6 can answer", () => {
  const api = (status: number, code: string, details?: unknown) => new TokoApiError("English operator message", status, code, details);

  const cases: Array<[string, TokoApiError, string]> = [
    ["404 neutral (flag off)", api(404, "NOT_FOUND"), "sembunyikan"],
    ["401", api(401, "UNAUTHENTICATED"), "masuk_ulang"],
    ["403 ACCOUNT_BLOCKED", api(403, "ACCOUNT_BLOCKED"), "tidak_ada"],
    ["403 ACCOUNT_NOT_VERIFIED", api(403, "ACCOUNT_NOT_VERIFIED"), "tidak_ada"],
    ["409 PUSH_UNAVAILABLE", api(409, "PUSH_UNAVAILABLE"), "tidak_ada"],
    ["409 DEVICE_LIMIT", api(409, "DEVICE_LIMIT"), "hapus_perangkat"],
    ["422 ENDPOINT_NOT_ALLOWED", api(422, "ENDPOINT_NOT_ALLOWED"), "tidak_ada"],
    ["422 ORIGIN_NOT_ALLOWED", api(422, "ORIGIN_NOT_ALLOWED"), "tidak_ada"],
    ["413", api(413, "PAYLOAD_TOO_LARGE"), "muat_ulang"],
    ["415", api(415, "UNSUPPORTED_MEDIA_TYPE"), "muat_ulang"],
    ["429", api(429, "RATE_LIMITED"), "coba_lagi"],
    ["400 VALIDATION_ERROR", api(400, "VALIDATION_ERROR", [{ field: "endpoint", message: "bad" }]), "muat_ulang"],
    ["network", api(0, "NETWORK_ERROR"), "coba_lagi"],
    ["unreadable body", api(200, "INVALID_RESPONSE"), "coba_lagi"],
    ["500", api(500, "INTERNAL_ERROR"), "coba_lagi"]
  ];

  for (const [name, error, tindakan] of cases) {
    test(`${name} -> ${tindakan}, in Indonesian, never the server's English message`, () => {
      const galat = petakanGalat(error);
      expect(galat.tindakan).toBe(tindakan as typeof galat.tindakan);
      expect(galat.pesan.length).toBeGreaterThan(10);
      expect(galat.pesan).not.toContain("English operator message");
      expect(galat.kode).toBeTruthy();
    });
  }

  test("DEVICE_LIMIT names the limit it was told", () => {
    expect(petakanGalat(api(409, "DEVICE_LIMIT"), { maxDevices: 5 }).pesan).toContain("5");
    expect(petakanGalat(api(409, "DEVICE_LIMIT"), { maxDevices: 3 }).pesan).toContain("3");
  });

  test("429 with a readable Retry-After says how long", () => {
    const short = petakanGalat(api(429, "RATE_LIMITED", { retryAfter: 42 }));
    expect(short.tunggu).toBe(42);
    expect(short.pesan).toContain("42 detik");
    const long = petakanGalat(api(429, "RATE_LIMITED", { retryAfter: 600 }));
    expect(long.pesan).toContain("10 menit");
    const unknown = petakanGalat(api(429, "RATE_LIMITED"));
    expect(unknown.tunggu).toBeNull();
    expect(unknown.pesan).toContain("beberapa saat");
  });

  test("a stale consent text version asks for a reload; other validation errors too but with other words", () => {
    const stale = petakanGalat(api(422, "VALIDATION_ERROR", [{ field: "consent.textVersion", message: "x" }]));
    expect(stale.pesan).toContain("Teks persetujuan");
    const stalePut = petakanGalat(api(422, "VALIDATION_ERROR", [{ field: "textVersion", message: "x" }]));
    expect(stalePut.pesan).toContain("Teks persetujuan");
    const other = petakanGalat(api(400, "VALIDATION_ERROR", [{ field: "endpoint", message: "x" }]));
    expect(other.pesan).not.toContain("Teks persetujuan");
  });

  test("a non-API error is a generic retry", () => {
    expect(petakanGalat(new Error("boom")).tindakan).toBe("coba_lagi");
    expect(petakanGalat("x").kode).toBe("UNKNOWN");
  });

  test("browser stack failures", () => {
    expect(petakanGalatPeramban({ name: "NotAllowedError" }).kode).toBe("PERMISSION_DENIED");
    expect(petakanGalatPeramban(Object.assign(new Error("push service error"), { name: "AbortError" })).kode).toBe("PUSH_SERVICE_ERROR");
    expect(petakanGalatPeramban({ name: "SecurityError" }).kode).toBe("SECURITY_ERROR");
    expect(petakanGalatPeramban(new TypeError("x")).kode).toBe("BROWSER_ERROR");
    expect(petakanGalatPeramban(undefined).kode).toBe("BROWSER_ERROR");
  });
});

describe("the versioned consent text", () => {
  test("the version the CMS publishes has a text in this page", () => {
    const cmsFile = new URL("../../cms/src/modules/commerce/domain/customer-push.ts", import.meta.url).pathname;
    if (!existsSync(cmsFile)) return; // a checkout without apps/cms cannot compare
    const source = readFileSync(cmsFile, "utf8");
    const version = /CUSTOMER_PUSH_CONSENT_TEXT_VERSION\s*=\s*"([^"]+)"/.exec(source)?.[1];
    expect(version).toBeTruthy();
    expect(teksPersetujuan(version!)).not.toBeNull();
  });

  test("the purposes and fixed paths agree with the CMS's closed lists (ADR-0048 section 6.5)", () => {
    const cmsFile = new URL("../../cms/src/modules/commerce/domain/customer-push.ts", import.meta.url).pathname;
    if (!existsSync(cmsFile)) return;
    const source = readFileSync(cmsFile, "utf8");

    const list = /CUSTOMER_PUSH_TRANSACTIONAL_PURPOSES\s*=\s*\[([^\]]+)\]/.exec(source)?.[1] ?? "";
    const cmsPurposes = [...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);
    expect([...PUSH_PURPOSES] as string[]).toEqual(cmsPurposes);

    for (const purpose of PUSH_PURPOSES) {
      const path = new RegExp(`${purpose}:\\s*"([^"]+)"`).exec(source.slice(source.indexOf("CUSTOMER_PUSH_TARGET_PATHS")))?.[1];
      expect(PUSH_TARGET_PATHS[purpose]).toBe(path ?? "<missing>");
    }
  });

  test("the stub publishes the same version and a key shape the page accepts", () => {
    expect(teksPersetujuan(STUB_CONSENT_VERSION)).not.toBeNull();
    expect(kunciServerKeBytes(STUB_SERVER_KEY)).not.toBeNull();
  });

  test("an unknown version has no text (the page then refuses to enrol)", () => {
    expect(teksPersetujuan("draft-2099-01")).toBeNull();
    expect(teksPersetujuan("__proto__")).toBeNull();
    expect(teksPersetujuan("constructor")).toBeNull();
  });

  test("every text describes exactly the three transactional purposes - never marketing", () => {
    for (const teks of Object.values(TEKS_PERSETUJUAN)) {
      expect(Object.keys(teks.tujuan).sort()).toEqual([...PUSH_PURPOSES].sort());
      const semua = JSON.stringify([teks.tujuan, teks.paragraf("Toko Contoh")]);
      expect(semua).not.toMatch(/marketing/i);
    }
  });

  test("the text says what ADR-0048 section 7 requires, keyed by the store name", () => {
    const paragraf = teksPersetujuan("draft-2026-10")!.paragraf("Toko Contoh").join("\n");
    expect(paragraf).toContain("Toko Contoh");
    expect(paragraf).toMatch(/layar kunci/i); // lock screen shows generic text
    expect(paragraf).toMatch(/terenkripsi/i); // encrypted through the vendor's push service
    expect(paragraf).toMatch(/Google, Apple, Mozilla/); // which vendors
    expect(paragraf).toMatch(/mematikan/i); // how to turn it off
    expect(paragraf).toMatch(/tidak bisa mencabutnya/i); // the page cannot revoke the browser permission
    expect(paragraf).toMatch(/tidak mengirim promosi/i); // marketing out of v1
    expect(paragraf).toMatch(/tidak mencatat/i); // no click tracking
    expect(paragraf).toMatch(/30 hari/); // session lifetime rule
  });

  test("the offered purposes are the server's list intersected with the text, in the text's order", () => {
    const teks = teksPersetujuan("draft-2026-10")!;
    expect(tujuanDitawarkan(capability(), teks)).toEqual([...PUSH_PURPOSES]);
    expect(tujuanDitawarkan(capability({ purposes: ["support_replies", "order_updates"] }), teks)).toEqual([
      "order_updates",
      "support_replies"
    ]);
    expect(tujuanDitawarkan(capability({ purposes: [] }), teks)).toEqual([] as typeof PUSH_PURPOSES[number][]);
  });
});

describe("parsePenanda", () => {
  test("round-trips a marker and refuses anything else", () => {
    expect(parsePenanda(JSON.stringify({ deviceId: "d", accountId: "a", at: "t" }))).toEqual({ deviceId: "d", accountId: "a", at: "t" });
    expect(parsePenanda(null)).toBeNull();
    expect(parsePenanda("")).toBeNull();
    expect(parsePenanda("{")).toBeNull();
    expect(parsePenanda(JSON.stringify({ deviceId: "d" }))).toBeNull();
    expect(parsePenanda(JSON.stringify([1]))).toBeNull();
  });

  test("the marker shape has no token, endpoint or key field", () => {
    const penanda = parsePenanda(
      JSON.stringify({ deviceId: "d", accountId: "a", at: "t", token: "cs_secret", endpoint: "https://x", keys: { auth: "y" } })
    );
    expect(Object.keys(penanda!).sort()).toEqual(["accountId", "at", "deviceId"]);
  });
});
