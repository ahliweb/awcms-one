/**
 * Deterministic stub-CMS lifecycle for every `*-build-smoke.test.ts` file
 * (and `profil-uji-bersama.ts`'s `buildProfile()`) — the one place that
 * starts `scripts/stub-awcms.mjs`, replacing what used to be a dozen-plus
 * copies of "pick a random port, hope nothing else on this machine is
 * using it yet, poll an HTTP endpoint until it answers or a deadline
 * elapses."
 *
 * ## Why the random-port-plus-poll pattern was unsafe
 *
 * Every smoke test picked `stubPort = <base> + Math.floor(Math.random() *
 * 4000)` — landing inside the SAME 32768–60999 ephemeral range Linux hands
 * out to every outbound client socket a concurrent `astro build` opens
 * (each build makes dozens of requests to its own stub). A `bun test` run
 * that starts many of these builds at once (the root suite's own shape,
 * and CI's shared-runner contention on top of it) can hand out a "free"
 * stub port that the kernel has already bound to a client socket from a
 * DIFFERENT test's build a moment earlier — `Bun.serve` then fails to bind
 * (`EADDRINUSE`) and the stub process exits immediately. The old spawn
 * used `stdout: "pipe", stderr: "pipe"` with NOTHING ever reading either
 * stream, so that exit and its error message were silently buffered and
 * never surfaced anywhere; the calling test's own `waitForStub` helper
 * just polled an HTTP URL until ITS OWN deadline elapsed, which reads
 * byte-for-byte identically whether the stub is merely slow to start or
 * already dead — "stub-awcms did not answer ... in time" either way. Three
 * real CI runs hit this exact shape on three different random ports
 * (issue #147's own two, plus a third on the emblem test, all after this
 * issue's first fix had already removed the OTHER source of contention —
 * three competing full `bun test` runs — proving this was a second,
 * independent cause).
 *
 * ## The fix
 *
 * `STUB_PORT=0` — the same convention `Bun.serve({ port: 0 })` itself
 * documents: the OS hands back a genuinely free ephemeral port, so no
 * collision is even possible — plus reading the stub's OWN startup line
 * (`[stub-awcms] serving fixtures on http://localhost:<port>`,
 * `scripts/stub-awcms.mjs`'s very last line) off its stdout, instead of
 * guessing a port up front and polling for it over HTTP. Readiness becomes
 * an EVENT (that line appeared), not a race against a deadline that
 * cannot distinguish "not ready yet" from "will never be ready".
 * `startStub()` also races that readiness wait against the process's own
 * `exited` promise, so a stub that exits before printing its ready line
 * (a bug, a missing fixture, anything) rejects IMMEDIATELY with whatever
 * it printed on stdout/stderr — not only after the caller's own deadline
 * has elapsed looking exactly like ordinary slowness. `STUB_START_DEADLINE_MS`
 * still applies, as the outer bound on the whole wait, and its error also
 * carries the captured output.
 */
import { STUB_START_DEADLINE_MS } from "./stub-deadline";

const STOREFRONT_ROOT = new URL("../", import.meta.url).pathname;

/** `scripts/stub-awcms.mjs`'s own last line — see that script's final `console.log`. */
const READY_LINE = /serving fixtures on http:\/\/localhost:(\d+)/;

export type StubHandle = {
  /** The real, OS-assigned port the stub bound — never guessed, never reused across a collision. */
  port: number;
  /** The underlying process, for a test that wants to assert on the stub's own behaviour directly. */
  proc: ReturnType<typeof Bun.spawn>;
  /** Kills the stub and waits for it to actually exit — never leaves a zombie process behind. */
  stop: () => Promise<void>;
};

/**
 * Reads `stream` line by line, calling `onLine` for each complete line,
 * until the stream ends. Never throws — a pipe closing mid-read (the
 * process was killed) is not this function's problem to report, the
 * caller already knows the process is gone.
 */
async function pump(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        onLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer) onLine(buffer);
  } catch {
    // See docblock above: a closed pipe from a killed process is expected,
    // not an error worth surfacing.
  }
}

/**
 * Starts `scripts/stub-awcms.mjs` on a real, OS-assigned free port
 * (`STUB_PORT=0`) and resolves once it has printed its own "serving
 * fixtures" line — never before, never by polling an HTTP endpoint.
 * `env` is merged over a copy of `process.env` (a caller can still
 * override `STUB_PORT` explicitly, though no smoke test needs to anymore —
 * the whole point of this helper is that none of them pick their own port
 * any longer). Stdout/stderr keep being drained for the stub's whole
 * lifetime (via `pump`, above) — a full pipe buffer would otherwise block
 * the stub process once it fills, long after this function has returned.
 */
export function startStub(opts: { env?: Record<string, string | undefined> } = {}): Promise<StubHandle> {
  const proc = Bun.spawn(["bun", "scripts/stub-awcms.mjs"], {
    cwd: STOREFRONT_ROOT,
    env: { ...process.env, ...opts.env, STUB_PORT: "0" },
    stdout: "pipe",
    stderr: "pipe"
  });

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const diagnostics = () => `--- stdout ---\n${stdoutLines.join("\n")}\n--- stderr ---\n${stderrLines.join("\n")}`;

  return new Promise<StubHandle>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new Error(`stub-awcms did not print its "serving fixtures" line within ${STUB_START_DEADLINE_MS}ms.\n${diagnostics()}`));
    }, STUB_START_DEADLINE_MS);

    // A stub that exits (a bind failure, a thrown fixture-load error,
    // anything) before printing its ready line rejects IMMEDIATELY — never
    // waits out the deadline above looking exactly like ordinary
    // slowness. `.catch` is not needed: `Bun.Subprocess.exited` resolves
    // (with the exit code), it never rejects.
    proc.exited.then((code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`stub-awcms exited (code ${code}) before it was ready.\n${diagnostics()}`));
    });

    pump(proc.stdout as ReadableStream<Uint8Array>, (line) => {
      stdoutLines.push(line);
      if (settled) return;
      const match = READY_LINE.exec(line);
      if (!match) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        port: Number(match[1]),
        proc,
        stop: async () => {
          proc.kill();
          await proc.exited;
        }
      });
    });

    pump(proc.stderr as ReadableStream<Uint8Array>, (line) => {
      stderrLines.push(line);
    });
  });
}
