/**
 * The customer Web Push half of `scripts/stub-awcms.mjs` (issue #431, ADR-0048
 * section 6.1): `/api/v1/commerce/storefront/account/push/*`, as a small state
 * machine, so `tests/e2e/akun-notifikasi.e2e.ts` can prove the settings page
 * against a real browser and a real build without a CMS.
 *
 * Faithful to the #430 contract in what the page depends on: bearer only
 * (`401 UNAUTHENTICATED`), `GET subscriptions` answers `{capability,
 * preferences, devices}` with `active` devices only and a MASKED endpoint,
 * `POST` is `201` for a new or transferred device and `200` for a no-op, answers
 * `409 DEVICE_LIMIT` past five devices, `422 ENDPOINT_NOT_ALLOWED` for a host
 * outside the push-service allow-list, `422 VALIDATION_ERROR` for a consent text
 * version other than the published one, and `DELETE` of a foreign or absent id
 * is the neutral `404`. Logging out revokes the devices of that session
 * (`revokeSessionDevices`, called by the stub's `/account/logout`). Nothing is
 * ever sent.
 *
 * `STUB_CUSTOMER_PUSH` picks what the stub's capability says: `on` (default),
 * `off` (the neutral 404, as the tenant flag off), `not_configured`,
 * `origin_not_supported`. `POST /stub/push/control` (no CORS, test-only) changes
 * it at run time and can reset the state.
 */
import { createECDH } from "node:crypto";

/**
 * A valid P-256 public key (65 bytes, 0x04 prefix), base64url - generated at
 * start-up rather than committed, so no key-shaped literal sits in the tree
 * (secret scanners rightly flag one) and every stub run publishes a fresh,
 * real, well-formed `applicationServerKey`. It is a public value; the matching
 * private key is discarded, so nothing could ever be sent with it.
 */
export const APPLICATION_SERVER_KEY = (() => {
  const curve = createECDH("prime256v1");
  curve.generateKeys();
  return curve.getPublicKey().toString("base64url");
})();

/** The consent text version the page ships (`TEKS_PERSETUJUAN` in `src/lib/push-pelanggan.ts`; `CUSTOMER_PUSH_CONSENT_TEXT_VERSION` in the CMS). */
export const CONSENT_TEXT_VERSION = "draft-2026-10";

const PURPOSES = ["order_updates", "payment_updates", "support_replies"];
const MAX_DEVICES = 5;

const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /\.notify\.windows\.com$/
];

function maskEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return `${url.host}/…${endpoint.slice(-6)}`;
  } catch {
    return "…";
  }
}

export function createPushStub({ envelope, envelopeError, findAccountByBearer, sessionTokenOf }) {
  let mode = process.env.STUB_CUSTOMER_PUSH ?? "on";
  /** accountId -> Map<deviceId, device> */
  const devicesByAccount = new Map();
  /** accountId -> { [purpose]: { enabled, consentTextVersion } } */
  const preferencesByAccount = new Map();
  let sequence = 0;

  const devicesOf = (account) => {
    let map = devicesByAccount.get(account.id);
    if (!map) {
      map = new Map();
      devicesByAccount.set(account.id, map);
    }
    return map;
  };

  const preferencesOf = (account) => {
    let prefs = preferencesByAccount.get(account.id);
    if (!prefs) {
      prefs = {};
      preferencesByAccount.set(account.id, prefs);
    }
    return prefs;
  };

  const serializePreferences = (account) => {
    const prefs = preferencesOf(account);
    return PURPOSES.map((purpose) => ({
      purpose,
      enabled: prefs[purpose]?.enabled === true,
      consentTextVersion: prefs[purpose]?.consentTextVersion ?? null,
      grantedAt: prefs[purpose]?.enabled ? new Date().toISOString() : null,
      revokedAt: null
    }));
  };

  const serializeDevice = (device, token) => ({
    id: device.id,
    endpointMasked: maskEndpoint(device.endpoint),
    userAgentSummary: device.userAgentSummary,
    status: "active",
    lastSuccessAt: null,
    registeredAt: device.registeredAt,
    current: device.token === token
  });

  const capability = () => ({
    enabled: mode === "on",
    reason: mode === "not_configured" || mode === "origin_not_supported" ? mode.replace("not_configured", "push_not_configured") : null,
    applicationServerKey: mode === "on" ? APPLICATION_SERVER_KEY : null,
    transports: ["web_push"],
    purposes: PURPOSES,
    consentTextVersion: CONSENT_TEXT_VERSION,
    maxDevices: MAX_DEVICES
  });

  const unauthenticated = (headers) =>
    envelopeError(401, "UNAUTHENTICATED", "Sesi tidak valid atau telah berakhir.", undefined, headers);

  return {
    /** Revokes every device the logging-out session enrolled (ADR-0048 section 5.3). */
    revokeSessionDevices(account, token) {
      const map = devicesByAccount.get(account.id);
      if (!map) return;
      for (const [id, device] of map) if (device.token === token) map.delete(id);
    },

    /** `path` is what follows `/account` (for example `/push/subscriptions`). Returns `null` for a path that is not ours. */
    handle(request, path, body, headers) {
      if (!path.startsWith("/push/")) return null;

      // The tenant flag off is the neutral 404, BEFORE the bearer is looked at.
      if (mode === "off") {
        return Response.json({ success: false, error: { code: "NOT_FOUND", message: "Not found." } }, { status: 404, headers });
      }

      const account = findAccountByBearer(request);
      if (!account) return unauthenticated(headers);
      const token = sessionTokenOf(request);

      if (path === "/push/subscriptions" && request.method === "GET") {
        return envelope(
          {
            capability: capability(),
            preferences: serializePreferences(account),
            devices: [...devicesOf(account).values()].map((device) => serializeDevice(device, token))
          },
          { headers }
        );
      }

      if (path === "/push/subscriptions" && request.method === "POST") {
        if (mode !== "on") {
          return envelopeError(409, "PUSH_UNAVAILABLE", "Push notifications are not available on this deployment.", undefined, headers);
        }
        const consent = body?.consent;
        const keys = body?.keys;
        if (
          typeof body?.endpoint !== "string" ||
          typeof keys?.p256dh !== "string" ||
          typeof keys?.auth !== "string" ||
          !Array.isArray(consent?.purposes) ||
          consent.purposes.length === 0 ||
          !consent.purposes.every((p) => PURPOSES.includes(p))
        ) {
          return envelopeError(400, "VALIDATION_ERROR", "Invalid request.", [{ field: "body", message: "Invalid subscription." }], headers);
        }
        let host;
        try {
          host = new URL(body.endpoint).hostname;
        } catch {
          host = "";
        }
        if (!PUSH_HOSTS.some((pattern) => pattern.test(host)) && !String(process.env.STUB_PUSH_EXTRA_HOSTS ?? "").split(",").includes(host)) {
          return envelopeError(422, "ENDPOINT_NOT_ALLOWED", "This push service is not supported.", undefined, headers);
        }
        if (consent.textVersion !== CONSENT_TEXT_VERSION) {
          return envelopeError(
            422,
            "VALIDATION_ERROR",
            "Invalid request.",
            [{ field: "consent.textVersion", message: "Unknown consent text version." }],
            headers
          );
        }

        const devices = devicesOf(account);
        const existing = [...devices.values()].find((device) => device.endpoint === body.endpoint);
        if (!existing && devices.size >= MAX_DEVICES) {
          return envelopeError(409, "DEVICE_LIMIT", "Maximum number of devices reached.", undefined, headers);
        }

        // Consent: the listed purposes are granted under this version.
        const prefs = preferencesOf(account);
        for (const purpose of consent.purposes) {
          prefs[purpose] = { enabled: true, consentTextVersion: consent.textVersion };
        }

        let status = 201;
        let device = existing;
        if (existing && existing.token === token) {
          status = 200;
        } else if (existing) {
          existing.token = token;
        } else {
          sequence += 1;
          device = {
            id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
            endpoint: body.endpoint,
            token,
            userAgentSummary: "Chrome on Android (mobile)",
            registeredAt: new Date().toISOString()
          };
          devices.set(device.id, device);
        }

        return Response.json(
          { success: true, data: { device: serializeDevice(device, token), preferences: serializePreferences(account) }, meta: {} },
          { status, headers }
        );
      }

      if (path === "/push/subscriptions" && request.method === "DELETE") {
        devicesOf(account).clear();
        return new Response(null, { status: 204, headers });
      }

      const one = /^\/push\/subscriptions\/([^/]+)$/.exec(path);
      if (one && request.method === "DELETE") {
        const devices = devicesOf(account);
        const id = decodeURIComponent(one[1]);
        if (!devices.has(id)) {
          return Response.json({ success: false, error: { code: "NOT_FOUND", message: "Not found." } }, { status: 404, headers });
        }
        devices.delete(id);
        return new Response(null, { status: 204, headers });
      }

      if (path === "/push/preferences" && request.method === "GET") {
        return envelope({ preferences: serializePreferences(account) }, { headers });
      }

      if (path === "/push/preferences" && request.method === "PUT") {
        const purposes = body?.purposes;
        if (!purposes || typeof purposes !== "object" || Object.keys(purposes).length === 0) {
          return envelopeError(400, "VALIDATION_ERROR", "Invalid request.", [{ field: "purposes", message: "Name at least one purpose." }], headers);
        }
        const turningOn = Object.values(purposes).some((value) => value === true);
        if (turningOn && body.textVersion !== CONSENT_TEXT_VERSION) {
          return envelopeError(
            422,
            "VALIDATION_ERROR",
            "Invalid request.",
            [{ field: "textVersion", message: "textVersion is required when turning a purpose on." }],
            headers
          );
        }
        const prefs = preferencesOf(account);
        for (const [purpose, enabled] of Object.entries(purposes)) {
          if (!PURPOSES.includes(purpose) || typeof enabled !== "boolean") {
            return envelopeError(400, "VALIDATION_ERROR", "Invalid request.", [{ field: `purposes.${purpose}`, message: "Unknown purpose." }], headers);
          }
          prefs[purpose] = { enabled, consentTextVersion: enabled ? body.textVersion : (prefs[purpose]?.consentTextVersion ?? CONSENT_TEXT_VERSION) };
        }
        return envelope({ preferences: serializePreferences(account) }, { headers });
      }

      return null;
    },

    /** `POST /stub/push/control` - `{mode?: "on"|"off"|"not_configured"|"origin_not_supported", reset?: true}`. */
    async handleControl(request) {
      const body = await request.json().catch(() => ({}));
      if (typeof body.mode === "string") mode = body.mode;
      if (body.reset === true) {
        devicesByAccount.clear();
        preferencesByAccount.clear();
        mode = process.env.STUB_CUSTOMER_PUSH ?? "on";
      }
      return Response.json({ mode });
    }
  };
}
