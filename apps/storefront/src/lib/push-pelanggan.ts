/**
 * Customer Web Push on the storefront - the pure contract (issue #431,
 * ADR-0048 section 7). No `window`, no `navigator`, no network: this file is
 * unit-testable under `bun test` and is imported by the browser-bound modules
 * (`push-alur.ts`, `src/scripts/akun-notifikasi*.ts`) and by the build-time
 * integration. It holds:
 *
 *  - the shapes of what `GET .../account/push/subscriptions` returns, parsed
 *    defensively (a malformed body is "not available", never trusted);
 *  - the browser/platform facts and the ONE function that turns server answer
 *    plus browser facts into a screen state (`tentukanKeadaan`);
 *  - the error vocabulary: every code ADR-0048 section 6 can answer, mapped to
 *    a plain Indonesian sentence and a next action (`petakanGalat`);
 *  - the versioned consent text (draft; counsel's review is a production gate
 *    of the `customerPush` flag, ADR-0048 Q8/D8).
 *
 * The build flag and why it exists next to the server's own `customerPush`
 * flag: `push-konfig.ts`.
 */
import { TokoApiError } from "./toko-permintaan";

// ---------------------------------------------------------------------------
// Build flag, fixed paths, storage keys: `push-konfig.ts` (re-exported here so
// browser modules have one import; the build-time integration imports the small
// file directly and never pulls the error vocabulary below into the config).
// ---------------------------------------------------------------------------

export {
  PUSH_MARKER_KEY,
  PUSH_NOTICE_KEY,
  PUSH_SETTINGS_PATH,
  PUSH_WORKER_PATH,
  PUSH_WORKER_SCOPE,
  isCustomerPushEnabled
} from "./push-konfig";

// ---------------------------------------------------------------------------
// Purposes (the closed transactional list; `marketing` is reserved, never offered)
// ---------------------------------------------------------------------------

export const PUSH_PURPOSES = ["order_updates", "payment_updates", "support_replies"] as const;
export type PushPurpose = (typeof PUSH_PURPOSES)[number];

export function isPushPurpose(value: unknown): value is PushPurpose {
  return typeof value === "string" && (PUSH_PURPOSES as readonly string[]).includes(value);
}

/** The fixed storefront path a notification of each purpose opens (ADR-0048 section 6.5). The worker carries the same allow-list; `tests/push-pekerja.test.ts` pins that the two agree. */
export const PUSH_TARGET_PATHS: Readonly<Record<PushPurpose, string>> = {
  order_updates: "/akun/pesanan",
  payment_updates: "/akun/pesanan",
  support_replies: "/akun/pesan"
};

// ---------------------------------------------------------------------------
// What the server tells the page
// ---------------------------------------------------------------------------

export type PushCapability = {
  enabled: boolean;
  reason: null | "push_not_configured" | "origin_not_supported";
  applicationServerKey: string | null;
  purposes: PushPurpose[];
  consentTextVersion: string;
  maxDevices: number;
};

export type PushPreference = {
  purpose: PushPurpose;
  enabled: boolean;
  consentTextVersion: string | null;
};

export type PushDevice = {
  id: string;
  endpointMasked: string;
  userAgentSummary: string | null;
  lastSuccessAt: string | null;
  registeredAt: string;
  current: boolean;
};

export type PushStatus = {
  capability: PushCapability;
  preferences: PushPreference[];
  devices: PushDevice[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Parses the `capability` object; `null` for anything that is not a well-shaped answer. Unknown purposes (for example a future `marketing`) are dropped, never offered. */
export function parseCapability(value: unknown): PushCapability | null {
  if (!isRecord(value)) return null;
  if (typeof value.enabled !== "boolean") return null;
  if (typeof value.consentTextVersion !== "string" || value.consentTextVersion.length === 0) return null;

  const reason =
    value.reason === "push_not_configured" || value.reason === "origin_not_supported" ? value.reason : null;
  if (!value.enabled && reason === null) {
    // Disabled without a reason we know: still disabled, reported as not configured.
    return {
      enabled: false,
      reason: "push_not_configured",
      applicationServerKey: null,
      purposes: [],
      consentTextVersion: value.consentTextVersion,
      maxDevices: typeof value.maxDevices === "number" ? value.maxDevices : 5
    };
  }

  const purposes = Array.isArray(value.purposes) ? value.purposes.filter(isPushPurpose) : [];
  return {
    enabled: value.enabled,
    reason: value.enabled ? null : reason,
    applicationServerKey: value.enabled ? stringOrNull(value.applicationServerKey) : null,
    purposes,
    consentTextVersion: value.consentTextVersion,
    maxDevices:
      typeof value.maxDevices === "number" && Number.isFinite(value.maxDevices) && value.maxDevices > 0
        ? Math.floor(value.maxDevices)
        : 5
  };
}

export function parsePreferences(value: unknown): PushPreference[] {
  if (!Array.isArray(value)) return [];
  const result: PushPreference[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isPushPurpose(entry.purpose)) continue;
    result.push({
      purpose: entry.purpose,
      enabled: entry.enabled === true,
      consentTextVersion: stringOrNull(entry.consentTextVersion)
    });
  }
  return result;
}

export function parseDevice(value: unknown): PushDevice | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || value.id.length === 0) return null;
  if (typeof value.endpointMasked !== "string") return null;
  if (typeof value.registeredAt !== "string") return null;
  return {
    id: value.id,
    endpointMasked: value.endpointMasked,
    userAgentSummary: stringOrNull(value.userAgentSummary),
    lastSuccessAt: stringOrNull(value.lastSuccessAt),
    registeredAt: value.registeredAt,
    current: value.current === true
  };
}

export function parseDevices(value: unknown): PushDevice[] {
  if (!Array.isArray(value)) return [];
  return value.map(parseDevice).filter((device): device is PushDevice => device !== null);
}

/** The whole `GET .../subscriptions` body, or `null` when the capability itself is unreadable. */
export function parseStatus(value: unknown): PushStatus | null {
  if (!isRecord(value)) return null;
  const capability = parseCapability(value.capability);
  if (!capability) return null;
  return { capability, preferences: parsePreferences(value.preferences), devices: parseDevices(value.devices) };
}

/** What `POST .../subscriptions` answers: the device and the preferences it left behind. */
export function parseRegistrasi(value: unknown): { device: PushDevice; preferences: PushPreference[] } | null {
  if (!isRecord(value)) return null;
  const device = parseDevice(value.device);
  if (!device) return null;
  return { device, preferences: parsePreferences(value.preferences) };
}

// ---------------------------------------------------------------------------
// The VAPID key
// ---------------------------------------------------------------------------

/**
 * `applicationServerKey` arrives as unpadded base64url; `PushManager.subscribe`
 * wants bytes. A valid P-256 public key is 65 bytes and starts with `0x04`;
 * anything else is refused here so a corrupt key surfaces as "not available"
 * rather than as an opaque browser exception.
 */
export function kunciServerKeBytes(key: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return null;
  const padded = key.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (key.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.length === 65 && bytes[0] === 0x04 ? bytes : null;
}

/** True when `existing` (a browser subscription's key) is the key the server now publishes - a VAPID rotation makes it false and the page re-subscribes. */
export function kunciSama(existing: ArrayBuffer | Uint8Array | null | undefined, expected: Uint8Array): boolean {
  if (!existing) return false;
  const bytes = existing instanceof Uint8Array ? existing : new Uint8Array(existing);
  if (bytes.length !== expected.length) return false;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== expected[index]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The browser, as the page sees it
// ---------------------------------------------------------------------------

/** Everything detection needs, injectable so the unit test never touches a DOM. */
export type LingkunganPush = {
  userAgent: string;
  maxTouchPoints: number;
  displayModeStandalone: boolean;
  navigatorStandalone: boolean | undefined;
  secureContext: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  permission: NotificationPermission;
};

export type PlatformPush = {
  ios: boolean;
  /** `null` when the user agent does not say (iPadOS pretending to be a Mac, or not iOS). */
  iosVersion: { major: number; minor: number } | null;
  standalone: boolean;
  /** Service worker, Push API and Notification API are all present. */
  pushDidukung: boolean;
  permission: NotificationPermission;
  secureContext: boolean;
};

export function deteksiPlatform(env: LingkunganPush): PlatformPush {
  const iosUa = /iPhone|iPad|iPod/.test(env.userAgent);
  const ipadOs = /Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1;
  const version = /OS (\d+)[_.](\d+)/.exec(env.userAgent);

  return {
    ios: iosUa || ipadOs,
    iosVersion: iosUa && version ? { major: Number(version[1]), minor: Number(version[2]) } : null,
    standalone: env.displayModeStandalone || env.navigatorStandalone === true,
    pushDidukung: env.hasServiceWorker && env.hasPushManager && env.hasNotification,
    permission: env.hasNotification ? env.permission : "denied",
    secureContext: env.secureContext
  };
}

/** Web Push on iOS and iPadOS needs 16.4 or later. */
export function iosMendukungPush(platform: PlatformPush): boolean {
  if (!platform.ios || platform.iosVersion === null) return true;
  const { major, minor } = platform.iosVersion;
  return major > 16 || (major === 16 && minor >= 4);
}

// ---------------------------------------------------------------------------
// The screen state
// ---------------------------------------------------------------------------

export type HasilMuat =
  | { jenis: "memuat" }
  /** No stored session. */
  | { jenis: "tamu" }
  /** The neutral 404: flag off, unresolvable tenant, refused origin. The control is hidden. */
  | { jenis: "disembunyikan" }
  | { jenis: "diblokir" }
  | { jenis: "belum_verifikasi" }
  | { jenis: "galat"; galat: GalatPush }
  | { jenis: "tersedia"; status: PushStatus };

export type KeadaanPush =
  | { jenis: "memuat" }
  | { jenis: "tamu" }
  | { jenis: "disembunyikan" }
  | { jenis: "diblokir" }
  | { jenis: "belum_verifikasi" }
  | { jenis: "galat"; galat: GalatPush }
  | { jenis: "server_nonaktif"; alasan: "push_not_configured" | "origin_not_supported" }
  | { jenis: "kunci_rusak" }
  | { jenis: "tidak_didukung" }
  | { jenis: "ios_pasang" }
  | { jenis: "ios_lama" }
  | { jenis: "izin_ditolak" }
  | { jenis: "siap" }
  | { jenis: "aktif" };

/**
 * Server answer + browser facts -> the one state the page renders.
 *
 * Order matters and is the ADR's (section 7): the server decides first (a
 * disabled capability hides or explains the control whatever the browser can
 * do), then what only the browser knows. `aktif` needs all three of: a
 * granted permission, a live browser subscription, and a server device that
 * is this browser's. Anything less is `siap` (offer the opt-in; if the
 * permission is already granted the browser asks nothing more).
 */
export function tentukanKeadaan(input: {
  hasil: HasilMuat;
  platform: PlatformPush;
  /** The id stored in the enrolment marker, if any. */
  perangkatTersimpan: string | null;
  /** Whether the browser holds a push subscription right now. */
  langgananAda: boolean;
}): KeadaanPush {
  const { hasil, platform } = input;

  if (hasil.jenis !== "tersedia") return hasil;

  const { capability, devices } = hasil.status;
  if (!capability.enabled) {
    return { jenis: "server_nonaktif", alasan: capability.reason ?? "push_not_configured" };
  }
  if (capability.applicationServerKey === null || kunciServerKeBytes(capability.applicationServerKey) === null) {
    return { jenis: "kunci_rusak" };
  }

  if (!platform.secureContext) return { jenis: "tidak_didukung" };
  if (platform.ios && !platform.standalone) {
    return iosMendukungPush(platform) ? { jenis: "ios_pasang" } : { jenis: "ios_lama" };
  }
  if (!platform.pushDidukung) {
    return platform.ios && !iosMendukungPush(platform) ? { jenis: "ios_lama" } : { jenis: "tidak_didukung" };
  }
  if (platform.permission === "denied") return { jenis: "izin_ditolak" };

  const perangkatIni = devices.some(
    (device) => device.current || (input.perangkatTersimpan !== null && device.id === input.perangkatTersimpan)
  );
  if (platform.permission === "granted" && input.langgananAda && perangkatIni) return { jenis: "aktif" };
  return { jenis: "siap" };
}

/** Whether `device` is this browser's: the session that enrolled it is the caller's, or its id is the one the marker remembers. */
export function perangkatIni(device: PushDevice, perangkatTersimpan: string | null): boolean {
  return device.current || (perangkatTersimpan !== null && device.id === perangkatTersimpan);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type TindakanGalat =
  /** The control must not be shown (neutral 404). */
  | "sembunyikan"
  /** The session is gone: send the shopper to sign in. */
  | "masuk_ulang"
  | "coba_lagi"
  /** Device limit: the device list is the way forward. */
  | "hapus_perangkat"
  /** The page is stale (consent text version): reload it. */
  | "muat_ulang"
  | "tidak_ada";

export type GalatPush = {
  kode: string;
  pesan: string;
  tindakan: TindakanGalat;
  /** Seconds to wait (429), when the browser could read `Retry-After`. */
  tunggu: number | null;
};

function lamaTunggu(detik: number | null): string {
  if (detik === null || detik <= 0) return "beberapa saat lagi";
  if (detik < 90) return `${detik} detik lagi`;
  return `${Math.ceil(detik / 60)} menit lagi`;
}

/**
 * Every failure the push routes can produce (ADR-0048 section 6.1/7), as a
 * sentence the shopper can act on. The server's own `message` is never shown:
 * it is English, written for operators, and may name internals. The mapping is
 * by `code` first (the contract is defined in codes, as `toko-permintaan.ts`
 * says), then by status for the ones that have no dedicated code.
 */
export function petakanGalat(error: unknown, konteks: { maxDevices?: number } = {}): GalatPush {
  if (!(error instanceof TokoApiError)) {
    return {
      kode: "UNKNOWN",
      pesan: "Terjadi kesalahan yang tidak terduga. Coba lagi.",
      tindakan: "coba_lagi",
      tunggu: null
    };
  }

  const { code, status } = error;
  const batas = konteks.maxDevices ?? 5;

  switch (code) {
    case "NETWORK_ERROR":
      return {
        kode: code,
        pesan: "Tidak bisa terhubung ke toko. Periksa koneksi internet Anda, lalu coba lagi.",
        tindakan: "coba_lagi",
        tunggu: null
      };
    case "UNAUTHENTICATED":
      return {
        kode: code,
        pesan: "Sesi masuk Anda sudah berakhir. Masuk lagi untuk mengatur notifikasi.",
        tindakan: "masuk_ulang",
        tunggu: null
      };
    case "ACCOUNT_BLOCKED":
      return {
        kode: code,
        pesan: "Akun Anda sedang diblokir, sehingga notifikasi tidak bisa diaktifkan. Hubungi toko untuk bantuan.",
        tindakan: "tidak_ada",
        tunggu: null
      };
    case "ACCOUNT_NOT_VERIFIED":
      return {
        kode: code,
        pesan: "Verifikasi alamat e-mail Anda terlebih dahulu sebelum mengaktifkan notifikasi.",
        tindakan: "tidak_ada",
        tunggu: null
      };
    case "PUSH_UNAVAILABLE":
      return {
        kode: code,
        pesan: "Notifikasi sedang tidak tersedia di toko ini. Anda tetap bisa melihat pembaruan di kotak pesan dan halaman pesanan.",
        tindakan: "tidak_ada",
        tunggu: null
      };
    case "DEVICE_LIMIT":
      return {
        kode: code,
        pesan: `Anda sudah memakai ${batas} perangkat, batas maksimum. Hapus salah satu perangkat di daftar di bawah, lalu aktifkan lagi.`,
        tindakan: "hapus_perangkat",
        tunggu: null
      };
    case "ENDPOINT_NOT_ALLOWED":
      return {
        kode: code,
        pesan: "Layanan notifikasi pada browser ini belum didukung. Gunakan Chrome, Edge, Firefox, atau Safari versi terbaru.",
        tindakan: "tidak_ada",
        tunggu: null
      };
    case "ORIGIN_NOT_ALLOWED":
      return {
        kode: code,
        pesan: "Notifikasi hanya bisa diaktifkan dari alamat resmi toko ini. Buka toko dari alamat utamanya, lalu coba lagi.",
        tindakan: "tidak_ada",
        tunggu: null
      };
    case "PAYLOAD_TOO_LARGE":
    case "UNSUPPORTED_MEDIA_TYPE":
      return {
        kode: code,
        pesan: "Permintaan tidak bisa diproses oleh toko. Muat ulang halaman ini, lalu coba lagi.",
        tindakan: "muat_ulang",
        tunggu: null
      };
    case "RATE_LIMITED": {
      const tunggu = error.retryAfterSeconds;
      return {
        kode: code,
        pesan: `Terlalu banyak percobaan. Coba lagi ${lamaTunggu(tunggu)}.`,
        tindakan: "coba_lagi",
        tunggu
      };
    }
    case "VALIDATION_ERROR": {
      const kenaVersi = error.fieldErrors.some(
        (entry) => entry.field === "textVersion" || entry.field.startsWith("consent")
      );
      return kenaVersi
        ? {
            kode: code,
            pesan: "Teks persetujuan di halaman ini sudah diperbarui. Muat ulang halaman, baca teksnya, lalu pilih lagi.",
            tindakan: "muat_ulang",
            tunggu: null
          }
        : {
            kode: code,
            pesan: "Data notifikasi tidak valid. Muat ulang halaman ini, lalu coba lagi.",
            tindakan: "muat_ulang",
            tunggu: null
          };
    }
    default:
      break;
  }

  if (status === 404) {
    return { kode: "NOT_FOUND", pesan: "Notifikasi tidak tersedia di toko ini.", tindakan: "sembunyikan", tunggu: null };
  }
  if (status === 429) {
    return {
      kode: "RATE_LIMITED",
      pesan: "Terlalu banyak percobaan. Coba lagi beberapa saat lagi.",
      tindakan: "coba_lagi",
      tunggu: null
    };
  }
  return {
    kode: code,
    pesan: "Toko sedang mengalami gangguan. Coba lagi beberapa saat lagi.",
    tindakan: "coba_lagi",
    tunggu: null
  };
}

/** A failure raised by the browser's own push stack (permission, service worker, `subscribe`), not by the store's API. */
export function petakanGalatPeramban(error: unknown): GalatPush {
  const nama = error instanceof Error || (typeof error === "object" && error !== null && "name" in error)
    ? String((error as { name?: unknown }).name ?? "")
    : "";

  if (nama === "NotAllowedError") {
    return {
      kode: "PERMISSION_DENIED",
      pesan: "Izin notifikasi tidak diberikan. Anda bisa mengubahnya lewat pengaturan browser atau perangkat.",
      tindakan: "tidak_ada",
      tunggu: null
    };
  }
  if (nama === "AbortError" || nama === "InvalidStateError" || nama === "NetworkError") {
    return {
      kode: "PUSH_SERVICE_ERROR",
      pesan: "Layanan notifikasi pada browser ini sedang tidak bisa dihubungi. Coba lagi beberapa saat lagi.",
      tindakan: "coba_lagi",
      tunggu: null
    };
  }
  if (nama === "SecurityError") {
    return {
      kode: "SECURITY_ERROR",
      pesan: "Browser menolak mengaktifkan notifikasi di halaman ini. Pastikan Anda membuka situs lewat HTTPS.",
      tindakan: "tidak_ada",
      tunggu: null
    };
  }
  return {
    kode: "BROWSER_ERROR",
    pesan: "Browser ini tidak bisa mengaktifkan notifikasi. Coba lagi, atau gunakan browser lain.",
    tindakan: "coba_lagi",
    tunggu: null
  };
}

// ---------------------------------------------------------------------------
// The consent text (versioned DRAFT)
// ---------------------------------------------------------------------------

export type DeskripsiTujuan = { label: string; deskripsi: string };

export type TeksPersetujuan = {
  version: string;
  tujuan: Record<PushPurpose, DeskripsiTujuan>;
  paragraf: (namaToko: string) => string[];
};

/**
 * THE consent wording, by version. The server publishes the version it will
 * accept (`capability.consentTextVersion`) and refuses a registration that
 * names any other (ADR-0048 section 6.1). The page may therefore show a text
 * only if it has THAT version: an unknown version means the page is older (or
 * newer) than the server, and the page refuses to enrol rather than record a
 * grant against wording the shopper never saw.
 *
 * Changing a word of a text means a NEW key here and the same new value in
 * `CUSTOMER_PUSH_CONSENT_TEXT_VERSION` (`apps/cms/.../domain/customer-push.ts`);
 * `tests/push-pelanggan.test.ts` fails when the CMS's current version has no
 * text. This is a DRAFT (Indonesian first); counsel's review is a production
 * gate of the `customerPush` flag (ADR-0048 Q8/D8), recorded by the operator.
 */
export const TEKS_PERSETUJUAN: Readonly<Record<string, TeksPersetujuan>> = {
  "draft-2026-10": {
    version: "draft-2026-10",
    tujuan: {
      order_updates: {
        label: "Pembaruan pesanan",
        deskripsi: "Pesanan Anda diproses, dikirim, selesai, atau dibatalkan, dan barang retur diterima."
      },
      payment_updates: {
        label: "Pembaruan pembayaran",
        deskripsi: "Pembayaran diterima, batas waktu pembayaran habis, atau pengembalian dana selesai."
      },
      support_replies: {
        label: "Balasan dari toko",
        deskripsi: "Ada pesan baru dari toko di kotak pesan Anda."
      }
    },
    paragraf: (namaToko) => [
      `Jika Anda mengaktifkan notifikasi, ${namaToko} mengirim pemberitahuan singkat ke perangkat ini hanya untuk jenis yang Anda pilih di bawah. Tidak ada jenis yang aktif sebelum Anda memilihnya sendiri.`,
      "Layar kunci hanya menampilkan teks umum, misalnya \"Pesanan Anda ada pembaruan\". Kode pesanan, jumlah, nama, dan alamat tidak pernah dikirim lewat notifikasi; rinciannya baru terlihat di akun Anda setelah Anda masuk.",
      "Isi pemberitahuan dikirim terenkripsi lewat layanan notifikasi dari pembuat browser Anda (misalnya Google, Apple, Mozilla, atau Microsoft). Layanan itu tetap mengetahui bahwa ada pemberitahuan untuk perangkat ini, tetapi tidak bisa membaca isinya.",
      "Kami tidak mengirim promosi lewat notifikasi dan tidak mencatat apakah Anda membuka sebuah notifikasi.",
      "Anda bisa mematikan tiap jenis, atau menghapus perangkat, kapan saja di halaman ini. Izin notifikasi di browser hanya bisa dicabut dari pengaturan browser atau perangkat Anda; halaman ini tidak bisa mencabutnya.",
      "Notifikasi berhenti sendiri jika sesi masuk Anda berakhir (sekitar 30 hari tanpa dipakai). Anda tinggal mengaktifkannya lagi dengan satu ketukan."
    ]
  }
};

/** The text for `version`, or `null` when this page does not know it. */
export function teksPersetujuan(version: string): TeksPersetujuan | null {
  return Object.hasOwn(TEKS_PERSETUJUAN, version) ? (TEKS_PERSETUJUAN[version] ?? null) : null;
}

/** The purposes the page may offer: the intersection of what the server lists and what the shown text describes, in the text's order. */
export function tujuanDitawarkan(capability: PushCapability, teks: TeksPersetujuan): PushPurpose[] {
  return PUSH_PURPOSES.filter((purpose) => capability.purposes.includes(purpose) && purpose in teks.tujuan);
}

// ---------------------------------------------------------------------------
// The enrolment marker
// ---------------------------------------------------------------------------

export type PenandaPush = { deviceId: string; accountId: string; at: string };

/** Parses the stored marker; `null` for anything not exactly this shape. Pure, so the logout tests need no `localStorage`. */
export function parsePenanda(raw: string | null | undefined): PenandaPush | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (typeof parsed.deviceId !== "string" || parsed.deviceId.length === 0) return null;
  if (typeof parsed.accountId !== "string" || parsed.accountId.length === 0) return null;
  return { deviceId: parsed.deviceId, accountId: parsed.accountId, at: typeof parsed.at === "string" ? parsed.at : "" };
}

/** The notices the settings page can show once, after a flow that had to finish without the server's confirmation. */
export type PemberitahuanPush = "sesi_lama_belum_terkonfirmasi";

export const PESAN_PEMBERITAHUAN: Readonly<Record<PemberitahuanPush, string>> = {
  sesi_lama_belum_terkonfirmasi:
    "Sesi akun sebelumnya belum bisa dikeluarkan di server karena koneksi terputus. Notifikasi di perangkat ini sudah dimatikan; sesi itu akan berakhir sendiri."
};
