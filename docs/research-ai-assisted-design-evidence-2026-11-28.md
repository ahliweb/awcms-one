🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](research-ai-assisted-design-evidence-2026-11-28.id.md)

# AI-assisted design and specification evidence — reusable multi-profile template

- Version: 0.2.0
- Date: 2026-11-28
- Status: research proposal, not a normative change or implementation. Every design item, control and mapping below is **proposed**.
- Related issue: #596 (stays open)
- Evidence snapshot: `AGENTS.md` blob `c6ed72f8b5a29c3559d67c5b905e9344227387cd` and `docs/template.md` blob `29ed1fea28a0ee069430e28b9b74d27cea0e4a42` on `origin/main` at `b95d76d54cbb482587ffb2b7ef6e409c48771838` (blob SHAs, not commit SHAs; both re-read at takeover on 2026-11-28).

## Research method and evidence

A rapid review of primary public sources, not a systematic review and not a product trial. The research was prompted by public descriptions of commercial AI planning and design tools; those descriptions are vendor feature claims, not effectiveness evidence, so no product is named or assessed here. Only general functional concepts and open standards are used.

- Cui et al., a field-experiment study of developer productivity ([publisher page](https://doi.org/10.1287/mnsc.2025.00535)): **not verified at takeover** (the publisher page refused access). Its year, sample size and effect figures are not stated here and must not be quoted until checked.
- [METR 2025](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/): a randomized study of 16 experienced developers over 246 issues, reporting 19% longer completion time; the page marks the result as not current. The [2026 update](https://metr.org/blog/2026-02-24-uplift-update/) describes a changed study design and selection effects. Outcomes differ between studies: do not pool them or promise savings.
- [Perry et al.](https://arxiv.org/abs/2211.03622): in a bounded study, participants were more inclined to believe their code was secure; read as a security and overconfidence risk signal, not a rate.
- DORA 2025 report: its page summary was consistent with the use made here; the full PDF was not opened (no link is added here). A DORA ROI report exists, but its page gives only an update date (22 April 2026), not a publication year.
- ISO/IEC/IEEE 12207 (software life cycle processes) and ISO 9241-210 (human-centred design): **not verified at takeover** (the catalogue pages refused access); edition years are therefore not stated.
- [Design Tokens Community Group format 2025.10](https://www.designtokens.org/tr/2025.10/format/) is a final Community Group report dated 28 October 2025, not a W3C Recommendation. The [DESIGN.md draft specification](https://blog.google/innovation-and-ai/models-and-research/google-labs/stitch-design-md/) is dated 21 April 2026. Both are interoperability references, not mandatory tools.
- [NIST SSDF](https://csrc.nist.gov/projects/ssdf/publications): version 1.1 is final (February 2022); version 1.2 is a draft released 17 December 2025.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) is a W3C Recommendation published 12 December 2024.

## Boundary and proposed validation

This is a Bun/Astro/PostgreSQL template with its own reference deployment; a consumer repository owns its backend, data, domains and operations ([ADR-0024](adr/0024-awcms-one-is-template-only-derived-apps-own-their-backend.md)). `SITE_PROFILE` is `toko`, `berita` or `landing`.

Proposed: review reuse of the canonical theme and tokens; the repository has no `DESIGN.md` at takeover, and existing design material lives under `design/`, so a DESIGN.md narrative would be new. Test profile-specific screenshots, a state inventory, `template:init` neutral branding and the absence of consumer data. Use the existing screenshot and local-CI conventions (see `docs/pengujian.md`) and compare against a baseline without replacing the architecture.

No consumer runtime dependency and no UAT here. Reusable foundations are promoted explicitly through their own upstream ADR and tests (the "Promotion is explicit" rule in `AGENTS.md`), not implicitly. There is no Lynx workspace in this repository ([ADR-0050](adr/0050-lynxjs-for-separate-persona-apps-astro-stays-for-admin-and-public-profiles.md)).

## Evidence contract (proposed)

- Steps 2 and 4: requirement and acceptance criteria, screen ID, review context and a synthetic prototype.
- Steps 5 to 8: explicit data, permission and operation, and a contract-generated mock when applicable.
- Gate 9: detect missing or conflicting links; corrections go back to the originating specification.
- Step 11: per-slice tests only after the applicable approval.
- Step 12: a deterministic visual baseline, plus manual and automated WCAG 2.2 checks; automation alone does not prove accessibility.
- Record observed, approved, inferred, unknown and proposed facts separately; pin the actual source SHA before any pilot. Where a UI is absent mark the item N/A. Reuse canonical artifacts instead of duplicating them.
- Measure time including review and rework, defect escape, task success and cost against a matched baseline. No fabricated tests, UAT or CI.

## Security and licensing (proposed)

Concept-only, independent adoption: no copying of proprietary assets or source, and no sending of confidential data to unapproved providers. Use synthetic fixtures, least privilege, redaction and licence review. Applicable Indonesian instruments are the personal data protection law ([UU 27/2022](https://peraturan.bpk.go.id/Details/229798/uu-no-27-tahun-2022); its article text was **not verified at takeover**, the page gives metadata only) and the copyright law ([UU 28/2014](https://peraturan.bpk.go.id/Details/38690/uu-no-28-tahun-2014); the page was reached, article text not shown). No compliance certification or performance result is claimed.

## Next decision

Issue #596 owns deeper inspection (ADRs, docs, actual code, CI and overlap), a bounded proposal and a reviewer decision. This note authorizes no implementation, dependency, release or gate approval.

## GitHub Projects lifecycle coordination (proposed, 2026-11-28)

Owner direction, general only: coordinate the applicable lifecycle steps through GitHub Projects (v2), integrated with existing project management and not as a second board or a replacement for repository authority. Template-only; profiles `toko`, `berita`, `landing`; consumer UAT and deployment stay in the consumer's issue and project. Existing work: #596.

- Steps 1 to 8: track research and specification deliverables with dependency, reviewer, acceptance criteria and evidence URL; no implementation issue before the applicable gate 9. The gate tracker references a recorded decision and never infers it from a board column.
- Steps 10 to 12: one canonical issue per S/M unit, native parent/sub-issue and blocked-by relations where supported, milestone, priority and assignee preserved; the PR references the issue and CI evidence. Steps 13 to 15: staging/UAT only if applicable, release-readiness evidence and decision. Steps 16 to 18: deployment, validation, monitoring and follow-up with release or incident evidence.
- Reuse the approved project and its existing fields; the field names (stage, assignee, priority, start, target) and their live values were **not verified at takeover**. Proposed status mapping: planned = backlog, ready = applicable definition of ready, running = claimed, waiting = dependency, review or approval, done = verified outcome, cancelled = cancelled with reason. The lifecycle step is a separate field or existing issue metadata, never inferred from the status. A gate rejection stays recorded even if the tracker closes. A closed-unmerged PR, a duplicate or not-planned issue, or missing evidence is never marked done automatically. Preserve owner, assignee and target; do not invent deadlines.
- Project membership and field changes: discover the live owner, number, access and field IDs; use the real issue URL or node ID, idempotent add, a dry-run diff, readback and reconcile; keep one canonical issue and distinguish PR items from work counts. No shared draft cards or confidential context. Review permissions, avoid broad seeding or status-automation conflicts, and never move an item across a visibility boundary automatically. The board is coordination only, never merge or deploy authority. No project membership was checked in this research.

References: [planning and tracking with Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects); [using the API to manage Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects); [issue dependencies](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies); [issue statuses](https://docs.github.com/en/issues/tracking-your-work-with-issues/learning-about-issues/about-issue-statuses). These four GitHub documentation pages were **not verified at takeover**.

## Reference verification at takeover (2026-11-28)

Of the fifteen references checked in the original draft, eleven were supported (two with corrections applied above: METR counts 246 issues, not tasks, and its result is marked not current; the DORA ROI report has no publication year on its page), one was partly supported, and three could not be verified (Cui et al. and ISO 12207, both cited here and marked above, and ISO 25010, which this note does not cite). Two commercial-product references were removed rather than verified (see "For human review" in the pull request). Additionally checked: WCAG 2.2 (Recommendation, 12 December 2024) and UU 28/2014 as the copyright law (article text not visible). Marked not verified: the four GitHub documentation pages, ISO 9241-210 (access refused) and the article text of UU 27/2022. All checks were read-only, through page summaries rather than raw copies. This note makes no performance, test or compliance claim.

## Changelog

- v0.2.0 (2026-11-28): takeover verification; rewording to proposed status; vendor product descriptions removed; unverifiable references marked; repository claims checked against the tree; index and changeset added; Indonesian mirror added.
- v0.1.0 (2026-11-28): initial research note and GitHub Projects coordination section.
