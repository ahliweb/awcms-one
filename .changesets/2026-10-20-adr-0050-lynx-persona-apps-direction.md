---
bump: patch
type: docs
impact: internal
---

# ADR-0050: Lynx for separate persona apps, Astro stays

Docs only. ADR-0050 (with its Indonesian mirror) records the approved direction from issue #445: LynxJS/ReactLynx is the preferred candidate for persona apps (customer, courier, driver, partner, warehouse) in separate repositories, while the AWCMS admin and every public profile (`toko`, `berita`, `landing`) stay Astro and the storefront stays static SSG. It is the template-specific elaboration of upstream ahliweb/awcms#1133, with the per-surface table, API boundary, PoC gate and trade-off analysis.

- AGENTS.md, status.md and template.md (and their mirrors) say the direction is approved and Lynx integration is NOT implemented.
- `tests/lynx-direction.test.mjs` guards that no workspace depends on Lynx and no document claims a shipped Lynx client.
