import { describe, expect, test } from "bun:test";
import { redactLine, redactText } from "../packages/gerbang/lib/redact.mjs";

describe("packages/gerbang/lib/redact.mjs", () => {
  test("masks a DSN's password, keeping the scheme/user/host visible", () => {
    const line = "connecting to postgres://awcms_setup:sUp3rS3cr3tPassw0rd@db.internal:5432/awcms";
    const out = redactLine(line);
    expect(out).not.toContain("sUp3rS3cr3tPassw0rd");
    expect(out).toContain("postgres://awcms_setup:***REDACTED***@db.internal:5432/awcms");
  });

  test("masks a Bearer token", () => {
    const line = 'Authorization header: "Bearer abcdEFGH12345678ijklmnop"';
    const out = redactLine(line);
    expect(out).not.toContain("abcdEFGH12345678ijklmnop");
    expect(out).toContain("Bearer ***REDACTED***");
  });

  test("masks a token=/secret=/key= assignment", () => {
    // Assembled at runtime: a literal token-shaped fixture reads to secret
    // scanners (GitGuardian) as a leaked credential. It is not one.
    const fake = ["fake", "0000", "test", "0000", "value"].join("");
    expect(redactLine(`api_key=${fake}`)).not.toContain(fake);
    expect(redactLine(`secret: ${fake}`)).not.toContain(fake);
  });

  test("redacts a whole env-assignment line whose name matches the secret heuristic", () => {
    expect(redactLine("DATABASE_URL=postgres://u:p@host/db")).toBe("DATABASE_URL=***REDACTED***");
    expect(redactLine("COMMERCE_MIDTRANS_SERVER_KEY=verysecretvalue")).toBe(
      "COMMERCE_MIDTRANS_SERVER_KEY=***REDACTED***"
    );
  });

  test("leaves a benign value unchanged", () => {
    expect(redactLine("SITE_PROFILE=toko")).toBe("SITE_PROFILE=toko");
    expect(redactLine("cms is healthy at https://cms.example.test/api/v1/health")).toBe(
      "cms is healthy at https://cms.example.test/api/v1/health"
    );
    expect(redactLine("role awcms_app: rolsuper=f rolbypassrls=f")).toBe(
      "role awcms_app: rolsuper=f rolbypassrls=f"
    );
  });

  test("redactText applies line by line", () => {
    const text = "line one\nDATABASE_URL=postgres://u:p@host/db\nline three";
    const out = redactText(text);
    expect(out).toBe("line one\nDATABASE_URL=***REDACTED***\nline three");
  });
});
