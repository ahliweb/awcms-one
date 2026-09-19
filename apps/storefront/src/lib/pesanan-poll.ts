/**
 * The `/pesanan` (and `/akun/pesanan` detail view) live-polling scheduler
 * for a `gateway` order still `pending_payment` (issue #112, contract: #106
 * D3 — "`/pesanan?kode=` polls the order every 5 s while `pending_payment`").
 *
 * `nextPollDecision` is the PURE half — no `document`, no timer, no
 * `fetch` — so `tests/pesanan-poll.test.ts` exercises every stop/pause
 * condition as plain data in, decision out, with nothing to fake. Every
 * other function in this file is impure wiring built on top of it, used by
 * `src/scripts/pesanan.ts` and `src/scripts/akun-pesanan.ts` identically.
 */

export const POLL_INTERVAL_MS = 5_000;
/** 15 minutes, this issue's own bound — a shopper who leaves the tab open on a stale gateway session forever is not this poller's job to keep re-fetching. */
export const POLL_MAX_DURATION_MS = 15 * 60_000;

export type PollStopReason = "status" | "expired" | "timeout" | "hidden";

export type PollInput = {
  /** The order's LATEST known status — polling only continues while this is `"pending_payment"`. */
  status: string;
  /** The order's `expiresAt`, or `null` for an order with none. */
  expiresAt: string | null;
  /** Milliseconds since polling started for this order — compared against `POLL_MAX_DURATION_MS`. */
  elapsedMs: number;
  /** `document.hidden` at decision time. */
  pageHidden: boolean;
  /** Injectable for tests; defaults to `Date.now()` at call sites. */
  nowMs: number;
};

export type PollDecision = { poll: true; delayMs: number } | { poll: false; reason: PollStopReason };

/**
 * One decision per tick: keep polling (`{poll:true, delayMs}`) or stop
 * (`{poll:false, reason}`). `"hidden"` is the one reason that is a PAUSE,
 * not a teardown — `wirePesananPolling` below resumes on `visibilitychange`
 * rather than discarding the poller; every OTHER reason is a genuine stop
 * (the order left `pending_payment`, its `expiresAt` passed, or 15 minutes
 * of polling elapsed) that a fresh page load, not a resumed timer, is the
 * only way back from.
 */
export function nextPollDecision(input: PollInput): PollDecision {
  if (input.status !== "pending_payment") return { poll: false, reason: "status" };
  if (input.expiresAt !== null && Date.parse(input.expiresAt) <= input.nowMs) {
    return { poll: false, reason: "expired" };
  }
  if (input.elapsedMs >= POLL_MAX_DURATION_MS) return { poll: false, reason: "timeout" };
  if (input.pageHidden) return { poll: false, reason: "hidden" };
  return { poll: true, delayMs: POLL_INTERVAL_MS };
}

export type PesananPoller = { stop: () => void };

export type WirePesananPollingOptions = {
  /** The most recently rendered order's own `status`/`expiresAt` — read fresh on every tick, so a status change from a PREVIOUS tick's `fetchAndRender` is what actually stops the next one. */
  getOrderState: () => { status: string; expiresAt: string | null };
  /** One `getOrder` (or `ambilPesananAkunByKode`) call + one re-render — errors are swallowed here (a transient network hiccup), the scheduler simply tries again on its own next tick rather than tearing the poller down over one failed fetch. */
  fetchAndRender: () => Promise<void>;
  onStop?: (reason: PollStopReason) => void;
};

/**
 * The impure wiring `pesanan.ts`/`akun-pesanan.ts` call once a `gateway`
 * order in `pending_payment` first renders — every subsequent tick's
 * decision (including whether the order has since left `pending_payment`)
 * is read fresh from `getOrderState`, never cached inside this function.
 */
export function wirePesananPolling(options: WirePesananPollingOptions): PesananPoller {
  const startedAtMs = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function hasDocument(): boolean {
    return typeof document !== "undefined";
  }

  function schedule(): void {
    if (stopped) return;

    const state = options.getOrderState();
    const decision = nextPollDecision({
      status: state.status,
      expiresAt: state.expiresAt,
      elapsedMs: Date.now() - startedAtMs,
      pageHidden: hasDocument() && document.hidden,
      nowMs: Date.now()
    });

    if (!decision.poll) {
      if (decision.reason === "hidden") return; // paused — `handleVisibility` resumes it.
      stopped = true;
      options.onStop?.(decision.reason);
      return;
    }

    timer = setTimeout(() => {
      void options.fetchAndRender().finally(schedule);
    }, decision.delayMs);
  }

  function handleVisibility(): void {
    if (hasDocument() && !document.hidden) schedule();
  }

  if (hasDocument()) document.addEventListener("visibilitychange", handleVisibility);
  schedule();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (hasDocument()) document.removeEventListener("visibilitychange", handleVisibility);
    }
  };
}
