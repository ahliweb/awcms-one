/**
 * Reads build-time configuration.
 *
 * ## Why not just `import.meta.env`
 *
 * Astro exposes `import.meta.env` in both client and server code, but Vite
 * only statically REPLACES the variables it knows it must — anything not
 * prefixed `PUBLIC_` can end up as `undefined` inside a prerender chunk even
 * though the value is sitting right there in `.env`. That is exactly the
 * failure mode this app must not have: a private variable that silently
 * reads as unset produces a build that fails for a reason ("no catalog
 * configured") that has nothing to do with the actual mistake.
 *
 * `process.env` is authoritative during `astro build`, which is the only
 * place these values are read — this app is `output: "static"` (issue #5),
 * so there is no request-time server to worry about. `import.meta.env` is
 * kept as a fallback so `astro dev` behaves identically.
 *
 * Never read a secret through anything that could reach the client. Nothing
 * here is `PUBLIC_`-prefixed, and nothing here should become so.
 */

type EnvSource = Record<string, string | undefined>;

/** The merged view, `process.env` winning. Exported so callers can test the chain. */
export function envSource(): EnvSource {
  const viteEnv = (import.meta.env ?? {}) as unknown as EnvSource;
  const nodeEnv =
    typeof process !== "undefined" && process.env
      ? (process.env as EnvSource)
      : {};

  return { ...viteEnv, ...nodeEnv };
}

export function readEnv(name: string): string | undefined {
  const value = envSource()[name];
  const trimmed = typeof value === "string" ? value.trim() : undefined;
  return trimmed ? trimmed : undefined;
}

export function readEnvOr(name: string, fallback: string): string {
  return readEnv(name) ?? fallback;
}
