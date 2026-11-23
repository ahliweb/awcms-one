---
bump: patch
type: fix
impact: public
---

# Footer column headings are visible in light mode

In light mode the footer column headings ("Ikuti Kami", "Informasi", "Bantuan", "Kanal", the shop name) were `#0f172a` on a `#0f172a` background, a 1:1 contrast ratio, on `landing`, `toko` and the store-footer pages of `berita` (issue #551). `.site-footer-column h2` set `--text-primary` over the on-inverse colour that `.site-footer h2` already declares; the stray `color` is removed, so the headings use `--text-on-inverse` in both colour schemes.

- The axe gate (`aksesibilitas.e2e.ts`) missed it because axe files identical-colour text under `incomplete` (`equalRatio`), not `violations`; the gate now fails on that case too.
- A static test (`footer-kontras.test.ts`) fails when a footer rule colours text with a surface-side token.
- `docs/aksesibilitas.md` (and its Indonesian mirror) records the gap. `apps/cms` is untouched.
