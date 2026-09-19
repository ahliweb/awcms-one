/**
 * Referral capture (issue #93, S3 of #32) — mounted ONCE from
 * `BaseLayout.astro`'s existing script block, on EVERY page, per the
 * `?ref=CODE` link a shopper might land on from any page of this site.
 *
 * On load: read `?ref=` from the current URL; if it is a valid code
 * (`validasiKodeAfiliasi`), store it (`simpanKodeAfiliasi` — a newer valid
 * code always replaces an older one) and remove ONLY the `ref` parameter
 * with `history.replaceState`, so:
 *
 *   - a bookmark/share of the CLEANED url carries no query string it did
 *     not intend to;
 *   - the canonical link `BaseLayout.astro` already renders for this page
 *     stays the plain, `?ref=`-free path (`docs/seo.md` explains why this
 *     happens client-side rather than as a build-time redirect: the
 *     referral must still be CAPTURED before the query string disappears,
 *     which a server-side 301 before this page ever loads cannot do without
 *     a runtime credential this static site does not have, per ADR-0007);
 *   - every OTHER query parameter on the URL is left completely untouched —
 *     this script touches `ref` and nothing else.
 *
 * An invalid/absent `?ref=` is a silent no-op: this script never rewrites
 * the URL for a page that did not carry the parameter, and never surfaces
 * an error for a malformed one (the contract's own "the CMS ignores
 * unknown/suspended codes" already covers a code that looks valid but is
 * not real — a code that does not even look valid is simply not captured).
 */
import { simpanKodeAfiliasi, validasiKodeAfiliasi } from "../lib/afiliasi-kontrak";

const url = new URL(window.location.href);
const raw = url.searchParams.get("ref");

if (raw !== null) {
  const kode = validasiKodeAfiliasi(raw);
  if (kode) {
    simpanKodeAfiliasi(kode);
    url.searchParams.delete("ref");

    try {
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // A browser that rejects `replaceState` (extremely rare) leaves the
      // query string on screen — the code was still captured above; this is
      // a cosmetic miss, never a functional one.
    }
  }
  // An INVALID `?ref=` is left exactly as-is: #93 only asks that a captured
  // (valid) code's own parameter be cleaned up, and this script has nothing
  // useful to do with a code shape it does not recognise — no error, no
  // rewrite, no capture.
}
