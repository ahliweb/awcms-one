# AWCMS-One template and initialization wizard — FastPlaz concepts, repository-specific architecture

## Document control
- **Version:** v1.0.0
- **Updated:** 2026-11-10
- **Status:** Proposed architecture / research only; not a production feature.
- **Document Changeset:** First reference and implementation-boundary mapping.
- **Owning issue:** [#521](https://github.com/ahliweb/awcms-one/issues/521).

## Summary and confirmed local baseline
The repository already implements `bun run template:init` with `SITE_PROFILE` (`toko`, `berita`, `landing`), neutral seeds, and tested scaffolding of derived products.

## Intent and candidate adaptation
Enhance `template:init` rather than replace it: pre-init planning, deterministic change manifest, post-init validation, no stale branding or inherited phone/address, lockfile/repo metadata consistency, profile and deployment smoke checks.

## Authority and prohibitions
Reusable template here; AWCMS generic backend work upstream; derived app owns its own CMS, DB, secrets and deployment; never point derived production to template deployment.

## Existing related issues and anti-duplication
New architecture [#521](https://github.com/ahliweb/awcms-one/issues/521); existing template drift [#476](https://github.com/ahliweb/awcms-one/issues/476); prior regressions [#227](https://github.com/ahliweb/awcms-one/issues/227) and [#233](https://github.com/ahliweb/awcms-one/issues/233).

## Six concrete validation scenarios
1. Landing profile without phone/address cannot inherit original store identity.
2. Toko profile has matching `package.json`/`bun.lock` root names.
3. Berita profile ships only permitted routes, canonical and site identity.
4. Two identical initializations result in zero unexpected diff.
5. Invalid profile or domain fails before file changes.
6. Derived product gets its own deployment and secret onboarding checklist.

## Proposed checks and test evidence
Reuse `bun run ci:template`, `bun run check:lockfile`, profile smoke and documentation gates; inspect template-init tests. No independent generator in `apps/cms`.

## Rollout / handoff
Coordinate implementation via #476 where overlapping; issue #521 is documentation/architecture only. Check generic capabilities before new issue.

## Source reference and limits
This document takes **concepts only** from [FastPlaz](https://github.com/fastplaz/fastplaz): [MCP/AI Agent Plane](https://github.com/fastplaz/fastplaz/blob/master/docs/MCP.md), [IDE workflow](https://github.com/fastplaz/fastplaz/blob/master/docs/AI_AGENT_by_FASTPLAZ.md), and [standalone operator concepts](https://github.com/fastplaz/fastplaz/blob/master/docs/STANDALONE-deployment.md). No Pascal, Lazarus, CGI, MVC/theme engine, or source-code copying. [FastPlaz license text](https://github.com/fastplaz/fastplaz/blob/master/LICENSE.txt) does not demonstrate explicit source-code permissions; independent implementation only.

## Cross-portfolio engineering invariants
Applies the **internal cross-portfolio standard**, alongside this repository's own AGENTS, ADR, CONTRIBUTING and current code reality. Human-approved **Gate 9 (cross-spec Definition of Ready)** precedes production feature code; human-approved **Gate 15 (release readiness)** precedes production. One issue/branch/PR per atomic scope. Never present a specification, green documentation check, or research as working production functionality.

Local MCP/tool connector, if ever required: loopback or authenticated IPC, host/Origin restrictions for HTTP, rotating scoped credentials, canonical-path and symlink protections, read/write/destructive approval tiers, no arbitrary shell, no default SQL/raw DB/secret access, bounded resource/time/cancellation, policy at actual tool/OS runtime, fail-closed unknown and redacted logs. Human sign-off for changes to authorization, production configuration or sensitive data.

## Relevant regulatory and control references
Evaluate applicability, not compliance by assertion: Indonesian UU 27/2022 (PDP), PP 71/2019 (PSTE), Perpres 95/2018 where SPBE applies; ISO/IEC 27001, 27002, 27005, 27017, 27018, 27034, 27701, ISO 22301, ISO/IEC 20000-1, ISO/IEC 42001, ISO/IEC 15408; OWASP LLM/Agentic Security, NIST AI RMF. Obtain independent control evidence and applicable edition before any claim of certification.

## Acceptance evidence rubric
For any follow-on: link spec/ADR and owning issue; record source commit, toolchain/runtime version, commands executed, actual error/result, denied access tests and evidence SHA. Mark unrun checks **NOT EXECUTED**. Approvals and publication/deployment status are distinct. No sensitive personal data or production secrets in prompts, logs or GitHub artifacts.


## Changelog
- **v1.0.0 — 2026-11-10:** Documented evidence-backed, repo-specific adoption boundary, six practical cases and acceptance rubric.
