/**
 * `src/lib/kirim-tunggal.ts` (issue #513): the single-flight guard.
 *
 * Two layers are tested separately. The PURE core is driven with controllable
 * promises (no DOM, no timers): concurrent calls, re-entrancy, settling when the
 * task throws, and the success lock. The DOM adapter is driven with plain-object
 * ports, so what is proved here is the contract - disabled controls, `aria-busy`,
 * the polite status text, focus handed back, the `pageshow` restore - NOT how a
 * real browser dispatches a double tap (`tests/e2e/daftar-ketuk-ganda.e2e.ts`
 * covers that where a browser exists).
 */
import { describe, expect, test } from "bun:test";
import {
  buatPenjagaDom,
  buatPenjagaTunggal,
  PESAN_MEMPROSES,
  type PortHalaman,
  type PortKontrol
} from "../src/lib/kirim-tunggal";

/** A promise the test resolves or rejects by hand. */
function tertunda<T = void>() {
  let selesai!: (nilai: T) => void;
  let gagal!: (alasan: unknown) => void;
  const janji = new Promise<T>((resolve, reject) => {
    selesai = resolve;
    gagal = reject;
  });
  return { janji, selesai, gagal };
}

describe("buatPenjagaTunggal (pure core)", () => {
  test("a second call while one is pending is ignored, not queued", async () => {
    const penjaga = buatPenjagaTunggal();
    const pertama = tertunda<string>();
    let dipanggil = 0;

    const a = penjaga.jalankan(() => {
      dipanggil += 1;
      return pertama.janji;
    });
    const b = penjaga.jalankan(async () => {
      dipanggil += 1;
      return "kedua";
    });

    expect(penjaga.keadaan()).toBe("pending");
    expect(await b).toEqual({ dijalankan: false, alasan: "pending" });

    pertama.selesai("pertama");
    expect(await a).toEqual({ dijalankan: true, hasil: "pertama" });
    expect(dipanggil).toBe(1);
    expect(penjaga.keadaan()).toBe("idle");

    // Ignored means NOT replayed later either: only a fresh call runs again.
    expect(dipanggil).toBe(1);
    expect(await penjaga.jalankan(async () => "lagi")).toEqual({ dijalankan: true, hasil: "lagi" });
  });

  test("many concurrent calls in the same tick run the task exactly once", async () => {
    const penjaga = buatPenjagaTunggal();
    const tahan = tertunda();
    let dipanggil = 0;
    const tugas = async () => {
      dipanggil += 1;
      await tahan.janji;
    };

    const hasil = [penjaga.jalankan(tugas), penjaga.jalankan(tugas), penjaga.jalankan(tugas)];
    tahan.selesai();
    const dijalankan = (await Promise.all(hasil)).filter((h) => h.dijalankan);

    expect(dipanggil).toBe(1);
    expect(dijalankan).toHaveLength(1);
  });

  test("re-entrancy: a task that triggers the guard again is refused", async () => {
    const penjaga = buatPenjagaTunggal();
    let dalam: unknown;
    await penjaga.jalankan(async () => {
      dalam = await penjaga.jalankan(async () => "tidak boleh");
    });
    expect(dalam).toEqual({ dijalankan: false, alasan: "pending" });
  });

  test("always settles: a throwing task restores idle and rethrows", async () => {
    const penjaga = buatPenjagaTunggal();
    await expect(
      penjaga.jalankan(async () => {
        throw new Error("jaringan putus");
      })
    ).rejects.toThrow("jaringan putus");
    expect(penjaga.keadaan()).toBe("idle");
    expect(await penjaga.jalankan(async () => 1)).toEqual({ dijalankan: true, hasil: 1 });
  });

  test("a task that throws synchronously also settles", async () => {
    const penjaga = buatPenjagaTunggal();
    await expect(
      penjaga.jalankan((() => {
        throw new Error("sinkron");
      }) as () => Promise<void>)
    ).rejects.toThrow("sinkron");
    expect(penjaga.keadaan()).toBe("idle");
  });

  test("success lock: kunciBila true leaves the guard settled and refuses every later call", async () => {
    const penjaga = buatPenjagaTunggal();
    await penjaga.jalankan(async () => "ok", { kunciBila: true });
    expect(penjaga.keadaan()).toBe("settled");
    expect(await penjaga.jalankan(async () => "lagi")).toEqual({ dijalankan: false, alasan: "settled" });
  });

  test("kunciBila as a function locks only for the results it accepts", async () => {
    const penjaga = buatPenjagaTunggal();
    await penjaga.jalankan(async () => false, { kunciBila: (berhasil) => berhasil });
    expect(penjaga.keadaan()).toBe("idle");
    await penjaga.jalankan(async () => true, { kunciBila: (berhasil) => berhasil });
    expect(penjaga.keadaan()).toBe("settled");
  });

  test("a throw never locks, even with kunciBila true", async () => {
    const penjaga = buatPenjagaTunggal();
    await expect(
      penjaga.jalankan(
        async () => {
          throw new Error("gagal");
        },
        { kunciBila: true }
      )
    ).rejects.toThrow();
    expect(penjaga.keadaan()).toBe("idle");
  });

  test("lepas() releases a settled guard and fires the release hook once", async () => {
    let dilepas = 0;
    const penjaga = buatPenjagaTunggal({ saatLepas: () => (dilepas += 1) });
    await penjaga.jalankan(async () => 1, { kunciBila: true });
    penjaga.lepas();
    penjaga.lepas();
    expect(penjaga.keadaan()).toBe("idle");
    expect(dilepas).toBe(1);
    expect(await penjaga.jalankan(async () => 2)).toEqual({ dijalankan: true, hasil: 2 });
  });

  test("hooks run in order: start, then finish with the lock flag", async () => {
    const urutan: string[] = [];
    const penjaga = buatPenjagaTunggal({
      saatMulai: () => urutan.push("mulai"),
      saatSelesai: (terkunci) => urutan.push(`selesai:${terkunci}`)
    });
    await penjaga.jalankan(async () => urutan.push("tugas"), { kunciBila: true });
    expect(urutan).toEqual(["mulai", "tugas", "selesai:true"]);
  });
});

// ---------------------------------------------------------------------------
// The DOM adapter, with fake ports.
// ---------------------------------------------------------------------------

type KontrolPalsu = PortKontrol & { fokusDipanggil: number };
function kontrol(disabled = false): KontrolPalsu {
  const k = {
    disabled,
    fokusDipanggil: 0,
    focus() {
      k.fokusDipanggil += 1;
    }
  };
  return k;
}

function formPalsu() {
  const atribut = new Map<string, string>();
  return {
    atribut,
    setAttribute: (nama: string, nilai: string) => void atribut.set(nama, nilai),
    removeAttribute: (nama: string) => void atribut.delete(nama)
  };
}

function halamanPalsu() {
  let pendengar: ((e: { persisted: boolean }) => void) | null = null;
  const halaman: PortHalaman = {
    addEventListener: (_jenis, fn) => {
      pendengar = fn;
    }
  };
  return { halaman, pageshow: (persisted: boolean) => pendengar?.({ persisted }) };
}

describe("buatPenjagaDom (adapter, fake ports)", () => {
  test("pending: controls disabled, aria-busy true, polite status written; settled: all restored", async () => {
    const form = formPalsu();
    const status = { textContent: "" as string | null };
    const kirim = kontrol();
    const ulang = kontrol();
    const penjaga = buatPenjagaDom({ form, kontrol: () => [kirim, ulang], status });
    const tahan = tertunda();

    const jalan = penjaga.jalankan(() => tahan.janji);
    expect(kirim.disabled).toBe(true);
    expect(ulang.disabled).toBe(true);
    expect(form.atribut.get("aria-busy")).toBe("true");
    expect(status.textContent).toBe(PESAN_MEMPROSES);
    expect(PESAN_MEMPROSES).toBe("Memproses...");

    tahan.selesai();
    await jalan;
    expect(kirim.disabled).toBe(false);
    expect(ulang.disabled).toBe(false);
    expect(form.atribut.has("aria-busy")).toBe(false);
    expect(status.textContent).toBe("");
  });

  test("a throwing task still restores the form (never a dead disabled form)", async () => {
    const form = formPalsu();
    const tombol = kontrol();
    const penjaga = buatPenjagaDom({ form, kontrol: () => [tombol] });
    await expect(
      penjaga.jalankan(async () => {
        throw new Error("putus");
      })
    ).rejects.toThrow();
    expect(tombol.disabled).toBe(false);
    expect(form.atribut.has("aria-busy")).toBe(false);
  });

  test("a control that was already disabled stays disabled afterwards", async () => {
    const dinonaktifkan = kontrol(true);
    const biasa = kontrol();
    const penjaga = buatPenjagaDom({ form: null, kontrol: () => [dinonaktifkan, biasa] });
    await penjaga.jalankan(async () => 1);
    expect(dinonaktifkan.disabled).toBe(true);
    expect(biasa.disabled).toBe(false);
  });

  test("tetapNonaktif keeps the resend button disabled while its countdown owns it", async () => {
    const kirim = kontrol();
    const ulang = kontrol();
    let hitungMundur = false;
    const penjaga = buatPenjagaDom({
      form: null,
      kontrol: () => [kirim, ulang],
      tetapNonaktif: (k) => k === ulang && hitungMundur
    });
    await penjaga.jalankan(async () => {
      hitungMundur = true; // the success path starts the countdown inside the task
    });
    expect(ulang.disabled).toBe(true);
    expect(kirim.disabled).toBe(false);
  });

  test("controls that render during the run are re-read (kontrol is a function)", async () => {
    let daftar: KontrolPalsu[] = [kontrol()];
    const penjaga = buatPenjagaDom({ form: null, kontrol: () => daftar });
    await penjaga.jalankan(async () => {
      daftar = [kontrol(true)]; // a re-render replaced the row's button (the old one is detached)
    });
    expect(daftar[0]!.disabled).toBe(false);
  });

  test("success lock: stays disabled and aria-busy; status keeps its text", async () => {
    const form = formPalsu();
    const status = { textContent: "" as string | null };
    const tombol = kontrol();
    const penjaga = buatPenjagaDom({ form, kontrol: () => [tombol], status });
    await penjaga.jalankan(async () => true, { kunciBila: true });
    expect(tombol.disabled).toBe(true);
    expect(form.atribut.get("aria-busy")).toBe("true");
    expect(status.textContent).toBe(PESAN_MEMPROSES);
    expect(await penjaga.jalankan(async () => 1)).toEqual({ dijalankan: false, alasan: "settled" });
  });

  test("a locked form is released by pageshow with persisted (bfcache back button)", async () => {
    const form = formPalsu();
    const status = { textContent: "" as string | null };
    const tombol = kontrol();
    const { halaman, pageshow } = halamanPalsu();
    const penjaga = buatPenjagaDom({ form, kontrol: () => [tombol], status, halaman });
    await penjaga.jalankan(async () => true, { kunciBila: true });

    pageshow(false); // a normal load is not a restore
    expect(tombol.disabled).toBe(true);

    pageshow(true);
    expect(penjaga.keadaan()).toBe("idle");
    expect(tombol.disabled).toBe(false);
    expect(form.atribut.has("aria-busy")).toBe(false);
    expect(status.textContent).toBe("");
    expect(await penjaga.jalankan(async () => "bisa lagi")).toEqual({ dijalankan: true, hasil: "bisa lagi" });
  });

  test("focus is handed back to the control that had it", async () => {
    const tombol = kontrol();
    const lain = kontrol();
    const penjaga = buatPenjagaDom({ form: null, kontrol: () => [tombol, lain], elemenAktif: () => tombol });
    await penjaga.jalankan(async () => 1);
    expect(tombol.fokusDipanggil).toBe(1);
    expect(lain.fokusDipanggil).toBe(0);
  });

  test("no focus call when focus was elsewhere, and none after a locked success", async () => {
    const tombol = kontrol();
    const penjaga = buatPenjagaDom({ form: null, kontrol: () => [tombol], elemenAktif: () => ({}) });
    await penjaga.jalankan(async () => 1);
    expect(tombol.fokusDipanggil).toBe(0);

    const terkunci = kontrol();
    const kedua = buatPenjagaDom({ form: null, kontrol: () => [terkunci], elemenAktif: () => terkunci });
    await kedua.jalankan(async () => true, { kunciBila: true });
    expect(terkunci.fokusDipanggil).toBe(0);
  });

  test("an absent status port and a form without attribute methods are tolerated", async () => {
    const tombol = kontrol();
    const penjaga = buatPenjagaDom({ form: {}, kontrol: () => [tombol], status: null });
    await penjaga.jalankan(async () => 1);
    expect(tombol.disabled).toBe(false);
  });

  test("a custom status message is used", async () => {
    const status = { textContent: "" as string | null };
    const penjaga = buatPenjagaDom({ form: null, kontrol: () => [], status, pesan: "Mengirim..." });
    const tahan = tertunda();
    const jalan = penjaga.jalankan(() => tahan.janji);
    expect(status.textContent).toBe("Mengirim...");
    tahan.selesai();
    await jalan;
  });

  test("double tap and Enter: two submit events in a row send one request", async () => {
    const tombol = kontrol();
    const penjaga = buatPenjagaDom({ form: formPalsu(), kontrol: () => [tombol] });
    const tahan = tertunda();
    let permintaan = 0;
    const submit = () =>
      penjaga.jalankan(async () => {
        permintaan += 1;
        await tahan.janji;
      });

    const a = submit();
    const b = submit(); // the Enter key, or the second tap
    tahan.selesai();
    await Promise.all([a, b]);
    expect(permintaan).toBe(1);
  });
});
