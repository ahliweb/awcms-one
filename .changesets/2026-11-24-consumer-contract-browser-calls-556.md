---
bump: minor
type: structure
impact: internal
---

# Freeze the storefront's browser calls as a consumer contract

Issue #556 extends the frozen consumer-contract slice of #555 (ADR-0058 D2, audit F-01) from the storefront's build-time reads to the operations it calls in the browser. `apps/cms` and `apps/storefront/tests/fixtures/` are untouched.

- `tests/fixtures/storefront-consumer-contract.json` (schema version 2) gains 53 `phase: "browser"` operations from `apps/storefront/src/lib/**` and `src/scripts/**`: 49 `kirimPermintaan` calls, the three newsletter calls and the page-view beacon. Per profile: `toko` 53, `berita` 4, `landing` 1.
- Responses keep the additive-superset rule. Request bodies and parameters follow the reverse rule: the provider must keep accepting what the storefront sends, so a new required field or parameter, a removed property or a narrowed type, enum, format or bound fails the gate.
- Each browser operation records its auth, the query and header parameters it sends, its Idempotency-Key behaviour and its negative cases (`204`, `401`, `404`, `409`, `429`) with evidence in the storefront source. A `429` the bundle does not declare is marked pending upstream (awcms#1385, issue #557), not invented.
- The source scan fails on a new `kirimPermintaan` call, a new direct transport, any other `fetch`, `sendBeacon` or `XMLHttpRequest` in the storefront source, and a bearer call that left the session-clearing wrapper.
- The two payment-proof upload operations send a body that the bundle does not declare; they are named in `REQUEST_BODY_UNDECLARED`, and the gate fails when the bundle starts declaring it so the exemption cannot go stale.
- Mutation tests prove each new check can fail. Docs: the audit report and `docs/pengujian.md` (with Indonesian mirrors).
