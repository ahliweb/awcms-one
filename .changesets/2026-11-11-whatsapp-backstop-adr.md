---
bump: patch
type: docs
impact: public
---

# ADR-0054: the commerce WhatsApp legacy-path backstop moves to v0.22.0

Upstream `awcms` ADR-0133 section 6 removes commerce's WhatsApp compatibility adapter and legacy path "no later than the second minor release of the downstream template after the one that first ships `upstream` mode", and requires a new ADR with a new date if the end conditions are not met by then. `upstream` mode and the guarded cutover first shipped in v0.17.0, so the backstop fell due at v0.19.0 and was missed. The conditions (every tenant in `upstream` mode, zero non-terminal legacy rows, retention elapsed, then removal and a final table drop) concern tenants that derived products own, not this template (ADR-0024), so they cannot be evidenced here.

- [ADR-0054](../docs/adr/0054-the-adr-0133-whatsapp-legacy-path-backstop-moves-to-v0-22-0.md) records the new date: removal no later than the second minor release after v0.20.0, v0.22.0, with the same five end conditions, the evidence the removal PR (issue #394) must carry, and the procedure a derived product follows before then (`bun run commerce:whatsapp:cutover` per tenant, drain the legacy queue). A miss of the new date needs another ADR, not a silent slip.
- No code, migration, table or setting changes: every tenant keeps working in its current mode, and `legacy` stays the default. Operators of derived products should plan the per-tenant flip against v0.22.0.
- ADR-0047 carries an "Amended by ADR-0054" note beside its backstop text; the ADR index lists the new record.
