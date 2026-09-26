---
bump: patch
type: fix
impact: public
---

# The primary nav is now actually visible above 720px

`Header.astro` (and `NavBerita.astro` on a `berita`-profile page) put the
primary navigation inside a `<details>`/`<summary>` disclosure and relied on
author CSS to show it as a plain horizontal nav above the mobile breakpoint.
That never worked: a *closed* `<details>` hides everything but its
`<summary>` through the UA stylesheet's own `::details-content` rule, which
no CSS on the hidden content's children can override — so the primary nav
was invisible above 720px, in every browser, in all three `SITE_PROFILE`s
(issue #230).

The fix renders the same nav array twice — an always-open desktop
`.primary-nav` and the pre-existing mobile `<details>` copy — and lets
`global.css` show exactly one of the two by viewport width, `display:
none`-ing the other out of the accessibility tree so a screen reader still
meets exactly one "Navigasi utama" landmark. No JavaScript is involved,
keeping issue #24's no-JS mobile-nav design intact.

- A reader on any deployment of this template can now reach every primary
  nav link at desktop width — previously, only the mobile disclosure ever
  worked.
- `apps/storefront/tests/e2e/navigasi-utama.e2e.ts` is new regression
  coverage: at 1440px it asserts the desktop nav is visible and
  keyboard-focusable, and that exactly one "Navigasi utama" landmark is
  accessible at a time; at 360px it asserts the desktop copy is hidden and
  the disclosure toggle still opens the mobile nav. Run for all three
  build profiles.
