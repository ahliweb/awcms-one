/**
 * `src/lib/pesanan-poll.ts`'s pure scheduler (issue #112) — every stop/pause
 * condition as plain data in, decision out, no `document`/timer/`fetch`
 * involved. `wirePesananPolling`'s own impure wiring is exercised only
 * indirectly, through `pesanan.ts`/`akun-pesanan.ts` build-smoke coverage
 * and the e2e scenario — this file is about `nextPollDecision` alone.
 */
import { describe, expect, test } from "bun:test";
import { nextPollDecision, POLL_INTERVAL_MS, POLL_MAX_DURATION_MS } from "../src/lib/pesanan-poll";

const NOW = Date.parse("2026-09-19T10:00:00.000Z");

function baseInput(overrides: Partial<Parameters<typeof nextPollDecision>[0]> = {}) {
  return {
    status: "pending_payment",
    expiresAt: null,
    elapsedMs: 0,
    pageHidden: false,
    nowMs: NOW,
    ...overrides
  };
}

describe("pesanan-poll: nextPollDecision", () => {
  test("keeps polling every 5s while pending_payment, not expired, not hidden, under the 15-minute bound", () => {
    const decision = nextPollDecision(baseInput());
    expect(decision).toEqual({ poll: true, delayMs: POLL_INTERVAL_MS });
  });

  test("stops with reason 'status' once the order leaves pending_payment", () => {
    for (const status of ["paid", "expired", "cancelled", "processing", "shipped", "completed"]) {
      expect(nextPollDecision(baseInput({ status }))).toEqual({ poll: false, reason: "status" });
    }
  });

  test("stops with reason 'expired' once expiresAt has passed", () => {
    const decision = nextPollDecision(
      baseInput({ expiresAt: new Date(NOW - 1000).toISOString() })
    );
    expect(decision).toEqual({ poll: false, reason: "expired" });
  });

  test("does not stop for an expiresAt still in the future", () => {
    const decision = nextPollDecision(
      baseInput({ expiresAt: new Date(NOW + 60_000).toISOString() })
    );
    expect(decision.poll).toBe(true);
  });

  test("stops with reason 'timeout' at/after 15 minutes elapsed", () => {
    expect(nextPollDecision(baseInput({ elapsedMs: POLL_MAX_DURATION_MS }))).toEqual({
      poll: false,
      reason: "timeout"
    });
    expect(nextPollDecision(baseInput({ elapsedMs: POLL_MAX_DURATION_MS + 1 }))).toEqual({
      poll: false,
      reason: "timeout"
    });
    expect(nextPollDecision(baseInput({ elapsedMs: POLL_MAX_DURATION_MS - 1 })).poll).toBe(true);
  });

  test("pauses (reason 'hidden') while the page is hidden — never counted as a genuine stop", () => {
    const decision = nextPollDecision(baseInput({ pageHidden: true }));
    expect(decision).toEqual({ poll: false, reason: "hidden" });
  });

  test("status/expired/timeout take priority over hidden — a genuine stop is not masked by the page being hidden", () => {
    expect(nextPollDecision(baseInput({ status: "paid", pageHidden: true }))).toEqual({
      poll: false,
      reason: "status"
    });
    expect(
      nextPollDecision(baseInput({ expiresAt: new Date(NOW - 1).toISOString(), pageHidden: true }))
    ).toEqual({ poll: false, reason: "expired" });
  });
});
