---
bump: patch
type: docs
impact: internal
---

# Bun 1.4.4 is the documented root pin (#470)

Bun moved to 1.4.4 in PR #457, but the omnichannel and CRM requirement docs
still stated the root pin as 1.4.3. RUN-BUN-01 is a normative requirement, so
a reader following it would have pinned the old runtime. The affected sentences
now state 1.4.4 (EN and ID). The dated 24 October baselines keep their
historical value, with the post-#457 state added beside them.

- `docs/bun-omnichannel-delivery-realtime.md` and its `.id.md` mirror: the root pin.
- `docs/omnichannel-crm-ui-ux.md` and its `.id.md` mirror: the version baseline.
- `docs/crm-omnichannel-requirements.md` and its `.id.md` mirror: RUN-BUN-01.
