---
bump: patch
type: docs
impact: public
---

# Security policy reconciled with the implemented customer and provider surfaces

`SECURITY.md`/`SECURITY.id.md` still said, under "What is NOT yet true," that
customer accounts do not exist and that there is no session/login attack
surface — stale since increment 4 (epic #32, ADR-0016) shipped OTP-verified
customer accounts and bearer sessions, and increment 5 (epic #33, ADR-0017)
added the Midtrans/WhatsApp/RajaOngkir provider ports. A stale security
policy is worse than a missing one: it tells a reviewer a surface does not
exist when it does.

- `SECURITY.md`/`SECURITY.id.md` now describe five surfaces, not three: the
  authenticated customer bearer-session surface (`Authorization: Bearer`,
  `awcms_commerce_customer_sessions`, `localStorage`-only, the XSS-not-CSRF
  residual risk, OTP rate limits and attempt caps) and the provider/webhook
  surfaces (Midtrans Snap's token-addressed webhook intake, the amount
  guard, the reconcile job, the WhatsApp OTP outbox, RajaOngkir rate
  caching, consent-gated campaigns) join the existing `apps/cms` and
  anonymous-commerce surfaces. "What is NOT yet true" now states plainly
  that customer accounts/sessions exist, and only what ADR-0016 D6 actually
  deferred (identifier change, phone verification) and the ADR-0017
  follow-ups (Xendit, courier tracking) remain undone.
- `CONTRIBUTING.md`/`CONTRIBUTING.id.md` no longer claim `apps/storefront`
  does not exist, and the changeset-backlog bound they quoted is corrected
  from 10 to the current 20 (`packages/gerbang/audit-rilis.mjs`).
- `SUPPORT.md`/`SUPPORT.id.md`'s "no live deployment" note now points at
  `docs/deployment.md` instead of a stale "increment 1" parenthetical.
- `apps/storefront/README.md` no longer claims the affiliate dashboard card
  still 404s — it has linked to a real page since issue #93 (S3).
- Added `tests/status-prosa.test.mjs`, a regression guard asserting the
  retired "customer accounts do not exist" phrasing never returns to either
  language of `SECURITY.md`, and that the bearer-session table/scheme and
  the webhook route family stay named concretely.
