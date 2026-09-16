/**
 * Who this site IS, read from awcms at build time (issue #24; awcms's own
 * Issue #596, ADR-0102). Named `profil.ts` — not `profile.ts` — to match
 * this issue's own file checklist and the sibling `media-lenterakalteng`
 * template's `src/lib/awcms/profil.ts` this is adapted from (PATTERN
 * adapted, not the file ported verbatim — this app has no locales, no
 * media-object resolution, and a much smaller identity surface).
 *
 * ## What this replaces
 *
 * Everything a reader uses to tell this store apart from a generic one — the
 * masthead, tagline, copyright line, contact details, address, and social
 * profiles — used to live only in `SITE_NAME`/`SITE_DESCRIPTION`
 * (`src/config/site.ts`) plus a hardcoded footer. `GET
 * /api/v1/site-profile/composed` (`apps/cms/src/pages/api/v1/site-profile/
 * composed.ts`) is the one endpoint that answers all of it in one call —
 * see that route's own docblock for why awcms composes two modules' worth
 * of fields there rather than making every consumer call both and merge.
 *
 * ## Fields this endpoint does NOT carry, verified against the route
 *
 * `apps/cms/src/modules/site-profile/application/site-profile-directory.ts`
 * is the full column list `awcms_site_profile` has: no FAQ list, no maps-
 * embed URL. A "FAQ accordion from `contact_faqs`" and a "maps iframe when
 * set" cannot be built from a field that does not exist — `/kontak`
 * (`src/pages/kontak.astro`) renders every field this endpoint actually
 * returns and omits both rather than inventing a shape awcms does not send.
 *
 * ## Media ids, not URLs — and left unresolved in this issue
 *
 * `logoMediaId`/`faviconMediaId` come back as media object ids, resolved
 * through `media_library` exactly as an article image is (see the route's
 * own docblock). This app does not carry a media-object client: increment 1
 * (`AGENTS.md`) explicitly excludes product/media imagery from this
 * re-platform slice, and issue #24 does not name a `src/lib/awcms/media.ts`
 * file in its checklist. Both ids are still surfaced on `SiteIdentity` below
 * — unused by this issue's own pages, kept for a later issue to resolve
 * without another round trip to design the field — but no page renders an
 * `<img>` from either. The header/footer render the store NAME as the
 * brand mark, and `apps/storefront/public/favicon.svg` is this deployment's
 * bundled default favicon (see `BaseLayout.astro`).
 *
 * ## Why a 403/404 degrades, and anything else throws
 *
 * `src/lib/catalog.ts` states the rule this app builds on for CONTENT:
 * partial content is the failure worth preventing, because it looks like a
 * successful deploy. Identity is different in one specific way: every field
 * here already has a real, working default (`DEFAULT_IDENTITY`,
 * `src/config/site.ts`) — BjekMart's own public values, not a placeholder —
 * so falling back is a legitimate, expected outcome, not a degraded one.
 *
 *   - **403** — the build credential lacks `site_profile.profile.read`. Real
 *     and expected on a token minted before this module existed.
 *   - **404** — this awcms predates the endpoint.
 *   - **anything else** (5xx, timeout, unreachable) — awcms being broken,
 *     not awcms saying no. Building through it would publish a site that
 *     quietly reverted to defaults while the operator believes the CMS is
 *     live; it throws, exactly as `catalog.ts`'s fetches do.
 */
import { AwcmsApiError, awcmsGet } from "./client";
import { readEnv } from "../env";
import { DEFAULT_IDENTITY } from "../../config/site";

/** One social profile link, as `SiteProfile.socialLinks` (`apps/cms`'s OpenAPI fragment) shapes it. */
export type SocialLink = { platform: string; url: string };

/** The composed endpoint's payload, exactly as `apps/cms` names every field. */
type ComposedSiteIdentity = {
  tagline: string | null;
  copyrightNotice: string | null;
  logoMediaId: string | null;
  faviconMediaId: string | null;
  editorialAddress: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  whatsappNumber: string | null;
  socialLinks: unknown;
  siteName: string | null;
  organizationName: string | null;
  organizationLogoMediaId: string | null;
  defaultSocialMediaId: string | null;
};

export type SiteIdentity = {
  name: string;
  /** `tagline` from the CMS, standing in for a "description" field the endpoint does not have. */
  description: string;
  copyrightNotice: string | null;
  address: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  whatsappNumber: string | null;
  socialLinks: SocialLink[];
  /** Surfaced, unresolved — see file header "Media ids, not URLs". */
  logoMediaId: string | null;
  faviconMediaId: string | null;
};

/**
 * `socialLinks` arrives from `jsonb` as `unknown` even though the endpoint
 * validated it at write time — a row written before a future validator
 * change must not throw inside a build. Re-checked here rather than
 * trusted, same as `apps/cms`'s own reader for the same column
 * (`site-profile-directory.ts`'s `toSocialLinks`): only `http(s)` survives,
 * because this renders as an `<a href>` on every page and a `javascript:`
 * value would be stored XSS with a very long reach.
 */
export function parseSocialLinks(raw: unknown): SocialLink[] {
  if (!Array.isArray(raw)) return [];

  const links: SocialLink[] = [];

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;

    const { platform, url } = entry as Record<string, unknown>;

    if (typeof platform !== "string" || platform.trim().length === 0) continue;
    if (typeof url !== "string") continue;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;

    links.push({ platform: platform.trim(), url });
  }

  return links;
}

/** True for the two answers that mean "awcms said no", as opposed to "awcms is broken". */
function isExpectedRefusal(error: unknown): error is AwcmsApiError {
  return (
    error instanceof AwcmsApiError &&
    (error.status === 403 || error.status === 404)
  );
}

function warnDegraded(error: AwcmsApiError): void {
  const reason =
    error.status === 403
      ? "the build credential does not hold `site_profile.profile.read`. " +
        "Grant it to the machine credential's role in awcms."
      : "this awcms does not serve GET /api/v1/site-profile/composed yet " +
        "(awcms Issue #596) — upgrade the instance to use it.";

  console.warn(
    `[awcms] site identity not read: ${reason}\n` +
      `        Falling back to SITE_NAME/SITE_DESCRIPTION and BjekMart's ` +
      `own defaults for every identity field. The build succeeds and the ` +
      `site is correct — it just cannot be re-branded from the CMS yet.`
  );
}

/** The empty payload used once an expected refusal is caught — every field then falls back to `DEFAULT_IDENTITY`/env below. */
const EMPTY_PAYLOAD: ComposedSiteIdentity = {
  tagline: null,
  copyrightNotice: null,
  logoMediaId: null,
  faviconMediaId: null,
  editorialAddress: null,
  contactEmail: null,
  contactPhone: null,
  whatsappNumber: null,
  socialLinks: [],
  siteName: null,
  organizationName: null,
  organizationLogoMediaId: null,
  defaultSocialMediaId: null
};

/**
 * Merge a (possibly all-null) composed payload with the env override and
 * BjekMart's own defaults. A pure function so the merge rule is unit-
 * testable without a network — see `tests/profil.test.ts`.
 *
 * Priority, per field: an explicit `SITE_NAME`/`SITE_DESCRIPTION` env value
 * wins over the CMS (issue #24: "env stays as the override"); everything
 * else prefers the CMS value and falls back to `DEFAULT_IDENTITY` only when
 * the CMS genuinely has nothing.
 */
export function mergeSiteIdentity(payload: ComposedSiteIdentity): SiteIdentity {
  return {
    name: readEnv("SITE_NAME") ?? payload.siteName ?? DEFAULT_IDENTITY.name,
    description:
      readEnv("SITE_DESCRIPTION") ?? payload.tagline ?? DEFAULT_IDENTITY.description,
    copyrightNotice: payload.copyrightNotice,
    address: payload.editorialAddress ?? DEFAULT_IDENTITY.address,
    contactEmail: payload.contactEmail ?? DEFAULT_IDENTITY.contactEmail,
    contactPhone: payload.contactPhone ?? DEFAULT_IDENTITY.contactPhone,
    whatsappNumber: payload.whatsappNumber,
    socialLinks: parseSocialLinks(payload.socialLinks),
    logoMediaId: payload.logoMediaId,
    faviconMediaId: payload.faviconMediaId
  };
}

let identityCache: Promise<SiteIdentity> | undefined;

/**
 * This site's identity, fetched once per build and memoized — every page
 * renders the header/footer, so without this a build with N pages would ask
 * awcms who it is N times.
 */
export function getSiteIdentity(): Promise<SiteIdentity> {
  identityCache ??= fetchSiteIdentity();
  return identityCache;
}

async function fetchSiteIdentity(): Promise<SiteIdentity> {
  let payload: ComposedSiteIdentity;

  try {
    payload = await awcmsGet<ComposedSiteIdentity>(
      "/api/v1/site-profile/composed"
    );
  } catch (error) {
    if (isExpectedRefusal(error)) {
      warnDegraded(error);
      payload = EMPTY_PAYLOAD;
    } else {
      throw error;
    }
  }

  return mergeSiteIdentity(payload);
}

/** Test seam: drops the per-build memoized fetch. */
export function resetSiteIdentityCacheForTests(): void {
  identityCache = undefined;
}
