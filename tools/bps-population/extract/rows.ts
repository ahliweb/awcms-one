/**
 * Page structure: column markers "(1) (2) ...", table title, body rows and
 * header words. BPS tables number their columns "(1) (2) (3) ..." on one line
 * directly above the data; those markers are the x-anchors every number is
 * assigned to, which makes the assignment independent of the text-layer order.
 */
import { isCellToken, isIndexToken } from "./cells";
import type { Page, Word } from "./words";

export interface Marker {
  /** Position, 0-based, left to right. */
  pos: number;
  cx: number;
}

export interface PageInfo {
  page: Page;
  markers: Marker[];
  markerY: number;
  /** Concatenated title/heading text above the marker line (table-number words removed). */
  head: string;
  /** Same, lower-case with all whitespace removed - what table title patterns match. */
  headKey: string;
  tableNumber: string | null;
  continued: boolean;
  printedPage: number | null;
  /** y below which words are notes/footer, not data. */
  bodyBottom: number;
  /** Notes and source lines under the table, lower-case with whitespace removed. */
  notesKey: string;
  /** The same notes line by line (reading order), for footnote parsing. */
  noteLines: Word[][];
}

export interface BodyRow {
  y: number;
  label1: string;
  label2: string;
  /** Cell text by marker position (label positions stay undefined). */
  cells: (string | undefined)[];
  hasNum: boolean;
  /** True when the label was assembled from neighbouring label-only lines. */
  wrapped: boolean;
  /** True for the last row on the page that carries numbers (where BPS prints the total row). */
  last: boolean;
}

const MARKER = /^\((\d+)\)$/;

export function cx(w: Word): number {
  return (w.x0 + w.x1) / 2;
}
function cy(w: Word): number {
  return (w.y0 + w.y1) / 2;
}

/** Groups words into lines by vertical centre. */
export function clusterLines(words: Word[], tol: number): Word[][] {
  const sorted = [...words].sort((a, b) => cy(a) - cy(b));
  const lines: Word[][] = [];
  let lastY = Number.NEGATIVE_INFINITY;
  for (const w of sorted) {
    const y = cy(w);
    if (lines.length === 0 || y - lastY > tol) {
      lines.push([w]);
    } else {
      lines[lines.length - 1]!.push(w);
    }
    lastY = y;
  }
  for (const line of lines) line.sort((a, b) => a.x0 - b.x0);
  return lines;
}

function medianHeight(words: Word[]): number {
  const hs = words.map((w) => w.h).sort((a, b) => a - b);
  return hs[Math.floor(hs.length / 2)] ?? 10;
}

/** Collapses a heading to the key title patterns match: lower-case, no whitespace. */
export function headingKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "");
}

export function analysePage(page: Page): PageInfo | null {
  const markerWords = page.words.filter((w) => MARKER.test(w.text));
  if (markerWords.length < 2) return null;
  // the marker line: the line holding the most markers (continuation pages repeat it once)
  const lines = clusterLines(markerWords, 3);
  lines.sort((a, b) => b.length - a.length || (a[0]?.y0 ?? 0) - (b[0]?.y0 ?? 0));
  const best = lines[0]!;
  if (best.length < 2) return null;
  const markers: Marker[] = best.map((w, pos) => ({ pos, cx: cx(w) }));
  const markerY = Math.min(...best.map((w) => w.y0));

  const tabelWords = page.words.filter((w) => /^(tabel|lanjutan)/i.test(w.text) && w.x0 < page.width * 0.45 && w.y1 <= markerY + 1);
  const topY = tabelWords.length ? Math.min(...tabelWords.map((w) => w.y0)) - 2 : Number.NEGATIVE_INFINITY;
  const above = page.words.filter((w) => w.y1 <= markerY + 1 && w.y0 >= topY);
  const labelWords = page.words.filter((w) => /^(tabel|table|tabel\/continued)$/i.test(w.text) && w.x0 < page.width * 0.6);
  const headLines = clusterLines(above, 3);
  const dropWord = /^(tabel|table|lanjutan|continued|tabel\/continued|lanjutan\/continued)$/i;
  let tableNumber: string | null = null;
  let continued = false;
  const parts: string[] = [];
  for (const line of headLines) {
    const kept: string[] = [];
    for (const w of line) {
      if (/^lanjutan$/i.test(w.text)) continued = true;
      const onLabelLine = labelWords.some((l) => Math.abs((l.y0 + l.y1) / 2 - (w.y0 + w.y1) / 2) < 10) && w.x0 < page.width * 0.5;
      if (/^\d+(\.\d+)+$/.test(w.text) && onLabelLine && tableNumber === null) {
        tableNumber = w.text;
        continue;
      }
      if (dropWord.test(w.text)) continue;
      kept.push(w.text);
    }
    if (kept.length) parts.push(kept.join(" "));
  }
  const head = parts.join(" ");

  const noteStarts = page.words.filter((w) => w.y0 > markerY && /^(catatan|sumber)\b/i.test(w.text) && w.x0 < page.width * 0.3);
  const bodyBottom = Math.min(
    noteStarts.length ? Math.min(...noteStarts.map((w) => w.y0)) - 0.5 : Number.POSITIVE_INFINITY,
    page.height * 0.9
  );

  const noteWords = page.words.filter((w) => w.y0 >= bodyBottom && w.y0 < page.height * 0.9);
  const noteLines = clusterLines(noteWords, 3);
  return {
    page,
    notesKey: headingKey(noteWords.map((w) => w.text).join(" ")),
    noteLines,
    markers,
    markerY,
    head,
    headKey: headingKey(head),
    tableNumber,
    continued,
    printedPage: printedPageOf(page),
    bodyBottom,
  };
}

export function printedPageOf(page: Page): number | null {
  const foot = page.words.filter(
    (w) => w.y0 > page.height * 0.88 && /^\d{1,4}$/.test(w.text) && (w.x0 < 60 || w.x1 > page.width - 60)
  );
  if (foot.length !== 1) {
    // a header-side page number can also sit at the extreme right on odd pages next to the English running title
    const right = foot.filter((w) => w.x1 > page.width - 60);
    if (right.length === 1) return Number(right[0]!.text);
    const left = foot.filter((w) => w.x0 < 60);
    if (left.length === 1) return Number(left[0]!.text);
    return null;
  }
  return Number(foot[0]!.text);
}

/** Header words above the marker line, within `reach` points of it. */
export function headerWords(info: PageInfo, reach = 75): Word[] {
  return info.page.words.filter((w) => w.y1 <= info.markerY + 1 && w.y0 >= info.markerY - reach);
}

/** Index of the marker nearest to an x position. */
export function nearestMarker(info: PageInfo, x: number, from = 0): number {
  let best = from;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = from; i < info.markers.length; i++) {
    const d = Math.abs(info.markers[i]!.cx - x);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Number of label columns (1, or 2 when the second column is Kelurahan/Desa). */
export function labelColumnCount(info: PageInfo): 1 | 2 {
  if (info.markers.length < 4) return 1;
  const lo = (info.markers[0]!.cx + info.markers[1]!.cx) / 2;
  const hi = (info.markers[1]!.cx + info.markers[2]!.cx) / 2;
  const hit = headerWords(info, 60).some((w) => cx(w) > lo && cx(w) < hi && /^(kelurahan|desa|subdistrict|village)\b/i.test(w.text));
  return hit ? 2 : 1;
}

/**
 * Reads the body of a page as rows. Numbers go to their nearest data marker;
 * text left of the first number column forms the label(s); text elsewhere in
 * the number area is watermark residue and is dropped.
 */
export function readBody(info: PageInfo, labelCols: 1 | 2): BodyRow[] {
  const { page, markers } = info;
  const body = page.words.filter((w) => w.y0 > info.markerY + 2 && w.y1 <= info.bodyBottom + 1);
  const med = medianHeight(body);
  const dataStart = labelCols;
  const numWords = body.filter((w) => isCellToken(w.text) && !isIndexToken(w.text) && nearestMarker(info, cx(w)) >= dataStart);
  const numLeft = numWords.length ? Math.min(...numWords.map((w) => w.x0)) - 1 : Number.POSITIVE_INFINITY;
  const split = labelCols === 2 ? (markers[0]!.cx + markers[1]!.cx) / 2 : Number.POSITIVE_INFINITY;

  const kept = body.filter((w) => {
    if (isCellToken(w.text) && !isIndexToken(w.text) && nearestMarker(info, cx(w)) >= dataStart) return true;
    return w.x0 < numLeft; // label text
  });
  const lines = clusterLines(kept, med * 0.4);
  const rows: BodyRow[] = [];
  for (const line of lines) {
    const cells: (string | undefined)[] = new Array(markers.length).fill(undefined);
    const l1: string[] = [];
    const l2: string[] = [];
    let hasNum = false;
    // Two label columns (Kecamatan | Kelurahan) only apply to lines that open with an
    // index token in the first column; any other line (a "Jumlah di Kecamatan X"
    // subtotal, a total row) is one label that merely spans both columns.
    const firstLabel = line.find((w) => !(isCellToken(w.text) && !isIndexToken(w.text) && nearestMarker(info, cx(w)) >= dataStart));
    const spans = labelCols === 2 && firstLabel !== undefined && !(isIndexToken(firstLabel.text) && cx(firstLabel) < split);
    const lineSplit = spans && cx(firstLabel!) < split ? Number.POSITIVE_INFINITY : split;
    for (const w of line) {
      const isNum = isCellToken(w.text) && !isIndexToken(w.text) && nearestMarker(info, cx(w)) >= dataStart;
      if (isNum) {
        const k = nearestMarker(info, cx(w), dataStart);
        cells[k] = cells[k] === undefined ? w.text : `${cells[k]} ${w.text}`;
        hasNum = true;
      } else if (cx(w) < lineSplit) {
        l1.push(w.text);
      } else {
        l2.push(w.text);
      }
    }
    rows.push({ y: cy(line[0]!), label1: joinLabel(l1), label2: joinLabel(l2), cells, hasNum, wrapped: false, last: false });
  }
  const merged = mergeWrapped(rows);
  for (let i = merged.length - 1; i >= 0; i--) {
    if (merged[i]!.hasNum) {
      merged[i]!.last = true;
      break;
    }
  }
  return merged;
}

/** Joins label tokens; a run of 3+ single letters ("K a p u a s", a letter-spaced name) becomes one word. */
export function joinLabel(tokens: string[]): string {
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length >= 3) out.push(run.join(""));
    else out.push(...run);
    run = [];
  };
  for (const t of tokens) {
    if (/^\p{L}$/u.test(t)) run.push(t);
    else {
      flush();
      out.push(t);
    }
  }
  flush();
  return out.join(" ");
}

const GROUP_LINE = /^(kabupaten|kota)\s*\/\s*(regency|municipality|city)$/i;

/** Joins labels that the PDF wrapped over several lines around a numbers line. */
function mergeWrapped(rows: BodyRow[]): BodyRow[] {
  const out: BodyRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const hasLabel = row.label1 !== "" || row.label2 !== "";
    if (!row.hasNum && hasLabel) {
      const next = rows[i + 1];
      const nextBare = next && next.hasNum && next.label1 === "" && next.label2 === "";
      if (nextBare && !GROUP_LINE.test(row.label1.trim())) {
        next.label1 = row.label1;
        next.label2 = row.label2;
        next.wrapped = true;
        continue;
      }
      const prev = out[out.length - 1];
      const startsNew = /^\d{1,3}\.\s|^\d{3}\s*\./.test(row.label1) || GROUP_LINE.test(row.label1.trim());
      if (prev && prev.hasNum && prev.wrapped && !startsNew) {
        prev.label1 = [prev.label1, row.label1].filter(Boolean).join(" ");
        prev.label2 = [prev.label2, row.label2].filter(Boolean).join(" ");
        continue;
      }
    }
    out.push(row);
  }
  return out;
}
