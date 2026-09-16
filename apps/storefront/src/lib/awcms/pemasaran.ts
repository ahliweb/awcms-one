/**
 * Marketing/merchandising read models — sliders, flash sales, vouchers,
 * testimonials, popups, and public store settings — built EXACTLY against
 * the #26⇄#27 contract (`commerce-public-read-models.md`, in the manager's
 * scratchpad): paths, field names, and "money is a string" all copied
 * verbatim from that document, not guessed from `mart-home.json`'s legacy
 * shape (which this file's fixtures use only for realistic CONTENT — names,
 * slugs, texts — never for field names).
 *
 * Every fetch below is isolated to this ONE file, on purpose: #26 (the CMS
 * side of this contract) is being built in parallel, and a deviation the
 * manager relays after #26 merges is a one-file fix. Each fetch also
 * tolerates a 404 — the endpoint does not exist yet on an awcms this old —
 * by degrading to an empty list/`null` with exactly ONE `console.warn` per
 * resource (memoization guarantees the fetch, and so the warning, runs at
 * most once per build regardless of how many pages read it). Any OTHER
 * failure (500, timeout, unreachable, a malformed payload) still THROWS —
 * this file never silently swallows a real outage, only a not-yet-built
 * endpoint.
 */
import { AwcmsApiError, awcmsGet } from "./client";

// ---------------------------------------------------------------------------
// Store settings
// ---------------------------------------------------------------------------

export type StoreFaq = { question: string; answer: string };
export type CustomerLevel = { level: number; name: string };
export type StoreLogo = { url: string; alt: string; width: number; height: number };
export type StoreFavicon = { url: string };
export type PromoSectionItem = {
  badge: string | null;
  title: string;
  subtitle: string | null;
  tags: string[];
  buttonText: string | null;
  buttonLink: string | null;
};
export type PromoSection = { active: boolean; items: PromoSectionItem[] };
export type ShippingAlternativeService = { id: string; name: string; cost: string };
export type ShippingSettings = {
  alternativeServices: ShippingAlternativeService[];
  selfPickup: boolean;
  courierEnabled: boolean;
  pinpointEnabled: boolean;
  freeShipping: { active: boolean; minOrder: string; maxDiscount: string };
  originCityName: string | null;
  originSubdistrictName: string | null;
};
export type PaymentSettings = {
  manualBank: { active: boolean; banks: { bankName: string }[] };
  manualQris: { active: boolean };
  downPayment: { active: boolean; percent: number };
  tax: { active: boolean; percent: number };
  insurance: { active: boolean; ratePercent: string; minFee: string };
  /**
   * Added by #29 to `GET /api/v1/commerce/store-settings/public`
   * (`commerce-storefront-endpoints.md`'s own "Store settings additions").
   * `false` (not just "absent") on any awcms that predates #29 — checked
   * with `?? false` at every read site, never assumed `true` — so
   * `/pesanan`'s payment-proof upload form stays hidden rather than
   * offering an upload the CMS has nowhere to receive.
   */
  proofUpload?: boolean;
};

export type StoreSettings = {
  storeName: string;
  tagline: string | null;
  logo: StoreLogo | null;
  favicon: StoreFavicon | null;
  address: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  /** Only rendered on `/kontak` when non-null AND a Google Maps embed URL — see `isGoogleMapsEmbedUrl` below. */
  mapsEmbedUrl: string | null;
  faqs: StoreFaq[];
  social: Partial<Record<"facebook" | "instagram" | "tiktok" | "x" | "youtube" | "linkedin", string | null>>;
  customerLevels: CustomerLevel[];
  shipping: ShippingSettings | null;
  payment: PaymentSettings | null;
  promoSection: PromoSection | null;
  meta: {
    home: { title: string | null; description: string | null };
    contact: { title: string | null; description: string | null };
  } | null;
  /** Added by #29 alongside `payment.proofUpload` above — not read by this app today (`/pesanan`'s countdown uses each order's own `expiresAt`, not this store-wide default), modelled here only so `StoreSettings` stays a faithful mirror of the public read model. */
  orders?: { expiryHours: number };
};

/** BjekMart's own well-known level names — the same "a real fallback, never an invented placeholder" convention `src/config/site.ts`'s `DEFAULT_IDENTITY` already follows — used only when awcms has not (yet) configured `customerLevels` at all. */
const DEFAULT_CUSTOMER_LEVELS: CustomerLevel[] = [
  { level: 1, name: "Pelanggan Umum" },
  { level: 2, name: "Reseller" },
  { level: 3, name: "Agen" },
  { level: 4, name: "Distributor" }
];

const EMPTY_STORE_SETTINGS: StoreSettings = {
  storeName: "",
  tagline: null,
  logo: null,
  favicon: null,
  address: null,
  phone: null,
  whatsapp: null,
  email: null,
  mapsEmbedUrl: null,
  faqs: [],
  social: {},
  customerLevels: DEFAULT_CUSTOMER_LEVELS,
  shipping: null,
  payment: null,
  promoSection: null,
  meta: null
};

/**
 * A maps-embed URL is only ever rendered inside a SANDBOXED `<iframe>`
 * (`src/pages/kontak.astro`), and only when it is genuinely a Google Maps
 * embed origin — never an arbitrary URL a store owner (or a compromised
 * admin session) could set to frame an attacker-controlled page inside this
 * site's own `<iframe>`. `www.google.com/maps/embed` is the origin Google's
 * own "Embed a map" feature generates; nothing else is accepted.
 */
export function isGoogleMapsEmbedUrl(value: string | null): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" &&
        url.hostname === "www.google.com" &&
        url.pathname.startsWith("/maps/embed")) ||
      (url.protocol === "https:" && url.hostname === "www.google.com" && url.pathname === "/maps/d/embed")
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sliders
// ---------------------------------------------------------------------------

export type Slider = {
  id: string;
  title: string;
  subtitle: string | null;
  image: { url: string; alt: string; width: number; height: number };
  linkUrl: string | null;
  buttonText: string | null;
  sortOrder: number;
};

// ---------------------------------------------------------------------------
// Flash sales
// ---------------------------------------------------------------------------

export type FlashSaleStatus = "scheduled" | "active";

export type FlashSaleProductEntry = {
  productId: string;
  variantId: string | null;
  salePrice: string;
  originalPrice: string;
  quota: number;
  sold: number;
  sortOrder: number;
  product: { id: string; slug: string; name: string; image: { url: string; alt: string } | null };
};

export type FlashSale = {
  id: string;
  name: string;
  slug: string;
  startsAt: string;
  endsAt: string;
  status: FlashSaleStatus;
  products: FlashSaleProductEntry[];
};

/** The flash sale (if any) whose `products[]` includes `productId`/`variantId`, and that entry — a product detail page's "is this in a flash sale" check. `variantId: null` on the entry means the sale applies at the PRODUCT level (matches regardless of which variant, if any, is selected). */
export function findFlashSaleForProduct(
  flashSales: readonly FlashSale[],
  productId: string,
  variantId: string | null
): { sale: FlashSale; entry: FlashSaleProductEntry } | null {
  for (const sale of flashSales) {
    const entry = sale.products.find(
      (candidate) =>
        candidate.productId === productId &&
        (candidate.variantId === null || candidate.variantId === variantId)
    );
    if (entry) return { sale, entry };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Vouchers
// ---------------------------------------------------------------------------

export type VoucherType = "percentage" | "nominal" | "free_shipping";

export type Voucher = {
  id: string;
  code: string;
  name: string;
  type: VoucherType;
  value: string;
  minOrder: string;
  maxDiscount: string | null;
  startsAt: string;
  endsAt: string;
  description: string | null;
};

// ---------------------------------------------------------------------------
// Testimonials
// ---------------------------------------------------------------------------

export type Testimonial = {
  id: string;
  authorName: string;
  authorRole: string | null;
  body: string;
  rating: number;
  avatar: { url: string; alt: string } | null;
  sortOrder: number;
};

// ---------------------------------------------------------------------------
// Popups
// ---------------------------------------------------------------------------

export type PopupFrequency = "once_per_session" | "once_per_day" | "always";

export type Popup = {
  id: string;
  title: string;
  body: string;
  image: { url: string; alt: string } | null;
  linkUrl: string | null;
  buttonText: string | null;
  frequency: PopupFrequency;
  startsAt: string | null;
  endsAt: string | null;
};

// ---------------------------------------------------------------------------
// Fetching — one memoized, 404-tolerant getter per resource.
// ---------------------------------------------------------------------------

/** `true` only for a 404 — "this awcms does not serve this endpoint yet". Any other status (403, 500, a timeout, unreachable) is NOT tolerated here; see this file's own header. */
function isMissingEndpoint(error: unknown): error is AwcmsApiError {
  return error instanceof AwcmsApiError && error.status === 404;
}

function warnMissing(resource: string, path: string): void {
  console.warn(
    `[awcms] ${resource} not read: this awcms does not serve GET ${path} yet ` +
      `(issue #26). Falling back to an empty/default value for ${resource} — ` +
      `the build succeeds, and this section of the storefront renders ` +
      `nothing until #26 lands.`
  );
}

let storeSettingsCache: Promise<StoreSettings> | undefined;

export function getStoreSettings(): Promise<StoreSettings> {
  const path = "/api/v1/commerce/store-settings/public";
  storeSettingsCache ??= (async () => {
    try {
      return await awcmsGet<StoreSettings>(path);
    } catch (error) {
      if (isMissingEndpoint(error)) {
        warnMissing("store settings", path);
        return EMPTY_STORE_SETTINGS;
      }
      throw error;
    }
  })();
  return storeSettingsCache;
}

let slidersCache: Promise<Slider[]> | undefined;

export function getActiveSliders(): Promise<Slider[]> {
  const path = "/api/v1/commerce/sliders/active";
  slidersCache ??= (async () => {
    try {
      return await awcmsGet<Slider[]>(path);
    } catch (error) {
      if (isMissingEndpoint(error)) {
        warnMissing("sliders", path);
        return [];
      }
      throw error;
    }
  })();
  return slidersCache;
}

let flashSalesCache: Promise<FlashSale[]> | undefined;

export function getActiveFlashSales(): Promise<FlashSale[]> {
  const path = "/api/v1/commerce/flash-sales/active";
  flashSalesCache ??= (async () => {
    try {
      return await awcmsGet<FlashSale[]>(path);
    } catch (error) {
      if (isMissingEndpoint(error)) {
        warnMissing("flash sales", path);
        return [];
      }
      throw error;
    }
  })();
  return flashSalesCache;
}

let vouchersCache: Promise<Voucher[]> | undefined;

export function getPublicVouchers(): Promise<Voucher[]> {
  const path = "/api/v1/commerce/vouchers/public";
  vouchersCache ??= (async () => {
    try {
      return await awcmsGet<Voucher[]>(path);
    } catch (error) {
      if (isMissingEndpoint(error)) {
        warnMissing("public vouchers", path);
        return [];
      }
      throw error;
    }
  })();
  return vouchersCache;
}

let testimonialsCache: Promise<Testimonial[]> | undefined;

export function getActiveTestimonials(): Promise<Testimonial[]> {
  const path = "/api/v1/commerce/testimonials/active";
  testimonialsCache ??= (async () => {
    try {
      return await awcmsGet<Testimonial[]>(path);
    } catch (error) {
      if (isMissingEndpoint(error)) {
        warnMissing("testimonials", path);
        return [];
      }
      throw error;
    }
  })();
  return testimonialsCache;
}

let popupCache: Promise<Popup | null> | undefined;

/** `null` is a NORMAL, successful answer here ("no active popup") — distinct from the 404 tolerance below, which is about the ENDPOINT not existing at all. */
export function getActivePopup(): Promise<Popup | null> {
  const path = "/api/v1/commerce/popups/active";
  popupCache ??= (async () => {
    try {
      return await awcmsGet<Popup | null>(path);
    } catch (error) {
      if (isMissingEndpoint(error)) {
        warnMissing("the promo popup", path);
        return null;
      }
      throw error;
    }
  })();
  return popupCache;
}

/** Test seam: drops every memoized fetch above, so a test file can register its own mock `fetch` per case without inheriting a previous test's cached result. */
export function resetPemasaranCacheForTests(): void {
  storeSettingsCache = undefined;
  slidersCache = undefined;
  flashSalesCache = undefined;
  vouchersCache = undefined;
  testimonialsCache = undefined;
  popupCache = undefined;
}
