---
bump: minor
type: content
impact: public
---

# Booking: an offering link can name the room(s) it sells (issue #437)

A tenant that sells several room types from separate resources of one booking mode no longer shows every type under every offering. An offering link can now name the Booking resource(s) it sells, and the `toko` storefront's `/booking` offers a bound offering only with its own resource(s). **A tenant that changes nothing sees no change:** a link with no resource named, which is every link made before this change, keeps offering the tenant's active resources of the matching booking mode, exactly as before.

- **Migration `1050`**: the child table `awcms_commerce_booking_offering_link_resources` (composite tenant foreign keys to the link and to the Booking resource, FORCE RLS, no `UPDATE` or `DELETE` for the application role, worker `SELECT, DELETE` for the retention engine). A child table rather than a column because the offering link stays frozen by its guard trigger and one offering can sell several rooms (at most ten).
- **`POST /api/v1/commerce/booking/offering-links`** takes an optional `resourceIds`; each id must be a live resource of the tenant (`404 RESOURCE_NOT_FOUND`, the same answer for unknown, another tenant's and deleted), active (`409 RESOURCE_NOT_ACTIVE`) and in the booking mode the offering needs (`409 RESOURCE_MODE_MISMATCH`). The link body of create, get, list and unlink gains `resourceIds`. OpenAPI and the API reference are updated in the same change.
- **Storefront**: `GET commerce/storefront/booking/offerings` lists only a bound link's live resources (a bound link whose resources are all inactive is not listed, never the whole pool), `availability` for a resource the link does not name is the neutral `404`, and the hold on one (storefront or staff) is refused with `404 RESOURCE_NOT_FOUND` before anything is written.
- No new permission, event, price, deposit or cancellation behaviour. To change a binding, unlink and link again. Docs: ADR-0045 implementation notes, the data-model page (section 4.1a), `docs/skema-basis-data.md`, `docs/kamus-data.md`, `docs/api.md` and the commerce README.
