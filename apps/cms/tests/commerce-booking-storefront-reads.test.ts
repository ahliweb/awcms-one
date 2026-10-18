/**
 * Pure unit tests for the anonymous booking reads' rules (Issue #386,
 * ADR-0045 implementation notes) plus the static properties of the four
 * routes. No database; the DB-backed behaviour is
 * `integration/commerce-booking-storefront-reads.integration.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  AVAILABILITY_MAX_HORIZON_DAYS,
  AVAILABILITY_MAX_SLOT_WINDOW_DAYS,
  availabilityBody,
  publicAvailabilityRefusal,
  validateAvailabilityQuery,
  validateQuoteQuery
} from "../src/modules/commerce/domain/booking-storefront-reads";

const OFFERING = "11111111-1111-4111-8111-111111111111";
const RESOURCE = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-18T10:00:00Z");

const query = (entries: Record<string, string>) =>
  new URLSearchParams({
    offeringId: OFFERING,
    resourceId: RESOURCE,
    ...entries
  });

const invalidFields = (result: {
  valid: boolean;
  errors?: { field: string }[];
}): string[] => (result.errors ?? []).map((error) => error.field).sort();

describe("availability query", () => {
  test("a stay and a slot window are each accepted exactly as sent", () => {
    expect(
      validateAvailabilityQuery(
        query({ checkInDate: "2026-11-01", checkOutDate: "2026-11-03" }),
        NOW
      )
    ).toEqual({
      valid: true,
      value: {
        offeringId: OFFERING,
        resourceId: RESOURCE,
        kind: "stay",
        checkInDate: "2026-11-01",
        checkOutDate: "2026-11-03"
      }
    });
    expect(
      validateAvailabilityQuery(
        query({ from: "2026-11-01T00:00:00Z", to: "2026-11-02T00:00:00Z" }),
        NOW
      )
    ).toEqual({
      valid: true,
      value: {
        offeringId: OFFERING,
        resourceId: RESOURCE,
        kind: "slot",
        from: "2026-11-01T00:00:00Z",
        to: "2026-11-02T00:00:00Z"
      }
    });
  });

  test("ids must be uuids, and an unknown parameter (a tenant or customer id) is refused, not ignored", () => {
    const bad = validateAvailabilityQuery(
      new URLSearchParams({
        offeringId: "x",
        resourceId: "y",
        tenantId: OFFERING,
        customerId: OFFERING,
        checkInDate: "2026-11-01",
        checkOutDate: "2026-11-03"
      }),
      NOW
    );
    expect(invalidFields(bad)).toEqual([
      "customerId",
      "offeringId",
      "resourceId",
      "tenantId"
    ]);
  });

  test("exactly one of the stay pair and the slot pair", () => {
    expect(invalidFields(validateAvailabilityQuery(query({}), NOW))).toEqual([
      "checkInDate"
    ]);
    expect(
      invalidFields(
        validateAvailabilityQuery(
          query({
            checkInDate: "2026-11-01",
            checkOutDate: "2026-11-03",
            from: "2026-11-01T00:00:00Z",
            to: "2026-11-02T00:00:00Z"
          }),
          NOW
        )
      )
    ).toEqual(["from"]);
    // Half a pair is refused too.
    expect(
      validateAvailabilityQuery(query({ checkInDate: "2026-11-01" }), NOW).valid
    ).toBe(false);
  });

  test("stay bounds: real dates, check-out after check-in, 1..366 nights, not in the past, not beyond the horizon", () => {
    const stay = (checkInDate: string, checkOutDate: string) =>
      validateAvailabilityQuery(query({ checkInDate, checkOutDate }), NOW);
    expect(stay("2026-02-30", "2026-03-02").valid).toBe(false);
    expect(stay("2026-11-03", "2026-11-03").valid).toBe(false);
    expect(stay("2026-11-04", "2026-11-03").valid).toBe(false);
    expect(stay("2026-11-01", "2027-11-03").valid).toBe(false); // 367 nights
    expect(stay("2026-11-01", "2027-11-02").valid).toBe(true); // 366 nights
    expect(stay("2026-10-10", "2026-10-12").valid).toBe(false); // past
    // Yesterday UTC is allowed: a guest east of UTC is already on the next day.
    expect(stay("2026-10-17", "2026-10-19").valid).toBe(true);
    const far = new Date(
      NOW.getTime() + (AVAILABILITY_MAX_HORIZON_DAYS + 5) * 86_400_000
    )
      .toISOString()
      .slice(0, 10);
    const farOut = new Date(
      NOW.getTime() + (AVAILABILITY_MAX_HORIZON_DAYS + 7) * 86_400_000
    )
      .toISOString()
      .slice(0, 10);
    expect(stay(far, farOut).valid).toBe(false);
  });

  test("slot bounds: Z instants, to after from, at most 31 days, not in the past", () => {
    const slot = (from: string, to: string) =>
      validateAvailabilityQuery(query({ from, to }), NOW);
    expect(
      slot("2026-11-01T00:00:00+07:00", "2026-11-02T00:00:00Z").valid
    ).toBe(false);
    expect(slot("2026-11-02T00:00:00Z", "2026-11-01T00:00:00Z").valid).toBe(
      false
    );
    expect(slot("2026-11-01T00:00:00Z", "2026-11-01T00:00:00Z").valid).toBe(
      false
    );
    const edge = new Date(
      Date.parse("2026-11-01T00:00:00Z") +
        AVAILABILITY_MAX_SLOT_WINDOW_DAYS * 86_400_000
    ).toISOString();
    expect(slot("2026-11-01T00:00:00Z", edge.replace(".000Z", "Z")).valid).toBe(
      true
    );
    expect(slot("2026-11-01T00:00:00Z", "2026-12-02T00:00:01Z").valid).toBe(
      false
    );
    expect(slot("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z").valid).toBe(
      false
    );
  });
});

describe("quote query", () => {
  test("an offering alone is a slot quote; a stay needs both real dates; unknown keys are refused", () => {
    expect(
      validateQuoteQuery(new URLSearchParams({ offeringId: OFFERING }), NOW)
    ).toEqual({
      valid: true,
      value: { offeringId: OFFERING, stay: null }
    });
    expect(
      validateQuoteQuery(
        new URLSearchParams({
          offeringId: OFFERING,
          checkInDate: "2026-11-01",
          checkOutDate: "2026-11-04"
        }),
        NOW
      )
    ).toEqual({
      valid: true,
      value: {
        offeringId: OFFERING,
        stay: { checkInDate: "2026-11-01", checkOutDate: "2026-11-04" }
      }
    });
    expect(
      validateQuoteQuery(
        new URLSearchParams({
          offeringId: OFFERING,
          checkInDate: "2026-11-01"
        }),
        NOW
      ).valid
    ).toBe(false);
    // The client never names a night count or an amount.
    expect(
      invalidFields(
        validateQuoteQuery(
          new URLSearchParams({
            offeringId: OFFERING,
            nights: "3",
            total: "1"
          }),
          NOW
        )
      )
    ).toEqual(["nights", "total"]);
  });
});

describe("the public face of the port's answer", () => {
  test("only validation-shaped refusals are a 400; everything else is one neutral 404", () => {
    for (const reason of [
      "VALIDATION_ERROR",
      "STAY_DATES_INVALID",
      "BOOKING_MODE_MISMATCH"
    ] as const) {
      expect(publicAvailabilityRefusal(reason).status).toBe(400);
    }
    for (const reason of [
      "OFFERING_NOT_FOUND",
      "RESOURCE_NOT_FOUND",
      "SLOT_UNAVAILABLE",
      "STAY_MIN_NIGHTS",
      "HORIZON_EXCEEDED"
    ] as const) {
      expect(publicAvailabilityRefusal(reason as never)).toEqual({
        status: 404,
        code: "NOT_FOUND",
        message: "Not found."
      });
    }
  });

  test("the body is an allow-list: a field the port adds later never reaches the public", () => {
    const stay = availabilityBody({
      ok: true,
      mode: "stay",
      timezone: "Asia/Pontianak",
      checkInDate: "2026-11-01",
      checkOutDate: "2026-11-03",
      nights: 2,
      freeUnits: 3,
      available: true,
      // Not part of the contract: must not survive.
      resourceName: "Room Rahasia",
      unitLabels: ["101"]
    } as never);
    expect(stay).toEqual({
      mode: "stay",
      timezone: "Asia/Pontianak",
      checkInDate: "2026-11-01",
      checkOutDate: "2026-11-03",
      nights: 2,
      available: true,
      freeUnits: 3
    });
    expect(JSON.stringify(stay)).not.toContain("Rahasia");

    expect(
      availabilityBody({
        ok: true,
        mode: "stay",
        timezone: "UTC",
        checkInDate: "2026-11-01",
        checkOutDate: "2026-11-03",
        nights: null,
        freeUnits: 0,
        available: false,
        reason: "SLOT_UNAVAILABLE"
      })
    ).toEqual({
      mode: "stay",
      timezone: "UTC",
      checkInDate: "2026-11-01",
      checkOutDate: "2026-11-03",
      nights: null,
      available: false,
      freeUnits: 0,
      reason: "SLOT_UNAVAILABLE"
    });

    const slot = availabilityBody({
      ok: true,
      mode: "slot",
      timezone: "Asia/Pontianak",
      from: "2026-11-01T00:00:00Z",
      to: "2026-11-02T00:00:00Z",
      slots: [
        {
          startsAt: "2026-11-01T01:00:00Z",
          endsAt: "2026-11-01T02:00:00Z",
          freeUnits: 1,
          staffId: "leak"
        } as never
      ],
      truncated: false
    });
    expect(slot).toEqual({
      mode: "slot",
      timezone: "Asia/Pontianak",
      from: "2026-11-01T00:00:00Z",
      to: "2026-11-02T00:00:00Z",
      slots: [
        {
          startsAt: "2026-11-01T01:00:00Z",
          endsAt: "2026-11-01T02:00:00Z",
          freeUnits: 1
        }
      ],
      truncated: false
    });
  });
});

describe("the routes", () => {
  const ROOT = "src/pages/api/v1/commerce/storefront/booking";
  const files = {
    availability: `${ROOT}/availability.ts`,
    offerings: `${ROOT}/offerings.ts`,
    quote: `${ROOT}/quote.ts`,
    reservations: `${ROOT}/reservations/index.ts`
  };

  test("each is tenant-from-origin, feature-gated, rate-limited, answers a preflight and takes no tenant or customer from the request", async () => {
    for (const [name, path] of Object.entries(files)) {
      const source = await readFile(path, "utf8");
      expect(source, name).toContain("withPublicCommerceTenant(");
      expect(source, name).toContain('"booking"');
      expect(source, name).toContain("checkSharedRateLimit(");
      expect(source, name).toContain("export const OPTIONS");
      expect(source, name).not.toMatch(/\.unsafe\(/);
      expect(source, name).not.toMatch(
        /searchParams\.get\("(?:tenant|tenantId|customer|customerId)"\)/
      );
    }
  });

  test("the anonymous reads are never cached and never import a Booking admin module or the resource name", async () => {
    for (const path of [files.availability, files.offerings, files.quote]) {
      const source = await readFile(path, "utf8");
      expect(source, path).toContain('"cache-control": "no-store"');
      expect(source, path).not.toMatch(/modules\/booking\//);
    }
    const reads = await readFile(
      "src/modules/commerce/application/booking-storefront-reads.ts",
      "utf8"
    );
    // The resource read selects ids; a name column is never named.
    expect(reads).toMatch(/SELECT id\s+FROM awcms_booking_resources/);
    expect(reads).not.toMatch(
      /SELECT[^;]*\bname\b[^;]*FROM awcms_booking_resources/i
    );
  });

  test("the own-list route requires a live bearer and the others only optionally use one", async () => {
    const list = await readFile(files.reservations, "utf8");
    expect(list).toContain("export const GET");
    expect(list).toContain("listOwnReservations(");
    expect(list).toContain('kind: "unauthenticated"');
    const availability = await readFile(files.availability, "utf8");
    expect(availability).not.toContain("requireCustomerSession");
  });
});
