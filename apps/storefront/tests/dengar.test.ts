/**
 * Unit tests for the "Dengarkan berita ini" player's pure half (issue #52) —
 * `src/scripts/dengar.ts`'s exported helpers.
 *
 * The DOM-driving half (`initDengar`/`pasangPemutar`) is not exercised here:
 * it needs a real `speechSynthesis`, which neither Bun nor happy-dom
 * provides, and a hand-rolled fake of it would test the fake. What IS
 * tested is everything a defect would actually hide in — which elements
 * become reading units, how a unit is split into utterances, how a device's
 * voices are filtered, and that persistence never throws at the reader.
 * The rendered card itself is covered by `dengar-build-smoke.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import {
  bacaSimpanan,
  kumpulkanUnit,
  pecahKalimat,
  suaraIndonesia,
  tulisSimpanan,
  type UnitBaca
} from "../src/scripts/dengar";

/** A minimal stand-in for the element shapes `kumpulkanUnit` reads. */
function el(tagName: string, textContent: string, className = ""): HTMLElement {
  const classes = new Set(className.split(" ").filter(Boolean));
  return {
    tagName,
    textContent,
    classList: { contains: (name: string) => classes.has(name) },
    children: [] as unknown as HTMLCollection
  } as unknown as HTMLElement;
}

function badanDengan(anak: HTMLElement[], teksSeluruhnya = ""): HTMLElement {
  return {
    tagName: "DIV",
    textContent: teksSeluruhnya,
    classList: { contains: () => false },
    children: anak as unknown as HTMLCollection
  } as unknown as HTMLElement;
}

function teksDari(unit: UnitBaca[]): string[] {
  return unit.map((u) => u.teks);
}

describe("pecahKalimat", () => {
  test("splits on sentence punctuation, keeping the punctuation", () => {
    expect(pecahKalimat("Satu kalimat. Dua kalimat! Tiga?")).toEqual([
      "Satu kalimat.",
      "Dua kalimat!",
      "Tiga?"
    ]);
  });

  test("a paragraph with no terminal punctuation stays one utterance", () => {
    expect(pecahKalimat("Judul tanpa titik")).toEqual(["Judul tanpa titik"]);
  });

  test("blank input yields no utterances at all", () => {
    expect(pecahKalimat("   ")).toEqual([]);
  });

  test("a decimal number does not split the sentence — the separator needs whitespace after the stop", () => {
    expect(pecahKalimat("Nilainya 3.14 dan seterusnya.")).toEqual(["Nilainya 3.14 dan seterusnya."]);
  });
});

describe("kumpulkanUnit", () => {
  test("the title is always the first unit, and it highlights nothing", () => {
    const unit = kumpulkanUnit("Judul Berita", null, null);
    expect(unit).toHaveLength(1);
    expect(unit[0]!.teks).toBe("Judul Berita");
    expect(unit[0]!.elemen).toBeNull();
  });

  test("an empty title contributes no unit", () => {
    expect(kumpulkanUnit("   ", null, null)).toEqual([]);
  });

  test("each block child of the body becomes its own unit, in order", () => {
    const p1 = el("P", "Paragraf satu.");
    const p2 = el("P", "Paragraf dua.");
    const unit = kumpulkanUnit("Judul", null, badanDengan([p1, p2]));
    expect(teksDari(unit)).toEqual(["Judul", "Paragraf satu.", "Paragraf dua."]);
    expect(unit[1]!.elemen).toBe(p1);
    expect(unit[2]!.elemen).toBe(p2);
  });

  test("figure, figcaption, script, style, iframe and noscript are never read", () => {
    const badan = badanDengan([
      el("FIGURE", "Foto: ANTARA"),
      el("FIGCAPTION", "Keterangan foto"),
      el("SCRIPT", "console.log(1)"),
      el("STYLE", ".x{}"),
      el("IFRAME", "video"),
      el("NOSCRIPT", "Aktifkan JavaScript"),
      el("P", "Isi berita.")
    ]);
    expect(teksDari(kumpulkanUnit("Judul", null, badan))).toEqual(["Judul", "Isi berita."]);
  });

  test("an ad slot inside the body is never read as article text", () => {
    const badan = badanDengan([el("DIV", "Iklan Pemasang", "ad-slot"), el("P", "Isi berita.")]);
    expect(teksDari(kumpulkanUnit("Judul", null, badan))).toEqual(["Judul", "Isi berita."]);
  });

  test("a legacy body with no block children is read as one unit rather than skipped", () => {
    const badan = badanDengan([], "Teks lama yang hanya dipisah <br>.");
    const unit = kumpulkanUnit("Judul", null, badan);
    expect(teksDari(unit)).toEqual(["Judul", "Teks lama yang hanya dipisah <br>."]);
    expect(unit[1]!.elemen).toBe(badan);
  });

  test("an empty block contributes nothing", () => {
    const badan = badanDengan([el("P", "   "), el("P", "Isi.")]);
    expect(teksDari(kumpulkanUnit("Judul", null, badan))).toEqual(["Judul", "Isi."]);
  });

  test("a dek element, when the template ever renders one, is read after the title", () => {
    const dek = el("P", "Ringkasan berita.");
    const badan = badanDengan([el("P", "Isi.")]);
    expect(teksDari(kumpulkanUnit("Judul", dek, badan))).toEqual([
      "Judul",
      "Ringkasan berita.",
      "Isi."
    ]);
  });
});

describe("suaraIndonesia", () => {
  const suara = (lang: string, name: string) => ({ lang, name }) as SpeechSynthesisVoice;

  test("keeps every id-* voice and drops the rest, preserving device order", () => {
    const hasil = suaraIndonesia([
      suara("en-US", "Samantha"),
      suara("id-ID", "Damayanti"),
      suara("ID-id", "Andika"),
      suara("en-GB", "Daniel")
    ]);
    expect(hasil.map((s) => s.name)).toEqual(["Damayanti", "Andika"]);
  });

  test("a device with no Indonesian voice yields none — the card stays hidden", () => {
    expect(suaraIndonesia([suara("en-US", "Samantha")])).toEqual([]);
  });
});

describe("persistence never reaches the reader as an error", () => {
  const asli = globalThis.window;

  test("a throwing localStorage reads as 'nothing remembered' and writes silently", () => {
    const meledak = {
      localStorage: {
        getItem() {
          throw new Error("SecurityError: site data blocked");
        },
        setItem() {
          throw new Error("QuotaExceededError");
        }
      }
    };
    (globalThis as { window?: unknown }).window = meledak;
    try {
      expect(bacaSimpanan("dengar:rate")).toBeNull();
      expect(() => tulisSimpanan("dengar:rate", "1.25")).not.toThrow();
    } finally {
      (globalThis as { window?: unknown }).window = asli;
    }
  });

  test("a working localStorage round-trips the value", () => {
    const simpanan = new Map<string, string>();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => simpanan.get(k) ?? null,
        setItem: (k: string, v: string) => void simpanan.set(k, v)
      }
    };
    try {
      tulisSimpanan("dengar:suara", "id-ID-Damayanti");
      expect(bacaSimpanan("dengar:suara")).toBe("id-ID-Damayanti");
    } finally {
      (globalThis as { window?: unknown }).window = asli;
    }
  });
});
