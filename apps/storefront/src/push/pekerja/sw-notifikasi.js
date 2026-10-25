/**
 * Storefront push service worker (issue #431, ADR-0048 section 7 and 6.3).
 *
 * Served from the STOREFRONT origin as `/sw-notifikasi.js` (a fixed, unhashed
 * URL: a registration is keyed by script URL, so a content-hashed name would
 * orphan every subscription the previous build made), scope `/`, `max-age=0`
 * (`server/penyaji.mjs` serves everything outside `/_astro/` as
 * `public, max-age=0, must-revalidate`; a worker under `immutable` would be one
 * a browser may keep for a year, so a fix here would reach nobody). It exists
 * in a build only when `PUBLIC_CUSTOMER_PUSH` is on (`src/lib/push-pelanggan.ts`).
 * The CMS keeps its own admin worker (`apps/cms/public/push-sw.js`) on ITS
 * origin; a service worker is never registered cross-origin.
 *
 * What this worker is, and is not - the guard tests
 * (`tests/storefront-tanpa-service-worker.test.mjs`, `tests/push-pekerja.test.ts`)
 * pin every line of it:
 *
 *   - PUSH AND CLICK ONLY. No `fetch` handler, no Cache Storage, no
 *     `importScripts`, no network call of its own. It intercepts nothing, so the
 *     `/` scope costs nothing and caches nothing: a shopper's pages are exactly
 *     as fresh with it installed as without it.
 *   - NO TOKEN, NO PERSONAL DATA. It cannot read `localStorage` (a worker has
 *     none) and never calls the API; the customer's `cs_` bearer stays on the
 *     page. It cannot register a device on `pushsubscriptionchange` for the same
 *     reason - the next visit to the settings page reconciles instead.
 *   - GENERIC TEXT FROM THE PAYLOAD ONLY. Title and body are the strings the
 *     producer sent (a fixed template, ADR-0048 I6/T15), length-capped; nothing
 *     is fetched, looked up or composed here. An unreadable or empty payload
 *     still shows ONE generic notification: browsers require a visible
 *     notification for every push and revoke the permission of a site that
 *     shows none.
 *   - THE CLICK TARGET IS NEVER TRUSTED. It must resolve to THIS origin and be
 *     one of the three fixed account paths (ADR-0048 section 6.5); the query
 *     string and fragment are dropped; anything else opens `/akun`. This is the
 *     third wall behind the server's closed path list and `validatePushTargetPath`
 *     (T7). The destination page authenticates with the stored bearer before it
 *     shows anything private.
 *   - NO ICON OR IMAGE FROM THE PAYLOAD (fetching one would leak the shopper's
 *     address to whoever controls it); a fixed same-origin icon is used.
 *
 * Both payload shapes are read, as upstream's worker does (Issue #1106):
 *   legacy       { title, body, targetPath?, data? }
 *   declarative  { web_push: 8030, notification: { title, body?, navigate, tag?, data? } }
 * Exactly one `showNotification` per event, so one banner. Vanilla ES5, no
 * dependencies, not bundled.
 */
"use strict";

var FALLBACK_TITLE = "Ada pembaruan dari toko";
var FALLBACK_BODY = "Buka akun Anda untuk melihatnya.";
var FALLBACK_PATH = "/akun";
var ICON_PATH = "/icons/icon-192.png";
var MAX_TITLE = 120;
var MAX_BODY = 240;

/** The only paths a click may open (ADR-0048 section 6.5, one per purpose, plus the account root). */
var ALLOWED_PATHS = ["/akun", "/akun/pesanan", "/akun/pesan"];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value, fallback, max) {
  if (typeof value !== "string") return fallback;
  var trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed === "") return fallback;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** A tag only coalesces repeats of one purpose; keep it a short lowercase word. */
function tagOf(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value) ? value : "";
}

/**
 * Resolve a click destination against THIS origin. `new URL()` makes
 * `//evil.example/x`, `/\evil.example` and `javascript:` decidable: they resolve
 * to another origin or scheme and fall back. Only the pathname survives.
 */
function resolveTarget(raw) {
  var fallback = self.location.origin + FALLBACK_PATH;
  if (typeof raw !== "string" || raw === "") return fallback;

  try {
    var url = new URL(raw, self.location.origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return fallback;
    if (url.origin !== self.location.origin) return fallback;

    var path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
    return ALLOWED_PATHS.indexOf(path) === -1 ? fallback : self.location.origin + path;
  } catch (error) {
    return fallback;
  }
}

function sameOrigin(href) {
  try {
    return new URL(href).origin === self.location.origin;
  } catch (error) {
    return false;
  }
}

/** Either shape -> { title, body, url, tag }. Never throws. */
function normalizePayload(raw) {
  var source = {};
  var target;

  if (isRecord(raw) && raw.web_push === 8030 && isRecord(raw.notification)) {
    source = raw.notification;
    target = source.navigate;
  } else if (isRecord(raw)) {
    source = raw;
    target = raw.targetPath;
  }

  return {
    title: text(source.title, FALLBACK_TITLE, MAX_TITLE),
    body: text(source.body, FALLBACK_BODY, MAX_BODY),
    url: resolveTarget(target),
    tag: tagOf(source.tag) || tagOf(isRecord(source.data) ? source.data.category : null)
  };
}

function readPayload(event) {
  if (!event.data) return null;
  try {
    return event.data.json();
  } catch (error) {
    // Not JSON, or not decryptable: the generic fallback still shows.
    return null;
  }
}

self.addEventListener("install", function () {
  // A push-only worker has nothing to migrate, so a fixed version takes over at once.
  self.skipWaiting();
});

self.addEventListener("push", function (event) {
  var normalized = normalizePayload(readPayload(event));
  var options = {
    body: normalized.body,
    icon: self.location.origin + ICON_PATH,
    data: { url: normalized.url }
  };
  if (normalized.tag) options.tag = normalized.tag;

  // `waitUntil` is not optional: the worker may be killed before
  // `showNotification` resolves.
  event.waitUntil(self.registration.showNotification(normalized.title, options));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();

  // Re-validated at click time: this is the code that navigates.
  var target = resolveTarget(event.notification.data && event.notification.data.url);

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (windowClients) {
      for (var index = 0; index < windowClients.length; index += 1) {
        var client = windowClients[index];
        if (sameOrigin(client.url) && "focus" in client) {
          if ("navigate" in client) {
            Promise.resolve(client.navigate(target)).catch(function () {});
          }
          return Promise.resolve(client.focus()).catch(function () {});
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
