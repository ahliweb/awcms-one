/**
 * tools/lib/awcms-api.ts — issue #58.
 *
 * The minimal HTTP client `tools/import-seputarborneo.ts` needs, copied out
 * of `tools/seed-borneojek-mart.ts`'s own `apiCall`/`Session`/`assertOk`
 * (that file exports nothing — checked directly, `grep -n "^export "
 * tools/seed-borneojek-mart.ts` matches zero lines — so per issue #58's own
 * Scope this is a copy, not an import). "Only this script uses it" (issue
 * #58's own words): nothing else in `tools/` should import from here without
 * first checking whether the two client shapes have actually stayed
 * identical, since a fix made in one and not the other is exactly the kind
 * of drift this note exists to flag.
 *
 * Same conventions as the seed script, deliberately: `AWCMS_BASE_URL`, the
 * `authorization: Bearer <token>` + `x-awcms-tenant-id` header pair, and the
 * `{ data, raw }` envelope unwrap — so an operator who already knows how to
 * run `bun run db:seed:cms` needs nothing new to run this importer.
 */

export type Session = { tenantId: string; token: string };

export type ApiResult<T = unknown> = {
  status: number;
  ok: boolean;
  data: T;
  raw: unknown;
};

export class AwcmsApiError extends Error {
  readonly status: number;
  readonly raw: unknown;

  constructor(step: string, result: ApiResult) {
    super(`${step} failed — HTTP ${result.status}: ${JSON.stringify(result.raw)}`);
    this.name = "AwcmsApiError";
    this.status = result.status;
    this.raw = result.raw;
  }
}

export function assertOk(step: string, result: ApiResult): void {
  if (!result.ok) throw new AwcmsApiError(step, result);
}

/**
 * A thin wrapper, not a second `fetch` — every call goes through this so the
 * base URL, JSON parsing, and auth headers are stated once. `baseUrl` is
 * passed explicitly (never a module-level constant here) so this file stays
 * side-effect-free and importable by a test with no `AWCMS_BASE_URL` set.
 */
export async function apiCall<T = unknown>(
  baseUrl: string,
  method: string,
  urlPath: string,
  options: {
    session?: Session;
    body?: unknown;
    idempotencyKey?: string;
  } = {}
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { "content-type": "application/json" };

  if (options.session) {
    headers.authorization = `Bearer ${options.session.token}`;
    headers["x-awcms-tenant-id"] = options.session.tenantId;
  }
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;

  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  const text = await response.text();
  const raw = text.length > 0 ? JSON.parse(text) : null;
  const data = (
    raw && typeof raw === "object" && "data" in raw ? (raw as { data: unknown }).data : raw
  ) as T;

  return { status: response.status, ok: response.ok, data, raw };
}

/**
 * Resolves a session against a tenant this importer expects to ALREADY
 * exist — `bun run db:seed:cms` (or an equivalent tenant bootstrap) must
 * have run first. Unlike the seed script's `ensureTenantAndSession`, this
 * function never calls `POST /api/v1/setup/initialize`: an importer that can
 * silently create the tenant it is about to write 25,000 articles into is a
 * bug waiting to happen the first time it runs against the wrong database.
 */
export async function resolveExistingTenantSession(
  baseUrl: string,
  ownerLoginIdentifier: string,
  ownerPassword: string
): Promise<Session> {
  const status = await apiCall<{ locked: boolean; tenantId?: string }>(
    baseUrl,
    "GET",
    "/api/v1/setup/status"
  );
  assertOk("GET /api/v1/setup/status", status);

  if (!status.data.locked || !status.data.tenantId) {
    throw new Error(
      "No tenant is set up yet at this AWCMS_BASE_URL. This importer only ever " +
        "writes INTO an already-seeded tenant — run `bun run db:seed:cms` " +
        "(or the seputarborneo taxonomy seed, issue #57) first."
    );
  }

  if (!ownerPassword) {
    throw new Error(
      "SEED_OWNER_PASSWORD is not set. This importer authenticates as the " +
        "tenant owner the seed script already created — set it to that " +
        "owner's password (printed once, the first time the seed script ran)."
    );
  }

  const login = await apiCall<{ token: string }>(baseUrl, "POST", "/api/v1/auth/login", {
    body: { loginIdentifier: ownerLoginIdentifier, password: ownerPassword },
    session: { tenantId: status.data.tenantId, token: "" }
  });
  assertOk("POST /api/v1/auth/login", login);

  return { tenantId: status.data.tenantId, token: login.data.token };
}
