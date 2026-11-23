---
bump: patch
type: fix
impact: internal
---

# A stale-bearer 401 on checkout, gateway session and review clears the stored session

`createOrder`, `createGatewaySession` and `submitReview` send an optional bearer but sat outside the session-clearing path, so an expired token showed a generic error and stayed in `localStorage`, contrary to the bearer-session rule. Issue #570 routes a `401 UNAUTHENTICATED` of these three calls through the same clearing (`hapusSesi`) as the `akun-klien.ts` calls, only when a bearer was actually sent; guest checkout is unchanged.

- Unit tests per call in `apps/storefront/tests/toko-klien-sesi-401.test.ts`: bearer plus 401 clears, no bearer plus 401 leaves the session, success unchanged.
- The #556 consumer-contract slice now states `session-cleared` for the three 401 cases with evidence in `toko-klien.ts` (it pointed at `akun-klien.ts`, which these calls never went through); the fixture is regenerated.
