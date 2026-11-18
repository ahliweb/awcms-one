/**
 * The campaign dispatcher enqueues its e-mail as `awcms_worker`, whose INSERT on
 * `awcms_email_messages` is column-scoped (`sql/302`, kept narrow by
 * `sql/1033`). Upstream's `enqueueDirectAddressEmail` writes the `purpose`
 * column, which the grant deliberately lacks, so the campaign path uses the worker-role
 * twin (`email/application/direct-address-worker-enqueue.ts`).
 *
 * DB-free: it holds the INSERT's column list to the worker's grant, holds the
 * default of `purpose` to the category's real purpose, and holds the dispatcher
 * to the worker-safe function. What it does not run is PostgreSQL (the
 * DATABASE_URL-gated `commerce-campaigns.integration.test.ts` does, as the real
 * `awcms_worker`).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { purposeForEmailCategory } from "../src/modules/email/domain/email-sender";
import { CAMPAIGN_EMAIL_TEMPLATE_KEY } from "../src/modules/commerce/domain/email-template-categories";

const CMS_ROOT = path.resolve(import.meta.dir, "..");
const read = (relative: string) =>
  readFileSync(path.join(CMS_ROOT, relative), "utf8");

function columnsOfInsert(source: string): string[] {
  const match = /INSERT\s+INTO\s+awcms_email_messages\s*\(([^)]*)\)/i.exec(
    source
  );

  return match
    ? match[1]!
        .split(",")
        .map((column) => column.trim())
        .filter(Boolean)
    : [];
}

describe("the campaign e-mail enqueue stays inside the worker's column grant", () => {
  const insertColumns = columnsOfInsert(
    read("src/modules/email/application/direct-address-worker-enqueue.ts")
  );
  const grant =
    /GRANT\s+INSERT\s*\(([^)]*)\)\s+ON\s+awcms_email_messages\s+TO\s+awcms_worker/i.exec(
      read("sql/302_awcms_hr_attendance_notice_worker_grants.sql")
    );
  const granted = grant
    ? grant[1]!
        .split(",")
        .map((column) => column.trim())
        .filter(Boolean)
    : [];

  test("the scan finds both lists (not vacuous)", () => {
    expect(granted.length).toBe(10);
    expect(insertColumns.length).toBeGreaterThan(0);
  });

  test("every column it writes is a column the worker may insert, and `purpose` is not one of them", () => {
    for (const column of insertColumns) {
      expect(granted, column).toContain(column);
    }
    expect(insertColumns).not.toContain("purpose");
    expect(granted).not.toContain("purpose");
  });

  test("the category's purpose is the column default, `transactional`", () => {
    expect(purposeForEmailCategory(CAMPAIGN_EMAIL_TEMPLATE_KEY)).toBe(
      "transactional"
    );
    expect(read("sql/346_awcms_email_sender_routing.sql")).toMatch(
      /ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'transactional'/
    );
  });

  test("the dispatcher uses it, not the request-path function that writes `purpose`", () => {
    const dispatch = read(
      "src/modules/commerce/application/campaign-dispatch.ts"
    );

    expect(dispatch).toContain("enqueueWorkerDirectAddressEmail");
    expect(dispatch).not.toContain("enqueueDirectAddressEmail");
  });
});
