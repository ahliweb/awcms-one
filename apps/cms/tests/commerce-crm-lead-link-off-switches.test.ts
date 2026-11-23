/**
 * The CRM lead link routes honour `crm_leads`' deployment flag and its
 * accountable-person rule through `crmLeadsMutationRefusal` (Issue #463,
 * ADR-0056 D6). The tenant switch needs a database and is covered by
 * `tests/integration/commerce-crm-lead-link.integration.test.ts`; both routes
 * must call the helper, which is pinned statically here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { crmLeadsMutationRefusal } from "../src/lib/composition/crm-lead-port";

const saved = process.env.CRM_LEADS_ENABLED;
afterEach(() => {
  if (saved === undefined) delete process.env.CRM_LEADS_ENABLED;
  else process.env.CRM_LEADS_ENABLED = saved;
});

const person = { context: { tenantUserId: "u" } };
const machine = { context: { tenantUserId: "u", viaMachineCredential: true } };
const noDatabase = {} as Bun.SQL;

describe("crmLeadsMutationRefusal", () => {
  test("a deployment with the flag off answers 503 CRM_LEADS_DISABLED", async () => {
    process.env.CRM_LEADS_ENABLED = "false";
    const res = await crmLeadsMutationRefusal(noDatabase, "t", person);
    expect(res?.status).toBe(503);
    expect(((await res!.json()) as any).error.code).toBe("CRM_LEADS_DISABLED");
  });

  test("a machine credential answers 403 INTERACTIVE_SESSION_REQUIRED", async () => {
    process.env.CRM_LEADS_ENABLED = "true";
    const res = await crmLeadsMutationRefusal(noDatabase, "t", machine);
    expect(res?.status).toBe(403);
    expect(((await res!.json()) as any).error.code).toBe(
      "INTERACTIVE_SESSION_REQUIRED"
    );
  });

  test("both CRM lead link mutation routes call it", () => {
    for (const file of [
      "src/pages/api/v1/commerce/crm-lead-links/index.ts",
      "src/pages/api/v1/commerce/crm-lead-links/[id]/reverse.ts"
    ]) {
      expect(readFileSync(file, "utf8")).toContain("crmLeadsMutationRefusal(");
    }
  });
});
