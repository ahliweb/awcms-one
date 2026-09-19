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

/**
 * Issue #108, contract #106/ADR-0017 D5 — `via: "whatsapp"` request-side
 * branching. No database: validation and `channel_unavailable` both return
 * before any store call.
 */
describe("requestCustomerOtp — via: whatsapp (Issue #108)", () => {
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

  test("via: whatsapp with purpose: register is a validation error — registration stays e-mail OTP only", async () => {
    const { requestCustomerOtp } =
      await import("../src/modules/commerce/application/customer-auth");

    const outcome = await requestCustomerOtp(
      explodingTx,
      "tenant-1",
      "Toko Uji",
      {
        email: "",
        purpose: "register",
        via: "whatsapp",
        phone: "081234567890"
      },
      explodingChannel,
      undefined,
      new Date(),
      { COMMERCE_WHATSAPP_ENABLED: "true" } as NodeJS.ProcessEnv
    );

    expect(outcome.kind).toBe("validation_error");
    if (outcome.kind === "validation_error") {
      expect(outcome.errors.map((error) => error.field)).toContain("via");
    }
  });

  test("via: whatsapp with no phone is a validation error", async () => {
    const { requestCustomerOtp } =
      await import("../src/modules/commerce/application/customer-auth");

    const outcome = await requestCustomerOtp(
      explodingTx,
      "tenant-1",
      "Toko Uji",
      { email: "", purpose: "login", via: "whatsapp" },
      explodingChannel,
      undefined,
      new Date(),
      { COMMERCE_WHATSAPP_ENABLED: "true" } as NodeJS.ProcessEnv
    );

    expect(outcome.kind).toBe("validation_error");
    if (outcome.kind === "validation_error") {
      expect(outcome.errors.map((error) => error.field)).toContain("phone");
    }
  });

  test("via: whatsapp answers channel_unavailable when COMMERCE_WHATSAPP_ENABLED is not true, without issuing a code", async () => {
    const { requestCustomerOtp } =
      await import("../src/modules/commerce/application/customer-auth");

    const outcome = await requestCustomerOtp(
      explodingTx,
      "tenant-1",
      "Toko Uji",
      {
        email: "",
        purpose: "login",
        via: "whatsapp",
        phone: "081234567890"
      },
      explodingChannel,
      undefined,
      new Date(),
      { COMMERCE_WHATSAPP_ENABLED: "false" } as NodeJS.ProcessEnv
    );

    expect(outcome.kind).toBe("channel_unavailable");
  });

  test("via: whatsapp, enabled, issues an OTP keyed by phone_normalized and hands it to the channel", async () => {
    let issuedIdentifier: string | undefined;
    let issuedColumn: string | undefined;
    let channelRequestVia: string | undefined;

    mock.module(
      "../src/modules/commerce/application/customer-account-store",
      () => ({
        ...ORIGINAL,
        issueOtp: async (
          _tx: Bun.SQL,
          _tenantId: string,
          identifierValue: string,
          _purpose: string,
          _registration: unknown,
          _now: Date,
          identifierColumn: string
        ) => {
          issuedIdentifier = identifierValue;
          issuedColumn = identifierColumn;
          return { code: "123456", expiresAt: new Date().toISOString() };
        }
      })
    );

    const { requestCustomerOtp } =
      await import("../src/modules/commerce/application/customer-auth");

    const channel: CustomerOtpChannel = {
      sendOtp: async (_tx, request) => {
        channelRequestVia = request.via;
        return { sent: true };
      }
    };

    const outcome = await requestCustomerOtp(
      fakeTx,
      "tenant-1",
      "Toko Uji",
      {
        email: "",
        purpose: "login",
        via: "whatsapp",
        phone: "081234567890"
      },
      channel,
      undefined,
      new Date(),
      { COMMERCE_WHATSAPP_ENABLED: "true" } as NodeJS.ProcessEnv
    );

    expect(outcome.kind).toBe("sent");
    expect(issuedColumn).toBe("phone_normalized");
    expect(issuedIdentifier).toBe("+6281234567890");
    expect(channelRequestVia).toBe("whatsapp");

    mock.module(
      "../src/modules/commerce/application/customer-account-store",
      () => ORIGINAL
    );
  });
});

/** Issue #108 — `verifyCustomerOtp` accepting `phone` as the identifier. */
describe("verifyCustomerOtp — phone identifier (Issue #108)", () => {
  afterAll(() => {
    mock.module(
      "../src/modules/commerce/application/customer-account-store",
      () => ORIGINAL
    );
  });

  test("phone + purpose: register is a validation error (phone verification is login-only)", async () => {
    const { verifyCustomerOtp } =
      await import("../src/modules/commerce/application/customer-auth");

    const outcome = await verifyCustomerOtp(
      fakeTx,
      "tenant-1",
      { email: "", phone: "081234567890", code: "123456", purpose: "register" },
      { clientIpHash: null, userAgentSummary: null }
    );

    expect(outcome.kind).toBe("validation_error");
  });

  test("both email and phone supplied is a validation error", async () => {
    const { verifyCustomerOtp } =
      await import("../src/modules/commerce/application/customer-auth");

    const outcome = await verifyCustomerOtp(
      fakeTx,
      "tenant-1",
      {
        email: "shopper@example.com",
        phone: "081234567890",
        code: "123456",
        purpose: "login"
      },
      { clientIpHash: null, userAgentSummary: null }
    );

    expect(outcome.kind).toBe("validation_error");
  });

  test("phone login resolves the account via findAccountByPhone, not findAccountByEmail", async () => {
    let findAccountByPhoneCalledWith: string | undefined;

    mock.module(
      "../src/modules/commerce/application/customer-account-store",
      () => ({
        ...ORIGINAL,
        consumeOtp: async () => ({
          ok: true as const,
          otp: { id: "otp-1", purpose: "login" as const, registration: null }
        }),
        findAccountByEmail: async () => {
          throw new Error("must not be called for phone verification");
        },
        findAccountByPhone: async (
          _tx: Bun.SQL,
          _tenantId: string,
          phone: string
        ) => {
          findAccountByPhoneCalledWith = phone;
          return {
            id: "acct-1",
            customerId: "cust-1",
            emailMasked: "s***@example.com",
            status: "active" as const,
            emailVerifiedAt: null,
            historyFrom: new Date().toISOString(),
            lastLoginAt: null,
            createdAt: new Date().toISOString()
          };
        },
        issueSession: async () => ({
          token: "cs_test",
          sessionId: "sess-1",
          expiresAt: new Date().toISOString()
        })
      })
    );

    const { verifyCustomerOtp } =
      await import("../src/modules/commerce/application/customer-auth");

    const outcome = await verifyCustomerOtp(
      fakeTx,
      "tenant-1",
      { email: "", phone: "081234567890", code: "123456", purpose: "login" },
      { clientIpHash: null, userAgentSummary: null }
    );

    expect(outcome.kind).toBe("success");
    expect(findAccountByPhoneCalledWith).toBe("+6281234567890");
  });
});
