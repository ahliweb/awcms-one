/**
 * The pure helpers of the booking adapter's admin screens (Issue #385).
 * Asserts what the screens send: the POLICY, never a computed deposit, and a
 * specific message per server refusal code.
 */
import { describe, expect, test } from "bun:test";

import {
  buildDepositPolicyBody,
  isUuidText,
  markFieldInvalid,
  newIdempotencyKey,
  pickRefusalMessage,
  showStatusAndFocus
} from "../src/lib/ui/commerce-booking-client";

describe("buildDepositPolicyBody", () => {
  test("full payment carries no amount", () => {
    expect(buildDepositPolicyBody("full", "30", "5")).toEqual({
      ok: true,
      body: { kind: "full" }
    });
  });

  test("percent accepts up to two decimals within 0 < p <= 100", () => {
    expect(buildDepositPolicyBody("percent", " 30.5 ", "")).toEqual({
      ok: true,
      body: { kind: "percent", percent: "30.5" }
    });
    expect(buildDepositPolicyBody("percent", "100", "").ok).toBe(true);
    for (const bad of ["", "0", "100.01", "101", "-5", "1.234", "abc"]) {
      expect(buildDepositPolicyBody("percent", bad, "")).toEqual({
        ok: false,
        field: "percent"
      });
    }
  });

  test("fixed accepts a positive amount with at most two decimals", () => {
    expect(buildDepositPolicyBody("fixed", "", "50000.00")).toEqual({
      ok: true,
      body: { kind: "fixed", fixedAmount: "50000.00" }
    });
    for (const bad of ["", "0", "0.00", "-1", "1.234", "1e3"]) {
      expect(buildDepositPolicyBody("fixed", "", bad)).toEqual({
        ok: false,
        field: "fixedAmount"
      });
    }
  });

  test("an unknown kind is refused and never produces a body", () => {
    expect(buildDepositPolicyBody("amount", "10", "10")).toEqual({
      ok: false,
      field: "kind"
    });
  });
});

describe("isUuidText", () => {
  test("accepts a canonical uuid and rejects anything else", () => {
    expect(isUuidText("0192f3a0-1b2c-4d5e-8f90-abcdef012345")).toBe(true);
    expect(isUuidText(" 0192f3a0-1b2c-4d5e-8f90-abcdef012345 ")).toBe(true);
    expect(isUuidText("not-a-uuid")).toBe(false);
    expect(isUuidText("")).toBe(false);
  });
});

describe("pickRefusalMessage", () => {
  const map = JSON.stringify({ PRODUCT_NOT_SERVICE: "service only" });
  test("returns the message for a known code", () => {
    expect(pickRefusalMessage(map, "PRODUCT_NOT_SERVICE", "generic")).toBe(
      "service only"
    );
  });
  test("falls back for an unknown code, a missing code or a bad map", () => {
    expect(pickRefusalMessage(map, "OTHER", "generic")).toBe("generic");
    expect(pickRefusalMessage(map, null, "generic")).toBe("generic");
    expect(pickRefusalMessage(undefined, "X", "generic")).toBe("generic");
    expect(pickRefusalMessage("{not json", "X", "generic")).toBe("generic");
  });
});

test("an idempotency key is a fresh uuid per attempt", () => {
  const a = newIdempotencyKey();
  expect(isUuidText(a)).toBe(true);
  expect(newIdempotencyKey()).not.toBe(a);
});

// Issue #448: the focus helpers, against a minimal stand-in for the DOM (the
// helpers touch only these members), so the contract is asserted without a browser.
describe("showStatusAndFocus and markFieldInvalid", () => {
  type Fake = {
    textContent: string;
    hidden: boolean;
    focused: number;
    attrs: Map<string, string>;
    hasAttribute(name: string): boolean;
    setAttribute(name: string, value: string): void;
    getAttribute(name: string): string | null;
    removeAttribute(name: string): void;
    focus(): void;
  };
  const fake = (): Fake => ({
    textContent: "",
    hidden: true,
    focused: 0,
    attrs: new Map(),
    hasAttribute(name) {
      return this.attrs.has(name);
    },
    setAttribute(name, value) {
      this.attrs.set(name, value);
    },
    getAttribute(name) {
      return this.attrs.get(name) ?? null;
    },
    removeAttribute(name) {
      this.attrs.delete(name);
    },
    focus() {
      this.focused += 1;
    }
  });

  test("a status line is filled, shown and focused, and made focusable once", () => {
    const element = fake();
    showStatusAndFocus(element as unknown as HTMLElement, "Linked.");
    expect(element.textContent).toBe("Linked.");
    expect(element.hidden).toBe(false);
    expect(element.focused).toBe(1);
    expect(element.getAttribute("tabindex")).toBe("-1");
    // An element that already declares its tabindex keeps it.
    const own = fake();
    own.setAttribute("tabindex", "0");
    showStatusAndFocus(own as unknown as HTMLElement, "x");
    expect(own.getAttribute("tabindex")).toBe("0");
  });

  test("a missing element is a no-op", () => {
    expect(() => showStatusAndFocus(null, "x")).not.toThrow();
    expect(() => markFieldInvalid(null, true, "e")).not.toThrow();
  });

  test("an invalid field is marked, described by its message once, and focused", () => {
    const input = fake();
    input.setAttribute("aria-describedby", "hint");
    markFieldInvalid(input as unknown as HTMLElement, true, "err");
    markFieldInvalid(input as unknown as HTMLElement, true, "err");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("hint err");
    expect(input.focused).toBe(2);
    markFieldInvalid(input as unknown as HTMLElement, false);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(input.focused).toBe(2);
  });
});
