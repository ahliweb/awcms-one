/**
 * PDF word geometry. Reads `pdftotext -bbox-layout` (poppler) through an argv
 * spawn - never a shell - and returns every word with its coordinates, so a
 * number can be assigned to a column by its x-position instead of by the order
 * in which the text layer happens to emit it (BPS PDFs carry a diagonal
 * watermark, and the text layer sometimes emits two rows' numbers out of order).
 */

export interface Word {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  text: string;
  /** Height, y1 - y0. */
  h: number;
}

export interface Page {
  /** 1-based PDF page number. */
  no: number;
  width: number;
  height: number;
  words: Word[];
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/**
 * Parses the XHTML emitted by `pdftotext -bbox-layout` into pages. Pure, so it
 * is unit-tested on fixtures. Superscript footnote markers (a word clearly
 * smaller than the page's body text) are dropped, and so are the large,
 * short, non-numeric fragments of the diagonal watermark ("ht", "tp", "s:",
 * "//k", ...). Smaller watermark fragments that survive are rejected later by
 * position (see rows.ts).
 */
export function parseBboxPages(xml: string, firstPageNo = 1): Page[] {
  const pages: Page[] = [];
  const chunks = xml.split("<page ").slice(1);
  let no = firstPageNo;
  for (const chunk of chunks) {
    const head = /^width="([\d.]+)" height="([\d.]+)"/.exec(chunk);
    const width = head ? Number(head[1]) : 0;
    const height = head ? Number(head[2]) : 0;
    const raw: Word[] = [];
    const wordRe = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g;
    for (let m = wordRe.exec(chunk); m; m = wordRe.exec(chunk)) {
      const x0 = Number(m[1]);
      const y0 = Number(m[2]);
      const x1 = Number(m[3]);
      const y1 = Number(m[4]);
      raw.push({ x0, y0, x1, y1, h: y1 - y0, text: decodeEntities(m[5] ?? "") });
    }
    const med = median(raw.map((w) => w.h));
    const words = raw.filter((w) => {
      if (med > 0 && w.h < med * 0.72 && w.text.length <= 3 && !/[()]/.test(w.text)) return false; // superscript footnote marker
      const wide = (w.x1 - w.x0) / Math.max(1, w.text.length);
      if (med > 0 && w.h > med * 1.3 && w.text.length <= 4 && !/\d/.test(w.text) && wide > 9) return false; // watermark
      // the rotated watermark glyphs have an axis-aligned box far wider than any 1-4 letter word
      const perChar = (w.x1 - w.x0) / Math.max(1, w.text.length);
      if (w.text.length <= 4 && !/\d/.test(w.text) && perChar > (w.text.length === 1 ? 12 : 9)) return false;
      return w.text.trim() !== "";
    });
    pages.push({ no: no++, width, height, words });
  }
  return pages;
}

/** Runs pdftotext over a page window and parses it. */
async function bboxWindow(pdf: string, first: number, last: number): Promise<Page[]> {
  const proc = Bun.spawn(["pdftotext", "-bbox-layout", "-f", String(first), "-l", String(last), pdf, "-"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`pdftotext failed for ${pdf} pages ${first}-${last}: ${err.trim()}`);
  return parseBboxPages(out, first);
}

export async function pdfPageCount(pdf: string): Promise<number> {
  const proc = Bun.spawn(["pdfinfo", pdf], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`pdfinfo failed for ${pdf}`);
  const m = /^Pages:\s+(\d+)/m.exec(out);
  if (!m) throw new Error(`pdfinfo gave no page count for ${pdf}`);
  return Number(m[1]);
}

/** Loads every page of the PDF, in windows so memory stays bounded. */
export async function loadPages(pdf: string, windowSize = 80): Promise<Page[]> {
  const total = await pdfPageCount(pdf);
  const pages: Page[] = [];
  for (let first = 1; first <= total; first += windowSize) {
    pages.push(...(await bboxWindow(pdf, first, Math.min(total, first + windowSize - 1))));
  }
  return pages;
}

export async function sha256OfFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hasher = new Bun.CryptoHasher("sha256");
  const file = Bun.file(path);
  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
  }
  return { sha256: hasher.digest("hex"), bytes: file.size };
}
