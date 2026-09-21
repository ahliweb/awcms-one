import { describe, expect, test } from "bun:test";

import {
  checkOtpDelivery,
  checkPaymentAndShipping,
  checkPublicUrls,
  checkRuntimeRoleShape,
  dsnUser,
  isProduction,
  isValidHttpsUrl
} from "../scripts/commerce-deploy-preflight";

/**
 * Shape/config tests only — no real credentials, no database connection. See
 * `docs/adr/0019-production-topology-two-images-a-jobs-sidecar-and-a-fail-closed-preflight.md`
 * D5 for why this preflight is fail-closed, and the `awcms-one-commerce`
 * skill for the two `Bun.SQL` quirks that do NOT apply here (this script
 * reads env only for these functions; the `--live` path is exercised
 * manually against a disposable database, see the issue #150 PR body).
 */

function statusOf(results: { name: string; status: string }[], needle: string) {
  const match = results.find((r) => r.name.includes(needle));
  if (!match)
    throw new Error(
      `no check matched "${needle}" among: ${results.map((r) => r.name).join(", ")}`
    );
  return match.status;
}

describe("isProduction", () => {
  test("APP_ENV=production is production", () => {
    expect(isProduction({ APP_ENV: "production" }, false)).toBe(true);
  });
  test("--production forces production even without APP_ENV", () => {
    expect(isProduction({}, true)).toBe(true);
  });
  test("development is not production", () => {
    expect(isProduction({ APP_ENV: "development" }, false)).toBe(false);
  });
});

describe("dsnUser / isValidHttpsUrl", () => {
  test("extracts the username from a postgres DSN", () => {
    expect(dsnUser("postgres://awcms_app:secret@db:5432/awcms")).toBe(
      "awcms_app"
    );
  });
  test("undefined DSN yields undefined user", () => {
    expect(dsnUser(undefined)).toBeUndefined();
  });
  test("https URL passes, http fails", () => {
    expect(isValidHttpsUrl("https://shop.example.test")).toBe(true);
    expect(isValidHttpsUrl("http://shop.example.test")).toBe(false);
    expect(isValidHttpsUrl(undefined)).toBe(false);
  });
});

describe("checkRuntimeRoleShape", () => {
  test("owner DSN (postgres superuser) is refused", () => {
    const result = checkRuntimeRoleShape({
      DATABASE_URL: "postgres://postgres:pw@db:5432/awcms"
    });
    expect(result.status).toBe("FAIL");
  });

  test("least-privilege awcms_app role passes", () => {
    const result = checkRuntimeRoleShape({
      DATABASE_URL: "postgres://awcms_app:pw@db:5432/awcms"
    });
    expect(result.status).toBe("PASS");
  });

  test("runtime DSN matching the SETUP_DATABASE_URL user is refused", () => {
    const result = checkRuntimeRoleShape({
      DATABASE_URL: "postgres://awcms_shared:pw@db:5432/awcms",
      SETUP_DATABASE_URL: "postgres://awcms_shared:pw@db:5432/awcms"
    });
    expect(result.status).toBe("FAIL");
  });

  test("missing DATABASE_URL fails", () => {
    expect(checkRuntimeRoleShape({}).status).toBe("FAIL");
  });
});

describe("checkOtpDelivery — customer accounts always require OTP delivery", () => {
  test("production with EMAIL_ENABLED=false fails", () => {
    const results = checkOtpDelivery({ EMAIL_ENABLED: "false" }, true);
    expect(statusOf(results, "e-mail delivery")).toBe("FAIL");
  });

  test("production with EMAIL_PROVIDER=log fails, even if enabled", () => {
    const results = checkOtpDelivery(
      { EMAIL_ENABLED: "true", EMAIL_PROVIDER: "log" },
      true
    );
    expect(statusOf(results, "e-mail delivery")).toBe("FAIL");
  });

  test("production with a real provider passes", () => {
    const results = checkOtpDelivery(
      { EMAIL_ENABLED: "true", EMAIL_PROVIDER: "mailketing" },
      true
    );
    expect(statusOf(results, "e-mail delivery")).toBe("PASS");
  });

  test("non-production is skipped", () => {
    const results = checkOtpDelivery({}, false);
    expect(statusOf(results, "e-mail delivery")).toBe("SKIP");
  });

  test("WhatsApp disabled is skipped regardless of environment", () => {
    const results = checkOtpDelivery(
      { COMMERCE_WHATSAPP_ENABLED: "false" },
      true
    );
    expect(statusOf(results, "WhatsApp")).toBe("SKIP");
  });

  test("WhatsApp enabled with fonnte but no token fails", () => {
    const results = checkOtpDelivery(
      {
        COMMERCE_WHATSAPP_ENABLED: "true",
        COMMERCE_WHATSAPP_PROVIDER: "fonnte"
      },
      true
    );
    expect(statusOf(results, "WhatsApp")).toBe("FAIL");
  });

  test("WhatsApp enabled with fonnte and a token passes", () => {
    const results = checkOtpDelivery(
      {
        COMMERCE_WHATSAPP_ENABLED: "true",
        COMMERCE_WHATSAPP_PROVIDER: "fonnte",
        COMMERCE_FONNTE_TOKEN: "placeholder-token"
      },
      true
    );
    expect(statusOf(results, "WhatsApp")).toBe("PASS");
  });

  test("WhatsApp enabled with meta but missing phone number id fails", () => {
    const results = checkOtpDelivery(
      {
        COMMERCE_WHATSAPP_ENABLED: "true",
        COMMERCE_WHATSAPP_PROVIDER: "meta",
        COMMERCE_META_WA_TOKEN: "placeholder-token"
      },
      true
    );
    expect(statusOf(results, "WhatsApp")).toBe("FAIL");
  });

  test("WhatsApp enabled with log provider fails in production", () => {
    const results = checkOtpDelivery(
      { COMMERCE_WHATSAPP_ENABLED: "true", COMMERCE_WHATSAPP_PROVIDER: "log" },
      true
    );
    expect(statusOf(results, "WhatsApp")).toBe("FAIL");
  });
});

describe("checkPaymentAndShipping — log adapters refused in production", () => {
  test("COMMERCE_PAYMENT_GATEWAY unset fails in production", () => {
    const results = checkPaymentAndShipping({}, true);
    expect(statusOf(results, "payment gateway")).toBe("FAIL");
  });

  test("COMMERCE_PAYMENT_GATEWAY=log fails in production", () => {
    const results = checkPaymentAndShipping(
      { COMMERCE_PAYMENT_GATEWAY: "log" },
      true
    );
    expect(statusOf(results, "payment gateway")).toBe("FAIL");
  });

  test("COMMERCE_PAYMENT_GATEWAY=log is skipped outside production", () => {
    const results = checkPaymentAndShipping(
      { COMMERCE_PAYMENT_GATEWAY: "log" },
      false
    );
    expect(statusOf(results, "payment gateway")).toBe("SKIP");
  });

  test("midtrans missing server key fails", () => {
    const results = checkPaymentAndShipping(
      { COMMERCE_PAYMENT_GATEWAY: "midtrans" },
      true
    );
    expect(statusOf(results, "payment gateway")).toBe("FAIL");
  });

  test("midtrans with server key but sandbox (IS_PRODUCTION not true) fails", () => {
    const results = checkPaymentAndShipping(
      {
        COMMERCE_PAYMENT_GATEWAY: "midtrans",
        COMMERCE_MIDTRANS_SERVER_KEY: "placeholder-key",
        COMMERCE_MIDTRANS_IS_PRODUCTION: "false"
      },
      true
    );
    expect(statusOf(results, "payment gateway")).toBe("FAIL");
  });

  test("midtrans fully configured for production passes", () => {
    const results = checkPaymentAndShipping(
      {
        COMMERCE_PAYMENT_GATEWAY: "midtrans",
        COMMERCE_MIDTRANS_SERVER_KEY: "placeholder-key",
        COMMERCE_MIDTRANS_IS_PRODUCTION: "true",
        COMMERCE_SHIPPING_RATE_PROVIDER: "rajaongkir",
        COMMERCE_RAJAONGKIR_API_KEY: "placeholder-key"
      },
      true
    );
    expect(statusOf(results, "payment gateway")).toBe("PASS");
  });

  test("COMMERCE_SHIPPING_RATE_PROVIDER=log fails in production", () => {
    const results = checkPaymentAndShipping(
      { COMMERCE_SHIPPING_RATE_PROVIDER: "log" },
      true
    );
    expect(statusOf(results, "shipping rate provider")).toBe("FAIL");
  });

  test("rajaongkir missing api key fails", () => {
    const results = checkPaymentAndShipping(
      { COMMERCE_SHIPPING_RATE_PROVIDER: "rajaongkir" },
      true
    );
    expect(statusOf(results, "shipping rate provider")).toBe("FAIL");
  });
});

describe("checkPublicUrls", () => {
  test("both URLs valid https in production pass", () => {
    const results = checkPublicUrls(
      {
        APP_URL: "https://cms.example.test",
        COMMERCE_STOREFRONT_PUBLIC_URL: "https://shop.example.test"
      },
      true
    );
    expect(statusOf(results, "APP_URL")).toBe("PASS");
    expect(statusOf(results, "COMMERCE_STOREFRONT_PUBLIC_URL")).toBe("PASS");
  });

  test("http APP_URL fails in production", () => {
    const results = checkPublicUrls(
      { APP_URL: "http://cms.example.test" },
      true
    );
    expect(statusOf(results, "APP_URL")).toBe("FAIL");
  });

  test("unset URLs are skipped outside production", () => {
    const results = checkPublicUrls({}, false);
    expect(statusOf(results, "APP_URL")).toBe("SKIP");
  });
});

describe("happy path — a fully-configured production env bag has no FAIL among the pure checks", () => {
  test("every pure check passes for a complete production-shaped env", () => {
    const env = {
      APP_ENV: "production",
      APP_URL: "https://cms.example.test",
      COMMERCE_STOREFRONT_PUBLIC_URL: "https://shop.example.test",
      DATABASE_URL: "postgres://awcms_app:pw@db:5432/awcms",
      EMAIL_ENABLED: "true",
      EMAIL_PROVIDER: "mailketing",
      COMMERCE_WHATSAPP_ENABLED: "false",
      COMMERCE_PAYMENT_GATEWAY: "midtrans",
      COMMERCE_MIDTRANS_SERVER_KEY: "placeholder-key",
      COMMERCE_MIDTRANS_IS_PRODUCTION: "true",
      COMMERCE_SHIPPING_RATE_PROVIDER: "rajaongkir",
      COMMERCE_RAJAONGKIR_API_KEY: "placeholder-key"
    };

    expect(checkRuntimeRoleShape(env).status).toBe("PASS");
    for (const r of checkOtpDelivery(env, true))
      expect(r.status).not.toBe("FAIL");
    for (const r of checkPaymentAndShipping(env, true))
      expect(r.status).not.toBe("FAIL");
    for (const r of checkPublicUrls(env, true))
      expect(r.status).not.toBe("FAIL");
  });
});
