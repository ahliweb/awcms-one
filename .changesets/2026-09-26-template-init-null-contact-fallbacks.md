---
bump: patch
type: fix
impact: public
---

# `template:init` no longer leaks BjekMart's own phone number and address

Omitting `--kontak-telepon`/`--alamat` from `template:init` left
`DEFAULT_IDENTITY.contactPhone`/`.address`
(`apps/storefront/src/config/site.ts`) as BjekMart's own real phone number
("0851-…") and street address — `mergeSiteIdentity()`'s fallback then
published them, live, on every derived deployment's footer, its landing
contact section, and `/kontak`, whenever the CMS itself had nothing
configured for those fields (issue #233, found in production pre-cutover
checks for `ahliweb/omes-web`, fixed there in `ahliweb/omes-web#8`).

- `DEFAULT_IDENTITY` is now typed `{ contactPhone: string | null; address:
  string | null; ... }`, and `tools/template-init/rewriters.mjs`'s
  `rewriteSiteTs()` writes the bare `null` literal for whichever of the two
  fields its matching flag omits — never leaving BjekMart's own value in
  place. When a flag IS given, behaviour is unchanged: the value is written
  verbatim.
- `apps/storefront/src/pages/kontak.astro`'s "Alamat" contact card, the one unconditional
  consumer found by grepping every reader of `identity.address`/
  `.contactPhone`, now renders only `{identity.address && (...)}` — the
  same guard `Footer.astro`, `FooterBerita.astro`, and `profil/landing/
  Beranda.astro` already had. No other BjekMart-specific contact surface
  (WhatsApp number, maps embed, social links, e-mail) was found to leak the
  same way: `whatsappNumber`/`mapsEmbedUrl`/`socialLinks` have no
  `DEFAULT_IDENTITY` fallback at all (CMS-only, `null`/empty otherwise), and
  `contactEmail` is always rewritten because `--kontak-email` is a required
  flag.
- `tests/template-init.test.mjs` asserts the null-write directly (both via
  a full `template:init` run without these flags, across all three
  profiles, and via a focused unit test of `rewriteSiteTs`), and that
  giving the flags still writes them verbatim.
  `apps/storefront/tests/kontak-fallback-null.test.ts` is a new real
  `astro build` smoke test proving `/kontak` and the footer render with no
  address/phone block — and no literal `"null"` — when both the CMS and
  `DEFAULT_IDENTITY` have nothing for either field.
