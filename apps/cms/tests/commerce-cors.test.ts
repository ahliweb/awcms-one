import { describe, expect, test } from "bun:test";

import {
  commerceCorsHeaders,
  commercePreflightHeaders
} from "../src/modules/commerce/domain/commerce-cors";

describe("commerceCorsHeaders", () => {
  test("a granted origin can read Retry-After on a 429", () => {
    const headers = commerceCorsHeaders({
      kind: "granted",
      origin: "https://toko.example"
    });
    expect(headers["access-control-allow-origin"]).toBe("https://toko.example");
    expect(headers["access-control-expose-headers"]).toBe("retry-after");
    expect(headers.vary).toBe("Origin");
  });

  test("same-origin and refused answers expose nothing and grant nothing", () => {
    for (const decision of [
      { kind: "same_origin" },
      { kind: "refused" }
    ] as const) {
      expect(commerceCorsHeaders(decision)).toEqual({ vary: "Origin" });
    }
  });

  test("never answers with credentials or a wildcard", () => {
    const headers = commercePreflightHeaders(
      { kind: "granted", origin: "https://toko.example" },
      ["content-type", "authorization"]
    );
    expect(headers["access-control-allow-credentials"]).toBeUndefined();
    expect(Object.values(headers)).not.toContain("*");
  });
});
