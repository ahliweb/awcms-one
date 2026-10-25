/**
 * Customer Web Push - the build flag, the fixed paths and the storage keys
 * (issue #431). Deliberately tiny and import-light: `integrations/profil.mjs`
 * reads it while Astro loads its config, long before any page code exists, and
 * the browser modules re-export it through `push-pelanggan.ts`.
 *
 * ## Why a build flag AND the server flag
 *
 * The CMS decides, per tenant at request time, whether customer push exists
 * (`customerPush`, a neutral 404 when off). That is the authority. This file's
 * `PUBLIC_CUSTOMER_PUSH` decides something different: whether THIS BUILD
 * contains the push-only service worker, the settings page and their link at
 * all. Off (the default), a storefront is byte-identical to one built before
 * issue #431 - no worker file, no page, no card - exactly the contract
 * `PUBLIC_INSTALL_HELP` (ADR-0049 D5) already gave the iOS help page. Both
 * must be on for a shopper to see anything, and turning the build flag on needs
 * a rebuild like every `PUBLIC_` flag.
 */
import { readEnv } from "./env";

/** Where the settings page lives when the flag is on. Deliberately not in `ROUTES` (see `pasang-aplikasi.ts`: a flag-gated page must not enter the sitemap, nav or profile matrices). */
export const PUSH_SETTINGS_PATH = "/akun/notifikasi";

/** The storefront-origin service worker: a fixed, unhashed URL (a registration is keyed by script URL, so a hashed name would orphan every subscription on each build). */
export const PUSH_WORKER_PATH = "/sw-notifikasi.js";

/** Scope `/` as ADR-0048 section 7 fixes it. The worker has no `fetch` handler, so the scope intercepts nothing. */
export const PUSH_WORKER_SCOPE = "/";

export { PUSH_MARKER_KEY, PUSH_NOTICE_KEY } from "./push-kunci";

export function isCustomerPushEnabled(): boolean {
  const raw = readEnv("PUBLIC_CUSTOMER_PUSH");
  return raw !== undefined && ["1", "true", "on", "yes"].includes(raw.toLowerCase());
}
