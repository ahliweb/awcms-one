import { afterAll, describe, expect, mock, test } from "bun:test";

import * as realStore from "../src/modules/commerce/application/customer-account-store";
import type { CustomerOtpChannel } from "../src/modules/commerce/domain/customer-otp-channel";

// Captured at load time, BEFORE any `mock.module` runs — see
// `identifier-masking.test.ts`'s own header for why: `mock.module` mutates
// the process-wide module registry and does not undo itself, so every other
// test file that imports `customer-account-store.ts` after this one runs
// would otherwise see the stub.
const ORIGINAL = { ...realStore };

/** A callable stand-in for `Bun.SQL` — `recordAuditEvent` runs `tx\`INSERT …\`` unconditionally on every branch below, so the fake has to be a callable tagged-template function, not just an object. It always resolves to an empty row set. */
const fakeTx = (() => Promise.resolve([])) as unknown as Bun.SQL;

/**
 * `application/customer-auth.ts`'s branching (Issue #89), with the store
 * mocked — the validation branches below never touch a `tx` at all (they
 * return before any store call), and the OTP/account branches drive the
 * store's return shape directly rather than reconstructing a fake
 * `WITH … UPDATE … RETURNING` query result.
 */
describe("requestCustomerOtp — validation (Issue #89)", () => {
  test("rejects a malformed purpose without calling the store", async () => {
    const { requestCustomerOtp } =
      await import("../src/modules/commerce/application/customer-auth");

    const explodingTx = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error("must not query");
        }
      }
    ) as unknown as Bun.SQL;
    const explodingChannel: CustomerOtpChannel = {
      sendOtp: () => {
        throw new Error("must not send");
      }
    };

    const outcome = await requestCustomerOtp(
      explodingTx,
      "tenant-1",
      "Toko Uji",
      { email: "shopper@example.com", purpose: "not-a-purpose" },
      explodingChannel
    );

    expect(outcome.kind).toBe("validation_error");
  });

  test("register without name/phone is a validation error (field errors before the e-mail goes out)", async () => {
    const { requestCustomerOtp } =
      await import("../src/modules/commerce/application/customer-auth");

    const explodingTx = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error("must not query");
        }
      }
    ) as unknown as Bun.SQL;
    const explodingChannel: CustomerOtpChannel = {
      sendOtp: () => {
        throw new Error("must not send");
      }
    };

    const outcome = await requestCustomerOtp(
      explodingTx,
      "tenant-1",
      "Toko Uji",
      { email: "shopper@example.com", purpose: "register" },
      explodingChannel
    );

    expect(outcome.kind).toBe("validation_error");
    if (outcome.kind === "validation_error") {
      const fields = outcome.errors.map((error) => error.field);
      expect(fields).toContain("name");
      expect(fields).toContain("phone");
    }
  });
});

describe("verifyCustomerOtp — branching against a mocked store (Issue #89)", () => {
  afterAll(() => {
    mock.module(
      "../src/modules/commerce/application/customer-account-store",
      () => ORIGINAL
    );
  });

  test("every consumeOtp failure reason collapses to otp_invalid", async () => {
    mock.module(
      "../src/modules/commerce/application/customer-account-store",
      () => ({
        ...ORIGINAL,
        consumeOtp: async () => ({
          ok: false as const,
          reason: "exhausted" as const
        })
      })
    );

    const { verifyCustomerOtp } =
      await import("../src/modules/commerce/application/customer-auth");

    const outcome = await verifyCustomerOtp(
      fakeTx,
      "tenant-1",
      { email: "shopper@example.com", code: "123456", purpose: "login" },
      { clientIpHash: null, userAgentSummary: null }
    );

    expect(outcome.kind).toBe("otp_invalid");
  });

  test("login with no matching account answers account_not_found", async () => {
    mock.module(
      "../src/modules/commerce/application/customer-account-store",
      () => ({
        ...ORIGINAL,
        consumeOtp: async () => ({
          ok: true as const,
          otp: { id: "otp-1", purpose: "login" as const, registration: null }
        }),
        findAccountByEmail: async () => null
      })
    );

    const { verifyCustomerOtp } =
      await import("../src/modules/commerce/application/customer-auth");

    const outcome = await verifyCustomerOtp(
      fakeTx,
      "tenant-1",
      { email: "shopper@example.com", code: "123456", purpose: "login" },
      { clientIpHash: null, userAgentSummary: null }
    );

    expect(outcome.kind).toBe("account_not_found");
  });

  test("login against a blocked account answers blocked, never issuing a session", async () => {
    let issueSessionCalled = false;

    mock.module(
      "../src/modules/commerce/application/customer-account-store",
      () => ({
        ...ORIGINAL,
        consumeOtp: async () => ({
          ok: true as const,
          otp: { id: "otp-1", purpose: "login" as const, registration: null }
        }),
        findAccountByEmail: async () => ({
          id: "acct-1",
          customerId: "cust-1",
          emailMasked: "s***@example.com",
          status: "blocked" as const,
          emailVerifiedAt: null,
          historyFrom: new Date().toISOString(),
          lastLoginAt: null,
          createdAt: new Date().toISOString()
        }),
        issueSession: async () => {
          issueSessionCalled = true;
          throw new Error("must not issue a session for a blocked account");
        }
      })
    );

    const { verifyCustomerOtp } =
      await import("../src/modules/commerce/application/customer-auth");

    const outcome = await verifyCustomerOtp(
      fakeTx,
      "tenant-1",
      { email: "shopper@example.com", code: "123456", purpose: "login" },
      { clientIpHash: null, userAgentSummary: null }
    );

    expect(outcome.kind).toBe("blocked");
    expect(issueSessionCalled).toBe(false);
  });

  test("register with a phone already bound to an account answers phone_already_registered", async () => {
    mock.module(
      "../src/modules/commerce/application/customer-account-store",
      () => ({
        ...ORIGINAL,
        consumeOtp: async () => ({
          ok: true as const,
          otp: {
            id: "otp-1",
            purpose: "register" as const,
            registration: { name: "Budi", phone: "+6281234567890" }
          }
        }),
        findAccountByPhone: async () => ({
          id: "acct-existing",
          customerId: "cust-existing",
          emailMasked: "b***@example.com",
          status: "active" as const,
          emailVerifiedAt: null,
          historyFrom: new Date().toISOString(),
          lastLoginAt: null,
          createdAt: new Date().toISOString()
        })
      })
    );

    const { verifyCustomerOtp } =
      await import("../src/modules/commerce/application/customer-auth");

    const outcome = await verifyCustomerOtp(
      fakeTx,
      "tenant-1",
      { email: "budi@example.com", code: "123456", purpose: "register" },
      { clientIpHash: null, userAgentSummary: null }
    );

    expect(outcome.kind).toBe("phone_already_registered");
  });
});
