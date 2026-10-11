---
bump: patch
type: fix
impact: internal
---

# Fix: campaign `audience.levels` failed to bind

A campaign's `audience.levels` filter bound its JS array as a bare parameter, so any non-empty price-level selection failed with "insufficient data left in message" on both preview (`countCampaignAudience`) and dispatch (`resolveCampaignAudiencePage`). It is now bound as a typed text array and cast to `int[]`, with an integration test covering one and several levels (#402).
