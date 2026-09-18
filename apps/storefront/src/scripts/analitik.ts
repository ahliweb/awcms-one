/**
 * The first-party visitor beacon (issue #56, A10) — this storefront's ONLY
 * outbound telemetry unless an operator also turns on GA4 (`src/lib/ga.ts`,
 * `BaseLayout.astro`'s GA branch). Mounted once, in `BaseLayout.astro`, on
 * EVERY page — store and news alike, a visitor counter is site-wide, not a
 * per-section feature — and reports one thing: "this path was viewed".
 *
 * ## The contract with `apps/cms`, verified against the route, not guessed
 *
 * `POST /api/v1/analytics/collect`
 * (`apps/cms/src/pages/api/v1/analytics/collect.ts`) validates EXACTLY
 * `{ tenantCode, path, referrer? }` as JSON — read from that file and from
 * `apps/cms/src/modules/visitor-analytics/README.md` directly, not
 * inferred. There is no "viewport class" field in that schema (the issue's
 * own Scope bullet names one as a "typically" example, not a requirement),
 * so this beacon does not invent one; every identifier the server actually
 * stores (visitor key, hashed IP, hashed user-agent) is derived server-side
 * from the request itself, never from anything this script sends.
 *
 * ## Why `fetch`, not `navigator.sendBeacon`
 *
 * The issue's own Scope bullet names `navigator.sendBeacon` first (fallback
 * `fetch keepalive`) — the usual shape for a page-unload-safe beacon. That
 * is backwards for THIS endpoint specifically, and the reason is recorded
 * where the endpoint's own author found it:
 * `apps/cms/src/modules/visitor-analytics/domain/beacon-cors.ts`'s "## What
 * was actually broken" docblock. `sendBeacon`'s payload has no way to force
 * a `content-type: application/json` header from this app's own code — a
 * `Blob` with an explicit JSON `type` still isn't what ships in practice, so
 * the request lands as `text/plain`, and `text/plain` is a FORM-LIKE content
 * type Astro's own `security.checkOrigin` middleware refuses cross-origin
 * (`403 Cross-site POST form submissions are forbidden`, verified by that
 * docblock's own path-1/path-2 test). This storefront calling the CMS is
 * cross-origin BY CONSTRUCTION (ADR-0007 revised, issue #30: two separate
 * deployments, `PUBLIC_AWCMS_ORIGIN` is a different origin from this site's
 * own). `collect.ts`'s own docblock ("CROSS-ORIGIN (Issue #637)") gives the
 * one call that IS supported: `fetch` with an explicit
 * `content-type: application/json`, `credentials: "include"` (the anonymous
 * `awcms_visitor_key` cookie — see `beacon-cors.ts`'s `SameSite` reasoning),
 * and `keepalive: true` — the one property that made `sendBeacon` attractive
 * in the first place (the request survives the page unloading). That exact
 * call is what `sendAnalyticsBeacon` below makes; `sendBeacon` is
 * deliberately never called.
 *
 * ## Privacy (no cookie/localStorage of THIS script's own making)
 *
 * `credentials: "include"` lets the BROWSER send/store the server's own
 * `httpOnly` anonymous cookie — this script never reads or writes a cookie
 * itself, and touches no `localStorage`. `Do Not Track`
 * (`navigator.doNotTrack`, and the legacy `window.doNotTrack` some browsers
 * still expose) and the Global Privacy Control signal
 * (`navigator.globalPrivacyControl`) both suppress sending outright, checked
 * BEFORE any network call — an opted-out visitor's browser makes no request
 * at all, rather than a request the server happens to discard. Silent on
 * any failure (ad blocker, offline, a misconfigured `PUBLIC_AWCMS_ORIGIN`):
 * a visitor counter must never surface as a console error a reader or a
 * site owner has to explain.
 *
 * ## What this deliberately does NOT cover
 *
 * `/produk` and `/cari`'s own client-side pagination/filtering
 * (`produk-listing.ts`/`cari-listing.ts`) changes the visible product grid
 * via `history.pushState` without a real navigation — no `DOMContentLoaded`,
 * no `pageshow`, so no second beacon fires for it. That is consistent with
 * this being a PAGE-VIEW counter (what `visitor-analytics`'s rollups and
 * A3's "Terpopuler" read), not a full single-page-app route tracker; adding
 * that would be a separately-scoped change.
 */
import { requireAwcmsOrigin } from "../lib/awcms/toko-origin";

const COLLECT_PATH = "/api/v1/analytics/collect";

/** Mirrors `collect.ts`'s own `tenantCode.length > 128` rejection. */
const MAX_TENANT_CODE_LENGTH = 128;

/** Mirrors `collect.ts`'s own `MAX_PATH_LENGTH`. */
const MAX_PATH_LENGTH = 2048;

export interface AnalyticsBeaconPayload {
  tenantCode: string;
  path: string;
  referrer?: string;
}

/** The `data-*` attribute `BaseLayout.astro` bakes `AWCMS_TENANT_CODE` into, read back here. */
const TENANT_CODE_DATASET_KEY = "analyticsTenantCode";

/**
 * The minimal shape this module needs to check an opt-out signal — narrowed
 * so `isTrackingOptedOut` is unit-testable without a real `Navigator`.
 * `globalPrivacyControl` is a real, shipping browser signal (Firefox,
 * Brave) that has no standard DOM type yet, hence the plain interface here
 * rather than `Navigator` itself.
 */
export interface TrackingSignalSource {
  doNotTrack?: string | null;
  globalPrivacyControl?: boolean;
}

/**
 * `true` when the visitor has opted out via Do Not Track or Global Privacy
 * Control. Both spellings of Do Not Track are checked — `navigator.
 * doNotTrack` (the modern location) and the legacy `window.doNotTrack` old
 * Internet Explorer/Firefox builds used — because a beacon honouring only
 * one is a beacon that ignores an opt-out signal depending on which browser
 * sent it.
 */
export function isTrackingOptedOut(
  navigatorSignals: TrackingSignalSource,
  legacyWindowDoNotTrack?: string | null
): boolean {
  return (
    navigatorSignals.doNotTrack === "1" ||
    legacyWindowDoNotTrack === "1" ||
    navigatorSignals.globalPrivacyControl === true
  );
}

/**
 * Builds the exact payload `POST /api/v1/analytics/collect` validates, or
 * `null` when the input cannot produce a well-formed one — most commonly a
 * blank `tenantCode` (this deployment never configured `AWCMS_TENANT_CODE`,
 * a normal, expected state — see `src/lib/awcms/theme.ts` for the same
 * variable degrading the same way). Pure and exported so the payload shape
 * is tested directly, without a network call or a real `document`.
 */
export function buildAnalyticsPayload(input: {
  tenantCode: string;
  path: string;
  referrer: string;
}): AnalyticsBeaconPayload | null {
  const tenantCode = input.tenantCode.trim();
  if (tenantCode.length === 0 || tenantCode.length > MAX_TENANT_CODE_LENGTH) {
    return null;
  }

  if (!input.path.startsWith("/") || input.path.length > MAX_PATH_LENGTH) {
    return null;
  }

  const referrer = input.referrer.trim();
  return referrer.length > 0
    ? { tenantCode, path: input.path, referrer }
    : { tenantCode, path: input.path };
}

/**
 * Fire-and-forget: never throws, never rejects the caller, never logs. See
 * this file's own "Why `fetch`, not `sendBeacon`" section above for why this
 * exact call shape (method/headers/credentials/keepalive) is not
 * negotiable.
 */
async function sendAnalyticsBeacon(
  origin: string,
  payload: AnalyticsBeaconPayload
): Promise<void> {
  try {
    await fetch(`${origin}${COLLECT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      keepalive: true,
      body: JSON.stringify(payload)
    });
  } catch {
    // Silent on any failure — see file docblock. A visitor counter must
    // never become a console error a reader or site owner has to explain.
  }
}

/**
 * One page view. Reads the tenant code `BaseLayout.astro` baked into
 * `<body data-analytics-tenant-code>` at build time — the SAME
 * `AWCMS_TENANT_CODE` variable `src/lib/awcms/theme.ts` already reads for
 * brand colors, never a second variable an operator would have to keep in
 * sync — and the CMS's own public origin (`requireAwcmsOrigin()`, the exact
 * origin cart/checkout/order-tracking already call directly, ADR-0007
 * revised).
 */
function reportPageView(): void {
  const legacyDoNotTrack = (window as Window & { doNotTrack?: string | null })
    .doNotTrack;
  const navigatorSignals = navigator as Navigator & {
    globalPrivacyControl?: boolean;
  };

  if (isTrackingOptedOut(navigatorSignals, legacyDoNotTrack)) {
    return;
  }

  const tenantCode = document.body?.dataset[TENANT_CODE_DATASET_KEY] ?? "";
  const payload = buildAnalyticsPayload({
    tenantCode,
    path: window.location.pathname,
    referrer: document.referrer
  });

  // No tenant configured, or a path the server would reject outright —
  // nothing to send. Not an error: an unconfigured `AWCMS_TENANT_CODE` is a
  // normal, expected deployment state.
  if (!payload) return;

  let origin: string;
  try {
    origin = requireAwcmsOrigin();
  } catch {
    // PUBLIC_AWCMS_ORIGIN unset/malformed. `csp.json.ts` already fails the
    // BUILD over this for cart/checkout, so a shipped build never reaches
    // this branch in practice — caught anyway so a beacon never throws.
    return;
  }

  void sendAnalyticsBeacon(origin, payload);
}

// Guarded so this module stays importable (and its pure functions above
// testable) from `bun test`, which runs with no `document`/`window` at all.
if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", reportPageView);

  // bfcache restore: `DOMContentLoaded` does not fire again when a browser
  // restores a page from its back/forward cache, so this is the only signal
  // that a reader is looking at this page again. `persisted: false` is an
  // ordinary fresh load already covered by the listener above — reporting
  // it again here would double-count every normal page view.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) reportPageView();
  });
}
