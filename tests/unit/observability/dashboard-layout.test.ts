import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  GRID,
  PANEL_BOUNDS,
  migrateV2Layout,
  movePanel,
  resizePanel,
} from "../../../dist/ui/observability-layout.js";

type Rect = { col: number; row: number; cols: number; rows: number };
type Layout = Record<string, Rect>;

const html = readFileSync("src/ui/observability.html", "utf8");
const layoutSource = readFileSync("src/ui/observability-layout.js", "utf8");
const css = readFileSync("src/ui/observability.css", "utf8");
const panelIds = [...html.matchAll(/data-panel="([^"]+)"/g)].map((match) => match[1]);

function idsFromDefaults(): string[] {
  const body = layoutSource.match(/const DEFAULT_LAYOUT = Object\.freeze\(\{([\s\S]*?)\n\}\);/)?.[1] ?? "";
  return [...body.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*): Object\.freeze\(/gm)].map(
    (match) => match[1],
  );
}

function idsFromCssFallbacks(): string[] {
  return [...css.matchAll(/\.dashboard-grid > \[data-panel="([^"]+)"\]/g)].map(
    (match) => match[1],
  );
}

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.col < b.col + b.cols &&
    a.col + a.cols > b.col &&
    a.row < b.row + b.rows &&
    a.row + a.rows > b.row
  );
}

function assertValidLayout(layout: Layout): void {
  assert.deepEqual(Object.keys(layout), panelIds);
  for (const [index, id] of panelIds.entries()) {
    const rect = layout[id];
    assert.ok(Number.isInteger(rect.col));
    assert.ok(Number.isInteger(rect.row));
    assert.ok(Number.isInteger(rect.cols));
    assert.ok(Number.isInteger(rect.rows));
    assert.ok(rect.col >= 1 && rect.col + rect.cols - 1 <= GRID.columns);
    assert.ok(rect.row >= 1);
    assert.ok(rect.cols >= PANEL_BOUNDS.minCols && rect.cols <= PANEL_BOUNDS.maxCols);
    assert.ok(rect.rows >= PANEL_BOUNDS.minRows && rect.rows <= PANEL_BOUNDS.maxRows);
    for (const priorId of panelIds.slice(0, index)) {
      assert.equal(overlaps(rect, layout[priorId]), false, `${id} overlaps ${priorId}`);
    }
  }
}

describe("dashboard layout geometry", () => {
  it("registers the same complete panel set in HTML, JavaScript defaults, and CSS", () => {
    assert.deepEqual(idsFromDefaults(), panelIds);
    assert.deepEqual(idsFromCssFallbacks(), panelIds);
    assert.ok(panelIds.includes("predictiveContext"));
    assert.ok(panelIds.includes("toolOutput"));
    assert.deepEqual(GRID, { columns: 24, rowPx: 56, gapPx: 14 });
    assert.deepEqual(PANEL_BOUNDS, { minCols: 4, minRows: 2, maxCols: 24, maxRows: 8 });
  });

  it("uses the exact v2 migration formulas and preserves the 35px rounding bound", () => {
    const migrated = migrateV2Layout(
      { bottleneck: { col: 2, row: 6, cols: 3, rows: 3 } },
      ["bottleneck"],
    );
    assert.deepEqual(migrated.bottleneck, { col: 3, row: 10, cols: 6, rows: 5 });

    for (let oldRow = 1; oldRow <= 50; oldRow++) {
      const result = migrateV2Layout(
        { bottleneck: { col: 1, row: oldRow, cols: 2, rows: 1 } },
        ["bottleneck"],
      ).bottleneck;
      const oldTopPx = (oldRow - 1) * 126;
      const roundedTopPx = (result.row - 1) * (GRID.rowPx + GRID.gapPx);
      assert.ok(Math.abs(oldTopPx - roundedTopPx) <= 35);
    }

    const helper = layoutSource.match(
      /const roundHalfUp = \(value\) => ([^;]+);/,
    )?.[1];
    assert.ok(helper, "roundHalfUp implementation is present");
    const roundHalfUp = Function("value", `return ${helper}`) as (value: number) => number;
    assert.equal(roundHalfUp(2.5), 3);
    assert.equal(roundHalfUp(-2.5), -3);
  });

  it("falls back per panel when v2 rectangles leave the finite integer domain", () => {
    const fallback = migrateV2Layout({}, ["bottleneck"]).bottleneck;
    const invalid = [
      { col: 0, row: 1, cols: 2, rows: 1 },
      { col: 12, row: 1, cols: 2, rows: 1 },
      { col: 1, row: 0, cols: 2, rows: 1 },
      { col: 1, row: 1, cols: 1, rows: 1 },
      { col: 1, row: 1, cols: 13, rows: 1 },
      { col: 1, row: 1, cols: 2, rows: 0 },
      { col: 1, row: 1, cols: 2, rows: 5 },
      { col: 1.5, row: 1, cols: 2, rows: 1 },
      { col: 1, row: Number.POSITIVE_INFINITY, cols: 2, rows: 1 },
    ];

    for (const rect of invalid) {
      assert.deepEqual(migrateV2Layout({ bottleneck: rect }, ["bottleneck"]).bottleneck, fallback);
    }

    const mixed = migrateV2Layout(
      {
        bottleneck: { col: 1, row: 50, cols: 2, rows: 1 },
        health: { col: 12, row: 1, cols: 2, rows: 1 },
      },
      ["bottleneck", "health"],
    );
    assert.equal(mixed.bottleneck.row, 89);
    assert.deepEqual(mixed.health, migrateV2Layout({}, ["health"]).health);
  });

  it("clamps size before position and leaves downward rows unbounded", () => {
    const layout = { panel: { col: 21, row: 2, cols: 4, rows: 2 } };
    assert.deepEqual(resizePanel(layout, "panel", 100, 100).panel, {
      col: 1,
      row: 2,
      cols: 24,
      rows: 8,
    });
    assert.deepEqual(resizePanel(layout, "panel", -100, -100).panel, {
      col: 21,
      row: 2,
      cols: 4,
      rows: 2,
    });
    assert.equal(movePanel(layout, "panel", 0, 100_000).panel.row, 100_002);
  });

  it("resolves migration collisions downward in panel DOM order", () => {
    const saved = {
      bottleneck: { col: 1, row: 2, cols: 2, rows: 1 },
      health: { col: 1, row: 2, cols: 2, rows: 1 },
    };
    const first = migrateV2Layout(saved, ["bottleneck", "health"]);
    const reversed = migrateV2Layout(saved, ["health", "bottleneck"]);
    assert.deepEqual(first, {
      bottleneck: { col: 1, row: 3, cols: 4, rows: 2 },
      health: { col: 1, row: 5, cols: 4, rows: 2 },
    });
    assert.deepEqual(reversed, {
      health: { col: 1, row: 3, cols: 4, rows: 2 },
      bottleneck: { col: 1, row: 5, cols: 4, rows: 2 },
    });
  });

  it("rejects colliding move and resize candidates without mutating layout", () => {
    const layout = {
      a: { col: 1, row: 2, cols: 4, rows: 2 },
      b: { col: 5, row: 2, cols: 4, rows: 2 },
    };
    assert.equal(movePanel(layout, "b", -1, 0), layout);
    assert.equal(resizePanel(layout, "a", 1, 0), layout);
    assert.deepEqual(layout, {
      a: { col: 1, row: 2, cols: 4, rows: 2 },
      b: { col: 5, row: 2, cols: 4, rows: 2 },
    });
  });

  it("returns a complete valid migration without writing browser storage", () => {
    let writes = 0;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { setItem: () => writes++ },
    });
    try {
      const migrated = migrateV2Layout({}, panelIds);
      assertValidLayout(migrated);
      assert.equal(writes, 0);
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
