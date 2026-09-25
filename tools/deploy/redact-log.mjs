#!/usr/bin/env bun
/**
 * redact-log.mjs — `bun tools/deploy/redact-log.mjs` (issue #224).
 *
 * A stdin-to-stdout filter: the whole stream is read, redacted line by line
 * through `packages/gerbang/lib/redact.mjs`'s `redactLine()`, and written
 * back out. This is the ONE way `tools/deploy/*.sh` redacts text before it
 * reaches a terminal or the append-only audit log — every script pipes
 * through this file rather than re-declaring the patterns
 * (`tests/standar-skrip.test.mjs`'s "a helper is declared once" rule,
 * applied to this issue's own new code).
 *
 * Reads the whole input before writing any output — a secret token that
 * happened to straddle two stream chunks must never leak by being redacted
 * against only half of itself. A deploy transaction's own log volume (git,
 * docker compose, psql output) is small enough that this costs nothing
 * observable; it never runs against a database dump or a build log.
 *
 * Usage: `<producer> | bun tools/deploy/redact-log.mjs`
 */
import { redactText } from "../../packages/gerbang/lib/redact.mjs";

async function main() {
  const input = await Bun.stdin.text();
  process.stdout.write(redactText(input));
}

await main();
