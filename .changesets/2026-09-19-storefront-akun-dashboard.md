---
bump: minor
type: structure
impact: public
---

# Customer accounts: addresses, order history, synced wishlist, reviews (issue #90, S2 of #32)

`apps/storefront` gains the rest of the customer-account surface #86 contracted: `/akun/alamat` (addresses), `/akun/pesanan` (order history and an owned-order detail view), `/akun/ulasan` (reviews), and an account-synced wishlist — all static (`output: "static"`, no `prerender = false`), calling `apps/cms`'s bearer-authenticated `/api/v1/commerce/storefront/account/*` routes directly from the browser, continuing S1's pattern (issue #88).

- `apps/storefront/src/lib/akun-klien.ts` gains one function per remaining #86 endpoint: addresses (list/create/update/delete/set-default), the account wishlist (get/union-merge `PUT`/remove), orders (keyset list/detail-by-code), and reviews (list) — every one bearer-only, clearing the local session on `401 UNAUTHENTICATED` like every existing function in that file.
- `apps/storefront/src/lib/wilayah-region-select.ts` is the province/city/district cascading-select wiring extracted out of `checkout.ts`'s original inline code, so `/akun/alamat`'s own form and `checkout.astro`'s new "Pilih alamat tersimpan" saved-address autofill share one region-selection module instead of two drifting copies.
- `apps/storefront/src/lib/pesanan-render.ts` extracts `/pesanan`'s (issue #30) own order-detail rendering out of `pesanan.ts` so `/akun/pesanan?kode=` renders an `Order` identically — `/pesanan`'s own behaviour and tests are unchanged.
- `apps/storefront/src/lib/wishlist-sinkron.ts` is a PURE wishlist-merge function (union by `productId`, earliest `addedAt` wins, capped at 200 items), wired in by `wishlist-akun-sync.ts`: on login the local wishlist is pushed to the account and replaced by the merge of local and server state; while signed in, every heart-button toggle and the `/wishlist` page's own remove action write through to the account; logging out leaves the local copy untouched; a network failure degrades to local-only operation with a shared `aria-live` status region.
- `toko-klien.ts`'s `createOrder` and `submitReview` each gain an OPTIONAL second `bearerToken` argument — every existing anonymous caller is unaffected; `checkout.ts` passes the signed-in shopper's session token so a placed order is bound to their account.
- `apps/storefront/scripts/stub-awcms.mjs` grows per-account addresses/wishlist/orders/reviews storage, seeding the fixture account with two addresses (one default) and two orders — one dated before `historyFrom` to prove the server, not the client, enforces #86's D4 history-window rule.
