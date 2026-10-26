/** CSV and review-file writers (pure string builders plus thin file helpers). */
import type { OutRow } from "./tables";

export const CSV_HEADER =
  "region_code,region_level,source_region_name,dimension,category,sex,value,unit,reference_year,figure_basis,universe,source_table,source_page,value_note,category_label";

export function csvField(value: string | number | null): string {
  const s = value === null ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsv(rows: OutRow[]): string {
  const lines = [CSV_HEADER];
  for (const r of rows) {
    lines.push(
      [
        r.region_code,
        r.region_level,
        r.source_region_name,
        r.dimension,
        r.category,
        r.sex,
        r.value,
        r.unit,
        r.reference_year,
        r.figure_basis,
        r.universe,
        r.source_table,
        r.source_page,
        r.value_note,
        r.category_label,
      ]
        .map(csvField)
        .join(",")
    );
  }
  return `${lines.join("\n")}\n`;
}
