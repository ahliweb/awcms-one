/**
 * Implementation of `bun run bench:commerce-load` (entry:
 * `scripts/bench-commerce-load.ts`). It lives under `tests/bench/` for the same
 * reason `booking-bench.ts` does: it seeds a throwaway database through the
 * admin connection exactly as the integration tests do, and the
 * table-write-ownership gate scans `scripts/*.ts` for production writes.
 *
 * Load and concurrency benchmarks for the commerce money-and-inventory paths
 * (Issue #395, epic ahliweb/awcms-one#280 item 34; PRD M6/M7). Four scenarios:
 *
 *   1. hold-to-order     N concurrent reservation requests for one unit pool
 *                        (ADR-0045 G2/G4): exactly `capacity` orders, no double
 *                        allocation; a same-key replay storm creates one order;
 *                        an uncontended sustained rate.
 *   2. expiry vs payment the C-08 race at volume (ADR-0045 D-table): hold
 *                        expiry (the booking reaper), payment settlement and the
 *                        domain-event dispatcher all running at once over many
 *                        orders; every order must end in exactly one of three
 *                        consistent terminal states, never auto-cancelled while
 *                        it holds money.
 *   3. loyalty redeem    N concurrent redemptions against ONE account (ADR-0043,
 *                        C-30): the balance never goes negative, winners =
 *                        floor(balance / points), the ledger sums to the balance,
 *                        `reconcileLoyaltyForTenant` finds no drift.
 *   4. segment preview   p50/p95 of the preview endpoint's evaluator on a
 *                        100,000-customer tenant (PRD M7: p95 <= 3 s), alone and
 *                        with several actors previewing at once.
 *
 * WHY A SEPARATE TARGET. Exactly as `bench:booking`: a timing assertion in
 * `bun test` is a flaky test, so this is NOT a `*.test.ts` and is not in
 * `bun run check`. INVARIANTS (money, allocation, terminal state) are always
 * enforced and exit 1; THRESHOLDS (latency/throughput budgets, M7) are enforced
 * on the `standard` profile unless `--no-thresholds` is given. The numbers and
 * the hardware they were taken on are in `docs/benchmarks-commerce-load.md`.
 *
 * WHAT IT RUNS AGAINST. The integration harness's throwaway database: the real
 * migrations and the production roles (`awcms_app` under FORCE RLS for the
 * request path, `awcms_worker` for the reaper). It needs the same superuser
 * `DATABASE_URL` the integration suite needs and refuses to run without it.
 * Each contender is its own pooled connection and its own transaction (the
 * production shape, `withTenant` without the in-process work-class gate), so the
 * DATABASE sees every contender at once.
 *
 * Usage: bun run bench:commerce-load [--profile smoke|standard] [--only <list>]
 *                                    [--json <file>] [--no-thresholds]
 *   --only: comma list of hold,race,loyalty,segment
 */
import { writeFileSync } from "node:fs";

import {
  createRuntimePool,
  getAdminSql,
  getWorkerRoleSql,
  integrationEnabled,
  reassertRuntimeRoleLogins,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "../integration/harness";
import { composedBookingPort } from "../../src/lib/composition/booking-port";
import {
  emitReaperExpiredEvents,
  expireDueHolds
} from "../../src/modules/booking/application/booking-hold-expiry";
import { saveBookingServiceTenantUserId } from "../../src/modules/commerce/application/booking-adapter-settings";
import {
  createBookingReservation,
  type HoldToOrderResult
} from "../../src/modules/commerce/application/booking-hold-to-order";
import { createOfferingLink } from "../../src/modules/commerce/application/booking-offering-links";
import {
  adjustPoints,
  findOrCreateAccountLocked,
  reconcileLoyaltyForTenant
} from "../../src/modules/commerce/application/loyalty-ledger";
import { saveRedemptionSettings } from "../../src/modules/commerce/application/loyalty-redemption";
import {
  createOrderFromCart,
  type CreateOrderOutcome
} from "../../src/modules/commerce/application/order-directory";
import { recordOwnerPayment } from "../../src/modules/commerce/application/payment-recording";
import { createProduct } from "../../src/modules/commerce/application/product-directory";
import { SEGMENT_EVALUATION_LIMITS } from "../../src/modules/commerce/domain/segment";
import {
  previewSegment,
  type SegmentEvaluationContext
} from "../../src/modules/commerce/application/segment-evaluator";
import { saveStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import {
  type BookingRequestActor,
  type BookingReservationRequest
} from "../../src/modules/commerce/domain/booking-hold-to-order";
import type { CreateOrderInput } from "../../src/modules/commerce/domain/order-request-validation";
import type { CreateProductInput } from "../../src/modules/commerce/domain/product-validation";
import { validateSegmentRules } from "../../src/modules/commerce/domain/segment-rules";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
import { dispatchDomainEventsForTenant } from "../../src/modules/domain-event-runtime/application/dispatch-domain-events";
import { mediaLibraryPortAdapter } from "../../src/modules/media-library/application/media-library-port-adapter";
import { updateModuleSettings } from "../../src/modules/module-management/application/module-settings";
import { percentile } from "./booking-bench";

// --- Profiles and thresholds -------------------------------------------------

type ScenarioName = "hold" | "race" | "loyalty" | "segment";

type Profile = {
  name: "smoke" | "standard";
  /** Hold-to-order: rounds per (workers, capacity) cell. */
  holdRounds: number;
  holdWorkers: readonly number[];
  holdCapacities: readonly number[];
  /** Hold-to-order: independent fixtures booked once each (sustained rate). */
  holdSustainedFixtures: number;
  holdSustainedLanes: number;
  /** Replay storm: simultaneous same-key requests per round. */
  replayWorkers: number;
  replayRounds: number;
  /** Expiry vs payment: orders per cohort (paid-first / racing / expired-unpaid). */
  raceCohortPaid: number;
  raceCohortRacing: number;
  raceCohortExpired: number;
  raceLanes: number;
  /** How long after the race starts the racing cohort's holds lapse, ms. */
  raceWindowMs: number;
  /** Loyalty: rounds, simultaneous redeemers, balance and points per redemption. */
  loyaltyRounds: number;
  loyaltyWorkers: readonly number[];
  /** Points each redeemer asks for; the balance is sized per cell so only about half of them can win. */
  loyaltyPointsEach: number;
  /** Segment preview. */
  segmentCustomers: number;
  segmentRounds: number;
  segmentConcurrentActors: number;
  /** Size of the runtime connection pool (>= every worker count + a margin). */
  poolSize: number;
};

const PROFILES: Record<Profile["name"], Profile> = {
  smoke: {
    name: "smoke",
    holdRounds: 2,
    holdWorkers: [8],
    holdCapacities: [1, 3],
    holdSustainedFixtures: 10,
    holdSustainedLanes: 4,
    replayWorkers: 8,
    replayRounds: 2,
    raceCohortPaid: 4,
    raceCohortRacing: 8,
    raceCohortExpired: 4,
    raceLanes: 4,
    raceWindowMs: 120,
    loyaltyRounds: 2,
    loyaltyWorkers: [8],
    loyaltyPointsEach: 1000,
    segmentCustomers: 2000,
    segmentRounds: 2,
    segmentConcurrentActors: 5,
    poolSize: 24
  },
  standard: {
    name: "standard",
    holdRounds: 20,
    holdWorkers: [8, 32],
    holdCapacities: [1, 5],
    holdSustainedFixtures: 300,
    holdSustainedLanes: 16,
    replayWorkers: 32,
    replayRounds: 10,
    raceCohortPaid: 100,
    raceCohortRacing: 300,
    raceCohortExpired: 100,
    raceLanes: 16,
    raceWindowMs: 5000,
    loyaltyRounds: 20,
    loyaltyWorkers: [8, 32],
    loyaltyPointsEach: 1000,
    segmentCustomers: 100_000,
    segmentRounds: 12,
    segmentConcurrentActors: 6,
    poolSize: 40
  }
};

// --- Statistics (local: booking-bench.ts is upstream's file, kept unmodified) ---

type Latency = {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
};

function latencyOf(samples: readonly number[]): Latency {
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (value: number) => Math.round(value * 100) / 100;

  return {
    count: sorted.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1] ?? 0)
  };
}

async function timed<T>(samples: number[], work: () => Promise<T>): Promise<T> {
  const start = performance.now();

  try {
    return await work();
  } finally {
    samples.push(performance.now() - start);
  }
}

/** Runs `total` jobs with at most `concurrency` in flight; a thrown job fails the run. */
async function pooled(
  total: number,
  concurrency: number,
  job: (index: number) => Promise<void>
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = next;
      next += 1;

      if (index >= total) {
        return;
      }

      await job(index);
    }
  });

  await Promise.all(lanes);
}

/**
 * Budgets for the `standard` profile: a margin over the numbers recorded in
 * `docs/benchmarks-commerce-load.md`, not the baseline itself (a threshold at
 * the measured value is a flaky assertion by another name). `smoke` checks
 * invariants only. `segmentPreviewP95Ms` is the PRD M7 target itself, not a
 * margin: 3,000 ms.
 */
export const THRESHOLDS = {
  /** p95 of ONE contender in a hold-to-order race, ms. */
  holdRaceP95Ms: 2000,
  /** Sustained uncontended hold-to-order rate, orders per second. */
  holdSustainedMinPerSecond: 20,
  /** p95 of one payment settlement during the expiry race, ms. */
  racePaymentP95Ms: 1000,
  /** p95 of ONE contender in a loyalty redemption race, ms. */
  loyaltyRaceP95Ms: 2000,
  /** PRD M7: p95 of a segment preview on a 100,000-customer tenant, ms. */
  segmentPreviewP95Ms: 3000
} as const;

// --- CLI ---------------------------------------------------------------------

function parseArgs(argv: string[]) {
  let profileName: Profile["name"] = "standard";
  let jsonPath: string | null = null;
  let thresholds = true;
  let only: ReadonlySet<ScenarioName> = new Set([
    "hold",
    "race",
    "loyalty",
    "segment"
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;

    if (arg === "--profile") {
      const value = argv[(index += 1)];

      if (value !== "smoke" && value !== "standard") {
        throw new Error("--profile must be smoke or standard");
      }

      profileName = value;
    } else if (arg === "--json") {
      jsonPath = argv[(index += 1)] ?? null;
    } else if (arg === "--no-thresholds") {
      thresholds = false;
    } else if (arg === "--only") {
      const names = (argv[(index += 1)] ?? "").split(",").filter(Boolean);
      const valid = ["hold", "race", "loyalty", "segment"];

      if (names.length === 0 || names.some((n) => !valid.includes(n))) {
        throw new Error(`--only takes a comma list of ${valid.join(",")}`);
      }

      only = new Set(names as ScenarioName[]);
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }

  return { profile: PROFILES[profileName], jsonPath, thresholds, only };
}

// --- Reporting, invariants, thresholds ---------------------------------------

const results: Record<string, unknown> = {};
const violations: string[] = [];

function invariant(condition: boolean, message: string): void {
  if (!condition) {
    violations.push(`INVARIANT ${message}`);
  }
}

let enforceThresholds = true;
let activeProfile: Profile = PROFILES.standard;

function budget(
  name: string,
  actual: number,
  limit: number,
  kind: "max" | "min"
) {
  if (!enforceThresholds || activeProfile.name !== "standard") {
    return;
  }

  const ok = kind === "max" ? actual <= limit : actual >= limit;

  if (!ok) {
    violations.push(
      `THRESHOLD ${name}: ${actual} ${kind === "max" ? "exceeds" : "is below"} ${limit}`
    );
  }
}

function logSection(title: string, body: unknown): void {
  console.log(`\n== ${title}`);
  console.log(JSON.stringify(body, null, 2));
}

const perSecond = (count: number, ms: number): number =>
  Math.round((count / Math.max(ms, 1)) * 1000 * 10) / 10;

// --- Fixtures ----------------------------------------------------------------

type Sql = Bun.SQL;
let pool: Sql;
let tenantSeq = 0;
let codeSeq = 0;

const PRICE = "500000.00";
const NIGHT_PHONE = "081311112222";

type Tenant = { id: string; actor: string };

/** A tenant with the commerce settings every scenario needs and a staff actor. */
async function seedTenant(label: string): Promise<Tenant> {
  await reassertRuntimeRoleLogins();
  tenantSeq += 1;
  const id = `b3950000-0000-4000-8000-${String(tenantSeq).padStart(12, "0")}`;
  const code = `c395-${label}-${tenantSeq}`;
  const admin = getAdminSql();

  await admin`
    INSERT INTO awcms_tenants (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${`Bench ${code}`}, ${`Bench ${code} Legal`}, 'active', 'en', 'light')
  `;

  const profile = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${id}, 'person', ${`Actor ${code}`}) RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${id}, ${profile[0]!.id}, ${`${code}@example.com`}, 'x') RETURNING id
  `) as { id: string }[];
  const user = (await admin`
    INSERT INTO awcms_tenant_users (tenant_id, identity_id)
    VALUES (${id}, ${identity[0]!.id}) RETURNING id
  `) as { id: string }[];
  const actor = user[0]!.id;

  // Booking's default caps (500 live holds per tenant, 5 per customer) are abuse
  // limits; a volume benchmark would just measure the 429.
  await admin`
    INSERT INTO awcms_booking_settings
      (tenant_id, max_active_holds_per_tenant, max_active_holds_per_customer)
    VALUES (${id}, 1000000, 1000000)
  `;

  const validated = validateStoreSettingsInput({
    storeName: "Bench Store",
    shipping: { selfPickup: true },
    payment: { manualQris: { active: true, mediaObjectId: null } }
  });

  if (!validated.valid) {
    throw new Error(JSON.stringify(validated.errors));
  }

  await tenantTx(id, async (tx) => {
    await saveStoreSettings(tx, id, actor, validated.value);
    await updateModuleSettings(
      tx,
      id,
      "commerce",
      {
        features: {
          pos: true,
          inbox: true,
          campaigns: true,
          gateway: true,
          courier: true,
          returns: true,
          booking: true,
          loyalty: true,
          loyaltyRedemption: true
        }
      },
      actor
    );
    await saveBookingServiceTenantUserId(tx, id, actor, actor);
  });

  return { id, actor };
}

function tenantTx<T>(
  tenantId: string,
  fn: (tx: Bun.TransactionSQL) => Promise<T>
): Promise<T> {
  return pool.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
    return fn(tx);
  });
}

// --- Shared event/dispatch helpers --------------------------------------------

type DispatchTotals = {
  claimed: number;
  retried: number;
  deadLettered: number;
};

/**
 * One bounded dispatcher pass for the tenant, as the runtime role (the shape
 * the `domain-events:dispatch` job and the integration suites use).
 */
async function dispatchPass(tenantId: string): Promise<DispatchTotals> {
  const pass = await dispatchDomainEventsForTenant(pool, tenantId, {
    limit: 200
  });

  return {
    claimed: pass.claimed,
    retried: pass.retried,
    deadLettered: pass.deadLettered
  };
}

/** Runs dispatcher passes until two in a row find nothing due (or a pass cap). */
async function drainEvents(tenantId: string): Promise<DispatchTotals> {
  const total: DispatchTotals = { claimed: 0, retried: 0, deadLettered: 0 };
  let quiet = 0;

  for (let pass = 0; pass < 400 && quiet < 2; pass += 1) {
    const result = await dispatchPass(tenantId);

    total.claimed += result.claimed;
    total.retried += result.retried;
    total.deadLettered += result.deadLettered;
    quiet = result.claimed === 0 ? quiet + 1 : 0;
  }

  return total;
}

// --- 1. Hold-to-order --------------------------------------------------------

type Fixture = {
  productId: string;
  offeringId: string;
  resourceId: string;
};

/** A service product, a stay resource of `capacity` units and a hold-then-confirm stay offering, linked. */
async function newBookingFixture(
  tenant: Tenant,
  capacity: number
): Promise<Fixture> {
  const admin = getAdminSql();

  codeSeq += 1;
  const code = `f${codeSeq}`;
  const product = (await admin`
    INSERT INTO awcms_commerce_products
      (tenant_id, type, sku, name, slug, price, stock, status)
    VALUES (${tenant.id}, 'service', ${`SKU-${code}`}, ${`Kamar ${code}`}, ${`kamar-${code}`}, ${PRICE}, 0, 'active')
    RETURNING id
  `) as { id: string }[];
  const resource = (await admin`
    INSERT INTO awcms_booking_resources
      (tenant_id, code, name, kind, capacity, timezone, booking_mode,
       stay_check_in_time, stay_check_out_time)
    VALUES (${tenant.id}, ${code}, ${`Room ${code}`}, 'room', ${capacity},
            'Asia/Pontianak', 'stay', '14:00'::time, '12:00'::time)
    RETURNING id
  `) as { id: string }[];

  await admin`
    INSERT INTO awcms_booking_resource_units (tenant_id, resource_id, ordinal)
    SELECT ${tenant.id}, ${resource[0]!.id}, g FROM generate_series(1, ${capacity}::int) g
  `;

  const offering = (await admin`
    INSERT INTO awcms_booking_service_offerings
      (tenant_id, code, name, granularity, min_nights, max_nights, max_party, confirmation_mode)
    VALUES (${tenant.id}, ${`night-${code}`}, 'Night', 'stay', 1, 30, 4, 'hold_then_confirm')
    RETURNING id
  `) as { id: string }[];
  const linked = await tenantTx(tenant.id, (tx) =>
    createOfferingLink(
      tx,
      tenant.id,
      tenant.actor,
      {
        offeringId: offering[0]!.id,
        productId: product[0]!.id,
        quantityBasis: "nights"
      },
      `link-${code}`
    )
  );

  if (linked.kind === "refused") {
    throw new Error(`offering link refused: ${linked.refusal}`);
  }

  return {
    productId: product[0]!.id,
    offeringId: offering[0]!.id,
    resourceId: resource[0]!.id
  };
}

/** A local date `day` days after a point comfortably inside Booking's default horizon. */
const stayDate = (day: number): string =>
  new Date(Date.now() + (60 + day) * 86_400_000).toISOString().slice(0, 10);

function reservationRequest(fixture: Fixture): BookingReservationRequest {
  return {
    offeringId: fixture.offeringId,
    resourceId: fixture.resourceId,
    startsAt: null,
    stay: { checkInDate: stayDate(10), checkOutDate: stayDate(12) },
    partySize: 2,
    guest: { name: "Budi", phone: NIGHT_PHONE, email: null },
    paymentMethod: "manual_qris",
    notes: null
  };
}

async function bookOnce(
  tenant: Tenant,
  fixture: Fixture,
  key: string,
  actor?: BookingRequestActor
): Promise<HoldToOrderResult> {
  const port = await composedBookingPort();

  return tenantTx(tenant.id, (tx) =>
    createBookingReservation(
      tx,
      {
        tenantId: tenant.id,
        actor: actor ?? { kind: "staff", tenantUserId: tenant.actor },
        correlationId: crypto.randomUUID(),
        port,
        mediaPort: mediaLibraryPortAdapter
      },
      reservationRequest(fixture),
      key
    )
  );
}

type Counts = { orders: number; links: number; reservations: number };

async function tenantCounts(tenantId: string): Promise<Counts> {
  const admin = getAdminSql();
  const one = async (query: Promise<unknown>) =>
    ((await query) as { n: number }[])[0]!.n;

  return {
    orders: await one(
      admin`SELECT count(*)::int AS n FROM awcms_commerce_orders WHERE tenant_id = ${tenantId}`
    ),
    links: await one(
      admin`SELECT count(*)::int AS n FROM awcms_commerce_booking_reservation_links WHERE tenant_id = ${tenantId}`
    ),
    reservations: await one(
      admin`SELECT count(*)::int AS n FROM awcms_booking_reservations WHERE tenant_id = ${tenantId}`
    )
  };
}

async function liveAllocations(resourceId: string): Promise<number> {
  const rows = (await getAdminSql()`
    SELECT count(*)::int AS n FROM awcms_booking_resource_allocations
    WHERE resource_id = ${resourceId} AND released_at IS NULL
  `) as { n: number }[];

  return rows[0]!.n;
}

async function holdRound(
  tenant: Tenant,
  capacity: number,
  workers: number,
  samples: number[]
): Promise<{ wins: number; wallMs: number }> {
  const fixture = await newBookingFixture(tenant, capacity);
  const before = await tenantCounts(tenant.id);
  let go!: () => void;
  const start = new Promise<void>((resolve) => {
    go = resolve;
  });
  const contenders = Array.from({ length: workers }, async (_, index) => {
    await start;
    return timed(samples, () =>
      bookOnce(tenant, fixture, `h395-${codeSeq}-${index}`)
    );
  });
  const began = performance.now();

  go();

  const settled = await Promise.allSettled(contenders);
  const wallMs = performance.now() - began;
  const threw = settled.filter((s) => s.status === "rejected");

  invariant(
    threw.length === 0,
    `hold-to-order capacity ${capacity} x ${workers}: ${threw.length} contender(s) threw instead of returning a result`
  );

  const outcomes = settled
    .filter(
      (s): s is PromiseFulfilledResult<HoldToOrderResult> =>
        s.status === "fulfilled"
    )
    .map((s) => s.value);
  const wins = outcomes.filter((o) => o.kind === "created").length;
  const unavailable = outcomes.filter(
    (o) =>
      o.kind === "refused" &&
      o.refusal.code === "BOOKING" &&
      o.refusal.reason === "SLOT_UNAVAILABLE"
  ).length;
  const expected = Math.min(capacity, workers);
  const after = await tenantCounts(tenant.id);

  invariant(
    wins === expected,
    `hold-to-order capacity ${capacity} x ${workers}: ${wins} order(s) created, expected exactly ${expected}`
  );
  invariant(
    wins + unavailable === workers,
    `hold-to-order capacity ${capacity} x ${workers}: ${workers - wins - unavailable} contender(s) ended neither created nor SLOT_UNAVAILABLE`
  );
  invariant(
    after.orders - before.orders === wins &&
      after.links - before.links === wins &&
      after.reservations - before.reservations === wins,
    `hold-to-order capacity ${capacity} x ${workers}: orders/links/reservations grew by ${after.orders - before.orders}/${after.links - before.links}/${after.reservations - before.reservations}, expected ${wins} each (a refused request left a partial write, or a winner lost one)`
  );
  invariant(
    (await liveAllocations(fixture.resourceId)) === wins,
    `hold-to-order capacity ${capacity} x ${workers}: live allocations differ from the winners (double allocation or a partial claim left behind)`
  );

  return { wins, wallMs };
}

async function benchHold(profile: Profile): Promise<void> {
  const tenant = await seedTenant("hold");
  const report: Record<string, unknown> = {};

  for (const workers of profile.holdWorkers) {
    for (const capacity of profile.holdCapacities) {
      const samples: number[] = [];
      const walls: number[] = [];
      let winners = 0;

      for (let round = 0; round < profile.holdRounds; round += 1) {
        const outcome = await holdRound(tenant, capacity, workers, samples);

        walls.push(outcome.wallMs);
        winners += outcome.wins;
      }

      const claim = latencyOf(samples);

      report[`capacity_${capacity}_${workers}_workers`] = {
        rounds: profile.holdRounds,
        requests: samples.length,
        ordersCreated: winners,
        contenderMs: claim,
        roundWallMs: latencyOf(walls)
      };
      budget(
        `hold-to-order capacity ${capacity} x ${workers} p95 ms`,
        claim.p95,
        THRESHOLDS.holdRaceP95Ms,
        "max"
      );
    }
  }

  // Replay storm: the SAME key and request from many workers at once is ONE
  // order (G5); the rest are replays of it.
  const replaySamples: number[] = [];
  let replayCreated = 0;
  let replayReplayed = 0;

  for (let round = 0; round < profile.replayRounds; round += 1) {
    const fixture = await newBookingFixture(tenant, 1);
    const before = await tenantCounts(tenant.id);
    const key = `storm395-${round}-${codeSeq}`;
    const settled = await Promise.allSettled(
      Array.from({ length: profile.replayWorkers }, () =>
        timed(replaySamples, () => bookOnce(tenant, fixture, key))
      )
    );
    const outcomes = settled
      .filter(
        (s): s is PromiseFulfilledResult<HoldToOrderResult> =>
          s.status === "fulfilled"
      )
      .map((s) => s.value);
    const created = outcomes.filter((o) => o.kind === "created").length;
    const replayed = outcomes.filter((o) => o.kind === "replayed").length;
    const after = await tenantCounts(tenant.id);

    replayCreated += created;
    replayReplayed += replayed;
    invariant(
      settled.every((s) => s.status === "fulfilled") &&
        created === 1 &&
        created + replayed === profile.replayWorkers,
      `replay storm: ${created} created + ${replayed} replayed of ${profile.replayWorkers} (expected exactly 1 created, the rest replays, none thrown)`
    );
    invariant(
      after.orders - before.orders === 1 &&
        (await liveAllocations(fixture.resourceId)) === 1,
      `replay storm: the same key produced ${after.orders - before.orders} order(s) / ${await liveAllocations(fixture.resourceId)} allocation(s), expected 1 / 1`
    );
  }

  report.replay_storm = {
    rounds: profile.replayRounds,
    workers: profile.replayWorkers,
    created: replayCreated,
    replayed: replayReplayed,
    requestMs: latencyOf(replaySamples)
  };

  // Sustained, uncontended rate: independent fixtures, each booked once.
  const sustainedSamples: number[] = [];
  const fixtures: Fixture[] = [];

  for (let index = 0; index < profile.holdSustainedFixtures; index += 1) {
    fixtures.push(await newBookingFixture(tenant, 1));
  }

  const beforeSustained = await tenantCounts(tenant.id);
  const began = performance.now();
  let failures = 0;

  await pooled(fixtures.length, profile.holdSustainedLanes, async (index) => {
    const result = await timed(sustainedSamples, () =>
      bookOnce(tenant, fixtures[index]!, `s395-${index}-${codeSeq}`)
    );

    if (result.kind !== "created") {
      failures += 1;
    }
  });

  const sustainedMs = performance.now() - began;
  const afterSustained = await tenantCounts(tenant.id);
  const rate = perSecond(fixtures.length, sustainedMs);

  invariant(
    failures === 0 &&
      afterSustained.orders - beforeSustained.orders === fixtures.length,
    `sustained hold-to-order: ${failures} refusal(s), ${afterSustained.orders - beforeSustained.orders} orders for ${fixtures.length} independent fixtures`
  );
  report.sustained = {
    orders: fixtures.length,
    lanes: profile.holdSustainedLanes,
    ordersPerSecond: rate,
    requestMs: latencyOf(sustainedSamples)
  };
  budget(
    "sustained hold-to-order orders/s",
    rate,
    THRESHOLDS.holdSustainedMinPerSecond,
    "min"
  );

  results.holdToOrder = report;
  logSection("1. hold-to-order", report);
}

// --- 2. Expiry vs payment race -----------------------------------------------

type RaceOrder = {
  cohort: "paid" | "racing" | "expired";
  orderId: string;
  reservationId: string;
  paymentOutcome?: string;
};

/**
 * Test-only, exactly as the integration suite does it for a hold (the update
 * guard forbids shortening, and the database clock is the only clock): move
 * holds to `now + offsetMs` (negative = already lapsed). One statement for a
 * whole cohort.
 */
async function moveHoldExpiry(
  reservationIds: string[],
  offsetMs: number
): Promise<void> {
  if (reservationIds.length === 0) {
    return;
  }

  await getAdminSql().begin(async (tx) => {
    await tx.unsafe(
      "ALTER TABLE awcms_booking_reservations DISABLE TRIGGER awcms_booking_reservations_update_guard"
    );
    await tx`
      UPDATE awcms_booking_reservations
      SET hold_expires_at = clock_timestamp() + ${offsetMs}::int * interval '1 millisecond'
      WHERE id = ANY(${tx.array(reservationIds, "uuid")}::uuid[])
    `;
    await tx.unsafe(
      "ALTER TABLE awcms_booking_reservations ENABLE TRIGGER awcms_booking_reservations_update_guard"
    );
  });
}

/** One batch of the booking reaper as the worker role, publishing `expired` events. Returns how many holds it expired. */
async function sweepHolds(tenantId: string, limit: number): Promise<number> {
  return getWorkerRoleSql().begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
    const outcome = await expireDueHolds(tx, tenantId, limit);

    await emitReaperExpiredEvents(tx, tenantId, outcome, crypto.randomUUID());

    return outcome.expired;
  });
}

function payInFull(tenant: Tenant, orderId: string) {
  return tenantTx(tenant.id, (tx) =>
    recordOwnerPayment(tx, tenant.id, tenant.actor, orderId, {
      idempotencyKey: crypto.randomUUID(),
      tenderType: "manual_qris",
      amount: "1000000.00",
      reference: null,
      note: null
    })
  );
}

type TerminalRow = {
  order_id: string;
  order_status: string;
  reservation_status: string;
  attention_reason: string | null;
  attention_resolved_at: Date | null;
  held: string;
};

async function benchRace(profile: Profile): Promise<void> {
  const tenant = await seedTenant("race");
  const admin = getAdminSql();
  const total =
    profile.raceCohortPaid +
    profile.raceCohortRacing +
    profile.raceCohortExpired;
  const orders: RaceOrder[] = [];
  const cohorts: RaceOrder["cohort"][] = [
    ...Array(profile.raceCohortPaid).fill("paid"),
    ...Array(profile.raceCohortRacing).fill("racing"),
    ...Array(profile.raceCohortExpired).fill("expired")
  ];
  const holdSamples: number[] = [];
  const setupBegan = performance.now();

  // One independent reservation per order (an own fixture each), so the
  // contention measured below is on the ORDERS, not on one resource's lock.
  await pooled(total, profile.raceLanes, async (index) => {
    const fixture = await newBookingFixture(tenant, 1);
    const result = await timed(holdSamples, () =>
      bookOnce(tenant, fixture, `r395-${index}-${codeSeq}`)
    );

    if (result.kind !== "created") {
      throw new Error(`race setup: hold ${index} was ${result.kind}`);
    }

    orders[index] = {
      cohort: cohorts[index]!,
      orderId: result.view.orderId,
      reservationId: result.view.reservationId
    };
  });

  const setupMs = performance.now() - setupBegan;
  const byCohort = (cohort: RaceOrder["cohort"]) =>
    orders.filter((order) => order.cohort === cohort);

  // Cohort "paid": payment settles and the confirm consumer runs BEFORE the
  // reaper starts. A confirmed reservation must survive every sweep.
  await pooled(byCohort("paid").length, profile.raceLanes, async (index) => {
    const order = byCohort("paid")[index]!;
    const outcome = await payInFull(tenant, order.orderId);

    order.paymentOutcome = outcome.kind;
  });

  const paidDrain = await drainEvents(tenant.id);

  // A confirmed reservation carries no hold expiry (a CHECK), so the "paid"
  // cohort is not touched: the reaper below simply must leave it alone. The
  // unpaid cohort's holds are already lapsed; the racing cohort's lapse
  // `raceWindowMs` into the race, so some payments land before the lapse (the
  // confirm can win) and the rest after it (the late-payment rule applies).
  await moveHoldExpiry(
    byCohort("expired").map((o) => o.reservationId),
    -2000
  );
  await moveHoldExpiry(
    byCohort("racing").map((o) => o.reservationId),
    profile.raceWindowMs
  );

  // The race. Payments on the racing cohort, the reaper, and the dispatcher all
  // run at once; the "expired" cohort gets no payment at all.
  const paymentSamples: number[] = [];
  let paymentsDone = false;
  let expiredByReaper = 0;
  const raceBegan = performance.now();
  // Each racing payment is scheduled at a random instant across twice the
  // window, so settlements straddle the lapse: before it (the confirm can win),
  // between it and the canceller (the late-payment rule), and after the order
  // closed (the payment is refused). At most `raceLanes` are in flight.
  let inFlight = 0;
  const waiting: (() => void)[] = [];
  const acquire = async () => {
    if (inFlight >= profile.raceLanes) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }

    inFlight += 1;
  };
  const release = () => {
    inFlight -= 1;
    waiting.shift()?.();
  };
  const payers = Promise.all(
    byCohort("racing").map(async (order) => {
      await Bun.sleep(Math.random() * 2 * profile.raceWindowMs);
      await acquire();

      try {
        const outcome = await timed(paymentSamples, () =>
          payInFull(tenant, order.orderId)
        );

        order.paymentOutcome = outcome.kind;
      } finally {
        release();
      }
    })
  ).finally(() => {
    paymentsDone = true;
  });
  const reaper = (async () => {
    while (true) {
      const expired = await sweepHolds(tenant.id, 25);

      expiredByReaper += expired;

      if (expired === 0 && paymentsDone) {
        return;
      }
    }
  })();
  const dispatcher = (async () => {
    while (!paymentsDone) {
      await dispatchPass(tenant.id);
    }
  })();

  await Promise.all([payers, reaper, dispatcher]);

  const raceMs = performance.now() - raceBegan;
  const drainBegan = performance.now();
  const finalDrain = await drainEvents(tenant.id);
  const drainMs = performance.now() - drainBegan;

  // A last reaper pass and drain: the events of the final sweep batch.
  expiredByReaper += await sweepHolds(tenant.id, 1000);
  const lastDrain = await drainEvents(tenant.id);

  // --- Classify every order by its end state, from the database, not the
  // function results. Money held = succeeded payments minus reversals.
  const ids = orders.map((order) => order.orderId);
  const rows = (await admin`
    SELECT o.id AS order_id, o.status AS order_status,
           r.status AS reservation_status,
           l.attention_reason, l.attention_resolved_at,
           (SELECT COALESCE(SUM(CASE WHEN a.kind = 'payment' THEN a.amount ELSE -a.amount END), 0)::text
              FROM awcms_commerce_payment_allocations a
              WHERE a.tenant_id = o.tenant_id AND a.order_id = o.id
                AND a.status = 'succeeded') AS held
    FROM awcms_commerce_orders o
    JOIN awcms_commerce_booking_reservation_links l
      ON l.tenant_id = o.tenant_id AND l.order_id = o.id
    JOIN awcms_booking_reservations r
      ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id
    WHERE o.tenant_id = ${tenant.id} AND o.id = ANY(${admin.array(ids, "uuid")}::uuid[])
  `) as TerminalRow[];
  const byId = new Map(rows.map((row) => [row.order_id, row]));
  const tally: Record<string, Record<string, number>> = {
    paid: {},
    racing: {},
    expired: {}
  };
  const bump = (cohort: string, state: string) => {
    tally[cohort]![state] = (tally[cohort]![state] ?? 0) + 1;
  };

  invariant(
    rows.length === total,
    `expiry race: ${rows.length} of ${total} orders found with a reservation link`
  );

  for (const order of orders) {
    const row = byId.get(order.orderId);

    if (!row) {
      continue;
    }

    const money = Number(row.held);
    const unresolved =
      row.attention_reason !== null && row.attention_resolved_at === null;
    let state: string;

    if (
      row.order_status === "paid" &&
      row.reservation_status === "confirmed" &&
      row.attention_reason === null &&
      money === 1_000_000
    ) {
      state = "confirmed";
    } else if (
      row.order_status === "paid" &&
      row.reservation_status === "expired" &&
      row.attention_reason === "deposit_after_expiry" &&
      unresolved &&
      money === 1_000_000
    ) {
      state = "paid_after_expiry_flagged";
    } else if (
      (row.order_status === "expired" || row.order_status === "cancelled") &&
      row.reservation_status === "expired" &&
      row.attention_reason === null &&
      money === 0
    ) {
      state = "closed_unpaid";
    } else {
      state = `INCONSISTENT(order=${row.order_status},reservation=${row.reservation_status},attention=${row.attention_reason},held=${row.held})`;
      violations.push(
        `INVARIANT expiry race: order ${order.orderId} (${order.cohort}) ended ${state}`
      );
    }

    bump(order.cohort, state);

    // Cohort rules on top of the three states.
    if (order.cohort === "paid" && state !== "confirmed") {
      violations.push(
        `INVARIANT expiry race: payment-first order ${order.orderId} ended ${state}, must stay confirmed`
      );
    }

    if (order.cohort === "expired" && state !== "closed_unpaid") {
      violations.push(
        `INVARIANT expiry race: unpaid expired order ${order.orderId} ended ${state}, must close unpaid`
      );
    }

    // Money is never lost and never left on a closed order: a payment that
    // returned ok MUST be held; a refused one MUST NOT be.
    if (order.paymentOutcome === "created" && money !== 1_000_000) {
      violations.push(
        `INVARIANT expiry race: order ${order.orderId} accepted a payment but holds ${row.held}`
      );
    }

    if (
      order.paymentOutcome !== undefined &&
      order.paymentOutcome !== "created" &&
      money !== 0
    ) {
      violations.push(
        `INVARIANT expiry race: order ${order.orderId} refused a payment (${order.paymentOutcome}) but holds ${row.held}`
      );
    }
  }

  // Allocations: a live allocation exists exactly for the held/confirmed
  // reservations; an expired reservation holds no capacity.
  const alloc = (await admin`
    SELECT
      (SELECT count(*)::int FROM awcms_booking_resource_allocations
        WHERE tenant_id = ${tenant.id} AND released_at IS NULL) AS live,
      (SELECT count(*)::int FROM awcms_booking_reservations
        WHERE tenant_id = ${tenant.id} AND status IN ('held', 'confirmed')) AS open_reservations,
      (SELECT count(*)::int FROM awcms_booking_reservations
        WHERE tenant_id = ${tenant.id} AND status = 'held') AS still_held
  `) as { live: number; open_reservations: number; still_held: number }[];

  invariant(
    alloc[0]!.live === alloc[0]!.open_reservations &&
      alloc[0]!.still_held === 0,
    `expiry race: ${alloc[0]!.live} live allocations for ${alloc[0]!.open_reservations} open reservations, ${alloc[0]!.still_held} reservation(s) still held after every sweep`
  );

  const dispatchFailures =
    paidDrain.deadLettered + finalDrain.deadLettered + lastDrain.deadLettered;

  invariant(
    dispatchFailures === 0,
    `expiry race: ${dispatchFailures} domain event delivery(ies) dead-lettered`
  );

  const payment = latencyOf(paymentSamples);

  results.expiryVsPayment = {
    orders: total,
    cohorts: {
      paidFirst: profile.raceCohortPaid,
      racing: profile.raceCohortRacing,
      expiredUnpaid: profile.raceCohortExpired
    },
    raceWindowMs: profile.raceWindowMs,
    setupMs: Math.round(setupMs),
    holdCreateMs: latencyOf(holdSamples),
    raceWallMs: Math.round(raceMs),
    raceOrdersPerSecond: perSecond(
      profile.raceCohortRacing + profile.raceCohortExpired,
      raceMs
    ),
    paymentMs: payment,
    drainAfterRaceMs: Math.round(drainMs),
    holdsExpiredByReaper: expiredByReaper,
    eventDeliveries: {
      claimedAfterRace: finalDrain.claimed,
      retried: paidDrain.retried + finalDrain.retried + lastDrain.retried,
      deadLettered: dispatchFailures
    },
    terminalStates: tally
  };
  logSection(
    `2. expiry vs payment race (${total} orders)`,
    results.expiryVsPayment
  );
  budget(
    "expiry race payment p95 ms",
    payment.p95,
    THRESHOLDS.racePaymentP95Ms,
    "max"
  );
}

// --- 3. Concurrent loyalty redemptions ---------------------------------------

const BASE_PRODUCT: CreateProductInput = {
  categoryId: null,
  type: "physical",
  sku: "SKU-BENCH",
  name: "Kopi Bench",
  slug: "kopi-bench",
  description: null,
  digitalNote: null,
  price: "10000.00",
  discountPercent: 0,
  stock: 1_000_000,
  label: null,
  labelColor: null,
  priceLevel2: null,
  priceLevel3: null,
  priceLevel4: null,
  costPrice: null,
  minPurchase: 1,
  weightGrams: 250,
  manualRating: null,
  manualSoldCount: 0,
  withInsurance: false,
  insuranceRequired: false,
  insuranceFee: null,
  promoBannerShow: false,
  promoBannerTitle: null,
  promoBannerSubtitle: null,
  promoBannerBadge: null,
  promoBannerIcon: null,
  promoBannerColor: null,
  sizeChartType: "none",
  sizeChartMediaId: null,
  sizeChartDetails: null,
  serviceForm: null,
  subscriptionPeriod: null,
  downloadLink: null,
  allowDp: false,
  allowFreeShipping: false,
  variantAttributes: null,
  isFeatured: false,
  isRecommended: false
};

let customerSeq = 0;

async function seedLoyaltyCustomer(
  tenant: Tenant,
  balance: number
): Promise<{ id: string; orderPhone: string }> {
  customerSeq += 1;
  const digits = `8123${String(customerSeq).padStart(8, "0")}`;
  const rows = (await getAdminSql()`
    INSERT INTO awcms_commerce_customers (tenant_id, name, phone, status)
    VALUES (${tenant.id}, ${`Pelanggan ${customerSeq}`}, ${`+62${digits}`}, 'active')
    RETURNING id
  `) as { id: string }[];
  const id = rows[0]!.id;

  await tenantTx(tenant.id, async (tx) => {
    await findOrCreateAccountLocked(tx, tenant.id, id);
    const outcome = await adjustPoints(
      tx,
      tenant.id,
      tenant.actor,
      {
        customerId: id,
        points: balance,
        reason: "bench grant",
        idempotencyKey: `grant-${id}`
      },
      new Date()
    );

    if (outcome.kind !== "adjusted") {
      throw new Error(`grant refused: ${outcome.kind}`);
    }
  });

  return { id, orderPhone: `0${digits}` };
}

function redemptionOrder(
  productId: string,
  phone: string,
  points: number,
  key: string
): CreateOrderInput {
  return {
    idempotencyKey: key,
    customer: { name: "Pelanggan", phone, email: null },
    address: null,
    lines: [
      { productId, variantId: null, quantity: 2, serviceFormValues: null }
    ],
    shipping: { method: "self_pickup" },
    payment: { method: "manual_qris" },
    voucherCode: null,
    insurance: false,
    notes: null,
    affiliateCode: null,
    loyaltyRedemption: { points }
  };
}

async function accountState(
  tenantId: string,
  customerId: string
): Promise<{
  balance: number;
  ledgerSum: number;
  redeemRows: number;
  redeemPoints: number;
  orders: number;
  redemptions: number;
}> {
  const rows = (await getAdminSql()`
    SELECT a.balance::bigint::int AS balance,
           COALESCE((SELECT SUM(l.points) FROM awcms_commerce_loyalty_ledger l
                     WHERE l.tenant_id = a.tenant_id AND l.account_id = a.id), 0)::int AS ledger_sum,
           (SELECT count(*) FROM awcms_commerce_loyalty_ledger l
             WHERE l.tenant_id = a.tenant_id AND l.account_id = a.id AND l.kind = 'redeem')::int AS redeem_rows,
           COALESCE((SELECT -SUM(l.points) FROM awcms_commerce_loyalty_ledger l
             WHERE l.tenant_id = a.tenant_id AND l.account_id = a.id AND l.kind = 'redeem'), 0)::int AS redeem_points,
           (SELECT count(*) FROM awcms_commerce_orders o
             WHERE o.tenant_id = a.tenant_id AND o.customer_id = a.customer_id)::int AS orders,
           (SELECT count(*) FROM awcms_commerce_loyalty_redemptions r
             WHERE r.tenant_id = a.tenant_id AND r.account_id = a.id)::int AS redemptions
    FROM awcms_commerce_loyalty_accounts a
    WHERE a.tenant_id = ${tenantId} AND a.customer_id = ${customerId}
  `) as {
    balance: number;
    ledger_sum: number;
    redeem_rows: number;
    redeem_points: number;
    orders: number;
    redemptions: number;
  }[];
  const row = rows[0]!;

  return {
    balance: row.balance,
    ledgerSum: row.ledger_sum,
    redeemRows: row.redeem_rows,
    redeemPoints: row.redeem_points,
    orders: row.orders,
    redemptions: row.redemptions
  };
}

async function benchLoyalty(profile: Profile): Promise<void> {
  const tenant = await seedTenant("loyalty");
  const product = await tenantTx(tenant.id, (tx) =>
    createProduct(tx, tenant.id, tenant.actor, BASE_PRODUCT)
  );

  await getAdminSql()`
    UPDATE awcms_commerce_products SET status = 'active' WHERE id = ${product.id}
  `;
  // 1 point = Rp 1; a 2 x Rp 10,000 cart can absorb up to 20,000 points.
  await tenantTx(tenant.id, (tx) =>
    saveRedemptionSettings(tx, tenant.id, tenant.actor, {
      rupiahPerPoint: 1,
      maxGoodsPercent: null
    })
  );

  const report: Record<string, unknown> = {};
  const each = profile.loyaltyPointsEach;

  for (const workers of profile.loyaltyWorkers) {
    // Room for about half the redeemers, plus a remainder smaller than one
    // redemption: the rest MUST be refused, and the leftover must stay exact.
    const winnersExpected = Math.floor(workers / 2);
    const balance = winnersExpected * each + Math.floor(each / 2);

    const samples: number[] = [];
    const walls: number[] = [];
    let created = 0;
    let refused = 0;

    for (let round = 0; round < profile.loyaltyRounds; round += 1) {
      const customer = await seedLoyaltyCustomer(tenant, balance);
      let go!: () => void;
      const start = new Promise<void>((resolve) => {
        go = resolve;
      });
      const contenders = Array.from({ length: workers }, async (_, index) => {
        await start;
        return timed(samples, () =>
          tenantTx(tenant.id, (tx) =>
            createOrderFromCart(
              tx,
              tenant.id,
              mediaLibraryPortAdapter,
              redemptionOrder(
                product.id,
                customer.orderPhone,
                each,
                crypto.randomUUID() + `-${index}`
              ),
              new Date(),
              undefined,
              customer.id
            )
          )
        );
      });
      const began = performance.now();

      go();

      const settled = await Promise.allSettled(contenders);

      walls.push(performance.now() - began);

      const threw = settled.filter((s) => s.status === "rejected");

      invariant(
        threw.length === 0,
        `loyalty redeem ${workers} workers: ${threw.length} contender(s) threw (${threw
          .slice(0, 1)
          .map((s) => String((s as PromiseRejectedResult).reason))
          .join("")})`
      );

      const outcomes = settled
        .filter(
          (s): s is PromiseFulfilledResult<CreateOrderOutcome> =>
            s.status === "fulfilled"
        )
        .map((s) => s.value);
      const wins = outcomes.filter((o) => o.kind === "created").length;
      const insufficient = outcomes.filter(
        (o) =>
          o.kind === "loyalty_refused" &&
          o.refusal.code === "INSUFFICIENT_POINTS"
      ).length;
      const state = await accountState(tenant.id, customer.id);
      const expectedWins = winnersExpected;

      created += wins;
      refused += insufficient;
      invariant(
        wins === expectedWins && wins + insufficient === workers,
        `loyalty redeem ${workers} workers: ${wins} won / ${insufficient} INSUFFICIENT_POINTS of ${workers}, expected ${expectedWins} winners and the rest INSUFFICIENT_POINTS`
      );
      invariant(
        state.balance === balance - wins * each && state.balance >= 0,
        `loyalty redeem ${workers} workers: balance ${state.balance}, expected ${balance - wins * each} (>= 0) - a double spend or a lost debit`
      );
      invariant(
        state.ledgerSum === state.balance &&
          state.redeemRows === wins &&
          state.redeemPoints === wins * each,
        `loyalty redeem ${workers} workers: ledger sums to ${state.ledgerSum} with ${state.redeemRows} redeem row(s) / ${state.redeemPoints} points, balance ${state.balance}, winners ${wins}`
      );
      invariant(
        state.orders === wins && state.redemptions === wins,
        `loyalty redeem ${workers} workers: ${state.orders} order(s) / ${state.redemptions} redemption record(s) for ${wins} winner(s) (a refused redemption left an order, or a winner lost its record)`
      );
    }

    const latency = latencyOf(samples);

    report[`${workers}_workers`] = {
      rounds: profile.loyaltyRounds,
      balance,
      pointsEach: each,
      winnersPerRound: winnersExpected,
      ordersCreated: created,
      refusedInsufficientPoints: refused,
      contenderMs: latency,
      roundWallMs: latencyOf(walls)
    };
    budget(
      `loyalty redeem ${workers} workers p95 ms`,
      latency.p95,
      THRESHOLDS.loyaltyRaceP95Ms,
      "max"
    );
  }

  // The whole tenant, after every round: no account drifted from its ledger and
  // no hash-chain break.
  const reconcile = await tenantTx(tenant.id, (tx) =>
    reconcileLoyaltyForTenant(tx, tenant.id, { repair: false })
  );

  invariant(
    reconcile.drifted.length === 0 && reconcile.ledgerBreaks.length === 0,
    `loyalty reconcile: ${reconcile.drifted.length} drifted account(s), ${reconcile.ledgerBreaks.length} ledger break(s)`
  );
  report.reconcile = {
    drifted: reconcile.drifted.length,
    ledgerBreaks: reconcile.ledgerBreaks.length
  };

  const negatives = (await getAdminSql()`
    SELECT count(*)::int AS n FROM awcms_commerce_loyalty_accounts
    WHERE tenant_id = ${tenant.id} AND balance < 0
  `) as { n: number }[];

  invariant(negatives[0]!.n === 0, "loyalty: an account balance is negative");
  report.negativeBalances = negatives[0]!.n;

  results.loyaltyRedemption = report;
  logSection("3. concurrent loyalty redemptions on one account", report);
}

// --- 4. Segment preview ------------------------------------------------------

const leaf = (field: string, op: string, value?: unknown, extra = {}) => ({
  field,
  op,
  ...(value === undefined ? {} : { value }),
  ...extra
});

function segmentRules(raw: unknown) {
  const result = validateSegmentRules(raw);

  if (!result.valid) {
    throw new Error(`rules refused: ${JSON.stringify(result.errors)}`);
  }

  return { node: result.node, stats: result.stats };
}

/** The five rules `commerce-segments.integration.test.ts` (M7) uses: broad, windowed and multi-fact. */
const SEGMENT_RULES: { name: string; raw: unknown }[] = [
  { name: "level_in_1_2", raw: leaf("level", "in", [1, 2]) },
  { name: "order_count_gte_2", raw: leaf("order_count", "gte", 2) },
  {
    name: "windowed_orders_spend_not_lapsed",
    raw: {
      and: [
        leaf("order_count", "gte", 1, { windowDays: 90 }),
        leaf("paid_spend", "gte", "30000.00", { windowDays: 365 }),
        { not: leaf("last_order_date", "before", { daysAgo: 100 }) }
      ]
    }
  },
  {
    name: "account_loyalty_spend_or_tenure",
    raw: {
      and: [
        leaf("has_account", "eq", true),
        leaf("loyalty_balance", "gte", 100),
        {
          or: [
            leaf("paid_spend", "gt", "50000.00"),
            leaf("first_order_date", "after", { daysAgo: 365 }),
            leaf("customer_since", "before", { daysAgo: 400 })
          ]
        }
      ]
    }
  },
  {
    name: "two_windows_and_never_not",
    raw: {
      and: [
        leaf("order_count", "gte", 1, { windowDays: 90 }),
        leaf("order_count", "gte", 2, { windowDays: 200 }),
        leaf("paid_spend", "gt", "1000.00", { windowDays: 365 }),
        { not: leaf("last_order_date", "never") }
      ]
    }
  }
];

async function benchSegment(profile: Profile): Promise<void> {
  const tenant = await seedTenant("segment");
  const admin = getAdminSql();
  const customers = profile.segmentCustomers;
  const seedBegan = performance.now();

  await admin`
    INSERT INTO awcms_commerce_customers
      (tenant_id, name, phone, email, level, created_at)
    SELECT ${tenant.id}, 'Perf ' || g, '+62877' || lpad(g::text, 9, '0'),
      CASE WHEN g % 3 = 0 THEN 'perf' || g || '@example.com' END,
      1 + (g % 4), now() - (g % 700) * interval '1 day'
    FROM generate_series(1, ${customers}::int) g
  `;
  // ~2.5 paid orders per customer on average, spread over two years.
  await admin`
    INSERT INTO awcms_commerce_orders
      (tenant_id, order_code, customer_id, status, payment_method,
       payment_status, shipping_method, subtotal, total, paid_at)
    SELECT ${tenant.id}, 'PERF-' || row_number() OVER (), c.id, 'completed',
      'manual_bank', 'paid', 'self_pickup', 10000 + (n * 7919) % 90000,
      10000 + (n * 7919) % 90000,
      now() - ((n * 37) % 720) * interval '1 day'
    FROM (SELECT id, row_number() OVER () AS rn FROM awcms_commerce_customers
          WHERE tenant_id = ${tenant.id}) c
    CROSS JOIN generate_series(1, 5) n
    WHERE (c.rn + n) % 2 = 0
  `;
  await admin`
    INSERT INTO awcms_commerce_customer_accounts
      (tenant_id, customer_id, email_normalized, history_from)
    SELECT tenant_id, id, email, now() - interval '300 days'
    FROM awcms_commerce_customers
    WHERE tenant_id = ${tenant.id} AND email IS NOT NULL
  `;
  await admin`
    INSERT INTO awcms_commerce_loyalty_accounts (tenant_id, customer_id, balance)
    SELECT tenant_id, id, (extract(epoch FROM created_at)::bigint % 1000)
    FROM awcms_commerce_customers
    WHERE tenant_id = ${tenant.id} AND level IN (2, 3)
  `;
  await admin`ANALYZE awcms_commerce_customers`;
  await admin`ANALYZE awcms_commerce_orders`;
  await admin`ANALYZE awcms_commerce_customer_accounts`;
  await admin`ANALYZE awcms_commerce_loyalty_accounts`;

  const seedMs = performance.now() - seedBegan;
  const counts = (await admin`
    SELECT (SELECT count(*) FROM awcms_commerce_customers WHERE tenant_id = ${tenant.id})::int AS customers,
           (SELECT count(*) FROM awcms_commerce_orders WHERE tenant_id = ${tenant.id})::int AS orders
  `) as { customers: number; orders: number }[];

  invariant(
    counts[0]!.customers === customers,
    `segment: seeded ${counts[0]!.customers} customers, expected ${customers}`
  );

  const evaluationContext = (actor: string): SegmentEvaluationContext => ({
    tenantId: tenant.id,
    actorTenantUserId: actor,
    now: new Date()
  });
  const preview = async (raw: unknown, actor: string) => {
    const outcome = await tenantTx(tenant.id, (tx) =>
      previewSegment(tx, evaluationContext(actor), segmentRules(raw), {
        includeSample: true
      })
    );

    if (outcome.kind !== "ok") {
      throw new Error(`segment preview: ${outcome.kind}`);
    }

    return outcome.preview.count.count ?? -1;
  };

  // A warm-up pass so the first sample is not a cold plan/cache, reported apart.
  const warm: number[] = [];

  for (const rule of SEGMENT_RULES) {
    await timed(warm, () => preview(rule.raw, tenant.actor));
  }

  const all: number[] = [];
  const perRule: Record<string, number[]> = {};
  const memberCounts: Record<string, number> = {};

  for (let round = 0; round < profile.segmentRounds; round += 1) {
    for (const rule of SEGMENT_RULES) {
      const samples = (perRule[rule.name] ??= []);
      const count = await timed(samples, () => preview(rule.raw, tenant.actor));

      all.push(samples[samples.length - 1]!);
      memberCounts[rule.name] = count;
    }
  }

  const overall = latencyOf(all);

  // Real populations: the timings measured work, not an empty scan.
  if (customers >= 100_000) {
    invariant(
      memberCounts.level_in_1_2! > 40_000 &&
        memberCounts.order_count_gte_2! > 1_000 &&
        memberCounts.windowed_orders_spend_not_lapsed! > 1_000 &&
        memberCounts.two_windows_and_never_not! > 1_000,
      `segment: a rule matched an implausibly small population (${JSON.stringify(memberCounts)})`
    );
  }

  // Several actors previewing at once. The evaluator's own back-pressure
  // (`SEGMENT_EVALUATION_LIMITS`: a try-lock per tenant slot and per actor, never
  // a queue) answers `busy` over the limit, so two phases: AT the tenant limit
  // every preview must be served; ABOVE it a preview is either served or `busy`,
  // never an error, and the served ones still meet M7.
  const tenantSlots = SEGMENT_EVALUATION_LIMITS.tenantConcurrency;
  const atLimit: number[] = [];
  const burst: number[] = [];
  let busyAtLimit = 0;
  let busyInBurst = 0;
  let servedInBurst = 0;
  const concurrentErrors: string[] = [];
  const attempt = async (
    samples: number[],
    actor: string,
    rule: { raw: unknown }
  ): Promise<"ok" | "busy"> => {
    const started = performance.now();

    try {
      const outcome = await tenantTx(tenant.id, (tx) =>
        previewSegment(tx, evaluationContext(actor), segmentRules(rule.raw), {
          includeSample: true
        })
      );

      if (outcome.kind === "ok") {
        samples.push(performance.now() - started);

        return "ok";
      }

      if (outcome.kind === "busy") {
        return "busy";
      }

      concurrentErrors.push(outcome.kind);
    } catch (error) {
      concurrentErrors.push(String(error));
    }

    return "ok";
  };
  const rounds = Math.max(2, Math.floor(profile.segmentRounds / 2));
  const concurrentBegan = performance.now();

  for (let round = 0; round < rounds; round += 1) {
    const served = await Promise.all(
      Array.from({ length: tenantSlots }, (_, lane) =>
        attempt(
          atLimit,
          crypto.randomUUID(),
          SEGMENT_RULES[(round + lane) % SEGMENT_RULES.length]!
        )
      )
    );

    busyAtLimit += served.filter((r) => r === "busy").length;
  }

  for (let round = 0; round < rounds; round += 1) {
    const served = await Promise.all(
      Array.from({ length: profile.segmentConcurrentActors }, (_, lane) =>
        attempt(
          burst,
          crypto.randomUUID(),
          SEGMENT_RULES[(round + lane) % SEGMENT_RULES.length]!
        )
      )
    );

    busyInBurst += served.filter((r) => r === "busy").length;
    servedInBurst += served.filter((r) => r === "ok").length;
  }

  const concurrentMs = performance.now() - concurrentBegan;
  const atLimitLatency = latencyOf(atLimit);
  const burstLatency = latencyOf(burst);

  invariant(
    concurrentErrors.length === 0,
    `segment: ${concurrentErrors.length} concurrent preview(s) errored (not served, not busy): ${concurrentErrors[0] ?? ""}`
  );
  invariant(
    busyAtLimit === 0,
    `segment: ${busyAtLimit} preview(s) answered busy at the tenant limit of ${tenantSlots}`
  );
  invariant(
    servedInBurst >= 1,
    "segment: a burst above the tenant limit served nothing"
  );

  results.segmentPreview = {
    customers: counts[0]!.customers,
    paidOrders: counts[0]!.orders,
    seedMs: Math.round(seedMs),
    warmUpMs: latencyOf(warm),
    sequential: {
      samples: all.length,
      rulesPerRound: SEGMENT_RULES.length,
      previewMs: overall,
      m7TargetP95Ms: THRESHOLDS.segmentPreviewP95Ms,
      m7Met: overall.p95 <= THRESHOLDS.segmentPreviewP95Ms,
      perRuleP95Ms: Object.fromEntries(
        Object.entries(perRule).map(([name, samples]) => [
          name,
          latencyOf(samples).p95
        ])
      ),
      matchedMembers: memberCounts
    },
    concurrentAtTenantLimit: {
      actors: tenantSlots,
      served: atLimit.length,
      busy: busyAtLimit,
      previewMs: atLimitLatency
    },
    burstAboveTenantLimit: {
      actors: profile.segmentConcurrentActors,
      served: servedInBurst,
      busy: busyInBurst,
      previewMs: burstLatency,
      wallMs: Math.round(concurrentMs)
    }
  };
  logSection(
    `4. segment preview (${counts[0]!.customers} customers)`,
    results.segmentPreview
  );

  // M7 is the PRD target, asserted at the full 100,000 customers only: a smaller
  // smoke tenant says nothing about it.
  if (customers >= 100_000 && enforceThresholds) {
    budget(
      "M7 segment preview p95 ms",
      overall.p95,
      THRESHOLDS.segmentPreviewP95Ms,
      "max"
    );
  }
}

// --- Environment ---------------------------------------------------------------

async function environment(): Promise<Record<string, unknown>> {
  const admin = getAdminSql();
  const version = (await admin`SELECT version() AS v`) as { v: string }[];
  const memory = (
    await Bun.file("/proc/meminfo")
      .text()
      .catch(() => "")
  ).split("\n")[0];
  const cpu = (
    await Bun.file("/proc/cpuinfo")
      .text()
      .catch(() => "")
  )
    .split("\n")
    .find((line) => line.startsWith("model name"));
  const os = await import("node:os");

  return {
    postgres: version[0]!.v.split(" on ")[0],
    cpuModel: cpu?.split(":")[1]?.trim() ?? os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    memory: memory?.replace(/\s+/g, " "),
    bun: Bun.version,
    loadAverage1m: os.loadavg()[0]!.toFixed(2),
    runtimePoolSize: activeProfile.poolSize,
    startedAt: new Date().toISOString()
  };
}

export async function main(): Promise<number> {
  if (!integrationEnabled) {
    console.error(
      "bench:commerce-load needs a superuser DATABASE_URL (the integration harness's admin channel), e.g.\n  DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bun run bench:commerce-load"
    );
    return 2;
  }

  const args = parseArgs(process.argv.slice(2));

  activeProfile = args.profile;
  enforceThresholds = args.thresholds;

  await setupIntegrationDatabase();
  pool = createRuntimePool(args.profile.poolSize);

  try {
    results.profile = args.profile.name;
    results.environment = await environment();
    logSection("environment", results.environment);

    if (args.only.has("hold")) {
      await benchHold(args.profile);
    }

    if (args.only.has("race")) {
      await benchRace(args.profile);
    }

    if (args.only.has("loyalty")) {
      await benchLoyalty(args.profile);
    }

    if (args.only.has("segment")) {
      await benchSegment(args.profile);
    }
  } catch (error) {
    console.error("bench:commerce-load aborted:", error);
    violations.push(
      `ABORTED ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    await pool.close({ timeout: 1 });
    await teardownIntegrationDatabase();
  }

  results.thresholds = THRESHOLDS;
  results.violations = violations;
  (results.environment as Record<string, unknown> | undefined) ??= {};
  (results.environment as Record<string, unknown>).finishedLoadAverage1m = (
    await import("node:os")
  )
    .loadavg()[0]!
    .toFixed(2);

  if (args.jsonPath) {
    writeFileSync(args.jsonPath, `${JSON.stringify(results, null, 2)}\n`);
  }

  if (violations.length > 0) {
    console.error(`\nFAILED (${violations.length}):`);

    for (const violation of violations.slice(0, 40)) {
      console.error(`  - ${violation}`);
    }

    return 1;
  }

  console.log(
    `\nOK: every invariant held${enforceThresholds && args.profile.name === "standard" ? " and every threshold passed" : " (thresholds not enforced)"}.`
  );

  return 0;
}
