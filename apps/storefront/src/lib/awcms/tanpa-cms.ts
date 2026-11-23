/**
 * Issue #535: the `landing` profile is a static company-profile site that
 * needs no CMS content, so it must be buildable where no CMS credentials
 * exist (a pipeline that only builds the image).
 *
 * `buildsWithoutCms()` answers true ONLY when the build profile is `landing`
 * AND `AWCMS_API_URL` is unset. Each build-time reader in this directory
 * that the landing profile reaches returns its empty value on that answer
 * instead of calling `client.ts`. `client.ts` itself is untouched, so on
 * `toko` and `berita`, or on `landing` with a CMS configured, nothing
 * changes and a missing `AWCMS_API_URL` still fails loudly.
 *
 * Both inputs are read per call (not frozen at import), the same shape
 * `client.ts`'s `baseUrl()` uses, so the answer is testable and correct under
 * `astro dev`. `PUBLIC_AWCMS_ORIGIN` stays required on every profile: it is
 * also the CSP `connect-src` (see `toko-origin.ts`).
 */
import { SITE_PROFILE_ENV, resolveSiteProfile } from "../../config/profil";
import { readEnv } from "../env";

export function buildsWithoutCms(): boolean {
  return (
    resolveSiteProfile(readEnv(SITE_PROFILE_ENV)) === "landing" &&
    readEnv("AWCMS_API_URL") === undefined
  );
}
