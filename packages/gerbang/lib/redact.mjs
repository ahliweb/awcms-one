/**
 * redact.mjs — the one place `tools/deploy/*.sh` gets its log/audit redaction
 * from (issue #224). Root-owned, workspace-agnostic, side-effect-free on
 * import (AGENTS.md's "packages/gerbang/lib/ modules are side-effect free").
 *
 * ## Why a second redactor, next to `apps/cms`'s own
 *
 * `apps/cms/scripts/commerce-deploy-preflight.ts` already exports a
 * `redact()` (issue #205) that this repository's `docs/deployment.md`
 * documents. It is `apps/cms`-internal, embedded upstream code — this
 * repository's own workspace-boundary rule ("Nothing outside `apps/cms/`
 * should depend on `apps/cms`'s internals") forbids a root-owned script from
 * importing it directly, and it is written for env-VARIABLE-shaped input
 * (`NAME=value`), not for the free-form stdout/stderr lines
 * `docker compose`, `git`, and `psql` produce. `tools/deploy/*.sh` needs a
 * redactor over arbitrary TEXT, so this module exists once, here, and every
 * deploy script imports it (via `tools/deploy/redact-log.mjs`) rather than
 * re-declaring the same patterns — the exact rule
 * `tests/standar-skrip.test.mjs` already enforces for `packages/gerbang/lib/`
 * and `tools/`.
 *
 * ## What is masked, and why each pattern earns its place
 *
 *   - **A DSN's password** — `scheme://user:PASSWORD@host` — matches any
 *     `://` URL with credentials, not only `postgres://`, since a deploy
 *     transaction's own diagnostics can carry an off-site SSH target
 *     (`user@host:path`, handled separately below) or a webhook URL.
 *   - **A bearer/API-token-shaped value** — `Bearer <token>`,
 *     `Authorization: <scheme> <token>`, or a long token-shaped run of
 *     characters following `token=`/`key=`/`secret=`/`password=` (case
 *     insensitive, `=` or `:`).
 *   - **An `SSH_TARGET`/`user@host:path` off-site copy target's user@host is
 *     left visible** (it is not a secret) but a `-i <keyfile>`-style path
 *     argument is not itself masked either — the KEY's bytes never reach a
 *     log line in the first place (compose `secrets:`/file-backed env vars),
 *     so there is nothing here for this module to catch; it exists as a
 *     defence in depth for a value that should never arrive, not the only
 *     control.
 *   - **An env-assignment line whose NAME matches
 *     `/PASSWORD|SECRET|TOKEN|KEY|DSN|DATABASE_URL/i`** — the same name
 *     heuristic `apps/cms`'s own `redact()` uses (issue #205), applied here
 *     to a full `NAME=value` line rather than to a bare value, since deploy
 *     scripts print `printenv`-shaped diagnostics on failure.
 *
 * A benign value — a role name, a provider name, a plain `https://` origin
 * with no credentials in it — passes through unchanged; `tests/redact.test.mjs`
 * pins that down alongside the redaction itself.
 */

const CREDENTIAL_URL = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:\/\s@]+:)([^@\s]+)(@)/g;

const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;

const KEY_VALUE_SECRET = /\b((?:token|key|secret|password|api[_-]?key)\s*[:=]\s*)("?)([^\s"',;]{4,})("?)/gi;

const ENV_LINE_SECRET_NAME = /(PASSWORD|SECRET|TOKEN|KEY|DSN|DATABASE_URL)/i;

/**
 * Redact a single line of text. Pure — no I/O.
 *
 * @param {string} line
 * @returns {string}
 */
export function redactLine(line) {
  const eq = line.indexOf("=");
  if (eq > 0) {
    const name = line.slice(0, eq).trim();
    // A bare, single-token NAME (no spaces) that looks like an env
    // assignment and whose name matches the secret heuristic is redacted
    // wholesale — the value half of an env line is exactly what a `printenv`
    // or `docker inspect`-style diagnostic dump would print.
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && ENV_LINE_SECRET_NAME.test(name)) {
      return `${name}=***REDACTED***`;
    }
  }

  return line
    .replace(CREDENTIAL_URL, (_match, prefix, _password, at) => `${prefix}***REDACTED***${at}`)
    .replace(BEARER, (match) => `${match.split(/\s+/)[0]} ***REDACTED***`)
    .replace(KEY_VALUE_SECRET, (_match, prefix, openQuote, _value, closeQuote) => `${prefix}${openQuote}***REDACTED***${closeQuote}`);
}

/**
 * Redact every line of a multi-line text block.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactText(text) {
  return text.split("\n").map(redactLine).join("\n");
}
