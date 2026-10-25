---
bump: patch
type: docs
impact: internal
---

# AGENTS: record the 490,000 B client asset budget set by the #482 integration

The standing-divergence entry for `apps/cms/scripts/client-asset-budget.ts` in `AGENTS.md` (and its Indonesian mirror) stopped at the #452 sync's 487,700 B. The #482 integration of #454, #455, #456 and #474 on top of the #457 sync raised `APP_BUDGET_BYTES` to 490,000 B (measured 489,973 B on the merged build); the constant's docblock already says so, and the divergence list now does too, so the next subtree sync resolves the conflict against the current figure. Docs only; no code, gate or budget value changes.
