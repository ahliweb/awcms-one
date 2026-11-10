🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](carikbot-conversation-reference.id.md)

# CarikBot Concept Reference — Conversation, Services and Authority

**Version:** v1.0.0 | **Updated:** 2026-11-10 | **Status:** F0 research/proposal, not released functionality.
**Document changeset:** Initial conceptual adaptation of CarikBot ecosystem/engine with repository-specific ownership, security, tests and phased readiness.
**Reference only:** https://github.com/CarikBot/ecosystem and https://github.com/luridarmawan/Carik. No copying source code or migration to Free Pascal/FastPlaz/legacy PHP.

## Evidence and historical context
Carik evolved around a lightweight intent/entity/handler chatbot engine and conversational service packages; the Carik engine README describes FastPlaz, SimpleBOT and SimpleAI with Pascal/FPC builds. The ecosystem README documents a mind-map (Freemind/XMind) to JSON menu flow, service package registry and an approval-oriented distribution claim. API documentation illustrates POST with actor/channel/message metadata, code/text responses with menu/button/form variants, webhook and push-message examples. These are **verified documents / design claims**, not evidence that each service is currently deployable.

- [Carik Bot engine](https://github.com/luridarmawan/Carik/blob/master/README.md) and [build script](https://github.com/luridarmawan/Carik/blob/master/build.sh).
- [Mind flow](https://github.com/CarikBot/ecosystem/blob/main/docs/mindmap-structure.md), [package registry](https://github.com/CarikBot/ecosystem/blob/main/data/package.json), [API / rich actions](https://github.com/CarikBot/ecosystem/blob/main/docs/api-structure.md), [webhook](https://github.com/CarikBot/ecosystem/blob/main/docs/webhook.md), [push API](https://github.com/CarikBot/ecosystem/blob/main/docs/api-push-message.md).
- [ecosystem/package.json](https://github.com/CarikBot/ecosystem/blob/main/package.json) declares MIT, while its test script is a failing placeholder. [Carik/LICENSE.txt](https://github.com/luridarmawan/Carik/blob/master/LICENSE.txt) is a copyright assertion with **no explicit code-reuse permission**. Do not copy code or assets. Third-party package rights need separate review.

## Target concept — NOT implemented
A **provider-independent, typed conversation presentation contract** MAY describe menu, button, form, safe text fallback, human handoff and authorized operation reference. It is NOT a new agent runtime, universal gateway, payment authority, workflow engine or privileged scripting layer. A visual designer is DEFERRED until usability and threat-model proof. Keep routing deterministic where practical; reserve Hermes reasoning for opted-in, sanitized cases with output treated as untrusted.

~~~
Verified provider event
  -> scoped tenant/account/thread + consent lookup
  -> existing workflow/approval and provider integration authority
  -> finite-state choice/form/handoff OR approved Hermes suggestion
  -> typed business API (only if actor authorized, idempotent, audited)
  -> channel capability mapper -> text/menu/button/form fallback
  -> existing provider outbox and sender policy
~~~

Proposed schema is an *illustration*, not a deployed API:
~~~json
{
  "schema_version":"1.0.0",
  "flow_ref":"helpdesk-v1",
  "flow_revision":1,
  "status":"draft",
  "nodes":[
    {"id":"start","kind":"choice","text":"Choose a service",
     "choices":[{"label":"Help","next":"human"},{"label":"Order status","next":"order"}]},
    {"id":"order","kind":"typed_operation","operation_key":"orders.read_own"},
    {"id":"human","kind":"handoff","queue":"support"}
  ],
  "policy":{"max_steps":12,"timeout_seconds":600,"default_deny":true}
}
~~~

**Security invariants:** actor/tenant/account derived from authenticated context, not inbound payload; published flow version immutable; typed operation reference allowlisted; callback uses opaque signed expiring transition token, not raw command; server reauthorizes every transition and outbox send. Unknown capability falls back to safe text. Untrusted action URLs MUST NOT trigger server-side fetch. Provider webhook must be verified and replay-protected. Protect PII in content/headers/trace; preserve correlation ID only. Treat LLM decisions as suggestions, not policy.

## Cross-channel capability contract (proposed)
| Internal representation | Web/Astro | Lynx persona UI | Provider-specific chat |
|---|---|---|---|
| Approved text | Escape output, accessible | Escaped native text | Provider text |
| Choice/menu | Accessible links/buttons | Host-safe choice list | Verified native buttons/menu or text fallback |
| Typed form | Server-validated form | Validated fields via API | Step-by-step prompt only if provider permits |
| Handoff | Support contact/status | Support destination | Authorized agent queue/status |
| Domain read/write | Typed backend API only | Typed backend API only | Provider -> backend operation with fresh actor authorization |
| AI suggestion | Server-reviewed only | Server-reviewed only | Approved reply policy before provider send |

Do not assume WhatsApp/Telegram capabilities, quotas or templates from legacy Carik screenshots: validate against current provider APIs and supported adapter versions before claiming implementation.

## Shared threat model
| Entry/risk | Required mitigation | Test |
|---|---|---|
| Spoofed webhook | Signature, account binding, timestamp | Reject forged payload |
| Replay/duplicate | Event dedup + idempotent outbox | Three duplicates, one side effect |
| Cross-tenant IDOR | RBAC/ABAC, FORCE RLS, scoped DTO | Deny other tenant/order |
| Callback injection | Opaque signed transition tokens, no eval | Invalid/expired callback denied |
| Arbitrary URL / SSRF | Static allowlisted provider adapters, no arbitrary server fetch | Private IP/redirect denied |
| LLM prompt injection | Least-privilege tools, structured output validation, human approval | User text cannot grant action |
| Revoked consent | Re-evaluate at send time and retain audit | Outbound blocked after opt-out |
| Excessive PII | Minimize, purpose-tag, retention, redact | Sensitive content absent from host logs |
| Loop / overlong form | Step, duration and payload limits; cancel/resume | Bounded safe fallback |
| Partner compromise | Signed manifest/contract and quota | Tampered adapter rejected |
| Unsupported provider UI | Capability negotiation | Safe readable text fallback |

## Evaluation examples (test fixtures, not shipping claims)
1. FAQ request: deterministic approved content, no LLM or personal data.
2. Order status: only authenticated owner; other-tenant attempt denied.
3. Multi-step registration: type validation, draft, cancellation, resumption and expiry.
4. Agent summary: sanitized input and opt-in, no direct send, human acceptance.
5. Campaign reply: blocked without allowed sender, consent and channel window/template.
6. Payment webhook: forged/replayed event fails without domain side effects.
7. Escalation: complex or uncertain question routes to human with minimal retained context.
8. Button-less channel: menu rendered as accessible textual numbered choices.

## Standards, regulatory and methodological considerations
Apply ISO/IEC 27001/27002 access, secure development and logging controls; 27005 risk assessment; 27017 cloud responsibilities; 27018 and 27701 PII/privacy management; 27034 secure application lifecycle; ISO 22301 continuity; ISO/IEC 20000-1 change/service operation; ISO/IEC 42001 AI governance. ISO/IEC 15408 is relevant only to a separately scoped Common Criteria evaluation, **not an automatic certification claim**. In Indonesia consider UU 27/2022 PDP and PP 71/2019 PSTE; public-government contexts may additionally require Perpres 95/2018 SPBE. Verify applicability per controller, processor, business and deployment. Use OWASP ASVS, API Security Top 10 and LLM Top 10 as engineering references.

## Decisions and rollout discipline
**REUSE** existing modules, messaging providers, workflow authority and Hermes. **ADAPT** declarative flow and typed action contract if evidence shows value. **DEFER** visual flow editor, generic plugin marketplace and fully autonomous replies. **REJECT** legacy Pascal/PHP code port, a second chat/agent runtime, unrestricted host/SQL and arbitrary external callbacks.

The internal cross-portfolio development standard requires scoped blueprint/PRD/threat model/UX/API contract, human **Definition of Ready at step 9**, atomic issue and PR, code tests, staging/UAT, human **release go/no-go at step 15** and observable rollback. This F0 research document alone is **not** an implementation approval. Document evidence from actual repository state and attach passing checks to the PR.

## Repository-specific owner: reusable template, not runtime backend for clients
**Issue:** https://github.com/ahliweb/awcms-one/issues/523. This repository is a **template** with apps/cms embedded from AWCMS and its own commerce features. A derived product owns a distinct backend, database, secrets and sender credentials. Do not patch upstream apps/cms directly; promote a generic capability to AWCMS first, then adopt via approved subtree sync.

### Relation to existing planned work
- [CRM AI #459](https://github.com/ahliweb/awcms-one/issues/459) already proposes Hermes-assisted triage/drafts, consent/approval and campaign controls: **REUSE**.
- [Telegram CRM #460](https://github.com/ahliweb/awcms-one/issues/460) has its own provider scope; generic Carik intent wrappers must not add Telegram senders.
- [Omnichannel CRM epic #280](https://github.com/ahliweb/awcms-one/issues/280) and upstream AWCMS #1164 govern inbox and state.
- [Template governance #476](https://github.com/ahliweb/awcms-one/issues/476) owns generic derived-product anti-drift, not CRM-specific workflow semantics.

### Proposed template reference
Provide a **sample configuration only**: inquiry -> price/FAQ -> order status -> customer handoff. All operation IDs must be generic placeholders bound to actual product APIs by the derived product. Never ship customer production data or provider credentials in neutral seeds. Email/WhatsApp/Telegram provider selection must stay independent, with sender verification and limits. AI draft is reviewed and dispatched by AWCMS-owned approved worker, not Hermes direct provider send.

### Acceptance
- Template metadata is neutral; tests demonstrate a derived product does not call template production endpoints.
- AWCMS source of truth remains in apps/cms subtree, with upsteam changes merged by required subtree method.
- Synthetic two-tenant test covers revoked consent, unsupported UI, account identity, AI outage, outbox idempotency and human handoff.
- Demo exists as doc and mock only until product-specific human DoR.

## Changelog
### v1.0.0 (2026-11-10)
Research reference and preliminary acceptance; no feature implementation.
