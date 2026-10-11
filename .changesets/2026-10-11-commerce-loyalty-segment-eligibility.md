---
bump: minor
type: content
impact: public
---

# Loyalty programs can be restricted to a customer segment (issue #361)

A loyalty program version can now be restricted to a CRM segment, so only that segment's members earn points under it (PRD L1/S3, Wave B item 9 of epic #280). It is **behind a new per-tenant `loyaltySegments` feature that defaults OFF**, on top of the existing `loyalty` and `segments` features: a tenant that never opens Features sees no change, and with the feature off a program that names a segment pays everyone exactly as before.

Why the design is what it is (ADR-0042 amendment): the ledger rules of ADR-0026 are unchanged — the program version in force at the order's `paid_at` decides, earn stays on `order.paid` through the existing consumer, reversal is untouched. The program records the **segment id and the pinned segment version** (migration `sql/1005`, composite foreign key, immutable once the program leaves draft), so editing or retiring the segment later never changes what a past earn used. Membership of ONE customer is decided with the same fixed templates as a full evaluation, narrowed to that customer, as of the order's `paid_at`; walk-in, blocked and erased customers never earn, and channel consent is neither read nor changed.

- Migration `sql/1005`: two nullable columns, a pair `CHECK`, a composite FK to `awcms_commerce_segment_versions`, a draft-only trigger, a partial index. No grants change.
- API: `eligibilitySegmentId` / `eligibilitySegmentVersion` on `POST` and `PATCH commerce/loyalty/programs` and on every program read; setting one needs the two features and `commerce.segments.read`; `422 SEGMENT_NOT_FOUND` for an unknown, foreign, retired or non-existent segment or version. No new route.
- Admin: the Loyalty screen's create form gains an optional segment picker and the programs table an Eligibility column; a _Loyalty eligibility by segment_ toggle under Features.
- Not built here: booking-originated earn (L2, after X3) and campaign audiences (#362).
