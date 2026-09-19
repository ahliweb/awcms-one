---
bump: minor
type: structure
impact: public
---

# Customer accounts: `/masuk`, `/daftar`, `/akun`, and a bearer client (issue #88, S1 of #32)

`apps/storefront` gains its first customer-facing authentication surface — an e-mail OTP sign-in (`/masuk`), registration (`/daftar`), and a signed-in account shell (`/akun`) — all static (`output: "static"`, no `prerender = false`), calling `apps/cms`'s `/api/v1/commerce/storefront/account/*` routes directly from the browser, per issue #86's contract. No password is ever collected, sent, or stored — matching ADR-0007's "the storefront holds no runtime credential" posture and #86's own D1/D2/D3 decisions (bearer session, no link to the staff `awcms_principals` table).

- A new customer-session store (`apps/storefront/src/lib/akun-sesi.ts`, pure logic in `apps/storefront/src/lib/akun-kontrak.ts`) keeps `{token, expiresAt, account}` in `localStorage` (`awcms-one:akun:v1`), expiring itself on read and dispatching `akun:berubah` on every write.
- A new bearer-aware client (`apps/storefront/src/lib/akun-klien.ts`) reuses the request/envelope plumbing extracted from `toko-klien.ts` into `apps/storefront/src/lib/toko-permintaan.ts` — `toko-klien.ts`'s own public API and behaviour are unchanged.
- `Header.astro` gained a `[data-akun-tautan]` link that swaps to the signed-in shopper's name once a session exists (`apps/storefront/src/scripts/akun-header.ts`).
- `apps/storefront/src/config/routes.ts` gained `login`, `register`, `account`, and four more constants (`accountOrders`, `accountOrder`, `accountAddresses`, `accountReviews`, `accountAffiliate`) for pages S2/S3 build later — their links resolve to a 404 until then, by design.
- `robots.txt.ts` disallows `/masuk`, `/daftar`, `/akun` (the bare `/akun` prefix also covers its future children); all three pages carry `<meta name="robots" content="noindex, follow">`.
- `apps/storefront/scripts/stub-awcms.mjs` implements the `/account/*` OTP/session state machine (fixed code `123456`, a seeded `budi@example.test` account) so this app's own build-smoke and future e2e tests exercise the real request/response shapes rather than a hand-rolled fixture.
