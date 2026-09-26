/**
 * The evidence-redaction helper (`tools/ci/lib/redact.ts`) — a thin
 * re-export of the shared root redactor, `packages/gerbang/lib/redact.mjs`
 * (`redactText`), which masks tokens and DSN passwords before local-ci
 * logs/evidence hit disk. This file exercises the re-export's own contract
 * (it forwards to the shared helper unchanged); `tests/redact.test.mjs`
 * (packages/gerbang) is the authoritative test of the redaction patterns
 * themselves.
 *
 * Every fixture "secret" below is assembled at runtime from harmless parts
 * rather than written as a token-shaped literal — a literal that merely
 * LOOKS like a real credential still trips secret-scanning on this
 * repository (GitGuardian), even inside a test fixture.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { redact } from "../tools/ci/lib/redact.ts";
import { redactText } from "../packages/gerbang/lib/redact.mjs";

const fakeDsnPassword = ["fake", "dsn", "value", "42"].join("");
const fakeBearerValue = ["abcdef", "0123456789", "ABCDEF"].join("");
const fakeGithubToken = ["ghp_", "abcdefghijklmnopqrstuvwxyz", "0123456789"].join("");

describe("tools/ci/lib/redact.ts", () => {
  test("is a thin forward to packages/gerbang/lib/redact.mjs's redactText, not a second implementation", () => {
    const sample = `connecting to postgres://awcms:${fakeDsnPassword}@127.0.0.1:5433/awcms\nAuthorization: Bearer ${fakeBearerValue}`;
    assert.equal(redact(sample), redactText(sample));
  });

  test("masks a DSN password but keeps the rest of the connection string readable", () => {
    const out = redact(`connecting to postgres://awcms:${fakeDsnPassword}@127.0.0.1:5433/awcms now`);
    assert.ok(!out.includes(fakeDsnPassword));
    assert.match(out, /postgres:\/\/awcms:.*@127\.0\.0\.1:5433\/awcms/);
  });

  test("masks a bearer token but keeps the header name", () => {
    const out = redact(`Authorization: Bearer ${fakeBearerValue}`);
    assert.ok(!out.includes(fakeBearerValue));
    assert.match(out, /Bearer/);
  });

  test("masks a token=/key=/secret= assignment, GitHub token shape included", () => {
    const out = redact(`token=${fakeGithubToken}`);
    assert.ok(!out.includes(fakeGithubToken));
  });

  test("does not touch ordinary log text", () => {
    const text = "bun install --frozen-lockfile\n42 pass, 0 fail";
    assert.equal(redact(text), text);
  });
});
