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

function shippingOptionsFor(storeSettingsValue) {
  const options = [];
  for (const service of storeSettingsValue.shipping?.alternativeServices ?? []) {
    options.push({ method: "alternative", serviceId: service.id, name: service.name, cost: service.cost, available: true });
  }
  if (storeSettingsValue.shipping?.selfPickup) {
    options.push({ method: "self_pickup", serviceId: null, name: "Ambil di toko", cost: "0.00", available: true });
  }
  options.push({
    method: "courier",
    serviceId: null,
    name: "Kurir (segera)",
    cost: null,
    available: Boolean(storeSettingsValue.shipping?.courierEnabled)
  });
  return options;
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

  const shippingOptions = shippingOptionsFor(settings);
  let shipping = null;
  if (body.shipping) {
    const match = shippingOptions.find(
      (option) =>
        option.method === body.shipping.method &&
        (option.method !== "alternative" || option.serviceId === body.shipping.serviceId)
    );
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
      { method: "dp", available: downPaymentAvailable }
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

/** Accounts keyed by normalized e-mail — seeded once from the fixture, then grown by `purpose:"register"` verifies. */
const ACCOUNTS = new Map(
  fixture("customer-accounts.json").map((account) => [
    normalizeEmail(account.email),
    {
      ...account,
      // Only the fixture's own `budi@example.test` gets the seeded
      // addresses/orders below — a second fixture row (if one is ever
      // added) starts empty, same as a freshly registered account.
      addresses: normalizeEmail(account.email) === "budi@example.test" ? SEEDED_ADDRESSES.map((a) => ({ ...a })) : [],
      wishlist: [],
      reviews: []
    }
  ])
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
    historyFrom: account.historyFrom
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

function handleAccountRequest(request, path, body, headers) {
  if (path === "/otp/request" && request.method === "POST") {
    const emailNormalized = normalizeEmail(body?.email);
    const purpose = body?.purpose === "register" ? "register" : "login";

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
    const emailNormalized = normalizeEmail(body?.email);
    const purpose = body?.purpose === "register" ? "register" : "login";
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
      historyFrom: now
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

  return null;
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
    canConfirmPayment: order.status === "pending_payment",
    canReview: order.status === "completed",
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    paidAt: order.paidAt,
    shippedAt: null,
    completedAt: null,
    cancelledAt: order.cancelledAt,
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

    const quote = computeQuote(body);
    if (!quote.canCheckout) {
      return envelopeError(409, "CART_CHANGED", "Cart changed since the quote was made.", { quote }, headers);
    }

    const settings = storeSettings();
    const orderCode = generateOrderCode();
    const now = new Date();
    const expiryHours = settings.orders?.expiryHours ?? 24;
    const expiresAt = new Date(now.getTime() + expiryHours * 3600_000).toISOString();

    const shippingOption = quote.shippingOptions.find(
      (option) => option.method === body.shipping.method && (option.method !== "alternative" || option.serviceId === body.shipping.serviceId)
    );

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
      // Issue #90 (#86's own "accept an OPTIONAL Bearer … the customer is
      // the account's row") — an anonymous request (no/invalid token) binds
      // to nothing, exactly as before this issue.
      accountEmail: optionalAccount ? normalizeEmail(optionalAccount.email) : null
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

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);

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
