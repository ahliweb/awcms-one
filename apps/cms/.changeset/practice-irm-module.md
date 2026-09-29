---
"awcms": minor
---

feat(practice-irm): add practice-irm module — 5-domain content + practice sessions (Issue #270, IRMbyDUS)

Genuinely new module (no IRM/practice content model existed anywhere in `apps/cms` before this PR — ADR-0002 in `web-irmbydus.com`):

- **`awcms_practice_irm_domains`** (`sql/940`) — the five canonical IRM domains (identify/neutralize/navigate/embed/reinforce) as admin-editable CMS content, tenant-scoped, RLS tenant-isolation only. `web-irmbydus.com` renders whatever this module returns and holds no independent copy of a domain's terminology — the mechanism ADR-0002 names for preventing "IRM terminology drift" (PRD Major Risks table). "Delete" resets a domain back to the built-in default copy (never leaves it blank), the same convention `awcms_commerce_store_settings` established. Admin CRUD (`practice_irm.domains.{read,create,update,delete}`), admin screen at `/admin/practice-irm-domains`.
- **`awcms_practice_irm_sessions`** (`sql/941`) — the 12-field guided-journal record from PRD §16 (situation/emotion/intensity/body/automatic_thought/meaning/neutralize/post_intensity/navigate/embed/reinforce/reflection), owned by a `commerce` customer (`owner_customer_id`) and a `commerce` product (`product_id`, recording which entitlement unlocked it). `intensity`/`post_intensity` are plain integers with a database `CHECK (… BETWEEN 0 AND 10)` constraint and **no derived scoring/classification logic anywhere** (PRD's Explicit Non-Goals explicitly forbid clinical scoring/psychological profiling) — guarded by a static source-scan test against future drift, not just current correctness.

Every session create/read/update/complete calls `commerce`'s `verifyEntitlement(ownerCustomerId, productId)` **first, live, no cache** — a customer without an active entitlement for the given product gets `403 ENTITLEMENT_REQUIRED` and never sees practice content or the ability to log a session, including history (a revoke cuts off access on the very next call). Owner-scoping is application-level, the same way `commerce-entitlement-directory.ts` already does it (ADR-0016 D1: no `app.current_customer_id` session variable exists in this system) — `owner_customer_id` is read only from the verified `commerce` customer bearer session, never accepted from request input.

**There is deliberately no tenant-staff read path into a customer's sessions** — no admin permission, no admin route, no admin screen (PRD's "Journal leakage" Critical risk, mitigated by the content simply never being exposed to a tenant-staff surface).

New endpoints:

- `GET/POST /api/v1/practice-irm/domains`, `GET/PUT/DELETE /api/v1/practice-irm/domains/{domainKey}` — admin
- `GET /api/v1/practice-irm/storefront/account/content?productId=` — the five domains' content, entitlement-gated, bearer session
- `GET/POST /api/v1/practice-irm/storefront/account/sessions`, `GET/PATCH /api/v1/practice-irm/storefront/account/sessions/{id}`, `POST .../sessions/{id}/complete` — customer session CRUD, bearer session

Depends on `commerce` (structural — both FK columns on `awcms_practice_irm_sessions` reference `commerce`'s own tables). `program-21day` (ADR-0002's second module) is out of scope for this PR.
