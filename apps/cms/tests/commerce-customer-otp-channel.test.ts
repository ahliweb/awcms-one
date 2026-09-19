import { describe, expect, test } from "bun:test";

import {
  createLogCustomerOtpChannel,
  CUSTOMER_OTP_TEMPLATE_KEY,
  CUSTOMER_OTP_TEMPLATE_VARIABLES,
  resolveCustomerOtpChannel
} from "../src/modules/commerce/application/customer-otp-channel-adapters";
import { getAllowedVariablesForCategory } from "../src/modules/email/domain/email-template-categories";

/**
 * Issue #89 — `CustomerOtpChannel` adapter selection and the `log` adapter's
 * own behaviour. No database: the `log` adapter never touches `tx`, and
 * `resolveCustomerOtpChannel` is a pure function of `env`.
 */
describe("resolveCustomerOtpChannel — env-driven selection (Issue #89)", () => {
  test('EMAIL_ENABLED not "true" selects the log channel', async () => {
    const channel = resolveCustomerOtpChannel({
      EMAIL_ENABLED: "false",
      EMAIL_PROVIDER: "mailketing"
    } as NodeJS.ProcessEnv);

    const result = await channel.sendOtp({} as Bun.SQL, {
      tenantId: "t1",
      emailNormalized: "shopper@example.com",
      code: "123456",
      purpose: "login",
      expiresInMinutes: 10,
      storeName: "Toko"
    });

    expect(result.sent).toBe(true);
  });

  test("EMAIL_PROVIDER=log selects the log channel even when EMAIL_ENABLED=true", async () => {
    const channel = resolveCustomerOtpChannel({
      EMAIL_ENABLED: "true",
      EMAIL_PROVIDER: "log"
    } as NodeJS.ProcessEnv);

    const result = await channel.sendOtp({} as Bun.SQL, {
      tenantId: "t1",
      emailNormalized: "shopper@example.com",
      code: "654321",
      purpose: "register",
      expiresInMinutes: 10,
      storeName: "Toko"
    });

    expect(result.sent).toBe(true);
  });
});

describe("derived.commerce_customer_otp — category registration (Issue #89)", () => {
  test("is registered with exactly its three variables, so an unlisted one is silently dropped at render time", () => {
    expect(getAllowedVariablesForCategory(CUSTOMER_OTP_TEMPLATE_KEY)).toEqual(
      CUSTOMER_OTP_TEMPLATE_VARIABLES as unknown as string[]
    );
  });
});

describe("createLogCustomerOtpChannel — always reports sent", () => {
  test("never touches its tx argument", async () => {
    const channel = createLogCustomerOtpChannel();

    // Passing a `Proxy` that throws on ANY property access proves the log
    // adapter never dereferences `tx` — if it ever tried, this test would
    // throw instead of resolving.
    const explodingTx = new Proxy(
      {},
      {
        get() {
          throw new Error("log channel must not touch tx");
        }
      }
    ) as Bun.SQL;

    const result = await channel.sendOtp(explodingTx, {
      tenantId: "t1",
      emailNormalized: "shopper@example.com",
      code: "111111",
      purpose: "login",
      expiresInMinutes: 10,
      storeName: "Toko"
    });

    expect(result.sent).toBe(true);
  });
});
