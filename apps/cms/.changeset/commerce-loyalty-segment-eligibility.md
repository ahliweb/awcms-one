---
"awcms": minor
---

feat(commerce): loyalty program eligibility by CRM segment (Issue #361, epic #280)

`awcms_commerce_loyalty_programs` gains `eligibility_segment_id` / `eligibility_segment_version` (`sql/1005`): both NULL = every customer earns; set together, composite FK to `awcms_commerce_segment_versions`, immutable once the program leaves draft (trigger). `earnPointsForPaidOrder` applies the restriction only while the tenant's new `loyaltySegments` feature (default OFF) is on: the version in force at `paid_at` decides (ADR-0026 D3/D5 unchanged), membership of one customer is evaluated by the same fixed templates narrowed to that customer as of `paid_at`, a replay of an order that already earned skips the check, and walk-in/blocked/erased customers never earn. Program create/edit accept `eligibilitySegmentId`/`eligibilitySegmentVersion` (needs `loyaltySegments`, `segments` and `commerce.segments.read`; `422 SEGMENT_NOT_FOUND`); the Loyalty admin screen gets a segment picker and an Eligibility column. ADR-0042 amendment.
