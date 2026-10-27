---
bump: minor
type: content
impact: public
---

# Storefront: opt-in notification settings, a push-only service worker and safe sign-out

[Issue #431](https://github.com/ahliweb/awcms-one/issues/431), the storefront half of [ADR-0048](../docs/adr/0048-customer-web-push-identity-subscription-and-cross-origin-contract.md), stacked on the subscription APIs of #430. A signed-in shopper can now turn on order, payment and support notifications for their own browser, see and remove their devices, and sign out without leaving a subscription behind. **Nothing is on by default and nothing is sent yet:** the feature needs the new build flag `PUBLIC_CUSTOMER_PUSH` (off, `toko` profile only) *and* the tenant's `customerPush` feature in the CMS (off: the neutral `404`, the control is hidden); sending is #432; production activation stays gated by counsel's review of the consent wording and physical-device UAT (ADR-0048 D8).

The "why" of the shape: a service worker is the one artefact the storefront deliberately kept out of every shopper's browser, so shipping one is an explicit per-deployment build decision, and the worker is held to push-and-click only. Customer push needs a worker on the storefront origin because the CMS origin's worker cannot serve it and a worker is never registered cross-origin.

- New page `/akun/notifikasi` (Indonesian, `noindex`, not in the sitemap or navigation) and a card on `/akun` that stays hidden until the CMS reports the capability. States: signed out, feature off (hidden), blocked or unverified account, server not configured / origin not supported, unsupported browser or web view, iPhone Safari tab (Add to Home Screen guide for iOS 16.4+), permission denied (how to re-enable), opt-in, active. Consent is explicit and per purpose, nothing ticked by default, with the consent text and its version (`draft-2026-10`, a draft) shown; the page refuses to enrol against a version it has no text for. The browser permission prompt only ever starts from the "Aktifkan Notifikasi" click.
- One service worker, `/sw-notifikasi.js` (scope `/`, `max-age=0`): shows the generic title and body of the payload, opens only `/akun`, `/akun/pesanan` or `/akun/pesan` on its own origin; no `fetch` handler, no cache, no network, no token, no icon from the payload. No CSP change.
- Sign-out and login over a stored session now revoke on the server before the stored session is cleared or replaced when the browser is enrolled; an unconfirmed sign-out is shown with a retry and an explicit "Keluar di perangkat ini saja" instead of clearing silently. A browser that never enabled notifications behaves exactly as before.
- Every error code of the push routes has an Indonesian message and a next action (device limit moves focus to the device list; `Retry-After` is shown when the browser can read it).
- `tests/storefront-tanpa-service-worker.test.mjs` is amended on purpose: from "no service worker in the storefront" to "exactly this push-only one, nothing else". New unit, build-smoke (all three profiles, flag off and on) and Playwright tests; the e2e replaces the browser's push stack with a mock and runs on the trusted host. `compose.production.yaml` now passes `PUBLIC_INSTALL_HELP` (which it was missing) and `PUBLIC_CUSTOMER_PUSH` as build arguments; the storefront Dockerfile declares the latter.
- Docs (English and Indonesian): `ui-ux`, `template`, `deployment` (flag and activation checklist), `pengujian` (evidence and the UAT gate), `arsitektur`, `status`, ADR-0048's implementation record, ADR-0049 D2, the storefront skill.
- A notification click focuses and navigates only a window already under `/akun`; any other open tab of the store (checkout, a product page) is left alone and the target opens in a new window.
