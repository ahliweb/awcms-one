🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](omnichannel-crm-ui-ux.id.md)

# AWCMS-One Omnichannel CRM — comprehensive UI/UX and product interaction specification v1.0

**Status: proposed design contract, 24 October 2026. NOT a claim that future screens are implemented.** Tracking [#472](https://github.com/ahliweb/awcms-one/issues/472). Implementation evidence: [status.md](status.md), [cms.md](cms.md), [Business PRD](aw-business-platform-prd.md), [CRM SRS draft #465](https://github.com/ahliweb/awcms-one/pull/465); Bun runtime [#467/#468](https://github.com/ahliweb/awcms-one/pull/468). Owner repositories: [AWCMS](https://github.com/ahliweb/awcms), [AWCMS-Astro](https://github.com/ahliweb/awcms-astro), [OMES](https://github.com/ahliweb/omes).

## 1. Executive decision record, evidence grading, versions

- **Existing AWCMS-One commerce UI:** Astro /admin/commerce-customers, /admin/commerce-segments, /admin/commerce-campaigns, /admin/commerce-inbox, /admin/commerce-whatsapp, /admin/commerce-reports, /admin/commerce-settings, plus orders/booking/POS. Implemented UI does **not** imply a generic omnichannel inbox or full lead pipeline.
- **Existing AWCMS upstream UI:** /admin/email*, /admin/email-suppression, newsletter, /admin/whatsapp, /admin/omes/*, push and staff Telegram module. Upstream social publishing port currently has a noop consumer; registered TikTok/LinkedIn/YouTube account connection is **planned**, not shipped.
- **Existing OMES screens:** AWCMS owns the operator web screens for servers/deployments/jobs/operations/health/backup/audit/enrollment and read-only Mission Control. OMES owns native host lifecycle; Hermes owns agent reasoning/runtime. Future AI management controls are planned.
- **Future CRM modules:** upstream lead/pipeline [#1163/#1166](https://github.com/ahliweb/awcms/issues/1166); inbox/SLA [#1144/#1164](https://github.com/ahliweb/awcms/issues/1164); follow-up [#1165](https://github.com/ahliweb/awcms/issues/1165); downstream conversion map [#463](https://github.com/ahliweb/awcms-one/issues/463), CRM reporting [#464](https://github.com/ahliweb/awcms-one/issues/464), campaigns/social [#458](https://github.com/ahliweb/awcms-one/issues/458), Telegram [#460](https://github.com/ahliweb/awcms-one/issues/460), Mailketing [#461](https://github.com/ahliweb/awcms-one/issues/461) and AI [#459](https://github.com/ahliweb/awcms-one/issues/459).
- **Version baseline:** main AWCMS-One/Bun 1.4.3, AWCMS/Bun 1.4.3, AWCMS-Astro/Bun 1.4.2. **Latest stable verified 24 Oct 2026 Bun 1.4.4 (22 Oct).** Upgrade issues AWCMS [#1172](https://github.com/ahliweb/awcms/issues/1172), AWCMS-One [#470](https://github.com/ahliweb/awcms-one/issues/470), Astro [#125](https://github.com/ahliweb/awcms-astro/issues/125). Current Mailketing adapter **v1**, required target **REST v2.0.2** (23 Oct 2026) [AWCMS #1159](https://github.com/ahliweb/awcms/issues/1159), not yet shipped. Do not label v2-connected UI as live.
- **Version policy:** pinned latest *verified-compatible* stable, weekly bun outdated + bun audit plus SDK/Docker/OS report, security hotfixes ASAP, patch/minor small PRs, major changes ADR + staged regression + rollback; no floating production tag, no manually edited bun.lock, no false claim all libraries already newest. AWCMS [#1173](https://github.com/ahliweb/awcms/issues/1173), AWCMS-One [#471](https://github.com/ahliweb/awcms-one/issues/471), Astro [#126](https://github.com/ahliweb/awcms-astro/issues/126), OMES [#347](https://github.com/ahliweb/omes/issues/347).

## 2. Experience principles and immutable architectural constraints

Use existing Astro SYSTEM admin shell and its design primitives (.admin-stat-card, .admin-status-pill, .admin-segmented, .admin-filter-bar, .admin-two-pane, .admin-timeline, .admin-toggle, .admin-media-grid), existing tokens/styles and bilingual catalogs. Preserve dark/light modes and high-contrast status semantics; **do not create a parallel React/Node-based admin or a second CRM customer master**. AWCMS is backend/tenant/security/channel authority, commerce is customer/segment/campaign authority, derived products own their business-specific attributes. AWCMS-One remains a reusable template; no hard-coded LPP ENTER identity/program/cohort.

Core UI invariants: a disabled/hidden action is **not authorization**; all API decisions default-deny and recheck tenant, actor, account and scope. Broadcast requires consent/purpose, suppression and sender checks during preview, enqueue and send. Empty is not zero, stale is not online, accepted-by-provider is not delivered. No UI can claim unapproved platform API capabilities. No raw tokens/OTP, personal conversations, user model prompts or private provider callbacks in rendered HTML, logs, downloadable CSV or telemetry.

**WhatsApp product configuration:** LPP ENTER chooses **StarSender as its tenant default**, with explicit Meta Cloud API alternative. Generic AWCMS-One template must not assume that default; StarSender is unofficial and may be blocked. Make risk acceptance, device health and account choice visible, never automatic anti-ban sender rotation or fallback. Consent remains mandatory either way.

**Realtime boundary:** email, WhatsApp, Telegram, social provider and push sends use durable **Bun** queues → vendor HTTPS API. Existing email/WhatsApp/push dispatchers run Bun. Proposed SSE (one-way dashboard status) / Bun native WS (proven duplex) only after upstream [#1168](https://github.com/ahliweb/awcms/issues/1168); gateway [#1171](https://github.com/ahliweb/awcms/issues/1171) NOT shipped. Closed browser notifications require opted-in Web Push, not open WS. Hermes-native and OMES host Python pull-worker are not replaced.

## 3. IA / navigation hierarchy and persona permissions

Desktop shell: persistent tenant/brand selector in context bar, global search, approved notification center, job status, help and account menu. Compact left nav with groups: **CRM** (Overview, Leads, Customers, Pipelines, Inbox, Follow-up, Segments, Campaigns); **Channels** (Accounts, WhatsApp Numbers, Email/Mailketing, Telegram, Social Publishing, Website Forms); **Analytics** (Funnel, Attribution, Staff SLA, Delivery Logs); **Automation** (Rules, AI Assist, Knowledge, Approvals); **System** (Roles, Audits, OMES Control Center, Service Health). Only existing routes are clickable; planned pages must be absent or behind explicit feature flags and show a truthful preview/not-available state, not a dead link.

Personas and actions:
| Persona | View scope | Allowed intent | Hard restriction |
| --- | --- | --- | --- |
| Owner/system admin | Authorized tenants/health | Global tenant permissions and channel-policy governance | Cannot silently access content across tenants |
| Tenant admin/marketing lead | One tenant, permitted brands | Connections, segmentation, approve campaigns, reports | No unauthorized business/account actions |
| Marketing operator | Assigned channels | Draft campaigns, contact eligible leads, follow-ups | Cannot approve own protected blast when SoD required |
| Customer support agent | Assigned conversations | Reply where provider and privacy permit; internal notes | No unrestricted exports, cross-tenant or bot tool escalation |
| Finance/analyst | Granted aggregate/report data | Metrics and authorized exports | No provider credentials, full message bodies |
| AI/Hermes proposal | Sanitized scoped context | Classify, summarize, suggest draft and action plan | Cannot bypass policy or self-authorize send |
| External site visitor/customer | Own form/account only | Submit lead/consent, withdraw, device opt-in | No system admin or protected analytics |

Permission vocabulary is illustrative only: use actual upstream AWCMS RBAC/ABAC names and public contracts before implementation, never invent an already-working permission string. Every tenant/brand switch invalidates scoped cached UI data and active SSE/WS subscriptions.

## 4. Screen catalogue: evidence vs delivery plan

| ID | Screen / route or target | State | Primary owner and issue |
| --- | --- | --- | --- |
| UX-01 | Existing commerce customer list /admin/commerce-customers | IMPLEMENTED | AWCMS-One commerce |
| UX-02 | Existing customer segments /admin/commerce-segments | IMPLEMENTED (feature-gated) | commerce #360, #362 closed |
| UX-03 | Existing campaigns /admin/commerce-campaigns | IMPLEMENTED (feature-gated) | commerce #114 closed |
| UX-04 | Existing commerce inbox /admin/commerce-inbox | IMPLEMENTED (narrow commerce inbox) | commerce #111 closed |
| UX-05 | Existing commerce WhatsApp /admin/commerce-whatsapp | IMPLEMENTED (legacy/upstream mode) | ADR-0047, issue #449 |
| UX-06 | Commerce reports, dashboard, booking, POS | IMPLEMENTED by existing modules | docs/cms.md/status.md |
| UX-07 | Existing upstream Email templates/announcements/suppression, /admin/whatsapp | IMPLEMENTED (deployment and flags matter) | AWCMS email/whatsapp_delivery READMEs |
| UX-08 | Existing OMES overview, servers, jobs, health, backups, audit and read-only views /admin/omes/* | IMPLEMENTED (authorization-limited) | OMES #200/#201, AWCMS |
| UX-09 | Unified CRM executive funnel dashboard | PLANNED | #464 / AWCMS #1166 |
| UX-10 | Lead intake/list/detail/merge | PLANNED | AWCMS #1163/#1166, One #463 |
| UX-11 | Configurable deal/pipeline kanban | PLANNED | upstream #1163/#1166 ADR |
| UX-12 | Unified cross-provider inbox, tags, assignment and SLA | PLANNED | upstream #1144/#1164 |
| UX-13 | Multi-account Channel Hub + OAuth/health | PLANNED | AWCMS #1139/#1140/#1154 |
| UX-14 | WhatsApp sender vault: StarSender multiple devices + Meta WABA/phone | PLANNED | upstream #1141/#1142/#1143, One #466 |
| UX-15 | Mailketing v2 connection/senders/credits | PLANNED (v1 adapter is actual) | AWCMS #1158–#1162, One #461 |
| UX-16 | Telegram bots/channels account center | PLANNED (staff notification module actual) | AWCMS #1155–#1157, One #460 |
| UX-17 | Facebook/Instagram account and capability map | PLANNED | AWCMS #1146 and upstream platform adapter |
| UX-18 | TikTok, LinkedIn, YouTube, Threads connectors | PLANNED/RESEARCH | AWCMS #1148/#1150/#1149/#1151 |
| UX-19 | Social publishing calendar/approval | PLANNED | AWCMS #1145, #1147–#1152 |
| UX-20 | Website lead capture, consent manager | PLANNED as CRM flow (website exists) | AWCMS-Astro #127 and upstream lead port |
| UX-21 | Advanced audience preview, CSV importer and dedupe | PARTIAL: segments/campaign preview exist | One #458/#461, AWCMS #1166 |
| UX-22 | Campaign composer with multi-provider sender selection, approval/scheduling | PARTIAL: commerce campaigns exist | One #458/#461 |
| UX-23 | Campaign progress/delivery timeline and status stream | PARTIAL via existing queue/poll; realtime gateway PLANNED | AWCMS #1168/#1171 |
| UX-24 | Follow-up worklist, automation builder, deadlines | PLANNED | AWCMS #1165 |
| UX-25 | AI copilot, approved knowledge, prompt guardrails and escalation | PLANNED; OMES read-only observations already exist | One #459, OMES #343/#344 |
| UX-26 | Conversion/attribution/staff SLA reports | PARTIAL: commerce reports exist | One #464 |
| UX-27 | Notification center + customer Web Push preference | PARTIAL upstream push; customer flow PLANNED | One #430–#432 |
| UX-28 | OMES AI governance, process tree, Mission Control | PARTIAL read-only status; AI management PLANNED | OMES #263/#343/#344 |
| UX-29 | Provider outage, quota, revocation and audit center | PARTIAL module logs; unified view PLANNED | AWCMS #1154/#1161/#1171 |
| UX-30 | UI release-readiness/dependency health | PLANNED as operator diagnostics; not auto-upgrade | AWCMS #1172/#1173; One #470/#471 |

**Implementation status is evidence-sensitive and feature-flag-sensitive; these entries are not links to deployable planned routes.** Validate again against live main before closing each issue.

## 5. Cross-screen wireframe conventions

Desktop ≥1200px: context bar (tenant, brand, breadcrumbs, freshness), nav ~240px, content max ~1440px, filter row, 12-column content grid, card/table/detail split based on task. Tablet 768–1199px: collapsible nav, stacked filters, responsive 2-column cards and table column prioritization. Small screens below 768px: drawers instead of permanent sidebars, one primary action sticky if safe, accessible accordion filters and horizontally scrollable data with labels; no essential action on hover only. Breakpoints are proposed tokens to harmonize with existing CSS, **not arbitrary replacements**.

Common screen anatomy: heading + status/provenance + contextual CTA; typed filter controls with Reset and Save View when authorized; paginated table showing owner/account/tenant; empty/loading/error/permission/stale states; detail drawer with activity timeline and redacted audit; confirmation modal for irreversible operations; aria-live message region and toast that never reveals personal data. Reuse upstream CSS primitives and read-first/deny-by-default permission checks.

Loading skeleton is not “0 contacts”; network timeout gets Retry, stale last-success timestamp and a safe REST snapshot. Empty zero-state provides authorized onboarding action; disabled providers show connection/explanation link. Error recovery never silently submits twice.

## 6. Per-screen specification and field/action inventory

### UX-09 CRM Overview
KPI cards: New leads, contacted, qualified, due follow-ups, registered, converted, first-response median, opt-out-adjusted eligible audience. Filters tenant/brand/period/timezone, account, campaign, owner, configurable dimension. Chart funnel with stage-version label and explicit denominator; separate current queue totals and provider acceptance/delivery. Drilldowns must reauthorize and preserve filter. Empty state “No eligible events in selected period”, not “0 delivered” for unavailable webhooks. Owner sees scoped operator aggregates, not raw inbox content. Desktop summary+funnel+due list; phone summary and accordion. Gated by #464; current commerce dashboard remains unaffected.

### UX-10 and UX-11 Leads + Pipeline
Columns Lead, verified contact handle masked, source account, source/campaign, owner/team, current stage, next action, last interaction, consent evidence. Actions create from permitted form/manual entry, assign, tag, stage transition, schedule task, review duplicate, link existing commerce customer only with verified proof. Filters stage version, age, channel and SLA. Detail tabs Overview / Timeline / Conversations / Tasks / Consent / Audit. Pipeline card drag/drop MUST validate legal transitions and optimistic revision; keyboard offers Move stage menu and undo/compensation where allowed. Unconfirmed lead cannot be represented as a paid customer. No universal training/cohort fields; products configure dimensions.

### UX-12 Unified Inbox
Two-pane desktop: left account+channel filters, saved views (Unassigned, Mine, Team, Overdue, Pending Approval), thread list and unread/first-response SLA; right transcript with timestamp, role, verified sender, supported attachment, internal note and composer. Mobile one-pane list→detail→back, drafts preserved. Actions claim/transfer, note/tag, quick-reply, eligible response, close/reopen, assign follow-up and AI draft request. **Reply button capability gated by provider permission + conversation window + consent/policy**; disabled with specific reason. Agent collision prevents double reply and shows recent editor/conflict. Browser must not get credentials or unapproved raw webhook.

### UX-13 Channel Connections Hub
Registry table Provider, account alias, tenant/brand, capabilities (publish, reply, DM, lead_ads, comments, insights, broadcast), sender identities, health, last verified time, token-expiry state, quotas, connected-by. Connect wizard: choose provider → authenticate OAuth/API token server-side → verify ownership/scope → test capabilities → assign brands/roles → acknowledge risk where applicable → choose default sender and save. Disconnect wizard warns queued work; revocation rechecks authorization and marks unknown until confirmed; do not leak secrets or silently recycle identity across tenants. Account-level capability matrix determines what UI features render.

### UX-14 WhatsApp Multi-number Manager
List multiple StarSender device IDs and Meta WABA/phone_number IDs with mask/name, tenant, readiness, throughput/quota estimate, template ability, last event, risk flag. Tenant/brand default selector; **LPP ENTER product sets StarSender default only after operator risk acknowledgment and healthy device**; generic template has no default. Explicit per-campaign sender selection available; change default affects new enqueues, not existing queued rows. Meta flow requires verified WABA/phone and approved template where applicable; StarSender flow validates documented vendor message/media capability but cannot claim Meta certification. No automatic cross-provider fallback, no number rotation to bypass restrictions. Confirmation previews impacted campaigns and provides disable/manual rollback. Failure states Disconnected, Unverified, Blocked, Credential expired, Webhook untrusted, Unknown delivery.

### UX-15 Mailketing API v2.0.2 Manager
Provider version badge **Target v2.0.2 (NOT yet live; upstream adapter still v1)**. Connection cards tenant/brand/account/verified from_email and domain, API token masked reference, credit balance and fetched-at timestamp, approved sender selector. Operations limited to documented **POST /api/v2/send**, **GET /credits**, **GET /senders**, **GET /lists**, **POST /subscribers**; corporate functionality only behind explicit verified capability. No made-up vendor campaign create/list delete/unsubscribe endpoints. Migration banner “v1 adapter active” until operator verifies opt-in v2 cutover; no production flip from an admin UI without backend gates. Mapping remote list ID↔CRM segment version, source opt-in, reversible sync status and errors. **Mailketing v2.0.2 always creates message_id**: display internal queue id and provider id in separate copyable redacted fields; HTTP accepted/queued ≠ delivered. 402 credits low, 403 unverified sender, 422 bad recipient, 429 with Retry-After, 5xx retryable, stale/unknown; no secret on URL/body. Webhook status only after trusted authentication review #1161, open/click subject to tracking limitations.

### UX-16 Telegram Bot & Channels
Bot account nickname, masked Bot ID/token secret reference, verified webhook and chat permissions, channel membership/admin posting rights. Separate **existing internal staff notifications** from **planned customer engagement**; no customer unsolicited bot messages. Conversation composer present only for eligible customer-initiated chats and supported Bot API abilities. Posting review with target channel, permitted media and status. Account quarantine on invalid webhook/removed bot/admin rights.

### UX-17–19 Social Account Hub and Publishing
Per platform **actual approved permissions** shape the UI:
Facebook Pages/Messenger and Instagram Professional through approved Meta scopes where supported; TikTok publish/analytics only after reviewed API rights, no general DM assumed; YouTube channel uploads/comments/analytics where supported, no DM; LinkedIn organization/page and professional permissions conditional, no unauthorized member enrichment; Threads supported publish/reply/insight APIs subject to access; optional X/LINE/Pinterest/Google Business Profile through provider admission matrix. Multi-account picker and brand association. Calendar views Day/Week/List, content preview per platform/aspect ratio, draft/approval/schedule status, alt text and captions, linked media with copyright/license verification. “Cannot publish: API permission missing” is not a network success. Preserve account-specific post URL/ID and reauth on token expiry.

### UX-21–23 Segment and Campaign Workbench
Segment builder reuses **existing versioned, closed-vocabulary commerce rules**; preview matched count/sample with privacy masking and consent-exclusion estimate; saved segment version remains immutable. Composer steps **Goal → Channel → Sender identity → Audience/consent → Template/content → Policy/compliance → Test → Approval → Schedule → Review**. Display estimated recipients after dedup/suppression and per-provider cost/credit when known; show hard-block reasons as table + accessible summary. A/B test is **future** and never bypasses opt-in. At send: confirm provider/version/number, immutable audience snapshot, approval separation and idempotency. Delivery dashboard statuses queued, claimed, provider_accepted, verified_delivered, unknown, failed, suppressed, replied, converted with provider capability labels; cancel only unsent work and clearly state in-flight uncertainty. Bun queue does provider HTTPS; optional SSE/WS later streams bounded status. Download CSV must sanitize spreadsheet formulas and PII.

### UX-24 Follow-up Worklist & Rules
Personal/team “Today, Due, Overdue, Waiting, Completed” with timezone and working calendar. Task details lead, stage, priority, due, owner, last response, upcoming allowed channel, reason to stop. Rule builder only after upstream admission: WHEN typed event, IF consent/channel/segment predicates, THEN create task or propose approved template, cap frequency, require review. Dry-run and version/diff before activation; emergency Stop Automation for entire tenant or account; reply, conversion, unsubscribe or blocked account cancels future eligible sends. Role-based escalation schedule and fair SLA, never auto-send provider DM without legitimate eligibility.

### UX-25 AI Assist and Knowledge
Right side copilot opens on selected authorized thread/lead. Modes Assist (default), Limited Auto (approved low-risk FAQ only), Escalate (uncertainty, complaints, pricing exceptions). Panel shows approved knowledge source, version/effective date, excerpt citation, confidence/unsupported markers, PII classification, cost estimate and manual Approve/Edit/Reject. Auto-mode scope by tenant+channel+intents+knowledge version; rollback instant. Prohibit invented prices, employment/overseas placement guarantees, third-party account browsing, untrusted prompt-driven tool calls or vendor credentials in prompts. Status pending/approved/rejected/expired, human override audit; Hermes agent runtime handles reasoning, OMES only host observation.

### UX-26 Reporting & SLA
Funnel formula definitions with numerator/denominator/lookback; per-account campaign/paid-order conversion attribution only from verified events. Agent SLA shows workload and business-hour normalization, not naïve productivity rankings. Filters with export scope warning; anonymous aggregate where necessary. Missing provider delivery receipts marked Unknown, not zero. Audit each report version and last-computed-at. Reuse commerce reporting engine, no second analytics warehouse.

### UX-27 Preferences and Notifications
Customer opt-in by channel/purpose for newsletters, WhatsApp marketing and Web Push; check consent timestamp/source and unsubscribe/stop status. iPhone installation instructions when PWA activation is needed and browser permission prompt occurs only after clear user action. Notification center for operators: assigned inbound, overdue, budget quota, campaign status and token expiry; per-role quiet hours, read/ack and dedup. Browser-closed updates depend on Web Push (planned customer flow #430–432); no persistent WebSocket claim.

### UX-28 OMES AI / Mission Control
Use **existing OMES visual tokens** and AWCMS /admin/omes observation as primary; do not duplicate OMES host console in CRM. Status tree shows host / Hermes session / subagent with provenance, freshness, redacted summarized cost/budget/policy, escalation/approval only through allowlisted typed contracts. Live-but-stale distinction, user view of responsible operator, irreversible action confirmation; no direct host terminal, private memory DB or public privileged socket. AI management planned #343/#344; 3D organizational twin planned #263, fallback accessible 2D screen required. See [OMES design system](https://github.com/ahliweb/omes/blob/main/docs/ui-ux-design-system.md).

### UX-29/30 Health, Security and Release Status
System status cards: providers connected/unknown/offline, failed webhooks/retries, per-sender credits, last audit, circuit breaker, worker queue lag, Bun version (installed vs latest **verified**), compatible upstream revision, dependency audit age, provider API version and vulnerability holdback. External vendor errors scrub secrets and recipients; no “all updated” success badge based merely on manifest range. Upgrade flow: detect latest → compare changelog/security → atomic issue/PR → review tests → staging/canary → explicit promote → rollback. No web UI button executing arbitrary package updates on managed hosts.

## 7. Four high-priority journey contracts

**J1 Lead to conversion:** verified website form or provider event → dedup/provenance → lead list/new stage → owner assignment → eligible inbox message → policy-approved human/AI draft → follow-up task → verified registration/paid conversion → report recalculation. Any denied action produces a reason, not a silent send.

**J2 Mailketing v2 campaign:** verified multi-account sender + sufficient credits → segment immutable revision → marketing consent eligibility → composer → test on an opted-in address → dual approval → Bun email queue → Mailketing v2.0.2 accepted with provider-generated message_id → trusted webhook/reconciliation → attribution and unsubscribe/suppression. If v1 backend only, **disable v2-specific publish UI and show migration needed**.

**J3 WhatsApp dual provider:** tenant LPP config default StarSender after acknowledgement; user selects alternate Meta number explicitly for a campaign → preview provider-specific allowed template/content → approval → durable Bun WhatsApp queue pinned to sender → verified callback or Unknown; disconnect blocks future sends and never silently substitutes another device.

**J4 OMES-assisted reply:** authorized conversation → AWCMS sends sanitized typed context to Hermes via accepted adapter → knowledge-anchored draft → employee approves → AWCMS checks permission, purpose, opt-out, provider window → provider-specific Bun queue → status projection. OMES shows runtime health/policy as read-only; managed host accepts no inbound privileged WS.

## 8. Detailed interaction, a11y and security QA checklist

| Category | Required acceptance |
| --- | --- |
| Keyboard | All dialogs, command menus, drag pipeline alternatives, tables, focus restore and accessible escape paths |
| Contrast | WCAG 2.2 AA text and non-text states, not color-only flags, status includes icon/text |
| Mobile | At 360px and 390px forms legible, large touch targets, list/detail nav and safe sticky actions |
| Global | Tenant switch clears cached data, source-context shown, no dead planned nav, no flashing “success” before provider acceptance |
| API/consent | Feature flag not authorization, wrong tenant/sender always 403, no consent inference from CSV or imported list, unsubscribe rechecked at dispatch |
| Realtime | Wrong Origin, expired ticket, removed role, cross-tenant topic, replay after reconnect, slow consumer/backpressure, multi-instance fallbacks and privacy |
| Provider | 401/402/403/422/429/5xx, stale credit, unverified sender, revoked OAuth, disconnected StarSender, consent withdrawn during in-flight queue |
| AI | Prompt injection, hallucinated price, missing effective-date knowledge, sensitive PII to model, reject/edit/undo and operator kill-switch |
| Data | User export/delete, masked customer search, audit immutability, sensitive logs redacted, CSV formula neutralization |
| Performance | Bounded queries/pagination, skeletons not zero, accessible chart tables, network retries, no oversize client scripts |
| Deployment | Latest-compatible Bun pinned with rollback; dependency/latest/held-back matrix; no Node microservice; all profiles and template:init pass |

## 9. Deliverables and traceability requirements

Developer-ready screen tickets must include **UX ID, Figma link (if supplied), current code/route, owning issue, permission, input DTO, state diagram, empty/loading/error flows, responsive behavior, tests, i18n keys and screenshot evidence**. Do not generate screenshots of real customer identities or secrets. Do not use a “simulated done” mock to imply an API integration exists.

Implementation waves: P0 newest verified Bun and Mailketing v2 contract, account registry/consent and tenant privacy; P1 lead/inbox/WhatsApp/email sender UI; P2 campaigns/follow-up and attribution; P3 AI approvals + social multi-account publishing; P4 bounded realtime gateway after ADR and enhanced reporting/OMES. All waves gated by reusable AWCMS upstream first, AWCMS-One subtree sync via **MERGE COMMIT only**, SSG profile and derived-template checks, and individual atomic issues/PRs.

### External ground truth
[Mailketing API v2.0.2](https://api.mailketing.co.id/docs/) (server-generated message_id; documented send/credits/senders/lists/subscribers only); [Mailketing webhook](https://api.mailketing.co.id/docs/webhook.html) (signature trust not established); [Bun v1.4.4](https://bun.com/blog/bun-v1.4.4); [Bun outdated](https://bun.com/docs/pm/cli/outdated); [Bun audit](https://bun.com/docs/pm/cli/audit); [Bun update](https://bun.com/docs/pm/cli/update). All latest-version assertions are dated; refresh before implementation.
