import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { enqueueLegacyWhatsappMessage } from "../src/modules/commerce/application/whatsapp-enqueue-legacy";
import {
  enqueueWhatsappMessage,
  isWhatsappChannelAvailable
} from "../src/modules/commerce/application/whatsapp-enqueue";
import {
  otpExpiresAt,
  toEnqueueResult,
  upstreamIdempotencyKey
} from "../src/modules/commerce/application/whatsapp-upstream-enqueue";
import { toOutboxState } from "../src/modules/commerce/application/whatsapp-upstream-status";
import {
  documentDeliveryFailureReason,
  type WhatsappNotQueuedReason
} from "../src/modules/commerce/domain/whatsapp-enqueue-types";
import { maskPhone } from "../src/modules/commerce/domain/phone-normalisation";
import {
  DEFAULT_WHATSAPP_MODE,
  parseWhatsappMode
} from "../src/modules/commerce/domain/whatsapp-mode";
import {
  COMMERCE_UPSTREAM_TEMPLATE_PLANS,
  COMMERCE_WHATSAPP_TEMPLATE_VERSION
} from "../src/modules/commerce/domain/whatsapp-upstream-templates";
import {
  renderWhatsappTemplate as renderCommerceTemplate,
  whatsappTemplateVariables,
  WHATSAPP_TEMPLATE_KEYS
} from "../src/modules/commerce/domain/whatsapp-templates";
import {
  getWhatsappTemplate,
  renderWhatsappTemplate as renderUpstreamTemplate
} from "../src/modules/whatsapp-delivery/domain/whatsapp-templates";

/**
 * Issue #392 (ADR-0133 section 6 phase 2) - the parts of the WhatsApp
 * compatibility adapter that need no database: the mode parse, the mapping from
 * commerce's message to the port's input and back, the template registration,
 * the proof that the legacy writer still issues the one statement it always did,
 * and the proof that a fresh `whatsapp:dispatch` process knows the templates.
 * The queue-level behaviour (which table a message lands in, per kind of
 * message) is `tests/integration/commerce-whatsapp-compat.integration.test.ts`.
 */
const CMS_ROOT = resolve(import.meta.dir, "..");

type Call = { sql: string; values: unknown[] };

/** A tagged-template stand-in for a transaction that records every statement. */
function fakeTx(answers: ((sql: string) => unknown[])[] = []): {
  tx: Bun.SQL;
  calls: Call[];
} {
  const calls: Call[] = [];
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings
      .reduce(
        (text, part, index) =>
          `${text}${part}${index < values.length ? `$${index + 1}` : ""}`,
        ""
      )
      .replace(/\s+/g, " ")
      .trim();

    calls.push({ sql, values });
    const answer = answers[calls.length - 1];

    return Promise.resolve(answer ? answer(sql) : [{ id: "row-1" }]);
  }) as unknown as Bun.SQL;

  return { tx, calls };
}

const TENANT = "11111111-1111-4111-8111-111111111111";

describe("the mode parse (Issue #392)", () => {
  test("only the exact string `upstream` selects the upstream queue", () => {
    expect(DEFAULT_WHATSAPP_MODE).toBe("legacy");
    expect(parseWhatsappMode("upstream")).toBe("upstream");
    expect(parseWhatsappMode("legacy")).toBe("legacy");

    for (const unknown of [
      undefined,
      null,
      "",
      "UPSTREAM",
      " upstream",
      1,
      {}
    ]) {
      expect(parseWhatsappMode(unknown)).toBe("legacy");
    }
  });
});

describe("a tenant in `legacy` mode is untouched (Issue #392, M9)", () => {
  test("the legacy writer issues exactly one INSERT, with the columns and values it always had", async () => {
    const { tx, calls } = fakeTx();
    const variables = {
      code: "123456",
      expiresInMinutes: "10",
      storeName: "Toko Uji"
    };

    const result = await enqueueLegacyWhatsappMessage(tx, {
      tenantId: TENANT,
      toPhone: "+6281234567890",
      templateKey: "commerce.customer_otp",
      variables,
      correlationId: "corr-1",
      // Ignored by the legacy writer: it changes no legacy row.
      idempotencyKey: "campaign:x:y"
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toBe(
      "INSERT INTO awcms_commerce_whatsapp_messages (tenant_id, correlation_id, to_phone, to_phone_hash, to_phone_masked, template_key, variables, body_rendered) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING id"
    );
    expect(calls[0]!.values).toEqual([
      TENANT,
      "corr-1",
      "+6281234567890",
      createHash("sha256").update("+6281234567890").digest("hex"),
      maskPhone("+6281234567890"),
      "commerce.customer_otp",
      variables,
      renderCommerceTemplate("commerce.customer_otp", variables)
    ]);
    expect(String(calls[0]!.values[4])).not.toContain("1234567");
    expect(result).toEqual({
      id: "row-1",
      bodyRendered: renderCommerceTemplate("commerce.customer_otp", variables)
    });
  });

  test("the router, in the default mode, takes the shared lock, reads the mode, then issues that same INSERT", async () => {
    const { tx, calls } = fakeTx([() => [], () => [], () => [{ id: "row-9" }]]);

    const result = await enqueueWhatsappMessage(tx, {
      tenantId: TENANT,
      toPhone: "+6281234567890",
      templateKey: "commerce.order_paid",
      variables: { orderCode: "A1", total: "10000.00", storeName: "Toko" },
      correlationId: "corr-2"
    });

    expect(
      calls.map((call) => call.sql.split(" ").slice(0, 2).join(" "))
    ).toEqual([
      "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,",
      "SELECT whatsapp_mode",
      "INSERT INTO"
    ]);
    expect(calls[2]!.sql).toContain("INTO awcms_commerce_whatsapp_messages");
    expect(calls[0]!.values).toEqual([`commerce.whatsapp_mode|${TENANT}`]);
    expect(calls[1]!.values).toEqual([TENANT]);
    // A tenant with no settings row (the mode select answered nothing) is `legacy`.
    expect(result).toMatchObject({ id: "row-9", enqueued: true });
  });
});

describe("channel availability asks the database only when the mode matters (Issue #392)", () => {
  const exploding = new Proxy(
    {},
    {
      get() {
        throw new Error("the database must not be touched");
      },
      apply() {
        throw new Error("the database must not be touched");
      }
    }
  ) as unknown as Bun.SQL;
  const env = (over: Record<string, string>) => over as NodeJS.ProcessEnv;

  test("both flags off, or both on, are the same answer in either mode", async () => {
    expect(await isWhatsappChannelAvailable(exploding, TENANT, env({}))).toBe(
      false
    );
    expect(
      await isWhatsappChannelAvailable(
        exploding,
        TENANT,
        env({ COMMERCE_WHATSAPP_ENABLED: "true", WHATSAPP_ENABLED: "true" })
      )
    ).toBe(true);
  });

  test("one flag on follows the tenant's mode", async () => {
    const txIn = (mode: string) =>
      (() => Promise.resolve([{ whatsapp_mode: mode }])) as unknown as Bun.SQL;
    const legacyOnly = env({ COMMERCE_WHATSAPP_ENABLED: "true" });
    const upstreamOnly = env({ WHATSAPP_ENABLED: "true" });

    expect(
      await isWhatsappChannelAvailable(txIn("legacy"), TENANT, legacyOnly)
    ).toBe(true);
    expect(
      await isWhatsappChannelAvailable(txIn("upstream"), TENANT, legacyOnly)
    ).toBe(false);
    expect(
      await isWhatsappChannelAvailable(txIn("legacy"), TENANT, upstreamOnly)
    ).toBe(false);
    expect(
      await isWhatsappChannelAvailable(txIn("upstream"), TENANT, upstreamOnly)
    ).toBe(true);
  });
});

describe("the mapping to and from the port (Issue #392)", () => {
  test("an idempotency key is `commerce:<identity>`, a fresh one when the caller has none, and never longer than the queue allows", () => {
    expect(upstreamIdempotencyKey("campaign:c1:u1", "commerce.campaign")).toBe(
      "commerce:campaign:c1:u1"
    );

    const a = upstreamIdempotencyKey(undefined, "commerce.customer_otp");
    const b = upstreamIdempotencyKey(undefined, "commerce.customer_otp");

    expect(a).not.toBe(b);
    expect(a.startsWith("commerce:commerce.customer_otp:")).toBe(true);

    const long = upstreamIdempotencyKey("x".repeat(500), "commerce.campaign");

    expect(long.length).toBeLessThanOrEqual(200);
    expect(long).toBe(
      upstreamIdempotencyKey("x".repeat(500), "commerce.campaign")
    );
  });

  test("a security message expires when the code does, not later", () => {
    const now = new Date("2026-10-14T10:00:00.000Z");

    expect(otpExpiresAt({ expiresInMinutes: "10" }, now).toISOString()).toBe(
      "2026-10-14T10:10:00.000Z"
    );
    // An unusable variable falls back to the 10 minutes `OTP_TTL_SECONDS` is,
    // and a hostile one is capped at a day.
    for (const bad of [
      {},
      { expiresInMinutes: "x" },
      { expiresInMinutes: "-5" }
    ] as Record<string, string>[]) {
      expect(otpExpiresAt(bad, now).toISOString()).toBe(
        "2026-10-14T10:10:00.000Z"
      );
    }
    expect(
      otpExpiresAt({ expiresInMinutes: "999999" }, now).getTime() -
        now.getTime()
    ).toBe(24 * 60 * 60_000);
  });

  test("a queued or replayed message keeps the legacy shape and says `enqueued`", () => {
    for (const status of ["queued", "duplicate"] as const) {
      expect(toEnqueueResult({ status, messageId: "m-1" }, "body")).toEqual({
        id: "m-1",
        bodyRendered: "body",
        enqueued: true
      });
    }
  });

  test("every refusal and suppression is RETURNED with its reason, never thrown", () => {
    expect(
      toEnqueueResult({ status: "suppressed", reason: "opt_out" }, "b")
    ).toEqual({
      id: "",
      bodyRendered: "b",
      enqueued: false,
      reason: "SUPPRESSED_OPT_OUT"
    });
    expect(
      toEnqueueResult({ status: "suppressed", reason: "hard_failure" }, "b")
    ).toMatchObject({ enqueued: false, reason: "SUPPRESSED_HARD_FAILURE" });

    for (const reason of [
      "CONSENT_REQUIRED",
      "TEMPLATE_UNKNOWN",
      "DISABLED",
      "RATE_LIMITED",
      "RECIPIENT_INVALID",
      "RECIPIENT_UNRESOLVED",
      "EXPIRY_REQUIRED",
      "MISCONFIGURED"
    ] as const) {
      expect(toEnqueueResult({ status: "refused", reason }, "b")).toMatchObject(
        {
          id: "",
          enqueued: false,
          reason
        }
      );
    }
  });

  test("a not-queued document delivery maps onto the two failure reasons its CHECK allows", () => {
    const mapped: Record<WhatsappNotQueuedReason, string> = {
      SUPPRESSED_HARD_FAILURE: "RECIPIENT_SUPPRESSED",
      SUPPRESSED_OPT_OUT: "RECIPIENT_SUPPRESSED",
      CONSENT_REQUIRED: "RECIPIENT_SUPPRESSED",
      RECIPIENT_INVALID: "RECIPIENT_SUPPRESSED",
      RECIPIENT_UNRESOLVED: "RECIPIENT_SUPPRESSED",
      TEMPLATE_UNKNOWN: "TEMPLATE_UNAVAILABLE",
      DISABLED: "TEMPLATE_UNAVAILABLE",
      RATE_LIMITED: "TEMPLATE_UNAVAILABLE",
      EXPIRY_REQUIRED: "TEMPLATE_UNAVAILABLE",
      MISCONFIGURED: "TEMPLATE_UNAVAILABLE"
    };

    for (const [reason, expected] of Object.entries(mapped)) {
      expect(
        documentDeliveryFailureReason(reason as WhatsappNotQueuedReason)
      ).toBe(expected as "RECIPIENT_SUPPRESSED" | "TEMPLATE_UNAVAILABLE");
    }
  });

  test("an expired queue message reads as failed in commerce's status vocabulary, and the port exposes no provider id", () => {
    const base = {
      messageId: "m",
      templateKey: "commerce.customer_otp",
      purpose: "security" as const,
      recipientMasked: "+62*****90",
      failureCode: "expired",
      sentAt: null,
      createdAt: "2026-10-14T10:00:00.000Z"
    };

    expect(toOutboxState({ ...base, status: "expired" })).toEqual({
      status: "failed",
      providerMessageId: null,
      retryCount: 0,
      lastError: "expired",
      sentAt: null
    });
    expect(toOutboxState({ ...base, status: "retry_wait" }).status).toBe(
      "retry_wait"
    );
  });
});

describe("the commerce.* templates registered with whatsapp_delivery (Issue #392)", () => {
  test("every commerce key is registered with its purpose, once, at the commerce wording", () => {
    expect(Object.keys(COMMERCE_UPSTREAM_TEMPLATE_PLANS).sort()).toEqual(
      [...WHATSAPP_TEMPLATE_KEYS].sort()
    );

    const purposes = Object.fromEntries(
      WHATSAPP_TEMPLATE_KEYS.map((key) => [
        key,
        getWhatsappTemplate(key)?.purpose
      ])
    );

    expect(purposes).toEqual({
      "commerce.customer_otp": "security",
      "commerce.order_paid": "transactional",
      "commerce.campaign": "marketing",
      "commerce.document": "transactional"
    });

    for (const key of WHATSAPP_TEMPLATE_KEYS) {
      const registered = getWhatsappTemplate(key)!;

      expect(registered.version).toBe(COMMERCE_WHATSAPP_TEMPLATE_VERSION);
      expect([...registered.variables]).toEqual([
        ...whatsappTemplateVariables(key)
      ]);
    }
  });

  test("the OTP code is the one secret variable", () => {
    expect([
      ...(getWhatsappTemplate("commerce.customer_otp")!.secretVariables ?? [])
    ]).toEqual(["code"]);

    for (const key of WHATSAPP_TEMPLATE_KEYS.filter(
      (k) => k !== "commerce.customer_otp"
    )) {
      expect(getWhatsappTemplate(key)!.secretVariables ?? []).toEqual([]);
    }
  });

  test("both modes say the same thing for single-line values: no wording drift while both exist", () => {
    const samples: Record<string, Record<string, string>> = {
      "commerce.customer_otp": {
        code: "123456",
        expiresInMinutes: "10",
        storeName: "Toko Uji"
      },
      "commerce.order_paid": {
        orderCode: "BJ-1",
        total: "30000.00",
        storeName: "Toko Uji"
      },
      "commerce.campaign": { body: "Diskon hari ini", storeName: "Toko Uji" },
      "commerce.document": {
        documentLabel: "Struk",
        documentNumber: "RCP-1",
        storeName: "Toko Uji",
        body: "Total 30000.00",
        link: ""
      }
    };

    for (const key of WHATSAPP_TEMPLATE_KEYS) {
      expect(
        renderUpstreamTemplate(getWhatsappTemplate(key)!, samples[key]!).body
      ).toBe(renderCommerceTemplate(key, samples[key]!));
    }
  });
});

describe("a fresh whatsapp:dispatch process knows the commerce templates (Issue #392)", () => {
  test("importing only the dispatch script registers every commerce.* template", async () => {
    // A fresh process: this test file's own imports have already populated the
    // registry here, so only a child can show what the dispatcher process sees.
    const script = `
      await import(${JSON.stringify(join(CMS_ROOT, "scripts/whatsapp-dispatch.ts"))});
      const { getWhatsappTemplate } = await import(${JSON.stringify(
        join(
          CMS_ROOT,
          "src/modules/whatsapp-delivery/domain/whatsapp-templates.ts"
        )
      )});
      const out = {};
      for (const key of ${JSON.stringify([...WHATSAPP_TEMPLATE_KEYS, "commerce.not_a_key"])}) {
        out[key] = getWhatsappTemplate(key)?.purpose ?? null;
      }
      console.log(JSON.stringify(out));
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: CMS_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, DATABASE_URL: "", WHATSAPP_ENABLED: "false" }
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);

    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout.trim().split("\n").pop()!)).toEqual({
      "commerce.customer_otp": "security",
      "commerce.order_paid": "transactional",
      "commerce.campaign": "marketing",
      "commerce.document": "transactional",
      "commerce.not_a_key": null
    });
  });
});
