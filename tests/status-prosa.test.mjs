/**
 * Regression guard for issue #148 — `SECURITY.md`/`SECURITY.id.md` once
 * claimed, under "What is NOT yet true", that customer accounts/sessions do
 * not exist and that there is no session/login attack surface. That was
 * true when written, and stayed in the file long after increment 4
 * (epic #32, ADR-0016) shipped OTP-verified customer accounts and bearer
 * sessions — a stale security-policy claim is worse than a missing one,
 * because it actively tells a reviewer a surface they should be checking
 * does not exist.
 *
 * This test does not re-derive the current feature state from code (that is
 * `apps/cms`'s own job); it only pins the two facts a stale rewrite could
 * silently undo: the retired phrases stay retired, and the security policy
 * still names the concrete surface (the bearer-session table, the
 * `Authorization: Bearer` scheme, the webhook route family) it replaced them
 * with.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const EN = readFileSync("SECURITY.md", "utf8");
const ID = readFileSync("SECURITY.id.md", "utf8");

/** Phrases that used to assert customer accounts/sessions do not exist — none may return. */
const STALE_EN_PHRASES = [
  "Customer accounts do not exist",
  "no session/login attack surface",
  "there is no session/login attack surface yet"
];

/** The Indonesian mirror's own wording of the same retired claim. */
const STALE_ID_PHRASES = ["Akun pelanggan belum ada", "belum ada permukaan serangan sesi/login"];

describe("SECURITY.md — the retired 'no customer accounts' claim never returns", () => {
  test("no stale English phrase is present", () => {
    for (const phrase of STALE_EN_PHRASES) {
      assert.ok(
        !EN.includes(phrase),
        `SECURITY.md contains the retired phrase "${phrase}" — customer accounts/OTP/bearer sessions have existed since epic #32 (ADR-0016); see docs/adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md.`
      );
    }
  });

  test("names the bearer-session surface concretely", () => {
    for (const needle of ["Authorization: Bearer", "awcms_commerce_customer_sessions"]) {
      assert.ok(
        EN.includes(needle),
        `SECURITY.md no longer names "${needle}" — the authenticated customer surface must be described concretely, not just asserted to exist.`
      );
    }
  });

  test("names the webhook route family", () => {
    assert.ok(
      EN.includes("/api/v1/commerce/webhooks/{provider}/{endpointToken}"),
      "SECURITY.md no longer names the token-addressed webhook route family (ADR-0017)."
    );
  });
});

describe("SECURITY.id.md — the Indonesian mirror stays in sync", () => {
  test("no stale Indonesian phrase is present", () => {
    for (const phrase of STALE_ID_PHRASES) {
      assert.ok(
        !ID.includes(phrase),
        `SECURITY.id.md contains the retired phrase "${phrase}" — this must track SECURITY.md's own reconciliation.`
      );
    }
  });

  test("names the bearer-session surface concretely", () => {
    for (const needle of ["Authorization: Bearer", "awcms_commerce_customer_sessions"]) {
      assert.ok(
        ID.includes(needle),
        `SECURITY.id.md no longer names "${needle}".`
      );
    }
  });

  test("names the webhook route family", () => {
    assert.ok(
      ID.includes("/api/v1/commerce/webhooks/{provider}/{endpointToken}"),
      "SECURITY.id.md no longer names the token-addressed webhook route family (ADR-0017)."
    );
  });
});
