---
bump: minor
type: dependency
impact: internal
---

# apps/cms synced to ahliweb/awcms 8c64528d — the admin chrome restyle

Issue #170's upstream half landed as awcms PR #813 and is pulled in here with a
`git subtree pull` merged by merge commit (AGENTS.md, "The subtree embed"). The
admin gains the 2026-09-21 redesign's chrome without any local patch to
upstream files: a dark sidebar rail on a new `--color-sidebar-*` token family
(the mockup's faint text corrected to clear WCAG AA), a brand tile + tenant line,
count-badge and status-card slots, and shared primitives every screen can use —
`.admin-stat-card`, `.admin-status-pill[data-tone]`, `.admin-segmented`,
`.admin-bulk-bar`, `.admin-two-pane`, `.admin-toggle`, `.admin-timeline`,
`.admin-media-grid`. Issue #171 re-composes this repo's own commerce screens on
them.

- Conflicts resolved by keeping both sides: `requiredFeature` (#118) and
  upstream's new `badgeCount` on sidebar entries; `client-asset-budget.ts`'s
  app budget is this repo's 246,500 plus upstream's +8,000 chrome delta.
- AGENTS.md's "Known local divergences" list now records the three
  divergences this sync surfaced (AdminLayout/sidebar model, admin-screens.css,
  the asset budget) beside the original version-check patch.
