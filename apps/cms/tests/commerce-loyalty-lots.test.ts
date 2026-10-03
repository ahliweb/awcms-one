/**
 * Loyalty lot replay (Issue #289, ADR-0026 D5) — pure unit tests. The replay
 * derives "how much of this earn is still spendable" from the append-only
 * ledger alone; these tests pin its allocation rules, the expiry and reversal
 * arithmetic, and the accounting identity that must hold for ANY ledger.
 */
import { describe, expect, test } from "bun:test";

import {
  computeReversalPoints,
  findExpirableLots,
  replayLoyaltyLots,
  type ReplayEntry
} from "../src/modules/commerce/domain/loyalty-lots";
import type { LoyaltyEntryKind } from "../src/modules/commerce/domain/loyalty";

const DAY = 86_400_000;
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

let counter = 0;
function entry(
  seq: number,
  kind: LoyaltyEntryKind,
  points: number,
  atDay: number,
  extra: Partial<ReplayEntry> = {}
): ReplayEntry {
  counter += 1;
  return {
    id: extra.id ?? `e${seq}-${counter}`,
    accountSeq: seq,
    kind,
    points,
    createdAt: new Date(T0 + atDay * DAY),
    expiresAt: null,
    reversesEntryId: null,
    sourceId: null,
    ...extra
  };
}

const earn = (
  seq: number,
  points: number,
  atDay: number,
  expiresInDays: number | null,
  id?: string
) =>
  entry(seq, "earn", points, atDay, {
    id: id ?? `earn-${seq}`,
    expiresAt:
      expiresInDays === null
        ? null
        : new Date(T0 + (atDay + expiresInDays) * DAY)
  });

describe("replayLoyaltyLots", () => {
  test("a single earn is a lot with everything remaining", () => {
    const { lots, balance, deficit } = replayLoyaltyLots([earn(1, 100, 0, 30)]);
    expect(lots.get("earn-1")?.remaining).toBe(100);
    expect(balance).toBe(100);
    expect(deficit).toBe(0);
  });

  test("a redemption consumes the EARLIEST-EXPIRING lot first", () => {
    const { lots } = replayLoyaltyLots([
      earn(1, 100, 0, 60, "late"),
      earn(2, 100, 1, 10, "soon"),
      entry(3, "redeem", -120, 2)
    ]);
    expect(lots.get("soon")?.remaining).toBe(0);
    expect(lots.get("late")?.remaining).toBe(80);
  });

  test("lots that never expire are consumed last", () => {
    const { lots } = replayLoyaltyLots([
      earn(1, 50, 0, null, "forever"),
      earn(2, 50, 1, 30, "dated"),
      entry(3, "redeem", -60, 2)
    ]);
    expect(lots.get("dated")?.remaining).toBe(0);
    expect(lots.get("forever")?.remaining).toBe(40);
  });

  test("a lot already past its expiry at the debit's instant cannot be spent", () => {
    const { lots, deficit } = replayLoyaltyLots([
      earn(1, 100, 0, 10, "lapsed"),
      earn(2, 50, 5, 100, "live"),
      // day 20: "lapsed" expired on day 10 but has no expire row yet.
      entry(3, "redeem", -50, 20)
    ]);
    expect(lots.get("lapsed")?.remaining).toBe(100);
    expect(lots.get("live")?.remaining).toBe(0);
    expect(deficit).toBe(0);
  });

  test("a debit that no lot can cover becomes a deficit and the balance still sums", () => {
    const { balance, deficit } = replayLoyaltyLots([
      earn(1, 10, 0, null),
      entry(2, "adjustment", -25, 1, { reason: "x" } as Partial<ReplayEntry>)
    ]);
    expect(balance).toBe(-15);
    expect(deficit).toBe(15);
  });

  test("an expire entry consumes exactly its own lot", () => {
    const { lots, balance } = replayLoyaltyLots([
      earn(1, 100, 0, 10, "a"),
      earn(2, 100, 1, 10, "b"),
      entry(3, "expire", -100, 12, { sourceId: "a" })
    ]);
    expect(lots.get("a")?.remaining).toBe(0);
    expect(lots.get("a")?.expired).toBe(100);
    expect(lots.get("b")?.remaining).toBe(100);
    expect(balance).toBe(100);
  });

  test("a reversal consumes its target lot first, then spills onto the others", () => {
    const { lots, deficit } = replayLoyaltyLots([
      earn(1, 100, 0, 30, "target"),
      earn(2, 40, 1, 60, "other"),
      entry(3, "redeem", -70, 2), // takes 70 from "target" (earlier expiry)
      entry(4, "reversal", -100, 3, { reversesEntryId: "target" })
    ]);
    // target had 30 left -> 0; the 70 already spent spills onto "other" (40).
    expect(lots.get("target")?.remaining).toBe(0);
    expect(lots.get("other")?.remaining).toBe(0);
    expect(deficit).toBe(30);
  });

  test("order of the input array does not matter — accountSeq does", () => {
    const entries = [
      earn(1, 100, 0, 30, "x"),
      entry(2, "redeem", -40, 1),
      earn(3, 10, 2, 30, "y")
    ];
    const a = replayLoyaltyLots(entries);
    const b = replayLoyaltyLots([...entries].reverse());
    expect(a.balance).toBe(b.balance);
    expect(a.lots.get("x")?.remaining).toBe(b.lots.get("x")?.remaining);
  });
});

describe("findExpirableLots", () => {
  test("returns lots due at asOf with what is still on them, soonest first", () => {
    const entries = [
      earn(1, 100, 0, 10, "a"),
      earn(2, 100, 1, 5, "b"),
      entry(3, "redeem", -30, 2) // consumes from "b" (earlier expiry)
    ];
    const due = findExpirableLots(entries, new Date(T0 + 20 * DAY));
    expect(due.map((lot) => [lot.lotId, lot.remaining])).toEqual([
      ["b", 70],
      ["a", 100]
    ]);
  });

  test("a lot not yet due is not returned; one exactly at its expiry is", () => {
    const entries = [earn(1, 100, 0, 10, "a")];
    expect(findExpirableLots(entries, new Date(T0 + 9 * DAY))).toEqual([]);
    expect(findExpirableLots(entries, new Date(T0 + 10 * DAY))).toHaveLength(1);
  });

  test("a lot that already has an expire entry is not returned again (idempotent)", () => {
    const entries = [
      earn(1, 100, 0, 10, "a"),
      entry(2, "expire", -100, 11, { sourceId: "a" })
    ];
    expect(findExpirableLots(entries, new Date(T0 + 30 * DAY))).toEqual([]);
  });

  test("a fully-spent due lot is returned with remaining 0 (it still needs its marker)", () => {
    const entries = [earn(1, 100, 0, 10, "a"), entry(2, "redeem", -100, 1)];
    const due = findExpirableLots(entries, new Date(T0 + 30 * DAY));
    expect(due).toHaveLength(1);
    expect(due[0]!.remaining).toBe(0);
  });

  test("a lot with no expiry is never returned", () => {
    expect(
      findExpirableLots([earn(1, 100, 0, null)], new Date(T0 + 9999 * DAY))
    ).toEqual([]);
  });

  test("points spent AFTER the expiry instant do not reduce what expires", () => {
    // "a" lapses on day 10. A redemption on day 15 (before the job ran) could
    // only have spent "b", so all 100 of "a" expire.
    const entries = [
      earn(1, 100, 0, 10, "a"),
      earn(2, 100, 1, 100, "b"),
      entry(3, "redeem", -100, 15)
    ];
    const due = findExpirableLots(entries, new Date(T0 + 20 * DAY));
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ lotId: "a", remaining: 100 });
  });
});

describe("computeReversalPoints", () => {
  test("an untouched earn reverses in full", () => {
    expect(computeReversalPoints([earn(1, 100, 0, 30, "a")], "a")).toBe(100);
  });

  test("points the customer already spent ARE reversed (the balance may go negative)", () => {
    expect(
      computeReversalPoints(
        [earn(1, 100, 0, 30, "a"), entry(2, "redeem", -80, 1)],
        "a"
      )
    ).toBe(100);
  });

  test("points that already lapsed are NOT reversed again", () => {
    expect(
      computeReversalPoints(
        [
          earn(1, 100, 0, 10, "a"),
          entry(2, "redeem", -30, 1),
          entry(3, "expire", -70, 11, { sourceId: "a" })
        ],
        "a"
      )
    ).toBe(30);
  });

  test("an unknown lot reverses nothing", () => {
    expect(computeReversalPoints([earn(1, 10, 0, null, "a")], "zzz")).toBe(0);
  });
});

describe("the accounting identity holds for any generated ledger", () => {
  // A small deterministic PRNG so a failure is reproducible.
  function mulberry32(seed: number) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  test("balance === sum(lot remaining) - deficit, remaining never negative, expired never exceeds the lot", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = mulberry32(seed);
      const entries: ReplayEntry[] = [];
      let seq = 0;
      let day = 0;
      for (let step = 0; step < 40; step += 1) {
        seq += 1;
        day += Math.floor(random() * 6);
        const roll = random();
        if (roll < 0.4) {
          entries.push(
            earn(
              seq,
              1 + Math.floor(random() * 200),
              day,
              random() < 0.3 ? null : 5 + Math.floor(random() * 40)
            )
          );
        } else if (roll < 0.7) {
          entries.push(
            entry(seq, "redeem", -(1 + Math.floor(random() * 150)), day)
          );
        } else if (roll < 0.85) {
          // Expire whatever is due right now, exactly as the job would.
          const due = findExpirableLots(entries, new Date(T0 + day * DAY));
          for (const lot of due) {
            entries.push(
              entry(seq, "expire", -lot.remaining, day, { sourceId: lot.lotId })
            );
            seq += 1;
          }
          seq -= 1;
        } else if (roll < 0.93) {
          entries.push(
            entry(seq, "adjustment", 1 + Math.floor(random() * 50), day)
          );
        } else {
          const earns = entries.filter((e) => e.kind === "earn");
          const reversed = new Set(
            entries
              .filter((e) => e.kind === "reversal")
              .map((e) => e.reversesEntryId)
          );
          const candidates = earns.filter((e) => !reversed.has(e.id));
          const target = candidates[Math.floor(random() * candidates.length)];
          if (target) {
            const points = computeReversalPoints(entries, target.id);
            if (points > 0) {
              entries.push(
                entry(seq, "reversal", -points, day, {
                  reversesEntryId: target.id
                })
              );
            }
          }
        }
      }

      const { lots, balance, deficit } = replayLoyaltyLots(entries);
      let remainingTotal = 0;
      for (const lot of lots.values()) {
        expect(lot.remaining).toBeGreaterThanOrEqual(0);
        expect(lot.expired).toBeLessThanOrEqual(lot.points);
        remainingTotal += lot.remaining;
      }
      expect(balance).toBe(remainingTotal - deficit);
      expect(balance).toBe(entries.reduce((sum, e) => sum + e.points, 0));
    }
  });
});
