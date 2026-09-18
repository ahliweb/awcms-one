/**
 * GA4 (Google Analytics) is entirely OFF by default (issue #56, A10) — this
 * app's own quality bar is explicit that "no third-party script" ships
 * "unless the issue says so" (root `AGENTS.md`), and issue #56 is the one
 * issue that says so, conditionally. The ONE switch is `PUBLIC_GA_ID`, read
 * at BUILD time: unset, empty, or not shaped like a real GA4 "Measurement
 * ID" and this app ships with no Google origin anywhere — no
 * `<script src=…googletagmanager.com…>`, no widened CSP (`csp.json.ts`).
 *
 * `PUBLIC_`-prefixed deliberately: a GA4 Measurement ID is not a secret — it
 * is broadcast, in plain text, inside the very `<script src>` tag that turns
 * GA on, to every reader's browser. That is the same reasoning
 * `PUBLIC_AWCMS_ORIGIN` already documents (`src/lib/awcms/toko-origin.ts`)
 * for an origin: the value being public by construction is what makes the
 * `PUBLIC_` prefix correct rather than a leak.
 *
 * This module is the ONE place the "is GA on, and with which id" question is
 * answered, because two independent build-time readers must agree on the
 * same answer: `BaseLayout.astro` (whether to emit the `gtag.js` snippet)
 * and `src/pages/csp.json.ts` (whether to widen `script-src`/`connect-src`
 * for it). A validator duplicated in both places is exactly the kind of
 * duplication that drifts — one emitting the tag while the other leaves the
 * CSP unwidened would ship a build that fails, for every reader, in the
 * browser console, with every gate here green.
 */
import { readEnv } from "./env";

/**
 * A real GA4 "Measurement ID": `G-` followed by at least one letter/digit.
 * Google's public docs give no formal grammar beyond the `G-` prefix; this
 * is deliberately permissive about what follows it and strict about the
 * prefix, which is the part that actually distinguishes a GA4 id from a
 * Universal Analytics `UA-…` or Tag Manager `GTM-…` id this app must not be
 * silently pointed at (those need a different snippet entirely).
 */
const GA4_MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]+$/i;

/** `true` for a non-empty string shaped like a GA4 Measurement ID. */
export function isValidGaMeasurementId(
  value: string | undefined | null
): value is string {
  return typeof value === "string" && GA4_MEASUREMENT_ID_PATTERN.test(value.trim());
}

/**
 * The configured GA4 id, or `undefined` when GA is off (unset, empty, or
 * malformed). Never throws: GA is an optional nice-to-have, so a malformed
 * value degrades to "off" the same way an unset `AWCMS_TENANT_CODE` degrades
 * `src/lib/awcms/theme.ts` to the default palette, rather than failing the
 * build over it.
 */
export function readGaMeasurementId(): string | undefined {
  const raw = readEnv("PUBLIC_GA_ID");
  return isValidGaMeasurementId(raw) ? raw.trim() : undefined;
}
