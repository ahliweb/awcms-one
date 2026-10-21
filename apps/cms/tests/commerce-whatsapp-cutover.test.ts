/**
 * The decision of the guarded WhatsApp mode flip, the CLI's argument parser, the
 * permission wiring and the migration (Issue #393, ADR-0047 "Cutover"). Pure - no
 * database; the behaviour against PostgreSQL is
 * `tests/integration/commerce-whatsapp-cutover.integration.test.ts`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  parseCutoverArgs,
  UsageError
} from "../scripts/commerce-whatsapp-cutover";
import { listModules } from "../src/modules";
import {
  COMMERCE_WHATSAPP_MODE_ACTIVITY_CODE,
  COMMERCE_WHATSAPP_MODE_PERMISSIONS
} from "../src/modules/commerce/domain/commerce-permissions";
import {
  LEGACY_TERMINAL_STATUSES,
  UPSTREAM_TERMINAL_STATUSES,
  assessWhatsappFlip,
  buildQueueDrain,
  describeNonTerminal,
  validateFlipReason,
  type ChannelFacts,
  type FlipFacts,
  type QueueDrain
} from "../src/modules/commerce/domain/whatsapp-cutover";
import { readChannelFacts } from "../src/modules/commerce/application/whatsapp-mode-flip";

const read = (relative: string) =>
  readFileSync(resolve(import.meta.dir, "..", relative), "utf8");

const EMPTY: QueueDrain = {
  countsByStatus: {},
  nonTerminal: 0,
  oldestNonTerminalAgeSeconds: null
};

const GOOD_CHANNEL: ChannelFacts = {
  legacyEnabled: true,
  upstreamEnabled: true,
  upstreamModuleEnabled: true,
  upstreamHashKeysUsable: true,
  upstreamProvider: "log",
  upstreamProviderKnown: true
};

function facts(over: Partial<FlipFacts> = {}): FlipFacts {
  return {
    current: "legacy",
    target: "upstream",
    legacy: EMPTY,
    upstream: EMPTY,
    channel: GOOD_CHANNEL,
    consent: { commerceMarketingOptIns: 0, upstreamGrantedConsents: 0 },
    acknowledgeWarnings: true,
    ...over
  };
}

describe("buildQueueDrain", () => {
  test("counts every status that is not terminal for the queue, and nothing else", () => {
    const drain = buildQueueDrain(
      { queued: 2, sending: 1, sent: 40, failed: 3 },
      LEGACY_TERMINAL_STATUSES,
      90
    );

    expect(drain.nonTerminal).toBe(3);
    expect(drain.oldestNonTerminalAgeSeconds).toBe(90);
  });

  test("an unknown future status counts as work: a flip that wrongly waits is safe, one that wrongly proceeds strands a row", () => {
    expect(
      buildQueueDrain({ sent: 5, paused: 1 }, LEGACY_TERMINAL_STATUSES, 5)
        .nonTerminal
    ).toBe(1);
  });

  test("the two queues' terminal sets differ: retry_wait is upstream work, cancelled and expired are upstream history", () => {
    const counts = { retry_wait: 1, cancelled: 2, expired: 3, sent: 4 };

    expect(
      buildQueueDrain(counts, UPSTREAM_TERMINAL_STATUSES, 1).nonTerminal
    ).toBe(1);
    // The same counts in the legacy table would all be work: it has none of these statuses.
    expect(
      buildQueueDrain(counts, LEGACY_TERMINAL_STATUSES, 1).nonTerminal
    ).toBe(6);
  });

  test("no age is reported when nothing is pending", () => {
    expect(
      buildQueueDrain({ sent: 9 }, LEGACY_TERMINAL_STATUSES, 500)
        .oldestNonTerminalAgeSeconds
    ).toBeNull();
  });

  test("describeNonTerminal lists only work, in lifecycle order", () => {
    expect(
      describeNonTerminal(
        buildQueueDrain(
          { sending: 1, queued: 2, sent: 9 },
          LEGACY_TERMINAL_STATUSES,
          1
        ),
        LEGACY_TERMINAL_STATUSES
      )
    ).toBe("queued=2, sending=1");
  });
});

describe("assessWhatsappFlip", () => {
  test("an empty legacy queue, a usable upstream channel and acknowledged warnings: allowed", () => {
    expect(assessWhatsappFlip(facts()).decision).toEqual({ kind: "allowed" });
  });

  test("a non-terminal legacy row refuses DRAIN_PENDING and names the counts and the oldest age", () => {
    const legacy = buildQueueDrain(
      { queued: 2, sending: 1, sent: 7 },
      LEGACY_TERMINAL_STATUSES,
      125
    );
    const { decision, blockers } = assessWhatsappFlip(facts({ legacy }));

    expect(decision).toMatchObject({ kind: "refused", code: "DRAIN_PENDING" });
    expect(decision.kind === "refused" && decision.message).toContain(
      "queued=2, sending=1"
    );
    expect(decision.kind === "refused" && decision.message).toContain("125s");
    expect(blockers.map((b) => b.code)).toEqual(["DRAIN_PENDING"]);
  });

  test("terminal rows alone never block: a tenant with a long history flips", () => {
    const legacy = buildQueueDrain(
      { sent: 12000, failed: 40 },
      LEGACY_TERMINAL_STATUSES,
      null
    );

    expect(assessWhatsappFlip(facts({ legacy })).decision.kind).toBe("allowed");
  });

  test("the UPSTREAM queue's backlog does not block a flip INTO upstream (it is the queue being entered)", () => {
    const upstream = buildQueueDrain(
      { queued: 5 },
      UPSTREAM_TERMINAL_STATUSES,
      10
    );

    expect(assessWhatsappFlip(facts({ upstream })).decision.kind).toBe(
      "allowed"
    );
  });

  test("the reverse flip is symmetric: it waits for the UPSTREAM queue, retry_wait included, and ignores legacy history", () => {
    const upstream = buildQueueDrain(
      { retry_wait: 1, sent: 3 },
      UPSTREAM_TERMINAL_STATUSES,
      60
    );
    const base = {
      current: "upstream" as const,
      target: "legacy" as const,
      acknowledgeWarnings: false
    };

    expect(
      assessWhatsappFlip(facts({ ...base, upstream })).decision
    ).toMatchObject({ kind: "refused", code: "DRAIN_PENDING" });
    expect(assessWhatsappFlip(facts({ ...base })).decision.kind).toBe(
      "allowed"
    );
  });

  test("the reverse flip needs no acknowledgement: it carries no warnings", () => {
    const result = assessWhatsappFlip(
      facts({
        current: "upstream",
        target: "legacy",
        acknowledgeWarnings: false
      })
    );

    expect(result.warnings).toEqual([]);
    expect(result.decision.kind).toBe("allowed");
  });

  test("a flip into a dead channel is refused, not performed: each reason is a blocker", () => {
    const dead: ChannelFacts = {
      legacyEnabled: true,
      upstreamEnabled: false,
      upstreamModuleEnabled: false,
      upstreamHashKeysUsable: false,
      upstreamProvider: null,
      upstreamProviderKnown: false
    };
    const { decision, blockers } = assessWhatsappFlip(facts({ channel: dead }));

    expect(decision).toMatchObject({
      kind: "refused",
      code: "TARGET_CHANNEL_UNAVAILABLE"
    });
    expect(blockers.map((b) => b.code)).toEqual([
      "TARGET_DISABLED",
      "TARGET_MODULE_DISABLED",
      "TARGET_HASH_KEYS_UNUSABLE",
      "TARGET_PROVIDER_UNSET"
    ]);
  });

  test("the drain blocker comes first when both a pending row and a dead channel apply, and the evidence lists both", () => {
    const legacy = buildQueueDrain({ queued: 1 }, LEGACY_TERMINAL_STATUSES, 1);
    const { decision, blockers } = assessWhatsappFlip(
      facts({
        legacy,
        channel: { ...GOOD_CHANNEL, upstreamEnabled: false }
      })
    );

    expect(decision).toMatchObject({ kind: "refused", code: "DRAIN_PENDING" });
    expect(blockers.map((b) => b.code)).toEqual([
      "DRAIN_PENDING",
      "TARGET_DISABLED"
    ]);
  });

  test("flipping back to legacy is refused when COMMERCE_WHATSAPP_ENABLED is off in this process", () => {
    const { blockers } = assessWhatsappFlip(
      facts({
        current: "upstream",
        target: "legacy",
        channel: { ...GOOD_CHANNEL, legacyEnabled: false }
      })
    );

    expect(blockers.map((b) => b.code)).toEqual(["TARGET_DISABLED"]);
  });

  test("a flip into upstream carries the ADR-0047 warnings and is refused until they are acknowledged", () => {
    const result = assessWhatsappFlip(
      facts({
        acknowledgeWarnings: false,
        consent: { commerceMarketingOptIns: 40, upstreamGrantedConsents: 0 }
      })
    );

    expect(result.decision).toMatchObject({
      kind: "refused",
      code: "WARNINGS_NOT_ACKNOWLEDGED"
    });
    expect(result.warnings.map((w) => w.code)).toEqual([
      "MARKETING_CONSENT_NOT_BRIDGED",
      "VARIABLES_SINGLE_LINE_CAPPED",
      "RATE_LIMITS_DIFFER"
    ]);
  });

  test("the consent warning is dropped once the upstream store holds at least as many grants as commerce has opt-ins", () => {
    const codes = assessWhatsappFlip(
      facts({
        consent: { commerceMarketingOptIns: 10, upstreamGrantedConsents: 10 }
      })
    ).warnings.map((w) => w.code);

    expect(codes).not.toContain("MARKETING_CONSENT_NOT_BRIDGED");
  });

  test("WHATSAPP_PROVIDER=meta adds the provider-template warning", () => {
    const codes = assessWhatsappFlip(
      facts({ channel: { ...GOOD_CHANNEL, upstreamProvider: "meta" } })
    ).warnings.map((w) => w.code);

    expect(codes).toContain("META_PROVIDER_TEMPLATE_MISSING");
  });

  test("a stale expectation refuses MODE_CHANGED before anything else, even when the tenant is already in the target mode", () => {
    expect(
      assessWhatsappFlip(facts({ current: "upstream", expected: "legacy" }))
        .decision
    ).toMatchObject({ kind: "refused", code: "MODE_CHANGED" });
  });

  test("a tenant already in the target mode is unchanged, whatever the queues look like", () => {
    const legacy = buildQueueDrain({ queued: 3 }, LEGACY_TERMINAL_STATUSES, 1);

    expect(
      assessWhatsappFlip(
        facts({ current: "upstream", target: "upstream", legacy })
      ).decision
    ).toEqual({ kind: "unchanged" });
  });
});

describe("readChannelFacts", () => {
  const env = (over: Record<string, string | undefined>) =>
    over as unknown as NodeJS.ProcessEnv;

  test("reads the two enable flags separately and never reports a credential", () => {
    const channel = readChannelFacts(
      env({
        WHATSAPP_ENABLED: "true",
        COMMERCE_WHATSAPP_ENABLED: undefined,
        WHATSAPP_PROVIDER: "fonnte",
        WHATSAPP_FONNTE_TOKEN: "secret-token"
      }),
      true
    );

    expect(channel).toMatchObject({
      upstreamEnabled: true,
      legacyEnabled: false,
      upstreamProvider: "fonnte",
      upstreamProviderKnown: true,
      upstreamHashKeysUsable: false
    });
    expect(JSON.stringify(channel)).not.toContain("secret-token");
  });

  test("an unset or unknown provider is not known", () => {
    expect(readChannelFacts(env({}), true).upstreamProviderKnown).toBe(false);
    expect(
      readChannelFacts(env({ WHATSAPP_PROVIDER: "carrier-pigeon" }), true)
        .upstreamProviderKnown
    ).toBe(false);
  });
});

describe("validateFlipReason", () => {
  test("trims, and refuses empty, non-string and over-long reasons", () => {
    expect(validateFlipReason("  go live  ")).toEqual({
      valid: true,
      reason: "go live"
    });
    expect(validateFlipReason("   ").valid).toBe(false);
    expect(validateFlipReason(undefined).valid).toBe(false);
    expect(validateFlipReason(7).valid).toBe(false);
    expect(validateFlipReason("x".repeat(501)).valid).toBe(false);
    expect(validateFlipReason("x".repeat(500)).valid).toBe(true);
  });
});

describe("the CLI's argument parser", () => {
  const TENANT = "39300000-0000-4000-8000-00000000000a";

  test("a flip needs --tenant, --to and --reason", () => {
    expect(
      parseCutoverArgs([
        "--tenant",
        TENANT,
        "--to",
        "upstream",
        "--reason",
        "go"
      ])
    ).toEqual({
      kind: "flip",
      waitSeconds: 0,
      tenantId: TENANT,
      to: "upstream",
      reason: "go",
      dryRun: false,
      acknowledgeWarnings: false
    });
  });

  test("--dry-run, --ack-warnings, --from and --operator are read", () => {
    expect(
      parseCutoverArgs([
        "--tenant",
        TENANT,
        "--to",
        "legacy",
        "--reason",
        "rollback",
        "--dry-run",
        "--ack-warnings",
        "--from",
        "upstream",
        "--operator",
        "ops-1"
      ])
    ).toMatchObject({
      to: "legacy",
      dryRun: true,
      acknowledgeWarnings: true,
      from: "upstream",
      operator: "ops-1"
    });
  });

  test("--status takes only --tenant", () => {
    expect(parseCutoverArgs(["--tenant", TENANT, "--status"])).toEqual({
      kind: "status",
      tenantId: TENANT
    });
    expect(() =>
      parseCutoverArgs(["--tenant", TENANT, "--status", "--to", "upstream"])
    ).toThrow(UsageError);
  });

  test("--wait is a whole number of seconds from 0 to 3600", () => {
    const base = ["--tenant", TENANT, "--to", "upstream", "--reason", "x"];

    expect(parseCutoverArgs([...base, "--wait", "90"])).toMatchObject({
      waitSeconds: 90
    });
    for (const bad of ["-1", "3601", "1.5", "soon"]) {
      expect(() => parseCutoverArgs([...base, "--wait", bad])).toThrow(
        UsageError
      );
    }
  });

  test("a missing or malformed value, an unknown flag and a stray argument are usage errors", () => {
    const bad: string[][] = [
      [],
      ["--tenant", "not-a-uuid", "--to", "upstream", "--reason", "x"],
      ["--tenant", TENANT, "--to", "elsewhere", "--reason", "x"],
      ["--tenant", TENANT, "--to", "upstream"],
      ["--tenant", TENANT, "--to", "upstream", "--reason", "   "],
      ["--tenant", TENANT, "--to", "upstream", "--reason", "--dry-run"],
      ["--tenant", TENANT, "--to", "upstream", "--reason", "x", "--force"],
      ["--tenant", TENANT, "--to", "upstream", "--reason", "x", "extra"],
      ["--tenant", TENANT, "--to", "upstream", "--reason", "x", "--from", "z"]
    ];

    for (const argv of bad) {
      expect(() => parseCutoverArgs(argv)).toThrow(UsageError);
    }
  });
});

describe("permissions, route wiring and the migration", () => {
  const KEYS = ["commerce.whatsapp_mode.manage", "commerce.whatsapp_mode.read"];
  const commerce = listModules().find((module) => module.key === "commerce")!;

  test("the constants name the two keys", () => {
    expect(
      (Object.values(COMMERCE_WHATSAPP_MODE_PERMISSIONS) as string[]).sort()
    ).toEqual(KEYS);
  });

  test("module.ts declares exactly the two keys", () => {
    expect(
      (commerce.permissions ?? [])
        .filter((p) => p.activityCode === COMMERCE_WHATSAPP_MODE_ACTIVITY_CODE)
        .map((p) => `commerce.${p.activityCode}.${p.action}`)
        .sort()
    ).toEqual(KEYS);
  });

  test("sql/1028 seeds exactly those keys and touches nothing else", () => {
    const sql = read("sql/1028_awcms_commerce_whatsapp_mode_permissions.sql");

    expect(
      [...sql.matchAll(/\('commerce', '([a-z_]+)', '([a-z_]+)',/g)]
        .map((match) => `commerce.${match[1]}.${match[2]}`)
        .sort()
    ).toEqual(KEYS);
    expect(sql).not.toMatch(/\b(CREATE|ALTER|DROP|GRANT|UPDATE|DELETE)\b\s/);
  });

  test("manage is a high-risk action; read is not", () => {
    const source = read("src/modules/identity-access/domain/access-control.ts");
    const start = source.indexOf("const HIGH_RISK_ACTIONS");
    const block = source.slice(start, source.indexOf("]);", start));

    expect(block).toContain('"manage"');
    expect(block).not.toContain('"read"');
  });

  test("GET is gated on read, POST on manage, and the POST requires a step-up for a real flip and an Idempotency-Key", () => {
    const route = read("src/pages/api/v1/commerce/whatsapp/mode.ts");
    const http = read("src/modules/commerce/application/whatsapp-mode-http.ts");

    expect(route).toMatch(
      /GET = defineTenantRoute\(\{[^}]*authorize: WHATSAPP_MODE_READ_GUARD/s
    );
    expect(route).toMatch(
      /POST = defineTenantRoute<Prepared>\(\{[\s\S]*authorize: WHATSAPP_MODE_MANAGE_GUARD/
    );
    expect(route).toContain("requireStepUp(");
    expect(route).toContain("requireIdempotencyKey(");
    expect(http).toMatch(
      /WHATSAPP_MODE_READ_GUARD = \{[^}]*COMMERCE_WHATSAPP_MODE_ACTIVITY_CODE[^}]*action: "read"/s
    );
    expect(http).toMatch(
      /WHATSAPP_MODE_MANAGE_GUARD = \{[^}]*COMMERCE_WHATSAPP_MODE_ACTIVITY_CODE[^}]*action: "manage"/s
    );
  });
});
