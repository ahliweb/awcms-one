---
bump: patch
type: docs
impact: internal
---

# Booking revenue slice: owner decisions for #450

Docs only: no code, migration or OpenAPI change, and nothing under `apps/cms/**` is touched. The owner adopted the recommended answer to the four questions #389 left open, recorded as metrics section 3.9 and an "Owner decisions" section of ADR-0045 (English and Indonesian).

- A refund counts when it is decided, not when the reversal leg settles. The Refunds step becomes paid back, refund payable and uncollected balance; the cash reading moves to the labelled by-refund-day view.
- A refund of a taxed order nets the tax companion pro rata, so a full refund gives net 0 and tax 0 instead of a negative net (tax collected is not revenue, IFRS 15.47).
- The retention anchor stays the order's first paid transition.
- Scheduled: the cash view by refund day and the waterfall CSV. Not scheduled: ADR and RevPAN as stored figures (derive at read) and channel or segment slices.
- The waterfall is stated to be an operational sales measure, not statutory revenue (PSAK 72 / IFRS 15), and commission is stated never to be a waterfall step.
- The build is tracked by #478 and starts after the subtree sync that owns `apps/cms/**`. Until it lands, #389's behaviour is the documented interim behaviour.
