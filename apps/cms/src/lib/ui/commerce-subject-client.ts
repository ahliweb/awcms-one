/**
 * Browser helpers of the shopper data-subject actions on the customers screen
 * (Issue #529, ADR-0055 D4). The export bundle is returned by the API and never
 * stored, so the screen hands it to the operator as a file download straight
 * from the response; nothing is kept in the page or in browser storage.
 */

/** `customer-<first 8 of the id>-export-<yyyy-mm-dd>.json`: names no one, sorts by date. */
export function subjectExportFileName(customerId: string, now: Date): string {
  const day = now.toISOString().slice(0, 10);
  return `customer-${customerId.slice(0, 8)}-export-${day}.json`;
}

/** Offers `value` as a JSON file download. Browser only. */
export function downloadJson(value: unknown, fileName: string): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
