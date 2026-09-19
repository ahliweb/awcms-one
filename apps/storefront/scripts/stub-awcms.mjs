#!/usr/bin/env bun
/**
 * A local stand-in for awcms, used ONLY to prove `bun run build` produces a
 * real `dist/client` without a live CMS (issue #5 acceptance: "builds
 * against a stubbed CMS response"). Serves the two commerce endpoints
 * `src/lib/catalog.ts` calls, reading their response bodies straight from
 * the fixtures committed at `tests/fixtures/awcms/` — the shape this script
 * answers with is exactly the shape a reviewer can already read as plain
 * JSON, not a shape hidden inside this script. Both fixtures hold the real
 * `{ items, nextCursor }` keyset page shape `apps/cms`'s commerce routes
 * actually return inside `ok({...})` (issue #6 caught this script previously
 * agreeing with an invented `{ products }` / `{ categories }` shape instead
 * of the true one).
 *
 * Not part of the production build or image: nothing under `scripts/` is
 * imported by `astro.config.mjs`, `src/`, or `server/penyaji.mjs`, and this
 * file is not wired into any `package.json` script — it is a manual,
 * explicit step for local/CI verification against a build that has no live
 * CMS to reach.
 *
 * Usage (two terminals):
 *   bun scripts/stub-awcms.mjs
 *   AWCMS_API_URL=http://localhost:4310 AWCMS_API_TOKEN=stub-token \
 *     SITE_URL=http://localhost:4321 bun run build
 *
 * Issue #24 adds four more routes, all read straight from committed
 * fixtures the same way the two commerce ones already are:
 *
 *   - `/api/v1/site-profile/composed` — `site-profile-composed.json`
 *     (`src/lib/awcms/profil.ts`).
 *   - `/api/v1/blog/pages/public` — `blog-pages-public.json`, and
 *     `/api/v1/blog/pages/public/{slug}` — one entry of
 *     `blog-pages-public-detail.json`, keyed by slug (`src/lib/awcms/
 *     pages.ts`).
 *   - `/theming/{tenantCode}/tokens.css` — `tokens.css`, served RAW
 *     (`text/css`, not the `{success,data}` envelope) and with NO
 *     Authorization check, because the real route
 *     (`apps/cms/src/modules/theming/presentation/theme-public-css.ts`) is
 *     genuinely public — see `src/lib/awcms/theme.ts`'s docblock for why
 *     this app calls that route and not `GET /api/v1/theming`. `tenantCode`
 *     in the path is accepted but ignored, same as every other stub route
 *     ignoring which tenant a token belongs to.
 *
 * Issue #28 adds six more, all read straight from committed fixtures the
 * same way, and all ignoring their query parameters exactly the way the
 * commerce routes above already do (one fixture page is "the whole
 * response", regardless of `?status=`/`?order=`/`?cursor=`/etc.):
 *
 *   - `/api/v1/blog/posts` — `blog-posts.json` (`src/lib/awcms/blog.ts`,
 *     `{ posts, nextCursor: null }`, `view=full` shape).
 *   - `/api/v1/blog/terms` — `blog-terms.json` (`{ terms, nextCursor: null }`).
 *   - `/api/v1/blog/institutions` — `blog-institutions.json`
 *     (`{ institutions }`, genuinely unpaginated — see that file's docblock).
 *   - `/api/v1/idn-regions/regions` — `regions-kalteng.json`
 *     (`src/lib/awcms/wilayah.ts`, `{ datasetCode, items, nextCursor: null,
 *     reason: null }`). `/api/v1/idn-regions/regions/{code}` (the by-code
 *     detail route) has NO stub entry: `wilayah.ts` only ever calls the list
 *     route.
 *   - `/api/v1/news-portal/ad-placements/active` — `ad-placements-active.json`
 *     (`{ slots }`).
 *   - `/api/v1/seo/redirects` — `seo-redirects-legacy.json`
 *     (`{ redirects, nextCursor: null }`).
 *
 * Issue #27 adds six more, per the #26⇄#27 contract
 * (`commerce-public-read-models.md`) — every response here is the array/
 * object shape directly, NOT `{items, nextCursor}` (these read models are
 * small by construction, per that document):
 *
 *   - `/api/v1/commerce/store-settings/public` — `store-settings-public.json`.
 *   - `/api/v1/commerce/sliders/active` — `sliders-active.json`.
 *   - `/api/v1/commerce/flash-sales/active` — `flash-sales-active.json`.
 *   - `/api/v1/commerce/vouchers/public` — `vouchers-public.json`.
 *   - `/api/v1/commerce/testimonials/active` — `testimonials-active.json`.
 *   - `/api/v1/commerce/popups/active` — `popups-active.json` (a single
 *     object or `null`, matching what `src/lib/awcms/pemasaran.ts` expects).
 *
 * Issue #47 adds two more, the `media_library` read surface
 * `src/lib/awcms/media.ts` calls:
 *
 *   - `GET /api/v1/media/objects?ids=` — filters `media-objects.json` (an
 *     object keyed by media id, verified field-for-field against
 *     `ResolvedMediaReferenceDTO`) by the requested `ids`, answering
 *     `{ items, unresolved }` exactly like the real route
 *     (`apps/cms/src/pages/api/v1/media/objects/index.ts`): a requested id
 *     not in the fixture comes back in `unresolved`, never dropped silently.
 *   - `GET /api/v1/media/public-origin` — `media-public-origin.json`
 *     (`{ configured, origin, baseUrl }`), read by `src/pages/csp.json.ts`.
 *
 * Issue #49 adds the `visitor_analytics` read `src/lib/awcms/analitik.ts`
 * calls for the sidebar's "Terpopuler":
 *
 *   - `GET /api/v1/analytics/pages?range=7d` — `analytics-pages.json`
 *     (`{ range, pages: [{ name, count }] }`, verified against
 *     `apps/cms/src/pages/api/v1/analytics/pages.ts`'s `ok({ range, pages })`
 *     and `fetchTopPaths`'s `NamedCount`). Like the real route, a `range`
 *     outside `24h|7d|30d|12m` is a `400 VALIDATION_ERROR`, so a client
 *     that sent the wrong parameter fails here rather than passing on a
 *     stub more lenient than the CMS. The fixture deliberately mixes
 *     post paths with the home page, a store path, a rubrik page, a
 *     query-string variant of an already-listed post, and a post slug no
 *     fixture post has — every shape `hitungTayangPerSlug` must ignore or
 *     fold, so the build proves the mapping, not just the fetch.
 *
 * Issue #30 adds a DIFFERENT kind of route: `/api/v1/commerce/storefront/*`,
 * the ANONYMOUS cross-origin endpoints `src/lib/toko-klien.ts` calls
 * straight from the BROWSER, per the #29⇄#30 contract
 * (`commerce-storefront-endpoints.md` in the manager's scratchpad) — this is
 * the stub the CMS agent's own #29 implementation is built against IN
 * PARALLEL, so it is deliberately a faithful, if minimal, STATE MACHINE
 * (quote → create order → track → confirm payment → cancel) rather than one
 * more fixture-backed GET:
 *
 *   - Every route lives under `STOREFRONT_PREFIX`, is reachable with NO
 *     bearer token, and is handled BEFORE the bearer-token gate below.
 *   - The tenant is "resolved" from the request `Origin` header — this stub
 *     has exactly one tenant, so "resolved" means "the `Origin` equals
 *     `STUB_ALLOWED_ORIGIN`" (default `http://localhost:4321`, overridable
 *     for a Playwright run against a different preview port). Any other
 *     Origin (missing, mismatched) gets the SAME neutral `404 NOT_FOUND`
 *     body a real unresolvable tenant would, per the contract.
 *   - `OPTIONS` is answered on every one of these routes; every actual
 *     response carries `Access-Control-Allow-Origin` (echoed, never `*`),
 *     `Vary: Origin`, and `Cache-Control: private, no-store` —
 *     `Access-Control-Allow-Credentials` is never set, matching
 *     `toko-klien.ts`'s `credentials: "omit"`.
 *   - State (orders, payment confirmations, idempotency keys) lives in a
 *     plain in-memory `Map`, reset every time this process restarts — there
 *     is no database here, on purpose; this script's whole job is proving
 *     the BROWSER-side contract, not simulating persistence.
 *
 * Issue #88 adds `/account/*` to that same state machine, per the #86
 * contract:
 *
 *   - `POST …/account/otp/request` — always `202 {sent:true,
 *     expiresInSeconds:600}` (anti-enumeration); remembers `purpose` and, for
 *     `purpose:"register"`, the `{name, phone}` given at request time,
 *     keyed by the normalized e-mail — applied at verify, never re-asked.
 *   - `POST …/account/otp/verify` — the code is always `123456`; anything
 *     else is `401 OTP_INVALID`. `purpose:"login"` for an e-mail with no
 *     seeded/registered account is `404 ACCOUNT_NOT_FOUND`.
 *     `purpose:"register"` whose remembered phone already belongs to a
 *     DIFFERENT account is `409 PHONE_ALREADY_REGISTERED`. A successful
 *     verify returns `{token: "cs_stub_"+n, expiresAt, account}` and starts
 *     a session.
 *   - `GET`/`PATCH …/account/me`, `POST …/account/logout` — bearer-only;
 *     missing/unknown/expired token is `401 UNAUTHENTICATED`, matching #86's
 *     own rule.
 *   - One account is seeded from `tests/fixtures/awcms/
 *     customer-accounts.json` (`budi@example.test`, `+6281234567890`) so
 *     `purpose:"login"` has something real to authenticate against without
 *     a prior register step.
 *
 * Issue #90 (S2) grows the same account object with `addresses`/`wishlist`/
 * `reviews` arrays and adds their own bearer-only routes (`GET/POST
 * /account/addresses`, `PATCH|DELETE|POST …/default`, `GET|PUT
 * /account/wishlist`, `DELETE /account/wishlist/{productId}`, `GET
 * /account/orders[?cursor=]`, `GET /account/orders/{orderCode}`, `GET
 * /account/reviews`) — every one inside `handleAccountRequest`, below the
 * #88 routes it already handles. `budi@example.test` is additionally seeded
 * with two addresses (one `isDefault`) and two orders, one dated BEFORE
 * `historyFrom` (must NOT appear in `GET /account/orders`) and one after
 * (must) — see `seedAccountOrders`'s own docblock. `POST …/orders` and
 * `POST …/reviews` (the pre-existing ANONYMOUS routes) now also accept an
 * OPTIONAL Bearer, binding the created record to that account when one is
 * present and valid — every existing anonymous caller is unaffected.
 *
 * Issue #93 (S3, #86's own D5) grows the same account object with
 * `affiliate`/`commissions`, and adds `GET/POST /account/affiliate` and
 * `GET /account/affiliate/commissions[?cursor=]`. `budi@example.test` is
 * seeded ALREADY ENROLLED with three commissions, one per status
 * (pending/approved/paid) — see `SEEDED_KOMISI`'s own docblock; a freshly
 * registered account starts with `affiliate: null` so `POST …/account/
 * affiliate` itself is exercised by enrolling a NEW account, not the seeded
 * one. `POST …/orders` records `body.affiliateCode` on the created order
 * (`order.affiliateCode`) when present — this stub does not go further and
 * simulate a commission being created when an order reaches `completed`
 * (#86's own D5 describes that as the CMS's job, not this storefront-only
 * stub's).
 *
 * Issue #112 (S2 of #33, contract: #106 D3) adds the payment-gateway
 * lifecycle: `store-settings-public.json`'s `payment.gatewayEnabled: true`
 * lists `gateway` in `computeQuote`'s own `paymentMethods[]`; `POST
 * …/orders/{code}/payment-gateway/sessions` mints (idempotently, per order)
 * a session pointing at THIS process's own `GET /stub/gateway/{sessionId}`
 * page — a tiny, un-styled HTML page with "Bayar (simulasi)"/"Batal" forms,
 * deliberately served OUTSIDE `STOREFRONT_PREFIX`'s CORS/`Origin` gate (see
 * `handleStubGatewayPage`'s own docblock for why) — which flips the order to
 * `paid` or leaves it, then `302`s back to the storefront's own `/pesanan?
 * kode=`.
 *
 * Issue #115 (S3 of #33, contract: #106 D5/D8/D9) adds:
 *
 *   - `via?: "email"|"whatsapp"` on `POST …/account/otp/request` (default
 *     `"email"`); `via:"whatsapp"` is LOGIN-only, keyed by `phone` rather
 *     than `email`, and answers `409 CHANNEL_UNAVAILABLE` when
 *     `store-settings-public.json`'s own `whatsappOtpEnabled` is not `true`
 *     — the same field this app's build reads to decide whether to render
 *     the channel choice at all. `POST …/otp/verify` accepts `{phone, code,
 *     purpose:"login"}` for that path, resolving the account by phone
 *     instead of e-mail. The fixture account (`budi@example.test`,
 *     `+6281234567890`) is what a WhatsApp login authenticates against —
 *     the same OTP code (`123456`) as the e-mail path.
 *   - `marketingConsent: boolean` on every account (default `false`,
 *     `true` for the seeded fixture account), read/written by
 *     `GET`/`PATCH …/account/me`.
 *   - `awcms_commerce_conversations`/`…_messages`'s own bearer routes:
 *     `GET/POST …/account/conversations`, `GET …/account/conversations/
 *     {id}` (marks the thread read), `POST …/account/conversations/{id}/
 *     messages` (`409 CONVERSATION_CLOSED` once `status` is `"closed"`,
 *     `400 VALIDATION_ERROR` over 4000 characters). The fixture account is
 *     seeded with one OPEN thread carrying an unread store reply and one
 *     CLOSED thread, so `/akun/pesan`'s unread badge and "closed thread
 *     shows a note" behaviour are both exercised with no manual message
 *     first; every new customer message additionally schedules a
 *     SIMULATED store auto-reply 2 seconds later (this issue's own "so
 *     unread flags are exercised" requirement) — a `setTimeout` against
 *     this process's own in-memory state, never persisted.
 *
 * See `handleStorefrontRequest` below for the route table itself.
 */
import { readFileSync } from "node:fs";

const PORT = Number(process.env.STUB_PORT ?? 4310);
const FIXTURES = new URL("../tests/fixtures/awcms/", import.meta.url);

function fixture(name) {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
}

function rawFixture(name) {
  return readFileSync(new URL(name, FIXTURES), "utf8");
}

/**
 * Filters a `regions-kalteng.json`-shaped page by the SAME `level`/
 * `parentCode` query parameters the real `GET /api/v1/idn-regions/regions`
 * accepts (`region-lookup.ts`) — see the `ROUTES` entry's own comment for
 * why this stopped being safe to skip once the fixture grew a second
 * province.
 */
function filterRegions(page, url) {
  const levelParam = url.searchParams.get("level");
  const parentCode = url.searchParams.get("parentCode");
  const level = levelParam === null ? null : Number(levelParam);

  const items = page.items.filter((item) => {
    if (level !== null && item.level !== level) return false;
    if (parentCode !== null && item.parentCode !== parentCode) return false;
    return true;
  });

  return { ...page, items };
}

const ROUTES = {
  "/api/v1/commerce/products": () => fixture("products.json"),
  "/api/v1/commerce/categories": () => fixture("categories.json"),
  "/api/v1/site-profile/composed": () => fixture("site-profile-composed.json"),
  "/api/v1/blog/pages/public": () => fixture("blog-pages-public.json"),
  // #28 news
  "/api/v1/blog/posts": () => fixture("blog-posts.json"),
  "/api/v1/blog/terms": () => fixture("blog-terms.json"),
  "/api/v1/blog/institutions": () => fixture("blog-institutions.json"),
  // Issue #30 enriched this fixture with a second province's regency/
  // district rows (for `wilayah-checkout.ts`'s own build-time indexes), so
  // this handler now actually filters by `level`/`parentCode` the way the
  // real route does (`region-lookup.ts`) — the fixture is no longer small
  // enough that "return it whole regardless of query" (this file's own
  // header, "ignoring their query parameters") stays a harmless
  // simplification for every consumer: `wilayah.ts` (issue #28) asks this
  // SAME route with a specific `level`/`parentCode` and, unfiltered, would
  // pick up rows meant for issue #30's OWN provinces/districts too.
  "/api/v1/idn-regions/regions": (url) => filterRegions(fixture("regions-kalteng.json"), url),
  "/api/v1/news-portal/ad-placements/active": () => fixture("ad-placements-active.json"),
  "/api/v1/seo/redirects": () => fixture("seo-redirects-legacy.json"),
  // #27 katalog: the #26⇄#27 marketing read-model contract
  // (commerce-public-read-models.md) — src/lib/awcms/pemasaran.ts.
  "/api/v1/commerce/store-settings/public": () => fixture("store-settings-public.json"),
  "/api/v1/commerce/sliders/active": () => fixture("sliders-active.json"),
  "/api/v1/commerce/flash-sales/active": () => fixture("flash-sales-active.json"),
  "/api/v1/commerce/vouchers/public": () => fixture("vouchers-public.json"),
  "/api/v1/commerce/testimonials/active": () => fixture("testimonials-active.json"),
  "/api/v1/commerce/popups/active": () => fixture("popups-active.json"),
  // #47 media
  "/api/v1/media/objects": (url) => resolveMediaObjects(url),
  "/api/v1/media/public-origin": () => fixture("media-public-origin.json"),
  // #49 visitor analytics — src/lib/awcms/analitik.ts (see file header).
  "/api/v1/analytics/pages": (url) => analyticsPages(url)
};

/** `range` values `GET /api/v1/analytics/pages` accepts — `ANALYTICS_RANGES` (`apps/cms`'s `domain/analytics-range.ts`), mirrored so this stub rejects exactly what the real route rejects. */
const ANALYTICS_RANGES = new Set(["24h", "7d", "30d", "12m"]);

/**
 * `GET /api/v1/analytics/pages?range=` — the fixture whole, with the real
 * route's own `range` validation in front of it (a handler may return a
 * `Response` to short-circuit the success envelope; see the dispatch at the
 * bottom of this file). The `range` echoed back is the one requested, as the
 * real route does — the fixture's own `range` field is just its default.
 */
function analyticsPages(url) {
  const range = url.searchParams.get("range") ?? "7d";
  if (!ANALYTICS_RANGES.has(range)) {
    return envelopeError(400, "VALIDATION_ERROR", "range must be one of 24h, 7d, 30d, 12m.");
  }
  return { ...fixture("analytics-pages.json"), range };
}

/**
 * `GET /api/v1/media/objects?ids=` — mirrors the real route's `{ items,
 * unresolved }` shape (see this file's own header): an id present in
 * `media-objects.json` comes back as `{ id, ...entry }`, one absent from it
 * comes back in `unresolved` rather than being silently dropped.
 */
function resolveMediaObjects(url) {
  const idsParam = url.searchParams.get("ids") ?? "";
  const ids = idsParam.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
  const registry = fixture("media-objects.json");

  const items = [];
  const unresolved = [];
  for (const id of ids) {
    const entry = registry[id];
    if (entry) items.push({ id, ...entry });
    else unresolved.push(id);
  }

  return { items, unresolved };
}

const TOKENS_CSS_PATTERN = /^\/theming\/[^/]+\/tokens\.css$/;
const BLOG_PAGE_DETAIL_PATTERN = /^\/api\/v1\/blog\/pages\/public\/([^/]+)$/;

// ---------------------------------------------------------------------------
// Issue #30: the anonymous storefront commerce state machine
// ---------------------------------------------------------------------------

const STOREFRONT_PREFIX = "/api/v1/commerce/storefront";
/** The one Origin this stub answers — see this file's own header. */
const ALLOWED_ORIGIN = process.env.STUB_ALLOWED_ORIGIN ?? "http://localhost:4321";

const NEUTRAL_NOT_FOUND = { success: false, error: { code: "NOT_FOUND", message: "Not found." } };

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Cache-Control": "private, no-store"
  };
}

function envelope(data, init = {}) {
  return Response.json({ success: true, data }, init);
}

function envelopeError(status, code, message, details, headers) {
  const error = details === undefined ? { code, message } : { code, message, details };
  return Response.json({ success: false, error }, { status, headers });
}

/** Every product this stub knows about, flattened once from `products.json` — the SAME fixture `src/lib/catalog.ts` (the build-time client) reads, so a quote computed here prices a line exactly the way the catalog page that added it to the cart displayed it. */
function productCatalog() {
  return fixture("products.json").items;
}

function findProductLine(productId, variantId) {
  const product = productCatalog().find((p) => p.id === productId);
  if (!product) return null;
  const variant = variantId ? product.variants.find((v) => v.id === variantId) : null;
  if (variantId && !variant) return null;
  return { product, variant };
}

/** `numeric(14,2)` string arithmetic done in integer CENTS (ADR-0003's own rule, applied here even though this is only a stub) — floats stay out of every money computation. */
function toCents(price) {
  return Math.round(Number(price) * 100);
}

function fromCents(cents) {
  return (cents / 100).toFixed(2);
}

function storeSettings() {
  return fixture("store-settings-public.json");
}

/** `tests/fixtures/awcms/shipping-rates.json`, read fresh every call (see this file's own header — no persistence, no caching layer here). */
function shippingRatesFixture() {
  return fixture("shipping-rates.json");
}

/**
 * The real courier toggle (issue #109, contract: #106 D4) — `shipping.
 * courier.enabled`/`.couriers` when present, falling back to the older
 * `shipping.courierEnabled` boolean (with no per-courier allow-list) for a
 * settings fixture that predates this issue, exactly as `store-settings-
 * public.json`'s own comment for this app's read side (`pemasaran.ts`)
 * describes.
 */
function courierSettings(storeSettingsValue) {
  const courier = storeSettingsValue.shipping?.courier;
  if (courier) return { enabled: Boolean(courier.enabled), couriers: courier.couriers ?? [] };
  return { enabled: Boolean(storeSettingsValue.shipping?.courierEnabled), couriers: [] };
}

/** The single disabled placeholder row (contract's own shape) — one per "why", never several at once. */
function unavailableCourierOption(note) {
  return [{ method: "courier", serviceId: null, name: "Kurir", cost: null, etd: null, available: false, note }];
}

/**
 * Real, priced courier options for `destination` (issue #109, contract:
 * #106 D4) — one row per `{courier, service}` in `shipping-rates.json`,
 * priced for `weightGrams` in whole-kilogram buckets (the fixture's own
 * `baseCost` covers the first kg, `perExtraKg` each kg after it — the same
 * "round UP, never down" a real courier's own weight bucketing uses, so a
 * 100 g order is never quoted as if it weighed nothing). Falls back to the
 * single disabled placeholder — courier off, no destination yet, or this
 * destination has no rate row at all (an "unreachable for this provider"
 * outcome, not a bug) — exactly per the contract's own "failure →
 * `available:false` with a note".
 */
function buildCourierOptions(storeSettingsValue, destination, weightGrams) {
  const settings = courierSettings(storeSettingsValue);

  if (!settings.enabled) {
    return unavailableCourierOption("Pengiriman kurir belum diaktifkan oleh toko ini.");
  }

  const districtCode = destination?.districtCode;
  if (!districtCode) {
    return unavailableCourierOption("Pilih kecamatan tujuan pada langkah alamat untuk melihat ongkir kurir.");
  }

  const ratesForDistrict = shippingRatesFixture()[districtCode];
  if (!ratesForDistrict) {
    return unavailableCourierOption("Kurir tidak tersedia untuk tujuan ini.");
  }

  const weightKg = Math.max(1, Math.ceil((weightGrams || 0) / 1000));
  const extraKg = weightKg - 1;
  const couriers = settings.couriers.length > 0 ? settings.couriers : Object.keys(ratesForDistrict);

  const options = [];
  for (const courier of couriers) {
    const services = ratesForDistrict[courier];
    if (!services) continue;

    for (const [serviceCode, service] of Object.entries(services)) {
      const costCents = toCents(service.baseCost) + extraKg * toCents(service.perExtraKg);
      options.push({
        method: "courier",
        serviceId: `${courier}:${serviceCode}`,
        name: service.name,
        etd: service.etd,
        cost: fromCents(costCents),
        available: true
      });
    }
  }

  return options.length > 0 ? options : unavailableCourierOption("Kurir tidak tersedia untuk tujuan ini.");
}

function shippingOptionsFor(storeSettingsValue, destination, weightGrams) {
  const options = [];
  for (const service of storeSettingsValue.shipping?.alternativeServices ?? []) {
    options.push({ method: "alternative", serviceId: service.id, name: service.name, cost: service.cost, available: true });
  }
  if (storeSettingsValue.shipping?.selfPickup) {
    options.push({ method: "self_pickup", serviceId: null, name: "Ambil di toko", cost: "0.00", available: true });
  }
  options.push(...buildCourierOptions(storeSettingsValue, destination, weightGrams));
  return options;
}

/** `option.method === "courier"` or `"alternative"` both carry a `serviceId` that must match exactly; `self_pickup` never does — the one equality rule both `computeQuote`'s own shipping match and `/orders`' order-time re-validation share. */
function shippingSelectionMatches(option, selection) {
  if (option.method !== selection.method) return false;
  if (option.method === "self_pickup") return true;
  return option.serviceId === selection.serviceId;
}

function findVoucher(code) {
  if (!code) return null;
  const vouchers = fixture("vouchers-public.json");
  return vouchers.find((v) => v.code.toLowerCase() === code.toLowerCase()) ?? null;
}

/**
 * The one arithmetic path both `POST …/cart/quote` and `POST …/orders`
 * share — the contract's own "arithmetic order" section, in integer cents:
 * subtotal → voucher discount → shipping → insurance → tax → total.
 */
function computeQuote(body) {
  const settings = storeSettings();
  const lines = [];
  let subtotalCents = 0;
  let weightGrams = 0;
  let everyLineAllowsFreeShipping = true;

  for (const requested of body.lines ?? []) {
    const found = findProductLine(requested.productId, requested.variantId ?? null);

    if (!found) {
      lines.push({
        productId: requested.productId,
        variantId: requested.variantId ?? null,
        slug: "",
        name: "Produk tidak ditemukan",
        variantName: null,
        sku: "",
        quantity: requested.quantity,
        unitPrice: "0.00",
        lineTotal: "0.00",
        weightGrams: 0,
        image: null,
        flashSaleId: null,
        allowDp: false,
        allowFreeShipping: false,
        withInsurance: false,
        insuranceRequired: false,
        status: "unavailable",
        previousUnitPrice: null,
        availableStock: 0,
        minPurchase: 1,
        serviceFormErrors: []
      });
      everyLineAllowsFreeShipping = false;
      continue;
    }

    const { product, variant } = found;
    const unitPriceStr = variant?.price ?? product.finalPrice;
    const availableStock = variant ? variant.stock : product.stock;
    const minPurchase = product.minPurchase ?? 1;
    let quantity = requested.quantity;
    let status = "ok";

    if (availableStock <= 0) {
      status = "out_of_stock";
    } else if (quantity < minPurchase) {
      status = "min_purchase";
    } else if (quantity > availableStock) {
      quantity = availableStock;
      status = "quantity_reduced";
    }

    const unitPriceCents = toCents(unitPriceStr);
    const lineTotalCents = unitPriceCents * quantity;
    subtotalCents += status === "out_of_stock" ? 0 : lineTotalCents;
    weightGrams += (variant?.weightGrams || product.weightGrams) * quantity;
    if (!(product.allowFreeShipping ?? true)) everyLineAllowsFreeShipping = false;

    const image = product.images?.[0]
      ? { url: product.images[0].publicUrl, alt: product.images[0].altText }
      : null;

    lines.push({
      productId: product.id,
      variantId: variant?.id ?? null,
      slug: product.slug,
      name: product.name,
      variantName: variant ? `${variant.name}${variant.value !== "Standard" ? ` / ${variant.value}` : ""}` : null,
      sku: variant?.sku ?? product.sku,
      quantity,
      unitPrice: unitPriceStr,
      lineTotal: fromCents(unitPriceCents * quantity),
      weightGrams: variant?.weightGrams || product.weightGrams,
      image,
      flashSaleId: null,
      allowDp: Boolean(product.allowDp),
      allowFreeShipping: Boolean(product.allowFreeShipping ?? true),
      withInsurance: Boolean(product.withInsurance),
      insuranceRequired: Boolean(product.insuranceRequired),
      status,
      previousUnitPrice: null,
      availableStock,
      minPurchase,
      serviceFormErrors: []
    });
  }

  const subtotal = fromCents(subtotalCents);

  const voucher = findVoucher(body.voucherCode);
  let discountCents = 0;
  let voucherResult = null;
  let voucherFreeShipping = false;

  if (body.voucherCode) {
    if (!voucher) {
      voucherResult = { code: body.voucherCode, valid: false, discount: "0.00", freeShipping: false, reason: "Kode voucher tidak ditemukan." };
    } else {
      if (voucher.type === "percentage") {
        discountCents = Math.round((subtotalCents * Number(voucher.value)) / 100);
        if (voucher.maxDiscount) discountCents = Math.min(discountCents, toCents(voucher.maxDiscount));
      } else if (voucher.type === "nominal") {
        discountCents = toCents(voucher.value);
      } else if (voucher.type === "free_shipping") {
        voucherFreeShipping = true;
      }
      voucherResult = {
        code: voucher.code,
        valid: true,
        discount: fromCents(discountCents),
        freeShipping: voucherFreeShipping,
        reason: null
      };
    }
  }

  const shippingOptions = shippingOptionsFor(settings, body.destination ?? null, weightGrams);
  let shipping = null;
  if (body.shipping) {
    const match = shippingOptions.find((option) => shippingSelectionMatches(option, body.shipping));
    if (match && match.available) {
      shipping = { method: match.method, serviceId: match.serviceId, name: match.name, cost: match.cost ?? "0.00" };
    }
  }

  const freeShippingThreshold = settings.shipping?.freeShipping;
  const freeShippingApplied =
    voucherFreeShipping ||
    Boolean(
      freeShippingThreshold?.active &&
        everyLineAllowsFreeShipping &&
        subtotalCents >= toCents(freeShippingThreshold.minOrder)
    );

  const shippingCents = freeShippingApplied ? 0 : shipping ? toCents(shipping.cost) : 0;

  const insuranceSettings = settings.payment?.insurance;
  const insuranceRequiredOverall = lines.some((line) => line.insuranceRequired);
  const insuranceSelected = Boolean(body.insurance) || insuranceRequiredOverall;
  const insuranceAvailable = Boolean(insuranceSettings?.active);
  const insuranceFeeCents =
    insuranceAvailable && insuranceSelected
      ? Math.max(toCents(insuranceSettings.minFee), Math.round((subtotalCents * Number(insuranceSettings.ratePercent)) / 100))
      : 0;

  const taxSettings = settings.payment?.tax;
  const taxableCents = subtotalCents - discountCents;
  const taxCents = taxSettings?.active ? Math.round((taxableCents * taxSettings.percent) / 100) : 0;

  const totalCents = subtotalCents - discountCents + shippingCents + insuranceFeeCents + taxCents;

  const downPaymentSettings = settings.payment?.downPayment;
  const downPaymentAvailable = Boolean(downPaymentSettings?.active) && lines.every((line) => line.allowDp);

  const canCheckout = lines.length > 0 && lines.every((line) => line.status === "ok");

  return {
    lines,
    subtotal,
    weightGrams,
    shippingOptions,
    shipping,
    freeShippingApplied,
    voucher: voucherResult,
    insurance: {
      available: insuranceAvailable,
      required: insuranceRequiredOverall,
      selected: insuranceSelected,
      fee: fromCents(insuranceFeeCents)
    },
    tax: { active: Boolean(taxSettings?.active), percent: taxSettings?.percent ?? 0, amount: fromCents(taxCents) },
    discount: fromCents(discountCents),
    total: fromCents(totalCents),
    downPayment: { available: downPaymentAvailable, percent: downPaymentSettings?.percent ?? 0, amount: "0.00" },
    paymentMethods: [
      { method: "manual_qris", available: Boolean(settings.payment?.manualQris?.active) },
      { method: "manual_bank", available: Boolean(settings.payment?.manualBank?.active) },
      { method: "dp", available: downPaymentAvailable },
      // Issue #112 (contract: #106 D3) — listed, `available:true`, only
      // when the fixture's own `payment.gatewayEnabled` is on.
      { method: "gateway", available: Boolean(settings.payment?.gatewayEnabled) }
    ],
    canCheckout,
    quotedAt: new Date().toISOString()
  };
}

/** Every order this process has created, keyed by `orderCode` — reset on restart, see this file's own header. */
const ORDERS = new Map();
/** `idempotencyKey -> orderCode`, so a repeated `POST …/orders` answers with the SAME order (the contract's own rule) instead of creating a second one. */
const IDEMPOTENCY_KEYS = new Map();
let orderSequence = 0;

// ---------------------------------------------------------------------------
// Issue #112 (contract: #106 D3) — the payment-gateway session state machine.
//
// One session per order, minted the first time `POST …/orders/{code}/
// payment-gateway/sessions` succeeds and reused on every later call for the
// SAME order (this contract's own "idempotent per order") — never a second
// `redirectUrl` for the same `pending_payment`/`gateway` order. Two maps
// index the same object: by `orderCode` (the idempotency check) and by
// `sessionId` (the `GET /stub/gateway/{id}` page and its "Bayar"/"Batal"
// forms, which know only the session id from the URL, never the order code).
// ---------------------------------------------------------------------------

const GATEWAY_SESSIONS_BY_ORDER = new Map();
const GATEWAY_SESSIONS_BY_ID = new Map();
let gatewaySessionSequence = 0;

/**
 * The base URL the "Bayar"/"Batal" forms redirect back to, resolved once at
 * SESSION-CREATION time (never re-derived later, since by the time a
 * shopper clicks "Bayar" on the stub's own page there is no more storefront
 * request to read it from). Contract's own choice, documented here because
 * it is genuinely a choice: `SITE_URL` (this repo's own build/e2e variable,
 * the storefront's real public origin) wins when set; otherwise this falls
 * back to the CREATE-SESSION request's own `Referer` header (the checkout/
 * tracking page's URL, sent by every real browser navigating there) origin;
 * and, failing both, `ALLOWED_ORIGIN` (this stub's one known tenant origin)
 * — a real awcms would instead read its OWN configured storefront origin
 * (`apps/cms`'s own site-settings), which this fixture-only stub has no
 * equivalent of.
 */
function gatewayReturnBase(request) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/+$/, "");
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      // Falls through to ALLOWED_ORIGIN below.
    }
  }
  return ALLOWED_ORIGIN;
}

// ---------------------------------------------------------------------------
// Issue #88: the /account/* customer-account state machine (#86 contract)
// ---------------------------------------------------------------------------

const OTP_CODE = "123456";
const OTP_TTL_SECONDS = 600;
const SESSION_TTL_DAYS = 30;

function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

/**
 * Issue #90 (#86 contract) — every account additionally carries its OWN
 * addresses/wishlist/reviews arrays, mutated in place by the handlers below.
 * `addresses` for the fixture account (`budi@example.test`) is seeded with
 * exactly two rows, one `isDefault`, per this issue's own seed requirement;
 * a freshly REGISTERED account starts with none of the three.
 */
let addressSequence = 0;
function nextAddressId() {
  addressSequence += 1;
  return `addr-${addressSequence}`;
}

const SEEDED_ADDRESSES = [
  {
    id: nextAddressId(),
    label: "Rumah",
    recipientName: "Budi Santoso",
    phone: "+6281234567890",
    provinceCode: "62",
    provinceName: "Kalimantan Tengah",
    cityCode: "6202",
    cityName: "Kotawaringin Timur",
    districtCode: "620201",
    districtName: "Baamang",
    postalCode: "74311",
    street: "Jl. Jenderal Sudirman No. 1",
    notes: null,
    isDefault: true
  },
  {
    id: nextAddressId(),
    label: "Kantor",
    recipientName: "Budi Santoso",
    phone: "+6281234567891",
    provinceCode: "62",
    provinceName: "Kalimantan Tengah",
    cityCode: "6201",
    cityName: "Kotawaringin Barat",
    districtCode: "620101",
    districtName: "Arut Selatan",
    postalCode: "74111",
    street: "Jl. Pangeran Antasari No. 10",
    notes: "Kantor pusat",
    isDefault: false
  }
];

/**
 * Issue #93 (S3 of #32, #86's own D5) — the fixture account
 * (`budi@example.test`) is seeded ALREADY ENROLLED, with three commissions
 * (one per status the storefront's own `KOMISI_STATUS_LABELS` names:
 * pending/approved/paid), so `/akun/afiliasi` can be exercised end-to-end
 * against this stub with no manual "Gabung" click first. A freshly
 * registered account starts with `affiliate: null`/`commissions: []`,
 * exactly like it starts with no addresses/orders/reviews — enrolling THAT
 * account is what exercises `POST …/account/affiliate` itself.
 */
const AFFILIATE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * A deterministic (not random) 8-char code per account — same shape
 * `src/lib/afiliasi-kontrak.ts`'s own `KODE_PATTERN` requires (unambiguous
 * base32, no `I`/`O`/`0`/`1`), so a code THIS stub mints always round-trips
 * through the storefront's own `validasiKodeAfiliasi` — INCLUDING the name
 * part: "Budi" contains an `I`, so each of its letters is only kept when it
 * is itself in {@link AFFILIATE_ALPHABET}, substituting `X` otherwise,
 * rather than copying the name's own letters verbatim and risking an
 * ambiguous character the storefront would then reject as an incoming
 * `?ref=`.
 */
function deterministicAffiliateCode(account) {
  const rawLetters = account.name.replace(/[^A-Za-z]/g, "").toUpperCase();

  let namePart = "";
  for (const ch of rawLetters) {
    if (namePart.length >= 4) break;
    namePart += AFFILIATE_ALPHABET.includes(ch) ? ch : "X";
  }
  namePart = (namePart + "XXXX").slice(0, 4);

  let hash = 0;
  for (const ch of account.email) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;

  let rest = "";
  for (let i = 0; i < 4; i += 1) {
    rest += AFFILIATE_ALPHABET[(hash >>> (i * 5)) % AFFILIATE_ALPHABET.length];
    hash = (hash * 31 + i) >>> 0;
  }

  return `${namePart}${rest}`;
}

/** `"${SITE_URL}/?ref=${code}"` — the storefront's own `SITE_URL` is not something this CMS stub is configured with (it is a STOREFRONT build variable), so this falls back to the storefront's own dev default when unset; a real awcms builds this from its own configured storefront origin. */
function buildAffiliateLink(code) {
  const site = (process.env.SITE_URL ?? "http://localhost:4321").replace(/\/+$/, "");
  return `${site}/?ref=${code}`;
}

const SEEDED_KOMISI = [
  { id: "komisi-1", orderCode: "STUB-20260201-0001", amount: "15000.00", status: "pending", createdAt: "2026-02-01T00:00:00.000Z" },
  { id: "komisi-2", orderCode: "STUB-20260202-0002", amount: "22000.00", status: "approved", createdAt: "2026-02-02T00:00:00.000Z" },
  { id: "komisi-3", orderCode: "STUB-20260203-0003", amount: "9000.00", status: "paid", createdAt: "2026-02-03T00:00:00.000Z" }
];

/** Sums `amount` across `commissions` whose `status === status`, formatted the same `numeric(14,2)` string shape every other money field in this stub already uses. */
function sumKomisi(commissions, status) {
  const total = commissions.filter((k) => k.status === status).reduce((sum, k) => sum + Number(k.amount), 0);
  return total.toFixed(2);
}

/**
 * Issue #115 — the fixture account's (`budi@example.test`) two seeded
 * conversations: one OPEN with an unread store reply already sitting on it
 * (so `/akun/pesan`'s unread badge is exercised without a manual message
 * first), one CLOSED (so the "closed thread shows a note instead of the
 * reply form" behaviour is exercised too). A freshly registered account
 * starts with `conversations: []`, same as it starts with no addresses/
 * orders/reviews.
 */
const SEEDED_CONVERSATIONS = [
  {
    id: "conv-seed-1",
    subject: "Pertanyaan tentang pengiriman",
    status: "open",
    unreadForCustomer: 1,
    messages: [
      { id: "msg-seed-1", sender: "customer", body: "Kapan pesanan saya dikirim?", createdAt: "2026-02-01T01:00:00.000Z" },
      { id: "msg-seed-2", sender: "store", body: "Pesanan Anda akan dikirim besok pagi.", createdAt: "2026-02-01T02:00:00.000Z" }
    ]
  },
  {
    id: "conv-seed-2",
    subject: "Komplain produk rusak",
    status: "closed",
    unreadForCustomer: 0,
    messages: [
      { id: "msg-seed-3", sender: "customer", body: "Produk yang saya terima rusak.", createdAt: "2026-01-05T01:00:00.000Z" },
      { id: "msg-seed-4", sender: "store", body: "Mohon maaf, kami akan proses pengembalian.", createdAt: "2026-01-05T05:00:00.000Z" }
    ]
  }
];

/** Accounts keyed by normalized e-mail — seeded once from the fixture, then grown by `purpose:"register"` verifies. */
const ACCOUNTS = new Map(
  fixture("customer-accounts.json").map((account) => {
    const isSeeded = normalizeEmail(account.email) === "budi@example.test";
    return [
      normalizeEmail(account.email),
      {
        ...account,
        // Only the fixture's own `budi@example.test` gets the seeded
        // addresses/orders/affiliate/conversations state below — a second
        // fixture row (if one is ever added) starts empty, same as a
        // freshly registered account.
        addresses: isSeeded ? SEEDED_ADDRESSES.map((a) => ({ ...a })) : [],
        wishlist: [],
        reviews: [],
        affiliate: isSeeded
          ? { code: deterministicAffiliateCode(account), commissionRate: "10.00", status: "active" }
          : null,
        commissions: isSeeded ? SEEDED_KOMISI.map((k) => ({ ...k })) : [],
        // Issue #115 — the seeded account already opted in, so `/akun`'s
        // consent toggle has something real to show ON by default.
        marketingConsent: isSeeded ? true : false,
        conversations: isSeeded
          ? SEEDED_CONVERSATIONS.map((c) => ({ ...c, messages: c.messages.map((m) => ({ ...m })) }))
          : []
      }
    ];
  })
);
/** `email -> {code, purpose, registration, expiresAt, consumed}` — one row per e-mail, the same "single code, replaced by the next request" shape `awcms_commerce_customer_otps` describes (#86's schema summary). */
const OTPS = new Map();
/** `token -> {emailNormalized, expiresAt}`. */
const SESSIONS = new Map();
let sessionSequence = 0;

/**
 * Issue #90's own seed requirement: TWO orders for the fixture account
 * (`budi@example.test`), reusing the same product catalog every OTHER order
 * on this stub is built from — one dated BEFORE `historyFrom`
 * (2026-01-01T00:00:00.000Z, see `customer-accounts.json`) and one AFTER.
 * `GET /account/orders` must return only the second one: this seed exists
 * to prove the SERVER enforces the D4 history-window rule (see
 * `handleAccountRequest`'s own `/orders` GET), not the client.
 */
function seedAccountOrders() {
  const account = ACCOUNTS.get("budi@example.test");
  if (!account) return;

  const found = findProductLine("c2000000-0000-4000-8000-000000000001", null);
  if (!found) return;
  const { product } = found;

  const image = product.images?.[0] ? { url: product.images[0].publicUrl, alt: product.images[0].altText } : null;

  function buildSeedOrder(orderCode, createdAt, status) {
    const lineTotal = fromCents(toCents(product.finalPrice) * 1);
    return {
      orderCode,
      status,
      paymentStatus: status === "completed" ? "paid" : "unpaid",
      paymentMethod: "manual_qris",
      shippingMethod: "self_pickup",
      shippingServiceName: null,
      customerName: account.name,
      customerEmail: account.email,
      phone: account.phone,
      address: null,
      lines: [
        {
          name: product.name,
          variantName: null,
          sku: product.sku,
          quantity: 1,
          unitPrice: product.finalPrice,
          lineTotal,
          image,
          serviceFormValues: null
        }
      ],
      subtotal: product.finalPrice,
      discount: "0.00",
      voucherCode: null,
      shippingCost: "0.00",
      insuranceFee: "0.00",
      tax: "0.00",
      total: product.finalPrice,
      paymentConfirmations: [],
      timeline: [{ status, at: createdAt, note: null }],
      createdAt,
      expiresAt: status === "pending_payment" ? new Date(new Date(createdAt).getTime() + 24 * 3600_000).toISOString() : null,
      paidAt: status === "completed" ? createdAt : null,
      cancelledAt: null,
      accountEmail: "budi@example.test"
    };
  }

  // BEFORE historyFrom (2026-01-01) — must NOT appear in the account order list.
  const beforeHistory = buildSeedOrder("STUB-SEED-0001", "2025-11-15T03:00:00.000Z", "completed");
  // AFTER historyFrom — must appear.
  const afterHistory = buildSeedOrder("STUB-SEED-0002", "2026-02-01T03:00:00.000Z", "pending_payment");

  ORDERS.set(beforeHistory.orderCode, beforeHistory);
  ORDERS.set(afterHistory.orderCode, afterHistory);
}

seedAccountOrders();

function issueSession(emailNormalized) {
  sessionSequence += 1;
  const token = `cs_stub_${sessionSequence}`;
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 3600_000).toISOString();
  SESSIONS.set(token, { emailNormalized, expiresAt });
  return { token, expiresAt };
}

function serializeAccount(account) {
  return {
    id: account.id,
    name: account.name,
    email: account.email,
    phone: account.phone,
    level: account.level,
    createdAt: account.createdAt,
    historyFrom: account.historyFrom,
    marketingConsent: Boolean(account.marketingConsent)
  };
}

/** Reads `Authorization: Bearer <token>`, resolving it to a live (unexpired) account — or `null`, the caller's cue to answer `401 UNAUTHENTICATED`. */
function findAccountByBearer(request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(authorization);
  if (!match) return null;

  const session = SESSIONS.get(match[1]);
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    SESSIONS.delete(match[1]);
    return null;
  }

  return ACCOUNTS.get(session.emailNormalized) ?? null;
}

/** The `via:"whatsapp"` OTP request/verify path keys `OTPS` by NORMALIZED phone rather than e-mail — this key format keeps the two channels from ever colliding in the same `Map`. */
function otpKeyForPhone(phone) {
  return `wa:${normalizePhoneForComparison(String(phone ?? ""))}`;
}

function findAccountByPhone(phone) {
  const target = normalizePhoneForComparison(String(phone ?? ""));
  if (!target) return null;
  return [...ACCOUNTS.values()].find((account) => normalizePhoneForComparison(account.phone) === target) ?? null;
}

function handleAccountRequest(request, path, body, headers) {
  if (path === "/otp/request" && request.method === "POST") {
    const purpose = body?.purpose === "register" ? "register" : "login";
    // Issue #115 (contract #106 D5) — `via` defaults to `"email"`; WhatsApp
    // is LOGIN-only (registration always goes out over e-mail regardless of
    // what a caller sends here, matching `/daftar`'s own "registration
    // stays e-mail OTP" rule).
    const via = body?.via === "whatsapp" && purpose === "login" ? "whatsapp" : "email";

    if (via === "whatsapp") {
      if (!(storeSettings().whatsappOtpEnabled ?? false)) {
        return envelopeError(
          409,
          "CHANNEL_UNAVAILABLE",
          "Kode via WhatsApp sedang tidak tersedia di toko ini.",
          undefined,
          headers
        );
      }

      OTPS.set(otpKeyForPhone(body?.phone), {
        code: OTP_CODE,
        purpose: "login",
        registration: null,
        expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000).toISOString(),
        consumed: false
      });
      return envelope({ sent: true, expiresInSeconds: OTP_TTL_SECONDS }, { status: 202, headers });
    }

    const emailNormalized = normalizeEmail(body?.email);
    OTPS.set(emailNormalized, {
      code: OTP_CODE,
      purpose,
      registration:
        purpose === "register" ? { name: body?.name ?? "", phone: body?.phone ?? "" } : null,
      expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000).toISOString(),
      consumed: false
    });

    // Always 202, regardless of whether the e-mail is known — #86's own
    // anti-enumeration rule, kept true even in this stub.
    return envelope({ sent: true, expiresInSeconds: OTP_TTL_SECONDS }, { status: 202, headers });
  }

  if (path === "/otp/verify" && request.method === "POST") {
    const purpose = body?.purpose === "register" ? "register" : "login";

    // Issue #115 — `{phone, code, purpose:"login"}` verifies the WhatsApp
    // path, resolving the account by phone instead of e-mail.
    if (purpose === "login" && typeof body?.phone === "string" && body.phone.length > 0) {
      const otp = OTPS.get(otpKeyForPhone(body.phone));
      if (!otp || otp.consumed || otp.code !== body?.code || new Date(otp.expiresAt).getTime() <= Date.now()) {
        return envelopeError(401, "OTP_INVALID", "Kode salah atau kedaluwarsa.", undefined, headers);
      }
      const account = findAccountByPhone(body.phone);
      if (!account) {
        return envelopeError(404, "ACCOUNT_NOT_FOUND", "Akun tidak ditemukan.", undefined, headers);
      }
      otp.consumed = true;
      const session = issueSession(normalizeEmail(account.email));
      return envelope({ ...session, account: serializeAccount(account) }, { headers });
    }

    const emailNormalized = normalizeEmail(body?.email);
    const otp = OTPS.get(emailNormalized);

    if (!otp || otp.consumed || otp.purpose !== purpose || otp.code !== body?.code) {
      return envelopeError(401, "OTP_INVALID", "Kode salah atau kedaluwarsa.", undefined, headers);
    }
    if (new Date(otp.expiresAt).getTime() <= Date.now()) {
      return envelopeError(401, "OTP_INVALID", "Kode salah atau kedaluwarsa.", undefined, headers);
    }

    if (purpose === "login") {
      const account = ACCOUNTS.get(emailNormalized);
      if (!account) {
        return envelopeError(404, "ACCOUNT_NOT_FOUND", "Akun tidak ditemukan.", undefined, headers);
      }
      otp.consumed = true;
      const session = issueSession(emailNormalized);
      return envelope({ ...session, account: serializeAccount(account) }, { headers });
    }

    // purpose === "register"
    const registration = otp.registration ?? { name: "", phone: "" };
    const phoneAlreadyBound = [...ACCOUNTS.values()].some(
      (account) => account.phone === registration.phone && normalizeEmail(account.email) !== emailNormalized
    );
    if (phoneAlreadyBound) {
      return envelopeError(
        409,
        "PHONE_ALREADY_REGISTERED",
        "Nomor telepon sudah terdaftar pada akun lain.",
        undefined,
        headers
      );
    }

    otp.consumed = true;
    const now = new Date().toISOString();
    const existing = ACCOUNTS.get(emailNormalized);
    const account = existing ?? {
      id: `acc-${emailNormalized}`,
      name: registration.name,
      email: body.email,
      phone: registration.phone,
      level: 0,
      createdAt: now,
      historyFrom: now,
      addresses: [],
      wishlist: [],
      reviews: [],
      affiliate: null,
      commissions: [],
      marketingConsent: false,
      conversations: []
    };
    ACCOUNTS.set(emailNormalized, account);

    const session = issueSession(emailNormalized);
    return envelope({ ...session, account: serializeAccount(account) }, { headers });
  }

  if (path === "/me" && (request.method === "GET" || request.method === "PATCH")) {
    const account = findAccountByBearer(request);
    if (!account) {
      return envelopeError(401, "UNAUTHENTICATED", "Sesi tidak valid atau telah berakhir.", undefined, headers);
    }

    if (request.method === "PATCH" && typeof body?.name === "string" && body.name.trim()) {
      account.name = body.name.trim();
    }
    if (request.method === "PATCH" && typeof body?.marketingConsent === "boolean") {
      account.marketingConsent = body.marketingConsent;
    }

    return envelope({ account: serializeAccount(account) }, { headers });
  }

  if (path === "/logout" && request.method === "POST") {
    const authorization = request.headers.get("authorization") ?? "";
    const match = /^Bearer (.+)$/.exec(authorization);
    const account = findAccountByBearer(request);
    if (!account) {
      return envelopeError(401, "UNAUTHENTICATED", "Sesi tidak valid atau telah berakhir.", undefined, headers);
    }
    if (match) SESSIONS.delete(match[1]);
    return new Response(null, { status: 204, headers });
  }

  // -------------------------------------------------------------------------
  // Issue #90 — addresses, the account's own wishlist, orders, reviews.
  // -------------------------------------------------------------------------

  if (path === "/addresses" && (request.method === "GET" || request.method === "POST")) {
    const account = findAccountByBearer(request);
    if (!account) {
      return envelopeError(401, "UNAUTHENTICATED", "Sesi tidak valid atau telah berakhir.", undefined, headers);
    }

    if (request.method === "GET") {
      return envelope({ items: account.addresses }, { headers });
    }

    // POST — create. Max 10 per account, per #86's own limit; the real
    // client (`akun-alamat.ts`) already enforces this before ever sending a
    // request, but the stub enforces it too so a client bug shows up here,
    // not only in a code review.
    if (account.addresses.length >= 10) {
      return envelopeError(
        400,
        "VALIDATION_ERROR",
        "Batas maksimum 10 alamat telah tercapai.",
        [{ field: "label", message: "Batas maksimum 10 alamat telah tercapai." }],
        headers
      );
    }

    const required = ["label", "recipientName", "phone", "provinceCode", "cityCode", "districtCode", "postalCode", "street"];
    const missing = required.filter((field) => !body?.[field]);
    if (missing.length > 0) {
      return envelopeError(
        400,
        "VALIDATION_ERROR",
        "Data alamat belum lengkap.",
        missing.map((field) => ({ field, message: "Wajib diisi." })),
        headers
      );
    }

    const address = {
      id: `addr-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      label: body.label,
      recipientName: body.recipientName,
      phone: body.phone,
      provinceCode: body.provinceCode,
      provinceName: body.provinceName ?? "",
      cityCode: body.cityCode,
      cityName: body.cityName ?? "",
      districtCode: body.districtCode,
      districtName: body.districtName ?? "",
      postalCode: body.postalCode,
      street: body.street,
      notes: body.notes ?? null,
      isDefault: account.addresses.length === 0
    };
    account.addresses.push(address);
    return envelope({ address }, { status: 201, headers });
  }

  const addressMatch = /^\/addresses\/([^/]+)(\/default)?$/.exec(path);
  if (addressMatch) {
    const account = findAccountByBearer(request);
    if (!account) {
      return envelopeError(401, "UNAUTHENTICATED", "Sesi tidak valid atau telah berakhir.", undefined, headers);
    }

    const addressId = decodeURIComponent(addressMatch[1]);
    const isDefaultRoute = Boolean(addressMatch[2]);
    const address = account.addresses.find((a) => a.id === addressId);
    if (!address) {
      return envelopeError(404, "NOT_FOUND", "Alamat tidak ditemukan.", undefined, headers);
    }

    if (isDefaultRoute && request.method === "POST") {
      for (const a of account.addresses) a.isDefault = a.id === addressId;
      return envelope({ address }, { headers });
    }

    if (!isDefaultRoute && request.method === "PATCH") {
      Object.assign(address, {
        label: body?.label ?? address.label,
        recipientName: body?.recipientName ?? address.recipientName,
        phone: body?.phone ?? address.phone,
        provinceCode: body?.provinceCode ?? address.provinceCode,
        provinceName: body?.provinceName ?? address.provinceName,
        cityCode: body?.cityCode ?? address.cityCode,
        cityName: body?.cityName ?? address.cityName,
        districtCode: body?.districtCode ?? address.districtCode,
        districtName: body?.districtName ?? address.districtName,
        postalCode: body?.postalCode ?? address.postalCode,
        street: body?.street ?? address.street,
        notes: body?.notes ?? address.notes
      });
      return envelope({ address }, { headers });
    }

    if (!isDefaultRoute && request.method === "DELETE") {
      account.addresses = account.addresses.filter((a) => a.id !== addressId);
      // Deleting the default address promotes the next one, if any — never
      // leaves the account with addresses but no default at all.
      if (address.isDefault && account.addresses.length > 0) account.addresses[0].isDefault = true;
      return new Response(null, { status: 204, headers });
    }
  }

  if (path === "/wishlist" && (request.method === "GET" || request.method === "PUT")) {
    const account = findAccountByBearer(request);
    if (!account) {
      return envelopeError(401, "UNAUTHENTICATED", "Sesi tidak valid atau telah berakhir.", undefined, headers);
    }

    if (request.method === "GET") {
      return envelope({ items: account.wishlist }, { headers });
    }

    // PUT — union-merge `productIds` into whatever is already on the
    // account, annotated with product summaries pulled from `products.json`
    // (this issue's own requirement) — an id this stub's catalog does not
    // know is silently skipped, the same "never invent a summary" posture
    // `resolveMediaObjects` above takes for an unknown media id.
    const catalog = productCatalog();
    const requestedIds = Array.isArray(body?.productIds) ? body.productIds : [];
    const now = new Date().toISOString();

    for (const productId of requestedIds) {
      if (account.wishlist.some((item) => item.productId === productId)) continue;
      const product = catalog.find((p) => p.id === productId);
      if (!product) continue;

      account.wishlist.push({
        productId: product.id,
        slug: product.slug,
        name: product.name,
        price: product.finalPrice,
        image: product.images?.[0] ? { url: product.images[0].publicUrl, alt: product.images[0].altText } : null,
        addedAt: now
      });
    }

    return envelope({ items: account.wishlist }, { headers });
  }

  const wishlistItemMatch = /^\/wishlist\/([^/]+)$/.exec(path);
  if (wishlistItemMatch && request.method === "DELETE") {
    const account = findAccountByBearer(request);
    if (!account) {
      return envelopeError(401, "UNAUTHENTICATED", "Sesi tidak valid atau telah berakhir.", undefined, headers);
    }
    const productId = decodeURIComponent(wishlistItemMatch[1]);
    account.wishlist = account.wishlist.filter((item) => item.productId !== productId);
    return new Response(null, { status: 204, headers });
  }

  if (path === "/orders" && request.method === "GET") {
    const account = findAccountByBearer(request);
    if (!account) {
      return envelopeError(401, "UNAUTHENTICATED", "Sesi tidak valid atau telah berakhir.", undefined, headers);
    }

    // #86's own D4: only orders at/after `historyFrom`, newest first — this
    // filtering happens HERE, server-side, on purpose (see this issue's own
    // seed: one of the two seeded orders predates `historyFrom` specifically
    // to prove that).
    const owned = [...ORDERS.values()]
      .filter((order) => order.accountEmail === normalizeEmail(account.email))
      .filter((order) => new Date(order.createdAt).getTime() >= new Date(account.historyFrom).getTime())
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const cursorParam = new URL(request.url).searchParams.get("cursor");
    const PAGE_SIZE = 10;
    const startIndex = cursorParam ? owned.findIndex((order) => order.orderCode === cursorParam) + 1 : 0;
    const page = owned.slice(startIndex, startIndex + PAGE_SIZE);
    const nextCursor = startIndex + PAGE_SIZE < owned.length ? page[page.length - 1]?.orderCode ?? null : null;

    return envelope({ items: page.map(serializeOrder), nextCursor }, { headers });
  }

  const accountOrderMatch = /^\/orders\/([^/]+)$/.exec(path);
  if (accountOrderMatch && request.method === "GET") {
    const account = findAccountByBearer(request);
    if (!account) {
      return envelopeError(401, "UNAUTHENTICATED", "Sesi tidak valid atau telah berakhir.", undefined, headers);
    }

    const orderCode = decodeURIComponent(accountOrderMatch[1]);
    const order = ORDERS.get(orderCode);
    const owned =
      order &&
      order.accountEmail === normalizeEmail(account.email) &&
      new Date(order.createdAt).getTime() >= new Date(account.historyFrom).getTime();

    if (!owned) {
      return envelopeError(404, "NOT_FOUND", "Pesanan tidak ditemukan.", undefined, headers);
    }
    return envelope(serializeOrder(order), { headers });
  }

  if (path === "/reviews" && request.method === "GET") {
    const account = findAccountByBearer(request);
    if (!account) {
      return envelopeError(401, "UNAUTHENTICATED", "Sesi tidak valid atau telah berakhir.", undefined, headers);
    }
    return envelope({ items: account.reviews }, { headers });
  }

  // Issue #93 (S3, #86's own D5) — the affiliate program.

  if (path === "/affiliate" && request.method === "GET") {
    const account = findAccountByBearer(request);
    if (!account) {
      return envelopeError(401, "UNAUTHENTICATED", "Sesi tidak valid atau telah berakhir.", undefined, headers);
    }
    return envelope({ affiliate: serializeAffiliate(account) }, { headers });
  }

  if (path === "/affiliate" && request.method === "POST") {
    const account = findAccountByBearer(request);
    if (!account) {
      return envelopeError(401, "UNAUTHENTICATED", "Sesi tidak valid atau telah berakhir.", undefined, headers);
    }

    const settings = storeSettings();
    if (!(settings.affiliateProgramEnabled ?? false)) {
      return envelopeError(
        409,
        "AFFILIATE_PROGRAM_DISABLED",
        "Program afiliasi sedang tidak aktif di toko ini.",
        undefined,
        headers
      );
    }

    if (!account.affiliate) {
      account.affiliate = { code: deterministicAffiliateCode(account), commissionRate: "10.00", status: "active" };
    }

    return envelope({ affiliate: serializeAffiliate(account) }, { status: 201, headers });
  }

  if (path === "/affiliate/commissions" && request.method === "GET") {
    const account = findAccountByBearer(request);
    if (!account) {
      return envelopeError(401, "UNAUTHENTICATED", "Sesi tidak valid atau telah berakhir.", undefined, headers);
    }

    const owned = [...account.commissions].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    const cursorParam = new URL(request.url).searchParams.get("cursor");
    const PAGE_SIZE = 10;
    const startIndex = cursorParam ? owned.findIndex((komisi) => komisi.id === cursorParam) + 1 : 0;
    const page = owned.slice(startIndex, startIndex + PAGE_SIZE);
    const nextCursor = startIndex + PAGE_SIZE < owned.length ? page[page.length - 1]?.id ?? null : null;

    return envelope({ items: page, nextCursor }, { headers });
  }

  // Issue #115 (S3, #106 D8) — the account's own inbox with the store.

  if (path === "/conversations" && request.method === "GET") {
    const account = findAccountByBearer(request);
    if (!account) {
      return envelopeError(401, "UNAUTHENTICATED", "Sesi tidak valid atau telah berakhir.", undefined, headers);
    }

    const owned = [...account.conversations].sort(
      (a, b) => new Date(lastMessageAt(b)).getTime() - new Date(lastMessageAt(a)).getTime()
    );

    const cursorParam = new URL(request.url).searchParams.get("cursor");
    const PAGE_SIZE = 10;
    const startIndex = cursorParam ? owned.findIndex((c) => c.id === cursorParam) + 1 : 0;
    const page = owned.slice(startIndex, startIndex + PAGE_SIZE);
    const nextCursor = startIndex + PAGE_SIZE < owned.length ? page[page.length - 1]?.id ?? null : null;

    return envelope({ items: page.map(serializeConversation), nextCursor }, { headers });
  }

  if (path === "/conversations" && request.method === "POST") {
    const account = findAccountByBearer(request);
    if (!account) {
      return envelopeError(401, "UNAUTHENTICATED", "Sesi tidak valid atau telah berakhir.", undefined, headers);
    }

    const subject = typeof body?.subject === "string" ? body.subject.trim() : "";
    const messageBody = typeof body?.body === "string" ? body.body.trim() : "";
    const fieldErrors = [];
    if (!subject) fieldErrors.push({ field: "subject", message: "Subjek wajib diisi." });
    if (!messageBody) fieldErrors.push({ field: "body", message: "Pesan wajib diisi." });
    else if (messageBody.length > 4000) {
      fieldErrors.push({ field: "body", message: "Pesan maksimum 4000 karakter." });
    }
    if (fieldErrors.length > 0) {
      return envelopeError(400, "VALIDATION_ERROR", "Data pesan belum lengkap.", fieldErrors, headers);
    }

    const now = new Date().toISOString();
    const message = { id: nextMessageId(), sender: "customer", body: messageBody, createdAt: now };
    const conversation = { id: nextConversationId(), subject, status: "open", unreadForCustomer: 0, messages: [message] };
    account.conversations.push(conversation);
    scheduleAutoReply(conversation);

    return envelope(
      { conversation: serializeConversation(conversation), message },
      { status: 201, headers }
    );
  }

  const conversationMatch = /^\/conversations\/([^/]+)$/.exec(path);
  if (conversationMatch && request.method === "GET") {
    const account = findAccountByBearer(request);
    if (!account) {
      return envelopeError(401, "UNAUTHENTICATED", "Sesi tidak valid atau telah berakhir.", undefined, headers);
    }

    const conversation = account.conversations.find((c) => c.id === conversationMatch[1]);
    if (!conversation) {
      return envelopeError(404, "NOT_FOUND", "Percakapan tidak ditemukan.", undefined, headers);
    }

    // #106's own contract: reading a thread marks it read.
    conversation.unreadForCustomer = 0;

    return envelope(
      { conversation: serializeConversation(conversation), messages: conversation.messages },
      { headers }
    );
  }

  const conversationMessagesMatch = /^\/conversations\/([^/]+)\/messages$/.exec(path);
  if (conversationMessagesMatch && request.method === "POST") {
    const account = findAccountByBearer(request);
    if (!account) {
      return envelopeError(401, "UNAUTHENTICATED", "Sesi tidak valid atau telah berakhir.", undefined, headers);
    }

    const conversation = account.conversations.find((c) => c.id === conversationMessagesMatch[1]);
    if (!conversation) {
      return envelopeError(404, "NOT_FOUND", "Percakapan tidak ditemukan.", undefined, headers);
    }
    if (conversation.status === "closed") {
      return envelopeError(409, "CONVERSATION_CLOSED", "Percakapan ini telah ditutup.", undefined, headers);
    }

    const messageBody = typeof body?.body === "string" ? body.body.trim() : "";
    if (!messageBody) {
      return envelopeError(
        400,
        "VALIDATION_ERROR",
        "Pesan wajib diisi.",
        [{ field: "body", message: "Pesan wajib diisi." }],
        headers
      );
    }
    if (messageBody.length > 4000) {
      return envelopeError(
        400,
        "VALIDATION_ERROR",
        "Pesan maksimum 4000 karakter.",
        [{ field: "body", message: "Pesan maksimum 4000 karakter." }],
        headers
      );
    }

    const message = { id: nextMessageId(), sender: "customer", body: messageBody, createdAt: new Date().toISOString() };
    conversation.messages.push(message);
    scheduleAutoReply(conversation);

    return envelope({ message }, { status: 201, headers });
  }

  return null;
}

/** `null` for an account that has not enrolled; otherwise the `{code, commissionRate, status, link, stats}` shape #86's contract names, `stats` computed fresh from `account.commissions` every call (never cached), so a status change to one commission is reflected immediately. */
function serializeAffiliate(account) {
  if (!account.affiliate) return null;

  return {
    code: account.affiliate.code,
    commissionRate: account.affiliate.commissionRate,
    status: account.affiliate.status,
    link: buildAffiliateLink(account.affiliate.code),
    stats: {
      referredOrders: account.commissions.length,
      pendingAmount: sumKomisi(account.commissions, "pending"),
      approvedAmount: sumKomisi(account.commissions, "approved"),
      paidAmount: sumKomisi(account.commissions, "paid")
    }
  };
}

// ---------------------------------------------------------------------------
// Issue #115 — conversations helpers.
// ---------------------------------------------------------------------------

let conversationSequence = 100;
function nextConversationId() {
  conversationSequence += 1;
  return `conv-${conversationSequence}`;
}

let messageSequence = 100;
function nextMessageId() {
  messageSequence += 1;
  return `msg-${messageSequence}`;
}

/** The `createdAt` of `conversation`'s last message — `lastMessageAt` is never stored separately, always derived, so it can never drift from the messages it summarises. */
function lastMessageAt(conversation) {
  const last = conversation.messages[conversation.messages.length - 1];
  return last ? last.createdAt : new Date(0).toISOString();
}

function serializeConversation(conversation) {
  return {
    id: conversation.id,
    subject: conversation.subject,
    status: conversation.status,
    lastMessageAt: lastMessageAt(conversation),
    unreadForCustomer: conversation.unreadForCustomer
  };
}

/**
 * This issue's own "so unread flags are exercised" requirement: 2 seconds
 * after a customer message, a SIMULATED store reply lands on the same
 * thread (unless it was closed in the meantime) and the thread's own
 * `unreadForCustomer` counter increments — the same signal a real reply
 * from staff would produce. Purely in-memory; a process restart forgets any
 * reply still pending.
 */
function scheduleAutoReply(conversation) {
  setTimeout(() => {
    if (conversation.status !== "open") return;
    conversation.messages.push({
      id: nextMessageId(),
      sender: "store",
      body: "Terima kasih, tim kami akan segera membalas pesan Anda.",
      createdAt: new Date().toISOString()
    });
    conversation.unreadForCustomer += 1;
  }, 2000);
}

function maskPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  const normalized = digits.startsWith("62") ? `+${digits}` : digits.startsWith("0") ? `+62${digits.slice(1)}` : `+${digits}`;
  return normalized.length > 6 ? `${normalized.slice(0, 5)}•••${normalized.slice(-4)}` : normalized;
}

function normalizePhoneForComparison(phone) {
  const digits = phone.replace(/\D/g, "");
  // Compare on the NATIONAL number (drop a leading 62/0) so "0812…" and
  // "+62812…" for the same shopper compare equal — a stub-only convenience;
  // the real CMS's own normaliser is the actual authority.
  if (digits.startsWith("62")) return digits.slice(2);
  if (digits.startsWith("0")) return digits.slice(1);
  return digits;
}

function generateOrderCode() {
  orderSequence += 1;
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `STUB-${today}-${String(orderSequence).padStart(4, "0")}`;
}

function buildPaymentInstructions(order, settings) {
  if (order.status !== "pending_payment") return null;
  // Issue #112 — a `gateway` order has no manual bank/QRIS instructions at
  // all; `/pesanan`'s own renderer shows the "Bayar sekarang" button
  // instead (`src/lib/pesanan-render.ts`).
  if (order.paymentMethod === "gateway") return null;

  const banks =
    order.paymentMethod === "manual_bank"
      ? (settings.payment?.manualBank?.banks ?? []).map((bank) => ({
          bankName: bank.bankName,
          accountNumber: "1234567890",
          accountName: settings.storeName
        }))
      : [];

  return {
    method: order.paymentMethod,
    qrisImage: order.paymentMethod === "manual_qris" ? { url: "https://cms.example.test/media/qris-stub.png" } : null,
    banks,
    amountDue: order.total,
    expiresAt: order.expiresAt,
    proofUpload: Boolean(settings.payment?.proofUpload)
  };
}

function serializeOrder(order) {
  const settings = storeSettings();
  return {
    orderCode: order.orderCode,
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    shippingMethod: order.shippingMethod,
    shippingServiceName: order.shippingServiceName,
    customer: { name: order.customerName, phoneMasked: maskPhone(order.phone), email: order.customerEmail },
    address: order.address ? { ...order.address, phone: maskPhone(order.address.phone) } : null,
    lines: order.lines,
    subtotal: order.subtotal,
    discount: order.discount,
    voucherCode: order.voucherCode,
    shippingCost: order.shippingCost,
    insuranceFee: order.insuranceFee,
    tax: order.tax,
    total: order.total,
    downPayment: null,
    paymentInstructions: buildPaymentInstructions(order, settings),
    paymentConfirmations: order.paymentConfirmations,
    timeline: order.timeline,
    canCancel: order.status === "pending_payment",
    // Issue #112 — a `gateway` order is never manually confirmed; its own
    // "Bayar sekarang"/poll flow is the only path to `paid`.
    canConfirmPayment: order.status === "pending_payment" && order.paymentMethod !== "gateway",
    canReview: order.status === "completed",
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    paidAt: order.paidAt,
    shippedAt: null,
    completedAt: null,
    cancelledAt: order.cancelledAt,
    // Issue #112 (contract: #106 D3) — `null` for every order this stub's
    // own gateway-session route has not touched (including every order
    // whose `paymentMethod` is not `"gateway"` at all).
    gateway: order.gateway ?? null,
    whatsapp: {
      number: (settings.whatsapp ?? "").replace(/\D/g, ""),
      text: `Halo ${settings.storeName}, saya ingin menanyakan pesanan ${order.orderCode}`
    }
  };
}

function findOrderForPhone(orderCode, phone) {
  const order = ORDERS.get(orderCode);
  if (!order || !phone) return null;
  if (normalizePhoneForComparison(order.phone) !== normalizePhoneForComparison(phone)) return null;
  return order;
}

async function handleStorefrontRequest(request, url) {
  const origin = request.headers.get("origin");
  const path = url.pathname.slice(STOREFRONT_PREFIX.length) || "/";

  if (request.method === "OPTIONS") {
    if (origin !== ALLOWED_ORIGIN) return new Response(null, { status: 404 });
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(origin),
        // PUT/DELETE (issue #90's wishlist/address routes) join the
        // preflight's allowed methods here — every anonymous route this
        // stub already answered only ever needed GET/POST/PATCH.
        "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
        // "authorization" (issue #88): the bearer-authenticated /account/*
        // routes below need the browser's preflight to allow this header;
        // echoing it here for every storefront route (rather than only the
        // /account/* ones) keeps this one OPTIONS handler simple, and is
        // harmless for the anonymous routes, which never send it.
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "600"
      }
    });
  }

  // An unresolvable tenant (unknown Origin) gets the SAME neutral 404 a
  // disabled module or a rate-limited caller would (the contract's own
  // "same neutral refusal" rule) — no CORS headers either, so the browser's
  // own cross-origin read failure is the only thing a real mismatched
  // caller would ever observe.
  if (origin !== ALLOWED_ORIGIN) {
    return Response.json(NEUTRAL_NOT_FOUND, { status: 404 });
  }

  const headers = corsHeaders(origin);
  let body = null;
  // PATCH (issue #88's `/account/me`) and PUT (issue #90's `/account/
  // wishlist`) read a JSON body the same way POST does — GET/DELETE never
  // send one. `POST …/account/logout` sends NO body at all (issue #88), so
  // an empty body is read as "no body" rather than a `VALIDATION_ERROR` —
  // only a NON-empty, unparsable body is rejected.
  if (request.method === "POST" || request.method === "PATCH" || request.method === "PUT") {
    const text = await request.text();
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        return envelopeError(400, "VALIDATION_ERROR", "Request body must be JSON.", [], headers);
      }
    }
  }

  if (path.startsWith("/account/")) {
    const accountResult = handleAccountRequest(request, path.slice("/account".length), body, headers);
    if (accountResult) return accountResult;
    return Response.json(NEUTRAL_NOT_FOUND, { status: 404, headers });
  }

  if (path === "/cart/quote" && request.method === "POST") {
    return envelope(computeQuote(body ?? {}), { headers });
  }

  if (path === "/orders" && request.method === "POST") {
    const optionalAccount = findAccountByBearer(request);

    if (!body?.customer?.name || !body?.customer?.phone) {
      return envelopeError(
        400,
        "VALIDATION_ERROR",
        "Missing required fields.",
        [
          ...(!body?.customer?.name ? [{ field: "customer.name", message: "Nama wajib diisi." }] : []),
          ...(!body?.customer?.phone ? [{ field: "customer.phone", message: "Nomor WhatsApp wajib diisi." }] : [])
        ],
        headers
      );
    }
    if (!body.shipping) {
      return envelopeError(400, "VALIDATION_ERROR", "Missing shipping method.", [{ field: "shipping", message: "Pilih metode pengiriman." }], headers);
    }
    if (!body.payment?.method) {
      return envelopeError(400, "VALIDATION_ERROR", "Missing payment method.", [{ field: "payment.method", message: "Pilih metode pembayaran." }], headers);
    }

    const existingCode = IDEMPOTENCY_KEYS.get(body.idempotencyKey);
    if (existingCode && ORDERS.has(existingCode)) {
      return envelope(serializeOrder(ORDERS.get(existingCode)), { status: 200, headers });
    }

    // Issue #109 (contract: #106 D4) — `CreateOrderRequest` carries no
    // separate `destination` field (unlike `QuoteRequest`): the shopper's
    // address, when one is given, already names the district the order
    // ships to, so order-time re-validation derives `destination` from
    // `body.address.districtCode` rather than trusting a second, possibly
    // stale copy of it. `self_pickup`/no-address orders pass `null`, same
    // as a quote taken before a district was ever chosen.
    const quote = computeQuote({
      ...body,
      destination: body.address?.districtCode ? { districtCode: body.address.districtCode } : null
    });
    if (!quote.canCheckout) {
      return envelopeError(409, "CART_CHANGED", "Cart changed since the quote was made.", { quote }, headers);
    }

    // The chosen `{method, serviceId}` (and, for a courier, its cost) is
    // re-validated against a FRESH quote at order time, never trusted from
    // the request alone: a rate this stub priced a minute ago may have gone
    // stale (a district's rates changed, courier got disabled) by the time
    // the shopper submits. A mismatch answers the SAME `409 CART_CHANGED` +
    // fresh quote a stock/price change would, matching this contract's own
    // "on mismatch at order time" rule.
    const shippingOption = quote.shippingOptions.find((option) => shippingSelectionMatches(option, body.shipping));
    if (!shippingOption || !shippingOption.available) {
      return envelopeError(409, "CART_CHANGED", "Shipping option changed since the quote was made.", { quote }, headers);
    }

    const settings = storeSettings();
    const orderCode = generateOrderCode();
    const now = new Date();
    const expiryHours = settings.orders?.expiryHours ?? 24;
    const expiresAt = new Date(now.getTime() + expiryHours * 3600_000).toISOString();

    const order = {
      orderCode,
      status: "pending_payment",
      paymentStatus: "unpaid",
      paymentMethod: body.payment.method,
      shippingMethod: body.shipping.method,
      shippingServiceName: shippingOption?.name ?? null,
      customerName: body.customer.name,
      customerEmail: body.customer.email ?? null,
      phone: body.customer.phone,
      address: body.address ?? null,
      lines: quote.lines.map((line) => ({
        name: line.name,
        variantName: line.variantName,
        sku: line.sku,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
        image: line.image,
        serviceFormValues:
          (body.lines ?? []).find((l) => l.productId === line.productId && (l.variantId ?? null) === line.variantId)
            ?.serviceFormValues ?? null
      })),
      subtotal: quote.subtotal,
      discount: quote.discount,
      voucherCode: quote.voucher?.valid ? quote.voucher.code : null,
      shippingCost: quote.shipping ? (quote.freeShippingApplied ? "0.00" : quote.shipping.cost) : "0.00",
      insuranceFee: quote.insurance.fee,
      tax: quote.tax.amount,
      total: quote.total,
      paymentConfirmations: [],
      timeline: [{ status: "pending_payment", at: now.toISOString(), note: null }],
      createdAt: now.toISOString(),
      expiresAt,
      paidAt: null,
      cancelledAt: null,
      // Issue #112 — `null` until this order's own `POST …/payment-gateway/
      // sessions` is called at least once (see `GATEWAY_SESSIONS_BY_ORDER`
      // below), regardless of `paymentMethod`.
      gateway: null,
      // Issue #90 (#86's own "accept an OPTIONAL Bearer … the customer is
      // the account's row") — an anonymous request (no/invalid token) binds
      // to nothing, exactly as before this issue.
      accountEmail: optionalAccount ? normalizeEmail(optionalAccount.email) : null,
      // Issue #93 (#86's own D5) — recorded verbatim, `null` when absent.
      // This stub never validates the code against a real affiliate (an
      // unknown/suspended code is IGNORED per D5, never rejected) and never
      // creates a commission itself — see this file's own header for why.
      affiliateCode: body.affiliateCode ?? null
    };

    ORDERS.set(orderCode, order);
    IDEMPOTENCY_KEYS.set(body.idempotencyKey, orderCode);

    return envelope(serializeOrder(order), { status: 201, headers });
  }

  const orderMatch = /^\/orders\/([^/]+)(.*)$/.exec(path);
  if (orderMatch) {
    const orderCode = decodeURIComponent(orderMatch[1]);
    const rest = orderMatch[2];

    if (rest === "" && request.method === "GET") {
      const phone = url.searchParams.get("phone") ?? "";
      const order = findOrderForPhone(orderCode, phone);
      if (!order) return Response.json(NEUTRAL_NOT_FOUND, { status: 404, headers });
      return envelope(serializeOrder(order), { headers });
    }

    if (rest === "/payment-confirmations" && request.method === "POST") {
      const order = findOrderForPhone(orderCode, body?.phone ?? "");
      if (!order) return Response.json(NEUTRAL_NOT_FOUND, { status: 404, headers });
      if (order.status !== "pending_payment") {
        return envelopeError(409, "ORDER_NOT_PAYABLE", "This order can no longer be paid.", undefined, headers);
      }
      order.paymentConfirmations.push({
        id: crypto.randomUUID(),
        method: body.method,
        amount: body.amount,
        status: "submitted",
        submittedAt: new Date().toISOString()
      });
      return envelope(serializeOrder(order), { status: 201, headers });
    }

    if (rest === "/payment-proof/upload-sessions" && request.method === "POST") {
      // This stub has no R2 configured — matching `store-settings-public.
      // json`'s own `payment.proofUpload: false` for this same reason.
      return envelopeError(503, "MEDIA_UNAVAILABLE", "Payment proof upload is not available on this stub.", undefined, headers);
    }

    if (rest === "/cancel" && request.method === "POST") {
      const order = findOrderForPhone(orderCode, body?.phone ?? "");
      if (!order) return Response.json(NEUTRAL_NOT_FOUND, { status: 404, headers });
      if (order.status !== "pending_payment") {
        return envelopeError(409, "ORDER_NOT_CANCELLABLE", "This order can no longer be cancelled.", undefined, headers);
      }
      order.status = "cancelled";
      order.cancelledAt = new Date().toISOString();
      order.timeline.push({ status: "cancelled", at: order.cancelledAt, note: body?.reason ?? null });
      return envelope(serializeOrder(order), { headers });
    }

    if (rest === "/payment-gateway/sessions" && request.method === "POST") {
      const order = ORDERS.get(orderCode);
      if (!order) return Response.json(NEUTRAL_NOT_FOUND, { status: 404, headers });

      // Ownership: the SAME phone/Bearer proof every other order-scoped
      // route on this stub already requires (see `findOrderForPhone`
      // above) — a caller that owns neither gets the same neutral 404 an
      // unresolvable tenant would, never a hint about which check failed.
      const account = findAccountByBearer(request);
      const ownsByPhone = Boolean(body?.phone) && normalizePhoneForComparison(order.phone) === normalizePhoneForComparison(body.phone);
      const ownsByAccount = Boolean(account) && order.accountEmail === normalizeEmail(account.email);
      if (!ownsByPhone && !ownsByAccount) {
        return Response.json(NEUTRAL_NOT_FOUND, { status: 404, headers });
      }

      if (order.paymentMethod !== "gateway" || order.status !== "pending_payment") {
        return envelopeError(
          409,
          "PAYMENT_NOT_APPLICABLE",
          "This order has no gateway payment to start.",
          undefined,
          headers
        );
      }

      const settings = storeSettings();
      if (!(settings.payment?.gatewayEnabled ?? false)) {
        return envelopeError(
          503,
          "GATEWAY_UNAVAILABLE",
          "Payment gateway is not available on this deployment.",
          undefined,
          headers
        );
      }

      // Idempotent per order (this contract's own rule) — a repeated call
      // for the SAME order answers with the session already minted for it,
      // never a second `redirectUrl`.
      let session = GATEWAY_SESSIONS_BY_ORDER.get(orderCode);
      if (!session) {
        gatewaySessionSequence += 1;
        const sessionId = `gw-${gatewaySessionSequence}`;
        session = {
          sessionId,
          orderCode,
          providerRef: `stub-${sessionId}`,
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          returnBase: gatewayReturnBase(request)
        };
        GATEWAY_SESSIONS_BY_ORDER.set(orderCode, session);
        GATEWAY_SESSIONS_BY_ID.set(sessionId, session);
        order.gateway = { provider: "stub", status: "created" };
      }

      return envelope(
        {
          redirectUrl: `http://localhost:${PORT}/stub/gateway/${session.sessionId}`,
          expiresAt: session.expiresAt,
          providerRef: session.providerRef
        },
        { status: 201, headers }
      );
    }
  }

  if (path === "/reviews" && request.method === "POST") {
    const order = findOrderForPhone(body?.orderCode, body?.phone ?? "");
    if (!order) return Response.json(NEUTRAL_NOT_FOUND, { status: 404, headers });
    if (order.status !== "completed") {
      return envelopeError(409, "REVIEW_NOT_ALLOWED", "This order is not eligible for a review yet.", undefined, headers);
    }

    const reviewId = crypto.randomUUID();

    // Issue #90 — an OPTIONAL Bearer (#86's own rule, mirroring `/orders`
    // above) additionally binds the review to that account, so it shows up
    // on `GET /account/reviews`. An anonymous submission behaves exactly as
    // before this issue: recorded, but invisible to any account.
    const account = findAccountByBearer(request);
    if (account) {
      const product = productCatalog().find((p) => p.id === body.productId);
      account.reviews.push({
        id: reviewId,
        productId: body.productId,
        productName: product?.name ?? "Produk",
        orderCode: order.orderCode,
        rating: body.rating,
        body: body.body,
        status: "pending",
        createdAt: new Date().toISOString()
      });
    }

    return envelope({ id: reviewId, status: "pending" }, { status: 201, headers });
  }

  return Response.json(NEUTRAL_NOT_FOUND, { status: 404, headers });
}

/**
 * Issue #112 (contract: #106 D3) — the stub's OWN hosted payment page,
 * `GET /stub/gateway/{sessionId}`, and its two forms. This is deliberately
 * NOT under `STOREFRONT_PREFIX`/`ALLOWED_ORIGIN`'s CORS gate: a real payment
 * gateway's hosted page is the PROVIDER's own origin, not the CMS's, and a
 * shopper's browser navigates there with a plain top-level `GET` — no CORS,
 * no `Origin` check, the same as any other page on the open web the browser
 * is simply sent to. "Bayar (simulasi)" flips the order to `paid` (with
 * `paidAt` and a timeline entry, `gateway.status: "paid"`); "Batal" leaves
 * the order exactly as it was, only marking `gateway.status: "failed"`. Both
 * then `302` back to `{returnBase}/pesanan?kode={orderCode}` — never a
 * different order, never a bare 200, matching how a shopper is expected to
 * land back on `/pesanan`'s own polling/"Bayar sekarang" UI either way.
 */
function gatewayPageHtml(order, sessionId) {
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<title>Simulasi Pembayaran</title>
</head>
<body>
<h1>Simulasi Pembayaran Gateway</h1>
<p>Pesanan: ${order.orderCode} — Total: Rp ${order.total}</p>
<form method="post" action="/stub/gateway/${sessionId}/pay">
<button type="submit">Bayar (simulasi)</button>
</form>
<form method="post" action="/stub/gateway/${sessionId}/cancel">
<button type="submit">Batal</button>
</form>
</body>
</html>`;
}

function handleStubGatewayPage(request, url) {
  const match = /^\/stub\/gateway\/([^/]+)(\/pay|\/cancel)?\/?$/.exec(url.pathname);
  if (!match) return new Response("Not found", { status: 404 });

  const session = GATEWAY_SESSIONS_BY_ID.get(match[1]);
  if (!session) return new Response("Sesi pembayaran tidak ditemukan atau telah kedaluwarsa.", { status: 404 });

  const order = ORDERS.get(session.orderCode);
  if (!order) return new Response("Pesanan tidak ditemukan.", { status: 404 });

  const action = match[2];
  const returnUrl = `${session.returnBase}/pesanan?kode=${encodeURIComponent(order.orderCode)}`;

  if (!action && request.method === "GET") {
    return new Response(gatewayPageHtml(order, session.sessionId), {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }

  if (action === "/pay" && request.method === "POST") {
    if (order.status === "pending_payment") {
      order.status = "paid";
      order.paymentStatus = "paid";
      order.paidAt = new Date().toISOString();
      order.timeline.push({ status: "paid", at: order.paidAt, note: "Dibayar melalui gateway (simulasi)." });
    }
    order.gateway = { provider: "stub", status: "paid" };
    return Response.redirect(returnUrl, 302);
  }

  if (action === "/cancel" && request.method === "POST") {
    order.gateway = { provider: "stub", status: "failed" };
    return Response.redirect(returnUrl, 302);
  }

  return new Response("Not found", { status: 404 });
}

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);

    // The stub's own hosted payment page — see `handleStubGatewayPage`'s
    // own docblock for why this is checked BEFORE, and outside, every other
    // gate in this file.
    if (url.pathname.startsWith("/stub/gateway/")) {
      return handleStubGatewayPage(request, url);
    }

    // Anonymous, cross-origin, no bearer token at all — handled BEFORE the
    // bearer-token gate below, which every OTHER route in this file needs.
    if (url.pathname.startsWith(STOREFRONT_PREFIX)) {
      return handleStorefrontRequest(request, url);
    }

    // Public, no auth at all — matches the real route exactly (see file
    // header). Checked BEFORE the bearer-token gate below, not after: a
    // stub that demanded a header the real route never asks for would hide
    // a caller that forgot to send one wasn't actually required.
    if (TOKENS_CSS_PATTERN.test(url.pathname)) {
      return new Response(rawFixture("tokens.css"), {
        headers: { "content-type": "text/css; charset=utf-8" }
      });
    }

    const authorization = request.headers.get("authorization") ?? "";

    // Not a security boundary — this is a local fixture server — but a
    // build that sent NO Authorization header at all would be a real bug in
    // `awcmsGet`, and a stub that accepted it silently would hide exactly
    // that bug.
    if (!authorization.startsWith("Bearer ")) {
      return Response.json(
        { success: false, error: { code: "UNAUTHENTICATED", message: "Missing bearer token." } },
        { status: 401 }
      );
    }

    const detailMatch = BLOG_PAGE_DETAIL_PATTERN.exec(url.pathname);
    if (detailMatch) {
      const slug = decodeURIComponent(detailMatch[1]);
      const detail = fixture("blog-pages-public-detail.json")[slug];
      if (!detail) {
        return Response.json(
          { success: false, error: { code: "RESOURCE_NOT_FOUND", message: `No stub page for slug ${slug}` } },
          { status: 404 }
        );
      }
      return Response.json({ success: true, data: detail });
    }

    const handler = ROUTES[url.pathname];
    if (!handler) {
      return Response.json(
        { success: false, error: { code: "NOT_FOUND", message: `No stub route for ${url.pathname}` } },
        { status: 404 }
      );
    }

    const data = handler(url);
    // A handler that already built a full `Response` (issue #49's analytics
    // route, for its `400`) is passed through; everything else is wrapped in
    // the success envelope exactly as before.
    if (data instanceof Response) return data;
    return Response.json({ success: true, data });
  }
});

console.log(`[stub-awcms] serving fixtures on http://localhost:${server.port}`);
