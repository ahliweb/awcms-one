/**
 * Static contract for the booking-commerce adapter's tables, permissions and
 * module wiring (Issue #378, ADR-0045; access matrix section 9 evidence item 1)
 * - no database. The rules that must not rot silently:
 *
 *   - the five registered permission keys are declared by the module through
 *     the part file, seeded by `sql/1039` exactly, and each is enforced by the
 *     route meant to need it; the rest of the access matrix is NOT registered
 *     (a key with no enforcing route is the "permission with no enforcing code"
 *     defect class) and the high-risk verbs it will use are already classed;
 *   - the six adapter tables are the ones the migrations create, each with an
 *     `id` primary key, `tenant_id`, RLS ENABLED and FORCED, a lifecycle and a
 *     subject-data descriptor, and a worker grant;
 *   - the module boundary: commerce reads Booking through the PORT only (no
 *     import of `modules/booking`), Booking never imports commerce, and the
 *     edge is a capability, not a lifecycle dependency;
 *   - the `booking` feature defaults OFF, and the part files are what
 *     `module.ts` spreads (so a later adapter issue never edits `module.ts`);
 *   - every adapter route is feature-gated and built on `defineTenantRoute`.
 */
import { readFile, readdir } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { listModules } from "../src/modules";
import { isHighRiskAction } from "../src/modules/identity-access/domain/access-control";
import { DEFAULT_COMMERCE_FEATURES } from "../src/modules/commerce/domain/commerce-features";
import {
  BOOKING_ADAPTER_DATA_LIFECYCLE,
  BOOKING_ADAPTER_SUBJECT_DATA
} from "../src/modules/commerce/domain/booking-adapter-lifecycle";
import {
  BOOKING_ADAPTER_PENDING_PERMISSIONS,
  BOOKING_ADAPTER_PERMISSIONS
} from "../src/modules/commerce/domain/booking-adapter-permissions";
import { BOOKING_ADAPTER_NAVIGATION } from "../src/modules/commerce/domain/booking-adapter-navigation";
import { BOOKING_ADAPTER_CONSUMERS } from "../src/modules/commerce/application/booking-adapter-consumers";

const MIGRATIONS = [
  "sql/1035_awcms_commerce_booking_links_schema.sql",
  "sql/1036_awcms_commerce_product_deposit_policies.sql",
  "sql/1037_awcms_commerce_cancellation_policies.sql",
  "sql/1038_awcms_commerce_booking_refund_decisions.sql"
];

const ADAPTER_TABLES = [
  "awcms_commerce_booking_offering_links",
  "awcms_commerce_booking_reservation_links",
  "awcms_commerce_product_deposit_policies",
  "awcms_commerce_cancellation_policies",
  "awcms_commerce_cancellation_policy_windows",
  "awcms_commerce_booking_refund_decisions"
];

const ROUTES: Record<string, string[]> = {
  "commerce.booking_offering_links.read": [
    "src/pages/api/v1/commerce/booking/offering-links/index.ts",
    "src/pages/api/v1/commerce/booking/offering-links/[id].ts"
  ],
  "commerce.booking_offering_links.create": [
    "src/pages/api/v1/commerce/booking/offering-links/index.ts"
  ],
  "commerce.booking_offering_links.update": [
    "src/pages/api/v1/commerce/booking/offering-links/[id].ts"
  ],
  "commerce.booking_deposit_policies.read": [
    "src/pages/api/v1/commerce/products/[id]/deposit-policy.ts"
  ],
  "commerce.booking_deposit_policies.update": [
    "src/pages/api/v1/commerce/products/[id]/deposit-policy.ts"
  ],
  // Issue #380 (sql/1041).
  "commerce.booking_reservation_links.create": [
    "src/pages/api/v1/commerce/booking/reservations/index.ts"
  ],
  "commerce.booking_reservation_links.read": [
    "src/pages/api/v1/commerce/booking/reservations/[id].ts",
    "src/pages/api/v1/commerce/booking/reconciliation.ts"
  ]
};

const CONSTANT_TO_CODE: Record<string, string> = {
  COMMERCE_BOOKING_OFFERING_LINKS_ACTIVITY_CODE: "booking_offering_links",
  COMMERCE_BOOKING_DEPOSIT_POLICIES_ACTIVITY_CODE: "booking_deposit_policies",
  COMMERCE_BOOKING_RESERVATION_LINKS_ACTIVITY_CODE: "booking_reservation_links"
};

function guardsIn(source: string): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(
    /activityCode:\s*(COMMERCE_[A-Z_]+_ACTIVITY_CODE),\s*action:\s*"([a-z_]+)"/g
  )) {
    const code = CONSTANT_TO_CODE[match[1]!];
    if (code) found.add(`commerce.${code}.${match[2]}`);
  }
  return found;
}

const commerce = listModules().find((module) => module.key === "commerce")!;
const declared = new Set(
  (commerce.permissions ?? []).map(
    (permission) => `commerce.${permission.activityCode}.${permission.action}`
  )
);
const EXPECTED_KEYS = Object.keys(ROUTES);

async function sourceFilesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await sourceFilesUnder(path)));
    else if (/\.(ts|astro)$/.test(entry.name)) files.push(path);
  }
  return files;
}

describe("permissions (evidence item 1)", () => {
  test("the seven keys are declared by the module from the part file, and sql/1039 + sql/1041 seed exactly them with the same descriptions", async () => {
    for (const key of EXPECTED_KEYS) expect(declared.has(key)).toBe(true);
    const sql =
      (await readFile(
        "sql/1039_awcms_commerce_booking_adapter_permissions.sql",
        "utf8"
      )) +
      (await readFile(
        "sql/1041_awcms_commerce_booking_reservation_permissions.sql",
        "utf8"
      ));
    const seeded = [
      ...sql.matchAll(
        /\('commerce', '([a-z_]+)', '([a-z_]+)', '((?:[^']|'')*)'\)/g
      )
    ].map((match) => ({
      key: `commerce.${match[1]}.${match[2]}`,
      description: match[3]!.replace(/''/g, "'")
    }));
    expect(seeded.map((s) => s.key).sort()).toEqual([...EXPECTED_KEYS].sort());
    for (const entry of BOOKING_ADAPTER_PERMISSIONS) {
      const key = `commerce.${entry.activityCode}.${entry.action}`;
      expect(seeded.find((s) => s.key === key)?.description).toBe(
        entry.description
      );
      // The module spreads the part file: the descriptor IS the part file's.
      expect(
        (commerce.permissions ?? []).some(
          (permission) =>
            permission.activityCode === entry.activityCode &&
            permission.action === entry.action &&
            permission.description === entry.description
        )
      ).toBe(true);
    }
    expect(BOOKING_ADAPTER_PERMISSIONS).toHaveLength(EXPECTED_KEYS.length);
  });

  test("each key is enforced by the route meant to need it", async () => {
    for (const [key, routes] of Object.entries(ROUTES)) {
      const enforced = new Set<string>();
      for (const route of routes) {
        for (const found of guardsIn(await readFile(route, "utf8"))) {
          enforced.add(found);
        }
      }
      expect(enforced.has(key), key).toBe(true);
    }
  });

  test("the rest of the access matrix is not registered yet, and the verbs it will use are already classed high-risk", () => {
    for (const key of BOOKING_ADAPTER_PENDING_PERMISSIONS) {
      expect(declared.has(key), key).toBe(false);
    }
    expect(BOOKING_ADAPTER_PENDING_PERMISSIONS).toHaveLength(8);
    // Reads, create and update are not high-risk (matrix section 2); cancel and
    // approve are, so registering the pending keys later classes them correctly
    // with no change to the upstream-owned AccessAction union.
    for (const key of EXPECTED_KEYS) {
      expect(isHighRiskAction(key.split(".")[2] as never), key).toBe(false);
    }
    for (const key of BOOKING_ADAPTER_PENDING_PERMISSIONS) {
      const action = key.split(".")[2]!;
      expect(isHighRiskAction(action as never), key).toBe(
        action === "cancel" || action === "approve"
      );
    }
  });
});

describe("tables", () => {
  test("the migrations create exactly the six adapter tables, each with an id primary key, tenant_id, RLS enabled and forced, and a tenant-isolation policy", async () => {
    const created: string[] = [];
    for (const file of MIGRATIONS) {
      const sql = await readFile(file, "utf8");
      for (const match of sql.matchAll(
        /CREATE TABLE IF NOT EXISTS (awcms_[a-z_]+) \(([\s\S]*?)\n\);/g
      )) {
        const table = match[1]!;
        created.push(table);
        expect(match[2], table).toContain(
          "id uuid PRIMARY KEY DEFAULT gen_random_uuid()"
        );
        expect(match[2], table).toContain(
          "tenant_id uuid NOT NULL REFERENCES awcms_tenants (id)"
        );
        expect(sql, table).toContain(
          `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`
        );
        expect(sql, table).toContain(
          `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`
        );
        expect(sql, table).toContain(`CREATE POLICY ${table}_tenant_isolation`);
        // The application role can never delete from any of them.
        expect(sql, table).toMatch(
          new RegExp(`REVOKE (?:UPDATE, )?DELETE ON ${table} FROM awcms_app;`)
        );
      }
    }
    expect(created.sort()).toEqual([...ADAPTER_TABLES].sort());
  });

  test("every trigger function the adapter migrations create pins its search_path", async () => {
    for (const file of [
      ...MIGRATIONS,
      "sql/1040_awcms_commerce_booking_adapter_settings_and_worker_grants.sql"
    ]) {
      const sql = await readFile(file, "utf8");
      for (const match of sql.matchAll(
        /CREATE OR REPLACE FUNCTION (awcms_[a-z_]+)\(\)([\s\S]*?)\$\1\$;/g
      )) {
        expect(match[2], match[1]).toContain(
          "SET search_path = pg_catalog, public, pg_temp"
        );
      }
    }
  });

  test("each table has a lifecycle and a subject-data descriptor with the same key, a surrogate id to purge by, and a worker grant", async () => {
    const lifecycle = BOOKING_ADAPTER_DATA_LIFECYCLE.map((d) => d.tableName);
    const subject = BOOKING_ADAPTER_SUBJECT_DATA.map((d) => d.tableName);
    expect(lifecycle.sort()).toEqual([...ADAPTER_TABLES].sort());
    expect(subject.sort()).toEqual([...ADAPTER_TABLES].sort());
    for (const descriptor of BOOKING_ADAPTER_DATA_LIFECYCLE) {
      expect(descriptor.executionMode).toBe("generic");
      expect(descriptor.ownerModuleKey).toBe("commerce");
      expect(descriptor.cursorColumn).toBe(
        descriptor.tableName === "awcms_commerce_booking_refund_decisions"
          ? "created_at"
          : "deleted_at"
      );
    }
    const moduleLifecycle = new Set(
      (commerce.dataLifecycle ?? []).map((d) => d.tableName)
    );
    const moduleSubject = new Set(
      (commerce.subjectData ?? []).map((d) => d.tableName)
    );
    const grants = await readFile(
      "sql/1040_awcms_commerce_booking_adapter_settings_and_worker_grants.sql",
      "utf8"
    );
    for (const table of ADAPTER_TABLES) {
      expect(moduleLifecycle.has(table), table).toBe(true);
      expect(moduleSubject.has(table), table).toBe(true);
      expect(grants).toContain(
        `GRANT SELECT, DELETE ON ${table} TO awcms_worker;`
      );
    }
    // Only the refund decision names a person (staff), and none stores a customer.
    const named = BOOKING_ADAPTER_SUBJECT_DATA.filter(
      (d) => !d.unreachableBySubject
    ).map((d) => d.tableName);
    expect(named).toEqual(["awcms_commerce_booking_refund_decisions"]);
  });
});

describe("module wiring and boundary", () => {
  test("the booking feature defaults OFF, and the part files carry the navigation (Issue #385: two entries, both gated on it) and the five consumers of Issue #380", () => {
    expect(DEFAULT_COMMERCE_FEATURES.booking).toBe(false);
    expect(BOOKING_ADAPTER_NAVIGATION.map((e) => e.path)).toEqual([
      "/admin/commerce-booking-links",
      "/admin/commerce-booking-deposits"
    ]);
    for (const entry of BOOKING_ADAPTER_NAVIGATION) {
      expect(entry.requiredFeature).toEqual({
        moduleKey: "commerce",
        feature: "booking"
      });
    }
    expect(BOOKING_ADAPTER_CONSUMERS.map((entry) => entry.name)).toEqual([
      "commerce.booking_order_paid_confirmer",
      "commerce.booking_expired_order_canceller",
      "commerce.booking_cancelled_order_canceller",
      "commerce.booking_order_cancelled_hold_releaser",
      "commerce.booking_late_payment_flagger"
    ]);
    // The default idempotency (the runtime wraps `handle`); never self-managed.
    for (const entry of BOOKING_ADAPTER_CONSUMERS) {
      expect(entry.idempotency ?? "runtime_effect_once").toBe(
        "runtime_effect_once"
      );
    }
    const settings = commerce.settings?.defaults as {
      features: Record<string, boolean>;
    };
    expect(settings.features.booking).toBe(false);
  });

  test("Booking is a consumed capability, not a lifecycle dependency; commerce reaches it through the port only; Booking never imports commerce", async () => {
    expect(commerce.dependencies).not.toContain("booking");
    expect(commerce.capabilities?.consumes).toContainEqual({
      capability: "booking",
      providedBy: "booking",
      optional: true
    });
    const booking = listModules().find((module) => module.key === "booking")!;
    expect(booking.dependencies).not.toContain("commerce");

    for (const file of await sourceFilesUnder("src/modules/commerce")) {
      const source = await readFile(file, "utf8");
      // The PORT is neutral ground; the module's own code is not.
      expect(source, file).not.toMatch(
        /from\s+["'][^"']*\/booking\/(?:application|domain|infrastructure)\//
      );
      expect(source, file).not.toMatch(/from\s+["'][^"']*modules\/booking["']/);
    }
    for (const file of await sourceFilesUnder("src/modules/booking")) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toMatch(/from\s+["'][^"']*\/commerce\//);
    }
  });

  test("the only reads of a Booking table are the offering lookup and the reservation reads, and commerce writes none", async () => {
    const readers: string[] = [];
    for (const file of await sourceFilesUnder("src/modules/commerce")) {
      const source = await readFile(file, "utf8");
      if (/\b(?:FROM|JOIN)\s+awcms_booking_/i.test(source)) readers.push(file);
      expect(source, file).not.toMatch(
        /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+awcms_booking_/i
      );
    }
    expect(readers.sort()).toEqual([
      "src/modules/commerce/application/booking-offering-links.ts",
      "src/modules/commerce/application/booking-reservation-reads.ts"
    ]);
  });

  test("every adapter route is feature-gated, built on defineTenantRoute, and reads no tenant or customer id from the body or query", async () => {
    const routes = new Set(Object.values(ROUTES).flat());
    for (const route of routes) {
      const source = await readFile(route, "utf8");
      expect(source, route).toContain("requireBookingFeature(");
      expect(source, route).toContain("defineTenantRoute");
      expect(source, route).not.toMatch(/\.unsafe\(/);
      expect(source, route).not.toMatch(
        /body\.(?:tenantId|customerId)|searchParams\.get\("(?:tenant|customer)/
      );
    }
  });
});
