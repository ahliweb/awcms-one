/**
 * Pure scanners shared by the root Bun-only gates (issue #469, ADR-0002):
 * `tests/bun-only-deployment-manifests.test.mjs` (compose, Dockerfiles, ops
 * scripts) and `tests/bun-only-runtime-entrypoints.test.mjs` (package scripts,
 * storefront profiles, queue workers, runtime-smoke script).
 *
 * Nothing here reads the repository or prints: every function takes text and
 * returns findings, so both gates and their in-test fixtures drive the same
 * code. It is a support module, not a test, so `bun test` never collects it.
 */
import { posix } from "node:path";

/** Node-ecosystem launchers. Matched as whole tokens, never as substrings. */
export const NODE_LAUNCHERS = new Set([
  "node",
  "nodejs",
  "npm",
  "npx",
  "pnpm",
  "pnpx",
  "yarn",
  "yarnpkg",
  "tsx",
  "ts-node",
  "ts-node-esm",
  "nodemon",
  "corepack"
]);

/** A `name:tag` is an image only when the tag looks like a version or variant. */
export const IMAGE_TAG_LOOKS_LIKE_VERSION =
  /^(\d|lts|latest|current|alpine|slim|bookworm|trixie|bullseye|iron|jod|hydrogen|krypton)/;

/** `node`, `/usr/bin/node`, `node:22`, `docker.io/library/node@sha256:...` -> "node". */
export function launcherIn(token) {
  if (token === "" || token.startsWith("@") || token.startsWith("-")) return null;
  const noDigest = token.split("@")[0];
  const base = noDigest.slice(noDigest.lastIndexOf("/") + 1);
  const colon = base.indexOf(":");
  const name = colon === -1 ? base : base.slice(0, colon);
  const tag = colon === -1 ? "" : base.slice(colon + 1);
  if (!NODE_LAUNCHERS.has(name)) return null;
  // `node:fs` is a built-in import specifier; `node:22` is an image.
  if (tag !== "" && !IMAGE_TAG_LOOKS_LIKE_VERSION.test(tag)) return null;
  return name;
}

export function countOf(text, char) {
  return text.split(char).length - 1;
}

/** Strip a trailing ` # comment` when the text before it has balanced quotes. */
export function stripComment(line) {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === "#" && (i === 0 || /\s/.test(line[i - 1] ?? ""))) {
      const before = line.slice(0, i);
      if (countOf(before, "'") % 2 === 0 && countOf(before, '"') % 2 === 0) return before;
    }
  }
  return line;
}

/** Split a line into candidate command words, keeping `:` (image tags) intact. */
export function tokensOf(line) {
  return line
    .replace(/\$\(|\$\{|[;&|(){}`<>=,[\]]/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^["'`]+|["'`]+$/g, ""))
    .filter((token) => token !== "");
}

/**
 * The non-comment, non-blank lines of a file, with trailing comments removed.
 * `skipProse` also drops `echo` / `printf` / `log` lines: user-facing messages
 * that merely mention a runtime are not launches.
 */
export function activeLines(text, { skipProse = false } = {}) {
  const out = [];
  text.split("\n").forEach((raw, index) => {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const withoutChain = trimmed.replace(/^\S+\s*&&\s*/, "");
    if (skipProse && /^(log|echo|printf)\b/.test(withoutChain)) return;
    out.push({ line: index + 1, text: stripComment(raw) });
  });
  return out;
}

/** A `#!` line must not select a Node-ecosystem launcher. */
export function shebangViolations(file, text) {
  if (!text.startsWith("#!")) return [];
  const firstLine = text.split("\n", 1)[0];
  const bad = tokensOf(firstLine.slice(2)).map(launcherIn).find((name) => name);
  return bad
    ? [{ file, line: 1, rule: "no-node-shebang", detail: `shebang "${firstLine}" selects ${bad}, not Bun` }]
    : [];
}

/**
 * Every Node-ecosystem launcher word in shell, crontab, systemd or Dockerfile
 * text. Not for JS source: there a bare `node` token is a variable, not a launch.
 */
export function launcherViolations(file, text, { skipProse = false } = {}) {
  const violations = [...shebangViolations(file, text)];
  for (const { line, text: code } of activeLines(text, { skipProse })) {
    for (const token of tokensOf(code)) {
      const name = launcherIn(token);
      if (name) {
        violations.push({
          file,
          line,
          rule: "no-node-launcher",
          detail: `"${token}" launches ${name}, not Bun (ADR-0002)`
        });
      }
    }
  }
  return violations;
}

/** A quoted launcher name in JS source (`spawn("npm", ...)`), outside comments. */
export const JS_LITERAL = /(["'`])(node|nodejs|npm|npx|pnpm|pnpx|yarn|yarnpkg|tsx|ts-node|nodemon|corepack)\1/g;

export function jsLiteralViolations(file, text) {
  const violations = [];
  text.split("\n").forEach((raw, index) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(raw)) return;
    for (const match of raw.matchAll(JS_LITERAL)) {
      violations.push({
        file,
        line: index + 1,
        rule: "no-node-launcher",
        detail: `"${match[2]}" literal names a Node launcher, not Bun`
      });
    }
  });
  return violations;
}

/** `ARG NAME=value` defaults, so `${BUN_VERSION}` can be resolved. */
export function argDefaults(text) {
  const map = {};
  for (const { text: line } of activeLines(text)) {
    const match = /^ARG\s+(\w+)=(\S+)/.exec(line.trim());
    if (match) map[match[1]] = match[2];
  }
  return map;
}

export function expand(value, vars) {
  return value.replace(/\$\{(\w+)\}|\$(\w+)/g, (whole, braced, bare) => {
    const name = braced ?? bare;
    return Object.hasOwn(vars, name) ? vars[name] : whole;
  });
}

/** True when an image tag is exactly the pin, with an optional variant suffix. */
export function isPinnedTag(tag, pin) {
  const match = /^(\d+\.\d+\.\d+)(?:-[a-z][a-z0-9.-]*)?$/.exec(tag);
  return match !== null && match[1] === pin;
}

/**
 * Every Bun version pin in a manifest must equal `pin`: `oven/bun:<tag>`
 * (floating or unresolvable tags fail), `BUN_VERSION=<x>` and `bun@<x>` /
 * `bun-v<x>` install pins. Comments are ignored.
 */
export function pinViolations(file, text, pin) {
  const violations = [];
  const vars = argDefaults(text);
  const report = (line, detail) =>
    violations.push({ file, line, rule: "bun-pin", detail });

  for (const { line, text: code } of activeLines(text)) {
    for (const match of code.matchAll(/oven\/bun(?::([^\s"'`,\]]*))?/g)) {
      if (match[1] === undefined || match[1] === "") {
        report(line, "`oven/bun` without a tag floats; pin it to the packageManager version");
        continue;
      }
      const resolved = expand(match[1], vars);
      if (resolved.includes("$")) {
        report(line, `oven/bun tag "${match[1]}" cannot be resolved to a literal version`);
      } else if (!isPinnedTag(resolved, pin)) {
        report(line, `oven/bun:${resolved} is not the pinned Bun ${pin}`);
      }
    }
    for (const match of code.matchAll(/BUN_VERSION\s*[:=]\s*["']?(\d+\.\d+\.\d+)/g)) {
      if (match[1] !== pin) report(line, `BUN_VERSION ${match[1]} is not the pinned Bun ${pin}`);
    }
    for (const match of code.matchAll(/bun@(\d+\.\d+\.\d+)/g)) {
      if (match[1] !== pin) report(line, `bun@${match[1]} is not the pinned Bun ${pin}`);
    }
    for (const match of code.matchAll(/bun-v(\d+\.\d+\.\d+)/g)) {
      if (match[1] !== pin) report(line, `bun-v${match[1]} is not the pinned Bun ${pin}`);
    }
  }
  return violations;
}

/** Dockerfile instructions, with `\` continuations joined and comments removed. */
export function dockerInstructions(text) {
  const out = [];
  let buffer = "";
  for (const { text: line } of activeLines(text)) {
    const trimmed = line.trim();
    if (trimmed.endsWith("\\")) {
      buffer += `${trimmed.slice(0, -1)} `;
      continue;
    }
    buffer += trimmed;
    const match = /^(\w+)\s*([\s\S]*)$/.exec(buffer);
    if (match) out.push({ keyword: match[1].toUpperCase(), args: match[2].trim() });
    buffer = "";
  }
  return out;
}

export const JS_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/** The words a launch line names: a JSON array form or a shell form. */
export function launchWords(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed).map(String);
    } catch {
      // Not valid JSON: fall through to the shell form.
    }
  }
  return trimmed.split(/\s+/).filter((word) => word !== "");
}

/**
 * A launch that names a JS file must be started by `bun`. The first word is
 * the launcher; `CMD` / `CMD-SHELL` markers from a compose healthcheck are not.
 */
export function jsLaunchViolations(file, label, value) {
  const words = launchWords(value).filter((word) => word !== "CMD" && word !== "CMD-SHELL");
  if (words.some((word) => JS_FILE.test(word)) && words[0] !== "bun") {
    return [
      {
        file,
        line: 0,
        rule: "bun-launcher",
        detail: `${label} runs a JavaScript file via "${words[0] ?? ""}", not bun`
      }
    ];
  }
  return [];
}

/** Final-stage check for one Dockerfile: base image pinned, launcher is bun. */
export function dockerfileStageViolations(file, text, pin) {
  const instructions = dockerInstructions(text);
  const froms = instructions.filter((instruction) => instruction.keyword === "FROM");
  if (froms.length === 0) {
    return [{ file, line: 0, rule: "bun-final-stage", detail: "no FROM instruction" }];
  }
  const vars = argDefaults(text);
  const last = froms.at(-1);
  const base = expand(last.args.split(/\s+/)[0], vars);
  const violations = [];
  const basePinned = base.startsWith("oven/bun:") && isPinnedTag(base.slice("oven/bun:".length), pin);
  if (!basePinned) {
    violations.push({
      file,
      line: 0,
      rule: "bun-final-stage",
      detail: `final stage base "${base}" is not oven/bun:${pin}`
    });
  }
  const finalStage = instructions.slice(instructions.indexOf(last));
  for (const instruction of finalStage) {
    if (instruction.keyword === "CMD" || instruction.keyword === "ENTRYPOINT") {
      violations.push(...jsLaunchViolations(file, instruction.keyword, instruction.args));
    }
    // HEALTHCHECK wraps its launch as `... CMD <launcher> ...`.
    if (instruction.keyword === "HEALTHCHECK" && /\bCMD\s/.test(instruction.args)) {
      const launch = instruction.args.slice(instruction.args.search(/\bCMD\s/) + 4);
      violations.push(...jsLaunchViolations(file, "HEALTHCHECK", launch));
    }
  }
  return violations;
}


// ---------------------------------------------------------------------------
// Package scripts and Dockerfile stage chains (issue #469, residuals 1-3)
// ---------------------------------------------------------------------------

/** `a && b || c; d | e` -> the individual commands, trimmed, in order. */
export function scriptSegments(script) {
  return script
    .split(/&&|\|\||;|\|/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
}

/** The words of one command, with leading `NAME=value` and `exec` removed. */
function commandWords(segment) {
  const words = segment.split(/\s+/);
  let index = 0;
  while (index < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]) || words[index] === "exec")) {
    index += 1;
  }
  return words.slice(index);
}

/** `bun` subcommands that are Bun's own, never a package bin run through a shebang. */
const BUN_SUBCOMMANDS = new Set([
  "install", "i", "add", "a", "remove", "rm", "update", "outdated", "audit", "pm", "test",
  "build", "link", "unlink", "publish", "patch", "init", "create", "repl", "upgrade",
  "completions", "why", "info", "exec", "pack", "feedback"
]);

/** Bun flags that consume the next word as their value. */
const BUN_VALUE_FLAGS = new Set(["--cwd", "--filter", "-F", "--config", "-c", "--env-file"]);

/** Build output a script runs but the working tree does not hold until it is built. */
const GENERATED_OUTPUT = /(^|\/)(dist|\.astro|build)\//;

/** `ctx.exists`, except that a path under a build-output directory is assumed to exist. */
function fileExists(ctx, path) {
  return GENERATED_OUTPUT.test(path) || ctx.exists(path);
}

/** Words that name a file to run rather than a package bin. */
const RUNNABLE_FILE = /\.(?:[cm]?[jt]s|[jt]sx|sh)$/;

/**
 * Findings for one `package.json`'s scripts. A script is Bun end to end when:
 *
 * - every command starts with `bun`, or is `cd`, `bash <file>` or `docker ...`;
 * - a bare package bin (`astro`, `tsc`, `playwright`) is only ever run through
 *   `bun --bun <bin>`, because without `--bun` Bun honours the bin's
 *   `#!/usr/bin/env node` shebang and starts a Node process;
 * - `bun run <name>` names a script that exists in the package it runs in
 *   (following `cd`), and a file named on the command line exists and has no
 *   Node shebang;
 * - no word anywhere is a Node-ecosystem launcher.
 *
 * `ctx.scriptsOf(dir)` returns the scripts of the package at `dir` (or null),
 * `ctx.exists(path)` and `ctx.shebangOf(path)` read the working tree.
 */
export function packageScriptViolations(file, dir, scripts, ctx) {
  const violations = [];
  const report = (name, rule, detail) =>
    violations.push({ file: `${file}#scripts.${name}`, line: 0, rule, detail });

  for (const [name, script] of Object.entries(scripts)) {
    let cwd = dir;
    for (const segment of scriptSegments(script)) {
      const words = commandWords(segment);
      const first = words[0] ?? "";

      for (const token of tokensOf(segment)) {
        const launcher = launcherIn(token);
        if (launcher) report(name, "no-node-launcher", `"${token}" launches ${launcher}, not Bun (ADR-0002)`);
      }

      if (first === "cd") {
        cwd = posix.normalize(posix.join(cwd, words[1] ?? "."));
        continue;
      }
      if (first === "docker") continue;
      if (first === "bash") {
        const target = words.slice(1).find((word) => !word.startsWith("-"));
        if (target && !fileExists(ctx, posix.join(cwd, target))) {
          report(name, "script-file-exists", `bash script "${target}" does not exist from ${cwd || "."}`);
        }
        continue;
      }
      if (first !== "bun") {
        report(name, "bun-launcher", `command "${segment}" starts with "${first}", not bun`);
        continue;
      }

      // bun [flags] <subcommand | file | bin> ...
      const flags = [];
      const positional = [];
      for (let i = 1; i < words.length; i += 1) {
        const word = words[i];
        if (word === "-e" || word === "--eval" || word === "-p" || word === "--print") break;
        if (word.startsWith("-")) {
          flags.push(word);
          if (BUN_VALUE_FLAGS.has(word)) i += 1;
        } else {
          positional.push(word);
        }
      }
      const viaBun = flags.includes("--bun");
      let [head, ...rest] = positional;
      if (head === undefined) continue; // `bun -e ...`, `bun --version`
      if (head === "x" || head === "bunx") {
        if (!viaBun) {
          report(name, "bun-bin-needs-bun-flag", `"${segment}" runs a package bin without --bun, so its shebang may start Node`);
        }
        continue;
      }
      if (head === "run") {
        [head, ...rest] = rest;
        if (head === undefined) continue;
        const known = ctx.scriptsOf(cwd);
        if (known && Object.hasOwn(known, head)) continue;
        if (RUNNABLE_FILE.test(head)) {
          if (!fileExists(ctx, posix.join(cwd, head))) {
            report(name, "script-file-exists", `"${head}" does not exist from ${cwd || "."}`);
          }
          continue;
        }
        if (!viaBun) {
          report(
            name,
            "bun-bin-needs-bun-flag",
            `"bun run ${head}" is neither a script of ${cwd || "."} nor run with --bun, so a bin shebang may start Node`
          );
        }
        continue;
      }
      if (BUN_SUBCOMMANDS.has(head)) continue;
      if (RUNNABLE_FILE.test(head) || head.includes("/")) {
        const path = posix.join(cwd, head);
        if (!fileExists(ctx, path)) {
          report(name, "script-file-exists", `"${head}" does not exist from ${cwd || "."}`);
        } else if (!GENERATED_OUTPUT.test(path)) {
          const shebang = ctx.shebangOf(path);
          if (shebang) {
            for (const violation of shebangViolations(path, `${shebang}\n`)) {
              report(name, violation.rule, violation.detail);
            }
          }
        }
        continue;
      }
      // `bun <name>` is `bun run <name>`.
      const known = ctx.scriptsOf(cwd);
      if (!(known && Object.hasOwn(known, head)) && !viaBun) {
        report(name, "bun-bin-needs-bun-flag", `"${segment}" is neither a script of ${cwd || "."} nor run with --bun`);
      }
    }
  }
  return violations;
}

/**
 * The chain of base images behind a named build stage, from the stage itself to
 * the external image it ultimately starts from (`ARG` defaults resolved).
 * Returns `null` when the stage does not exist.
 */
export function dockerStageChain(text, target) {
  const vars = argDefaults(text);
  const stages = new Map();
  for (const instruction of dockerInstructions(text)) {
    if (instruction.keyword !== "FROM") continue;
    const parts = instruction.args.split(/\s+/).filter((part) => !part.startsWith("--"));
    const base = expand(parts[0], vars);
    if (parts[1]?.toUpperCase() === "AS" && parts[2]) stages.set(parts[2], base);
  }
  if (!stages.has(target)) return null;
  const chain = [];
  let current = target;
  while (stages.has(current) && !chain.includes(current)) {
    chain.push(current);
    current = stages.get(current);
  }
  chain.push(current);
  return chain;
}

/**
 * A Node launcher in the position of a command to spawn: the first element of an
 * argv array (`["npm", "ci"]`, `argv: ["node", ...]`) or the first argument of a
 * spawn/exec call (`spawnSync("tsx", ...)`), outside comments. Narrower than
 * `jsLiteralViolations`, which flags any quoted launcher name: here a string
 * like `"npm"` in a type or a label (`source: "github" | "npm"`, the npm
 * REGISTRY) is data, not a launch.
 */
const LAUNCHERS = "node|nodejs|npm|npx|pnpm|pnpx|yarn|yarnpkg|tsx|ts-node|nodemon|corepack";
const SPAWN_LITERAL = new RegExp(
  // spawn("npm", ...) or exec("npm install"): the call's first argument starts with a launcher
  `\\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\\(\\s*(["'\`])(${LAUNCHERS})(?=\\1|\\s)` +
    // ["npm", "ci"] / argv: ["node", ...]: an argv array whose first element is a launcher
    `|\\[\\s*(["'\`])(${LAUNCHERS})\\3(?=\\s*,)`,
  "g"
);

export function spawnLiteralViolations(file, text) {
  const violations = [];
  text.split("\n").forEach((raw, index) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(raw)) return;
    for (const match of raw.matchAll(SPAWN_LITERAL)) {
      violations.push({
        file,
        line: index + 1,
        rule: "no-node-launcher",
        detail: `"${match[2] ?? match[4]}" is spawned as a command, not Bun`
      });
    }
  });
  return violations;
}
