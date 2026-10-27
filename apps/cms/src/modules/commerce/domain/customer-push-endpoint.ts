/**
 * The push-service host allowlist for customer devices (Issue #430, ADR-0048 T9
 * and Q6). Pure.
 *
 * ## Why an allowlist here when upstream has none
 *
 * Upstream's `validateSubscriptionInput` (reused for the shape, the https rule,
 * the literal-private-address rule and the key sizes) lets staff register any
 * https endpoint, because the dispatcher's `ssrfSafeFetch` is the SSRF
 * authority at send time. A customer surface has a far larger attacker
 * population: ANY verified shopper can register, and the endpoint is later
 * fetched by our server. So for customers the set of hosts a browser endpoint
 * can legitimately have is closed: the Web Push services of the browser vendors.
 * An endpoint anywhere else answers `422 ENDPOINT_NOT_ALLOWED`, and no row is
 * written.
 *
 * ## The default list (checked against the operator test matrix,
 * `docs/awcms/push-notifications-test-matrix.md`)
 *
 * | Vendor     | Host                                    | Used by                       |
 * | ---------- | --------------------------------------- | ----------------------------- |
 * | Google     | `fcm.googleapis.com`                    | Chrome, Edge, Brave, Android  |
 * | Mozilla    | `updates.push.services.mozilla.com`     | Firefox                       |
 * | Apple      | `web.push.apple.com`                    | Safari, iOS/iPadOS web apps   |
 * | Microsoft  | `*.notify.windows.com`                  | legacy Edge (WNS)             |
 *
 * ## The operator override
 *
 * ONLY an operator environment setting can extend the list
 * (`COMMERCE_CUSTOMER_PUSH_EXTRA_ENDPOINT_HOSTS`): never a tenant admin, a
 * request or a stored row. The value is a comma-separated list of exact
 * hostnames or `*.suffix.example` wildcards; anything malformed, an IP literal,
 * a single label, `localhost` or a wildcard over a bare top-level label is
 * IGNORED (fail closed: an invalid entry can only shrink the allowlist) and is
 * reported by `parseExtraPushHosts().invalid` so `config:validate` can say so.
 *
 * Also refused regardless of host: a non-`https` scheme, userinfo, an explicit
 * port (push services use the default 443), and a trailing-dot or non-ASCII
 * host (the URL parser normalises case and punycode, so the comparison is on the
 * canonical hostname).
 */

export const CUSTOMER_PUSH_EXTRA_HOSTS_ENV =
  "COMMERCE_CUSTOMER_PUSH_EXTRA_ENDPOINT_HOSTS";

export type PushHostRule =
  { kind: "exact"; host: string } | { kind: "suffix"; suffix: string };

/** Exact hosts and wildcard suffixes of the browser vendors' Web Push services. */
export const DEFAULT_PUSH_SERVICE_HOST_RULES: readonly PushHostRule[] = [
  { kind: "exact", host: "fcm.googleapis.com" },
  { kind: "exact", host: "updates.push.services.mozilla.com" },
  { kind: "exact", host: "web.push.apple.com" },
  { kind: "suffix", suffix: "notify.windows.com" }
];

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME_PATTERN = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);
const MAX_EXTRA_RULES = 32;

export type ExtraPushHosts = {
  rules: PushHostRule[];
  /** Entries that were ignored (never echoed into an error that reaches a customer). */
  invalid: string[];
};

function looksLikeIpLiteral(host: string): boolean {
  return /^[0-9.]+$/.test(host) || host.includes(":");
}

/** Parses the operator's override. Pure; an unset or blank value yields no rules. */
export function parseExtraPushHosts(raw: string | undefined): ExtraPushHosts {
  const rules: PushHostRule[] = [];
  const invalid: string[] = [];

  const entries = (raw ?? "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");

  for (const entry of entries) {
    if (rules.length >= MAX_EXTRA_RULES) {
      invalid.push(entry);
      continue;
    }

    const wildcard = entry.startsWith("*.");
    const host = wildcard ? entry.slice(2) : entry;

    if (
      !HOSTNAME_PATTERN.test(host) ||
      looksLikeIpLiteral(host) ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".internal") ||
      host.endsWith(".local")
    ) {
      invalid.push(entry);
      continue;
    }

    rules.push(
      wildcard ? { kind: "suffix", suffix: host } : { kind: "exact", host }
    );
  }

  return { rules, invalid };
}

export type PushHostPolicy = readonly PushHostRule[];

/** The effective policy: the vendor defaults plus the operator's extra rules. */
export function resolvePushHostPolicy(
  env: NodeJS.ProcessEnv = process.env
): PushHostPolicy {
  return [
    ...DEFAULT_PUSH_SERVICE_HOST_RULES,
    ...parseExtraPushHosts(env[CUSTOMER_PUSH_EXTRA_HOSTS_ENV]).rules
  ];
}

export function isPushHostAllowed(
  hostname: string,
  policy: PushHostPolicy = DEFAULT_PUSH_SERVICE_HOST_RULES
): boolean {
  const host = hostname.toLowerCase();
  if (host === "" || looksLikeIpLiteral(host)) return false;

  return policy.some((rule) =>
    rule.kind === "exact"
      ? host === rule.host
      : host.endsWith(`.${rule.suffix}`)
  );
}

export type EndpointPolicyResult =
  { ok: true; hostname: string } | { ok: false; message: string };

/**
 * The host-level check of a registration endpoint (the shape, https rule and
 * key sizes are upstream's `validateSubscriptionInput`, run first). The message
 * is fixed text: it never echoes the host the caller chose.
 */
export function checkCustomerPushEndpoint(
  endpoint: string,
  policy: PushHostPolicy = DEFAULT_PUSH_SERVICE_HOST_RULES
): EndpointPolicyResult {
  const refusal = {
    ok: false,
    message:
      "This push service is not supported. Use a current browser (Chrome, Edge, Firefox or Safari)."
  } as const;

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return refusal;
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hostname.endsWith(".")
  ) {
    return refusal;
  }

  return isPushHostAllowed(url.hostname, policy)
    ? { ok: true, hostname: url.hostname.toLowerCase() }
    : refusal;
}
