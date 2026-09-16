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

/** Read-only build credential's name and scope — matches what apps/storefront's own catalog fetch calls (`apps/storefront/src/lib/catalog.ts`). */
const MACHINE_CREDENTIAL_NAME = "storefront-build (baca-saja)";
const MACHINE_CREDENTIAL_PERMISSION_KEYS = [
  "commerce.products.read",
  "commerce.categories.read"
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

type ProductSeed = { slug: string; current: ProductCurrent; future?: Record<string, unknown> };

async function ensureProducts(
  session: Session,
  categoryIdBySlug: Map<string, string>
): Promise<void> {
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

async function ensureBlogPages(session: Session): Promise<void> {
  // Response key is `pages` — `blog/pages/index.ts`'s `GET` returns `ok({ pages })`.
  const list = await apiCall<{ pages: Array<{ id: string; slug: string }> }>(
    "GET",
    "/api/v1/blog/pages?limit=100",
    { session }
  );
  assertOk("GET /api/v1/blog/pages", list);

  const existingSlugs = new Set(list.data.pages.map((item) => item.slug));
  const pages = readSeedJson<PageSeed[]>("pages.json");

  for (const page of pages) {
    if (existingSlugs.has(page.slug)) {
      console.log(`skip page "${page.slug}" (already exists)`);
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
  const list = await apiCall<{ posts: Array<{ id: string; slug: string }> }>(
    "GET",
    "/api/v1/blog/posts?limit=100",
    { session }
  );
  assertOk("GET /api/v1/blog/posts", list);

  const existingSlugs = new Set(list.data.posts.map((item) => item.slug));
  const posts = readSeedJson<PostSeed[]>("posts.json");

  for (const post of posts) {
    if (existingSlugs.has(post.slug)) {
      console.log(`skip post "${post.slug}" (already exists)`);
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
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`db:seed:cms — target ${BASE_URL}, tenant "${TENANT_CODE}"`);

  const { session, ownerTenantUserId } = await ensureTenantAndSession();
  const categoryIdBySlug = await ensureCategories(session);
  await ensureProducts(session, categoryIdBySlug);
  const termIdBySlug = await ensureBlogTerms(session);
  await ensureBlogPages(session);
  await ensureBlogPosts(session, termIdBySlug);
  await applySiteProfile(session);
  await ensureMachineCredential(session, ownerTenantUserId);

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
