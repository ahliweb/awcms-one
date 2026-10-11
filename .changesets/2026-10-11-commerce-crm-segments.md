---
bump: minor
type: content
impact: public
---

# CRM segments: versioned rules, preview and evaluation (issue #360)

A tenant can now define a named customer segment from a closed rule vocabulary, count how many customers match, and — with permission to read customers — list or export them. This is Wave B item 7 of epic #280 (PRD stories S1, S2, S4; outcome M7), allowed under the ADR-0040 D7 commerce-only carve-out, and it is **behind a new per-tenant `segments` feature that defaults OFF**: a tenant that never opens Features sees no change.

Why the design is what it is (ADR-0042): a segment turns a rule into a list of people, so the risks are disclosure and evaluation cost. Rules are a closed, versioned JSON vocabulary mapped to fixed parameterised SQL templates (no client SQL, no free strings, bounded depth/nodes/windows); membership is derived on demand and **never stored**; versions are immutable at the database and a delete keeps every version a past consumer recorded; every evaluation is bounded (5 s statement timeout, per-tenant and per-actor concurrency, page and export caps) with stable refusal codes.

- Migrations `sql/1001`–`1004`: `awcms_commerce_segments` and `awcms_commerce_segment_versions` (FORCE RLS, composite FKs, immutability trigger, no UPDATE/DELETE for the app role on versions), one partial covering index on `awcms_commerce_orders`, seven permission keys, worker grants.
- Seven resource-split permissions: `commerce.segments.{read,create,update,delete}`, `commerce.segment_previews.read` (count only, no customer permission), `commerce.segment_members.{read,export}` (each also requires `commerce.customers.read`). Existing tenants do not gain them retroactively.
- New endpoints under `/api/v1/commerce/segments`: list/define, get/rename-and-version/retire, `preview`, `{id}/members`, `{id}/export.csv`. A count under five is withheld; the as-of instant is the server's; walk-in, blocked and erased customers are never members; consent stays independent of membership.
- Admin screen `/admin/commerce-segments` and a *Customer segments* toggle under Features; sidebar entry hidden while the feature is off.
- Measured on 100,000 customers (about 250,000 paid orders): preview p95 between 0.3 s and 1.2 s against the 3 s target (M7).
- Not built here: wiring a segment into a loyalty program version (#361) or a campaign audience (#362), booking-derived fields (after Wave C), domain events.
