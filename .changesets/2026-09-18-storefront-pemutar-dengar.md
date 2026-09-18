---
bump: minor
type: content
impact: public
---

# "Dengarkan berita ini" — the article read-aloud player

Issue #52. Every article page (never a video post — there is nothing to
read aloud beside a video the reader is already watching) now offers a
player that reads the headline and the body with the READER'S OWN device
voice: `window.speechSynthesis`, `lang = "id-ID"`. No API key, no audio
file built or stored, no request leaving the page — the article text never
travels anywhere except into the browser's own speech engine. Ported from
seputarborneo.com v2.4.0's own player and the contract its `AGENTS.md`
records.

- A reader can play/pause, skip to the previous or next section, stop,
  choose a speaking rate (0.75×–1.5×) and, on a device with more than one
  Indonesian voice, pick the voice. Rate and voice are remembered for the
  next visit.
- The section being read is outlined in the article as it is spoken. The
  highlight is an `outline`/`box-shadow`, never a background or border, so
  the article does not shift under the reader mid-sentence.
- The card is ALWAYS rendered with `hidden`; the script reveals it only
  when the browser really has `speechSynthesis` AND the device has a voice.
  A browser without the API, or a reader with JavaScript off, sees nothing
  at all rather than a dead control.
- Photo captions, credits, embeds and ad slots inside the article body are
  skipped — an advertiser's name read out mid-sentence is worse than
  silence.

Only felt while developing: speech is split per sentence (Chrome cuts an
utterance off after ~15 seconds) while the highlight stays per block; the
`data-dengar-*` attribute names are a three-sided contract between
`apps/storefront/src/components/berita/PemutarDengar.astro`, `apps/storefront/src/styles/dengar.css` and `apps/storefront/src/scripts/dengar.ts`,
listed in the component's own docblock.
