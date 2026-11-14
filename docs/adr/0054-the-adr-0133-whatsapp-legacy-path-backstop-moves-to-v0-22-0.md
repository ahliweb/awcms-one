🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0054-the-adr-0133-whatsapp-legacy-path-backstop-moves-to-v0-22-0.id.md)

# ADR-0054 — The commerce WhatsApp legacy-path backstop moves to v0.22.0

- **Status:** Accepted
- **Date:** 11 November 2026
- **Decision maker:** ahliweb
- **Related:** issue [#394](https://github.com/ahliweb/awcms-one/issues/394) (the removal, phase 4, still open and not started); [ADR-0047](0047-commerce-whatsapp-moves-to-the-upstream-queue-through-a-per-tenant-mode-router.md) (the per-tenant mode router D1-D9, the guarded cutover D10-D15, the review amendments D16-D17, and the Consequences line that started the backstop clock); upstream ADR-0133 section 6 (the phases, the five end conditions and the backstop) under `apps/cms/docs/adr/`; [ADR-0024](0024-awcms-one-is-template-only-derived-apps-own-their-backend.md) (this repository is a template; derived products own their tenants and runtime); [ADR-0017](0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md) D5 (the commerce-owned outbox the legacy path is); epic [#280](https://github.com/ahliweb/awcms-one/issues/280) item 31

## Context

Upstream `awcms` ADR-0133 section 6 ends the commerce WhatsApp compatibility adapter with a dated backstop: the adapter and the legacy path are removed "no later than the **second minor release of the downstream template after the release that first ships the `upstream` mode (step 2)**; if the conditions above are not met by then, the decision to extend it needs a new ADR with a new date". A compatibility adapter without a dated end is the failure mode that section refuses on purpose. [ADR-0047](0047-commerce-whatsapp-moves-to-the-upstream-queue-through-a-per-tenant-mode-router.md)'s Consequences accepted the clock and said it starts with the release that carries the router.

The facts, from [`CHANGELOG.md`](../../CHANGELOG.md):

- `upstream` mode (the per-tenant mode router of #392, `sql/1027`) and the guarded cutover (#393, `sql/1028`) first shipped in **v0.17.0, 20 October 2026**.
- The two minor releases after it are v0.18.0 (25 October 2026) and **v0.19.0 (11 November 2026)**. The backstop therefore fell due at v0.19.0, and v0.19.0 has been released.
- The current release is v0.20.0 (11 November 2026). The legacy path was not removed in any of them, and none of the five end conditions has been evidenced.

The conditions cannot be evidenced **in this repository**, and that is a property of what the repository is, not a slip in the work. Per ADR-0024, `awcms-one` is a template and a reference deployment: the derived products created from it own their tenants, databases, domains, secrets, scheduled jobs and operational lifecycle. Conditions 2 and 3 ("every tenant on every deployment is in `upstream` mode, with zero non-terminal rows in the legacy queue, and the retention window has elapsed or been purged") are statements about tenants this repository does not hold. No tenant here has been flipped, and the reference deployment must not be used to manufacture that evidence (ADR-0024: no consumer runtime tenancy here). Removing the legacy path (screens, jobs, flag, tables) while a derived product's tenant still runs in `legacy` mode would break that product on its next upgrade; ADR-0133's own condition 2 exists to prevent exactly that.

So the backstop was missed, and `awcms` ADR-0133 says what a miss requires: a new ADR with a new date, not a silent slip. This is that ADR.

## Decision

**D1 — The backstop moves: the legacy path is removed no later than the second minor release after v0.20.0, that is v0.22.0.** The counting rule is `awcms` ADR-0133's own, applied to a new anchor: v0.21.0 is the first minor release after v0.20.0 and v0.22.0 the second. A release that is not a minor (`0.x.y` patch) does not count; a major would restart the question in a new ADR. The new date replaces the one in ADR-0047's Consequences (the Amendment note there points here); ADR-0133 upstream is unchanged and its wording ("a new ADR with a new date") is what this ADR applies.

**D2 — The five end conditions are unchanged.** They are upstream's, quoted here only so the removal PR has one checklist:

1. Every commerce caller (customer OTP, order paid, campaigns, document delivery) enqueues through the router and the upstream port; `apps/cms/tests/commerce-whatsapp-upstream-boundary.test.ts` (ADR-0047 D9) is green with its allowlist empty.
2. Every tenant on every deployment is in `upstream` mode and `awcms_commerce_whatsapp_messages` holds **zero non-terminal rows** (`queued`, `sending`; an unknown status counts as non-terminal, ADR-0047 D11).
3. The old retention window has elapsed for terminal rows, or `commerce:whatsapp:purge` has purged them; the delivery-attempts ledger likewise.
4. `commerce:whatsapp:dispatch`, `commerce:whatsapp:purge`, the commerce-owned WhatsApp admin screens and API paths, and the `legacy` mode flag are removed, with the API paths first redirected or aliased to the upstream ones for **one minor release** and announced in the changelog.
5. A final migration drops the two legacy tables (`awcms_commerce_whatsapp_messages` and `awcms_commerce_whatsapp_delivery_attempts`), recorded as a **restore-class decision** in the removal PR's ADR, not as a `down` migration.

Nothing in this ADR relaxes, reorders or waives one of them. Only the date moves.

**D3 — No code, schema or table is removed or changed by this ADR.** The router, the legacy writer, the legacy dispatcher and purge, the admin screens, `sql/1027` and `sql/1028`, and both legacy tables stay exactly as they are. The `legacy` default stays, so a tenant that does nothing keeps working. This is a decision record only.

**D4 — What the removal PR (issue #394) must carry as evidence.** The condition list is the acceptance list; each item gets a line in the PR:

- Condition 1: the boundary test's output with the allowlist empty, plus a `git grep` showing no commerce file names a legacy table, provider, dispatcher or writer outside the files being deleted.
- Conditions 2 and 3: because this repository cannot show them for other people's tenants, the evidence is a **written attestation per known derived product** (the product repository's owner, the date, and the evidence record from `commerce:whatsapp:cutover --status` for each tenant: `mode: upstream`, `queues.legacy.nonTerminal: 0`, the legacy table's remaining row count and the purge run), plus the reference deployment's own `--status`. A derived product that has not attested by the PR's merge is not covered by this removal and carries the consequence in D5. If no derived product exists to attest, the PR says so.
- Condition 4: the removal release deletes the jobs, the screens and the flag, and turns the old API paths into aliases of the upstream ones; the alias period (one minor release) is announced in that release's changelog, and the aliases are deleted in the next minor release, never the same one.
- Condition 5: the migration, the restore-class note (the two tables are not restorable by migrating down; a backup taken before the deploy is the restore path), and a `bun run db:migrate` result on a database that held legacy rows.

The backstop in D1 applies to that removal release: it lands **no later than v0.22.0**, as `awcms` ADR-0133's wording ("the adapter and the legacy path are removed") places it. The aliases it introduces, and the condition-5 migration that drops the two legacy tables, follow no later than the next minor release (v0.23.0). If the removal release slips past v0.22.0, D6 applies.

**D5 — What a derived product must do before then.** A derived product owns its tenants (ADR-0024), so the work is its own and happens in its own repository, with its own issue:

1. Configure the upstream channel (`WHATSAPP_ENABLED`, `WHATSAPP_PROVIDER` with its credentials, `WHATSAPP_RECIPIENT_HASH_KEYS`) in the environment of both the CMS and the jobs sidecar, and read the ADR-0047 known gaps (marketing consent is not bridged, variables are single-line and capped at 1,000 characters, Meta needs a provider template identity, the rate limits differ).
2. Flip each tenant with the existing command, one tenant at a time: `bun run commerce:whatsapp:cutover --tenant <tenant-uuid> --to upstream --reason "<why>" --ack-warnings` (dry-run first with `--dry-run`; `--wait <seconds>` waits for the legacy queue to drain). The equivalent API is `POST /api/v1/commerce/whatsapp/mode`. The runbook is in [`docs/deployment.md`](../deployment.md).
3. Drain the legacy queue: the flip refuses while the legacy queue holds a non-terminal row, so a flipped tenant has none, and `commerce:whatsapp:purge` then removes terminal rows and attempts once their retention passes.
4. Send one real OTP to a number the operator controls after each flip (the flip does not verify provider credentials), and keep the evidence record.

A derived product that is still on `legacy` when it adopts the release that removes the path has, by D2 condition 2, not met the precondition for that upgrade; it must flip before adopting it, or stay on the last release that still carries the path and carry its own divergence. The changelog of the release that introduces the aliases says so in as many words.

**D6 — If the new backstop is missed too, the answer is another ADR, never a silent slip.** If the five conditions are not evidenced when v0.22.0 is being cut, an ADR with a new date and a new anchor is written **in the same release cycle, before the v0.22.0 tag**, with the same two parts this one has: what has been evidenced and what has not, and who owns the missing evidence. A third postponement also records, in that ADR, whether the template should keep carrying the legacy path at all, or should freeze it behind a documented support horizon and stop shipping `legacy` as the default for new derived products. A changelog entry that says the removal "will happen later" with no ADR is not a decision.

**D7 — A check that keeps the date honest.** The backstop is a sentence; sentences expire silently. When v0.21.0 is released, its release notes name this ADR and say that one minor release remains before the backstop; the removal PR, when opened, links back to it. The "not here yet" list in `docs/status.md` states the date and cites this ADR, which is the one place a reader looks. This ADR adds no gate: a structural test that fails on a version number would encode the date a second time and would be wrong the day a minor release is skipped. Revisit if the date moves a second time.

## Consequences

- Nothing observable changes today: every tenant on `legacy` keeps working, every flipped tenant keeps working, and the router, the cutover and the legacy dispatchers are untouched.
- The `awcms` ADR-0133 backstop is satisfied procedurally by a new ADR with a new date, as ADR-0133 requires, rather than by removal. The earlier date (v0.19.0) is recorded as missed, in the open, with the reason: the evidence belongs to tenants this template does not hold.
- Derived products get a stated horizon (v0.22.0) and an exact procedure (D5) instead of an open-ended "someday"; they can plan the flip of each tenant against it.
- The removal work (issue #394) stays open and unstarted. Its precondition list is now the D2/D4 checklist, and its removal release has a deadline (v0.22.0), with the aliases and the table-dropping migration gone by v0.23.0.
- The risk this ADR accepts is the one ADR-0133 named: a compatibility adapter carried longer than planned. The cost is two more minor releases of a second WhatsApp outbox in the tree; the benefit is that no derived product's tenant is broken by a removal it could not see coming.
- ADR-0047 gains an "Amended by ADR-0054" note where its backstop text sits; ADR-0133 upstream is not edited (it is upstream's, and it already provides for this ADR).
