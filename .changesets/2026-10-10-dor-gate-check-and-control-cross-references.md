---
bump: patch
type: docs
impact: internal
---

# DoR gate check (A9) and control cross-references

Issue #339. `docs/aw-business-platform-dor.md` rolls up the epic #280 Definition of Ready after W1 to W9 landed: `awcms` ADR-0135 (nightly stays, ahliweb/awcms#931) resolves finding X1 and decision W0, the threat-model addendum resolves X4, and the upstream packs now record the owner answers (X9). The ADR-0040 D7 gate is evaluated criterion by criterion: it holds conditionally, with three named residuals (R1 to R3) proposed as explicit owner waivers.

- The booking access matrix, UX flows and adapter contracts cite threat controls C-25 to C-41 and drop their "does not exist on this base" caveats.
- Documents that cited `awcms` ADR-0135 by GitHub URL link the local copy in `apps/cms/docs/adr/`.
- Docs only: no module, migration or OpenAPI path. Indonesian mirrors are updated and re-stamped.
