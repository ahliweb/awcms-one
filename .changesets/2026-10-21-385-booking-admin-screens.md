---
bump: minor
type: content
impact: public
---

# Booking adapter admin screens: closing pass, deposits paging, focus after reload (issue #385, ADR-0045)

Behind the tenant's `booking` feature (a tenant that never turns it on sees no change). The offering-link, deposit-policy, cancellation-policy-version screens, the refund-override dialog and the sidebar entries were delivered in parts by #423, #441, #381 and #382; this closes issue #385 (DoR residual R2) with what a pass over them in a real browser, with real data, found. No migration, route, permission or event.

- **The deposits list no longer stops at 200 rows without saying so.** It is keyset-paged by product name (50 per page) with "Next page" and "First page" links and a visible line while more follow; each row links to that product's cancellation policy versions. The cancellation-policy scope selector keeps its 200-product cap and now says when it is cut. A cursor that cannot be read is the first page.
- **Focus after a reload.** The "this product has no cancellation policy" notice on the links screen and the "refund set" line on the order detail take focus when they appear after the page reloads, so a screen reader reads them and a keyboard user continues from them. A value the browser-side check refuses is marked `aria-invalid`, tied to its error and focused.
- **Screens that were rendered by markup no stylesheet covered:** the link filter (three links jammed together, the current one visible only to assistive technology) is the shared segmented control; the deposit kind radios no longer render as stretched text fields; labels sit with their controls in the link, scope and draft forms; stacked tables at 360px keep their caption and their empty states readable; a window added to or removed from the draft editor keeps keyboard focus in the form. Required fields say "(required)" in the label.
- **Real-browser evidence.** `apps/cms/tests/e2e/admin-commerce-booking.e2e.ts` turns the feature on, seeds the rows and drives the screens by keyboard: axe (no critical or serious finding) in both themes at 360px and 1280px, no sideways scroll, the confirm dialog (no raw browser dialog), the override dialog refusing an amount above what was paid and returning focus on Escape, the sidebar entries absent while the feature is off. The server's own refusal of such an amount (`409 REFUND_EXCEEDS_PAID`) stays covered by the route integration suite.
- **Client asset budget** raised to 489,900 B, measured 489,891 B on the build (487,529 B on the `main` it was branched from): +2.4 kB of script and stylesheet for the above. The arithmetic is in the docblock of `APP_BUDGET_BYTES`.
- The override dialog stays on the booking panel of the order detail: Booking's own reservation screen cannot know the amount paid and must not import commerce (documented in ADR-0045 and the UX spec, section 11.5).
