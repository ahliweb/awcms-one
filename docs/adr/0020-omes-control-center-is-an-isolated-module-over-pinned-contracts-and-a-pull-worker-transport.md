🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0020-omes-control-center-is-an-isolated-module-over-pinned-contracts-and-a-pull-worker-transport.id.md)

# ADR-0020 — The OMES Control Center is an isolated module, over pinned contracts and a pull-worker transport

- **Status:** Accepted
- **Date:** 21 September 2026
- **Decision maker:** ahliweb
- **Related:** [ADR-0008](0008-one-commerce-module-carries-the-whole-store-not-three.md) (module-per-domain precedent this ADR does not disturb — `commerce` stays commerce-only), [ADR-0015](0015-commerce-migrations-live-in-the-reserved-9xx-range.md) (the migration-range convention this ADR extends to a second module), [ADR-0016](0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) and [ADR-0017](0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md) (the outbox/port/idempotency/audit primitives this ADR reuses rather than reinventing); `apps/cms`'s own module-admission discipline (`apps/cms/AGENTS.md`); issue [#146](https://github.com/ahliweb/awcms-one/issues/146) (epic: OMES Control Center), issue [#151](https://github.com/ahliweb/awcms-one/issues/151) (this ADR), issue [#150](https://github.com/ahliweb/awcms-one/issues/150) (production topology — a sibling ADR, not this one); upstream `ahliweb/omes`'s `AGENTS.md`, *docs/control-center-foundation.md*, *docs/control-center-contracts.md*, *docs/jobs.md*, `contracts/README.md`, and `contracts/control-center/v1/**`; `ahliweb/omes#192` (the companion transport issue, still open at this ADR's writing)

## Context

Epic #146 asks awcms-one to become the web GUI and control plane for OMES-managed hosts, without moving host execution, Hermes runtime semantics, or arbitrary shell access into this CMS. OMES already answered half of this question from its own side: `ahliweb/omes`'s *docs/control-center-contracts.md* fixes an ownership matrix and a versioned wire contract (`contracts/control-center/v1/**`) for exactly this boundary, and *docs/jobs.md* fixes the job/state-machine shape those contracts describe. What OMES's own documents explicitly leave open, by their own words, is everything on this repository's side of the line: the web GUI, the tenant/RBAC/ABAC/RLS tables, the workflow-approval and audit primitives, and — the one piece genuinely undecided anywhere yet — the transport a browser-facing control plane uses to reach a fleet of hosts it must never directly dial into.

This ADR is wave 0 of epic #146: it records the trust and ownership boundary, pins the contract this repository builds against, freezes the module shape every child issue (#152–#158) codes to, and states plainly that the transport itself is not yet buildable — `ahliweb/omes#192`, the issue that will define the OMES-side pull-worker protocol, is still **open**. Nothing here is running code; #152 adds the first line of the `omes_control` module itself.

Two related ADRs are in flight at once and are deliberately kept separate: this one (#151) settles admission — ownership, contracts, transport shape, module boundary, evidence-only capability, standards alignment, non-goals. A sibling ADR (issue #150, authored concurrently, expected to number `docs/adr/0019-*.md` once merged) settles this deployment's own production topology for running an OMES-facing control plane at all. Where the two would otherwise overlap, this ADR defers to whatever issue #150's own ADR decides about topology and cites it once that ADR exists on `main`; this ADR does not itself decide topology.

## Decision

### D1 — Ownership matrix: reproduced verbatim from `ahliweb/omes`'s own boundary, per entity

`ahliweb/omes`'s *docs/control-center-contracts.md* §1 already answers "who owns what" precisely enough that re-deriving it here would risk a second, drifting copy. This ADR adopts it verbatim, per entity:

| Entity / state | AWCMS-one (Control Center) | OMES | Hermes |
| --- | --- | --- | --- |
| Tenant, user, permission (RBAC/ABAC) | **owns** | reads tenant/actor identity on incoming requests only | no knowledge |
| Server/deployment inventory (which hosts exist, which tenant owns them) | stores a copy for UI/billing, reconciled from OMES | **owns the live truth** (`omes status`, state file) | no knowledge |
| Host preflight/compatibility evidence | displays it | **owns** (`omes check`) | no knowledge |
| Install/configure/start/stop/restart/update execution | requests it via a job | **owns** (executes; the only party that runs host commands) | Hermes-specific config only, applied by OMES |
| Job queue, state machine, audit log | reads job status via API | **owns** (`lib/omes/py/jobs/`) | no knowledge |
| Backup/restore/rollback | requests and displays status | **owns** (`omes backup`/`restore`) | no knowledge |
| Health/readiness evidence | displays it | **owns** (reuses `lib/omes/py/health/model.py`) | Hermes reports its own runtime signals which OMES's health layer reads, never the reverse |
| Agent reasoning, sessions, memory, skills, channels, model/provider routing | no knowledge | no knowledge (never reimplements this) | **owns** |
| Approvals for destructive operations | records the approval decision and actor | enforces the approval gate before executing | no knowledge |
| Secrets (tokens, passwords, credentials) | never stores raw values; stores `secret_ref` pointers only | resolves `secret_ref` locally; never returns raw values | resolves its own secrets from its own `.env`, unrelated to Control Center secrets |

**The Control Center stores desired/observed/projection state and reconciliation evidence only.** It never stores a raw SSH key, a provider API token, a Hermes credential, a shell command, or host filesystem content — the same rule OMES's own contracts enforce at the schema level (§D2 below) and this repository's own `omes_control` tables enforce as a second, independent backstop by never defining a column shaped to hold one.

Every operational screen epic #146 names (Overview, Servers, Deployments, Operations, Jobs, Health & readiness, Backups/recovery, Audit, Orchestration visibility) is a read model or a request-submission form over this matrix — none of them requires this repository to know anything OMES or Hermes already owns above.

### D2 — Contract pinning: `contracts/control-center/v1/**` vendored at a named commit, validated fail-closed, unknown versions rejected

`ahliweb/omes`'s `contracts/control-center/v1/**` is vendored into `apps/cms/src/modules/omes-control/contracts/v1/` at commit **`e4e94ea92067df91b04b08d987a106c8ee977e79`** (`ahliweb/omes`'s `main`, 21 September 2026) — the same "copy at a named commit, re-vendor deliberately" discipline this repository already applies to `apps/cms` itself (ADR-0001), scaled down to a directory instead of a whole tree because OMES's own compatibility rule (`contracts/README.md`: "a `v<major>` directory, once referenced by a merged PR outside this repository, is never renamed or deleted; only additive changes land inside it") already gives a vendored copy the same stability a subtree gives `apps/cms`.

Every contract this repository's server-side adapters consume is a member of that set: `server-registration.request/response`, `preflight.request/response`, `deployment.request`, `deployment-view`, `operation-request`, `job-status.response`, `health-readiness.response`, `backup-status.response`, `rollback.request`, and `entitlement.schema.json` (consumed read-only, per below). The same `v1` directory also carries a catalog/subscription/invoice/payment-gateway/webhook contract family (issues #92–#95 upstream) for OMES's own SaaS billing surface; nothing in epic #146's scope reads or writes those, and no child issue of #151–#158 is authorized to start consuming them without a fresh ADR — vendoring the whole directory is a compatibility convenience (one commit, one copy), not a license to grow this module's surface silently.

Validation is **fail-closed**, matching `contracts/README.md`'s own validator subset exactly rather than reaching for a general-purpose JSON Schema library this repository does not otherwise depend on:

- the supported keyword set is `type, required, properties, additionalProperties, enum, const, pattern, minimum, maximum, minLength, maxLength, minItems, maxItems, items, oneOf, anyOf` plus the allowlisted annotations `$schema, $id, title, description`;
- any other keyword (`$ref`, `format`, `if`/`then`/`else`, `allOf`, `not`, `uniqueItems`, `patternProperties`, …) appearing in a vendored schema is a **build-time** error, not a silently-ignored constraint — the same fail-closed posture OMES's own *scripts/check-contracts.py* takes, so a future vendored schema this repository has not reviewed for validator-subset compatibility cannot pass through unenforced;
- `additionalProperties: false` is honoured everywhere the vendored schema sets it — an operation request with a `command`, `args`, `shell`, or any other field OMES's own `deployment.request` and `operation-request` schemas do not name is rejected by the schema itself, before this module's own handler code ever runs;
- an unconditional raw-secret scan runs on every request/response this module serializes or deserializes against a vendored contract — the same two-part check OMES's own validator runs (a key-name check for `token|password|secret|credential|api_key|passphrase|cookie|authorization`-shaped field names, and a pattern-based check for a well-known secret-value shape regardless of field name) — reimplemented here rather than shared as a dependency, because this module has no other reason to depend on OMES's Python runtime, but tested against the same fixture shapes OMES vendors (`fixtures/operation-request/invalid-permission-denied-with-command-field.json`, `fixtures/deployment-view/invalid-raw-secret-in-error-evidence.json`) so the two implementations cannot silently drift apart on what counts as a leak;
- any `contract_version` this module does not recognize — a client presenting a version outside the vendored `v1` set, or an OMES worker heartbeat claiming a `contract_version` this module's own validator has no schema for — is a typed rejection (`UNSUPPORTED_CONTRACT_VERSION`), never a best-effort parse. Fail closed on an unknown version, not fail open on "looks close enough."

**No browser-side evaluator duplicates OMES's own job or entitlement logic.** `lib/omes/py/jobs/entitlement.py`'s `evaluate(entitlement, action, resource_policy)` and the job-runner's own allowlist/approval re-derivation are consumed as **evidence OMES already computed and reports back** (a `job-status.response`, a `deployment-view.observed_state`, a heartbeat's capability-registry digest) — this module never re-implements `evaluate()`'s allow/deny arithmetic in TypeScript, in the browser, or anywhere else in `apps/cms`. A UI that needs to know whether an operation is currently permitted reads the OMES-reported capability, per D5; it does not compute one of its own that could disagree with the host's own truth.

### D3 — Transport: the browser never talks to a host; the server consumes OMES's outbound pull-worker transport

The browser's only network target is this repository's own authenticated API (`apps/cms`) — never an OMES host, directly or indirectly. The server side of this module is a **consumer** of the outbound pull-worker transport `ahliweb/omes#192` will define, not a second implementation of it:

```text
Browser
  -> AWCMS-one authenticated API (RBAC/ABAC/RLS + approval + outbox)
  -> pending allowlisted operation, queued as an omes_control job row
  <- HTTPS pull by an enrolled OMES worker (worker-initiated, outbound-only)
  -> local schema/scope/capability verification on the worker
  -> omes job submit/approve/run (OMES's own allowlist, re-derived, never trusting this module's decision alone)
  -> read-back verification
  -> signed/redacted result + health/projection evidence, on the same outbound connection
  -> AWCMS-one projection/reconciliation read model
```

This shape — **outbound pull, no public privileged listener** — is the one architectural decision `ahliweb/omes#192`'s own issue body already commits to before its acceptance criteria are met: "no public privileged listeners on OMES hosts; no inbound SSH as the normal execution channel; no arbitrary remote shell; no browser-to-host trust." This ADR does not re-argue that choice; it records that this repository's server side is built to consume exactly that shape, and that nothing in `omes_control`'s own design requires OMES to expose an inbound listener instead. If `ahliweb/omes#192` ultimately lands a materially different transport shape than the pull-worker sketch above, the consuming adapter in `apps/cms/src/modules/omes-control/` changes; the module boundary, ownership matrix, and RLS/approval/audit discipline in D1/D4 do not.

**Enrollment** follows the same non-secret-bearing shape `ahliweb/omes#192` proposes: an operator creates a pending server record in this module holding no credential at all; the Control Center issues a single-use, short-lived enrollment challenge; the OMES host generates its own worker key material locally and never transmits it; the worker exchanges the challenge for a scoped worker identity; **this module stores only public identity/credential metadata** — a key id, a public key or certificate fingerprint, a `secret_ref`-shaped pointer if any resolution is needed — never a raw SSH key, a provider token, or a Hermes credential. Rotation and revocation are explicit, actor-attributed mutations, audited exactly like any other high-risk `omes_control` action (D4).

### D4 — Module admission: `omes_control`, an isolated domain module, not inside `commerce`

`omes_control` is admitted as its own top-level module at `apps/cms/src/modules/omes-control/`, following `apps/cms`'s own module-admission discipline (`apps/cms/AGENTS.md`) exactly as `commerce` did — **not** as a fourth area inside `commerce`. ADR-0008 decided "one `commerce` module carries the whole store, not three" because catalog/marketing/orders are one bounded domain (a shopper's purchase path) sharing one set of tables or none. OMES's operational fleet — servers, deployments, jobs, health snapshots, backups, enrollments, audit projections — shares no schema, no permission, no read model, and no domain event with a shopper's cart; forcing it into `commerce` would repeat exactly the mistake ADR-0008 argued against avoiding, in the opposite direction (bolting an unrelated domain onto a module that already has a clear boundary), and would make every future `apps/cms` `git subtree pull` (AGENTS.md's own subtree section) touch `commerce`'s tree for a reason that has nothing to do with commerce.

`omes_control` reuses every primitive this codebase already has rather than inventing parallel ones:

- **`withTenant` + `authorizeInTransaction`** on every mutation and every tenant-scoped read — the same pattern `commerce` and every other admitted module already use; no `omes_control` table is ever queried outside a tenant-scoped transaction.
- **`ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`** on every tenant-scoped table (`omes_servers`, `omes_deployments`, `omes_operation_requests`, `omes_jobs`, `omes_health_snapshots`, `omes_backup_snapshots`, `omes_audit_projection`, `omes_enrollments`), matching the epic's own named data-model minimum.
- **`Idempotency-Key`** on every operation-submission and worker-result-ingestion endpoint — a duplicate submission (a retried browser request, a re-delivered worker result) never executes twice, the same discipline ADR-0016/ADR-0017's own bearer-session and webhook endpoints already require.
- **Audit events** for every high-risk action (server registration, enrollment, any lifecycle operation request, an approval decision, a backup restore/rollback) — reusing the audit primitive `commerce` and other modules already write to, not a second audit table this module invents for itself.
- **The domain-event outbox** for asynchronous work (a queued job becoming visible to the pull-worker transport, a completed job's result feeding back into a projection) — the same CLAIM → do the work outside any transaction → FINALIZE shape ADR-0017 D1 already proved three times over for `email`/`push_delivery`/the provider outboxes; a worker-facing job queue is exactly this shape once more, not a new one.
- **`workflow_approval`** gating destructive operations (`rollback`, `restore`, `stop`, and `update` where policy requires) before a job is ever enqueued for a worker to pull — the same explicit-approval discipline epic #146 names outright and ADR-0017's own webhook/reconciliation design already assumes for anything irreversible.

**Migrations continue this repository's reserved `9xx` range, after `commerce`'s own numbers.** Per ADR-0015, `commerce` occupies `901`–`934` with the next free `commerce` number at `935`; `omes_control`'s own migrations are numbered forward from whatever `apps/cms/sql/9*.sql`'s highest existing prefix is at the time #152 lands (`935` as of this ADR's writing — `apps/cms/tests/commerce-migrations-range.test.ts` only currently asserts "commerce migrations are 900–999, everything else is below 900," so that test is **extended in #152**, not here, to also recognize `awcms_omes_control_*`-named migrations as belonging in the reserved 9xx band rather than failing its "non-commerce migrations stay below 900" assertion). No `omes_control` migration ever renumbers a migration `git subtree pull` brought in from upstream, matching AGENTS.md's existing rule for `commerce`.

Permissions follow the epic's own named surface: `omes.servers.read`/`.register`, `omes.deployments.read`/`.operate`, `omes.jobs.read`/`.approve`, `omes.backups.read`/`.restore`/`.rollback`, `omes.audit.read` — default-deny, least-privilege, defined once #152 lands the module skeleton.

### D5 — Capability comes from OMES evidence only; stale data renders as stale, never as healthy

A UI never hard-codes "this operation is available" from its own assumptions about what OMES or Hermes can do. Every operation a screen renders as executable is gated by the capability-registry digest an enrolled worker's own heartbeat reports — the same evidence-only posture D2 already applies to `evaluate()`. An operation OMES's current baseline does not support is never rendered as a clickable action; it is either absent or explicitly shown as unsupported, never greyed-out-but-technically-clickable behind a client-side check that could be bypassed.

Staleness is a first-class, always-visible property, not an inferred one: `deployment-view`'s own `last_reconciled_at` and a worker's own heartbeat age are read and shown directly. Data older than the freshness window this module defines is rendered **as stale** — a distinct visual/textual state, never silently collapsed into "healthy" or "unknown-but-probably-fine." A worker that stops heartbeating is shown as offline/stale from the moment its heartbeat window lapses, not from the moment a human notices.

### D6 — Standards alignment: engineering practice, not certification

Design and evidence for `omes_control` are expected to align with the engineering practices behind ISO/IEC 27001, 27002, 27005, 27017, 27018, 27701; ISO/IEC 20000-1; ISO 22301; ISO/IEC 15408 principles; OWASP ASVS and OWASP API Security; NIST SP 800-53 and SP 800-207 (zero trust); the CIS benchmarks; and SLSA/OpenSSF supply-chain practices — the same list epic #146 names outright, adopted here as this module's own working reference. **No certification against any of these standards is claimed by this ADR, by this repository, or by any future `omes_control` documentation** — these are cited as engineering discipline this module's threat model (below) and its RLS/approval/audit/idempotency choices (D4) are built to satisfy in spirit, not as a compliance statement a customer or auditor could rely on as evidence of formal certification.

### D7 — Explicit non-goals

`omes_control` does **not** build, and no child issue of #151–#158 is authorized to build without a fresh ADR:

- a second Hermes runtime, or any reimplementation of Hermes's own reasoning/session/memory/skill/channel/model-routing semantics;
- a shell or SSH endpoint of any kind, anywhere in the module's own API surface;
- a host filesystem read of any kind — not a log tail, not a config-file preview, nothing that returns raw host file content to the browser;
- a private-database inspection surface into Hermes's own state;
- a generic "run this command on the host" escape hatch, under any name — every operation this module can request is a member of OMES's own closed `operation` enum (`deployment.request`'s `preflight, install, configure, start, stop, restart, update, status, backup, restore, rollback`, or the narrower `operation-request` enum for issue #91-shaped screens), never a free-form field.

## Threat model and privacy impact (summary)

**Assets:** tenant/server/deployment inventory and its RLS-scoped rows; operation-request and job records (including any recorded `permission`/approval decision); health/backup/reconciliation evidence; enrollment/worker identity metadata (public keys, key ids, fingerprints — never a private key or a raw host secret); the audit log itself.

**Actors:**

| Actor | Trust level | What they can do |
| --- | --- | --- |
| Tenant operator | Authenticated, RBAC/ABAC-scoped to their own tenant | Read their tenant's servers/deployments/jobs/health/backups/audit; submit an allowlisted operation request their permissions grant; approve a destructive operation if their role carries approval rights |
| Platform owner | Authenticated, cross-tenant admin | Register servers, manage enrollments, read/approve across tenants they administer |
| Enrolled OMES worker | A scoped, tenant/server-bound identity established once via a single-use enrollment challenge | Pull queued jobs for its own tenant/server only; post results/heartbeats for its own identity only; cannot act as any other server or tenant |
| Unauthenticated internet | None | Can reach only this module's public surface, if any exists (an enrollment-challenge endpoint bound to a pre-created, non-secret server record); every other endpoint requires an authenticated session or an enrolled worker identity |
| A compromised host | Holds one worker's own key material, nothing else | Can act as that one server/tenant only, and only within the operation allowlist and approval gates OMES's own job runner independently re-derives — it cannot forge another tenant's identity, and it never held this repository's own database credentials or any other tenant's secret |

**Trust boundaries:** browser ↔ `apps/cms` API (session/bearer + RLS); `apps/cms` ↔ the pull-worker transport (worker-initiated, outbound-only, per D3 — this repository never dials a host); `apps/cms` ↔ its own PostgreSQL (RLS-enforced per tenant); `omes_control` ↔ the rest of `apps/cms` (module boundary, D4 — no shared tables with `commerce` or any other module).

**Top abuse cases and their controls:**

| Abuse case | Control |
| --- | --- |
| Cross-tenant read (tenant A views tenant B's servers/jobs/audit) | `ENABLE`/`FORCE ROW LEVEL SECURITY` on every tenant-scoped table (D4); `additionalProperties: false` on `target` in the vendored `operation-request` schema rejects a smuggled second tenant identifier at the schema layer too (D2) — a second, independent check behind RLS, not a substitute for it |
| Secret smuggling in evidence (a raw token/credential riding inside an otherwise schema-legal string field, e.g. inside `error_evidence.message`) | The unconditional key-name + pattern-based raw-secret scan (D2) runs on every contract this module serializes or deserializes, rejecting the payload before persistence or rendering |
| Replayed result (a worker or an attacker re-submits an already-processed job result) | `Idempotency-Key` on every result-ingestion endpoint (D4); a replayed key returns the original outcome, never re-executes or re-records a second effect |
| Stale data rendered as healthy | D5's explicit staleness rendering from `last_reconciled_at`/heartbeat age — never inferred, never silently collapsed to "OK" |
| Unsupported operation rendered as executable | D5's evidence-only capability gating — an operation absent from the current heartbeat's capability-registry digest is never shown as clickable |
| A denied request smuggling a command-shaped field anyway | `additionalProperties: false` on the vendored `deployment.request`/`operation-request` schemas rejects any `command`, `args`, or `shell` field outright, independent of the `permission.granted` value the request also carries (D2) |
| Enrollment challenge reuse or replay | Single-use, short-lived challenge (D3); a consumed or expired challenge cannot be redeemed a second time |

**Personal data present:** the actor identity recorded on every audit row and every approval decision (an operator's user id, attributable per D4's audit requirement) is personal data in the ordinary sense this repository already handles for every other module's audit trail. It carries no special category of data beyond that. **Retention** follows this repository's existing `data_lifecycle` mechanism — `omes_control`'s audit and job-history rows are subject to the same retention/purge policy discipline every other module's audited tables already use; #152 registers `omes_control`'s tables with it rather than inventing a second retention mechanism.

## Delivery

Epic #146's children, per this ADR's own admission:

| Issue | Scope | Status |
| --- | --- | --- |
| #151 | This ADR (admission: ownership, contracts, transport, module shape, evidence-only capability, standards alignment, non-goals, threat model) | This change |
| #152 | The `omes_control` module skeleton — schema (D4's eight tables), permissions, migrations continuing the reserved 9xx range, `commerce-migrations-range.test.ts` extended to recognize it |
| #153 | Server registration and enrollment (D3) — pending server records, single-use challenge issuance, worker identity storage (public metadata only) |
| #154 | Deployment/job read models and the Overview/Servers/Deployments/Jobs screens (D1's ownership matrix rendered as UI, D5's evidence-only capability and staleness display) |
| #155 | Operation submission and worker-result ingestion over the pull-worker transport — **blocked on `ahliweb/omes#192`**, still open at this ADR's writing; this repository's own consumer side cannot be built against a transport contract that does not yet exist |
| #156 | Backups/recovery screen, approval-gated restore/rollback (D4's `workflow_approval` requirement) |
| #157 | Audit screen and `data_lifecycle` registration |
| #158 | Orchestration-visibility (read-only Hermes-native profile/status display through supported OMES/Hermes adapters), docs sweep, and epic close |

## Options considered

| Option | Why not (or why chosen) |
| --- | --- |
| **Isolated `omes_control` module, pinned OMES `v1` contracts, consumed pull-worker transport, evidence-only capability** (chosen) | Reuses every primitive this codebase already has (RLS, outbox, approval, audit, idempotency) for a domain with no schema/permission/read-model overlap with `commerce`, and does not duplicate OMES's own job/entitlement evaluators or invent a second transport design ahead of `ahliweb/omes#192` |
| Fold OMES operations into `commerce` as a fourth area | Repeats ADR-0008's own rejected shape in the opposite direction — an unrelated domain (host fleet operations) bolted onto a module whose boundary (a shopper's purchase path) has nothing to do with it, and makes every future `apps/cms` subtree pull touch `commerce` for an unrelated reason |
| Re-implement OMES's job/entitlement evaluators in this module (or in the browser) for a faster UI | Creates a second, independently-drifting source of truth for allow/deny decisions OMES's own job runner already re-derives and enforces; a UI-side evaluator that disagrees with the host's own decision is a worse failure mode than waiting on OMES's own evidence |
| Design and build a bespoke transport now, ahead of `ahliweb/omes#192` | This repository does not own the host-side worker; building a browser/API-side transport implementation against a protocol OMES has not yet fixed risks building the wrong thing twice — #155 is explicitly blocked on that issue landing first |
| An inbound listener on each OMES host, reachable from this repository's API | Exactly the "public privileged OMES listener" epic #146 and `ahliweb/omes#192` both rule out — it inverts the trust boundary this ADR is written to protect |
| Claim formal certification against the cited standards | No certification process has been undertaken; citing the standards as engineering-practice alignment while explicitly disclaiming certification (D6) is honest about what this ADR actually commits to |

## Consequences

- `apps/cms/src/modules/omes-control/` does not exist yet as of this ADR; #152 creates it. Nothing in this change touches `apps/cms/**`.
- `docs/arsitektur.md` gains a short pointer section to this ADR (below), stating plainly that no code exists yet.
- `apps/cms/tests/commerce-migrations-range.test.ts` will need to be extended (in #152, not here) to recognize `awcms_omes_control_*`-prefixed migrations as also belonging in the reserved 9xx range, alongside `commerce`'s own.
- #155 (operation submission / worker-result ingestion) cannot start until `ahliweb/omes#192` lands a concrete transport contract; every other child issue can proceed once #152's schema exists, since D1–D2's ownership/contract boundary does not depend on the transport's final shape.
- A future ADR (or an amendment here) is required before `omes_control` consumes any contract from the catalog/subscription/invoice/payment-gateway family in the same vendored `v1` directory — D2 vendors the whole directory for compatibility convenience, not as a license to use all of it.

## Status — 21 September 2026: admission decided, no implementation yet

This ADR settles the trust boundary, the contract pin, the transport consumption shape, the module boundary, and the non-goals every child issue of epic #146 builds against. `apps/cms/src/modules/omes-control/` does not exist yet; #152 is the first issue to add running code. #155 remains blocked on `ahliweb/omes#192`, which is open as of this ADR's writing.
