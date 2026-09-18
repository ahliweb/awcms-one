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
  post), `/buletin/konfirmasi`, `/buletin/berhenti` (read `?token=`, call
  confirm/unsubscribe, `noindex, follow`). `robots.txt` disallows the two
  token pages, matching `/pesanan`'s existing precedent for a URL that
  carries a one-time, reader-specific credential.
- No CSP change: the newsletter endpoints live on the same CMS origin
  cart/checkout already call, and `connect-src` is already keyed by that
  whole origin, not by path.
- Flagged, not fixed here: the CMS bakes its confirmation/unsubscribe links
  from FIXED paths (`/newsletter/confirm`, `/newsletter/unsubscribe`) that
  do not match this issue's `/buletin/konfirmasi`/`/buletin/berhenti` — see
  `apps/storefront/README.md`'s "Newsletter" section for the two ways to
  close that gap, both outside this change's own file ownership.
