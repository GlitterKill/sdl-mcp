export const GRID = Object.freeze({ columns: 24, rowPx: 56, gapPx: 14 });
export const PANEL_BOUNDS = Object.freeze({
  minCols: 4,
  minRows: 2,
  maxCols: 24,
  maxRows: 8,
});

const DEFAULT_LAYOUT = Object.freeze({
  bottleneck: Object.freeze({ col: 1, row: 2, cols: 12, rows: 4 }),
  cache: Object.freeze({ col: 19, row: 6, cols: 6, rows: 4 }),
  predictiveContext: Object.freeze({ col: 1, row: 10, cols: 8, rows: 4 }),
  retrieval: Object.freeze({ col: 13, row: 6, cols: 6, rows: 4 }),
  beam: Object.freeze({ col: 9, row: 10, cols: 8, rows: 4 }),
  indexing: Object.freeze({ col: 17, row: 10, cols: 8, rows: 4 }),
  tokenEfficiency: Object.freeze({ col: 1, row: 6, cols: 12, rows: 4 }),
  health: Object.freeze({ col: 13, row: 2, cols: 6, rows: 4 }),
  latency: Object.freeze({ col: 19, row: 2, cols: 6, rows: 4 }),
  ppr: Object.freeze({ col: 1, row: 14, cols: 8, rows: 4 }),
  scip: Object.freeze({ col: 9, row: 14, cols: 8, rows: 4 }),
  toolVolume: Object.freeze({ col: 1, row: 18, cols: 12, rows: 4 }),
  toolOutput: Object.freeze({ col: 1, row: 22, cols: 24, rows: 4 }),
  postIndex: Object.freeze({ col: 17, row: 14, cols: 8, rows: 4 }),
  resources: Object.freeze({ col: 13, row: 18, cols: 12, rows: 4 }),
});

const roundHalfUp = (value) => Math.sign(value) * Math.floor(Math.abs(value) + 0.5);
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function normalizeRect(rect) {
  if (![rect.col, rect.row, rect.cols, rect.rows].every(Number.isSafeInteger)) return null;
  const cols = clamp(rect.cols, PANEL_BOUNDS.minCols, PANEL_BOUNDS.maxCols);
  const rows = clamp(rect.rows, PANEL_BOUNDS.minRows, PANEL_BOUNDS.maxRows);
  const normalized = {
    col: clamp(rect.col, 1, GRID.columns - cols + 1),
    row: Math.max(1, rect.row),
    cols,
    rows,
  };
  return isLayoutRect(normalized) ? normalized : null;
}

function isLayoutRect(rect) {
  return (
    rect !== null &&
    typeof rect === "object" &&
    [rect.col, rect.row, rect.cols, rect.rows].every(Number.isSafeInteger) &&
    rect.col >= 1 &&
    rect.row >= 1 &&
    rect.cols >= PANEL_BOUNDS.minCols &&
    rect.cols <= PANEL_BOUNDS.maxCols &&
    rect.rows >= PANEL_BOUNDS.minRows &&
    rect.rows <= PANEL_BOUNDS.maxRows &&
    rect.col + rect.cols - 1 <= GRID.columns &&
    Number.isSafeInteger(rect.row + rect.rows - 1)
  );
}

function overlaps(a, b) {
  return (
    a.col < b.col + b.cols &&
    a.col + a.cols > b.col &&
    a.row < b.row + b.rows &&
    a.row + a.rows > b.row
  );
}

function collides(layout, candidate, excludedId) {
  return Object.entries(layout).some(
    ([id, rect]) => id !== excludedId && overlaps(candidate, rect),
  );
}

function placeBelow(layout, rect) {
  if (!isLayoutRect(rect)) return null;
  const candidate = { ...rect };
  while (collides(layout, candidate)) {
    const nextRow = candidate.row + 1;
    if (
      !Number.isSafeInteger(nextRow) ||
      nextRow === candidate.row ||
      !Number.isSafeInteger(nextRow + candidate.rows - 1)
    ) {
      return null;
    }
    candidate.row = nextRow;
  }
  return candidate;
}

function isV2Rect(rect) {
  return (
    rect !== null &&
    typeof rect === "object" &&
    Number.isSafeInteger(rect.col) &&
    Number.isSafeInteger(rect.row) &&
    Number.isSafeInteger(rect.cols) &&
    Number.isSafeInteger(rect.rows) &&
    rect.col >= 1 &&
    rect.col <= 12 &&
    rect.cols >= 2 &&
    rect.cols <= 12 &&
    rect.row >= 1 &&
    rect.rows >= 1 &&
    rect.rows <= 4 &&
    rect.col + rect.cols - 1 <= 12
  );
}

function migrateRect(rect) {
  // v2 used 112px tracks with 14px gaps; v3 advances 70px per row (56 + 14).
  const oldTopPx = (rect.row - 1) * 126;
  const oldHeightPx = (rect.rows * 112) + ((rect.rows - 1) * 14);
  const newCol = (2 * rect.col) - 1;
  const newCols = 2 * rect.cols;
  const newRow = roundHalfUp(oldTopPx / 70) + 1;
  const newRows = roundHalfUp((oldHeightPx + 14) / 70);
  const newTopPx = (newRow - 1) * 70;
  if (
    ![oldTopPx, oldHeightPx, newCol, newCols, newRow, newRows, newTopPx]
      .every(Number.isSafeInteger)
  ) return null;
  const migrated = normalizeRect({
    col: newCol,
    row: newRow,
    cols: newCols,
    rows: newRows,
  });
  return migrated && Math.abs(oldTopPx - newTopPx) <= 35 ? migrated : null;
}

export function migrateV2Layout(saved, panelIds) {
  const source = saved !== null && typeof saved === "object" && !Array.isArray(saved)
    ? saved
    : {};
  const layout = {};

  for (const id of panelIds) {
    const savedRect = source[id];
    const fallback = DEFAULT_LAYOUT[id] ?? { col: 1, row: 1, cols: 4, rows: 2 };
    const migrated = isV2Rect(savedRect) ? migrateRect(savedRect) : null;
    layout[id] = placeBelow(layout, migrated) ?? placeBelow(layout, fallback) ?? { ...fallback };
  }

  return layout;
}

export function movePanel(layout, id, dx, dy) {
  const current = layout[id];
  if (
    !isLayoutRect(current) ||
    !Object.values(layout).every(isLayoutRect) ||
    !Number.isSafeInteger(dx) ||
    !Number.isSafeInteger(dy)
  ) return layout;
  const candidate = normalizeRect({ ...current, col: current.col + dx, row: current.row + dy });
  return !candidate || collides(layout, candidate, id) ? layout : { ...layout, [id]: candidate };
}

export function resizePanel(layout, id, dw, dh) {
  const current = layout[id];
  if (
    !isLayoutRect(current) ||
    !Object.values(layout).every(isLayoutRect) ||
    !Number.isSafeInteger(dw) ||
    !Number.isSafeInteger(dh)
  ) return layout;
  const candidate = normalizeRect({
    ...current,
    cols: current.cols + dw,
    rows: current.rows + dh,
  });
  return !candidate || collides(layout, candidate, id) ? layout : { ...layout, [id]: candidate };
}
