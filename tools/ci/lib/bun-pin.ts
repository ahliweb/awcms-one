/**
 * bun-pin.ts — the Bun-version gate every local-ci leg runs before doing
 * anything else.
 *
 * `.github/workflows/*.yml` pinned Bun via `oven-sh/setup-bun`'s
 * `bun-version: "1.4.2"`, which always matched the root `package.json`'s
 * `packageManager`/`engines.bun` (AGENTS.md's "Configuration and toolchain":
 * "Raising one without the others makes a local install, CI, and any future
 * container image behave differently — silently"). Local CI has no
 * `setup-bun` step to pin a version for it — it runs on whatever Bun is
 * already on the operator's or the server's PATH — so this module is the
 * replacement: read the pin straight from `package.json`, compare it to the
 * Bun actually running, and fail closed with a clear message rather than
 * silently running a leg under the wrong Bun the way an unpinned
 * self-hosted runner would.
 *
 * Kept here, pure and side-effect free (no filesystem read baked in — the
 * caller passes the already-read `package.json` text), so `tests/
 * ci-bun-pin.test.mjs` and a future `tests/versi-toolchain.test.mjs` (per the
 * #225 plan) can exercise it with fixture strings and no real Bun install at
 * all.
 */

/**
 * Extract the exact Bun version a root `package.json`'s `packageManager`
 * field pins, e.g. `"bun@1.4.2"` -> `"1.4.2"`.
 *
 * @param {string} packageJsonText - the raw text of the root package.json
 * @returns {string} the pinned version
 * @throws {Error} when the field is missing or not in `bun@X.Y.Z` form
 */
export function readPinnedBunVersion(packageJsonText: string): string {
  const parsed = JSON.parse(packageJsonText) as { packageManager?: string };
  const pin = parsed.packageManager;
  if (!pin) {
    throw new Error(
      "package.json has no \"packageManager\" field — cannot enforce the Bun pin. " +
        "See AGENTS.md's \"Configuration and toolchain\"."
    );
  }
  const match = /^bun@(\d+\.\d+\.\d+)$/.exec(pin);
  if (!match) {
    throw new Error(
      `package.json's "packageManager" is "${pin}", not the expected "bun@X.Y.Z" shape.`
    );
  }
  return match[1];
}

export type BunPinResult =
  | { ok: true; version: string }
  | { ok: false; expected: string; actual: string; message: string };

/**
 * Compare the Bun version actually running against the pin in
 * `package.json`. Pure: takes both versions as strings so a caller running
 * this for real passes `Bun.version`, and a test passes a fixture.
 *
 * @param {string} actualVersion - e.g. `Bun.version`
 * @param {string} packageJsonText - the root package.json's raw text
 * @returns {BunPinResult}
 */
export function checkBunPin(actualVersion: string, packageJsonText: string): BunPinResult {
  const expected = readPinnedBunVersion(packageJsonText);
  if (actualVersion === expected) {
    return { ok: true, version: actualVersion };
  }
  return {
    ok: false,
    expected,
    actual: actualVersion,
    message:
      `Bun ${actualVersion} is running, but the root package.json pins bun@${expected} ` +
      `(packageManager / engines.bun — AGENTS.md's "Configuration and toolchain"). ` +
      `Local CI refuses to run a leg under an un-pinned Bun: install ${expected} ` +
      `(e.g. \`bun upgrade --version ${expected}\`) and try again.`
  };
}

/**
 * Fail closed if the running Bun does not match the pin. Every local-ci
 * entrypoint calls this before running any leg.
 *
 * @param {string} packageJsonText
 * @throws {Error} with {@link BunPinResult}'s message, when the pin does not match
 */
export function enforceBunPinOrThrow(packageJsonText: string): void {
  const result = checkBunPin(Bun.version, packageJsonText);
  if (!result.ok) {
    throw new Error(result.message);
  }
}
