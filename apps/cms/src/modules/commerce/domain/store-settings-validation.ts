/**
 * `awcms_commerce_store_settings.settings` — the versioned jsonb schema
 * (Issue #26). Pure — no database, no I/O.
 *
 * One row per tenant, the whole object replaced by `PUT
 * /api/v1/commerce/store-settings` (never a partial `PATCH` merge — the
 * settings screen always submits the full form, so "absent means unchanged"
 * has no caller that needs it). `validateStoreSettingsInput` therefore
 * follows `validateCreateProductInput`'s shape (fully resolves every field,
 * defaulting whatever a caller omits) rather than `validateUpdate*`'s
 * partial-patch shape.
 *
 * Field names here match `GET .../store-settings/public`'s contract
 * (`docs`'s commerce-public-read-models contract) almost verbatim, so the
 * public projection (`toPublicRecord` in
 * `application/store-settings-directory.ts`) is close to an identity
 * mapping — it only STRIPS what must never leave this tenant's own owner
 * view (`payment.manualBank.accounts[].accountNumber`/`.accountHolder`,
 * `payment.manualQris.mediaObjectId`) and RESOLVES `logoMediaObjectId`/
 * `faviconMediaObjectId` to public URLs through `MediaLibraryPort`, the same
 * way `product-directory.ts` resolves product images.
 *
 * `customerLevels[].type`/`.value` (a level's default discount RULE) is
 * stored and validated here but not yet CONSUMED anywhere — applying it at
 * checkout is #29's job; this issue only owns the schema.
 */

export type ValidationError = { field: string; message: string };
type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

export const STORE_SETTINGS_SCHEMA_VERSION = 1;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRICE_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;
const RATE_PERCENT_PATTERN = /^\d{1,3}(\.\d{1,2})?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Flags a key on `record` that is not in `allowed` (Issue #26 acceptance
 * criterion: "reject unknown keys"). A typo'd or renamed field (an owner
 * migrating a legacy export, a caller guessing at a field name) would
 * otherwise silently vanish rather than error — the same "fail loud on a
 * shape the schema does not recognize" rule a versioned jsonb blob needs,
 * since nothing else here would ever catch a client writing to a field this
 * schema no longer has. Applied at the top level and at every nested object
 * this schema defines; left off array-item shapes (`faqs[]`,
 * `customerLevels[]`, `alternativeServices[]`, bank `accounts[]`, promo
 * `items[]`) where the existing field-by-field validators already reject a
 * missing REQUIRED key and an extra key on a list entry is far less likely to
 * be a caller's typo than a top-level/nested-object field name.
 */
function rejectUnknownKeys(
  value: unknown,
  allowed: readonly string[],
  path: string,
  errors: ValidationError[]
): void {
  if (!isRecord(value)) return;
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      errors.push({
        field: path ? `${path}.${key}` : key,
        message: `${path ? `${path}.${key}` : key} is not a recognized field.`
      });
    }
  }
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, max);
}

function requiredText(
  value: unknown,
  field: string,
  max: number,
  errors: ValidationError[],
  fallback = ""
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push({ field, message: `${field} is required.` });
    return fallback;
  }
  if (value.trim().length > max) {
    errors.push({
      field,
      message: `${field} must be at most ${max} characters.`
    });
    return value.trim().slice(0, max);
  }
  return value.trim();
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function money(
  value: unknown,
  field: string,
  errors: ValidationError[],
  fallback = "0.00"
): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !PRICE_PATTERN.test(value)) {
    errors.push({
      field,
      message: `${field} must be a non-negative decimal string with at most 2 fractional digits.`
    });
    return fallback;
  }
  return value;
}

function percent0to100(
  value: unknown,
  field: string,
  errors: ValidationError[],
  fallback = 0
): number {
  if (value === undefined || value === null) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 100
  ) {
    errors.push({
      field,
      message: `${field} must be an integer between 0 and 100.`
    });
    return fallback;
  }
  return value;
}

function optionalUuid(
  value: unknown,
  field: string,
  errors: ValidationError[]
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    errors.push({ field, message: `${field} must be a valid UUID, or null.` });
    return null;
  }
  return value;
}

export type StoreSettingsFaq = { question: string; answer: string };

function validateFaqs(
  value: unknown,
  errors: ValidationError[]
): StoreSettingsFaq[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({ field: "faqs", message: "faqs must be an array." });
    return [];
  }
  if (value.length > 50) {
    errors.push({
      field: "faqs",
      message: "faqs must contain at most 50 entries."
    });
  }
  return value.slice(0, 50).map((entry, index) => {
    const record = isRecord(entry) ? entry : {};
    return {
      question: requiredText(
        record.question,
        `faqs[${index}].question`,
        300,
        errors
      ),
      answer: requiredText(record.answer, `faqs[${index}].answer`, 4000, errors)
    };
  });
}

export type StoreSettingsSocial = {
  facebook: string | null;
  instagram: string | null;
  tiktok: string | null;
  x: string | null;
  youtube: string | null;
  linkedin: string | null;
};

const SOCIAL_KEYS = [
  "facebook",
  "instagram",
  "tiktok",
  "x",
  "youtube",
  "linkedin"
] as const;

function validateSocial(
  value: unknown,
  errors: ValidationError[]
): StoreSettingsSocial {
  rejectUnknownKeys(value, SOCIAL_KEYS, "social", errors);
  const record = isRecord(value) ? value : {};
  return {
    facebook: text(record.facebook, 300),
    instagram: text(record.instagram, 300),
    tiktok: text(record.tiktok, 300),
    x: text(record.x, 300),
    youtube: text(record.youtube, 300),
    linkedin: text(record.linkedin, 300)
  };
}

export type StoreSettingsCustomerLevel = {
  level: number;
  name: string;
  type: "percentage" | "nominal";
  value: string;
};

/** Always exactly 4 levels, numbered 1-4 — the fixed shape BjekMart's legacy `customer_level_1..4_name` columns already had, kept as a fixed-arity array rather than an open list so the public `customerLevels` contract stays a stable 4-tuple. */
/**
 * The name a level gets when a `PUT` omits `customerLevels` entirely — the
 * same four the default settings row carries, so "I never touched the
 * levels" round-trips instead of failing four fields an owner never saw.
 * An array that IS sent must name every level: a present-but-empty name is
 * a mistake worth refusing, an absent section is a default worth keeping.
 */
export const DEFAULT_CUSTOMER_LEVEL_NAMES: readonly [
  string,
  string,
  string,
  string
] = ["Level 1", "Level 2", "Level 3", "Level 4"];

function validateCustomerLevels(
  value: unknown,
  errors: ValidationError[]
): StoreSettingsCustomerLevel[] {
  const absent = value === undefined || value === null;
  const input = Array.isArray(value) ? value : [];
  const levels: StoreSettingsCustomerLevel[] = [];
  for (let level = 1; level <= 4; level += 1) {
    const record = isRecord(input[level - 1]) ? input[level - 1] : {};
    const type = record.type === "nominal" ? "nominal" : "percentage";
    levels.push({
      level,
      name: absent
        ? DEFAULT_CUSTOMER_LEVEL_NAMES[level - 1]!
        : requiredText(
            record.name,
            `customerLevels[${level - 1}].name`,
            100,
            errors,
            `Level ${level}`
          ),
      type,
      value: money(record.value, `customerLevels[${level - 1}].value`, errors)
    });
  }
  return levels;
}

export type StoreSettingsAlternativeService = {
  id: string;
  name: string;
  cost: string;
};

function validateAlternativeServices(
  value: unknown,
  errors: ValidationError[]
): StoreSettingsAlternativeService[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({
      field: "shipping.alternativeServices",
      message: "shipping.alternativeServices must be an array."
    });
    return [];
  }
  if (value.length > 20) {
    errors.push({
      field: "shipping.alternativeServices",
      message: "shipping.alternativeServices must contain at most 20 entries."
    });
  }
  return value.slice(0, 20).map((entry, index) => {
    const record = isRecord(entry) ? entry : {};
    const id = text(record.id, 50) ?? crypto.randomUUID();
    return {
      id,
      name: requiredText(
        record.name,
        `shipping.alternativeServices[${index}].name`,
        100,
        errors
      ),
      cost: money(
        record.cost,
        `shipping.alternativeServices[${index}].cost`,
        errors
      )
    };
  });
}

/**
 * Issue #107 (contract #106 D4) — the courier-rate integration's own on/off
 * switch and configuration, separate from the pre-existing (and, until now,
 * entirely decorative — `domain/cart-quote.ts`'s `buildShippingOptions`
 * always listed a courier option as `available: false` regardless of it)
 * `shipping.courierEnabled` flag: that flag is now purely a stored input
 * this schema still accepts for backward compatibility with any settings
 * blob written before this issue, but neither `cart-quote.ts` nor the public
 * read model gates on it any longer — `shipping.courier.enabled` is the ONE
 * flag that turns live courier rates on, and the public projection's own
 * `shipping.courierEnabled` (`application/store-settings-directory.ts`'s
 * `toPublicRecord`) is now DERIVED from `courier.enabled && a provider is
 * configured`, never read back from this stored field.
 */
export type StoreSettingsCourier = {
  enabled: boolean;
  originDestinationId: string | null;
  couriers: string[];
};

export type StoreSettingsShipping = {
  alternativeServices: StoreSettingsAlternativeService[];
  selfPickup: boolean;
  courierEnabled: boolean;
  pinpointEnabled: boolean;
  freeShipping: { active: boolean; minOrder: string; maxDiscount: string };
  originCityName: string | null;
  originSubdistrictName: string | null;
  courier: StoreSettingsCourier;
};

const SHIPPING_KEYS = [
  "alternativeServices",
  "selfPickup",
  "courierEnabled",
  "pinpointEnabled",
  "freeShipping",
  "originCityName",
  "originSubdistrictName",
  "courier"
] as const;
const FREE_SHIPPING_KEYS = ["active", "minOrder", "maxDiscount"] as const;
const COURIER_KEYS = ["enabled", "originDestinationId", "couriers"] as const;
const COURIER_CODE_PATTERN = /^[a-z0-9_-]{1,30}$/;

function validateCourierCodes(
  value: unknown,
  errors: ValidationError[]
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    errors.push({
      field: "shipping.courier.couriers",
      message: "shipping.courier.couriers must be an array."
    });
    return [];
  }
  if (value.length > 20) {
    errors.push({
      field: "shipping.courier.couriers",
      message: "shipping.courier.couriers must contain at most 20 entries."
    });
  }
  const codes: string[] = [];
  value.slice(0, 20).forEach((entry, index) => {
    if (typeof entry !== "string" || !COURIER_CODE_PATTERN.test(entry)) {
      errors.push({
        field: `shipping.courier.couriers[${index}]`,
        message: `shipping.courier.couriers[${index}] must be a lowercase courier code.`
      });
      return;
    }
    codes.push(entry);
  });
  return codes;
}

function validateCourier(
  value: unknown,
  errors: ValidationError[]
): StoreSettingsCourier {
  rejectUnknownKeys(value, COURIER_KEYS, "shipping.courier", errors);
  const record = isRecord(value) ? value : {};
  return {
    enabled: bool(record.enabled, false),
    originDestinationId: text(record.originDestinationId, 100),
    couriers: validateCourierCodes(record.couriers, errors)
  };
}

function validateShipping(
  value: unknown,
  errors: ValidationError[]
): StoreSettingsShipping {
  rejectUnknownKeys(value, SHIPPING_KEYS, "shipping", errors);
  const record = isRecord(value) ? value : {};
  const freeShippingRecord = isRecord(record.freeShipping)
    ? record.freeShipping
    : {};
  rejectUnknownKeys(
    record.freeShipping,
    FREE_SHIPPING_KEYS,
    "shipping.freeShipping",
    errors
  );

  return {
    alternativeServices: validateAlternativeServices(
      record.alternativeServices,
      errors
    ),
    selfPickup: bool(record.selfPickup, false),
    courierEnabled: bool(record.courierEnabled, false),
    pinpointEnabled: bool(record.pinpointEnabled, false),
    freeShipping: {
      active: bool(freeShippingRecord.active, false),
      minOrder: money(
        freeShippingRecord.minOrder,
        "shipping.freeShipping.minOrder",
        errors
      ),
      maxDiscount: money(
        freeShippingRecord.maxDiscount,
        "shipping.freeShipping.maxDiscount",
        errors
      )
    },
    originCityName: text(record.originCityName, 200),
    originSubdistrictName: text(record.originSubdistrictName, 200),
    courier: validateCourier(record.courier, errors)
  };
}

export type StoreSettingsBankAccount = {
  bankName: string;
  accountNumber: string;
  accountHolder: string;
};

function validateBankAccounts(
  value: unknown,
  errors: ValidationError[]
): StoreSettingsBankAccount[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({
      field: "payment.manualBank.accounts",
      message: "payment.manualBank.accounts must be an array."
    });
    return [];
  }
  if (value.length > 10) {
    errors.push({
      field: "payment.manualBank.accounts",
      message: "payment.manualBank.accounts must contain at most 10 entries."
    });
  }
  return value.slice(0, 10).map((entry, index) => {
    const record = isRecord(entry) ? entry : {};
    return {
      bankName: requiredText(
        record.bankName,
        `payment.manualBank.accounts[${index}].bankName`,
        100,
        errors
      ),
      accountNumber: requiredText(
        record.accountNumber,
        `payment.manualBank.accounts[${index}].accountNumber`,
        50,
        errors
      ),
      accountHolder: requiredText(
        record.accountHolder,
        `payment.manualBank.accounts[${index}].accountHolder`,
        200,
        errors
      )
    };
  });
}

export type StoreSettingsPayment = {
  manualBank: { active: boolean; accounts: StoreSettingsBankAccount[] };
  manualQris: { active: boolean; mediaObjectId: string | null };
  downPayment: { active: boolean; percent: number };
  tax: { active: boolean; percent: number };
  insurance: { active: boolean; ratePercent: string; minFee: string };
  /**
   * Issue #110 (contract #106 D3) — the payment-gateway integration's own
   * on/off switch, same shape as `shipping.courier.enabled`
   * (`validateCourier`'s own header): this flag alone does not mean gateway
   * checkout is actually usable — the public read model's
   * `payment.gatewayEnabled` (`application/store-settings-directory.ts`'s
   * `toPublicRecord`) is DERIVED from `gateway.enabled && a
   * PaymentGatewayProvider is configured`, never read back from this stored
   * field alone.
   */
  gateway: { enabled: boolean };
};

const PAYMENT_KEYS = [
  "manualBank",
  "manualQris",
  "downPayment",
  "tax",
  "insurance",
  "gateway"
] as const;
const MANUAL_BANK_KEYS = ["active", "accounts"] as const;
const MANUAL_QRIS_KEYS = ["active", "mediaObjectId"] as const;
const DOWN_PAYMENT_KEYS = ["active", "percent"] as const;
const TAX_KEYS = ["active", "percent"] as const;
const INSURANCE_KEYS = ["active", "ratePercent", "minFee"] as const;
const GATEWAY_KEYS = ["enabled"] as const;

function validatePayment(
  value: unknown,
  errors: ValidationError[]
): StoreSettingsPayment {
  rejectUnknownKeys(value, PAYMENT_KEYS, "payment", errors);
  const record = isRecord(value) ? value : {};
  const manualBank = isRecord(record.manualBank) ? record.manualBank : {};
  const manualQris = isRecord(record.manualQris) ? record.manualQris : {};
  const downPayment = isRecord(record.downPayment) ? record.downPayment : {};
  const tax = isRecord(record.tax) ? record.tax : {};
  const insurance = isRecord(record.insurance) ? record.insurance : {};
  const gateway = isRecord(record.gateway) ? record.gateway : {};
  rejectUnknownKeys(record.gateway, GATEWAY_KEYS, "payment.gateway", errors);
  rejectUnknownKeys(
    record.manualBank,
    MANUAL_BANK_KEYS,
    "payment.manualBank",
    errors
  );
  rejectUnknownKeys(
    record.manualQris,
    MANUAL_QRIS_KEYS,
    "payment.manualQris",
    errors
  );
  rejectUnknownKeys(
    record.downPayment,
    DOWN_PAYMENT_KEYS,
    "payment.downPayment",
    errors
  );
  rejectUnknownKeys(record.tax, TAX_KEYS, "payment.tax", errors);
  rejectUnknownKeys(
    record.insurance,
    INSURANCE_KEYS,
    "payment.insurance",
    errors
  );

  let ratePercent = "0.0";
  if (insurance.ratePercent !== undefined && insurance.ratePercent !== null) {
    if (
      typeof insurance.ratePercent !== "string" ||
      !RATE_PERCENT_PATTERN.test(insurance.ratePercent)
    ) {
      errors.push({
        field: "payment.insurance.ratePercent",
        message:
          'payment.insurance.ratePercent must be a decimal string between "0" and "100".'
      });
    } else {
      ratePercent = insurance.ratePercent;
    }
  }

  return {
    manualBank: {
      active: bool(manualBank.active, false),
      accounts: validateBankAccounts(manualBank.accounts, errors)
    },
    manualQris: {
      active: bool(manualQris.active, false),
      mediaObjectId: optionalUuid(
        manualQris.mediaObjectId,
        "payment.manualQris.mediaObjectId",
        errors
      )
    },
    downPayment: {
      active: bool(downPayment.active, false),
      percent: percent0to100(
        downPayment.percent,
        "payment.downPayment.percent",
        errors
      )
    },
    tax: {
      active: bool(tax.active, false),
      percent: percent0to100(tax.percent, "payment.tax.percent", errors)
    },
    insurance: {
      active: bool(insurance.active, false),
      ratePercent,
      minFee: money(insurance.minFee, "payment.insurance.minFee", errors)
    },
    gateway: {
      enabled: bool(gateway.enabled, false)
    }
  };
}

export type StoreSettingsPromoItem = {
  badge: string | null;
  title: string;
  subtitle: string | null;
  tags: string[];
  buttonText: string | null;
  buttonLink: string | null;
};

function validatePromoItems(
  value: unknown,
  errors: ValidationError[]
): StoreSettingsPromoItem[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({
      field: "promoSection.items",
      message: "promoSection.items must be an array."
    });
    return [];
  }
  if (value.length > 10) {
    errors.push({
      field: "promoSection.items",
      message: "promoSection.items must contain at most 10 entries."
    });
  }
  return value.slice(0, 10).map((entry, index) => {
    const record = isRecord(entry) ? entry : {};
    const tags = Array.isArray(record.tags)
      ? record.tags
          .filter(
            (tag): tag is string =>
              typeof tag === "string" && tag.trim().length > 0
          )
          .slice(0, 20)
          .map((tag) => tag.trim().slice(0, 30))
      : [];
    return {
      badge: text(record.badge, 50),
      title: requiredText(
        record.title,
        `promoSection.items[${index}].title`,
        100,
        errors
      ),
      subtitle: text(record.subtitle, 200),
      tags,
      buttonText: text(record.buttonText, 50),
      buttonLink: text(record.buttonLink, 500)
    };
  });
}

export type StoreSettingsMetaPage = {
  title: string | null;
  description: string | null;
};
export type StoreSettingsMeta = {
  home: StoreSettingsMetaPage;
  contact: StoreSettingsMetaPage;
};

const META_PAGE_KEYS = ["title", "description"] as const;

function validateMetaPage(
  value: unknown,
  path: string,
  errors: ValidationError[]
): StoreSettingsMetaPage {
  rejectUnknownKeys(value, META_PAGE_KEYS, path, errors);
  const record = isRecord(value) ? value : {};
  return {
    title: text(record.title, 200),
    description: text(record.description, 500)
  };
}

/**
 * Order-lifecycle settings (Issue #29). `expiryHours` is how long a
 * newly-created order stays `pending_payment` before
 * `commerce:orders:expire` moves it to `expired` and restocks/un-redeems its
 * voucher — `application/order-directory.ts`'s `createOrderFromCart` reads
 * it to stamp the order's own `expires_at` at creation time (a later change
 * to this setting never retroactively moves an ALREADY-created order's
 * deadline, the same "snapshot at creation" choice `awcms_commerce_orders`
 * makes for its `address` column).
 */
export type StoreSettingsOrders = { expiryHours: number };

export type StoreSettingsData = {
  schemaVersion: number;
  storeName: string;
  tagline: string | null;
  logoMediaObjectId: string | null;
  faviconMediaObjectId: string | null;
  address: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  mapsEmbedUrl: string | null;
  faqs: StoreSettingsFaq[];
  social: StoreSettingsSocial;
  customerLevels: StoreSettingsCustomerLevel[];
  shipping: StoreSettingsShipping;
  payment: StoreSettingsPayment;
  orders: StoreSettingsOrders;
  promoSection: StoreSettingsPromoSection;
  meta: StoreSettingsMeta;
};

export type StoreSettingsPromoSection = {
  active: boolean;
  items: StoreSettingsPromoItem[];
};

/**
 * Full-replace validation for `PUT /api/v1/commerce/store-settings` — every
 * field is resolved (defaulted when absent), never a partial patch (see this
 * file's header). `schemaVersion` on the wire is informational only (a
 * caller does not have to send it); this function always stamps the
 * CURRENT {@link STORE_SETTINGS_SCHEMA_VERSION} on the value it returns.
 */
const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "storeName",
  "tagline",
  "logoMediaObjectId",
  "faviconMediaObjectId",
  "address",
  "phone",
  "whatsapp",
  "email",
  "mapsEmbedUrl",
  "faqs",
  "social",
  "customerLevels",
  "shipping",
  "payment",
  "orders",
  "promoSection",
  "meta"
] as const;
const ORDERS_KEYS = ["expiryHours"] as const;
const DEFAULT_ORDER_EXPIRY_HOURS = 24;

function validateOrdersSettings(
  value: unknown,
  errors: ValidationError[]
): StoreSettingsOrders {
  rejectUnknownKeys(value, ORDERS_KEYS, "orders", errors);
  const record = isRecord(value) ? value : {};

  if (record.expiryHours === undefined || record.expiryHours === null) {
    return { expiryHours: DEFAULT_ORDER_EXPIRY_HOURS };
  }
  if (
    typeof record.expiryHours !== "number" ||
    !Number.isInteger(record.expiryHours) ||
    record.expiryHours < 1 ||
    record.expiryHours > 720
  ) {
    errors.push({
      field: "orders.expiryHours",
      message: "orders.expiryHours must be an integer between 1 and 720."
    });
    return { expiryHours: DEFAULT_ORDER_EXPIRY_HOURS };
  }
  return { expiryHours: record.expiryHours };
}
const PROMO_SECTION_KEYS = ["active", "items"] as const;
const META_KEYS = ["home", "contact"] as const;

export function validateStoreSettingsInput(
  body: unknown
): ValidationResult<StoreSettingsData> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  rejectUnknownKeys(body, TOP_LEVEL_KEYS, "", errors);

  const storeName = requiredText(
    record.storeName,
    "storeName",
    200,
    errors,
    "Store"
  );
  const tagline = text(record.tagline, 300);
  const logoMediaObjectId = optionalUuid(
    record.logoMediaObjectId,
    "logoMediaObjectId",
    errors
  );
  const faviconMediaObjectId = optionalUuid(
    record.faviconMediaObjectId,
    "faviconMediaObjectId",
    errors
  );
  const address = text(record.address, 1000);
  const phone = text(record.phone, 50);
  const whatsapp = text(record.whatsapp, 50);
  const email = text(record.email, 320);
  const mapsEmbedUrl = text(record.mapsEmbedUrl, 2000);
  const faqs = validateFaqs(record.faqs, errors);
  const social = validateSocial(record.social, errors);
  const customerLevels = validateCustomerLevels(record.customerLevels, errors);
  const shipping = validateShipping(record.shipping, errors);
  const payment = validatePayment(record.payment, errors);
  const orders = validateOrdersSettings(record.orders, errors);
  rejectUnknownKeys(
    record.promoSection,
    PROMO_SECTION_KEYS,
    "promoSection",
    errors
  );
  const promoSectionRecord = isRecord(record.promoSection)
    ? record.promoSection
    : {};
  const promoSection: StoreSettingsPromoSection = {
    active: bool(promoSectionRecord.active, false),
    items: validatePromoItems(promoSectionRecord.items, errors)
  };
  rejectUnknownKeys(record.meta, META_KEYS, "meta", errors);
  const meta: StoreSettingsMeta = {
    home: validateMetaPage(
      isRecord(record.meta) ? record.meta.home : undefined,
      "meta.home",
      errors
    ),
    contact: validateMetaPage(
      isRecord(record.meta) ? record.meta.contact : undefined,
      "meta.contact",
      errors
    )
  };

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    value: {
      schemaVersion: STORE_SETTINGS_SCHEMA_VERSION,
      storeName,
      tagline,
      logoMediaObjectId,
      faviconMediaObjectId,
      address,
      phone,
      whatsapp,
      email,
      mapsEmbedUrl,
      faqs,
      social,
      customerLevels,
      shipping,
      payment,
      orders,
      promoSection,
      meta
    }
  };
}
