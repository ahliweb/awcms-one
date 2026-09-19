/**
 * tools/seed-cms.ts — `bun run db:seed:cms` (issue #139, contract: ADR-0018 D6).
 *
 * The general seeder `docs/template.md`'s "Sample seeds" section describes:
 * `--profil toko|berita|landing|contoh:borneojek-mart` picks which small,
 * self-contained seed set under `tools/seed-data/**` is applied to an
 * ALREADY MIGRATED `apps/cms` (`bun run db:up && bun run db:migrate:cms`
 * first — see `docs/deployment.md`'s "Local database").
 *
 * ## Why `contoh:borneojek-mart` is still the default
 *
 * `bun run db:seed:cms` with NO `--profil` flag targets
 * `contoh:borneojek-mart` — the full BjekMart reference content this
 * repository's own live deployment has always seeded (moved here, verbatim
 * in shape, from the file this issue renames — see
 * `tools/seed-borneojek-mart.ts`, now a one-release deprecation shim). ADR-
 * 0018 D6's own "keeps running unmodified" premise: the live reference
 * deployment's own `db:seed:cms` invocation does not change.
 *
 * `toko`, `berita`, and `landing` are neutral, fictional, small sample
 * content sets for a repository DERIVED from this template (`template:init`,
 * issue #138) to seed instead — no real people, phone numbers, e-mails,
 * brands, or places tied to BjekMart/seputarborneo. Each is deliberately
 * smaller in SCOPE, not just size, than the reference example: `toko` seeds
 * only what a plain commerce storefront needs (categories, products,
 * marketing, pages, terms — no orders, no machine credential, no tenant-
 * domain registration); `berita` seeds only what a plain news portal needs
 * (rubrics, posts, pages, and the region/institution rows a `/daerah/{slug}`
 * archive needs to have something to show — no commerce surface at all);
 * `landing` seeds only a site profile and a handful of pages.
 *
 * ## Shared machinery, profile-specific pipeline
 *
 * Every `ensure*`/`apply*` function below is IDENTICAL in shape to the one
 * `tools/seed-borneojek-mart.ts` used to own, parameterized by `seedDir`
 * instead of a fixed constant — moving a profile's own JSON files never
 * requires touching the function that reads them. `main()` below is the one
 * place profile choice becomes a DIFFERENT LIST of steps to run, not a
 * conditional inside any one step (the same "profiles are data, not
 * branches" reasoning ADR-0018 D2 already applies to `apps/storefront`).
 *
 * `contoh:borneojek-mart`'s own pipeline (categories → products → marketing
 * → orders → blog terms/pages/posts → site profile → machine credential →
 * rubrik/regions/institutions/news posts → ad placements → redirects) is
 * untouched — every step, in the same order, reading the same shaped JSON,
 * now living under `tools/seed-data/contoh/borneojek-mart/`.
 *
 * ## `--dry-run`
 *
 * Loads and validates the chosen profile's seed JSON (the same structural
 * checks `tests/seed-profil.test.mjs` runs, from the shared
 * `tools/lib/seed-profil.mjs`), prints an inventory summary, and exits —
 * making NO network call at all. This is deliberately a stronger guarantee
 * than "no WRITE call": a dry run never needs a running `apps/cms`, so it
 * is safe to run against a database that already holds real content (see
 * this issue's own instruction never to seed the shared local dev database,
 * which already holds BjekMart data).
 *
 * ## Idempotent by construction
 *
 * Same convention as before: every `ensure*` function lists what already
 * exists before creating anything, so a second run against the same tenant
 * creates nothing new and exits 0.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SEED_DATA_ROOT = path.join(SCRIPT_DIR, "seed-data");

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export type ProfileKey = "toko" | "berita" | "landing" | "contoh:borneojek-mart";

const KNOWN_PROFILES: ProfileKey[] = ["toko", "berita", "landing", "contoh:borneojek-mart"];

function isKnownProfile(value: string): value is ProfileKey {
  return (KNOWN_PROFILES as string[]).includes(value);
}

function seedDirFor(profil: ProfileKey): string {
  if (profil === "contoh:borneojek-mart") {
    return path.join(SEED_DATA_ROOT, "contoh", "borneojek-mart");
  }
  return path.join(SEED_DATA_ROOT, "profil", profil);
}

type ProfileDefaults = {
  tenantCode: string;
  tenantName: string;
  officeCode: string;
  officeName: string;
  ownerEmail: string;
};

/**
 * Every domain below is `example.com`/`example.id` (RFC 2606/6761 reserved
 * for documentation) and every default is a fictional, invented name — see
 * this issue's own "no real people/brands/places" instruction. Only
 * `contoh:borneojek-mart`'s defaults name the real reference tenant, exactly
 * as `tools/seed-borneojek-mart.ts` always did.
 */
const PROFILE_DEFAULTS: Record<ProfileKey, ProfileDefaults> = {
  "contoh:borneojek-mart": {
    tenantCode: "borneojek-mart",
    tenantName: "BjekMart",
    officeCode: "HQ-BJEKMART",
    officeName: "BjekMart Head Office",
    ownerEmail: "owner@borneojek-mart.local"
  },
  toko: {
    tenantCode: "toko-nusantara",
    tenantName: "Toko Nusantara",
    officeCode: "HQ-TOKO-NUSANTARA",
    officeName: "Toko Nusantara Head Office",
    ownerEmail: "owner@toko-nusantara.example.id"
  },
  berita: {
    tenantCode: "kabar-kita",
    tenantName: "Kabar Kita",
    officeCode: "HQ-KABAR-KITA",
    officeName: "Kabar Kita Newsroom",
    ownerEmail: "owner@kabar-kita.example.id"
  },
  landing: {
    tenantCode: "pt-contoh-karya",
    tenantName: "PT Contoh Karya",
    officeCode: "HQ-CONTOH-KARYA",
    officeName: "PT Contoh Karya Head Office",
    ownerEmail: "owner@contoh-karya.example.id"
  }
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type Cli = { profil: ProfileKey; dryRun: boolean; help: boolean };

function parseArgs(argv: string[]): Cli {
  let profil = "contoh:borneojek-mart";
  let dryRun = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--profil" || arg === "-p") {
      const value = argv[++i];
      if (!value) throw new Error("--profil requires a value");
      profil = value;
    } else if (arg.startsWith("--profil=")) {
      profil = arg.slice("--profil=".length);
    } else {
      throw new Error(`Unknown argument: "${arg}" (see --help)`);
    }
  }

  if (!isKnownProfile(profil)) {
    throw new Error(
      `Unknown --profil "${profil}" — expected one of: ${KNOWN_PROFILES.join(", ")}`
    );
  }

  return { profil, dryRun, help };
}

function printHelp(): void {
  console.log(
    [
      "bun run db:seed:cms [-- --profil <toko|berita|landing|contoh:borneojek-mart>] [--dry-run]",
      "",
      "  --profil <name>   Which seed set to apply. Default: contoh:borneojek-mart",
      "                    (the live reference deployment's own content — unchanged",
      "                    default, see this file's own docblock).",
      "  --dry-run         Validate the chosen profile's seed JSON and print an",
      "                    inventory summary — makes NO network call at all.",
      "  --help            Show this message.",
      "",
      "Neutral profiles (toko, berita, landing) seed small, fictional sample",
      "content — see docs/template.md's \"Sample seeds\" section."
    ].join("\n")
  );
}

// ---------------------------------------------------------------------------
// Configuration — every variable here is documented in root .env.example.
// ---------------------------------------------------------------------------

const BASE_URL = (process.env.AWCMS_BASE_URL?.trim() || "http://localhost:4321").replace(/\/+$/, "");

function randomPassword(): string {
  return randomBytes(24).toString("base64url");
}

function readSeedJson<T>(seedDir: string, fileName: string): T {
  const filePath = path.join(seedDir, fileName);
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function hasSeedFile(seedDir: string, fileName: string): boolean {
  return existsSync(path.join(seedDir, fileName));
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

type Session = { tenantId: string; token: string };
type ApiResult<T = unknown> = { status: number; ok: boolean; data: T; raw: unknown };

async function apiCall<T = unknown>(
  method: string,
  urlPath: string,
  options: { session?: Session; body?: unknown; idempotencyKey?: string } = {}
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { "content-type": "application/json" };

  if (options.session) {
    headers.authorization = `Bearer ${options.session.token}`;
    headers["x-awcms-tenant-id"] = options.session.tenantId;
  }
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;

  const response = await fetch(`${BASE_URL}${urlPath}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  const text = await response.text();
  const raw = text.length > 0 ? JSON.parse(text) : null;
  const data = (raw && typeof raw === "object" && "data" in raw ? (raw as { data: unknown }).data : raw) as T;

  return { status: response.status, ok: response.ok, data, raw };
}

class SeedApiError extends Error {
  constructor(step: string, result: ApiResult) {
    super(`${step} failed — HTTP ${result.status}: ${JSON.stringify(result.raw)}`);
    this.name = "SeedApiError";
  }
}

function assertOk(step: string, result: ApiResult): void {
  if (!result.ok) throw new SeedApiError(step, result);
}

function paragraphsToPortableText(paragraphs: string[]): unknown[] {
  return paragraphs.map((text, index) => ({
    _type: "block",
    _key: `seed-block-${index}`,
    style: "normal",
    children: [{ _type: "span", _key: `seed-span-${index}`, text, marks: [] }],
    markDefs: []
  }));
}

// ---------------------------------------------------------------------------
// Tenant + owner bootstrap
// ---------------------------------------------------------------------------

async function ensureTenantAndSession(defaults: ProfileDefaults): Promise<{
  session: Session;
  ownerTenantUserId: string;
}> {
  const tenantCode = process.env.SEED_TENANT_CODE?.trim() || defaults.tenantCode;
  const tenantName = process.env.SEED_TENANT_NAME?.trim() || defaults.tenantName;
  const officeCode = process.env.SEED_OFFICE_CODE?.trim() || defaults.officeCode;
  const officeName = process.env.SEED_OFFICE_NAME?.trim() || defaults.officeName;
  const ownerEmail = process.env.SEED_OWNER_EMAIL?.trim() || defaults.ownerEmail;
  const ownerDisplayName = `${tenantName} Owner`;

  const status = await apiCall<{ locked: boolean; tenantId?: string }>("GET", "/api/v1/setup/status");
  assertOk("GET /api/v1/setup/status", status);

  let tenantId: string;
  let ownerPassword = process.env.SEED_OWNER_PASSWORD?.trim() || "";
  let ownerTenantUserId: string | null = null;

  if (status.data.locked) {
    if (!status.data.tenantId) {
      throw new Error("setup is locked but returned no tenantId — cannot resume seeding.");
    }
    tenantId = status.data.tenantId;
    console.log(`skip setup/initialize (already locked) — tenantId=${tenantId}`);

    if (!ownerPassword) {
      throw new Error(
        "Setup was already completed on a previous run, so this run cannot re-bootstrap the " +
          "tenant. Set SEED_OWNER_PASSWORD to the password printed the first time this script " +
          "ran against this database (or reset the database with `bun run db:reset` to start clean)."
      );
    }
  } else {
    ownerPassword = ownerPassword || randomPassword();
    const generated = !process.env.SEED_OWNER_PASSWORD?.trim();

    const initialize = await apiCall<{ tenantId: string; ownerTenantUserId: string }>(
      "POST",
      "/api/v1/setup/initialize",
      {
        body: {
          tenantCode,
          tenantName,
          officeCode,
          officeName,
          ownerDisplayName,
          ownerLoginIdentifier: ownerEmail,
          ownerPassword
        }
      }
    );
    assertOk("POST /api/v1/setup/initialize", initialize);

    tenantId = initialize.data.tenantId;
    ownerTenantUserId = initialize.data.ownerTenantUserId;
    console.log(`apply setup/initialize — tenantId=${tenantId} code=${tenantCode}`);

    if (generated) {
      console.log(`owner password (SHOWN ONCE, not stored by this script): ${ownerPassword}`);
    }
  }

  const login = await apiCall<{ token: string }>("POST", "/api/v1/auth/login", {
    body: { loginIdentifier: ownerEmail, password: ownerPassword },
    session: { tenantId, token: "" }
  });
  assertOk("POST /api/v1/auth/login", login);

  const session: Session = { tenantId, token: login.data.token };

  if (!ownerTenantUserId) {
    const users = await apiCall<{ items: Array<{ id: string; roles: string[] }> }>("GET", "/api/v1/users", {
      session
    });
    assertOk("GET /api/v1/users", users);

    const owner = users.data.items.find((item) => item.roles.includes("owner"));
    if (!owner) {
      throw new Error(
        "Could not resolve the owner's tenant user id from GET /api/v1/users — no tenant user holds the 'owner' role."
      );
    }
    ownerTenantUserId = owner.id;
  }

  return { session, ownerTenantUserId };
}

// ---------------------------------------------------------------------------
// Storefront origins (`awcms_tenant_domains`) — `contoh:borneojek-mart` only.
// See `tools/seed-borneojek-mart.ts`'s original docblock for why this is the
// one place this script reaches the database directly instead of HTTP.
// ---------------------------------------------------------------------------

type StorefrontOrigin = { hostname: string; isPrimary: boolean };

async function ensureTenantDomains(tenantId: string): Promise<void> {
  const origins: StorefrontOrigin[] = [
    { hostname: process.env.SEED_STOREFRONT_HOSTNAME?.trim() || "mart.borneojek.com", isPrimary: true },
    { hostname: "localhost", isPrimary: false }
  ];

  const host = process.env.SEED_DB_HOST?.trim() || "localhost";
  const port = process.env.POSTGRES_PORT?.trim() || "5433";
  const user = process.env.POSTGRES_USER?.trim() || "awcms";
  const password = process.env.POSTGRES_PASSWORD?.trim() || "awcms_dev_password";
  const database = process.env.POSTGRES_DB?.trim() || "awcms";
  const connectionString = `postgres://${user}:${password}@${host}:${port}/${database}`;

  const sql = new Bun.SQL(connectionString);
  try {
    for (const origin of origins) {
      const rows = (await sql`
        INSERT INTO awcms_tenant_domains (
          tenant_id, hostname, normalized_hostname, domain_type, route_mode,
          status, verification_method, verified_at, is_primary
        )
        VALUES (
          ${tenantId}, ${origin.hostname}, ${origin.hostname}, 'custom_domain', 'canonical',
          'active', 'manual', now(), ${origin.isPrimary}
        )
        ON CONFLICT (normalized_hostname) WHERE deleted_at IS NULL DO NOTHING
        RETURNING id
      `) as { id: string }[];

      console.log(
        rows.length > 0
          ? `apply tenant domain "${origin.hostname}" (active, manually attested)`
          : `skip tenant domain "${origin.hostname}" (already exists)`
      );
    }
  } finally {
    await sql.close({ timeout: 1 });
  }
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

type CategorySeed = { name: string; slug: string; icon: string | null };

async function ensureCategories(session: Session, seedDir: string): Promise<Map<string, string>> {
  const list = await apiCall<{ items: Array<{ id: string; slug: string }> }>(
    "GET",
    "/api/v1/commerce/categories",
    { session }
  );
  assertOk("GET /api/v1/commerce/categories", list);

  const idBySlug = new Map(list.data.items.map((item) => [item.slug, item.id]));
  const categories = readSeedJson<CategorySeed[]>(seedDir, "categories.json");

  for (const category of categories) {
    if (idBySlug.has(category.slug)) {
      console.log(`skip category "${category.slug}" (already exists)`);
      continue;
    }

    const created = await apiCall<{ id: string }>("POST", "/api/v1/commerce/categories", {
      session,
      body: { parentId: null, name: category.name, slug: category.slug, icon: category.icon }
    });
    assertOk(`POST /api/v1/commerce/categories (${category.slug})`, created);
    idBySlug.set(category.slug, created.data.id);
    console.log(`apply category "${category.slug}"`);
  }

  return idBySlug;
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

type ProductCurrent = {
  sku: string;
  name: string;
  categorySlug: string;
  type: "physical" | "digital" | "service" | "subscription";
  description: string | null;
  digitalNote: string | null;
  price: string;
  discountPercent: number;
  stock: number;
  label: string | null;
  labelColor: string | null;
};
type ProductVariantSeed = {
  name: string;
  value: string;
  sku: string;
  price: string;
  stock: number;
  sortOrder: number;
};
type ProductParity = Record<string, unknown> & { variants?: ProductVariantSeed[] };
type ProductSeed = {
  slug: string;
  current: ProductCurrent;
  parity?: ProductParity;
  future?: Record<string, unknown>;
};

async function ensureProducts(
  session: Session,
  categoryIdBySlug: Map<string, string>,
  seedDir: string
): Promise<Map<string, string>> {
  const productIdBySlug = new Map<string, string>();
  const list = await apiCall<{ items: Array<{ id: string; slug: string; status: string }> }>(
    "GET",
    "/api/v1/commerce/products",
    { session }
  );
  assertOk("GET /api/v1/commerce/products", list);

  const existingBySlug = new Map(list.data.items.map((item) => [item.slug, item]));
  const products = readSeedJson<ProductSeed[]>(seedDir, "products.json");

  for (const product of products) {
    const existing = existingBySlug.get(product.slug);
    let productId: string;

    if (existing) {
      console.log(`skip product "${product.slug}" (already exists)`);
      productId = existing.id;
    } else {
      const categoryId = categoryIdBySlug.get(product.current.categorySlug);
      if (!categoryId) {
        throw new Error(
          `product "${product.slug}" names categorySlug "${product.current.categorySlug}", which was not created — check categories.json.`
        );
      }

      const created = await apiCall<{ id: string }>("POST", "/api/v1/commerce/products", {
        session,
        body: {
          categoryId,
          type: product.current.type,
          sku: product.current.sku,
          name: product.current.name,
          slug: product.slug,
          description: product.current.description,
          digitalNote: product.current.digitalNote,
          price: product.current.price,
          discountPercent: product.current.discountPercent,
          stock: product.current.stock,
          label: product.current.label,
          labelColor: product.current.labelColor
        }
      });
      assertOk(`POST /api/v1/commerce/products (${product.slug})`, created);
      productId = created.data.id;
      console.log(`apply product "${product.slug}" (${product.current.type})`);

      if (product.parity) {
        const { variants, ...fields } = product.parity;
        if (Object.keys(fields).length > 0) {
          const patched = await apiCall("PATCH", `/api/v1/commerce/products/${productId}`, {
            session,
            body: fields
          });
          assertOk(`PATCH /api/v1/commerce/products/${productId} (parity)`, patched);
          console.log(`  apply parity fields: ${Object.keys(fields).join(", ")}`);
        }
        for (const variant of variants ?? []) {
          const createdVariant = await apiCall("POST", `/api/v1/commerce/products/${productId}/variants`, {
            session,
            body: {
              name: variant.name,
              value: variant.value,
              colorHex: null,
              imageMediaObjectId: null,
              sku: variant.sku,
              price: variant.price,
              priceLevel2: null,
              priceLevel3: null,
              priceLevel4: null,
              stock: variant.stock,
              weightGrams: 0,
              sortOrder: variant.sortOrder
            }
          });
          assertOk(`POST /api/v1/commerce/products/${productId}/variants (${variant.sku})`, createdVariant);
          console.log(`  apply variant "${variant.name}" (${variant.sku})`);
        }
      }

      if (product.future && Object.keys(product.future).length > 0) {
        const keys = Object.keys(product.future).filter((key) => key !== "note");
        console.log(`  not yet applied (extension point): ${keys.join(", ")}`);
      }
    }

    if (!existing || existing.status !== "active") {
      const activated = await apiCall("PATCH", `/api/v1/commerce/products/${productId}`, {
        session,
        body: { status: "active" }
      });
      assertOk(`PATCH /api/v1/commerce/products/${productId} (activate)`, activated);
      console.log(`apply product "${product.slug}" status -> active`);
    }

    productIdBySlug.set(product.slug, productId);
  }

  return productIdBySlug;
}

// ---------------------------------------------------------------------------
// Marketing surface
// ---------------------------------------------------------------------------

type MarketingSeed = {
  flashSales: Array<{
    slug: string;
    name: string;
    startsInHours: number;
    endsInHours: number;
    status: "draft" | "scheduled";
    products: Array<{ productSlug: string; salePrice: string; quota: number; sortOrder: number }>;
  }>;
  vouchers: Array<{
    code: string;
    name: string;
    description: string | null;
    type: "percentage" | "nominal" | "free_shipping";
    value: string;
    minOrder: string;
    maxDiscount: string | null;
    quota: number;
    isPublic: boolean;
    startsInHours: number;
    endsInHours: number;
  }>;
  testimonials: Array<{
    authorName: string;
    authorRole: string | null;
    body: string;
    rating: number;
    sortOrder: number;
  }>;
  popup: {
    title: string;
    body: string | null;
    linkUrl: string | null;
    buttonText: string | null;
    frequency: "once_per_session" | "once_per_day" | "always";
    isActive: boolean;
  };
  storeSettings: Record<string, unknown>;
};

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

async function ensureMarketing(
  session: Session,
  productIdBySlug: Map<string, string>,
  seedDir: string
): Promise<void> {
  const seed = readSeedJson<MarketingSeed>(seedDir, "marketing.json");

  const sales = await apiCall<{ items: Array<{ id: string; slug: string }> }>(
    "GET",
    "/api/v1/commerce/flash-sales",
    { session }
  );
  assertOk("GET /api/v1/commerce/flash-sales", sales);
  const saleBySlug = new Map(sales.data.items.map((item) => [item.slug, item]));

  for (const sale of seed.flashSales) {
    if (saleBySlug.has(sale.slug)) {
      console.log(`skip flash sale "${sale.slug}" (already exists)`);
      continue;
    }
    const created = await apiCall<{ id: string }>("POST", "/api/v1/commerce/flash-sales", {
      session,
      body: {
        name: sale.name,
        slug: sale.slug,
        startsAt: hoursFromNow(sale.startsInHours),
        endsAt: hoursFromNow(sale.endsInHours),
        status: sale.status
      }
    });
    assertOk(`POST /api/v1/commerce/flash-sales (${sale.slug})`, created);
    console.log(`apply flash sale "${sale.slug}"`);

    for (const entry of sale.products) {
      const productId = productIdBySlug.get(entry.productSlug);
      if (!productId) {
        throw new Error(`flash sale "${sale.slug}" names productSlug "${entry.productSlug}", which was not seeded.`);
      }
      const row = await apiCall("POST", `/api/v1/commerce/flash-sales/${created.data.id}/products`, {
        session,
        body: {
          productId,
          variantId: null,
          salePrice: entry.salePrice,
          quota: entry.quota,
          sortOrder: entry.sortOrder
        }
      });
      assertOk(`POST /api/v1/commerce/flash-sales/${created.data.id}/products`, row);
      console.log(`  apply flash-sale product "${entry.productSlug}" @ ${entry.salePrice}`);
    }
  }

  const vouchers = await apiCall<{ items: Array<{ code: string }> }>("GET", "/api/v1/commerce/vouchers", {
    session
  });
  assertOk("GET /api/v1/commerce/vouchers", vouchers);
  const voucherCodes = new Set(vouchers.data.items.map((item) => item.code));

  for (const voucher of seed.vouchers) {
    if (voucherCodes.has(voucher.code)) {
      console.log(`skip voucher "${voucher.code}" (already exists)`);
      continue;
    }
    const { startsInHours, endsInHours, ...fields } = voucher;
    const created = await apiCall("POST", "/api/v1/commerce/vouchers", {
      session,
      body: { ...fields, startsAt: hoursFromNow(startsInHours), endsAt: hoursFromNow(endsInHours) }
    });
    assertOk(`POST /api/v1/commerce/vouchers (${voucher.code})`, created);
    console.log(`apply voucher "${voucher.code}" (${voucher.type})`);
  }

  const testimonials = await apiCall<{ items: Array<{ authorName: string; body: string }> }>(
    "GET",
    "/api/v1/commerce/testimonials",
    { session }
  );
  assertOk("GET /api/v1/commerce/testimonials", testimonials);
  const testimonialKeys = new Set(
    testimonials.data.items.map((item) => `${item.authorName} ${item.body}`)
  );

  for (const testimonial of seed.testimonials) {
    if (testimonialKeys.has(`${testimonial.authorName} ${testimonial.body}`)) {
      console.log(`skip testimonial by "${testimonial.authorName}" (already exists)`);
      continue;
    }
    const created = await apiCall("POST", "/api/v1/commerce/testimonials", {
      session,
      body: { ...testimonial, avatarMediaObjectId: null, isActive: true }
    });
    assertOk(`POST /api/v1/commerce/testimonials (${testimonial.authorName})`, created);
    console.log(`apply testimonial by "${testimonial.authorName}"`);
  }

  const popups = await apiCall<{ items: Array<{ title: string }> }>("GET", "/api/v1/commerce/popups", {
    session
  });
  assertOk("GET /api/v1/commerce/popups", popups);
  if (popups.data.items.some((item) => item.title === seed.popup.title)) {
    console.log(`skip popup "${seed.popup.title}" (already exists)`);
  } else if (popups.data.items.length > 0) {
    console.log(`skip popup "${seed.popup.title}" (another popup exists — one active per tenant)`);
  } else {
    const created = await apiCall("POST", "/api/v1/commerce/popups", {
      session,
      body: { ...seed.popup, mediaObjectId: null, startsAt: null, endsAt: null }
    });
    assertOk(`POST /api/v1/commerce/popups (${seed.popup.title})`, created);
    console.log(`apply popup "${seed.popup.title}"`);
  }

  const saved = await apiCall("PUT", "/api/v1/commerce/store-settings", { session, body: seed.storeSettings });
  assertOk("PUT /api/v1/commerce/store-settings", saved);
  console.log("apply store settings (full replace)");
}

// ---------------------------------------------------------------------------
// Orders — `contoh:borneojek-mart` only.
// ---------------------------------------------------------------------------

type OrderSeed = {
  customer: { name: string; phone: string; email: string | null };
  productSlug: string;
  quantity: number;
  notes: string | null;
  finalStatus: "pending_payment" | "paid" | "processing" | "shipped" | "completed" | "cancelled";
};

async function anonymousStorefrontCall<T = unknown>(
  method: string,
  urlPath: string,
  body: unknown
): Promise<ApiResult<T>> {
  const origin = process.env.SEED_STOREFRONT_ORIGIN?.trim() || "http://localhost:4321";

  const response = await fetch(`${BASE_URL}${urlPath}`, {
    method,
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  const raw = text.length > 0 ? JSON.parse(text) : null;
  const data = (raw && typeof raw === "object" && "data" in raw ? (raw as { data: unknown }).data : raw) as T;

  return { status: response.status, ok: response.ok, data, raw };
}

async function ensureOrders(
  session: Session,
  productIdBySlug: Map<string, string>,
  seedDir: string
): Promise<void> {
  const seed = readSeedJson<{ orders: OrderSeed[] }>(seedDir, "orders.json");

  const existing = await apiCall<{ items: Array<{ orderCode: string; customerName: string; status: string }> }>(
    "GET",
    "/api/v1/commerce/orders",
    { session }
  );
  assertOk("GET /api/v1/commerce/orders", existing);
  const existingCustomerNames = new Set(existing.data.items.map((item) => item.customerName));

  for (const order of seed.orders) {
    if (existingCustomerNames.has(order.customer.name)) {
      console.log(`skip order for "${order.customer.name}" (already exists)`);
      continue;
    }

    const productId = productIdBySlug.get(order.productSlug);
    if (!productId) {
      throw new Error(`orders.json names productSlug "${order.productSlug}", which was not seeded.`);
    }

    const created = await anonymousStorefrontCall<{ orderCode: string }>(
      "POST",
      "/api/v1/commerce/storefront/orders",
      {
        idempotencyKey: crypto.randomUUID(),
        customer: order.customer,
        address: null,
        lines: [{ productId, variantId: null, quantity: order.quantity, serviceFormValues: null }],
        shipping: { method: "self_pickup" },
        payment: { method: "manual_qris" },
        voucherCode: null,
        insurance: false,
        notes: order.notes
      }
    );
    assertOk(`POST /api/v1/commerce/storefront/orders (${order.customer.name})`, created);
    console.log(`apply order "${created.data.orderCode}" for "${order.customer.name}" (pending_payment)`);

    if (order.finalStatus === "pending_payment") continue;

    const adminList = await apiCall<{ items: Array<{ id: string; orderCode: string }> }>(
      "GET",
      "/api/v1/commerce/orders",
      { session }
    );
    assertOk("GET /api/v1/commerce/orders (post-create lookup)", adminList);
    const row = adminList.data.items.find((item) => item.orderCode === created.data.orderCode);
    if (!row) {
      throw new Error(`Could not find order "${created.data.orderCode}" in the admin list right after creating it.`);
    }

    const statusUpdate = await apiCall("PATCH", `/api/v1/commerce/orders/${row.id}/status`, {
      session,
      body: { status: order.finalStatus, note: "Seeded for demo purposes." }
    });
    assertOk(`PATCH /api/v1/commerce/orders/${row.id}/status (${order.finalStatus})`, statusUpdate);
    console.log(`  apply status "${order.finalStatus}" to "${created.data.orderCode}"`);
  }
}

// ---------------------------------------------------------------------------
// Blog terms (taxonomy)
// ---------------------------------------------------------------------------

type TermSeed = { taxonomyType: "category" | "tag" | "channel" | "topic"; name: string; slug: string; description: string | null };

async function ensureBlogTerms(session: Session, seedDir: string): Promise<Map<string, string>> {
  const list = await apiCall<{ terms: Array<{ id: string; slug: string }> }>("GET", "/api/v1/blog/terms", {
    session
  });
  assertOk("GET /api/v1/blog/terms", list);

  const idBySlug = new Map(list.data.terms.map((item) => [item.slug, item.id]));
  const terms = readSeedJson<TermSeed[]>(seedDir, "terms.json");

  for (const term of terms) {
    if (idBySlug.has(term.slug)) {
      console.log(`skip blog term "${term.slug}" (already exists)`);
      continue;
    }

    const created = await apiCall<{ id: string }>("POST", "/api/v1/blog/terms", {
      session,
      body: { taxonomyType: term.taxonomyType, parentId: null, name: term.name, slug: term.slug, description: term.description }
    });
    assertOk(`POST /api/v1/blog/terms (${term.slug})`, created);
    idBySlug.set(term.slug, created.data.id);
    console.log(`apply blog term "${term.slug}" (${term.taxonomyType})`);
  }

  return idBySlug;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

type PageSeed = {
  slug: string;
  title: string;
  pageType: "standard" | "landing" | "legal" | "system";
  excerpt: string;
  bodyParagraphs: string[];
};

async function publishBlogContent(session: Session, kind: "pages" | "posts", id: string, label: string): Promise<void> {
  const noun = kind === "pages" ? "page" : "post";
  const result = await apiCall("POST", `/api/v1/blog/${kind}/${id}/publish`, {
    session,
    idempotencyKey: crypto.randomUUID()
  });

  if (result.ok) {
    console.log(`  apply ${noun} "${label}" status -> published`);
    return;
  }

  const raw = result.raw as { error?: { code?: string } } | null;
  if (raw?.error?.code === "INVALID_STATUS_TRANSITION") {
    console.log(`  skip publish for ${noun} "${label}" (already published, or not publishable from its current status)`);
    return;
  }

  throw new SeedApiError(`POST /api/v1/blog/${kind}/${id}/publish (${label})`, result);
}

async function ensureBlogPages(session: Session, seedDir: string): Promise<void> {
  const list = await apiCall<{ pages: Array<{ id: string; slug: string; status: string }> }>(
    "GET",
    "/api/v1/blog/pages?limit=100",
    { session }
  );
  assertOk("GET /api/v1/blog/pages", list);

  const existingBySlug = new Map(list.data.pages.map((item) => [item.slug, item]));
  const pages = readSeedJson<PageSeed[]>(seedDir, "pages.json");

  for (const page of pages) {
    const existing = existingBySlug.get(page.slug);

    if (existing) {
      console.log(`skip page "${page.slug}" (already exists)`);
      if (existing.status !== "published") {
        await publishBlogContent(session, "pages", existing.id, page.slug);
      }
      continue;
    }

    const created = await apiCall<{ id: string }>("POST", "/api/v1/blog/pages", {
      session,
      body: {
        title: page.title,
        slug: page.slug,
        excerpt: page.excerpt,
        bodyPortableText: paragraphsToPortableText(page.bodyParagraphs),
        locale: "id",
        visibility: "public",
        pageType: page.pageType,
        parentPageId: null,
        menuOrder: 0
      }
    });
    assertOk(`POST /api/v1/blog/pages (${page.slug})`, created);
    console.log(`apply page "${page.slug}" (${page.pageType})`);
    await publishBlogContent(session, "pages", created.data.id, page.slug);
  }
}

// ---------------------------------------------------------------------------
// Blog posts (plain, non-news) — `contoh:borneojek-mart` only.
// ---------------------------------------------------------------------------

type PostSeed = { slug: string; title: string; excerpt: string; termSlugs: string[]; bodyParagraphs: string[] };

async function ensureBlogPosts(session: Session, termIdBySlug: Map<string, string>, seedDir: string): Promise<void> {
  const list = await apiCall<{ posts: Array<{ id: string; slug: string; status: string }> }>(
    "GET",
    "/api/v1/blog/posts?limit=100",
    { session }
  );
  assertOk("GET /api/v1/blog/posts", list);

  const existingBySlug = new Map(list.data.posts.map((item) => [item.slug, item]));
  const posts = readSeedJson<PostSeed[]>(seedDir, "posts.json");

  for (const post of posts) {
    const existing = existingBySlug.get(post.slug);

    if (existing) {
      console.log(`skip post "${post.slug}" (already exists)`);
      if (existing.status !== "published") {
        await publishBlogContent(session, "posts", existing.id, post.slug);
      }
      continue;
    }

    const termIds = post.termSlugs.map((slug) => {
      const id = termIdBySlug.get(slug);
      if (!id) throw new Error(`post "${post.slug}" names termSlug "${slug}", which was not created — check terms.json.`);
      return id;
    });

    const created = await apiCall<{ id: string }>("POST", "/api/v1/blog/posts", {
      session,
      body: {
        title: post.title,
        slug: post.slug,
        excerpt: post.excerpt,
        bodyPortableText: paragraphsToPortableText(post.bodyParagraphs),
        locale: "id",
        visibility: "public",
        termIds,
        institutionIds: [],
        autoInternalTagLinksDisabled: false
      }
    });
    assertOk(`POST /api/v1/blog/posts (${post.slug})`, created);
    console.log(`apply post "${post.slug}"`);
    await publishBlogContent(session, "posts", created.data.id, post.slug);
  }
}

// ---------------------------------------------------------------------------
// Site profile — full replace.
// ---------------------------------------------------------------------------

async function applySiteProfile(session: Session, seedDir: string): Promise<void> {
  const seed = readSeedJson<{ current: Record<string, unknown>; future?: Record<string, unknown> }>(
    seedDir,
    "site-profile.json"
  );

  const result = await apiCall("PUT", "/api/v1/site-profile", {
    session,
    body: seed.current,
    idempotencyKey: `seed-cms-site-profile-${session.tenantId}-${Date.now()}`
  });
  assertOk("PUT /api/v1/site-profile", result);
  console.log("apply site profile (full replace, idempotent operation)");

  if (seed.future && Object.keys(seed.future).length > 0) {
    const keys = Object.keys(seed.future).filter((key) => key !== "note");
    console.log(`  not applied — no field on /api/v1/site-profile today: ${keys.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// Machine credential — `contoh:borneojek-mart` only (the storefront build
// credential BjekMart's own deployment uses).
// ---------------------------------------------------------------------------

const MACHINE_CREDENTIAL_NAME = "storefront-build (baca-saja)";
const MACHINE_CREDENTIAL_PERMISSION_KEYS = [
  "commerce.products.read",
  "commerce.categories.read",
  "commerce.flash_sales.read",
  "commerce.vouchers.read",
  "commerce.sliders.read",
  "commerce.testimonials.read",
  "commerce.popups.read",
  "commerce.settings.read",
  "blog_content.posts.read",
  "blog_content.taxonomies.read",
  "blog_content.institutions.read",
  "blog_content.pages.read",
  "blog_content.ad_placements.read",
  "seo_distribution.redirect.read",
  "site_profile.profile.read",
  "idn_admin_regions.region.read",
  "media_library.media.read",
  "visitor_analytics.dashboard.read"
] as const;
const MACHINE_CREDENTIAL_LIFETIME_DAYS = 365;

async function issueMachineCredentialFor(session: Session, ownerTenantUserId: string): Promise<{ id: string; token: string }> {
  const expiresAt = new Date(Date.now() + MACHINE_CREDENTIAL_LIFETIME_DAYS * 24 * 60 * 60 * 1000);

  const result = await apiCall<{ token: string; credential: { id: string } }>(
    "POST",
    "/api/v1/access/machine-credentials",
    {
      session,
      body: {
        name: MACHINE_CREDENTIAL_NAME,
        tenantUserId: ownerTenantUserId,
        allowedPermissionKeys: [...MACHINE_CREDENTIAL_PERMISSION_KEYS],
        allowedWriteActions: [],
        allowedIpCidrs: [],
        expiresAt: expiresAt.toISOString()
      }
    }
  );
  assertOk("POST /api/v1/access/machine-credentials", result);

  return { id: result.data.credential.id, token: result.data.token };
}

async function ensureMachineCredential(session: Session, ownerTenantUserId: string): Promise<void> {
  const list = await apiCall<{
    items: Array<{ id: string; name: string; status: "active" | "expired" | "revoked"; allowedPermissionKeys: string[] }>;
  }>("GET", "/api/v1/access/machine-credentials", { session });
  assertOk("GET /api/v1/access/machine-credentials", list);

  const existing = list.data.items.find(
    (item) => item.name === MACHINE_CREDENTIAL_NAME && item.status === "active"
  );
  const wantedKeys = [...MACHINE_CREDENTIAL_PERMISSION_KEYS].sort();

  if (existing) {
    const liveKeys = [...existing.allowedPermissionKeys].sort();
    const scopeMatches =
      liveKeys.length === wantedKeys.length && liveKeys.every((key, index) => key === wantedKeys[index]);

    if (scopeMatches) {
      console.log(`skip machine credential "${MACHINE_CREDENTIAL_NAME}" (already exists, scope matches)`);
      return;
    }

    console.log(
      `rotate machine credential "${MACHINE_CREDENTIAL_NAME}" — revoking id=${existing.id} and issuing a replacement`
    );
    const revoked = await apiCall("POST", `/api/v1/access/machine-credentials/${existing.id}/revoke`, { session });
    assertOk(`POST /api/v1/access/machine-credentials/${existing.id}/revoke`, revoked);

    const issued = await issueMachineCredentialFor(session, ownerTenantUserId);
    console.log(`apply machine credential "${MACHINE_CREDENTIAL_NAME}" — id=${issued.id}`);
    console.log(`AWCMS_API_TOKEN ROTATED (SHOWN ONCE, not stored by this script): ${issued.token}`);
    return;
  }

  const issued = await issueMachineCredentialFor(session, ownerTenantUserId);
  console.log(`apply machine credential "${MACHINE_CREDENTIAL_NAME}" — id=${issued.id}`);
  console.log(`AWCMS_API_TOKEN (SHOWN ONCE, not stored by this script): ${issued.token}`);
}

// ---------------------------------------------------------------------------
// Rubrik terms (news taxonomy) — `contoh:borneojek-mart` and `berita`.
// ---------------------------------------------------------------------------

type RubrikSeed = { name: string; slug: string; parentSlug: string | null; description: string | null };

async function ensureRubrikTerms(session: Session, seedDir: string): Promise<Map<string, string>> {
  const list = await apiCall<{ terms: Array<{ id: string; slug: string }> }>("GET", "/api/v1/blog/terms", {
    session
  });
  assertOk("GET /api/v1/blog/terms", list);

  const idBySlug = new Map(list.data.terms.map((item) => [item.slug, item.id]));
  const rubrikList = readSeedJson<RubrikSeed[]>(seedDir, "rubrik.json");

  for (const rubrik of rubrikList) {
    if (idBySlug.has(rubrik.slug)) {
      console.log(`skip rubrik "${rubrik.slug}" (already exists)`);
      continue;
    }

    let parentId: string | null = null;
    if (rubrik.parentSlug) {
      const resolved = idBySlug.get(rubrik.parentSlug);
      if (!resolved) {
        throw new Error(
          `rubrik "${rubrik.slug}" names parentSlug "${rubrik.parentSlug}", which was not created yet — check rubrik.json's ordering.`
        );
      }
      parentId = resolved;
    }

    const created = await apiCall<{ id: string }>("POST", "/api/v1/blog/terms", {
      session,
      body: { taxonomyType: "category", parentId, name: rubrik.name, slug: rubrik.slug, description: rubrik.description }
    });
    assertOk(`POST /api/v1/blog/terms (${rubrik.slug})`, created);
    idBySlug.set(rubrik.slug, created.data.id);
    console.log(`apply rubrik "${rubrik.slug}"${rubrik.parentSlug ? ` (child of "${rubrik.parentSlug}")` : ""}`);
  }

  return idBySlug;
}

// ---------------------------------------------------------------------------
// Regions + institutions
// ---------------------------------------------------------------------------

type RegionListResponse = { items: Array<{ code: string; name: string }>; reason: "no_active_dataset" | "dataset_not_found" | null };

function namesMatchIgnoringSpaces(a: string, b: string): boolean {
  return a.toUpperCase().replace(/\s+/g, "").includes(b.toUpperCase().replace(/\s+/g, ""));
}

async function fetchRegionItems(session: Session, level: 1 | 2, parentCode: string | null): Promise<RegionListResponse["items"]> {
  const params = new URLSearchParams({ level: String(level), limit: "200" });
  if (parentCode) params.set("parentCode", parentCode);

  const result = await apiCall<RegionListResponse>("GET", `/api/v1/idn-regions/regions?${params.toString()}`, {
    session
  });
  assertOk(`GET /api/v1/idn-regions/regions (level=${level})`, result);

  if (result.data.reason) {
    throw new Error(
      `idn_admin_regions has no resolvable dataset (reason="${result.data.reason}") while listing level ${level} regions — ` +
        "run `cd apps/cms && bun run idn-regions:import --commit` then `bun run idn-regions:activate` first " +
        "(see docs/deployment.md's \"Local database\" section)."
    );
  }

  return result.data.items;
}

function matchRegionCode(items: RegionListResponse["items"], level: 1 | 2, name: string): string {
  const matches = items.filter((item) => namesMatchIgnoringSpaces(item.name, name));
  if (matches.length !== 1) {
    throw new Error(
      `Region lookup for "${name}" (level ${level}) returned ${matches.length} match(es) from GET /api/v1/idn-regions/regions — expected exactly 1.`
    );
  }
  return matches[0]!.code;
}

/** `contoh:borneojek-mart`'s own reference region list (seputarborneo's 14-regency "Daerah" list, issue #57) — verbatim. */
const KALTENG_DAERAH_NAMES: readonly string[] = [
  "Palangka Raya",
  "Kapuas",
  "Pulang Pisau",
  "Katingan",
  "Kotawaringin Timur",
  "Kotawaringin Barat",
  "Seruyan",
  "Lamandau",
  "Sukamara",
  "Gunung Mas",
  "Barito Selatan",
  "Barito Timur",
  "Barito Utara",
  "Murung Raya"
];

type KaltengRegions = { provinceCode: string; regencyCodeByName: Map<string, string> };

async function resolveKaltengRegions(session: Session): Promise<KaltengRegions> {
  const provinceCode = await resolveRegionCode(session, 1, "Kalimantan Tengah", null);
  console.log(`resolve region "Kalimantan Tengah" (province) -> ${provinceCode}`);

  const regencyItems = await fetchRegionItems(session, 2, provinceCode);
  const regencyCodeByName = new Map<string, string>();
  for (const name of KALTENG_DAERAH_NAMES) {
    const code = matchRegionCode(regencyItems, 2, name);
    regencyCodeByName.set(name, code);
    console.log(`resolve region "${name}" (regency/city) -> ${code}`);
  }

  return { provinceCode, regencyCodeByName };
}

async function resolveRegionCode(session: Session, level: 1 | 2, name: string, parentCode: string | null): Promise<string> {
  const items = await fetchRegionItems(session, level, parentCode);
  return matchRegionCode(items, level, name);
}

type InstitutionSeed = {
  name: string;
  slug: string;
  branch: "legislative" | "executive";
  regionLevel: 1 | 2;
  regionName: string;
  seoTitle: string;
  description: string;
};

/**
 * `contoh:borneojek-mart`'s own institutions, resolved against the
 * hardcoded Kalteng region list (verbatim, issue #57 logic).
 */
async function ensureInstitutionsForBorneojekMart(
  session: Session,
  regions: KaltengRegions,
  seedDir: string
): Promise<Map<string, string>> {
  const list = await apiCall<{ institutions: Array<{ id: string; slug: string }> }>(
    "GET",
    "/api/v1/blog/institutions",
    { session }
  );
  assertOk("GET /api/v1/blog/institutions", list);

  const idBySlug = new Map(list.data.institutions.map((item) => [item.slug, item.id]));
  const institutions = readSeedJson<InstitutionSeed[]>(seedDir, "institutions.json");

  for (const institution of institutions) {
    if (idBySlug.has(institution.slug)) {
      console.log(`skip institution "${institution.slug}" (already exists)`);
      continue;
    }

    const regionCode =
      institution.regionLevel === 1 ? regions.provinceCode : regions.regencyCodeByName.get(institution.regionName);

    if (!regionCode) {
      throw new Error(
        `institution "${institution.slug}" names regionName "${institution.regionName}" at level ${institution.regionLevel}, which was not resolved.`
      );
    }

    const created = await apiCall<{ id: string }>("POST", "/api/v1/blog/institutions", {
      session,
      body: {
        branch: institution.branch,
        name: institution.name,
        slug: institution.slug,
        regionCode,
        description: institution.description,
        seoTitle: institution.seoTitle,
        seoDescription: null
      }
    });
    assertOk(`POST /api/v1/blog/institutions (${institution.slug})`, created);
    idBySlug.set(institution.slug, created.data.id);
    console.log(`apply institution "${institution.slug}" (${institution.branch})`);
  }

  return idBySlug;
}

/**
 * Generic institutions/regions resolver — `berita` profile. Unlike
 * `contoh:borneojek-mart`'s hardcoded 14-name Kalteng list, this derives the
 * exact set of provinces/regencies it needs to resolve directly from
 * `institutions.json` itself, so a fourth or fifth profile using this same
 * function never needs a new hardcoded name list. Every `regionLevel: 2`
 * entry names its own `provinceName` (validated by
 * `tools/lib/seed-profil.mjs`'s `validateInstitutions`) so the province
 * parent is unambiguous even across institutions naming different
 * provinces.
 */
type InstitutionSeedGeneric = InstitutionSeed & { provinceName?: string };

async function ensureInstitutionsGeneric(session: Session, seedDir: string): Promise<Map<string, string>> {
  const institutions = readSeedJson<InstitutionSeedGeneric[]>(seedDir, "institutions.json");

  const provinceNames = new Set<string>();
  for (const institution of institutions) {
    if (institution.regionLevel === 1) {
      provinceNames.add(institution.regionName);
    } else {
      if (!institution.provinceName) {
        throw new Error(`institution "${institution.slug}" is regionLevel 2 but names no provinceName.`);
      }
      provinceNames.add(institution.provinceName);
    }
  }

  const provinceCodeByName = new Map<string, string>();
  if (provinceNames.size > 0) {
    const provinceItems = await fetchRegionItems(session, 1, null);
    for (const name of provinceNames) {
      const code = matchRegionCode(provinceItems, 1, name);
      provinceCodeByName.set(name, code);
      console.log(`resolve region "${name}" (province) -> ${code}`);
    }
  }

  const regencyCodeByProvinceAndName = new Map<string, string>();
  const provincesWithRegencies = new Set(
    institutions.filter((item) => item.regionLevel === 2).map((item) => item.provinceName!)
  );
  for (const provinceName of provincesWithRegencies) {
    const provinceCode = provinceCodeByName.get(provinceName)!;
    const regencyItems = await fetchRegionItems(session, 2, provinceCode);
    for (const institution of institutions) {
      if (institution.regionLevel !== 2 || institution.provinceName !== provinceName) continue;
      const code = matchRegionCode(regencyItems, 2, institution.regionName);
      regencyCodeByProvinceAndName.set(`${provinceName}::${institution.regionName}`, code);
      console.log(`resolve region "${institution.regionName}" (regency/city of ${provinceName}) -> ${code}`);
    }
  }

  const list = await apiCall<{ institutions: Array<{ id: string; slug: string }> }>(
    "GET",
    "/api/v1/blog/institutions",
    { session }
  );
  assertOk("GET /api/v1/blog/institutions", list);
  const idBySlug = new Map(list.data.institutions.map((item) => [item.slug, item.id]));

  for (const institution of institutions) {
    if (idBySlug.has(institution.slug)) {
      console.log(`skip institution "${institution.slug}" (already exists)`);
      continue;
    }

    const regionCode =
      institution.regionLevel === 1
        ? provinceCodeByName.get(institution.regionName)
        : regencyCodeByProvinceAndName.get(`${institution.provinceName}::${institution.regionName}`);

    if (!regionCode) {
      throw new Error(`institution "${institution.slug}" names a region that was not resolved.`);
    }

    const created = await apiCall<{ id: string }>("POST", "/api/v1/blog/institutions", {
      session,
      body: {
        branch: institution.branch,
        name: institution.name,
        slug: institution.slug,
        regionCode,
        description: institution.description,
        seoTitle: institution.seoTitle,
        seoDescription: null
      }
    });
    assertOk(`POST /api/v1/blog/institutions (${institution.slug})`, created);
    idBySlug.set(institution.slug, created.data.id);
    console.log(`apply institution "${institution.slug}" (${institution.branch})`);
  }

  return idBySlug;
}

// ---------------------------------------------------------------------------
// News posts (rubrik + institutions) — `contoh:borneojek-mart` and `berita`.
// ---------------------------------------------------------------------------

type NewsPostVideoSeed = { videoId: string; title: string; caption: string };
type NewsPostSeed = {
  slug: string;
  title: string;
  excerpt: string;
  rubrikSlug: string;
  authorName?: string;
  institutionSlugs?: string[];
  video?: NewsPostVideoSeed;
  bodyParagraphs: string[];
};

function newsPostBodyPortableText(post: NewsPostSeed): unknown[] {
  const blocks = paragraphsToPortableText(post.bodyParagraphs);
  if (!post.video) return blocks;

  return [
    ...blocks,
    {
      _type: "videoNews",
      _key: "seed-video-0",
      provider: "youtube",
      videoId: post.video.videoId,
      title: post.video.title,
      caption: post.video.caption
    }
  ];
}

async function ensureNewsPosts(
  session: Session,
  rubrikIdBySlug: Map<string, string>,
  institutionIdBySlug: Map<string, string>,
  seedDir: string
): Promise<void> {
  const list = await apiCall<{ posts: Array<{ id: string; slug: string; status: string }> }>(
    "GET",
    "/api/v1/blog/posts?limit=100",
    { session }
  );
  assertOk("GET /api/v1/blog/posts", list);

  const existingBySlug = new Map(list.data.posts.map((item) => [item.slug, item]));
  const posts = readSeedJson<NewsPostSeed[]>(seedDir, "posts-berita.json");

  for (const post of posts) {
    const existing = existingBySlug.get(post.slug);

    if (existing) {
      console.log(`skip news post "${post.slug}" (already exists)`);
      if (existing.status !== "published") {
        await publishBlogContent(session, "posts", existing.id, post.slug);
      }
      continue;
    }

    const rubrikId = rubrikIdBySlug.get(post.rubrikSlug);
    if (!rubrikId) {
      throw new Error(`news post "${post.slug}" names rubrikSlug "${post.rubrikSlug}", which was not created — check rubrik.json.`);
    }

    const institutionIds = (post.institutionSlugs ?? []).map((slug) => {
      const id = institutionIdBySlug.get(slug);
      if (!id) throw new Error(`news post "${post.slug}" names institutionSlugs entry "${slug}", which was not created.`);
      return id;
    });

    const created = await apiCall<{ id: string }>("POST", "/api/v1/blog/posts", {
      session,
      body: {
        title: post.title,
        slug: post.slug,
        excerpt: post.excerpt,
        bodyPortableText: newsPostBodyPortableText(post),
        locale: "id",
        visibility: "public",
        termIds: [rubrikId],
        institutionIds,
        autoInternalTagLinksDisabled: false
      }
    });
    assertOk(`POST /api/v1/blog/posts (${post.slug})`, created);
    console.log(
      `apply news post "${post.slug}" (rubrik=${post.rubrikSlug}${institutionIds.length > 0 ? `, institutions=${post.institutionSlugs!.join(",")}` : ""}${post.video ? ", video" : ""})`
    );
    await publishBlogContent(session, "posts", created.data.id, post.slug);
  }
}

// ---------------------------------------------------------------------------
// Ad placements — `contoh:borneojek-mart` only (needs a real R2-backed media
// upload session; degrades to a single explained skip when none is
// configured — see `tools/seed-borneojek-mart.ts`'s original docblock).
// ---------------------------------------------------------------------------

type AdPlacementSeed = { placementKey: string; name: string; contentClass: "standard" | "advertorial" | "sponsored"; assetFile: string; mimeType: string };

type MediaAttemptResult =
  | { ok: true; mediaObjectId: string }
  | { ok: false; providerDegraded: boolean; reason: string };

function errorCodeOf(result: ApiResult): string | null {
  const raw = result.raw as { error?: { code?: unknown } } | null;
  return typeof raw?.error?.code === "string" ? raw.error.code : null;
}

function isProviderNotConfigured(result: ApiResult): boolean {
  return result.status === 502 && errorCodeOf(result) === "PROVIDER_ERROR";
}

async function attemptCreateVerifiedMediaObject(
  session: Session,
  assetFile: string,
  mimeType: string,
  altText: string
): Promise<MediaAttemptResult> {
  const bytes = readFileSync(path.join(SCRIPT_DIR, "..", assetFile));

  const created = await apiCall<{ objectId: string; presignedUrl: string }>(
    "POST",
    "/api/v1/media/news-images/upload-sessions",
    { session, body: { mimeType, altText } }
  );

  if (!created.ok) {
    return {
      ok: false,
      providerDegraded: isProviderNotConfigured(created),
      reason: `POST /api/v1/media/news-images/upload-sessions -> HTTP ${created.status}: ${JSON.stringify(created.raw)}`
    };
  }

  let putResponse: Response;
  try {
    putResponse = await fetch(created.data.presignedUrl, {
      method: "PUT",
      headers: { "content-type": mimeType },
      body: bytes
    });
  } catch (error) {
    return {
      ok: false,
      providerDegraded: false,
      reason: `PUT to presigned R2 URL failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  if (!putResponse.ok) {
    return { ok: false, providerDegraded: false, reason: `PUT to presigned R2 URL -> HTTP ${putResponse.status}` };
  }

  const finalized = await apiCall(
    "POST",
    `/api/v1/media/news-images/upload-sessions/${created.data.objectId}/finalize`,
    { session, body: {}, idempotencyKey: crypto.randomUUID() }
  );

  if (!finalized.ok) {
    return {
      ok: false,
      providerDegraded: false,
      reason: `POST .../finalize -> HTTP ${finalized.status}: ${JSON.stringify(finalized.raw)}`
    };
  }

  return { ok: true, mediaObjectId: created.data.objectId };
}

async function ensureAdPlacements(session: Session, seedDir: string): Promise<void> {
  const list = await apiCall<{ placements: Array<{ placementKey: string }> }>(
    "GET",
    "/api/v1/news-portal/ad-placements",
    { session }
  );
  assertOk("GET /api/v1/news-portal/ad-placements", list);

  const existingKeys = new Set(list.data.placements.map((item) => item.placementKey));
  const placements = readSeedJson<AdPlacementSeed[]>(seedDir, "ad-placements.json");
  const pending = placements.filter((placement) => {
    if (existingKeys.has(placement.placementKey)) {
      console.log(`skip ad placement "${placement.placementKey}" (already exists)`);
      return false;
    }
    return true;
  });

  const realFailures: string[] = [];

  for (let index = 0; index < pending.length; index++) {
    const placement = pending[index]!;
    const media = await attemptCreateVerifiedMediaObject(
      session,
      placement.assetFile,
      placement.mimeType,
      `${placement.name} creative (seed, issue #57)`
    );

    if (!media.ok) {
      if (media.providerDegraded) {
        const remaining = pending.length - index;
        console.log(
          `skip ${remaining} pending ad placement(s) — this deployment has no working media R2 storage (${media.reason}).`
        );
        break;
      }
      console.error(`FAILED ad placement "${placement.placementKey}" — ${media.reason}`);
      realFailures.push(`${placement.placementKey}: ${media.reason}`);
      continue;
    }

    const created = await apiCall("POST", "/api/v1/news-portal/ad-placements", {
      session,
      body: {
        placementKey: placement.placementKey,
        name: placement.name,
        mediaObjectId: media.mediaObjectId,
        linkUrl: null,
        rotationMode: "latest",
        priority: 0,
        isActive: true,
        targetType: "global",
        contentClass: placement.contentClass
      }
    });

    if (!created.ok) {
      console.error(
        `FAILED ad placement "${placement.placementKey}" — POST /api/v1/news-portal/ad-placements -> HTTP ${created.status}: ${JSON.stringify(created.raw)}`
      );
      realFailures.push(`${placement.placementKey}: POST /api/v1/news-portal/ad-placements -> HTTP ${created.status}`);
      continue;
    }

    console.log(`apply ad placement "${placement.placementKey}" (${placement.contentClass})`);
  }

  if (realFailures.length > 0) {
    throw new Error(
      `ensureAdPlacements: ${realFailures.length} ad placement(s) failed for reasons other than a missing R2 provider:\n  ${realFailures.join("\n  ")}`
    );
  }
}

// ---------------------------------------------------------------------------
// Legacy redirects — `contoh:borneojek-mart` only.
// ---------------------------------------------------------------------------

type RedirectSeed = { sourcePath: string; postSlug: string; reason: string };

async function ensureRedirects(session: Session, seedDir: string, tenantCode: string): Promise<void> {
  const list = await apiCall<{ redirects: Array<{ sourcePath: string }> }>(
    "GET",
    "/api/v1/seo/redirects?limit=100",
    { session }
  );
  assertOk("GET /api/v1/seo/redirects", list);

  const existingSourcePaths = new Set(list.data.redirects.map((item) => item.sourcePath));
  const redirects = readSeedJson<RedirectSeed[]>(seedDir, "redirects.json");

  for (const redirect of redirects) {
    if (existingSourcePaths.has(redirect.sourcePath)) {
      console.log(`skip redirect "${redirect.sourcePath}" (already exists)`);
      continue;
    }

    const target = `/blog/${tenantCode}/${redirect.postSlug}`;
    const created = await apiCall("POST", "/api/v1/seo/redirects", {
      session,
      body: { sourcePath: redirect.sourcePath, target, origin: "legacy_blog", reason: redirect.reason },
      idempotencyKey: crypto.randomUUID()
    });
    assertOk(`POST /api/v1/seo/redirects (${redirect.sourcePath})`, created);
    console.log(`apply redirect "${redirect.sourcePath}" -> "${target}"`);
  }
}

// ---------------------------------------------------------------------------
// Dry run — no network call at all. See this file's own docblock.
// ---------------------------------------------------------------------------

async function runDryRun(profil: ProfileKey, seedDir: string): Promise<void> {
  const { validateCategories, validateProducts, validateMarketing, validateTerms, validatePages, validateSiteProfile, validateRubrik, validateInstitutions, validateNewsPosts, validateAuthors } =
    await import("./lib/seed-profil.mjs");

  const summary: string[] = [];
  const problems: string[] = [];

  function loadAndValidate<T>(fileName: string, validate: (data: T) => Array<{ path: string[]; message: string }>): T | null {
    if (!hasSeedFile(seedDir, fileName)) return null;
    const data = readSeedJson<T>(seedDir, fileName);
    const issues = validate(data);
    for (const issue of issues) {
      problems.push(`${fileName} [${issue.path.join(".")}]: ${issue.message}`);
    }
    return data;
  }

  const categories = loadAndValidate<unknown[]>("categories.json", validateCategories);
  if (categories) summary.push(`categories: ${categories.length}`);

  const knownCategorySlugs = categories
    ? new Set((categories as Array<{ slug: string }>).map((item) => item.slug))
    : undefined;
  const products = loadAndValidate<unknown[]>("products.json", (data) => validateProducts(data, knownCategorySlugs));
  if (products) summary.push(`products: ${products.length}`);

  const knownProductSlugs = products
    ? new Set((products as Array<{ slug: string }>).map((item) => item.slug))
    : undefined;
  const marketing = loadAndValidate<{
    flashSales: unknown[];
    vouchers: unknown[];
    testimonials: unknown[];
  }>("marketing.json", (data) => validateMarketing(data, knownProductSlugs));
  if (marketing) {
    summary.push(
      `marketing: ${marketing.flashSales.length} flash sale(s), ${marketing.vouchers.length} voucher(s), ${marketing.testimonials.length} testimonial(s)`
    );
  }

  const terms = loadAndValidate<unknown[]>("terms.json", validateTerms);
  if (terms) summary.push(`blog terms: ${terms.length}`);

  const pages = loadAndValidate<unknown[]>("pages.json", validatePages);
  if (pages) summary.push(`pages: ${pages.length}`);

  const siteProfile = loadAndValidate<unknown>("site-profile.json", validateSiteProfile);
  if (siteProfile) summary.push("site profile: 1 (full replace)");

  const rubrik = loadAndValidate<unknown[]>("rubrik.json", validateRubrik);
  if (rubrik) summary.push(`rubrics: ${rubrik.length}`);

  const knownRubrikSlugs = rubrik ? new Set((rubrik as Array<{ slug: string }>).map((item) => item.slug)) : undefined;

  const institutions = loadAndValidate<unknown[]>("institutions.json", validateInstitutions);
  if (institutions) summary.push(`institutions: ${institutions.length}`);
  const knownInstitutionSlugs = institutions
    ? new Set((institutions as Array<{ slug: string }>).map((item) => item.slug))
    : undefined;

  const newsPosts = loadAndValidate<unknown[]>("posts-berita.json", (data) =>
    validateNewsPosts(data, knownRubrikSlugs, knownInstitutionSlugs)
  );
  if (newsPosts) summary.push(`news posts: ${newsPosts.length}`);

  const authors = loadAndValidate<unknown[]>("authors.json", validateAuthors);
  if (authors) summary.push(`authors (informational bylines): ${authors.length}`);

  console.log(`db:seed:cms --dry-run — profile "${profil}" (${seedDir})`);
  console.log("");
  if (summary.length === 0) {
    console.log("No recognised seed files found under this profile's directory.");
  } else {
    console.log("Would apply (idempotent, upsert by slug):");
    for (const line of summary) console.log(`  - ${line}`);
  }
  console.log("");
  console.log("No network calls made (dry-run).");

  if (problems.length > 0) {
    console.error("");
    console.error(`${problems.length} validation issue(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    throw new Error(`--dry-run found ${problems.length} validation issue(s) in "${seedDir}".`);
  }
}

// ---------------------------------------------------------------------------
// Live pipelines
// ---------------------------------------------------------------------------

async function runContohBorneojekMart(seedDir: string, defaults: ProfileDefaults): Promise<void> {
  const { session, ownerTenantUserId } = await ensureTenantAndSession(defaults);
  const tenantCode = process.env.SEED_TENANT_CODE?.trim() || defaults.tenantCode;

  await ensureTenantDomains(session.tenantId);
  const categoryIdBySlug = await ensureCategories(session, seedDir);
  const productIdBySlug = await ensureProducts(session, categoryIdBySlug, seedDir);
  await ensureMarketing(session, productIdBySlug, seedDir);
  await ensureOrders(session, productIdBySlug, seedDir);
  const termIdBySlug = await ensureBlogTerms(session, seedDir);
  await ensureBlogPages(session, seedDir);
  await ensureBlogPosts(session, termIdBySlug, seedDir);
  await applySiteProfile(session, seedDir);
  await ensureMachineCredential(session, ownerTenantUserId);

  const rubrikIdBySlug = await ensureRubrikTerms(session, seedDir);
  const kaltengRegions = await resolveKaltengRegions(session);
  const institutionIdBySlug = await ensureInstitutionsForBorneojekMart(session, kaltengRegions, seedDir);
  await ensureNewsPosts(session, rubrikIdBySlug, institutionIdBySlug, seedDir);
  await ensureAdPlacements(session, seedDir);
  await ensureRedirects(session, seedDir, tenantCode);

  console.log("");
  console.log(`db:seed:cms complete — tenantId=${session.tenantId}`);
}

async function runToko(seedDir: string, defaults: ProfileDefaults): Promise<void> {
  const { session } = await ensureTenantAndSession(defaults);

  const categoryIdBySlug = await ensureCategories(session, seedDir);
  const productIdBySlug = await ensureProducts(session, categoryIdBySlug, seedDir);
  await ensureMarketing(session, productIdBySlug, seedDir);
  await ensureBlogTerms(session, seedDir);
  await ensureBlogPages(session, seedDir);

  console.log("");
  console.log(`db:seed:cms complete — profile "toko", tenantId=${session.tenantId}`);
}

async function runBerita(seedDir: string, defaults: ProfileDefaults): Promise<void> {
  const { session } = await ensureTenantAndSession(defaults);

  const rubrikIdBySlug = await ensureRubrikTerms(session, seedDir);
  const institutionIdBySlug = await ensureInstitutionsGeneric(session, seedDir);
  await ensureNewsPosts(session, rubrikIdBySlug, institutionIdBySlug, seedDir);
  await ensureBlogPages(session, seedDir);

  console.log("");
  console.log(`db:seed:cms complete — profile "berita", tenantId=${session.tenantId}`);
}

async function runLanding(seedDir: string, defaults: ProfileDefaults): Promise<void> {
  const { session } = await ensureTenantAndSession(defaults);

  await applySiteProfile(session, seedDir);
  await ensureBlogPages(session, seedDir);

  console.log("");
  console.log(`db:seed:cms complete — profile "landing", tenantId=${session.tenantId}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cli = parseArgs(argv);

  if (cli.help) {
    printHelp();
    return;
  }

  const seedDir = seedDirFor(cli.profil);
  if (!existsSync(seedDir)) {
    throw new Error(`Seed directory "${seedDir}" does not exist for --profil "${cli.profil}".`);
  }

  if (cli.dryRun) {
    await runDryRun(cli.profil, seedDir);
    return;
  }

  console.log(`db:seed:cms — target ${BASE_URL}, profile "${cli.profil}"`);
  const defaults = PROFILE_DEFAULTS[cli.profil];

  switch (cli.profil) {
    case "contoh:borneojek-mart":
      await runContohBorneojekMart(seedDir, defaults);
      break;
    case "toko":
      await runToko(seedDir, defaults);
      break;
    case "berita":
      await runBerita(seedDir, defaults);
      break;
    case "landing":
      await runLanding(seedDir, defaults);
      break;
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`db:seed:cms failed — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
