/**
 * storefront-consumer-contract.mjs — the frozen consumer-contract slice for
 * the storefront's calls: build-time reads (issue #555) and browser calls
 * (issue #556), ADR-0058 D2.
 *
 * Side-effect free: importing this runs and prints nothing. The CLI is
 * `tools/storefront-consumer-contract.mjs`; the gate is
 * `tests/storefront-consumer-contract.test.mjs` (root `bun test`, so it runs
 * inside `local-ci/check-toko` with no database and no network).
 *
 * ## What it freezes
 *
 * Every operation `apps/storefront` calls while `astro build` runs, per build
 * profile, as the consumed operation objects plus every component they reach
 * (the transitive `$ref` closure, because the interesting breakages happen in
 * the schema, not in the path object). The rule is the one
 * `apps/cms/scripts/api-consumer-contract.ts` applies to `awcms-astro`: the
 * provider may ADD, never remove or narrow what the consumer relies on.
 * `apps/cms` is read-only for this repository (ADR-0024, ADR-0058 D2), so the
 * helpers are re-implemented here, not imported from it.
 *
 * Two small, deliberate differences from that script, both because this
 * slice is checked on every subtree sync rather than once per release:
 *
 *  - It freezes only the METHODS the consumer calls (`GET`), not the whole
 *    path item, so a provider adding a `POST` is not a contract event.
 *  - It drops prose keys (`description`, `summary`, `title`, `example(s)`,
 *    `tags`, `externalDocs`) before comparing, so rewording documentation is
 *    not mistaken for a contract change. Types, enums, `required`, nullability
 *    and declared parameters are all still compared.
 *
 * ## Browser calls (issue #556)
 *
 * Each frozen operation carries `phase: "build"` or `phase: "browser"`. A
 * browser entry adds the request side (auth, query and header parameters the
 * consumer sends, whether it sends a body, its Idempotency-Key behaviour) and
 * the NEGATIVE CASES the storefront code handles for it (`negatives`: 204,
 * 401, 404, 409, 429), each with evidence (a file and a token that must still
 * be in it) and, for a status the bundle does not declare yet, a `pending`
 * marker naming the upstream work (429 is the only status that may be pending:
 * ahliweb/awcms#1385, tracked here by issue #557).
 *
 * Direction matters. RESPONSES follow the additive-superset rule above. REQUEST
 * bodies and parameters follow the reverse rule: the provider must still
 * accept what the consumer sends, so it may not add a required field or
 * parameter, remove a property, or narrow a type, enum, format or bound
 * (`findRequestProblems`). A schema reached from both directions gets both
 * rules, which makes it effectively frozen (stated, not hidden).
 *
 * The browser source guard (`scanBrowserCallSources`) is the sibling of the
 * build one: it finds every `kirimPermintaan(...)` call site, the two direct
 * `fetch` transports (`scripts/buletin.ts`, `scripts/analitik.ts`) and any other
 * `fetch`/`sendBeacon`/`XMLHttpRequest` in `apps/storefront/src`, so a new
 * browser call to an awcms path that is not frozen fails.
 *
 * ## What it does not see (stated so it is not mistaken for guarded)
 *
 *  - The per-profile mapping is hand-reviewed (see `PROFILE_NOTE`); the source
 *    guard proves the SET of operations and readers, not which page group
 *    reaches which one.
 *  - A read whose path is assembled from a value imported from another module,
 *    or a raw `fetch()` against a computed URL outside `src/lib/awcms/`, is
 *    not detected. The guard is a tripwire for the shapes this codebase uses
 *    today, not a parser.
 *  - Browser: a `kirimPermintaan` whose path argument is not a string literal
 *    or template, or a method that is not a string literal, is not seen (a
 *    stray `fetch` there is still reported). Which statuses a PAGE handles is
 *    evidenced by one token per case, not proven by running the page.
 *  - Browser: the per-profile set is hand-reviewed like the build one. Account,
 *    cart, order, booking and push flows are `toko` because sessions are only
 *    created there; the shared header bundles the wishlist sync into every
 *    profile but never calls it without a stored session, so it is not counted
 *    for `berita` or `landing`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const BUNDLE_PATH = "apps/cms/openapi/awcms-public-api.openapi.yaml";
export const FIXTURE_PATH = "tests/fixtures/storefront-consumer-contract.json";

export const PROFILES = ["toko", "berita", "landing"];

/** Profile sets an operation may carry. A new set is a deliberate edit here. */
const ALL = ["toko", "berita", "landing"];
const TOKO_BERITA = ["toko", "berita"];
const TOKO = ["toko"];

/**
 * Why a profile set looks the way it does (`apps/storefront/src/config/profil.ts`
 * `PROFILE_GROUPS`): `toko` builds shared + toko + berita, `berita` builds
 * shared + berita, `landing` builds shared only. So an operation reached only
 * from the `berita` group belongs to `toko` and `berita`; one reached only from
 * the `toko` group belongs to `toko`; one reached from a shared page or layout
 * belongs to all three.
 */
export const PROFILE_NOTE =
  "shared group -> all profiles; berita group -> toko+berita; toko group -> toko";

const LIB = "apps/storefront/src/lib";

/**
 * The build-time reads. `readers` are the files under `apps/storefront/src`
 * that issue the call (the source guard compares this to what it finds).
 * `queryParams` are the query parameters the consumer sends; each must stay a
 * declared parameter of the operation in the bundle.
 */
export const BUILD_OPERATIONS = [
  op("/api/v1/site-profile/composed", ALL, [], [`${LIB}/awcms/profil.ts`]),
  op("/api/v1/blog/pages/public", ALL, [], [`${LIB}/awcms/pages.ts`]),
  op("/api/v1/blog/pages/public/{slug}", ALL, [], [`${LIB}/awcms/pages.ts`]),
  op("/api/v1/commerce/store-settings/public", ALL, [], [`${LIB}/awcms/pemasaran.ts`]),
  op("/api/v1/media/public-origin", ALL, [], [`${LIB}/awcms/media.ts`]),

  op(
    "/api/v1/blog/posts",
    TOKO_BERITA,
    ["cursor", "limit", "order", "status", "view"],
    [`${LIB}/awcms/blog.ts`]
  ),
  op(
    "/api/v1/blog/terms",
    TOKO_BERITA,
    ["cursor", "limit", "order"],
    [`${LIB}/awcms/blog.ts`]
  ),
  op("/api/v1/blog/institutions", TOKO_BERITA, [], [`${LIB}/awcms/blog.ts`]),
  op("/api/v1/news-portal/ad-placements/active", TOKO_BERITA, [], [`${LIB}/awcms/blog.ts`]),
  op("/api/v1/seo/redirects", TOKO_BERITA, ["cursor", "state"], [`${LIB}/awcms/blog.ts`]),
  op("/api/v1/analytics/pages", TOKO_BERITA, ["range"], [`${LIB}/awcms/analitik.ts`]),
  op("/api/v1/media/objects", TOKO_BERITA, ["ids"], [`${LIB}/awcms/media.ts`]),
  op(
    "/api/v1/idn-regions/regions",
    TOKO_BERITA,
    ["after", "level", "limit", "parentCode"],
    [`${LIB}/awcms/wilayah.ts`, `${LIB}/awcms/wilayah-checkout.ts`]
  ),

  op("/api/v1/commerce/products", TOKO, ["cursor"], [`${LIB}/catalog.ts`]),
  op("/api/v1/commerce/categories", TOKO, ["cursor"], [`${LIB}/catalog.ts`]),
  op("/api/v1/commerce/sliders/active", TOKO, [], [`${LIB}/awcms/pemasaran.ts`]),
  op("/api/v1/commerce/flash-sales/active", TOKO, [], [`${LIB}/awcms/pemasaran.ts`]),
  op("/api/v1/commerce/vouchers/public", TOKO, [], [`${LIB}/awcms/pemasaran.ts`]),
  op("/api/v1/commerce/testimonials/active", TOKO, [], [`${LIB}/awcms/pemasaran.ts`]),
  op("/api/v1/commerce/popups/active", TOKO, [], [`${LIB}/awcms/pemasaran.ts`])
];

/**
 * Build-time reads that are NOT in the OpenAPI bundle (audit F-07). They are
 * named, not given an invented schema: the route answers raw CSS, not the
 * `{ success, data }` envelope, and the bundle does not describe it.
 */
export const OUT_OF_BUNDLE = [
  {
    phase: "build",
    method: "GET",
    path: "/theming/{tenantCode}/tokens.css",
    profiles: ALL,
    readers: [`${LIB}/awcms/theme.ts`],
    reason:
      "The route returns raw text/css and lives outside /api, so it is not in the OpenAPI bundle and api:spec:check does not cover it (audit F-07, reported upstream).",
    alternativeCheck:
      "Existence only: the route file apps/cms/src/pages/theming/[tenantCode]/tokens.css.ts must exist (checked by the gate). Its CSS is parsed leniently by extractThemeToken with a default-palette fallback, so a body change degrades colours rather than failing the build. No schema is claimed."
  }
];

/** The provider-side file whose existence is the alternative check above. */
export const THEMING_ROUTE_FILE = "apps/cms/src/pages/theming/[tenantCode]/tokens.css.ts";


// ---------------------------------------------------------------------------
// Browser calls (issue #556)
// ---------------------------------------------------------------------------

const SF = "/api/v1/commerce/storefront";
const TOKO_REQUEST = `${LIB}/toko-permintaan.ts`;
const AKUN_CLIENT = `${LIB}/akun-klien.ts`;
const TOKO_CLIENT = `${LIB}/toko-klien.ts`;
const BULETIN = "apps/storefront/src/scripts/buletin.ts";
const ANALITIK = "apps/storefront/src/scripts/analitik.ts";

/**
 * Where a negative case is handled, as evidence: `file` must exist and still
 * contain `token` (comments excluded). `handling` says what the storefront does.
 * Generic handling lives in the one transport every `kirimPermintaan` call goes
 * through, so it applies to every operation that uses it.
 */
const GENERIC = {
  noContent: { handling: "no-content", evidence: { file: TOKO_REQUEST, token: "response.status === 204" } },
  typedError: { handling: "typed-error", evidence: { file: TOKO_REQUEST, token: "new TokoApiError(" } },
  retryAfter: { handling: "typed-error+retry-after", evidence: { file: TOKO_REQUEST, token: "withRetryAfter(" } },
  sessionCleared: {
    handling: "session-cleared",
    evidence: { file: AKUN_CLIENT, token: 'error.code === "UNAUTHENTICATED"' }
  },
  newsletterError: { handling: "typed-error", evidence: { file: BULETIN, token: "new BuletinApiError(" } },
  newsletterRetry: {
    handling: "typed-error+retry-after",
    evidence: { file: BULETIN, token: 'response.headers.get("retry-after")' }
  }
};

/**
 * Issue #570: the three optional-bearer toko-klien.ts calls clear the session on
 * a 401 only when a bearer was sent (`denganPembersihanSesiBilaBearer`), so their
 * evidence is that helper in toko-klien.ts, not akun-klien.ts's own wrapper.
 */
const SESSION_CLEARED_IF_BEARER = {
  handling: "session-cleared",
  evidence: { file: TOKO_CLIENT, token: 'bearerToken && error instanceof TokoApiError && error.code === "UNAUTHENTICATED"' }
};

/** Handling a page or a contract module adds on top of the generic one, keyed by `METHOD path|status`. */
const SPECIFIC = {
  "POST /orders|401": SESSION_CLEARED_IF_BEARER,
  "POST /orders/{orderCode}/payment-gateway/sessions|401": SESSION_CLEARED_IF_BEARER,
  "POST /reviews|401": SESSION_CLEARED_IF_BEARER,
  "POST /orders|409": {
    handling: "cart-refresh",
    evidence: { file: "apps/storefront/src/scripts/checkout.ts", token: 'error.code === "CART_CHANGED"' }
  },
  "POST /orders|429": {
    handling: "retry-message",
    evidence: { file: "apps/storefront/src/scripts/checkout.ts", token: 'error.code === "RATE_LIMITED"' }
  },
  "POST /account/privacy/erasure|409": {
    handling: "refusal-list",
    evidence: { file: `${LIB}/privasi-kontrak.ts`, token: '"ERASURE_REFUSED"' }
  },
  "POST /booking/reservations|401": {
    handling: "restart-sign-in",
    evidence: { file: "apps/storefront/src/scripts/booking-pesan.ts", token: 'error.code === "UNAUTHENTICATED"' }
  },
  "POST /booking/reservations|429": {
    handling: "hold-limit-message",
    evidence: { file: `${LIB}/booking-kontrak.ts`, token: 'case "HOLD_LIMIT_EXCEEDED"' }
  },
  "GET /booking/reservations/{orderCode}|404": {
    handling: "not-found-state",
    evidence: { file: "apps/storefront/src/scripts/akun-reservasi-detail.ts", token: "error.status === 404" }
  },
  "GET /booking/availability|404": {
    handling: "offering-not-sold-state",
    evidence: { file: "apps/storefront/src/scripts/booking-cari.ts", token: "error.status === 404" }
  },
  "DELETE /account/push/subscriptions/{id}|404": {
    handling: "treated-as-already-gone",
    evidence: { file: `${LIB}/push-alur.ts`, token: "error.status === 404" }
  }
};

/** Every customer push route answers 429 with a Retry-After the page turns into a message. */
const PUSH_429 = {
  handling: "retry-message",
  evidence: { file: `${LIB}/push-pelanggan.ts`, token: "status === 429" }
};

/**
 * A negative status the bundle does not declare yet, and where it is tracked.
 * Only 429 may be pending: ahliweb/awcms#1385 (upstream), issue #557 (adoption
 * here, after the next subtree sync). The storefront already handles it, so it
 * is recorded with this marker rather than invented in the bundle.
 */
export const PENDING_UPSTREAM = {
  429: "ahliweb/awcms#1385 (upstream spec); adoption in this repository: issue #557"
};

/**
 * Browser operations whose consumer sends a request body that the bundle does
 * not declare at all, so there is no schema to freeze (found by this slice; to
 * be reported upstream). The entry is stale, and fails the gate, the moment the
 * bundle declares the body: remove it and regenerate so the body is frozen.
 */
// Empty since #571 declared the payment-proof upload-session and finalize
// request bodies in the commerce OpenAPI fragment. A new entry needs a reason;
// the gate fails once the bundle declares the body, so an entry cannot go stale.
export const REQUEST_BODY_UNDECLARED = {};

function negativesFor(method, path, statuses, no429, via) {
  const key = (status) => `${method} ${path}|${status}`;
  const isPush = path.startsWith("/account/push/");
  return statuses.map((status) => {
    let base;
    if (status === 204) base = GENERIC.noContent;
    else if (status === 401) base = via === "storefront" ? GENERIC.sessionCleared : GENERIC.typedError;
    else if (status === 429) base = via === "newsletter" ? GENERIC.newsletterRetry : isPush ? PUSH_429 : GENERIC.retryAfter;
    else base = via === "newsletter" ? GENERIC.newsletterError : GENERIC.typedError;
    const chosen = SPECIFIC[key(status)] ?? base;
    const entry = { status, handling: chosen.handling, evidence: chosen.evidence };
    if (status === 429 && no429) entry.pending = PENDING_UPSTREAM[429];
    return entry;
  });
}

/**
 * One browser operation. `reader` is `AK` (akun-klien.ts) or `TK` (toko-klien.ts):
 * both reach the CMS only through `kirimPermintaan`, which prefixes
 * `/api/v1/commerce/storefront`. `auth` is what the consumer sends:
 * `bearer` (required, the call throws UNAUTHENTICATED before the network
 * without a session), `optional-bearer` (sent when a session exists) or `none`.
 * `idem` is the Idempotency-Key behaviour: `header-required` (always sent, and
 * the bundle declares it), `header-optional` (sent when the caller passes a
 * key), `body-field` or none.
 */
function bop(reader, method, path, auth, queryParams, body, idem, statuses, no429) {
  const file = reader === "AK" ? AKUN_CLIENT : TOKO_CLIENT;
  return {
    phase: "browser",
    method,
    path: `${SF}${path}`,
    profiles: TOKO,
    auth,
    queryParams,
    headerParams: idem === "header-required" ? ["Idempotency-Key"] : [],
    sendsBody: body !== null,
    idempotencyKey: idem ?? "none",
    readers: [file],
    negatives: negativesFor(method, path, statuses, no429, "storefront")
  };
}

function direct(method, path, profiles, reader, statuses, no429, via) {
  return {
    phase: "browser",
    method,
    path,
    profiles,
    auth: "none",
    queryParams: [],
    headerParams: [],
    sendsBody: true,
    idempotencyKey: "none",
    readers: [reader],
    negatives: negativesFor(method, path, statuses, no429, via)
  };
}

/**
 * The operations the storefront calls IN THE BROWSER (issue #556, audit F-01).
 * The audit counted 41; the source has 49 `kirimPermintaan` call sites (37 in
 * akun-klien.ts, 12 in toko-klien.ts), plus the newsletter and analytics
 * beacon transports, all enumerated here and held to the source by the scan.
 */
export const BROWSER_OPERATIONS = [
  bop("AK", "POST", "/account/otp/request", "none", [], "body", null, [409, 429], false),
  bop("AK", "POST", "/account/otp/verify", "none", [], "body", "header-optional", [401, 404, 409, 429], false),
  bop("AK", "GET", "/account/me", "bearer", [], null, null, [401, 429], true),
  bop("AK", "PATCH", "/account/me", "bearer", [], "body", null, [401, 429], true),
  bop("AK", "POST", "/account/logout", "bearer", [], null, null, [204, 401, 429], true),
  bop("AK", "GET", "/account/loyalty", "bearer", ["limit"], null, null, [401, 404, 429], false),
  bop("AK", "GET", "/account/addresses", "bearer", [], null, null, [401, 429], false),
  bop("AK", "POST", "/account/addresses", "bearer", [], "body", "header-optional", [401, 409, 429], false),
  bop("AK", "PATCH", "/account/addresses/{id}", "bearer", [], "body", null, [401, 404, 429], false),
  bop("AK", "DELETE", "/account/addresses/{id}", "bearer", [], null, null, [204, 401, 404, 429], false),
  bop("AK", "POST", "/account/addresses/{id}/default", "bearer", [], null, null, [401, 404, 429], false),
  bop("AK", "GET", "/account/wishlist", "bearer", [], null, null, [401, 429], false),
  bop("AK", "PUT", "/account/wishlist", "bearer", [], "body", null, [401, 409, 429], false),
  bop("AK", "DELETE", "/account/wishlist/{productId}", "bearer", [], null, null, [204, 401, 429], false),
  bop("AK", "GET", "/account/orders", "bearer", ["cursor"], null, null, [401, 429], false),
  bop("AK", "GET", "/account/orders/{orderCode}", "bearer", [], null, null, [401, 404, 429], false),
  bop("AK", "GET", "/account/reviews", "bearer", [], null, null, [401, 429], false),
  bop("AK", "GET", "/account/affiliate", "bearer", [], null, null, [401, 429], false),
  bop("AK", "POST", "/account/affiliate", "bearer", [], null, null, [401, 409, 429], false),
  bop("AK", "GET", "/account/affiliate/commissions", "bearer", ["cursor"], null, null, [401, 429], false),
  bop("AK", "GET", "/account/conversations", "bearer", ["cursor"], null, null, [401, 429], false),
  bop("AK", "POST", "/account/conversations", "bearer", [], "body", "header-optional", [401, 409, 429], false),
  bop("AK", "GET", "/account/conversations/{id}", "bearer", [], null, null, [401, 404, 429], false),
  bop("AK", "POST", "/account/conversations/{id}/messages", "bearer", [], "body", "header-optional", [401, 404, 409, 429], false),
  bop("AK", "POST", "/booking/reservations", "bearer", [], "body", "header-required", [401, 404, 409, 429], false),
  bop("AK", "GET", "/booking/reservations", "bearer", ["cursor"], null, null, [401, 404, 429], false),
  bop("AK", "GET", "/booking/reservations/{orderCode}", "bearer", [], null, null, [401, 404, 429], false),
  bop("AK", "GET", "/booking/reservations/{orderCode}/cancellation-quote", "bearer", [], null, null, [401, 404, 409, 429], false),
  bop("AK", "POST", "/booking/reservations/{orderCode}/cancel", "bearer", [], "body", "header-required", [401, 404, 409, 429], false),
  bop("AK", "GET", "/account/push/subscriptions", "bearer", [], null, null, [401, 404, 429], false),
  bop("AK", "POST", "/account/push/subscriptions", "bearer", [], "body", null, [401, 404, 409, 429], false),
  bop("AK", "DELETE", "/account/push/subscriptions/{id}", "bearer", [], null, null, [204, 401, 404, 429], false),
  bop("AK", "DELETE", "/account/push/subscriptions", "bearer", [], null, null, [204, 401, 404, 429], false),
  bop("AK", "PUT", "/account/push/preferences", "bearer", [], "body", null, [401, 404, 429], false),
  bop("AK", "POST", "/account/privacy/otp", "bearer", [], "body", null, [401, 429], false),
  bop("AK", "POST", "/account/privacy/export", "bearer", [], "body", null, [401, 429], false),
  bop("AK", "POST", "/account/privacy/erasure", "bearer", [], "body", "header-required", [401, 409, 429], false),
  bop("TK", "POST", "/cart/quote", "none", [], "body", null, [404, 429], false),
  bop("TK", "POST", "/orders", "optional-bearer", [], "body", "body-field", [401, 404, 409, 429], false),
  bop("TK", "GET", "/orders/{orderCode}", "none", ["phone"], null, null, [404, 429], false),
  bop("TK", "POST", "/orders/{orderCode}/payment-confirmations", "none", [], "body", "header-optional", [404, 409, 429], false),
  bop("TK", "POST", "/orders/{orderCode}/payment-proof/upload-sessions", "none", [], "body", null, [404, 429], true),
  bop("TK", "POST", "/orders/{orderCode}/payment-proof/upload-sessions/{sessionId}/finalize", "none", [], "body", null, [404, 429], true),
  bop("TK", "POST", "/orders/{orderCode}/payment-gateway/sessions", "optional-bearer", [], "body", null, [401, 404, 409, 429], false),
  bop("TK", "POST", "/orders/{orderCode}/cancel", "none", [], "body", "header-optional", [404, 409, 429], false),
  bop("TK", "POST", "/reviews", "optional-bearer", [], "body", null, [401, 404, 409, 429], false),
  bop("TK", "GET", "/booking/offerings", "optional-bearer", [], null, null, [404, 429], false),
  bop("TK", "GET", "/booking/availability", "none", ["offeringId", "resourceId", "checkInDate", "checkOutDate"], null, null, [404, 429], false),
  bop("TK", "GET", "/booking/quote", "optional-bearer", ["offeringId", "checkInDate", "checkOutDate"], null, null, [404, 429], false),

  direct("POST", "/api/v1/newsletter/subscribe", TOKO_BERITA, BULETIN, [429], false, "newsletter"),
  direct("POST", "/api/v1/newsletter/confirm", TOKO_BERITA, BULETIN, [429], false, "newsletter"),
  direct("POST", "/api/v1/newsletter/unsubscribe", TOKO_BERITA, BULETIN, [429], false, "newsletter"),
  // The page-view beacon is fire and forget: scripts/analitik.ts swallows every failure
  // (try/catch around fetch, no status read), so there is no negative case to freeze.
  direct("POST", "/api/v1/analytics/collect", ALL, ANALITIK, [], false, "beacon")
];

/** Every frozen operation, build reads first. */
export const OPERATIONS = [...BUILD_OPERATIONS, ...BROWSER_OPERATIONS];

function op(path, profiles, queryParams, readers) {
  return { phase: "build", method: "GET", path, profiles, queryParams, readers };
}

/** `${path}` keys of one operation, for sorting and lookups. */
export function opKey(entry) {
  return `${entry.method} ${entry.path}`;
}

// ---------------------------------------------------------------------------
// Slice construction and the additive-superset rule
// ---------------------------------------------------------------------------

const PROSE_KEYS = new Set(["description", "summary", "title", "example", "examples", "externalDocs", "tags"]);

/**
 * Remove documentation-only keys. A `properties` map is keyed by FIELD names,
 * so a field called `description` there is data, not prose, and is kept.
 */
export function stripProse(value, parentKey = "") {
  if (Array.isArray(value)) return value.map((item) => stripProse(item, parentKey));
  if (!value || typeof value !== "object") return value;

  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (parentKey !== "properties" && PROSE_KEYS.has(key)) continue;
    out[key] = stripProse(child, key);
  }
  return out;
}

/** Every `#/components/<group>/<name>` reachable from `value`, transitively. */
export function collectRefs(value, components, seen = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, components, seen);
    return seen;
  }
  if (!value || typeof value !== "object") return seen;

  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string") {
      const match = /^#\/components\/([^/]+)\/(.+)$/.exec(child);
      if (match && !seen.has(child)) {
        seen.add(child);
        collectRefs(components?.[match[1]]?.[match[2]], components, seen);
      }
      continue;
    }
    collectRefs(child, components, seen);
  }
  return seen;
}

function sortedObject(entries) {
  return Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The frozen slice (`paths` and `components`) of `bundle` for `operations`. */
export function buildSlice(bundle, operations = OPERATIONS) {
  const bundlePaths = bundle.paths ?? {};
  const bundleComponents = bundle.components ?? {};
  const paths = {};
  const refs = new Set();

  for (const entry of operations) {
    const pathItem = bundlePaths[entry.path];
    const method = entry.method.toLowerCase();

    if (pathItem === undefined || pathItem[method] === undefined) {
      throw new Error(
        `Consumed operation ${opKey(entry)} is not in ${BUNDLE_PATH}. Either the provider removed ` +
          "it, which breaks the storefront build, or OPERATIONS is stale."
      );
    }

    const frozenItem = (paths[entry.path] ??= {});
    // A path-level `parameters` list applies to every method; keep it.
    if (pathItem.parameters !== undefined) frozenItem.parameters = pathItem.parameters;
    frozenItem[method] = pathItem[method];
    collectRefs(frozenItem, bundleComponents, refs);
  }

  const components = {};
  for (const ref of [...refs].sort()) {
    const match = /^#\/components\/([^/]+)\/(.+)$/.exec(ref);
    const group = (components[match[1]] ??= {});
    group[match[2]] = bundleComponents[match[1]][match[2]];
  }

  return stripProse({
    paths: sortedObject(Object.entries(paths)),
    components: sortedObject(
      Object.entries(components).map(([group, entries]) => [group, sortedObject(Object.entries(entries))])
    )
  });
}

/** Is `frozen` fully contained in `current`? Added keys pass; a removal or retype does not. */
export function isAdditiveSuperset(frozen, current) {
  if (Array.isArray(frozen)) {
    if (!Array.isArray(current)) return false;
    // Arrays (enum, required, parameters) compare as sets: an added member is additive.
    return frozen.every((item) => current.some((candidate) => isAdditiveSuperset(item, candidate)));
  }
  if (frozen && typeof frozen === "object") {
    if (!current || typeof current !== "object" || Array.isArray(current)) return false;
    return Object.entries(frozen).every(([key, value]) => isAdditiveSuperset(value, current[key]));
  }
  return frozen === current;
}

const REF_PATTERN = /^#\/components\/([^/]+)\/(.+)$/;

/** `value` with every `#/components/...` reference replaced by its target; a cycle becomes `{ $cycle }`. */
export function dereference(value, components, stack = []) {
  if (Array.isArray(value)) return value.map((item) => dereference(item, components, stack));
  if (!value || typeof value !== "object") return value;

  const { $ref: ref, ...rest } = value;
  const own = Object.fromEntries(Object.entries(rest).map(([key, child]) => [key, dereference(child, components, stack)]));
  if (typeof ref !== "string") return own;

  const match = REF_PATTERN.exec(ref);
  if (!match) return value;
  if (stack.includes(ref)) return { $cycle: ref };
  const target = components?.[match[1]]?.[match[2]];
  if (target === undefined) return { $unresolved: ref };
  return { ...dereference(target, components, [...stack, ref]), ...own };
}

const asSet = (value) => new Set(Array.isArray(value) ? value : value === undefined ? [] : [value]);
const COMPOSITION = ["oneOf", "anyOf", "allOf", "not"];
const LOWER_BOUNDS = ["minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties"];
const UPPER_BOUNDS = ["maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties"];

/**
 * The REQUEST direction of the rule (issue #556): everything the consumer
 * sent before must still be accepted. Returns problems; empty means the
 * current schema still accepts every value the frozen one accepted. Both
 * arguments are already dereferenced. Conservative on purpose: a composition
 * keyword (`oneOf`, `anyOf`, `allOf`, `not`) that changed at all is a problem,
 * because proving a subset there is not worth a wrong answer.
 */
export function findRequestProblems(frozen, current, where = "body") {
  if (!frozen || typeof frozen !== "object" || Array.isArray(frozen)) return [];
  if (!current || typeof current !== "object" || Array.isArray(current)) return [`${where}: the schema is gone`];
  if (frozen.$cycle !== undefined || current.$cycle !== undefined) {
    return frozen.$cycle === current.$cycle ? [] : [`${where}: recursion changed`];
  }
  if (frozen.$unresolved !== undefined || current.$unresolved !== undefined) return [`${where}: unresolved reference`];

  const problems = [];

  for (const keyword of COMPOSITION) {
    if (JSON.stringify(frozen[keyword]) !== JSON.stringify(current[keyword])) {
      problems.push(`${where}: ${keyword} changed (a request schema with a composition keyword is compared exactly)`);
    }
  }

  if (current.type !== undefined) {
    if (frozen.type === undefined) {
      problems.push(`${where}: a type was added where the consumer relied on none`);
    } else {
      const accepted = asSet(current.type);
      for (const type of asSet(frozen.type)) {
        if (!accepted.has(type)) problems.push(`${where}: type ${type} is no longer accepted`);
      }
    }
  }
  if (frozen.nullable === true && current.nullable !== true) problems.push(`${where}: null is no longer accepted`);

  if (current.enum !== undefined) {
    if (frozen.enum === undefined) {
      problems.push(`${where}: an enum was added`);
    } else {
      const accepted = new Set(current.enum.map((value) => JSON.stringify(value)));
      for (const value of frozen.enum) {
        if (!accepted.has(JSON.stringify(value))) problems.push(`${where}: enum value ${JSON.stringify(value)} was removed`);
      }
    }
  }
  if (current.const !== undefined && JSON.stringify(current.const) !== JSON.stringify(frozen.const)) {
    problems.push(`${where}: const changed or added`);
  }
  for (const keyword of ["format", "pattern"]) {
    if (current[keyword] !== undefined && current[keyword] !== frozen[keyword]) {
      problems.push(`${where}: ${keyword} was added or changed (${JSON.stringify(frozen[keyword])} to ${JSON.stringify(current[keyword])})`);
    }
  }
  for (const keyword of LOWER_BOUNDS) {
    if (current[keyword] !== undefined && (frozen[keyword] === undefined || current[keyword] > frozen[keyword])) {
      problems.push(`${where}: ${keyword} was raised or added`);
    }
  }
  for (const keyword of UPPER_BOUNDS) {
    if (current[keyword] !== undefined && (frozen[keyword] === undefined || current[keyword] < frozen[keyword])) {
      problems.push(`${where}: ${keyword} was lowered or added`);
    }
  }
  if (current.uniqueItems === true && frozen.uniqueItems !== true) problems.push(`${where}: uniqueItems was added`);

  const frozenRequired = asSet(frozen.required);
  for (const name of asSet(current.required)) {
    if (!frozenRequired.has(name)) problems.push(`${where}: "${name}" is newly required`);
  }
  if (current.additionalProperties === false && frozen.additionalProperties !== false) {
    problems.push(`${where}: additionalProperties was closed`);
  }
  for (const [name, schema] of Object.entries(frozen.properties ?? {})) {
    const now = current.properties?.[name];
    if (now === undefined) problems.push(`${where}: property "${name}" was removed`);
    else problems.push(...findRequestProblems(schema, now, `${where}.${name}`));
  }
  if (frozen.items !== undefined) {
    if (current.items === undefined) problems.push(`${where}: items schema is gone`);
    else problems.push(...findRequestProblems(frozen.items, current.items, `${where}[]`));
  }
  return problems;
}

/** A request body object (`required`, `content`) compared in the request direction. */
function requestBodyProblems(frozenBody, currentBody, frozenComponents, currentComponents, where) {
  if (frozenBody === undefined) return [];
  if (currentBody === undefined) return [`${where}: the request body is no longer declared`];

  const frozenDeref = dereference(frozenBody, frozenComponents);
  const currentDeref = dereference(currentBody, currentComponents);
  const problems = [];
  if (currentDeref.required === true && frozenDeref.required !== true) problems.push(`${where}: the body is now required`);
  for (const [mediaType, media] of Object.entries(frozenDeref.content ?? {})) {
    const now = currentDeref.content?.[mediaType];
    if (now === undefined) problems.push(`${where}: media type ${mediaType} is no longer accepted`);
    else problems.push(...findRequestProblems(media.schema, now.schema, `${where} ${mediaType}`));
  }
  return problems;
}

function parameterKey(parameter) {
  return `${parameter.in}:${String(parameter.name).toLowerCase()}`;
}

/** Path-level plus operation-level parameters, dereferenced and keyed by `in:name`. */
function parametersOf(pathItem, operation, components) {
  const map = new Map();
  for (const raw of [...(pathItem?.parameters ?? []), ...(operation?.parameters ?? [])]) {
    const parameter = dereference(raw, components);
    if (parameter && parameter.name !== undefined) map.set(parameterKey(parameter), parameter);
  }
  return map;
}

function parameterProblems(frozenParams, currentParams, where) {
  const problems = [];
  for (const [key, parameter] of frozenParams) {
    const now = currentParams.get(key);
    if (now === undefined) {
      problems.push(`${where}: parameter ${key} is gone`);
      continue;
    }
    if (now.required === true && parameter.required !== true) problems.push(`${where}: parameter ${key} is newly required`);
    problems.push(...findRequestProblems(parameter.schema, now.schema, `${where} ${key}`));
  }
  for (const [key, parameter] of currentParams) {
    if (!frozenParams.has(key) && parameter.required === true) problems.push(`${where}: new required parameter ${key}`);
  }
  return problems;
}

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

function browserKeysOf(frozen) {
  return new Set(
    (frozen.operations ?? []).filter((entry) => entry.phase === "browser").map((entry) => `${entry.method.toLowerCase()} ${entry.path}`)
  );
}

/** Which components are reached from the response side and which from the request side of the frozen operations. */
export function componentRoles(frozen) {
  const browserKeys = browserKeysOf(frozen);
  const response = new Set();
  const request = new Set();

  for (const [pathKey, item] of Object.entries(frozen.paths ?? {})) {
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (browserKeys.has(`${method} ${pathKey}`)) {
        const { requestBody, parameters, ...rest } = operation;
        collectRefs({ requestBody, parameters: [...(item.parameters ?? []), ...(parameters ?? [])] }, frozen.components, request);
        collectRefs(rest, frozen.components, response);
      } else {
        collectRefs({ ...operation, parameters: item.parameters }, frozen.components, response);
      }
    }
  }
  return { response, request };
}

/**
 * Every frozen path/component the current bundle no longer satisfies.
 * Responses (and every build read) follow the additive-superset rule; the
 * request body and parameters of a browser operation follow the request rule.
 */
export function findContractBreaks(frozen, currentSlice) {
  const breaks = [];
  const browserKeys = browserKeysOf(frozen);
  const roles = componentRoles(frozen);

  for (const [pathKey, pathItem] of Object.entries(frozen.paths ?? {})) {
    const now = currentSlice.paths?.[pathKey];
    if (now === undefined) {
      breaks.push(`path ${pathKey} is gone from the bundle`);
      continue;
    }
    let pathHasBrowser = false;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (now[method] === undefined) {
        breaks.push(`${method.toUpperCase()} ${pathKey} is gone from the bundle`);
        continue;
      }
      if (!browserKeys.has(`${method} ${pathKey}`)) {
        if (!isAdditiveSuperset(operation, now[method])) breaks.push(`${method.toUpperCase()} ${pathKey} changed non-additively`);
        continue;
      }

      pathHasBrowser = true;
      const label = `${method.toUpperCase()} ${pathKey}`;
      const { requestBody: frozenBody, parameters: _frozenParameters, ...frozenRest } = operation;
      const { requestBody: currentBody, parameters: _currentParameters, ...currentRest } = now[method];
      if (!isAdditiveSuperset(frozenRest, currentRest)) breaks.push(`${label} changed non-additively (response side)`);
      for (const problem of requestBodyProblems(frozenBody, currentBody, frozen.components, currentSlice.components, `${label} request`)) {
        breaks.push(`${label} no longer accepts what the storefront sends: ${problem}`);
      }
      for (const problem of parameterProblems(
        parametersOf(pathItem, operation, frozen.components),
        parametersOf(now, now[method], currentSlice.components),
        `${label} request`
      )) {
        breaks.push(`${label} no longer accepts what the storefront sends: ${problem}`);
      }
    }
    if (!pathHasBrowser && pathItem.parameters !== undefined && !isAdditiveSuperset(pathItem.parameters, now.parameters)) {
      breaks.push(`path ${pathKey} parameters changed non-additively`);
    }
  }

  for (const [group, entries] of Object.entries(frozen.components ?? {})) {
    for (const [name, schema] of Object.entries(entries)) {
      const ref = `#/components/${group}/${name}`;
      const now = currentSlice.components?.[group]?.[name];
      if (now === undefined) {
        breaks.push(`components.${group}.${name} is gone from the bundle`);
        continue;
      }
      const inRequest = roles.request.has(ref);
      if ((roles.response.has(ref) || !inRequest) && !isAdditiveSuperset(schema, now)) {
        breaks.push(`components.${group}.${name} changed non-additively`);
      }
      if (inRequest) {
        const frozenDeref = dereference(schema, frozen.components, [ref]);
        const currentDeref = dereference(now, currentSlice.components, [ref]);
        let problems;
        if (group === "parameters") {
          problems = parameterProblems(
            new Map([[parameterKey(frozenDeref), frozenDeref]]),
            new Map([[parameterKey(frozenDeref), currentDeref]]),
            `components.${group}.${name}`
          );
        } else if (group === "requestBodies") {
          problems = requestBodyProblems(schema, now, frozen.components, currentSlice.components, `components.${group}.${name}`);
        } else {
          problems = findRequestProblems(frozenDeref, currentDeref, `components.${group}.${name}`);
        }
        for (const problem of problems) {
          breaks.push(`components.${group}.${name} no longer accepts what the storefront sends: ${problem}`);
        }
      }
    }
  }

  return breaks;
}

/**
 * Query and header parameters the consumer sends that the bundle no longer
 * declares (looked up through `$ref` to `components.parameters`).
 */
export function findUndeclaredQueryParams(bundle, operations = OPERATIONS) {
  const problems = [];

  for (const entry of operations) {
    const pathItem = bundle.paths?.[entry.path];
    const operation = pathItem?.[entry.method.toLowerCase()];
    if (!operation) continue; // reported by buildSlice / findContractBreaks

    const declared = { query: new Set(), header: new Set() };
    for (const parameter of [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]) {
      const resolved = parameter?.$ref
        ? bundle.components?.parameters?.[/^#\/components\/parameters\/(.+)$/.exec(parameter.$ref)?.[1]]
        : parameter;
      if (typeof resolved?.name !== "string") continue;
      if (resolved.in === "query") declared.query.add(resolved.name);
      if (resolved.in === "header") declared.header.add(resolved.name.toLowerCase());
    }

    for (const name of entry.queryParams) {
      if (!declared.query.has(name)) problems.push(`${opKey(entry)} no longer declares query parameter "${name}"`);
    }
    for (const name of entry.headerParams ?? []) {
      if (!declared.header.has(name.toLowerCase())) problems.push(`${opKey(entry)} no longer declares header parameter "${name}"`);
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

export const FIXTURE_NOTICE =
  "FROZEN: the storefront's build-time reads (issue #555) and browser calls (issue #556), ADR-0058. Generated by `bun run contract:storefront:generate`; do NOT hand-edit. Regenerating is a DELIBERATE act that means the contract changed and the storefront must change with it; say why in the PR. Additive provider changes need no regeneration: responses are a subset assertion; request bodies and parameters are the reverse (the provider must keep accepting what the storefront sends).";

export const FIXTURE_SCHEMA_VERSION = 2;

/** The complete fixture object for `bundle`. */
export function buildFixture(bundle) {
  const operations = [...OPERATIONS].sort((a, b) => (opKey(a) < opKey(b) ? -1 : 1));
  return {
    _frozen: FIXTURE_NOTICE,
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    consumer: "apps/storefront",
    bundle: BUNDLE_PATH,
    profileNote: PROFILE_NOTE,
    operations,
    outOfBundle: OUT_OF_BUNDLE,
    pendingUpstream: PENDING_UPSTREAM,
    requestBodyUndeclared: REQUEST_BODY_UNDECLARED,
    ...buildSlice(bundle, operations)
  };
}

export function serializeFixture(fixture) {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

/** Operations a profile builds. */
export function operationsForProfile(fixtureOrOps, profile) {
  const list = Array.isArray(fixtureOrOps) ? fixtureOrOps : fixtureOrOps.operations;
  return list.filter((entry) => entry.profiles.includes(profile));
}

// ---------------------------------------------------------------------------
// The source guard (build phase)
// ---------------------------------------------------------------------------

const SRC = "apps/storefront/src";
/** Browser-only code: a request there is a browser call (issue #556), not a build read. */
const BROWSER_DIRS = [`${SRC}/scripts`];
/** Where a build read must not appear except through a registered reader. */
const RENDER_DIRS = ["pages", "profil", "layouts", "components", "install", "push"].map((dir) => `${SRC}/${dir}`);

function walk(root, dir, out = []) {
  let names;
  try {
    names = readdirSync(join(root, dir));
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) walk(root, rel, out);
    else if (/\.(ts|mjs|js|astro)$/.test(name)) out.push(rel);
  }
  return out;
}

/** Comments removed, so a path named in a docblock is not mistaken for a read. */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/(\s)\/\/\s.*$/gm, "$1");
}

/** `/api/v1/...` and `/theming/...` string/template literals, `${...}` normalised to `{param}`. */
export function extractPathLiterals(code) {
  const found = new Set();
  // The leading `}` covers `${origin}/theming/...`, the one shape that has no opening quote.
  for (const match of code.matchAll(/(?:["'`]|\})(\/(?:api\/v1|theming)\/[^"'`\s?]*)["'`?]/g)) {
    found.add(match[1].replace(/\$\{[^}]*\}/g, "{param}"));
  }
  return found;
}

/** Map a normalised literal onto a frozen path template (`{param}` matches any `{name}`). */
function samePath(literal, template) {
  const normalise = (value) => value.replace(/\{[^}]*\}/g, "{param}");
  return normalise(literal) === normalise(template);
}

/**
 * Scan the storefront source for build-time reads.
 *
 * Returns `{ readerFiles, literalsByFile, renderStrays, fetchInAwcmsLib }`:
 *  - `readerFiles`: files outside the browser dirs that call `awcmsGet` (other
 *    than the client itself) or contain a `/theming/` literal;
 *  - `literalsByFile`: the path literals in each of those files;
 *  - `renderStrays`: awcms path literals in a render directory (pages, layouts,
 *    components, ...), where there must be none;
 *  - `fetchInAwcmsLib`: files under `src/lib/awcms/` that call `fetch(`.
 */
export function scanBuildReadSources(root) {
  const files = walk(root, SRC).filter((rel) => !BROWSER_DIRS.some((dir) => rel.startsWith(`${dir}/`)));
  const readerFiles = [];
  const literalsByFile = {};
  const renderStrays = [];
  const fetchInAwcmsLib = [];

  for (const rel of files) {
    if (rel === `${SRC}/lib/awcms/client.ts`) continue;

    const code = stripComments(readFileSync(join(root, rel), "utf8"));
    const literals = extractPathLiterals(code);
    const callsAwcms = /\bawcmsGet\s*[<(]/.test(code);
    const readsTheming = [...literals].some((literal) => literal.startsWith("/theming/"));

    if (rel.startsWith(`${SRC}/lib/awcms/`) && /\bfetch\s*\(/.test(code)) fetchInAwcmsLib.push(rel);

    if (callsAwcms || readsTheming) {
      readerFiles.push(rel);
      literalsByFile[rel] = [...literals].sort();
    } else if (literals.size > 0 && RENDER_DIRS.some((dir) => rel.startsWith(`${dir}/`))) {
      renderStrays.push({ file: rel, literals: [...literals].sort() });
    }
  }

  return { readerFiles, literalsByFile, renderStrays, fetchInAwcmsLib };
}

/**
 * Compare a scan with the frozen operations. Returns human-readable problems;
 * empty means the source and the slice agree.
 */
export function compareScanToSlice(scan, operations = BUILD_OPERATIONS, outOfBundle = OUT_OF_BUNDLE) {
  const problems = [];
  const all = [...operations, ...outOfBundle];
  const registeredReaders = new Set(all.flatMap((entry) => entry.readers));

  for (const file of scan.readerFiles) {
    if (!registeredReaders.has(file)) {
      problems.push(
        `${file} reads awcms at build time but is not a reader of any frozen operation. ` +
          "Add its operation(s) to OPERATIONS in tools/lib/storefront-consumer-contract.mjs and regenerate."
      );
    }
  }

  for (const file of registeredReaders) {
    if (!scan.readerFiles.includes(file)) {
      problems.push(`${file} is registered as a reader but no longer reads awcms at build time (stale entry).`);
    }
  }

  for (const [file, literals] of Object.entries(scan.literalsByFile)) {
    for (const literal of literals) {
      const registered = all.some(
        (entry) => entry.readers.includes(file) && samePath(literal, entry.path)
      );
      if (!registered) {
        problems.push(
          `${file} reads ${literal} at build time, which is not frozen for that file. ` +
            "Freeze it (OPERATIONS, then regenerate) with a reason in the PR."
        );
      }
    }
  }

  for (const entry of all) {
    for (const file of entry.readers) {
      const literals = scan.literalsByFile[file] ?? [];
      if (scan.readerFiles.includes(file) && !literals.some((literal) => samePath(literal, entry.path))) {
        problems.push(`${opKey(entry)} is frozen but ${file} no longer names that path (stale entry).`);
      }
    }
  }

  for (const stray of scan.renderStrays) {
    problems.push(
      `${stray.file} names an awcms path (${stray.literals.join(", ")}) outside the registered readers. ` +
        "Build-time reads go through src/lib/awcms/ or src/lib/catalog.ts so they can be frozen."
    );
  }

  for (const file of scan.fetchInAwcmsLib) {
    if (!outOfBundle.some((entry) => entry.readers.includes(file))) {
      problems.push(`${file} calls fetch() directly but is not a registered out-of-bundle reader.`);
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// The source guard (browser phase, issue #556)
// ---------------------------------------------------------------------------

/**
 * Files that may contain a `fetch(`, `sendBeacon(`, `XMLHttpRequest`, `EventSource`
 * or `WebSocket`. A request transport anywhere else is a new way for the browser
 * to reach awcms that nothing froze, so it fails until it is registered here.
 */
const KNOWN_TRANSPORTS = {
  [`${LIB}/toko-permintaan.ts`]: "the one browser transport for /api/v1/commerce/storefront (kirimPermintaan)",
  "apps/storefront/src/scripts/buletin.ts": "direct newsletter transport (frozen as the three /api/v1/newsletter operations)",
  "apps/storefront/src/scripts/analitik.ts": "direct page-view beacon (frozen as POST /api/v1/analytics/collect)",
  [`${LIB}/awcms/client.ts`]: "build-time awcmsGet client (the build phase of this slice)",
  [`${LIB}/awcms/theme.ts`]: "build-time tokens.css read (OUT_OF_BUNDLE)",
  [`${LIB}/wilayah-region-select.ts`]: "same-origin static /index/wilayah-*.json, not awcms",
  "apps/storefront/src/scripts/produk-index-klien.ts": "same-origin static /index/produk.json, not awcms",
  "apps/storefront/src/profil/berita/pages/cari-berita.astro": "same-origin static /index/berita.json, not awcms"
};
export const REQUEST_TRANSPORT_FILES = Object.keys(KNOWN_TRANSPORTS);

const TRANSPORT_PATTERN = /\bfetch\s*\(|\bsendBeacon\s*\(|\bXMLHttpRequest\b|\bnew\s+EventSource\b|\bnew\s+WebSocket\b/;

/** `const NAME = "/literal"` declarations in one file, for `${NAME}` inside a path. */
function stringConstants(code) {
  const constants = {};
  for (const match of code.matchAll(/\bconst\s+(\w+)\s*=\s*["'](\/[^"']*)["']\s*;/g)) constants[match[1]] = match[2];
  return constants;
}

/** `/account/orders${query}` and `/booking/quote?${p}` both name the path `/account/orders` / `/booking/quote`. */
function normaliseStorefrontPath(raw, constants) {
  let path = raw.replace(/\$\{(\w+)\}/g, (whole, name) => constants[name] ?? whole);
  path = path.replace(/\$\{[^}]*\}/g, "{param}");
  const query = path.indexOf("?");
  if (query >= 0) path = path.slice(0, query);
  // A trailing placeholder glued to a word (`/orders{param}`) is a query suffix, not a path segment.
  path = path.replace(/([A-Za-z0-9_-])\{param\}$/, "$1");
  return `${SF}${path}`;
}

/**
 * Scan the storefront source for browser calls.
 *
 * Returns `{ calls, strayTransports, staleTransports, literalStrays }`:
 *  - `calls`: `{ file, method, path, wrapped }` for every `kirimPermintaan(...)`
 *    call site (`wrapped` is true when it sits directly inside
 *    `denganPembersihanSesi`, which clears the session on a 401), and for each
 *    operation the two direct transports name;
 *  - `strayTransports`: files outside `KNOWN_TRANSPORTS` that contain a request transport;
 *  - `staleTransports`: files in `KNOWN_TRANSPORTS` that no longer contain one;
 *  - `literalStrays`: files that name an `/api/v1/` path but are neither a build
 *    reader, a browser reader nor a known transport.
 */
export function scanBrowserCallSources(root) {
  const files = walk(root, SRC);
  const calls = [];
  const strayTransports = [];
  const staleTransports = [];
  const literalStrays = [];

  const browserReaders = new Set([...BROWSER_OPERATIONS.flatMap((entry) => entry.readers), ...REQUEST_TRANSPORT_FILES]);

  for (const rel of files) {
    const code = stripComments(readFileSync(join(root, rel), "utf8"));
    const constants = stringConstants(code);
    const isTransport = TRANSPORT_PATTERN.test(code);

    if (isTransport && !(rel in KNOWN_TRANSPORTS)) strayTransports.push(rel);

    for (const match of code.matchAll(
      /\bkirimPermintaan\s*(?:<[^()]*?>)?\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1\s*,\s*["'](GET|POST|PUT|PATCH|DELETE)["']/g
    )) {
      const before = code.slice(Math.max(0, match.index - 80), match.index);
      calls.push({
        file: rel,
        method: match[3],
        path: normaliseStorefrontPath(match[2], constants),
        wrapped: /denganPembersihanSesi\(\s*\(\)\s*=>\s*$/.test(before)
      });
    }

    if (rel === "apps/storefront/src/scripts/buletin.ts") {
      const prefix = Object.values(constants).find((value) => value.startsWith("/api/v1/newsletter"));
      for (const match of code.matchAll(/\brequest\(\s*["'](\/[a-z-]+)["']/g)) {
        if (prefix) calls.push({ file: rel, method: "POST", path: `${prefix}${match[1]}`, wrapped: false });
      }
    }
    if (rel === "apps/storefront/src/scripts/analitik.ts") {
      for (const value of Object.values(constants)) {
        if (value.startsWith("/api/v1/") && /method:\s*["']POST["']/.test(code)) {
          calls.push({ file: rel, method: "POST", path: value, wrapped: false });
        }
      }
    }

    if (rel in KNOWN_TRANSPORTS && !isTransport) staleTransports.push(rel);

    const buildReader = /\bawcmsGet\s*[<(]/.test(code) || rel.startsWith(`${SRC}/lib/awcms/`);
    if (!buildReader && !browserReaders.has(rel) && extractPathLiterals(code).size > 0) {
      literalStrays.push({ file: rel, literals: [...extractPathLiterals(code)].sort() });
    }
  }

  calls.sort((a, b) => (`${a.file} ${a.method} ${a.path}` < `${b.file} ${b.method} ${b.path}` ? -1 : 1));
  return { calls, strayTransports, staleTransports, literalStrays };
}

/**
 * Compare a browser scan with the frozen browser operations. Returns
 * human-readable problems; empty means the source and the slice agree.
 */
export function compareBrowserScanToSlice(scan, operations = BROWSER_OPERATIONS) {
  const problems = [];

  for (const call of scan.calls) {
    const entry = operations.find(
      (candidate) => candidate.method === call.method && samePath(call.path, candidate.path) && candidate.readers.includes(call.file)
    );
    if (!entry) {
      problems.push(
        `${call.file} calls ${call.method} ${call.path} in the browser, which is not frozen for that file. ` +
          "Add it to BROWSER_OPERATIONS in tools/lib/storefront-consumer-contract.mjs (with its negative cases) and regenerate."
      );
    } else if (entry.auth === "bearer" && call.file.endsWith("/akun-klien.ts") && !call.wrapped) {
      problems.push(
        `${opKey(entry)} requires a bearer session but its call in ${call.file} is not inside denganPembersihanSesi, ` +
          "so a 401 UNAUTHENTICATED would not clear the stored session (AGENTS.md, bearer-session rule)."
      );
    }
  }

  for (const entry of operations) {
    for (const file of entry.readers) {
      const seen = scan.calls.some(
        (call) => call.file === file && call.method === entry.method && samePath(call.path, entry.path)
      );
      if (!seen) problems.push(`${opKey(entry)} is frozen but ${file} no longer calls it in the browser (stale entry).`);
    }
  }

  for (const file of scan.strayTransports) {
    problems.push(
      `${file} contains a request transport (fetch, sendBeacon, XMLHttpRequest, EventSource or WebSocket) that is not registered. ` +
        "Route browser calls through kirimPermintaan, or register the file in KNOWN_TRANSPORTS with a reason and freeze what it calls."
    );
  }
  for (const file of scan.staleTransports) {
    problems.push(`${file} is a registered transport but no longer contains one (stale registration).`);
  }
  for (const stray of scan.literalStrays) {
    problems.push(
      `${stray.file} names an awcms path (${stray.literals.join(", ")}) but is neither a build reader, a browser reader nor a known transport.`
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Negative cases and request bodies (issue #556)
// ---------------------------------------------------------------------------

/**
 * Check the negative cases of every browser operation: each has evidence that
 * is still in the source, a status the bundle declares (or, for 429 only, a
 * `pending` marker), and a bearer operation still declares its 401.
 */
export function findNegativeCaseProblems(bundle, root, operations = BROWSER_OPERATIONS) {
  const problems = [];
  const texts = new Map();
  const textOf = (file) => {
    if (!texts.has(file)) {
      try {
        texts.set(file, stripComments(readFileSync(join(root, file), "utf8")));
      } catch {
        texts.set(file, null);
      }
    }
    return texts.get(file);
  };

  for (const entry of operations) {
    const declared = new Set(Object.keys(bundle.paths?.[entry.path]?.[entry.method.toLowerCase()]?.responses ?? {}));

    for (const negative of entry.negatives) {
      const where = `${opKey(entry)} negative case ${negative.status}`;
      const text = textOf(negative.evidence.file);
      if (text === null) problems.push(`${where}: evidence file ${negative.evidence.file} does not exist.`);
      else if (!text.includes(negative.evidence.token)) {
        problems.push(`${where}: ${negative.evidence.file} no longer contains \`${negative.evidence.token}\` (the handling it evidences is gone or moved).`);
      }

      if (negative.pending !== undefined) {
        if (PENDING_UPSTREAM[negative.status] === undefined) {
          problems.push(`${where}: only ${Object.keys(PENDING_UPSTREAM).join(", ")} may be pending upstream.`);
        }
      } else if (!declared.has(String(negative.status))) {
        problems.push(
          `${where}: the storefront handles it but the bundle does not declare ${negative.status}, and the case is not marked pending upstream.`
        );
      }
    }

    if (entry.auth === "bearer" && !entry.negatives.some((negative) => negative.status === 401)) {
      problems.push(`${opKey(entry)} sends a required bearer but records no 401 negative case.`);
    }
  }
  return problems;
}

/** Pending markers the bundle has since resolved (informational: adoption is issue #557). */
export function findResolvedPending(bundle, operations = BROWSER_OPERATIONS) {
  const resolved = [];
  for (const entry of operations) {
    const declared = new Set(Object.keys(bundle.paths?.[entry.path]?.[entry.method.toLowerCase()]?.responses ?? {}));
    for (const negative of entry.negatives) {
      if (negative.pending !== undefined && declared.has(String(negative.status))) {
        resolved.push(`${opKey(entry)} now declares ${negative.status}; drop its pending marker (issue #557)`);
      }
    }
  }
  return resolved;
}

/**
 * A browser operation whose consumer sends a body must have one declared, so
 * the request rule has something to freeze; the known exceptions are named in
 * REQUEST_BODY_UNDECLARED and must disappear once the bundle declares the body.
 */
export function findRequestBodyGaps(bundle, operations = BROWSER_OPERATIONS, undeclared = REQUEST_BODY_UNDECLARED) {
  const problems = [];
  for (const entry of operations) {
    if (!entry.sendsBody) continue;
    const declaredBody = bundle.paths?.[entry.path]?.[entry.method.toLowerCase()]?.requestBody !== undefined;
    const exempt = undeclared[opKey(entry)] !== undefined;
    if (!declaredBody && !exempt) {
      problems.push(`${opKey(entry)} sends a request body that the bundle does not declare, and it is not listed in REQUEST_BODY_UNDECLARED.`);
    }
    if (declaredBody && exempt) {
      problems.push(`${opKey(entry)} is listed in REQUEST_BODY_UNDECLARED but the bundle now declares its body: remove the entry and regenerate so the body is frozen.`);
    }
  }
  for (const key of Object.keys(undeclared)) {
    if (!operations.some((entry) => opKey(entry) === key)) problems.push(`REQUEST_BODY_UNDECLARED names ${key}, which is not a browser operation.`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Everything the gate asserts, in one place (CLI and test both call this)
// ---------------------------------------------------------------------------

/** The fixture must say exactly what OPERATIONS and OUT_OF_BUNDLE say. */
export function findFixtureDrift(frozen) {
  const problems = [];
  const sorted = [...OPERATIONS].sort((a, b) => (opKey(a) < opKey(b) ? -1 : 1));
  if (JSON.stringify(frozen.operations) !== JSON.stringify(sorted)) {
    problems.push(
      "the fixture's operations differ from OPERATIONS. Re-freeze deliberately: " +
        'bun run contract:storefront:generate --reason "<why>".'
    );
  }
  if (JSON.stringify(frozen.outOfBundle) !== JSON.stringify(OUT_OF_BUNDLE)) {
    problems.push("the fixture's outOfBundle list differs from OUT_OF_BUNDLE (regenerate deliberately).");
  }
  if (frozen.schemaVersion !== FIXTURE_SCHEMA_VERSION) {
    problems.push(`the fixture's schemaVersion is ${frozen.schemaVersion}, the checker expects ${FIXTURE_SCHEMA_VERSION}.`);
  }
  if (JSON.stringify(frozen.pendingUpstream) !== JSON.stringify(PENDING_UPSTREAM)) {
    problems.push("the fixture's pendingUpstream differs from PENDING_UPSTREAM (regenerate deliberately).");
  }
  if (JSON.stringify(frozen.requestBodyUndeclared) !== JSON.stringify(REQUEST_BODY_UNDECLARED)) {
    problems.push("the fixture's requestBodyUndeclared differs from REQUEST_BODY_UNDECLARED (regenerate deliberately).");
  }
  return problems;
}

/** Run every check; returns problems, empty when green. `root` is the repo root. */
export function runChecks({ frozen, bundle, root }) {
  const problems = [...findFixtureDrift(frozen)];

  let current;
  try {
    current = buildSlice(bundle, frozen.operations);
  } catch (error) {
    problems.push(error.message);
  }
  if (current) problems.push(...findContractBreaks(frozen, current));

  problems.push(...findUndeclaredQueryParams(bundle, frozen.operations));
  problems.push(...compareScanToSlice(scanBuildReadSources(root)));
  problems.push(...compareBrowserScanToSlice(scanBrowserCallSources(root)));
  problems.push(...findNegativeCaseProblems(bundle, root));
  problems.push(...findRequestBodyGaps(bundle));
  return problems;
}
