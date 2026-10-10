---
bump: patch
type: dependency
impact: internal
---

# Sync apps/cms to AWCMS v10.7.0 and adopt descriptor-declared domain-event consumers

Subtree sync of `apps/cms` from upstream `66c74273` (AWCMS v10.7.0, 7 commits; issue #347). No new migration.

- Upstream ADR-0134 (ahliweb/awcms#926): consumers are declared in `ModuleDescriptor.domainEventConsumers` (module contract 4.2.0) and the runtime builds its registry from the composed module list; the new `domain-events:consumers:check` gate is in the `apps/cms` check chain.
- This repo's standing divergence in `domain-event-runtime/infrastructure/consumer-registry.ts` is **retired**: upstream's file is taken unchanged and the four `commerce` consumers (`commerce.order_paid_entitlement_grantor`, `commerce.order_paid_loyalty_earner`, `commerce.order_cancelled_loyalty_reverser`, `commerce.inventory_stock_cache_projector`) are declared in the commerce module descriptor with unchanged names. The `domain_event_runtime -> commerce` module-boundary exception is gone.
- Wave A design packs for booking, hr_payroll and delivery plus provisional cross-domain AsyncAPI events arrive as documentation.
- `AGENTS.md` / `AGENTS.id.md` "Last sync" row and divergence list, and `docs/aw-business-platform-dor.md` DoR item 9, are updated.
