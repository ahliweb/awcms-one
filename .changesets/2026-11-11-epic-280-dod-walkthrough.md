---
bump: patch
type: docs
impact: public
---

# Epic #280: Definition of Done walkthrough

Issue #397 asks for the epic's Definition of Done to be ticked with links. Ticking it blindly would overstate the state of the work, so the new walkthrough gives each of the 20 items a verdict (Met, Met for the template scope, Partial or Not met) with evidence links that resolve in this tree or the embedded upstream tree.

- `docs/aw-business-platform-dod.md` (with its Indonesian mirror) lists the verdicts, what each Partial item lacks, and who owns the remainder: this repository, upstream `awcms`, or the derived product that deploys (ADR-0024). Seventeen items are Met or Met for the template scope; three are Partial (payroll rules, which are upstream design only; the WhatsApp legacy path, due by v0.22.0 under ADR-0054; and staging, UAT and production validation, which belong to the product that deploys).
- Two new evidence pages close what was missing for items 14, 15 and 17: `docs/aw-business-platform-traceability.md` maps every PRD story to its tests and every threat-model control (C-01 to C-41) to its as-built status and regression test, and `docs/aw-business-platform-standards-map.md` maps the components built for the epic to OWASP ASVS, ISO/IEC 27001, PCI DSS and UU PDP with a gap register. Neither is a compliance claim. The largest gap they record, a shopper's data export and erasure path through `commerce`, is tracked as issue #529.
- The threat model no longer says nothing is implemented, and `docs/status.md` no longer calls the epic architecture-only.
- The DoR tracker carries an "Archived" note pointing to the walkthrough; its body is unchanged. The documentation index lists the three new pages.
- No code, migration or setting changes.
