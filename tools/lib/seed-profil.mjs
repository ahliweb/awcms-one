/**
 * tools/lib/seed-profil.mjs — issue #139.
 *
 * Shared, side-effect-free helpers for `tools/seed-cms.ts`'s `--dry-run`
 * mode AND `tests/seed-profil.test.mjs` — one validation apparatus for both,
 * per `AGENTS.md`'s "one finding/report apparatus" convention (stated there
 * for the audit gates specifically, applied here to the same class of
 * problem: a schema check duplicated between the script and its test is a
 * schema check that can drift silently).
 *
 * Every function here is a pure check over already-parsed JSON — no file
 * I/O, no network, importable from a plain `bun:test` file with nothing
 * else running.
 */

/** @typedef {{ path: string[]; message: string }} ValidationIssue */

/**
 * @param {ValidationIssue[]} issues
 * @param {string[]} path
 * @param {boolean} condition
 * @param {string} message
 */
function check(issues, path, condition, message) {
  if (!condition) issues.push({ path, message });
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringOrNull(value) {
  return value === null || typeof value === "string";
}

/**
 * `categories.json` — `CategorySeed[]` (`tools/seed-cms.ts`).
 * @param {unknown} data
 * @returns {ValidationIssue[]}
 */
export function validateCategories(data) {
  const issues = [];
  check(issues, [], Array.isArray(data), "categories.json must be an array");
  if (!Array.isArray(data)) return issues;

  const seenSlugs = new Set();
  data.forEach((item, index) => {
    const path = [String(index)];
    check(issues, path, isNonEmptyString(item?.name), "name must be a non-empty string");
    check(issues, path, isNonEmptyString(item?.slug), "slug must be a non-empty string");
    check(issues, path, "icon" in item, "icon must be present (string or null)");
    if (isNonEmptyString(item?.slug)) {
      check(issues, path, !seenSlugs.has(item.slug), `duplicate slug "${item.slug}"`);
      seenSlugs.add(item.slug);
    }
  });
  return issues;
}

const PRODUCT_TYPES = new Set(["physical", "digital", "service", "subscription"]);

/**
 * `products.json` — `ProductSeed[]`.
 * @param {unknown} data
 * @param {Set<string>} [knownCategorySlugs]
 * @returns {ValidationIssue[]}
 */
export function validateProducts(data, knownCategorySlugs) {
  const issues = [];
  check(issues, [], Array.isArray(data), "products.json must be an array");
  if (!Array.isArray(data)) return issues;

  const seenSlugs = new Set();
  data.forEach((item, index) => {
    const path = [String(index), item?.slug ?? "?"];
    check(issues, path, isNonEmptyString(item?.slug), "slug must be a non-empty string");
    if (isNonEmptyString(item?.slug)) {
      check(issues, path, !seenSlugs.has(item.slug), `duplicate slug "${item.slug}"`);
      seenSlugs.add(item.slug);
    }
    const current = item?.current;
    check(issues, path, typeof current === "object" && current !== null, "current must be an object");
    if (typeof current === "object" && current !== null) {
      check(issues, path, isNonEmptyString(current.sku), "current.sku must be a non-empty string");
      check(issues, path, isNonEmptyString(current.name), "current.name must be a non-empty string");
      check(
        issues,
        path,
        isNonEmptyString(current.categorySlug),
        "current.categorySlug must be a non-empty string"
      );
      check(issues, path, PRODUCT_TYPES.has(current.type), `current.type must be one of ${[...PRODUCT_TYPES].join(", ")}`);
      check(issues, path, isNonEmptyString(current.price), "current.price must be a non-empty numeric string");
      check(
        issues,
        path,
        typeof current.discountPercent === "number",
        "current.discountPercent must be a number"
      );
      check(issues, path, typeof current.stock === "number", "current.stock must be a number");
      if (knownCategorySlugs) {
        check(
          issues,
          path,
          knownCategorySlugs.has(current.categorySlug),
          `current.categorySlug "${current.categorySlug}" is not in categories.json`
        );
      }
    }
  });
  return issues;
}

/**
 * `terms.json` — `TermSeed[]`.
 * @param {unknown} data
 * @returns {ValidationIssue[]}
 */
export function validateTerms(data) {
  const issues = [];
  check(issues, [], Array.isArray(data), "terms.json must be an array");
  if (!Array.isArray(data)) return issues;

  const TAXONOMY_TYPES = new Set(["category", "tag", "channel", "topic"]);
  data.forEach((item, index) => {
    const path = [String(index)];
    check(issues, path, TAXONOMY_TYPES.has(item?.taxonomyType), "taxonomyType must be a valid taxonomy type");
    check(issues, path, isNonEmptyString(item?.name), "name must be a non-empty string");
    check(issues, path, isNonEmptyString(item?.slug), "slug must be a non-empty string");
    check(issues, path, isStringOrNull(item?.description), "description must be a string or null");
  });
  return issues;
}

/**
 * `rubrik.json` — `RubrikSeed[]`. Verifies every `parentSlug` names an
 * earlier entry (the same ordering constraint `ensureRubrikTerms` enforces
 * at seed time).
 * @param {unknown} data
 * @returns {ValidationIssue[]}
 */
export function validateRubrik(data) {
  const issues = [];
  check(issues, [], Array.isArray(data), "rubrik.json must be an array");
  if (!Array.isArray(data)) return issues;

  const seenSlugs = new Set();
  data.forEach((item, index) => {
    const path = [String(index)];
    check(issues, path, isNonEmptyString(item?.name), "name must be a non-empty string");
    check(issues, path, isNonEmptyString(item?.slug), "slug must be a non-empty string");
    check(issues, path, "parentSlug" in item, "parentSlug must be present (string or null)");
    if (isNonEmptyString(item?.parentSlug)) {
      check(
        issues,
        path,
        seenSlugs.has(item.parentSlug),
        `parentSlug "${item.parentSlug}" must name an earlier entry`
      );
    }
    if (isNonEmptyString(item?.slug)) seenSlugs.add(item.slug);
  });
  return issues;
}

const PAGE_TYPES = new Set(["standard", "landing", "legal", "system"]);

/**
 * `pages.json` — `PageSeed[]`.
 * @param {unknown} data
 * @returns {ValidationIssue[]}
 */
export function validatePages(data) {
  const issues = [];
  check(issues, [], Array.isArray(data), "pages.json must be an array");
  if (!Array.isArray(data)) return issues;

  const seenSlugs = new Set();
  data.forEach((item, index) => {
    const path = [String(index)];
    check(issues, path, isNonEmptyString(item?.slug), "slug must be a non-empty string");
    check(issues, path, isNonEmptyString(item?.title), "title must be a non-empty string");
    check(issues, path, PAGE_TYPES.has(item?.pageType), `pageType must be one of ${[...PAGE_TYPES].join(", ")}`);
    check(issues, path, isNonEmptyString(item?.excerpt), "excerpt must be a non-empty string");
    check(
      issues,
      path,
      Array.isArray(item?.bodyParagraphs) && item.bodyParagraphs.every(isNonEmptyString),
      "bodyParagraphs must be a non-empty array of non-empty strings"
    );
    if (isNonEmptyString(item?.slug)) {
      check(issues, path, !seenSlugs.has(item.slug), `duplicate slug "${item.slug}"`);
      seenSlugs.add(item.slug);
    }
  });
  return issues;
}

/**
 * `posts-berita.json` — `NewsPostSeed[]`.
 * @param {unknown} data
 * @param {Set<string>} [knownRubrikSlugs]
 * @param {Set<string>} [knownInstitutionSlugs]
 * @returns {ValidationIssue[]}
 */
export function validateNewsPosts(data, knownRubrikSlugs, knownInstitutionSlugs) {
  const issues = [];
  check(issues, [], Array.isArray(data), "posts-berita.json must be an array");
  if (!Array.isArray(data)) return issues;

  const seenSlugs = new Set();
  data.forEach((item, index) => {
    const path = [String(index), item?.slug ?? "?"];
    check(issues, path, isNonEmptyString(item?.slug), "slug must be a non-empty string");
    check(issues, path, isNonEmptyString(item?.title), "title must be a non-empty string");
    check(issues, path, isNonEmptyString(item?.excerpt), "excerpt must be a non-empty string");
    check(issues, path, isNonEmptyString(item?.rubrikSlug), "rubrikSlug must be a non-empty string");
    check(
      issues,
      path,
      Array.isArray(item?.bodyParagraphs) && item.bodyParagraphs.every(isNonEmptyString),
      "bodyParagraphs must be a non-empty array of non-empty strings"
    );
    if (isNonEmptyString(item?.slug)) {
      check(issues, path, !seenSlugs.has(item.slug), `duplicate slug "${item.slug}"`);
      seenSlugs.add(item.slug);
    }
    if (knownRubrikSlugs && isNonEmptyString(item?.rubrikSlug)) {
      check(
        issues,
        path,
        knownRubrikSlugs.has(item.rubrikSlug),
        `rubrikSlug "${item.rubrikSlug}" is not in rubrik.json`
      );
    }
    if (item?.institutionSlugs !== undefined) {
      check(issues, path, Array.isArray(item.institutionSlugs), "institutionSlugs must be an array when present");
      if (Array.isArray(item.institutionSlugs) && knownInstitutionSlugs) {
        for (const slug of item.institutionSlugs) {
          check(
            issues,
            path,
            knownInstitutionSlugs.has(slug),
            `institutionSlugs entry "${slug}" is not in institutions.json`
          );
        }
      }
    }
  });
  return issues;
}

/**
 * `institutions.json` — `InstitutionSeed[]`. Two region-resolution
 * strategies exist in `tools/seed-cms.ts`: `contoh:borneojek-mart` resolves
 * every `regionLevel: 2` entry against a hardcoded 14-regency Kalteng list
 * (verbatim, issue #57 logic — no `provinceName` field needed, every entry
 * is implicitly Kalimantan Tengah), while the generic `berita` profile
 * resolver derives its province set FROM the data and so needs an explicit
 * `provinceName` per level-2 entry. `requireProvinceName` selects which
 * contract to check; only `berita`'s own profile validates with it `true`.
 * @param {unknown} data
 * @param {{ requireProvinceName?: boolean }} [options]
 * @returns {ValidationIssue[]}
 */
export function validateInstitutions(data, options) {
  const requireProvinceName = options?.requireProvinceName ?? false;
  const issues = [];
  check(issues, [], Array.isArray(data), "institutions.json must be an array");
  if (!Array.isArray(data)) return issues;

  const BRANCHES = new Set(["legislative", "executive"]);
  data.forEach((item, index) => {
    const path = [String(index)];
    check(issues, path, isNonEmptyString(item?.name), "name must be a non-empty string");
    check(issues, path, isNonEmptyString(item?.slug), "slug must be a non-empty string");
    check(issues, path, BRANCHES.has(item?.branch), "branch must be legislative or executive");
    check(issues, path, item?.regionLevel === 1 || item?.regionLevel === 2, "regionLevel must be 1 or 2");
    check(issues, path, isNonEmptyString(item?.regionName), "regionName must be a non-empty string");
    if (requireProvinceName && item?.regionLevel === 2) {
      check(
        issues,
        path,
        isNonEmptyString(item?.provinceName),
        "regionLevel 2 entries need a provinceName to resolve their parent province"
      );
    }
  });
  return issues;
}

/**
 * `authors.json` — informational bylines only (`blog_content` has no author
 * entity separate from the tenant user that created a post — see
 * `tools/seed-cms.ts`'s own docblock).
 * @param {unknown} data
 * @returns {ValidationIssue[]}
 */
export function validateAuthors(data) {
  const issues = [];
  check(issues, [], Array.isArray(data), "authors.json must be an array");
  if (!Array.isArray(data)) return issues;

  data.forEach((item, index) => {
    const path = [String(index)];
    check(issues, path, isNonEmptyString(item?.name), "name must be a non-empty string");
    check(issues, path, isNonEmptyString(item?.role), "role must be a non-empty string");
  });
  return issues;
}

/**
 * `site-profile.json` — `{ current, future? }`.
 * @param {unknown} data
 * @returns {ValidationIssue[]}
 */
export function validateSiteProfile(data) {
  const issues = [];
  check(issues, [], typeof data === "object" && data !== null, "site-profile.json must be an object");
  if (typeof data !== "object" || data === null) return issues;

  const current = /** @type {any} */ (data).current;
  check(issues, ["current"], typeof current === "object" && current !== null, "current must be an object");
  if (typeof current === "object" && current !== null) {
    check(issues, ["current"], isNonEmptyString(current.tagline), "current.tagline must be a non-empty string");
    check(
      issues,
      ["current"],
      isNonEmptyString(current.copyrightNotice),
      "current.copyrightNotice must be a non-empty string"
    );
  }
  return issues;
}

/**
 * `marketing.json` — the shape `ensureMarketing` reads.
 * @param {unknown} data
 * @param {Set<string>} [knownProductSlugs]
 * @returns {ValidationIssue[]}
 */
export function validateMarketing(data, knownProductSlugs) {
  const issues = [];
  check(issues, [], typeof data === "object" && data !== null, "marketing.json must be an object");
  if (typeof data !== "object" || data === null) return issues;

  const seed = /** @type {any} */ (data);
  check(issues, ["flashSales"], Array.isArray(seed.flashSales), "flashSales must be an array");
  check(issues, ["vouchers"], Array.isArray(seed.vouchers), "vouchers must be an array");
  check(issues, ["testimonials"], Array.isArray(seed.testimonials), "testimonials must be an array");
  check(
    issues,
    ["popup"],
    typeof seed.popup === "object" && seed.popup !== null,
    "popup must be an object"
  );
  check(
    issues,
    ["storeSettings"],
    typeof seed.storeSettings === "object" && seed.storeSettings !== null,
    "storeSettings must be an object"
  );

  if (knownProductSlugs && Array.isArray(seed.flashSales)) {
    for (const sale of seed.flashSales) {
      for (const entry of sale.products ?? []) {
        check(
          issues,
          ["flashSales", sale.slug ?? "?"],
          knownProductSlugs.has(entry.productSlug),
          `flash sale product "${entry.productSlug}" is not in products.json`
        );
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// No-PII scan — a regex sweep over the RAW JSON text of a seed file, not the
// parsed object, so a phone/e-mail/domain hiding inside a string value (a
// body paragraph, a description) is caught the same as one in a dedicated
// field.
// ---------------------------------------------------------------------------

/**
 * Domains/numbers this profile's placeholder content is explicitly allowed
 * to use — reserved-for-documentation domains (RFC 2606/6761) and the
 * `+62 800 0000 0000`-style placeholder phone number this issue's own
 * contract names.
 */
export const PII_ALLOWLIST_DOMAINS = ["example.com", "example.id", "example.net", "example.org"];

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;

// Indonesian mobile-style numbers: an optional +62/62/0 prefix followed by
// 8, then 8-11 more digits, allowing spaces or dashes as separators —
// deliberately loose (a false positive here just means an extra allowlist
// check on a placeholder), never used to PARSE a real number.
const PHONE_PATTERN = /(?:\+?62|0)[\s-]?8[\s-]?(?:[0-9][\s-]?){7,11}/g;

/**
 * @param {string} jsonText
 * @returns {{ emails: string[]; phones: string[] }} every match NOT covered
 * by the allowlist (an `example.*` e-mail domain, or a phone number whose
 * digits collapse to the `62800000000` / `0800000000` placeholder shape).
 */
export function scanForPii(jsonText) {
  const emails = [];
  for (const match of jsonText.matchAll(EMAIL_PATTERN)) {
    const domain = match[1].toLowerCase();
    if (!PII_ALLOWLIST_DOMAINS.includes(domain)) emails.push(match[0]);
  }

  const phones = [];
  for (const match of jsonText.matchAll(PHONE_PATTERN)) {
    const digits = match[0].replace(/\D/g, "");
    // Placeholder shapes this issue's contract names: 62800000000 (with a
    // 62 or 0 prefix) — every digit after the leading 8 is a zero.
    const normalized = digits.replace(/^62/, "").replace(/^0/, "");
    const isPlaceholder = /^80{7,11}$/.test(normalized);
    if (!isPlaceholder) phones.push(match[0]);
  }

  return { emails, phones };
}
