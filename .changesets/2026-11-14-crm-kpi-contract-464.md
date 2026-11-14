---
bump: patch
type: docs
impact: public
---

# A versioned CRM KPI contract awaits owner sign-off before any projection code

Issue #464, docs only. `docs/crm-kpi-contract.md` (with its Indonesian mirror) specifies the lead funnel from `crm_leads` stage categories, conversion from the verified commerce facts of #463, first-touch campaign attribution with a lookback, staff first-response SLA in business minutes, denominators, zero-denominator and small-cell suppression, the no-PII rule, formula-safe CSV exports, and a proposed set of response shapes that is deliberately **not** added to the OpenAPI document (route parity is untouched). Its section 11 is the owner sign-off checklist that gates every projection, route and dashboard. `docs/README.md` and `docs/status.md` link it and list the projections and the dashboard as not here yet. No code, migration, endpoint or screen changed.
