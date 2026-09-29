import { describe, expect, test } from "bun:test";

import {
  COMMERCE_ENTITLEMENT_STATUSES,
  isActiveCommerceEntitlement,
  isCommerceEntitlementStatus
} from "../src/modules/commerce/domain/commerce-entitlement";

describe("commerce entitlement domain (Issue #267, IRMbyDUS)", () => {
  test("isCommerceEntitlementStatus accepts only the two declared statuses", () => {
    for (const status of COMMERCE_ENTITLEMENT_STATUSES) {
      expect(isCommerceEntitlementStatus(status)).toBe(true);
    }
    expect(isCommerceEntitlementStatus("entitlement_required")).toBe(false);
    expect(isCommerceEntitlementStatus("pending")).toBe(false);
    expect(isCommerceEntitlementStatus(123)).toBe(false);
    expect(isCommerceEntitlementStatus(null)).toBe(false);
  });

  test("isActiveCommerceEntitlement is true only for status active", () => {
    expect(isActiveCommerceEntitlement({ status: "active" })).toBe(true);
    expect(isActiveCommerceEntitlement({ status: "revoked" })).toBe(false);
  });
});
