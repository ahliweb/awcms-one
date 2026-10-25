---
bump: patch
type: docs
impact: internal
---

# Reference-only commerce admin redesign under `design/`

Adds `design/redesain-ui-ux-2026-10/`: a commerce dashboard with a channel
filter and a 14-day revenue chart, and an orders screen with status tabs and an
order detail timeline, plus the family analysis. It exists so the commerce
navigation (32 screens in seven sub-groups) and the tenant accent can be
discussed before anything changes in `apps/cms`, which is a subtree of
`ahliweb/awcms`.

- The pages load `apps/cms/public/fonts` and the storefront favicon by relative
  path; no runtime code, build or gate reads the new folder.
