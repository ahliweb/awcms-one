/**
 * GA4's `dataLayer`/`gtag` bootstrap (issue #56, A10) — the second half of
 * Google's own two-tag snippet, as an ordinary same-origin bundled module
 * rather than the inline `<script>` Google's docs normally show.
 *
 * ## Why this is not inline
 *
 * `BaseLayout.astro`'s `<head>` loads `gtag.js` itself from
 * `https://www.googletagmanager.com`, an origin `src/pages/csp.json.ts`'s GA
 * branch widens `script-src` for. Widening `script-src` with a host-source
 * permits loading a script FROM that origin; it grants nothing to an inline
 * `<script>` body, which this app's CSP (`server/penyaji.mjs`) blocks
 * unconditionally — there is no `'unsafe-inline'` anywhere in it, and a
 * fully static, prerendered page has no per-request value to mint a CSP
 * nonce from. Google's own inline bootstrap would therefore silently never
 * run under this app's policy. This file is that bootstrap moved into a
 * same-origin bundled module instead, which `script-src 'self'` already
 * allows with no widening at all — the SAME fix `src/pages/product-labels
 * .css.ts` already applies to a would-be inline `<style>`.
 *
 * ## Why it reads a `data-*` attribute, not `PUBLIC_GA_ID` directly
 *
 * It could — `PUBLIC_GA_ID` reaches the browser bundle exactly like
 * `PUBLIC_AWCMS_ORIGIN` does. It reads `document.body.dataset
 * .gaMeasurementId` instead purely to have ONE place
 * (`src/lib/ga.ts`'s `readGaMeasurementId`) decide "is GA on, and with which
 * id" — the same id `BaseLayout.astro`'s `<head>` block already resolved to
 * decide whether to emit the `gtag.js` tag at all. Reading the env variable
 * a second time here risks a build where Vite/Astro's env resolution
 * disagrees between two separate reads (unlikely, but the whole reason
 * `src/lib/ga.ts` exists as a single validator is to make that class of
 * disagreement structurally impossible rather than merely unlikely).
 */

declare global {
  interface Window {
    dataLayer?: unknown[];
  }
}

/**
 * Google's own `gtag()` shim: pushes its arguments onto `window.dataLayer`,
 * created lazily. Exported so its exact shape is unit-testable without
 * `gtag.js` itself ever loading.
 */
export function gtag(...args: unknown[]): void {
  window.dataLayer ??= [];
  window.dataLayer.push(args);
}

/** `anonymize_ip` is set explicitly per issue #56's own Scope, even though GA4 anonymizes IPs by default (unlike Universal Analytics) — stated, not assumed. */
export function initGa(gaId: string): void {
  gtag("js", new Date());
  gtag("config", gaId, { anonymize_ip: true });
}

if (typeof document !== "undefined") {
  const gaId = document.body?.dataset.gaMeasurementId ?? "";
  if (gaId) initGa(gaId);
}
