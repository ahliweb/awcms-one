---
bump: minor
type: content
impact: public
---

# A reading-preferences panel on every public page of every profile

The storefront (`toko`, `berita` and `landing`) now carries a small floating button at the bottom-left that opens a "Pengaturan Aksesibilitas" panel (issue #539, ADR-0057). A visitor can choose a larger or extra-large text size, high contrast, monochrome, dyslexia-friendly text (a plain sans font with WCAG 1.4.12 spacing), underlined or highlighted links, and reduced motion, or reset everything. It is a set of display preferences, not an overlay: it never rewrites content, loads no third-party code, makes no request and claims no compliance. The choices live only in the visitor's `localStorage` (`awcms-a11y`) and are never sent to the server.

- A new same-origin classic file `apps/storefront/src/pages/a11y-early.js.ts` applies the stored choices before first paint, so there is no flash; the CSP is unchanged (no inline script or style, no new origin).
- With nothing stored, `prefers-reduced-motion` and the new `prefers-contrast: more` apply through CSS, so a visitor without JavaScript gets them too; high contrast is never applied under `forced-colors: active`.
- The OS reduced-motion rule in `global.css` now stands down once the visitor has an explicit stored choice; the two smooth-scroll calls (`/produk`, `/cari` pagination) and the news ticker's pulse obey the choice.
- At the largest text size, and with dyslexia spacing, on a 360 px phone the layout defects that appeared are fixed: the header search field, the newsletter form's grid column (footer and sidebar), the width of form controls, long unbreakable words and no-wrap buttons. The home slider's secondary button (1.48:1 text contrast, previously masked by the promotional popup in the old axe scan) now uses `--text-primary`. Nothing else changes for a visitor who never touches the panel.
- Only felt while developing: new unit tests (`a11y-preferences`, `a11y-early`, `a11y-css`), build-smoke assertions on every page of every profile, and a Playwright suite (`a11y-panel.e2e.ts`) with axe scans of the panel; `docs/aksesibilitas.md` is updated to the real state. `apps/cms` is untouched and receives upstream's own version through the next ordinary subtree sync.
