---
bump: patch
type: docs
impact: internal
---

# Reconcile apps READMEs found broken by #43's review

Two defects in `apps/**` READMEs, both found while reviewing PR #43 and out
of scope for it since it only touches root-level docs.

- `apps/storefront/README.md`'s stub-workflow paragraph: PR #41 (issue #30)
  inserted the new state-machine clause mid-sentence, between "straight from
  the committed fixtures" and "under `apps/storefront/tests/fixtures/
  awcms/`", orphaning the second half as its own fragment line. Restored the
  original sentence and made the issue #30 addition its own well-formed
  sentence, keeping the file's hard-wrap style.
- `apps/cms/src/modules/commerce/README.id.md` had fallen behind Issue #29:
  the whole "Customers, orders and reviews" section was missing from the
  mirror, the admin-screens heading and body still described the
  pre-#29 eight-screen/32-permission state, and the frontmatter table
  (tables, permissions, API, events, dependencies, jobs) plus several
  prose paragraphs (the `manualRating`/`manualSoldCount` note, the voucher
  redemption paragraph, the `downloadLink` DTO note, and "Dengan sengaja
  tidak ada di sini") still described the pre-#29 shape — one of them
  (the `downloadLink` note) had drifted into stating the opposite of what
  the corrected English source now says. Translated the missing section
  and brought every drifted paragraph back in line with `README.md`,
  paragraph by paragraph. Verified the module has nineteen
  `awcms_commerce_*` tables and 39 permissions against `module.ts`, both of
  which now match `README.md`; no factual error was found in the English
  source itself.
