/**
 * Pure side of the cross-provider WhatsApp acceptance matrix (Issue #466, the
 * template-side half; the DB-backed half is
 * `integration/commerce-whatsapp-sender-matrix.integration.test.ts`).
 *
 * Commerce is a CONSUMER of the upstream `whatsapp_delivery` sender routing
 * (ahliweb/awcms ADR-0148): it owns no provider, no sender registry and no
 * routing. These tests pin that boundary and the way a sender refusal travels
 * back to a commerce caller:
 *
 *   - a refused sender is RETURNED as `enqueued: false` with its reason, never
 *     thrown and never turned into a send through another sender;
 *   - the document-delivery record classes it as a sending-side failure, not as a
 *     consent failure;
 *   - commerce's upstream path forwards no `senderAccountId` (campaign sender
 *     selection is #458, pending) and names no provider, so a caller cannot spoof
 *     a sender through commerce and commerce cannot pick a provider by itself.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { toEnqueueResult } from "../src/modules/commerce/application/whatsapp-upstream-enqueue";
import { documentDeliveryFailureReason } from "../src/modules/commerce/domain/whatsapp-enqueue-types";

const SRC = join(import.meta.dir, "..", "src", "modules", "commerce");

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesUnder(join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(dir, entry.name)]
        : []
  );
}

describe("a sender refusal reaches the commerce caller as a returned non-delivery", () => {
  for (const reason of [
    "SENDER_UNAVAILABLE",
    "SENDER_AFFINITY_CONFLICT",
    "TEMPLATE_NOT_APPROVED",
    "OUTSIDE_SERVICE_WINDOW"
  ] as const) {
    test(`${reason} is enqueued:false with the reason, no id`, () => {
      expect(toEnqueueResult({ status: "refused", reason }, "body")).toEqual({
        id: "",
        bodyRendered: "body",
        enqueued: false,
        reason
      });
    });

    test(`${reason} is a sending-side document-delivery failure, not a consent one`, () => {
      expect(documentDeliveryFailureReason(reason)).toBe(
        "TEMPLATE_UNAVAILABLE"
      );
    });
  }

  test("a consent-scope refusal stays a recipient-side failure", () => {
    expect(documentDeliveryFailureReason("CONSENT_SCOPE_REQUIRED")).toBe(
      "RECIPIENT_SUPPRESSED"
    );
  });
});

describe("commerce keeps no sender or provider logic of its own (template boundary)", () => {
  const files = filesUnder(SRC).filter((file) => !file.includes("/tests/"));

  test("no commerce source file mentions StarSender", () => {
    const hits = files.filter((file) =>
      /starsender/i.test(readFileSync(file, "utf8"))
    );

    expect(hits).toEqual([]);
  });

  test("the upstream enqueue builds its port input without a sender", () => {
    const source = readFileSync(
      join(SRC, "application", "whatsapp-upstream-enqueue.ts"),
      "utf8"
    );
    // Strip comments: the docblock may talk about senders, the code may not pass one.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    expect(code).not.toMatch(
      /senderAccountId|inReplyToMessageId|businessScope/
    );
  });

  test("no commerce route or input type accepts a sender from a request", () => {
    const hits = files.filter(
      (file) =>
        file.includes("/pages/") === false &&
        /senderAccountId/.test(
          readFileSync(file, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^\s*\/\/.*$/gm, "")
        )
    );

    // `senderAccountId` belongs to the campaign work of #458, which is pending.
    expect(hits).toEqual([]);
  });
});
