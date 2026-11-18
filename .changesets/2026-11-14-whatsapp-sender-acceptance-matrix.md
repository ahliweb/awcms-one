---
bump: patch
type: docs
impact: public
---

# Cross-provider WhatsApp acceptance matrix and staging runbook (issue #466, template side)

The template-side half of the tenant-configurable default WhatsApp provider acceptance work. No product code, migration or setting changes.

- `tests/template-tanpa-starsender.test.mjs` proves the template never selects StarSender or ships a provider key: no env example or compose file sets `WHATSAPP_PROVIDER=starsender` or `WHATSAPP_STARSENDER_ENABLED=true`, `template:init` for each of the three build profiles leaves the same true, and the neutral seed profiles name no provider and no real number.
- `apps/cms/tests/integration/commerce-whatsapp-sender-matrix.integration.test.ts` (needs `DATABASE_URL`) drives commerce's `upstream` mode through a mock provider: the sender is pinned on queued rows across a default switch, an unusable or switched-off default is refused with no reroute, another tenant's sender id is refused, and events and audit carry the masked recipient only. `apps/cms/tests/commerce-whatsapp-sender-matrix.test.ts` pins the pure side (a refusal is returned, commerce passes no sender and names no provider).
- `docs/deployment.md` (and its Indonesian mirror) gains the staging runbook: StarSender risk acknowledgement, enrolment, token rotation, disable and rollback, manual Meta selection and fail-closed behaviour. Campaign multi-sender rows stay pending on #458.
