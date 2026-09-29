/**
 * `practice_irm` domain-content directory integration (Issue #270) —
 * exercised against a REAL migrated database (`tests/integration/harness.ts`),
 * the same pattern `commerce-entitlement-directory.integration.test.ts`
 * already established. Gated on `DATABASE_URL`; skips cleanly without one.
 *
 * Covers the properties only a real database can prove:
 *
 *   - a domain key with no live row falls back to the built-in default, and
 *     `listPracticeIrmDomains` always returns exactly five entries;
 *   - `createPracticeIrmDomain` inserts, and refuses a second create while a
 *     live row exists (`ALREADY_EXISTS`);
 *   - `updatePracticeIrmDomain` edits an existing live row and refuses
 *     `not_found` for one that does not exist yet;
 *   - `deletePracticeIrmDomain` resets — the row is no longer "live", and the
 *     very next read falls back to the built-in default, never blank;
 *   - RLS: tenant B cannot see tenant A's domain row even with the right id.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import { withTenantOrThrow } from "../../src/lib/database/tenant-context";
import {
  createPracticeIrmDomain,
  deletePracticeIrmDomain,
  getPracticeIrmDomain,
  listPracticeIrmDomains,
  updatePracticeIrmDomain
} from "../../src/modules/practice-irm/application/practice-irm-domain-directory";
import { DEFAULT_PRACTICE_IRM_DOMAIN_CONTENT } from "../../src/modules/practice-irm/domain/practice-irm-domain-content";
import {
  getAdminSql,
  getRuntimeSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const ACTOR = "33333333-3333-3333-3333-333333333333";

function inTenant<T>(
  tenantId: string,
  fn: (tx: Bun.SQL) => Promise<T>
): Promise<T> {
  return withTenantOrThrow(getRuntimeSql(), tenantId, fn);
}

async function seedTenant(id: string, code: string): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${code + " Name"}, ${code + " Legal"}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

suite("practice-irm domain-content directory integration (Issue #270)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "TENA");
    await seedTenant(TENANT_B, "TENB");
  });

  test("listPracticeIrmDomains always returns exactly five entries, falling back to the built-in default when no live row exists", async () => {
    const domains = await inTenant(TENANT_A, (tx) =>
      listPracticeIrmDomains(tx, TENANT_A)
    );

    expect(domains.length).toBe(5);
    for (const domain of domains) {
      const fallback = DEFAULT_PRACTICE_IRM_DOMAIN_CONTENT[domain.domainKey];
      expect(domain.name).toBe(fallback.name);
      expect(domain.id.startsWith("default:")).toBe(true);
    }
  });

  test("createPracticeIrmDomain inserts a live row, and a second create for the same key is ALREADY_EXISTS", async () => {
    const created = await inTenant(TENANT_A, (tx) =>
      createPracticeIrmDomain(tx, TENANT_A, ACTOR, {
        domainKey: "identify",
        name: "Custom Identify",
        description: "Custom description",
        copy: "Custom copy",
        displayOrder: 1
      })
    );
    expect(created.kind).toBe("created");

    const fetched = await inTenant(TENANT_A, (tx) =>
      getPracticeIrmDomain(tx, TENANT_A, "identify")
    );
    expect(fetched.name).toBe("Custom Identify");
    expect(fetched.id.startsWith("default:")).toBe(false);

    const secondCreate = await inTenant(TENANT_A, (tx) =>
      createPracticeIrmDomain(tx, TENANT_A, ACTOR, {
        domainKey: "identify",
        name: "Another",
        description: "Another",
        copy: "Another",
        displayOrder: 1
      })
    );
    expect(secondCreate.kind).toBe("already_exists");
  });

  test("updatePracticeIrmDomain edits a live row, and is not_found for a key with no live row yet", async () => {
    await inTenant(TENANT_A, (tx) =>
      createPracticeIrmDomain(tx, TENANT_A, ACTOR, {
        domainKey: "neutralize",
        name: "Neutralize",
        description: "d",
        copy: "c",
        displayOrder: 2
      })
    );

    const updated = await inTenant(TENANT_A, (tx) =>
      updatePracticeIrmDomain(tx, TENANT_A, ACTOR, "neutralize", {
        copy: "Updated copy"
      })
    );
    expect(updated.kind).toBe("updated");
    if (updated.kind === "updated") {
      expect(updated.domain.copy).toBe("Updated copy");
      // Fields not passed keep their current value.
      expect(updated.domain.name).toBe("Neutralize");
    }

    const notFound = await inTenant(TENANT_A, (tx) =>
      updatePracticeIrmDomain(tx, TENANT_A, ACTOR, "navigate", { copy: "x" })
    );
    expect(notFound.kind).toBe("not_found");
  });

  test("deletePracticeIrmDomain resets to the built-in default rather than leaving the domain blank", async () => {
    await inTenant(TENANT_A, (tx) =>
      createPracticeIrmDomain(tx, TENANT_A, ACTOR, {
        domainKey: "embed",
        name: "Custom Embed",
        description: "d",
        copy: "c",
        displayOrder: 4
      })
    );

    const deleted = await inTenant(TENANT_A, (tx) =>
      deletePracticeIrmDomain(tx, TENANT_A, ACTOR, "embed")
    );
    expect(deleted.kind).toBe("deleted");

    const afterReset = await inTenant(TENANT_A, (tx) =>
      getPracticeIrmDomain(tx, TENANT_A, "embed")
    );
    expect(afterReset.name).toBe(
      DEFAULT_PRACTICE_IRM_DOMAIN_CONTENT.embed.name
    );
    expect(afterReset.id.startsWith("default:")).toBe(true);

    const secondDelete = await inTenant(TENANT_A, (tx) =>
      deletePracticeIrmDomain(tx, TENANT_A, ACTOR, "embed")
    );
    expect(secondDelete.kind).toBe("not_found");
  });

  test("RLS: tenant B cannot see tenant A's domain row even with the right id", async () => {
    const created = await inTenant(TENANT_A, (tx) =>
      createPracticeIrmDomain(tx, TENANT_A, ACTOR, {
        domainKey: "reinforce",
        name: "Custom Reinforce",
        description: "d",
        copy: "c",
        displayOrder: 5
      })
    );
    expect(created.kind).toBe("created");
    if (created.kind !== "created") return;

    const crossTenantRead = (await inTenant(
      TENANT_B,
      (tx) =>
        tx`SELECT id FROM awcms_practice_irm_domains WHERE id = ${created.domain.id}`
    )) as { id: string }[];
    expect(crossTenantRead.length).toBe(0);

    // Tenant B's own read still gets the built-in default for the same key —
    // proof the two tenants' content is genuinely independent.
    const tenantBView = await inTenant(TENANT_B, (tx) =>
      getPracticeIrmDomain(tx, TENANT_B, "reinforce")
    );
    expect(tenantBView.id.startsWith("default:")).toBe(true);
  });
});
