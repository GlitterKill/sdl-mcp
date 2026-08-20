import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

import {
  GRID,
  PANEL_BOUNDS,
  migrateV2Layout,
  movePanel,
  normalizeV3Layout,
  resizePanel,
} from "../../../dist/ui/observability-layout.js";

type Rect = { col: number; row: number; cols: number; rows: number };
type Layout = Record<string, Rect>;
const RECT_KEYS = ["col", "row", "cols", "rows"];

const html = readFileSync("src/ui/observability.html", "utf8");
const layoutSource = readFileSync("src/ui/observability-layout.js", "utf8");
const dashboardSource = readFileSync("src/ui/observability.js", "utf8");
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
    assert.ok(rect.col >= 1 && rect.col + rect.cols <= GRID.columns + 1);
    assert.ok(rect.row >= 1);
    assert.ok(Number.isSafeInteger(rect.row + rect.rows));
    assert.ok(rect.cols >= PANEL_BOUNDS.minCols && rect.cols <= PANEL_BOUNDS.maxCols);
    assert.ok(rect.rows >= PANEL_BOUNDS.minRows && rect.rows <= PANEL_BOUNDS.maxRows);
    for (const priorId of panelIds.slice(0, index)) {
      assert.equal(overlaps(rect, layout[priorId]), false, `${id} overlaps ${priorId}`);
    }
  }
}

function assertCanonicalRect(rect: Rect): void {
  assert.deepEqual(Object.keys(rect), RECT_KEYS);
}

type StorageHarness = {
  calls: string[];
  values: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

type DashboardHarness = {
  loadDashboardLayout(panelIds: string[], storage: StorageHarness): Layout;
  resetDashboardLayout(
    storage: StorageHarness,
    current: Layout,
    defaults: Layout,
    apply: (layout: Layout) => void,
    announce: (message: string) => void,
  ): Layout;
  installKeyboardLayoutTransactions(options: {
    entries: Array<{ panel: FakeEventTarget; id: string; name: string }>;
    storage: StorageHarness;
    getLayout: () => Layout;
    setLayout: (layout: Layout) => void;
    applyPanelRect: (panel: FakeEventTarget, rect: Rect) => void;
    announce: (message: string) => void;
    isEditMode: () => boolean;
    visibilityTarget: FakeEventTarget;
  }): { cancel: () => void };
};

type FakeEvent = {
  key?: string;
  shiftKey?: boolean;
  repeat?: boolean;
  target: unknown;
  currentTarget: unknown;
  defaultPrevented: boolean;
  preventDefault(): void;
};

class FakeEventTarget {
  readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();
  visibilityState = "visible";
  focusCount = 0;

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string, init: Omit<Partial<FakeEvent>, "preventDefault"> = {}): FakeEvent {
    const event: FakeEvent = {
      ...init,
      target: init.target ?? this,
      currentTarget: this,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }

  focus(): void {
    this.focusCount++;
  }
}

function makeStorage(
  initial: Record<string, string> = {},
  fail?: { operation: "get" | "set" | "remove"; key: string },
): StorageHarness {
  const values = new Map(Object.entries(initial));
  const calls: string[] = [];
  const throwIfRequested = (operation: "get" | "set" | "remove", key: string) => {
    if (fail?.operation === operation && fail.key === key) {
      const error = new Error("Storage access denied");
      error.name = "SecurityError";
      throw error;
    }
  };
  return {
    calls,
    values,
    getItem(key) {
      calls.push(`get:${key}`);
      throwIfRequested("get", key);
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      calls.push(`set:${key}`);
      throwIfRequested("set", key);
      values.set(key, value);
    },
    removeItem(key) {
      calls.push(`remove:${key}`);
      throwIfRequested("remove", key);
      values.delete(key);
    },
  };
}

function loadDashboardHarness(): DashboardHarness {
  const source = dashboardSource
    .replace(/^import[\s\S]*?;\s*$/gm, "")
    .replace(/\nif \(document\.readyState === "loading"\)[\s\S]*$/, "");
  const context = {
    migrateV2Layout,
    movePanel,
    normalizeV3Layout,
    resizePanel,
  } as Record<string, unknown>;
  runInNewContext(
    `${source}\nglobalThis.__layoutHarness = { loadDashboardLayout, resetDashboardLayout, installKeyboardLayoutTransactions };`,
    context,
  );
  return context.__layoutHarness as DashboardHarness;
}

function makeKeyboardFixture(
  initial: Layout = { panel: { col: 1, row: 1, cols: 4, rows: 2 } },
  storage = makeStorage(),
) {
  const harness = loadDashboardHarness();
  const panel = new FakeEventTarget();
  const visibilityTarget = new FakeEventTarget();
  const announcements: string[] = [];
  const applied: Rect[] = [];
  let layout = structuredClone(initial);
  let editMode = true;
  const controller = harness.installKeyboardLayoutTransactions({
    entries: [{ panel, id: "panel", name: "Cache" }],
    storage,
    getLayout: () => layout,
    setLayout: (next) => {
      layout = next;
    },
    applyPanelRect: (_panel, rect) => applied.push({ ...rect }),
    announce: (message) => announcements.push(message),
    isEditMode: () => editMode,
    visibilityTarget,
  });
  return {
    panel,
    visibilityTarget,
    announcements,
    applied,
    storage,
    controller,
    layout: () => layout,
    setEditMode: (enabled: boolean) => {
      editMode = enabled;
    },
  };
}

describe("dashboard layout geometry", () => {
  it("provides opt-in accessible layout editing structure", () => {
    assert.match(
      html,
      /<button[^>]+id="layoutEditBtn"[^>]+aria-pressed="false"[^>]*>\s*EDIT LAYOUT\s*<\/button>/,
    );
    assert.match(html, /<button[^>]+id="layoutResetBtn"[^>]*>\s*RESET LAYOUT\s*<\/button>/);
    assert.match(html, /id="layoutInstructions"/);
    assert.match(html, /arrow keys to move it one grid cell/i);
    assert.match(html, /hold Shift and use the arrow keys to resize it one grid cell/i);
    assert.match(html, /drag a panel\s+header to move it/i);
    assert.match(html, /bottom-right resize handle/i);
    assert.match(html, /Press Escape[\s\S]*?leave\s+edit\s+mode[\s\S]*?cancel/i);
    assert.match(html, /id="layoutStatus"[^>]+aria-live="polite"[^>]+aria-atomic="true"/);

    assert.match(dashboardSource, /setAttribute\("aria-labelledby", heading\.id\)/);
    assert.match(dashboardSource, /setAttribute\("aria-describedby", "layoutInstructions"\)/);
    assert.match(dashboardSource, /panel\.tabIndex = 0/);
    assert.match(dashboardSource, /panel\.removeAttribute\("tabindex"\)/);
    assert.match(
      dashboardSource,
      /layoutResetBtn\.addEventListener\("click", \(\) => \{\s*try \{\s*if \(!window\.confirm\("Reset dashboard panel layout\?"\)\) return;[\s\S]*?\} finally \{\s*layoutResetBtn\.focus\(\);/,
    );
  });

  it("uses a real accessible resize handle and hides editing in the mobile stack", () => {
    assert.match(dashboardSource, /className = "panel-resize-grip"/);
    assert.match(dashboardSource, /setAttribute\("aria-label", `Resize \$\{panelName\}`\)/);
    assert.match(css, /\.panel-resize-grip\s*\{[\s\S]*?width:\s*(?:2[4-9]|[3-9]\d)px;[\s\S]*?height:\s*(?:2[4-9]|[3-9]\d)px;/);
    assert.match(
      css,
      /@media \(max-width: 720px\)[\s\S]*?\.layout-controls,[\s\S]*?\.panel-resize-grip\s*\{[\s\S]*?display:\s*none;/,
    );
  });

  it("shows a distinct high-contrast desktop focus indicator", () => {
    assert.match(
      css,
      /@media \(min-width: 721px\)[\s\S]*?\.dashboard-grid\[data-layout-edit="true"\] \.panel:focus-visible\s*\{[\s\S]*?outline:\s*3px solid var\(--accent\);[\s\S]*?outline-offset:\s*2px;/,
    );
  });

  it("loads layout v3 atomically through the shared geometry module", () => {
    assert.match(
      dashboardSource,
      /import \{[\s\S]*?migrateV2Layout,[\s\S]*?movePanel,[\s\S]*?normalizeV3Layout,[\s\S]*?resizePanel,[\s\S]*?\} from "\.\/observability-layout\.js";/,
    );
    assert.match(dashboardSource, /sdl-observability-panel-layout-v3/);
    assert.match(dashboardSource, /sdl-observability-panel-layout-v2/);
    assert.doesNotMatch(dashboardSource, /const defaults = \{/);
    assert.doesNotMatch(dashboardSource, /addEventListener\("pointerdown"/);
    assert.match(
      dashboardSource,
      /catch \{[\s\S]*?return defaults;[\s\S]*?\}/,
    );
    assert.match(dashboardSource, /for \(const panel of panels\) \{[\s\S]*?try \{/);
  });

  it("validates collisions that do not involve the first panel", () => {
    const layout = migrateV2Layout({}, panelIds);
    const laterCollision = {
      ...layout,
      latency: { ...layout.health },
    };
    assert.notEqual(movePanel(laterCollision, panelIds[0], 0, 0), laterCollision);
    assert.equal(
      panelIds.every((id) => movePanel(laterCollision, id, 0, 0) !== laterCollision),
      false,
    );
    assertValidLayout(normalizeV3Layout(laterCollision, panelIds));
  });

  it("normalizes v3 per panel without discarding unrelated valid placement", () => {
    const saved = {
      cache: { col: 19, row: 40, cols: 6, rows: 4 },
      health: { col: 0, row: 2, cols: 6, rows: 4 },
    };
    const normalized = normalizeV3Layout(saved, panelIds);
    assert.deepEqual(normalized.cache, saved.cache);
    assert.deepEqual(normalized.health, migrateV2Layout({}, ["health"]).health);
    assertValidLayout(normalized);

    const hostileInputs = [null, [], "layout", 42, { cache: { col: 1, row: 1e16, cols: 6, rows: 4 } }];
    for (const hostile of hostileInputs) {
      assertValidLayout(normalizeV3Layout(hostile, panelIds));
    }
  });

  it("emits canonical rectangles without carrying untrusted own properties", () => {
    const largeExtraKey = "x".repeat(4_096);
    const saved = JSON.parse(`{
      "cache": {
        "col": 19,
        "row": 40,
        "cols": 6,
        "rows": 4,
        "__proto__": { "polluted": true },
        "constructor": { "prototype": { "polluted": true } },
        "prototype": { "polluted": true },
        "${largeExtraKey}": "ignored"
      }
    }`) as Record<string, Rect>;
    const before = JSON.stringify(saved);
    const normalized = normalizeV3Layout(saved, ["cache"]);

    assertCanonicalRect(normalized.cache);
    assert.equal(JSON.stringify(saved), before);
    assert.doesNotMatch(JSON.stringify(normalized), /polluted|ignored/);
    const target = {};
    const targetPrototype = Object.getPrototypeOf(target);
    Object.assign(target, normalized.cache);
    assert.equal(Object.getPrototypeOf(target), targetPrototype);
    assert.equal(Object.hasOwn(normalized.cache, largeExtraKey), false);

    const migrated = migrateV2Layout({
      health: { col: 1, row: 2, cols: 2, rows: 1, extra: true },
    }, ["health"]);
    const editable = {
      panel: { col: 1, row: 2, cols: 4, rows: 2, extra: true },
    };
    assertCanonicalRect(migrated.health);
    assertCanonicalRect(movePanel(editable, "panel", 1, 0).panel);
    assertCanonicalRect(resizePanel(editable, "panel", 1, 0).panel);
    assert.equal(editable.panel.extra, true);
  });

  it("falls back from storage SecurityError and continues without writes", () => {
    const harness = loadDashboardHarness();
    const storage = makeStorage({}, {
      operation: "get",
      key: "sdl-observability-panel-layout-v3",
    });
    assert.deepEqual(
      harness.loadDashboardLayout(panelIds, storage),
      migrateV2Layout({}, panelIds),
    );
    assert.deepEqual(storage.calls, ["get:sdl-observability-panel-layout-v3"]);
  });

  it("resets durably without allowing valid v2 to resurrect", () => {
    const harness = loadDashboardHarness();
    const defaults = migrateV2Layout({}, panelIds);
    const current = normalizeV3Layout(
      { cache: { col: 19, row: 40, cols: 6, rows: 4 } },
      panelIds,
    );
    const storage = makeStorage({
      "sdl-observability-panel-layout-v2": JSON.stringify({
        cache: { col: 10, row: 4, cols: 3, rows: 2 },
      }),
      "sdl-observability-panel-layout-v3": JSON.stringify(current),
    });
    const applied: Layout[] = [];
    const announcements: string[] = [];
    const result = harness.resetDashboardLayout(
      storage,
      current,
      defaults,
      (layout) => applied.push(layout),
      (message) => announcements.push(message),
    );
    assert.equal(result, defaults);
    assert.deepEqual(storage.calls.slice(0, 3), [
      "get:sdl-observability-panel-layout-v2",
      "remove:sdl-observability-panel-layout-v2",
      "remove:sdl-observability-panel-layout-v3",
    ]);
    assert.equal(storage.values.size, 0);
    assert.deepEqual(applied, [defaults]);
    assert.deepEqual(announcements, ["Panel layout reset."]);
    assert.deepEqual(harness.loadDashboardLayout(panelIds, storage), defaults);
    assert.equal(storage.calls.some((call) => call.startsWith("set:")), false);
  });

  it("preserves invalid v2 and current UI when reset storage access fails", () => {
    const harness = loadDashboardHarness();
    const defaults = migrateV2Layout({}, panelIds);
    const current = normalizeV3Layout(
      { cache: { col: 19, row: 40, cols: 6, rows: 4 } },
      panelIds,
    );

    const invalidV2 = makeStorage({
      "sdl-observability-panel-layout-v2": "not-json",
      "sdl-observability-panel-layout-v3": JSON.stringify(current),
    });
    harness.resetDashboardLayout(invalidV2, current, defaults, () => {}, () => {});
    assert.equal(invalidV2.values.get("sdl-observability-panel-layout-v2"), "not-json");
    assert.equal(invalidV2.values.has("sdl-observability-panel-layout-v3"), false);

    for (const fail of [
      { operation: "get" as const, key: "sdl-observability-panel-layout-v2" },
      { operation: "remove" as const, key: "sdl-observability-panel-layout-v2" },
      { operation: "remove" as const, key: "sdl-observability-panel-layout-v3" },
    ]) {
      const storage = makeStorage({
        "sdl-observability-panel-layout-v2": JSON.stringify({ cache: { col: 10, row: 4, cols: 3, rows: 2 } }),
        "sdl-observability-panel-layout-v3": JSON.stringify(current),
      }, fail);
      const applied: Layout[] = [];
      const announcements: string[] = [];
      const result = harness.resetDashboardLayout(
        storage,
        current,
        defaults,
        (layout) => applied.push(layout),
        (message) => announcements.push(message),
      );
      assert.equal(result, current);
      assert.equal(storage.values.has("sdl-observability-panel-layout-v3"), true);
      assert.deepEqual(applied, [current]);
      assert.deepEqual(announcements, ["Panel layout reset failed."]);
    }
  });

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

  it("falls back from unsafe v2 rows without stalling collision resolution", () => {
    const script = `
      import { migrateV2Layout } from "./dist/ui/observability-layout.js";
      const ids = ["bottleneck", "health"];
      const unsafe = { col: 1, row: 1e16, cols: 2, rows: 1 };
      const actual = migrateV2Layout({ bottleneck: unsafe, health: unsafe }, ids);
      const expected = migrateV2Layout({}, ids);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) process.exit(2);
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 1_000,
    });
    assert.equal(child.status, 0, child.error?.message ?? child.stderr);

    const cliffRow = 5_003_999_585_967_218;
    const cliff = { col: 1, row: cliffRow, cols: 2, rows: 1 };
    const displaced = migrateV2Layout(
      { bottleneck: cliff, health: cliff },
      ["bottleneck", "health"],
    );
    assert.deepEqual(displaced, migrateV2Layout({}, ["bottleneck", "health"]));
    for (const rect of Object.values(displaced)) {
      assert.ok(Number.isSafeInteger(rect.row));
      assert.ok(Number.isSafeInteger(rect.row + rect.rows));
    }
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

  it("rejects unsafe and overflowing movement or resize without mutation", () => {
    const layout = { panel: { col: 1, row: 2, cols: 4, rows: 2 } };
    assert.equal(movePanel(layout, "panel", Number.MAX_SAFE_INTEGER, 0), layout);
    assert.equal(movePanel(layout, "panel", 0, Number.POSITIVE_INFINITY), layout);
    assert.equal(resizePanel(layout, "panel", Number.MAX_SAFE_INTEGER, 0), layout);
    assert.equal(resizePanel(layout, "panel", 0, Number.MAX_SAFE_INTEGER + 1), layout);

    const unsafeLayout = { panel: { col: 1, row: 1e16, cols: 4, rows: 2 } };
    assert.equal(movePanel(unsafeLayout, "panel", 0, 1), unsafeLayout);
    assert.equal(resizePanel(unsafeLayout, "panel", 1, 0), unsafeLayout);

    const nearLimitLayout = {
      panel: { col: 1, row: Number.MAX_SAFE_INTEGER - 1, cols: 4, rows: 2 },
    };
    assert.equal(movePanel(nearLimitLayout, "panel", 0, 1), nearLimitLayout);
    assert.deepEqual(layout, { panel: { col: 1, row: 2, cols: 4, rows: 2 } });
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


  it("previews held arrow moves and commits once after the final key is released", () => {
    const fixture = makeKeyboardFixture();

    const first = fixture.panel.dispatch("keydown", { key: "ArrowRight" });
    const repeat = fixture.panel.dispatch("keydown", { key: "ArrowRight", repeat: true });
    fixture.panel.dispatch("keydown", { key: "ArrowDown" });

    assert.equal(first.defaultPrevented, true);
    assert.equal(repeat.defaultPrevented, true);
    assert.deepEqual(fixture.layout().panel, { col: 3, row: 2, cols: 4, rows: 2 });
    assert.equal(fixture.storage.calls.length, 0);
    assert.deepEqual(fixture.announcements, []);

    const firstRelease = fixture.panel.dispatch("keyup", { key: "ArrowRight" });
    assert.equal(firstRelease.defaultPrevented, true);
    assert.equal(fixture.storage.calls.length, 0);
    const finalRelease = fixture.panel.dispatch("keyup", { key: "ArrowDown" });
    assert.equal(finalRelease.defaultPrevented, true);

    assert.deepEqual(fixture.storage.calls, ["set:sdl-observability-panel-layout-v3"]);
    assert.deepEqual(fixture.announcements, [
      "Cache, column 3, row 2, width 4, height 2",
    ]);

    fixture.panel.dispatch("keydown", { key: "ArrowLeft" });
    fixture.panel.dispatch("keyup", { key: "ArrowLeft" });
    fixture.panel.dispatch("keydown", { key: "ArrowUp" });
    fixture.panel.dispatch("keyup", { key: "ArrowUp" });
    assert.deepEqual(fixture.layout().panel, { col: 2, row: 1, cols: 4, rows: 2 });
  });

  it("resizes one cell with Shift and keeps the last valid collision-free preview", () => {
    const fixture = makeKeyboardFixture({
      panel: { col: 1, row: 1, cols: 4, rows: 2 },
      blocker: { col: 6, row: 1, cols: 4, rows: 2 },
    });

    fixture.panel.dispatch("keydown", { key: "ArrowRight" });
    fixture.panel.dispatch("keydown", { key: "ArrowRight", repeat: true });
    assert.deepEqual(fixture.layout().panel, { col: 2, row: 1, cols: 4, rows: 2 });
    fixture.panel.dispatch("keyup", { key: "ArrowRight" });

    fixture.panel.dispatch("keydown", { key: "ArrowDown", shiftKey: true });
    assert.deepEqual(fixture.layout().panel, { col: 2, row: 1, cols: 4, rows: 3 });
    fixture.panel.dispatch("keyup", { key: "ArrowDown", shiftKey: true });
    assert.equal(fixture.storage.calls.length, 2);
  });

  it("prevents Arrow scrolling only in edit mode and skips no-op commits", () => {
    const fixture = makeKeyboardFixture();
    fixture.setEditMode(false);
    const inactive = fixture.panel.dispatch("keydown", { key: "ArrowLeft" });
    assert.equal(inactive.defaultPrevented, false);
    assert.deepEqual(fixture.layout().panel, { col: 1, row: 1, cols: 4, rows: 2 });

    fixture.setEditMode(true);
    const clamped = fixture.panel.dispatch("keydown", { key: "ArrowLeft" });
    fixture.panel.dispatch("keyup", { key: "ArrowLeft" });
    assert.equal(clamped.defaultPrevented, true);
    assert.deepEqual(fixture.storage.calls, []);
    assert.deepEqual(fixture.announcements, []);
  });

  it("leaves bubbled child controls native while panel-owned keyup completes the transaction", () => {
    const fixture = makeKeyboardFixture();
    const childInput = new FakeEventTarget();
    const childArrow = fixture.panel.dispatch("keydown", {
      key: "ArrowRight",
      target: childInput,
    });

    assert.equal(childArrow.defaultPrevented, false);
    assert.deepEqual(fixture.layout().panel, { col: 1, row: 1, cols: 4, rows: 2 });
    assert.deepEqual(fixture.storage.calls, []);

    const panelArrow = fixture.panel.dispatch("keydown", { key: "ArrowRight" });
    assert.equal(panelArrow.defaultPrevented, true);
    assert.deepEqual(fixture.layout().panel, { col: 2, row: 1, cols: 4, rows: 2 });
    const bubbledRelease = fixture.panel.dispatch("keyup", {
      key: "ArrowRight",
      target: childInput,
    });
    assert.equal(bubbledRelease.defaultPrevented, true);
    assert.deepEqual(fixture.storage.calls, ["set:sdl-observability-panel-layout-v3"]);
  });

  it("cancels the active transaction identically on Escape, blur, visibility loss, or edit exit", () => {
    for (const cancel of ["escape", "blur", "visibility", "edit-exit"] as const) {
      const fixture = makeKeyboardFixture();
      fixture.panel.dispatch("keydown", { key: "ArrowRight" });
      assert.equal(fixture.layout().panel.col, 2);

      if (cancel === "escape") fixture.panel.dispatch("keydown", { key: "Escape" });
      if (cancel === "blur") fixture.panel.dispatch("blur");
      if (cancel === "visibility") {
        fixture.visibilityTarget.visibilityState = "hidden";
        fixture.visibilityTarget.dispatch("visibilitychange");
      }
      if (cancel === "edit-exit") fixture.controller.cancel();

      assert.deepEqual({ ...fixture.layout().panel }, { col: 1, row: 1, cols: 4, rows: 2 });
      fixture.panel.dispatch("keyup", { key: "ArrowRight" });
      assert.deepEqual(fixture.storage.calls, [], cancel);
      assert.deepEqual(fixture.announcements, [], cancel);
    }
    assert.match(dashboardSource, /if \(!enabled\) cancelKeyboardTransaction\(\);/);
  });

  it("rolls back safely and reports failure when browser persistence is denied", () => {
    const storage = makeStorage({}, {
      operation: "set",
      key: "sdl-observability-panel-layout-v3",
    });
    const fixture = makeKeyboardFixture(undefined, storage);
    fixture.panel.dispatch("keydown", { key: "ArrowRight" });

    assert.doesNotThrow(() => fixture.panel.dispatch("keyup", { key: "ArrowRight" }));
    assert.deepEqual({ ...fixture.layout().panel }, { col: 1, row: 1, cols: 4, rows: 2 });
    assert.deepEqual(fixture.announcements, ["Panel layout update failed."]);
    assert.equal(fixture.panel.focusCount, 1);
  });
});
