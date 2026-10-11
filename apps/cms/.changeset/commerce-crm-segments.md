---
"awcms": minor
---

feat(commerce): CRM segments with versioned rules, preview and evaluation (Issue #360, epic #280)

New tables `awcms_commerce_segments` (mutable head: name, description, `latest_version`, `retired_at`) and `awcms_commerce_segment_versions` (one immutable row per version of a closed-vocabulary rule tree) — `sql/1001` schema + guard/immutability triggers + REVOKEs, `sql/1002` one partial covering index on `awcms_commerce_orders`, `sql/1003` seven permissions, `sql/1004` worker purge grants. No table of members: membership is derived on demand (ADR-0042).

Rules are a closed JSON vocabulary (`level`, `has_account`, `has_email`, `customer_since`, `order_count`, `paid_spend`, `last_order_date`, `first_order_date`, `loyalty_balance`; AND / OR / NOT to depth 4) validated by `domain/segment-rules.ts` and mapped to fixed parameterised SQL templates in `application/segment-sql.ts`. Evaluation (`application/segment-evaluator.ts`) is bounded: 5 s statement timeout inside a savepoint (`422 SEGMENT_TOO_EXPENSIVE`), transaction-scoped advisory try-locks (2 per tenant, 1 per actor; `429 SEGMENT_EVALUATION_BUSY`), a 30-per-minute preview throttle, capped pages/sample/export. Walk-in, blocked and erased customers are excluded by the evaluator; a count under 5 is withheld; the as-of is the server's.

New endpoints (all behind the `segments` feature flag, default OFF → `409 FEATURE_DISABLED`):

- `GET`/`POST /api/v1/commerce/segments`, `GET`/`PATCH`/`DELETE .../segments/{id}` (an edit adds a new version and carries `baseVersion`; delete retires and keeps every version)
- `POST .../segments/preview` (`commerce.segment_previews.read`; count only), `GET .../segments/{id}/members` (`commerce.segment_members.read` + `commerce.customers.read`), `GET .../segments/{id}/export.csv` (`commerce.segment_members.export` + `commerce.customers.read`; formula-neutralised, bounded, audited)

`dataLifecycle`/`subjectData` descriptors for both tables (`domain/segment-lifecycle.ts`). Admin: `/admin/commerce-segments`, a sidebar entry, a "Customer segments" toggle in the commerce Features section.
