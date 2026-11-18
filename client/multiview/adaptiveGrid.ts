export const MAX_ADAPTIVE_GRID_ROOMS = 48;
export const ADAPTIVE_GRID_ASPECT_RATIO = 16 / 9;

export interface AdaptiveGridLayout {
  roomCount: number;
  columns: number;
  rows: number;
  width: number;
  height: number;
  gap: number;
  aspectRatio: number;
  cellWidth: number;
  cellHeight: number;
  effectiveWidth: number;
  effectiveHeight: number;
  effectiveArea: number;
  emptyCells: number;
  signature: string;
}

const finiteNonNegative = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;

/** Pick the largest near-16:9 grid for the current canvas without changing room order. */
export function getAdaptiveGridLayout(
  roomCount: number,
  width: number,
  height: number,
  gap: number,
  aspectRatio = ADAPTIVE_GRID_ASPECT_RATIO,
): AdaptiveGridLayout {
  const safeRoomCount = Number.isFinite(roomCount)
    ? Math.max(1, Math.min(MAX_ADAPTIVE_GRID_ROOMS, Math.floor(roomCount))) : 1;
  const safeWidth = finiteNonNegative(width);
  const safeHeight = finiteNonNegative(height);
  const safeGap = finiteNonNegative(gap);
  const safeAspectRatio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : ADAPTIVE_GRID_ASPECT_RATIO;
  let bestColumns = 1;
  let bestRows = safeRoomCount;
  let bestCellWidth = 0;
  let bestCellHeight = 0;
  let bestEffectiveWidth = 0;
  let bestEffectiveHeight = 0;
  let bestEffectiveArea = Number.NEGATIVE_INFINITY;
  let bestError = Number.POSITIVE_INFINITY;
  let bestEmptyCells = Number.POSITIVE_INFINITY;

  for (let columns = 1; columns <= safeRoomCount; columns += 1) {
    const rows = Math.ceil(safeRoomCount / columns);
    const cellWidth = Math.max(0, (safeWidth - safeGap * (columns - 1)) / columns);
    const cellHeight = Math.max(0, (safeHeight - safeGap * (rows - 1)) / rows);
    const effectiveWidth = Math.min(cellWidth, cellHeight * safeAspectRatio);
    const effectiveHeight = effectiveWidth / safeAspectRatio;
    const effectiveArea = effectiveWidth * effectiveHeight * safeRoomCount;
    const ratioError = cellHeight > 0 && cellWidth > 0
      ? Math.abs(Math.log((cellWidth / cellHeight) / safeAspectRatio)) : Number.POSITIVE_INFINITY;
    const emptyCells = columns * rows - safeRoomCount;
    const areaDelta = effectiveArea - bestEffectiveArea;
    const better = areaDelta > 0.01
      || (Math.abs(areaDelta) <= 0.01 && (ratioError < bestError - 0.0001
        || (Math.abs(ratioError - bestError) <= 0.0001 && (emptyCells < bestEmptyCells
          || (emptyCells === bestEmptyCells && columns < bestColumns)))));
    if (!better) continue;
    bestColumns = columns; bestRows = rows; bestCellWidth = cellWidth; bestCellHeight = cellHeight;
    bestEffectiveWidth = effectiveWidth; bestEffectiveHeight = effectiveHeight; bestEffectiveArea = effectiveArea;
    bestError = ratioError; bestEmptyCells = emptyCells;
  }

  return {
    roomCount: safeRoomCount, columns: bestColumns, rows: bestRows, width: safeWidth, height: safeHeight, gap: safeGap,
    aspectRatio: safeAspectRatio, cellWidth: bestCellWidth, cellHeight: bestCellHeight,
    effectiveWidth: bestEffectiveWidth, effectiveHeight: bestEffectiveHeight, effectiveArea: bestEffectiveArea,
    // Pixel resizing is handled by CSS Grid. Only a structural change should
    // restart FLIP or invalidate an operation's layout context.
    emptyCells: bestEmptyCells, signature: `${safeRoomCount}:${bestColumns}x${bestRows}:${safeGap}`,
  };
}

export function adaptiveGridStyle(layout: AdaptiveGridLayout) {
  return {
    gridTemplateAreas: 'none',
    gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))`,
  };
}
