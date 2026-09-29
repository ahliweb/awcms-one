/**
 * Issue #268 (IRMbyDUS) — `GET /api/v1/media/objects/{id}/download-url`, the
 * STAFF/ABAC-gated half of the private-object issuance flow, against a real
 * PostgreSQL and the REAL route handler (not a mocked `authorizeInTransaction`
 * — the actual chokepoint and the actual `awcms_role_permissions` grants).
 *
 * Covers this issue's own acceptance criteria for the staff side:
 * - `media_library.media.download` gates the route (ABAC, the existing
 *   evaluator) — a caller without it is denied, never merely warned.
 * - Works for BOTH visibility classes (a private object is exactly the point;
 *   a public object may also be issued a signed URL, it simply has no need
 *   to).
 * - Every issuance is audited (`media.download`).
 *
 * WORLD-2 (harness.ts) — skipped unless `DATABASE_URL` is configured.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import {
  ensureHandlerDatabaseReady,
  getHandlerAdminSql,
  integrationEnabled,
  invoke,
  resetHandlerDatabase,
  teardownHandlerDatabase
} from "./harness";
import { GET as downloadUrlGet } from "../../src/pages/api/v1/media/objects/[id]/download-url";
import {
  generateSessionToken,
  hashSessionToken
} from "../../src/lib/auth/session-token";
import { grantRolePolicy } from "../../src/modules/identity-access/application/access-policy-writer";
import { NEWS_MEDIA_R2_MAX_PRESIGNED_DOWNLOAD_TTL_SECONDS } from "../../src/modules/media-library/domain/media-r2-config";

const TENANT = "26826826-2682-4682-8682-268268268001";
const TENANT_CODE = "media-dl-268";

const PUBLIC_OBJECT_ID = "26826826-0000-4682-8682-268268268010";
const PRIVATE_OBJECT_ID = "26826826-0000-4682-8682-268268268011";
const PENDING_OBJECT_ID = "26826826-0000-4682-8682-268268268012";

const DOWNLOADER = {
  profileId: "26826826-0000-4682-8682-268268268100",
  tenantUserId: "26826826-0000-4682-8682-268268268101",
  identityId: "26826826-0000-4682-8682-268268268102",
  roleId: "26826826-0000-4682-8682-268268268103",
  loginIdentifier: "downloader-268@example.test"
};
const NO_PERMISSION = {
  profileId: "26826826-0000-4682-8682-268268268200",
  tenantUserId: "26826826-0000-4682-8682-268268268201",
  identityId: "26826826-0000-4682-8682-268268268202",
  roleId: "26826826-0000-4682-8682-268268268203",
  loginIdentifier: "bystander-268@example.test"
};

let handlerReady = false;
const sessionTokens = new Map<string, string>();

/** The route reads `resolveNewsMediaR2Config()` straight off `process.env` — set the minimum required-when-enabled set (`media-r2-config.ts`'s own `NEWS_MEDIA_R2_REQUIRED_WHEN_ENABLED`) so the 502 "not configured" refusal never masks the behavior under test. */
const R2_ENV: Record<string, string> = {
  NEWS_MEDIA_R2_ENABLED: "true",
  NEWS_MEDIA_R2_ACCOUNT_ID: "test-account-268",
  NEWS_MEDIA_R2_ACCESS_KEY_ID: "test-key-268",
  NEWS_MEDIA_R2_SECRET_ACCESS_KEY: "test-secret-268",
  NEWS_MEDIA_R2_BUCKET: "test-bucket-268",
  NEWS_MEDIA_R2_PUBLIC_BASE_URL: "https://media.example.test"
};
const savedEnv: Record<string, string | undefined> = {};

async function seedPersona(
  persona: {
    profileId: string;
    tenantUserId: string;
    identityId: string;
    roleId: string;
    loginIdentifier: string;
  },
  roleName: string,
  actions: readonly string[]
): Promise<void> {
  const sql = getHandlerAdminSql();

  await sql`
    INSERT INTO awcms_profiles (id, tenant_id, profile_type, display_name)
    VALUES (${persona.profileId}, ${TENANT}, 'person', ${roleName})
  `;
  await sql`
    INSERT INTO awcms_identities
      (id, tenant_id, profile_id, login_identifier, password_hash, status)
    VALUES (${persona.identityId}, ${TENANT}, ${persona.profileId},
            ${persona.loginIdentifier}, 'not-a-real-hash', 'active')
  `;
  await sql`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id, status)
    VALUES (${persona.tenantUserId}, ${TENANT}, ${persona.identityId}, 'active')
  `;
  await sql`
    INSERT INTO awcms_roles (id, tenant_id, role_code, role_name, is_system)
    VALUES (${persona.roleId}, ${TENANT}, ${roleName}, ${roleName}, false)
  `;

  for (const action of actions) {
    await sql`
      INSERT INTO awcms_role_permissions (tenant_id, role_id, permission_id)
      SELECT ${TENANT}, ${persona.roleId}, p.id
      FROM awcms_permissions p
      WHERE p.module_key = 'media_library'
        AND p.activity_code = 'media'
        AND p.action = ${action}
    `;
  }

  await grantRolePolicy(sql, TENANT, {
    tenantUserId: persona.tenantUserId,
    roleId: persona.roleId,
    grantedByTenantUserId: null
  });

  const token = generateSessionToken();
  sessionTokens.set(persona.tenantUserId, token);

  await sql`
    INSERT INTO awcms_sessions (tenant_id, identity_id, token_hash, expires_at)
    VALUES (${TENANT}, ${persona.identityId}, ${hashSessionToken(token)},
            now() + interval '1 hour')
  `;
}

async function seed(): Promise<void> {
  const sql = getHandlerAdminSql();

  await sql`
    INSERT INTO awcms_tenants (id, tenant_code, tenant_name, status)
    VALUES (${TENANT}, ${TENANT_CODE}, 'Media Download 268', 'active')
  `;

  await seedPersona(DOWNLOADER, "downloader-268", ["download"]);
  await seedPersona(NO_PERMISSION, "bystander-268", ["read"]);

  const publicKey = `news-media/${TENANT}/2026/09/${PUBLIC_OBJECT_ID}.jpg`;
  await sql`
    INSERT INTO awcms_news_media_objects
      (id, tenant_id, bucket_name, object_key, public_url, visibility,
       mime_type, status, created_by_tenant_user_id)
    VALUES (
      ${PUBLIC_OBJECT_ID}, ${TENANT}, 'test-bucket', ${publicKey},
      ${`https://media.example.test/${publicKey}`}, 'public', 'image/jpeg',
      'verified', ${DOWNLOADER.tenantUserId}
    )
  `;

  const privateKey = `news-media/${TENANT}/2026/09/${PRIVATE_OBJECT_ID}.pdf`;
  await sql`
    INSERT INTO awcms_news_media_objects
      (id, tenant_id, bucket_name, object_key, public_url, visibility,
       mime_type, status, created_by_tenant_user_id)
    VALUES (
      ${PRIVATE_OBJECT_ID}, ${TENANT}, 'test-bucket', ${privateKey},
      NULL, 'private', 'application/pdf', 'verified', ${DOWNLOADER.tenantUserId}
    )
  `;

  const pendingKey = `news-media/${TENANT}/2026/09/${PENDING_OBJECT_ID}.jpg`;
  await sql`
    INSERT INTO awcms_news_media_objects
      (id, tenant_id, bucket_name, object_key, public_url, visibility,
       mime_type, status, created_by_tenant_user_id)
    VALUES (
      ${PENDING_OBJECT_ID}, ${TENANT}, 'test-bucket', ${pendingKey},
      ${`https://media.example.test/${pendingKey}`}, 'public', 'image/jpeg',
      'pending_upload', ${DOWNLOADER.tenantUserId}
    )
  `;
}

function headersFor(tenantUserId: string): Record<string, string> {
  return {
    "x-awcms-tenant-id": TENANT,
    authorization: `Bearer ${sessionTokens.get(tenantUserId)}`
  };
}

async function requestDownloadUrl(tenantUserId: string, objectId: string) {
  return invoke<{
    data?: { mediaObjectId: string; url: string; expiresAt: string };
    error?: { code: string; message: string };
  }>(downloadUrlGet, {
    method: "GET",
    path: `/api/v1/media/objects/${objectId}/download-url`,
    params: { id: objectId },
    headers: headersFor(tenantUserId)
  });
}

const describeOrSkip = integrationEnabled ? describe : describe.skip;

describeOrSkip(
  "Issue #268 — GET /api/v1/media/objects/{id}/download-url (staff/ABAC path)",
  () => {
    beforeAll(async () => {
      handlerReady = await ensureHandlerDatabaseReady();
      for (const [key, value] of Object.entries(R2_ENV)) {
        savedEnv[key] = process.env[key];
        process.env[key] = value;
      }
    });

    afterAll(async () => {
      if (handlerReady) await teardownHandlerDatabase();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    beforeEach(async () => {
      if (!handlerReady) return;
      await resetHandlerDatabase();
      sessionTokens.clear();
      await seed();
    });

    test("a caller WITHOUT media_library.media.download is denied (403), never a URL", async () => {
      if (!handlerReady) return;

      const result = await requestDownloadUrl(
        NO_PERMISSION.tenantUserId,
        PRIVATE_OBJECT_ID
      );

      expect(result.status).toBe(403);
      expect(result.body.data).toBeUndefined();
      expect(JSON.stringify(result.body)).not.toContain("http");
    });

    test("a caller WITH media_library.media.download gets a signed URL for a PRIVATE object", async () => {
      if (!handlerReady) return;

      const result = await requestDownloadUrl(
        DOWNLOADER.tenantUserId,
        PRIVATE_OBJECT_ID
      );

      expect(result.status).toBe(200);
      expect(result.body.data?.mediaObjectId).toBe(PRIVATE_OBJECT_ID);
      expect(result.body.data?.url).toContain("X-Amz-Expires=");
      expect(typeof result.body.data?.expiresAt).toBe("string");

      const url = new URL(result.body.data!.url);
      const expiresSeconds = Number(url.searchParams.get("X-Amz-Expires"));
      expect(expiresSeconds).toBeGreaterThan(0);
      expect(expiresSeconds).toBeLessThanOrEqual(
        NEWS_MEDIA_R2_MAX_PRESIGNED_DOWNLOAD_TTL_SECONDS
      );
    });

    test("the same permission also issues a signed URL for a PUBLIC object", async () => {
      if (!handlerReady) return;

      const result = await requestDownloadUrl(
        DOWNLOADER.tenantUserId,
        PUBLIC_OBJECT_ID
      );

      expect(result.status).toBe(200);
      expect(result.body.data?.mediaObjectId).toBe(PUBLIC_OBJECT_ID);
    });

    test("a not-yet-verified object answers 404, not a URL", async () => {
      if (!handlerReady) return;

      const result = await requestDownloadUrl(
        DOWNLOADER.tenantUserId,
        PENDING_OBJECT_ID
      );

      expect(result.status).toBe(404);
      expect(result.body.data).toBeUndefined();
    });

    test("an unknown id answers 404", async () => {
      if (!handlerReady) return;

      const result = await requestDownloadUrl(
        DOWNLOADER.tenantUserId,
        "00000000-0000-4000-8000-000000000000"
      );

      expect(result.status).toBe(404);
    });

    test("a successful issuance writes exactly one media.download audit row", async () => {
      if (!handlerReady) return;

      await requestDownloadUrl(DOWNLOADER.tenantUserId, PRIVATE_OBJECT_ID);

      const rows = (await getHandlerAdminSql()`
        SELECT action, resource_id, severity, attributes
        FROM awcms_audit_events
        WHERE tenant_id = ${TENANT}
          AND module_key = 'media_library'
          AND action = 'media.download'
          AND resource_id = ${PRIVATE_OBJECT_ID}
      `) as {
        action: string;
        resource_id: string;
        severity: string;
        attributes: Record<string, unknown>;
      }[];

      expect(rows).toHaveLength(1);
      expect(rows[0]?.severity).toBe("info");
      expect(rows[0]?.attributes?.outcome).toBe("issued");
    });
  }
);
