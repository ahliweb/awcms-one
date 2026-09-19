import { describe, expect, test } from "bun:test";

import {
  ACCOUNT_ADDRESS_LIMIT,
  createAccountAddress,
  mergeAccountWishlist,
  removeAccountWishlistItem
} from "../src/modules/commerce/application/customer-account-resources";
import { mediaLibraryPortAdapter } from "../src/modules/media-library/application/media-library-port-adapter";

/**
 * `application/customer-account-resources.ts`'s branching (Issue #91), with
 * the store faked — every fake below inspects the QUERY TEXT (the tagged
 * template's own `strings`) to decide what to answer, since the real
 * `Bun.SQL` tag is called as `tx(strings, ...values)`, never as an ordinary
 * function. Each test proves ONE branch never reaches (or never needs) a
 * query it should not run for that input — the exhaustive round-trip
 * behaviour (limit math against a real count, promotion, RLS, …) is proven
 * against a real database instead, in
 * `tests/integration/commerce-customer-account-resources.integration.test.ts`.
 */
function explodingTx(): Bun.SQL {
  return new Proxy(
    {},
    {
      get: () => () => {
        throw new Error("must not query the store for this branch");
      }
    }
  ) as unknown as Bun.SQL;
}

describe("createAccountAddress — limit_reached (Issue #91)", () => {
  test("answers limit_reached without ever running an INSERT once the count is at the cap", async () => {
    const calls: string[] = [];
    const fakeTx = ((strings: TemplateStringsArray) => {
      const text = strings.join("");
      calls.push(text);
      if (text.includes("count(*)::int AS n")) {
        return Promise.resolve([{ n: ACCOUNT_ADDRESS_LIMIT }]);
      }
      throw new Error(`unexpected query in this branch: ${text}`);
    }) as unknown as Bun.SQL;

    const outcome = await createAccountAddress(
      fakeTx,
      "tenant-1",
      "customer-1",
      {
        label: "Rumah",
        recipientName: "Budi",
        phone: "+6281234567890",
        provinceCode: "62",
        provinceName: "Kalimantan Tengah",
        cityCode: "6202",
        cityName: "Kotawaringin Timur",
        districtCode: "620201",
        districtName: "Baamang",
        postalCode: "74311",
        street: "Jl. Sudirman No. 1",
        latitude: null,
        longitude: null,
        notes: null
      }
    );

    expect(outcome.kind).toBe("limit_reached");
    expect(calls.some((text) => text.includes("INSERT INTO"))).toBe(false);
  });
});

describe("removeAccountWishlistItem — non-UUID productId (Issue #91)", () => {
  test("returns without ever touching the store", async () => {
    await removeAccountWishlistItem(
      explodingTx(),
      "tenant-1",
      "customer-1",
      "not-a-uuid"
    );
    // No throw above means the exploding proxy was never called.
  });
});

describe("mergeAccountWishlist — malformed ids are silently skipped (Issue #91)", () => {
  test("never queries product existence for ids that are not even UUID-shaped", async () => {
    const calls: string[] = [];
    const fakeTx = ((strings: TemplateStringsArray) => {
      const text = strings.join("");
      calls.push(text);
      if (text.includes("count(*)::int AS n")) {
        return Promise.resolve([{ n: 0 }]);
      }
      if (text.includes("FROM awcms_commerce_wishlists w")) {
        return Promise.resolve([]);
      }
      throw new Error(`unexpected query in this branch: ${text}`);
    }) as unknown as Bun.SQL;

    const outcome = await mergeAccountWishlist(
      fakeTx,
      "tenant-1",
      "customer-1",
      ["not-a-uuid", "also-not-one"],
      mediaLibraryPortAdapter
    );

    expect(outcome.kind).toBe("merged");
    expect(
      calls.some((text) => text.includes("FROM awcms_commerce_products"))
    ).toBe(false);
    expect(calls.some((text) => text.includes("INSERT INTO"))).toBe(false);
  });
});
