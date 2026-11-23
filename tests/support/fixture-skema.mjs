/**
 * Fixture-versus-OpenAPI-response gate: the engine (issue #553, ADR-0058).
 *
 * `apps/storefront/scripts/stub-awcms.mjs` serves hand-written JSON from
 * `apps/storefront/tests/fixtures/awcms/`. Nothing used to compare those
 * files with the provider's response schema, so a fixture could contradict
 * the contract and the storefront would still be green (audit finding F-02).
 * This module is the comparison: it reads the committed OpenAPI bundle in
 * `apps/cms/openapi/` (read only, never edited from here), resolves the
 * response schema of one (path, method, status), and validates a fixture's
 * response body against it with Ajv. No database, no network, no build.
 *
 * Side-effect free: importing this file runs nothing.
 *
 * ## What "valid" means here: three adjustments to plain Ajv
 *
 * The bundle declares `openapi: 3.1.0` but is written in the 3.0 dialect, and
 * its schemas rarely say `additionalProperties: false`. The schema is
 * normalised (on a deep copy; the bundle is never modified) as follows.
 *
 * 1. **Dialect.** `nullable` next to a `type` is understood by Ajv. A
 *    `nullable` with no `type` is rewritten (`{ $ref, nullable }` becomes
 *    "the ref or null"; on an `enum` the flag is dropped). `nullable: true`
 *    with an `enum` that omits `null` gets `null` added, because the intent
 *    is "this enum, or absent" (OpenAPI 3.0.3 says to list `null`; the bundle
 *    does not always). `example` is ignored (`strict: false`). Formats
 *    (`uuid`, `date-time`) are NOT asserted: `ajv-formats` is not a
 *    dependency and format checking is not what this gate is for.
 * 2. **Undeclared properties are errors.** Plain JSON Schema accepts a
 *    property the schema does not declare, which is exactly how F-04's
 *    `shipping.courier` goes unnoticed. Every use site of an object schema
 *    (a property value, an array item, the response root) that lists
 *    `properties`, composes (`allOf`/`oneOf`/`anyOf`) or is a `$ref` gets
 *    `unevaluatedProperties: false`. That keyword sees through `$ref` and
 *    `allOf`, so a composed schema is judged as a whole and no component
 *    is closed on its own (a component used as one `allOf` branch must not
 *    reject its sibling's properties). A schema that declares
 *    `additionalProperties` is left to it.
 * 3. **`$ref`s resolve against the bundle.** Every `#/components/...` ref is
 *    rewritten to point into the bundle registered with Ajv.
 */
import Ajv2020 from "ajv/dist/2020";
import { readFileSync } from "node:fs";

const ROOT = new URL("../../", import.meta.url).pathname;
export const BUNDLE_PATH = "apps/cms/openapi/awcms-public-api.openapi.yaml";
export const FIXTURE_DIR = "apps/storefront/tests/fixtures/awcms";

const COMPOSITION = ["allOf", "oneOf", "anyOf"];

export function loadBundle() {
  return Bun.YAML.parse(readFileSync(ROOT + BUNDLE_PATH, "utf8"));
}

/** Read a fixture file as JSON. */
export function readFixture(file) {
  return JSON.parse(readFileSync(ROOT + FIXTURE_DIR + "/" + file, "utf8"));
}

/**
 * Normalise one schema node (see the header). `branch` is true for a node
 * that is a branch of `allOf`/`oneOf`/`anyOf` or a component root: those are
 * never closed on their own, only the use site that contains them is.
 */
function normalise(node, branch) {
  if (Array.isArray(node)) return node.map((item) => normalise(item, branch));
  if (node === null || typeof node !== "object") return node;

  if (node.nullable === true && !("type" in node)) {
    const { nullable: _nullable, ...rest } = node;
    return "$ref" in rest
      ? normalise({ anyOf: [rest, { type: "null" }] }, branch)
      : normalise(rest, branch);
  }

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref") {
      out[key] = String(value).replace(/^#\//, "bundle#/");
    } else if (key === "properties" && value && typeof value === "object") {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [name, normalise(schema, false)])
      );
    } else if (COMPOSITION.includes(key) && Array.isArray(value)) {
      out[key] = value.map((entry) => normalise(entry, true));
    } else if ((key === "items" || key === "additionalProperties") && value && typeof value === "object") {
      out[key] = normalise(value, false);
    } else {
      out[key] = value;
    }
  }

  if (out.nullable === true && Array.isArray(out.enum) && !out.enum.includes(null)) {
    out.enum = [...out.enum, null];
  }

  const objectLike = "properties" in out || "$ref" in out || COMPOSITION.some((keyword) => keyword in out);
  if (
    !branch &&
    objectLike &&
    !("additionalProperties" in out) &&
    !("unevaluatedProperties" in out)
  ) {
    out.unevaluatedProperties = false;
  }
  return out;
}

/**
 * Replace the schema at `pick.path` (property names and `items`, from the
 * response root) by its `oneOf[pick.oneOf]` branch. Used where a response
 * is a union of views and the fixture is written for exactly one of them
 * (the blog posts list: summary or full). Throws when the path or branch is
 * not there, so a spec change cannot silently turn the pick into a no-op.
 */
function pickBranch(schema, pick) {
  const copy = structuredClone(schema);
  let holder = null;
  let key = null;
  let node = copy;
  for (const step of pick.path) {
    holder = node;
    key = step;
    node = node?.[step];
  }
  const branch = node?.oneOf?.[pick.oneOf];
  if (!branch || holder === null) {
    throw new Error(`pick ${JSON.stringify(pick)} does not resolve to a oneOf branch`);
  }
  holder[key] = branch;
  return copy;
}

/** Look up `paths[path][method].responses[status]`'s JSON schema; null if absent. */
export function findResponseSchema(bundle, path, method, status) {
  const response = bundle.paths?.[path]?.[method]?.responses?.[String(status)];
  return response?.content?.["application/json"]?.schema ?? null;
}

/**
 * Build a validator over the bundle. `has` says whether the operation has a
 * JSON response schema at that status; `validate(path, method, status, body)`
 * returns `{ errors }` (Ajv errors, empty when valid) and throws when the
 * operation or its schema is missing.
 */
export function createValidator(bundle) {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  ajv.addSchema({
    $id: "bundle",
    components: {
      schemas: Object.fromEntries(
        Object.entries(bundle.components?.schemas ?? {}).map(([name, schema]) => [
          name,
          normalise(schema, true)
        ])
      )
    }
  });

  const compiled = new Map();
  return {
    has: (path, method, status) => findResponseSchema(bundle, path, method, status) !== null,
    validate(path, method, status, body, pick) {
      const key = `${method} ${path} ${status} ${JSON.stringify(pick ?? null)}`;
      let fn = compiled.get(key);
      if (!fn) {
        let schema = findResponseSchema(bundle, path, method, status);
        if (!schema) throw new Error(`no response schema for ${method.toUpperCase()} ${path} ${status}`);
        if (pick) schema = pickBranch(schema, pick);
        fn = ajv.compile(normalise(schema, false));
        compiled.set(key, fn);
      }
      fn(body);
      return { errors: fn.errors ? [...fn.errors] : [] };
    }
  };
}

/** The value of an Ajv error's offending member name, whichever keyword carried it. */
function errorProperty(error) {
  const p = error.params ?? {};
  return p.missingProperty ?? p.unevaluatedProperty ?? p.additionalProperty ?? null;
}

function matches(rule, error) {
  return (
    error.keyword === rule.keyword &&
    new RegExp(rule.instancePath).test(error.instancePath) &&
    (rule.property === undefined || rule.property === errorProperty(error))
  );
}

/**
 * Judge one mapped fixture. Returns `{ problems }`, a list of human-readable
 * failures (empty when the fixture is acceptable). Rules, in order:
 *
 * - `not-a-response` entries carry no operation and need a reason.
 * - every other entry's operation must exist in the bundle with a JSON
 *   schema (a mapped operation missing from the bundle fails);
 * - an `omittedRequired` rule (subset fixtures) forgives a `required` error
 *   for a named property only, and must hit at least once;
 * - every remaining error must match a recorded exception of that fixture,
 *   and every exception rule must match at least once (so fixing the
 *   fixture forces the exception to be deleted);
 * - an exception past its `reviewBy` date fails.
 *
 * `today` is an ISO date string, injectable for tests.
 */
export function evaluateEntry(entry, validator, readJson, exceptions, today) {
  const problems = [];
  const label = entry.file;
  const own = exceptions.filter((exception) => exception.fixture === entry.file);

  if (!entry.reason || entry.reason.trim().length < 20) {
    problems.push(`${label}: every mapping needs a reason of at least 20 characters`);
  }
  if (entry.kind === "not-a-response") {
    if (entry.op) problems.push(`${label}: a not-a-response entry must not name an operation`);
    if (own.length) problems.push(`${label}: a not-a-response entry cannot carry exceptions`);
    return { problems };
  }
  if (!entry.op) {
    problems.push(`${label}: kind ${entry.kind} needs an operation`);
    return { problems };
  }
  const { path, method, status } = entry.op;
  if (!validator.has(path, method, status)) {
    problems.push(`${label}: ${method.toUpperCase()} ${path} ${status} is not in the OpenAPI bundle (or has no JSON schema)`);
    return { problems };
  }
  if (entry.kind === "subset" && !(entry.omittedRequired?.length > 0)) {
    problems.push(`${label}: a subset fixture must list the required fields it omits`);
  }
  if (entry.kind !== "subset" && entry.omittedRequired?.length) {
    problems.push(`${label}: omittedRequired is only allowed on a subset fixture`);
  }

  const omit = new Map((entry.omittedRequired ?? []).map((item) => [item.property, { ...item, hits: 0 }]));
  const ruleHits = new Map();
  let remaining = [];
  for (const { body, label: bodyLabel } of entry.bodies(readJson(entry.file))) {
    const { errors } = validator.validate(path, method, status, body, entry.pick);
    for (const error of errors) {
      const forgiven = error.keyword === "required" ? omit.get(errorProperty(error)) : undefined;
      if (forgiven) {
        forgiven.hits += 1;
        continue;
      }
      let covered = false;
      for (const exception of own) {
        for (const [index, rule] of exception.matches.entries()) {
          if (matches(rule, error)) {
            covered = true;
            const key = `${exception.id}#${index}`;
            ruleHits.set(key, (ruleHits.get(key) ?? 0) + 1);
          }
        }
      }
      if (!covered) {
        remaining.push(
          `${label}${bodyLabel ? ` [${bodyLabel}]` : ""}: ${error.keyword} at ${error.instancePath || "/"} ${JSON.stringify(error.params)}`
        );
      }
    }
  }
  problems.push(...[...new Set(remaining)].slice(0, 15));
  if (remaining.length > 15) problems.push(`${label}: ... and more`);

  for (const item of omit.values()) {
    if (!item.reason || item.reason.trim().length < 10) {
      problems.push(`${label}: omittedRequired ${item.property} needs a reason`);
    }
    if (item.hits === 0) {
      problems.push(`${label}: omittedRequired ${item.property} no longer matches anything - delete it`);
    }
  }
  for (const exception of own) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(exception.reviewBy)) {
      problems.push(`${label}: exception ${exception.id} needs an ISO reviewBy date`);
    } else if (exception.reviewBy < today) {
      problems.push(`${label}: exception ${exception.id} passed its review date ${exception.reviewBy}; fix it (${exception.issue}) or renew with a new reason`);
    }
    if (!exception.issue || !exception.reason) {
      problems.push(`${label}: exception ${exception.id} needs an issue and a reason`);
    }
    exception.matches.forEach((rule, index) => {
      if (!ruleHits.get(`${exception.id}#${index}`)) {
        problems.push(
          `${label}: exception ${exception.id} rule ${index} (${rule.keyword} ${rule.instancePath}${rule.property ? " " + rule.property : ""}) matches nothing any more - delete it (${exception.issue})`
        );
      }
    });
  }
  return { problems };
}
