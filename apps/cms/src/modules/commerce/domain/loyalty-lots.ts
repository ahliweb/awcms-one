/**
 * Loyalty lot accounting — Issue #289, ADR-0026 D5. Pure — no database, no
 * I/O, fully deterministic.
 *
 * ## Why a replay, and why it never mutates anything
 *
 * The ledger is append-only, so "how much of THIS earn is still unspent" cannot
 * be a column that is decremented as points are redeemed. Instead it is
 * DERIVED: walk an account's entries in `accountSeq` order and allocate every
 * debit against the positive entries ("lots") it consumes. The result is a
 * function of the ledger alone — re-running it always gives the same answer,
 * and nothing is stored that could drift.
 *
 * ## The allocation rules
 *
 *   - every positive entry (earn, positive adjustment, positive reversal,
 *     restore) opens a lot of that many points; only an `earn` and a `restore`
 *     (Issue #363) may carry an `expiresAt`;
 *   - a debit (negative `points`) consumes lots EARLIEST-EXPIRY FIRST (lots
 *     that never expire last, ties by `accountSeq`), skipping a lot that had
 *     ALREADY expired at the debit's own instant (`expiresAt <= createdAt`) —
 *     points past their expiry cannot be spent, even before the expiry job has
 *     written the `expire` row;
 *   - an `expire` entry targets exactly one lot (`sourceId` is that lot's
 *     entry id) and consumes from it;
 *   - a `reversal` consumes its target lot first and spills any remainder
 *     (points the customer already spent from that lot) onto the other lots in
 *     the usual order; whatever no lot can cover is recorded as `deficit` — the
 *     balance is allowed to go negative (ADR-0026 D6).
 *
 * `balance` is simply the sum of every entry's points, so
 * `balance === sum(lot remaining) - deficit` always holds; the property test in
 * `tests/commerce-loyalty-lots.test.ts` pins that.
 */
import type { LoyaltyEntryKind } from "./loyalty";

/** The subset of a ledger row the replay reads. */
export type ReplayEntry = {
  id: string;
  accountSeq: number;
  kind: LoyaltyEntryKind;
  points: number;
  /** Instant the row was written (ISO-8601 string or Date). */
  createdAt: string | Date;
  /** Only an `earn` carries one. */
  expiresAt: string | Date | null;
  /** The earn a `reversal` compensates. */
  reversesEntryId: string | null;
  /** For an `expire`: the lot's entry id. */
  sourceId: string | null;
};

export type LotState = {
  /** The entry that opened the lot. */
  lotId: string;
  /** Points the lot opened with. */
  points: number;
  /** Points still unspent, unexpired and un-reversed. */
  remaining: number;
  /** Points taken from this lot by `expire` entries. */
  expired: number;
  expiresAtMs: number | null;
};

export type LotReplayResult = {
  lots: Map<string, LotState>;
  /** Sum of every entry's points. */
  balance: number;
  /** Debit points no lot could cover (a negative balance, in lot terms). */
  deficit: number;
};

function toMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function expiryOrder(
  a: LotState,
  b: LotState,
  seqOf: Map<string, number>
): number {
  const aExpiry = a.expiresAtMs ?? Number.POSITIVE_INFINITY;
  const bExpiry = b.expiresAtMs ?? Number.POSITIVE_INFINITY;
  if (aExpiry !== bExpiry) return aExpiry < bExpiry ? -1 : 1;
  return (seqOf.get(a.lotId) ?? 0) - (seqOf.get(b.lotId) ?? 0);
}

/** Replays `entries` (any order; sorted by `accountSeq` here) into lot state. */
export function replayLoyaltyLots(
  entries: readonly ReplayEntry[]
): LotReplayResult {
  const ordered = [...entries].sort((a, b) => a.accountSeq - b.accountSeq);
  const lots = new Map<string, LotState>();
  const seqOf = new Map<string, number>();
  let balance = 0;
  let deficit = 0;

  /** Consumes up to `amount` from open, not-yet-expired-at-`atMs` lots, FIFO by expiry. Returns what it could NOT cover. */
  const consumeFifo = (amount: number, atMs: number): number => {
    let left = amount;
    const candidates = [...lots.values()]
      .filter(
        (lot) =>
          lot.remaining > 0 &&
          (lot.expiresAtMs === null || lot.expiresAtMs > atMs)
      )
      .sort((a, b) => expiryOrder(a, b, seqOf));

    for (const lot of candidates) {
      if (left <= 0) break;
      const take = Math.min(lot.remaining, left);
      lot.remaining -= take;
      left -= take;
    }
    return left;
  };

  for (const entry of ordered) {
    balance += entry.points;
    const atMs = toMs(entry.createdAt);

    if (entry.points > 0) {
      // Any positive entry opens a lot: an earn, a positive adjustment, a
      // positive reversal and (Issue #363) a `restore` - the last two carry
      // the `expiresAt` of the lot they give back.
      lots.set(entry.id, {
        lotId: entry.id,
        points: entry.points,
        remaining: entry.points,
        expired: 0,
        expiresAtMs: entry.expiresAt === null ? null : toMs(entry.expiresAt)
      });
      seqOf.set(entry.id, entry.accountSeq);
      continue;
    }

    const debit = -entry.points;
    if (debit === 0) continue;

    if (entry.kind === "expire" && entry.sourceId !== null) {
      const lot = lots.get(entry.sourceId);
      if (lot) {
        const take = Math.min(lot.remaining, debit);
        lot.remaining -= take;
        lot.expired += take;
        // An expire row can never be larger than what the lot still held when
        // it was computed; anything beyond is a corrupt ledger, surfaced as a
        // deficit rather than silently dropped.
        deficit += debit - take;
      } else {
        deficit += debit;
      }
      continue;
    }

    let uncovered = debit;
    if (entry.kind === "reversal" && entry.reversesEntryId !== null) {
      const target = lots.get(entry.reversesEntryId);
      if (target) {
        const take = Math.min(target.remaining, uncovered);
        target.remaining -= take;
        uncovered -= take;
      }
    }
    uncovered = consumeFifo(uncovered, atMs);
    deficit += uncovered;
  }

  return { lots, balance, deficit };
}

export type ExpirableLot = {
  lotId: string;
  /** Points still on the lot — the amount its `expire` entry must take (0 = marker only). */
  remaining: number;
  expiresAt: Date;
};

/**
 * Earn lots whose `expiresAt <= asOf` and that have no `expire` entry yet,
 * with the points each still holds — soonest-expiry first. A lot with
 * `remaining === 0` is returned too: it still needs its zero-point marker so
 * the expiry scan terminates (`sql/950`'s `expire_lot_key`).
 */
export function findExpirableLots(
  entries: readonly ReplayEntry[],
  asOf: Date
): ExpirableLot[] {
  const asOfMs = asOf.getTime();
  const { lots } = replayLoyaltyLots(entries);

  const alreadyExpired = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "expire" && entry.sourceId !== null) {
      alreadyExpired.add(entry.sourceId);
    }
  }

  const result: ExpirableLot[] = [];
  for (const lot of lots.values()) {
    if (lot.expiresAtMs === null || lot.expiresAtMs > asOfMs) continue;
    if (alreadyExpired.has(lot.lotId)) continue;
    result.push({
      lotId: lot.lotId,
      remaining: lot.remaining,
      expiresAt: new Date(lot.expiresAtMs)
    });
  }

  return result.sort(
    (a, b) =>
      a.expiresAt.getTime() - b.expiresAt.getTime() ||
      a.lotId.localeCompare(b.lotId)
  );
}

/**
 * The points a `reversal` of the earn lot `lotId` must take: what the lot
 * originally granted MINUS the part that already lapsed through an `expire`
 * entry (those points are gone; clawing them back again would be a double
 * deduction). Points the customer already SPENT from the lot are included —
 * they are clawed back and may drive the balance negative (ADR-0026 D6).
 * Returns 0 when the lot is unknown.
 */
export function computeReversalPoints(
  entries: readonly ReplayEntry[],
  lotId: string
): number {
  const { lots } = replayLoyaltyLots(entries);
  const lot = lots.get(lotId);
  if (!lot) return 0;
  return Math.max(
    0,
    lot.points - lot.expired - pointsReversedFromLot(entries, lotId)
  );
}

/**
 * Points already taken back from the lot by earlier `reversal` entries
 * (Issue #287: a partial refund reverses a PROPORTION of the lot, so a lot can
 * be reversed several times before an order cancellation reverses the rest).
 * A positive number; 0 for a lot nobody reversed.
 */
export function pointsReversedFromLot(
  entries: readonly ReplayEntry[],
  lotId: string
): number {
  let reversed = 0;
  for (const entry of entries) {
    if (entry.kind === "reversal" && entry.reversesEntryId === lotId) {
      reversed += -entry.points;
    }
  }
  return reversed;
}

/**
 * The points a REFUND of `refundedCents` (cumulative, out of `totalCents`)
 * must have taken back from the lot by now, less what was already taken back:
 * `floor(lot points * refunded / total)` capped at what the lot can still
 * give (its points, minus lapsed, minus already reversed). Exact at 100%.
 */
export function computeRefundReversalPoints(
  entries: readonly ReplayEntry[],
  lotId: string,
  refundedCents: bigint,
  totalCents: bigint
): number {
  const { lots } = replayLoyaltyLots(entries);
  const lot = lots.get(lotId);
  if (!lot || totalCents <= 0n || refundedCents <= 0n) return 0;
  const alreadyReversed = pointsReversedFromLot(entries, lotId);
  const target =
    refundedCents >= totalCents
      ? lot.points
      : Number((BigInt(lot.points) * refundedCents) / totalCents);
  const wanted = target - alreadyReversed;
  const room = lot.points - lot.expired - alreadyReversed;
  return Math.max(0, Math.min(wanted, room));
}

/**
 * Issue #363 (ADR-0043 D7). The soonest expiry among the lots a debit of
 * `points` consumes if it is made at `atMs`: the same earliest-expiry-first,
 * skip-already-lapsed allocation `replayLoyaltyLots` applies to a debit. `null`
 * when no consumed lot expires (every one was permanent) or when there is
 * nothing to consume. A redemption records this; the `restore` row that gives
 * the points back copies it, so spending then cancelling cannot turn points
 * that were about to lapse into permanent ones.
 *
 * Pure and read-only: it works on the replay's own lot state and does not
 * mutate the entries.
 */
export function soonestExpiryConsumedBy(
  entries: readonly ReplayEntry[],
  points: number,
  atMs: number
): Date | null {
  const { lots } = replayLoyaltyLots(entries);
  const seqOf = new Map<string, number>();
  for (const entry of entries) seqOf.set(entry.id, entry.accountSeq);

  const candidates = [...lots.values()]
    .filter(
      (lot) =>
        lot.remaining > 0 &&
        (lot.expiresAtMs === null || lot.expiresAtMs > atMs)
    )
    .sort((a, b) => expiryOrder(a, b, seqOf));

  let left = points;
  let soonest: number | null = null;
  for (const lot of candidates) {
    if (left <= 0) break;
    const take = Math.min(lot.remaining, left);
    left -= take;
    if (take > 0 && lot.expiresAtMs !== null) {
      soonest =
        soonest === null ? lot.expiresAtMs : Math.min(soonest, lot.expiresAtMs);
    }
  }
  return soonest === null ? null : new Date(soonest);
}
