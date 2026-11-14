/**
 * Pure rules of a shopper's data-subject request (Issue #529, ADR-0055): the
 * refusal vocabulary, the sentinels, the key and code shapes and the maker /
 * checker rule. The database-backed behaviour is
 * `tests/integration/commerce-customer-subject.integration.test.ts`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  OPEN_ORDER_STATUSES,
  SUBJECT_OTP_PURPOSES,
  SUBJECT_REFUSAL_CODES,
  SUBJECT_REFUSAL_MESSAGES,
  erasedCustomerName,
  erasedEmail,
  erasedPhone,
  erasedText,
  isErasedSentinel,
  isSeparateChecker,
  isWellFormedSubjectOtpCode,
  normaliseSubjectReason,
  validateSubjectIdempotencyKey
} from "../src/modules/commerce/domain/customer-subject-policy";
import { erasureRefusedResponse } from "../src/modules/commerce/application/customer-subject-http";
import { COMMERCE_CUSTOMER_SUBJECT_REQUEST_PERMISSIONS } from "../src/modules/commerce/domain/customer-subject-permissions";
import { commerceModule } from "../src/modules/commerce/module";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("refusals", () => {
  test("every code has a message and the set is closed", () => {
    expect(SUBJECT_REFUSAL_CODES.length).toBe(6);
    for (const code of SUBJECT_REFUSAL_CODES) {
      expect(SUBJECT_REFUSAL_MESSAGES[code].length).toBeGreaterThan(10);
    }
    expect(Object.keys(SUBJECT_REFUSAL_MESSAGES).sort()).toEqual(
      [...SUBJECT_REFUSAL_CODES].sort()
    );
  });

  test("the open order statuses are exactly the in-flight ones of the order schema", () => {
    expect([...OPEN_ORDER_STATUSES]).toEqual([
      "pending_payment",
      "paid",
      "processing",
      "shipped"
    ]);
  });

  test("a refusal answers 409 with every code in details", async () => {
    const response = erasureRefusedResponse(["OPEN_ORDER", "PENDING_REFUND"]);
    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: {
        code: string;
        details: { refusals: { code: string; message: string }[] };
      };
    };
    expect(body.error.code).toBe("ERASURE_REFUSED");
    expect(body.error.details.refusals.map((r) => r.code)).toEqual([
      "OPEN_ORDER",
      "PENDING_REFUND"
    ]);
  });
});

describe("sentinels", () => {
  test("they are unique per row, recognisable and never a deliverable address", () => {
    expect(erasedPhone(A)).not.toBe(erasedPhone(B));
    expect(erasedEmail(A)).not.toBe(erasedEmail(B));
    expect(erasedEmail(A).endsWith("@erased.invalid")).toBe(true);
    for (const value of [
      erasedPhone(A),
      erasedEmail(A),
      erasedCustomerName(),
      erasedText()
    ]) {
      expect(isErasedSentinel(value)).toBe(true);
    }
    expect(isErasedSentinel("+628123456789")).toBe(false);
    expect(isErasedSentinel(null)).toBe(false);
  });
});

describe("request shapes", () => {
  test("the idempotency key shares the storefront key shape", () => {
    expect(validateSubjectIdempotencyKey(null)).not.toBeNull();
    expect(validateSubjectIdempotencyKey("short")).not.toBeNull();
    expect(
      validateSubjectIdempotencyKey("a b c d e f g h i j k l")
    ).not.toBeNull();
    expect(validateSubjectIdempotencyKey(crypto.randomUUID())).toBeNull();
    expect(validateSubjectIdempotencyKey("A".repeat(16))).toBeNull();
  });

  test("the code is six digits", () => {
    expect(isWellFormedSubjectOtpCode("012345")).toBe(true);
    expect(isWellFormedSubjectOtpCode("12345")).toBe(false);
    expect(isWellFormedSubjectOtpCode("12345a")).toBe(false);
    expect(isWellFormedSubjectOtpCode(123456)).toBe(false);
  });

  test("a reason is optional, trimmed and bounded", () => {
    expect(normaliseSubjectReason(undefined)).toEqual({
      ok: true,
      value: null
    });
    expect(normaliseSubjectReason("   ")).toEqual({ ok: true, value: null });
    expect(normaliseSubjectReason("  asked by phone ")).toEqual({
      ok: true,
      value: "asked by phone"
    });
    expect(normaliseSubjectReason("x".repeat(501)).ok).toBe(false);
    expect(normaliseSubjectReason(5).ok).toBe(false);
  });

  test("a login code can never authorise a request, and the reverse", () => {
    expect(SUBJECT_OTP_PURPOSES.export).toBe("subject_export");
    expect(SUBJECT_OTP_PURPOSES.erasure).toBe("subject_erasure");
    expect(SUBJECT_OTP_PURPOSES.export).not.toBe(SUBJECT_OTP_PURPOSES.erasure);
    const migration = readFileSync(
      path.resolve(
        import.meta.dir,
        "../sql/1066_awcms_commerce_customer_erasure_marker.sql"
      ),
      "utf8"
    );
    expect(migration).toContain("'subject_export'");
    expect(migration).toContain("'subject_erasure'");
  });
});

describe("maker and checker", () => {
  test("the checker must be someone else; a shopper's own request has no maker", () => {
    expect(isSeparateChecker(A, A)).toBe(false);
    expect(isSeparateChecker(A, B)).toBe(true);
    expect(isSeparateChecker(null, A)).toBe(true);
  });
});

describe("permissions", () => {
  test("the four keys are declared by the module and use existing high-risk verbs", () => {
    const declared = new Set(
      (commerceModule.permissions ?? []).map(
        (p) => `commerce.${p.activityCode}.${p.action}`
      )
    );
    for (const key of Object.values(
      COMMERCE_CUSTOMER_SUBJECT_REQUEST_PERMISSIONS
    )) {
      expect(declared.has(key)).toBe(true);
    }
  });

  test("the migration seeds exactly the declared keys", () => {
    const sql = readFileSync(
      path.resolve(
        import.meta.dir,
        "../sql/1067_awcms_commerce_customer_subject_permissions.sql"
      ),
      "utf8"
    );
    for (const action of ["read", "export", "delete", "approve"]) {
      expect(sql).toContain(`'customer_subject_requests', '${action}'`);
    }
  });
});

describe("the migration", () => {
  const sql = readFileSync(
    path.resolve(
      import.meta.dir,
      "../sql/1065_awcms_commerce_customer_subject_requests.sql"
    ),
    "utf8"
  );
  test("is tenant-isolated, append-only and checks maker against checker", () => {
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("maker_checker_check");
    expect(sql).toContain("SET search_path = pg_catalog, public, pg_temp");
    expect(sql).toContain("REVOKE DELETE, TRUNCATE");
    expect(sql).toMatch(/FOREIGN KEY \(tenant_id, customer_id\)/);
  });
});
