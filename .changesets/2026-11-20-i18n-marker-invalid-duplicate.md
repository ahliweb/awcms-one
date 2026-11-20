---
bump: patch
type: structure
impact: internal
---

# The translation gate and stamper now see invalid and duplicate `i18n-source-hash` markers

`MARKER_REGEX` only matched `<!-- i18n-source-hash: sha256:<64 hex> -->`, so a hand-written `<!-- i18n-source-hash: sha256:placeholder -->` line was invisible twice over: `docs:i18n:stamp` did not remove it (it stacked a second, real marker on top), and `audit:translation` did not notice it.

- `docs:i18n:stamp` removes every marker-comment line whatever its value, then writes one valid marker. A line only counts when the whole line is the comment, so a mention of the marker in prose or inline code is left alone.
- `audit:translation` fails a mirror with more than one marker, or with a marker whose value is not `sha256:<64 hex>`, and names the fix.
- Tests in `tests/docs-i18n-checks.test.mjs` cover a placeholder dropped by the stamper, a duplicate rejected and an invalid marker rejected.
- Sixteen mirrors under `docs/` lost a stray marker line (fifteen `sha256:placeholder`, one `sha256:0`) and the blank line beside it. `apps/cms` is untouched.
