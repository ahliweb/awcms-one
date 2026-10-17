/**
 * Entry point of `bun run bench:commerce-load` (Issue #395): load and
 * concurrency benchmarks for hold-to-order, the expiry-versus-payment race,
 * concurrent loyalty redemptions and the segment preview (PRD M7). The
 * implementation, its scenarios and its thresholds are in
 * `tests/bench/commerce-load-bench.ts`; the numbers and the hardware they were
 * taken on are in `docs/benchmarks-commerce-load.md`. Deliberately not a
 * `*.test.ts` and not part of `bun run check`.
 */
import { main } from "../tests/bench/commerce-load-bench";

process.exit(await main());
