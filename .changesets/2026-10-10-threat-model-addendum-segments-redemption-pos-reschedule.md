---
bump: patch
type: docs
impact: internal
---

# Threat model addendum: segments, loyalty redemption, POS service context, reschedule and no-show

Closes cross-spec finding X4 (issue #354). `docs/aw-business-platform-threat-model.md` gains flows F8 to F11 with STRIDE tables and controls C-25 to C-41 in the existing control-mapping format, so the Wave B issues (#360 to #363) have threat rows to implement against. The PRD owner answers Q4 and Q6 to Q10 (point value, points-plus-deposit exclusion, refund override, segment vocabulary, reschedule pricing, cancellation windows) are recorded in the decision provenance table and bound to controls.

- Docs only: no module, migration, OpenAPI path or DDL is added; every control is "planned".
- The Indonesian mirror is updated and re-stamped.
