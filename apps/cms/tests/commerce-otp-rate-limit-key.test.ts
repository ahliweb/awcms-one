import { describe, expect, test } from "bun:test";
import {
  otpEmailRateLimitKey,
  otpPhoneRateLimitKey
} from "../src/modules/commerce/domain/otp-rate-limit-key";

describe("otpPhoneRateLimitKey — one bucket per real number (OTP-bombing guard)", () => {
  test("the spellings a shopper types collapse to one key", () => {
    const keys = new Set(
      [
        "+62 812-3456-7890",
        "0812 3456 7890",
        "628123456 7890",
        "62812\t34567890"
      ].map(otpPhoneRateLimitKey)
    );
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe(
      "commerce:account:otp:request:phone:6281234567890"
    );
  });

  test("garbage yields no key rather than a shared junk bucket", () => {
    expect(otpPhoneRateLimitKey("")).toBeNull();
    expect(otpPhoneRateLimitKey("abc")).toBeNull();
    expect(otpPhoneRateLimitKey(12345678)).toBeNull();
    expect(otpPhoneRateLimitKey("12345")).toBeNull();
  });
});

describe("otpEmailRateLimitKey", () => {
  test("case and whitespace do not split the bucket", () => {
    expect(otpEmailRateLimitKey("  Budi@Example.COM ")).toBe(
      "commerce:account:otp:request:email:budi@example.com"
    );
    expect(otpEmailRateLimitKey("")).toBeNull();
    expect(otpEmailRateLimitKey(null)).toBeNull();
  });
});
