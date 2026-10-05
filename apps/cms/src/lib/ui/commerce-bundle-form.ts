/**
 * The bundle component editor's text format (Issue #290, ADR-0036 D8): one
 * component per line, `SKU x quantity` (`x`, `X` or `×`; a bare SKU means one).
 * The line order is the component order. The server resolves each SKU to a
 * live product or variant of the tenant, so the form needs no product picker
 * script - it is a plain `<textarea>` that works with the cashier's keyboard.
 * Pure: no DOM, so it is unit-tested.
 */

export type BundleLine = { sku: string; quantity: number };

const LINE_PATTERN = /^(.+?)(?:\s*[xX×]\s*(\d{1,5}))?$/;

/** `null` when any non-blank line is not `SKU` or `SKU x quantity`. */
export function parseBundleLines(text: string): BundleLine[] | null {
  const lines: BundleLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const match = LINE_PATTERN.exec(line);
    if (!match) return null;
    const quantity = match[2] === undefined ? 1 : Number(match[2]);
    const sku = match[1]!.trim();
    if (sku.length === 0 || quantity < 1) return null;
    lines.push({ sku, quantity });
  }
  return lines;
}

/** The inverse, for pre-filling an edit form. */
export function formatBundleLines(
  components: readonly { sku: string | null; quantity: number }[]
): string {
  return components
    .map((component) => `${component.sku ?? ""} x ${component.quantity}`)
    .join("\n");
}
