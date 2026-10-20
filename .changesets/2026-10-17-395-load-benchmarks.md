---
bump: patch
type: content
impact: internal
---

# Load and concurrency benchmarks for hold-to-order, deposit races, loyalty redemptions and segment preview (issue #395)

`bun run bench:commerce-load` (in `apps/cms`) is a new, opt-in benchmark target, deliberately outside `bun run check` and the normal integration run. Against a throwaway migrated PostgreSQL under the production roles it measures and asserts four things: N concurrent holds converting to orders on one unit pool (exactly `capacity` orders, no double allocation, a same-key replay storm creates one order); the C-08 expiry-versus-payment race at volume with the booking reaper, payment settlement and the domain-event dispatcher all running at once (every order ends in one of three consistent terminal states, none auto-cancelled while it holds money); concurrent loyalty redemptions on one account (no double spend, the balance never negative, the ledger sums to the balance); and the segment preview on a 100,000-customer tenant (PRD M7: p95 at most 3 s).

The measured numbers, the machine they were taken on and the invariant results are recorded in `docs/benchmarks-commerce-load.md`, with an Indonesian mirror; `docs/pengujian.md` and the docs index say how to run it. No production code changes. It reuses `percentile` from upstream's `apps/cms/tests/bench/booking-bench.ts`, which stays unmodified.
