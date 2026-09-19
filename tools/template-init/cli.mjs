/**
 * cli.mjs — flag parsing, validation, and interactive prompting for
 * `bun run template:init`, per `docs/template.md`'s CLI reference and
 * ADR-0018 D5.
 *
 * A missing REQUIRED flag prompts for it when stdin is a TTY; otherwise the
 * tool exits `2`, naming every missing flag on one line — see `run.mjs`,
 * which is what actually calls `process.exit`. This module only computes
 * what is missing and, when asked, prompts; it never exits itself, so it
 * stays testable as a pure-ish function.
 */
import { createInterface } from "node:readline/promises";
import { darken, defaultAccent } from "./color.mjs";

/** Long flag name -> camelCase key. */
const FLAG_KEYS = {
  "--nama": "nama",
  "--slug": "slug",
  "--domain": "domain",
  "--profil": "profil",
  "--warna-primer": "warnaPrimer",
  "--warna-sekunder": "warnaSekunder",
  "--warna-aksen": "warnaAksen",
  "--kontak-email": "kontakEmail",
  "--kontak-telepon": "kontakTelepon",
  "--alamat": "alamat"
};

const BOOLEAN_FLAGS = { "--dry-run": "dryRun", "--yes": "yes" };

/** Required flags, in prompt order. */
export const REQUIRED_FLAGS = [
  ["nama", "--nama"],
  ["slug", "--slug"],
  ["domain", "--domain"],
  ["profil", "--profil"],
  ["warnaPrimer", "--warna-primer"],
  ["kontakEmail", "--kontak-email"]
];

export const PROFILES = ["toko", "berita", "landing"];

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * @param {string[]} argv - `process.argv.slice(2)`
 * @returns {Record<string, string | boolean>}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);

    if (flag in BOOLEAN_FLAGS) {
      out[BOOLEAN_FLAGS[flag]] = true;
      continue;
    }
    if (flag in FLAG_KEYS) {
      const key = FLAG_KEYS[flag];
      if (eq !== -1) {
        out[key] = arg.slice(eq + 1);
      } else {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error(`${flag} requires a value`);
        }
        out[key] = value;
        i++;
      }
      continue;
    }
    if (flag === "--help" || flag === "-h") {
      out.help = true;
      continue;
    }
    throw new Error(`Unknown flag: ${flag}`);
  }
  return out;
}

/**
 * Field-level validation for flags that ARE present (missingness is a
 * separate, prior concern — see {@link REQUIRED_FLAGS}).
 *
 * @param {Record<string, string | boolean>} flags
 * @returns {string[]} human-readable problems, empty when all present
 *   values are well-formed
 */
export function validateFlags(flags) {
  const problems = [];
  if (typeof flags.slug === "string" && !SLUG_RE.test(flags.slug)) {
    problems.push(`--slug ${JSON.stringify(flags.slug)} is not kebab-case (a-z, 0-9, single hyphens)`);
  }
  if (typeof flags.profil === "string" && !PROFILES.includes(flags.profil)) {
    problems.push(`--profil must be one of ${PROFILES.join("|")}, got ${JSON.stringify(flags.profil)}`);
  }
  if (typeof flags.warnaPrimer === "string" && !HEX_RE.test(flags.warnaPrimer)) {
    problems.push(`--warna-primer ${JSON.stringify(flags.warnaPrimer)} is not a #rrggbb hex colour`);
  }
  if (typeof flags.warnaSekunder === "string" && !HEX_RE.test(flags.warnaSekunder)) {
    problems.push(`--warna-sekunder ${JSON.stringify(flags.warnaSekunder)} is not a #rrggbb hex colour`);
  }
  if (typeof flags.warnaAksen === "string" && !HEX_RE.test(flags.warnaAksen)) {
    problems.push(`--warna-aksen ${JSON.stringify(flags.warnaAksen)} is not a #rrggbb hex colour`);
  }
  if (typeof flags.kontakEmail === "string" && !EMAIL_RE.test(flags.kontakEmail)) {
    problems.push(`--kontak-email ${JSON.stringify(flags.kontakEmail)} is not a plausible e-mail address`);
  }
  if (typeof flags.domain === "string" && !DOMAIN_RE.test(flags.domain)) {
    problems.push(`--domain ${JSON.stringify(flags.domain)} is not a plausible domain name`);
  }
  return problems;
}

/**
 * @param {Record<string, string | boolean>} flags
 * @returns {string[]} the required flag NAMES (e.g. `--nama`) missing from `flags`
 */
export function missingRequired(flags) {
  return REQUIRED_FLAGS.filter(([key]) => flags[key] === undefined).map(([, name]) => name);
}

/**
 * Prompts on stdin, in order, for every required flag `flags` is missing.
 * Mutates nothing; returns a new, filled object. Caller decides whether
 * stdin is even a TTY before calling this — see `run.mjs`.
 *
 * @param {Record<string, string | boolean>} flags
 * @returns {Promise<Record<string, string | boolean>>}
 */
export async function promptForMissing(flags) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const filled = { ...flags };
  try {
    for (const [key, name] of REQUIRED_FLAGS) {
      if (filled[key] !== undefined) continue;
      let answer = "";
      while (!answer) {
        // eslint-disable-next-line no-await-in-loop -- an interactive prompt is inherently sequential
        answer = (await rl.question(`${name}: `)).trim();
      }
      filled[key] = answer;
    }
  } finally {
    rl.close();
  }
  return filled;
}

/**
 * Fills the two optional colours from `--warna-primer` when not given —
 * `docs/template.md`'s own documented defaulting behaviour.
 *
 * @param {Record<string, string | boolean>} flags
 * @returns {Record<string, string | boolean>}
 */
export function applyColorDefaults(flags) {
  const next = { ...flags };
  if (typeof next.warnaPrimer === "string") {
    if (next.warnaSekunder === undefined) next.warnaSekunder = darken(next.warnaPrimer);
    if (next.warnaAksen === undefined) next.warnaAksen = defaultAccent();
  }
  return next;
}

export const USAGE = `bun run template:init \\
  --nama "Toko Contoh" \\
  --slug toko-contoh \\
  --domain toko-contoh.id \\
  --profil toko|berita|landing \\
  --warna-primer "#0ea5e9" \\
  [--warna-sekunder "#0369a1"] \\
  [--warna-aksen "#f59e0b"] \\
  --kontak-email owner@toko-contoh.id \\
  [--kontak-telepon "+62 812-0000-0000"] \\
  [--alamat "Jl. Contoh No. 1, Kota Contoh"] \\
  [--dry-run] \\
  [--yes]

See docs/template.md for the full CLI reference.`;
