---
bump: minor
type: content
impact: public
---

# Storefront visitor beacon + optional GA4 (issue #56, A10)

`apps/storefront` sent no telemetry of any kind — the seputarborneo
reference this epic re-platforms from loads GA4 on every page and runs its
own per-IP-per-day counter; this repository's `apps/cms` already carries a
privacy-first, off-by-default `visitor_analytics` module with a public
ingest endpoint (`POST /api/v1/analytics/collect`) that nothing called it.
Without this change, A3's "Terpopuler" section (the module's rollups) would
have nothing real to read once it lands, and there was no way to add GA4
for an operator who wants it alongside.

- `apps/storefront/src/scripts/analitik.ts` — a first-party, privacy-
  respecting page-view beacon mounted on every page. It sends exactly
  `{ tenantCode, path, referrer? }`, verified against the route and its
  module's README rather than guessed, and honours Do Not Track/Global
  Privacy Control by not sending at all.
- **Scope correction, recorded rather than silently followed:** the issue's
  own Scope bullet named `navigator.sendBeacon` (fallback `fetch keepalive`).
  That is backwards for this specific endpoint — `sendBeacon`'s payload
  cannot carry the `content-type: application/json` header the endpoint
  requires cross-origin, a fact `apps/cms`'s own
  `visitor-analytics/domain/beacon-cors.ts` docblock already tested and
  documents. `fetch` with an explicit JSON content-type, `credentials:
  "include"`, and `keepalive: true` is what is actually sent; `sendBeacon`
  is never called. There is also no "viewport class" field in the route's
  validated schema, so none is invented.
- GA4 (`PUBLIC_GA_ID`, optional, off by default) — `BaseLayout.astro` loads
  `gtag.js` only when a real GA4 Measurement ID is configured, and
  `csp.json.ts`/`apps/storefront/server/penyaji.mjs` widen the served CSP's `script-src`/
  `connect-src` for GA's own fixed origins only then. The `dataLayer`/`gtag`
  bootstrap Google's own snippet normally inlines is instead
  `apps/storefront/src/scripts/ga-init.ts`, an ordinary same-origin bundled module — an
  inline `<script>` body is blocked by this app's strict CSP regardless of
  what `script-src` allows, and this static site has no per-request value to
  mint a CSP nonce from.
- Documented: `apps/storefront/.env.example`, `apps/storefront/README.md`,
  and `docs/deployment.md` (+ `.id.md`) gain "the two switches" a deployer
  needs — `apps/cms`'s own `VISITOR_ANALYTICS_ENABLED` (whether anything is
  actually recorded) and `apps/storefront`'s `PUBLIC_GA_ID` (whether GA4 is
  additionally on) — independent of each other, both off by default.
