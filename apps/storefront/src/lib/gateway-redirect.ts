/**
 * Validates a payment-gateway `redirectUrl` (issue #112, contract: #106 D3)
 * before this app ever hands the browser's WHOLE navigation to it
 * (`window.location.assign` — never a `fetch`, never an `<iframe>`, per
 * ADR-0010's own "redirect-based … no `script-src`/`form-action` change").
 *
 * `https:` is always accepted — the only scheme a real Midtrans Snap
 * `redirect_url` is ever served on. `http:` is accepted ONLY when this
 * build's own `PUBLIC_AWCMS_ORIGIN` (`src/lib/awcms/toko-origin.ts`) is
 * itself `http:` — this repo's own local/CI stub setup
 * (`scripts/stub-awcms.mjs`'s `redirectUrl` is `http://localhost:<port>/…`),
 * never a real deployment, which always configures an `https:` CMS origin.
 * Anything else — a relative path, `javascript:`, `data:`, a malformed
 * string — is rejected: a shopper's whole browser tab is the one thing this
 * function stands between and an unvalidated string from the network.
 */
import { requireAwcmsOrigin } from "./awcms/toko-origin";

export function isValidGatewayRedirectUrl(redirectUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(redirectUrl);
  } catch {
    return false;
  }

  if (url.protocol === "https:") return true;

  if (url.protocol === "http:") {
    try {
      return new URL(requireAwcmsOrigin()).protocol === "http:";
    } catch {
      return false;
    }
  }

  return false;
}
