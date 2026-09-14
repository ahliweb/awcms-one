/**
 * lockfile.mjs — reading `bun.lock`, which is JSONC and not JSON.
 *
 * `tools/cek-lockfile.mjs` is the only caller today. The scanner is kept in
 * its own module rather than inlined there because it is exactly the kind of
 * helper that gets a second copy the day a second script needs the same
 * read — `ahliweb/media-lenterakalteng`'s own `packages/gerbang/lib/lockfile.mjs`
 * exists because its two copies (in that repo's lockfile gate and its SBOM
 * generator) had drifted into asymmetric test coverage before anyone
 * noticed. Starting from one module here means that drift has nowhere to
 * begin.
 */

/**
 * Strip JSONC trailing commas so `JSON.parse` accepts the text.
 *
 * A regex is the wrong tool and was rejected: a comma inside a string
 * literal (`"a, b"`) matches the same shape as a structural one, so a naive
 * `,\s*([}\]])` replacement corrupts data it was never meant to touch. This
 * scanner tracks string and escape state, and drops a comma only when it is
 * genuinely outside a string and followed by `}` or `]`.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripTrailingCommas(text) {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];

    if (inString) {
      result += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }

    if (c === '"') {
      inString = true;
      result += c;
      continue;
    }

    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === "}" || text[j] === "]") continue;
    }

    result += c;
  }

  return result;
}
