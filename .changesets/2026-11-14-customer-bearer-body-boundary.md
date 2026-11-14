---
bump: patch
type: fix
impact: public
---

# Customer-bearer storefront account routes are reachable behind the body-authentication middleware

`apps/cms`'s middleware refuses every body-carrying `/api/` request unless it holds a staff session or a machine credential (`refuseUnauthenticatedApiBody`). A shopper's `cs_` bearer session (ADR-0016) is neither, so the fifteen mutating `customerBearer` operations under `/api/v1/commerce/storefront/account/` (addresses, wishlist, profile `PATCH`, push subscriptions and preferences, conversations and messages, affiliate, logout) were answered `401 AUTH_REQUIRED` before their handlers ran. Handler-level tests and `api:spec:check` never saw it.

- Declared in a new `CUSTOMER_BEARER_BODY_ENDPOINTS` registry (`api-body-auth-boundary.ts`), not in `SESSION_FREE_BODY_ENDPOINTS`: eight of those handlers read the body before their own session check, so exempting them would have opened body parsing to anonymous callers.
- `middleware.ts` authenticates them with the new `refuseUnauthenticatedCustomerBody`: tenant resolved as the storefront routes do, a read-only live-session lookup (`findLiveCustomerSession`, split out of `requireCustomerSession`), `401 UNAUTHENTICATED` carrying the storefront CORS headers otherwise, so the browser can read the status and clear the stored session.
- `apps/cms/tests/customer-bearer-body-boundary.test.ts` holds the registry equal to the OpenAPI `customerBearer` body operations and the route files; a new customer route that is neither registered nor session-free fails the test.
- The DB-backed check (`commerce-customer-auth.integration.test.ts`, `findLiveCustomerSession`) is gated on `DATABASE_URL` and was not executed where this change was written.

AGENTS.md records the new local divergence in `apps/cms` and marks the open finding of the `f0182930` sync as fixed.
