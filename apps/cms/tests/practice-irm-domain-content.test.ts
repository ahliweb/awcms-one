import { describe, expect, test } from "bun:test";

import {
  DEFAULT_PRACTICE_IRM_DOMAIN_CONTENT,
  isPracticeIrmDomainKey,
  PRACTICE_IRM_DOMAIN_KEYS
} from "../src/modules/practice-irm/domain/practice-irm-domain-content";

describe("practice-irm domain content (Issue #270)", () => {
  test("PRACTICE_IRM_DOMAIN_KEYS is exactly the five canonical IRM domains, in cycle order", () => {
    expect(PRACTICE_IRM_DOMAIN_KEYS).toEqual([
      "identify",
      "neutralize",
      "navigate",
      "embed",
      "reinforce"
    ]);
  });

  test("isPracticeIrmDomainKey accepts only the five declared keys", () => {
    for (const key of PRACTICE_IRM_DOMAIN_KEYS) {
      expect(isPracticeIrmDomainKey(key)).toBe(true);
    }
    expect(isPracticeIrmDomainKey("diagnose")).toBe(false);
    expect(isPracticeIrmDomainKey("IDENTIFY")).toBe(false);
    expect(isPracticeIrmDomainKey(123)).toBe(false);
    expect(isPracticeIrmDomainKey(null)).toBe(false);
    expect(isPracticeIrmDomainKey(undefined)).toBe(false);
  });

  test("DEFAULT_PRACTICE_IRM_DOMAIN_CONTENT has one non-empty entry per domain key", () => {
    for (const key of PRACTICE_IRM_DOMAIN_KEYS) {
      const entry = DEFAULT_PRACTICE_IRM_DOMAIN_CONTENT[key];
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.copy.length).toBeGreaterThan(0);
      expect(entry.displayOrder).toBeGreaterThan(0);
    }
  });

  test("DEFAULT_PRACTICE_IRM_DOMAIN_CONTENT's displayOrder walks the cycle 1..5 with no gaps or repeats", () => {
    const orders = PRACTICE_IRM_DOMAIN_KEYS.map(
      (key) => DEFAULT_PRACTICE_IRM_DOMAIN_CONTENT[key].displayOrder
    );
    expect([...orders].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });
});
