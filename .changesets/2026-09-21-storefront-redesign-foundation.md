---
bump: minor
type: structure
impact: public
---

# Storefront redesign foundation — self-hosted type system, tokens, primitives, site chrome

Wave 1 of the 2026-09 redesign (issue #166): everything issues #167/#168/#169 (product, cart/checkout, and account/news-chrome screens) build on, landed on its own so those issues never touch `apps/storefront/src/styles/global.css`'s top-of-file structure or the font vendoring again.

- **Self-hosted type system.** `apps/storefront/public/fonts/` vendors latin-subset `woff2` builds (SIL OFL) of Plus Jakarta Sans (400/500/600/700/800), Lora (400/500/600 + 400 italic), and IBM Plex Mono (400/500) — `@font-face` with `font-display: swap`, `--font-sans`/`--font-serif`/`--font-mono` tokens, and `BaseLayout.astro` preload hints for the three faces above the fold. No Google Fonts, no new CSP origin — every font stays same-origin (`font-src 'self'` unchanged).
- **New design tokens** in `global.css`: an inverse-band surface, soft status colour pairs, a named link colour, a radius scale, and a type scale — each with a `prefers-color-scheme: dark` counterpart. Brand colour is still read from `/theme-tokens.css`, never hard-coded.
- **New, additive CSS primitives**: `.btn`, `.pill`, `.band-inverse`, `.field-label`/`.is-mono`, token-driven 42px form controls, `.stepper`, `.radio-card`, `.segmented`, `.section-title` — every pre-existing class (`.card`, `.cart-count`, `.stock-badge`, …) is unchanged.
- **Site chrome**: a dark utility bar (Lacak pesanan / Berita / Akun saya), a brand-tile wordmark, and a footer "Kanal" column, all profile-gated through `apps/storefront/src/config/profil.ts` exactly like every existing chrome link.

Documented in `docs/ui-ux.md`'s new "Design system (2026-09 redesign)" section (+ Indonesian mirror), with matching updates to `docs/aksesibilitas.md`/`docs/responsif.md` and `apps/storefront/README.md`.
