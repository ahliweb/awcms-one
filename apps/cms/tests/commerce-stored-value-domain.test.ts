/**
 * Closed-loop stored value, pure rules (Issue #288, ADR-0030) - no database.
 *
 * The properties pinned here are the ones a reader of the ADR relies on: the
 * code's entropy, alphabet and check character; the tenant-scoped hash (and
 * that nothing else is stored); signed-money arithmetic in integer cents; the
 * ledger rules, which mirror the database trigger; the replay model that
 * reconcile compares the stored projection against (including a randomised
 * ledger); and request validation.
 */
import { describe, expect, test } from "bun:test";

import {
  computeExpiresAt,
  evaluateEntry,
  formatStoredValueCode,
  generateStoredValueCode,
  hashStoredValueCode,
  isStoredValueCodeWellFormed,
  isStoredValueTender,
  maskStoredValueCode,
  normalizeSignedMoney,
  normalizeStoredValueCode,
  replayLedger,
  signedFromCents,
  signedToCents,
  storedValueCheckChar,
  storedValueCodeLast4,
  STORED_VALUE_CODE_ALPHABET,
  STORED_VALUE_CODE_ENTROPY_BITS,
  STORED_VALUE_CODE_LENGTH,
  STORED_VALUE_CODE_RANDOM_LENGTH,
  validateAdjustAccountInput,
  validateChangeStatusInput,
  validateIssueAccountInput,
  validateLoadAccountInput,
  validateReconcileInput,
  validateStoredValueCodeField,
  validateUpsertProgramInput,
  type AccountState,
  type ReplayEntry,
  type StoredValueEntryKind
} from "../src/modules/commerce/domain/stored-value";
import {
  planTenders,
  validatePosTenders,
  validateRecordPaymentInput
} from "../src/modules/commerce/domain/payment-allocation";
import { redactTendersForHash } from "../src/modules/commerce/application/stored-value-tender";

const TENANT = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const OTHER_TENANT = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const NOW = new Date("2026-10-03T10:00:00.000Z");

describe("the redeemable code", () => {
  test("is at least 80 bits of entropy (it is 100) from an unambiguous 32-symbol alphabet", () => {
    expect(STORED_VALUE_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(STORED_VALUE_CODE_ALPHABET).size).toBe(32);
    expect(STORED_VALUE_CODE_ENTROPY_BITS).toBe(100);
    expect(STORED_VALUE_CODE_ENTROPY_BITS).toBeGreaterThanOrEqual(80);
    expect(STORED_VALUE_CODE_RANDOM_LENGTH * Math.log2(32)).toBe(
      STORED_VALUE_CODE_ENTROPY_BITS
    );
    for (const ambiguous of ["I", "O", "0", "1"]) {
      expect(STORED_VALUE_CODE_ALPHABET).not.toContain(ambiguous);
    }
    // Even with the last four characters public (the display form), well over
    // 80 bits of the random part remain.
    expect((STORED_VALUE_CODE_RANDOM_LENGTH - 3) * 5).toBeGreaterThanOrEqual(
      80
    );
  });

  test("a generated code is well-formed, 21 characters, and never repeats across many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      const code = generateStoredValueCode();
      expect(code).toHaveLength(STORED_VALUE_CODE_LENGTH);
      expect(isStoredValueCodeWellFormed(code)).toBe(true);
      seen.add(code);
    }
    expect(seen.size).toBe(2000);
  });

  test("every position is uniform over the alphabet (no modulo bias: 32 = 2^5)", () => {
    const counts = new Map<string, number>();
    const draws = 8000;
    for (let i = 0; i < draws; i += 1) {
      const code = generateStoredValueCode();
      counts.set(code[0]!, (counts.get(code[0]!) ?? 0) + 1);
    }
    expect(counts.size).toBe(32);
    const expected = draws / 32;
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(expected * 0.6);
      expect(count).toBeLessThan(expected * 1.4);
    }
  });

  test("uses the injected CSPRNG bytes, masking each to five bits", () => {
    const code = generateStoredValueCode(() => new Uint8Array(20).fill(0xff));
    expect(code.slice(0, 20)).toBe("9".repeat(20));
    expect(isStoredValueCodeWellFormed(code)).toBe(true);
    const zero = generateStoredValueCode(() => new Uint8Array(20));
    expect(zero.slice(0, 20)).toBe("A".repeat(20));
  });

  test("the check character catches every single-character typo and every adjacent transposition of distinct characters", () => {
    const code = generateStoredValueCode();
    for (let i = 0; i < code.length; i += 1) {
      for (const replacement of STORED_VALUE_CODE_ALPHABET) {
        if (replacement === code[i]) continue;
        const typo = code.slice(0, i) + replacement + code.slice(i + 1);
        expect(isStoredValueCodeWellFormed(typo)).toBe(false);
      }
    }
    let swaps = 0;
    for (let i = 0; i + 1 < code.length; i += 1) {
      if (code[i] === code[i + 1]) continue;
      const swapped =
        code.slice(0, i) + code[i + 1] + code[i] + code.slice(i + 2);
      if (isStoredValueCodeWellFormed(swapped)) continue;
      swaps += 1;
    }
    // Luhn mod N detects adjacent transpositions except the single pair
    // (0, N-1); a random code almost always has none of those.
    expect(swaps).toBeGreaterThan(10);
  });

  test("normalisation upper-cases and strips spaces and hyphens only; there is no O/0 aliasing", () => {
    const code = generateStoredValueCode();
    const shown = formatStoredValueCode(code);
    expect(shown).toMatch(/^[A-Z2-9]{7}-[A-Z2-9]{7}-[A-Z2-9]{7}$/);
    expect(normalizeStoredValueCode(shown)).toBe(code);
    expect(
      normalizeStoredValueCode(` ${shown.toLowerCase().replace(/-/g, " ")} `)
    ).toBe(code);
    expect(isStoredValueCodeWellFormed(normalizeStoredValueCode("O0I1L"))).toBe(
      false
    );
    expect(isStoredValueCodeWellFormed("")).toBe(false);
    expect(isStoredValueCodeWellFormed(code.slice(1))).toBe(false);
    expect(isStoredValueCodeWellFormed(code + "A")).toBe(false);
  });

  test("the stored form is a tenant-scoped sha256 and the plaintext is not derivable from what is displayed", () => {
    const code = generateStoredValueCode();
    const hash = hashStoredValueCode(TENANT, code);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hash).toBe(hashStoredValueCode(TENANT, code));
    expect(hashStoredValueCode(OTHER_TENANT, code)).not.toBe(hash);
    expect(hash).not.toContain(code);
    const last4 = storedValueCodeLast4(code);
    expect(last4).toBe(code.slice(-4));
    const masked = maskStoredValueCode(last4);
    expect(masked).toBe(`•••••••-•••••••-•••${last4}`);
    expect(masked).not.toContain(code.slice(0, 17));
  });

  test("the check character is a pure function of the payload", () => {
    expect(storedValueCheckChar("AAAAA")).toBe(storedValueCheckChar("AAAAA"));
    expect(STORED_VALUE_CODE_ALPHABET).toContain(storedValueCheckChar("ABCDE"));
  });
});

describe("signed money in integer cents", () => {
  test("round-trips, including the sign-losing cases the shared toCents cannot carry", () => {
    for (const value of [
      "0.00",
      "0.50",
      "-0.50",
      "-0.01",
      "12345678.90",
      "-100.00"
    ]) {
      expect(signedFromCents(signedToCents(value))).toBe(value);
    }
    expect(signedToCents("-0.50")).toBe(-50n);
    expect(signedToCents("5")).toBe(500n);
    expect(signedToCents("1.5")).toBe(150n);
    expect(normalizeSignedMoney("-3")).toBe("-3.00");
    expect(() => signedToCents("abc")).toThrow(RangeError);
  });

  test("decimals never drift: 0.10 + 0.20 is exactly 0.30", () => {
    expect(signedFromCents(signedToCents("0.10") + signedToCents("0.20"))).toBe(
      "0.30"
    );
  });
});

function state(overrides: Partial<AccountState> = {}): AccountState {
  return {
    status: "active",
    balanceCents: 10_000n,
    version: 1,
    expiresAt: null,
    ...overrides
  };
}

describe("evaluateEntry mirrors the database trigger", () => {
  test("a redemption can never exceed the available value", () => {
    expect(evaluateEntry(state(), "redeem", -10_000n, NOW)).toMatchObject({
      ok: true
    });
    expect(evaluateEntry(state(), "redeem", -10_001n, NOW)).toEqual({
      ok: false,
      refusal: "INSUFFICIENT",
      available: 10_000n
    });
  });

  test("an expired account takes nothing, ever", () => {
    for (const kind of [
      "load",
      "redeem",
      "refund",
      "adjust",
      "expire",
      "disable",
      "enable"
    ] as StoredValueEntryKind[]) {
      expect(
        evaluateEntry(
          state({ status: "expired" }),
          kind,
          kind === "redeem" ? -1n : 1n,
          NOW
        )
      ).toMatchObject({ ok: false, refusal: "ACCOUNT_EXPIRED" });
    }
  });

  test("a disabled account refuses load/redeem/refund but still takes an adjustment and an enable", () => {
    const disabled = state({ status: "disabled" });
    for (const kind of ["load", "refund"] as StoredValueEntryKind[]) {
      expect(evaluateEntry(disabled, kind, 1n, NOW)).toMatchObject({
        ok: false,
        refusal: "ACCOUNT_UNAVAILABLE"
      });
    }
    expect(evaluateEntry(disabled, "redeem", -1n, NOW)).toMatchObject({
      ok: false,
      refusal: "ACCOUNT_UNAVAILABLE"
    });
    expect(evaluateEntry(disabled, "adjust", -100n, NOW)).toMatchObject({
      ok: true
    });
    const enabled = evaluateEntry(disabled, "enable", 0n, NOW);
    expect(enabled).toMatchObject({ ok: true });
    if (enabled.ok) expect(enabled.next.status).toBe("active");
    expect(evaluateEntry(state(), "enable", 0n, NOW)).toMatchObject({
      ok: false,
      refusal: "NOT_DISABLED"
    });
    expect(evaluateEntry(disabled, "disable", 0n, NOW)).toMatchObject({
      ok: false,
      refusal: "NOT_ACTIVE"
    });
  });

  test("a lapsed account refuses use, and expire is only possible once it lapsed and releases the whole balance", () => {
    const lapsed = state({ expiresAt: new Date(NOW.getTime() - 1) });
    expect(evaluateEntry(lapsed, "redeem", -1n, NOW)).toMatchObject({
      ok: false,
      refusal: "ACCOUNT_LAPSED"
    });
    expect(evaluateEntry(lapsed, "load", 1n, NOW)).toMatchObject({
      ok: false,
      refusal: "ACCOUNT_LAPSED"
    });
    const expired = evaluateEntry(lapsed, "expire", -10_000n, NOW);
    expect(expired).toMatchObject({ ok: true });
    if (expired.ok) {
      expect(expired.next.status).toBe("expired");
      expect(expired.next.balanceCents).toBe(0n);
    }
    expect(
      evaluateEntry(
        state({ expiresAt: new Date(NOW.getTime() + 1000) }),
        "expire",
        -10_000n,
        NOW
      )
    ).toMatchObject({ ok: false, refusal: "NOT_LAPSED" });
    // The boundary is inclusive: an account whose expiry IS now has lapsed.
    expect(
      evaluateEntry(
        state({ expiresAt: new Date(NOW.getTime()) }),
        "redeem",
        -1n,
        NOW
      )
    ).toMatchObject({ ok: false, refusal: "ACCOUNT_LAPSED" });
  });

  test("an adjustment can never take the balance below zero", () => {
    expect(evaluateEntry(state(), "adjust", -10_000n, NOW)).toMatchObject({
      ok: true
    });
    expect(evaluateEntry(state(), "adjust", -10_001n, NOW)).toMatchObject({
      ok: false,
      refusal: "INSUFFICIENT"
    });
  });

  test("an account is issued once, as its first entry", () => {
    expect(
      evaluateEntry(state({ version: 0, balanceCents: 0n }), "issue", 500n, NOW)
    ).toMatchObject({
      ok: true
    });
    expect(evaluateEntry(state(), "issue", 500n, NOW)).toMatchObject({
      ok: false
    });
  });

  test("every accepted entry advances the version by exactly one", () => {
    const result = evaluateEntry(state({ version: 4 }), "load", 100n, NOW);
    expect(result.ok && result.next.version).toBe(5);
  });
});

describe("replayLedger (the model reconcile compares the projection against)", () => {
  const entry = (
    accountSeq: number,
    kind: StoredValueEntryKind,
    amount: string,
    balanceAfter: string
  ): ReplayEntry => ({ accountSeq, kind, amount, balanceAfter });

  test("a consistent ledger replays to its projection with no breaks, and status follows the entries", () => {
    const result = replayLedger([
      entry(1, "issue", "100.00", "100.00"),
      entry(2, "redeem", "-30.00", "70.00"),
      entry(3, "disable", "0.00", "70.00"),
      entry(4, "enable", "0.00", "70.00"),
      entry(5, "refund", "5.50", "75.50")
    ]);
    expect(result).toEqual({
      balance: "75.50",
      version: 5,
      status: "active",
      breaks: []
    });
    expect(
      replayLedger([
        entry(1, "issue", "10.00", "10.00"),
        entry(2, "disable", "0.00", "10.00")
      ]).status
    ).toBe("disabled");
    expect(
      replayLedger([
        entry(1, "issue", "10.00", "10.00"),
        entry(2, "expire", "-10.00", "0.00")
      ])
    ).toMatchObject({ status: "expired", balance: "0.00", breaks: [] });
  });

  test("it reports a gap, a running balance that does not add up, a forbidden sign, a negative balance and an entry after expiry", () => {
    expect(
      replayLedger([
        entry(1, "issue", "10.00", "10.00"),
        entry(3, "load", "1.00", "11.00")
      ]).breaks[0]
    ).toContain("sequence");
    expect(
      replayLedger([
        entry(1, "issue", "10.00", "10.00"),
        entry(2, "load", "1.00", "99.00")
      ]).breaks[0]
    ).toContain("balance_after");
    expect(
      replayLedger([entry(1, "issue", "-10.00", "-10.00")]).breaks.join("|")
    ).toContain("not allowed");
    expect(
      replayLedger([
        entry(1, "issue", "10.00", "10.00"),
        entry(2, "redeem", "-11.00", "-1.00")
      ]).breaks.join("|")
    ).toContain("below zero");
    expect(
      replayLedger([
        entry(1, "issue", "10.00", "10.00"),
        entry(2, "expire", "-10.00", "0.00"),
        entry(3, "adjust", "5.00", "5.00")
      ]).breaks.join("|")
    ).toContain("follows an expiry");
  });

  test("property: a ledger built ONLY from accepted entries always replays clean and to the same balance the rules produced (500 random ledgers)", () => {
    let seed = 0x2f6e2b1;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    for (let round = 0; round < 500; round += 1) {
      let account = state({ version: 0, balanceCents: 0n });
      const entries: ReplayEntry[] = [];
      const kinds: StoredValueEntryKind[] = [
        "load",
        "redeem",
        "refund",
        "adjust",
        "disable",
        "enable"
      ];
      const first = evaluateEntry(
        account,
        "issue",
        BigInt(1 + Math.floor(next() * 100000)),
        NOW
      );
      if (!first.ok) throw new Error("issue refused");
      account = first.next;
      entries.push(
        entry(
          1,
          "issue",
          signedFromCents(account.balanceCents),
          signedFromCents(account.balanceCents)
        )
      );
      for (let step = 0; step < 40; step += 1) {
        const kind = kinds[Math.floor(next() * kinds.length)]!;
        const magnitude = BigInt(1 + Math.floor(next() * 50000));
        const amount =
          kind === "redeem"
            ? -magnitude
            : kind === "adjust"
              ? next() < 0.5
                ? -magnitude
                : magnitude
              : kind === "disable" || kind === "enable"
                ? 0n
                : magnitude;
        const verdict = evaluateEntry(account, kind, amount, NOW);
        if (!verdict.ok) continue; // a refused entry is never written
        account = verdict.next;
        entries.push(
          entry(
            account.version,
            kind,
            signedFromCents(amount),
            signedFromCents(account.balanceCents)
          )
        );
      }
      const replay = replayLedger(entries);
      expect(replay.breaks).toEqual([]);
      expect(replay.balance).toBe(signedFromCents(account.balanceCents));
      expect(replay.version).toBe(account.version);
      expect(replay.status).toBe(account.status);
      expect(account.balanceCents >= 0n).toBe(true);
    }
  });
});

describe("expiry", () => {
  test("computeExpiresAt adds whole days and returns null for never", () => {
    expect(computeExpiresAt(NOW, null)).toBeNull();
    expect(computeExpiresAt(NOW, 30)!.toISOString()).toBe(
      "2026-11-02T10:00:00.000Z"
    );
  });
});

describe("request validation", () => {
  test("issue: kind, amount (string, > 0), customer, expiry, reason", () => {
    const ok = validateIssueAccountInput(
      { kind: "gift_card", amount: "50000.00", reason: "  birthday  " },
      "key-1",
      NOW
    );
    expect(ok).toMatchObject({
      valid: true,
      value: {
        kind: "gift_card",
        amount: "50000.00",
        reason: "birthday",
        expiresAt: undefined
      }
    });
    for (const body of [
      { kind: "voucher", amount: "1.00" },
      { kind: "gift_card", amount: 100 },
      { kind: "gift_card", amount: "0.00" },
      { kind: "gift_card", amount: "-5.00" },
      { kind: "gift_card", amount: "1.005" },
      { kind: "gift_card", amount: "1.00", customerId: "nope" },
      { kind: "gift_card", amount: "1.00", expiresAt: "2020-01-01T00:00:00Z" },
      { kind: "gift_card", amount: "1.00", expiresAt: "not-a-date" },
      { kind: "gift_card", amount: "1.00", reason: "x".repeat(501) }
    ]) {
      expect(validateIssueAccountInput(body, "key-1", NOW).valid).toBe(false);
    }
    expect(
      validateIssueAccountInput({ kind: "gift_card", amount: "1.00" }, "", NOW)
        .valid
    ).toBe(false);
    const never = validateIssueAccountInput(
      { kind: "store_credit", amount: "1.00", expiresAt: null },
      "k",
      NOW
    );
    expect(never.valid && never.value.expiresAt).toBeNull();
    const dated = validateIssueAccountInput(
      {
        kind: "store_credit",
        amount: "1.00",
        expiresAt: "2027-01-01T00:00:00Z"
      },
      "k",
      NOW
    );
    expect(dated.valid && dated.value.expiresAt?.toISOString()).toBe(
      "2027-01-01T00:00:00.000Z"
    );
  });

  test("load / adjust / status / program / reconcile", () => {
    expect(validateLoadAccountInput({ amount: "10.00" }, "k")).toMatchObject({
      valid: true
    });
    expect(validateLoadAccountInput({ amount: "0" }, "k").valid).toBe(false);

    expect(
      validateAdjustAccountInput({ amount: "-5.50", reason: "typo" }, "k")
    ).toMatchObject({
      valid: true,
      value: { amount: "-5.50", reason: "typo" }
    });
    expect(validateAdjustAccountInput({ amount: "5.50" }, "k").valid).toBe(
      false
    ); // reason required
    expect(
      validateAdjustAccountInput({ amount: "0.00", reason: "r" }, "k").valid
    ).toBe(false);
    expect(
      validateAdjustAccountInput({ amount: 5, reason: "r" }, "k").valid
    ).toBe(false);

    expect(
      validateChangeStatusInput({ action: "disable", reason: "lost" }, "k")
        .valid
    ).toBe(true);
    expect(validateChangeStatusInput({ action: "disable" }, "k").valid).toBe(
      false
    );
    expect(validateChangeStatusInput({ action: "enable" }, "k").valid).toBe(
      true
    );
    expect(
      validateChangeStatusInput({ action: "expire", reason: "x" }, "k").valid
    ).toBe(false);

    expect(
      validateUpsertProgramInput({
        enabled: true,
        expiryDays: 365,
        allowRefundToAccount: false,
        maxBalance: "1000000.00"
      })
    ).toMatchObject({
      valid: true,
      value: { expiryDays: 365, maxBalance: "1000000.00" }
    });
    expect(
      validateUpsertProgramInput({ enabled: true, allowRefundToAccount: true })
    ).toMatchObject({
      valid: true,
      value: { expiryDays: null, maxBalance: null }
    });
    for (const body of [
      { allowRefundToAccount: true },
      { enabled: true, allowRefundToAccount: true, expiryDays: 0 },
      { enabled: true, allowRefundToAccount: true, expiryDays: 3651 },
      { enabled: true, allowRefundToAccount: true, expiryDays: 1.5 },
      { enabled: true, allowRefundToAccount: true, maxBalance: "0.00" }
    ]) {
      expect(validateUpsertProgramInput(body).valid).toBe(false);
    }

    expect(validateReconcileInput({})).toMatchObject({
      valid: true,
      value: { repair: false }
    });
    expect(validateReconcileInput({ repair: true })).toMatchObject({
      valid: true,
      value: { repair: true }
    });
    expect(validateReconcileInput({ repair: "yes" }).valid).toBe(false);
  });

  test("the code field: required, checksummed, normalised, never echoed in an error", () => {
    const code = generateStoredValueCode();
    const errors: { field: string; message: string }[] = [];
    expect(
      validateStoredValueCodeField(formatStoredValueCode(code), "c", errors)
    ).toBe(code);
    expect(errors).toEqual([]);
    for (const bad of [
      undefined,
      "",
      "   ",
      "ABC",
      `${code.slice(0, -1)}${code.at(-1) === "A" ? "B" : "A"}`,
      "x".repeat(65)
    ]) {
      const e: { field: string; message: string }[] = [];
      expect(validateStoredValueCodeField(bad, "c", e)).toBeNull();
      expect(e).toHaveLength(1);
      if (typeof bad === "string" && bad.trim().length > 0) {
        expect(e[0]!.message).not.toContain(bad);
      }
    }
  });
});

describe("stored value as a payment tender", () => {
  const code = generateStoredValueCode();

  test("the two kinds are tenders; nothing else is", () => {
    expect(isStoredValueTender("gift_card")).toBe(true);
    expect(isStoredValueTender("store_credit")).toBe(true);
    expect(isStoredValueTender("cash")).toBe(false);
    expect(isStoredValueTender("gateway")).toBe(false);
  });

  test("POS tenders: a card tender needs a valid code and an amount; the code never doubles as the stored free-text reference", () => {
    const errors: { field: string; message: string }[] = [];
    const tenders = validatePosTenders(
      [
        {
          tenderType: "gift_card",
          amount: "6000.00",
          storedValueCode: formatStoredValueCode(code),
          reference: "should-not-stick"
        },
        { tenderType: "cash", amount: "5000.00" }
      ],
      errors
    );
    expect(errors).toEqual([]);
    expect(tenders[0]).toEqual({
      tenderType: "gift_card",
      amount: "6000.00",
      reference: null,
      storedValueCode: code
    });
    expect(tenders[1]).toEqual({
      tenderType: "cash",
      amount: "5000.00",
      reference: null
    });

    const missing: { field: string; message: string }[] = [];
    validatePosTenders(
      [{ tenderType: "store_credit", amount: "1.00" }],
      missing
    );
    expect(missing[0]!.field).toBe("tenders[0].storedValueCode");

    const stray: { field: string; message: string }[] = [];
    validatePosTenders(
      [{ tenderType: "cash", amount: "1.00", storedValueCode: code }],
      stray
    );
    expect(stray[0]!.field).toBe("tenders[0].storedValueCode");

    const duplicate: { field: string; message: string }[] = [];
    validatePosTenders(
      [
        { tenderType: "gift_card", amount: "1.00", storedValueCode: code },
        {
          tenderType: "gift_card",
          amount: "1.00",
          storedValueCode: formatStoredValueCode(code)
        }
      ],
      duplicate
    );
    expect(duplicate.some((e) => e.message.includes("same code"))).toBe(true);
  });

  test("an owner payment body carries the code for a card tender only", () => {
    const ok = validateRecordPaymentInput(
      { tenderType: "gift_card", amount: "1000.00", storedValueCode: code },
      "key"
    );
    expect(ok).toMatchObject({
      valid: true,
      value: { tenderType: "gift_card", storedValueCode: code }
    });
    expect(
      validateRecordPaymentInput(
        { tenderType: "gift_card", amount: "1.00" },
        "key"
      ).valid
    ).toBe(false);
    expect(
      validateRecordPaymentInput(
        { tenderType: "cash", amount: "1.00", storedValueCode: code },
        "key"
      ).valid
    ).toBe(false);
    const plain = validateRecordPaymentInput(
      { tenderType: "cash", amount: "1.00" },
      "key"
    );
    expect(plain.valid && "storedValueCode" in plain.value).toBe(false);
  });

  test("planTenders: a card is a non-cash leg with an explicit amount - change applies to cash only, and a card can never exceed the total", () => {
    const plan = planTenders(
      "10000.00",
      [
        {
          tenderType: "gift_card",
          amount: "6000.00",
          reference: null,
          storedValueCode: code
        },
        { tenderType: "cash", amount: "5000.00", reference: null }
      ],
      { allowDue: false }
    );
    expect(
      plan.legs.map((leg) => [leg.tenderType, leg.amount, leg.changeAmount])
    ).toEqual([
      ["gift_card", "6000.00", null],
      ["cash", "4000.00", "1000.00"]
    ]);
    expect(plan.legs[0]!.storedValueCode).toBe(code);
    expect(plan.changeAmount).toBe("1000.00");

    expect(() =>
      planTenders(
        "10000.00",
        [
          {
            tenderType: "gift_card",
            amount: "10000.01",
            reference: null,
            storedValueCode: code
          }
        ],
        { allowDue: false }
      )
    ).toThrow(/exceeds what is still owed/);
    // Fully covered by cards: a cash tender would only produce change.
    expect(() =>
      planTenders(
        "10000.00",
        [
          {
            tenderType: "store_credit",
            amount: "10000.00",
            reference: null,
            storedValueCode: code
          },
          { tenderType: "cash", amount: "1000.00", reference: null }
        ],
        { allowDue: false }
      )
    ).toThrow(/would only produce change/);
    expect(() =>
      planTenders(
        "10000.00",
        [
          {
            tenderType: "gift_card",
            amount: null,
            reference: null,
            storedValueCode: code
          }
        ],
        { allowDue: false }
      )
    ).toThrow(/explicit amount/);
    // A short card without cash is a shortfall, like any other tender.
    expect(() =>
      planTenders(
        "10000.00",
        [
          {
            tenderType: "gift_card",
            amount: "4000.00",
            reference: null,
            storedValueCode: code
          }
        ],
        { allowDue: false }
      )
    ).toThrow(/do not cover/);
  });

  test("the idempotency request hash input never contains the plaintext, only its tenant-scoped hash; a codeless tender hashes as before", () => {
    const redacted = redactTendersForHash(TENANT, [
      {
        tenderType: "gift_card",
        amount: "1.00",
        reference: null,
        storedValueCode: code
      },
      {
        tenderType: "cash",
        amount: "1.00",
        reference: null,
        storedValueCode: null
      }
    ]);
    const json = JSON.stringify(redacted);
    expect(json).not.toContain(code);
    expect(json).toContain(hashStoredValueCode(TENANT, code));
    expect(redacted![1]).toEqual({
      tenderType: "cash",
      amount: "1.00",
      reference: null
    });
    expect(redactTendersForHash(TENANT, null)).toBeUndefined();
  });
});
