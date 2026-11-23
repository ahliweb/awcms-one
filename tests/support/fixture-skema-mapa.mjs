/**
 * The reviewed map from every storefront stub fixture to the OpenAPI
 * response it stands for, and the dated exceptions the gate carries
 * (issue #553, ADR-0058, audit `docs/audit-paritas-kontrak-cms-storefront.md`
 * section 8.2 Issue A). Data only; the rules live in `fixture-skema.mjs`.
 *
 * A fixture file with no entry here fails the gate, so adding a fixture is
 * adding a line to this file in the same change. Four kinds:
 *
 * - `response`: the file is (the `data` of) one response body and is judged
 *   whole, strictly.
 * - `subset`: a response the storefront consumes as a declared subset. It
 *   omits required fields on purpose; each omitted field is named with the
 *   reason, and a named field that stops being omitted fails the gate. No
 *   other deviation is forgiven.
 * - `lookup`: not a response but a table the stub turns into one. The
 *   entry's `bodies` builds the response(s) the stub would send from it, and
 *   those are judged strictly.
 * - `not-a-response`: stub configuration or a non-JSON asset with no
 *   OpenAPI counterpart; a reason is required and nothing is validated.
 *
 * Exceptions are the way a known contract violation stays green: dated
 * (`reviewBy`), reasoned, pointing at the issue that fixes it, and matched
 * narrowly by keyword and instance path. The gate fails when a rule matches
 * nothing, so the fix has to delete the exception.
 */

const ok = (data) => ({ success: true, data });
const whole = (json) => [{ body: ok(json) }];
const GET = "get";

/** @type {ReadonlyArray<object>} */
export const FIXTURE_MAP = [
  // --- clean responses -------------------------------------------------------
  { file: "products.json", kind: "response", op: { path: "/api/v1/commerce/products", method: GET, status: 200 }, bodies: whole, reason: "Public product list; judged whole. Violates the schema today through F-03 (downloadLink), recorded as an exception." },
  { file: "categories.json", kind: "response", op: { path: "/api/v1/commerce/categories", method: GET, status: 200 }, bodies: whole, reason: "Public category list, matches the schema." },
  { file: "site-profile-composed.json", kind: "response", op: { path: "/api/v1/site-profile/composed", method: GET, status: 200 }, bodies: whole, reason: "Composed site identity (allOf of SiteProfile and the four SEO-owned fields), matches the schema." },
  { file: "blog-pages-public.json", kind: "response", op: { path: "/api/v1/blog/pages/public", method: GET, status: 200 }, bodies: whole, reason: "Public page summaries, matches the schema." },
  { file: "ad-placements-active.json", kind: "response", op: { path: "/api/v1/news-portal/ad-placements/active", method: GET, status: 200 }, bodies: whole, reason: "Active ad slots, matches the schema." },
  { file: "sliders-active.json", kind: "response", op: { path: "/api/v1/commerce/sliders/active", method: GET, status: 200 }, bodies: whole, reason: "Active sliders (a bare array in data), matches the schema." },
  { file: "flash-sales-active.json", kind: "response", op: { path: "/api/v1/commerce/flash-sales/active", method: GET, status: 200 }, bodies: whole, reason: "Active flash sales (a bare array in data), matches the schema." },
  { file: "vouchers-public.json", kind: "response", op: { path: "/api/v1/commerce/vouchers/public", method: GET, status: 200 }, bodies: whole, reason: "Public vouchers (a bare array in data), matches the schema." },
  { file: "testimonials-active.json", kind: "response", op: { path: "/api/v1/commerce/testimonials/active", method: GET, status: 200 }, bodies: whole, reason: "Active testimonials (a bare array in data), matches the schema." },
  { file: "popups-active.json", kind: "response", op: { path: "/api/v1/commerce/popups/active", method: GET, status: 200 }, bodies: whole, reason: "The one active popup (an object or null in data), matches the schema." },
  { file: "media-public-origin.json", kind: "response", op: { path: "/api/v1/media/public-origin", method: GET, status: 200 }, bodies: whole, reason: "Public media origin, matches the schema." },
  { file: "analytics-pages.json", kind: "response", op: { path: "/api/v1/analytics/pages", method: GET, status: 200 }, bodies: whole, reason: "Top pages; the stub overrides only `range` with the requested one. Matches the schema." },
  { file: "store-settings-public.json", kind: "response", op: { path: "/api/v1/commerce/store-settings/public", method: GET, status: 200 }, bodies: whole, reason: "Public store settings; violates the schema today through F-04 (tax without mode, shipping.courier), recorded as an exception." },
  { file: "regions-kalteng.json", kind: "response", op: { path: "/api/v1/idn-regions/regions", method: GET, status: 200 }, bodies: whole, reason: "Region list the stub filters by query before sending; judged whole. Violates the schema today through F-05 (regionType city), recorded as an exception." },

  // --- declared subsets (audit F-02: four fixtures omit required fields) ----
  {
    file: "blog-posts.json",
    kind: "subset",
    op: { path: "/api/v1/blog/posts", method: GET, status: 200 },
    // The response is a oneOf of BlogPostSummary and BlogPost (`view=full`);
    // the fixture is written for the full view, which carries the body.
    pick: { path: ["properties", "data", "properties", "posts", "items"], oneOf: 1 },
    bodies: whole,
    omittedRequired: [
      { property: "tenantId", reason: "The storefront never reads a tenant id; the token already scopes the tenant." },
      { property: "createdAt", reason: "Pages order and show publishedAt/updatedAt; createdAt is read nowhere." },
      { property: "version", reason: "Optimistic-lock counter for editors; a public reader has no use for it." }
    ],
    reason: "Full-view posts as the berita group consumes them (apps/storefront/src/lib/awcms/blog.ts); a trimmed projection, not a full record."
  },
  {
    file: "blog-terms.json",
    kind: "subset",
    op: { path: "/api/v1/blog/terms", method: GET, status: 200 },
    bodies: whole,
    omittedRequired: [{ property: "tenantId", reason: "Never read by the storefront; the token scopes the tenant." }],
    reason: "Taxonomy terms as the berita group consumes them; everything but the tenant id is present."
  },
  {
    file: "blog-institutions.json",
    kind: "subset",
    op: { path: "/api/v1/blog/institutions", method: GET, status: 200 },
    bodies: whole,
    omittedRequired: [{ property: "tenantId", reason: "Never read by the storefront; the token scopes the tenant." }],
    reason: "Institutions as the berita group consumes them; everything but the tenant id is present."
  },
  {
    file: "seo-redirects-legacy.json",
    kind: "subset",
    op: { path: "/api/v1/seo/redirects", method: GET, status: 200 },
    bodies: whole,
    omittedRequired: [
      "id", "normalizedSourcePath", "localeScope", "domainScopeHost", "statusCode", "state",
      "effectiveFrom", "effectiveUntil", "preserveQuery", "reason", "hitCount", "lastHitAt",
      "createdAt", "updatedAt", "deletedAt"
    ].map((property) => ({
      property,
      reason: "The storefront's RawRedirect reads only sourcePath, targetType, target and origin; every other field is admin bookkeeping."
    })),
    reason: "Legacy redirect rules as `RawRedirect` consumes them (a declared four-field subset of SeoRedirect)."
  },

  // --- lookup tables the stub turns into responses ---------------------------
  {
    file: "media-objects.json",
    kind: "lookup",
    op: { path: "/api/v1/media/objects", method: GET, status: 200 },
    bodies: (json) => [
      {
        body: ok({
          items: Object.entries(json).map(([id, entry]) => ({ id, ...entry })),
          unresolved: []
        })
      }
    ],
    reason: "Id-keyed registry; the stub answers `{ id, ...entry }` per requested id, so each entry is judged as a ResolvedMediaReference."
  },
  {
    file: "blog-pages-public-detail.json",
    kind: "lookup",
    op: { path: "/api/v1/blog/pages/public/{slug}", method: GET, status: 200 },
    bodies: (json) => Object.entries(json).map(([slug, detail]) => ({ label: slug, body: ok(detail) })),
    reason: "Slug-keyed table; the stub answers the entry for the requested slug, so each entry is judged as one PublicBlogPageDetail."
  },

  // --- not a response --------------------------------------------------------
  { file: "tokens.css", kind: "not-a-response", reason: "Raw CSS served by GET /theming/{tenantCode}/tokens.css, a route that is not in the OpenAPI bundle (audit F-07, owned upstream)." },
  { file: "booking.json", kind: "not-a-response", reason: "Offsets and fixed identifiers shared by stub-booking.mjs and the booking e2e spec; the stub builds the responses (booking operations are covered by their own client tests)." },
  { file: "customer-accounts.json", kind: "not-a-response", reason: "Seed accounts the stub loads into its in-memory state; the stub shapes the account responses from them, never serves the file." },
  { file: "shipping-rates.json", kind: "not-a-response", reason: "Rate table keyed by region, courier and service from which the stub computes quotes; it is a pricing input, not a response body." }
];

/**
 * Known contract violations by fixtures: F-03 to F-05 of the audit (fixed by
 * issue #554) plus N-01 and N-02, which the gate found on its first run. Delete each entry
 * in the change that fixes it; the gate fails if one matches nothing.
 */
export const EXCEPTIONS = [
  {
    id: "F-03",
    fixture: "products.json",
    issue: "#554",
    reviewBy: "2026-12-15",
    reason:
      "downloadLink is absent from the public product record by design (toAdminRecord adds it for admins only); the fixture and the storefront CommerceProduct type still carry it.",
    matches: [{ keyword: "unevaluatedProperties", instancePath: "^/data/items/\\d+$", property: "downloadLink" }]
  },
  {
    id: "F-04",
    fixture: "store-settings-public.json",
    issue: "#554",
    reviewBy: "2026-12-15",
    reason:
      "payment.tax has no `mode` although the schema is a union discriminated on it (issue #324), and shipping.courier is a property the schema does not list. The tax `oneOf` and the two unevaluated tax members (active, percent) are consequences of the missing mode.",
    matches: [
      { keyword: "unevaluatedProperties", instancePath: "^/data/shipping$", property: "courier" },
      { keyword: "required", instancePath: "^/data/payment/tax$", property: "mode" },
      { keyword: "oneOf", instancePath: "^/data/payment/tax$" },
      { keyword: "unevaluatedProperties", instancePath: "^/data/payment/tax$", property: "active" },
      { keyword: "unevaluatedProperties", instancePath: "^/data/payment/tax$", property: "percent" }
    ]
  },
  {
    id: "F-05",
    fixture: "regions-kalteng.json",
    issue: "#554",
    reviewBy: "2026-12-15",
    reason:
      "One region has regionType `city`; the schema enum is province, regency, district, village.",
    matches: [{ keyword: "enum", instancePath: "^/data/items/\\d+/regionType$" }]
  },
  {
    id: "N-01",
    fixture: "media-objects.json",
    issue: "#554",
    reviewBy: "2026-12-15",
    reason:
      "Found by this gate on its first run, not in the audit: one registry entry has copyrightStatus `own_work`, which is not in the ResolvedMediaReference enum (the nearest member is `owned`). Triage into #554 or its own issue is the owner's call.",
    matches: [{ keyword: "enum", instancePath: "^/data/items/\\d+/copyrightStatus$" }]
  },
  {
    id: "N-02",
    fixture: "blog-posts.json",
    issue: "#554",
    reviewBy: "2026-12-15",
    reason:
      "Found by this gate on its first run, not in the audit: a videoNews node carries title, caption, durationSeconds and sourceLabel, which PortableTextNode (blog_content) does not declare - it lists only provider and videoId for that type. Either the fixture invents fields or the upstream spec under-declares them; which one is the owner's call (a spec fix belongs in ahliweb/awcms, not apps/cms here).",
    matches: ["title", "caption", "durationSeconds", "sourceLabel"].map((property) => ({
      keyword: "unevaluatedProperties",
      instancePath: "^/data/posts/\\d+/bodyPortableText/\\d+$",
      property
    }))
  }
];
