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
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
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
  if (request.method === "POST") {
    try {
      body = await request.json();
    } catch {
      return envelopeError(400, "VALIDATION_ERROR", "Request body must be JSON.", [], headers);
    }
  }

  if (path === "/cart/quote" && request.method === "POST") {
    return envelope(computeQuote(body ?? {}), { headers });
  }

  if (path === "/orders" && request.method === "POST") {
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
      cancelledAt: null
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
    return envelope({ id: crypto.randomUUID(), status: "pending" }, { status: 201, headers });
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
