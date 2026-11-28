🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](independent-intelligence-reference-2026-11-28.id.md)

# Independent intelligence capability research

## Metadata

- Version: v1.3.0
- Last updated: 2026-11-28
- Changeset: takeover verification; vendor statements removed; unverifiable references marked; mirror and index added.
- Status: research and reference only, **proposed**; no product code, no approved dependency, no Gate 9 or Gate 15 decision.
- Tracker: #598 (stays open)
- Evidence: blob snapshots on `origin/main` at `b95d76d54cbb482587ffb2b7ef6e409c48771838`: `AGENTS.md` `c6ed72f8b5a29c3559d67c5b905e9344227387cd`, `docs/template.md` `29ed1fea28a0ee069430e28b9b74d27cea0e4a42` (blob SHAs, not commit SHAs; re-read at takeover). A full code, migration, issue-status and CI audit is still pending.

## Evidence and intellectual property

This research was prompted by the public description of a commercial product in this field. That description is vendor self-report, was not independently tested, and is not assessed here; the note uses only general functional concepts and open standards. No licence to reproduce any third-party product has been established. Use public functional concepts and original requirements, specifications, design and implementation. No third-party code, UI, assets, text, datasets, brand, proprietary SDK, rules or API, no reverse engineering, and no unauthorized testing.

Indonesian copyright law (UU 28/2014) is the legal context for the distinction between protected expression and ideas or methods ([UU 28/2014 on the BPK site](https://peraturan.bpk.go.id/Details/38690/uu-no-28-tahun-2014): the page was reached, but articles 40 and 41 were **not verified at takeover**; the [WIPO Lex entry](https://www.wipo.int/wipolex/en/legislation/details/15600) was reached and its article text was not read). Patent, trademark, trade secret and contract review is still required. No dependencies are introduced: every proposed dependency, model or data source needs a version or SHA, a licence/SPDX identifier, commercial and SaaS rights, a notice, a transitive SBOM, owner approval and an exit plan before use. Do not reproduce licensed standards text.

## Repository disposition (proposed)

Reuse the template; ADR-0024 ([ADR-0024](../adr/0024-awcms-one-is-template-only-derived-apps-own-their-backend.md)) keeps the consumer's backend, database, migrations and secrets independent; generic capability is upstreamed in the upstream platform through the repository's explicit promotion rule; subtree syncs use a merge commit. Evaluate the `landing`, `berita` and `toko` profiles for reusable dashboard needs. No intelligence engine and no shared runtime here.

## Controls, validation and evidence (proposed)

Mock contract, no private data in static generation, and all profile, `template:init` and local-CI gates plus regression. UAT runs in the consumer, not upstream. No new profile and no server-side rendering without an ADR. Avoid graph-database and vector dependencies until there is evidence.

Record requirements and threats, then control, versioned contract, reproducible synthetic test, evidence, and SOP or monitoring. Baselines and thresholds are hypotheses until measured. Use least privilege, default-deny RBAC/ABAC and forced RLS where applicable, no client-provided tenant trust, no secrets or PII in logs, audited approvals and recovery. No live vendor, customer or public target is tested. Verify data purpose, retention, lawful basis and the controller/processor split. No cross-tenant data sharing without an explicit scoped grant.

## Professional reference register

Each entry shows its status at takeover (2026-11-28).

| Reference | Status at takeover |
| --- | --- |
| [W3C PROV-O](https://www.w3.org/TR/prov-o/) | Supported: W3C Recommendation, 30 April 2013 |
| [Lewis et al., NeurIPS 2020, retrieval-augmented generation](https://papers.nips.cc/paper/2020/hash/6b493230205f780e1bc26945df7481e5-Abstract.html) | Supported |
| [NIST SP 800-218 SSDF v1.1](https://csrc.nist.gov/pubs/sp/800/218/final) | Supported: final, February 2022 |
| [NIST SP 800-218A](https://csrc.nist.gov/pubs/sp/800/218/a/final) | Supported: final, July 2024 |
| [NIST SP 800-61 Rev. 3](https://csrc.nist.gov/pubs/sp/800/61/r3/final) | Supported: final, April 2025 |
| [OASIS STIX 2.1](https://docs.oasis-open.org/cti/stix/v2.1/os/stix-v2.1-os.html) | Supported: OASIS Standard, 10 June 2021 |
| [OWASP ASVS](https://owasp.org/projects/asvs) | Supported: 5.0.0 stable (the ASVS site states publication on 30 May 2025) |
| [WCAG 2.2](https://www.w3.org/TR/WCAG22/) | Supported: W3C Recommendation, 12 December 2024 |
| [NIST Cybersecurity Framework](https://www.nist.gov/cyberframework) | Page presents CSF 2.0; no publication year is stated on the page, so none is given here |
| [NIST AI RMF 1.0](https://doi.org/10.6028/NIST.AI.100-1) | **Not verified at takeover**: the link redirects to a PDF that could not be read |
| Hall and Llinas (1997), data fusion ([DOI](https://doi.org/10.1109/5.554205)) | **Not verified at takeover** (publisher page gave no content) |
| ISO/IEC catalogue entries (27001, 27002, 27005, 27017, 27018, 27034-1, 27701, 15408-1, 20000-1, 22301, 42001, 23894, 25010, 27035, 27036-3, 27037) | **Not verified at takeover** (catalogue refused access); edition years are therefore not stated, and no certification, compliance or clause audit is claimed |
| UU 27/2022 on personal data protection ([BPK page](https://peraturan.bpk.go.id/Details/229798/uu-no-27-tahun-2022)) | Page reached, metadata only; the content of article 46 (breach notification within 3 x 24 hours) is **not verified at takeover** |
| [PP 71/2019](https://jdih.komdigi.go.id/produk_hukum/view/id/695/t/common) | Supported as "Penyelenggaraan Sistem dan Transaksi Elektronik" |
| [Perpres 82/2022](https://peraturan.bpk.go.id/Details/211029/perpres-no-82-tahun-2022) | Supported as "Pelindungan Infrastruktur Informasi Vital" |

Review UU ITE, sector laws and the current implementing rules before any release. No deadline or regulation number taken from a vendor statement is used.

## Next gate

Follow the internal cross-portfolio 18-step lifecycle. Discovery and UX, privacy and threat model, data and authorization, algorithms and contracts come before Gate 9; only the research issue is authorized now. Validate repository-specific CI, index, changeset and project board, milestone and dependencies during review; consumer UAT and Gate 15 come before production. Rollback is removal of this document (no runtime effect); future features need tested recovery and rollback and monitoring. No CI or test execution is claimed for this research.

## Follow-up research: security controls and licence admission (v1.1.0 content, reworded at takeover)

Status: research only; no implementation gate, no dependency admission. Vendor pages are not cited and no vendor pricing, hours, scoring or tooling is assumed. Functional concepts only: no copy of any UI, code, scoring formula, text, proprietary API, assets, scan templates or data. No account, no target testing, no download of third-party internals. A data-residency claim is not proof of where all processing happens: review subprocessors, transfers, deletion and contracts separately. Personal data protection readiness is not a certification.

### Licence admission register (observed on the default branch, not a pinned release)

| Candidate | Evidence and disposition |
| --- | --- |
| ZAP | Apache-2.0 ([LICENSE](https://github.com/zaproxy/zaproxy/blob/main/LICENSE)); unapproved candidate; check add-ons and NOTICE |
| Nuclei | MIT ([LICENSE](https://github.com/projectdiscovery/nuclei/blob/dev/LICENSE.md)); unapproved candidate, no new dependency |
| Official Nuclei templates | MIT ([LICENSE](https://github.com/projectdiscovery/nuclei-templates/blob/main/LICENSE.md)); review provenance, signatures and safety separately; no unknown third-party templates |
| testssl.sh | GPL-2.0 ([repository](https://github.com/testssl/testssl.sh)); hold until distribution and integration review |
| Wazuh | Per its [README](https://github.com/wazuh/wazuh/blob/main/README.md): the engine is AGPL-3.0-or-later, some shared libraries are "GPL-2.0-only OR AGPL-3.0-or-later", the rest is GPLv2; inspect all packages, indexer, dashboard, agent and the actual release; hold |
| MVT | Custom consent-restricted licence ([LICENSE](https://github.com/mvt-project/mvt/blob/main/LICENSE)), MVT License 1.1, with a consensual-use restriction; hold; explicit, informed, non-coerced data-owner consent; IOC data has separate licences |

No tool is approved, installed or bundled. Before any ADR: pin the release, tag or SHA, record the digest, the transitive SBOM, licence obligations and NOTICE, distribution and network-use terms, dataset and feed terms, support and exit plan, and complete legal review. Process separation does not erase licence obligations. Prefer the approved native foundation; external adapters only after a gate. No reverse engineering of any API.

### Scientific and professional method (proposed)

- FIRST [CVSS v4.0 FAQ](https://www.first.org/cvss/faq): base severity is not business risk. [FIRST EPSS](https://www.first.org/epss/): the current score estimates the probability that a published CVE is exploited in the wild in the next 30 days, not the compromise probability of a specific asset. FIRST's [research page](https://www.first.org/epss/research) lists the original 2021 paper and a later update; their horizons were not compared at takeover, and the original paper (Jacobs et al., 2021) was **not verified at takeover**.
- [CISA KEV](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) records known exploitation; [SSVC](https://www.cisa.gov/ssvc) is a stakeholder-specific decision method. Record feed date and version; stale or unknown data is explicitly unknown and is not scored as zero. A risk decision combines verified exposure, asset impact, controls, exploitation evidence and human review; no production formula is invented and nothing is closed automatically. Evaluate on a time-split synthetic or authorized historical dataset: coverage and efficiency, precision and recall, calibration (Brier score) and analyst burden against a severity-only baseline. No measured result is claimed.
- [NIST SP 800-115](https://csrc.nist.gov/pubs/sp/800/115/final) (September 2008) for assessment planning; SP 800-61 Rev. 3 for incident response integrated with CSF 2.0; ASVS 5.0.0; PROV-O; WCAG 2.2. ISO 27035, 27036-3 and 27037 supplement an existing control mapping and are neither certification nor licensed text.
- Personal data law: UU 27/2022 breach notification (article 46) needs human and legal validation of the trigger and recipients; no automated filing. Legal review of lawful basis, DPIA, data transfer, PSE and sector requirements, UU ITE, PP 71/2019, Perpres 82/2022 and UU 28/2014 is required.

### Proposed safety and acceptance tests

All tests below are proposed; none has been executed, and the IDs are provisional and must be reconciled with existing CAP and REQ IDs.

- SEC-001: verified asset and signed scope grant; expiry and revocation; recheck before every job. DNS or file proof alone is not blanket permission; third-party and shared hosting need separate authorization.
- SEC-002: deny unapproved destinations, redirects, DNS changes, SSRF and private or link-local targets; no broad or disruptive tests, no exploitation, no credential collection, no external callbacks; sandboxed synthetic fixtures, a bounded resource budget, a stop switch and an independent worker identity.
- SEC-003: admission, SBOM and version or signature checks; no arbitrary user templates or shell.
- SEC-004: finding and evidence hash, redacted output, tenant-scoped access, stale flag, audit and retest, and a false-positive workflow.
- SEC-005: explainable risk decision with provenance and uncertainty.
- SEC-008: governance, risk and compliance evidence with legal review. SEC-009: incident chronology, a configurable notification deadline, approval and a recovery drill. SEC-010: restricted evidence retention and deletion with access audit.
- SEC-011: a GitHub issue only after scoped authorization and redaction; no automatic action.
- SEC-012: AI may draft only; no secrets or raw customer telemetry; prompt-injection and egress tests; citations and abstention.
- SEC-013: endpoint monitoring is metadata only, where authorized. SEC-014: legitimate rights-holder reports only, human review, no retaliatory action. SEC-015: device-owner consent, no reading of communications, no forensic guarantee.

No real customer assets or data are used in this research.

### Local research deliverables (#598, proposed)

Evaluate product-owned security dashboard and report mocks across the three `SITE_PROFILE` values; public static output only for deliberately approved aggregates. No scanner, no tenant production data, no secret, no shared API or runtime and no security-report service in the template. The generic foundation comes through the upstream platform and a tested subtree merge commit; no new profile and no server-side rendering without an ADR. Test `template:init`, the existing local-CI checks, contracts, exclusion of private reports from build output, and consumer upgrade and rollback. The consumer owns authorization, assessment workers, storage, UAT and deployment; upstream UAT is N/A.

## Independent reconstruction direction (2026-11-28, proposed)

Direction, stated generally: use original capabilities rather than unapproved dependencies. This supersedes the earlier "hold as candidate" status for testssl.sh (GPL-2.0), Wazuh (AGPL-3.0-or-later engine, mixed licences) and MVT (custom licence with consent). Do not install, link, vendor, port, translate or copy source, structure, UI, rules, templates, IOCs or datasets of these products or of any commercial product, do not use them as an oracle, and do not reverse engineer them. GPL and AGPL are not commercial bans: independent implementation is a business and architecture choice, not a legal exemption. Informed, non-coerced device-owner consent is preserved regardless of implementation. ZAP and Nuclei remain unapproved candidates with no dependency admission. Use public functional descriptions and independent standards only; require contributor provenance and attestation, a source register, independent requirements, a reviewer, similarity and dependency/SBOM checks, and a pin of version, SHA, licence, notice, patent and data terms and exit plan. No formal clean-room or compliance claim is made. No restricted material goes into agent prompts.

### Independent standards and scope (proposed)

- TLS: [RFC 9846](https://www.rfc-editor.org/info/rfc9846/) (July 2026) obsoletes RFC 8446. [BCP 195](https://www.rfc-editor.org/info/bcp195/) comprises RFC 8996, RFC 9325 and RFC 9852; RFC 9325 is also updated by RFC 10015, which is **outside** BCP 195. [RFC 9525](https://www.rfc-editor.org/rfc/rfc9525.html) covers service identity. [NIST SP 800-52 Rev. 2](https://csrc.nist.gov/pubs/sp/800/52/r2/final) (August 2019). Use approved runtime TLS APIs and never new cryptography; observe negotiated version, chain, identity and expiry only; unknown is not a pass. An observed TLS 1.2 connection is not BCP compliance; no parity or exploit probes.
- Logging and integrity: Denning (1987, intrusion detection model) is **not verified at takeover**. [NIST SP 800-92](https://csrc.nist.gov/pubs/sp/800/92/final) (2006; Revision 1 is still a draft), [SP 800-137](https://csrc.nist.gov/pubs/sp/800/137/final) (September 2011), [SP 800-53 Rev. 5](https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final) with Release 5.2.0 (27 August 2025; controls AU-6, SI-7 and SI-4 were not individually read), [RFC 5424](https://www.rfc-editor.org/info/rfc5424/) (March 2009) and the [OpenTelemetry logs data model](https://opentelemetry.io/docs/specs/otel/logs/data-model/) as references only.
- Mobile: [NIST SP 800-124 Rev. 2](https://csrc.nist.gov/pubs/sp/800/124/r2/final) (May 2023) and [SP 800-101 Rev. 1](https://csrc.nist.gov/pubs/sp/800/101/r1/final) (May 2014, mobile device forensics) mark a scope boundary, not forensic acquisition.
- SSDF 1.1 is final; 1.2 is an initial public draft, not final. ISO and Indonesian-law mappings are listed in the register above with their verification status; they are evidence, not certification.

Provisional IDs (all proposed): IND-01 TLS posture (consumer worker), IND-02 host metadata (consumer-side host tooling), IND-03 event normalization and correlation (upstream contract and summaries), IND-04 integrity evidence (consumer-side host tooling), IND-05 mobile posture (product discovery), IND-06 risk, evidence and cases (upstream platform and consumer). No full SIEM, XDR or forensics claim and no spyware-detection claim. An explicit scoped grant, expiry and revocation, an independent worker, synthetic data, no unauthorized I/O or private data, and no action without approval apply throughout.

A reference spike for pure decision logic over supplied observations was prepared outside this repository by the research session, which reported that it passed 19 synthetic tests on Node v22.16.0. It was **not run in this repository** and is not implementation evidence for it; there was no Bun, CI, real TLS, device, RLS or production testing. Reconcile CAP and REQ IDs, source provenance, ADRs and Gates 9 and 15; no new product code or deployment.

### Local requirements and acceptance (proposed)

IND-01 and IND-06: a reusable mock posture and report UI, approved contracts only; no scanner, engine, collector or new dependency in the template. The consumer owns backend, scope, workers, secrets, UAT and backup; the upstream generic foundation arrives by a subtree merge commit. Verify `template:init`, all profiles, static-output privacy and regression. No new profile and no server-side rendering without an ADR.

## Reference verification at takeover (2026-11-28)

References were checked by opening their pages on 2026-11-28 (read-only; page summaries, not raw copies). Supported: the RFC and BCP pages, the NIST publications named above with their dates, STIX 2.1, PROV-O, the retrieval-augmented generation paper, ASVS 5.0.0, EPSS, CVSS v4.0, CISA KEV and SSVC, RFC 5424, the OpenTelemetry page, WCAG 2.2, PP 71/2019, Perpres 82/2022, and the licence pages for ZAP, Nuclei, its templates, testssl.sh, Wazuh and MVT. Corrections applied: RFC 10015 is outside BCP 195; SP 800-53 is cited as Rev. 5 with Release 5.2.0 (27 August 2025); the CSF year is not stated; the ASVS publication date is now sourced. Marked **not verified at takeover**: every ISO catalogue entry and edition year, UU 27/2022 article 46 and UU 28/2014 articles 40 and 41, NIST AI RMF 1.0, Hall and Llinas, Denning and Jacobs et al. Vendor statements (prices, service hours, tool lists, deadlines) were removed rather than verified. The 19-test statement is a research-session claim, not a result of this repository. The checks give no performance, test or compliance claim.

## Changelog

- v1.3.0 (2026-11-28): takeover verification; vendor product statements removed and replaced by a neutral sentence; unverifiable references marked; spike claim reworded; mirror and index added.
- v1.2.0 (2026-11-28): independent reconstruction replacing unapproved components; proposed local acceptance.
- v1.1.0 (2026-11-28): vendor-site evidence, licence dispositions, risk methodology and local research criteria (vendor content since removed).
- v1.0.0 (2026-11-28): initial research, local ownership and controls.
