/**
 * This tenant's brand colors, read from awcms's `theming` module at build
 * time (issue #24), rendered as `--color-primary`/`--color-secondary`/
 * `--color-accent` custom properties by `src/pages/theme-tokens.css.ts`.
 *
 * ## Why this does NOT call `GET /api/v1/theming`
 *
 * The issue names that endpoint, and it was tried first — but reading
 * `apps/cms/src/pages/api/v1/theming/index.ts` and its
 * `theme-config-directory.ts` shows it cannot answer the question this file
 * needs answered. It returns `themes` (the build-time theme DESCRIPTORS,
 * with each token's DEFAULT — not a tenant's chosen value), `state` (which
 * theme is active, and a published version id — no color values), `draft`
 * (a config, but the UNPUBLISHED editor's draft, not what the public site
 * should show), and `versions` (published version METADATA — id, hash,
 * timestamp — but, verified against `theme-config-directory.ts`'s
 * `listPublishedVersions`, never the version's actual `config`). There is no
 * request shape that turns those four fields into "this tenant's live,
 * published token values" without re-implementing awcms's own resolution
 * algorithm (`theme-config.ts`'s `resolveThemeTokens`) against data this
 * endpoint does not expose. It is also gated behind a SESSION
 * (`resolveAuthInputs` — cookie or Bearer machine token) rather than being
 * a public build-time read, unlike every other endpoint this app calls.
 *
 * The endpoint that actually answers this question is the one awcms itself
 * built for it: `GET /theming/{tenantCode}/tokens.css`
 * (`apps/cms/src/modules/theming/presentation/theme-public-css.ts`) — PUBLIC
 * (no auth at all), always 200, and its own docblock says why it exists:
 * "the whole reason token values ship as an external stylesheet ... never
 * weaken CSP", the exact same reasoning `product-labels.css.ts` already
 * uses in this app. This is the "verify field names against the route code
 * ... do not invent them" correction for this one field of issue #24's
 * spec — recorded here, in the PR, and in the final report, following this
 * codebase's own precedent for a scope correction found while implementing
 * (`catalog.ts`'s "Scope amendment" comments).
 *
 * ## `AWCMS_TENANT_CODE` is a NEW, OPTIONAL env var
 *
 * `tokens.css` resolves its tenant from an explicit `tenantCode` PATH
 * segment (ADR-0009: no Host/subdomain resolution), which this app has never
 * needed before — `awcmsGet`'s Bearer token already scopes every other
 * request to a tenant. Unset, this file skips the network call entirely and
 * uses `DEFAULT_THEME_COLORS` — a legitimate, expected state (a deployment
 * that has not been told its public tenant code yet), not an error.
 *
 * ## `--color-secondary` has no CMS equivalent
 *
 * The registered base theme (`apps/cms/src/modules/theming/themes/
 * default-theme.ts`) declares `color_primary`, `color_accent`, and five
 * other tokens — there is no `color_secondary` token anywhere in the
 * descriptor. A "secondary" brand color is this app's OWN three-color
 * convention, not awcms's, so it always renders `DEFAULT_THEME_COLORS.
 * secondary` regardless of what the CMS returns; only primary/accent are
 * ever CMS-driven. Documented rather than silently approximated.
 */
import { readEnv } from "../env";
import { DEFAULT_THEME_COLORS } from "../../config/site";

export type ThemeColors = {
  primary: string;
  secondary: string;
  accent: string;
};

/** `--awcms-theme-<key>: <value>;` — see `theme-config.ts`'s `THEME_CSS_CUSTOM_PROPERTY_PREFIX`. */
const TOKEN_PREFIX = "--awcms-theme-";

/**
 * Pulls one custom-property value out of a `:root { ... }` stylesheet.
 * Pure and exported so the parsing itself is unit-testable without a
 * network (`tests/theme.test.ts`).
 *
 * A regex over CSS text is safe here specifically because the source is
 * `serializeThemeTokensCss` — awcms's own, safe-by-construction serializer
 * (every value it emits already passed `resolveThemeTokens`'s
 * re-validation) — not arbitrary CSS this file must defend against.
 */
export function extractThemeToken(css: string, tokenKey: string): string | null {
  const pattern = new RegExp(
    `${TOKEN_PREFIX}${tokenKey}\\s*:\\s*([^;]+);`
  );
  const match = pattern.exec(css);
  return match ? match[1]!.trim() : null;
}

function tenantCode(): string | undefined {
  return readEnv("AWCMS_TENANT_CODE");
}

function apiOrigin(): string | undefined {
  const raw = readEnv("AWCMS_API_URL");
  return raw ? raw.replace(/\/+$/, "") : undefined;
}

let themeCache: Promise<ThemeColors> | undefined;

/** This tenant's brand colors, fetched once per build and memoized. */
export function getSiteTheme(): Promise<ThemeColors> {
  themeCache ??= fetchSiteTheme();
  return themeCache;
}

async function fetchSiteTheme(): Promise<ThemeColors> {
  const code = tenantCode();
  const origin = apiOrigin();

  if (!code || !origin) {
    return { ...DEFAULT_THEME_COLORS };
  }

  const url = `${origin}/theming/${encodeURIComponent(code)}/tokens.css`;

  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "text/css" } });
  } catch (cause) {
    console.warn(
      `[awcms] theme tokens not read: could not reach ${url} (${
        cause instanceof Error ? cause.message : String(cause)
      }).\n        Falling back to BjekMart's default palette. Brand ` +
        `colors are cosmetic, so this degrades rather than failing the build.`
    );
    return { ...DEFAULT_THEME_COLORS };
  }

  if (!response.ok) {
    console.warn(
      `[awcms] theme tokens not read: ${url} answered HTTP ${response.status}.\n` +
        `        Falling back to BjekMart's default palette.`
    );
    return { ...DEFAULT_THEME_COLORS };
  }

  const css = await response.text();
  const primary = extractThemeToken(css, "color_primary");
  const accent = extractThemeToken(css, "color_accent");

  return {
    primary: primary ?? DEFAULT_THEME_COLORS.primary,
    // No CMS equivalent — see file header. Always the default.
    secondary: DEFAULT_THEME_COLORS.secondary,
    accent: accent ?? DEFAULT_THEME_COLORS.accent
  };
}

/** Test seam: drops the per-build memoized fetch. */
export function resetSiteThemeCacheForTests(): void {
  themeCache = undefined;
}
