/**
 * text.mjs — small, assertive string-surgery helpers `rewriters.mjs` uses so
 * every rewrite is a TARGETED replacement, never a regex loose enough to hit
 * code it was not meant to touch (ADR-0018 D4/D5's own requirement for the
 * `site.ts` rewrite, applied here to every text-based target).
 *
 * Every helper THROWS the moment its assumption about the file's shape does
 * not hold — a occurrence count that is not exactly one, a marker that is
 * missing — rather than silently doing nothing or replacing the wrong spot.
 * `template:init` exits 1 on that throw ("a file the tool expected to
 * rewrite is missing/changed shape"), per `docs/template.md`'s exit-code
 * table — a loud failure here is the point, not a bug.
 */

/**
 * Replace `search` with `replace`, asserting it occurs in `content` exactly
 * once.
 *
 * @param {string} content
 * @param {string} search
 * @param {string} replace
 * @param {string} label - names the file/field, for the thrown message
 * @returns {string}
 */
export function replaceExactlyOnce(content, search, replace, label) {
  const count = content.split(search).length - 1;
  if (count !== 1) {
    throw new Error(
      `${label}: expected exactly one occurrence of ${JSON.stringify(search)}, found ${count}`
    );
  }
  return content.replace(search, replace);
}

/**
 * Replace `search` with `replace` when present exactly once, or return
 * `content` unchanged when `search` is absent entirely — for a target that
 * MAY have already been rewritten to something this tool no longer
 * recognises (never for a target that must always be findable).
 *
 * @param {string} content
 * @param {string} search
 * @param {string} replace
 * @param {string} label
 * @returns {string}
 */
export function replaceIfPresentOnce(content, search, replace, label) {
  const count = content.split(search).length - 1;
  if (count === 0) return content;
  if (count !== 1) {
    throw new Error(
      `${label}: expected at most one occurrence of ${JSON.stringify(search)}, found ${count}`
    );
  }
  return content.replace(search, replace);
}

/**
 * Slice out the substring between a unique `startMarker` and the first
 * `endMarker` that follows it, so a field replacement can be scoped to
 * (say) `DEFAULT_IDENTITY`'s own block without risking a same-named field
 * elsewhere in the file.
 *
 * @param {string} content
 * @param {string} startMarker
 * @param {string} endMarker
 * @param {string} label
 * @returns {{ before: string, block: string, after: string }}
 */
export function extractBlock(content, startMarker, endMarker, label) {
  const startIdx = content.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(`${label}: start marker not found: ${JSON.stringify(startMarker)}`);
  }
  if (content.indexOf(startMarker, startIdx + 1) !== -1) {
    throw new Error(`${label}: start marker is not unique: ${JSON.stringify(startMarker)}`);
  }
  const blockStart = startIdx + startMarker.length;
  const endIdx = content.indexOf(endMarker, blockStart);
  if (endIdx === -1) {
    throw new Error(`${label}: end marker not found after start: ${JSON.stringify(endMarker)}`);
  }
  return {
    before: content.slice(0, blockStart),
    block: content.slice(blockStart, endIdx),
    after: content.slice(endIdx)
  };
}

/**
 * Set a `field: "value"` line inside a block extracted by {@link
 * extractBlock}, preserving whatever leading whitespace already precedes it.
 *
 * @param {string} block
 * @param {string} field
 * @param {string} value
 * @param {string} label
 * @returns {string}
 */
export function setStringField(block, field, value, label) {
  const re = new RegExp(`(\\n\\s*${field}:\\s*)"(?:[^"\\\\]|\\\\.)*"`);
  if (!re.test(block)) {
    throw new Error(`${label}: field "${field}" not found in its expected block`);
  }
  return block.replace(re, (_match, prefix) => `${prefix}${JSON.stringify(value)}`);
}

/**
 * Set a `field: "value"` OR `field: null` line inside a block extracted by
 * {@link extractBlock} — the nullable analogue of {@link setStringField},
 * for a field whose CURRENT value might already be a quoted string (a prior
 * run's own output, or the file's original literal) or the bare `null`
 * literal (a prior run that wrote `null` because its own flag was omitted).
 * `value === null` writes the bare `null` literal, never `"null"` the
 * string — `JSON.stringify(null)` already produces exactly that (`"null"`
 * as TEXT, i.e. the four characters `n`, `u`, `l`, `l`, with no quotes),
 * which is also why this reuses the very same replacement shape
 * {@link setStringField} uses.
 *
 * @param {string} block
 * @param {string} field
 * @param {string | null} value
 * @param {string} label
 * @returns {string}
 */
export function setStringOrNullField(block, field, value, label) {
  const re = new RegExp(`(\\n\\s*${field}:\\s*)(?:"(?:[^"\\\\]|\\\\.)*"|null)`);
  if (!re.test(block)) {
    throw new Error(`${label}: field "${field}" not found in its expected block`);
  }
  return block.replace(re, (_match, prefix) => `${prefix}${JSON.stringify(value)}`);
}

/**
 * Reassemble a block extracted by {@link extractBlock}.
 *
 * @param {{ before: string, block: string, after: string }} extracted
 * @param {string} block
 * @returns {string}
 */
export function withBlock(extracted, block) {
  return `${extracted.before}${block}${extracted.after}`;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace whatever sits between a fixed `prefix` and a fixed `suffix` with
 * `middle` — the idempotency-safe alternative to {@link replaceExactlyOnce}
 * for a value that changes on every run (a name, a domain): the FIRST run
 * matches the original text between those anchors, and every run AFTER
 * that still matches, because the anchors themselves never change even
 * though what is between them now is this tool's own prior output rather
 * than the original. `replaceExactlyOnce` on the original literal value
 * alone cannot do this — once rewritten, that literal is gone, and a
 * SECOND run with different flags would find zero occurrences instead of
 * finding and replacing its own prior output.
 *
 * @param {string} content
 * @param {string} prefix
 * @param {string} suffix
 * @param {string} middle
 * @param {string} label
 * @param {{ dotAll?: boolean }} [opts] - `dotAll`: let `.` match newlines too (multi-line hero text)
 * @returns {string}
 */
export function replaceBetweenAnchors(content, prefix, suffix, middle, label, opts = {}) {
  const re = new RegExp(`${escapeRegExp(prefix)}([\\s\\S]*?)${escapeRegExp(suffix)}`, opts.dotAll ? "s" : "");
  const matches = content.match(new RegExp(re.source, "g"));
  if (!matches || matches.length !== 1) {
    throw new Error(
      `${label}: expected exactly one span between ${JSON.stringify(prefix)} and ${JSON.stringify(suffix)}, found ${matches?.length ?? 0}`
    );
  }
  return content.replace(re, `${prefix}${middle}${suffix}`);
}

/**
 * Replace a `KEY=value` line's value, regardless of what the current value
 * is — the `.env.example` analogue of {@link replaceBetweenAnchors}.
 *
 * @param {string} content
 * @param {string} key
 * @param {string} value
 * @param {string} label
 * @returns {string}
 */
export function setEnvValue(content, key, value, label) {
  const re = new RegExp(`^${escapeRegExp(key)}=.*$`, "m");
  if (!re.test(content)) {
    throw new Error(`${label}: ${key}=... not found`);
  }
  return content.replace(re, `${key}=${value}`);
}

/**
 * Replace exactly one line matching `linePattern` (a RegExp with no `g`
 * flag; matched with `m` added internally) with `replacementLine` — for a
 * whole-line rewrite where the line's OWN shape (not a value inside it) is
 * the identifying feature, e.g. a YAML `  <slug>-pgdata:` key line whose
 * `<slug>` is exactly what is being rewritten and so cannot itself be part
 * of a stable anchor.
 *
 * @param {string} content
 * @param {RegExp} linePattern
 * @param {string} replacementLine
 * @param {string} label
 * @returns {string}
 */
export function replaceLineOnce(content, linePattern, replacementLine, label) {
  const flags = linePattern.flags.includes("m") ? linePattern.flags : `${linePattern.flags}m`;
  const re = new RegExp(linePattern.source, flags);
  const global = new RegExp(linePattern.source, `${flags.includes("g") ? flags : `${flags}g`}`);
  const count = (content.match(global) ?? []).length;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one line matching ${linePattern}, found ${count}`);
  }
  return content.replace(re, replacementLine);
}
