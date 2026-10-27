/**
 * Small-cell suppression for population statistics (awcms-one ADR-0051).
 *
 * The figures are public aggregates, but a count of a handful of people in a
 * small place can identify them: "3 Hindu residents in this village" names a
 * household to anyone who lives there. Statistical offices therefore withhold
 * small cells, and so must any surface that serves these rows. No such surface
 * exists in this change (there is no HTTP API); this helper exists so the future
 * one reuses a single, tested rule instead of inventing its own.
 *
 * ## The rule
 *
 * A cell is withheld when its unit is `jiwa` (a head count) and its value is
 * below {@link SMALL_CELL_THRESHOLD}, and either
 *
 *   * its dimension is `religion`, at ANY region level (belief is special-category
 *     data about people, so even a district-level handful is withheld), or
 *   * it is published at region level 4 (village / kelurahan), for EVERY dimension.
 *
 * `ribu_jiwa` and `rupiah` are never suppressed here: a figure in thousands is
 * already at least a rounded 10 persons, and an average in rupiah is not a count.
 *
 * ## What this does NOT do
 *
 * It is cell-level (primary) suppression only. A caller serving both a total and
 * all but one of its parts still lets the withheld cell be recovered by
 * subtraction; complementary suppression is the future API's decision and is
 * deliberately not guessed at here.
 *
 * Pure: no filesystem, no database, no clock.
 */

/** Cells with a head count strictly below this are withheld. */
export const SMALL_CELL_THRESHOLD = 10;

export type SuppressibleCell = {
  dimension: string;
  regionLevel: number;
  unit: string;
  value: number;
};

/** True when this cell must not be served. */
export function isSmallCell(cell: SuppressibleCell): boolean {
  if (cell.unit !== "jiwa") return false;
  if (cell.value >= SMALL_CELL_THRESHOLD) return false;
  return cell.dimension === "religion" || cell.regionLevel === 4;
}

export type SuppressedCell<T extends SuppressibleCell> = Omit<T, "value"> & {
  /** `null` when the cell was withheld. */
  value: number | null;
  suppressed: boolean;
};

/**
 * Returns every cell, with the value of a small cell replaced by `null` and
 * `suppressed: true`. Cells are kept (not dropped) so a client can tell
 * "withheld" from "never published".
 */
export function suppressSmallCells<T extends SuppressibleCell>(
  cells: readonly T[]
): SuppressedCell<T>[] {
  return cells.map((cell) =>
    isSmallCell(cell)
      ? { ...cell, value: null, suppressed: true }
      : { ...cell, suppressed: false }
  );
}
