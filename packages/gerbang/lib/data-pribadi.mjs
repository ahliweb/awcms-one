/**
 * data-pribadi.mjs — the checks behind `audit:data-pribadi`.
 *
 * ## What this module is, and is not
 *
 * Pure functions over strings and path lists: no filesystem, no git, no
 * output. `audit-data-pribadi.mjs` does the I/O and prints; the patterns and
 * placeholder lists live in `data-pribadi-config.mjs` and are passed in as
 * `config`, so a test (or a derived product) can substitute its own.
 *
 * ## The one rule every function here follows
 *
 * A finding carries a path, a line number and a category — **never the
 * matched value**. The gate exists to keep personal data out of the tree; a
 * report that echoed it into CI logs and PR comments would copy the leak into
 * a second place that cannot be rewritten.
 *
 * ## What it deliberately does not do
 *
 * It does not look for names or addresses in free text (no pattern can tell
 * a person's name from a word), and it does not read git history (that is an
 * opt-in diagnostic of the gate script, not of this module).
 */
import * as defaults from "./data-pribadi-config.mjs";

/**
 * @typedef {{ line: number, category: string }} LineFinding
 * @typedef {{ path: string, line: number, category: string }} Finding
 * @typedef {{ path: string, category: string, line?: number, reason: string }} AllowEntry
 */

/** The config shape every function accepts; defaults to the module's own data. */
const DEFAULT_CONFIG = defaults;

/**
 * Is `path` one the scan should read? True outside the skipped subtree, and
 * inside it only for a path a derived product declared as its own.
 *
 * @param {string} path - repo-relative, forward slashes
 * @param {typeof DEFAULT_CONFIG} [config]
 * @returns {boolean}
 */
export function isInScope(path, config = DEFAULT_CONFIG) {
  const skipped = config.SKIPPED_PREFIXES.some((prefix) => path.startsWith(prefix));
  if (!skipped) return true;
  return config.OWNED_SUBTREE_PATHS.some((prefix) => path.startsWith(prefix));
}

/**
 * Is `path` a tracked data file by name (spreadsheet, CSV, archive, log,
 * snapshot)?
 *
 * @param {string} path
 * @param {typeof DEFAULT_CONFIG} [config]
 * @returns {boolean}
 */
export function isDataFile(path, config = DEFAULT_CONFIG) {
  const lower = path.toLowerCase();
  if (config.DATA_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  const segments = lower.split("/");
  return config.DATA_DIRECTORY_SEGMENTS.some((segment) => segments.includes(segment));
}

/** Longest run of consecutive ascending or descending digits in `digits`. */
function longestSequentialRun(digits) {
  let best = 1;
  let up = 1;
  let down = 1;
  for (let i = 1; i < digits.length; i += 1) {
    const step = Number(digits[i]) - Number(digits[i - 1]);
    up = step === 1 ? up + 1 : 1;
    down = step === -1 ? down + 1 : 1;
    best = Math.max(best, up, down);
  }
  return best;
}

/** Longest run of one repeated digit in `digits`. */
function longestRepeatedRun(digits) {
  let best = 1;
  let run = 1;
  for (let i = 1; i < digits.length; i += 1) {
    run = digits[i] === digits[i - 1] ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

/**
 * Is this digit string a recognisably fake identifier — a reserved prefix, or
 * a long repetition or counting run such as `00000000` or `12345678`?
 *
 * @param {string} digits
 * @param {{ repeat: number, sequence: number }} limits
 * @returns {boolean}
 */
function looksFake(digits, limits) {
  return (
    longestRepeatedRun(digits) >= limits.repeat || longestSequentialRun(digits) >= limits.sequence
  );
}

/**
 * Is this national-identity-shaped number a reserved or trivially fake one?
 *
 * @param {string} digits
 * @param {typeof DEFAULT_CONFIG} config
 * @returns {boolean}
 */
export function isFakeNationalId(digits, config = DEFAULT_CONFIG) {
  if (config.RESERVED_NATIONAL_ID_PREFIXES.some((prefix) => digits.startsWith(prefix))) return true;
  return looksFake(digits, { repeat: 8, sequence: 8 });
}

/**
 * Is this mobile number recognisably fake (a run of `0000` or `9999`, six or
 * more repeated digits, or a counting run of six)?
 *
 * @param {string} raw - the matched text, separators and all
 * @returns {boolean}
 */
export function isFakePhone(raw) {
  const digits = raw.replace(/\D/g, "");
  // Four zeros or nines in a row is the placeholder idiom (`0000`, `9999`);
  // four of any other digit (`8888`) is a number someone really owns, so a
  // repetition only counts as fake from six.
  if (/0{4}|9{4}/.test(digits)) return true;
  return looksFake(digits, { repeat: 6, sequence: 6 });
}

/**
 * Is `domain` a placeholder: equal to or under a listed domain, or ending in
 * a reserved TLD?
 *
 * @param {string} domain
 * @param {typeof DEFAULT_CONFIG} [config]
 * @returns {boolean}
 */
export function isPlaceholderDomain(domain, config = DEFAULT_CONFIG) {
  const lower = domain.toLowerCase();
  const tld = lower.slice(lower.lastIndexOf(".") + 1);
  if (config.PLACEHOLDER_EMAIL_TLDS.includes(tld)) return true;
  return config.PLACEHOLDER_EMAIL_DOMAINS.some(
    (placeholder) => lower === placeholder || lower.endsWith(`.${placeholder}`)
  );
}

/**
 * Scan one text file's content for the content categories. One finding per
 * match (a line with two matches yields two findings); the value is read to
 * decide and then dropped.
 *
 * @param {string} text
 * @param {typeof DEFAULT_CONFIG} [config]
 * @returns {LineFinding[]}
 */
export function scanText(text, config = DEFAULT_CONFIG) {
  /** @type {LineFinding[]} */
  const findings = [];
  const lines = text.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const number = index + 1;

    for (const match of line.matchAll(config.NATIONAL_ID_PATTERN)) {
      if (!isFakeNationalId(match[0], config)) {
        findings.push({ line: number, category: "national-id" });
      }
    }

    for (const match of line.matchAll(config.MOBILE_PHONE_PATTERN)) {
      if (!isFakePhone(match[0])) findings.push({ line: number, category: "mobile-phone" });
    }

    for (const match of line.matchAll(config.EMAIL_PATTERN)) {
      if (
        !isPlaceholderDomain(match[1], config) &&
        !config.PLACEHOLDER_EMAIL_ADDRESSES.includes(match[0].toLowerCase())
      ) {
        findings.push({ line: number, category: "email" });
      }
    }

    for (const { pattern, minIdLength } of config.FILE_SHARE_LINKS) {
      for (const match of line.matchAll(pattern)) {
        if (match[1].length >= minIdLength) {
          findings.push({ line: number, category: "file-share-link" });
        }
      }
    }
  }

  return findings;
}

/**
 * Does `entry` cover `finding`? The entry's `path` is an exact file, or a
 * directory prefix ending in `/`; `line`, when present, pins one line.
 *
 * @param {AllowEntry} entry
 * @param {Finding} finding
 * @returns {boolean}
 */
function covers(entry, finding) {
  if (entry.category !== finding.category) return false;
  const pathMatches = entry.path.endsWith("/")
    ? finding.path.startsWith(entry.path)
    : finding.path === entry.path;
  if (!pathMatches) return false;
  return entry.line === undefined || entry.line === finding.line;
}

/**
 * Validate the allow-list's own shape. An entry with no reason, an unknown
 * category, or a non-integer line is a problem: the reason is the whole point
 * of the file.
 *
 * @param {unknown} entries
 * @param {typeof DEFAULT_CONFIG} [config]
 * @returns {{ index: number, message: string }[]}
 */
export function validateAllowList(entries, config = DEFAULT_CONFIG) {
  if (!Array.isArray(entries)) return [{ index: -1, message: "`entries` must be an array" }];
  /** @type {{ index: number, message: string }[]} */
  const problems = [];
  entries.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      problems.push({ index, message: "entry is not an object" });
      return;
    }
    if (typeof entry.path !== "string" || entry.path === "") {
      problems.push({ index, message: "entry has no `path`" });
    }
    if (!config.CATEGORIES.includes(entry.category)) {
      problems.push({ index, message: `entry has an unknown \`category\` (${config.CATEGORIES.join(", ")})` });
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      problems.push({ index, message: "entry has no `reason`" });
    }
    if (entry.line !== undefined && !Number.isInteger(entry.line)) {
      problems.push({ index, message: "entry `line` must be an integer" });
    }
  });
  return problems;
}

/**
 * Remove allow-listed findings and report the entries that covered nothing.
 * An unused entry is a finding of its own, so the list cannot rot.
 *
 * @param {Finding[]} findings
 * @param {AllowEntry[]} entries - already validated
 * @returns {{ remaining: Finding[], unused: number[] }} `unused` holds entry indexes
 */
export function applyAllowList(findings, entries) {
  const used = new Set();
  const remaining = findings.filter((finding) => {
    let allowed = false;
    entries.forEach((entry, index) => {
      if (covers(entry, finding)) {
        used.add(index);
        allowed = true;
      }
    });
    return !allowed;
  });
  const unused = entries.map((_, index) => index).filter((index) => !used.has(index));
  return { remaining, unused };
}

/**
 * Scan a unified diff (`git log -p`) for the content categories on added
 * lines only. Used by the opt-in `--history` diagnostic.
 *
 * @param {string} diff - `git log -p --unified=0 --format="commit %H"` output
 * @param {typeof DEFAULT_CONFIG} [config]
 * @returns {{ commit: string, path: string, category: string }[]}
 */
export function scanDiff(diff, config = DEFAULT_CONFIG) {
  /** @type {{ commit: string, path: string, category: string }[]} */
  const findings = [];
  let commit = "";
  let path = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("commit ")) {
      commit = line.slice(7, 19);
    } else if (line.startsWith("+++ b/")) {
      path = line.slice(6);
    } else if (line.startsWith("+") && !line.startsWith("+++") && path && isInScope(path, config)) {
      for (const { category } of scanText(line.slice(1), config)) {
        findings.push({ commit, path, category });
      }
      if (isDataFile(path, config) && !findings.some((f) => f.commit === commit && f.path === path && f.category === "tracked-data-file")) {
        findings.push({ commit, path, category: "tracked-data-file" });
      }
    }
  }
  return findings;
}
