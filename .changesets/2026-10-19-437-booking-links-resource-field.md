---
bump: minor
type: content
impact: public
---

# Booking links screen: the resource(s) an offering sells (issue #437)

`/admin/commerce-booking-links` takes an optional "Resource IDs" field (the room type this offering sells: up to ten resource IDs from Booking, Resources, separated by commas; empty keeps the old behaviour of offering every active resource of the same kind) and shows the bound resources in a new "Resources" column ("All active resources" for a link that names none). The server proves every ID; its refusals (`RESOURCE_NOT_FOUND`, `RESOURCE_MODE_MISMATCH`, `RESOURCE_NOT_ACTIVE`, `VALIDATION_ERROR`) each have their own copy in English and Indonesian. The app client-asset budget is raised from 480,800 B to 480,900 B (measured 480,827 B). Spec: `docs/booking-ux-flows.md` section 11.1.
