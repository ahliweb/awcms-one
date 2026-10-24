🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](crm-omnichannel-requirements.id.md)

# Omnichannel CRM — reusable requirements standard (v1.0, proposed)

> **Classification:** normative target requirements / Definition of Ready input, **NOT evidence of shipped functionality**. The current implementation inventory is [status.md](status.md). Scope: `ahliweb/awcms-one` template and derived products, with generic foundation owned by [`ahliweb/awcms`](https://github.com/ahliweb/awcms). Tracker: [#462](https://github.com/ahliweb/awcms-one/issues/462). As of **24 October 2026**.

## 1. Provenance, source limits and promotion decisions

The requirements are derived from the stakeholder document **“SPESIFIKASI KEBUTUHAN SISTEM CRM OMNICHANNEL LPP ENTER”**, five pages supplied for requirements analysis on 24 October 2026, and reconciled with [AW Business Platform PRD](aw-business-platform-prd.md), [ADR-0024](adr/0024-awcms-one-is-template-only-derived-apps-own-their-backend.md), [ADR-0040](adr/0040-aw-business-platform-capability-ownership-and-boundaries.md), the current code, and the preceding multi-account omnichannel blueprint v1.2.0. The customer source itself is **not copied into repository product defaults**.

**Source scope, unchanged:** §1 Executive Dashboard; §2 Omnichannel Integration; §3 Unified Inbox; §6 WhatsApp Broadcast; §7 Follow-up Automation; §8 AI Assistant for Marketing; §9 Marketing/Admin Performance; §10 Notifications. **Sections 4 and 5 are absent** in the supplied document. Lead/pipeline and enrollment adapters below are **analyst-derived proposed completion**, not falsely attributed to missing source sections.

**Promotion rule:** platform requirements must be neutral across retail, news, services, education, agency and derived tenants. LPP ENTER's “training program”, “cohort/angkatan”, “registrant/pendaftar” and “re-registration/daftar ulang” are **configurable product dimensions and pipeline stages**, never hard-coded commerce columns, seeds, default tenant names or universal CRM states. Legal claims about job placement or overseas departure are vertical-specific forbidden/approval-controlled content, not general product features.

**WhatsApp business decision / source supersession (24 October 2026):** source §2 and §6 originally said official WhatsApp Business Platform/API or an officially authorized provider. **The product owner has explicitly superseded that transport restriction for LPP ENTER**: **StarSender is the product-specific default**, and **Meta WhatsApp Cloud API is the selectable alternative**. The original text remains traceable as *superseded source*, not as a current acceptance criterion. StarSender is **not Meta-authorized** and has acknowledged account blocking risk; the operator must review/acknowledge that risk and lawful opt-in, disconnection handling and data security before activation. This business preference does **not** prove WhatsApp policy compliance or guarantee message delivery. The **AWCMS-One template itself has no global hard-coded WhatsApp default**: it must support a versioned per-tenant/brand default plus explicit campaign sender selection; product-level configuration sets StarSender as LPP's default after the provider connection is authenticated and healthy. Meta template review and 24-hour rules are enforced on Meta paths only; StarSender retains its own verified capabilities, not fake Meta template approval. Neither API availability nor a social account implies general messaging permission.

## 2. Ownership and capability admission

| Authority | Owns | Must not own |
| --- | --- | --- |
| AWCMS upstream | Tenant/RBAC/ABAC/RLS, channel-account registry, OAuth/credentials references, generic verified inbound interaction contracts, provider-specific delivery/publishing ports, notifications, workflow approval, reporting engine | Derived product enrollment/tuition rules |
| AWCMS-One `commerce` | Existing customer master, segment versioning, consent-gated campaigns and commerce conversion facts; permitted **adapters/projections** | A duplicate generic `crm_customer`, another outbound delivery queue, direct provider calls from transactions |
| Derived product | Business-specific stage names, custom attributes and final-conversion events (e.g. program, cohort, re-registration) through approved extension contracts | Production dependency on this template's reference backend |
| Hermes Agent | Reasoning, model routing, skills, sessions, runtime | Authoritative customer data, provider credentials, sending outside CRM policy |
| OMES | Host lifecycle, health, safety, backup and permitted runtime assurance | Another agent runtime, CRM workflow engine or arbitrary remote shell |
| AWCMS Control Center | Tenant roles, deterministic authorization, review/approval, business event and audit projections | Reading Hermes private database, raw prompts or agent secrets |

**Existing, verified baseline:** `commerce` customer accounts, segments, campaign audiences and email/WhatsApp campaign queueing; AWCMS `email`/Mailketing v1, newsletter, suppression, operational-only Telegram `telegram_delivery`, generic WhatsApp queue with Fonnte/Meta/log, and OMES/Hermes read-only monitoring. **Not yet established:** generic CRM lead/deal lifecycle, cross-provider unified inbox and assignment, full follow-up engine, generic conversion attribution, multi-sender/multi-account routing, social publishing, CRM Hermes automation and comprehensive CRM KPIs. A completed epic is not proof those missing capabilities exist.

## 3. Numbered functional requirements (MUST unless specified)

### 3.1 Lead identity, lifecycle and business extension — analyst-derived gaps (absent source §§4–5)

- **CRM-001** One tenant-scoped, auditable lead/prospect identity and provenance; link to an existing commerce customer through a permissioned, verified mapping, **never create duplicate master customers**. A lead may exist before customer registration.
- **CRM-002** Capture leads from a verified website form, eligible social webhook/message, manually created record or reviewed CSV/XLSX import; record source channel, account, campaign, UTM, event time, capture consent/evidence and source reliability.
- **CRM-003** Versioned, tenant-configurable stage pipeline with transitions, guarded permissions and history; reference stages may be `new → contacted → qualified → follow_up → registered → converted`, but a derived training institution may configure `registered → re_registered` and a store may configure `opportunity → paid`. Stage changes and reasons are auditable.
- **CRM-004** Owner, team, branch/brand, program/service interest, tags, custom attributes, duplicate candidate and merge review. Identity resolution requires explicit proof/authorization; provider handles are not automatic CRM IDs.
- **CRM-005** Opportunities/deals, expected value where meaningful, forecast and won/lost reasons as **optional and separately admitted** generic capability; never equate an inbound message to a verified registrant or customer payment.
- **CRM-006** Data retention, deletion/export, consent subject requests and lawful-purpose separation; isolate person PII, attachments and notes from dashboard metrics and third-party AI.
- **CRM-007** Two tenant records with identical phone/email/external handles remain isolated; authorizations and RLS deny cross-tenant identity lookup, merge or export.

### 3.2 Executive dashboard — stakeholder §1

- **CRM-010** Aggregate leads by today/week/month/custom period, channel, connected account, campaign, business dimension, stage, owner and team.
- **CRM-011** Show new/contacted/qualified/follow-up/registered/converted counts, unanswered interactions, overdue tasks, trends, funnel drop-off and conversion rates with zero-denominator handling.
- **CRM-012** Filters are permission-scoped; live drill-down reauthorizes records. CSV/Excel-compatible and optional PDF export with formula-injection neutralization and PII masking; no undisclosed cross-tenant totals.
- **CRM-013** Every KPI must define event authority, exact numerator/denominator, timezone, reporting window, dedup key, conversion attribution lookback and unknown/missing-data behavior; do not present unavailable real-time provider events as success.

### 3.3 Connected accounts and social capabilities — stakeholder §2

- **CRM-020** Unlimited-by-model (quota/policy limited) accounts per tenant/provider with tenant/brand permissions: Meta WhatsApp Cloud API numbers and risk-acknowledged StarSender devices, Facebook Pages/Messenger, Instagram Professional, TikTok, YouTube, LinkedIn Pages, Threads, Telegram bots/channels, Mailketing sender accounts, verified websites and approved additional platforms.
- **CRM-021** Show actual per-account `publish/reply/dm/inbound/comments/analytics/lead_ads/broadcast` capability and permission state; refuse unsupported actions. Do not assume TikTok DM, LinkedIn member lead enrichment or YouTube DM access.
- **CRM-022** OAuth/consent, secret-reference credentials, expiry/revocation, account health, provider quota, sender verification, least privilege and alerting. No provider keys in browser, agent context, logs, screenshots or issue attachments.
- **CRM-023** Inbound events only via authenticated official mechanisms: webhook verification, tenant + provider account binding, bounded body, dedup, replay protection and safe media retrieval; quarantine unverifiable events rather than mutating trusted CRM facts.
- **CRM-024** Site profile social follow/share links are **not** evidence of connected accounts.

### 3.4 Unified inbox and SLA — stakeholder §3

- **CRM-030** One authorized **projection** of conversations across eligible connected accounts, preserving provider/thread identity; this is not a new master customer or a fake common provider messaging capability.
- **CRM-031** Account/channel/time/contact search and filters by assigned owner, stage, status and business dimension; show provider-supported read/delivery states with “unknown” when absent.
- **CRM-032** Assign/reassign with explicit permission and audit, internal notes hidden from external recipients, tags, approved quick replies, allowed attachments, close/reopen/follow-up, and conflict-safe multi-agent concurrency.
- **CRM-033** Reply only inside provider-approved eligibility/window with a matching authenticated sender identity and channel-specific consent/policy. Show a disabled action with an explanation when unavailable.
- **CRM-034** SLA policy per tenant, channel and working calendar: queue wait, first meaningful human response, due time, escalations and holidays; paused/nonbusiness time is explicit, not silently counted against staff.
- **CRM-035** Prevent two staff members or an AI agent and staff member from silently duplicating replies; optimistic concurrency and idempotent outgoing message identity.

### 3.5 Broadcast and campaigns — stakeholder §6

- **CRM-040** Import contact files through preview/validated dry-run, dedup, safe spreadsheet parsing and CSV-injection prevention; importing a number/email **never grants marketing consent**.
- **CRM-041** Campaign audience from existing CRM/customer segments and eligible opt-ins, with immutable segment/version snapshot; by program/cohort/region/source/status/interaction date only where product dimension exists.
- **CRM-042** Versioned template/message definition, variables, preview, provider-specific approved Meta templates **only for Meta Cloud API**, and capability-gated StarSender message content without claiming Meta approval; internal test send, scheduling, safe cancel/retry, quota/cost warnings, human approval, opt-out recheck **at enqueue and delivery**.
- **CRM-043** Per-recipient statuses distinguish `queued`, `provider_accepted`, `delivered` (only if verified), `failed`, `suppressed`, `replied`; correlation, bounce/opt-out/replay behavior; do not claim acceptance = delivered or pixel open = read.
- **CRM-044** Attribute replies, reactivated leads, registration/final conversions and costs only when authoritative events and explainable campaign-link evidence exist. Keep unknown vs zero distinct.
- **CRM-045** One existing queue per approved channel (email, WhatsApp, etc.), no generic arbitrary-send facade and **no automatic cross-channel failover**, especially for revoked consent or provider policy.
- **CRM-046** Mailketing sender/list sync follows API-verified capabilities; existing newsletter double-opt-in and suppression are preserved. Telegram staff-only delivery remains separate from opt-in customer messaging.

### 3.6 Follow-up and human work — stakeholder §7

- **CRM-050** Configurable workflows triggered by admitted lead-stage, unanswered inbound, task deadline, approved registration or campaign events; versioned rules + preview/simulation + scheduled jobs in an auditable queue.
- **CRM-051** A daily owner/team worklist, manual reminders, due/overdue/escalation, SLA policies, templates and frequency caps.
- **CRM-052** Stop or re-evaluate future communications immediately after reply, registration, conversion, `/stop`, unsubscribe, suppression, customer opt-out or revoked sender/account; no unapproved unsolicited bot DM.
- **CRM-053** Explicit human approval for campaigns and sensitive/uncertain responses; deterministic policy always runs **after** any AI recommendation and **before** provider enqueue.

### 3.7 AI knowledge and marketing assistance — stakeholder §8

- **CRM-060** AI drafts replies, summarizes, classifies intent/stage, suggests next steps, drafts campaign copy and detects unanswered knowledge gaps, with tenant-limited context, cost and event tracing.
- **CRM-061** Answers about product/program, terms, pricing, location, facilities, schedule and enrollment procedures may cite **approved, versioned, effective-dated organization knowledge**; uncertain, outdated or conflicting knowledge requires handoff.
- **CRM-062** Modes: `assist` (default, human approves); `limited_auto` (only for verified, low-risk FAQ and explicitly authorized channel/window); `escalate` (sensitive, complaints, pricing exceptions, uncertainty). Operator can disable instantly.
- **CRM-063** The agent may **not invent prices, terms, guaranteed employment or guaranteed foreign deployment, or unapproved claims**. Those industry examples are stakeholder constraints, enforced by configurable prohibited-claim policies. Never train or infer consent from arbitrary conversations.
- **CRM-064** Hermes owns agent execution; OMES supplies supported host/runtime posture and capped/redacted observation; AWCMS owns tenant permissions, knowledge approval, workflow decisions and outbound authorization. Block prompt-injection tool escalation and restricted-data cloud egress.

### 3.8 Reporting, notifications and operations — stakeholder §§9–10

- **CRM-070** Marketing reports: received leads, stage conversions, response rate, campaigns, attrition reasons, paid acquisition cost where known, cohort/channel attribution.
- **CRM-071** Staff/team reports: handled interactions, completed/late follow-ups, first-response distributions, conversion contribution and activity audit; show working hours, assigned workload and channel differences to prevent unfair rankings.
- **CRM-072** Role-scoped notifications: new messages/leads, unanswered/overdue, due follow-up, campaign due/done/failure, broken API connection, daily summary; dedup, quiet hours, channel and tenant role preference.
- **CRM-073** System diagnostics: webhook delivery failures, token expiry, stale provider data, queue lag, dead-letter, consumption cost, credential rotation; immutable audit events without sensitive message content.

## 4. Acceptance tests and launch gates

| Test ID | Required observable evidence |
| --- | --- |
| **AT-01** | Two tenants each have multiple same-platform accounts; no foreign account/contact/conversation/status read or write, even with guessed IDs (RLS FORCE + default-deny). |
| **AT-02** | Website lead can become opportunity/customer/conversion without duplicate master; stage history and source campaign are attributable and reproducible. |
| **AT-03** | Incoming eligible message appears once despite webhook retries, assigned owner sees it; unsupported platform reply remains forbidden. |
| **AT-04** | Follow-up timer respects working calendar/holiday; opt-out or reply between preview and dispatch stops future sends. |
| **AT-05** | A campaign with duplicate imports, disconnected/unverified sender, missing consent or unsupported social DM is refused for invalid recipients. Per-tenant default StarSender selects an authorized StarSender device, explicit Meta selection routes only through an authorized WABA/phone ID; no silent fallback or duplicate dispatch. |
| **AT-06** | Provider acceptance, confirmed delivery, bounce, response, registration and conversion are separately recorded; missing provider data is “unknown”, not 0 or delivered. |
| **AT-07** | AI drafts only within approved knowledge; unsupported promise/price escalates; payload prompt-injection cannot call tools or bypass approval; restricted data remains local-only where required. |
| **AT-08** | KPI source events replay into same projection; business-hours-normalized first-response SLA and conversion denominator are consistent. |
| **AT-09** | Consent withdrawal, data export/deletion, tenant boundary, audit redaction, secret rotation, spoofed webhook and CSV formula payload are covered by negative tests. |
| **AT-10** | `toko`, `berita`, `landing` remain buildable; `template:init` retains neutral branding/content; no provider credentials in fixtures. |

**Definition of Ready:** business glossary + stages; ADR/owner boundaries; threat/privacy model and UU PDP 27/2022 applicability; ERD/data dictionary; RBAC/ABAC/FORCE RLS; provider capability matrix; OpenAPI/AsyncAPI; UX/WCAG; task/notification SLA calendar; consent model; reporting formulas; test fixtures; operations and rollout/rollback. No design review waives these for implementation.

## 5. Status and linked issue backlog

| Capability | Verified status on `main` (24 October 2026) | Owning work |
| --- | --- | --- |
| Commerce customer, CRM segment rules and campaign audiences | **Implemented**; scope is commerce-specific | [AW Business PRD](aw-business-platform-prd.md), [status.md](status.md) |
| Email/Mailketing v1, newsletter double opt-in, email suppression | **Implemented** in AWCMS embed | [AWCMS email](https://github.com/ahliweb/awcms/blob/main/src/modules/email/README.md) |
| CRM lead/prospect/pipeline, dedupe/transition | **Not established** as reusable module | [AWCMS #1163](https://github.com/ahliweb/awcms/issues/1163) (ADR), [#1166](https://github.com/ahliweb/awcms/issues/1166) (implementation) |
| Unified cross-provider inbox, ownership, SLA | **Not established**; commerce inbox is narrower | [AWCMS #1144](https://github.com/ahliweb/awcms/issues/1144) (admission), [#1164](https://github.com/ahliweb/awcms/issues/1164) (inbox/SLA) |
| Multi-account OAuth/provider credentials | **Planned** | [AWCMS #1139](https://github.com/ahliweb/awcms/issues/1139), [#1140](https://github.com/ahliweb/awcms/issues/1140) |
| WhatsApp StarSender and Meta multi-number | **Planned**; LPP product configuration: StarSender default, Meta selectable alternative (owner supersedes source transport clause) | [AWCMS #1141](https://github.com/ahliweb/awcms/issues/1141)–[#1143](https://github.com/ahliweb/awcms/issues/1143), [AWCMS-One #458](https://github.com/ahliweb/awcms-one/issues/458) |
| Telegram staff notifications | **Implemented**, staff-only; no customer blast | [AWCMS module](https://github.com/ahliweb/awcms/blob/main/src/modules/telegram-delivery/README.md) |
| Telegram CRM and channel posts | **Planned**, separate admitted capability | [AWCMS #1155](https://github.com/ahliweb/awcms/issues/1155)–[#1157](https://github.com/ahliweb/awcms/issues/1157), [AWCMS-One #460](https://github.com/ahliweb/awcms-one/issues/460) |
| Social publishing and other social message capability | **Planned**; no-op port today | [AWCMS #1145](https://github.com/ahliweb/awcms/issues/1145) and platform-specific issues |
| Mailketing v2, many senders, status webhooks | **Planned** | [AWCMS #1158](https://github.com/ahliweb/awcms/issues/1158)–[#1162](https://github.com/ahliweb/awcms/issues/1162); [AWCMS-One #461](https://github.com/ahliweb/awcms-one/issues/461) |
| Hermes AI CRM recommendation, AI Management | **Planned**; OMES observability exists | [AWCMS-One #459](https://github.com/ahliweb/awcms-one/issues/459); [OMES #343](https://github.com/ahliweb/omes/issues/343)–[#344](https://github.com/ahliweb/omes/issues/344) |
| Follow-up sequence engine and CRM conversion KPIs | **Not established** | [AWCMS #1165](https://github.com/ahliweb/awcms/issues/1165) (follow-ups), [AWCMS-One #464](https://github.com/ahliweb/awcms-one/issues/464) (KPIs) |

**Implementation sequence:** approve generic lead/prospect/pipeline, conversation/SLA and event boundary ADRs; implement upstream public ports with tests; sync `apps/cms` by full-history **MERGE COMMIT** (never squash/rebase); add `commerce` adapters/reporting here; verify all profiles and derived template neutrality. Separate issue and branch for each atomic implementation. No change to applied migration history or root `bun.lock`.

## 6. Mapping to the LPP ENTER example (not template defaults)

| Stakeholder term | Neutral CRM extension | Source |
| --- | --- | --- |
| Training program | Product/service interest dimension | §§1, 6, 8, 9 |
| Cohort / angkatan | Optional campaign or cohort dimension | §6 |
| Participant registration | `registered` configured event/stage | §§1, 8, 9 |
| Re-registration | `converted` or custom `re_registered` verified event | §§1, 8, 9 |
| Marketing administrator | Scoped assignee/team | §§1, 3, 7, 9, 10 |
| Program price/schedule/requirements | Approved knowledge with effective date and source | §8 |
| WhatsApp transport choice | **LPP decision 24 Oct 2026:** `starsender` default per product tenant/brand; `meta_cloud_api` selectable alternative; supplier source §6 official-only clause superseded by owner | §2, §6 + owner override |
| Job placement/overseas-departure claim | Forbidden promise / escalate-to-human policy | §8 |

No business-specific data or provider token is imported into the template. A product derived from AWCMS-One owns its own production backend, tenant-specific settings, UAT and deployment. The authoritative source document should remain in the product's requirements repository, with this standard holding only neutral, promoted controls.

## 7. Atomic execution ownership (validated gaps, 24 October 2026)

1. [AWCMS #1163](https://github.com/ahliweb/awcms/issues/1163) **architecture first** → [#1166](https://github.com/ahliweb/awcms/issues/1166) `crm_leads` generic lifecycle; neutral pipeline stages, no duplicate commerce customer.
2. [AWCMS #1144](https://github.com/ahliweb/awcms/issues/1144) verified inbound architecture → [#1164](https://github.com/ahliweb/awcms/issues/1164) unified inbox/assignments/SLA; do not replace the commerce-specific inbox without a reviewed adapter.
3. [AWCMS #1165](https://github.com/ahliweb/awcms/issues/1165) deterministic follow-up tasks and notification policy; reuse notifications and workflow, no duplicate agent runtime.
4. [AWCMS-One #463](https://github.com/ahliweb/awcms-one/issues/463) **commerce adapter only** for lead→customer and verified conversion facts; product stages remain the product's own.
5. [AWCMS-One #464](https://github.com/ahliweb/awcms-one/issues/464) existing reporting engine lead funnel/attribution/admin SLA projections; define metric contracts before code.
6. Existing targeted consumers remain [#458](https://github.com/ahliweb/awcms-one/issues/458), [#459](https://github.com/ahliweb/awcms-one/issues/459), [#460](https://github.com/ahliweb/awcms-one/issues/460), [#461](https://github.com/ahliweb/awcms-one/issues/461) and upstream [#1139](https://github.com/ahliweb/awcms/issues/1139)–[#1162](https://github.com/ahliweb/awcms/issues/1162) where relevant. Do not open duplicate provider-engine issues.

All listed implementation issues are **open/planned** at publication, and require their own branch/PR and validation. This documentation PR is **requirements-only**.

## 8. WhatsApp provider selection policy — decision amendment (24 October 2026)

**Decision scope:** For a derived **LPP ENTER** product, set the default provider policy to `starsender` after verified tenant device enrollment; offer `meta_cloud_api` as an alternate selectable provider. For **AWCMS-One as a reusable template**, keep this value **unconfigured / requires tenant operator choice** by default, rather than embedding LPP's settings or provider keys. This is a deliberate owner override of the uploaded source's §2/§6 official-only wording, **not** a change to the historical source document.

### Multi-sender routing and permission requirements

- **WA-SEL-01** Configure `tenant_id + business_scope/brand_id + default_sender_account_id + default_provider_kind` with a verified account binding and audit; no deployment-wide global sender accidentally reused across tenants. Product-specific `starsender` default is only activated after required device credentials, service status, consent and risk acknowledgment; otherwise fail closed, **not** implicit Meta substitution.
- **WA-SEL-02** Allow an operator to register **multiple StarSender devices** and **multiple Meta WABA/phone_number_id identities**, see state/capability/cost visibility and choose an eligible exact sender for a campaign/conversation. A provider switch requires explicit authorization and a prospective configuration version; queued messages remain pinned to their original sender and are not silently redirected.
- **WA-SEL-03** Maintain the **existing upstream `whatsapp_delivery` queue**, purpose/consent and per-message template rules. For Meta Cloud API, require approved message templates and enforce its 24-hour service window where applicable; for StarSender validate its own API messageType/body/media and allowlisted endpoint. Provider-neutral marketing consent and opt-out are mandatory for **both**.
- **WA-SEL-04** Refuse cross-tenant sender selection, duplicate campaign fan-out, a disconnected/banned StarSender device, revoked Meta phone/token, unsupported media/message mode, missing consent or a wrong-tenant inbound webhook. Do not rotate numbers/devices as an anti-spam workaround; rate limits and circuit breakers are per sender, with an emergency stop and manual human escalation.
- **WA-SEL-05** Status must distinguish `queued`, `provider_accepted`, `verified_delivered`, `failed`, `unknown`, `suppressed`. StarSender's successful API response is **not** verified delivery. If StarSender webhook authentication cannot be established, do not trust inbound CRM mutations or final status updates; record unknown and require approved compensating controls or defer intake.
- **WA-SEL-06** Provide staged acceptance with one tenant default StarSender + two devices, manual Meta switch + two phone IDs, another tenant with opposite default, outages/reconnects, revocation, webhook spoofing, rollback, consent withdrawal before send, repeat crash and idempotency; maintain neutral template profile `toko/berita/landing`.

**Threat and commercial note:** StarSender expressly describes its service as *not official WhatsApp API* and warns of number/account blocking. The operator must acknowledge account, privacy, continuity and vendor-data exposure risks. The preferred default is **an owner deployment decision**, not a claim of Meta endorsement, guaranteed no-ban delivery, or permission to send unsolicited marketing. [StarSender send API](https://docs.starsender.online/docs/message-api/kirim-pesan/); [StarSender webhook docs](https://docs.starsender.online/docs/webhook/); [StarSender FAQ](https://starsender.id/); [WhatsApp Business policy](https://whatsappbusiness.com/id/policy/).

**Tracking:** [AWCMS #1139](https://github.com/ahliweb/awcms/issues/1139) ADR, [#1141](https://github.com/ahliweb/awcms/issues/1141) routing, [#1142](https://github.com/ahliweb/awcms/issues/1142) StarSender, [#1143](https://github.com/ahliweb/awcms/issues/1143) Meta, [#1154](https://github.com/ahliweb/awcms/issues/1154) Admin; [AWCMS-One #458](https://github.com/ahliweb/awcms-one/issues/458) CRM targeting. Separate e2e test work is to be linked after issue creation.
