/**
 * Gate: the storefront's build-time reads (issue #555) and browser calls
 * (issue #556) are frozen against the OpenAPI bundle (ADR-0058 D2, audit F-01
 * and F-07).
 *
 * No database, no network, no build: it reads the committed bundle in
 * `apps/cms/openapi/`, the frozen fixture and the storefront source, so it runs
 * inside `local-ci/check-toko` through the bare root `bun test`.
 *
 * The first group is the real gate over this repository's state. The second
 * proves each check can actually fail, because a gate that has never been seen
 * red is an assumption (the mutations are made in memory or in a temp tree).
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  BROWSER_OPERATIONS,
  BUILD_OPERATIONS,
  BUNDLE_PATH,
  FIXTURE_PATH,
  FIXTURE_SCHEMA_VERSION,
  OPERATIONS,
  OUT_OF_BUNDLE,
  PENDING_UPSTREAM,
  PROFILES,
  REQUEST_BODY_UNDECLARED,
  THEMING_ROUTE_FILE,
  buildSlice,
  compareBrowserScanToSlice,
  compareScanToSlice,
  componentRoles,
  dereference,
  findContractBreaks,
  findFixtureDrift,
  findNegativeCaseProblems,
  findRequestBodyGaps,
  findRequestProblems,
  findResolvedPending,
  findUndeclaredQueryParams,
  isAdditiveSuperset,
  operationsForProfile,
  runChecks,
  scanBrowserCallSources,
  scanBuildReadSources
} from "../tools/lib/storefront-consumer-contract.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const bundle = Bun.YAML.parse(readFileSync(join(ROOT, BUNDLE_PATH), "utf8"));
const frozen = JSON.parse(readFileSync(join(ROOT, FIXTURE_PATH), "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));

describe("storefront build-read contract: this repository", () => {
  test("the whole gate is green (fixture, additive superset, query params, source scan)", () => {
    assert.deepEqual(runChecks({ frozen, bundle, root: ROOT }), []);
  });

  test("the fixture is exactly what OPERATIONS and OUT_OF_BUNDLE say (regeneration is deliberate)", () => {
    assert.deepEqual(findFixtureDrift(frozen), []);
  });

  test("every build operation is a GET in the bundle and every frozen operation is registered once", () => {
    const keys = OPERATIONS.map((entry) => `${entry.method} ${entry.path}`);
    assert.equal(new Set(keys).size, keys.length, "duplicate operation");
    assert.equal(OPERATIONS.length, BUILD_OPERATIONS.length + BROWSER_OPERATIONS.length);
    for (const entry of BUILD_OPERATIONS) {
      assert.equal(entry.phase, "build");
      assert.equal(entry.method, "GET");
      assert.ok(bundle.paths[entry.path]?.get, `${entry.path} has no GET in the bundle`);
      assert.ok(entry.readers.length > 0, `${entry.path} names no reader`);
    }
  });

  test("the per-profile sets are pinned: landing reads only the shared operations", () => {
    for (const profile of PROFILES) {
      assert.ok(operationsForProfile(BUILD_OPERATIONS, profile).length > 0, `${profile} has no build read`);
    }
    assert.deepEqual(
      operationsForProfile(BUILD_OPERATIONS, "landing").map((entry) => entry.path).sort(),
      [
        "/api/v1/blog/pages/public",
        "/api/v1/blog/pages/public/{slug}",
        "/api/v1/commerce/store-settings/public",
        "/api/v1/media/public-origin",
        "/api/v1/site-profile/composed"
      ],
      "landing builds the shared group only; widening this set is a deliberate decision"
    );
    // berita is a subset of toko (toko builds shared + toko + berita groups).
    const toko = new Set(operationsForProfile(BUILD_OPERATIONS, "toko").map((entry) => entry.path));
    for (const entry of operationsForProfile(BUILD_OPERATIONS, "berita")) {
      assert.ok(toko.has(entry.path), `${entry.path} is built by berita but not by toko`);
    }
    assert.ok(
      !operationsForProfile(BUILD_OPERATIONS, "berita").some((entry) => entry.path.startsWith("/api/v1/commerce/products")),
      "berita must not read the catalog"
    );
  });

  test("tokens.css is named explicitly as out of the bundle, with a reason and an alternative check", () => {
    assert.equal(OUT_OF_BUNDLE.length, 1);
    const [theme] = OUT_OF_BUNDLE;
    assert.equal(theme.path, "/theming/{tenantCode}/tokens.css");
    assert.deepEqual(theme.profiles, PROFILES);
    assert.ok(theme.reason.length > 0 && theme.alternativeCheck.length > 0);
    assert.equal(bundle.paths[theme.path], undefined, "tokens.css is now in the bundle: freeze it as an operation instead");
    assert.ok(existsSync(join(ROOT, THEMING_ROUTE_FILE)), `${THEMING_ROUTE_FILE} (the provider route) no longer exists`);
    assert.equal(frozen.paths[theme.path], undefined, "no schema may be invented for tokens.css");
  });

  test("nothing under tests/ or tools/ imports packages/kontrak at runtime, and apps/cms is not imported", () => {
    const sources = [
      readFileSync(join(ROOT, "tools/lib/storefront-consumer-contract.mjs"), "utf8"),
      readFileSync(join(ROOT, "tools/storefront-consumer-contract.mjs"), "utf8")
    ];
    for (const text of sources) {
      assert.doesNotMatch(text, /from\s+["'][^"']*packages\/kontrak/);
      assert.doesNotMatch(text, /from\s+["'][^"']*apps\/cms/);
    }
  });
});

describe("storefront build-read contract: each check can fail", () => {
  function currentSlice(mutate) {
    const copy = clone(bundle);
    mutate(copy);
    return buildSlice(copy, frozen.operations);
  }

  test("adding a field or an enum value is additive and passes", () => {
    const current = currentSlice((b) => {
      const schema = b.components.schemas[Object.keys(frozen.components.schemas)[0]];
      schema.properties = { ...(schema.properties ?? {}), brandNewOptionalField: { type: "string" } };
    });
    assert.deepEqual(findContractBreaks(frozen, current), []);
  });

  test("removing a property the consumer relies on is a break", () => {
    const target = Object.entries(frozen.components.schemas).find(([, schema]) => schema.properties && Object.keys(schema.properties).length > 0);
    assert.ok(target, "expected at least one frozen schema with properties");
    const [name, schema] = target;
    const dropped = Object.keys(schema.properties)[0];
    const current = currentSlice((b) => {
      delete b.components.schemas[name].properties[dropped];
    });
    const breaks = findContractBreaks(frozen, current);
    assert.ok(breaks.some((entry) => entry.includes(`components.schemas.${name}`)), breaks.join("\n"));
  });

  test("retyping a property is a break", () => {
    const target = Object.entries(frozen.components.schemas).find(([, schema]) =>
      Object.values(schema.properties ?? {}).some((property) => property.type === "string")
    );
    assert.ok(target);
    const [name, schema] = target;
    const field = Object.entries(schema.properties).find(([, property]) => property.type === "string")[0];
    const current = currentSlice((b) => {
      b.components.schemas[name].properties[field].type = "number";
    });
    assert.ok(findContractBreaks(frozen, current).length > 0);
  });

  test("a removed operation fails closed when the slice is rebuilt", () => {
    const copy = clone(bundle);
    delete copy.paths["/api/v1/blog/terms"].get;
    assert.throws(() => buildSlice(copy, frozen.operations), /GET \/api\/v1\/blog\/terms is not in/);
  });

  test("a narrowed enum is a break, an extended one is not (set semantics)", () => {
    assert.equal(isAdditiveSuperset(["a", "b"], ["a", "b", "c"]), true);
    assert.equal(isAdditiveSuperset(["a", "b"], ["a"]), false);
    assert.equal(isAdditiveSuperset({ type: "string" }, { type: "string", nullable: true }), true);
    assert.equal(isAdditiveSuperset({ type: "string" }, { type: "integer" }), false);
  });

  test("rewording documentation is not a contract change", () => {
    const current = currentSlice((b) => {
      b.paths["/api/v1/blog/terms"].get.description = "reworded";
      b.paths["/api/v1/blog/terms"].get.summary = "reworded";
    });
    assert.deepEqual(findContractBreaks(frozen, current), []);
  });

  test("a query parameter the bundle stops declaring is reported", () => {
    const copy = clone(bundle);
    const operation = copy.paths["/api/v1/analytics/pages"].get;
    operation.parameters = (operation.parameters ?? []).filter((parameter) => {
      const resolved = parameter.$ref ? copy.components.parameters[parameter.$ref.split("/").pop()] : parameter;
      return resolved?.name !== "range";
    });
    const problems = findUndeclaredQueryParams(copy, OPERATIONS);
    assert.ok(problems.some((entry) => entry.includes('"range"')), problems.join("\n"));
  });

  test("a fixture edited by hand, or an OPERATIONS edit without regeneration, is drift", () => {
    const edited = clone(frozen);
    edited.operations[0].profiles = ["landing"];
    assert.ok(findFixtureDrift(edited).length > 0);
  });
});

describe("storefront build-read contract: the source guard can fail", () => {
  function tree(files) {
    const dir = mkdtempSync(join(tmpdir(), "sfcc-"));
    for (const [rel, text] of Object.entries(files)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text);
    }
    return dir;
  }

  const LIB = "apps/storefront/src/lib/awcms";
  const registeredAll = {
    [`${LIB}/profil.ts`]: 'await awcmsGet("/api/v1/site-profile/composed");',
    [`${LIB}/pages.ts`]: 'awcmsGet("/api/v1/blog/pages/public"); awcmsGet(`/api/v1/blog/pages/public/${encodeURIComponent(slug)}`);',
    [`${LIB}/pemasaran.ts`]: [
      'awcmsGet("/api/v1/commerce/store-settings/public");',
      ...["sliders/active", "flash-sales/active", "vouchers/public", "testimonials/active", "popups/active"].map(
        (tail) => `awcmsGet("/api/v1/commerce/${tail}");`
      )
    ].join("\n"),
    [`${LIB}/media.ts`]: 'awcmsGet("/api/v1/media/public-origin"); awcmsGet("/api/v1/media/objects", {});',
    [`${LIB}/blog.ts`]: [
      "/api/v1/blog/posts",
      "/api/v1/blog/terms",
      "/api/v1/blog/institutions",
      "/api/v1/news-portal/ad-placements/active",
      "/api/v1/seo/redirects"
    ]
      .map((path) => `awcmsGet("${path}");`)
      .join("\n"),
    [`${LIB}/analitik.ts`]: 'awcmsGet("/api/v1/analytics/pages");',
    [`${LIB}/wilayah.ts`]: 'awcmsGet("/api/v1/idn-regions/regions");',
    [`${LIB}/wilayah-checkout.ts`]: 'awcmsGet("/api/v1/idn-regions/regions");',
    "apps/storefront/src/lib/catalog.ts": 'awcmsGet("/api/v1/commerce/products"); awcmsGet("/api/v1/commerce/categories");',
    [`${LIB}/theme.ts`]: "const url = `${origin}/theming/${encodeURIComponent(code)}/tokens.css`; fetch(url);"
  };

  function problemsFor(extra = {}, remove = []) {
    const files = { ...registeredAll, ...extra };
    for (const rel of remove) delete files[rel];
    const dir = tree(files);
    try {
      return compareScanToSlice(scanBuildReadSources(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("the synthetic baseline (every registered reader, nothing else) is clean", () => {
    assert.deepEqual(problemsFor(), []);
  });

  test("a new awcmsGet reader file is reported", () => {
    const problems = problemsFor({ [`${LIB}/novo.ts`]: 'awcmsGet("/api/v1/novo/endpoint");' });
    assert.ok(problems.some((entry) => entry.includes("novo.ts") && entry.includes("not a reader")), problems.join("\n"));
  });

  test("a new path in an existing reader is reported", () => {
    const problems = problemsFor({ [`${LIB}/analitik.ts`]: 'awcmsGet("/api/v1/analytics/pages"); awcmsGet("/api/v1/analytics/other");' });
    assert.ok(problems.some((entry) => entry.includes("/api/v1/analytics/other")), problems.join("\n"));
  });

  test("a path named only in a comment is not a read", () => {
    const problems = problemsFor({ [`${LIB}/analitik.ts`]: '// GET /api/v1/x/y\n/** "/api/v1/analytics/legacy" */ awcmsGet("/api/v1/analytics/pages");' });
    assert.deepEqual(problems, []);
  });

  test("an awcms path literal in a page, layout or component is reported", () => {
    const problems = problemsFor({
      "apps/storefront/src/pages/x.astro": '---\nconst r = await fetch(`${base}` + "/api/v1/commerce/leaked");\n---'
    });
    assert.ok(problems.some((entry) => entry.includes("pages/x.astro")), problems.join("\n"));
  });

  test("a reader that stopped reading leaves a stale entry", () => {
    const problems = problemsFor({}, [`${LIB}/analitik.ts`]);
    assert.ok(problems.some((entry) => entry.includes("analitik.ts") && entry.includes("stale")), problems.join("\n"));
  });

  test("a direct fetch() in src/lib/awcms outside theme.ts is reported", () => {
    const problems = problemsFor({ [`${LIB}/analitik.ts`]: 'awcmsGet("/api/v1/analytics/pages"); fetch(u);' });
    assert.ok(problems.some((entry) => entry.includes("calls fetch() directly")), problems.join("\n"));
  });

  test("the real source tree has no stray or unregistered build read", () => {
    assert.deepEqual(compareScanToSlice(scanBuildReadSources(ROOT)), []);
  });
});

// ---------------------------------------------------------------------------
// Browser calls (issue #556)
// ---------------------------------------------------------------------------

const SF = "/api/v1/commerce/storefront";
const browserKey = (entry) => `${entry.method} ${entry.path}`;
const find = (method, path) => BROWSER_OPERATIONS.find((entry) => entry.method === method && entry.path === path);

describe("storefront browser-call contract: this repository", () => {
  test("the fixture carries the browser phase at the pinned schema version", () => {
    assert.equal(frozen.schemaVersion, FIXTURE_SCHEMA_VERSION);
    assert.equal(FIXTURE_SCHEMA_VERSION, 2);
    assert.equal(frozen.operations.filter((entry) => entry.phase === "browser").length, BROWSER_OPERATIONS.length);
    assert.deepEqual(frozen.pendingUpstream, PENDING_UPSTREAM);
    assert.deepEqual(frozen.requestBodyUndeclared, REQUEST_BODY_UNDECLARED);
  });

  test("every browser operation exists in the bundle with its method, and none repeats", () => {
    const keys = BROWSER_OPERATIONS.map(browserKey);
    assert.equal(new Set(keys).size, keys.length, "duplicate browser operation");
    assert.equal(BROWSER_OPERATIONS.length, 53, "49 kirimPermintaan call sites + 3 newsletter + 1 analytics beacon");
    for (const entry of BROWSER_OPERATIONS) {
      assert.equal(entry.phase, "browser");
      assert.ok(bundle.paths[entry.path]?.[entry.method.toLowerCase()], `${browserKey(entry)} is not in the bundle`);
      assert.ok(entry.readers.length > 0);
      assert.ok(["bearer", "optional-bearer", "none"].includes(entry.auth));
      assert.ok(entry.profiles.length > 0 && entry.profiles.every((profile) => PROFILES.includes(profile)));
    }
  });

  test("the per-profile browser sets are pinned: only the beacon is on landing, newsletter joins it on berita", () => {
    const paths = (profile) => operationsForProfile(BROWSER_OPERATIONS, profile).map(browserKey).sort();
    assert.deepEqual(paths("landing"), ["POST /api/v1/analytics/collect"]);
    assert.deepEqual(paths("berita"), [
      "POST /api/v1/analytics/collect",
      "POST /api/v1/newsletter/confirm",
      "POST /api/v1/newsletter/subscribe",
      "POST /api/v1/newsletter/unsubscribe"
    ]);
    assert.equal(paths("toko").length, BROWSER_OPERATIONS.length, "toko builds every group, so it ships every browser call");
    for (const entry of BROWSER_OPERATIONS.filter((candidate) => candidate.path.startsWith(SF))) {
      assert.deepEqual(entry.profiles, ["toko"], `${browserKey(entry)}: accounts, cart, orders, booking and push exist only in toko`);
    }
  });

  test("every negative case names a handling and evidence, uses only the named statuses, and only 429 may be pending", () => {
    for (const entry of BROWSER_OPERATIONS) {
      for (const negative of entry.negatives) {
        assert.ok([204, 401, 404, 409, 429].includes(negative.status), `${browserKey(entry)} ${negative.status}`);
        assert.ok(negative.handling.length > 0);
        assert.ok(negative.evidence.file.startsWith("apps/storefront/src/") && negative.evidence.token.length > 0);
        if (negative.pending !== undefined) {
          assert.equal(negative.status, 429);
          assert.match(negative.pending, /awcms#1385/);
          assert.match(negative.pending, /#557/);
        }
      }
    }
    assert.deepEqual(findNegativeCaseProblems(bundle, ROOT), []);
  });

  test("429 is recorded on every call that goes through a transport; the beacon records none (it swallows every failure)", () => {
    for (const entry of BROWSER_OPERATIONS) {
      const has429 = entry.negatives.some((negative) => negative.status === 429);
      assert.equal(has429, entry.path !== "/api/v1/analytics/collect", browserKey(entry));
    }
    assert.deepEqual(find("POST", "/api/v1/analytics/collect").negatives, []);
  });

  test("a 429 that is not marked pending is declared by the bundle today", () => {
    for (const entry of BROWSER_OPERATIONS) {
      const declared = Object.keys(bundle.paths[entry.path][entry.method.toLowerCase()].responses);
      for (const negative of entry.negatives.filter((candidate) => candidate.status === 429 && candidate.pending === undefined)) {
        assert.ok(declared.includes("429"), `${browserKey(entry)} claims a declared 429`);
      }
    }
    // A pending marker the bundle has since resolved is a CLI note (issue #557), never a failure.
    assert.ok(Array.isArray(findResolvedPending(bundle)));
  });

  test("a required-bearer operation records 401 with the session-clearing handling; void calls record 204", () => {
    for (const entry of BROWSER_OPERATIONS.filter((candidate) => candidate.auth === "bearer")) {
      assert.ok(
        entry.negatives.some((negative) => negative.status === 401),
        `${browserKey(entry)} has no 401`
      );
    }
    assert.equal(find("POST", `${SF}/account/logout`).negatives.find((negative) => negative.status === 204)?.handling, "no-content");
    assert.ok(find("DELETE", `${SF}/account/wishlist/{productId}`).negatives.some((negative) => negative.status === 204));
    assert.equal(find("GET", `${SF}/account/me`).negatives.find((negative) => negative.status === 401).handling, "session-cleared");
  });

  test("named, verified handling: the order's cart refresh and rate-limit message, the erasure refusal, the stay 404", () => {
    const order = find("POST", `${SF}/orders`);
    assert.equal(order.negatives.find((negative) => negative.status === 409).handling, "cart-refresh");
    assert.equal(order.negatives.find((negative) => negative.status === 429).handling, "retry-message");
    assert.equal(find("POST", `${SF}/account/privacy/erasure`).negatives.find((negative) => negative.status === 409).handling, "refusal-list");
    assert.equal(find("GET", `${SF}/booking/availability`).negatives.find((negative) => negative.status === 404).handling, "offering-not-sold-state");
  });

  test("the Idempotency-Key behaviour is recorded: required header on the booking writes and the erasure, body field on the order", () => {
    const required = BROWSER_OPERATIONS.filter((entry) => entry.idempotencyKey === "header-required").map(browserKey).sort();
    assert.deepEqual(required, [
      `POST ${SF}/account/privacy/erasure`,
      `POST ${SF}/booking/reservations`,
      `POST ${SF}/booking/reservations/{orderCode}/cancel`
    ]);
    assert.equal(find("POST", `${SF}/orders`).idempotencyKey, "body-field");
    assert.deepEqual(find("POST", `${SF}/booking/reservations`).headerParams, ["Idempotency-Key"]);
    assert.deepEqual(findUndeclaredQueryParams(bundle, BROWSER_OPERATIONS), []);
  });

  test("the request bodies the bundle does not declare are named, with a reason (found by this slice)", () => {
    assert.equal(Object.keys(REQUEST_BODY_UNDECLARED).length, 2);
    assert.deepEqual(findRequestBodyGaps(bundle), []);
    for (const key of Object.keys(REQUEST_BODY_UNDECLARED)) {
      const entry = BROWSER_OPERATIONS.find((candidate) => browserKey(candidate) === key);
      assert.ok(entry?.sendsBody);
      assert.equal(frozen.paths[entry.path][entry.method.toLowerCase()].requestBody, undefined);
    }
  });

  test("components are classified by direction, and a request-only schema exists", () => {
    const roles = componentRoles(frozen);
    assert.ok(roles.request.has("#/components/schemas/CommerceCreateOrderRequest"));
    assert.ok(!roles.response.has("#/components/schemas/CommerceCreateOrderRequest"), "a request-only schema must not be held to the response rule");
    assert.ok(roles.response.size > 0 && roles.request.size > 0);
  });
});

describe("storefront browser-call contract: each check can fail", () => {
  function mutated(mutate) {
    const copy = clone(bundle);
    mutate(copy);
    return copy;
  }
  function breaksFor(mutate) {
    const copy = mutated(mutate);
    return findContractBreaks(frozen, buildSlice(copy, frozen.operations));
  }
  const orderRequest = (b) => b.components.schemas.CommerceCreateOrderRequest;
  const preferencesRequest = (b) => b.components.schemas.CommerceCustomerPushPreferencesRequest;

  test("RESPONSES stay additive: a new declared response passes, a removed one is a break", () => {
    assert.deepEqual(
      breaksFor((b) => {
        b.paths[`${SF}/booking/availability`].get.responses["418"] = { description: "teapot" };
      }),
      []
    );
    const breaks = breaksFor((b) => {
      delete b.paths[`${SF}/booking/availability`].get.responses["404"];
    });
    assert.ok(breaks.some((entry) => entry.includes(`GET ${SF}/booking/availability`)), breaks.join("\n"));
    const problems = findNegativeCaseProblems(
      mutated((b) => delete b.paths[`${SF}/booking/availability`].get.responses["404"]),
      ROOT
    );
    assert.ok(problems.some((entry) => entry.includes("negative case 404") && entry.includes("not declare")), problems.join("\n"));
  });

  test("REQUEST: adding an optional property is accepted", () => {
    assert.deepEqual(
      breaksFor((b) => {
        orderRequest(b).properties.brandNewOptional = { type: "string" };
      }),
      []
    );
  });

  test("REQUEST: a new required field is a break (the reverse of the response rule)", () => {
    const breaks = breaksFor((b) => {
      orderRequest(b).properties.brandNewMandatory = { type: "string" };
      orderRequest(b).required = [...orderRequest(b).required, "brandNewMandatory"];
    });
    assert.ok(breaks.some((entry) => entry.includes("newly required") && entry.includes("brandNewMandatory")), breaks.join("\n"));
  });

  test("REQUEST: dropping a required field is accepted (a request may relax), though a response drop would not be", () => {
    const breaks = breaksFor((b) => {
      orderRequest(b).required = orderRequest(b).required.filter((name) => name !== "customer");
    });
    assert.equal(breaks.filter((entry) => entry.includes("CommerceCreateOrderRequest")).length, 0, breaks.join("\n"));
    assert.equal(isAdditiveSuperset({ required: ["a", "b"] }, { required: ["a"] }), false);
  });

  test("REQUEST: removing or retyping a property the consumer sends is a break", () => {
    const removed = breaksFor((b) => {
      delete orderRequest(b).properties.customer;
    });
    assert.ok(removed.some((entry) => entry.includes('property "customer" was removed')), removed.join("\n"));
    const retyped = breaksFor((b) => {
      preferencesRequest(b).properties.textVersion.type = "integer";
    });
    assert.ok(retyped.some((entry) => entry.includes("textVersion") && entry.includes("no longer accepted")), retyped.join("\n"));
  });

  test("REQUEST: closing a schema, adding a bound, an enum or a format narrows it; widenings are accepted", () => {
    const narrowed = (frozenSchema, mutateSchema) => {
      const next = clone(frozenSchema);
      mutateSchema(next);
      return findRequestProblems(frozenSchema, next);
    };
    const base = { type: "object", properties: { n: { type: "integer" }, s: { type: "string", enum: ["a", "b"] } } };
    assert.deepEqual(narrowed(base, () => {}), []);
    assert.ok(narrowed(base, (next) => (next.additionalProperties = false)).some((p) => p.includes("additionalProperties")));
    assert.ok(narrowed(base, (next) => (next.properties.n.minimum = 1)).some((p) => p.includes("minimum")));
    assert.ok(narrowed(base, (next) => (next.properties.s.enum = ["a"])).some((p) => p.includes("enum value")));
    assert.ok(narrowed(base, (next) => (next.properties.s.format = "uuid")).some((p) => p.includes("format")));
    assert.ok(narrowed(base, (next) => (next.properties.s.maxLength = 3)).some((p) => p.includes("maxLength")));
    assert.ok(narrowed(base, (next) => (next.oneOf = [{ type: "object" }])).some((p) => p.includes("oneOf")));
    assert.deepEqual(narrowed(base, (next) => next.properties.s.enum.push("c")), []);
    assert.deepEqual(narrowed(base, (next) => delete next.properties.s.enum), []);
    assert.deepEqual(narrowed(base, (next) => (next.properties.n.type = ["integer", "null"])), []);
  });

  test("REQUEST: a nullable type that stops accepting null is a break, and a recursive schema compares to itself", () => {
    const nullable = { type: "string", nullable: true };
    assert.ok(findRequestProblems(nullable, { type: "string" }).some((p) => p.includes("null")));
    const tree = { schemas: { Tree: { type: "object", properties: { child: { $ref: "#/components/schemas/Tree" } } } } };
    const cyclic = dereference({ $ref: "#/components/schemas/Tree" }, tree);
    assert.equal(cyclic.properties.child.$cycle, "#/components/schemas/Tree");
    assert.deepEqual(findRequestProblems(cyclic, cyclic), []);
  });

  test("REQUEST: a new required parameter, or a removed one, is a break; a new optional one is not", () => {
    const withParameter = (required) =>
      breaksFor((b) => {
        b.paths[`${SF}/account/orders`].get.parameters = [
          ...(b.paths[`${SF}/account/orders`].get.parameters ?? []),
          { name: "tenantHint", in: "query", required, schema: { type: "string" } }
        ];
      });
    const required = withParameter(true);
    assert.ok(required.some((entry) => entry.includes("new required parameter query:tenanthint")), required.join("\n"));
    assert.deepEqual(withParameter(false), []);
    const removed = breaksFor((b) => {
      b.paths[`${SF}/account/orders`].get.parameters = [];
    });
    assert.ok(removed.some((entry) => entry.includes("parameter query:cursor is gone")), removed.join("\n"));
  });

  test("REQUEST: a request body that is no longer declared, or a media type that was replaced, is a break", () => {
    const gone = breaksFor((b) => {
      delete b.paths[`${SF}/orders`].post.requestBody;
    });
    assert.ok(gone.some((entry) => entry.includes("request body is no longer declared")), gone.join("\n"));
    const media = breaksFor((b) => {
      const body = b.paths[`${SF}/account/otp/request`].post.requestBody;
      body.content = { "text/plain": body.content["application/json"] };
    });
    assert.ok(media.some((entry) => entry.includes("application/json is no longer accepted")), media.join("\n"));
  });

  test("a header parameter the consumer sends (the booking Idempotency-Key) that the bundle stops declaring is reported", () => {
    const copy = mutated((b) => {
      b.paths[`${SF}/booking/reservations`].post.parameters = [];
    });
    const problems = findUndeclaredQueryParams(copy, BROWSER_OPERATIONS);
    assert.ok(problems.some((entry) => entry.includes('header parameter "Idempotency-Key"')), problems.join("\n"));
  });

  test("a sent body the bundle does not declare is reported, and a stale exemption is reported once it does", () => {
    const missing = findRequestBodyGaps(mutated((b) => delete b.paths[`${SF}/account/push/subscriptions`].post.requestBody));
    assert.ok(missing.some((entry) => entry.includes("does not declare")), missing.join("\n"));
    const stale = findRequestBodyGaps(
      mutated((b) => {
        b.paths[`${SF}/orders/{orderCode}/payment-proof/upload-sessions`].post.requestBody = {
          required: true,
          content: { "application/json": { schema: { type: "object" } } }
        };
      })
    );
    assert.ok(stale.some((entry) => entry.includes("remove the entry and regenerate")), stale.join("\n"));
  });

  test("a negative case marked pending that is not 429 is reported", () => {
    const operations = clone(BROWSER_OPERATIONS);
    const target = operations.find((entry) => entry.negatives.some((negative) => negative.status === 404));
    target.negatives.find((negative) => negative.status === 404).pending = "later";
    const problems = findNegativeCaseProblems(bundle, ROOT, operations);
    assert.ok(problems.some((entry) => entry.includes("may be pending")), problems.join("\n"));
  });

  test("a bearer operation with no 401 case, and a fixture whose pending list or version drifted, are reported", () => {
    const operations = clone(BROWSER_OPERATIONS);
    const target = operations.find((entry) => entry.auth === "bearer");
    target.negatives = target.negatives.filter((negative) => negative.status !== 401);
    assert.ok(findNegativeCaseProblems(bundle, ROOT, operations).some((entry) => entry.includes("no 401")));

    const edited = clone(frozen);
    edited.pendingUpstream = {};
    assert.ok(findFixtureDrift(edited).some((entry) => entry.includes("pendingUpstream")));
    const older = clone(frozen);
    older.schemaVersion = 1;
    assert.ok(findFixtureDrift(older).some((entry) => entry.includes("schemaVersion")));
  });
});

describe("storefront browser-call contract: the source guard can fail", () => {
  const SRC_REL = "apps/storefront/src";
  const AKUN = `${SRC_REL}/lib/akun-klien.ts`;
  const TOKO = `${SRC_REL}/lib/toko-klien.ts`;

  /** A copy of the real storefront source, mutated in place; the scan is run over the copy. */
  function withTree(mutate, run) {
    const dir = mkdtempSync(join(tmpdir(), "sfcc-browser-"));
    try {
      cpSync(join(ROOT, SRC_REL), join(dir, SRC_REL), { recursive: true });
      mutate((rel, change) => {
        const abs = join(dir, rel);
        mkdirSync(dirname(abs), { recursive: true });
        const before = existsSync(abs) ? readFileSync(abs, "utf8") : "";
        const after = typeof change === "function" ? change(before) : change;
        assert.notEqual(after, before, `mutation of ${rel} changed nothing`);
        writeFileSync(abs, after);
      });
      return run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const problemsIn = (mutate) => withTree(mutate, (dir) => compareBrowserScanToSlice(scanBrowserCallSources(dir)));

  test("the unmodified copy is clean (53 calls found, 35 inside the session-clearing wrapper)", () => {
    withTree(
      () => {},
      (dir) => {
        const scan = scanBrowserCallSources(dir);
        assert.equal(scan.calls.length, 53);
        assert.equal(scan.calls.filter((call) => call.wrapped).length, 35);
        assert.deepEqual(compareBrowserScanToSlice(scan), []);
      }
    );
    assert.deepEqual(compareBrowserScanToSlice(scanBrowserCallSources(ROOT)), []);
  });

  test("a new kirimPermintaan call to a path that is not frozen is reported", () => {
    const problems = problemsIn((edit) =>
      edit(AKUN, (text) => `${text}\nexport const novo = () => kirimPermintaan<unknown>("/account/novo", "GET");\n`)
    );
    assert.ok(problems.some((entry) => entry.includes(`GET ${SF}/account/novo`) && entry.includes("not frozen")), problems.join("\n"));
  });

  test("a changed path or method on an existing call is reported as new and as a stale entry", () => {
    const renamed = problemsIn((edit) => edit(TOKO, (text) => text.replace('"/cart/quote", "POST"', '"/cart/quote-v2", "POST"')));
    assert.ok(renamed.some((entry) => entry.includes("cart/quote-v2") && entry.includes("not frozen")), renamed.join("\n"));
    assert.ok(renamed.some((entry) => entry.includes(`POST ${SF}/cart/quote is frozen`) && entry.includes("stale")), renamed.join("\n"));

    const method = problemsIn((edit) => edit(TOKO, (text) => text.replace('"/cart/quote", "POST"', '"/cart/quote", "PUT"')));
    assert.ok(method.some((entry) => entry.includes("PUT") && entry.includes("not frozen")), method.join("\n"));
  });

  test("a bearer call that left denganPembersihanSesi no longer clears the session, and is reported", () => {
    const problems = problemsIn((edit) =>
      edit(AKUN, (text) =>
        text.replace(
          'denganPembersihanSesi(() =>\n    kirimPermintaan<{ account: Akun }>("/account/me", "GET"',
          'Promise.resolve().then(() =>\n    kirimPermintaan<{ account: Akun }>("/account/me", "GET"'
        )
      )
    );
    assert.ok(problems.some((entry) => entry.includes(`GET ${SF}/account/me`) && entry.includes("denganPembersihanSesi")), problems.join("\n"));
  });

  test("a new fetch, sendBeacon or XMLHttpRequest anywhere else is reported as an unregistered transport", () => {
    for (const body of [
      "export const a = () => fetch(`${origin}/api/v1/novo/x`);",
      "export const b = () => navigator.sendBeacon('/x', '');",
      "export const c = () => new XMLHttpRequest();"
    ]) {
      const problems = problemsIn((edit) => edit(`${SRC_REL}/scripts/novo.ts`, `${body}\n`));
      assert.ok(problems.some((entry) => entry.includes("scripts/novo.ts") && entry.includes("request transport")), problems.join("\n"));
    }
  });

  test("a new operation on the newsletter transport is reported, and a literal in an unregistered file too", () => {
    const newsletter = problemsIn((edit) =>
      edit(`${SRC_REL}/scripts/buletin.ts`, (text) => `${text}\nvoid request("/novo", { email: "a@b.c" });\n`)
    );
    assert.ok(newsletter.some((entry) => entry.includes("/api/v1/newsletter/novo") && entry.includes("not frozen")), newsletter.join("\n"));

    const stray = problemsIn((edit) => edit(`${SRC_REL}/lib/novo.ts`, 'export const url = "/api/v1/commerce/leaked";\n'));
    assert.ok(stray.some((entry) => entry.includes("lib/novo.ts") && entry.includes("neither a build reader")), stray.join("\n"));
  });

  test("a registered transport that no longer has one, and a beacon path that moved, are stale", () => {
    const transport = problemsIn((edit) =>
      edit(`${SRC_REL}/lib/wilayah-region-select.ts`, (text) => text.replace("await fetch(path)", "await Promise.resolve(path)"))
    );
    assert.ok(transport.some((entry) => entry.includes("wilayah-region-select.ts") && entry.includes("stale registration")), transport.join("\n"));

    const beacon = problemsIn((edit) =>
      edit(`${SRC_REL}/scripts/analitik.ts`, (text) =>
        text.replace('const COLLECT_PATH = "/api/v1/analytics/collect";', 'const COLLECT_PATH = "/api/v1/analytics/other";')
      )
    );
    assert.ok(beacon.some((entry) => entry.includes("POST /api/v1/analytics/collect is frozen") && entry.includes("stale")), beacon.join("\n"));
  });

  test("a path named only in a comment is not a call", () => {
    const problems = problemsIn((edit) =>
      edit(AKUN, (text) => `// kirimPermintaan<unknown>("/account/ghost", "GET")\n/** kirimPermintaan("/account/ghost2", "GET") */\n${text}`)
    );
    assert.deepEqual(problems, []);
  });

  test("evidence that moved or vanished is reported", () => {
    withTree(
      (edit) => {
        edit(`${SRC_REL}/scripts/checkout.ts`, (text) => text.replace('error.code === "CART_CHANGED"', 'error.code === "RENAMED"'));
        edit(`${SRC_REL}/lib/toko-permintaan.ts`, (text) => text.replace("response.status === 204", "response.status === 205"));
      },
      (dir) => {
        const problems = findNegativeCaseProblems(bundle, dir);
        assert.ok(problems.some((entry) => entry.includes(`POST ${SF}/orders negative case 409`) && entry.includes("CART_CHANGED")), problems.join("\n"));
        assert.ok(problems.some((entry) => entry.includes("negative case 204") && entry.includes("response.status === 204")), problems.join("\n"));
      }
    );
    const missingFile = findNegativeCaseProblems(bundle, join(tmpdir(), "sfcc-does-not-exist"));
    assert.ok(missingFile.some((entry) => entry.includes("does not exist")));
  });
});
