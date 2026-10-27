/**
 * The storefront push service worker (issue #431, ADR-0048 section 7 and 6.3,
 * TS-E3): `src/push/pekerja/sw-notifikasi.js`, executed in a `node:vm` context
 * with a fake worker global so what the real worker does on `push` and
 * `notificationclick` is observed, not inferred from its text. A second block
 * pins what the file must NOT contain (the invariants the root guard also
 * enforces).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { PUSH_PURPOSES, PUSH_TARGET_PATHS } from "../src/lib/push-pelanggan";

const WORKER_PATH = new URL("../src/push/pekerja/sw-notifikasi.js", import.meta.url).pathname;
const SOURCE = readFileSync(WORKER_PATH, "utf8");
const ORIGIN = "https://toko.example";

type Listener = (event: any) => void;

type Shown = { title: string; options: Record<string, unknown> };

type Harness = {
  push: (payload: unknown, opts?: { rawData?: "none" | "text" }) => Promise<Shown[]>;
  click: (data: unknown, clients?: FakeClient[]) => Promise<{ opened: string[]; closed: boolean; focused: string[]; navigated: string[] }>;
  listeners: Map<string, Listener>;
  skipWaiting: () => number;
};

type FakeClient = { url: string; focus?: () => Promise<void>; navigate?: (url: string) => Promise<void> };

function load(): Harness {
  const listeners = new Map<string, Listener>();
  const shown: Shown[] = [];
  let skipWaitingCalls = 0;
  const opened: string[] = [];
  let windowClients: FakeClient[] = [];

  const self: Record<string, unknown> = {
    location: new URL(`${ORIGIN}/sw-notifikasi.js`),
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: () => {
      skipWaitingCalls += 1;
    },
    registration: {
      showNotification: (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
        return Promise.resolve();
      }
    },
    clients: {
      matchAll: () => Promise.resolve(windowClients),
      openWindow: (url: string) => {
        opened.push(url);
        return Promise.resolve({});
      }
    }
  };

  const context = createContext({ self, URL, Promise, JSON, Array, String, RegExp, Object });
  runInContext(SOURCE, context);

  return {
    listeners,
    skipWaiting: () => skipWaitingCalls,
    async push(payload, opts = {}) {
      shown.length = 0;
      const waits: Promise<unknown>[] = [];
      const event = {
        data:
          opts.rawData === "none"
            ? null
            : {
                json: () => {
                  if (opts.rawData === "text") throw new SyntaxError("not json");
                  return payload;
                }
              },
        waitUntil: (promise: Promise<unknown>) => waits.push(promise)
      };
      listeners.get("push")!(event);
      await Promise.all(waits);
      return [...shown];
    },
    async click(data, clients = []) {
      windowClients = clients;
      opened.length = 0;
      let closed = false;
      const waits: Promise<unknown>[] = [];
      listeners.get("notificationclick")!({
        notification: { close: () => (closed = true), data },
        waitUntil: (promise: Promise<unknown>) => waits.push(promise)
      });
      await Promise.all(waits);
      return {
        opened: [...opened],
        closed,
        focused: clients.filter((c) => (c as any).__focused).map((c) => c.url),
        navigated: clients.flatMap((c) => (c as any).__navigated ?? [])
      };
    }
  };
}

function trackedClient(url: string): FakeClient {
  const client: any = { url, __navigated: [] as string[] };
  client.focus = () => {
    client.__focused = true;
    return Promise.resolve();
  };
  client.navigate = (target: string) => {
    client.__navigated.push(target);
    return Promise.resolve();
  };
  return client;
}

describe("push: shows exactly one notification from the payload's generic text", () => {
  test("legacy shape", async () => {
    const worker = load();
    const shown = await worker.push({ title: "Pesanan Anda ada pembaruan", body: "Buka akun Anda untuk melihatnya.", targetPath: "/akun/pesanan" });
    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toBe("Pesanan Anda ada pembaruan");
    expect(shown[0]!.options.body).toBe("Buka akun Anda untuk melihatnya.");
    expect((shown[0]!.options.data as { url: string }).url).toBe(`${ORIGIN}/akun/pesanan`);
  });

  test("declarative shape (WebKit, web_push 8030) with an absolute navigate on this origin", async () => {
    const worker = load();
    const shown = await worker.push({
      web_push: 8030,
      notification: { title: "Ada balasan", body: "Buka kotak pesan Anda.", navigate: `${ORIGIN}/akun/pesan`, silent: false, tag: "message" }
    });
    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toBe("Ada balasan");
    expect((shown[0]!.options.data as { url: string }).url).toBe(`${ORIGIN}/akun/pesan`);
    expect(shown[0]!.options.tag).toBe("message");
  });

  test("an empty, missing or unreadable payload still shows ONE generic notification (browsers revoke a site that shows none)", async () => {
    for (const run of [
      (w: Harness) => w.push(null, { rawData: "none" }),
      (w: Harness) => w.push(null, { rawData: "text" }),
      (w: Harness) => w.push({}),
      (w: Harness) => w.push("a string"),
      (w: Harness) => w.push([1, 2]),
      (w: Harness) => w.push({ title: "", body: "   " })
    ]) {
      const shown = await run(load());
      expect(shown).toHaveLength(1);
      expect(shown[0]!.title).toBe("Ada pembaruan dari toko");
      expect(shown[0]!.options.body).toBe("Buka akun Anda untuk melihatnya.");
      expect((shown[0]!.options.data as { url: string }).url).toBe(`${ORIGIN}/akun`);
    }
  });

  test("title and body are length-capped and whitespace-collapsed; non-strings fall back", async () => {
    const worker = load();
    const shown = await worker.push({ title: `${"T".repeat(500)}`, body: `a\n\n  b${"x".repeat(900)}` });
    expect(shown[0]!.title.length).toBe(120);
    expect((shown[0]!.options.body as string).length).toBe(240);
    expect((shown[0]!.options.body as string).startsWith("a b")).toBe(true);

    const typed = await worker.push({ title: 42, body: { x: 1 } });
    expect(typed[0]!.title).toBe("Ada pembaruan dari toko");
  });

  test("no icon, image or badge is ever taken from the payload; the icon is a fixed same-origin path", async () => {
    const worker = load();
    const shown = await worker.push({
      title: "x",
      body: "y",
      icon: "https://evil.example/track.png",
      image: "https://evil.example/big.png",
      badge: "https://evil.example/b.png"
    });
    const options = shown[0]!.options;
    expect(options.icon).toBe(`${ORIGIN}/icons/icon-192.png`);
    expect(options.image).toBeUndefined();
    expect(options.badge).toBeUndefined();
    expect(JSON.stringify(options)).not.toContain("evil.example");
  });

  test("a tag is kept only when it is a short lowercase word", async () => {
    const worker = load();
    expect((await worker.push({ title: "t", body: "b", tag: "order" }))[0]!.options.tag).toBe("order");
    expect((await worker.push({ title: "t", body: "b", tag: "Has Space!" }))[0]!.options.tag).toBeUndefined();
    expect((await worker.push({ title: "t", body: "b", data: { category: "payment" } }))[0]!.options.tag).toBe("payment");
  });
});

describe("the click target is never trusted (T7, third wall)", () => {
  const HOSTILE = [
    "https://evil.example/akun/pesanan",
    "//evil.example/akun/pesanan",
    "/\\evil.example/akun/pesanan",
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "http://toko.example.evil.example/akun",
    `${ORIGIN}.evil.example/akun`,
    "https://user:pass@toko.example@evil.example/akun",
    "file:///etc/passwd",
    "blob:https://toko.example/abc"
  ];

  test("anything resolving off this origin, or not an http(s) URL, opens the account root", async () => {
    const worker = load();
    for (const target of HOSTILE) {
      const shown = await worker.push({ title: "t", body: "b", targetPath: target });
      expect((shown[0]!.options.data as { url: string }).url).toBe(`${ORIGIN}/akun`);
    }
  });

  test("only the three fixed account paths are navigable; every other same-origin path falls back", async () => {
    const worker = load();
    const allowed = ["/akun", "/akun/pesanan", "/akun/pesan"];
    for (const path of allowed) {
      const shown = await worker.push({ title: "t", body: "b", targetPath: path });
      expect((shown[0]!.options.data as { url: string }).url).toBe(`${ORIGIN}${path}`);
    }
    for (const path of ["/", "/checkout", "/akun/alamat", "/akun/pesanan/BJM-1", "/admin", "/akun/../admin", "/akun/pesan/x", "/akun/pesananx"]) {
      const shown = await worker.push({ title: "t", body: "b", targetPath: path });
      expect((shown[0]!.options.data as { url: string }).url).toBe(`${ORIGIN}/akun`);
    }
  });

  test("a query string, fragment or trailing slash never survives (no identifier can ride in the URL)", async () => {
    const worker = load();
    for (const target of ["/akun/pesanan?kode=BJM-1", "/akun/pesanan#x", "/akun/pesanan/", `${ORIGIN}/akun/pesan?id=123#y`]) {
      const shown = await worker.push({ title: "t", body: "b", targetPath: target });
      expect((shown[0]!.options.data as { url: string }).url).toMatch(new RegExp(`^${ORIGIN}/akun/pesan(an)?$`));
    }
  });

  test("a click re-validates the stored URL: a tampered notification.data still cannot navigate away", async () => {
    const worker = load();
    for (const data of [{ url: "https://evil.example/akun" }, { url: "javascript:1" }, null, undefined, {}, "x", { url: 5 }]) {
      const result = await worker.click(data);
      expect(result.closed).toBe(true);
      expect(result.opened).toEqual([`${ORIGIN}/akun`]);
    }
  });

  test("a click opens the fixed page, or focuses and navigates an existing tab already under /akun", async () => {
    const worker = load();
    const fresh = await worker.click({ url: `${ORIGIN}/akun/pesanan` });
    expect(fresh.opened).toEqual([`${ORIGIN}/akun/pesanan`]);

    const open = trackedClient(`${ORIGIN}/akun/profil`);
    const foreign = trackedClient("https://evil.example/akun");
    const reused = await worker.click({ url: `${ORIGIN}/akun/pesan` }, [foreign as FakeClient, open as FakeClient]);
    expect(reused.opened).toEqual([]);
    expect(reused.focused).toEqual([`${ORIGIN}/akun/profil`]);
    expect(reused.navigated).toEqual([`${ORIGIN}/akun/pesan`]);

    const root = trackedClient(`${ORIGIN}/akun`);
    const fromRoot = await worker.click({ url: `${ORIGIN}/akun/pesanan` }, [root as FakeClient]);
    expect(fromRoot.focused).toEqual([`${ORIGIN}/akun`]);
    expect(fromRoot.navigated).toEqual([`${ORIGIN}/akun/pesanan`]);
  });

  test("a click never takes over a tab outside /akun: checkout, a product page or a look-alike path", async () => {
    const worker = load();
    for (const url of [
      `${ORIGIN}/checkout`,
      `${ORIGIN}/produk`,
      `${ORIGIN}/`,
      `${ORIGIN}/akunx`,
      `${ORIGIN}/produk/akun`,
      `${ORIGIN}/produk?next=/akun`
    ]) {
      const tab = trackedClient(url);
      const result = await worker.click({ url: `${ORIGIN}/akun/pesan` }, [tab as FakeClient]);
      expect(result.focused).toEqual([]);
      expect(result.navigated).toEqual([]);
      expect(result.opened).toEqual([`${ORIGIN}/akun/pesan`]);
    }

    // An account tab behind an unrelated one is still the one reused.
    const checkout = trackedClient(`${ORIGIN}/checkout`);
    const account = trackedClient(`${ORIGIN}/akun/pesanan`);
    const mixed = await worker.click({ url: `${ORIGIN}/akun/pesan` }, [checkout as FakeClient, account as FakeClient]);
    expect(mixed.opened).toEqual([]);
    expect(mixed.focused).toEqual([`${ORIGIN}/akun/pesanan`]);
    expect((checkout as any).__navigated).toEqual([]);
  });
});

describe("the worker's own surface", () => {
  test("it listens to install, push and notificationclick - and nothing else", () => {
    const worker = load();
    expect([...worker.listeners.keys()].sort()).toEqual(["install", "notificationclick", "push"]);
  });

  test("it takes over at once (a push-only worker has nothing to migrate)", () => {
    const worker = load();
    worker.listeners.get("install")!({});
    expect(worker.skipWaiting()).toBe(1);
  });

  test("its fixed paths agree with the page's purposes (ADR-0048 section 6.5)", () => {
    const allowed = /var ALLOWED_PATHS = \[([^\]]+)\]/.exec(SOURCE)?.[1] ?? "";
    const paths = [...allowed.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    for (const purpose of PUSH_PURPOSES) expect(paths).toContain(PUSH_TARGET_PATHS[purpose]);
    expect(paths.sort()).toEqual(["/akun", "/akun/pesan", "/akun/pesanan"]);
  });
});

describe("what the worker file must never contain (ADR-0048 section 7, T16)", () => {
  // Strip comments first: the header explains these very words.
  const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  test("no fetch handler, no network, no offline cache", () => {
    expect(CODE).not.toMatch(/addEventListener\(\s*["']fetch["']/);
    expect(CODE).not.toMatch(/\bfetch\s*\(/);
    expect(CODE).not.toMatch(/XMLHttpRequest|WebSocket|EventSource|sendBeacon/);
    expect(CODE).not.toMatch(/\bcaches\b|CacheStorage|Cache\.|importScripts|indexedDB/);
  });

  test("no token, no storage, no API origin", () => {
    expect(CODE).not.toMatch(/Authorization|Bearer|cs_|localStorage|sessionStorage|AWCMS|PUBLIC_|api\/v1/i);
  });

  test("it does not register a device on pushsubscriptionchange (it holds no token to do so)", () => {
    expect(CODE).not.toMatch(/pushsubscriptionchange/);
  });

  test("it is plain ES5-style script: no import/export, no template with interpolation of build data", () => {
    expect(CODE).not.toMatch(/^\s*(import|export)\s/m);
    expect(CODE).not.toMatch(/\$\{/);
  });
});
