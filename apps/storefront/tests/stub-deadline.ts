/**
 * How long a build-smoke test waits for `scripts/stub-awcms.mjs` to answer
 * its first request before declaring the run broken.
 *
 * It used to be a 5 s literal repeated in every smoke test. The stub now
 * loads a dozen fixtures and boots a dozen state machines (accounts,
 * conversations, gateway sessions, courier rates…), and the root `bun test`
 * runs sixteen of these builds concurrently on a two-core CI runner — so a
 * cold start regularly crossed 5 s and a genuinely green change failed CI on
 * a timing accident (PR #122 was the fourth such rerun). Twenty seconds is
 * still short enough that a stub that truly cannot start fails the test
 * within the test's own 55–60 s budget, and long enough that CPU contention
 * alone no longer decides the outcome. One constant, so the next adjustment
 * is one line.
 */
export const STUB_START_DEADLINE_MS = 20_000;
