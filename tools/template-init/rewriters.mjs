/**
 * rewriters.mjs — the flag-driven half of ADR-0018 D4's brand surface: pure
 * `(content, flags) -> content` functions, one per target file, each a
 * TARGETED replacement (see `text.mjs`'s own docblock for why). None of
 * these touch the disk; `plan.mjs` reads, these transform, `apply.mjs`
 * writes only what actually changed — which is also what makes a second run
 * with identical flags a no-op: every one of these is idempotent by
 * construction (rewriting already-rewritten content reproduces it exactly).
 *
 * `apps/cms/**` has no entry here at all — ADR-0018 D4's "never rewritten"
 * rule, enforced by omission rather than by a guard that could be forgotten.
 */
import {
  extractBlock,
  replaceBetweenAnchors,
  replaceLineOnce,
  setEnvValue,
  setStringField,
  withBlock
} from "./text.mjs";

/** @typedef {import("./flags.mjs").TemplateFlags} TemplateFlags */

const SITE_DESCRIPTION_BY_PROFILE = {
  toko: (nama) => `Katalog produk ${nama}.`,
  berita: (nama) => `Berita dan artikel dari ${nama}.`,
  landing: (nama) => `Profil resmi ${nama}.`
};

/** `DEFAULT_IDENTITY.description` — a friendlier one-line catchphrase, not the SEO-facing sentence `SITE_DESCRIPTION_BY_PROFILE` above provides. */
const IDENTITY_DESCRIPTION_BY_PROFILE = {
  toko: (nama) => `Belanja online hemat, mudah, dan terpercaya di ${nama}`,
  berita: (nama) => `Berita terpercaya dari ${nama}`,
  landing: (nama) => `Solusi tepercaya dari ${nama}`
};

/**
 * `apps/storefront/src/config/site.ts` — `DEFAULT_IDENTITY`,
 * `DEFAULT_THEME_COLORS`, and the `SITE_NAME`/`SITE_DESCRIPTION`
 * `readEnvOr` fallbacks (ADR-0018 D4; the exact surface this file already
 * centralises, per its own docblock).
 *
 * @param {string} content
 * @param {TemplateFlags} flags
 * @returns {string}
 */
export function rewriteSiteTs(content, flags) {
  let next = content;

  // A plain literal match (BjekMart's own default) would not survive a
  // SECOND run with a different --nama, since the literal would already be
  // gone. Matching `readEnvOr("SITE_NAME", "<anything>")` instead finds the
  // field regardless of what a prior run wrote there; it occurs exactly
  // once in this file by construction (declared once, in `siteConfig`).
  //
  // The presence check is against the REGEX matching `content` (not a
  // before/after string comparison) — a run whose flags happen to already
  // match what is on disk produces IDENTICAL output, which must still count
  // as "found and correctly idempotent", not as "field not found".
  const siteNameRe = /readEnvOr\("SITE_NAME",\s*"(?:[^"\\]|\\.)*"\)/;
  if (!siteNameRe.test(content)) {
    throw new Error("site.ts: SITE_NAME readEnvOr default not found");
  }
  next = content.replace(siteNameRe, `readEnvOr("SITE_NAME", ${JSON.stringify(flags.nama)})`);

  const describe = SITE_DESCRIPTION_BY_PROFILE[flags.profil] ?? SITE_DESCRIPTION_BY_PROFILE.toko;
  const nextDescription = describe(flags.nama);
  const siteDescriptionRe = /readEnvOr\("SITE_DESCRIPTION",\s*"(?:[^"\\]|\\.)*"\)/;
  if (!siteDescriptionRe.test(next)) {
    throw new Error("site.ts: SITE_DESCRIPTION readEnvOr default not found");
  }
  next = next.replace(siteDescriptionRe, `readEnvOr("SITE_DESCRIPTION", ${JSON.stringify(nextDescription)})`);

  const identity = extractBlock(
    next,
    "export const DEFAULT_IDENTITY = {",
    "} as const;",
    "site.ts DEFAULT_IDENTITY"
  );
  let identityBlock = identity.block;
  identityBlock = setStringField(identityBlock, "name", flags.nama, "DEFAULT_IDENTITY.name");
  // Not in ADR-0018 D4's original wave-0 list (only `.name`/`.contactEmail`/
  // `.contactPhone`/`.address` were named) — corrected here, in the same
  // change that implements the tool: leaving `.description` untouched
  // ships BjekMart's own catchphrase text ("...di BjekMart") into every
  // derived deployment forever, exactly the defect D4's own "Rejected (c)"
  // paragraph describes. Derived from `--nama`/`--profil`, the same inputs
  // `SITE_DESCRIPTION`'s own default already uses.
  identityBlock = setStringField(
    identityBlock,
    "description",
    IDENTITY_DESCRIPTION_BY_PROFILE[flags.profil]?.(flags.nama) ?? IDENTITY_DESCRIPTION_BY_PROFILE.toko(flags.nama),
    "DEFAULT_IDENTITY.description"
  );
  identityBlock = setStringField(
    identityBlock,
    "contactEmail",
    flags.kontakEmail,
    "DEFAULT_IDENTITY.contactEmail"
  );
  if (flags.kontakTelepon) {
    identityBlock = setStringField(
      identityBlock,
      "contactPhone",
      flags.kontakTelepon,
      "DEFAULT_IDENTITY.contactPhone"
    );
  }
  if (flags.alamat) {
    identityBlock = setStringField(identityBlock, "address", flags.alamat, "DEFAULT_IDENTITY.address");
  }
  next = withBlock(identity, identityBlock);

  const theme = extractBlock(
    next,
    "export const DEFAULT_THEME_COLORS = {",
    "} as const;",
    "site.ts DEFAULT_THEME_COLORS"
  );
  let themeBlock = theme.block;
  themeBlock = setStringField(themeBlock, "primary", flags.warnaPrimer, "DEFAULT_THEME_COLORS.primary");
  themeBlock = setStringField(themeBlock, "secondary", flags.warnaSekunder, "DEFAULT_THEME_COLORS.secondary");
  themeBlock = setStringField(themeBlock, "accent", flags.warnaAksen, "DEFAULT_THEME_COLORS.accent");
  next = withBlock(theme, themeBlock);

  return next;
}

/**
 * `compose.yaml` — the Docker Compose project name, container name, and
 * named volume, all currently prefixed `awcms-one-` (ADR-0018 D4).
 *
 * @param {string} content
 * @param {TemplateFlags} flags
 * @returns {string}
 */
export function rewriteComposeYaml(content, flags) {
  // Every field below is matched by its OWN LINE's fixed shape, never by
  // the slug value it currently carries — a plain literal match on
  // `awcms-one` would find nothing on a second run with a DIFFERENT slug,
  // since the first run's own output has already replaced that literal
  // (see `text.mjs`'s `replaceLineOnce`/`replaceBetweenAnchors` docblocks).
  let next = content;
  next = replaceBetweenAnchors(next, "\nname: ", "\n", flags.slug, "compose.yaml project name");
  next = replaceLineOnce(
    next,
    /^    container_name: [\w-]+-postgres$/,
    `    container_name: ${flags.slug}-postgres`,
    "compose.yaml container_name"
  );
  next = replaceLineOnce(
    next,
    /^      - [\w-]+-pgdata:\/var\/lib\/postgresql$/,
    `      - ${flags.slug}-pgdata:/var/lib/postgresql`,
    "compose.yaml volume mount"
  );
  next = replaceLineOnce(next, /^  [\w-]+-pgdata:$/, `  ${flags.slug}-pgdata:`, "compose.yaml named volume key");
  next = replaceLineOnce(
    next,
    /^    name: [\w-]+-pgdata$/,
    `    name: ${flags.slug}-pgdata`,
    "compose.yaml named volume name"
  );
  return next;
}

/**
 * Root `.env.example` — the seed-script tenant defaults (ADR-0018 D4; the
 * seed SCRIPT itself is a separate removal target, see `removals.mjs`, but
 * these variable defaults are read by whichever seeder (old or #139's new
 * one) is present, so they are rewritten unconditionally).
 *
 * @param {string} content
 * @param {TemplateFlags} flags
 * @returns {string}
 */
export function rewriteRootEnvExample(content, flags) {
  // `setEnvValue` matches the KEY, never the value — idempotency-safe the
  // same way `replaceBetweenAnchors` is (see that function's docblock).
  let next = content;
  next = setEnvValue(next, "SEED_TENANT_CODE", flags.slug, ".env.example SEED_TENANT_CODE");
  next = setEnvValue(next, "SEED_TENANT_NAME", flags.nama, ".env.example SEED_TENANT_NAME");
  next = setEnvValue(next, "SEED_OFFICE_CODE", `HQ-${flags.slug.toUpperCase()}`, ".env.example SEED_OFFICE_CODE");
  next = setEnvValue(next, "SEED_OFFICE_NAME", `${flags.nama} Head Office`, ".env.example SEED_OFFICE_NAME");
  next = setEnvValue(next, "SEED_OWNER_EMAIL", flags.kontakEmail, ".env.example SEED_OWNER_EMAIL");
  return next;
}

/**
 * `apps/storefront/.env.example` — `SITE_URL`/`SITE_NAME`/`SITE_DESCRIPTION`
 * defaults, plus a new `SITE_PROFILE` line.
 *
 * **Deviation from `docs/template.md`'s first-drafted wording, corrected in
 * the same change that adds this file**: the ADR/doc describe `.env.example`
 * (the ROOT one) as carrying `SITE_NAME`/`SITE_URL`/`SITE_PROFILE`. In the
 * tree as it stands on this branch, those three variables live in
 * `apps/storefront/.env.example` (the root file documents only
 * root-owned-script variables — see that file's own header). `SITE_PROFILE`
 * itself does not exist anywhere yet: issue #137 (the `SITE_PROFILE`
 * mechanism itself) has not landed on this branch. This function adds the
 * line here, forward-compatible with #137 reading it once it lands, and
 * rewrites the three that already exist.
 *
 * @param {string} content
 * @param {TemplateFlags} flags
 * @returns {string}
 */
export function rewriteStorefrontEnvExample(content, flags) {
  // Issue #137 landed while this issue was in flight and added its own
  // `# SITE_PROFILE=toko` line (commented out, documented, right after
  // `SITE_NAME`/`SITE_DESCRIPTION`) — this function no longer needs to
  // INSERT the line itself (an earlier version of it did, defensively,
  // back when #137 had not landed yet). It only needs to UNCOMMENT it and
  // set it to the deployment's own chosen profile, matching whether the
  // line is already active (a second `template:init` run) or still
  // commented out (the very first run, or #137's own untouched default).
  let next = content;
  next = setEnvValue(next, "SITE_URL", `https://${flags.domain}`, "apps/storefront/.env.example SITE_URL");

  const siteProfileRe = /^#?\s*SITE_PROFILE=\w*$/m;
  if (!siteProfileRe.test(next)) {
    throw new Error("apps/storefront/.env.example: SITE_PROFILE line not found");
  }
  next = next.replace(siteProfileRe, `SITE_PROFILE=${flags.profil}`);

  next = setEnvValue(next, "SITE_NAME", flags.nama, "apps/storefront/.env.example SITE_NAME");
  const describe = SITE_DESCRIPTION_BY_PROFILE[flags.profil] ?? SITE_DESCRIPTION_BY_PROFILE.toko;
  next = setEnvValue(next, "SITE_DESCRIPTION", describe(flags.nama), "apps/storefront/.env.example SITE_DESCRIPTION");
  return next;
}

/**
 * `bun.lock` — ONLY the root workspace's own `name` field (the `""` entry
 * inside `workspaces`), never any other workspace's name and never anything
 * else in the file (issue #227).
 *
 * `template:init` rewrites `package.json`'s own `name` to `flags.slug`, but
 * `bun install` does not rewrite an EXISTING root workspace entry in
 * `bun.lock` to match — it reports "no changes" and leaves
 * `workspaces[""].name` as `"awcms-one"`. `bun run check:lockfile`
 * (`tools/cek-lockfile.mjs`) then fails in every derived repository with
 * "lockfile entry name = \"awcms-one\", package.json name = \"<slug>\"".
 *
 * This is a targeted, single-field string replacement, never a full
 * lockfile regeneration: `rm -rf node_modules bun.lock && bun install` would
 * re-resolve every dependency and could drift resolved versions in a
 * derived repo's very first commit, which is exactly what this fix must
 * avoid.
 *
 * Anchored on the fixed STRUCTURE of the root workspace entry — the `""`
 * key is unique to the root workspace by definition, and bun always emits
 * it as the first entry of `workspaces` with this exact indentation — never
 * on the literal value currently there. This is the same idempotency
 * reasoning `rewriteComposeYaml`'s slug lines use: a second run with a
 * DIFFERENT slug still finds this exact anchor, because the anchor is the
 * surrounding JSON shape, not this tool's own prior output. If bun ever
 * changes that shape, `replaceBetweenAnchors` throws loudly (exit 1) rather
 * than silently rewriting the wrong field or a different workspace's name.
 *
 * @param {string} content
 * @param {TemplateFlags} flags
 * @returns {string}
 */
export function rewriteBunLock(content, flags) {
  return replaceBetweenAnchors(
    content,
    '"workspaces": {\n    "": {\n      "name": "',
    '",\n    },',
    flags.slug,
    'bun.lock root workspace name (workspaces[""].name)'
  );
}

const UPSTREAM_TEMPLATE_URL = "https://github.com/ahliweb/awcms-one";

/**
 * `README.md` / `README.id.md` hero — the opening bold description
 * sentence, and the "Use this as a template" / "Gunakan sebagai template"
 * section, repointed at the upstream template rather than describing the
 * mechanism as still-being-built (ADR-0018 D4; the task's own explicit
 * instruction to keep that section but repoint it).
 *
 * @param {string} content
 * @param {TemplateFlags} flags
 * @param {{ lang: "en" | "id" }} opts
 * @returns {string}
 */
export function rewriteReadme(content, flags, opts) {
  // Both spans are matched by extractBlock's structural markers — the H1
  // title / next-heading pair, never by the hero text's own content — so
  // this is idempotent regardless of what a PRIOR run already wrote there
  // (see text.mjs's `replaceBetweenAnchors` docblock for why a literal-text
  // match cannot survive a second run with different flags).
  const heroMarkers =
    opts.lang === "en"
      ? { start: "# awcms-one\n\n", end: "\n\n## Where this sits in the AWCMS family" }
      : { start: "# awcms-one\n\n", end: "\n\n## Letak repo ini di keluarga AWCMS" };
  const templateSectionMarkers =
    opts.lang === "en"
      ? { start: "## Use this as a template\n\n", end: "\n\n## Documentation" }
      : { start: "## Gunakan sebagai template\n\n", end: "\n\n## Dokumentasi" };

  const hero =
    opts.lang === "en"
      ? `**${flags.nama}** is a deployment created from the [awcms-one](${UPSTREAM_TEMPLATE_URL}) template — Bun, Astro, and PostgreSQL under row-level security. Its build profile is \`${flags.profil}\` and its canonical domain is \`${flags.domain}\` (see [\`docs/template.md\`](docs/template.md)).`
      : `**${flags.nama}** adalah deployment yang dibuat dari template [awcms-one](${UPSTREAM_TEMPLATE_URL}) — Bun, Astro, dan PostgreSQL dengan row-level security. Profil build-nya adalah \`${flags.profil}\` dan domain kanoniknya adalah \`${flags.domain}\` (lihat [\`docs/template.md\`](docs/template.id.md)).`;

  const templateSection =
    opts.lang === "en"
      ? `This repository was created from the [\`ahliweb/awcms-one\`](${UPSTREAM_TEMPLATE_URL}) template using its own \`bun run template:init\` — see that repository's [\`docs/template.md\`](${UPSTREAM_TEMPLATE_URL}/blob/main/docs/template.md) for the walkthrough and [ADR-0018](${UPSTREAM_TEMPLATE_URL}/blob/main/docs/adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md) for the design decisions behind it.`
      : `Repositori ini dibuat dari template [\`ahliweb/awcms-one\`](${UPSTREAM_TEMPLATE_URL}) menggunakan \`bun run template:init\` milik template itu sendiri — lihat [\`docs/template.md\`](${UPSTREAM_TEMPLATE_URL}/blob/main/docs/template.md) repositori tersebut untuk panduannya dan [ADR-0018](${UPSTREAM_TEMPLATE_URL}/blob/main/docs/adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md) untuk keputusan desain di baliknya.`;

  const label = opts.lang === "en" ? "README.md" : "README.id.md";
  let next = extractHeroBlock(content, heroMarkers, hero, `${label} hero`);
  next = extractHeroBlock(next, templateSectionMarkers, templateSection, `${label} template section`);
  return next;
}

/** Small local wrapper around `extractBlock`/`withBlock` for a whole-block replacement. */
function extractHeroBlock(content, { start, end }, replacement, label) {
  const extracted = extractBlock(content, start, end, label);
  return withBlock(extracted, replacement);
}

/**
 * `SUPPORT.md` / `SUPPORT.id.md` — the descriptive first line naming
 * "re-platforming borneojek-mart" (ADR-0018 D4's "contact/hero lines").
 *
 * @param {string} content
 * @param {TemplateFlags} flags
 * @param {{ lang: "en" | "id" }} opts
 * @returns {string}
 */
export function rewriteSupport(content, flags, opts) {
  // Fixed prefix/suffix around the varying part (see
  // `replaceBetweenAnchors`'s own docblock for why this — not a literal
  // match on the ORIGINAL BjekMart text — is what stays idempotent across
  // repeated runs with different `--nama` values).
  if (opts.lang === "en") {
    return replaceBetweenAnchors(
      content,
      "**This repo holds the code and documentation for ",
      ", not its live storefront or customer support.**",
      flags.nama,
      "SUPPORT.md hero"
    );
  }
  return replaceBetweenAnchors(
    content,
    "**Repo ini menyimpan kode dan dokumentasi untuk ",
    ", bukan toko yang sudah tayang atau layanan pelanggannya.**",
    flags.nama,
    "SUPPORT.id.md hero"
  );
}

/**
 * `SECURITY.md` / `SECURITY.id.md` — no BjekMart-specific contact line
 * exists today (verified against the current file: every address in it is
 * a GitHub URL to `ahliweb/awcms-one`, which this tool deliberately does
 * NOT rewrite — it has no `--org`/`--repo` flag to know a derived repo's
 * own GitHub location, see `docs/template.md`'s "What it does not know").
 * This function is a documented no-op placeholder kept for D4 symmetry and
 * so a future contact line added to this file has a named place to be
 * wired in.
 *
 * @param {string} content
 * @param {TemplateFlags} _flags
 * @param {{ lang: "en" | "id" }} _opts
 * @returns {string}
 */
export function rewriteSecurity(content, _flags, _opts) {
  return content;
}
