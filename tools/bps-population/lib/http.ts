/**
 * A deliberately slow, honest HTTP client for bps.go.id.
 *
 * One request at a time, at least MIN_INTERVAL_MS between the end of one request and the start of the next,
 * exponential backoff on 429/5xx/network errors, and a hard stop (ChallengeError) on 403 or a Cloudflare
 * challenge. It never tries to get around a challenge: no stealth, no proxy, no cookie replay.
 */
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { detectJsonError, isChallenge, isPdf } from "./parse";

export const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export class ChallengeError extends Error {
  constructor(public readonly url: string, public readonly status: number) {
    super(`BPS answered ${status} / a challenge for ${url}; stopping, not bypassing`);
    this.name = "ChallengeError";
  }
}

export interface ClientOptions {
  minIntervalMs?: number;
  backoffMs?: number[];
  /** Pauses before retrying a 403/challenge, one retry per entry. */
  challengePausesMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface TextResponse {
  status: number;
  text: string;
}

export interface DownloadResult {
  kind: "pdf" | "json-error" | "other";
  bytes: number;
  sha256: string | null;
  detail: string | null;
}

export class PoliteClient {
  readonly minIntervalMs: number;
  private readonly backoff: number[];
  private readonly challengePauses: number[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private lastEnd = 0;
  requests = 0;

  constructor(opts: ClientOptions = {}) {
    this.minIntervalMs = Math.max(2000, opts.minIntervalMs ?? 2000);
    this.backoff = opts.backoffMs ?? [10_000, 30_000, 90_000];
    this.challengePauses = opts.challengePausesMs ?? [15 * 60_000, 60 * 60_000];
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  private async gap(): Promise<void> {
    const wait = this.lastEnd + this.minIntervalMs + Math.floor(Math.random() * 400) - this.now();
    if (wait > 0) await this.sleep(wait);
  }

  /**
   * Runs one request with the politeness rules; `read` consumes the response before the gap clock restarts.
   * A 403/challenge is never bypassed: pause 15 minutes and retry that one URL once, then pause 60 minutes
   * and retry once more, then give up with ChallengeError (the caller stops and records it).
   */
  private async run<T>(url: string, init: RequestInit, read: (res: Response) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    let challenges = 0;
    for (let attempt = 0; attempt <= this.backoff.length; ) {
      await this.gap();
      this.requests++;
      let challenged = false;
      try {
        const res = await this.fetchImpl(url, {
          ...init,
          headers: { "User-Agent": USER_AGENT, "Accept-Language": "id,en;q=0.8", ...(init.headers as Record<string, string>) },
          signal: AbortSignal.timeout(120_000),
        });
        if (res.status === 403 || res.headers.get("cf-mitigated")?.toLowerCase() === "challenge") {
          this.lastEnd = this.now();
          await res.body?.cancel();
          challenged = true;
        } else if (res.status === 429 || res.status >= 500) {
          this.lastEnd = this.now();
          lastErr = new Error(`HTTP ${res.status} for ${url}`);
          await res.body?.cancel();
        } else {
          const out = await read(res);
          this.lastEnd = this.now();
          return out;
        }
      } catch (err) {
        this.lastEnd = this.now();
        if (err instanceof ChallengeError) challenged = true;
        else lastErr = err;
      }
      if (challenged) {
        const pause = this.challengePauses[challenges];
        if (pause === undefined) throw new ChallengeError(url, 403);
        challenges++;
        console.error(`challenge/403 for ${url}: pausing ${pause / 60_000} min, then retrying once`);
        await this.sleep(pause);
        continue;
      }
      const delay = this.backoff[attempt];
      attempt++;
      if (delay === undefined) break;
      await this.sleep(delay);
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async getText(url: string, extraHeaders: Record<string, string> = {}): Promise<TextResponse> {
    return this.run(url, { headers: extraHeaders }, async (res) => {
      const text = await res.text();
      if (isChallenge(res.status, res.headers, text.slice(0, 4000))) throw new ChallengeError(url, res.status);
      return { status: res.status, text };
    });
  }

  async postText(url: string, body: string, headers: Record<string, string>): Promise<TextResponse> {
    return this.run(url, { method: "POST", body, headers }, async (res) => {
      const text = await res.text();
      if (isChallenge(res.status, res.headers, text.slice(0, 4000))) throw new ChallengeError(url, res.status);
      return { status: res.status, text };
    });
  }

  /**
   * Streams a download to `dest` (via dest + ".part", renamed only for a real PDF), hashing as it goes.
   * A JSON error body or anything that is not a PDF is discarded and reported, never kept as a PDF.
   */
  async downloadPdf(url: string, dest: string): Promise<DownloadResult> {
    mkdirSync(dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    return this.run(url, {}, async (res) => {
      if (res.status !== 200 || !res.body) {
        await res.body?.cancel();
        return { kind: "other", bytes: 0, sha256: null, detail: `HTTP ${res.status}` } satisfies DownloadResult;
      }
      const hash = createHash("sha256");
      const writer = Bun.file(part).writer();
      let total = 0;
      let first: Uint8Array | null = null;
      const small: Uint8Array[] = [];
      for await (const chunk of res.body) {
        if (first === null) {
          first = chunk;
          if (!isPdf(chunk)) {
            // Not a PDF: read the (small) rest, classify, and discard.
            small.push(chunk);
            continue;
          }
        } else if (!isPdf(first)) {
          small.push(chunk);
          if (small.reduce((n, c) => n + c.length, 0) > 1_000_000) break;
          continue;
        }
        hash.update(chunk);
        writer.write(chunk);
        total += chunk.length;
      }
      await writer.end();
      if (first !== null && !isPdf(first)) {
        rmSync(part, { force: true });
        const all = Buffer.concat(small);
        const err = detectJsonError(all);
        return { kind: err ? "json-error" : "other", bytes: all.length, sha256: null, detail: err ?? "not a PDF" } satisfies DownloadResult;
      }
      if (total === 0) {
        rmSync(part, { force: true });
        return { kind: "other", bytes: 0, sha256: null, detail: "empty body" } satisfies DownloadResult;
      }
      renameSync(part, dest);
      return { kind: "pdf", bytes: total, sha256: hash.digest("hex"), detail: null } satisfies DownloadResult;
    });
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}

/** `pdfinfo <path>` via an argv array; returns the page count or null when pdfinfo cannot read the file. */
export async function pdfPages(path: string): Promise<number | null> {
  const p = Bun.spawn(["pdfinfo", path], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  if (code !== 0) return null;
  const m = /^Pages:\s+(\d+)/m.exec(out);
  return m ? Number(m[1]) : null;
}
