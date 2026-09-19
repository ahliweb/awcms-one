/**
 * `commerce/domain/customer-account-validation.ts` unit tests (Issue #87,
 * C1, contract #86/ADR-0016 D4). Pure — no database, no network.
 */
import { describe, expect, test } from "bun:test";

import {
  isWellFormedEmail,
  normalizeEmail,
  resolveHistoryFrom,
  validateRegistration
} from "../src/modules/commerce/domain/customer-account-validation";

describe("normalizeEmail", () => {
  test("lowercases and trims", () => {
    expect(normalizeEmail("  Budi.Santoso@Example.COM  ")).toBe(
      "budi.santoso@example.com"
    );
  });
});

describe("isWellFormedEmail", () => {
  test("accepts an ordinary address", () => {
    expect(isWellFormedEmail("budi@example.com")).toBe(true);
  });

  test("rejects missing @, missing domain, and embedded whitespace", () => {
    expect(isWellFormedEmail("budi.example.com")).toBe(false);
    expect(isWellFormedEmail("budi@")).toBe(false);
    expect(isWellFormedEmail("bu di@example.com")).toBe(false);
  });
});

describe("validateRegistration", () => {
  test("accepts a well-formed registration and normalises phone/email", () => {
    const result = validateRegistration({
      name: "Budi Santoso",
      phone: "0812-3456-7890",
      email: "  Budi@Example.com "
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.name).toBe("Budi Santoso");
      expect(result.value.phone).toBe("+6281234567890");
      expect(result.value.emailNormalized).toBe("budi@example.com");
    }
  });

  test("rejects a missing name/phone/email with field-tagged errors", () => {
    const result = validateRegistration({});
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const fields = result.errors.map((e) => e.field).sort();
      expect(fields).toEqual(["email", "name", "phone"]);
    }
  });

  test("rejects an invalid phone shape", () => {
    const result = validateRegistration({
      name: "Budi",
      phone: "not-a-phone",
      email: "budi@example.com"
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.field === "phone")).toBe(true);
    }
  });

  test("rejects an invalid email shape", () => {
    const result = validateRegistration({
      name: "Budi",
      phone: "081234567890",
      email: "not-an-email"
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.field === "email")).toBe(true);
    }
  });
});

describe("resolveHistoryFrom (ADR-0016 D4)", () => {
  const guestCreatedAt = new Date("2026-01-01T00:00:00.000Z");
  const now = new Date("2026-09-19T00:00:00.000Z");

  test("returns the guest row's created_at when e-mails match (case/whitespace-insensitive)", () => {
    const result = resolveHistoryFrom({
      guestCustomerEmail: "  Budi@Example.com ",
      verifiedEmail: "budi@example.com",
      guestCreatedAt,
      now
    });
    expect(result).toEqual(guestCreatedAt);
  });

  test("returns now() when e-mails differ", () => {
    const result = resolveHistoryFrom({
      guestCustomerEmail: "lain@example.com",
      verifiedEmail: "budi@example.com",
      guestCreatedAt,
      now
    });
    expect(result).toEqual(now);
  });

  test("returns now() when the guest row has no e-mail at all", () => {
    const result = resolveHistoryFrom({
      guestCustomerEmail: null,
      verifiedEmail: "budi@example.com",
      guestCreatedAt,
      now
    });
    expect(result).toEqual(now);
  });
});
