---
bump: minor
type: structure
impact: public
---

# Customer account resource endpoints — addresses, wishlist, orders, reviews (C3)

Issue #91 (part of epic #32, C3; contract #86/ADR-0016). Built on #87's schema and
#89's bearer sessions, the storefront's account holders can now manage their own
data through eight `/api/v1/commerce/storefront/account/*` routes, all
`requireCustomerSession`-secured:

- `addresses` (`GET`/`POST`), `addresses/{id}` (`PATCH`/`DELETE`),
  `addresses/{id}/default` (`POST`) — max 10 live addresses, the first ever saved
  becomes the default automatically, and exactly one default per customer is now a
  DATABASE invariant (`apps/cms/sql/920_awcms_commerce_customer_addresses_default_index.sql`'s
  partial unique index), not merely an application one.
- `wishlist` (`GET`/`PUT`), `wishlist/{productId}` (`DELETE`) — `PUT` union-merges
  up to 200 product ids and returns the merged list; an id that is not a live
  product in the caller's own tenant is silently skipped, never a 400.
- `orders` (`GET`, keyset) and `orders/{orderCode}` (`GET`) — bounded to
  `created_at >= account.historyFrom` (ADR-0016 D4) and, for the detail route,
  ownership, both enforced INSIDE the query.
- `reviews` (`GET`) — the account's own submitted reviews.

The two existing anonymous routes, `POST .../storefront/orders` and
`POST .../storefront/reviews`, now accept an OPTIONAL bearer: present and valid,
the order/review is attributed to that account's own customer row instead of the
guest phone lookup; present but invalid/expired, `401 UNAUTHENTICATED` explicitly;
absent, unchanged. `POST .../orders` also accepts `affiliateCode` in the body —
shape-validated only in this issue, ignored until #92 wires attribution.

Removed from `ROUTE_PARITY_EXEMPTIONS` (`apps/cms/scripts/api-spec-check.ts`)
accordingly; only the C4 affiliate paths remain contract-only.
