🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0012-first-party-visitor-analytics-with-an-opt-in-ga4-switch.id.md)

# ADR-0012 — Visitor analytics is first-party by default; GA4 is an opt-in switch

- **Status:** Accepted
- **Date:** 18 September 2026
- **Decision maker:** ahliweb
- **Related:** issues #49, #56; `apps/cms/src/modules/visitor-analytics/README.md`; `apps/cms/src/modules/visitor-analytics/domain/beacon-cors.ts`

## Context

seputarborneo.com loads GA4 on every page and, separately, keeps its own per-IP-per-day `counter` table. `apps/storefront` sent nothing at all, which had two consequences: the operator had no traffic figures, and `apps/cms`'s `visitor_analytics` module — privacy-first, off by default, with a public ingest endpoint since its own port — had no caller, so the rollups the "Terpopuler" block wants stayed empty.

## Decision

Every page sends a first-party page-view beacon to `POST /api/v1/analytics/collect`; GA4 is emitted **only** when `PUBLIC_GA_ID` is set at build time.

| | GA4 only (the reference site) | First-party only | First-party + opt-in GA4 (**chosen**) |
| --- | --- | --- | --- |
| Privacy | every reader's page view leaves for a third party by default | nothing leaves the operator's own infrastructure | nothing leaves by default; the operator opts in knowingly |
| CSP | a third-party script/connect origin on every page | none | none by default; the GA origins appear only in a GA build |
| "Terpopuler" | impossible (the storefront cannot read GA) | real, from the module's own rollups | real |
| Operator familiarity | high | GA-shaped reports are missing | both available |

## Consequences

- The beacon uses `fetch` with `keepalive`, never `navigator.sendBeacon`: `sendBeacon`'s payload lands as `text/plain`, which the CMS's own CORS/origin check refuses cross-origin — a failure that module's docblock had already diagnosed and fixed once.
- It sends exactly what the route validates (`tenantCode`, `path`, `referrer?`), carries no cookie or client-side identifier of its own, and stays silent when `navigator.doNotTrack === "1"` or Global Privacy Control is set.
- GA4's bootstrap is an ordinary bundled module, not Google's inline snippet: this app's CSP has no `'unsafe-inline'` and no per-request nonce, so an inline body would never run. Only the `gtag.js` tag itself needs the widened `script-src`/`connect-src`/`img-src`.
- "Terpopuler" ranks by the module's own `pages` report over the last seven days and falls back to "latest" when the module is disabled or answers empty — the fallback is recorded in code, never dressed up as a ranking in the UI.
