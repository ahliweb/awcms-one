---
bump: patch
type: fix
impact: public
---

# Sync `apps/cms` with upstream awcms `8e9bce0c` (CMS image Debian CVE fix)

`apps/cms` is synced from upstream `2d29a446` to `8e9bce0c` (28 commits, issue #260), merged with a merge commit.

- **Security:** `apps/cms/Dockerfile.production`'s `base` stage now applies Debian security upgrades (awcms#840). This closes three CRITICAL, fixed-upstream `perl-base` CVEs in `oven/bun:1.4.2`: CVE-2026-13221, CVE-2026-42496 and CVE-2026-8376 (awcms#833). Without it, `release:images --publish` failed closed on trivy.
- **Security:** `ssrfSafeFetch` now passes a 304 Not Modified through instead of rejecting it as a broken redirect (awcms#857).
- **New upstream admin screens:** the OMES Control Center, with migrations `sql/159`–`sql/167`. Run `bun run db:migrate` on deploy. Commerce migrations stay at `901`–`934`.
- **Fixes:** admin topbar, legal-hold form, and long unbreakable text no longer overflow at 1024px and 360px.
- **Dependencies:** astro 7.3.5, @astrojs/node 11.1.6, prettier 3.9.9, prettier-plugin-astro 1.1.0, yaml 2.9.1. This repo's 21 commerce admin screens were reformatted for the new plugin, with no behaviour change.
- **Asset budget:** the admin client asset budget rises to 288,500 B, measured on the merged build.
