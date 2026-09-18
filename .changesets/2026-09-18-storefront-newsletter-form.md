---
bump: minor
type: content
impact: public
---

# Storefront newsletter subscribe form and double opt-in pages (issue #50)

`apps/cms`'s `newsletter` module — an `awcms` module, ADR-0103 in
`ahliweb/awcms`'s own decision log — has shipped anonymous double opt-in
endpoints (`/api/v1/newsletter/{subscribe,confirm,unsubscribe}`) since
increment 2, and the legacy seputarborneo site this platform replaces
had a live subscribe form and admin screen — but this storefront had zero
way for a reader to actually join a list. Migrating without this would be a
functional regression against the site being replaced, not just a missing
nice-to-have.

- `FormBuletin.astro` (`variant: "footer" | "sidebar"`) — an accessible
  subscribe form: labelled e-mail field, a sentence naming double opt-in
  explicitly (PRD §30 forbids a pre-ticked/implied consent), a client-side-
  only honeypot, and an `aria-live="polite"` status region. Not mounted
  anywhere yet — placing it in the site chrome is a separate, parallel
  change (issue #46's A3), so the two changes never touch the same shared
  file at once.
- `apps/storefront/src/scripts/buletin.ts` — the browser-side client, calling the CMS's
  anonymous `/api/v1/newsletter/*` directly (cross-origin, credential-free,
  `PUBLIC_AWCMS_ORIGIN`, the same pattern `toko-klien.ts` established for
  cart/checkout in issue #30) and translating every documented outcome into
  Indonesian copy — the CMS's own response text is English by design (a
  neutral body shared with `awcms-astro`'s deployments) and is never shown
  to a reader verbatim.
- Three pages: `/buletin` (a standalone page for links from an e-mail/social
  post), `/newsletter/confirm`, `/newsletter/unsubscribe` (read `?token=`,
  call confirm/unsubscribe, `noindex, follow`). The two token pages sit at a
  CMS-imposed path, not this app's own naming: `apps/cms/src/modules/
  newsletter/domain/newsletter-mail.ts` bakes every confirmation/unsubscribe
  e-mail from the fixed, non-configurable constants
  `NEWSLETTER_CONFIRM_PATH`/`NEWSLETTER_UNSUBSCRIBE_PATH`, and its own
  `subscribe.ts` docblock says the public site in front of the CMS (this
  storefront) is expected to serve exactly those paths — so this app honours
  that contract directly rather than adding a redirect layer in front of a
  storefront-chosen URL. `apps/storefront/tests/newsletter-path-contract.test.ts`
  guards the two path strings, by file existence and without importing anything from
  `apps/cms`, against a future upstream rename. `robots.txt` disallows the
  two token pages, matching `/pesanan`'s existing precedent for a URL that
  carries a one-time, reader-specific credential.
- No CSP change: the newsletter endpoints live on the same CMS origin
  cart/checkout already call, and `connect-src` is already keyed by that
  whole origin, not by path.
- Documented, not shipped here (an operator action, not code): the CMS only
  composes a confirmation/unsubscribe link pointing at THIS storefront's
  origin — and only grants the CORS access the subscribe form needs at all —
  once that origin is registered and verified in `awcms_tenant_domains`
  (`POST /api/v1/tenant/domains` + `POST .../{id}/verify`). See
  `apps/storefront/README.md`'s "Newsletter" section.

Four fixes from review, all in `apps/storefront/src/scripts/buletin.ts`:

- The subscribe form now runs `checkValidity()`/`reportValidity()` before
  ever calling `fetch()` (the same pattern `checkout.ts` already uses) — a
  malformed address used to reach the network and come back as a CORS-
  opaque failure the reader saw as "could not reach the server".
- `VALIDATION_ERROR`/`RATE_LIMITED` are real route behaviour but effectively
  unreachable from this app's actual, cross-origin deployment (the CMS
  answers both BEFORE classifying `Origin`, with no CORS grant on either —
  the browser's `fetch()` rejects before the body is ever read, landing in
  `NETWORK_ERROR` instead). `NETWORK_ERROR`'s copy no longer asserts a
  connectivity cause, is worded differently for the subscribe form (an
  e-mail address to check) vs. the two token pages (a link to check, no
  address field to point at), and the two now-corrected docblocks say
  plainly that a reader on this app's real deployment will see
  `NETWORK_ERROR`'s message for what is very often really a bad address, not
  a dropped connection.
- `/newsletter/confirm` and `/newsletter/unsubscribe` no longer fire their
  state-changing `POST` on page load. A mail gateway's inbound link-scanner
  routinely fetches and fully renders — executes JS on — every link in an
  incoming e-mail before the reader sees it; an eager POST let the SCANNER
  confirm the subscription or unsubscribe the reader, not a choice the
  reader made. Both pages now ship an inert, `hidden` button in their static
  HTML that `buletin.ts` unhides and wires to a `click` handler only once a
  well-formed token is confirmed present.
- `RATE_LIMITED`'s wait is now read from the response's `Retry-After`
  HEADER. The CMS's own `fail(429, ...)` call never populates
  `error.details` — the wait travels as a header — so the previous
  `details.retryAfter` read always evaluated to `null` in production.
