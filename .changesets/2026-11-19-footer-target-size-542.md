---
bump: patch
type: fix
impact: public
---

# Footer links meet the WCAG 2.2 minimum target size

The footer links of every profile (`toko`, `berita`, `landing`) were about 20 px tall, below WCAG 2.2 SC 2.5.8 (Target Size, Minimum), for example "Pasang di Layar Utama" (issue #542). Each footer link is now at least 24 px tall, through a new `--target-min` token used by `.site-footer a` and `.footer-berita a`; the columns, wording and colours are unchanged and nothing moves for a visitor except slightly more room between lines of links.

- The whole-page axe scan of every key page (`aksesibilitas.e2e.ts`) now uses the WCAG 2.2 AA tags and passes on all three profiles.
- `docs/aksesibilitas.md` (and its Indonesian mirror) states the real state.
- `apps/cms` is untouched.
