---
bump: minor
type: content
impact: public
---

# Booking pages for the `toko` storefront (`/booking`, `/booking/pesan`, `/akun/reservasi`)

A shopper can now search a stay, see the server's nights, price, deposit and balance, hold the room with a countdown, hand off to payment through the existing gateway session, and see their own reservations. Closes #386 (epic #280, Wave C).

- **Pages, `toko` profile only.** `/booking` (service, two date inputs, guest count, a quote panel; "Penuh" when no resource is free), `/booking/pesan` (the hold, a countdown from the server's clock, the expired and confirmed states, the payment handoff: gateway deposit, balance or full session, or `/pesanan` for a manual tender) and `/akun/reservasi` (own reservations behind the bearer session; a `401` clears it). Static (`output: "static"`, no `prerender = false`); `berita` and `landing` build none of the pages and link to none; the derived CSP is unchanged.
- **Four CMS reads, no migration.** `GET commerce/storefront/booking/offerings`, `.../availability` (the anonymous `BookingPort.availability` of contract 1.1.0: validated and bounded, rate limited, `no-store`, an allow-listed body with no PII and no resource name, one `404` for any offering that is not sold), `.../quote` (nights, total and deposit from the same quote the hold re-checks) and `GET .../reservations` (the bearer's own list, keyset). All sit behind the tenant's `booking` feature (off = the neutral `404`). Every reservation body gains `serverNow`, so the countdown never trusts the device clock. This resolves the "availability needs U1, deferred" note of #380.
- **Known limitation.** The offering link carries no resource, so `offerings` lists the ids of the tenant's active resources of the right booking mode and the page probes them in turn; a tenant selling several room types from separate resources of one mode would see every type under every offering. The fix (a nullable `resource_id` on the link, migration `1050`) is recorded in ADR-0045 and not built here.
- **Not here.** Cancellation and refund (#381), reschedule, no-show, check-in, a calendar grid, a hold extension (the CMS has no endpoint), and a header link (`PROFILE_NAV` stays as it was; a deployment that sells stays adds one line).
- **Rollback.** No schema change: revert the commit. A tenant that never enables the `booking` feature sees no difference (the three routes answer "Pemesanan tidak tersedia", and the reads are the neutral `404`).
