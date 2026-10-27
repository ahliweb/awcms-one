/**
 * Static contract for the booking-commerce adapter's tables, permissions and
 * module wiring (Issue #378, ADR-0045; access matrix section 9 evidence item 1)
 * - no database. The rules that must not rot silently:
 *
 *   - the eighteen registered permission keys are declared by the module
 *     through the part file, seeded by `sql/1039`, `sql/1041`, `sql/1044`,
 *     `sql/1045` and `sql/1046` exactly, and each is enforced by the route meant
 *     to need it;
 *     nothing of the access matrix is left unregistered (a key with no enforcing
 *     route is the "permission with no enforcing code" defect class) and the
 *     high-risk verbs are classed;
 *   - the seven adapter tables are the ones the migrations create, each with an
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
  "sql/1038_awcms_commerce_booking_refund_decisions.sql",
  // Issue #381: ALTERs only (no table), but its re-issued guard must pin search_path too.
  "sql/1043_awcms_commerce_booking_cancellation_schema.sql",
  // Issue #437: the offering link's resource binding.
  "sql/1050_awcms_commerce_booking_offering_link_resources.sql",
  // Issue #382: the reschedule record, the no-show columns and one permission.
  "sql/1045_awcms_commerce_booking_reschedule.sql",
  // Issue #383: the POS permissions, the check-in policy column and the relaxed
  // ledger guard (re-issued with its search_path pinned).
  "sql/1046_awcms_commerce_booking_pos.sql"
];

const ADAPTER_TABLES = [
  "awcms_commerce_booking_offering_links",
  "awcms_commerce_booking_reservation_links",
  "awcms_commerce_product_deposit_policies",
  "awcms_commerce_cancellation_policies",
  "awcms_commerce_cancellation_policy_windows",
  "awcms_commerce_booking_refund_decisions",
  "awcms_commerce_booking_offering_link_resources",
  "awcms_commerce_booking_reschedules"
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
    "src/pages/api/v1/commerce/booking/reconciliation.ts",
    "src/pages/api/v1/commerce/booking/reservations/[id]/cancellation-quote.ts",
    // Issue #383: the till's lookup rides the read key (no key of its own).
    "src/pages/api/v1/commerce/pos/booking/lookup.ts"
  ],
  // Issue #381 (sql/1044).
  // Issue #382 (sql/1045): the reschedule and its price preview; the no-show
  // takes the two keys a cancel takes.
  "commerce.booking_reservation_links.update": [
    "src/pages/api/v1/commerce/booking/reservations/[id]/reschedule.ts",
    "src/pages/api/v1/commerce/booking/reservations/[id]/reschedule-quote.ts"
  ],
  "commerce.booking_reservation_links.cancel": [
    "src/pages/api/v1/commerce/booking/reservations/[id]/cancel.ts",
    "src/pages/api/v1/commerce/booking/reservations/[id]/no-show.ts"
  ],
  "commerce.booking_refund_decisions.create": [
    "src/pages/api/v1/commerce/booking/reservations/[id]/cancel.ts",
    "src/pages/api/v1/commerce/booking/reservations/[id]/no-show.ts"
  ],
  "commerce.booking_refund_decisions.read": [
    "src/pages/api/v1/commerce/booking/reservations/[id]/refund-decision.ts"
  ],
  // The override key is enforced by the one helper the cancel route calls (the
  // service accepts only the type it returns); the route file names the helper.
  "commerce.booking_refund_overrides.approve": [
    "src/modules/commerce/application/booking-refund-override.ts"
  ],
  // Issue #383 (sql/1046): the till's three writes, each its own key and route.
  "commerce.booking_check_ins.create": [
    "src/pages/api/v1/commerce/pos/booking/reservations/[id]/check-in.ts"
  ],
  "commerce.booking_check_outs.create": [
    "src/pages/api/v1/commerce/pos/booking/reservations/[id]/check-out.ts"
  ],
  "commerce.booking_balance_payments.create": [
    "src/pages/api/v1/commerce/pos/booking/reservations/[id]/balance-payments.ts"
  ],
  "commerce.booking_cancellation_policies.read": [
    "src/pages/api/v1/commerce/booking/cancellation-policies/index.ts"
  ],
  "commerce.booking_cancellation_policies.create": [
    "src/pages/api/v1/commerce/booking/cancellation-policies/index.ts"
  ],
  "commerce.booking_cancellation_policies.approve": [
    "src/pages/api/v1/commerce/booking/cancellation-policies/[id]/approve.ts",
    "src/pages/api/v1/commerce/booking/cancellation-policies/[id]/retire.ts"
  ]
};

/** The routes that must be feature-gated and built on `defineTenantRoute` (the override helper is not a route). */
const ROUTE_FILES = new Set(
  Object.values(ROUTES)
    .flat()
    .filter((file) => file.startsWith("src/pages/"))
);

const CONSTANT_TO_CODE: Record<string, string> = {
  COMMERCE_BOOKING_OFFERING_LINKS_ACTIVITY_CODE: "booking_offering_links",
  COMMERCE_BOOKING_DEPOSIT_POLICIES_ACTIVITY_CODE: "booking_deposit_policies",
  COMMERCE_BOOKING_RESERVATION_LINKS_ACTIVITY_CODE: "booking_reservation_links",
  COMMERCE_BOOKING_CANCELLATION_POLICIES_ACTIVITY_CODE:
    "booking_cancellation_policies",
  COMMERCE_BOOKING_REFUND_DECISIONS_ACTIVITY_CODE: "booking_refund_decisions",
  COMMERCE_BOOKING_REFUND_OVERRIDES_ACTIVITY_CODE: "booking_refund_overrides",
  COMMERCE_BOOKING_CHECK_INS_ACTIVITY_CODE: "booking_check_ins",
  COMMERCE_BOOKING_CHECK_OUTS_ACTIVITY_CODE: "booking_check_outs",
  COMMERCE_BOOKING_BALANCE_PAYMENTS_ACTIVITY_CODE: "booking_balance_payments"
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
  test("the eighteen keys are declared by the module from the part file, and sql/1039 + sql/1041 + sql/1044 + sql/1045 + sql/1046 seed exactly them with the same descriptions", async () => {
    for (const key of EXPECTED_KEYS) expect(declared.has(key)).toBe(true);
    const sql =
      (await readFile(
        "sql/1039_awcms_commerce_booking_adapter_permissions.sql",
        "utf8"
      )) +
      (await readFile(
        "sql/1041_awcms_commerce_booking_reservation_permissions.sql",
        "utf8"
      )) +
      (await readFile(
        "sql/1044_awcms_commerce_booking_cancellation_permissions.sql",
        "utf8"
      )) +
      // Issue #382: the reschedule key rides in the migration that creates its table.
      (await readFile(
        "sql/1045_awcms_commerce_booking_reschedule.sql",
        "utf8"
      )) +
      // Issue #383: the three POS keys ride in the migration that lands their routes.
      (await readFile("sql/1046_awcms_commerce_booking_pos.sql", "utf8"));
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

  test("nothing of the access matrix is left unregistered, and the verbs are classed (update is not high-risk, cancel and approve are)", () => {
    for (const key of BOOKING_ADAPTER_PENDING_PERMISSIONS) {
      expect(declared.has(key), key).toBe(false);
    }
    // Issue #382 landed the last key (reschedule); a later issue that proposes a
    // key before its route exists lists it here until the route lands.
    expect([...BOOKING_ADAPTER_PENDING_PERMISSIONS]).toEqual([]);
    // Reads, create and update are not high-risk (matrix section 2); cancel and
    // approve are, so the registered keys are classed correctly with no change
    // to the upstream-owned AccessAction union (a high-risk verb makes the
    // action-time separation-of-duties check available).
    for (const key of EXPECTED_KEYS) {
      const action = key.split(".")[2]!;
      expect(isHighRiskAction(action as never), key).toBe(
        action === "cancel" || action === "approve"
      );
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
  test("the migrations create exactly the seven adapter tables, each with an id primary key, tenant_id, RLS enabled and forced, and a tenant-isolation policy", async () => {
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
        descriptor.tableName === "awcms_commerce_booking_refund_decisions" ||
          descriptor.tableName === "awcms_commerce_booking_reschedules"
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
    // The reschedule record (Issue #382) takes its worker grant in its own migration.
    const grants =
      (await readFile(
        "sql/1040_awcms_commerce_booking_adapter_settings_and_worker_grants.sql",
        "utf8"
      )) +
      (await readFile(
        "sql/1050_awcms_commerce_booking_offering_link_resources.sql",
        "utf8"
      )) +
      (await readFile(
        "sql/1045_awcms_commerce_booking_reschedule.sql",
        "utf8"
      ));
    for (const table of ADAPTER_TABLES) {
      expect(moduleLifecycle.has(table), table).toBe(true);
      expect(moduleSubject.has(table), table).toBe(true);
      expect(grants).toContain(
        `GRANT SELECT, DELETE ON ${table} TO awcms_worker;`
      );
    }
    // Only the refund decision names a person (staff), and none stores a customer.
    // Issue #381: the policy version also names the two STAFF users who authored
    // and approved it.
    const named = BOOKING_ADAPTER_SUBJECT_DATA.filter(
      (d) => !d.unreachableBySubject
    ).map((d) => d.tableName);
    // Issue #382: the reschedule record names the staff member who moved it.
    expect(named.sort()).toEqual([
      "awcms_commerce_booking_refund_decisions",
      "awcms_commerce_booking_reschedules",
      "awcms_commerce_cancellation_policies"
    ]);
  });
});

describe("module wiring and boundary", () => {
  test("the booking feature defaults OFF, and the part files carry the navigation (Issues #385 and #381: three entries, all gated on it) and the seven consumers of Issues #380 and #382", () => {
    expect(DEFAULT_COMMERCE_FEATURES.booking).toBe(false);
    expect(BOOKING_ADAPTER_NAVIGATION.map((e) => e.path)).toEqual([
      "/admin/commerce-booking-links",
      "/admin/commerce-booking-deposits",
      "/admin/commerce-booking-policies"
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
      "commerce.booking_late_payment_flagger",
      // Issue #382 (ADR-0045 D15): the reconciler and the no-show recorder.
      "commerce.booking_rescheduled_link_reconciler",
      "commerce.booking_no_show_decision_recorder"
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

  test("the only reads of a Booking table are the offering lookup, the reservation reads, the storefront resource-id read and the segment booking facts, and commerce writes none", async () => {
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
      "src/modules/commerce/application/booking-reservation-reads.ts",
      "src/modules/commerce/application/booking-storefront-reads.ts",
      "src/modules/commerce/application/segment-booking-sql.ts"
    ]);
  });

  test("the segment booking facts read only the reservation status and arrival instant of a Booking row - never a customer reference, note or party (ADR-0052 D3)", async () => {
    const source = (
      await readFile(
        "src/modules/commerce/application/segment-booking-sql.ts",
        "utf8"
      )
    )
      // The header names the forbidden columns to explain the rule; only code counts.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // The only Booking relation named, and only these columns of `r`.
    expect([...new Set(source.match(/awcms_booking_[a-z_]+/g))]).toEqual([
      "awcms_booking_reservations"
    ]);
    const columns = new Set(
      [...source.matchAll(/\br\.([a-z_]+)/g)].map((match) => match[1])
    );
    expect([...columns].sort()).toEqual(
      ["id", "starts_at", "status", "tenant_id"].sort()
    );
    for (const personal of [
      "external_customer_ref",
      "customer_note",
      "party_size",
      "created_by"
    ]) {
      expect(source).not.toContain(personal);
    }
    expect(source).not.toMatch(/\.unsafe\(/);
  });

  test("every adapter route is feature-gated, built on defineTenantRoute, and reads no tenant or customer id from the body or query", async () => {
    for (const route of ROUTE_FILES) {
      const source = await readFile(route, "utf8");
      expect(source, route).toContain("requireBookingFeature(");
      expect(source, route).toContain("defineTenantRoute");
      expect(source, route).not.toMatch(/\.unsafe\(/);
      expect(source, route).not.toMatch(
        /body\.(?:tenantId|customerId)|searchParams\.get\("(?:tenant|customer)/
      );
    }
  });

  test("changing the booking service account is audited in the same transaction, and a lost unlink race is a no-op", async () => {
    const settings = await readFile(
      "src/modules/commerce/application/booking-adapter-settings.ts",
      "utf8"
    );
    expect(settings).toContain("recordAuditEvent(");
    expect(settings).toContain("commerce.booking_service_account.changed");
    expect(settings).toContain("oldTenantUserId");
    expect(settings).toContain("newTenantUserId");
    const route = await readFile(
      "src/pages/api/v1/commerce/store-settings/index.ts",
      "utf8"
    );
    expect(route).toMatch(
      /saveBookingServiceTenantUserId\(\s*tx,\s*tenantId,\s*prepared\.bookingServiceTenantUserId,\s*auth\.context\.tenantUserId/
    );
    const links = await readFile(
      "src/modules/commerce/application/booking-offering-links.ts",
      "utf8"
    );
    const unlink = links.slice(
      links.indexOf("export async function unlinkOfferingLink")
    );
    expect(unlink.indexOf("if (!rows[0])")).toBeGreaterThan(-1);
    expect(unlink.indexOf("if (!rows[0])")).toBeLessThan(
      unlink.indexOf("recordAuditEvent(")
    );
  });
});
