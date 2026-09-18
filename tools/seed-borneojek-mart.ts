/**
 * tools/seed-borneojek-mart.ts — `bun run db:seed:cms` (issue #25).
 *
 * Seeds the `borneojek-mart` tenant — owner account, an 8-category catalog,
 * one representative product per commerce `type`, a handful of blog terms
 * and posts, two legal pages, and the site profile — into an ALREADY
 * MIGRATED `apps/cms` (`bun run db:up && bun run db:migrate:cms` first, see
 * docs/deployment.md's "Local database").
 *
 * ## Why HTTP, not a direct import of apps/cms internals
 *
 * The sibling repo's `media-lenterakalteng/tools/seed-lenterakalteng.ts`
 * imports `apps/cms`'s application services by relative path and calls them
 * directly against a `Bun.SQL` connection — a fine approach there, because
 * that repo's `apps/cms` subtree is not being actively developed by another
 * agent in parallel. Here it is (issue #23, the commerce module itself, is
 * mid-flight on another branch): a relative import into
 * `apps/cms/src/modules/commerce/...` from this file would break the moment
 * that module's internal shape changes, for a script that owns no part of
 * `apps/cms`. So this script talks to a RUNNING `apps/cms` the same way
 * `apps/storefront`'s own build does — as an HTTP client of the public
 * `/api/v1/*` surface — which is also the ONLY interface issue #23/#26/#29
 * commit to keeping stable.
 *
 * It borrows the sibling script's shape everywhere that distinction does not
 * matter: one `ensure*` function per resource, each idempotent by checking
 * for the row before creating it, and the tenant bootstrap / machine
 * credential issuance sequence (`POST /api/v1/setup/initialize`, then
 * `POST /api/v1/access/machine-credentials`) is the same bootstrap
 * `apps/cms`'s own E2E CI job and that sibling script both already use.
 *
 * ## Running it
 *
 *   bun run db:up                                  # postgres:18.4, port 5433
 *   DATABASE_URL=postgres://awcms:<POSTGRES_PASSWORD>@localhost:5433/awcms \
 *     bun run db:migrate:cms
 *   (cd apps/cms && bun run dev)                   # a SECOND terminal — the
 *                                                   # server this script drives
 *   bun run db:seed:cms                            # a THIRD terminal, from the repo root
 *
 * See docs/deployment.md's "Local database" for the exact sequence with real
 * values, and root `.env.example` for every variable this script reads.
 *
 * ## Idempotent by construction
 *
 * Every `ensure*` function lists what already exists (via the resource's own
 * `GET`) before creating anything, so a second run against the same tenant
 * creates nothing new and exits 0 — the acceptance criterion issue #25 states
 * plainly. The one exception justified below is the site profile PUT, which
 * is a full-replace and therefore idempotent as an OPERATION rather than by
 * an existence check.
 *
 * ## The extension point issue #23/#26/#29 fill in
 *
 * `tools/seed-data/*.json` splits every resource into a `current` object
 * (exactly the fields `/api/v1/commerce/products` etc. accept TODAY) and a
 * `future` object (images, variants, `service_form`, `subscription_period`,
 * tiers — the fields issue #23 is adding on another branch right now). Each
 * `apply*` function below reads ONLY `current` and logs which `future` keys
 * exist but were not sent, so landing issue #23 is a change to what
 * `applyProduct` reads, plus filling in `future` → `current`, in this one
 * file — never a restructure of the data or a second script.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SEED_DATA_DIR = path.join(SCRIPT_DIR, "seed-data");

// ---------------------------------------------------------------------------
// Configuration — every variable here is documented in root .env.example,
// with the consequence of leaving it unset (AGENTS.md's "Configuration and
// toolchain").
// ---------------------------------------------------------------------------

const BASE_URL = (
  process.env.AWCMS_BASE_URL?.trim() || "http://localhost:4321"
).replace(/\/+$/, "");
const TENANT_CODE = process.env.SEED_TENANT_CODE?.trim() || "borneojek-mart";
const TENANT_NAME = process.env.SEED_TENANT_NAME?.trim() || "BjekMart";
const OFFICE_CODE = process.env.SEED_OFFICE_CODE?.trim() || "HQ-BJEKMART";
const OFFICE_NAME =
  process.env.SEED_OFFICE_NAME?.trim() || "BjekMart Head Office";
const OWNER_EMAIL =
  process.env.SEED_OWNER_EMAIL?.trim() || "owner@borneojek-mart.local";
const OWNER_DISPLAY_NAME = "BjekMart Owner";

/**
 * Read-only build credential's name and scope — every `read` the storefront's
 * build fetches with (`apps/storefront/src/lib/catalog.ts` for the catalog,
 * `apps/storefront/src/lib/awcms/pemasaran.ts` for the Issue #26 marketing
 * read models). Machine credentials are read-only by construction (awcms
 * ADR-0049), so listing a `read` here is the widest this token can ever be.
 */
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
  // Issue #57 — the news surface (`apps/storefront/src/lib/awcms/{blog,
  // pages,profil,wilayah,wilayah-checkout}.ts`) 403s at build time without
  // these: `permissionKey(moduleKey, activityCode, action)`
  // (`identity-access/domain/access-control.ts`) is `${moduleKey}.
  // ${activityCode}.${action}`, and each key below is copied verbatim from
  // the `authorize`/`READ_GUARD` block of the ROUTE FILE that endpoint's
  // `awcmsGet()` call actually hits — never guessed:
  //   - blog.ts's POSTS_PATH          -> blog/posts/index.ts
  "blog_content.posts.read",
  //   - blog.ts's TERMS_PATH          -> blog/terms/index.ts (activityCode
  //     is "taxonomies", not "terms")
  "blog_content.taxonomies.read",
  //   - blog.ts's INSTITUTIONS_PATH   -> blog/institutions/index.ts
  "blog_content.institutions.read",
  //   - pages.ts's public page(s) fetch -> blog/pages/public.ts and
  //     blog/pages/public/[slug].ts (both guarded identically)
  "blog_content.pages.read",
  //   - blog.ts's AD_PLACEMENTS_ACTIVE_PATH -> news-portal/ad-placements/
  //     active.ts
  "blog_content.ad_placements.read",
  //   - blog.ts's REDIRECTS_PATH      -> seo/redirects/index.ts
  //     (SEO_MODULE_KEY/SEO_REDIRECT_ACTIVITY_CODE, seo-permissions.ts)
  "seo_distribution.redirect.read",
  //   - profil.ts's site-profile fetch -> site-profile/composed.ts
  //     (SITE_PROFILE_MODULE_KEY/SITE_PROFILE_ACTIVITY_CODE,
  //     site-profile-permissions.ts — activityCode is "profile")
  "site_profile.profile.read",
  //   - wilayah.ts's/wilayah-checkout.ts's REGIONS_PATH -> idn-regions/
  //     regions/index.ts (IDN_ADMIN_REGIONS_MODULE_KEY/
  //     IDN_REGION_ACTIVITY_CODE, idn-admin-regions-permissions.ts —
  //     activityCode is "region", singular)
  "idn_admin_regions.region.read"
  // theme.ts's `/theming/{tenantCode}/tokens.css` is PUBLIC (no auth at
  // all — see that file's own docblock), so it needs no key here.
  // Deliberately NOT added: `media_library.media.read` (PR #65 adds this
  // line; rebase after it merges) and the visitor-analytics read key (A3
  // adds it in wave 2) — per the coordinator's own scope split, so this
  // list stays a clean append for whichever of those three PRs merges
  // last.
] as const;
const MACHINE_CREDENTIAL_LIFETIME_DAYS = 365;

function randomPassword(): string {
  return randomBytes(24).toString("base64url");
}

function readSeedJson<T>(fileName: string): T {
  const filePath = path.join(SEED_DATA_DIR, fileName);
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

// ---------------------------------------------------------------------------
// HTTP client — a thin wrapper, not a second `fetch`. Every call goes through
// this so the base URL, JSON parsing, and auth headers are stated once.
// ---------------------------------------------------------------------------

type Session = { tenantId: string; token: string };

type ApiResult<T = unknown> = { status: number; ok: boolean; data: T; raw: unknown };

async function apiCall<T = unknown>(
  method: string,
  urlPath: string,
  options: {
    session?: Session;
    body?: unknown;
    idempotencyKey?: string;
  } = {}
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
  const data = (raw && typeof raw === "object" && "data" in raw
    ? (raw as { data: unknown }).data
    : raw) as T;

  return { status: response.status, ok: response.ok, data, raw };
}

class SeedApiError extends Error {
  constructor(step: string, result: ApiResult) {
    super(
      `${step} failed — HTTP ${result.status}: ${JSON.stringify(result.raw)}`
    );
    this.name = "SeedApiError";
  }
}

function assertOk(step: string, result: ApiResult): void {
  if (!result.ok) throw new SeedApiError(step, result);
}

// ---------------------------------------------------------------------------
// Portable Text — the minimal valid document `blog-content` accepts
// (ADR-0100). One helper, since every page/post body here is plain
// paragraphs — no headings, lists, or embeds needed for seed content.
// ---------------------------------------------------------------------------

function paragraphsToPortableText(paragraphs: string[]): unknown[] {
  return paragraphs.map((text, index) => ({
    _type: "block",
    _key: `seed-block-${index}`,
    style: "normal",
    children: [
      { _type: "span", _key: `seed-span-${index}`, text, marks: [] }
    ],
    markDefs: []
  }));
}

// ---------------------------------------------------------------------------
// Step 1 — tenant + owner bootstrap (`POST /api/v1/setup/initialize`), then
// a session (`POST /api/v1/auth/login`). Idempotent: setup is a singleton
// lock apps/cms itself enforces (`awcms_setup_state`), so a second run finds
// it already locked and logs in against the SAME tenant instead of
// bootstrapping a second one.
// ---------------------------------------------------------------------------

async function ensureTenantAndSession(): Promise<{
  session: Session;
  ownerTenantUserId: string;
}> {
  const status = await apiCall<{ locked: boolean; tenantId?: string }>(
    "GET",
    "/api/v1/setup/status"
  );
  assertOk("GET /api/v1/setup/status", status);

  let tenantId: string;
  let ownerPassword = process.env.SEED_OWNER_PASSWORD?.trim() || "";
  let ownerTenantUserId: string | null = null;

  if (status.data.locked) {
    if (!status.data.tenantId) {
      throw new Error(
        "setup is locked but returned no tenantId — cannot resume seeding."
      );
    }

    tenantId = status.data.tenantId;
    console.log(`skip setup/initialize (already locked) — tenantId=${tenantId}`);

    if (!ownerPassword) {
      throw new Error(
        "Setup was already completed on a previous run, so this run cannot " +
          "re-bootstrap the tenant. Set SEED_OWNER_PASSWORD to the password " +
          "printed the first time this script ran against this database " +
          "(or reset the database with `bun run db:reset` to start clean)."
      );
    }
  } else {
    ownerPassword = ownerPassword || randomPassword();
    const generated = !process.env.SEED_OWNER_PASSWORD?.trim();

    const initialize = await apiCall<{
      tenantId: string;
      ownerTenantUserId: string;
    }>("POST", "/api/v1/setup/initialize", {
      body: {
        tenantCode: TENANT_CODE,
        tenantName: TENANT_NAME,
        officeCode: OFFICE_CODE,
        officeName: OFFICE_NAME,
        ownerDisplayName: OWNER_DISPLAY_NAME,
        ownerLoginIdentifier: OWNER_EMAIL,
        ownerPassword
      }
    });
    assertOk("POST /api/v1/setup/initialize", initialize);

    tenantId = initialize.data.tenantId;
    ownerTenantUserId = initialize.data.ownerTenantUserId;
    console.log(`apply setup/initialize — tenantId=${tenantId} code=${TENANT_CODE}`);

    if (generated) {
      console.log(
        `owner password (SHOWN ONCE, not stored by this script): ${ownerPassword}`
      );
    }
  }

  const login = await apiCall<{ token: string }>("POST", "/api/v1/auth/login", {
    body: { loginIdentifier: OWNER_EMAIL, password: ownerPassword },
    session: { tenantId, token: "" }
  });
  assertOk("POST /api/v1/auth/login", login);

  const session: Session = { tenantId, token: login.data.token };

  // Recovery path: setup was already locked, so we have no
  // ownerTenantUserId from initialize's own response. `GET /api/v1/users`
  // (Issue #166) lists this tenant's users with their role codes — a freshly
  // bootstrapped tenant has exactly one, the owner, so this is unambiguous
  // rather than a guess.
  if (!ownerTenantUserId) {
    const users = await apiCall<{
      items: Array<{ id: string; roles: string[] }>;
    }>("GET", "/api/v1/users", { session });
    assertOk("GET /api/v1/users", users);

    const owner = users.data.items.find((item) => item.roles.includes("owner"));
    if (!owner) {
      throw new Error(
        "Could not resolve the owner's tenant user id from GET /api/v1/users " +
          "— no tenant user holds the 'owner' role."
      );
    }
    ownerTenantUserId = owner.id;
  }

  return { session, ownerTenantUserId };
}

// ---------------------------------------------------------------------------
// Step 1b — storefront origins (`awcms_tenant_domains`), Issue #29.
// ---------------------------------------------------------------------------
//
// The anonymous storefront routes under `/api/v1/commerce/storefront/*`
// resolve their tenant from the request Origin/Host through
// `awcms_tenant_domains`, never from a caller-supplied header
// (`src/lib/tenant/public-host-tenant-resolver.ts`). This is the ONE place
// this script reaches the database directly instead of going through the
// HTTP API — see this file's header for why HTTP is the rule everywhere
// else — and the exception is narrow and disclosed: a freshly created
// domain row starts `pending_verification` and only resolves once genuinely
// verified (`POST /api/v1/tenant/domains/{id}/verify`), which this script
// cannot do for a local/CI seed run because there is no real DNS record to
// prove. `verification_method: "manual"` is a real, documented value in
// `sql/046`'s own CHECK constraint ("operator-attested, no automated
// check"); marking a row `active` this way is exactly what an operator does
// by hand for a domain they already control, and a seed script attesting
// its OWN localhost/demo origins is the same act, done once,
// non-interactively — not a bypass of the verification MODEL, a use of the
// value the model already reserves for this case.
//
// Connects as the Postgres OWNER role (`POSTGRES_USER`/`POSTGRES_PASSWORD` —
// the same connection `bun run db:migrate:cms` uses), a superuser that
// bypasses `FORCE ROW LEVEL SECURITY`, required here since this is the one
// write in this script issued OUTSIDE an authenticated tenant session.
// Idempotent as an OPERATION (`ON CONFLICT ... DO NOTHING` against the
// table's own global `normalized_hostname` uniqueness, `sql/046`) rather
// than by a prior existence check — the same choice `ensureMarketing`'s
// store-settings `PUT` already makes for the same reason.
type StorefrontOrigin = { hostname: string; isPrimary: boolean };

const STOREFRONT_ORIGINS: StorefrontOrigin[] = [
  {
    hostname: process.env.SEED_STOREFRONT_HOSTNAME?.trim() || "mart.borneojek.com",
    isPrimary: true
  },
  // The `Origin` header a `bun run dev`/`astro dev` storefront sends —
  // `parseRequestOrigin`/`normalizePublicHost` compare only the HOSTNAME
  // (port stripped), so this row is "localhost", not "localhost:4321".
  { hostname: "localhost", isPrimary: false }
];

async function ensureTenantDomains(tenantId: string): Promise<void> {
  const host = process.env.SEED_DB_HOST?.trim() || "localhost";
  const port = process.env.POSTGRES_PORT?.trim() || "5433";
  const user = process.env.POSTGRES_USER?.trim() || "awcms";
  const password = process.env.POSTGRES_PASSWORD?.trim() || "awcms_dev_password";
  const database = process.env.POSTGRES_DB?.trim() || "awcms";
  const connectionString = `postgres://${user}:${password}@${host}:${port}/${database}`;

  const sql = new Bun.SQL(connectionString);

  try {
    for (const origin of STOREFRONT_ORIGINS) {
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
// Step 2 — categories (`/api/v1/commerce/categories`)
// ---------------------------------------------------------------------------

type CategorySeed = { name: string; slug: string; icon: string | null };

async function ensureCategories(
  session: Session
): Promise<Map<string, string>> {
  const list = await apiCall<{ items: Array<{ id: string; slug: string }> }>(
    "GET",
    "/api/v1/commerce/categories",
    { session }
  );
  assertOk("GET /api/v1/commerce/categories", list);

  const idBySlug = new Map(list.data.items.map((item) => [item.slug, item.id]));
  const categories = readSeedJson<CategorySeed[]>("categories.json");

  for (const category of categories) {
    if (idBySlug.has(category.slug)) {
      console.log(`skip category "${category.slug}" (already exists)`);
      continue;
    }

    const created = await apiCall<{ id: string }>(
      "POST",
      "/api/v1/commerce/categories",
      {
        session,
        body: { parentId: null, name: category.name, slug: category.slug, icon: category.icon }
      }
    );
    assertOk(`POST /api/v1/commerce/categories (${category.slug})`, created);
    idBySlug.set(category.slug, created.data.id);
    console.log(`apply category "${category.slug}"`);
  }

  return idBySlug;
}

// ---------------------------------------------------------------------------
// Step 3 — products (`/api/v1/commerce/products`) — the CURRENT 12-field
// create shape only. See this file's header for the `future` extension point.
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

/**
 * `parity` (Issue #26) — the Issue #23 product-model fields, applied with one
 * `PATCH` right after the product is created, plus `variants[]` created
 * through `POST .../variants`. Kept separate from `current` so the create
 * body stays the increment-1 shape the endpoint has always accepted, and so
 * a reader can see at a glance which fields are catalog-core and which are
 * parity. `future` holds what still cannot be applied here (images — they
 * need an R2-backed upload session).
 */
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
  categoryIdBySlug: Map<string, string>
): Promise<Map<string, string>> {
  const productIdBySlug = new Map<string, string>();
  const list = await apiCall<{
    items: Array<{ id: string; slug: string; status: string }>;
  }>("GET", "/api/v1/commerce/products", { session });
  assertOk("GET /api/v1/commerce/products", list);

  const existingBySlug = new Map(
    list.data.items.map((item) => [item.slug, item])
  );
  const products = readSeedJson<ProductSeed[]>("products.json");

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
          `product "${product.slug}" names categorySlug "${product.current.categorySlug}", ` +
            "which was not created — check tools/seed-data/categories.json."
        );
      }

      const created = await apiCall<{ id: string }>(
        "POST",
        "/api/v1/commerce/products",
        {
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
        }
      );
      assertOk(`POST /api/v1/commerce/products (${product.slug})`, created);
      productId = created.data.id;
      console.log(`apply product "${product.slug}" (${product.current.type})`);

      if (product.parity) {
        const { variants, ...fields } = product.parity;
        if (Object.keys(fields).length > 0) {
          const patched = await apiCall(
            "PATCH",
            `/api/v1/commerce/products/${productId}`,
            { session, body: fields }
          );
          assertOk(`PATCH /api/v1/commerce/products/${productId} (parity)`, patched);
          console.log(`  apply parity fields: ${Object.keys(fields).join(", ")}`);
        }
        for (const variant of variants ?? []) {
          const createdVariant = await apiCall(
            "POST",
            `/api/v1/commerce/products/${productId}/variants`,
            {
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
            }
          );
          assertOk(
            `POST /api/v1/commerce/products/${productId}/variants (${variant.sku})`,
            createdVariant
          );
          console.log(`  apply variant "${variant.name}" (${variant.sku})`);
        }
      }

      if (product.future && Object.keys(product.future).length > 0) {
        const keys = Object.keys(product.future).filter((key) => key !== "note");
        console.log(
          `  not yet applied (extension point, see tools/seed-data/products.json): ${keys.join(", ")}`
        );
      }
    }

    // A product is authored `draft` (product-status.ts's LEGAL_TRANSITIONS —
    // `createProduct` always starts there) and apps/storefront's own build
    // REFUSES to publish a catalog where every fetched product is non-active
    // (`apps/storefront/src/lib/catalog.ts`'s `getProducts()`: "awcms
    // returned N product(s) and NOT ONE has status 'active'"). Seed data is
    // meant to be browsable, so every product here is switched `active`
    // right after it exists — skipped when it already is, since
    // `draft -> active` is the only transition needed and repeating it on an
    // already-active product would be a no-op `PATCH` anyway, best avoided.
    if (!existing || existing.status !== "active") {
      const activated = await apiCall(
        "PATCH",
        `/api/v1/commerce/products/${productId}`,
        { session, body: { status: "active" } }
      );
      assertOk(`PATCH /api/v1/commerce/products/${productId} (activate)`, activated);
      console.log(`apply product "${product.slug}" status -> active`);
    }

    productIdBySlug.set(product.slug, productId);
  }

  return productIdBySlug;
}

// ---------------------------------------------------------------------------
// Step 3b — the marketing surface (Issue #26): flash sales, vouchers,
// testimonials, the promo popup, and the store-settings block
// (`/api/v1/commerce/{flash-sales,vouchers,testimonials,popups,store-settings}`).
//
// Idempotent the same way every step above is: each resource is LISTED first
// and matched on its natural key (slug, code, author+body, title), and only
// the missing ones are created. Store settings are a full-replace `PUT`, which
// is idempotent by construction. Sliders are NOT here — a slider requires a
// media object, and media objects only exist through the R2-backed upload
// session; they stay under `future` in `tools/seed-data/marketing.json`.
//
// Windows are expressed as HOURS relative to the moment the seed runs
// (`startsInHours`/`endsInHours`) rather than as fixed timestamps, so a seed
// run next month still produces a flash sale that is live today.
// ---------------------------------------------------------------------------

type MarketingSeed = {
  flashSales: Array<{
    slug: string;
    name: string;
    startsInHours: number;
    endsInHours: number;
    status: "draft" | "scheduled";
    products: Array<{
      productSlug: string;
      salePrice: string;
      quota: number;
      sortOrder: number;
    }>;
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
  productIdBySlug: Map<string, string>
): Promise<void> {
  const seed = readSeedJson<MarketingSeed>("marketing.json");

  // Flash sales — matched on slug; products attached only on first creation.
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
    const created = await apiCall<{ id: string }>(
      "POST",
      "/api/v1/commerce/flash-sales",
      {
        session,
        body: {
          name: sale.name,
          slug: sale.slug,
          startsAt: hoursFromNow(sale.startsInHours),
          endsAt: hoursFromNow(sale.endsInHours),
          status: sale.status
        }
      }
    );
    assertOk(`POST /api/v1/commerce/flash-sales (${sale.slug})`, created);
    console.log(`apply flash sale "${sale.slug}"`);

    for (const entry of sale.products) {
      const productId = productIdBySlug.get(entry.productSlug);
      if (!productId) {
        throw new Error(
          `flash sale "${sale.slug}" names productSlug "${entry.productSlug}", which was not seeded.`
        );
      }
      const row = await apiCall(
        "POST",
        `/api/v1/commerce/flash-sales/${created.data.id}/products`,
        {
          session,
          body: {
            productId,
            variantId: null,
            salePrice: entry.salePrice,
            quota: entry.quota,
            sortOrder: entry.sortOrder
          }
        }
      );
      assertOk(`POST /api/v1/commerce/flash-sales/${created.data.id}/products`, row);
      console.log(`  apply flash-sale product "${entry.productSlug}" @ ${entry.salePrice}`);
    }
  }

  // Vouchers — matched on code.
  const vouchers = await apiCall<{ items: Array<{ code: string }> }>(
    "GET",
    "/api/v1/commerce/vouchers",
    { session }
  );
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
      body: {
        ...fields,
        startsAt: hoursFromNow(startsInHours),
        endsAt: hoursFromNow(endsInHours)
      }
    });
    assertOk(`POST /api/v1/commerce/vouchers (${voucher.code})`, created);
    console.log(`apply voucher "${voucher.code}" (${voucher.type})`);
  }

  // Testimonials — matched on author + body (the closest thing to a key).
  const testimonials = await apiCall<{
    items: Array<{ authorName: string; body: string }>;
  }>("GET", "/api/v1/commerce/testimonials", { session });
  assertOk("GET /api/v1/commerce/testimonials", testimonials);
  const testimonialKeys = new Set(
    testimonials.data.items.map((item) => `${item.authorName}\u0000${item.body}`)
  );

  for (const testimonial of seed.testimonials) {
    if (testimonialKeys.has(`${testimonial.authorName}\u0000${testimonial.body}`)) {
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

  // Popup — matched on title; at most one may be active per tenant, so an
  // existing active popup of a different title is left alone rather than
  // fought with.
  const popups = await apiCall<{ items: Array<{ title: string }> }>(
    "GET",
    "/api/v1/commerce/popups",
    { session }
  );
  assertOk("GET /api/v1/commerce/popups", popups);
  if (popups.data.items.some((item) => item.title === seed.popup.title)) {
    console.log(`skip popup "${seed.popup.title}" (already exists)`);
  } else if (popups.data.items.length > 0) {
    console.log(
      `skip popup "${seed.popup.title}" (another popup exists — one active per tenant, see sql/161)`
    );
  } else {
    const created = await apiCall("POST", "/api/v1/commerce/popups", {
      session,
      body: { ...seed.popup, mediaObjectId: null, startsAt: null, endsAt: null }
    });
    assertOk(`POST /api/v1/commerce/popups (${seed.popup.title})`, created);
    console.log(`apply popup "${seed.popup.title}"`);
  }

  // Store settings — a full replace, idempotent by construction. The bank
  // account in the seed data is a PLACEHOLDER by design: real account
  // numbers are entered by the owner on /admin/commerce-settings, never
  // committed.
  const saved = await apiCall("PUT", "/api/v1/commerce/store-settings", {
    session,
    body: seed.storeSettings
  });
  assertOk("PUT /api/v1/commerce/store-settings", saved);
  console.log("apply store settings (full replace)");
}

// ---------------------------------------------------------------------------
// Step 3b — orders (Issue #29): one customer, two orders in different
// states, created through the ANONYMOUS storefront path
// (`POST /api/v1/commerce/storefront/orders`) — never the authenticated
// session, which has no permission for this action by design (see
// `commerce-permissions.ts`'s header: "an order is created only through the
// anonymous storefront path"). The tenant is resolved from an `Origin`
// header naming one of `ensureTenantDomains`'s rows, exactly the way a real
// storefront page's browser fetch would be resolved.
// ---------------------------------------------------------------------------

type OrderSeed = {
  customer: { name: string; phone: string; email: string | null };
  productSlug: string;
  quantity: number;
  notes: string | null;
  finalStatus: "pending_payment" | "paid" | "processing" | "shipped" | "completed" | "cancelled";
};

/** A guest checkout call — `apiCall` cannot be reused as-is: this path takes no bearer/tenant header at all, and instead needs an `Origin` the tenant domain resolver recognises. */
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
  const data = (raw && typeof raw === "object" && "data" in raw
    ? (raw as { data: unknown }).data
    : raw) as T;

  return { status: response.status, ok: response.ok, data, raw };
}

async function ensureOrders(
  session: Session,
  productIdBySlug: Map<string, string>
): Promise<void> {
  const seed = readSeedJson<{ orders: OrderSeed[] }>("orders.json");

  // List existing orders once (admin session) so a second run recognises
  // the ones this script already created, matched by customer name + product
  // — an order has no other natural key this script controls ahead of
  // creation (the real key, `orderCode`, is server-generated).
  const existing = await apiCall<{
    items: Array<{ orderCode: string; customerName: string; status: string }>;
  }>("GET", "/api/v1/commerce/orders", { session });
  assertOk("GET /api/v1/commerce/orders", existing);
  const existingCustomerNames = new Set(
    existing.data.items.map((item) => item.customerName)
  );

  for (const order of seed.orders) {
    if (existingCustomerNames.has(order.customer.name)) {
      console.log(`skip order for "${order.customer.name}" (already exists)`);
      continue;
    }

    const productId = productIdBySlug.get(order.productSlug);
    if (!productId) {
      throw new Error(
        `orders.json names productSlug "${order.productSlug}", which was not seeded.`
      );
    }

    const created = await anonymousStorefrontCall<{ orderCode: string }>(
      "POST",
      "/api/v1/commerce/storefront/orders",
      {
        idempotencyKey: crypto.randomUUID(),
        customer: order.customer,
        address: null,
        lines: [
          {
            productId,
            variantId: null,
            quantity: order.quantity,
            serviceFormValues: null
          }
        ],
        shipping: { method: "self_pickup" },
        payment: { method: "manual_qris" },
        voucherCode: null,
        insurance: false,
        notes: order.notes
      }
    );
    assertOk(
      `POST /api/v1/commerce/storefront/orders (${order.customer.name})`,
      created
    );
    console.log(
      `apply order "${created.data.orderCode}" for "${order.customer.name}" (pending_payment)`
    );

    if (order.finalStatus === "pending_payment") continue;

    // Move it to its target state through the authenticated admin path
    // (`PATCH /api/v1/commerce/orders/{id}/status`) — the anonymous path
    // never accepts a status, by design.
    const adminList = await apiCall<{
      items: Array<{ id: string; orderCode: string }>;
    }>("GET", "/api/v1/commerce/orders", { session });
    assertOk("GET /api/v1/commerce/orders (post-create lookup)", adminList);
    const row = adminList.data.items.find(
      (item) => item.orderCode === created.data.orderCode
    );
    if (!row) {
      throw new Error(
        `Could not find order "${created.data.orderCode}" in the admin list right after creating it.`
      );
    }

    const statusUpdate = await apiCall(
      "PATCH",
      `/api/v1/commerce/orders/${row.id}/status`,
      { session, body: { status: order.finalStatus, note: "Seeded for demo purposes." } }
    );
    assertOk(
      `PATCH /api/v1/commerce/orders/${row.id}/status (${order.finalStatus})`,
      statusUpdate
    );
    console.log(`  apply status "${order.finalStatus}" to "${created.data.orderCode}"`);
  }
}

// ---------------------------------------------------------------------------
// Step 4 — blog terms (`/api/v1/blog/terms`)
// ---------------------------------------------------------------------------

type TermSeed = {
  taxonomyType: "category" | "tag" | "channel" | "topic";
  name: string;
  slug: string;
  description: string | null;
};

async function ensureBlogTerms(session: Session): Promise<Map<string, string>> {
  // Response key is `terms`, not `items` — unlike commerce's list endpoints,
  // `blog/terms/index.ts`'s `GET` returns `ok({ terms })`.
  const list = await apiCall<{ terms: Array<{ id: string; slug: string }> }>(
    "GET",
    "/api/v1/blog/terms",
    { session }
  );
  assertOk("GET /api/v1/blog/terms", list);

  const idBySlug = new Map(list.data.terms.map((item) => [item.slug, item.id]));
  const terms = readSeedJson<TermSeed[]>("terms.json");

  for (const term of terms) {
    if (idBySlug.has(term.slug)) {
      console.log(`skip blog term "${term.slug}" (already exists)`);
      continue;
    }

    const created = await apiCall<{ id: string }>("POST", "/api/v1/blog/terms", {
      session,
      body: {
        taxonomyType: term.taxonomyType,
        parentId: null,
        name: term.name,
        slug: term.slug,
        description: term.description
      }
    });
    assertOk(`POST /api/v1/blog/terms (${term.slug})`, created);
    idBySlug.set(term.slug, created.data.id);
    console.log(`apply blog term "${term.slug}" (${term.taxonomyType})`);
  }

  return idBySlug;
}

// ---------------------------------------------------------------------------
// Step 5 — legal pages (`/api/v1/blog/pages`) — the two footer custom pages
// observed on the live site (`kebijakan-privasi`, `tos`), legacy slugs
// verbatim.
// ---------------------------------------------------------------------------

type PageSeed = {
  slug: string;
  title: string;
  pageType: "standard" | "landing" | "legal" | "system";
  excerpt: string;
  bodyParagraphs: string[];
};

/**
 * Issue #57 finding, fixed for every page/post this script has ever seeded
 * (not narrowly scoped to this issue's own new rows — a half-fix would leave
 * the OLD rows silently stuck forever): `createBlogPage`/`createBlogPost`
 * always write `status: 'draft'`
 * (`blog-page-directory.ts`/`blog-post-directory.ts`), and nothing in this
 * script ever transitioned either past it. `apps/storefront`'s build reads
 * `blog/pages/public.ts`'s own predicate (`published`, reachable visibility,
 * not soft-deleted) and `blog.ts`'s `getAllPosts()`
 * (`?status=published&...`, walked WITHOUT catching a refusal — "the primary
 * content type the whole issue exists to publish"), so every page/post
 * seeded before this fix was, and would have stayed, invisible to the
 * storefront regardless of how much taxonomy/institution data surrounded it.
 * Found while verifying this issue's own "renders /halaman/redaksi" and
 * "renders /berita" acceptance criteria against a REAL seeded local CMS — a
 * stub-backed storefront build never exercises this path, since the stub's
 * fixtures are canned, already-published data, not the output of this
 * script's own create call.
 *
 * `POST .../{id}/publish` (Issue #538/`pages/{id}/publish.ts`) is the only
 * code path that can ever move either row past `draft`; the content quality
 * checklist it runs is a documented no-op unless full-online R2-only mode is
 * active for the tenant (`content-quality-checklist.ts`'s own header), which
 * this seed's tenant never turns on, so it never blocks these calls.
 * `INVALID_STATUS_TRANSITION` (already published, or a re-run of this
 * script) is treated as success, not an error to fail the run over.
 */
async function publishBlogContent(
  session: Session,
  kind: "pages" | "posts",
  id: string,
  label: string
): Promise<void> {
  const noun = kind === "pages" ? "page" : "post";
  const result = await apiCall(
    "POST",
    `/api/v1/blog/${kind}/${id}/publish`,
    { session, idempotencyKey: crypto.randomUUID() }
  );

  if (result.ok) {
    console.log(`  apply ${noun} "${label}" status -> published`);
    return;
  }

  const raw = result.raw as { error?: { code?: string } } | null;
  if (raw?.error?.code === "INVALID_STATUS_TRANSITION") {
    console.log(
      `  skip publish for ${noun} "${label}" (already published, or not publishable from its current status)`
    );
    return;
  }

  throw new SeedApiError(`POST /api/v1/blog/${kind}/${id}/publish (${label})`, result);
}

async function ensureBlogPages(session: Session): Promise<void> {
  // Response key is `pages` — `blog/pages/index.ts`'s `GET` returns `ok({ pages })`.
  const list = await apiCall<{
    pages: Array<{ id: string; slug: string; status: string }>;
  }>("GET", "/api/v1/blog/pages?limit=100", { session });
  assertOk("GET /api/v1/blog/pages", list);

  const existingBySlug = new Map(list.data.pages.map((item) => [item.slug, item]));
  const pages = readSeedJson<PageSeed[]>("pages.json");

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
// Step 6 — a handful of blog posts (`/api/v1/blog/posts`), so issue #28 has
// something real to render. Synthetic content — the live home page's
// `recentBlogs` was empty, so there is nothing to carry over verbatim; see
// tools/seed-data/posts.json's own placeholder note.
// ---------------------------------------------------------------------------

type PostSeed = {
  slug: string;
  title: string;
  excerpt: string;
  termSlugs: string[];
  bodyParagraphs: string[];
};

async function ensureBlogPosts(
  session: Session,
  termIdBySlug: Map<string, string>
): Promise<void> {
  // Response key is `posts` — `blog/posts/index.ts`'s `GET` returns `ok({ posts })`.
  const list = await apiCall<{
    posts: Array<{ id: string; slug: string; status: string }>;
  }>("GET", "/api/v1/blog/posts?limit=100", { session });
  assertOk("GET /api/v1/blog/posts", list);

  const existingBySlug = new Map(list.data.posts.map((item) => [item.slug, item]));
  const posts = readSeedJson<PostSeed[]>("posts.json");

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
      if (!id) {
        throw new Error(
          `post "${post.slug}" names termSlug "${slug}", which was not created ` +
            "— check tools/seed-data/terms.json."
        );
      }
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
// Step 7 — site profile (`PUT /api/v1/site-profile`). A full replace, so
// re-running this with the same seed data is idempotent as an OPERATION
// (converges to the same row) rather than by an existence check — unlike
// every `ensure*` above, there is deliberately no "does it already exist?"
// guard here.
// ---------------------------------------------------------------------------

async function applySiteProfile(session: Session): Promise<void> {
  const seed = readSeedJson<{
    current: Record<string, unknown>;
    future?: Record<string, unknown>;
  }>("site-profile.json");

  const result = await apiCall("PUT", "/api/v1/site-profile", {
    session,
    body: seed.current,
    idempotencyKey: `seed-borneojek-mart-site-profile-${Date.now()}`
  });
  assertOk("PUT /api/v1/site-profile", result);
  console.log("apply site profile (full replace, idempotent operation)");

  if (seed.future && Object.keys(seed.future).length > 0) {
    const keys = Object.keys(seed.future).filter((key) => key !== "note");
    console.log(
      `  not applied — no field on /api/v1/site-profile today (see tools/seed-data/site-profile.json): ${keys.join(", ")}`
    );
  }
}

// ---------------------------------------------------------------------------
// Step 8 — the read-only machine credential apps/storefront's build uses
// (ADR-0049). Deliberately NOT idempotency-keyed by the endpoint itself (a
// duplicate submit mints a second credential — see
// `access/machine-credentials/index.ts`'s own docblock), so THIS script is
// what makes re-running it produce no duplicate: skip if a live, non-revoked
// credential with this name already exists.
// ---------------------------------------------------------------------------

async function ensureMachineCredential(
  session: Session,
  ownerTenantUserId: string
): Promise<void> {
  const list = await apiCall<{
    items: Array<{ name: string; status: "active" | "expired" | "revoked" }>;
  }>("GET", "/api/v1/access/machine-credentials", { session });
  assertOk("GET /api/v1/access/machine-credentials", list);

  const alreadyIssued = list.data.items.some(
    (item) => item.name === MACHINE_CREDENTIAL_NAME && item.status === "active"
  );

  if (alreadyIssued) {
    console.log(
      `skip machine credential "${MACHINE_CREDENTIAL_NAME}" (already exists, live)`
    );
    return;
  }

  const expiresAt = new Date(
    Date.now() + MACHINE_CREDENTIAL_LIFETIME_DAYS * 24 * 60 * 60 * 1000
  );

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

  console.log(
    `apply machine credential "${MACHINE_CREDENTIAL_NAME}" — id=${result.data.credential.id} ` +
      `scope=[${MACHINE_CREDENTIAL_PERMISSION_KEYS.join(", ")}]`
  );
  console.log(
    `AWCMS_API_TOKEN (SHOWN ONCE, not stored by this script): ${result.data.token}`
  );
}

// ---------------------------------------------------------------------------
// Step 9 — seputarborneo reference taxonomy, institutions, sample news
// posts, legal pages, ad placements, and legacy redirects (issue #57).
//
// Appended after every increment-2 step above rather than interleaved with
// them, so a rebase against A1/A3's own additive changes to
// `MACHINE_CREDENTIAL_PERMISSION_KEYS` (the one shared piece of this file)
// stays a clean append on both sides. None of the endpoints below are used
// by `apps/storefront`'s BUILD-TIME machine credential (they are all called
// from THIS script under the owner session), so that permission list is
// untouched here.
//
// Reference: seputarborneo `include/nav_menu.php`'s
// `seputarborneo_taksonomi()`/`seputarborneo_nav_mitra()`/
// `seputarborneo_nav_umum()` (verified 2026-09-18) — the rubrik tree,
// 24-institution directory, and 14-regency/city list this step seeds mirror
// that reference's real structure, translated into this platform's own
// `blog_content` taxonomy/institution/region model (doc `docs/cms.md`'s
// "Taxonomy: commerce categories, plus the news IA's own hierarchy").
// ---------------------------------------------------------------------------

// -- 9a. Rubrik tree (`taxonomy_type=category`) -----------------------------
//
// `awcms_blog_terms_slug_dedup` (apps/cms/sql/035) is UNIQUE on
// `(tenant_id, taxonomy_type, slug)` with NO `parent_id` component — verified
// directly against that migration, not assumed — so this one category tree
// cannot hold both seputarborneo's top-level `WISATA` rubrik and its UMUM
// child also spelled `Wisata` the way two separate MySQL columns
// (`jenis_rubrik`, `kategori`) could. `tools/seed-data/rubrik.json` resolves
// this the way the issue's own text allows: the UMUM child is named
// "Wisata & Travel" / slug `wisata-travel` instead of colliding with the
// top-level `wisata` rubrik.

type RubrikSeed = {
  name: string;
  slug: string;
  parentSlug: string | null;
  description: string | null;
};

async function ensureRubrikTerms(session: Session): Promise<Map<string, string>> {
  const list = await apiCall<{ terms: Array<{ id: string; slug: string }> }>(
    "GET",
    "/api/v1/blog/terms",
    { session }
  );
  assertOk("GET /api/v1/blog/terms", list);

  const idBySlug = new Map(list.data.terms.map((item) => [item.slug, item.id]));
  const rubrikList = readSeedJson<RubrikSeed[]>("rubrik.json");

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
          `rubrik "${rubrik.slug}" names parentSlug "${rubrik.parentSlug}", which ` +
            "was not created yet — check tools/seed-data/rubrik.json's ordering " +
            "(a parent must be listed before its children)."
        );
      }
      parentId = resolved;
    }

    const created = await apiCall<{ id: string }>("POST", "/api/v1/blog/terms", {
      session,
      body: {
        taxonomyType: "category",
        parentId,
        name: rubrik.name,
        slug: rubrik.slug,
        description: rubrik.description
      }
    });
    assertOk(`POST /api/v1/blog/terms (${rubrik.slug})`, created);
    idBySlug.set(rubrik.slug, created.data.id);
    console.log(
      `apply rubrik "${rubrik.slug}"${rubrik.parentSlug ? ` (child of "${rubrik.parentSlug}")` : ""}`
    );
  }

  return idBySlug;
}

// -- 9b. Kalimantan Tengah region codes (`idn_admin_regions`) ---------------
//
// Resolved by NAME against `GET /api/v1/idn-regions/regions` at seed time —
// never hard-coded — per the issue's own instruction: a Kepmendagri update
// could renumber any of these codes, and this script has no business
// guessing one. Requires an ACTIVE `idn_admin_regions` dataset; see
// docs/deployment.md's "Local database" section for the
// `idn-regions:import`/`idn-regions:activate` sequence this depends on.
//
// The 14 names are seputarborneo's own "Daerah" list
// (`seputarborneo_nav_daerah()`), by REGENCY/CITY name (not the legacy city
// names `nav_menu.php` itself maps away from, e.g. "Sampit" ->
// "Kotawaringin Timur").
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

type RegionListResponse = {
  items: Array<{ code: string; name: string }>;
  reason: "no_active_dataset" | "dataset_not_found" | null;
};

/**
 * Strips whitespace before comparing — the active `idn_admin_regions`
 * dataset spells some names WITHOUT the space seputarborneo's own reference
 * taxonomy uses (`Kota Palangkaraya`, not `Kota Palangka Raya`; verified
 * against a real import of `cahyadsn/wilayah`, dataset
 * `wilayah-cae306278e5b-c4c3396d`, Kepmendagri No 300.2.2-2138/2025). Not
 * sent as the API's own `?search=` query param for the same reason: that
 * filter is a literal `LIKE` against `normalized_name`, so a caller-side
 * space the dataset does not have would return zero rows server-side before
 * this function ever gets a chance to normalize anything. Fetching the
 * whole level+parent set instead (at most a few hundred provinces or one
 * province's regencies) and filtering here client-side sidesteps that
 * mismatch entirely.
 */
function namesMatchIgnoringSpaces(a: string, b: string): boolean {
  return a.toUpperCase().replace(/\s+/g, "").includes(b.toUpperCase().replace(/\s+/g, ""));
}

async function resolveRegionCode(
  session: Session,
  level: 1 | 2,
  name: string,
  parentCode: string | null
): Promise<string> {
  const params = new URLSearchParams({
    level: String(level),
    limit: "200"
  });
  if (parentCode) params.set("parentCode", parentCode);

  const result = await apiCall<RegionListResponse>(
    "GET",
    `/api/v1/idn-regions/regions?${params.toString()}`,
    { session }
  );
  assertOk(`GET /api/v1/idn-regions/regions (${name})`, result);

  if (result.data.reason) {
    throw new Error(
      `idn_admin_regions has no resolvable dataset (reason="${result.data.reason}") ` +
        "while resolving region \"" +
        name +
        "\" — run `cd apps/cms && bun run idn-regions:import --commit` then " +
        "`bun run idn-regions:activate -- --dataset <code printed above> --commit` " +
        "before seeding institutions (see docs/deployment.md's \"Local database\" " +
        "section)."
    );
  }

  const matches = result.data.items.filter((item) =>
    namesMatchIgnoringSpaces(item.name, name)
  );

  if (matches.length !== 1) {
    throw new Error(
      `Region lookup for "${name}" (level ${level}) returned ${matches.length} ` +
        "match(es) from GET /api/v1/idn-regions/regions — expected exactly 1. " +
        "Check tools/seed-data/institutions.json's regionName spelling against " +
        "the active idn_admin_regions dataset."
    );
  }

  return matches[0]!.code;
}

type KaltengRegions = {
  provinceCode: string;
  regencyCodeByName: Map<string, string>;
};

async function resolveKaltengRegions(session: Session): Promise<KaltengRegions> {
  const provinceCode = await resolveRegionCode(session, 1, "Kalimantan Tengah", null);
  console.log(`resolve region "Kalimantan Tengah" (province) -> ${provinceCode}`);

  const regencyCodeByName = new Map<string, string>();
  for (const name of KALTENG_DAERAH_NAMES) {
    const code = await resolveRegionCode(session, 2, name, provinceCode);
    regencyCodeByName.set(name, code);
    console.log(`resolve region "${name}" (regency/city) -> ${code}`);
  }

  return { provinceCode, regencyCodeByName };
}

// -- 9c. Institutions (`POST /api/v1/blog/institutions`) --------------------

type InstitutionSeed = {
  name: string;
  slug: string;
  branch: "legislative" | "executive";
  regionLevel: 1 | 2;
  regionName: string;
  seoTitle: string;
  description: string;
};

async function ensureInstitutions(
  session: Session,
  regions: KaltengRegions
): Promise<Map<string, string>> {
  const list = await apiCall<{ institutions: Array<{ id: string; slug: string }> }>(
    "GET",
    "/api/v1/blog/institutions",
    { session }
  );
  assertOk("GET /api/v1/blog/institutions", list);

  const idBySlug = new Map(list.data.institutions.map((item) => [item.slug, item.id]));
  const institutions = readSeedJson<InstitutionSeed[]>("institutions.json");

  for (const institution of institutions) {
    if (idBySlug.has(institution.slug)) {
      console.log(`skip institution "${institution.slug}" (already exists)`);
      continue;
    }

    const regionCode =
      institution.regionLevel === 1
        ? regions.provinceCode
        : regions.regencyCodeByName.get(institution.regionName);

    if (!regionCode) {
      throw new Error(
        `institution "${institution.slug}" names regionName "${institution.regionName}" ` +
          "at level " +
          institution.regionLevel +
          ", which was not resolved — check tools/seed-data/institutions.json " +
          "against KALTENG_DAERAH_NAMES."
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

// -- 9d. Sample news posts (`POST /api/v1/blog/posts`) ----------------------
//
// `regionCode` lives on `awcms_blog_institutions`, not on
// `awcms_blog_posts` — `apps/cms/src/modules/blog-content/domain/blog-post-
// validation.ts` has no `regionCode` field, and `docs/cms.md`/
// `apps/storefront/src/lib/awcms/wilayah.ts` both document this as
// DELIBERATE: "a post itself carries no region field", reached only via an
// institution's own `regionCode`. So a "daerah"/"mitra-borneo" post below is
// filed with `institutionSlugs`, never a region field of its own — exactly
// how `apps/storefront`'s `/daerah/{slug}` archive is documented to resolve
// membership.
//
// Video posts carry a Portable Text `videoNews` node (verified against
// `portable-text.ts`'s closed `PortableTextNodeType` union and
// `apps/storefront/src/lib/portable-text.ts`'s `documentHasPlayableVideo` —
// NOT the separate `contentJson.blocks[].type === "video_news"` mechanism
// `blog-post-validation.ts` also has, which is a different, storefront-
// unused field). `videoId`s are clearly-marked, format-valid-but-fake
// placeholders (`SEED000000{n}`) — no real seputarborneo channel id was
// available to verify, so this follows the issue's own "else placeholder
// ids clearly marked" instruction rather than guessing a real one.

type NewsPostVideoSeed = { videoId: string; title: string; caption: string };

type NewsPostSeed = {
  slug: string;
  title: string;
  excerpt: string;
  rubrikSlug: string;
  institutionSlugs?: string[];
  video?: NewsPostVideoSeed;
  bodyParagraphs: string[];
};

function newsPostBodyPortableText(post: NewsPostSeed): unknown[] {
  const blocks = paragraphsToPortableText(post.bodyParagraphs);

  if (!post.video) {
    return blocks;
  }

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
  institutionIdBySlug: Map<string, string>
): Promise<void> {
  const list = await apiCall<{
    posts: Array<{ id: string; slug: string; status: string }>;
  }>("GET", "/api/v1/blog/posts?limit=100", { session });
  assertOk("GET /api/v1/blog/posts", list);

  const existingBySlug = new Map(list.data.posts.map((item) => [item.slug, item]));
  const posts = readSeedJson<NewsPostSeed[]>("posts-berita.json");
  let anyCreated = false;

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
      throw new Error(
        `news post "${post.slug}" names rubrikSlug "${post.rubrikSlug}", which was ` +
          "not created — check tools/seed-data/rubrik.json."
      );
    }

    const institutionIds = (post.institutionSlugs ?? []).map((slug) => {
      const id = institutionIdBySlug.get(slug);
      if (!id) {
        throw new Error(
          `news post "${post.slug}" names institutionSlugs entry "${slug}", which ` +
            "was not created — check tools/seed-data/institutions.json."
        );
      }
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
    anyCreated = true;
    console.log(
      `apply news post "${post.slug}" (rubrik=${post.rubrikSlug}` +
        `${institutionIds.length > 0 ? `, institutions=${post.institutionSlugs!.join(",")}` : ""}` +
        `${post.video ? ", video" : ""})`
    );
    await publishBlogContent(session, "posts", created.data.id, post.slug);
  }

  if (anyCreated) {
    console.log(
      "  news posts created with featuredMediaId=null — this local/CI deployment " +
        "has no NEWS_MEDIA_R2_* configured to upload a real featured image through " +
        "(same documented gap as tools/seed-data/products.json's own images, see " +
        'docs/deployment.md\'s "What this script still does not seed, and why").'
    );
  }
}

// -- 9e. Ad placements (`POST /api/v1/news-portal/ad-placements`) -----------
//
// Unlike every resource above, `mediaObjectId` here is REQUIRED and
// existence/verified-status-checked against `awcms_news_media_objects`
// (`ad-placement-reference-validation.ts`) — there is no way to create a
// real ad placement without a media object whose `status` is `verified` or
// `attached`, and reaching `verified` needs `finalizeNewsMediaUploadSession`
// to perform a REAL R2 `GET` + checksum, which needs `NEWS_MEDIA_R2_*`
// configured. This repo's local/CI compose stack provisions PostgreSQL only
// — no R2/S3-compatible object storage — so this step ATTEMPTS the real
// upload-session -> PUT -> finalize flow (so it works unattended the moment
// a deployment DOES have R2 configured) and degrades to a single explained
// skip line the moment that flow's first step refuses, rather than either
// fabricating a `status='verified'` row (unlike `ensureTenantDomains`'s
// `verification_method='manual'`, media verification has no reserved
// operator-attested value — `verified` means the bytes were actually
// checked) or failing the whole seed run over infrastructure this script
// does not own.

type AdPlacementSeed = {
  placementKey: string;
  name: string;
  contentClass: "standard" | "advertorial" | "sponsored";
  assetFile: string;
  mimeType: string;
};

type MediaAttemptResult =
  | { ok: true; mediaObjectId: string }
  | { ok: false; reason: string };

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
      reason: `PUT to presigned R2 URL failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  if (!putResponse.ok) {
    return { ok: false, reason: `PUT to presigned R2 URL -> HTTP ${putResponse.status}` };
  }

  const finalized = await apiCall(
    "POST",
    `/api/v1/media/news-images/upload-sessions/${created.data.objectId}/finalize`,
    { session, body: {}, idempotencyKey: crypto.randomUUID() }
  );

  if (!finalized.ok) {
    return {
      ok: false,
      reason: `POST .../finalize -> HTTP ${finalized.status}: ${JSON.stringify(finalized.raw)}`
    };
  }

  return { ok: true, mediaObjectId: created.data.objectId };
}

async function ensureAdPlacements(session: Session): Promise<void> {
  const list = await apiCall<{ placements: Array<{ placementKey: string }> }>(
    "GET",
    "/api/v1/news-portal/ad-placements",
    { session }
  );
  assertOk("GET /api/v1/news-portal/ad-placements", list);

  const existingKeys = new Set(list.data.placements.map((item) => item.placementKey));
  const placements = readSeedJson<AdPlacementSeed[]>("ad-placements.json");
  const pending = placements.filter((placement) => {
    if (existingKeys.has(placement.placementKey)) {
      console.log(`skip ad placement "${placement.placementKey}" (already exists)`);
      return false;
    }
    return true;
  });

  for (const placement of pending) {
    const media = await attemptCreateVerifiedMediaObject(
      session,
      placement.assetFile,
      placement.mimeType,
      `${placement.name} creative (seed, issue #57)`
    );

    if (!media.ok) {
      console.log(
        `skip ${pending.length} pending ad placement(s) — this deployment has no ` +
          `working media R2 storage (${media.reason}). Same documented gap as ` +
          'product images (docs/deployment.md\'s "What this script still does not ' +
          'seed, and why") — configure NEWS_MEDIA_R2_* and re-run to apply these.'
      );
      return;
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
    assertOk(`POST /api/v1/news-portal/ad-placements (${placement.placementKey})`, created);
    console.log(
      `apply ad placement "${placement.placementKey}" (${placement.contentClass})`
    );
  }
}

// -- 9f. Legacy redirects (`POST /api/v1/seo/redirects`) --------------------
//
// `target` is this CMS's OWN `/blog/{tenantCode}/{slug}` shape
// (`blog-content/module.ts`'s `urlTemplate`), never `apps/storefront`'s
// `/berita/{slug}` — `apps/storefront/src/lib/pengalihan-legacy.ts`'s own
// header explains why: the two sides only agree on the post's SLUG, and the
// storefront's build rebuilds the destination in its own URL vocabulary
// from that slug alone.

type RedirectSeed = { sourcePath: string; postSlug: string; reason: string };

async function ensureRedirects(session: Session): Promise<void> {
  const list = await apiCall<{ redirects: Array<{ sourcePath: string }> }>(
    "GET",
    "/api/v1/seo/redirects?limit=100",
    { session }
  );
  assertOk("GET /api/v1/seo/redirects", list);

  const existingSourcePaths = new Set(list.data.redirects.map((item) => item.sourcePath));
  const redirects = readSeedJson<RedirectSeed[]>("redirects.json");

  for (const redirect of redirects) {
    if (existingSourcePaths.has(redirect.sourcePath)) {
      console.log(`skip redirect "${redirect.sourcePath}" (already exists)`);
      continue;
    }

    const target = `/blog/${TENANT_CODE}/${redirect.postSlug}`;
    const created = await apiCall("POST", "/api/v1/seo/redirects", {
      session,
      body: {
        sourcePath: redirect.sourcePath,
        target,
        origin: "legacy_blog",
        reason: redirect.reason
      },
      idempotencyKey: crypto.randomUUID()
    });
    assertOk(`POST /api/v1/seo/redirects (${redirect.sourcePath})`, created);
    console.log(`apply redirect "${redirect.sourcePath}" -> "${target}"`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`db:seed:cms — target ${BASE_URL}, tenant "${TENANT_CODE}"`);

  const { session, ownerTenantUserId } = await ensureTenantAndSession();
  await ensureTenantDomains(session.tenantId);
  const categoryIdBySlug = await ensureCategories(session);
  const productIdBySlug = await ensureProducts(session, categoryIdBySlug);
  await ensureMarketing(session, productIdBySlug);
  await ensureOrders(session, productIdBySlug);
  const termIdBySlug = await ensureBlogTerms(session);
  await ensureBlogPages(session);
  await ensureBlogPosts(session, termIdBySlug);
  await applySiteProfile(session);
  await ensureMachineCredential(session, ownerTenantUserId);

  // Issue #57 — seputarborneo reference taxonomy, institutions, sample news
  // posts, legal pages (via ensureBlogPages/pages.json above), ad
  // placements, and legacy redirects. Appended last, deliberately: every
  // step here depends on nothing before it except the session/tenant.
  const rubrikIdBySlug = await ensureRubrikTerms(session);
  const kaltengRegions = await resolveKaltengRegions(session);
  const institutionIdBySlug = await ensureInstitutions(session, kaltengRegions);
  await ensureNewsPosts(session, rubrikIdBySlug, institutionIdBySlug);
  await ensureAdPlacements(session);
  await ensureRedirects(session);

  console.log("");
  console.log(`db:seed:cms complete — tenantId=${session.tenantId}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(
      `db:seed:cms failed — ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  });
}
