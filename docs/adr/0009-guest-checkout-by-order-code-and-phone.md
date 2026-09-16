🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0009-guest-checkout-by-order-code-and-phone.id.md)

# ADR-0009 — Guest checkout, addressed by order code + phone; customer accounts come later

- **Status:** Accepted
- **Date:** 16 September 2026
- **Decision maker:** ahliweb
- **Related:** [ADR-0007](0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md); issues #29, #30, #32

## Context

mart.borneojek.com requires an account to check out (register, verify e-mail, login) and offers a dashboard. Building accounts first means building session issuance, CSRF, password reset and e-mail verification in the storefront's runtime surface before a single order can be placed.

| | Accounts first | Guest checkout first (**chosen**) |
| --- | --- | --- |
| Security surface | passwords, sessions, reset tokens, verification links, CSRF — all in the first runtime increment | no password store, no session store; the order code + the phone that placed it are the credential for tracking |
| UX | a registration wall before the first order (the live site's largest drop-off point by design) | order in one form; the confirmation page is bookmarkable and reachable again from a WhatsApp message |
| Compatibility | matches the live site | matches the live site's *guest-visible* flow; accounts arrive on the same tables (#32) |
| Long-term | the customer row is born with credentials | `awcms_commerce_customers` is keyed by phone from day one, which is what OTP login needs anyway |

## Decision

Increment 2 ships guest checkout. `awcms_commerce_customers` is created or reused by normalised phone (E.164) at order time and carries no credentials. `GET .../storefront/orders/{orderCode}?phone=` answers a neutral 404 unless the pair matches; the phone check runs inside the transaction, not only in request preparation. Wishlist stays browser-local (`localStorage`). Accounts, synced wishlist/addresses/reviews and the affiliate program are #32, on these same rows.

## Consequences

- A customer who loses both the order code and access to the phone number cannot self-serve tracking; the store's WhatsApp link with the code prefilled is the documented fallback.
- Reviews require a `completed` order for that product and are moderated (`pending` → `published`/`rejected`) before publication.
- The 8 tables this decision creates (`awcms_commerce_{customers,customer_addresses,orders,order_items,order_events,payment_confirmations,reviews,wishlists}`) are `unreachableBySubject: true` in the module's data-lifecycle/subject-data descriptors — a guest identified only by a typed phone number has none of the staff-side identity concepts (`tenant_user`/`identity`/`profile`/`principal`) that codebase's subject-data vocabulary is built around; a genuine erasure/export request is handled as an ordinary admin lookup instead.
