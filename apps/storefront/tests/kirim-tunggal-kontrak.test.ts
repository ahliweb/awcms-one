/**
 * Source contract for issue #513: EVERY storefront script that can send a
 * mutating request goes through the shared single-flight guard
 * (`src/lib/kirim-tunggal.ts`), so a future form cannot silently skip it.
 *
 * Plain `bun test` has no DOM and the scripts run at import time against
 * `document`, so this is a textual contract, the same trade
 * `checkout-guard-no-prerender.test.ts` makes: the mutating functions are
 * DISCOVERED from the two client libraries (any exported function whose body
 * names a `"POST" | "PUT" | "PATCH" | "DELETE"` method), then every script under
 * `src/scripts` is checked for calling one of them or for a raw mutating
 * `fetch`. A script that does must import the guard. The only exceptions are the
 * explicit, justified entries in `DIKECUALIKAN`; the list is itself checked so
 * it cannot go stale.
 *
 * What this proves: no script reaches a mutating endpoint without importing the
 * guard. What it cannot prove: that a given handler wraps the right call (the
 * unit tests of the guard and the Playwright double-tap test cover behaviour).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;
const SCRIPTS = join(SRC, "scripts");
const LIBS = ["lib/akun-klien.ts", "lib/toko-klien.ts"];

/** POST calls that change nothing: the cart quote re-prices the cart (a read that needs a body). */
const BACA_SAJA = new Set(["quoteCart"]);

const GUARD_IMPORT = /from\s+["']\.\.\/lib\/kirim-tunggal["']/;

/** Scripts that call a mutator (or fetch with a mutating method) but are deliberately not form handlers. */
const DIKECUALIKAN: Record<string, string> = {
  "analitik.ts":
    "First-party visitor beacon (fire-and-forget telemetry on page load, `keepalive`): not a user-triggered form, a duplicate beacon is a duplicate page-view row by design."
};

function mutatingExports(): Set<string> {
  const names = new Set<string>();
  for (const lib of LIBS) {
    const text = readFileSync(join(SRC, lib), "utf8");
    for (const chunk of text.split(/\n(?=export )/)) {
      const nama = chunk.match(/^export (?:async )?function (\w+)/)?.[1];
      if (nama && !BACA_SAJA.has(nama) && /["'](POST|PUT|PATCH|DELETE)["']/.test(chunk)) names.add(nama);
    }
  }
  return names;
}

const PEMANGGIL_MUTASI_LANGSUNG = /method:\s*["'](POST|PUT|PATCH|DELETE)["']/;

function scriptFiles(): string[] {
  return readdirSync(SCRIPTS)
    .filter((f) => f.endsWith(".ts"))
    .sort();
}

function stripKomentar(teks: string): string {
  return teks.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The mutators and raw fetches a script's CODE (not its comments) reaches. */
function mutasiDalam(teks: string, mutators: Set<string>): string[] {
  const kode = stripKomentar(teks);
  const hasil: string[] = [];
  for (const nama of mutators) if (new RegExp(`\\b${nama}\\s*\\(`).test(kode)) hasil.push(nama);
  if (PEMANGGIL_MUTASI_LANGSUNG.test(kode)) hasil.push("fetch(method)");
  return hasil;
}

describe("every mutating storefront script uses the shared single-flight guard (issue #513)", () => {
  const mutators = mutatingExports();

  test("the discovery finds the known mutators (so an empty set cannot make this suite pass vacuously)", () => {
    for (const nama of [
      "mintaKode",
      "verifikasiKode",
      "ubahProfil",
      "keluar",
      "tambahAlamat",
      "buatPercakapan",
      "kirimPesanPercakapan",
      "buatReservasiBooking",
      "batalkanReservasi",
      "createOrder",
      "submitPaymentConfirmation",
      "cancelOrder",
      "createGatewaySession"
    ]) {
      expect(mutators.has(nama)).toBe(true);
    }
    // Pure reads are not mutators.
    expect(mutators.has("ambilProfil")).toBe(false);
    expect(mutators.has("getOrder")).toBe(false);
    expect(mutators.has("quoteCart")).toBe(false);
  });

  for (const berkas of scriptFiles()) {
    test(`${berkas}: reaches no mutating call without the guard`, () => {
      const teks = readFileSync(join(SCRIPTS, berkas), "utf8");
      const mutasi = mutasiDalam(teks, mutators);
      if (mutasi.length === 0) return;
      if (berkas in DIKECUALIKAN) return;
      expect(
        GUARD_IMPORT.test(teks),
        `${berkas} calls ${mutasi.join(", ")} but does not import ../lib/kirim-tunggal`
      ).toBe(true);
    });
  }

  test("the exemption list is not stale: every entry exists and still reaches a mutation", () => {
    const ada = new Set(scriptFiles());
    for (const berkas of Object.keys(DIKECUALIKAN)) {
      expect(ada.has(berkas), `${berkas} no longer exists`).toBe(true);
    }
    // `analitik.ts` reaches its POST through a raw fetch.
    expect(mutasiDalam(readFileSync(join(SCRIPTS, "analitik.ts"), "utf8"), mutators)).toContain("fetch(method)");
  });

  test("the lib code that clears a session or enrols push is reached only from guarded scripts", () => {
    // `keluar()` and the push calls are wrapped by `lib/push-sesi.ts` / `lib/push-alur.ts`; their callers are the scripts below.
    const pemanggil = ["akun.ts", "akun-notifikasi.ts", "daftar.ts", "masuk.ts"];
    for (const berkas of pemanggil) {
      const teks = readFileSync(join(SCRIPTS, berkas), "utf8");
      expect(GUARD_IMPORT.test(teks), `${berkas} must import the guard`).toBe(true);
    }
  });

  test("the shared module and the layout's polite status exist", () => {
    expect(readFileSync(join(SRC, "lib/kirim-tunggal.ts"), "utf8")).toContain("export function buatPenjagaTunggal");
    expect(readFileSync(join(SRC, "layouts/BaseLayout.astro"), "utf8")).toContain("data-proses-status");
  });

  test("no script keeps its own in-flight flag or its own key generator any more", () => {
    for (const berkas of scriptFiles()) {
      const kode = stripKomentar(readFileSync(join(SCRIPTS, berkas), "utf8"));
      expect(kode, `${berkas}: use the shared guard, not a local \`submitting\` flag`).not.toMatch(/let\s+submitting\b/);
      expect(kode, `${berkas}: use buatPengelolaKunci, not a local crypto.randomUUID()`).not.toMatch(/crypto\.randomUUID\(/);
    }
  });
});
