import { describe, expect, test } from "bun:test";

import {
  hasMinimumFieldsToComplete,
  isPracticeSessionStatus,
  isValidIntensityValue,
  PRACTICE_SESSION_INTENSITY_MAX,
  PRACTICE_SESSION_INTENSITY_MIN,
  PRACTICE_SESSION_STATUSES
} from "../src/modules/practice-irm/domain/practice-session";

describe("practice session domain (Issue #270)", () => {
  test("isPracticeSessionStatus accepts only draft/completed", () => {
    for (const status of PRACTICE_SESSION_STATUSES) {
      expect(isPracticeSessionStatus(status)).toBe(true);
    }
    expect(isPracticeSessionStatus("archived")).toBe(false);
    expect(isPracticeSessionStatus(1)).toBe(false);
    expect(isPracticeSessionStatus(null)).toBe(false);
  });

  test("isValidIntensityValue accepts every integer 0-10 inclusive", () => {
    for (
      let n = PRACTICE_SESSION_INTENSITY_MIN;
      n <= PRACTICE_SESSION_INTENSITY_MAX;
      n++
    ) {
      expect(isValidIntensityValue(n)).toBe(true);
    }
  });

  test("isValidIntensityValue rejects out-of-range integers", () => {
    expect(isValidIntensityValue(-1)).toBe(false);
    expect(isValidIntensityValue(11)).toBe(false);
    expect(isValidIntensityValue(100)).toBe(false);
  });

  test("isValidIntensityValue rejects non-integers and non-numbers", () => {
    expect(isValidIntensityValue(5.5)).toBe(false);
    expect(isValidIntensityValue("5")).toBe(false);
    expect(isValidIntensityValue(null)).toBe(false);
    expect(isValidIntensityValue(undefined)).toBe(false);
    expect(isValidIntensityValue(Number.NaN)).toBe(false);
  });

  test("hasMinimumFieldsToComplete requires a non-blank situation and a non-null intensity", () => {
    expect(
      hasMinimumFieldsToComplete({ situation: "Traffic jam", intensity: 6 })
    ).toBe(true);
    expect(
      hasMinimumFieldsToComplete({ situation: "Traffic jam", intensity: 0 })
    ).toBe(true);
    expect(hasMinimumFieldsToComplete({ situation: null, intensity: 6 })).toBe(
      false
    );
    expect(hasMinimumFieldsToComplete({ situation: "   ", intensity: 6 })).toBe(
      false
    );
    expect(
      hasMinimumFieldsToComplete({ situation: "Traffic jam", intensity: null })
    ).toBe(false);
  });
});
