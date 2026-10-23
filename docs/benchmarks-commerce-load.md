🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](benchmarks-commerce-load.id.md)

# Commerce load and concurrency benchmarks (issue #395)

Measured numbers for the commerce money-and-inventory paths under concurrent load, and the verification of PRD M7 (segment preview p95 at most 3 s on 100,000 customers). One command, run from `apps/cms`: `bun run bench:commerce-load` (entry `apps/cms/scripts/bench-commerce-load.ts`, implementation `apps/cms/tests/bench/commerce-load-bench.ts`). Companion to upstream's `apps/cms/docs/awcms/booking-benchmarks.md`, which benchmarks the booking allocator itself; this one benchmarks what this repository's `commerce` module builds on top of it ([ADR-0045](adr/0045-booking-commerce-adapter.md), [ADR-0043](adr/0043-loyalty-points-are-redeemed-as-a-server-priced-discount-line-written-with-the-ledger-debit.md)).

## Not part of the test suites

A timing assertion in `bun test` is a flaky test, so the benchmark is not a `*.test.ts` and is not in `bun run check`. It refuses to run without a superuser `DATABASE_URL` (exit 2). It keeps two kinds of assertion apart:

- **Invariants** are always enforced (exit 1): no double allocation, no double spend, no negative balance, one consistent terminal state per order.
- **Thresholds** (latency and throughput budgets, and M7 itself) are enforced on the `standard` profile unless `--no-thresholds` is passed. Each is a wide margin over the numbers below, except `segmentPreviewP95Ms`, which is the M7 target (3,000 ms) itself.

## What it runs against

The integration harness's throwaway database: every real migration, and the production roles (`awcms_app` under FORCE RLS for the request path, `awcms_worker` for the booking reaper). Each contender is its own pooled connection and its own transaction, so the database sees every contender at once. No production code is changed by this work.

## Environment of the recorded run

| Item               | Value                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------- |
| Date               | 17 October 2026                                                                               |
| Commit             | `37c970fd` (verified: the base, i.e. parent, of PR #425's harness commit `01953109`)          |
| CPU                | Intel Xeon @ 2.10 GHz, `nproc` = 4                                                            |
| Memory             | `free -g`: 15 GiB total, 14 GiB available                                                     |
| Bun                | 1.4.2                                                                                         |
| PostgreSQL         | 18.4 (Debian 18.4-1.pgdg13+1), `postgres:18.4` container, default configuration, same host    |
| Runtime pool       | 40 connections                                                                                |
| Load average (1 m) | 1.84 when the run started; 3.73 when it finished (the benchmark itself saturates the 4 CPUs)  |
| Profile            | `standard`; 99 s wall time                                                                    |

The database and the benchmark share one 4-vCPU machine, so absolute figures are a floor for dedicated hardware, not a ceiling. A sibling agent's checks were running on the same host; the load was below 2 only when the run started.

## Method and results

### 1. Concurrent holds converting to orders on one capacity-limited slot

Each round creates a unit pool of `capacity` units and fires N simultaneous reservation requests (a hold plus its order, ADR-0045 G2/G4), 20 rounds per cell. Invariant: exactly `capacity` orders per round, every loser `SLOT_UNAVAILABLE`, live allocations equal the winners. A replay storm sends 32 requests with one idempotency key and expects one order. A sustained run measures uncontended throughput over 16 lanes.

| Cell                      | Requests | Orders created           | Contender p50 | p95    | p99    | max    |
| ------------------------- | -------- | ------------------------ | ------------- | ------ | ------ | ------ |
| capacity 1, 8 contenders  | 160      | 20 (1/round)             | 90 ms         | 166 ms | 206 ms | 206 ms |
| capacity 5, 8 contenders  | 160      | 100 (5/round)            | 126 ms        | 215 ms | 248 ms | 248 ms |
| capacity 1, 32 contenders | 640      | 20 (1/round)             | 141 ms        | 174 ms | 217 ms | 218 ms |
| capacity 5, 32 contenders | 640      | 100 (5/round)            | 221 ms        | 251 ms | 269 ms | 270 ms |
| replay storm (32 x 10)    | 320      | 10 created, 310 replayed | 46 ms         | 67 ms  | 83 ms  | 88 ms  |
| sustained, 16 lanes       | 300      | 300                      | 280 ms        | 397 ms | 412 ms | 441 ms |

Sustained throughput: **55.6 orders per second**. Result: no double allocation, exactly `capacity` winners in every round, one order per replayed key.

### 2. Hold expiry racing payment settlement

500 independent orders in three cohorts: 100 paid before the reaper starts, 300 racing (payment at a random instant across twice a 5 s window, the hold lapsing at the window), 100 unpaid and already lapsed. The booking reaper (as `awcms_worker`), payment settlement (`recordOwnerPayment`) and the domain-event dispatcher run at the same time. Invariant (ADR-0045): every order ends in exactly one of three states, and a payment that returned ok is held while a refused one is not.

| Terminal state                                                                             | Paid first | Racing | Unpaid expired |
| ------------------------------------------------------------------------------------------ | ---------- | ------ | -------------- |
| `confirmed` (order paid, reservation confirmed, no attention flag)                         | 100        | 86     | 0              |
| `paid_after_expiry_flagged` (paid, reservation expired, `deposit_after_expiry` unresolved) | 0          | 132    | 0              |
| `closed_unpaid` (order expired or cancelled, reservation expired, no money held)           | 0          | 82     | 100            |
| Inconsistent                                                                               | 0          | 0      | 0              |

Payment settlement during the race: p50 13.8 ms, p95 24.6 ms, p99 29.5 ms, max 40.6 ms. The reaper expired 314 holds; the race took 10.0 s for 500 orders (40 orders per second including the sleeps); no domain-event delivery was retried or dead-lettered. Live allocations equal open reservations and no reservation is left `held`. A paid order is never auto-cancelled: the 132 late payments are flagged for a person to resolve, the ADR-0045 rule.

### 3. Concurrent loyalty redemptions on one account

One account, N simultaneous redemptions of 1,000 points each, 20 rounds; the balance is sized so about half can win. Invariants: winners = floor(balance / points), the rest refused as insufficient points, the balance never negative, the ledger sums to the stored balance, `reconcileLoyaltyForTenant` finds no drift.

| Cell       | Balance | Winners per round | Orders created | Refused | Contender p50 | p95    | p99    | max    |
| ---------- | ------- | ----------------- | -------------- | ------- | ------------- | ------ | ------ | ------ |
| 8 workers  | 4,500   | 4                 | 80             | 80      | 64 ms         | 103 ms | 121 ms | 125 ms |
| 32 workers | 16,500  | 16                | 320            | 320     | 183 ms        | 238 ms | 260 ms | 268 ms |

Result: no double spend, 0 negative balances, 0 drifted accounts, 0 ledger breaks.

### 4. Segment preview at 100,000 customers (PRD M7)

A tenant with 100,000 customers and 250,000 paid orders (seeding took 15.7 s) is evaluated by the preview endpoint's evaluator with five rule shapes, 12 rounds each (60 samples), after 5 warm-up evaluations. It also runs with 2 actors at the tenant's evaluation limit and with 6 actors above it, where the excess is refused with the busy outcome.

| Measure                            | p50    | p95        | p99    | max    |
| ---------------------------------- | ------ | ---------- | ------ | ------ |
| Sequential preview (60 samples)    | 293 ms | **410 ms** | 510 ms | 510 ms |
| 2 concurrent actors (12 served)    | 197 ms | 454 ms     | 454 ms | 454 ms |
| 6-actor burst (12 served, 24 busy) | 273 ms | 387 ms     | 387 ms | 387 ms |

Per-rule p95: `level_in_1_2` 28 ms (50,000 members), `order_count_gte_2` 244 ms (100,000), `windowed_orders_spend_not_lapsed` 410 ms (100,000), `account_loyalty_spend_or_tenure` 314 ms (16,666), `two_windows_and_never_not` 510 ms (100,000).

**M7 verified: p95 410 ms against the 3,000 ms target, with about 7x margin.** The burst above the limit completes in 3.98 s wall time with the surplus refused rather than queued.

## Invariant results

| Invariant                                                         | Result |
| ----------------------------------------------------------------- | ------ |
| Exactly `capacity` orders per round, no double allocation         | held   |
| Replayed idempotency key creates one order                        | held   |
| Every order in one consistent terminal state (500 of 500)         | held   |
| Accepted payment is held, refused payment is not                  | held   |
| No auto-cancel of an order holding money                          | held   |
| No loyalty double spend; balance never negative; ledger = balance | held   |
| Loyalty reconcile: drift 0, ledger breaks 0                       | held   |
| M7 p95 at most 3,000 ms                                           | held   |

No violation was found, so no production code was touched.

## Re-running

See [`pengujian.md`](pengujian.md) for the exact commands. `--profile smoke` checks the invariants at small scale in a few seconds; `--only hold,race,loyalty,segment` selects scenarios; `--json <file>` writes the raw figures. Re-measure on quiet hardware (1-minute load below 2) before comparing against these numbers.
