---
bump: minor
type: structure
impact: public
---

# Storefront redesign — news chrome, news home and article

Wave 2 of the 2026-09 redesign (issue #169), building on issue #166's foundation (`docs/ui-ux.md`'s "Design system (2026-09 redesign)" section) — markup/CSS restyling only, no data or behaviour change beyond what is called out below.

- **News chrome**: the date bar (`BilahUtilitas.astro`) is now `--news-bar-bg` (a new, news-only dark token) with a mono date, a static "· WIB" suffix, and — only when the `toko` group is also active — "Ke toko" and "Akun" (reusing `Header.astro`'s own `[data-akun-tautan]` account-link contract). The masthead (`NavBerita.astro`) is set in `--font-serif` with a mono kicker from `identity.description` when the CMS has one. The primary nav's active item gets a 2px `--news-accent` underline (a new, news-only red token — never the CMS-driven brand colour). The "Terkini" ticker (`Ticker.astro`) is now a light band with the label as a red pill carrying a reduced-motion-safe pulsing dot, and each headline truncates to one line.
- **News home** (`HalamanDepanBerita.astro`): a "Headline" tag and Lora typography on the hero block; Lora titles and a sky rubric eyebrow on the 6-card grid (`berita.css`, safe because that file loads only on the news layout). The sidebar's tested Terbaru/Mitra Borneo tabs are kept as-is (see `Sidebar.astro`'s own docblock for why); the always-visible "Terpopuler" section gets a mono, zero-padded 2-digit index. The newsletter card moves onto `.band-inverse`, wrapping the same double opt-in form.
- **Article** (`ArtikelView.astro`): Lora 32px title, a new lede paragraph from `post.excerpt` (no new fetch — the field already existed), decorative byline avatar initials, mono byline dates, `--font-serif` 16px/1.85 body, and a restyled pull-quote (3px `--color-primary` rule, italic, on a subtle background). The "Dengarkan berita ini" player gets a real 4px visual progress bar, wired from the same unit-index numbers `dengar.ts` already tracked. The share row keeps its 44px touch target (this repo's own accessibility floor) and only changes shape from a circle to a rounded square.
- **Deliberately not done**: the mockup's "Produk terkait dari toko" sidebar box — nothing in this app today correlates an article with a set of products, and this issue's own rules forbid adding a new build-time fetch to invent one.

Documented in `docs/ui-ux.md`'s "News chrome, news home and article (issue #169)" subsection (+ Indonesian mirror).
