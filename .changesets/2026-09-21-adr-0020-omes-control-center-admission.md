---
bump: patch
type: docs
impact: internal
---

# ADR-0020: the OMES Control Center admission ADR

Records the trust and ownership boundary between AWCMS-one, `ahliweb/omes`, and Hermes for epic #146 (the OMES Control Center): the ownership matrix reproduced from `ahliweb/omes`'s own *docs/control-center-contracts.md* §1, the pinned-and-fail-closed contract (`contracts/control-center/v1/**` vendored at `ahliweb/omes` commit `e4e94ea92067df91b04b08d987a106c8ee977e79`), the outbound pull-worker transport this repository's server side will consume once `ahliweb/omes#192` lands, the `omes_control` module's admission as an isolated domain module (never a fourth `commerce` area), evidence-only capability rendering, standards-alignment (not certification) language, and explicit non-goals.

- No code lands with this change — `apps/cms/src/modules/omes-control/` is created by issue #152; this ADR is the reviewed contract its children (#152–#158) build against.
- `docs/arsitektur.md`/`.id.md` gain a short pointer section stating plainly that nothing exists yet.
- Issue #155 (operation submission / worker-result ingestion) is recorded as blocked on `ahliweb/omes#192`, which is still open.
